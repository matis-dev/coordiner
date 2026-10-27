import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_INPUT_CHARS } from "./chains.ts";
import { announcement, busyLabel, canPause, canSend, CHAT_HEIGHT, checkAnswers, continueLabel, destination, endedLine, entriesAnnouncement, firstUnanswered, heightForKey, heightFromPointer, savedHeight, savedMax, statusLine, cacheLabel } from "./chat-logic.ts";
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

  it("sends to the chat after the run, and never pauses it", () => {
    const after = view({ phase: "waiting", card: "Kickoff", attended: true, afterRun: true });
    assert.equal(canSend(after), true);
    assert.equal(canSend({ ...after, phase: "running" }), true);
    assert.equal(canPause({ ...after, phase: "running" }), false);
  });
});

describe("the end of the run", () => {
  it("says how the run ended in one sentence, with the reason and without a doubled full stop", () => {
    assert.equal(endedLine({ status: "done" }), "The run is done.");
    assert.equal(endedLine({ status: "halted", reason: "the plan reserves the schema change." }), "The run halted: the plan reserves the schema change.");
    assert.equal(endedLine({ status: "failed", reason: "the session ended with error_max_turns." }), "The run failed: the session ended with error_max_turns.");
    assert.deepEqual((["no-changes", "stopped", "refused"] as const).map((status) => endedLine({ status })), ["The run found nothing to review.", "The run was stopped.", "The run was refused."]);
  });

  it("offers the chat after the run in the status line, and keeps how it ended once the chat closes", () => {
    const after = view({ phase: "waiting", card: "Kickoff", attended: true, afterRun: true, ending: { status: "halted", reason: "needs you" } });
    assert.equal(statusLine(after), "The run halted: needs you. You can keep talking to Kickoff.");
    assert.equal(statusLine({ ...after, ending: undefined }), "The run has ended. You can keep talking to Kickoff.");
    assert.equal(statusLine({ ...after, phase: "running" }), "Kickoff is working on your message…");
    assert.equal(statusLine(view({ phase: "ended", ending: { status: "done" } })), "The run is done.");
  });

  it("announces the chat after the run once, then each wait as a pausing card does, and says when a queued message came back", () => {
    const after = view({ phase: "waiting", card: "Kickoff", attended: true, afterRun: true, ending: { status: "done" } });
    assert.equal(announcement(view(), after), "The run is done. You can keep talking to Kickoff.");
    assert.equal(announcement(view(), { ...after, returned: "x" }), "The run is done. You can keep talking to Kickoff. Your queued message is back in the message box.");
    assert.equal(announcement(after, after), undefined);
    assert.equal(announcement({ ...after, phase: "running" }, after), "Kickoff is waiting for you");
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

  it("announces once that answers were sent while the card runs on, and not when the run ended with the form open", () => {
    const open = view({ question: { id: "q1", card: "Implement", questions: [single] } });
    assert.equal(announcement(open, view()), "Answers sent; Implement is working on them");
    assert.equal(announcement(view(), view()), undefined);
    assert.equal(announcement(open, view({ phase: "ended" })), "The run has ended.");
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
  it("names the card of the latest reply, else the card the user's message reached, and stays quiet for tool calls", () => {
    assert.equal(entriesAnnouncement([{ kind: "assistant", card: "Plan", text: "a" }, { kind: "assistant", card: "Implement", text: "b" }, { kind: "tool", card: "Implement", name: "Read", input: "{}" }]), "Implement replied");
    assert.equal(entriesAnnouncement([{ kind: "tool", card: "Implement", name: "Read", input: "{}" }, { kind: "you", card: "Implement", text: "hi" }]), "Your message reached Implement");
    assert.equal(entriesAnnouncement([{ kind: "tool", card: "Implement", name: "Read", input: "{}" }]), undefined);
  });
});

describe("busyLabel", () => {
  it("counts whole seconds up since the turn started and since its last activity, with the last tool", () => {
    assert.equal(busyLabel({ since: 1000, lastAt: 150_000, last: "Bash" }, 192_900), "Working 3:11 · last activity 0:42 ago · Bash");
  });

  it("names no tool before one was called, and shows hours from one hour on", () => {
    assert.equal(busyLabel({ since: 0, lastAt: 0 }, 3_600_000), "Working 1:00:00 · last activity 1:00:00 ago");
  });

  it("reads a clock that moved back as no time at all", () => {
    assert.equal(busyLabel({ since: 5000, lastAt: 5000 }, 1000), "Working 0:00 · last activity 0:00 ago");
  });
});

describe("cacheLabel", () => {
  const cache = (ttlMs: number, assumed = false) => ({ since: 1000, ttlMs, assumed });

  it("shows minutes and seconds left, rounding a part second up", () => {
    assert.deepEqual(cacheLabel(cache(300_000), 1000), { text: "Prompt cache warm for 5:00", expired: false });
    assert.deepEqual(cacheLabel(cache(300_000), 1000 + 299_500), { text: "Prompt cache warm for 0:01", expired: false });
  });

  it("shows hours from one hour left", () => {
    assert.equal(cacheLabel(cache(3_600_000), 1000).text, "Prompt cache warm for 1:00:00");
    assert.equal(cacheLabel(cache(3_600_000), 2000).text, "Prompt cache warm for 59:59");
  });

  it("is expired at the end of the lifetime and after it, also after the computer slept", () => {
    assert.equal(cacheLabel(cache(300_000), 301_000).expired, true);
    assert.equal(cacheLabel(cache(300_000), 10_000_000).text, "Prompt cache expired: your next message re-reads the whole conversation without the cache discount.");
  });

  it("says when five minutes is assumed", () => {
    assert.equal(cacheLabel(cache(300_000, true), 1000).text, "Prompt cache warm for 5:00 (assumed 5-minute cache)");
    assert.match(cacheLabel(cache(300_000, true), 400_000).text, /\(assumed 5-minute cache\)$/);
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

  it("fills the editor only when true was saved", () => {
    assert.equal(savedMax(true), true);
    for (const value of [false, "true", 1, undefined]) assert.equal(savedMax(value), false);
  });
});
