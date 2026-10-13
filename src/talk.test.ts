import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_INPUT_CHARS } from "./chains.ts";
import { Talk, type TalkSnapshot } from "./talk.ts";

const question = { question: "Which store?", options: [{ label: "SQLite" }, { label: "Files" }] };

function setup() {
  const snapshots: TalkSnapshot[] = [];
  const delivered: Array<[string, string]> = [];
  const answered: Array<[string, string, string]> = [];
  const talk = new Talk({
    changed: (s) => void snapshots.push(s),
    delivered: (card, text) => void delivered.push([card, text]),
    answered: (card, q, a) => void answered.push([card, q, a]),
  });
  return { talk, snapshots, delivered, answered, last: () => snapshots.at(-1)! };
}

const running = (card = "Implement", attended = false) => {
  const s = setup();
  s.talk.at({ card, index: 0, session: 0, attended });
  return s;
};

describe("Talk: queueing for the next turn", () => {
  it("starts idle and refuses messages before the run starts", () => {
    const { talk } = setup();
    assert.deepEqual(talk.snapshot(), { phase: "idle", attended: false, queued: [], continueReady: false, pausePending: false });
    assert.equal(talk.send("hello"), false);
  });

  it("queues messages during a turn and hands them, joined in order, to the next turn", () => {
    const { talk, last, delivered } = running();
    assert.equal(talk.send("use the existing helper"), true);
    assert.equal(talk.send("and keep it small"), true);
    assert.deepEqual(last().queued.map((q) => q.text), ["use the existing helper", "and keep it small"]);
    assert.equal(talk.takeQueued("Implement"), "use the existing helper\n\nand keep it small");
    assert.deepEqual(last().queued, []);
    assert.deepEqual(delivered, [["Implement", "use the existing helper\n\nand keep it small"]]);
    assert.equal(talk.takeQueued("Implement"), undefined);
  });

  it("refuses an empty message and one over the length limit, and takes one at the limit", () => {
    const { talk } = running();
    assert.equal(talk.send("  \n"), false);
    assert.equal(talk.send("x".repeat(MAX_INPUT_CHARS + 1)), false);
    assert.equal(talk.send("x".repeat(MAX_INPUT_CHARS)), true);
  });

  it("withdraws a queued message by id, and ignores an id that is not queued", () => {
    const { talk, last, snapshots } = running();
    talk.send("one");
    talk.send("two");
    const [first] = last().queued;
    talk.withdraw(first!.id);
    assert.deepEqual(last().queued.map((q) => q.text), ["two"]);
    const count = snapshots.length;
    talk.withdraw("m99");
    assert.equal(snapshots.length, count);
    assert.equal(talk.takeQueued("Implement"), "two");
  });

  it("says where a queued message goes if the card ends its session, and forgets it at the next card", () => {
    const { talk, last } = setup();
    talk.at({ card: "Implement", index: 1, session: 0, attended: false, nextSession: "Review" });
    assert.equal(last().nextSession, "Review");
    talk.at({ card: "Review", index: 0, session: 1, attended: false });
    assert.equal(last().nextSession, undefined);
    assert.equal(last().session, 1);
  });
});

describe("Talk: waiting for the user", () => {
  it("waits, then hands the user's message to the card as its next turn", async () => {
    const { talk, last, delivered } = running("Brainstorm", true);
    const move = talk.waitForYou({ card: "Brainstorm", nextCard: "Plan", ready: false, signal: new AbortController().signal });
    assert.deepEqual({ phase: last().phase, nextCard: last().nextCard, continueReady: last().continueReady }, { phase: "waiting", nextCard: "Plan", continueReady: false });
    assert.equal(talk.send("offline first"), true);
    assert.deepEqual(await move, { kind: "message", text: "offline first" });
    assert.deepEqual(delivered, [["Brainstorm", "offline first"]]);
    assert.equal(last().phase, "running");
    assert.deepEqual(last().queued, []);
  });

  it("moves on when the user presses Continue, and shows Continue ready when the reply had a status line", async () => {
    const { talk, last } = running("Brainstorm", true);
    const move = talk.waitForYou({ card: "Brainstorm", ready: true, signal: new AbortController().signal });
    assert.equal(last().continueReady, true);
    assert.equal(last().nextCard, undefined);
    talk.continue();
    assert.deepEqual(await move, { kind: "continue" });
    assert.equal(last().continueReady, false);
  });

  it("sends what was queued during the turn at once, as the first message of the pause", async () => {
    const { talk, delivered } = running();
    talk.send("why this helper?");
    assert.deepEqual(await talk.waitForYou({ card: "Implement", ready: false, signal: new AbortController().signal }), { kind: "message", text: "why this helper?" });
    assert.deepEqual(delivered, [["Implement", "why this helper?"]]);
  });

  it("settles as stopped when the run aborts while waiting, or had already aborted", async () => {
    const { talk } = running();
    const abort = new AbortController();
    const move = talk.waitForYou({ card: "Implement", ready: false, signal: abort.signal });
    abort.abort();
    assert.deepEqual(await move, { kind: "stopped" });
    talk.continue();
    assert.deepEqual(await talk.waitForYou({ card: "Implement", ready: false, signal: abort.signal }), { kind: "stopped" });
  });

  it("ignores Continue when no card is waiting", () => {
    const { talk, snapshots } = running();
    const count = snapshots.length;
    talk.continue();
    assert.equal(snapshots.length, count);
  });
});

