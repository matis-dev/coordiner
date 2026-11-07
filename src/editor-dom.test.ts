import type { ImageRef } from "./images.ts";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { defaultCard, MAX_ARGS, MAX_CARDS, MAX_NAME, MAX_SESSIONS, TEMPLATES, type Card, type Chain, type Effort } from "./chains.ts";
import { editorHtml } from "./editor-html.ts";
import type { EditorState } from "./editor-protocol.ts";
import { REQUIRED_COMMANDS } from "./session.ts";
import { palette } from "./skills.ts";

// Runs the real webview script (media/editor.js) in jsdom against the page editorHtml builds. The script imports its sibling
// modules from the URL in data-chain-edit, so here it gets the .ts sources instead of dist/. Importing it starts it on the first
// page; every later page calls start() again, so one module instance (and one coverage record) serves every test.
const SCRIPT = new URL("../media/editor.js", import.meta.url).href;
const CHAIN_EDIT = new URL("chain-edit.ts", import.meta.url).href;
let editor: { start(): Promise<void> } | undefined;
let current: JSDOM | undefined;

type Posted = Record<string, unknown> & { type: string };
const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("acme:a"), defaultCard("acme:b"), defaultCard("acme:c")] }] };
const other: Chain = { id: "other", name: "Other", sessions: [{ cards: [defaultCard("acme:lint")] }] };
const base = (): Omit<EditorState, "type"> => ({ templates: TEMPLATES, removedTemplates: [], chains: [own, other], running: false, mskills: true, palette: palette([...REQUIRED_COMMANDS, "acme:a", "acme:b", "acme:c", "acme:lint"]) });

async function open(stored?: { selectedId: string }) {
  const html = editorHtml({ cspSource: "test:", nonce: "n", scriptUri: "", styleUri: "", chainEditUri: CHAIN_EDIT });
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  current = dom;
  const w = dom.window;
  const posted: Posted[] = [];
  let state: unknown = stored;
  Object.assign(globalThis as Record<string, unknown>, {
    window: w,
    document: w.document,
    Node: w.Node,
    FileReader: w.FileReader,
    requestAnimationFrame: (callback: () => void) => callback(),
    acquireVsCodeApi: () => ({ postMessage: (m: Posted) => posted.push(m), getState: () => state, setState: (s: unknown) => (state = s) }),
  });
  // jsdom has no layout, so no scrollIntoView: record the calls instead.
  const scrolled: Element[] = [];
  w.Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  if (editor) await editor.start();
  else editor = (await import(SCRIPT)) as { start(): Promise<void> };

  const doc = w.document;
  const all = (selector: string) => [...doc.querySelectorAll<HTMLElement>(selector)];
  const named = (name: string) => {
    const found = all("button").find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
    assert.ok(found, `no button named "${name}"`);
    return found;
  };
  return {
    w,
    doc,
    posted,
    scrolled,
    stored: () => state,
    all,
    named,
    message: (data: object) => w.dispatchEvent(new w.MessageEvent("message", { data })),
    send: (patch: Partial<Omit<EditorState, "type">> = {}) => w.dispatchEvent(new w.MessageEvent("message", { data: { type: "state", ...base(), ...patch } })),
    select: (name: string) => named(name).click(),
    focused: () => doc.activeElement as HTMLElement | null,
    status: () => doc.getElementById("status")!.textContent,
    saves: () => posted.filter((m) => m.type === "save").map((m) => m.chain as Chain),
    cardSkills: () => all(".lane .card .skill").map((n) => n.textContent),
  };
}

afterEach(() => current?.window.close());

describe("chains webview: loading", () => {
  it("asks the extension for its state once it has loaded", async () => {
    const page = await open();
    assert.deepEqual(page.posted, [{ type: "ready" }]);
  });

  it("lists templates and the user's chains in the rail, with no badge while m-skills is installed", async () => {
    const page = await open();
    page.send();
    const rail = page.doc.getElementById("rail")!;
    assert.deepEqual([...rail.querySelectorAll("h2")].map((h) => h.textContent), ["Templates", "Single skills", "My chains"]);
    assert.deepEqual(
      [...rail.querySelectorAll("ul")].slice(0, 2).map((ul) => [...ul.querySelectorAll("button > span:first-child")].map((s) => s.textContent)),
      [["Story", "Idea", "Bug", "New project"], ["Kickoff", "Onboard", "Security audit", "UI audit", "Accessibility audit", "Docs audit"]],
    );
    assert.equal(rail.querySelectorAll(".badge").length, 0);
    assert.ok(page.named("Story"));
    assert.ok(page.named("Own"));
  });

  it("marks each of your chains that uses m-skills while it is not installed, and no other", async () => {
    const mine: Chain = { id: "mine", name: "Mine", sessions: [{ cards: [defaultCard("m-skills:planning-architect")] }] };
    const page = await open();
    page.send({ mskills: false, templates: [], chains: [own, mine] });
    const rail = page.doc.getElementById("rail")!;
    assert.equal(rail.querySelectorAll(".badge").length, 1);
    assert.ok(page.named("Mine, uses m-skills"), "the badge is spoken as part of the name, separated");
    assert.ok(page.named("Own"));
  });

  it("opens on the Story template, its arguments read-only, with a fresh-context divider between its sessions", async () => {
    const page = await open();
    page.send();
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Story");
    assert.match(page.doc.getElementById("detail")!.textContent!, /Built-in template\. Changing a card's model, effort or pause saves your own copy; duplicate it to edit the rest\./);
    assert.equal(page.all('#detail [role="separator"]').length, 1);
    assert.equal(page.all('#detail [role="separator"]')[0]!.getAttribute("aria-label"), "Fresh context: session 2 starts a new conversation");
    assert.equal(page.all("#detail textarea").length, 0);
    assert.equal(page.all('button[aria-label^="Remove"]').length, 0);
  });

  it("says when there are no chains of your own yet", async () => {
    const page = await open();
    page.send({ chains: [] });
    assert.match(page.doc.getElementById("rail")!.textContent!, /No chains yet\./);
  });

  it("reopens the chain selected last time", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Own");
  });

  it("falls back to Story when the selected chain is gone", async () => {
    const page = await open({ selectedId: "deleted" });
    page.send();
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Story");
  });
});

