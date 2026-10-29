import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_ENTRIES } from "./chat-logic.ts";
import { cardPrompt, MAX_INPUT_CHARS, TEMPLATES } from "./chains.ts";
import { byWorktree, CLOSED_MID_RUN, continuePoint, journalsOf, listed, MAX_LISTED, parseJournal, readNewest, type PastRun } from "./history.ts";
import { continueAfter, fillInput, pickUpAfter, restateAfter } from "./run.ts";

const START = { at: "2026-10-27T15:34:11.325Z", type: "run-started", chain: "Story", story: "11", repo: "/r", worktree: "/r.coordiner/11", branch: "coordiner/11", models: {}, questions: "timed" };
const journal = (...records: object[]) => [START, ...records].map((r) => JSON.stringify(r)).join("\n") + "\n";
const parse = (...records: object[]) => parseJournal(journal(...records), "11.jsonl")!;
const started = (index: number, label: string, extra: object = {}) => ({ type: "step-started", index, label, tier: "strong", model: "claude-opus-5-5", ...extra });

describe("parseJournal", () => {
  it("reads where the run happened and how it ended", () => {
    const run = parse({ at: "2026-10-27T16:00:00.000Z", type: "outcome", outcome: { status: "done", text: "Commit brief" } });
    assert.deepEqual(
      { file: run.file, chain: run.chain, story: run.story, repo: run.repo, worktree: run.worktree, branch: run.branch, questions: run.questions, lastAt: run.lastAt, outcome: run.outcome },
      { file: "11.jsonl", chain: "Story", story: "11", repo: "/r", worktree: "/r.coordiner/11", branch: "coordiner/11", questions: "timed", lastAt: "2026-10-27T16:00:00.000Z", outcome: { status: "done", text: "Commit brief" } },
    );
    assert.deepEqual(run.entries, [{ kind: "end", status: "done" }]);
    assert.deepEqual(run.ending, { status: "done" });
  });

  it("rebuilds the transcript in journal order from every record that shows in the chat", () => {
    const run = parse(
      { type: "entry", entry: { kind: "assistant", card: "Plan", text: "the plan" } },
      { type: "entry", entry: { kind: "tool", card: "Plan", name: "Bash", input: "{}" } },
      { type: "you", card: "Plan", text: "smaller" },
      { type: "answer", card: "Plan", question: "Store?", answer: "SQLite" },
      { type: "decided", card: "Plan", question: "Fonts?", answer: "none (Recommended)", after: "at once" },
      { type: "entry", entry: { kind: "divider", session: 1 } },
      { type: "entry", entry: { kind: "failed", card: "Review", error: "no network" } },
      { type: "outcome", outcome: { status: "halted", reason: "needs you", sessionId: "s-1" } },
      { type: "you", card: "Review", text: "go on" },
    );
    assert.deepEqual(run.entries, [
      { kind: "assistant", card: "Plan", text: "the plan" },
      { kind: "tool", card: "Plan", name: "Bash", input: "{}" },
      { kind: "you", card: "Plan", text: "smaller" },
      { kind: "answer", card: "Plan", question: "Store?", answer: "SQLite" },
      { kind: "decided", card: "Plan", question: "Fonts?", answer: "none (Recommended)", after: "at once" },
      { kind: "divider", session: 1 },
      { kind: "failed", card: "Review", error: "no network" },
      { kind: "end", status: "halted", reason: "needs you" },
      { kind: "you", card: "Review", text: "go on" },
    ]);
    assert.equal(run.userOnly, false);
  });

  it("reads each kind of outcome, keeping only what the transcript and the list show", () => {
    const outcomes = [
      { status: "no-changes" },
      { status: "stopped" },
      { status: "refused", reason: "no m-skills" },
      { status: "failed", error: "API Error", sessionId: "s-1", at: { session: 0, card: 1 } },
    ];
    assert.deepEqual(
      outcomes.map((outcome) => parse({ type: "outcome", outcome }).outcome),
      [{ status: "no-changes" }, { status: "stopped" }, { status: "refused", reason: "no m-skills" }, { status: "failed", error: "API Error" }],
    );
  });

  it("strips control characters from everything it shows", () => {
    const run = parse(
      { type: "entry", entry: { kind: "assistant", card: "Pl\u001ban", text: "a\u0007b" } },
      { type: "entry", entry: { kind: "tool", card: "P", name: "B\u001bash", input: "x".repeat(2100) } },
      { type: "answer", card: "P", question: "Q\u001b?", answer: "A\u001b" },
      { type: "decided", card: "P", question: "Q\u001b?", answer: "A\u001b", after: "after 5 minutes" },
      { type: "entry", entry: { kind: "failed", card: "P", error: "e\u001brr" } },
      { type: "outcome", outcome: { status: "failed", error: "bad\u001b" } },
    );
    assert.deepEqual(run.entries.slice(0, 2), [
      { kind: "assistant", card: "Plan", text: "ab" },
      { kind: "tool", card: "P", name: "Bash", input: `${"x".repeat(2000)}…` },
    ]);
    assert.deepEqual(run.entries.slice(2), [
      { kind: "answer", card: "P", question: "Q?", answer: "A" },
      { kind: "decided", card: "P", question: "Q?", answer: "A", after: "after 5 minutes" },
      { kind: "failed", card: "P", error: "err" },
      { kind: "end", status: "failed", reason: "bad" },
    ]);
    assert.deepEqual(parse({ type: "outcome", outcome: { status: "halted", reason: "r\u001b" } }).outcome, { status: "halted", reason: "r" });
    assert.deepEqual(parse({ type: "outcome", outcome: { status: "done", text: "t\u001b" } }).outcome, { status: "done", text: "t" });
  });

  it("drops lines that are not JSON, records of unknown types, and fields of the wrong shape", () => {
    const text = [
      JSON.stringify(START),
      "not json",
      "[1,2]",
      JSON.stringify({ type: "mystery" }),
      JSON.stringify({ type: "you", card: "Plan", text: 3 }),
      JSON.stringify({ type: "answer", card: "Plan" }),
      JSON.stringify({ type: "decided", card: "P", question: "Q", answer: "A", after: "later" }),
      JSON.stringify({ type: "entry", entry: "text" }),
      JSON.stringify({ type: "entry", entry: { kind: "end", status: "done" } }),
      JSON.stringify({ type: "entry", entry: { kind: "assistant", card: "P" } }),
      JSON.stringify({ type: "entry", entry: { kind: "tool", card: "P", name: "B" } }),
      JSON.stringify({ type: "entry", entry: { kind: "divider", session: 0 } }),
      JSON.stringify({ type: "entry", entry: { kind: "failed", card: "P" } }),
      JSON.stringify({ type: "outcome", outcome: "done" }),
      JSON.stringify({ type: "outcome", outcome: { status: "won" } }),
      JSON.stringify({ type: "outcome", outcome: { status: "done" } }),
      JSON.stringify({ type: "outcome", outcome: { status: "halted" } }),
      JSON.stringify({ type: "outcome", outcome: { status: "failed" } }),
      JSON.stringify({ type: "you", card: "Plan", text: "kept", at: 5 }),
    ].join("\n");
    const run = parseJournal(text, "f")!;
    assert.deepEqual(run.entries, [
      { kind: "you", card: "Plan", text: "kept" },
      { kind: "end", status: "stopped", reason: CLOSED_MID_RUN },
    ]);
    assert.equal(run.outcome, undefined);
    assert.equal(run.lastAt, START.at);
  });

  it("keeps the first outcome when a journal has two", () => {
    const run = parse({ type: "outcome", outcome: { status: "stopped" } }, { type: "outcome", outcome: { status: "done", text: "" } });
    assert.deepEqual(run.outcome, { status: "stopped" });
    assert.equal(run.entries.filter((e) => e.kind === "end").length, 1);
  });

  it("is nothing without a valid run-started record first", () => {
    assert.equal(parseJournal("", "f"), undefined);
    assert.equal(parseJournal(JSON.stringify({ type: "log", line: "x" }), "f"), undefined);
    assert.equal(parseJournal(JSON.stringify({ ...START, questions: "sometimes" }), "f"), undefined);
    assert.equal(parseJournal(JSON.stringify({ ...START, repo: 7 }), "f"), undefined);
  });

  it("has no last time when the start record has none", () => {
    const { at: _at, ...undated } = START;
    assert.equal(parseJournal(JSON.stringify(undated), "f")!.lastAt, "");
  });

  it("marks a run with no outcome as closed mid-run, its running step stopped", () => {
    const run = parse(started(0, "Plan"), { type: "step-finished", index: 0, status: "done", detail: "next: Standard" }, started(1, "Implement", { tier: "medium", model: "claude-sonnet-5-5", effort: "high" }));
    assert.equal(run.outcome, undefined);
    assert.deepEqual(run.entries, [{ kind: "end", status: "stopped", reason: CLOSED_MID_RUN }]);
    assert.deepEqual(run.ending, { status: "stopped", reason: CLOSED_MID_RUN });
    assert.deepEqual(run.steps, [
      { label: "Plan", tier: "strong", model: "claude-opus-5-5", status: "done", detail: "next: Standard" },
      { label: "Implement", tier: "medium", model: "claude-sonnet-5-5", effort: "high", status: "stopped", detail: CLOSED_MID_RUN },
    ]);
  });

  it("drops steps of the wrong shape or out of order, and finishes only a step it has", () => {
    const run = parse(
      started(1, "Skipped ahead"),
      started(0, "Plan", { tier: "huge" }),
      started(0, "Plan", { model: "bad model" }),
      started(0, "Plan", { effort: "extreme" }),
      { type: "step-finished", index: 3, status: "done", detail: "" },
      { type: "step-finished", index: "0", status: "done", detail: "" },
      { type: "step-finished", index: 0, status: "won", detail: "" },
      { type: "step-finished", index: 0, status: "halted", detail: "needs \u001byou" },
      { type: "outcome", outcome: { status: "halted", reason: "needs you" } },
    );
    assert.deepEqual(run.steps, [{ label: "Plan", tier: "strong", model: "claude-opus-5-5", status: "halted", detail: "needs you" }]);
  });

  it("talks to the session of the latest turn record", () => {
    const run = parse(
      { type: "turn", sessionId: "s-1", model: "claude-opus-5-5", card: "Plan", reply: "first" },
      { type: "turn", sessionId: "s-2", model: "claude-sonnet-5-5", effort: "low", card: "Imp\u001blement", reply: "second" },
      { type: "turn", sessionId: "not a session", model: "claude-opus-5-5", card: "Plan", reply: "bad" },
      { type: "turn", sessionId: "s-3", model: "bad model", card: "Plan", reply: "bad" },
    );
    assert.deepEqual(run.last, { sessionId: "s-2", model: "claude-sonnet-5-5", effort: "low", card: "Implement", reply: "second" });
    assert.equal(run.userOnly, false);
  });

  it("falls back, for a journal from before turns were recorded, to the last finished step's session with no reply", () => {
    const run = parse(
      started(0, "Plan", { effort: "max" }),
      { type: "step-finished", index: 0, status: "done", detail: "next", sessionId: "s-1" },
      started(1, "Implement"),
      { type: "step-finished", index: 1, status: "halted", detail: "stuck", sessionId: "bad id!" },
      { type: "outcome", outcome: { status: "halted", reason: "stuck" } },
    );
    assert.deepEqual(run.last, { sessionId: "s-1", model: "claude-opus-5-5", effort: "max", card: "Plan", reply: "" });
    assert.equal(run.userOnly, true);
    assert.equal(parse(started(0, "Plan"), { type: "step-finished", index: 0, status: "done", detail: "" }).last, undefined);
    assert.deepEqual(parse(started(0, "Plan"), { type: "step-finished", index: 0, status: "done", detail: "", sessionId: "s-9" }).last, { sessionId: "s-9", model: "claude-opus-5-5", card: "Plan", reply: "" });
  });

  it("keeps the newest entries of a long transcript, with the dropped marker first", () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({ type: "you", card: "Plan", text: `m${i}` }));
    const { entries } = parse(...many);
    assert.equal(entries.length, MAX_ENTRIES + 1);
    assert.deepEqual(entries[0], { kind: "dropped" });
    assert.deepEqual(entries.at(-1), { kind: "end", status: "stopped", reason: CLOSED_MID_RUN });
  });
});

