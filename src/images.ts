import { plain } from "./text.ts";

// Images the user attaches to a message. The extension holds their data (ImageStore); everything else names them by id, so the
// chat's state, the queue and the journal never carry the data itself. Also loaded by the webview (through chat-logic), so this
// module takes no runtime imports beyond text.ts.

// The types Claude takes (platform.claude.com/docs/en/build-with-claude/vision, read 2026-11-07). Never SVG: it is markup.
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const isImageType = (v: unknown): v is ImageType => IMAGE_TYPES.includes(v as ImageType);

// Per image: 5 MB base64-encoded, the lowest per-image limit among the platforms Claude runs on (Bedrock and Google-managed
// Vertex; the Claude API itself takes 10 MB). Same source as above.
export const MAX_IMAGE_CHARS = 5_000_000;
export const MAX_IMAGE_BYTES = (MAX_IMAGE_CHARS / 4) * 3;
// Per message, a choice: enough for a ticket and its screenshots.
export const MAX_IMAGES = 5;
// Per chat: a request with more than 20 images, earlier turns included, gets a stricter size limit for every image in it.
export const MAX_HELD_IMAGES = 20;
export const MAX_IMAGE_NAME = 255;

export type ImageRef = { id: string; name: string; bytes: number; mediaType: ImageType };
// The file extension each type is saved and opened with.
export const IMAGE_EXTENSIONS: Readonly<Record<ImageType, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
// An image saved on a card is named by the SHA-256 of its bytes, so a copied chain shares the file and a file cannot pass for another.
export const CARD_IMAGE_ID = /^[0-9a-f]{64}$/;
// What the journal keeps of an image: its chip, never its data. A chip in the chat has the id too while the chat holds it.
export type ImageMeta = Omit<ImageRef, "id">;
export type ImageChip = ImageMeta & { id?: string };
// What the user says in one go: text, and the images that go with it.
export type Said = { text: string; images: readonly ImageRef[] };

export const said = (text: string, images: readonly ImageRef[] = []): Said => ({ text, images });
export const isEmpty = (s: Said): boolean => s.text.trim() === "" && s.images.length === 0;
// Two messages as one, the first in front: texts joined by a blank line (an empty one adds nothing), images in order.
export const joinSaid = (a: Said, b: Said): Said => ({ text: [a.text, b.text].filter((t) => t !== "").join("\n\n"), images: [...a.images, ...b.images] });

const SIGNATURES: ReadonlyArray<[ImageType, (b: Uint8Array) => boolean]> = [
  ["image/png", (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a"],
  ["image/webp", (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP"],
];
const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.slice(from, to));

// The type an image's first bytes say it is; what the page or the file name claim is never asked.
export const sniff = (head: Uint8Array): ImageType | undefined => SIGNATURES.find(([, test]) => test(head))?.[0];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type Decoded = { ok: true; name: string; bytes: number; mediaType: ImageType } | { ok: false; reason: string };

// Checks an image as it arrives: strict base64 within the size limit, of a type Claude takes. Only the first bytes are decoded; the
// data goes on to the session as it came. `name` is only ever shown.
export function decodeImage(name: string, data: string): Decoded {
  const shown = plain(name).trim().slice(0, MAX_IMAGE_NAME) || "image";
  if (data.length > MAX_IMAGE_CHARS) return { ok: false, reason: `${shown} is larger than ${sizeLabel(MAX_IMAGE_BYTES)}.` };
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, reason: `${shown} could not be read as an image.` };
  const head = Uint8Array.from(atob(data.slice(0, 16)), (c) => c.charCodeAt(0));
  const mediaType = sniff(head);
  if (!mediaType) return { ok: false, reason: `${shown} is not a PNG, JPEG, GIF or WebP image.` };
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { ok: true, name: shown, bytes: (data.length / 4) * 3 - padding, mediaType };
}

export const sizeLabel = (bytes: number): string =>
  bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${Math.round(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
