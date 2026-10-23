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
  const toggle = el("button", { type: "button", "aria-expanded": "true", "aria-controls": "chat-body", onclick: () => setOpen(toggle.getAttribute("aria-expanded") !== "true") }, "Hide chat");
  const line = el("p", { class: "chat-status" });
  // Plain text, not a live region: it changes every second. Only the expiry is announced, once.
  const cacheLine = el("p", { class: "chat-cache", hidden: true });
  let cacheTimer;
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
  const body = el(
    "div",
    { id: "chat-body" },
    line,
    cacheLine,
    transcript,
    queuedList,
    form,
    el("div", { class: "composer" }, inputLabel, input, error, el("div", { class: "toolbar" }, sendButton, pauseButton, continueButton, stopButton)),
  );
  root.replaceChildren(el("div", { class: "chat-head" }, title, toggle), body);

  // The divider between the chains and the chat: the window-splitter pattern, its value the chat's share of the window.
  const { min, max } = logic.CHAT_HEIGHT;
  let height = logic.savedHeight(vscode.getState()?.chatHeight);
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
    root.style.height = `${next}vh`;
    splitter.setAttribute("aria-valuenow", String(next));
    splitter.setAttribute("aria-valuetext", `${next}% of the window`);
    if (save) remember({ chatHeight: next });
  }
  setHeight(height, false);

  // A hidden chat shrinks to its heading, and there is nothing to resize.
  function setOpen(open) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Hide chat" : "Show chat";
    body.hidden = !open;
    splitter.hidden = !open;
    root.style.height = open ? `${height}vh` : "";
  }

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
        return el("li", { class: "entry assistant" }, el("span", { class: "who" }, e.card), el("p", { class: "text" }, e.text));
      case "tool":
        return el("li", { class: "entry tool" }, el("span", { class: "visually-hidden" }, `${e.card} used `), el("code", {}, `${e.name} ${e.input}`));
      case "you":
        return el("li", { class: "entry you" }, el("span", { class: "who" }, `You to ${e.card}`), el("p", { class: "text" }, e.text));
      case "answer":
        return el("li", { class: "entry you" }, el("span", { class: "who" }, `You answered ${e.card}`), el("p", { class: "text" }, `${e.question} → ${e.answer}`));
      case "divider":
        return el("li", { class: "handover" }, `fresh context: session ${e.session + 1}`);
      default:
        return el("li", { class: "note", "data-dropped": "true" }, "Earlier messages were dropped to keep the chat short.");
    }
  }

  // The page keeps the newest entries, as the extension does, so a long run cannot grow it without end.
  function append(entries) {
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    transcript.append(...entries.map(entry));
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
    title.textContent = next.title ? `Run: ${next.title}` : "Run";
    line.textContent = logic.statusLine(next);
    inputLabel.textContent = next.card ? `Message to ${next.card}` : "Message";
    sendButton.setAttribute("aria-disabled", String(!logic.canSend(next)));
    stopButton.setAttribute("aria-disabled", String(!logic.canSend(next)));
    pauseButton.setAttribute("aria-disabled", String(!logic.canPause(next)));
    pauseButton.textContent = next.pausePending ? "Pausing after this turn" : "Pause after this turn";
    continueButton.hidden = next.phase !== "waiting";
    continueButton.textContent = logic.continueLabel(next);
    continueButton.classList.toggle("run", next.continueReady);

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
      renderQuestion(next.question);
      if (next.question && inside) form.querySelector("input").focus();
      // Focus landing on a lone question reads it out already, so announcing it would say it twice. With several, focus reads
      // only the first, so the count is still announced.
      readByFocus = next.question !== undefined && inside && next.question.questions.length === 1;
    }
    if (next.returned && !prev?.returned) {
      input.value = input.value ? `${next.returned}\n\n${input.value}` : next.returned;
    }
    const said = prev && !readByFocus ? logic.announcement(prev, next) : undefined;
    if (said) announce(said);
    showCache(next);
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
}
