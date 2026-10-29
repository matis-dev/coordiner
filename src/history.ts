import { cardPrompt, isEffort, MAX_INPUT_CHARS, MODEL, parseChainShape, type Chain } from "./chains.ts";
import type { Tier } from "./environment.ts";
import type { JournaledEntry, LastTurn } from "./journal.ts";
import { continueAfter, fillInput, pickUpAfter, restateAfter, type At, type Outcome, type StartPoint, type StepStatus } from "./run.ts";
import { clip, plain } from "./text.ts";
import { endEntry, MAX_TOOL_INPUT, Transcript, type Entry } from "./transcript.ts";
import type { Ending } from "./editor-protocol.ts";
import type { DecidedAfter, QuestionWait } from "./unattended.ts";
import type { StepView } from "./view.ts";
import { SESSION_ID, type Listed } from "./worktree.ts";

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
  // The chain as picked and its input; none in a journal from before runs could be continued.
  definition?: Chain;
  input?: string;
  // Where Continue picks up: the card a halted or failed run stopped at, else the card the run last started. With the tier it
  // ran on (none when it never started), whether a turn of it reached a session, whether it had given its reply, and the latest
  // session of its chain session.
  lastCard?: { at: At; tier?: Tier; reached: boolean; finished: boolean; resume?: string };
};

// A run that can be continued: the filled chain, where it picks up, and the card and reason the confirm names.
export type Continuation = { chain: Chain; from: StartPoint; card: string; reason: string };

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
  const { chain, story, repo, worktree, branch, questions: firstWait } = start;
  if (!str(chain, 1000) || !str(story, 1000) || !str(repo, 4096) || !str(worktree, 4096) || !str(branch, 1000) || !one(WAITS, firstWait)) return undefined;
  // A continued run may have chosen differently.
  let questions: QuestionWait = firstWait;

  const shape = parseChainShape(start.definition);
  const definition = typeof shape === "string" || !str(start.input, MAX_INPUT_CHARS) ? undefined : shape;
  const input = definition ? (start.input as string) : undefined;
  const inChain = (v: unknown): v is At =>
    isRecord(v) && index(v.session) && index(v.card) && definition?.sessions[v.session as number]?.cards[v.card as number] !== undefined;

  const steps: StepView[] = [];
  // Each step's card, kept only while the chain is known.
  const cards: (At | undefined)[] = [];
  // The latest session id of each chain session, and the cards a turn of which reached a session.
  const sessionOf = new Map<number, string>();
  const reached = new Set<string>();
  const key = (at: At) => `${at.session}:${at.card}`;
  const transcript = new Transcript();
  let outcome: Outcome | undefined;
  // The card a halted or failed outcome names; a halt before a session's first card leaves no step for it.
  let stoppedAt: At | undefined;
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
          cards.push(inChain(r.position) ? { session: r.position.session, card: r.position.card } : undefined);
        }
        break;
      case "step-finished": {
        const step = index(r.index) ? steps[r.index] : undefined;
        if (!step || !one(STEP_STATUSES, r.status) || !str(r.detail)) break;
        steps[r.index as number] = { ...step, status: r.status, detail: plain(r.detail) };
        if (str(r.sessionId) && SESSION_ID.test(r.sessionId)) {
          lastStep = { sessionId: r.sessionId, model: step.model, ...(step.effort ? { effort: step.effort } : {}), card: step.label, reply: "" };
          const at = cards[r.index as number];
          if (at) {
            sessionOf.set(at.session, r.sessionId);
            reached.add(key(at));
          }
        }
        break;
      }
      case "continued":
        // The run went on after its outcome: a later outcome is how it ended.
        if (one(WAITS, r.questions)) {
          outcome = undefined;
          stoppedAt = undefined;
          questions = r.questions;
        }
        break;
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
          // outcomeOf took it, so it is an object.
          const { at } = r.outcome as { at?: unknown };
          stoppedAt = (parsed.status === "halted" || parsed.status === "failed") && inChain(at) ? { session: at.session, card: at.card } : undefined;
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
  const started = cards.at(-1);
  const at = stoppedAt ?? started;
  const isStarted = at !== undefined && started !== undefined && key(at) === key(started);
  const resume = at && sessionOf.get(at.session);
  const lastCard = at && {
    at,
    ...(isStarted ? { tier: steps.at(-1)!.tier } : {}),
    reached: reached.has(key(at)),
    finished: isStarted && steps.at(-1)!.status === "done",
    ...(resume ? { resume } : {}),
  };
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
    ...(definition ? { definition, input } : {}),
    ...(lastCard ? { lastCard } : {}),
  };
}

