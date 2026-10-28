import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { parseStories, slugify, storyText, wholeFileStory, type Story } from "./backlog.ts";
import { ChainStore, type StoreFs } from "./chain-store.ts";
import { briefHeading, inputOf, INPUTS, MAX_INPUT_CHARS, MSKILLS_URL, requiredSkills, runnable, TEMPLATES, type Chain, type InputKind } from "./chains.ts";
import { editorHtml } from "./editor-html.ts";
import { runReason } from "./editor-logic.ts";
import { parseEditorMessage, type ChatMessage, type EditorState } from "./editor-protocol.ts";
import { bundledClaudePath, checkEnvironment, findClaude, sessionEnv, type Models } from "./environment.ts";
import { MAX_JOURNAL_BYTES, parseJournal, readNewest, type PastRun } from "./history.ts";
import { createJournal, journalFileName, type JournalRecord, type LastTurn } from "./journal.ts";
import { replyOf } from "./protocol.ts";
import { fillInput, remainingCommands, runChain, talkOn, type AfterAsk, type Outcome, type RunEvent } from "./run.ts";
import { oneRun, type OneRun } from "./one-run.ts";
import { actOnChat, createRunChat, IDLE_CHAT, type ChatAction, type Decision, type RunChat, type TurnMode } from "./run-chat.ts";
import { listCommands, runTurn, type TurnControl, type TurnResult } from "./session.ts";
import { proposeSetup, runSetup } from "./setup.ts";
import { commonEfforts, modelOptions, mskillsPresent, palette, type ModelOption, type PaletteEntry } from "./skills.ts";
import { plain } from "./text.ts";
import type { QuestionWait } from "./unattended.ts";
import { applyTask, liveProcess, stopLine, type Process } from "./processes.ts";
import { currentItem, finishedMessage, nothingToReviewMessage, pickedChain, processItem, sessionItem, startItems, stepItem, type ItemView, type StepView } from "./view.ts";
import { addWorktree, prepareReview, removalNote, resumeCommand, setUpRepo, type Exec, type RepoInfo, type SetupPrompt, type Worktree } from "./worktree.ts";

const run = promisify(execFile);
const exec: Exec = (file, args, options) => run(file, args, options);

// The Sessions list: the session open now at the top, with its steps and, under the running one, the background processes of its
// turn; under it the earlier sessions of this repo, each with the steps it ran.
type OpenRow = { kind: "open" };
type PastRow = { kind: "past"; run: PastRun };
type PastStep = { kind: "past-step"; step: StepView; index: number; parent: PastRow };
type RunItem = OpenRow | PastRow | PastStep | StepView | Process;
const OPEN: OpenRow = { kind: "open" };
const isProcess = (item: RunItem): item is Process => "id" in item && !("kind" in item);

class SessionsProvider implements vscode.TreeDataProvider<RunItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  steps: StepView[] = [];
  processes: Process[] = [];
  private open?: { title: string; phase: "running" | "chat open" | "ended" };
  private past: PastRow[] = [];

  update(steps: StepView[]): void {
    this.steps = steps;
    this.changed.fire();
  }

  setProcesses(processes: Process[]): void {
    this.processes = processes;
    this.changed.fire();
  }

  setOpen(open: SessionsProvider["open"]): void {
    this.open = open;
    this.changed.fire();
  }

  setPast(runs: readonly PastRun[]): void {
    this.past = runs.map((run) => ({ kind: "past", run }));
    this.changed.fire();
  }

  // The argument of a row's open command is a key into this list, never a path.
  pastRun(file: unknown): PastRun | undefined {
    return this.past.find((row) => row.run.file === file)?.run;
  }

  private running(): StepView | undefined {
    return this.steps.findLast((s) => s.status === "running");
  }

  getTreeItem(element: RunItem): vscode.TreeItem {
    if ("kind" in element) return this.sessionTreeItem(element);
    const view = isProcess(element) ? processItem(element, this.running()?.label ?? "") : stepItem(element);
    const item = treeItem(view);
    // The Stop process action (inline, and in the context menu for the keyboard) shows on these items only.
    if (isProcess(element)) item.contextValue = "process";
    else if (element === this.running() && this.processes.length > 0) item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    return item;
  }

  private sessionTreeItem(element: OpenRow | PastRow | PastStep): vscode.TreeItem {
    const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
    switch (element.kind) {
      case "open": {
        const item = treeItem(currentItem(this.open?.title ?? "", this.open?.phase ?? "ended"));
        item.id = "open";
        item.collapsibleState = this.steps.length > 0 ? Expanded : None;
        item.command = { command: "coordiner.openChains", title: "Open Chains" };
        return item;
      }
      case "past": {
        const item = treeItem(sessionItem(element.run, Date.now()));
        // Ids keep a row expanded across refreshes.
        item.id = `past:${element.run.file}`;
        item.collapsibleState = element.run.steps.length > 0 ? Collapsed : None;
        item.command = { command: "coordiner.openSession", title: "Open Session", arguments: [element.run.file] };
        return item;
      }
      case "past-step": {
        const item = treeItem(stepItem(element.step));
        item.id = `past:${element.parent.run.file}:${element.index}`;
        return item;
      }
    }
  }

  getChildren(element?: RunItem): vscode.ProviderResult<RunItem[]> {
    if (!element) return [...(this.open ? [OPEN] : []), ...this.past];
    if (element === OPEN) return this.steps;
    if ("kind" in element) return element.kind === "past" ? element.run.steps.map((step, index): PastStep => ({ kind: "past-step", step, index, parent: element })) : [];
    return !isProcess(element) && element === this.running() ? this.processes : [];
  }

  getParent(element: RunItem): RunItem | undefined {
    if (isProcess(element)) return this.running();
    if (!("kind" in element)) return OPEN;
    return element.kind === "past-step" ? element.parent : undefined;
  }
}

function treeItem(view: ItemView): vscode.TreeItem {
  const item = new vscode.TreeItem(view.label);
  item.description = view.description;
  item.iconPath = new vscode.ThemeIcon(view.icon);
  item.accessibilityInformation = { label: view.accessibleLabel, role: "treeitem" };
  return item;
}

function readModels(config: vscode.WorkspaceConfiguration): Models {
  return {
    strong: config.get<string>("models.strong", "claude-opus-5-5"),
    medium: config.get<string>("models.medium", "claude-sonnet-5-5"),
    weak: config.get<string>("models.weak", "claude-haiku-5-5"),
  };
}

