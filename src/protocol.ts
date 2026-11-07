import type { ModelOption } from "./skills.ts";

// What a step suggests for the step after it, as the model wrote it: each value is one token of at most 100 characters, checked
// against the session's own models only where it is used (`turnSettings`, src/chains.ts).
export type Suggestion = { model?: string; effort?: string; skill?: string };
export type Status = { kind: "next"; suggestion: Suggestion } | { kind: "done" } | { kind: "halt"; reason: string } | { kind: "none" };

// `NEXT Light|Standard|Heavy` is the line skills gave before the suggestion fields; it still moves the chain on, suggesting nothing.
const STATUS_LINE = /^COORDINER: (?:NEXT(?: (?:Light|Standard|Heavy))?((?: \S+)*)|(DONE)|HALT (.{1,300}))$/;
const FIELD = /^(model|effort|skill)=(\S{1,100})$/;

// Only the last non-empty line counts: a marker quoted mid-text (a plan, a file's contents) must not steer the run. A NEXT line with
// anything but known fields, each at most once, is not a status line.
export function parseStatus(text: string): Status {
  const last = text.trimEnd().split("\n").at(-1)!.trim();
  const match = STATUS_LINE.exec(last);
  if (!match) return { kind: "none" };
  if (match[2]) return { kind: "done" };
  if (match[3]) return { kind: "halt", reason: match[3] };
  const suggestion: Suggestion = {};
  for (const token of match[1]!.split(" ").filter(Boolean)) {
    const field = FIELD.exec(token);
    if (!field || field[1]! in suggestion) return { kind: "none" };
    suggestion[field[1] as keyof Suggestion] = field[2]!;
  }
  return { kind: "next", suggestion };
}

// The fields a NEXT line gave, as the step's detail shows them.
export const suggested = (s: Suggestion): string => (["skill", "model", "effort"] as const).flatMap((k) => (s[k] ? [`${k}=${s[k]}`] : [])).join(" ");

export const withoutStatus = (text: string): string => text.trimEnd().split("\n").slice(0, -1).join("\n").trimEnd();

// A reply as the user reads it: without its status line, when it ends with one.
export const replyOf = (text: string): string => (parseStatus(text).kind === "none" ? text.trim() : withoutStatus(text));

// Added to a message that carries images when a later session of the chain follows: that session starts in a fresh context and
// never sees them.
export const IMAGES_NOTE =
  "(From coordiner: the images attached here do not reach the later sessions of this chain, which start with a fresh context. Write down in your reply or plan anything you need from them: the text they show, the UI, the error.)";

export const UNATTENDED_NOTE = [
  "This session is driven by coordiner, an unattended pipeline running a chain of skills. Nobody is at the keyboard.",
  "Finish the skill's work, then end your turn. Do not offer a next-step picker or start another skill.",
  "Planning: instead of the approval picker, end with the line `COORDINER: NEXT`, suggesting the model and effort of the plan's first step (below).",
  "Implementing: at every stop in the plan where the model or effort changes, end with `COORDINER: NEXT`, suggesting the next step's model and effort. When the whole plan is done, end with `COORDINER: DONE`.",
  "Reviewing: end with `COORDINER: NEXT`, suggesting the model and effort the fixes need, or `COORDINER: DONE` when there is nothing to fix.",
  "Fixing findings: stop where the model or effort changes, as when implementing, and end with `COORDINER: DONE` once every finding is handled.",
  "Rolling history: end with `COORDINER: DONE` after the commit brief.",
  "Any other skill: when its work is done, end with `COORDINER: DONE`.",
  "A decision the plan reserves for the user, or a one-way door, is a question (below), not a halt.",
  "End with `COORDINER: HALT <one-line reason>` only when the user must act outside this session: install a tool, log in, add a key, change a setting. Before that line, say what happened and why, and give the steps as fenced shell blocks, one command per block, saying which need sudo. Coordiner waits for the user, then resumes this session.",
  "Before relying on a system tool that is not one of the project's own dependencies (docker, php, a database server), check it with `command -v`; if it is missing, choose an approach that works without it, or HALT with the steps to install it.",
  "The status line must be the last line of your final message.",
  "The user may send a message while you work: take it into account, carry on with the skill's work, and still end your final message with the status line it calls for.",
  "Questions you genuinely need answered go through AskUserQuestion. Give every question an option labelled (Recommended) that is safe to take without the user; for multi-select, label a recommended set. Coordiner may wait for the user for a while, then takes the Recommended option and logs it. Leave the label out only when no option is safe without the user: that question waits for the user.",
].join(" ");

