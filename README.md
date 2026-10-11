# Coordiner

A VS Code extension that runs one backlog story through the m-skills story flow without you at the keyboard. It creates a git worktree for the story, runs a planning and implementing session, then a fresh review session that fixes its findings and writes a commit brief. Nothing is committed: you review the worktree and commit by hand.

Coordiner is a personal tool. It runs from source in an Extension Development Host; there is no packaged `.vsix` yet.

## Prerequisites

- **VS Code or VSCodium 1.135 or newer** (`engines.vscode` in [package.json](package.json)).
- **Node.js 24 or newer** and **pnpm 10** (pinned in `packageManager` in [package.json](package.json)); `corepack enable` provides it.
- **git**.
- **Claude Code, signed in on this machine.** Sessions use your existing Claude Code login.
- **The m-skills plugin, enabled in your user Claude Code settings.** Coordiner refuses to start a session unless these commands are available: `m-skills:planning-architect`, `m-skills:implementing-architect`, `m-skills:code-review-architect-uncommitted`, `m-skills:rolling-history`.

## Run the extension from source

1. Install the dependencies and build:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   ```

   The build writes the extension to `dist/`. Run `pnpm build` again after every source change; the launch config does not build for you.

2. Open this folder in VS Code and press **F5** (launch config **Run Coordiner extension**). A second window opens, titled **Extension Development Host**, with Coordiner loaded.

3. In that window, open the git repository you want to work on, and trust it when asked. Coordiner does not run in untrusted workspaces.

A **Coordiner** icon appears in the activity bar.

## Check your setup

Run **Coordiner: Check Environment** from the Command Palette. It makes three short model calls (one per tier), resumes the first session on another model, and checks that `node` is on the PATH sessions get. Results are in the **Coordiner** output channel, one line per check; a passing run ends with the message "every environment check passed".

If a check fails, the line names the setting that fixes it:

| Failing check | Fix |
|---|---|
| `strong tier`, `medium tier` or `weak tier` | Set a full model ID in `coordiner.models.strong`, `.medium` or `.weak`. |
| `node on PATH` | Set `coordiner.extraPath` to the folder that contains `node`, for example `~/.nvm/versions/node/v24.21.0/bin`. Editors started from a launcher or a flatpak often lack your shell's PATH. |

The settings are application-scoped: set them in your user settings, not in a workspace. Their defaults are in [package.json](package.json) under `contributes.configuration`.

## Run a story

1. Write the story in a Markdown file in the open repository. Coordiner finds stories by their heading, which must start with `Story <number>` or `Slice <number>`:

   ```markdown
   ## Story 1: Add a settings page

   What the story should do, in as much detail as the planner needs.
   ```

2. Run **Coordiner: Run Story…**, pick the file, then the story.
3. Read the confirm dialog and choose **Run**. It shows the install command Coordiner will run in the new worktree (taken from the lockfile) and warns if your checkout has uncommitted changes, which the worktree will not contain.
4. Follow the steps in the **Run** view. Keep VS Code open and the computer awake: closing VS Code stops the run. **Coordiner: Stop Run** stops it by hand.

The worktree is created next to your repository at `<repo>.coordiner/<story-slug>`, on branch `coordiner/<story-slug>`. When the run finishes, the commit brief is in the **Coordiner** output. If a run halts or fails, the output prints the `claude --resume` line for the session and the m-skills commands left to run by hand.

To run the same story again, remove its worktree and branch first; Coordiner will not reuse them. From your repository:

```sh
git worktree remove ../<repo>.coordiner/<story-slug>
git branch -D coordiner/<story-slug>
```

`git worktree remove` refuses while the worktree has uncommitted changes; add `--force` only if you mean to throw them away.

For what each step does, the unattended rules, and where the run journal is kept, see **Current state** in [CHANGELOG.md](CHANGELOG.md).

## Develop

| Task | Command |
|---|---|
| Type-check | `pnpm typecheck` |
| Test | `pnpm test` |
| Test with coverage | `pnpm coverage` |
| Build | `pnpm build` |

Commit messages are checked by commitlint ([commitlint.config.js](commitlint.config.js)) through a husky hook, which `pnpm install` installs.
