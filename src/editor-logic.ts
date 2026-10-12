import { runnable, usesMskills, type Card, type Chain } from "./chains.ts";

// The decisions behind the chains webview, kept out of the DOM script so they can be tested. The webview loads this module from dist/.

export type EditorView = { running: boolean; mskills?: boolean; palette?: readonly { skill: string }[] };

export function runReason(chain: Chain, view: EditorView): string | undefined {
  if (view.running) return "A run is in progress.";
  if (view.mskills === false && usesMskills(chain)) return "Needs m-skills, which is not installed.";
  const result = runnable(chain, view.palette?.map((p) => p.skill));
  return result.ok ? undefined : result.reason;
}

// Unknown until discovery has run; a skill the workspace does not offer is flagged on its card.
export const isMissing = (card: Card, view: EditorView): boolean => view.palette !== undefined && !view.palette.some((p) => p.skill === card.skill);

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