describe("continuePoint", () => {
  const STORY = TEMPLATES.find((t) => t.id === "story")!;
  const DEFINED = { ...START, definition: STORY, input: "Story 11: Export" };
  const defined = (...records: object[]) => parseJournal([DEFINED, ...records].map((r) => JSON.stringify(r)).join("\n"), "11.jsonl")!;
  const { builtIn: _builtIn, ...shape } = STORY;
  const filledStory = (fillInput(shape, "Story 11: Export") as { ok: true; chain: typeof STORY }).chain;
  const plan = started(0, "Plan", { position: { session: 0, card: 0 } });
  const planned = { type: "step-finished", index: 0, status: "done", detail: "next: Light", sessionId: "s-1" };
  const implement = started(1, "Implement", { tier: "weak", model: "claude-haiku-5-5", position: { session: 0, card: 1 } });

  it("keeps the journaled chain and its input", () => {
    const run = defined();
    assert.deepEqual(run.definition, shape);
    assert.equal(run.input, "Story 11: Export");
  });

  it("retries a stopped card in its session, on the tier it ran on", () => {
    const point = continuePoint(defined(plan, planned, implement, { type: "step-finished", index: 1, status: "stopped", detail: "stopped", sessionId: "s-2" }, { type: "outcome", outcome: { status: "stopped" } }))!;
    assert.deepEqual(point.from, { at: { session: 0, card: 1 }, tier: "weak", resume: "s-2", prompt: pickUpAfter("the user stopped the run") });
    assert.deepEqual([point.card, point.reason], ["Implement", "the user stopped the run"]);
    assert.deepEqual(point.chain, filledStory);
  });

  it("asks a halted or failed card to check the fix", () => {
    const halted = continuePoint(defined(plan, { ...planned, status: "halted", detail: "needs a decision" }, { type: "outcome", outcome: { status: "halted", reason: "needs a decision", sessionId: "s-1" } }))!;
    assert.equal(halted.from.prompt, continueAfter("needs a decision"));
    const failed = continuePoint(defined(plan, { ...planned, status: "failed", detail: "API Error" }, { type: "outcome", outcome: { status: "failed", error: "API Error" } }))!;
    assert.equal(failed.from.prompt, continueAfter("API Error"));
  });

  it("picks up a run cut off by VS Code closing at the card that was running, in the session before it", () => {
    const point = continuePoint(defined(plan, planned, implement))!;
    // The cut turn left no session id, and none of its turns reached a session, so the card is sent its own prompt again.
    assert.deepEqual(point.from, { at: { session: 0, card: 1 }, tier: "weak", resume: "s-1", prompt: cardPrompt(filledStory.sessions[0]!.cards[1]!) });
    assert.equal(point.reason, CLOSED_MID_RUN);
  });

  it("treats a card as reached when an earlier turn of it took the prompt", () => {
    const point = continuePoint(defined(plan, planned, implement, { type: "step-finished", index: 1, status: "done", detail: "next: Light", sessionId: "s-2" }, started(2, "Implement", { tier: "weak", model: "claude-haiku-5-5", position: { session: 0, card: 1 } })))!;
    assert.deepEqual([point.from.resume, point.from.prompt], ["s-2", pickUpAfter(CLOSED_MID_RUN)]);
  });

  it("starts a later session fresh rather than resuming the session before it", () => {
    const review = started(2, "Review", { position: { session: 1, card: 0 } });
    const point = continuePoint(defined(plan, planned, implement, { type: "step-finished", index: 1, status: "done", detail: "done", sessionId: "s-2" }, review))!;
    assert.deepEqual(point.from, { at: { session: 1, card: 0 }, tier: "strong", prompt: "/m-skills:code-review-architect-uncommitted" });
  });

  // Preparing the review can halt or fail before the review card starts: the author's finished card is not the place to go back to.
  it("picks up at the card a halted or failed outcome names, even one that never started", () => {
    const implemented = { type: "step-finished", index: 1, status: "done", detail: "done", sessionId: "s-2" };
    const halted = defined(plan, planned, implement, implemented, { type: "outcome", outcome: { status: "halted", reason: "too many new files", at: { session: 1, card: 0 } } });
    assert.deepEqual(halted.lastCard, { at: { session: 1, card: 0 }, reached: false, finished: false });
    const point = continuePoint(halted)!;
    assert.deepEqual(point.from, { at: { session: 1, card: 0 }, prompt: "/m-skills:code-review-architect-uncommitted" });
    assert.deepEqual([point.card, point.reason], ["Review", "too many new files"]);
    const failed = continuePoint(defined({ type: "outcome", outcome: { status: "failed", error: "git failed", at: { session: 1, card: 0 } } }))!;
    assert.deepEqual(failed.from.at, { session: 1, card: 0 });
  });

  it("falls back to the card last started when the outcome names a card outside the chain, or the run was stopped", () => {
    const halted = defined(plan, { ...planned, status: "halted", detail: "x" }, { type: "outcome", outcome: { status: "halted", reason: "x", at: { session: 7, card: 0 } } });
    assert.deepEqual(halted.lastCard?.at, { session: 0, card: 0 });
    const stopped = defined(plan, { ...planned, status: "stopped", detail: "stopped" }, { type: "outcome", outcome: { status: "stopped", at: { session: 1, card: 0 } } });
    assert.deepEqual(stopped.lastCard?.at, { session: 0, card: 0 });
  });

  it("asks a card that had given its reply for its status line again, in its session", () => {
    const waited = { type: "step-finished", index: 1, status: "done", detail: "waiting for you", sessionId: "s-2" };
    const stopped = continuePoint(defined(plan, planned, implement, waited, { type: "outcome", outcome: { status: "stopped" } }))!;
    assert.deepEqual(stopped.from, { at: { session: 0, card: 1 }, tier: "weak", resume: "s-2", prompt: restateAfter("the user stopped the run") });
    assert.equal(continuePoint(defined(plan, planned, implement, waited))!.from.prompt, restateAfter(CLOSED_MID_RUN));
  });

  it("forgets where a run halted once it was continued", () => {
    const run = defined(
      plan,
      planned,
      implement,
      { type: "step-finished", index: 1, status: "halted", detail: "needs a decision", sessionId: "s-2" },
      { type: "outcome", outcome: { status: "halted", reason: "needs a decision", at: { session: 0, card: 1 } } },
      { type: "continued", position: { session: 0, card: 1 }, questions: "timed" },
      started(2, "Implement", { tier: "weak", model: "claude-haiku-5-5", position: { session: 0, card: 1 } }),
      { type: "step-finished", index: 2, status: "done", detail: "done", sessionId: "s-2" },
      started(3, "Review", { position: { session: 1, card: 0 } }),
    );
    assert.deepEqual(run.lastCard, { at: { session: 1, card: 0 }, tier: "strong", reached: false, finished: false });
  });

  it("offers nothing for a run that finished, found nothing to review, or was refused", () => {
    for (const outcome of [{ status: "done", text: "" }, { status: "no-changes" }, { status: "refused", reason: "no m-skills" }]) {
      assert.equal(continuePoint(defined(plan, planned, { type: "outcome", outcome })), undefined);
    }
  });

  it("offers nothing for an input the chain cannot take", () => {
    assert.equal(continuePoint({ ...defined(plan, planned), input: "x".repeat(MAX_INPUT_CHARS + 1) }), undefined);
  });

  it("offers nothing for a journal from before runs could be continued, or one with no step", () => {
    assert.equal(continuePoint(parse(plan, { type: "outcome", outcome: { status: "stopped" } })), undefined);
    assert.equal(continuePoint(defined({ type: "outcome", outcome: { status: "stopped" } })), undefined);
  });

  it("reads a continued run to its own end, and keeps counting its steps", () => {
    const run = defined(
      plan,
      { ...planned, status: "stopped", detail: "stopped" },
      { type: "outcome", outcome: { status: "stopped" } },
      { type: "continued", position: { session: 0, card: 0 }, questions: "never" },
      started(1, "Plan", { position: { session: 0, card: 0 } }),
      { type: "step-finished", index: 1, status: "done", detail: "done", sessionId: "s-3" },
      { type: "outcome", outcome: { status: "done", text: "brief" } },
    );
    assert.deepEqual(run.outcome, { status: "done", text: "brief" });
    assert.equal(run.questions, "never");
    assert.equal(run.steps.length, 2);
    assert.deepEqual(run.entries.filter((e) => e.kind === "end"), [{ kind: "end", status: "stopped" }, { kind: "end", status: "done" }]);
    assert.equal(continuePoint(run), undefined);
  });

  it("ignores a continued record with an unknown question choice", () => {
    const run = defined({ type: "outcome", outcome: { status: "stopped" } }, { type: "continued", position: { session: 0, card: 0 }, questions: "sometimes" });
    assert.deepEqual(run.outcome, { status: "stopped" });
    assert.equal(run.questions, "timed");
  });

  // A journal is a file anyone with access to the editor's storage can write; what it says runs only if it is a valid chain.
  it("drops a journaled chain whose card names an invalid skill", () => {
    const bad = { ...STORY, sessions: [{ cards: [{ skill: "rm -rf /", args: "", label: "X", pause: false }] }] };
    const run = parseJournal(JSON.stringify({ ...START, definition: bad, input: "" }), "f")!;
    assert.equal(run.definition, undefined);
    assert.equal(continuePoint(run), undefined);
  });

  it("drops a journaled chain over the card limits, and an input over the input limit", () => {
    const tooMany = { ...STORY, sessions: Array.from({ length: 21 }, () => ({ cards: [] })) };
    assert.equal(parseJournal(JSON.stringify({ ...START, definition: tooMany, input: "" }), "f")!.definition, undefined);
    assert.equal(parseJournal(JSON.stringify({ ...DEFINED, input: "x".repeat(MAX_INPUT_CHARS + 1) }), "f")!.definition, undefined);
  });

  it("drops a step position outside the journaled chain", () => {
    for (const at of [{ session: 5, card: 0 }, { session: 0, card: 9 }, { session: -1, card: 0 }, { session: 0.5, card: 0 }, "0:0"]) {
      assert.equal(defined(started(0, "Plan", { position: at })).lastCard, undefined);
    }
  });

  it("does not resume a session id that is not one claude gives", () => {
    const point = continuePoint(defined(plan, { ...planned, sessionId: "--dangerous" }, { type: "outcome", outcome: { status: "stopped" } }))!;
    assert.equal(point.from.resume, undefined);
  });
});

