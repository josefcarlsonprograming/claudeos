/**
 * Renderer: the single-operator cockpit UI. Entirely keyboard-driven via the keymap
 * loaded from config. Shows ONE recommended action with a compact queue behind it,
 * renders the AI-chosen adaptive view per category, and lets the operator expand any
 * item to the raw transcript with a single keystroke.
 */
// NOTE: keep this file free of import/export so tsc emits a plain browser script
// (no CommonJS `exports`). The preload exposes window.cockpit via contextBridge.
const api = (window as any).cockpit;

interface S {
  state: any;
  keymap: Record<string, string>;
  sel: number; // index into queue
  rawFor: number | null; // item id whose raw transcript is shown
  jumpMode: boolean;
  termSession: number | null; // session id whose live terminal panel is open
  termTimer: any; // poll handle for the live terminal
  term: any; // xterm.js Terminal instance (real terminal rendering)
  termFit: any; // xterm FitAddon
  termCols: number; // last known pane grid size
  termWs: WebSocket | null; // websocket to the real attached PTY (browser / fallback transport)
  termNative: { id: string } | null; // LOCAL terminal: a handle to an Electron-spawned `ssh→tmux` pty (transport bypasses the WS)
  termSessionForPane: number | null; // session id the (single) live terminal is attached to
  termIntentionalClose: boolean; // true while a teardown/switch is in progress → onclose must NOT reconnect
  termReconnectTimer: any; // pending auto-reconnect timer (null when none scheduled)
  termReconnectAttempts: number; // consecutive failed reconnects (drives backoff; reset to 0 on a live socket)
  panes: { A: PaneView; B: PaneView }; // each pane shows ONE view independently
  paneManual: { A: boolean; B: boolean }; // operator manually set this pane (don't auto-yank)
  paneItem: { A: number | null; B: number | null }; // item id each pane's content is rendered for
  termPane: "A" | "B" | null; // which pane currently hosts the single live terminal
  termFull: boolean; // terminal POWER MODE: fills the window, Ctrl+B → inner tmux (native)
  fullPane: "A" | "B" | null; // FIX HH: which pane (ANY view) is maximized to fill the window
  focused: "A" | "B"; // which pane the leader (o/t/d/r) acts on
  selItemId: number | null; // selected item id last seen (to detect task change)
  paneMode: "detail" | "terminal" | "diff" | "launcher"; // legacy (kept for type compat)
  paneItemId: number | null; // legacy
  diffFormat: "side-by-side" | "line-by-line"; // diff2html output format (split default)
  vizTab: number; // FIX O: selected visualization HTML tab index
  diffPatch: { A: string; B: string }; // last loaded unified patch per pane (for toggle)
  leaderActive: boolean; // tmux-style leader (Ctrl+B) was pressed; next key is a command
  leaderTimer: any;
  diffSession: number | null; // session id whose PR diff is shown
  lastCardId: number | null; // last rendered card item id (for one-time autofocus)
  pendingConfirm: (() => Promise<void>) | null; // action for the shared confirm overlay
  autoOpened: Set<number>; // item ids whose live terminal we already auto-opened once (COMPLEX routing)
  autoDiffed: Set<number>; // item ids whose split diff we already auto-opened once (PR/REVIEW routing)
  autoVized: Set<string>; // "sessionId:vizCount" keys whose HTML we already auto-surfaced once (re-fires when a NEW html appears)
}
type PaneView = "overview" | "terminal" | "diff" | "html";
const S: S = { state: null, keymap: {}, sel: 0, rawFor: null, jumpMode: false, termSession: null, termTimer: null, term: null, termFit: null, termCols: 0, termWs: null, termNative: null, termSessionForPane: null, termIntentionalClose: false, termReconnectTimer: null, termReconnectAttempts: 0, panes: { A: "overview", B: "terminal" }, paneManual: { A: false, B: false }, paneItem: { A: null, B: null }, termPane: null, termFull: false, fullPane: null, focused: "A", selItemId: null, paneMode: "detail", paneItemId: null, diffFormat: "side-by-side", vizTab: 0, diffPatch: { A: "", B: "" }, leaderActive: false, leaderTimer: null, diffSession: null, lastCardId: null, pendingConfirm: null, autoOpened: new Set<number>(), autoDiffed: new Set<number>(), autoVized: new Set<string>() };

// ===================== DETACHED DETAIL WINDOW (the 3rd pane: Diff / HTML) =====================
// ClaudeOS opens a SECOND OS window (window.open ?view=detail) that the operator drags onto a
// separate screen. It loads the SAME renderer.js — so every diff/html rendering path is reused
// byte-for-byte — but runs in DETAIL MODE: all chrome hidden, showing ONLY the Diff/HTML viewer
// for the CURRENTLY-SELECTED task. The selection is mirrored from the main window over a
// BroadcastChannel; live data comes from the same /api/state + /api/events SSE. The main two-pane
// window is left completely unchanged (this is purely additive).
const IS_DETAIL = (() => { try { return new URLSearchParams(location.search).get("view") === "detail"; } catch { return false; } })();
const _detailChan: BroadcastChannel | null = (typeof BroadcastChannel !== "undefined") ? new BroadcastChannel("claudeos-detail") : null;
let _detailSelId: number | null = null;     // (detail window) item id the main window currently has selected
let _detailSelSessionId: number | null = null; // (detail window) session id of that selection — resolves virtual-top/roster-only items the item id can't
let _detailRenderedId: number | null = null; // (detail window) item id whose content is currently rendered
let _detailManual = false;                  // (detail window) operator manually picked Diff/HTML for this item

/** (main window) tell the detached detail window which task is selected. Cheap; called every render.
 *  Sends the SESSION id too: a virtual-top / roster-only selection (an opened/taken-over session
 *  with no queue item) has a synthetic item id that exists ONLY in this window's in-memory queue —
 *  the detail window's server-fetched queue can't resolve it and would fall back to queue[0]
 *  (so the operator's PR/session "never shows up" in the detached window). The session id is global,
 *  so the detail window can find the item by session or synthesize one from the roster. */
function broadcastSel(): void {
  if (!_detailChan || IS_DETAIL) return;
  const it = selectedItem();
  try { _detailChan.postMessage({ type: "sel", id: S.selItemId, sessionId: it && it.session ? it.session.id : null }); } catch {}
}

/** (main window) open — or refocus — the detached Diff/HTML window on the operator's other screen.
 *  Reuses the named target so a second call just refocuses the existing window (no duplicates). */
function openDetailWindow(): void {
  try {
    const w = window.open("?view=detail", "claudeos-detail", "width=1280,height=900");
    if (!w) { setStatus("⚠ detail window blocked — allow pop-ups for this site, then click ⧉ detail"); return; }
    try { w.focus(); } catch {}
  } catch { setStatus("⚠ could not open detail window"); }
}

const $ = (id: string) => document.getElementById(id)!;
function esc(s: string): string {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}
// Compact "how long ago" label (e.g. "30m ago", "3h ago", "2d ago") from an ISO timestamp —
// what the operator means by "this happened a while back" in the sessions roster.
function timeAgo(iso: string): string {
  const ms = Date.parse(iso || "");
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  return `${w}w ago`;
}

