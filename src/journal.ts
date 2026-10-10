import type { Models } from "./environment.ts";
import type { Outcome, RunEvent } from "./run.ts";

export type JournalRecord =
  | { type: "run-started"; story: string; repo: string; worktree: string; branch: string; models: Models }
  | RunEvent
  | { type: "log"; line: string }
  | { type: "outcome"; outcome: Outcome };

// One JSON line per record, written in call order. A failed write is reported once and the run goes on: the journal is a record, not a control.
// The returned promise settles once this record and every earlier one are written; callers may ignore it.
export function createJournal(write: (line: string) => Promise<void>, now: () => Date, onError: (error: unknown) => void): (record: JournalRecord) => Promise<void> {
  let chain = Promise.resolve();
  let reported = false;
  return (record) => {
    const line = `${JSON.stringify({ at: now().toISOString(), ...record })}\n`;
    chain = chain.then(() => write(line)).catch((error: unknown) => {
      if (!reported) onError(error);
      reported = true;
    });
    return chain;
  };
}

export const journalFileName = (slug: string, date: Date): string => `${slug}-${date.toISOString().replace(/[-:]/g, "").slice(0, 15)}.jsonl`;
