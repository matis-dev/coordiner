import { MAX_INPUT_CHARS } from "./chains.ts";
import type { ChatView, Ending } from "./editor-protocol.ts";
import type { Entry } from "./transcript.ts";
import type { Question } from "./unattended.ts";

// The decisions behind the run's chat, kept out of the DOM script so they can be tested. The webview loads this module from dist/,
// so it imports nothing at runtime beyond chains.ts.

// The most transcript entries kept, by the extension and by the chat on the page alike; older ones are dropped.
export const MAX_ENTRIES = 1000;

// The prompt cache of the session a card waits in: warm from `since` for `ttlMs`. `assumed` when the session never said which
// lifetime it writes, and five minutes is taken.
export type CacheClock = { since: number; ttlMs: number; assumed: boolean };

// The turn running: since when, and the latest sign of life from it (a message, a tool call, the user's answers), with the last
// tool it called.
export type TurnClock = { since: number; lastAt: number; last?: string };

const pad = (n: number): string => String(n).padStart(2, "0");
function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(s % 60)}` : `${minutes}:${pad(s % 60)}`;
}

// Worked out from the clock each time, never counted down, so a computer that slept shows the right time when it wakes.
export function cacheLabel(cache: CacheClock, now: number): { text: string; expired: boolean } {
  const left = cache.since + cache.ttlMs - now;
  const assumed = cache.assumed ? " (assumed 5-minute cache)" : "";
  if (left <= 0) return { text: `Prompt cache expired: your next message re-reads the whole conversation without the cache discount.${assumed}`, expired: true };
  return { text: `Prompt cache warm for ${clock(left)}${assumed}`, expired: false };
}

// Elapsed time counts whole seconds up from the clock, and a clock that moved back reads as no time at all.
const elapsed = (ms: number): string => clock(Math.max(0, Math.floor(ms / 1000) * 1000));

// Worked out from the clock, as cacheLabel is: a turn that streams nothing for minutes still shows it is alive, and for how long.
export function busyLabel(turn: TurnClock, now: number): string {
  return `Working ${elapsed(now - turn.since)} · last activity ${elapsed(now - turn.lastAt)} ago${turn.last ? ` · ${turn.last}` : ""}`;
}

// A question that takes its Recommended option when the time runs out says how long the user has, from the clock as cacheLabel does.
export function expiryLabel(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  return left > 0 ? `Takes the recommended answer in ${clock(left)} unless you answer.` : "Taking the recommended answer.";
}

// Model text as Markdown, parsed into plain data the page builds with createElement and textContent, never as markup. It covers
// what a model writes: headings, paragraphs, emphasis, strikethrough, inline code, fenced code, lists (nested, tasks), quotes,
// tables, rules, and links. Raw HTML stays text. A fence left open stays text, so a half-written block never swallows the rest.
export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  // `href` is set only for an http(s) address; any other target is shown as text beside the link's words.
  | { type: "link"; href?: string; target: string; children: Inline[] }
  | { type: "br" };
export type Align = "left" | "center" | "right" | undefined;
export type Block =
  | { type: "p"; inline: Inline[] }
  | { type: "h"; level: number; inline: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: { task?: boolean; blocks: Block[] }[] }
  | { type: "quote"; blocks: Block[] }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

// Model text is untrusted, so the parser stays linear in it. Past these bounds the rest is shown as written: a longer reply, and
// anything nested deeper (quotes, lists, emphasis, links), which would otherwise recurse once per level.
export const MAX_MARKDOWN = 50_000;
export const MAX_DEPTH = 16;

// Each pattern has one way to match a line, so a long line cannot make it backtrack.
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const DELIMITER_CELL = /^:?-+:?$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const blank = (line: string): boolean => line.trim() === "";

// Text as written, its line breaks kept.
const asWritten = (text: string): Inline[] =>
  text.split("\n").flatMap((line, k): Inline[] => [...(k > 0 ? [{ type: "br" } as const] : []), ...(line ? [{ type: "text", text: line } as const] : [])]);

// An opening fence: its info string's first word is the language; a backtick fence whose info string holds a backtick is not one.
function fenceOpen(line: string): { indent: number; fence: string; lang: string } | undefined {
  const m = FENCE.exec(line);
  if (!m || m[3]!.includes("`")) return undefined;
  return { indent: m[1]!.length, fence: m[2]!, lang: m[3]!.trim().split(/\s/)[0]! };
}

