import { cardPrompt, singleSkill, type Chain, type Effort } from "./chains.ts";
import type { Tier } from "./environment.ts";
import type { Line, PastRun } from "./history.ts";
import type { Process } from "./processes.ts";
import type { Outcome, StepStatus } from "./run.ts";
import { clip, plain } from "./text.ts";
import type { WorktreeState } from "./worktree.ts";

// "waiting": the running card waits for the user, or asked them something; only the open session shows it.
export type StepView = { label: string; tier: Tier; model: string; effort?: Effort; status: "running" | "waiting" | StepStatus; detail?: string };
export type ItemView = { label: string; description: string; icon: string; accessibleLabel: string };

const ICON: Record<StepView["status"], string> = {
  running: "loading~spin",
  waiting: "bell-dot",
  done: "check",
  failed: "error",
  halted: "debug-stop",
  stopped: "circle-slash",
};

// The status is also spoken in words, so it never depends on the icon alone.
export function stepItem(step: StepView): ItemView {
  const label = plain(step.label);
  const detail = step.detail && step.detail !== step.status ? ` · ${clip(plain(step.detail), 120)}` : "";
  const effort = step.effort ? ` · ${step.effort}` : "";
  const waiting = step.status === "waiting" ? "waiting for you · " : "";
  return {
    label,
    description: `${waiting}${plain(step.tier)} · ${plain(step.model)}${effort}${detail}`,
    icon: ICON[step.status],
    accessibleLabel: `${label}, ${step.status === "waiting" ? "waiting for you" : step.status}, ${step.tier}, ${plain(step.model)}${step.effort ? `, effort ${step.effort}` : ""}`,
  };
}

// A process under the step that started it; the summary, when the task has one, is its latest progress line.
export function processItem(process: Process, step: string): ItemView {
  const label = clip(plain(process.description), 120) || plain(process.type);
  const summary = process.summary ? clip(plain(process.summary), 120) : "";
  return {
    label,
    description: summary || plain(process.type),
    icon: process.type === "local_bash" ? "terminal" : "pulse",
    accessibleLabel: `${label}, running, under ${plain(step)}${summary ? `, ${summary}` : ""}`,
  };
}

const ENDING: Record<Outcome["status"] | "closed", [words: string, icon: string]> = {
  done: ["done", "check"],
  "no-changes": ["nothing to review", "circle-large-outline"],
  halted: ["halted", "debug-stop"],
  failed: ["failed", "error"],
  stopped: ["stopped", "circle-slash"],
  refused: ["refused", "warning"],
  closed: ["closed mid-run", "history"],
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// How long ago a session was last active, in the words a list row has room for.
export function when(at: string, now: number): string {
  const then = new Date(at);
  const minutes = Math.floor((now - then.getTime()) / 60_000);
  if (Number.isNaN(minutes)) return "unknown time";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 48 * 60) return "yesterday";
  return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
}

// An earlier session in the Sessions list; how it ended is spoken in words, never by the icon alone.
export function sessionItem(past: PastRun, now: number): ItemView {
  const label = `${past.chain} · ${past.story}`;
  const [ending, icon] = ENDING[past.outcome?.status ?? "closed"];
  const ago = when(past.lastAt, now);
  const parts = [ending, ago, ...(past.userOnly ? ["replies not recorded"] : [])];
  return { label, description: parts.join(" · "), icon, accessibleLabel: `${label}, ${parts.join(", ")}` };
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// A line of work in the Sessions list: how its latest run ended (and at which card, when it did not finish), what its worktree holds,
// and when it was last active. Counts git could not give read "state unknown", never zero.
export function worktreeItem(line: Line, state: WorktreeState, head: string | undefined, now: number): ItemView {
  const label = plain(line.slug);
  const latest = line.runs[0];
  const [ending] = ENDING[latest?.outcome?.status ?? "closed"];
  const card = latest?.lastCard && latest.definition?.sessions[latest.lastCard.at.session]?.cards[latest.lastCard.at.card]?.label;
  const finished = latest?.outcome?.status === "done" || latest?.outcome?.status === "no-changes";
  const ran = !latest ? "no runs" : card && !finished ? `${ending} at ${plain(card)}` : ending;
  const held =
    line.where === "gone"
      ? ["gone"]
      : line.where === "unregistered"
        ? ["not a worktree any more"]
        : state.changed === undefined && state.ahead === undefined
          ? ["state unknown"]
          : [
              state.changed === undefined ? "changed files unknown" : plural(state.changed, "file changed", "files changed"),
              state.ahead === undefined ? "commits unknown" : `${plural(state.ahead, "commit", "commits")} ahead of ${plain(head ?? "HEAD")}`,
            ];
  const parts = [ran, ...held, ...(latest ? [when(latest.lastAt, now)] : [])];
  return { label, description: parts.join(" · "), icon: line.where === "here" ? "git-branch" : "warning", accessibleLabel: `${label}, worktree, ${parts.join(", ")}` };
}

// The session open now, at the top of the list: its run going, or the chat after it.
export function currentItem(title: string, phase: "running" | "waiting for you" | "chat open" | "ended"): ItemView {
  const icon = phase === "running" ? "loading~spin" : phase === "waiting for you" ? "bell-dot" : phase === "chat open" ? "comment-discussion" : "comment";
  const label = plain(title);
  return { label, description: phase, icon, accessibleLabel: `${label}, ${phase}` };
}

export type StartItem = { separator: string } | { label: string; description: string; id: string };

// Start… groups what can run the way the chains editor's rail does; an empty group is left out.
export function startItems(templates: readonly Chain[], chains: readonly Chain[]): StartItem[] {
  const item = (chain: Chain): StartItem => ({
    label: plain(chain.name),
    description: plain(singleSkill(chain) ? cardPrompt(chain.sessions[0]!.cards[0]!) : chain.sessions.map((s) => s.cards.map((c) => c.label).join(" → ")).join(" · ")),
    id: chain.id,
  });
  const groups: [string, readonly Chain[]][] = [
    ["Templates", templates.filter((t) => !singleSkill(t))],
    ["Single skills", templates.filter(singleSkill)],
    ["My chains", chains],
  ];
  return groups.flatMap(([separator, group]) => (group.length > 0 ? [{ separator }, ...group.map(item)] : []));
}

// A separator has no id, and a chain deleted while the pick was open is simply not found.
export const pickedChain = (id: string | undefined, templates: readonly Chain[], chains: readonly Chain[]): Chain | undefined =>
  id === undefined ? undefined : [...templates, ...chains].find((c) => c.id === id);

// `review` is the worktree to review; without one, nothing changed and the output says how to remove it.
export const finishedMessage = (name: string, brief: string, review?: string): string =>
  `Coordiner: ${name} is finished. The ${brief.toLowerCase()} is in the Coordiner output; ${review ? `review the worktree at ${review}.` : "no file changed, and the output says how to remove the worktree."}`;

// For a run whose review session found no changed file; `removable` when the output says how to remove the worktree.
export const nothingToReviewMessage = (name: string, removable: boolean): string =>
  `Coordiner: ${name} finished without changing any file, so there is nothing to review${removable ? "; the Coordiner output says how to remove the worktree." : "."}`;
