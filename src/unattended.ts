import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { clip, plain } from "./text.ts";

type Option = { label: string; description?: string };
type Question = { question: string; options: Option[]; multiSelect?: boolean };

const RECOMMENDED = /\(Recommended\)/i;

const isQuestion = (q: unknown): q is Question => {
  const v = q as Partial<Question> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.question === "string" &&
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

export const unattendedCanUseTool =
  (log: (line: string) => void): CanUseTool =>
  async (toolName, input) => {
    if (toolName === "AskUserQuestion") return answerUnattended(input, log);
    log(`denied tool: ${plain(toolName)} ${clip(plain(JSON.stringify(input)), 300)}`);
    return { behavior: "deny", message: "coordiner runs unattended and cannot approve this action." };
  };
