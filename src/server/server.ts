/**
 * Web server mode — for running the cockpit on a HEADLESS machine (e.g. the server, no
 * monitor) and driving it from a browser on another computer (your laptop), exactly like
 * the kanban web UI. The engine + all session observation run here on the headless
 * box; the browser is just the operator console.
 *
 * It serves the SAME renderer used by the Electron app, with a tiny fetch-based shim
 * (webapi.js) standing in for the Electron IPC bridge, so window.cockpit is identical.
 *
 *   node dist/server/server.js              # listens on 0.0.0.0:4317
 *   COCKPIT_PORT=4000 node dist/server/server.js
 *
 * From your laptop:  ssh -L 4317:localhost:4317 <host>   then open http://localhost:4317
 * (or just http://<host>:4317 if you can reach the box directly).
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer } from "ws";
import * as pty from "node-pty";
import { openDb, purgeDemoArtifacts, upsertDiscoveredSession } from "../core/db";
import { SessionSearchService } from "../core/sessionSearch";
import { loadConfig, loadKeymap } from "../core/config";
import { SessionManager } from "../core/sessions";
import { Engine } from "../core/engine";
import { Controller } from "../core/controller";
import { dream, runDream } from "../core/dream";
import { isDemo, seedDemo, resetDemoDbFiles } from "../core/demo";
import { TermModeTracker } from "../core/termmodes";
import { listAccounts as listClaudeAccounts, switchTo as switchClaudeAccount } from "../core/accounts";

const PORT = parseInt(process.env.COCKPIT_PORT || "4317", 10);
const HOST = process.env.COCKPIT_HOST || "0.0.0.0";
const SSH_HOST = process.env.COCKPIT_SSH_HOST || "localhost"; // for attach commands shown to the browser
const DEMO = isDemo();

// Ports 4317/4318 are reserved for your canonical checkout. If you run a SECOND (dev/eval) server
// from another checkout on these ports, it would replace your real cockpit and render that
// checkout's data/cockpit.db as the live task queue. To opt into that guard, set
// COCKPIT_CANONICAL_ROOT to your canonical checkout path; dev/eval servers then must pick
// COCKPIT_PORT >= 5000 (they get their own data/cockpit.db). By default the guard is a no-op:
// CANONICAL_ROOT == this checkout, so a fresh clone always starts on 4317/4318.
const REPO_ROOT = fs.realpathSync(path.resolve(__dirname, "../.."));
const CANONICAL_ROOT = process.env.COCKPIT_CANONICAL_ROOT || REPO_ROOT;
if ((PORT === 4317 || PORT === 4318) && REPO_ROOT !== fs.realpathSync(CANONICAL_ROOT)) {
  console.error(
    `FATAL: port ${PORT} is reserved for the canonical checkout (${CANONICAL_ROOT}), ` +
      `but this server is running from ${REPO_ROOT}. Start dev/eval servers with COCKPIT_PORT>=5000 ` +
      `(they get their own data/cockpit.db), or set COCKPIT_CANONICAL_ROOT if the deploy moved.`,
  );
  process.exit(1);
}

// In DEMO mode use a throwaway DB that is RESET on every startup so nothing persists.
let dbPath: string | undefined;
if (DEMO) {
  dbPath = path.resolve(__dirname, "../../data/demo.db");
  resetDemoDbFiles(dbPath);
}
const db = openDb(dbPath);
// One-time idempotent cleanup: drop any stale demo-worktrees sessions that leaked into
// a real db (the old demo seed). No-op in demo mode (fresh throwaway db).
if (!DEMO) {
  const purged = purgeDemoArtifacts(db);
  if (purged.sessions || purged.projectDirs) console.log(`[purge] removed ${purged.sessions} stale demo sessions, ${purged.projectDirs} transcript dirs`);
}
const cfg = loadConfig();
const sm = new SessionManager(db, DEMO);
// Demo: no discovery, no PR scan, no Claude enrichment — fully self-contained + safe.
const engine = new Engine(db, sm, cfg, {
  enrich: DEMO ? false : !process.env.COCKPIT_NO_ENRICH,
  discover: DEMO ? false : undefined,
  pr: DEMO ? false : undefined,
  prScanIntervalMs: cfg.pr_scan_interval_ms, // how often to poll GitHub for open PRs (config-driven)
  kanban: DEMO ? false : undefined, // demo seeds fake kanban cards; never scans the real board
});
const ctrl = new Controller(db, engine, sm, cfg, DEMO);

// SESSION SEARCH: full-history search over every transcript in ~/.claude/projects.
// Index is mtime-cached in data/. DEMO is fully sandboxed: it scans a throwaway projects
// dir (wiped on boot, seedable by tests) instead of the real ~/.claude/projects, and the
// semantic (sonnet) pass never runs — it falls back to keyword so the sandbox stays offline.
const demoSearchDir = path.resolve(__dirname, "../../data/demo_session_search_projects");
const searchCacheFile = path.resolve(__dirname, DEMO ? "../../data/demo_session_search.json" : "../../data/session_search_index.json");
if (DEMO) {
  try {
    fs.rmSync(demoSearchDir, { recursive: true, force: true });
    fs.rmSync(searchCacheFile, { force: true });
    fs.mkdirSync(demoSearchDir, { recursive: true });
  } catch {}
}
const searchSvc = new SessionSearchService(searchCacheFile, DEMO ? 1_000 : 60_000, DEMO ? demoSearchDir : undefined);

const RENDERER_DIR = path.resolve(__dirname, "../renderer");
const WEB_DIR = path.resolve(__dirname, "../server");

// SSE clients to notify the browser after each tick.
const sseClients = new Set<http.ServerResponse>();
function broadcast() {
  for (const res of sseClients) {
    try {
      res.write(`event: update\ndata: {}\n\n`);
    } catch {}
  }
}

async function tickLoop() {
  try {
    await engine.tick();
    void ctrl.applyBgAgentTitles(); // instant clean headlines from `claude agents --json` names
    void ctrl.refreshSessionPrs().then(() => broadcast()).catch(() => {}); // FIX X: bounded bg PR sweep
  } catch (e) {
    console.error("tick error:", e);
  }
  broadcast();
}

// CHEAP path for quick actions (snooze/feedback/ack/sendAnswer/pin/manualImportance): apply
// the DB mutation, recompute priorities from existing data, broadcast, and respond — WITHOUT
// awaiting a full engine tick (discovery + Claude enrichment + gh PR scan), which can take
// seconds under load. The heavy tick keeps running on its own 2s timer.
function quickRerank() {
  try { engine.rerank(); } catch (e) { console.error("rerank error:", e); }
  broadcast();
}
// Seed the demo sandbox first (so the very first /api/state is already populated),
// then start the regular tick loop.
(async () => {
  if (DEMO) {
    try {
      await seedDemo(db, sm, engine, cfg);
      console.log("[demo] seeded fake sandbox tasks (nothing here is real)");
    } catch (e) {
      console.error("[demo] seed error:", e);
    }
  }
  setInterval(tickLoop, cfg.tick_interval_ms);
  // KEEP THE TICK FAST: the engine tick scales with active-session count, so terminal opens that
  // land during a tick stall (2026-06-17: 58 sessions → 1.7s tick → multi-second opens). Reaping
  // idle sessions ONLY nightly let them pile up all day ("slower and slower"). Run the idle-reap
  // hourly too — operator sessions still need >auto_complete_idle_hours, teammates >teammate_idle_reap_hours.
  setInterval(() => { try { reapOrphanTmux(); } catch {} }, 3_600_000);
  tickLoop();
})();

// Nightly: archive sessions silent >N hours (Controller.autoCompleteIdleSessions), then kill
// orphan tmux for tasks completed (Ctrl+G e) long ago — see Controller.reapCompletedTmux.
function reapOrphanTmux() {
  try {
    const ac = ctrl.autoCompleteIdleSessions(cfg.auto_complete_idle_hours, (cfg as any).teammate_idle_reap_hours);
    if (ac.completed) console.log(`[reap] auto-completed ${ac.completed} idle session(s) (ops >${cfg.auto_complete_idle_hours}h, teammates >${(cfg as any).teammate_idle_reap_hours}h)`);
  } catch (e) {
    console.error("auto-complete error:", e);
  }
  try {
    const rr = ctrl.reapCompletedTmux(cfg.reap_completed_tmux_hours);
    if (rr.reaped) console.log(`[reap] killed ${rr.reaped} orphan tmux (sessions completed >${cfg.reap_completed_tmux_hours}h ago)`);
  } catch (e) {
    console.error("reap error:", e);
  }
}

// Nightly "dream": re-tune ranking from the day's decisions. Runs at ~03:00 local.
function scheduleDream() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    try {
      const r = await runDream(db);
      console.log("[dream]", r.summary);
    } catch (e) {
      console.error("dream error:", e);
    }
    reapOrphanTmux();
    broadcast();
    setInterval(async () => {
      try {
        const r = await runDream(db);
        console.log("[dream]", r.summary);
        reapOrphanTmux();
        broadcast();
      } catch (e) {
        console.error("dream error:", e);
      }
    }, 24 * 3600 * 1000);
  }, next.getTime() - now.getTime());
}
scheduleDream();

/** Coerce a value to a positive integer id, or null if it isn't one. */
function numId(v: any): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function send(res: http.ServerResponse, code: number, body: any, type = "application/json") {
  // Defensive: res.end() only accepts string/Buffer — coerce anything else so a stray object body
  // (e.g. an error payload sent as text/plain) can never throw and crash the request/process.
  let data = type === "application/json" ? JSON.stringify(body) : body;
  if (typeof data !== "string" && !Buffer.isBuffer(data)) data = String(data ?? "");
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}

