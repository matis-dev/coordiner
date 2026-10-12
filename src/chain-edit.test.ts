import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addCard, addSession, duplicate, moveCard, removeCard, removeSession, rename, setArgs } from "./chain-edit.ts";
import { defaultCard, TEMPLATES, type Chain } from "./chains.ts";

const chain: Chain = { id: "c", name: "C", sessions: [{ cards: [defaultCard("a"), defaultCard("b"), defaultCard("c")] }, { cards: [defaultCard("d")] }] };
const skills = (c: Chain) => c.sessions.map((s) => s.cards.map((x) => x.skill));

describe("moveCard", () => {
  it("swaps a card with its neighbour in either direction", () => {
    assert.deepEqual(skills(moveCard(chain, 0, 0, 1)), [["b", "a", "c"], ["d"]]);
    assert.deepEqual(skills(moveCard(chain, 0, 2, -1)), [["a", "c", "b"], ["d"]]);
  });

  it("leaves the chain as it was at either end or out of range", () => {
    assert.deepEqual(skills(moveCard(chain, 0, 0, -1)), skills(chain));
    assert.deepEqual(skills(moveCard(chain, 0, 2, 1)), skills(chain));
    assert.deepEqual(skills(moveCard(chain, 0, 7, 1)), skills(chain));
    assert.equal(moveCard(chain, 5, 0, 1), chain);
    assert.equal(moveCard(chain, -1, 0, 1), chain);
  });

  it("never changes the chain it was given", () => {
    moveCard(chain, 0, 0, 1);
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
