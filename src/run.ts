import { afterMskills, cardPrompt, inputOf, INPUTS, isEffort, MAX_INPUT_CHARS, REVIEW, skillDefault, type Card, type Chain, type ChainSession, type Effort } from "./chains.ts";
import { parseStatus, suggested, withoutStatus, type Status, type Suggestion } from "./protocol.ts";
import type { Spend, TurnRequest, TurnResult } from "./session.ts";
import type { ModelOption } from "./skills.ts";
import type { Talk } from "./talk.ts";
import { clip, plain } from "./text.ts";
import { MAX_NEW_FILES, type ReviewPrep } from "./worktree.ts";

export const MAX_TURNS = 20;

export type StepStatus = "done" | "failed" | "halted" | "stopped";

// Where a run is, or where it stopped: the session and the card within it.
export type At = { session: number; card: number };

// One turn: how long it ran, and the session's running totals after it (none when its session reported none).
export type TurnStats = { ms: number; usage?: Spend };

export type RunEvent =
  // `position`, not `at`: the journal stamps each record with its time as `at`. No `model`: the session's own default, unchecked
  // (its models could not be listed). `note`: what became of the previous step's suggestion, when it was not simply taken.
  | { type: "step-started"; index: number; label: string; model?: string; effort?: Effort; note?: string; position: At }
  | { type: "step-finished"; index: number; status: StepStatus; detail: string; sessionId?: string; stats: TurnStats };

// Where a continued run picks up: the card, what the step before it suggested (the model and effort it last ran on), the session
// to resume (none starts it fresh), and the prompt its first turn sends.
export type StartPoint = { at: At; suggestion?: Suggestion; resume?: string; prompt: string };

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
  // The models the session offers, and its default model's id; none when they could not be listed.
  offered?: readonly ModelOption[];
  defaultModel?: string;
  emit(event: RunEvent): void;
  signal: AbortSignal;
  talk: Pick<Talk, "at" | "takeQueued" | "pausePending" | "waitForYou" | "giveBack">;
  // Times each turn; Date.now when absent.
  now?: () => number;
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

// How a card's turn runs: its model and effort, from the card and what the step before it suggested. Per field, a value set on the
// card wins and an unset one takes the suggestion; a card that follows the previous step takes the suggestion first, its own values
// being the fallback. A suggested model is taken only when the session offers it, and an effort only when the model the turn runs on
// takes it: anything else is dropped and said in `notes`. With no model at all, the turn runs on the session's default model.
export type TurnSettings = { model?: string; effort?: Effort; notes: string[] };

export function turnSettings(card: Card, suggestion: Suggestion | undefined, offered: readonly ModelOption[] | undefined, defaultModel: string | undefined): TurnSettings {
  const notes: string[] = [];
  const shown = (value: string) => plain(clip(value, 100));
  let model: string | undefined;
  if (suggestion?.model !== undefined) {
    if (!offered) notes.push(`suggested model ${shown(suggestion.model)} not used: the session's models could not be listed`);
    else if (offered.some((m) => m.id === suggestion.model)) model = suggestion.model;
    else notes.push(`suggested model ${shown(suggestion.model)} not used: the session does not offer it`);
  }
  let effort: Effort | undefined;
  if (suggestion?.effort !== undefined) {
    if (isEffort(suggestion.effort)) effort = suggestion.effort;
    else notes.push(`suggested effort ${shown(suggestion.effort)} not used: not an effort level`);
  }
  if (suggestion?.skill !== undefined && suggestion.skill !== card.skill) notes.push(`the previous step suggested ${shown(suggestion.skill)}; the chain runs ${card.skill}`);
  if (card.follow && model === undefined && effort === undefined) notes.push("no suggestion from the previous step: ran on the card's own model and effort");
  const chosen = (card.follow ? (model ?? card.model) : (card.model ?? model)) ?? defaultModel;
  let chosenEffort = card.follow ? (effort ?? card.effort) : (card.effort ?? effort);
  const takes = chosen === undefined ? undefined : offered?.find((m) => m.id === chosen)?.efforts;
  if (chosenEffort && takes && !takes.includes(chosenEffort)) {
    notes.push(`effort ${chosenEffort} not used: ${shown(chosen!)} does not take it`);
    chosenEffort = undefined;
  }
  return { ...(chosen ? { model: chosen } : {}), ...(chosenEffort ? { effort: chosenEffort } : {}), notes };
}

