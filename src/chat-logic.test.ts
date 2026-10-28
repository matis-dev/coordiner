import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_INPUT_CHARS } from "./chains.ts";
import { announcement, busyLabel, canPause, canSend, CHAT_HEIGHT, checkAnswers, continueLabel, copyable, destination, hasHidden, endedLine, entriesAnnouncement, expiryLabel, firstUnanswered, heightForKey, heightFromPointer, savedHeight, savedMax, statusLine, cacheLabel, markdown, inline, attention, MAX_DEPTH, MAX_MARKDOWN, type Block, type Inline } from "./chat-logic.ts";
import type { ChatView } from "./editor-protocol.ts";

const opts = (...labels: string[]) => labels.map((label) => ({ label }));
const single = { question: "Which store?", options: opts("SQLite (Recommended)", "Files") };
const multi = { question: "Which themes?", multiSelect: true, options: opts("Light", "Dark", "High contrast") };

describe("checkAnswers", () => {
  it("keys each answer by its question text", () => {
    assert.deepEqual(checkAnswers([single, multi], [{ picked: ["Files"] }, { picked: ["Light", "Dark"] }]), { "Which store?": "Files", "Which themes?": "Light, Dark" });
  });

  it("takes the user's own text when they pick Other, trimmed, and joins it after the labels of a multi-select", () => {
    assert.deepEqual(checkAnswers([single], [{ picked: [], other: "  Postgres " }]), { "Which store?": "Postgres" });
    assert.deepEqual(checkAnswers([multi], [{ picked: ["Dark"], other: "Sepia" }]), { "Which themes?": "Dark, Sepia" });
  });

  it("refuses an answer that is not an offered label and not marked Other", () => {
    assert.equal(checkAnswers([single], [{ picked: ["Postgres"] }]), undefined);
  });

  it("refuses a question left unanswered, or more than one choice on a single select", () => {
    assert.equal(checkAnswers([single], [{ picked: [] }]), undefined);
    assert.equal(checkAnswers([single], [{ picked: ["Files", "SQLite (Recommended)"] }]), undefined);
    assert.equal(checkAnswers([single], [{ picked: ["Files"], other: "Postgres" }]), undefined);
  });

  it("refuses a repeated label, an empty Other, and an Other over the length limit", () => {
    assert.equal(checkAnswers([multi], [{ picked: ["Dark", "Dark"] }]), undefined);
    assert.equal(checkAnswers([single], [{ picked: [], other: "   " }]), undefined);
    assert.equal(checkAnswers([single], [{ picked: [], other: "x".repeat(MAX_INPUT_CHARS + 1) }]), undefined);
    assert.deepEqual(checkAnswers([single], [{ picked: [], other: "x".repeat(MAX_INPUT_CHARS) }]), { "Which store?": "x".repeat(MAX_INPUT_CHARS) });
  });

  it("refuses answers that do not match the number of questions", () => {
    assert.equal(checkAnswers([single, multi], [{ picked: ["Files"] }]), undefined);
  });
});

const view = (patch: Partial<ChatView> = {}): ChatView => ({ phase: "running", card: "Implement", session: 0, attended: false, queued: [], continueReady: false, pausePending: false, ...patch });

describe("firstUnanswered", () => {
  it("finds the first question whose pick does not fit, or -1", () => {
    assert.equal(firstUnanswered([single, multi], [{ picked: ["Files"] }, { picked: [] }]), 1);
    assert.equal(firstUnanswered([single, multi], [{ picked: ["Files"] }]), 1);
    assert.equal(firstUnanswered([single, multi], [{ picked: ["Files"] }, { picked: ["Dark"] }]), -1);
  });
});

