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
import { briefHeading, inputOf, INPUTS, MAX_INPUT_CHARS, MSKILLS_URL, requiredSkills, runnable, TEMPLATES, type Chain, type InputKind } from "./chains.ts";
import { editorHtml } from "./editor-html.ts";
import { runReason } from "./editor-logic.ts";
import { parseEditorMessage, type ChatMessage, type EditorState } from "./editor-protocol.ts";
import { checkEnvironment, findClaude, sessionEnv, type Models } from "./environment.ts";
import { createJournal, journalFileName } from "./journal.ts";
import { fillInput, remainingCommands, runChain, type Outcome, type RunEvent } from "./run.ts";
import { oneRun, type OneRun } from "./one-run.ts";
import { actOnChat, createRunChat, IDLE_CHAT, type ChatAction, type RunChat } from "./run-chat.ts";
import { listCommands, runTurn, type TurnControl } from "./session.ts";
import { proposeSetup, runSetup } from "./setup.ts";
import { commonEfforts, modelOptions, mskillsPresent, palette, type ModelOption, type PaletteEntry } from "./skills.ts";
import { plain } from "./text.ts";
import { applyTask, liveProcess, stopLine, type Process } from "./processes.ts";
import { finishedMessage, nothingToReviewMessage, pickedChain, processItem, startItems, stepItem, type StepView } from "./view.ts";
import { addWorktree, prepareReview, removalNote, setUpRepo, type Exec, type RepoInfo, type SetupPrompt, type Worktree } from "./worktree.ts";

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
const claudeFor = (config: vscode.WorkspaceConfiguration, env: Record<string, string | undefined>) => findClaude(config.get<string>("claudePath", ""), env, homedir(), isExecutable);
const openFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
// `stopProcess` exists while a run is going; it acts on the turn running at the time.
type RunState = { abort?: AbortController; chainId?: string; chat?: RunChat; stopProcess?: (process: Process) => Promise<void> };

