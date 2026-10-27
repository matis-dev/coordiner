import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { interactiveCanUseTool, QUESTION_WAIT_MS, sleep, unattendedCanUseTool, type Ask, type DecidedAfter, type QuestionWait, type WaitDeps } from "./unattended.ts";

const opts = (...labels: string[]) => labels.map((label) => ({ label }));
const logger = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
};
const answersOf = (result: PermissionResult | null) => (result?.behavior === "allow" ? (result.updatedInput as { answers: Record<string, string> }).answers : undefined);

// A run's question deps: `asked` holds each question sent to the chat, `timers` each wait started; tests settle them by hand.
function waiting(wait: QuestionWait) {
  const { lines, log } = logger();
  const decisions: Array<[string, string, DecidedAfter]> = [];
  const asked: Array<{ signal: AbortSignal; expiresAt?: number; answer(answers: Record<string, string>): void }> = [];
  const timers: Array<{ ms: number; signal: AbortSignal; run(): void }> = [];
  const deps: WaitDeps = {
    wait,
    ask: (_questions, signal, expiresAt) =>
      new Promise((resolve, reject) => {
        asked.push({ signal, ...(expiresAt !== undefined ? { expiresAt } : {}), answer: resolve });
        signal.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true });
      }),
    sleep: (ms, signal) => new Promise((resolve) => void timers.push({ ms, signal, run: () => resolve() })),
    now: () => 1_000,
    log,
    decided: (question, answer, after) => void decisions.push([question, answer, after]),
  };
  return { deps, lines, decisions, asked, timers, canUse: unattendedCanUseTool(deps) };
}
const toolOptions = (signal = new AbortController().signal) => ({ signal }) as Parameters<CanUseTool>[2];
const settle = () => new Promise((resolve) => setImmediate(resolve));
const recommended = { questions: [{ question: "Q?", options: opts("A (Recommended)", "B") }] };
const unsafe = { questions: [{ question: "Install docker?", options: opts("Yes", "No") }] };