describe("what the chat allows", () => {
  it("sends while a run is going, and not before or after", () => {
    assert.deepEqual((["idle", "running", "waiting", "ended"] as const).map((phase) => canSend(view({ phase }))), [false, true, true, false]);
  });

  it("pauses only an unattended card that is working and not already pausing", () => {
    assert.equal(canPause(view()), true);
    assert.equal(canPause(view({ attended: true })), false);
    assert.equal(canPause(view({ pausePending: true })), false);
    assert.equal(canPause(view({ phase: "waiting" })), false);
  });

  it("sends to the chat after the run, and never pauses it", () => {
    const after = view({ phase: "waiting", card: "Kickoff", attended: true, afterRun: true });
    assert.equal(canSend(after), true);
    assert.equal(canSend({ ...after, phase: "running" }), true);
    assert.equal(canPause({ ...after, phase: "running" }), false);
  });
});

describe("the end of the run", () => {
  it("says how the run ended in one sentence, with the reason and without a doubled full stop", () => {
    assert.equal(endedLine({ status: "done" }), "The run is done.");
    assert.equal(endedLine({ status: "halted", reason: "the plan reserves the schema change." }), "The run halted: the plan reserves the schema change.");
    assert.equal(endedLine({ status: "failed", reason: "the session ended with error_max_turns." }), "The run failed: the session ended with error_max_turns.");
    assert.deepEqual((["no-changes", "stopped", "refused"] as const).map((status) => endedLine({ status })), ["The run found nothing to review.", "The run was stopped.", "The run was refused."]);
  });

  it("offers the chat after the run in the status line, and keeps how it ended once the chat closes", () => {
    const after = view({ phase: "waiting", card: "Kickoff", attended: true, afterRun: true, ending: { status: "halted", reason: "needs you" } });
    assert.equal(statusLine(after), "The run halted: needs you. You can keep talking to Kickoff.");
    assert.equal(statusLine({ ...after, ending: undefined }), "The run has ended. You can keep talking to Kickoff.");
    assert.equal(statusLine({ ...after, phase: "running" }), "Kickoff is working on your message…");
    assert.equal(statusLine(view({ phase: "ended", ending: { status: "done" } })), "The run is done.");
  });

  it("announces the chat after the run once, then each wait as a pausing card does, and says when a queued message came back", () => {
    const after = view({ phase: "waiting", card: "Kickoff", attended: true, afterRun: true, ending: { status: "done" } });
    assert.equal(announcement(view(), after), "The run is done. You can keep talking to Kickoff.");
    assert.equal(announcement(view(), { ...after, returned: "x" }), "The run is done. You can keep talking to Kickoff. Your queued message is back in the message box.");
    assert.equal(announcement(after, after), undefined);
    assert.equal(announcement({ ...after, phase: "running" }, after), "Kickoff is waiting for you");
  });
});

describe("chat labels", () => {
  it("says what the run is doing in text", () => {
    assert.match(statusLine(view({ phase: "idle" })), /No run yet/);
    assert.equal(statusLine(view()), "Implement is working…");
    assert.equal(statusLine(view({ card: "Brainstorm", attended: true })), "Brainstorm is working on your message…");
    assert.equal(statusLine(view({ phase: "waiting", card: "Brainstorm" })), "Brainstorm is waiting for you.");
    assert.match(statusLine(view({ phase: "waiting", card: "Brainstorm", continueReady: true })), /Continue moves the chain on/);
    assert.equal(statusLine(view({ phase: "ended" })), "The run has ended.");
  });

  it("names where a queued message goes, including the fresh context of the next session", () => {
    assert.equal(destination(view()), "the next turn of Implement");
    assert.equal(destination(view({ nextSession: "Review" })), "the next turn of Implement, or Review in a fresh context if Implement finishes");
  });

  it("names what Continue moves on to", () => {
    assert.equal(continueLabel(view({ nextCard: "Plan" })), "Continue to Plan");
    assert.equal(continueLabel(view()), "Continue the chain");
  });
});

