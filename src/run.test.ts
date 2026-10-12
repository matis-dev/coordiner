import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storyText } from "./backlog.ts";
import { defaultCard, TEMPLATES, type Chain } from "./chains.ts";
import { fillInput, MAX_INPUT_CHARS, MAX_TURNS, remainingCommands, runChain, runSession, type ChainDeps, type Outcome, type RunDeps, type RunEvent } from "./run.ts";
import type { TurnResult } from "./session.ts";
import type { ReviewPrep } from "./worktree.ts";

const models = { strong: "m-strong", medium: "m-medium", weak: "m-weak" };
const story = { heading: "Story 1: Login", body: "Add a login form." };
const filled = fillInput(TEMPLATES[0]!, storyText(story));
const chain = (filled as { ok: true; chain: Chain }).chain;
const AUTHOR_SESSION = chain.sessions[0]!;
const REVIEW_SESSION = chain.sessions[1]!;
const reply = (text: string, n: number): TurnResult => ({ ok: true, sessionId: `sess-${n}`, model: "ignored", resultText: text, commands: [] });

// `script` answers turn N with script[N]; a function lets a test react to the request.
function harness(script: Array<TurnResult | (() => TurnResult)>, signal = new AbortController().signal) {
  const requests: Array<{ prompt: string; model: string; resume?: string }> = [];
  const events: RunEvent[] = [];
  const deps: RunDeps = {
    runTurn: async (request) => {
      requests.push(request);
      const next = script[requests.length - 1]!;
      return typeof next === "function" ? next() : next;
    },
    models,
    emit: (event) => void events.push(event),
    signal,
  };
  return { deps, requests, events };
}

