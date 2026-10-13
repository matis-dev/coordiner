import { cardPrompt, inputOf, INPUTS, MAX_INPUT_CHARS, REVIEW, skillDefault, type Chain, type ChainSession } from "./chains.ts";
import type { Models, Tier } from "./environment.ts";
import { parseStatus, tierOf, withoutStatus, type Status } from "./protocol.ts";
import type { TurnRequest, TurnResult } from "./session.ts";
import type { Talk } from "./talk.ts";
import { clip } from "./text.ts";
import { MAX_NEW_FILES, type ReviewPrep } from "./worktree.ts";

export const MAX_TURNS = 20;

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

// A turn the user is present for (`interactive`) gets the interactive note and their answers to its questions.
export type TurnAsk = Pick<TurnRequest, "prompt" | "model" | "resume"> & { interactive: boolean };

export type RunDeps = {
  runTurn(request: TurnAsk): Promise<TurnResult>;
  models: Models;
  emit(event: RunEvent): void;
  signal: AbortSignal;
  talk: Pick<Talk, "at" | "takeQueued" | "pausePending" | "waitForYou">;
};

// Where a session sits in its chain: its number, and the first card of the session after it (a queued message may cross over).
export type SessionPlace = { session: number; nextSession?: string };

const NUDGE = "End your reply with your COORDINER status line.";

