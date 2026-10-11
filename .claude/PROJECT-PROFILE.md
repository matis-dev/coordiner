# Project Profile

<!-- m-skills-fingerprint: 4136376765 -->

> Seeded at kickoff (2026-10-06), rewritten 2026-10-10 when coordiner became a VS Code extension.
> Rows not settled yet carry `pending: <when>`. Each section is filled by its owning skill on first use.

## Identity

- **Project:** coordiner — a VS Code extension that drives the user's m-skills story flow through unattended Claude Code sessions, each story in its own git worktree, from a prepared backlog story up to the commit brief.
- **Stack:** TypeScript on Node ≥24, compiled to ESM JavaScript in `dist/` by tsc (no bundler), running in the VS Code extension host (VSCodium 1.135, a flatpak on the user's machine). Built on the Claude Agent SDK, exact-pinned. Only dependency added beyond it: the vscode type definitions (dev).
- **Package manager:** pnpm 10 (`packageManager` in package.json; lockfile `pnpm-lock.yaml`)
- **Repo shape:** single package; this folder is not a git repository yet.
- **Install shape:** run from source through the `Run Coordiner extension` launch config (F5). Packaging as a `.vsix` is a later slice.
- **Node on PATH:** the flatpak editor has no `node`; gates need `PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH`, and sessions get it through the `coordiner.extraPath` setting.

## Commands (role → the command this project actually uses)

| Role | Command | Notes |
|---|---|---|
| `<lint>` | n-a | decided: strict `tsc` stands in for a small personal tool — revisit if contributors join |
| `<format>` | n-a | none chosen |
| `<typecheck>` | `pnpm typecheck` | `tsc --noEmit`, strict; includes the vscode types |
| `<test>` | `pnpm test` | `node --test`, picks up `src/**/*.test.ts` |
| `<build>` | `pnpm build` | `tsc -p tsconfig.build.json`, emits `dist/` |
| `<e2e>` | n-a | no automated extension-host tests yet — the F5 smoke is manual |
| `<visual>` | n-a | built-in VS Code UI only, nothing custom rendered |
| `<a11y>` | n-a | built-in tree view, quick picks and notifications; revisit with the first webview |
| `<audit>` | `pnpm audit` | |
| `<run>` | F5, launch config `Run Coordiner extension` | needs `pnpm build` first |

Coverage: `pnpm coverage` (`node --test --experimental-test-coverage`, src only).

**Gate order:** `pnpm typecheck` → `pnpm test` → `pnpm coverage` → `pnpm build` → `pnpm audit`

## Conventions

- **Design system / UI vocabulary:** VS Code's own — tree view, quick pick, modal message, output channel, theme icons. Nothing custom until the first webview.
- **Localized?** no
- **Test layers in use:** unit only — `node:test` and strict assert; everything that touches the outside (SDK query, git and install commands, the filesystem) is injected as a parameter and faked in tests.
- **Test file placement:** next to the source as `src/<name>.test.ts`.
- **Coverage bar:** 100% branch on new functions; `src/extension.ts` (the only file that imports vscode) is the justified exception, covered by the manual F5 smoke.
- **Seam rule:** only `src/extension.ts` imports vscode; every other module is plain TypeScript.

## Design

- **Does this project have a UI?** yes, built-in VS Code views only (visitor mode: Operate). The direction brief is deferred to the first webview slice.

## Security

- **Auth model:** n-a — local tool; Claude credentials come from the user's existing Claude Code login.
- **Untrusted input enters at:** model output (final text including the commit brief, AskUserQuestion input, names of files a session creates), headings and bodies of backlog files from a cloned repo, and the repo's lockfiles. Backlog story bodies are passed to the model verbatim by design (size-capped).
- **Controls:** status markers are read from the last line only; story names become branch and directory names only through a strict slug (re-checked before git is called); git and install commands run as argument arrays, never through a shell; the install command is derived from the lockfile and shown in a confirm dialog on every run; model text shown in the UI has control characters stripped; settings are application-scoped so a repo cannot set them; the extension declares untrusted workspaces unsupported; new files are marked for review with intent-to-add, passed after `--` with `--literal-pathspecs` (so a name like `:!other` cannot exclude another file) from NUL-separated `ls-files` output and capped at 200 (`src/worktree.ts` `prepareReview`); the commit brief is shown through `plain()` and never offered as a command to copy or run.
- **Unattended session permissions:** `permissionMode: "auto"`; anything auto mode will not approve is denied and logged (no one is there to answer). Questions get the Recommended option and are logged.
- **Fail-closed rule:** refuse to run a turn if the m-skills commands are absent from the init message (no plugin = no git-guard hook) or if the session runs a different model than requested.
- **Standard tracked:** OWASP Top 10:2025
- **Audit gate:** `pnpm audit`

## Distribution

- n-a — personal tool, not built to be found (decided at kickoff).

## Documentation Targets

| Doc | Path | Notes |
|---|---|---|
| Changelog | `CHANGELOG.md` | the one changelog; a **Current state** baseline at the top, then dated entries newest first |
| README | `README.md` | prerequisites, run from source (F5), the develop commands |
| Architecture / deployment / API / tests docs | n-a | none; the profile carries those facts |

## Commit Convention

- **Enforced by:** `commitlint.config.js` (`@commitlint/config-conventional`) through the husky `commit-msg` hook.
- **Header:** `<type>: <subject>`, at most 100 characters, scope optional (not used so far).
- **Types:** `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.
- **Subject case:** lower-case start — sentence-case, start-case, PascalCase and UPPER CASE are rejected; no trailing full stop.
- **Body / footer:** lines at most 100 characters; blank line after the header.

## Deployment

n-a beyond the install shape above — no hosting, environments, or rollback.

## Guardrails Specific to This Project

- **Do not touch:** pending
- **Known blind spots:** the extension host wiring (`src/extension.ts`) and the real SDK, git and install commands are not covered by automated tests; slice 1 is verified by the F5 smoke only. The exact arguments for creating a worktree are inferred from git's usage, not run. Intent-to-add marking of new files, and the uncommitted review seeing them, is verified only by the F5 smoke.
- **Coordinator state lives outside target repos.** The per-story journal is JSONL under the extension's `globalStorageUri/journal/` (`<slug>-<UTC stamp>.jsonl`), never in a worktree, because `code-review-architect-uncommitted` would review it as a change.

## Recurring Propagation Sites

- Planner tiers (Light, Standard, Heavy) map to the user's strong, medium and weak models in `src/protocol.ts`; the `COORDINER:` status-line grammar lives in `src/protocol.ts` (parser and the unattended note) and must change together.
- The m-skills commands a session needs are listed in `src/session.ts` (`REQUIRED_COMMANDS`); the session scripts that send them (`sessionOne`, `SESSION_TWO`) and `remainingCommands` live in `src/run.ts` and change with `UNATTENDED_NOTE`.
- `JournalRecord` in `src/journal.ts` embeds `RunEvent` and `Outcome` from `src/run.ts`: a shape change there changes the journal format.
