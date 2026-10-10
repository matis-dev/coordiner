import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proposeSetup, runSetup } from "./setup.ts";
import type { Exec } from "./worktree.ts";

describe("proposeSetup", () => {
  it("proposes the install that matches the lockfile", () => {
    assert.deepEqual(proposeSetup(["package.json", "package-lock.json"]), ["npm", "ci"]);
    assert.deepEqual(proposeSetup(["pnpm-lock.yaml"]), ["pnpm", "install", "--frozen-lockfile"]);
    assert.deepEqual(proposeSetup(["yarn.lock"]), ["yarn", "install", "--frozen-lockfile"]);
  });

  it("proposes nothing without a lockfile", () => {
    assert.equal(proposeSetup(["package.json", "README.md"]), undefined);
  });

  it("prefers npm when several lockfiles exist", () => {
    assert.deepEqual(proposeSetup(["yarn.lock", "package-lock.json"]), ["npm", "ci"]);
  });
});

describe("runSetup", () => {
  const env = { PATH: "/nvm/bin" };

  it("runs the argv without a shell in the worktree with the session env", async () => {
    const seen: unknown[] = [];
    const exec: Exec = async (file, args, options) => {
      seen.push([file, args, options]);
      return { stdout: "", stderr: "" };
    };
    assert.deepEqual(await runSetup(["npm", "ci"], "/wt", env, exec), { ok: true });
    assert.deepEqual(seen, [["npm", ["ci"], { cwd: "/wt", env }]]);
  });

  it("returns a written message naming the command and the setting, with the stderr tail as detail", async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error("Command failed"), { stderr: `${"x".repeat(600)}npm ERR! missing lockfile` });
    };
    const result = await runSetup(["npm", "ci"], "/wt", env, exec);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /"npm ci" did not finish.*coordiner\.extraPath/);
    assert.equal(result.detail.length, 500);
    assert.match(result.detail, /npm ERR! missing lockfile$/);
  });

  it("falls back to the error text when there is no stderr", async () => {
    const exec: Exec = async () => {
      throw new Error("spawn npm ENOENT");
    };
    const result = await runSetup(["npm", "ci"], "/wt", env, exec);
    assert.equal(!result.ok && result.detail, "Error: spawn npm ENOENT");
  });
});