describe("chains webview: what a chain starts from", () => {
  it("says what Run asks for, and shows a placeholder as what Run will put there", async () => {
    const page = await open();
    page.send();
    assert.match(page.doc.querySelector(".starts")!.textContent!, /^Starts from a written story/);
    assert.deepEqual(page.all(".args .chip").map((n) => n.textContent), ["the story you choose at Run"]);
    assert.equal(page.all(".args")[1]!.textContent, "Implement the approved plan above.");
    assert.doesNotMatch(page.doc.getElementById("detail")!.textContent!, /\{\{/);
  });

  it("explains the placeholders on a chain you can edit", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    assert.match(page.doc.querySelector(".starts")!.textContent!, /a name only/);
    assert.match(page.doc.getElementById("detail")!.textContent!, /\{\{bug\}\} are placeholders: type one in a card's arguments/);
  });
});

describe("chains webview: text is never markup", () => {
  it("shows a chain name and card arguments literally", async () => {
    const page = await open({ selectedId: "x" });
    const hostile: Chain = { id: "x", name: '<img src=x onerror="alert(1)">', sessions: [{ cards: [{ ...defaultCard("acme:a"), args: "<script>alert(2)</script>" }] }] };
    page.send({ chains: [hostile] });
    assert.equal(page.all("img").length, 0);
    assert.equal(page.all("#detail script").length, 0);
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, hostile.name);
    assert.equal((page.doc.querySelector("textarea") as HTMLTextAreaElement).value, "<script>alert(2)</script>");
  });
});

describe("chains webview: selecting and copying", () => {
  it("moves focus to the chain's heading when a chain is selected, and remembers it", async () => {
    const page = await open();
    page.send();
    page.select("Own");
    assert.equal(page.focused(), page.doc.querySelector("#detail h2"));
    assert.equal(page.focused()!.textContent, "Own");
    assert.deepEqual(page.stored(), { selectedId: "own" });
    assert.equal(page.all('#rail button[aria-pressed="true"]').length, 1);
  });

  it("duplicates a single skill into a one-card chain of your own", async () => {
    const page = await open();
    page.send();
    page.select("Security audit");
    page.named("Duplicate to edit").click();
    const [copy] = page.saves();
    assert.equal(copy!.name, "Security audit copy");
    assert.deepEqual(copy!.sessions, [{ cards: [{ skill: "m-skills:security-audit", args: "", label: "Security audit", pause: false }] }]);
  });

  it("duplicates a template into an editable chain of your own and selects it", async () => {
    const page = await open();
    page.send();
    page.named("Duplicate to edit").click();
    const [copy] = page.saves();
    assert.equal(copy!.name, "Story copy");
    assert.match(copy!.id, /^chain-[a-z0-9]+$/);
    assert.deepEqual(copy!.sessions, TEMPLATES[0]!.sessions);
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Story copy");
    assert.equal(page.focused(), page.doc.querySelector("#detail h2"));
    assert.equal(page.status(), "Created Story copy");
  });

  it("removes a template, shows the next chain with Undo, and says so", async () => {
    const page = await open({ selectedId: "idea" });
    page.send();
    page.named("Remove template").click();
    assert.deepEqual(page.posted.at(-1), { type: "removeTemplate", id: "idea" });
    assert.equal(page.all("#rail button").some((b) => b.textContent === "Idea"), false);
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Bug");
    assert.equal(page.focused(), page.doc.querySelector("#detail h2"));
    assert.equal(page.status(), "Removed the template Idea");
    assert.equal(page.doc.querySelector("#detail .notice span")!.textContent, "Removed the template Idea.");
    assert.equal(page.named("Restore templates (1)").dataset.focus, "restore-templates");
    page.named("Undo remove template Idea").click();
    assert.deepEqual(page.posted.at(-1), { type: "restoreTemplate", id: "idea" });
    assert.equal(page.status(), "Restored the template Idea");
    // The template comes back with the extension's next state, its heading focused.
    page.send();
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Idea");
    assert.equal(page.focused(), page.doc.querySelector("#detail h2"));
  });

  it("removes the last chain in the list and lands on the one before it", async () => {
    const page = await open({ selectedId: "other" });
    page.send({ templates: [], chains: [own, other] });
    page.send({ templates: TEMPLATES.slice(-1), chains: [] });
    page.named("Remove template").click();
    assert.equal(page.doc.getElementById("detail")!.children.length, 0);
    assert.equal(page.focused()?.dataset.focus, "new-chain");
  });

  it("restores every removed template, focusing the first of them in the list", async () => {
    const page = await open();
    page.send({ templates: TEMPLATES.filter((t) => t.id !== "bug" && t.id !== "kickoff"), removedTemplates: ["kickoff", "bug"] });
    page.named("Restore templates (2)").click();
    assert.deepEqual(page.posted.at(-1), { type: "restoreTemplates" });
    assert.equal(page.status(), "Restored the templates");
    page.send();
    assert.equal(page.focused()?.dataset.focus, "rail-bug");
    assert.equal(page.all("#rail button").some((b) => b.textContent === "Restore templates (0)"), false);
  });

  it("creates an empty chain", async () => {
    const page = await open();
    page.send();
    page.named("New empty chain").click();
    assert.deepEqual(page.saves()[0]!.sessions, [{ cards: [] }]);
    assert.match(page.doc.getElementById("detail")!.textContent!, /No skills in this session yet\./);
  });
});

describe("chains webview: moving cards across sessions", () => {
  const split: Chain = { id: "split", name: "Split", sessions: [{ cards: [defaultCard("acme:p"), defaultCard("acme:q")] }, { cards: [defaultCard("acme:r")] }, { cards: [defaultCard("acme:s")] }] };
  type Page = Awaited<ReturnType<typeof open>>;
  const lanes = (chain: Chain) => chain.sessions.map((session) => session.cards.map((c) => c.label));
  const shown = (page: Page) => page.all("#detail section").map((section) => [...section.querySelectorAll(".card .card-label")].map((n) => n.textContent));
  // jsdom has no DragEvent: a plain event stands in, with no dataTransfer, as the page must cope with.
  const fire = (page: Page, node: EventTarget, type: string) => node.dispatchEvent(new page.w.Event(type, { bubbles: true, cancelable: true }));
  const handle = (page: Page, label: string) => page.all(".card-label").find((n) => n.textContent === label)!;
  const cardOf = (page: Page, label: string) => handle(page, label).closest(".card")!;
  const sessionOf = (page: Page, s: number) => page.doc.querySelector(`section[aria-labelledby="session-h-${s}"]`)!;
  const drag = (page: Page, label: string, target: () => Element) => {
    fire(page, handle(page, label), "dragstart");
    fire(page, target(), "dragover");
    fire(page, target(), "drop");
  };
  async function openSplit(patch: Partial<Omit<EditorState, "type">> = {}) {
    const page = await open({ selectedId: "split" });
    page.send({ chains: [own, other, split], ...patch });
    return page;
  }

  it("wraps an arrow past a session's end into the next or previous session, keeping focus on that arrow", async () => {
    const page = await openSplit();
    page.named("Move q right").click();
    assert.deepEqual(lanes(page.saves()[0]!), [["p"], ["q", "r"], ["s"]]);
    assert.equal(page.focused(), page.named("Move q right"));
    assert.equal(page.status(), "Moved q to session 2, position 1");
    page.named("Move q left").dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }));
    assert.deepEqual(lanes(page.saves()[1]!), [["p", "q"], ["r"], ["s"]]);
    assert.equal(page.focused(), page.named("Move q left"));
    assert.equal(page.status(), "Moved q to session 1, position 2");
  });

  it("drops a card dragged onto a card of another session before it, and says where it went", async () => {
    const page = await openSplit();
    drag(page, "p", () => cardOf(page, "r"));
    assert.deepEqual(lanes(page.saves()[0]!), [["q"], ["p", "r"], ["s"]]);
    assert.deepEqual(shown(page), [["q"], ["p", "r"], ["s"]]);
    assert.equal(page.status(), "Moved p to session 2, position 1");
    assert.equal(page.focused(), page.named("Move p right"));
  });

  it("drops a card dragged onto a session, not onto a card, at that session's end", async () => {
    const page = await openSplit();
    drag(page, "p", () => sessionOf(page, 2));
    assert.deepEqual(lanes(page.saves()[0]!), [["q"], ["r"], ["s", "p"]]);
    drag(page, "q", () => sessionOf(page, 0));
    assert.equal(page.saves().length, 1, "q is already the last card of its session");
  });

  it("marks where a card would land while it is dragged, and clears the marks when the drag ends", async () => {
    const page = await openSplit();
    fire(page, handle(page, "p"), "dragstart");
    assert.ok(cardOf(page, "p").classList.contains("dragging"));
    fire(page, cardOf(page, "r"), "dragover");
    assert.ok(cardOf(page, "r").classList.contains("drop-before"));
    fire(page, sessionOf(page, 2), "dragover");
    assert.ok(!cardOf(page, "r").classList.contains("drop-before"));
    assert.ok(sessionOf(page, 2).classList.contains("drop-end"));
    fire(page, page.doc, "dragend");
    assert.equal(page.all(".dragging, .drop-before, .drop-end").length, 0);
    assert.deepEqual(page.saves(), []);
  });

  it("refuses a drop into a full session, saying why", async () => {
    const full: Chain = { ...split, sessions: [{ cards: Array.from({ length: MAX_CARDS }, () => defaultCard("acme:p")) }, { cards: [defaultCard("acme:r")] }] };
    const page = await open({ selectedId: "split" });
    page.send({ chains: [full] });
    fire(page, handle(page, "r"), "dragstart");
    fire(page, sessionOf(page, 0), "dragover");
    assert.ok(!sessionOf(page, 0).classList.contains("drop-end"));
    fire(page, sessionOf(page, 0), "drop");
    assert.deepEqual(page.saves(), []);
    assert.equal(page.status(), `A session holds at most ${MAX_CARDS} skills.`);
  });

  it("takes no drop it did not start: a file or text dragged in from outside", async () => {
    const page = await openSplit();
    assert.equal(fire(page, sessionOf(page, 1), "dragover"), true, "the drag over is not taken, so nothing can be dropped");
    fire(page, sessionOf(page, 1), "drop");
    assert.deepEqual(page.saves(), []);
    assert.equal(page.all(".drop-end").length, 0);
  });

  it("locks the sessions a run on this chain has started, and leaves the rest and every setting free", async () => {
    const page = await openSplit({ running: true, locked: { chainId: "split", through: 0 } });
    const reason = "Session 1 has started: its cards keep their order until the run ends.";
    assert.equal(page.doc.getElementById("locked-0")!.textContent, reason);
    assert.equal(page.doc.getElementById("locked-1"), null);
    for (const name of ["Move p left", "Move p right", "Remove p", "Remove session 1"]) {
      assert.equal(page.named(name).getAttribute("aria-disabled"), "true", name);
      assert.equal(page.named(name).getAttribute("aria-describedby"), "locked-0", name);
    }
    assert.equal(handle(page, "p").getAttribute("draggable"), null);
    page.named("Remove p").click();
    page.named("Remove session 1").click();
    page.named("Move q right").click();
    assert.deepEqual(page.saves(), []);
    assert.equal(page.status(), reason);
    // Into the started session, by arrow or by drop, is refused too.
    assert.equal(page.named("Move r left").getAttribute("aria-disabled"), "true");
    assert.equal(page.named("Move r left").getAttribute("title"), reason);
    drag(page, "s", () => cardOf(page, "p"));
    assert.deepEqual(page.saves(), []);
    // Its settings, and every later session, stay free.
    const args = page.doc.getElementById("args-0-0") as HTMLTextAreaElement;
    args.value = "more";
    args.dispatchEvent(new page.w.Event("change"));
    assert.equal(page.saves()[0]!.sessions[0]!.cards[0]!.args, "more");
    page.named("Move r right").click();
    assert.deepEqual(lanes(page.saves()[1]!), [["p", "q"], [], ["r", "s"]]);
  });

  it("locks nothing for a run on another chain", async () => {
    const page = await openSplit({ running: true, locked: { chainId: "own", through: 2 } });
    assert.equal(page.named("Move p right").getAttribute("aria-disabled"), "false");
    assert.equal(handle(page, "p").getAttribute("draggable"), "true");
  });

  it("holds a state that arrives mid-drag, so the card stays, and renders it when the drag ends", async () => {
    const page = await openSplit();
    fire(page, handle(page, "p"), "dragstart");
    const held = handle(page, "p");
    page.send({ chains: [own, other, split, { ...other, id: "late", name: "Late" }] });
    assert.ok(held.isConnected, "not re-rendered while dragging");
    assert.equal(page.all("#rail button").some((b) => b.textContent === "Late"), false);
    fire(page, page.doc, "dragend");
    assert.ok(page.named("Late"));
  });

  it("offers no drag on a template", async () => {
    const page = await open();
    page.send();
    assert.equal(page.all('.card-label[draggable="true"]').length, 0);
  });
});

