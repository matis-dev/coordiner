import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCard, MAX_CARDS, MAX_SESSIONS, TEMPLATES, type Card, type Chain, type Effort } from "./chains.ts";
import {
  addCardReason,
  addKey,
  addSessionReason,
  afterRemove,
  argParts,
  copyName,
  copyThenEdit,
  dropTarget,
  effortAfterModel,
  effortChoices,
  effortKey,
  effortReason,
  isMissing,
  lockReason,
  modelKey,
  modelOffered,
  moveDelta,
  movedNote,
  moveKey,
  moveReason,
  moveTarget,
  newChainId,
  pauseKey,
  filterPalette,
  followAvailable,
  matchCount,
  PLACEHOLDER_NOTE,
  removeKey,
  runningCard,
  runReason,
  strayNote,
  startsFrom,
} from "./editor-logic.ts";
import { REQUIRED_COMMANDS } from "./session.ts";

const story = TEMPLATES[0]!;
const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("acme:lint")] }] };
const palette = (skills: readonly string[]) => skills.map((skill) => ({ skill }));

describe("runReason", () => {
  it("allows a runnable chain", () => assert.equal(runReason(story, { running: false, mskills: true, palette: palette(REQUIRED_COMMANDS) }), undefined));
  it("allows a chain before discovery has answered", () => assert.equal(runReason(story, { running: false }), undefined));
  it("blocks every chain while a run is in progress, and says how to stop it", () =>
    assert.equal(runReason(own, { running: true }), "A run is in progress. Stop it in the chat below or with Coordiner: Stop Run to start another."));
  it("blocks an m-skills chain when m-skills is missing", () => assert.equal(runReason(story, { running: false, mskills: false }), "Needs m-skills, which is not installed."));
  it("lets your own skills run without m-skills", () => assert.equal(runReason(own, { running: false, mskills: false, palette: palette(["acme:lint"]) }), undefined));
  it("passes on the chain's own reason", () => assert.match(runReason(own, { running: false, palette: [] })!, /Missing skills: acme:lint/));
});

