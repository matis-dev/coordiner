import { query as sdkQuery, type CanUseTool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const REQUIRED_COMMANDS = [
  "m-skills:planning-architect",
  "m-skills:implementing-architect",
  "m-skills:code-review-architect-uncommitted",
  "m-skills:rolling-history",
];

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export type TurnResult =
  | { ok: true; sessionId: string; model: string; resultText: string }
  | { ok: false; sessionId?: string; error: string };

export type TurnRequest = {
  prompt: string;
  cwd: string;
  model: string;
  canUseTool: CanUseTool;
  env: Record<string, string | undefined>;
  resume?: string;
  systemPromptAppend?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  query?: QueryFn;
};

type InitMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>;

// Without the m-skills plugin there is no git-guard hook, so the session must not do any work.
export function pluginProblem(init: InitMessage): string | undefined {
  const missing = REQUIRED_COMMANDS.filter((command) => !init.slash_commands.includes(command));
  if (missing.length > 0) return `m-skills commands are not available in this session: ${missing.join(", ")}.`;
  const failed = (init.plugin_errors ?? []).filter((e) => e.plugin.startsWith("m-skills"));
  if (failed.length > 0) return `m-skills did not load cleanly: ${failed.map((e) => `${e.type} (${e.message})`).join("; ")}.`;
  return undefined;
}

// One turn = one SDK query. A later turn continues the same conversation through `resume`, optionally on another model.
export async function runTurn({ prompt, cwd, model, canUseTool, env, resume, systemPromptAppend, maxTurns, signal, query = sdkQuery }: TurnRequest): Promise<TurnResult> {
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
        ...(resume ? { resume } : {}),
        ...(maxTurns ? { maxTurns } : {}),
      },
    });
    let reportedModel = model;
    for await (const message of messages) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        reportedModel = message.model;
        const problem = pluginProblem(message);
        if (problem) {
          abortController.abort();
          return { ok: false, sessionId, error: problem };
        }
        if (message.model !== model) {
          abortController.abort();
          return { ok: false, sessionId, error: `the session runs ${message.model}, not the requested ${model}. Set a full model ID in the Coordiner settings.` };
        }
      }
      if (message.type === "result") {
        sessionId = message.session_id;
        // Returning here also avoids the throw query() raises after an error result.
        if (message.subtype === "success" && !message.is_error) return { ok: true, sessionId, model: reportedModel, resultText: message.result };
        return { ok: false, sessionId, error: `the session ended with ${message.subtype}.` };
      }
    }
    return { ok: false, sessionId, error: "the session ended without a result." };
  } catch (error) {
    return { ok: false, sessionId, error: `the Claude Agent SDK raised: ${error instanceof Error ? error.message : String(error)}` };
  }
}