describe("chains webview: editing a chain", () => {
  it("moves a card right with its button, keeps focus on that button at the new place, and announces it", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Move a right").click();
    assert.deepEqual(page.cardSkills(), ["acme:b", "acme:a", "acme:c"]);
    assert.deepEqual(page.saves()[0]!.sessions[0]!.cards.map((c) => c.skill), ["acme:b", "acme:a", "acme:c"]);
    assert.equal(page.focused(), page.named("Move a right"));
    assert.equal(page.status(), "Moved a to position 2");
  });

  it("moves a card with Alt+Left from anywhere on the card", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Remove c").dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }));
    assert.deepEqual(page.cardSkills(), ["acme:a", "acme:c", "acme:b"]);
    assert.equal(page.focused(), page.named("Move c left"));
  });

  it("ignores arrows without Alt, and a move past either end", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Move a left").dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    page.named("Move a left").click();
    page.named("Move c right").click();
    assert.deepEqual(page.saves(), []);
    assert.deepEqual(page.cardSkills(), ["acme:a", "acme:b", "acme:c"]);
  });

  it("after a remove, focuses the card that took its place, then the one before, then Add", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Remove a").click();
    assert.equal(page.focused(), page.named("Remove b"));
    page.named("Remove c").click();
    assert.equal(page.focused(), page.named("Remove b"));
    page.named("Remove b").click();
    assert.equal(page.focused(), page.named("Add"));
    assert.equal(page.status(), "Removed b");
  });

  it("adds the skill picked in the palette, m-skills first, and focuses the new card", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const select = page.doc.getElementById("palette-0") as HTMLSelectElement;
    assert.equal(select.options[0]!.value, "m-skills:code-review-architect-uncommitted");
    assert.equal(page.doc.querySelector('label[for="palette-0"]')!.textContent, "Add a skill to session 1");
    select.value = "acme:lint";
    page.named("Add").click();
    assert.deepEqual(page.cardSkills(), ["acme:a", "acme:b", "acme:c", "acme:lint"]);
    assert.equal(page.focused(), page.named("Remove lint"));
    assert.equal(page.status(), "Added lint");
  });

  describe("filtering the skills", () => {
    const type = (page: Awaited<ReturnType<typeof open>>, text: string) => {
      const filter = page.doc.getElementById("filter-0") as HTMLInputElement;
      filter.focus();
      filter.value = text;
      filter.dispatchEvent(new page.w.Event("input", { bubbles: true }));
      return filter;
    };
    const skills = (page: Awaited<ReturnType<typeof open>>) => [...(page.doc.getElementById("palette-0") as HTMLSelectElement).options].map((o) => o.value);

    it("narrows the list to the skills whose name holds the text, says how many, and keeps focus in the filter", async () => {
      const page = await open({ selectedId: "own" });
      page.send();
      assert.equal(page.doc.querySelector('label[for="filter-0"]')!.textContent, "Filter skills for session 1");
      const filter = type(page, "LINT");
      assert.deepEqual(skills(page), ["acme:lint"]);
      await new Promise((resolve) => page.w.requestAnimationFrame(resolve));
      assert.equal(page.status(), "1 skill matches");
      assert.equal(page.focused(), filter);
      page.named("Add").click();
      assert.deepEqual(page.cardSkills(), ["acme:a", "acme:b", "acme:c", "acme:lint"]);
    });

    it("says when nothing matches, and turns Add off with the reason said aloud", async () => {
      const page = await open({ selectedId: "own" });
      page.send();
      type(page, "zzz");
      assert.deepEqual(skills(page), [""]);
      assert.equal((page.doc.getElementById("palette-0") as HTMLSelectElement).options[0]!.textContent, "No skills match");
      assert.equal(page.named("Add").getAttribute("aria-disabled"), "true");
      page.named("Add").click();
      await new Promise((resolve) => page.w.requestAnimationFrame(resolve));
      assert.equal(page.status(), "No skill matches the filter. Change it to add one.");
      assert.equal(page.saves().length, 0);
      type(page, "");
      assert.equal(page.named("Add").getAttribute("aria-disabled"), "false");
      assert.equal(skills(page).length, 8);
    });

    it("keeps the filter's text across a new state, once focus has left it", async () => {
      const page = await open({ selectedId: "own" });
      page.send();
      type(page, "acme");
      page.named("Refresh skills").focus();
      page.send({ running: true });
      assert.equal((page.doc.getElementById("filter-0") as HTMLInputElement).value, "acme");
      assert.deepEqual(skills(page), ["acme:a", "acme:b", "acme:c", "acme:lint"]);
    });
  });

  it("keeps the skill picked in the palette, and focus on it, when a state arrives before Add", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const before = page.doc.getElementById("palette-0") as HTMLSelectElement;
    before.value = "acme:lint";
    before.dispatchEvent(new page.w.Event("change"));
    before.focus();
    page.send({ running: true });
    const after = page.doc.getElementById("palette-0") as HTMLSelectElement;
    assert.notEqual(after, before, "the state re-rendered the palette");
    assert.equal(after.value, "acme:lint");
    assert.equal(page.focused(), after);
    page.named("Add").click();
    assert.deepEqual(page.cardSkills(), ["acme:a", "acme:b", "acme:c", "acme:lint"]);
  });

  it("turns Add off at the most skills a session holds, says why, and saves nothing", async () => {
    const full: Chain = { id: "own", name: "Own", sessions: [{ cards: Array.from({ length: MAX_CARDS }, () => defaultCard("acme:a")) }] };
    const page = await open({ selectedId: "own" });
    page.send({ chains: [full] });
    const add = page.named("Add");
    assert.equal(add.getAttribute("aria-disabled"), "true");
    assert.equal(page.doc.getElementById(add.getAttribute("aria-describedby")!)!.textContent, `A session holds at most ${MAX_CARDS} skills.`);
    assert.equal(add.title, `A session holds at most ${MAX_CARDS} skills.`);
    add.click();
    assert.deepEqual(page.saves(), []);
    assert.equal(page.status(), `A session holds at most ${MAX_CARDS} skills.`);
  });

  it("leaves no stray text under Add a session while more sessions fit", async () => {
    const own: Chain = { id: "own", name: "Own", sessions: [{ cards: [defaultCard("acme:a")] }] };
    const page = await open({ selectedId: "own" });
    page.send({ chains: [own] });
    const detail = page.doc.getElementById("detail")!;
    assert.equal(page.named("Add a session").getAttribute("aria-disabled"), "false");
    assert.equal(page.named("Add a session").hasAttribute("title"), false);
    assert.ok([...detail.childNodes].every((n) => n.nodeType === n.ELEMENT_NODE));
    assert.doesNotMatch(detail.textContent!, /undefined/);
  });

  it("turns Add a session off at the most sessions a chain holds, says why, and saves nothing", async () => {
    const full: Chain = { id: "own", name: "Own", sessions: Array.from({ length: MAX_SESSIONS }, () => ({ cards: [defaultCard("acme:a")] })) };
    const page = await open({ selectedId: "own" });
    page.send({ chains: [full] });
    const add = page.named("Add a session");
    assert.equal(add.getAttribute("aria-disabled"), "true");
    assert.equal(page.doc.getElementById(add.getAttribute("aria-describedby")!)!.textContent, `A chain holds at most ${MAX_SESSIONS} sessions.`);
    assert.equal(add.title, `A chain holds at most ${MAX_SESSIONS} sessions.`);
    add.click();
    assert.deepEqual(page.saves(), []);
    assert.equal(page.status(), `A chain holds at most ${MAX_SESSIONS} sessions.`);
  });

  it("keeps a card's arguments and the chain's name within what a stored chain holds", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    assert.equal(page.doc.getElementById("args-0-0")!.getAttribute("maxlength"), String(MAX_ARGS));
    assert.equal(page.doc.getElementById("chain-name")!.getAttribute("maxlength"), String(MAX_NAME));
  });

  it("does nothing on Add when the workspace offers no skills", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ palette: [] });
    page.named("Add").click();
    assert.deepEqual(page.saves(), []);
  });

  it("leaves your other chains as they are when one is edited", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Remove a").click();
    page.select("Other");
    assert.deepEqual(page.cardSkills(), ["acme:lint"]);
  });

  it("saves a card's arguments when the field changes", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const field = page.doc.getElementById("args-0-1") as HTMLTextAreaElement;
    assert.equal(page.doc.querySelector('label[for="args-0-1"]')!.textContent, "Arguments for b");
    field.value = "--fast";
    field.dispatchEvent(new page.w.Event("change", { bubbles: true }));
    assert.equal(page.saves()[0]!.sessions[0]!.cards[1]!.args, "--fast");
  });

  it("renames a chain, ignoring a blank name", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const name = page.doc.getElementById("chain-name") as HTMLInputElement;
    name.value = "   ";
    name.dispatchEvent(new page.w.Event("change"));
    assert.deepEqual(page.saves(), []);
    name.value = "  Lint chain ";
    name.dispatchEvent(new page.w.Event("change"));
    assert.equal(page.saves()[0]!.name, "Lint chain");
  });

  it("adds and removes sessions", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Add a session").click();
    assert.equal(page.all("#detail section").length, 2);
    assert.equal(page.focused(), page.all('[data-focus="add-1"]')[0]);
    page.named("Remove session 2").click();
    assert.equal(page.all("#detail section").length, 1);
    assert.equal(page.focused(), page.named("Add a session"));
  });

  it("says what a removed card was, and Undo puts it back with focus on its Remove button", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Remove b").click();
    assert.equal(page.doc.querySelector("#detail .notice > span")!.textContent, "Removed b");
    page.named("Undo remove b").click();
    assert.deepEqual(page.saves().at(-1)!.sessions[0]!.cards.map((c) => c.skill), ["acme:a", "acme:b", "acme:c"]);
    assert.deepEqual(page.cardSkills(), ["acme:a", "acme:b", "acme:c"]);
    assert.equal(page.focused(), page.named("Remove b"));
    assert.equal(page.status(), "Restored b");
    assert.equal(page.doc.querySelector("#detail .notice"), null);
  });

  it("puts a removed session back with Undo, with focus on its Remove session button", async () => {
    const two: Chain = { ...own, sessions: [own.sessions[0]!, { cards: [defaultCard("acme:lint")] }] };
    const page = await open({ selectedId: "own" });
    page.send({ chains: [two, other] });
    page.named("Remove session 2").click();
    assert.equal(page.all("#detail section").length, 1);
    page.named("Undo remove session 2").click();
    assert.equal(page.all("#detail section").length, 2);
    assert.deepEqual(page.saves().at(-1)!.sessions[1]!.cards.map((c) => c.skill), ["acme:lint"]);
    assert.equal(page.focused(), page.named("Remove session 2"));
    assert.equal(page.status(), "Restored session 2");
  });

  it("keeps the notice through a state from the extension, and clears it on another edit or when another chain is picked", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const notice = () => page.doc.querySelector("#detail .notice");
    page.named("Remove b").click();
    page.send({ chains: [page.saves().at(-1)!, other] });
    assert.ok(notice(), "a state from the extension keeps it");
    page.named("Add a session").click();
    assert.equal(notice(), null, "another edit clears it");

    page.named("Remove c").click();
    assert.ok(notice());
    page.select("Other");
    page.select("Own");
    assert.equal(notice(), null, "picking a chain clears it");
  });

  it("asks the extension to delete a chain and to duplicate it", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Delete chain").click();
    assert.deepEqual(page.posted.at(-1), { type: "delete", id: "own" });
    page.named("Duplicate").click();
    assert.equal(page.saves()[0]!.name, "Own copy");
  });

  it("keeps focus where it was when the extension sends a new state", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Remove b").focus();
    page.send();
    assert.equal(page.focused(), page.named("Remove b"));
  });

  it("puts Run first and Delete chain last in the toolbar, the name in its own row, and Refresh skills once at the foot of the rail", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const toolbar = () => [...page.doc.querySelectorAll("#detail > .toolbar button")].map((b) => b.textContent);
    assert.deepEqual(toolbar(), ["Run Own", "Duplicate", "Delete chain"]);
    assert.ok(page.doc.querySelector("#detail > .name-row #chain-name"));
    assert.equal(page.doc.querySelector("#rail")!.lastElementChild!.textContent, "Refresh skills");
    assert.equal(page.all("button").filter((b) => b.textContent === "Refresh skills").length, 1);
    page.select("Story");
    assert.deepEqual(toolbar(), ["Run Story", "Duplicate to edit", "Remove template"]);
    assert.equal(page.doc.querySelector("#chain-name"), null);
  });

  it("keeps toolbar buttons focused across a new state", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    for (const name of ["Refresh skills", "Run Own", "Delete chain", "Duplicate"]) {
      page.named(name).focus();
      page.send();
      assert.equal(page.focused(), page.named(name), name);
    }
  });

  it("holds a state that arrives mid-typing, and applies it with the edit when the field changes", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const field = page.doc.getElementById("args-0-1") as HTMLTextAreaElement;
    field.focus();
    field.value = "--draft";
    page.send({ running: true });
    assert.equal(page.doc.getElementById("args-0-1"), field, "the field being typed in is not replaced");
    assert.equal(field.value, "--draft");
    assert.equal(page.named("Run Own").getAttribute("aria-disabled"), "false");
    field.dispatchEvent(new page.w.Event("change", { bubbles: true }));
    assert.equal(page.saves()[0]!.sessions[0]!.cards[1]!.args, "--draft");
    assert.equal(page.named("Run Own").getAttribute("aria-disabled"), "true");
  });

  it("applies a held state once focus leaves a field whose typing was undone", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const name = page.doc.getElementById("chain-name") as HTMLInputElement;
    name.focus();
    name.value = "Ow";
    page.send({ running: true });
    name.value = "Own";
    page.named("Remove b").focus();
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(page.named("Run Own").getAttribute("aria-disabled"), "true");
    assert.equal(page.focused(), page.named("Remove b"));
    assert.deepEqual(page.saves(), []);
  });

  it("after the chain on screen is deleted, focuses the heading shown in its place and announces it", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    page.named("Delete chain").click();
    page.send({ chains: [other] });
    assert.equal(page.focused(), page.doc.querySelector("#detail h2"));
    assert.equal(page.focused()!.textContent, "Story");
    assert.equal(page.status(), "Deleted Own");
  });
});