function serveStatic(res: http.ServerResponse, file: string, type: string) {
  if (!fs.existsSync(file)) return send(res, 404, { error: "not found" });
  if (file.endsWith("index.html")) {
    // inject the web shim before renderer.js so window.cockpit exists.
    let html = fs.readFileSync(file, "utf8");
    html = html.replace(
      '<script src="renderer.js"></script>',
      '<script src="webapi.js"></script>\n    <script src="renderer.js"></script>'
    );
    // CACHE-BUST our own assets with the build hash so the browser NEVER serves a stale renderer.js
    // / styles.css / webapi.js (the recurring "buttons dead = old bundle" problem). index.html is
    // no-store, so a new build hash forces fresh fetches of these three.
    const v = (() => { try { return ctrl.buildHash() || String(Date.now()); } catch { return String(Date.now()); } })();
    html = html
      .replace('href="styles.css"', `href="styles.css?v=${v}"`)
      .replace('src="webapi.js"', `src="webapi.js?v=${v}"`)
      .replace('src="renderer.js"', `src="renderer.js?v=${v}"`);
    return send(res, 200, html, "text/html");
  }
  // Binary assets (e.g. image/png) must NOT be utf8-decoded — serve the raw Buffer.
  if (!/^text\/|javascript|json|css/i.test(type)) {
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(fs.readFileSync(file));
    return;
  }
  send(res, 200, fs.readFileSync(file, "utf8"), type);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// CRASH-RESILIENCE: a single bad terminal (e.g. a failing tmux/pty spawn or a throwing WS/onData
// handler) must NEVER take ClaudeOS down. Without these, an uncaught error/rejection exits the
// process and the operator loses the whole app. Log and keep running.
process.on("uncaughtException", (e) => { try { console.error("uncaughtException (kept alive):", e); } catch {} });
process.on("unhandledRejection", (e) => { try { console.error("unhandledRejection (kept alive):", e); } catch {} });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ---- static ----
    if (p === "/favicon.ico") { res.writeHead(204).end(); return; } // silence the harmless 404
    if (p === "/" || p === "/index.html") return serveStatic(res, path.join(RENDERER_DIR, "index.html"), "text/html");
    if (p === "/renderer.js") return serveStatic(res, path.join(RENDERER_DIR, "renderer.js"), "application/javascript");
    if (p === "/styles.css") return serveStatic(res, path.join(RENDERER_DIR, "styles.css"), "text/css");
    if (p === "/logo.png") return serveStatic(res, path.join(RENDERER_DIR, "logo.png"), "image/png");
    if (p === "/webapi.js") return serveStatic(res, path.join(WEB_DIR, "webapi.js"), "application/javascript");
    if (p === "/vendor/xterm.js") return serveStatic(res, path.join(RENDERER_DIR, "vendor", "xterm.js"), "application/javascript");
    if (p === "/vendor/addon-fit.js") return serveStatic(res, path.join(RENDERER_DIR, "vendor", "addon-fit.js"), "application/javascript");
    if (p === "/vendor/addon-webgl.js") return serveStatic(res, path.join(RENDERER_DIR, "vendor", "addon-webgl.js"), "application/javascript");
    if (p === "/vendor/addon-clipboard.js") return serveStatic(res, path.join(RENDERER_DIR, "vendor", "addon-clipboard.js"), "application/javascript");
    if (p === "/vendor/xterm.css") return serveStatic(res, path.join(RENDERER_DIR, "vendor", "xterm.css"), "text/css");
    if (p === "/vendor/diff2html-ui.min.js") return serveStatic(res, path.join(RENDERER_DIR, "vendor", "diff2html-ui.min.js"), "application/javascript");
    if (p === "/vendor/diff2html.min.css") return serveStatic(res, path.join(RENDERER_DIR, "vendor", "diff2html.min.css"), "text/css");
    if (p === "/vendor/github-dark.min.css") return serveStatic(res, path.join(RENDERER_DIR, "vendor", "github-dark.min.css"), "text/css");

    // ---- SSE ----
    if (p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("event: ping\ndata: {}\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ---- API ----
    if (p === "/api/state") return send(res, 200, ctrl.state());
    if (p === "/api/diag" && req.method === "GET") return send(res, 200, { recent: _diagLog }); // FIX T: read recent term diagnostics
    if (p === "/api/accounts" && req.method === "GET") {
      // Manual account picker (see src/core/accounts.ts). Returns snapshots + which is active.
      // Kept OFF the broadcast state — accounts rarely change, no need to push every tick.
      const { accounts, activeLabel } = listClaudeAccounts();
      return send(res, 200, {
        active: activeLabel || null,
        accounts: accounts.map((a) => ({ label: a.label, sizeBytes: a.size, capturedAt: new Date(a.mtimeMs).toISOString() })),
      });
    }
    if (p.startsWith("/api/sessionPr/")) {
      // FIX X: lazily detect (gh) + return a session's open PR; cached 60s. Called when the diff opens.
      const sid = numId(p.slice("/api/sessionPr/".length));
      if (sid == null) return send(res, 400, { error: "bad sessionId" });
      const pr = await ctrl.refreshSessionPr(sid);
      return send(res, 200, { pr: pr || null });
    }
    if (p.startsWith("/api/gist/")) {
      // The SOUL-voiced chat gist (highlights) for a session; cached on transcript mtime, ?force=1
      // regenerates. Lazy — the tick already computes gists for ready items; this covers on-demand
      // refresh (e.g. a WORKING session opened in the chat view).
      const sid = numId(p.slice("/api/gist/".length));
      if (sid == null) return send(res, 400, { error: "bad sessionId" });
      return send(res, 200, await ctrl.gistForSession(sid, url.searchParams.get("force") === "1"));
    }
    if (p.startsWith("/api/prConversation/")) {
      // PR-CONV: PR meta + review runs + conversation timeline (45s server cache; ?force=1 from
      // the ↻ button bypasses it). Lazy — called when the diff view opens, never from the tick loop.
      const sid = numId(p.slice("/api/prConversation/".length));
      if (sid == null) return send(res, 400, { error: "bad sessionId" });
      return send(res, 200, await ctrl.prConversation(sid, url.searchParams.get("force") === "1"));
    }
    if (p.startsWith("/api/viz/")) {
      // FIX O: serve a session's visualization HTML. /api/viz/<sessionId>/<index-or-filename>.
      // resolveViz() guards against path traversal (must stay under viz_dir/<matched folder>).
      const rest = p.slice("/api/viz/".length).split("/");
      const sid = numId(rest[0]);
      const which = decodeURIComponent(rest.slice(1).join("/") || "0");
      if (sid == null) return send(res, 400, { error: "bad sessionId" });
      const abs = ctrl.resolveViz(sid, which);
      if (!abs) return send(res, 404, "no such visualization", "text/plain");
      try { return send(res, 200, fs.readFileSync(abs, "utf8"), "text/html; charset=utf-8"); }
      catch { return send(res, 404, "unreadable", "text/plain"); }
    }
    if (p === "/api/keymap") return send(res, 200, loadKeymap());
    if (p === "/api/raw") {
      const id = numId(url.searchParams.get("itemId"));
      if (id == null) return send(res, 400, { error: "bad itemId" });
      return send(res, 200, { raw: ctrl.rawTranscript(id) });
    }
    if (p === "/api/pretty") {
      const id = numId(url.searchParams.get("itemId"));
      if (id == null) return send(res, 400, { error: "bad itemId" });
      return send(res, 200, { text: ctrl.prettyTranscript(id) });
    }
    // SESSION SEARCH — live keyword filter (every keystroke). Empty q → most recent sessions.
    if (p === "/api/session-search") {
      const q = url.searchParams.get("q") || "";
      const results = await searchSvc.search(q, 30);
      return send(res, 200, { results });
    }
    // SESSION SEARCH — Enter → semantic top-5 via sonnet (keyword fallback on any failure).
    if (p === "/api/session-search/semantic") {
      const q = url.searchParams.get("q") || "";
      if (DEMO) {
        const results = await searchSvc.search(q, 5);
        return send(res, 200, { results, via: "keyword-fallback", error: "demo sandbox — no claude calls" });
      }
      const model = (cfg as any).models?.summary || "sonnet";
      return send(res, 200, await searchSvc.semantic(q, { model }));
    }
    if (p === "/api/attach") {
      const sid = numId(url.searchParams.get("sessionId"));
      if (sid == null) return send(res, 400, { error: "bad sessionId" });
      const cmd = ctrl.attachCommand(sid);
      return send(res, 200, { command: cmd ? `ssh ${SSH_HOST} -t '${cmd}'` : "" });
    }
    // LOCAL terminal (Electron): ensure the durable per-task tmux exists on the server and return the
    // ssh host + trivial `tmux attach` remote command. The desktop app spawns `ssh -t <host>
    // <remote>` in a LOCAL pty (bytes go your laptop↔the server over ssh, bypassing this WS). { ok:false } →
    // the client falls back to the streamed /api/term WebSocket (live/bg/non-resumable sessions).
    if (p === "/api/term-spec") {
      const sid = numId(url.searchParams.get("sessionId"));
      if (sid == null) return send(res, 400, { error: "bad sessionId" });
      try { return send(res, 200, ctrl.localTermSpec(sid, SSH_HOST)); }
      catch (e: any) { return send(res, 200, { ok: false, error: String(e?.message || e) }); }
    }
    if (p === "/api/pane") {
      const sid = numId(url.searchParams.get("sessionId"));
      if (sid == null) return send(res, 400, { error: "bad sessionId" });
      const lines = numId(url.searchParams.get("lines")) || 200;
      return send(res, 200, ctrl.pane(sid, lines));
    }
    if (p === "/api/takeoverable") {
      // FIX E: live BACKGROUND agents that can be taken over (+ status idle/busy) for the UI.
      return send(res, 200, { agents: await ctrl.takeOverableAgents() });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (p === "/api/tick") {
        await tickLoop();
        return send(res, 200, { ok: true });
      }
      if (p === "/api/dream") {
        const r = await runDream(db);
        broadcast();
        return send(res, 200, r);
      }
      if (p === "/api/focus") {
        ctrl.setFocus(typeof body.focus === "string" ? body.focus : "");
        await tickLoop();
        return send(res, 200, { ok: true });
      }
      if (p === "/api/account/switch") {
        // Manual account picker: swap ~/.claude.json to the named snapshot.
        // The next `claude -p` subprocess picks up the swapped credentials; running ones finish under their old auth.
        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (!label) return send(res, 400, { error: "missing label" });
        try {
          const prev = switchClaudeAccount(label);
          return send(res, 200, { ok: true, prev: prev || null, active: label });
        } catch (e: any) {
          return send(res, 400, { ok: false, error: String(e?.message || e) });
        }
      }
      if (p === "/api/undo") {
        const r = ctrl.undo();
        await tickLoop();
        return send(res, 200, r);
      }
      if (p === "/api/key") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        if (typeof body.key !== "string") return send(res, 400, { error: "bad key" });
        return send(res, 200, ctrl.key(sid, body.key, !!body.named));
      }
      if (p === "/api/diag") {
        // FIX T: the browser POSTs terminal-size diagnostics here so they're readable SERVER-SIDE
        // (the operator's screen is remote). Log + keep the last 30 in memory (GET /api/diag).
        const d = body || {};
        const line = `[term-diag ${d.phase}] sess#${d.sessionId} paneB ${d.paneB_w}×${d.paneB_h} · host ${d.host_w}×${d.host_h} · propose ${d.propose_cols}×${d.propose_rows} · term ${d.term_cols}×${d.term_rows}`;
        console.log(line);
        _diagLog.push({ at: new Date().toISOString(), ...d });
        if (_diagLog.length > 30) _diagLog.shift();
        return send(res, 200, { ok: true });
      }
      if (p === "/api/mergePr") {
        // FIX X: merge the session's PR (gh pr merge --<strategy>). The UI confirms first — clicking
        // IS the operator's approval. Outward-facing; never auto-invoked.
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        const r = await ctrl.mergeSessionPr(sid, body.deleteBranch === true);
        if (r.ok) { await tickLoop(); }
        return send(res, 200, r);
      }
      if (p === "/api/resurfaceAll") {
        // One-time repopulate of Up Next: run a FRESH tick (state detection) so readiness is
        // current, then flip every ready (WAITING_INPUT/DONE) non-completed session's
        // DISMISSED ('decided'/'done') item back to pending. Operator-triggered, not automatic.
        await tickLoop();
        const r = ctrl.resurfaceAll();
        quickRerank();
        return send(res, 200, r);
      }
      if (p === "/api/reprioritize") {
        // OPERATOR-TRIGGERED full re-prioritization: re-judge EVERY queued task's importance against
        // the CURRENT focus and re-rank the whole queue — overriding the Up-Next freeze for this one
        // action (normally a task already in the queue keeps its priority). Heavy: one model call per
        // task, fire-and-forget, so scores refresh over the next few ticks. broadcast() pushes the
        // immediate re-sort (focus keyword-match / staleness / flags) right away.
        // 2026-06-29: any unhandled throw from engine.reprioritizeAll() (e.g. a missing transcript
        // file deep in detect()) used to surface in the UI as the unhelpful "re-prioritize failed"
        // toast with no detail. Catch + surface the message so the operator can diagnose.
        try {
          const r = await engine.reprioritizeAll();
          broadcast();
          return send(res, 200, r);
        } catch (e: any) {
          console.error("[reprioritize] failed:", e?.stack || e);
          return send(res, 500, { ok: false, error: String(e?.message || e) });
        }
      }
      if (p === "/api/reasonFeedback") {
        // FIX BB: strong reasoned priority feedback (direction down|up + reason text).
        const itemId = numId(body.itemId);
        if (itemId == null || (body.direction !== "down" && body.direction !== "up")) return send(res, 400, { error: "bad itemId/direction" });
        const r = ctrl.reasonFeedback(itemId, body.direction, typeof body.reason === "string" ? body.reason : "");
        quickRerank();
        return send(res, 200, r);
      }
      if (p === "/api/activate") {
        // FIX L: opening a terminal on a task makes it the ACTIVE task → boost to top + re-rank.
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        const r = ctrl.activateSession(sid);
        quickRerank();
        return send(res, 200, r);
      }
      if (p === "/api/complete") {
        // FIX J: complete & archive a session (durable, survives re-discovery) + move its kanban
        // card to 8_done. Undoable.
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        const r = ctrl.completeTask(sid);
        quickRerank();
        return send(res, 200, r);
      }
      if (p === "/api/takeover") {
        // E-REPURPOSE: a cc-daemon bg agent can't be durably killed (it respawns), so this no
        // longer kills — it returns {needsManualStop} telling the operator to stop it in their
        // `claude agents` view (Ctrl+X). FIX I then resumes it here instantly once its process is
        // gone. If it's already stopped, returns {ok:true} → directly resumable.
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        const r = await ctrl.takeOverAgent(sid);
        if (r.ok) { try { await ctrl.applyBgAgentTitles(); } catch {} broadcast(); }
        return send(res, 200, r);
      }
      if (p === "/api/takeoverAll") {
        // E-REPURPOSE: no safe bulk kill (daemon agents respawn). Just return the list of live
        // bg agents the operator should stop (Ctrl+X) in their agents view; each then resumes
        // here instantly via FIX I.
        return send(res, 200, { ok: true, agents: await ctrl.takeOverableAgents() });
      }
      if (p === "/api/pin") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        ctrl.setPinned(sid, !!body.pinned);
        quickRerank(); // cheap re-sort + broadcast, no heavy tick
        return send(res, 200, { ok: true });
      }
      // SESSION SEARCH — open a result: upsert the historical session into the roster (keyed
      // by its transcript uuid, so re-opening never duplicates), then the renderer attaches
      // it through the NORMAL roster path (attachReviewSession → durable claudeos-<id> tmux).
      if (p === "/api/session-search/open") {
        const cid = typeof body.claudeSessionId === "string" ? body.claudeSessionId.trim() : "";
        if (!cid) return send(res, 400, { error: "bad claudeSessionId" });
        await searchSvc.ensure();
        const e = searchSvc.byId(cid);
        if (!e) return send(res, 404, { ok: false, error: "unknown session" });
        // No recorded cwd = an internal helper stub or torn transcript head. Falling back to
        // $HOME here used to fabricate an unopenable phantom card pointing at the home dir
        // (empty bash terminal, no task behind it) — refuse instead.
        if (!e.cwd) return send(res, 422, { ok: false, error: "transcript has no working directory (internal helper stub) — nothing to open" });
        const cwd = e.cwd;
        const sessionId = upsertDiscoveredSession(db, {
          claude_session_id: cid,
          title: (e.title || e.first || e.last || "resumed session").slice(0, 120),
          repo: path.basename(cwd) || "?",
          worktree_path: cwd,
          branch: "",
          transcript_path: e.transcript_path,
          clean_title: e.title || null,
        });
        quickRerank();
        return send(res, 200, { ok: true, sessionId });
      }
      if (p === "/api/renameSession") {
        // Inline rename from the overview: set/clear the operator-typed session name.
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        const r = ctrl.renameSession(sid, typeof body.title === "string" ? body.title : "");
        broadcast(); // other clients pick the new name up immediately
        return send(res, 200, r);
      }
      if (p === "/api/manualImportance") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        const v = body.value === null || body.value === undefined ? null : Number(body.value);
        ctrl.setManualImportance(sid, v);
        quickRerank(); // cheap re-rank, respond immediately
        return send(res, 200, { ok: true });
      }
      if (p === "/api/overrideState") {
        // MANUAL STATE OVERRIDE: operator right-clicked a card to correct its status. state is one
        // of WAITING_INPUT | WORKING | DONE, or null/"" to clear the override (let Claude decide).
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        const raw = body.state === null || body.state === undefined || body.state === "" ? null : String(body.state);
        if (raw !== null && !["WAITING_INPUT", "WORKING", "DONE"].includes(raw))
          return send(res, 400, { error: "bad state" });
        const r = ctrl.overrideState(sid, raw as any);
        quickRerank(); // cheap re-sort + broadcast so the card moves/surfaces immediately
        return send(res, 200, r);
      }
      if (p === "/api/prDiff") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, await ctrl.prDiff(sid));
      }
      if (p === "/api/worktreeDiff") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, await ctrl.worktreeDiff(sid));
      }
      if (p === "/api/diffExpand") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, await ctrl.diffExpand(sid, String(body.path || ""), Number(body.ctx) || 0, String(body.oldPath || "")));
      }
      if (p === "/api/prReviews") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, await ctrl.prReviews(sid));
      }
      if (p === "/api/diffViewed") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, { viewed: ctrl.diffViewed(sid) });
      }
      if (p === "/api/setDiffViewed") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, ctrl.setDiffViewed(sid, String(body.filePath || ""), !!body.viewed));
      }
      if (p === "/api/newSession") {
        const kind = body.kind === "shell" ? "shell" : "claude";
        // Optional manual importance (0–100) so the operator can set a task's priority right when
        // firing a quick prompt. null/undefined → none (default ranking). Clamped server-side.
        const imp =
          body.importance === null || body.importance === undefined || body.importance === ""
            ? null
            : Math.max(0, Math.min(100, Math.round(Number(body.importance)) || 0));
        const repo = typeof body.repo === "string" && body.repo ? body.repo : null;
        const r = ctrl.newSession(kind, typeof body.prompt === "string" ? body.prompt : undefined, imp, repo);
        await tickLoop();
        return send(res, 200, r);
      }
      if (p === "/api/launchSession") {
        const r = ctrl.launchSession(String(body.repo || ""), String(body.title || ""), String(body.prompt || ""));
        await tickLoop();
        return send(res, 200, r);
      }
      if (p === "/api/kanbanStart") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        const r = ctrl.kanbanStart(sid);
        await tickLoop();
        return send(res, 200, r);
      }
      if (p === "/api/kanbanAnswer") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, ctrl.kanbanAnswer(sid, Array.isArray(body.answers) ? body.answers : []));
      }
      if (p === "/api/kanbanAppend") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, ctrl.kanbanAppend(sid));
      }
      if (p === "/api/prStatus") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, await ctrl.prStatus(sid));
      }
      if (p === "/api/prMerge") {
        const sid = numId(body.sessionId);
        if (sid == null) return send(res, 400, { error: "bad sessionId" });
        return send(res, 200, await ctrl.prMerge(sid, body.method, body.deleteBranch === true));
      }
      // remaining POSTs operate on an item id
      const id = numId(body.itemId);
      if (id == null) return send(res, 400, { error: "bad or missing itemId" });
      if (p === "/api/sendAnswer") { const r = ctrl.sendAnswer(id, body.answer); quickRerank(); return send(res, 200, r); }
      if (p === "/api/ack") { ctrl.ack(id); quickRerank(); return send(res, 200, { ok: true }); }
      if (p === "/api/dismiss") { ctrl.dismiss(id); quickRerank(); return send(res, 200, { ok: true }); }
      if (p === "/api/snooze") {
        ctrl.snooze(id, numId(body.minutes) || 60);
        quickRerank(); // cheap re-rank → snoozed item sinks → respond instantly
        return send(res, 200, { ok: true });
      }
      if (p === "/api/feedback") {
        ctrl.feedback(id, body.fb);
        quickRerank();
        return send(res, 200, { ok: true });
      }
    }

    send(res, 404, { error: "not found", path: p });
  } catch (e: any) {
    send(res, 500, { error: String(e?.message || e) });
  }
});