// Where a run that did not finish picks up: the card it stopped at, retried in the session it ran in. Nothing for a run that
// finished, was refused, or was journaled before runs could be continued.
export function continuePoint(run: PastRun): Continuation | undefined {
  const { definition, input, lastCard, outcome } = run;
  if (!definition || input === undefined || !lastCard) return undefined;
  if (outcome && outcome.status !== "halted" && outcome.status !== "failed" && outcome.status !== "stopped") return undefined;
  const filled = fillInput(definition, input);
  if (!filled.ok) return undefined;
  const card = filled.chain.sessions[lastCard.at.session]!.cards[lastCard.at.card]!;
  const reason = !outcome ? CLOSED_MID_RUN : outcome.status === "halted" ? outcome.reason : outcome.status === "failed" ? outcome.error : "the user stopped the run";
  // A card whose prompt never reached a session is sent it again; one that had given its reply is asked for its status line again;
  // any other is asked to carry on.
  const retry = outcome?.status === "halted" || outcome?.status === "failed" ? continueAfter(reason) : pickUpAfter(reason);
  const prompt = !lastCard.reached ? cardPrompt(card) : lastCard.finished ? restateAfter(reason) : retry;
  return { chain: filled.chain, from: { at: lastCard.at, ...(lastCard.tier ? { tier: lastCard.tier } : {}), ...(lastCard.resume ? { resume: lastCard.resume } : {}), prompt }, card: card.label, reason };
}

function entryOf(v: unknown): JournaledEntry | undefined {
  if (!isRecord(v)) return undefined;
  switch (v.kind) {
    case "assistant":
      return str(v.card, 1000) && str(v.text) ? { kind: "assistant", card: plain(v.card), text: plain(v.text) } : undefined;
    case "tool":
      return str(v.card, 1000) && str(v.name, 1000) && str(v.input) ? { kind: "tool", card: plain(v.card), name: plain(v.name), input: clip(plain(v.input), MAX_TOOL_INPUT) } : undefined;
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

// One line of work in the Sessions list: a worktree and its runs, newest first. "gone": its folder is not there; "unregistered": the
// folder is there but git no longer lists it as a worktree. Either way only its runs' journals can be removed, never a folder.
export type Line = { path: string; branch: string; slug: string; where: "here" | "gone" | "unregistered"; runs: PastRun[] };

// The worktrees git lists for the repo and those the listed runs name, each once. Lines with runs come first, by their latest run;
// a worktree with no run left in the list follows, by name. `runs` come newest first, as `listed` gives them.
export function byWorktree(runs: readonly PastRun[], worktrees: readonly Listed[], present: (path: string) => boolean): Line[] {
  const lines = new Map<string, Line>();
  const line = (path: string, branch: string, isListed: boolean): Line => {
    const where = present(path) ? (isListed ? "here" : "unregistered") : "gone";
    return { path, branch, slug: path.split(/[\\/]/).at(-1) || path, where, runs: [] };
  };
  for (const w of worktrees) lines.set(w.path, line(w.path, w.branch, true));
  for (const run of runs) {
    if (!lines.has(run.worktree)) lines.set(run.worktree, line(run.worktree, run.branch, false));
    lines.get(run.worktree)!.runs.push(run);
  }
  return [...lines.values()].sort((a, b) => {
    const [x, y] = [a.runs[0]?.lastAt, b.runs[0]?.lastAt];
    if (x !== undefined && y !== undefined) return y.localeCompare(x);
    if (x !== undefined || y !== undefined) return x === undefined ? 1 : -1;
    return a.slug.localeCompare(b.slug);
  });
}

// The journals of the runs in a worktree, by the worktree their first record names: what Remove deletes along with it. A journal
// whose first record cannot be read is kept.
export function journalsOf(journals: readonly { name: string; text: string }[], path: string): string[] {
  return journals.filter(({ text }) => {
    try {
      const first: unknown = JSON.parse(text.split("\n", 1)[0]!);
      return isRecord(first) && first.type === "run-started" && first.worktree === path;
    } catch {
      return false;
    }
  }).map(({ name }) => name);
}
