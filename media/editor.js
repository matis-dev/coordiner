// Coordiner chains editor. All text reaches the page through textContent, never as markup.
// Everything lives inside start(), so a fresh page can start it again (the tests do; the webview starts it once).
export async function start() {
  const vscode = acquireVsCodeApi();
  const editUri = document.body.dataset.chainEdit;
  // Sibling modules keep the extension of the one we were given: .js from dist/ in VS Code, .ts from src/ under test.
  const sibling = (name) => editUri.replace(/chain-edit(\.[jt]s)$/, `${name}$1`);
  const edit = await import(editUri);
  const chainsModule = await import(sibling("chains"));
  const logic = await import(sibling("editor-logic"));
  const chatLogic = await import(sibling("chat-logic"));
  const { startChat } = await import("./chat.js");

  const rail = document.getElementById("rail");
  const detail = document.getElementById("detail");
  const banner = document.getElementById("banner");
  const status = document.getElementById("status");
  const chatRoot = document.getElementById("chat");

  let state = { templates: [], chains: [], running: false };
  let selectedId = vscode.getState()?.selectedId ?? "story";
  let pendingFocus;
  // A state that arrived while a field held unsaved typing, not rendered yet.
  let deferred = false;
  let shown;

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

  // The webview's saved state is shared with the chat (which keeps its height there), so each write keeps what the other wrote.
  const remember = (patch) => vscode.setState({ ...vscode.getState(), ...patch });

  const announce = (text) => {
    status.textContent = "";
    requestAnimationFrame(() => (status.textContent = text));
  };

  startChat({ vscode, root: chatRoot, logic: chatLogic, maxChars: chainsModule.MAX_INPUT_CHARS, announce, remember });

  const allChains = () => [...state.templates, ...state.chains];
  const selected = () => allChains().find((c) => c.id === selectedId) ?? state.templates[0];
  const newId = () => logic.newChainId(Date.now());

  function select(id) {
    selectedId = id;
    remember({ selectedId });
    pendingFocus = "chain-title";
    render();
  }

  // Optimistic: the edit shows at once, the extension saves it and sends the state back.
  function save(chain, message, focus) {
    state = { ...state, chains: state.chains.some((c) => c.id === chain.id) ? state.chains.map((c) => (c.id === chain.id ? chain : c)) : [...state.chains, chain] };
    pendingFocus = focus;
    vscode.postMessage({ type: "save", chain });
    render();
    if (message) announce(message);
  }

  function copyOf(chain) {
    const copy = edit.duplicate(chain, newId(), logic.copyName(chain.name));
    selectedId = copy.id;
    remember({ selectedId });
    save(copy, `Created ${copy.name}`, "chain-title");
  }

  function renderBanner() {
    banner.replaceChildren();
    if (state.storageError) {
      banner.append(
        el("section", { class: "banner error", "aria-labelledby": "storage-h" }, el("h2", { id: "storage-h" }, "Saved chains could not be read"), el("p", {}, state.storageError)),
      );
    }
    if (state.mskills === false) {
      banner.append(
        el(
          "section",
          { class: "banner", "aria-labelledby": "mskills-h" },
          el("h2", { id: "mskills-h" }, "m-skills is not installed"),
          el("p", {}, "Coordiner is built around m-skills, and the shipped templates use its skills. Chains of your own skills work without it."),
          el("button", { type: "button", "data-focus": "install-mskills", onclick: () => vscode.postMessage({ type: "openMskills" }) }, "Install m-skills (opens its page)"),
        ),
      );
    }
  }

  function railItem(chain) {
    return el(
      "li",
      {},
      el(
        "button",
        { type: "button", "aria-pressed": String(chain.id === selected()?.id), "data-focus": `rail-${chain.id}`, onclick: () => select(chain.id) },
        el("span", {}, chain.name),
        // The separator keeps the spoken name "Story, m-skills" instead of "Storym-skills".
        chain.builtIn && chainsModule.usesMskills(chain) ? [el("span", { class: "visually-hidden" }, ", "), el("span", { class: "badge" }, "m-skills")] : undefined,
      ),
    );
  }

  function renderRail() {
    rail.replaceChildren(
      el("h2", {}, "Templates"),
      el("ul", {}, state.templates.map(railItem)),
      el("h2", {}, "My chains"),
      state.chains.length > 0 ? el("ul", {}, state.chains.map(railItem)) : el("p", { class: "note" }, "No chains yet. Duplicate a template to start."),
      el(
        "button",
        { type: "button", "data-focus": "new-chain", onclick: () => {
          const chain = { id: newId(), name: "New chain", sessions: [{ cards: [] }] };
          selectedId = chain.id;
          remember({ selectedId });
          save(chain, "Created New chain", "chain-title");
        } },
        "New empty chain",
      ),
    );
  }

  function card(chain, s, i, c, editable) {
    const missing = logic.isMissing(c, state);
    const running = logic.runningCard(chain, s, state.runningAt) === i;
    const label = c.label;
    const children = [el("span", { class: "card-label" }, label), el("code", { class: "skill" }, c.skill)];
    if (running) children.push(el("span", { class: "flag running" }, "Running"));
    if (editable) {
      const id = `args-${s}-${i}`;
      children.push(
        el("label", { for: id, class: "visually-hidden" }, `Arguments for ${label}`),
        el("textarea", { id, rows: 2, "data-focus": id, onchange: (e) => save(edit.setArgs(chain, s, i, e.target.value), `Saved ${label}`, id) }, c.args),
      );
    } else if (c.args) {
      children.push(el("p", { class: "args" }, logic.argParts(c.args).map((part) => ("chip" in part ? el("span", { class: "chip" }, part.chip) : part.text))));
    }
    if (c.pause) children.push(el("span", { class: "flag" }, "Pauses for you"));
    if (missing) children.push(el("span", { class: "flag" }, "Not available in this workspace"));
    if (editable) {
      const cards = chain.sessions[s].cards;
      const move = (delta) => {
        const focus = logic.afterMove(s, i, delta, cards.length);
        if (focus) save(edit.moveCard(chain, s, i, delta), `Moved ${label} to position ${i + delta + 1}`, focus);
      };
      children.push(
        el(
          "div",
          { class: "card-actions" },
          el("button", { type: "button", "aria-label": `Move ${label} left`, "data-focus": logic.moveKey(s, i, -1), onclick: () => move(-1) }, "←"),
          el("button", { type: "button", "aria-label": `Move ${label} right`, "data-focus": logic.moveKey(s, i, 1), onclick: () => move(1) }, "→"),
          el(
            "button",
            { type: "button", "data-focus": logic.removeKey(s, i), "aria-label": `Remove ${label}`, onclick: () => save(edit.removeCard(chain, s, i), `Removed ${label}`, logic.afterRemove(s, i, cards.length)) },
            "Remove",
          ),
        ),
      );
      return el(
        "li",
        { class: "card", "aria-current": running ? "step" : undefined, onkeydown: (e) => {
          const delta = logic.moveDelta(e);
          if (delta === undefined) return;
          e.preventDefault();
          move(delta);
        } },
        children,
      );
    }
    return el("li", { class: "card", "aria-current": running ? "step" : undefined }, children);
  }

  function addSkill(chain, s) {
    const id = `palette-${s}`;
    if (!state.palette) {
      return el(
        "div",
        { class: "add-skill" },
        el("p", { class: "note" }, state.paletteError ? `Skills could not be listed: ${state.paletteError}` : "Listing the skills this workspace offers…"),
        state.paletteError ? el("button", { type: "button", "data-focus": `try-again-${s}`, onclick: () => vscode.postMessage({ type: "refreshPalette" }) }, "Try again") : undefined,
        state.paletteError ? el("button", { type: "button", "data-focus": `check-environment-${s}`, onclick: () => vscode.postMessage({ type: "checkEnvironment" }) }, "Check Environment") : undefined,
      );
    }
    const options = state.palette.map((p) => el("option", { value: p.skill }, p.mskills ? `${p.label} (${p.skill})` : p.skill));
    return el(
      "div",
      { class: "add-skill" },
      el("label", { for: id }, `Add a skill to session ${s + 1}`),
      el("select", { id }, options),
      el(
        "button",
        { type: "button", "data-focus": logic.addKey(s), onclick: () => {
          const skill = document.getElementById(id).value;
          if (!skill) return;
          const next = edit.addCard(chain, s, skill);
          save(next, `Added ${next.sessions[s].cards.at(-1).label}`, logic.removeKey(s, next.sessions[s].cards.length - 1));
        } },
        "Add",
      ),
    );
  }

  function renderDetail() {
    const chain = selected();
    shown = chain;
    if (!chain) return detail.replaceChildren();
    const editable = !chain.builtIn;
    const reason = logic.runReason(chain, state);
    const parts = [el("h2", { tabindex: "-1", "data-focus": "chain-title" }, chain.name)];

    const toolbar = [];
    if (editable) {
      toolbar.push(
        el("label", { for: "chain-name" }, "Name"),
        el("input", { id: "chain-name", "data-focus": "chain-name", value: chain.name, maxlength: 100, onchange: (e) => e.target.value.trim() && save(edit.rename(chain, e.target.value.trim()), "Renamed", "chain-title") }),
        el("button", { type: "button", "data-focus": "duplicate", onclick: () => copyOf(chain) }, "Duplicate"),
        el("button", { type: "button", "data-focus": "delete-chain", onclick: () => vscode.postMessage({ type: "delete", id: chain.id }) }, "Delete chain"),
      );
    } else {
      parts.push(el("p", { class: "note" }, "Built-in template, read-only."));
      toolbar.push(el("button", { type: "button", "data-focus": "duplicate", onclick: () => copyOf(chain) }, "Duplicate to edit"));
    }
    toolbar.push(
      el("button", { type: "button", "data-focus": "refresh-skills", onclick: () => vscode.postMessage({ type: "refreshPalette" }) }, "Refresh skills"),
      el(
        "button",
        { type: "button", class: "run", "data-focus": "run", "aria-disabled": String(reason !== undefined), "aria-describedby": reason ? "run-reason" : undefined, onclick: () => {
          if (reason) return announce(reason);
          vscode.postMessage({ type: "run", id: chain.id });
        } },
        `Run ${chain.name}`,
      ),
    );
    parts.push(el("div", { class: "toolbar" }, toolbar));
    if (reason) parts.push(el("p", { id: "run-reason", class: "reason" }, reason));
    parts.push(el("p", { class: "starts" }, logic.startsFrom(chain)));
    if (editable) {
      parts.push(el("p", { class: "note" }, logic.PLACEHOLDER_NOTE));
    }

    chain.sessions.forEach((session, s) => {
      if (s > 0) parts.push(el("div", { class: "handover", role: "separator", "aria-label": `Fresh context: session ${s + 1} starts a new conversation` }, "fresh context"));
      const heading = `session-h-${s}`;
      parts.push(
        el(
          "section",
          { "aria-labelledby": heading },
          el("h3", { id: heading }, `Session ${s + 1}`),
          session.cards.length > 0 ? el("ol", { class: "lane" }, session.cards.map((c, i) => card(chain, s, i, c, editable))) : el("p", { class: "note" }, "No skills in this session yet."),
          editable ? addSkill(chain, s) : undefined,
          editable && chain.sessions.length > 1
            ? el("button", { type: "button", "data-focus": `remove-session-${s}`, onclick: () => save(edit.removeSession(chain, s), `Removed session ${s + 1}`, "add-session") }, `Remove session ${s + 1}`)
            : undefined,
        ),
      );
    });
    if (editable) parts.push(el("p", {}, el("button", { type: "button", "data-focus": "add-session", onclick: () => save(edit.addSession(chain), `Added session ${chain.sessions.length + 1}`, logic.addKey(chain.sessions.length)) }, "Add a session")));
    detail.replaceChildren(...parts);
  }

  function render() {
    deferred = false;
    renderBanner();
    renderRail();
    renderDetail();
    if (pendingFocus) {
      [...document.querySelectorAll("[data-focus]")].find((node) => node.dataset.focus === pendingFocus)?.focus();
      pendingFocus = undefined;
    }
  }

  function applyState() {
    if (!allChains().some((c) => c.id === selectedId)) {
      // The chain on screen was deleted: land on the heading of the one shown in its place, and say what happened.
      if (shown?.id === selectedId) {
        pendingFocus = "chain-title";
        announce(`Deleted ${shown.name}`);
      }
      selectedId = "story";
    }
    pendingFocus = pendingFocus ?? document.activeElement?.dataset?.focus;
    render();
  }

  // Re-rendering replaces every field, so a state that arrives mid-typing waits: the field's change renders it with the edit, or,
  // if the typing was undone, it renders once focus has left the field.
  const typing = () => {
    const field = document.activeElement;
    // The chat's own fields are never replaced by a chains state, so typing there holds nothing back.
    return field.matches("textarea, input") && !chatRoot.contains(field) && field.value !== field.defaultValue;
  };

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "state") return;
    state = event.data;
    if (typing()) deferred = true;
    else applyState();
  });

  document.addEventListener("focusout", () => {
    if (deferred) setTimeout(applyState);
  });

  vscode.postMessage({ type: "ready" });
}

await start();