// ---- REAL attached terminal: a WebSocket that pipes a node-pty `tmux attach` both ways.
// This replaces the old capture-pane MIRROR: the browser xterm.js is wired to a genuine
// PTY attached to the exact tmux session, so keys/colors/redraws/autocomplete are native
// and low-latency. ws path: /api/term?sessionId=&cols=&rows=
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let url: URL;
  try { url = new URL(req.url || "/", `http://${req.headers.host}`); } catch { socket.destroy(); return; }
  if (url.pathname !== "/api/term") { socket.destroy(); return; }
  const sid = parseInt(url.searchParams.get("sessionId") || "", 10);
  const cols = Math.max(20, parseInt(url.searchParams.get("cols") || "100", 10) || 100);
  const rows = Math.max(6, parseInt(url.searchParams.get("rows") || "30", 10) || 30);
  wss.handleUpgrade(req, socket, head, (ws) => {
    // CRASH-RESILIENCE: never let a terminal-attach error (pty/tmux spawn, etc.) escape and crash
    // the server — contain it to this one socket.
    attachTerminal(ws as any, sid, cols, rows).catch((e: any) => {
      try { console.error("attachTerminal error (contained):", e); ws.send(`\r\n\x1b[31mterminal error: ${String(e?.message || e)}\x1b[0m\r\n`); ws.close(); } catch {}
    });
  });
});

