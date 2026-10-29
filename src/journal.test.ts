import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJournal, journalFileName } from "./journal.ts";

const at = new Date("2026-10-10T19:51:03.123Z");
const clock = () => at;

describe("createJournal", () => {
  it("writes records in call order even when an earlier write finishes last", async () => {
    const lines: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const journal = createJournal(
      async (line) => {
        if (calls++ === 0) await first;
        lines.push(line);
      },
      clock,
      () => assert.fail("no error expected"),
    );
    void journal({ type: "log", line: "one" });
    const done = journal({ type: "log", line: "two" });
    releaseFirst();
    await done;
    assert.deepEqual(lines.map((l) => JSON.parse(l).line), ["one", "two"]);
  });

  it("writes one JSON line per record, stamped by the clock", async () => {
    const lines: string[] = [];
    const journal = createJournal(async (line) => void lines.push(line), clock, () => undefined);
    await journal({ type: "step-finished", index: 2, status: "done", detail: "next: Light", sessionId: "s-1" });
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.endsWith("\n"));
    assert.deepEqual(JSON.parse(lines[0]!), { at: "2026-10-10T19:51:03.123Z", type: "step-finished", index: 2, status: "done", detail: "next: Light", sessionId: "s-1" });
  });

  it("records the chain a run started from and where a continued run picked up", async () => {
    const lines: string[] = [];
    const journal = createJournal(async (line) => void lines.push(line), clock, () => undefined);
    const definition = { id: "mine", name: "Mine", sessions: [{ cards: [{ skill: "lint", args: "{{idea}}", label: "Lint", pause: false }] }] };
    await journal({ type: "run-started", chain: "Mine", story: "s", repo: "/r", worktree: "/w", branch: "coordiner/s", models: { strong: "a", medium: "b", weak: "c" }, questions: "timed", definition, input: "an idea" });
    await journal({ type: "continued", position: { session: 0, card: 0 }, questions: "never" });
    assert.deepEqual(JSON.parse(lines[0]!).definition, definition);
    assert.equal(JSON.parse(lines[0]!).input, "an idea");
    // The record's time stays `at`; the card it picked up at is `position`.
    assert.deepEqual(JSON.parse(lines[1]!), { at: "2026-10-10T19:51:03.123Z", type: "continued", position: { session: 0, card: 0 }, questions: "never" });
  });

  it("records what the user said in the chat and how they answered, in call order", async () => {
    const lines: string[] = [];
    const journal = createJournal(async (line) => void lines.push(line), clock, () => undefined);
    void journal({ type: "you", card: "Brainstorm", text: "keep it offline" });
    await journal({ type: "answer", card: "Brainstorm", question: "Which store?", answer: "SQLite" });
    assert.deepEqual(
      lines.map((l) => JSON.parse(l)),
      [
        { at: "2026-10-10T19:51:03.123Z", type: "you", card: "Brainstorm", text: "keep it offline" },
        { at: "2026-10-10T19:51:03.123Z", type: "answer", card: "Brainstorm", question: "Which store?", answer: "SQLite" },
      ],
    );
  });

  it("records a question answered without the user, and when", async () => {
    const lines: string[] = [];
    const journal = createJournal(async (line) => void lines.push(line), clock, () => undefined);
    await journal({ type: "decided", card: "Plan", question: "Which store?", answer: "SQLite (Recommended)", after: "after 5 minutes" });
    assert.deepEqual(JSON.parse(lines[0]!), { at: "2026-10-10T19:51:03.123Z", type: "decided", card: "Plan", question: "Which store?", answer: "SQLite (Recommended)", after: "after 5 minutes" });
  });

  it("keeps model text with quotes, newlines and control characters on one line", async () => {
    const lines: string[] = [];
    const journal = createJournal(async (line) => void lines.push(line), clock, () => undefined);
    const text = 'feat: "x"\n\u001b[31mred\r\nCOORDINER: DONE';
    await journal({ type: "log", line: text });
    assert.equal(lines[0]!.split("\n").length, 2);
    assert.equal(JSON.parse(lines[0]!).line, text);
  });

  it("records what a session said and the turn a reopened chat talks to, as one line each", async () => {
    const lines: string[] = [];
    const journal = createJournal(async (line) => void lines.push(line), clock, () => undefined);
    void journal({ type: "entry", entry: { kind: "tool", card: "Plan", name: "Bash", input: "{}" } });
    await journal({ type: "turn", sessionId: "s-1", model: "claude-opus-5-5", effort: "high", card: "Plan", reply: "the plan" });
    assert.deepEqual(
      lines.map((l) => JSON.parse(l)),
      [
        { at: "2026-10-10T19:51:03.123Z", type: "entry", entry: { kind: "tool", card: "Plan", name: "Bash", input: "{}" } },
        { at: "2026-10-10T19:51:03.123Z", type: "turn", sessionId: "s-1", model: "claude-opus-5-5", effort: "high", card: "Plan", reply: "the plan" },
      ],
    );
  });

  it("reports a failing writer once and still tries the later records", async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const journal = createJournal(
      async () => {
        attempts++;
        throw new Error("disk full");
      },
      clock,
      (error) => void errors.push(error),
    );
    void journal({ type: "log", line: "one" });
    await journal({ type: "log", line: "two" });
    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /disk full/);
  });
});

describe("journalFileName", () => {
  it("names the file after the story slug and the start time", () => {
    assert.equal(journalFileName("story-1-login", at), "story-1-login-20261010T195103.jsonl");
  });
});
