import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storyText } from "./backlog.ts";
import { defaultCard, MAX_INPUT_CHARS, TEMPLATES, type Chain } from "./chains.ts";
import { continueAfter, fillInput, pickUpAfter, restateAfter, MAX_TURNS, remainingCommands, runChain, runSession, talkOn, type AfterAsk, type ChainDeps, type Outcome, type RunDeps, type RunEvent, type TurnAsk } from "./run.ts";
import type { TurnResult } from "./session.ts";
import { Talk, type Move, type WaitRequest } from "./talk.ts";
import type { ReviewPrep } from "./worktree.ts";

const models = { strong: "m-strong", medium: "m-medium", weak: "m-weak" };
const story = { heading: "Story 1: Login", body: "Add a login form." };
const filled = fillInput(TEMPLATES[0]!, storyText(story));
const chain = (filled as { ok: true; chain: Chain }).chain;
const AUTHOR_SESSION = chain.sessions[0]!;
const REVIEW_SESSION = chain.sessions[1]!;
const reply = (text: string, n: number): TurnResult => ({ ok: true, sessionId: `sess-${n}`, model: "ignored", resultText: text, commands: [] });

// `script` answers turn N with script[N]; a function lets a test react to the request, and act in the chat as the user would.
// Each time a card waits for the user, the next of `moves` runs; a wait with no move left ends the chat, which stops the run.
function harness(script: Array<TurnResult | ((talk: Talk) => TurnResult)>, signal = new AbortController().signal, moves: Array<(talk: Talk) => void> = []) {
  const requests: TurnAsk[] = [];
  const events: RunEvent[] = [];
  const waits: WaitRequest[] = [];
  const talk = new Talk({ changed: () => undefined, delivered: () => undefined, answered: () => undefined });
  const deps: RunDeps = {
    runTurn: async (request) => {
      requests.push(request);
      const next = script[requests.length - 1]!;
      return typeof next === "function" ? next(talk) : next;
    },
    models,
    emit: (event) => void events.push(event),
    signal,
    // Every reading is a second on from the one before, so each turn runs a second.
    now: ((t) => () => (t += 1000))(0),
    talk: {
      at: (where) => talk.at(where),
      takeQueued: (card) => talk.takeQueued(card),
      pausePending: () => talk.pausePending(),
      waitForYou: (request) => {
        waits.push(request);
        const move = talk.waitForYou(request);
        // A wait that the queue answered at once has already moved on, and keeps the user's move for the next wait.
        queueMicrotask(() => {
          if (talk.snapshot().phase !== "waiting") return;
          const act = moves.shift();
          if (act) act(talk);
          else talk.end();
        });
        return move;
      },
    },
  };
  return { deps, requests, events, waits, talk };
}

