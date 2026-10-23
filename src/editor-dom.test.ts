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
const base = (): Omit<EditorState, "type"> => ({ templates: TEMPLATES, chains: [own, other], running: false, mskills: true, palette: palette([...REQUIRED_COMMANDS, "acme:a", "acme:b", "acme:c", "acme:lint"]) });

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
    requestAnimationFrame: (callback: () => void) => callback(),
    acquireVsCodeApi: () => ({ postMessage: (m: Posted) => posted.push(m), getState: () => state, setState: (s: unknown) => (state = s) }),
  });
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
    stored: () => state,
    all,
    named,
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

  it("lists templates with an m-skills badge and the user's chains in the rail", async () => {
    const page = await open();
    page.send();
    const rail = page.doc.getElementById("rail")!;
    assert.deepEqual([...rail.querySelectorAll("h2")].map((h) => h.textContent), ["Templates", "Single skills", "My chains"]);
    assert.deepEqual(
      [...rail.querySelectorAll("ul")].slice(0, 2).map((ul) => [...ul.querySelectorAll("button > span:first-child")].map((s) => s.textContent)),
      [["Story", "Idea", "Bug", "New project"], ["Kickoff", "Onboard", "Security audit", "UI audit", "Accessibility audit", "Docs audit"]],
    );
    assert.equal(rail.querySelectorAll(".badge").length, 10);
    assert.ok(page.named("Story, m-skills"), "the badge is spoken as part of the name, separated");
    assert.ok(page.named("Own"));
  });

  it("opens on the Story template, read-only, with a fresh-context divider between its sessions", async () => {
    const page = await open();
    page.send();
    assert.equal(page.doc.querySelector("#detail h2")!.textContent, "Story");
    assert.match(page.doc.getElementById("detail")!.textContent!, /Built-in template, read-only\./);
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
    assert.match(page.doc.getElementById("detail")!.textContent!, /Put \{\{story\}\}, \{\{idea\}\} or \{\{bug\}\} in a card's arguments/);
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
    page.select("Security audit, m-skills");
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

  it("creates an empty chain", async () => {
    const page = await open();
    page.send();
    page.named("New empty chain").click();
    assert.deepEqual(page.saves()[0]!.sessions, [{ cards: [] }]);
    assert.match(page.doc.getElementById("detail")!.textContent!, /No skills in this session yet\./);
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
    add.click();
    assert.deepEqual(page.saves(), []);
    assert.equal(page.status(), `A session holds at most ${MAX_CARDS} skills.`);
  });

  it("turns Add a session off at the most sessions a chain holds, says why, and saves nothing", async () => {
    const full: Chain = { id: "own", name: "Own", sessions: Array.from({ length: MAX_SESSIONS }, () => ({ cards: [defaultCard("acme:a")] })) };
    const page = await open({ selectedId: "own" });
    page.send({ chains: [full] });
    const add = page.named("Add a session");
    assert.equal(add.getAttribute("aria-disabled"), "true");
    assert.equal(page.doc.getElementById(add.getAttribute("aria-describedby")!)!.textContent, `A chain holds at most ${MAX_SESSIONS} sessions.`);
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
  ];
  const listed = { models, tierEfforts: ["low"] as Effort[] };
  const withB = (patch: Partial<Card>): Chain => ({ ...own, sessions: [{ cards: [own.sessions[0]!.cards[0]!, { ...own.sessions[0]!.cards[1]!, ...patch }, own.sessions[0]!.cards[2]!] }] });
  const options = (page: Awaited<ReturnType<typeof open>>, id: string) => [...(page.doc.getElementById(id) as HTMLSelectElement).options].map((o) => o.textContent);
  const choose = (page: Awaited<ReturnType<typeof open>>, id: string, value: string) => {
    const field = page.doc.getElementById(id) as HTMLSelectElement;
    field.value = value;
    field.dispatchEvent(new page.w.Event("change", { bubbles: true }));
  };

  it("labels both selects with the card's name and offers the listed models and the tier efforts", async () => {
    const page = await open({ selectedId: "own" });
    page.send(listed);
    assert.equal(page.doc.querySelector('label[for="model-0-1"]')!.textContent, "Model for b");
    assert.equal(page.doc.querySelector('label[for="effort-0-1"]')!.textContent, "Effort for b");
    assert.deepEqual(options(page, "model-0-1"), ["By tier", "Opus", "Haiku"]);
    assert.deepEqual(options(page, "effort-0-1"), ["Model default", "low"]);
    assert.equal((page.doc.getElementById("model-0-1") as HTMLSelectElement).value, "");
  });

  it("shows no selects on a built-in template", async () => {
    const page = await open({ selectedId: "story" });
    page.send(listed);
    assert.equal(page.doc.querySelector("#detail select[id^=model]"), null);
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
      page.all("#detail .note").some((n) => n.textContent === "Cards on By tier run on their tier's model, and a pinned card keeps its model, checked when its session starts. Models could not be listed: unsupported"),
    );
  });

  it("shows a pinned model as stored, unmarked, while the models are not listed", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ modelsError: "unsupported", chains: [withB({ model: "m-opus" }), other] });
    const model = page.doc.getElementById("model-0-1") as HTMLSelectElement;
    assert.deepEqual(options(page, "model-0-1"), ["By tier", "m-opus"]);
    assert.equal(model.selectedOptions[0]!.textContent, "m-opus");
    assert.ok(!page.all(".card .flag").some((f) => f.textContent === "Model not offered by this session"));
    assert.equal(page.named("Run Own").getAttribute("aria-disabled"), "false");
  });

  it("notes that a pinned loop card keeps its model through tier stops", async () => {
    const loop: Chain = { id: "own", name: "Own", sessions: [{ cards: [{ ...defaultCard("m-skills:implementing-architect"), model: "m-opus" }] }] };
    const page = await open({ selectedId: "own" });
    page.send({ ...listed, chains: [loop] });
    assert.ok(page.all(".card-settings .note").some((n) => n.textContent === "Pinned: NEXT <tier> does not change this card's model."));
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
    page.select("New project, m-skills");
    const run = page.named("Run New project");
    assert.equal(run.getAttribute("aria-disabled"), "false");
    run.click();
    assert.deepEqual(page.posted.at(-1), { type: "run", id: "new-project" });
    assert.match(page.doc.getElementById("detail")!.textContent!, /Pauses for you/);
  });

  it("runs a single skill from its template", async () => {
    const page = await open();
    page.send({ palette: palette([...REQUIRED_COMMANDS, "m-skills:kickoff"]) });
    page.select("Kickoff, m-skills");
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
    assert.match(current[0]!.textContent!, /^Review.*Running$/);
    page.send({ running: true, runningAt: { chainId: "own", session: 0, index: 0 } });
    assert.equal(page.all('.card[aria-current="step"]').length, 0);
  });

  it("marks the second of two cards that share a label when the run is on it", async () => {
    const twice: Chain = { id: "twice", name: "Twice", sessions: [{ cards: [defaultCard("acme:lint"), defaultCard("acme:lint")] }] };
    const page = await open({ selectedId: "twice" });
    page.send({ chains: [twice], running: true, runningAt: { chainId: "twice", session: 0, index: 1 } });
    const cards = page.all("#detail .card");
    assert.deepEqual(cards.map((c) => c.getAttribute("aria-current")), [null, "step"]);
  });

  it("disables Run while another run is in progress", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ running: true });
    assert.equal(page.named("Run Own").getAttribute("aria-disabled"), "true");
    assert.match(page.doc.getElementById("run-reason")!.textContent!, /in progress/);
  });

  it("flags a card whose skill the workspace does not offer", async () => {
    const page = await open({ selectedId: "own" });
    page.send({ palette: palette(["acme:a", "acme:b"]) });
    assert.match(page.all(".card")[2]!.textContent!, /Not available in this workspace/);
    assert.match(page.doc.getElementById("run-reason")!.textContent!, /Missing skills: acme:c/);
  });
});

describe("chains webview: m-skills and skill listing", () => {
  it("shows the m-skills banner with its link button, and locks the templates, when m-skills is missing", async () => {
    const page = await open();
    page.send({ mskills: false });
    const banner = page.doc.querySelector("#banner section")!;
    assert.equal(banner.getAttribute("aria-labelledby"), "mskills-h");
    assert.match(banner.textContent!, /m-skills is not installed/);
    page.named("Install m-skills (opens its page)").click();
    assert.deepEqual(page.posted.at(-1), { type: "openMskills" });
    assert.match(page.doc.getElementById("run-reason")!.textContent!, /Needs m-skills/);
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
