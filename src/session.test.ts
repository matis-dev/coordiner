import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool, HookInput, ModelInfo, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { listCommands, REQUIRED_COMMANDS, runTurn, type ListQueryFn, type QueryFn, type TaskMessage, type TurnControl } from "./session.ts";

// Fixtures carry only the fields runTurn reads; the full SDK message types are far larger.
const msg = (m: object) => m as unknown as SDKMessage;

const init = (overrides: object = {}) =>
  msg({ type: "system", subtype: "init", session_id: "sess-1", model: "model-a", slash_commands: [...REQUIRED_COMMANDS], plugin_errors: undefined, ...overrides });
const success = (text = "done") => msg({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", result: text });

const canUseTool: CanUseTool = async (_name, input) => ({ behavior: "allow", updatedInput: input });
const base = { prompt: "go", cwd: "/repo", model: "model-a", env: { PATH: "/bin" }, canUseTool, requiredCommands: REQUIRED_COMMANDS };
const pushCall = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: ["git", "push"].join(" ") } } as unknown as HookInput;
const decision = (out: object) => (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

// The text of each message the turn's prompt stream sent, read once the turn has closed it.
async function texts(prompt: AsyncIterable<SDKUserMessage> | undefined): Promise<string[]> {
  const sent: string[] = [];
  for await (const m of prompt!) sent.push(m.message.content as string);
  return sent;
}

const fakeQuery = (body: (options: Options) => AsyncGenerator<SDKMessage>) => {
  const seen: { prompt?: AsyncIterable<SDKUserMessage>; options?: Options; stopped: string[] } = { stopped: [] };
  const query: QueryFn = ({ prompt, options }) => {
    seen.prompt = prompt;
    seen.options = options;
    return Object.assign(body(options), { stopTask: async (taskId: string) => void seen.stopped.push(taskId) });
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
    assert.deepEqual(result, { ok: true, sessionId: "sess-1", model: "model-a", resultText: "plan ready", commands: [...REQUIRED_COMMANDS] });
    assert.deepEqual(await texts(seen.prompt), ["go"]);
  });

  it("passes on the conversation's own assistant messages as they arrive, not a subagent's", async () => {
    const own = msg({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } });
    const sub = msg({ type: "assistant", parent_tool_use_id: "tool-1", message: { content: [{ type: "text", text: "inner" }] } });
    const seen: SDKMessage[] = [];
    const { query } = fakeQuery(async function* () {
      yield init();
      yield own;
      yield sub;
      yield success();
    });
    assert.equal((await runTurn({ ...base, query, onMessage: (m) => void seen.push(m) })).ok, true);
    assert.deepEqual(seen, [own]);
  });

  it("passes the effort when one is set, and leaves the model's default otherwise", async () => {
    const { query, seen } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    await runTurn({ ...base, effort: "high", query });
    assert.equal(seen.options!.effort, "high");
    await runTurn({ ...base, query });
    assert.equal(Object.hasOwn(seen.options!, "effort"), false);
  });

  it("hands out a stopTask that reaches the running session", async () => {
    let control: TurnControl | undefined;
    const { query, seen } = fakeQuery(async function* () {
      yield init();
      await control!.stopTask("task-7");
      yield success();
    });
    assert.equal((await runTurn({ ...base, query, onStarted: (c) => (control = c) })).ok, true);
    assert.deepEqual(seen.stopped, ["task-7"]);
  });

  describe("a message injected into the running turn", () => {
    const reporting = () => init({ capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"] });
    const lifecycle = (uuid: unknown, state: unknown) => msg({ type: "command_lifecycle", command_uuid: uuid, state });
    // The fake pulls the prompt stream as the SDK does, waiting on it before the message is pushed, to learn the uuid it was sent with.
    const injectInto = async (prompt: AsyncIterable<SDKUserMessage> | undefined, control: TurnControl, text: string) => {
      const stream = prompt![Symbol.asyncIterator]();
      await stream.next();
      const next = stream.next();
      assert.equal(control.inject(text), true);
      return (await next).value as SDKUserMessage;
    };

    it("goes into the prompt stream with priority now, and the result of its own turn is the one returned", async () => {
      let control: TurnControl | undefined;
      let injected: SDKUserMessage | undefined;
      const { query, seen } = fakeQuery(async function* () {
        yield reporting();
        injected = await injectInto(seen.prompt, control!, "use the helper");
        // The turn it went into ends early with an empty result; the message's own turn follows.
        yield success("");
        yield lifecycle(injected.uuid, "queued");
        // A malformed frame is ignored; another command the CLI starts first holds back its own result too.
        yield lifecycle(42, "started");
        yield lifecycle("other-command", "started");
        yield success("");
        yield lifecycle(injected.uuid, "started");
        yield success("final");
      });
      const result = await runTurn({ ...base, query, onStarted: (c) => (control = c) });
      assert.deepEqual(result.ok && result.resultText, "final");
      assert.equal(injected!.message.content, "use the helper");
      assert.equal(injected!.priority, "now");
      assert.match(injected!.uuid!, /^[0-9a-f-]{36}$/);
      assert.equal(control!.inject("too late"), false, "the turn has ended");
      assert.deepEqual(await texts(seen.prompt), [], "the stream is closed");
    });

    it("is refused before the session starts and by a session that does not report what becomes of a message", async () => {
      let control: TurnControl | undefined;
      const refused: boolean[] = [];
      const { query } = fakeQuery(async function* () {
        refused.push(control!.inject("early"));
        yield init({ capabilities: ["interrupt_receipt_v1"] });
        refused.push(control!.inject("unreported"));
        yield success();
      });
      assert.equal((await runTurn({ ...base, query, onStarted: (c) => (control = c) })).ok, true);
      assert.deepEqual(refused, [false, false]);
    });

    it("holds back one result per message, so two messages each get their turn", async () => {
      let control: TurnControl | undefined;
      const { query, seen } = fakeQuery(async function* () {
        yield reporting();
        const first = await injectInto(seen.prompt, control!, "one");
        assert.equal(control!.inject("two"), true);
        const second = (await seen.prompt![Symbol.asyncIterator]().next()).value as SDKUserMessage;
        yield success("");
        yield lifecycle(first.uuid, "started");
        yield success("answer to one");
        yield lifecycle(second.uuid, "started");
        yield success("answer to two");
      });
      const result = await runTurn({ ...base, query, onStarted: (c) => (control = c) });
      assert.deepEqual(result.ok && result.resultText, "answer to two");
    });

    it("ends after the message's own turn when the session never reports what became of it, instead of waiting for ever", async () => {
      let control: TurnControl | undefined;
      const { query, seen } = fakeQuery(async function* () {
        yield reporting();
        await injectInto(seen.prompt, control!, "use the helper");
        yield success("");
        yield success("answer\nCOORDINER: DONE");
        yield success("never read");
      });
      const result = await runTurn({ ...base, query, onStarted: (c) => (control = c) });
      assert.deepEqual(result.ok && result.resultText, "answer\nCOORDINER: DONE");
    });

    it("no longer holds the turn open once cancelled", async () => {
      let control: TurnControl | undefined;
      const { query, seen } = fakeQuery(async function* () {
        yield reporting();
        const injected = await injectInto(seen.prompt, control!, "never mind");
        yield lifecycle(injected.uuid, "cancelled");
        yield success("first");
      });
      const result = await runTurn({ ...base, query, onStarted: (c) => (control = c) });
      assert.deepEqual(result.ok && result.resultText, "first");
    });

    it("does not hold back a failed result, and returns with it the message the turn never started", async () => {
      let control: TurnControl | undefined;
      const { query, seen } = fakeQuery(async function* () {
        yield reporting();
        await injectInto(seen.prompt, control!, "more");
        yield msg({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "sess-1" });
      });
      assert.deepEqual(await runTurn({ ...base, query, onStarted: (c) => (control = c) }), {
        ok: false,
        sessionId: "sess-1",
        error: "the session ended with error_during_execution.",
        undelivered: ["more"],
      });
    });

    it("returns only the messages not yet started when the turn is stopped", async () => {
      let control: TurnControl | undefined;
      const { query, seen } = fakeQuery(async function* () {
        yield reporting();
        const started = await injectInto(seen.prompt, control!, "ran");
        yield lifecycle(started.uuid, "started");
        assert.equal(control!.inject("waiting"), true);
        throw new Error("aborted by user");
      });
      const result = await runTurn({ ...base, query, onStarted: (c) => (control = c) });
      assert.deepEqual(!result.ok && result.undelivered, ["waiting"]);
    });
  });

  it("passes on task progress and the live set of background tasks, and nothing else", async () => {
    const progress = msg({ type: "system", subtype: "task_progress", task_id: "t1", description: "pnpm test", summary: "running" });
    const live = msg({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    const started = msg({ type: "system", subtype: "task_started", task_id: "t1", description: "pnpm test" });
    const told: TaskMessage[] = [];
    const { query } = fakeQuery(async function* () {
      yield init();
      yield started;
      yield progress;
      yield msg({ type: "assistant", parent_tool_use_id: null, message: { content: [] } });
      yield live;
      yield success();
    });
    await runTurn({ ...base, query, onTask: (m) => void told.push(m) });
    assert.deepEqual(told, [progress, live]);
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
    assert.equal(options.pathToClaudeCodeExecutable, undefined);
  });

  it("runs the given claude executable", async () => {
    const { query, seen } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    await runTurn({ ...base, claudePath: "/h/.local/bin/claude", query });
    assert.equal(seen.options!.pathToClaudeCodeExecutable, "/h/.local/bin/claude");
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

  it("refuses to work and aborts when a skill the chain needs is missing", async () => {
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

  it("works without m-skills when the chain needs none, and reports what the session offers", async () => {
    const { query } = fakeQuery(async function* () {
      yield init({ slash_commands: ["acme:lint"], plugin_errors: [{ plugin: "m-skills@m-skills", type: "x", message: "not relevant here" }] });
      yield success();
    });
    const result = await runTurn({ ...base, requiredCommands: ["acme:lint"], query });
    assert.deepEqual(result.ok && result.commands, ["acme:lint"]);
  });

  it("attaches coordiner's guard to Bash and reports its denials", async () => {
    const lines: string[] = [];
    const { query, seen } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    await runTurn({ ...base, onGuard: (l) => lines.push(l), query });
    const matchers = seen.options!.hooks!.PreToolUse!;
    assert.equal(matchers.length, 1);
    assert.equal(matchers[0]!.matcher, "Bash");
    assert.equal(decision(await matchers[0]!.hooks[0]!(pushCall, "t", { signal: new AbortController().signal })), "deny");
    assert.equal(lines.length, 1);
  });

  it("still denies through the guard when nobody listens for its reports", async () => {
    const { query, seen } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    await runTurn({ ...base, query });
    assert.equal(decision(await seen.options!.hooks!.PreToolUse![0]!.hooks[0]!(pushCall, "t", { signal: new AbortController().signal })), "deny");
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

  it("treats a success result flagged is_error as a failure and reports its text", async () => {
    const { query } = fakeQuery(async function* () {
      yield init();
      yield msg({ type: "result", subtype: "success", is_error: true, session_id: "sess-1", result: "API Error: 400 boom" });
    });
    assert.deepEqual(await runTurn({ ...base, query }), { ok: false, sessionId: "sess-1", error: "the session failed: API Error: 400 boom" });
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
    assert.deepEqual(await runTurn({ ...base, query }), { ok: true, sessionId: "sess-1", model: "model-a", resultText: "late", commands: [] });
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

describe("listCommands", () => {
  const fakeList = (answer: () => Promise<Array<{ name: string; description: string }>>, models: () => Promise<ModelInfo[]> = async () => []) => {
    const seen: { options?: Options; prompt?: AsyncIterable<unknown> } = {};
    const query: ListQueryFn = ({ prompt, options }) => {
      seen.options = options;
      seen.prompt = prompt;
      return { supportedCommands: async () => (await answer()) as Awaited<ReturnType<ReturnType<ListQueryFn>["supportedCommands"]>>, supportedModels: models };
    };
    return { query, seen };
  };
  const opus: ModelInfo = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "", supportedEffortLevels: ["low", "high"] };

  it("returns the command names and aborts the session afterwards", async () => {
    const { query, seen } = fakeList(async () => [{ name: "m-skills:planning-architect", description: "" }, { name: "acme:lint", description: "" }]);
    assert.deepEqual(await listCommands({ cwd: "/repo", env: { PATH: "/bin" }, query }), { ok: true, commands: ["m-skills:planning-architect", "acme:lint"], models: [] });
    assert.equal(seen.options!.abortController!.signal.aborted, true);
    assert.equal(seen.options!.cwd, "/repo");
    assert.deepEqual(seen.options!.settingSources, ["user", "project"]);
    assert.equal(seen.options!.model, undefined);
    assert.equal(seen.options!.pathToClaudeCodeExecutable, undefined);
  });

  it("runs the given claude executable", async () => {
    const { query, seen } = fakeList(async () => []);
    await listCommands({ cwd: "/repo", env: {}, claudePath: "/h/.local/bin/claude", query });
    assert.equal(seen.options!.pathToClaudeCodeExecutable, "/h/.local/bin/claude");
  });

  it("never sends a prompt, so no model turn runs", async () => {
    const { query, seen } = fakeList(async () => []);
    await listCommands({ cwd: "/repo", env: {}, query });
    const sent: unknown[] = [];
    for await (const message of seen.prompt!) sent.push(message);
    assert.deepEqual(sent, []);
  });

  it("reports an SDK error", async () => {
    const { query, seen } = fakeList(async () => {
      throw new Error("not signed in");
    });
    assert.deepEqual(await listCommands({ cwd: "/repo", env: {}, query }), { ok: false, error: "not signed in" });
    assert.equal(seen.options!.abortController!.signal.aborted, true);
  });

  it("reports a non-Error throw", async () => {
    const { query } = fakeList(async () => {
      throw "plain";
    });
    assert.deepEqual(await listCommands({ cwd: "/repo", env: {}, query }), { ok: false, error: "plain" });
  });

  it("returns the session's models from the same session", async () => {
    const { query } = fakeList(async () => [], async () => [opus]);
    assert.deepEqual(await listCommands({ cwd: "/repo", env: {}, query }), { ok: true, commands: [], models: [opus] });
  });

  it("still lists the skills when the models cannot be listed", async () => {
    const { query } = fakeList(
      async () => [{ name: "acme:lint", description: "" }],
      async () => {
        throw new Error("unsupported");
      },
    );
    assert.deepEqual(await listCommands({ cwd: "/repo", env: {}, query }), { ok: true, commands: ["acme:lint"], modelsError: "unsupported" });
  });

  it("still lists the skills when the models never come", async () => {
    const { query, seen } = fakeList(async () => [{ name: "acme:lint", description: "" }], () => new Promise(() => undefined));
    assert.deepEqual(await listCommands({ cwd: "/repo", env: {}, timeoutMs: 10, query }), { ok: true, commands: ["acme:lint"], modelsError: "no answer within 0.01 seconds" });
    assert.equal(seen.options!.abortController!.signal.aborted, true);
  });

  it("gives up when the session never answers", async () => {
    const { query, seen } = fakeList(() => new Promise(() => undefined));
    assert.deepEqual(await listCommands({ cwd: "/repo", env: {}, timeoutMs: 10, query }), { ok: false, error: "no answer within 0.01 seconds" });
    assert.equal(seen.options!.abortController!.signal.aborted, true);
  });
});