// ---------- Overview dashboard (the bottom-of-pane stats + bars) ----------
function mFmtDur(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
function mFmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

/** "this session" bar panel for the CURRENTLY selected session — GPU-dashboard style bars (track +
 *  fill colored by a lower-is-better band). Everything is about this one tmux window / Claude
 *  session; the only global figure is the total session count. */
function renderSessionStats(it: any): string {
  const m: any = S.state && (S.state as any).metrics;
  if (!m || !m.sessions || !it || !it.session) return "";
  const cur = m.sessions.find((s: any) => s.id === it.session.id);
  if (!cur) return "";
  const total = (m.totals && m.totals.sessions) || m.sessions.length;
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  // lower-is-better banding → a LEVEL class (colours + texture live in CSS, colourblind-safe:
  // blue=low, amber=mid, striped-red=high, slate=no-data). Never relies on red/green hue alone.
  const band = (v: number | null, lo: number, hi: number) =>
    v == null ? "none" : v < lo ? "low" : v <= hi ? "mid" : "high";
  // Piecewise (non-linear) width: each band fills an EQUAL THIRD of the bar regardless of how wide
  // its value range is — [0,lo)→0–⅓, [lo,hi)→⅓–⅔, [hi,max)→⅔–1 (clamped). So "low" always reads as
  // the first third even when it spans 1h while the red third spans a day.
  const seg = (v: number | null, lo: number, hi: number, max: number): number => {
    if (v == null || v <= 0) return 0;
    if (v < lo) return v / lo / 3;
    if (v <= hi) return (1 + (v - lo) / (hi - lo)) / 3;
    return (2 + Math.min(1, (v - hi) / (max - hi))) / 3;
  };
  // one bar row: label · fill (width = piecewise third; level class carries colour+pattern) · value.
  // (lo, hi, max) = the low|mid|high thresholds; `max` is where the red third fills completely.
  const row = (label: string, valTxt: string, v: number | null, lo: number, hi: number, max: number) => {
    const pct = (seg(v, lo, hi, max) * 100).toFixed(1);
    return (
      `<div class="ss-row">` +
      `<span class="ss-k">${esc(label)}</span>` +
      `<span class="ss-bar"><span class="ss-fill lvl-${band(v, lo, hi)}" style="width:${pct}%"></span></span>` +
      `<span class="ss-val">${esc(valTxt)}</span>` +
      `</div>`
    );
  };
  return (
    `<div class="sess-stats">` +
    `<div class="ss-head">this session<span class="ss-total">${total} total</span></div>` +
    row("uptime", mFmtDur(cur.ageMs), cur.ageMs, 2 * HOUR, 6 * HOUR, 2 * DAY) +
    row("last reply", cur.sinceLastMs != null ? mFmtDur(cur.sinceLastMs) + " ago" : "—", cur.sinceLastMs, 20 * MIN, 60 * MIN, 2 * HOUR) +
    row("context", "~" + mFmtNum(cur.estTokens), cur.estTokens, 100_000, 300_000, 1_000_000) +
    row("avg queue wait", mFmtDur(cur.avgQueueWaitMs), cur.avgQueueWaitMs, 20 * MIN, 60 * MIN, 10 * HOUR) +
    row("median reply", mFmtDur(cur.medianReplyMs), cur.medianReplyMs, 20 * MIN, 60 * MIN, 4 * HOUR) +
    row("came back", `${cur.cameBack || 0}×`, cur.cameBack, 10, 50, 60) +
    `</div>`
  );
}

/** Global "task queue" panel under the per-session stats: how much is waiting, how fast tasks
 *  start/complete (last hour + 24h), the smoothed 24h trend chart, completions per tag, and the
 *  latest completions. Data is metrics.throughput (controller.throughput()); pure HTML/SVG. */
function renderQueuePulse(): string {
  const t: any = S.state && (S.state as any).metrics && (S.state as any).metrics.throughput;
  if (!t || !Array.isArray(t.hourly)) return "";
  const tile = (n: number, label: string, sub = "", cls = "") =>
    `<div class="qp-tile ${cls}"><div class="qp-n">${n}</div><div class="qp-l">${esc(label)}</div>` +
    `<div class="qp-sub">${sub ? esc(sub) : "&nbsp;"}</div></div>`;
  // Pace = rolling completions last 12h vs the 12h before (server-computed equal windows, so the
  // partial current hour can't bias it toward "slowing").
  const h: any[] = t.hourly;
  const recent = t.completed12h | 0, prev = t.completedPrev12h | 0;
  const pace =
    recent > prev ? `<span class="qp-pace up" title="${recent} completed in the last 12h vs ${prev} the 12h before">▲ picking up</span>`
    : recent < prev ? `<span class="qp-pace down" title="${recent} completed in the last 12h vs ${prev} the 12h before">▼ slowing</span>`
    : `<span class="qp-pace flat" title="${recent} completed in the last 12h, same as the 12h before">— steady</span>`;

  // ---- trend chart: smooth curves over a CENTERED 3h ROLLING MEAN — per-hour counts are too
  // spiky at a few tasks/hour; the operator reads the trend, raw hourly numbers stay on hover.
  // Inline SVG, viewBox-scaled to the pane width (taller than the old bar strip on purpose).
  // <2 buckets can't form a line (and would NaN the x scale) — degrade to a chartless panel.
  const drawChart = h.length >= 2;
  const W = 480, H = 120, PAD = 6;
  const smooth = (key: string): number[] =>
    h.map((_, i) => {
      const lo = Math.max(0, i - 1), hi = Math.min(h.length - 1, i + 1);
      let s = 0;
      for (let j = lo; j <= hi; j++) s += h[j][key];
      return s / (hi - lo + 1);
    });
  const sDn = smooth("completed"), sSt = smooth("started");
  const rawMax = Math.max(0, ...sDn, ...sSt);
  const maxV = Math.max(1, rawMax); // scale floor only — the peak label uses rawMax (0 stays honest)
  const xy = (i: number, v: number): [number, number] =>
    [PAD + (i / Math.max(1, h.length - 1)) * (W - 2 * PAD), H - PAD - (v / maxV) * (H - 2 * PAD)];
  // Catmull-Rom → cubic bezier: a genuinely smooth curve through the smoothed points.
  const curve = (vals: number[]): string => {
    const p = vals.map((v, i) => xy(i, v));
    let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
      d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ` +
        `${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ` +
        `${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  };
  let chart = "";
  if (drawChart) {
    const dnPath = curve(sDn);
    const area = `${dnPath}L${(W - PAD).toFixed(1)},${(H - PAD).toFixed(1)} L${PAD},${(H - PAD).toFixed(1)} Z`;
    const [dotX, dotY] = xy(h.length - 1, sDn[sDn.length - 1]);
    const colW = (W - 2 * PAD) / (h.length - 1);
    // Invisible per-hour hover strips carrying the RAW counts (native SVG <title> tooltips).
    const hovers = h
      .map((b, i) => {
        const hh = String(new Date(b.hourStartMs).getHours()).padStart(2, "0");
        const x = Math.max(0, PAD + (i - 0.5) * colW);
        return `<rect class="qp-hov" x="${x.toFixed(1)}" y="0" width="${colW.toFixed(1)}" height="${H}" fill="transparent"><title>${escAttr(`${hh}:00 — ${b.completed} completed · ${b.started} started · ${b.answered} answered`)}</title></rect>`;
      })
      .join("");
    const grid = [0.25, 0.5, 0.75]
      .map((f) => { const y = (PAD + f * (H - 2 * PAD)).toFixed(1); return `<line x1="${PAD}" x2="${W - PAD}" y1="${y}" y2="${y}" class="qp-grid"/>`; })
      .join("");
    const peak = rawMax > 0 ? `<span class="qp-ymax">peak ~${rawMax % 1 ? rawMax.toFixed(1) : rawMax}/h</span>` : "";
    chart =
      `<div class="qp-chart"><svg class="qp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      grid +
      `<path class="qp-area" d="${area}"/>` +
      `<path class="qp-line st" d="${curve(sSt)}"/>` +
      `<path class="qp-line dn" d="${dnPath}"/>` +
      `<circle class="qp-now-dot" cx="${dotX.toFixed(1)}" cy="${dotY.toFixed(1)}" r="3.5"/>` +
      hovers +
      `</svg>${peak}</div>` +
      `<div class="qp-axis"><span>24h ago</span><span class="qp-legend"><i class="qp-dot dn"></i>completed&nbsp;&nbsp;<i class="qp-dot st"></i>started <span class="qp-smooth-note">· 3h mean</span></span><span>now</span></div>`;
  }

  // ---- completions per tag (ec2 / gpu / data / training / …) — all-time; a session counts
  // toward each of its tags; "untagged" always survives the cap (it's appended last by the
  // server, so a naive slice would drop it exactly when the tag vocabulary fills up).
  const byTag: any[] = t.doneByTag || [];
  const untaggedRow = byTag.find((g: any) => g.tag === "untagged");
  const tags = byTag
    .filter((g: any) => g !== untaggedRow)
    .slice(0, 8)
    .concat(untaggedRow ? [untaggedRow] : [])
    .map((g: any) => {
      const name = String(g.tag); // defensive: a hand-edited tags array can carry non-strings
      return `<span class="qp-tag${name === "untagged" ? " untagged" : ""}" title="${escAttr(`${g.n} completed tasks tagged '${name}'`)}">${esc(name)} <b>${g.n}</b></span>`;
    })
    .join("");

  const latest = (t.recentCompletions || [])
    .slice(0, 3)
    .map((c: any) =>
      `<div class="qp-done-row"><span class="qp-check">✓</span><span class="qp-done-t">${esc(c.title)}</span>` +
      `<span class="qp-done-ago">${esc(timeAgo(new Date(c.atMs).toISOString()))}</span></div>`
    )
    .join("");
  return (
    `<div class="queue-pulse">` +
    `<div class="ss-head">task queue ${pace}<span class="ss-total">${t.completedTotal} completed all-time</span></div>` +
    `<div class="qp-tiles">` +
    tile(t.queuedNow, "in queue now", "", "q") +
    tile(t.completedLastHour, "done · last hour", t.answeredLastHour ? `${t.answeredLastHour} answered` : "", "dn") +
    tile(t.startedLastHour, "started · last hour", "", "st") +
    tile(t.completed24h, "done · 24h", `${t.started24h} started`, "dn") +
    `</div>` +
    chart +
    (tags ? `<div class="qp-tags"><span class="qp-tags-label">done by tag</span>${tags}</div>` : "") +
    (latest ? `<div class="qp-latest">${latest}</div>` : "") +
    `</div>`
  );
}

// Compact time-left until an ISO finish time the session reported via /eta ("~50m", "~2h10m",
// "due now"). Empty string when there's no live ETA. Mirrors core/eta.ts formatTimeLeft.
function timeLeft(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(at)) return "";
  const mins = Math.round((at - Date.now()) / 60000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `~${mins}m`;
  const hh = Math.floor(mins / 60);
  const r = mins % 60;
  return r ? `~${hh}h${r}m` : `~${hh}h`;
}
// Total minutes a reported ETA originally covered, parsed from eta_text ("9m","40m","1h30m","2h").
// Used as the DENOMINATOR for the countdown bar's fraction-remaining. 0 if unparseable.
function etaTotalMin(s: string | null | undefined): number {
  const t = (s || "").trim().toLowerCase();
  if (!t) return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t));
  let total = 0, matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(h|m|d|s)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(t))) { matched = true; const n = parseFloat(m[1]); const u = m[2];
    total += u === "h" ? n * 60 : u === "d" ? n * 1440 : u === "s" ? n / 60 : n; }
  return matched ? Math.round(total) : 0;
}
// Compact "how long this session has been running" from its start time (transcript birth), e.g.
// "45m", "2h", "3h10m", "2d". Empty when unknown. Shown as the roster's "⏱ run-for" badge so a
// long-silent session reads as "been going 3h" rather than only "40m ago" (which is ambiguous
// between idle-for-40m and chugging-for-40m).
function runFor(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(at)) return "";
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  if (h < 24) return r ? `${h}h${r}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
// First non-empty line, trimmed to a sane length — used for the "Needs input" one-liner.
function firstLine(s: string, max = 200): string {
  const t = (s || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
/** Clean an operator prompt for the verbatim "You asked" line: drop Claude Code envelope
 *  tags (system-reminder blocks, <command-*>, <local-command-*>) and collapse whitespace. */
function cleanPrompt(s: string): string {
  return (s || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// FIX B: the card/queue HEADLINE = the operator's own rename when set, else the clean haiku
// title ("oh yeah, this task"), falling back to a cleaned/truncated first-prompt until the
// lazy haiku title is ready.
function sessionHeadline(session: any, max = 60): string {
  const manual = (session && session.manual_title || "").trim();
  if (manual) return manual.length > max ? manual.slice(0, max - 1) + "…" : manual;
  const clean = (session && session.clean_title || "").trim();
  if (clean) return clean;
  const t = (session && session.title || "").replace(/\s+/g, " ").replace(/^["'`@#\s]+/, "").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t || "(session)";
}
// Category chips (haiku-assigned, closed vocabulary — see discover.generateSessionMetaAsync).
// The tag name doubles as the color class, so chips are consistent everywhere they render.
function tagChips(s: any): string {
  let tags: string[] = [];
  try { tags = JSON.parse((s && s.tags) || "[]"); } catch {}
  return tags
    .filter((t: any) => typeof t === "string" && /^[a-z0-9_-]+$/.test(t))
    .slice(0, 2)
    .map((t: string) => `<span class="tagchip tag-${t}" title="category: ${t}">${t}</span>`)
    .join("");
}

// ---------- inline rename ----------
/** Session id being renamed inline, or null. While set, render() is PAUSED — the background
 *  tick re-renders via innerHTML and would destroy the input mid-edit. Editing lasts seconds;
 *  finish() always clears the guard and refreshes. */
let _renamingSid: number | null = null;
/** Swap `host`'s content for an inline <input>: Enter saves the name (manual_title — wins over
 *  every auto name), Esc/blur cancels, saving EMPTY reverts to the auto (haiku) name. */
function startInlineRename(host: HTMLElement, session: any) {
  if (_renamingSid != null || !session || !(session.id > 0)) return;
  _renamingSid = session.id;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = (session.manual_title || session.clean_title || session.title || "").trim();
  input.title = "Enter save · Esc cancel · save empty to revert to the auto name";
  host.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value;
    _renamingSid = null;
    if (save) {
      try { await api.renameSession(session.id, v); } catch {}
      setStatus(v.trim() ? `renamed → ${v.trim().slice(0, 60)}` : "name cleared — back to the auto name");
    }
    await refresh();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing a name must never trigger global hotkeys (master key, undo, …)
    if (e.key === "Enter") { e.preventDefault(); void finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); void finish(false); }
  });
  for (const ev of ["click", "mousedown", "dblclick"]) input.addEventListener(ev, (e) => e.stopPropagation());
  input.addEventListener("blur", () => void finish(false));
}
/** Ctrl+G R: rename the currently-selected session inline, same as clicking the ✎ / the name.
 *  Finds a visible host for the name — the session's queue row, else its roster row, else the
 *  selected detail card's title — and opens the inline editor there. */
function renameSelected() {
  const it = selectedItem();
  const session = it && it.session;
  if (!session || !(session.id > 0)) { setStatus("nothing selected to rename"); return; }
  if (it._team) { setStatus("can't rename a team row"); return; }
  const sid = session.id;
  // Prefer the sid-matched always-present elements (queue row, roster row); fall back to the
  // selected detail card's title when the session is roster-only / shown only in the detail card.
  const host =
    document.querySelector(`#queue .qt[data-sid="${sid}"]`) ||
    document.querySelector(`#sessions li[data-sid="${sid}"] .sess-title`) ||
    document.querySelector(".card-title");
  if (host) startInlineRename(host as HTMLElement, session);
  else setStatus("rename: no visible name to edit");
}
// Strip ANSI/CSI escape sequences so the captured tmux pane is readable in <pre>.
function stripAnsi(s: string): string {
  return (s || "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[()][AB0]/g, "");
}
function setStatus(msg: string) {
  $("status-bar").textContent = msg;
}

async function refresh() {
  S.state = await api.state();
  if (S.sel >= S.state.queue.length) S.sel = Math.max(0, S.state.queue.length - 1);
  render();
}

function selectedItem(): any | null {
  // In the detached detail window the "selection" is the mirrored one, which may be a
  // virtual-top / roster-only session with NO queue item (S.sel falls to 0). Resolve it the same
  // way renderDetail does, so EVERY consumer here — the Merge button, Viewed toggles, the HTML/viz
  // mount — acts on the displayed session, not queue[0]. (Main window: unchanged, index-based.)
  if (IS_DETAIL) return detailResolveItem().it;
  return S.state?.queue?.[S.sel] || null;
}

/** Index of the highest-priority task that ISN'T pinned — i.e. the auto-chosen task to work on.
 *  Pinned items are sticky at the very top (a watchlist that never disappears), but they are NOT
 *  the default selection: the operator works the highest organic task while the pins sit above it.
 *  Falls back to 0 when every task is pinned (or the queue is empty). */
function firstUnpinnedIndex(): number {
  const q = S.state?.queue;
  if (!Array.isArray(q) || !q.length) return 0;
  const i = q.findIndex((it: any) => !(it.session && it.session.pinned));
  return i >= 0 ? i : 0;
}

/** FIX U: selection is IDENTITY-based. `S.selItemId` (the selected item's id) is the source of
 *  truth; `S.sel` (index) is DERIVED from it every render. So when the background tick re-ranks,
 *  a new WAITING task arrives, ensureVirtualTop inserts a top entry, or the active-boost reorders,
 *  the SAME task stays selected — the index follows it. Selection only moves when the user moves
 *  it (nav/click/open) or when the selected item DISAPPEARS (then → nearest neighbor). */
function reconcileSelection() {
  if (!S.state || !Array.isArray(S.state.queue)) return;
  const q = S.state.queue;
  if (!q.length) { S.sel = 0; S.selItemId = null; return; }
  if (S.selItemId != null) {
    const idx = q.findIndex((it: any) => it.id === S.selItemId);
    if (idx >= 0) { S.sel = idx; return; } // FOLLOW the selected task as the queue reorders
    // selected item is GONE (resolved/dismissed/completed) → nearest neighbor by prior index.
    S.sel = Math.max(0, Math.min(q.length - 1, S.sel));
    S.selItemId = q[S.sel] ? q[S.sel].id : null;
    return;
  }
  // No explicit selection yet → default to the highest UNPINNED task. Pins are sticky headers at
  // the very top, not the auto-chosen work item.
  S.sel = firstUnpinnedIndex();
  S.selItemId = q[S.sel] ? q[S.sel].id : null;
}

/** FIX DD: set ONLY by explicit user navigation (selectIndex) → consumed once by renderQueue to
 *  scrollIntoView the focused row. Background tick re-renders never set it, so they never scroll. */
let _navScroll = false;
// Overview rows ("Goal/Next/Recap/You asked") clamp long text to a few lines; clicking a row toggles
// its full text. Keyed "itemId:field" so the expanded state survives background re-renders.
const _ovExpanded = new Set<string>();

/** FIX LL: set ONLY by explicit user navigation (selectIndex). Consumed once by renderPanes to
 *  permit resetting focus to the new task's default pane. Background ticks never set it, so a
 *  background-driven item change can NEVER move focus off a terminal the operator is working in. */
let _navFocus = false;

/** Explicit USER selection by index (nav/click/jump): sets BOTH the index and the identity. */
function selectIndex(i: number) {
  if (!S.state || !Array.isArray(S.state.queue) || !S.state.queue.length) { S.sel = 0; S.selItemId = null; return; }
  S.sel = Math.max(0, Math.min(S.state.queue.length - 1, i));
  const it = S.state.queue[S.sel];
  S.selItemId = it ? it.id : null;
  // FIX: the terminal follows an explicit task pick. Release the pin to a previously-opened
  // session when the user selects a DIFFERENT session's task — otherwise the terminal stays
  // stuck on the old session. (Keep it for the virtual-top entry, whose session_id IS the pin.)
  if (it && _termOverride != null && it.session_id !== _termOverride) _termOverride = null;
  _navScroll = true; // FIX DD: explicit nav → allow one scrollIntoView this render
  _navFocus = true;  // FIX LL: explicit nav MAY reset focus to the new task (background ticks can't)
  _termTypedSinceNav = false; // TYPE-AWARE NAV: a fresh landing re-arms plain ↑/↓ as queue nav
}

/** FIX O: the visualization HTML files for the currently-active session (selected item, else the
 *  pinned terminal session). Empty unless a matching viz folder exists. */
/** The viz (task HTML) list for a specific session id (from /api/state). */
function sessionVizFor(sid: number | null): { name: string; file: string; mtime: number }[] {
  if (sid == null || !S.state) return [];
  const e = (S.state.sessions || []).find((s: any) => s.row && s.row.id === sid);
  return (e && e.viz) || [];
}
function currentViz(): { name: string; file: string; mtime: number }[] {
  const it = selectedItem();
  return sessionVizFor(it ? it.session.id : (_termOverride ?? null));
}

/** FIX M: when the operator opens a terminal on a session that has NO queue item (roster-only:
 *  a resumed/taken-over session), inject a SELECTABLE virtual "up next" entry for it at the TOP
 *  of the queue. This makes BOTH panes (A overview + B terminal) about the SAME opened session —
 *  instead of pane A still showing the previously-selected DIFFERENT task underneath. Idempotent:
 *  removes any prior virtual entry first, re-injects only if still needed. */
function ensureVirtualTop() {
  if (!S.state || !Array.isArray(S.state.queue)) return;
  S.state.queue = S.state.queue.filter((q: any) => !q._virtual);
  if (_termOverride == null) return;
  if (S.state.queue.some((q: any) => q.session_id === _termOverride)) return; // a REAL item exists
  const row = overrideSessionRow();
  if (!row) return;
  // Sit just above the current highest organic task — a readable number, not 9,999,999.
  const maxOrganic = S.state.queue.reduce((m: number, q: any) => (q.priority < PIN_BASE && q.priority > m ? q.priority : m), 0);
  S.state.queue.unshift({
    id: -1_000_000 - row.id, session_id: row.id, session: row, _virtual: true,
    category: "● active", state: row.state, status: "pending",
    one_liner: "open in terminal — you're working on this",
    question: "", suggested_answer: "", changed_lines: 0, priority: maxOrganic + 5,
    score_breakdown: {}, default_view: "summary",
  });
}

function answerInputFocused(): boolean {
  const el = document.getElementById("answer-input");
  return !!el && document.activeElement === el;
}

// 2026-06-29: switched candidate-answer keys from A/B/C/D to 1/2/3/4 at operator request — A
// in the empty answer box used to fire the option-pick AND start typing text starting with "A",
// which felt like the input was eating his keys. Digits never collide with normal English prose.
const LETTERS = ["1", "2", "3", "4"];
const PIN_BASE = 100000; // mirror of priority.ts — pinned items get this base added
/** Display priority: pinned items show 📌 + their REAL underlying score (not 100152). */
function dispPriority(it: any): string {
  return it.session && it.session.pinned ? `📌 ${it.priority - PIN_BASE}` : `${it.priority}`;
}
function isAnswerable(it: any): boolean {
  return !!it && it.session.kind !== "pr" && (it.category === "SIMPLE_QUESTION" || it.category === "COMPLEX_DECISION");
}
interface AnswerOption { key: string; label: string; text: string; }
function optionsFor(it: any): AnswerOption[] {
  let raw: any[] = [];
  try {
    if (it.answer_options) raw = JSON.parse(it.answer_options) || [];
  } catch {}
  if (!Array.isArray(raw)) raw = [];
  const out: AnswerOption[] = [];
  // 2026-06-29: ignore whatever .key the enrichment proposed (it usually says "A"/"B"/…). The
  // visible key is ALWAYS the position-based digit (1/2/3/4) so the empty-box hotkey matches what
  // the operator sees on the chip. This means a stale enrichment with letter keys still picks
  // cleanly with 1/2/3/4 instead of leaving dead chips labelled "A" with no working hotkey.
  raw.forEach((o, i) => {
    if (o && typeof o === "object" && o.text) out.push({ key: LETTERS[i], label: LETTERS[i], text: o.text });
    else if (typeof o === "string" && o.trim()) out.push({ key: LETTERS[i], label: LETTERS[i], text: o.trim() });
  });
  if (!out.length && it.suggested_answer) out.push({ key: "1", label: "1", text: it.suggested_answer });
  return out.slice(0, 4);
}
function optionKeys(it: any): string[] {
  return optionsFor(it).map((o) => o.key.toLowerCase());
}

function render() {
  const st = S.state;
  if (!st) return;
  if (_renamingSid != null) return; // inline rename in progress — don't destroy the input mid-edit
  try { (window as any).cockpitRender = render; (window as any).cockpitS = S; } catch {} // debug/test hooks (focus-flicker regression; pane-layout state assertions)
  ensureVirtualTop(); // FIX M: inject the opened roster-only session as a top selectable entry
  reconcileSelection(); // FIX U: re-derive S.sel from the selected item's IDENTITY (never drift)
  broadcastSel(); // mirror the selected task to the detached Diff/HTML window (no-op in detail mode)
  const banner = $("demo-banner");
  if (banner) banner.style.display = st.demo ? "block" : "none";
  if (st.demo) document.body.classList.add("demo");
  $("focus-val").textContent = st.focus || "(none)";
  const cc: Record<string, number> = {};
  for (const s of st.sessions) cc[s.row.state] = (cc[s.row.state] || 0) + 1;
  $("counts").innerHTML = ["WAITING_INPUT", "DONE", "WORKING", "UNKNOWN"]
    .map((k) => `<span class="pill"><span class="dot ${k}"></span> ${k.replace("_", " ").toLowerCase()}: ${cc[k] || 0}</span>`)
    .join("");

  renderQueue();
  renderPanes();
  renderSessions();
  renderWeights();
  // FIX AA: stamp the running build hash in the header so a stale renderer shows in a screenshot.
  const bm = document.getElementById("build-marker");
  if (bm && st.config && (st.config as any).build) bm.textContent = (st.config as any).build;
}

// ===================== TWO-PANE WORKING AREA =====================
const A_TABS: PaneView[] = ["overview", "terminal", "diff"];
const B_TABS: PaneView[] = ["terminal", "diff"];
function paneDefault(P: "A" | "B", it: any): PaneView {
  // STANDARD LAYOUT (operator request 2026-06-11): EVERY task lands as Overview (A) | Terminal (B)
  // — PR/review tasks included. Diff/HTML live in the detached detail window; the operator can
  // still switch either pane manually (o/h/t/d), which sticks while staying on the same task.
  void it; // kept in the signature so callers stay uniform (defaultFocus passes it through)
  return P === "A" ? "overview" : "terminal";
}
function isDiffable(it: any): boolean {
  // Diff is available for PR/review tasks AND any session with a real worktree branch
  // (branch-vs-base diff). Kanban backfill rows have no worktree → not diffable.
  return !!it && (it.session.kind === "pr" || it.category === "REVIEW_DIFF" || (it.session.kind !== "kanban" && !!it.session.branch));
}

/** DEFAULT FOCUS — TERMINAL-FIRST (operator request 2026-06-10): landing on a new task focuses
 *  Pane B's TERMINAL, so typing goes straight to the session with zero keystrokes of setup.
 *  Plain ↑/↓ walk the queue on a fresh landing (intercepted before the pty) and hand over to
 *  the pty once the operator types (TYPE-AWARE NAV, _termTypedSinceNav); every other cockpit
 *  action sits behind the master key. With the STANDARD LAYOUT pane B always defaults to
 *  Terminal, so a fresh landing always focuses B; the A-branch stays for safety. */
function defaultFocus(it: any): "A" | "B" {
  return paneDefault("B", it) === "terminal" ? "B" : "A";
}

/** Master pane render. Detects a task change → resets non-manually-overridden panes to
 *  their defaults (and clears stale diff/terminal content). */
/** FIX K: the session backing the current view when there's no queue item — i.e. an explicitly
 *  opened terminal (resume / take-over / new session). Lets the layout render the SAME two-pane
 *  task view (overview left + terminal right) for a roster-only session, not a broken empty view. */
function overrideSessionRow(): any | null {
  if (_termOverride == null || !S.state) return null;
  const e = (S.state.sessions || []).find((s: any) => s.row && s.row.id === _termOverride);
  return e ? e.row : null;
}

function renderPanes() {
  const it = selectedItem();
  const ov = !it ? overrideSessionRow() : null; // FIX K: terminal-only session context
  // Task changed → reset panes (unless the operator manually set one) + clear stale state. FIX U:
  // use a SEPARATE "what's rendered" tracker (_renderedItemId), NOT the selection identity — the
  // pane reset must fire only when the user navigates to a different task, never just because the
  // background reorder shifted indices (the selection itself is pinned by reconcileSelection).
  if (it && _renderedItemId !== it.id) {
    _renderedItemId = it.id;
    // FIX LL — STICKY TERMINAL FOCUS. If the operator is actively in a terminal and this item
    // change was NOT an explicit navigation (i.e. a background tick re-ranked, the pinned task
    // vanished, or a new WAITING task arrived → selection moved), DO NOT yank them out: leave the
    // focused terminal pane's view AND keyboard focus untouched. Only an explicit user nav
    // (selectIndex → _navFocus) resets focus to the new task's default (pane A). Background paths
    // must never move S.focused off the terminal.
    const stickTerm = !_navFocus && S.panes[S.focused] === "terminal";
    // STANDARD LAYOUT: an EXPLICIT nav to a different task always lands on the default
    // Overview | Terminal — a manual pane choice made on the PREVIOUS task must not leak into
    // this one (it used to: paneManual persisted forever → "html left / diff right" landings).
    // Background re-ranks (!_navFocus) keep manual choices and the sticky terminal untouched.
    if (_navFocus) { S.paneManual.A = false; S.paneManual.B = false; }
    for (const P of ["A", "B"] as const) {
      if (stickTerm && P === S.focused) continue; // leave the focused terminal pane intact
      if (!S.paneManual[P]) S.panes[P] = paneDefault(P, it);
      // if a pane is showing diff/terminal but the item can't (e.g. non-PR diff), fall to default
      if (S.panes[P] === "diff" && !isDiffable(it)) S.panes[P] = P === "A" ? "overview" : "terminal";
      S.paneItem[P] = null; // force a fresh content render for the new item
      S.diffPatch[P] = "";
    }
    // SMART DEFAULT FOCUS — fresh landing on a task (explicit nav only); manual focus from the
    // previous task does not carry over. When sticking to a terminal, focus stays put (FIX LL).
    if (!stickTerm) S.focused = defaultFocus(it);
    // CONTEXT-AWARE WIDTHS — re-apply the per-mode A|B split (PR → wider diff) for the new task.
    // (the ResizeObserver refits the terminal if this actually changes the host box)
    applyPaneWidths();
    S.autoDiffed.clear();
    // STANDARD LAYOUT: arriving at a task that ALREADY has an html visualization must still land
    // Overview | Terminal — seed autoVized with the current viz count so auto-html below only
    // fires for a NEW html written while the operator is looking at this task.
    const viz0 = it.session ? sessionVizFor(it.session.id) : [];
    if (viz0.length) S.autoVized.add(`${it.session.id}:${viz0.length}`);
    // NEWEST-FIRST: viz is sorted newest→oldest (viz.ts), so landing on a task always opens its
    // LATEST html (tab 0). Resetting here stops a tab index chosen on the PREVIOUS task from leaking.
    if (_navFocus) S.vizTab = 0;
  } else if (!it) {
    _renderedItemId = null;
  }
  // AUTO-HTML (config auto_html_on_viz, default ON): when a session WRITES a NEW html
  // visualization while its task is in view, surface it in the LEFT pane (A) automatically, so
  // "Claude made an html" → "I see the html" with no keystroke. Keyed by sessionId:vizCount;
  // the task-change block above pre-seeds the key, so an html that already existed when the
  // operator NAVIGATED here never fires it (STANDARD LAYOUT: every landing = Overview | Terminal).
  // Respects a manual pane-A override (you switched to overview/diff → we leave it) and never
  // touches S.focused, so it can't yank you out of the terminal you're typing in (it only swaps
  // pane A's CONTENT). Mirrors auto_diff_on_pr_review.
  if (it && (S.state?.config as any)?.auto_html_on_viz !== false && !S.paneManual.A && S.panes.A !== "html") {
    const viz = sessionVizFor(it.session.id);
    const key = `${it.session.id}:${viz.length}`;
    if (viz.length && !S.autoVized.has(key)) {
      S.autoVized.add(key);
      S.panes.A = "html";
      S.vizTab = 0; // jump to the newest tab — viz is sorted newest-first (viz.ts), so 0 = just written
      S.paneItem.A = null;
    }
  }
  for (const P of ["A", "B"] as const) renderPane(P);
  // FIX K: a terminal-only session (resume/take-over, no queue item) is a REAL view — hide the
  // empty-state so it renders as the normal two-pane task layout, not a tiny broken window.
  const termPinned = S.panes.A === "terminal" || S.panes.B === "terminal" || _termOverride != null;
  $("empty-state").style.display = (it || ov || termPinned) ? "none" : "block";
  // keep exactly one pane hosting the terminal
  reconcileTerminal();
  // keep the real keyboard target in lock-step with the visible focus. FIX LL: this re-asserts
  // term.focus() every render whenever the focused pane shows the terminal, so a re-render that
  // momentarily blurred the xterm immediately restores keyboard focus to it.
  applyKeyboardTarget();
  _navFocus = false; // FIX LL: nav-intent is consumed once; subsequent background renders can't steal focus
}

function renderPane(P: "A" | "B") {
  const it = selectedItem();
  const body = $(`pane-${P}-body`);
  const view = S.panes[P];
  // ONE MODE PER PANE: the body holds exactly one mode's DOM. For terminal the body becomes
  // a flex column hosting ONLY the term-host (so the xterm fills the FULL pane height); for
  // every other mode the term-host is rescued out and the body's innerHTML is replaced.
  body.classList.toggle("pane-body--term", view === "terminal");
  body.classList.toggle("pane-body--html", view === "html"); // FIX O: full-bleed iframe
  // FIX O: the HTML tab (pane A) is shown ONLY when this session has a visualization folder.
  if (P === "A") {
    const htmlTab = document.querySelector('.pane-tabs[data-tabs="A"] .tab-html') as HTMLElement | null;
    if (htmlTab) htmlTab.style.display = currentViz().length ? "" : "none";
  }
  // active tab + focus ring + "typing here" badge
  document.querySelectorAll(`.pane-tabs[data-tabs="${P}"] .tab`).forEach((el) =>
    el.classList.toggle("active", (el as HTMLElement).dataset.mode === view));
  const focused = S.focused === P;
  $(`pane-${P}`).classList.toggle("focused", focused);
  $(`pane-${P}`).classList.toggle("unfocused", !focused);
  const badge = document.getElementById(`pane-${P}-actions`);
  if (badge) badge.innerHTML = focused
    ? `<span class="focus-badge">✍ ${view === "terminal" ? "typing → terminal" : view === "overview" ? "typing → answer" : "active"}</span>`
    : "";
  const host = $("term-host");
  if (view === "terminal") {
    // Strip any STALE content (old diff/overview) so it can't stack OVER the terminal.
    Array.from(body.children).forEach((c) => { if (c !== host) c.remove(); });
    return; // reconcileTerminal mounts/moves the single term-host here
  }
  // Non-terminal mode: rescue the movable term-host out of this body before overwriting it.
  if (host.parentElement === body) { host.style.display = "none"; $("main").appendChild(host); }
  // FIX O: HTML visualization view (works for a selected item OR a terminal-only override session).
  if (view === "html") { renderHtmlInto(body, P); return; }
  if (!it) {
    // FIX K: no queue item but an explicitly-opened terminal session → render a minimal session
    // overview on the LEFT (so it's the normal two-pane task view, not "No task selected").
    const ov = overrideSessionRow();
    if (ov && view === "overview") { renderSessionOnlyOverview(body, ov); S.paneItem[P] = -1; return; }
    body.innerHTML = `<div class="empty">No task selected.</div>`;
    return;
  }
  if (view === "overview") {
    // FIX M: a virtual (terminal-only) entry has no real item content → minimal session overview.
    if (it._virtual) { renderSessionOnlyOverview(body, it.session); S.paneItem[P] = it.id; return; }
    const keepTyping = P === S.focused && answerInputFocused() && S.paneItem[P] === it.id;
    if (!keepTyping) { renderOverviewInto(body, it, P); S.paneItem[P] = it.id; }
    return;
  }
  if (view === "diff") {
    if (S.paneItem[P] !== it.id) { S.paneItem[P] = it.id; loadDiffInto(P, it); }
    return;
  }
}

/** Switch a pane's view (manual=true means the operator chose it → don't auto-yank later). */
function setPaneView(P: "A" | "B", view: PaneView, manual = true) {
  // "html" is pane-A only and ALLOWED even though it's not a default cycle tab (opt-in via Ctrl+G h
  // / the HTML tab) — but only when the session actually HAS a visualization.
  if (view === "html") {
    if (P !== "A" || !currentViz().length) { setStatus("no visualization for this task"); return; }
  } else {
    if (P === "A" && !A_TABS.includes(view)) return;
    if (P === "B" && !B_TABS.includes(view)) return;
  }
  const it = selectedItem();
  if (view === "diff" && !isDiffable(it)) { setStatus("No diff: this task has no PR and no git branch"); return; }
  // single terminal: if this pane takes terminal, kick the OTHER pane off terminal.
  if (view === "terminal") {
    const other = P === "A" ? "B" : "A";
    if (S.panes[other] === "terminal") { S.panes[other] = paneDefault(other, it); S.paneItem[other] = null; }
  }
  S.panes[P] = view;
  S.paneManual[P] = manual;
  S.paneItem[P] = null;
  S.focused = P;
  renderPanes();
  applyPaneWidths(); // mode may have changed (B→diff widens the diff); RO refits the terminal
  applyKeyboardTarget();
}

function focusPane(P: "A" | "B") {
  // FIX: a click anywhere in a pane fires this via the section mousedown. If the pane is ALREADY
  // focused, do NOT re-render — otherwise every click inside the Diff pane (incl. the "Viewed"
  // button) used to blow away and reload the whole diff ("loading diff…"), racing/eating the click.
  // Just re-assert the keyboard target and return.
  if (S.focused === P) { applyKeyboardTarget(); return; }
  S.focused = P;
  // DECORATION-ONLY refresh (terminal-first fix): this runs on the pane's MOUSEDOWN, so it must
  // NOT rebuild pane content — replacing the DOM between mousedown and mouseup makes the browser
  // swallow the CLICK entirely (the "clicking an answer chip did nothing" bug: with the terminal
  // focused by default, the first click into pane A re-rendered it and ate the chip click).
  // Only the focus ring / badge / keyboard target change here; content (incl. a loaded diff,
  // its scroll position and Viewed state) is untouched.
  for (const Q of ["A", "B"] as const) {
    const focused = S.focused === Q;
    $(`pane-${Q}`).classList.toggle("focused", focused);
    $(`pane-${Q}`).classList.toggle("unfocused", !focused);
    const badge = document.getElementById(`pane-${Q}-actions`);
    if (badge) badge.innerHTML = focused
      ? `<span class="focus-badge">✍ ${S.panes[Q] === "terminal" ? "typing → terminal" : S.panes[Q] === "overview" ? "typing → answer" : "active"}</span>`
      : "";
  }
  applyKeyboardTarget();
}
function toggleFocus() { focusPane(S.focused === "A" ? "B" : "A"); }

/** SINGLE SOURCE OF TRUTH for "where do keystrokes land". The focus indicator (border +
 *  badge) and the real keyboard target are driven by the SAME S.focused/S.panes state:
 *   • focused pane = Terminal → the xterm holds keyboard focus (keys → PTY); answer box blurred.
 *   • focused pane = Overview → the answer box holds focus (keys → box); the xterm is BLURRED
 *     so it can't silently swallow keystrokes (the classic "indicator says Overview but typing
 *     goes to the terminal" bug).
 *   • focused pane = Diff/Transcript → xterm blurred, no input focused. */
function applyKeyboardTarget() {
  // FIX QP: while an overlay (quick prompt / focus / edit / import / merge) is open, its own input
  // owns the keyboard. Do NOT touch focus here — otherwise a background render tick lands in this
  // function and calls term.focus() below (when the overlay sits over a terminal pane), yanking
  // focus out of the overlay textarea. The textarea's blur handler refocuses on setTimeout(0), but
  // any keystroke in that gap leaks into the terminal behind — the "every ~Nth letter types into
  // the terminal" flicker, paced by the render tick. Leaving early keeps the overlay input focused.
  if (overlayOpen()) return;
  const fv = S.panes[S.focused];
  const term = S.term;
  const inp = document.getElementById("answer-input") as HTMLTextAreaElement | null;
  if (fv === "terminal") {
    if (inp) inp.blur();
    try { term && term.focus(); } catch {}
  } else {
    // A non-terminal view is focused → the xterm must NOT keep keyboard focus.
    try { term && term.blur(); } catch {}
    if (fv === "overview" && S.focused === "A" && inp && !overlayOpen()) inp.focus();
  }
}

function renderQueue() {
  const st = S.state;
  // FIX DD: capture scroll BEFORE the innerHTML rebuild so a background tick never yanks Up Next to
  // the top. Preserve whichever element actually scrolls (the list and its column).
  const ql = $("queue");
  const col = document.getElementById("queue-col");
  const prevQ = ql ? ql.scrollTop : 0;
  const prevCol = col ? col.scrollTop : 0;
  $("queue-count").textContent = `(${st.queue.length})`;
  $("queue").innerHTML = st.queue
    .map(
      (it: any, i: number) => {
      const s = it.session;
      const pin = s.pinned ? '<span class="badge pin" title="pinned">📌</span>' : "";
      const man = s.manual_importance != null ? `<span class="badge man" title="manual importance">${s.manual_importance}</span>` : "";
      const snzEff = s.snooze_effective ?? s.snooze_penalty; // live decayed value (climbs back to 0)
      const snz = s.snooze_penalty < 0 && snzEff < 0 ? `<span class="badge snz" title="snoozed — penalty decays linearly back to 0, item climbs back up">💤 ${Math.round(snzEff)}</span>` : "";
      // any card with an open PR attached gets the badge — standalone pr-cards AND working/terminal
      // sessions the scan tagged (same condition that renders the merge button / Ctrl+G M).
      const pr = s.pr_repo && s.pr_number ? `<span class="badge pr" title="open GitHub PR — M to merge">PR #${s.pr_number}</span>` : "";
      const kan = s.kind === "kanban" ? '<span class="badge kan" title="kanban backfill">KAN</span>' : "";
      const team = it._team ? `<span class="badge team" title="Claude Code team — teammates listed below">team ·${(it.children || []).length}</span>` : "";
      const prioCell = it._virtual ? '<span class="p" title="active terminal">●</span>' : it._team ? '<span class="p" title="team — informational">·</span>' : `<span class="p">${dispPriority(it)}</span>`;
      // TEAM-GROUP rows append one display-only child line per teammate (not selectable, no data-i).
      const kids = it._team
        ? (it.children || []).map((c: any) => {
            const lbl = c.state === "WORKING" ? "busy" : c.state === "DONE" ? "done" : c.state === "WAITING_INPUT" ? "waiting" : "idle";
            return `<div class="child"><span class="ct">└ ${esc(c.agent_name)}</span><span class="cs ${lbl}">${lbl}</span></div>`;
          }).join("")
        : "";
      // Rename affordance only for REAL sessions (team rows are synthetic, nothing to rename).
      const renameBtn = it._team ? "" : `<span class="rename-btn" data-sid="${s.id}" title="rename (or double-click the name)">✎</span>`;
      // Status dot — shows what Claude tagged this card (waiting/done/etc.); click or right-click the
      // card to correct it. Team rows are synthetic (their children carry per-teammate status).
      const stateDot = it._team ? "" : `<span class="dot ${s.state} statedot" data-sid="${s.id}" title="status: ${String(s.state || "UNKNOWN").replace("_", " ").toLowerCase()} — click to change"></span> `;
      return `
    <li class="${i === S.sel ? "sel" : ""} ${it._virtual ? "virtual" : ""} ${it._team ? "team" : ""}" data-i="${i}" data-sid="${s.id}">
      <div class="row1"><span class="t">${i + 1}. ${stateDot}${pin}${pr}${kan}${team}${man}${snz} <span class="qt" data-sid="${s.id}">${esc(sessionHeadline(s, 44))}</span>${renameBtn}${tagChips(s)}</span>${prioCell}</div>
      <div class="c">${esc(it.category || "")} · ${esc(it.one_liner || "")}</div>${kids}
    </li>`;
    }
    )
    .join("");
  document.querySelectorAll("#queue li").forEach((el) => {
    el.addEventListener("click", () => {
      selectIndex(parseInt((el as HTMLElement).dataset.i!, 10)); // FIX U: explicit user selection
      render();
    });
    // Right-click a card → status menu (skip synthetic team rows: no single session behind them).
    el.addEventListener("contextmenu", (e) => {
      const sid = parseInt((el as HTMLElement).dataset.sid || "", 10);
      if (!sid) return;
      const it = S.state.queue[parseInt((el as HTMLElement).dataset.i!, 10)];
      if (it && it._team) return;
      e.preventDefault();
      showStateMenu(sid, it?.session?.state || "UNKNOWN", (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    });
  });
  // Left-click the status dot → same menu (the operator "presses the status of the card").
  document.querySelectorAll("#queue .statedot").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const sid = parseInt((el as HTMLElement).dataset.sid!, 10);
      const cur = (el.className.match(/dot (\w+)/) || [])[1] || "UNKNOWN";
      showStateMenu(sid, cur, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    })
  );
  // Inline rename: ✎ click or double-click the name. The session comes from the row's queue item.
  const queueRename = (el: HTMLElement) => {
    const i = parseInt((el.closest("li") as HTMLElement)?.dataset.i || "", 10);
    const it = S.state.queue[i];
    const host = el.closest(".row1")?.querySelector(".qt") as HTMLElement | null;
    if (it && !it._team && it.session && host) startInlineRename(host, it.session);
  };
  document.querySelectorAll("#queue .rename-btn").forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); queueRename(el as HTMLElement); })
  );
  document.querySelectorAll("#queue .qt").forEach((el) =>
    el.addEventListener("dblclick", (e) => { e.stopPropagation(); queueRename(el as HTMLElement); })
  );
  // FIX DD: restore scroll (a background re-render must NOT move the operator's position)…
  if (ql) ql.scrollTop = prevQ;
  if (col) col.scrollTop = prevCol;
  // …and ONLY scroll the focused row into view when the user JUST navigated (explicit nav set the
  // flag); never on a tick/background render.
  if (_navScroll) {
    _navScroll = false;
    const selEl = document.querySelector("#queue li.sel") as HTMLElement | null;
    if (selEl) selEl.scrollIntoView({ block: "nearest" });
  }
}

/** Render the Overview card for `it` into pane body `el`. */
function renderOverviewInto(el: HTMLElement, it: any, P: "A" | "B") {
  const card = el;
  const km = S.keymap;
  // TEAM-GROUP card: informational only — a teammate roster with live status. No answer box,
  // no actions (the synthetic session id is not a real session; nothing to send input to).
  if (it._team) {
    const kids = (it.children || []).map((c: any) => {
      const lbl = c.state === "WORKING" ? "busy" : c.state === "DONE" ? "done" : c.state === "WAITING_INPUT" ? "waiting" : "idle";
      return `<div class="child"><span class="ct">└ ${esc(c.agent_name)}</span><span class="cs ${lbl}">${lbl}</span></div>`;
    }).join("");
    card.innerHTML =
      `<h1><span class="badge team">team ·${(it.children || []).length}</span> ${esc(it.session.title || "")}</h1>` +
      `<p class="brief-context">${esc(it.one_liner || "")}</p>` +
      `<div class="team-roster">${kids}</div>` +
      `<p class="brief-context" style="opacity:.6">Teammates are sub-agents of a Claude Code team — they report to their team-lead, not to you.</p>`;
    return;
  }
  const isPr = it.session.kind === "pr";
  const isKanban = it.session.kind === "kanban";
  // The card title (h1) + question render INSTANTLY; while the one-combined-call
  // enrichment is still in flight (enriched===0) we show a small placeholder badge
  // and the options/one-liner fill in on the next tick. Never blocks the card.
  const enriching = !isPr && !isKanban && it.enriched === 0;
  const enrichBadge = enriching ? `<span class="enriching">⏳ enriching…</span> ` : "";
  // A reusable written-brief block: the operator reads THIS instead of the transcript.
  //   • CONTEXT — 2-3 sentences (enrich `context`, fallback one_liner)
  //   • NEEDS INPUT — the specific ask, or an FYI marker when nothing is needed
  // Alternatives (answer options) render below as their own compact chips.
  const briefBlock = (needLabel: string, needText: string, fyi = false) => {
    const ctx = (it.context && it.context.trim()) || it.one_liner || "";
    return (
      `<div class="brief">` +
      (ctx ? `<p class="brief-context">${enrichBadge}${esc(ctx)}</p>` : (enriching ? `<p class="brief-context">${enrichBadge}</p>` : "")) +
      `<div class="brief-need ${fyi ? "fyi" : ""}"><span class="brief-need-label">${esc(needLabel)}</span><span class="brief-need-text">${needText}</span></div>` +
      `</div>`
    );
  };

  // The MINIMAL overview header: a RECAP of where the session stands + the operator's most
  // recent prompt ("You asked"). The operator reads these two lines instead of the transcript.
  //   • Recap     — it.context (1-2 sentences, Claude's status) — falls back to one_liner.
  //   • You asked  — it.prompt_summary when the prompt was long, else the verbatim prompt
  //                  (cleaned + truncated, full text on hover). Omitted when we have nothing.
  const recapBlock = () => {
    const recap = (it.context && it.context.trim()) || it.one_liner || "";
    // Each row CLAMPS to a few lines and is click-to-expand (a long prompt/recap no longer needs the
    // transcript or a hover-tooltip to read in full). `valHtml` is already-escaped inner HTML.
    const ovRow = (label: string, valHtml: string, field: string, extraCls = "") => {
      const key = `${it.id}:${field}`;
      const expanded = _ovExpanded.has(key);
      const cls = `ov-val ${extraCls} ${expanded ? "ov-expanded" : "ov-clamp"}`.trim();
      return `<div class="ov-row ov-expandable" data-ovkey="${esc(key)}" title="click to ${expanded ? "collapse" : "expand"}"><span class="ov-label">${label}</span><span class="${cls}">${valHtml}</span></div>`;
    };
    // Goal/Next context (see enrich.ts CONTEXT_RULE) renders as two labeled rows; anything
    // else (older cached items, one_liner fallback) keeps the single Recap row.
    const gn = recap.match(/^Goal:\s*([\s\S]*?)\s*\bNext:\s*([\s\S]*)$/i);
    const recapRow = gn
      ? ovRow("Goal", enrichBadge + esc(gn[1].trim()), "goal") + ovRow("Next", esc(gn[2].trim()), "next")
      : recap || enriching
        ? ovRow("Recap", enrichBadge + esc(recap), "recap")
        : "";
    let askRow = "";
    if (it.prompt_summary && it.prompt_summary.trim()) {
      askRow = ovRow("You asked", esc(it.prompt_summary.trim()), "ask", "ov-ask");
    } else {
      const full = cleanPrompt(it.last_prompt || "");
      if (full) askRow = ovRow("You asked", `“${esc(full)}”`, "ask", "ov-ask");
    }
    return `<div class="ov">${recapRow}${askRow}</div>`;
  };

  let body = "";
  if (isKanban) {
    const startable = it.session.kanban_startable === 1;
    let qs: string[] = [];
    try { qs = JSON.parse(it.session.kanban_questions || "[]"); } catch {}
    const desc = `<div class="kanban-desc">${esc((it.question || it.one_liner || "").slice(0, 1200))}</div>`;
    if (startable) {
      body = desc + `<div class="kanban-status startable">✅ STARTABLE — enough context to begin</div>`;
    } else {
      body = desc + `<div class="kanban-status needsinfo">❓ NEEDS-INFO — answer to make it startable</div>` +
        `<div class="kanban-qs">` +
        qs.map((q, i) => `<div class="kanban-q"><div class="kanban-qtext">${i + 1}. ${esc(q)}</div><input class="kanban-ans" data-qi="${i}" type="text" placeholder="your answer…" /></div>`).join("") +
        `</div>`;
    }
  } else if (isPr) {
    const s = it.session;
    const branches = s.pr_head_ref && s.pr_base_ref
      ? `<div class="pr-branches"><span class="pr-ref head">${esc(s.pr_head_ref)}</span> <span class="pr-arrow">→</span> <span class="pr-ref base">${esc(s.pr_base_ref)}</span>${s.pr_review_decision === "merged" ? ' <span class="rv green">✅ merged</span>' : ""}</div>`
      : "";
    body =
      briefBlock("Needs review", "view the diff, then merge or send feedback") +
      branches +
      (s.pr_url ? `<div class="meta dim">${esc(s.pr_url)}</div>` : "") +
      renderPrReviews(it);
  } else if (it.category === "FYI_DONE") {
    body = recapBlock() + `<div class="ov-note fyi">Nothing needed — acknowledge to clear.</div>`;
  } else if (it.category === "REVIEW_DIFF") {
    body =
      recapBlock() +
      `<div class="ov-note">${it.changed_lines} changed lines — review the diff.</div>` +
      `<pre class="diff">${colorDiff(it.diff_summary || "(no summary)")}</pre>`;
  } else {
    // SIMPLE_QUESTION or COMPLEX_DECISION — the answerable card: recap + "you asked", then the
    // candidate answers (A is the recommendation; ↵ sends it), then a free-type box. Picking A/B/C
    // or typing your own is captured by the answer-quality loop and improves future suggestions.
    const opts = optionsFor(it);
    const answers = opts.length
      ? `<div class="answers">` +
        opts
          .map((o, i) => {
            const key = o.label.length <= 1 ? o.label : o.key.toUpperCase();
            const rec = i === 0;
            return (
              `<div class="ans${rec ? " recommended" : ""}" data-opt="${i}" title="${esc(o.text)}">` +
              `<span class="anskey">${rec ? "↵ " : ""}${esc(key)}</span>` +
              `<span class="anstext">${esc(o.text)}</span>` +
              (rec ? `<span class="ans-rec">★ recommended</span>` : "") +
              `</div>`
            );
          })
          .join("") +
        `</div>`
      : enriching
      ? `<div class="ov-enriching">drafting suggested answers…</div>`
      : "";
    body =
      recapBlock() +
      answers +
      `<div class="answer-row">` +
      `<textarea id="answer-input" class="answer-input" rows="1" placeholder="type your own answer · Enter send · Ctrl+Enter newline"></textarea>` +
      `</div>`;
  }

  // Tiny, muted, INFO-ONLY hotkey hints — just the key, full meaning on hover (title).
  // Action keys are GATED behind the master (Ctrl+G) — show them prefixed so the hint is honest.
  const hk = (key: string, desc: string, cls = "") => `<span class="hk ${cls}" title="${esc(desc)}"><kbd>${esc(key)}</kbd></span>`;
  const mk = (key: string, desc: string, cls = "") => hk(`${masterLabel()} ${key}`, desc, cls);
  const acts = (
    isKanban
      ? (it.session.kanban_startable === 1
          ? [hk(km.accept_answer, "Start a real Claude session for this task (confirm)", "kanbtn"), mk("Z", "Snooze — sink it but keep it visible"), mk("u", "Undo last action")]
          : [`<span class="hk kanbtn" data-act="save" title="Save your answers">save</span>`, `<span class="hk kanbtn danger" data-act="append" title="Append answers to the card file (confirm)">append</span>`, mk("Z", "Snooze")])
      : isPr
      ? [mk("d", "View the diff"), mk("X", `Merge ${it.session.pr_head_ref || "head"} → ${it.session.pr_base_ref || "base"} (guarded)`, "danger"), mk("p", it.session.pinned ? "Unpin" : "Pin to top"), mk("I", "Set manual importance"), mk("Z", "Snooze")]
      : [
          it.category === "FYI_DONE" ? hk(km.accept_answer, "Acknowledge — clear this FYI") : hk(km.accept_answer, "Send the highlighted / typed answer"),
          mk("t", "Watch Claude work in the live terminal"),
          mk("p", it.session.pinned ? "Unpin" : "Pin to top"),
          mk("I", "Set manual importance"),
          mk("Z", "Snooze — sink it but keep it visible"),
          mk("u", "Undo last action"),
          mk("H/L", "Rank this task higher / lower (+ optional reason)"),
          mk("g", "Mark this a good call (teaches ranking)"),
        ]
  ).join("");

  const imp =
    it.session.manual_importance != null
      ? ` · importance <b>${it.session.manual_importance}</b> <span class="dim">(manual override)</span>`
      : it.importance >= 0
      ? ` · importance <b>${it.importance}</b>${it.importance_reason ? ` <span class="dim">(${esc(it.importance_reason)})</span>` : ""}`
      : "";
  const pinBadge = it.session.pinned ? ' <span class="badge pin">📌 pinned</span>' : "";
  const prBadge = it.session.pr_repo && it.session.pr_number
    ? ` <span class="badge pr" title="open GitHub PR — M to merge">PR #${it.session.pr_number}</span>`
    : "";
  // MINIMAL header: standard claude cards drop the meta/importance line entirely (the recap +
  // "you asked" rows carry the context); repo·branch moves to the title's hover tooltip. PR and
  // kanban keep their fuller meta line since their bodies depend on that orientation.
  const repoBranch = `${esc(it.session.repo)} · branch ${esc(it.session.branch)}`;
  const metaLine =
    isPr || isKanban
      ? `<div class="meta">${it.ready_reason} · ${repoBranch}${imp}</div>`
      : "";
  card.innerHTML = `
    <span class="cat ${it.category}">${it.category}${it.default_view === "raw" ? " · default→raw" : ""}</span>
    <h1 title="${repoBranch} — click the name to rename"><span class="card-title">${esc(sessionHeadline(it.session))}</span>${tagChips(it.session)} <span class="dim">#${it.session.slot}</span>${prBadge}${pinBadge}</h1>
    ${metaLine}
    ${body}
    <div class="actions" title="keyboard shortcuts — hover a key for what it does">${acts}</div>
    ${P === "A" ? renderSessionStats(it) + renderQueuePulse() : ""}
  `;

  // Click the card's name to rename it inline (the h1 has no other click action).
  const cardTitle = card.querySelector(".card-title") as HTMLElement | null;
  if (cardTitle) cardTitle.addEventListener("click", () => startInlineRename(cardTitle, it.session));

  if (isAnswerable(it)) {
    // click an answer to send it
    card.querySelectorAll(".ans").forEach((el) =>
      el.addEventListener("click", () => {
        const i = parseInt((el as HTMLElement).dataset.opt!, 10);
        const opts = optionsFor(it);
        if (opts[i]) sendOption(opts[i].text);
      })
    );
    // the answer input doesn't itself trigger the global nav loop (guarded in keydown)
    const inp = card.querySelector("#answer-input") as HTMLTextAreaElement | null;
    // Autofocus when we land on a new answerable card in the focused pane.
    if (inp && S.focused === P && S.paneItem[P] !== it.id) inp.focus();
  }
  if (isKanban) {
    card.querySelectorAll(".kanbtn").forEach((el) =>
      el.addEventListener("click", async () => {
        const act = (el as HTMLElement).dataset.act;
        if (act === "start") showKanbanStartConfirm();
        else if (act === "save") await saveKanbanAnswers();
        else if (act === "append") showKanbanAppendConfirm();
      })
    );
  }
  // Review-run "attach" buttons → host that session's live terminal in pane B.
  card.querySelectorAll(".rev-attach").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const sid = parseInt((el as HTMLElement).dataset.sid || "", 10);
      if (sid > 0) attachReviewSession(sid);
    })
  );
}

// ---------- cockpit-tagged /pr + /prteam review runs on a PR ----------
let _prRuns: any[] = [];
let _prRunsForSession: number | null = null;
let _prRunsLoading = false;

/** Render the pulled review runs for a PR (fetched once per PR; triggers a fetch). */
function renderPrReviews(it: any): string {
  const sid = it.session.id;
  if (_prRunsForSession !== sid && !_prRunsLoading) { fetchPrReviews(sid); return `<div class="pr-reviews dim">loading review runs…</div>`; }
  if (_prRunsForSession !== sid) return `<div class="pr-reviews dim">loading review runs…</div>`;
  if (!_prRuns.length) return `<div class="pr-reviews dim">no /pr or /prteam review comments on this PR yet.</div>`;
  const rows = _prRuns.map((r) => {
    const v = r.verdict === "GREEN" ? `<span class="rv green">✅ GREEN</span>` : r.verdict === "RED" ? `<span class="rv red">❌ RED</span>` : `<span class="rv">${esc(r.verdict || "?")}</span>`;
    const kind = r.type === "prteam" ? `<b>/prteam</b>${r.tier ? ` ${esc(r.tier)}` : ""}${r.rounds ? ` · ${esc(r.rounds)}r` : ""}` : `<b>/pr</b>`;
    const tests = r.tests ? ` · tests ${r.tests === "pass" ? "✅" : r.tests === "fail" ? "❌" : "⏭️"}` : "";
    const when = (r.ts || r.createdAt || "").slice(0, 16).replace("T", " ");
    const attach = r.attachable
      ? `<button class="rev-attach" data-sid="${r.attachSessionId}">▶ attach (${esc(r.session)})</button>`
      : `<span class="dim">session ${esc(r.session || "?")} not tracked</span>`;
    return `<div class="pr-run"><div class="pr-run-head">${v} ${kind}${tests} <span class="dim">· ${esc(when)}</span> ${attach}</div><div class="pr-run-sum">${esc(r.summary || "").slice(0, 400)}</div></div>`;
  }).join("");
  return `<div class="pr-reviews"><h3>Review runs <span class="dim">(/pr · /prteam)</span></h3>${rows}</div>`;
}

async function fetchPrReviews(sid: number) {
  _prRunsLoading = true;
  try {
    const r = await api.prReviews(sid);
    _prRuns = (r && r.runs) || [];
    _prRunsForSession = sid;
    if (r && r.stats) updateReviewStats(r.stats);
  } catch { _prRuns = []; _prRunsForSession = sid; }
  _prRunsLoading = false;
  render();
}

function updateReviewStats(st: any) {
  const el = document.getElementById("review-stats");
  if (!el) return;
  if (!st || !st.prs) { el.textContent = ""; return; }
  el.innerHTML = `<span title="ClaudeOS review runs across watched PRs">🔎 ${st.prs} PR${st.prs === 1 ? "" : "s"} · ${st.prRuns} /pr · ${st.prteamRuns} /prteam · <span class="rv green">${st.green}✅</span>/<span class="rv red">${st.red}❌</span></span>`;
}

function colorDiff(s: string): string {
  return esc(s)
    .split("\n")
    .map((l) => (l.startsWith("+") ? `<span class="add">${l}</span>` : l.startsWith("-") ? `<span class="del">${l}</span>` : l))
    .join("\n");
}

/**
 * Parse a unified `git diff` / `gh pr diff` into a GitHub-style SIDE-BY-SIDE split:
 * per-file header bar (path + +adds/−dels), two columns (old/red left, new/green right),
 * per-side line numbers, hunk separators. Returns HTML.
 */
function splitDiffHtml(unified: string): string {
  const lines = (unified || "").split("\n");
  type Row = { type: "ctx" | "del" | "add" | "pair" | "hunk"; lo?: string; ro?: string; ln?: number; rn?: number; hunk?: string };
  type FileBlk = { path: string; adds: number; dels: number; rows: Row[] };
  const files: FileBlk[] = [];
  let f: FileBlk | null = null;
  let oldNo = 0, newNo = 0;
  let delBuf: { t: string; n: number }[] = [];
  let addBuf: { t: string; n: number }[] = [];

  const flushPairs = () => {
    if (!f) { delBuf = []; addBuf = []; return; }
    const n = Math.max(delBuf.length, addBuf.length);
    for (let i = 0; i < n; i++) {
      const d = delBuf[i], a = addBuf[i];
      f.rows.push({ type: "pair", lo: d ? d.t : undefined, ln: d ? d.n : undefined, ro: a ? a.t : undefined, rn: a ? a.n : undefined });
    }
    delBuf = []; addBuf = [];
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git")) {
      flushPairs();
      const m = raw.match(/ b\/(.+)$/);
      f = { path: m ? m[1] : raw.replace("diff --git ", ""), adds: 0, dels: 0, rows: [] };
      files.push(f);
      continue;
    }
    if (!f) continue;
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("similarity ") || raw.startsWith("rename ")) {
      const m = raw.match(/^\+\+\+ b\/(.+)$/);
      if (m) f.path = m[1];
      continue;
    }
    if (raw.startsWith("@@")) {
      flushPairs();
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      f.rows.push({ type: "hunk", hunk: raw });
      continue;
    }
    if (raw.startsWith("-")) { f.dels++; delBuf.push({ t: raw.slice(1), n: oldNo++ }); continue; }
    if (raw.startsWith("+")) { f.adds++; addBuf.push({ t: raw.slice(1), n: newNo++ }); continue; }
    // context (starts with space, or blank)
    flushPairs();
    const t = raw.startsWith(" ") ? raw.slice(1) : raw;
    f.rows.push({ type: "ctx", lo: t, ro: t, ln: oldNo++, rn: newNo++ });
  }
  flushPairs();

  if (!files.length) return `<div class="dim">(no diff)</div>`;
  const cell = (n: number | undefined, text: string | undefined, cls: string) =>
    `<span class="dl-num">${n != null ? n : ""}</span><span class="dl-code ${cls}">${text != null ? esc(text) || "&nbsp;" : ""}</span>`;
  let html = "";
  for (const fl of files) {
    html += `<div class="dl-file">`;
    html += `<div class="dl-fhead"><span class="dl-fpath">${esc(fl.path)}</span><span class="dl-fstat"><span class="add">+${fl.adds}</span> <span class="del">−${fl.dels}</span></span></div>`;
    html += `<div class="dl-grid">`;
    for (const r of fl.rows) {
      if (r.type === "hunk") { html += `<div class="dl-hunk">${esc(r.hunk || "")}</div>`; continue; }
      if (r.type === "ctx") { html += `<div class="dl-row">${cell(r.ln, r.lo, "ctx")}${cell(r.rn, r.ro, "ctx")}</div>`; continue; }
      // pair: left = removed (red) or empty, right = added (green) or empty
      const leftCls = r.lo != null ? "del" : "empty";
      const rightCls = r.ro != null ? "add" : "empty";
      html += `<div class="dl-row">${cell(r.ln, r.lo, leftCls)}${cell(r.rn, r.ro, rightCls)}</div>`;
    }
    html += `</div></div>`;
  }
  return html;
}

