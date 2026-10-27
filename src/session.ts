import { randomUUID } from "node:crypto";
import {
  query as sdkQuery,
  type CanUseTool,
  type ModelInfo,
  type Options,
  type Query,
  type SDKAssistantMessage,
  type SDKBackgroundTasksChangedMessage,
  type SDKMessage,
  type SDKTaskProgressMessage,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "./chains.ts";
import { guardHook } from "./guard.ts";

// The m-skills commands the shipped templates use; all present means m-skills is installed.
export const REQUIRED_COMMANDS = [
  "m-skills:planning-architect",
  "m-skills:implementing-architect",
  "m-skills:code-review-architect-uncommitted",
  "m-skills:rolling-history",
];

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & Pick<Query, "stopTask">;
// What the Run view needs to list a turn's background processes: the live set, and each one's latest progress line.
export type TaskMessage = SDKTaskProgressMessage | SDKBackgroundTasksChangedMessage;
// `inject` writes a user message into the running turn: false when the turn cannot take one (its session does not report what
// becomes of a message, or the turn is ending), and the caller keeps the message for the next turn.
export type TurnControl = { stopTask(taskId: string): Promise<void>; inject(text: string): boolean };

export type TurnResult =
  | { ok: true; sessionId: string; model: string; resultText: string; commands: string[] }
  // `undelivered`: messages injected into the turn that it ended before starting, in the order they were sent.
  | { ok: false; sessionId?: string; error: string; undelivered?: string[] };

export type TurnRequest = {
  prompt: string;
  cwd: string;
  model: string;
  // Absent: the model's own default.
  effort?: Effort;
  // The slash commands this turn needs; the session refuses to work without them.
  requiredCommands: readonly string[];
  canUseTool: CanUseTool;
  env: Record<string, string | undefined>;
  // The installed Claude Code binary; the packaged extension does not ship the SDK's own.
  claudePath?: string;
  resume?: string;
  systemPromptAppend?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  // Told when coordiner's own guard denies a command.
  onGuard?: (line: string) => void;
  // Told each assistant message of the conversation itself, not of a subagent inside it, as it arrives.
  onMessage?: (message: SDKAssistantMessage) => void;
  // Told once the session exists, with what can act on it while the turn runs.
  onStarted?: (control: TurnControl) => void;
  onTask?: (message: TaskMessage) => void;
  query?: QueryFn;
};

type InitMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>;

const userMessage = (text: string): SDKUserMessage => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

// The turn's prompt as a stream: the first message, then whatever is pushed while the turn runs, until it is closed.
function promptStream(first: string) {
  const pending: SDKUserMessage[] = [];
  let closed = false;
  let wake = () => {};
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(first);
    for (;;) {
      while (pending.length > 0) yield pending.shift()!;
      if (closed) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    messages: messages(),
    closed: () => closed,
    push(message: SDKUserMessage) {
      pending.push(message);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
  };
}

// Observed against Claude Code 2.1.310 (CHANGELOG, 2026-10-27): a message pushed with priority "now" lets the running tool finish,
// ends the turn there with an empty result, and runs as the next turn of the same query, under the same hooks and canUseTool. The
// CLI reports what becomes of it in command_lifecycle frames (queued, started, completed, cancelled), keyed by the uuid it was sent
// with, when its init lists the msg_lifecycle_v1 capability. The SDK types neither, so both are read defensively.
const LIFECYCLE = "msg_lifecycle_v1";
const reportsLifecycle = (init: InitMessage): boolean => {
  const { capabilities } = init as { capabilities?: unknown };
  return Array.isArray(capabilities) && capabilities.includes(LIFECYCLE);
};
function lifecycleOf(message: SDKMessage): { uuid: string; state: string } | undefined {
  const m = message as { type: string; command_uuid?: unknown; state?: unknown };
  return m.type === "command_lifecycle" && typeof m.command_uuid === "string" && typeof m.state === "string" ? { uuid: m.command_uuid, state: m.state } : undefined;
}

export type ListQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => { supportedCommands(): Promise<SlashCommand[]>; supportedModels(): Promise<ModelInfo[]> };
// The models are a bonus: a session that lists its skills but not its models still lists its skills. Each error is the bare reason;
// the editor says what could not be listed.
export type CommandList = { ok: true; commands: string[]; models?: ModelInfo[]; modelsError?: string } | { ok: false; error: string };
export const LIST_TIMEOUT_MS = 60_000;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Lists the slash commands and models a session in `cwd` offers without running a model turn: the prompt stream never sends a message,
// the commands come from the session's initialize answer, and the session is aborted once they arrive.
export async function listCommands({ cwd, env, claudePath, timeoutMs = LIST_TIMEOUT_MS, query = sdkQuery as unknown as ListQueryFn }: { cwd: string; env: Record<string, string | undefined>; claudePath?: string; timeoutMs?: number; query?: ListQueryFn }): Promise<CommandList> {
  const abortController = new AbortController();
  // Registered now, not when the stream is first pulled, so a pull after the abort still ends.
  const aborted = new Promise<void>((resolve) => abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
  const silent = (async function* (): AsyncGenerator<SDKUserMessage> {
    await aborted;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} seconds`)), timeoutMs)));
  let result: CommandList;
  try {
    const session = query({ prompt: silent, options: { cwd, env, abortController, settingSources: ["user", "project"], ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}) } });
    const models = Promise.race([session.supportedModels(), timeout]).then(
      (list) => ({ models: list }),
      (error: unknown) => ({ modelsError: reason(error) }),
    );
    const [commands, listed] = await Promise.all([Promise.race([session.supportedCommands(), timeout]), models]);
    result = { ok: true, commands: commands.map((c) => c.name), ...listed };
  } catch (error) {
    result = { ok: false, error: reason(error) };
  }
  clearTimeout(timer);
  abortController.abort();
  return result;
}

// A skill the chain needs must exist in this session, and a chain built on m-skills needs m-skills to have loaded cleanly.
export function pluginProblem(init: InitMessage, required: readonly string[]): string | undefined {
  const missing = required.filter((command) => !init.slash_commands.includes(command));
  if (missing.length > 0) return `skills this chain needs are not available in this session: ${missing.join(", ")}.`;
  if (!required.some((command) => command.startsWith("m-skills:"))) return undefined;
  const failed = (init.plugin_errors ?? []).filter((e) => e.plugin.startsWith("m-skills"));
  if (failed.length > 0) return `m-skills did not load cleanly: ${failed.map((e) => `${e.type} (${e.message})`).join("; ")}.`;
  return undefined;
}

// One turn = one SDK query. A later turn continues the same conversation through `resume`, optionally on another model. The prompt
// stream is closed however the turn ends, so it never waits on a session that is gone.
export function runTurn(request: TurnRequest): Promise<TurnResult> {
  const input = promptStream(request.prompt);
  return turnOn(input, request).finally(input.close);
}

async function turnOn(input: ReturnType<typeof promptStream>, { cwd, model, effort, requiredCommands, canUseTool, env, claudePath, resume, systemPromptAppend, maxTurns, signal, onGuard = () => undefined, onMessage, onStarted, onTask, query = sdkQuery }: TurnRequest): Promise<TurnResult> {
  const abortController = new AbortController();
  signal?.addEventListener("abort", () => abortController.abort(), { once: true });
  let sessionId: string | undefined;
  // Messages injected and not yet started by the session, by uuid: while one is left, a result may not be the turn's last.
  const unstarted = new Map<string, string>();
  // A result is held back only when something accounts for it: the early end each injected message causes, or another command the
  // CLI reported starting. A CLI that stops sending lifecycle frames then ends the turn after the message's own turn, not never.
  let owed = 0;
  let injectable = false;
  const failed = (error: string): TurnResult => ({ ok: false, sessionId, error, ...(unstarted.size > 0 ? { undelivered: [...unstarted.values()] } : {}) });
  try {
    const messages = query({
      prompt: input.messages,
      options: {
        cwd,
        model,
        env,
        abortController,
        settingSources: ["user", "project"],
        permissionMode: "auto",
        systemPrompt: { type: "preset", preset: "claude_code", ...(systemPromptAppend ? { append: systemPromptAppend } : {}) },
        canUseTool,
        // coordiner's own guard: no git writes or GitHub publishing, whichever skills the chain uses.
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [guardHook(onGuard)] }] },
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        ...(effort ? { effort } : {}),
        ...(resume ? { resume } : {}),
        ...(maxTurns ? { maxTurns } : {}),
      },
    });
    onStarted?.({
      stopTask: (taskId) => messages.stopTask(taskId),
      inject: (text) => {
        if (!injectable || input.closed()) return false;
        const uuid = randomUUID();
        unstarted.set(uuid, text);
        owed += 1;
        input.push({ ...userMessage(text), priority: "now", uuid });
        return true;
      },
    });
    let reportedModel = model;
    let commands: string[] = [];
    for await (const message of messages) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        reportedModel = message.model;
        commands = message.slash_commands;
        injectable = reportsLifecycle(message);
        const problem = pluginProblem(message, requiredCommands);
        if (problem) {
          abortController.abort();
          return { ok: false, sessionId, error: problem };
        }
        if (message.model !== model) {
          abortController.abort();
          return { ok: false, sessionId, error: `the session runs ${message.model}, not the requested ${model}. Set a full model ID in the Coordiner settings.` };
        }
      }
      if (message.type === "assistant" && message.parent_tool_use_id === null) onMessage?.(message);
      if (message.type === "system" && (message.subtype === "task_progress" || message.subtype === "background_tasks_changed")) onTask?.(message);
      const lifecycle = lifecycleOf(message);
      if (lifecycle?.state === "started" && !unstarted.has(lifecycle.uuid)) owed += 1;
      if (lifecycle && lifecycle.state !== "queued") unstarted.delete(lifecycle.uuid);
      if (message.type === "result") {
        sessionId = message.session_id;
        // The turn a message was injected into ends early; the message's own turn follows, and its result is the one returned. The
        // latest reply's status line is the one that counts, since the message may have changed where the chain goes.
        if (message.subtype === "success" && !message.is_error && unstarted.size > 0 && owed > 0) {
          owed -= 1;
          continue;
        }
        // Closed now, not in finally: returning first waits on the SDK, and a message injected meanwhile would be taken and never run.
        input.close();
        // Returning here also avoids the throw query() raises after an error result.
        if (message.subtype === "success" && !message.is_error) return { ok: true, sessionId, model: reportedModel, resultText: message.result, commands };
        // A "success" flagged is_error carries the reason (an API error, an outdated claude) in its result text.
        if (message.subtype === "success" && message.result) return failed(`the session failed: ${message.result}`);
        return failed(`the session ended with ${message.subtype}.`);
      }
    }
    return failed("the session ended without a result.");
  } catch (error) {
    return failed(`the Claude Agent SDK raised: ${reason(error)}`);
  }
}
