import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBuiltin } from "node:module";
import { build } from "esbuild";
import { options } from "../build.ts";

// The packaged extension ships dist/ and no node_modules, so whatever dist/ imports at run time must come with the editor.
describe("the bundle", () => {
  it("imports nothing at run time but vscode and node builtins", async () => {
    const result = await build({ ...options, write: false, metafile: true, logLevel: "silent" });
    const leftOver = Object.values(result.metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((i) => i.external && i.path !== "vscode" && !isBuiltin(i.path))
      .map((i) => i.path);
    assert.deepEqual([...new Set(leftOver)], []);
  });

  it("emits the extension and every module the chains webview imports from dist/", async () => {
    const result = await build({ ...options, write: false, metafile: true, logLevel: "silent" });
    const outputs = Object.keys(result.metafile.outputs);
    for (const name of ["extension", "chain-edit", "chains", "editor-logic", "chat-logic"]) assert.ok(outputs.includes(`dist/${name}.js`), name);
  });
});