function renderExplain(it: any): string {
  const bd = it.score_breakdown?.breakdown || [];
  const learned = it.score_breakdown?.learned || [];
  const max = Math.max(1, ...bd.map((t: any) => Math.abs(t.contribution)));
  const rows = bd
    .map((t: any) => {
      const pct = (Math.abs(t.contribution) / max) * 100;
      return `<div class="bar ${t.contribution < 0 ? "neg" : ""}"><span class="name" title="${esc(t.note)}">${t.signal}</span><span class="track"><span class="fill" style="width:${pct}%"></span></span><span class="val">${t.contribution}</span></div>`;
    })
    .join("");
  const learnedRows = learned.length
    ? `<h3 style="margin-top:8px">learned nudge (your feedback)</h3>` +
      learned.map((l: any) => `<div class="bar ${l.adjustment < 0 ? "neg" : ""}"><span class="name">${esc(l.key)}</span><span class="track"></span><span class="val">${l.adjustment > 0 ? "+" : ""}${l.adjustment}</span></div>`).join("")
    : "";
  return `<h3>why priority ${it.session && it.session.pinned ? `${it.priority - PIN_BASE} <span class="dim">(📌 pinned → top)</span>` : it.priority}</h3>${rows}${learnedRows}`;
}

function renderSessions() {
  // Roster ordered by LATEST OUTPUT — the session Claude wrote to most recently floats to the
  // top (mirrors the Claude app's recency list). lastActivity = transcript mtime (server-computed).
  // Independent of the "Up next" queue: this is the full roster, sorted purely by recency.
  const rows = (S.state.sessions || []).slice().sort((a: any, b: any) => {
    return (Date.parse(b.lastActivity || "") || 0) - (Date.parse(a.lastActivity || "") || 0);
  });
  $("sessions").innerHTML = rows
    .map((s: any) => {
      const r = s.row;
      const live = !!r.is_live_pane || r.kind === "pr" || r.kind === "kanban" || r.kind === "shell";
      const title = esc((r.manual_title || r.clean_title || r.title || "").slice(0, 80));
      const ago = timeAgo(s.lastActivity || "");
      const tag = !live ? '<span class="dim"> · past</span>' : "";
      const agoTag = ago ? `<span class="sess-ago" title="time since last output">${ago}</span>` : "";
      // How long this session has been RUNNING (start → now) — disambiguates "40m ago" (see runFor).
      const run = runFor(s.startedAt || "");
      const runTag = run && live ? `<span class="sess-run" title="running for">⏱ ${run}</span>` : "";
      // ETA the session reported via /eta (long-running silent jobs) → a COUNTDOWN BAR (no text):
      // its WIDTH is the fraction of the reported time still left; a SOLID fill = still running,
      // DIAGONAL STRIPES = ETA reached / re-checking. Encoded by shape+texture (reads the same in
      // greyscale — colorblind-safe), with a colorblind-safe blue/orange only as a redundant bonus.
      // Only meaningful while the session is HELD (parked/working); once it's actionable in the Task
      // Queue (DONE/WAITING_INPUT) the countdown is moot, so no bar. Exact time-left is in the tooltip.
      const heldState = r.state === "UNKNOWN" || r.state === "WORKING";
      const etaMin = heldState && r.eta_at ? Math.round((Date.parse(r.eta_at.includes("T") ? r.eta_at : r.eta_at.replace(" ", "T") + "Z") - Date.now()) / 60000) : null;
      let etaBar = "";
      if (etaMin != null) {
        const total = etaTotalMin(r.eta_text) || Math.max(etaMin, 1);
        const due = etaMin <= 1;                                   // about to expire / re-checking
        const frac = Math.max(0, Math.min(1, etaMin / total));
        const pct = due ? (etaMin <= 0 ? 18 : Math.max(8, Math.round(frac * 100))) : Math.max(8, Math.round(frac * 100));
        const lbl = etaMin > 0 ? `~${timeLeft(r.eta_at)} left` : "ETA reached — re-checking";
        etaBar = `<span class="sess-etabar ${due ? "due" : "run"}" title="${lbl}" aria-label="${lbl}"><i style="width:${pct}%"></i></span>`;
      }
      return `<li class="sessrow ${s.surfaced ? "surfaced" : ""} ${live ? "" : "roster-only"}" data-sid="${r.id}" data-live="${live ? 1 : 0}" data-title="${esc(r.title)}" title="${live ? "open live terminal" : "recent session (no live pane)"}"><span class="dot ${r.state} statedot" data-sid="${r.id}" title="status: ${String(r.state || "UNKNOWN").replace("_", " ").toLowerCase()} — click to change"></span><span class="sess-title">${title}${tag}</span><span class="rename-btn" data-sid="${r.id}" title="rename">✎</span>${tagChips(r)}${r.pr_repo && r.pr_number ? `<span class="badge pr" title="open GitHub PR #${r.pr_number}">PR</span>` : ""}${runTag}${etaBar}${agoTag}<span class="watch-eye">${live ? "👁" : ""}</span></li>`;
    })
    .join("");
  // Inline rename via the ✎ (single click on the row still opens the terminal, so the pencil is
  // the roster's rename affordance — stopPropagation keeps it from attaching).
  document.querySelectorAll("#sessions .rename-btn").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const sid = parseInt((el as HTMLElement).dataset.sid!, 10);
      const s = (S.state.sessions || []).find((x: any) => x.row && x.row.id === sid);
      const host = (el as HTMLElement).closest("li")?.querySelector(".sess-title") as HTMLElement | null;
      if (s && host) startInlineRename(host, s.row);
    })
  );
  // Click ANY session to open its terminal. The server attaches the live pane, RESUMES a stopped
  // session (`claude --resume` into its durable claudeos-<id> tmux), or shows read-only if truly
  // gone — but a terminal is NEVER unclickable here.
  document.querySelectorAll("#sessions li.sessrow").forEach((el) => {
    el.addEventListener("click", () => {
      const sid = parseInt((el as HTMLElement).dataset.sid!, 10);
      attachReviewSession(sid);
    });
    // Right-click a roster row → status menu (correct a mis-read status).
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const sid = parseInt((el as HTMLElement).dataset.sid!, 10);
      const dot = el.querySelector(".statedot") as HTMLElement | null;
      const cur = (dot?.className.match(/dot (\w+)/) || [])[1] || "UNKNOWN";
      showStateMenu(sid, cur, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    });
  });
  // Click the status dot itself (don't open the terminal) → status menu.
  document.querySelectorAll("#sessions .statedot").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const sid = parseInt((el as HTMLElement).dataset.sid!, 10);
      const cur = (el.className.match(/dot (\w+)/) || [])[1] || "UNKNOWN";
      showStateMenu(sid, cur, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    })
  );
}

/** Manual status override menu — right-click a card / roster row (or click its status dot) to
 *  correct a status the auto-detector read wrong (WAITING_INPUT | WORKING | DONE), or clear the
 *  override to let Claude decide again. This is the TRANSIENT status only; permanent "done + archive"
 *  stays the complete action (Ctrl+G e). The change is logged server-side so the ranking loop learns
 *  where detection was wrong. */
function showStateMenu(sessionId: number, curState: string, x: number, y: number) {
  document.querySelectorAll(".ctx-menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const opts: Array<[string, string]> = [
    ["WAITING_INPUT", "waiting for me"],
    ["WORKING", "working"],
    ["DONE", "done"],
  ];
  menu.innerHTML =
    opts.map(([val, lbl]) => `<div class="ctx-item" data-state="${val}"><span class="dot ${val}"></span>${lbl}${val === curState ? " ✓" : ""}</div>`).join("") +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-item ctx-clear" data-state="">↺ let Claude decide</div>`;
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  const close = () => { menu.remove(); document.removeEventListener("mousedown", onDoc, true); };
  const onDoc = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close(); };
  setTimeout(() => document.addEventListener("mousedown", onDoc, true), 0);
  menu.querySelectorAll(".ctx-item").forEach((el) =>
    el.addEventListener("click", () => {
      const st = (el as HTMLElement).dataset.state || "";
      close();
      setStatus(st ? `status → ${st.replace("_", " ").toLowerCase()}…` : "cleared manual status — Claude decides…");
      // Server quick-reranks + broadcasts an update, which refreshes the queue/roster automatically.
      api.overrideState(sessionId, st).catch(() => {});
    })
  );
}

function renderWeights() {
  const learning = S.state.learning || { weights: [], examples: [], ranking: "" };
  // Effective weights: base + learned Δ → effective (the Δ column shows what was learned).
  const wRows = (learning.weights || []).map((x: any) => {
    const d = x.delta || 0;
    const dStr = d ? `<span class="num ${d < 0 ? "neg" : "pos"}">${d > 0 ? "+" : ""}${d}</span>` : `<span class="dim">·</span>`;
    return `<tr><td>${esc(x.key)}</td><td class="num dim">${x.base}</td><td class="num">${dStr}</td><td class="num"><b>${x.effective}</b></td></tr>`;
  });
  $("weights-table").innerHTML = `<tr><td class="dim">signal</td><td class="num dim">base</td><td class="num dim">learned Δ</td><td class="num dim">eff</td></tr>` + wRows.join("");
  // RANKING.md (learned qualitative rules)
  $("ranking-md").textContent = learning.ranking || "(no learned ranking rules yet)";
  // Training examples (state → predicted → correct)
  $("examples-list").innerHTML = (learning.examples || []).length
    ? learning.examples.map((e: any) =>
        // FIX BB: explicit reasoned feedback shows the operator's own words + direction (strong).
        e.kind === "explicit_reason"
          ? `<li><b class="strong">★ reason</b> <span class="dim">${(e.ts || "").slice(5, 16)}</span><br><span class="dim">${e.state && e.state.direction === "up" ? "raise ↑" : "lower ↓"}${e.state && e.state.category ? " · " + esc(e.state.category) : ""}:</span> “${esc(String(e.reason || "").slice(0, 90))}”</li>`
          : `<li><b>${esc(e.kind)}</b> <span class="dim">${(e.ts || "").slice(5, 16)}</span><br><span class="dim">pred</span> ${esc(JSON.stringify(e.predicted).slice(0, 60))} → <span class="dim">correct</span> ${esc(JSON.stringify(e.correct).slice(0, 60))}</li>`
      ).join("")
    : `<li class="dim">no training examples yet — they appear as you triage</li>`;
  $("adj-table").innerHTML =
    S.state.adjustments.map((a: any) => `<tr><td>${esc(a.key)}</td><td class="num ${a.adjustment < 0 ? "neg" : ""}">${a.adjustment > 0 ? "+" : ""}${a.adjustment}</td></tr>`).join("") || `<tr><td class="dim">no nudges yet</td></tr>`;
  const dreamLines = (S.state.dreams || []).map((d: any) => `<li>🌙 <span class="dim">${(d.ran_at || "").slice(5, 16)}</span> ${esc((d.summary || "").slice(0, 80))}</li>`);
  const fbLines = S.state.recent.map((r: any) => `<li>${r.feedback} · ${r.category || "-"} <span class="dim">${(r.created_at || "").slice(11, 19)}</span></li>`);
  $("recent-list").innerHTML = [...dreamLines, ...fbLines].join("") || `<li class="dim">no feedback yet</li>`;
}

// ---------- keyboard loop ----------
function overlayOpen(): string | null {
  for (const id of ["help-overlay", "focus-overlay", "edit-overlay", "imp-overlay", "quickprompt-overlay", "merge-overlay", "search-overlay"])
    if ($(id).style.display !== "none") return id;
  return null;
}
function closeOverlays() {
  ["help-overlay", "focus-overlay", "edit-overlay", "imp-overlay", "quickprompt-overlay", "merge-overlay", "search-overlay"].forEach(
    (id) => ($(id).style.display = "none")
  );
  S.rawFor = null;
  S.diffSession = null;
  S.pendingConfirm = null;
}

/** Keyboard handling while ANY overlay is open. Called at the TOP of the global keydown listener
 *  (before master-arming and the terminal early-return) because the overlay's input holds DOM focus
 *  while S.focused still points at the pane underneath — running it later would let those swallow
 *  Esc/Enter or yank focus away. Esc always closes the overlay AND restores focus to the pane;
 *  every key it doesn't explicitly handle falls through and types into the overlay's input. */
async function handleOverlayKey(e: KeyboardEvent) {
  const open = overlayOpen();
  if (!open) return;
  // Esc closes any overlay and hands the keyboard back to the pane it was opened over.
  if (e.key === "Escape") { e.preventDefault(); closeOverlays(); applyKeyboardTarget(); render(); return; }
  if (open === "focus-overlay" && e.key === "Enter") {
    await api.setFocus(($("focus-input") as HTMLInputElement).value);
    closeOverlays();
    await api.tick();
    await refresh();
    return;
  }
  if (open === "edit-overlay" && e.key === "Enter") {
    if (e.ctrlKey || e.shiftKey || e.metaKey) {
      // Ctrl/Shift+Enter => newline in the edit box
      e.preventDefault();
      const ta = $("edit-input") as HTMLTextAreaElement;
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + "\n" + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 1;
      return;
    }
    e.preventDefault();
    const val = ($("edit-input") as HTMLTextAreaElement).value;
    const r = await api.sendAnswer(selectedItem().id, val);
    setStatus(r.ok ? `sent: ${r.sent}` : `staged: ${r.sent}`);
    closeOverlays();
    await refresh();
    return;
  }
  if (open === "imp-overlay" && e.key === "Enter") {
    const raw = ($("imp-input") as HTMLInputElement).value.trim();
    const val = raw === "" ? null : Math.max(0, Math.min(100, parseInt(raw, 10) || 0));
    const it = selectedItem();
    if (it) await api.setManualImportance(it.session.id, val);
    closeOverlays();
    setStatus(val == null ? "cleared manual importance" : `manual importance = ${val}`);
    await api.tick();
    await refresh();
    return;
  }
  if (open === "quickprompt-overlay" && e.key === "Enter") {
    if (e.shiftKey) return; // Shift+Enter = newline (flows into textarea)
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd+Enter = reveal the priority field & jump to it (instead of a newline). Type a
      // number 0–100, then plain Enter sends with that importance. Default stays "none".
      e.preventDefault();
      revealQuickPromptPriority();
      return;
    }
    e.preventDefault();
    await submitQuickPrompt(); // plain Enter (from the textarea OR the priority field) sends
    return;
  }
  if (open === "merge-overlay" && e.key === "Enter") {
    e.preventDefault();
    const fn = S.pendingConfirm;
    S.pendingConfirm = null;
    if (fn) { await fn(); } else { await doMerge(); }
    return;
  }
  if (open === "search-overlay") {
    // ↑/↓ move the result selection; Enter on a selection opens it, Enter with no
    // selection fires the SMART (sonnet) semantic rank. Everything else types & filters.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveSearchSel(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (_searchSel >= 0 && _searchResults[_searchSel]) await openSearchResult(_searchResults[_searchSel]);
      else await runSemanticSearch();
      return;
    }
  }
  // every other key types into the overlay's focused input
}

/** Transcript view was removed — the written brief in Overview replaces it. Legacy callers
 *  fall back to opening the live terminal (where the operator can scroll Claude's output). */
async function showRaw() {
  setPaneView("B", "terminal");
}

function showHelp() {
  const ml = esc(masterLabel());
  const sel = selectedItem();
  const dynKeys = isAnswerable(sel) ? optionsFor(sel).map((o) => `<kbd>${esc(o.key.toUpperCase())}</kbd> ${esc(o.label)}`).join(" · ") : "";
  const synthetic =
    `<tr><td class="k"><kbd>⌘E</kbd> <kbd>⌘P</kbd> <kbd>⌘F</kbd></td><td><b>Mac shortcuts</b> — work EVERYWHERE incl. the terminal: <kbd>⌘E</kbd> archive/complete · <kbd>⌘P</kbd> pin · <kbd>⌘F</kbd> set focus · <kbd>⌘↑</kbd>/<kbd>⌘↓</kbd> prev/next task. (Or click the <b>📌 Pin</b> / <b>✓ Archive</b> buttons in the header.)</td></tr>` +
    `<tr><td class="k">model</td><td><b>TERMINAL-FIRST</b>: landing on a task focuses its live terminal — whatever you type goes straight to the session. On a fresh landing <kbd>↑</kbd>/<kbd>↓</kbd> walk the queue; once you TYPE anything into the terminal they become real arrows to the session (prompt history) until you switch task. <kbd>Shift+↑/↓</kbd> = always the session, <kbd>${ml} ↑/↓</kbd> = always the queue. Every other cockpit action is behind the master (<kbd>${ml}</kbd>) — bare letters never trigger anything.</td></tr>` +
    `<tr><td class="k"><kbd>↑</kbd>/<kbd>↓</kbd></td><td>previous / next task — works everywhere, incl. inside the terminal. <kbd>Shift+↑</kbd>/<kbd>Shift+↓</kbd> sends a REAL arrow to the terminal (Claude menus, shell history).</td></tr>` +
    `<tr><td class="k">${dynKeys || "<kbd>Y</kbd>/<kbd>N</kbd> or <kbd>A</kbd>/<kbd>B</kbd>/<kbd>C</kbd>/<kbd>D</kbd>"}</td><td>pick + send a candidate answer — in the (empty) answer box (focus pane A first: <kbd>${ml}</kbd> <kbd>←</kbd> or <kbd>o</kbd>)</td></tr>` +
    `<tr><td class="k"><kbd>type</kbd></td><td>in the answer box: custom answer · <kbd>Enter</kbd> send · <kbd>Ctrl/Shift+Enter</kbd> newline</td></tr>` +
    `<tr><td class="k"><kbd>←</kbd></td><td>(in Overview) open a NEW empty Claude terminal — discarded if you leave without typing</td></tr>` +
    `<tr><td class="k">layout</td><td><b>two panes</b>: <b>A</b> (center) and <b>B</b> (right) each show ONE view independently. Click a pane to focus it (ring). The single live terminal <b>moves</b> between panes — never double-attached.</td></tr>` +
    `<tr><td class="k">resizers</td><td>drag the dividers (queue│A│B) to resize · <b>double-click</b> a divider to reset · widths persist</td></tr>` +
    `<tr><td class="k"><kbd>Ctrl+B</kbd> (in terminal)</td><td><b>your inner tmux</b> — passes straight through. The ClaudeOS master (${ml}) and plain <kbd>↑</kbd>/<kbd>↓</kbd> are the ONLY keys ClaudeOS intercepts in the terminal.</td></tr>` +
    `<tr><td class="k">terminal</td><td><b>everything else goes straight to Claude</b> — <kbd>Esc</kbd> interrupts, <kbd>Ctrl+U</kbd> clears, <kbd>←</kbd>/<kbd>→</kbd>/Tab/slash-autosuggest all work</td></tr>`;
  const MASTER: [string, string][] = [
    ["↑ / ↓ · j / k", "previous / next task (identity-stable)"],
    ["Enter", "dismiss — \"handled for now\"; re-surfaces when waiting/done again"],
    ["e", "complete — permanent: archive + move the kanban card to done"],
    ["a", "accept & send the suggested answer / acknowledge"],
    ["E", "edit the answer, then send"],
    ["H / L", "rank this task HIGHER / LOWER (+ optional reason)"],
    ["I", "set manual importance — becomes the priority score exactly (0–100)"],
    ["p", "pin / unpin (force to top when ready)"],
    ["Z", "snooze (score penalty; stays visible)"],
    ["u", "undo / revert last action (Ctrl+Z outside the terminal also works)"],
    ["o / t / d / h", "focused pane view: Overview / Terminal / Diff / HTML(viz)"],
    ["m (or z)", "maximize the focused pane (exit: " + ml + " q)"],
    ["; · ← / →", "toggle / pick the focused pane (A ⇄ B)"],
    ["C / c", "new Claude terminal (skip-perms) / new plain shell — both ephemeral"],
    ["i", "quick prompt — fire a new Claude session in the background (Ctrl+Enter to set its priority first)"],
    ["n", "new session"],
    ["T / A", "take over the selected bg agent / all idle agents"],
    ["M", "merge the selected session's GitHub PR (guarded confirm)"],
    ["X", "merge the selected item's PR (guarded confirm; bare X works while a diff pane is focused)"],
    ["w / g", "feedback: wrong classification / good suggestion"],
    ["O / N", "feedback: too much output / needed more context"],
    ["f", "set current focus (biases ranking)"],
    ["/", "search ALL past sessions (type→filter, Enter→semantic top-5)"],
    ["r", "refresh now"],
    ["R", "rename the selected session (inline; empty reverts to the auto name)"],
    ["G", "then a digit → jump to session N"],
    ["?", "this overlay"],
    ["q / Esc", "back: exit maximize, else detach the terminal"],
  ];
  $("help-table").innerHTML = synthetic +
    `<tr><td class="k"><kbd>${ml}</kbd> then …</td><td><b>master key</b> — works everywhere, incl. inside the terminal:</td></tr>` +
    MASTER.map(([key, d]) => `<tr><td class="k"><kbd>${ml}</kbd> <kbd>${esc(key)}</kbd></td><td>${d}</td></tr>`).join("");
  $("help-overlay").style.display = "block";
}

function showFocus() {
  const inp = $("focus-input") as HTMLInputElement;
  inp.value = S.state.focus || "";
  $("focus-overlay").style.display = "block";
  inp.focus();
}
function showEdit() {
  const it = selectedItem();
  if (!it) return;
  const ta = $("edit-input") as HTMLTextAreaElement;
  ta.value = it.suggested_answer || "";
  $("edit-overlay").style.display = "block";
  ta.focus();
}

// ---------- inline working-pane mode switching (no popups) ----------
type PaneMode = "detail" | "terminal" | "diff" | "launcher";
// ---------- COCKPIT MASTER KEY (configurable, default C-g) ----------
// The master key REPLACES the old tmux-style Ctrl+B leader EVERYWHERE (incl. inside the
// live terminal). Ctrl+B is now 100% the inner tmux's. After the master, the next key is a
// cockpit command: o/t/d/r pane views · f fullscreen · ; / ←→ focus · C/c new Claude/shell ·
// q (or Esc) exit/back/detach · n new session.
/** Parse a chord like "C-g" / "M-x" into modifier+key. */
function parseChord(s: string): { ctrl: boolean; alt: boolean; shift: boolean; key: string } {
  const parts = (s || "C-g").split("-");
  const key = (parts.pop() || "g").toLowerCase();
  const mods = parts.map((p) => p.toUpperCase());
  return { ctrl: mods.includes("C"), alt: mods.includes("M") || mods.includes("A"), shift: mods.includes("S"), key };
}
function masterChordStr(): string { return S.keymap.master || "C-g"; }
function masterLabel(): string { return masterChordStr().toUpperCase().replace("C-", "Ctrl+").replace("M-", "Alt+"); }
function isMasterKey(e: KeyboardEvent): boolean {
  const c = parseChord(masterChordStr());
  return e.ctrlKey === c.ctrl && (e.altKey || false) === c.alt && e.key.toLowerCase() === c.key;
}
/** Browser-reserved chords that the page CANNOT override (warn the operator if chosen). */
function masterBrowserWarning(): string {
  const c = parseChord(masterChordStr());
  if (c.ctrl && !c.alt) {
    const k = c.key.toLowerCase();
    if (["w", "t", "n", "tab", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(k))
      return `${masterLabel()} is reserved by the browser and won't work in-app — pick another master key (e.g. Ctrl+G).`;
  }
  return "";
}
function startMaster() {
  S.leaderActive = true;
  const hint = $("leader-hint");
  hint.textContent = `${masterLabel()} [pane ${S.focused}] — ↑/↓ or j/k tasks · Enter done · e complete · a answer · E edit · H/L rank ± · I importance · p pin · Z snooze · u undo · o/t/d/h views · m max · f focus · ; pane · C/c new · i quick-prompt · M merge · r refresh · R rename · ? help · q back`;
  hint.style.display = "block";
  if (S.leaderTimer) clearTimeout(S.leaderTimer);
  S.leaderTimer = setTimeout(clearMaster, 2500);
}
function clearMaster() {
  S.leaderActive = false;
  if (S.leaderTimer) { clearTimeout(S.leaderTimer); S.leaderTimer = null; }
  $("leader-hint").style.display = "none";
}

/** MAC ⌘ SHORTCUTS — direct, single-press actions on the selected task. Unlike Ctrl-based keys these
 *  never collide with the terminal (⌘ isn't a terminal control char), so they work EVERYWHERE,
 *  including while typing to Claude. Returns true if it handled the key (caller preventDefaults).
 *  ⌘C/⌘V/⌘R/⌘Z/⌘Q etc. are deliberately NOT captured here so copy/paste/reload/undo/quit still work. */
function runMacShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.ctrlKey || e.altKey) return false; // plain ⌘ only
  switch (e.key.toLowerCase()) {
    case "e": completeSelected(); return true;        // ⌘E  archive / complete
    case "p": void togglePin(); return true;          // ⌘P  pin / unpin
    case "f": showFocus(); return true;               // ⌘F  set focus
    case "arrowup": moveQueueSel(-1); return true;    // ⌘↑  previous task
    case "arrowdown": moveQueueSel(1); return true;   // ⌘↓  next task
    default: return false;
  }
}
/** Run a master command key. Always consumes the key (master sequence). */
function runMasterCmd(e: KeyboardEvent): boolean {
  // A bare modifier keydown (e.g. the Shift in `master` then `Shift+C`) must NOT consume or
  // clear the master — stay armed and wait for the real command key.
  if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
    e.preventDefault();
    return false;
  }
  clearMaster();
  // ; (or Tab) toggles the focused pane; Left/Right move PANE FOCUS; Up/Down navigate the QUEUE.
  if (e.key === ";" || e.key === "Tab") { toggleFocus(); return false; }
  if (e.key === "ArrowLeft") { focusPane("A"); return false; }
  if (e.key === "ArrowRight") { focusPane("B"); return false; }
  if (e.key === "ArrowUp") { moveQueueSel(-1); return false; }   // master+↑ = previous task
  if (e.key === "ArrowDown") { moveQueueSel(1); return false; }  // master+↓ = next task
  // master+Enter => "I'm done with this task": dismiss it from Up Next (no text sent), advance.
  if (e.key === "Enter") { dismissCurrentTask(); return false; }
  // q / Esc => exit maximize, else detach the terminal.
  if (e.key === "q" || e.key === "Escape") { if (S.fullPane) setPaneFull(null); else if (S.termPane) closeTerminal(); return false; }
  // case-sensitive new-session commands: C = new Claude, c = new shell.
  if (e.key === "C") { newClaudeTerminal(); return false; }
  if (e.key === "c") { newShellTerminal(); return false; }
  // i = QUICK inline prompt: type a prompt → fire off a new Claude session in the
  // background and return to whatever you were doing (no terminal switch).
  // (lowercase only — capital I is manual importance, see the gated action keys below)
  if (e.key === "i") { showQuickPrompt(); return false; }
  // / = SEARCH all past sessions (type→filter, Enter→sonnet top-5).
  if (e.key === "/") { showSessionSearch(); return false; }
  // FIX E: T = take over the selected bg agent → dedicated terminal; A = take over all idle.
  if (e.key === "T") { takeOverSelected(); return false; }
  if (e.key === "A") { takeOverAllAgents(); return false; }
  // FIX J: master_complete (default e) = complete & archive the selected task (kanban → done).
  if (e.key === (S.keymap.master_complete || "e")) { completeSelected(); return false; }
  // FIX V: Ctrl+G + / Ctrl+G - = live terminal font zoom (bigger/smaller, re-fits).
  if (e.key === "+" || e.key === "=") { zoomTermFont(+1); return false; }
  if (e.key === "-" || e.key === "_") { zoomTermFont(-1); return false; }
  // FIX X: Ctrl+G M = merge the selected session's GitHub PR (confirm first).
  // (lowercase m = maximize, operator request 2026-06-10 — f is now set-focus, like it always was)
  if (e.key === "M") { mergeSelectedPr(); return false; }
  // GATED ACTION KEYS (operator request 2026-06-10): the old DIRECT single-key actions (h/l
  // priority, i importance, p pin, z snooze, …) now live ONLY behind the master — bare keys go
  // to the terminal/answer box. Case-sensitive: capitals dodge the existing view bindings
  // (h=HTML, e=complete, i=quick-prompt, z=fullscreen).
  if (e.key === "H") { showReasonInput("up"); return false; }   // rank this task HIGHER (+ reason)
  if (e.key === "L") { showReasonInput("down"); return false; } // rank this task LOWER (+ reason)
  if (e.key === "I") { showManualImportance(); return false; }  // manual importance 0–100
  if (e.key === "Z") {                                          // snooze (z stays fullscreen)
    const it = selectedItem();
    if (it) { const id = it.id; optimisticAdvance(id); setStatus("snoozed — advancing…"); api.snooze(id, 60).catch(() => {}); }
    return false;
  }
  if (e.key === "p" || e.key === "P") { void togglePin(); return false; }
  if (e.key === "u" || e.key === "U") { void doUndo(); return false; }
  if (e.key === "r") { setStatus("refreshing…"); api.tick().then(() => refresh()).catch(() => {}); return false; }
  if (e.key === "R") { renameSelected(); return false; }          // rename the selected session inline (manual_title)
  if (e.key === "?") { showHelp(); return false; }
  if (e.key === "a") { void sendSelected(); return false; }     // accept & send the suggested answer
  if (e.key === "E") { showEdit(); return false; }              // edit answer then send (e = complete)
  if (e.key === "w" || e.key === "W") { void act("wrong"); return false; }
  if (e.key === "g") { void act("good"); return false; }
  if (e.key === "O") { void act("too_much_output"); return false; }   // feedback: too much Output
  if (e.key === "N") { void act("need_more_context"); return false; } // feedback: Need more context
  if (e.key === "f" || e.key === "F") { showFocus(); return false; } // set current focus (m/z = maximize)
  if (e.key === "X") { mergeCurrent(); return false; }                // merge PR-kind OR detected-PR item (guarded)
  if (e.key === "j") { moveQueueSel(1); return false; }
  if (e.key === "k") { moveQueueSel(-1); return false; }
  if (e.key === "G") { S.jumpMode = true; setStatus("jump: press session number"); return false; }
  const k = e.key.toLowerCase();
  const P = S.focused; // master acts on the FOCUSED pane
  switch (k) {
    case "o": setPaneView("A", "overview"); break; // Overview only exists in A
    case "h": setPaneView("A", "html"); break; // FIX O: HTML viz (only if the session has one)
    case "t": setPaneView(P, "terminal"); break;
    case "d": setPaneView(P, "diff"); break; // NOTE: no "g" alias — it collides with the Ctrl+G master
    case "n": newClaudeTerminal(); break;
    case "m": case "z": // FIX HH: m = fullscreen the FOCUSED pane's current view (any: term/diff/html/overview)
      setPaneFull(P);
      break;
    default: /* unknown master cmd: ignore */ break;
  }
  return false;
}

