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
  question?: { id: string; card: string; questions: Question[] };
  // The latest reply carried a status line, so the card says where the chain goes next.
  continueReady: boolean;
  pausePending: boolean;
  // Messages still queued when the run ended, joined; they go back to the user.
  returned?: string;
};

export type TalkHooks = {
  changed(snapshot: TalkSnapshot): void;
  delivered(card: string, text: string): void;
  answered(card: string, question: string, answer: string): void;
};

export type WaitRequest = { card: string; nextCard?: string; ready: boolean; signal: AbortSignal };

// Settles once: on the user's move, or with "stopped" when the run aborts.
type Waiter = { card: string; settle(move: Move): void };
type Asking = { id: string; card: string; questions: Question[]; resolve(answers: Record<string, string>): void; reject(error: Error): void };

export class Talk {
  private readonly hooks: TalkHooks;
  private state: TalkSnapshot = { phase: "idle", attended: false, queued: [], continueReady: false, pausePending: false };
  private waiter?: Waiter;
  private asking?: Asking;
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
    const { nextCard: _gone, nextSession: _old, ...rest } = this.state;
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

  pausePending(): boolean {
    return this.state.pausePending;
  }

  // The card waits for the user. What they queued during the turn is their first message, so it is sent at once.
  waitForYou({ card, nextCard, ready, signal }: WaitRequest): Promise<Move> {
    const { nextCard: _gone, ...rest } = this.state;
    this.update({ ...rest, phase: "waiting", card, attended: true, continueReady: ready, pausePending: false, ...(nextCard ? { nextCard } : {}) });
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
  ask(questions: Question[], signal: AbortSignal): Promise<Record<string, string>> {
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
      this.update({ ...this.state, question: { id, card, questions } });
    });
  }

  // The run is over: nothing more is sent, and what was still queued goes back to the user.
  end(): void {
    const returned = this.state.queued.map((q) => q.text).join("\n\n");
    this.closeQuestion()?.reject(new Error("the run has stopped"));
    const { nextCard: _gone, nextSession: _old, ...rest } = this.state;
    this.update({ ...rest, phase: "ended", attended: false, queued: [], continueReady: false, pausePending: false, ...(returned ? { returned } : {}) });
    this.waiter?.settle({ kind: "stopped" });
  }

  // ── The user, through the chat ──────────────────────────────────────────────

  // While a card waits, the message is its next turn; otherwise it is queued for the next turn. False when it was refused.
  send(text: string): boolean {
    const { phase } = this.state;
    if (text.trim() === "" || text.length > MAX_INPUT_CHARS || phase === "idle" || phase === "ended") return false;
    if (this.waiter) {
      this.hooks.delivered(this.waiter.card, text);
      this.waiter.settle({ kind: "message", text });
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

  continue(): void {
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
    this.update({ ...this.state, phase: this.state.phase === "ended" ? "ended" : "running", continueReady: false });
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
