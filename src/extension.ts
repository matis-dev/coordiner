import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { parseStories, slugify, type Story } from "./backlog.ts";
import { checkEnvironment, sessionEnv, type Models } from "./environment.ts";
import { UNATTENDED_NOTE } from "./protocol.ts";
import { runStorySession, type Outcome, type RunEvent } from "./run.ts";
import { runTurn } from "./session.ts";
import { proposeSetup, runSetup } from "./setup.ts";
import { plain } from "./text.ts";
import { unattendedCanUseTool } from "./unattended.ts";
import { stepItem, type StepView } from "./view.ts";
import { addWorktree, inspectRepo, type Exec } from "./worktree.ts";

const run = promisify(execFile);
const exec: Exec = (file, args, options) => run(file, args, options);

class StepsProvider implements vscode.TreeDataProvider<StepView> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  steps: StepView[] = [];

  update(steps: StepView[]): void {
    this.steps = steps;
    this.changed.fire();
  }

  getTreeItem(step: StepView): vscode.TreeItem {
    const view = stepItem(step);
    const item = new vscode.TreeItem(view.label);
    item.description = view.description;
    item.iconPath = new vscode.ThemeIcon(view.icon);
    item.accessibilityInformation = { label: view.accessibleLabel, role: "treeitem" };
    return item;
  }

  getChildren(): vscode.ProviderResult<StepView[]> {
    return this.steps;
  }

  getParent(): undefined {
    return undefined;
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
const openFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

async function checkEnvironmentCommand(output: vscode.OutputChannel): Promise<void> {
  const cwd = openFolder();
  if (cwd === undefined) {
    await vscode.window.showErrorMessage("Coordiner: open a folder first. Sessions run in the open folder.");
    return;
  }
  const config = vscode.workspace.getConfiguration("coordiner");
  output.show(true);
  output.appendLine("Checking the environment: three short model calls and one resume.");
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Coordiner: checking the environment" },
    () =>
      checkEnvironment({
        runTurn,
        nodeVersion: async (env) => (await run("node", ["--version"], { env })).stdout.trim(),
        models: readModels(config),
        cwd,
        env: sessionEnvFor(config),
        canUseTool: async () => ({ behavior: "deny", message: "Check Environment uses no tools." }),
      }),
  );
  output.appendLine("extension activation: ok");
  for (const r of results) output.appendLine(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) await vscode.window.showInformationMessage("Coordiner: every environment check passed.");
  else await vscode.window.showErrorMessage(`Coordiner: ${failed.length} environment check(s) failed. See the Coordiner output.`);
}