/** Per-pane mode cycle (used by Tab outside the terminal). */
function cycleFocusedPane(dir: number) {
  const P = S.focused;
  const tabs = P === "A" ? A_TABS : B_TABS;
  const i = Math.max(0, tabs.indexOf(S.panes[P]));
  setPaneView(P, tabs[(i + dir + tabs.length) % tabs.length]);
}


// ---------- live terminal: a SINGLE real attached PTY (xterm + WS) hosted in whichever
// pane currently shows Terminal. _termOverride pins it to a specific (new/review) session;
// otherwise it follows the selected task's session. ----------
let _termUsed = false;          // whether the operator typed a real key into the current terminal
// NEWEST-OPEN-WINS token for the async native (ssh→tmux) attach: every openTermNative() stamps a
// fresh value; a stale in-flight attach (superseded by a newer open or a teardown) sees its stamp
// is no longer current and abandons instead of spawning/keeping a duplicate ssh pty. See
// openTermNative() — this is what stops the "duplicate tmux client / size-flap" leak.
let _termOpenSeq = 0;
// TYPE-AWARE NAV (operator request 2026-06-11): gates what plain ↑/↓ mean INSIDE the terminal.
// false (fresh landing on a task, nothing typed yet) → ↑/↓ walk the task queue.
// true (the operator typed/pasted ANYTHING into this terminal) → ↑/↓ are REAL arrows to the pty
// (claude prompt history, menus) until the next EXPLICIT task nav re-arms queue mode.
// Escape hatches in both directions at all times: Shift+↑/↓ = always pty, master+↑/↓ = always queue.
let _termTypedSinceNav = false;
// SCROLL FIX: fractional wheel-line carry for the synthetic SGR wheel reports (reset per xterm).
let _wheelAcc = 0;
let _termOverride: number | null = null; // explicit session id to attach (new-session / review-attach)
let _renderedItemId: number | null = null; // FIX U: which task the panes are CURRENTLY rendering (≠ selection identity)
// FIX V: live font-size delta from Ctrl +/- (added to config terminal_font_size). PERSISTED to
// localStorage so a hard reload (Ctrl+Shift+R) keeps the operator's chosen terminal font size —
// the new xterm is created with termFontSize(), which reads this restored value.
let _termFontZoom = (() => { try { const v = parseInt(localStorage.getItem("cockpit.termFontZoom") || "0", 10); return isNaN(v) ? 0 : Math.max(-12, Math.min(16, v)); } catch { return 0; } })();

/** FIX V: effective xterm font size = config terminal_font_size (default 15) + the live zoom delta,
 *  clamped to a sane range. 198 cols at 13px was microscopic; 15px ≈ 150 cols, readable. */
function termFontSize(): number {
  const base = (S.state && S.state.config && (S.state.config as any).terminal_font_size) || 15;
  return Math.max(8, Math.min(28, base + _termFontZoom));
}

/** FIX CC: UI text scale (overview/diff/html + queue) — independent of the terminal font. Applied
 *  as a CSS `--ui-scale` (zoom) and persisted in localStorage. */
let _uiScale = (() => { try { const v = parseFloat(localStorage.getItem("ui_font_scale") || "1"); return isNaN(v) ? 1 : Math.max(0.7, Math.min(1.6, v)); } catch { return 1; } })();
function applyUiScale() {
  try { document.documentElement.style.setProperty("--ui-scale", String(_uiScale)); } catch {}
}
function zoomUi(delta: number) {
  _uiScale = Math.max(0.7, Math.min(1.6, +(_uiScale + delta).toFixed(2)));
  applyUiScale();
  try { localStorage.setItem("ui_font_scale", String(_uiScale)); } catch {}
  setStatus(`UI text ${Math.round(_uiScale * 100)}%`);
}

/** FIX CC: is this a plain Ctrl/Cmd +/- zoom keystroke (incl. Ctrl+Shift+= and numpad)? */
function isZoomKey(e: KeyboardEvent): 1 | -1 | 0 {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return 0;
  if (e.key === "+" || e.key === "=") return 1;
  if (e.key === "-" || e.key === "_") return -1;
  return 0;
}

/** FIX V: bump the terminal font live (Ctrl+G + / Ctrl+G -) and re-fit so cols/rows update. */
function zoomTermFont(delta: number) {
  _termFontZoom = Math.max(-12, Math.min(16, _termFontZoom + delta));
  try { localStorage.setItem("cockpit.termFontZoom", String(_termFontZoom)); } catch {}
  if (S.term) {
    try { S.term.options.fontSize = termFontSize(); } catch { try { (S.term as any).setOption("fontSize", termFontSize()); } catch {} }
    fitAndResize();
    try { S.term.refresh(0, S.term.rows - 1); } catch {}
  }
  setStatus(`terminal font ${termFontSize()}px`);
}

/** Reconcile the single live terminal with the panes: mount it into the pane that shows
 *  Terminal (moving it if needed), attach the right session, or tear it down if neither.
 *  PERF: this is a NO-OP when nothing actually changed (same session + same pane + already
 *  mounted) — the periodic 2s data refresh must NOT reconcile, re-fit, or touch the live
 *  xterm/WS. We only (re)mount/move/attach on a REAL change, and never fit() from here. */
function reconcileTerminal() {
  const target: "A" | "B" | null = S.panes.A === "terminal" ? "A" : S.panes.B === "terminal" ? "B" : null;
  const host = $("term-host");
  if (!target) { if (S.termWs || S.termNative || S.term) teardownTerminal(); host.style.display = "none"; S.termPane = null; return; }
  const it = selectedItem();
  const wantSession = _termOverride != null ? _termOverride : it ? it.session.id : null;
  if (wantSession == null) { host.style.display = "none"; S.termPane = null; return; }
  const body = $(`pane-${target}-body`);
  const mountedHere = host.parentElement === body;
  const sameSession = S.termSessionForPane === wantSession && (!!S.termWs || !!S.termNative);
  // Fast path: already showing the right session in the right pane → touch NOTHING.
  if (mountedHere && sameSession && S.termPane === target && host.style.display === "flex") return;
  if (!mountedHere) body.appendChild(host); // MOVE the single terminal here (real change only)
  host.style.display = "flex";
  const paneChanged = S.termPane !== target;
  S.termPane = target;
  observeTermHost(); // (idempotent) watch the host's box so we fit on REAL size changes only
  if (!sameSession) attachTerminalSession(wantSession);
  else if (paneChanged || !mountedHere) scheduleTermRefit(); // fit only when it actually moved
}

// PERF: fit the terminal on ACTUAL box-size changes (ResizeObserver) rather than every
// render. One observer, attached once to the persistent term-host element.
let _termRO: ResizeObserver | null = null;
let _termROsize = { w: 0, h: 0 };
function observeTermHost() {
  if (_termRO || typeof ResizeObserver === "undefined") return;
  const host = document.getElementById("term-host");
  if (!host) return;
  _termRO = new ResizeObserver((entries) => {
    if (!S.term) return;
    const r = entries[0]?.contentRect;
    if (!r) return;
    // ignore sub-pixel jitter; only refit on a meaningful change
    if (Math.abs(r.width - _termROsize.w) < 2 && Math.abs(r.height - _termROsize.h) < 2) return;
    _termROsize = { w: r.width, h: r.height };
    if (r.width > 8 && r.height > 8) fitAndResize();
  });
  _termRO.observe(host);
}

function attachTerminalSession(sid: number) {
  // IDEMPOTENT: if we already have an xterm + a WS that is CONNECTING (0) or OPEN (1) for
  // this exact session, do NOTHING — moving the host, fullscreen toggles, ResizeObserver,
  // and re-renders must never close+reopen the socket (that's the "WebSocket is closed
  // before the connection is established" → black-screen bug). Only a genuinely DIFFERENT
  // session tears down + reopens.
  if (S.termSessionForPane === sid && S.term && ((S.termWs && (S.termWs.readyState === 0 || S.termWs.readyState === 1)) || S.termNative)) {
    applyKeyboardTarget();
    return;
  }
  teardownTerminal();
  S.termSessionForPane = sid;
  _termUsed = false;
  const it = selectedItem();
  const ttl = _termOverride == null && it ? it.session.title : "session";
  $("term-title").textContent = `Live terminal · ${ttl}`;
  const term = makeXterm();
  if (!term) { $("term-foot").textContent = "xterm.js not loaded (need server mode)"; return; }
  // FIX F: the host IS mounted here, so fit to the ACTUAL pane box (force a layout read first),
  // then SPAWN the pty at the FITTED cols/rows — not xterm's default 80×24 — so `claude` starts
  // full-width. proposeDimensions() reads the fitted size even if fit() hasn't applied yet; we
  // resize the xterm to match so the WS query, the xterm, and the pty all agree on open.
  fitAndResize();
  try {
    const d = S.termFit && S.termFit.proposeDimensions && S.termFit.proposeDimensions();
    if (d && d.cols > 20 && d.rows > 6 && (d.cols !== term.cols || d.rows !== term.rows)) term.resize(d.cols, d.rows);
  } catch {}
  // Belt-and-suspenders: re-fit on the next frame once layout fully settles, then push the size
  // to the pty (handles a pane that hadn't reached its final width on this synchronous tick).
  requestAnimationFrame(() => { fitAndResize(); termSizeDiag("rAF"); });
  termSizeDiag("open"); // FIX M PROBLEM 2: log the real container/fit/term numbers
  // Bind input → PTY ONCE for this xterm, targeting whatever the CURRENT socket is (S.termWs).
  // Re-binding per reconnect would double every keystroke — openTermWs reuses THIS xterm and only
  // swaps the socket underneath.
  term.onData((d: string) => termSendInput(d));
  // TRANSPORT CHOICE: inside the Electron desktop app a LOCAL `ssh→tmux` pty is available — use it
  // (bytes go your laptop↔the server over ssh, bypassing this server's WS). In a plain browser (no native
  // bridge) — or for sessions the local path can't safely attach — fall back to the streamed WS.
  if (nativeTerm()) openTermNative(sid, term);
  else openTermWs(sid, term);
  applyKeyboardTarget(); // only grab keyboard if the terminal's pane is actually focused
}

/** The Electron-injected local-terminal bridge, or null in a plain browser. */
function nativeTerm(): any { return (window as any).claudeosNative || null; }

/** FIX WD (desktop): in the Electron app, Chromium/Windows eats some keys before the page ever
 *  sees them (notably Alt+Backspace = the OS "undo" accelerator), so the in-page xterm handler can't
 *  fire. main.js catches those in before-input-event and IPC-forwards the byte(s) to inject here.
 *  Route by focus: the live terminal (either transport) gets the raw byte → word-delete; a focused
 *  text field gets an equivalent in-field word-rubout so its native behavior is preserved.
 *  In a plain browser there's no claudeosNative.onInjectInput → the in-page handler covers it. */
function wireNativeInject() {
  const n = nativeTerm();
  if (!n || typeof n.onInjectInput !== "function") return;
  n.onInjectInput(routeInjectedInput);
}

/** Route a byte the MAIN process injected (e.g. Alt+Backspace → 0x17) by what currently has focus.
 *  Extracted from wireNativeInject so it's unit-testable headless (the Electron IPC half can't run
 *  in the test harness). Exposed as window._routeInjectedInput for the UI tier. */
function routeInjectedInput(d: string) {
  const ae = document.activeElement as HTMLElement | null;
  const inXterm = !!(ae && ae.classList && ae.classList.contains("xterm-helper-textarea"));
  if (inXterm) { termSendInput(d); return; }
  if (d === "\x17" && ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) { deleteWordBackInField(ae as HTMLTextAreaElement); return; }
  if (S.termNative || S.termWs) termSendInput(d); // terminal-first: no editable focus → the live terminal
}

