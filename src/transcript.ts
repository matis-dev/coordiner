import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_ENTRIES } from "./chat-logic.ts";
import { clip, plain } from "./text.ts";

// What the run's chat shows. Model text reaches it only through plain(), and the webview sets it with textContent.
export type Entry =
  | { kind: "assistant"; card: string; text: string }
  | { kind: "tool"; card: string; name: string; input: string }
  | { kind: "you"; card: string; text: string }
  | { kind: "answer"; card: string; question: string; answer: string }
  | { kind: "divider"; session: number }
  | { kind: "dropped" };

const MAX_TOOL_INPUT = 300;

// Text and tool calls only; thinking and any other block are left out.
export function entriesFrom(message: SDKAssistantMessage, card: string): Entry[] {
  return message.message.content.flatMap((block): Entry[] => {
    if (block.type === "text") return block.text.trim() ? [{ kind: "assistant", card, text: plain(block.text) }] : [];
    if (block.type === "tool_use") return [{ kind: "tool", card, name: plain(block.name), input: clip(plain(JSON.stringify(block.input) ?? ""), MAX_TOOL_INPUT) }];
    return [];
  });
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
