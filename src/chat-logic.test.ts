import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_INPUT_CHARS } from "./chains.ts";
import { announcement, canPause, canSend, CHAT_HEIGHT, checkAnswers, continueLabel, destination, entriesAnnouncement, firstUnanswered, heightForKey, heightFromPointer, savedHeight, statusLine } from "./chat-logic.ts";
import type { ChatView } from "./editor-protocol.ts";

const opts = (...labels: string[]) => labels.map((label) => ({ label }));
const single = { question: "Which store?", options: opts("SQLite (Recommended)", "Files") };
const multi = { question: "Which themes?", multiSelect: true, options: opts("Light", "Dark", "High contrast") };

describe("checkAnswers", () => {
  it("keys each answer by its question text", () => {
    assert.deepEqual(checkAnswers([single, multi], [{ picked: ["Files"] }, { picked: ["Light", "Dark"] }]), { "Which store?": "Files", "Which themes?": "Light, Dark" });
  });

  it("takes the user's own text when they pick Other, trimmed, and joins it after the labels of a multi-select", () => {
    assert.deepEqual(checkAnswers([single], [{ picked: [], other: "  Postgres " }]), { "Which store?": "Postgres" });
    assert.deepEqual(checkAnswers([multi], [{ picked: ["Dark"], other: "Sepia" }]), { "Which themes?": "Dark, Sepia" });
  });

  it("refuses an answer that is not an offered label and not marked Other", () => {
    assert.equal(checkAnswers([single], [{ picked: ["Postgres"] }]), undefined);
  });

  it("refuses a question left unanswered, or more than one choice on a single select", () => {
    assert.equal(checkAnswers([single], [{ picked: [] }]), undefined);
    assert.equal(checkAnswers([single], [{ picked: ["Files", "SQLite (Recommended)"] }]), undefined);
    assert.equal(checkAnswers([single], [{ picked: ["Files"], other: "Postgres" }]), undefined);
  });

  it("refuses a repeated label, an empty Other, and an Other over the length limit", () => {
    assert.equal(checkAnswers([multi], [{ picked: ["Dark", "Dark"] }]), undefined);
    assert.equal(checkAnswers([single], [{ picked: [], other: "   " }]), undefined);
    assert.equal(checkAnswers([single], [{ picked: [], other: "x".repeat(MAX_INPUT_CHARS + 1) }]), undefined);
    assert.deepEqual(checkAnswers([single], [{ picked: [], other: "x".repeat(MAX_INPUT_CHARS) }]), { "Which store?": "x".repeat(MAX_INPUT_CHARS) });
  });

  it("refuses answers that do not match the number of questions", () => {
    assert.equal(checkAnswers([single, multi], [{ picked: ["Files"] }]), undefined);
  });
});

const view = (patch: Partial<ChatView> = {}): ChatView => ({ phase: "running", card: "Implement", session: 0, attended: false, queued: [], continueReady: false, pausePending: false, ...patch });

describe("firstUnanswered", () => {
  it("finds the first question whose pick does not fit, or -1", () => {
    assert.equal(firstUnanswered([single, multi], [{ picked: ["Files"] }, { picked: [] }]), 1);
    assert.equal(firstUnanswered([single, multi], [{ picked: ["Files"] }]), 1);
    assert.equal(firstUnanswered([single, multi], [{ picked: ["Files"] }, { picked: ["Dark"] }]), -1);
  });
});

describe("what the chat allows", () => {
  it("sends while a run is going, and not before or after", () => {
    assert.deepEqual((["idle", "running", "waiting", "ended"] as const).map((phase) => canSend(view({ phase }))), [false, true, true, false]);
  });

  it("pauses only an unattended card that is working and not already pausing", () => {
    assert.equal(canPause(view()), true);
    assert.equal(canPause(view({ attended: true })), false);
    assert.equal(canPause(view({ pausePending: true })), false);
    assert.equal(canPause(view({ phase: "waiting" })), false);
  });
});

describe("chat labels", () => {
  it("says what the run is doing in text", () => {
    assert.match(statusLine(view({ phase: "idle" })), /No run yet/);
    assert.equal(statusLine(view()), "Implement is working…");
    assert.equal(statusLine(view({ card: "Brainstorm", attended: true })), "Brainstorm is working on your message…");
    assert.equal(statusLine(view({ phase: "waiting", card: "Brainstorm" })), "Brainstorm is waiting for you.");
    assert.match(statusLine(view({ phase: "waiting", card: "Brainstorm", continueReady: true })), /Continue moves the chain on/);
    assert.equal(statusLine(view({ phase: "ended" })), "The run has ended.");
  });

  it("names where a queued message goes, including the fresh context of the next session", () => {
    assert.equal(destination(view()), "the next turn of Implement");
    assert.equal(destination(view({ nextSession: "Review" })), "the next turn of Implement, or Review in a fresh context if Implement finishes");
  });

  it("names what Continue moves on to", () => {
    assert.equal(continueLabel(view({ nextCard: "Plan" })), "Continue to Plan");
    assert.equal(continueLabel(view()), "Continue the chain");
  });
});

