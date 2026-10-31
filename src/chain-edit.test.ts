import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addCard, addSession, duplicate, moveTo, removeCard, removeSession, rename, setArgs, setEffort, setModel, setPause } from "./chain-edit.ts";
import { defaultCard, TEMPLATES, type Chain } from "./chains.ts";

const chain: Chain = { id: "c", name: "C", sessions: [{ cards: [defaultCard("a"), defaultCard("b"), defaultCard("c")] }, { cards: [defaultCard("d")] }] };
const skills = (c: Chain) => c.sessions.map((s) => s.cards.map((x) => x.skill));

describe("moveTo", () => {
  it("moves a card within its session, either way", () => {
    assert.deepEqual(skills(moveTo(chain, { s: 0, i: 0 }, { s: 0, i: 1 })), [["b", "a", "c"], ["d"]]);
    assert.deepEqual(skills(moveTo(chain, { s: 0, i: 2 }, { s: 0, i: 0 })), [["c", "a", "b"], ["d"]]);
  });

  it("moves a card into another session, at its start, middle or end", () => {
    assert.deepEqual(skills(moveTo(chain, { s: 0, i: 1 }, { s: 1, i: 0 })), [["a", "c"], ["b", "d"]]);
    assert.deepEqual(skills(moveTo(chain, { s: 0, i: 1 }, { s: 1, i: 1 })), [["a", "c"], ["d", "b"]]);
    assert.deepEqual(skills(moveTo(chain, { s: 1, i: 0 }, { s: 0, i: 3 })), [["a", "b", "c", "d"], []]);
  });

  it("moves a card into an empty session, and leaves the session it emptied", () => {
    const withEmpty: Chain = { ...chain, sessions: [...chain.sessions, { cards: [] }] };
    assert.deepEqual(skills(moveTo(withEmpty, { s: 1, i: 0 }, { s: 2, i: 0 })), [["a", "b", "c"], [], ["d"]]);
  });

  it("leaves the chain as it was for a card or a place that is not there", () => {
    assert.equal(moveTo(chain, { s: 0, i: 7 }, { s: 1, i: 0 }), chain);
    assert.equal(moveTo(chain, { s: 5, i: 0 }, { s: 0, i: 0 }), chain);
    assert.equal(moveTo(chain, { s: 0, i: 0 }, { s: 5, i: 0 }), chain);
    assert.equal(moveTo(chain, { s: 0, i: 0 }, { s: 1, i: 2 }), chain);
    assert.equal(moveTo(chain, { s: 0, i: 0 }, { s: 0, i: 3 }), chain, "the session has two other cards, so 3 is past its end");
    assert.equal(moveTo(chain, { s: 0, i: 0 }, { s: 0, i: -1 }), chain);
  });

  it("never changes the chain it was given", () => {
    moveTo(chain, { s: 0, i: 0 }, { s: 1, i: 0 });
    assert.deepEqual(skills(chain), [["a", "b", "c"], ["d"]]);
  });
});

describe("cards", () => {
  it("adds a card with the skill's defaults at the end of the session", () => {
    const added = addCard(chain, 1, "m-skills:rolling-history");
    assert.deepEqual(added.sessions[1]!.cards.at(-1), defaultCard("m-skills:rolling-history"));
  });

  it("removes a card, and leaves an empty session when it was the last", () => {
    assert.deepEqual(skills(removeCard(chain, 0, 1)), [["a", "c"], ["d"]]);
    assert.deepEqual(skills(removeCard(chain, 1, 0)), [["a", "b", "c"], []]);
  });

  it("sets a card's args", () => {
    assert.equal(setArgs(chain, 0, 2, "--fast").sessions[0]!.cards[2]!.args, "--fast");
  });
});

describe("model and effort", () => {
  const pinned = setModel(chain, 0, 1, "claude-haiku-5-5", "low");

  it("pins a card's model and effort, leaving the other cards alone", () => {
    assert.deepEqual(pinned.sessions[0]!.cards[1], { ...defaultCard("b"), model: "claude-haiku-5-5", effort: "low" });
    assert.deepEqual(pinned.sessions[0]!.cards[0], defaultCard("a"));
  });

  it("removes both fields when the card goes back to its tier and the default effort", () => {
    assert.deepEqual(setModel(pinned, 0, 1).sessions[0]!.cards[1], defaultCard("b"));
    assert.equal(Object.hasOwn(setModel(pinned, 0, 1).sessions[0]!.cards[1]!, "model"), false);
  });

  it("drops the effort when a new model comes without one", () => {
    assert.deepEqual(setModel(pinned, 0, 1, "claude-opus-5-5").sessions[0]!.cards[1], { ...defaultCard("b"), model: "claude-opus-5-5" });
  });

  it("sets and clears the effort without touching the model", () => {
    assert.deepEqual(setEffort(pinned, 0, 1, "max").sessions[0]!.cards[1], { ...defaultCard("b"), model: "claude-haiku-5-5", effort: "max" });
    assert.deepEqual(setEffort(pinned, 0, 1).sessions[0]!.cards[1], { ...defaultCard("b"), model: "claude-haiku-5-5" });
  });

  it("sets and clears the pause without touching the other fields", () => {
    const paused = setPause(pinned, 0, 1, true);
    assert.deepEqual(paused.sessions[0]!.cards[1], { ...pinned.sessions[0]!.cards[1]!, pause: true });
    assert.deepEqual(setPause(paused, 0, 1, false).sessions[0]!.cards[1], pinned.sessions[0]!.cards[1]);
  });

  it("leaves the chain as it was out of range", () => {
    assert.equal(setModel(chain, 4, 0, "x"), chain);
    assert.deepEqual(setEffort(chain, 0, 9, "low"), chain);
  });

  it("copies both fields into a duplicate", () => {
    assert.deepEqual(duplicate(pinned, "d", "D").sessions[0]!.cards[1], pinned.sessions[0]!.cards[1]);
  });
});

describe("sessions and names", () => {
  it("adds an empty session at the end", () => assert.deepEqual(skills(addSession(chain)), [["a", "b", "c"], ["d"], []]));
  it("removes a session with its cards", () => assert.deepEqual(skills(removeSession(chain, 0)), [["d"]]));
  it("renames", () => assert.equal(rename(chain, "New").name, "New"));
});

describe("duplicate", () => {
  it("makes a user chain from a template, with a new id and name", () => {
    const copy = duplicate(TEMPLATES[0]!, "story-copy", "Story copy");
    assert.equal(copy.builtIn, undefined);
    assert.deepEqual([copy.id, copy.name], ["story-copy", "Story copy"]);
    assert.deepEqual(copy.sessions, TEMPLATES[0]!.sessions);
  });

  it("copies deeply enough that editing the copy cannot touch the template", () => {
    const copy = duplicate(TEMPLATES[0]!, "x", "X");
    copy.sessions[0]!.cards[0]!.args = "changed";
    assert.equal(TEMPLATES[0]!.sessions[0]!.cards[0]!.args, "{{story}}");
  });
});