const sessionEnvFor = (config: vscode.WorkspaceConfiguration) => sessionEnv(process.env, config.get<string>("extraPath", ""));
const isExecutable = (path: string) => access(path, constants.X_OK).then(() => true, () => false);
const bundledClaude = () => bundledClaudePath(vscode.extensions.getExtension("anthropic.claude-code")?.extensionPath, process.platform);
const claudeFor = (config: vscode.WorkspaceConfiguration, env: Record<string, string | undefined>) => findClaude(config.get<string>("claudePath", ""), env, homedir(), isExecutable, bundledClaude());
const openFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const exists = (path: string) => access(path).then(() => true, () => false);
const noTools = async () => ({ behavior: "deny" as const, message: "This check uses no tools." });

async function checkEnvironmentCommand(output: vscode.OutputChannel): Promise<void> {
  const cwd = openFolder();
  if (cwd === undefined) {
    await vscode.window.showErrorMessage("Coordiner: open a folder first. Sessions run in the open folder.");
    return;
  }
  const config = vscode.workspace.getConfiguration("coordiner");
  const env = sessionEnvFor(config);
  const claude = await claudeFor(config, env);
  output.show(true);
  output.appendLine("Checking the environment: three short model calls and one resume.");
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Coordiner: checking the environment" },
    () =>
      checkEnvironment({
        runTurn,
        nodeVersion: async (env) => (await run("node", ["--version"], { env })).stdout.trim(),
        claude,
        models: readModels(config),
        cwd,
        env,
        canUseTool: noTools,
      }),
  );
  output.appendLine("extension activation: ok");
  for (const r of results) output.appendLine(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) await vscode.window.showInformationMessage("Coordiner: every environment check passed.");
  else await vscode.window.showErrorMessage(`Coordiner: ${failed.length} environment check(s) failed. See the Coordiner output.`);
}

// "type" means the user chose to type a story instead of picking one from a file.
async function pickStory(): Promise<Story | "type" | undefined> {
  const files = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**", 200);
  const picked = await vscode.window.showQuickPick(
    [
      { label: "$(edit) Type a story…", description: "no backlog file needed", uri: undefined },
      ...files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), description: undefined, uri })),
    ],
    { title: "Pick a story", placeHolder: "The Markdown file that holds your stories, or type one" },
  );
  if (!picked) return undefined;
  if (!picked.uri) return "type";
  const markdown = await readFile(picked.uri.fsPath, "utf8");
  if (markdown.trim() === "") {
    void vscode.window.showInformationMessage(`Coordiner: ${picked.label} is empty. Write the story in it, or choose "Type a story…".`);
    return undefined;
  }
  const stories = parseStories(markdown);
  if (stories.length === 0) return wholeFileStory(markdown, basename(picked.uri.fsPath));
  const chosen = await vscode.window.showQuickPick(
    stories.map((story) => ({ label: plain(story.heading), story })),
    { title: "Pick a story", placeHolder: "Story to run" },
  );
  return chosen?.story;
}

// The name becomes the worktree folder and the branch, so it must slugify.
const nameProblem = (value: string): string | undefined => {
  try {
    slugify(value);
    return undefined;
  } catch {
    return "Use at least one letter or digit.";
  }
};

async function nameRun(value = ""): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: "Name this run",
    prompt: "The name becomes the worktree folder and the coordiner/<name> branch.",
    value,
    validateInput: nameProblem,
  });
  return name?.trim();
}

type RunInput = { name: string; text: string };

// Run asks for what the chain starts from; a typed input also suggests the run's name.
async function askInput(kind: InputKind | undefined): Promise<RunInput | undefined> {
  if (kind === undefined) {
    const name = await nameRun();
    return name === undefined ? undefined : { name, text: "" };
  }
  if (kind === "story") {
    const story = await pickStory();
    if (story !== "type") return story && { name: story.heading, text: storyText(story) };
  }
  const { title, ask } = INPUTS[kind];
  const text = (
    await vscode.window.showInputBox({
      title,
      prompt: ask,
      validateInput: (value) =>
        value.length > MAX_INPUT_CHARS ? `Keep it under ${MAX_INPUT_CHARS} characters.` : value.trim() === "" ? "Write at least a few words." : undefined,
    })
  )?.trim();
  if (!text) return undefined;
  // Text in any script is fine; only the suggested name needs a letter or digit from [a-z0-9].
  const name = await nameRun(nameProblem(text) ? "" : slugify(text));
  return name === undefined ? undefined : { name, text };
}

// A run that changed nothing leaves its worktree and branch behind; the output says how to remove them, and Coordiner removes nothing.
async function offerRemoval(worktree: Worktree, output: vscode.OutputChannel): Promise<boolean> {
  const note = await removalNote(worktree, exec);
  for (const line of note ?? []) output.appendLine(line);
  return note !== undefined;
}

// The commit brief is model text: it is shown, never offered as a command to copy or run. So are the questions the run answered
// without the user, listed for them to check.
async function announce(outcome: Outcome, heading: string, worktree: Worktree, chain: Chain, output: vscode.OutputChannel, decided: readonly Decision[]): Promise<void> {
  const name = plain(heading);
  if (decided.length > 0) {
    output.appendLine("Decided without you (the Recommended option):");
    for (const d of decided) output.appendLine(`- ${plain(d.card)}: ${plain(d.question)} → ${plain(d.answer)} (${d.after})`);
  }
  if ((outcome.status === "halted" || outcome.status === "failed") && outcome.sessionId) {
    output.appendLine(`To take over this session, run in ${worktree.path}: claude --resume ${outcome.sessionId}`);
  }
  const remaining = remainingCommands(chain, outcome);
  if (remaining.length > 0) output.appendLine(`To finish by hand, run these in a Claude Code session in ${worktree.path}: ${remaining.map(plain).join(" → ")}`);
  switch (outcome.status) {
    case "done": {
      const brief = briefHeading(chain);
      output.appendLine(`${brief}:`);
      output.appendLine(plain(outcome.text) || `(the session returned no ${brief.toLowerCase()})`);
      const unchanged = await offerRemoval(worktree, output);
      output.show(true);
      await vscode.window.showInformationMessage(finishedMessage(name, brief, unchanged ? undefined : worktree.path));
      return;
    }
    case "no-changes": {
      const removable = await offerRemoval(worktree, output);
      if (removable) output.show(true);
      await vscode.window.showInformationMessage(nothingToReviewMessage(name, removable));
      return;
    }
    case "halted":
      await vscode.window.showWarningMessage(`Coordiner: ${name} halted: ${plain(outcome.reason)} See the Coordiner output.`);
      return;
    case "stopped":
      await vscode.window.showInformationMessage(`Coordiner: ${name} was stopped.`);
      return;
    case "refused":
      await vscode.window.showErrorMessage(`Coordiner: ${plain(outcome.reason)}`);
      return;
    case "failed":
      await vscode.window.showErrorMessage(`Coordiner: ${name} failed: ${plain(outcome.error)} See the Coordiner output.`);
  }
}

