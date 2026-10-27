import type { CanUseTool, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CacheClock, TurnClock } from "./chat-logic.ts";
import type { ChatMessage, ChatView, EditorMessage, Ending } from "./editor-protocol.ts";
import type { JournalRecord } from "./journal.ts";
import { AFTER_NOTE, INTERACTIVE_NOTE, UNATTENDED_NOTE } from "./protocol.ts";
import type { Outcome } from "./run.ts";
import { Talk, type TalkSnapshot } from "./talk.ts";
import { plain } from "./text.ts";
import { endEntry, entriesFrom, Transcript, type Entry } from "./transcript.ts";
import { interactiveCanUseTool, unattendedCanUseTool } from "./unattended.ts";

// One run's chat, wired to the outside: the chains editor (through `post`), the journal, and the editor's attention. Kept out of
// src/extension.ts so it can be tested; the extension only supplies these functions.

export const IDLE_CHAT: ChatView = { phase: "idle", attended: false, queued: [], continueReady: false, pausePending: false };

export type RunChatDeps = {
  title: string;
  post(message: ChatMessage): void;
  record(record: JournalRecord): void;
  // The card or session the run is on changed: the lanes mark the running card.
  moved(): void;
  // A card started waiting for the user, or asked them something.
  needsYou(card: string): void;
  log(line: string): void;
  now?: () => number;
};

const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
type Usage = { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null } | undefined;

// Every response refreshes the cache. Its lifetime shows in what the response wrote to the cache; a response that wrote nothing
// keeps the lifetime seen before, and before any is seen five minutes is assumed.
export function cacheFrom(usage: Usage, now: number, previous?: CacheClock): CacheClock {
  const written = usage?.cache_creation;
  if ((written?.ephemeral_1h_input_tokens ?? 0) > 0) return { since: now, ttlMs: ONE_HOUR, assumed: false };
  if ((written?.ephemeral_5m_input_tokens ?? 0) > 0) return { since: now, ttlMs: FIVE_MINUTES, assumed: false };
  return { since: now, ttlMs: previous?.ttlMs ?? FIVE_MINUTES, assumed: previous?.assumed ?? true };
}

// What one turn of the session gets: the note, how its tools are decided, and where its messages go.
export type TurnSetup = { canUseTool: CanUseTool; systemPromptAppend: string; onMessage(message: SDKAssistantMessage): void };
// A turn nobody is present for, one the user is present for, or one after the run has ended (the user is present).
export type TurnMode = "unattended" | "interactive" | "after";

export type RunChat = {
  talk: Talk;
  view(): ChatView;
  entries(): Entry[];
  forTurn(mode: TurnMode): TurnSetup;
  // The run is over: the transcript says how it ended. With `after`, the chat stays open on the run's last session.
  ended(outcome: Outcome, after?: { card: string }): void;
  // A turn of the chat after the run failed.
  failed(card: string, error: string): void;
};

export function createRunChat({ title, post, record, moved, needsYou, log, now = Date.now }: RunChatDeps): RunChat {
  const transcript = new Transcript();
  const add = (entries: Entry[]) => {
    if (entries.length === 0) return;
    transcript.add(entries);
    post({ type: "chatAppend", entries });
  };
  let shown: TalkSnapshot | undefined;
  let cache: CacheClock | undefined;
  let turn: TurnClock | undefined;
  let ending: Ending | undefined;
  const viewOf = (snapshot: TalkSnapshot): ChatView => ({
    ...snapshot,
    title,
    ...(snapshot.phase === "waiting" && cache ? { cache } : {}),
    ...(snapshot.phase === "running" && turn ? { turn } : {}),
    ...(ending ? { ending } : {}),
  });
  const talk = new Talk({
    changed: (snapshot) => {
      const before = shown;
      shown = snapshot;
      // A turn's clock starts when a card starts running, or when the run moves to another card; answers sent are activity.
      if (snapshot.phase === "running") {
        const at = now();
        if (before?.phase !== "running" || snapshot.card !== before.card || snapshot.index !== before.index || snapshot.session !== before.session) turn = { since: at, lastAt: at };
        else if (before.question && !snapshot.question) turn = { ...turn!, lastAt: at };
      }
      if (snapshot.session !== undefined && snapshot.session !== (before?.session ?? 0)) add([{ kind: "divider", session: snapshot.session }]);
      post({ type: "chatUpdate", chat: viewOf(snapshot) });
      if (snapshot.index !== before?.index || snapshot.session !== before?.session) moved();
      const asked = snapshot.question !== undefined && snapshot.question.id !== before?.question?.id;
      // After the run the chat waits after every reply, and the run's own announcement already says it ended.
      const waits = snapshot.phase === "waiting" && before?.phase !== "waiting" && !snapshot.afterRun;
      if (snapshot.card && (asked || waits)) needsYou(snapshot.card);
    },
    delivered: (card, text) => {
      add([{ kind: "you", card, text }]);
      record({ type: "you", card, text });
    },
    answered: (card, question, answer) => {
      add([{ kind: "answer", card, question: plain(question), answer: plain(answer) }]);
      record({ type: "answer", card, question, answer });
    },
  });
  const view = (): ChatView => viewOf(talk.snapshot());
  post({ type: "chat", chat: view(), entries: [] });
  return {
    talk,
    view,
    entries: () => transcript.entries(),
    forTurn: (mode) => ({
      canUseTool: mode === "unattended" ? unattendedCanUseTool(log) : interactiveCanUseTool((questions, signal) => talk.ask(questions, signal), log),
      systemPromptAppend: NOTES[mode],
      onMessage: (message) => {
        cache = cacheFrom(message.message.usage, now(), cache);
        const snapshot = talk.snapshot();
        const entries = entriesFrom(message, snapshot.card ?? "");
        add(entries);
        if (snapshot.phase !== "running" || !turn) return;
        const tool = entries.findLast((e) => e.kind === "tool");
        turn = { ...turn, lastAt: now(), ...(tool?.kind === "tool" ? { last: tool.name } : {}) };
        post({ type: "chatUpdate", chat: viewOf(snapshot) });
      },
    }),
    ended: (outcome, after) => {
      const entry = endEntry(outcome);
      add([entry]);
      const { kind: _end, ...how } = entry;
      ending = how;
      talk.end(after ? { after } : {});
    },
    failed: (card, error) => add([{ kind: "failed", card, error: plain(error) }]),
  };
}

const NOTES: Record<TurnMode, string> = { unattended: UNATTENDED_NOTE, interactive: INTERACTIVE_NOTE, after: AFTER_NOTE };

export type ChatAction = Extract<EditorMessage, { type: `chat${string}` }>;

// What the extension does for the chat: stop the run (or end the chat after it), and the actions once the run has ended.
export type ChatActions = { stop(): void; copyResume(): void; nextChain(): void };

// Acts on a message from the chat. False when the run's chat refused it (a stale question, an empty message); Talk decides.
export function actOnChat(talk: Talk, { stop, copyResume, nextChain }: ChatActions, message: ChatAction): boolean {
  switch (message.type) {
    case "chatSend":
      return talk.send(message.text);
    case "chatWithdraw":
      talk.withdraw(message.id);
      return true;
    case "chatPause":
      talk.requestPause();
      return true;
    case "chatContinue":
      talk.continue();
      return true;
    case "chatAnswer":
      return talk.answer(message.id, message.picks);
    case "chatStop":
      stop();
      return true;
    case "chatCopyResume":
      copyResume();
      return true;
    case "chatNextChain":
      nextChain();
      return true;
  }
}
