/**
 * Editable configuration loader. All tunables live in JSON files under config/
 * so the operator owns them in open formats. Nothing here is hard-coded magic.
 */
import * as fs from "fs";
import * as path from "path";

export interface Weights {
  llm_importance: number;
  blocks_other_work: number;
  effort_small: number;
  staleness: number;
  focus_match: number;
  deadline: number;
  needs_input_bonus: number;
  done_bonus: number;
  idle_base?: number; // FIX W: base score for surfaced idle/UNKNOWN sessions (negative → bottom)
}

export interface TriageConfig {
  simple_question_max_chars: number;
  review_diff_min_changed_lines: number;
  complex_question_min_options: number;
  quiet_period_ms: number;
  uncertain_calls_claude: boolean;
}

export interface EtaConfig {
  enabled: boolean; // master switch for the /eta probe feature
  probe_after_min: number; // only probe a parked session quiet at least this many minutes
  reprobe_min: number; // after any probe/answer, wait this long before asking again
}

/** The "ready gate" (card 288): the cadence of the double-sample stability check + the Haiku final
 *  classifier that together GUARANTEE nothing enters Up Next while it's still working / self-blocked. */
export interface StateGateConfig {
  classifier_enabled: boolean;   // master switch for the model final gate (off → heuristic + double-sample only)
  model?: string;                // which model reads tails for the verdict (default sonnet — see eval:verifier)
  double_sample_gap_ms: number;  // transcript+CPU must be byte-stable across this gap before a session is eligible
  settle_ms: number;             // don't classify a session that wrote within this (still settling)
  min_verify_interval_ms: number;// cap re-classify cost for a long-running session to ~1 model call per this
  surface_verify_window_ms?: number; // LEGACY, unused — every alive candidate is gated now (kept so old configs load)
  cpu_busy_frac: number;         // process-tree CPU fraction (0..1) that counts as "still computing" (claudectl: >5%)
  fail_open_attempts?: number;   // consecutive failed classifier checks before surfacing the stable heuristic state
  self_wait_ttl_min?: number;    // WAITING_ON_SELF hides only while quiet < this many minutes (0 = forever)
}

export interface FullConfig {
  weights: Weights;
  triage: TriageConfig;
  models: { triage: string; summary: string };
  focus: string;
  pr_repos: string[]; // GitHub repos to scan for open PRs, e.g. ["your-org/your-repo"]
  pr_scan_interval_ms: number; // how often to poll GitHub (gh pr list) for open PRs per repo
  pr_min_priority: number; // floor on the ORGANIC score of a PR-backed item (an open PR is visible by default); operator gestures (snooze, h/l, manual score) apply after it and can rank the PR lower
  kanban_path: string; // root of the kanban board
  viz_dir: string; // root of per-task visualization folders (<viz_dir>/<task-slug>/*.html)
  viz_mention_roots: string[]; // containment roots for transcript-MENTIONED html (worktree + viz_dir always allowed)
  min_active_tasks: number; // top up the ready queue from kanban below this many real items
  kanban_auto_launch: boolean; // engine-side auto-launch of the top #-ready STARTABLE card when below threshold (off → surface only)
  kanban_auto_cooldown_min: number; // min minutes between two auto-launches (load-bearing anti-stampede; readyClaudeCount lags)
  kanban_column_order: string[]; // column folders in priority order
  kanban_repo: string; // repo to launch a kanban task's Claude session into
  sessions_repos: string[]; // repos offered in the "new session" launcher (← in detail)
  sessions_default_repo: string; // repo used for the instant new-session launch (← / Ctrl+B C/c)
  tick_interval_ms: number; // main engine tick cadence (server)
  terminal_poll_ms: number; // live-terminal capture poll cadence (renderer)
  terminal_font_size: number; // FIX V: xterm font size (px) — bigger = fewer cols, more readable
  pr_merge_strategy: "squash" | "merge" | "rebase"; // FIX X: gh pr merge strategy
  auto_open_terminal_on_complex: boolean; // COMPLEX_DECISION cards auto-open the live terminal on first focus
  auto_diff_on_pr_review: boolean; // PR / REVIEW_DIFF items default to the full split diff on first focus
  auto_html_on_viz: boolean; // a task that has an HTML visualization auto-surfaces it in Pane A (left)
  snooze_penalty: number; // score penalty applied per snooze (negative); item stays VISIBLE, just sinks
  snooze_recover_hours: number; // the snooze penalty decays LINEARLY back to 0 over this many hours (item slowly climbs back to its natural rank)
  reap_completed_tmux_hours: number; // nightly: kill the orphan tmux for sessions COMPLETED (Ctrl+G e) more than this many hours ago. 0/negative disables.
  auto_complete_idle_hours: number;
  teammate_idle_reap_hours: number; // teammates (machinery) are reaped on this much shorter idle window // nightly: auto-complete (archive + reap terminals) any claude session SILENT — transcript untouched — for this many hours; covers teammates/one-shot jobs nobody Ctrl+G e's, and dead sessions. 0/negative disables.
  guarantee_resurface_hours: number;
  dismiss_reopen_grace_min: number; // a dismissed card whose session is STILL waiting reopens after this many minutes // completeness invariant: a decided/dismissed card whose session then stays COMPLETELY silent (no new turn, no future ETA) this many hours reopens in Up Next. 0/negative disables.
  learning_rate: number; // nightly small-LR step for the learned weight deltas
  // How strongly each FEEDBACK SIGNAL teaches the nightly tuner (multiplies learning_rate):
  implicit_learn_weight?: number;  // SILENT signals — just picking a non-top task (leapfrog) or snoozing. Small → learn very little from a silent pick.
  direction_learn_weight?: number; // h/l with NO typed reason — a bare up/down nudge. Moderate.
  reason_learn_weight?: number;    // h/l WITH a typed reason ("I don't want this because X"). Large → learn a lot from reasoned feedback.
  default_base_branch: string; // branch any session's Diff view compares against (e.g. main)
  eta: EtaConfig; // /eta probe for long-running silent sessions
  state_gate: StateGateConfig;
  auto_continue?: { enabled?: boolean; quiet_ms?: number; max_attempts?: number; retry_ms?: number; message?: string }; // the double-sample + Haiku ready-gate (card 288)
  enrich_fyi_with_model?: boolean; // default false: FYI_DONE cards use the free deterministic excerpt
  pane_a_frac_default: number; // default A|B split (Pane A share) for normal/question tasks
  pane_a_frac_pr: number; // default A|B split for PR/review tasks (narrower Overview, wider Diff)
  soul_source?: { repo: string; path: string }; // canonical SOUL.md source in the CRM repo (git sync)
}

