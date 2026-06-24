/**
 * Auto-discover the operator's most-recently-active Claude Code sessions from
 * ~/.claude/projects and register them so the cockpit is never empty and always
 * reflects real work. We take the N transcripts written most recently, derive each
 * session's working directory + a title, and upsert it. State detection then decides
 * which (if any) are actually ready to surface.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { DatabaseSync } from "node:sqlite";
import { upsertSession, upsertDiscoveredSession, clearLivePanes } from "./db";
import { SessionManager } from "./sessions";

interface Meta {
  cwd: string;
  title: string;
  mtimeMs: number;
  // Claude Code TEAM sub-agent markers: present as top-level fields on every transcript line of a
  // teammate session (reviewer-r1, worker, …); absent on normal operator sessions.
  teamName: string | null;
  agentName: string | null;
}
const metaCache = new Map<string, Meta>(); // transcriptPath -> meta (keyed by mtime)

/** FIX C: read only the HEAD (~64KB) of a transcript — cwd + first user prompt are near the
 *  START, so we must NOT read the whole 14–21MB file just to derive the title. */
async function readHead(file: string, bytes = 64 * 1024): Promise<string> {
  const fh = await fs.promises.open(file, "r");
  try {
    const st = await fh.stat();
    const len = Math.min(bytes, Number(st.size));
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf.toString("utf8");
  } finally { await fh.close(); }
}


/** Deterministic infrastructure tags from transcript content — zero model cost (operator request
 *  2026-06-12: "as soon as it uses a GPU/EC2 it should be tagged in the task queue").
 *  - "ec2": the session actually operates AWS EC2 — an instance id, a real `aws ec2|autoscaling`
 *    call, or a concrete *sized* instance type (g5.48xlarge).
 *  - "gpu": the session actually operates a GPU — nvidia-smi, a torchrun/DDP launch, or CUDA.
 *
 *  PRECISION over recall (operator complaint 2026-06-15: ec2/gpu chips fired on ~every session):
 *  1. Scan ONLY genuine conversation — strip the injected <system-reminder> blocks first. They carry
 *     the project CLAUDE.md + auto-memory, both saturated with EC2/GPU/CUDA/nvidia/g5 references, so
 *     every young your-repo session (whose tail WAS that injection) matched.
 *  2. Require an OPERATIONAL token, not a bare mention. The old `/\bEC2\b/i` and `/\bGPUs?\b/i`
 *     matched casual discussion ("the GPUs are idle", "PR #53: ec2/gpu chips") — dropped.
 *  Merged with the haiku category tags by the engine, which treats infra tags as AUTHORITATIVE
 *  (re-derives them every scan, removing stale ones) — see engine.ts. */
export function infraTags(raw: string): string[] {
  const t: string[] = [];
  if (!raw) return t;
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");
  if (/\bi-0[0-9a-f]{16}\b/.test(text) ||
      /\baws\s+(ec2|autoscaling)\s+[a-z][a-z-]+/.test(text) ||
      /\b(g4dn|g5|g6|p4d|p5|p5e|c7i|m7i|r6i)\.[0-9]*[a-z]+\b/.test(text)) t.push("ec2");
  if (/\bnvidia-smi\b/.test(text) || /\btorchrun\b/.test(text) ||
      /\bCUDA(_VISIBLE_DEVICES)?\b/.test(text) || /\bcuda:\d\b/.test(text)) t.push("gpu");
  return t;
}

