import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { briefHeading, cardPrompt, defaultCard, parseChain, parseChains, parseChainShape, inputKinds, inputOf, keepsStarted, pickUpFrom, startReason, requiredSkills, runnable, serializeChains, singleSkill, skillDefault, takeFrom, TEMPLATES, usesMskills, type Chain } from "./chains.ts";

const story = TEMPLATES.find((t) => t.id === "story")!;
const mine = (sessions: Chain["sessions"], id = "mine"): Chain => ({ id, name: "Mine", sessions });

describe("templates", () => {
  it("keeps the Story flow's prompts exactly as the fixed scripts had them", () => {
    assert.deepEqual(
      story.sessions.map((s) => s.cards.map(cardPrompt)),
      [
        ["/m-skills:planning-architect {{story}}", "/m-skills:implementing-architect Implement the approved plan above."],
        ["/m-skills:code-review-architect-uncommitted", "/m-skills:implementing-architect fix the findings", "/m-skills:rolling-history"],
      ],
    );
    assert.deepEqual(story.sessions.flatMap((s) => s.cards.map((c) => c.label)), ["Plan", "Implement", "Review", "Fix", "History"]);
    assert.deepEqual(story.sessions[1]!.cards.map((c) => c.next), [undefined, "Continue with the next fix.", undefined]);
  });

  it("ships four flows named after what you bring, then six single skills, all using m-skills", () => {
    assert.deepEqual(TEMPLATES.map((t) => [t.id, t.name]), [
      ["story", "Story"],
      ["idea", "Idea"],
      ["bug", "Bug"],
      ["new-project", "New project"],
      ["kickoff", "Kickoff"],
      ["onboard", "Onboard"],
      ["security-audit", "Security audit"],
      ["ui-audit", "UI audit"],
      ["a11y-audit", "Accessibility audit"],
      ["docs-audit", "Docs audit"],
    ]);
    assert.ok(TEMPLATES.every((t) => t.builtIn && usesMskills(t)));
  });

  it("runs each single skill alone, with no arguments, so Run asks only for a name", () => {
    const singles = TEMPLATES.filter(singleSkill);
    assert.deepEqual(singles.map((t) => cardPrompt(t.sessions[0]!.cards[0]!)), [
      "/m-skills:kickoff",
      "/m-skills:onboard",
      "/m-skills:security-audit",
      "/m-skills:ui-audit",
      "/m-skills:a11y-audit",
      "/m-skills:docs-audit",
    ]);
    assert.ok(singles.every((t) => inputOf(t) === undefined && runnable(t, requiredSkills(t)).ok));
  });

  it("tells a single skill from a flow", () => {
    assert.deepEqual(TEMPLATES.map(singleSkill), [false, false, false, false, true, true, true, true, true, true]);
    assert.equal(singleSkill(mine([{ cards: [defaultCard("a"), defaultCard("b")] }])), false);
    assert.equal(singleSkill(mine([{ cards: [defaultCard("a")] }, { cards: [defaultCard("b")] }])), false);
  });

  it("calls the final message a commit brief only after rolling-history", () => {
    assert.equal(briefHeading(story), "Commit brief");
    assert.equal(briefHeading(TEMPLATES.find((t) => t.id === "security-audit")!), "Result");
    assert.equal(briefHeading(mine([TEMPLATES.find((t) => t.id === "bug")!.sessions[0]!])), "Result");
    assert.equal(briefHeading(mine([])), "Result");
  });

  it("reserves the single-skill template ids", () => {
    assert.equal(parseChain({ id: "security-audit", name: "Mine", sessions: [] }), "chain id security-audit belongs to a built-in template");
  });

  it("takes a template's shape back as it is, for a journaled run", () => {
    const template = TEMPLATES.find((t) => t.id === "story")!;
    const { builtIn: _builtIn, ...shape } = template;
    assert.deepEqual(parseChainShape(JSON.parse(JSON.stringify(template))), shape);
    assert.equal(parseChainShape({ ...shape, sessions: [{ cards: [{ skill: "bad skill", args: "", label: "X", pause: false }] }] }), "chain story: a card has an invalid skill name");
    assert.equal(parseChainShape(null), "a chain is not an object");
  });

  it("starts each interactive flow from the input its first skill expects", () => {
    assert.deepEqual(
      TEMPLATES.slice(1, 4).map((t) => t.sessions[0]!.cards.map(cardPrompt)),
      [
        ["/m-skills:brainstorming-planner {{idea}}", "/m-skills:planning-architect Plan the Deep-Dive Execution Prompt above.", "/m-skills:implementing-architect Implement the approved plan above."],
        // debugging-architect writes the fix itself, so its session ends there.
        ["/m-skills:debugging-architect {{bug}}"],
        ["/m-skills:kickoff {{idea}}", "/m-skills:planning-architect Plan the first slice decided above.", "/m-skills:implementing-architect Implement the approved plan above."],
      ],
    );
  });

  it("marks the conversations as pausing and lets the audits run unattended", () => {
    assert.deepEqual(TEMPLATES.map((t) => t.sessions[0]!.cards[0]!.pause), [false, true, true, true, true, true, false, false, false, false]);
  });

  it("has the implementing cards take the model and effort their plan or review suggests, and no other card", () => {
    const following = TEMPLATES.flatMap((t) => t.sessions.flatMap((s) => s.cards.filter((c) => c.follow).map((c) => `${t.id}:${c.label}`)));
    assert.deepEqual(following, ["story:Implement", "story:Fix", "idea:Implement", "idea:Fix", "bug:Fix", "new-project:Implement", "new-project:Fix"]);
  });
});

