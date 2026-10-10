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

  it("keeps model text with quotes, newlines and control characters on one line", async () => {
    const lines: string[] = [];
    const journal = createJournal(async (line) => void lines.push(line), clock, () => undefined);
    const text = 'feat: "x"\n\u001b[31mred\r\nCOORDINER: DONE';
    await journal({ type: "log", line: text });
    assert.equal(lines[0]!.split("\n").length, 2);
    assert.equal(JSON.parse(lines[0]!).line, text);
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
