/**
 * Controller — the headless action layer behind the keymap. Every keystroke in the
 * UI maps to exactly one method here, so the entire operator loop is keyboard-drivable
 * AND testable without a window. The Electron renderer calls these over IPC; the test
 * harness calls them directly.
 */
import { DatabaseSync } from "node:sqlite";
import { Engine, RankedItem } from "./engine";
import { SessionManager, claudeLaunchCmd } from "./sessions";
import { applyFeedback, Feedback, allAdjustments, recentDecisions, AdjustmentRow } from "./feedback";
import { recordAnswer } from "./answerLog";
import { loadConfig, saveFocus, FullConfig, Weights } from "./config";
import { lastDreams } from "./dream";
import { ItemRow, SessionRow, SessionState, setPinned, setManualImportance, setManualStateOverride, setSessionState, setManualTitle, setSnoozePenalty, recordExample, getLearnedWeights, recentExamples } from "./db";
import { effectiveSnoozePenalty } from "./priority";
import { readRanking } from "./ranking";
import { prDiff, prStatus, prMerge, prSeedPrompt, localRepoForPr } from "./pr";
import { createPrWorktree, gitEnv } from "./worktree";
import { pretrust } from "./pretrust";
import { FAKE_PR_DIFF, FAKE_PR_STATUS } from "./demo";
import { pushUndo, undo as undoStack, peekUndo, undoCount, nextDecisionLogId, UndoOp } from "./undo";

const NUDGE = 5; // mirror of feedback.ts so undo can reverse a nudge

/** The signal-adjustment / view-pref ops that REVERSE a given feedback verb. */
function reverseFeedbackOps(category: string | null, fb: Feedback): UndoOp[] {
  const ops: UndoOp[] = [];
  const catKey = category ? `category:${category}` : null;
  const half = Math.round(NUDGE / 2);
  switch (fb) {
    case "priority_high": if (catKey) ops.push({ t: "bump", key: catKey, delta: +NUDGE }); break;
    case "priority_low": if (catKey) ops.push({ t: "bump", key: catKey, delta: -NUDGE }); break;
    case "good": if (catKey) ops.push({ t: "bump", key: catKey, delta: -half }); break;
    case "wrong":
      if (catKey) ops.push({ t: "bump", key: catKey, delta: +NUDGE });
      if (category) ops.push({ t: "bumpView", category, rawDelta: -1, ctxDelta: 0 });
      break;
    case "too_much_output": if (category) ops.push({ t: "bumpView", category, rawDelta: +1, ctxDelta: 0 }); break;
    case "need_more_context": if (category) ops.push({ t: "bumpView", category, rawDelta: 0, ctxDelta: -1 }); break;
  }
  return ops;
}

// Per-session stats for the Overview "this session" panel. Everything here is cheap: SQLite
// aggregates over the already-logged items table + the transcript file SIZE as a context proxy
// (ClaudeOS has no token meter, so estTokens ≈ bytes/4).
export interface SessionMetric {
  id: number;
  title: string;
  state: string;
  working: boolean;
  ageMs: number; // now - createdAt — how long this session has been running
  sinceLastMs: number | null; // now - last activity — how long since it last replied to you
  estTokens: number; // ≈ transcript bytes / 4
  ctxLevel: "green" | "yellow" | "red"; // >150k amber, >300k red
  cameBack: number; // how many times this session surfaced needing you (items)
  answered: number; // of those, how many you've decided
  medianReplyMs: number | null; // median time its items sat before you acted
  avgQueueWaitMs: number | null; // average of the same
}

// One hour of queue flow, for the Overview throughput chart. 24 of these, oldest → newest;
// the last bucket is the (partial) current hour. Only real operator tasks count: kind='claude',
// not a teammate sub-agent, and completions exclude the 'auto' idle-reaper (see throughput()).
export interface HourBucket {
  hourStartMs: number; // epoch ms of the bucket's start (UTC-hour aligned; whole-hour zones render cleanly)
  started: number; // sessions first discovered/created in this hour
  completed: number; // sessions the operator completed (Ctrl+G e) in this hour
  answered: number; // queue items genuinely answered (decision 'sent'/'ack') — dismissals and card-starts don't count
}

// Global queue-flow stats for the Overview "task queue" panel: how much is waiting, how fast
// tasks start/complete, and the 24h curve. All from timestamps already in the DB.
export interface ThroughputSnapshot {
  queuedNow: number; // actionable items in Up Next right now
  completedTotal: number; // all-time operator-completed sessions
  startedLastHour: number; // rolling last 60 minutes (not the wall-clock bucket)
  completedLastHour: number;
  answeredLastHour: number;
  started24h: number; // sums of the hourly buckets — always agrees with the chart
  completed24h: number;
  answered24h: number;
  completed12h: number; // rolling last 12h vs the 12h before — the pace comparison
  completedPrev12h: number;
  hourly: HourBucket[]; // 24 UTC-hour buckets, oldest → newest
  recentCompletions: { title: string; atMs: number }[]; // newest first, ≤ 5
  doneByTag: { tag: string; n: number }[]; // all-time completions per category tag, desc; "untagged" last
}

export interface MetricsSnapshot {
  totals: { sessions: number; working: number }; // the only GLOBAL numbers shown
  sessions: SessionMetric[];
  throughput: ThroughputSnapshot; // global queue-flow stats (Overview "task queue" panel)
}

export interface CockpitState {
  next: RankedItem | null; // single recommended action
  queue: RankedItem[]; // compact queue behind it
  metrics: MetricsSnapshot; // Overview dashboard (uptime, context, response times)
  sessions: { row: SessionRow; surfaced: boolean; lastActivity: string; startedAt: string; viz?: { name: string; file: string }[]; pr?: any | null }[];
  focus: string;
  weights: Weights;
  adjustments: AdjustmentRow[];
  recent: any[];
  dreams: { ran_at: string; summary: string }[];
  demo: boolean; // true => safe sandbox; UI shows a "nothing is real" banner
  undo: { available: boolean; label: string; count: number }; // most-recent reversible action
  config: { build?: string; terminal_poll_ms: number; terminal_font_size: number; auto_open_terminal_on_complex: boolean; auto_diff_on_pr_review: boolean; auto_html_on_viz: boolean; sessions_repos: string[]; pane_a_frac_default: number; pane_a_frac_pr: number; chat_enabled?: boolean }; // UI-facing knobs
  learning: {
    weights: { key: string; base: number; delta: number; effective: number }[]; // base + learned
    examples: any[]; // recent training examples (state/predicted/correct)
    ranking: string; // RANKING.md contents
  };
}

export class Controller {
  constructor(
    private db: DatabaseSync,
    private engine: Engine,
    private sessions: SessionManager,
    private cfg: FullConfig,
    private demo = false
  ) {}

  reloadConfig(): void {
    this.cfg = loadConfig();
    this.engine.setConfig(this.cfg);
  }

  /** FIX AA: short git commit hash of the running build (computed once), surfaced in the header so
   *  a stale renderer (operator hasn't refreshed) is obvious in a screenshot. */
  private _buildHash: string | undefined;
  buildHash(): string {
    if (this._buildHash !== undefined) return this._buildHash;
    try { this._buildHash = String(require("child_process").execSync("git rev-parse --short HEAD", { cwd: __dirname, encoding: "utf8" }).trim()); }
    catch { this._buildHash = ""; }
    return this._buildHash || "";
  }

  async tick() {
    return this.engine.tick();
  }

  /** Full snapshot for rendering. The first queue entry IS the recommended next action. */
  state(): CockpitState {
    const queue = this.engine.queue();
    // Attach the SOUL-voiced gist (highlights of the session's conversation) to each item, for the
    // chat view. Cheap: a Map lookup of the beats the tick already computed (no model call here).
    if ((this.cfg as any).chat?.enabled !== false) {
      try {
        const { cachedGist } = require("./gist");
        for (const q of queue) {
          const g = cachedGist(q.session_id);
          if (g && g.beats && g.beats.length) (q as any).gist = g.beats;
        }
      } catch {}
    }
    const surfacedIds = new Set(queue.map((q) => q.session_id));
    const nowMs = Date.now();
    const sessions = this.sessions.list()
      // ROSTER FILTER: a teammate is a Claude Code sub-agent (review-fleet rev-*/tester, supervised
      // worker/worker2) represented ONLY by its team-group row in the queue. It never belongs in the
      // operator's session roster — listing each one just clutters the panel with perma-stale
      // "Working directory: ~…" rows (2026-06-16/17). Hide ALL teammates.
      .filter((row) => !(row as any).is_teammate)
      .map((row) => {
      // The 💤 badge must show the LIVE decayed penalty (it recovers linearly over
      // snooze_recover_hours), not the stale stored value from snooze time.
      (row as any).snooze_effective = effectiveSnoozePenalty(row.snooze_penalty || 0, row.snoozed_at ?? null, this.cfg.snooze_recover_hours ?? 5, nowMs);
      return { row, surfaced: surfacedIds.has(row.id), lastActivity: this.lastActivityOf(row), startedAt: this.startedAtOf(row), viz: this.sessionViz(row.id), pr: this.sessionPr(row) };
    });
    return {
      // team-group rows are informational — a running team never needs the operator, so it is
      // never the recommended next action.
      next: queue.find((q) => !q._team) || null,
      queue,
      metrics: this.metrics(sessions, queue.filter((q) => !q._team).length),
      sessions,
      focus: this.cfg.focus,
      weights: this.cfg.weights,
      adjustments: allAdjustments(this.db),
      recent: recentDecisions(this.db),
      dreams: lastDreams(this.db, 3),
      demo: this.demo,
      undo: (() => {
        const p = peekUndo(this.db);
        return { available: !!p, label: p?.label || "", count: undoCount(this.db) };
      })(),
      config: {
        build: this.buildHash(), // FIX AA: short commit hash — visible in the header to catch stale renderers
        terminal_poll_ms: this.cfg.terminal_poll_ms,
        terminal_font_size: this.cfg.terminal_font_size,
        auto_open_terminal_on_complex: this.cfg.auto_open_terminal_on_complex,
        auto_diff_on_pr_review: this.cfg.auto_diff_on_pr_review,
        auto_html_on_viz: this.cfg.auto_html_on_viz,
        sessions_repos: this.cfg.sessions_repos,
        pane_a_frac_default: this.cfg.pane_a_frac_default,
        pane_a_frac_pr: this.cfg.pane_a_frac_pr,
        chat_enabled: (this.cfg as any).chat?.enabled !== false, // renderer uses chat as the Pane A default when on
      },
      learning: (() => {
        const learned = getLearnedWeights(this.db);
        const w: any = this.cfg.weights;
        return {
          weights: Object.keys(w).map((k) => ({ key: k, base: w[k], delta: +(learned[k] || 0).toFixed(3), effective: +(w[k] + (learned[k] || 0)).toFixed(3) })),
          examples: recentExamples(this.db, 12),
          ranking: readRanking(),
        };
      })(),
    };
  }

