import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { checkEnvironment, sessionEnv, type CheckDeps, type Models } from "./environment.ts";
import type { TurnRequest, TurnResult } from "./session.ts";

const models: Models = { strong: "m-strong", medium: "m-medium", weak: "m-weak" };
const canUseTool: CanUseTool = async (_name, input) => ({ behavior: "deny", message: String(input) });

describe("sessionEnv", () => {
  it("prepends the extra folder to PATH", () => {
    assert.deepEqual(sessionEnv({ PATH: "/usr/bin", HOME: "/h" }, "/nvm/bin"), { PATH: "/nvm/bin:/usr/bin", HOME: "/h" });
  });

  it("leaves PATH alone when the extra folder is empty", () => {
    assert.deepEqual(sessionEnv({ PATH: "/usr/bin" }, ""), { PATH: "/usr/bin" });
  });

  it("sets PATH to the extra folder when the process has none", () => {
    assert.deepEqual(sessionEnv({}, "/nvm/bin"), { PATH: "/nvm/bin" });
  });
});

const deps = (turn: (request: TurnRequest) => TurnResult, nodeVersion: CheckDeps["nodeVersion"] = async () => "v24.15.0") => {
  const requests: TurnRequest[] = [];
  const value: CheckDeps = {
    runTurn: async (request) => {
      requests.push(request);
      return turn(request);
    },
    nodeVersion,
    models,
    cwd: "/repo",
    env: { PATH: "/bin" },
    canUseTool,
  };
  return { value, requests };
};

const ok = (request: TurnRequest): TurnResult => ({ ok: true, sessionId: `sess-${request.model}`, model: request.model, resultText: "OK" });

describe("checkEnvironment", () => {
  it("passes every check when sessions, the model switch and node all work", async () => {
    const { value, requests } = deps(ok);
    const results = await checkEnvironment(value);
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ["strong tier", true],
      ["medium tier", true],
      ["weak tier", true],
      ["model switch on resume", true],
      ["node on PATH", true],
    ]);
    assert.equal(results[0]!.detail, "session ran m-strong, m-skills loaded");
    assert.equal(results[3]!.detail, "strong session resumed on m-weak");
    assert.equal(results[4]!.detail, "v24.15.0");
    assert.equal(requests.length, 4);
  });

  it("resumes the strong-tier session on the weak model", async () => {
    const { value, requests } = deps(ok);
    await checkEnvironment(value);
    const resumed = requests[3]!;
    assert.equal(resumed.resume, "sess-m-strong");
    assert.equal(resumed.model, "m-weak");
    assert.equal(requests[0]!.resume, undefined);
  });

  it("asks each tier for one tool-free turn in the given working directory and env", async () => {
    const { value, requests } = deps(ok);
    await checkEnvironment(value);
    for (const request of requests) {
      assert.equal(request.maxTurns, 1);
      assert.equal(request.cwd, "/repo");
      assert.deepEqual(request.env, { PATH: "/bin" });
      assert.equal(request.canUseTool, canUseTool);
      assert.match(request.prompt, /Do not use any tools/);
    }
  });

  it("names the failing tier and its setting, and skips the switch check when strong fails", async () => {
    const { value, requests } = deps((request) => (request.model === "m-strong" ? { ok: false, error: "model_not_found" } : ok(request)));
    const results = await checkEnvironment(value);
    assert.equal(results[0]!.ok, false);
    assert.match(results[0]!.detail, /m-strong: model_not_found Fix: coordiner\.models\.strong\./);
    assert.deepEqual(results[3], { name: "model switch on resume", ok: false, detail: "not run: the strong-tier session did not start." });
    assert.equal(requests.length, 3);
  });

  it("reports a failed model switch as a re-plan point", async () => {
    const { value } = deps((request) => (request.resume ? { ok: false, error: "the session runs m-strong, not the requested m-weak." } : ok(request)));
    const switchCheck = (await checkEnvironment(value))[3]!;
    assert.equal(switchCheck.ok, false);
    assert.match(switchCheck.detail, /stop and re-plan/);
  });

  it("points at coordiner.extraPath when node is missing", async () => {
    const { value } = deps(ok, async () => {
      throw new Error("ENOENT");
    });
    const nodeCheck = (await checkEnvironment(value)).at(-1)!;
    assert.equal(nodeCheck.ok, false);
    assert.match(nodeCheck.detail, /coordiner\.extraPath/);
  });
});
