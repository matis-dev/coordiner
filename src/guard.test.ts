import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { gitWriteDenial, guardHook } from "./guard.ts";

describe("gitWriteDenial", () => {
  const denied: Array<[name: string, command: string]> = [
    ["a plain commit", "git commit -m x"],
    ["a push with -C before it", "git -C /repo push origin main"],
    ["a commit hidden after &&", "cd app && git add ."],
    ["a reset inside bash -c", 'bash -c "git reset --hard"'],
    ["an interposed --git-dir flag", "git --git-dir=.git commit -m y"],
    ["branch creation", "git branch feature"],
    ["branch deletion", "git branch -D old"],
    ["tag creation", "git tag v1"],
    ["a bare stash", "git stash"],
    ["stash pop", "git stash pop"],
    ["worktree add", "git worktree add ../x"],
    ["remote add", "git remote add up url"],
    ["a quoted mention, by design of the full-string scan", 'echo "git commit"'],
    ["git called by its absolute path", "/usr/bin/git commit -m x"],
    ["the -P pager flag before the subcommand", "git -P commit -m x"],
    ["--git-dir with its value as a separate word", "git --git-dir .git commit -m x"],
    ["--work-tree with its value as a separate word", "git --work-tree . add -A"],
    ["-C with a quoted path holding a space", "git -C '/tmp/a b' commit -m x"],
    ["a quoted git", '"git" push'],
    ["gh called by its absolute path", "/usr/bin/gh pr create --fill"],
    ["skipping hooks", "npm test --no-verify"],
    ["skipping signing", "git log --no-gpg-sign"],
    ["opening a pull request", "gh pr create --fill"],
    ["merging a pull request", "gh pr merge 3"],
    ["setting a secret", "gh secret set TOKEN"],
    ["a writing API call", "gh api repos/a/b/issues -X POST -f title=x"],
    ["triggering a workflow", "gh workflow run ci.yml"],
  ];
  for (const [name, command] of denied) {
    it(`denies ${name}`, () => assert.notEqual(gitWriteDenial(command), undefined));
  }

  const allowed = [
    "git status",
    "git diff HEAD",
    "git log --oneline -5",
    "git show HEAD:src/a.ts",
    "git branch",
    "git branch -a",
    "git tag",
    "git tag -l",
    "git stash list",
    "git worktree list",
    "git remote -v",
    "gh pr view 3",
    "gh pr diff 3",
    "gh api repos/a/b",
    "legit commit",
    "pnpm test",
    "cat .git/config",
    "ls ~/git-templates",
    "git -P log",
    "git --version",
    "git -C '/tmp/a b' status",
    "git -c core.pager=cat diff",
  ];
  for (const command of allowed) {
    it(`allows \`${command}\``, () => assert.equal(gitWriteDenial(command), undefined));
  }

  it("names the git subcommand it denied", () => {
    assert.match(gitWriteDenial("git -C x commit -m y")!, /`git commit`/);
    assert.match(gitWriteDenial("git branch new")!, /`git branch`/);
  });
});

const bash = (tool_input: unknown) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/r" }) as unknown as HookInput;
const signal = new AbortController().signal;
const decision = (output: object) => (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

describe("guardHook", () => {
  it("denies a git write and logs the reason, never the command", async () => {
    const lines: string[] = [];
    const out = await guardHook((l) => lines.push(l))(bash({ command: "git commit -m 'secret token abc'" }), "t1", { signal });
    assert.equal(decision(out), "deny");
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0]!, /secret token/);
  });

  it("lets an ordinary command through without logging", async () => {
    const lines: string[] = [];
    assert.deepEqual(await guardHook((l) => lines.push(l))(bash({ command: "git status" }), "t1", { signal }), {});
    assert.deepEqual(lines, []);
  });

  it("ignores tools other than Bash", async () => {
    const input = { ...(bash({ command: "git commit" }) as object), tool_name: "Edit" } as unknown as HookInput;
    assert.deepEqual(await guardHook(() => assert.fail("no log"))(input, "t1", { signal }), {});
  });

  it("ignores events other than PreToolUse", async () => {
    const input = { ...(bash({ command: "git commit" }) as object), hook_event_name: "PostToolUse" } as unknown as HookInput;
    assert.deepEqual(await guardHook(() => assert.fail("no log"))(input, "t1", { signal }), {});
  });

  it("denies a Bash call whose command it cannot read", async () => {
    const lines: string[] = [];
    assert.equal(decision(await guardHook((l) => lines.push(l))(bash({ command: 42 }), "t1", { signal })), "deny");
    assert.equal(decision(await guardHook((l) => lines.push(l))(bash(null), "t1", { signal })), "deny");
    assert.equal(lines.length, 2);
  });

  it("fails closed when reading the input throws", async () => {
    const lines: string[] = [];
    const hostile = {
      get command(): string {
        throw new Error("boom");
      },
    };
    assert.equal(decision(await guardHook((l) => lines.push(l))(bash(hostile), "t1", { signal })), "deny");
    assert.match(lines[0]!, /boom/);
  });

  it("reports a non-Error throw too", async () => {
    const lines: string[] = [];
    const hostile = {
      get command(): string {
        throw "plain";
      },
    };
    assert.equal(decision(await guardHook((l) => lines.push(l))(bash(hostile), "t1", { signal })), "deny");
    assert.match(lines[0]!, /plain/);
  });
});
