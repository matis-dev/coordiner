import { afterMskills, INPUT_KINDS, inputOf, INPUTS, MAX_CARDS, MAX_NAME, MAX_SESSIONS, runnable, usesMskills, type Card, type Chain, type Effort } from "./chains.ts";
import type { Slot } from "./chain-edit.ts";
import type { ModelOption } from "./skills.ts";

// The decisions behind the chains webview, kept out of the DOM script so they can be tested. The webview loads this module from dist/.

export type EditorView = {
  running: boolean;
  mskills?: boolean;
  palette?: readonly { skill: string }[];
  models?: readonly ModelOption[];
  // The model a card on Default runs on.
  defaultModel?: string;
  locked?: { chainId: string; through: number };
};

// Until the models are listed nothing is offered, and nothing is refused: the session's own model check still guards the turn.
function effortsFor(model: string | undefined, view: EditorView): readonly Effort[] {
  if (!view.models) return [];
  return view.models.find((m) => m.id === (model ?? view.defaultModel))?.efforts ?? [];
}
export const effortChoices = (card: Card, view: EditorView): readonly Effort[] => effortsFor(card.model, view);
// A new model keeps the card's effort only when it takes that effort too.
export const effortAfterModel = (card: Card, model: string | undefined, view: EditorView): Effort | undefined =>
  card.effort !== undefined && effortsFor(model, view).includes(card.effort) ? card.effort : undefined;
export const modelOffered = (card: Card, view: EditorView): boolean => card.model === undefined || !view.models || view.models.some((m) => m.id === card.model);
const effortOffered = (card: Card, view: EditorView): boolean => card.effort === undefined || !view.models || effortChoices(card, view).includes(card.effort);

// Why the Effort list holds only the model's default.
export function effortReason(card: Card, view: EditorView): string | undefined {
  if (effortChoices(card, view).length > 0) return undefined;
  if (!view.models) return "Effort can be set once the session's models are listed.";
  if (card.model === undefined && view.defaultModel === undefined) return "The session names no default model; pick a model to set an effort.";
  return card.model === undefined ? "The default model has no effort setting." : "This model has no effort setting.";
}

// A card can take its model and effort from the step before it where a run would let it (`afterMskills`), and only while m-skills
// is installed.
export const followAvailable = (chain: Chain, s: number, i: number, view: EditorView): boolean => view.mskills === true && afterMskills(chain.sessions[s]?.cards ?? [], i);

export function runReason(chain: Chain, view: EditorView): string | undefined {
  if (view.running) return "A run is in progress. Stop it in the chat below or with Coordiner: Stop Run to start another.";
  if (view.mskills === false && usesMskills(chain)) return "Needs m-skills, which is not installed.";
  const result = runnable(chain, view.palette?.map((p) => p.skill));
  if (!result.ok) return result.reason;
  const cards = chain.sessions.flatMap((s) => s.cards);
  const stale = cards.find((c) => !modelOffered(c, view));
  if (stale) return `${stale.label}: model ${stale.model} is not offered by this session.`;
  const unoffered = cards.find((c) => !effortOffered(c, view));
  if (unoffered) return `${unoffered.label}: effort ${unoffered.effort} is not available for ${unoffered.model ?? "the default model"}.`;
  return undefined;
}

// The card a run is on, in session `s` of `chain`, or -1. By index, since two cards in a session can share a label.
export const runningCard = (chain: Chain, s: number, runningAt?: { chainId: string; session: number; index: number }): number =>
  runningAt?.chainId === chain.id && runningAt.session === s ? runningAt.index : -1;

// Unknown until discovery has run; a skill the workspace does not offer is flagged on its card.
export const isMissing = (card: Card, view: EditorView): boolean => view.palette !== undefined && !view.palette.some((p) => p.skill === card.skill);

export function startsFrom(chain: Chain): string {
  const kind = inputOf(chain);
  return `Starts from ${kind ? INPUTS[kind].startsFrom : "a name only. Run asks for one; it names the worktree and the branch."}`;
}

const PLACEHOLDERS = INPUT_KINDS.map((k) => INPUTS[k].placeholder);
export const PLACEHOLDER_NOTE = `${PLACEHOLDERS.slice(0, -1).join(", ")} and ${PLACEHOLDERS.at(-1)} are placeholders: type one in a card's arguments, and Run asks for that input and puts it in its place.`;

// Splits a card's arguments so each placeholder can be shown as what Run will put there.
const PLACEHOLDER = new RegExp(`(${PLACEHOLDERS.map((p) => p.replace(/[{}]/g, "\\$&")).join("|")})`);
export const argParts = (args: string): ({ text: string } | { chip: string })[] =>
  args
    .split(PLACEHOLDER)
    .filter((part) => part !== "")
    .map((part) => {
      const kind = INPUT_KINDS.find((k) => INPUTS[k].placeholder === part);
      return kind ? { chip: INPUTS[kind].chip } : { text: part };
    });

