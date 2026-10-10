import type { Tier } from "./environment.ts";
import type { StepStatus } from "./run.ts";
import { clip, plain } from "./text.ts";

export type StepView = { label: string; tier: Tier; model: string; status: "running" | StepStatus; detail?: string };
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
  return {
    label,
    description: `${plain(step.tier)} · ${plain(step.model)}${detail}`,
    icon: ICON[step.status],
    accessibleLabel: `${label}, ${step.status}, ${step.tier}, ${plain(step.model)}`,
  };
}