describe("chains webview: model and effort", () => {
  const models = [
    { id: "m-opus", label: "Opus", efforts: ["low", "high"] as Effort[] },
    { id: "m-haiku", label: "Haiku", efforts: [] as Effort[] },
    { id: "m-sonnet", label: "Sonnet", efforts: ["low"] as Effort[] },
  ];
  const listed = { models, defaultModel: "m-sonnet" };
  const withB = (patch: Partial<Card>): Chain => ({ ...own, sessions: [{ cards: [own.sessions[0]!.cards[0]!, { ...own.sessions[0]!.cards[1]!, ...patch }, own.sessions[0]!.cards[2]!] }] });
  const options = (page: Awaited<ReturnType<typeof open>>, id: string) => [...(page.doc.getElementById(id) as HTMLSelectElement).options].map((o) => o.textContent);
  const choose = (page: Awaited<ReturnType<typeof open>>, id: string, value: string) => {
    const field = page.doc.getElementById(id) as HTMLSelectElement;
    field.value = value;
    field.dispatchEvent(new page.w.Event("change", { bubbles: true }));
  };

  it("labels both selects with the card's name and offers Default, named after its model, the listed models and the default's efforts", async () => {
    const page = await open({ selectedId: "own" });
    page.send(listed);
    assert.equal(page.doc.querySelector('label[for="model-0-1"]')!.textContent, "Model for b");
    assert.equal(page.doc.querySelector('label[for="effort-0-1"]')!.textContent, "Effort for b");
    assert.deepEqual(options(page, "model-0-1"), ["Default (Sonnet)", "Opus", "Haiku", "Sonnet"]);
    assert.deepEqual(options(page, "effort-0-1"), ["Model default", "low"]);
    assert.equal((page.doc.getElementById("model-0-1") as HTMLSelectElement).value, "");
  });

  it("shows the settings on a template's cards, and saves a change to a copy that takes its place with focus on the same control", async () => {
    const page = await open({ selectedId: "kickoff" });
    page.send(listed);
    assert.equal(page.doc.querySelector('label[for="model-0-0"]')!.textContent, "Model for Kickoff");
    choose(page, "model-0-0", "m-opus");
    const [copy] = page.saves();
    assert.equal(copy!.name, "Kickoff copy");
    assert.equal(copy!.builtIn, undefined);
    assert.notEqual(copy!.id, "kickoff");
    assert.equal(copy!.sessions[0]!.cards[0]!.model, "m-opus");
    assert.equal(page.status(), "Copied Kickoff to Kickoff copy to save this change");
    assert.equal(page.doc.querySelector("#detail .notice")!.textContent, "Saved as Kickoff copy. Templates don't change.");
    assert.deepEqual(page.stored(), { selectedId: copy!.id });
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Kickoff copy");
    assert.equal(page.focused()?.id, "model-0-0");
    assert.equal((page.doc.getElementById("model-0-0") as HTMLSelectElement).value, "m-opus");
    assert.equal(TEMPLATES.find((t) => t.id === "kickoff")!.sessions[0]!.cards[0]!.model, undefined, "the template is untouched");
  });

  it("copies a template for an effort change too", async () => {
    const page = await open({ selectedId: "kickoff" });
    page.send(listed);
    choose(page, "effort-0-0", "low");
    assert.equal(page.saves()[0]!.sessions[0]!.cards[0]!.effort, "low");
    assert.equal(page.focused()?.id, "effort-0-0");
  });

  it("pins a model, keeps focus on its select and says it saved", async () => {
    const page = await open({ selectedId: "own" });
    page.send(listed);
    choose(page, "model-0-1", "m-opus");
    assert.deepEqual(page.saves()[0]!.sessions[0]!.cards[1], { ...own.sessions[0]!.cards[1]!, model: "m-opus" });
    assert.equal(page.focused()?.id, "model-0-1");
    assert.equal(page.status(), "Saved b");
    assert.deepEqual(options(page, "effort-0-1"), ["Model default", "low", "high"]);
  });

  it("keeps the effort when the new model takes it, and drops it when it does not", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ ...listed, chains: [withB({ effort: "low" }), other] });
    choose(page, "model-0-1", "m-opus");
    assert.deepEqual(page.saves()[0]!.sessions[0]!.cards[1], { ...own.sessions[0]!.cards[1]!, model: "m-opus", effort: "low" });
    page.send({ ...listed, chains: [withB({ model: "m-opus", effort: "high" }), other] });
    choose(page, "model-0-1", "");
    assert.deepEqual(page.saves()[1]!.sessions[0]!.cards[1], own.sessions[0]!.cards[1]);
  });

  it("sets and clears the effort", async () => {
    const page = await open({ selectedId: "own" });
    page.send(listed);
    choose(page, "effort-0-1", "low");
    assert.equal(page.saves()[0]!.sessions[0]!.cards[1]!.effort, "low");
    assert.equal(page.focused()?.id, "effort-0-1");
    choose(page, "effort-0-1", "");
    assert.equal(Object.hasOwn(page.saves()[1]!.sessions[0]!.cards[1]!, "effort"), false);
  });

  it("turns Effort off and says why when there is nothing to pick", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ ...listed, chains: [withB({ model: "m-haiku" }), other] });
    const effort = page.doc.getElementById("effort-0-1")!;
    assert.equal(effort.getAttribute("aria-disabled"), "true");
    assert.equal(page.doc.getElementById(effort.getAttribute("aria-describedby")!)!.textContent, "This model has no effort setting.");
    assert.equal(effort.title, "This model has no effort setting.");
    page.send();
    assert.equal(page.doc.getElementById("effort-0-1")!.getAttribute("aria-disabled"), "true");
    assert.match(page.doc.getElementById("effort-why-0-1")!.textContent!, /once the session's models are listed/);
  });

  it("keeps a stored model the session does not offer, marks it, and turns Run off", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ ...listed, chains: [withB({ model: "m-gone" }), other] });
    const model = page.doc.getElementById("model-0-1") as HTMLSelectElement;
    assert.equal(model.value, "m-gone");
    assert.equal(model.selectedOptions[0]!.textContent, "m-gone (not offered by this session)");
    assert.ok(page.all(".card .flag").some((f) => f.textContent === "Model not offered by this session"));
    assert.equal(page.doc.getElementById("run-reason")!.textContent, "b: model m-gone is not offered by this session.");
  });

  it("lets an effort the model no longer takes go back to the default", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ ...listed, chains: [withB({ model: "m-opus", effort: "max" }), other] });
    const effort = page.doc.getElementById("effort-0-1") as HTMLSelectElement;
    assert.equal(effort.selectedOptions[0]!.textContent, "max (not offered)");
    assert.equal(effort.getAttribute("aria-disabled"), "false");
    choose(page, "effort-0-1", "");
    assert.deepEqual(page.saves()[0]!.sessions[0]!.cards[1], { ...own.sessions[0]!.cards[1]!, model: "m-opus" });
  });

  it("says when the models could not be listed", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ modelsError: "unsupported" });
    assert.ok(
      page.all("#detail .note").some((n) => n.textContent === "Cards on Default run on the session's own default model, unchecked, and a card with a model keeps it, checked when its session starts. Models could not be listed: unsupported"),
    );
  });

  it("shows a pinned model as stored, unmarked, while the models are not listed", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ modelsError: "unsupported", chains: [withB({ model: "m-opus" }), other] });
    const model = page.doc.getElementById("model-0-1") as HTMLSelectElement;
    assert.deepEqual(options(page, "model-0-1"), ["Default", "m-opus"]);
    assert.equal(model.selectedOptions[0]!.textContent, "m-opus");
    assert.ok(!page.all(".card .flag").some((f) => f.textContent === "Model not offered by this session"));
    assert.equal(page.named("Run Own").getAttribute("aria-disabled"), "false");
  });

  describe("taking model and effort from the previous step", () => {
    const planned = (follow: boolean): Chain => ({
      id: "own",
      name: "Own",
      sessions: [{ cards: [defaultCard("m-skills:planning-architect"), { ...defaultCard("m-skills:implementing-architect"), model: "m-opus", ...(follow ? { follow: true as const } : {}) }] }],
    });
    const box = (page: Awaited<ReturnType<typeof open>>) => page.doc.getElementById("follow-1") as HTMLInputElement | null;
    const ticked = (page: Awaited<ReturnType<typeof open>>, id: string) => page.doc.getElementById(id) as HTMLSelectElement;

    it("offers it after an m-skills card, and turns both lists off while it is ticked, saying they are the fallback", async () => {
      const page = await open({ selectedId: "own" });
      page.send({ ...listed, mskills: true, chains: [planned(true)] });
      const follow = page.doc.getElementById("follow-0-1") as HTMLInputElement;
      assert.equal(follow.checked, true);
      assert.equal(follow.closest("label")!.textContent, " Take model and effort from the previous step for Implement");
      assert.equal(page.doc.getElementById(follow.getAttribute("aria-describedby")!)!.textContent, "Model and Effort below are used only when the previous step suggests nothing.");
      assert.equal(ticked(page, "model-0-1").disabled, true);
      assert.equal(ticked(page, "effort-0-1").disabled, true);
      assert.equal(ticked(page, "model-0-1").value, "m-opus");
      assert.equal(page.doc.getElementById("follow-0-0"), null, "the first card of a session has no step before it");
      assert.equal(box(page), null);
    });

    it("saves the box, keeps focus on it, and turns the lists back on when it is cleared", async () => {
      const page = await open({ selectedId: "own" });
      page.send({ ...listed, mskills: true, chains: [planned(false)] });
      const follow = page.doc.getElementById("follow-0-1") as HTMLInputElement;
      assert.equal(ticked(page, "model-0-1").disabled, false);
      assert.match(page.doc.getElementById("follow-why-0-1")!.textContent!, /they win over the previous step's suggestion/);
      follow.checked = true;
      follow.dispatchEvent(new page.w.Event("change", { bubbles: true }));
      assert.equal(page.saves()[0]!.sessions[0]!.cards[1]!.follow, true);
      assert.equal(page.focused()?.id, "follow-0-1");
      assert.equal(ticked(page, "model-0-1").disabled, true);
      const again = page.doc.getElementById("follow-0-1") as HTMLInputElement;
      again.checked = false;
      again.dispatchEvent(new page.w.Event("change", { bubbles: true }));
      assert.equal(Object.hasOwn(page.saves()[1]!.sessions[0]!.cards[1]!, "follow"), false);
    });

    it("hides it while m-skills is not installed or not yet known, leaving the lists on and the stored choice as it was", async () => {
      for (const mskills of [false, undefined]) {
        const page = await open({ selectedId: "own" });
        page.send({ ...listed, mskills, chains: [planned(true)] });
        assert.equal(page.doc.getElementById("follow-0-1"), null);
        assert.equal(ticked(page, "model-0-1").disabled, false);
        assert.equal(page.saves().length, 0);
      }
    });

    it("copies a template when its box is changed", async () => {
      const page = await open({ selectedId: "story" });
      page.send({ ...listed, mskills: true });
      const follow = page.doc.getElementById("follow-0-1") as HTMLInputElement;
      assert.equal(follow.checked, true, "the Story template's Implement card follows its plan");
      follow.checked = false;
      follow.dispatchEvent(new page.w.Event("change", { bubbles: true }));
      assert.equal(page.saves()[0]!.name, "Story copy");
      assert.equal(page.focused()?.id, "follow-0-1");
    });
  });
});