describe("runSession: session one", () => {
  it("plans on the strong model, then implements on the model the plan names, in one session", async () => {
    const { deps, requests, events } = harness([reply("plan\nCOORDINER: NEXT Light", 1), reply("built\nCOORDINER: DONE", 2)]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "built" });
    assert.deepEqual(requests.map((r) => [r.model, r.resume]), [["m-strong", undefined], ["m-weak", "sess-1"]]);
    assert.equal(requests[0]!.prompt, "/m-skills:planning-architect Story 1: Login\n\nAdd a login form.");
    assert.equal(requests[1]!.prompt, "/m-skills:implementing-architect Implement the approved plan above.");
    assert.deepEqual(events, [
      { type: "step-started", index: 0, label: "Plan", tier: "strong", model: "m-strong" },
      { type: "step-finished", index: 0, status: "done", detail: "next: Light", sessionId: "sess-1" },
      { type: "step-started", index: 1, label: "Implement", tier: "weak", model: "m-weak" },
      { type: "step-finished", index: 1, status: "done", detail: "done", sessionId: "sess-2" },
    ]);
  });

  it("switches the model at every tier stop and continues the plan", async () => {
    const { deps, requests } = harness([reply("COORDINER: NEXT Light", 1), reply("COORDINER: NEXT Standard", 2), reply("COORDINER: NEXT Heavy", 3), reply("COORDINER: DONE", 4)]);
    await runSession(AUTHOR_SESSION, deps);
    assert.deepEqual(requests.map((r) => r.model), ["m-strong", "m-weak", "m-medium", "m-strong"]);
    assert.equal(requests[2]!.prompt, "Continue with the next step of the plan.");
    assert.deepEqual(requests.map((r) => r.resume), [undefined, "sess-1", "sess-2", "sess-3"]);
  });

  it("stops on HALT with its reason and keeps the session id for take-over", async () => {
    const { deps, events } = harness([reply("COORDINER: NEXT Light", 1), reply("COORDINER: HALT needs a migration decision", 2)]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "halted", reason: "needs a migration decision", sessionId: "sess-2" });
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 1, status: "halted", detail: "needs a migration decision", sessionId: "sess-2" });
  });

  it("reminds once on the same model when the status line is missing, then continues", async () => {
    const { deps, requests } = harness([reply("plan without marker", 1), reply("COORDINER: NEXT Standard", 2), reply("COORDINER: DONE", 3)]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.equal(requests[1]!.prompt, "End your reply with your COORDINER status line.");
    assert.deepEqual(requests.map((r) => r.model), ["m-strong", "m-strong", "m-medium"]);
    assert.equal(requests[2]!.prompt, "/m-skills:implementing-architect Implement the approved plan above.");
  });

  it("halts when the status line is still missing after the reminder", async () => {
    const { deps, requests } = harness([reply("no marker", 1), reply("still none", 2)]);
    const outcome = await runSession(AUTHOR_SESSION, deps);
    assert.equal(outcome.status, "halted");
    assert.equal(outcome.status === "halted" && outcome.sessionId, "sess-2");
    assert.equal(requests.length, 2);
  });

  it("allows a fresh reminder after a valid status line resets it", async () => {
    const { deps, requests } = harness([reply("none", 1), reply("COORDINER: NEXT Light", 2), reply("none again", 3), reply("COORDINER: DONE", 4)]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.equal(requests.length, 4);
  });

  it("stops on a failed turn and keeps the session id for take-over", async () => {
    const { deps, events } = harness([reply("COORDINER: NEXT Light", 1), { ok: false, sessionId: "sess-1", error: "the session ended with error_max_turns." }]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "failed", error: "the session ended with error_max_turns.", sessionId: "sess-1" });
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 1, status: "failed", detail: "the session ended with error_max_turns.", sessionId: "sess-1" });
  });

  it("reports a failed turn that has no session id", async () => {
    const { deps } = harness([{ ok: false, error: "the Claude Agent SDK raised: down" }]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "failed", error: "the Claude Agent SDK raised: down" });
  });

  it("marks the step stopped when the abort arrives during a turn", async () => {
    const stop = new AbortController();
    const { deps, events } = harness([() => (stop.abort(), { ok: false, error: "aborted" })], stop.signal);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "stopped" });
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 0, status: "stopped", detail: "stopped" });
  });

  it("starts no turn when already aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    const { deps, requests } = harness([], stop.signal);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "stopped" });
    assert.equal(requests.length, 0);
  });

  it("stops between turns when the abort arrives after a successful one", async () => {
    const stop = new AbortController();
    const { deps, requests } = harness([() => (stop.abort(), reply("COORDINER: NEXT Light", 1))], stop.signal);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "stopped" });
    assert.equal(requests.length, 1);
  });

  it("fails at the turn cap instead of looping forever", async () => {
    const { deps, requests } = harness(Array.from({ length: MAX_TURNS + 5 }, (_, n) => reply("COORDINER: NEXT Light", n)));
    const outcome = await runSession(AUTHOR_SESSION, deps);
    assert.equal(outcome.status, "failed");
    assert.equal(requests.length, MAX_TURNS);
  });
});

