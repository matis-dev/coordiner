import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage } from "./editor-protocol.ts";
import type { JournalRecord } from "./journal.ts";
import { INTERACTIVE_NOTE, UNATTENDED_NOTE } from "./protocol.ts";
import { actOnChat, createRunChat, IDLE_CHAT } from "./run-chat.ts";

const question = { question: "Which \u001b[31mstore?", options: [{ label: "SQLite" }, { label: "Files (Recommended)" }] };
const said = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }) as unknown as SDKAssistantMessage;
const toolOptions = () => ({ signal: new AbortController().signal }) as Parameters<CanUseTool>[2];

function setup() {
  const posted: ChatMessage[] = [];
  const records: JournalRecord[] = [];
  const logs: string[] = [];
  let moves = 0;
  const waiting: string[] = [];
  const chat = createRunChat({
    title: "Idea · notes",
    post: (m) => void posted.push(m),
    record: (r) => void records.push(r),
    moved: () => void moves++,
    needsYou: (card) => void waiting.push(card),
    log: (line) => void logs.push(line),
  });
  return { chat, posted, records, logs, waiting, moves: () => moves, appended: () => posted.flatMap((m) => (m.type === "chatAppend" ? m.entries : [])), updates: () => posted.filter((m) => m.type === "chatUpdate") };
}

describe("createRunChat", () => {
  it("resets the editor's chat for the new run, titled", () => {
    const { chat, posted } = setup();
    assert.deepEqual(posted, [{ type: "chat", chat: { ...IDLE_CHAT, title: "Idea · notes" }, entries: [] }]);
    assert.deepEqual(chat.view(), { ...IDLE_CHAT, title: "Idea · notes" });
    assert.deepEqual(chat.entries(), []);
  });

  it("sends every change to the editor with the title, and says when the run moves to another card or session", () => {
    const { chat, updates, moves } = setup();
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    chat.talk.send("keep it small");
    assert.equal(moves(), 1);
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    assert.equal(moves(), 1);
    chat.talk.at({ card: "Implement", index: 1, session: 0, attended: false });
    assert.equal(moves(), 2);
    // A card with the same label further on is still a move.
    chat.talk.at({ card: "Implement", index: 2, session: 0, attended: false });
    assert.equal(moves(), 3);
    assert.equal(updates().at(-1)?.type === "chatUpdate" && updates().at(-1)!.chat.title, "Idea · notes");
  });

  it("puts a fresh-context divider in the transcript when a new session starts, not for the first", () => {
    const { chat, appended, moves } = setup();
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    chat.talk.at({ card: "Review", index: 0, session: 1, attended: false });
    chat.talk.at({ card: "Review", index: 0, session: 1, attended: false });
    assert.deepEqual(appended(), [{ kind: "divider", session: 1 }]);
    assert.deepEqual(chat.entries(), [{ kind: "divider", session: 1 }]);
    assert.equal(moves(), 2);
  });

  it("calls for the user once when a card starts waiting and once per new question", async () => {
    const { chat, waiting } = setup();
    chat.talk.at({ card: "Brainstorm", index: 0, session: 0, attended: true });
    const signal = new AbortController().signal;
    const move = chat.talk.waitForYou({ card: "Brainstorm", ready: false, signal });
    chat.talk.send("desktop");
    await move;
    void chat.talk.ask([question], signal);
    chat.talk.send("one more thing");
    assert.deepEqual(waiting, ["Brainstorm", "Brainstorm"]);
  });

  it("does not call for the user when nothing waits for them", () => {
    const { chat, waiting } = setup();
    void chat.talk.ask([question], new AbortController().signal);
    assert.deepEqual(waiting, []);
  });

  it("shows and records what the user said, with the card it went to", () => {
    const { chat, appended, records } = setup();
    chat.talk.at({ card: "Implement", index: 0, session: 0, attended: false });
    chat.talk.send("use the helper");
    chat.talk.takeQueued("Implement");
    assert.deepEqual(appended(), [{ kind: "you", card: "Implement", text: "use the helper" }]);
    assert.deepEqual(records, [{ type: "you", card: "Implement", text: "use the helper" }]);
  });

  it("shows an answer with the model's text made plain, and records it as given", async () => {
    const { chat, appended, records } = setup();
    chat.talk.at({ card: "Brainstorm", index: 0, session: 0, attended: true });
    const answers = chat.talk.ask([question], new AbortController().signal);
    chat.talk.answer(chat.view().question!.id, [{ picked: ["SQLite"] }]);
    await answers;
    assert.deepEqual(appended(), [{ kind: "answer", card: "Brainstorm", question: "Which [31mstore?", answer: "SQLite" }]);
    assert.deepEqual(records, [{ type: "answer", card: "Brainstorm", question: "Which \u001b[31mstore?", answer: "SQLite" }]);
  });
});