// One session runs its cards in order, resuming one conversation. A "once" card takes one turn; NEXT moves to the next card on the
// tier it names, DONE moves to the next card on its own tier. A review's DONE skips the loop cards after it (nothing to fix goes
// straight to history); any other skill's DONE does not. A "loop" card continues on each NEXT and moves on at DONE. NEXT on a last
// "once" card has no step to name, so it counts as a missing status line.
//
// A card that pauses, or one the user paused, talks with the user: after each turn it waits, each message is another turn, and
// Continue applies the latest status line the card gave (a pausing card that gave none is done). Only unattended turns count
// toward MAX_TURNS. Messages the user queued go in front of the next turn's prompt.
async function runSessionAt(session: ChainSession, deps: RunDeps, place: SessionPlace = { session: 0 }): Promise<{ outcome: Outcome; card: number }> {
  const { cards } = session;
  if (cards.length === 0) return { outcome: { status: "refused", reason: "This session has no skills." }, card: 0 };
  let card = 0;
  let { label } = cards[0]!;
  let prompt = cardPrompt(cards[0]!);
  let tier = skillDefault(cards[0]!.skill).tier;
  let attended = cards[0]!.pause;
  let chat = false;
  let resume: string | undefined;
  let nudged = false;
  let unattendedTurns = 0;
  // The latest status line the card gave since it started waiting for the user; Continue applies it.
  let latest: { status: Status; text: string } | undefined;
  const stop = (outcome: Outcome) => ({ outcome, card });
  const enter = (next: number, nextTier: Tier) => {
    card = next;
    ({ label } = cards[card]!);
    prompt = cardPrompt(cards[card]!);
    tier = nextTier;
    attended = cards[card]!.pause;
    latest = undefined;
  };

  // Moves the session on from a status line: sets the next turn, or returns the outcome that ends the session. `step` is how the
  // turn that gave the status is reported.
  const advance = (status: Status, text: string, sessionId: string): { end?: Outcome; step: [StepStatus, string] } => {
    const kind = skillDefault(cards[card]!.skill).kind;
    chat = false;
    if (status.kind === "halt") return { end: { status: "halted", reason: status.reason, sessionId }, step: ["halted", status.reason] };
    if (status.kind === "none" || (status.kind === "next" && kind === "once" && card === cards.length - 1)) {
      if (nudged) {
        const reason = "the session did not report a COORDINER status line, even after a reminder";
        return { end: { status: "halted", reason, sessionId }, step: ["halted", "no COORDINER status line after a reminder"] };
      }
      nudged = true;
      prompt = NUDGE;
      label = "Reminder";
      attended = false;
      return { step: ["done", "no status line; reminding"] };
    }
    nudged = false;
    if (status.kind === "done") {
      let next = card + 1;
      if (skillDefault(cards[card]!.skill).doneSkipsLoops) while (next < cards.length && skillDefault(cards[next]!.skill).kind === "loop") next++;
      if (next >= cards.length) return { end: { status: "done", text: withoutStatus(text) }, step: ["done", "done"] };
      enter(next, skillDefault(cards[next]!.skill).tier);
      return { step: ["done", "done"] };
    }
    if (kind === "loop") {
      ({ label } = cards[card]!);
      prompt = cards[card]!.next ?? "Continue.";
      tier = tierOf(status.tier);
      attended = false;
    } else {
      enter(card + 1, tierOf(status.tier));
    }
    return { step: ["done", `next: ${status.tier}`] };
  };

  for (let index = 0; ; index++) {
    if (deps.signal.aborted) return stop({ status: "stopped" });
    if (!attended && unattendedTurns >= MAX_TURNS) return stop({ status: "failed", error: `the run reached the ${MAX_TURNS}-turn cap without finishing.` });
    if (!attended) unattendedTurns++;
    deps.talk.at({ card: cards[card]!.label, index: card, session: place.session, attended, ...(card === cards.length - 1 && place.nextSession ? { nextSession: place.nextSession } : {}) });
    const queued = deps.talk.takeQueued(cards[card]!.label);
    const shown = chat ? `${label} · chat` : label;
    deps.emit({ type: "step-started", index, label: shown, tier, model: deps.models[tier] });
    const result = await deps.runTurn({ prompt: queued ? `${queued}\n\n${prompt}` : prompt, model: deps.models[tier], interactive: attended, ...(resume ? { resume } : {}) });
    const sessionId = result.sessionId;
    const finish = ([status, detail]: [StepStatus, string]) => deps.emit({ type: "step-finished", index, status, detail, ...(sessionId ? { sessionId } : {}) });

    if (!result.ok) {
      if (deps.signal.aborted) {
        finish(["stopped", "stopped"]);
        return stop({ status: "stopped" });
      }
      finish(["failed", result.error]);
      return stop({ status: "failed", error: result.error, ...(sessionId ? { sessionId } : {}) });
    }
    resume = result.sessionId;
    const status = parseStatus(result.resultText);

    // A halt in an unattended turn ends the run even when a pause was asked for; the user takes over with claude --resume.
    if (attended || (deps.talk.pausePending() && status.kind !== "halt")) {
      if (status.kind !== "none") latest = { status, text: result.resultText };
      finish(["done", "waiting for you"]);
      const next = cards[card + 1]?.label;
      const move = await deps.talk.waitForYou({ card: cards[card]!.label, ready: latest !== undefined, signal: deps.signal, ...(next ? { nextCard: next } : {}) });
      if (move.kind === "stopped") return stop({ status: "stopped" });
      if (move.kind === "message") {
        prompt = move.text;
        attended = true;
        chat = true;
        continue;
      }
      // Continue. A pausing card that never gave a status line is done; any other card gets one reminder, as an unattended turn does.
      const decided = latest ?? { status: cards[card]!.pause ? ({ kind: "done" } as const) : ({ kind: "none" } as const), text: "" };
      latest = undefined;
      nudged = false;
      const { end } = advance(decided.status, decided.text, result.sessionId);
      if (end) return stop(end);
      continue;
    }

    const { end, step } = advance(status, result.resultText, result.sessionId);
    finish(step);
    if (end) return stop(end);
  }
}

export const runSession = async (session: ChainSession, deps: RunDeps): Promise<Outcome> => (await runSessionAt(session, deps)).outcome;

export type FilledChain = { ok: true; chain: Chain } | { ok: false; reason: string };

// The input (a story, an idea or a bug) fills the chain's placeholder; a chain without one runs as it is.
export function fillInput(chain: Chain, text: string): FilledChain {
  if (text.length > MAX_INPUT_CHARS) return { ok: false, reason: `This text is longer than ${MAX_INPUT_CHARS} characters; split it.` };
  const kind = inputOf(chain);
  if (kind === undefined) return { ok: true, chain };
  const { placeholder } = INPUTS[kind];
  return {
    ok: true,
    chain: { ...chain, sessions: chain.sessions.map((s) => ({ cards: s.cards.map((c) => ({ ...c, args: c.args.split(placeholder).join(text) })) })) },
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
    const nextSession = chain.sessions[s + 1]?.cards[0]?.label;
    const { outcome, card } = await runSessionAt(session, { ...deps, emit }, { session: s, ...(nextSession ? { nextSession } : {}) });
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
