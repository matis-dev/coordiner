import { MAX_INPUT_CHARS } from "./chains.ts";
import { checkAnswers, type Pick } from "./chat-logic.ts";
import type { Question } from "./unattended.ts";

// The run's chat for one run: what the user has queued, whether they asked to pause, the card waiting for them, and the question
// it asked. The run engine and the chat webview both talk to it; it never talks to the model itself.

export type Move = { kind: "message"; text: string } | { kind: "continue" } | { kind: "stopped" };
export type Queued = { id: string; text: string };

export type TalkSnapshot = {
  phase: "idle" | "running" | "waiting" | "ended";
  // The card running, or waiting for the user, its place in its session, and the session it belongs to (0 for the first).
  card?: string;
  index?: number;
  session?: number;
  // True while the card is talking with the user: a card that pauses, or one the user paused.
  attended: boolean;
  // When the running card is the last of its session: the card a queued message reaches, in a fresh context, if this one finishes.
  nextSession?: string;
  // What Continue moves on to; undefined when nothing follows in this session.
  nextCard?: string;
  queued: Queued[];
  // `expiresAt`: when the Recommended option is taken instead, if the run does not wait for the user.
  question?: { id: string; card: string; questions: Question[]; expiresAt?: number };
  // The latest reply carried a status line, so the card says where the chain goes next.
  continueReady: boolean;
  pausePending: boolean;
  // Messages still queued when the run ended, joined; they go back to the user.
  returned?: string;
  // The run has ended and the chat stays on its last session: each message is a turn of it (talkOn).
  afterRun?: boolean;
  // Why the waiting card stopped (a halt, a failed turn, the turn cap): Continue retries it, a message is a turn of it.
  parked?: string;
};

export type TalkHooks = {
  changed(snapshot: TalkSnapshot): void;
  delivered(card: string, text: string): void;
  answered(card: string, question: string, answer: string): void;
};

export type WaitRequest = { card: string; nextCard?: string; ready: boolean; signal: AbortSignal; parked?: string };

// Settles once: on the user's move, or with "stopped" when the run aborts.
type Waiter = { card: string; settle(move: Move): void };
type Asking = { id: string; card: string; questions: Question[]; resolve(answers: Record<string, string>): void; reject(error: Error): void };

export class Talk {
  private readonly hooks: TalkHooks;
  private state: TalkSnapshot = { phase: "idle", attended: false, queued: [], continueReady: false, pausePending: false };
  private waiter?: Waiter;
  private asking?: Asking;
  private inject?: (text: string) => boolean;
  private ids = 0;

  constructor(hooks: TalkHooks) {
    this.hooks = hooks;
  }

  snapshot(): TalkSnapshot {
    const { question, queued, ...rest } = this.state;
    return { ...rest, queued: queued.map((q) => ({ ...q })), ...(question ? { question: { ...question, questions: [...question.questions] } } : {}) };
  }

  // ── The run engine ──────────────────────────────────────────────────────────

  // A turn of `card` is about to run.
  at({ card, index, session, attended, nextSession }: { card: string; index: number; session: number; attended: boolean; nextSession?: string }): void {
    const { nextCard: _gone, nextSession: _old, parked: _was, ...rest } = this.state;
    this.update({ ...rest, phase: "running", card, index, session, attended, continueReady: false, ...(nextSession ? { nextSession } : {}) });
  }

  // What the user queued, for the turn of `card` about to run; the queue is empty afterwards.
  takeQueued(card: string): string | undefined {
    const { queued } = this.state;
    if (queued.length === 0) return undefined;
    const text = queued.map((q) => q.text).join("\n\n");
    this.update({ ...this.state, queued: [] });
    this.hooks.delivered(card, text);
    return text;
  }

  // The running turn's way in for a message (TurnControl.inject), while a turn runs; undefined between turns.
  injectInto(inject?: (text: string) => boolean): void {
    this.inject = inject;
  }

  // Messages a turn took but ended before starting (it failed or was stopped) go back in front of the queue: the next turn gets
  // them, or the user does when the run ends. Once the chat has ended, they go straight back to the user.
  giveBack(texts: readonly string[]): void {
    if (this.state.phase === "ended") {
      this.update({ ...this.state, returned: [this.state.returned, ...texts].filter(Boolean).join("\n\n") });
      return;
    }
    this.update({ ...this.state, queued: [...texts.map((text) => ({ id: this.nextId("m"), text })), ...this.state.queued] });
  }

  pausePending(): boolean {
    return this.state.pausePending;
  }

