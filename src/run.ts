import { cardPrompt, inputOf, INPUTS, MAX_INPUT_CHARS, REVIEW, skillDefault, type Chain, type ChainSession, type Effort } from "./chains.ts";
import type { Models, Tier } from "./environment.ts";
import { parseStatus, tierOf, withoutStatus, type Status } from "./protocol.ts";
import type { TurnRequest, TurnResult } from "./session.ts";
import type { Talk } from "./talk.ts";
import { clip } from "./text.ts";
import { MAX_NEW_FILES, type ReviewPrep } from "./worktree.ts";

export const MAX_TURNS = 20;

export type StepStatus = "done" | "failed" | "halted" | "stopped";

// Where a run is, or where it stopped: the session and the card within it.
export type At = { session: number; card: number };

export type RunEvent =
  // `position`, not `at`: the journal stamps each record with its time as `at`.
  | { type: "step-started"; index: number; label: string; tier: Tier; model: string; effort?: Effort; position: At }
  | { type: "step-finished"; index: number; status: StepStatus; detail: string; sessionId?: string };

// Where a continued run picks up: the card, the tier it was on (none takes the skill's default), the session to resume (none
// starts it fresh), and the prompt its first turn sends.
export type StartPoint = { at: At; tier?: Tier; resume?: string; prompt: string };

export type Outcome =
  | { status: "done"; text: string }
  | { status: "no-changes" }
  | { status: "halted"; reason: string; sessionId?: string; at?: At }
  | { status: "failed"; error: string; sessionId?: string; at?: At }
  | { status: "stopped" }
  | { status: "refused"; reason: string };

// A turn the user is present for (`interactive`) gets the interactive note and their answers to its questions.
export type TurnAsk = Pick<TurnRequest, "prompt" | "model" | "effort" | "resume"> & { interactive: boolean };

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

// What a parked card is sent when the user chooses Continue, in the session that stopped.
export const continueAfter = (reason: string): string =>
  `The user has handled what stopped you (${reason}). Check that it is fixed, then carry on with the step, and end your reply with your COORDINER status line.`;

// What a card is sent when a run that was stopped, or cut off by VS Code closing, is continued in the session it ran in.
export const pickUpAfter = (reason: string): string =>
  `This step was interrupted (${reason}). Check where you left off, then carry on with it, and end your reply with your COORDINER status line.`;

// What a card is sent when its run is continued after the card had given its reply: it waited for the user, or the run stopped
// before the card after it began. Its status line was not acted on, so it is asked for again rather than the work.
export const restateAfter = (reason: string): string =>
  `This step had finished when the run was interrupted (${reason}). Do not redo it: end your reply with your COORDINER status line for it again.`;

// Why a card stopped, and the outcome the run ends with if the user stops it there.
type Parking = { outcome: Extract<Outcome, { status: "halted" | "failed" }>; reason: string };