describe("skill defaults", () => {
  it("knows the m-skills cards", () => {
    assert.deepEqual(skillDefault("m-skills:implementing-architect").kind, "loop");
    assert.deepEqual(skillDefault("m-skills:planning-architect"), { kind: "once", label: "Plan" });
  });

  it("treats any other skill as one turn named after the skill", () => {
    assert.deepEqual(skillDefault("acme:lint-fix"), { kind: "once", label: "lint-fix" });
    assert.deepEqual(defaultCard("deploy"), { skill: "deploy", args: "", label: "deploy", pause: false });
  });

  it("gives every valid skill name a label a stored chain accepts, so a new card can always be saved", () => {
    const long = `acme:${"x".repeat(90)}`;
    assert.equal(skillDefault(long).label, "x".repeat(60));
    assert.equal(skillDefault("acme:").label, "acme:");
    const chain = { id: "a", name: "A", sessions: [{ cards: [defaultCard(long), defaultCard("acme:")] }] };
    assert.deepEqual(parseChain(chain), chain);
  });

  it("builds a card with the default continuation prompt for a loop skill", () => {
    assert.equal(defaultCard("m-skills:implementing-architect").next, "Continue with the next step of the plan.");
  });

  it("writes a prompt without a trailing space when there are no args", () => {
    assert.equal(cardPrompt(defaultCard("m-skills:rolling-history")), "/m-skills:rolling-history");
  });
});

describe("requiredSkills and usesMskills", () => {
  it("lists each skill once", () => {
    assert.deepEqual(requiredSkills(story), ["m-skills:planning-architect", "m-skills:implementing-architect", "m-skills:code-review-architect-uncommitted", "m-skills:rolling-history"]);
  });

  it("says when a chain needs no m-skills", () => {
    assert.equal(usesMskills(mine([{ cards: [defaultCard("acme:x")] }])), false);
  });
});

describe("inputOf", () => {
  it("asks Story for a story, Idea and New project for an idea, Bug for a bug, and a single skill for nothing", () =>
    assert.deepEqual(TEMPLATES.map(inputOf), ["story", "idea", "bug", "idea", undefined, undefined, undefined, undefined, undefined, undefined]));
  it("is undefined for a chain without a placeholder, which needs only a name", () => assert.equal(inputOf(mine([{ cards: [defaultCard("acme:x")] }])), undefined));
  it("finds a placeholder in any session", () => assert.equal(inputOf(mine([{ cards: [defaultCard("a")] }, { cards: [{ ...defaultCard("b"), args: "fix {{bug}} now" }] }])), "bug"));
  it("lists every kind a chain uses", () => {
    const both = mine([{ cards: [{ ...defaultCard("a"), args: "{{story}}" }, { ...defaultCard("b"), args: "{{idea}}" }] }]);
    assert.deepEqual(inputKinds(both), ["story", "idea"]);
  });
});