// P4: per-session DIRECT pty (`claude --resume`) — NO tmux in the path → no double-rendering,
// snappier. Persists across browser reconnects (reopening REUSES the live pty, doesn't respawn);
// cleaned only when the claude process exits.
interface DirectPty { term: pty.IPty; ws: any; buffer: string; modes: TermModeTracker; }
const directPtys = new Map<number, DirectPty>();
// FIX T: in-memory ring of recent terminal-size diagnostics POSTed by the browser (server-readable).
const _diagLog: any[] = [];

/** Disable Nagle so single keystrokes flush immediately (biggest felt win over the network). */
function noDelay(ws: any) { try { ws._socket && ws._socket.setNoDelay(true); } catch {} }

/** Force a tmux session's window to the attaching client's size. The fallback attach uses
 *  `-f ignore-size` (so a stray second client can't shrink OUR dedicated per-task session), which
 *  also means the client never grows the window either — a freshly launched session would stay at
 *  tmux's 80×24 default and claude would draw a tiny box in the top-left. An explicit `resize-window`
 *  overrides ignore-size and makes the window (and thus claude) fill the xterm. Fire-and-forget. */
function tmuxResizeWindow(name: string, cols: number, rows: number, env: NodeJS.ProcessEnv) {
  if (!name || !(cols > 0) || !(rows > 0)) return;
  try {
    require("child_process").execFile(
      "tmux", ["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)],
      { env }, () => {}
    );
  } catch {}
}

/** Wire a ws ⇄ pty: coalesced output, input passthrough, resize, "used" marker. `onDetach`
 *  runs when this ws goes away (kills the pty for tmux-attach; just unbinds for direct). */
function wireTermWs(ws: any, term: pty.IPty, sessionId: number, onDetach: () => void, onResize?: (cols: number, rows: number) => void) {
  noDelay(ws);
  let outBuf = "", flushScheduled = false;
  const flush = () => { flushScheduled = false; if (outBuf) { const d = outBuf; outBuf = ""; try { ws.send(d); } catch {} } };
  const dataDisp = term.onData((d) => { outBuf += d; if (!flushScheduled) { flushScheduled = true; setImmediate(flush); } });
  ws.on("message", (raw: any) => {
    let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg && msg.t === "i" && typeof msg.d === "string") { try { term.write(msg.d); } catch {} }
    else if (msg && msg.t === "r" && msg.cols > 0 && msg.rows > 0) { try { term.resize(msg.cols, msg.rows); } catch {} if (onResize) try { onResize(msg.cols, msg.rows); } catch {} }
    else if (msg && msg.t === "used") { try { ctrl.markSessionInput(sessionId); } catch {} }
  });
  // HEARTBEAT: ping every 20s; if no pong arrives before the next tick the socket is a dead
  // half-open (common over the network — TCP never sends FIN), so terminate it. That makes the
  // CLIENT's onclose fire and it auto-reconnects, instead of the operator typing into a black hole.
  // Browsers auto-reply to protocol pings, so a genuinely live socket always stays alive.
  let alive = true;
  ws.on("pong", () => { alive = true; });
  const hb = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch {} clearInterval(hb); return; }
    alive = false;
    try { ws.ping(); } catch {}
  }, 20000);
  const off = () => { clearInterval(hb); try { (dataDisp as any) && (dataDisp as any).dispose && (dataDisp as any).dispose(); } catch {} onDetach(); };
  ws.on("close", off); ws.on("error", off);
}

