import { randomUUID } from "node:crypto";
import { decodeImage, MAX_HELD_IMAGES, type ImageRef } from "./images.ts";

// The images the open chat holds, in memory only: what is attached and not sent yet, and what was sent, so Open can show it. The
// page and the journal see only each image's ref; its data stays here until the chat lets it go.
export class ImageStore {
  private readonly held = new Map<string, { ref: ImageRef; data: string }>();
  private readonly dropped: (ids: string[]) => void;
  private readonly newId: () => string;

  // `dropped` hears every image let go, so the page can take its chip away.
  constructor(dropped: (ids: string[]) => void = () => undefined, newId: () => string = randomUUID) {
    this.dropped = dropped;
    this.newId = newId;
  }

  add(name: string, data: string): { ok: true; ref: ImageRef } | { ok: false; reason: string } {
    const decoded = decodeImage(name, data);
    if (!decoded.ok) return decoded;
    if (this.held.size >= MAX_HELD_IMAGES) return { ok: false, reason: `This chat already holds ${MAX_HELD_IMAGES} images, the most one conversation takes at full size.` };
    const ref: ImageRef = { id: this.newId(), name: decoded.name, bytes: decoded.bytes, mediaType: decoded.mediaType };
    this.held.set(ref.id, { ref, data });
    return { ok: true, ref };
  }

  ids(): string[] {
    return [...this.held.keys()];
  }

  has(id: string): boolean {
    return this.held.has(id);
  }

  ref(id: string): ImageRef | undefined {
    return this.held.get(id)?.ref;
  }

  data(id: string): string | undefined {
    return this.held.get(id)?.data;
  }

  release(ids: Iterable<string>): void {
    const gone = [...new Set(ids)].filter((id) => this.held.delete(id));
    if (gone.length > 0) this.dropped(gone);
  }

  // Keeps only these, letting go of the rest.
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids);
    this.release([...this.held.keys()].filter((id) => !keep.has(id)));
  }

  clear(): void {
    this.release([...this.held.keys()]);
  }
}
