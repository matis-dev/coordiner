import { basename, dirname, join } from "node:path";
import { plain } from "./text.ts";

export type Exec = (file: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;

export type RepoInfo = { root: string; dirty: string[] };
// A folder that is not a repository yet, or has no commits, is reported rather than thrown, so the caller can offer to set it up.
// Any other failure (git missing, a repository git will not open under safe.directory) is not offered git init.
export type RepoCheck = ({ kind: "ready" } & RepoInfo) | { kind: "no-repo" } | { kind: "no-commits"; root: string } | { kind: "failed"; detail: string };
export type WorktreeResult = { ok: true; path: string; branch: string } | { ok: false; reason: string; detail?: string };

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
// A session id as resume takes it; also the check on one read back from a journal.
export const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;

const detailOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function inspectRepo(dir: string, exec: Exec): Promise<RepoCheck> {
  let root;
  try {
    // LC_ALL=C keeps git's message in English, so "not a git repository" can be told apart from every other failure.
    root = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, env: { ...process.env, LC_ALL: "C" } })).stdout.trim();
  } catch (error) {
    const detail = detailOf(error);
    return detail.includes("not a git repository") ? { kind: "no-repo" } : { kind: "failed", detail };
  }
  // Every run's worktree starts from HEAD, which a fresh `git init` does not have yet.
  const hasCommit = await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: dir }).then(() => true, () => false);
  if (!hasCommit) return { kind: "no-commits", root };
  try {
    const status = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
    return { kind: "ready", root, dirty: status.split("\n").filter((line) => line.trim() !== "") };
  } catch {
    throw new Error(`${dir} is not a git repository, or git is unavailable.`);
  }
}

export type GitStep = { ok: true } | { ok: false; detail: string };

const step = (run: Promise<unknown>): Promise<GitStep> => run.then(() => ({ ok: true }) as const, (error) => ({ ok: false, detail: detailOf(error) }));

// Run only after the user agreed to it.
export const initRepo = (dir: string, exec: Exec): Promise<GitStep> => step(exec("git", ["init"], { cwd: dir }));

export type FileList = { kind: "files"; files: string[] } | { kind: "too-many" } | { kind: "failed"; detail: string };

// Every file a first commit would take, by name: what is staged, and each untracked file .gitignore lets through.
// A listing too big for exec's output buffer is far past MAX_NEW_FILES, so it is reported as too many rather than as git's error.
export async function uncommitted(root: string, exec: Exec): Promise<FileList> {
  let stdout;
  try {
    ({ stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root }));
  } catch (error) {
    return (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? { kind: "too-many" } : { kind: "failed", detail: detailOf(error) };
  }
  const files = stdout.split("\0").filter((file) => file !== "");
  return files.length > MAX_NEW_FILES ? { kind: "too-many" } : { kind: "files", files };
}

// Run only after the user agreed to it. With no files it is an empty commit, which is all a run's worktree needs to start from.
export const firstCommit = (root: string, withFiles: boolean, exec: Exec): Promise<GitStep> =>
  step(
    (async () => {
      if (withFiles) await exec("git", ["add", "--all"], { cwd: root });
      await exec("git", ["commit", "--allow-empty", "-m", "Initial commit"], { cwd: root });
    })(),
  );

export type SetupPrompt = { kind: "init"; folder: string } | { kind: "empty-commit"; root: string } | { kind: "commit-files"; root: string; files: string[] };
export type RepoSetup = { kind: "ready"; repo: RepoInfo } | { kind: "cancelled" } | { kind: "failed"; reason: string; detail?: string };

// Every run's worktree starts from a commit. A folder without one is offered git init and a first commit, each made only once `ask` agrees, and the run carries on.
export async function setUpRepo(folder: string, deps: { exec: Exec; ask(prompt: SetupPrompt): Promise<boolean>; log(line: string): void }): Promise<RepoSetup> {
  let check = await inspectRepo(folder, deps.exec);
  let agreed = false;
  if (check.kind === "no-repo") {
    if (!(await deps.ask({ kind: "init", folder }))) return { kind: "cancelled" };
    const init = await initRepo(folder, deps.exec);
    if (!init.ok) return { kind: "failed", reason: "git init failed. Is git installed?", detail: init.detail };
    deps.log(`Initialized a git repository in ${folder}`);
    agreed = true;
    check = await inspectRepo(folder, deps.exec);
  }
  if (check.kind === "no-commits") {
    const listed = await uncommitted(check.root, deps.exec);
    if (listed.kind === "too-many") {
      return { kind: "failed", reason: `More than ${MAX_NEW_FILES} files are not committed yet, which usually means a dependency folder is missing from .gitignore. Add it, or make the first commit yourself, then start again.` };
    }
    if (listed.kind === "failed") return { kind: "failed", reason: "Git could not list the files for the first commit.", detail: listed.detail };
    const { files } = listed;
    // Agreeing to git init covers an empty first commit; files are always shown before they are committed.
    if (files.length > 0 || !agreed) {
      const prompt: SetupPrompt = files.length > 0 ? { kind: "commit-files", root: check.root, files } : { kind: "empty-commit", root: check.root };
      if (!(await deps.ask(prompt))) return { kind: "cancelled" };
    }
    const commit = await firstCommit(check.root, files.length > 0, deps.exec);
    if (!commit.ok) return { kind: "failed", reason: "The first commit failed. If git asks who you are, set user.name and user.email, then start again.", detail: commit.detail };
    deps.log(`Made the first commit in ${check.root}`);
    check = await inspectRepo(folder, deps.exec);
  }
  if (check.kind === "failed") return { kind: "failed", reason: `Git could not open ${plain(folder)} as a repository. Is git installed?`, detail: check.detail };
  if (check.kind !== "ready") return { kind: "failed", reason: `${plain(folder)} still has no commit to start from.` };
  return { kind: "ready", repo: check };
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

// The line that takes over a session by hand, for the user to paste. None for a path with a control character, or a session id
// that is not the plain id claude gives.
export function resumeCommand(path: string, sessionId: string): string | undefined {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path) || !SESSION_ID.test(sessionId)) return undefined;
  return `cd ${quote(path)} && claude --resume ${sessionId}`;
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