/** tmux-attach fallback (live / bg-agent / no-resumable session). `notice` is an optional
 *  dim status line shown on connect. If no attach spec resolves, a clear inline message is
 *  shown instead of any raw error. */
/** FIX D: render THIS session's OWN transcript read-only into the ws (no pty, no pane attach).
 *  Used when a session can't be `--resume`d AND has no safe exact pane — instead of grabbing the
 *  wrong cwd-shared pane, we show its own conversation so the operator sees the RIGHT session. */
async function sendReadOnlyTranscript(ws: any, sessionId: number, label: string) {
  let body = "(no transcript)";
  try { body = await ctrl.sessionTranscriptText(sessionId, 30); } catch {}
  try {
    const text = body.replace(/\n/g, "\r\n");
    ws.send(`\r\n\x1b[2m${label}\x1b[0m\r\n\r\n${text}\r\n`);
    ws.send(`\r\n\x1b[2m(read-only — nothing to type here)\x1b[0m\r\n`);
    // DO NOT ws.close() here. The renderer treats an unexpected socket close as a dropped
    // terminal and AUTO-RECONNECTS (term-foot "reconnecting… try N") → re-opens → re-sends this
    // same read-only dump → infinite spam loop. Keep the socket OPEN and idle: the operator sees a
    // static read-only view, the renderer stays "live", and no reconnect fires. Incoming keystrokes
    // are intentionally ignored (read-only). The socket is cleaned up when the operator navigates
    // away (renderer closes it intentionally) or the process exits.
    try { ws.on?.("message", () => { /* read-only: ignore input */ }); } catch {}
  } catch {}
}

