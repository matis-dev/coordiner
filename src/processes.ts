import type { TaskMessage } from "./session.ts";
import { plain } from "./text.ts";

// A background task of the turn that is running: a shell command, a Monitor, a subagent.
export type Process = { id: string; type: string; description: string; summary?: string };

// `background_tasks_changed` carries the whole live set and replaces the list, so a missed message never leaves a stale row;
// tasks marked ambient are not activity and are left out. `task_progress` updates the line of a task already listed.
export function applyTask(list: readonly Process[], message: TaskMessage): Process[] {
  if (message.subtype === "task_progress") {
    const { task_id: id, summary } = message;
    return list.map((p) => (p.id === id && summary ? { ...p, summary } : p));
  }
  return message.tasks
    .filter((t) => !t.ambient)
    .map((t) => {
      const summary = list.find((p) => p.id === t.task_id)?.summary;
      return { id: t.task_id, type: t.task_type, description: t.description, ...(summary ? { summary } : {}) };
    });
}

// The Stop button's argument comes back from the tree; only a task still in the live list is acted on.
export const liveProcess = (list: readonly Process[], id: unknown): Process | undefined => (typeof id === "string" ? list.find((p) => p.id === id) : undefined);

// For the output and the journal: the task's kind and id, never its description, which can hold a whole command line.
export const stopLine = (process: Process): string => `Stopped ${plain(process.type)} ${plain(process.id)}`;
