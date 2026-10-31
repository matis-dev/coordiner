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
  // Where the run was when its card was last scrolled into view; a re-render on the same card leaves the scroll alone.
  let scrolledTo;
  // The line under the toolbar saying what the last edit did, with Undo after a remove: { chainId, text, undo? }. Any other edit
  // or picking a chain clears it; a state from the extension keeps it.
  let notice;
  // The skill picked in each session's palette, by chain and session: a re-render (a run moving on, say) keeps it.
  const picks = new Map();
  // The card being dragged, { chainId, from, label }: set only by a drag this page started, so a file or text dragged in from
  // outside is never dropped. The node showing where it would land carries a drop-* class.
  let dragging;
  let marked;

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

  const chat = startChat({ vscode, root: chatRoot, logic: chatLogic, maxChars: chainsModule.MAX_INPUT_CHARS, announce, remember });

  const allChains = () => [...state.templates, ...state.chains];
  const selected = () => allChains().find((c) => c.id === selectedId) ?? state.templates[0];
  const newId = () => logic.newChainId(Date.now());

  function select(id) {
    chat.showChains();
    notice = undefined;
    selectedId = id;
    remember({ selectedId });
    pendingFocus = "chain-title";
    render();
  }

  // Optimistic: the edit shows at once, the extension saves it and sends the state back. `leaves` is the notice the edit leaves.
  function save(chain, message, focus, leaves) {
    notice = leaves;
    state = { ...state, chains: state.chains.some((c) => c.id === chain.id) ? state.chains.map((c) => (c.id === chain.id ? chain : c)) : [...state.chains, chain] };
    pendingFocus = focus;
    vscode.postMessage({ type: "save", chain });
    render();
    if (message) announce(message);
  }

  // A setting changed on a template goes to a copy of it, which takes the template's place on screen. The copy's cards have the
  // same focus keys, so focus stays on the control that was changed.
  function saveSetting(chain, change, label, focus) {
    const next = logic.copyThenEdit(chain, change, (from) => edit.duplicate(from, newId(), logic.copyName(from.name)));
    if (next.id === chain.id) return save(next, `Saved ${label}`, focus);
    selectedId = next.id;
    remember({ selectedId });
    save(next, `Copied ${chain.name} to ${next.name} to save this change`, focus, { chainId: next.id, text: `Saved as ${next.name}. Templates don't change.` });
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
        el("section", { class: "banner error", "aria-labelledby": "storage-h" }, el("h2", { id: "storage-h" }, "A problem with your saved chains"), el("p", {}, state.storageError)),
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
        // Only while m-skills is missing does the badge tell one chain from another: it marks the ones that will not run. The separator
        // keeps the spoken name "Story, needs m-skills" instead of "Storyneeds m-skills".
        state.mskills === false && chainsModule.usesMskills(chain) ? [el("span", { class: "visually-hidden" }, ", "), el("span", { class: "badge" }, "needs m-skills")] : undefined,
      ),
    );
  }

  function renderRail() {
    rail.replaceChildren(
      el("h2", {}, "Templates"),
      el("ul", {}, state.templates.filter((t) => !chainsModule.singleSkill(t)).map(railItem)),
      el("h2", {}, "Single skills"),
      el("ul", {}, state.templates.filter(chainsModule.singleSkill).map(railItem)),
      el("h2", {}, "My chains"),
      state.chains.length > 0 ? el("ul", {}, state.chains.map(railItem)) : el("p", { class: "note" }, "No chains yet. Duplicate a template to start."),
      el(
        "button",
        { type: "button", "data-focus": "new-chain", onclick: () => {
          const chain = { id: newId(), name: "New chain", sessions: [{ cards: [] }] };
          chat.showChains();
          selectedId = chain.id;
          remember({ selectedId });
          save(chain, "Created New chain", "chain-title");
        } },
        "New empty chain",
      ),
      // The skill list is the window's, not a chain's, so it is refreshed from here.
      el("button", { type: "button", class: "refresh", "data-focus": "refresh-skills", onclick: () => vscode.postMessage({ type: "refreshPalette" }) }, "Refresh skills"),
    );
  }

  function card(chain, s, i, c, editable) {
    const missing = logic.isMissing(c, state);
    const running = logic.runningCard(chain, s, state.runningAt) === i;
    const label = c.label;
    const locked = editable ? logic.lockReason(chain, s, state) : undefined;
    // The label, with its station number, is the handle: the card's fields keep their own pointer behaviour.
    const handle = el("span", { class: "card-label", draggable: editable && !locked ? "true" : undefined, ondragstart: (e) => {
      dragging = { chainId: chain.id, from: { s, i }, label };
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      e.currentTarget.closest(".card").classList.add("dragging");
    } }, label);
    const children = [handle, el("code", { class: "skill" }, c.skill)];
    if (running) children.push(el("span", { class: "flag running" }, state.runningAt.waiting ? "Waiting for you" : "Running"));
    if (editable) {
      const id = `args-${s}-${i}`;
      children.push(
        el("label", { for: id, class: "visually-hidden" }, `Arguments for ${label}`),
        el("textarea", { id, rows: 2, maxlength: chainsModule.MAX_ARGS, "data-focus": id, onchange: (e) => save(edit.setArgs(chain, s, i, e.target.value), `Saved ${label}`, id) }, c.args),
      );
      const stray = logic.strayNote(c.args);
      if (stray) children.push(el("p", { class: "note" }, stray));
    } else if (c.args) {
      children.push(el("p", { class: "args" }, logic.argParts(c.args).map((part) => ("chip" in part ? el("span", { class: "chip" }, part.chip) : part.text))));
    }
    children.push(settings(chain, s, i, c));
    if (missing) children.push(el("span", { class: "flag" }, "Not available in this workspace"));
    if (!logic.modelOffered(c, state)) children.push(el("span", { class: "flag" }, "Model not offered by this session"));
    if (editable) {
      const cards = chain.sessions[s].cards;
      const from = { s, i };
      // Why an arrow cannot move the card that way: its session has started, or the move is refused. Past either end of the chain
      // it just does nothing.
      const blocked = (delta) => {
        const to = logic.moveTarget(chain, s, i, delta);
        return locked ?? (to && logic.moveReason(chain, from, to, state));
      };
      const move = (delta) => {
        const why = blocked(delta);
        if (why) return announce(why);
        const to = logic.moveTarget(chain, s, i, delta);
        if (!to) return;
        save(edit.moveTo(chain, from, to), logic.movedNote(label, from, to), logic.moveKey(to.s, to.i, delta));
      };
      const arrow = (delta, name, glyph) => {
        const why = blocked(delta);
        return el(
          "button",
          { type: "button", "aria-label": `Move ${label} ${name}`, "data-focus": logic.moveKey(s, i, delta), "aria-disabled": String(why !== undefined), "aria-describedby": locked ? `locked-${s}` : undefined, title: why, onclick: () => move(delta) },
          glyph,
        );
      };
      children.push(
        el(
          "div",
          { class: "card-actions" },
          arrow(-1, "left", "←"),
          arrow(1, "right", "→"),
          el(
            "button",
            { type: "button", "data-focus": logic.removeKey(s, i), "aria-label": `Remove ${label}`, "aria-disabled": String(locked !== undefined), "aria-describedby": locked ? `locked-${s}` : undefined, title: locked, onclick: () => {
              if (locked) return announce(locked);
              save(edit.removeCard(chain, s, i), `Removed ${label}`, logic.afterRemove(s, i, cards.length), {
                chainId: chain.id,
                text: `Removed ${label}`,
                undo: { chain, name: `Undo remove ${label}`, said: `Restored ${label}`, focus: logic.removeKey(s, i) },
              });
            } },
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
        }, ondragover: (e) => dragOver(e, chain, s, i), ondrop: (e) => drop(e, chain, s, i) },
        children,
      );
    }
    return el("li", { class: "card", "aria-current": running ? "step" : undefined }, children);
  }

  // A drop target takes only this page's own drag, of a card of the chain on screen. A drop on a card puts the dragged card before
  // it; a drop on the session elsewhere puts it at the end. Where the move is refused, nothing is marked and the drop says why.
  function dragOver(e, chain, s, before) {
    if (dragging?.chainId !== chain.id) return;
    e.preventDefault();
    e.stopPropagation();
    const to = logic.dropTarget(chain, dragging.from, s, before);
    unmark();
    if (logic.moveReason(chain, dragging.from, to, state)) return;
    marked = e.currentTarget;
    marked.classList.add(before === undefined ? "drop-end" : "drop-before");
  }

  function drop(e, chain, s, before) {
    if (dragging?.chainId !== chain.id) return;
    e.preventDefault();
    e.stopPropagation();
    const { from, label } = dragging;
    endDrag();
    const to = logic.dropTarget(chain, from, s, before);
    const why = logic.moveReason(chain, from, to, state);
    if (why) announce(why);
    else if (to.s !== from.s || to.i !== from.i) save(edit.moveTo(chain, from, to), logic.movedNote(label, from, to), logic.moveKey(to.s, to.i, 1));
    // A state held back for the drag renders now, unless the save just did.
    if (deferred) applyState();
  }

  function unmark() {
    marked?.classList.remove("drop-before", "drop-end");
    marked = undefined;
  }

  function endDrag() {
    dragging = undefined;
    unmark();
    detail.querySelector(".card.dragging")?.classList.remove("dragging");
  }

  // Model, effort and pause, each a native control whose label names the card, on every card: on a template, a change makes a copy.
  // A stored value the session does not offer stays selected, marked, so the card shows what Run would refuse rather than quietly
  // changing it.
  function settings(chain, s, i, c) {
    const label = c.label;
    const modelId = logic.modelKey(s, i);
    const effortId = logic.effortKey(s, i);
    const pauseId = logic.pauseKey(s, i);
    const models = state.models ?? [];
    const efforts = logic.effortChoices(c, state);
    // Until the session lists its models, a pinned one is shown as stored: only a listed session can say it does not offer it.
    const unlisted = c.model !== undefined && !models.some((m) => m.id === c.model);
    const why = logic.effortReason(c, state);
    const note = logic.pinNote(c);
    const named = (text) => [text, el("span", { class: "visually-hidden" }, ` for ${label}`)];
    return el(
      "div",
      { class: "card-settings" },
      el("label", { for: modelId }, named("Model")),
      el(
        "select",
        { id: modelId, "data-focus": modelId, onchange: (e) => {
          const model = e.target.value || undefined;
          saveSetting(chain, (to) => edit.setModel(to, s, i, model, logic.effortAfterModel(c, model, state)), label, modelId);
        } },
        el("option", { value: "" }, "By tier"),
        models.map((m) => el("option", { value: m.id, selected: m.id === c.model }, m.label)),
        unlisted ? el("option", { value: c.model, selected: true }, logic.modelOffered(c, state) ? c.model : `${c.model} (not offered by this session)`) : undefined,
      ),
      el("label", { for: effortId }, named("Effort")),
      el(
        "select",
        // Off only when there is nothing to pick; an effort the model no longer takes can still be set back to the default.
        { id: effortId, "data-focus": effortId, "aria-disabled": String(why !== undefined && c.effort === undefined), "aria-describedby": why ? `effort-why-${s}-${i}` : undefined, title: why, onchange: (e) => {
          saveSetting(chain, (to) => edit.setEffort(to, s, i, e.target.value || undefined), label, effortId);
        } },
        el("option", { value: "" }, "Model default"),
        efforts.map((effort) => el("option", { value: effort, selected: effort === c.effort }, effort)),
        c.effort !== undefined && !efforts.includes(c.effort) ? el("option", { value: c.effort, selected: true }, `${c.effort} (not offered)`) : undefined,
      ),
      why ? el("p", { id: `effort-why-${s}-${i}`, class: "reason" }, why) : undefined,
      note ? el("p", { class: "note" }, note) : undefined,
      el(
        "label",
        { class: "pause" },
        el("input", { type: "checkbox", id: pauseId, "data-focus": pauseId, checked: c.pause, onchange: (e) => saveSetting(chain, (to) => edit.setPause(to, s, i, e.target.checked), label, pauseId) }),
        " Pause for me",
        el("span", { class: "visually-hidden" }, ` after ${label}`),
      ),
    );
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
    const key = `${chain.id}:${s}`;
    const full = logic.addCardReason(chain, s);
    const options = state.palette.map((p) => el("option", { value: p.skill, selected: p.skill === picks.get(key) }, p.mskills ? `${p.label} (${p.skill})` : p.skill));
    return el(
      "div",
      { class: "add-skill" },
      el("label", { for: id }, `Add a skill to session ${s + 1}`),
      el("select", { id, "data-focus": id, onchange: (e) => picks.set(key, e.target.value) }, options),
      el(
        "button",
        { type: "button", class: "outline", "data-focus": logic.addKey(s), "aria-disabled": String(full !== undefined), "aria-describedby": full ? `full-${s}` : undefined, title: full, onclick: () => {
          if (full) return announce(full);
          const skill = document.getElementById(id).value;
          if (!skill) return;
          const next = edit.addCard(chain, s, skill);
          save(next, `Added ${next.sessions[s].cards.at(-1).label}`, logic.removeKey(s, next.sessions[s].cards.length - 1));
        } },
        "Add",
      ),
      full ? el("p", { id: `full-${s}`, class: "reason" }, full) : undefined,
    );
  }

  function renderDetail() {
    const chain = selected();
    shown = chain;
    if (!chain) return detail.replaceChildren();
    const editable = !chain.builtIn;
    const reason = logic.runReason(chain, state);
    const parts = [el("h2", { tabindex: "-1", "data-focus": "chain-title" }, chain.name)];

    if (editable) {
      parts.push(
        el(
          "div",
          { class: "name-row" },
          el("label", { for: "chain-name" }, "Name"),
          el("input", { id: "chain-name", "data-focus": "chain-name", value: chain.name, maxlength: chainsModule.MAX_NAME, onchange: (e) => e.target.value.trim() && save(edit.rename(chain, e.target.value.trim()), "Renamed", "chain-title") }),
        ),
      );
    } else {
      parts.push(el("p", { class: "note" }, "Built-in template. Changing a card's model, effort or pause saves your own copy; duplicate it to edit the rest."));
    }
    // Run first, the one destructive action last and set apart; the order on screen is the order in the DOM.
    const toolbar = [
      el(
        "button",
        { type: "button", class: "run", "data-focus": "run", "aria-disabled": String(reason !== undefined), "aria-describedby": reason ? "run-reason" : undefined, title: reason, onclick: () => {
          if (reason) return announce(reason);
          vscode.postMessage({ type: "run", id: chain.id });
        } },
        `Run ${chain.name}`,
      ),
      el("button", { type: "button", class: "accent", "data-focus": "duplicate", onclick: () => copyOf(chain) }, editable ? "Duplicate" : "Duplicate to edit"),
      editable ? el("button", { type: "button", class: "end danger", "data-focus": "delete-chain", onclick: () => vscode.postMessage({ type: "delete", id: chain.id }) }, "Delete chain") : undefined,
    ];
    parts.push(el("div", { class: "toolbar" }, toolbar));
    // Not a live region: the status region already said it once.
    if (notice?.chainId === chain.id) {
      const { undo } = notice;
      parts.push(
        el(
          "p",
          { class: "notice" },
          el("span", {}, notice.text),
          undo ? el("button", { type: "button", "aria-label": undo.name, "data-focus": "undo", onclick: () => save(undo.chain, undo.said, undo.focus) }, "Undo") : undefined,
        ),
      );
    }
    if (reason) parts.push(el("p", { id: "run-reason", class: "reason" }, reason));
    parts.push(el("p", { class: "starts" }, logic.startsFrom(chain)));
    if (editable) {
      parts.push(el("p", { class: "note" }, logic.PLACEHOLDER_NOTE));
      if (state.modelsError) parts.push(el("p", { class: "note" }, `Cards on By tier run on their tier's model, and a pinned card keeps its model, checked when its session starts. Models could not be listed: ${state.modelsError}`));
    }

    chain.sessions.forEach((session, s) => {
      if (s > 0) parts.push(el("div", { class: "handover", role: "separator", "aria-label": `Fresh context: session ${s + 1} starts a new conversation` }, "fresh context"));
      const heading = `session-h-${s}`;
      const locked = editable ? logic.lockReason(chain, s, state) : undefined;
      parts.push(
        el(
          "section",
          { "aria-labelledby": heading, ondragover: editable ? (e) => dragOver(e, chain, s) : undefined, ondrop: editable ? (e) => drop(e, chain, s) : undefined },
          el("h3", { id: heading }, `Session ${s + 1}`),
          locked ? el("p", { id: `locked-${s}`, class: "reason" }, locked) : undefined,
          session.cards.length > 0 ? el("ol", { class: "lane" }, session.cards.map((c, i) => card(chain, s, i, c, editable))) : el("p", { class: "note" }, "No skills in this session yet."),
          // Add a skill on the left, Remove session at the right end of the same line; they wrap under each other when narrow.
          editable
            ? el(
                "div",
                { class: "session-foot" },
                addSkill(chain, s),
                chain.sessions.length > 1
                  ? el("button", { type: "button", class: "danger", "data-focus": `remove-session-${s}`, "aria-disabled": String(locked !== undefined), "aria-describedby": locked ? `locked-${s}` : undefined, title: locked, onclick: () => {
                if (locked) return announce(locked);
                save(edit.removeSession(chain, s), `Removed session ${s + 1}`, "add-session", {
                  chainId: chain.id,
                  text: `Removed session ${s + 1}`,
                  undo: { chain, name: `Undo remove session ${s + 1}`, said: `Restored session ${s + 1}`, focus: `remove-session-${s}` },
                });
              } }, `Remove session ${s + 1}`)
                  : undefined,
              )
            : undefined,
        ),
      );
    });
    if (editable) {
      const full = logic.addSessionReason(chain);
      // replaceChildren writes an undefined part out as the text "undefined", so only elements go into parts.
      parts.push(
        el("hr", { class: "end-rule" }),
        el(
          "p",
          {},
          el(
            "button",
            { type: "button", class: "add-session", "data-focus": "add-session", "aria-disabled": String(full !== undefined), "aria-describedby": full ? "sessions-full" : undefined, title: full, onclick: () => {
              if (full) return announce(full);
              save(edit.addSession(chain), `Added session ${chain.sessions.length + 1}`, logic.addKey(chain.sessions.length));
            } },
            "Add a session",
          ),
        ),
      );
      if (full) parts.push(el("p", { id: "sessions-full", class: "reason" }, full));
    }
    detail.replaceChildren(...parts);
  }

  function render() {
    deferred = false;
    renderBanner();
    renderRail();
    renderDetail();
    // A card that starts running or waiting may be under the chat: scroll its lane just enough to show it. Focus stays put.
    const at = state.runningAt;
    const runKey = at && `${at.chainId}:${at.session}:${at.index}:${Boolean(at.waiting)}`;
    if (runKey !== scrolledTo) {
      scrolledTo = runKey;
      detail.querySelector('.card[aria-current="step"]')?.scrollIntoView({ block: "nearest" });
    }
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
    // A save the extension could not make arrives as a storage problem; the banner shows it, and it is said aloud. A problem that
    // reads the same as the last is said again when the count of unsaved changes rose, since the editor went back once more.
    const unsavedRose = (event.data.unsaved ?? 0) > (state.unsaved ?? 0);
    if (event.data.storageError && (event.data.storageError !== state.storageError || unsavedRose)) announce(event.data.storageError);
    state = event.data;
    // A re-render mid-drag would take away the card being dragged; the drop, or the drag's end, renders it.
    if (typing() || dragging) deferred = true;
    else applyState();
  });

  document.addEventListener("focusout", () => {
    if (deferred) setTimeout(applyState);
  });

  // A drag that ends without a drop here (Escape, or let go elsewhere). Listened for on the page, since the dragged card may be
  // gone from it by then.
  document.addEventListener("dragend", () => {
    if (!dragging) return;
    endDrag();
    if (deferred) applyState();
  });

  vscode.postMessage({ type: "ready" });
}

await start();
