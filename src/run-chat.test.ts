import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage } from "./editor-protocol.ts";
import type { JournalRecord } from "./journal.ts";
import { AFTER_NOTE, INTERACTIVE_NOTE, UNATTENDED_NOTE } from "./protocol.ts";
import type { Entry } from "./transcript.ts";
import { actOnChat, cacheFrom, createRunChat, IDLE_CHAT } from "./run-chat.ts";
import { QUESTION_WAIT_MS, type QuestionWait } from "./unattended.ts";

const question = { question: "Which \u001b[31mstore?", options: [{ label: "SQLite" }, { label: "Files (Recommended)" }] };
const said = (text: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }) as unknown as SDKAssistantMessage;
const toolOptions = () => ({ signal: new AbortController().signal }) as Parameters<CanUseTool>[2];

function setup(now = () => 0, questions: QuestionWait = "never", sleep?: (ms: number, signal: AbortSignal) => Promise<void>, past?: Entry[]) {
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
    questions,
    now,
    ...(sleep ? { sleep } : {}),
    ...(past ? { past } : {}),
  });
  return { chat, posted, records, logs, waiting, moves: () => moves, appended: () => posted.flatMap((m) => (m.type === "chatAppend" ? m.entries : [])), updates: () => posted.filter((m) => m.type === "chatUpdate") };
}

