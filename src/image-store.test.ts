import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ImageStore } from "./image-store.ts";
import { MAX_HELD_IMAGES } from "./images.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

function setup() {
  const dropped: string[][] = [];
  let n = 0;
  const store = new ImageStore((ids) => void dropped.push(ids), () => `i${++n}`);
  return { store, dropped };
}

describe("ImageStore", () => {
  it("holds a checked image by id and gives back its ref and data", () => {
    const { store } = setup();
    const added = store.add("shot.png", PNG);
    assert.deepEqual(added, { ok: true, ref: { id: "i1", name: "shot.png", bytes: 12, mediaType: "image/png" } });
    assert.equal(store.has("i1"), true);
    assert.equal(store.data("i1"), PNG);
    assert.equal(store.ref("i1")?.name, "shot.png");
  });

  it("refuses an image that fails the check, holding nothing", () => {
    const { store } = setup();
    assert.equal(store.add("x.svg", Buffer.from("<svg/>").toString("base64")).ok, false);
    assert.equal(store.has("i1"), false);
  });

  it("holds up to the chat's limit and refuses one more", () => {
    const { store } = setup();
    for (let i = 0; i < MAX_HELD_IMAGES; i++) assert.equal(store.add("a.png", PNG).ok, true);
    const over = store.add("a.png", PNG);
    assert.equal(over.ok, false);
    assert.match((over as { reason: string }).reason, /already holds 20 images/);
  });

  it("tells which images it let go, once, and not ones it never held", () => {
    const { store, dropped } = setup();
    store.add("a.png", PNG);
    store.add("b.png", PNG);
    store.release(["i1", "i1", "nope"]);
    store.release(["i1"]);
    assert.deepEqual(dropped, [["i1"]]);
    assert.equal(store.data("i1"), undefined);
    assert.equal(store.has("i2"), true);
  });

  it("retains only the named images, and clear lets go of all", () => {
    const { store, dropped } = setup();
    for (const name of ["a", "b", "c"]) store.add(`${name}.png`, PNG);
    store.retain(["i2"]);
    assert.deepEqual(dropped, [["i1", "i3"]]);
    store.clear();
    assert.deepEqual(dropped, [["i1", "i3"], ["i2"]]);
    assert.equal(store.has("i2"), false);
  });

  it("names images with ids the webview protocol accepts", () => {
    const store = new ImageStore();
    const added = store.add("a.png", PNG);
    assert.match(added.ok ? added.ref.id : "", /^[a-z0-9-]{1,64}$/);
    store.clear();
    assert.deepEqual(store.ids(), [], "lets go with no one listening");
  });
});

describe("ImageStore.ids", () => {
  it("lists what it holds, in the order it took it", () => {
    const { store } = setup();
    store.add("a.png", PNG);
    store.add("b.png", PNG);
    store.release(["i1"]);
    assert.deepEqual(store.ids(), ["i2"]);
  });
});
