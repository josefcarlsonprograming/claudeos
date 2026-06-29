/**
 * The engine: one tick = SCAN -> DETECT -> TRIAGE -> SUMMARIZE -> RANK, writing
 * the operator-facing `items`. Mirrors the jarvis pipeline, specialised to Claude
 * Code sessions.
 *
 * The CRITICAL RULE is enforced here at the gate: only sessions the state detector
 * marks READY (WAITING_INPUT | DONE) ever produce an item. WORKING / UNKNOWN
 * sessions update their state column but never surface as actionable.
 */
import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import {
  SessionRow,
  ItemRow,
  TriageCategory,
  SessionState,
  setSessionState,
  setSessionEta,
  setSessionEtaProbe,
  allSessions,
  setSessionVerdict,
} from "./db";
import { parseEtaMarker, interpretEta, estimateEtaFromOutput, formatTimeLeft } from "./eta";
import { SessionManager } from "./sessions";
import { parseTranscriptTail, turnSignature, TranscriptView, findLastUserPromptDeep, pendingToolStall, pendingInteractivePrompt } from "./transcript";
import { detectState } from "./stateDetector";
import { verifyWorking, WorkingVerdict, mapActivity, ActivityClass, VERDICT_REV } from "./workingVerifier";
import { StreamingSampler, transcriptSig, processTreeJiffies } from "./streamingSampler";
import { worktreeDiff } from "./diff";
import { triage, triageRules } from "./triage";
import { enrichItem, enrichFallback } from "./enrich";
import { scoreItem, focusMatch, effectiveSnoozePenalty, PIN_BASE, ACTIVE_OVER, ScoreResult } from "./priority";
import { learnedAdjustments, viewPreference } from "./feedback";
import { discoverRecentSessions, infraTags } from "./discover";
import { scanPrs } from "./pr";
import { normalizeOptions } from "./options";
import { listKanbanCards, classifyKanbanCard, cardDescription, kanbanLaunchPrompt, KanbanCard } from "./kanban";
import { upsertKanban, pruneKanban, getSession, getLearnedWeights, getMeta, setMeta } from "./db";
import { FullConfig } from "./config";

export interface RankedItem extends ItemRow {
  session: SessionRow;
  score_breakdown: any;
  default_view: "summary" | "raw";
  ready_reason: string;
  // TEAM-GROUP entries: one synthetic row per live Claude Code team, listing its teammates as
  // child rows. Never becomes `next`; children are display-only.
  _team?: boolean;
  children?: TeamChild[];
}

export interface TeamChild {
  session_id: number;
  agent_name: string;
  state: string; // WORKING | WAITING_INPUT | DONE | UNKNOWN
  tmux_target: string | null;
}

export interface TickResult {
  surfaced: number; // ready sessions that produced/updated items
  hidden: number; // sessions deliberately kept hidden (working/ambiguous)
  locked: number; // sessions ALREADY in Up Next → frozen, not re-evaluated this tick
  states: Record<string, number>;
}

export class Engine {
  constructor(
    private db: DatabaseSync,
    private sessions: SessionManager,
    private cfg: FullConfig,
    private opts: { enrich?: boolean; discover?: boolean; discoverLimit?: number; pr?: boolean; prScanIntervalMs?: number; kanban?: boolean; now?: () => number; heavyPhaseEvery?: number } = { enrich: true }
  ) {}