describe("chains webview: pause for me", () => {
  const box = (page: Awaited<ReturnType<typeof open>>, id: string) => page.doc.getElementById(id) as HTMLInputElement;
  const toggle = (page: Awaited<ReturnType<typeof open>>, id: string) => {
    box(page, id).checked = !box(page, id).checked;
    box(page, id).dispatchEvent(new page.w.Event("change", { bubbles: true }));
  };

  it("is a checkbox named for its card, and saves the pause on the user's own chain", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const field = box(page, "pause-0-1");
    assert.equal(field.type, "checkbox");
    assert.equal(field.checked, false);
    assert.equal(field.closest("label")!.textContent, " Pause for me after b");
    toggle(page, "pause-0-1");
    assert.deepEqual(page.saves()[0]!.sessions[0]!.cards[1], { ...own.sessions[0]!.cards[1]!, pause: true });
    assert.equal(page.saves()[0]!.id, "own");
    assert.equal(page.status(), "Saved b");
    assert.equal(page.focused()?.id, "pause-0-1");
  });

  it("copies a template to turn its pause off", async () => {
    const page = await open({ selectedId: "kickoff" });
    page.send();
    toggle(page, "pause-0-0");
    assert.equal(page.saves()[0]!.name, "Kickoff copy");
    assert.equal(page.saves()[0]!.sessions[0]!.cards[0]!.pause, false);
    assert.equal(page.focused()?.id, "pause-0-0");
  });
});

