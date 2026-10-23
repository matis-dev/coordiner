import { MAX_INPUT_CHARS } from "./chains.ts";
import type { ChatView } from "./editor-protocol.ts";
import type { Entry } from "./transcript.ts";
import type { Question } from "./unattended.ts";

// The decisions behind the run's chat, kept out of the DOM script so they can be tested. The webview loads this module from dist/,
// so it imports nothing at runtime beyond chains.ts.

// The most transcript entries kept, by the extension and by the chat on the page alike; older ones are dropped.
export const MAX_ENTRIES = 1000;

// The prompt cache of the session a card waits in: warm from `since` for `ttlMs`. `assumed` when the session never said which
// lifetime it writes, and five minutes is taken.
export type CacheClock = { since: number; ttlMs: number; assumed: boolean };

const pad = (n: number): string => String(n).padStart(2, "0");
function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
}

// Worked out from the clock each time, never counted down, so a computer that slept shows the right time when it wakes.
export function cacheLabel(cache: CacheClock, now: number): { text: string; expired: boolean } {
  const left = cache.since + cache.ttlMs - now;
  const assumed = cache.assumed ? " (assumed 5-minute cache)" : "";
  if (left <= 0) return { text: `Prompt cache expired: your next message re-reads the whole conversation without the cache discount.${assumed}`, expired: true };
  return { text: `Prompt cache warm for ${clock(left)}${assumed}`, expired: false };
}

// What the user chose for one question: offered labels, and their own text when they picked Other.
export type Pick = { picked: string[]; other?: string };

// Answers reach the skill keyed by question text, several choices joined as an unattended answer joins them. Anything that is not
// an offered label, or text the user did not mark as Other, is refused.
export function checkAnswers(questions: readonly Question[], picks: readonly Pick[]): Record<string, string> | undefined {
  if (picks.length !== questions.length) return undefined;
  const answers: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const { picked, other } = picks[i]!;
    const labels = q.options.map((o) => o.label);
    if (new Set(picked).size !== picked.length || !picked.every((label) => labels.includes(label))) return undefined;
    const typed = other?.trim();
    if (other !== undefined && (!typed || other.length > MAX_INPUT_CHARS)) return undefined;
    const chosen = typed ? [...picked, typed] : picked;
    if (chosen.length === 0 || (!q.multiSelect && chosen.length > 1)) return undefined;
    answers[q.question] = chosen.join(", ");
  }
  return answers;
}

// The first question whose pick does not fit it, or -1 when every one does; the form moves focus there.
export const firstUnanswered = (questions: readonly Question[], picks: readonly Pick[]): number =>
  questions.findIndex((q, i) => checkAnswers([q], [picks[i] ?? { picked: [] }]) === undefined);

export const canSend = (chat: ChatView): boolean => chat.phase === "running" || chat.phase === "waiting";
export const canPause = (chat: ChatView): boolean => chat.phase === "running" && !chat.attended && !chat.pausePending;

export function statusLine(chat: ChatView): string {
  switch (chat.phase) {
    case "idle":
      return "No run yet. A run shows here, and a card that pauses waits for you here.";
    case "running":
      return chat.attended ? `${chat.card} is working on your message…` : `${chat.card} is working…`;
    case "waiting":
      return chat.continueReady ? `${chat.card} is waiting for you. It gave its status line, so Continue moves the chain on.` : `${chat.card} is waiting for you.`;
    case "ended":
      return "The run has ended.";
  }
}

// Where a queued message goes. If the card ends its session first, it goes to the next session, which starts a fresh context.
export function destination(chat: ChatView): string {
  if (chat.nextSession) return `the next turn of ${chat.card}, or ${chat.nextSession} in a fresh context if ${chat.card} finishes`;
  return `the next turn of ${chat.card}`;
}

export const continueLabel = (chat: ChatView): string => (chat.nextCard ? `Continue to ${chat.nextCard}` : "Continue the chain");

// The one line the status region speaks for a change, most important first; nothing for a change that needs no word.
export function announcement(prev: ChatView | undefined, next: ChatView): string | undefined {
  const q = next.question;
  if (q && prev?.question?.id !== q.id) {
    const first = q.questions[0]!;
    return q.questions.length > 1 ? `${q.card} asks ${q.questions.length} questions` : `${q.card} asks: ${first.header || first.question}`;
  }
  if (next.phase === "waiting" && prev?.phase !== "waiting") return next.continueReady ? `${next.card} is waiting for you; Continue is ready` : `${next.card} is waiting for you`;
  if (next.returned && !prev?.returned) return "The run ended before your message was sent; it is back in the message box.";
  if (next.phase === "ended" && prev?.phase !== "ended") return "The run has ended.";
  if (next.queued.length > (prev?.queued.length ?? 0)) return `Message queued for ${destination(next)}`;
  if (next.pausePending && !prev?.pausePending) return `${next.card} will wait for you after this turn`;
  return undefined;
}

// New transcript entries are not a live region; a reply is announced by who gave it, and tool calls are not announced at all.
export function entriesAnnouncement(entries: readonly Entry[]): string | undefined {
  const reply = entries.findLast((e) => e.kind === "assistant");
  return reply ? `${reply.card} replied` : undefined;
}

// The chat's height, as a share of the window: the divider above it moves in steps between these bounds.
export const CHAT_HEIGHT = { min: 15, max: 80, initial: 35, step: 5 } as const;

const clampHeight = (n: number): number => Math.min(CHAT_HEIGHT.max, Math.max(CHAT_HEIGHT.min, Math.round(n)));

// Up makes the chat taller, down shorter; Home and End go to the smallest and the largest. Any other key is not the divider's.
export function heightForKey(height: number, key: string): number | undefined {
  switch (key) {
    case "ArrowUp":
      return clampHeight(height + CHAT_HEIGHT.step);
    case "ArrowDown":
      return clampHeight(height - CHAT_HEIGHT.step);
    case "Home":
      return CHAT_HEIGHT.min;
    case "End":
      return CHAT_HEIGHT.max;
    default:
      return undefined;
  }
}

// Dragging puts the divider under the pointer: the chat takes the window below it.
export const heightFromPointer = (clientY: number, windowHeight: number): number => clampHeight(((windowHeight - clientY) / windowHeight) * 100);

// The saved state is the webview's own, but it is read defensively: anything but a number falls back to the initial height.
export const savedHeight = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? clampHeight(value) : CHAT_HEIGHT.initial);