describe("runSession: session two", () => {
  it("reviews on the strong model, fixes on the tier the review names, then writes history on the medium model, in one session", async () => {
    const { deps, requests } = harness([
      reply("findings\nCOORDINER: NEXT Light", 1),
      reply("fixed\nCOORDINER: DONE", 2),
      reply("feat: add login\n\n- form\nCOORDINER: DONE", 3),
    ]);
    assert.deepEqual(await runSession(REVIEW_SESSION, deps), { status: "done", text: "feat: add login\n\n- form" });
    assert.deepEqual(
      requests.map((r) => [r.prompt, r.model, r.resume]),
      [
        ["/m-skills:code-review-architect-uncommitted", "m-strong", undefined],
        ["/m-skills:implementing-architect fix the findings", "m-weak", "sess-1"],
        ["/m-skills:rolling-history", "m-medium", "sess-2"],
      ],
    );
  });

  it("continues fixing across tier stops", async () => {
    const { deps, requests } = harness([reply("COORDINER: NEXT Light", 1), reply("COORDINER: NEXT Heavy", 2), reply("COORDINER: DONE", 3), reply("brief\nCOORDINER: DONE", 4)]);
    await runSession(REVIEW_SESSION, deps);
    assert.deepEqual(requests.map((r) => r.prompt).slice(1, 3), ["/m-skills:implementing-architect fix the findings", "Continue with the next fix."]);
    assert.deepEqual(requests.map((r) => r.model), ["m-strong", "m-weak", "m-strong", "m-medium"]);
  });

  it("goes straight from review to history when there is nothing to fix", async () => {
    const { deps, requests, events } = harness([reply("no findings\nCOORDINER: DONE", 1), reply("brief\nCOORDINER: DONE", 2)]);
    assert.deepEqual(await runSession(REVIEW_SESSION, deps), { status: "done", text: "brief" });
    assert.deepEqual(requests.map((r) => r.prompt), ["/m-skills:code-review-architect-uncommitted", "/m-skills:rolling-history"]);
    assert.deepEqual(events.filter((e) => e.type === "step-started").map((e) => e.type === "step-started" && e.label), ["Review", "History"]);
  });

  it("treats NEXT in the history turn as a missing status line: one reminder, then a halt", async () => {
    const { deps, requests } = harness([reply("COORDINER: DONE", 1), reply("brief\nCOORDINER: NEXT Light", 2), reply("COORDINER: NEXT Light", 3)]);
    const outcome = await runSession(REVIEW_SESSION, deps);
    assert.equal(outcome.status, "halted");
    assert.deepEqual(requests.map((r) => [r.prompt, r.model]).slice(1), [["/m-skills:rolling-history", "m-medium"], ["End your reply with your COORDINER status line.", "m-medium"]]);
  });

  it("finishes after a reminder in the history turn", async () => {
    const { deps } = harness([reply("COORDINER: DONE", 1), reply("brief, no marker", 2), reply("brief\nCOORDINER: DONE", 3)]);
    assert.deepEqual(await runSession(REVIEW_SESSION, deps), { status: "done", text: "brief" });
  });

  it("keeps the session id and does not run history when fixing fails", async () => {
    const { deps, requests } = harness([reply("COORDINER: NEXT Standard", 1), { ok: false, sessionId: "sess-1", error: "the session ended with error_during_execution." }]);
    assert.deepEqual(await runSession(REVIEW_SESSION, deps), { status: "failed", error: "the session ended with error_during_execution.", sessionId: "sess-1" });
    assert.equal(requests.length, 2);
  });
});

describe("runChain: the Story template", () => {
  function storyHarness(script: Array<TurnResult | (() => TurnResult)>, prep: ReviewPrep = { kind: "ready", marked: 0 }, signal?: AbortSignal) {
    const h = harness(script, signal);
    let prepared = 0;
    const deps: ChainDeps = {
      ...h.deps,
      prepareReview: async () => {
        prepared++;
        return prep;
      },
    };
    return { ...h, deps, prepared: () => prepared };
  }
  const authored = [reply("COORDINER: NEXT Light", 1), reply("COORDINER: DONE", 2)];

  it("runs session two as a fresh session after session one, with step numbers continuing", async () => {
    const { deps, requests, events, prepared } = storyHarness([...authored, reply("COORDINER: DONE", 3), reply("brief\nCOORDINER: DONE", 4)]);
    assert.deepEqual(await runChain(chain, deps), { status: "done", text: "brief" });
    assert.equal(prepared(), 1);
    assert.equal(requests[2]!.prompt, "/m-skills:code-review-architect-uncommitted");
    assert.equal(requests[2]!.resume, undefined);
    assert.equal(requests[3]!.resume, "sess-3");
    assert.deepEqual(events.filter((e) => e.type === "step-started").map((e) => e.index), [0, 1, 2, 3]);
    assert.deepEqual(events.filter((e) => e.type === "step-finished").map((e) => e.index), [0, 1, 2, 3]);
  });

  it("does not prepare a review when session one does not finish", async () => {
    const { deps, requests, prepared } = storyHarness([reply("COORDINER: HALT needs a decision", 1)]);
    assert.deepEqual(await runChain(chain, deps), { status: "halted", reason: "needs a decision", sessionId: "sess-1", at: { session: 0, card: 0 } });
    assert.equal(prepared(), 0);
    assert.equal(requests.length, 1);
  });

  it("ends with no changes, and no review, when session one changed nothing", async () => {
    const { deps, requests } = storyHarness(authored, { kind: "no-changes" });
    assert.deepEqual(await runChain(chain, deps), { status: "no-changes" });
    assert.equal(requests.length, 2);
  });

  it("halts before the review when there are too many new files", async () => {
    const { deps, requests } = storyHarness(authored, { kind: "too-many", count: 4000 });
    const outcome = await runChain(chain, deps);
    assert.equal(outcome.status, "halted");
    assert.match(outcome.status === "halted" ? outcome.reason : "", /4000 new files.*\.gitignore/);
    assert.deepEqual(outcome.status === "halted" && outcome.at, { session: 1, card: 0 });
    assert.equal(requests.length, 2);
  });

  it("fails before the review when the new files cannot be marked", async () => {
    const { deps, requests } = storyHarness(authored, { kind: "failed", detail: "index.lock exists" });
    const outcome = await runChain(chain, deps);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.status === "failed" ? outcome.error : "", /index\.lock exists/);
    assert.deepEqual(outcome.status === "failed" && outcome.at, { session: 1, card: 0 });
    assert.equal(requests.length, 2);
  });

  it("stops between the sessions without preparing the review", async () => {
    const stop = new AbortController();
    const { deps, prepared } = storyHarness([reply("COORDINER: NEXT Light", 1), () => (stop.abort(), reply("COORDINER: DONE", 2))], undefined, stop.signal);
    assert.deepEqual(await runChain(chain, deps), { status: "stopped" });
    assert.equal(prepared(), 0);
  });

  it("records the card that stopped in a later session", async () => {
    const { deps } = storyHarness([...authored, reply("COORDINER: NEXT Light", 3), reply("COORDINER: HALT one-way door", 4)]);
    const outcome = await runChain(chain, deps);
    assert.deepEqual(outcome, { status: "halted", reason: "one-way door", sessionId: "sess-4", at: { session: 1, card: 1 } });
  });
});

