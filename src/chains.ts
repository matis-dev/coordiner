// Runtime imports only from modules that load in the webview too (images.ts, text.ts): the editor loads this module from dist/.
import { CARD_IMAGE_ID, isImageType, MAX_IMAGE_BYTES, MAX_IMAGE_NAME, MAX_IMAGES, type ImageRef } from "./images.ts";

// `model` and `effort` set how the card's turns run; absent, the step before it may suggest them (src/run.ts `turnSettings`), else the
// session's default model at the model's default effort. `follow` makes the previous step's suggestion win over the card's own values.
// `images`: pictures that are part of the card's instructions, sent with its first turn on every run; the card keeps only their refs,
// and the extension keeps the files (src/card-images.ts).
export type Card = { skill: string; args: string; label: string; pause: boolean; next?: string; model?: string; effort?: Effort; follow?: true; images?: ImageRef[] };
export type ChainSession = { cards: Card[] };
export type Chain = { id: string; name: string; sessions: ChainSession[]; builtIn?: true };

// A "once" card is one turn; a "loop" card keeps going on each NEXT (the implementing loop). Any other skill is "once".
// `doneSkipsLoops`: DONE from this skill means there is nothing for the loop cards after it to do (a review with no findings).
type SkillDefault = { kind: "once" | "loop"; label: string; next?: string; pause?: true; doneSkipsLoops?: true };

export const MSKILLS = "m-skills:";
// `follow` holds only right after an m-skills step in the same session, since m-skills is what suggests a model and effort; the
// first card of a session starts a fresh context, with nothing before it.
export const afterMskills = (cards: readonly Card[], i: number): boolean => i > 0 && cards[i - 1]?.skill.startsWith(MSKILLS) === true;
export const MSKILLS_URL = "https://github.com/matis-dev/m-skills";
// The most a user types in one go: the input Run asks for, or a message in the run's chat.
export const MAX_INPUT_CHARS = 20_000;
const PLAN = `${MSKILLS}planning-architect`;
const IMPLEMENT = `${MSKILLS}implementing-architect`;
export const REVIEW = `${MSKILLS}code-review-architect-uncommitted`;
const HISTORY = `${MSKILLS}rolling-history`;
const NEXT_STEP = "Continue with the next step of the plan.";

export const SKILL_DEFAULTS: Readonly<Record<string, SkillDefault>> = {
  [PLAN]: { kind: "once", label: "Plan" },
  [IMPLEMENT]: { kind: "loop", label: "Implement", next: NEXT_STEP },
  [REVIEW]: { kind: "once", label: "Review", doneSkipsLoops: true },
  [HISTORY]: { kind: "once", label: "History" },
  [`${MSKILLS}brainstorming-planner`]: { kind: "once", label: "Brainstorm", pause: true },
  [`${MSKILLS}debugging-architect`]: { kind: "once", label: "Debug", pause: true },
  [`${MSKILLS}kickoff`]: { kind: "once", label: "Kickoff", pause: true },
  [`${MSKILLS}onboard`]: { kind: "once", label: "Onboard", pause: true },
  [`${MSKILLS}security-audit`]: { kind: "once", label: "Security audit" },
  [`${MSKILLS}ui-audit`]: { kind: "once", label: "UI audit" },
  [`${MSKILLS}a11y-audit`]: { kind: "once", label: "Accessibility audit" },
  [`${MSKILLS}docs-audit`]: { kind: "once", label: "Docs audit" },
};

// What a stored chain may hold; the editor stops at the same limits, so an edit it shows is one the extension can save.
export const MAX_SESSIONS = 20;
export const MAX_CARDS = 30;
export const MAX_ARGS = 20_000;
export const MAX_LABEL = 60;
export const MAX_NAME = 100;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort);
// A model id reaches the SDK only as an option value, never a shell; the pattern still keeps it to one plain token.
export const MODEL = /^[A-Za-z0-9._:[\]-]{1,100}$/;

