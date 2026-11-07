import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { bundledClaudePath, checkEnvironment, findClaude, sessionEnv, type CheckDeps } from "./environment.ts";
import { REQUIRED_COMMANDS, type TurnRequest, type TurnResult } from "./session.ts";

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

describe("bundledClaudePath", () => {
  it("points at the native binary inside the Claude Code extension's folder", () => {
    assert.equal(bundledClaudePath("/ext/anthropic.claude-code-2.1.306", "linux"), "/ext/anthropic.claude-code-2.1.306/resources/native-binary/claude");
  });

  it("names the Windows binary claude.exe", () => {
    assert.equal(bundledClaudePath("/ext", "win32"), "/ext/resources/native-binary/claude.exe");
  });

  it("has no path when the Claude Code extension is not installed", () => {
    assert.equal(bundledClaudePath(undefined, "linux"), undefined);
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

  it("falls back to the Claude Code extension's bundled binary last, as when a ~/.local/bin link dangles after an update", async () => {
    const bundled = "/ext/anthropic.claude-code-2.1.306/resources/native-binary/claude";
    assert.deepEqual(await findClaude("", { PATH: "/usr/bin" }, "/h", only(bundled), bundled), { ok: true, path: bundled });
    assert.deepEqual(await findClaude("", { PATH: "/usr/bin" }, "/h", only("/h/.local/bin/claude", bundled), bundled), { ok: true, path: "/h/.local/bin/claude" });
  });

  it("does not use the bundled binary over a configured path that is not executable", async () => {
    const bundled = "/ext/claude";
    assert.equal((await findClaude("/opt/claude", {}, "/h", only(bundled), bundled)).ok, false);
  });

  it("names the places searched and the setting when claude is nowhere", async () => {
    assert.deepEqual(await findClaude("", { PATH: "/usr/bin" }, "/h", only(), "/ext/claude"), {
      ok: false,
      error: "Claude Code was not found on PATH, in ~/.local/bin, or in the Claude Code extension. Fix: install Claude Code, or set coordiner.claudePath to the full path of claude.",
    });
  });
});

const OFFERED = [
  { id: "m-default", label: "Default", efforts: [] },
  { id: "m-other", label: "Other", efforts: [] },
];
type Listed = Awaited<ReturnType<CheckDeps["listModels"]>>;

const deps = (turn: (request: TurnRequest) => TurnResult, nodeVersion: CheckDeps["nodeVersion"] = async () => "v24.15.0", listed: Listed = { ok: true, options: OFFERED, defaultModel: "m-default" }) => {
  const requests: TurnRequest[] = [];
  const value: CheckDeps = {
    runTurn: async (request) => {
      requests.push(request);
      return turn(request);
    },
    nodeVersion,
    claude: { ok: true, path: "/h/.local/bin/claude" },
    listModels: async () => listed,
    cwd: "/repo",
    env: { PATH: "/bin" },
    canUseTool,
  };
  return { value, requests };
};

// A turn that asks for no model runs on the session's default, m-default.
const ok = (request: TurnRequest): TurnResult => ({ ok: true, sessionId: `sess-${request.model ?? "m-default"}`, model: request.model ?? "m-default", resultText: "OK", commands: [...REQUIRED_COMMANDS] });

describe("checkEnvironment", () => {
  it("passes every check when the session, its models, the model switch and node all work", async () => {
    const { value, requests } = deps(ok);
    const results = await checkEnvironment(value);
    assert.deepEqual(results, [
      { name: "claude executable", ok: true, detail: "/h/.local/bin/claude" },
      { name: "default model", ok: true, detail: "session ran m-default" },
      { name: "models", ok: true, detail: "Default, Other" },
      { name: "m-skills", ok: true, detail: "installed" },
      { name: "model switch on resume", ok: true, detail: "resumed on m-other" },
      { name: "node on PATH", ok: true, detail: "v24.15.0" },
    ]);
    assert.equal(requests.length, 2);
  });

  it("asks for no model first, then resumes that session on another listed model", async () => {
    const { value, requests } = deps(ok);
    await checkEnvironment(value);
    assert.equal(Object.hasOwn(requests[0]!, "model"), false);
    assert.equal(requests[0]!.resume, undefined);
    assert.deepEqual([requests[1]!.model, requests[1]!.resume], ["m-other", "sess-m-default"]);
  });

  it("asks for one tool-free turn each time, in the given working directory and env", async () => {
    const { value, requests } = deps(ok);
    await checkEnvironment(value);
    for (const request of requests) {
      assert.equal(request.maxTurns, 1);
      assert.equal(request.cwd, "/repo");
      assert.deepEqual(request.env, { PATH: "/bin" });
      assert.equal(request.claudePath, "/h/.local/bin/claude");
      assert.equal(request.canUseTool, canUseTool);
      assert.match(request.prompt.text, /Do not use any tools/);
    }
  });

  it("says why the first session failed, and skips the m-skills row and the switch", async () => {
    const { value, requests } = deps(() => ({ ok: false, error: "not logged in." }));
    const results = await checkEnvironment(value);
    assert.deepEqual(results[1], { name: "default model", ok: false, detail: "not logged in. Fix: run claude in a terminal and check it signs in." });
    assert.equal(results.some((r) => r.name === "m-skills"), false);
    assert.deepEqual(results.find((r) => r.name === "model switch on resume"), { name: "model switch on resume", ok: false, detail: "not run: the first session did not start." });
    assert.equal(requests.length, 1);
  });

  it("reports models that could not be listed, and does not try a switch without a second model", async () => {
    const { value, requests } = deps(ok, undefined, { ok: false, error: "the session did not list its models: timeout." });
    const results = await checkEnvironment(value);
    assert.deepEqual(results.find((r) => r.name === "models"), { name: "models", ok: false, detail: "the session did not list its models: timeout. Cards then run on the default model, unchecked." });
    assert.deepEqual(results.find((r) => r.name === "model switch on resume"), { name: "model switch on resume", ok: true, detail: "not run: the session offers no second model to switch to." });
    assert.equal(requests.length, 1);
  });

  it("says so when the session lists no models at all", async () => {
    const { value } = deps(ok, undefined, { ok: true, options: [] });
    assert.deepEqual((await checkEnvironment(value)).find((r) => r.name === "models"), { name: "models", ok: true, detail: "none listed; cards run on the default model" });
  });

  it("reports a failed model switch, saying what it stops", async () => {
    const { value } = deps((request) => (request.resume ? { ok: false, error: "the session runs m-default, not the requested m-other." } : ok(request)));
    const switchCheck = (await checkEnvironment(value)).find((r) => r.name === "model switch on resume")!;
    assert.equal(switchCheck.ok, false);
    assert.match(switchCheck.detail, /suggested model cannot take over its session/);
  });

  it("asks for no command, so a missing m-skills cannot fail a check", async () => {
    const { value, requests } = deps(ok);
    await checkEnvironment(value);
    assert.ok(requests.every((r) => r.requiredCommands.length === 0));
  });

  it("reports a missing m-skills as a suggestion with the link, not as a failure", async () => {
    const { value } = deps((request) => ({ ...(ok(request) as Extract<TurnResult, { ok: true }>), commands: ["acme:lint"] }));
    const row = (await checkEnvironment(value)).find((r) => r.name === "m-skills")!;
    assert.equal(row.ok, true);
    assert.match(row.detail, /not installed\. With it you get the starter chains.*github\.com\/matis-dev\/m-skills/);
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
    assert.deepEqual(results.slice(0, 4), [
      { name: "claude executable", ok: false, detail: "Claude Code was not found. Fix: coordiner.claudePath." },
      { name: "default model", ok: false, detail: "not run: no claude executable." },
      { name: "models", ok: false, detail: "not run: no claude executable." },
      { name: "model switch on resume", ok: false, detail: "not run: no claude executable." },
    ]);
    assert.deepEqual(results.at(-1), { name: "node on PATH", ok: true, detail: "v24.15.0" });
  });
});
