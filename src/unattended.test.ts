import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { answerUnattended, interactiveCanUseTool, unattendedCanUseTool, type Ask } from "./unattended.ts";

const opts = (...labels: string[]) => labels.map((label) => ({ label }));
const logger = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
};
const answersOf = (result: PermissionResult | null) => (result?.behavior === "allow" ? (result.updatedInput as { answers: Record<string, string> }).answers : undefined);

describe("answerUnattended", () => {
  it("takes the option marked (Recommended)", () => {
    const { lines, log } = logger();
    const result = answerUnattended({ questions: [{ question: "Which?", options: opts("A", "B (Recommended)") }] }, log);
    assert.deepEqual(answersOf(result), { "Which?": "B (Recommended)" });
    assert.deepEqual(lines, ["question: Which? → B (Recommended)"]);
  });

  it("takes the first option and says so when none is recommended", () => {
    const { lines, log } = logger();
    const result = answerUnattended({ questions: [{ question: "Which?", options: opts("A", "B") }] }, log);
    assert.deepEqual(answersOf(result), { "Which?": "A" });
    assert.match(lines[0]!, /no Recommended option; took the first/);
  });

  it("takes every recommended option of a multi-select, and only the first of a single select", () => {
    const { log } = logger();
    const multi = answerUnattended({ questions: [{ question: "M?", multiSelect: true, options: opts("A (Recommended)", "B", "C (recommended)") }] }, log);
    assert.deepEqual(answersOf(multi), { "M?": "A (Recommended), C (recommended)" });
    const single = answerUnattended({ questions: [{ question: "S?", options: opts("A (Recommended)", "C (Recommended)") }] }, log);
    assert.deepEqual(answersOf(single), { "S?": "A (Recommended)" });
  });

  it("answers several questions and keeps the original input fields", () => {
    const { log } = logger();
    const result = answerUnattended({ extra: 1, questions: [{ question: "One?", options: opts("x (Recommended)") }, { question: "Two?", options: opts("y") }] }, log);
    assert.deepEqual(answersOf(result), { "One?": "x (Recommended)", "Two?": "y" });
    assert.equal(result.behavior === "allow" && result.updatedInput?.extra, 1);
  });

  it("denies malformed input", () => {
    const { log } = logger();
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
      assert.equal(answerUnattended(input, log).behavior, "deny");
    }
  });

  it("strips control characters from what it logs", () => {
    const { lines, log } = logger();
    answerUnattended({ questions: [{ question: "Q\u001b[2J?", options: opts("A (Recommended)") }] }, log);
    assert.equal(lines[0], "question: Q[2J? → A (Recommended)");
  });
});

describe("unattendedCanUseTool", () => {
  const options = {} as Parameters<ReturnType<typeof unattendedCanUseTool>>[2];

  it("routes AskUserQuestion to the unattended answer", async () => {
    const { log } = logger();
    const result = await unattendedCanUseTool(log)("AskUserQuestion", { questions: [{ question: "Q?", options: opts("A (Recommended)") }] }, options);
    assert.deepEqual(answersOf(result), { "Q?": "A (Recommended)" });
  });

  it("denies every other tool and logs the name and a clipped input", async () => {
    const { lines, log } = logger();
    const result = await unattendedCanUseTool(log)("Bash", { command: "x".repeat(500) }, options);
    assert.equal(result?.behavior, "deny");
    assert.match(lines[0]!, /^denied tool: Bash \{"command":"x+…$/);
    assert.equal(lines[0]!.length < 340, true);
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
    assert.equal(lines[0], 'denied tool: Bash {"command":"rm -rf build"}');
  });
});