const GENERIC: SkillDefault = { kind: "once", label: "" };
// A skill name ending in ":" has no last part to show, so its label is the whole name.
export const skillDefault = (skill: string): SkillDefault => SKILL_DEFAULTS[skill] ?? { ...GENERIC, label: (skill.split(":").at(-1) || skill).slice(0, MAX_LABEL) };

export function defaultCard(skill: string): Card {
  const d = skillDefault(skill);
  return { skill, args: "", label: d.label, pause: d.pause ?? false, ...(d.next ? { next: d.next } : {}) };
}

// What a chain starts from: a placeholder in a card's arguments makes Run ask for that input and put it there.
// `ask` is the question Run asks when the input is typed; a story can also be picked from a backlog file.
export const INPUTS = {
  story: {
    placeholder: "{{story}}",
    chip: "the story you choose at Run",
    startsFrom: 'a written story. Run lets you pick one from a Markdown backlog file (headings like "## Story 1: …") or type it.',
    title: "Type a story",
    ask: "The story in one line: what should change, and for whom. Planning works out the rest.",
  },
  idea: {
    placeholder: "{{idea}}",
    chip: "the idea you describe at Run",
    startsFrom: "a rough idea; one line is enough. Run asks you to describe it, and the conversation asks the rest.",
    title: "Describe the idea",
    ask: "What do you want to build? One line is enough; the conversation asks the rest.",
  },
  bug: {
    placeholder: "{{bug}}",
    chip: "the bug you describe at Run",
    startsFrom: "a bug. Run asks what happened, what you expected, and how to trigger it.",
    title: "Describe the bug",
    ask: "What happened, what did you expect, and how do you trigger it?",
  },
} as const;
export type InputKind = keyof typeof INPUTS;
export const INPUT_KINDS = Object.keys(INPUTS) as InputKind[];
const card = (skill: string, args = "", extra: Partial<Card> = {}): Card => ({ ...defaultCard(skill), args, ...extra });
const reviewSession: ChainSession = {
  cards: [card(REVIEW), card(IMPLEMENT, "fix the findings", { label: "Fix", next: "Continue with the next fix.", follow: true }), card(HISTORY)],
};
// The implementing card runs on the model and effort its plan suggests.
const authorSession = (first: Card[]): ChainSession => ({
  cards: [...first, card(IMPLEMENT, "Implement the approved plan above.", { follow: true })],
});

// Each template is named after what you bring to it.
export const TEMPLATES: readonly Chain[] = [
  { id: "story", name: "Story", builtIn: true, sessions: [authorSession([card(PLAN, INPUTS.story.placeholder)]), reviewSession] },
  {
    id: "idea",
    name: "Idea",
    builtIn: true,
    sessions: [authorSession([card(`${MSKILLS}brainstorming-planner`, INPUTS.idea.placeholder), card(PLAN, "Plan the Deep-Dive Execution Prompt above.")]), reviewSession],
  },
  {
    id: "bug",
    name: "Bug",
    builtIn: true,
    // debugging-architect writes the regression test and the fix itself, so no plan or implement cards follow it.
    sessions: [{ cards: [card(`${MSKILLS}debugging-architect`, INPUTS.bug.placeholder)] }, reviewSession],
  },
  {
    id: "new-project",
    name: "New project",
    builtIn: true,
    sessions: [authorSession([card(`${MSKILLS}kickoff`, INPUTS.idea.placeholder), card(PLAN, "Plan the first slice decided above.")]), reviewSession],
  },
  // One skill on its own, named after the skill. Kickoff picks the next skill itself, so nothing follows it here.
  ...(["kickoff", "onboard", "security-audit", "ui-audit", "a11y-audit", "docs-audit"] as const).map((id): Chain => {
    const only = card(`${MSKILLS}${id}`);
    return { id, name: only.label, builtIn: true, sessions: [{ cards: [only] }] };
  }),
];

