import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addWorktree, changedFiles, currentBranch, firstCommit, initRepo, inspectRepo, listWorktrees, MAX_NEW_FILES, mergeSteps, prepareReview, removalCommands, removalNote, removeWorktree, resumeCommand, setUpRepo, uncommitted, worktreeClean, worktreeState, type Exec, type SetupPrompt } from "./worktree.ts";

type Call = { file: string; args: string[]; cwd: string };

// `fail` lists argv prefixes (space-joined) that should reject, like a non-zero git exit; `thrown` rejects a prefix with that exact value.
function fakeExec(stdout: Record<string, string> = {}, fail: string[] = [], thrown: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    const key = args.join(" ");
    const match = Object.keys(thrown).find((prefix) => key.startsWith(prefix));
    if (match !== undefined) throw thrown[match];
    if (fail.some((prefix) => key.startsWith(prefix))) throw new Error(`git ${key} failed`);
    return { stdout: stdout[args[0]!] ?? "", stderr: "" };
  };
  return { exec, calls };
}

const notARepo = new Error("Command failed: git rev-parse --show-toplevel\nfatal: not a git repository (or any of the parent directories): .git\n");

describe("inspectRepo", () => {
  it("returns the top level and the dirty lines, without blank ones", async () => {
    const { exec, calls } = fakeExec({ "rev-parse": "/home/u/app\n", status: " M a.ts\n?? b.ts\n\n" });
    assert.deepEqual(await inspectRepo("/home/u/app/sub", exec), { kind: "ready", root: "/home/u/app", dirty: [" M a.ts", "?? b.ts"] });
    assert.deepEqual(calls.map((c) => c.args), [["rev-parse", "--show-toplevel"], ["rev-parse", "--verify", "--quiet", "HEAD"], ["status", "--porcelain"]]);
  });

  it("reports a clean tree as no dirty lines", async () => {
    const { exec } = fakeExec({ "rev-parse": "/r\n", status: "" });
    assert.deepEqual(await inspectRepo("/r", exec), { kind: "ready", root: "/r", dirty: [] });
  });

  it("reports a folder that is not a repository, so the caller can offer git init", async () => {
    const { exec } = fakeExec({}, [], { rev: notARepo });
    assert.deepEqual(await inspectRepo("/tmp/x", exec), { kind: "no-repo" });
  });

  it("asks git in the C locale, so its message is the English one matched above", async () => {
    let env: Record<string, string | undefined> | undefined;
    const exec: Exec = async (_file, _args, options) => {
      env ??= options.env;
      throw notARepo;
    };
    await inspectRepo("/tmp/x", exec);
    assert.equal(env?.LC_ALL, "C");
  });

  it("does not take any other failure for a missing repository, so git init is never offered over one git will not open", async () => {
    const dubious = new Error("Command failed: git rev-parse --show-toplevel\nfatal: detected dubious ownership in repository at '/r'\n");
    assert.deepEqual(await inspectRepo("/r", fakeExec({}, [], { rev: dubious }).exec), { kind: "failed", detail: dubious.message });
    assert.deepEqual(await inspectRepo("/r", fakeExec({}, [], { rev: new Error("spawn git ENOENT") }).exec), { kind: "failed", detail: "spawn git ENOENT" });
  });

  it("reports a repository with no commits, since a worktree starts from HEAD", async () => {
    const { exec, calls } = fakeExec({ "rev-parse": "/r\n" }, ["rev-parse --verify"]);
    assert.deepEqual(await inspectRepo("/r", exec), { kind: "no-commits", root: "/r" });
    assert.equal(calls.some((c) => c.args[0] === "status"), false);
  });

  it("explains when git fails after finding the repository", async () => {
    const { exec } = fakeExec({ "rev-parse": "/r\n" }, ["status"]);
    await assert.rejects(inspectRepo("/r", exec), /^Error: \/r is not a git repository, or git is unavailable\.$/);
  });
});

describe("initRepo", () => {
  it("runs git init in the folder", async () => {
    const { exec, calls } = fakeExec();
    assert.deepEqual(await initRepo("/r", exec), { ok: true });
    assert.deepEqual(calls, [{ file: "git", args: ["init"], cwd: "/r" }]);
  });

  it("returns git's error rather than throwing", async () => assert.deepEqual(await initRepo("/r", fakeExec({}, ["init"]).exec), { ok: false, detail: "git init failed" }));

  it("keeps a non-Error failure as the detail", async () => assert.deepEqual(await initRepo("/r", fakeExec({}, [], { init: "boom" }).exec), { ok: false, detail: "boom" }));
});

describe("uncommitted", () => {
  it("names every file the first commit would take, staged and untracked, as git wrote them", async () => {
    const { exec, calls } = fakeExec({ "ls-files": "a.ts\0src/b.ts\0é.md\0" });
    assert.deepEqual(await uncommitted("/r", exec), { kind: "files", files: ["a.ts", "src/b.ts", "é.md"] });
    assert.deepEqual(calls.map((c) => c.args), [["ls-files", "--cached", "--others", "--exclude-standard", "-z"]]);
  });

  it("reports more than MAX_NEW_FILES as too many", async () => {
    const many = Array.from({ length: MAX_NEW_FILES + 1 }, (_, i) => `f${i}\0`).join("");
    assert.deepEqual(await uncommitted("/r", fakeExec({ "ls-files": many }).exec), { kind: "too-many" });
  });

  it("reports a listing that overflows exec's output buffer as too many, not as git's error", async () => {
    const overflow = Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    assert.deepEqual(await uncommitted("/r", fakeExec({}, [], { "ls-files": overflow }).exec), { kind: "too-many" });
  });

  it("returns any other git error rather than throwing", async () => {
    assert.deepEqual(await uncommitted("/r", fakeExec({}, ["ls-files"]).exec), { kind: "failed", detail: "git ls-files --cached --others --exclude-standard -z failed" });
  });
});