// A heading's text, without a closing run of #s set off by a space.
function headingText(rest: string): string {
  const text = rest.trim();
  const hashes = /#*$/.exec(text)![0].length;
  const before = text.length - hashes;
  return hashes > 0 && before > 0 && /\s/.test(text[before - 1]!) ? text.slice(0, before).trimEnd() : text;
}

// Up to `n` leading spaces off a line; a tab counts as four.
function dedent(line: string, n: number): string {
  let i = 0;
  let width = 0;
  while (i < line.length && width < n && (line[i] === " " || line[i] === "\t")) {
    width += line[i] === "\t" ? 4 : 1;
    i += 1;
  }
  return line.slice(i);
}

// Per list of lines, the first line from which a fence of that kind was found not to close: a search from there or later is not
// repeated, so many unclosed fences cost one scan, not one each.
const unclosedFrom = new WeakMap<readonly string[], Map<string, number>>();

function closingFence(lines: readonly string[], from: number, fence: string): number {
  const known = unclosedFrom.get(lines) ?? new Map<string, number>();
  unclosedFrom.set(lines, known);
  if ((known.get(fence) ?? Infinity) <= from) return -1;
  const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
  for (let i = from; i < lines.length; i++) if (close.test(lines[i]!)) return i;
  known.set(fence, from);
  return -1;
}

function cells(row: string): string[] {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (text[i] === "|") {
      out.push(cell.trim());
      cell = "";
    } else cell += text[i];
  }
  out.push(cell.trim());
  return out;
}

function isTableStart(lines: readonly string[], i: number): boolean {
  if (!lines[i]!.includes("|") || i + 1 >= lines.length) return false;
  const delimiters = cells(lines[i + 1]!);
  return delimiters.every((c) => DELIMITER_CELL.test(c)) && cells(lines[i]!).length === delimiters.length;
}

// A line that ends a paragraph above it without a blank line between them.
function interrupts(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  const fence = fenceOpen(line);
  return HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || (fence !== undefined && closingFence(lines, i + 1, fence.fence) !== -1) || (ITEM.test(line) && ITEM.exec(line)![4] !== undefined) || isTableStart(lines, i);
}

export function markdown(text: string): Block[] {
  const normal = text.replace(/\r\n?/g, "\n");
  if (normal.length > MAX_MARKDOWN) return normal.trim() ? [{ type: "p", inline: asWritten(normal.trim()) }] : [];
  return blocks(normal.split("\n"), 0);
}

function blocks(lines: readonly string[], depth: number): Block[] {
  if (depth >= MAX_DEPTH) {
    const text = lines.join("\n").trim();
    return text ? [{ type: "p", inline: asWritten(text) }] : [];
  }
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const end = closingFence(lines, i + 1, fence.fence);
      if (end !== -1) {
        // A fence indented in a list item has its content indented the same; that indent is not part of the command.
        out.push({ type: "code", lang: fence.lang, text: lines.slice(i + 1, end).map((l) => dedent(l, fence.indent)).join("\n") });
        i = end + 1;
        continue;
      }
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ type: "h", level: heading[1]!.length, inline: spans(headingText(heading[2] ?? ""), depth, false) });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ type: "hr" });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(lines[i++]!.replace(QUOTE, ""));
      out.push({ type: "quote", blocks: blocks(quoted, depth + 1) });
      continue;
    }
    if (ITEM.test(line)) {
      i = list(lines, i, out, depth);
      continue;
    }
    if (isTableStart(lines, i)) {
      const align = cells(lines[i + 1]!).map((c): Align => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined));
      const width = align.length;
      const fit = (row: string[]) => Array.from({ length: width }, (_, k) => spans(row[k] ?? "", depth, false));
      const head = fit(cells(lines[i]!));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]!) && lines[i]!.includes("|")) rows.push(fit(cells(lines[i++]!)));
      out.push({ type: "table", align, head, rows });
      continue;
    }
    const para: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && !blank(lines[i]!) && !interrupts(lines, i)) para.push(lines[i++]!.trim());
    out.push({ type: "p", inline: spans(para.join("\n"), depth, false) });
  }
  return out;
}