export const singleSkill = (chain: Chain): boolean => chain.sessions.length === 1 && chain.sessions[0]!.cards.length === 1;
// Only rolling-history writes a commit brief; any other last card's final message is the run's result.
export const briefHeading = (chain: Chain): string => (chain.sessions.at(-1)?.cards.at(-1)?.skill === HISTORY ? "Commit brief" : "Result");

export const cardPrompt = (c: Card): string => (c.args === "" ? `/${c.skill}` : `/${c.skill} ${c.args}`);
export const requiredSkills = (chain: Chain): string[] => [...new Set(chain.sessions.flatMap((s) => s.cards.map((c) => c.skill)))];
export const usesMskills = (chain: Chain): boolean => requiredSkills(chain).some((s) => s.startsWith(MSKILLS));
export const inputKinds = (chain: Chain): InputKind[] =>
  INPUT_KINDS.filter((kind) => chain.sessions.some((s) => s.cards.some((c) => c.args.includes(INPUTS[kind].placeholder))));
// A chain with no placeholder just needs a name for its worktree.
export const inputOf = (chain: Chain): InputKind | undefined => inputKinds(chain)[0];

export type Runnable = { ok: true } | { ok: false; reason: string };

// `commands` is what discovery found; undefined means not known yet, and the session's init check still guards the run.
const ONE_INPUT = `Use only one of ${INPUT_KINDS.map((k) => INPUTS[k].placeholder).join(", ")} in a chain; Run asks for one input.`;

export function runnable(chain: Chain, commands?: readonly string[]): Runnable {
  if (chain.sessions.length === 0) return { ok: false, reason: "This chain has no sessions." };
  const empty = chain.sessions.findIndex((s) => s.cards.length === 0);
  if (empty !== -1) return { ok: false, reason: `Session ${empty + 1} has no skills.` };
  if (inputKinds(chain).length > 1) return { ok: false, reason: ONE_INPUT };
  const missing = commands ? requiredSkills(chain).filter((s) => !commands.includes(s)) : [];
  if (missing.length > 0) return { ok: false, reason: `Missing skills: ${missing.join(", ")}.` };
  return { ok: true };
}

// While a run goes, whether `after` keeps what it has started: through session `through`, every card where it was (by skill), with
// cards added after them allowed. A started session's settings may change, since the run never reads that session again.
export const keepsStarted = (before: Chain, after: Chain, through: number): boolean =>
  before.sessions.slice(0, through + 1).every((session, s) => {
    const now = after.sessions[s]?.cards;
    return now !== undefined && now.length >= session.cards.length && session.cards.every((card, i) => now[i]!.skill === card.skill);
  });

// Why session `s` cannot start now the run has reached it, with the saved sessions taken in. Only that session must hold skills,
// so a later one can still be half made; the input the run was given (`kind`, none for a name only) must still fill the chain.
export function startReason(chain: Chain, s: number, kind: InputKind | undefined): string | undefined {
  if (chain.sessions[s]?.cards.length === 0) return `Session ${s + 1} has no skills.`;
  const kinds = inputKinds(chain);
  if (kinds.length > 1) return ONE_INPUT;
  const wanted = kinds[0];
  if (wanted !== undefined && wanted !== kind) return `${INPUTS[wanted].placeholder} has nothing to fill it: this run started from ${kind ? INPUTS[kind].chip : "a name only"}.`;
  return undefined;
}

// The run's chain with its sessions from `s` on as `saved` has them; the sessions before `s` stay as the run ran them.
export const takeFrom = (chain: Chain, saved: Chain, s: number): Chain => ({ ...chain, sessions: [...chain.sessions.slice(0, s), ...saved.sessions.slice(s)] });

// The chain a run goes on with as session `s` starts, from the saved `chains`: `takeFrom` the saved copy of the run's chain, or the
// run's chain as it is when none is saved (a template, or a chain deleted while it ran); else why session `s` cannot start.
export function pickUpFrom(chain: Chain, chains: readonly Chain[], s: number, kind: InputKind | undefined): Chain | string {
  const saved = chains.find((c) => c.id === chain.id);
  const next = saved ? takeFrom(chain, saved, s) : chain;
  return startReason(next, s, kind) ?? next;
}

