import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addWorktree, inspectRepo, type Exec } from "./worktree.ts";

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