describe("announcement", () => {
  const asked = (n: number, header?: string) => view({ phase: "waiting", card: "Brainstorm", question: { id: "q1", card: "Brainstorm", questions: Array.from({ length: n }, () => ({ ...single, ...(header ? { header } : {}) })) } });

  it("announces a new question by its header, else its text, or how many there are", () => {
    assert.equal(announcement(view(), asked(1, "Store")), "Brainstorm asks: Store");
    assert.equal(announcement(undefined, asked(1)), "Brainstorm asks: Which store?");
    assert.equal(announcement(view(), asked(2)), "Brainstorm asks 2 questions");
    assert.equal(announcement(asked(1), asked(1)), undefined);
  });

  it("announces that a card waits, and whether Continue is ready", () => {
    assert.equal(announcement(view(), view({ phase: "waiting" })), "Implement is waiting for you");
    assert.equal(announcement(undefined, view({ phase: "waiting", continueReady: true })), "Implement is waiting for you; Continue is ready");
  });

  it("announces the end of the run, and a message handed back", () => {
    assert.equal(announcement(view(), view({ phase: "ended", returned: "x" })), "The run ended before your message was sent; it is back in the message box.");
    assert.equal(announcement(view(), view({ phase: "ended" })), "The run has ended.");
    assert.equal(announcement(view({ phase: "ended" }), view({ phase: "ended" })), undefined);
  });

  it("announces once that answers were sent while the card runs on, and not when the run ended with the form open", () => {
    const open = view({ question: { id: "q1", card: "Implement", questions: [single] } });
    assert.equal(announcement(open, view()), "Answers sent; Implement is working on them");
    assert.equal(announcement(view(), view()), undefined);
    assert.equal(announcement(open, view({ phase: "ended" })), "The run has ended.");
  });

  it("announces a queued message with where it goes, and a pause asked for", () => {
    assert.equal(announcement(view(), view({ queued: [{ id: "m1", text: "x" }] })), "Message queued for the next turn of Implement");
    assert.equal(announcement(undefined, view({ queued: [{ id: "m1", text: "x" }] })), "Message queued for the next turn of Implement");
    assert.equal(announcement(view({ queued: [{ id: "m1", text: "x" }] }), view()), undefined);
    assert.equal(announcement(view(), view({ pausePending: true })), "Implement will wait for you after this turn");
    assert.equal(announcement(view({ pausePending: true }), view({ pausePending: true })), undefined);
  });
});

describe("entriesAnnouncement", () => {
  it("names the card of the latest reply, else the card the user's message reached, and stays quiet for tool calls", () => {
    assert.equal(entriesAnnouncement([{ kind: "assistant", card: "Plan", text: "a" }, { kind: "assistant", card: "Implement", text: "b" }, { kind: "tool", card: "Implement", name: "Read", input: "{}" }]), "Implement replied");
    assert.equal(entriesAnnouncement([{ kind: "tool", card: "Implement", name: "Read", input: "{}" }, { kind: "you", card: "Implement", text: "hi" }]), "Your message reached Implement");
    assert.equal(entriesAnnouncement([{ kind: "tool", card: "Implement", name: "Read", input: "{}" }]), undefined);
  });
});

describe("busyLabel", () => {
  it("counts whole seconds up since the turn started and since its last activity, with the last tool", () => {
    assert.equal(busyLabel({ since: 1000, lastAt: 150_000, last: "Bash" }, 192_900), "Working 3:11 · last activity 0:42 ago · Bash");
  });

  it("names no tool before one was called, and shows hours from one hour on", () => {
    assert.equal(busyLabel({ since: 0, lastAt: 0 }, 3_600_000), "Working 1:00:00 · last activity 1:00:00 ago");
  });

  it("reads a clock that moved back as no time at all", () => {
    assert.equal(busyLabel({ since: 5000, lastAt: 5000 }, 1000), "Working 0:00 · last activity 0:00 ago");
  });
});

