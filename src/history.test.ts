import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_ENTRIES } from "./chat-logic.ts";
import { CLOSED_MID_RUN, listed, MAX_LISTED, parseJournal, readNewest, type PastRun } from "./history.ts";

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
