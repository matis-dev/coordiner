import { basename, dirname, join } from "node:path";
import { plain } from "./text.ts";

export type Exec = (file: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined> }) => Promise<{ stdout: string; stderr: string }>;

export type RepoInfo = { root: string; dirty: string[] };
// A folder that is not a repository yet, or has no commits, is reported rather than thrown, so the caller can offer to set it up.
// Any other failure (git missing, a repository git will not open under safe.directory) is not offered git init.
export type RepoCheck = ({ kind: "ready" } & RepoInfo) | { kind: "no-repo" } | { kind: "no-commits"; root: string } | { kind: "failed"; detail: string };
export type WorktreeResult = { ok: true; path: string; branch: string } | { ok: false; reason: string; detail?: string };

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
// A session id as resume takes it; also the check on one read back from a journal. It never starts with a dash, so it cannot
// read as an option to `claude --resume`.
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

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

export type Listed = { path: string; branch: string };
// `main`: the main worktree's path, which is the repo's root even when git is asked from a linked worktree.
export type WorktreeList = { ok: true; main: string; worktrees: Listed[] } | { ok: false; detail: string };

const COORDINER_REF = /^refs\/heads\/(coordiner\/[a-z0-9][a-z0-9-]*)$/;
const COORDINER_BRANCH = /^coordiner\/[a-z0-9][a-z0-9-]*$/;

// The repo's worktrees on a coordiner/<slug> branch, asked from any of its worktrees. The main worktree (always listed first) is
// never one of them, whatever it has checked out. `-z` ends every field with a NUL, so a path with a newline cannot split a record.
export async function listWorktrees(root: string, exec: Exec): Promise<WorktreeList> {
  let stdout;
  try {
    ({ stdout } = await exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root }));
  } catch (error) {
    return { ok: false, detail: detailOf(error) };
  }
  const records: Map<string, string>[] = [new Map()];
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (records.at(-1)!.size > 0) records.push(new Map());
      continue;
    }
    const space = field.indexOf(" ");
    records.at(-1)!.set(space < 0 ? field : field.slice(0, space), space < 0 ? "" : field.slice(space + 1));
  }
  const worktrees = records.slice(1).flatMap((r): Listed[] => {
    const branch = COORDINER_REF.exec(r.get("branch") ?? "")?.[1];
    const path = r.get("worktree");
    return branch && path ? [{ path, branch }] : [];
  });
  return { ok: true, main: records[0]!.get("worktree") || root, worktrees };
}

// What a worktree holds that its removal would lose: uncommitted files, and commits on its branch that the main checkout's HEAD
// does not have. Either is undefined when git could not say, which is never read as none. `landed`: those commits change nothing
// HEAD lacks, as after a squash merge; only ever true.
export type WorktreeState = { changed?: number; ahead?: number; landed?: true };

// Uncommitted files in a checkout; undefined when git could not say.
export const changedFiles = (path: string, exec: Exec): Promise<number | undefined> =>
  exec("git", ["status", "--porcelain"], { cwd: path }).then(
    (r) => r.stdout.split("\n").filter((line) => line.trim() !== "").length,
    () => undefined,
  );

// Merging the branch into HEAD gives HEAD's own tree. A conflict (merge-tree exits 1) or any failure is never read as landed.
async function landed(root: string, branch: string, exec: Exec): Promise<boolean> {
  try {
    const [merged, own] = await Promise.all([
      exec("git", ["merge-tree", "--write-tree", "HEAD", `refs/heads/${branch}`], { cwd: root }),
      exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root }),
    ]);
    const tree = merged.stdout.split("\n")[0]!.trim();
    return /^[0-9a-f]{40,64}$/.test(tree) && tree === own.stdout.trim();
  } catch {
    return false;
  }
}

export async function worktreeState(root: string, worktree: Listed, exec: Exec): Promise<WorktreeState> {
  const changed = changedFiles(worktree.path, exec);
  const ahead = COORDINER_BRANCH.test(worktree.branch)
    ? exec("git", ["rev-list", "--count", `HEAD..refs/heads/${worktree.branch}`], { cwd: root }).then((r) => (/^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : undefined), () => undefined)
    : undefined;
  const [c, a] = await Promise.all([changed, ahead]);
  const l = a !== undefined && a > 0 && (await landed(root, worktree.branch, exec));
  return { ...(c !== undefined ? { changed: c } : {}), ...(a !== undefined ? { ahead: a } : {}), ...(l ? { landed: true } : {}) };
}

export type MergeStep = { text: string; command?: string };
export type MergeInput = { root: string; path: string; branch: string; target?: string; mainChanged?: number } & WorktreeState;

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

