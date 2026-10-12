import { MSKILLS, skillDefault } from "./chains.ts";
import { REQUIRED_COMMANDS } from "./session.ts";

export type PaletteEntry = { skill: string; label: string; mskills: boolean };

export const mskillsPresent = (commands: readonly string[]): boolean => REQUIRED_COMMANDS.every((c) => commands.includes(c));

// Every slash command the session offers can be a card: m-skills first, then the rest, each alphabetical.
export function palette(commands: readonly string[]): PaletteEntry[] {
  const entries = [...new Set(commands)].map((skill) => ({ skill, label: skillDefault(skill).label, mskills: skill.startsWith(MSKILLS) }));
  return entries.sort((a, b) => Number(b.mskills) - Number(a.mskills) || a.skill.localeCompare(b.skill));
}
