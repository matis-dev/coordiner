import type { Models, Tier } from "./environment.ts";
import { parseStatus, tierOf } from "./protocol.ts";
import type { Story } from "./backlog.ts";
import type { TurnRequest, TurnResult } from "./session.ts";

export const MAX_TURNS = 20;
export const MAX_STORY_CHARS = 20_000;

export type StepStatus = "done" | "failed" | "halted" | "stopped";
export type RunEvent =
  | { type: "step-started"; index: number; label: string; tier: Tier; model: string }
  | { type: "step-finished"; index: number; status: StepStatus; detail: string };

export type Outcome =
  | { status: "done" }
  | { status: "halted"; reason: string }
  | { status: "failed"; error: string; sessionId?: string }
  | { status: "stopped" }
  | { status: "refused"; reason: string };

export type RunDeps = {
  runTurn(request: Pick<TurnRequest, "prompt" | "model" | "resume">): Promise<TurnResult>;
  models: Models;
  emit(event: RunEvent): void;
  signal: AbortSignal;
};

const NUDGE = "End your reply with your COORDINER status line.";
const FIRST_IMPLEMENT = "/m-skills:implementing-architect Implement the approved plan above.";
const CONTINUE = "Continue with the next step of the plan.";

// Session 1 of a story: plan on the strong model, then implement in the same session, switching model at each tier stop.
export async function runStorySession(story: Story, deps: RunDeps): Promise<Outcome> {
  if (story.body.length > MAX_STORY_CHARS) return { status: "refused", reason: `This story is longer than ${MAX_STORY_CHARS} characters; split it.` };

  let tier: Tier = "strong";
  let prompt = `/m-skills:planning-architect ${story.heading}\n\n${story.body}`;
  let label = "Plan";
  let resume: string | undefined;
  let implementing = false;
  let nudged = false;

  for (let index = 0; index < MAX_TURNS; index++) {
    if (deps.signal.aborted) return { status: "stopped" };
    deps.emit({ type: "step-started", index, label, tier, model: deps.models[tier] });
    const result = await deps.runTurn({ prompt, model: deps.models[tier], ...(resume ? { resume } : {}) });
    const finish = (status: StepStatus, detail: string) => deps.emit({ type: "step-finished", index, status, detail });

    if (!result.ok) {
      if (deps.signal.aborted) {
        finish("stopped", "stopped");
        return { status: "stopped" };
      }
      finish("failed", result.error);
      return { status: "failed", error: result.error, ...(result.sessionId ? { sessionId: result.sessionId } : {}) };
    }
    resume = result.sessionId;
    const status = parseStatus(result.resultText);

    if (status.kind === "done") {
      finish("done", "done");
      return { status: "done" };
    }
    if (status.kind === "halt") {
      finish("halted", status.reason);
      return { status: "halted", reason: status.reason };
    }
    if (status.kind === "none") {
      if (nudged) {
        finish("halted", "no COORDINER status line after a reminder");
        return { status: "halted", reason: "the session did not report a COORDINER status line, even after a reminder" };
      }
      finish("done", "no status line; reminding");
      nudged = true;
      prompt = NUDGE;
      label = "Reminder";
      continue;
    }

    finish("done", `next: ${status.tier}`);
    nudged = false;
    tier = tierOf(status.tier);
    prompt = implementing ? CONTINUE : FIRST_IMPLEMENT;
    implementing = true;
    label = "Implement";
  }
  return { status: "failed", error: `the run reached the ${MAX_TURNS}-turn cap without finishing.` };
}

