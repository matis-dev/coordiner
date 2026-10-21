import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChainStore, type StoreFs } from "./chain-store.ts";
import { defaultCard, parseChains, serializeChains, type Chain } from "./chains.ts";

const FILE = "/store/chains.json";
const NOW = new Date("2026-10-21T10:20:30.456Z");
const BACKUP = `${FILE}.bak-20261021T102030456Z`;
const chain = (id: string): Chain => ({ id, name: id.toUpperCase(), sessions: [{ cards: [defaultCard("acme:x")] }] });
const missing = () => Object.assign(new Error("no such file"), { code: "ENOENT" });

// The disk as a map of path to text; each call is recorded, and any call can be made to fail.
function setup(files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files));
  const calls: string[] = [];
  const fail: Partial<Record<keyof StoreFs, Error>> = {};
  const fs: StoreFs = {
    async readFile(path) {
      calls.push(`read ${path}`);
      if (fail.readFile) throw fail.readFile;
      const text = disk.get(path);
      if (text === undefined) throw missing();
      return text;
    },
    async writeFile(path, text) {
      calls.push(`write ${path}`);
      if (fail.writeFile) throw fail.writeFile;
      disk.set(path, text);
    },
    async rename(from, to) {
      calls.push(`rename ${from} ${to}`);
      if (fail.rename) throw fail.rename;
      const text = disk.get(from);
      if (text === undefined) throw missing();
      disk.delete(from);
      disk.set(to, text);
    },
    async mkdir(path) {
      calls.push(`mkdir ${path}`);
    },
  };
  let saved = 0;
  const store = new ChainStore(FILE, fs, () => NOW, () => void saved++);
  const add = (c: Chain) => (chains: readonly Chain[]) => [...chains, c];
  return { store, disk, calls, fail, add, saved: () => saved, stored: () => parseChains(disk.get(FILE)!).chains.map((c) => c.id) };
}

describe("ChainStore: loading", () => {
  it("starts with no chains when the file does not exist yet, and creates it on the first save", async () => {
    const { store, add, stored } = setup();
    await store.load();
    assert.deepEqual(store.chains, []);
    assert.equal(store.error, undefined);
    await store.save(add(chain("a")));
    assert.deepEqual(stored(), ["a"]);
  });

  it("loads the chains the file holds, and reads it only once", async () => {
    const { store, calls } = setup({ [FILE]: serializeChains([chain("a")]) });
    await store.load();
    await store.load();
    assert.deepEqual(store.chains, [chain("a")]);
    assert.equal(calls.filter((c) => c.startsWith("read")).length, 1);
  });

  it("makes a second load wait for the first read, so the editor is never sent the chains before they are read", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fs: StoreFs = {
      readFile: async () => {
        await held;
        return serializeChains([chain("a")]);
      },
      writeFile: async () => {},
      rename: async () => {},
      mkdir: async () => {},
    };
    const store = new ChainStore(FILE, fs, () => NOW, () => {});
    void store.load();
    let second = false;
    const done = store.load().then(() => (second = true));
    await new Promise(setImmediate);
    assert.equal(second, false, "the second load is still waiting on the read");
    release();
    await done;
    assert.deepEqual(store.chains, [chain("a")]);
  });

  it("sets a file that is not valid JSON aside, keeps it, and saves to a fresh file", async () => {
    const { store, disk, add, stored } = setup({ [FILE]: "{oops" });
    await store.load();
    assert.equal(disk.get(BACKUP), "{oops");
    assert.equal(store.error, `The saved chains were set aside because the chains file is not valid JSON. The file is kept at ${BACKUP}.`);
    await store.save(add(chain("a")));
    assert.deepEqual(stored(), ["a"]);
    assert.equal(disk.get(BACKUP), "{oops");
    assert.match(store.error!, /kept at/, "where the old file went stays shown");
  });

  it("sets aside a file it cannot read", async () => {
    const { store, disk, fail } = setup({ [FILE]: serializeChains([chain("a")]) });
    fail.readFile = new Error("EACCES: permission denied");
    await store.load();
    assert.ok(disk.has(BACKUP));
    assert.match(store.error!, /because it could not be read \(EACCES: permission denied\)/);
  });

  it("never overwrites a bad file it cannot move aside: saving stays off, and the editor is still told", async () => {
    const { store, disk, calls, fail, add, saved } = setup({ [FILE]: "{oops" });
    fail.rename = new Error("EBUSY: resource busy");
    await store.load();
    assert.match(store.error!, /could not be set aside \(EBUSY: resource busy\)\. Changes are not saved until it is fixed: \/store\/chains\.json/);
    await store.save(add(chain("a")));
    assert.equal(disk.get(FILE), "{oops");
    assert.equal(calls.some((c) => c.startsWith("write")), false);
    assert.deepEqual(store.chains, []);
    assert.equal(saved(), 1);
  });
});

