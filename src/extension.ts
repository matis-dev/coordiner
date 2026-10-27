import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { parseStories, slugify, storyText, type Story } from "./backlog.ts";
import { ChainStore, type StoreFs } from "./chain-store.ts";
import { briefHeading, inputOf, INPUTS, MAX_INPUT_CHARS, MSKILLS_URL, requiredSkills, runnable, TEMPLATES, type Chain, type Effort, type InputKind } from "./chains.ts";
import { editorHtml } from "./editor-html.ts";
import { runReason } from "./editor-logic.ts";
import { parseEditorMessage, type ChatMessage, type EditorState } from "./editor-protocol.ts";
import { bundledClaudePath, checkEnvironment, findClaude, sessionEnv, type Models } from "./environment.ts";
import { createJournal, journalFileName, type JournalRecord } from "./journal.ts";
import { replyOf } from "./protocol.ts";
import { fillInput, remainingCommands, runChain, talkOn, type AfterAsk, type Outcome, type RunEvent } from "./run.ts";
import { oneRun, type OneRun } from "./one-run.ts";
import { actOnChat, createRunChat, IDLE_CHAT, type ChatAction, type RunChat, type TurnMode } from "./run-chat.ts";
import { listCommands, runTurn, type TurnControl, type TurnResult } from "./session.ts";
import { proposeSetup, runSetup } from "./setup.ts";
import { commonEfforts, modelOptions, mskillsPresent, palette, type ModelOption, type PaletteEntry } from "./skills.ts";
import { plain } from "./text.ts";
import { applyTask, liveProcess, stopLine, type Process } from "./processes.ts";
import { finishedMessage, nothingToReviewMessage, pickedChain, processItem, startItems, stepItem, type StepView } from "./view.ts";
import { addWorktree, prepareReview, removalNote, resumeCommand, setUpRepo, type Exec, type RepoInfo, type SetupPrompt, type Worktree } from "./worktree.ts";

const run = promisify(execFile);
const exec: Exec = (file, args, options) => run(file, args, options);

// The run's steps, and under the running one the background processes of its turn.
type RunItem = StepView | Process;
const isProcess = (item: RunItem): item is Process => "id" in item;

class StepsProvider implements vscode.TreeDataProvider<RunItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  steps: StepView[] = [];
  processes: Process[] = [];

  update(steps: StepView[]): void {
    this.steps = steps;
    this.changed.fire();
  }

  setProcesses(processes: Process[]): void {
    this.processes = processes;
    this.changed.fire();
  }

  private running(): StepView | undefined {
    return this.steps.findLast((s) => s.status === "running");
  }

  getTreeItem(element: RunItem): vscode.TreeItem {
    const view = isProcess(element) ? processItem(element, this.running()?.label ?? "") : stepItem(element);
    const item = new vscode.TreeItem(view.label);
    item.description = view.description;
    item.iconPath = new vscode.ThemeIcon(view.icon);
    item.accessibilityInformation = { label: view.accessibleLabel, role: "treeitem" };
    // The Stop process action (inline, and in the context menu for the keyboard) shows on these items only.
    if (isProcess(element)) item.contextValue = "process";
    else if (element === this.running() && this.processes.length > 0) item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    return item;
  }

  getChildren(element?: RunItem): vscode.ProviderResult<RunItem[]> {
    if (!element) return this.steps;
    return !isProcess(element) && element === this.running() ? this.processes : [];
  }

  getParent(element: RunItem): RunItem | undefined {
    return isProcess(element) ? this.running() : undefined;
  }
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
  const stories = parseStories(await readFile(picked.uri.fsPath, "utf8"));
  if (stories.length === 0) {
    await vscode.window.showInformationMessage(`Coordiner: no stories found in ${picked.label}. Headings look like "## Story 1: …" or "### Slice 2: …"; or choose "Type a story…".`);
    return undefined;
  }
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