describe("chains webview: running", () => {
  it("runs a runnable chain", async () => {
    const page = await open({ selectedId: "own" });
    page.send();
    const run = page.named("Run Own");
    assert.equal(run.getAttribute("aria-disabled"), "false");
    run.click();
    assert.deepEqual(page.posted.at(-1), { type: "run", id: "own" });
  });

  it("runs a template with a pausing card, and flags the card", async () => {
    const page = await open();
    page.send({ palette: palette([...REQUIRED_COMMANDS, "m-skills:kickoff"]) });
    page.select("New project");
    const run = page.named("Run New project");
    assert.equal(run.getAttribute("aria-disabled"), "false");
    run.click();
    assert.deepEqual(page.posted.at(-1), { type: "run", id: "new-project" });
    assert.equal((page.doc.getElementById("pause-0-0") as HTMLInputElement).checked, true);
  });

  it("runs a single skill from its template", async () => {
    const page = await open();
    page.send({ palette: palette([...REQUIRED_COMMANDS, "m-skills:kickoff"]) });
    page.select("Kickoff");
    page.named("Run Kickoff").click();
    assert.deepEqual(page.posted.at(-1), { type: "run", id: "kickoff" });
    assert.match(page.doc.getElementById("detail")!.textContent!, /Starts from a name only/);
  });

  it("disables Run with the reason linked to it, and announces the reason instead of running", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ palette: palette(["acme:a", "acme:b"]) });
    const run = page.named("Run Own");
    assert.equal(run.getAttribute("aria-disabled"), "true");
    const reason = page.doc.getElementById(run.getAttribute("aria-describedby")!)!;
    assert.match(reason.textContent!, /Missing skills/);
    run.click();
    assert.equal(page.posted.some((m) => m.type === "run"), false);
    assert.match(page.status()!, /Missing skills/);
  });

  it("marks the card a run is on, in text and as the current step", async () => {
    const page = await open();
    page.send({ running: true, runningAt: { chainId: "story", session: 1, index: 0 } });
    const current = page.all('.card[aria-current="step"]');
    assert.equal(current.length, 1);
    assert.equal(current[0]!.querySelector(".card-label")!.textContent, "Review");
    assert.equal(current[0]!.querySelector(".flag.running")!.textContent, "Running");
    page.send({ running: true, runningAt: { chainId: "own", session: 0, index: 0 } });
    assert.equal(page.all('.card[aria-current="step"]').length, 0);
  });

  it("scrolls the card a run is on into view when it starts running or waiting, and not again on the same card", async () => {
    const page = await open();
    page.send({ running: true, runningAt: { chainId: "story", session: 0, index: 1 } });
    assert.deepEqual(page.scrolled.map((c) => c.querySelector(".card-label")!.textContent), ["Implement"]);
    page.send({ running: true, runningAt: { chainId: "story", session: 0, index: 1 } });
    assert.equal(page.scrolled.length, 1);
    page.send({ running: true, runningAt: { chainId: "story", session: 0, index: 1, waiting: true } });
    assert.equal(page.scrolled.length, 2);
    page.send({ running: true, runningAt: { chainId: "story", session: 1, index: 0 } });
    assert.equal(page.scrolled.at(-1)!.querySelector(".card-label")!.textContent, "Review");
  });

  it("scrolls nothing when the run is on a chain that is not shown", async () => {
    const page = await open();
    page.send({ running: true, runningAt: { chainId: "own", session: 0, index: 0 } });
    assert.equal(page.scrolled.length, 0);
  });

  it("marks the second of two cards that share a label when the run is on it", async () => {
    const twice: Chain = { id: "twice", name: "Twice", sessions: [{ cards: [defaultCard("acme:lint"), defaultCard("acme:lint")] }] };
    const page = await open({ selectedId: "twice" });
    page.send({ chains: [twice], running: true, runningAt: { chainId: "twice", session: 0, index: 1 } });
    const cards = page.all("#detail .card");
    assert.deepEqual(cards.map((c) => c.getAttribute("aria-current")), [null, "step"]);
  });

  it("disables Run while another run is in progress, and its tooltip says how to stop it", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ running: true });
    const run = page.named("Run Own");
    assert.equal(run.getAttribute("aria-disabled"), "true");
    assert.match(page.doc.getElementById("run-reason")!.textContent!, /in progress.*Coordiner: Stop Run/);
    assert.equal(run.title, page.doc.getElementById("run-reason")!.textContent);
    page.send({ running: false });
    assert.equal(page.named("Run Own").hasAttribute("title"), false);
  });

  it("notes a {{…}} in a card's arguments that Run will not fill", async () => {
    const withPath: Chain = { ...own, sessions: [{ cards: [{ ...defaultCard("acme:a"), args: "{{docs/stories/01.md}}" }, { ...defaultCard("acme:b"), args: "{{story}}" }] }] };
    const page = await open({ selectedId: "own" });
    page.send({ chains: [withPath] });
    const [first, second] = page.all("#detail .card");
    assert.match(first!.textContent!, /\{\{docs\/stories\/01\.md\}\} is not a placeholder/);
    assert.doesNotMatch(second!.textContent!, /not a placeholder/);
  });

  it("flags a card whose skill the workspace does not offer", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ palette: palette(["acme:a", "acme:b"]) });
    assert.match(page.all(".card")[2]!.textContent!, /Not available in this workspace/);
    assert.match(page.doc.getElementById("run-reason")!.textContent!, /Missing skills: acme:c/);
  });
});

