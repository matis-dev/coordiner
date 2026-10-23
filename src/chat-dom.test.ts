import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { MAX_INPUT_CHARS, TEMPLATES } from "./chains.ts";
import { MAX_ENTRIES } from "./chat-logic.ts";
import { editorHtml } from "./editor-html.ts";
import type { ChatView, EditorState } from "./editor-protocol.ts";
import type { Entry } from "./transcript.ts";

// Runs the real webview script (media/editor.js, which starts media/chat.js) in jsdom, as src/editor-dom.test.ts does, and drives
// the run's chat with the messages the extension sends.
const SCRIPT = new URL("../media/editor.js", import.meta.url).href;
const CHAIN_EDIT = new URL("chain-edit.ts", import.meta.url).href;
let editor: { start(): Promise<void> } | undefined;
let current: JSDOM | undefined;

type Posted = Record<string, unknown> & { type: string };
const view = (patch: Partial<ChatView> = {}): ChatView => ({ phase: "running", card: "Implement", session: 0, attended: false, queued: [], continueReady: false, pausePending: false, title: "Story · login", ...patch });
const question = { id: "q1", card: "Brainstorm", questions: [{ question: "Which store?", header: "Store", options: [{ label: "SQLite", description: "one file" }, { label: "Files" }] }] };