// The commit brief is model text: it is shown, never offered as a command to copy or run.
async function announce(outcome: Outcome, heading: string, worktree: Worktree, chain: Chain, output: vscode.OutputChannel): Promise<void> {
  const name = plain(heading);
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

// The run's chat outlives the run, so the editor still shows the last transcript after it ends, until the next run starts.
// `stopProcess` exists while a turn can run; it acts on the turn running at the time. `after` is the chat after the run.
type RunState = { abort?: AbortController; chainId?: string; chat?: RunChat; stopProcess?: (process: Process) => Promise<void>; after?: After };

// Where a next chain runs: the worktree of the run before, that run's name, and its last reply, which becomes the input.
type Here = { worktree: Worktree; name: string; slug: string; card: string; input: string };

// The run's last session, which the user keeps talking to after the run until they end the chat or confirm a new run.
type After = { abort: AbortController; chat: RunChat; here: Here; sessionId: string };

// The session the run's last turn ran in, on its model and effort, and the latest reply it gave.
type LastTurn = { sessionId: string; model: string; effort?: Effort; card: string; reply: string };

type Journal = (record: JournalRecord) => Promise<void>;

// A run the user confirmed: the filled chain, its name, and a worktree whose setup is done.
type Place = { chain: Chain; name: string; slug: string; worktree: Worktree; env: Record<string, string | undefined>; claudePath: string; models: Models; journal: Journal };

type RunContext = {
  state: RunState;
  // Held from the moment Run is pressed until the run ends, and by each turn of the chat after it; `state.abort` only exists
  // once the sessions start.
  slot: OneRun;
  provider: StepsProvider;
  reveal: (step: RunItem) => void;
  output: vscode.OutputChannel;
  storage: vscode.Uri;
  onRunChange: () => void;
  // Sends the run's chat to the chains editor, if it is open.
  postChat: (message: ChatMessage) => void;
  // A card waits for the user, or asked them something: bring the editor up without taking focus.
  needsYou: (card: string) => void;
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
    await vscode.window.showErrorMessage(`Coordiner: ${setup.reason}${setup.detail ? " See the Coordiner output." : ""}`);
  }
  return undefined;
}

// What the sessions run with: the editor's environment and the claude to start.
async function sessionTools(): Promise<{ env: Record<string, string | undefined>; claudePath: string; models: Models } | undefined> {
  const config = vscode.workspace.getConfiguration("coordiner");
  const env = sessionEnvFor(config);
  const claude = await claudeFor(config, env);
  if (!claude.ok) {
    await vscode.window.showErrorMessage(`Coordiner: ${claude.error}`);
    return undefined;
  }
  return { env, claudePath: claude.path, models: readModels(config) };
}

// What every run's confirm modal says about how the chain runs.
function runNotes(chain: Chain): string[] {
  const sessions = chain.sessions.map((s, i) => `${i + 1}. ${s.cards.map((c) => plain(c.label)).join(" → ")}`).join("\n");
  return [
    chain.sessions.some((s) => s.cards.some((c) => c.pause))
      ? "Cards that pause wait for you in the chat under the chains editor. Every other card runs unattended: its questions are answered with the Recommended option and logged."
      : "The chain runs unattended: questions are answered with the Recommended option and logged.",
    "In the chat you can message any card (it gets your message with its next turn) or pause it after its turn. Anything auto mode will not approve is denied, and so is any git write or GitHub publish.",
    `Each session starts a fresh conversation:\n${sessions}`,
    "Keep this computer awake: the run stops if VS Code closes.",
  ];
}

// A new run's journal file, which begins with where the run happens.
function startJournal(ctx: RunContext, slug: string, start: Extract<JournalRecord, { type: "run-started" }>): Journal {
  const { storage, output } = ctx;
  const journalDir = join(storage.fsPath, "journal");
  const journalFile = join(journalDir, journalFileName(slug, new Date()));
  const journal = createJournal(
    async (line) => {
      await mkdir(journalDir, { recursive: true });
      await appendFile(journalFile, line, "utf8");
    },
    () => new Date(),
    (error) => output.appendLine(`Journal not written to ${journalFile}: ${error instanceof Error ? error.message : String(error)}`),
  );
  void journal(start);
  output.appendLine(`Journal: ${journalFile}`);
  return journal;
}