/** Delete the word before the caret in a text field — mirrors Ctrl+W / Alt+Backspace in a shell. */
function deleteWordBackInField(el: HTMLTextAreaElement | HTMLInputElement) {
  const v = el.value ?? "";
  const end = el.selectionStart ?? v.length;
  const selEnd = el.selectionEnd ?? end;
  let i = end;
  while (i > 0 && /\s/.test(v[i - 1])) i--; // eat the whitespace run before the caret
  while (i > 0 && !/\s/.test(v[i - 1])) i--; // eat the word itself
  el.value = v.slice(0, i) + v.slice(selEnd);
  el.selectionStart = el.selectionEnd = i;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Send a keystroke to whichever transport is live (native ssh pty or the WS). */
function termSendInput(d: string) {
  try { (window as any)._lastTermSent = d; } catch {} // debug/test hook (e.g. Alt+Backspace → 0x17)
  const n = nativeTerm();
  if (S.termNative && n) { try { n.write(S.termNative.id, d); } catch {} return; }
  const w = S.termWs;
  if (w && w.readyState === 1) { try { w.send(JSON.stringify({ t: "i", d })); } catch {} }
}

/** Push a resize to whichever transport is live. */
function termSendResize(cols: number, rows: number) {
  const n = nativeTerm();
  if (S.termNative && n) { try { n.resize(S.termNative.id, cols, rows); } catch {} return; }
  if (S.termWs && S.termWs.readyState === 1) { try { S.termWs.send(JSON.stringify({ t: "r", cols, rows })); } catch {} }
}

/** Open the LOCAL (Electron) terminal: ask the server for this session's durable tmux + ssh host,
 *  then have the desktop bridge spawn `ssh -t <host> tmux attach -t claudeos-<id>` in a LOCAL pty
 *  and wire its bytes to THIS xterm. If the server says the session isn't safely attachable
 *  ({ ok:false }) — live agent / bg / non-resumable — fall back to the streamed WS, which keeps the
 *  special server-side handling for those. ssh+tmux own persistence, so there's no custom
 *  reconnect/heartbeat plumbing here (a dropped ssh just ends the pty; reopening re-attaches). */
async function openTermNative(sid: number, term: any) {
  const n = nativeTerm();
  if (!n) { openTermWs(sid, term); return; }
  // NEWEST-OPEN-WINS: openTerm() is async (it awaits /api/term-spec). Without a guard, a second
  // attach for the same session while the first is still awaiting would spawn a SECOND
  // `ssh→tmux attach` pty — both attach to the one durable `claudeos-<id>` tmux, leaking a
  // duplicate client and making tmux flap to the SMALLER client's rows (constant redraw / the
  // "stuck writing" feel + the 88↔89 size churn in the logs). Stamp this open with a monotonic
  // token; any open that's been superseded by a newer one abandons (and closes any pty it spawned).
  const myseq = ++_termOpenSeq;
  $("term-foot").textContent = `attaching (local ssh)… ${term.cols}×${term.rows} · ${masterLabel()} q back`;
  let spec: any;
  try { spec = await (await fetch(`/api/term-spec?sessionId=${sid}`)).json(); } catch { spec = { ok: false }; }
  // Task switched, terminal torn down, or a newer attach raced past us → drop this stale attach.
  if (myseq !== _termOpenSeq || S.termSessionForPane !== sid || !S.term) return;
  if (!spec || !spec.ok) { openTermWs(sid, term); return; } // server handles live/bg/read-only via WS
  // Belt-and-suspenders: never spawn a fresh pty on top of a live one (would leak the old client).
  if (S.termNative) { try { n.close(S.termNative.id); } catch {} S.termNative = null; }
  let handle: any;
  try {
    handle = n.openTerm({ host: spec.host, remote: spec.remote, cols: term.cols, rows: term.rows });
  } catch (e: any) {
    term.write(`\r\n\x1b[31mlocal terminal failed: ${String(e && e.message || e)} — falling back to streamed terminal\x1b[0m\r\n`);
    openTermWs(sid, term); return;
  }
  // A newer open landed while n.openTerm() ran → this pty is orphaned; close it instead of leaking.
  if (myseq !== _termOpenSeq || S.termSessionForPane !== sid || !S.term) { try { n.close(handle.id); } catch {} return; }
  S.termNative = { id: handle.id };
  n.onData(handle.id, (d: any) => { if (S.termNative && S.termNative.id === handle.id) try { term.write(typeof d === "string" ? d : new Uint8Array(d)); } catch {} });
  n.onExit(handle.id, () => {
    if (!S.termNative || S.termNative.id !== handle.id) return;
    // ssh/tmux ended (detach, network drop, or `claudeos-<id>` gone). Show a hint; don't auto-respawn
    // (tmux is durable — reopening the pane re-attaches cleanly).
    try { term.write(`\r\n\x1b[2m[detached — reopen the terminal to re-attach]\x1b[0m\r\n`); } catch {}
    S.termNative = null;
  });
  S.termReconnectAttempts = 0;
  scheduleTermRefit(); applyKeyboardTarget();
}

/** Terminal reconnect tuning. A live socket resets the counter (onopen). We do MAX_TERM_FAST_RECONNECTS
 *  quick backoff tries to ride out a momentary blip, then drop to a calm fixed-interval retry that
 *  self-heals when the session becomes reachable again — instead of either spamming "try N" forever
 *  or giving up permanently. */
const MAX_TERM_FAST_RECONNECTS = 6;
const TERM_SLOW_RECONNECT_MS = 15000;

/** Open (or RE-open) the PTY websocket for `sid` on an EXISTING xterm. Wires output/close/error
 *  (NOT input — that's bound once in attachTerminalSession). On an UNEXPECTED drop it auto-reconnects:
 *  the terminal is just a re-attachable VIEW of the durable `claudeos-<id>` tmux session, so a deploy,
 *  a the network blip, or a dead half-open socket self-heals instead of freezing on a dead screen. */
function openTermWs(sid: number, term: any) {
  // CLOSE-BEFORE-REOPEN: a reconnect (or any re-entry) must never leave the PREVIOUS socket alive.
  // Over the network a dropped socket can sit half-open (readyState still OPEN) with its onmessage
  // still bound — if we just overwrite S.termWs, BOTH sockets keep painting tmux output into the
  // same xterm → every byte is drawn 2–3× ("three letters for every letter I type") and each
  // lingering server-side `tmux attach` leaks as a duplicate tmux client. Tear the old one down
  // first so exactly ONE socket ever feeds this xterm.
  if (S.termWs) {
    const prev = S.termWs;
    prev.onopen = prev.onmessage = prev.onclose = prev.onerror = null;
    try { prev.close(); } catch {}
    S.termWs = null;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // GUARD: a file:// renderer has an EMPTY location.host → `ws:///api/term` (no host) which fails
  // instantly with code 1006 and never recovers ("couldn't connect to the terminal"). The macOS app
  // now loads from the server so this is populated; fall back to the canonical local server if it
  // isn't, so the terminal can still attach instead of silently dead-looping.
  const wsHost = location.host || "localhost:4317";
  const ws = new WebSocket(`${proto}://${wsHost}/api/term?sessionId=${sid}&cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = "arraybuffer";
  S.termWs = ws;
  S.termIntentionalClose = false;
  if (!S.termReconnectAttempts) $("term-foot").textContent = `attaching… ${term.cols}×${term.rows} · ${masterLabel()} q back`;
  ws.onopen = () => {
    S.termReconnectAttempts = 0; // socket is live → reset backoff
    if (S.termReconnectTimer) { clearTimeout(S.termReconnectTimer); S.termReconnectTimer = null; }
    scheduleTermRefit(); applyKeyboardTarget(); requestAnimationFrame(() => termSizeDiag("live"));
  };
  ws.onmessage = (ev: MessageEvent) => { if (typeof ev.data === "string") term.write(ev.data); else term.write(new Uint8Array(ev.data)); };
  ws.onclose = () => { if (S.termWs === ws) scheduleTermReconnect(sid); };
  ws.onerror = () => { if (S.termWs === ws) scheduleTermReconnect(sid); };
}

/** Auto-reconnect the live terminal after an UNEXPECTED socket drop. Backs off 300ms→3s and keeps
 *  retrying until the server returns; the existing xterm is reused and the server re-attaches the
 *  persistent tmux session (redrawing the current screen) on reconnect. No-op if the operator
 *  detached on purpose or moved the pane to a different session/view. */
function scheduleTermReconnect(sid: number) {
  if (S.termIntentionalClose) return;        // user detached / pane switched — don't fight it
  if (S.termSessionForPane !== sid) return;  // pane now wants a different session
  if (!S.term) return;                        // no xterm to reuse
  if (S.termReconnectTimer) return;           // already scheduled
  const n = (S.termReconnectAttempts = (S.termReconnectAttempts || 0) + 1);
  // TWO-PHASE RECONNECT. A live socket resets the counter to 0 in onopen, so a counter that keeps
  // climbing means the WS isn't staying up. The old code retried FOREVER with a 300ms→3s backoff,
  // which spun "reconnecting… (try 161)" forever and pegged the CPU. But the opposite extreme —
  // giving up permanently after N tries — is also wrong: a TRANSIENT outage (the server being
  // redeployed, a VPN blip) would then leave the terminal dead until a manual reopen, even though
  // it would have healed on its own seconds later. So: do a few FAST tries to ride out a blip, then
  // fall back to a calm SLOW retry that self-heals whenever the server returns — without the spam.
  if (n <= MAX_TERM_FAST_RECONNECTS) {
    const delay = Math.min(3000, Math.round(300 * Math.pow(1.7, n - 1)));
    try { $("term-foot").textContent = `● reconnecting… (try ${n}/${MAX_TERM_FAST_RECONNECTS})`; } catch {}
    S.termReconnectTimer = window.setTimeout(() => {
      S.termReconnectTimer = null;
      if (S.termIntentionalClose || S.termSessionForPane !== sid || !S.term) return;
      openTermWs(sid, S.term);
    }, delay);
    return;
  }
  // SLOW PHASE: keep trying every TERM_SLOW_RECONNECT_MS so the terminal heals itself once the
  // session becomes attachable again (server back up, tmux server started, session resumable).
  // Print the explanation ONCE (on the first slow tick) so we don't repaint it every retry.
  if (n === MAX_TERM_FAST_RECONNECTS + 1) {
    try {
      S.term.write(
        `\r\n\x1b[33m● terminal unavailable — couldn't attach after ${MAX_TERM_FAST_RECONNECTS} tries.\x1b[0m\r\n` +
        `\x1b[2m  Likely cause: no tmux server is running, the session's worktree was moved/deleted,\r\n` +
        `  or this session can't be resumed. Retrying in the background — it'll connect automatically\r\n` +
        `  once it's reachable. Press ${masterLabel()} t to retry now.\x1b[0m\r\n`
      );
    } catch {}
  }
  try { $("term-foot").textContent = `⚠ terminal unavailable · auto-retrying… · ${masterLabel()} t to retry now`; } catch {}
  S.termReconnectTimer = window.setTimeout(() => {
    S.termReconnectTimer = null;
    if (S.termIntentionalClose || S.termSessionForPane !== sid || !S.term) return;
    openTermWs(sid, S.term);
  }, TERM_SLOW_RECONNECT_MS);
}

function teardownTerminal() {
  // Any teardown (detach, pane switch, session switch) is INTENTIONAL → stop auto-reconnect so a
  // closing socket's onclose can't resurrect a terminal the operator deliberately left.
  S.termIntentionalClose = true;
  _termOpenSeq++; // invalidate any native attach that's mid-await so it can't resurrect a torn-down term
  if (S.termReconnectTimer) { clearTimeout(S.termReconnectTimer); S.termReconnectTimer = null; }
  S.termReconnectAttempts = 0;
  if (S.termWs) {
    const ws = S.termWs;
    // detach handlers first so a close mid-handshake doesn't fire our onclose UI churn
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch {}
    S.termWs = null;
  }
  if (S.termNative) { const n = nativeTerm(); try { n && n.close(S.termNative.id); } catch {} S.termNative = null; }
  if (S.term) { try { S.term.dispose(); } catch {} S.term = null; }
  S.termSessionForPane = null;
}

/** Detach (master+q / ✕) — the hosting pane reverts to its default view. */
function closeTerminal() {
  if (S.fullPane) setPaneFull(null);
  teardownTerminal();
  _termOverride = null;
  const P = S.termPane; S.termPane = null;
  if (P) { S.panes[P] = paneDefault(P, selectedItem()); S.paneManual[P] = false; S.paneItem[P] = null; }
  setStatus("detached terminal");
  renderPanes();
}

/** Terminal MAXIMIZE — collapse the two-pane split so the TERMINAL fills the entire working
 *  area (full width to the right of the queue + full height); the OTHER pane hides. The QUEUE
 *  column STAYS visible (still navigable with master+↑/↓). The term-host does NOT move to
 *  <body> and the WS is NOT closed/reopened — only the grid layout changes, then FitAddon.fit()
 *  + pty.resize on the SAME pty. (This supersedes the old lift-to-<body> fullscreen that caused
 *  the "WebSocket closed before established" black screen.) */
/** FIX HH: maximize the FOCUSED pane's CURRENT view (terminal / diff / html / overview) to fill the
 *  working area; the other pane collapses. Toggling the same pane (or passing null) restores the
 *  two-pane layout. Generalizes the old terminal-only fullscreen. */
function setPaneFull(pane: "A" | "B" | null) {
  S.fullPane = pane && S.fullPane === pane ? null : pane; // same pane → restore
  S.termFull = S.fullPane != null; // back-compat for any remaining checks
  document.body.classList.toggle("term-max", S.fullPane != null);
  const fhint = $("term-fullhint");
  if (fhint) {
    fhint.textContent = `${masterLabel()} f restore · ${S.fullPane && S.panes[S.fullPane] === "terminal" ? "Ctrl+B → your tmux · " : ""}${masterLabel()} q back`;
    fhint.style.display = S.fullPane ? "block" : "none";
  }
  const btn = document.getElementById("term-full-btn");
  if (btn) btn.textContent = S.fullPane ? "🗗 restore" : "⛶ max";
  applyPaneWidths();
  // if the maximized view is the terminal, re-fit + focus the xterm; else nothing to refit.
  if (S.fullPane && S.panes[S.fullPane] === "terminal") { scheduleTermRefit(); try { S.term && S.term.focus(); } catch {} }
}
/** Back-compat shim: terminal-specific fullscreen (used by the term button / q-exit). */
function setTermFull(on: boolean) { setPaneFull(on ? (S.termPane || S.focused) : null); }
function toggleTermFull() { setPaneFull(S.focused); }

/** Re-fit the xterm to its container once the container actually HAS dimensions, then force
 *  a full repaint. Guards the black-screen bug: fitting at 0×0 yields an empty canvas. */
let _refitTries = 0;
function scheduleTermRefit() {
  _refitTries = 0;
  const tick = () => {
    const xt = document.getElementById("term-xterm");
    const w = xt ? xt.clientWidth : 0, h = xt ? xt.clientHeight : 0;
    if (S.term && (w < 8 || h < 8) && _refitTries < 40) { _refitTries++; requestAnimationFrame(tick); return; }
    fitAndResize();
    try { if (S.term) S.term.refresh(0, S.term.rows - 1); } catch {}
  };
  requestAnimationFrame(tick);
  // belt-and-suspenders: a couple of delayed repaints for slow layout/transition settles
  setTimeout(() => { fitAndResize(); try { S.term && S.term.refresh(0, S.term.rows - 1); } catch {} }, 160);
  setTimeout(() => { fitAndResize(); try { S.term && S.term.refresh(0, S.term.rows - 1); } catch {} }, 360);
}

/** ← / Ctrl+B C: instantly launch a fresh empty Claude terminal in pane B and attach. */
async function newClaudeTerminal() {
  setStatus("opening a new Claude terminal…");
  const r = await api.newSession("claude");
  if (!r || !r.ok) { setStatus("launch failed: " + ((r && r.message) || "unknown")); return; }
  await refresh();
  openTerminalView(r.sessionId!);
}
/** Ctrl+B c: a fresh plain shell (bash) terminal in pane B. */
async function newShellTerminal() {
  setStatus("opening a new shell…");
  const r = await api.newSession("shell");
  if (!r || !r.ok) { setStatus("launch failed: " + ((r && r.message) || "unknown")); return; }
  await refresh();
  openTerminalView(r.sessionId!);
}
/** Review-run "attach" → host that session's terminal in pane B. */
function attachReviewSession(sid: number) { openTerminalView(sid); }

/** FIX K: minimal LEFT-pane overview for a terminal-only session (no queue item) — title, branch,
 *  state — so an opened/resumed terminal looks like a normal two-pane task, not an empty pane. */
function renderSessionOnlyOverview(body: HTMLElement, row: any) {
  const title = esc(row.clean_title || row.title || "session");
  const sub = [row.repo, row.branch].filter(Boolean).map((x: string) => esc(x)).join(" · ");
  body.innerHTML =
    `<div class="card">` +
    `<span class="cat">live session</span>` +
    `<h1>${title}</h1>` +
    (sub ? `<div class="dim" style="margin:6px 0 14px">${sub}</div>` : "") +
    `<div class="dim">This session is open in the terminal on the right. Type there to interact; ` +
    `<kbd>${esc(masterLabel())}</kbd> then <kbd>q</kbd> to close it.</div>` +
    renderQueuePulse() +
    `</div>`;
}

/** FIX K: open a session's live terminal as the NORMAL two-pane task view — overview LEFT,
 *  terminal RIGHT and focused, fitted to the pane. Single entry point for resume / take-over /
 *  new-session / review-attach so none of them bypass the standard layout. */
async function openTerminalView(sid: number) {
  _termOverride = sid;
  if (S.termSessionForPane === sid) teardownTerminal(); // force a fresh spawn (e.g. after take-over)
  S.panes.A = "overview"; // LEFT always defaults to Overview; Diff/HTML live in the detached window
  setPaneView("B", "terminal"); // RIGHT = terminal + focus B + render (FIX F fits after layout)
  // FIX L PART 1: opening a terminal = "working on this now" → bump the task to the TOP and keep
  // it selected as it rises (selection follows the SAME item id, so focus stays on the terminal).
  try {
    await api.activate(sid);
    await refresh();
    const idx = (S.state?.queue || []).findIndex((q: any) => q.session_id === sid);
    if (idx >= 0) { selectIndex(idx); render(); } // FIX U: explicit open → select this task by identity
  } catch {}
  // FIX MM — TERMINAL FOCUS ON OPEN. Explicitly opening a terminal (new session / resume /
  // take-over / review-attach) means the operator wants to TYPE in it. The selectIndex() above
  // sets _navFocus, which makes render() reset focus to the task's default pane (A / overview),
  // stealing keyboard focus away from the just-opened terminal. Re-assert B-focus as the LAST
  // word so a fresh Claude/shell session lands in the terminal, not the answer box. This runs
  // after the task-change render, so it does NOT trigger another default-focus reset.
  if (S.panes.B === "terminal" && S.focused !== "B") { S.focused = "B"; renderPanes(); }
  applyKeyboardTarget();
}

/** FIX J: complete & archive the selected task — durably stops queueing it AND moves its kanban
 *  card to done. Optimistic-advance + toast with undo hint. */
async function completeSelected() {
  const it = selectedItem();
  // TEAM ROW (2026-06-17): a team-group row is synthetic — no single session — so `e` had nothing
  // to act on ("can't Ctrl+G e the team"). Archive the WHOLE team: complete every member session,
  // which removes the team-group row. Undoable per member.
  if (it && (it as any)._team) {
    const kids: number[] = ((it as any).children || []).map((c: any) => c.session_id).filter((x: any) => x != null);
    if (!kids.length) { setStatus("empty team — nothing to archive"); await refresh(); return; }
    optimisticAdvance(it.id);
    setStatus(`✓ archiving team (${kids.length} member${kids.length > 1 ? "s" : ""})…`);
    let ok = 0;
    for (const sid of kids) { const r = await api.complete(sid).catch(() => null); if (r && (r as any).ok) ok++; }
    setStatus(`✓ archived ${ok}/${kids.length} team member${kids.length > 1 ? "s" : ""} · ${S.keymap.undo || "u"} to undo`);
    await refresh();
    return;
  }
  // ARCHIVE IS EXPLICIT — a pin must NOT block it. Clicking ✓ Archive (or ⌘E) on a pinned task
  // used to just advance to the next item WITHOUT archiving (the operator's "archive not working,
  // it just drops me to the next item" report). Completing marks the session completed, so it
  // leaves the queue regardless of the pin; it's undoable (undo restores completed_at AND the pin).
  const sid = it ? it.session.id : selectedSessionId();
  if (sid == null) { setStatus("no task selected to complete"); return; }
  if (it) optimisticAdvance(it.id);
  setStatus("✓ completing…");
  const r = await api.complete(sid).catch((e: any) => ({ ok: false, message: String(e) }));
  if (!r || !r.ok) { setStatus("complete failed" + (r && r.message ? ": " + r.message : "")); await refresh(); return; }
  setStatus(`✓ completed${r.kanbanMoved ? " (kanban → done)" : ""} · ${S.keymap.undo || "u"} to undo`);
  await refresh();
}

/** The session id the take-over acts on: an explicitly-pinned terminal session, else the
 *  selected task's session. */
function selectedSessionId(): number | null {
  if (_termOverride != null) return _termOverride;
  const it = selectedItem();
  return it ? it.session.id : null;
}

/** FIX E: TAKE OVER the selected background agent → kill its exact pid, then open it as a
 *  DEDICATED `claude --resume` terminal (the FIX D idle path). A busy agent prompts to confirm
 *  first (its conversation is preserved by the resume). */
async function takeOverSelected() {
  const sid = selectedSessionId();
  if (sid == null) { setStatus("no session selected to take over"); return; }
  setStatus("checking agent…");
  const r = await api.takeOver(sid, false).catch((e: any) => ({ ok: false, error: String(e) }));
  // E-REPURPOSE: a cc-daemon-managed bg agent can't be killed durably (it respawns). Tell the
  // operator to STOP it in their `claude agents` view (Ctrl+X); FIX I then resumes it here
  // INSTANTLY the moment its process is gone — no kill, no respawn race.
  if (r && r.needsManualStop) {
    showConfirm(
      `<b>${esc(r.name || "This agent")}</b> is a background agent managed by your <code>claude agents</code> daemon.<br><br>` +
      `Killing it isn't durable (the daemon respawns it). To convert it to a dedicated terminal:<br>` +
      `<b>1.</b> Open your <code>claude agents</code> view and <b>stop it (Ctrl+X)</b>.<br>` +
      `<b>2.</b> Then open its terminal here — it resumes instantly via <code>claude --resume</code>.<br><br>` +
      `<span class="dim">Press <kbd>Enter</kbd> to dismiss.</span>`,
      async () => { closeOverlays(); }
    );
    setStatus("stop it in your agents view (Ctrl+X), then reopen here");
    return;
  }
  finishTakeOver(sid, r);
}

function finishTakeOver(sid: number, r: any) {
  if (!r || !r.ok) { setStatus("take-over failed" + (r && r.error ? ": " + r.error : "")); return; }
  // Already stopped / not a live daemon agent → it's directly resumable now (FIX I).
  setStatus("opening dedicated terminal…");
  openTerminalView(sid); // FIX K: normal two-pane layout, terminal right + focused, fitted
}

/** E-REPURPOSE: there's no safe bulk kill (daemon agents respawn). Point the operator at the
 *  agents view to stop them (Ctrl+X); each then resumes here instantly via FIX I. */
async function takeOverAllAgents() {
  const agents = await api.takeOverable().catch(() => []);
  const n = (agents || []).length;
  showConfirm(
    `You have <b>${n}</b> background agent${n === 1 ? "" : "s"} managed by the <code>claude agents</code> daemon.<br><br>` +
    `These can't be bulk-killed (the daemon respawns them). To migrate them to dedicated terminals, <b>stop each in your <code>claude agents</code> view (Ctrl+X)</b> — then open it here and it resumes instantly via <code>claude --resume</code>.<br><br>` +
    `<span class="dim">Press <kbd>Enter</kbd> to dismiss.</span>`,
    async () => { closeOverlays(); }
  );
}

/** The text of the most recent terminal selection→clipboard copy. Observable hook for the UI
 *  click-through test (the real OS clipboard isn't reliably readable from headless chromium over
 *  http), and handy when debugging "did select-to-copy actually fire?". */
let _lastTermCopy = "";

/** Copy text to the clipboard, resilient to an insecure (http) context where navigator.clipboard
 *  is blocked. The async clipboard API is ONLY usable in a secure context — over plain http (the
 *  operator's `http://localhost:4317`) `navigator.clipboard` may be present yet `writeText()`
 *  REJECTS, and its `.catch` runs in a later microtask AFTER the user-gesture window has closed, so
 *  the execCommand fallback inside it silently no-ops (the bug the operator hit). So gate on
 *  `isSecureContext`: secure → async API; otherwise run the synchronous textarea+execCommand path
 *  RIGHT NOW, inside the calling gesture (mouseup), where execCommand is still permitted. */
function copyTextToClipboard(text: string): boolean {
  try {
    if (window.isSecureContext && (navigator as any).clipboard && (navigator as any).clipboard.writeText) {
      (navigator as any).clipboard.writeText(text).catch(() => fallbackCopy(text));
      return true;
    }
  } catch {}
  return fallbackCopy(text);
}
function fallbackCopy(text: string): boolean {
  try {
    const prev = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "0"; ta.style.left = "-9999px"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    // CRITICAL: execCommand("copy") copies the *focused* element's selection. xterm draws its
    // selection on a canvas (NOT a DOM Selection), so without focusing+selecting the textarea the
    // copy command sees an empty document selection and copies nothing. Focus the textarea, select
    // its whole value, copy, then restore focus so we don't steal it from the terminal.
    ta.focus();
    ta.select();
    try { ta.setSelectionRange(0, text.length); } catch {}
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
    try { prev && prev.focus(); } catch {}
    return ok;
  } catch { return false; }
}

function makeXterm() {
  const Term = (window as any).Terminal;
  const FitAddonNS = (window as any).FitAddon;
  if (!Term) return null;
  if (S.term) { try { S.term.dispose(); } catch {} S.term = null; }
  const term = new Term({
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: '"JetBrains Mono","Fira Code",Menlo,Consolas,"DejaVu Sans Mono",monospace',
    fontSize: termFontSize(), // FIX V: config terminal_font_size (default 15) + live Ctrl+G +/- zoom
    scrollback: 5000,
    theme: {
      background: "#0d1117", foreground: "#d1d5db", cursor: "#58a6ff",
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
      brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
  });
  const el = $("term-xterm");
  el.innerHTML = "";
  term.open(el);
  // FIX R: PASTE via the browser `paste` EVENT (works in an insecure http context, unlike the
  // async clipboard API). Inject the clipboard TEXT straight into the PTY (same path as typing).
  // If the clipboard has ONLY an image (no text), show an inline notice instead of sending a raw
  // keystroke — the PTY is text-only and claude can't see the your laptop's clipboard image.
  el.addEventListener("paste", (ev: Event) => {
    const e = ev as ClipboardEvent;
    const cd = e.clipboardData;
    if (!cd) return;
    const text = cd.getData("text/plain");
    if (text) {
      e.preventDefault();
      if (S.termWs && S.termWs.readyState === 1) { try { S.termWs.send(JSON.stringify({ t: "i", d: text })); } catch {} }
      _termTypedSinceNav = true; // TYPE-AWARE NAV: pasting counts as typing here
      if (!_termUsed) { _termUsed = true; try { S.termWs && S.termWs.readyState === 1 && S.termWs.send(JSON.stringify({ t: "used" })); } catch {} }
      return;
    }
    const hasImage = Array.from(cd.items || []).some((it) => it.type && it.type.startsWith("image/"));
    if (hasImage) {
      e.preventDefault();
      try { S.term && S.term.write("\r\n\x1b[33m● image paste isn't supported in the web terminal — save the image on the server and reference its path.\x1b[0m\r\n"); } catch {}
    }
  });
  // SELECTION → CLIPBOARD: like a normal terminal, auto-copy whatever you select (drag, or
  // double/triple-click) — no Ctrl/⌘ needed; paste stays on the usual key/middle-click, so the
  // pty input path is untouched. Two complementary triggers, neither hijacks normal terminal use:
  //
  //  • onSelectionChange (xterm's selection API): in a SECURE context the async clipboard API can
  //    copy without stealing focus, so copy live as the selection changes — this also covers
  //    keyboard/programmatic selection that never fires a mouseup. We DON'T run the textarea
  //    fallback here: focusing a transient textarea mid-drag would interrupt xterm's drag-select.
  //  • mouseup (a real user gesture): after the drag completes, run the FULL robust copy
  //    (copyTextToClipboard → execCommand fallback). execCommand is only permitted inside a user
  //    gesture, so this is where the insecure-http path actually lands the text on the clipboard.
  const recordSelection = (sel: string) => { _lastTermCopy = sel; try { (window as any)._lastTermCopy = sel; } catch {} };
  term.onSelectionChange(() => {
    try {
      const sel = term.getSelection();
      if (!sel) return;
      recordSelection(sel);
      if (window.isSecureContext && (navigator as any).clipboard && (navigator as any).clipboard.writeText) {
        (navigator as any).clipboard.writeText(sel).catch(() => {});
      }
    } catch {}
  });
  el.addEventListener("mouseup", () => {
    try { const sel = term.getSelection(); if (sel) { copyTextToClipboard(sel); recordSelection(sel); } } catch {}
    setTimeout(() => { try { term.focus(); } catch {} }, 0);
  });
  if (FitAddonNS && FitAddonNS.FitAddon) {
    try { S.termFit = new FitAddonNS.FitAddon(); term.loadAddon(S.termFit); } catch {}
  }
  // P4: GPU-fast renderer (WebGL) so dumping lots of claude/diff output stays smooth; fall
  // back silently to the default DOM renderer if WebGL is unavailable or the context is lost.
  try {
    const WebglNS = (window as any).WebglAddon;
    if (WebglNS && WebglNS.WebglAddon) {
      const wgl = new WebglNS.WebglAddon();
      wgl.onContextLoss(() => { try { wgl.dispose(); } catch {} });
      term.loadAddon(wgl);
    }
  } catch {}
  // PLAIN-DRAG COPY (no Shift): with tmux `mouse on` a drag is consumed by tmux, so xterm makes NO
  // local selection — the onSelectionChange/mouseup copy above never sees it. Instead tmux (with
  // `set-clipboard on` + the `clipboard` terminal-feature, both set in ~/.tmux.conf) emits an OSC 52
  // escape carrying the selected text; the ClipboardAddon decodes it and hands it to THIS provider.
  // We route it through the SAME resilient copyTextToClipboard: secure context → async clipboard API;
  // insecure http → synchronous execCommand, still permitted because the OSC 52 round-trips within
  // the just-released mouse gesture's activation window. readText is a deliberate no-op — we never
  // let a program inside the terminal READ the operator's clipboard (write-only is the safe default).
  try {
    const ClipNS = (window as any).ClipboardAddon;
    if (ClipNS && ClipNS.ClipboardAddon) {
      const provider = {
        readText: () => Promise.resolve(""),
        writeText: (_sel: string, data: string) => {
          try { if (data) { copyTextToClipboard(data); recordSelection(data); } } catch {}
          return Promise.resolve();
        },
      };
      term.loadAddon(new ClipNS.ClipboardAddon(undefined, provider));
    }
  } catch {}
  // The cockpit MASTER key (default Ctrl+G) is the ONLY key intercepted before the PTY —
  // it switches panes / fullscreen / focus, and works even inside the terminal. EVERYTHING
  // else — including Ctrl+B (now 100% the inner tmux's), Esc, Ctrl+U/C/A/E/K/W, arrows,
  // Tab, slash-autosuggest — goes straight to the real Claude/tmux session.
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") return true;
    // An open overlay OWNS the keyboard — even when the xterm still holds DOM focus (an overlay
    // opened via the master chord from inside the terminal, e.g. help or the merge confirm, has
    // no input of its own so focus stays here). Returning false makes xterm ignore the key while
    // the event propagates to the window handler → handleOverlayKey (Esc closes, Enter confirms).
    // Without this, Esc/Enter typed into the pty UNDER the overlay and it could never be closed.
    if (overlayOpen()) return false;
    // MAC ⌘ SHORTCUTS work even while typing to Claude (⌘ ≠ terminal control char). Handle + swallow
    // so xterm doesn't also send the keystroke to the pty. ⌘C/⌘V/etc. fall through (copy/paste).
    if (runMacShortcut(e)) { e.preventDefault(); e.stopPropagation(); return false; }
    // The master key is owned HERE while the terminal is focused (single-dispatch:
    // stopPropagation so the global window handler never double-processes it).
    if (S.leaderActive) { e.preventDefault(); e.stopPropagation(); runMasterCmd(e); return false; }
    if (isMasterKey(e)) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) startMaster(); return false; }
    // TERMINAL-FIRST NAV, TYPE-AWARE (operator requests 2026-06-10 + 2026-06-11): on a FRESH
    // landing (explicit nav, nothing typed yet) plain ↑/↓ walk the queue — ride the task list
    // without leaving the terminal. The moment the operator TYPES anything into this terminal
    // (a letter, Enter, paste, …) the arrows belong to the pty again — claude prompt history,
    // menus — until the next explicit task nav re-arms queue mode. Shift+↑/↓ always sends a
    // REAL arrow to the pty; master+↑/↓ always walks the queue (escape hatches both ways).
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey || _termTypedSinceNav) { _termTypedSinceNav = true; termSendInput(e.key === "ArrowUp" ? "\x1b[A" : "\x1b[B"); }
      else moveQueueSel(e.key === "ArrowUp" ? -1 : 1);
      return false;
    }
    // FIX H: in the live terminal, Ctrl+Enter (or Cmd+Enter) inserts a NEWLINE in claude's prompt
    // instead of submitting — send 0x0A (Ctrl+J / "\n") to the pty and SWALLOW the key so xterm
    // doesn't also emit its default. Plain Enter falls through → xterm sends "\r" (0x0D) → claude
    // submits as normal.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); e.stopPropagation();
      if (S.termWs && S.termWs.readyState === 1) { try { S.termWs.send(JSON.stringify({ t: "i", d: "\n" })); } catch {} }
      return false;
    }
    // FIX CC: in the terminal, plain Ctrl/Cmd +/- zooms the TERMINAL font (not the page). Swallow.
    { const z = isZoomKey(e); if (z) { e.preventDefault(); e.stopPropagation(); zoomTermFont(z); return false; } }
    // FIX WD: Alt+Backspace (Option+Backspace) → DELETE THE PREVIOUS WORD, exactly like Ctrl+W.
    // xterm's own default for Alt+Backspace is ESC+DEL (\x1b\x7f); some apps in the pane (and some
    // client OS/browser layers that eat the bare Alt) don't honor it, so it silently does nothing.
    // We make it bullet-proof by sending the SAME byte Ctrl+W sends — 0x17 (C0 ETB = unix
    // word-rubout) — which every shell and claude's input box already treat as delete-word. Swallow
    // the key so xterm doesn't ALSO emit its \x1b\x7f. (Ctrl+Alt+Backspace is left to xterm.)
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === "Backspace") {
      e.preventDefault(); e.stopPropagation();
      _termTypedSinceNav = true; // TYPE-AWARE NAV: editing here means plain ↑/↓ belong to the pty
      if (!_termUsed) { _termUsed = true; if (S.termWs && S.termWs.readyState === 1) { try { S.termWs.send(JSON.stringify({ t: "used" })); } catch {} } }
      termSendInput("\x17");
      return false;
    }
    // FIX R: let Ctrl+V / Cmd+V trigger the browser's NATIVE paste EVENT (handled below) instead of
    // xterm sending raw 0x16 — claude misreads 0x16 as image-paste ("can't find any images"). We
    // MUST use the paste event because ClaudeOS is served over http (insecure context), where
    // navigator.clipboard.readText() is blocked. Returning false makes xterm ignore the key while
    // the browser still fires `paste` on the focused textarea. (Ctrl+Shift+V also works.)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "v" || e.key === "V")) return false;
    // A REAL operator keystroke is about to reach the PTY → mark the session "used" once
    // (so a provisional new session is promoted, not discarded). Pure modifier presses
    // and xterm's automatic terminal-query responses do NOT count.
    if (e.key && e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") {
      _termTypedSinceNav = true; // TYPE-AWARE NAV: from now on plain ↑/↓ belong to THIS pty
      if (!_termUsed) {
        _termUsed = true;
        if (S.termWs && S.termWs.readyState === 1) { try { S.termWs.send(JSON.stringify({ t: "used" })); } catch {} }
      }
    }
    return true;
  });
  // SCROLL FIX (operator report 2026-06-11): every ClaudeOS terminal is a tmux client, so the
  // xterm sits in the ALTERNATE buffer (no local scrollback). xterm.js's built-in fallback for
  // a wheel in the alt buffer is to synthesize ↑/↓ ARROW KEYS — which land in claude's prompt
  // box and cycle prompt HISTORY instead of scrolling. That fallback only fires when the outer
  // mouse-tracking state is off/lost (e.g. a replayed pty that predates the mode re-assert);
  // when tracking is live the wheel becomes a normal mouse report and tmux scrolls via
  // copy-mode. Make the broken state behave like the healthy one: swallow the wheel and write
  // the SGR wheel report OURSELVES — tmux has `mouse on`, so it enters copy-mode and scrolls
  // real history. Net effect: the wheel ALWAYS scrolls, never time-travels the prompt.
  _wheelAcc = 0;
  term.attachCustomWheelEventHandler((ev: WheelEvent) => {
    try {
      const modes = (term as any).modes;
      if (modes && modes.mouseTrackingMode && modes.mouseTrackingMode !== "none") return true; // healthy: xterm reports the wheel → tmux copy-mode
      const buf = term.buffer && term.buffer.active;
      if (!buf || buf.type !== "alternate") return true; // normal buffer: xterm scrolls its own scrollback
      if (!ev.deltaY) return false; // horizontal-only: nothing to do, but never let arrows synth
      ev.preventDefault();
      const host = $("term-xterm");
      const r = host.getBoundingClientRect();
      const cellH = Math.max(1, r.height / Math.max(1, term.rows));
      // Convert px → lines (damped for small trackpad deltas) → REPORTS with fractional carry.
      // tmux's copy-mode wheel binding scrolls 5 LINES PER REPORT (send-keys -X -N 5), so one
      // report ≈ one wheel notch — sending one report per line made each notch scroll ~5× too
      // far (operator report 2026-06-11: "scrolls very very fast").
      const TMUX_LINES_PER_REPORT = 5;
      _wheelAcc += (ev.deltaY / cellH) * (Math.abs(ev.deltaY) < 50 ? 0.3 : 1) / TMUX_LINES_PER_REPORT;
      const n = Math.trunc(_wheelAcc);
      if (!n) return false;
      _wheelAcc -= n;
      // SGR wheel report; 1-based cell coords (tmux only uses them to pick the pane)
      const col = Math.max(1, Math.min(term.cols, 1 + Math.floor((ev.clientX - r.left) / Math.max(1, r.width / Math.max(1, term.cols)))));
      const row = Math.max(1, Math.min(term.rows, 1 + Math.floor((ev.clientY - r.top) / cellH)));
      const btn = n < 0 ? 64 : 65; // 64 = wheel up, 65 = wheel down
      termSendInput(`\x1b[<${btn};${col};${row}M`.repeat(Math.min(30, Math.abs(n))));
      return false; // handled — xterm must NOT synthesize arrow keys
    } catch { return true; }
  });
  S.term = term;
  try { (window as any).cockpitTerm = term; } catch {} // debug/test hook (select-to-copy UI test)
  return term;
}

/** FIX O: render the session's visualization HTML in a SANDBOXED iframe filling pane A, with a
 *  tab strip when there are multiple files. The iframe is re-created only when the session/tab
 *  actually changes (so the periodic state poll never reloads + flickers it). */
let _vizMountedKey = "";
function renderHtmlInto(body: HTMLElement, P: "A" | "B") {
  const viz = currentViz();
  const it = selectedItem();
  const sid = it ? it.session.id : (_termOverride ?? null);
  if (!viz.length || sid == null) { _vizMountedKey = ""; body.innerHTML = `<div class="empty">No visualization for this task.</div>`; return; }
  const sel = Math.min(Math.max(0, S.vizTab), viz.length - 1);
  // Key on the file's mtime (+ count) too, NOT just pane:session:tab. When the HTML is regenerated
  // in place (same path) or a newer html lands in the same "latest" slot, the mtime changes → the
  // key changes → the iframe re-mounts and the view auto-updates. Without this the key is sticky and
  // the iframe is never reloaded — which is why the detached detail window (it only clears the key
  // when the selected TASK changes, never on content churn) kept showing stale HTML until a hard
  // reload. mtime in /api/state refreshes within ~10s (controller.sessionViz cache).
  const ver = (viz[sel] && viz[sel].mtime) || 0;
  const key = `${P}:${sid}:${sel}:${ver}:${viz.length}`;
  if (_vizMountedKey === key && body.querySelector("iframe.viz-frame")) return; // already showing
  _vizMountedKey = key;
  // Tabs are newest-first (viz.ts mtime-desc). Show each html's age, and badge tab 0 as the LATEST
  // so when a task has many htmls it's obvious which to look at now.
  const tabs = viz.length > 1
    ? `<div class="viz-tabs">${viz.map((v, i) => {
        const age = v.mtime ? timeAgo(new Date(v.mtime).toISOString()) : "";
        const latest = i === 0 ? `<span class="viz-tab-latest">latest</span>` : "";
        const ageEl = age ? `<span class="viz-tab-age">${esc(age)}</span>` : "";
        return `<span class="viz-tab${i === sel ? " active" : ""}${i === 0 ? " viz-tab--latest" : ""}" data-i="${i}" title="${escAttr(v.file)}">${latest}${esc(v.name)}${ageEl}</span>`;
      }).join("")}</div>`
    : "";
  body.innerHTML = `${tabs}<iframe class="viz-frame" sandbox="allow-scripts allow-same-origin" src="/api/viz/${sid}/${sel}?v=${ver}"></iframe>`;
  body.querySelectorAll(".viz-tab").forEach((el) =>
    el.addEventListener("click", () => { S.vizTab = parseInt((el as HTMLElement).dataset.i!, 10); _vizMountedKey = ""; renderPane(P); }));
}

function fitAndResize() {
  if (!S.term || !S.termFit) return;
  try { S.termFit.fit(); } catch {}
  termSendResize(S.term.cols, S.term.rows);
}

/** FIX M PROBLEM 2: terminal-size DIAGNOSTICS. Logs (console + term footer) the REAL numbers so
 *  the operator can read why a terminal is small: pane-B container box, the xterm host box, what
 *  fitAddon.proposeDimensions() returns, and the final term.cols×rows. A ~0 container height ⇒ a
 *  CSS/layout (0-height) problem; a tiny proposeDimensions with a real box ⇒ a fit-timing problem. */
function termSizeDiag(phase: string) {
  try {
    const host = document.getElementById("term-xterm");
    const paneB = document.getElementById("pane-B-body");
    const cw = host ? host.clientWidth : 0, ch = host ? host.clientHeight : 0;
    const pw = paneB ? paneB.clientWidth : 0, ph = paneB ? paneB.clientHeight : 0;
    let pd: any = null;
    try { pd = S.termFit && S.termFit.proposeDimensions && S.termFit.proposeDimensions(); } catch {}
    const cols = S.term ? S.term.cols : 0, rows = S.term ? S.term.rows : 0;
    const msg = `[term ${phase}] paneB ${pw}×${ph} · host ${cw}×${ch} · propose ${pd ? pd.cols + "×" + pd.rows : "n/a"} · term ${cols}×${rows}`;
    // eslint-disable-next-line no-console
    console.log(msg);
    const foot = document.getElementById("term-foot");
    if (foot) foot.textContent = `● live ${cols}×${rows} · host ${cw}×${ch} · propose ${pd ? pd.cols + "×" + pd.rows : "n/a"} · ${masterLabel()} q back`;
    // FIX T: POST the numbers so they're readable SERVER-SIDE (the operator's browser is remote).
    try {
      (api as any).diag && (api as any).diag({
        phase, sessionId: S.termSessionForPane,
        paneB_w: pw, paneB_h: ph, host_w: cw, host_h: ch,
        propose_cols: pd ? pd.cols : null, propose_rows: pd ? pd.rows : null,
        term_cols: cols, term_rows: rows,
      });
    } catch {}
  } catch {}
}

// ---------- inline GitHub-style split diff, per pane (diff2html + Viewed) ----------
const _diffViewed: { A: Record<string, boolean>; B: Record<string, boolean> } = { A: {}, B: {} };

/** Load + render the diff for `it` into pane `P` (header + diff2html body). Content is
 *  keyed to the item id; a stale load (task changed mid-fetch) is dropped. */
/** FIX X: the GitHub PR for a session, from /api/state (cached/bg-detected), or null. */
function sessionPrFor(sessionId: number): any | null {
  if (!S.state) return null;
  const e = (S.state.sessions || []).find((s: any) => s.row && s.row.id === sessionId);
  return (e && e.pr) || null;
}

// PR-CONV: per-pane state for the redesigned PR header (ages + prteam badge) and the
// Conversation tab (the GitHub PR page's comments/reviews/threads pulled as a timeline).
const _prConv: { A: any | null; B: any | null } = { A: null, B: null };
const _prConvAt: { A: number; B: number } = { A: 0, B: 0 };
const _prConvReq: { A: number; B: number } = { A: 0, B: 0 }; // request token — newest call wins
const _prTab: { A: "diff" | "conv"; B: "diff" | "conv" } = { A: "diff", B: "diff" };
// what the bar was last rendered for, so async fills (gh is slow) can re-render in place
const _prBarCtx: { A: { sid: number; seed: any } | null; B: { sid: number; seed: any } | null } = { A: null, B: null };

function escAttr(s: string): string { return esc(s).replace(/"/g, "&quot;"); }
/** Tiny markdown-ish formatter for PR comment bodies (esc first — never trusts GitHub text). */
function mdLite(s: string): string {
  let h = esc(s || "");
  h = h.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, _lang, code) => `<pre>${code}</pre>`);
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/(https?:\/\/[^\s<"]+)/g, (m) => `<a href="${m}" target="_blank" rel="noopener">${m}</a>`);
  return h;
}
/** Merge PR shapes, later objects win but never with empty values (SessionPr lacks head/adds…). */
function mergePrInfo(...objs: any[]): any {
  const o: any = {};
  for (const x of objs) for (const k in x || {}) { const v = (x as any)[k]; if (v !== undefined && v !== null && v !== "") o[k] = v; }
  return o;
}

/** FIX X: render the PR header bar + Merge button into #pr-bar-P. Uses the cached PR immediately,
 *  then lazily refreshes via api.prConversation (gh — also brings ages/reviews/timeline) so a
 *  session whose PR isn't cached yet still shows. */
async function renderPrBar(P: "A" | "B", sessionId: number, seedPr?: any) {
  _prBarCtx[P] = { sid: sessionId, seed: seedPr || null };
  fillPrBar(P);
  loadPrConversation(P, sessionId);
}

function fillPrBar(P: "A" | "B") {
  const ctx = _prBarCtx[P];
  const bar = document.getElementById(`pr-bar-${P}`);
  if (!bar || !ctx) return;
  const sessionId = ctx.sid;
  const conv = _prConv[P] && _prConv[P].ok ? _prConv[P] : null;
  const pr = mergePrInfo(ctx.seed, sessionPrFor(sessionId), conv && conv.pr);
  if (!pr.number) { bar.innerHTML = ""; return; }
  // MERGED-STATE: once a PR is merged, the merge button is meaningless and the tiny grey "merged"
  // chip is too easy to miss — so when merged we recolor the WHOLE bar (purple, GitHub-style),
  // swap the state chip for a bold "✅ Merged" pill, drop the now-irrelevant draft/mergeable/review
  // chips, and replace the Merge button with a non-clickable merged badge.
  const isMerged = /^MERGED$/i.test(String(pr.state || "")) || /^merged$/i.test(String(pr.reviewDecision || ""));
  const draft = !isMerged && pr.draft ? `<span class="pr-chip draft">draft</span>` : "";
  const mergeable = !isMerged && pr.mergeable ? `<span class="pr-chip ${/CLEAN|MERGEABLE/i.test(pr.mergeable) ? "ok" : "warn"}">${esc(String(pr.mergeable).toLowerCase())}</span>` : "";
  const rev = !isMerged && pr.reviewDecision ? `<span class="pr-chip ${/^APPROVED$/i.test(pr.reviewDecision) ? "ok" : /CHANGES/i.test(pr.reviewDecision) ? "warn" : ""}">${esc(String(pr.reviewDecision).toLowerCase().replace(/_/g, " "))}</span>` : "";
  const stateChip = isMerged
    ? `<span class="pr-chip merged">✅ merged</span>`
    : `<span class="pr-chip">${esc((pr.state || "open").toLowerCase())}</span>`;
  const refs = pr.head && pr.base
    ? ` <span class="pr-refs"><span class="pr-ref head">${esc(pr.head)}</span><span class="pr-arrow">→</span><span class="pr-ref base">${esc(pr.base)}</span></span>`
    : pr.base ? ` <span class="dim">→ ${esc(pr.base)}</span>` : "";
  // row 2: counts + ages + prteam badge (dim placeholders until the conversation pull lands;
  // a FAILED pull collapses them to one "details unavailable" note instead of "…" forever)
  const convErr = _prConv[P] && !_prConv[P].ok ? String(_prConv[P].error || "unavailable") : null;
  const adds = pr.additions != null ? `<span class="pr-adds">+${pr.additions}</span><span class="pr-dels">−${pr.deletions ?? 0}</span>` : "";
  const meta = conv && conv.meta ? conv.meta : null;
  const opened = meta && meta.createdAt
    ? `<span class="pr-meta-item" title="${escAttr(meta.createdAt)}">opened <b>${timeAgo(meta.createdAt)}</b>${pr.author ? ` by ${esc(pr.author)}` : ""}</span>`
    : convErr ? `<span class="pr-meta-item dim" title="${escAttr(convErr)}">details unavailable</span>` : `<span class="pr-meta-item dim">opened …</span>`;
  const lastCommit = meta
    ? (meta.lastCommitAt
        ? `<span class="pr-meta-item" title="${escAttr(meta.lastCommitAt)}">last commit <b>${timeAgo(meta.lastCommitAt)}</b> · ${meta.commitCount} commit${meta.commitCount === 1 ? "" : "s"}</span>`
        : `<span class="pr-meta-item dim">no commits</span>`)
    : convErr ? "" : `<span class="pr-meta-item dim">last commit …</span>`;
  // prteam badge: latest run's verdict colors it; click jumps to the Conversation tab
  let badge: string;
  if (convErr) badge = "";
  else if (!conv) badge = `<span class="prteam-badge none">reviews …</span>`;
  else {
    const runs = conv.reviews || []; // newest first
    const pt = runs.filter((r: any) => r.type === "prteam");
    const pq = runs.filter((r: any) => r.type === "pr");
    const mk = (label: string, list: any[]) => {
      // latest KNOWN verdict colors the badge (loose marker-less runs have verdict unknown)
      const v = (list.find((r: any) => r.verdict)?.verdict || "").toUpperCase();
      const cls = v === "GREEN" ? "green" : v === "RED" ? "red" : "none";
      const tip = (list[0].summary || "").split("\n").find((l: string) => l.trim()) || "";
      const vTxt = v === "GREEN" ? " · ✅ GREEN" : v === "RED" ? " · ❌ RED" : v ? ` · ${esc(v)}` : "";
      return `<span class="prteam-badge ${cls} pr-conv-link" data-p="${P}" title="${escAttr(tip)} — click for the conversation">${label} ×${list.length}${vTxt}</span>`;
    };
    badge = pt.length ? mk("/prteam", pt) : pq.length ? mk("/pr", pq) : `<span class="prteam-badge none" title="no /pr or /prteam review comments on this PR yet">no reviews yet</span>`;
  }
  // tab count = discussion items only (a 40-commit PR with 2 comments is not "Conversation 42")
  const nThread = conv && conv.thread ? conv.thread.filter((t: any) => t.kind !== "commit").length : 0;
  const tabs =
    `<span class="pr-tabs">` +
    `<button class="pr-tab${_prTab[P] === "diff" ? " active" : ""}" data-p="${P}" data-tab="diff">Diff</button>` +
    `<button class="pr-tab${_prTab[P] === "conv" ? " active" : ""}" data-p="${P}" data-tab="conv">Conversation${nThread ? `<span class="pr-tab-n">${nThread}</span>` : ""}</button>` +
    `</span>`;
  // no URL yet (seed/marker PR before the conversation pull) → plain span, not an href="" self-link
  const numEl = pr.url
    ? `<a href="${escAttr(pr.url)}" target="_blank" rel="noopener" class="pr-num">PR #${pr.number}</a>`
    : `<span class="pr-num">PR #${pr.number}</span>`;
  // merged → a static badge instead of a live Merge button (nothing left to merge).
  const mergeAction = isMerged
    ? `<span class="pr-merged-badge" title="this PR is merged">✅ Merged</span>`
    : // FIX AA: NO per-element listener — the delegated document handler routes .pr-merge-btn clicks.
      `<button class="term-btn danger pr-merge-btn" data-sid="${sessionId}">⇲ Merge</button>`;
  bar.innerHTML =
    `<div class="pr-bar pr-bar2${isMerged ? " pr-bar-merged" : ""}">` +
    `<div class="pr-bar-row"><span class="pr-bar-main">${numEl} ` +
    `<span class="pr-bar-title" title="${escAttr(pr.title || "")}">${esc(pr.title || "")}</span> ${stateChip}${draft}${mergeable}${rev}${refs}</span>` +
    `<span class="pr-bar-actions">${tabs}${mergeAction}</span></div>` +
    `<div class="pr-bar-meta">${adds}${opened}${lastCommit}${badge}</div>` +
    `</div>`;
  // keep the diff-toolbar's own "⇲ Merge" control consistent with the merged state (it's rendered
  // synchronously before the conversation pull lands, so toggle it here once we know).
  const mergeWrap = document.getElementById(`diff-merge-wrap-${P}`);
  if (mergeWrap) mergeWrap.style.display = isMerged ? "none" : "";
}

/** PR-CONV: fetch the PR conversation (server-cached 45s) for pane P and re-render the bar
 *  (ages + badge) and, if the Conversation tab is open, the timeline. A request TOKEN (not a
 *  boolean) gates stale responses: switching tasks mid-fetch must not swallow the new task's
 *  load — the newest call always proceeds and always wins. */
async function loadPrConversation(P: "A" | "B", sessionId: number, force = false) {
  if (!force && _prConv[P] && Date.now() - _prConvAt[P] < 60_000) return;
  const req = ++_prConvReq[P];
  const reqItem = S.paneItem[P];
  try {
    const r = await api.prConversation(sessionId, force);
    if (_prConvReq[P] !== req || S.paneItem[P] !== reqItem) return; // superseded / task changed → drop
    _prConv[P] = r || null;
    _prConvAt[P] = Date.now();
  } catch {
    // transport-level failure (server unreachable) — record it so the bar shows "details
    // unavailable" instead of "…" forever; tab switch / ↻ retries as usual
    if (_prConvReq[P] !== req || S.paneItem[P] !== reqItem) return;
    _prConv[P] = { ok: false, error: "cockpit server unreachable" };
    _prConvAt[P] = Date.now();
  }
  fillPrBar(P);
  if (_prTab[P] === "conv") renderConversation(P);
}

/** PR-CONV: switch a diff pane between the Diff and Conversation tabs. The diff2html DOM stays
 *  mounted (display toggle only) so switching back is instant. */
function setPrTab(P: "A" | "B", tab: "diff" | "conv") {
  _prTab[P] = tab;
  const two = document.querySelector(`#pane-${P}-body .diff-2col`) as HTMLElement | null;
  const conv = document.getElementById(`pr-conv-${P}`);
  if (two) two.style.display = tab === "conv" ? "none" : "";
  if (conv) (conv as HTMLElement).style.display = tab === "conv" ? "" : "none";
  document.querySelectorAll(`#pr-bar-${P} .pr-tab`).forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.tab === tab));
  if (tab === "conv") {
    renderConversation(P);
    const ctx = _prBarCtx[P];
    if (ctx && Date.now() - _prConvAt[P] > 60_000) loadPrConversation(P, ctx.sid, true);
  }
}

