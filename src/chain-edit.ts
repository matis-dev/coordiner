import { defaultCard, type Card, type Chain, type ChainSession, type Effort } from "./chains.ts";
import { MAX_IMAGES, type ImageRef } from "./images.ts";

// Pure edits for the chains editor; the webview loads this module from dist/. Every function returns a new chain, and an index
// out of range leaves the chain as it was.

const editSession = (chain: Chain, s: number, edit: (cards: Card[]) => Card[]): Chain =>
  s < 0 || s >= chain.sessions.length ? chain : { ...chain, sessions: chain.sessions.map((session, i) => (i === s ? { cards: edit(session.cards) } : session)) };

// A card's place: its session and its index there.
export type Slot = { s: number; i: number };

// Moves the card at `from` so it ends at `to`, in its own session or another; `to.i` counts the target's cards without it.
export function moveTo(chain: Chain, from: Slot, to: Slot): Chain {
  const card = chain.sessions[from.s]?.cards[from.i];
  if (!card) return chain;
  const left = editSession(chain, from.s, (cards) => cards.filter((_, j) => j !== from.i));
  const target = left.sessions[to.s]?.cards;
  if (!target || to.i < 0 || to.i > target.length) return chain;
  return editSession(left, to.s, (cards) => [...cards.slice(0, to.i), card, ...cards.slice(to.i)]);
}

export const addCard = (chain: Chain, s: number, skill: string): Chain => editSession(chain, s, (cards) => [...cards, defaultCard(skill)]);
export const removeCard = (chain: Chain, s: number, i: number): Chain => editSession(chain, s, (cards) => cards.filter((_, j) => j !== i));
export const setArgs = (chain: Chain, s: number, i: number, args: string): Chain => editSession(chain, s, (cards) => cards.map((c, j) => (j === i ? { ...c, args } : c)));

// Undefined removes the field, so a card back on Default or the model's default effort is stored as it was before either was set.
const withCard = (chain: Chain, s: number, i: number, patch: (card: Card) => Card): Chain => editSession(chain, s, (cards) => cards.map((c, j) => (j === i ? patch(c) : c)));
export const setModel = (chain: Chain, s: number, i: number, model?: string, effort?: Effort): Chain =>
  withCard(chain, s, i, ({ model: _model, effort: _effort, ...c }) => ({ ...c, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }));
export const setEffort = (chain: Chain, s: number, i: number, effort?: Effort): Chain =>
  withCard(chain, s, i, ({ effort: _effort, ...c }) => ({ ...c, ...(effort !== undefined ? { effort } : {}) }));
// An image becomes part of the card's instructions; one it already has, or one past the most a card takes, is not added.
export const addCardImage = (chain: Chain, s: number, i: number, image: ImageRef): Chain =>
  withCard(chain, s, i, (c) => (c.images?.some((x) => x.id === image.id) || (c.images?.length ?? 0) >= MAX_IMAGES ? c : { ...c, images: [...(c.images ?? []), image] }));
export const removeCardImage = (chain: Chain, s: number, i: number, id: string): Chain =>
  withCard(chain, s, i, ({ images, ...c }) => {
    const left = (images ?? []).filter((x) => x.id !== id);
    return left.length > 0 ? { ...c, images: left } : c;
  });
export const setPause = (chain: Chain, s: number, i: number, pause: boolean): Chain => withCard(chain, s, i, (c) => ({ ...c, pause }));
export const setFollow = (chain: Chain, s: number, i: number, follow: boolean): Chain =>
  withCard(chain, s, i, ({ follow: _follow, ...c }) => ({ ...c, ...(follow ? { follow: true as const } : {}) }));

export const addSession = (chain: Chain): Chain => ({ ...chain, sessions: [...chain.sessions, { cards: [] }] });
export const removeSession = (chain: Chain, s: number): Chain => ({ ...chain, sessions: chain.sessions.filter((_, i) => i !== s) });
export const rename = (chain: Chain, name: string): Chain => ({ ...chain, name });

// A copy is the user's own: never built in, and deep enough that editing it cannot touch the original.
export function duplicate(chain: Chain, id: string, name: string): Chain {
  const sessions: ChainSession[] = chain.sessions.map((s) => ({ cards: s.cards.map((c) => ({ ...c })) }));
  return { id, name, sessions };
}
