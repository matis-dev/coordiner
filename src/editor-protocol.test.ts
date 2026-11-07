import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCard, MAX_INPUT_CHARS } from "./chains.ts";
import { parseEditorMessage } from "./editor-protocol.ts";
import { MAX_IMAGE_CHARS, MAX_IMAGES } from "./images.ts";

const chain = { id: "mine", name: "Mine", sessions: [{ cards: [defaultCard("acme:lint")] }] };

describe("parseEditorMessage", () => {
  it("accepts each message type with exactly its fields", () => {
    for (const type of ["ready", "refreshPalette", "openMskills", "checkEnvironment", "restoreTemplates"]) assert.deepEqual(parseEditorMessage({ type }), { type });
    assert.deepEqual(parseEditorMessage({ type: "removeTemplate", id: "bug" }), { type: "removeTemplate", id: "bug" });
    assert.deepEqual(parseEditorMessage({ type: "restoreTemplate", id: "kickoff" }), { type: "restoreTemplate", id: "kickoff" });
    assert.deepEqual(parseEditorMessage({ type: "delete", id: "mine" }), { type: "delete", id: "mine" });
    assert.deepEqual(parseEditorMessage({ type: "run", id: "story" }), { type: "run", id: "story" });
    assert.deepEqual(parseEditorMessage({ type: "save", chain }), { type: "save", chain });
  });

  it("takes only a template's id to remove or restore, and no extra field", () => {
    for (const type of ["removeTemplate", "restoreTemplate"]) {
      assert.equal(parseEditorMessage({ type, id: "mine" }), undefined);
      assert.equal(parseEditorMessage({ type, id: "__proto__" }), undefined);
      assert.equal(parseEditorMessage({ type, id: 1 }), undefined);
      assert.equal(parseEditorMessage({ type, id: "bug", also: "story" }), undefined);
    }
    assert.equal(parseEditorMessage({ type: "restoreTemplates", ids: ["bug"] }), undefined);
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
    for (const type of ["chatPause", "chatContinue", "chatStop", "chatCopyResume", "chatNextChain", "chatMergeSteps"]) assert.deepEqual(parseEditorMessage({ type }), { type });
    assert.deepEqual(parseEditorMessage({ type: "chatSend", text: "keep it small", images: [] }), { type: "chatSend", text: "keep it small", images: [] });
    assert.deepEqual(parseEditorMessage({ type: "chatWithdraw", id: "m3" }), { type: "chatWithdraw", id: "m3" });
    const picks = [{ picked: ["SQLite"] }, { picked: [], other: "Postgres" }];
    assert.deepEqual(parseEditorMessage({ type: "chatAnswer", id: "q1", picks }), { type: "chatAnswer", id: "q1", picks });
  });

  it("drops a chat message that is empty, over the length limit, or carries extra fields", () => {
    assert.equal(parseEditorMessage({ type: "chatSend", text: "  ", images: [] }), undefined);
    assert.equal(parseEditorMessage({ type: "chatSend", text: 7, images: [] }), undefined);
    assert.equal(parseEditorMessage({ type: "chatSend", text: "keep it small" }), undefined, "images is required, even empty");
    assert.equal(parseEditorMessage({ type: "chatSend", text: "x".repeat(MAX_INPUT_CHARS + 1), images: [] }), undefined);
    assert.deepEqual(parseEditorMessage({ type: "chatSend", text: "x".repeat(MAX_INPUT_CHARS), images: [] }), { type: "chatSend", text: "x".repeat(MAX_INPUT_CHARS), images: [] });
    assert.equal(parseEditorMessage({ type: "chatPause", card: "Implement" }), undefined);
    assert.equal(parseEditorMessage({ type: "chatCopyResume", command: "rm -rf ~" }), undefined);
    assert.equal(parseEditorMessage({ type: "chatNextChain", worktree: "/tmp" }), undefined);
    assert.equal(parseEditorMessage({ type: "chatMergeSteps", target: "main" }), undefined);
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

describe("parseEditorMessage: images and Run's input", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);

  it("takes a message of images alone, or text with up to the most images a message holds, by distinct id", () => {
    for (const type of ["chatSend", "composeDone"] as const) {
      assert.deepEqual(parseEditorMessage({ type, text: "", images: ["i1"] }), { type, text: "", images: ["i1"] });
      assert.deepEqual(parseEditorMessage({ type, text: "see", images: ids(MAX_IMAGES) }), { type, text: "see", images: ids(MAX_IMAGES) });
      assert.equal(parseEditorMessage({ type, text: "see", images: ids(MAX_IMAGES + 1) }), undefined);
      assert.equal(parseEditorMessage({ type, text: " ", images: [] }), undefined, "neither text nor images");
      assert.equal(parseEditorMessage({ type, text: "see", images: ["i1", "i1"] }), undefined);
      assert.equal(parseEditorMessage({ type, text: "see", images: ["../x"] }), undefined);
      assert.equal(parseEditorMessage({ type, text: "see", images: "i1" }), undefined);
      assert.equal(parseEditorMessage({ type, text: "see", images: [], card: "Plan" }), undefined);
    }
  });

  it("bounds an attached image's data and name before anything decodes it, and takes no other field", () => {
    assert.deepEqual(parseEditorMessage({ type: "attachImage", name: "shot.png", data: "iVBORw0KGgo=" }), { type: "attachImage", name: "shot.png", data: "iVBORw0KGgo=" });
    assert.equal(parseEditorMessage({ type: "attachImage", name: "shot.png", data: "A".repeat(MAX_IMAGE_CHARS + 1) }), undefined);
    assert.equal(parseEditorMessage({ type: "attachImage", name: "x".repeat(256), data: "AAAA" }), undefined);
    assert.equal(parseEditorMessage({ type: "attachImage", name: "shot.png", data: "AAAA", mediaType: "image/png" }), undefined, "the page's claimed type is not taken");
    assert.equal(parseEditorMessage({ type: "attachImage", name: "shot.png", data: new Uint8Array(4) }), undefined);
  });

  it("takes an image id to let go of or open, and the picker and cancel with no field", () => {
    for (const type of ["detachImage", "openImage"] as const) {
      assert.deepEqual(parseEditorMessage({ type, id: "4f1c-a2" }), { type, id: "4f1c-a2" });
      assert.equal(parseEditorMessage({ type, id: "/etc/passwd" }), undefined);
    }
    for (const type of ["pickImages", "composeCancel"]) {
      assert.deepEqual(parseEditorMessage({ type }), { type });
      assert.equal(parseEditorMessage({ type, path: "/tmp/x.png" }), undefined);
    }
  });
});

describe("parseEditorMessage: images on cards", () => {
  const hash = "a".repeat(64);

  it("takes an image for a card named by chain id, session and index, bounded before anything decodes it", () => {
    assert.deepEqual(parseEditorMessage({ type: "cardAttachImage", target: "own:0:1", name: "t.png", data: "AAAA" }), { type: "cardAttachImage", target: "own:0:1", name: "t.png", data: "AAAA" });
    assert.deepEqual(parseEditorMessage({ type: "cardPickImages", target: "own:2:10" }), { type: "cardPickImages", target: "own:2:10" });
    for (const target of ["own", "own:0", "../x:0:0", "own:0:100", "own:-1:0"]) assert.equal(parseEditorMessage({ type: "cardPickImages", target }), undefined, target);
    assert.equal(parseEditorMessage({ type: "cardAttachImage", target: "own:0:1", name: "t.png", data: "A".repeat(MAX_IMAGE_CHARS + 1) }), undefined);
  });

  it("opens a card image only by its hash", () => {
    assert.deepEqual(parseEditorMessage({ type: "cardOpenImage", id: hash }), { type: "cardOpenImage", id: hash });
    assert.equal(parseEditorMessage({ type: "cardOpenImage", id: "/etc/hostname" }), undefined);
    assert.equal(parseEditorMessage({ type: "cardOpenImage", id: hash, path: "/tmp/x" }), undefined);
  });
});