// The run's chat outlives the run, so the editor still shows the last transcript after it ends, until the next run starts or an
// earlier session is reopened. `stopProcess` exists while a turn can run; it acts on the turn running at the time. `after` is the
// chat after the run. `open` is the session the chat belongs to: its row title and its journal file; `opening` is the journal file
// of an earlier session being reopened.
type RunState = { abort?: AbortController; chainId?: string; chat?: RunChat; stopProcess?: (process: Process) => Promise<void>; after?: After; open?: { title: string; file: string }; opening?: string };

// Where a next chain runs: the worktree of the run before, that run's name, and its last reply, which becomes the input.
type Here = { worktree: Worktree; name: string; slug: string; card: string; input: string };

// The run's last session, which the user keeps talking to after the run until they end the chat or confirm a new run.
type After = { abort: AbortController; chat: RunChat; here: Here; sessionId: string };

type Journal = (record: JournalRecord) => Promise<void>;

// A run the user confirmed: the filled chain, its name, and a worktree whose setup is done.
// `questions`: how the run treats a question from a card that runs unattended, chosen with the run's confirmation.
type Place = { chain: Chain; name: string; slug: string; worktree: Worktree; models: Models; journal: Journal; journalFile: string; questions: QuestionWait };

type RunContext = {
  state: RunState;
  // Held from the moment Run is pressed until the run ends, and by each turn of the chat after it; `state.abort` only exists
  // once the sessions start.
  slot: OneRun;
  provider: SessionsProvider;
  reveal: (step: RunItem) => void;
  output: vscode.OutputChannel;
  storage: vscode.Uri;
  onRunChange: () => void;
  // Sends the run's chat to the chains editor, if it is open.
  postChat: (message: ChatMessage) => void;
  // A card waits for the user, or asked them something: bring the editor up without taking focus.
  needsYou: (card: string) => void;
  // The open session changed: list the earlier ones again, without it.
  sessionsChanged: () => void;
};

// The run's announcement waits on a notification, so it comes after the slot is given back: the chat after the run needs the slot.
async function runChainCommand(chain: Chain, ctx: RunContext, here?: Here): Promise<void> {
  let announce: (() => Promise<void>) | undefined;
  if (!(await ctx.slot.run(async () => void (announce = await startRun(chain, ctx, here))))) {
    await vscode.window.showWarningMessage("Coordiner: a run is already in progress. Stop it first.");
    return;
  }
  await announce?.();
}

// Ends the chat after the last run, if one is open: its session gets no more turns.
function endAfter(state: RunState): void {
  const { after } = state;
  if (!after) return;
  state.after = undefined;
  state.stopProcess = undefined;
  after.abort.abort();
  after.chat.talk.end();
}

// setUpRepo's questions, each a modal that agrees only through its button.
async function askSetup(prompt: SetupPrompt): Promise<boolean> {
  const ask = async (message: string, detail: string, button: string) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  switch (prompt.kind) {
    case "init":
      return ask(`${plain(prompt.folder)} is not a git repository yet.`, "Every run works in its own git worktree, made from your last commit. Coordiner can run git init here and make a first commit, then carry on with this run.", "Initialize git");
    case "empty-commit":
      return ask(`${plain(prompt.root)} has no commits yet.`, "Every run works in its own git worktree, made from your last commit. Coordiner can make an empty first commit, then carry on with this run.", "Make first commit");
    case "commit-files": {
      const { files } = prompt;
      const shown = files.slice(0, 10).map(plain).join("\n") + (files.length > 10 ? `\n… and ${files.length - 10} more` : "");
      const detail = `The run's worktree starts from the first commit, so it has only the files that commit takes. Coordiner can commit all of them, .gitignore respected, as "Initial commit". To choose which go in, cancel, commit them yourself and start again.\n\n${shown}`;
      return ask(`${plain(prompt.root)} has no commits yet.`, detail, `Commit ${files.length} file${files.length === 1 ? "" : "s"}`);
    }
  }
}

async function readyRepo(folder: string, output: vscode.OutputChannel): Promise<RepoInfo | undefined> {
  const setup = await setUpRepo(folder, { exec, ask: askSetup, log: (line) => output.appendLine(line) });
  if (setup.kind === "ready") return setup.repo;
  if (setup.kind === "failed") {
    if (setup.detail) {
      output.appendLine(setup.detail);
      output.show(true);
    }
    void vscode.window.showErrorMessage(`Coordiner: ${setup.reason}${setup.detail ? " See the Coordiner output." : ""}`);
  }
  return undefined;
}

// What a turn runs with, read again for every turn, so a setting fixed while a card waits applies when it carries on.
async function turnTools(): Promise<{ ok: true; env: Record<string, string | undefined>; claudePath: string } | { ok: false; error: string }> {
  const config = vscode.workspace.getConfiguration("coordiner");
  const env = sessionEnvFor(config);
  const claude = await claudeFor(config, env);
  return claude.ok ? { ok: true, env, claudePath: claude.path } : claude;
}

// The run's confirmation, one Run button for each way it can treat a question from a card that runs unattended.
const RUN_CHOICES: ReadonlyArray<readonly [string, QuestionWait]> = [
  ["Run, wait 5 min for answers", "timed"],
  ["Run, wait for my answers", "always"],
  ["Run, never wait", "never"],
];

async function confirmRun(message: string, detail: string): Promise<QuestionWait | undefined> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, ...RUN_CHOICES.map(([label]) => label));
  return RUN_CHOICES.find(([label]) => label === choice)?.[1];
}

