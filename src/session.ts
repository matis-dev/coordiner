import { query as sdkQuery, type CanUseTool, type Options, type SDKAssistantMessage, type SDKMessage, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { guardHook } from "./guard.ts";

// The m-skills commands the shipped templates use; all present means m-skills is installed.
export const REQUIRED_COMMANDS = [
  "m-skills:planning-architect",
  "m-skills:implementing-architect",
  "m-skills:code-review-architect-uncommitted",
  "m-skills:rolling-history",
];

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export type TurnResult =
  | { ok: true; sessionId: string; model: string; resultText: string; commands: string[] }
  | { ok: false; sessionId?: string; error: string };

export type TurnRequest = {
  prompt: string;
  cwd: string;
  model: string;
  // The slash commands this turn needs; the session refuses to work without them.
  requiredCommands: readonly string[];
  canUseTool: CanUseTool;
  env: Record<string, string | undefined>;
  resume?: string;
  systemPromptAppend?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  // Told when coordiner's own guard denies a command.
  onGuard?: (line: string) => void;
  // Told each assistant message of the conversation itself, not of a subagent inside it, as it arrives.
  onMessage?: (message: SDKAssistantMessage) => void;
  query?: QueryFn;
};

type InitMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>;

export type ListQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => { supportedCommands(): Promise<SlashCommand[]> };
export type CommandList = { ok: true; commands: string[] } | { ok: false; error: string };
export const LIST_TIMEOUT_MS = 60_000;

// Lists the slash commands a session in `cwd` offers without running a model turn: the prompt stream never sends a message,
// the commands come from the session's initialize answer, and the session is aborted once they arrive.
export async function listCommands({ cwd, env, timeoutMs = LIST_TIMEOUT_MS, query = sdkQuery as unknown as ListQueryFn }: { cwd: string; env: Record<string, string | undefined>; timeoutMs?: number; query?: ListQueryFn }): Promise<CommandList> {
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
    const session = query({ prompt: silent, options: { cwd, env, abortController, settingSources: ["user", "project"] } });
    const commands = await Promise.race([session.supportedCommands(), timeout]);
    result = { ok: true, commands: commands.map((c) => c.name) };
  } catch (error) {
    result = { ok: false, error: `the skills could not be listed: ${error instanceof Error ? error.message : String(error)}` };
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

// One turn = one SDK query. A later turn continues the same conversation through `resume`, optionally on another model.
export async function runTurn({ prompt, cwd, model, requiredCommands, canUseTool, env, resume, systemPromptAppend, maxTurns, signal, onGuard = () => undefined, onMessage, query = sdkQuery }: TurnRequest): Promise<TurnResult> {
  const abortController = new AbortController();
  signal?.addEventListener("abort", () => abortController.abort(), { once: true });
  let sessionId: string | undefined;
  try {
    const messages = query({
      prompt,
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
        ...(resume ? { resume } : {}),
        ...(maxTurns ? { maxTurns } : {}),
      },
    });
    let reportedModel = model;
    let commands: string[] = [];
    for await (const message of messages) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        reportedModel = message.model;
        commands = message.slash_commands;
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
      if (message.type === "result") {
        sessionId = message.session_id;
        // Returning here also avoids the throw query() raises after an error result.
        if (message.subtype === "success" && !message.is_error) return { ok: true, sessionId, model: reportedModel, resultText: message.result, commands };
        return { ok: false, sessionId, error: `the session ended with ${message.subtype}.` };
      }
    }
    return { ok: false, sessionId, error: "the session ended without a result." };
  } catch (error) {
    return { ok: false, sessionId, error: `the Claude Agent SDK raised: ${error instanceof Error ? error.message : String(error)}` };
  }
}
