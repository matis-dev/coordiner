import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { checkEnvironment, findClaude, sessionEnv, type CheckDeps, type Models } from "./environment.ts";
import { REQUIRED_COMMANDS, type TurnRequest, type TurnResult } from "./session.ts";

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

describe("findClaude", () => {
  const only = (...paths: string[]) => async (path: string) => paths.includes(path);

  it("uses the configured path when it is executable", async () => {
    assert.deepEqual(await findClaude("/opt/claude", { PATH: "/usr/bin" }, "/h", only("/opt/claude", "/usr/bin/claude")), { ok: true, path: "/opt/claude" });
  });

  it("does not fall back when the configured path is not executable, and says the setting is wrong", async () => {
    assert.deepEqual(await findClaude("/opt/claude", { PATH: "/usr/bin" }, "/h", only("/usr/bin/claude")), {
      ok: false,
      error: "coordiner.claudePath is /opt/claude, which is not an executable file. Fix: set coordiner.claudePath to the full path of claude.",
    });
  });

  it("finds claude on PATH, first folder first", async () => {
    assert.deepEqual(await findClaude("", { PATH: "/a:/b" }, "/h", only("/a/claude", "/b/claude")), { ok: true, path: "/a/claude" });
    assert.deepEqual(await findClaude("", { PATH: "/a:/b" }, "/h", only("/b/claude")), { ok: true, path: "/b/claude" });
  });

  it("falls back to the native installer's ~/.local/bin, which a flatpak editor's PATH lacks", async () => {
    assert.deepEqual(await findClaude("", { PATH: "/usr/bin" }, "/h", only("/h/.local/bin/claude")), { ok: true, path: "/h/.local/bin/claude" });
    assert.deepEqual(await findClaude("", {}, "/h", only("/h/.local/bin/claude")), { ok: true, path: "/h/.local/bin/claude" });
  });

  it("names the places searched and the setting when claude is nowhere", async () => {
    assert.deepEqual(await findClaude("", { PATH: "/usr/bin" }, "/h", only()), {
      ok: false,
      error: "Claude Code was not found on PATH or in ~/.local/bin. Fix: coordiner.claudePath (the full path to claude).",
    });
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
    claude: { ok: true, path: "/h/.local/bin/claude" },
    models,
    cwd: "/repo",
    env: { PATH: "/bin" },
    canUseTool,
  };
  return { value, requests };
};

const ok = (request: TurnRequest): TurnResult => ({ ok: true, sessionId: `sess-${request.model}`, model: request.model, resultText: "OK", commands: [...REQUIRED_COMMANDS] });

describe("checkEnvironment", () => {
  it("passes every check when sessions, the model switch and node all work", async () => {
    const { value, requests } = deps(ok);
    const results = await checkEnvironment(value);
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ["claude executable", true],
      ["strong tier", true],
      ["medium tier", true],
      ["weak tier", true],
      ["m-skills", true],
      ["model switch on resume", true],
      ["node on PATH", true],
    ]);
    assert.equal(results[0]!.detail, "/h/.local/bin/claude");
    assert.equal(results[1]!.detail, "session ran m-strong");
    assert.equal(results[4]!.detail, "installed");
    assert.equal(results[5]!.detail, "strong session resumed on m-weak");
    assert.equal(results[6]!.detail, "v24.15.0");
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
      assert.equal(request.claudePath, "/h/.local/bin/claude");
      assert.equal(request.canUseTool, canUseTool);
      assert.match(request.prompt, /Do not use any tools/);
    }
  });

  it("names the failing tier and its setting, and skips the switch check when strong fails", async () => {
    const { value, requests } = deps((request) => (request.model === "m-strong" ? { ok: false, error: "model_not_found" } : ok(request)));
    const results = await checkEnvironment(value);
    assert.equal(results[1]!.ok, false);
    assert.match(results[1]!.detail, /m-strong: model_not_found Fix: coordiner\.models\.strong\./);
    assert.equal(results.some((r) => r.name === "m-skills"), false);
    assert.deepEqual(results[4], { name: "model switch on resume", ok: false, detail: "not run: the strong-tier session did not start." });
    assert.equal(requests.length, 3);
  });

  it("reports a failed model switch as a re-plan point", async () => {
    const { value } = deps((request) => (request.resume ? { ok: false, error: "the session runs m-strong, not the requested m-weak." } : ok(request)));
    const switchCheck = (await checkEnvironment(value)).find((r) => r.name === "model switch on resume")!;
    assert.equal(switchCheck.ok, false);
    assert.match(switchCheck.detail, /stop and re-plan/);
  });

  it("asks no tier for any command, so a missing m-skills cannot fail the tiers", async () => {
    const { value, requests } = deps(ok);
    await checkEnvironment(value);
    assert.ok(requests.every((r) => r.requiredCommands.length === 0));
  });

  it("reports a missing m-skills as information with the link, not as a failure", async () => {
    const { value } = deps((request) => ({ ...(ok(request) as Extract<TurnResult, { ok: true }>), commands: ["acme:lint"] }));
    const row = (await checkEnvironment(value)).find((r) => r.name === "m-skills")!;
    assert.equal(row.ok, true);
    assert.match(row.detail, /not installed.*github\.com\/matis-dev\/m-skills/);
  });

  it("points at coordiner.extraPath when node is missing", async () => {
    const { value } = deps(ok, async () => {
      throw new Error("ENOENT");
    });
    const nodeCheck = (await checkEnvironment(value)).at(-1)!;
    assert.equal(nodeCheck.ok, false);
    assert.match(nodeCheck.detail, /coordiner\.extraPath/);
  });

  it("runs no session without a claude executable and leads with the lookup's fix", async () => {
    const { value, requests } = deps(ok);
    value.claude = { ok: false, error: "Claude Code was not found. Fix: coordiner.claudePath." };
    const results = await checkEnvironment(value);
    assert.equal(requests.length, 0);
    assert.deepEqual(results.slice(0, 5), [
      { name: "claude executable", ok: false, detail: "Claude Code was not found. Fix: coordiner.claudePath." },
      { name: "strong tier", ok: false, detail: "not run: no claude executable." },
      { name: "medium tier", ok: false, detail: "not run: no claude executable." },
      { name: "weak tier", ok: false, detail: "not run: no claude executable." },
      { name: "model switch on resume", ok: false, detail: "not run: no claude executable." },
    ]);
    assert.deepEqual(results.at(-1), { name: "node on PATH", ok: true, detail: "v24.15.0" });
  });
});