// What to run, in order, to land a worktree's work on the branch the main checkout is on, as one commit. Shown for the user to run,
// never run here. Built from git's own names only: the commit message reaches git through `commit -C <branch>`, never as text.
export function mergeSteps({ root, path, branch, target, mainChanged, changed, ahead, landed }: MergeInput): MergeStep[] {
  if (changed === undefined || ahead === undefined || mainChanged === undefined) {
    return [{ text: `Git could not say what ${plain(branch)} holds, or what the main checkout has uncommitted, so no commands are shown.` }];
  }
  if (!COORDINER_BRANCH.test(branch)) return [{ text: `${plain(branch)} is not a branch Coordiner made, so no commands are shown.` }];
  if (target === undefined || target === "HEAD") {
    return [{ text: `The main checkout at ${plain(root)} is not on a branch. Check out the branch to merge into there, then choose Merge steps again.` }];
  }
  if ([root, path, target].some((value) => /[\u0000-\u001f\u007f-\u009f]/.test(value))) {
    return [{ text: `A path or branch name has a control character, so no commands are printed. Commit in ${plain(path)}, then merge ${branch} into ${plain(target)} with git merge --squash.` }];
  }
  const cleanUp = { text: "Then choose End chat, and remove the worktree with Remove Worktree… in Sessions." };
  if (changed === 0 && (ahead === 0 || landed)) {
    return [{ text: ahead === 0 ? `Nothing to merge: ${branch} has no changes and no commits that ${target} lacks.` : `Nothing to merge: the changes on ${branch} are already in ${target}.` }, cleanUp];
  }
  return [
    ...(mainChanged > 0 ? [{ text: `The main checkout has ${files(mainChanged)} uncommitted. Commit or stash them first: the merge stops if it would touch them.` }] : []),
    ...(changed > 0
      ? [
          { text: `Stage the ${files(changed)} the run changed:`, command: `cd ${quote(path)} && git add -A` },
          { text: "Then run the commit brief's git commit command from the chat above, in the same terminal." },
        ]
      : []),
    { text: `Bring the work into ${target} as one change:`, command: `git -C ${quote(root)} merge --squash ${quote(branch)}` },
    { text: "Commit it with the message of the worktree's commit:", command: `git -C ${quote(root)} commit -C ${quote(branch)}` },
    { text: `If the merge stops on conflicts, fix them and run the commit command, or put ${target} back as it was:`, command: `git -C ${quote(root)} reset --merge` },
    cleanUp,
  ];
}

// The branch the main checkout is on, for "commits ahead of <branch>"; undefined when git could not say.
export const currentBranch = (root: string, exec: Exec): Promise<string | undefined> =>
  exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).then((r) => r.stdout.trim() || undefined, () => undefined);

export type Removal = { ok: true; removed: ("worktree" | "branch")[]; left: string[] } | { ok: false; reason: string; detail?: string };

// Removes a worktree and its branch, only once the caller has the user's confirmation. It acts only on a worktree git lists now
// for this repo on a coordiner/<slug> branch, so neither a stale listing nor a tampered journal can aim it elsewhere. `force` is
// passed only after the user agreed to lose what the worktree holds; without it git keeps a worktree with changes.
export async function removeWorktree(root: string, worktree: Listed, { force }: { force: boolean }, exec: Exec): Promise<Removal> {
  if (!COORDINER_BRANCH.test(worktree.branch)) return { ok: false, reason: `${plain(worktree.branch)} is not a branch Coordiner made.` };
  const listed = await listWorktrees(root, exec);
  if (!listed.ok) return { ok: false, reason: "Git could not list the worktrees, so nothing was removed.", detail: listed.detail };
  if (!listed.worktrees.some((w) => w.path === worktree.path && w.branch === worktree.branch)) {
    return { ok: false, reason: `Git no longer lists ${plain(worktree.path)} as a worktree on ${plain(worktree.branch)}, so nothing was removed.` };
  }
  try {
    await exec("git", ["worktree", "remove", ...(force ? ["--force"] : []), "--", worktree.path], { cwd: root });
  } catch (error) {
    return { ok: false, reason: "Git could not remove the worktree.", detail: detailOf(error) };
  }
  try {
    await exec("git", ["branch", "-D", worktree.branch], { cwd: root });
  } catch {
    return { ok: true, removed: ["worktree"], left: removalCommands(root, worktree.path, worktree.branch)?.slice(1) ?? [] };
  }
  return { ok: true, removed: ["worktree", "branch"], left: [] };
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
