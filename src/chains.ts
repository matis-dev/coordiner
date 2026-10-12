import type { Tier } from "./environment.ts";

// No runtime imports: the editor webview loads this module from dist/ as well.

export type Card = { skill: string; args: string; label: string; pause: boolean; next?: string };
export type ChainSession = { cards: Card[] };
export type Chain = { id: string; name: string; sessions: ChainSession[]; builtIn?: true };

// A "once" card is one turn; a "loop" card keeps going on each NEXT (the implementing loop). Any other skill is "once" on the medium tier.
// `doneSkipsLoops`: DONE from this skill means there is nothing for the loop cards after it to do (a review with no findings).
type SkillDefault = { kind: "once" | "loop"; tier: Tier; label: string; next?: string; pause?: true; doneSkipsLoops?: true };

export const MSKILLS = "m-skills:";
export const MSKILLS_URL = "https://github.com/matis-dev/m-skills";
const PLAN = `${MSKILLS}planning-architect`;
const IMPLEMENT = `${MSKILLS}implementing-architect`;
export const REVIEW = `${MSKILLS}code-review-architect-uncommitted`;
const HISTORY = `${MSKILLS}rolling-history`;
const NEXT_STEP = "Continue with the next step of the plan.";

export const SKILL_DEFAULTS: Readonly<Record<string, SkillDefault>> = {
  [PLAN]: { kind: "once", tier: "strong", label: "Plan" },
  [IMPLEMENT]: { kind: "loop", tier: "medium", label: "Implement", next: NEXT_STEP },
  [REVIEW]: { kind: "once", tier: "strong", label: "Review", doneSkipsLoops: true },
  [HISTORY]: { kind: "once", tier: "medium", label: "History" },
  [`${MSKILLS}brainstorming-planner`]: { kind: "once", tier: "strong", label: "Brainstorm", pause: true },
  [`${MSKILLS}debugging-architect`]: { kind: "once", tier: "strong", label: "Debug", pause: true },
  [`${MSKILLS}kickoff`]: { kind: "once", tier: "strong", label: "Kickoff", pause: true },
};

const GENERIC: SkillDefault = { kind: "once", tier: "medium", label: "" };
export const skillDefault = (skill: string): SkillDefault => SKILL_DEFAULTS[skill] ?? { ...GENERIC, label: skill.split(":").at(-1)! };

export function defaultCard(skill: string): Card {
  const d = skillDefault(skill);
  return { skill, args: "", label: d.label, pause: d.pause ?? false, ...(d.next ? { next: d.next } : {}) };
}

export const STORY = "{{story}}";
const card = (skill: string, args = "", extra: Partial<Card> = {}): Card => ({ ...defaultCard(skill), args, ...extra });
const reviewSession: ChainSession = {
  cards: [card(REVIEW), card(IMPLEMENT, "fix the findings", { label: "Fix", next: "Continue with the next fix." }), card(HISTORY)],
};
const authorSession = (first: Card[]): ChainSession => ({
  cards: [...first, card(IMPLEMENT, "Implement the approved plan above.")],
});

export const TEMPLATES: readonly Chain[] = [
  { id: "story", name: "Story", builtIn: true, sessions: [authorSession([card(PLAN, STORY)]), reviewSession] },
  {
    id: "brainstorm-story",
    name: "Brainstorm story",
    builtIn: true,
    sessions: [authorSession([card(`${MSKILLS}brainstorming-planner`, STORY), card(PLAN, "Plan the Deep-Dive Execution Prompt above.")]), reviewSession],
  },
  {
    id: "debug-story",
    name: "Debug story",
    builtIn: true,
    sessions: [authorSession([card(`${MSKILLS}debugging-architect`, STORY), card(PLAN, "Plan the fix found above.")]), reviewSession],
  },
  {
    id: "kickoff",
    name: "Kickoff",
    builtIn: true,
    sessions: [authorSession([card(`${MSKILLS}kickoff`, STORY), card(PLAN, "Plan the first slice decided above.")]), reviewSession],
  },
];