describe("listed", () => {
  const run = (file: string, repo: string, lastAt: string) => ({ file, repo, lastAt }) as PastRun;

  it("lists the open repo's runs newest first, without the one whose chat is open", () => {
    const runs = [run("a", "/r", "2026-10-25T10:00:00.000Z"), run("b", "/other", "2026-10-28T10:00:00.000Z"), run("c", "/r", "2026-10-27T10:00:00.000Z"), run("d", "/r", "2026-10-26T10:00:00.000Z")];
    assert.deepEqual(listed(runs, "/r", "d").map((r) => r.file), ["c", "a"]);
    assert.deepEqual(listed(runs, "/r").map((r) => r.file), ["c", "d", "a"]);
  });

  it("keeps the newest fifty", () => {
    const runs = Array.from({ length: MAX_LISTED + 5 }, (_, i) => run(`f${i}`, "/r", new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()));
    const shown = listed(runs, "/r");
    assert.equal(shown.length, MAX_LISTED);
    assert.equal(shown[0]!.file, `f${MAX_LISTED + 4}`);
  });
});

describe("readNewest", () => {
  const run = (file: string, repo: string, lastAt: string) => ({ file, repo, lastAt }) as PastRun;

  it("reads the newest files first and stops once the newest fifty of the repo are in hand", async () => {
    const files = Array.from({ length: MAX_LISTED + 20 }, (_, i) => ({ name: `f${i}`, mtimeMs: i }));
    const read: string[] = [];
    const shown = await readNewest(files, async (name) => (read.push(name), run(name, "/r", new Date(Date.UTC(2026, 0, 1) + Number(name.slice(1)) * 60_000).toISOString())), "/r");
    assert.equal(shown.length, MAX_LISTED);
    assert.equal(read.length, MAX_LISTED);
    assert.equal(read[0], `f${MAX_LISTED + 19}`);
    assert.equal(shown[0]!.file, `f${MAX_LISTED + 19}`);
  });

  it("reads past other repos' journals, the open one and unreadable ones without counting them", async () => {
    const files = ["open", "bad", "other", "mine"].map((name, i) => ({ name, mtimeMs: 10 - i }));
    const reads: Record<string, PastRun | undefined> = { open: run("open", "/r", "2026-10-28T10:00:00.000Z"), bad: undefined, other: run("other", "/x", "2026-10-27T10:00:00.000Z"), mine: run("mine", "/r", "2026-10-26T10:00:00.000Z") };
    const shown = await readNewest(files, async (name) => reads[name], "/r", "open");
    assert.deepEqual(shown.map((r) => r.file), ["mine"]);
  });

  it("is empty with no files", async () => {
    assert.deepEqual(await readNewest([], async () => undefined, "/r"), []);
  });
});

