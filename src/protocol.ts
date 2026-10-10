import type { Tier } from "./environment.ts";

export type PlannerTier = "Light" | "Standard" | "Heavy";
export type Status = { kind: "next"; tier: PlannerTier } | { kind: "done" } | { kind: "halt"; reason: string } | { kind: "none" };

const TIER_OF: Record<PlannerTier, Tier> = { Heavy: "strong", Standard: "medium", Light: "weak" };
const STATUS_LINE = /^COORDINER: (?:NEXT (Light|Standard|Heavy)|(DONE)|HALT (.{1,300}))$/;

export const tierOf = (planner: PlannerTier): Tier => TIER_OF[planner];

// Only the last non-empty line counts: a marker quoted mid-text (a plan, a file's contents) must not steer the run.
export function parseStatus(text: string): Status {
  const last = text.trimEnd().split("\n").at(-1)!.trim();
  const match = STATUS_LINE.exec(last);
  if (!match) return { kind: "none" };
  if (match[1]) return { kind: "next", tier: match[1] as PlannerTier };
  if (match[2]) return { kind: "done" };
  return { kind: "halt", reason: match[3]! };
}

export const UNATTENDED_NOTE = [
  "This session is driven by coordiner, an unattended pipeline running the m-skills flow. Nobody is at the keyboard.",
  "Finish the skill's work, then end your turn. Do not offer a next-step picker or start another skill.",
  "Planning: instead of the approval picker, end with the line `COORDINER: NEXT <tier>`, where <tier> (Light, Standard or Heavy) is the tier of the plan's first step.",
  "Implementing: at every tier stop in the plan, end with `COORDINER: NEXT <tier>` naming the next step's tier. When the whole plan is done, end with `COORDINER: DONE`.",
  "If you hit a decision the plan reserves for the user (a one-way door), do not ask: end with `COORDINER: HALT <one-line reason>`.",
  "The status line must be the last line of your final message.",
  "Questions you genuinely need answered go through AskUserQuestion, and every question must carry an option labelled (Recommended) that is safe to take without the user; for multi-select, label a recommended set. Coordiner takes the Recommended option and logs it.",
].join(" ");
