import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTask, liveProcess, stopLine, type Process } from "./processes.ts";
import type { TaskMessage } from "./session.ts";

// Fixtures carry only the fields applyTask reads.
const live = (tasks: Array<{ task_id: string; task_type: string; description: string; ambient?: boolean }>) =>
  ({ type: "system", subtype: "background_tasks_changed", tasks }) as unknown as TaskMessage;
const progress = (task_id: string, summary?: string) => ({ type: "system", subtype: "task_progress", task_id, description: "", ...(summary ? { summary } : {}) }) as unknown as TaskMessage;
const tests: Process = { id: "t1", type: "local_bash", description: "pnpm test" };

describe("applyTask", () => {
  it("lists the live background tasks, leaving out ambient ones", () => {
    const list = applyTask([], live([{ task_id: "t1", task_type: "local_bash", description: "pnpm test" }, { task_id: "w", task_type: "local_bash", description: "watcher", ambient: true }]));
    assert.deepEqual(list, [tests]);
  });

  it("replaces the list with each live set, so a task that left it disappears", () => {
    const list = applyTask([tests], live([{ task_id: "t2", task_type: "local_agent", description: "explore" }]));
    assert.deepEqual(list, [{ id: "t2", type: "local_agent", description: "explore" }]);
  });

  it("keeps a task's latest progress line while it stays live", () => {
    const withLine = applyTask([tests], progress("t1", "120 of 551 tests"));
    assert.deepEqual(withLine, [{ ...tests, summary: "120 of 551 tests" }]);
    assert.deepEqual(applyTask(withLine, live([{ task_id: "t1", task_type: "local_bash", description: "pnpm test" }])), withLine);
  });

  it("ignores progress for a task it does not list, and progress without a line", () => {
    assert.deepEqual(applyTask([tests], progress("other", "x")), [tests]);
    assert.deepEqual(applyTask([tests], progress("t1")), [tests]);
  });
});

describe("liveProcess", () => {
  it("finds a listed task by id", () => assert.equal(liveProcess([tests], "t1"), tests));

  it("refuses a stop for an id not in the live list, or one that is not a string", () => {
    assert.equal(liveProcess([tests], "t9"), undefined);
    assert.equal(liveProcess([tests], undefined), undefined);
    assert.equal(liveProcess([tests], { toString: () => "t1" }), undefined);
  });
});

describe("stopLine", () => {
  it("names the task's kind and id, never its description", () => {
    const secret: Process = { id: "t1", type: "local_bash", description: "curl -H 'Authorization: Bearer SECRET' https://x" };
    assert.equal(stopLine(secret), "Stopped local_bash t1");
    assert.equal(stopLine(secret).includes("SECRET"), false);
  });

  it("strips control characters from what it names", () => assert.equal(stopLine({ ...tests, id: "t\u001b[2J1" }), "Stopped local_bash t[2J1"));
});