type RunContext = {
  state: RunState;
  // Held from the moment Run is pressed until the run ends; `state.abort` only exists once the sessions start.
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

async function runChainCommand(chain: Chain, ctx: RunContext): Promise<void> {
  if (!(await ctx.slot.run(() => startRun(chain, ctx)))) await vscode.window.showWarningMessage("Coordiner: a run is already in progress. Stop it first.");
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

async function startRun(chain: Chain, ctx: RunContext): Promise<void> {
  const { state, provider, reveal, output, storage } = ctx;
  const check = runnable(chain);
  if (!check.ok) {
    await vscode.window.showErrorMessage(`Coordiner: ${plain(chain.name)} cannot run. ${check.reason}`);
    return;
  }
  const folder = openFolder();
  if (folder === undefined) {
    await vscode.window.showErrorMessage("Coordiner: open a folder first. Sessions run in the open folder.");
    return;
  }
  let repo;
  try {
    repo = await readyRepo(folder, output);
  } catch (error) {
    await vscode.window.showErrorMessage(`Coordiner: ${(error as Error).message}`);
    return;
  }
  if (!repo) return;
  const config = vscode.workspace.getConfiguration("coordiner");
  const env = sessionEnvFor(config);
  const claude = await claudeFor(config, env);
  if (!claude.ok) {
    await vscode.window.showErrorMessage(`Coordiner: ${claude.error}`);
    return;
  }
  const input = await askInput(inputOf(chain));
  if (!input) return;
  const filled = fillInput(chain, input.text);
  if (!filled.ok) {
    await vscode.window.showErrorMessage(`Coordiner: ${filled.reason}`);
    return;
  }
  let slug;
  try {
    slug = slugify(input.name);
  } catch (error) {
    await vscode.window.showErrorMessage(`Coordiner: ${(error as Error).message}`);
    return;
  }

  // The setup command comes from the lockfile, never from the repo's own files; it is shown on every run.
  const setup = proposeSetup(await readdir(repo.root));
  const sessions = chain.sessions.map((s, i) => `${i + 1}. ${s.cards.map((c) => plain(c.label)).join(" → ")}`).join("\n");
  const detail = [
    chain.sessions.some((s) => s.cards.some((c) => c.pause))
      ? "Cards that pause wait for you in the chat under the chains editor. Every other card runs unattended: its questions are answered with the Recommended option and logged."
      : "The chain runs unattended: questions are answered with the Recommended option and logged.",
    "In the chat you can message any card (it gets your message with its next turn) or pause it after its turn. Anything auto mode will not approve is denied, and so is any git write or GitHub publish.",
    `Each session starts a fresh conversation:\n${sessions}`,
    "Keep this computer awake: the run stops if VS Code closes.",
    repo.dirty.length > 0 ? "WARNING: your checkout has uncommitted changes. They are not in the new worktree." : undefined,
    setup ? `Setup command in the new worktree: ${setup.join(" ")}` : "No setup command (no lockfile found).",
  ].filter(Boolean).join("\n\n");
  const choice = await vscode.window.showWarningMessage(`Run ${plain(chain.name)} for "${plain(input.name)}"?`, { modal: true, detail }, "Run");
  if (choice !== "Run") return;

  const added = await addWorktree(repo.root, slug, { exec, exists: (path) => access(path).then(() => true, () => false) });
  if (!added.ok) {
    if (added.detail) output.appendLine(added.detail);
    await vscode.window.showErrorMessage(`Coordiner: ${added.reason}`);
    return;
  }
  output.appendLine(`Worktree ${added.path} on branch ${added.branch}`);
  const models = readModels(config);
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
  void journal({ type: "run-started", chain: chain.name, story: input.name, repo: repo.root, worktree: added.path, branch: added.branch, models });
  output.appendLine(`Journal: ${journalFile}`);
  if (setup) {
    const result = await runSetup(setup, added.path, env, exec);
    if (!result.ok) {
      output.appendLine(result.detail);
      void journal({ type: "outcome", outcome: { status: "failed", error: result.message } });
      await vscode.window.showErrorMessage(`Coordiner: ${result.message}`);
      return;
    }
  }

  const abort = new AbortController();
  const log = (line: string) => {
    output.appendLine(line);
    void journal({ type: "log", line });
  };
  const chat = createRunChat({
    title: `${plain(chain.name)} · ${plain(input.name)}`,
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
  state.stopProcess = async (process) => {
    if (!control) return;
    try {
      await control.stopTask(process.id);
      log(stopLine(process));
    } catch {
      output.appendLine("Coordiner: that process had already ended.");
    }
  };
  let outcome: Outcome;
  try {
    outcome = await runChain(filled.chain, {
      runTurn: async ({ interactive, ...request }) => {
        try {
          return await runTurn({
            ...request,
            ...chat.forTurn(interactive),
            cwd: added.path,
            env,
            claudePath: claude.path,
            requiredCommands: required,
            signal: abort.signal,
            onGuard: log,
            onStarted: (c) => (control = c),
            onTask: (message) => provider.setProcesses(applyTask(provider.processes, message)),
          });
        } finally {
          control = undefined;
          provider.setProcesses([]);
        }
      },
      models,
      emit,
      signal: abort.signal,
      talk: chat.talk,
      prepareReview: () => prepareReview(added.path, exec),
    });
  } finally {
    chat.talk.end();
    state.abort = undefined;
    state.stopProcess = undefined;
    ctx.onRunChange();
  }
  void journal({ type: "outcome", outcome });
  await announce(outcome, input.name, { root: repo.root, path: added.path, branch: added.branch }, filled.chain, output);
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
  async run(chain: Chain): Promise<void> {
    if (!this.palette) await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Coordiner: listing skills" }, () => this.discover());
    // The webview disables Run on its own, but its state is not trusted.
    const reason = runReason(chain, { running: this.ctx.slot.busy(), ...this.discovered() });
    if (reason) {
      await vscode.window.showErrorMessage(`Coordiner: ${plain(chain.name)} cannot run. ${reason}`);
      return;
    }
    await runChainCommand(structuredClone(chain), this.ctx);
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

  // The chat acts only on the run that is going; Talk itself refuses what does not fit the moment (a stale question, an empty message).
  private chat(message: ChatAction): void {
    const { chat, abort } = this.ctx.state;
    if (!chat || !abort) {
      this.ctx.output.appendLine("Coordiner: ignored a chat message; no run is going.");
      return;
    }
    if (!actOnChat(chat.talk, () => abort.abort(), message)) this.ctx.output.appendLine(`Coordiner: the run's chat did not accept a ${message.type} message.`);
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

async function startCommand(editor: ChainsEditor): Promise<void> {
  const { templates, chains } = await editor.startable();
  const items = startItems(templates, chains).map((i): vscode.QuickPickItem & { id?: string } =>
    "separator" in i ? { label: i.separator, kind: vscode.QuickPickItemKind.Separator } : i,
  );
  const picked = await vscode.window.showQuickPick(items, { title: "Start", placeHolder: "A template, a single skill, or one of your chains" });
  const chain = pickedChain(picked?.id, templates, chains);
  if (chain) await editor.run(chain);
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