// `{{…}}` that Run will not fill, such as a file path, reaches the skill as typed; the card says so.
export function strayNote(args: string): string | undefined {
  const stray = [...new Set(args.match(/\{\{[^{}]*\}\}/g) ?? [])].filter((p) => !PLACEHOLDERS.some((known) => known === p));
  if (stray.length === 0) return undefined;
  const which = stray.length === 1 ? `${stray[0]} is not a placeholder` : `${stray.join(" and ")} are not placeholders`;
  return `${which}, so the skill gets it as typed. Run fills only ${PLACEHOLDERS.join(", ")}; for a story file, write ${INPUTS.story.placeholder} and pick the file when Run asks.`;
}

// Why Add or Add a session is off: the chain is at a limit the extension would refuse to save past.
export const addCardReason = (chain: Chain, s: number): string | undefined =>
  (chain.sessions[s]?.cards.length ?? 0) >= MAX_CARDS ? `A session holds at most ${MAX_CARDS} skills.` : undefined;
export const addSessionReason = (chain: Chain): string | undefined => (chain.sessions.length >= MAX_SESSIONS ? `A chain holds at most ${MAX_SESSIONS} sessions.` : undefined);

export const copyName = (name: string): string => `${name} copy`.slice(0, MAX_NAME);

// A template never changes: an edit made on one goes to the copy `copy` makes of it, and the copy is what gets saved.
export const copyThenEdit = (chain: Chain, change: (chain: Chain) => Chain, copy: (chain: Chain) => Chain): Chain => change(chain.builtIn ? copy(chain) : chain);
export const newChainId = (now: number): string => `chain-${now.toString(36)}`;

// Alt+Left / Alt+Right on a card move it; anything else is not ours.
export function moveDelta(key: { altKey: boolean; key: string }): -1 | 1 | undefined {
  if (!key.altKey) return undefined;
  if (key.key === "ArrowLeft") return -1;
  if (key.key === "ArrowRight") return 1;
  return undefined;
}

// Focus keys name the control that should hold focus after a re-render.
export const moveKey = (s: number, i: number, delta: -1 | 1): string => `move-${s}-${i}-${delta}`;
export const removeKey = (s: number, i: number): string => `remove-${s}-${i}`;
export const addKey = (s: number): string => `add-${s}`;
export const modelKey = (s: number, i: number): string => `model-${s}-${i}`;
export const effortKey = (s: number, i: number): string => `effort-${s}-${i}`;
export const pauseKey = (s: number, i: number): string => `pause-${s}-${i}`;
export const followKey = (s: number, i: number): string => `follow-${s}-${i}`;
export const filterKey = (s: number): string => `filter-${s}`;

// The skills whose name or label holds the filter's text, in any case; an empty filter keeps them all.
export function filterPalette<T extends { skill: string; label: string }>(palette: readonly T[], query: string): readonly T[] {
  const q = query.trim().toLowerCase();
  return q === "" ? palette : palette.filter((p) => p.skill.toLowerCase().includes(q) || p.label.toLowerCase().includes(q));
}

export const matchCount = (n: number): string => (n === 0 ? "No skills match" : n === 1 ? "1 skill matches" : `${n} skills match`);

// What the Model list calls Default: the model it is, once the session has named it.
export const defaultLabel = (view: EditorView): string => {
  const model = view.models?.find((m) => m.id === view.defaultModel);
  return model ? `Default (${model.label})` : "Default";
};

// Why a session's cards cannot change places: the run has started it.
export const lockReason = (chain: Chain, s: number, view: EditorView): string | undefined =>
  view.locked?.chainId === chain.id && s <= view.locked.through ? `Session ${s + 1} has started: its cards keep their order until the run ends.` : undefined;

// Where an arrow moves a card: its neighbour's place, or past either end of its session, the near end of the session that way.
// Nothing past either end of the chain.
export function moveTarget(chain: Chain, s: number, i: number, delta: -1 | 1): Slot | undefined {
  const count = chain.sessions[s]?.cards.length ?? 0;
  if (i + delta >= 0 && i + delta < count) return { s, i: i + delta };
  const next = chain.sessions[s + delta];
  if (!next) return undefined;
  return { s: s + delta, i: delta < 0 ? next.cards.length : 0 };
}

// Where a dropped card ends: before the card it was dropped on, or at the end of the session (`before` undefined).
export function dropTarget(chain: Chain, from: Slot, s: number, before?: number): Slot {
  const count = chain.sessions[s]?.cards.length ?? 0;
  const at = before ?? count;
  return { s, i: s === from.s && from.i < at ? at - 1 : at };
}

// Why a card cannot go from `from` to `to`: either session has started, or the other session is full.
export const moveReason = (chain: Chain, from: Slot, to: Slot, view: EditorView): string | undefined =>
  lockReason(chain, from.s, view) ?? lockReason(chain, to.s, view) ?? (to.s === from.s ? undefined : addCardReason(chain, to.s));

export const movedNote = (label: string, from: Slot, to: Slot): string =>
  to.s === from.s ? `Moved ${label} to position ${to.i + 1}` : `Moved ${label} to session ${to.s + 1}, position ${to.i + 1}`;

// After a remove, focus goes to the card that took its place, else the one before it, else the session's Add button.
export function afterRemove(s: number, i: number, count: number): string {
  if (i < count - 1) return removeKey(s, i);
  if (i > 0) return removeKey(s, i - 1);
  return addKey(s);
}
