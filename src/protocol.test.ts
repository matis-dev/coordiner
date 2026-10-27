import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AFTER_NOTE, INTERACTIVE_NOTE, parseStatus, replyOf, tierOf, UNATTENDED_NOTE, withoutStatus } from "./protocol.ts";

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

  it("tells the review, fix and history phases, and any other skill, how to end", () => {
    for (const phase of ["Reviewing:", "Fixing findings:", "Rolling history:", "Any other skill:"]) assert.ok(UNATTENDED_NOTE.includes(phase), phase);
  });

  it("keeps HALT for an action the user takes outside the session, with the steps as fenced commands", () => {
    assert.match(UNATTENDED_NOTE, /HALT <one-line reason>` only when the user must act outside this session/);
    assert.match(UNATTENDED_NOTE, /fenced shell blocks, one command per block, saying which need sudo/);
    assert.match(UNATTENDED_NOTE, /one-way door, is a question \(below\), not a halt/);
  });

  it("asks for command -v before relying on a system tool outside the project's dependencies", () => {
    assert.match(UNATTENDED_NOTE, /check it with `command -v`; if it is missing, choose an approach that works without it, or HALT/);
  });

  it("says a question without a safe Recommended option waits for the user", () => {
    assert.match(UNATTENDED_NOTE, /Leave the label out only when no option is safe without the user: that question waits for the user/);
  });

  it("keeps the status line after a message the user sends while the card works", () => {
    assert.match(UNATTENDED_NOTE, /user may send a message while you work: .*still end your final message with the status line/);
  });
});

describe("INTERACTIVE_NOTE", () => {
  it("names every marker the parser accepts, and the Continue button that moves the chain on", () => {
    for (const marker of ["COORDINER: NEXT", "COORDINER: DONE", "COORDINER: HALT", "AskUserQuestion", "Continue"]) assert.ok(INTERACTIVE_NOTE.includes(marker), marker);
  });

  it("does not claim that nobody is at the keyboard", () => {
    assert.doesNotMatch(INTERACTIVE_NOTE, /Nobody is at the keyboard/);
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

describe("replyOf", () => {
  it("drops a status line, and keeps a reply without one whole", () => {
    assert.equal(replyOf("Profile written.\nCOORDINER: NEXT Standard"), "Profile written.");
    assert.equal(replyOf("Two questions first.\nWhich store?\n"), "Two questions first.\nWhich store?");
  });
});

describe("AFTER_NOTE", () => {
  it("says the chain has ended and no status line is needed", () => {
    assert.match(AFTER_NOTE, /chain has ended/);
    assert.match(AFTER_NOTE, /No COORDINER status line is needed/);
  });
});