export async function deriveMeta(file: string, mtimeMs: number): Promise<Meta | null> {
  const cached = metaCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let raw: string;
  try {
    raw = await readHead(file); // HEAD only (~64KB), not the full file
  } catch {
    return null;
  }
  let cwd = "";
  let title = "";
  let teamName: string | null = null;
  let agentName: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!teamName && typeof o.teamName === "string" && o.teamName) teamName = o.teamName;
    if (!agentName && typeof o.agentName === "string" && o.agentName) agentName = o.agentName;
    // first real user prompt becomes the title
    if (!title && o.type === "user" && o.message) {
      const c = o.message.content;
      let t = "";
      if (typeof c === "string") t = c;
      else if (Array.isArray(c)) {
        const tb = c.find((b: any) => b && b.type === "text");
        if (tb) t = tb.text;
      }
      t = (t || "").trim();
      // A teammate's first prompt arrives wrapped in a <teammate-message …> envelope; unwrap it so
      // the REAL text is visible to the title + agent-noise signature checks (it otherwise starts
      // with "<", gets skipped, and the session masquerades as basename(cwd)).
      const tm = /^<teammate-message[^>]*>\s*([\s\S]*?)\s*<\/teammate-message>/.exec(t);
      if (tm) t = tm[1].trim();
      // skip tool_result-only / command wrapper noise
      if (t && !t.startsWith("<") && !t.startsWith("Caveat:")) title = t.replace(/\s+/g, " ").slice(0, 80);
    }
    if (cwd && title && teamName && agentName) break;
  }
  if (!cwd) return null;
  if (!title) title = path.basename(cwd);
  const m = { cwd, title, mtimeMs, teamName, agentName };
  metaCache.set(file, m);
  return m;
}

const execFileP = promisify(execFile);

// P0: cache gitInfo(cwd) → {repo,branch} with a 60s TTL. repo/branch rarely change, so the 5s
// discovery tick must NOT re-spawn `git rev-parse` twice per session every time — that was
// ~40 blocking subprocess spawns/tick freezing the terminal. Now ~all ticks are cache hits.
const _gitInfoCache = new Map<string, { at: number; val: { repo: string; branch: string } }>();
async function gitInfo(cwd: string): Promise<{ repo: string; branch: string }> {
  const c = _gitInfoCache.get(cwd);
  if (c && Date.now() - c.at < 60_000) return c.val;
  let val: { repo: string; branch: string };
  try {
    // ASYNC execFile → yields to the event loop, so the terminal WS keeps flowing during the tick.
    const [top, branch] = await Promise.all([
      execFileP("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).then((r) => r.stdout.trim()).catch(() => ""),
      execFileP("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).then((r) => r.stdout.trim()).catch(() => ""),
    ]);
    val = { repo: top ? path.basename(top) : path.basename(cwd), branch: branch || "-" };
  } catch {
    val = { repo: path.basename(cwd), branch: "-" };
  }
  _gitInfoCache.set(cwd, { at: Date.now(), val });
  return val;
}

// Don't surface the cockpit's own internal claude -p helper calls as sessions.
const INTERNAL_PROMPT_SIGNATURES = [
  "A Claude Code session is waiting on its operator",
  "You are a triage classifier",
  "You rank a Claude Code session",
  "Summarize this code change for a fast review",
  "A Claude Code session just finished",
  // build/orchestration + test-probe noise (this very build task + eval probes)
  "Use ultrathink. Start coding now and build this",
  "Use ultrathink",
  "Ask me exactly one short question",
  "Say: result:",
  "Reply with exactly the word",
  "Count slowly to twenty",
  "Reply with only valid minified JSON",
  "Read HEARTBEAT.md",
  "You are the operator's assistant",
];

// Agent / review SUB-SESSIONS (from /prteam, code-review, the supervisor swarm) — NOT the
// operator's own tasks. Matched anywhere in the first prompt (not just the start).
const AGENT_SUBSESSION_SIGNATURES = [
  "Tiered ensemble PR review",
  "thorough code review",
  "Perform a thorough code review",
  "You are an independent reviewer",
  "code-reviewer",
  "security engineer",
  "security-review",
  "/prteam",
  'You are "reviewer',
  'You are "worker',
  "debate-arbitrated",
];

function isAgentNoise(title: string): boolean {
  const t = (title || "").toLowerCase();
  return AGENT_SUBSESSION_SIGNATURES.some((sig) => t.includes(sig.toLowerCase()));
}

function envNoTmux(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.TMUX;
  delete e.TMUX_PANE;
  // The cockpit server is launched via `systemd --user` with a minimal PATH that omits ~/.local/bin
  // — where `claude` lives. Without this, `claude agents --json` (the session→pane mapping) silently
  // returns nothing → every session shows read-only. Guarantee the user's local bin is on PATH for
  // our subprocess spawns, regardless of how the server was started.
  const localBin = `${os.homedir()}/.local/bin`;
  if (!e.PATH) e.PATH = localBin;
  else if (!e.PATH.split(":").includes(localBin)) e.PATH = `${localBin}:${e.PATH}`;
  return e;
}

interface LivePane { paneId: string; panePid: number; cmd: string; target: string; cwd: string; }

/** All live tmux panes (default socket) whose command looks like a Claude Code session.
 *  ASYNC so the 5s tick doesn't block the event loop on the tmux subprocess. */
async function listClaudePanes(): Promise<LivePane[]> {
  let out = "";
  try {
    const r = await execFileP(
      "tmux",
      ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_path}"],
      { encoding: "utf8", env: envNoTmux() }
    );
    out = r.stdout;
  } catch {
    return [];
  }
  const panes: LivePane[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, pid, cmd, target, cwd] = line.split("\t");
    if (!paneId || !pid) continue;
    panes.push({ paneId, panePid: parseInt(pid, 10), cmd: (cmd || "").trim(), target: (target || "").trim(), cwd: (cwd || "").trim() });
  }
  return panes;
}