// For a turn the user is present for: a card that pauses, or one they paused. The status lines stay those of UNATTENDED_NOTE.
export const INTERACTIVE_NOTE = [
  "This session is driven by coordiner, which runs a chain of skills. Right now the user is at the keyboard, talking to you in coordiner's chat.",
  "Ask what you need through AskUserQuestion, as often as the skill calls for; the user answers each question in the chat.",
  "Do not offer a next-step picker or start another skill: the user moves the chain on with coordiner's Continue button.",
  "Continue runs only the next skill in the chain, and ends the run when there is none, so do not tell the user that Continue runs a skill you name: name the next skill, and leave how to start it to coordiner.",
  "When this skill's work is done, end your final message with the status line the skill would give in an unattended run: `COORDINER: NEXT` when a next step follows (with the model and effort it needs, as below), `COORDINER: DONE` when the skill is finished, or `COORDINER: HALT <one-line reason>` when the user must act outside this session.",
  "Until the work is done, end your turn without a status line; the user replies in the chat.",
].join(" ");

// For a turn after the chain has ended: the user talks to the run's last session in coordiner's chat. No status line steers it.
export const AFTER_NOTE = [
  "This session was driven by coordiner, which ran a chain of skills. The chain has ended; the user is now talking to you in coordiner's chat.",
  "Answer them directly. No COORDINER status line is needed: nothing follows in the chain, and one would steer nothing.",
  "There is no Continue button in this chat; do not tell the user to press one. To run the next skill, the user chooses Start the next chain here, which runs a chain of their choice in this worktree, starting from your last reply.",
  "Ask what you need through AskUserQuestion; the user answers each question in the chat.",
  "Do not offer a next-step picker. Start another skill only when the user asks for one.",
].join(" ");

// A chat opened on its own (Open Chat): no chain ran before it, and none follows unless the user starts one.
export const CHAT_NOTE = [
  "This session was started from coordiner's chat, with no chain of skills: the user is talking to you directly in coordiner's chat.",
  "Answer them directly. No COORDINER status line is needed, and there is no Continue button in this chat; do not tell the user to press one.",
  "Ask what you need through AskUserQuestion; the user answers each question in the chat.",
  "Do not offer a next-step picker. Start a skill only when the user asks for one.",
].join(" ");

// What a NEXT line may suggest, with the models this session offers. Appended to the unattended and interactive notes; the model's
// suggestion is only a suggestion: coordiner checks it against the same list, and the card's own settings decide when it applies.
export function suggestionNote(offered: readonly ModelOption[] | undefined): string {
  const how =
    "A `COORDINER: NEXT` line may suggest how the next step runs, with fields after NEXT: `model=<id>` and `effort=<level>`, for example `COORDINER: NEXT model=<id> effort=medium`. Leave out a field you have no reason to set.";
  if (!offered || offered.length === 0) return `${how} This session's models could not be listed, so suggest only the effort (low, medium, high, xhigh or max).`;
  const list = offered.map((m) => `${m.id} (${m.label}; ${m.efforts.length > 0 ? `effort ${m.efforts.join(", ")}` : "no effort setting"})`).join("; ");
  return `${how} Use only these model ids, and an effort the model takes: ${list}. When a plan gives a step a tier, suggest the strongest listed model for Heavy, a mid one for Standard and the lightest for Light, with the plan's effort.`;
}