describe("cacheLabel", () => {
  const cache = (ttlMs: number, assumed = false) => ({ since: 1000, ttlMs, assumed });

  it("shows minutes and seconds left, rounding a part second up", () => {
    assert.deepEqual(cacheLabel(cache(300_000), 1000), { text: "Prompt cache warm for 5:00", expired: false });
    assert.deepEqual(cacheLabel(cache(300_000), 1000 + 299_500), { text: "Prompt cache warm for 0:01", expired: false });
  });

  it("shows hours from one hour left", () => {
    assert.equal(cacheLabel(cache(3_600_000), 1000).text, "Prompt cache warm for 1:00:00");
    assert.equal(cacheLabel(cache(3_600_000), 2000).text, "Prompt cache warm for 59:59");
  });

  it("is expired at the end of the lifetime and after it, also after the computer slept", () => {
    assert.equal(cacheLabel(cache(300_000), 301_000).expired, true);
    assert.equal(cacheLabel(cache(300_000), 10_000_000).text, "Prompt cache expired: your next message re-reads the whole conversation without the cache discount.");
  });

  it("says when five minutes is assumed", () => {
    assert.equal(cacheLabel(cache(300_000, true), 1000).text, "Prompt cache warm for 5:00 (assumed 5-minute cache)");
    assert.match(cacheLabel(cache(300_000, true), 400_000).text, /\(assumed 5-minute cache\)$/);
  });
});

describe("chat height", () => {
  it("moves in steps with the arrow keys, up for taller, and stops at the bounds", () => {
    assert.equal(heightForKey(35, "ArrowUp"), 40);
    assert.equal(heightForKey(35, "ArrowDown"), 30);
    assert.equal(heightForKey(CHAT_HEIGHT.max, "ArrowUp"), CHAT_HEIGHT.max);
    assert.equal(heightForKey(CHAT_HEIGHT.min, "ArrowDown"), CHAT_HEIGHT.min);
  });

  it("goes to the smallest with Home and the largest with End, and leaves other keys alone", () => {
    assert.equal(heightForKey(35, "Home"), CHAT_HEIGHT.min);
    assert.equal(heightForKey(35, "End"), CHAT_HEIGHT.max);
    assert.equal(heightForKey(35, "Enter"), undefined);
  });

  it("puts the divider under the pointer, within the bounds", () => {
    assert.equal(heightFromPointer(600, 1000), 40);
    assert.equal(heightFromPointer(990, 1000), CHAT_HEIGHT.min);
    assert.equal(heightFromPointer(0, 1000), CHAT_HEIGHT.max);
  });

  it("reads a saved height, and falls back to the initial one for anything else", () => {
    assert.equal(savedHeight(50), 50);
    assert.equal(savedHeight(500), CHAT_HEIGHT.max);
    assert.equal(savedHeight("50"), CHAT_HEIGHT.initial);
    assert.equal(savedHeight(Number.NaN), CHAT_HEIGHT.initial);
    assert.equal(savedHeight(undefined), CHAT_HEIGHT.initial);
  });

  it("fills the editor only when true was saved", () => {
    assert.equal(savedMax(true), true);
    for (const value of [false, "true", 1, undefined]) assert.equal(savedMax(value), false);
  });
});

describe("a card that needs you", () => {
  const parked = view({ phase: "waiting", card: "Implement", attended: true, parked: "docker is not installed. " });

  it("says why the card stopped and how to move on, and names Continue for the card", () => {
    assert.equal(statusLine(parked), "Implement needs you: docker is not installed. Reply to it, or fix the cause and choose Continue to try again.");
    assert.equal(continueLabel({ ...parked, nextCard: "Review" }), "Continue Implement");
  });

  it("is announced once, when the card starts waiting", () => {
    assert.equal(announcement(view({ card: "Implement" }), parked), "Implement needs you: docker is not installed. ");
    assert.equal(announcement(parked, parked), undefined);
  });
});

