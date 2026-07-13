/**
 * The one database. All persistent state lives here, in local SQLite (open format,
 * the operator owns it). Accessed through exactly this module. Uses Node 22+/24
 * built-in `node:sqlite` so there is no native build step.
 *
 * Two conceptual entities:
 *   sessions  - a launched Claude Code session living in its own git worktree.
 *   items     - a surfaced "ready" event for a session (needs-input or done).
 *               Mirrors the jarvis `queue` table: the unit the operator decides on.
 *
 * Plus the learning loop tables (decision_log, signal_adjustments, view_pref).
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type SessionState = "WORKING" | "WAITING_INPUT" | "DONE" | "UNKNOWN";
export type TriageCategory =
  | "SIMPLE_QUESTION"
  | "REVIEW_DIFF"
  | "COMPLEX_DECISION"
  | "FYI_DONE";

export interface SessionRow {
  id: number;
  slot: number; // stable 1..N for "jump to session N"
  title: string;
  repo: string;
  worktree_path: string;
  branch: string;
  claude_session_id: string | null;
  transcript_path: string | null;
  pid: number | null;
  // per-pane discovery: a live claude PANE this session maps to (default tmux socket)
  pane_id: string | null;        // tmux %id, e.g. "%67" — stable per live pane
  tmux_target: string | null;    // "session:window.pane" for exact-pane attach
  is_live_pane: number;          // 1 = a live claude pane (attachable); 0 = transcript-only roster
  clean_title: string | null;    // short human title (haiku-generated, lazy); falls back to title
  manual_title: string | null;   // operator-typed name (inline rename) — ALWAYS wins over clean_title/title
  tags: string | null;           // JSON array of category tags (haiku-assigned), e.g. ["training"]
  meta_gen_prompts: number;      // # of user prompts seen when title+tags were last generated (-1 = never)
  state: SessionState;
  manual_state: SessionState | null;      // operator-forced status (right-click a card); wins over detection
  manual_state_base: SessionState | null; // auto-detected state at override time; override auto-clears when the auto state moves off it
  blocks_other_work: number; // 0/1 operator-declared
  deadline: string | null; // ISO date or null
  kind: string; // 'claude' (a Claude Code session) | 'pr' (a GitHub PR to review)
  pr_repo: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_author: string | null;
  discovered: number; // 1 if auto-discovered from ~/.claude/projects
  manual_importance: number | null; // operator override 0..100 (overrides LLM importance)
  pinned: number; // 1 = force to top of queue the moment it is ready
  snooze_penalty: number; // <=0 score penalty from snoozing (sinks the item but keeps it VISIBLE)
  snoozed_at: string | null; // ISO timestamp of the last snooze — the penalty decays LINEARLY back to 0 over cfg.snooze_recover_hours from this moment
  provisional: number; // 1 = freshly-launched, ephemeral until the operator actually uses it
  input_seen: number; // 1 = the operator sent input to this session's terminal
  pr_updated_at: string | null;
  pr_review_decision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
  pr_draft: number;
  pr_additions: number;
  pr_deletions: number;
  pr_head_ref: string | null; // PR head branch (feature)
  pr_base_ref: string | null; // PR base branch (target)
  pr_local_repo: string | null; // demo only: path to the throwaway local git repo
  kanban_file: string | null; // absolute path to the kanban card .md
  kanban_column: string | null;
  kanban_startable: number; // -1 unknown, 0 needs-info, 1 startable (2 = legacy H-blocked; reclassified on next surface)
  kanban_from_scratch: number; // 1 = NEEDS-INFO and so sparse the classifier couldn't even form questions ("explain from scratch")
  kanban_questions: string | null; // JSON array of clarifying questions
  kanban_answers: string | null; // JSON array of operator answers
  // ETA tracking for long-running silent sessions (see eta.ts / handleEta).
  eta_at: string | null; // ISO absolute finish time the session reported, or null
  eta_text: string | null; // the verbatim value from the `eta:` marker (e.g. "50m")
  eta_mtime: number; // transcript mtime (ms) the latest eta marker was parsed at (0 = none)
  eta_probe_at: string | null; // ISO of the last `/eta` probe we injected (throttle)
  verdict_mtime: number;       // transcript mtime the persisted gate verdict was judged at (0 = none)
  verdict_rev: number;         // workingVerifier.VERDICT_REV at judge time — stale revisions are not reused
  verdict_activity: string | null; // persisted ready-gate verdict class (survives restarts — a restart must not re-buy ~200 verdicts)
  verdict_reason: string | null;
  // Claude Code TEAM sub-agents (teammates): the transcript carries top-level teamName/agentName
  // on every line. Teammates never surface as their own queue items — they render as child rows
  // under one synthetic team-group entry (see engine.queue()).
  is_teammate: number;
  teammate_orphaned: number; // 1 = team silent past the guarantee → treated as a normal session (surfaces) // 1 = a team sub-agent session (reviewer-r1, worker, …)
  team_name: string | null; // e.g. "sup-s3-9k-dataloader"
  agent_name: string | null; // e.g. "reviewer-r1"
  created_at: string;
  updated_at: string;
}

export interface ItemRow {
  id: number;
  session_id: number;
  state: SessionState; // WAITING_INPUT | DONE (only ready states get items)
  category: TriageCategory | null;
  category_source: string | null; // 'rules' | 'claude'
  question: string | null; // the raw question / final text
  last_prompt: string | null; // the operator's most recent prompt to this session (verbatim)
  prompt_summary: string | null; // LLM summary of last_prompt when it's long (null => show verbatim)
  one_liner: string | null; // AI one-line context
  context: string | null; // AI recap: where this session now stands (Claude's status, not the ask)
  suggested_answer: string | null;
  diff_summary: string | null;
  changed_lines: number;
  importance: number; // LLM-judged importance 0..100 (-1 = not yet judged)
  importance_reason: string | null; // one-line LLM rationale
  answer_options: string | null; // JSON array of 2-4 candidate answers (A/B/C/D)
  enriched: number; // 0 = placeholder (LLM enrichment pending), 1 = enriched
  auto_opened: number; // 0 = terminal not yet auto-opened, 1 = already auto-opened once (COMPLEX routing)
  priority: number;
  priority_explain: string | null; // JSON breakdown, fully inspectable
  status: string; // pending | decided | snoozed | hidden
  snooze_until: string | null;
  decision: string | null;
  signature: string; // dedup: session_id + transcript hash of the ready turn
  created_at: string;
  updated_at: string;
}

let _db: DatabaseSync | null = null;

export function openDb(dbPath?: string): DatabaseSync {
  const p =
    dbPath ||
    process.env.COCKPIT_DB ||
    path.resolve(__dirname, "../../data/cockpit.db");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL;");
  // WAIT (up to 5s) for a contended write lock instead of throwing "database is locked"
  // immediately. Without this, ANY second opener of the db — a stray/duplicate server, an
  // Electron app running alongside the web server, or a WAL checkpoint — makes every engine
  // tick's setSessionState() throw ERR_SQLITE_ERROR(5), freezing state updates so the app
  // looks "broken" while actually just starved of the lock.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Keep the WAL from ballooning (it had grown to multiple MB): checkpoint passively at ~1000 pages.
  db.exec("PRAGMA wal_autocheckpoint = 1000;");
  migrate(db);
  _db = db;
  return db;
}

export function db(): DatabaseSync {
  if (!_db) return openDb();
  return _db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot INTEGER NOT NULL,
      title TEXT NOT NULL,
      repo TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      claude_session_id TEXT,
      transcript_path TEXT,
      pid INTEGER,
      pane_id TEXT,
      tmux_target TEXT,
      is_live_pane INTEGER NOT NULL DEFAULT 0,
      clean_title TEXT,
      state TEXT NOT NULL DEFAULT 'UNKNOWN',
      blocks_other_work INTEGER NOT NULL DEFAULT 0,
      deadline TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- (new columns added below via additive ALTERs for older DBs)

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      category TEXT,
      category_source TEXT,
      question TEXT,
      one_liner TEXT,
      context TEXT,
      suggested_answer TEXT,
      diff_summary TEXT,
      changed_lines INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 50,
      priority_explain TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      snooze_until TEXT,
      decision TEXT,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(signature)
    );

    -- Learning loop: append-only record of every operator decision/feedback.
    CREATE TABLE IF NOT EXISTS decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      session_id INTEGER,
      category TEXT,
      state TEXT,
      feedback TEXT NOT NULL,        -- priority_high|priority_low|wrong|too_much_output|need_more_context|good|decided
      decision TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Answer-quality feedback (a "draft comparison" loop).
    -- Every time the operator sends an answer we keep BOTH what ClaudeOS suggested AND
    -- what the operator actually sent, plus — when A/B/C/D options were offered — which
    -- option was chosen (or that they wrote their own). This is the raw material for
    -- learning better SUGGESTIONS, and for harvesting confirmed Q->A goldset cases.
    -- It deliberately does NOT feed the ranking nudges (prioritization is learned
    -- elsewhere and must not be perturbed by answer edits).
    CREATE TABLE IF NOT EXISTS answer_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      session_id INTEGER,
      category TEXT,
      state TEXT,
      question TEXT,                 -- what the session asked the operator
      suggested TEXT,                -- ClaudeOS's proposed answer (option A)
      final TEXT,                    -- what the operator actually sent
      options_json TEXT,             -- the A/B/C/D candidates shown (JSON array of strings)
      chosen_index INTEGER,          -- index in options matching 'final', or -1 if free-written
      edit_distance INTEGER,         -- Levenshtein(suggested, final)
      similarity REAL,               -- 0..1, 1 = identical to the suggestion
      outcome TEXT,                  -- accepted | option_picked | edited | rewritten | empty
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-signal learned nudges applied transparently at rank time.
    CREATE TABLE IF NOT EXISTS signal_adjustments (
      key TEXT PRIMARY KEY,          -- e.g. 'category:REVIEW_DIFF' or 'signal:focus_match'
      adjustment REAL NOT NULL DEFAULT 0,
      up_count INTEGER NOT NULL DEFAULT 0,
      down_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Classifier view-default learning: how often a category was downgraded to raw,
    -- or the operator wanted more context. Nudges the default view per category.
    CREATE TABLE IF NOT EXISTS view_pref (
      category TEXT PRIMARY KEY,
      raw_pref REAL NOT NULL DEFAULT 0,   -- >0 => operator tends to want raw output
      context_pref REAL NOT NULL DEFAULT 0, -- >0 => operator tends to want MORE context
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-file "Viewed" state for the diff reviewer (GitHub-style), persisted per
    -- (session/PR + file) so files stay collapsed when you return to that review.
    CREATE TABLE IF NOT EXISTS diff_viewed (
      session_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, file_path)
    );

    -- Learning loop: every revealed mistake saved as {state, prediction, correct} so the
    -- nightly dream can nudge weights + RANKING.md a little toward correct. Fully inspectable.
    CREATE TABLE IF NOT EXISTS training_examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL,            -- leapfrog | manual_importance | snooze_high | triage_wrong
      state_json TEXT NOT NULL,      -- queue/item feature snapshot at decision time
      predicted_json TEXT NOT NULL,  -- what the model predicted (order / importance / category)
      correct_json TEXT NOT NULL,    -- what the operator revealed as correct
      applied INTEGER NOT NULL DEFAULT 0
    );

    -- Learned per-weight deltas from the nightly small-LR tuning. Effective weight =
    -- base (weights.json) + learned delta. Kept separate so the base stays operator-owned.
    CREATE TABLE IF NOT EXISTS learned_weights (
      key TEXT PRIMARY KEY,
      delta REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Nightly "dream": each run records what it changed and why (inspectable).
    CREATE TABLE IF NOT EXISTS dream_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT NOT NULL DEFAULT (datetime('now')),
      summary TEXT NOT NULL
    );

    -- Nightly conversation-review ("reflect"): a trajectory score (0-100) of whether the
    -- cockpit is getting BETTER at drafting answers / doing the operator's ABC questions.
    -- One row per run_date (upserted); window_stats_json holds the day/week rollup it scored.
    CREATE TABLE IF NOT EXISTS reflect_scores (
      run_date TEXT PRIMARY KEY,
      score INTEGER,
      window_stats_json TEXT,
      rationale TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Conversation / gist log. Every SOUL-voiced gist beat, every chat message (per-task
    -- and the global cockpit thread), and — from Stage 2 — every prompt+response sent to
    -- the claude CLI. This is the durable record the operator reviews to "see what happens":
    -- what was asked, in his voice, and where Claude's draft diverged from what he'd say.
    -- Append-only + best-effort (a logging failure must never break a model call or an action).
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT,                    -- 'task' | 'global'
      session_id INTEGER,            -- nullable (the global cockpit thread has none)
      item_id INTEGER,               -- nullable
      role TEXT NOT NULL,            -- 'user' | 'assistant' | 'gist' | 'system'
      content TEXT,                  -- the beat text / message / model response
      prompt TEXT,                   -- the full prompt sent to claude -p (nullable)
      persona_snapshot TEXT,         -- personaBlock() at send time (nullable, auditable)
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cross-review: Claude and Codex checking each other's code. One row per review run
    -- (the OPPOSITE model reviews a session's diff). The latest per session is shown in the UI.
    CREATE TABLE IF NOT EXISTS cross_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      reviewer TEXT NOT NULL,        -- 'claude' | 'codex' (who reviewed)
      author TEXT NOT NULL,          -- 'claude' | 'codex' (whose code)
      base TEXT,                     -- the base ref the diff was taken against
      changed_lines INTEGER DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 0, -- 1 = a real review, 0 = an error/empty (markdown holds the reason)
      markdown TEXT,                 -- the review (or the error message when ok=0)
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Singleton key/value bag for small engine bookkeeping (e.g. last_auto_launch_at,
    -- the kanban auto-launch cooldown timestamp). One row per key.
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Undo stack: every reversible operator action pushes a record whose ops
    -- describe how to reverse it (restore columns, delete a decision_log row, reverse
    -- a learned nudge). Popped newest-first.
    CREATE TABLE IF NOT EXISTS undo_stack (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      label TEXT NOT NULL,
      ops TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Additive columns (safe to re-run; ignore "duplicate column" on existing DBs).
  for (const col of [
    "pane_id TEXT",
    "tmux_target TEXT",
    "is_live_pane INTEGER NOT NULL DEFAULT 0",
    "clean_title TEXT",
    "kind TEXT NOT NULL DEFAULT 'claude'",
    "pr_repo TEXT",
    "pr_number INTEGER",
    "pr_url TEXT",
    "pr_author TEXT",
    "discovered INTEGER NOT NULL DEFAULT 0",
    "manual_importance INTEGER",
    "pinned INTEGER NOT NULL DEFAULT 0",
    "snooze_penalty INTEGER NOT NULL DEFAULT 0",
    "snoozed_at TEXT",
    "provisional INTEGER NOT NULL DEFAULT 0",
    "input_seen INTEGER NOT NULL DEFAULT 0",
    "pr_updated_at TEXT",
    "pr_review_decision TEXT",
    "pr_draft INTEGER NOT NULL DEFAULT 0",
    "pr_additions INTEGER NOT NULL DEFAULT 0",
    "pr_deletions INTEGER NOT NULL DEFAULT 0",
    "pr_head_ref TEXT",
    "pr_base_ref TEXT",
    "pr_local_repo TEXT",
    "kanban_file TEXT",
    "kanban_column TEXT",
    "kanban_startable INTEGER NOT NULL DEFAULT -1",
    "kanban_from_scratch INTEGER NOT NULL DEFAULT 0",
    "kanban_questions TEXT",
    "kanban_answers TEXT",
    "completed_at TEXT",
    "completed_by TEXT", // 'operator' (Ctrl+G e) vs 'auto' (idle reaper) — throughput counts only operator completions
    "manual_priority_delta INTEGER NOT NULL DEFAULT 0",
    "eta_at TEXT",
    "eta_text TEXT",
    "eta_mtime INTEGER NOT NULL DEFAULT 0",
    "eta_probe_at TEXT",
    "verdict_mtime INTEGER NOT NULL DEFAULT 0",
    "verdict_rev INTEGER NOT NULL DEFAULT 0",
    "verdict_activity TEXT",
    "verdict_reason TEXT",
    "is_teammate INTEGER NOT NULL DEFAULT 0",
    "teammate_orphaned INTEGER NOT NULL DEFAULT 0",
    "team_name TEXT",
    "agent_name TEXT",
    "manual_title TEXT",
    "tags TEXT",
    "meta_gen_prompts INTEGER NOT NULL DEFAULT -1",
    // MANUAL STATE OVERRIDE (operator right-clicks a card to correct a mis-read status). manual_state
    // is the forced state; manual_state_base is the auto-detected state captured on the first tick
    // after the override, used to auto-expire the override once reality actually moves off it.
    "manual_state TEXT",
    "manual_state_base TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col};`);
    } catch {
      /* column already exists */
    }
  }
  // Throughput stats sort completions on every /api/state and the sessions table only grows
  // (completed rows are kept); index keeps the ORDER BY completed_at cheap at scale.
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_completed_at ON sessions(completed_at) WHERE completed_at IS NOT NULL;"); } catch {}
  // The log viewer + gist cache read chat_log newest-first, filtered by scope/session; index both.
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_chat_log_scope_created ON chat_log(scope, created_at);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_chat_log_session_created ON chat_log(session_id, created_at);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_cross_reviews_session_created ON cross_reviews(session_id, created_at);"); } catch {}

  // FIX BB: explicit reasoned-priority feedback columns on training_examples.
  for (const col of ["reason TEXT", "source TEXT", "weight REAL NOT NULL DEFAULT 1"]) {
    try { db.exec(`ALTER TABLE training_examples ADD COLUMN ${col};`); } catch {}
  }
  for (const col of ["importance INTEGER NOT NULL DEFAULT -1", "importance_reason TEXT", "answer_options TEXT", "enriched INTEGER NOT NULL DEFAULT 0", "auto_opened INTEGER NOT NULL DEFAULT 0", "context TEXT", "dismissed_at TEXT", "last_prompt TEXT", "prompt_summary TEXT"]) {
    try {
      db.exec(`ALTER TABLE items ADD COLUMN ${col};`);
    } catch {
      /* column already exists */
    }
  }
  // One-shot heal: TEAMMATE sessions discovered before teammate detection existed (past the
  // discovery recency cap, so they never get re-derived and is_teammate stays 0). Only a teammate
  // RECEIVES envelopes from "team-lead", so the content match can't hit a real operator session.
  // Marking the SESSION is what stops the noise durably — hiding the item alone loses: the idle
  // surfacing policy (FIX W) re-pends the same card on the next tick.
  try {
    db.exec(`UPDATE sessions SET is_teammate=1 WHERE is_teammate=0 AND id IN
             (SELECT DISTINCT session_id FROM items WHERE last_prompt LIKE '%teammate_id="team-lead"%');`);
    db.exec(`UPDATE items SET status='hidden' WHERE status='pending' AND last_prompt LIKE '%teammate_id="team-lead"%';`);
  } catch {}
}