describe("firstCommit", () => {
  it("makes an empty commit without staging anything", async () => {
    const { exec, calls } = fakeExec();
    assert.deepEqual(await firstCommit("/r", false, exec), { ok: true });
    assert.deepEqual(calls.map((c) => c.args), [["commit", "--allow-empty", "-m", "Initial commit"]]);
  });

  it("stages every file first when asked to take them", async () => {
    const { exec, calls } = fakeExec();
    assert.deepEqual(await firstCommit("/r", true, exec), { ok: true });
    assert.deepEqual(calls.map((c) => c.args), [["add", "--all"], ["commit", "--allow-empty", "-m", "Initial commit"]]);
  });

  it("returns git's error rather than throwing", async () => {
    const { exec } = fakeExec({}, ["commit"]);
    assert.deepEqual(await firstCommit("/r", false, exec), { ok: false, detail: "git commit --allow-empty -m Initial commit failed" });
  });
});

// A folder git sees through `repo` and `commit`, which git init and git commit turn on; `answers` are the user's replies, in order.
function fakeSetup(start: { repo: boolean; commit: boolean; files?: string[]; fail?: string }, answers: boolean[] = []) {
  const git = { ...start };
  const writes: string[][] = [];
  const asked: SetupPrompt[] = [];
  const logged: string[] = [];
  const exec: Exec = async (_file, args) => {
    const key = args.join(" ");
    if (git.fail !== undefined && key.startsWith(git.fail)) throw new Error(`git ${key} failed`);
    if (key === "rev-parse --show-toplevel") {
      if (!git.repo) throw notARepo;
      return { stdout: "/r\n", stderr: "" };
    }
    if (key.startsWith("rev-parse --verify")) {
      if (!git.commit) throw new Error("no HEAD");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "ls-files") return { stdout: (git.files ?? []).map((f) => `${f}\0`).join(""), stderr: "" };
    if (args[0] === "status") return { stdout: "", stderr: "" };
    writes.push(args);
    if (args[0] === "init") git.repo = true;
    if (args[0] === "commit") git.commit = true;
    return { stdout: "", stderr: "" };
  };
  const ask = async (prompt: SetupPrompt) => {
    asked.push(prompt);
    return answers.shift() ?? false;
  };
  return { deps: { exec, ask, log: (line: string) => logged.push(line) }, writes, asked, logged };
}

