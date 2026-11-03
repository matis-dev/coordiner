import { MAX_INPUT_CHARS, parseChain, TEMPLATES, type Chain } from "./chains.ts";
import type { CacheClock, Pick, TurnClock } from "./chat-logic.ts";
import type { Outcome } from "./run.ts";
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
  // Templates the user removed stay out of the rail and Start… until restored; the ids are checked against the templates.
  | { type: "removeTemplate"; id: string }
  | { type: "restoreTemplate"; id: string }
  | { type: "restoreTemplates" }
  // The run's chat
  | { type: "chatSend"; text: string }
  | { type: "chatWithdraw"; id: string }
  | { type: "chatPause" }
  | { type: "chatContinue" }
  | { type: "chatAnswer"; id: string; picks: Pick[] }
  | { type: "chatStop" }
  // A command shown in the transcript, copied for the user to run themselves; coordiner never runs it.
  | { type: "chatCopyText"; text: string }
  // After the run: the clipboard text and the worktree are the extension's own, never taken from the page.
  | { type: "chatCopyResume" }
  | { type: "chatNextChain" }
  | { type: "chatMergeSteps" };

export type EditorState = {
  type: "state";
  // The templates the rail shows: none while m-skills is known to be missing, and none the user removed.
  templates: readonly Chain[];
  // The ids of the templates the user removed, for Restore; none while m-skills is known to be missing.
  removedTemplates: readonly string[];
  chains: readonly Chain[];
  // undefined while discovery runs or after it failed
  palette?: PaletteEntry[];
  paletteError?: string;
  mskills?: boolean;
  // Listed with the skills; undefined while discovery runs or when the session would not list them.
  models?: ModelOption[];
  modelsError?: string;
  // The model a card on Default runs on; undefined when the session names none.
  defaultModel?: string;
  running: boolean;
  // The chain running, and where in it (the card's index in its session): the lanes mark that card.
  // `waiting`: the card waits for the user, or asked them something.
  runningAt?: { chainId: string; session: number; index: number; waiting?: boolean };
  // The running chain's sessions up to `through` have started: their cards keep their order until the run ends.
  locked?: { chainId: string; through: number };
  storageError?: string;
  // How many changes could not be saved so far: each rise is said aloud, even when storageError reads the same as before.
  unsaved?: number;
};

// The run's chat, kept apart from the chains state so a new message never re-renders the chain being edited.
// `cache` only while a card waits for the user: that is when the time it stays warm is the user's to spend. `ending` once the run
// has ended: how it ended, with the reason a halt or failure gave. `turn` only while a card runs: how long, and its last activity.
export type Ending = { status: Outcome["status"]; reason?: string };
// `line`: the chain's card labels, by session, for the line of stations in the chat's head. `freeChat`: a chat opened on its own
// (Open Chat), with no run before it.
export type ChatView = TalkSnapshot & { title?: string; cache?: CacheClock; turn?: TurnClock; ending?: Ending; line?: string[][]; freeChat?: true };
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
  removeTemplate: ["id"],
  restoreTemplate: ["id"],
  restoreTemplates: [],
  chatSend: ["text"],
  chatWithdraw: ["id"],
  chatPause: [],
  chatContinue: [],
  chatAnswer: ["id", "picks"],
  chatStop: [],
  chatCopyText: ["text"],
  chatCopyResume: [],
  chatNextChain: [],
  chatMergeSteps: [],
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
    case "removeTemplate":
    case "restoreTemplate":
      return typeof m.id === "string" && TEMPLATES.some((t) => t.id === m.id) ? { type, id: m.id } : undefined;
    case "chatSend":
    case "chatCopyText":
      return isText(m.text, MAX_INPUT_CHARS) && m.text.trim() !== "" ? { type, text: m.text } : undefined;
    case "chatAnswer": {
      const picks = parsePicks(m.picks);
      return typeof m.id === "string" && ID.test(m.id) && picks ? { type, id: m.id, picks } : undefined;
    }
    default:
      return { type };
  }
}
