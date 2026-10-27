import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCard, MAX_INPUT_CHARS } from "./chains.ts";
import { parseEditorMessage } from "./editor-protocol.ts";

const chain = { id: "mine", name: "Mine", sessions: [{ cards: [defaultCard("acme:lint")] }] };

describe("parseEditorMessage", () => {
  it("accepts each message type with exactly its fields", () => {
    for (const type of ["ready", "refreshPalette", "openMskills", "checkEnvironment"]) assert.deepEqual(parseEditorMessage({ type }), { type });
    assert.deepEqual(parseEditorMessage({ type: "delete", id: "mine" }), { type: "delete", id: "mine" });
    assert.deepEqual(parseEditorMessage({ type: "run", id: "story" }), { type: "run", id: "story" });
    assert.deepEqual(parseEditorMessage({ type: "save", chain }), { type: "save", chain });
  });

  it("drops an openMskills message that carries its own URL", () => {
    assert.equal(parseEditorMessage({ type: "openMskills", url: "https://evil.example" }), undefined);
  });

  it("drops unknown types and inherited names", () => {
    assert.equal(parseEditorMessage({ type: "exec" }), undefined);
    assert.equal(parseEditorMessage({ type: "toString" }), undefined);
    assert.equal(parseEditorMessage({ type: 3 }), undefined);
  });

  it("drops non-objects", () => {
    for (const v of [null, "ready", 1, ["ready"]]) assert.equal(parseEditorMessage(v), undefined);
  });

  it("drops missing, extra or ill-typed fields", () => {
    assert.equal(parseEditorMessage({ type: "run" }), undefined);
    assert.equal(parseEditorMessage({ type: "run", id: "Bad Id" }), undefined);
    assert.equal(parseEditorMessage({ type: "delete", id: 4 }), undefined);
    assert.equal(parseEditorMessage({ type: "delete", id: "x", force: true }), undefined);
  });

  it("accepts the chat's messages with exactly their fields", () => {
    for (const type of ["chatPause", "chatContinue", "chatStop", "chatCopyResume", "chatNextChain"]) assert.deepEqual(parseEditorMessage({ type }), { type });
    assert.deepEqual(parseEditorMessage({ type: "chatSend", text: "keep it small" }), { type: "chatSend", text: "keep it small" });
    assert.deepEqual(parseEditorMessage({ type: "chatWithdraw", id: "m3" }), { type: "chatWithdraw", id: "m3" });
    const picks = [{ picked: ["SQLite"] }, { picked: [], other: "Postgres" }];
    assert.deepEqual(parseEditorMessage({ type: "chatAnswer", id: "q1", picks }), { type: "chatAnswer", id: "q1", picks });
  });

  it("drops a chat message that is empty, over the length limit, or carries extra fields", () => {
    assert.equal(parseEditorMessage({ type: "chatSend", text: "  " }), undefined);
    assert.equal(parseEditorMessage({ type: "chatSend", text: 7 }), undefined);
    assert.equal(parseEditorMessage({ type: "chatSend", text: "x".repeat(MAX_INPUT_CHARS + 1) }), undefined);
    assert.deepEqual(parseEditorMessage({ type: "chatSend", text: "x".repeat(MAX_INPUT_CHARS) }), { type: "chatSend", text: "x".repeat(MAX_INPUT_CHARS) });
    assert.equal(parseEditorMessage({ type: "chatPause", card: "Implement" }), undefined);
    assert.equal(parseEditorMessage({ type: "chatCopyResume", command: "rm -rf ~" }), undefined);
    assert.equal(parseEditorMessage({ type: "chatNextChain", worktree: "/tmp" }), undefined);
    assert.equal(parseEditorMessage({ type: "chatWithdraw", id: "M 3" }), undefined);
  });

  it("drops answers that are not a list of one to four picks of labels and Other text", () => {
    const answer = (picks: unknown, id: unknown = "q1") => parseEditorMessage({ type: "chatAnswer", id, picks });
    for (const picks of [
      [],
      "SQLite",
      Array.from({ length: 5 }, () => ({ picked: ["a"] })),
      [null],
      [["SQLite"]],
      [{ picked: "SQLite" }],
      [{ picked: [3] }],
      [{ picked: ["x".repeat(1001)] }],
      [{ picked: [], other: 3 }],
      [{ picked: [], other: "x".repeat(MAX_INPUT_CHARS + 1) }],
      [{ picked: ["a"], extra: true }],
    ]) {
      assert.equal(answer(picks), undefined, JSON.stringify(picks).slice(0, 80));
    }
    assert.equal(answer([{ picked: ["a"] }], "Q 1"), undefined);
    assert.equal(answer([{ picked: ["a"] }], 1), undefined);
  });

  it("drops a save whose chain fails validation, including one claiming a template id", () => {
    assert.equal(parseEditorMessage({ type: "save", chain: { ...chain, id: "story" } }), undefined);
    assert.equal(parseEditorMessage({ type: "save", chain: { ...chain, sessions: [{ cards: [{ ...defaultCard("x"), skill: "x\ny" }] }] } }), undefined);
  });
});

describe("parseEditorMessage: copying a command", () => {
  it("accepts text to copy", () => {
    assert.deepEqual(parseEditorMessage({ type: "chatCopyText", text: "sudo usermod -aG docker $USER" }), { type: "chatCopyText", text: "sudo usermod -aG docker $USER" });
  });

  it("refuses text over the cap, empty text, a non-string, and extra keys", () => {
    assert.equal(parseEditorMessage({ type: "chatCopyText", text: "x".repeat(MAX_INPUT_CHARS) })?.type, "chatCopyText");
    for (const bad of [
      { type: "chatCopyText", text: "x".repeat(MAX_INPUT_CHARS + 1) },
      { type: "chatCopyText", text: "  " },
      { type: "chatCopyText", text: ["rm -rf /"] },
      { type: "chatCopyText", text: "ls", run: true },
      { type: "chatCopyText" },
    ]) assert.equal(parseEditorMessage(bad), undefined, JSON.stringify(bad).slice(0, 60));
  });
});
