/**
 * Browser shim: provides the same window.cockpit surface the Electron preload exposes,
 * but backed by fetch() against the cockpit web server. Loaded before renderer.js so the
 * renderer code is byte-for-byte identical between Electron and the browser.
 *
 * Also handles browser desktop notifications + distinct sounds for needs-input vs done
 * (the Electron build does this in the main process; in the browser we do it here on each
 * state poll). On localhost / via SSH tunnel this is a secure context, so Notification works.
 */
(function () {
  async function jget(url) {
    const r = await fetch(url);
    return r.json();
  }
  async function jpost(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  // ---- distinct sounds via WebAudio (no asset files needed) ----
  // The AudioContext is created LAZILY and resumed only on the first real user gesture —
  // browsers block audio before a gesture, and creating/starting one on every SSE/poll
  // floods the console with "AudioContext was not allowed to start". So: no context until
  // the operator interacts; beep() is a silent no-op until the context is actually running.
  let actx = null;
  function ensureAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx && actx.state === "suspended") actx.resume().catch(function () {});
    } catch (e) {}
  }
  // Arm audio on the first user gesture (one-time), then drop the listeners.
  function armAudioOnce() {
    ensureAudio();
    window.removeEventListener("pointerdown", armAudioOnce, true);
    window.removeEventListener("keydown", armAudioOnce, true);
  }
  window.addEventListener("pointerdown", armAudioOnce, true);
  window.addEventListener("keydown", armAudioOnce, true);

  function beep(kind) {
    try {
      // No console spam: if there's no RUNNING context (operator hasn't interacted yet),
      // stay silent — never attempt to start a blocked context.
      if (!actx || actx.state !== "running") return;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.connect(g);
      g.connect(actx.destination);
      // needs-input: rising two-tone; done: lower single tone
      if (kind === "needs_input") {
        o.frequency.setValueAtTime(660, actx.currentTime);
        o.frequency.setValueAtTime(880, actx.currentTime + 0.12);
      } else {
        o.frequency.setValueAtTime(440, actx.currentTime);
      }
      g.gain.setValueAtTime(0.001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, actx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.3);
      o.start();
      o.stop(actx.currentTime + 0.32);
    } catch (e) {}
  }

  function notify(kind, title, body) {
    try {
      if ("Notification" in window) {
        if (Notification.permission === "granted") new Notification(title, { body });
        else if (Notification.permission !== "denied") Notification.requestPermission();
      }
    } catch (e) {}
    beep(kind);
  }

  // track which ready items we've already announced. The FIRST poll just primes the set
  // (no burst of beeps for items that were already waiting when the page loaded) — only
  // genuinely NEW ready items after that trigger a notification.
  let announced = new Set();
  let primed = false;
  async function checkNotifications() {
    try {
      const st = await jget("/api/state");
      const live = new Set();
      for (const it of st.queue || []) {
        live.add(it.id);
        if (announced.has(it.id)) continue;
        announced.add(it.id);
        if (primed) {
          if (it.state === "WAITING_INPUT") notify("needs_input", "Needs input · " + it.session.title, it.one_liner || "");
          else if (it.state === "DONE") notify("done", "Done · " + it.session.title, it.one_liner || "");
        }
      }
      announced = new Set([...announced].filter((id) => live.has(id)));
      primed = true;
    } catch (e) {}
  }

  window.cockpit = {
    state: () => jget("/api/state"),
    keymap: () => jget("/api/keymap"),
    tick: () => jpost("/api/tick"),
    sendAnswer: (itemId, answer) => jpost("/api/sendAnswer", { itemId, answer }),
    ack: (itemId) => jpost("/api/ack", { itemId }),
    dismiss: (itemId) => jpost("/api/dismiss", { itemId }),
    snooze: (itemId, minutes) => jpost("/api/snooze", { itemId, minutes }),
    feedback: (itemId, fb) => jpost("/api/feedback", { itemId, fb }),
    rawTranscript: (itemId) => jget("/api/raw?itemId=" + itemId).then((r) => r.raw),
    prettyTranscript: (itemId) => jget("/api/pretty?itemId=" + itemId).then((r) => r.text),
    attachCommand: (sessionId) => jget("/api/attach?sessionId=" + sessionId).then((r) => r.command),
    openTerminal: (sessionId) => jget("/api/attach?sessionId=" + sessionId).then((r) => r.command),
    pane: (sessionId, lines) => jget("/api/pane?sessionId=" + sessionId + (lines ? "&lines=" + lines : "")),
    sendPaneKey: (sessionId, key, named) => jpost("/api/key", { sessionId, key, named: !!named }),
    setPinned: (sessionId, pinned) => jpost("/api/pin", { sessionId, pinned: !!pinned }),
    setManualImportance: (sessionId, value) => jpost("/api/manualImportance", { sessionId, value }),
    renameSession: (sessionId, title) => jpost("/api/renameSession", { sessionId, title }),
    prDiff: (sessionId) => jpost("/api/prDiff", { sessionId }),
    worktreeDiff: (sessionId) => jpost("/api/worktreeDiff", { sessionId }),
    diffExpand: (sessionId, path, ctx, oldPath) => jpost("/api/diffExpand", { sessionId, path, ctx, oldPath: oldPath || "" }),
    prReviews: (sessionId) => jpost("/api/prReviews", { sessionId }),
    prConversation: (sessionId, force) => jget("/api/prConversation/" + sessionId + (force ? "?force=1" : "")),
    diffViewed: (sessionId) => jpost("/api/diffViewed", { sessionId }).then((r) => r.viewed),
    setDiffViewed: (sessionId, filePath, viewed) => jpost("/api/setDiffViewed", { sessionId, filePath, viewed }),
    prStatus: (sessionId) => jpost("/api/prStatus", { sessionId }),
    prMerge: (sessionId, method, deleteBranch) => jpost("/api/prMerge", { sessionId, method, deleteBranch: !!deleteBranch }),
    launchSession: (repo, title, prompt) => jpost("/api/launchSession", { repo, title, prompt }),
    newSession: (kind, prompt, importance, repo) => jpost("/api/newSession", { kind, prompt, importance, repo: repo || null }),
    complete: (sessionId) => jpost("/api/complete", { sessionId }),
    activate: (sessionId) => jpost("/api/activate", { sessionId }),
    reasonFeedback: (itemId, direction, reason) => jpost("/api/reasonFeedback", { itemId, direction, reason }),
    resurfaceAll: () => jpost("/api/resurfaceAll", {}),
    reprioritize: () => jpost("/api/reprioritize", {}),
    sessionPr: (sessionId) => jget("/api/sessionPr/" + sessionId).then((r) => r.pr),
    mergePr: (sessionId, deleteBranch) => jpost("/api/mergePr", { sessionId, deleteBranch: !!deleteBranch }),
    diag: (payload) => jpost("/api/diag", payload),
    takeOverable: () => jget("/api/takeoverable").then((r) => r.agents),
    takeOver: (sessionId, confirmedBusy) => jpost("/api/takeover", { sessionId, confirmedBusy: !!confirmedBusy }),
    takeOverAll: (confirmedBusy) => jpost("/api/takeoverAll", { confirmedBusy: !!confirmedBusy }),
    kanbanStart: (sessionId) => jpost("/api/kanbanStart", { sessionId }),
    kanbanAnswer: (sessionId, answers) => jpost("/api/kanbanAnswer", { sessionId, answers }),
    kanbanAppend: (sessionId) => jpost("/api/kanbanAppend", { sessionId }),
    undo: () => jpost("/api/undo", {}),
    setFocus: (focus) => jpost("/api/focus", { focus }),
    accountsList: () => jget("/api/accounts"),
    accountSwitch: (label) => jpost("/api/account/switch", { label }),
    reloadConfig: () => Promise.resolve({ ok: true }),
    onUpdate: (cb) => {
      // ask for notification permission on first interaction
      try {
        if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
      } catch (e) {}
      const es = new EventSource("/api/events");
      es.addEventListener("update", () => {
        checkNotifications();
        cb();
      });
      es.onerror = () => {};
    },
  };
})();