describe("setUpRepo", () => {
  const ready = { kind: "ready", repo: { kind: "ready", root: "/r", dirty: [] } };
  const emptyCommit = ["commit", "--allow-empty", "-m", "Initial commit"];

  it("asks nothing and writes nothing in a repository that has a commit", async () => {
    const { deps, writes, asked } = fakeSetup({ repo: true, commit: true });
    assert.deepEqual(await setUpRepo("/r", deps), ready);
    assert.deepEqual([asked, writes], [[], []]);
  });

  it("asks once for an empty folder: agreeing to git init covers the empty first commit", async () => {
    const { deps, writes, asked, logged } = fakeSetup({ repo: false, commit: false }, [true]);
    assert.deepEqual(await setUpRepo("/r", deps), ready);
    assert.deepEqual(asked, [{ kind: "init", folder: "/r" }]);
    assert.deepEqual(writes, [["init"], emptyCommit]);
    assert.deepEqual(logged, ["Initialized a git repository in /r", "Made the first commit in /r"]);
  });

  it("shows the files before committing them, even after git init was agreed", async () => {
    const { deps, writes, asked } = fakeSetup({ repo: false, commit: false, files: ["a.ts", "b.ts"] }, [true, true]);
    assert.deepEqual(await setUpRepo("/r", deps), ready);
    assert.deepEqual(asked, [{ kind: "init", folder: "/r" }, { kind: "commit-files", root: "/r", files: ["a.ts", "b.ts"] }]);
    assert.deepEqual(writes, [["init"], ["add", "--all"], emptyCommit]);
  });

  it("asks before an empty first commit in a repository git init made earlier", async () => {
    const { deps, writes, asked } = fakeSetup({ repo: true, commit: false }, [true]);
    assert.deepEqual(await setUpRepo("/r", deps), ready);
    assert.deepEqual(asked, [{ kind: "empty-commit", root: "/r" }]);
    assert.deepEqual(writes, [emptyCommit]);
  });

  it("writes nothing when git init is declined", async () => {
    const { deps, writes } = fakeSetup({ repo: false, commit: false }, [false]);
    assert.deepEqual(await setUpRepo("/r", deps), { kind: "cancelled" });
    assert.deepEqual(writes, []);
  });

  it("stages and commits nothing when the files are declined", async () => {
    const { deps, writes } = fakeSetup({ repo: true, commit: false, files: ["a.ts"] }, [false]);
    assert.deepEqual(await setUpRepo("/r", deps), { kind: "cancelled" });
    assert.deepEqual(writes, []);
  });

  it("refuses more than MAX_NEW_FILES files without asking to commit them", async () => {
    const files = Array.from({ length: MAX_NEW_FILES + 1 }, (_, i) => `f${i}`);
    const { deps, writes, asked } = fakeSetup({ repo: true, commit: false, files });
    const result = await setUpRepo("/r", deps);
    assert.equal(result.kind, "failed");
    assert.match(result.kind === "failed" ? result.reason : "", new RegExp(`^More than ${MAX_NEW_FILES} files are not committed yet`));
    assert.deepEqual([asked, writes], [[], []]);
  });

  it("asks nothing and commits nothing when the files cannot be listed", async () => {
    const { deps, writes, asked } = fakeSetup({ repo: true, commit: false, fail: "ls-files" });
    assert.deepEqual(await setUpRepo("/r", deps), { kind: "failed", reason: "Git could not list the files for the first commit.", detail: "git ls-files --cached --others --exclude-standard -z failed" });
    assert.deepEqual([asked, writes], [[], []]);
  });

  it("does not hand on a repository that still has no commit after the first one was made", async () => {
    const { exec } = fakeExec({ "rev-parse": "/r\n" }, ["rev-parse --verify"]);
    assert.deepEqual(await setUpRepo("/r", { exec, ask: async () => true, log: () => {} }), { kind: "failed", reason: "/r still has no commit to start from." });
  });

  it("offers no git init over a folder git could not open, and passes git's message on", async () => {
    const { deps, asked } = fakeSetup({ repo: true, commit: true, fail: "rev-parse --show-toplevel" });
    assert.deepEqual(await setUpRepo("/r", deps), { kind: "failed", reason: "Git could not open /r as a repository. Is git installed?", detail: "git rev-parse --show-toplevel failed" });
    assert.deepEqual(asked, []);
  });

  it("reports a failed git init or first commit with git's message", async () => {
    assert.deepEqual(await setUpRepo("/r", fakeSetup({ repo: false, commit: false, fail: "init" }, [true]).deps), { kind: "failed", reason: "git init failed. Is git installed?", detail: "git init failed" });
    const commit = await setUpRepo("/r", fakeSetup({ repo: true, commit: false, fail: "commit" }, [true]).deps);
    assert.deepEqual(commit, { kind: "failed", reason: "The first commit failed. If git asks who you are, set user.name and user.email, then start again.", detail: "git commit --allow-empty -m Initial commit failed" });
  });
});

describe("worktreeClean", () => {
  it("is true for a worktree with nothing to show", async () => {
    const { exec, calls } = fakeExec({ status: "\n" });
    assert.equal(await worktreeClean("/w", exec), true);
    assert.deepEqual(calls, [{ file: "git", args: ["status", "--porcelain"], cwd: "/w" }]);
  });

  it("is false when a file changed", async () => assert.equal(await worktreeClean("/w", fakeExec({ status: "?? new.md\n" }).exec), false));
  it("is unknown when git fails", async () => assert.equal(await worktreeClean("/w", fakeExec({}, ["status"]).exec), undefined));
});

// Splits a command line the way a POSIX shell does for single quotes, so a test can see which arguments git would get.
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (const m of line.matchAll(/'([^']*)'|\\(.)|(\s+)|([^\s'\\]+)/g)) {
    if (m[3] !== undefined) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + (m[1] ?? m[2] ?? m[4]);
  }
  if (word !== undefined) words.push(word);
  return words;
}

describe("removalNote", () => {
  const worktree = { root: "/home/u/app", path: "/home/u/app.coordiner/audit", branch: "coordiner/audit" };

  it("prints the removal commands, indented, under the worktree it found unchanged", async () => {
    assert.deepEqual(await removalNote(worktree, fakeExec({ status: "" }).exec), [
      "Nothing changed in /home/u/app.coordiner/audit. To remove the worktree and its branch, run:",
      "  git -C '/home/u/app' worktree remove '/home/u/app.coordiner/audit'",
      "  git -C '/home/u/app' branch -D 'coordiner/audit'",
    ]);
  });

  it("says nothing when a file changed, or when git could not say", async () => {
    assert.equal(await removalNote(worktree, fakeExec({ status: " M a.ts\n" }).exec), undefined);
    assert.equal(await removalNote(worktree, fakeExec({}, ["status"]).exec), undefined);
  });

  it("says how to remove an unchanged worktree, without a command, when its path cannot be shown safely", async () => {
    assert.deepEqual(await removalNote({ ...worktree, path: "/home/u/a\u001b[2K" }, fakeExec({ status: "" }).exec), [
      "Nothing changed in /home/u/a[2K. Its path has a control character, so no command is printed; remove it with git worktree remove and its branch coordiner/audit with git branch -D.",
    ]);
  });
});