// One session runs its cards in order, resuming one conversation. A "once" card takes one turn; NEXT moves to the next card on the
// tier it names, DONE moves to the next card on its own tier. A review's DONE skips the loop cards after it (nothing to fix goes
// straight to history); any other skill's DONE does not. A "loop" card continues on each NEXT and moves on at DONE. NEXT on a last
// "once" card names a step this session does not have (a kickoff naming the planning after it), so it ends the card as DONE does.
//
// A card that pauses, or one the user paused, talks with the user: after each turn it waits, each message is another turn, and
// Continue applies the latest status line the card gave (a pausing card that gave none is done). Only unattended turns count
// toward MAX_TURNS. Messages the user queued go in front of the next turn's prompt.
//
// A card that cannot go on (a HALT, a failed turn, no status line after the reminder, the turn cap) parks instead of ending the
// run: it waits for the user, a message is a turn with them, and Continue retries it, in the session that stopped when there is
// one. Stop ends the run with the outcome that parked it, so the session can still be taken over by hand.
//
// A card with its own model runs every turn on it, loop turns and the reminder included: NEXT <tier> then only picks the tier the
// card after it starts on.
// `start` begins at a later card instead, resuming the session it names with its prompt.
async function runSessionAt(session: ChainSession, deps: RunDeps, place: SessionPlace = { session: 0 }, start?: Omit<StartPoint, "at"> & { card: number }): Promise<{ outcome: Outcome; card: number }> {
  const { cards } = session;
  if (cards.length === 0) return { outcome: { status: "refused", reason: "This session has no skills." }, card: 0 };
  let card = start?.card ?? 0;
  if (!cards[card]) return { outcome: { status: "refused", reason: "This session has no such card to continue at." }, card: 0 };
  let { label } = cards[card]!;
  let prompt = start?.prompt ?? cardPrompt(cards[card]!);
  let tier = start?.tier ?? skillDefault(cards[card]!.skill).tier;
  let attended = cards[card]!.pause;
  let chat = false;
  let resume: string | undefined = start?.resume;
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

  // Moves the session on from a status line: sets the next turn, or returns the outcome that ends the session or the parking that
  // stops the card. `step` is how the turn that gave the status is reported.
  const advance = (status: Status, text: string, sessionId: string): { end?: Outcome; park?: Parking; step: [StepStatus, string] } => {
    const kind = skillDefault(cards[card]!.skill).kind;
    chat = false;
    if (status.kind === "halt") return { park: { outcome: { status: "halted", reason: status.reason, sessionId }, reason: status.reason }, step: ["halted", status.reason] };
    if (status.kind === "none") {
      if (nudged) {
        const reason = "the session did not report a COORDINER status line, even after a reminder";
        return { park: { outcome: { status: "halted", reason, sessionId }, reason }, step: ["halted", "no COORDINER status line after a reminder"] };
      }
      nudged = true;
      prompt = NUDGE;
      label = "Reminder";
      attended = false;
      return { step: ["done", "no status line; reminding"] };
    }
    nudged = false;
    if (status.kind === "done" || (kind === "once" && card === cards.length - 1)) {
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

  // The card waits for the user. Returns the outcome to end the run with when they stop it; otherwise the next turn is set, with a
  // fresh turn allowance: their message, or the retry on Continue. A prompt that never reached the session (`unsent`) is the retry,
  // and a message goes in front of it, as a queued one does, so the card's own prompt is never lost.
  const park = async ({ outcome, reason }: Parking, next: { retry: string } | { unsent: string }): Promise<Outcome | undefined> => {
    const move = await deps.talk.waitForYou({ card: cards[card]!.label, ready: false, signal: deps.signal, parked: reason });
    if (move.kind === "stopped") return outcome;
    latest = undefined;
    nudged = false;
    unattendedTurns = 0;
    ({ label } = cards[card]!);
    const retry = "unsent" in next ? next.unsent : next.retry;
    if (move.kind === "message") {
      prompt = "unsent" in next ? `${move.text}\n\n${retry}` : move.text;
      attended = true;
      chat = true;
      return undefined;
    }
    prompt = retry;
    attended = cards[card]!.pause;
    chat = false;
    return undefined;
  };

  for (let index = 0; ; index++) {
    if (deps.signal.aborted) return stop({ status: "stopped" });
    if (!attended && unattendedTurns >= MAX_TURNS) {
      const error = `the run reached the ${MAX_TURNS}-turn cap without finishing.`;
      const ended = await park({ outcome: { status: "failed", error }, reason: error }, { unsent: prompt });
      if (ended) return stop(ended);
    }
    if (!attended) unattendedTurns++;
    deps.talk.at({ card: cards[card]!.label, index: card, session: place.session, attended, ...(card === cards.length - 1 && place.nextSession ? { nextSession: place.nextSession } : {}) });
    const queued = deps.talk.takeQueued(cards[card]!.label);
    const shown = chat ? `${label} · chat` : label;
    const { model = deps.models[tier], effort } = cards[card]!;
    const effortSet = effort ? { effort } : {};
    deps.emit({ type: "step-started", index, label: shown, tier, model, ...effortSet, position: { session: place.session, card } });
    const result = await deps.runTurn({ prompt: queued ? `${queued}\n\n${prompt}` : prompt, model, ...effortSet, interactive: attended, ...(resume ? { resume } : {}) });
    const sessionId = result.sessionId;
    const finish = ([status, detail]: [StepStatus, string]) => deps.emit({ type: "step-finished", index, status, detail, ...(sessionId ? { sessionId } : {}) });

    if (!result.ok) {
      if (deps.signal.aborted) {
        finish(["stopped", "stopped"]);
        return stop({ status: "stopped" });
      }
      finish(["failed", result.error]);
      // A turn that started its session took the prompt; one that did not is tried again as it was.
      if (sessionId) resume = sessionId;
      const parking: Parking = { outcome: { status: "failed", error: result.error, ...(sessionId ? { sessionId } : {}) }, reason: result.error };
      const ended = await park(parking, sessionId ? { retry: continueAfter(result.error) } : { unsent: prompt });
      if (ended) return stop(ended);
      continue;
    }
    resume = result.sessionId;
    const status = parseStatus(result.resultText);

    // A halt in an unattended turn parks the card even when a pause was asked for.
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
      const { end, park: parking } = advance(decided.status, decided.text, result.sessionId);
      if (end) return stop(end);
      if (parking) {
        const ended = await park(parking, { retry: continueAfter(parking.reason) });
        if (ended) return stop(ended);
      }
      continue;
    }

    const { end, park: parking, step } = advance(status, result.resultText, result.sessionId);
    finish(step);
    if (end) return stop(end);
    if (parking) {
      const ended = await park(parking, { retry: continueAfter(parking.reason) });
      if (ended) return stop(ended);
    }
  }
}

// A turn after the run ends. The caller gives it AFTER_NOTE and the interactive tool rules, as for a card the user is present for.
export type AfterAsk = Pick<TurnRequest, "prompt" | "model" | "effort" | "resume">;

export type TalkOnDeps = {
  runTurn(request: AfterAsk): Promise<TurnResult>;
  talk: Pick<Talk, "waitForYou">;
  signal: AbortSignal;
  // The run's last card, and the session, model and effort its last turn ran on.
  card: string;
  sessionId: string;
  model: string;
  effort?: Effort;
};

// After the run, the chat stays on its last session until the signal aborts: each message is a turn that resumes it. A failed
// turn leaves the chat open (the caller shows the failure), and a status line in a reply steers nothing.
export async function talkOn({ runTurn, talk, signal, card, sessionId, model, effort }: TalkOnDeps): Promise<void> {
  let resume = sessionId;
  for (;;) {
    const move = await talk.waitForYou({ card, ready: false, signal });
    if (move.kind === "stopped") return;
    if (move.kind !== "message") continue;
    const result = await runTurn({ prompt: move.text, model, ...(effort ? { effort } : {}), resume });
    if (result.ok) resume = result.sessionId;
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
// uncommitted review first marks the new files so the review sees them. With `from`, the chain picks up at that card: the sessions
// before it are skipped, and a session entered at a later card has its review already prepared.
export async function runChain(chain: Chain, deps: ChainDeps, from?: StartPoint): Promise<Outcome> {
  let steps = 0;
  let last: Outcome = { status: "refused", reason: "This chain has no sessions." };
  for (const [s, session] of chain.sessions.entries()) {
    if (from && s < from.at.session) continue;
    if (s > 0 && deps.signal.aborted) return { status: "stopped" };
    const start = from?.at.session === s ? { ...from, card: from.at.card } : undefined;
    if (session.cards[0]?.skill === REVIEW && (start?.card ?? 0) === 0) {
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
    const { outcome, card } = await runSessionAt(session, { ...deps, emit }, { session: s, ...(nextSession ? { nextSession } : {}) }, start);
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
