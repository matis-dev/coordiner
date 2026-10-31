import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Nothing else reads package.json's contributions, so a view or command named wrong there would pass every other gate.
type View = { id: string; name: string };
type Entry = { command?: string; when?: string };
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  contributes: {
    commands: { command: string }[];
    views: Record<string, View[]>;
    viewsWelcome: { view: string; contents: string }[];
    menus: Record<string, Entry[]>;
  };
};
const { commands, views, viewsWelcome, menus } = manifest.contributes;
const viewIds = Object.values(views).flat().map((v) => v.id);

describe("the manifest's views", () => {
  it("shows the Start view above the Sessions list in the Coordiner container", () => {
    assert.deepEqual(views.coordiner!.map((v) => v.id), ["coordiner.start", "coordiner.run"]);
  });

  it("gives every welcome text a view that exists", () => {
    for (const { view } of viewsWelcome) assert.ok(viewIds.includes(view), view);
    assert.deepEqual(viewsWelcome.map((w) => w.view).sort(), ["coordiner.run", "coordiner.start"]);
  });

  it("links every welcome button to a command that exists", () => {
    const declared = commands.map((c) => c.command);
    const linked = viewsWelcome.flatMap((w) => [...w.contents.matchAll(/\]\(command:([^)\s]+)\)/g)].map((m) => m[1]!));
    assert.deepEqual(linked, ["coordiner.start", "coordiner.openChains"]);
    for (const command of linked) assert.ok(declared.includes(command), command);
  });

  it("gives the empty Sessions list plain text, with no button", () => {
    const run = viewsWelcome.find((w) => w.view === "coordiner.run")!;
    assert.doesNotMatch(run.contents, /command:/);
  });

  it("keeps the title-bar start and chains buttons on the Sessions view, for when Start is collapsed", () => {
    const title = menus["view/title"]!.filter((e) => e.when?.startsWith("view == coordiner.run"));
    for (const command of ["coordiner.start", "coordiner.openChains"]) assert.ok(title.some((e) => e.command === command), command);
  });

  it("scopes every item menu to the Sessions view, never to Start", () => {
    for (const { when } of menus["view/item/context"]!) assert.match(when!, /^view == coordiner\.run /);
  });
});