describe("unattendedCanUseTool", () => {
  it("takes the Recommended option at once when the run never waits, and records it", async () => {
    const { canUse, decisions, asked } = waiting("never");
    assert.deepEqual(answersOf(await canUse("AskUserQuestion", recommended, toolOptions())), { "Q?": "A (Recommended)" });
    assert.deepEqual(decisions, [["Q?", "A (Recommended)", "at once"]]);
    assert.equal(asked.length, 0);
  });

  it("waits for the user on a question with no Recommended option, even when the run never waits", async () => {
    const { canUse, decisions, asked, timers } = waiting("never");
    const result = canUse("AskUserQuestion", unsafe, toolOptions());
    await settle();
    assert.deepEqual([asked.length, asked[0]!.expiresAt, timers.length], [1, undefined, 0]);
    asked[0]!.answer({ "Install docker?": "Yes" });
    assert.deepEqual(answersOf(await result), { "Install docker?": "Yes" });
    assert.deepEqual(decisions, []);
  });

  it("uses the user's answer when it comes within the wait, and stops the timer", async () => {
    const { canUse, decisions, asked, timers } = waiting("timed");
    const result = canUse("AskUserQuestion", recommended, toolOptions());
    await settle();
    assert.equal(asked[0]!.expiresAt, 1_000 + QUESTION_WAIT_MS);
    assert.equal(timers[0]!.ms, QUESTION_WAIT_MS);
    asked[0]!.answer({ "Q?": "B" });
    assert.deepEqual(answersOf(await result), { "Q?": "B" });
    assert.equal(timers[0]!.signal.aborted, true);
    assert.deepEqual(decisions, []);
  });

  it("withdraws the question and takes the Recommended option when the wait runs out", async () => {
    const { canUse, decisions, asked, timers, lines } = waiting("timed");
    const result = canUse("AskUserQuestion", recommended, toolOptions());
    await settle();
    timers[0]!.run();
    assert.deepEqual(answersOf(await result), { "Q?": "A (Recommended)" });
    assert.equal(asked[0]!.signal.aborted, true);
    assert.deepEqual(decisions, [["Q?", "A (Recommended)", "after 5 minutes"]]);
    assert.deepEqual(lines, ["question: Q? → A (Recommended)"]);
  });

  it("never answers a call without the user when one of its questions has no Recommended option, timer or not", async () => {
    const { canUse, decisions, asked, timers } = waiting("timed");
    const result = canUse("AskUserQuestion", { questions: [...recommended.questions, ...unsafe.questions] }, toolOptions());
    await settle();
    assert.deepEqual([asked.length, asked[0]!.expiresAt, timers.length], [1, undefined, 0]);
    asked[0]!.answer({ "Q?": "B", "Install docker?": "No" });
    assert.deepEqual(answersOf(await result), { "Q?": "B", "Install docker?": "No" });
    assert.deepEqual(decisions, []);
  });

  it("waits for the user with no timer when the run always waits", async () => {
    const { canUse, asked, timers } = waiting("always");
    const result = canUse("AskUserQuestion", recommended, toolOptions());
    await settle();
    assert.deepEqual([asked[0]!.expiresAt, timers.length], [undefined, 0]);
    asked[0]!.answer({ "Q?": "B" });
    assert.deepEqual(answersOf(await result), { "Q?": "B" });
  });

  it("denies, and records nothing, when the run stops while the question waits", async () => {
    const stop = new AbortController();
    const { canUse, decisions, timers } = waiting("timed");
    const result = canUse("AskUserQuestion", recommended, toolOptions(stop.signal));
    await settle();
    stop.abort();
    assert.deepEqual(await result, { behavior: "deny", message: "The run was stopped before the user answered." });
    assert.equal(timers[0]!.signal.aborted, true);
    assert.deepEqual(decisions, []);
  });

  it("denies, and records nothing, when the wait runs out as the run stops", async () => {
    const stop = new AbortController();
    const { deps } = waiting("timed");
    const canUse = unattendedCanUseTool({
      ...deps,
      ask: () => (stop.abort(), new Promise<Record<string, string>>(() => undefined)),
      sleep: async () => undefined,
      decided: () => assert.fail("nothing is decided"),
    });
    assert.deepEqual(await canUse("AskUserQuestion", recommended, toolOptions(stop.signal)), { behavior: "deny", message: "The run was stopped before the user answered." });
  });

  it("takes every recommended option of a multi-select, and only the first of a single select", async () => {
    const { canUse } = waiting("never");
    const multi = { questions: [{ question: "M?", multiSelect: true, options: opts("A (Recommended)", "B", "C (recommended)") }] };
    assert.deepEqual(answersOf(await canUse("AskUserQuestion", multi, toolOptions())), { "M?": "A (Recommended), C (recommended)" });
    const single = { questions: [{ question: "S?", options: opts("A (Recommended)", "C (Recommended)") }] };
    assert.deepEqual(answersOf(await canUse("AskUserQuestion", single, toolOptions())), { "S?": "A (Recommended)" });
  });

  it("answers several questions and keeps the original input fields", async () => {
    const { canUse } = waiting("never");
    const input = { extra: 1, questions: [{ question: "One?", options: opts("x (Recommended)") }, { question: "Two?", options: opts("y (Recommended)", "z") }] };
    const result = await canUse("AskUserQuestion", input, toolOptions());
    assert.deepEqual(answersOf(result), { "One?": "x (Recommended)", "Two?": "y (Recommended)" });
    assert.equal(result?.behavior === "allow" && result.updatedInput?.extra, 1);
  });

  it("strips control characters from what it logs", async () => {
    const { canUse, lines } = waiting("never");
    const esc = String.fromCharCode(0x1b);
    await canUse("AskUserQuestion", { questions: [{ question: `Q${esc}[2J?`, options: opts("A (Recommended)") }] }, toolOptions());
    assert.deepEqual(lines, ["question: Q[2J? → A (Recommended)"]);
  });

  it("denies a question it cannot read, without asking or deciding", async () => {
    const { canUse, asked, decisions } = waiting("never");
    for (const input of [
      {},
      { questions: "no" },
      { questions: [{ question: "Q?", options: [] }] },
      { questions: [{ question: 1, options: opts("a") }] },
      { questions: [null] },
      { questions: [{ question: "Q?", options: [{ nolabel: 1 }] }] },
      { questions: [{ question: "Q?", header: 7, options: opts("a") }] },
      { questions: [{ question: "Q?", multiSelect: "yes", options: opts("a") }] },
    ]) {
      assert.equal((await canUse("AskUserQuestion", input, toolOptions()))?.behavior, "deny");
    }
    assert.deepEqual([asked.length, decisions.length], [0, 0]);
  });

  it("denies every other tool and logs its name and input keys", async () => {
    const { canUse, lines } = waiting("never");
    const result = await canUse("Bash", { command: "ls", description: "List" }, toolOptions());
    assert.equal(result?.behavior, "deny");
    assert.deepEqual(lines, ["denied tool: Bash (command, description)"]);
  });

  it("never logs the values of a denied tool's input, where a credential can sit", async () => {
    const { canUse, lines } = waiting("never");
    await canUse("Write", { file_path: "/home/u/.netrc", content: "password hunter2-not-real" }, toolOptions());
    assert.doesNotMatch(lines.join("\n"), /netrc|hunter2/);
  });

  it("logs a denied tool's input keys clipped and without control characters", async () => {
    const { canUse, lines } = waiting("never");
    await canUse("Odd\u001b[2J", { [`k\u0007${"y".repeat(400)}`]: 1 }, toolOptions());
    assert.doesNotMatch(lines[0]!, /[\u0007\u001b]/);
    assert.equal(lines[0]!.length < 340, true);
  });
});

