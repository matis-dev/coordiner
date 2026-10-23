import { rmSync } from "node:fs";
import { build, type BuildOptions } from "esbuild";

// The packaged extension ships dist/ without node_modules, so every dependency is bundled; only vscode comes from the editor.
// The chains webview imports chain-edit, chains, editor-logic and chat-logic from dist/ (media/editor.js), so each stays an
// entry point; splitting keeps one copy of the code they share.
export const options: BuildOptions = {
  entryPoints: ["src/extension.ts", "src/chain-edit.ts", "src/chains.ts", "src/editor-logic.ts", "src/chat-logic.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "es2024",
  external: ["vscode"],
  sourcemap: true,
};

if (import.meta.main) {
  rmSync("dist", { recursive: true, force: true });
  await build(options);
}
