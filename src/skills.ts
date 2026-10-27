import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { EFFORTS, MODEL, MSKILLS, skillDefault, type Effort } from "./chains.ts";
import { REQUIRED_COMMANDS } from "./session.ts";
import { plain } from "./text.ts";

export type PaletteEntry = { skill: string; label: string; mskills: boolean };

export const mskillsPresent = (commands: readonly string[]): boolean => REQUIRED_COMMANDS.every((c) => commands.includes(c));

// Every slash command the session offers can be a card: m-skills first, then the rest, each alphabetical.
export function palette(commands: readonly string[]): PaletteEntry[] {
  const entries = [...new Set(commands)].map((skill) => ({ skill, label: skillDefault(skill).label, mskills: skill.startsWith(MSKILLS) }));
  return entries.sort((a, b) => Number(b.mskills) - Number(a.mskills) || a.skill.localeCompare(b.skill));
}

export type ModelOption = { id: string; label: string; efforts: Effort[] };

// A card stores the model id the session resolves to, so the session's own model check can compare it. An alias row and an explicit
// row for the same model are offered once; an id that is not one plain token is not offered at all. The "default" row comes last: a
// card pinned to it keeps that model when the default moves, so it is named by the model ("Opus 5.5", the lead of the description
// "Opus 5.5 · Best for …"), not "Default (recommended)".
export function modelOptions(models: readonly ModelInfo[]): ModelOption[] {
  const options: ModelOption[] = [];
  for (const m of [...models.filter((m) => m.value !== "default"), ...models.filter((m) => m.value === "default")]) {
    const id = m.resolvedModel ?? m.value;
    if (!MODEL.test(id) || options.some((o) => o.id === id)) continue;
    const efforts = m.supportsEffort === false ? [] : EFFORTS.filter((e) => m.supportedEffortLevels?.includes(e));
    const name = m.description.includes(" · ") ? plain(m.description.split(" · ")[0]!) : "";
    options.push({ id, label: name || plain(m.displayName) || id, efforts });
  }
  return options;
}

// A card on its tier can land on any of the three tier models, so it may only ask for an effort all of them take.
export function commonEfforts(options: readonly ModelOption[], tierModels: readonly string[]): Effort[] {
  const found = tierModels.map((id) => options.find((o) => o.id === id));
  return found.every((o) => o !== undefined) ? EFFORTS.filter((e) => found.every((o) => o.efforts.includes(e))) : [];
}