describe("createRunChat: forTurn", () => {
  it("gives an unattended turn the unattended note and Recommended answers", async () => {
    const { chat, logs, waiting } = setup();
    const setupTurn = chat.forTurn(false);
    assert.equal(setupTurn.systemPromptAppend, UNATTENDED_NOTE);
    const result = await setupTurn.canUseTool("AskUserQuestion", { questions: [question] }, toolOptions());
    assert.deepEqual(result?.behavior === "allow" && result.updatedInput?.answers, { "Which \u001b[31mstore?": "Files (Recommended)" });
    assert.equal(logs.length, 1);
    assert.deepEqual(waiting, []);
  });

  it("gives an interactive turn the interactive note, and asks the user", async () => {
    const { chat } = setup();
    chat.talk.at({ card: "Brainstorm", index: 0, session: 0, attended: true });
    const setupTurn = chat.forTurn(true);
    assert.equal(setupTurn.systemPromptAppend, INTERACTIVE_NOTE);
    const pending = setupTurn.canUseTool("AskUserQuestion", { questions: [question] }, toolOptions());
    chat.talk.answer(chat.view().question!.id, [{ picked: [], other: "Postgres" }]);
    const result = await pending;
    assert.deepEqual(result?.behavior === "allow" && result.updatedInput?.answers, { "Which \u001b[31mstore?": "Postgres" });
  });

  it("puts the turn's messages in the transcript under the card that is running, or none before any turn", () => {
    const { chat, appended } = setup();
    chat.forTurn(false).onMessage(said("early"));
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    chat.forTurn(false).onMessage(said("Reading the code."));
    chat.forTurn(false).onMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [] } } as unknown as SDKAssistantMessage);
    assert.deepEqual(appended(), [
      { kind: "assistant", card: "", text: "early" },
      { kind: "assistant", card: "Plan", text: "Reading the code." },
    ]);
  });
});

describe("actOnChat", () => {
  it("passes each chat message to the run's chat, and stops the run on chatStop", async () => {
    const { chat } = setup();
    let stopped = 0;
    const stop = () => void stopped++;
    chat.talk.at({ card: "Implement", index: 0, session: 0, attended: false });
    assert.equal(actOnChat(chat.talk, stop, { type: "chatSend", text: "one" }), true);
    assert.equal(actOnChat(chat.talk, stop, { type: "chatSend", text: "  " }), false);
    const id = chat.view().queued[0]!.id;
    assert.equal(actOnChat(chat.talk, stop, { type: "chatWithdraw", id }), true);
    assert.deepEqual(chat.view().queued, []);
    assert.equal(actOnChat(chat.talk, stop, { type: "chatPause" }), true);
    assert.equal(chat.view().pausePending, true);
    const move = chat.talk.waitForYou({ card: "Implement", ready: true, signal: new AbortController().signal });
    assert.equal(actOnChat(chat.talk, stop, { type: "chatContinue" }), true);
    assert.deepEqual(await move, { kind: "continue" });
    assert.equal(actOnChat(chat.talk, stop, { type: "chatAnswer", id: "q9", picks: [{ picked: ["SQLite"] }] }), false);
    assert.equal(actOnChat(chat.talk, stop, { type: "chatStop" }), true);
    assert.equal(stopped, 1);
  });
});
