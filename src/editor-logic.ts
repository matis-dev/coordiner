import { INPUT_KINDS, inputOf, INPUTS, MAX_CARDS, MAX_NAME, MAX_SESSIONS, runnable, skillDefault, usesMskills, type Card, type Chain, type Effort } from "./chains.ts";
import type { ModelOption } from "./skills.ts";

// The decisions behind the chains webview, kept out of the DOM script so they can be tested. The webview loads this module from dist/.

export type EditorView = {
  running: boolean;
  mskills?: boolean;
  palette?: readonly { skill: string }[];
  models?: readonly ModelOption[];
  tierEfforts?: readonly Effort[];
};

// Until the models are listed nothing is offered, and nothing is refused: the session's own model check still guards the turn.
function effortsFor(model: string | undefined, view: EditorView): readonly Effort[] {
  if (!view.models) return [];
  if (model === undefined) return view.tierEfforts ?? [];
  return view.models.find((m) => m.id === model)?.efforts ?? [];
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
  return card.model === undefined ? "The tier models do not share an effort setting; pin a model to set one." : "This model has no effort setting.";
}

// A pinned loop card keeps its model through the plan's tier stops.
export const pinNote = (card: Card): string | undefined =>
  card.model !== undefined && skillDefault(card.skill).kind === "loop" ? "Pinned: NEXT <tier> does not change this card's model." : undefined;

export function runReason(chain: Chain, view: EditorView): string | undefined {
  if (view.running) return "A run is in progress. To run another, stop it first: Stop run or End chat in its chat, the Stop button in the Sessions view, or Coordiner: Stop Run.";
  if (view.mskills === false && usesMskills(chain)) return "Needs m-skills, which is not installed.";
  const result = runnable(chain, view.palette?.map((p) => p.skill));
  if (!result.ok) return result.reason;
  const cards = chain.sessions.flatMap((s) => s.cards);
  const stale = cards.find((c) => !modelOffered(c, view));
  if (stale) return `${stale.label}: model ${stale.model} is not offered by this session.`;
  const unoffered = cards.find((c) => !effortOffered(c, view));
  if (unoffered) return `${unoffered.label}: effort ${unoffered.effort} is not available for ${unoffered.model ?? "its tier's models"}.`;
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
export const PLACEHOLDER_NOTE = `Put ${PLACEHOLDERS.slice(0, -1).join(", ")} or ${PLACEHOLDERS.at(-1)} in a card's arguments, and Run asks for that input and puts it there.`;

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

// After a move, focus stays on the same button of the moved card; at either end nothing moves.
export function afterMove(s: number, i: number, delta: -1 | 1, count: number): string | undefined {
  const to = i + delta;
  return to < 0 || to >= count ? undefined : moveKey(s, to, delta);
}

// After a remove, focus goes to the card that took its place, else the one before it, else the session's Add button.
export function afterRemove(s: number, i: number, count: number): string {
  if (i < count - 1) return removeKey(s, i);
  if (i > 0) return removeKey(s, i - 1);
  return addKey(s);
}
