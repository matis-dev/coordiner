import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clip, plain } from "./text.ts";

describe("plain", () => {
  it("strips escape and other control characters but keeps newlines", () => {
    assert.equal(plain("a\u001b[31mb\u0007c\nd"), "a[31mbc\nd");
  });
});

describe("clip", () => {
  it("leaves short text alone and cuts long text with an ellipsis", () => {
    assert.equal(clip("abc", 3), "abc");
    assert.equal(clip("abcd", 3), "abc…");
  });
});