async function open(stored?: Record<string, unknown>) {
  const html = editorHtml({ cspSource: "test:", nonce: "n", scriptUri: "", styleUri: "", chainEditUri: CHAIN_EDIT });
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  current = dom;
  const w = dom.window;
  const posted: Posted[] = [];
  let saved: unknown = stored;
  Object.assign(globalThis as Record<string, unknown>, {
    window: w,
    document: w.document,
    Node: w.Node,
    requestAnimationFrame: (callback: () => void) => callback(),
    acquireVsCodeApi: () => ({ postMessage: (m: Posted) => posted.push(m), getState: () => saved, setState: (s: unknown) => (saved = s) }),
  });
  if (editor) await editor.start();
  else editor = (await import(SCRIPT)) as { start(): Promise<void> };

  const doc = w.document;
  const post = (data: unknown) => w.dispatchEvent(new w.MessageEvent("message", { data }));
  const button = (name: string) => {
    const found = [...doc.querySelectorAll<HTMLButtonElement>("#chat button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
    assert.ok(found, `no chat button named "${name}"`);
    return found;
  };
  return {
    w,
    doc,
    posted,
    saved: () => saved,
    splitter: () => doc.getElementById("chat-splitter")!,
    chat: () => doc.getElementById("chat")!,
    button,
    input: () => doc.getElementById("chat-input") as HTMLTextAreaElement,
    status: () => doc.getElementById("status")!.textContent,
    line: () => doc.querySelector(".chat-status")!.textContent,
    entries: () => [...doc.querySelectorAll<HTMLElement>("#transcript li")],
    reset: (chat: ChatView, entries: Entry[] = []) => post({ type: "chat", chat, entries }),
    update: (chat: ChatView) => post({ type: "chatUpdate", chat }),
    append: (entries: Entry[]) => post({ type: "chatAppend", entries }),
    state: (patch: Partial<EditorState> = {}) => post({ type: "state", templates: TEMPLATES, chains: [], running: true, ...patch }),
  };
}

afterEach(() => current?.window.close());

describe("run chat: before and during a run", () => {
  it("says no run is going, and refuses to send", async () => {
    const page = await open();
    assert.match(page.line()!, /No run yet/);
    assert.equal(page.doc.getElementById("chat-h")!.textContent, "Run");
    assert.equal(page.button("Send").getAttribute("aria-disabled"), "true");
    page.input().value = "hello";
    page.button("Send").click();
    assert.equal(page.posted.some((m) => m.type === "chatSend"), false);
    assert.match(page.status()!, /No run is going/);
  });

  it("shows the run's title, what it is doing, and every kind of entry", async () => {
    const page = await open();
    page.reset(view(), [
      { kind: "dropped" },
      { kind: "assistant", card: "Plan", text: "line one\nline two" },
      { kind: "tool", card: "Plan", name: "Read", input: '{"file_path":"a.ts"}' },
      { kind: "you", card: "Implement", text: "keep it small" },
      { kind: "answer", card: "Brainstorm", question: "Which store?", answer: "SQLite" },
      { kind: "divider", session: 1 },
    ]);
    assert.equal(page.doc.getElementById("chat-h")!.textContent, "Run: Story · login");
    assert.equal(page.line(), "Implement is working…");
    assert.deepEqual(
      page.entries().map((li) => li.textContent),
      [
        "Earlier messages were dropped to keep the chat short.",
        "Planline one\nline two",
        'Plan used Read {"file_path":"a.ts"}',
        "You to Implementkeep it small",
        "You answered BrainstormWhich store? → SQLite",
        "fresh context: session 2",
      ],
    );
    assert.equal(page.status(), "");
  });

  it("renders markup in an assistant message as text", async () => {
    const page = await open();
    page.reset(view(), [{ kind: "assistant", card: "Plan", text: '<img src=x onerror="alert(1)"><b>bold</b>' }]);
    assert.equal(page.doc.querySelector("#transcript img, #transcript b"), null);
    assert.match(page.entries()[0]!.textContent!, /<img src=x/);
  });

  it("appends new entries without replacing the ones shown, and announces a reply by its card", async () => {
    const page = await open();
    page.reset(view(), [{ kind: "assistant", card: "Plan", text: "first" }]);
    const first = page.entries()[0]!;
    page.append([{ kind: "tool", card: "Implement", name: "Edit", input: "{}" }]);
    assert.equal(page.status(), "");
    page.append([{ kind: "assistant", card: "Implement", text: "second" }]);
    assert.equal(page.entries().length, 3);
    assert.equal(first.isConnected, true);
    assert.equal(page.status(), "Implement replied");
  });

  it("keeps only the newest entries on the page, with one note at the top that older ones were dropped", async () => {
    const page = await open();
    const said = (i: number): Entry => ({ kind: "assistant", card: "Implement", text: `reply ${i}` });
    page.reset(view(), Array.from({ length: MAX_ENTRIES }, (_, i) => said(i)));
    page.append([said(MAX_ENTRIES), said(MAX_ENTRIES + 1)]);
    page.append([said(MAX_ENTRIES + 2)]);
    const shown = page.entries();
    assert.equal(shown.length, MAX_ENTRIES + 1);
    assert.equal(shown[0]!.textContent, "Earlier messages were dropped to keep the chat short.");
    assert.equal(shown.filter((li) => li.dataset.dropped).length, 1);
    assert.match(shown[1]!.textContent!, /reply 3$/);
    assert.match(shown.at(-1)!.textContent!, new RegExp(`reply ${MAX_ENTRIES + 2}$`));
  });

  it("keeps what the user is typing when the chat or the chains change", async () => {
    const page = await open();
    page.reset(view());
    const input = page.input();
    input.focus();
    input.value = "half a thought";
    page.update(view({ card: "Review" }));
    page.state();
    page.append([{ kind: "assistant", card: "Review", text: "x" }]);
    assert.equal(page.input(), input);
    assert.equal(input.value, "half a thought");
    assert.equal(page.doc.querySelector('label[for="chat-input"]')!.textContent, "Message to Review");
  });
});

describe("run chat: sending", () => {
  it("sends with Ctrl+Enter or the Send button, clears the box and keeps focus there", async () => {
    const page = await open();
    page.reset(view());
    const input = page.input();
    input.focus();
    input.value = "use the helper";
    input.dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    assert.deepEqual(page.posted.at(-1), { type: "chatSend", text: "use the helper" });
    assert.equal(input.value, "");
    input.value = "and test it";
    page.button("Send").click();
    assert.deepEqual(page.posted.at(-1), { type: "chatSend", text: "and test it" });
    assert.equal(page.doc.activeElement, input);
  });

  it("leaves plain Enter to make a new line", async () => {
    const page = await open();
    page.reset(view());
    page.input().value = "line";
    page.input().dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    page.input().dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    assert.equal(page.posted.some((m) => m.type === "chatSend"), false);
  });

  it("refuses an empty message and one over the limit with an error tied to the box, and clears it after a good send", async () => {
    const page = await open();
    page.reset(view());
    const input = page.input();
    input.value = "   ";
    page.button("Send").click();
    assert.equal(page.doc.getElementById("chat-error")!.textContent, "Write a message first.");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(page.status(), "Write a message first.");
    input.value = "x".repeat(MAX_INPUT_CHARS + 1);
    page.button("Send").click();
    assert.match(page.doc.getElementById("chat-error")!.textContent!, /Keep it under/);
    assert.equal(page.posted.some((m) => m.type === "chatSend"), false);
    input.value = "fine";
    page.button("Send").click();
    assert.equal(page.doc.getElementById("chat-error")!.textContent, "");
    assert.equal(input.hasAttribute("aria-invalid"), false);
  });

  it("lists queued messages with where they go, and withdraws one", async () => {
    const page = await open();
    page.reset(view({ nextSession: "Review", queued: [{ id: "m1", text: "check the docs" }, { id: "m2", text: "and the tests" }] }));
    const items = [...page.doc.querySelectorAll(".queued li")];
    assert.equal(items.length, 2);
    assert.match(items[0]!.textContent!, /Queued for the next turn of Implement, or Review in a fresh context if Implement finishes/);
    page.button("Withdraw queued message 2").click();
    assert.deepEqual(page.posted.at(-1), { type: "chatWithdraw", id: "m2" });
    assert.equal(page.doc.activeElement, page.input());
  });

  it("announces a newly queued message", async () => {
    const page = await open();
    page.reset(view());
    page.update(view({ queued: [{ id: "m1", text: "x" }] }));
    assert.equal(page.status(), "Message queued for the next turn of Implement");
  });

  it("puts a message the run did not send back in the box, before what is being typed", async () => {
    const page = await open();
    page.reset(view());
    page.update(view({ phase: "ended", returned: "check the docs" }));
    assert.equal(page.input().value, "check the docs");
    assert.match(page.status()!, /back in the message box/);
    const again = await open();
    again.reset(view());
    again.input().value = "draft";
    again.update(view({ phase: "ended", returned: "check the docs" }));
    assert.equal(again.input().value, "check the docs\n\ndraft");
  });
});

describe("run chat: pause, continue and stop", () => {
  it("pauses an unattended card after its turn, and says so", async () => {
    const page = await open();
    page.reset(view());
    page.button("Pause after this turn").click();
    assert.deepEqual(page.posted.at(-1), { type: "chatPause" });
    page.update(view({ pausePending: true }));
    const pause = page.button("Pausing after this turn");
    assert.equal(pause.getAttribute("aria-disabled"), "true");
    assert.equal(page.status(), "Implement will wait for you after this turn");
    const count = page.posted.length;
    pause.click();
    assert.equal(page.posted.length, count);
  });

  it("offers Continue only while a card waits, named for what follows, and returns focus to the box", async () => {
    const page = await open();
    page.reset(view({ card: "Brainstorm", attended: true }));
    assert.equal(page.button("Continue the chain").hidden, true);
    page.update(view({ phase: "waiting", card: "Brainstorm", attended: true, nextCard: "Plan" }));
    const go = page.button("Continue to Plan");
    assert.equal(go.hidden, false);
    assert.equal(go.classList.contains("run"), false);
    assert.equal(page.status(), "Brainstorm is waiting for you");
    page.update(view({ phase: "waiting", card: "Brainstorm", attended: true, nextCard: "Plan", continueReady: true }));
    assert.equal(go.classList.contains("run"), true);
    assert.match(page.line()!, /Continue moves the chain on/);
    go.click();
    assert.deepEqual(page.posted.at(-1), { type: "chatContinue" });
    assert.equal(page.doc.activeElement, page.input());
  });

  it("stops the run from the chat, and only while one is going", async () => {
    const page = await open();
    page.button("Stop run").click();
    assert.equal(page.posted.some((m) => m.type === "chatStop"), false);
    page.reset(view());
    page.button("Stop run").click();
    assert.deepEqual(page.posted.at(-1), { type: "chatStop" });
  });

  it("hides and shows the chat with a disclosure button", async () => {
    const page = await open();
    page.button("Hide chat").click();
    const toggle = page.button("Show chat");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(page.doc.getElementById("chat-body")!.hidden, true);
    toggle.click();
    assert.equal(page.button("Hide chat").getAttribute("aria-expanded"), "true");
    assert.equal(page.doc.getElementById("chat-body")!.hidden, false);
  });
});

describe("run chat: answering a question", () => {
  const waiting = (patch: Partial<ChatView> = {}) => view({ phase: "waiting", card: "Brainstorm", attended: true, question, ...patch });

  it("shows the question as a form, and moves focus to its first option when focus was in the chat, without also announcing it", async () => {
    const page = await open();
    page.reset(view({ card: "Brainstorm", attended: true }));
    page.input().focus();
    page.doc.getElementById("status")!.textContent = "";
    page.update(waiting());
    const form = page.doc.querySelector<HTMLFormElement>("form.question")!;
    assert.equal(form.hidden, false);
    assert.equal(form.querySelector("legend")!.textContent, "Which store? (needs an answer)");
    const first = form.querySelector<HTMLInputElement>('input[type="radio"]')!;
    assert.equal(page.doc.activeElement, first);
    assert.equal(page.doc.getElementById(first.getAttribute("aria-describedby")!)!.textContent, "one file");
    assert.equal(page.status(), "", "focus on the question reads it; the status region stays quiet");
  });

  it("still announces how many questions there are when focus moves to the first of several", async () => {
    const page = await open();
    page.reset(view({ card: "Brainstorm", attended: true }));
    page.input().focus();
    const two = { ...question, questions: [question.questions[0]!, { question: "Which cache?", header: "Cache", options: [{ label: "None" }] }] };
    page.update(waiting({ question: two }));
    assert.equal(page.doc.activeElement, page.doc.querySelector('form.question input[type="radio"]'));
    assert.equal(page.status(), "Brainstorm asks 2 questions");
  });

  it("leaves focus where it was when it was outside the chat, and announces the question instead", async () => {
    const page = await open();
    page.state();
    page.reset(view({ card: "Brainstorm", attended: true }));
    const rail = page.doc.querySelector<HTMLButtonElement>("#rail button")!;
    rail.focus();
    page.update(waiting());
    assert.equal(page.doc.activeElement, rail);
    assert.equal(page.status(), "Brainstorm asks: Store");
  });

  it("moves focus to a question left unanswered, and sends nothing", async () => {
    const page = await open();
    page.reset(waiting());
    page.doc.querySelector<HTMLButtonElement>("form.question button[type=submit]")!.click();
    const set = page.doc.querySelector("fieldset")!;
    assert.equal(set.querySelector<HTMLElement>(".flag")!.hidden, false);
    assert.equal(page.doc.activeElement, set.querySelector("input"));
    assert.equal(page.posted.some((m) => m.type === "chatAnswer"), false);
  });

  it("sends the picked label, then focuses the message box", async () => {
    const page = await open();
    page.reset(waiting());
    const files = [...page.doc.querySelectorAll<HTMLInputElement>('fieldset input[type="radio"]')].find((r) => r.value === "Files")!;
    files.checked = true;
    page.doc.querySelector<HTMLButtonElement>("form.question button[type=submit]")!.click();
    assert.deepEqual(page.posted.at(-1), { type: "chatAnswer", id: "q1", picks: [{ picked: ["Files"] }] });
    assert.equal(page.doc.activeElement, page.input());
    page.update(waiting({ question: undefined }));
    const form = page.doc.querySelector<HTMLFormElement>("form.question")!;
    assert.equal(form.hidden, true);
    const count = page.posted.length;
    form.dispatchEvent(new page.w.Event("submit", { cancelable: true }));
    assert.equal(page.posted.length, count);
  });

  it("picks Other when the user types their own answer, and clears it when they empty it", async () => {
    const page = await open();
    page.reset(waiting());
    const text = page.doc.querySelector<HTMLInputElement>('fieldset input[type="text"]')!;
    const other = page.doc.querySelector<HTMLInputElement>("fieldset input[data-other]")!;
    assert.equal(text.getAttribute("aria-label"), "Other answer to: Store");
    text.value = "Postgres";
    text.dispatchEvent(new page.w.Event("input"));
    assert.equal(other.checked, true);
    page.doc.querySelector<HTMLButtonElement>("form.question button[type=submit]")!.click();
    assert.deepEqual(page.posted.at(-1), { type: "chatAnswer", id: "q1", picks: [{ picked: [], other: "Postgres" }] });
    text.value = " ";
    text.dispatchEvent(new page.w.Event("input"));
    assert.equal(other.checked, false);
  });

  it("offers checkboxes for a multi-select, labelled by the question when it has no header", async () => {
    const page = await open();
    const multi = { id: "q2", card: "Brainstorm", questions: [{ question: "Which themes?", multiSelect: true, options: [{ label: "Light" }, { label: "Dark" }] }] };
    page.reset(waiting({ question: multi }));
    const boxes = [...page.doc.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];
    assert.equal(boxes.length, 3);
    boxes[0]!.checked = true;
    boxes[1]!.checked = true;
    assert.equal(page.doc.querySelector('fieldset input[type="text"]')!.getAttribute("aria-label"), "Other answer to: Which themes?");
    page.doc.querySelector<HTMLButtonElement>("form.question button[type=submit]")!.click();
    assert.deepEqual(page.posted.at(-1), { type: "chatAnswer", id: "q2", picks: [{ picked: ["Light", "Dark"] }] });
  });
});

describe("run chat: the prompt cache", () => {
  const cacheLine = (page: Awaited<ReturnType<typeof open>>) => page.doc.querySelector<HTMLElement>(".chat-cache")!;
  const waiting = (card: string, ttlMs: number, assumed = false) => view({ phase: "waiting", card, attended: true, cache: { since: 0, ttlMs, assumed } });
  afterEach(() => mock.timers.reset());

  it("counts down each second while a card waits, then says once that it expired", async () => {
    const page = await open();
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    page.update(waiting("Brainstorm", 3000));
    assert.equal(cacheLine(page).hidden, false);
    assert.equal(cacheLine(page).textContent, "Prompt cache warm for 0:03");
    mock.timers.tick(1000);
    assert.equal(cacheLine(page).textContent, "Prompt cache warm for 0:02");
    mock.timers.tick(2000);
    assert.match(cacheLine(page).textContent!, /^Prompt cache expired/);
    assert.equal(page.status(), "Prompt cache expired for Brainstorm");
    page.doc.getElementById("status")!.textContent = "";
    mock.timers.tick(10_000);
    assert.equal(page.status(), "", "the expiry is announced once");
  });

  it("says when the lifetime is assumed", async () => {
    const page = await open();
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    page.update(waiting("Brainstorm", 300_000, true));
    assert.equal(cacheLine(page).textContent, "Prompt cache warm for 5:00 (assumed 5-minute cache)");
  });

  it("shows nothing while a card runs, and stops counting when the card runs again", async () => {
    const page = await open();
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    page.update(view({ cache: { since: 0, ttlMs: 3000, assumed: false } }));
    assert.equal(cacheLine(page).hidden, true);
    page.update(waiting("Brainstorm", 3000));
    page.update(view({ phase: "running", card: "Brainstorm" }));
    assert.equal(cacheLine(page).hidden, true);
    page.doc.getElementById("status")!.textContent = "";
    mock.timers.tick(5000);
    assert.equal(page.status(), "");
  });

  it("keeps one timer when another update arrives while the card waits", async () => {
    const page = await open();
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    page.update(waiting("Brainstorm", 3000));
    page.update(waiting("Debug", 10_000));
    page.doc.getElementById("status")!.textContent = "";
    mock.timers.tick(3000);
    assert.equal(page.status(), "", "the first update's timer is gone");
    assert.equal(cacheLine(page).textContent, "Prompt cache warm for 0:07");
  });

  it("does not announce a cache that had already expired when the card started waiting", async () => {
    const page = await open();
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 10_000 });
    page.update(waiting("Brainstorm", 3000));
    assert.match(cacheLine(page).textContent!, /^Prompt cache expired/);
    page.doc.getElementById("status")!.textContent = "";
    mock.timers.tick(5000);
    assert.equal(page.status(), "");
  });
});