  /** Parse a SQLite datetime('now') string ("YYYY-MM-DD HH:MM:SS", UTC, no T/Z) OR an ISO
   *  string to epoch ms. Returns NaN on junk so callers can skip it. */
  private msOf(s: string | null | undefined): number {
    if (!s) return NaN;
    return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(" ", "T") + "Z" : s);
  }

  /** Per-session stats for the Overview "this session" panel. Cheap: one SQLite scan of the
   *  already-logged items table + a statSync per transcript (context-size proxy — ClaudeOS has no
   *  token meter, so estTokens ≈ transcript bytes / 4). The only global numbers are the counts. */
  metrics(sessions: { row: SessionRow; lastActivity: string; startedAt: string }[], queuedNow = 0): MetricsSnapshot {
    const now = Date.now();
    const fs = require("fs");
    const median = (xs: number[]): number | null => {
      if (!xs.length) return null;
      const a = [...xs].sort((p, q) => p - q);
      const m = a.length >> 1;
      return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
    };
    const mean = (xs: number[]): number | null =>
      xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

    // Every item per session: cameBack = how many times it surfaced needing you; for the DECIDED
    // ones, how long each sat before you acted (updated_at − created_at) → reply-time stats.
    const items = this.db
      .prepare("SELECT session_id, status, created_at, updated_at FROM items")
      .all() as { session_id: number; status: string; created_at: string; updated_at: string }[];
    const cameBack = new Map<number, number>();
    const waitBySession = new Map<number, number[]>();
    for (const it of items) {
      cameBack.set(it.session_id, (cameBack.get(it.session_id) || 0) + 1);
      if (it.status !== "decided") continue;
      const w = this.msOf(it.updated_at) - this.msOf(it.created_at);
      if (!Number.isFinite(w) || w < 0) continue;
      const arr = waitBySession.get(it.session_id) || [];
      arr.push(w);
      waitBySession.set(it.session_id, arr);
    }

    const CTX_RED = 300_000, CTX_YEL = 150_000;
    const sess: SessionMetric[] = sessions.map((s) => {
      const row = s.row;
      let bytes = 0;
      if (row.transcript_path) { try { bytes = fs.statSync(row.transcript_path).size; } catch {} }
      const estTokens = Math.round(bytes / 4);
      const ctxLevel = estTokens > CTX_RED ? "red" : estTokens > CTX_YEL ? "yellow" : "green";
      const startedMs = this.msOf(row.created_at);
      const lastMs = this.msOf(s.lastActivity);
      const waits = waitBySession.get(row.id) || [];
      return {
        id: row.id,
        title: (row as any).manual_title || (row as any).clean_title || row.title || "(untitled)",
        state: row.state || "UNKNOWN",
        working: row.state === "WORKING",
        ageMs: Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0,
        sinceLastMs: Number.isFinite(lastMs) ? Math.max(0, now - lastMs) : null,
        estTokens,
        ctxLevel,
        cameBack: cameBack.get(row.id) || 0,
        answered: waits.length,
        medianReplyMs: median(waits),
        avgQueueWaitMs: mean(waits),
      };
    });

    return {
      totals: { sessions: sessions.length, working: sess.filter((x) => x.working).length },
      sessions: sess,
      throughput: this.throughput(now, queuedNow),
    };
  }

  /** Global queue-flow stats: starts (sessions.created_at), completions (sessions.completed_at),
   *  answers (items decided). ONLY real operator tasks count — kind='claude' AND not a teammate
   *  sub-agent — never the auto-upserted pr/kanban cards or shell terminals (a PR scan inserting
   *  30 cards is not "30 started"), and completions exclude the 'auto' idle-reaper (an idle-dead
   *  session is not DONE). Bucketed into 24 UTC-hours for the Overview chart; the 24h totals are
   *  the bucket sums so tiles and chart always agree. Timestamp-only scans, cheap. */
  private throughput(now: number, queuedNow: number): ThroughputSnapshot {
    const HOUR = 3_600_000;
    const hour0 = Math.floor(now / HOUR) * HOUR - 23 * HOUR; // start of the oldest bucket
    const hourly: HourBucket[] = Array.from({ length: 24 }, (_, i) => ({
      hourStartMs: hour0 + i * HOUR, started: 0, completed: 0, answered: 0,
    }));
    const lastHour = { started: 0, completed: 0, answered: 0 };
    let completed12h = 0, completedPrev12h = 0;
    const tally = (kind: "started" | "completed" | "answered", atMs: number) => {
      if (!Number.isFinite(atMs)) return; // junk stamp
      const age = now - atMs;
      if (age < 0) return; // future stamp
      if (age <= HOUR) lastHour[kind]++;
      if (kind === "completed") {
        if (age <= 12 * HOUR) completed12h++;
        else if (age <= 24 * HOUR) completedPrev12h++;
      }
      const idx = Math.floor((atMs - hour0) / HOUR);
      if (idx >= 0 && idx < 24) hourly[idx][kind]++;
    };
    // Real operator tasks only (matches every kind-filtered query in discover/pr).
    const TASKS = "kind='claude' AND COALESCE(is_teammate,0)=0";
    const DONE = `completed_at IS NOT NULL AND ${TASKS} AND COALESCE(completed_by,'operator')!='auto'`;
    // 24h cutoff for the tally scans — this runs on every /api/state, and sessions/items only
    // grow, so the window queries must not materialize all history. The SQLite-shaped cutoff
    // ("YYYY-MM-DD HH:MM:SS") compares correctly against BOTH stored formats: same-prefix ISO
    // stamps sort above it ('T' > ' '), earlier dates below. The only error direction is
    // over-inclusion (up to the cutoff's whole calendar day for ISO stamps) — harmless since
    // tally() re-filters by age.
    const cutoff = new Date(now - 24 * HOUR).toISOString().replace("T", " ").replace(/\..*$/, "");

    const starts = this.db
      .prepare(`SELECT created_at FROM sessions WHERE ${TASKS} AND created_at >= ?`)
      .all(cutoff) as { created_at: string }[];
    for (const s of starts) tally("started", this.msOf(s.created_at));

    const done = this.db
      .prepare(`SELECT completed_at FROM sessions WHERE ${DONE} AND completed_at >= ?`)
      .all(cutoff) as { completed_at: string }[];
    for (const d of done) tally("completed", this.msOf(d.completed_at));

    const answers = this.db
      .prepare(
        `SELECT i.updated_at FROM items i JOIN sessions s ON s.id=i.session_id
         WHERE i.status='decided' AND i.decision IN ('sent','ack')
           AND s.kind='claude' AND COALESCE(s.is_teammate,0)=0 AND i.updated_at >= ?`
      )
      .all(cutoff) as { updated_at: string }[];
    for (const a of answers) tally("answered", this.msOf(a.updated_at));

    const completedTotal = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${DONE}`)
      .get() as { n: number }).n;
    // Newest few completions for the "latest" list — fetch a small buffer so one junk stamp
    // among the newest rows can't shrink the visible top-5.
    const recent = this.db
      .prepare(
        `SELECT completed_at, COALESCE(manual_title, clean_title, title) AS t FROM sessions
         WHERE ${DONE} ORDER BY completed_at DESC LIMIT 10`
      )
      .all() as { completed_at: string; t: string }[];

    // All-time completions per category tag (tags = JSON array per session; a session counts
    // once toward EACH of its tags). SQLite json_each avoids materializing rows in JS; tags
    // come from the enricher/infraTags with a small fixed vocabulary, so the group-by is tiny.
    // try/catch: json_each throws on a malformed tags value — degrade to no tag row, never 500.
    let doneByTag: { tag: string; n: number }[] = [];
    try {
      // ${DONE} reused verbatim (unqualified columns resolve against sessions — json_each's
      // columns don't collide) so the tag breakdown can never drift from completedTotal's
      // filters. COUNT(DISTINCT id) so a duplicated tag in one array still counts the session
      // once; j.type='text' drops non-string junk a hand-edited row could carry.
      doneByTag = this.db
        .prepare(
          `SELECT j.value AS tag, COUNT(DISTINCT s.id) AS n FROM sessions s, json_each(COALESCE(s.tags,'[]')) j
           WHERE ${DONE} AND j.type='text'
           GROUP BY j.value ORDER BY n DESC, tag LIMIT 12`
        )
        .all() as { tag: string; n: number }[];
      const untagged = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${DONE} AND json_array_length(COALESCE(tags,'[]'))=0`)
        .get() as { n: number }).n;
      if (untagged > 0) doneByTag.push({ tag: "untagged", n: untagged });
    } catch (e) {
      doneByTag = []; // all-or-nothing: the untagged COUNT can throw after the tag rows succeeded
      console.error("[metrics] doneByTag query failed (malformed tags JSON?):", e);
    }

    return {
      queuedNow,
      completedTotal,
      startedLastHour: lastHour.started,
      completedLastHour: lastHour.completed,
      answeredLastHour: lastHour.answered,
      started24h: hourly.reduce((a, b) => a + b.started, 0),
      completed24h: hourly.reduce((a, b) => a + b.completed, 0),
      answered24h: hourly.reduce((a, b) => a + b.answered, 0),
      completed12h,
      completedPrev12h,
      hourly,
      recentCompletions: recent
        .map((d) => ({ title: d.t || "(untitled)", atMs: this.msOf(d.completed_at) }))
        .filter((d) => Number.isFinite(d.atMs))
        .slice(0, 5),
      doneByTag,
    };
  }

  /** Extract the interpretable ranking features of a queue item (for training examples
   *  + the nightly small-LR gradient). Signal values come straight from the transparent
   *  score breakdown, so what we learn from is exactly what's shown. */
  featuresOf(q: RankedItem, rank: number): Record<string, number | string | null> {
    const bd: any[] = (q.score_breakdown && q.score_breakdown.breakdown) || [];
    const sig = (name: string) => { const t = bd.find((x) => x.signal === name); return t ? t.raw : 0; };
    return {
      id: q.id,
      session_id: q.session_id,
      category: q.category,
      rank,
      llm_importance: q.importance,
      manual_importance: q.session ? q.session.manual_importance : null,
      blocks_other_work: q.session && q.session.blocks_other_work ? 1 : 0,
      focus_match: sig("focus_match"),
      effort_small: sig("effort_small"),
      staleness: sig("staleness"),
      deadline: sig("deadline"),
      snooze_penalty: q.session ? q.session.snooze_penalty || 0 : 0,
      priority: q.priority,
    };
  }

  private getItem(itemId: number): ItemRow | undefined {
    return this.db.prepare("SELECT * FROM items WHERE id=?").get(itemId) as unknown as ItemRow | undefined;
  }
  private getSession(id: number): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as unknown as SessionRow | undefined;
  }

  /** Accept (optionally edited) the suggested answer and send it to the session. */
  sendAnswer(itemId: number, answer?: string): { ok: boolean; sent: string } {
    const it = this.getItem(itemId);
    if (!it) return { ok: false, sent: "" };
    const session = this.getSession(it.session_id);
    if (!session) return { ok: false, sent: "" };
    const text = (answer ?? it.suggested_answer ?? "").trim();
    const ok = text ? this.sessions.sendInput(session, text) : false;

    // ANSWER-QUALITY CAPTURE (draft-comparison loop): keep BOTH what we suggested and
    // what the operator actually sent, plus which A/B/C/D option they chose. Strictly
    // additive — never touches ranking. Best-effort: a failure here must not block the send.
    let answerFbId = 0;
    try {
      let options: string[] = [];
      if (it.answer_options) {
        const raw = JSON.parse(it.answer_options);
        if (Array.isArray(raw)) options = raw.map((o: any) => (typeof o === "string" ? o : o?.text ?? "")).filter(Boolean);
      }
      answerFbId = recordAnswer(this.db, {
        itemId,
        sessionId: it.session_id,
        category: it.category,
        state: it.state,
        question: it.question || it.one_liner || "",
        suggested: it.suggested_answer || "",
        options,
        final: text,
      });
    } catch { /* answer capture is best-effort */ }

    // IMPLICIT SKIP-LEARNING: capture the queue rank BEFORE we mark this decided. If the
    // operator completed a task that was NOT #1, the higher-ranked items they skipped
    // were (mildly) over-ranked and this lower pick was under-ranked — log both so the
    // nightly dream can nudge those categories.
    const leapfrogOps: UndoOp[] = [];
    const queueNow = this.engine.queue();
    const idx = queueNow.findIndex((q) => q.id === itemId);
    if (idx > 0) {
      const pickRow = this.db
        .prepare("INSERT INTO decision_log (item_id, session_id, category, state, feedback) VALUES (?,?,?,?, 'leapfrogged_pick')")
        .run(itemId, it.session_id, it.category ?? null, it.state);
      leapfrogOps.push({ t: "delDecisionLog", id: Number(pickRow.lastInsertRowid) });
      const seen = new Set<string>();
      for (const higher of queueNow.slice(0, idx)) {
        const c = higher.category || "";
        if (!c || seen.has(c)) continue; // one signal per skipped category
        seen.add(c);
        const overRow = this.db
          .prepare("INSERT INTO decision_log (item_id, session_id, category, state, feedback) VALUES (?,?,?,?, 'leapfrogged_over')")
          .run(higher.id, higher.session_id, c, higher.state);
        leapfrogOps.push({ t: "delDecisionLog", id: Number(overRow.lastInsertRowid) });
      }
      // Training example: state = the full ranked queue's features at decision time;
      // predicted = the model's order; correct = the item the operator actually picked
      // (and the higher-ranked ones they skipped).
      try {
        const state = queueNow.map((q, i) => this.featuresOf(q, i));
        recordExample(this.db, "leapfrog", state, { order: queueNow.map((q) => q.id) }, { picked: itemId, skippedHigher: queueNow.slice(0, idx).map((q) => q.id) });
      } catch {}
    }

    const dlId = nextDecisionLogId(this.db);
    // record decision + mark decided (it goes back to WORKING on next tick).
    applyFeedback(this.db, {
      itemId,
      sessionId: it.session_id,
      category: it.category,
      state: it.state,
      feedback: "decided",
    } as any);
    this.db
      .prepare("UPDATE items SET status='decided', decision='sent', updated_at=datetime('now') WHERE id=?")
      .run(itemId);
    // Engaging with the task (a real answer) HALVES the remaining (decayed) snooze penalty
    // (round toward 0; snap to 0 once tiny) — a "kept deferring" signal that partially
    // recovers as the operator engages, rather than snapping fully back. The decay clock is
    // restarted on the halved value so it keeps recovering linearly from here.
    const prevPenalty = session.snooze_penalty || 0;
    const prevSnoozedAt = session.snoozed_at ?? null;
    if (prevPenalty < 0) {
      const recoverH = this.cfg.snooze_recover_hours ?? 5;
      const eff = effectiveSnoozePenalty(prevPenalty, prevSnoozedAt, recoverH, Date.now());
      let next = Math.round(eff / 2);
      if (Math.abs(next) < 5) next = 0;
      setSnoozePenalty(this.db, it.session_id, next, next < 0 ? new Date().toISOString() : null);
    }
    pushUndo(this.db, "sendAnswer", `sent answer to “${session.title}”`, [
      { t: "setItem", id: itemId, fields: { status: it.status, decision: it.decision } },
      { t: "setSession", id: it.session_id, fields: { snooze_penalty: prevPenalty, snoozed_at: prevSnoozedAt } }, // restore EXACT prior value
      { t: "delDecisionLog", id: dlId },
      ...(answerFbId ? [{ t: "delAnswerFeedback", id: answerFbId } as UndoOp] : []),
      ...leapfrogOps,
    ]);
    return { ok, sent: text };
  }

  /** Acknowledge an FYI_DONE / clear an item without sending. */
  ack(itemId: number): void {
    const it = this.getItem(itemId);
    if (!it) return;
    this.db.prepare("UPDATE items SET status='decided', decision='ack', updated_at=datetime('now') WHERE id=?").run(itemId);
    // ack does NOT change the snooze penalty (only a real answer halves it).
    pushUndo(this.db, "ack", "acknowledged item", [
      { t: "setItem", id: itemId, fields: { status: it.status, decision: it.decision } },
    ]);
  }

  /** Dismiss: the operator HANDLED this task themselves (e.g. typed in the terminal) and wants
   *  it off Up Next. Marks it decided (decision='done') WITHOUT sending any text to the session.
   *  Undoable (u restores it to pending). The session stays tracked and may resurface later. */
  dismiss(itemId: number): void {
    const it = this.getItem(itemId);
    if (!it) return;
    // FIX P: dismiss = SNOOZE-UNTIL-READY, not permanent. Stamp dismissed_at so the engine can
    // RE-SURFACE this task the moment its session shows FRESH activity (transcript written after
    // the dismiss). NOTE: dismiss does NOT set completed_at and does NOT touch the session row →
    // the session stays in the roster and remains eligible to re-surface (only Complete archives).
    this.db.prepare("UPDATE items SET status='decided', decision='done', dismissed_at=?, updated_at=datetime('now') WHERE id=?").run(new Date().toISOString(), itemId);
    // Dismissing = "I handled this" → UNSNOOZE it: clear any accumulated snooze penalty so the
    // session resurfaces at its NATURAL priority next time, instead of staying permanently sunk.
    // (Snooze applies a sticky penalty that otherwise never clears — see snooze().) Undoable.
    const session = this.getSession(it.session_id);
    const prevPenalty = session?.snooze_penalty || 0;
    const prevSnoozedAt = session?.snoozed_at ?? null;
    if (prevPenalty < 0) setSnoozePenalty(this.db, it.session_id, 0, null);
    pushUndo(this.db, "dismiss", "dismissed task from Up Next", [
      { t: "setItem", id: itemId, fields: { status: it.status, decision: it.decision, dismissed_at: (it as any).dismissed_at ?? null } },
      ...(prevPenalty < 0 ? [{ t: "setSession", id: it.session_id, fields: { snooze_penalty: prevPenalty, snoozed_at: prevSnoozedAt } } as UndoOp] : []),
    ]);
  }

  // FIX X: per-session GitHub PR detection. gh is slow (~1s) so NEVER called from state(); a
  // background sweep + the lazy /api/sessionPr endpoint populate this cache (TTL 60s). state()
  // only READS the cache (or the cheap pr_number marker fallback).
  private _prCache = new Map<string, { at: number; pr: any | null }>();
  private _prKey(s: any): string { return `${s.worktree_path || ""}::${s.branch || ""}`; }

  /** "Latest output" timestamp for the sessions roster — the transcript file's mtime (the moment
   *  Claude last WROTE), which is what the operator means by "this happened 30 min ago". Falls back
   *  to pr_updated_at (PR rows have no transcript) then the session row's updated_at. Returns ISO. */
  private lastActivityOf(s: SessionRow): string {
    // Transcript mtime is the TRUE "last output" moment — prefer it. We must NOT max it against
    // updated_at: the scan tick bumps every session's updated_at to ~now, which would collapse the
    // whole roster to "just now". Only fall back to row timestamps when there's NO transcript.
    const tPath = s.transcript_path;
    if (tPath) { try { return new Date(require("fs").statSync(tPath).mtimeMs).toISOString(); } catch {} }
    // No transcript (PR / kanban / shell / output-less rows): pr_updated_at is meaningful; else
    // created_at (STABLE — unlike updated_at, which the tick bumps to now, falsely reading "just
    // now"). SQLite datetime('now') stores "YYYY-MM-DD HH:MM:SS" (UTC, no T/Z) — normalize.
    const fallback = s.pr_updated_at || s.created_at || s.updated_at || "";
    const ms = fallback ? Date.parse(fallback.includes("T") ? fallback : fallback.replace(" ", "T") + "Z") || 0 : 0;
    return new Date(ms).toISOString();
  }

  /** When the session STARTED running — used for the roster's "run for X" badge (how long this
   *  task has been going). The transcript's birth time is the truest signal (when Claude first
   *  wrote to this conversation); fall back to the file's ctime, then the row's created_at. */
  private startedAtOf(s: SessionRow): string {
    const tPath = s.transcript_path;
    if (tPath) {
      try {
        const st = require("fs").statSync(tPath);
        const ms = st.birthtimeMs || st.ctimeMs || 0;
        if (ms > 0) return new Date(ms).toISOString();
      } catch {}
    }
    const fb = s.created_at || s.updated_at || "";
    const ms = fb ? Date.parse(fb.includes("T") ? fb : fb.replace(" ", "T") + "Z") || 0 : 0;
    return new Date(ms).toISOString();
  }

  /** Cached PR for a session (or the pr_number marker fallback if a /pr-style run tagged it). No
   *  gh call — safe for state(). */
  sessionPr(s: any): any | null {
    if (!s) return null;
    const c = this._prCache.get(this._prKey(s));
    // A NON-null cached PR (gh found it for this branch) wins. But a cached NULL must NOT hide PR
    // fields explicitly attached to the row (e.g. from the @claude_pr window option) — a /work
    // session's branch is cockpit/<name> so prForBranch caches null, yet pr_number IS set. Prefer
    // the stored fields over a stale null; fall back to the cached null only when none are stored.
    if (c && c.pr) return c.pr;
    if (s.pr_number && s.pr_repo) {
      return { number: s.pr_number, url: s.pr_url || "", title: s.title || `PR #${s.pr_number}`, state: "OPEN", mergeable: "", draft: !!s.pr_draft, base: s.pr_base_ref || "", reviewDecision: s.pr_review_decision || "" };
    }
    return c ? c.pr : null;
  }

  /** FIX X: refresh (run gh) the PR for one session, cache it (60s). Returns the PR or null. */
  async refreshSessionPr(sessionId: number): Promise<any | null> {
    if (this.demo) return null;
    const s = this.getSession(sessionId) as any;
    if (!s || s.kind === "pr" || s.kind === "kanban" || s.kind === "shell" || !s.worktree_path || !s.branch) return null;
    const key = this._prKey(s);
    const cached = this._prCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.pr;
    let pr: any | null = null;
    try { const { prForBranch } = require("./pr"); pr = await prForBranch(s.worktree_path, s.branch); } catch {}
    if (!pr && s.pr_number) pr = this.sessionPr(s); // fall back to a /pr marker if gh found nothing
    this._prCache.set(key, { at: Date.now(), pr });
    return pr;
  }

  /** FIX X: background sweep — refresh PRs for up to `max` sessions with stale caches (non-blocking,
   *  bounded so the tick never stalls). Called opportunistically from the server tick loop. */
  async refreshSessionPrs(max = 6): Promise<void> {
    if (this.demo) return;
    const rows = this.sessions.list().filter((s: any) => s.kind === "claude" && s.worktree_path && s.branch);
    let done = 0;
    for (const s of rows) {
      const c = this._prCache.get(this._prKey(s));
      if (c && Date.now() - c.at < 60_000) continue;
      await this.refreshSessionPr(s.id);
      if (++done >= max) break;
    }
  }

  /** FIX X: MERGE the selected session's PR (gh pr merge --<strategy>). Outward-facing — the UI
   *  confirms first. Returns the gh result + the exact command. */
  async mergeSessionPr(sessionId: number, deleteBranch = false): Promise<{ ok: boolean; output?: string; error?: string; cmd?: string }> {
    if (this.demo) return { ok: false, error: "demo — no real merge" };
    const s = this.getSession(sessionId) as any;
    if (!s) return { ok: false, error: "no session" };
    // PR-CONV: pr-card rows have a SYNTHETIC worktree_path ("pr:owner/repo#N", not a directory) —
    // the cwd-based merge below would always spawn-fail. Route them through the -R repo merge.
    if (s.kind === "pr") return this.prMerge(sessionId, this.cfg.pr_merge_strategy || "squash", deleteBranch);
    const pr = this.sessionPr(s) || (await this.refreshSessionPr(sessionId));
    if (!pr || !pr.number) return { ok: false, error: "no open PR for this session" };
    const { mergePrByNumber } = require("./pr");
    // MERGE-DEL: delete the merged PR's OWN head (pr.head from gh, else the scan tag) — never
    // trust s.branch blindly: materialized PR terminals sit on a DETACHED checkout whose branch
    // reads the literal "HEAD", and a stale tag could make s.branch a different branch than the
    // PR being merged.
    const delBranch = (pr as any).head || s.pr_head_ref || (s.branch && s.branch !== "HEAD" ? s.branch : null);
    const r = await mergePrByNumber(s.worktree_path, pr.number, this.cfg.pr_merge_strategy || "squash", deleteBranch, delBranch);
    // MERGE-RECONCILE: reflect the merge locally NOW so the card stops re-surfacing with a live
    // merge button (the post-merge tick usually skips scanPrs — see reconcileMergedPr).
    if (r.ok) this.reconcileMergedLocally(sessionId);
    return r;
  }

  /** MERGE-RECONCILE: after a SUCCESSFUL real merge, untag a PR-tagged claude session / delete a
   *  kind='pr' card immediately (what scanPrs would do, but without waiting out its throttle), and
   *  record undo for the reversible (untag) case. Best-effort: scanPrs is the backstop. */
  private reconcileMergedLocally(sessionId: number): void {
    try {
      const { reconcileMergedPr } = require("./db");
      const res = reconcileMergedPr(this.db, sessionId);
      if (res.action === "untagged" && res.prev) {
        const s = this.getSession(sessionId) as any;
        pushUndo(this.db, "mergePr", `merged ${s && s.repo ? s.repo + "#" : "PR #"}${res.prev.pr_number ?? ""}`, [
          { t: "setSession", id: sessionId, fields: res.prev },
        ]);
      }
    } catch {
      /* best-effort — the throttled scanPrs reconciliation is the backstop */
    }
  }

  /** FIX L: mark the session whose terminal the operator just opened as the ACTIVE task — it
   *  jumps to the top of the queue (and the UI selects it). Opening a terminal = "working on
   *  this now". */
  activateSession(sessionId: number): { ok: boolean } {
    this.engine.setActiveSession(sessionId);
    return { ok: true };
  }

  /** FIX BB: REASONED priority feedback — the operator says, for the item AS RANKED NOW, "I did
   *  NOT want it here, because <reason>" (direction down = too high, up = too low). Captures a
   *  STRONG training example (feature snapshot + priority + rank + breakdown + the reason text,
   *  source='explicit_reason', high weight) so the nightly tuner nudges harder than implicit
   *  signals, and the reason feeds RANKING.md. */
  reasonFeedback(itemId: number, direction: "down" | "up", reason: string): { ok: boolean; exampleId?: number; delta?: number } {
    const q = this.engine.queue();
    const idx = q.findIndex((x) => x.id === itemId);
    if (idx < 0) return { ok: false };
    const item = q[idx];
    // FIX BB (revised): IMMEDIATE effect is a PER-ITEM priority offset on THIS session only —
    // up = +STEP (rank higher), down = −STEP (rank lower). Nothing else reshuffles. The generalizing
    // weight-vector learning is recorded below and applied ONLY by the nightly dream.
    const STEP = 30;
    const signed = direction === "up" ? STEP : -STEP;
    const prevDelta = (this.getSession(item.session_id) as any)?.manual_priority_delta || 0;
    const newDelta = Math.max(-300, Math.min(300, prevDelta + signed));
    this.db.prepare("UPDATE sessions SET manual_priority_delta=?, updated_at=datetime('now') WHERE id=?").run(newDelta, item.session_id);
    pushUndo(this.db, "reasonFeedback", `${direction === "up" ? "raised" : "lowered"} “${(item.session && item.session.title) || "task"}” (${newDelta >= 0 ? "+" : ""}${newDelta})`, [
      { t: "setSession", id: item.session_id, fields: { manual_priority_delta: prevDelta } },
    ]);
    const snapshot = {
      direction,
      session_id: item.session_id,
      item_id: item.id,
      category: item.category,
      features: this.featuresOf(item, idx),
      priority: item.priority,
      rank: idx,
      breakdown: item.score_breakdown,
    };
    const { recordReasonExample } = require("./db");
    // A typed REASON ("I don't want this because X") teaches the nightly tuner FAR harder than a
    // bare up/down nudge — and both teach harder than a SILENT pick (see implicit_learn_weight in
    // dream.ts). Configurable via reason_learn_weight / direction_learn_weight.
    let reasonW = 15, dirW = 5;
    try { const c = require("./config").loadConfig(); reasonW = c.reason_learn_weight ?? 15; dirW = c.direction_learn_weight ?? 5; } catch {}
    const id = recordReasonExample(this.db, {
      state: snapshot,
      predicted: { rank: idx, priority: item.priority },
      correct: { direction },
      reason: (reason || "").slice(0, 400),
      weight: reason && reason.trim() ? reasonW : dirW,
    });
    return { ok: true, exampleId: id, delta: newDelta };
  }

  /** RE-SURFACE ALL: one-time repopulate of Up Next. For every NON-completed session currently in
   *  a READY state (WAITING_INPUT / DONE) whose latest item is stuck 'decided' from a DISMISS
   *  (decision='done'), flip it back to 'pending' (clear decision + dismissed_at) so the actionable
   *  session returns to the queue. Leaves ANSWERED items (decision='sent'/'ack') and completed
   *  (Ctrl+G e) sessions alone — those were intentionally resolved. Returns how many re-surfaced.
   *  Callers should run a fresh tick (state detection) BEFORE this so readiness is current. */
  resurfaceAll(): { ok: boolean; reopened: number } {
    const sessions = this.db
      .prepare("SELECT id FROM sessions WHERE completed_at IS NULL AND state IN ('WAITING_INPUT','DONE')")
      .all() as { id: number }[];
    let reopened = 0;
    for (const s of sessions) {
      // 2026-06-29: widened from `status='decided' AND decision='done'` to any non-pending item.
      // The idle-reaper marks items as superseded (not decision='done'), and after we cleared
      // completed_at on auto-reaped sessions the older filter missed them, so the queue stayed
      // empty even though the session was live + ready. Wider match brings every live ready
      // session back as a card.
      const it = this.db
        .prepare("SELECT id FROM items WHERE session_id=? AND status!='pending' ORDER BY updated_at DESC, id DESC LIMIT 1")
        .get(s.id) as { id: number } | undefined;
      if (!it) continue;
      this.db
        .prepare("UPDATE items SET status='pending', decision=NULL, dismissed_at=NULL, updated_at=datetime('now') WHERE id=?")
        .run(it.id);
      reopened++;
    }
    // The flipped rows still carry the priority cached when they were dismissed — possibly under
    // flags that have since changed (e.g. dismissed while pinned, unpinned meanwhile → a stuck
    // ~100k score). Re-score everything pending before the queue shows them.
    if (reopened) this.engine.rerank();
    return { ok: true, reopened };
  }

  /** FIX J: COMPLETE & ARCHIVE a session — durably stop queueing/surfacing it (survives
   *  re-discovery) AND move its kanban card to 8_done. Fully undoable (restores the archive flag
   *  AND moves the card back). */
  completeTask(sessionId: number): { ok: boolean; kanbanMoved: boolean; message: string } {
    const s = this.getSession(sessionId) as any;
    if (!s) return { ok: false, kanbanMoved: false, message: "no session" };
    const { setCompleted } = require("./db");
    const { moveCardFile, findCardByTitle } = require("./kanban");
    const path = require("path");
    const undoOps: UndoOp[] = [];

    // 1) durable archive + drop any pending item from the queue NOW (restorable on undo).
    if (this.engine.activeSessionId() === sessionId) this.engine.setActiveSession(null); // FIX L: drop active boost
    const prevCompleted = s.completed_at ?? null;
    const pendingItems = this.db.prepare("SELECT id FROM items WHERE session_id=? AND status='pending'").all(sessionId) as { id: number }[];
    setCompleted(this.db, sessionId, new Date().toISOString());
    this.db.prepare("UPDATE items SET status='superseded' WHERE session_id=? AND status='pending'").run(sessionId);
    // completed_by restored in lockstep (undo bypasses setCompleted) — else a re-completed
    // auto-reaped session would undo into completed_at='auto stamp' + completed_by='operator'.
    undoOps.push({ t: "setSession", id: sessionId, fields: { completed_at: prevCompleted, completed_by: prevCompleted == null ? null : (s.completed_by ?? null) } });
    for (const it of pendingItems) undoOps.push({ t: "setItem", id: it.id, fields: { status: "pending" } });

    // 2) kanban move → 8_done (linked card, else best-effort title match).
    // DEMO GUARD: never touch the real kanban board in demo. A demo session's kanban_file is a
    // fake /demo/... path, but a demo session with NO linked card would otherwise fall through to
    // findCardByTitle() against the REAL board and could move a real card whose title happens to
    // match a demo title. In demo we skip the filesystem entirely (the db archive above still runs).
    let kanbanMoved = false;
    if (!this.demo) {
      const doneDir = path.join(this.cfg.kanban_path, "8_done");
      let cardPath: string | null = s.kanban_file || null;
      let prevColumn: string | null = s.kanban_column || null;
      let prevDir: string | null = cardPath ? path.dirname(cardPath) : null;
      if (!cardPath) {
        const hit = findCardByTitle(this.cfg.kanban_path, s.clean_title || s.title || "");
        if (hit) { cardPath = hit.fullPath; prevColumn = hit.column; prevDir = path.dirname(hit.fullPath); }
      }
      if (cardPath) {
        const newPath = moveCardFile(cardPath, doneDir);
        if (newPath) {
          kanbanMoved = true;
          this.db.prepare("UPDATE sessions SET kanban_file=?, kanban_column='8_done' WHERE id=?").run(newPath, sessionId);
          undoOps.push({ t: "setSession", id: sessionId, fields: { kanban_file: cardPath, kanban_column: prevColumn } });
          if (prevDir) undoOps.push({ t: "moveFile", from: newPath, toDir: prevDir }); // undo: move card back
        }
      }
    }

    pushUndo(this.db, "complete", `completed “${(s as any).manual_title || s.clean_title || s.title || "session"}”${kanbanMoved ? " (kanban → done)" : ""}`, undoOps);
    return { ok: true, kanbanMoved, message: kanbanMoved ? "completed; kanban card → 8_done" : "completed (no kanban card linked)" };
  }

  /** NIGHTLY REAP — kill the orphan tmux for sessions COMPLETED (Ctrl+G e) more than `hours`
   *  ago, so dozens of done tasks don't leave dozens of idle terminals / Claude processes
   *  running forever. SAFETY: the filter is `completed_at IS NOT NULL`, and `completed_at`
   *  is set ONLY by completeTask (Ctrl+G e) — never by dismiss (Ctrl+G Enter), snooze, or any
   *  active session — so a task you might still want is never reaped. The db row AND the git
   *  worktree are LEFT INTACT; only the tmux is killed (undo still restores the card — the
   *  terminal is just gone, which is expected past the `hours` window). Idempotent: killTmuxOnly
   *  is a no-op once a session is already closed. `candidates` is the count matched by the time
   *  filter; `reaped` is how many were actually live and killed. */
  reapCompletedTmux(hours = 5): { candidates: number; reaped: number } {
    if (!(hours > 0)) return { candidates: 0, reaped: 0 }; // 0/negative disables the reaper
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE completed_at IS NOT NULL AND completed_at < ?")
      .all(cutoff) as unknown as SessionRow[];
    let reaped = 0;
    for (const s of rows) {
      try { if (this.sessions.killTmuxOnly(s)) reaped++; } catch {}
    }
    if (reaped > 0) {
      try {
        this.db
          .prepare("INSERT INTO dream_log (summary) VALUES (?)")
          .run(`reaped ${reaped} orphan tmux session(s) completed >${hours}h ago`);
      } catch {}
    }
    return { candidates: rows.length, reaped };
  }

  /** NIGHTLY AUTO-COMPLETE — archive sessions that are clearly over but that nobody ever
   *  Ctrl+G e's: teammate workers, one-shot background jobs (cron runs), abandoned "new
   *  session" rows. The ONLY other exit from the sessions panel is a manual Ctrl+G e, so
   *  these otherwise sit there forever. A session counts as over when it has shown no sign
   *  of life for `hours`: its transcript (its only output channel) untouched — which also
   *  covers dead sessions, since a dead session stops writing. Mirrors completeTask's
   *  archive semantics (completed_at + supersede pending items) and reaps BOTH its terminals,
   *  but deliberately does NOT move any kanban card: an idle-dead session does not mean its
   *  task is DONE — the card must stay pickable for a fresh session. Never touches: pinned
   *  sessions, the session the operator is viewing, shell terminals (no transcript — age
   *  says nothing), or a session with a still-future ETA (it told us when it'll be back). */
  autoCompleteIdleSessions(hours = 20, teammateHours = 0): { completed: number } {
    if (!(hours > 0) && !(teammateHours > 0)) return { completed: 0 }; // both disabled
    const { setCompleted } = require("./db");
    const fs = require("fs");
    const nowMs = Date.now();
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE completed_at IS NULL AND kind='claude' AND COALESCE(pinned,0)=0")
      .all() as unknown as SessionRow[];
    let completed = 0;
    for (const s of rows) {
      if (this.engine.activeSessionId() === s.id) continue;
      const etaMs = (s as any).eta_at ? Date.parse((s as any).eta_at) : NaN;
      if (Number.isFinite(etaMs) && etaMs > nowMs) continue;
      // TEAMMATES are machinery (review-fleet/worker sub-agents) — they finish fast and then linger,
      // bloating every engine tick (which scales with session count → slow terminal opens). Reap
      // them on a much shorter idle window than the operator's own sessions. 0 = use `hours`.
      const thr = ((s as any).is_teammate && teammateHours > 0) ? teammateHours : hours;
      if (!(thr > 0)) continue;
      // last sign of life: transcript mtime when visible, else created_at.
      let lastMs = NaN;
      const tp = (s as any).transcript_path;
      try { if (tp && fs.existsSync(tp)) lastMs = fs.statSync(tp).mtimeMs; } catch {}
      if (!Number.isFinite(lastMs)) {
        const created = String(s.created_at || "").replace(" ", "T");
        lastMs = Date.parse(created.endsWith("Z") ? created : created + "Z");
      }
      if (!Number.isFinite(lastMs) || nowMs - lastMs < thr * 3600 * 1000) continue;
      this.db.prepare("UPDATE items SET status='superseded' WHERE session_id=? AND status='pending'").run(s.id);
      setCompleted(this.db, s.id, new Date(nowMs).toISOString(), "auto"); // idle-reap ≠ a real completion (throughput excludes 'auto')
      try { this.sessions.killTmuxOnly(s); } catch {}
      completed++;
    }
    if (completed > 0) {
      try {
        this.db
          .prepare("INSERT INTO dream_log (summary) VALUES (?)")
          .run(`auto-completed ${completed} session(s) silent >${hours}h (archived + terminals reaped)`);
      } catch {}
    }
    return { completed };
  }

  /** Snooze = apply a SCORE PENALTY (config.snooze_penalty, default -100) so the item sinks
   *  ~|penalty| below its natural score but STAYS VISIBLE — then DECAYS LINEARLY back to 0 over
   *  config.snooze_recover_hours (default 5h), so the item slowly climbs back up the queue and is
   *  at its natural rank again once recovered (the engine's snoozeDecayTick pushes the decay into
   *  the cached priorities). Re-snoozing stacks from the CURRENT decayed value (capped at 3x) and
   *  restarts the decay clock. The `minutes` arg is ignored (kept for API compatibility). */
  snooze(itemId: number, _minutes = 60): void {
    const it = this.getItem(itemId);
    if (!it) return;
    // Training example: snoozing a HIGH-ranked item reveals it was over-ranked.
    try {
      const q = this.engine.queue();
      const idx = q.findIndex((x) => x.id === itemId);
      if (idx >= 0 && idx <= 2) {
        recordExample(this.db, "snooze_high", { item: this.featuresOf(q[idx], idx), queue: q.slice(0, 5).map((x, i) => this.featuresOf(x, i)) }, { rank: idx }, { shouldRankLower: true });
      }
    } catch {}
    const session = this.getSession(it.session_id);
    const prevPenalty = session?.snooze_penalty || 0;
    const prevSnoozedAt = session?.snoozed_at ?? null;
    const prevPinned = session?.pinned || 0;
    // Pin ("always top") and snooze ("not now") are contradictory — snoozing a pinned
    // item AUTO-UNPINS it first so the penalty can actually drop it below PIN_BASE.
    if (prevPinned) setPinned(this.db, it.session_id, false);
    const step = this.cfg.snooze_penalty ?? -100;
    const cap = step * 3; // e.g. -300
    const recoverH = this.cfg.snooze_recover_hours ?? 5;
    // Stack from the EFFECTIVE (decayed) value, not the stale stored one — re-snoozing an item
    // that has half-recovered sinks it by a full step from where it actually is now.
    const effNow = effectiveSnoozePenalty(prevPenalty, prevSnoozedAt, recoverH, Date.now());
    const next = Math.max(cap, Math.round(effNow) + step);
    setSnoozePenalty(this.db, it.session_id, next, new Date().toISOString()); // restart the decay clock
    const dlId = nextDecisionLogId(this.db);
    // Snoozing is a signal the item was over-ranked; the nightly dream learns from it.
    this.db
      .prepare("INSERT INTO decision_log (item_id, session_id, category, state, feedback) VALUES (?,?,?,?, 'snoozed')")
      .run(itemId, it.session_id, it.category ?? null, it.state);
    pushUndo(this.db, "snooze", prevPinned ? `unpinned + snoozed “${session?.title || "item"}” (${next})` : `snoozed “${session?.title || "item"}” (${next})`, [
      { t: "setSession", id: it.session_id, fields: { snooze_penalty: prevPenalty, snoozed_at: prevSnoozedAt, pinned: prevPinned } },
      { t: "delDecisionLog", id: dlId },
    ]);
    // Auto-unpin + penalty must land in the cached priorities even when the caller (Electron
    // IPC) doesn't follow up with a rerank of its own.
    this.engine.rerank();
  }

  /** MANUAL STATE OVERRIDE — the operator right-clicked a card to correct its status
   *  (WAITING_INPUT | WORKING | DONE, or null to clear and let the detector decide again). The
   *  engine applies it with final authority (see engine.applyManualOverride). Every correction is
   *  logged to decision_log — feedback='manual_state', `state`=what the auto-detector last said,
   *  `decision`=what the operator changed it to — so the nightly learning pass can see exactly where
   *  the detector was wrong. Undoable. */
  overrideState(sessionId: number, state: SessionState | null): { ok: boolean } {
    const s = this.getSession(sessionId);
    if (!s) return { ok: false };
    const prev = s.manual_state ?? null;
    const prevBase = s.manual_state_base ?? null;
    const prevState = s.state;
    // base = what the detector currently says (s.state); the engine drops the override once the auto
    // detection moves off this, so a silenced session can't strand a later genuine question.
    setManualStateOverride(this.db, sessionId, state, s.state);
    const undoOps: UndoOp[] = [
      { t: "setSession", id: sessionId, fields: { manual_state: prev, manual_state_base: prevBase, state: prevState } },
    ];
    if (state) {
      // Reflect the corrected status on the row NOW (the engine then holds it there until the
      // detector moves off the base). Forcing a non-actionable state (WORKING/idle) also drops the
      // card from Up Next immediately — an explicit operator action, the only thing allowed to pull a
      // pending item (mirrors dismiss/complete; the tick itself never does this — see the LOCK guard).
      setSessionState(this.db, sessionId, state);
      if (state === "WORKING" || state === "UNKNOWN") {
        for (const r of this.db.prepare("SELECT id FROM items WHERE session_id=? AND status='pending'").all(sessionId) as Array<{ id: number }>) {
          this.db.prepare("UPDATE items SET status='superseded' WHERE id=?").run(r.id);
          undoOps.push({ t: "setItem", id: r.id, fields: { status: "pending" } });
        }
      }
      const dlId = nextDecisionLogId(this.db);
      this.db
        .prepare("INSERT INTO decision_log (item_id, session_id, category, state, feedback, decision) VALUES (?,?,?,?,?,?)")
        .run(null, sessionId, null, prevState, "manual_state", state);
      undoOps.push({ t: "delDecisionLog", id: dlId });
    }
    const name = (s as any).manual_title || s.clean_title || s.title || "session";
    pushUndo(this.db, "overrideState", state ? `status → ${state.replace("_", " ").toLowerCase()} “${name}”` : `cleared manual status on “${name}”`, undoOps);
    this.engine.rerank();
    return { ok: true };
  }

  /** One-keystroke feedback verbs. */
  feedback(itemId: number, fb: Feedback): void {
    const it = this.getItem(itemId);
    if (!it) return;
    // Training example: 'wrong' means the triage category was mis-predicted.
    if (fb === "wrong") {
      try {
        recordExample(this.db, "triage_wrong", { itemId, category: it.category, changedLines: it.changed_lines, question: (it.question || "").slice(0, 400) }, { category: it.category }, { category: "needs-info" });
      } catch {}
    }
    const dlId = nextDecisionLogId(this.db);
    applyFeedback(this.db, {
      itemId,
      sessionId: it.session_id,
      category: it.category,
      state: it.state,
      feedback: fb,
    });
    pushUndo(this.db, "feedback", `feedback “${fb}”`, [
      { t: "delDecisionLog", id: dlId },
      ...reverseFeedbackOps(it.category, fb),
    ]);
  }

  /** Revert the most recent reversible action. */
  undo(): { ok: boolean; label: string } {
    const r = undoStack(this.db);
    // Undo can restore pinned/importance/snooze flags or flip items back to 'pending' with a
    // priority cached under OLD flags; the tick won't fix those (Stage-0 lock). Re-score now.
    if (r) this.engine.rerank();
    return r ? { ok: true, label: r.label } : { ok: false, label: "" };
  }

  rawTranscript(itemId: number): string {
    const it = this.getItem(itemId);
    if (!it) return "";
    const s = this.getSession(it.session_id);
    if (!s) return "";
    const tPath = this.sessions.transcriptFor(s);
    if (!tPath) return "(no transcript found)";
    const fs = require("fs");
    return fs.existsSync(tPath) ? fs.readFileSync(tPath, "utf8") : "(transcript missing)";
  }

  /** Human-readable conversation view (not raw JSONL). */
  prettyTranscript(itemId: number): string {
    const it = this.getItem(itemId);
    if (!it) return "";
    const s = this.getSession(it.session_id);
    if (!s) return "";
    const tPath = this.sessions.transcriptFor(s);
    if (!tPath) return "(no transcript found)";
    const fs = require("fs");
    if (!fs.existsSync(tPath)) return "(transcript missing)";
    const { parseTranscript, renderConversation } = require("./transcript");
    try {
      return renderConversation(parseTranscript(tPath));
    } catch {
      return "(could not render transcript)";
    }
  }

  /** The SOUL-voiced gist (chat highlights) for a session — cached on transcript mtime; ?force
   *  regenerates. Reads only the transcript TAIL (never the whole 20MB file). Used by /api/gist
   *  for an on-demand refresh (e.g. a WORKING session the tick hasn't enriched). */
  async gistForSession(sessionId: number, force = false): Promise<{ beats: { kind: string; text: string }[] }> {
    if ((this.cfg as any).chat?.enabled === false) return { beats: [] };
    const s = this.getSession(sessionId);
    if (!s) return { beats: [] };
    const tPath = this.sessions.transcriptFor(s);
    const fs = require("fs");
    let mtimeMs = 0;
    let conversation = "";
    if (tPath && fs.existsSync(tPath)) {
      try {
        mtimeMs = fs.statSync(tPath).mtimeMs;
        const { parseTranscriptTail } = require("./transcript");
        const view = await parseTranscriptTail(tPath, mtimeMs);
        conversation = view?.raw || "";
      } catch {}
    }
    // Pull the latest pending item for the question / last_prompt / category, if any.
    const it = this.db
      .prepare("SELECT * FROM items WHERE session_id=? AND status='pending' ORDER BY id DESC LIMIT 1")
      .get(sessionId) as any;
    const chat = (this.cfg as any).chat || {};
    const { refreshGist } = require("./gist");
    const input = {
      sessionId,
      title: (s as any).manual_title || (s as any).clean_title || s.title,
      state: ((s as any).manual_state || s.state || "UNKNOWN"),
      category: it?.category ?? null,
      question: it?.question ?? "",
      conversation,
      lastPrompt: it?.last_prompt ?? "",
      model: chat.gist_model || this.cfg.models.triage,
      maxBeats: chat.gist_max_beats || 6,
    };
    // In the demo sandbox, never spawn a real `claude` (would add seconds/flakiness) — a null gen
    // makes generateGist fall back deterministically. The real instance uses the model.
    const opts: any = { db: this.db, force };
    if (this.demo) opts.gen = async () => null;
    return await refreshGist(input, String(mtimeMs), opts);
  }

  /** PER-TASK chat input → writes the operator's message straight into the session's terminal (the
   *  live claude session), exactly as if he'd typed it in the pty. This is a CONVERSATION with the
   *  session, so it does NOT resolve/advance the queue item — the session goes WORKING then comes
   *  back with its next turn (a fresh gist). If there's a pending question, the message answers it
   *  in-session (and we still log the answer-quality signal for learning, without advancing). */
  sessionSay(sessionId: number, text: string): { ok: boolean; live: boolean } {
    const s = this.getSession(sessionId);
    if (!s || !text || !text.trim()) return { ok: false, live: false };
    const live = this.sessions.sendInput(s, text);
    // Log the exchange to chat_log so the operator's chat history persists across reloads.
    try { require("./db").logChat(this.db, { scope: "task", role: "user", sessionId, content: text }); } catch {}
    // If a pending question existed, record the answer-quality signal (learning) but keep the card.
    try {
      const it = this.db.prepare("SELECT * FROM items WHERE session_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(sessionId) as any;
      if (it) {
        const { recordAnswer } = require("./answerLog");
        let options: string[] = []; try { options = JSON.parse(it.answer_options || "[]") || []; } catch {}
        recordAnswer(this.db, { itemId: it.id, sessionId, category: it.category, state: it.state, question: it.question || "", suggested: it.suggested_answer || "", options, final: text });
      }
    } catch {}
    return { ok: live, live };
  }

  /** GLOBAL cockpit chat (Stage 3): the operator talks TO ClaudeOS, which narrates in his SOUL voice
   *  and can drive the queue (answer / dismiss / complete / focus) via the existing actions. Every
   *  turn is logged to chat_log (scope 'global'). Best-effort; never throws to the caller. */
  async cockpitChat(message: string, history: { role: "user" | "assistant"; content: string }[] = []): Promise<{ ok: boolean; say: string; action: any; did: string | null }> {
    const { queueSummary, buildAssistantPrompt, parseAssistantReply } = require("./assistant");
    const { logChat } = require("./db");
    let persona = "";
    try { persona = require("./soul").personaBlock() || ""; } catch {}
    // Compact queue summary from the live ranked queue.
    const queue = this.engine.queue().filter((q: any) => !q._team);
    const lines = queue.slice(0, 12).map((q: any) => ({
      sessionId: q.session_id,
      title: (q.session && (q.session.manual_title || q.session.clean_title || q.session.title)) || "session",
      category: q.category, state: q.state, one_liner: q.one_liner,
    }));
    const prompt = buildAssistantPrompt(persona, queueSummary(lines), message, history);
    logChat(this.db, { scope: "global", role: "user", content: message });

    const model = this.demo ? "" : this.cfg.models.triage;
    let raw: string | null = null;
    if (this.demo) {
      // Demo: no real model — deterministic honest reply (keeps the sandbox + tests fast/offline).
      raw = JSON.stringify({ say: lines.length ? `${lines.length} waiting — top is "${lines[0].title}".` : "Nothing needs you right now.", action: { type: "none" } });
    } else {
      try { raw = await require("./claude").claudePrompt(prompt, { model, timeoutMs: 60000, label: "assistant" }); } catch { raw = null; }
    }
    const reply = parseAssistantReply(raw);

    // Execute at most one action, grounded in the current queue (never act on an unknown session).
    let did: string | null = null;
    try {
      const a = reply.action || { type: "none" };
      const known = (sid: any) => lines.some((l: any) => l.sessionId === sid);
      if (a.type === "focus" && a.value) { this.setFocus(String(a.value)); did = `focus set to "${a.value}"`; }
      else if (a.type === "complete" && known(a.sessionId)) { this.completeTask(a.sessionId); did = `completed session ${a.sessionId}`; }
      else if ((a.type === "answer" || a.type === "dismiss") && known(a.sessionId)) {
        const it = this.db.prepare("SELECT id FROM items WHERE session_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(a.sessionId) as { id: number } | undefined;
        if (it) {
          if (a.type === "answer" && a.text) { await this.sendAnswer(it.id, String(a.text)); did = `answered session ${a.sessionId}`; }
          else if (a.type === "dismiss") { this.dismiss(it.id); did = `dismissed session ${a.sessionId}`; }
        }
      }
    } catch { /* an action failure must not break the reply */ }

    logChat(this.db, { scope: "global", role: "assistant", content: reply.say, prompt, model });
    return { ok: true, say: reply.say, action: reply.action, did };
  }

  attachCommand(sessionId: number): string {
    const s = this.getSession(sessionId);
    return s ? this.sessions.attachCommand(s) : "";
  }

  /** Live tmux pane snapshot for the session's real Claude Code terminal. */
  pane(sessionId: number, lines = 200): { ok: boolean; live: boolean; target: string | null; content: string; cols: number; rows: number } {
    const s = this.getSession(sessionId);
    if (!s) return { ok: false, live: false, target: null, content: "", cols: 0, rows: 0 };
    const target = this.sessions.resolvePaneTarget(s);
    if (!target) return { ok: true, live: false, target: null, content: "", cols: 0, rows: 0 };
    const content = this.sessions.capturePane(s, lines);
    const size = this.sessions.paneSize(s) || { cols: 96, rows: 30 };
    return { ok: true, live: content != null, target, content: content ?? "", cols: size.cols, rows: size.rows };
  }

  // Cache of parsed cockpit review runs per PR (for the stats aggregate). Keyed by repo#number,
  // NOT sessionId — a PR's ownership can move between a pr-card and a tagged claude session, and
  // session-keyed entries would then double-count the same PR's runs in the stats.
  private _reviewCache = new Map<string, any[]>();
  private _reviewKey(s: any, sessionId: number): string {
    return s && s.pr_repo && s.pr_number ? `${s.pr_repo}#${s.pr_number}` : `sid:${sessionId}`;
  }

  /** Pull the cockpit-tagged /pr and /prteam review runs for a PR, resolve each run's
   *  session=<branch> to a tracked cockpit session (for the attach action), and return
   *  the cross-PR stats. */
  async prReviews(sessionId: number): Promise<{ ok: boolean; runs: any[]; stats: any; error?: string }> {
    const s = this.getSession(sessionId);
    if (!s) return { ok: false, runs: [], stats: this.reviewStats(), error: "no session" };
    let runs: any[] = [];
    if (this.demo) {
      runs = DEMO_REVIEW_RUNS();
    } else if (s.pr_repo && s.pr_number) {
      // any session TAGGED with a PR (pr-card OR a claude session on the PR's branch) has runs —
      // the old kind==='pr' gate silently returned [] for tagged claude sessions.
      const { prReviewRuns } = require("./pr");
      const r = await prReviewRuns(s);
      runs = r.ok ? r.runs : [];
      if (!r.ok) { this._reviewCache.set(this._reviewKey(s, sessionId), []); return { ok: false, runs: [], stats: this.reviewStats(), error: r.error }; }
    }
    this._reviewCache.set(this._reviewKey(s, sessionId), runs);
    const withAttach = runs.map((run) => {
      const sid = this.findSessionIdByBranch(run.session);
      return { ...run, attachSessionId: sid, attachable: sid != null };
    });
    return { ok: true, runs: withAttach, stats: this.reviewStats() };
  }

  private reviewStats() {
    const { reviewStats } = require("./pr_comments");
    return reviewStats([...this._reviewCache.values()]);
  }

  // PR-CONV: the full "GitHub PR page" pull (meta + review runs + conversation timeline) for the
  // diff view's redesigned header + Conversation tab. Two gh calls (~1-2s) → cached 45s per
  // session (failures 15s — a flaky gh must not re-spawn two 30s subprocesses per render), with
  // in-flight dedup so the main + detached windows opening the same task share one pull.
  private _convCache = new Map<number, { at: number; ttl: number; val: any }>();
  private _convInflight = new Map<number, Promise<any>>();

  async prConversation(sessionId: number, force = false): Promise<any> {
    const s = this.getSession(sessionId) as any;
    if (!s) return { ok: false, error: "no session" };
    if (this.demo) {
      // only the demo's actual PR rows get the canned conversation — a plain demo claude
      // session must not render a bogus "PR #512" header
      if (!s.pr_number && s.kind !== "pr") return { ok: false, error: "no open PR for this session" };
      const val = DEMO_PR_CONVERSATION();
      val.reviews = this.attachReviewRuns(val.reviews);
      return val;
    }
    const cached = this._convCache.get(sessionId);
    if (!force && cached && Date.now() - cached.at < cached.ttl) return cached.val;
    const inflight = this._convInflight.get(sessionId);
    if (inflight) return inflight;
    const p = this._fetchConversation(s, sessionId).finally(() => this._convInflight.delete(sessionId));
    this._convInflight.set(sessionId, p);
    return p;
  }

  private async _fetchConversation(s: any, sessionId: number): Promise<any> {
    // resolve the PR number: scan tag first (cheap), else the lazy gh detection (60s-cached)
    const repo: string | null = s.pr_repo || null;
    let number: number | null = s.pr_number || null;
    if (!number) {
      const pr = this.sessionPr(s) || (await this.refreshSessionPr(sessionId));
      if (pr && pr.number) number = pr.number;
    }
    if (!number) return { ok: false, error: "no open PR for this session" };
    const { fetchPrConversation } = require("./pr");
    const val = await fetchPrConversation({ repo, cwd: s.worktree_path || s.pr_local_repo || undefined, number });
    if (val && val.ok) {
      val.reviews = this.attachReviewRuns(val.reviews || []);
      // feed the header stats — but ONLY under the canonical repo#number key. A sid: fallback
      // entry would linger after scanPrs tags the session and double-count the PR until restart.
      if (repo) this._reviewCache.set(`${repo}#${number}`, val.reviews);
    }
    this._convCache.set(sessionId, { at: Date.now(), ttl: val && val.ok ? 45_000 : 15_000, val });
    return val;
  }

  /** Decorate review runs with the attach action (resolve session=<branch> → cockpit session). */
  private attachReviewRuns(runs: any[]): any[] {
    return (runs || []).map((run) => {
      const sid = this.findSessionIdByBranch(run.session);
      return { ...run, attachSessionId: sid, attachable: sid != null };
    });
  }

  private findSessionIdByBranch(branch: string): number | null {
    if (!branch) return null;
    const row = this.db.prepare("SELECT id FROM sessions WHERE branch=? ORDER BY id DESC LIMIT 1").get(branch) as { id: number } | undefined;
    return row ? row.id : null;
  }

  /** Per-file "Viewed" state for a session's diff (GitHub-style collapse), persisted. */
  diffViewed(sessionId: number): Record<string, boolean> {
    const { getDiffViewed } = require("./db");
    return getDiffViewed(this.db, sessionId);
  }
  setDiffViewed(sessionId: number, filePath: string, viewed: boolean): { ok: boolean } {
    const { setDiffViewed } = require("./db");
    setDiffViewed(this.db, sessionId, String(filePath || ""), !!viewed);
    return { ok: true };
  }

  /** Branch-vs-base `git diff` of a session's worktree — committed + uncommitted changes vs
   *  the configured base branch (default main). Works for ANY session with a
   *  worktree, not just PR/review tasks. Returns the resolved base/branch for the header. */
  async worktreeDiff(sessionId: number): Promise<{ ok: boolean; diff: string; base?: string; branch?: string; mergeBase?: string; error?: string }> {
    const s = this.getSession(sessionId);
    if (!s) return { ok: false, diff: "", error: "no session" };
    if (this.demo) {
      const { FAKE_PR_DIFF } = require("./demo");
      return { ok: true, diff: FAKE_PR_DIFF, base: this.cfg.default_base_branch, branch: (s as any).branch || "demo-branch", mergeBase: "demo123" };
    }
    const cwd = (s as any).worktree_path || (s as any).repo_path || "";
    if (!cwd) return { ok: false, diff: "", error: "no worktree for this session" };
    // brief cache (3s) so focus/open refreshes don't hammer git
    const now = Date.now();
    const cached = this._diffCache.get(sessionId);
    if (cached && now - cached.at < 3000) return cached.val;
    try {
      const { branchVsBaseDiff } = require("./diff");
      const d = await branchVsBaseDiff(cwd, this.cfg.default_base_branch, (s as any).base_branch || null);
      const val = d.base
        ? { ok: true, diff: d.patch || "", base: d.base, branch: d.branch, mergeBase: d.mergeBase }
        : { ok: true, diff: "", base: "", branch: d.branch, error: "no base branch to diff against" };
      this._diffCache.set(sessionId, { at: now, val });
      return val;
    } catch (e: any) {
      return { ok: false, diff: "", error: String(e?.message || e) };
    }
  }

  private _diffCache = new Map<number, { at: number; val: any }>();
  // per-repo throttle for the PR-expand `git fetch` (one network hit a minute, not per click)
  private _prExpandFetchAt = new Map<string, number>();

  /** GitHub-style "expand context": ONE file's diff re-cut with `ctx` context lines, against
   *  the SAME rev the full diff used (PR local repo base..head, else worktree merge-base).
   *  The renderer swaps the file's patch for this wider one when an expand arrow is clicked. */
  async diffExpand(sessionId: number, filePath: string, ctx: number, oldPath?: string): Promise<{ ok: boolean; fileDiff: string; error?: string; warning?: string }> {
    const s = this.getSession(sessionId);
    if (!s) return { ok: false, fileDiff: "", error: "no session" };
    // segment-based traversal check (a filename like `a..b.txt` is legitimate; `../` is not);
    // also reject `:`-prefixed git pathspec magic (`:/`, `:(glob)`) — defense in depth.
    const pathOk = (p: string) => !!p && !p.startsWith("/") && !p.startsWith(":") && !p.split("/").includes("..");
    const fp = String(filePath || "");
    const op = String(oldPath || "");
    if (!pathOk(fp) || (op && !pathOk(op))) return { ok: false, fileDiff: "", error: "bad path" };
    try {
      const { resolveDiffAgainst, fileDiffWithContext } = require("./diff");
      // PR sessions with a LOCAL repo (incl. the demo sandbox repo): diff base..head there.
      if ((s as any).pr_local_repo && (s as any).pr_base_ref && (s as any).pr_head_ref) {
        const d = await fileDiffWithContext((s as any).pr_local_repo, `${(s as any).pr_base_ref}..${(s as any).pr_head_ref}`, fp, ctx, op);
        return d.trim() ? { ok: true, fileDiff: d } : { ok: false, fileDiff: "", error: "no diff for this file" };
      }
      // PR-SOURCED diffs (`gh pr diff` — PR cards' synthetic `pr:` cwd, and claude sessions with
      // an attached PR): re-cut from a LOCAL clone of the PR's repo — fetch base+head (throttled
      // to once a minute per repo), then diff from the merge-base, the same content gh displays.
      // NEVER fall through to the worktree here: that would widen a DIFFERENT rev pair than the
      // one on screen. pr_number AND pr_repo, mirroring the renderer's hasPr (pr_number alone
      // never switches the pane to the gh diff, so its worktree diff is the displayed one).
      if ((s as any).kind === "pr" || ((s as any).pr_number && (s as any).pr_repo)) {
        if (this.demo) return { ok: false, fileDiff: "", error: "context expand not available for this demo session" };
        const base = String((s as any).pr_base_ref || "").trim();
        const head = String((s as any).pr_head_ref || "").trim();
        if (!base || !head) return { ok: false, fileDiff: "", error: "PR base/head not recorded yet — retry after the next PR scan" };
        // refs come from GitHub scans (valid branch names), but guard the shape anyway before
        // they're embedded in fetch refspecs: no leading '-', no whitespace/refspec metachars.
        const refSane = (x: string) => !x.startsWith("-") && !/[\s~^:?*\[\\]/.test(x) && !x.includes("..");
        if (!refSane(base) || !refSane(head)) return { ok: false, fileDiff: "", error: `unusable PR refs ${base}…${head}` };
        const repoPath = localRepoForPr((s as any).pr_repo, [(s as any).pr_local_repo, this.cfg.kanban_repo, ...this.cfg.sessions_repos]);
        if (!repoPath) return { ok: false, fileDiff: "", error: `no local clone of ${(s as any).pr_repo} — add it to sessions_repos in config/weights.json` };
        const { prExpandRange } = require("./diff");
        const now = Date.now();
        // throttle per (repo, base, head) — a different PR in the same repo still gets its fetch
        const tkey = `${repoPath}\0${base}\0${head}`;
        const doFetch = (this._prExpandFetchAt.get(tkey) || 0) < now - 60_000;
        if (doFetch) this._prExpandFetchAt.set(tkey, now); // pre-stamp: dedupes concurrent clicks
        const r = await prExpandRange(repoPath, base, head, Number((s as any).pr_number) || 0, doFetch);
        if (doFetch && !r.fetchOk) this._prExpandFetchAt.delete(tkey); // failed fetch ≠ a spent token — retry allowed
        if (!r.range) return { ok: false, fileDiff: "", error: `can't resolve ${base}…${head} in ${repoPath} — run 'git fetch origin' there (offline?), or the PR head may live on a fork` };
        const d = await fileDiffWithContext(repoPath, r.range, fp, ctx, op);
        if (!d.trim()) return { ok: false, fileDiff: "", error: "no diff for this file" };
        // stale-cut honesty: the screen shows the LIVE gh diff; if we couldn't freshen the local
        // refs, say so rather than silently serving outdated context.
        return r.fetchOk ? { ok: true, fileDiff: d } : { ok: true, fileDiff: d, warning: "fetch failed — context cut from possibly-stale local refs" };
      }
      if (this.demo) return { ok: false, fileDiff: "", error: "context expand not available for this demo session" };
      const cwd = (s as any).worktree_path || (s as any).repo_path || "";
      if (!cwd) return { ok: false, fileDiff: "", error: "no worktree for this session" };
      const r = await resolveDiffAgainst(cwd, this.cfg.default_base_branch, (s as any).base_branch || null);
      if (!r.against) return { ok: false, fileDiff: "", error: "no base branch to diff against" };
      const d = await fileDiffWithContext(cwd, r.against, fp, ctx, op);
      return d.trim() ? { ok: true, fileDiff: d } : { ok: false, fileDiff: "", error: "no diff for this file" };
    } catch (e: any) {
      // strict-git throws carry the whole "Command failed: git diff …\n<stderr>" blob — the
      // last stderr line (`fatal: …`) is the part worth showing in the status bar.
      const tail = String(e?.stderr || "").trim().split("\n").pop();
      return { ok: false, fileDiff: "", error: tail || String(e?.message || e) };
    }
  }

  /** Resolve the tmux attach spec (argv + env) for a real PTY (ensures a demo tmux exists). */
  attachSpec(sessionId: number): { argv: string[]; env: NodeJS.ProcessEnv; resizeName?: string } | null {
    const s = this.getSession(sessionId);
    if (!s) return null;
    return this.sessions.ensureAttachSpec(s);
  }

  /** P4: spec to spawn a session DIRECTLY (no tmux) via `claude --resume <id>` for a snappy
   *  dedicated terminal. Returns null if this isn't a resumable discovered claude session. */
  directResumeSpec(sessionId: number): { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | null {
    if (this.demo) return null;
    const s = this.getSession(sessionId) as any;
    if (!s) return null;
    // PR-TERMINAL: opening a terminal on a PR card MATERIALIZES it (in place, same row id) into a
    // real claude session — worktree on the PR's head branch + a fresh `claude` seeded with the
    // full PR context, ready to answer the operator's questions. Both terminal transports route
    // through here (the WS direct path AND localTermSpec's ssh path), so this one hook covers both.
    if (s.kind === "pr") return this.materializePrTerminal(s);
    // KANBAN-TERMINAL: opening a kanban card's terminal STARTS the card — same in-place
    // materialization as PR cards, so a surfaced card is never the "background agent —
    // read-only / (no transcript found)" dead end.
    if (s.kind === "kanban") return this.materializeKanbanTerminal(s);
    if (s.kind !== "claude") return null;
    const sid = s.claude_session_id;
    const cwd = s.worktree_path;
    if (!sid || !cwd) return null;
    try { if (!require("fs").existsSync(cwd)) return null; } catch { return null; }
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.TMUX; delete env.TMUX_PANE; // so `tmux` attaches on the DEFAULT socket + loads ~/.tmux.conf
    // node-pty's posix_spawnp resolves the command against THIS env's PATH (not a login shell), and
    // macOS GUI/launchd processes get a minimal PATH without Homebrew — so bare `tmux`/`claude` fail
    // with "posix_spawnp failed". Prepend the usual bin dirs and resolve to absolute paths so the
    // spawn (and the inner `claude` the tmux shell runs) always find the binaries. Harmless on Linux.
    {
      const home = require("os").homedir();
      const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
      env.PATH = [...extra, ...String(env.PATH || "").split(":")].filter((p, i, a) => p && a.indexOf(p) === i).join(":");
    }
    const resolveBin = (name: string): string => {
      try { return require("child_process").execFileSync("/usr/bin/env", ["sh", "-c", `command -v ${name}`], { env, encoding: "utf8" }).trim() || name; }
      catch { return name; }
    };
    const claudeBin = resolveBin("claude");
    const tmuxBin = resolveBin("tmux");
    // FIX FF: wrap the resume in a fresh per-session tmux so the operator's tmux commands work
    // (Ctrl+B - / | splits, etc.) and the terminal PERSISTS. `-A` = attach-or-create (reopening
    // re-attaches the SAME session). No `-f` override → the operator's own ~/.tmux.conf bindings
    // load. If tmux isn't available, fall back to a bare `claude --resume`. Ctrl+B passes through
    // to this inner tmux (the xterm handler only intercepts Ctrl+G).
    // KEEP-ALIVE: wrap the resume so the tmux session does NOT die (and tmux does NOT print a bare
    // `[exited]`) if `claude` ever exits — crash, `/exit`, or a slow refusal. On a normal exit we
    // drop into an interactive shell IN THE WORKTREE with a hint, so the session persists and
    // reopening re-attaches to it. EXCEPTION: if claude dies in <5s it's almost always a bg-agent
    // resume refusal — let the pane exit fast so attachTerminal()'s onExit fallback can route to the
    // agents view (existing behaviour) instead of trapping the operator in a shell.
    const resume = `${claudeBin} --resume ${sid} --dangerously-skip-permissions`;
    const inner =
      // SCROLL: tmux defaults to `mouse off`, so the xterm wheel does nothing and the operator
      // can't scroll the terminal. Enable it for this server (global, idempotent) the moment the
      // session starts → wheel → tmux copy-mode scrollback works. Harmless if already on.
      'tmux set -g mouse on 2>/dev/null; ' +
      '__t0=$(date +%s); ' + resume + '; __rc=$?; __t1=$(date +%s); ' +
      'if [ $((__t1 - __t0)) -lt 5 ]; then exit $__rc; fi; ' +
      'printf "\\n[Claude session ended — terminal kept alive. Resume with: ' + resume + ']\\n"; ' +
      'exec "${SHELL:-bash}" -i';
    const haveTmux = tmuxBin !== "tmux"; // resolveBin returns an absolute path when found, else the bare name
    if (haveTmux) {
      return { cmd: tmuxBin, args: ["new-session", "-A", "-s", `claudeos-${sessionId}`, "-c", cwd, inner], cwd, env };
    }
    return { cmd: claudeBin, args: ["--resume", sid, "--dangerously-skip-permissions"], cwd, env };
  }

  /** PR-TERMINAL: why the last PR-card terminal attach couldn't be materialized (no local clone,
   *  no head branch yet, worktree failure) — surfaced in the terminal instead of a silent
   *  read-only "(no transcript)" dead end. Cleared on success. */
  private _prTermError = new Map<number, string>();
  prTerminalError(sessionId: number): string | null {
    return this._prTermError.get(sessionId) || null;
  }

  /** PR-TERMINAL: convert a kind='pr' card into a real claude session and return the spawn spec
   *  for its terminal. The row keeps its id + PR tags (pr_repo/pr_number/…), so the next scanPrs
   *  dedups onto it via prBranchOwner (no duplicate card) and the UI keeps the PR diff + merge
   *  button. The terminal lives in the durable per-task tmux `claudeos-<id>` — the SAME name the
   *  normal resume path uses — so once discovery attaches a claude_session_id, every later open
   *  (direct resume, ssh local terminal, attach fallback) converges on this one tmux. */
  private materializePrTerminal(s: any): { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | null {
    const fail = (msg: string) => {
      this._prTermError.set(s.id, msg);
      try { console.error(`[pr-terminal] session #${s.id}: ${msg}`); } catch {}
      return null;
    };
    if (!s.pr_repo || !s.pr_number) return fail("PR card has no repo/number");
    const head = (s.pr_head_ref || "").trim();
    if (!head) return fail(`PR #${s.pr_number} has no head branch recorded yet — retry after the next PR scan`);
    const repoPath = localRepoForPr(s.pr_repo, [s.pr_local_repo, this.cfg.kanban_repo, ...this.cfg.sessions_repos]);
    if (!repoPath) return fail(`no local clone of ${s.pr_repo} — add its path to sessions_repos in config/weights.json`);
    let wt;
    try {
      wt = createPrWorktree(repoPath, s.pr_number, head);
    } catch (e: any) {
      return fail(`worktree for ${head} failed: ${String(e?.message || e)}`);
    }
    pretrust(wt.path); // skip the interactive trust dialog, like every cockpit-launched session
    // branch = the PR head: that's what makes the NEXT scanPrs dedup onto this row (prBranchOwner)
    // instead of re-creating a standalone card keyed by the old synthetic worktree_path.
    this.db
      // created_at resets to NOW: the card row becomes a live session at this moment — its
      // discovery time would mis-stamp (usually drop) the start in the throughput stats.
      .prepare("UPDATE sessions SET kind='claude', worktree_path=?, branch=?, state='WORKING', created_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(wt.path, head, s.id);
    this._prTermError.delete(s.id);
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.TMUX; delete env.TMUX_PANE;
    const boot = claudeLaunchCmd(true, prSeedPrompt(s)); // seed auto-submits on TUI boot (quoted literal)
    // Same keep-alive shape as the resume path: if claude ever exits, drop to a shell IN the PR
    // worktree instead of killing the tmux (reopening re-attaches).
    const inner = boot + '; printf "\\n[PR terminal ended — shell kept alive in the PR worktree]\\n"; exec "${SHELL:-bash}" -i';
    let haveTmux = false;
    try { require("child_process").execSync("command -v tmux", { stdio: "ignore" }); haveTmux = true; } catch {}
    if (haveTmux) return { cmd: "tmux", args: ["new-session", "-A", "-s", `claudeos-${s.id}`, "-c", wt.path, inner], cwd: wt.path, env };
    return { cmd: "bash", args: ["-lc", boot], cwd: wt.path, env };
  }

  /** KANBAN-TERMINAL: convert a kind='kanban' card into a real claude session and return the
   *  spawn spec for its terminal — the mirror of materializePrTerminal. The row flips IN PLACE
   *  (same id) to kind='claude' with a fresh worktree in kanban_repo, claude boots seeded with the
   *  shared kanbanLaunchPrompt (a one-line `/work <number> <title> (in <column>)`), and the
   *  card's queue item is consumed exactly like an engine auto-launch. The terminal lives in the
   *  durable per-task tmux `claudeos-<id>` so every later open converges on this one tmux. */
  private materializeKanbanTerminal(s: any): { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | null {
    const fail = (msg: string) => {
      this._prTermError.set(s.id, msg);
      try { console.error(`[kanban-terminal] session #${s.id}: ${msg}`); } catch {}
      return null;
    };
    const { slugify } = require("./sessions");
    const { createWorktree } = require("./worktree");
    const slug = slugify(s.title || `kanban-${s.id}`) || `kanban-${s.id}`;
    let wt;
    try {
      wt = createWorktree(this.cfg.kanban_repo, slug);
    } catch (e: any) {
      return fail(`worktree for kanban card "${s.title}" failed: ${String(e?.message || e)}`);
    }
    pretrust(wt.path); // skip the interactive trust dialog, like every cockpit-launched session
    const { kanbanLaunchPrompt } = require("./kanban");
    const prompt = kanbanLaunchPrompt(s);
    // Pin the CARD TITLE as the authoritative name (TASK_TAG_TITLED sentinel) so discovery's
    // prompt-derived titling never renames the card to the raw /work prompt text.
    const { TASK_TAG_TITLED } = require("./discover");
    this.db
      // created_at resets to NOW (see materializePrTerminal): start is stamped at launch, not at
      // the kanban scan that discovered the card.
      .prepare("UPDATE sessions SET kind='claude', worktree_path=?, branch=?, state='WORKING', clean_title=?, meta_gen_prompts=?, created_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(wt.path, wt.branch, s.title || null, TASK_TAG_TITLED, s.id);
    // the card item is consumed; the materialized session becomes a normal tracked one
    this.db.prepare("UPDATE items SET status='decided', decision='started', updated_at=datetime('now') WHERE session_id=?").run(s.id);
    this._prTermError.delete(s.id);
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.TMUX; delete env.TMUX_PANE;
    const boot = claudeLaunchCmd(true, prompt); // seed auto-submits on TUI boot (quoted literal)
    // Same keep-alive shape as the resume path: if claude ever exits, drop to a shell IN the
    // worktree instead of killing the tmux (reopening re-attaches).
    const inner = boot + '; printf "\\n[kanban terminal ended — shell kept alive in the task worktree]\\n"; exec "${SHELL:-bash}" -i';
    let haveTmux = false;
    try { require("child_process").execSync("command -v tmux", { stdio: "ignore" }); haveTmux = true; } catch {}
    if (haveTmux) return { cmd: "tmux", args: ["new-session", "-A", "-s", `claudeos-${s.id}`, "-c", wt.path, inner], cwd: wt.path, env };
    return { cmd: "bash", args: ["-lc", boot], cwd: wt.path, env };
  }

  /** LOCAL-TERMINAL spec (Electron desktop). Ensures this session's durable per-task tmux
   *  `claudeos-<id>` exists on the server (created DETACHED, reusing the exact keep-alive resume from
   *  directResumeSpec), then returns the ssh host + the trivial remote command to attach to it. The
   *  Electron client runs `ssh -t <host> <remote>` in a LOCAL pty, so terminal bytes flow your laptop↔the server
   *  straight over ssh — NOT through this server's WebSocket. Returns null when the session isn't
   *  safely resumable (live / bg-agent / non-claude); the client then falls back to the streamed WS,
   *  which keeps its special handling (foreign-pane attach / read-only transcript) for those cases. */
  localTermSpec(sessionId: number, host: string): { ok: true; host: string; remote: string; sessionName: string } | { ok: false } {
    const spec = this.directResumeSpec(sessionId);
    // Only the tmux-wrapped resume is safe to attach to from a second (ssh) client. A bare
    // `claude --resume` (no tmux) or a null spec means we must defer to the server-side WS path.
    if (!spec || spec.cmd !== "tmux") return { ok: false };
    const sessionName = `claudeos-${sessionId}`;
    // Ensure the durable session exists WITHOUT attaching here: `new-session -A -d` = create-detached
    // if missing, else no-op. We splice "-d" right after the existing "-A" so the keep-alive inner
    // command + cwd are byte-identical to what the WS path would have spawned.
    try {
      const args = [spec.args[0], spec.args[1], "-d", ...spec.args.slice(2)]; // new-session -A -d -s <name> -c <cwd> <inner>
      // Use spec.cmd (the ABSOLUTE tmux path directResumeSpec already resolved), NOT a bare "tmux":
      // the Electron app is launched from the macOS GUI/launchd with a minimal PATH that omits
      // Homebrew, so a bare "tmux" here fails to resolve → the durable claudeos-<id> is never
      // pre-created → the ssh `tmux attach` lands on a missing session → "[detached]". The absolute
      // path matches exactly what the server-side WS path spawns.
      require("child_process").execFileSync(spec.cmd, args, { env: spec.env, stdio: "ignore" });
    } catch { /* if create races/fails, a plain attach below may still succeed if it already exists */ }
    return { ok: true, host, remote: `tmux attach -t ${sessionName}`, sessionName };
  }

  /** FIX O: the visualization HTML files for a session (matched folder under viz_dir), cached
   *  ~10s so the frequent state() poll doesn't readdir the NFS viz_dir every call. */
  private _vizCache = new Map<number, { at: number; files: { name: string; file: string }[] }>();
  sessionViz(sessionId: number): { name: string; file: string }[] {
    const c = this._vizCache.get(sessionId);
    if (c && Date.now() - c.at < 10_000) return c.files;
    let files: { name: string; file: string }[] = [];
    try {
      const s = this.getSession(sessionId);
      if (s) files = require("./viz").vizFor(this.cfg.viz_dir, s, this.cfg.viz_mention_roots);
    } catch {}
    this._vizCache.set(sessionId, { at: Date.now(), files });
    return files;
  }

  /** FIX O: resolve a session's viz HTML file (by index or filename) to a safe absolute path
   *  under viz_dir, or null (missing / traversal). */
  resolveViz(sessionId: number, indexOrName: string): string | null {
    try {
      const s = this.getSession(sessionId);
      if (!s) return null;
      return require("./viz").resolveVizFile(this.cfg.viz_dir, s, indexOrName, this.cfg.viz_mention_roots);
    } catch { return null; }
  }

  /** The transcript session-id (uuid) for a session, or null. */
  sessionClaudeId(sessionId: number): string | null {
    const s = this.getSession(sessionId) as any;
    return (s && s.claude_session_id) || null;
  }

  /** FIX D: read-only render of THIS session's OWN transcript (tail-read, last ~30 turns).
   *  Used when a session can't be `--resume`d (bg-agent / live elsewhere) — we show its own
   *  conversation instead of EVER attaching to some other pane that merely shares the cwd. */
  async sessionTranscriptText(sessionId: number, maxTurns = 30): Promise<string> {
    const s = this.getSession(sessionId);
    if (!s) return "(no session)";
    const tPath = this.sessions.transcriptFor(s);
    if (!tPath) return "(no transcript found for this session)";
    try {
      const fs = require("fs");
      if (!fs.existsSync(tPath)) return "(transcript missing)";
      const { parseTranscriptTail, renderConversation } = require("./transcript");
      const st = fs.statSync(tPath);
      const view = await parseTranscriptTail(tPath, st.mtimeMs);
      const trimmed = { ...view, turns: view.turns.slice(-maxTurns) };
      return renderConversation(trimmed);
    } catch {
      return "(could not render transcript)";
    }
  }

  /** Raw `claude agents --json` records (NO cache) — used for fresh polls during a take-over. */
  private async fetchAgentsRaw(): Promise<any[]> {
    if (this.demo) return [];
    try {
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
      const { stdout } = await promisify(execFile)("claude", ["agents", "--json"], { encoding: "utf8", env, timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
      const data = JSON.parse(stdout);
      return Array.isArray(data) ? data : (Array.isArray(data?.agents) ? data.agents : (Array.isArray(data?.sessions) ? data.sessions : []));
    } catch { return []; }
  }

  private static agentId(a: any): string | null {
    const id = a?.sessionId || a?.session_id || a?.id || a?.session || a?.uuid;
    return typeof id === "string" ? id : null;
  }

  private _bgAgents: { at: number; ids: Set<string>; names: Map<string, string> } | null = null;
  /** LIVE background-agent session-ids (+ their clean names) from `claude agents --json` (cached
   *  ~10s). Background agents are daemon-managed (stale transcript mtime, no held fd) so
   *  isSessionLive misses them — and `claude --resume <id>` REFUSES for a running bg agent. We
   *  treat these as live → tmux/agents-view fallback. There is no per-agent direct-attach CLI.
   *  Bonus: the JSON carries a clean `name` (the operator's own agent name) → use it as the
   *  card headline immediately (no haiku call needed). */
  private async bgAgents(): Promise<{ ids: Set<string>; names: Map<string, string> }> {
    if (this.demo) return { ids: new Set(), names: new Map() };
    if (this._bgAgents && Date.now() - this._bgAgents.at < 10_000) return this._bgAgents;
    const ids = new Set<string>();
    const names = new Map<string, string>();
    try {
      const arr = await this.fetchAgentsRaw();
      for (const a of arr) {
        const id = Controller.agentId(a);
        // Only daemon-managed BACKGROUND agents are non-resumable; interactive ones are real ttys.
        if (id && a?.kind === "background") { ids.add(id); if (typeof a?.name === "string" && a.name.trim()) names.set(id, a.name.trim().slice(0, 60)); }
      }
    } catch { /* CLI missing/old/errored → empty set (defensive spawn-catch still protects) */ }
    this._bgAgents = { at: Date.now(), ids, names };
    return this._bgAgents;
  }
  async bgAgentSessionIds(): Promise<Set<string>> { return (await this.bgAgents()).ids; }

  /** FIX E: the live bg-agent record (pid + status + name) for a tracked session, or null.
   *  pid is taken STRICTLY from `claude agents --json` by sessionId — never guessed. */
  async bgAgentInfo(sessionId: number): Promise<{ pid: number; status: string; name: string; cwd: string; sessionId: string } | null> {
    const cid = this.sessionClaudeId(sessionId);
    if (!cid) return null;
    for (const a of await this.fetchAgentsRaw()) {
      if (Controller.agentId(a) === cid && a?.kind === "background" && Number.isInteger(a?.pid)) {
        return { pid: a.pid, status: String(a?.status || "idle"), name: String(a?.name || ""), cwd: String(a?.cwd || ""), sessionId: cid };
      }
    }
    return null;
  }

  /** FIX E: all take-over-able BACKGROUND agents that map to a tracked session (for the UI list
   *  + "take over all"). status is the live `claude agents --json` status (idle | busy). */
  async takeOverableAgents(): Promise<{ sessionId: number; claudeId: string; pid: number; status: string; name: string }[]> {
    const out: { sessionId: number; claudeId: string; pid: number; status: string; name: string }[] = [];
    const arr = await this.fetchAgentsRaw();
    for (const a of arr) {
      const cid = Controller.agentId(a);
      if (!cid || a?.kind !== "background" || !Number.isInteger(a?.pid)) continue;
      const row = this.db.prepare("SELECT id FROM sessions WHERE claude_session_id=? ORDER BY id DESC LIMIT 1").get(cid) as { id: number } | undefined;
      if (row) out.push({ sessionId: row.id, claudeId: cid, pid: a.pid, status: String(a?.status || "idle"), name: String(a?.name || "") });
    }
    return out;
  }

  /** FIX E: TAKE OVER a background agent → free it so it can be resumed as a dedicated terminal.
   *  (1) read its EXACT pid + status from `claude agents --json` by sessionId; (2) if busy and
   *  not confirmed, return needConfirm (the UI asks before interrupting a working agent — the
   *  conversation is preserved by the resume); (3) SIGTERM that exact pid, wait ≤3s, SIGKILL if
   *  still alive; (4) poll `claude agents --json` until the sessionId is gone (lock released, ≤5s).
   *  The caller then opens the terminal, which takes the FIX D idle path (`claude --resume`). */
  async takeOverAgent(sessionId: number, _opts: { confirmedBusy?: boolean } = {}): Promise<{ ok: boolean; needsManualStop?: boolean; status?: string; name?: string; pid?: number; error?: string }> {
    if (this.demo) return { ok: false, error: "demo" };
    const info = await this.bgAgentInfo(sessionId);
    if (!info) {
      // Not (any longer) a live bg agent → nothing to stop; mark it so a recent-mtime false
      // positive doesn't block the resume, then it's directly resumable.
      this._takenOver.set(sessionId, this._now());
      return { ok: true };
    }
    // E-REPURPOSE: `kind:"background"` agents are cc-DAEMON-managed — killing the pid is NOT
    // durable (the daemon RESPAWNS the agent with a new pid; verified with 30393e0d). So we DON'T
    // kill. Instead we tell the operator to stop it in their `claude agents` view (Ctrl+X); FIX I
    // then makes it resume here INSTANTLY (no 60s wait) the moment its process is gone.
    return { ok: false, needsManualStop: true, status: info.status, name: info.name, pid: info.pid };
  }

  private _takenOver = new Map<number, number>();
  private _now(): number { try { return Date.now(); } catch { return 0; } }
  /** True if this session was taken over in the last ~2 min → force the `claude --resume` path
   *  (its bg agent is dead; the recent-mtime liveness heuristic is a false positive). */
  wasJustTakenOver(sessionId: number): boolean {
    const t = this._takenOver.get(sessionId);
    return !!t && this._now() - t < 120_000;
  }

  /** Apply `claude agents --json` names as clean_title for matching sessions (instant, free
   *  clean headlines for the operator's bg agents). Called from the tick; best-effort. */
  async applyBgAgentTitles(): Promise<void> {
    if (this.demo) return;
    try {
      const { names } = await this.bgAgents();
      if (!names.size) return;
      for (const [sid, name] of names) {
        this.db.prepare("UPDATE sessions SET clean_title=? WHERE claude_session_id=? AND (clean_title IS NULL OR clean_title='' OR clean_title!=?)").run(name, sid, name);
      }
    } catch {}
  }

  /** P4 double-run guard: is this session currently LIVE elsewhere? (a running claude holds its
   *  transcript open, OR the transcript was written in the last ~60s). If LIVE we must NOT
   *  direct-spawn `--resume` (would corrupt the transcript) — fall back to tmux-attach. */
  isSessionLive(sessionId: number): boolean {
    const s = this.getSession(sessionId) as any;
    if (!s) return false;
    const tp = s.transcript_path as string | null;
    if (!tp) return false;
    try {
      const fs = require("fs");
      const st = fs.statSync(tp);
      if (Date.now() - st.mtimeMs < 60_000) return true; // recently active
    } catch {}
    return this.processHoldsTranscript(sessionId);
  }

  /** Does any LIVE process currently run this session in a way that makes a direct `--resume`
   *  re-spawn UNSAFE (a real second claude on the same transcript)? This is process-based truth —
   *  independent of mtime. Platform-split because the underlying signal differs:
   *   • Linux: a live `claude` holds its transcript fd open → scan /proc for a NON-daemon fd holder.
   *   • macOS: Claude appends-and-CLOSES the transcript (never holds the fd — verified with lsof),
   *     so the fd signal is unavailable. Use argv instead: a `claude --resume <cid>` process means
   *     this exact session is live. EXCEPTION: our OWN per-task `claudeos-<id>` tmux also runs
   *     `claude --resume <cid>`, but reopening it is SAFE (directResumeSpec's `tmux new-session -A`
   *     just re-attaches, no second claude) — so if that managed tmux exists, report NOT live and
   *     let the fast direct path re-attach it. */
  private processHoldsTranscript(sessionId: number): boolean {
    const s = this.getSession(sessionId) as any;
    const tp = s && (s.transcript_path as string | null);
    if (!tp) return false;
    if (process.platform === "linux") {
      try {
        const fs = require("fs");
        for (const ent of fs.readdirSync("/proc")) {
          if (!/^\d+$/.test(ent)) continue;
          let fds: string[]; try { fds = fs.readdirSync(`/proc/${ent}/fd`); } catch { continue; }
          for (const fd of fds) {
            let link: string; try { link = fs.readlinkSync(`/proc/${ent}/fd/${fd}`); } catch { continue; }
            // FIX Q: the cc-DAEMON supervisor (`claude daemon run`) keeps transcript fds OPEN for
            // sessions it ONCE managed — long after they stop being active agents. That is NOT a
            // live session; counting it makes idle sessions wrongly route to the agents-view
            // fallback. Only an ACTUAL session process (interactive / `claude --resume <id>`)
            // holding the fd means "live". So skip the daemon holder.
            if (link === tp && !Controller.isCcDaemon(ent)) return true;
          }
        }
      } catch {}
      return false;
    }
    // macOS / other: argv-based (see method doc). Our managed `claudeos-<id>` tmux → safe to direct.
    const cid = (s.claude_session_id as string | null) || null;
    if (!cid) return false;
    const cp = require("child_process");
    const env = this.spawnProbeEnv();
    try { cp.execFileSync("tmux", ["has-session", "-t", `claudeos-${sessionId}`], { stdio: "ignore", env, timeout: 5000 }); return false; } catch {}
    try {
      const ps = cp.execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 8000 });
      return Controller.matchesResumeProc(ps, cid);
    } catch { return false; }
  }

  /** A minimal env for liveness probes (tmux/ps): default tmux socket + the bin dirs a macOS
   *  GUI/launchd process is missing (Homebrew, ~/.local). Mirrors directResumeSpec/envNoTmux. */
  private spawnProbeEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.TMUX; delete env.TMUX_PANE; // probe the DEFAULT socket, not whatever spawned us
    const home = require("os").homedir();
    const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    env.PATH = [...extra, ...String(env.PATH || "").split(":")].filter((p, i, a) => p && a.indexOf(p) === i).join(":");
    return env;
  }

  /** Pure + testable: do any of these `ps`-style "pid command" lines run `claude --resume <cid>`?
   *  The cc-daemon (`claude daemon run`) lacks `--resume <cid>`, so it's excluded automatically. */
  static matchesResumeProc(psOutput: string, cid: string): boolean {
    if (!cid) return false;
    const needle = `--resume ${cid}`;
    for (const line of psOutput.split("\n")) {
      if (line.includes(needle) && /(^|\/|\s)claude(\s|$)/.test(line)) return true;
    }
    return false;
  }

  /** FIX Q: is this pid the cc-daemon supervisor (`claude daemon run`)? Its cmdline contains
   *  "daemon" + "run" (NUL-separated argv). It supervises agents but is NOT a session process.
   *  Linux-only (reads /proc); the macOS argv path excludes the daemon implicitly (no `--resume`). */
  private static isCcDaemon(pid: string): boolean {
    try {
      const fs = require("fs");
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim().toLowerCase();
      return cmd.includes("daemon run") || /(^|\/|\s)claude\s+daemon\b/.test(cmd) || cmd.includes("cc-daemon");
    } catch { return false; }
  }

  /** FIX I: FRESH, PROCESS-BASED liveness for terminal-open routing. A session is "live / unsafe
   *  to --resume" ONLY if a process is actually running it — it's in `claude agents --json`
   *  (FRESH fetch, NOT the 10s cache) OR a process holds its transcript fd. Transcript mtime alone
   *  is NOT a blocker, so an externally-stopped (Ctrl+X) or just-killed agent — dead process,
   *  recent mtime — resumes IMMEDIATELY. Returns {live, isBg} so the caller can label the case. */
  async livenessForOpen(sessionId: number): Promise<{ live: boolean; isBg: boolean }> {
    if (this.demo) return { live: false, isBg: false };
    const cid = this.sessionClaudeId(sessionId);
    let isBg = false;
    if (cid) {
      try { isBg = (await this.fetchAgentsRaw()).some((a) => Controller.agentId(a) === cid && a?.kind === "background"); } catch {}
    }
    if (isBg) return { live: true, isBg: true };
    // not a daemon bg agent → live ONLY if a process actually holds the transcript fd
    return { live: this.processHoldsTranscript(sessionId), isBg: false };
  }

  /** Forward a single keystroke from the browser into the session's tmux pane. */
  key(sessionId: number, key: string, named: boolean): { ok: boolean } {
    const s = this.getSession(sessionId);
    if (!s) return { ok: false };
    return { ok: this.sessions.sendKey(s, key, named) };
  }

  /** Pin/unpin a session — pinned forces it to the top of the queue when ready. */
  setPinned(sessionId: number, pinned: boolean): void {
    const s = this.getSession(sessionId);
    const prev = s ? s.pinned : 0;
    setPinned(this.db, sessionId, pinned);
    pushUndo(this.db, "pin", pinned ? `pinned “${s?.title || "session"}”` : `unpinned “${s?.title || "session"}”`, [
      { t: "setSession", id: sessionId, fields: { pinned: prev } },
    ]);
    // Re-score HERE, not only in the HTTP handler: items cache their priority, the tick's
    // Stage-0 lock never re-evaluates a pending item, and the Electron IPC path has no other
    // rerank — without this, unpinning left the +PIN_BASE score baked in (the "99994" ghost).
    this.engine.rerank();
  }

  /** Inline rename: set/clear the operator-typed session name. Blank clears → display reverts
   *  to the auto (haiku) name. The auto-namer never touches manual_title, so a rename sticks. */
  renameSession(sessionId: number, title: string): { ok: boolean; title: string | null } {
    const s = this.getSession(sessionId);
    if (!s) return { ok: false, title: null };
    const prev = (s as any).manual_title ?? null;
    setManualTitle(this.db, sessionId, title);
    const now = ((this.getSession(sessionId) as any)?.manual_title ?? null) as string | null;
    pushUndo(this.db, "rename", now ? `renamed session to “${now}”` : `cleared name on “${s.clean_title || s.title || "session"}”`, [
      { t: "setSession", id: sessionId, fields: { manual_title: prev } },
    ]);
    return { ok: true, title: now };
  }

  /** Set/clear the operator's manual importance override (0..100, or null to clear). */
  setManualImportance(sessionId: number, value: number | null): void {
    const s = this.getSession(sessionId);
    const prev = s ? s.manual_importance : null;
    // Training example: an override reveals the model's importance was wrong for this item.
    if (value != null) {
      try {
        const q = this.engine.queue().find((x) => x.session_id === sessionId);
        if (q) recordExample(this.db, "manual_importance", this.featuresOf(q, 0), { llm_importance: q.importance }, { manual_importance: value });
      } catch {}
    }
    setManualImportance(this.db, sessionId, value);
    // Typing an exact score is an ABSOLUTE statement — wipe accumulated h/l nudges, or a stale
    // delta (e.g. -90 from old "l" presses) silently drags "set to 100" down to 10.
    const prevDelta = s ? (s as any).manual_priority_delta || 0 : 0;
    if (value != null && prevDelta)
      this.db.prepare("UPDATE sessions SET manual_priority_delta=0, updated_at=datetime('now') WHERE id=?").run(sessionId);
    pushUndo(this.db, "manualImportance", `set importance ${value == null ? "(cleared)" : value} on “${s?.title || "session"}”`, [
      { t: "setSession", id: sessionId, fields: { manual_importance: prev, manual_priority_delta: prevDelta } },
    ]);
    this.engine.rerank(); // same as setPinned: cached priorities must follow the flag everywhere
  }

  async prDiff(sessionId: number) {
    if (this.demo) {
      const s = this.getSession(sessionId);
      if (s && s.pr_local_repo && s.pr_base_ref && s.pr_head_ref) {
        try {
          const { execFileSync } = require("child_process");
          const diff = execFileSync("git", ["-C", s.pr_local_repo, "diff", `${s.pr_base_ref}..${s.pr_head_ref}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: gitEnv() });
          return { ok: true, diff };
        } catch { /* fall through to canned */ }
      }
      return { ok: true, diff: FAKE_PR_DIFF };
    }
    const s = this.getSession(sessionId);
    if (!s) return { ok: false, diff: "", error: "no session" };
    return prDiff(s);
  }

  async prStatus(sessionId: number) {
    if (this.demo) return { ...FAKE_PR_STATUS };
    const s = this.getSession(sessionId);
    if (!s) return { ok: false, reviewDecision: "", checks: "", state: "", error: "no session" };
    return prStatus(s);
  }

  /** Launch a real Claude Code session for a STARTABLE kanban card (confirm-guarded in UI). */
  /** Instantly launch a fresh EMPTY terminal session (no form) and return its id for
   *  auto-attach. kind 'claude' = empty interactive claude (--dangerously-skip-permissions);
   *  kind 'shell' = a plain bash. Marked provisional (ephemeral until used). */
  newSession(
    kind: "claude" | "shell",
    prompt?: string,
    importance?: number | null,
    repo?: string | null,
  ): { ok: boolean; sessionId?: number; kind: string; message: string } {
    try {
      // Repo can be chosen at launch (the ＋ new-terminal picker passes one of `sessions_repos`);
      // fall back to the configured default. Only honor a repo that's actually on the offered list
      // (or the default) so an arbitrary path can't be launched from the client.
      const allowed = new Set([...(this.cfg.sessions_repos || []), this.cfg.sessions_default_repo].filter(Boolean));
      const chosen = repo && allowed.has(repo) ? repo : this.cfg.sessions_default_repo;
      const id = this.sessions.launchTerminalSession({ kind, repo: chosen, skipPermissions: kind === "claude", prompt });
      // Optional manual importance set at launch (quick-prompt priority). Write it straight to the
      // row — no undo entry / example-recording (the session is brand-new, has no queue item yet).
      if (importance != null && Number.isFinite(importance)) {
        setManualImportance(this.db, id, Math.max(0, Math.min(100, Math.round(importance))));
      }
      return { ok: true, sessionId: id, kind, message: kind === "shell" ? "new shell" : "new Claude session" };
    } catch (e: any) {
      return { ok: false, kind, message: "launch failed: " + String(e?.message || e) };
    }
  }

  /** Record that the operator sent input to a session's terminal (promotes it from provisional). */
  markSessionInput(sessionId: number): void {
    const { setInputSeen } = require("./db");
    setInputSeen(this.db, sessionId);
  }

  /** PROVISIONAL GUARD: the operator OPENED a terminal on this session (the WS attached). That's
   *  a real interaction — even with no keystroke yet — so a provisional session that was ever
   *  opened must be KEPT, not deleted on detach. Marks input_seen (the keep signal). */
  markSessionOpened(sessionId: number): void {
    const { setInputSeen } = require("./db");
    try { setInputSeen(this.db, sessionId); } catch {}
  }

  /** On detach: a provisional session that was TRULY never touched is DELETED; one that was
   *  EVER OPENED (terminal attached → input_seen via markSessionOpened), had input sent, or has a
   *  real user turn is PROMOTED/kept. So you can never lose a session you opened a terminal on. */
  cleanupOrPromoteProvisional(sessionId: number): { action: "deleted" | "promoted" | "kept" } {
    const s = this.getSession(sessionId);
    if (!s || !s.provisional) return { action: "kept" };
    const used = s.input_seen === 1 || this.firstUserMessage(s) != null;
    const { setProvisional, deleteSession } = require("./db");
    if (used) {
      setProvisional(this.db, sessionId, false);
      const title = this.firstUserMessage(s);
      if (title && s.kind !== "shell") this.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(title.slice(0, 80), sessionId);
      return { action: "promoted" };
    }
    this.sessions.killTerminalSession(s);
    deleteSession(this.db, sessionId);
    return { action: "deleted" };
  }

  private firstUserMessage(s: SessionRow): string | null {
    try {
      const tp = this.sessions.transcriptFor(s);
      if (!tp) return null;
      const { parseTranscript } = require("./transcript");
      const v = parseTranscript(tp);
      const u = (v?.turns || []).find((t: any) => t.role === "user" && t.text && t.text.trim());
      return u ? String(u.text).trim() : null;
    } catch { return null; }
  }

  /** Launch a NEW Claude session (← in detail) and return its id for auto-attach. In
   *  demo it creates a sandbox session row (the live terminal spawns a real sandbox
   *  `claude` on the demo socket); in real mode it launches a worktree + tmux `claude`. */
  launchSession(repo: string, title: string, firstPrompt: string): { ok: boolean; sessionId?: number; message: string } {
    const t = (title || "").trim() || "new session";
    if (this.demo) {
      const id = this.sessions.register({
        repo: repo || "demo/sandbox",
        title: t,
        worktreePath: `/tmp/cockpit-demo-launch-${t.replace(/[^a-z0-9]+/gi, "-")}`,
        branch: "demo",
      });
      return { ok: true, sessionId: id, message: `demo session “${t}”` };
    }
    try {
      const prompt = (firstPrompt || "").trim() || `Start working on: ${t}`;
      const id = this.sessions.launch({ repo, title: t, prompt });
      return { ok: true, sessionId: id, message: `launched Claude session #${id}` };
    } catch (e: any) {
      return { ok: false, message: "launch failed: " + String(e?.message || e) };
    }
  }

  kanbanStart(sessionId: number): { ok: boolean; message: string } {
    const s = this.getSession(sessionId);
    if (!s || s.kind !== "kanban") return { ok: false, message: "not a kanban card" };
    if (this.demo) {
      this.db.prepare("UPDATE items SET status='decided', decision='started (demo)', updated_at=datetime('now') WHERE session_id=?").run(sessionId);
      return { ok: true, message: `would launch a Claude session for “${s.title}” (demo — nothing real happened)` };
    }
    // Shared launch path (also used by the engine's kanban auto-launch — card 291).
    const newId = this.engine.launchKanbanCard(s);
    if (newId == null) return { ok: false, message: "launch failed" };
    return { ok: true, message: `launched Claude session #${newId} for “${s.title}”` };
  }

  /** Store the operator's answers to a NEEDS-INFO kanban card's clarifying questions. */
  kanbanAnswer(sessionId: number, answers: string[]): { ok: boolean } {
    const s = this.getSession(sessionId);
    if (!s || s.kind !== "kanban") return { ok: false };
    let qs: string[] = [];
    try { qs = JSON.parse(s.kanban_questions || "[]"); } catch {}
    const qa = qs.map((q, i) => ({ q, a: answers[i] || "" }));
    this.db.prepare("UPDATE sessions SET kanban_answers=? WHERE id=?").run(JSON.stringify(qa), sessionId);
    return { ok: true };
  }

  /** Append stored answers to the kanban card file — EXPLICIT confirm only; demo no-op. */
  kanbanAppend(sessionId: number): { ok: boolean; message: string } {
    const s = this.getSession(sessionId);
    if (!s || s.kind !== "kanban") return { ok: false, message: "not a kanban card" };
    let qa: { q: string; a: string }[] = [];
    try { qa = JSON.parse(s.kanban_answers || "[]"); } catch {}
    if (!qa.length) return { ok: false, message: "no answers to append" };
    if (this.demo) return { ok: true, message: "would append answers to the card file (demo — nothing real happened)" };
    try {
      const { appendAnswersToCard } = require("./kanban");
      if (!s.kanban_file) return { ok: false, message: "no card file" };
      appendAnswersToCard(s.kanban_file, qa);
      // now startable
      this.db.prepare("UPDATE sessions SET kanban_startable=1 WHERE id=?").run(sessionId);
      return { ok: true, message: "appended clarifications to the card; it's now startable" };
    } catch (e: any) {
      return { ok: false, message: "append failed: " + String(e?.message || e) };
    }
  }

  async prMerge(sessionId: number, method?: "merge" | "squash" | "rebase", deleteBranch = false) {
    if (this.demo) {
      const delNote = deleteBranch ? " (branch deletion skipped — demo)" : "";
      const s = this.getSession(sessionId);
      const it = this.db.prepare("SELECT * FROM items WHERE session_id=?").get(sessionId) as unknown as ItemRow | undefined;
      // DEMO but REAL: perform an actual local `git merge --no-ff` in the throwaway repo
      // (100% sandboxed — no GitHub, no real repos) so the result is genuinely visible.
      if (s && s.pr_local_repo && s.pr_base_ref && s.pr_head_ref) {
        try {
          const { execFileSync } = require("child_process");
          const g = (args: string[]) => execFileSync("git", ["-C", s.pr_local_repo, ...args], { encoding: "utf8", env: gitEnv() });
          const commits = g(["rev-list", "--count", `${s.pr_base_ref}..${s.pr_head_ref}`]).trim();
          g(["checkout", "-q", s.pr_base_ref]);
          g(["merge", "--no-ff", "-m", `Merge ${s.pr_head_ref} into ${s.pr_base_ref} (demo)`, s.pr_head_ref]);
          const out = `✅ merged ${s.pr_head_ref} → ${s.pr_base_ref} (${commits} commits)${delNote}`;
          this.db.prepare("UPDATE sessions SET pr_review_decision='merged', updated_at=datetime('now') WHERE id=?").run(sessionId);
          if (it) {
            this.db.prepare("UPDATE items SET status='decided', decision=?, one_liner=?, updated_at=datetime('now') WHERE session_id=?").run(out, out, sessionId);
            pushUndo(this.db, "prMerge", out, [{ t: "setItem", id: it.id, fields: { status: it.status, decision: it.decision, one_liner: it.one_liner } }]);
          }
          return { ok: true, output: out };
        } catch (e: any) {
          return { ok: false, output: "demo merge failed: " + String(e?.message || e) };
        }
      }
      if (s) this.db.prepare("UPDATE items SET status='decided', decision='merged (demo)', updated_at=datetime('now') WHERE session_id=?").run(sessionId);
      if (it)
        pushUndo(this.db, "prMerge", `merged ${s ? s.repo + "#" + s.pr_number : "PR"} (demo)`, [
          { t: "setItem", id: it.id, fields: { status: it.status, decision: it.decision } },
        ]);
      return { ok: true, output: `merged ${s ? s.repo + "#" + s.pr_number : "PR"} (demo — nothing real happened)${delNote}` };
    }
    const s = this.getSession(sessionId);
    if (!s) return { ok: false, output: "", error: "no session" };
    const r = await prMerge(s, method || "squash", deleteBranch);
    // MERGE-RECONCILE: delete the merged kind='pr' card (or untag a claude session) right away so
    // it doesn't re-surface with a live merge button before the next throttled scanPrs.
    if (r.ok) this.reconcileMergedLocally(sessionId);
    return r;
  }

  setFocus(focus: string): void {
    saveFocus(focus);
    this.cfg.focus = focus;
    this.engine.setConfig(this.cfg);
  }
}

/** Canned cockpit review runs for the DEMO PR (session=demo/bf16 is a real demo session
 *  so the "attach" action resolves to a live sandbox terminal). Clearly fake. */
function DEMO_REVIEW_RUNS(): any[] {
  return [
    {
      type: "prteam", verdict: "GREEN", tier: "deep", rounds: "3", tests: "pass",
      session: "demo/bf16", ts: "2026-06-08T07:40:00Z", author: "octocat",
      summary: "**/prteam (deep) — GREEN · 3 rounds**\n\nConverged. Fixed 2 bugs (off-by-one in varlen pack, missing null guard). Contested item resolved: keep bf16 grads. Tests pass.",
      createdAt: "2026-06-08T07:40:05Z",
    },
    {
      type: "pr", verdict: "RED", tier: "", rounds: "", tests: "fail",
      session: "demo/bf16", ts: "2026-06-08T06:15:00Z", author: "octocat",
      summary: "**Code review — RED**\n\n1 Important, 2 Minor. 🔴 race in flush loop drops messages on shutdown. Tests: 1 failing.",
      createdAt: "2026-06-08T06:15:02Z",
    },
    {
      type: "pr", verdict: "GREEN", tier: "", rounds: "", tests: "skip",
      session: "task/not-tracked", ts: "2026-06-07T22:00:00Z", author: "octocat",
      summary: "**Code review — GREEN**\n\nNo issues found. (Tests skipped — needs GPU.)",
      createdAt: "2026-06-07T22:00:01Z",
    },
  ];
}

/** PR-CONV: canned conversation for the demo PR — same shape as fetchPrConversation, no gh.
 *  Timestamps are relative to now so the "opened / last commit" ages always read sensibly. */
function DEMO_PR_CONVERSATION(): any {
  const h = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
  const runs = DEMO_REVIEW_RUNS();
  return {
    ok: true,
    pr: {
      number: 512, url: "https://github.com/demo/your-repo/pull/512", title: "bf16 gradient compression for DDP",
      state: "OPEN", draft: false, reviewDecision: "APPROVED", mergeable: "CLEAN",
      additions: 142, deletions: 38, author: "octocat", base: "main", head: "demo/bf16", createdAt: h(70),
    },
    meta: { createdAt: h(70), lastCommitAt: h(2), commitCount: 4 },
    reviews: runs,
    thread: [
      { kind: "commit", oid: "a1b2c3d", headline: "bf16 grad compression hook", author: "octocat", createdAt: h(69) },
      { kind: "comment", author: "octocat", createdAt: h(40), body: runs[1].summary, cockpit: { type: "pr", verdict: "RED", tier: "", rounds: "", tests: "fail" } },
      { kind: "thread", path: "src/your-repo/ddp/flush.py", line: 42, author: "your-org", createdAt: h(38),
        comments: [
          { author: "your-org", createdAt: h(38), body: "This drops messages if the loop is mid-flush on shutdown — needs a drain." },
          { author: "octocat", createdAt: h(30), body: "Fixed in a1b2c3d — drain + join before exit." },
        ] },
      { kind: "commit", oid: "d4e5f6a", headline: "fix: drain flush loop on shutdown", author: "octocat", createdAt: h(30) },
      { kind: "comment", author: "octocat", createdAt: h(8), body: runs[0].summary, cockpit: { type: "prteam", verdict: "GREEN", tier: "deep", rounds: "3", tests: "pass" } },
      { kind: "review", author: "your-org", createdAt: h(5), state: "APPROVED", body: "LGTM — nice catch on the flush race." },
      { kind: "commit", oid: "b7c8d9e", headline: "docs: comment the drain invariant", author: "octocat", createdAt: h(2) },
    ],
  };
}
