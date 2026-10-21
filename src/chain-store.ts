import { dirname } from "node:path";
import { parseChains, serializeChains, type Chain } from "./chains.ts";

// The user's chains on disk. The filesystem is passed in, so the rules that keep the file whole are tested without one.
export type StoreFs = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
};

export class ChainStore {
  chains: readonly Chain[] = [];
  // How many changes could not be saved, refused or failed: the editor says each one aloud, even when the reason repeats.
  unsaved = 0;
  private readonly file: string;
  private readonly fs: StoreFs;
  private readonly now: () => Date;
  private readonly saved: () => void;
  // Why the stored file was set aside; it stays shown, since it says where the old file went.
  private asideProblem?: string;
  // Why the last change was not saved; the next save that lands clears it.
  private saveProblem?: string;
  // Set when the stored file could neither be read nor moved aside; saving then would overwrite it.
  private blocked = false;
  private loading?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  // `saved` is told after every save, made or not, once the chains are what the file holds.
  constructor(file: string, fs: StoreFs, now: () => Date, saved: () => void) {
    this.file = file;
    this.fs = fs;
    this.now = now;
    this.saved = saved;
  }

  get error(): string | undefined {
    return [this.asideProblem, this.saveProblem].filter(Boolean).join(" ") || undefined;
  }

  // True while saves are queued: a state sent now would roll the editor back past them.
  get saving(): boolean {
    return this.pending > 0;
  }

  // Reads the file once; a missing file is no chains yet. A second call waits for that read, so it never sees the chains before it.
  load(): Promise<void> {
    return (this.loading ??= this.read());
  }

  private async read(): Promise<void> {
    let text: string;
    try {
      text = await this.fs.readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await this.setAside(`it could not be read (${(error as Error).message})`);
      return;
    }
    const parsed = parseChains(text);
    if (parsed.error) await this.setAside(parsed.error);
    else this.chains = parsed.chains;
  }

  // Saves run one at a time, each edit applied to what the save before it left, and the file lands by rename, so neither a burst
  // of edits nor a crash mid-write leaves it torn.
  save(edit: (chains: readonly Chain[]) => Chain[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.blocked) return;
      const temp = `${this.file}.tmp`;
      // The edit is inside the try too: a throw anywhere here must not leave the queue stuck and the editor waiting on it.
      try {
        const chains = edit(this.chains);
        await this.fs.mkdir(dirname(this.file));
        await this.fs.writeFile(temp, serializeChains(chains));
        await this.fs.rename(temp, this.file);
        this.chains = chains;
        this.saveProblem = undefined;
      } catch (error) {
        this.saveProblem = `Changes could not be saved: ${(error as Error).message}`;
        this.unsaved++;
      }
    });
  }

  // An edit the editor already shows but that did not pass the checks: nothing is written, and the editor is told, after any saves
  // still queued, so it goes back to the chains as saved.
  refuse(): Promise<void> {
    return this.enqueue(() => {
      this.saveProblem = "A change was not saved: it went past what a chain can hold. The editor shows your chains as last saved.";
      this.unsaved++;
    });
  }

  private enqueue(step: () => Promise<void> | void): Promise<void> {
    this.pending++;
    this.queue = this.queue.then(async () => {
      await step();
      this.pending--;
      this.saved();
    });
    return this.queue;
  }

  // A bad file is moved aside, never overwritten; if it cannot be moved, saving stays off.
  private async setAside(problem: string): Promise<void> {
    const backup = `${this.file}.bak-${this.now().toISOString().replace(/[-:.]/g, "")}`;
    try {
      await this.fs.rename(this.file, backup);
      this.asideProblem = `The saved chains were set aside because ${problem}. The file is kept at ${backup}.`;
    } catch (error) {
      this.blocked = true;
      this.asideProblem = `The saved chains could not be used because ${problem}, and the file could not be set aside (${(error as Error).message}). Changes are not saved until it is fixed: ${this.file}`;
    }
  }
}
