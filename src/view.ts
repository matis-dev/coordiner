import { cardPrompt, singleSkill, type Chain, type Effort } from "./chains.ts";
import type { Tier } from "./environment.ts";
import type { Process } from "./processes.ts";
import type { StepStatus } from "./run.ts";
import { clip, plain } from "./text.ts";

export type StepView = { label: string; tier: Tier; model: string; effort?: Effort; status: "running" | StepStatus; detail?: string };
export type ItemView = { label: string; description: string; icon: string; accessibleLabel: string };

const ICON: Record<StepView["status"], string> = {
  running: "loading~spin",
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
  return {
    label,
    description: `${plain(step.tier)} · ${plain(step.model)}${effort}${detail}`,
    icon: ICON[step.status],
    accessibleLabel: `${label}, ${step.status}, ${step.tier}, ${plain(step.model)}${step.effort ? `, effort ${step.effort}` : ""}`,
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