function tmuxAttachFallback(ws: any, sessionId: number, cols: number, rows: number, notice?: string, isBg = false) {
  // A BACKGROUND AGENT has no attachable pane of its own (it's daemon-managed). Any attachSpec
  // match is therefore a FOREIGN pane that merely shares the cwd — attaching it spawns a tmux
  // client that exits instantly (tmux prints "[exited]") → ws.close() → the renderer auto-reconnects
  // → re-attach → an endless "[exited]" / reconnecting↔live FLICKER. So for a bg agent skip the
  // attach entirely and show the stable read-only transcript (socket kept open).
  const spec = isBg ? null : ctrl.attachSpec(sessionId);
  if (!spec) {
    // No safe pane to attach to → show this session's OWN transcript read-only (NEVER a foreign pane).
    void sendReadOnlyTranscript(ws, sessionId, "● background agent — read-only (interact via your agents view)");
    return;
  }
  let term: pty.IPty;
  try { term = pty.spawn("tmux", spec.argv, { name: "xterm-256color", cols, rows, env: spec.env as any }); }
  catch { void sendReadOnlyTranscript(ws, sessionId, "● could not attach — read-only"); return; } // do NOT close (→ reconnect loop)
  // Our dedicated per-task session attaches with `ignore-size` → force its window to the xterm size
  // (else a freshly-launched session stays at tmux's 80×24 default = tiny box in the top-left).
  if (spec.resizeName) tmuxResizeWindow(spec.resizeName, cols, rows, spec.env);
  if (notice) { try { ws.send(`\r\n\x1b[2m${notice}\x1b[0m\r\n`); } catch {} }
  const startedAt = Date.now();
  term.onExit(() => {
    // An IMMEDIATE exit means the pane was stale/gone (the tmux client detached at once). Closing the
    // ws here would make the renderer reconnect → re-attach → flicker. Instead fall back to the stable
    // read-only transcript (keeps the socket open). A LATER exit is a real detach → close normally.
    if (Date.now() - startedAt < 2500) void sendReadOnlyTranscript(ws, sessionId, "● read-only (live session not attachable)");
    else { try { ws.close(); } catch {} }
  });
  wireTermWs(ws, term, sessionId, () => {
    try { term.kill(); } catch {} // killing a tmux-attach just DETACHES
    try { const r = ctrl.cleanupOrPromoteProvisional(sessionId); if (r.action !== "kept") broadcast(); } catch {}
  }, spec.resizeName ? (c, r) => tmuxResizeWindow(spec.resizeName!, c, r, spec.env) : undefined);
}