// What the sessions run with: the editor's environment and the claude to start.
async function sessionTools(): Promise<{ env: Record<string, string | undefined>; claudePath: string; models: Models } | undefined> {
  const config = vscode.workspace.getConfiguration("coordiner");
  const env = sessionEnvFor(config);
  const claude = await claudeFor(config, env);
  if (!claude.ok) {
    void vscode.window.showErrorMessage(`Coordiner: ${claude.error}`);
    return undefined;
  }
  return { env, claudePath: claude.path, models: readModels(config) };
}

// What every run's confirm modal says about how the chain runs.
function runNotes(chain: Chain): string[] {
  const sessions = chain.sessions.map((s, i) => `${i + 1}. ${s.cards.map((c) => plain(c.label)).join(" → ")}`).join("\n");
  return [
    chain.sessions.some((s) => s.cards.some((c) => c.pause))
      ? "Cards that pause wait for you in the chat under the chains editor. Every other card runs unattended."
      : "The chain runs unattended.",
    "A question from a card that runs unattended shows in the chat. Wait 5 min: answer it within 5 minutes, or the Recommended option is taken. Wait for my answers: it waits as long as it takes. Never wait: the Recommended option is taken at once. A question with no Recommended option always waits for you, and every answer taken without you is listed when the run ends.",
    "A card that cannot go on (a halt, a failed turn) waits for you in the chat with the reason: reply to it, or fix the cause and choose Continue.",
    "In the chat you can message any card (it gets your message with its next turn) or pause it after its turn. Anything auto mode will not approve is denied, and so is any git write or GitHub publish.",
    `Each session starts a fresh conversation:\n${sessions}`,
    "Keep this computer awake: the run stops if VS Code closes.",
  ];
}

const journalDir = (ctx: RunContext) => join(ctx.storage.fsPath, "journal");

// A new run's journal file, which begins with where the run happens.
function startJournal(ctx: RunContext, slug: string, start: Extract<JournalRecord, { type: "run-started" }>): { journal: Journal; file: string } {
  const file = journalFileName(slug, new Date());
  const journal = journalAt(ctx, file);
  void journal(start);
  ctx.output.appendLine(`Journal: ${join(journalDir(ctx), file)}`);
  return { journal, file };
}

// Appends to the journal file of that name: a new run's, or a reopened session's own.
function journalAt(ctx: RunContext, file: string): Journal {
  const { output } = ctx;
  const dir = journalDir(ctx);
  const journalFile = join(dir, file);
  return createJournal(
    async (line) => {
      await mkdir(dir, { recursive: true });
      await appendFile(journalFile, line, "utf8");
    },
    () => new Date(),
    (error) => output.appendLine(`Journal not written to ${journalFile}: ${error instanceof Error ? error.message : String(error)}`),
  );
}

// Returns the run's announcement, for after the slot is given back; nothing when the run never started. Its messages are not
// awaited: a notification that slides into the notification center never settles, and the slot would stay taken.
async function startRun(chain: Chain, ctx: RunContext, here?: Here): Promise<(() => Promise<void>) | undefined> {
  const check = runnable(chain);
  if (!check.ok) {
    void vscode.window.showErrorMessage(`Coordiner: ${plain(chain.name)} cannot run. ${check.reason}`);
    return undefined;
  }
  const place = here ? await confirmHere(chain, here, ctx) : await prepareWorktree(chain, ctx);
  return place && runIn(place, ctx);
}

// A new worktree for the run: the repo, the chain's input, the confirm modal, then the worktree and its setup.
async function prepareWorktree(chain: Chain, ctx: RunContext): Promise<Place | undefined> {
  const { output } = ctx;
  const folder = openFolder();
  if (folder === undefined) {
    void vscode.window.showErrorMessage("Coordiner: open a folder first. Sessions run in the open folder.");
    return undefined;
  }
  let repo;
  try {
    repo = await readyRepo(folder, output);
  } catch (error) {
    void vscode.window.showErrorMessage(`Coordiner: ${(error as Error).message}`);
    return undefined;
  }
  if (!repo) return undefined;
  const tools = await sessionTools();
  if (!tools) return undefined;
  const input = await askInput(inputOf(chain));
  if (!input) return undefined;
  const filled = fillInput(chain, input.text);
  if (!filled.ok) {
    void vscode.window.showErrorMessage(`Coordiner: ${filled.reason}`);
    return undefined;
  }
  let slug;
  try {
    slug = slugify(input.name);
  } catch (error) {
    void vscode.window.showErrorMessage(`Coordiner: ${(error as Error).message}`);
    return undefined;
  }

  // The setup command comes from the lockfile, never from the repo's own files; it is shown on every run.
  const setup = proposeSetup(await readdir(repo.root));
  const detail = [
    ...runNotes(chain),
    repo.dirty.length > 0 ? "WARNING: your checkout has uncommitted changes. They are not in the new worktree." : undefined,
    setup ? `Setup command in the new worktree: ${setup.join(" ")}` : "No setup command (no lockfile found).",
  ].filter(Boolean).join("\n\n");
  const questions = await confirmRun(`Run ${plain(chain.name)} for "${plain(input.name)}"?`, detail);
  if (!questions) return undefined;
  endAfter(ctx.state);

  const added = await addWorktree(repo.root, slug, { exec, exists });
  if (!added.ok) {
    if (added.detail) output.appendLine(added.detail);
    void vscode.window.showErrorMessage(`Coordiner: ${added.reason}`);
    return undefined;
  }
  output.appendLine(`Worktree ${added.path} on branch ${added.branch}`);
  const worktree = { root: repo.root, path: added.path, branch: added.branch };
  const { journal, file: journalFile } = startJournal(ctx, slug, { type: "run-started", chain: chain.name, story: input.name, repo: repo.root, worktree: added.path, branch: added.branch, models: tools.models, questions });
  if (setup) {
    const result = await runSetup(setup, added.path, tools.env, exec);
    if (!result.ok) {
      output.appendLine(result.detail);
      void journal({ type: "outcome", outcome: { status: "failed", error: result.message } });
      void vscode.window.showErrorMessage(`Coordiner: ${result.message}`);
      return undefined;
    }
  }
  return { chain: filled.chain, name: input.name, slug, worktree, models: tools.models, journal, journalFile, questions };
}