describe("fillInput", () => {
  it("puts the story heading and body where the template says {{story}}", () => {
    assert.equal(AUTHOR_SESSION.cards[0]!.args, "Story 1: Login\n\nAdd a login form.");
    assert.equal(AUTHOR_SESSION.cards[1]!.args, "Implement the approved plan above.");
  });

  it("puts a typed idea or bug where the chain's own placeholder is", () => {
    const idea = fillInput(TEMPLATES.find((t) => t.id === "idea")!, "a dark mode");
    assert.equal(idea.ok && idea.chain.sessions[0]!.cards[0]!.args, "a dark mode");
    const bug = fillInput(TEMPLATES.find((t) => t.id === "bug")!, "save loses the last line");
    assert.equal(bug.ok && bug.chain.sessions[0]!.cards[0]!.args, "save loses the last line");
  });

  it("leaves a chain without a placeholder as it is", () => {
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("acme:lint")] }] };
    assert.deepEqual(fillInput(own, ""), { ok: true, chain: own });
  });

  it("refuses text over the size cap", () => {
    assert.deepEqual(fillInput(TEMPLATES[0]!, "x".repeat(MAX_INPUT_CHARS + 1)), {
      ok: false,
      reason: `This text is longer than ${MAX_INPUT_CHARS} characters; split it.`,
    });
  });
});