/** PR-CONV: render the conversation timeline (comments · review verdicts · file threads ·
 *  commits) into #pr-conv-P — the GitHub PR page's discussion, readable without leaving the
 *  cockpit. */
function renderConversation(P: "A" | "B") {
  const el = document.getElementById(`pr-conv-${P}`);
  if (!el) return;
  const conv = _prConv[P];
  if (!conv) { el.innerHTML = `<div class="conv-empty dim">loading conversation…</div>`; return; }
  if (!conv.ok) { el.innerHTML = `<div class="conv-empty dim">conversation unavailable: ${esc(conv.error || "unknown")}</div>`; return; }
  const items: any[] = conv.thread || [];
  const head =
    `<div class="conv-head"><span class="dim">${items.length} event${items.length === 1 ? "" : "s"} · pulled from GitHub</span>` +
    `<button class="term-btn conv-refresh" data-p="${P}">↻ refresh</button></div>`;
  if (!items.length) { el.innerHTML = head + `<div class="conv-empty dim">no conversation on this PR yet.</div>`; return; }
  el.innerHTML = head + `<div class="conv-timeline">${items.map((it) => renderConvItem(it)).join("")}</div>`;
}

function convWho(author: string, createdAt: string): string {
  const initial = (author || "?").slice(0, 1).toUpperCase();
  return `<span class="conv-avatar">${esc(initial)}</span><b>${esc(author || "?")}</b> <span class="dim" title="${escAttr(createdAt || "")}">${timeAgo(createdAt || "")}</span>`;
}

function renderConvItem(it: any): string {
  if (it.kind === "commit") {
    return `<div class="conv-commit"><span class="conv-commit-dot">◦</span><code>${esc(it.oid || "")}</code> ${esc(it.headline || "")} <span class="dim">· ${esc(it.author || "")} · ${timeAgo(it.createdAt || "")}</span></div>`;
  }
  if (it.kind === "review") {
    const st = String(it.state || "").toUpperCase();
    const cls = st === "APPROVED" ? "approved" : st === "CHANGES_REQUESTED" ? "changes" : "commented";
    const label = st === "APPROVED" ? "✔ approved" : st === "CHANGES_REQUESTED" ? "✖ changes requested" : "reviewed";
    return `<div class="conv-item"><div class="conv-card conv-review ${cls}"><div class="conv-card-head">${convWho(it.author, it.createdAt)} <span class="conv-rev-state ${cls}">${label}</span></div>` +
      (it.body ? `<div class="conv-body">${mdLite(it.body)}</div>` : "") + `</div></div>`;
  }
  if (it.kind === "thread") {
    const loc = `<span class="conv-inline-chip">${esc(it.path || "")}${it.line ? `:${it.line}` : ""}</span>`;
    const cs = (it.comments || []).map((c: any, i: number) =>
      `<div class="conv-thread-msg${i ? " reply" : ""}"><div class="conv-card-head">${convWho(c.author, c.createdAt)}</div><div class="conv-body">${mdLite(c.body || "")}</div></div>`).join("");
    return `<div class="conv-item"><div class="conv-card conv-thread"><div class="conv-card-head">${loc} <span class="dim">code comment${(it.comments || []).length > 1 ? ` · ${(it.comments || []).length} messages` : ""}</span></div>${cs}</div></div>`;
  }
  // plain comment (cockpit-tagged /pr & /prteam runs get a verdict strip)
  let strip = "";
  if (it.cockpit) {
    const v = (it.cockpit.verdict || "").toUpperCase();
    const rv = v === "GREEN" ? `<span class="rv green">✅ GREEN</span> ` : v === "RED" ? `<span class="rv red">❌ RED</span> ` : ""; // loose runs: verdict unknown → no badge
    const kind = it.cockpit.type === "prteam" ? `<b>/prteam</b>${it.cockpit.tier ? ` ${esc(it.cockpit.tier)}` : ""}${it.cockpit.rounds ? ` · ${esc(it.cockpit.rounds)}r` : ""}` : `<b>/pr</b>`;
    const tests = it.cockpit.tests ? ` · tests ${it.cockpit.tests === "pass" ? "✅" : it.cockpit.tests === "fail" ? "❌" : "⏭️"}` : "";
    strip = `<div class="conv-cockpit-strip">${rv}${kind}${tests} <span class="dim">review run</span></div>`;
  }
  return `<div class="conv-item"><div class="conv-card${it.cockpit ? " conv-cockpit" : ""}"><div class="conv-card-head">${convWho(it.author, it.createdAt)}</div>${strip}<div class="conv-body">${mdLite(it.body || "")}</div></div></div>`;
}

// MERGE-DEL: GitHub-style "delete branch after merge" — a default-CHECKED checkbox in both merge
// confirms. Read it BEFORE the popup body is replaced with the progress spinner.
function mergeDelCheckboxHtml(checked = true): string {
  return `<label class="merge-del"><input type="checkbox" id="merge-del-branch"${checked ? " checked" : ""}> delete the branch after merge</label>`;
}
function readMergeDelCheckbox(): boolean {
  const cb = document.getElementById("merge-del-branch") as HTMLInputElement | null;
  // missing element (popup body already replaced) → FALSE: never opt into a destructive
  // deletion off a failed DOM lookup; the rendered checkbox carries the default instead
  return cb ? cb.checked : false;
}

/** FIX X: confirm + merge a session's PR (gh pr merge --<strategy>). Outward-facing → confirm. */
function confirmMergePr(sessionId: number, pr: any) {
  if (!pr || !pr.number) { setStatus("no open PR for this session"); return; }
  showConfirm(
    `Merge <b>PR #${pr.number}</b> — ${esc(pr.title || "")}<br>${pr.base ? `into <b>${esc(pr.base)}</b> ` : ""}(${esc((S.state?.config as any)?.pr_merge_strategy || "squash")}).<br>` +
    conflictLine(pr.mergeable) + mergeDelCheckboxHtml() + `<br>` +
    `This is outward-facing (merges on GitHub via gh). Press <kbd>Enter</kbd> to confirm.`,
    async () => {
      // Keep the popup OPEN and show progress + result in it — the footer status-bar alone is too
      // easy to miss. Ignore Enter while the merge is in flight (don't fire a second merge).
      const delBranch = readMergeDelCheckbox(); // before the body is replaced below
      S.pendingConfirm = async () => {};
      $("merge-body").innerHTML = `⏳ Merging <b>PR #${pr.number}</b>…<br><span class="dim">running gh pr merge — can take a few seconds</span>`;
      setStatus(`merging PR #${pr.number}…`);
      const r = await api.mergePr(sessionId, delBranch).catch((e: any) => ({ ok: false, error: String(e) }));
      showMergeResult(`PR #${pr.number}`, r);
      if (r && r.ok) await refresh();
    }
  );
}

/** Merge the SELECTED item, whatever its shape: a PR-kind queue item → the guarded prMerge
 *  confirm (showMergeConfirm); a claude session with a DETECTED GitHub PR → the same confirm
 *  path as the ⇲ Merge button (mergeSelectedPr). One entry point for the X key + the diff-header
 *  Merge button, so "merge" never says "not a PR" while a merge button is visibly on screen. */
function mergeCurrent() {
  const it = selectedItem();
  if (it && it.session.kind === "pr") showMergeConfirm();
  else mergeSelectedPr();
}

/** FIX X: master Ctrl+G m — merge the SELECTED session's PR (with confirm). */
function mergeSelectedPr() {
  const it = selectedItem();
  const sid = it ? it.session.id : (_termOverride ?? null);
  if (sid == null) { setStatus("no session selected"); return; }
  const pr = sessionPrFor(sid);
  if (pr && pr.number) { confirmMergePr(sid, pr); return; }
  // not cached → fetch then confirm
  api.sessionPr(sid).then((fresh: any) => { if (fresh && fresh.number) confirmMergePr(sid, fresh); else setStatus("no open PR for this session"); }).catch(() => setStatus("no open PR for this session"));
}

async function loadDiffInto(P: "A" | "B", it: any) {
  const body = $(`pane-${P}-body`);
  const isPr = it.session.kind === "pr";
  // A claude /work session's own branch (cockpit/<name>) is clean — its real changes live on the
  // attached PR's task/<name> branch. So when such a session HAS a PR (pr_repo+pr_number, set from
  // the @claude_pr window option), show the PR's diff (gh pr diff), not the empty worktree diff —
  // keeping the diff pane consistent with the Merge button. Plain sessions (no PR) still diff their
  // worktree as before.
  const hasPr = !!(it.session.pr_number && it.session.pr_repo);
  const usePrDiff = isPr || hasPr;
  // expand-context everywhere the server can re-cut the SAME diff source: worktree diffs from
  // the merge-base, PR diffs from a local clone of the PR's repo (fetch + merge-base — same
  // content `gh pr diff` shows; no local clone → a polite status-bar error on click). Only demo
  // sessions without the sandbox repo are gated out: their patches are CANNED, not re-cuttable.
  const demoCanned = !!(S.state && S.state.demo) && !it.session.pr_local_repo;
  _diffCanExpand[P] = !demoCanned;
  if (!isDiffable(it)) { body.innerHTML = `<div class="dim">No diff for this task (no PR and no git branch).</div>`; return; }
  // PR-CONV: new task in this pane → back to the Diff tab with a fresh conversation pull;
  // same task re-rendered (e.g. format toggle) keeps tab + data.
  if (!_prBarCtx[P] || _prBarCtx[P]!.sid !== it.session.id) { _prTab[P] = "diff"; _prConv[P] = null; _prConvAt[P] = 0; }
  const initialTitle = usePrDiff ? `PR #${it.session.pr_number} · ${esc(it.session.repo || "")}` : `Diff · ${esc(it.session.branch || it.session.title)}`;
  body.innerHTML =
    `<div class="pane-subhead"><span id="diff-title-${P}">${initialTitle} <span class="diff-counter dim" id="diff-counter-${P}"></span></span>` +
    // FIX: the old non-clickable `<kbd>X</kbd> merge` hint looked like a button but did nothing
    // (and bare X was unbound by the 2026-06-10 master-gating) → a REAL Merge button for PR items,
    // routed by the delegated .diff-merge-btn handler (survives re-renders, works detached too).
    `<span class="hint"><button class="term-btn" id="diff-toggle-${P}">${S.diffFormat === "side-by-side" ? "⇄ split" : "≡ unified"}</button>${usePrDiff ? `<span class="diff-merge-wrap" id="diff-merge-wrap-${P}"> <button class="term-btn danger diff-merge-btn" title="merge this PR (guarded confirm) — or press ${esc(S.keymap.pr_merge || "X")}">⇲ Merge</button> <kbd>${esc(S.keymap.pr_merge || "X")}</kbd> merge</span>` : ""} · <kbd>v</kbd> viewed</span></div>` +
    `<div id="pr-bar-${P}"></div>` + // FIX X / PR-CONV: redesigned GitHub PR header (chips · ages · prteam badge · tabs · Merge)
    // P1: GitHub-style TWO-COLUMN — collapsible file tree (left) + independently-scrollable diff (right)
    `<div class="diff-2col">` +
    `<aside class="diff-tree" id="diff-tree-${P}"></aside>` +
    `<div class="diff-pane" id="diff-body-${P}"><div class="dim">loading diff…</div></div>` +
    `</div>` +
    // PR-CONV: the Conversation tab's container — a display toggle sibling of the diff, so the
    // mounted diff2html DOM survives tab switches.
    `<div class="pr-conv" id="pr-conv-${P}" style="display:none"></div>`;
  const tg = document.getElementById(`diff-toggle-${P}`);
  if (tg) tg.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); S.diffFormat = S.diffFormat === "side-by-side" ? "line-by-line" : "side-by-side"; (tg as HTMLElement).textContent = S.diffFormat === "side-by-side" ? "⇄ split" : "≡ unified"; renderDiffStack(P, it.session.id); });
  // FIX X / PR-CONV: the PR header bar renders for BOTH kinds now — PR cards fill instantly from
  // their pr_* columns (seed); claude sessions lazily detect their PR via the conversation pull.
  const seedPr = usePrDiff ? {
    number: it.session.pr_number, url: it.session.pr_url, title: it.session.title, state: "OPEN",
    draft: !!it.session.pr_draft, base: it.session.pr_base_ref, head: it.session.pr_head_ref,
    reviewDecision: it.session.pr_review_decision, additions: it.session.pr_additions, deletions: it.session.pr_deletions,
    author: it.session.pr_author,
  } : undefined;
  renderPrBar(P, it.session.id, seedPr);
  if (_prTab[P] === "conv") setPrTab(P, "conv"); // same-task re-render: restore the open tab
  const reqId = it.id;
  const [r, viewed] = await Promise.all([
    usePrDiff ? api.prDiff(it.session.id) : api.worktreeDiff(it.session.id),
    api.diffViewed(it.session.id).catch(() => ({})),
  ]);
  if (S.paneItem[P] !== reqId) return; // task changed while loading → drop stale render
  _diffViewed[P] = viewed || {};
  // For non-PR sessions, show "<branch> vs <base> @ <merge-base sha>" once resolved.
  if (!usePrDiff && r && r.branch) {
    const t = document.getElementById(`diff-title-${P}`);
    const mb = (r as any).mergeBase ? ` <span class="dim">@ ${esc((r as any).mergeBase)}</span>` : "";
    if (t) t.innerHTML = `<span class="pr-ref head">${esc(r.branch)}</span><span class="pr-arrow">vs</span><span class="pr-ref base">${esc(r.base || "?")}</span>${mb} <span class="diff-counter dim" id="diff-counter-${P}"></span>`;
  }
  if (r && r.ok && (r.diff || "").trim()) { S.diffPatch[P] = r.diff || ""; renderDiff2HtmlInto(P, it.session.id); }
  else {
    const b = document.getElementById(`diff-body-${P}`);
    if (b) {
      if (r && r.ok && !((r as any).base) && !usePrDiff) b.innerHTML = `<div class="dim">no base branch to diff against</div>`;
      else if (r && r.ok) b.innerHTML = `<div class="dim">no changes vs ${esc(((r as any).base) || "base")}</div>`;
      else b.innerHTML = `<div class="dim">diff error: ${esc((r && r.error) || "unknown")}</div>`;
    }
  }
}

// Per-pane parsed file list (path, +/- counts, that file's own patch) + selected index.
interface DiffFile { path: string; add: number; del: number; fp: string; }
const _diffFiles: { A: DiffFile[]; B: DiffFile[] } = { A: [], B: [] };
const _diffSel: { A: number; B: number } = { A: 0, B: 0 };

/** Split a unified patch into per-file sections (one `diff --git` block each) with counts. */
function parsePatchFiles(patch: string): DiffFile[] {
  const parts = patch.split(/\n(?=diff --git )/);
  const files: DiffFile[] = [];
  for (const fp of parts) {
    if (!fp.startsWith("diff --git")) continue;
    let pth = "";
    const mPlus = fp.match(/^\+\+\+ b\/(.+)$/m);
    if (mPlus) pth = mPlus[1].trim();
    else { const dm = fp.match(/^diff --git a\/(.+?) b\/(.+)$/m); if (dm) pth = (dm[2] || dm[1]).trim(); }
    let add = 0, del = 0;
    for (const line of fp.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    files.push({ path: pth || "(file)", add, del, fp });
  }
  return files;
}

// FIX G: per-pane directory EXPANSION state + the IntersectionObserver that lazy-mounts file
// diffs. A file's diff appears on the RIGHT only if ALL its ancestor dirs are expanded.
const _diffExpanded: { A: Set<string>; B: Set<string> } = { A: new Set(), B: new Set() };
const _diffIO: { A: IntersectionObserver | null; B: IntersectionObserver | null } = { A: null, B: null };

/** Default expansion: the common source roots (src / lib / app) and everything UNDER them; every
 *  other directory (vendored, docs, generated…) starts COLLAPSED, so the default right pane shows
 *  your source first. If a repo has none of those roots, expand everything (so the diff is never
 *  mysteriously empty). Override the roots by editing DIFF_EXPAND_ROOTS. */
const DIFF_EXPAND_ROOTS = ["src", "lib", "app"];
function defaultExpandedDirs(files: DiffFile[]): Set<string> {
  const s = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? cur + "/" + parts[i] : parts[i];
      if (DIFF_EXPAND_ROOTS.some((r) => cur === r || cur.startsWith(r + "/"))) s.add(cur);
    }
  }
  if (s.size === 0) {
    // no known source root in this diff → expand every ancestor dir (show the whole diff)
    for (const f of files) {
      const parts = f.path.split("/");
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) { cur = cur ? cur + "/" + parts[i] : parts[i]; s.add(cur); }
    }
  }
  return s;
}

/** A file is VISIBLE on the right iff every one of its ancestor dirs is expanded. */
function diffFileVisible(P: "A" | "B", path: string): boolean {
  const parts = path.split("/");
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? cur + "/" + parts[i] : parts[i];
    if (!_diffExpanded[P].has(cur)) return false;
  }
  return true;
}

/** Estimate a file block's rendered height from its changed-line count (for the placeholder, so
 *  the scrollbar is roughly right before the real diff mounts). */
function estimateBlockHeight(f: DiffFile): number {
  return Math.max(80, Math.min(4000, 56 + (f.add + f.del) * 17));
}

// GitHub-style "expand context": per-pane per-file current -U context width (default git 3).
// Clicking an expand bar / hunk header re-fetches THAT file's diff with more context lines.
const CTX_DEFAULT = 3, CTX_STEP = 25, CTX_ALL = 100000;
const _diffCtx: { A: Record<string, number>; B: Record<string, number> } = { A: {}, B: {} };
// per-pane: whether the current diff's SOURCE supports expansion (set by loadDiffInto).
const _diffCanExpand: { A: boolean; B: boolean } = { A: true, B: true };

function renderDiff2HtmlInto(P: "A" | "B", sid: number) {
  const el = document.getElementById(`diff-body-${P}`);
  if (!el) return;
  const patch = S.diffPatch[P] || "";
  if (!patch.trim()) { el.innerHTML = `<div class="dim">(no diff)</div>`; return; }
  _diffCtx[P] = {}; // fresh patch → every file back to default context
  _diffFiles[P] = parsePatchFiles(patch);
  if (!_diffFiles[P].length) { el.innerHTML = splitDiffHtml(patch); return; }
  _diffExpanded[P] = defaultExpandedDirs(_diffFiles[P]); // default: source roots (src/lib/app)
  buildDiffTree(P, sid);
  renderDiffStack(P, sid);
}

/** FIX G: render ALL currently-VISIBLE files STACKED in one continuously-scrollable container.
 *  Each file is a block that lazy-mounts its diff2html via IntersectionObserver (placeholder
 *  sized by changed-line count until near the viewport), so continuous scroll stays smooth even
 *  with many files. Collapsed dirs' files are excluded entirely. */
function renderDiffStack(P: "A" | "B", sid: number) {
  const el = document.getElementById(`diff-body-${P}`);
  if (!el) return;
  if (_diffIO[P]) { try { _diffIO[P]!.disconnect(); } catch {} _diffIO[P] = null; }
  const visible = _diffFiles[P].map((f, i) => ({ f, i })).filter(({ f }) => diffFileVisible(P, f.path));
  if (!visible.length) { el.innerHTML = `<div class="dim">no visible files — expand a directory on the left</div>`; updateViewedCounter(P); return; }
  el.innerHTML = visible.map(({ f, i }) =>
    `<div class="diff-file-block" id="diff-fb-${P}-${i}" data-idx="${i}" data-path="${esc(f.path)}" style="min-height:${estimateBlockHeight(f)}px">` +
    `<div class="diff-file-ph"><span class="dim">${esc(f.path)} <span class="dt-add">+${f.add}</span> <span class="dt-del">−${f.del}</span></span></div>` +
    `</div>`
  ).join("");
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const block = e.target as HTMLElement;
      if (e.isIntersecting) mountDiffBlock(P, block, sid);
      else placeholderDiffBlock(P, block);
    }
  }, { root: el, rootMargin: "1200px 0px" });
  el.querySelectorAll(".diff-file-block").forEach((b) => io.observe(b));
  _diffIO[P] = io;
  el.scrollTop = 0;
  updateViewedCounter(P);
}

/** Mount the real diff2html for one file block (idempotent). highlight off for >1500-line files. */
function mountDiffBlock(P: "A" | "B", block: HTMLElement, sid: number) {
  if (block.dataset.mounted === "1") return;
  const idx = parseInt(block.dataset.idx || "-1", 10);
  const f = _diffFiles[P][idx];
  if (!f) return;
  const D2H = (window as any).Diff2HtmlUI;
  const changed = f.add + f.del;
  block.dataset.mounted = "1";
  block.style.minHeight = ""; // let real content drive the height now
  try {
    if (!D2H) { block.innerHTML = splitDiffHtml(f.fp); }
    else {
      block.innerHTML = "";
      const ui = new D2H(block, f.fp, { outputFormat: S.diffFormat, drawFileList: false, matching: "lines", highlight: changed <= 1500, colorScheme: "dark" });
      ui.draw(); if (changed <= 1500) ui.highlightCode();
      enhanceViewedTogglesPane(P, sid, block);
      injectExpandBars(P, block);
    }
  } catch { block.innerHTML = splitDiffHtml(f.fp); }
}

/** Unmount a far-offscreen file block back to a fixed-height placeholder (frees the heavy DOM). */
function placeholderDiffBlock(P: "A" | "B", block: HTMLElement) {
  if (block.dataset.mounted !== "1") return;
  const idx = parseInt(block.dataset.idx || "-1", 10);
  const f = _diffFiles[P][idx];
  const h = block.offsetHeight || (f ? estimateBlockHeight(f) : 200);
  block.dataset.mounted = "0";
  block.style.minHeight = `${h}px`;
  block.innerHTML = `<div class="diff-file-ph"><span class="dim">${esc(f ? f.path : "")} ${f ? `<span class="dt-add">+${f.add}</span> <span class="dt-del">−${f.del}</span>` : ""}</span></div>`;
}

/** GitHub-style expand-context controls for one mounted file block: a clickable bar at the TOP
 *  and BOTTOM of the file (+25 lines / whole file), and every hunk header (`.d2h-info` @@-row)
 *  clickable for the same +25 step. Buttons carry data-attrs only — clicks route through the
 *  document-level delegated handler (per-element listeners die on re-render). */
function injectExpandBars(P: "A" | "B", block: HTMLElement) {
  block.querySelectorAll(".diff-expand-bar").forEach((b) => b.remove());
  if (!_diffCanExpand[P]) return; // gh-pr-diff source: server can't widen the same rev pair
  const path = block.dataset.path || "";
  // "(file)" = parsePatchFiles couldn't extract the path (git-quoted special chars) — the
  // server could never match it, so don't offer arrows that can only error.
  if (!path || path === "(file)") return;
  const full = (_diffCtx[P][path] || CTX_DEFAULT) >= CTX_ALL;
  const wrap = (block.querySelector(".d2h-file-wrapper") as HTMLElement) || block;
  const mkBtn = (act: "step" | "all", label: string, title: string) => {
    const b = document.createElement("button");
    b.className = "de-btn"; b.dataset.act = act; b.textContent = label; b.title = title;
    return b;
  };
  const mkBar = (pos: "top" | "bottom") => {
    const bar = document.createElement("div");
    bar.className = "diff-expand-bar";
    if (full) bar.innerHTML = `<span class="dim">whole file shown</span>`;
    else {
      bar.appendChild(mkBtn("step", `${pos === "top" ? "⌃" : "⌄"} expand ${CTX_STEP} lines`, `show ${CTX_STEP} more context lines`));
      bar.appendChild(mkBtn("all", "↕ whole file", "show the entire file as context"));
    }
    return bar;
  };
  const header = wrap.querySelector(".d2h-file-header");
  if (header && header.parentElement) header.parentElement.insertBefore(mkBar("top"), header.nextSibling);
  else wrap.insertBefore(mkBar("top"), wrap.firstChild);
  wrap.appendChild(mkBar("bottom"));
  if (!full)
    block.querySelectorAll(".d2h-info").forEach((r) => {
      (r as HTMLElement).classList.add("de-hunk");
      (r as HTMLElement).title = `click to show ${CTX_STEP} more context lines`;
    });
}

/** Click action for the expand controls: re-fetch THIS file's diff with wider context from the
 *  server (same base rev as the full diff), swap it into the file's patch and remount the block.
 *  An unchanged response means the file edges were reached → flip to "whole file shown". */
async function expandDiffContext(P: "A" | "B", block: HTMLElement, whole: boolean) {
  // resolve the file by PATH first (idx can go stale if _diffFiles re-parses/reorders — same
  // trap the Viewed handler de-risks), idx only as fallback.
  const idx = parseInt(block.dataset.idx || "-1", 10);
  const path = block.dataset.path || (_diffFiles[P][idx] && _diffFiles[P][idx].path) || "";
  const f = _diffFiles[P].find((x) => x.path === path) || _diffFiles[P][idx];
  if (!f || !path) { setStatus("expand: stale diff block — reopen the diff"); return; }
  const it = selectedItem();
  const sid = (it && it.session.id) || _termOverride || 0;
  // renames: the full patch pairs old+new paths; a single-path -U pathspec would break rename
  // detection and blow the hunk up into a whole-file addition — send the old path along. Parsed
  // from the unambiguous `rename from`/`copy from` headers (the `diff --git a/.. b/..` line is
  // unsplittable for paths containing " b/" and C-quoted for special chars).
  const rm = f.fp.match(/^rename from (.+)$/m) || f.fp.match(/^copy from (.+)$/m);
  // C-QUOTED old path (git quotes non-ASCII/control chars: `rename from "p\303\244th"`): the
  // capture is the quoted blob, not a usable path — sending it breaks the rename pathspec and
  // the cut degrades to a misleading whole-file addition. Refuse and keep the correct hunk.
  if (rm && rm[1].startsWith('"')) { setStatus(`expand ${path}: rename with special-char old path — can't widen safely`); return; }
  const oldPath = rm && rm[1] !== path ? rm[1] : "";
  const next = whole ? CTX_ALL : (_diffCtx[P][path] || CTX_DEFAULT) + CTX_STEP;
  let r: any = null;
  try { r = await api.diffExpand(sid, path, next, oldPath); } catch (e: any) { r = { ok: false, error: String(e && e.message || e) }; }
  // staleness guard: the diff may have reloaded (selection change / re-render) while the request
  // was in flight — _diffFiles got replaced and _diffCtx reset; don't pollute the fresh state.
  if (!block.isConnected || !_diffFiles[P].includes(f)) return;
  if (!r || !r.ok || !(r.fileDiff || "").trim()) { setStatus(`expand ${path}: ${(r && r.error) || "unavailable"}`); return; }
  // belt-and-braces: a response spanning >1 file (bad pathspec) must never replace this block
  if ((r.fileDiff.match(/^diff --git /gm) || []).length > 1) { setStatus(`expand ${path}: ambiguous multi-file result — not applied`); return; }
  // unchanged result (modulo the trailing newline parsePatchFiles strips) = file edges reached
  _diffCtx[P][path] = whole || r.fileDiff.trimEnd() === f.fp.trimEnd() ? CTX_ALL : next;
  f.fp = r.fileDiff;
  block.dataset.mounted = "0"; // remount in place with the wider patch (re-injects the bars)
  mountDiffBlock(P, block, sid);
  // PR-sourced cuts come from a local clone; if the server couldn't freshen its refs it says so
  if (r.warning) setStatus(`expand ${path}: ${r.warning}`);
}

/** FIX G: collapsible file TREE (left). Dir toggle updates _diffExpanded and re-renders the
 *  stack (collapsing REMOVES that dir's files from the right). Clicking a FILE smooth-scrolls to
 *  its diff block on the right. */