// One list from line `i`: items of the same kind, each with the lines indented under it; returns the line after the list.
function list(lines: readonly string[], i: number, out: Block[], depth: number): number {
  const first = ITEM.exec(lines[i]!)!;
  const ordered = /\d/.test(first[2]!);
  const kind = ordered ? first[2]!.slice(-1) : first[2]!;
  const items: { task?: boolean; blocks: Block[] }[] = [];
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || (ordered ? m[2]!.slice(-1) !== kind || !/\d/.test(m[2]!) : m[2] !== kind)) break;
    const content = m[1]!.length + m[2]!.length + Math.min(m[3]?.length ?? 1, 4);
    const body = [m[4] ?? ""];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!;
      if (blank(next)) {
        // A blank line keeps the item open only when what follows is indented under it.
        let j = i;
        while (j < lines.length && blank(lines[j]!)) j += 1;
        if (j < lines.length && indentOf(lines[j]!) >= content) {
          body.push(...lines.slice(i, j).map(() => ""));
          i = j;
          continue;
        }
        break;
      }
      if (indentOf(next) >= content) body.push(dedent(next, content));
      else if (!ITEM.test(next) && !interrupts(lines, i) && !blank(body.at(-1)!)) body.push(next.trim());
      else break;
      i += 1;
    }
    const task = /^\[([ xX])\]\s+/.exec(body[0]!);
    if (task) body[0] = body[0]!.slice(task[0].length);
    items.push({ ...(task ? { task: task[1] !== " " } : {}), blocks: blocks(body, depth + 1) });
    // Items separated by blank lines are still one list.
    let j = i;
    while (j < lines.length && blank(lines[j]!)) j += 1;
    if (j > i && j < lines.length && ITEM.test(lines[j]!)) i = j;
  }
  out.push({ type: "list", ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, items });
  return i;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const URL_AT = /https?:\/\/[^\s<>]*[^\s<>.,:;"'!?)\]*_~]/y;

// The end of the code span opened by the backtick run at `i`, or -1 when no run of the same length closes it.
function codeSpanEnd(text: string, i: number): { run: number; close: number } {
  let run = 0;
  while (text[i + run] === "`") run += 1;
  let j = i + run;
  while ((j = text.indexOf("`", j)) !== -1) {
    let n = 0;
    while (text[j + n] === "`") n += 1;
    if (n === run) return { run, close: j };
    j += n;
  }
  return { run, close: -1 };
}

// Where the delimiter opened at `from` closes: the next occurrence not inside a code span, with no space before it, and for `_`
// not inside a word (so snake_case stays as written).
function closeOf(text: string, from: number, delim: string): number {
  for (let j = from; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === "\\") {
      j += 1;
      continue;
    }
    if (ch === "`") {
      const { run, close } = codeSpanEnd(text, j);
      j = close === -1 ? j + run - 1 : close + run - 1;
      continue;
    }
    if (!text.startsWith(delim, j) || /\s/.test(text[j - 1] ?? " ") || j === from) continue;
    // In a run of three, the pair closes at its end, so ***both*** is strong around em.
    let at = j;
    if (delim.length === 2 && text[j + 2] === delim[0]) at = j + 1;
    else if (delim.length === 1 && text[j + 1] === delim) {
      j += 1;
      continue;
    }
    if (delim[0] === "_" && WORD.test(text[at + delim.length] ?? "")) continue;
    return at;
  }
  return -1;
}

// Each "[" with the "]" that closes it, matched once for the whole text, so looking for a link never rescans the rest of it.
function bracketPairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let j = 0; j < text.length; j++) {
    if (text[j] === "\\") j += 1;
    else if (text[j] === "[") open.push(j);
    else if (text[j] === "]" && open.length > 0) pairs.set(open.pop()!, j);
  }
  return pairs;
}