describe("runnable", () => {
  const all = requiredSkills(story);
  it("accepts the Story template when its skills are present", () => assert.deepEqual(runnable(story, all), { ok: true }));
  it("accepts a chain when the skills are not known yet", () => assert.deepEqual(runnable(story), { ok: true }));
  it("refuses a chain with no sessions", () => assert.deepEqual(runnable(mine([])), { ok: false, reason: "This chain has no sessions." }));
  it("refuses a chain with an empty session", () => assert.deepEqual(runnable(mine([{ cards: [defaultCard("x")] }, { cards: [] }])), { ok: false, reason: "Session 2 has no skills." }));

  it("refuses a chain that uses more than one kind of input", () => {
    const both = mine([{ cards: [{ ...defaultCard("a"), args: "{{story}}" }, { ...defaultCard("b"), args: "{{bug}}" }] }]);
    assert.deepEqual(runnable(both), { ok: false, reason: "Use only one of {{story}}, {{idea}}, {{bug}} in a chain; Run asks for one input." });
  });

  it("runs a chain with a pausing card; the card waits for the user in the chat", () => {
    assert.deepEqual(runnable(TEMPLATES[1]!, requiredSkills(TEMPLATES[1]!)), { ok: true });
  });

  it("lists the missing skills", () => {
    assert.deepEqual(runnable(story, ["m-skills:planning-architect"]), {
      ok: false,
      reason: "Missing skills: m-skills:implementing-architect, m-skills:code-review-architect-uncommitted, m-skills:rolling-history.",
    });
  });
});