async function pickStory(): Promise<Story | undefined> {
  const files = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**", 200);
  const file = await vscode.window.showQuickPick(
    files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    { placeHolder: "Backlog file" },
  );
  if (!file) return undefined;
  const stories = parseStories(await readFile(file.uri.fsPath, "utf8"));
  if (stories.length === 0) {
    await vscode.window.showInformationMessage(`Coordiner: no stories found in ${file.label}. Headings look like "## Story 1: …" or "### Slice 2: …".`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    stories.map((story) => ({ label: plain(story.heading), story })),
    { placeHolder: "Story to run" },
  );
  return picked?.story;
}

async function announce(outcome: Outcome, heading: string, worktree: string, output: vscode.OutputChannel): Promise<void> {
  const name = plain(heading);
  switch (outcome.status) {
    case "done":
      await vscode.window.showInformationMessage(`Coordiner: ${name} is finished. Review the worktree at ${worktree}.`);
      return;
    case "halted":
      await vscode.window.showWarningMessage(`Coordiner: ${name} halted: ${plain(outcome.reason)}`);
      return;
    case "stopped":
      await vscode.window.showInformationMessage(`Coordiner: ${name} was stopped.`);
      return;
    case "refused":
      await vscode.window.showErrorMessage(`Coordiner: ${plain(outcome.reason)}`);
      return;
    case "failed":
      if (outcome.sessionId) output.appendLine(`To take over this session: claude --resume ${outcome.sessionId}`);
      await vscode.window.showErrorMessage(`Coordiner: ${name} failed: ${plain(outcome.error)} See the Coordiner output.`);
  }
}

async function runStoryCommand(state: { abort?: AbortController }, provider: StepsProvider, reveal: (step: StepView) => void, output: vscode.OutputChannel): Promise<void> {
  if (state.abort) {
    await vscode.window.showWarningMessage("Coordiner: a run is already in progress. Stop it first.");
    return;
  }
  const folder = openFolder();
  if (folder === undefined) {
    await vscode.window.showErrorMessage("Coordiner: open a folder first. Sessions run in the open folder.");
    return;
  }
  let repo;
  try {
    repo = await inspectRepo(folder, exec);
  } catch (error) {
    await vscode.window.showErrorMessage(`Coordiner: ${(error as Error).message}`);
    return;
  }
  const story = await pickStory();
  if (!story) return;
  let slug;
  try {
    slug = slugify(story.heading);
  } catch (error) {
    await vscode.window.showErrorMessage(`Coordiner: ${(error as Error).message}`);
    return;
  }

  // The setup command comes from the lockfile, never from the repo's own files; it is shown on every run.
  const setup = proposeSetup(await readdir(repo.root));
  const detail = [
    "Questions are answered with the Recommended option and logged. Anything auto mode will not approve is denied.",
    "Keep this computer awake: the run stops if VS Code closes.",
    repo.dirty.length > 0 ? "WARNING: your checkout has uncommitted changes. They are not in the new worktree." : undefined,
    setup ? `Setup command in the new worktree: ${setup.join(" ")}` : "No setup command (no lockfile found).",
  ].filter(Boolean).join("\n\n");
  const choice = await vscode.window.showWarningMessage(`Run "${plain(story.heading)}" unattended?`, { modal: true, detail }, "Run");
  if (choice !== "Run") return;

  const config = vscode.workspace.getConfiguration("coordiner");
  const env = sessionEnvFor(config);
  const added = await addWorktree(repo.root, slug, { exec, exists: (path) => access(path).then(() => true, () => false) });
  if (!added.ok) {
    if (added.detail) output.appendLine(added.detail);
    await vscode.window.showErrorMessage(`Coordiner: ${added.reason}`);
    return;
  }
  output.appendLine(`Worktree ${added.path} on branch ${added.branch}`);
  if (setup) {
    const result = await runSetup(setup, added.path, env, exec);
    if (!result.ok) {
      output.appendLine(result.detail);
      await vscode.window.showErrorMessage(`Coordiner: ${result.message}`);
      return;
    }
  }

  const abort = new AbortController();
  state.abort = abort;
  provider.update([]);
  const log = (line: string) => output.appendLine(line);
  const emit = (event: RunEvent) => {
    if (event.type === "step-started") {
      provider.update([...provider.steps, { label: event.label, tier: event.tier, model: event.model, status: "running" }]);
      reveal(provider.steps[event.index]!);
      return;
    }
    provider.update(provider.steps.map((step, i) => (i === event.index ? { ...step, status: event.status, detail: event.detail } : step)));
  };
  let outcome: Outcome;
  try {
    outcome = await runStorySession(story, {
      runTurn: (request) => runTurn({ ...request, cwd: added.path, env, canUseTool: unattendedCanUseTool(log), systemPromptAppend: UNATTENDED_NOTE, signal: abort.signal }),
      models: readModels(config),
      emit,
      signal: abort.signal,
    });
  } finally {
    state.abort = undefined;
  }
  await announce(outcome, story.heading, added.path, output);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Coordiner");
  const provider = new StepsProvider();
  const view = vscode.window.createTreeView("coordiner.run", { treeDataProvider: provider });
  const state: { abort?: AbortController } = {};
  // Reveal without stealing focus; a hidden view just rejects, which is fine.
  const reveal = (step: StepView) => void view.reveal(step, { focus: false, select: false }).then(undefined, () => undefined);

  context.subscriptions.push(
    output,
    view,
    vscode.commands.registerCommand("coordiner.checkEnvironment", () => checkEnvironmentCommand(output)),
    vscode.commands.registerCommand("coordiner.runStory", () => runStoryCommand(state, provider, reveal, output)),
    vscode.commands.registerCommand("coordiner.stopRun", async () => {
      if (state.abort) state.abort.abort();
      else await vscode.window.showInformationMessage("Coordiner: no run is active.");
    }),
  );
}
