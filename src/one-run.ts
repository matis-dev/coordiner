// One run at a time. The slot is taken before a run's first await and given back however the run ends (an early return, an
// error, the end of the run), so a second Run cannot start while the first is still asking for its input or installing.
export type OneRun = { busy(): boolean; run(task: () => Promise<void>): Promise<boolean> };

// `changed` is told each time the slot is taken or given back, so the chains editor can disable Run meanwhile.
export function oneRun(changed: () => void): OneRun {
  let busy = false;
  return {
    busy: () => busy,
    // False, without starting the task, when a run already holds the slot.
    async run(task) {
      if (busy) return false;
      busy = true;
      try {
        changed();
        await task();
      } finally {
        busy = false;
        changed();
      }
      return true;
    },
  };
}