// A next chain in the worktree of the run before: no new worktree and no setup, and its input is that run's last reply.
async function confirmHere(chain: Chain, here: Here, ctx: RunContext): Promise<Place | undefined> {
  const { worktree, card } = here;
  if (!(await exists(worktree.path))) {
    void vscode.window.showErrorMessage(`Coordiner: ${plain(worktree.path)} no longer exists, so ${plain(chain.name)} cannot run there.`);
    return undefined;
  }
  const tools = await sessionTools();
  if (!tools) return undefined;
  const takesInput = inputOf(chain) !== undefined;
  if (takesInput && here.input.trim() === "") {
    void vscode.window.showErrorMessage(`Coordiner: ${plain(card)} gave no reply to start ${plain(chain.name)} from.`);
    return undefined;
  }
  const filled = fillInput(chain, here.input);
  if (!filled.ok) {
    void vscode.window.showErrorMessage(`Coordiner: ${filled.reason}`);
    return undefined;
  }
  const detail = [
    `In the same worktree, ${worktree.path}. It keeps the run before's changes, uncommitted, and its setup is already done.`,
    takesInput ? `Input: ${plain(card)}'s last reply, ${here.input.length} characters.` : "This chain takes no input.",
    ...runNotes(chain),
  ].join("\n\n");
  const questions = await confirmRun(`Run ${plain(chain.name)} in the same worktree?`, detail);
  if (!questions) return undefined;
  endAfter(ctx.state);
  const { journal, file: journalFile } = startJournal(ctx, here.slug, { type: "run-started", chain: chain.name, story: here.name, repo: worktree.root, worktree: worktree.path, branch: worktree.branch, models: tools.models, questions });
  return { chain: filled.chain, name: here.name, slug: here.slug, worktree, models: tools.models, journal, journalFile, questions };
}

type Turn = (request: AfterAsk & { mode: TurnMode }, signal: AbortSignal) => Promise<TurnResult>;
type Turns = { turn: Turn; stopProcess: (process: Process) => Promise<void>; last: () => LastTurn | undefined };

// The turns of a run's sessions, or of a reopened session's, in its worktree. Each turn's session, model and reply is journaled, so
// the chat can be reopened on it after VS Code closes.
function sessionTurns(chat: RunChat, worktree: Worktree, required: readonly string[], journal: Journal, ctx: RunContext, log: (line: string) => void): Turns {
  const { provider, output } = ctx;
  // What can act on the turn that is running; the turn's processes are listed only while it runs.
  let control: TurnControl | undefined;
  const stopProcess = async (process: Process) => {
    if (!control) return;
    try {
      await control.stopTask(process.id);
      log(stopLine(process));
    } catch {
      output.appendLine("Coordiner: that process had already ended.");
    }
  };
  let last: LastTurn | undefined;
  const turn: Turn = async ({ mode, ...request }, signal) => {
    const card = chat.talk.snapshot().card ?? "";
    let result: TurnResult;
    const tools = await turnTools();
    try {
      result = !tools.ok ? { ok: false, error: tools.error } : await runTurn({
        ...request,
        ...chat.forTurn(mode),
        cwd: worktree.path,
        env: tools.env,
        claudePath: tools.claudePath,
        requiredCommands: required,
        signal,
        onGuard: log,
        onStarted: (c) => {
          control = c;
          chat.talk.injectInto(c.inject);
        },
        onTask: (message) => provider.setProcesses(applyTask(provider.processes, message)),
      });
    } finally {
      control = undefined;
      chat.talk.injectInto(undefined);
      provider.setProcesses([]);
    }
    if (!result.ok && result.undelivered) chat.talk.giveBack(result.undelivered);
    if (result.sessionId) {
      const reply = result.ok ? replyOf(result.resultText) : (last?.reply ?? "");
      last = { sessionId: result.sessionId, model: request.model, ...(request.effort ? { effort: request.effort } : {}), card, reply };
      void journal({ type: "turn", ...last });
    }
    return result;
  };
  return { turn, stopProcess, last: () => last };
}

// Runs the chain in its place, then leaves the chat open on the last session. Returns the run's announcement.
async function runIn(place: Place, ctx: RunContext): Promise<() => Promise<void>> {
  const { state, provider, reveal, output } = ctx;
  const { chain, name, worktree, models, journal, questions } = place;
  const abort = new AbortController();
  const log = (line: string) => {
    output.appendLine(line);
    void journal({ type: "log", line });
  };
  const title = `${plain(chain.name)} · ${plain(name)}`;
  const chat = createRunChat({
    title,
    post: ctx.postChat,
    record: (r) => void journal(r),
    moved: ctx.onRunChange,
    needsYou: ctx.needsYou,
    log,
    questions,
  });
  Object.assign(state, { abort, chainId: chain.id, chat, open: { title, file: place.journalFile } });
  provider.update([]);
  ctx.onRunChange();
  ctx.sessionsChanged();
  const emit = (event: RunEvent) => {
    void journal(event);
    if (event.type === "step-started") {
      provider.update([...provider.steps, { label: event.label, tier: event.tier, model: event.model, ...(event.effort ? { effort: event.effort } : {}), status: "running" }]);
      reveal(provider.steps[event.index]!);
      return;
    }
    provider.update(provider.steps.map((step, i) => (i === event.index ? { ...step, status: event.status, detail: event.detail } : step)));
  };
  const { turn, stopProcess, last } = sessionTurns(chat, worktree, requiredSkills(chain), journal, ctx, log);
  state.stopProcess = stopProcess;
  let outcome: Outcome | undefined;
  try {
    outcome = await runChain(chain, {
      runTurn: ({ interactive, ...request }) => turn({ ...request, mode: interactive ? "interactive" : "unattended" }, abort.signal),
      models,
      emit,
      signal: abort.signal,
      talk: chat.talk,
      prepareReview: () => prepareReview(worktree.path, exec),
    });
  } finally {
    if (!outcome) chat.talk.end();
    state.abort = undefined;
    state.stopProcess = undefined;
    ctx.onRunChange();
  }
  void journal({ type: "outcome", outcome });
  const lastTurn = last();
  chat.ended(outcome, lastTurn && { card: lastTurn.card });
  if (lastTurn) talkAfter(lastTurn, { chat, place, ctx, stopProcess, turn });
  const ended = outcome;
  return () => announce(ended, name, worktree, chain, output, chat.decided());
}

