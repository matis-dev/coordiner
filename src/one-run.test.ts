import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { oneRun } from "./one-run.ts";

// A task the test finishes by hand, so a second Run can arrive while the first is still going.
function pending() {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { task: () => done, finish, fail };
}

describe("oneRun", () => {
  it("refuses a second run while the first is still setting up, without starting it", async () => {
    const slot = oneRun(() => undefined);
    const first = pending();
    const running = slot.run(first.task);
    let started = false;
    assert.equal(await slot.run(async () => void (started = true)), false);
    assert.equal(started, false);
    assert.equal(slot.busy(), true);
    first.finish();
    assert.equal(await running, true);
  });

  it("gives the slot back when the run ends, so the next one can start", async () => {
    const slot = oneRun(() => undefined);
    assert.equal(await slot.run(async () => undefined), true);
    assert.equal(slot.busy(), false);
    assert.equal(await slot.run(async () => undefined), true);
  });

  it("gives the slot back when the run throws, and passes the error on", async () => {
    const slot = oneRun(() => undefined);
    const first = pending();
    const running = slot.run(first.task);
    first.fail(new Error("worktree failed"));
    await assert.rejects(running, /worktree failed/);
    assert.equal(slot.busy(), false);
  });

  it("gives the slot back when telling the editor throws, so Run is not lost until a reload", async () => {
    let calls = 0;
    const slot = oneRun(() => {
      if (calls++ === 0) throw new Error("post failed");
    });
    let started = false;
    await assert.rejects(slot.run(async () => void (started = true)), /post failed/);
    assert.equal(started, false);
    assert.equal(slot.busy(), false);
    assert.equal(await slot.run(async () => undefined), true);
  });

  it("says when the slot is taken and when it is given back", async () => {
    const seen: boolean[] = [];
    const slot = oneRun(() => seen.push(slot.busy()));
    await slot.run(async () => undefined);
    assert.deepEqual(seen, [true, false]);
  });
});
