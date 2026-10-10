import type { Models, Tier } from "./environment.ts";
import { parseStatus, tierOf, withoutStatus } from "./protocol.ts";
import type { Story } from "./backlog.ts";
import type { TurnRequest, TurnResult } from "./session.ts";
import { clip } from "./text.ts";
import { MAX_NEW_FILES, type ReviewPrep } from "./worktree.ts";

export const MAX_TURNS = 20;
export const MAX_STORY_CHARS = 20_000;

export type StepStatus = "done" | "failed" | "halted" | "stopped";
export type RunEvent =
  | { type: "step-started"; index: number; label: string; tier: Tier; model: string }
  | { type: "step-finished"; index: number; status: StepStatus; detail: string; sessionId?: string };

export type Outcome =
  | { status: "done"; text: string }
  | { status: "no-changes" }
  | { status: "halted"; reason: string; sessionId?: string; beforeReview?: true }
  | { status: "failed"; error: string; sessionId?: string; beforeReview?: true }
  | { status: "stopped" }
  | { status: "refused"; reason: string };

export type RunDeps = {
  runTurn(request: Pick<TurnRequest, "prompt" | "model" | "resume">): Promise<TurnResult>;
  models: Models;
  emit(event: RunEvent): void;
  signal: AbortSignal;
};

type Turn = { label: string; prompt: string; tier: Tier };

// A session opens with one turn, enters `work` on NEXT and stays there on each further NEXT; DONE moves to `close` when there is one, else ends the session.
export type Script = { open: Turn; work: { label: string; first: string; next: string }; close?: Turn };

export const sessionOne = (story: Story): Script => ({
  open: { label: "Plan", prompt: `/m-skills:planning-architect ${story.heading}\n\n${story.body}`, tier: "strong" },
  work: { label: "Implement", first: "/m-skills:implementing-architect Implement the approved plan above.", next: "Continue with the next step of the plan." },
});

const REVIEW: Turn = { label: "Review", prompt: "/m-skills:code-review-architect-uncommitted", tier: "strong" };
const FIX = { label: "Fix", first: "/m-skills:implementing-architect fix the findings", next: "Continue with the next fix." };
const HISTORY: Turn = { label: "History", prompt: "/m-skills:rolling-history", tier: "medium" };

export const SESSION_TWO: Script = { open: REVIEW, work: FIX, close: HISTORY };

const NUDGE = "End your reply with your COORDINER status line.";

export async function runSession(script: Script, deps: RunDeps): Promise<Outcome> {
  let phase: "open" | "work" | "close" = "open";
  let { label, prompt, tier } = script.open;
  let resume: string | undefined;
  let nudged = false;

  for (let index = 0; index < MAX_TURNS; index++) {
    if (deps.signal.aborted) return { status: "stopped" };
    deps.emit({ type: "step-started", index, label, tier, model: deps.models[tier] });
    const result = await deps.runTurn({ prompt, model: deps.models[tier], ...(resume ? { resume } : {}) });
    const sessionId = result.sessionId;
    const finish = (status: StepStatus, detail: string) => deps.emit({ type: "step-finished", index, status, detail, ...(sessionId ? { sessionId } : {}) });

    if (!result.ok) {
      if (deps.signal.aborted) {
        finish("stopped", "stopped");
        return { status: "stopped" };
      }
      finish("failed", result.error);
      return { status: "failed", error: result.error, ...(sessionId ? { sessionId } : {}) };
    }
    resume = result.sessionId;
    const status = parseStatus(result.resultText);

    if (status.kind === "halt") {
      finish("halted", status.reason);
      return { status: "halted", reason: status.reason, sessionId: result.sessionId };
    }
    // The closing turn has no next step to name, so a NEXT there is treated like a missing status line.
    if (status.kind === "none" || (status.kind === "next" && phase === "close")) {
      if (nudged) {
        finish("halted", "no COORDINER status line after a reminder");
        return { status: "halted", reason: "the session did not report a COORDINER status line, even after a reminder", sessionId: result.sessionId };
      }
      finish("done", "no status line; reminding");
      nudged = true;
      prompt = NUDGE;
      label = "Reminder";
      continue;
    }
    nudged = false;

    if (status.kind === "done") {
      finish("done", "done");
      if (phase === "close" || !script.close) return { status: "done", text: withoutStatus(result.resultText) };
      phase = "close";
      ({ label, prompt, tier } = script.close);
      continue;
    }

    finish("done", `next: ${status.tier}`);
    tier = tierOf(status.tier);
    prompt = phase === "work" ? script.work.next : script.work.first;
    phase = "work";
    label = script.work.label;
  }
  return { status: "failed", error: `the run reached the ${MAX_TURNS}-turn cap without finishing.` };
}

export type StoryDeps = RunDeps & { prepareReview(): Promise<ReviewPrep> };

// Session 1 authors, session 2 reviews in a fresh session (never a resume), so the reviewer does not share the author's context.
export async function runStory(story: Story, deps: StoryDeps): Promise<Outcome> {
  if (story.body.length > MAX_STORY_CHARS) return { status: "refused", reason: `This story is longer than ${MAX_STORY_CHARS} characters; split it.` };

  let steps = 0;
  const countSteps = (event: RunEvent) => {
    steps = event.index + 1;
    deps.emit(event);
  };
  const authored = await runSession(sessionOne(story), { ...deps, emit: countSteps });
  if (authored.status !== "done") return authored;
  if (deps.signal.aborted) return { status: "stopped" };

  const prep = await deps.prepareReview();
  if (prep.kind === "no-changes") return { status: "no-changes" };
  if (prep.kind === "too-many") return { status: "halted", reason: `session 1 left ${prep.count} new files, more than ${MAX_NEW_FILES}. Is a dependency folder missing from .gitignore?`, beforeReview: true };
  if (prep.kind === "failed") return { status: "failed", error: `git could not mark the new files for review: ${clip(prep.detail, 300)}`, beforeReview: true };

  return runSession(SESSION_TWO, { ...deps, emit: (event) => deps.emit({ ...event, index: event.index + steps }) });
}

const REVIEW_COMMANDS: Array<[label: string, command: string]> = [
  [REVIEW.label, REVIEW.prompt],
  [FIX.label, FIX.first],
  [HISTORY.label, HISTORY.prompt],
];

// What is left to run by hand after a halt or failure: all of session 2 when it never got to start, else from the last session-2 phase that started.
export function remainingCommands(outcome: Outcome, labels: string[]): string[] {
  if (outcome.status !== "halted" && outcome.status !== "failed") return [];
  if (outcome.beforeReview) return REVIEW_COMMANDS.map(([, command]) => command);
  const last = labels.findLast((label) => REVIEW_COMMANDS.some(([phase]) => phase === label));
  const from = REVIEW_COMMANDS.findIndex(([phase]) => phase === last);
  return from === -1 ? [] : REVIEW_COMMANDS.slice(from).map(([, command]) => command);
}