describe("cacheFrom", () => {
  const wrote = (h1: number, m5: number) => ({ cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 } });

  it("reads the lifetime from what the response wrote to the cache", () => {
    assert.deepEqual(cacheFrom(wrote(10, 0), 7), { since: 7, ttlMs: 3_600_000, assumed: false });
    assert.deepEqual(cacheFrom(wrote(0, 10), 7), { since: 7, ttlMs: 300_000, assumed: false });
  });

  it("keeps the lifetime seen before when a response wrote nothing, and assumes five minutes before any is seen", () => {
    const hour = { since: 1, ttlMs: 3_600_000, assumed: false };
    assert.deepEqual(cacheFrom(wrote(0, 0), 9, hour), { since: 9, ttlMs: 3_600_000, assumed: false });
    assert.deepEqual(cacheFrom({ cache_creation: null }, 9), { since: 9, ttlMs: 300_000, assumed: true });
    assert.deepEqual(cacheFrom(undefined, 9), { since: 9, ttlMs: 300_000, assumed: true });
  });
});

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

  it("says the run moved when its card starts or stops waiting for the user, so the lanes and the Sessions view mark it", async () => {
    const { chat, moves } = setup();
    chat.talk.at({ card: "Brainstorm", index: 0, session: 0, attended: true });
    assert.equal(moves(), 1);
    const signal = new AbortController().signal;
    const wait = chat.talk.waitForYou({ card: "Brainstorm", ready: false, signal });
    assert.equal(moves(), 2);
    chat.talk.send("desktop");
    await wait;
    assert.equal(moves(), 3);
    void chat.talk.ask([question], signal);
    assert.equal(moves(), 4);
    chat.talk.send("one more thing");
    assert.equal(moves(), 4);
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

  it("tells the editor how long the cache stays warm only while a card waits, from the card's last response", () => {
    let clock = 50;
    const { chat, updates } = setup(() => clock);
    chat.talk.at({ card: "Brainstorm", index: 0, session: 0, attended: true });
    const message = { ...said("hi"), message: { content: [], usage: { cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } } } } as unknown as SDKAssistantMessage;
    chat.forTurn("interactive").onMessage(message);
    clock = 90;
    chat.talk.at({ card: "Brainstorm", index: 0, session: 0, attended: true });
    assert.equal(chat.view().cache, undefined);
    void chat.talk.waitForYou({ card: "Brainstorm", ready: false, signal: new AbortController().signal });
    const last = updates().at(-1)!;
    assert.deepEqual(last.type === "chatUpdate" && last.chat.cache, { since: 50, ttlMs: 3_600_000, assumed: false });
    assert.deepEqual(chat.view().cache, { since: 50, ttlMs: 3_600_000, assumed: false });
  });

  it("clocks a running turn from when its card starts running, and stamps its last activity and tool", () => {
    let clock = 100;
    const { chat, updates } = setup(() => clock);
    const tool = (name: string) => ({ ...said(""), message: { content: [{ type: "tool_use", name, input: {} }] } }) as unknown as SDKAssistantMessage;
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    assert.deepEqual(chat.view().turn, { since: 100, lastAt: 100 });
    clock = 200;
    chat.forTurn("unattended").onMessage(tool("Bash"));
    assert.deepEqual(chat.view().turn, { since: 100, lastAt: 200, last: "Bash" });
    const last = updates().at(-1)!;
    assert.deepEqual(last.type === "chatUpdate" && last.chat.turn, { since: 100, lastAt: 200, last: "Bash" });
    clock = 300;
    chat.forTurn("unattended").onMessage(said("thinking out loud"));
    assert.deepEqual(chat.view().turn, { since: 100, lastAt: 300, last: "Bash" }, "a reply keeps the last tool");
    clock = 400;
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    assert.equal(chat.view().turn?.since, 100, "another turn of the same card keeps the clock");
    chat.talk.at({ card: "Implement", index: 1, session: 0, attended: false });
    assert.deepEqual(chat.view().turn, { since: 400, lastAt: 400 });
  });

  it("counts the user's answers as activity, and shows no clock while the card waits", async () => {
    let clock = 0;
    const { chat } = setup(() => clock);
    chat.talk.at({ card: "Brainstorm", index: 0, session: 0, attended: true });
    const answers = chat.talk.ask([question], new AbortController().signal);
    clock = 50;
    chat.talk.answer(chat.view().question!.id, [{ picked: ["SQLite"] }]);
    await answers;
    assert.deepEqual(chat.view().turn, { since: 0, lastAt: 50 });
    void chat.talk.waitForYou({ card: "Brainstorm", ready: false, signal: new AbortController().signal });
    assert.equal(chat.view().turn, undefined);
  });

  it("sends no turn update for a message outside a running turn", () => {
    const { chat, updates } = setup();
    chat.forTurn("unattended").onMessage(said("early"));
    assert.equal(updates().length, 0);
    void chat.talk.waitForYou({ card: "Brainstorm", ready: false, signal: new AbortController().signal });
    const before = updates().length;
    chat.forTurn("interactive").onMessage(said("late"));
    assert.equal(updates().length, before);
  });

  it("sends no cache while a card waits before any response arrived", () => {
    const { chat } = setup();
    void chat.talk.waitForYou({ card: "Brainstorm", ready: false, signal: new AbortController().signal });
    assert.equal(chat.view().phase, "waiting");
    assert.equal(chat.view().cache, undefined);
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
    const setupTurn = chat.forTurn("unattended");
    assert.equal(setupTurn.systemPromptAppend, UNATTENDED_NOTE);
    const result = await setupTurn.canUseTool("AskUserQuestion", { questions: [question] }, toolOptions());
    assert.deepEqual(result?.behavior === "allow" && result.updatedInput?.answers, { "Which \u001b[31mstore?": "Files (Recommended)" });
    assert.equal(logs.length, 1);
    assert.deepEqual(waiting, []);
  });

  it("shows, records and lists a question answered without the user, its text made plain", async () => {
    const { chat, records, appended } = setup();
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    await chat.forTurn("unattended").canUseTool("AskUserQuestion", { questions: [question] }, toolOptions());
    const decision = { card: "Plan", question: "Which \u001b[31mstore?", answer: "Files (Recommended)", after: "at once" };
    assert.deepEqual(appended(), [{ kind: "decided", card: "Plan", question: "Which [31mstore?", answer: "Files (Recommended)", after: "at once" }]);
    assert.deepEqual(records.at(-1), { type: "decided", ...decision });
    assert.deepEqual(chat.decided(), [decision]);
    chat.decided()[0]!.answer = "changed";
    assert.equal(chat.decided()[0]!.answer, "Files (Recommended)");
  });

  it("shows an unattended question in the chat with its expiry when the run waits, and takes the user's answer", async () => {
    let wake = () => {};
    const { chat, waiting } = setup(() => 50, "timed", () => new Promise((resolve) => (wake = resolve)));
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    const pending = chat.forTurn("unattended").canUseTool("AskUserQuestion", { questions: [question] }, toolOptions());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chat.view().question?.expiresAt, 50 + QUESTION_WAIT_MS);
    assert.deepEqual(waiting, ["Plan"]);
    chat.talk.answer(chat.view().question!.id, [{ picked: ["SQLite"] }]);
    const result = await pending;
    assert.deepEqual(result?.behavior === "allow" && result.updatedInput?.answers, { "Which \u001b[31mstore?": "SQLite" });
    assert.deepEqual(chat.decided(), []);
    wake();
  });

  it("gives an interactive turn the interactive note, and asks the user", async () => {
    const { chat } = setup();
    chat.talk.at({ card: "Brainstorm", index: 0, session: 0, attended: true });
    const setupTurn = chat.forTurn("interactive");
    assert.equal(setupTurn.systemPromptAppend, INTERACTIVE_NOTE);
    const pending = setupTurn.canUseTool("AskUserQuestion", { questions: [question] }, toolOptions());
    chat.talk.answer(chat.view().question!.id, [{ picked: [], other: "Postgres" }]);
    const result = await pending;
    assert.deepEqual(result?.behavior === "allow" && result.updatedInput?.answers, { "Which \u001b[31mstore?": "Postgres" });
  });

  it("puts the turn's messages in the transcript under the card that is running, or none before any turn", () => {
    const { chat, appended } = setup();
    chat.forTurn("unattended").onMessage(said("early"));
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: false });
    chat.forTurn("unattended").onMessage(said("Reading the code."));
    chat.forTurn("unattended").onMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [] } } as unknown as SDKAssistantMessage);
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
    const stop = { stop: () => void stopped++, copyResume: () => assert.fail("not asked"), nextChain: () => assert.fail("not asked"), copyText: () => assert.fail("not asked") };
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

  it("hands the actions after the run to the extension", () => {
    const { chat } = setup();
    const asked: string[] = [];
    const actions = { stop: () => void asked.push("stop"), copyResume: () => void asked.push("copy"), nextChain: () => void asked.push("next"), copyText: (text: string) => void asked.push(`text: ${text}`) };
    assert.equal(actOnChat(chat.talk, actions, { type: "chatCopyResume" }), true);
    assert.equal(actOnChat(chat.talk, actions, { type: "chatNextChain" }), true);
    assert.deepEqual(asked, ["copy", "next"]);
  });

  it("hands a command to copy to the extension, at any time", () => {
    const { chat } = setup();
    const asked: string[] = [];
    const actions = { stop: () => assert.fail("not asked"), copyResume: () => assert.fail("not asked"), nextChain: () => assert.fail("not asked"), copyText: (text: string) => void asked.push(text) };
    assert.equal(actOnChat(chat.talk, actions, { type: "chatCopyText", text: "docker --version" }), true);
    assert.deepEqual(asked, ["docker --version"]);
  });
});