describe("removalCommands", () => {
  it("removes the worktree, then its branch, from the repository", () => {
    assert.deepEqual(removalCommands("/home/u/app", "/home/u/app.coordiner/audit", "coordiner/audit"), [
      "git -C '/home/u/app' worktree remove '/home/u/app.coordiner/audit'",
      "git -C '/home/u/app' branch -D 'coordiner/audit'",
    ]);
  });

  it("keeps a path with a space or a quote as one argument", () => {
    const [remove, branch] = removalCommands("/home/u/my app's", "/home/u/my app's.coordiner/a", "coordiner/a")!;
    assert.deepEqual(shellWords(remove!), ["git", "-C", "/home/u/my app's", "worktree", "remove", "/home/u/my app's.coordiner/a"]);
    assert.deepEqual(shellWords(branch!), ["git", "-C", "/home/u/my app's", "branch", "-D", "coordiner/a"]);
  });

  it("prints no command for a path with a control character", () => {
    assert.equal(removalCommands("/home/u/a\nrm -rf ~", "/home/u/a.coordiner/x", "coordiner/x"), undefined);
    assert.equal(removalCommands("/home/u/a", "/home/u/a.coordiner/x\u001b[2K", "coordiner/x"), undefined);
  });
});

describe("resumeCommand", () => {
  it("goes to the worktree, quoted as one argument, and resumes the session", () => {
    const command = resumeCommand("/home/u/my app's.coordiner/a", "0c5fcc13-3a18-4d74-a6b4-e97c15b9323a")!;
    assert.equal(command, "cd '/home/u/my app'\\''s.coordiner/a' && claude --resume 0c5fcc13-3a18-4d74-a6b4-e97c15b9323a");
    assert.deepEqual(shellWords(command.split(" && ")[0]!), ["cd", "/home/u/my app's.coordiner/a"]);
  });

  it("prints no command for a path with a control character or a session id that is not a plain id", () => {
    assert.equal(resumeCommand("/home/u/a\nrm -rf ~", "abc-1"), undefined);
    assert.equal(resumeCommand("/home/u/a", "abc; rm -rf ~"), undefined);
    assert.equal(resumeCommand("/home/u/a", ""), undefined);
    assert.equal(resumeCommand("/home/u/a", "--dangerously-skip-permissions"), undefined);
  });
});

const notThere = async () => false;

describe("addWorktree", () => {
  it("adds a worktree next to the repo on a coordiner branch, from HEAD", async () => {
    const { exec, calls } = fakeExec({}, ["show-ref"]);
    const result = await addWorktree("/home/u/app", "story-1-login", { exec, exists: notThere });
    assert.deepEqual(result, { ok: true, path: "/home/u/app.coordiner/story-1-login", branch: "coordiner/story-1-login" });
    assert.deepEqual(calls.map((c) => c.args), [
      ["show-ref", "--verify", "--quiet", "refs/heads/coordiner/story-1-login"],
      ["worktree", "add", "-b", "coordiner/story-1-login", "--", "/home/u/app.coordiner/story-1-login", "HEAD"],
    ]);
    assert.equal(calls.every((c) => c.file === "git" && c.cwd === "/home/u/app"), true);
  });

  it("refuses when the branch already exists, creating nothing", async () => {
    const { exec, calls } = fakeExec();
    const result = await addWorktree("/home/u/app", "story-1", { exec, exists: notThere });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : "", /branch coordiner\/story-1 already exists/);
    assert.doesNotMatch(!result.ok ? result.reason : "", /continue/);
    assert.equal(calls.length, 1);
  });

  it("refuses when the directory already exists, creating nothing", async () => {
    const { exec, calls } = fakeExec({}, ["show-ref"]);
    const result = await addWorktree("/home/u/app", "story-1", { exec, exists: async () => true });
    assert.match(!result.ok ? result.reason : "", /app\.coordiner\/story-1 already exists/);
    assert.equal(calls.length, 1);
  });

  it("reports a git failure with a written reason and keeps the detail for the log", async () => {
    const { exec } = fakeExec({}, ["show-ref", "worktree"]);
    const result = await addWorktree("/home/u/app", "story-1", { exec, exists: notThere });
    assert.deepEqual(result, { ok: false, reason: "Git could not create the worktree.", detail: "git worktree add -b coordiner/story-1 -- /home/u/app.coordiner/story-1 HEAD failed" });
  });

  it("keeps a non-Error git failure as the detail", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[0] === "show-ref") throw new Error("no");
      throw "plain";
    };
    const result = await addWorktree("/r", "s", { exec, exists: notThere });
    assert.equal(!result.ok && result.detail, "plain");
  });

  // Security regression: a story heading is attacker-influenced text. Shell syntax, option-like or path-like names must never reach git.
  it("refuses unsafe names without calling git", async () => {
    for (const slug of ["x; rm -rf ~", "../../etc", "-rf", "a b", "", "UPPER", "$(id)"]) {
      const { exec, calls } = fakeExec();
      const result = await addWorktree("/home/u/app", slug, { exec, exists: notThere });
      assert.equal(result.ok, false, slug);
      assert.equal(calls.length, 0, slug);
    }
  });
});

