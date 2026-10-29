import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultCard, TEMPLATES, type Chain } from "./chains.ts";
import type { Line, PastRun } from "./history.ts";
import { currentItem, finishedMessage, nothingToReviewMessage, pickedChain, processItem, sessionItem, startItems, stepItem, when, worktreeItem, type StepView } from "./view.ts";

const step = (overrides: Partial<StepView> = {}): StepView => ({ label: "Plan", tier: "strong", model: "m-strong", status: "running", ...overrides });

describe("stepItem", () => {
  it("marks the card waiting for the user with a bell, and says so first", () => {
    const item = stepItem(step({ status: "waiting" }));
    assert.equal(item.icon, "bell-dot");
    assert.equal(item.description, "waiting for you · strong · m-strong");
    assert.equal(item.accessibleLabel, "Plan, waiting for you, strong, m-strong");
  });

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

describe("when", () => {
  const now = new Date(2026, 9, 28, 12, 0).getTime();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  it("says how long ago, in the words a row has room for", () => {
    assert.deepEqual([0.5, 1, 59, 60, 23 * 60 + 59, 24 * 60, 47 * 60].map((m) => when(ago(m), now)), ["just now", "1 min ago", "59 min ago", "1 h ago", "23 h ago", "yesterday", "yesterday"]);
  });

  it("gives the date once it is two days back or more", () => {
    assert.equal(when(new Date(2026, 9, 25, 20, 36).toISOString(), now), "Oct 25");
  });

  it("does not guess a time it cannot read", () => {
    assert.equal(when("", now), "unknown time");
  });
});

describe("sessionItem", () => {
  const now = new Date("2026-10-28T12:00:00.000Z").getTime();
  const past = (overrides: Partial<PastRun> = {}): PastRun => ({
    file: "11.jsonl", chain: "Story", story: "11", repo: "/r", worktree: "/w", branch: "coordiner/11", questions: "timed",
    lastAt: "2026-10-28T10:00:00.000Z", steps: [], entries: [], ending: { status: "stopped" }, userOnly: false, ...overrides,
  });

  it("names the chain and story, and says how it ended in words and by icon", () => {
    const outcomes = [{ status: "done", text: "" }, { status: "no-changes" }, { status: "halted", reason: "r" }, { status: "failed", error: "e" }, { status: "stopped" }, { status: "refused", reason: "r" }] as const;
    assert.deepEqual(
      [...outcomes.map((outcome) => sessionItem(past({ outcome }), now)), sessionItem(past(), now)].map((i) => [i.description, i.icon]),
      [
        ["done · 2 h ago", "check"],
        ["nothing to review · 2 h ago", "circle-large-outline"],
        ["halted · 2 h ago", "debug-stop"],
        ["failed · 2 h ago", "error"],
        ["stopped · 2 h ago", "circle-slash"],
        ["refused · 2 h ago", "warning"],
        ["closed mid-run · 2 h ago", "history"],
      ],
    );
    assert.deepEqual(sessionItem(past({ outcome: { status: "done", text: "" } }), now), { label: "Story · 11", description: "done · 2 h ago", icon: "check", accessibleLabel: "Story · 11, done, 2 h ago" });
  });

  it("says when the journal holds only the user's side", () => {
    const item = sessionItem(past({ userOnly: true }), now);
    assert.equal(item.description, "closed mid-run · 2 h ago · replies not recorded");
    assert.equal(item.accessibleLabel, "Story · 11, closed mid-run, 2 h ago, replies not recorded");
  });
});

describe("currentItem", () => {
  it("shows the open session's state in words, with an icon for each", () => {
    assert.deepEqual(currentItem("Story · 11", "running"), { label: "Story · 11", description: "running", icon: "loading~spin", accessibleLabel: "Story · 11, running" });
    assert.equal(currentItem("Story · 11", "chat open").icon, "comment-discussion");
    assert.equal(currentItem("Story · 1\u001b1", "ended").label, "Story · 11");
    assert.equal(currentItem("x", "ended").icon, "comment");
    assert.deepEqual(currentItem("Story · 11", "waiting for you"), { label: "Story · 11", description: "waiting for you", icon: "bell-dot", accessibleLabel: "Story · 11, waiting for you" });
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

describe("worktreeItem", () => {
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  const story = TEMPLATES.find((t) => t.id === "story")!;
  const stopped = { lastAt: "2026-10-28T10:00:00.000Z", outcome: { status: "stopped" }, definition: story, lastCard: { at: { session: 0, card: 1 }, tier: "weak", reached: true, finished: false } } as PastRun;
  const line = (runs: PastRun[], where: Line["where"] = "here"): Line => ({ path: "/r.coordiner/my-app", branch: "coordiner/my-app", slug: "my-app", where, runs });

  it("says how the latest run ended and at which card, what the worktree holds, and when", () => {
    const item = worktreeItem(line([stopped]), { changed: 12, ahead: 2 }, "main", now);
    assert.deepEqual(item, {
      label: "my-app",
      description: "stopped at Implement · 12 files changed · 2 commits ahead of main · 2 h ago",
      icon: "git-branch",
      accessibleLabel: "my-app, worktree, stopped at Implement, 12 files changed, 2 commits ahead of main, 2 h ago",
    });
  });

  it("names no card for a run that finished, and counts one in the singular", () => {
    const done = { ...stopped, outcome: { status: "done", text: "" } } as PastRun;
    assert.equal(worktreeItem(line([done]), { changed: 1, ahead: 1 }, "main", now).description, "done · 1 file changed · 1 commit ahead of main · 2 h ago");
    const closed = { ...stopped, outcome: undefined } as PastRun;
    assert.match(worktreeItem(line([closed]), { changed: 0, ahead: 0 }, "main", now).description, /^closed mid-run at Implement · 0 files changed · 0 commits ahead of main/);
  });

  it("says no runs for a worktree with none, and HEAD when the branch is not known", () => {
    assert.equal(worktreeItem(line([]), { changed: 0, ahead: 0 }, undefined, now).description, "no runs · 0 files changed · 0 commits ahead of HEAD");
  });

  it("reads what git could not count as unknown, never as zero", () => {
    assert.equal(worktreeItem(line([]), {}, "main", now).description, "no runs · state unknown");
    assert.equal(worktreeItem(line([]), { changed: 3 }, "main", now).description, "no runs · 3 files changed · commits unknown");
    assert.equal(worktreeItem(line([]), { ahead: 0 }, "main", now).description, "no runs · changed files unknown · 0 commits ahead of main");
  });

  it("marks a worktree that is gone, or no longer a worktree, without counts", () => {
    assert.deepEqual([worktreeItem(line([stopped], "gone"), { changed: 5 }, "main", now).description, worktreeItem(line([stopped], "gone"), {}, "main", now).icon], ["stopped at Implement · gone · 2 h ago", "warning"]);
    assert.equal(worktreeItem(line([], "unregistered"), {}, "main", now).description, "no runs · not a worktree any more");
  });

  it("strips control characters from the name and the branch", () => {
    const odd = { ...line([]), slug: "a\u001bb" };
    assert.equal(worktreeItem(odd, { changed: 0, ahead: 0 }, "ma\u0007in", now).label, "ab");
    assert.match(worktreeItem(odd, { changed: 0, ahead: 0 }, "ma\u0007in", now).description, /ahead of main$/);
  });
});