describe("sleep", () => {
  it("settles after the time given, and never once its signal aborts", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let done = 0;
    void sleep(QUESTION_WAIT_MS, new AbortController().signal).then(() => done++);
    const stop = new AbortController();
    void sleep(QUESTION_WAIT_MS, stop.signal).then(() => done++);
    stop.abort();
    t.mock.timers.tick(QUESTION_WAIT_MS - 1);
    await Promise.resolve();
    assert.equal(done, 0);
    t.mock.timers.tick(1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(done, 1);
  });
});

describe("interactiveCanUseTool", () => {
  const signal = new AbortController().signal;
  const options = { signal } as Parameters<ReturnType<typeof interactiveCanUseTool>>[2];
  const question = { question: "Which?", header: "Pick", multiSelect: false, options: opts("A", "B (Recommended)") };

  it("asks the user and passes their answers back with the original input", async () => {
    const { lines, log } = logger();
    let asked: unknown;
    const ask: Ask = async (questions, s) => {
      asked = [questions, s];
      return { "Which?": "A" };
    };
    const result = await interactiveCanUseTool(ask, log)("AskUserQuestion", { extra: 1, questions: [question] }, options);
    assert.deepEqual(asked, [[question], signal]);
    assert.deepEqual(answersOf(result), { "Which?": "A" });
    assert.equal(result?.behavior === "allow" && result.updatedInput?.extra, 1);
    assert.deepEqual(lines, []);
  });

  it("denies when the run stops before the user answers", async () => {
    const { log } = logger();
    const result = await interactiveCanUseTool(async () => Promise.reject(new Error("stopped")), log)("AskUserQuestion", { questions: [question] }, options);
    assert.deepEqual(result, { behavior: "deny", message: "The run was stopped before the user answered." });
  });

  it("denies questions it cannot read without asking the user", async () => {
    const { log } = logger();
    const ask: Ask = async () => assert.fail("must not ask");
    for (const input of [{}, { questions: [{ question: "Q?", options: [] }] }]) {
      assert.equal((await interactiveCanUseTool(ask, log)("AskUserQuestion", input, options))?.behavior, "deny");
    }
  });

  it("denies every other tool and logs it, as an unattended turn does", async () => {
    const { lines, log } = logger();
    const result = await interactiveCanUseTool(async () => assert.fail("must not ask"), log)("Bash", { command: "rm -rf build" }, options);
    assert.equal(result?.behavior, "deny");
    assert.deepEqual(lines, ["denied tool: Bash (command)"]);
  });
});
