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

// Only called when every question has a Recommended option: every recommended label of a multi-select, the first of a single one.
function recommendedAnswers(questions: readonly Question[], log: (line: string) => void): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const recommended = q.options.filter((o) => RECOMMENDED.test(o.label));
    const answer = (q.multiSelect ? recommended : recommended.slice(0, 1)).map((o) => o.label).join(", ");
    answers[q.question] = answer;
    log(`question: ${plain(q.question)} → ${plain(answer)}`);
  }
  return answers;
}

// Only the input's keys are logged: its values can hold file contents or a credential, and the log is kept in the journal.
const denyTool = (toolName: string, input: Record<string, unknown>, log: (line: string) => void): PermissionResult => {
  log(`denied tool: ${plain(toolName)} (${clip(plain(Object.keys(input).join(", ")), 300)})`);
  return { behavior: "deny", message: "coordiner runs unattended and cannot approve this action." };
};

// How long an unattended question waits for the user before the Recommended option is taken, when the run waits at all.
export const QUESTION_WAIT_MS = 5 * 60_000;

// Chosen for each run: wait QUESTION_WAIT_MS, then take the Recommended option; wait for the user; or take it at once.
export type QuestionWait = "timed" | "always" | "never";
export type DecidedAfter = "at once" | "after 5 minutes";

export type WaitDeps = {
  wait: QuestionWait;
  ask: Ask;
  // Settles after `ms`, and never once `signal` aborts.
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  log(line: string): void;
  // A question answered with the Recommended option, without the user.
  decided(question: string, answer: string, after: DecidedAfter): void;
};

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });
}

const STOPPED: PermissionResult = { behavior: "deny", message: "The run was stopped before the user answered." };

// A question goes to the chat unless the run takes the Recommended option at once. Only a call whose every question has a
// Recommended option is ever answered without the user: any other waits for them, whatever the run chose (fails closed).
export const unattendedCanUseTool =
  ({ wait, ask, sleep, now, log, decided }: WaitDeps): CanUseTool =>
  async (toolName, input, { signal }) => {
    if (toolName !== "AskUserQuestion") return denyTool(toolName, input, log);
    const { questions } = input;
    if (!Array.isArray(questions) || !questions.every(isQuestion)) {
      return { behavior: "deny", message: "coordiner could not read this question; decide yourself and state the decision." };
    }
    const recommended = questions.every((q) => q.options.some((o) => RECOMMENDED.test(o.label)));
    const take = (after: DecidedAfter): PermissionResult => {
      const answers = recommendedAnswers(questions, log);
      for (const [question, answer] of Object.entries(answers)) decided(question, answer, after);
      return { behavior: "allow", updatedInput: { ...input, questions, answers } };
    };
    if (recommended && wait === "never") return take("at once");
    const timed = recommended && wait === "timed";
    const timer = new AbortController();
    const answered = ask(questions, AbortSignal.any([signal, timer.signal]), timed ? now() + QUESTION_WAIT_MS : undefined);
    answered.catch(() => undefined);
    let answers: Record<string, string> | undefined;
    try {
      answers = timed ? await Promise.race([answered, sleep(QUESTION_WAIT_MS, timer.signal).then(() => undefined)]) : await answered;
    } catch {
      return STOPPED;
    } finally {
      // Stops the wait, and withdraws a question the wait ran out on; `answered` then settles with nobody awaiting it.
      timer.abort();
    }
    if (answers) return { behavior: "allow", updatedInput: { ...input, questions, answers } };
    return signal.aborted ? STOPPED : take("after 5 minutes");
  };

// The user answers in the chat; `ask` settles with their answers, keyed by question text, or rejects when the run stops.
// `expiresAt`: when the Recommended option will be taken instead, for the chat to show.
export type Ask = (questions: Question[], signal: AbortSignal, expiresAt?: number) => Promise<Record<string, string>>;

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
      return STOPPED;
    }
  };