// ── Stored chains ─────────────────────────────────────────────────────────────
// Parsed field by field into fresh objects, so unknown keys (including __proto__) never survive.

const SKILL = /^[A-Za-z0-9:_.-]{1,100}$/;
const ID = /^[a-z0-9-]{1,64}$/;
const TEMPLATE_IDS = new Set(TEMPLATES.map((t) => t.id));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;

// A card's image refs, rebuilt field by field: at most MAX_IMAGES, each named by its hash.
function parseImages(v: unknown): ImageRef[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_IMAGES) return undefined;
  const images: ImageRef[] = [];
  for (const i of v) {
    if (!isRecord(i) || !text(i.id, 64) || !CARD_IMAGE_ID.test(i.id) || !text(i.name, MAX_IMAGE_NAME, 1) || !isImageType(i.mediaType)) return undefined;
    if (!Number.isInteger(i.bytes) || (i.bytes as number) < 0 || (i.bytes as number) > MAX_IMAGE_BYTES || images.some((x) => x.id === i.id)) return undefined;
    images.push({ id: i.id, name: i.name, bytes: i.bytes as number, mediaType: i.mediaType });
  }
  return images;
}

function parseCard(v: unknown): Card | string {
  if (!isRecord(v)) return "a card is not an object";
  if (!text(v.skill, 100) || !SKILL.test(v.skill)) return "a card has an invalid skill name";
  if (!text(v.args, MAX_ARGS) || !text(v.label, MAX_LABEL, 1) || typeof v.pause !== "boolean") return `card ${v.skill} has invalid fields`;
  if (v.next !== undefined && !text(v.next, 500, 1)) return `card ${v.skill} has an invalid next prompt`;
  if (v.model !== undefined && !(typeof v.model === "string" && MODEL.test(v.model))) return `card ${v.skill} has an invalid model`;
  if (v.effort !== undefined && !isEffort(v.effort)) return `card ${v.skill} has an invalid effort`;
  if (v.follow !== undefined && v.follow !== true) return `card ${v.skill} has an invalid follow setting`;
  const images = v.images === undefined ? undefined : parseImages(v.images);
  if (v.images !== undefined && !images) return `card ${v.skill} has invalid images`;
  return {
    skill: v.skill,
    args: v.args,
    label: v.label,
    pause: v.pause,
    ...(v.next !== undefined ? { next: v.next } : {}),
    ...(v.model !== undefined ? { model: v.model } : {}),
    ...(v.effort !== undefined ? { effort: v.effort } : {}),
    ...(v.follow ? { follow: true as const } : {}),
    ...(images ? { images } : {}),
  };
}

// A stored or edited chain: its shape, and an id no built-in template has.
export function parseChain(v: unknown): Chain | string {
  if (isRecord(v) && typeof v.id === "string" && TEMPLATE_IDS.has(v.id)) return `chain id ${v.id} belongs to a built-in template`;
  return parseChainShape(v);
}

// The shape alone, field by field: a journaled run's chain may be a built-in template.
export function parseChainShape(v: unknown): Chain | string {
  if (!isRecord(v)) return "a chain is not an object";
  if (!text(v.id, 64) || !ID.test(v.id)) return "a chain has an invalid id";
  if (!text(v.name, MAX_NAME, 1)) return `chain ${v.id} has an invalid name`;
  if (!Array.isArray(v.sessions) || v.sessions.length > MAX_SESSIONS) return `chain ${v.id} has invalid sessions`;
  const sessions: ChainSession[] = [];
  for (const s of v.sessions) {
    if (!isRecord(s) || !Array.isArray(s.cards) || s.cards.length > MAX_CARDS) return `chain ${v.id} has an invalid session`;
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
