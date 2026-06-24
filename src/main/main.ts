/**
 * Electron main process. Wires the core engine/controller to the renderer over IPC,
 * runs the pipeline on an interval, and fires desktop notifications (distinct sounds)
 * when a session newly becomes actionable.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import { execFile } from "child_process";
import { openDb } from "../core/db";
import { loadConfig, loadKeymap } from "../core/config";
import { SessionManager } from "../core/sessions";
import { Engine } from "../core/engine";
import { Controller } from "../core/controller";
import { notifyReady } from "./notify";

// Some environments (containers, NFS-mounted node_modules) can't use the SUID
// sandbox. Disable it before app is ready so the cockpit still launches.
app.commandLine.appendSwitch("no-sandbox");

let win: BrowserWindow | null = null;
let lastSurfaced = new Set<number>(); // item ids already announced

// DESKTOP (macOS) MODE: when COCKPIT_UI_URL is set, the window loads the local web UI from the
// running server instead of the file:// renderer. On macOS the file:// renderer can't open the
// terminal WebSocket (empty location.host) and the in-app ssh/emulator terminal path is Linux-only,
// so we point Electron at http://localhost:4317 — the exact UI we verified works — and let the
// server be the single brain (no in-app engine/IPC). Unset → original behaviour, unchanged.
const UI_URL = process.env.COCKPIT_UI_URL || "";

function buildStack() {
  const db = openDb();
  const cfg = loadConfig();
  const sm = new SessionManager(db);
  // Enrichment (Claude one-liners/summaries/suggested answers) is on by default.
  // Set COCKPIT_NO_ENRICH=1 to run fully offline with deterministic fallbacks.
  const engine = new Engine(db, sm, cfg, { enrich: !process.env.COCKPIT_NO_ENRICH });
  const ctrl = new Controller(db, engine, sm, cfg);
  return { db, sm, engine, ctrl };
}

const stack = buildStack();

async function tickAndNotify() {
  try {
    await stack.engine.tick();
  } catch (e) {
    console.error("tick error:", e);
  }
  const q = stack.engine.queue();
  for (const it of q) {
    if (lastSurfaced.has(it.id)) continue;
    lastSurfaced.add(it.id);
    if (it.state === "WAITING_INPUT")
      notifyReady("needs_input", `Needs input · ${it.session.title}`, it.one_liner || "");
    else if (it.state === "DONE") notifyReady("done", `Done · ${it.session.title}`, it.one_liner || "");
  }
  // forget items no longer pending so re-surfacing re-notifies
  const live = new Set(q.map((i) => i.id));
  lastSurfaced = new Set([...lastSurfaced].filter((id) => live.has(id)));
  win?.webContents.send("update");
}

function registerIpc() {
  ipcMain.handle("state", () => stack.ctrl.state());
  ipcMain.handle("tick", () => tickAndNotify());
  ipcMain.handle("sendAnswer", (_e, id: number, a?: string) => stack.ctrl.sendAnswer(id, a));
  ipcMain.handle("ack", (_e, id: number) => stack.ctrl.ack(id));
  ipcMain.handle("snooze", (_e, id: number, m?: number) => stack.ctrl.snooze(id, m));
  ipcMain.handle("feedback", (_e, id: number, fb: string) => stack.ctrl.feedback(id, fb as any));
  ipcMain.handle("rawTranscript", (_e, id: number) => stack.ctrl.rawTranscript(id));
  ipcMain.handle("prettyTranscript", (_e, id: number) => stack.ctrl.prettyTranscript(id));
  ipcMain.handle("attachCommand", (_e, id: number) => stack.ctrl.attachCommand(id));
  ipcMain.handle("pane", (_e, id: number, lines?: number) => stack.ctrl.pane(id, lines));
  ipcMain.handle("sendPaneKey", (_e, id: number, key: string, named?: boolean) => stack.ctrl.key(id, key, !!named));
  ipcMain.handle("setPinned", (_e, id: number, pinned: boolean) => stack.ctrl.setPinned(id, pinned));
  ipcMain.handle("setManualImportance", (_e, id: number, value: number | null) => stack.ctrl.setManualImportance(id, value));
  ipcMain.handle("renameSession", (_e, id: number, title: string) => stack.ctrl.renameSession(id, title));
  ipcMain.handle("prDiff", (_e, id: number) => stack.ctrl.prDiff(id));
  ipcMain.handle("launchSession", (_e, repo: string, title: string, prompt: string) => stack.ctrl.launchSession(repo, title, prompt));
  ipcMain.handle("newSession", (_e, kind: string, prompt?: string, importance?: number | null) => stack.ctrl.newSession(kind as any, prompt, importance ?? null));
  ipcMain.handle("complete", (_e, sessionId: number) => stack.ctrl.completeTask(sessionId));
  ipcMain.handle("activate", (_e, sessionId: number) => stack.ctrl.activateSession(sessionId));
  ipcMain.handle("reasonFeedback", (_e, itemId: number, direction: any, reason: string) => stack.ctrl.reasonFeedback(itemId, direction, reason));
  ipcMain.handle("resurfaceAll", () => stack.ctrl.resurfaceAll());
  ipcMain.handle("sessionPr", (_e, id: number) => stack.ctrl.refreshSessionPr(id));
  ipcMain.handle("mergePr", (_e, id: number, deleteBranch?: boolean) => stack.ctrl.mergeSessionPr(id, deleteBranch === true));
  ipcMain.handle("diag", (_e, payload: any) => { try { console.log(`[term-diag ${payload?.phase}] sess#${payload?.sessionId} host ${payload?.host_w}×${payload?.host_h} term ${payload?.term_cols}×${payload?.term_rows}`); } catch {} return { ok: true }; });
  ipcMain.handle("takeOverable", () => stack.ctrl.takeOverableAgents());
  ipcMain.handle("takeOver", (_e, sessionId: number) => stack.ctrl.takeOverAgent(sessionId));
  ipcMain.handle("takeOverAll", async () => ({ ok: true, agents: await stack.ctrl.takeOverableAgents() }));
  ipcMain.handle("worktreeDiff", (_e, id: number) => stack.ctrl.worktreeDiff(id));
  ipcMain.handle("prReviews", (_e, id: number) => stack.ctrl.prReviews(id));
  ipcMain.handle("diffViewed", (_e, id: number) => stack.ctrl.diffViewed(id));
  ipcMain.handle("setDiffViewed", (_e, id: number, fp: string, v: boolean) => stack.ctrl.setDiffViewed(id, fp, v));
  ipcMain.handle("prStatus", (_e, id: number) => stack.ctrl.prStatus(id));
  ipcMain.handle("prMerge", (_e, id: number, method?: any, deleteBranch?: boolean) => stack.ctrl.prMerge(id, method, deleteBranch === true));
  ipcMain.handle("kanbanStart", (_e, id: number) => stack.ctrl.kanbanStart(id));
  ipcMain.handle("kanbanAnswer", (_e, id: number, answers: string[]) => stack.ctrl.kanbanAnswer(id, answers));
  ipcMain.handle("kanbanAppend", (_e, id: number) => stack.ctrl.kanbanAppend(id));
  ipcMain.handle("undo", () => stack.ctrl.undo());
  ipcMain.handle("setFocus", (_e, f: string) => stack.ctrl.setFocus(f));
  ipcMain.handle("keymap", () => loadKeymap());
  ipcMain.handle("reloadConfig", () => stack.ctrl.reloadConfig());
  ipcMain.handle("openTerminal", (_e, id: number) => {
    const cmd = stack.ctrl.attachCommand(id);
    // open a terminal attached to the session's tmux; try common emulators.
    const emulators: [string, string[]][] = [
      ["x-terminal-emulator", ["-e", "bash", "-lc", cmd]],
      ["gnome-terminal", ["--", "bash", "-lc", cmd]],
      ["xterm", ["-e", `bash -lc '${cmd}'`]],
    ];
    const tryEmu = (i: number) => {
      if (i >= emulators.length) return;
      execFile(emulators[i][0], emulators[i][1], (err) => err && tryEmu(i + 1));
    };
    tryEmu(0);
    return cmd;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: "ClaudeOS",
    backgroundColor: "#0b0d12",
    // URL mode talks to the server over HTTP/WS (no preload bridge); file:// mode uses IPC.
    webPreferences: UI_URL ? {} : { preload: path.join(__dirname, "preload.js") },
  });
  win.webContents.on("console-message", (_e, _lvl, msg) => console.log("[renderer]", msg));
  win.webContents.on("preload-error", (_e, p, err) => console.error("[preload-error]", p, err));
  // FIX CC: never let Ctrl+/- zoom the whole Electron page — the renderer handles +/- itself
  // (context-aware: terminal font vs UI text scale). Pin the page zoom.
  try { win.webContents.setVisualZoomLevelLimits(1, 1); } catch {}
  try { win.webContents.on("did-finish-load", () => { try { win!.webContents.setZoomFactor(1); } catch {} }); } catch {}
  if (UI_URL) win.loadURL(UI_URL);
  else win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  if (!UI_URL) registerIpc();          // URL/desktop mode: the server is the brain — no in-app engine
  createWindow();
  if (!UI_URL) { tickAndNotify(); setInterval(tickAndNotify, 5000); }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