export type Keymap = Record<string, string>;

const CONFIG_DIR =
  process.env.COCKPIT_CONFIG_DIR || path.resolve(__dirname, "../../config");

export function configDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): FullConfig {
  const raw = JSON.parse(
    fs.readFileSync(path.join(CONFIG_DIR, "weights.json"), "utf8")
  );
  return {
    weights: raw.weights,
    triage: raw.triage,
    models: raw.models,
    focus: raw.focus || "",
    pr_repos: Array.isArray(raw.pr_repos) ? raw.pr_repos : [],
    pr_scan_interval_ms: typeof raw.pr_scan_interval_ms === "number" ? raw.pr_scan_interval_ms : 60000,
    pr_min_priority: typeof raw.pr_min_priority === "number" ? raw.pr_min_priority : 30,
    kanban_path: raw.kanban_path || "", // optional feature; empty = off
    viz_dir: raw.viz_dir || "", // optional HTML-visualization feature; empty = off
    viz_mention_roots: Array.isArray(raw.viz_mention_roots)
      ? raw.viz_mention_roots.filter((x: any) => typeof x === "string" && x)
      : typeof raw.viz_mention_roots === "string" && raw.viz_mention_roots
        ? [raw.viz_mention_roots]
        // Containment roots for transcript-MENTIONED html: a session that writes an HTML report
        // anywhere under your $HOME surfaces it in the HTML pane. Still mtime-gated (>= session
        // start) + hidden-component guarded (~/.cache etc. blocked), so old/vendored htmls don't
        // become noise tabs. Add more roots in config/weights.json (viz_mention_roots).
        : (process.env.HOME ? [process.env.HOME] : []),
    min_active_tasks: typeof raw.min_active_tasks === "number" ? raw.min_active_tasks : 4,
    kanban_auto_launch: raw.kanban_auto_launch === true, // default OFF (safe rollout) — opt in via config
    kanban_auto_cooldown_min: typeof raw.kanban_auto_cooldown_min === "number" ? raw.kanban_auto_cooldown_min : 30,
    kanban_column_order: Array.isArray(raw.kanban_column_order)
      ? raw.kanban_column_order
      : ["_work", "4_today", "3_week", "2_planned", "1_unplanned", "0_backlog"],
    kanban_repo: raw.kanban_repo || "",
    sessions_repos: Array.isArray(raw.sessions_repos) && raw.sessions_repos.length
      ? raw.sessions_repos
      : (raw.kanban_repo ? [raw.kanban_repo] : []),
    sessions_default_repo: raw.sessions_default_repo || raw.kanban_repo || "",
    tick_interval_ms: typeof raw.tick_interval_ms === "number" ? raw.tick_interval_ms : 2000,
    terminal_poll_ms: typeof raw.terminal_poll_ms === "number" ? raw.terminal_poll_ms : 200,
    terminal_font_size: typeof raw.terminal_font_size === "number" ? raw.terminal_font_size : 15,
    pr_merge_strategy: ["squash", "merge", "rebase"].includes(raw.pr_merge_strategy) ? raw.pr_merge_strategy : "squash",
    auto_open_terminal_on_complex: raw.auto_open_terminal_on_complex !== false, // default ON
    auto_diff_on_pr_review: raw.auto_diff_on_pr_review !== false, // default ON
    auto_html_on_viz: raw.auto_html_on_viz !== false, // default ON
    snooze_penalty: typeof raw.snooze_penalty === "number" ? raw.snooze_penalty : -100,
    snooze_recover_hours: typeof raw.snooze_recover_hours === "number" ? raw.snooze_recover_hours : 5,
    reap_completed_tmux_hours: typeof raw.reap_completed_tmux_hours === "number" ? raw.reap_completed_tmux_hours : 5,
    auto_complete_idle_hours: typeof raw.auto_complete_idle_hours === "number" ? raw.auto_complete_idle_hours : 20,
    teammate_idle_reap_hours: typeof raw.teammate_idle_reap_hours === "number" ? raw.teammate_idle_reap_hours : 3,
    guarantee_resurface_hours: typeof raw.guarantee_resurface_hours === "number" ? raw.guarantee_resurface_hours : 6,
    dismiss_reopen_grace_min: typeof raw.dismiss_reopen_grace_min === "number" ? raw.dismiss_reopen_grace_min : 15,
    learning_rate: typeof raw.learning_rate === "number" ? raw.learning_rate : 0.05,
    implicit_learn_weight: typeof raw.implicit_learn_weight === "number" ? raw.implicit_learn_weight : 0.1,
    direction_learn_weight: typeof raw.direction_learn_weight === "number" ? raw.direction_learn_weight : 5,
    reason_learn_weight: typeof raw.reason_learn_weight === "number" ? raw.reason_learn_weight : 15,
    default_base_branch: raw.default_base_branch || "main",
    eta: {
      enabled: raw.eta?.enabled !== false, // default ON
      probe_after_min: typeof raw.eta?.probe_after_min === "number" ? raw.eta.probe_after_min : 30,
      reprobe_min: typeof raw.eta?.reprobe_min === "number" ? raw.eta.reprobe_min : 30,
    },
    state_gate: {
      classifier_enabled: raw.state_gate?.classifier_enabled !== false, // default ON
      model: typeof raw.state_gate?.model === "string" ? raw.state_gate.model : undefined, // engine defaults to sonnet when unset
      double_sample_gap_ms: typeof raw.state_gate?.double_sample_gap_ms === "number" ? raw.state_gate.double_sample_gap_ms : 5000,
      settle_ms: typeof raw.state_gate?.settle_ms === "number" ? raw.state_gate.settle_ms : 1200,
      min_verify_interval_ms: typeof raw.state_gate?.min_verify_interval_ms === "number" ? raw.state_gate.min_verify_interval_ms : 6000,
      surface_verify_window_ms: typeof raw.state_gate?.surface_verify_window_ms === "number" ? raw.state_gate.surface_verify_window_ms : 120000,
      cpu_busy_frac: typeof raw.state_gate?.cpu_busy_frac === "number" ? raw.state_gate.cpu_busy_frac : 0.05,
      fail_open_attempts: typeof raw.state_gate?.fail_open_attempts === "number" ? raw.state_gate.fail_open_attempts : 3,
      self_wait_ttl_min: typeof raw.state_gate?.self_wait_ttl_min === "number" ? raw.state_gate.self_wait_ttl_min : 60,
    },
    enrich_fyi_with_model: raw.enrich_fyi_with_model === true,
    auto_continue: raw.auto_continue && typeof raw.auto_continue === "object" ? raw.auto_continue : {},
    pane_a_frac_default: typeof raw.pane_a_frac_default === "number" ? raw.pane_a_frac_default : 0.4,
    pane_a_frac_pr: typeof raw.pane_a_frac_pr === "number" ? raw.pane_a_frac_pr : 0.3,
    soul_source:
      raw.soul_source && typeof raw.soul_source === "object" && raw.soul_source.repo && raw.soul_source.path
        ? { repo: String(raw.soul_source.repo), path: String(raw.soul_source.path) }
        : undefined,
  };
}

export function saveFocus(focus: string): void {
  const p = path.join(CONFIG_DIR, "weights.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  raw.focus = focus;
  fs.writeFileSync(p, JSON.stringify(raw, null, 2));
}

export function saveWeights(weights: Weights): void {
  const p = path.join(CONFIG_DIR, "weights.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  raw.weights = weights;
  fs.writeFileSync(p, JSON.stringify(raw, null, 2));
}

export function loadKeymap(): Keymap {
  const raw = JSON.parse(
    fs.readFileSync(path.join(CONFIG_DIR, "keymap.json"), "utf8")
  );
  const map: Keymap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    map[k] = v as string;
  }
  return map;
}
