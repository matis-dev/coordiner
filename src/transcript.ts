import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_ENTRIES } from "./chat-logic.ts";
import type { Outcome } from "./run.ts";
import { clip, plain } from "./text.ts";
import type { DecidedAfter } from "./unattended.ts";

// What the run's chat shows. Model text reaches it only through plain(), and the webview sets it with textContent.
export type Entry =
  | { kind: "assistant"; card: string; text: string }
  | { kind: "tool"; card: string; name: string; input: string }
  | { kind: "you"; card: string; text: string }
  | { kind: "answer"; card: string; question: string; answer: string }
  // A question answered with its Recommended option without the user.
  | { kind: "decided"; card: string; question: string; answer: string; after: DecidedAfter }
  | { kind: "divider"; session: number }
  | { kind: "end"; status: Outcome["status"]; reason?: string }
  // A turn of the chat after the run that failed; the chat stays open.
  | { kind: "failed"; card: string; error: string }
  | { kind: "dropped" };

// A tool's input scrolls in a small box on the page, so it can be longer than one line has room for.
export const MAX_TOOL_INPUT = 2000;

// The fields that say what a call does, by tool; the rest of its input is left out.
const TELLING: Record<string, readonly string[]> = {
  Bash: ["command"],
  BashOutput: ["bash_id"],
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path", "glob"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Skill: ["skill", "args"],
  Agent: ["description"],
  Task: ["description"],
  KillShell: ["shell_id"],
};

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "");

// A tool call's input as a person reads it: the command, the file, the question; otherwise one `key: value` line per field.
export function toolInput(name: string, input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input === undefined ? "" : asText(input);
  const fields = input as Record<string, unknown>;
  if (name === "AskUserQuestion" && Array.isArray(fields.questions)) {
    return fields.questions.map((q) => asText((q as { question?: unknown } | null)?.question ?? q)).join("\n");
  }
  if (name === "TodoWrite" && Array.isArray(fields.todos)) {
    const mark: Record<string, string> = { completed: "[x]", in_progress: "[~]" };
    return fields.todos.map((t) => `${mark[(t as { status?: string } | null)?.status ?? ""] ?? "[ ]"} ${asText((t as { content?: unknown } | null)?.content ?? t)}`).join("\n");
  }
  const telling = (TELLING[name] ?? []).filter((key) => fields[key] !== undefined);
  if (telling.length === 1) return asText(fields[telling[0]!]);
  const keys = telling.length > 0 ? telling : Object.keys(fields);
  return keys.map((key) => `${key}: ${asText(fields[key])}`).join("\n");
}

// Text and tool calls only; thinking and any other block are left out.
export function entriesFrom(message: SDKAssistantMessage, card: string): Entry[] {
  return message.message.content.flatMap((block): Entry[] => {
    if (block.type === "text") return block.text.trim() ? [{ kind: "assistant", card, text: plain(block.text) }] : [];
    if (block.type === "tool_use") return [{ kind: "tool", card, name: plain(block.name), input: clip(plain(toolInput(block.name, block.input)), MAX_TOOL_INPUT) }];
    return [];
  });
}

// How the run ended, at the foot of the transcript. A halt's reason is model text.
export function endEntry(outcome: Outcome): Extract<Entry, { kind: "end" }> {
  const reason = reasonOf(outcome);
  return { kind: "end", status: outcome.status, ...(reason ? { reason: plain(reason) } : {}) };
}

function reasonOf(outcome: Outcome): string | undefined {
  switch (outcome.status) {
    case "halted":
    case "refused":
      return outcome.reason;
    case "failed":
      return outcome.error;
    default:
      return undefined;
  }
}

// Keeps the newest entries; once older ones are dropped, a single marker at the top says so.
export class Transcript {
  private kept: Entry[] = [];
  private dropped = false;

  add(entries: readonly Entry[]): void {
    this.kept.push(...entries);
    if (this.kept.length > MAX_ENTRIES) {
      this.kept = this.kept.slice(-MAX_ENTRIES);
      this.dropped = true;
    }
  }

  entries(): Entry[] {
    return this.dropped ? [{ kind: "dropped" }, ...this.kept] : [...this.kept];
  }
}
