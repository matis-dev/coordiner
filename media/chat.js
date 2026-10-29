// The run's chat, docked under the chains editor. It is built once and updated in place, so a new message never replaces the
// message box the user is typing in. All text reaches the page through textContent, never as markup.
export function startChat({ vscode, root, logic, maxChars, announce, remember }) {
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) if (child !== undefined && child !== null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  }

  const idle = { phase: "idle", attended: false, queued: [], continueReady: false, pausePending: false };
  let chat = idle;

  const title = el("h2", { id: "chat-h" }, "Run");
  // Next to the title, so it shows while the chat is hidden: a card working, or waiting for the user. Not a live region; the
  // status region already says each change once.
  const chipText = el("span");
  const chip = el("span", { class: "run-chip", hidden: true }, el("span", { class: "dot", "aria-hidden": "true" }), chipText);
  const toggle = el("button", { type: "button", "aria-expanded": "true", "aria-controls": "chat-body", onclick: () => setOpen(toggle.getAttribute("aria-expanded") !== "true") }, "Hide chat");
  // A toggle whose name stays put: the pressed state says which way it is.
  const maxButton = el("button", { type: "button", "aria-pressed": "false", onclick: () => setMax(maxButton.getAttribute("aria-pressed") !== "true") }, "Maximize chat");
  const line = el("p", { class: "chat-status" });
  // Plain text, not a live region: it changes every second. Only the expiry is announced, once.
  const cacheLine = el("p", { class: "chat-cache", hidden: true });
  let cacheTimer;
  // The same for a running turn: how long it has run, and its last sign of life. Never announced.
  const busyLine = el("p", { class: "chat-busy", hidden: true });
  let busyTimer;
  // A question the run answers itself when its time runs out shows the time left. Plain text: it changes every second.
  const expiryLine = el("p", { class: "note expiry" });
  let expiryTimer;
  const transcript = el("ol", { id: "transcript", "aria-label": "Run transcript" });
  const queuedList = el("ul", { class: "queued", "aria-label": "Queued messages" });
  const form = el("form", { class: "question", "aria-labelledby": "question-h", hidden: true, onsubmit: (e) => (e.preventDefault(), submitAnswers()) });
  const inputLabel = el("label", { for: "chat-input" }, "Message");
  const input = el("textarea", { id: "chat-input", rows: 3, "aria-describedby": "chat-error", onkeydown: (e) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    send();
  } });
  const error = el("p", { id: "chat-error", class: "reason" });
  const sendButton = el("button", { type: "button", class: "run", onclick: () => send() }, "Send");
  const pauseButton = el("button", { type: "button", onclick: () => {
    if (!logic.canPause(chat)) return;
    vscode.postMessage({ type: "chatPause" });
  } }, "Pause after this turn");
  const continueButton = el("button", { type: "button", hidden: true, onclick: () => {
    vscode.postMessage({ type: "chatContinue" });
    input.focus();
  } }, "Continue the chain");
  const stopButton = el("button", { type: "button", onclick: () => logic.canSend(chat) && vscode.postMessage({ type: "chatStop" }) }, "Stop run");
  // After the run. The extension builds the command and knows the worktree; the page only asks.
  const copyButton = el("button", { type: "button", hidden: true, onclick: () => {
    vscode.postMessage({ type: "chatCopyResume" });
    announce("Resume command copied");
  } }, "Copy resume command");
  const nextButton = el("button", { type: "button", hidden: true, onclick: () => {
    vscode.postMessage({ type: "chatNextChain" });
    input.focus();
  } }, "Start the next chain here");
  const composer = el("div", { class: "composer" }, inputLabel, input, error, el("div", { class: "toolbar" }, sendButton, pauseButton, continueButton, copyButton, nextButton, stopButton));
  const headActions = el("div", { class: "chat-head-actions" }, maxButton, toggle);
  const body = el("div", { id: "chat-body" }, line, busyLine, cacheLine, transcript, queuedList, form, composer);
  root.replaceChildren(el("div", { class: "chat-head" }, el("div", { class: "chat-title" }, title, chip), headActions), body);

  // The divider between the chains and the chat: the window-splitter pattern, its value the chat's share of the window.
  const { min, max } = logic.CHAT_HEIGHT;
  let height = logic.savedHeight(vscode.getState()?.chatHeight);
  let maximized = logic.savedMax(vscode.getState()?.chatMax);
  const splitter = el("div", {
    id: "chat-splitter",
    role: "separator",
    tabindex: "0",
    "aria-orientation": "horizontal",
    "aria-label": "Chat height",
    "aria-controls": "chat",
    "aria-valuemin": min,
    "aria-valuemax": max,
    onkeydown: (e) => {
      const next = logic.heightForKey(height, e.key);
      if (next === undefined) return;
      e.preventDefault();
      setHeight(next, true);
    },
    onpointerdown: (e) => {
      e.preventDefault();
      const move = (ev) => setHeight(logic.heightFromPointer(ev.clientY, window.innerHeight), false);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setHeight(height, true);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
  });
  root.before(splitter);

  function setHeight(next, save) {
    height = next;
    splitter.setAttribute("aria-valuenow", String(next));
    splitter.setAttribute("aria-valuetext", `${next}% of the window`);
    if (save) remember({ chatHeight: next });
    layout();
  }

  // A hidden chat shrinks to its heading, and a maximized one fills the editor in place of the chains: in neither is there anything
  // to resize. Before the first run the chat is folded to its heading and status line, so the chains have the room; a saved height
  // or maximize waits for the run. The saved height stays, so the chat comes back to it.
  function layout() {
    const open = !body.hidden;
    const folded = chat.phase === "idle";
    splitter.hidden = !open || maximized || folded;
    root.style.height = open && !maximized && !folded ? `${height}vh` : "";
    document.body.classList.toggle("chat-max", open && maximized && !folded);
  }

  function setOpen(open) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Hide chat" : "Show chat";
    body.hidden = !open;
    // A hidden chat cannot fill the editor, so hiding it gives the chains their room back.
    if (!open && maximized) setMax(false);
    else layout();
  }

  function setMax(on) {
    maximized = on;
    maxButton.setAttribute("aria-pressed", String(on));
    remember({ chatMax: on });
    if (on && body.hidden) setOpen(true);
    else layout();
  }

  maxButton.setAttribute("aria-pressed", String(maximized));
  setHeight(height, false);

  function showError(text) {
    error.textContent = text;
    if (text) {
      input.setAttribute("aria-invalid", "true");
      announce(text);
    } else {
      input.removeAttribute("aria-invalid");
    }
  }

  function send() {
    if (!logic.canSend(chat)) return announce("No run is going, so there is nobody to send this to.");
    const text = input.value;
    if (text.trim() === "") return showError("Write a message first.");
    if (text.length > maxChars) return showError(`Keep it under ${maxChars} characters.`);
    showError("");
    vscode.postMessage({ type: "chatSend", text });
    input.value = "";
    input.focus();
  }

  // ── Transcript ──────────────────────────────────────────────────────────────

  function entry(e) {
    switch (e.kind) {
      case "assistant":
        return el("li", { class: "entry assistant" }, el("span", { class: "who" }, e.card), el("div", { class: "md" }, markdown(e.text)));
      // A long input scrolls in its own small box (see scrollable).
      case "tool":
        return el(
          "li",
          { class: "entry tool" },
          el("span", { class: "visually-hidden" }, `${e.card} used `),
          el("span", { class: "tool-name" }, e.name),
          e.input ? el("pre", { class: "tool-input", "data-tool": e.name }, e.input) : undefined,
        );
      case "you":
        return el("li", { class: "entry you" }, el("span", { class: "who" }, `You to ${e.card}`), el("p", { class: "text" }, e.text));
      case "answer":
        return el("li", { class: "entry you" }, el("span", { class: "who" }, `You answered ${e.card}`), el("p", { class: "text" }, `${e.question} → ${e.answer}`));
      case "decided":
        return el("li", { class: "entry" }, el("span", { class: "who" }, `Recommended answer taken for ${e.card}, ${e.after}`), el("p", { class: "text" }, `${e.question} → ${e.answer}`));
      case "divider":
        return el("li", { class: "handover" }, `fresh context: session ${e.session + 1}`);
      case "end":
        return el("li", { class: "handover" }, logic.endedLine(e));
      case "failed":
        return el("li", { class: "note" }, `${e.card} could not answer: ${e.error}`);
      default:
        return el("li", { class: "note", "data-dropped": "true" }, "Earlier messages were dropped to keep the chat short.");
    }
  }

  // ── Markdown ────────────────────────────────────────────────────────────────

  // The parsed reply (src/chat-logic.ts) built as elements; every piece of model text goes in as a text node. Headings start at h3,
  // under the chat's own h2. Fenced commands get a Copy button the user presses; the extension writes the clipboard, and nothing
  // runs them. A block with hidden characters gets a warning instead, since selecting it by hand copies them too.
  function markdown(text) {
    let n = 0;
    const blocks = (list) => list.map(block);
    function block(b) {
      switch (b.type) {
        case "p":
          return el("p", { class: "text" }, inline(b.inline));
        case "h":
          return el(`h${Math.min(b.level + 2, 6)}`, { class: "md-h" }, inline(b.inline));
        case "code":
          n += 1;
          return codeBlock(b.text, n);
        case "list":
          return el(
            b.ordered ? "ol" : "ul",
            { start: b.ordered && b.start !== 1 ? b.start : undefined },
            b.items.map((item) =>
              el(
                "li",
                { class: item.task === undefined ? undefined : "task" },
                item.task === undefined ? undefined : el("input", { type: "checkbox", disabled: true, checked: item.task, "aria-label": item.task ? "done" : "not done" }),
                blocks(item.blocks),
              ),
            ),
          );
        case "quote":
          return el("blockquote", {}, blocks(b.blocks));
        case "table": {
          const cell = (tag, content, k) => el(tag, { class: b.align[k] ? `align-${b.align[k]}` : undefined }, inline(content));
          return el(
            "div",
            { class: "table" },
            el("table", {}, el("thead", {}, el("tr", {}, b.head.map((c, k) => cell("th", c, k)))), el("tbody", {}, b.rows.map((row) => el("tr", {}, row.map((c, k) => cell("td", c, k)))))),
          );
        }
        default:
          return el("hr");
      }
    }
    return blocks(logic.markdown(text));
  }

  function inline(nodes) {
    return nodes.map((node) => {
      switch (node.type) {
        case "text":
          return document.createTextNode(node.text);
        case "code":
          return el("code", {}, node.text);
        case "strong":
        case "em":
        case "del":
          return el(node.type === "strong" ? "strong" : node.type === "em" ? "em" : "del", {}, inline(node.children));
        case "link": {
          // Only a web address is a link, and VS Code asks before opening it. Any other target is shown, not followed.
          if (node.href) return el("a", { href: node.href, title: node.href, rel: "noreferrer" }, inline(node.children));
          const words = inline(node.children);
          const said = words.map((w) => w.textContent).join("");
          return el("span", {}, words, said === node.target ? undefined : el("span", { class: "target" }, ` (${node.target})`));
        }
        default:
          return el("br");
      }
    });
  }

  const SVG = "http://www.w3.org/2000/svg";
  function icon(paths) {
    const svg = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
    for (const d of paths) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  const copyIcon = () => icon(["M5.5 5.5h8v9h-8z", "M3.5 10.5h-1v-9h8v1"]);
  const doneIcon = () => icon(["M3 8.5l3 3 7-7"]);

  // The Copy button is an icon in the block's corner, shown when the pointer is over the block or the button has focus.
  function codeBlock(text, index) {
    const pre = el("pre", {}, el("code", {}, text));
    if (logic.hasHidden(text)) return el("div", { class: "code" }, pre, el("p", { class: "note" }, "This command contains hidden characters, so it may not run as it reads. Do not run it."));
    if (!logic.copyable(text)) return el("div", { class: "code" }, pre);
    let reset;
    const button = el("button", { type: "button", class: "copy-code", "aria-label": `Copy command ${index}`, title: "Copy", onclick: () => {
      vscode.postMessage({ type: "chatCopyText", text });
      announce(`Copied command ${index}`);
      button.replaceChildren(doneIcon());
      clearTimeout(reset);
      reset = setTimeout(() => button.replaceChildren(copyIcon()), 1500);
    } }, copyIcon());
    return el("div", { class: "code copyable" }, pre, button);
  }

  // A tool's input box is a Tab stop, named for its tool, only while it scrolls: one that shows all of its input needs no stop, and
  // with one per tool call the keyboard would pass every call in the transcript on the way to the message box.
  function scrollable(pre) {
    if (pre.scrollHeight > pre.clientHeight) {
      pre.tabIndex = 0;
      pre.setAttribute("role", "group");
      pre.setAttribute("aria-label", `${pre.dataset.tool} input`);
    } else for (const name of ["tabindex", "role", "aria-label"]) pre.removeAttribute(name);
  }

  // A new width rewraps every box, and a chat shown again after Hide has its first real size.
  if (typeof ResizeObserver === "function") new ResizeObserver(() => transcript.querySelectorAll("pre.tool-input").forEach(scrollable)).observe(transcript);

  // The page keeps the newest entries, as the extension does, so a long run cannot grow it without end.
  function append(entries) {
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    const added = entries.map(entry);
    transcript.append(...added);
    for (const li of added) li.querySelectorAll("pre.tool-input").forEach(scrollable);
    const kept = [...transcript.children].filter((li) => !li.dataset.dropped);
    if (kept.length > logic.MAX_ENTRIES) {
      for (const li of kept.slice(0, kept.length - logic.MAX_ENTRIES)) li.remove();
      if (!transcript.firstElementChild.dataset.dropped) transcript.prepend(entry({ kind: "dropped" }));
    }
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  // ── Question form ───────────────────────────────────────────────────────────

  function renderQuestion(question) {
    form.replaceChildren();
    form.hidden = !question;
    if (!question) return;
    form.append(el("h3", { id: "question-h" }, `${question.card} asks`));
    if (question.expiresAt !== undefined) form.append(expiryLine);
    question.questions.forEach((q, i) => {
      const type = q.multiSelect ? "checkbox" : "radio";
      const name = `answer-${i}`;
      const options = q.options.map((o, j) => {
        const describedBy = o.description ? `${name}-d${j}` : undefined;
        return el(
          "div",
          { class: "option" },
          el("label", {}, el("input", { type, name, value: o.label, "aria-describedby": describedBy }), ` ${o.label}`),
          o.description ? el("p", { id: describedBy, class: "note" }, o.description) : undefined,
        );
      });
      const otherChoice = el("input", { type, name, "data-other": "true" });
      const otherText = el("input", { type: "text", "aria-label": `Other answer to: ${q.header || q.question}`, maxlength: maxChars, oninput: () => (otherChoice.checked = otherText.value.trim() !== "") });
      form.append(
        el(
          "fieldset",
          { "data-question": i },
          el("legend", {}, q.question, el("span", { class: "flag", hidden: true }, " (needs an answer)")),
          options,
          el("div", { class: "option" }, el("label", {}, otherChoice, " Other"), otherText),
        ),
      );
    });
    form.append(el("button", { type: "submit", class: "run" }, "Send answers"));
  }

  function picks() {
    return [...form.querySelectorAll("fieldset")].map((set) => {
      const checked = [...set.querySelectorAll("input:checked")];
      const other = checked.some((box) => box.dataset.other) ? set.querySelector('input[type="text"]').value : undefined;
      return { picked: checked.filter((box) => !box.dataset.other).map((box) => box.value), ...(other !== undefined ? { other } : {}) };
    });
  }

  function submitAnswers() {
    const question = chat.question;
    if (!question) return;
    const chosen = picks();
    const missing = logic.firstUnanswered(question.questions, chosen);
    const sets = [...form.querySelectorAll("fieldset")];
    sets.forEach((set, i) => (set.querySelector(".flag").hidden = i !== missing));
    if (missing !== -1) {
      sets[missing].querySelector("input").focus();
      return;
    }
    vscode.postMessage({ type: "chatAnswer", id: question.id, picks: chosen });
    input.focus();
  }

  // ── State ───────────────────────────────────────────────────────────────────

  function render(next, prev) {
    chat = next;
    // Nothing to send, stop, resize or read before the first run: only the heading and the status line show.
    const folded = next.phase === "idle";
    headActions.hidden = folded;
    composer.hidden = folded;
    transcript.hidden = folded;
    queuedList.hidden = folded;
    layout();
    title.textContent = next.title ? `Run: ${next.title}` : "Run";
    const attention = logic.attention(next);
    chip.hidden = !attention;
    chip.className = `run-chip ${attention?.kind ?? ""}`;
    chipText.textContent = attention?.text ?? "";
    line.textContent = logic.statusLine(next);
    inputLabel.textContent = next.card ? `Message to ${next.card}` : "Message";
    sendButton.setAttribute("aria-disabled", String(!logic.canSend(next)));
    stopButton.setAttribute("aria-disabled", String(!logic.canSend(next)));
    stopButton.textContent = next.afterRun ? "End chat" : "Stop run";
    pauseButton.hidden = Boolean(next.afterRun);
    pauseButton.setAttribute("aria-disabled", String(!logic.canPause(next)));
    pauseButton.textContent = next.pausePending ? "Pausing after this turn" : "Pause after this turn";
    continueButton.hidden = next.phase !== "waiting" || Boolean(next.afterRun);
    copyButton.hidden = !next.afterRun;
    nextButton.hidden = !next.afterRun;
    continueButton.textContent = logic.continueLabel(next);
    continueButton.classList.toggle("run", next.continueReady || Boolean(next.parked));

    queuedList.replaceChildren(
      ...next.queued.map((q, i) =>
        el(
          "li",
          {},
          el("span", { class: "who" }, `Queued for ${logic.destination(next)}`),
          el("p", { class: "text" }, q.text),
          el("button", { type: "button", "aria-label": `Withdraw queued message ${i + 1}`, onclick: () => {
            vscode.postMessage({ type: "chatWithdraw", id: q.id });
            input.focus();
          } }, "Withdraw"),
        ),
      ),
    );

    let readByFocus = false;
    if (next.question?.id !== prev?.question?.id) {
      const inside = root.contains(document.activeElement);
      // A question withdrawn while the user was in its form leaves focus in the message box, not on the page.
      const inForm = form.contains(document.activeElement);
      renderQuestion(next.question);
      if (next.question && inside) form.querySelector("input").focus();
      else if (inForm) input.focus();
      // Focus landing on a lone question reads it out already, so announcing it would say it twice. With several, focus reads
      // only the first, so the count is still announced.
      readByFocus = next.question !== undefined && inside && next.question.questions.length === 1;
    }
    // The run's controls go away when it ends; focus that was in the chat goes to the message box rather than to the page.
    const runEnded = (next.afterRun && !prev?.afterRun) || (next.phase === "ended" && prev?.phase !== "ended");
    if (prev && runEnded && root.contains(document.activeElement)) input.focus();
    if (next.returned && !prev?.returned) {
      input.value = input.value ? `${next.returned}\n\n${input.value}` : next.returned;
    }
    const said = prev && !readByFocus ? logic.announcement(prev, next) : undefined;
    if (said) announce(said);
    showCache(next);
    showBusy(next);
    showExpiry(next);
  }

  // One timer at most, running only while a question with a time limit is open.
  function showExpiry(next) {
    clearInterval(expiryTimer);
    expiryTimer = undefined;
    const expiresAt = next.question?.expiresAt;
    if (expiresAt === undefined) return;
    const tick = () => (expiryLine.textContent = logic.expiryLabel(expiresAt, Date.now()));
    tick();
    expiryTimer = setInterval(tick, 1000);
  }

  // One timer at most, running only while a turn runs; it reads the turn's clock, so a computer that slept shows the right time.
  function showBusy(next) {
    clearInterval(busyTimer);
    busyTimer = undefined;
    busyLine.hidden = !(next.phase === "running" && next.turn);
    if (busyLine.hidden) return;
    const tick = () => (busyLine.textContent = logic.busyLabel(next.turn, Date.now()));
    tick();
    busyTimer = setInterval(tick, 1000);
  }

  // One timer at most, running only while a card waits; any update starts over from the cache it carries.
  function showCache(next) {
    clearInterval(cacheTimer);
    cacheTimer = undefined;
    cacheLine.hidden = !(next.phase === "waiting" && next.cache);
    if (cacheLine.hidden) return;
    let expired = logic.cacheLabel(next.cache, Date.now()).expired;
    const tick = () => {
      const label = logic.cacheLabel(next.cache, Date.now());
      cacheLine.textContent = label.text;
      if (label.expired && !expired) announce(`Prompt cache expired for ${next.card}`);
      expired = label.expired;
      if (expired) {
        clearInterval(cacheTimer);
        cacheTimer = undefined;
      }
    };
    tick();
    if (!expired) cacheTimer = setInterval(tick, 1000);
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m?.type === "chat") {
      transcript.replaceChildren();
      append(m.entries);
      render(m.chat, undefined);
    } else if (m?.type === "chatUpdate") {
      render(m.chat, chat);
    } else if (m?.type === "chatAppend") {
      append(m.entries);
      const said = logic.entriesAnnouncement(m.entries);
      if (said) announce(said);
    }
  });

  render(idle, undefined);

  // A chain picked in the rail needs the column a maximized chat covers, or it opens out of sight and its focus goes nowhere.
  return { showChains: () => maximized && setMax(false) };
}