  /** Current wall-clock in ms. Injectable (`opts.now`) so the kanban cooldown is testable with a fake clock. */
  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private ticking = false;
  private lastPrScan = 0;
  /** Monotonic tick counter — used to THROTTLE the heavy, non-time-critical phases (session
   *  discovery + housekeeping sweeps) to ~every 15s instead of every tick. The responsiveness-
   *  critical per-session detect/surface/❓-flag loop still runs EVERY tick; only the work that
   *  doesn't need 5s freshness is throttled, so a terminal open rarely lands on a busy event loop.
   *  2026-06-18: opens stalled ~650ms because discover (≈950ms wall) + the sweeps ran every 5s. */
  private tickCount = 0;
  /** Haiku working-verifier cache: the model's last verdict per session, keyed by the transcript
   *  mtime it was judged at. While the transcript is unchanged the verdict is reused (zero calls);
   *  a fresh write invalidates it. `verifyingWork` dedups in-flight checks. See workingVerifier.ts. */
  private workVerdicts = new Map<number, { mtimeMs: number; verdict: WorkingVerdict; at: number }>();
  private verifyingWork = new Set<number>();
  /** The FREE double-sample stability gate (card 288, Layer 1): the transcript signature + the
   *  process-tree CPU must be byte-stable/quiet across `double_sample_gap_ms` before a candidate is
   *  even eligible for the Haiku classifier. Catches active streaming for $0. See streamingSampler.ts. */
  private sampler = new StreamingSampler();
  /** Consecutive failed (null/error) ready-gate classifier checks per session — feeds the
   *  fail-open: a stable session whose checks keep failing surfaces on the heuristic after
   *  gateFailOpenAttempts(), so a down model can never strand a ready session hidden. */
  private verifyFailures = new Map<number, number>();
  /** auto-continue tracker: per session, the stalled transcript mtime + a CPU baseline + how many
   *  "continue" nudges we've sent for THIS stall. A transcript advance (mtime change = the nudge
   *  worked) resets it; the cap stops an unrevivable stall from looping. In-memory (a restart just
   *  re-nudges once, harmless). */
  private stallTracker = new Map<number, { mtime: number; cpuJiffies: number | null; cpuAt: number; attempts: number; lastAttemptAt: number }>();
  /** infra-tag scan memo: transcript mtime already scanned per session (regex over the 128KB tail
   *  is cheap, but ~200 sessions x every tick adds up — scan only when the transcript changed). */
  private infraTagged = new Map<number, number>();
  /** ETA exponential backoff: re-estimating UNCHANGED output mostly re-buys the same answer. Per
   *  session: attempts on the same transcript mtime double the reprobe interval (cap 8x = 24h at
   *  the 180m default); any new output resets to 1x. In-memory — a restart just resets backoff. */
  private etaBackoff = new Map<number, { mtime: number; mult: number }>();
  /** Defaults for the ready-gate cadence. These are the FALLBACKS — the live values come from
   *  cfg.state_gate (config/weights.json), read via the gate*() helpers below so the operator can
   *  tune them without a rebuild. Kept as statics so the wiring is greppable + testable. */
  /** Don't Haiku a session that wrote in the last beat — it's plausibly still streaming; wait for
   *  the writes to settle this long first. */
  private static WORK_VERIFY_SETTLE_MS = 1200;
  /** While a session keeps writing (mtime moving), re-check at most this often — caps cost for a
   *  genuinely long-running session to ~1 Haiku call per this interval. */
  private static WORK_VERIFY_MIN_INTERVAL_MS = 6000;
  // NOTE: the old SURFACE_VERIFY_WINDOW_MS "recently active" window is GONE: it let any session
  // quiet for >2 min surface on the cheap text heuristics with no model read — exactly how
  // "kicked off the script, will check back" sessions landed in the operator's queue. Every alive
  // candidate is now verdict-gated; the model-down escape is the fail-open counter instead.
  // --- live ready-gate cadence (cfg.state_gate, falling back to the statics above) ---
  private gateSettleMs(): number { return this.cfg.state_gate?.settle_ms ?? Engine.WORK_VERIFY_SETTLE_MS; }
  private gateMinIntervalMs(): number { return this.cfg.state_gate?.min_verify_interval_ms ?? Engine.WORK_VERIFY_MIN_INTERVAL_MS; }
  private gateGapMs(): number { return this.cfg.state_gate?.double_sample_gap_ms ?? 5000; }
  private gateCpuBusyFrac(): number { return this.cfg.state_gate?.cpu_busy_frac ?? 0.05; }
  /** auto-continue config (operator request 2026-06-15): nudge a stalled-after-tool session with
   *  "continue" so the operator doesn't babysit every stall. Conservative defaults. */
  /** Seam (overridable in tests): process-tree CPU jiffies for the auto-continue idle gate. */
  private cpuJiffiesFor(pid: number | null | undefined, now: number): number | null { return processTreeJiffies(pid, now); }
  /** Audit every auto-continue nudge to .run/auto-continue.jsonl so the operator can VERIFY it only
   *  ever fired on real stalls (no "did it secretly continue a waiting session?" guesswork). */
  private logAutoContinue(s: SessionRow, attempt: number, quietMs: number): void {
    try {
      const f = path.resolve(__dirname, "../../.run/auto-continue.jsonl");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), session_id: s.id, title: (s.clean_title || s.title || "").slice(0, 80), attempt, quiet_s: Math.round(quietMs / 1000) }) + "\n");
    } catch {}
  }
  private autoContinueCfg() {
    const a = (this.cfg as any).auto_continue || {};
    return {
      enabled: a.enabled !== false,
      quietMs: typeof a.quiet_ms === "number" ? a.quiet_ms : 600000, // 10 min of ZERO transcript activity
      maxAttempts: typeof a.max_attempts === "number" ? a.max_attempts : 3,
      retryMs: typeof a.retry_ms === "number" ? a.retry_ms : 40000,
      message: typeof a.message === "string" ? a.message : "continue",
    };
  }
  private classifierEnabled(): boolean { return this.cfg.state_gate?.classifier_enabled !== false; }
  /** The model that reads transcript tails for the ready-gate verdict. Separate from models.triage:
   *  gate calls are low-volume (mtime-cached) and visibility-critical, so they default to sonnet —
   *  measured on the verifier goldset (npm run eval:verifier): sonnet 24/24 exact, haiku 100% on
   *  surface-safety but wobbles DONE↔WAITING_ON_OPERATOR on borderline trailing-offer tails. */
  private gateModel(): string { return this.cfg.state_gate?.model || "sonnet"; }
  /** After this many consecutive failed/timed-out classifier checks on a stable session, surface
   *  the heuristic state anyway (the model-down self-bound; replaces the old time-window escape). */
  private gateFailOpenAttempts(): number { return this.cfg.state_gate?.fail_open_attempts ?? 3; }
  /** A WAITING_ON_SELF verdict only keeps a session hidden while it's been quiet LESS than this.
   *  0 disables (hide until the transcript changes). */
  private gateSelfWaitTtlMs(): number { return (this.cfg.state_gate?.self_wait_ttl_min ?? 60) * 60_000; }
  /** ETA grace window. A session that reported a finish time MORE than this far in the future is
   *  considered "still busy with a known ETA": it's held OUT of Up Next (shown blue in the roster)
   *  and not re-probed yet. Once its ETA is within this window (≈expired) it becomes eligible for a
   *  mandatory re-check and, if we can't refresh the estimate, surfaces in Up Next. */
  private static ETA_FUTURE_GRACE_MS = 60_000;
  /** Signatures whose background enrichment is currently running, so repeated ticks
   *  never launch a duplicate `claude -p` for the same placeholder item. */
  private enriching = new Set<string>();
  /** ETA Haiku-interpretation: dedup in-flight calls + remember the transcript mtime we last asked
   *  Haiku to distill, so a probe reply that isn't a clean `eta:` line is interpreted at most once
   *  per turn (not re-dispatched every tick while the async call is pending / after it failed). */
  private etaInterpreting = new Set<number>();
  private etaInterpretedAt = new Map<number, number>();
  /** FIX L: the session the operator just opened a terminal on — floated to the top of the
   *  queue (highest organic + ACTIVE_OVER, repositioned in queue()) until they open another.
   *  Single active task at a time. */
  private _activeSessionId: number | null = null;

  setConfig(cfg: FullConfig) {
    this.cfg = cfg;
  }

  /** FIX L: mark the active task (just-opened terminal). null clears it. */
  setActiveSession(id: number | null): void {
    this._activeSessionId = id;
  }
  activeSessionId(): number | null { return this._activeSessionId; }

  /** Run one full pipeline tick over all sessions. Re-entrant calls are skipped so
   *  overlapping timers/IPC never race on inserts. */
  async tick(): Promise<TickResult> {
    if (this.ticking) return { surfaced: 0, hidden: 0, locked: 0, states: {} };
    this.ticking = true;
    try {
      return await this._tick();
    } finally {
      this.ticking = false;
    }
  }

  private async _tick(): Promise<TickResult> {
    const res: TickResult = { surfaced: 0, hidden: 0, locked: 0, states: {} };
    // THE OPERATOR'S HARD RULE — "once it's in Up Next, leave it alone."
    // A session that ALREADY has a pending item is LOCKED: the tick must NEVER re-evaluate it —
    // not its state, not its priority, not its presence in the queue — until the operator acts on
    // it (answer / ack / dismiss / snooze-expire-then-act / complete → it leaves 'pending') or the
    // session is deleted (orphan prune below). This is what stops the focused task from flickering
    // out of Up Next (and the view auto-flipping to another task) the instant its worker writes a
    // byte: we simply DON'T LOOK at sessions that are already in Up Next. The engine only ever
    // (re-)evaluates sessions that are NOT in Up Next, and the moment one becomes ready it is added
    // and then frozen. See HOW_PRIORITIZATION_WORKS.md.
    const lockedSessionIds = new Set<number>(
      (this.db.prepare("SELECT DISTINCT session_id FROM items WHERE status='pending'").all() as Array<{ session_id: number }>)
        .map((r) => r.session_id)
    );
    // THROTTLE cadence for the heavy, non-time-critical phases. Discovery (~950ms wall: scans every
    // transcript, derives meta, maps live panes) + the housekeeping sweeps don't need 5s freshness —
    // running them every tick is what made the event loop stall ~650ms every 5s, so terminal opens
    // landing in that window blocked. Target ~15s; tick 0 always runs them (cold-start populate).
    const tc = this.tickCount++;
    const heavyEvery = this.opts.heavyPhaseEvery ?? Math.max(1, Math.round(15_000 / Math.max(1, this.cfg.tick_interval_ms)));
    const runHeavy = tc % heavyEvery === 0;
    // Keep the cockpit populated with the operator's real, most-recent sessions. (Throttled: a new
    // session / liveness change appears within ~15s, which is imperceptible for the roster.)
    if (this.opts.discover !== false && runHeavy) {
      try {
        await discoverRecentSessions(this.db, this.sessions, this.opts.discoverLimit ?? (Number(process.env.COCKPIT_DISCOVER_LIMIT) || 2000));
        // lazy clean titles + category tags (fire-and-forget; never blocks the tick)
        if (this.opts.enrich !== false) {
          const { generateSessionMetaAsync } = require("./discover");
          void generateSessionMetaAsync(this.db, this.cfg.models.triage);
        }
      } catch (e) {
        /* discovery is best-effort */
      }
    }
    // Scan GitHub PRs (throttled) and surface them as REVIEW_DIFF items.
    if (this.opts.pr !== false && (this.cfg.pr_repos || []).length) {
      const interval = this.opts.prScanIntervalMs ?? 60000;
      if (Date.now() - this.lastPrScan >= interval) {
        this.lastPrScan = Date.now();
        try {
          scanPrs(this.db, this.cfg.pr_repos);
        } catch (e) {
          /* PR scan is best-effort */
        }
      }
    }
    // Detect every session synchronously (cheap, file reads), then surface the ready
    // ones in PARALLEL. Surfacing inserts the card instantly and schedules enrichment
    // in the background, so a freshly-ready session is usable immediately.
    const ready: Array<{ s: SessionRow; state: any; reason: string; view: TranscriptView | null }> = [];
    let _chunk = 0;
    for (const s of allSessions(this.db)) {
      // FIX C: CHUNK the loop — yield to the event loop every 2 sessions so the terminal/diff
      // WS stays smooth THROUGHOUT the tick (main thread never held more than one frame).
      if (++_chunk % 2 === 0) await new Promise<void>((r) => setImmediate(r));
      // PR sessions are always "ready to review" — they don't have a transcript.
      if (s.kind === "pr") {
        res.states["WAITING_INPUT"] = (res.states["WAITING_INPUT"] || 0) + 1;
        await this.surfacePr(s);
        res.surfaced++;
        continue;
      }
      // Plain shell sessions (Ctrl+B c) are attachable but never enter the priority queue.
      if (s.kind === "shell") { res.hidden++; continue; }
      // TEAMMATES (Claude Code team sub-agents) never get their own cards — no surface(), no
      // enrichment, no shutdown_request FYI noise. They render as child rows under one team-group
      // entry (see queue()). Still run the cheap heuristic detect so the child status stays live
      // (busy/waiting/done); skip the Haiku gates — nothing surfaces, so precision doesn't matter.
      if ((s as any).is_teammate) {
        const detected = await this.detect(s);
        res.states[detected.state] = (res.states[detected.state] || 0) + 1;
        setSessionState(this.db, s.id, detected.state);
        // ORPHANED TEAMMATE (2026-06-12: two real-dataloader workers sat 18h at "result:" with ❓
        // up and NEVER surfaced — their team was long dead, and teammate suppression assumes a
        // live lead represents them). When the WHOLE team has been silent past the completeness
        // guarantee, the teammate is nobody's child anymore: treat it as a normal session — its
        // done-report/question goes through the standard gate and reaches the queue.
        const gHours = (this.cfg as any).guarantee_resurface_hours ?? 6;
        let teamQuietMs = detected.msSinceWrite;
        if (gHours > 0 && s.team_name) {
          try {
            for (const o of this.db.prepare("SELECT transcript_path FROM sessions WHERE team_name=? AND id != ?").all(s.team_name, s.id) as any[]) {
              try { teamQuietMs = Math.min(teamQuietMs, Date.now() - require("fs").statSync(o.transcript_path).mtimeMs); } catch {}
            }
          } catch {}
        }
        const orphaned = gHours > 0 && teamQuietMs > gHours * 3600_000;
        if (orphaned !== ((s as any).teammate_orphaned === 1)) {
          try { this.db.prepare("UPDATE sessions SET teammate_orphaned=? WHERE id=?").run(orphaned ? 1 : 0, s.id); } catch {}
        }
        // A teammate is machinery — a Claude Code sub-agent (review-fleet rev-*/tester, supervised
        // worker/worker2). It NEVER gets its own task card or roster row; it is represented ONLY by
        // its one collapsed team-group row (see teamGroups()/queue()). 2026-06-17: a single dead
        // review fleet orphaned 6 sub-agents that each flooded the queue as a raw "You are a worker /
        // Working directory: …" card. The orphaned flag is still tracked (the nightly reaper uses it
        // to archive dead teams), but it no longer surfaces individual cards. Always hidden.
        res.hidden++; continue;
      }
      // LOCKED: already in Up Next → frozen. Don't re-evaluate it (no state change, no re-rank, no
      // supersede). It stays EXACTLY as the operator last saw it until they act on it.
      // Re-evaluating it is precisely what used to flicker it out of Up Next the moment its worker
      // wrote a byte — so we don't.
      //
      // ONE exemption: ETA (lockedEtaTick). An idle session surfaces — and locks — IMMEDIATELY, so a
      // lock that also skips handleEta makes the /eta probe unreachable by construction: eta_probe_at
      // stayed 0 on every session, ever. (The previous fix held idle sessions OUT of Up Next until
      // probed instead — that hid them for up to half an hour and was reverted.) Probing in place
      // never touches the item: it reads the transcript tail and writes only the session's eta_*
      // columns. Only when the session then reports a still-FUTURE finish time do we swap its
      // low-prio idle card for the roster countdown (same scoped pull as the unlocked ETA-hold).
      if (lockedSessionIds.has(s.id)) {
        res.locked++;
        // Babysit pull (mirrors the locked ETA pull below): a surfaced low-prio IDLE card whose
        // pane is now flagged 👶/🕐 is a babysitter we mis-surfaced (or one that flipped to
        // babysitting after surfacing) — take the idle card out. Scoped to state='UNKNOWN' items
        // only; a pending question/done card is never touched.
        if (s.is_live_pane === 1 && this.sessions.paneBabysit(s.pane_id)) {
          try { this.db.prepare("UPDATE items SET status='superseded' WHERE session_id=? AND status='pending' AND state='UNKNOWN'").run(s.id); } catch {}
        }
        await this.lockedEtaTick(s);
        continue;
      }
      const detected = await this.detect(s);
      // INFRA TAGS (operator request): deterministic ec2/gpu chips from REAL infra operation.
      // Runs here — right after detect(), before any state branch / early `continue` — so EVERY
      // session is re-derived (a WORKING/stalled/babysitting session also gets/loses chips), not
      // only the ones that fall through to the surface logic. AUTHORITATIVE: re-derive every scan,
      // dropping stale ec2/gpu and keeping the haiku category tags. (The old block was union-only
      // AND sat past the auto-continue `continue`s, so most sessions kept a stale chip forever once
      // a young tail held the injected CLAUDE.md/MEMORY.md — operator complaint 2026-06-15.)
      if (detected.view && this.infraTagged.get(s.id) !== detected.mtimeMs) {
        this.infraTagged.set(s.id, detected.mtimeMs);
        try {
          const INFRA = new Set(["ec2", "gpu"]);
          const add = infraTags(detected.view.raw);
          let cur: string[] = [];
          try { cur = JSON.parse(s.tags || "[]"); } catch {}
          const kept = cur.filter((x) => !INFRA.has(x));
          const merged = [...kept, ...add];
          const same = merged.length === cur.length && merged.every((x, i) => x === cur[i]);
          if (!same)
            this.db.prepare("UPDATE sessions SET tags=? WHERE id=?").run(JSON.stringify(merged), s.id);
        } catch {}
      }
      // The operator's declared babysit/waiting flag (👶/🕐, babysit.sh / waiting.sh) on this
      // session's live pane: "alive, but only watching its own long job — nothing for you".
      const paneFlag = s.is_live_pane === 1 ? this.sessions.paneBabysit(s.pane_id) : null;
      // AUTO-CONTINUE a session STALLED after a tool call (operator request 2026-06-15: "I have to
      // type 'continue' across many tasks"). pendingToolStall is unambiguous (see transcript.ts):
      // a pending question / done turn / in-flight tool are all excluded, and a session
      // mid-generating the continuation is excluded by the CPU-idle gate here. We send the nudge so
      // stalls self-heal; capped + only while CPU-idle, and surfaced if it can't be revived.
      {
        const ac = this.autoContinueCfg();
        if (ac.enabled && !(s as any).is_teammate && s.is_live_pane === 1 && s.pane_id && !paneFlag &&
            // …and NEVER nudge a pane that is flagged ❓ `input`: an AskUserQuestion isn't written to
            // the transcript, so pendingToolStall sees only the prior tool_result tail and would
            // happily answer a real on-screen question with "continue" (2026-06-17). The flag is the
            // authoritative "claude is asking" signal — defer to the ❓-surface path below.
            !this.sessions.paneInput(s.pane_id) &&
            detected.processAlive && detected.view &&
            // HARD SEMANTIC GUARDS (2026-06-15, operator: "ONLY continue on REAL stalls"): the
            // detector itself must read WORKING — never WAITING_INPUT/DONE/UNKNOWN — so a session
            // waiting on the operator can never be answered with "continue"; and no pending
            // interactive prompt. (pendingToolStall already excludes these by shape — a question is
            // end_turn or an unanswered tool_use, never a tool_result tail — but a tool_result can
            // NEVER follow an unanswered question anyway: a question stops the turn until the
            // operator replies. These guards make that airtight and auditable.)
            detected.state === "WORKING" && !detected.interactivePrompt &&
            pendingToolStall(detected.view)) {
          const now = Date.now();
          const jif = this.cpuJiffiesFor(s.pid, now);
          let tr = this.stallTracker.get(s.id);
          if (!tr || tr.mtime !== detected.mtimeMs) tr = { mtime: detected.mtimeMs, cpuJiffies: null, cpuAt: 0, attempts: 0, lastAttemptAt: 0 };
          let cpuIdle: boolean;
          if (jif == null) cpuIdle = true;                                  // pid-less external pane → can't measure → assume idle
          else if (tr.cpuJiffies == null || now <= tr.cpuAt) cpuIdle = false; // no baseline yet → wait one tick (never nudge mid-stream)
          else cpuIdle = (jif - tr.cpuJiffies) / (((now - tr.cpuAt) / 1000) * 100) < this.gateCpuBusyFrac();
          tr.cpuJiffies = jif; tr.cpuAt = now;
          this.stallTracker.set(s.id, tr);
          const stalled = detected.msSinceWrite >= ac.quietMs && cpuIdle;
          if (stalled && tr.attempts >= ac.maxAttempts) {
            // the nudge didn't revive it — SURFACE (tool_result+alive would otherwise hide forever).
            setSessionState(this.db, s.id, "WAITING_INPUT");
            ready.push({ s, state: "WAITING_INPUT", reason: `stalled after a tool call — auto-continue x${tr.attempts} did not resume it; needs you`, view: detected.view });
            continue;
          }
          if (stalled && now - tr.lastAttemptAt >= ac.retryMs) {
            let sent = false;
            try { sent = this.sessions.sendInput(s, ac.message); } catch {}
            if (sent) { tr.attempts++; tr.lastAttemptAt = now; this.logAutoContinue(s, tr.attempts, detected.msSinceWrite); }
          }
          setSessionState(this.db, s.id, "WORKING"); // handled — keep hidden while we revive it
          res.hidden++;
          continue;
        }
      }
      // DON'T TRUST the heuristic's WORKING verdict — it fires on cheap recency/stop_reason signals
      // and wrongly hides sessions that have actually parked on a question. Let Haiku read the tail
      // and override (async + mtime-cached; this tick uses the last verdict, schedules a re-check).
      let state: any = detected.state;
      let reason = detected.reason;
      // ❓ PANE-FLAG SURFACE (deterministic, outranks EVERYTHING below incl. the gate): Claude
      // Code's own notify hook sets @claude_pane_status=input the moment the session needs the
      // operator. This signal is in-process truth and does not depend on the transcript — the
      // 2026-06-11 incident #2 (session-337 again) was an AskUserQuestion dialog ON SCREEN whose
      // assistant turn was NEVER written to the .jsonl: the tail still ended at the operator's
      // own message, so every transcript-based layer read "operator just replied; assistant is
      // responding ⇒ WORKING" for 73 minutes straight. A pane that says ❓ is asking, full stop.
      const lastTurnR = detected.view?.turns?.[detected.view.turns.length - 1];
      // "Operator just replied" = the THINKING window: the ❓ flag is stale from before the submit
      // (UserPromptSubmit→working hook only reaches sessions started after 2026-06-12; long-lived
      // sessions keep the gap). In that one shape, require 10 min of silence before believing the
      // flag — far past any thinking phase, far inside the unflushed-dialog rescue window (73 min).
      const operatorJustReplied = !!(lastTurnR && lastTurnR.role === "user" && !lastTurnR.isToolResult && lastTurnR.text);
      // FLAG IS UP and not a stale post-submit thinking-window flag.
      const flagUp = s.is_live_pane === 1 && this.sessions.paneInput(s.pane_id) && !!detected.view &&
          (!operatorJustReplied || detected.msSinceWrite >= 10 * 60_000);
      // PERSISTENCE ESCAPE (2026-06-17 incident, sup-server-inference-speed): the notify hooks
      // rewrite @claude_pane_status to `working` on the VERY NEXT PreToolUse and to `done` on Stop —
      // so a flag still reading `input` after the transcript has been quiet a while is a GENUINE
      // unanswered prompt, never a lagging post-answer flag (that self-clears within seconds when
      // claude resumes and fires its first tool call). This rescues the cases the stability double-
      // sample below never settles for: a session that asked then CRASHED mid-dialog (process gone,
      // flag stranded on a now-dead pane) or one crash-looping while a dialog is on screen. The
      // supervisor here asked a destructive-remediation AskUserQuestion, kept crashing
      // (FileNotFoundError ×45 / 120s config hang), never went stable → its question was hidden.
      const flagPersistedQuiet = detected.msSinceWrite >= Engine.PANE_INPUT_TRUST_MS;
      let paneAsking = false;
      // …ONLY for transcript-blind shapes (heuristic WORKING: user-msg-last, tool stall, unflushed
      // dialog). Claude Code fires idle_prompt ~a minute after EVERY completed turn, so a parked
      // self-waiter ("ETA ~40 min, will report when done") also carries ❓ — for a clean end_turn
      // tail the ready-gate below reads the actual content (WAITING_ON_SELF verdict + ETA hold) and
      // must outrank the flag (2026-06-12 incident: eval babysitter with a CORRECT self-wait verdict
      // + parsed 40m ETA kept surfacing top-of-queue on ❓). The persistence escape keeps this same
      // shape gate — it relaxes ONLY the stability double-sample, never the WORKING requirement.
      if (flagUp && detected.state === "WORKING") {
        if (flagPersistedQuiet) {
          // Quiet long enough (≥ PANE_INPUT_TRUST_MS) that any resumed work would already have
          // flipped the flag to `working`/`done` via PreToolUse/Stop → this `input` is a real,
          // unanswered prompt. Surface without the stability sample, which a crash-looping or
          // already-exited asking session never satisfies (2026-06-17 sup-inference incident).
          paneAsking = true;
        } else if (
          // Below the persistence window the flag LAGS reality: it is only rewritten when the next
          // hook fires, so for the seconds after the operator answers, a stale ❓ remains while
          // claude is visibly working again (2026-06-12 false surface: card 6s after the reply,
          // session deep in tool calls). There the flag only counts when the transcript corroborates
          // it — byte-stable + CPU-quiet across the sample gap.
          this.sampler.consider(s.id, { sig: transcriptSig(detected.view!.raw, detected.mtimeMs), cpuJiffies: processTreeJiffies(s.pid, Date.now()), at: Date.now() }, this.gateGapMs(), this.gateCpuBusyFrac()).stable
        ) {
          paneAsking = true;
        }
      }
      if (paneAsking) {
        state = "WAITING_INPUT";
        reason = "claude itself reports it needs input (❓ pane flag from the notify hook)";
      } else {
      // NOTE: there is deliberately NO model consult for heuristic-WORKING sessions (the old
      // "override rescue" was removed as pure waste — measured at ~100 calls/h): once a session is
      // quiet past the 4s recency window, heuristic-WORKING is STRUCTURAL (tool_use/tool_result/
      // user-message tail, or a non-clean stop_reason) and the classifier's own decisive rules
      // return WORKING for every one of those shapes. A genuinely parked question has a clean
      // end_turn tail, which the heuristic already routes through the ready branch below within
      // ~one tick of going quiet. The model only ever earns its cost where the heuristic says
      // "ready" and might be wrong about that.
      if (
        this.opts.enrich !== false &&        // offline/no-model mode → no gate, trust the heuristic
        detected.state !== "WORKING" &&      // heuristic thinks it's ready to surface…
        detected.processAlive && detected.view
        // …but it's ALIVE — so the model must read the tail before it may surface, no matter how
        // long it's been quiet. (Previously only sessions that wrote within surface_verify_window_ms
        // were classified; anything quiet longer surfaced on the cheap text heuristics alone — which
        // is exactly how "kicked off the script, will check back" sessions, quiet for 10+ minutes,
        // landed in the operator's queue as DONE/idle cards. A babysitter's long poll gap and a
        // parked self-waiter are the same shape: the VERDICT, not the clock, decides.) Cost is
        // bounded: verdicts are mtime-cached, so an idle session costs ONE model call per transcript
        // state, ever. The fail-open below keeps a dead model from stranding sessions hidden.
      ) {
        // REVERSE GUARD (the ready-gate, card 288): a session that looks ready but is alive and
        // wrote moments ago may still be STREAMING its reply — the heuristic only saw the last
        // *completed* turn (.jsonl is written per message, not per token). Two layers stop it
        // entering Up Next prematurely:
        //   LAYER 1 (FREE) — double-sample: require the transcript signature AND the process CPU to
        //     be byte-stable/quiet across the gap. Any motion ⇒ still streaming ⇒ stay hidden, with
        //     NO model call. This is the cheap catch for "is it still outputting tokens?".
        //   LAYER 2 (model) — only a STABLE candidate is read by the model, which also catches the
        //     WAITING_ON_SELF case (stopped generating but blocked on its own script → stay hidden).
        // The defer self-bounds two ways: a finished session stops writing + burning CPU, goes
        // stable, and surfaces on its verdict; if the MODEL is down, the fail-open below surfaces
        // the stable heuristic state after gateFailOpenAttempts() failed checks.
        const now = Date.now();
        const cur = { sig: transcriptSig(detected.view.raw, detected.mtimeMs), cpuJiffies: processTreeJiffies(s.pid, now), at: now };
        const stab = this.sampler.consider(s.id, cur, this.gateGapMs(), this.gateCpuBusyFrac());
        if (detected.interactivePrompt) {
          // DETERMINISTIC SURFACE (the pending-question guarantee): the model is NOT consulted —
          // a stochastic verdict must never hide a session that is literally asking.
          // PENDING QUESTION + STILL WORKING (2026-06-11 incident #3): a session can keep doing
          // background work AFTER asking — sibling tools running, text streaming — and the
          // double-sample then never goes stable, so putting the stability check first hid the
          // question for as long as the work continued. A pending AskUserQuestion/ExitPlanMode is
          // mechanical truth (id-matched, unanswered) no matter what else is moving: the operator
          // is being asked NOW. Surface it BEFORE the stability gate, not after.
        } else if (!stab.stable) {
          state = "WORKING";                 // still moving (tokens or CPU) → keep it out of Up Next
          reason = `deferred (double-sample): ${stab.reason}`;
        } else if (!this.classifierEnabled()) {
          // Stable across the gap and the model gate is OFF → trust the heuristic-ready state as-is.
        } else {
          const v = this.consultWorkVerdict(s, detected);
          const selfTtlMs = this.gateSelfWaitTtlMs();
          if (v?.working && v.activity === "WAITING_ON_SELF" && selfTtlMs > 0 && detected.msSinceWrite > selfTtlMs) {
            // SELF-WAIT TTL: hidden-because-waiting-on-its-own-job is only honored while the wait is
            // plausibly live. Past the TTL of total silence the job may have finished without waking
            // the session — surface as low-prio IDLE so nothing rots hidden forever (the ETA probe
            // can then re-hold it with a concrete "~Xm left" if the job really is still going).
            state = "UNKNOWN";
            reason = `self-wait quiet > ${Math.round(selfTtlMs / 60000)}m — surfacing as idle (${v.reason})`;
          } else if (v?.working) {
            state = "WORKING";               // confirmed mid-stream / self-blocked → keep hidden
            reason = v.activity === "WAITING_ON_SELF"
              ? `verified waiting-on-self: ${v.reason}`
              : `verified streaming: ${v.reason}`;
          } else if (v) {
            state = v.state;                 // confirmed stopped → adopt the verdict's ready-state
            reason = `verified: ${v.reason}`;
          } else if ((this.verifyFailures.get(s.id) || 0) >= this.gateFailOpenAttempts()) {
            // FAIL-OPEN: the classifier has errored/timed out repeatedly for THIS session while it
            // sat stable. Without the old time-window self-bound, deferring forever would strand a
            // genuinely-ready session behind a down model — so trust the stable heuristic state.
            reason = `${detected.reason} (classifier fail-open after ${this.verifyFailures.get(s.id)} failed checks)`;
          } else {
            state = "WORKING";               // verdict pending → defer one tick (conservative)
            reason = "deferred: awaiting streaming-check before surfacing";
          }
        }
      }
      }
      res.states[state] = (res.states[state] || 0) + 1;
      setSessionState(this.db, s.id, state);

      // ETA: parse any reported time-left, and probe parked-but-quiet sessions. Decoupled from
      // surfacing — a running/babysitting session never enters Up Next, but its ETA shows in the
      // sessions panel next to "X ago". Cheap; never blocks (probe is fire-and-forget).
      try { this.handleEta(s, detected, state); } catch {}

      // FIX W (operator policy): surface EVERYTHING that isn't actively WORKING — WAITING_INPUT,
      // DONE, AND idle/UNKNOWN (at low prio) — so Up Next is complete. Only a session actively
      // running a tool / mid-generation (WORKING, now Haiku-confirmed), or one with no transcript
      // at all, stays hidden.
      //
      // ETA HOLD: an idle (UNKNOWN) session that reported a still-FUTURE finish time via /eta is a
      // long-running background job we already know about — it's accounted for. Hold it OUT of Up
      // Next (it shows blue "~Xm left" in the roster, never vanishes) until its ETA window expires;
      // at that point handleEta re-checks, and if it can't refresh the estimate the session falls
      // through here and surfaces — so a never-completing babysit ALWAYS resurfaces. We only ever
      // hold a genuinely IDLE session this way; a WAITING_INPUT/DONE session surfaces regardless of
      // any ETA (a question always reaches the operator).
      const etaAtMs = s.eta_at ? (Date.parse(s.eta_at.includes("T") ? s.eta_at : s.eta_at.replace(" ", "T") + "Z") || 0) : 0;
      const etaHold = state === "UNKNOWN" && etaAtMs > Date.now() + Engine.ETA_FUTURE_GRACE_MS;
      // BABYSIT HOLD (operator policy, same shape as the ETA hold): an idle session whose pane is
      // flagged 👶/🕐 is by declaration watching its own job — keep it OUT of Up Next. Scoped to
      // idle (UNKNOWN) only: a question always reaches the operator, and a DONE state has already
      // been Haiku-confirmed as genuinely-finished by the gate above (a flagged session's "done"
      // poll reports classify WAITING_ON_SELF → WORKING → hidden). Self-healing: the flag clears
      // via babysit.sh off / pane death (is_live_pane reset), and a real completion surfaces as DONE.
      const flagHold = state === "UNKNOWN" && !!paneFlag;
      const surfaceable = state !== "WORKING" && !!detected.view && !etaHold && !flagHold;
      if (!surfaceable) {
        res.hidden++;
        // ETA-hold pull: if a now-busy session had already surfaced as a low-prio IDLE item, take
        // that idle item out of Up Next (we now know it's working with a known ETA). Scoped to
        // state='UNKNOWN' items only — never pulls a pending question/done card, and never touches a
        // decided/dismissed item (those leave Up Next solely by operator action / fresh activity).
        if (etaHold || flagHold) {
          try { this.db.prepare("UPDATE items SET status='superseded' WHERE session_id=? AND status='pending' AND state='UNKNOWN'").run(s.id); } catch {}
        }
        // Otherwise NO STALE PRUNE: a session that reaches this point is NOT in Up Next (locked
        // sessions were skipped above), so it has no pending item to prune. We must NOT pull a
        // session out of Up Next just because it flickered to WORKING — that auto-flip is exactly
        // the bug the lock fixes. A pending item only ever leaves Up Next when the operator acts.
        continue;
      }
      ready.push({ s, state, reason, view: detected.view });
    }
    await Promise.all(ready.map((r) => this.surface(r.s, r.state, r.reason, r.view)));
    res.surfaced += ready.length;

    // ORPHAN PRUNE: pending items whose session no longer exists (removed/cleaned).
    try {
      this.db.prepare("UPDATE items SET status='superseded' WHERE status='pending' AND session_id NOT IN (SELECT id FROM sessions)").run();
    } catch {}
    // TEAMMATE PRUNE: heal items surfaced for teammate sessions before they were marked (the
    // "shutdown request from team-lead" FYI noise). Going forward the teammate skip above prevents
    // new ones; this clears any that already slipped in.
    try {
      this.db.prepare("UPDATE items SET status='superseded' WHERE status='pending' AND session_id IN (SELECT id FROM sessions WHERE is_teammate=1)").run();
    } catch {}

    // SNOOZE DECAY + STALE-DISMISS SWEEP: housekeeping that re-scores snoozed items and reopens
    // dismissed-but-still-waiting cards. THROTTLED with discovery (~15s) — their timescales are
    // minutes (snooze recovery is linear; the stale-dismiss grace is 15 min), so 5s freshness buys
    // nothing and the two together were ~290ms of synchronous event-loop block every tick.
    if (runHeavy) {
      // SNOOZE DECAY: re-score (only) snoozed items so their penalty's linear recovery actually
      // reaches the cached priorities — see snoozeDecayTick for why this exemption from the
      // Stage-0 lock is sanctioned and how it's scoped.
      try { this.snoozeDecayTick(); } catch {}

      // STALE-DISMISS SWEEP: a dismissed card that's still genuinely waiting/stuck must come back —
      // the surface() reopen path is unreachable for heuristic-WORKING sessions, so do it here for
      // ALL decided cards regardless of state. (2026-06-15: 6 sessions sat dismissed-but-waiting for
      // 30min–2.6h, invisible.) Best-effort, never blocks the tick.
      try { await this.staleDismissSweep(); } catch {}
    }

    // Kanban backfill: if too few real Claude work items are ready, top up from the board.
    if (this.opts.kanban !== false) {
      try {
        await this.backfillKanban();
      } catch (e) {
        /* backfill is best-effort */
      }
    }
    return res;
  }

  /** Count ready (pending, un-snoozed) NON-kanban items — i.e. real Claude work AND PR tasks.
   *  Everything already in the queue (Claude + PR) counts toward min_active_tasks; kanban cards
   *  are the *fill* that tops the queue up to that target, so they're excluded from the count
   *  here (counting them would make backfill self-referential and flap-prune every tick). */
  private readyNonKanbanCount(): number {
    const rows = this.db
      .prepare(
        `SELECT COUNT(*) c FROM items i JOIN sessions s ON s.id=i.session_id
         WHERE i.status='pending' AND (i.snooze_until IS NULL OR i.snooze_until < datetime('now'))
           AND s.kind != 'kanban'`
      )
      .get() as { c: number };
    return rows.c;
  }

  /** Surface top kanban cards as items only enough to reach min_active_tasks. */
  /** STALE-DISMISS SWEEP — the completeness invariant for DISMISSED cards, made universal.
   *  A dismissed/decided card only reopened on fresh transcript writes (FIX-P) or the 6h backstop
   *  inside surface() — but a parked session writes nothing, and heuristic-WORKING sessions
   *  (tool-stall, stale self-wait verdict) never reach surface() at all. So a dismissed-but-still-
   *  needs-me session rotted for hours. This runs every tick over EVERY decided card and reopens:
   *    - one whose session is STILL waiting on the operator (detect → WAITING_INPUT) past
   *      dismiss_reopen_grace_min (default 15) — a real question is never lost to a dismiss; and
   *    - any decided card quiet past guarantee_resurface_hours (the universal backstop, now
   *      reachable in EVERY state).
   *  Skips live-team teammates, future-ETA (countdown accounts for it), and dead/shell sessions.
   *  An actively-working dismissed session never reopens (working ⇒ not WAITING_INPUT, and the
   *  backstop needs hours of silence). */
  private async staleDismissSweep(): Promise<void> {
    const graceMs = ((this.cfg as any).dismiss_reopen_grace_min ?? 15) * 60_000;
    const backstopMs = ((this.cfg as any).guarantee_resurface_hours ?? 6) * 3_600_000;
    if (graceMs <= 0 && backstopMs <= 0) return;
    const now = Date.now();
    let rows: any[] = [];
    try {
      rows = this.db.prepare(
        `SELECT i.id AS i_id, i.dismissed_at, i.updated_at, i.importance, i.category, s.*
         FROM items i JOIN sessions s ON s.id = i.session_id
         WHERE i.status = 'decided' AND s.kind = 'claude' AND s.completed_at IS NULL
           -- ONLY the session's CURRENT card (its newest item). A session accumulates one decided
           -- item per dismissed turn over its life; reopening the old ones minted a duplicate card
           -- per past turn (2026-06-15: #461 → 7 identical cards). Newest-only = one card per session.
           AND i.id = (SELECT MAX(id) FROM items WHERE session_id = i.session_id)
           -- and never add a second pending card if one already exists.
           AND NOT EXISTS (SELECT 1 FROM items p WHERE p.session_id = i.session_id AND p.status = 'pending')`
      ).all() as any[];
    } catch { return; }
    for (const r of rows) {
      try {
        if (r.is_teammate) continue; // teammates never get individual cards — only team-group rows
        if (r.eta_at && Date.parse(r.eta_at) > now) continue;
        if (!(this.sessions.processAlive(r) || r.is_live_pane === 1)) continue;
        const tPath = this.sessions.transcriptFor(r);
        if (!tPath) continue;
        let mtime = 0; let view: TranscriptView | null = null;
        try { mtime = fs.statSync(tPath).mtimeMs; view = await parseTranscriptTail(tPath, mtime); } catch { continue; }
        if (!view) continue;
        const det = detectState({ view, processAlive: true, msSinceWrite: now - mtime, quietPeriodMs: this.cfg.triage.quiet_period_ms });
        const ds = String(r.dismissed_at || r.updated_at || "");
        const decidedAtMs = Date.parse(ds.includes("T") ? ds : ds.replace(" ", "T") + "Z") || 0;
        const stillAsking = graceMs > 0 && det.state === "WAITING_INPUT" && now - decidedAtMs > graceMs;
        const quietPastBackstop = backstopMs > 0 && now - Math.max(decidedAtMs, mtime) > backstopMs;
        if (!stillAsking && !quietPastBackstop) continue;
        const reopenState = det.state === "WORKING" ? "WAITING_INPUT" : det.state; // a stuck WORKING card → show as needs-you
        const cat = (r.category as TriageCategory) || "COMPLEX_DECISION";
        const { score, explain } = this.scoreFor(r, cat, reopenState, r.importance ?? -1, 0, view.lastAssistant?.text || "");
        this.db.prepare(
          `UPDATE items SET status='pending', decision=NULL, dismissed_at=NULL, state=?, priority=?, priority_explain=?, updated_at=datetime('now') WHERE id=?`
        ).run(reopenState, score, explain, r.i_id);
      } catch { /* per-row best-effort */ }
    }
  }

  private async backfillKanban(): Promise<void> {
    const need = Math.max(0, this.cfg.min_active_tasks - this.readyNonKanbanCount());
    if (need <= 0) {
      pruneKanban(this.db, new Set()); // nothing needed -> drop any stale kanban items
      return;
    }
    const cards = listKanbanCards(this.cfg.kanban_path, this.cfg.kanban_column_order);
    const chosen = cards.slice(0, need);
    const keep = new Set(chosen.map((c) => c.key));
    pruneKanban(this.db, keep);
    for (const card of chosen) await this.surfaceKanban(card);
    // AUTO-LAUNCH: at most ONE card per tick AND per cooldown window (anti-stampede).
    await this.maybeAutoLaunchKanban(chosen);
  }

  /**
   * Engine-side auto-launch (card 291). When below threshold, launch the single top
   * surfaced card — but only if the cooldown has elapsed, and at most ONE per tick.
   * The cooldown is LOAD-BEARING: readyClaudeCount() lags (a freshly launched session
   * isn't a ready 'claude' item for seconds-to-minutes), so without it the queue still
   * reads low and we'd stampede many sessions. EVERY card auto-launches — #-ready,
   * NEEDS-INFO, H — classification only shapes the prompt (open questions are passed
   * along); the launched Claude looks things up itself and asks the operator in-session
   * for whatever it can't resolve.
   */
  private async maybeAutoLaunchKanban(chosen: KanbanCard[]): Promise<void> {
    if (!this.cfg.kanban_auto_launch) return;
    // Cooldown gate (anti-stampede).
    const cooldownMs = Math.max(0, this.cfg.kanban_auto_cooldown_min) * 60_000;
    const last = Number(getMeta(this.db, "last_auto_launch_at") || 0);
    const now = this.nowMs();
    if (last && now - last < cooldownMs) return;
    // `chosen` is ordered best-first, so the first still-pending card is the top one.
    for (const card of chosen) {
      const session = this.db
        .prepare("SELECT * FROM sessions WHERE worktree_path=? AND kind='kanban'")
        .get(card.key) as unknown as SessionRow | undefined;
      if (!session) continue;
      const item = this.db.prepare("SELECT status FROM items WHERE session_id=?").get(session.id) as { status: string } | undefined;
      if (!item || item.status !== "pending") continue; // already launched / not surfaced → skip
      // This is the single top startable candidate. CONSUME the cooldown window on the ATTEMPT, before
      // launching — so even a FAILED launch (e.g. the worktree/branch already exists) can't be retried
      // every 5s tick. That retry-on-failure was the 2026-06-10 stampede (launches with no cooldown stamp).
      setMeta(this.db, "last_auto_launch_at", String(now));
      this.launchKanbanCard(session);
      break; // ONE launch attempt per tick AND per cooldown window
    }
  }

  /**
   * Launch a real Claude session for a kanban card (the factored body of
   * controller.kanbanStart, callable from the engine for auto-launch). Marks the card's
   * queue item decided. Returns the new session id, or null on failure. Never called in
   * demo (backfill is gated on opts.kanban !== false, which demo disables).
   */
  launchKanbanCard(session: SessionRow): number | null {
    try {
      const prompt = kanbanLaunchPrompt(session as any);
      // skipPermissions: the session runs /work unattended, like a Ctrl+G i quick prompt.
      const newId = this.sessions.launch({ repo: this.cfg.kanban_repo, title: session.title, prompt, skipPermissions: true });
      // Pin the CARD TITLE as the authoritative name (TASK_TAG_TITLED sentinel): discovery's
      // prompt-derived titling would otherwise rename the card to the raw /work prompt text.
      try {
        const { TASK_TAG_TITLED } = require("./discover");
        this.db.prepare("UPDATE sessions SET clean_title=?, meta_gen_prompts=? WHERE id=?").run(session.title, TASK_TAG_TITLED, newId);
      } catch {}
      // the card item is consumed; the launched session becomes a normal tracked one
      this.db.prepare("UPDATE items SET status='decided', decision='started', updated_at=datetime('now') WHERE session_id=?").run(session.id);
      return newId;
    } catch {
      return null;
    }
  }

  private async surfaceKanban(card: KanbanCard): Promise<void> {
    const sid = upsertKanban(this.db, { key: card.key, title: card.title, file: card.fullPath, column: card.column });
    const session = getSession(this.db, sid)!;

    // classify once (cached on the session); '#'-ready cards skip the LLM.
    // H (human-required) cards get NO special-casing: they classify, start, and
    // auto-launch like any other card — the H flag is informational only.
    // (=== 2 reclassifies rows blocked by the old never-startable H gate.)
    if (session.kanban_startable === -1 || session.kanban_startable === 2) {
      let cls: { startable: boolean; questions: string[]; fromScratch?: boolean } = { startable: card.aiReady, questions: [] };
      if (!card.aiReady && this.opts.enrich !== false) {
        cls = await classifyKanbanCard(card, this.cfg.models.triage);
      } else if (card.aiReady) {
        cls = { startable: true, questions: [] };
      }
      this.db
        .prepare("UPDATE sessions SET kanban_startable=?, kanban_from_scratch=?, kanban_questions=? WHERE id=?")
        .run(cls.startable ? 1 : 0, cls.fromScratch ? 1 : 0, JSON.stringify(cls.questions || []), sid);
      session.kanban_startable = cls.startable ? 1 : 0;
      session.kanban_from_scratch = cls.fromScratch ? 1 : 0;
      session.kanban_questions = JSON.stringify(cls.questions || []);
    }

    const sig = card.key;
    const existing = this.db.prepare("SELECT * FROM items WHERE signature=?").get(sig) as unknown as ItemRow | undefined;
    const desc = cardDescription(card.body).split("\n").filter(Boolean)[0] || card.title;
    const oneLiner = `${card.column} · c${card.complexity} · ${desc}`.slice(0, 160);
    // kanban items sit below real work: modest priority, ordered by column then file prio.
    const priority = Math.round(30 - card.columnRank * 3 + Math.min(card.priority, 30) * 0.1);
    if (existing) {
      this.db
        .prepare("UPDATE items SET one_liner=?, priority=?, question=?, updated_at=datetime('now') WHERE id=?")
        .run(oneLiner, priority, cardDescription(card.body).slice(0, 4000), existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO items
            (session_id,state,category,category_source,question,one_liner,suggested_answer,diff_summary,changed_lines,importance,importance_reason,answer_options,priority,priority_explain,status,signature)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)
           ON CONFLICT(signature) DO NOTHING`
        )
        .run(
          sid,
          "WAITING_INPUT",
          "KANBAN",
          "kanban",
          cardDescription(card.body).slice(0, 4000),
          oneLiner,
          null,
          null,
          0,
          -1,
          null,
          null,
          priority,
          JSON.stringify({ breakdown: [{ signal: "kanban_backfill", raw: 1, weight: priority, contribution: priority, note: `top-up from ${card.column}` }], learned: [] }),
          sig
        );
    }
  }

  /** Surface a GitHub PR as a REVIEW_DIFF item (no transcript; signature stable per PR). */
  private async surfacePr(s: SessionRow): Promise<void> {
    const sig = `pr:${s.pr_repo}#${s.pr_number}`;
    const existing = this.db.prepare("SELECT * FROM items WHERE signature = ?").get(sig) as unknown as ItemRow | undefined;
    const draft = s.pr_draft ? " (draft)" : "";
    const decision = s.pr_review_decision ? ` · ${s.pr_review_decision.toLowerCase().replace(/_/g, " ")}` : "";
    const oneLiner = `PR #${s.pr_number} by ${s.pr_author || "?"}${draft} · +${s.pr_additions}/-${s.pr_deletions}${decision}`;
    const changed = (s.pr_additions || 0) + (s.pr_deletions || 0);
    const learned = learnedAdjustments(this.db, "REVIEW_DIFF");
    const score = scoreItem({
      weights: this.effectiveWeights(),
      importance: s.manual_importance != null ? -1 : 50, // PRs get a moderate default importance
      manualImportance: s.manual_importance ?? null,
      pinned: !!s.pinned,
      blocksOtherWork: !!s.blocks_other_work,
      changedLines: changed,
      ageHours: 0,
      focusMatch: focusMatch(this.cfg.focus, s.title),
      deadline: null,
      state: "WAITING_INPUT",
      category: "REVIEW_DIFF",
      learnedTerms: learned,
      snoozePenalty: s.snooze_penalty || 0,
      snoozedAt: s.snoozed_at ?? null,
      snoozeRecoverHours: this.cfg.snooze_recover_hours,
      manualPriorityDelta: (s as any).manual_priority_delta || 0, // h/l must survive the per-tick re-surface
    });
    const explain = JSON.stringify({ breakdown: score.breakdown, learned: score.learned });
    // PR floor: an open PR never ranks below pr_min_priority by default — but operator gestures
    // (snooze, h/l, manual score) can take it below; see prFloor().
    const pri = this.prFloor(s, score);
    if (existing) {
      this.db
        .prepare(
          `UPDATE items SET one_liner=?, changed_lines=?, priority=?, priority_explain=?, updated_at=datetime('now') WHERE id=?`
        )
        .run(oneLiner, changed, pri, explain, existing.id);
      // 'superseded' = the session was completed (operator Ctrl+G e or the idle sweep), but this PR
      // is verifiably still open, so re-pend: an open PR must never be silently invisible
      // (pr_min_priority's whole contract). To park an open PR, snooze it ('decided'/'hidden'
      // stay untouched); to get rid of it, merge or close it.
      if (existing.status === "superseded") {
        this.db.prepare(`UPDATE items SET status='pending', updated_at=datetime('now') WHERE id=?`).run(existing.id);
      }
    } else {
      this.db
        .prepare(
          `INSERT INTO items
            (session_id,state,category,category_source,question,one_liner,suggested_answer,diff_summary,changed_lines,importance,importance_reason,priority,priority_explain,status,signature)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)
           ON CONFLICT(signature) DO NOTHING`
        )
        .run(
          s.id,
          "WAITING_INPUT",
          "REVIEW_DIFF",
          "pr",
          s.title,
          oneLiner,
          null,
          null,
          changed,
          50,
          null,
          pri,
          explain,
          sig
        );
    }
  }

  private async detect(s: SessionRow) {
    const tPath = this.sessions.transcriptFor(s);
    let view: TranscriptView | null = null;
    let msSinceWrite = Infinity;
    let mtimeMs = 0;
    if (tPath) {
      try {
        // FIX C: read only the TAIL (~128KB, async, mtime-cached) — state + last message live at
        // the end. Never reads the full 14–21MB transcript on the tick.
        const st = await fs.promises.stat(tPath);
        view = await parseTranscriptTail(tPath, st.mtimeMs);
        msSinceWrite = Date.now() - st.mtimeMs;
        mtimeMs = st.mtimeMs;
      } catch {}
    }
    // THE LIVENESS FIX: discovered external sessions (the operator's real tmux panes) carry NO
    // pid (pid=null) and their tmux session isn't `cockpit-<slug>`, so processAlive() alone is
    // FALSE for all of them — which silently disabled the ENTIRE ready-gate for exactly the
    // sessions the operator cares about: stateDetector's "wrote recently → streaming" check, its
    // mid-turn tool_use/continuation rules, AND the engine's double-sample + Haiku reverse guard
    // are all conditioned on processAlive. Result: a session still outputting tokens surfaced
    // into Up Next. is_live_pane=1 is proof of life — discovery maps a pane only by walking a
    // LIVE claude process (agent pid / open transcript fd) up to its tmux pane, and clearLivePanes
    // resets it the moment that process is gone. (handleEta already used this exact disjunction.)
    const alive = this.sessions.processAlive(s) || s.is_live_pane === 1;
    const d = detectState({
      view,
      processAlive: alive,
      msSinceWrite,
      quietPeriodMs: this.cfg.triage.quiet_period_ms,
    });
    return { ...d, view, msSinceWrite, mtimeMs, processAlive: alive };
  }

  /** Last-activity timestamp in ms: transcript mtime (what "X ago" shows) — the moment Claude or
   *  the operator last wrote — falling back to created_at for rows without a transcript. */
  private lastActivityMs(s: SessionRow): number {
    const tPath = s.transcript_path;
    if (tPath) { try { return fs.statSync(tPath).mtimeMs; } catch {} }
    const fb = s.created_at;
    return fb ? (Date.parse(fb.includes("T") ? fb : fb.replace(" ", "T") + "Z") || 0) : 0;
  }

  /** Throttle for the locked-session ETA pass: each locked session gets at most one
   *  detect+handleEta per this interval, so the lock stays near-zero cost on the tick. Minutes-scale
   *  probe gates don't need finer granularity; the only sub-minute-sensitive step (parsing a probe
   *  reply) still lands within a minute of the answer. */
  private static LOCKED_ETA_TICK_MS = 60_000;
  private lockedEtaCheckedAt = new Map<number, number>();

  /** ETA pass for LOCKED (already-surfaced) sessions — the one exemption from the Up Next freeze.
   *  Without it the /eta probe is unreachable: an idle session surfaces+locks immediately, and the
   *  lock skipped handleEta, so no session was ever probed (and a probe REPLY was never parsed
   *  either). This runs the exact same parse/probe as the unlocked path but never touches the item —
   *  EXCEPT when a still-FUTURE finish time is (or becomes) known: then the session is a long-running
   *  job we've accounted for, so its low-prio idle card is pulled in favor of the roster countdown
   *  (identical scoped pull to the unlocked ETA-hold: state='UNKNOWN' items only — a question/done
   *  card is never touched). When the ETA expires and can't be refreshed, the session surfaces again
   *  via the normal unlocked path, so nothing hides forever. */
  private async lockedEtaTick(s: SessionRow): Promise<void> {
    try {
      const cfg = this.cfg.eta;
      if (!cfg || cfg.enabled === false || s.kind !== "claude") return;
      if (s.state !== "UNKNOWN") return; // only idle cards; WAITING_INPUT/DONE are the operator's
      const now = Date.now();
      if (now - (this.lockedEtaCheckedAt.get(s.id) || 0) < Engine.LOCKED_ETA_TICK_MS) return;
      this.lockedEtaCheckedAt.set(s.id, now);
      // No reachability pre-gate: PARSING a printed `eta:` marker is valid for any session;
      // handleEta itself gates the PROBE on reachability exactly like the unlocked path.
      const detected = await this.detect(s);
      this.handleEta(s, detected, "UNKNOWN");
      // applyEta reflects a parsed marker onto the local row; a Haiku-interpreted reply lands in the
      // DB asynchronously and is seen here on the NEXT pass via the fresh row from allSessions().
      const etaAtMs = s.eta_at ? (Date.parse(s.eta_at.includes("T") ? s.eta_at : s.eta_at.replace(" ", "T") + "Z") || 0) : 0;
      if (etaAtMs > now + Engine.ETA_FUTURE_GRACE_MS) {
        this.db.prepare("UPDATE items SET status='superseded' WHERE session_id=? AND status='pending' AND state='UNKNOWN'").run(s.id);
      }
    } catch {}
  }

  /** THE COMPLETENESS INVARIANT (operator rule): every session is either IN the Task Queue or
   *  carries a live countdown — nothing may rot invisible at "1 day ago". decided/dismissed cards
   *  leave the queue intentionally, but if their session then goes COMPLETELY silent — no new turn
   *  (same signature), no still-future ETA — for guarantee_resurface_hours, the card must reopen:
   *  the answer never took, or the session died right after. Conservative by design: any transcript
   *  write OR a live countdown resets/holds it, and operator-COMPLETED sessions are excluded (those
   *  are archived; the nightly reap owns them). 0 disables. */
  private guaranteeReopenDue(s: SessionRow, anchorMs: number): boolean {
    const hours = (this.cfg as any).guarantee_resurface_hours ?? 6;
    if (!(hours > 0)) return false;
    if ((s as any).completed_at) return false;                          // operator archived it
    if (s.eta_at && Date.parse(s.eta_at) > Date.now()) return false;    // timered = accounted for
    let mtime = 0; try { if (s.transcript_path) mtime = fs.statSync(s.transcript_path).mtimeMs; } catch {}
    return Date.now() - Math.max(anchorMs, mtime) > hours * 3600_000;
  }

  /** ETA tracking for long-running, silent sessions (see eta.ts).
   *  - PARSE (cheap, every tick): read the freshest `eta:` marker the session emitted and store it
   *    as an absolute finish time. Handles both probe replies and proactively-printed markers.
   *  - PASSIVE ESTIMATE (throttled): for a long-running session — actively WORKING, or parked
   *    (UNKNOWN) and quiet at least probe_after_min — read its OWN recent output (tmux pane capture,
   *    else transcript tail) and let Haiku estimate the time left. NOTHING is ever injected into the
   *    session (the old `/eta` keystroke probe is gone), so this safely covers working sessions. */
  private handleEta(
    s: SessionRow,
    detected: { view: TranscriptView | null; mtimeMs: number; processAlive: boolean },
    state: SessionState
  ): void {
    const cfg = this.cfg.eta;
    if (!cfg || cfg.enabled === false || s.kind !== "claude") return;
    const now = Date.now();

    // 1) PARSE — only when the transcript is NEWER than the marker we last recorded, so we don't
    //    re-apply the same line (and don't write the DB) every tick.
    const text = detected.view?.lastAssistant?.text || "";
    if (detected.mtimeMs > (s.eta_mtime || 0)) {
      const parsed = parseEtaMarker(text);
      if (parsed) {
        this.applyEta(s, parsed, detected.mtimeMs, now);
      } else {
        // No clean `eta:` line. If this fresh turn is the session's RESPONSE to a probe we sent
        // (we probed, and it wrote after that), it answered in its own words — hand the reply to
        // Haiku to distill the time-left (async, fire-and-forget, once per turn). This is the
        // "Claude reasons → Haiku reads it → ETA" step; the cheap parser above is the fast path.
        const probedMs = s.eta_probe_at ? Date.parse(s.eta_probe_at) || 0 : 0;
        const isProbeReply = probedMs > 0 && detected.mtimeMs > probedMs && text.trim().length > 0;
        if (isProbeReply && this.opts.enrich !== false) this.scheduleEtaInterpret(s, text, detected.mtimeMs);
      }
    }

    // 2) PASSIVE ESTIMATE — NO keystrokes injected (the old `/eta` probe is gone: it polluted live
    //    sessions and only ever fired into UNKNOWN ones). Instead, for a long-running session — one
    //    actively WORKING, or parked (UNKNOWN) and quiet a while — we READ its OWN recent output (the
    //    live terminal screen, else the transcript tail) and let Haiku distill the time-left. Safe to
    //    run on WORKING sessions precisely because we never type into them — which is exactly the
    //    babysitting-inference / training case the operator cares about.
    if (this.opts.enrich === false) return; // offline → no model
    const quietMin = (now - detected.mtimeMs) / 60000;
    // STALENESS CAP (cost): a session silent for a day has no running job to count down — but we
    // deliberately do NOT gate on processAlive (pid-less discovered panes are real sessions; that
    // contract is pinned by the eta-passive harness test). ~200 ancient sessions × 1 call per
    // reprobe window was a measurable steady drain for countdowns that can never tick.
    if (quietMin > 24 * 60) return;
    const isLongRun = state === "WORKING" || (state === "UNKNOWN" && quietMin >= cfg.probe_after_min);
    if (!isLongRun) return;
    const etaAtMs = s.eta_at ? (Date.parse(s.eta_at) || 0) : 0;
    const etaExpired = etaAtMs > 0 && etaAtMs <= now;
    // A still-FUTURE ETA → don't re-estimate yet; re-check as it approaches expiry.
    if (!etaExpired && etaAtMs > now + Engine.ETA_FUTURE_GRACE_MS) return;
    // Throttle: at most one Haiku estimate per session per reprobe_min (a small floor once an ETA has
    // expired so a fresh estimate is fetched right at expiry). eta_probe_at = last estimate time.
    const reprobeMs = cfg.reprobe_min * 60000;
    const back = this.etaBackoff.get(s.id);
    const mult = back && back.mtime === detected.mtimeMs ? back.mult : 1; // unchanged output → backed-off
    const throttleMs = etaExpired ? Math.min(reprobeMs, 60000) : reprobeMs * mult;
    const lastEstMs = s.eta_probe_at ? Date.parse(s.eta_probe_at) || 0 : 0;
    if (lastEstMs && now - lastEstMs < throttleMs) return;
    this.etaBackoff.set(s.id, { mtime: detected.mtimeMs, mult: Math.min(mult * 2, 8) });
    // Read the session's OWN output (no injection): the live terminal screen (best for progress bars /
    // step counters), falling back to the transcript tail.
    let output = "";
    try { output = this.sessions.capturePane(s, 80) || ""; } catch {}
    if (!output.trim()) output = detected.view?.lastAssistant?.text || "";
    if (!output.trim()) return;
    setSessionEtaProbe(this.db, s.id, new Date(now).toISOString()); // stamp the attempt (throttle)
    this.scheduleEtaEstimate(s, output, detected.mtimeMs);
  }

  /** Async: read a long-running session's OWN output and let Haiku estimate the time-left, then store
   *  it — WITHOUT injecting anything into the session. Fire-and-forget; deduped in-flight. */
  private scheduleEtaEstimate(s: SessionRow, output: string, mtimeMs: number): void {
    if (this.etaInterpreting.has(s.id)) return;
    this.etaInterpreting.add(s.id);
    void (async () => {
      try {
        const parsed = await estimateEtaFromOutput(output, this.cfg.models.triage);
        if (parsed) {
          const fresh = getSession(this.db, s.id);
          if (fresh) this.applyEta(fresh, parsed, mtimeMs, Date.now());
        }
      } catch {
        /* best-effort; the throttle will retry next window */
      } finally {
        this.etaInterpreting.delete(s.id);
      }
    })();
  }

  /** Store a parsed ETA verdict (from the cheap parser OR Haiku) on the session row + local copy.
   *  time → absolute finish; done/none → clear the countdown (returns it to Up Next, never held). */
  private applyEta(s: SessionRow, parsed: { kind: "time" | "done" | "none"; minutes?: number; raw: string }, mtimeMs: number, now: number): void {
    if (parsed.kind === "time" && parsed.minutes != null) {
      const etaAt = new Date(now + parsed.minutes * 60000).toISOString();
      setSessionEta(this.db, s.id, etaAt, parsed.raw.trim(), mtimeMs);
      s.eta_at = etaAt; // reflect locally so THIS tick's surface gate sees the fresh hold
      s.eta_text = parsed.raw.trim();
    } else {
      setSessionEta(this.db, s.id, null, null, mtimeMs);
      s.eta_at = null;
      s.eta_text = null;
    }
    s.eta_mtime = mtimeMs;
  }

  /** Async: let Haiku read a session's free-form probe reply and distill the ETA, then store it.
   *  Fire-and-forget (never blocks the tick); deduped in-flight and bounded to one attempt per
   *  turn-mtime so a reply Haiku can't parse doesn't re-dispatch every 5s. */
  private scheduleEtaInterpret(s: SessionRow, text: string, mtimeMs: number): void {
    if (this.etaInterpreting.has(s.id)) return;
    if (this.etaInterpretedAt.get(s.id) === mtimeMs) return; // already tried for this exact reply
    this.etaInterpreting.add(s.id);
    void (async () => {
      try {
        const parsed = await interpretEta(text, this.cfg.models.triage);
        this.etaInterpretedAt.set(s.id, mtimeMs); // bound to one attempt per turn (success or not)
        if (parsed) {
          const fresh = getSession(this.db, s.id);
          if (fresh) this.applyEta(fresh, parsed, mtimeMs, Date.now());
        }
      } catch {
        this.etaInterpretedAt.set(s.id, mtimeMs);
      } finally {
        this.etaInterpreting.delete(s.id);
      }
    })();
  }

  /** Consult (or schedule) the Haiku working-verdict for a heuristic-WORKING session.
   *  - Returns the cached verdict immediately IF it was judged at the CURRENT transcript mtime
   *    (the session hasn't written since → the verdict still holds → zero new calls).
   *  - Otherwise the verdict is stale/missing: schedule an async re-check (only once the writes
   *    have settled, throttled per session) and return null so THIS tick trusts the heuristic
   *    (stays WORKING — conservative). The next tick picks up the fresh verdict. */
  private consultWorkVerdict(s: SessionRow, detected: { view: TranscriptView | null; mtimeMs: number; msSinceWrite: number }): WorkingVerdict | null {
    if (this.opts.enrich === false || !this.classifierEnabled()) return null; // offline / gate disabled → heuristic only
    const cached = this.workVerdicts.get(s.id);
    if (cached && cached.mtimeMs === detected.mtimeMs) return cached.verdict; // fresh for this exact transcript state
    // RESTART CACHE: the verdict survives in the sessions row — same transcript state, same verdict,
    // zero calls. (Each deploy used to re-buy every parked session's classification: ~$2/restart.)
    if (!cached && s.verdict_mtime === detected.mtimeMs && s.verdict_activity && (s as any).verdict_rev === VERDICT_REV) {
      const v = mapActivity(s.verdict_activity as ActivityClass, s.verdict_reason || "persisted verdict");
      this.workVerdicts.set(s.id, { mtimeMs: detected.mtimeMs, verdict: v, at: Date.now() });
      return v;
    }
    const settled = detected.msSinceWrite >= this.gateSettleMs();
    const due = !cached || Date.now() - cached.at >= this.gateMinIntervalMs();
    if (settled && due && detected.view) this.scheduleWorkVerify(s, detected.view, detected.mtimeMs);
    return null;
  }

  /** Fire-and-forget Haiku check; stores the verdict against the mtime it judged. Never blocks. */
  private scheduleWorkVerify(s: SessionRow, view: TranscriptView, mtimeMs: number): void {
    if (this.verifyingWork.has(s.id)) return; // a check is already in flight
    this.verifyingWork.add(s.id);
    const prev = this.workVerdicts.get(s.id);
    void (async () => {
      try {
        const v = await verifyWorking(view, this.gateModel());
        if (v) {
          this.workVerdicts.set(s.id, { mtimeMs, verdict: v, at: Date.now() });
          try { setSessionVerdict(this.db, s.id, mtimeMs, v.activity, v.reason, VERDICT_REV); } catch {} // survive restarts
          // Verdict-ETA: the tail often STATES its own time estimate ("ETA ~40 min", "another 2h").
          // The classifier extracts it in the same call (zero extra cost); a self-waiting session
          // then shows the blue "~Xm left" roster countdown instead of nagging the queue, and the
          // existing ETA machinery guarantees it resurfaces when the countdown expires.
          if (v.working && v.etaMinutes && v.etaMinutes > 0) {
            const mins = Math.min(v.etaMinutes, 24 * 60);
            try { setSessionEta(this.db, s.id, new Date(Date.now() + mins * 60000).toISOString(), `${mins}m`, mtimeMs); } catch {}
          }
          this.verifyFailures.delete(s.id); // a verdict landed — reset the fail-open counter
        } else {
          this.verifyFailures.set(s.id, (this.verifyFailures.get(s.id) || 0) + 1);
          if (prev) this.workVerdicts.set(s.id, { ...prev, at: Date.now() }); // bump throttle on failure
        }
      } catch {
        this.verifyFailures.set(s.id, (this.verifyFailures.get(s.id) || 0) + 1);
        if (prev) this.workVerdicts.set(s.id, { ...prev, at: Date.now() });
      } finally {
        this.verifyingWork.delete(s.id);
      }
    })();
  }

  /** Effective weights = operator's base weights (weights.json) + the nightly-learned
   *  deltas. Kept transparent — the inspector shows base + delta side by side. */
  effectiveWeights() {
    const base: any = this.cfg.weights;
    const learned = getLearnedWeights(this.db);
    const out: any = { ...base };
    for (const k of Object.keys(out)) if (learned[k]) out[k] = base[k] + learned[k];
    return out;
  }

  /** Compute the transparent score + explain JSON for an item. */
  private scoreFor(
    s: SessionRow,
    category: TriageCategory,
    state: any,
    importance: number,
    changedLines: number,
    questionText: string
  ): { score: number; explain: string } {
    // ALWAYS score from the LIVE session row. `s` is often a snapshot taken at the start of a
    // multi-second tick; a quick action landing mid-tick (unpin, importance, snooze) would
    // otherwise be overwritten with a score computed from the stale flags — and since the
    // Stage-0 lock then freezes the item, a stale +PIN_BASE score would stick forever.
    const live = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(s.id) as unknown as SessionRow | undefined;
    if (live) s = live;
    // Staleness = time since LAST ACTIVITY (transcript mtime — the "X ago" the operator sees),
    // not since the session was created. A task that's been worked on minutes ago isn't stale even
    // if it was opened days ago; a long-untouched one is. Falls back to created_at when there's no
    // transcript (kanban / output-less rows).
    const laMs = this.lastActivityMs(s);
    const ageHours = laMs ? (Date.now() - laMs) / 3.6e6 : 0;
    const fm = focusMatch(this.cfg.focus, `${s.title} ${questionText}`);
    const learned = learnedAdjustments(this.db, category);
    const score = scoreItem({
      weights: this.effectiveWeights(),
      importance,
      manualImportance: s.manual_importance ?? null,
      pinned: !!s.pinned,
      blocksOtherWork: !!s.blocks_other_work,
      changedLines,
      ageHours: Math.max(0, ageHours),
      focusMatch: fm,
      deadline: s.deadline,
      state,
      category,
      learnedTerms: learned,
      snoozePenalty: s.snooze_penalty || 0,
      snoozedAt: s.snoozed_at ?? null,
      snoozeRecoverHours: this.cfg.snooze_recover_hours,
      manualPriorityDelta: (s as any).manual_priority_delta || 0, // FIX BB: per-item h/l offset
      active: this._activeSessionId === s.id, // FIX L: just-opened terminal → boost to top
    });
    // PR floor: a session that has an open PR (kind='pr', or a working session the scan tagged
    // with a PR) gets its ORGANIC score floored at pr_min_priority — operator gestures (snooze,
    // h/l, manual score) apply after the floor and can rank it lower; see prFloor().
    const floored = this.prFloor(s, score);
    return { score: floored, explain: JSON.stringify({ breakdown: score.breakdown, learned: score.learned }) };
  }

  /** PR floor with an operator escape hatch. The ORGANIC score of a PR-backed item never ranks
   *  below pr_min_priority (an open PR is always plainly visible by default), but explicit
   *  operator gestures apply AFTER the floor: snoozing or an h/l lower takes the PR below it
   *  (the snooze decays back up to the floored score, not the unfloored one), and a manual
   *  score (set-importance) is absolute — never floored back up. */
  private prFloor(s: SessionRow, score: ScoreResult): number {
    const raw = Math.round(score.score);
    if (s.pr_number == null) return raw;
    if (s.manual_importance != null && s.manual_importance >= 0) return raw; // operator's number is exact (mirror scoreItem's override guard)
    const gestures = score.breakdown
      .filter((t) => t.signal === "snoozed" || t.signal === "manual_priority")
      .reduce((a, t) => a + t.contribution, 0);
    const organic = score.score - gestures;
    return Math.round(Math.max(organic, this.cfg.pr_min_priority ?? 30) + gestures);
  }

  private async surface(
    s: SessionRow,
    state: "WAITING_INPUT" | "DONE" | any,
    reason: string,
    view: TranscriptView | null
  ): Promise<void> {
    const questionText = view?.lastAssistant?.text || "";
    const sig = turnSignature(s.id, view?.lastAssistant || null);

    // Dedup: if we already have an item for this exact ready turn, only re-rank it.
    const existing = this.db
      .prepare("SELECT * FROM items WHERE signature = ?")
      .get(sig) as unknown as ItemRow | undefined;

    // "What you last asked" — shown verbatim on the card. The hot tick only parses the 128KB tail,
    // so once Claude has done >128KB of tool-call work the operator's LATEST prompt scrolls out of
    // that window and view.lastUserPrompt goes null. Recover it WITHOUT going stale:
    //   1. the fresh tail value when present (it's the latest, by definition);
    //   2. else what we already stored for THIS SAME ready turn (existing.last_prompt — same
    //      signature ⇒ same turn, so it can never be an older request);
    //   3. else, on a brand-new turn whose prompt isn't in the tail, a one-time deep scan that
    //      reads back far enough to find the TRUE latest prompt (cached into the item below, so it
    //      runs at most once per turn — the next tick takes step 2).
    // We must NOT fall back to a *previous item's* prompt (an OLDER turn): that was the bug where
    // "You asked" showed a stale, earlier request whenever Claude's work pushed the newest prompt
    // out of the 128KB tail — the operator's most recent prompt should always win.
    let lastPrompt = view?.lastUserPrompt?.text || existing?.last_prompt || "";
    if (!lastPrompt && s.transcript_path) {
      try { lastPrompt = await findLastUserPromptDeep(s.transcript_path); } catch {}
    }

    let diffInfo = { changedLines: 0, stat: "", patch: "" };
    try {
      const d = await worktreeDiff(s.worktree_path);
      diffInfo = { changedLines: d.changedLines, stat: d.stat, patch: d.patch };
    } catch {}

    if (existing) {
      // ASKING REOPEN: the operator dealt with this turn's card (answered OR dismissed) but the
      // session is STILL asking — a question dialog is physically on screen blocking it. Two
      // sources, both meaning "a live prompt is up, dismissing it does NOT make it go away":
      //   - the ❓ notify-hook pane flag (incident #2, session-337: the asking turn may never
      //     reach the .jsonl, so the signature can't change);
      //   - a transcript-detected pending AskUserQuestion/ExitPlanMode (2026-06-15, session-475:
      //     the question card was dismissed 17s after surfacing while the dialog stayed open — a
      //     dismissed card only reopens on FRESH writes, but a blocking dialog produces none, so
      //     it stayed hidden ~48 min until a restart resolved it). A pending dialog is not
      //     "handle-for-now"-able: keep surfacing it until it is actually answered (tool_result).
      // 3-min grace prevents answer→reopen ping-pong while the result lands.
      const askingNow = state === "WAITING_INPUT" && (/❓ pane flag/.test(reason) || (!!view && !!pendingInteractivePrompt(view)));
      if (existing.status === "decided" && askingNow) {
        const decidedAtMs = Date.parse(String(existing.updated_at || "").replace(" ", "T") + "Z") || 0;
        if (Date.now() - decidedAtMs > 3 * 60_000) {
          const importance = existing.importance ?? -1;
          const cat = existing.category || "COMPLEX_DECISION";
          const { score, explain } = this.scoreFor(s, cat as any, state, importance, diffInfo.changedLines, questionText);
          this.db
            .prepare(
              `UPDATE items SET status='pending', decision=NULL, dismissed_at=NULL, state=?, priority=?, priority_explain=?, changed_lines=?, updated_at=datetime('now') WHERE id=?`
            )
            .run(state, score, explain, diffInfo.changedLines, existing.id);
          return;
        }
      }
      // FIX P: a DISMISSED item ("Ctrl+G Enter — handled for now", decision='done') is a
      // SNOOZE-UNTIL-READY, not permanent. RE-SURFACE it the moment the session shows FRESH
      // activity AFTER the dismiss — i.e. the LLM did more work / is waiting again on something
      // the operator hasn't resolved since dismissing. "Fresh activity" = the transcript was
      // written after the dismiss timestamp (dismissed_at, which re-rank does NOT bump).
      const dismissed = existing.status === "decided" && existing.decision === "done" && !!(existing as any).dismissed_at;
      if (dismissed) {
        const dismissAt = Date.parse((existing as any).dismissed_at as string) || 0; // ISO ms precision
        let mtime = 0; try { mtime = require("fs").statSync(s.transcript_path).mtimeMs; } catch {}
        if (mtime > dismissAt + 250) {
          // RE-OPEN to pending → back in Up Next (keep prior enrichment/category).
          const importance = existing.importance ?? -1;
          const cat = existing.category || (state === "DONE" ? "FYI_DONE" : "COMPLEX_DECISION");
          const { score, explain } = this.scoreFor(s, cat as any, state, importance, diffInfo.changedLines, questionText);
          this.db
            .prepare(
              `UPDATE items SET status='pending', decision=NULL, dismissed_at=NULL, state=?, priority=?, priority_explain=?, changed_lines=?, updated_at=datetime('now') WHERE id=?`
            )
            .run(state, score, explain, diffInfo.changedLines, existing.id);
          return;
        }
        // Still dismissed with no fresh activity → normally stays hidden (handled-for-now holds) —
        // UNLESS it has now been silent past the completeness guarantee: a babysit dismissed and
        // then dead-quiet for hours is exactly the "1 day ago, in neither queue nor timer" rot.
        if (this.guaranteeReopenDue(s, dismissAt)) {
          const importance = existing.importance ?? -1;
          const cat = existing.category || (state === "DONE" ? "FYI_DONE" : "COMPLEX_DECISION");
          const { score, explain } = this.scoreFor(s, cat as any, state, importance, diffInfo.changedLines, questionText);
          this.db
            .prepare(
              `UPDATE items SET status='pending', decision=NULL, dismissed_at=NULL, state=?, priority=?, priority_explain=?, changed_lines=?, updated_at=datetime('now') WHERE id=?`
            )
            .run(state, score, explain, diffInfo.changedLines, existing.id);
          return;
        }
        return;
      }
      // Other decided items (answered/ack/completed) stay decided — don't resurrect them on this
      // same turn — UNLESS the session then went completely silent past the completeness guarantee:
      // an ANSWERED card whose session never wrote another byte means the answer never reached it
      // (dead pane, lost keystrokes) — surface it again rather than let it vanish forever.
      if (existing.status === "decided") {
        const decidedAt = Date.parse(String(existing.updated_at || "").replace(" ", "T") + "Z") || 0; // sqlite datetime('now') is UTC
        if (this.guaranteeReopenDue(s, decidedAt)) {
          const importance = existing.importance ?? -1;
          const cat = existing.category || (state === "DONE" ? "FYI_DONE" : "COMPLEX_DECISION");
          const { score, explain } = this.scoreFor(s, cat as any, state, importance, diffInfo.changedLines, questionText);
          this.db
            .prepare(
              `UPDATE items SET status='pending', decision=NULL, dismissed_at=NULL, state=?, priority=?, priority_explain=?, changed_lines=?, updated_at=datetime('now') WHERE id=?`
            )
            .run(state, score, explain, diffInfo.changedLines, existing.id);
        }
        return;
      }
      if (existing.category) {
        // Re-rank only; keep prior enrichment (don't pay for Claude twice).
        const importance = existing.importance ?? -1;
        const { score, explain } = this.scoreFor(s, existing.category, state, importance, diffInfo.changedLines, questionText);
        // RESTORE: a session that flickered to WORKING got its card superseded (FIX, see _tick);
        // now that it's ready again on the SAME turn, put it BACK in Up Next. Only 'pending' and
        // 'superseded' reach here ('decided' returned above), so forcing 'pending' is the intended
        // "re-surface the moment it goes idle/ready again" — it was pulled, never restored.
        this.db
          .prepare(
            `UPDATE items SET status='pending', state=?, priority=?, priority_explain=?, changed_lines=?, updated_at=datetime('now') WHERE id=?`
          )
          .run(state, score, explain, diffInfo.changedLines, existing.id);
        // If the placeholder never got enriched (e.g. earlier failure), try again now.
        if (this.opts.enrich !== false && existing.enriched === 0) {
          this.scheduleEnrich(s, existing.category, state, questionText, view, diffInfo, sig, lastPrompt);
        }
        return;
      }
    }

    // FIX W: an IDLE/UNKNOWN session is surfaced LOW with NO Claude enrichment — it's just "this
    // session is idle and here if you want it" (firing claude -p on every idle session would be
    // expensive and pointless). WAITING_INPUT/DONE keep the normal cheap-classify + enrich path.
    const isIdle = state === "UNKNOWN";
    // ---- NEW item: classify cheaply (rules, sync) and INSERT INSTANTLY as a
    // placeholder, then enrich in the background so the card is usable immediately. ----
    const ruled = isIdle ? null : triageRules({ state, questionText, changedLines: diffInfo.changedLines, cfg: this.cfg.triage });
    const category: TriageCategory = isIdle
      ? "FYI_DONE"
      : ruled
      ? ruled.category
      : state === "DONE"
      ? "FYI_DONE"
      : "COMPLEX_DECISION"; // tentative; refined by enrichment/triage below
    const categorySource = isIdle ? "idle" : ruled ? ruled.source : "tentative";
    const enrichOn = !isIdle && this.opts.enrich !== false;
    const placeholderOneLiner = isIdle
      ? "idle — " + ((questionText || "").split("\n").filter(Boolean).pop()?.slice(0, 110) || "session is idle")
      : (questionText || reason).split("\n").filter(Boolean)[0]?.slice(0, 140) || reason;
    const importance = -1;
    const { score, explain } = this.scoreFor(s, category, state, importance, diffInfo.changedLines, questionText);

    this.db
      .prepare(
        `INSERT INTO items
          (session_id,state,category,category_source,question,last_prompt,one_liner,suggested_answer,diff_summary,changed_lines,importance,importance_reason,answer_options,enriched,priority,priority_explain,status,signature)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)
         ON CONFLICT(signature) DO NOTHING`
      )
      .run(
        s.id,
        state,
        category,
        categorySource,
        questionText,
        lastPrompt || null,
        placeholderOneLiner,
        null,
        null,
        diffInfo.changedLines,
        importance,
        null,
        null,
        enrichOn ? 0 : 1, // offline (no-enrich): the placeholder IS the final content
        score,
        explain,
        sig
      );

    if (enrichOn) this.scheduleEnrich(s, category, state, questionText, view, diffInfo, sig, lastPrompt);
  }

  /** Fire-and-forget background enrichment: ONE combined `claude -p` call, then update
   *  the placeholder row in place. Never blocks the tick or the card. */
  private scheduleEnrich(
    s: SessionRow,
    category: TriageCategory,
    state: any,
    questionText: string,
    view: TranscriptView | null,
    diffInfo: { changedLines: number; stat: string; patch: string },
    sig: string,
    lastPrompt: string
  ): void {
    if (this.enriching.has(sig)) return; // already running
    this.enriching.add(sig);
    const run = async () => {
      try {
        // Refine a tentative (rules-uncertain) category with one cheap triage call.
        let cat = category;
        if (!triageRules({ state, questionText, changedLines: diffInfo.changedLines, cfg: this.cfg.triage })) {
          const t = await triage({ state, questionText, changedLines: diffInfo.changedLines, cfg: this.cfg.triage }, this.cfg.models.triage);
          cat = t.category;
        }
        const vp = viewPreference(this.db, cat);
        // FYI_DONE cards: the final message IS the summary — paying a model to one-line it again
        // is the bulk of enrichment spend (most surfaced cards are DONE). Deterministic excerpt
        // unless the operator opts back in via enrich_fyi_with_model.
        const out = (cat === "FYI_DONE" && (this.cfg as any).enrich_fyi_with_model !== true)
          ? enrichFallback({ category: cat, title: s.title, questionText, lastPrompt, recentTranscript: view?.raw || "", diffStat: diffInfo.stat, diffPatch: diffInfo.patch, focus: this.cfg.focus, changedLines: diffInfo.changedLines, extraContextRequested: vp.preferMoreContext, model: this.cfg.models.triage })
          : await enrichItem({
          category: cat,
          title: s.title,
          questionText,
          lastPrompt, // sticky: resolved in surface() so it survives the prompt scrolling out of the hot tail
          recentTranscript: view?.raw || "",
          diffStat: diffInfo.stat,
          diffPatch: diffInfo.patch,
          focus: this.cfg.focus,
          changedLines: diffInfo.changedLines,
          extraContextRequested: vp.preferMoreContext,
          model: this.cfg.models.triage, // ONE combined cheap call
        });
        const normOpts = normalizeOptions(questionText, out.options);
        const answerOptions = normOpts.length ? JSON.stringify(normOpts) : null;
        const fresh = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(s.id) as unknown as SessionRow | undefined;
        const { score, explain } = this.scoreFor(fresh || s, cat, state, out.importance, diffInfo.changedLines, questionText);
        this.db
          .prepare(
            `UPDATE items SET category=?, category_source=?, one_liner=?, context=?, prompt_summary=?, suggested_answer=?, diff_summary=?, importance=?, importance_reason=?, answer_options=?, enriched=1, priority=?, priority_explain=?, updated_at=datetime('now') WHERE signature=?`
          )
          .run(cat, "claude", out.one_liner, out.context, out.prompt_summary, out.suggested_answer, out.diff_summary, out.importance, out.importance_reason, answerOptions, score, explain, sig);
      } catch {
        /* leave placeholder; a later tick retries (enriched still 0) */
      } finally {
        this.enriching.delete(sig);
      }
    };
    void run();
  }

  /** CHEAP re-rank: recompute every pending item's priority from data ALREADY in the DB
   *  (session flags, stored category/importance/changed_lines, snooze penalty) and re-sort.
   *  NO discovery, NO Claude enrichment, NO gh PR scan — safe to call synchronously on a
   *  quick action (snooze/feedback/pin/…) so the UI advances instantly instead of waiting
   *  for the heavy 2s tick(). */
  rerank(): void {
    const rows = this.db.prepare("SELECT * FROM items WHERE status='pending'").all() as unknown as ItemRow[];
    const upd = this.db.prepare("UPDATE items SET priority=?, priority_explain=? WHERE id=?");
    this.db.exec("BEGIN");
    try {
      for (const it of rows) {
        const s = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(it.session_id) as unknown as SessionRow | undefined;
        if (!s) continue;
        const { score, explain } = this.scoreFor(s, it.category as any, it.state, it.importance, it.changed_lines, it.question || "");
        upd.run(score, explain, it.id);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }

  /** SNOOZE DECAY (operator request): a snoozed item starts cfg.snooze_penalty (default -100) below
   *  its natural score and climbs back LINEARLY over cfg.snooze_recover_hours (default 5h) — at
   *  -100/5h that's 20 points/hour. Priorities are CACHED on items and the Stage-0 lock keeps the
   *  tick's hands off queued items, so without this pass the decaying penalty would never reach the
   *  cached score and the item would stay sunk at its snooze-time value. This is a sanctioned,
   *  surgically-scoped exemption from the lock: it re-SCORES (never re-evaluates state, presence,
   *  or enrichment) ONLY the pending items whose session currently carries a snooze penalty, at
   *  most once per minute — every other item's cached priority is untouched. Once a penalty is
   *  fully recovered the stored value is cleared (snooze_penalty=0, snoozed_at=NULL) so the row
   *  returns to its natural state for good and drops out of this pass. */
  private static SNOOZE_DECAY_TICK_MS = 60_000;
  private lastSnoozeDecayAt = 0;
  snoozeDecayTick(force = false): number {
    const now = Date.now();
    if (!force && now - this.lastSnoozeDecayAt < Engine.SNOOZE_DECAY_TICK_MS) return 0;
    this.lastSnoozeDecayAt = now;
    const rows = this.db
      .prepare(
        `SELECT i.* FROM items i JOIN sessions s ON s.id=i.session_id
         WHERE i.status='pending' AND s.snooze_penalty < 0`
      )
      .all() as unknown as ItemRow[];
    let updated = 0;
    const upd = this.db.prepare("UPDATE items SET priority=?, priority_explain=? WHERE id=?");
    for (const it of rows) {
      const s = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(it.session_id) as unknown as SessionRow | undefined;
      if (!s) continue;
      // Fully recovered → clear the stored penalty so the session is back at its natural rank
      // permanently (and stops matching the query above).
      const recoverH = this.cfg.snooze_recover_hours ?? 5;
      if (effectiveSnoozePenalty(s.snooze_penalty || 0, s.snoozed_at ?? null, recoverH, now) === 0) {
        try {
          this.db.prepare("UPDATE sessions SET snooze_penalty=0, snoozed_at=NULL, updated_at=datetime('now') WHERE id=?").run(s.id);
        } catch {}
      }
      // scoreFor re-reads the LIVE session row, so it sees the clear above (or the decayed stamp).
      const { score, explain } = this.scoreFor(s, it.category as any, it.state, it.importance, it.changed_lines, it.question || "");
      upd.run(score, explain, it.id);
      updated++;
    }
    return updated;
  }

  /** OPERATOR-TRIGGERED full re-prioritization (the "↻ re-prioritize" button next to the queue).
   *
   *  The two automatic paths deliberately do NOT re-judge a task that's already in Up Next:
   *    • the 5s tick LEAVES Up Next alone (Stage 0 lock — a queued task is never re-evaluated on its
   *      own, so the operator is never auto-moved off what they're looking at), and
   *    • rerank() only re-SORTS from the importance ALREADY stored — it never asks the model again.
   *  Neither re-measures a task against a CHANGED focus. This does: for every pending item it re-reads
   *  the freshest transcript + worktree diff and re-runs the SAME enrichment call normal surfacing
   *  uses, which re-judges the item's importance against the CURRENT focus (and the learned ranking
   *  rules), re-summarizes, and re-scores — including the items currently frozen in Up Next. Use it
   *  when the focus has shifted and you want the WHOLE queue re-measured against it.
   *
   *  Bypassing the Up-Next freeze is intentional and scoped to this one explicit action: it operates
   *  directly on the pending items rather than through _tick(), so it never re-runs state detection
   *  (a task can't flicker out of the queue) and never drops anything — it only re-judges + re-ranks.
   *  Operator overrides are respected exactly as in normal scoring (a manual importance still REPLACES
   *  the model's judgement; pins / snooze / h-l deltas still apply). Enrichment is fire-and-forget, so
   *  the model-judged scores refresh progressively as each call returns; the immediate rerank() below
   *  re-scores from current data (focus keyword-match, staleness, flags) so the order updates at once,
   *  even before the model replies. Returns how many items were queued for re-judgement. */
  async reprioritizeAll(): Promise<{ ok: boolean; reprioritized: number }> {
    const items = this.db.prepare("SELECT * FROM items WHERE status='pending'").all() as unknown as ItemRow[];
    let n = 0;
    for (const it of items) {
      const s = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(it.session_id) as unknown as SessionRow | undefined;
      if (!s) continue;
      // PR items aren't enriched via a transcript — surfacePr() recomputes focus_match + the full
      // score against the current focus and updates the row in place.
      if (s.kind === "pr") { try { await this.surfacePr(s); n++; } catch {} continue; }
      // Kanban backfill cards carry a column-based priority (no model importance) — leave them be;
      // the rerank() below keeps them consistent. Only real Claude work gets re-judged by the model.
      if (s.kind !== "claude") continue;
      if (this.opts.enrich === false) continue; // offline / no-model → nothing to re-ask (rerank() still re-sorts)
      // Re-read the freshest transcript tail + worktree diff so importance is judged on the CURRENT
      // content (picks up new work / a changed diff since the card was first enriched).
      const detected = await this.detect(s);
      let diffInfo = { changedLines: it.changed_lines || 0, stat: "", patch: "" };
      try { const d = await worktreeDiff(s.worktree_path); diffInfo = { changedLines: d.changedLines, stat: d.stat, patch: d.patch }; } catch {}
      const questionText = it.question || detected.view?.lastAssistant?.text || "";
      const lastPrompt = it.last_prompt || detected.view?.lastUserPrompt?.text || "";
      const category = (it.category as TriageCategory) || (it.state === "DONE" ? "FYI_DONE" : "COMPLEX_DECISION");
      // Force a fresh enrich even if one was cached for this exact signature this session.
      this.enriching.delete(it.signature);
      this.scheduleEnrich(s, category, it.state, questionText, detected.view, diffInfo, it.signature, lastPrompt);
      n++;
    }
    // Re-score immediately from current data so the order updates at once (focus keyword-match,
    // staleness, flags); the model-judged importance lands per item as each enrich call returns.
    this.rerank();
    return { ok: true, reprioritized: n };
  }

  /** The ranked, operator-facing worklist: pending items only, best first. */
  queue(): RankedItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items
         WHERE status='pending' AND (snooze_until IS NULL OR snooze_until < datetime('now'))
           AND session_id NOT IN (SELECT id FROM sessions WHERE completed_at IS NOT NULL)
         ORDER BY priority DESC, updated_at DESC`
      )
      .all() as unknown as ItemRow[];

    // FIX L: float the ACTIVE task (operator just opened its terminal) to #1 with a priority just
    // above the highest organic item — readable (e.g. 63 when next is 58), not a flat 50k. Done
    // here (not in scoreItem) because it needs the others' scores. Stays BELOW explicit pins.
    const activeId = this._activeSessionId;
    if (activeId != null && rows.some((r) => r.session_id === activeId)) {
      let maxOrganic = 0;
      for (const r of rows) {
        if (r.session_id === activeId || r.priority >= PIN_BASE) continue; // ignore self + pins
        if (r.priority > maxOrganic) maxOrganic = r.priority;
      }
      const boosted = maxOrganic + ACTIVE_OVER;
      for (const r of rows) if (r.session_id === activeId && r.priority < PIN_BASE) r.priority = boosted;
      rows.sort((a, b) => b.priority - a.priority || (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    }

    const ranked: RankedItem[] = rows.map((it) => {
      const session = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(it.session_id) as unknown as SessionRow;
      // Live decayed snooze penalty for the 💤 badge (recovers linearly over snooze_recover_hours).
      if (session && (session.snooze_penalty || 0) < 0) {
        (session as any).snooze_effective = effectiveSnoozePenalty(session.snooze_penalty, session.snoozed_at ?? null, this.cfg.snooze_recover_hours ?? 5, Date.now());
      }
      const vp = viewPreference(this.db, it.category);
      let explain: any = {};
      try {
        explain = JSON.parse(it.priority_explain || "{}");
      } catch {}
      if (it.session_id === activeId && it.priority < PIN_BASE) {
        explain.breakdown = (explain.breakdown || []).filter((t: any) => t.signal !== "active");
        explain.breakdown.push({ signal: "active", raw: 1, weight: ACTIVE_OVER, contribution: ACTIVE_OVER, note: "you opened this task's terminal — floated just above the rest" });
      }
      const defaultView: "summary" | "raw" = vp.preferRaw ? "raw" : "summary";
      return {
        ...it,
        session,
        score_breakdown: explain,
        default_view: defaultView,
        ready_reason: it.state === "DONE" ? "finished" : "waiting on your input",
      };
    });
    return ranked.concat(this.teamGroups());
  }

  /** A team whose newest member transcript is older than this is over — drop its group row. */
  private static readonly TEAM_ACTIVE_WINDOW_MS = 30 * 60 * 1000;

  /** Persistence escape for the ❓ pane flag: once @claude_pane_status has read `input` while the
   *  transcript stayed quiet this long, it is a genuine unanswered prompt — the notify hooks would
   *  have flipped it to `working`/`done` on the next tool call / turn-end if claude were still
   *  going. Past this, surface WAITING_INPUT without waiting on the stability double-sample (which
   *  a crash-looping or already-exited asking session never satisfies). 2 min ≫ the seconds-long
   *  post-answer lag window, so it cannot false-surface a normally-resuming session. */
  private static readonly PANE_INPUT_TRUST_MS = 2 * 60 * 1000;

  /**
   * One synthetic queue entry per LIVE Claude Code team: `‹repo› — ‹team-name› [team ·N]` with the
   * teammates as display-only child rows. Teammates never surface as their own items (see _tick),
   * so this is the only place a team shows up. Appended after the ranked items — a running team
   * never needs the operator, so it never competes for `next`.
   */
  private teamGroups(): RankedItem[] {
    let mates: SessionRow[] = [];
    try {
      mates = this.db.prepare(
        `SELECT * FROM sessions
          WHERE is_teammate=1 AND completed_at IS NULL
            AND created_at > datetime('now','-2 days')`
      ).all() as unknown as SessionRow[];
    } catch { return []; }
    if (!mates.length) return [];
    const groups = new Map<string, SessionRow[]>();
    for (const m of mates) {
      const key = `${m.repo} ${m.team_name || ""}`;
      const g = groups.get(key); if (g) g.push(m); else groups.set(key, [m]);
    }
    const out: RankedItem[] = [];
    for (const members of groups.values()) {
      // Activity gate: a team is shown only while its newest member transcript is still fresh —
      // finished teams age out instead of cluttering the queue forever.
      let newest = 0;
      for (const m of members) {
        if (!m.transcript_path) continue;
        try { newest = Math.max(newest, fs.statSync(m.transcript_path).mtimeMs); } catch {}
      }
      if (Date.now() - newest > Engine.TEAM_ACTIVE_WINDOW_MS) continue;
      members.sort((a, b) => (a.agent_name || "").localeCompare(b.agent_name || ""));
      const children: TeamChild[] = members.map((m) => ({
        session_id: m.id,
        agent_name: m.agent_name || "teammate",
        state: m.state || "UNKNOWN",
        tmux_target: m.tmux_target,
      }));
      const states = new Set(children.map((c) => c.state));
      const rollup = states.has("WORKING") ? "WORKING"
        : states.has("WAITING_INPUT") ? "WAITING_INPUT"
        : states.has("DONE") ? "DONE" : "UNKNOWN";
      const lead = members[0];
      const minId = Math.min(...members.map((m) => m.id));
      const busy = children.filter((c) => c.state === "WORKING").length;
      const session: SessionRow = {
        ...lead,
        id: -2_000_000 - minId, // synthetic + stable; clear of the renderer's _virtual id range
        title: `${lead.repo} — ${lead.team_name}`,
        clean_title: `${lead.repo} — ${lead.team_name}`,
        kind: "team",
        state: rollup as any,
        pinned: 0, manual_importance: null, snooze_penalty: 0,
        pane_id: null, tmux_target: null, is_live_pane: 0,
      };
      out.push({
        id: -2_000_000 - minId,
        session_id: session.id,
        state: rollup as any,
        category: null,
        category_source: null,
        question: null,
        last_prompt: null,
        prompt_summary: null,
        one_liner: busy ? `${busy}/${children.length} teammates busy` : `all ${children.length} teammates finished`,
        context: null,
        suggested_answer: null,
        diff_summary: null,
        changed_lines: 0,
        importance: -1,
        importance_reason: null,
        answer_options: null,
        enriched: 1,
        auto_opened: 0,
        priority: 0,
        priority_explain: null,
        status: "pending",
        snooze_until: null,
        decision: null,
        signature: `team:${lead.repo}:${lead.team_name}`,
        created_at: lead.created_at,
        updated_at: lead.updated_at,
        session,
        score_breakdown: {},
        default_view: "summary",
        ready_reason: rollup === "WORKING" ? "team running" : "team finished",
        _team: true,
        children,
      });
    }
    return out;
  }
}
