import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCard } from "./chains.ts";
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

  it("drops a save whose chain fails validation, including one claiming a template id", () => {
    assert.equal(parseEditorMessage({ type: "save", chain: { ...chain, id: "story" } }), undefined);
    assert.equal(parseEditorMessage({ type: "save", chain: { ...chain, sessions: [{ cards: [{ ...defaultCard("x"), skill: "x\ny" }] }] } }), undefined);
  });
});