// The chat after the run: each message is a turn of the run's last session, and each turn holds the slot, so a new run waits
// for it. A failed turn is shown in the transcript and the chat stays open.
function talkAfter(
  last: LastTurn,
  { chat, place, ctx, stopProcess, turn }: { chat: RunChat; place: Pick<Place, "worktree" | "name" | "slug">; ctx: RunContext; stopProcess: RunState["stopProcess"]; turn: Turn },
): void {
  const abort = new AbortController();
  const here: Here = { worktree: place.worktree, name: place.name, slug: place.slug, card: last.card, input: last.reply };
  const after: After = { abort, chat, here, sessionId: last.sessionId };
  Object.assign(ctx.state, { after, stopProcess });
  ctx.onRunChange();
  const runAfterTurn = async (request: AfterAsk): Promise<TurnResult> => {
    let ran: TurnResult | undefined;
    await ctx.slot.run(async () => void (ran = await turn({ ...request, mode: "after" }, abort.signal)));
    const result: TurnResult = ran ?? { ok: false, error: "a new run is starting, so the message was not sent." };
    if (result.ok) {
      after.sessionId = result.sessionId;
      here.input = replyOf(result.resultText);
    } else if (!abort.signal.aborted) {
      chat.failed(last.card, result.error);
    }
    return result;
  };
  void talkOn({ runTurn: runAfterTurn, talk: chat.talk, signal: abort.signal, card: last.card, sessionId: last.sessionId, model: last.model, ...(last.effort ? { effort: last.effort } : {}) });
}

// Reopens an earlier session from its journal: its transcript, and, while its worktree and session are still there, the chat after
// the run on that session. The slot is held while it reads, so a run cannot start meanwhile; a second click on the row being opened
// is ignored.
async function openSession(file: unknown, editor: ChainsEditor, ctx: RunContext): Promise<void> {
  const { state, slot, provider } = ctx;
  const listedRun = provider.pastRun(file);
  if (!listedRun) {
    if (state.open?.file === file) await editor.open();
    return;
  }
  if (state.opening === listedRun.file) return;
  state.opening = listedRun.file;
  let opened = false;
  try {
    const took = await slot.run(async () => void (opened = await reopen(listedRun.file, ctx)));
    if (!took) void vscode.window.showWarningMessage("Coordiner: a run or a turn of the chat is going. Stop it first, then open the session.");
  } finally {
    state.opening = undefined;
  }
  if (opened) await editor.open();
}

// Whether the session was reopened: false when its journal can no longer be read.
async function reopen(file: string, ctx: RunContext): Promise<boolean> {
  const { state, provider, output } = ctx;
  const path = join(journalDir(ctx), file);
  let run: PastRun | undefined;
  try {
    run = (await stat(path)).size <= MAX_JOURNAL_BYTES ? parseJournal(await readFile(path, "utf8"), file) : undefined;
  } catch (error) {
    output.appendLine(`Coordiner: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!run) {
    void vscode.window.showErrorMessage("Coordiner: that session's journal can no longer be read. See the Coordiner output.");
    return false;
  }
  endAfter(state);
  const journal = journalAt(ctx, run.file);
  const log = (line: string) => {
    output.appendLine(line);
    void journal({ type: "log", line });
  };
  const title = `${run.chain} · ${run.story}`;
  const chat = createRunChat({ title, post: ctx.postChat, record: (r) => void journal(r), moved: ctx.onRunChange, needsYou: ctx.needsYou, log, questions: run.questions, past: run.entries });
  Object.assign(state, { chat, chainId: undefined, open: { title, file: run.file } });
  provider.update(run.steps);
  const there = await exists(run.worktree);
  if (run.last && there) {
    const worktree: Worktree = { root: run.repo, path: run.worktree, branch: run.branch };
    // A chat turn runs no skill of its own, so no skill is required of the session.
    const { turn, stopProcess } = sessionTurns(chat, worktree, [], journal, ctx, log);
    chat.reopened(run.ending, { card: run.last.card });
    talkAfter(run.last, { chat, place: { worktree, name: run.story, slug: slugOf(run.worktree) }, ctx, stopProcess, turn });
  } else {
    chat.reopened(run.ending);
    ctx.onRunChange();
    if (!there) void vscode.window.showWarningMessage(`Coordiner: ${plain(run.worktree)} no longer exists, so the session's chat is read-only.`);
  }
  ctx.sessionsChanged();
  return true;
}

// The worktree folder is named after the run's slug; a folder renamed by hand gets a plain one, used only to name the next journal.
function slugOf(path: string): string {
  try {
    return slugify(basename(path));
  } catch {
    return "session";
  }
}

// The earlier sessions of the open folder's repo. A journal that cannot be read, or is too large, is skipped and said once.
async function loadSessions(ctx: RunContext, skipped: Set<string>): Promise<PastRun[]> {
  const folder = openFolder();
  if (folder === undefined) return [];
  let root;
  try {
    root = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder })).stdout.trim();
  } catch {
    return [];
  }
  const dir = journalDir(ctx);
  const names = await readdir(dir).catch(() => [] as string[]);
  const skip = (name: string, why: string) => {
    if (!skipped.has(name)) ctx.output.appendLine(`Coordiner: left ${join(dir, name)} out of Sessions: ${why}`);
    skipped.add(name);
  };
  const files = await Promise.all(
    names.filter((name) => name.endsWith(".jsonl")).map(async (name) => {
      try {
        const { size, mtimeMs } = await stat(join(dir, name));
        return size > MAX_JOURNAL_BYTES ? void skip(name, "it is too large to read back.") : { name, mtimeMs };
      } catch (error) {
        return void skip(name, error instanceof Error ? error.message : String(error));
      }
    }),
  );
  const read = async (name: string): Promise<PastRun | undefined> => {
    try {
      const run = parseJournal(await readFile(join(dir, name), "utf8"), name);
      if (!run) skip(name, "it does not start with a run.");
      return run;
    } catch (error) {
      return void skip(name, error instanceof Error ? error.message : String(error));
    }
  };
  return readNewest(files.filter((f) => f !== undefined), read, root, ctx.state.open?.file);
}

// ── Chains editor ─────────────────────────────────────────────────────────────

