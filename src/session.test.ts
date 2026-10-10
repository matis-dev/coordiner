import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { REQUIRED_COMMANDS, runTurn, type QueryFn } from "./session.ts";

// Fixtures carry only the fields runTurn reads; the full SDK message types are far larger.
const msg = (m: object) => m as unknown as SDKMessage;

const init = (overrides: object = {}) =>
  msg({ type: "system", subtype: "init", session_id: "sess-1", model: "model-a", slash_commands: [...REQUIRED_COMMANDS], plugin_errors: undefined, ...overrides });
const success = (text = "done") => msg({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", result: text });

const canUseTool: CanUseTool = async (_name, input) => ({ behavior: "allow", updatedInput: input });
const base = { prompt: "go", cwd: "/repo", model: "model-a", env: { PATH: "/bin" }, canUseTool };

const fakeQuery = (body: (options: Options) => AsyncGenerator<SDKMessage>) => {
  const seen: { prompt?: string; options?: Options } = {};
  const query: QueryFn = ({ prompt, options }) => {
    seen.prompt = prompt;
    seen.options = options;
    return body(options);
  };
  return { query, seen };
};

describe("runTurn", () => {
  it("returns the session id, reported model and result text on success", async () => {
    const { query, seen } = fakeQuery(async function* () {
      yield init();
      yield success("plan ready");
    });
    const result = await runTurn({ ...base, query });
    assert.deepEqual(result, { ok: true, sessionId: "sess-1", model: "model-a", resultText: "plan ready" });
    assert.equal(seen.prompt, "go");
  });

  it("configures the session: cwd, model, env, settings, auto mode, preset prompt", async () => {
    const { query, seen } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    await runTurn({ ...base, query });
    const options = seen.options!;
    assert.equal(options.cwd, "/repo");
    assert.equal(options.model, "model-a");
    assert.deepEqual(options.env, { PATH: "/bin" });
    assert.deepEqual(options.settingSources, ["user", "project"]);
    assert.equal(options.permissionMode, "auto");
    assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code" });
    assert.equal(options.canUseTool, canUseTool);
    assert.equal(options.resume, undefined);
    assert.equal(options.maxTurns, undefined);
  });

  it("passes resume, the prompt append and the turn cap when given", async () => {
    const { query, seen } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    await runTurn({ ...base, resume: "sess-0", systemPromptAppend: "be quiet", maxTurns: 1, query });
    assert.equal(seen.options!.resume, "sess-0");
    assert.equal(seen.options!.maxTurns, 1);
    assert.deepEqual(seen.options!.systemPrompt, { type: "preset", preset: "claude_code", append: "be quiet" });
  });

  it("refuses to work and aborts when an m-skills command is missing", async () => {
    let aborted = false;
    const { query } = fakeQuery(async function* (options) {
      options.abortController!.signal.addEventListener("abort", () => (aborted = true));
      yield init({ slash_commands: ["m-skills:rolling-history"] });
      assert.fail("the loop must stop after the init problem");
    });
    const result = await runTurn({ ...base, query });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /m-skills:planning-architect/);
    assert.equal(!result.ok && result.sessionId, "sess-1");
    assert.equal(aborted, true);
  });

  it("refuses when the m-skills plugin reports a load error", async () => {
    const { query } = fakeQuery(async function* () {
      yield init({ plugin_errors: [{ plugin: "m-skills@m-skills", type: "hook-load-failed", message: "bad hooks" }, { plugin: "other", type: "x", message: "ignored" }] });
    });
    const result = await runTurn({ ...base, query });
    assert.equal(result.ok, false);
    const error = !result.ok ? result.error : "";
    assert.match(error, /hook-load-failed \(bad hooks\)/);
    assert.doesNotMatch(error, /ignored/);
  });

  it("ignores plugin errors from other plugins", async () => {
    const { query } = fakeQuery(async function* () {
      yield init({ plugin_errors: [{ plugin: "other", type: "x", message: "irrelevant" }] });
      yield success();
    });
    assert.equal((await runTurn({ ...base, query })).ok, true);
  });

  it("refuses when the session runs a different model than requested", async () => {
    let aborted = false;
    const { query } = fakeQuery(async function* (options) {
      options.abortController!.signal.addEventListener("abort", () => (aborted = true));
      yield init({ model: "model-b" });
      assert.fail("the loop must stop after the model mismatch");
    });
    const result = await runTurn({ ...base, query });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /runs model-b, not the requested model-a/);
    assert.equal(aborted, true);
  });

  it("reports an error result with its subtype", async () => {
    const { query } = fakeQuery(async function* () {
      yield init();
      yield msg({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "sess-1" });
    });
    const result = await runTurn({ ...base, query });
    assert.deepEqual(result, { ok: false, sessionId: "sess-1", error: "the session ended with error_max_turns." });
  });

  it("treats a success result flagged is_error as a failure", async () => {
    const { query } = fakeQuery(async function* () {
      yield init();
      yield msg({ type: "result", subtype: "success", is_error: true, session_id: "sess-1", result: "boom" });
    });
    assert.equal((await runTurn({ ...base, query })).ok, false);
  });

  it("reports a stream that ends without a result", async () => {
    const { query } = fakeQuery(async function* () {
      yield init();
    });
    assert.deepEqual(await runTurn({ ...base, query }), { ok: false, sessionId: "sess-1", error: "the session ended without a result." });
  });

  it("reports a result when the stream sent no init message", async () => {
    const { query } = fakeQuery(async function* () {
      yield success("late");
    });
    assert.deepEqual(await runTurn({ ...base, query }), { ok: true, sessionId: "sess-1", model: "model-a", resultText: "late" });
  });

  it("catches an SDK throw and keeps the session id seen so far", async () => {
    const { query } = fakeQuery(async function* () {
      yield init();
      throw new Error("network down");
    });
    assert.deepEqual(await runTurn({ ...base, query }), { ok: false, sessionId: "sess-1", error: "the Claude Agent SDK raised: network down" });
  });

  it("catches a non-Error throw", async () => {
    const { query } = fakeQuery(async function* () {
      throw "plain text";
    });
    assert.deepEqual(await runTurn({ ...base, query }), { ok: false, sessionId: undefined, error: "the Claude Agent SDK raised: plain text" });
  });

  it("aborts the SDK session when the caller's signal aborts", async () => {
    const stop = new AbortController();
    let aborted = false;
    const { query } = fakeQuery(async function* (options) {
      options.abortController!.signal.addEventListener("abort", () => (aborted = true));
      stop.abort();
      yield init();
      yield success();
    });
    await runTurn({ ...base, signal: stop.signal, query });
    assert.equal(aborted, true);
  });
});
