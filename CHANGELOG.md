# Changelog

Newest entry first. The **Current state** section describes the extension as it is now, not how it got here.

## Current state (last synced 2026-10-11)

- **Commands:** `Coordiner: Check Environment`, `Coordiner: Run Story…`, `Coordiner: Stop Run`; a Run view in the activity bar lists each step with its tier, model and status.
- **Run Story:** pick a Markdown backlog file, then a story (`## Story N: …` / `### Slice N: …` headings, body capped at 20,000 characters). A modal confirm shows what will happen, then a worktree is created at `<repo>.coordiner/<slug>` on branch `coordiner/<slug>` from `HEAD`, and the lockfile-derived install command runs in it.
- **Session 1 (author):** `planning-architect` on the strong model, then `implementing-architect` in the same session, switching model at each tier stop (Heavy/Standard/Light → strong/medium/weak) as reported by the `COORDINER:` status line.
- **Session 2 (review, fresh session):** new files are marked intent-to-add (literal pathspecs, cap 200), then `code-review-architect-uncommitted` → `implementing-architect fix the findings` → `rolling-history`. The commit brief is shown in the Coordiner output; nothing is committed.
- **Stops:** a halt or failure prints the `claude --resume` line for the session and the m-skills commands left to run by hand; a story that changed no file ends as "nothing to review".
- **Unattended rules:** permission mode `auto`, questions take the Recommended option and are logged, a turn is refused if the m-skills commands are missing or the model differs from the one requested; each session is capped at 20 turns.
- **Journal:** one JSONL file per run under the extension's global storage (`journal/<slug>-<UTC stamp>.jsonl`), never inside the worktree.

## 2026-10-11 — build: Switch the package manager from npm to pnpm

- `package-lock.json` converted with `pnpm import`, so `pnpm-lock.yaml` resolves the same versions npm had installed; `package-lock.json` removed.
- `package.json` pins `"packageManager": "pnpm@10.33.2"`. No dependency runs an install script, so pnpm 10's blocked-builds default changes nothing; the root `prepare` script (husky) still runs on install.
- The husky `commit-msg` hook calls `pnpm exec commitlint` instead of `npx --no -- commitlint`.
- README, the profile's command rows and gate order now use `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm coverage`, `pnpm build` and `pnpm audit`; `.gitignore` ignores `pnpm-debug.log*` instead of `npm-debug.log*`.
- Unchanged on purpose: `src/setup.ts` picks the install command from the *target* repo's lockfile and already handled pnpm.
- **Why it matters:** the project now installs and runs its gates with pnpm, with the same dependency versions as before; typecheck, 117 tests, build and the audit (no known vulnerabilities) all pass after the switch.
- **Affected:** `package.json`, `pnpm-lock.yaml`, `package-lock.json` (removed), `.husky/commit-msg`, `.gitignore`, `README.md`, `.claude/PROJECT-PROFILE.md`.

## 2026-10-10 — feat: Session two and the run journal (slice 2)

- `runStorySession` became `runSession(script, deps)`, driven by a `Script` (`open` turn, `work` loop on `NEXT`, optional `close` turn on `DONE`). `sessionOne(story)` is plan → implement; `SESSION_TWO` is review → fix → history. A `NEXT` in the closing turn counts as a missing status line (one reminder, then halt).
- `runStory` runs session 1, then `prepareReview`, then session 2 as a **fresh** session (never a resume) so the reviewer does not share the author's context. Step numbers continue across both sessions.
- `prepareReview` (`src/worktree.ts`): `git status --porcelain` → `no-changes` on a clean tree; otherwise NUL-separated `ls-files --others --exclude-standard` and `git --literal-pathspecs add --intent-to-add -- …`, so new files appear in `git diff HEAD` without staging their content. More than 200 new files halts the run (usually a missing `.gitignore` entry). `--literal-pathspecs` stops a model-chosen name like `:!src/x.ts` from excluding another file from the review.
- `Outcome`: `done` carries the commit brief text (status line stripped by `withoutStatus`); new `no-changes`; `halted` carries `sessionId`; a halt or failure before the review sets `beforeReview`. `remainingCommands(outcome, labels)` lists what is left to run by hand.
- `UNATTENDED_NOTE` tells the review, fix and history phases how to end.
- Journal (`src/journal.ts`): `createJournal` writes one JSON line per record in call order; a failed write is reported once and never stops the run.
- **Why it matters:** a story now runs unattended all the way to a reviewed, fixed change and a commit brief, and every run leaves a record you can read afterwards.
- **Affected:** `src/run.ts`, `src/protocol.ts`, `src/worktree.ts`, `src/journal.ts`, `src/extension.ts`, `.claude/PROJECT-PROFILE.md`.
