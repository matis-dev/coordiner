import { basename, dirname, join } from "node:path";
import { plain } from "./text.ts";

export type Exec = (file: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;

export type RepoInfo = { root: string; dirty: string[] };
export type WorktreeResult = { ok: true; path: string; branch: string } | { ok: false; reason: string; detail?: string };

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export async function inspectRepo(dir: string, exec: Exec): Promise<RepoInfo> {
  let root;
  try {
    root = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir })).stdout.trim();
  } catch {
    throw new Error(`${dir} is not a git repository, or git is unavailable. Run git init there and make a first commit, then start again.`);
  }
  // Every run's worktree starts from HEAD, which a fresh `git init` does not have yet.
  const hasCommit = await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir }).then(() => true, () => false);
  if (!hasCommit) throw new Error(`${root} has no commits yet. Make a first commit, then start again; each run's worktree starts from it.`);
  try {
    const status = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
    return { root, dirty: status.split("\n").filter((line) => line.trim() !== "") };
  } catch {
    throw new Error(`${dir} is not a git repository, or git is unavailable.`);
  }
}

// Undefined when git could not say, so the caller never offers to remove a worktree it is unsure about.
export const worktreeClean = (path: string, exec: Exec): Promise<boolean | undefined> =>
  exec("git", ["status", "--porcelain"], { cwd: path }).then((r) => r.stdout.trim() === "", () => undefined);

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export type Worktree = { root: string; path: string; branch: string };

// The output lines for a run that left its worktree unchanged; undefined when a file changed or git could not say.
export async function removalNote(worktree: Worktree, exec: Exec): Promise<string[] | undefined> {
  if ((await worktreeClean(worktree.path, exec)) !== true) return undefined;
  const commands = removalCommands(worktree.root, worktree.path, worktree.branch);
  if (!commands) return [`Nothing changed in ${plain(worktree.path)}. Its path has a control character, so no command is printed; remove it with git worktree remove and its branch ${plain(worktree.branch)} with git branch -D.`];
  return [`Nothing changed in ${worktree.path}. To remove the worktree and its branch, run:`, ...commands.map((command) => `  ${command}`)];
}

// Shown for the user to run, never run here. A path with a control character, a newline included, is not printed as a command at all.
export function removalCommands(root: string, path: string, branch: string): string[] | undefined {
  if ([root, path, branch].some((value) => /[\u0000-\u001f\u007f-\u009f]/.test(value))) return undefined;
  return [`git -C ${quote(root)} worktree remove ${quote(path)}`, `git -C ${quote(root)} branch -D ${quote(branch)}`];
}

// Git is called with argument arrays only, and the slug is re-checked here so a caller bug cannot reach git as an option or a path.
export async function addWorktree(root: string, slug: string, deps: { exec: Exec; exists(path: string): Promise<boolean> }): Promise<WorktreeResult> {
  if (!SLUG.test(slug)) return { ok: false, reason: "The story name is not a safe branch name." };
  const branch = `coordiner/${slug}`;
  const path = join(dirname(root), `${basename(root)}.coordiner`, slug);

  const branchExists = await deps.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).then(() => true, () => false);
  if (branchExists) return { ok: false, reason: `The branch ${branch} already exists. Remove it first.` };
  if (await deps.exists(path)) return { ok: false, reason: `${path} already exists. Remove it first.` };

  try {
    await deps.exec("git", ["worktree", "add", "-b", branch, "--", path, "HEAD"], { cwd: root });
  } catch (error) {
    return { ok: false, reason: "Git could not create the worktree.", detail: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, path, branch };
}

// More new files than this usually means a dependency folder is missing from .gitignore; raise it if a real story trips it.
export const MAX_NEW_FILES = 200;

export type ReviewPrep = { kind: "no-changes" } | { kind: "ready"; marked: number } | { kind: "too-many"; count: number } | { kind: "failed"; detail: string };

// The uncommitted review reads `git diff HEAD`, which skips untracked files; intent-to-add makes them part of the diff without staging their content.
// File names are model-chosen: `--` stops option parsing, `--literal-pathspecs` stops `:!name` or globs from excluding another file.
export async function prepareReview(path: string, exec: Exec): Promise<ReviewPrep> {
  try {
    if ((await exec("git", ["status", "--porcelain"], { cwd: path })).stdout.trim() === "") return { kind: "no-changes" };
    const files = (await exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: path })).stdout.split("\0").filter((f) => f !== "");
    if (files.length > MAX_NEW_FILES) return { kind: "too-many", count: files.length };
    if (files.length > 0) await exec("git", ["--literal-pathspecs", "add", "--intent-to-add", "--", ...files], { cwd: path });
    return { kind: "ready", marked: files.length };
  } catch (error) {
    return { kind: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}