describe("byWorktree", () => {
  const run = (file: string, worktree: string, lastAt: string) => ({ file, worktree, branch: `coordiner/${worktree.split("/").at(-1)}`, lastAt }) as PastRun;
  const all = () => true;

  it("puts the runs of one worktree under one line, newest run first", () => {
    const runs = [run("b", "/r.coordiner/x", "2026-10-28T10:00:00.000Z"), run("a", "/r.coordiner/x", "2026-10-27T10:00:00.000Z")];
    const [line, ...rest] = byWorktree(runs, [{ path: "/r.coordiner/x", branch: "coordiner/x" }], all);
    assert.deepEqual(rest, []);
    assert.deepEqual({ ...line, runs: line!.runs.map((r) => r.file) }, { path: "/r.coordiner/x", branch: "coordiner/x", slug: "x", where: "here", runs: ["b", "a"] });
  });

  it("lists a worktree git knows with no run left, after the lines with runs, by name", () => {
    const lines = byWorktree(
      [run("a", "/r.coordiner/x", "2026-10-27T10:00:00.000Z"), run("b", "/r.coordiner/y", "2026-10-28T10:00:00.000Z")],
      [{ path: "/r.coordiner/z", branch: "coordiner/z" }, { path: "/r.coordiner/c", branch: "coordiner/c" }, { path: "/r.coordiner/x", branch: "coordiner/x" }],
      all,
    );
    assert.deepEqual(lines.map((l) => [l.slug, l.runs.length]), [["y", 1], ["x", 1], ["c", 0], ["z", 0]]);
    const after = byWorktree([run("a", "/r.coordiner/x", "2026-10-27T10:00:00.000Z")], [{ path: "/r.coordiner/x", branch: "coordiner/x" }, { path: "/r.coordiner/z", branch: "coordiner/z" }], all);
    assert.deepEqual(after.map((l) => l.slug), ["x", "z"]);
  });

  it("names a line by its whole path when the path ends in a separator", () => {
    assert.equal(byWorktree([], [{ path: "/r.coordiner/x/", branch: "coordiner/x" }], all)[0]!.slug, "/r.coordiner/x/");
  });

  it("tells a removed folder from a folder git no longer lists", () => {
    const lines = byWorktree(
      [run("a", "/r.coordiner/gone", "2026-10-27T10:00:00.000Z"), run("b", "/r.coordiner/kept", "2026-10-27T09:00:00.000Z")],
      [{ path: "/r.coordiner/pruned", branch: "coordiner/pruned" }],
      (path) => path.endsWith("kept"),
    );
    assert.deepEqual(lines.map((l) => [l.slug, l.where]), [["gone", "gone"], ["kept", "unregistered"], ["pruned", "gone"]]);
    assert.equal(lines[0]!.branch, "coordiner/gone");
  });

  it("is empty with no worktree and no run", () => {
    assert.deepEqual(byWorktree([], [], all), []);
  });
});