// macOS has no /proc. Build a pid→ppid snapshot once via `ps` and cache it briefly so a single
// discovery tick (which walks many parent chains) shares one cheap spawn instead of N.
let _ppidMapDarwin: { at: number; map: Map<number, number> } | null = null;
function ppidMapDarwin(): Map<number, number> {
  if (_ppidMapDarwin && Date.now() - _ppidMapDarwin.at < 3000) return _ppidMapDarwin.map;
  const map = new Map<number, number>();
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 8000 });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) map.set(parseInt(m[1], 10), parseInt(m[2], 10));
    }
  } catch { /* ps missing/errored → empty map; chain walk just stops early */ }
  _ppidMapDarwin = { at: Date.now(), map };
  return map;
}

/** Parent pid of `pid`. Linux: /proc/<pid>/stat (4th field; comm may contain spaces/parens, so
 *  parse after the LAST ')'). macOS/other: a cached `ps -axo pid=,ppid=` snapshot. Returns 0 if unknown. */
function ppidOf(pid: number): number {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2); // skip "<state> "
      const parts = after.split(" ");
      return parseInt(parts[1], 10) || 0; // state, ppid, ...
    } catch { return 0; }
  }
  return ppidMapDarwin().get(pid) || 0;
}

/** Scan ALL processes for an open transcript (.jsonl under ~/.claude/projects), returning
 *  pid → transcript path. Claude Code keeps its session transcript open, so this reliably
 *  enumerates every live claude session regardless of tmux pane churn. */
const TRANSCRIPT_FD_RE = /\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/;
function scanOpenTranscripts(): Map<number, string> {
  const map = new Map<number, string>();
  if (process.platform === "linux") {
    let pids: string[];
    try { pids = fs.readdirSync("/proc"); } catch { return map; }
    for (const ent of pids) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = parseInt(ent, 10);
      let fds: string[];
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        let link: string;
        try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        if (TRANSCRIPT_FD_RE.test(link)) { map.set(pid, link); break; }
      }
    }
    return map;
  }
  // macOS/other: no /proc. Ask lsof for files held open by `claude` processes, in field mode
  // (`-F pn` → alternating `p<pid>` / `n<path>` lines). NOTE: some Claude builds append-and-close
  // the transcript rather than holding it open, so this fallback may be empty — the PRIMARY
  // mapping is `claude agents --json` (paneBySession). This just mirrors the Linux fd fallback.
  try {
    const out = execFileSync("lsof", ["-nP", "-w", "-c", "claude", "-F", "pn"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 8000 });
    let pid = 0;
    for (const line of out.split("\n")) {
      if (line[0] === "p") pid = parseInt(line.slice(1), 10) || 0;
      else if (line[0] === "n" && pid) {
        const name = line.slice(1);
        if (TRANSCRIPT_FD_RE.test(name) && !map.has(pid)) map.set(pid, name);
      }
    }
  } catch { /* lsof missing/errored → empty; claude-agents mapping still applies */ }
  return map;
}

/** Walk UP the parent chain from `pid` until we hit a pid that is a known tmux pane pid.
 *  Returns the matching LivePane, or null. Robust to intermediate processes + pane churn. */
