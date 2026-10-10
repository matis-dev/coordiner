import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, tierOf, UNATTENDED_NOTE, withoutStatus } from "./protocol.ts";

describe("parseStatus", () => {
  it("reads NEXT, DONE and HALT from the last line", () => {
    assert.deepEqual(parseStatus("plan written\nCOORDINER: NEXT Standard"), { kind: "next", tier: "Standard" });
    assert.deepEqual(parseStatus("all steps done.\nCOORDINER: DONE\n\n"), { kind: "done" });
    assert.deepEqual(parseStatus("COORDINER: HALT needs a migration decision"), { kind: "halt", reason: "needs a migration decision" });
  });

  it("ignores a marker that is not the last line", () => {
    assert.deepEqual(parseStatus("COORDINER: DONE\nbut then I kept talking"), { kind: "none" });
  });

  it("ignores lowercase, unknown tiers and extra text", () => {
    assert.deepEqual(parseStatus("COORDINER: NEXT light"), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: NEXT Huge"), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: DONE please"), { kind: "none" });
  });

  it("returns none for empty text and for a HALT without a reason", () => {
    assert.deepEqual(parseStatus(""), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: HALT "), { kind: "none" });
  });
});

describe("tiers", () => {
  it("maps planner tiers to the user's strong, medium and weak tiers", () => {
    assert.equal(tierOf("Heavy"), "strong");
    assert.equal(tierOf("Standard"), "medium");
    assert.equal(tierOf("Light"), "weak");
  });
});

describe("UNATTENDED_NOTE", () => {
  it("names every marker the parser accepts", () => {
    for (const marker of ["COORDINER: NEXT", "COORDINER: DONE", "COORDINER: HALT", "(Recommended)"]) assert.match(UNATTENDED_NOTE, new RegExp(marker.replace(/[()]/g, "\\$&")));
  });

  it("tells the review, fix and history phases how to end", () => {
    for (const phase of ["Reviewing:", "Fixing findings:", "Rolling history:"]) assert.ok(UNATTENDED_NOTE.includes(phase), phase);
  });
});

describe("withoutStatus", () => {
  it("drops the status line and keeps the text above it", () => {
    assert.equal(withoutStatus("feat: add login\n\n- form\nCOORDINER: DONE"), "feat: add login\n\n- form");
  });

  it("ignores trailing blank lines after the status line", () => {
    assert.equal(withoutStatus("brief\nCOORDINER: DONE\n\n"), "brief");
  });

  it("returns empty text when there is only a status line", () => {
    assert.equal(withoutStatus("COORDINER: DONE"), "");
  });
});