describe("runChain: other chains", () => {
  const deps = (h: ReturnType<typeof harness>, prep: ReviewPrep = { kind: "ready", marked: 0 }) => {
    let prepared = 0;
    return { deps: { ...h.deps, prepareReview: async () => (prepared++, prep) } as ChainDeps, prepared: () => prepared };
  };

  it("runs a generic skill as one medium-tier turn that ends at DONE", async () => {
    const h = harness([reply("linted\nCOORDINER: DONE", 1)]);
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("acme:lint")] }] };
    assert.deepEqual(await runChain(own, deps(h).deps), { status: "done", text: "linted" });
    assert.deepEqual(h.requests, [{ prompt: "/acme:lint", model: "m-medium" }]);
  });

  it("moves between generic cards on NEXT, on the tier it names", async () => {
    const h = harness([reply("COORDINER: NEXT Heavy", 1), reply("COORDINER: DONE", 2)]);
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("a"), defaultCard("b")] }] };
    assert.equal((await runChain(own, deps(h).deps)).status, "done");
    assert.deepEqual(h.requests.map((r) => [r.prompt, r.model, r.resume]), [["/a", "m-medium", undefined], ["/b", "m-strong", "sess-1"]]);
  });

  it("runs three sessions, each fresh, with step numbers continuing and the review prepared only where a session opens with it", async () => {
    const h = harness([reply("COORDINER: DONE", 1), reply("COORDINER: DONE", 2), reply("COORDINER: DONE", 3)]);
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("a")] }, { cards: [defaultCard("b")] }, { cards: [defaultCard("m-skills:code-review-architect-uncommitted")] }] };
    const d = deps(h);
    assert.equal((await runChain(own, d.deps)).status, "done");
    assert.deepEqual(h.requests.map((r) => r.resume), [undefined, undefined, undefined]);
    assert.equal(d.prepared(), 1);
    assert.deepEqual(h.events.filter((e) => e.type === "step-started").map((e) => e.index), [0, 1, 2]);
  });

  it("refuses an empty session and a chain without sessions", async () => {
    const h = harness([]);
    assert.deepEqual(await runChain({ id: "e", name: "E", sessions: [{ cards: [] }] }, deps(h).deps), { status: "refused", reason: "This session has no skills." });
    assert.deepEqual(await runChain({ id: "e", name: "E", sessions: [] }, deps(h).deps), { status: "refused", reason: "This chain has no sessions." });
  });

  it("continues a loop card with a plain prompt when it names none", async () => {
    const h = harness([reply("COORDINER: NEXT Light", 1), reply("COORDINER: NEXT Light", 2), reply("COORDINER: DONE", 3)]);
    const loop = { ...defaultCard("m-skills:implementing-architect"), next: undefined };
    delete loop.next;
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("a"), loop] }] };
    await runChain(own, deps(h).deps);
    assert.equal(h.requests[2]!.prompt, "Continue.");
  });

  it("runs the loop card after another skill that ends with DONE, as the unattended note tells it to", async () => {
    const h = harness([reply("spec written\nCOORDINER: DONE", 1), reply("built\nCOORDINER: DONE", 2)]);
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("acme:spec"), defaultCard("m-skills:implementing-architect")] }] };
    assert.deepEqual(await runChain(own, deps(h).deps), { status: "done", text: "built" });
    assert.deepEqual(h.requests.map((r) => [r.prompt, r.model]), [["/acme:spec", "m-medium"], ["/m-skills:implementing-architect", "m-medium"]]);
  });
});

describe("remainingCommands", () => {
  const all = ["/m-skills:code-review-architect-uncommitted", "/m-skills:implementing-architect fix the findings", "/m-skills:rolling-history"];
  const halted = (session: number, card: number): Outcome => ({ status: "halted", reason: "x", at: { session, card } });

  it("lists every session-two command when the review stopped", () => {
    assert.deepEqual(remainingCommands(chain, halted(1, 0)), all);
  });

  it("lists fixing and history when fixing stopped, even after a reminder there", () => {
    assert.deepEqual(remainingCommands(chain, { status: "failed", error: "x", at: { session: 1, card: 1 } }), all.slice(1));
  });

  it("lists only history when history stopped", () => {
    assert.deepEqual(remainingCommands(chain, halted(1, 2)), all.slice(2));
  });

  it("lists nothing when session one stopped", () => {
    assert.deepEqual(remainingCommands(chain, halted(0, 1)), []);
  });

  it("lists nothing when the outcome does not say where it stopped", () => {
    assert.deepEqual(remainingCommands(chain, { status: "halted", reason: "x" }), []);
  });

  it("lists the rest of the stopped session and every later one", () => {
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("a")] }, { cards: [defaultCard("b"), defaultCard("c")] }, { cards: [defaultCard("d")] }] };
    assert.deepEqual(remainingCommands(own, halted(1, 1)), ["/c", "/d"]);
  });

  it("lists nothing for a run that finished or was stopped by the user", () => {
    assert.deepEqual(remainingCommands(chain, { status: "done", text: "" }), []);
    assert.deepEqual(remainingCommands(chain, { status: "stopped" }), []);
  });
});