function buildDiffTree(P: "A" | "B", sid: number) {
  const tree = document.getElementById(`diff-tree-${P}`);
  if (!tree) return;
  const files = _diffFiles[P].map((f, i) => ({ path: f.path, full: f.path, add: f.add, del: f.del, idx: i }));
  type Node = { dirs: Record<string, Node>; files: typeof files };
  const root: Node = { dirs: {}, files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) { const seg = parts[i]; cur.dirs[seg] = cur.dirs[seg] || { dirs: {}, files: [] }; cur = cur.dirs[seg]; }
    cur.files.push({ ...f, path: parts[parts.length - 1] });
  }
  const renderNode = (n: Node, depth: number, prefix: string): string => {
    let html = "";
    for (const dir of Object.keys(n.dirs).sort()) {
      const full = prefix ? prefix + "/" + dir : dir;
      const expanded = _diffExpanded[P].has(full);
      html += `<div class="dt-folder${expanded ? "" : " collapsed"}" data-dir="${esc(full)}" style="--d:${depth}"><span class="dt-caret">${expanded ? "▾" : "▸"}</span><span class="dt-dir">${esc(dir)}/</span></div>`;
      html += `<div class="dt-children" style="${expanded ? "" : "display:none"}">${renderNode(n.dirs[dir], depth + 1, full)}</div>`;
    }
    for (const f of n.files.sort((a, b) => a.path.localeCompare(b.path))) {
      const vw = _diffViewed[P][f.full] ? " viewed" : "";
      html += `<div class="dt-file${vw}" data-idx="${f.idx}" style="--d:${depth}" title="${esc(f.full)}"><span class="dt-name">${esc(f.path)}</span><span class="dt-stats"><span class="dt-add">+${f.add}</span><span class="dt-del">−${f.del}</span></span></div>`;
    }
    return html;
  };
  tree.innerHTML = `<div class="dt-head">${files.length} file${files.length === 1 ? "" : "s"}</div>` + renderNode(root, 0, "") || "";
  tree.querySelectorAll(".dt-folder").forEach((f) =>
    f.addEventListener("click", () => {
      const dir = (f as HTMLElement).dataset.dir || "";
      const kids = (f as HTMLElement).nextElementSibling as HTMLElement | null;
      const collapsed = (f as HTMLElement).classList.toggle("collapsed");
      const caret = f.querySelector(".dt-caret"); if (caret) caret.textContent = collapsed ? "▸" : "▾";
      if (kids && kids.classList.contains("dt-children")) kids.style.display = collapsed ? "none" : "";
      if (collapsed) _diffExpanded[P].delete(dir); else _diffExpanded[P].add(dir);
      renderDiffStack(P, sid); // collapsing removes its files from the right; expanding re-adds
    })
  );
  // file click → smooth-scroll to that file's diff block on the RIGHT (it's visible, since its
  // dir must be expanded for the row to show).
  tree.querySelectorAll(".dt-file").forEach((f) =>
    f.addEventListener("click", () => {
      const idx = parseInt((f as HTMLElement).dataset.idx!, 10);
      tree.querySelectorAll(".dt-file.sel").forEach((x) => x.classList.remove("sel"));
      f.classList.add("sel");
      scrollDiffToBlock(P, idx);
    })
  );
}

/** FIX: scroll ONLY the diff-pane container to a file block. NEVER use block.scrollIntoView() here:
 *  it walks UP the ancestor chain and scrolls EVERY scrollable ancestor — including the
 *  `overflow:hidden` <body> (hidden blocks the *user* from scrolling, NOT programmatic scrolls) —
 *  which slides the whole page down with no way back except a reload. scrollBy on the container
 *  moves only that container. */
function scrollDiffToBlock(P: "A" | "B", idx: number) {
  const container = document.getElementById(`diff-body-${P}`);
  const block = document.getElementById(`diff-fb-${P}-${idx}`);
  if (!container || !block) return;
  const delta = block.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollBy({ top: delta, behavior: "smooth" });
}

/** FIX Y: collapse/expand a file block IN PLACE (no re-render). Collapsed = only the filename
 *  header shows; the diff body is hidden (CSS .file-collapsed). */
function applyFileCollapsed(block: HTMLElement | null, collapsed: boolean) {
  if (block) block.classList.toggle("file-collapsed", collapsed);
}

/** FIX Y: mark a file viewed/unviewed → COLLAPSE/expand it in place, update the tree marker and
 *  counter WITHOUT rebuilding anything (scroll preserved), and persist. */
function setFileViewed(P: "A" | "B", sid: number, path: string, block: HTMLElement | null, viewed: boolean) {
  _diffViewed[P][path] = viewed;
  applyFileCollapsed(block, viewed);
  // reflect in the left tree (strikethrough) WITHOUT rebuilding the tree.
  const tree = document.getElementById(`diff-tree-${P}`);
  const idx = block ? block.dataset.idx : null;
  if (tree && idx != null) { const row = tree.querySelector(`.dt-file[data-idx="${idx}"]`); if (row) row.classList.toggle("viewed", viewed); }
  // keep the Viewed button label/state in sync (so `v` and the button agree)
  if (block) { const b = block.querySelector(".d2h-viewed-btn") as HTMLElement | null; if (b) { b.classList.toggle("on", viewed); b.textContent = viewed ? "✓ Viewed" : "Viewed"; } }
  updateViewedCounter(P);
  try { api.setDiffViewed(sid, path, viewed); } catch {}
}

/** FIX AA: add EXACTLY ONE Viewed control to a single file BLOCK — keyed by the block's own file
 *  (block.dataset.idx), and bulletproof against diff2html structure: it removes EVERY pre-existing
 *  `.d2h-viewed` anywhere in the block first, then adds one to the file header (or the block top). */
function wireBlockViewed(P: "A" | "B", sid: number, block: HTMLElement) {
  // FIX AA-2: nuke EVERY viewed/collapse-like control in this block (mine from a prior mount AND
  // any diff2html-native one) so there is EXACTLY ONE Viewed button per file. Then log what was
  // there (one-time-ish) so a stray 2nd control is visible in the operator's devtools.
  const stale = Array.from(block.querySelectorAll(".d2h-viewed, .d2h-viewed-btn, .d2h-file-collapse, input[type=checkbox]"));
  if (stale.length) { try { console.log("[viewed-dedup] removing", stale.length, "stale control(s):", stale.map((s) => (s as HTMLElement).className || (s as HTMLElement).tagName)); } catch {} }
  stale.forEach((el) => el.remove());
  const idx = parseInt(block.dataset.idx || "-1", 10);
  const path = block.dataset.path || (_diffFiles[P][idx] && _diffFiles[P][idx].path) || "";
  if (!path) return;
  block.dataset.path = path; // ensure it's always present for the delegated handler
  const isViewed = !!_diffViewed[P][path];
  applyFileCollapsed(block, isViewed); // restore collapsed state on (re)mount
  const host = (block.querySelector(".d2h-file-header") as HTMLElement) || block;
  // A plain BUTTON with data-attrs — NO per-element listener (those die on re-render). The
  // document-level delegated handler routes the click to setFileViewed, exactly like the `v` key.
  const btn = document.createElement("button");
  btn.className = "d2h-viewed d2h-viewed-btn" + (isViewed ? " on" : "");
  btn.dataset.p = P; btn.dataset.idx = String(idx); btn.dataset.path = path; // robust identifiers
  btn.textContent = isViewed ? "✓ Viewed" : "Viewed";
  host.appendChild(btn);
}

/** FIX AA (systemic): ONE delegated click listener on the document routes diff-pane button clicks
 *  — which survive diff2html re-renders / lazy mount because the listener is on the document, not
 *  the per-render buttons. Viewed button → setFileViewed (same as `v`); Merge button → the merge
 *  confirm (same as Ctrl+G m). Installed once. */
let _diffDelegationWired = false;
function wireDiffPaneDelegation() {
  if (_diffDelegationWired) return;
  _diffDelegationWired = true;
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // expand-context: the bars' buttons and ARMED hunk headers only (bare .d2h-info after
    // "whole file shown" has no .de-hunk → stays inert, no pointless round-trip).
    const de = t.closest(".de-btn, .d2h-info.de-hunk") as HTMLElement | null;
    if (de) {
      const block = de.closest(".diff-file-block") as HTMLElement | null;
      if (block) {
        e.preventDefault(); e.stopPropagation();
        const m = block.id.match(/^diff-fb-([AB])-/);
        const P = m ? (m[1] as "A" | "B") : "A";
        expandDiffContext(P, block, de.dataset.act === "all");
        return;
      }
    }
    const vb = t.closest(".d2h-viewed-btn") as HTMLElement | null;
    if (vb) {
      e.preventDefault(); e.stopPropagation();
      // FIX AA-2: derive EVERYTHING from the clicked button + its block — never depend on a
      // _diffFiles[P][idx] lookup succeeding (it can be stale/reordered → silent dead button). The
      // button is INSIDE its block, so closest('.diff-file-block') ALWAYS yields the right block.
      const block = vb.closest(".diff-file-block") as HTMLElement | null;
      const m = block && block.id.match(/^diff-fb-([AB])-/);
      const P = (vb.dataset.p as "A" | "B") || (m ? (m[1] as "A" | "B") : "A");
      const path = vb.dataset.path || (block && block.dataset.path) || "";
      // eslint-disable-next-line no-console
      console.log("[viewed-click] fired — block:", block && block.id, "P:", P, "path:", path);
      if (!block || !path) return;
      const sid = (selectedItem() && selectedItem().session.id) || _termOverride || 0;
      setFileViewed(P, sid, path, block, !_diffViewed[P][path]);
      return;
    }
    // Diff-header ⇲ Merge (PR-kind items): same unified action as the X key. The rendered diff
    // always belongs to the selected item (panes follow selection), so no data-sid needed.
    const dmb = t.closest(".diff-merge-btn") as HTMLElement | null;
    if (dmb) {
      e.preventDefault(); e.stopPropagation();
      mergeCurrent();
      return;
    }
    const mb = t.closest(".pr-merge-btn") as HTMLElement | null;
    if (mb) {
      e.preventDefault(); e.stopPropagation();
      const sid = parseInt(mb.dataset.sid || "-1", 10);
      if (sid < 0) return;
      const pr = sessionPrFor(sid);
      if (pr && pr.number) confirmMergePr(sid, pr);
      else api.sessionPr(sid).then((fresh: any) => { if (fresh && fresh.number) confirmMergePr(sid, fresh); else setStatus("no open PR for this session"); }).catch(() => {});
      return;
    }
    // PR-CONV: Diff | Conversation tab switch (delegated — survives bar re-fills).
    const tab = t.closest(".pr-tab") as HTMLElement | null;
    if (tab) {
      e.preventDefault(); e.stopPropagation();
      setPrTab((tab.dataset.p as "A" | "B") || "A", (tab.dataset.tab as "diff" | "conv") || "diff");
      return;
    }
    // PR-CONV: clicking the prteam badge jumps straight to the conversation.
    const lk = t.closest(".pr-conv-link") as HTMLElement | null;
    if (lk) {
      e.preventDefault(); e.stopPropagation();
      setPrTab((lk.dataset.p as "A" | "B") || "A", "conv");
      return;
    }
    // PR-CONV: manual ↻ — refetch the conversation, bypassing the client staleness window.
    const rf = t.closest(".conv-refresh") as HTMLElement | null;
    if (rf) {
      e.preventDefault(); e.stopPropagation();
      const P = (rf.dataset.p as "A" | "B") || "A";
      const ctx = _prBarCtx[P];
      if (ctx) loadPrConversation(P, ctx.sid, true);
      return;
    }
  });
}

function enhanceViewedTogglesPane(P: "A" | "B", sid: number, root?: HTMLElement | null) {
  // mountDiffBlock passes the mounted BLOCK as root → wire exactly that one. If called over the
  // whole diff-body, wire every block. Either way: one control per file.
  if (root && root.classList.contains("diff-file-block")) wireBlockViewed(P, sid, root as HTMLElement);
  else {
    const body = root || document.getElementById(`diff-body-${P}`);
    if (body) body.querySelectorAll(".diff-file-block").forEach((b) => wireBlockViewed(P, sid, b as HTMLElement));
  }
  updateViewedCounter(P);
}
function updateViewedCounter(P: "A" | "B") {
  const c = document.getElementById(`diff-counter-${P}`);
  if (!c) return;
  const files = _diffFiles[P];
  const viewed = files.filter((f) => _diffViewed[P][f.path]).length;
  c.textContent = files.length ? `Viewed ${viewed}/${files.length}` : "";
}
/** `v` marks the FIRST UNVIEWED VISIBLE file viewed (persist) + smooth-scrolls to the next
 *  unviewed visible file's diff block. (Continuous-scroll model — no single selected file.) */
function toggleFirstUnviewed() {
  const P = S.panes[S.focused] === "diff" ? S.focused : S.panes.A === "diff" ? "A" : S.panes.B === "diff" ? "B" : null;
  if (!P) return;
  const visible = _diffFiles[P].map((f, i) => ({ f, i })).filter(({ f }) => diffFileVisible(P, f.path));
  const targetIdx = visible.findIndex(({ f }) => !_diffViewed[P][f.path]);
  const cur = targetIdx >= 0 ? visible[targetIdx] : visible[visible.length - 1];
  if (!cur) return;
  const nowViewed = !_diffViewed[P][cur.f.path];
  const sid = (selectedItem() && selectedItem().session.id) || 0;
  // FIX Y: collapse the file IN PLACE (no buildDiffTree / re-render); persist + update marker.
  setFileViewed(P, sid, cur.f.path, document.getElementById(`diff-fb-${P}-${cur.i}`), nowViewed);
  // scroll to the next still-unviewed visible block (if any)
  const nextU = visible.find(({ f }, k) => k > targetIdx && !_diffViewed[P][f.path]);
  const jump = nextU || cur;
  scrollDiffToBlock(P, jump.i); // scroll the diff container only (never the whole page) — see FIX above
}


function showMergeConfirm() {
  const it = selectedItem();
  if (!it || it.session.kind !== "pr") { setStatus("not a PR"); return; }
  const head = `Merge <b>${esc(it.session.repo)}#${it.session.pr_number}</b><br>` +
    `<span class="dim">${esc(it.session.title)}</span><br>`;
  const foot = `<br>This is destructive and outward-facing (squash merge via gh).<br>Press <kbd>Enter</kbd> to confirm.`;
  // Show immediately, then fill in conflict status from a fresh gh fetch (mergeStateStatus).
  $("merge-body").innerHTML = head + `<span class="dim">checking for merge conflicts…</span>` + mergeDelCheckboxHtml() + foot;
  $("merge-overlay").style.display = "block";
  const sid = it.session.id;
  api.sessionPr(sid).then((pr: any) => {
    // Bail if the overlay was dismissed or a different one opened while fetching — and ALSO if
    // the checkbox is gone, which means the body already became the merge progress/result
    // (refilling would resurrect the confirm prompt mid-merge and invite a second Enter).
    if (overlayOpen() !== "merge-overlay") return;
    if (!document.getElementById("merge-del-branch")) return;
    // MERGE-DEL: preserve the operator's checkbox choice across the async conflict-status refill
    $("merge-body").innerHTML = head + conflictLine(pr && pr.mergeable) + mergeDelCheckboxHtml(readMergeDelCheckbox()) + foot;
  }).catch(() => {});
}

async function doMerge() {
  const it = selectedItem();
  if (!it || it.session.kind !== "pr") return;
  // Keep the popup open with progress + result (see confirmMergePr). Ignore Enter while in flight.
  const delBranch = readMergeDelCheckbox(); // before the body is replaced below
  S.pendingConfirm = async () => {};
  const label = `PR #${it.session.pr_number}`;
  $("merge-body").innerHTML = `⏳ Merging <b>${esc(label)}</b>…<br><span class="dim">running gh pr merge — can take a few seconds</span>`;
  setStatus(`merging ${label}…`);
  const r = await api.prMerge(it.session.id, "squash", delBranch);
  showMergeResult(label, r);
  if (r && r.ok) { await api.tick(); await refresh(); }
}

/** Conflict line for the merge confirm popup, from gh's mergeStateStatus.
 *  DIRTY = real merge conflicts; CLEAN/UNSTABLE/MERGEABLE = no conflicts; BLOCKED/BEHIND/etc =
 *  no conflict but not ready to merge as-is. Empty if status is unknown. */
function conflictLine(mergeable: string | undefined): string {
  const ms = String(mergeable || "").toUpperCase();
  if (ms === "DIRTY") return `<span class="pr-chip warn">⚠️ contains merge conflicts</span> <span class="dim">not cleanly mergeable — resolve first</span><br>`;
  if (/^(CLEAN|MERGEABLE|UNSTABLE|HAS_HOOKS)$/.test(ms)) return `<span class="pr-chip ok">✓ no merge conflicts</span><br>`;
  if (ms) return `<span class="pr-chip">${esc(ms.toLowerCase())}</span> <span class="dim">no conflicts, but not ready (blocked/behind)</span><br>`;
  return ``;
}

/** Replace the merge popup body with an unmistakable ✅/❌ result, dismissed with Enter/Esc.
 *  Sets pendingConfirm to a plain close so a follow-up Enter won't trigger another merge. */
function showMergeResult(label: string, r: any) {
  const ok = !!(r && r.ok);
  const detail = esc(String((r && (r.output || r.error)) || (ok ? "" : "unknown")).slice(0, 400));
  $("merge-body").innerHTML = ok
    ? `✅ <b>Merged ${esc(label)}</b>${detail ? `<br><span class="dim">${detail}</span>` : ""}<br><br>Press <kbd>Enter</kbd> or <kbd>Esc</kbd> to close.`
    : `❌ <b>Merge failed</b> — ${esc(label)}<br><span class="dim">${detail}</span><br><br>Press <kbd>Enter</kbd> or <kbd>Esc</kbd> to close.`;
  setStatus(ok ? `✓ merged ${label}` : `merge failed: ${detail}`);
  S.pendingConfirm = async () => { closeOverlays(); };
}

// ---------- kanban backfill ----------
/** Show the shared confirm overlay (reuses merge-overlay) with a pending action. */
function showConfirm(html: string, fn: () => Promise<void>) {
  $("merge-body").innerHTML = html;
  S.pendingConfirm = fn;
  $("merge-overlay").style.display = "block";
}

/** FIX BB: reasoned priority feedback — Ctrl+G < / > opens a reason input for the SELECTED task as
 *  ranked NOW. The typed reason + a feature snapshot become a STRONG training example. */
function showReasonInput(direction: "down" | "up") {
  const it = selectedItem();
  if (!it || it._virtual) { setStatus("select a queued task first"); return; }
  const verb = direction === "up" ? "rank this HIGHER ↑" : "rank this LOWER ↓";
  let submitted = false;
  const submit = async () => {
    if (submitted) return; submitted = true;
    const ri = document.getElementById("reason-input") as HTMLInputElement | null;
    const reason = (ri?.value || "").trim();
    closeOverlays();
    const r = await api.reasonFeedback(it.id, direction, reason).catch(() => ({ ok: false } as any));
    setStatus(r && r.ok ? `${direction === "up" ? "↑ raised" : "↓ lowered"} this task${reason ? ` — “${reason}”` : ""} (now ${(r as any).delta >= 0 ? "+" : ""}${(r as any).delta ?? ""})` : "feedback failed");
  };
  showConfirm(
    `<b>${esc(sessionHeadline(it.session, 56))}</b><br><span class="dim">${verb} · currently #${S.sel + 1} (p${dispPriority(it)})</span><br><br>` +
      `Why? <span class="dim">(optional)</span> <input id="reason-input" class="reason-input" autocomplete="off" placeholder="e.g. still running a script · not urgent · blocks nothing"/><br><br>` +
      `<span class="dim">Enter = record with reason · Esc = ${direction === "up" ? "raise" : "lower"} without a reason</span>`,
    submit
  );
  setTimeout(() => {
    const ri = document.getElementById("reason-input") as HTMLInputElement | null;
    if (ri) { ri.focus(); ri.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); submit(); } }); }
  }, 30);
}

function showKanbanStartConfirm() {
  const it = selectedItem();
  if (!it || it.session.kind !== "kanban") { setStatus("not a kanban card"); return; }
  showConfirm(
    `Start <b>${esc(it.session.title)}</b><br><span class="dim">${esc(it.session.kanban_column || "")}</span><br><br>` +
      `This LAUNCHES A REAL Claude Code session in ${esc(it.session.repo === "kanban" ? "the configured repo" : it.session.repo)}.<br>Press <kbd>Enter</kbd> to confirm.`,
    async () => {
      const r = await api.kanbanStart(it.session.id);
      closeOverlays();
      setStatus((r && r.message) || "started");
      await api.tick();
      await refresh();
    }
  );
}

async function saveKanbanAnswers() {
  const it = selectedItem();
  if (!it || it.session.kind !== "kanban") return;
  const answers = Array.from(document.querySelectorAll(".kanban-ans")).map((el) => (el as HTMLInputElement).value);
  const r = await api.kanbanAnswer(it.session.id, answers);
  setStatus(r && r.ok ? "saved answers" : "save failed");
}

function showKanbanAppendConfirm() {
  const it = selectedItem();
  if (!it || it.session.kind !== "kanban") return;
  // save current answers first, then confirm the file write
  showConfirm(
    `Append your answers to the kanban card FILE on disk:<br><b>${esc(it.session.title)}</b><br><br>` +
      `This MODIFIES the kanban file (so the task becomes startable).<br>Press <kbd>Enter</kbd> to confirm.`,
    async () => {
      await saveKanbanAnswers();
      const r = await api.kanbanAppend(it.session.id);
      closeOverlays();
      setStatus((r && r.message) || "appended");
      await api.tick();
      await refresh();
    }
  );
}

async function togglePin() {
  const it = selectedItem();
  if (!it) return;
  const next = !it.session.pinned;
  await api.setPinned(it.session.id, next);
  setStatus(next ? `pinned “${it.session.title}” (forced to top)` : `unpinned “${it.session.title}”`);
  await api.tick();
  await refresh();
}

function showManualImportance() {
  const it = selectedItem();
  if (!it) return;
  const inp = $("imp-input") as HTMLInputElement;
  // Open EMPTY (current value shown only as a placeholder hint) and focus on the next
  // tick + clear, so the triggering keystroke ('i') never leaks into the box.
  const cur = it.session.manual_importance != null ? String(it.session.manual_importance) : "";
  inp.value = "";
  inp.placeholder = cur ? `current ${cur} — type new (blank to clear)` : "e.g. 90";
  $("imp-overlay").style.display = "block";
  setTimeout(() => { inp.value = ""; inp.focus(); }, 0);
}

/** Ctrl+G i — QUICK inline Claude prompt. A tiny overlay over whatever you're doing: type a
 *  prompt, Enter fires off a BRAND-NEW Claude session in the background (seeded with the prompt
 *  as its first message) and immediately returns focus to where you were — the new terminal is
 *  never shown. A fast, no-context-switch version of Ctrl+G Shift+C. */
// Focus TRAP for the quick-prompt overlay. The overlay is a small centered box (NOT a full-screen
// backdrop), so a click outside it lands on the panes/terminal behind and would steal focus — and
// once the terminal grabs the keyboard you can't type back into the box. While the overlay is open,
// swallow every mouse event whose target is outside it (capture phase, before the panes' own click
// handlers run) and snap focus back to the textarea. Wired exactly once; inert when the overlay is closed.
let _qpFocusLockWired = false;
function wireQuickPromptFocusLock() {
  if (_qpFocusLockWired) return;
  _qpFocusLockWired = true;
  const lock = (e: Event) => {
    if (overlayOpen() !== "quickprompt-overlay") return; // only while the quick prompt is up
    const ov = $("quickprompt-overlay");
    if (ov.contains(e.target as Node)) return; // clicks inside the box are fine
    e.preventDefault();   // stop the click from focusing whatever was clicked
    e.stopPropagation();  // stop the panes' click handlers (select task / switch pane) from firing
    if (e.type === "mousedown") { try { ($("quickprompt-input") as HTMLTextAreaElement).focus(); } catch {} }
  };
  document.addEventListener("mousedown", lock, true);
  document.addEventListener("click", lock, true);
}

// ---------- SESSION SEARCH (header ⌕ button / master+/) ----------
// Type → instant keyword filter over EVERY transcript on the box (server-side index).
// Enter → smart semantic rank: sonnet picks the top 5 matches for the query's MEANING.
// ↑/↓ select a result, Enter opens it (upserts into the roster → normal attach path).
let _searchResults: any[] = [];
let _searchSel = -1;
let _searchRanked = false;
let _searchTimer: any = null;
let _searchSeq = 0;     // stale-response guard: only the latest request may render
let _searchDirty = false; // operator typed since the overlay opened

function showSessionSearch(prefix = "") {
  const inp = $("search-input") as HTMLInputElement;
  inp.value = prefix;
  _searchResults = []; _searchSel = -1; _searchRanked = false; _searchDirty = !!prefix;
  $("search-status").textContent = "";
  $("search-results").innerHTML = "";
  $("search-overlay").style.display = "block";
  if (!(inp as any)._searchWired) {
    (inp as any)._searchWired = true;
    inp.addEventListener("input", () => {
      _searchDirty = true;
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(() => void runKeywordSearch(), 150);
    });
    // Focus pin (same trick as quickprompt): while the overlay is open, any stray blur — a
    // background render(), an SSE refresh, a terminal grabbing keys — snaps focus straight
    // back to the box, so typing and Enter NEVER leak into the pane underneath. Inert once
    // closeOverlays() hides the overlay.
    inp.addEventListener("blur", () => {
      if ($("search-overlay").style.display !== "none")
        setTimeout(() => { if ($("search-overlay").style.display !== "none") inp.focus(); }, 0);
    });
  }
  void runKeywordSearch(); // initial "most recent" list — seq-guarded, so fast typing wins
  // Focus on the next tick (lets the triggering keystroke finish first). NEVER clear or
  // re-search here: under a busy tab this callback can land SECONDS late and would wipe
  // what the operator already typed (the e2e caught exactly that race) — only sweep the
  // leaked trigger char if the box is otherwise untouched.
  setTimeout(() => { if (!_searchDirty) inp.value = ""; inp.focus(); }, 0);
}

async function runKeywordSearch() {
  const q = ($("search-input") as HTMLInputElement).value;
  const seq = ++_searchSeq;
  try {
    const r = await (await fetch(`/api/session-search?q=${encodeURIComponent(q)}`)).json();
    if (seq !== _searchSeq) return; // a newer keystroke/semantic call superseded us
    _searchResults = r.results || [];
    _searchSel = -1; _searchRanked = false;
    $("search-status").innerHTML = q.trim()
      ? `${_searchResults.length} keyword match${_searchResults.length === 1 ? "" : "es"} · <b>Enter</b> = smart rank (Sonnet)`
      : "most recent sessions — type to filter";
    renderSearchResults();
  } catch { if (seq === _searchSeq) $("search-status").textContent = "search failed"; }
}

async function runSemanticSearch() {
  const q = ($("search-input") as HTMLInputElement).value.trim();
  if (!q) return void runKeywordSearch();
  const seq = ++_searchSeq;
  $("search-status").innerHTML = `<span class="search-spin"></span>Sonnet is ranking your sessions…`;
  try {
    const r = await (await fetch(`/api/session-search/semantic?q=${encodeURIComponent(q)}`)).json();
    if (seq !== _searchSeq) return;
    _searchResults = (r.results || []).slice(0, 5);
    _searchSel = _searchResults.length ? 0 : -1;
    _searchRanked = r.via === "semantic";
    $("search-status").innerHTML = _searchRanked
      ? `<span class="rank-tag">top ${_searchResults.length} semantic matches</span> · ↑↓ pick · Enter open`
      : `⚠ ${esc(r.error || "semantic rank unavailable")} — keyword top ${_searchResults.length}`;
    renderSearchResults();
  } catch { if (seq === _searchSeq) $("search-status").textContent = "semantic search failed"; }
}

function renderSearchResults() {
  const box = $("search-results");
  if (!_searchResults.length) { box.innerHTML = `<div class="dim" style="padding:14px 4px">No matches.</div>`; return; }
  box.innerHTML = _searchResults
    .map((e: any, i: number) => {
      const rank = _searchRanked ? `<span class="sc-rank">#${i + 1}</span>` : "";
      const ago = e.mtimeMs ? timeAgo(new Date(e.mtimeMs).toISOString()) : "";
      return `<div class="search-card ${i === _searchSel ? "sel" : ""}" data-i="${i}">
        <div class="sc-title">${rank}${esc(e.title || "(untitled)")}<span class="sc-ago">${ago}</span></div>
        <div class="sc-proj">${esc(e.cwd || "")}</div>
        <div class="sc-body">${esc((e.first || e.last || "").slice(0, 260))}</div>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".search-card").forEach((el) =>
    el.addEventListener("click", () => void openSearchResult(_searchResults[parseInt((el as HTMLElement).dataset.i!, 10)]))
  );
}

function moveSearchSel(d: number) {
  if (!_searchResults.length) return;
  _searchSel = Math.max(0, Math.min(_searchResults.length - 1, _searchSel + d));
  renderSearchResults();
  const sel = document.querySelector(".search-card.sel");
  if (sel) (sel as HTMLElement).scrollIntoView({ block: "nearest" });
}

/** Open a search hit: server upserts it into the roster (idempotent — keyed by transcript
 *  uuid), then we attach through the NORMAL roster path (resume into its claudeos tmux). */
async function openSearchResult(entry: any) {
  if (!entry) return;
  $("search-status").innerHTML = `<span class="search-spin"></span>opening session…`;
  try {
    const r = await (await fetch(`/api/session-search/open`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claudeSessionId: entry.claude_session_id }),
    })).json();
    if (!r.ok) { $("search-status").textContent = `open failed: ${r.error || "unknown"}`; return; }
    closeOverlays();
    await refresh();
    attachReviewSession(r.sessionId);
    setStatus(`resumed past session: ${(entry.title || "").slice(0, 60) || entry.claude_session_id}`);
  } catch { $("search-status").textContent = "open failed"; }
}

function showQuickPrompt() {
  wireQuickPromptFocusLock();
  const ta = $("quickprompt-input") as HTMLTextAreaElement;
  ta.value = "";
  // Priority starts OFF (none) every time the overlay opens — Ctrl+Enter reveals it on demand.
  const prio = $("quickprompt-prio") as HTMLInputElement;
  prio.value = "";
  $("quickprompt-prio-row").style.display = "none";
  $("quickprompt-overlay").style.display = "block";
  // Keyboard/programmatic focus pin: the mouse focus-lock above only catches clicks, but Tab or any
  // stray blur (e.g. a background render) could still strand focus elsewhere. While the overlay is
  // open, snap focus straight back to the box. Inert once closeOverlays() hides it (display:none),
  // so submit/Esc can hand focus cleanly back to the pane. Listener wired exactly once.
  // EXCEPTION: never yank focus away from the priority field — it's an in-overlay sibling, so
  // landing there (via Ctrl+Enter) is legitimate; only re-grab focus that escaped the overlay.
  if (!(ta as any)._focusPinned) {
    (ta as any)._focusPinned = true;
    ta.addEventListener("blur", () => {
      if ($("quickprompt-overlay").style.display === "none") return;
      setTimeout(() => {
        if ($("quickprompt-overlay").style.display === "none") return;
        if ($("quickprompt-overlay").contains(document.activeElement)) return; // focus still inside (e.g. prio field)
        ta.focus();
      }, 0);
    });
  }
  // focus on the next tick + clear, so the triggering 'i' keystroke never leaks into the box.
  setTimeout(() => { ta.value = ""; ta.focus(); }, 0);
}

/** Ctrl+Enter in the quick prompt: reveal the priority field and jump to it. Type a number
 *  0–100, then plain Enter sends with that manual importance (blank = none/default). */
function revealQuickPromptPriority() {
  $("quickprompt-prio-row").style.display = "flex";
  const prio = $("quickprompt-prio") as HTMLInputElement;
  setTimeout(() => { prio.focus(); prio.select(); }, 0);
}

/** Submit the quick-prompt overlay: launch a background Claude session with the typed text,
 *  close the overlay, and restore keyboard focus to the pane the operator was on. */
async function submitQuickPrompt() {
  const ta = $("quickprompt-input") as HTMLTextAreaElement;
  const text = ta.value.trim();
  // Optional manual importance from the priority field. Blank → null (none/default). Clamp 0–100.
  const rawPrio = ($("quickprompt-prio") as HTMLInputElement).value.trim();
  const importance = rawPrio === "" ? null : Math.max(0, Math.min(100, parseInt(rawPrio, 10) || 0));
  closeOverlays();
  applyKeyboardTarget(); // land the keyboard back where it was (terminal / overview)
  if (!text) { setStatus("quick prompt cancelled (empty)"); return; }
  setStatus("firing off a new Claude session…");
  const r = await api.newSession("claude", text, importance);
  if (!r || !r.ok) { setStatus("launch failed: " + ((r && r.message) || "unknown")); return; }
  await refresh();              // track the new session — but DON'T switch the view to it
  applyKeyboardTarget();        // refresh may re-render; keep focus where the operator was
  const prioMsg = importance == null ? "" : ` · priority ${importance}`;
  setStatus(`sent to a new Claude session #${r.sessionId}${prioMsg} — kept you where you were`);
}

async function act(fb: string) {
  const it = selectedItem();
  if (!it) return;
  await api.feedback(it.id, fb);
  setStatus(`feedback: ${fb} on “${it.session.title}”`);
  await api.tick();
  await refresh();
}

/** OPTIMISTIC ADVANCE: drop the acted-on item from the LOCAL queue and snap to the new #1
 *  immediately — no waiting for the server round-trip. The next SSE state update (after the
 *  server's cheap rerank) reconciles the real queue. Keeps z/send/ack feeling instant under
 *  load. */
function optimisticAdvance(itemId: number) {
  if (S.state && Array.isArray(S.state.queue)) {
    S.state.queue = S.state.queue.filter((q: any) => q.id !== itemId);
  }
  selectIndex(firstUnpinnedIndex()); // snap to the highest UNPINNED task (pins stay sticky on top)
  render();
}

/** master+↑/↓ — move the queue selection (prev/next task). Works in ALL panes incl. the
 *  terminal (the master is intercepted before the PTY). Landing applies the usual behavior
 *  (focus → Overview). The terminal session stays alive; it just follows the selected task. */
function moveQueueSel(dir: number) {
  if (!S.state || !Array.isArray(S.state.queue) || !S.state.queue.length) return;
  const cur = S.state.queue[S.sel];
  const real = S.state.queue.filter((q: any) => !q._virtual); // FIX M: nav over the REAL queue
  if (!real.length) { render(); return; }
  // current position in the real queue; a selected VIRTUAL entry counts as -1 so ↓ lands on real[0].
  const pos = cur && !cur._virtual ? real.indexOf(cur) : -1;
  const next = Math.max(0, Math.min(real.length - 1, pos + dir));
  if (pos === next && pos !== -1) { render(); return; } // already at an end → nothing moved
  // FIX L PART 2 (nav-stuck): navigating to a new task must NOT leave the operator stuck on the
  // previous task's terminal. Un-pin the terminal override (drops the virtual entry), reset manual
  // pane choices so the new task gets DEFAULT panes, blur the old xterm, focus the new OVERVIEW.
  _termOverride = null;
  S.paneManual.A = false;
  S.paneManual.B = false;
  S.focused = "A";
  try { if (S.term && (S.term as any).blur) (S.term as any).blur(); } catch {}
  try { (document.activeElement as HTMLElement)?.blur?.(); } catch {}
  S.state.queue = real; // virtual entry removed; indices now stable
  selectIndex(next); // FIX U: move by identity to the target task
  render();
}

/** master+Enter — "I'm done with this task." Dismiss it from Up Next WITHOUT sending any text
 *  to the session (the operator handled it themselves). Optimistic-advance + cheap server
 *  dismiss (undoable via u). The terminal session stays attached/alive. */
function dismissCurrentTask() {
  const it = selectedItem();
  if (!it) return;
  // A pinned task can't disappear from the top — Enter just advances to the next task; the pin
  // stays put. Unpin it first ({pin_toggle}) to actually dismiss it.
  if (it.session && it.session.pinned) {
    setStatus(`“${it.session.title}” is pinned — ${S.keymap.pin_toggle || "p"} to unpin before dismissing · advancing`);
    moveQueueSel(1);
    return;
  }
  const id = it.id, title = it.session.title;
  optimisticAdvance(id);
  setStatus(`dismissed “${title}” from Tasks — advancing (u to restore)`);
  (api as any).dismiss(id).catch(() => {});
}

async function sendSelected() {
  const it = selectedItem();
  if (!it) return;
  if (it.session.kind === "kanban") {
    if (it.session.kanban_startable === 1) showKanbanStartConfirm();
    else setStatus("answer the clarifying questions, then append to make it startable");
    return;
  }
  const id = it.id, title = it.session.title, isAck = it.category === "FYI_DONE";
  optimisticAdvance(id); // instant — don't wait on the server
  if (isAck) {
    api.ack(id).then(() => setStatus(`acknowledged “${title}”`)).catch(() => {});
  } else {
    api.sendAnswer(id).then((r: any) => setStatus(r.ok ? `sent to “${title}”: ${r.sent}` : `staged (no live session): ${r.sent || "(empty)"}`)).catch(() => {});
  }
}

/** Send a chosen candidate answer (A/B/C/D or a clicked option). Auto-advances to the
 *  new #1 instantly (quick answers are one keystroke → next task). */
async function sendOption(text: string) {
  const it = selectedItem();
  if (!it) return;
  const id = it.id;
  optimisticAdvance(id);
  api.sendAnswer(id, text).then((r: any) => setStatus(r.ok ? `sent: ${r.sent}` : `staged: ${r.sent}`)).catch(() => {});
}

/** Send the operator's free-typed custom answer from the answer input. */
async function sendTyped() {
  const it = selectedItem();
  const inp = document.getElementById("answer-input") as HTMLInputElement | null;
  if (!it) return;
  const text = (inp?.value || "").trim();
  if (!text) {
    // empty + Enter => send the first option if present
    const opts = optionsFor(it);
    if (opts[0]) await sendOption(opts[0].text);
    return;
  }
  const id = it.id;
  optimisticAdvance(id);
  api.sendAnswer(id, text).then((r: any) => setStatus(r.ok ? `sent custom: ${r.sent}` : `staged custom: ${r.sent}`)).catch(() => {});
}

async function doUndo() {
  const r = await api.undo();
  if (r && r.ok) setStatus(`undid: ${r.label}`);
  else setStatus("nothing to undo");
  await api.tick();
  await refresh();
}

// FIX: the app shell (<body>) is a fixed 100vh cockpit and must NEVER scroll. A stray
// scrollIntoView on ANY nested element can still programmatically scroll the overflow:hidden body
// (hidden blocks user wheel/scrollbar, NOT programmatic scrolls), sliding the whole page down with
// no way back except a reload. Snap the shell back to its origin whenever that happens.
window.addEventListener("scroll", () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); }, { passive: true });

