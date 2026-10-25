# Coordiner

A VS Code extension that runs a chain of Claude Code skills on one backlog story without you at the keyboard. It creates a git worktree for the story and runs each session of the chain in it. The default chain, **Story**, is the m-skills story flow: a planning and implementing session, then a fresh review session that fixes its findings and writes a commit brief. Nothing is committed: you review the worktree and commit by hand.

Coordiner is a personal tool. Run it from source in an Extension Development Host, or [install a packaged `.vsix`](#install-a-packaged-vsix).

## Prerequisites

- **VS Code or VSCodium 1.135 or newer** (`engines.vscode` in [package.json](package.json)).
- **Node.js 24 or newer** and **pnpm 12** (pinned in `packageManager` in [package.json](package.json)); `corepack enable` provides it.
- **git**.
- **Claude Code, installed and signed in on this machine.** Sessions run your installed `claude` with your existing login: the one set in `coordiner.claudePath`, else the first `claude` on PATH, else `~/.local/bin/claude`, else the one bundled with the Claude Code editor extension.
- **Recommended: the [m-skills](https://github.com/matis-dev/m-skills) plugin**, enabled in your Claude Code settings. Coordiner is built around it, and every shipped template uses its skills. Chains made only of your own skills run without it. A chain refuses to start when a skill it uses is not available in the session.

## Run the extension from source

1. Install the dependencies and build:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   ```

   The build bundles the extension and its dependencies into `dist/`. Run `pnpm build` again after every source change; the launch config does not build for you.

2. Open this folder in VS Code and press **F5** (launch config **Run Coordiner extension**). A second window opens, titled **Extension Development Host**, with Coordiner loaded.

3. In that window, open the git repository you want to work on, and trust it when asked. Coordiner does not run in untrusted workspaces.

A **Coordiner** icon appears in the activity bar.

## Install a packaged `.vsix`

1. Build and package it. The bundle in `dist/` carries every dependency, so the package needs none of `node_modules`:

   ```sh
   pnpm install --frozen-lockfile
   pnpm dlx @vscode/vsce@4.0.0 package --no-dependencies
   ```

   `vsce` runs `pnpm build` first and writes `coordiner-<version>.vsix`.

2. Install it with **Extensions: Install from VSIX…** in the Command Palette, then reload the window.

3. Run **Coordiner: Check Environment** (below). The `claude executable` line shows which Claude Code the sessions run.

## Check your setup

Run **Coordiner: Check Environment** from the Command Palette. It first checks that sessions can find `claude`; without it nothing else that needs a session runs, and a chain refuses to start. Then it makes three short model calls (one per tier), resumes the first session on another model, reports whether m-skills is installed (information only, never a failure), and checks that `node` is on the PATH sessions get. Results are in the **Coordiner** output channel, one line per check; a passing run ends with the message "every environment check passed".

If a check fails, the line names the setting that fixes it:

| Failing check | Fix |
|---|---|
| `strong tier`, `medium tier` or `weak tier` | Set a full model ID in `coordiner.models.strong`, `.medium` or `.weak`. |
| `claude executable` | Set `coordiner.claudePath` to the full path of `claude`. A flatpak editor's PATH has no `~/.local/bin`, and a `claude` link there breaks when its target moves. |
| `node on PATH` | Set `coordiner.extraPath` to the folder that contains `node`, for example `~/.nvm/versions/node/v24.21.0/bin`. Editors started from a launcher or a flatpak often lack your shell's PATH. |

The settings are application-scoped: set them in your user settings, not in a workspace. Their defaults are in [package.json](package.json) under `contributes.configuration`.

## Run a story

A story says what should change and for whom. The **Story** template plans it, implements it, then reviews the result in a fresh session. No story yet, only an idea? Start from the **Idea** template instead (see [Build and run a chain](#build-and-run-a-chain)); its brainstorm turns the idea into one.

1. Write the story in a Markdown file in the open repository, your backlog. Coordiner finds stories by their heading, which must start with `Story <number>` or `Slice <number>`. Everything under the heading, up to the next heading of the same level, is the story:

   ```markdown
   # Backlog

   ## Story 1: Add a settings page

   As a user I can change the theme and the language from one page.
   The page opens from the gear icon. Changes apply at once, without a reload.

   ## Story 2: Export a report as CSV

   …
   ```

   For a one-off you can skip the file: choose **Type a story…** in the next step and write the story in one line.

2. Run **Coordiner: Run Story…**, pick the file, then the story.
3. Read the confirm dialog and choose **Run**. It shows the install command Coordiner will run in the new worktree (taken from the lockfile) and warns if your checkout has uncommitted changes, which the worktree will not contain.
4. Follow the steps in the **Run** view. Keep VS Code open and the computer awake: closing VS Code stops the run. **Coordiner: Stop Run** stops it by hand.

   While a turn runs, its background processes (a test run, a Monitor, a subagent) are listed under its step, with their latest progress line. **Stop Process**, the stop button on the row or in its context menu (**Shift+F10**), stops one. The list clears when the turn ends.

The worktree is created next to your repository at `<repo>.coordiner/<story-slug>`, on branch `coordiner/<story-slug>`. When the run finishes, the commit brief is in the **Coordiner** output. If a run halts or fails, the output prints the `claude --resume` line for the session and the m-skills commands left to run by hand.

To run the same story again, remove its worktree and branch first; Coordiner will not reuse them. From your repository:

```sh
git worktree remove ../<repo>.coordiner/<story-slug>
git branch -D coordiner/<story-slug>
```

`git worktree remove` refuses while the worktree has uncommitted changes; add `--force` only if you mean to throw them away.

When a run finishes without changing any file (an audit, say), the **Coordiner** output prints these two commands with the run's own paths, ready to paste. Coordiner never removes a worktree or a branch itself. A run that ends in rolling-history puts its commit brief in the output; any other run puts its result there.

For what each step does, the unattended rules, and where the run journal is kept, see **Current state** in [CHANGELOG.md](CHANGELOG.md).

## Build and run a chain

To run something without opening the editor, run **Coordiner: Start…** (the ▶ button in the **Run** view's title bar, or **Start…** in the view before your first run) and pick a template, a single skill or one of your chains.

Run **Coordiner: Open Chains** (or the list button in the **Run** view's title bar). Templates, single skills and your own chains are on the left; the selected chain's sessions are on the right, each a row of skill cards, with a **fresh context** divider where a new conversation starts.

Each template is named after what you bring to it, and **Run** asks for exactly that:

| Template | You bring | Run asks | Session 1 | Session 2 |
|---|---|---|---|---|
| **Story** (what **Run Story…** runs) | a written story | pick one from a backlog file, or type it | planning → implementing | review → fix → rolling-history |
| **Idea** | a rough idea; one line is enough | "What do you want to build?" | brainstorming ⏸ → planning → implementing | same |
| **Bug** | a symptom | "What happened, what did you expect, and how do you trigger it?" | debugging ⏸ (writes the fix itself) | same |
| **New project** | what you want to build | "What do you want to build?" | kickoff ⏸ → planning → implementing | same |

Single skills run one m-skills command on its own, in one session, and Run asks only for a run name:

| Single skill | What it does | Card |
|---|---|---|
| **Kickoff** | works out whether the project is new or existing, then plans the first slice of a new one or onboards the existing one and asks what to run next | kickoff ⏸ |
| **Onboard** | writes `.claude/PROJECT-PROFILE.md` from the repository and adopts the docs already there | onboard ⏸ |
| **Security audit** | maps trust boundaries and traces sinks to entry points; writes nothing | security-audit |
| **UI audit** | reads the interface against the craft floor and the refuse list; writes nothing | ui-audit |
| **Accessibility audit** | reads the interface against WCAG 2.2 AA and says what was not tested; writes nothing | a11y-audit |
| **Docs audit** | reads the docs against the code, a friction log with `path:line`; writes nothing | docs-audit |

Like every run, a single skill runs in its own worktree, made from your last commit: an audit reads what is committed, not your uncommitted changes. In a folder that is not a git repository yet, or has no commits, Coordiner offers to run `git init` and make a first commit, then carries on with the run. If the folder has files, the dialog lists them and commits them all (.gitignore respected); to choose which go in, cancel and commit them yourself. Kickoff on an existing project may carry on into brainstorming, planning and implementing in the same card when you pick that from its question; no review session follows it there, so run the **Story** or **Idea** template when you want one.

For a typed answer, Run then suggests a run name made from it, which you can change. The name becomes the worktree folder and the `coordiner/<name>` branch.

⏸ marks a card that pauses for you: the brainstorm, the debugging, the kickoff and the onboarding are conversations, and your answer at Run only opens them. The conversation happens in the run's chat, described below.

1. Select a template and choose **Duplicate to edit**. Templates are read-only.
2. Edit the copy: **Add** a skill from the list (every skill your Claude Code session offers, m-skills first), move cards with the arrow buttons or **Alt+←** / **Alt+→**, edit a card's arguments, add or remove sessions. Every change is saved at once. To have Run ask for an input, put one placeholder in a card's arguments:

   | Placeholder | Run asks for | What replaces it |
   |---|---|---|
   | `{{story}}` | a story from a backlog file, or a typed one | the story's heading and body |
   | `{{idea}}` | an idea, typed | your answer |
   | `{{bug}}` | a bug, typed | your answer |

   A chain uses one kind of placeholder at most. A chain with none asks only for a run name.
3. Choose **Run**. A disabled **Run** says why underneath.

### Choose a card's model and effort

Each card in your own chains has a **Model** and an **Effort** list.

- **By tier**, the default, runs the card on its tier's model from the `coordiner.models.*` settings, and the plan's `NEXT <tier>` lines switch it as the run goes.
- Pick a model to pin the card to it for every turn, loop turns and reminders included.
- **Effort** lists the levels the card's model takes; on **By tier**, only the levels all three tier models take. **Model default** leaves it to the model.

The lists come from the same session that lists the skills. If it cannot list its models, the editor says so: cards on **By tier** run on their tier's model, and a pinned card keeps its model, which the session checks when it starts. A card set to a model or effort the session does not offer is marked, and **Run** stays off until you change it. The **Run** view shows each step's model and effort. Sessions always run in auto mode with Coordiner's git guard; there is no other permission mode.

### Talk to a run in the chat

The run's chat sits under the chains in the chains editor. It shows what the running card says and which tools it uses, with a **fresh context** divider where a new session starts; the card the run is on is marked **Running** in its lane. If a card starts waiting for you while the editor is closed, the editor opens without taking focus and a notification says so. Drag the bar above the chat to change its height, or focus the bar and use **↑** / **↓** (**Home** and **End** for the smallest and largest); the editor remembers the height. **Hide chat** folds it down to its heading.

- **A card that pauses (⏸)** waits after each of its turns. Write in the message box and choose **Send** (or press **Ctrl+Enter**); your message is its next turn, in the same conversation. When the skill asks you something, its question shows as a form: pick an option, or pick **Other** and write your own answer, then choose **Send answers**.
- **Continue to …** moves the chain on. It is highlighted once the card has given its status line, and you can keep talking before you choose it. A pausing card that never gave a status line simply moves on to the next card.
- **Any other card** keeps running unattended. A message you send while it works is queued and goes in front of its next turn; the queue says where it goes, including the next session (in a fresh context) when the card may finish first, and **Withdraw** takes a message back. **Pause after this turn** makes the card wait for you once its current turn ends, as a pausing card does.
- **Stop run** stops the run. A message still queued when the run ends goes back into the message box.
- A question waits for your answer for as long as it takes; nothing runs and nothing is spent while it waits.
- While a card waits, a line under the status counts down how long the prompt cache stays warm. A message sent after that re-reads the whole conversation without the cache discount; the chat says once when the time is up. If the session has not shown how long its cache lasts, five minutes is assumed and the line says so.

Only unattended turns count toward the 20-turn cap. Your messages and answers are written to the run journal.

The skill list comes from asking a Claude Code session in the open folder which skills it offers. No prompt is sent, so it costs no model turn. It runs once per window; **Refresh skills** re-lists after you install or change skills.

Chains are saved in the extension's global storage (`chains.json`), never in your repository. A file that cannot be read is set aside as `chains.json.bak-<time>` and the editor says so.

Every session Coordiner starts denies `git` writes (commit, push, branch creation, reset and the rest), `--no-verify`, and `gh` commands that publish, whichever skills the chain uses. Read-only git and `gh` stay open. A denial is logged in the **Coordiner** output and the run journal.

## Develop

| Task | Command |
|---|---|
| Type-check | `pnpm typecheck` |
| Test | `pnpm test` |
| Test with coverage | `pnpm coverage` |
| Build | `pnpm build` |

Commit messages are checked by commitlint ([commitlint.config.js](commitlint.config.js)) through a husky hook, which `pnpm install` installs.
