import type { CanUseTool, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage, ChatView, EditorMessage } from "./editor-protocol.ts";
import type { JournalRecord } from "./journal.ts";
import { INTERACTIVE_NOTE, UNATTENDED_NOTE } from "./protocol.ts";
import { Talk, type TalkSnapshot } from "./talk.ts";
import { plain } from "./text.ts";
import { entriesFrom, Transcript, type Entry } from "./transcript.ts";
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
};

// What one turn of the session gets: the note, how its tools are decided, and where its messages go.
export type TurnSetup = { canUseTool: CanUseTool; systemPromptAppend: string; onMessage(message: SDKAssistantMessage): void };

export type RunChat = {
  talk: Talk;
  view(): ChatView;
  entries(): Entry[];
  forTurn(interactive: boolean): TurnSetup;
};

export function createRunChat({ title, post, record, moved, needsYou, log }: RunChatDeps): RunChat {
  const transcript = new Transcript();
  const add = (entries: Entry[]) => {
    if (entries.length === 0) return;
    transcript.add(entries);
    post({ type: "chatAppend", entries });
  };
  let shown: TalkSnapshot | undefined;
  const talk = new Talk({
    changed: (snapshot) => {
      const before = shown;
      shown = snapshot;
      if (snapshot.session !== undefined && snapshot.session !== (before?.session ?? 0)) add([{ kind: "divider", session: snapshot.session }]);
      post({ type: "chatUpdate", chat: { ...snapshot, title } });
      if (snapshot.index !== before?.index || snapshot.session !== before?.session) moved();
      const asked = snapshot.question !== undefined && snapshot.question.id !== before?.question?.id;
      if (snapshot.card && (asked || (snapshot.phase === "waiting" && before?.phase !== "waiting"))) needsYou(snapshot.card);
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
  const view = (): ChatView => ({ ...talk.snapshot(), title });
  post({ type: "chat", chat: view(), entries: [] });
  return {
    talk,
    view,
    entries: () => transcript.entries(),
    forTurn: (interactive) => ({
      canUseTool: interactive ? interactiveCanUseTool((questions, signal) => talk.ask(questions, signal), log) : unattendedCanUseTool(log),
      systemPromptAppend: interactive ? INTERACTIVE_NOTE : UNATTENDED_NOTE,
      onMessage: (message) => add(entriesFrom(message, talk.snapshot().card ?? "")),
    }),
  };
}

export type ChatAction = Extract<EditorMessage, { type: `chat${string}` }>;

// Acts on a message from the chat. False when the run's chat refused it (a stale question, an empty message); Talk decides.
export function actOnChat(talk: Talk, stop: () => void, message: ChatAction): boolean {
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
  }
}