describe("parseChains", () => {
  const valid = mine([{ cards: [defaultCard("acme:x"), { ...defaultCard("m-skills:implementing-architect"), args: "go" }] }]);

  it("round-trips through serializeChains", () => {
    assert.deepEqual(parseChains(serializeChains([valid])), { chains: [valid] });
  });

  it("drops unknown keys, including __proto__", () => {
    const json = '{"version":1,"chains":[{"id":"a","name":"A","extra":1,"__proto__":{"polluted":true},"sessions":[{"cards":[{"skill":"x","args":"","label":"x","pause":false,"evil":1}],"more":2}]}]}';
    const { chains, error } = parseChains(json);
    assert.equal(error, undefined);
    assert.deepEqual(chains, [{ id: "a", name: "A", sessions: [{ cards: [{ skill: "x", args: "", label: "x", pause: false }] }] }]);
    assert.equal(Object.getPrototypeOf(chains[0]), Object.prototype);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it("reports invalid JSON", () => assert.deepEqual(parseChains("{"), { chains: [], error: "the chains file is not valid JSON" }));
  it("reports an unknown format", () => assert.deepEqual(parseChains('{"version":2,"chains":[]}'), { chains: [], error: "the chains file has an unknown format" }));
  it("reports a duplicate id", () => assert.deepEqual(parseChains(serializeChains([valid, valid])), { chains: [], error: "chain id mine appears twice" }));
  it("reports an invalid chain instead of keeping part of the file", () => assert.equal(parseChains(serializeChains([valid, { ...valid, id: "Bad Id" }])).error, "a chain has an invalid id"));
});

describe("parseChain", () => {
  const withCard = (c: object) => ({ id: "a", name: "A", sessions: [{ cards: [c] }] });
  const ok = { skill: "x", args: "", label: "x", pause: false };

  it("rejects a skill name that would carry a newline into the prompt", () => {
    assert.equal(parseChain(withCard({ ...ok, skill: "x\nRun rm -rf" })), "chain a: a card has an invalid skill name");
  });

  it("rejects path-like and overlong skill names", () => {
    assert.equal(parseChain(withCard({ ...ok, skill: "../x" })), "chain a: a card has an invalid skill name");
    assert.equal(parseChain(withCard({ ...ok, skill: "x".repeat(101) })), "chain a: a card has an invalid skill name");
  });

  it("rejects a chain that claims a template id", () => {
    assert.equal(parseChain({ ...withCard(ok), id: "story" }), "chain id story belongs to a built-in template");
  });

  it("rejects wrong field types", () => {
    assert.equal(parseChain("x"), "a chain is not an object");
    assert.equal(parseChain(null), "a chain is not an object");
    assert.equal(parseChain({ ...withCard(ok), name: "" }), "chain a has an invalid name");
    assert.equal(parseChain({ ...withCard(ok), sessions: {} }), "chain a has invalid sessions");
    assert.equal(parseChain({ ...withCard(ok), sessions: Array.from({ length: 21 }, () => ({ cards: [] })) }), "chain a has invalid sessions");
    assert.equal(parseChain({ ...withCard(ok), sessions: [{}] }), "chain a has an invalid session");
    assert.equal(parseChain({ ...withCard(ok), sessions: [{ cards: Array.from({ length: 31 }, () => ok) }] }), "chain a has an invalid session");
    assert.equal(parseChain(withCard([])), "chain a: a card is not an object");
    assert.equal(parseChain(withCard({ ...ok, pause: "no" })), "chain a: card x has invalid fields");
    assert.equal(parseChain(withCard({ ...ok, label: "" })), "chain a: card x has invalid fields");
    assert.equal(parseChain(withCard({ ...ok, args: 3 })), "chain a: card x has invalid fields");
    assert.equal(parseChain(withCard({ ...ok, next: "" })), "chain a: card x has an invalid next prompt");
  });

  it("keeps a pinned model and effort, and a card without them parses as before", () => {
    const pinned = parseChain(withCard({ ...ok, model: "claude-opus-5-5[1m]", effort: "xhigh" }));
    assert.deepEqual(typeof pinned !== "string" && pinned.sessions[0]!.cards[0], { ...ok, model: "claude-opus-5-5[1m]", effort: "xhigh" });
    const plain = parseChain(withCard(ok));
    assert.deepEqual(typeof plain !== "string" && plain.sessions[0]!.cards[0], ok);
  });

  it("round-trips a pinned card through serializeChains", () => {
    const chain = { id: "a", name: "A", sessions: [{ cards: [{ ...ok, model: "claude-haiku-5-5", effort: "low" as const }] }] };
    assert.deepEqual(parseChains(serializeChains([chain])), { chains: [chain] });
  });

  it("takes a model of 100 characters and refuses one of 101", () => {
    assert.notEqual(typeof parseChain(withCard({ ...ok, model: "m".repeat(100) })), "string");
    assert.equal(parseChain(withCard({ ...ok, model: "m".repeat(101) })), "chain a: card x has an invalid model");
  });

  it("rejects a model that would carry a newline, a space or a shell separator to the session", () => {
    for (const model of ["opus\n--dangerously-skip-permissions", "opus --x", "opus;rm", "", 7]) {
      assert.equal(parseChain(withCard({ ...ok, model })), "chain a: card x has an invalid model");
    }
  });

  it("rejects an effort the SDK does not know", () => {
    for (const effort of ["turbo", "", 3, "LOW"]) assert.equal(parseChain(withCard({ ...ok, effort })), "chain a: card x has an invalid effort");
  });

  it("keeps follow when it is true, and refuses any other value", () => {
    const parsed = parseChain(withCard({ ...ok, follow: true }));
    assert.equal(typeof parsed !== "string" && parsed.sessions[0]!.cards[0]!.follow, true);
    const plain = parseChain(withCard(ok));
    assert.equal(typeof plain !== "string" && Object.hasOwn(plain.sessions[0]!.cards[0]!, "follow"), false);
    for (const follow of [false, "yes", 1]) assert.equal(parseChain(withCard({ ...ok, follow })), "chain a: card x has an invalid follow setting");
  });

  it("keeps a valid next prompt", () => {
    const parsed = parseChain(withCard({ ...ok, next: "Keep going." }));
    assert.equal(typeof parsed !== "string" && parsed.sessions[0]!.cards[0]!.next, "Keep going.");
  });
});

describe("a chain while it runs", () => {
  const card = (skill: string, args = "") => ({ ...defaultCard(skill), args });
  const before = mine([{ cards: [card("a"), card("b")] }, { cards: [card("c")] }, { cards: [card("d")] }]);
  const edit = (change: (sessions: Chain["sessions"]) => Chain["sessions"]) => mine(change(structuredClone(before.sessions)));

  it("keeps a started session whose settings changed or that gained cards at its end", () => {
    assert.equal(keepsStarted(before, edit((s) => (s[0]!.cards[0]!.args = "new", s)), 1), true);
    assert.equal(keepsStarted(before, edit((s) => (s[1]!.cards.push(card("e")), s)), 1), true);
    assert.equal(keepsStarted(before, edit((s) => [s[0]!, s[1]!]), 1), true, "a session not started yet may go");
    assert.equal(keepsStarted(before, edit((s) => (s[2]!.cards.reverse(), s)), 0), true);
  });

  it("does not keep a started session whose cards moved, left or were replaced", () => {
    assert.equal(keepsStarted(before, edit((s) => (s[0]!.cards.reverse(), s)), 0), false);
    assert.equal(keepsStarted(before, edit((s) => (s[0]!.cards.pop(), s)), 0), false);
    assert.equal(keepsStarted(before, edit((s) => (s[0]!.cards[1] = card("x"), s)), 0), false);
    assert.equal(keepsStarted(before, edit((s) => [s[0]!, s[2]!]), 1), false, "a started session removed");
    assert.equal(keepsStarted(before, edit((s) => (s[1]!.cards.unshift(card("e")), s)), 1), false, "a card put in front");
  });

  it("lets a session start when it holds skills, whatever a later session holds", () => {
    const chain = mine([{ cards: [card("a")] }, { cards: [card("b", "{{story}}")] }, { cards: [] }]);
    assert.equal(startReason(chain, 1, "story"), undefined);
    assert.equal(startReason(chain, 2, "story"), "Session 3 has no skills.");
    assert.equal(startReason(chain, 3, "story"), undefined, "past the end, the run just ends");
  });

  it("does not start a session once the chain asks for a second input, or one the run was not given", () => {
    const two = mine([{ cards: [card("a", "{{story}}")] }, { cards: [card("b", "{{idea}}")] }]);
    assert.match(startReason(two, 1, "story")!, /^Use only one of \{\{story\}\}, \{\{idea\}\}, \{\{bug\}\} in a chain/);
    const idea = mine([{ cards: [card("a")] }, { cards: [card("b", "{{idea}}")] }]);
    assert.equal(startReason(idea, 1, "story"), "{{idea}} has nothing to fill it: this run started from the story you choose at Run.");
    assert.equal(startReason(idea, 1, undefined), "{{idea}} has nothing to fill it: this run started from a name only.");
    assert.equal(startReason(idea, 1, "idea"), undefined);
    assert.equal(startReason(mine([{ cards: [card("a")] }, { cards: [card("b")] }]), 1, "story"), undefined, "a placeholder dropped is fine");
  });

  it("takes the sessions from `s` on from the saved chain and keeps the ones before as the run has them", () => {
    const saved = mine([{ cards: [card("x")] }, { cards: [card("y"), card("c")] }]);
    const taken = takeFrom(before, saved, 1);
    assert.deepEqual(taken.sessions.map((s) => s.cards.map((c) => c.skill)), [["a", "b"], ["y", "c"]], "a shorter saved chain ends there");
    assert.equal(taken.id, before.id);
  });

  it("picks up the saved copy of the run's chain from the session starting, and the run's own chain when none is saved", () => {
    const saved = mine([{ cards: [card("x")] }, { cards: [card("y")] }]);
    const other = { ...mine([{ cards: [card("z")] }]), id: "other" };
    const picked = pickUpFrom(before, [other, saved], 1, undefined);
    assert.deepEqual(typeof picked !== "string" && picked.sessions.map((s) => s.cards.map((c) => c.skill)), [["a", "b"], ["y"]]);
    assert.equal(pickUpFrom(before, [other], 1, undefined), before, "a template or a deleted chain runs on as the run has it");
  });

  it("gives the reason instead when the session starting cannot start as saved", () => {
    const emptied = mine([{ cards: [card("a"), card("b")] }, { cards: [] }]);
    assert.equal(pickUpFrom(before, [emptied], 1, undefined), "Session 2 has no skills.");
    const asking = mine([{ cards: [card("a")] }, { cards: [card("c", "{{bug}}")] }]);
    assert.equal(pickUpFrom(before, [asking], 1, "story"), "{{bug}} has nothing to fill it: this run started from the story you choose at Run.");
  });
});

describe("parseChain: images on a card", () => {
  const image = { id: "a".repeat(64), name: "ticket.png", bytes: 2048, mediaType: "image/png" };
  const chainWith = (images: unknown) => ({ id: "mine", name: "Mine", sessions: [{ cards: [{ ...defaultCard("acme:lint"), images }] }] });

  it("keeps a card's image refs, rebuilt without any other field", () => {
    const parsed = parseChain(chainWith([{ ...image, data: "iVBORw0KGgo=" }])) as Chain;
    assert.deepEqual(parsed.sessions[0]!.cards[0]!.images, [image]);
  });

  it("refuses images that are not named by a hash, are not a type Claude takes, repeat, are too large, or are too many", () => {
    for (const images of [
      [{ ...image, id: "../../etc/hostname" }],
      [{ ...image, id: "A".repeat(64) }],
      [{ ...image, mediaType: "image/svg+xml" }],
      [image, image],
      [{ ...image, bytes: 3_750_001 }],
      [{ ...image, bytes: 1.5 }],
      [{ ...image, name: "" }],
      Array.from({ length: 6 }, (_, n) => ({ ...image, id: String(n).repeat(64) })),
      [],
      "ticket.png",
    ]) {
      assert.equal(typeof parseChain(chainWith(images)), "string", JSON.stringify(images).slice(0, 60));
    }
  });

  it("reads a card without images as before", () => {
    assert.equal((parseChain({ id: "mine", name: "Mine", sessions: [{ cards: [defaultCard("acme:lint")] }] }) as Chain).sessions[0]!.cards[0]!.images, undefined);
  });
});