window.addEventListener("keydown", async (e) => {
  const km = S.keymap;

  // FIX CC: context-aware Ctrl/Cmd +/- zoom — ALWAYS preventDefault (stop browser/Electron page
  // zoom). Terminal pane focused → terminal font (handled by the xterm key handler; here we just
  // block page-zoom). Otherwise → UI text scale (overview/diff/html + queue), independent + persisted.
  { const z = isZoomKey(e); if (z) { e.preventDefault(); if (S.panes[S.focused] !== "terminal") zoomUi(z * 0.05); return; } }

  // An open overlay OWNS the keyboard. Its input has DOM focus, but S.focused still points at the
  // pane underneath — so this MUST run before the master-arming and the terminal early-return below.
  // Otherwise: (a) when the overlay was opened over a focused TERMINAL pane, `S.panes[S.focused] ===
  // "terminal"` returns early and swallows the overlay's Esc/Enter (you can't close or submit it);
  // and (b) over a non-terminal pane, the master key (Ctrl+G) re-arms and yanks focus out of the box.
  if (overlayOpen()) { await handleOverlayKey(e); return; }

  // MAC ⌘ SHORTCUTS — handled here when the terminal doesn't own the keys (the xterm custom handler
  // catches them when it has focus). ⌘E archive · ⌘P pin · ⌘F focus · ⌘↑/⌘↓ prev/next task.
  if (runMacShortcut(e)) { e.preventDefault(); return; }

  // SINGLE-DISPATCH master: when the xterm actually HOLDS DOM focus, its custom handler owns the
  // master (and stopPropagation()s it), so the global handler must NOT also process it here.
  // But "the focused PANE shows a terminal" does not guarantee the xterm has DOM focus — right
  // after an overlay closes (focus → body, until the next render tick re-asserts term.focus())
  // the keyboard would otherwise be COMPLETELY dead: master skipped here, early-return below
  // swallows the rest. Process the master whenever the xterm does not really own the keys.
  const xtermHasDomFocus = !!(document.activeElement && (document.activeElement as HTMLElement).closest && (document.activeElement as HTMLElement).closest("#term-host"));
  if (S.panes[S.focused] !== "terminal" || !xtermHasDomFocus) {
    if (S.leaderActive) { e.preventDefault(); e.stopPropagation(); runMasterCmd(e); return; }
    if (isMasterKey(e)) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) startMaster(); return; }
  }

  // The FOCUSED pane shows the live terminal → xterm owns all OTHER keys. (This early return
  // is ALSO what lets Ctrl+Z pass through to the PTY as SIGTSTP when the terminal is focused —
  // the FIX N undo binding below is reached only OUTSIDE the terminal.)
  if (S.panes[S.focused] === "terminal") return;

  // FIX N: Ctrl+Z (or Cmd+Z) = UNDO — same as `u`, the existing undo stack (snooze / complete /
  // feedback / importance / …). Only OUTSIDE the terminal (there Ctrl+Z is SIGTSTP, handled by the
  // early return above) and not while typing in the answer box (leave the textarea's native undo).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z") && !answerInputFocused()) {
    e.preventDefault();
    await doUndo();
    return;
  }

  // GATED (operator request 2026-06-10): the bare pane keys (1/2/3/Tab) moved behind the master
  // (Ctrl+G o/t/d, Ctrl+G ;) — bare keys must never trigger cockpit actions.

  // Esc on a focused diff pane reverts it to its default view; `v` toggles Viewed on the diff.
  if (S.panes[S.focused] === "diff") {
    if (e.key === "Escape") { e.preventDefault(); setPaneView(S.focused, paneDefault(S.focused, selectedItem()), false); return; }
    if (S.panes[S.focused] === "diff" && e.key === "v") { e.preventDefault(); toggleFirstUnviewed(); return; }
    // Bare X = merge, ONLY while a diff pane is focused — the diff header advertises "X merge",
    // and there's no text input to collide with here (same reasoning as the bare `v` above).
    // Everywhere else merge stays gated behind the master (Ctrl+G X / Ctrl+G M).
    const mkKey = S.keymap.pr_merge || "X";
    if (!answerInputFocused() && e.key.toLowerCase() === mkKey.toLowerCase() && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); mergeCurrent(); return;
    }
  }

  // Answer input focused = typing a custom answer. The input behaves like a command
  // bar WHILE EMPTY (A/B/C/D pick, j/k browse, Enter=send option A); the moment you
  // type any other character it's literal text and Enter sends your custom answer.
  if (answerInputFocused()) {
    const inp = document.getElementById("answer-input") as HTMLTextAreaElement;
    const it = selectedItem();
    if (e.key === "Enter") {
      if (e.ctrlKey || e.shiftKey || e.metaKey) {
        // Ctrl/Shift+Enter => insert a newline at the cursor
        e.preventDefault();
        const start = inp.selectionStart ?? inp.value.length;
        const end = inp.selectionEnd ?? inp.value.length;
        inp.value = inp.value.slice(0, start) + "\n" + inp.value.slice(end);
        inp.selectionStart = inp.selectionEnd = start + 1;
        return;
      }
      e.preventDefault();
      await sendTyped();
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); inp.blur(); render(); return; }
    if (inp.value === "") {
      const low = e.key.toLowerCase();
      if (it && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const opts = optionsFor(it);
        const idx = opts.findIndex((o) => o.key.toLowerCase() === low);
        if (idx >= 0) { e.preventDefault(); await sendOption(opts[idx].text); return; }
      }
      if (e.key === "ArrowDown") { e.preventDefault(); inp.blur(); selectIndex(S.sel + 1); render(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); inp.blur(); selectIndex(S.sel - 1); render(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); inp.blur(); newClaudeTerminal(); return; } // ← = new Claude session
      // GATED (operator request 2026-06-10): the old empty-box command-bar letters (j/k/t/p/i/z/
      // u/?/r) now type LITERALLY into the box — all actions live behind the master (Ctrl+G).
    }
    return; // let the character type into the input
  }

  // (overlay keys are handled at the TOP of this listener via handleOverlayKey — see above)

  // jump mode: g then a digit
  if (S.jumpMode) {
    S.jumpMode = false;
    if (/[0-9]/.test(e.key)) {
      const idx = S.state.queue.findIndex((q: any) => q.session.slot === parseInt(e.key, 10));
      if (idx >= 0) { selectIndex(idx); render(); setStatus(`jumped to session ${e.key}`); }
    }
    return;
  }

  const k = e.key;

  // Arrow keys navigate the queue (operator request) — the ONLY bare keys that act. Everything
  // else (h/l priority, i importance, p pin, z snooze, option picks, views, …) is GATED behind
  // the master (Ctrl+G) — see runMasterCmd. Bare letters outside an input do nothing, so stray
  // typing can never trigger a cockpit action (operator request 2026-06-10).
  if (k === "ArrowDown") { e.preventDefault(); selectIndex(S.sel + 1); render(); return; }
  if (k === "ArrowUp") { e.preventDefault(); selectIndex(S.sel - 1); render(); return; }
  // ← in detail/nav (only) starts a NEW Claude session. (Inside the terminal, Left is a
  // cursor move — that path returns early above, so this never fires there.)
  if (k === "ArrowLeft" && S.panes[S.focused] !== "terminal") { e.preventDefault(); newClaudeTerminal(); return; }
});

// ---------- draggable resizers (queue | A | B), widths persisted to localStorage ----------
// CONTEXT-AWARE pane widths: the A|B split auto-adjusts to the selected task's mode —
// a PR/review task (Pane B = Diff) gets a wider diff (narrower Overview); a normal/question
// task is balanced. Defaults come from config (pane_a_frac_pr / pane_a_frac_default). A
// manual drag is remembered PER MODE and overrides the auto default until reset.
function widthMode(): "pr" | "default" {
  const it = selectedItem();
  return it && isDiffable(it) && (it.session.kind === "pr" || it.category === "REVIEW_DIFF" || S.panes.B === "diff") ? "pr" : "default";
}
function modeDefaultFrac(mode: "pr" | "default"): number {
  const c = (S.state && S.state.config) || {};
  return mode === "pr" ? (typeof c.pane_a_frac_pr === "number" ? c.pane_a_frac_pr : 0.3)
                       : (typeof c.pane_a_frac_default === "number" ? c.pane_a_frac_default : 0.5);
}
/** Resolved Pane-A fraction for the current mode: the operator's per-mode manual drag if set,
 *  else the config default for that mode. */
function currentPaneAFrac(): number {
  const mode = widthMode();
  const manual = localStorage.getItem(`cockpit.paneAFrac.${mode}`);
  const f = manual != null ? parseFloat(manual) : modeDefaultFrac(mode);
  return Math.max(0.2, Math.min(0.8, f));
}
function applyPaneWidths() {
  const qs = localStorage.getItem("cockpit.queueW");
  const main = $("main");
  const qw = qs ? Math.max(220, Math.min(560, parseInt(qs, 10))) : 320;
  // grid: queue | rz-q | A | rz-ab | B
  const paneA = $("pane-A"), paneB = $("pane-B");
  if (S.fullPane) {
    // FIX HH MAXIMIZE: the focused pane (any view) fills the whole working area; the OTHER pane
    // collapses to 0 width and the inner divider to 0. Queue column stays.
    // NOTE: we mark the collapsed pane with a class instead of display:none — display:none
    // removes the element from grid auto-placement and would shift the focused pane into the
    // wrong (0px) track. The grid 0fr + the class (border/overflow off) hide it cleanly.
    const aFr = S.fullPane === "A" ? 1 : 0;
    main.style.gridTemplateColumns = `${qw}px 6px minmax(0, ${aFr}fr) 0px minmax(0, ${1 - aFr}fr)`;
    paneA.classList.toggle("pane-collapsed", S.termPane !== "A");
    paneB.classList.toggle("pane-collapsed", S.termPane !== "B");
    return;
  }
  paneA.classList.remove("pane-collapsed");
  paneB.classList.remove("pane-collapsed");
  const aFrac = currentPaneAFrac();
  main.style.gridTemplateColumns = `${qw}px 6px minmax(220px, ${aFrac}fr) 6px minmax(260px, ${1 - aFrac}fr)`;
}
function wireResizers() {
  const main = $("main");
  const drag = (which: "q" | "ab") => (e: MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      if (which === "q") {
        const qw = Math.max(220, Math.min(560, ev.clientX - main.getBoundingClientRect().left));
        localStorage.setItem("cockpit.queueW", String(Math.round(qw)));
      } else {
        const rect = $("pane-A").getBoundingClientRect();
        const bRect = $("pane-B").getBoundingClientRect();
        const total = bRect.right - rect.left;
        const aFrac = Math.max(0.2, Math.min(0.8, (ev.clientX - rect.left) / total));
        // Remember the drag for THIS mode only (don't clobber the other mode's width).
        localStorage.setItem(`cockpit.paneAFrac.${widthMode()}`, String(aFrac.toFixed(3)));
      }
      applyPaneWidths();
      // (no per-move fit — the ResizeObserver on the term-host refits as its box changes)
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.classList.remove("dragging"); if (S.termPane) scheduleTermRefit(); };
    document.body.classList.add("dragging");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  $("rz-q").addEventListener("mousedown", drag("q"));
  $("rz-ab").addEventListener("mousedown", drag("ab"));
  $("rz-q").addEventListener("dblclick", () => { localStorage.removeItem("cockpit.queueW"); applyPaneWidths(); });
  // double-click resets THIS mode back to its config default
  $("rz-ab").addEventListener("dblclick", () => { localStorage.removeItem(`cockpit.paneAFrac.${widthMode()}`); applyPaneWidths(); if (S.termPane) scheduleTermRefit(); });
}

// ---------- DETACHED DETAIL WINDOW: view picker + render + init ----------
/** (detail window) pick the view per the operator's rule: an ACTUAL pull request → Diff;
 *  else a task HTML visualization exists → HTML; else Diff (the default). A mere REVIEW_DIFF
 *  triage (big local diff, NO real PR) must NOT outrank the task's html. */
function detailView(it: any): "diff" | "html" {
  if (!it) return "diff";
  const sid = it.session.id;
  const hasPr = it.session.kind === "pr" || !!sessionPrFor(sid);
  if (hasPr && isDiffable(it)) return "diff"; // actively reviewing a real PR → diff wins over html
  if (sessionVizFor(sid).length) return "html"; // a task HTML exists → html
  return "diff"; // default
}

/** (detail window) synthesize a queue-item shape from a ROSTER session (one with no actionable
 *  queue item — e.g. a working/opened session shown via virtual-top in the main window) so its
 *  diff/HTML can render in the detached window. Mirrors ensureVirtualTop's shape + stable id. */
function synthRosterItem(sessionId: number): any | null {
  const e = (S.state?.sessions || []).find((s: any) => s.row && s.row.id === sessionId);
  if (!e || !e.row) return null;
  const row = e.row;
  return {
    id: -1_000_000 - row.id, session_id: row.id, session: row, _virtual: true,
    category: (row.pr_number && row.pr_repo) ? "REVIEW_DIFF" : "● active", state: row.state, status: "pending",
    one_liner: "", question: "", suggested_answer: "", changed_lines: 0, priority: 0,
    score_breakdown: {}, default_view: "summary",
  };
}

/** (detail window) resolve the mirrored selection to an item: by item id (real queue items),
 *  then by SESSION id (the same session may carry a different item id here, or none at all),
 *  then — for a roster-only / virtual-top session with no queue item — synthesize one from the
 *  roster. Without the session-id fallback a virtual item id (main-window-only) resolves to
 *  nothing and the detail window silently shows queue[0] instead of the selected PR/session.
 *  Returns the queue index (or -1 for a synthesized item) so the caller can sync S.sel. */
function detailResolveItem(): { it: any | null; idx: number } {
  const q = (S.state?.queue as any[]) || [];
  let idx = _detailSelId != null ? q.findIndex((it) => it.id === _detailSelId) : -1;
  if (idx < 0 && _detailSelSessionId != null) idx = q.findIndex((it) => it.session_id === _detailSelSessionId);
  if (idx >= 0) return { it: q[idx], idx };
  return { it: _detailSelSessionId != null ? synthRosterItem(_detailSelSessionId) : null, idx: -1 };
}

/** (detail window) render the single full-window Diff/HTML pane for the mirrored selection. */
function renderDetail(): void {
  if (!S.state) return;
  const { it, idx } = detailResolveItem();
  if (idx >= 0) { S.sel = idx; S.selItemId = it.id; } else { S.sel = 0; S.selItemId = it ? it.id : null; }
  const body = $("pane-A-body");
  if (!it) { _detailRenderedId = null; _vizMountedKey = ""; body.classList.remove("pane-body--html"); body.innerHTML = `<div class="empty">No task selected in the main window.</div>`; return; }
  // task changed → drop any manual override + force a fresh content render
  if (_detailRenderedId !== it.id) {
    _detailRenderedId = it.id; _detailManual = false;
    S.paneItem.A = null; S.diffPatch.A = ""; _vizMountedKey = "";
  }
  const view = _detailManual ? (S.panes.A === "html" ? "html" : "diff") : detailView(it);
  if (S.panes.A !== view) { S.panes.A = view; S.paneItem.A = null; S.diffPatch.A = ""; _vizMountedKey = ""; }
  S.paneManual.A = true; // never let the shared reset logic yank this back to overview
  // active-tab highlight + only show the HTML tab when this task actually has a visualization
  document.querySelectorAll('.pane-tabs[data-tabs="A"] .tab').forEach((el) =>
    el.classList.toggle("active", (el as HTMLElement).dataset.mode === view));
  const htmlTab = document.querySelector('.pane-tabs[data-tabs="A"] .tab-html') as HTMLElement | null;
  if (htmlTab) htmlTab.style.display = sessionVizFor(it.session.id).length ? "" : "none";
  if (view === "html") { body.classList.add("pane-body--html"); renderHtmlInto(body, "A"); return; }
  body.classList.remove("pane-body--html");
  if (!isDiffable(it)) { body.innerHTML = `<div class="empty">No diff and no visualization for this task.</div>`; return; }
  if (S.paneItem.A !== it.id) { S.paneItem.A = it.id; loadDiffInto("A", it); }
}

/** Boot the detached Diff/HTML window: hide all chrome, mirror selection over the BroadcastChannel,
 *  and run an OWN /api/events feed (separate from api.onUpdate so we don't double-fire the desktop
 *  notifications/sounds the main window already plays). */
function initDetail(): void {
  document.body.classList.add("detail-mode");
  try { (window as any).cockpitS = S; } catch {} // test hook (same as render(), which never runs here)
  if (_detailChan) {
    _detailChan.onmessage = (e: MessageEvent) => {
      const m: any = e.data || {};
      if (m.type === "sel") { _detailSelId = m.id ?? null; _detailSelSessionId = m.sessionId ?? null; renderDetail(); }
    };
    try { _detailChan.postMessage({ type: "hello" }); } catch {} // ask the main window for the current selection
  }
  // detail-window tab strip → manual Diff/HTML override (cleared when the selected task changes)
  document.querySelectorAll('.pane-tabs[data-tabs="A"] .tab').forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const mode = (el as HTMLElement).dataset.mode as PaneView;
      if (mode !== "diff" && mode !== "html") return;
      if (mode === "html" && !sessionVizFor(detailResolveItem().it?.session.id ?? null).length) { setStatus("no visualization for this task"); return; }
      _detailManual = true; S.panes.A = mode; S.paneItem.A = null; S.diffPatch.A = ""; _vizMountedKey = "";
      renderDetail();
    }));
  wireDiffPaneDelegation(); // the diff's Viewed / Merge buttons work in the detached window too
  applyUiScale();
  const refreshDetail = async () => { try { S.state = await api.state(); renderDetail(); } catch {} };
  refreshDetail();
  try { const es = new EventSource("/api/events"); es.addEventListener("update", () => { refreshDetail(); }); es.onerror = () => {}; } catch {}
  window.addEventListener("resize", () => renderDetail());
  setStatus("ClaudeOS · detached Diff/HTML view — drag me to your other screen");
}

(async function init() {
  if (IS_DETAIL) { initDetail(); return; } // detached Diff/HTML window: lean boot, no terminal/queue/notifications
  S.keymap = await api.keymap();
  // Warn if the configured master key is browser-reserved (can't be intercepted in-app).
  const mw = masterBrowserWarning();
  if (mw) { try { console.warn("[ClaudeOS]", mw); } catch {} setTimeout(() => setStatus("⚠ " + mw), 500); }
  applyPaneWidths();
  wireResizers();
  // Re-fit the live terminal whenever the window resizes (keep the PTY matching the pane).
  window.addEventListener("resize", () => { if (S.term) scheduleTermRefit(); });
  wireNativeInject(); // desktop: route main-process-injected keys (e.g. Alt+Backspace) to the terminal
  try { (window as any)._routeInjectedInput = routeInjectedInput; } catch {} // UI-test hook

  await refresh();
  // terminal "detach" button (in the movable term-host).
  const bb = document.getElementById("term-back");
  if (bb) bb.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (S.fullPane) setPaneFull(null); else closeTerminal(); });
  const fb = document.getElementById("term-full-btn");
  if (fb) fb.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleTermFull(); });
  // Per-pane tab strips: click a tab → set that pane's view.
  document.querySelectorAll(".pane-tabs .tab").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const P = (el.closest(".pane-tabs") as HTMLElement).dataset.tabs as "A" | "B";
      setPaneView(P, (el as HTMLElement).dataset.mode as PaneView);
    })
  );
  // Click a pane to focus it.
  for (const P of ["A", "B"] as const) {
    const sec = document.getElementById(`pane-${P}`);
    if (sec) sec.addEventListener("mousedown", () => focusPane(P));
  }
  // Collapsible Learning panel — default collapsed (thin strip), toggle on click.
  const wt = document.getElementById("weights-toggle");
  if (wt) wt.addEventListener("click", () => {
    const panel = document.getElementById("weights-panel")!;
    const collapsed = panel.classList.toggle("collapsed");
    wt.innerHTML = `${collapsed ? "▸" : "▾"} Learning — weights, nudges &amp; nightly dreams <span class="dim">(click to ${collapsed ? "expand" : "collapse"})</span>`;
  });
  wireDiffPaneDelegation(); // FIX AA: delegated clicks for diff-pane buttons (Viewed + Merge)
  applyUiScale(); // FIX CC: restore persisted UI text scale
  // Detached Diff/HTML window: reply to its "hello" with the current selection, expose a manual
  // (re)open button, and auto-open it at startup (best-effort — a pop-up blocker may make the
  // operator click ⧉ detail once to allow it).
  if (_detailChan) _detailChan.onmessage = (e: MessageEvent) => { if ((e.data || {}).type === "hello") broadcastSel(); };
  const odb = document.getElementById("open-detail-btn");
  if (odb) odb.addEventListener("click", (e) => { e.preventDefault(); openDetailWindow(); });
  // Clickable Pin / Archive — same actions as the master-key shortcuts (Ctrl+G p / Ctrl+G e), but
  // discoverable and mouse-driven, so the operator never needs the leader chord. Both act on the
  // currently selected task; Archive is undoable (Ctrl+G u / the undo button).
  const pinBtn = document.getElementById("pin-btn");
  if (pinBtn) pinBtn.addEventListener("click", (e) => { e.preventDefault(); void togglePin(); });
  const archiveBtn = document.getElementById("archive-btn");
  if (archiveBtn) archiveBtn.addEventListener("click", (e) => { e.preventDefault(); completeSelected(); });
  // Click-to-expand the clamped overview rows (Goal/Next/Recap/You asked). Delegated so it survives
  // every re-render; toggles the row's key in _ovExpanded and re-renders so the full text shows.
  document.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement)?.closest?.(".ov-expandable") as HTMLElement | null;
    if (!row) return;
    const key = row.getAttribute("data-ovkey");
    if (!key) return;
    if (_ovExpanded.has(key)) _ovExpanded.delete(key); else _ovExpanded.add(key);
    render();
  });
  // ↻ re-prioritize: re-judge the WHOLE queue's importance against the current focus and re-rank
  // (overrides the Up-Next freeze for this one explicit action). Heavy — disable while it runs so a
  // double-click can't fire a second wave of model calls; scores then fill in over the next ticks.
  const rpb = document.getElementById("reprioritize-btn") as HTMLButtonElement | null;
  if (rpb) rpb.addEventListener("click", async (e) => {
    e.preventDefault();
    if (rpb.disabled) return;
    rpb.disabled = true;
    const prev = rpb.textContent;
    rpb.textContent = "↻ re-prioritizing…";
    setStatus("re-prioritizing the whole queue against your current focus…");
    try {
      const r = await api.reprioritize();
      setStatus(
        r && r.ok
          ? `re-prioritizing ${r.reprioritized} task${r.reprioritized === 1 ? "" : "s"} against focus — scores refresh as the model re-judges each`
          : "re-prioritize failed"
      );
    } catch {
      setStatus("re-prioritize failed");
    } finally {
      rpb.disabled = false;
      rpb.textContent = prev || "↻ re-prioritize";
      await refresh();
    }
  });
  // The Tasks-header search BAR is a trigger: focusing it opens the full search overlay (whose
  // own input takes over — it has the focus pin + results list). Any prefix already typed into
  // the bar is carried into the overlay so fast typers lose nothing.
  const sbar = document.getElementById("search-bar") as HTMLInputElement | null;
  if (sbar) sbar.addEventListener("focus", () => {
    const prefix = sbar.value;
    sbar.value = "";
    showSessionSearch(prefix);
  });
  setTimeout(() => openDetailWindow(), 400);
  api.onUpdate(async () => { await refresh(); });
  setStatus(`ClaudeOS ready · press ? for keys · ${masterLabel()} then o/t/d · ; switches pane`);

  // -------------------------------------------------------------------------
  // ＋ NEW-TERMINAL launcher (upper-left). Click → a dropdown of the repos in
  // config.sessions_repos; picking one launches a fresh `claude` session in a new
  // worktree of that repo and opens its terminal in pane B. Mirrors the account
  // picker's show/hide-menu pattern (no overlay keyboard plumbing needed).
  // -------------------------------------------------------------------------
  (function wireNewTermPicker() {
    const root = document.getElementById("new-term") as HTMLElement | null;
    const btn = document.getElementById("new-term-btn") as HTMLButtonElement | null;
    const menu = document.getElementById("new-term-menu") as HTMLUListElement | null;
    if (!root || !btn || !menu) return;

    function repos(): string[] {
      const r = (S.state && (S.state as any).config && (S.state as any).config.sessions_repos) || [];
      return Array.isArray(r) ? r.filter((x: any) => typeof x === "string" && x) : [];
    }
    function base(p: string): string { const parts = String(p).replace(/\/+$/, "").split("/"); return parts[parts.length - 1] || p; }

    async function launch(repo: string): Promise<void> {
      closeMenu();
      setStatus(`opening a new Claude terminal in ${base(repo)}…`);
      const r = await api.newSession("claude", undefined, undefined, repo).catch((e: any) => ({ ok: false, message: String(e) }));
      if (!r || !r.ok) { setStatus("launch failed: " + ((r && (r as any).message) || "unknown")); return; }
      await refresh();
      openTerminalView((r as any).sessionId!);
    }

    function renderMenu(): void {
      if (!menu) return;
      menu.innerHTML = "";
      const rs = repos();
      const head = document.createElement("li");
      head.className = "head";
      head.textContent = "New terminal in…";
      menu.appendChild(head);
      if (!rs.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "no repos — add paths to sessions_repos in config/weights.json";
        menu.appendChild(li);
        return;
      }
      for (const repo of rs) {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.className = "repo-name";
        name.textContent = base(repo);
        const path = document.createElement("span");
        path.className = "repo-path";
        path.textContent = repo;
        li.appendChild(name);
        li.appendChild(path);
        li.addEventListener("click", (e) => { e.stopPropagation(); void launch(repo); });
        menu.appendChild(li);
      }
    }

    function openMenu(): void { if (menu) { renderMenu(); menu.hidden = false; } }
    function closeMenu(): void { if (menu) menu.hidden = true; }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu && menu.hidden) openMenu(); else closeMenu();
    });
    document.addEventListener("click", (e) => { if (root && !root.contains(e.target as Node)) closeMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu && !menu.hidden) closeMenu(); });
  })();

  // -------------------------------------------------------------------------
  // Manual Claude-account picker (~/.claude.json swap).
  // Server: GET /api/accounts, POST /api/account/switch. Manual only — no auto-rotate.
  // -------------------------------------------------------------------------
  (function wireAccountPicker() {
    const root = document.getElementById("account-pick") as HTMLElement | null;
    const btn = document.getElementById("account-pick-btn") as HTMLButtonElement | null;
    const labelEl = document.getElementById("account-pick-label") as HTMLElement | null;
    const menu = document.getElementById("account-pick-menu") as HTMLUListElement | null;
    if (!root || !btn || !labelEl || !menu) return;

    let cache: { active: string | null; accounts: Array<{ label: string; capturedAt: string }> } | null = null;

    function fmtAge(iso: string): string {
      const ms = Date.now() - new Date(iso).getTime();
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    }

    function renderHeader(): void {
      if (!labelEl) return;
      labelEl.textContent = cache?.active ? `account: ${cache.active}` : `account: (none)`;
    }

    function renderMenu(): void {
      if (!menu) return;
      menu.innerHTML = "";
      const accounts = cache?.accounts ?? [];
      if (!accounts.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "no snapshots — run `node dist/cli.js account add <label>`";
        menu.appendChild(li);
        return;
      }
      for (const a of accounts) {
        const li = document.createElement("li");
        if (a.label === cache?.active) li.classList.add("active");
        const name = document.createElement("span");
        name.textContent = a.label;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = fmtAge(a.capturedAt);
        li.appendChild(name);
        li.appendChild(meta);
        li.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (a.label === cache?.active) { closeMenu(); return; }
          li.style.opacity = "0.5";
          try {
            const r = await (api as any).accountSwitch(a.label);
            if (r && r.ok) {
              if (cache) cache.active = a.label;
              renderHeader();
              renderMenu();
              setStatus(`account: switched to ${a.label}`);
            } else {
              setStatus(`account switch failed: ${(r && r.error) || "unknown"}`);
            }
          } catch (err: any) {
            setStatus(`account switch failed: ${String(err?.message || err)}`);
          } finally {
            li.style.opacity = "";
            closeMenu();
          }
        });
        menu.appendChild(li);
      }
    }

    function openMenu(): void { if (menu) { menu.hidden = false; renderMenu(); } }
    function closeMenu(): void { if (menu) menu.hidden = true; }

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { cache = await (api as any).accountsList(); } catch { /* keep stale cache */ }
      renderHeader();
      if (menu && menu.hidden) openMenu(); else closeMenu();
    });
    document.addEventListener("click", (e) => {
      if (root && !root.contains(e.target as Node)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menu && !menu.hidden) closeMenu();
    });

    (async () => {
      try { cache = await (api as any).accountsList(); renderHeader(); }
      catch { /* old server without endpoint — leave placeholder */ }
    })();
  })();
})();