const LINK_TAIL = /\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/y;
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y;

// The link whose "[" is at `i` and "]" at `close` ("[words](target)"), with where it ends; undefined when it is not a link.
function linkAt(text: string, i: number, close: number | undefined): { words: string; target: string; end: number } | undefined {
  if (close === undefined || text[close + 1] !== "(") return undefined;
  LINK_TAIL.lastIndex = close + 1;
  const m = LINK_TAIL.exec(text);
  if (!m) return undefined;
  const target = m[1]!.startsWith("<") ? m[1]!.slice(1, -1) : m[1]!;
  return { words: text.slice(i + 1, close), target, end: close + 1 + m[0].length };
}

const webAddress = (target: string): string | undefined => {
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const link = (target: string, children: Inline[]): Inline => {
  const href = webAddress(target);
  return { type: "link", ...(href ? { href } : {}), target, children };
};

export const inline = (text: string): Inline[] => spans(text, 0, false);

// `depth`: how deeply the text is nested. `linked`: it is a link's words, where no other link starts, since a link cannot hold one.
function spans(text: string, depth: number, linked: boolean): Inline[] {
  if (depth >= MAX_DEPTH) return asWritten(text);
  let pairs: Map<number, number> | undefined;
  const closeBracket = (i: number) => (pairs ??= bracketPairs(text)).get(i);
  // Per delimiter, the first place a search for its close failed: a search from there or later fails too, so it is not repeated.
  const unclosed = new Map<string, number>();
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === "\\" && PUNCT.test(text[i + 1] ?? "")) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\\" && text[i + 1] === "\n") {
      push({ type: "br" });
      i += 2;
      continue;
    }
    if (ch === "\n") {
      buffer = buffer.replace(/ +$/, "");
      push({ type: "br" });
      i += 1;
      continue;
    }
    if (ch === "`") {
      const { run, close } = codeSpanEnd(text, i);
      if (close === -1) {
        buffer += "`".repeat(run);
        i += run;
        continue;
      }
      let code = text.slice(i + run, close).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      push({ type: "code", text: code });
      i = close + run;
      continue;
    }
    if (!linked && ch === "!" && text[i + 1] === "[") {
      const image = linkAt(text, i + 1, closeBracket(i + 1));
      if (image) {
        // No image is loaded: its description stands in for it.
        push(link(image.target, spans(image.words || "image", depth + 1, true)));
        i = image.end;
        continue;
      }
    }
    if (!linked && ch === "[") {
      const found = linkAt(text, i, closeBracket(i));
      if (found) {
        push(link(found.target, spans(found.words, depth + 1, true)));
        i = found.end;
        continue;
      }
    }
    if (!linked && ch === "<") {
      AUTOLINK.lastIndex = i;
      const auto = AUTOLINK.exec(text);
      if (auto) {
        push(link(auto[1]!, [{ type: "text", text: auto[1]! }]));
        i += auto[0].length;
        continue;
      }
    }
    if (!linked && ch === "h" && !WORD.test(text[i - 1] ?? "")) {
      URL_AT.lastIndex = i;
      const bare = URL_AT.exec(text);
      if (bare) {
        push(link(bare[0], [{ type: "text", text: bare[0] }]));
        i += bare[0].length;
        continue;
      }
    }
    const delim = text.startsWith("**", i) ? "**" : text.startsWith("__", i) ? "__" : text.startsWith("~~", i) ? "~~" : ch === "*" || ch === "_" ? ch : undefined;
    const opens = delim && !/\s/.test(text[i + delim.length] ?? " ") && !(delim[0] === "_" && WORD.test(text[i - 1] ?? ""));
    if (delim && opens && (unclosed.get(delim) ?? Infinity) > i + delim.length) {
      const close = closeOf(text, i + delim.length, delim);
      if (close !== -1) {
        push({ type: delim === "~~" ? "del" : delim.length === 2 ? "strong" : "em", children: spans(text.slice(i + delim.length, close), depth + 1, linked) });
        i = close + delim.length;
        continue;
      }
      unclosed.set(delim, i + delim.length);
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

// Bidi controls and zero-width characters, which plain() keeps: with them a command can read differently from what it runs.
const HIDDEN = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
export const hasHidden = (code: string): boolean => HIDDEN.test(code);

// The extension refuses longer copies (src/editor-protocol.ts), so a longer block gets no Copy button; nor does one with hidden
// characters, since the copy would not be the command shown.
export const copyable = (code: string): boolean => code.length <= MAX_INPUT_CHARS && !hasHidden(code);

// What the user chose for one question: offered labels, and their own text when they picked Other.
export type Pick = { picked: string[]; other?: string };

// Answers reach the skill keyed by question text, several choices joined as an unattended answer joins them. Anything that is not
// an offered label, or text the user did not mark as Other, is refused.
export function checkAnswers(questions: readonly Question[], picks: readonly Pick[]): Record<string, string> | undefined {
  if (picks.length !== questions.length) return undefined;
  const answers: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const { picked, other } = picks[i]!;
    const labels = q.options.map((o) => o.label);
    if (new Set(picked).size !== picked.length || !picked.every((label) => labels.includes(label))) return undefined;
    const typed = other?.trim();
    if (other !== undefined && (!typed || other.length > MAX_INPUT_CHARS)) return undefined;
    const chosen = typed ? [...picked, typed] : picked;
    if (chosen.length === 0 || (!q.multiSelect && chosen.length > 1)) return undefined;
    answers[q.question] = chosen.join(", ");
  }
  return answers;
}