describe("createRunChat: the end of the run", () => {
  it("shows how the run ended, and keeps the chat open on the last card", () => {
    const { chat, appended, waiting } = setup();
    chat.talk.at({ card: "Kickoff", index: 0, session: 0, attended: true });
    chat.ended({ status: "halted", reason: "needs a \u001b[31mdecision" }, { card: "Kickoff" });
    assert.deepEqual(appended(), [{ kind: "end", status: "halted", reason: "needs a [31mdecision" }]);
    assert.deepEqual(chat.view().ending, { status: "halted", reason: "needs a [31mdecision" });
    assert.deepEqual([chat.view().phase, chat.view().afterRun, chat.view().card], ["waiting", true, "Kickoff"]);
    assert.deepEqual(waiting, [], "the run's own announcement says it ended");
    assert.deepEqual(chat.entries(), appended());
  });

  it("says the run moved when a turn of the chat after the run starts and ends, so the computer is kept awake for it", async () => {
    const { chat, moves } = setup();
    chat.ended({ status: "done", text: "" }, { card: "Kickoff" });
    const before = moves();
    const signal = new AbortController().signal;
    const wait = chat.talk.waitForYou({ card: "Kickoff", ready: false, signal });
    assert.equal(moves(), before, "waiting after the run is not news");
    chat.talk.send("one more thing");
    await wait;
    assert.equal(chat.view().phase, "running");
    assert.equal(moves(), before + 1);
    void chat.talk.waitForYou({ card: "Kickoff", ready: false, signal });
    assert.equal(moves(), before + 2);
  });

  it("closes the chat when there is no session to keep talking to", () => {
    const { chat } = setup();
    chat.ended({ status: "done", text: "brief" });
    assert.deepEqual([chat.view().phase, chat.view().afterRun, chat.view().ending], ["ended", undefined, { status: "done" }]);
  });

  it("gives a turn after the run the after note, and asks the user its questions", async () => {
    const { chat } = setup();
    chat.ended({ status: "done", text: "" }, { card: "Kickoff" });
    const setupTurn = chat.forTurn("after");
    assert.equal(setupTurn.systemPromptAppend, AFTER_NOTE);
    const pending = setupTurn.canUseTool("AskUserQuestion", { questions: [question] }, toolOptions());
    chat.talk.answer(chat.view().question!.id, [{ picked: ["SQLite"] }]);
    const result = await pending;
    assert.deepEqual(result?.behavior === "allow" && result.updatedInput?.answers, { "Which \u001b[31mstore?": "SQLite" });
  });

  it("puts a failed turn after the run in the transcript, control characters stripped", () => {
    const { chat, appended } = setup();
    chat.failed("Kickoff", "the session failed: \u001b[31mAPI Error");
    assert.deepEqual(appended(), [{ kind: "failed", card: "Kickoff", error: "the session failed: [31mAPI Error" }]);
  });

  it("does not journal the end entry; the outcome record says how the run ended", () => {
    const { chat, records } = setup();
    chat.ended({ status: "done", text: "brief" }, { card: "Kickoff" });
    assert.deepEqual(records, []);
  });
});

