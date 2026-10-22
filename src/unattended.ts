import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { clip, plain } from "./text.ts";

export type Option = { label: string; description?: string };
export type Question = { question: string; header?: string; options: Option[]; multiSelect?: boolean };

const RECOMMENDED = /\(Recommended\)/i;

export const isQuestion = (q: unknown): q is Question => {
  const v = q as Partial<Question> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.question === "string" &&
    (v.header === undefined || typeof v.header === "string") &&
    (v.multiSelect === undefined || typeof v.multiSelect === "boolean") &&
    Array.isArray(v.options) &&
    v.options.length > 0 &&
    v.options.every((o) => typeof o?.label === "string")
  );
};

// Answers are always chosen from the offered labels; with no Recommended option the first is taken and the log says so.
export function answerUnattended(input: Record<string, unknown>, log: (line: string) => void): PermissionResult {
  const { questions } = input;
  if (!Array.isArray(questions) || !questions.every(isQuestion)) {
    return { behavior: "deny", message: "coordiner could not read this question; decide yourself and state the decision." };
  }
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const recommended = q.options.filter((o) => RECOMMENDED.test(o.label));
    const answer = recommended.length > 0 ? (q.multiSelect ? recommended : recommended.slice(0, 1)).map((o) => o.label).join(", ") : q.options[0]!.label;
    answers[q.question] = answer;
    log(`question: ${plain(q.question)} → ${plain(answer)}${recommended.length > 0 ? "" : " (no Recommended option; took the first)"}`);
  }
  return { behavior: "allow", updatedInput: { ...input, questions, answers } };
}

// Only the input's keys are logged: its values can hold file contents or a credential, and the log is kept in the journal.
const denyTool = (toolName: string, input: Record<string, unknown>, log: (line: string) => void): PermissionResult => {
  log(`denied tool: ${plain(toolName)} (${clip(plain(Object.keys(input).join(", ")), 300)})`);
  return { behavior: "deny", message: "coordiner runs unattended and cannot approve this action." };
};

export const unattendedCanUseTool =
  (log: (line: string) => void): CanUseTool =>
  async (toolName, input) => (toolName === "AskUserQuestion" ? answerUnattended(input, log) : denyTool(toolName, input, log));

// The user answers in the chat; `ask` settles with their answers, keyed by question text, or rejects when the run stops.
export type Ask = (questions: Question[], signal: AbortSignal) => Promise<Record<string, string>>;

// Only questions reach the user; every other tool is decided exactly as in an unattended turn.
export const interactiveCanUseTool =
  (ask: Ask, log: (line: string) => void): CanUseTool =>
  async (toolName, input, { signal }) => {
    if (toolName !== "AskUserQuestion") return denyTool(toolName, input, log);
    const { questions } = input;
    if (!Array.isArray(questions) || !questions.every(isQuestion)) {
      return { behavior: "deny", message: "coordiner could not read this question; ask it in plain text instead." };
    }
    try {
      return { behavior: "allow", updatedInput: { ...input, questions, answers: await ask(questions, signal) } };
    } catch {
      return { behavior: "deny", message: "The run was stopped before the user answered." };
    }
  };