  // The card waits for the user. What they queued during the turn is their first message, so it is sent at once.
  waitForYou({ card, nextCard, ready, signal, parked }: WaitRequest): Promise<Move> {
    const { nextCard: _gone, parked: _was, ...rest } = this.state;
    this.update({ ...rest, phase: "waiting", card, attended: true, continueReady: ready, pausePending: false, ...(nextCard ? { nextCard } : {}), ...(parked ? { parked } : {}) });
    if (signal.aborted) return Promise.resolve(this.resume({ kind: "stopped" }));
    const queued = this.takeQueued(card);
    if (queued !== undefined) return Promise.resolve(this.resume({ kind: "message", text: queued }));
    return new Promise<Move>((resolve) => {
      const onAbort = () => this.waiter?.settle({ kind: "stopped" });
      this.waiter = {
        card,
        settle: (move) => {
          this.waiter = undefined;
          signal.removeEventListener("abort", onAbort);
          resolve(this.resume(move));
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // A skill's question, answered by the user in the chat. One question is open at a time.
  ask(questions: Question[], signal: AbortSignal, expiresAt?: number): Promise<Record<string, string>> {
    if (this.asking) return Promise.reject(new Error("another question is already open"));
    if (signal.aborted || this.state.phase === "ended") return Promise.reject(new Error("the run has stopped"));
    const id = this.nextId("q");
    const card = this.state.card ?? "";
    return new Promise((resolve, reject) => {
      const onAbort = () => this.closeQuestion()?.reject(new Error("the run has stopped"));
      this.asking = {
        id,
        card,
        questions,
        resolve: (answers) => {
          signal.removeEventListener("abort", onAbort);
          resolve(answers);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.update({ ...this.state, question: { id, card, questions, ...(expiresAt !== undefined ? { expiresAt } : {}) } });
    });
  }

  // The run is over, and what was still queued goes back to the user. With `after`, the chat stays open on the run's last session,
  // waiting for the user as `after.card`; otherwise nothing more is sent.
  end({ after }: { after?: { card: string } } = {}): void {
    const returned = this.state.queued.map((q) => q.text).join("\n\n");
    this.closeQuestion()?.reject(new Error("the run has stopped"));
    this.waiter?.settle({ kind: "stopped" });
    const { nextCard: _gone, nextSession: _old, afterRun: _was, parked: _left, ...rest } = this.state;
    const open = after ? ({ phase: "waiting", card: after.card, attended: true, afterRun: true } as const) : ({ phase: "ended", attended: false } as const);
    this.update({ ...rest, ...open, queued: [], continueReady: false, pausePending: false, ...(returned ? { returned } : {}) });
  }

  // ── The user, through the chat ──────────────────────────────────────────────

  // While a card waits, the message is its next turn. While one runs, the turn takes it at once when it can; otherwise, or behind
  // messages already queued, it is queued for the next turn. False when it was refused.
  send(text: string): boolean {
    const { phase } = this.state;
    if (text.trim() === "" || text.length > MAX_INPUT_CHARS || phase === "idle" || phase === "ended") return false;
    if (this.waiter) {
      this.hooks.delivered(this.waiter.card, text);
      this.waiter.settle({ kind: "message", text });
      return true;
    }
    if (phase === "running" && this.state.queued.length === 0 && this.inject?.(text)) {
      this.hooks.delivered(this.state.card!, text);
      return true;
    }
    this.update({ ...this.state, queued: [...this.state.queued, { id: this.nextId("m"), text }] });
    return true;
  }

  withdraw(id: string): void {
    if (!this.state.queued.some((q) => q.id === id)) return;
    this.update({ ...this.state, queued: this.state.queued.filter((q) => q.id !== id) });
  }

  // Takes effect when the running turn ends; a card already talking with the user has nothing to pause.
  requestPause(): void {
    if (this.state.phase !== "running" || this.state.attended || this.state.pausePending) return;
    this.update({ ...this.state, pausePending: true });
  }

  // After the run there is no chain to continue.
  continue(): void {
    if (this.state.afterRun) return;
    this.waiter?.settle({ kind: "continue" });
  }

  // False for an answer to a question that is no longer open, or one that does not fit the question.
  answer(id: string, picks: readonly Pick[]): boolean {
    if (this.asking?.id !== id) return false;
    const answers = checkAnswers(this.asking.questions, picks);
    if (!answers) return false;
    const asking = this.closeQuestion()!;
    for (const [question, answer] of Object.entries(answers)) this.hooks.answered(asking.card, question, answer);
    asking.resolve(answers);
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private resume(move: Move): Move {
    const { parked: _was, ...rest } = this.state;
    this.update({ ...rest, phase: this.state.phase === "ended" ? "ended" : "running", continueReady: false });
    return move;
  }

  private closeQuestion(): Asking | undefined {
    const asking = this.asking;
    if (!asking) return undefined;
    this.asking = undefined;
    const { question: _gone, ...rest } = this.state;
    this.update(rest);
    return asking;
  }

  private nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}${this.ids}`;
  }

  private update(state: TalkSnapshot): void {
    this.state = state;
    this.hooks.changed(this.snapshot());
  }
}
