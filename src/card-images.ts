import { createHash } from "node:crypto";
import { join } from "node:path";
import { CARD_IMAGE_ID, decodeImage, IMAGE_EXTENSIONS, type ImageRef } from "./images.ts";
import { plain } from "./text.ts";

// The images saved on cards, one file each in the extension's global storage, named by the SHA-256 of its bytes: a chain copied
// with its cards shares the files, the same picture is saved once, and a file changed on disk no longer matches its name and is
// not sent. A card keeps only the ref.

export type CardImageFs = {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
};

const FILE = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export class CardImages {
  private readonly dir: string;
  private readonly fs: CardImageFs;

  constructor(dir: string, fs: CardImageFs) {
    this.dir = dir;
    this.fs = fs;
  }

  fileOf(ref: Pick<ImageRef, "id" | "mediaType">): string {
    return join(this.dir, `${ref.id}.${IMAGE_EXTENSIONS[ref.mediaType]}`);
  }

  // Checks the image as a pasted one is checked, then writes it once, through a temporary file so a half-written one never has the
  // final name.
  async save(name: string, data: string): Promise<{ ok: true; ref: ImageRef } | { ok: false; reason: string }> {
    const decoded = decodeImage(name, data);
    if (!decoded.ok) return decoded;
    const bytes = Buffer.from(data, "base64");
    const ref: ImageRef = { id: sha256(bytes), name: decoded.name, bytes: decoded.bytes, mediaType: decoded.mediaType };
    const file = this.fileOf(ref);
    try {
      await this.fs.mkdir(this.dir);
      const temp = `${file}.${process.pid}.tmp`;
      await this.fs.writeFile(temp, bytes);
      await this.fs.rename(temp, file);
      return { ok: true, ref };
    } catch {
      return { ok: false, reason: `${decoded.name} could not be saved.` };
    }
  }

  // The image's data for a turn; none when its file is gone or no longer matches the hash it is named by.
  async read(ref: Pick<ImageRef, "id" | "mediaType">): Promise<string | undefined> {
    try {
      const bytes = await this.fs.readFile(this.fileOf(ref));
      return sha256(bytes) === ref.id ? Buffer.from(bytes).toString("base64") : undefined;
    } catch {
      return undefined;
    }
  }

  // The data of the card images among a turn's images (named by a hash; the chat's own are skipped). Fails on the first one that
  // cannot be read, naming it: the turn is not sent without it.
  async readAll(images: readonly ImageRef[]): Promise<{ ok: true; data: Map<string, string> } | { ok: false; reason: string }> {
    const data = new Map<string, string>();
    for (const image of images) {
      if (!CARD_IMAGE_ID.test(image.id)) continue;
      const read = await this.read(image);
      if (read === undefined)
        return {
          ok: false,
          reason: `${plain(image.name)}, an image on this card, is gone from Coordiner's storage or changed on disk, so the turn was not sent. Attach it to the card again and start a new run: a run keeps its cards as they were when their session started.`,
        };
      data.set(image.id, read);
    }
    return { ok: true, data };
  }

  // Deletes the saved images no card names any more. Only files this store names are touched; a failure leaves the file for next time.
  async sweep(keep: ReadonlySet<string>): Promise<string[]> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.dir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of names) {
      const id = FILE.exec(name)?.[1];
      if (id === undefined || keep.has(id)) continue;
      try {
        await this.fs.unlink(join(this.dir, name));
        removed.push(id);
      } catch {
        // Kept for the next sweep.
      }
    }
    return removed;
  }
}
