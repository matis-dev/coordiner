import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_ENTRIES } from "./chat-logic.ts";
import { endEntry, entriesFrom, toolInput, Transcript, type Entry } from "./transcript.ts";

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
      { kind: "tool", card: "Plan", name: "Read", input: "src/run.ts" },
    ]);
  });

  it("skips a text block that is only whitespace", () => {
    assert.deepEqual(entriesFrom(assistant({ type: "text", text: " \n " }), "Plan"), []);
  });

  it("clips a long tool input at 2000 characters", () => {
    const [entry] = entriesFrom(assistant({ type: "tool_use", id: "t1", name: "Write", input: { content: "x".repeat(2100) } }), "Implement");
    assert.equal(entry?.kind === "tool" && entry.input.length, 2001);
    assert.equal(entry?.kind === "tool" && entry.input.endsWith("…"), true);
  });

  it("shows a tool call without input as an empty input", () => {
    assert.deepEqual(entriesFrom(assistant({ type: "tool_use", id: "t1", name: "Stop", input: undefined }), "Plan"), [{ kind: "tool", card: "Plan", name: "Stop", input: "" }]);
  });

  it("strips an escape sequence from model text and tool names", () => {
    const entries = entriesFrom(assistant({ type: "text", text: "red \u001b[31mtext" }, { type: "tool_use", id: "t1", name: "Ba\u0007sh", input: {} }), "Plan");
    assert.deepEqual(entries, [
      { kind: "assistant", card: "Plan", text: "red [31mtext" },
      { kind: "tool", card: "Plan", name: "Bash", input: "" },
    ]);
  });
});

describe("toolInput", () => {
  it("shows the field that says what a call does, alone", () => {
    assert.equal(toolInput("Bash", { command: "ls -la", description: "List files" }), "ls -la");
    assert.equal(toolInput("Read", { file_path: "src/run.ts", limit: 20 }), "src/run.ts");
  });

  it("names each field when a tool has several telling ones, or is not known", () => {
    assert.equal(toolInput("Grep", { pattern: "TODO", path: "src", output_mode: "content" }), "pattern: TODO\npath: src");
    assert.equal(toolInput("mcp__x__y", { id: 3, tags: ["a"] }), 'id: 3\ntags: ["a"]');
  });

  it("lists the questions asked and the todos with their state", () => {
    assert.equal(toolInput("AskUserQuestion", { questions: [{ question: "Which store?" }, { question: "Which port?" }] }), "Which store?\nWhich port?");
    assert.equal(
      toolInput("TodoWrite", { todos: [{ content: "plan", status: "completed" }, { content: "build", status: "in_progress" }, { content: "ship", status: "pending" }] }),
      "[x] plan\n[~] build\n[ ] ship",
    );
  });

  // The model writes a tool call's input, and a throw here would fail the turn that shows it.
  it("shows a malformed question or todo as written instead of throwing", () => {
    assert.equal(toolInput("AskUserQuestion", { questions: [null, "Which port?"] }), "null\nWhich port?");
    assert.equal(toolInput("TodoWrite", { todos: [null, "ship", { status: "completed" }] }), '[ ] null\n[ ] ship\n[x] {"status":"completed"}');
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

describe("endEntry", () => {
  it("carries the outcome and its reason, with control characters stripped", () => {
    assert.deepEqual(endEntry({ status: "halted", reason: "needs a\u001b[31m decision" }), { kind: "end", status: "halted", reason: "needs a[31m decision" });
    assert.deepEqual(endEntry({ status: "refused", reason: "no skills" }), { kind: "end", status: "refused", reason: "no skills" });
    assert.deepEqual(endEntry({ status: "failed", error: "the session failed: API Error: 400" }), { kind: "end", status: "failed", reason: "the session failed: API Error: 400" });
  });

  it("has no reason for an outcome without one", () => {
    assert.deepEqual(endEntry({ status: "done", text: "brief" }), { kind: "end", status: "done" });
    assert.deepEqual(endEntry({ status: "stopped" }), { kind: "end", status: "stopped" });
    assert.deepEqual(endEntry({ status: "no-changes" }), { kind: "end", status: "no-changes" });
  });
});
