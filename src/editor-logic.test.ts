import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCard, MAX_CARDS, MAX_SESSIONS, TEMPLATES, type Chain } from "./chains.ts";
import { addCardReason, addKey, addSessionReason, afterMove, afterRemove, argParts, copyName, isMissing, moveDelta, moveKey, newChainId, PLACEHOLDER_NOTE, removeKey, runningCard, runReason, startsFrom } from "./editor-logic.ts";
import { REQUIRED_COMMANDS } from "./session.ts";

const story = TEMPLATES[0]!;
const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("acme:lint")] }] };
const palette = (skills: readonly string[]) => skills.map((skill) => ({ skill }));

describe("runReason", () => {
  it("allows a runnable chain", () => assert.equal(runReason(story, { running: false, mskills: true, palette: palette(REQUIRED_COMMANDS) }), undefined));
  it("allows a chain before discovery has answered", () => assert.equal(runReason(story, { running: false }), undefined));
  it("blocks every chain while a run is in progress", () => assert.equal(runReason(own, { running: true }), "A run is in progress."));
  it("blocks an m-skills chain when m-skills is missing", () => assert.equal(runReason(story, { running: false, mskills: false }), "Needs m-skills, which is not installed."));
  it("lets your own skills run without m-skills", () => assert.equal(runReason(own, { running: false, mskills: false, palette: palette(["acme:lint"]) }), undefined));
  it("passes on the chain's own reason", () => assert.match(runReason(own, { running: false, palette: [] })!, /Missing skills: acme:lint/));
});

describe("runningCard", () => {
  it("finds the running card by its index in the running session of the running chain, else -1", () => {
    assert.equal(runningCard(story, 1, { chainId: "story", session: 1, index: 1 }), 1);
    assert.equal(runningCard(story, 0, { chainId: "story", session: 1, index: 1 }), -1);
    assert.equal(runningCard(story, 1, { chainId: "own", session: 1, index: 1 }), -1);
    assert.equal(runningCard(story, 1, undefined), -1);
  });

  it("tells apart two cards that share a label", () => {
    const twice: Chain = { id: "twice", name: "Twice", sessions: [{ cards: [defaultCard("acme:lint"), defaultCard("acme:lint")] }] };
    assert.equal(runningCard(twice, 0, { chainId: "twice", session: 0, index: 1 }), 1);
  });
});

describe("isMissing", () => {
  const card = defaultCard("acme:lint");
  it("is false until discovery has answered", () => assert.equal(isMissing(card, { running: false }), false));
  it("is false for an offered skill", () => assert.equal(isMissing(card, { running: false, palette: palette(["acme:lint"]) }), false));
  it("is true for a skill the workspace does not offer", () => assert.equal(isMissing(card, { running: false, palette: [] }), true));
});

describe("names and ids", () => {
  it("names a copy and keeps it within the name limit", () => {
    assert.equal(copyName("Story"), "Story copy");
    assert.equal(copyName("x".repeat(100)).length, 100);
  });

  it("makes ids a stored chain accepts", () => assert.match(newChainId(1_760_000_000_000), /^chain-[a-z0-9]+$/));
});

describe("limits in the editor", () => {
  const sessions = (count: number, cards: number): Chain => ({ id: "own", name: "Own", sessions: Array.from({ length: count }, () => ({ cards: Array.from({ length: cards }, () => defaultCard("acme:lint")) })) });

  it("lets a session take skills up to the stored limit, then says why Add is off", () => {
    assert.equal(addCardReason(sessions(1, MAX_CARDS - 1), 0), undefined);
    assert.equal(addCardReason(sessions(1, MAX_CARDS), 0), `A session holds at most ${MAX_CARDS} skills.`);
  });

  it("lets a chain take sessions up to the stored limit, then says why Add a session is off", () => {
    assert.equal(addSessionReason(sessions(MAX_SESSIONS - 1, 0)), undefined);
    assert.equal(addSessionReason(sessions(MAX_SESSIONS, 0)), `A chain holds at most ${MAX_SESSIONS} sessions.`);
  });

  it("has nothing to say about a session that does not exist", () => assert.equal(addCardReason(sessions(1, 0), 5), undefined));
});

describe("moveDelta", () => {
  it("maps Alt+Left and Alt+Right", () => {
    assert.equal(moveDelta({ altKey: true, key: "ArrowLeft" }), -1);
    assert.equal(moveDelta({ altKey: true, key: "ArrowRight" }), 1);
  });

  it("ignores arrows without Alt and other keys with Alt", () => {
    assert.equal(moveDelta({ altKey: false, key: "ArrowLeft" }), undefined);
    assert.equal(moveDelta({ altKey: true, key: "ArrowUp" }), undefined);
  });
});

describe("focus after an edit", () => {
  it("keeps focus on the moved card's button at its new place", () => {
    assert.equal(afterMove(0, 1, 1, 3), moveKey(0, 2, 1));
    assert.equal(afterMove(1, 1, -1, 3), moveKey(1, 0, -1));
  });

  it("reports no move at either end", () => {
    assert.equal(afterMove(0, 0, -1, 3), undefined);
    assert.equal(afterMove(0, 2, 1, 3), undefined);
  });

  it("moves focus to the card that took the removed one's place, else the one before, else Add", () => {
    assert.equal(afterRemove(0, 0, 3), removeKey(0, 0));
    assert.equal(afterRemove(0, 2, 3), removeKey(0, 1));
    assert.equal(afterRemove(1, 0, 1), addKey(1));
  });
});

describe("startsFrom", () => {
  it("says what each template asks for at Run", () => {
    assert.match(startsFrom(story), /^Starts from a written story\. Run lets you pick one from a Markdown backlog file/);
    assert.match(startsFrom(TEMPLATES[1]!), /^Starts from a rough idea/);
    assert.match(startsFrom(TEMPLATES[2]!), /^Starts from a bug/);
  });
  it("says a chain without a placeholder needs only a name", () => assert.equal(startsFrom(own), "Starts from a name only. Run asks for one; it names the worktree and the branch."));
});

describe("argParts", () => {
  it("shows each placeholder as what Run will put there, keeping the text around it", () => {
    assert.deepEqual(argParts("fix {{bug}} now"), [{ text: "fix " }, { chip: "the bug you describe at Run" }, { text: " now" }]);
    assert.deepEqual(argParts("{{story}}"), [{ chip: "the story you choose at Run" }]);
  });
  it("leaves text without a placeholder, and unknown braces, as text", () => assert.deepEqual(argParts("use {{other}}"), [{ text: "use {{other}}" }]));
});

describe("PLACEHOLDER_NOTE", () => {
  it("lists every placeholder Run knows", () =>
    assert.equal(PLACEHOLDER_NOTE, "Put {{story}}, {{idea}} or {{bug}} in a card's arguments, and Run asks for that input and puts it there."));
});
