# Progress — Run-chat usability fixes (#1–#5)

Plan approved 2026-10-27 in session (brainstorming-planner → planning-architect → implementing-architect).

1. done — NEXT on the last card of a session ends the card as DONE (src/run.ts, src/run.test.ts) — Light. pnpm typecheck ✔; node --test src/run.test.ts 57/57 ✔ (flipped the history-NEXT test; added the Kickoff regression and the session-crossing case)

2. done — Chat after the run: Talk.end({after}), talkOn loop, AFTER_NOTE, `end` entry (endEntry) — Standard. talkOn takes its own runTurn (AfterAsk); the caller supplies AFTER_NOTE + interactive canUseTool (step 3). pnpm typecheck ✔; node --test talk/run/transcript 95/95 ✔
3. done — End entry, end actions, next chain here; split startRun — Standard. extension.ts: startRun → prepareWorktree | confirmHere → runIn; talkAfter runs talkOn, each after-turn holds the slot; the run's announcement now runs after the slot is given back (runChainCommand), else the after chat would be refused while the notification shows. Added: RunChat.ended/failed, Entry kinds `end` + `failed`, ChatView.ending, endedLine, replyOf, resumeCommand (worktree.ts), chatCopyResume/chatNextChain. pnpm typecheck ✔; pnpm test 680/680 ✔; pnpm build ✔. NOT checked: Done When 1–3 in the F5 app (no editor in this session).
4. todo — Chat space: question scroll + Maximize chat — Light
5. todo — Busy indicator + answers-sent announcement — Light
6. todo — Model/Effort/Pause on template cards (auto-copy) + setPause — Light
7. todo — Spike: mid-turn injection via SDK streaming input (scratchpad) — Standard
8. todo — Send without waiting (inject, or Interrupt and send fallback) — Standard
9. todo — Docs: CHANGELOG current state + entry, README chat section — Light
10. todo — Gates: pnpm typecheck → pnpm test → pnpm coverage → pnpm build → pnpm audit — Light

Pre-existing uncommitted changes (README.md, src/session.ts, src/session.test.ts) are the user's; build on them.

Handoff (2026-10-27): steps 1–3 done. Resume at step 4 (Light tier — stop was the tier switch). Still to do at step 9: review finding 1 (README.md:22 — macOS keeps the login in the Keychain, not ~/.claude/.credentials.json) and finding 2 (src/run.test.ts:431 — history comment). Gates 1–5 run at step 10; F5 smoke for Done When 1–3 is the user's.