describe("a question with a time limit", () => {
  const question = { id: "q1", card: "Plan", questions: [{ question: "Which store?", header: "Store", options: [{ label: "SQLite (Recommended)" }] }] };

  it("is announced with what happens when its time runs out", () => {
    assert.equal(announcement(view({ card: "Plan" }), view({ card: "Plan", question: { ...question, expiresAt: 300_000 } })), "Plan asks: Store. If you do not answer in time, it takes the recommended answer");
    assert.equal(announcement(view({ card: "Plan" }), view({ card: "Plan", question })), "Plan asks: Store");
  });

  it("counts the time left from the clock, and says when it is up", () => {
    assert.equal(expiryLabel(300_000, 0), "Takes the recommended answer in 5:00 unless you answer.");
    assert.equal(expiryLabel(300_000, 299_001), "Takes the recommended answer in 0:01 unless you answer.");
    assert.equal(expiryLabel(300_000, 300_000), "Taking the recommended answer.");
  });

  it("announces a question taken without the user by its card, after a reply", () => {
    const decided = { kind: "decided", card: "Plan", question: "Which store?", answer: "SQLite", after: "at once" } as const;
    assert.equal(entriesAnnouncement([decided]), "Plan took the recommended answer");
    assert.equal(entriesAnnouncement([decided, { kind: "assistant", card: "Plan", text: "ok" }]), "Plan replied");
  });
});