async function attachTerminal(ws: any, sessionId: number, cols: number, rows: number) {
  if (!Number.isInteger(sessionId)) { try { ws.close(); } catch {} return; }
  // PROVISIONAL GUARD: opening a terminal IS an interaction — mark it so a brand-new provisional
  // session opened then detached without typing is KEPT, never deleted (operator can't lose it).
  try { ctrl.markSessionOpened(sessionId); } catch {}

  // 1) REUSE an existing direct pty for this session (don't respawn `claude --resume`).
  const existing = directPtys.get(sessionId);
  if (existing) {
    existing.ws = ws;
    // Replay the recent screen — PREFIXED with the latest DECSET state (alt-screen / mouse
    // tracking / bracketed paste). The 200KB buffer tail long ago lost the head of the stream
    // where tmux enabled mouse mode, so without this the fresh xterm never sends wheel events
    // and the terminal can't scroll (until a real resize made tmux re-assert its modes —
    // the old "maximize once to fix scrolling" workaround).
    if (existing.buffer) { try { ws.send(existing.modes.reassertPrefix() + existing.buffer); } catch {} }
    try { existing.term.resize(cols, rows); } catch {}
    wireTermWs(ws, existing.term, sessionId, () => { if (existing.ws === ws) existing.ws = null; });
    return;
  }

  // FIX I: FRESH, PROCESS-BASED liveness. A session is unsafe to `--resume` ONLY if a process is
  // actually running it — in `claude agents --json` (fresh, not the 10s cache) OR holding the
  // transcript fd. Transcript mtime alone does NOT block, so an externally-stopped (Ctrl+X) or
  // just-killed agent — dead process, recent mtime — resumes IMMEDIATELY (no 60s wait). This
  // subsumes the old wasJustTakenOver special-case (kept only as a belt-and-suspenders override).
  let isBg = false, live = false;
  try { const L = await ctrl.livenessForOpen(sessionId); isBg = L.isBg; live = L.live; } catch {}
  if (ctrl.wasJustTakenOver(sessionId)) { live = false; isBg = false; }

  // 2) DIRECT spawn ONLY for a genuinely idle, non-bg, resumable claude session.
  const dspec = live ? null : ctrl.directResumeSpec(sessionId);
  if (dspec) {
    let term: pty.IPty;
    try { term = pty.spawn(dspec.cmd, dspec.args, { name: "xterm-256color", cols, rows, cwd: dspec.cwd, env: dspec.env as any }); }
    catch (e: any) { try { console.error(`[term] direct-spawn FAILED sess#${sessionId} cmd=${dspec.cmd} cwd=${dspec.cwd} err=${String(e?.message || e)}`); } catch {} try { ws.send(`\r\n\x1b[31mfailed to start claude --resume: ${String(e?.message || e)}\x1b[0m\r\n`); ws.close(); } catch {} return; }
    const reg: DirectPty = { term, ws, buffer: "", modes: new TermModeTracker() };
    directPtys.set(sessionId, reg);
    // DEFENSIVE: if `claude --resume` REFUSES (bg-agent / already-running) it exits fast with a
    // tell-tale message. If it dies within ~2s saying "background agent"/"currently running",
    // auto-fall-back to tmux-attach so the operator NEVER sees the raw error.
    const startedAt = Date.now();
    term.onData((d) => { reg.buffer = (reg.buffer + d).slice(-200000); reg.modes.feed(d); });
    term.onExit(() => {
      directPtys.delete(sessionId);
      const early = Date.now() - startedAt < 2500;
      const refused = /background agent|currently running|--fork-session/i.test(reg.buffer);
      // ANY early exit means `claude --resume` never gave us a usable session (it refused as a
      // bg-agent/already-running, or errored). Don't ws.close() (→ renderer reconnects → respawns →
      // loop) — fall back to tmux-attach, which itself lands on the stable read-only view if there's
      // no safe pane. (Was gated on the exact refusal wording; a reworded message slipped through to
      // the close→reconnect loop.) A LATER exit is a session the operator genuinely ended → close.
      if (early && reg.ws === ws) {
        try { ws.send("\r\n\x1b[2m● background agent — opening agents view…\x1b[0m\r\n"); } catch {}
        tmuxAttachFallback(ws, sessionId, cols, rows, undefined, isBg || refused);
      } else {
        try { reg.ws && reg.ws.close(); } catch {}
      }
    });
    // FIX GG: on WS close (operator dismissed / snoozed / navigated away / closed the view) we ONLY
    // detach (null the ws) — we DO NOT kill the pty. With FF the pty is a `tmux new-session -A` client
    // of `claudeos-<id>`, so claude keeps running in the tmux server even after this (and even across
    // a ClaudeOS restart). Reopening reuses this pty (replays the live screen) or re-attaches the
    // persistent tmux — showing the operator's message + claude's answer that arrived while away.
    wireTermWs(ws, term, sessionId, () => { if (reg.ws === ws) reg.ws = null; /* GG: keep claude alive */ });
    return;
  }

  // 3) FALLBACK: tmux-attach for live / bg-agent / no-resumable sessions. A bg agent has no pane of
  //    its own → tmuxAttachFallback routes straight to read-only (no phantom-pane "[exited]" flicker).
  //    PR-TERMINAL: if a PR card's terminal couldn't be materialized (no local clone / no head branch
  //    yet), say WHY instead of leaving the operator on a silent "(no transcript)" dead end.
  const prErr = ctrl.prTerminalError(sessionId);
  tmuxAttachFallback(ws, sessionId, cols, rows, isBg ? "● background agent — opening agents view" : (live ? "● running live — attaching to the existing session" : (prErr ? `✗ PR terminal unavailable: ${prErr}` : undefined)), isBg);
}

// Clean up demo throwaway tmux sessions on shutdown.
if (DEMO) {
  const bye = () => { try { sm.killDemoTmux(); } catch {} process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

server.listen(PORT, HOST, () => {
  console.log(`ClaudeOS web server on http://${HOST}:${PORT}${DEMO ? "  [DEMO SANDBOX — nothing is real]" : ""}`);
  console.log(`from your laptop:  ssh -L ${PORT}:localhost:${PORT} ${SSH_HOST}   then open http://localhost:${PORT}`);
});
