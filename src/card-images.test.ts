import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CardImages, type CardImageFs } from "./card-images.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ID = createHash("sha256").update(PNG).digest("hex");

function memoryFs(fail: Partial<Record<keyof CardImageFs, true>> = {}) {
  const files = new Map<string, Uint8Array>();
  const no = (op: keyof CardImageFs) => {
    if (fail[op]) throw new Error(`${op} failed`);
  };
  const fs: CardImageFs = {
    readFile: async (path) => (no("readFile"), files.get(path) ?? Promise.reject(new Error("ENOENT"))),
    writeFile: async (path, data) => void (no("writeFile"), files.set(path, data)),
    rename: async (from, to) => {
      no("rename");
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    mkdir: async () => no("mkdir"),
    readdir: async () => (no("readdir"), [...files.keys()].map((p) => p.slice("/store/".length))),
    unlink: async (path) => void (no("unlink"), files.delete(path)),
  };
  return { fs, files };
}

describe("CardImages", () => {
  it("saves a checked image under the hash of its bytes, through a temporary file, and reads it back", async () => {
    const { fs, files } = memoryFs();
    const store = new CardImages("/store", fs);
    const saved = await store.save("ticket.png", PNG.toString("base64"));
    assert.deepEqual(saved, { ok: true, ref: { id: ID, name: "ticket.png", bytes: 12, mediaType: "image/png" } });
    assert.deepEqual([...files.keys()], [`/store/${ID}.png`]);
    assert.equal(await store.read({ id: ID, mediaType: "image/png" }), PNG.toString("base64"));
  });

  it("refuses an image that fails the check, writing nothing", async () => {
    const { fs, files } = memoryFs();
    const saved = await new CardImages("/store", fs).save("x.svg", Buffer.from("<svg/>").toString("base64"));
    assert.equal(saved.ok, false);
    assert.equal(files.size, 0);
  });

  it("says the image could not be saved when the disk refuses it", async () => {
    const { fs } = memoryFs({ writeFile: true });
    assert.deepEqual(await new CardImages("/store", fs).save("ticket.png", PNG.toString("base64")), { ok: false, reason: "ticket.png could not be saved." });
  });

  it("reads nothing for a file that is gone, or changed so it no longer matches its name", async () => {
    const { fs, files } = memoryFs();
    const store = new CardImages("/store", fs);
    assert.equal(await store.read({ id: ID, mediaType: "image/png" }), undefined);
    files.set(`/store/${ID}.png`, Buffer.from("tampered"));
    assert.equal(await store.read({ id: ID, mediaType: "image/png" }), undefined);
  });

  it("reads a turn's card images, skipping the chat's own, and names the first one it cannot read", async () => {
    const { fs, files } = memoryFs();
    const store = new CardImages("/store", fs);
    await store.save("mockup.png", PNG.toString("base64"));
    const card = { id: ID, name: "mockup.png", bytes: 12, mediaType: "image/png" as const };
    const chat = { id: "3f1c2a4e-0000-4000-8000-000000000000", name: "paste.png", bytes: 12, mediaType: "image/png" as const };
    assert.deepEqual(await store.readAll([chat, card]), { ok: true, data: new Map([[ID, PNG.toString("base64")]]) });
    files.clear();
    const gone = await store.readAll([chat, { ...card, name: "mock\u0007up.png" }]);
    assert.equal(gone.ok, false);
    assert.match(!gone.ok ? gone.reason : "", /^mockup\.png, an image on this card, is gone .* start a new run/);
  });

  it("deletes only its own files that no card names, and keeps one it cannot delete for next time", async () => {
    const { fs, files } = memoryFs();
    const kept = "a".repeat(64);
    const orphan = "b".repeat(64);
    for (const name of [`${kept}.png`, `${orphan}.jpg`, "notes.txt", `${ID}.png.123.tmp`]) files.set(`/store/${name}`, PNG);
    assert.deepEqual(await new CardImages("/store", fs).sweep(new Set([kept])), [orphan]);
    assert.deepEqual([...files.keys()].sort(), [`/store/${ID}.png.123.tmp`, `/store/${kept}.png`, "/store/notes.txt"].sort());
    const stuck = memoryFs({ unlink: true });
    stuck.files.set(`/store/${orphan}.jpg`, PNG);
    assert.deepEqual(await new CardImages("/store", stuck.fs).sweep(new Set()), []);
    assert.deepEqual(await new CardImages("/store", memoryFs({ readdir: true }).fs).sweep(new Set()), []);
  });
});
