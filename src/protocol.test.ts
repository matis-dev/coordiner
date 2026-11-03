import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AFTER_NOTE, INTERACTIVE_NOTE, parseStatus, replyOf, suggested, suggestionNote, UNATTENDED_NOTE, withoutStatus } from "./protocol.ts";

describe("parseStatus", () => {
  it("reads NEXT, DONE and HALT from the last line", () => {
    assert.deepEqual(parseStatus("plan written\nCOORDINER: NEXT model=claude-opus-5-5 effort=high"), { kind: "next", suggestion: { model: "claude-opus-5-5", effort: "high" } });
    assert.deepEqual(parseStatus("COORDINER: NEXT"), { kind: "next", suggestion: {} });
    assert.deepEqual(parseStatus("all steps done.\nCOORDINER: DONE\n\n"), { kind: "done" });
    assert.deepEqual(parseStatus("COORDINER: HALT needs a migration decision"), { kind: "halt", reason: "needs a migration decision" });
  });

  it("ignores a marker that is not the last line", () => {
    assert.deepEqual(parseStatus("COORDINER: DONE\nbut then I kept talking"), { kind: "none" });
  });

  it("ignores lowercase, unknown words and extra text", () => {
    assert.deepEqual(parseStatus("COORDINER: NEXT light"), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: NEXT Huge"), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: DONE please"), { kind: "none" });
  });

  it("still takes the tier line skills gave before the suggestion fields, suggesting nothing by it", () => {
    assert.deepEqual(parseStatus("COORDINER: NEXT Light"), { kind: "next", suggestion: {} });
    assert.deepEqual(parseStatus("COORDINER: NEXT Heavy effort=high"), { kind: "next", suggestion: { effort: "high" } });
  });

  it("reads the skill field, and keeps each value as written for turnSettings to check", () => {
    assert.deepEqual(parseStatus("COORDINER: NEXT skill=m-skills:maintenance-architect model=x effort=huge"), {
      kind: "next",
      suggestion: { skill: "m-skills:maintenance-architect", model: "x", effort: "huge" },
    });
  });

  it("is no status line when a field is unknown, repeated, empty or over 100 characters", () => {
    assert.deepEqual(parseStatus("COORDINER: NEXT tier=Heavy"), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: NEXT model=a model=b"), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: NEXT model="), { kind: "none" });
    assert.deepEqual(parseStatus(`COORDINER: NEXT model=${"m".repeat(101)}`), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: NEXT  model=a"), { kind: "none" });
  });

  it("returns none for empty text and for a HALT without a reason", () => {
    assert.deepEqual(parseStatus(""), { kind: "none" });
    assert.deepEqual(parseStatus("COORDINER: HALT "), { kind: "none" });
  });
});

describe("suggested", () => {
  it("lists the fields a NEXT line gave, skill first", () => {
    assert.equal(suggested({ effort: "low", model: "m", skill: "s" }), "skill=s model=m effort=low");
    assert.equal(suggested({}), "");
  });
});

describe("suggestionNote", () => {
  const offered = [
    { id: "m-big", label: "Big", efforts: ["low", "high"] as const },
    { id: "m-old", label: "Old", efforts: [] },
  ].map((m) => ({ ...m, efforts: [...m.efforts] }));

  it("lists each model by id with the efforts it takes, and the fields a NEXT line may carry", () => {
    const note = suggestionNote(offered);
    assert.match(note, /`COORDINER: NEXT model=<id> effort=medium`/);
    assert.match(note, /m-big \(Big; effort low, high\); m-old \(Old; no effort setting\)/);
    assert.match(note, /Heavy/);
  });

  it("asks for the effort only when the models could not be listed", () => {
    assert.match(suggestionNote(undefined), /models could not be listed, so suggest only the effort/);
    assert.match(suggestionNote([]), /suggest only the effort/);
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

  it("says Continue ends the run on the chain's last skill, so the reply does not promise it runs the next one", () => {
    assert.match(INTERACTIVE_NOTE, /Continue runs only the next skill in the chain, and ends the run when there is none/);
    assert.match(INTERACTIVE_NOTE, /do not tell the user that Continue runs a skill you name/);
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
    assert.equal(replyOf("Profile written.\nCOORDINER: NEXT effort=medium"), "Profile written.");
    assert.equal(replyOf("Two questions first.\nWhich store?\n"), "Two questions first.\nWhich store?");
  });
});

describe("AFTER_NOTE", () => {
  it("says the chain has ended and no status line is needed", () => {
    assert.match(AFTER_NOTE, /chain has ended/);
    assert.match(AFTER_NOTE, /No COORDINER status line is needed/);
  });

  it("says there is no Continue button, and names the action that starts the next skill", () => {
    assert.match(AFTER_NOTE, /There is no Continue button in this chat; do not tell the user to press one/);
    assert.match(AFTER_NOTE, /Start the next chain here/);
  });
});