// The first question whose pick does not fit it, or -1 when every one does; the form moves focus there.
export const firstUnanswered = (questions: readonly Question[], picks: readonly Pick[]): number =>
  questions.findIndex((q, i) => checkAnswers([q], [picks[i] ?? { picked: [] }]) === undefined);

// What the chip by the chat's title says, and what the Sessions view marks: a card waiting on the user, or one working. After the
// run, the chat waits after every reply, so that is not waiting for the user.
export function attention(chat: ChatView): { kind: "needs" | "working"; text: string } | undefined {
  if (chat.question) return { kind: "needs", text: "Waiting for your answer" };
  if (chat.phase === "waiting" && !chat.afterRun) return { kind: "needs", text: "Waiting for you" };
  return chat.phase === "running" ? { kind: "working", text: "Working" } : undefined;
}

export const needsYou = (chat: ChatView): boolean => attention(chat)?.kind === "needs";

export const canSend = (chat: ChatView): boolean => chat.phase === "running" || chat.phase === "waiting";
export const canPause = (chat: ChatView): boolean => chat.phase === "running" && !chat.attended && !chat.pausePending;

const ENDED: Record<Ending["status"], string> = {
  done: "The run is done",
  "no-changes": "The run found nothing to review",
  halted: "The run halted",
  failed: "The run failed",
  stopped: "The run was stopped",
  refused: "The run was refused",
};

// How the run ended, as one sentence: the end entry, and the start of the status line after the run.
export const endedLine = ({ status, reason }: Ending): string => `${ENDED[status]}${reason ? `: ${reason.replace(/[.\s]+$/, "")}` : ""}.`;

export function statusLine(chat: ChatView): string {
  switch (chat.phase) {
    case "idle":
      return "No run yet. A run shows here, and a card that pauses waits for you here.";
    case "running":
      return chat.attended ? `${chat.card} is working on your message…` : `${chat.card} is working…`;
    case "waiting":
      if (chat.afterRun) return `${chat.ending ? endedLine(chat.ending) : "The run has ended."} You can keep talking to ${chat.card}.`;
      if (chat.parked) return `${chat.card} needs you: ${chat.parked.replace(/[.\s]+$/, "")}. Reply to it, or fix the cause and choose Continue to try again.`;
      return chat.continueReady ? `${chat.card} is waiting for you. It gave its status line, so Continue moves the chain on.` : `${chat.card} is waiting for you.`;
    case "ended":
      return chat.ending ? endedLine(chat.ending) : "The run has ended.";
  }
}