describe("run chat: the divider above it", () => {
  const press = (page: Awaited<ReturnType<typeof open>>, name: string) =>
    page.splitter().dispatchEvent(new page.w.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

  it("sits between the chains and the chat as a focusable separator with its value", async () => {
    const page = await open();
    const splitter = page.splitter();
    assert.equal(splitter.nextElementSibling, page.chat());
    assert.equal(splitter.previousElementSibling, page.doc.querySelector(".pane"));
    assert.deepEqual(
      ["role", "tabindex", "aria-orientation", "aria-label", "aria-controls", "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext"].map((a) => splitter.getAttribute(a)),
      ["separator", "0", "horizontal", "Chat height", "chat", "15", "80", "35", "35% of the window"],
    );
    assert.equal(page.chat().style.height, "35vh");
  });

  it("resizes with the arrow keys, Home and End, and remembers the height with what the editor saved", async () => {
    const page = await open({ selectedId: "own" });
    press(page, "ArrowUp");
    assert.equal(page.chat().style.height, "40vh");
    assert.equal(page.splitter().getAttribute("aria-valuenow"), "40");
    assert.deepEqual(page.saved(), { selectedId: "own", chatHeight: 40 });
    press(page, "End");
    assert.equal(page.chat().style.height, "80vh");
    press(page, "Home");
    assert.equal(page.chat().style.height, "15vh");
    press(page, "ArrowDown");
    assert.equal(page.chat().style.height, "15vh");
  });

  it("leaves other keys to the page", async () => {
    const page = await open();
    const key = new page.w.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    page.splitter().dispatchEvent(key);
    assert.equal(key.defaultPrevented, false);
    assert.equal(page.saved(), undefined);
  });

  it("follows the pointer while dragging, and saves the height when the drag ends", async () => {
    const page = await open();
    const at = (y: number) => new page.w.MouseEvent("pointermove", { clientY: y });
    page.splitter().dispatchEvent(new page.w.MouseEvent("pointerdown", { clientY: 500, bubbles: true, cancelable: true }));
    page.w.dispatchEvent(at(page.w.innerHeight / 2));
    assert.equal(page.chat().style.height, "50vh");
    assert.equal(page.saved(), undefined);
    page.w.dispatchEvent(new page.w.MouseEvent("pointerup"));
    assert.deepEqual(page.saved(), { chatHeight: 50 });
    page.w.dispatchEvent(at(0));
    assert.equal(page.chat().style.height, "50vh");
  });

  it("opens at the height saved last time, and keeps the editor's own saved state when it saves", async () => {
    const page = await open({ selectedId: "own", chatHeight: 60 });
    assert.equal(page.chat().style.height, "60vh");
    page.state({ chains: [], running: false });
    page.doc.querySelector<HTMLButtonElement>('#rail button[aria-pressed="false"]')!.click();
    assert.equal((page.saved() as { chatHeight: number }).chatHeight, 60);
  });

  it("hides with the chat, and the chat shrinks to its heading", async () => {
    const page = await open();
    page.button("Hide chat").click();
    assert.equal(page.splitter().hidden, true);
    assert.equal(page.chat().style.height, "");
    page.button("Show chat").click();
    assert.equal(page.splitter().hidden, false);
    assert.equal(page.chat().style.height, "35vh");
  });
});