// Returns the run's announcement, for after the slot is given back; nothing when the run never started.
async function startRun(chain: Chain, ctx: RunContext, here?: Here): Promise<(() => Promise<void>) | undefined> {
  const check = runnable(chain);
  if (!check.ok) {
    await vscode.window.showErrorMessage(`Coordiner: ${plain(chain.name)} cannot run. ${check.reason}`);
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
    await vscode.window.showErrorMessage("Coordiner: open a folder first. Sessions run in the open folder.");
    return undefined;
  }
  let repo;
  try {
    repo = await readyRepo(folder, output);
  } catch (error) {
    await vscode.window.showErrorMessage(`Coordiner: ${(error as Error).message}`);
    return undefined;
  }
  if (!repo) return undefined;
  const tools = await sessionTools();
  if (!tools) return undefined;
  const input = await askInput(inputOf(chain));
  if (!input) return undefined;
  const filled = fillInput(chain, input.text);
  if (!filled.ok) {
    await vscode.window.showErrorMessage(`Coordiner: ${filled.reason}`);
    return undefined;
  }
  let slug;
  try {
    slug = slugify(input.name);
  } catch (error) {
    await vscode.window.showErrorMessage(`Coordiner: ${(error as Error).message}`);
    return undefined;
  }

  // The setup command comes from the lockfile, never from the repo's own files; it is shown on every run.
  const setup = proposeSetup(await readdir(repo.root));
  const detail = [
    ...runNotes(chain),
    repo.dirty.length > 0 ? "WARNING: your checkout has uncommitted changes. They are not in the new worktree." : undefined,
    setup ? `Setup command in the new worktree: ${setup.join(" ")}` : "No setup command (no lockfile found).",
  ].filter(Boolean).join("\n\n");
  const choice = await vscode.window.showWarningMessage(`Run ${plain(chain.name)} for "${plain(input.name)}"?`, { modal: true, detail }, "Run");
  if (choice !== "Run") return undefined;
  endAfter(ctx.state);

  const added = await addWorktree(repo.root, slug, { exec, exists });
  if (!added.ok) {
    if (added.detail) output.appendLine(added.detail);
    await vscode.window.showErrorMessage(`Coordiner: ${added.reason}`);
    return undefined;
  }
  output.appendLine(`Worktree ${added.path} on branch ${added.branch}`);
  const worktree = { root: repo.root, path: added.path, branch: added.branch };
  const journal = startJournal(ctx, slug, { type: "run-started", chain: chain.name, story: input.name, repo: repo.root, worktree: added.path, branch: added.branch, models: tools.models });
  if (setup) {
    const result = await runSetup(setup, added.path, tools.env, exec);
    if (!result.ok) {
      output.appendLine(result.detail);
      void journal({ type: "outcome", outcome: { status: "failed", error: result.message } });
      await vscode.window.showErrorMessage(`Coordiner: ${result.message}`);
      return undefined;
    }
  }
  return { chain: filled.chain, name: input.name, slug, worktree, ...tools, journal };
}

// A next chain in the worktree of the run before: no new worktree and no setup, and its input is that run's last reply.
async function confirmHere(chain: Chain, here: Here, ctx: RunContext): Promise<Place | undefined> {
  const { worktree, card } = here;
  if (!(await exists(worktree.path))) {
    await vscode.window.showErrorMessage(`Coordiner: ${plain(worktree.path)} no longer exists, so ${plain(chain.name)} cannot run there.`);
    return undefined;
  }
  const tools = await sessionTools();
  if (!tools) return undefined;
  const takesInput = inputOf(chain) !== undefined;
  if (takesInput && here.input.trim() === "") {
    await vscode.window.showErrorMessage(`Coordiner: ${plain(card)} gave no reply to start ${plain(chain.name)} from.`);
    return undefined;
  }
  const filled = fillInput(chain, here.input);
  if (!filled.ok) {
    await vscode.window.showErrorMessage(`Coordiner: ${filled.reason}`);
    return undefined;
  }
  const detail = [
    `In the same worktree, ${worktree.path}. It keeps the run before's changes, uncommitted, and its setup is already done.`,
    takesInput ? `Input: ${plain(card)}'s last reply, ${here.input.length} characters.` : "This chain takes no input.",
    ...runNotes(chain),
  ].join("\n\n");
  const choice = await vscode.window.showWarningMessage(`Run ${plain(chain.name)} in the same worktree?`, { modal: true, detail }, "Run");
  if (choice !== "Run") return undefined;
  endAfter(ctx.state);
  const journal = startJournal(ctx, here.slug, { type: "run-started", chain: chain.name, story: here.name, repo: worktree.root, worktree: worktree.path, branch: worktree.branch, models: tools.models });
  return { chain: filled.chain, name: here.name, slug: here.slug, worktree, ...tools, journal };
}

