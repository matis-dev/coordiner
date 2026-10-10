import type { Exec } from "./worktree.ts";

const LOCKFILES: Array<[file: string, argv: string[]]> = [
  ["package-lock.json", ["npm", "ci"]],
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
];

export type SetupResult = { ok: true } | { ok: false; message: string; detail: string };

export const proposeSetup = (fileNames: string[]): string[] | undefined => LOCKFILES.find(([file]) => fileNames.includes(file))?.[1];

// argv runs without a shell; the caller shows it to the user for confirmation before the first run.
export async function runSetup(argv: string[], cwd: string, env: Record<string, string | undefined>, exec: Exec): Promise<SetupResult> {
  const [file, ...args] = argv;
  try {
    await exec(file!, args, { cwd, env });
    return { ok: true };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return {
      ok: false,
      message: `Setup failed: "${argv.join(" ")}" did not finish. Check that it runs in a terminal, and that coordiner.extraPath holds the folder of the tool it needs.`,
      detail: (typeof stderr === "string" && stderr !== "" ? stderr : String(error)).slice(-500),
    };
  }
}