// ---- session helpers ----

export function nextSlot(db: DatabaseSync): number {
  const r = db.prepare("SELECT COALESCE(MAX(slot),0)+1 AS n FROM sessions").get() as {
    n: number;
  };
  return r.n;
}

export function upsertSession(
  db: DatabaseSync,
  s: Partial<SessionRow> & { worktree_path: string; title: string; repo: string; branch: string }
): number {
  const existing = db
    .prepare("SELECT id FROM sessions WHERE worktree_path = ?")
    .get(s.worktree_path) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE sessions SET title=?, repo=?, branch=?, claude_session_id=COALESCE(?,claude_session_id),
        transcript_path=COALESCE(?,transcript_path), pid=?, state=COALESCE(?,state),
        blocks_other_work=COALESCE(?,blocks_other_work), deadline=?,
        kind=COALESCE(?,kind), pr_repo=COALESCE(?,pr_repo), pr_number=COALESCE(?,pr_number),
        pr_url=COALESCE(?,pr_url), pr_author=COALESCE(?,pr_author), discovered=COALESCE(?,discovered),
        updated_at=datetime('now')
       WHERE id=?`
    ).run(
      s.title,
      s.repo,
      s.branch,
      s.claude_session_id ?? null,
      s.transcript_path ?? null,
      s.pid ?? null,
      s.state ?? null,
      s.blocks_other_work ?? null,
      s.deadline ?? null,
      s.kind ?? null,
      s.pr_repo ?? null,
      s.pr_number ?? null,
      s.pr_url ?? null,
      s.pr_author ?? null,
      s.discovered ?? null,
      existing.id
    );
    return existing.id;
  }
  const slot = s.slot ?? nextSlot(db);
  const info = db
    .prepare(
      `INSERT INTO sessions (slot,title,repo,worktree_path,branch,claude_session_id,transcript_path,pid,state,blocks_other_work,deadline,kind,pr_repo,pr_number,pr_url,pr_author,discovered)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      slot,
      s.title,
      s.repo,
      s.worktree_path,
      s.branch,
      s.claude_session_id ?? null,
      s.transcript_path ?? null,
      s.pid ?? null,
      s.state ?? "UNKNOWN",
      s.blocks_other_work ?? 0,
      s.deadline ?? null,
      s.kind ?? "claude",
      s.pr_repo ?? null,
      s.pr_number ?? null,
      s.pr_url ?? null,
      s.pr_author ?? null,
      s.discovered ?? 0
    );
  return Number(info.lastInsertRowid);
}

