import { delimiter } from "node:path";
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

const PING = "Reply with OK. Do not use any tools.";

export async function checkEnvironment(deps: CheckDeps): Promise<CheckResult[]> {
  const { models, cwd, env, canUseTool } = deps;
  const results: CheckResult[] = [];
  const turn = (request: Partial<TurnRequest> & { model: string }) =>
    deps.runTurn({ prompt: PING, cwd, env, canUseTool, maxTurns: 1, requiredCommands: [], ...request });

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

  try {
    results.push({ name: "node on PATH", ok: true, detail: await deps.nodeVersion(env) });
  } catch {
    results.push({ name: "node on PATH", ok: false, detail: "node was not found. Fix: coordiner.extraPath (the folder that contains node)." });
  }
  return results;
}