describe("createRunChat: the journal", () => {
  it("records what the sessions said, the dividers and failed turns, but not the user's side twice", async () => {
    const { chat, records } = setup();
    chat.talk.at({ card: "Plan", index: 0, session: 0, attended: true });
    chat.forTurn("interactive").onMessage(said("the plan"));
    chat.talk.send("keep it small");
    chat.talk.takeQueued("Plan");
    chat.talk.at({ card: "Review", index: 0, session: 1, attended: true });
    chat.failed("Review", "no network");
    assert.deepEqual(records, [
      { type: "entry", entry: { kind: "assistant", card: "Plan", text: "the plan" } },
      { type: "you", card: "Plan", text: "keep it small" },
      { type: "entry", entry: { kind: "divider", session: 1 } },
      { type: "entry", entry: { kind: "failed", card: "Review", error: "no network" } },
    ]);
  });
});

describe("createRunChat: a reopened session", () => {
  const past: Entry[] = [
    { kind: "assistant", card: "Plan", text: "the plan" },
    { kind: "end", status: "halted", reason: "needs a decision" },
  ];

  it("shows the transcript read back from the journal first, and does not record it again", () => {
    const { chat, posted, records } = setup(undefined, undefined, undefined, past);
    assert.deepEqual(posted, [{ type: "chat", chat: { ...IDLE_CHAT, title: "Idea · notes" }, entries: past }]);
    assert.deepEqual(chat.entries(), past);
    chat.forTurn("after").onMessage(said("next step"));
    assert.deepEqual(chat.entries(), [...past, { kind: "assistant", card: "", text: "next step" }]);
    assert.deepEqual(records, [{ type: "entry", entry: { kind: "assistant", card: "", text: "next step" } }]);
  });

  it("opens on the session without a second end entry, ready to keep talking", () => {
    const { chat, appended, waiting } = setup(undefined, undefined, undefined, past);
    chat.reopened({ status: "halted", reason: "needs a decision" }, { card: "Plan" });
    assert.deepEqual(appended(), []);
    assert.deepEqual(chat.view().ending, { status: "halted", reason: "needs a decision" });
    assert.deepEqual([chat.view().phase, chat.view().afterRun, chat.view().card], ["waiting", true, "Plan"]);
    assert.deepEqual(waiting, []);
  });

  it("opens read-only when there is no session to talk to", () => {
    const { chat } = setup(undefined, undefined, undefined, past);
    chat.reopened({ status: "stopped" });
    assert.deepEqual([chat.view().phase, chat.view().afterRun], ["ended", undefined]);
  });
});
