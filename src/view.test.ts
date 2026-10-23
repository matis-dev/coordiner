import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCard, TEMPLATES, type Chain } from "./chains.ts";
import { finishedMessage, nothingToReviewMessage, pickedChain, processItem, startItems, stepItem, type StepView } from "./view.ts";

const step = (overrides: Partial<StepView> = {}): StepView => ({ label: "Plan", tier: "strong", model: "m-strong", status: "running", ...overrides });

describe("stepItem", () => {
  it("maps each status to its icon", () => {
    const icons = (["running", "done", "failed", "halted", "stopped"] as const).map((status) => stepItem(step({ status })).icon);
    assert.deepEqual(icons, ["loading~spin", "check", "error", "debug-stop", "circle-slash"]);
  });

  it("speaks the status, tier and model in words", () => {
    assert.equal(stepItem(step({ status: "failed" })).accessibleLabel, "Plan, failed, strong, m-strong");
  });

  it("shows tier and model, and the detail when it adds something", () => {
    assert.equal(stepItem(step()).description, "strong · m-strong");
    assert.equal(stepItem(step({ status: "done", detail: "next: Light" })).description, "strong · m-strong · next: Light");
  });

  it("shows and speaks the effort when the card sets one", () => {
    const item = stepItem(step({ effort: "high", status: "done", detail: "next: Light" }));
    assert.equal(item.description, "strong · m-strong · high · next: Light");
    assert.equal(item.accessibleLabel, "Plan, done, strong, m-strong, effort high");
  });

  it("does not repeat a detail that only echoes the status", () => {
    assert.equal(stepItem(step({ status: "done", detail: "done" })).description, "strong · m-strong");
  });

  it("clips a long detail", () => {
    const { description } = stepItem(step({ status: "failed", detail: "x".repeat(300) }));
    assert.equal(description.length, "strong · m-strong · ".length + 121);
  });

  it("strips control characters from every text field", () => {
    const item = stepItem(step({ label: "Pl\u001b[31man", model: "m\u0007x", status: "halted", detail: "re\u001bason" }));
    assert.equal(item.label, "Pl[31man");
    assert.equal(item.description, "strong · mx · re" + "ason");
    assert.equal(item.accessibleLabel, "Pl[31man, halted, strong, mx");
  });
});

describe("processItem", () => {
  const tests = { id: "t1", type: "local_bash", description: "pnpm test" };

  it("shows the description, and the kind until a progress line arrives", () => {
    assert.deepEqual(processItem(tests, "Implement"), { label: "pnpm test", description: "local_bash", icon: "terminal", accessibleLabel: "pnpm test, running, under Implement" });
  });

  it("shows and speaks the latest progress line", () => {
    const item = processItem({ ...tests, summary: "120 of 551" }, "Implement");
    assert.equal(item.description, "120 of 551");
    assert.equal(item.accessibleLabel, "pnpm test, running, under Implement, 120 of 551");
  });

  it("gives a subagent its own icon, and names a task without a description by its kind", () => {
    const item = processItem({ id: "a", type: "local_agent", description: "" }, "Plan");
    assert.equal(item.icon, "pulse");
    assert.equal(item.label, "local_agent");
  });

  it("strips control characters and clips a long description and line", () => {
    const item = processItem({ ...tests, description: `run\u0007 ${"x".repeat(500)}`, summary: "y".repeat(500) }, "Im\u001bplement");
    assert.equal(item.label.length, 121);
    assert.equal(item.label.startsWith("run x"), true);
    assert.equal(item.description.length, 121);
    assert.match(item.accessibleLabel, /under Implement/);
  });
});

describe("startItems", () => {
  const own = (name: string, cards: string[][]): Chain => ({ id: `chain-${name.length}`, name, sessions: cards.map((s) => ({ cards: s.map(defaultCard) })) });

  it("groups the templates into flows and single skills, then your chains, as the rail does", () => {
    const items = startItems(TEMPLATES, [own("Mine", [["acme:lint"]])]);
    assert.deepEqual(
      items.map((i) => ("separator" in i ? `— ${i.separator}` : i.label)),
      ["— Templates", "Story", "Idea", "Bug", "New project", "— Single skills", "Kickoff", "Onboard", "Security audit", "UI audit", "Accessibility audit", "Docs audit", "— My chains", "Mine"],
    );
  });

  it("describes a flow by its cards and sessions, and a single skill by its command", () => {
    const items = startItems(TEMPLATES, []).filter((i) => "id" in i);
    assert.deepEqual(items.find((i) => i.id === "story"), { label: "Story", description: "Plan → Implement · Review → Fix → History", id: "story" });
    assert.deepEqual(items.find((i) => i.id === "kickoff"), { label: "Kickoff", description: "/m-skills:kickoff", id: "kickoff" });
  });

  it("leaves out My chains when there are none", () => {
    assert.equal(startItems(TEMPLATES, []).some((i) => "separator" in i && i.separator === "My chains"), false);
  });

  it("strips control characters from a chain you named", () => {
    const [, item] = startItems([], [own("Mine\u001b[2J", [["acme:a"], ["acme:b"]])]);
    assert.deepEqual(item, { label: "Mine[2J", description: "a · b", id: "chain-8" });
  });
});

describe("pickedChain", () => {
  const mine: Chain = { id: "chain-1", name: "Mine", sessions: [{ cards: [defaultCard("acme:a")] }] };
  it("finds a template or one of your chains by id", () => {
    assert.equal(pickedChain("kickoff", TEMPLATES, [mine])?.name, "Kickoff");
    assert.equal(pickedChain("chain-1", TEMPLATES, [mine]), mine);
  });
  it("runs nothing for a dismissed pick or a chain that is gone", () => {
    assert.equal(pickedChain(undefined, TEMPLATES, [mine]), undefined);
    assert.equal(pickedChain("chain-2", TEMPLATES, [mine]), undefined);
  });
});

describe("finishedMessage", () => {
  it("points at the worktree to review when files changed", () =>
    assert.equal(finishedMessage("Story 1", "Commit brief", "/w/s1"), "Coordiner: Story 1 is finished. The commit brief is in the Coordiner output; review the worktree at /w/s1."));
  it("says nothing changed when there is no worktree to review", () =>
    assert.equal(finishedMessage("audit", "Result", undefined), "Coordiner: audit is finished. The result is in the Coordiner output; no file changed, and the output says how to remove the worktree."));
});

describe("nothingToReviewMessage", () => {
  it("points at the output when it says how to remove the worktree", () =>
    assert.equal(nothingToReviewMessage("Story 1", true), "Coordiner: Story 1 finished without changing any file, so there is nothing to review; the Coordiner output says how to remove the worktree."));
  it("says only that nothing changed when git could not say whether the worktree is clean", () =>
    assert.equal(nothingToReviewMessage("Story 1", false), "Coordiner: Story 1 finished without changing any file, so there is nothing to review."));
});