describe("markdown", () => {
  const t = (text: string): Inline => ({ type: "text", text });
  const p = (...inline: Inline[]): Block => ({ type: "p", inline });

  it("keeps text without markup as one paragraph, a line break where the model broke the line", () => {
    assert.deepEqual(markdown("just text\nover two lines"), [p(t("just text"), { type: "br" }, t("over two lines"))]);
    assert.deepEqual(markdown(""), []);
  });

  it("splits fenced blocks out as code with their language, and the text around them into paragraphs", () => {
    assert.deepEqual(markdown("Run:\n```sh\ndocker --version\n```\nThen:\n~~~\nnode --version\nnpm --version\n~~~"), [
      p(t("Run:")),
      { type: "code", lang: "sh", text: "docker --version" },
      p(t("Then:")),
      { type: "code", lang: "", text: "node --version\nnpm --version" },
    ]);
  });

  it("leaves an unclosed fence as text", () => {
    assert.deepEqual(markdown("Run:\n```sh\ndocker --version"), [p(t("Run:"), { type: "br" }, t("```sh"), { type: "br" }, t("docker --version"))]);
  });

  it("takes the list item's indent off a fence inside it, so the command has no stray spaces or empty last line", () => {
    const [list] = markdown("2. In Konsole, check:\n   ```\n   docker run --rm hello-world\n   ```\n3. Start it.");
    assert.deepEqual(list, {
      type: "list",
      ordered: true,
      start: 2,
      items: [
        { blocks: [p(t("In Konsole, check:")), { type: "code", lang: "", text: "docker run --rm hello-world" }] },
        { blocks: [p(t("Start it."))] },
      ],
    });
  });

  it("reads headings, rules, quotes, and tasks", () => {
    assert.deepEqual(markdown("## Still blocked ##\n\n---\n> quoted\n> on"), [
      { type: "h", level: 2, inline: [t("Still blocked")] },
      { type: "hr" },
      { type: "quote", blocks: [p(t("quoted"), { type: "br" }, t("on"))] },
    ]);
    assert.deepEqual(markdown("- [x] done\n- [ ] not yet"), [
      { type: "list", ordered: false, start: 1, items: [{ task: true, blocks: [p(t("done"))] }, { task: false, blocks: [p(t("not yet"))] }] },
    ]);
  });

  it("starts a list right under a paragraph, nests an indented one, and keeps items apart by a blank line in one list", () => {
    const [intro, list] = markdown("Neither file is committed:\n- **`a.md`** is copied\n  - nested\n\n- second");
    assert.deepEqual(intro, p(t("Neither file is committed:")));
    assert.deepEqual(list, {
      type: "list",
      ordered: false,
      start: 1,
      items: [
        { blocks: [p({ type: "strong", children: [{ type: "code", text: "a.md" }] }, t(" is copied")), { type: "list", ordered: false, start: 1, items: [{ blocks: [p(t("nested"))] }] }] },
        { blocks: [p(t("second"))] },
      ],
    });
  });

  it("reads a table with its alignment, padding short rows", () => {
    assert.deepEqual(markdown("| Step | Done |\n|:--|--:|\n| one | `yes` |\n| two |"), [
      { type: "table", align: ["left", "right"], head: [[t("Step")], [t("Done")]], rows: [[[t("one")], [{ type: "code", text: "yes" }]], [[t("two")], []]] },
    ]);
  });

  it("reads emphasis, strikethrough, and escapes, and leaves snake_case and lone stars alone", () => {
    assert.deepEqual(inline("**bold** *em* _em_ ~~gone~~ ***both***"), [
      { type: "strong", children: [t("bold")] },
      t(" "),
      { type: "em", children: [t("em")] },
      t(" "),
      { type: "em", children: [t("em")] },
      t(" "),
      { type: "del", children: [t("gone")] },
      t(" "),
      { type: "strong", children: [{ type: "em", children: [t("both")] }] },
    ]);
    assert.deepEqual(inline("snake_case_name and 2 * 3 * 4 and \\*not em\\*"), [t("snake_case_name and 2 * 3 * 4 and *not em*")]);
    assert.deepEqual(inline("`**not bold**`"), [{ type: "code", text: "**not bold**" }]);
  });

  it("links only web addresses, and shows any other target as text", () => {
    assert.deepEqual(inline("[docs](https://example.com/a) and https://example.com/b."), [
      { type: "link", href: "https://example.com/a", target: "https://example.com/a", children: [t("docs")] },
      t(" and "),
      { type: "link", href: "https://example.com/b", target: "https://example.com/b", children: [t("https://example.com/b")] },
      t("."),
    ]);
    assert.deepEqual(inline("[plan](.claude/plans/slice-1.md) [x](javascript:alert(1))"), [
      { type: "link", target: ".claude/plans/slice-1.md", children: [t("plan")] },
      t(" "),
      { type: "link", target: "javascript:alert(1)", children: [t("x")] },
    ]);
  });

  it("keeps raw HTML as text", () => {
    assert.deepEqual(markdown("<b>bold</b>"), [p(t("<b>bold</b>"))]);
  });

  it("drops a heading's closing #s only when a space sets them off, and reads a fence with a backtick in its info as text", () => {
    assert.deepEqual(markdown("#   spaced   #\n# a##\n# ###\n# plain"), [
      { type: "h", level: 1, inline: [t("spaced")] },
      { type: "h", level: 1, inline: [t("a##")] },
      { type: "h", level: 1, inline: [t("###")] },
      { type: "h", level: 1, inline: [t("plain")] },
    ]);
    assert.deepEqual(markdown("```a`b\nx"), [p(t("```a`b"), { type: "br" }, t("x"))]);
  });

  it("closes a backtick fence after an unclosed tilde fence, and leaves every unclosed fence as text", () => {
    assert.deepEqual(markdown("~~~\n```\nx\n```"), [p(t("~~~")), { type: "code", lang: "", text: "x" }]);
    assert.deepEqual(markdown("```a\n\n```b"), [p(t("```a")), p(t("```b"))]);
  });

  it("keeps an escaped pipe in its cell, and a list item open across a blank line when the next line is indented under it", () => {
    assert.deepEqual(markdown("| a \\| b | c |\n|-|-|"), [{ type: "table", align: [undefined, undefined], head: [[t("a | b")], [t("c")]], rows: [] }]);
    assert.deepEqual(markdown("- a\n\n  b"), [{ type: "list", ordered: false, start: 1, items: [{ blocks: [p(t("a")), p(t("b"))] }] }]);
  });

  it("reads a backslash line break, an angle-bracket address, and a star or escape inside emphasis", () => {
    assert.deepEqual(inline("a\\\nb <https://example.com>"), [t("a"), { type: "br" }, t("b "), { type: "link", href: "https://example.com/", target: "https://example.com", children: [t("https://example.com")] }]);
    assert.deepEqual(inline("*a**b* *c \\* d*"), [{ type: "em", children: [t("a**b")] }, t(" "), { type: "em", children: [t("c * d")] }]);
  });

  it("puts no link inside a link: a web address as a link's words stays text", () => {
    assert.deepEqual(inline("[https://a.example](https://b.example) ![see <https://c.example>](https://d.example/i.png)"), [
      { type: "link", href: "https://b.example/", target: "https://b.example", children: [t("https://a.example")] },
      t(" "),
      { type: "link", href: "https://d.example/i.png", target: "https://d.example/i.png", children: [t("see <https://c.example>")] },
    ]);
  });

  it("shows a reply longer than MAX_MARKDOWN as written, its line breaks kept, without reading its markup", () => {
    const long = `**not bold**\n\n${"x".repeat(MAX_MARKDOWN)}`;
    assert.deepEqual(markdown(long), [p(t("**not bold**"), { type: "br" }, { type: "br" }, t("x".repeat(MAX_MARKDOWN)))]);
    assert.deepEqual(markdown(" ".repeat(MAX_MARKDOWN + 1)), []);
  });

  it("stops nesting at MAX_DEPTH, so a reply of thousands of quote markers or brackets cannot overflow the stack", () => {
    let [block] = markdown(`${">".repeat(20_000)} x`);
    for (let level = 0; level < MAX_DEPTH; level++) {
      assert.equal(block?.type, "quote");
      [block] = (block as Extract<Block, { type: "quote" }>).blocks;
    }
    assert.deepEqual(block, p(t(`${">".repeat(20_000 - MAX_DEPTH)} x`)));
    const [list] = markdown(Array.from({ length: 40 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n"));
    assert.equal(list?.type, "list");
    const links = inline(`${"[".repeat(10_000)}x${"](y)".repeat(10_000)}`);
    assert.equal(links[0]?.type, "link");
  });

  it("parses a reply at the size cap built to make a parser backtrack or rescan, each well within a second", () => {
    const n = MAX_MARKDOWN - 10;
    const shapes = {
      "unclosed stars": "*a ".repeat(n / 3),
      "unclosed underscores": "_a ".repeat(n / 3),
      "unclosed brackets": "[".repeat(n),
      "unclosed angles": "<".repeat(n),
      "unclosed fences": "```a\n".repeat(n / 5),
      "a fence info string ending in a backtick": `\`\`\`${"a".repeat(n)}\``,
      "a delimiter row of spaces": `a|b\n-${" ".repeat(n)}x`,
      "a heading of spaces": `# a${" ".repeat(n)}b`,
      "list markers on one line": `${"- ".repeat(n / 2)}x`,
    };
    for (const [shape, text] of Object.entries(shapes)) {
      const start = performance.now();
      markdown(text);
      assert.ok(performance.now() - start < 1000, shape);
    }
  });
});

describe("attention", () => {
  const base: ChatView = { phase: "running", attended: false, queued: [], continueReady: false, pausePending: false };
  it("says a card waits for the user's answer, waits for them, or works; after the run, nothing", () => {
    assert.deepEqual(attention({ ...base, question: { id: "q", card: "Plan", questions: [] } }), { kind: "needs", text: "Waiting for your answer" });
    assert.deepEqual(attention({ ...base, phase: "waiting" }), { kind: "needs", text: "Waiting for you" });
    assert.deepEqual(attention(base), { kind: "working", text: "Working" });
    assert.equal(attention({ ...base, phase: "waiting", afterRun: true }), undefined);
    assert.equal(attention({ ...base, phase: "idle" }), undefined);
  });
});

describe("copyable", () => {
  it("copies a block up to the message cap, not past it", () => {
    assert.equal(copyable("x".repeat(MAX_INPUT_CHARS)), true);
    assert.equal(copyable("x".repeat(MAX_INPUT_CHARS + 1)), false);
  });

  it("copies no block with a bidi control or a zero-width character, which can make it read as another command", () => {
    for (const code of [0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff]) {
      const text = `echo safe${String.fromCharCode(code)} && rm -rf ~`;
      assert.equal(hasHidden(text), true, code.toString(16));
      assert.equal(copyable(text), false, code.toString(16));
    }
    assert.equal(hasHidden("sudo apt install docker.io — ok"), false);
  });
});