// Where the run is, for the lanes to mark; nothing once it has ended.
function runningAt({ abort, chainId, chat }: RunState): Pick<EditorState, "runningAt"> {
  const view = chat?.view();
  return abort && chainId && view?.index !== undefined && view.session !== undefined ? { runningAt: { chainId, session: view.session, index: view.index } } : {};
}

class ChainsEditor {
  private panel?: vscode.WebviewPanel;
  private palette?: PaletteEntry[];
  private paletteError?: string;
  private mskills?: boolean;
  private models?: ModelOption[];
  private modelsError?: string;
  private readonly extension: vscode.Uri;
  private readonly store: ChainStore;
  private readonly ctx: RunContext;

  constructor(extension: vscode.Uri, file: string, ctx: RunContext) {
    this.extension = extension;
    this.ctx = ctx;
    const fs: StoreFs = {
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, text) => writeFile(path, text, "utf8"),
      rename,
      mkdir: async (path) => void (await mkdir(path, { recursive: true })),
    };
    this.store = new ChainStore(file, fs, () => new Date(), () => this.post());
  }

  // `preserveFocus` brings the editor up for a waiting card without taking focus from wherever the user is.
  async open(preserveFocus = false): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const media = vscode.Uri.joinPath(this.extension, "media");
    const dist = vscode.Uri.joinPath(this.extension, "dist");
    const panel = vscode.window.createWebviewPanel(
      "coordiner.chains",
      "Coordiner Chains",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      { enableScripts: true, localResourceRoots: [media, dist] },
    );
    this.panel = panel;
    const uri = (base: vscode.Uri, name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(base, name)).toString();
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      scriptUri: uri(media, "editor.js"),
      styleUri: uri(media, "editor.css"),
      chainEditUri: uri(dist, "chain-edit.js"),
    });
    panel.onDidDispose(() => (this.panel = undefined));
    panel.webview.onDidReceiveMessage((raw: unknown) => void this.receive(raw));
  }

  // A waiting card brings the editor up; a notification says so only when the editor was not already in view.
  needsYou(card: string): void {
    const inView = this.panel?.visible === true;
    void this.open(true);
    if (!inView) void vscode.window.showInformationMessage(`Coordiner: ${plain(card)} is waiting for you in the chains editor.`);
  }

  // The saved chains, read once whether or not the editor was opened; an unreadable file leaves only the templates.
  async startable(): Promise<{ templates: readonly Chain[]; chains: readonly Chain[] }> {
    await this.store.load();
    return { templates: TEMPLATES, chains: this.store.chains };
  }

  // The same checks for Run in the editor and for Start…. Start… can come before the editor was ever opened, so the skills are
  // listed first: a missing one is caught here, not after the worktree and its setup. If listing fails, the session checks them.
  async run(chain: Chain, here?: Here): Promise<void> {
    if (!this.palette) await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Coordiner: listing skills" }, () => this.discover());
    // The webview disables Run on its own, but its state is not trusted.
    const reason = runReason(chain, { running: this.ctx.slot.busy(), ...this.discovered() });
    if (reason) {
      await vscode.window.showErrorMessage(`Coordiner: ${plain(chain.name)} cannot run. ${reason}`);
      return;
    }
    await runChainCommand(structuredClone(chain), this.ctx, here);
  }

  // What discovery found, for the Run checks here and in the webview. The tier efforts follow the settings as they are now.
  private discovered(): Pick<EditorState, "mskills" | "palette" | "models" | "tierEfforts"> {
    const tiers = Object.values(readModels(vscode.workspace.getConfiguration("coordiner")));
    return {
      ...(this.mskills !== undefined ? { mskills: this.mskills } : {}),
      ...(this.palette ? { palette: this.palette } : {}),
      ...(this.models ? { models: this.models, tierEfforts: commonEfforts(this.models, tiers) } : {}),
    };
  }

  postChat(message: ChatMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  post(): void {
    // A state sent while saves are queued would roll the editor back past them; the last save posts instead.
    if (this.store.saving) return;
    const run = this.ctx.state;
    const { error, unsaved } = this.store;
    const state: EditorState = {
      type: "state",
      templates: TEMPLATES,
      chains: this.store.chains,
      running: this.ctx.slot.busy(),
      ...runningAt(run),
      ...this.discovered(),
      ...(this.paletteError ? { paletteError: this.paletteError } : {}),
      ...(this.modelsError ? { modelsError: this.modelsError } : {}),
      ...(error ? { storageError: error } : {}),
      ...(unsaved ? { unsaved } : {}),
    };
    void this.panel?.webview.postMessage(state);
  }

  private async receive(raw: unknown): Promise<void> {
    const message = parseEditorMessage(raw);
    if (!message) {
      this.ctx.output.appendLine("Coordiner: ignored an unexpected message from the chains editor.");
      // The editor already shows the edit it asked to save; it goes back to the saved chains, and says why.
      if ((raw as { type?: unknown } | null)?.type === "save") await this.store.refuse();
      return;
    }
    switch (message.type) {
      case "ready":
        await this.store.load();
        this.post();
        this.postChat({ type: "chat", chat: this.ctx.state.chat?.view() ?? IDLE_CHAT, entries: this.ctx.state.chat?.entries() ?? [] });
        if (!this.palette) await this.discover();
        return;
      case "save":
        await this.store.save((chains) => (chains.some((c) => c.id === message.chain.id) ? chains.map((c) => (c.id === message.chain.id ? message.chain : c)) : [...chains, message.chain]));
        return;
      case "delete": {
        const chain = this.store.chains.find((c) => c.id === message.id);
        if (!chain) return;
        const choice = await vscode.window.showWarningMessage(`Delete the chain ${plain(chain.name)}?`, { modal: true }, "Delete");
        if (choice === "Delete") await this.store.save((chains) => chains.filter((c) => c.id !== message.id));
        else this.post();
        return;
      }
      case "run": {
        const chain = [...TEMPLATES, ...this.store.chains].find((c) => c.id === message.id);
        if (chain) await this.run(chain);
        return;
      }
      case "refreshPalette":
        await this.discover();
        return;
      case "openMskills":
        await vscode.env.openExternal(vscode.Uri.parse(MSKILLS_URL));
        return;
      case "checkEnvironment":
        await vscode.commands.executeCommand("coordiner.checkEnvironment");
        return;
      default:
        this.chat(message);
    }
  }

  // The chat acts only on the run that is going, or on the chat after it; Talk itself refuses what does not fit the moment (a stale
  // question, an empty message).
  private chat(message: ChatAction): void {
    const { state } = this.ctx;
    const { chat, abort, after } = state;
    if (!chat || (!abort && !after)) {
      this.ctx.output.appendLine("Coordiner: ignored a chat message; no run is going.");
      return;
    }
    const actions = {
      stop: () => {
        if (abort) return abort.abort();
        endAfter(state);
        this.ctx.onRunChange();
      },
      copyResume: () => void (after && this.copyResume(after)),
      // The user runs it, if they choose to; coordiner only puts it on the clipboard.
      copyText: (text: string) => void vscode.env.clipboard.writeText(text),
      nextChain: () => void (after && startCommand(this, after.here)),
    };
    if (!actOnChat(chat.talk, actions, message)) this.ctx.output.appendLine(`Coordiner: the run's chat did not accept a ${message.type} message.`);
  }

  // Built here from the worktree and the session id, never from the page.
  private async copyResume({ here, sessionId }: After): Promise<void> {
    const command = resumeCommand(here.worktree.path, sessionId);
    if (command) await vscode.env.clipboard.writeText(command);
    else await vscode.window.showWarningMessage(`Coordiner: no resume command for this session; its worktree path has a control character. Run claude --resume ${sessionId} in the worktree.`);
  }

  // Asks a session for its skills without running a model turn; once per window, or again on "Try again".
  private async discover(): Promise<void> {
    const cwd = openFolder();
    this.palette = undefined;
    this.paletteError = undefined;
    this.models = undefined;
    this.modelsError = undefined;
    if (cwd === undefined) {
      this.paletteError = "open a folder first; skills are listed for the open folder.";
      this.post();
      return;
    }
    this.post();
    const config = vscode.workspace.getConfiguration("coordiner");
    const env = sessionEnvFor(config);
    const claude = await claudeFor(config, env);
    const result = claude.ok ? await listCommands({ cwd, env, claudePath: claude.path }) : claude;
    if (result.ok) {
      this.palette = palette(result.commands);
      this.mskills = mskillsPresent(result.commands);
      if (result.models) this.models = modelOptions(result.models);
      if (result.modelsError) this.modelsError = plain(result.modelsError);
    } else {
      this.paletteError = plain(result.error);
    }
    this.post();
  }
}

