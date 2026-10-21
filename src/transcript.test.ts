import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_ENTRIES } from "./chat-logic.ts";
import { entriesFrom, Transcript, type Entry } from "./transcript.ts";

// Fixtures carry only the fields entriesFrom reads.
const assistant = (...content: object[]) => ({ type: "assistant", parent_tool_use_id: null, message: { content } }) as unknown as SDKAssistantMessage;
const said = (n: number): Entry => ({ kind: "assistant", card: "Plan", text: `line ${n}` });

describe("entriesFrom", () => {
  it("turns text blocks and tool calls into entries for the card, and leaves out the rest", () => {
    const entries = entriesFrom(
      assistant({ type: "thinking", thinking: "hmm" }, { type: "text", text: "Reading the code." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/run.ts" } }),
      "Plan",
    );
    assert.deepEqual(entries, [
      { kind: "assistant", card: "Plan", text: "Reading the code." },
      { kind: "tool", card: "Plan", name: "Read", input: '{"file_path":"src/run.ts"}' },
    ]);
  });

  it("skips a text block that is only whitespace", () => {
    assert.deepEqual(entriesFrom(assistant({ type: "text", text: " \n " }), "Plan"), []);
  });

  it("clips a long tool input at 300 characters", () => {
    const [entry] = entriesFrom(assistant({ type: "tool_use", id: "t1", name: "Write", input: { content: "x".repeat(400) } }), "Implement");
    assert.equal(entry?.kind === "tool" && entry.input.length, 301);
    assert.equal(entry?.kind === "tool" && entry.input.endsWith("…"), true);
  });

  it("shows a tool call without input as an empty input", () => {
    assert.deepEqual(entriesFrom(assistant({ type: "tool_use", id: "t1", name: "Stop", input: undefined }), "Plan"), [{ kind: "tool", card: "Plan", name: "Stop", input: "" }]);
  });

  it("strips an escape sequence from model text and tool names", () => {
    const entries = entriesFrom(assistant({ type: "text", text: "red \u001b[31mtext" }, { type: "tool_use", id: "t1", name: "Ba\u0007sh", input: {} }), "Plan");
    assert.deepEqual(entries, [
      { kind: "assistant", card: "Plan", text: "red [31mtext" },
      { kind: "tool", card: "Plan", name: "Bash", input: "{}" },
    ]);
  });
});

describe("Transcript", () => {
  it("keeps every entry up to the cap, with no marker", () => {
    const transcript = new Transcript();
    transcript.add(Array.from({ length: MAX_ENTRIES }, (_, i) => said(i)));
    const entries = transcript.entries();
    assert.equal(entries.length, MAX_ENTRIES);
    assert.deepEqual(entries[0], said(0));
  });

  it("drops the oldest entries past the cap and puts one marker at the top", () => {
    const transcript = new Transcript();
    transcript.add(Array.from({ length: MAX_ENTRIES }, (_, i) => said(i)));
    transcript.add([said(MAX_ENTRIES)]);
    transcript.add([said(MAX_ENTRIES + 1)]);
    const entries = transcript.entries();
    assert.equal(entries.length, MAX_ENTRIES + 1);
    assert.deepEqual(entries.slice(0, 2), [{ kind: "dropped" }, said(2)]);
    assert.deepEqual(entries.at(-1), said(MAX_ENTRIES + 1));
  });

  it("hands out a copy, so a caller cannot change what it keeps", () => {
    const transcript = new Transcript();
    transcript.add([said(1)]);
    transcript.entries().push(said(2));
    assert.deepEqual(transcript.entries(), [said(1)]);
  });
});