describe("Talk: pausing an unattended card", () => {
  it("marks a pause as pending until the card waits", async () => {
    const { talk, last } = running();
    talk.requestPause();
    assert.equal(talk.pausePending(), true);
    assert.equal(last().pausePending, true);
    const move = talk.waitForYou({ card: "Implement", ready: true, signal: new AbortController().signal });
    assert.equal(talk.pausePending(), false);
    assert.equal(last().attended, true);
    talk.continue();
    await move;
  });

  it("does nothing for a card already talking with the user, while waiting, twice, or before the run", async () => {
    const attended = running("Brainstorm", true);
    attended.talk.requestPause();
    assert.equal(attended.talk.pausePending(), false);

    const idle = setup();
    idle.talk.requestPause();
    assert.equal(idle.talk.pausePending(), false);

    const twice = running();
    twice.talk.requestPause();
    const count = twice.snapshots.length;
    twice.talk.requestPause();
    assert.equal(twice.snapshots.length, count);
  });
});

describe("Talk: questions", () => {
  it("shows the question with the card that asked, and resolves with the checked answers", async () => {
    const { talk, last, answered } = running("Brainstorm", true);
    const answers = talk.ask([question], new AbortController().signal);
    const open = last().question!;
    assert.deepEqual({ card: open.card, questions: open.questions }, { card: "Brainstorm", questions: [question] });
    assert.equal(talk.answer(open.id, [{ picked: ["Files"] }]), true);
    assert.deepEqual(await answers, { "Which store?": "Files" });
    assert.equal(last().question, undefined);
    assert.deepEqual(answered, [["Brainstorm", "Which store?", "Files"]]);
  });

  it("refuses an answer that is not an offered label and not marked Other, and keeps the question open", () => {
    const { talk, last } = running("Brainstorm", true);
    void talk.ask([question], new AbortController().signal);
    const { id } = last().question!;
    assert.equal(talk.answer(id, [{ picked: ["Postgres"] }]), false);
    assert.equal(last().question?.id, id);
  });

  it("ignores an answer for a stale question id", async () => {
    const { talk, last } = running("Brainstorm", true);
    const answers = talk.ask([question], new AbortController().signal);
    const { id } = last().question!;
    assert.equal(talk.answer("q999", [{ picked: ["Files"] }]), false);
    talk.answer(id, [{ picked: ["SQLite"] }]);
    await answers;
    assert.equal(talk.answer(id, [{ picked: ["Files"] }]), false);
  });

  it("rejects a second question while one is open", async () => {
    const { talk } = running("Brainstorm", true);
    void talk.ask([question], new AbortController().signal);
    await assert.rejects(talk.ask([question], new AbortController().signal), /already open/);
  });

  it("rejects when the run aborts while the question is open, or before it is asked, and ignores a late answer", async () => {
    const { talk, last } = running("Brainstorm", true);
    const abort = new AbortController();
    const answers = talk.ask([question], abort.signal);
    const { id } = last().question!;
    abort.abort();
    await assert.rejects(answers, /stopped/);
    assert.equal(last().question, undefined);
    assert.equal(talk.answer(id, [{ picked: ["Files"] }]), false);
    await assert.rejects(talk.ask([question], abort.signal), /stopped/);
  });

  it("names no card for a question asked before any turn", async () => {
    const { talk, last } = setup();
    void talk.ask([question], new AbortController().signal);
    assert.equal(last().question?.card, "");
  });
});

describe("Talk: the end of the run", () => {
  it("hands queued messages back, refuses new ones, and stops a waiting card and an open question", async () => {
    const { talk, last } = running("Implement");
    talk.send("one");
    talk.send("two");
    talk.end();
    assert.deepEqual({ phase: last().phase, queued: last().queued, returned: last().returned }, { phase: "ended", queued: [], returned: "one\n\ntwo" });
    assert.equal(talk.send("three"), false);
    await assert.rejects(talk.ask([question], new AbortController().signal), /stopped/);

    const waiting = running("Brainstorm", true);
    const move = waiting.talk.waitForYou({ card: "Brainstorm", ready: false, signal: new AbortController().signal });
    const answers = waiting.talk.ask([question], new AbortController().signal);
    waiting.talk.end();
    assert.deepEqual(await move, { kind: "stopped" });
    await assert.rejects(answers, /stopped/);
    assert.equal(waiting.last().phase, "ended");
    assert.equal(waiting.last().returned, undefined);
  });

  it("hands out copies, so the chat cannot change what it holds", () => {
    const { talk } = running();
    talk.send("one");
    const shown = talk.snapshot();
    shown.queued[0]!.text = "changed";
    assert.equal(talk.takeQueued("Implement"), "one");
  });
});
