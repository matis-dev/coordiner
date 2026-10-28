import { isEffort, MODEL } from "./chains.ts";
import type { Tier } from "./environment.ts";
import type { JournaledEntry, LastTurn } from "./journal.ts";
import type { Outcome, StepStatus } from "./run.ts";
import { clip, plain } from "./text.ts";
import { endEntry, Transcript, type Entry } from "./transcript.ts";
import type { Ending } from "./editor-protocol.ts";
import type { DecidedAfter, QuestionWait } from "./unattended.ts";
import type { StepView } from "./view.ts";
import { SESSION_ID } from "./worktree.ts";

// A run read back from its journal, for the Sessions list and for reopening its chat.
export type PastRun = {
  file: string;
  chain: string;
  story: string;
  repo: string;
  worktree: string;
  branch: string;
  questions: QuestionWait;
  // When the journal's last record was written.
  lastAt: string;
  steps: StepView[];
  entries: Entry[];
  // None when VS Code closed while the run went on.
  outcome?: Outcome;
  // How the run ended, for the reopened chat's status line.
  ending: Ending;
  // None when no turn left a session to talk to; the chat then opens read-only.
  last?: LastTurn;
  // A journal from before what the sessions said was recorded: the transcript holds the user's side only.
  userOnly: boolean;
};

// Journals past this are not read; a full transcript stays far below it.
export const MAX_JOURNAL_BYTES = 5_000_000;
export const MAX_LISTED = 50;
export const CLOSED_MID_RUN = "VS Code closed while it ran";

const TIERS: readonly Tier[] = ["strong", "medium", "weak"];
const WAITS: readonly QuestionWait[] = ["timed", "always", "never"];
const AFTERS: readonly DecidedAfter[] = ["at once", "after 5 minutes"];
const STEP_STATUSES: readonly StepStatus[] = ["done", "failed", "halted", "stopped"];
const MAX_TEXT = 100_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length <= max;
const index = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const one = <T>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
const effortOf = (v: Record<string, unknown>) => (isEffort(v.effort) ? { effort: v.effort } : {});