describe("model and effort", () => {
  const lint = defaultCard("acme:lint");
  const view = {
    running: false,
    models: [
      { id: "m-opus", label: "Opus", efforts: ["low", "high"] as Effort[] },
      { id: "m-haiku", label: "Haiku", efforts: [] as Effort[] },
      { id: "m-default", label: "Default", efforts: ["low"] as Effort[] },
    ],
    defaultModel: "m-default",
  };
  const chainOf = (card: Card): Chain => ({ id: "own", name: "Own", sessions: [{ cards: [card] }] });

  it("offers the card's model's efforts, the default model's on Default, and nothing before the models are listed", () => {
    assert.deepEqual(effortChoices({ ...lint, model: "m-opus" }, view), ["low", "high"]);
    assert.deepEqual(effortChoices(lint, view), ["low"]);
    assert.deepEqual(effortChoices(lint, { running: false, models: view.models }), []);
    assert.deepEqual(effortChoices({ ...lint, model: "m-gone" }, view), []);
    assert.deepEqual(effortChoices(lint, { running: false }), []);
  });

  it("keeps the effort across a model change only when the new model takes it", () => {
    assert.equal(effortAfterModel({ ...lint, effort: "low" }, "m-opus", view), "low");
    assert.equal(effortAfterModel({ ...lint, effort: "high" }, undefined, view), undefined);
    assert.equal(effortAfterModel(lint, "m-opus", view), undefined);
  });

  it("knows a model is offered when it is listed, unset, or the list is not known yet", () => {
    assert.equal(modelOffered({ ...lint, model: "m-opus" }, view), true);
    assert.equal(modelOffered(lint, view), true);
    assert.equal(modelOffered({ ...lint, model: "m-gone" }, { running: false }), true);
    assert.equal(modelOffered({ ...lint, model: "m-gone" }, view), false);
  });

  it("says why Effort holds only the default", () => {
    assert.equal(effortReason(lint, view), undefined);
    assert.equal(effortReason(lint, { running: false }), "Effort can be set once the session's models are listed.");
    assert.equal(effortReason({ ...lint, model: "m-haiku" }, view), "This model has no effort setting.");
    assert.equal(effortReason(lint, { ...view, defaultModel: "m-haiku" }), "The default model has no effort setting.");
    assert.equal(effortReason(lint, { running: false, models: view.models }), "The session names no default model; pick a model to set an effort.");
  });

  it("offers following the step before only after an m-skills card in the same session, while m-skills is installed", () => {
    const plan = defaultCard("m-skills:planning-architect");
    const chain: Chain = { id: "own", name: "Own", sessions: [{ cards: [plan, lint, lint] }, { cards: [lint] }] };
    const on = { running: false, mskills: true };
    assert.equal(followAvailable(chain, 0, 1, on), true);
    assert.equal(followAvailable(chain, 0, 0, on), false);
    assert.equal(followAvailable(chain, 0, 2, on), false);
    assert.equal(followAvailable(chain, 1, 0, on), false);
    assert.equal(followAvailable(chain, 0, 1, { running: false, mskills: false }), false);
    assert.equal(followAvailable(chain, 0, 1, { running: false }), false);
    assert.equal(followAvailable(chain, 5, 1, on), false);
  });

  it("refuses to run a card on a model the session does not offer, or an effort its model does not take", () => {
    const palette = [{ skill: "acme:lint" }];
    assert.equal(runReason(chainOf({ ...lint, model: "m-gone" }), { ...view, palette }), "lint: model m-gone is not offered by this session.");
    assert.equal(runReason(chainOf({ ...lint, model: "m-haiku", effort: "low" }), { ...view, palette }), "lint: effort low is not available for m-haiku.");
    assert.equal(runReason(chainOf({ ...lint, effort: "high" }), { ...view, palette }), "lint: effort high is not available for the default model.");
    assert.equal(runReason(chainOf({ ...lint, model: "m-opus", effort: "high" }), { ...view, palette }), undefined);
  });

  it("refuses nothing about models before they are listed; the session's own check still guards the turn", () => {
    assert.equal(runReason(chainOf({ ...lint, model: "m-gone", effort: "max" }), { running: false }), undefined);
  });

  it("names the selects' focus keys by session and card", () => {
    assert.equal(modelKey(1, 2), "model-1-2");
    assert.equal(effortKey(1, 2), "effort-1-2");
    assert.equal(pauseKey(1, 2), "pause-1-2");
  });
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

  it("edits a copy of a template, and the chain itself when it is the user's own", () => {
    const template = TEMPLATES.find((t) => t.id === "kickoff")!;
    const own: Chain = { id: "own", name: "Own", sessions: [] };
    const copy = (from: Chain): Chain => ({ id: "c", name: copyName(from.name), sessions: from.sessions });
    const renamed = (chain: Chain): Chain => ({ ...chain, name: `${chain.name}!` });
    assert.deepEqual(copyThenEdit(template, renamed, copy), { id: "c", name: "Kickoff copy!", sessions: template.sessions });
    assert.deepEqual(copyThenEdit(own, renamed, copy), { ...own, name: "Own!" });
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

describe("moving cards", () => {
  const cards = (n: number) => Array.from({ length: n }, (_, i) => defaultCard(`acme:${i}`));
  const three: Chain = { id: "own", name: "Own", sessions: [{ cards: cards(2) }, { cards: [] }, { cards: cards(3) }] };
  const view = (through?: number, chainId = "own") => ({ running: through !== undefined, ...(through !== undefined ? { locked: { chainId, through } } : {}) });

  it("moves an arrow's card to its neighbour's place inside its session", () => {
    assert.deepEqual(moveTarget(three, 0, 0, 1), { s: 0, i: 1 });
    assert.deepEqual(moveTarget(three, 2, 2, -1), { s: 2, i: 1 });
  });

  it("wraps an arrow past a session's end to the near end of the session that way, an empty one included", () => {
    assert.deepEqual(moveTarget(three, 0, 1, 1), { s: 1, i: 0 });
    assert.deepEqual(moveTarget(three, 2, 0, -1), { s: 1, i: 0 });
    const two: Chain = { ...three, sessions: [three.sessions[0]!, three.sessions[2]!] };
    assert.deepEqual(moveTarget(two, 1, 0, -1), { s: 0, i: 2 }, "after the previous session's last card");
    assert.deepEqual(moveTarget(two, 0, 1, 1), { s: 1, i: 0 }, "before the next session's first card");
  });

  it("moves nothing past either end of the chain", () => {
    assert.equal(moveTarget(three, 0, 0, -1), undefined);
    assert.equal(moveTarget(three, 2, 2, 1), undefined);
  });

  it("puts a dropped card before the card it was dropped on, counting without the card itself", () => {
    assert.deepEqual(dropTarget(three, { s: 0, i: 0 }, 2, 1), { s: 2, i: 1 });
    assert.deepEqual(dropTarget(three, { s: 2, i: 0 }, 2, 2), { s: 2, i: 1 }, "later in its own session: one place less");
    assert.deepEqual(dropTarget(three, { s: 2, i: 2 }, 2, 0), { s: 2, i: 0 });
  });

  it("puts a card dropped on the session itself at its end", () => {
    assert.deepEqual(dropTarget(three, { s: 0, i: 0 }, 1), { s: 1, i: 0 });
    assert.deepEqual(dropTarget(three, { s: 0, i: 0 }, 2), { s: 2, i: 3 });
    assert.deepEqual(dropTarget(three, { s: 2, i: 0 }, 2), { s: 2, i: 2 }, "its own session: the last place");
  });

  it("locks the sessions the run on this chain has started, and no others", () => {
    assert.equal(lockReason(three, 0, view(0)), "Session 1 has started: its cards keep their order until the run ends.");
    assert.equal(lockReason(three, 1, view(1)), "Session 2 has started: its cards keep their order until the run ends.");
    assert.equal(lockReason(three, 1, view(0)), undefined);
    assert.equal(lockReason(three, 0, view(2, "other")), undefined, "another chain's run");
    assert.equal(lockReason(three, 0, view()), undefined);
  });

  it("refuses a move out of or into a started session, or into a full one", () => {
    assert.match(moveReason(three, { s: 0, i: 1 }, { s: 1, i: 0 }, view(0))!, /^Session 1 has started/);
    assert.match(moveReason(three, { s: 2, i: 0 }, { s: 1, i: 0 }, view(1))!, /^Session 2 has started/);
    assert.equal(moveReason(three, { s: 2, i: 0 }, { s: 1, i: 0 }, view(0)), undefined);
    const full: Chain = { ...three, sessions: [{ cards: cards(MAX_CARDS) }, { cards: cards(1) }] };
    assert.equal(moveReason(full, { s: 1, i: 0 }, { s: 0, i: 0 }, view()), `A session holds at most ${MAX_CARDS} skills.`);
    assert.equal(moveReason(full, { s: 0, i: 0 }, { s: 0, i: 5 }, view()), undefined, "inside a full session is fine");
    const room: Chain = { ...three, sessions: [{ cards: cards(MAX_CARDS - 1) }, { cards: cards(1) }] };
    assert.equal(moveReason(room, { s: 1, i: 0 }, { s: 0, i: 0 }, view()), undefined);
  });

  it("says where a moved card went, naming the session only when it changed", () => {
    assert.equal(movedNote("Plan", { s: 0, i: 0 }, { s: 0, i: 1 }), "Moved Plan to position 2");
    assert.equal(movedNote("Plan", { s: 0, i: 1 }, { s: 2, i: 0 }), "Moved Plan to session 3, position 1");
  });
});

describe("focus after an edit", () => {
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
    assert.match(startsFrom(TEMPLATES.find((t) => t.id === "kickoff")!), /^Starts from a name only/);
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
    assert.equal(PLACEHOLDER_NOTE, "{{story}}, {{idea}} and {{bug}} are placeholders: type one in a card's arguments, and Run asks for that input and puts it in its place."));
});

describe("strayNote", () => {
  it("names a {{…}} Run will not fill and points to {{story}}", () =>
    assert.equal(
      strayNote("{{docs/stories/01.md}}"),
      "{{docs/stories/01.md}} is not a placeholder, so the skill gets it as typed. Run fills only {{story}}, {{idea}}, {{bug}}; for a story file, write {{story}} and pick the file when Run asks.",
    ));
  it("names each stray once, joined", () => assert.match(strayNote("{{a}} {{b}} {{a}} {{story}}")!, /^\{\{a\}\} and \{\{b\}\} are not placeholders,/));
  it("says nothing for real placeholders or plain text", () => {
    assert.equal(strayNote("Plan {{story}} then {{idea}}"), undefined);
    assert.equal(strayNote("Implement the approved plan above."), undefined);
  });
});

describe("filterPalette", () => {
  const palette = [
    { skill: "m-skills:planning-architect", label: "Plan" },
    { skill: "acme:lint", label: "lint" },
  ];

  it("keeps every skill for an empty or blank filter", () => {
    assert.equal(filterPalette(palette, ""), palette);
    assert.equal(filterPalette(palette, "  "), palette);
  });

  it("matches the name or the label, in any case", () => {
    assert.deepEqual(filterPalette(palette, "ARCH").map((p) => p.skill), ["m-skills:planning-architect"]);
    assert.deepEqual(filterPalette(palette, "plan").map((p) => p.skill), ["m-skills:planning-architect"]);
    assert.deepEqual(filterPalette(palette, " lint ").map((p) => p.skill), ["acme:lint"]);
    assert.deepEqual(filterPalette(palette, "nope"), []);
  });

  it("says how many match in words", () => {
    assert.deepEqual([0, 1, 2].map(matchCount), ["No skills match", "1 skill matches", "2 skills match"]);
  });
});