/**
 * Upsert a DISCOVERED claude session keyed by its transcript session-id (the .jsonl uuid),
 * NOT by cwd — so multiple concurrent claude PANES sharing a repo each get their own row.
 * Stores the live-pane mapping (pane_id / tmux_target / is_live_pane) for exact-pane attach.
 */
export function upsertDiscoveredSession(
  db: DatabaseSync,
  s: { claude_session_id: string; title: string; repo: string; worktree_path: string; branch: string;
       transcript_path: string; pane_id?: string | null; tmux_target?: string | null;
       is_live_pane?: number; pid?: number | null; clean_title?: string | null;
       is_teammate?: number; team_name?: string | null; agent_name?: string | null;
       // 'claude' (default) or 'codex' — a discovered OpenAI Codex CLI session. The column doubles
       // as the resumable session id for both (claude --resume / codex resume).
       kind?: string }
): number {
  const kind = s.kind || "claude";
  const existing = db.prepare("SELECT id FROM sessions WHERE claude_session_id = ?").get(s.claude_session_id) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE sessions SET title=?, repo=?, worktree_path=?, branch=?, transcript_path=?,
        pane_id=?, tmux_target=?, is_live_pane=?, pid=COALESCE(?,pid),
        clean_title=COALESCE(?,clean_title), is_teammate=?, team_name=COALESCE(?,team_name),
        agent_name=COALESCE(?,agent_name), kind=?, discovered=1, updated_at=datetime('now')
       WHERE id=?`
    ).run(s.title, s.repo, s.worktree_path, s.branch, s.transcript_path,
          s.pane_id ?? null, s.tmux_target ?? null, s.is_live_pane ?? 0, s.pid ?? null,
          s.clean_title ?? null, s.is_teammate ?? 0, s.team_name ?? null, s.agent_name ?? null,
          kind, existing.id);
    return existing.id;
  }
  // ADOPT a cockpit-LAUNCHED session instead of inserting a duplicate. A Ctrl+G-i / new-Claude
  // launch (launchTerminalSession) creates a row in its OWN dedicated worktree with
  // claude_session_id=NULL — the transcript uuid isn't known until `claude` starts and writes its
  // .jsonl. When discovery later finds that transcript, its uuid matches NO row, so without this we
  // INSERT a SECOND row for the same worktree → the duplicate "new claude session" twin that shows
  // up in the queue. A cockpit worktree path is unique to exactly one launch, so an un-adopted
  // (claude_session_id IS NULL), cockpit-launched (discovered=0) claude row at this worktree_path is
  // unambiguously the SAME session — stamp it with the uuid + live transcript/pane rather than dup
  // it. Guarded so it can never fold together two genuinely-distinct sessions that share a repo cwd
  // (those are discovered=1 with their own uuids; none is an un-stamped launch row).
  const adopt = kind === "claude" ? db.prepare(
    `SELECT id FROM sessions
       WHERE worktree_path = ? AND claude_session_id IS NULL AND discovered = 0 AND kind = 'claude'
       ORDER BY id DESC LIMIT 1`
  ).get(s.worktree_path) as { id: number } | undefined : undefined;
  if (adopt) {
    db.prepare(
      `UPDATE sessions SET claude_session_id=?, title=?, repo=?, branch=?, transcript_path=?,
        pane_id=?, tmux_target=?, is_live_pane=?, pid=COALESCE(?,pid),
        clean_title=COALESCE(?,clean_title), kind='claude', provisional=0, updated_at=datetime('now')
       WHERE id=?`
    ).run(s.claude_session_id, s.title, s.repo, s.branch, s.transcript_path,
          s.pane_id ?? null, s.tmux_target ?? null, s.is_live_pane ?? 0, s.pid ?? null,
          s.clean_title ?? null, adopt.id);
    return adopt.id;
  }
  const slot = nextSlot(db);
  const info = db.prepare(
    `INSERT INTO sessions (slot,title,repo,worktree_path,branch,claude_session_id,transcript_path,pane_id,tmux_target,is_live_pane,clean_title,pid,is_teammate,team_name,agent_name,state,kind,discovered)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'UNKNOWN',?,1)`
  ).run(slot, s.title, s.repo, s.worktree_path, s.branch, s.claude_session_id, s.transcript_path,
        s.pane_id ?? null, s.tmux_target ?? null, s.is_live_pane ?? 0, s.clean_title ?? null, s.pid ?? null,
        s.is_teammate ?? 0, s.team_name ?? null, s.agent_name ?? null, kind);
  return Number(info.lastInsertRowid);
}

/** Clear the live-pane mapping on sessions whose pane is no longer present (became roster-only). */
export function clearLivePanes(db: DatabaseSync, keepSessionIds: string[]): void {
  const live = db.prepare("SELECT id, claude_session_id FROM sessions WHERE is_live_pane=1").all() as any[];
  const keep = new Set(keepSessionIds);
  for (const r of live) {
    if (!keep.has(r.claude_session_id)) {
      db.prepare("UPDATE sessions SET is_live_pane=0, pane_id=NULL, tmux_target=NULL WHERE id=?").run(r.id);
    }
  }
}

export function setSessionState(db: DatabaseSync, id: number, state: SessionState): void {
  db.prepare("UPDATE sessions SET state=?, updated_at=datetime('now') WHERE id=?").run(
    state,
    id
  );
}

/** MANUAL STATE OVERRIDE — persist the operator's forced status (WAITING_INPUT | WORKING | DONE),
 *  or null to clear it. `base` is the auto-detected state AT OVERRIDE TIME (what the detector thought
 *  when the operator corrected it); the engine auto-clears the override once the auto detection moves
 *  off that base (reality changed → trust the detector again), so a silenced session can never strand
 *  a real question forever. */
export function setManualStateOverride(db: DatabaseSync, id: number, state: SessionState | null, base: SessionState | null): void {
  db.prepare("UPDATE sessions SET manual_state=?, manual_state_base=?, updated_at=datetime('now') WHERE id=?")
    .run(state, state == null ? null : base, id);
}

export function allSessions(db: DatabaseSync): SessionRow[] {
  // FIX J: COMPLETED/ARCHIVED sessions are durably excluded from the roster AND the engine's
  // discovery loop, so a completed task never re-surfaces on subsequent ticks (undo clears it).
  return db.prepare("SELECT * FROM sessions WHERE completed_at IS NULL ORDER BY slot").all() as unknown as SessionRow[];
}

/** FIX J: durably mark a session COMPLETED (archived) — survives re-discovery. `by` records who
 *  completed it ('operator' vs 'auto' idle-reap) so throughput stats can count real completions
 *  only; clearing completed_at (undo/reopen) clears it too. */
export function setCompleted(db: DatabaseSync, id: number, completedAt: string | null, by: string = "operator"): void {
  db.prepare("UPDATE sessions SET completed_at=?, completed_by=?, updated_at=datetime('now') WHERE id=?")
    .run(completedAt, completedAt == null ? null : by, id);
}

export function getSession(db: DatabaseSync, id: number): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
    | unknown
    | undefined as SessionRow | undefined;
}

/**
 * Idempotent purge of stale DEMO artifacts that leaked into a REAL cockpit db/home:
 * sessions whose worktree_path is under a `data/demo-worktrees` dir (the old demo seed)
 * plus their items, and the matching ~/.claude/projects transcript dirs. Matches ONLY
 * on the demo-worktrees PATH — never on title/seed-phrase — so genuine sessions that
 * happen to share a demo title are untouched. Safe to run on every startup.
 */
export function purgeDemoArtifacts(db: DatabaseSync): { sessions: number; projectDirs: number } {
  const rows = db
    .prepare("SELECT id FROM sessions WHERE worktree_path LIKE '%/data/demo-worktrees/%'")
    .all() as unknown as { id: number }[];
  for (const r of rows) {
    db.prepare("DELETE FROM items WHERE session_id=?").run(r.id);
    db.prepare("DELETE FROM sessions WHERE id=?").run(r.id);
  }
  // Remove encoded transcript dirs for those demo worktrees (segment: data-demo-worktrees).
  let projectDirs = 0;
  try {
    const proj = path.join(os.homedir(), ".claude", "projects");
    for (const d of fs.readdirSync(proj)) {
      if (d.includes("data-demo-worktrees")) {
        try {
          fs.rmSync(path.join(proj, d), { recursive: true, force: true });
          projectDirs++;
        } catch {}
      }
    }
  } catch {}
  return { sessions: rows.length, projectDirs };
}

export function setPinned(db: DatabaseSync, id: number, pinned: boolean): void {
  db.prepare("UPDATE sessions SET pinned=?, updated_at=datetime('now') WHERE id=?").run(pinned ? 1 : 0, id);
}

/** Operator-typed session name (inline rename). null/empty clears it → display reverts to the
 *  auto name (clean_title/title). Never touched by the auto-namer, so a rename is durable. */
export function setManualTitle(db: DatabaseSync, id: number, title: string | null): void {
  const v = (title || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  db.prepare("UPDATE sessions SET manual_title=?, updated_at=datetime('now') WHERE id=?").run(v, id);
}

export function setManualImportance(db: DatabaseSync, id: number, value: number | null): void {
  const v = value == null ? null : Math.max(0, Math.min(100, Math.round(value)));
  db.prepare("UPDATE sessions SET manual_importance=?, updated_at=datetime('now') WHERE id=?").run(v, id);
}

export function setSnoozePenalty(db: DatabaseSync, id: number, value: number, snoozedAt: string | null = null): void {
  db.prepare("UPDATE sessions SET snooze_penalty=?, snoozed_at=?, updated_at=datetime('now') WHERE id=?").run(Math.round(value), snoozedAt, id);
}

export function setProvisional(db: DatabaseSync, id: number, v: boolean): void {
  db.prepare("UPDATE sessions SET provisional=?, updated_at=datetime('now') WHERE id=?").run(v ? 1 : 0, id);
}
export function setInputSeen(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE sessions SET input_seen=1, updated_at=datetime('now') WHERE id=?").run(id);
}

/** Record the latest parsed `eta:` marker. etaAt=null clears the countdown (done/none). We do
 *  NOT bump updated_at — "X ago" is the transcript mtime, and an ETA write isn't session activity. */
export function setSessionEta(db: DatabaseSync, id: number, etaAt: string | null, etaText: string | null, mtimeMs: number): void {
  db.prepare("UPDATE sessions SET eta_at=?, eta_text=?, eta_mtime=? WHERE id=?").run(etaAt, etaText, Math.round(mtimeMs), id);
}

/** Stamp the time we injected a `/eta` probe (throttle for re-probing). */
export function setSessionEtaProbe(db: DatabaseSync, id: number, atIso: string): void {
  db.prepare("UPDATE sessions SET eta_probe_at=? WHERE id=?").run(atIso, id);
}

/** Persist the ready-gate verdict so a server restart doesn't re-buy every cached classification. */
export function setSessionVerdict(db: DatabaseSync, id: number, mtimeMs: number, activity: string, reason: string, rev: number): void {
  db.prepare("UPDATE sessions SET verdict_mtime=?, verdict_activity=?, verdict_reason=?, verdict_rev=? WHERE id=?")
    .run(mtimeMs, activity, reason.slice(0, 160), rev, id);
}
export function deleteSession(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM items WHERE session_id=?").run(id);
  db.prepare("DELETE FROM diff_viewed WHERE session_id=?").run(id);
  db.prepare("DELETE FROM sessions WHERE id=?").run(id);
}

// ---- learning loop: training examples ----
export interface TrainingExample {
  id: number;
  ts: string;
  kind: string;
  state: any;
  predicted: any;
  correct: any;
  applied: number;
}
export function recordExample(db: DatabaseSync, kind: string, state: any, predicted: any, correct: any): number {
  const r = db
    .prepare("INSERT INTO training_examples (kind, state_json, predicted_json, correct_json) VALUES (?,?,?,?)")
    .run(kind, JSON.stringify(state ?? null), JSON.stringify(predicted ?? null), JSON.stringify(correct ?? null));
  return Number(r.lastInsertRowid);
}
/** FIX BB: record a STRONG, reasoned priority-feedback example (operator typed WHY). `source` =
 *  'explicit_reason', `weight` > 1 so the nightly tuner steps the weights harder than implicit
 *  signals. `state` carries the item's feature snapshot + direction (down|up). */
export function recordReasonExample(db: DatabaseSync, args: { state: any; predicted: any; correct: any; reason: string; weight: number }): number {
  const r = db
    .prepare("INSERT INTO training_examples (kind, state_json, predicted_json, correct_json, reason, source, weight) VALUES (?,?,?,?,?, 'explicit_reason', ?)")
    .run("explicit_reason", JSON.stringify(args.state ?? null), JSON.stringify(args.predicted ?? null), JSON.stringify(args.correct ?? null), args.reason || "", args.weight || 3);
  return Number(r.lastInsertRowid);
}
function parseExampleRow(r: any): TrainingExample {
  const j = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  return { id: r.id, ts: r.ts, kind: r.kind, state: j(r.state_json), predicted: j(r.predicted_json), correct: j(r.correct_json), applied: r.applied, reason: r.reason ?? null, source: r.source ?? null, weight: typeof r.weight === "number" ? r.weight : 1 } as any;
}
export function unappliedExamples(db: DatabaseSync, limit = 500): TrainingExample[] {
  const rows = db.prepare("SELECT * FROM training_examples WHERE applied=0 ORDER BY id ASC LIMIT ?").all(limit) as any[];
  return rows.map(parseExampleRow);
}
export function recentExamples(db: DatabaseSync, limit = 20): TrainingExample[] {
  const rows = db.prepare("SELECT * FROM training_examples ORDER BY id DESC LIMIT ?").all(limit) as any[];
  return rows.map(parseExampleRow);
}
export function markExamplesApplied(db: DatabaseSync, ids: number[]): void {
  if (!ids.length) return;
  const stmt = db.prepare("UPDATE training_examples SET applied=1 WHERE id=?");
  for (const id of ids) stmt.run(id);
}

// ---- learned weight deltas (small-LR tuning) ----
export function getLearnedWeights(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare("SELECT key, delta FROM learned_weights").all() as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key] = r.delta;
  return out;
}
export function bumpLearnedWeight(db: DatabaseSync, key: string, step: number, clamp = 20): number {
  db.prepare(
    `INSERT INTO learned_weights (key, delta) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET delta = MAX(${-clamp}, MIN(${clamp}, delta + ?)), updated_at = datetime('now')`
  ).run(key, Math.max(-clamp, Math.min(clamp, step)), step);
  return (db.prepare("SELECT delta FROM learned_weights WHERE key=?").get(key) as any).delta;
}

export function getDiffViewed(db: DatabaseSync, sessionId: number): Record<string, boolean> {
  const rows = db.prepare("SELECT file_path, viewed FROM diff_viewed WHERE session_id=?").all(sessionId) as unknown as { file_path: string; viewed: number }[];
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.file_path] = !!r.viewed;
  return out;
}

export function setDiffViewed(db: DatabaseSync, sessionId: number, filePath: string, viewed: boolean): void {
  db.prepare(
    `INSERT INTO diff_viewed (session_id, file_path, viewed) VALUES (?,?,?)
     ON CONFLICT(session_id, file_path) DO UPDATE SET viewed=?, updated_at=datetime('now')`
  ).run(sessionId, filePath, viewed ? 1 : 0, viewed ? 1 : 0);
}

/** Upsert a GitHub PR as a session row (kind='pr'). Keyed by a synthetic worktree_path. */
export function upsertPr(
  db: DatabaseSync,
  pr: {
    repo: string;
    number: number;
    title: string;
    url: string;
    author: string;
    updatedAt: string;
    reviewDecision: string;
    isDraft: boolean;
    additions: number;
    deletions: number;
    headRef?: string;
    baseRef?: string;
  }
): number {
  const key = `pr:${pr.repo}#${pr.number}`;
  const existing = db.prepare("SELECT id FROM sessions WHERE worktree_path=?").get(key) as { id: number } | undefined;
  if (existing) {
    // completed_at=NULL: the PR is verifiably still OPEN (we are inside the scan of open PRs), so a
    // card completed by a session sweep must resurrect — otherwise the open PR is invisible forever.
    db.prepare(
      `UPDATE sessions SET title=?, repo=?, pr_url=?, pr_author=?, pr_updated_at=?, pr_review_decision=?,
         pr_draft=?, pr_additions=?, pr_deletions=?, pr_head_ref=?, pr_base_ref=?, state='WAITING_INPUT', completed_at=NULL, completed_by=NULL, updated_at=datetime('now') WHERE id=?`
    ).run(
      pr.title,
      pr.repo,
      pr.url,
      pr.author,
      pr.updatedAt,
      pr.reviewDecision,
      pr.isDraft ? 1 : 0,
      pr.additions,
      pr.deletions,
      pr.headRef ?? null,
      pr.baseRef ?? null,
      existing.id
    );
    return existing.id;
  }
  const slot = nextSlot(db);
  const info = db
    .prepare(
      `INSERT INTO sessions (slot,title,repo,worktree_path,branch,state,kind,pr_repo,pr_number,pr_url,pr_author,
         pr_updated_at,pr_review_decision,pr_draft,pr_additions,pr_deletions,pr_head_ref,pr_base_ref,discovered)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      slot,
      pr.title,
      pr.repo,
      key,
      `pr/${pr.number}`,
      "WAITING_INPUT",
      "pr",
      pr.repo,
      pr.number,
      pr.url,
      pr.author,
      pr.updatedAt,
      pr.reviewDecision,
      pr.isDraft ? 1 : 0,
      pr.additions,
      pr.deletions,
      pr.headRef ?? null,
      pr.baseRef ?? null,
      0
    );
  return Number(info.lastInsertRowid);
}

/** Upsert a kanban card as a session row (kind='kanban'). Keyed by its synthetic key. */
export function upsertKanban(
  db: DatabaseSync,
  card: { key: string; title: string; file: string; column: string }
): number {
  const existing = db.prepare("SELECT id FROM sessions WHERE worktree_path=?").get(card.key) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE sessions SET title=?, kanban_file=?, kanban_column=?, state='WAITING_INPUT', updated_at=datetime('now') WHERE id=?"
    ).run(card.title, card.file, card.column, existing.id);
    return existing.id;
  }
  const slot = nextSlot(db);
  const info = db
    .prepare(
      `INSERT INTO sessions (slot,title,repo,worktree_path,branch,state,kind,kanban_file,kanban_column,discovered)
       VALUES (?,?,?,?,?,?,?,?,?,0)`
    )
    .run(slot, card.title, "kanban", card.key, `kanban/${card.column}`, "WAITING_INPUT", "kanban", card.file, card.column);
  return Number(info.lastInsertRowid);
}

/** Remove kanban sessions (and items) whose card is no longer a current candidate. */
export function pruneKanban(db: DatabaseSync, keepKeys: Set<string>): void {
  const rows = db.prepare("SELECT id, worktree_path FROM sessions WHERE kind='kanban'").all() as unknown as {
    id: number;
    worktree_path: string;
  }[];
  for (const r of rows) {
    if (!keepKeys.has(r.worktree_path)) {
      db.prepare("DELETE FROM items WHERE session_id=?").run(r.id);
      db.prepare("DELETE FROM sessions WHERE id=?").run(r.id);
    }
  }
}

/** Read a singleton bookkeeping value (see the `meta` table). undefined if unset. */
export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  return r?.value;
}

/** Write a singleton bookkeeping value (upsert). */
export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')"
  ).run(key, value);
}

/** Remove PR sessions (and their items) that are no longer open. When `scannedRepos` is given,
 *  only cards from those repos are eligible — a repo whose gh listing failed this round must not
 *  have its cards wiped (they'd flap back on the next good scan). Card keys are `pr:owner/name#N`. */
/** MERGE-RECONCILE: reflect a JUST-MERGED PR in the local DB immediately, the same way the
 *  throttled scanPrs eventually would. Without this, a successful `gh pr merge` writes nothing
 *  locally, so the card lingers — with a live merge button — until the next PR scan (which the
 *  post-merge tick usually skips, since scanPrs only runs every `pr_scan_interval_ms`, default
 *  60s). The operator then sees "the same thing come up again" and can click merge on an
 *  already-merged PR. Mirrors scanPrs's own reconciliation: a kind='pr' card is DELETED (like
 *  pruneClosedPrs — the card IS the PR), a PR-tagged claude session is UNTAGGED (drops the PR
 *  badge + merge button + min-priority floor, but keeps the session). Returns what it did so the
 *  caller can offer undo (and so it's unit-testable without gh). */
export function reconcileMergedPr(
  db: DatabaseSync,
  sessionId: number
): {
  action: "deleted" | "untagged" | "none";
  prev?: { pr_repo: string | null; pr_number: number | null; pr_head_ref: string | null; pr_base_ref: string | null };
} {
  const s = db
    .prepare("SELECT id, kind, repo, pr_repo, pr_number, pr_head_ref, pr_base_ref FROM sessions WHERE id=?")
    .get(sessionId) as
    | { kind: string; pr_repo: string | null; pr_number: number | null; pr_head_ref: string | null; pr_base_ref: string | null }
    | undefined;
  if (!s) return { action: "none" };
  if (s.kind === "pr") {
    db.prepare("DELETE FROM items WHERE session_id=?").run(sessionId);
    db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
    return { action: "deleted" };
  }
  if (s.pr_repo || s.pr_number) {
    const prev = {
      pr_repo: s.pr_repo ?? null,
      pr_number: s.pr_number ?? null,
      pr_head_ref: s.pr_head_ref ?? null,
      pr_base_ref: s.pr_base_ref ?? null,
    };
    db.prepare(
      "UPDATE sessions SET pr_repo=NULL, pr_number=NULL, pr_head_ref=NULL, pr_base_ref=NULL, updated_at=datetime('now') WHERE id=?"
    ).run(sessionId);
    return { action: "untagged", prev };
  }
  return { action: "none" };
}

// ---- chat_log: gist beats / chat messages / logged prompts (the conversation record) ----
export type ChatScope = "task" | "global";
export type ChatRole = "user" | "assistant" | "gist" | "system";

export interface ChatLogInput {
  scope: ChatScope;
  role: ChatRole;
  content?: string | null;
  sessionId?: number | null;
  itemId?: number | null;
  prompt?: string | null;
  personaSnapshot?: string | null;
  model?: string | null;
}

export interface ChatLogRow {
  id: number;
  scope: string | null;
  session_id: number | null;
  item_id: number | null;
  role: string;
  content: string | null;
  prompt: string | null;
  persona_snapshot: string | null;
  model: string | null;
  created_at: string;
}

/** Append one row to chat_log. Best-effort: a logging failure must never break the caller. */
export function logChat(db: DatabaseSync, e: ChatLogInput): number {
  try {
    const r = db
      .prepare(
        `INSERT INTO chat_log (scope, session_id, item_id, role, content, prompt, persona_snapshot, model)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        e.scope,
        e.sessionId ?? null,
        e.itemId ?? null,
        e.role,
        e.content ?? null,
        e.prompt ?? null,
        e.personaSnapshot ?? null,
        e.model ?? null
      );
    return Number(r.lastInsertRowid);
  } catch {
    return 0;
  }
}

/** Recent chat_log rows, newest-first, optionally filtered by scope and/or session. */
export function recentChat(
  db: DatabaseSync,
  opts: { scope?: ChatScope; sessionId?: number; roles?: ChatRole[]; limit?: number } = {}
): ChatLogRow[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.scope) { where.push("scope = ?"); args.push(opts.scope); }
  if (typeof opts.sessionId === "number") { where.push("session_id = ?"); args.push(opts.sessionId); }
  if (opts.roles && opts.roles.length) {
    where.push(`role IN (${opts.roles.map(() => "?").join(",")})`);
    args.push(...opts.roles);
  }
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const sql = `SELECT * FROM chat_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit) as unknown as ChatLogRow[];
}

// ---- cross_reviews: Claude ↔ Codex second-opinion reviews ----
export interface CrossReviewRow {
  id: number;
  session_id: number;
  reviewer: string;
  author: string;
  base: string | null;
  changed_lines: number;
  ok: number;
  markdown: string | null;
  created_at: string;
}

/** Persist a cross-review run. Returns the new row id (0 on failure — best-effort). */
export function insertCrossReview(
  db: DatabaseSync,
  r: { sessionId: number; reviewer: string; author: string; base: string; changedLines: number; ok: boolean; markdown: string }
): number {
  try {
    const info = db.prepare(
      "INSERT INTO cross_reviews (session_id, reviewer, author, base, changed_lines, ok, markdown) VALUES (?,?,?,?,?,?,?)"
    ).run(r.sessionId, r.reviewer, r.author, r.base || null, r.changedLines || 0, r.ok ? 1 : 0, r.markdown || "");
    return Number(info.lastInsertRowid);
  } catch { return 0; }
}

/** The most recent cross-review for a session, or null. */
export function latestCrossReview(db: DatabaseSync, sessionId: number): CrossReviewRow | null {
  try {
    return (db.prepare("SELECT * FROM cross_reviews WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as unknown as CrossReviewRow) || null;
  } catch { return null; }
}

export function pruneClosedPrs(db: DatabaseSync, openKeys: Set<string>, scannedRepos?: string[]): void {
  const prs = db.prepare("SELECT id, worktree_path FROM sessions WHERE kind='pr'").all() as unknown as {
    id: number;
    worktree_path: string;
  }[];
  for (const p of prs) {
    if (scannedRepos) {
      const m = /^pr:(.+)#\d+$/.exec(p.worktree_path || "");
      if (!m || !scannedRepos.includes(m[1])) continue;
    }
    if (!openKeys.has(p.worktree_path)) {
      db.prepare("DELETE FROM items WHERE session_id=?").run(p.id);
      db.prepare("DELETE FROM sessions WHERE id=?").run(p.id);
    }
  }
}