// One session runs its cards in order, resuming one conversation. A "once" card takes one turn; NEXT moves to the next card with
// what it suggested, DONE moves to the next card with no suggestion. A review's DONE skips the loop cards after it (nothing to fix goes
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
// A loop card's NEXT suggests how its own next turn runs; a reminder or a retry keeps the suggestion the card had.
// `start` begins at a later card instead, resuming the session it names with its prompt.
async function runSessionAt(session: ChainSession, deps: RunDeps, place: SessionPlace = { session: 0 }, start?: Omit<StartPoint, "at"> & { card: number }): Promise<{ outcome: Outcome; card: number }> {
  const { cards } = session;
  if (cards.length === 0) return { outcome: { status: "refused", reason: "This session has no skills." }, card: 0 };
  let card = start?.card ?? 0;
  if (!cards[card]) return { outcome: { status: "refused", reason: "This session has no such card to continue at." }, card: 0 };
  let { label } = cards[card]!;
  let prompt = start?.prompt ?? cardPrompt(cards[card]!);
  let suggestion = start?.suggestion;
  let attended = cards[card]!.pause;
  let chat = false;
  let resume: string | undefined = start?.resume;
  let nudged = false;
  let unattendedTurns = 0;
  // The latest status line the card gave since it started waiting for the user; Continue applies it.
  let latest: { status: Status; text: string } | undefined;
  const stop = (outcome: Outcome) => ({ outcome, card });
  const enter = (next: number, nextSuggestion: Suggestion | undefined) => {
    card = next;
    ({ label } = cards[card]!);
    prompt = cardPrompt(cards[card]!);
    suggestion = nextSuggestion;
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
      enter(next, undefined);
      return { step: ["done", "done"] };
    }
    if (kind === "loop") {
      ({ label } = cards[card]!);
      prompt = cards[card]!.next ?? "Continue.";
      suggestion = status.suggestion;
      attended = false;
    } else {
      enter(card + 1, status.suggestion);
    }
    const fields = plain(clip(suggested(status.suggestion), 300));
    return { step: ["done", fields ? `next: ${fields}` : "next"] };
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
    // A `follow` the editor no longer offers (the card was moved) is kept on the card but not applied, as the editor shows it.
    const { follow, ...unfollowed } = cards[card]!;
    const { model, effort, notes } = turnSettings(follow && afterMskills(cards, card) ? cards[card]! : unfollowed, suggestion, deps.offered, deps.defaultModel);
    const effortSet = effort ? { effort } : {};
    const modelSet = model ? { model } : {};
    deps.emit({ type: "step-started", index, label: shown, ...modelSet, ...effortSet, ...(notes.length > 0 ? { note: notes.join("; ") } : {}), position: { session: place.session, card } });
    const now = deps.now ?? Date.now;
    const began = now();
    const result = await deps.runTurn({ prompt: queued ? `${queued}\n\n${prompt}` : prompt, ...modelSet, ...effortSet, interactive: attended, ...(resume ? { resume } : {}) });
    const stats: TurnStats = { ms: Math.max(0, now() - began), ...(result.usage ? { usage: result.usage } : {}) };
    const sessionId = result.sessionId;
    const finish = ([status, detail]: [StepStatus, string]) => deps.emit({ type: "step-finished", index, status, detail, ...(sessionId ? { sessionId } : {}), stats });

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
  // The run's last card, and the session, model and effort its last turn ran on. No session: the first message starts one.
  card: string;
  sessionId?: string;
  model?: string;
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
    const result = await runTurn({ prompt: move.text, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(resume ? { resume } : {}) });
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

export type ChainDeps = RunDeps & {
  prepareReview(): Promise<ReviewPrep>;
  // The chain as saved, read as session `s` is about to start: the chain to run on with, or why session `s` cannot start.
  pickUp?(s: number, chain: Chain): Promise<Chain | string>;
};

// While session `s` cannot start, the run waits for the user with the reason. Continue looks again; a message does too, and goes in
// front of the session's first prompt once it starts; Stop ends the run halted there, so it can be continued at that session.
async function pickUpAt(s: number, chain: Chain, deps: ChainDeps, pickUp: NonNullable<ChainDeps["pickUp"]>): Promise<Chain | Outcome> {
  const held: string[] = [];
  for (;;) {
    const picked = await pickUp(s, chain);
    if (typeof picked !== "string") {
      if (held.length > 0) deps.talk.giveBack(held);
      return picked;
    }
    const move = await deps.talk.waitForYou({ card: `Session ${s + 1}`, ready: false, signal: deps.signal, parked: picked });
    if (move.kind === "stopped") return { status: "halted", reason: picked, at: { session: s, card: 0 } };
    if (move.kind === "message") held.push(move.text);
  }
}

// Each session is fresh (never a resume), so a reviewer does not share the author's context. A session that opens with the
// uncommitted review first marks the new files so the review sees them. With `from`, the chain picks up at that card: the sessions
// before it are skipped, and a session entered at a later card has its review already prepared. With `pickUp`, each session entered
// at its first card is run as saved then, so edits to sessions not started yet reach the run.
export async function runChain(chain: Chain, deps: ChainDeps, from?: StartPoint): Promise<Outcome> {
  let steps = 0;
  let last: Outcome = { status: "refused", reason: "This chain has no sessions." };
  for (let s = from?.at.session ?? 0; s < chain.sessions.length; s++) {
    if (s > 0 && deps.signal.aborted) return { status: "stopped" };
    let start = from?.at.session === s ? { ...from, card: from.at.card } : undefined;
    // A session with no conversation to resume has not started: it runs as saved, from its first card's own prompt.
    if (deps.pickUp && (start === undefined || (start.card === 0 && start.resume === undefined))) {
      const picked = await pickUpAt(s, chain, deps, deps.pickUp);
      if ("status" in picked) return picked;
      chain = picked;
      start = undefined;
      if (s >= chain.sessions.length) break;
    }
    const session = chain.sessions[s]!;
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