// The journal is read back field by field: a line that is not JSON, a record of an unknown type and a field of the wrong shape
// are dropped. Text is made plain again, since anyone who can write the file can write anything into it.
export function parseJournal(text: string, file: string): PastRun | undefined {
  const records = text.split("\n").flatMap((line): Record<string, unknown>[] => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
  const start = records[0];
  if (!start || start.type !== "run-started") return undefined;
  const { chain, story, repo, worktree, branch, questions } = start;
  if (!str(chain, 1000) || !str(story, 1000) || !str(repo, 4096) || !str(worktree, 4096) || !str(branch, 1000) || !one(WAITS, questions)) return undefined;

  const steps: StepView[] = [];
  const transcript = new Transcript();
  let outcome: Outcome | undefined;
  let last: LastTurn | undefined;
  let lastStep: LastTurn | undefined;
  let userOnly = true;
  let lastAt = str(start.at, 100) ? start.at : "";
  for (const r of records.slice(1)) {
    if (str(r.at, 100)) lastAt = r.at;
    switch (r.type) {
      case "step-started":
        if (r.index === steps.length && str(r.label, 1000) && one(TIERS, r.tier) && str(r.model) && MODEL.test(r.model)) {
          steps.push({ label: plain(r.label), tier: r.tier, model: r.model, ...effortOf(r), status: "running" });
        }
        break;
      case "step-finished": {
        const step = index(r.index) ? steps[r.index] : undefined;
        if (!step || !one(STEP_STATUSES, r.status) || !str(r.detail)) break;
        steps[r.index as number] = { ...step, status: r.status, detail: plain(r.detail) };
        if (str(r.sessionId) && SESSION_ID.test(r.sessionId)) lastStep = { sessionId: r.sessionId, model: step.model, ...(step.effort ? { effort: step.effort } : {}), card: step.label, reply: "" };
        break;
      }
      case "you":
        if (str(r.card, 1000) && str(r.text)) transcript.add([{ kind: "you", card: plain(r.card), text: plain(r.text) }]);
        break;
      case "answer":
        if (str(r.card, 1000) && str(r.question) && str(r.answer)) transcript.add([{ kind: "answer", card: plain(r.card), question: plain(r.question), answer: plain(r.answer) }]);
        break;
      case "decided":
        if (str(r.card, 1000) && str(r.question) && str(r.answer) && one(AFTERS, r.after)) {
          transcript.add([{ kind: "decided", card: plain(r.card), question: plain(r.question), answer: plain(r.answer), after: r.after }]);
        }
        break;
      case "entry": {
        userOnly = false;
        const entry = entryOf(r.entry);
        if (entry) transcript.add([entry]);
        break;
      }
      case "turn":
        userOnly = false;
        if (str(r.sessionId) && SESSION_ID.test(r.sessionId) && str(r.model) && MODEL.test(r.model) && str(r.card, 1000) && str(r.reply, MAX_JOURNAL_BYTES)) {
          last = { sessionId: r.sessionId, model: r.model, ...effortOf(r), card: plain(r.card), reply: r.reply };
        }
        break;
      case "outcome": {
        const parsed = outcomeOf(r.outcome);
        if (parsed && !outcome) {
          outcome = parsed;
          transcript.add([endEntry(parsed)]);
        }
        break;
      }
    }
  }
  // A step still running when the journal ends did not finish; it is not running now.
  const settled = steps.map((s): StepView => (s.status === "running" ? { ...s, status: "stopped", detail: CLOSED_MID_RUN } : s));
  const { kind: _end, ...ending } = outcome ? endEntry(outcome) : ({ kind: "end", status: "stopped", reason: CLOSED_MID_RUN } as const);
  if (!outcome) transcript.add([{ kind: "end", ...ending }]);
  const turn = last ?? lastStep;
  return {
    file,
    chain: plain(chain),
    story: plain(story),
    repo,
    worktree,
    branch: plain(branch),
    questions,
    lastAt,
    steps: settled,
    entries: transcript.entries(),
    ...(outcome ? { outcome } : {}),
    ending,
    ...(turn ? { last: turn } : {}),
    userOnly,
  };
}

function entryOf(v: unknown): JournaledEntry | undefined {
  if (!isRecord(v)) return undefined;
  switch (v.kind) {
    case "assistant":
      return str(v.card, 1000) && str(v.text) ? { kind: "assistant", card: plain(v.card), text: plain(v.text) } : undefined;
    case "tool":
      return str(v.card, 1000) && str(v.name, 1000) && str(v.input) ? { kind: "tool", card: plain(v.card), name: plain(v.name), input: clip(plain(v.input), 300) } : undefined;
    case "divider":
      return Number.isInteger(v.session) && (v.session as number) > 0 ? { kind: "divider", session: v.session as number } : undefined;
    case "failed":
      return str(v.card, 1000) && str(v.error) ? { kind: "failed", card: plain(v.card), error: plain(v.error) } : undefined;
    default:
      return undefined;
  }
}

// Only the fields the transcript and the list read; a session id or a stop position is not needed to show how a run ended.
function outcomeOf(v: unknown): Outcome | undefined {
  if (!isRecord(v)) return undefined;
  switch (v.status) {
    case "done":
      return str(v.text) ? { status: "done", text: plain(v.text) } : undefined;
    case "no-changes":
    case "stopped":
      return { status: v.status };
    case "halted":
    case "refused":
      return str(v.reason) ? { status: v.status, reason: plain(v.reason) } : undefined;
    case "failed":
      return str(v.error) ? { status: "failed", error: plain(v.error) } : undefined;
    default:
      return undefined;
  }
}

// Reads journals newest file first and stops once the open repo's newest MAX_LISTED are in hand, so a journal directory that is
// never pruned is not read back whole on every refresh. A file's time stands in for its last record's; `listed` orders by the latter.
export async function readNewest(files: readonly { name: string; mtimeMs: number }[], read: (name: string) => Promise<PastRun | undefined>, repoRoot: string, openFile?: string): Promise<PastRun[]> {
  const found: PastRun[] = [];
  for (const { name } of [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (found.length >= MAX_LISTED) break;
    const run = await read(name);
    if (run && run.repo === repoRoot && run.file !== openFile) found.push(run);
  }
  return listed(found, repoRoot, openFile);
}

// The runs of the open folder's repo, newest first, without the one whose chat is open now.
export const listed =(runs: readonly PastRun[], repoRoot: string, openFile?: string): PastRun[] =>
  runs
    .filter((r) => r.repo === repoRoot && r.file !== openFile)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, MAX_LISTED);