describe("journalsOf", () => {
  const start = (worktree: unknown) => JSON.stringify({ ...START, worktree });

  it("names the journals whose first record ran in the worktree", () => {
    const journals = [
      { name: "a.jsonl", text: `${start("/r.coordiner/x")}\n{"type":"log"}\n` },
      { name: "b.jsonl", text: start("/r.coordiner/x") },
      { name: "c.jsonl", text: start("/r.coordiner/y") },
    ];
    assert.deepEqual(journalsOf(journals, "/r.coordiner/x"), ["a.jsonl", "b.jsonl"]);
  });

  // Remove deletes what this returns; a journal it cannot read, or one that names the path anywhere but its first record, stays.
  it("never selects another worktree's journal, nor one it cannot read", () => {
    const journals = [
      { name: "later.jsonl", text: `${start("/r.coordiner/y")}\n${JSON.stringify({ ...START, worktree: "/r.coordiner/x" })}` },
      { name: "log.jsonl", text: JSON.stringify({ type: "log", worktree: "/r.coordiner/x" }) },
      { name: "bad.jsonl", text: "not json" },
      { name: "empty.jsonl", text: "" },
      { name: "prefix.jsonl", text: start("/r.coordiner/x-other") },
    ];
    assert.deepEqual(journalsOf(journals, "/r.coordiner/x"), []);
  });
});