describe("chains webview: m-skills and skill listing", () => {
  it("suggests m-skills with its link button when it is missing, and marks your chains that use it", async () => {
    const mine: Chain = { id: "mine", name: "Mine", sessions: [{ cards: [defaultCard("m-skills:planning-architect")] }] };
    const page = await open({ selectedId: "mine" });
    // The extension sends no templates while m-skills is missing.
    page.send({ mskills: false, templates: [], chains: [mine, other] });
    const banner = page.doc.querySelector("#banner section")!;
    assert.equal(banner.getAttribute("aria-labelledby"), "mskills-h");
    assert.match(banner.textContent!, /More with m-skills.*starter chains built on it show in the list, and a card can take its model and effort from the step before it/);
    page.named("Install m-skills (opens its page)").click();
    assert.deepEqual(page.posted.at(-1), { type: "openMskills" });
    assert.match(page.doc.getElementById("run-reason")!.textContent!, /Needs m-skills/);
    assert.equal(page.named("Mine, uses m-skills").textContent, "Mine, uses m-skills");
    assert.ok(page.all("#rail .note").some((n) => n.textContent === "Starter chains built on m-skills show here once it is installed."));
    assert.deepEqual(page.all("#rail h2").map((h) => h.textContent), ["My chains"]);
  });

  it("opens on your first chain when there are no templates, and on nothing when there are no chains either", async () => {
    const page = await open();
    page.send({ mskills: false, templates: [] });
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Own");
    page.send({ mskills: false, templates: [], chains: [] });
    assert.equal(page.doc.getElementById("detail")!.children.length, 0);
    assert.ok(page.all("#rail .note").some((n) => n.textContent === "No chains yet. Make one with New empty chain."));
  });

  it("shows no banner when m-skills is installed or not yet known", async () => {
    const page = await open();
    page.send();
    assert.equal(page.doc.getElementById("banner")!.children.length, 0);
    page.send({ mskills: undefined });
    assert.equal(page.doc.getElementById("banner")!.children.length, 0);
  });

  it("says skills are being listed until the palette arrives", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ palette: undefined });
    assert.match(page.doc.getElementById("detail")!.textContent!, /Listing the skills this workspace offers/);
    assert.equal(page.all("select[id^=palette]").length, 0);
  });

  it("offers Try again and Check Environment when listing failed", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ palette: undefined, paletteError: "not signed in" });
    assert.match(page.doc.getElementById("detail")!.textContent!, /Skills could not be listed: not signed in/);
    page.named("Try again").click();
    page.named("Check Environment").click();
    assert.deepEqual(page.posted.slice(-2), [{ type: "refreshPalette" }, { type: "checkEnvironment" }]);
  });

  it("re-lists skills on Refresh skills", async () => {
    const page = await open();
    page.send();
    page.named("Refresh skills").click();
    assert.deepEqual(page.posted.at(-1), { type: "refreshPalette" });
  });

  it("shows a storage problem as its own banner, and says it aloud when it first arrives", async () => {
    const page = await open();
    page.send({ storageError: "A change was not saved." });
    assert.match(page.doc.getElementById("banner")!.textContent!, /A problem with your saved chains.*not saved/);
    assert.equal(page.status(), "A change was not saved.");
    page.doc.getElementById("status")!.textContent = "";
    page.send({ storageError: "A change was not saved." });
    assert.equal(page.status(), "", "the same problem again is not repeated");
  });

  it("says each change that could not be saved aloud, even when the reason is the same as the last", async () => {
    const page = await open();
    const failed = "Changes could not be saved: EACCES: permission denied";
    page.send({ storageError: failed, unsaved: 1 });
    assert.equal(page.status(), failed);
    page.doc.getElementById("status")!.textContent = "";
    page.send({ storageError: failed, unsaved: 2 });
    assert.equal(page.status(), failed, "a second failure with the same reason is said again");
    page.doc.getElementById("status")!.textContent = "";
    page.send({ storageError: failed, unsaved: 2 });
    assert.equal(page.status(), "", "a state that brings no new failure stays quiet");
  });

  it("shows an empty detail pane when there is no chain at all", async () => {
    const page = await open();
    page.send({ templates: [], chains: [] });
    assert.equal(page.doc.getElementById("detail")!.children.length, 0);
    assert.match(page.doc.getElementById("rail")!.textContent!, /No chains yet\./);
  });

  it("ignores messages that are not a state", async () => {
    const page = await open();
    page.w.dispatchEvent(new page.w.MessageEvent("message", { data: { type: "other" } }));
    page.w.dispatchEvent(new page.w.MessageEvent("message", { data: null }));
    assert.equal(page.doc.getElementById("detail")!.children.length, 0);
  });
});