function paneForPid(pid: number, paneByPid: Map<number, LivePane>): LivePane | null {
  let cur = pid, hops = 0;
  while (cur > 1 && hops < 12) {
    const pane = paneByPid.get(cur);
    if (pane) return pane;
    cur = ppidOf(cur);
    hops++;
  }
  return null;
}

/** Transcript cwds we never surface: ephemeral / orchestration / cockpit-internal trees. */
function isExcludedCwd(cwd: string, cockpitRoot: string): boolean {
  const home = os.homedir();
  // Ephemeral /tmp scratch — but NOT a home dir that itself lives under /tmp (test homes do;
  // real operator homes never do, so real /tmp sessions are still excluded).
  if ((cwd === "/tmp" || cwd.startsWith("/tmp/")) && cwd !== home && !cwd.startsWith(home + path.sep)) return true;
  const excluded = [
    path.join(home, ".claude"),     // all cockpit/orchestration internal trees (jobs/teams/worktrees/control-tower/…)
    path.join(home, ".openclaw"),   // openclaw orchestration workspace
    // NOTE: the cockpit repo ROOT is intentionally NOT excluded — the operator dogfoods ClaudeOS by
    // running real Claude Code sessions IN this repo, and wants them surfaced like any other work.
    // We still hide the repo's OWN internal orchestration tree (.claude/worktrees/jobs/agents), and
    // the cockpit's `claude -p` helper calls are filtered separately (neutral /tmp cwd + title sigs).
    path.join(cockpitRoot, ".claude"),
  ];
  return excluded.some((p) => cwd === p || cwd.startsWith(p + path.sep));
}

function isFilteredTitle(title: string): boolean {
  return INTERNAL_PROMPT_SIGNATURES.some((sig) => title.startsWith(sig.slice(0, 40))) || isAgentNoise(title);
}

/** The fixed tag vocabulary the auto-tagger may assign (closed set → stable chip colors). */
export const SESSION_TAGS = ["training", "inference", "data", "claudeos", "infra", "babysit", "other"] as const;

/** Read the first few REAL operator prompts from a transcript head (~256KB) — the raw material
 *  for the auto title + tag. Cached by (path, mtime) so the tick never re-parses unchanged files. */
const _promptsCache = new Map<string, { mtimeMs: number; prompts: string[] }>();
export async function readUserPrompts(file: string, maxPrompts = 4): Promise<string[]> {
  let mtimeMs = 0;
  try { mtimeMs = (await fs.promises.stat(file)).mtimeMs; } catch { return []; }
  const cached = _promptsCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.prompts;
  let raw = "";
  try { raw = await readHead(file, 256 * 1024); } catch { return []; }
  const prompts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "user" || !o.message) continue;
    const c = o.message.content;
    let t = "";
    if (typeof c === "string") t = c;
    else if (Array.isArray(c)) {
      const tb = c.find((b: any) => b && b.type === "text");
      if (tb) t = tb.text;
    }
    t = (t || "").trim();
    const tm = /^<teammate-message[^>]*>\s*([\s\S]*?)\s*<\/teammate-message>/.exec(t);
    if (tm) t = tm[1].trim();
    if (!t || t.startsWith("<") || t.startsWith("Caveat:")) continue; // tool_result/envelope noise
    prompts.push(t.replace(/\s+/g, " ").slice(0, 400));
    if (prompts.length >= maxPrompts) break;
  }
  _promptsCache.set(file, { mtimeMs, prompts });
  return prompts;
}

let _metaRunning = false;
/**
 * LAZY session meta (clean title + category tag) via the cheap model, cached in the DB.
 * Fire-and-forget — never blocks the tick; a few sessions per call so it self-paces.
 *
 * Unlike the old title pass (one shot off the FIRST prompt — which named "new claude session"
 * launches and /work boilerplate forever), this reads the first few REAL prompts and
 * RE-generates as the conversation grows, so the name converges on what the session is
 * actually about: once at the first prompt(s), and once more after ~4 prompts.
 * `meta_gen_prompts` records how many prompts the last generation saw (-1 = never), EXCEPT the
 * sentinel `TASK_TAG_TITLED` (99) which `applyTaskWindowMeta` stamps when it titled a session from
 * the authoritative `@claude_task` tmux option — the `< 4` filter below then leaves it untouched.
 * The operator's manual_title is never touched — it always wins in the UI.
 */