// Runs the chain in its place, then leaves the chat open on the last session. Returns the run's announcement.
async function runIn(place: Place, ctx: RunContext): Promise<() => Promise<void>> {
  const { state, provider, reveal, output } = ctx;
  const { chain, name, worktree, env, claudePath, models, journal } = place;
  const abort = new AbortController();
  const log = (line: string) => {
    output.appendLine(line);
    void journal({ type: "log", line });
  };
  const chat = createRunChat({
    title: `${plain(chain.name)} · ${plain(name)}`,
    post: ctx.postChat,
    record: (r) => void journal(r),
    moved: ctx.onRunChange,
    needsYou: ctx.needsYou,
    log,
  });
  Object.assign(state, { abort, chainId: chain.id, chat });
  ctx.onRunChange();
  provider.update([]);
  const emit = (event: RunEvent) => {
    void journal(event);
    if (event.type === "step-started") {
      provider.update([...provider.steps, { label: event.label, tier: event.tier, model: event.model, ...(event.effort ? { effort: event.effort } : {}), status: "running" }]);
      reveal(provider.steps[event.index]!);
      return;
    }
    provider.update(provider.steps.map((step, i) => (i === event.index ? { ...step, status: event.status, detail: event.detail } : step)));
  };
  const required = requiredSkills(chain);
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
  state.stopProcess = stopProcess;
  let last: LastTurn | undefined;
  const turn = async ({ mode, ...request }: AfterAsk & { mode: TurnMode }, signal: AbortSignal): Promise<TurnResult> => {
    const card = chat.talk.snapshot().card ?? "";
    let result: TurnResult;
    try {
      result = await runTurn({
        ...request,
        ...chat.forTurn(mode),
        cwd: worktree.path,
        env,
        claudePath,
        requiredCommands: required,
        signal,
        onGuard: log,
        onStarted: (c) => (control = c),
        onTask: (message) => provider.setProcesses(applyTask(provider.processes, message)),
      });
    } finally {
      control = undefined;
      provider.setProcesses([]);
    }
    if (result.sessionId) {
      const reply = result.ok ? replyOf(result.resultText) : (last?.reply ?? "");
      last = { sessionId: result.sessionId, model: request.model, ...(request.effort ? { effort: request.effort } : {}), card, reply };
    }
    return result;
  };
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
  chat.ended(outcome, last && { card: last.card });
  if (last) talkAfter(last, { chat, place, ctx, stopProcess, turn });
  const ended = outcome;
  return () => announce(ended, name, worktree, chain, output);
}

// The chat after the run: each message is a turn of the run's last session, and each turn holds the slot, so a new run waits
// for it. A failed turn is shown in the transcript and the chat stays open.
function talkAfter(
  last: LastTurn,
  { chat, place, ctx, stopProcess, turn }: { chat: RunChat; place: Place; ctx: RunContext; stopProcess: RunState["stopProcess"]; turn: (request: AfterAsk & { mode: TurnMode }, signal: AbortSignal) => Promise<TurnResult> },
): void {
  const abort = new AbortController();
  const here: Here = { worktree: place.worktree, name: place.name, slug: place.slug, card: last.card, input: last.reply };
  const after: After = { abort, chat, here, sessionId: last.sessionId };
  Object.assign(ctx.state, { after, stopProcess });
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
      stop: () => (abort ? abort.abort() : endAfter(state)),
      copyResume: () => void (after && this.copyResume(after)),
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
  const provider = new StepsProvider();
  const view = vscode.window.createTreeView("coordiner.run", { treeDataProvider: provider });
  const state: RunState = {};
  // Reveal without stealing focus; a hidden view just rejects, which is fine.
  const reveal = (step: RunItem) => void view.reveal(step, { focus: false, select: false }).then(undefined, () => undefined);
  let editor: ChainsEditor | undefined;
  const ctx: RunContext = {
    state,
    slot: oneRun(() => editor?.post()),
    provider,
    reveal,
    output,
    storage: context.globalStorageUri,
    onRunChange: () => editor?.post(),
    postChat: (message) => editor?.postChat(message),
    needsYou: (card) => editor?.needsYou(card),
  };
  editor = new ChainsEditor(context.extensionUri, join(context.globalStorageUri.fsPath, "chains.json"), ctx);
  const story = TEMPLATES.find((t) => t.id === "story")!;

  context.subscriptions.push(
    output,
    view,
    vscode.commands.registerCommand("coordiner.checkEnvironment", () => checkEnvironmentCommand(output)),
    vscode.commands.registerCommand("coordiner.runStory", () => runChainCommand(story, ctx)),
    vscode.commands.registerCommand("coordiner.start", () => startCommand(editor)),
    vscode.commands.registerCommand("coordiner.openChains", () => editor.open()),
    // The argument is the tree item the button sits on.
    vscode.commands.registerCommand("coordiner.stopProcess", async (item: unknown) => {
      const process = liveProcess(provider.processes, (item as { id?: unknown } | undefined)?.id);
      if (process && state.stopProcess) await state.stopProcess(process);
    }),
    vscode.commands.registerCommand("coordiner.stopRun", async () => {
      if (state.abort) state.abort.abort();
      else await vscode.window.showInformationMessage("Coordiner: no run is active.");
    }),
  );
}
