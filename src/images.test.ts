import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeImage, isEmpty, joinSaid, MAX_IMAGE_BYTES, MAX_IMAGE_CHARS, said, sizeLabel, sniff, type ImageRef } from "./images.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const b64 = (bytes: number[] | string, pad = 0): string => Buffer.concat([Buffer.from(bytes as never), Buffer.alloc(pad)]).toString("base64");
const bytes = (s: string | number[]) => Uint8Array.from(Buffer.from(s as never));
const ref = (id: string): ImageRef => ({ id, name: `${id}.png`, bytes: 1, mediaType: "image/png" });

describe("sniff", () => {
  it("reads each type Claude takes from its first bytes", () => {
    assert.equal(sniff(bytes([...PNG, 0, 0, 0, 0])), "image/png");
    assert.equal(sniff(bytes([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniff(bytes("GIF87a......")), "image/gif");
    assert.equal(sniff(bytes("GIF89a......")), "image/gif");
    assert.equal(sniff(bytes("RIFF\0\0\0\0WEBP")), "image/webp");
  });

  it("refuses markup, other image types, documents and short input", () => {
    assert.equal(sniff(bytes('<svg xmlns="http://www.w3.org/2000/svg">')), undefined);
    assert.equal(sniff(bytes("\0\0\0\x18ftypheic")), undefined);
    assert.equal(sniff(bytes("%PDF-1.7")), undefined);
    assert.equal(sniff(bytes("RIFF\0\0\0\0WAVE")), undefined);
    assert.equal(sniff(new Uint8Array()), undefined);
    assert.equal(sniff(bytes([0x89, 0x50, 0x4e])), undefined);
  });
});

describe("decodeImage", () => {
  it("takes a PNG and counts its bytes from the base64 length, padding included", () => {
    assert.deepEqual(decodeImage("shot.png", b64(PNG, 4)), { ok: true, name: "shot.png", bytes: 12, mediaType: "image/png" });
    assert.deepEqual(decodeImage("shot.png", b64(PNG, 5)), { ok: true, name: "shot.png", bytes: 13, mediaType: "image/png" });
    assert.deepEqual(decodeImage("shot.png", b64(PNG, 6)), { ok: true, name: "shot.png", bytes: 14, mediaType: "image/png" });
  });

  it("takes an image of exactly the size limit and refuses one character more", () => {
    const head = b64(PNG, 4);
    const atLimit = head + "A".repeat(MAX_IMAGE_CHARS - head.length);
    const ok = decodeImage("big.png", atLimit);
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.bytes, MAX_IMAGE_BYTES);
    assert.match((decodeImage("big.png", `${atLimit}AAAA`) as { reason: string }).reason, /big\.png is larger than 3\.8 MB/);
  });

  it("refuses base64 that is not strict: whitespace, url-safe letters, stray padding, a partial group, nothing", () => {
    const good = b64(PNG, 4);
    for (const data of [`${good.slice(0, 8)} ${good.slice(8)}`, good.replace(/[+/]/g, "-") + "-_-_", `=${good.slice(1)}`, good.slice(0, -1), ""]) {
      assert.equal(decodeImage("x.png", data).ok, false, JSON.stringify(data));
    }
  });

  it("refuses an SVG sent under a PNG name: the bytes decide, not the name", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    assert.deepEqual(decodeImage("innocent.png", svg), { ok: false, reason: "innocent.png is not a PNG, JPEG, GIF or WebP image." });
  });

  it("keeps a path-like name only as text to show, without control characters, and names a nameless image", () => {
    const d = decodeImage("../../\u001b[31mevil.png", b64(PNG, 4));
    assert.equal(d.ok && d.name, "../../[31mevil.png");
    assert.equal(decodeImage("  ", b64(PNG, 4)).ok && (decodeImage("  ", b64(PNG, 4)) as { name: string }).name, "image");
    assert.equal((decodeImage("x".repeat(400), b64(PNG, 4)) as { name: string }).name.length, 255);
  });
});

describe("Said", () => {
  it("joins two messages: texts by a blank line, an empty text adding nothing, images in order", () => {
    assert.deepEqual(joinSaid(said("a", [ref("i1")]), said("b", [ref("i2")])), said("a\n\nb", [ref("i1"), ref("i2")]));
    assert.deepEqual(joinSaid(said("", [ref("i1")]), said("/skill")), said("/skill", [ref("i1")]));
  });

  it("is empty with neither text nor images", () => {
    assert.equal(isEmpty(said("  ")), true);
    assert.equal(isEmpty(said("", [ref("i1")])), false);
    assert.equal(isEmpty(said("hi")), false);
  });
});

describe("sizeLabel", () => {
  it("says bytes, kilobytes or megabytes", () => {
    assert.equal(sizeLabel(999), "999 B");
    assert.equal(sizeLabel(240_400), "240 KB");
    assert.equal(sizeLabel(1_250_000), "1.3 MB");
  });
});