export async function generateSessionMetaAsync(db: DatabaseSync, model: string): Promise<void> {
  if (_metaRunning) return;
  _metaRunning = true;
  try {
    const { claudeJson } = require("./claude");
    const rows = db.prepare(
      `SELECT id, title, transcript_path, meta_gen_prompts FROM sessions
       WHERE kind='claude' AND is_teammate=0 AND completed_at IS NULL AND meta_gen_prompts < 4
       ORDER BY is_live_pane DESC, updated_at DESC LIMIT 12`
    ).all() as any[];
    let calls = 0;
    for (const r of rows) {
      if (calls >= 3) break; // self-pace: a few model calls per tick
      const prompts = r.transcript_path ? await readUserPrompts(r.transcript_path, 4) : [];
      const n = prompts.length;
      const last = typeof r.meta_gen_prompts === "number" ? r.meta_gen_prompts : -1;
      // Generate when never done; RE-generate when the conversation grew past what the last
      // generation saw (0 → first real prompt arrived; <4 → enough context to settle the name).
      const due = last < 0 || (n > last && (last === 0 || n >= 4));
      if (!due) continue;
      calls++;
      const ctx = (prompts.length ? prompts.map((p, i) => `${i + 1}. ${p}`).join("\n") : (r.title || "")).slice(0, 1600);
      const prompt =
        `You label a Claude Code work session from the operator's first prompts.\n` +
        `Return JSON: {"title": "...", "tag": "..."}\n` +
        `- title: SHORT name of the task, max 6 words, no quotes, no trailing period. Name the ACTUAL work ` +
        `(e.g. "Fix the failing import job"), never meta-phrases like "Start new session" or "Pick next task".\n` +
        `- tag: exactly one of ${JSON.stringify(SESSION_TAGS)}.\n` +
        `  training = ML model training/finetuning/sweeps/eval · inference = the inference pipeline, queues, classify runs · ` +
        `data = datasets, labels, exports, syncs · claudeos = work on ClaudeOS/cockpit/kanban tooling itself · ` +
        `infra = servers, GPUs, networking, deploys, env · babysit = monitoring/watching a long-running job or run · other = anything else.\n\n` +
        `Prompts:\n"""${ctx}"""`;
      let res: { title?: string; tag?: string } | null = null;
      try { res = await claudeJson(prompt, { model, timeoutMs: 30000, label: "discover" }); } catch {}
      const clean = String(res?.title || "").replace(/^["'\s]+|["'\s.]+$/g, "").split("\n")[0].slice(0, 60).trim();
      const tag = SESSION_TAGS.includes(String(res?.tag || "") as any) ? String(res!.tag) : "";
      if (!clean && !tag) continue; // model failed — retry on a later tick (meta_gen_prompts unchanged)
      db.prepare(
        "UPDATE sessions SET clean_title=COALESCE(NULLIF(?, ''), clean_title), tags=COALESCE(NULLIF(?, ''), tags), meta_gen_prompts=? WHERE id=?"
      ).run(clean, tag ? JSON.stringify([tag]) : "", n, r.id);
    }
  } catch { /* best-effort */ } finally { _metaRunning = false; }
}

/** Sentinel stored in `meta_gen_prompts` once a session's title was set authoritatively from its
 *  `@claude_task` tmux option. ≥4 so `generateSessionMetaAsync` (WHERE meta_gen_prompts < 4) never
 *  overwrites the real task name with a model guess, and so `applyTaskWindowMeta` skips it next tick. */
export const TASK_TAG_TITLED = 99;

/** Humanize a kebab/snake `@claude_task` slug into a short display title.
 *  "s3-stream-dl-overlap-prefetch" → "S3 stream dl overlap prefetch". */
export function humanizeTaskTag(tag: string): string {
  const t = (tag || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

export interface ClaudeWindowOpts { task?: string; pr?: string; branch?: string; }

/** Read a session's `@claude_*` tmux WINDOW options — the metadata the your-repo `/work` and `/add`
 *  flows publish on every task window: `@claude_task` (the descriptive task slug, e.g.
 *  "s3-stream-dl-overlap-prefetch") and, once a PR is opened, `@claude_pr` (the PR URL) +
 *  `@claude_branch` (the `task/<name>` head). Without these, the session's title is the model's
 *  summary of the `/work` SLASH-COMMAND BODY ("Select next kanban task") and its PR is invisible
 *  (the session's own branch is `cockpit/<name>`, not the PR's `task/<name>` head).
 *
 *  Resolution order: the session's own live pane (a plain `/work` tmux window carries the options on
 *  its window), then the cockpit-launched session `cockpit-<worktree-basename>` — because ClaudeOS
 *  attaches a cockpit session through a SEPARATE `claudeos-<id>` shell whose window does NOT carry
 *  the options, while the real `claude` (where `/work` set them) lives in `cockpit-<name>`. */
async function readClaudeWindowOpts(s: { pane_id?: string | null; worktree_path?: string | null }): Promise<ClaudeWindowOpts> {
  const targets: string[] = [];
  if (s.pane_id) targets.push(s.pane_id);
  const m = /\.cockpit-worktrees\/([^/]+)\/*$/.exec((s.worktree_path || "").replace(/\/+$/, ""));
  if (m) targets.push(`cockpit-${m[1]}`);
  const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "").trim();
  for (const t of targets) {
    try {
      // No option name → tmux lists ALL window options in one call (cheap; one subprocess/session).
      const r = await execFileP("tmux", ["show-options", "-w", "-t", t], { encoding: "utf8", env: envNoTmux() });
      const out = r.stdout || "";
      const get = (k: string) => { const mm = new RegExp(`^${k}\\s+(.+)$`, "m").exec(out); return mm ? unquote(mm[1]) : ""; };
      const o: ClaudeWindowOpts = { task: get("@claude_task"), pr: get("@claude_pr"), branch: get("@claude_branch") };
      if (o.task || o.pr || o.branch) return o;
    } catch { /* options unset or target gone → try next */ }
  }
  return {};
}

/** Parse a GitHub PR URL → { repo: "owner/name", number }. "" / non-PR → null. */
export function parsePrUrl(url: string | undefined | null): { repo: string; number: number } | null {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url || "");
  return m ? { repo: m[1], number: parseInt(m[2], 10) } : null;
}

/** Bind a task session's title AND its PR from the `@claude_*` tmux options the `/work`/`/add` flows
 *  publish — authoritative, since the session's own branch (`cockpit/<name>`) is clean and never
 *  carries the work or the PR (both live on the nested `task/<name>` worktree).
 *
 *  - title: from `@claude_task` → "S3 stream dl overlap prefetch" instead of `/work` boilerplate.
 *    The operator's `manual_title` always wins; stamps `TASK_TAG_TITLED` so the model titler never
 *    re-guesses it.
 *  - PR: from `@claude_pr` (URL) → sets pr_repo/pr_number/pr_url/pr_head_ref so the PR bar + the
 *    PR-diff pane surface on the session (the diff pane shows `gh pr diff`, consistent with the
 *    merge button — see the renderer). prForBranch can't find it (branch mismatch), so this explicit
 *    link is the reliable path.
 *
 *  `readOptsFor` is injectable for tests. Returns counts of what it set. */
export async function applyTaskWindowMeta(
  db: DatabaseSync,
  readOptsFor: (s: any) => Promise<ClaudeWindowOpts> = readClaudeWindowOpts
): Promise<{ titled: number; prs: number }> {
  const rows = db.prepare(
    `SELECT id, worktree_path, pane_id, branch, clean_title, manual_title, meta_gen_prompts, pr_number
       FROM sessions
       WHERE kind='claude' AND completed_at IS NULL
         AND (is_live_pane = 1 OR clean_title IS NULL OR clean_title = '' OR pr_number IS NULL)
       ORDER BY is_live_pane DESC, updated_at DESC
       LIMIT 25`
  ).all() as any[];
  let titled = 0, prs = 0;
  for (const r of rows) {
    let opts: ClaudeWindowOpts = {};
    try { opts = await readOptsFor(r); } catch { opts = {}; }
    // Title — gated by the sentinel so it's set once; manual_title always wins.
    if (!r.manual_title && opts.task && r.meta_gen_prompts !== TASK_TAG_TITLED) {
      const title = humanizeTaskTag(opts.task);
      if (title) {
        db.prepare("UPDATE sessions SET clean_title=?, meta_gen_prompts=? WHERE id=?").run(title, TASK_TAG_TITLED, r.id);
        titled++;
      }
    }
    // PR — attach (or update) when the window advertises one the row doesn't already have.
    const pr = parsePrUrl(opts.pr);
    if (pr && pr.number !== r.pr_number) {
      db.prepare("UPDATE sessions SET pr_repo=?, pr_number=?, pr_url=?, pr_head_ref=COALESCE(NULLIF(?,''),pr_head_ref) WHERE id=?")
        .run(pr.repo, pr.number, opts.pr || "", opts.branch || "", r.id);
      prs++;
    }
  }
  return { titled, prs };
}

/** `claude agents --json` → [{sessionId, pid}] for live agents, cached ~8s (spawning claude on
 *  every 5s tick is wasteful). The pid is what lets discovery walk the process tree to each agent's
 *  tmux pane — the only reliable session→pane mapping here, since the transcript fd is held by the
 *  cc-daemon, not the pane. `sessionId` is the FULL uuid (matches the transcript filename), NOT the
 *  short `id`. */
let _agentsCache: { at: number; list: { sessionId: string; pid: number }[] } | null = null;
async function listClaudeAgents(): Promise<{ sessionId: string; pid: number }[]> {
  if (_agentsCache && Date.now() - _agentsCache.at < 8000) return _agentsCache.list;
  const list: { sessionId: string; pid: number }[] = [];
  try {
    const { stdout } = await execFileP("claude", ["agents", "--json"], { encoding: "utf8", env: envNoTmux(), timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    const d = JSON.parse(stdout);
    const arr = Array.isArray(d) ? d : (Array.isArray((d as any)?.agents) ? (d as any).agents : (Array.isArray((d as any)?.sessions) ? (d as any).sessions : []));
    for (const a of arr) {
      const sid = a?.sessionId || a?.session_id;
      const pid = a?.pid;
      if (typeof sid === "string" && typeof pid === "number") list.push({ sessionId: sid, pid });
    }
  } catch { /* claude missing/errored → empty; transcript-fd fallback still applies */ }
  _agentsCache = { at: Date.now(), list };
  return list;
}

/**
 * PER-PANE discovery. The operator runs all their chats as Claude AGENT PANES inside one tmux
 * window — many sharing the main-repo cwd. So we surface ONE ClaudeOS session per LIVE CLAUDE
 * AGENT (correlated to its tmux pane via its `claude agents` pid → process-tree walk), plus recent
 * transcript-only sessions as a greyed, non-attachable roster. Returns how many sessions upserted.
 */
export async function discoverRecentSessions(db: DatabaseSync, sm: SessionManager, limit = 20): Promise<number> {
  const projects = path.join(os.homedir(), ".claude", "projects");
  const cockpitRoot = path.resolve(__dirname, "../..");
  const sessIdOf = (jsonl: string) => path.basename(jsonl).replace(/\.jsonl$/, "");
  let seen = 0;
  const liveSessionIds: string[] = [];

  // SESSION→PANE mapping via `claude agents --json` pids. Earlier attempts failed: matching by CWD
  // collapsed every same-cwd session onto one pane (the operator's window — "clicking any session
  // shows my 3-pane tmux window"); matching by the transcript fd found NOTHING for interactive
  // agents because the .jsonl fd is held by the orphaned cc-daemon, not the pane (→ everything went
  // read-only). The reliable signal: each agent record carries its `pid`, and walking that pid's
  // process tree UP to a tmux pane pid (paneForPid) yields the EXACT pane. So each interactive agent
  // maps to its OWN pane (typeable, distinct), while a daemon-managed background agent (pid not under
  // any tmux pane) maps to NO pane → honest read-only.
  const paneByPid = new Map<number, LivePane>();
  for (const p of await listClaudePanes()) paneByPid.set(p.panePid, p);
  const paneBySession = new Map<string, LivePane>(); // claude_session_id → its exact live pane
  for (const a of await listClaudeAgents()) {
    const pane = paneForPid(a.pid, paneByPid);
    if (pane) paneBySession.set(a.sessionId, pane);
  }
  // Fallback for a session NOT in `claude agents` but whose own process holds its transcript fd in a
  // pane (e.g. a plain `claude --resume` pane). Still NEVER cwd-matches.
  const paneByTranscript = new Map<string, LivePane>();
  for (const [pid, tpath] of scanOpenTranscripts()) {
    const pane = paneForPid(pid, paneByPid);
    if (pane && !paneByTranscript.has(tpath)) paneByTranscript.set(tpath, pane);
  }

  // ---- Discover sessions PER TRANSCRIPT SESSION-ID (no cwd-dedup) ----
  // FIX C: async fs throughout (readdir/stat via fs.promises) so the dir scan never blocks.
  const fsp = fs.promises;
  let projectsExists = false; try { await fsp.access(projects); projectsExists = true; } catch {}
  if (projectsExists) {
    const files: { file: string; mtimeMs: number }[] = [];
    let dirs: string[] = []; try { dirs = await fsp.readdir(projects); } catch {}
    for (const dir of dirs) {
      const dpath = path.join(projects, dir);
      try { if (!(await fsp.stat(dpath)).isDirectory()) continue; } catch { continue; }
      let entries: string[] = []; try { entries = await fsp.readdir(dpath); } catch {}
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(dpath, f);
        try { files.push({ file: fp, mtimeMs: (await fsp.stat(fp)).mtimeMs }); } catch {}
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let _chunk = 0;
    for (const { file, mtimeMs } of files) {
      const sessId = sessIdOf(file);
      // A session that maps to a LIVE, attachable tmux pane is ALWAYS linked — regardless of the
      // recency cap. `limit` is only a cap on transcript-only (non-live) ROSTER entries. Without this,
      // an older-but-still-running session falls past the cap, gets de-linked by clearLivePanes(), and
      // renders as a greyed, unclickable "past" row that also drops out of the queue. With 39 live
      // panes but limit=20, that de-linked the majority of live sessions.
      const pane = paneBySession.get(sessId) || paneByTranscript.get(file) || null; // EXACT: agent-pid→pane (daemon-safe), then transcript-fd; NEVER shared cwd
      if (!pane && seen >= limit) continue;
      // CHUNK: yield to the event loop every ~3 files so the terminal/diff WS stays smooth.
      if (++_chunk % 3 === 0) await new Promise<void>((r) => setImmediate(r));
      const meta = await deriveMeta(file, mtimeMs);
      if (!meta) continue;
      let cwdExists = false; try { await fsp.access(meta.cwd); cwdExists = true; } catch {}
      if (!cwdExists) continue;
      if (isExcludedCwd(meta.cwd, cockpitRoot)) continue;
      // TEAMMATES (transcript carries teamName/agentName) are KEPT — they render as child rows
      // under one team-group queue entry, never as their own items. They must bypass the title
      // filter: their unwrapped first prompt ('You are "reviewer…') matches the agent-noise list.
      const isTeammate = !!meta.teamName;
      if (!isTeammate && isFilteredTitle(meta.title)) continue; // agent/review/internal sub-session, not a task
      const { repo, branch } = await gitInfo(meta.cwd);
      upsertDiscoveredSession(db, {
        claude_session_id: sessId,
        title: meta.title,
        repo,
        worktree_path: meta.cwd,
        branch,
        transcript_path: file,
        pane_id: pane ? pane.paneId : null,
        tmux_target: pane ? pane.target : null,
        is_live_pane: pane ? 1 : 0,
        is_teammate: isTeammate ? 1 : 0,
        team_name: meta.teamName,
        agent_name: meta.agentName,
      });
      if (pane) liveSessionIds.push(sessId);
      else seen++; // only roster (non-live) entries count against the recency cap
    }
  }
  try { clearLivePanes(db, liveSessionIds); } catch {}
  // Authoritative titles from the `@claude_task` tmux option (set by /work, /add). Best-effort —
  // never let a tmux hiccup fail discovery.
  try { await applyTaskWindowMeta(db); } catch {}
  return seen;
}
