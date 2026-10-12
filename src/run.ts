import { cardPrompt, REVIEW, skillDefault, STORY, type Chain, type ChainSession } from "./chains.ts";
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

// Where a run stopped: the session and the card within it.
export type At = { session: number; card: number };

export type Outcome =
  | { status: "done"; text: string }
  | { status: "no-changes" }
  | { status: "halted"; reason: string; sessionId?: string; at?: At }
  | { status: "failed"; error: string; sessionId?: string; at?: At }
  | { status: "stopped" }
  | { status: "refused"; reason: string };

export type RunDeps = {
  runTurn(request: Pick<TurnRequest, "prompt" | "model" | "resume">): Promise<TurnResult>;
  models: Models;
  emit(event: RunEvent): void;
  signal: AbortSignal;
};

const NUDGE = "End your reply with your COORDINER status line.";

// One session runs its cards in order, resuming one conversation. A "once" card takes one turn; NEXT moves to the next card on the
// tier it names, DONE moves to the next card on its own tier. A review's DONE skips the loop cards after it (nothing to fix goes
// straight to history); any other skill's DONE does not. A "loop" card continues on each NEXT and moves on at DONE. NEXT on a last
// "once" card has no step to name, so it counts as a missing status line.
async function runSessionAt(session: ChainSession, deps: RunDeps): Promise<{ outcome: Outcome; card: number }> {
  const { cards } = session;
  if (cards.length === 0) return { outcome: { status: "refused", reason: "This session has no skills." }, card: 0 };
  let card = 0;
  let { label } = cards[0]!;
  let prompt = cardPrompt(cards[0]!);
  let tier = skillDefault(cards[0]!.skill).tier;
  let resume: string | undefined;
  let nudged = false;
  const stop = (outcome: Outcome) => ({ outcome, card });
  const enter = (next: number, nextTier: Tier) => {
    card = next;
    ({ label } = cards[card]!);
    prompt = cardPrompt(cards[card]!);
    tier = nextTier;
  };

  for (let index = 0; index < MAX_TURNS; index++) {
    if (deps.signal.aborted) return stop({ status: "stopped" });
    deps.emit({ type: "step-started", index, label, tier, model: deps.models[tier] });
    const result = await deps.runTurn({ prompt, model: deps.models[tier], ...(resume ? { resume } : {}) });
    const sessionId = result.sessionId;
    const finish = (status: StepStatus, detail: string) => deps.emit({ type: "step-finished", index, status, detail, ...(sessionId ? { sessionId } : {}) });

    if (!result.ok) {
      if (deps.signal.aborted) {
        finish("stopped", "stopped");
        return stop({ status: "stopped" });
      }
      finish("failed", result.error);
      return stop({ status: "failed", error: result.error, ...(sessionId ? { sessionId } : {}) });
    }
    resume = result.sessionId;
    const status = parseStatus(result.resultText);
    const kind = skillDefault(cards[card]!.skill).kind;

    if (status.kind === "halt") {
      finish("halted", status.reason);
      return stop({ status: "halted", reason: status.reason, sessionId: result.sessionId });
    }
    if (status.kind === "none" || (status.kind === "next" && kind === "once" && card === cards.length - 1)) {
      if (nudged) {
        finish("halted", "no COORDINER status line after a reminder");
        return stop({ status: "halted", reason: "the session did not report a COORDINER status line, even after a reminder", sessionId: result.sessionId });
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
      let next = card + 1;
      if (skillDefault(cards[card]!.skill).doneSkipsLoops) while (next < cards.length && skillDefault(cards[next]!.skill).kind === "loop") next++;
      if (next >= cards.length) return stop({ status: "done", text: withoutStatus(result.resultText) });
      enter(next, skillDefault(cards[next]!.skill).tier);
      continue;
    }

    finish("done", `next: ${status.tier}`);
    if (kind === "loop") {
      ({ label } = cards[card]!);
      prompt = cards[card]!.next ?? "Continue.";
      tier = tierOf(status.tier);
    } else {
      enter(card + 1, tierOf(status.tier));
    }
  }
  return stop({ status: "failed", error: `the run reached the ${MAX_TURNS}-turn cap without finishing.` });
}

export const runSession = async (session: ChainSession, deps: RunDeps): Promise<Outcome> => (await runSessionAt(session, deps)).outcome;

export type FilledChain = { ok: true; chain: Chain } | { ok: false; reason: string };

// The story fills each {{story}} placeholder; it also names the worktree, so every chain runs for one story.
export function fillStory(chain: Chain, story: Story): FilledChain {
  if (story.body.length > MAX_STORY_CHARS) return { ok: false, reason: `This story is longer than ${MAX_STORY_CHARS} characters; split it.` };
  const text = `${story.heading}\n\n${story.body}`;
  return {
    ok: true,
    chain: { ...chain, sessions: chain.sessions.map((s) => ({ cards: s.cards.map((c) => ({ ...c, args: c.args.split(STORY).join(text) })) })) },
  };
}

export type ChainDeps = RunDeps & { prepareReview(): Promise<ReviewPrep> };

// Each session is fresh (never a resume), so a reviewer does not share the author's context. A session that opens with the
// uncommitted review first marks the new files so the review sees them.
export async function runChain(chain: Chain, deps: ChainDeps): Promise<Outcome> {
  let steps = 0;
  let last: Outcome = { status: "refused", reason: "This chain has no sessions." };
  for (const [s, session] of chain.sessions.entries()) {
    if (s > 0 && deps.signal.aborted) return { status: "stopped" };
    if (session.cards[0]?.skill === REVIEW) {
      const prep = await deps.prepareReview();
      const at = { session: s, card: 0 };
      if (prep.kind === "no-changes") return { status: "no-changes" };
      if (prep.kind === "too-many") return { status: "halted", reason: `the work left ${prep.count} new files, more than ${MAX_NEW_FILES}. Is a dependency folder missing from .gitignore?`, at };
      if (prep.kind === "failed") return { status: "failed", error: `git could not mark the new files for review: ${clip(prep.detail, 300)}`, at };
    }
    const offset = steps;
    const emit = (event: RunEvent) => {
      steps = offset + event.index + 1;
      deps.emit({ ...event, index: event.index + offset });
    };
    const { outcome, card } = await runSessionAt(session, { ...deps, emit });
    if (outcome.status === "halted" || outcome.status === "failed") return { ...outcome, at: { session: s, card } };
    if (outcome.status !== "done") return outcome;
    last = outcome;
  }
  return last;
}

// What is left to run by hand after a halt or failure. A stop in the first session is taken over with `claude --resume`, so it
// lists nothing; a later stop lists the rest of that session from the card that stopped, then every later session.
export function remainingCommands(chain: Chain, outcome: Outcome): string[] {
  if ((outcome.status !== "halted" && outcome.status !== "failed") || !outcome.at || outcome.at.session === 0) return [];
  const { session, card } = outcome.at;
  return chain.sessions.slice(session).flatMap((s, i) => s.cards.slice(i === 0 ? card : 0).map(cardPrompt));
}
