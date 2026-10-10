import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_STORY_CHARS, MAX_TURNS, runStorySession, type RunDeps, type RunEvent } from "./run.ts";
import type { TurnResult } from "./session.ts";

const models = { strong: "m-strong", medium: "m-medium", weak: "m-weak" };
const story = { heading: "Story 1: Login", body: "Add a login form." };
const reply = (text: string, n: number): TurnResult => ({ ok: true, sessionId: `sess-${n}`, model: "ignored", resultText: text });

// `script` answers turn N with script[N]; a function lets a test react to the request.
function harness(script: Array<TurnResult | (() => TurnResult)>, signal = new AbortController().signal) {
  const requests: Array<{ prompt: string; model: string; resume?: string }> = [];
  const events: RunEvent[] = [];
  const deps: RunDeps = {
    runTurn: async (request) => {
      requests.push(request);
      const next = script[requests.length - 1]!;
      return typeof next === "function" ? next() : next;
    },
    models,
    emit: (event) => void events.push(event),
    signal,
  };
  return { deps, requests, events };
}

describe("runStorySession", () => {
  it("plans on the strong model, then implements on the model the plan names, in one session", async () => {
    const { deps, requests, events } = harness([reply("plan\nCOORDINER: NEXT Light", 1), reply("built\nCOORDINER: DONE", 2)]);
    assert.deepEqual(await runStorySession(story, deps), { status: "done" });
    assert.deepEqual(requests.map((r) => [r.model, r.resume]), [["m-strong", undefined], ["m-weak", "sess-1"]]);
    assert.equal(requests[0]!.prompt, "/m-skills:planning-architect Story 1: Login\n\nAdd a login form.");
    assert.equal(requests[1]!.prompt, "/m-skills:implementing-architect Implement the approved plan above.");
    assert.deepEqual(events, [
      { type: "step-started", index: 0, label: "Plan", tier: "strong", model: "m-strong" },
      { type: "step-finished", index: 0, status: "done", detail: "next: Light" },
      { type: "step-started", index: 1, label: "Implement", tier: "weak", model: "m-weak" },
      { type: "step-finished", index: 1, status: "done", detail: "done" },
    ]);
  });

  it("switches the model at every tier stop and continues the plan", async () => {
    const { deps, requests } = harness([reply("COORDINER: NEXT Light", 1), reply("COORDINER: NEXT Standard", 2), reply("COORDINER: NEXT Heavy", 3), reply("COORDINER: DONE", 4)]);
    await runStorySession(story, deps);
    assert.deepEqual(requests.map((r) => r.model), ["m-strong", "m-weak", "m-medium", "m-strong"]);
    assert.equal(requests[2]!.prompt, "Continue with the next step of the plan.");
    assert.deepEqual(requests.map((r) => r.resume), [undefined, "sess-1", "sess-2", "sess-3"]);
  });

  it("stops on HALT with its reason", async () => {
    const { deps, events } = harness([reply("COORDINER: NEXT Light", 1), reply("COORDINER: HALT needs a migration decision", 2)]);
    assert.deepEqual(await runStorySession(story, deps), { status: "halted", reason: "needs a migration decision" });
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 1, status: "halted", detail: "needs a migration decision" });
  });

  it("reminds once on the same model when the status line is missing, then continues", async () => {
    const { deps, requests } = harness([reply("plan without marker", 1), reply("COORDINER: NEXT Standard", 2), reply("COORDINER: DONE", 3)]);
    assert.deepEqual(await runStorySession(story, deps), { status: "done" });
    assert.equal(requests[1]!.prompt, "End your reply with your COORDINER status line.");
    assert.deepEqual(requests.map((r) => r.model), ["m-strong", "m-strong", "m-medium"]);
    assert.equal(requests[2]!.prompt, "/m-skills:implementing-architect Implement the approved plan above.");
  });

  it("halts when the status line is still missing after the reminder", async () => {
    const { deps, requests } = harness([reply("no marker", 1), reply("still none", 2)]);
    const outcome = await runStorySession(story, deps);
    assert.equal(outcome.status, "halted");
    assert.equal(requests.length, 2);
  });

  it("allows a fresh reminder after a valid status line resets it", async () => {
    const { deps, requests } = harness([reply("none", 1), reply("COORDINER: NEXT Light", 2), reply("none again", 3), reply("COORDINER: DONE", 4)]);
    assert.deepEqual(await runStorySession(story, deps), { status: "done" });
    assert.equal(requests.length, 4);
  });

  it("stops on a failed turn and keeps the session id for take-over", async () => {
    const { deps, events } = harness([reply("COORDINER: NEXT Light", 1), { ok: false, sessionId: "sess-1", error: "the session ended with error_max_turns." }]);
    assert.deepEqual(await runStorySession(story, deps), { status: "failed", error: "the session ended with error_max_turns.", sessionId: "sess-1" });
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 1, status: "failed", detail: "the session ended with error_max_turns." });
  });

  it("reports a failed turn that has no session id", async () => {
    const { deps } = harness([{ ok: false, error: "the Claude Agent SDK raised: down" }]);
    assert.deepEqual(await runStorySession(story, deps), { status: "failed", error: "the Claude Agent SDK raised: down" });
  });

  it("marks the step stopped when the abort arrives during a turn", async () => {
    const stop = new AbortController();
    const { deps, events } = harness([() => (stop.abort(), { ok: false, error: "aborted" })], stop.signal);
    assert.deepEqual(await runStorySession(story, deps), { status: "stopped" });
    assert.deepEqual(events.at(-1), { type: "step-finished", index: 0, status: "stopped", detail: "stopped" });
  });

  it("starts no turn when already aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    const { deps, requests } = harness([], stop.signal);
    assert.deepEqual(await runStorySession(story, deps), { status: "stopped" });
    assert.equal(requests.length, 0);
  });

  it("stops between turns when the abort arrives after a successful one", async () => {
    const stop = new AbortController();
    const { deps, requests } = harness([() => (stop.abort(), reply("COORDINER: NEXT Light", 1))], stop.signal);
    assert.deepEqual(await runStorySession(story, deps), { status: "stopped" });
    assert.equal(requests.length, 1);
  });

  it("fails at the turn cap instead of looping forever", async () => {
    const { deps, requests } = harness(Array.from({ length: MAX_TURNS + 5 }, (_, n) => reply("COORDINER: NEXT Light", n)));
    const outcome = await runStorySession(story, deps);
    assert.equal(outcome.status, "failed");
    assert.equal(requests.length, MAX_TURNS);
  });

  it("refuses a story over the size cap before any turn", async () => {
    const { deps, requests } = harness([]);
    const outcome = await runStorySession({ heading: "Story 1", body: "x".repeat(MAX_STORY_CHARS + 1) }, deps);
    assert.equal(outcome.status, "refused");
    assert.equal(requests.length, 0);
  });
});