describe("runSession: session one", () => {
  it("plans on the strong model, then implements on the model the plan names, in one session", async () => {
    const { deps, requests, events } = harness([reply("plan\nCOORDINER: NEXT Light", 1), reply("built\nCOORDINER: DONE", 2)]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "built" });
    assert.deepEqual(requests.map((r) => [r.model, r.resume]), [["m-strong", undefined], ["m-weak", "sess-1"]]);
    assert.equal(requests[0]!.prompt, "/m-skills:planning-architect Story 1: Login\n\nAdd a login form.");
    assert.equal(requests[1]!.prompt, "/m-skills:implementing-architect Implement the approved plan above.");
    assert.deepEqual(events, [
      { type: "step-started", index: 0, label: "Plan", tier: "strong", model: "m-strong", position: { session: 0, card: 0 } },
      { type: "step-finished", index: 0, status: "done", detail: "next: Light", sessionId: "sess-1", stats: { ms: 1000 } },
      { type: "step-started", index: 1, label: "Implement", tier: "weak", model: "m-weak", position: { session: 0, card: 1 } },
      { type: "step-finished", index: 1, status: "done", detail: "done", sessionId: "sess-2", stats: { ms: 1000 } },
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
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 1, status: "halted", detail: "needs a migration decision", sessionId: "sess-2", stats: { ms: 1000 } });
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
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 1, status: "failed", detail: "the session ended with error_max_turns.", sessionId: "sess-1", stats: { ms: 1000 } });
  });

  it("reports a failed turn that has no session id", async () => {
    const { deps } = harness([{ ok: false, error: "the Claude Agent SDK raised: down" }]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "failed", error: "the Claude Agent SDK raised: down" });
  });

  it("marks the step stopped when the abort arrives during a turn", async () => {
    const stop = new AbortController();
    const { deps, events } = harness([() => (stop.abort(), { ok: false, error: "aborted" })], stop.signal);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "stopped" });
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 0, status: "stopped", detail: "stopped", stats: { ms: 1000 } });
  });

  it("carries the session's totals with the turn, and times a turn with the real clock when none is given", async () => {
    const usage = { costUsd: 0.2, input: 10, output: 2, cacheRead: 5, cacheWrite: 1 };
    const { deps, events } = harness([{ ...reply("COORDINER: DONE", 1), usage }]);
    await runSession({ ...AUTHOR_SESSION, cards: [AUTHOR_SESSION.cards[0]!] }, deps);
    const first = events.at(-1)!;
    assert.deepEqual(first.type === "step-finished" && first.stats, { ms: 1000, usage });
    const timed = harness([reply("COORDINER: DONE", 1)]);
    delete timed.deps.now;
    await runSession({ ...AUTHOR_SESSION, cards: [AUTHOR_SESSION.cards[0]!] }, timed.deps);
    const last = timed.events.at(-1)!;
    assert.ok(last.type === "step-finished" && last.stats.ms >= 0);
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

describe("runSession: a card that cannot go on parks", () => {
  const brief = (r: TurnAsk) => [r.prompt, r.model, r.resume, r.interactive];
  const docker = "docker is not installed";

  it("parks on a HALT; Continue resumes the same session with the continue prompt and the chain reaches DONE", async () => {
    const { deps, requests, waits, events } = harness(
      [reply("plan\nCOORDINER: NEXT Light", 1), reply(`COORDINER: HALT ${docker}`, 2), reply("COORDINER: DONE", 3)],
      undefined,
      [(t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.deepEqual(requests.map(brief).at(-1), [continueAfter(docker), "m-weak", "sess-2", false]);
    assert.deepEqual(waits.map((w) => [w.card, w.parked, w.ready, w.nextCard]), [["Implement", docker, false, undefined]]);
    assert.deepEqual(events.filter((e) => e.type === "step-finished").map((e) => e.status), ["done", "halted", "done"]);
    assert.deepEqual(events.filter((e) => e.type === "step-started").map((e) => e.index), [0, 1, 2]);
  });

  it("takes a message to a parked card as a turn of the same session; Continue then applies its status line", async () => {
    const { deps, requests } = harness(
      [reply("plan\nCOORDINER: NEXT Light", 1), reply(`COORDINER: HALT ${docker}`, 2), reply("checked\nCOORDINER: DONE", 3)],
      undefined,
      [(t) => void t.send("installed it, check again"), (t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "checked" });
    assert.deepEqual(requests.map(brief).at(-1), ["installed it, check again", "m-weak", "sess-2", true]);
    assert.equal(requests.length, 3);
  });

  it("parks again with the new reason when the card halts again after Continue", async () => {
    const { deps, waits } = harness(
      [reply(`COORDINER: HALT ${docker}`, 1), reply("COORDINER: HALT docker runs, but the socket is denied", 2)],
      undefined,
      [(t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "halted", reason: "docker runs, but the socket is denied", sessionId: "sess-2" });
    assert.deepEqual(waits.map((w) => w.parked), [docker, "docker runs, but the socket is denied"]);
  });

  it("parks again when a talk on a parked card ends on a HALT and the user continues", async () => {
    const { deps, waits, requests } = harness(
      [reply(`COORDINER: HALT ${docker}`, 1), reply("COORDINER: HALT still no docker", 2), reply("COORDINER: NEXT Light", 3), reply("COORDINER: DONE", 4)],
      undefined,
      [(t) => void t.send("try now"), (t) => t.continue(), (t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.deepEqual(waits.map((w) => w.parked), [docker, undefined, "still no docker"]);
    assert.equal(requests[2]!.prompt, continueAfter("still no docker"));
  });

  it("ends with the halt's outcome and session id when the user stops a parked card", async () => {
    const stop = new AbortController();
    const { deps } = harness([reply("COORDINER: NEXT Light", 1), reply(`COORDINER: HALT ${docker}`, 2)], stop.signal, [() => stop.abort()]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "halted", reason: docker, sessionId: "sess-2" });
  });

  it("parks on a failed turn that started its session; Continue resumes that session", async () => {
    const { deps, requests } = harness(
      [reply("COORDINER: NEXT Light", 1), { ok: false, sessionId: "sess-2", error: "the API is overloaded" }, reply("COORDINER: DONE", 3)],
      undefined,
      [(t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.deepEqual(requests.map(brief).at(-1), [continueAfter("the API is overloaded"), "m-weak", "sess-2", false]);
  });

  it("parks on a failed turn with no session; Continue sends the card's prompt again on the session before", async () => {
    const { deps, requests } = harness(
      [reply("COORDINER: NEXT Light", 1), { ok: false, error: "claude was not found" }, reply("COORDINER: DONE", 3)],
      undefined,
      [(t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.deepEqual(requests.slice(1).map(brief), [
      ["/m-skills:implementing-architect Implement the approved plan above.", "m-weak", "sess-1", false],
      ["/m-skills:implementing-architect Implement the approved plan above.", "m-weak", "sess-1", false],
    ]);
  });

  it("puts a message to a card parked with no session in front of the card's prompt, so the skill still runs", async () => {
    const { deps, requests } = harness(
      [reply("COORDINER: NEXT Light", 1), { ok: false, error: "claude was not found" }, reply("COORDINER: DONE", 3)],
      undefined,
      [(t) => void t.send("fixed the path"), (t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.deepEqual(requests.map(brief).at(-1), ["fixed the path\n\n/m-skills:implementing-architect Implement the approved plan above.", "m-weak", "sess-1", true]);
  });

  it("parks when the status line is still missing after the reminder", async () => {
    const { deps, waits, requests } = harness([reply("no marker", 1), reply("still none", 2), reply("COORDINER: NEXT Light", 3), reply("COORDINER: DONE", 4)], undefined, [(t) => t.continue()]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.match(waits[0]!.parked ?? "", /did not report a COORDINER status line/);
    assert.match(requests[2]!.prompt, /^The user has handled what stopped you/);
  });

  it("parks at the turn cap; Continue gives the card a fresh allowance", async () => {
    const looping = Array.from({ length: MAX_TURNS * 2 }, (_, n) => reply("COORDINER: NEXT Light", n + 1));
    const { deps, requests, waits, events } = harness([...looping, reply("COORDINER: DONE", 99)], undefined, [(t) => t.continue()]);
    const outcome = await runSession(AUTHOR_SESSION, deps);
    assert.equal(outcome.status, "failed");
    assert.equal(requests.length, MAX_TURNS * 2);
    assert.deepEqual(waits.map((w) => w.parked), [`the run reached the ${MAX_TURNS}-turn cap without finishing.`, `the run reached the ${MAX_TURNS}-turn cap without finishing.`]);
    assert.equal(requests[MAX_TURNS]!.prompt, "Continue with the next step of the plan.");
    assert.equal(requests[MAX_TURNS]!.resume, `sess-${MAX_TURNS}`);
    const started = events.filter((e) => e.type === "step-started").map((e) => e.index);
    assert.deepEqual(started, Array.from({ length: MAX_TURNS * 2 }, (_, i) => i));
  });

  it("gives a card at the turn cap a fresh allowance when the user talks to it, then continues", async () => {
    const looping = Array.from({ length: MAX_TURNS }, (_, n) => reply("COORDINER: NEXT Light", n + 1));
    const { deps, requests, waits } = harness(
      [...looping, reply("it keeps finding more to do", 98), reply("COORDINER: DONE", 99)],
      undefined,
      [(t) => void t.send("why are you looping?"), (t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.deepEqual(waits.map((w) => w.parked), [`the run reached the ${MAX_TURNS}-turn cap without finishing.`, undefined]);
    assert.deepEqual(requests.slice(MAX_TURNS).map(brief), [
      ["why are you looping?\n\nContinue with the next step of the plan.", "m-weak", `sess-${MAX_TURNS}`, true],
      ["End your reply with your COORDINER status line.", "m-weak", "sess-98", false],
    ]);
  });

  it("gives a pausing card its talk back on Continue after a park", async () => {
    const idea = (fillInput(TEMPLATES.find((t) => t.id === "idea")!, "an offline notes app") as { ok: true; chain: Chain }).chain;
    const { deps, requests } = harness([{ ok: false, sessionId: "sess-1", error: "overloaded" }, reply("Which platforms?", 2)], undefined, [(t) => t.continue()]);
    await runSession(idea.sessions[0]!, deps);
    assert.deepEqual(requests.map(brief).at(-1), [continueAfter("overloaded"), "m-strong", "sess-1", true]);
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

  it("ends the session as done on NEXT in the history turn, the last card: no reminder", async () => {
    const { deps, requests } = harness([reply("COORDINER: DONE", 1), reply("brief\nCOORDINER: NEXT Light", 2)]);
    assert.deepEqual(await runSession(REVIEW_SESSION, deps), { status: "done", text: "brief" });
    assert.equal(requests.length, 2);
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

describe("runChain: continuing at a card", () => {
  function chainHarness(script: TurnResult[]) {
    const h = harness(script);
    let prepared = 0;
    const deps: ChainDeps = { ...h.deps, prepareReview: async () => (prepared++, { kind: "ready", marked: 0 }) };
    return { ...h, deps, prepared: () => prepared };
  }

  it("marks every started step with its session and card, across sessions", async () => {
    const { deps, events } = chainHarness([reply("COORDINER: NEXT Light", 1), reply("COORDINER: DONE", 2), reply("COORDINER: DONE", 3), reply("brief\nCOORDINER: DONE", 4)]);
    await runChain(chain, deps);
    assert.deepEqual(events.flatMap((e) => (e.type === "step-started" ? [e.position] : [])), [
      { session: 0, card: 0 },
      { session: 0, card: 1 },
      { session: 1, card: 0 },
      // The review's DONE skips the Fix card.
      { session: 1, card: 2 },
    ]);
  });

  it("resumes the stopped card's session with the given prompt, then runs the next session fresh", async () => {
    const { deps, requests, events, prepared } = chainHarness([reply("COORDINER: DONE", 5), reply("COORDINER: DONE", 6), reply("brief\nCOORDINER: DONE", 7)]);
    const from = { at: { session: 0, card: 1 }, tier: "weak" as const, resume: "sess-2", prompt: pickUpAfter("the user stopped the run") };
    assert.deepEqual(await runChain(chain, deps, from), { status: "done", text: "brief" });
    assert.deepEqual(requests.map((r) => [r.prompt, r.resume, r.model]), [
      [from.prompt, "sess-2", "m-weak"],
      ["/m-skills:code-review-architect-uncommitted", undefined, "m-strong"],
      ["/m-skills:rolling-history", "sess-6", "m-medium"],
    ]);
    assert.equal(prepared(), 1);
    assert.deepEqual(events.find((e) => e.type === "step-started"), { type: "step-started", index: 0, label: "Implement", tier: "weak", model: "m-weak", position: { session: 0, card: 1 } });
  });

  it("skips the sessions before the card, and prepares the review when it starts the session", async () => {
    const { deps, requests, prepared } = chainHarness([reply("COORDINER: DONE", 1), reply("brief\nCOORDINER: DONE", 2)]);
    await runChain(chain, deps, { at: { session: 1, card: 0 }, prompt: "/m-skills:code-review-architect-uncommitted" });
    assert.equal(prepared(), 1);
    assert.deepEqual(requests.map((r) => r.resume), [undefined, "sess-1"]);
  });

  it("does not prepare the review again when it picks up later in the review session", async () => {
    const { deps, requests, prepared } = chainHarness([reply("brief\nCOORDINER: DONE", 9)]);
    assert.deepEqual(await runChain(chain, deps, { at: { session: 1, card: 2 }, resume: "sess-8", prompt: "/m-skills:rolling-history" }), { status: "done", text: "brief" });
    assert.equal(prepared(), 0);
    assert.deepEqual(requests.map((r) => [r.prompt, r.resume]), [["/m-skills:rolling-history", "sess-8"]]);
  });

  it("starts the card fresh, on its skill's tier, when no session or tier is given", async () => {
    const { deps, requests } = chainHarness([reply("COORDINER: DONE", 1), reply("COORDINER: DONE", 2), reply("brief\nCOORDINER: DONE", 3)]);
    await runChain(chain, deps, { at: { session: 0, card: 1 }, prompt: "/m-skills:implementing-architect Implement the approved plan above." });
    assert.deepEqual([requests[0]!.resume, requests[0]!.model], [undefined, "m-medium"]);
  });

  it("refuses a card the session does not have", async () => {
    const { deps, requests } = chainHarness([]);
    assert.deepEqual(await runChain(chain, deps, { at: { session: 0, card: 9 }, prompt: "x" }), { status: "refused", reason: "This session has no such card to continue at." });
    assert.equal(requests.length, 0);
  });

  it("asks the card to check where it left off", () => {
    assert.match(pickUpAfter("VS Code closed while it ran"), /interrupted \(VS Code closed while it ran\).*COORDINER status line/);
  });

  it("asks a card that had finished for its status line again, not for the work", () => {
    assert.match(restateAfter("the user stopped the run"), /had finished.*\(the user stopped the run\)\. Do not redo it.*COORDINER status line/);
  });
});

describe("runSession: talking with the user", () => {
  const idea = (fillInput(TEMPLATES.find((t) => t.id === "idea")!, "an offline notes app") as { ok: true; chain: Chain }).chain;
  const IDEA_SESSION = idea.sessions[0]!;
  const brief = (r: TurnAsk) => [r.prompt, r.model, r.resume, r.interactive];

  it("waits after a pausing card's first turn, sends the user's message as its next turn, and moves on at Continue", async () => {
    const { deps, requests, waits, events } = harness(
      [reply("Which platforms?", 1), reply("deep dive\nCOORDINER: DONE", 2), reply("plan\nCOORDINER: NEXT Light", 3), reply("built\nCOORDINER: DONE", 4)],
      undefined,
      [(t) => void t.send("desktop only"), (t) => t.continue()],
    );
    assert.deepEqual(await runSession(IDEA_SESSION, deps), { status: "done", text: "built" });
    assert.deepEqual(requests.map(brief), [
      ["/m-skills:brainstorming-planner an offline notes app", "m-strong", undefined, true],
      ["desktop only", "m-strong", "sess-1", true],
      ["/m-skills:planning-architect Plan the Deep-Dive Execution Prompt above.", "m-strong", "sess-2", false],
      ["/m-skills:implementing-architect Implement the approved plan above.", "m-weak", "sess-3", false],
    ]);
    assert.deepEqual(waits.map((w) => [w.card, w.nextCard, w.ready]), [["Brainstorm", "Plan", false], ["Brainstorm", "Plan", true]]);
    assert.deepEqual(events.filter((e) => e.type === "step-started").map((e) => e.label), ["Brainstorm", "Brainstorm · chat", "Plan", "Implement"]);
    assert.deepEqual(events.filter((e) => e.type === "step-finished").slice(0, 2).map((e) => e.detail), ["waiting for you", "waiting for you"]);
  });

  it("moves a pausing card on at Continue even when it never gave a status line", async () => {
    const { deps, requests } = harness([reply("Which platforms?", 1), reply("plan\nCOORDINER: NEXT Light", 2), reply("built\nCOORDINER: DONE", 3)], undefined, [(t) => t.continue()]);
    assert.deepEqual(await runSession(IDEA_SESSION, deps), { status: "done", text: "built" });
    assert.equal(requests[1]!.prompt, "/m-skills:planning-architect Plan the Deep-Dive Execution Prompt above.");
    assert.equal(requests[1]!.model, "m-strong");
  });

  it("does not count turns with the user toward the turn cap", async () => {
    const chatting = Array.from({ length: MAX_TURNS + 5 }, (_, n) => reply(`answer ${n}`, n + 1));
    const { deps, requests } = harness(
      [...chatting, reply("plan\nCOORDINER: NEXT Light", 90), reply("built\nCOORDINER: DONE", 91)],
      undefined,
      [...Array.from({ length: MAX_TURNS + 4 }, () => (t: Talk) => void t.send("go on")), (t) => t.continue()],
    );
    assert.deepEqual(await runSession(IDEA_SESSION, deps), { status: "done", text: "built" });
    assert.equal(requests.length, MAX_TURNS + 7);
  });

  it("halts at Continue when the card's latest status line was a HALT", async () => {
    const { deps } = harness([reply("COORDINER: HALT the idea needs a budget first", 1), reply("ok, noted", 2)], undefined, [(t) => void t.send("why?"), (t) => t.continue()]);
    assert.deepEqual(await runSession(IDEA_SESSION, deps), { status: "halted", reason: "the idea needs a budget first", sessionId: "sess-2" });
  });

  it("stops when the run is stopped while the card waits", async () => {
    const stop = new AbortController();
    const { deps, requests } = harness([reply("Which platforms?", 1)], stop.signal, [() => stop.abort()]);
    assert.deepEqual(await runSession(IDEA_SESSION, deps), { status: "stopped" });
    assert.equal(requests.length, 1);
  });

  it("sends what the user queued during the first turn as the first message of the pause", async () => {
    const { deps, requests } = harness(
      [(t) => (t.send("and it must sync"), reply("Which platforms?", 1)), reply("noted", 2), reply("plan\nCOORDINER: NEXT Light", 3), reply("COORDINER: DONE", 4)],
      undefined,
      [(t) => t.continue()],
    );
    await runSession(IDEA_SESSION, deps);
    assert.deepEqual(requests.slice(0, 2).map(brief), [
      ["/m-skills:brainstorming-planner an offline notes app", "m-strong", undefined, true],
      ["and it must sync", "m-strong", "sess-1", true],
    ]);
  });

  it("pauses an unattended card after its turn, talks, then Continue resumes the plan at the tier it named", async () => {
    const { deps, requests, waits } = harness(
      [reply("plan\nCOORDINER: NEXT Light", 1), (t) => (t.requestPause(), reply("step 1 done\nCOORDINER: NEXT Standard", 2)), reply("because it is shared", 3), reply("COORDINER: DONE", 4)],
      undefined,
      [(t) => void t.send("why that helper?"), (t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.deepEqual(requests.map((r) => [r.prompt, r.model, r.interactive]), [
      ["/m-skills:planning-architect Story 1: Login\n\nAdd a login form.", "m-strong", false],
      ["/m-skills:implementing-architect Implement the approved plan above.", "m-weak", false],
      ["why that helper?", "m-weak", true],
      ["Continue with the next step of the plan.", "m-medium", false],
    ]);
    assert.deepEqual(waits.map((w) => [w.card, w.nextCard, w.ready]), [["Implement", undefined, true], ["Implement", undefined, true]]);
  });

  it("reminds a paused card that gave no status line, once Continue is pressed", async () => {
    const { deps, requests } = harness(
      [reply("plan\nCOORDINER: NEXT Light", 1), (t) => (t.requestPause(), reply("halfway there", 2)), reply("COORDINER: DONE", 3)],
      undefined,
      [(t) => t.continue()],
    );
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "done", text: "" });
    assert.deepEqual(requests.map((r) => [r.prompt, r.interactive]).at(-1), ["End your reply with your COORDINER status line.", false]);
  });

  it("parks on an unattended HALT even when a pause was asked for", async () => {
    const { deps, waits } = harness([(t) => (t.requestPause(), reply("COORDINER: HALT needs a migration decision", 1))]);
    assert.deepEqual(await runSession(AUTHOR_SESSION, deps), { status: "halted", reason: "needs a migration decision", sessionId: "sess-1" });
    assert.deepEqual(waits.map((w) => [w.parked, w.ready]), [["needs a migration decision", false]]);
  });

  it("tells the chat which card the turn is for by its place in the session, not only its label", async () => {
    const seen: Array<[string | undefined, number | undefined]> = [];
    const at = (t: Talk, r: TurnResult) => (seen.push([t.snapshot().card, t.snapshot().index]), r);
    const { deps } = harness([(t) => at(t, reply("plan\nCOORDINER: NEXT Light", 1)), (t) => at(t, reply("built\nCOORDINER: DONE", 2))]);
    await runSession(AUTHOR_SESSION, deps);
    assert.deepEqual(seen, [["Plan", 0], ["Implement", 1]]);
  });

  it("puts queued messages in front of the next unattended prompt, also across the fresh-context divider", async () => {
    let during: unknown;
    const h = harness([
      reply("plan\nCOORDINER: NEXT Light", 1),
      (t) => (t.send("use the existing helper"), reply("COORDINER: NEXT Light", 2)),
      (t) => ((during = [t.snapshot().session, t.snapshot().nextSession]), t.send("check the docs too"), reply("COORDINER: DONE", 3)),
      (t) => ((during = [during, t.snapshot().session, t.snapshot().nextSession]), reply("COORDINER: DONE", 4)),
      reply("brief\nCOORDINER: DONE", 5),
    ]);
    const deps: ChainDeps = { ...h.deps, prepareReview: async () => ({ kind: "ready", marked: 0 }) };
    assert.deepEqual(await runChain(chain, deps), { status: "done", text: "brief" });
    assert.equal(h.requests[2]!.prompt, "use the existing helper\n\nContinue with the next step of the plan.");
    assert.equal(h.requests[3]!.prompt, "check the docs too\n\n/m-skills:code-review-architect-uncommitted");
    assert.equal(h.requests[3]!.resume, undefined);
    assert.deepEqual(during, [[0, "Review"], 1, undefined]);
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
    assert.deepEqual(h.requests, [{ prompt: "/acme:lint", model: "m-medium", interactive: false }]);
  });

  // A one-card chain has no next card for NEXT to name: the NEXT ends the card as DONE would.
  it("ends a one-card Kickoff as done when it ends on NEXT and the user continues: no reminder, no halt", async () => {
    const h = harness([reply("profile written\nCOORDINER: NEXT Standard", 1)], undefined, [(t) => t.continue()]);
    const kickoff = TEMPLATES.find((t) => t.id === "kickoff")!;
    assert.deepEqual(await runChain(kickoff, deps(h).deps), { status: "done", text: "profile written" });
    assert.equal(h.requests.length, 1);
  });

  it("crosses into the next session when the last card of a session ends on NEXT", async () => {
    const h = harness([reply("COORDINER: NEXT Heavy", 1), reply("COORDINER: DONE", 2)]);
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("a")] }, { cards: [defaultCard("b")] }] };
    assert.deepEqual(await runChain(own, deps(h).deps), { status: "done", text: "" });
    assert.deepEqual(h.requests.map((r) => [r.prompt, r.model, r.resume]), [["/a", "m-medium", undefined], ["/b", "m-medium", undefined]]);
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

  it("runs a pinned card on its own model and effort for every turn, loop turns and the reminder included", async () => {
    const h = harness([reply("COORDINER: NEXT Heavy", 1), reply("COORDINER: NEXT Light", 2), reply("no marker", 3), reply("COORDINER: DONE", 4), reply("COORDINER: DONE", 5)]);
    const pinned = { ...defaultCard("m-skills:implementing-architect"), model: "m-pinned", effort: "low" as const };
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("a"), pinned, defaultCard("b")] }] };
    assert.equal((await runChain(own, deps(h).deps)).status, "done");
    assert.deepEqual(h.requests.map((r) => [r.model, r.effort]), [["m-medium", undefined], ["m-pinned", "low"], ["m-pinned", "low"], ["m-pinned", "low"], ["m-medium", undefined]]);
    assert.equal(h.requests[3]!.prompt, "End your reply with your COORDINER status line.");
    assert.equal(Object.hasOwn(h.requests[0]!, "effort"), false);
    const started = h.events.filter((e) => e.type === "step-started");
    assert.deepEqual(started.map((e) => [e.tier, e.model, e.effort]), [["medium", "m-medium", undefined], ["strong", "m-pinned", "low"], ["weak", "m-pinned", "low"], ["weak", "m-pinned", "low"], ["medium", "m-medium", undefined]]);
  });

  it("sets only the effort when the card keeps its tier's model", async () => {
    const h = harness([reply("COORDINER: DONE", 1)]);
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [{ ...defaultCard("acme:lint"), effort: "max" }] }] };
    await runChain(own, deps(h).deps);
    assert.deepEqual(h.requests, [{ prompt: "/acme:lint", model: "m-medium", effort: "max", interactive: false }]);
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

describe("talkOn", () => {
  // Hands out `moves` in order, one per wait; a wait with none left is a stop.
  function after(moves: Move[], results: TurnResult[]) {
    const requests: AfterAsk[] = [];
    const waits: WaitRequest[] = [];
    const run = talkOn({
      runTurn: async (request) => {
        requests.push(request);
        return results.shift()!;
      },
      talk: { waitForYou: async (request) => (waits.push(request), moves.shift() ?? { kind: "stopped" }) },
      signal: new AbortController().signal,
      card: "Kickoff",
      sessionId: "sess-1",
      model: "m-pinned",
      effort: "high",
    });
    return { run, requests, waits };
  }
  const message = (text: string): Move => ({ kind: "message", text });

  it("resumes the run's session with each message, on its model and effort, and follows the session it reports", async () => {
    const { run, requests, waits } = after([message("why?"), message("and then?")], [reply("because", 2), reply("then this", 2)]);
    await run;
    assert.deepEqual(requests, [
      { prompt: "why?", model: "m-pinned", effort: "high", resume: "sess-1" },
      { prompt: "and then?", model: "m-pinned", effort: "high", resume: "sess-2" },
    ]);
    assert.deepEqual(waits.map((w) => [w.card, w.ready, w.nextCard]), [["Kickoff", false, undefined], ["Kickoff", false, undefined], ["Kickoff", false, undefined]]);
  });

  it("keeps going after a failed turn, on the session it had", async () => {
    const { run, requests } = after([message("one"), message("two")], [{ ok: false, error: "the session failed: API Error: 400" }, reply("fine", 1)]);
    await run;
    assert.deepEqual(requests.map((r) => r.resume), ["sess-1", "sess-1"]);
  });

  it("ignores status lines and Continue: only a stop ends it", async () => {
    const { run, requests } = after([message("one"), { kind: "continue" }, message("two")], [reply("COORDINER: HALT nope", 1), reply("COORDINER: DONE", 1)]);
    await run;
    assert.equal(requests.length, 2);
  });

  it("sends no effort when the run had none, and stops when the run's chat is aborted", async () => {
    const talk = new Talk({ changed: () => undefined, delivered: () => undefined, answered: () => undefined });
    talk.end({ after: { card: "Kickoff" } });
    const abort = new AbortController();
    const requests: AfterAsk[] = [];
    const run = talkOn({
      runTurn: async (request) => {
        requests.push(request);
        abort.abort();
        return reply("ok", 1);
      },
      talk,
      signal: abort.signal,
      card: "Kickoff",
      sessionId: "sess-1",
      model: "m-medium",
    });
    talk.send("hello");
    await run;
    assert.deepEqual(requests, [{ prompt: "hello", model: "m-medium", resume: "sess-1" }]);
  });
});
