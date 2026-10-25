import { delimiter, join } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { MSKILLS_URL } from "./chains.ts";
import type { TurnRequest, TurnResult } from "./session.ts";
import { mskillsPresent } from "./skills.ts";

export type Tier = "strong" | "medium" | "weak";
export type Models = Record<Tier, string>;

export type CheckResult = { name: string; ok: boolean; detail: string };

export type CheckDeps = {
  runTurn(request: TurnRequest): Promise<TurnResult>;
  nodeVersion(env: Record<string, string | undefined>): Promise<string>;
  claude: ClaudeLookup;
  models: Models;
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
        ...["strong tier", "medium tier", "weak tier", "model switch on resume"].map((name) => ({ name, ok: false, detail: "not run: no claude executable." })),
      ];

  try {
    results.push({ name: "node on PATH", ok: true, detail: await deps.nodeVersion(env) });
  } catch {
    results.push({ name: "node on PATH", ok: false, detail: "node was not found. Fix: coordiner.extraPath (the folder that contains node)." });
  }
  return results;
}

async function sessionChecks(deps: CheckDeps, claudePath: string): Promise<CheckResult[]> {
  const { models, cwd, env, canUseTool } = deps;
  const results: CheckResult[] = [];
  const turn = (request: Partial<TurnRequest> & { model: string }) =>
    deps.runTurn({ prompt: PING, cwd, env, claudePath, canUseTool, maxTurns: 1, requiredCommands: [], ...request });

  let strongSession: string | undefined;
  let commands: string[] | undefined;
  for (const tier of ["strong", "medium", "weak"] as const) {
    const result = await turn({ model: models[tier] });
    if (tier === "strong" && result.ok) {
      strongSession = result.sessionId;
      commands = result.commands;
    }
    results.push({
      name: `${tier} tier`,
      ok: result.ok,
      detail: result.ok ? `session ran ${result.model}` : `${models[tier]}: ${result.error} Fix: coordiner.models.${tier}.`,
    });
  }

  // m-skills is recommended, not required: its absence is reported, never counted as a failure.
  if (commands !== undefined) {
    results.push({
      name: "m-skills",
      ok: true,
      detail: mskillsPresent(commands) ? "installed" : `not installed. The shipped templates need it: ${MSKILLS_URL}`,
    });
  }

  if (strongSession === undefined) {
    results.push({ name: "model switch on resume", ok: false, detail: "not run: the strong-tier session did not start." });
  } else {
    const result = await turn({ model: models.weak, resume: strongSession });
    results.push({
      name: "model switch on resume",
      ok: result.ok,
      detail: result.ok ? `strong session resumed on ${result.model}` : `${result.error} Slice 1 needs this: stop and re-plan.`,
    });
  }
  return results;
}
