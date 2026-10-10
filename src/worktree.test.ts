import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addWorktree, inspectRepo, MAX_NEW_FILES, prepareReview, type Exec } from "./worktree.ts";

type Call = { file: string; args: string[]; cwd: string };

// `fail` lists argv prefixes (space-joined) that should reject, like a non-zero git exit.
function fakeExec(stdout: Record<string, string> = {}, fail: string[] = []) {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    const key = args.join(" ");
    if (fail.some((prefix) => key.startsWith(prefix))) throw new Error(`git ${key} failed`);
    return { stdout: stdout[args[0]!] ?? "", stderr: "" };
  };
  return { exec, calls };
}

describe("inspectRepo", () => {
  it("returns the top level and the dirty lines, without blank ones", async () => {
    const { exec, calls } = fakeExec({ "rev-parse": "/home/u/app\n", status: " M a.ts\n?? b.ts\n\n" });
    assert.deepEqual(await inspectRepo("/home/u/app/sub", exec), { root: "/home/u/app", dirty: [" M a.ts", "?? b.ts"] });
    assert.deepEqual(calls.map((c) => c.args), [["rev-parse", "--show-toplevel"], ["status", "--porcelain"]]);
  });

  it("reports a clean tree as no dirty lines", async () => {
    const { exec } = fakeExec({ "rev-parse": "/r\n", status: "" });
    assert.deepEqual((await inspectRepo("/r", exec)).dirty, []);
  });

  it("explains when the folder is not a repository", async () => {
    const { exec } = fakeExec({}, ["rev-parse"]);
    await assert.rejects(inspectRepo("/tmp/x", exec), /not a git repository/);
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
