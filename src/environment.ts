import { delimiter, join } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { MSKILLS_URL } from "./chains.ts";
import { said } from "./images.ts";
import type { TurnRequest, TurnResult } from "./session.ts";
import { mskillsPresent, type ModelOption } from "./skills.ts";

export type CheckResult = { name: string; ok: boolean; detail: string };

export type CheckDeps = {
  runTurn(request: TurnRequest): Promise<TurnResult>;
  nodeVersion(env: Record<string, string | undefined>): Promise<string>;
  claude: ClaudeLookup;
  // The models a session in `cwd` offers, and its default model's id; an error says why they could not be listed.
  listModels(claudePath: string): Promise<{ ok: true; options: readonly ModelOption[]; defaultModel?: string } | { ok: false; error: string }>;
  cwd: string;
  env: Record<string, string | undefined>;
  canUseTool: CanUseTool;
};

// Editors started from a launcher (e.g. a flatpak) often lack the user's Node on PATH; the setting adds it for sessions.
export function sessionEnv(processEnv: NodeJS.ProcessEnv, extraPath: string): Record<string, string | undefined> {
  if (extraPath === "") return { ...processEnv };
  return { ...processEnv, PATH: [extraPath, processEnv.PATH].filter(Boolean).join(delimiter) };
}

export type ClaudeLookup = { ok: true; path: string } | { ok: false; error: string };

export function bundledClaudePath(extensionPath: string | undefined, platform: NodeJS.Platform): string | undefined {
  return extensionPath && join(extensionPath, "resources", "native-binary", platform === "win32" ? "claude.exe" : "claude");
}

// The packaged extension does not ship the SDK's platform binary, so sessions run the Claude Code the user installed:
// the configured path, else the first `claude` on the sessions' PATH, else the native installer's ~/.local/bin,
// else the binary the Claude Code editor extension bundles. The editor resolves that extension's current folder,
// so it survives the extension's updates, unlike a ~/.local/bin link into an older version's folder.
// Without one the SDK would fall back to the binary it lacks, so callers stop on a failed lookup.
export async function findClaude(configured: string, env: Record<string, string | undefined>, home: string, isExecutable: (path: string) => Promise<boolean>, bundled?: string): Promise<ClaudeLookup> {
  const candidates = configured !== ""
    ? [configured]
    : [...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "claude")), join(home, ".local", "bin", "claude"), ...(bundled ? [bundled] : [])];
  for (const candidate of candidates) if (await isExecutable(candidate)) return { ok: true, path: candidate };
  return {
    ok: false,
    error: configured !== ""
      ? `coordiner.claudePath is ${configured}, which is not an executable file. Fix: set coordiner.claudePath to the full path of claude.`
      : "Claude Code was not found on PATH, in ~/.local/bin, or in the Claude Code extension. Fix: install Claude Code, or set coordiner.claudePath to the full path of claude.",
  };
}

const PING = "Reply with OK. Do not use any tools.";

export async function checkEnvironment(deps: CheckDeps): Promise<CheckResult[]> {
  const { claude, env } = deps;
  const results: CheckResult[] = claude.ok
    ? [{ name: "claude executable", ok: true, detail: claude.path }, ...(await sessionChecks(deps, claude.path))]
    : [
        { name: "claude executable", ok: false, detail: claude.error },
        ...["default model", "models", "model switch on resume"].map((name) => ({ name, ok: false, detail: "not run: no claude executable." })),
      ];

  try {
    results.push({ name: "node on PATH", ok: true, detail: await deps.nodeVersion(env) });
  } catch {
    results.push({ name: "node on PATH", ok: false, detail: "node was not found. Fix: coordiner.extraPath (the folder that contains node)." });
  }
  return results;
}

async function sessionChecks(deps: CheckDeps, claudePath: string): Promise<CheckResult[]> {
  const { cwd, env, canUseTool } = deps;
  const turn = (request: Partial<TurnRequest>) => deps.runTurn({ prompt: said(PING), cwd, env, claudePath, canUseTool, maxTurns: 1, requiredCommands: [], ...request });

  // No model asked for: the session runs its own default, as a card left on Default does when the models cannot be listed.
  const first = await turn({});
  const results: CheckResult[] = [{ name: "default model", ok: first.ok, detail: first.ok ? `session ran ${first.model}` : `${first.error} Fix: run claude in a terminal and check it signs in.` }];

  const listed = await deps.listModels(claudePath);
  results.push(
    listed.ok
      ? { name: "models", ok: true, detail: listed.options.length > 0 ? listed.options.map((o) => o.label).join(", ") : "none listed; cards run on the default model" }
      : { name: "models", ok: false, detail: `${listed.error} Cards then run on the default model, unchecked.` },
  );

  // m-skills is recommended, not required: its absence is reported, never counted as a failure.
  if (first.ok) {
    results.push({
      name: "m-skills",
      ok: true,
      detail: mskillsPresent(first.commands) ? "installed" : `not installed. With it you get the starter chains, and cards that take their model and effort from the step before: ${MSKILLS_URL}`,
    });
  }

  // A step's suggestion switches the model of a session it resumes.
  const other = listed.ok ? listed.options.find((o) => o.id !== (first.ok ? first.model : listed.defaultModel)) : undefined;
  if (!first.ok) results.push({ name: "model switch on resume", ok: false, detail: "not run: the first session did not start." });
  else if (!other) results.push({ name: "model switch on resume", ok: true, detail: "not run: the session offers no second model to switch to." });
  else {
    const result = await turn({ model: other.id, resume: first.sessionId });
    results.push({
      name: "model switch on resume",
      ok: result.ok,
      detail: result.ok ? `resumed on ${result.model}` : `${result.error} A step's suggested model cannot take over its session.`,
    });
  }
  return results;
}
