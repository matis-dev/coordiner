import { defaultCard, type Card, type Chain, type ChainSession, type Effort } from "./chains.ts";

// Pure edits for the chains editor; the webview loads this module from dist/. Every function returns a new chain, and an index
// out of range leaves the chain as it was.

const editSession = (chain: Chain, s: number, edit: (cards: Card[]) => Card[]): Chain =>
  s < 0 || s >= chain.sessions.length ? chain : { ...chain, sessions: chain.sessions.map((session, i) => (i === s ? { cards: edit(session.cards) } : session)) };

export function moveCard(chain: Chain, s: number, i: number, delta: -1 | 1): Chain {
  return editSession(chain, s, (cards) => {
    const to = i + delta;
    if (i < 0 || i >= cards.length || to < 0 || to >= cards.length) return cards;
    const next = [...cards];
    [next[i], next[to]] = [next[to]!, next[i]!];
    return next;
  });
}

export const addCard = (chain: Chain, s: number, skill: string): Chain => editSession(chain, s, (cards) => [...cards, defaultCard(skill)]);
export const removeCard = (chain: Chain, s: number, i: number): Chain => editSession(chain, s, (cards) => cards.filter((_, j) => j !== i));
export const setArgs = (chain: Chain, s: number, i: number, args: string): Chain => editSession(chain, s, (cards) => cards.map((c, j) => (j === i ? { ...c, args } : c)));

// Undefined removes the field, so a card back on its tier or the model's default effort is stored as it was before either was set.
const withCard = (chain: Chain, s: number, i: number, patch: (card: Card) => Card): Chain => editSession(chain, s, (cards) => cards.map((c, j) => (j === i ? patch(c) : c)));
export const setModel = (chain: Chain, s: number, i: number, model?: string, effort?: Effort): Chain =>
  withCard(chain, s, i, ({ model: _model, effort: _effort, ...c }) => ({ ...c, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }));
export const setEffort = (chain: Chain, s: number, i: number, effort?: Effort): Chain =>
  withCard(chain, s, i, ({ effort: _effort, ...c }) => ({ ...c, ...(effort !== undefined ? { effort } : {}) }));

export const addSession = (chain: Chain): Chain => ({ ...chain, sessions: [...chain.sessions, { cards: [] }] });
export const removeSession = (chain: Chain, s: number): Chain => ({ ...chain, sessions: chain.sessions.filter((_, i) => i !== s) });
export const rename = (chain: Chain, name: string): Chain => ({ ...chain, name });

// A copy is the user's own: never built in, and deep enough that editing it cannot touch the original.
export function duplicate(chain: Chain, id: string, name: string): Chain {
  const sessions: ChainSession[] = chain.sessions.map((s) => ({ cards: s.cards.map((c) => ({ ...c })) }));
  return { id, name, sessions };
}
