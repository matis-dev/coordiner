import { INPUT_KINDS, inputOf, INPUTS, runnable, usesMskills, type Card, type Chain } from "./chains.ts";

// The decisions behind the chains webview, kept out of the DOM script so they can be tested. The webview loads this module from dist/.

export type EditorView = { running: boolean; mskills?: boolean; palette?: readonly { skill: string }[] };

export function runReason(chain: Chain, view: EditorView): string | undefined {
  if (view.running) return "A run is in progress.";
  if (view.mskills === false && usesMskills(chain)) return "Needs m-skills, which is not installed.";
  const result = runnable(chain, view.palette?.map((p) => p.skill));
  return result.ok ? undefined : result.reason;
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

export const copyName = (name: string): string => `${name} copy`.slice(0, 100);
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
