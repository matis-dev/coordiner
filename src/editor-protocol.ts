import { parseChain, type Chain } from "./chains.ts";
import type { PaletteEntry } from "./skills.ts";

// Messages from the webview are untrusted input: each type has an exact set of keys, and anything else is dropped.
export type EditorMessage =
  | { type: "ready" }
  | { type: "save"; chain: Chain }
  | { type: "delete"; id: string }
  | { type: "run"; id: string }
  | { type: "refreshPalette" }
  | { type: "openMskills" }
  | { type: "checkEnvironment" };

export type EditorState = {
  type: "state";
  templates: readonly Chain[];
  chains: readonly Chain[];
  // undefined while discovery runs or after it failed
  palette?: PaletteEntry[];
  paletteError?: string;
  mskills?: boolean;
  running: boolean;
  storageError?: string;
};

const ID = /^[a-z0-9-]{1,64}$/;
const KEYS: Record<EditorMessage["type"], readonly string[]> = {
  ready: [],
  save: ["chain"],
  delete: ["id"],
  run: ["id"],
  refreshPalette: [],
  openMskills: [],
  checkEnvironment: [],
};

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
      return typeof m.id === "string" && ID.test(m.id) ? { type, id: m.id } : undefined;
    default:
      return { type };
  }
}