describe("prepareReview", () => {
  const nul = (files: string[]) => files.map((f) => `${f}\0`).join("");
  const addArgs = (calls: Call[]) => calls.find((c) => c.args.includes("add"))!.args;

  it("reports no changes on a clean tree, after one status call", async () => {
    const { exec, calls } = fakeExec({ status: "\n" });
    assert.deepEqual(await prepareReview("/w", exec), { kind: "no-changes" });
    assert.deepEqual(calls.map((c) => c.args), [["status", "--porcelain"]]);
  });

  it("marks nothing when only tracked files changed", async () => {
    const { exec, calls } = fakeExec({ status: " M a.ts\n", "ls-files": "" });
    assert.deepEqual(await prepareReview("/w", exec), { kind: "ready", marked: 0 });
    assert.deepEqual(calls.map((c) => c.args[0]), ["status", "ls-files"]);
  });

  it("marks new files with intent-to-add, in the worktree", async () => {
    const { exec, calls } = fakeExec({ status: "?? src/new.ts\n", "ls-files": nul(["src/new.ts", "docs/a.md"]) });
    assert.deepEqual(await prepareReview("/w", exec), { kind: "ready", marked: 2 });
    assert.deepEqual(calls.map((c) => c.args), [
      ["status", "--porcelain"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
      ["--literal-pathspecs", "add", "--intent-to-add", "--", "src/new.ts", "docs/a.md"],
    ]);
    assert.equal(calls.every((c) => c.file === "git" && c.cwd === "/w"), true);
  });

  it("marks exactly the cap, and refuses one file more without marking any", async () => {
    const at = Array.from({ length: MAX_NEW_FILES }, (_, n) => `f${n}`);
    const { exec } = fakeExec({ status: "?? f0\n", "ls-files": nul(at) });
    assert.deepEqual(await prepareReview("/w", exec), { kind: "ready", marked: MAX_NEW_FILES });

    const over = fakeExec({ status: "?? f0\n", "ls-files": nul([...at, "one-more"]) });
    assert.deepEqual(await prepareReview("/w", over.exec), { kind: "too-many", count: MAX_NEW_FILES + 1 });
    assert.equal(over.calls.some((c) => c.args.includes("add")), false);
  });

  it("reports a git failure with its detail", async () => {
    const { exec } = fakeExec({ status: "?? x\n", "ls-files": nul(["x"]) }, ["--literal-pathspecs add"]);
    const result = await prepareReview("/w", exec);
    assert.equal(result.kind, "failed");
    assert.match(result.kind === "failed" ? result.detail : "", /intent-to-add -- x failed/);
  });

  it("keeps a non-Error failure as the detail", async () => {
    const exec: Exec = async () => {
      throw "plain";
    };
    assert.deepEqual(await prepareReview("/w", exec), { kind: "failed", detail: "plain" });
  });

  // Security regression: session 1's model chooses file names. An option-like name must reach git only as a path, after `--`.
  it("passes option-like file names only after --", async () => {
    const { exec, calls } = fakeExec({ status: "?? --force\n", "ls-files": nul(["--force", "-x"]) });
    await prepareReview("/w", exec);
    const args = addArgs(calls);
    assert.deepEqual(args.slice(0, 4), ["--literal-pathspecs", "add", "--intent-to-add", "--"]);
    assert.deepEqual(args.slice(4), ["--force", "-x"]);
  });

  // Security regression: names with spaces or newlines must stay one argument each, which only NUL-separated output guarantees.
  it("keeps names with spaces and newlines as single arguments", async () => {
    const { exec, calls } = fakeExec({ status: "?? x\n", "ls-files": nul(["a b.ts", "line\nbreak.ts"]) });
    assert.deepEqual(await prepareReview("/w", exec), { kind: "ready", marked: 2 });
    assert.deepEqual(addArgs(calls).slice(4), ["a b.ts", "line\nbreak.ts"]);
  });

  // Security regression: `--` stops option parsing but not pathspec magic. A new file named `:!src/evil.ts` must not exclude src/evil.ts from the review.
  it("turns off pathspec magic, so one new file name cannot exclude another from the review", async () => {
    const names = ["src/evil.ts", ":!src/evil.ts", ":(exclude)src/evil.ts", "*"];
    const { exec, calls } = fakeExec({ status: "?? src/evil.ts\n", "ls-files": nul(names) });
    await prepareReview("/w", exec);
    const args = addArgs(calls);
    assert.equal(args[0], "--literal-pathspecs");
    assert.deepEqual(args.slice(args.indexOf("--") + 1), names);
  });
});

// `git worktree list --porcelain -z`: every field ends with a NUL, and every record with one more.
const porcelain = (...records: string[][]) => records.map((fields) => fields.map((f) => `${f}\0`).join("") + "\0").join("");
const MAIN = ["worktree /home/u/app", "HEAD 1111", "branch refs/heads/main"];
const AUDIT = ["worktree /home/u/app.coordiner/audit", "HEAD 2222", "branch refs/heads/coordiner/audit"];

describe("listWorktrees", () => {
  it("lists the worktrees on a coordiner branch, never the main one", async () => {
    const stdout = porcelain(
      MAIN,
      AUDIT,
      ["worktree /home/u/elsewhere", "HEAD 3333", "branch refs/heads/feature"],
      ["worktree /home/u/detached", "HEAD 4444", "detached"],
      ["worktree /home/u/app.coordiner/gone", "HEAD 5555", "branch refs/heads/coordiner/gone", "prunable gitdir file points to non-existent location"],
    );
    const { exec, calls } = fakeExec({ worktree: stdout });
    assert.deepEqual(await listWorktrees("/home/u/app", exec), {
      ok: true,
      main: "/home/u/app",
      worktrees: [
        { path: "/home/u/app.coordiner/audit", branch: "coordiner/audit" },
        { path: "/home/u/app.coordiner/gone", branch: "coordiner/gone" },
      ],
    });
    assert.deepEqual(calls[0], { file: "git", args: ["worktree", "list", "--porcelain", "-z"], cwd: "/home/u/app" });
  });

  it("skips the main worktree even when it has a coordiner branch checked out", async () => {
    const { exec } = fakeExec({ worktree: porcelain(["worktree /home/u/app", "HEAD 1", "branch refs/heads/coordiner/audit"]) });
    assert.deepEqual(await listWorktrees("/home/u/app", exec), { ok: true, main: "/home/u/app", worktrees: [] });
  });

  // A worktree opened in its own window: git still lists the main worktree first, and the one asked from is one of the others.
  it("names the main worktree and lists the one it is asked from, when asked from a linked worktree", async () => {
    const { exec, calls } = fakeExec({ worktree: porcelain(MAIN, AUDIT) });
    assert.deepEqual(await listWorktrees("/home/u/app.coordiner/audit", exec), {
      ok: true,
      main: "/home/u/app",
      worktrees: [{ path: "/home/u/app.coordiner/audit", branch: "coordiner/audit" }],
    });
    assert.equal(calls[0]!.cwd, "/home/u/app.coordiner/audit");
  });

  it("takes the path it was asked from as the main one when git's first record names none", async () => {
    assert.deepEqual(await listWorktrees("/r", fakeExec({ worktree: "" }).exec), { ok: true, main: "/r", worktrees: [] });
  });

  it("keeps a path with a newline whole, and skips a branch outside coordiner/<slug>", async () => {
    const stdout = porcelain(MAIN, ["worktree /home/u/a\nb", "HEAD 2", "branch refs/heads/coordiner/x"], ["worktree /home/u/c", "HEAD 3", "branch refs/heads/coordiner/Bad Name"], ["worktree /home/u/d", "HEAD 4", "branch refs/heads/coordiner/../main"]);
    assert.deepEqual(await listWorktrees("/home/u/app", fakeExec({ worktree: stdout }).exec), { ok: true, main: "/home/u/app", worktrees: [{ path: "/home/u/a\nb", branch: "coordiner/x" }] });
  });

  it("reports git's failure rather than an empty list", async () => {
    assert.deepEqual(await listWorktrees("/r", fakeExec({}, ["worktree"]).exec), { ok: false, detail: "git worktree list --porcelain -z failed" });
  });
});

describe("worktreeState", () => {
  const audit = { path: "/home/u/app.coordiner/audit", branch: "coordiner/audit" };

  it("counts the uncommitted files in the worktree and the commits its branch has that HEAD does not", async () => {
    const { exec, calls } = fakeExec({ status: " M a.ts\n?? b.ts\n\n", "rev-list": "2\n" });
    assert.deepEqual(await worktreeState("/home/u/app", audit, exec), { changed: 2, ahead: 2 });
    assert.deepEqual(calls.map((c) => [c.args, c.cwd]), [
      [["status", "--porcelain"], audit.path],
      [["rev-list", "--count", "HEAD..refs/heads/coordiner/audit"], "/home/u/app"],
      [["merge-tree", "--write-tree", "HEAD", "refs/heads/coordiner/audit"], "/home/u/app"],
      [["rev-parse", "HEAD^{tree}"], "/home/u/app"],
    ]);
  });

  it("marks commits as landed when merging them into HEAD gives HEAD's own tree, as after a squash merge", async () => {
    const tree = "a".repeat(40);
    const state = await worktreeState("/r", audit, fakeExec({ status: "", "rev-list": "1\n", "merge-tree": `${tree}\n`, "rev-parse": `${tree}\n` }).exec);
    assert.deepEqual(state, { changed: 0, ahead: 1, landed: true });
  });

  it("does not mark commits as landed when the merged tree differs, merge-tree fails, or it prints no tree", async () => {
    const tree = "a".repeat(40);
    const differs = await worktreeState("/r", audit, fakeExec({ status: "", "rev-list": "1\n", "merge-tree": `${"b".repeat(40)}\n`, "rev-parse": `${tree}\n` }).exec);
    assert.deepEqual(differs, { changed: 0, ahead: 1 });
    const conflict = await worktreeState("/r", audit, fakeExec({ status: "", "rev-list": "1\n", "rev-parse": `${tree}\n` }, ["merge-tree"]).exec);
    assert.deepEqual(conflict, { changed: 0, ahead: 1 });
    assert.deepEqual(await worktreeState("/r", audit, fakeExec({ status: "", "rev-list": "1\n" }).exec), { changed: 0, ahead: 1 });
  });

  it("does not ask whether commits landed when the branch has none", async () => {
    const { exec, calls } = fakeExec({ status: "", "rev-list": "0\n" });
    assert.deepEqual(await worktreeState("/r", audit, exec), { changed: 0, ahead: 0 });
    assert.equal(calls.some((c) => c.args[0] === "merge-tree"), false);
  });

  it("says nothing it could not find out, rather than zero", async () => {
    assert.deepEqual(await worktreeState("/r", audit, fakeExec({}, ["status", "rev-list"]).exec), {});
    assert.deepEqual(await worktreeState("/r", audit, fakeExec({ status: "", "rev-list": "lots" }).exec), { changed: 0 });
  });

  it("does not ask git about a branch Coordiner did not make", async () => {
    const { exec, calls } = fakeExec({ status: "" });
    assert.deepEqual(await worktreeState("/r", { ...audit, branch: "--all" }, exec), { changed: 0 });
    assert.equal(calls.some((c) => c.args[0] === "rev-list"), false);
  });
});

describe("changedFiles", () => {
  it("counts the uncommitted files in a checkout, or nothing when git cannot say", async () => {
    const { exec, calls } = fakeExec({ status: " M a.ts\n?? b.ts\n" });
    assert.equal(await changedFiles("/r", exec), 2);
    assert.deepEqual(calls, [{ file: "git", args: ["status", "--porcelain"], cwd: "/r" }]);
    assert.equal(await changedFiles("/r", fakeExec({ status: "" }).exec), 0);
    assert.equal(await changedFiles("/r", fakeExec({}, ["status"]).exec), undefined);
  });
});

describe("mergeSteps", () => {
  const base = { root: "/home/u/app", path: "/home/u/app.coordiner/audit", branch: "coordiner/audit", target: "main", mainChanged: 0, changed: 3, ahead: 0 };
  const commands = (steps: { command?: string }[]) => steps.flatMap((s) => (s.command ? [s.command] : []));

  it("stages the run's changes, then squashes the branch into the main checkout's branch and reuses its commit message", () => {
    const steps = mergeSteps(base);
    assert.deepEqual(commands(steps), [
      "cd '/home/u/app.coordiner/audit' && git add -A",
      "git -C '/home/u/app' merge --squash 'coordiner/audit'",
      "git -C '/home/u/app' commit -C 'coordiner/audit'",
      "git -C '/home/u/app' reset --merge",
    ]);
    assert.match(steps[1]!.text, /commit brief's git commit command/);
    assert.match(steps[2]!.text, /into main as one change/);
    assert.match(steps.at(-1)!.text, /End chat.*Remove Worktree/);
  });

  it("skips staging once everything is committed in the worktree", () => {
    assert.deepEqual(commands(mergeSteps({ ...base, changed: 0, ahead: 1 })), [
      "git -C '/home/u/app' merge --squash 'coordiner/audit'",
      "git -C '/home/u/app' commit -C 'coordiner/audit'",
      "git -C '/home/u/app' reset --merge",
    ]);
  });

  it("warns first when the main checkout has uncommitted files", () => {
    const steps = mergeSteps({ ...base, mainChanged: 1 });
    assert.equal(steps[0]!.text, "The main checkout has 1 file uncommitted. Commit or stash them first: the merge stops if it would touch them.");
    assert.equal(steps[0]!.command, undefined);
    assert.match(mergeSteps({ ...base, mainChanged: 4 })[0]!.text, /has 4 files uncommitted/);
  });

  it("says there is nothing to merge when the branch has no changes and no commits, or its commits already landed", () => {
    const none = mergeSteps({ ...base, changed: 0, ahead: 0 });
    assert.deepEqual(commands(none), []);
    assert.equal(none[0]!.text, "Nothing to merge: coordiner/audit has no changes and no commits that main lacks.");
    const landed = mergeSteps({ ...base, changed: 0, ahead: 2, landed: true });
    assert.deepEqual(commands(landed), []);
    assert.equal(landed[0]!.text, "Nothing to merge: the changes on coordiner/audit are already in main.");
    assert.match(landed[1]!.text, /Remove Worktree/);
  });

  it("still gives the merge commands when landed commits are followed by new uncommitted changes", () => {
    assert.equal(commands(mergeSteps({ ...base, changed: 1, ahead: 2, landed: true })).length, 4);
  });

  it("prints no command when git could not say what the worktree or the main checkout holds", () => {
    for (const unknown of [{ changed: undefined }, { ahead: undefined }, { mainChanged: undefined }]) {
      const steps = mergeSteps({ ...base, ...unknown });
      assert.deepEqual(commands(steps), []);
      assert.match(steps[0]!.text, /^Git could not say/);
    }
  });

  it("prints no merge command for a detached main checkout", () => {
    for (const target of [undefined, "HEAD"]) {
      const steps = mergeSteps({ ...base, target });
      assert.deepEqual(commands(steps), []);
      assert.match(steps[0]!.text, /is not on a branch/);
    }
  });

  it("prints no command for a branch Coordiner did not make", () => {
    const steps = mergeSteps({ ...base, branch: "--upload-pack=evil" });
    assert.deepEqual(commands(steps), []);
    assert.match(steps[0]!.text, /is not a branch Coordiner made/);
  });

  it("prints no command when a path or the target branch carries a control character, so a newline cannot start a second command", () => {
    for (const bad of [{ path: "/home/u/x\nrm -rf ~" }, { root: "/home/u/a\u001b[2J" }, { target: "main\ncurl evil" }]) {
      const steps = mergeSteps({ ...base, ...bad });
      assert.deepEqual(commands(steps), []);
      assert.match(steps[0]!.text, /control character/);
      assert.ok(!steps[0]!.text.includes("\u001b"));
    }
  });

  it("keeps a worktree path with a single quote inside one quoted argument", () => {
    const [stage] = commands(mergeSteps({ ...base, path: "/home/u/it's" }));
    assert.equal(stage, `cd '/home/u/it'\\''s' && git add -A`);
  });
});

describe("currentBranch", () => {
  it("names the branch the main checkout is on, or nothing when git cannot say", async () => {
    assert.equal(await currentBranch("/r", fakeExec({ "rev-parse": "main\n" }).exec), "main");
    assert.equal(await currentBranch("/r", fakeExec({}, ["rev-parse"]).exec), undefined);
    assert.equal(await currentBranch("/r", fakeExec({ "rev-parse": "\n" }).exec), undefined);
  });
});

describe("removeWorktree", () => {
  const audit = { path: "/home/u/app.coordiner/audit", branch: "coordiner/audit" };
  const listed = { worktree: porcelain(MAIN, AUDIT) };
  const DELETE_BRANCH = ["branch", "-D"];

  it("re-lists, removes the worktree, then deletes its branch, from the repository", async () => {
    const { exec, calls } = fakeExec(listed);
    assert.deepEqual(await removeWorktree("/home/u/app", audit, { force: false }, exec), { ok: true, removed: ["worktree", "branch"], left: [] });
    assert.deepEqual(calls.map((c) => [c.args, c.cwd]), [
      [["worktree", "list", "--porcelain", "-z"], "/home/u/app"],
      [["worktree", "remove", "--", audit.path], "/home/u/app"],
      [[...DELETE_BRANCH, "coordiner/audit"], "/home/u/app"],
    ]);
  });

  it("forces the removal only when asked", async () => {
    const { exec, calls } = fakeExec(listed);
    await removeWorktree("/home/u/app", audit, { force: true }, exec);
    assert.deepEqual(calls[1]!.args, ["worktree", "remove", "--force", "--", audit.path]);
  });

  it("says what is left to do when the branch could not be deleted after the worktree was", async () => {
    const { exec } = fakeExec(listed, [DELETE_BRANCH[0]!]);
    const result = await removeWorktree("/home/u/app", audit, { force: false }, exec);
    assert.deepEqual(result, { ok: true, removed: ["worktree"], left: [removalCommands("/home/u/app", audit.path, audit.branch)![1]!] });
  });

  it("offers no command to paste for a path with a control character", async () => {
    const odd = { path: "/home/u/a\u0007b", branch: "coordiner/x" };
    const { exec } = fakeExec({ worktree: porcelain(MAIN, [`worktree ${odd.path}`, "HEAD 2", "branch refs/heads/coordiner/x"]) }, [DELETE_BRANCH[0]!]);
    assert.deepEqual(await removeWorktree("/home/u/app", odd, { force: false }, exec), { ok: true, removed: ["worktree"], left: [] });
  });

  it("removes nothing when git refuses to remove the worktree", async () => {
    const { exec, calls } = fakeExec(listed, ["worktree remove"]);
    const result = await removeWorktree("/home/u/app", audit, { force: false }, exec);
    assert.deepEqual(result, { ok: false, reason: "Git could not remove the worktree.", detail: `git worktree remove -- ${audit.path} failed` });
    assert.equal(calls.some((c) => c.args[0] === DELETE_BRANCH[0]), false);
  });

  // The path and branch come from a listing or a journal; neither may aim git at anything but a worktree it lists now.
  it("refuses to remove a path git does not list as a coordiner worktree", async () => {
    for (const target of [{ path: "/home/u/app", branch: "coordiner/audit" }, { path: "/home/u/important", branch: "coordiner/audit" }, { path: audit.path, branch: "coordiner/other" }]) {
      const { exec, calls } = fakeExec(listed);
      assert.equal((await removeWorktree("/home/u/app", target, { force: true }, exec)).ok, false);
      assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [["worktree", "list"]]);
    }
  });

  it("refuses a branch name outside coordiner/<slug> before calling git", async () => {
    for (const branch of ["main", "-D", "coordiner/../main", "coordiner/a b"]) {
      const { exec, calls } = fakeExec(listed);
      assert.equal((await removeWorktree("/home/u/app", { ...audit, branch }, { force: true }, exec)).ok, false);
      assert.equal(calls.length, 0);
    }
  });

  it("passes the path after --, so a path that looks like an option is still a path", async () => {
    const odd = { path: "--force", branch: "coordiner/odd" };
    const { exec, calls } = fakeExec({ worktree: porcelain(MAIN, ["worktree --force", "HEAD 9", "branch refs/heads/coordiner/odd"]) });
    await removeWorktree("/home/u/app", odd, { force: false }, exec);
    assert.deepEqual(calls[1]!.args, ["worktree", "remove", "--", "--force"]);
  });

  it("removes nothing when git cannot list the worktrees", async () => {
    const { exec, calls } = fakeExec({}, ["worktree list"]);
    assert.deepEqual(await removeWorktree("/home/u/app", audit, { force: true }, exec), { ok: false, reason: "Git could not list the worktrees, so nothing was removed.", detail: "git worktree list --porcelain -z failed" });
    assert.equal(calls.length, 1);
  });
});