export const cardPrompt = (c: Card): string => (c.args === "" ? `/${c.skill}` : `/${c.skill} ${c.args}`);
export const requiredSkills = (chain: Chain): string[] => [...new Set(chain.sessions.flatMap((s) => s.cards.map((c) => c.skill)))];
export const usesMskills = (chain: Chain): boolean => requiredSkills(chain).some((s) => s.startsWith(MSKILLS));
// Only a chain that puts the story in a prompt needs a backlog story; any other chain just needs a name for its worktree.
export const usesStory = (chain: Chain): boolean => chain.sessions.some((s) => s.cards.some((c) => c.args.includes(STORY)));

export type Runnable = { ok: true } | { ok: false; reason: string };

// `commands` is what discovery found; undefined means not known yet, and the session's init check still guards the run.
export function runnable(chain: Chain, commands?: readonly string[]): Runnable {
  if (chain.sessions.length === 0) return { ok: false, reason: "This chain has no sessions." };
  const empty = chain.sessions.findIndex((s) => s.cards.length === 0);
  if (empty !== -1) return { ok: false, reason: `Session ${empty + 1} has no skills.` };
  if (chain.sessions.some((s) => s.cards.some((c) => c.pause))) return { ok: false, reason: "A card here pauses for you, and that needs the chat panel, which comes in the next slice." };
  const missing = commands ? requiredSkills(chain).filter((s) => !commands.includes(s)) : [];
  if (missing.length > 0) return { ok: false, reason: `Missing skills: ${missing.join(", ")}.` };
  return { ok: true };
}

// ── Stored chains ─────────────────────────────────────────────────────────────
// Parsed field by field into fresh objects, so unknown keys (including __proto__) never survive.

const SKILL = /^[A-Za-z0-9:_.-]{1,100}$/;
const ID = /^[a-z0-9-]{1,64}$/;
const MAX_ARGS = 20_000;
const TEMPLATE_IDS = new Set(TEMPLATES.map((t) => t.id));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;

function parseCard(v: unknown): Card | string {
  if (!isRecord(v)) return "a card is not an object";
  if (!text(v.skill, 100) || !SKILL.test(v.skill)) return "a card has an invalid skill name";
  if (!text(v.args, MAX_ARGS) || !text(v.label, 60, 1) || typeof v.pause !== "boolean") return `card ${v.skill} has invalid fields`;
  if (v.next !== undefined && !text(v.next, 500, 1)) return `card ${v.skill} has an invalid next prompt`;
  return { skill: v.skill, args: v.args, label: v.label, pause: v.pause, ...(v.next !== undefined ? { next: v.next } : {}) };
}

export function parseChain(v: unknown): Chain | string {
  if (!isRecord(v)) return "a chain is not an object";
  if (!text(v.id, 64) || !ID.test(v.id)) return "a chain has an invalid id";
  if (TEMPLATE_IDS.has(v.id)) return `chain id ${v.id} belongs to a built-in template`;
  if (!text(v.name, 100, 1)) return `chain ${v.id} has an invalid name`;
  if (!Array.isArray(v.sessions) || v.sessions.length > 20) return `chain ${v.id} has invalid sessions`;
  const sessions: ChainSession[] = [];
  for (const s of v.sessions) {
    if (!isRecord(s) || !Array.isArray(s.cards) || s.cards.length > 30) return `chain ${v.id} has an invalid session`;
    const cards: Card[] = [];
    for (const c of s.cards) {
      const parsed = parseCard(c);
      if (typeof parsed === "string") return `chain ${v.id}: ${parsed}`;
      cards.push(parsed);
    }
    sessions.push({ cards });
  }
  return { id: v.id, name: v.name, sessions };
}

export function parseChains(json: string): { chains: Chain[]; error?: string } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { chains: [], error: "the chains file is not valid JSON" };
  }
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.chains)) return { chains: [], error: "the chains file has an unknown format" };
  const chains: Chain[] = [];
  for (const c of data.chains) {
    const parsed = parseChain(c);
    if (typeof parsed === "string") return { chains: [], error: parsed };
    if (chains.some((x) => x.id === parsed.id)) return { chains: [], error: `chain id ${parsed.id} appears twice` };
    chains.push(parsed);
  }
  return { chains };
}

export const serializeChains = (chains: readonly Chain[]): string => `${JSON.stringify({ version: 1, chains }, null, 2)}\n`;