// Where a queued message goes. If the card ends its session first, it goes to the next session, which starts a fresh context.
export function destination(chat: ChatView): string {
  if (chat.nextSession) return `the next turn of ${chat.card}, or ${chat.nextSession} in a fresh context if ${chat.card} finishes`;
  return `the next turn of ${chat.card}`;
}

export function continueLabel(chat: ChatView): string {
  if (chat.parked) return `Continue ${chat.card}`;
  return chat.nextCard ? `Continue to ${chat.nextCard}` : "Continue the chain";
}

// The one line the status region speaks for a change, most important first; nothing for a change that needs no word.
export function announcement(prev: ChatView | undefined, next: ChatView): string | undefined {
  const q = next.question;
  if (q && prev?.question?.id !== q.id) {
    const first = q.questions[0]!;
    const asks = q.questions.length > 1 ? `${q.card} asks ${q.questions.length} questions` : `${q.card} asks: ${first.header || first.question}`;
    return q.expiresAt === undefined ? asks : `${asks}. If you do not answer in time, it takes the recommended answer`;
  }
  // The form goes away the moment the answers are sent; this says where they went.
  if (prev?.question && !q && next.phase === "running") return `Answers sent; ${next.card} is working on them`;
  if (next.afterRun && !prev?.afterRun) return `${statusLine(next)}${next.returned ? " Your queued message is back in the message box." : ""}`;
  if (next.phase === "waiting" && prev?.phase !== "waiting" && next.parked) return `${next.card} needs you: ${next.parked}`;
  if (next.phase === "waiting" && prev?.phase !== "waiting") return next.continueReady ? `${next.card} is waiting for you; Continue is ready` : `${next.card} is waiting for you`;
  if (next.returned && !prev?.returned) return "The run ended before your message was sent; it is back in the message box.";
  if (next.phase === "ended" && prev?.phase !== "ended") return "The run has ended.";
  if (next.queued.length > (prev?.queued.length ?? 0)) return `Message queued for ${destination(next)}`;
  if (next.pausePending && !prev?.pausePending) return `${next.card} will wait for you after this turn`;
  return undefined;
}

// New transcript entries are not a live region; a reply is announced by who gave it, a message of the user's by where it went (a
// queued one is announced when it is queued), and tool calls are not announced at all.
export function entriesAnnouncement(entries: readonly Entry[]): string | undefined {
  const reply = entries.findLast((e) => e.kind === "assistant");
  if (reply) return `${reply.card} replied`;
  const decided = entries.findLast((e) => e.kind === "decided");
  if (decided) return `${decided.card} took the recommended answer`;
  const sent = entries.findLast((e) => e.kind === "you");
  return sent ? `Your message reached ${sent.card}` : undefined;
}

// The chat's height, as a share of the window: the divider above it moves in steps between these bounds.
export const CHAT_HEIGHT = { min: 15, max: 80, initial: 35, step: 5 } as const;

const clampHeight = (n: number): number => Math.min(CHAT_HEIGHT.max, Math.max(CHAT_HEIGHT.min, Math.round(n)));

// Up makes the chat taller, down shorter; Home and End go to the smallest and the largest. Any other key is not the divider's.
export function heightForKey(height: number, key: string): number | undefined {
  switch (key) {
    case "ArrowUp":
      return clampHeight(height + CHAT_HEIGHT.step);
    case "ArrowDown":
      return clampHeight(height - CHAT_HEIGHT.step);
    case "Home":
      return CHAT_HEIGHT.min;
    case "End":
      return CHAT_HEIGHT.max;
    default:
      return undefined;
  }
}

// Dragging puts the divider under the pointer: the chat takes the window below it.
export const heightFromPointer = (clientY: number, windowHeight: number): number => clampHeight(((windowHeight - clientY) / windowHeight) * 100);

// The saved state is the webview's own, but it is read defensively: anything but a number falls back to the initial height.
export const savedHeight = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? clampHeight(value) : CHAT_HEIGHT.initial);

// Whether the chat fills the editor, from the saved state: only a saved true does, so a fresh or damaged state starts docked.
export const savedMax = (value: unknown): boolean => value === true;
