import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { editorHtml } from "./editor-html.ts";

const input = { cspSource: "vscode-resource:", nonce: "abc123", scriptUri: "vscode-resource:/media/editor.js", styleUri: "vscode-resource:/media/editor.css", chainEditUri: "vscode-resource:/dist/chain-edit.js" };
const html = editorHtml(input);
const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;

describe("editorHtml", () => {
  it("allows scripts only by nonce or from the extension's own files", () => {
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-abc123' vscode-resource:/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  });

  it("puts the nonce on every script tag", () => {
    const scripts = html.match(/<script\b[^>]*>/g)!;
    assert.equal(scripts.length, 1);
    assert.ok(scripts.every((s) => s.includes('nonce="abc123"')));
  });

  it("renders the status region empty from the start, so the first message is announced", () => {
    assert.match(html, /<div id="status" role="status" class="visually-hidden"><\/div>/);
  });

  it("names the chain list and passes the module path through a data attribute", () => {
    assert.match(html, /<nav id="rail" aria-label="Chains">/);
    assert.match(html, /data-chain-edit="vscode-resource:\/dist\/chain-edit\.js"/);
  });

  it("escapes values placed in attributes", () => {
    const out = editorHtml({ ...input, styleUri: 'x"><script>alert(1)</script>' });
    assert.doesNotMatch(out, /<script>alert/);
    assert.match(out, /x&quot;&gt;&lt;script&gt;/);
  });
});
