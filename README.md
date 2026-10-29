<p align="center">
  <img src="media/icon.png" alt="Coordiner icon: a butler in a tuxedo and bow tie, wearing a monocle with a targeting reticle" width="160">
</p>

<h1 align="center">Coordiner</h1>

<p align="center"><strong>Chains of Claude Code skills, run unattended, each in its own git worktree.</strong></p>

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/matis-dev/coordiner?label=version" alt="Version from package.json">
  <img src="https://img.shields.io/github/license/matis-dev/coordiner" alt="License: MIT">
  <img src="https://img.shields.io/badge/VS%20Code-%E2%89%A51.135-007ACC" alt="VS Code 1.135 or newer">
</p>

A VS Code extension that runs a chain of Claude Code skills on one backlog story without you at the keyboard. It creates a git worktree for the story and runs each session of the chain in it. The default chain, **Story**, is the m-skills story flow: a planning and implementing session, then a fresh review session that fixes its findings and writes a commit brief. Nothing is committed: you review the worktree and commit by hand.

Coordiner is a personal tool. Run it from source in an Extension Development Host, or [install a packaged `.vsix`](#install-a-packaged-vsix).

## Prerequisites

- **VS Code or VSCodium 1.135 or newer** (`engines.vscode` in [package.json](package.json)).
- **Node.js 24 or newer** and **pnpm 12** (pinned in `packageManager` in [package.json](package.json)); `corepack enable` provides it.
- **git**.
- **Claude Code, installed and signed in on this machine.** Sessions run your installed `claude` with your existing login: the one set in `coordiner.claudePath`, else the first `claude` on PATH, else `~/.local/bin/claude`, else the one bundled with the Claude Code editor extension.
- **Recommended: the [m-skills](https://github.com/matis-dev/m-skills) plugin**, enabled in your Claude Code settings. Coordiner is built around it, and every shipped template uses its skills. Chains made only of your own skills run without it. A chain refuses to start when a skill it uses is not available in the session.

## How sessions run, and who pays for them

Coordiner does not call the Anthropic API itself. Each session goes through the Claude Agent SDK, which starts your `claude` as a child process (the one **Coordiner: Check Environment** reports) and exchanges JSON messages with it over stdin and stdout. That process is an ordinary Claude Code session: it loads your user and project settings, skills, plugins and hooks, and writes its transcript to `~/.claude/projects/` like any other session.

The session signs in as `claude` does in your terminal:

- **An API credential is set** in the environment sessions get (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an `apiKeyHelper`, or a Bedrock, Vertex or Foundry provider variable): usage is billed to that credential's account, whatever account you are logged in with. A session never asks before using an `ANTHROPIC_API_KEY`, as an interactive `claude` does.
- **Otherwise**: your Claude Code login (in the macOS Keychain, or `~/.claude/.credentials.json` on Linux and Windows), so usage counts against your subscription's limits, as `claude -p` does.

Sessions get the editor's full environment, plus `coordiner.extraPath`. A key exported in your shell profile therefore switches every run to API billing. To check which applies, run `claude` in a terminal and type `/status`. The full order is in [Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence).

Because the sessions run your `claude`, its version decides which models they can use. If a model needs a newer Claude Code, the run fails with a message such as `the session failed: API Error: 400 Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required`. Run `claude update`, or point `coordiner.claudePath` at a newer `claude`.

## Run the extension from source

1. Install the dependencies and build:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   ```

   The build bundles the extension and its dependencies into `dist/`. Run `pnpm build` again after every source change; the launch config does not build for you.

2. Open this folder in VS Code and press **F5** (launch config **Run Coordiner extension**). A second window opens, titled **Extension Development Host**, with Coordiner loaded.

3. In that window, open the git repository you want to work on, and trust it when asked. Coordiner does not run in untrusted workspaces.

A **Coordiner** icon appears in the activity bar. It opens the **Sessions** view.

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

   A file with no `Story <number>` or `Slice <number>` heading, such as one story per file in `docs/stories/`, runs whole: its first heading names the run.

   For a one-off you can skip the file: choose **Type a story…** in the next step and write the story in one line.

2. Run **Coordiner: Run Story…**, pick the file, then the story. The file you picked last in this workspace is listed first.
3. Read the confirm dialog and choose one of its **Run** buttons. It shows the install command Coordiner will run in the new worktree (taken from the lockfile) and warns if your checkout has uncommitted changes, which the worktree will not contain. The buttons decide what happens when a card that runs unattended asks a question:
   - **Run, wait 5 min for answers**: the question shows in the chat for 5 minutes; if you do not answer, the Recommended option is taken.
   - **Run, wait for my answers**: the question waits until you answer.
   - **Run, never wait**: the Recommended option is taken at once.

   The button you chose last in this workspace comes first, so **Enter** picks it again. A question with no Recommended option always waits for you, whichever button you chose. When the run ends, the **Coordiner** output lists every answer taken without you under **Decided without you**.
4. Follow the steps in the **Sessions** view, where the running session is on top. Keep VS Code open and the computer awake: closing VS Code stops the run, and **Continue** on its row in the **Sessions** view picks it up later. The Stop button in the **Sessions** view's title bar, or **Coordiner: Stop Run**, stops it by hand; once the run has ended, it ends the chat after the run.

   While a turn runs, its background processes (a test run, a Monitor, a subagent) are listed under its step, with their latest progress line. **Stop Process**, the stop button on the row or in its context menu (**Shift+F10**), stops one. The list clears when the turn ends.

The worktree is created next to your repository at `<repo>.coordiner/<story-slug>`, on branch `coordiner/<story-slug>`. When the run finishes, the commit brief is in the **Coordiner** output, and the notification offers **Open Worktree** (a new window on it) and **Show Output**. A message about something the output holds (a halt, a failure, a failed check) offers **Show Output**. A card that halts or fails does not end the run: it waits for you in the chat (see [Talk to a run in the chat](#talk-to-a-run-in-the-chat)). If you stop the run there, the output prints the `claude --resume` line for the session and the m-skills commands left to run by hand.

To run the same story again, remove its worktree and branch first; Coordiner will not reuse them. Choose **Remove Worktree…** on its row in the **Sessions** view (see [Go back to an earlier session](#go-back-to-an-earlier-session)), or run these from your repository:

```sh
git worktree remove ../<repo>.coordiner/<story-slug>
git branch -D coordiner/<story-slug>
```

`git worktree remove` refuses while the worktree has uncommitted changes; add `--force` only if you mean to throw them away.

When a run finishes without changing any file (an audit, say), the **Coordiner** output prints these two commands with the run's own paths, ready to paste. Coordiner removes a worktree or a branch only when you choose **Remove Worktree…**. A run that ends in rolling-history puts its commit brief in the output; any other run puts its result there.

### Go back to an earlier session

The **Sessions** view lists the open repository's lines of work under the running session, one row per worktree: the worktrees git lists on a `coordiner/<slug>` branch, and those earlier sessions ran in. The most recently active comes first. A row says how its latest run ended (done, nothing to review, halted, failed, stopped, refused, or closed mid-run if VS Code was closed while it ran) and at which card, how many files are changed in the worktree, how many commits its branch has that the main checkout's current branch does not, and when it was last active. A row whose folder is gone, or that git no longer lists as a worktree, says so.

Expand a row to see its sessions, newest first, and a session to see its steps. Click a session to open its transcript in the chains editor's chat.

Each row has these actions, as buttons and in its right-click menu:

- **Continue** — shown when the row's latest run halted, failed, was stopped, or was cut off by VS Code closing. After a confirm, the run picks up at the card it stopped at, in the session that card ran in, and writes on in the same journal. A card that had already replied is asked for its status line again rather than its work; a run that halted while the review was being prepared picks up at the review. Runs journaled before Continue existed cannot be continued.
- **Start a Chain Here** — pick a chain, as with **Start…**, and run it in that worktree: no new worktree and no setup. It asks for the chain's input as usual and is named after the worktree.
- **Open in New Window** — opens the worktree's folder in a new VS Code window. Its **Sessions** view lists the same rows as the repository's window.
- **Remove Worktree…** — deletes the worktree's folder, its branch, and the journals of its sessions, after a confirm. A second confirm names what would be lost when the worktree has uncommitted files or commits that branch does not have. It is refused while a run or a turn of the chat is going, while the chat on that worktree is open, and in the window that has the worktree open. For a row whose folder is gone or that git no longer lists, only the journals are removed; git's own record and the branch are left for you, and the **Coordiner** output says so.

When you open a session:

- If its worktree and its last session still exist, the chat is live: you can keep talking to the session, copy its resume command, or start the next chain in its worktree, as after any run.
- If the worktree is gone, the transcript is read-only and a warning says so.
- Opening a session is refused while a run or a turn of the chat is going; stop it first. Opening one ends the chat after the run that was open.
- The transcript is rebuilt from the run journal. Journals written before this list existed hold only your messages and answers, so their rows say "replies not recorded". Journals over 5 MB are left out, and the **Coordiner** output says which.

For what each step does, the unattended rules, and where the run journal is kept, see **Current state** in [CHANGELOG.md](CHANGELOG.md).

## Build and run a chain

To run something without opening the editor, run **Coordiner: Start…** (the ▶ button in the **Sessions** view's title bar, or **Start…** in the view before your first session) and pick a template, a single skill or one of your chains.

Run **Coordiner: Open Chains** (or the list button in the **Sessions** view's title bar). Templates, single skills and your own chains are on the left; the selected chain's sessions are on the right, each a row of skill cards, with a **fresh context** divider where a new conversation starts.

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

1. Select a template and choose **Duplicate to edit**. A template's skills and arguments are read-only; changing a card's model, effort or pause copies it for you, and a line under the toolbar says "Saved as <template> copy".
2. Edit the copy: rename it in the **Name** field, **Add** a skill from the list (every skill your Claude Code session offers, m-skills first), move cards with the arrow buttons or **Alt+←** / **Alt+→**, edit a card's arguments, add or remove sessions. Every change is saved at once. After you remove a card or a session, a line under the toolbar says what went, with **Undo** to put it back; it clears at your next edit or when you pick another chain. **Delete chain** sits at the far end of the toolbar and asks first. To have Run ask for an input, put one placeholder in a card's arguments:

   | Placeholder | Run asks for | What replaces it |
   |---|---|---|
   | `{{story}}` | a story from a backlog file, or a typed one | the story's heading and body |
   | `{{idea}}` | an idea, typed | your answer |
   | `{{bug}}` | a bug, typed | your answer |

   A chain uses one kind of placeholder at most. A chain with none asks only for a run name.
3. Choose **Run**. A disabled **Run** says why underneath.

### Choose a card's model and effort

Each card has a **Model** and an **Effort** list, and a **Pause for me** checkbox that makes it wait for you after each turn. On a template, changing any of them saves your own copy of the template (named "<template> copy", under **My chains**), selects it, and keeps focus on the same control; the template stays as it was.

- **By tier**, the default, runs the card on its tier's model from the `coordiner.models.*` settings, and the plan's `NEXT <tier>` lines switch it as the run goes.
- Pick a model to pin the card to it for every turn, loop turns and reminders included.
- **Effort** lists the levels the card's model takes; on **By tier**, only the levels all three tier models take. **Model default** leaves it to the model.

The lists come from the same session that lists the skills. If it cannot list its models, the editor says so: cards on **By tier** run on their tier's model, and a pinned card keeps its model, which the session checks when it starts. A card set to a model or effort the session does not offer is marked, and **Run** stays off until you change it. The **Sessions** view shows each step's model and effort. Sessions always run in auto mode with Coordiner's git guard; there is no other permission mode.

### Talk to a run in the chat

The run's chat sits under the chains in the chains editor. Until the first run of the window it is only its heading and one line, so the chains have the room; it opens when a run starts. It shows what the running card says, with its Markdown (headings, lists, tables, code), and which tools it uses, each with the input that says what it did (the command, the file) in a small box that scrolls; a box that scrolls can be reached with **Tab**. A link is a link only when it points to a web address; any other target is shown as text beside its words. A reply over 50,000 characters is shown as written. A **fresh context** divider marks where a new session starts. The card the run is on is marked **Running** in its lane, and **Waiting for you** when it waits for you or asks you something; the chat's title then says so too, the Sessions view shows it with a bell, and the Coordiner icon in the activity bar gets a badge, which you see even with the editor closed. If a card starts waiting for you while the editor is closed, the editor opens without taking focus and a notification says so. Drag the bar above the chat to change its height, or focus the bar and use **↑** / **↓** (**Home** and **End** for the smallest and largest); the editor remembers the height. **Hide chat** folds it down to its heading. **Maximize chat** gives the chat the whole column the chains use, and the editor remembers that too; press it again, **Hide chat**, or pick a chain in the list to bring the chains back. A long question form scrolls on its own, so the transcript above it stays readable.

- **A card that pauses (⏸)** waits after each of its turns. Write in the message box and choose **Send** (or press **Ctrl+Enter**); your message is its next turn, in the same conversation. When the skill asks you something, its question shows as a form: pick an option, or pick **Other** and write your own answer, then choose **Send answers**. The chat says the answers were sent, and the card carries on.
- **Continue to …** moves the chain on. It is highlighted once the card has given its status line, and you can keep talking before you choose it. A pausing card that never gave a status line simply moves on to the next card.
- **While a card works**, a line under the status shows how long its turn has run, how long since its last activity, and the last tool it used. A message you send then goes into the running turn: the card finishes the tool it is running, ends that step, and answers your message in the same turn, and the chat says your message reached it. If the turn fails or is stopped before it gets to your message, the message is queued again (or put back in the message box when the run ends). If the turn cannot take a message (it is ending, or your `claude` does not report what became of one), the message is queued and goes in front of the next turn; the queue says where it goes, including the next session (in a fresh context) when the card may finish first, and **Withdraw** takes a message back. Messages already queued keep their place: a new one queues behind them.
- **Any other card** keeps running unattended. **Pause after this turn** makes the card wait for you once its current turn ends, as a pausing card does.
- **A card that needs you** stops and waits in the chat when it cannot go on: it halted because you have to do something yourself (install a tool, log in, add a key), a turn failed, it gave no status line even after a reminder, or it reached the 20-turn cap. The status line says why. A halting card explains what happened and gives the commands to run, each in a block with a **Copy** button; read a command before you run it, since Coordiner only copies it and never runs it. A block that contains hidden characters (which can make a command read as something else) gets a warning instead of a **Copy** button. Reply in the message box to talk to the card, or fix the cause and choose **Continue …**: the card carries on in the same session, and the chain goes on to the end. Settings such as `coordiner.extraPath` are read again for every turn, so a fix you make there applies when you continue.
- **Stop run** stops the run. A message still queued when the run ends goes back into the message box.
- **When the run ends**, the transcript says how (done, halted with its reason, failed, stopped), and the chat stays open on the run's last session: each message you send is another turn of it, on the same model and effort, and needs no status line. **Copy resume command** copies `cd <worktree> && claude --resume <id>` to take the session over in a terminal. **Start the next chain here** opens **Start…** and runs the chain you pick in the same worktree, with the last card's reply as its input, after a confirm. **End chat** ends it, and so does confirming a new run.
- A question from a card that runs unattended shows in the same form. With **wait 5 min**, the form counts down the time left, and the Recommended option is taken when it runs out; the transcript shows the answer taken. Otherwise the question waits for your answer for as long as it takes; nothing runs and nothing is spent while it waits.
- While a card waits, a line under the status counts down how long the prompt cache stays warm. A message sent after that re-reads the whole conversation without the cache discount; the chat says once when the time is up. If the session has not shown how long its cache lasts, five minutes is assumed and the line says so.

Only unattended turns count toward the 20-turn cap, and **Continue** on a card that reached it gives it 20 more. Your messages and answers, and the answers taken without you, are written to the run journal.

The skill list comes from asking a Claude Code session in the open folder which skills it offers. No prompt is sent, so it costs no model turn. It runs once per window; **Refresh skills**, at the foot of the chains list, re-lists after you install or change skills. While m-skills is not installed, each chain that uses it is marked **needs m-skills** in the list.

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
