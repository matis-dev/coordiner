import { MAX_INPUT_CHARS, parseChain, type Chain, type Effort } from "./chains.ts";
import type { CacheClock, Pick } from "./chat-logic.ts";
import type { ModelOption, PaletteEntry } from "./skills.ts";
import type { TalkSnapshot } from "./talk.ts";
import type { Entry } from "./transcript.ts";

// Messages from the webview are untrusted input: each type has an exact set of keys, and anything else is dropped.
export type EditorMessage =
  | { type: "ready" }
  | { type: "save"; chain: Chain }
  | { type: "delete"; id: string }
  | { type: "run"; id: string }
  | { type: "refreshPalette" }
  | { type: "openMskills" }
  | { type: "checkEnvironment" }
  // The run's chat
  | { type: "chatSend"; text: string }
  | { type: "chatWithdraw"; id: string }
  | { type: "chatPause" }
  | { type: "chatContinue" }
  | { type: "chatAnswer"; id: string; picks: Pick[] }
  | { type: "chatStop" };

export type EditorState = {
  type: "state";
  templates: readonly Chain[];
  chains: readonly Chain[];
  // undefined while discovery runs or after it failed
  palette?: PaletteEntry[];
  paletteError?: string;
  mskills?: boolean;
  // Listed with the skills; undefined while discovery runs or when the session would not list them.
  models?: ModelOption[];
  modelsError?: string;
  // What a card on its tier may ask for: the efforts every tier model takes.
  tierEfforts?: Effort[];
  running: boolean;
  // The chain running, and where in it (the card's index in its session): the lanes mark that card.
  runningAt?: { chainId: string; session: number; index: number };
  storageError?: string;
  // How many changes could not be saved so far: each rise is said aloud, even when storageError reads the same as before.
  unsaved?: number;
};

// The run's chat, kept apart from the chains state so a new message never re-renders the chain being edited.
// `cache` only while a card waits for the user: that is when the time it stays warm is the user's to spend.
export type ChatView = TalkSnapshot & { title?: string; cache?: CacheClock };
export type ChatMessage =
  // Everything: on "ready", and when a run starts.
  | { type: "chat"; chat: ChatView; entries: Entry[] }
  | { type: "chatAppend"; entries: Entry[] }
  | { type: "chatUpdate"; chat: ChatView };

const ID = /^[a-z0-9-]{1,64}$/;
const KEYS: Record<EditorMessage["type"], readonly string[]> = {
  ready: [],
  save: ["chain"],
  delete: ["id"],
  run: ["id"],
  refreshPalette: [],
  openMskills: [],
  checkEnvironment: [],
  chatSend: ["text"],
  chatWithdraw: ["id"],
  chatPause: [],
  chatContinue: [],
  chatAnswer: ["id", "picks"],
  chatStop: [],
};

const MAX_QUESTIONS = 4;
const MAX_LABEL = 1000;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

// A question has at most four parts; each pick holds offered labels (checked against the open question later) and maybe Other text.
function parsePicks(v: unknown): Pick[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_QUESTIONS) return undefined;
  const picks: Pick[] = [];
  for (const p of v) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) return undefined;
    const { picked, other, ...extra } = p as Record<string, unknown>;
    if (Object.keys(extra).length > 0 || !Array.isArray(picked) || !picked.every((l) => isText(l, MAX_LABEL))) return undefined;
    if (other !== undefined && !isText(other, MAX_INPUT_CHARS)) return undefined;
    picks.push({ picked: [...picked], ...(other !== undefined ? { other } : {}) });
  }
  return picks;
}

export function parseEditorMessage(v: unknown): EditorMessage | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m.type !== "string" || !Object.hasOwn(KEYS, m.type)) return undefined;
  const type = m.type as EditorMessage["type"];
  const keys = Object.keys(m).filter((k) => k !== "type");
  if (keys.length !== KEYS[type].length || !keys.every((k) => KEYS[type].includes(k))) return undefined;
  switch (type) {
    case "save": {
      const chain = parseChain(m.chain);
      return typeof chain === "string" ? undefined : { type, chain };
    }
    case "delete":
    case "run":
    case "chatWithdraw":
      return typeof m.id === "string" && ID.test(m.id) ? { type, id: m.id } : undefined;
    case "chatSend":
      return isText(m.text, MAX_INPUT_CHARS) && m.text.trim() !== "" ? { type, text: m.text } : undefined;
    case "chatAnswer": {
      const picks = parsePicks(m.picks);
      return typeof m.id === "string" && ID.test(m.id) && picks ? { type, id: m.id, picks } : undefined;
    }
    default:
      return { type };
  }
}