describe("announcement", () => {
  const asked = (n: number, header?: string) => view({ phase: "waiting", card: "Brainstorm", question: { id: "q1", card: "Brainstorm", questions: Array.from({ length: n }, () => ({ ...single, ...(header ? { header } : {}) })) } });

  it("announces a new question by its header, else its text, or how many there are", () => {
    assert.equal(announcement(view(), asked(1, "Store")), "Brainstorm asks: Store");
    assert.equal(announcement(undefined, asked(1)), "Brainstorm asks: Which store?");
    assert.equal(announcement(view(), asked(2)), "Brainstorm asks 2 questions");
    assert.equal(announcement(asked(1), asked(1)), undefined);
  });

  it("announces that a card waits, and whether Continue is ready", () => {
    assert.equal(announcement(view(), view({ phase: "waiting" })), "Implement is waiting for you");
    assert.equal(announcement(undefined, view({ phase: "waiting", continueReady: true })), "Implement is waiting for you; Continue is ready");
  });

  it("announces the end of the run, and a message handed back", () => {
    assert.equal(announcement(view(), view({ phase: "ended", returned: "x" })), "The run ended before your message was sent; it is back in the message box.");
    assert.equal(announcement(view(), view({ phase: "ended" })), "The run has ended.");
    assert.equal(announcement(view({ phase: "ended" }), view({ phase: "ended" })), undefined);
  });

  it("announces a queued message with where it goes, and a pause asked for", () => {
    assert.equal(announcement(view(), view({ queued: [{ id: "m1", text: "x" }] })), "Message queued for the next turn of Implement");
    assert.equal(announcement(undefined, view({ queued: [{ id: "m1", text: "x" }] })), "Message queued for the next turn of Implement");
    assert.equal(announcement(view({ queued: [{ id: "m1", text: "x" }] }), view()), undefined);
    assert.equal(announcement(view(), view({ pausePending: true })), "Implement will wait for you after this turn");
    assert.equal(announcement(view({ pausePending: true }), view({ pausePending: true })), undefined);
  });
});

describe("entriesAnnouncement", () => {
  it("names the card of the latest reply, and stays quiet for tool calls and the user's own words", () => {
    assert.equal(entriesAnnouncement([{ kind: "assistant", card: "Plan", text: "a" }, { kind: "assistant", card: "Implement", text: "b" }, { kind: "tool", card: "Implement", name: "Read", input: "{}" }]), "Implement replied");
    assert.equal(entriesAnnouncement([{ kind: "tool", card: "Implement", name: "Read", input: "{}" }, { kind: "you", card: "Implement", text: "hi" }]), undefined);
  });
});

describe("chat height", () => {
  it("moves in steps with the arrow keys, up for taller, and stops at the bounds", () => {
    assert.equal(heightForKey(35, "ArrowUp"), 40);
    assert.equal(heightForKey(35, "ArrowDown"), 30);
    assert.equal(heightForKey(CHAT_HEIGHT.max, "ArrowUp"), CHAT_HEIGHT.max);
    assert.equal(heightForKey(CHAT_HEIGHT.min, "ArrowDown"), CHAT_HEIGHT.min);
  });

  it("goes to the smallest with Home and the largest with End, and leaves other keys alone", () => {
    assert.equal(heightForKey(35, "Home"), CHAT_HEIGHT.min);
    assert.equal(heightForKey(35, "End"), CHAT_HEIGHT.max);
    assert.equal(heightForKey(35, "Enter"), undefined);
  });

  it("puts the divider under the pointer, within the bounds", () => {
    assert.equal(heightFromPointer(600, 1000), 40);
    assert.equal(heightFromPointer(990, 1000), CHAT_HEIGHT.min);
    assert.equal(heightFromPointer(0, 1000), CHAT_HEIGHT.max);
  });

  it("reads a saved height, and falls back to the initial one for anything else", () => {
    assert.equal(savedHeight(50), 50);
    assert.equal(savedHeight(500), CHAT_HEIGHT.max);
    assert.equal(savedHeight("50"), CHAT_HEIGHT.initial);
    assert.equal(savedHeight(Number.NaN), CHAT_HEIGHT.initial);
    assert.equal(savedHeight(undefined), CHAT_HEIGHT.initial);
  });
});
