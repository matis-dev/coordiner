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
  denied.push(
    ["a commit under an alias set with -c", "git -c alias.c=commit c -m x"],
    ["an alias set after another -c and -C", "git -C /repo -c user.name=x -c alias.p=push p"],
    ["an alias set with --config-env", "git --config-env=alias.c=CMD c"],
    ["an alias set with --config-env and a space", "git --config-env alias.c=CMD c"],
    ["an alias whose section is not lower case", "git -c Alias.c=commit c"],
    ["a quoted alias option", "git -c 'alias.c=commit' c"],
    ["an include set with -c", "git -c include.path=/tmp/x c -m x"],
    ["a conditional include set with -c", "git -c includeIf.gitdir:/r/.path=/tmp/x c"],
    ["an alias defined with git config, then used", "git config alias.c commit && git c -m x"],
    ["git config with a scope and a value", "git config --global user.name x"],
    ["git config set", "git config set alias.c commit"],
    ["git config --unset", "git config --unset core.hooksPath"],
    ["git config --add","git config --add alias.c commit"],
    ["an alias set through GIT_CONFIG_COUNT", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.c GIT_CONFIG_VALUE_0=commit git c -m x"],
    ["an alias set through GIT_CONFIG_PARAMETERS", `GIT_CONFIG_PARAMETERS="'alias.c=commit'" git c -m x`],
    ["a config file named through an exported GIT_CONFIG_GLOBAL", "export GIT_CONFIG_GLOBAL=/tmp/x; git c"],
  );
  // Writes that never name a denied porcelain command: moving a ref, staging through plumbing, and sending patches out.
  denied.push(
    ["a branch moved with -f", "git branch -f other HEAD"],
    ["a branch moved with --force", "git branch --force other HEAD"],
    ["a branch created with -t", "git branch -t new origin/main"],
    ["a branch created with --track", "git branch --track new origin/main"],
    ["a branch moved with -f after another flag", "git branch -q -f other HEAD"],
    ["a branch created with --no-track", "git branch --no-track new origin/main"],
    ["an upstream set with -u", "git branch -u origin/main"],
    ["an upstream set with --set-upstream-to= after another flag", "git branch -q --set-upstream-to=origin/main"],
    ["patches stored with imap-send", "git imap-send < 0001.patch"],
    ["commits published with svn dcommit", "git svn dcommit"],
    ["staging through update-index", "git update-index --add src/a.ts"],
    ["a commit made with commit-tree", "git commit-tree HEAD^{tree} -p HEAD -m x"],
    ["the index replaced with read-tree", "git read-tree HEAD"],
    ["the working tree overwritten with checkout-index", "git checkout-index -a -f"],
    ["patches sent with send-email", "git send-email --to=a@example.com HEAD^"],
    ["the reflog expired", "git reflog expire --expire=now --all"],
    ["a reflog entry deleted", "git reflog delete HEAD@{1}"],
    ["the sparse checkout changed", "git sparse-checkout set src"],
  );
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
    "git branch --list",
    "git branch -vv",
    "git branch --contains HEAD",
    "git branch -r --list 'origin/*'",
    "git branch -vv | sort -u",
    "git branch --sort=-committerdate --format '%(refname) -d'",
    "git svn log",
    "git reflog",
    "git reflog show HEAD",
    "git sparse-checkout list",
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
    "git -c color.ui=always log",
    "git log --grep alias.c",
    "git -C alias.x status",
    "git config --get user.name",
    "git config --global --get user.email",
    "git -C /repo config --get-regexp alias",
    "git config --list --show-origin",
    "git config -l",
    "git config get user.name",
    "echo $GIT_CONFIG_GLOBAL",
  ];
  for (const command of allowed) {
    it(`allows \`${command}\``, () => assert.equal(gitWriteDenial(command), undefined));
  }

  it("names the git subcommand it denied", () => {
    assert.match(gitWriteDenial("git -C x commit -m y")!, /`git commit`/);
    assert.match(gitWriteDenial("git branch new")!, /`git branch`/);
  });

  it("says why an alias set on the command line is denied", () => {
    assert.match(gitWriteDenial("git -c alias.c=commit c")!, /an alias or an include set with -c or --config-env can run any git command/);
  });

  it("says why git config is denied, and that reading it stays open", () => {
    assert.match(gitWriteDenial("git config alias.c commit")!, /`git config` changes git's settings.*`git config --get` and `--list`/);
    assert.match(gitWriteDenial("GIT_CONFIG_COUNT=1 git c")!, /a GIT_CONFIG_\* variable changes git's settings/);
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