// With `here`, the picked chain runs in that worktree instead of a new one.
async function startCommand(editor: ChainsEditor, here?: Here): Promise<void> {
  const { templates, chains } = await editor.startable();
  const items = startItems(templates, chains).map((i): vscode.QuickPickItem & { id?: string } =>
    "separator" in i ? { label: i.separator, kind: vscode.QuickPickItemKind.Separator } : i,
  );
  const picked = await vscode.window.showQuickPick(items, { title: "Start", placeHolder: "A template, a single skill, or one of your chains" });
  const chain = pickedChain(picked?.id, templates, chains);
  if (chain) await editor.run(chain, here);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Coordiner");
  const provider = new SessionsProvider();
  const view = vscode.window.createTreeView("coordiner.run", { treeDataProvider: provider });
  const state: RunState = {};
  // Reveal without stealing focus; a hidden view just rejects, which is fine.
  const reveal = (step: RunItem) => void view.reveal(step, { focus: false, select: false }).then(undefined, () => undefined);
  let editor: ChainsEditor | undefined;
  // The Sessions view's Stop button shows while the slot is held and while the chat after a run is open.
  const changed = () => {
    editor?.post();
    provider.setOpen(state.open && { title: state.open.title, phase: state.abort ? "running" : state.after ? "chat open" : "ended" });
    void vscode.commands.executeCommand("setContext", "coordiner.busy", ctx.slot.busy() || state.after !== undefined);
  };
  // Only the newest listing is shown, so a slow one cannot replace a later one.
  const skipped = new Set<string>();
  let listing = 0;
  const sessionsChanged = () => {
    const mine = ++listing;
    void loadSessions(ctx, skipped).then((runs) => mine === listing && provider.setPast(runs));
  };
  const ctx: RunContext = {
    state,
    slot: oneRun(changed),
    provider,
    reveal,
    output,
    storage: context.globalStorageUri,
    onRunChange: changed,
    postChat: (message) => editor?.postChat(message),
    needsYou: (card) => editor?.needsYou(card),
    sessionsChanged,
  };
  editor = new ChainsEditor(context.extensionUri, join(context.globalStorageUri.fsPath, "chains.json"), ctx);
  const story = TEMPLATES.find((t) => t.id === "story")!;
  sessionsChanged();

  context.subscriptions.push(
    output,
    view,
    // Another window may have run something meanwhile.
    view.onDidChangeVisibility(({ visible }) => visible && sessionsChanged()),
    vscode.commands.registerCommand("coordiner.checkEnvironment", () => checkEnvironmentCommand(output)),
    // The argument is the row's journal file name, looked up in the listing.
    vscode.commands.registerCommand("coordiner.openSession", (file: unknown) => openSession(file, editor, ctx)),
    vscode.commands.registerCommand("coordiner.runStory", () => runChainCommand(story, ctx)),
    vscode.commands.registerCommand("coordiner.start", () => startCommand(editor)),
    vscode.commands.registerCommand("coordiner.openChains", () => editor.open()),
    // The argument is the tree item the button sits on.
    vscode.commands.registerCommand("coordiner.stopProcess", async (item: unknown) => {
      const process = liveProcess(provider.processes, (item as { id?: unknown } | undefined)?.id);
      if (process && state.stopProcess) await state.stopProcess(process);
    }),
    // The same stop as the chat's: the run, else the chat after it. Before the sessions start, the run is waiting on a dialog or its setup.
    vscode.commands.registerCommand("coordiner.stopRun", async () => {
      if (state.abort) state.abort.abort();
      else if (state.after) {
        endAfter(state);
        changed();
        void vscode.window.showInformationMessage("Coordiner: ended the chat after the run.");
      } else if (ctx.slot.busy()) await vscode.window.showInformationMessage("Coordiner: the run is still being set up. Answer or cancel its open dialog, or wait for setup to finish.");
      else await vscode.window.showInformationMessage("Coordiner: no run is active.");
    }),
  );
}