describe("chains webview: images on a card", () => {
  const shot = { id: "a".repeat(64), name: "ticket.png", bytes: 2048, mediaType: "image/png" as const };
  const mock = { id: "b".repeat(64), name: "mockup.jpg", bytes: 12, mediaType: "image/jpeg" as const };
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(done(), "never happened");
  };
  const withImages = (...images: ImageRef[]): Chain => ({ ...own, sessions: [{ cards: [{ ...own.sessions[0]!.cards[0]!, images }, ...own.sessions[0]!.cards.slice(1)] }] });
  const ready = async (chain: Chain = own) => {
    const page = await open({ selectedId: "own" });
    page.send({ chains: [chain, other] });
    return page;
  };

  it("sends an image pasted into a card's box to the extension to save, naming the card, and leaves the text paste alone", async () => {
    const page = await ready();
    const paste = new page.w.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new page.w.File([new Uint8Array(PNG)], "ticket.png")] } });
    page.doc.getElementById("args-0-0")!.dispatchEvent(paste);
    assert.equal(paste.defaultPrevented, false);
    await until(() => page.posted.some((m) => m.type === "cardAttachImage"));
    assert.deepEqual(page.posted.at(-1), { type: "cardAttachImage", target: "own:0:0", name: "ticket.png", data: Buffer.from(PNG).toString("base64") });
  });

  it("takes files dropped on a card's box without moving cards, and asks the picker from the card's Attach images", async () => {
    const page = await ready();
    const drop = new page.w.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new page.w.File([new Uint8Array(PNG)], "drop.png")] } });
    page.doc.getElementById("args-0-1")!.dispatchEvent(drop);
    assert.equal(drop.defaultPrevented, true);
    await until(() => page.posted.some((m) => m.type === "cardAttachImage"));
    assert.equal((page.posted.at(-1) as unknown as { target: string }).target, "own:0:1");
    page.named("Attach images to a").click();
    assert.deepEqual(page.posted.at(-1), { type: "cardPickImages", target: "own:0:0" });
  });

  it("puts a saved image on its card with the text typed there, saves the chain, and says so", async () => {
    const page = await ready();
    const box = page.doc.getElementById("args-0-0") as HTMLTextAreaElement;
    box.focus();
    box.value = "see the ticket";
    page.message({ type: "cardImageSaved", target: "own:0:0", image: shot });
    const saved = page.saves().at(-1)!.sessions[0]!.cards[0]!;
    assert.deepEqual([saved.args, saved.images], ["see the ticket", [shot]]);
    assert.equal(page.status(), "Attached ticket.png, 2 KB to a");
    assert.equal(page.focused()?.id, "args-0-0");
  });

  it("puts a saved image on a chain that is not shown without the text typed in the shown chain, and on a card with nothing typed", async () => {
    const page = await ready();
    (page.doc.getElementById("args-0-0") as HTMLTextAreaElement).value = "a draft for Own";
    (page.doc.activeElement as HTMLElement).blur();
    page.message({ type: "cardImageSaved", target: "other:0:0", image: shot });
    const onOther = page.saves().at(-1)!;
    assert.equal(onOther.id, "other");
    assert.deepEqual([onOther.sessions[0]!.cards[0]!.args, onOther.sessions[0]!.cards[0]!.images], [other.sessions[0]!.cards[0]!.args, [shot]]);
    assert.equal(page.focused()?.id, "args-0-0", "nothing focused had a focus key: focus goes to the card's box");
    page.message({ type: "cardImageSaved", target: "own:0:1", image: mock });
    const onOwn = page.saves().at(-1)!.sessions[0]!.cards[1]!;
    assert.deepEqual([onOwn.args, onOwn.images], [own.sessions[0]!.cards[1]!.args, [mock]]);
  });

  it("takes a drag of files over a card's box for itself, so the card list does not see it, and leaves other drags alone", async () => {
    const page = await ready();
    const box = page.doc.getElementById("args-0-0")!;
    let reachedList = 0;
    box.parentElement!.addEventListener("dragover", () => void reachedList++);
    const over = (types: string[]) => {
      const event = new page.w.Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types, files: [] } });
      box.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(over(["Files"]), true);
    assert.equal(reachedList, 0);
    assert.equal(over(["text/plain"]), false);
    assert.equal(reachedList, 1);
  });

  it("ignores a paste with no clipboard data and a drop with no files on a card's box", async () => {
    const page = await ready();
    const box = page.doc.getElementById("args-0-0")!;
    box.dispatchEvent(new page.w.Event("paste", { bubbles: true }));
    const drop = new page.w.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
    box.dispatchEvent(drop);
    assert.equal(drop.defaultPrevented, false);
    assert.equal(page.posted.some((m) => m.type === "cardAttachImage"), false);
  });

  it("says when a file for a card cannot be read", async () => {
    const page = await ready();
    (globalThis as Record<string, unknown>).FileReader = class {
      onerror = () => undefined;
      readAsDataURL() {
        setImmediate(() => this.onerror());
      }
    };
    const paste = new page.w.Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new page.w.File([new Uint8Array(PNG)], "locked.png")] } });
    page.doc.getElementById("args-0-0")!.dispatchEvent(paste);
    await until(() => page.status() === "locked.png could not be read.");
    assert.equal(page.posted.some((m) => m.type === "cardAttachImage"), false);
  });

  it("shows a template card's images with Open only", async () => {
    const story = TEMPLATES.find((t) => t.id === "story")!;
    const [first, ...rest] = story.sessions;
    const withShot: Chain = { ...story, sessions: [{ cards: [{ ...first!.cards[0]!, images: [shot] }, ...first!.cards.slice(1)] }, ...rest] };
    const page = await open({ selectedId: "story" });
    page.send({ templates: [withShot, ...TEMPLATES.filter((t) => t.id !== "story")] });
    assert.deepEqual(page.all(".card .images .image-name").map((n) => n.textContent), ["ticket.png, 2 KB"]);
    page.named("Open ticket.png").click();
    assert.deepEqual(page.posted.at(-1), { type: "cardOpenImage", id: shot.id });
    assert.equal(page.all(".card .images button").length, 1, "no Remove on a template");
  });

  it("ignores a saved image for a card that is gone", async () => {
    const page = await ready();
    page.message({ type: "cardImageSaved", target: "gone:0:0", image: shot });
    assert.equal(page.saves().length, 0);
  });

  it("shows a card's images with Open and Remove; Remove saves the card without it and moves focus on", async () => {
    const page = await ready(withImages(shot, mock));
    assert.deepEqual(page.all(".card .images .image-name").map((n) => n.textContent), ["ticket.png, 2 KB", "mockup.jpg, 12 B"]);
    page.named("Open ticket.png").click();
    assert.deepEqual(page.posted.at(-1), { type: "cardOpenImage", id: shot.id });
    page.named("Remove ticket.png from a").click();
    assert.deepEqual(page.saves().at(-1)!.sessions[0]!.cards[0]!.images, [mock]);
    assert.equal(page.status(), "Removed ticket.png from a");
    assert.equal(page.focused()?.getAttribute("aria-label"), "Remove mockup.jpg from a");
    page.named("Remove mockup.jpg from a").click();
    assert.equal(page.saves().at(-1)!.sessions[0]!.cards[0]!.images, undefined);
    assert.equal(page.focused()?.id, "args-0-0");
  });

  it("refuses a sixth image on a card on the page, and says why an image was refused", async () => {
    const full = withImages(...Array.from({ length: 5 }, (_, n) => ({ ...shot, id: String(n).repeat(64) })));
    const page = await ready(full);
    const paste = new page.w.Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new page.w.File([new Uint8Array(PNG)], "one-more.png")] } });
    page.doc.getElementById("args-0-0")!.dispatchEvent(paste);
    assert.equal(page.status(), "A message takes at most 5 images.");
    page.message({ type: "cardImageProblem", target: "own:0:0", reason: "x.svg is not a PNG, JPEG, GIF or WebP image." });
    assert.equal(page.status(), "x.svg is not a PNG, JPEG, GIF or WebP image.");
  });
});