describe("ChainStore: saving", () => {
  it("runs saves one at a time, each applied to what the one before it left", async () => {
    const { store, add, stored, saved } = setup();
    const first = store.save(add(chain("a")));
    const second = store.save(add(chain("b")));
    assert.equal(store.saving, true);
    await Promise.all([first, second]);
    assert.deepEqual(stored(), ["a", "b"]);
    assert.deepEqual(store.chains.map((c) => c.id), ["a", "b"]);
    assert.equal(store.saving, false);
    assert.equal(saved(), 2);
  });

  it("writes to a temporary file and renames it into place, so a crash mid-write leaves the old file whole", async () => {
    const { store, calls, add } = setup();
    await store.save(add(chain("a")));
    assert.deepEqual(calls, ["mkdir /store", `write ${FILE}.tmp`, `rename ${FILE}.tmp ${FILE}`]);
  });

  it("keeps the chains as they were when a write fails, says why, and clears that once a save lands", async () => {
    const { store, disk, fail, add, saved } = setup({ [FILE]: serializeChains([chain("a")]) });
    await store.load();
    fail.writeFile = new Error("ENOSPC: no space left on device");
    await store.save(add(chain("b")));
    assert.deepEqual(store.chains, [chain("a")]);
    assert.equal(disk.get(FILE), serializeChains([chain("a")]));
    assert.equal(store.error, "Changes could not be saved: ENOSPC: no space left on device");
    assert.equal(saved(), 1);
    delete fail.writeFile;
    await store.save(add(chain("b")));
    assert.equal(store.error, undefined);
  });

  it("refuses an edit without writing, after the saves still queued, and says so until a save lands", async () => {
    const { store, calls, add, saved } = setup();
    const first = store.save(add(chain("a")));
    const refused = store.refuse();
    assert.equal(store.saving, true);
    await Promise.all([first, refused]);
    assert.equal(calls.filter((c) => c.startsWith("write")).length, 1);
    assert.deepEqual(store.chains.map((c) => c.id), ["a"]);
    assert.equal(store.error, "A change was not saved: it went past what a chain can hold. The editor shows your chains as last saved.");
    assert.equal(saved(), 2);
    await store.save(add(chain("b")));
    assert.equal(store.error, undefined);
  });

  it("counts each change it could not save, refused or failed, and not one that lands", async () => {
    const { store, fail, add } = setup();
    await store.save(add(chain("a")));
    assert.equal(store.unsaved, 0);
    await store.refuse();
    fail.writeFile = new Error("EACCES: permission denied");
    await store.save(add(chain("b")));
    await store.save(add(chain("b")));
    assert.equal(store.unsaved, 3, "the same reason twice still counts twice");
    assert.equal(store.error, "Changes could not be saved: EACCES: permission denied");
  });

  it("keeps saving after an edit that throws: the queue moves on, the problem is shown, and the editor is told", async () => {
    const { store, add, stored, saved } = setup();
    await store.save(() => {
      throw new Error("bad edit");
    });
    assert.equal(store.saving, false);
    assert.equal(store.error, "Changes could not be saved: bad edit");
    assert.equal(saved(), 1);
    await store.save(add(chain("a")));
    assert.deepEqual(stored(), ["a"]);
  });
});
