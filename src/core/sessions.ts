/**
 * SessionManager — launches and observes real Claude Code sessions, each fully
 * isolated in its own git worktree. Sessions run inside a detached tmux session so
 * they are genuine interactive Claude Code (the operator can attach with the
 * 'open terminal' key), while the cockpit observes them passively through their
 * transcript file. No autonomous swarm: the human stays in the loop.
 */
import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DatabaseSync } from "node:sqlite";
import { createWorktree, removeWorktree, repoName } from "./worktree";
import { findTranscript, findTranscriptById } from "./transcript";
import { upsertSession, SessionRow, allSessions } from "./db";
import { pretrust } from "./pretrust";

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

function tmuxName(slug: string): string {
  return `cockpit-${slug}`;
}

/** POSIX-safe single-quote: wrap in '…' and escape embedded quotes as '\''. Unlike double
 *  quotes / JSON.stringify, this neutralizes ALL shell expansion ($VAR, `cmd`, $(cmd)) — the
 *  command string is handed to `sh -c` by tmux, so a free-form prompt must stay fully literal. */
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Build the shell command a new Claude terminal session runs. An optional seed prompt is
 *  passed as claude's first CLI arg (single-quoted so it's delivered verbatim), so it's
 *  auto-submitted the instant the TUI boots — no send-keys timing race. A blank/whitespace
 *  prompt is treated as no seed. Exported for deterministic unit testing of the quoting. */
export function claudeLaunchCmd(skipPermissions?: boolean, prompt?: string): string {
  const seed = prompt && prompt.trim() ? " " + shQuote(prompt.trim()) : "";
  return `claude${skipPermissions ? " --dangerously-skip-permissions" : ""}${seed}`;
}

/** Wrap a launch command so the tmux pane SURVIVES the command exiting — crash OR clean quit —
 *  and SELF-HEALS from boot crashes. Without this, a claude that dies at startup takes the whole
 *  tmux session (and its error output — the only evidence) with it: the operator's quick-prompt
 *  task silently evaporates and the db row points at nothing (the 2026-06-11 "apply S3 review
 *  fixes" vanishing task).
 *
 *  Retry policy: a NONZERO exit within BOOT_WINDOW_S seconds of launch is a boot crash
 *  (transient: deploy churn, binary mid-update, fs/auth hiccup) → retry up to MAX_RETRIES
 *  times after a short pause — claude barely started, so re-seeding the same prompt cannot
 *  double-run the task. A clean exit (rc=0, operator quit) or a death after the window
 *  (claude genuinely ran) is NEVER retried. The trailing `exec bash` keeps the pane attachable
 *  either way; the reapers already clean up lingering terminals.
 *
 *  POSIX-sh only (tmux runs commands via /bin/sh, dash on Ubuntu): no $SECONDS, no arrays.
 *  Exported for deterministic unit testing.
 *
 *  `seedPrompt`: the operator's task text, echoed as the pane's FIRST line. The task must be
 *  readable in the pane even when claude never boots (the card title carries it too — belt
 *  and braces: a written task is never reduced to a dead process argument). */
export function keepAliveWrap(cmd: string, seedPrompt?: string): string {
  const BOOT_WINDOW_S = 15;
  const MAX_RETRIES = 2;
  const seedEcho = seedPrompt && seedPrompt.trim()
    ? `printf '[task] %s\\n' ${shQuote(seedPrompt.trim())}; `
    : "";
  return (
    seedEcho +
    `_n=0; while :; do _t0=$(date +%s); ${cmd}; rc=$?; _d=$(( $(date +%s) - _t0 )); ` +
    `[ "$rc" -eq 0 ] && break; [ "$_d" -ge ${BOOT_WINDOW_S} ] && break; ` +
    `_n=$((_n+1)); [ "$_n" -gt ${MAX_RETRIES} ] && break; ` +
    `printf '\\n[claude died at boot (status %s after %ss) — auto-retry %s/${MAX_RETRIES} in 2s]\\n' "$rc" "$_d" "$_n"; sleep 2; ` +
    `done; ` +
    `if [ "$rc" -eq 0 ]; then printf '\\n[claude exited cleanly — pane kept alive]\\n'; ` +
    `else printf '\\n[claude FAILED (status %s) — gave up; the error is above, and this card + its task text stay on the board]\\n' "$rc"; fi; exec bash`
  );
}

/** Canonicalize a path (resolve symlinks when possible) so worktree<->pane cwd
 *  comparisons survive /tmp, NFS, and other symlinked roots. */
function canonPath(p: string): string {
  if (!p) return p;
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

function haveTmux(): boolean {
  try {
    execSync("command -v tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to the `claude` binary (cached), or null if not on PATH. */
let _claudePath: string | null | undefined;
function claudePath(): string | null {
  if (_claudePath !== undefined) return _claudePath;
  try {
    _claudePath = execSync("command -v claude", { encoding: "utf8" }).trim() || null;
  } catch {
    _claudePath = null;
  }
  return _claudePath;
}

/** Dedicated tmux socket for DEMO throwaway sessions — isolated from the operator's real tmux. */
const DEMO_SOCKET = "cockpit-demo-sock";

/** A copy of the env with $TMUX cleared, so `tmux attach` works even when the cockpit
 *  server is itself running inside a tmux (tmux refuses to nest otherwise). */
function envNoTmux(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.TMUX;
  delete e.TMUX_PANE;
  // node-pty resolves bare commands (`tmux`) against THIS PATH; macOS GUI/launchd processes get a
  // minimal PATH without Homebrew, so the attach spawn fails. Prepend the usual locations.
  const home = os.homedir();
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  e.PATH = [...extra, ...String(e.PATH || "").split(":")].filter((p, i, a) => p && a.indexOf(p) === i).join(":");
  return e;
}

/** Write (once) the demo TUI script and return its path. A real interactive shell with
 *  a colored Claude-Code-style banner, so the DEMO terminal is a genuine attached PTY
 *  (clearly still a no-op sandbox — typing runs in a throwaway shell, nothing real). */
let _demoTuiPath: string | null = null;
function demoTuiScriptPath(): string {
  if (_demoTuiPath) return _demoTuiPath;
  const p = path.join(os.tmpdir(), "cockpit-demo-tui.sh");
  const script = `#!/usr/bin/env bash
TITLE="\${1:-demo task}"
clear
printf '\\033[38;5;208m╭──────────────────────────────────────────────────────────────╮\\033[0m\\n'
printf '\\033[38;5;208m│  \\033[1m✻ Claude Code\\033[0m\\033[38;5;208m  ·  \\033[33mDEMO — real attached tmux (sandbox)\\033[38;5;208m   │\\033[0m\\n'
printf '\\033[38;5;208m╰──────────────────────────────────────────────────────────────╯\\033[0m\\n\\n'
printf '  \\033[36m⏵\\033[0m \\033[1mtask:\\033[0m %s\\n\\n' "$TITLE"
printf '  \\033[36m⏺ Read\\033[0m(\\033[90msrc/your-repo/training_pipeline/varlen_pack.py\\033[0m)\\n'
printf '    \\033[90m⎿  read 412 lines\\033[0m\\n'
printf '  \\033[36m⏺ Edit\\033[0m(\\033[90mvarlen_pack.py\\033[0m) \\033[90m⎿ \\033[32m+14\\033[0m \\033[31m-5\\033[0m\\n'
printf '  \\033[36m⏺ Bash\\033[0m(\\033[90mpytest -q\\033[0m) \\033[90m⎿\\033[0m \\033[32m8 passed\\033[0m\\n\\n'
printf '  \\033[33m⠹\\033[0m This is a REAL attached terminal. Type freely — it is a sandbox shell.\\n'
printf '  \\033[90m(slash-style autocomplete, arrows, Esc, Ctrl+keys all work natively)\\033[0m\\n\\n'
export PS1=$'\\033[32m❯\\033[0m '
exec bash --norc -i
`;
  try {
    fs.writeFileSync(p, script, { mode: 0o755 });
    _demoTuiPath = p;
  } catch {
    _demoTuiPath = p;
  }
  return p;
}

export interface LaunchOpts {
  repo: string;
  title: string;
  prompt: string;
  baseRef?: string;
  blocksOtherWork?: boolean;
  deadline?: string | null;
  skipPermissions?: boolean; // --dangerously-skip-permissions (kanban auto-start: the session must run unattended)
}

export class SessionManager {
  /** In demo mode every tmux interaction is a no-op against an in-memory fake buffer. */
  private demoBuffers = new Map<number, string>();
  constructor(private db: DatabaseSync, private demo = false) {}

  /** Launch a new isolated Claude Code session. Returns the session row id. */
  launch(opts: LaunchOpts): number {
    const slug = slugify(opts.title);
    const wt = createWorktree(opts.repo, slug, opts.baseRef);
    pretrust(wt.path); // skip the interactive trust dialog for the new worktree
    let pid: number | null = null;
    if (haveTmux()) {
      const name = tmuxName(slug);
      // kill stale session of same name, then start fresh, seeded with the prompt.
      try {
        execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
      } catch {}
      execFileSync("tmux", [
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        wt.path,
        // claudeLaunchCmd shQuotes the prompt (double quotes would let $VAR/`cmd` in a
        // free-form prompt expand in the pane's sh -c). keepAliveWrap: see claudeLaunchCmd.
        keepAliveWrap(claudeLaunchCmd(opts.skipPermissions, opts.prompt), opts.prompt),
      ]);
      try {
        pid = parseInt(
          execFileSync("tmux", ["list-panes", "-t", name, "-F", "#{pane_pid}"], {
            encoding: "utf8",
          }).trim(),
          10
        );
      } catch {}
    }
    return upsertSession(this.db, {
      title: opts.title,
      repo: repoName(opts.repo),
      worktree_path: wt.path,
      branch: wt.branch,
      pid: pid ?? null,
      state: "WORKING",
      blocks_other_work: opts.blocksOtherWork ? 1 : 0,
      deadline: opts.deadline ?? null,
    });
  }

  /** Register a session for a worktree/cwd already running Claude Code elsewhere. */
  register(opts: { repo: string; title: string; worktreePath: string; branch: string; pid?: number; blocksOtherWork?: boolean; deadline?: string | null }): number {
    return upsertSession(this.db, {
      title: opts.title,
      repo: repoName(opts.repo),
      worktree_path: opts.worktreePath,
      branch: opts.branch,
      pid: opts.pid ?? null,
      state: "UNKNOWN",
      blocks_other_work: opts.blocksOtherWork ? 1 : 0,
      deadline: opts.deadline ?? null,
    });
  }

  /**
   * Launch a fresh terminal session and return its id. An EMPTY one (no prompt) is marked
   * PROVISIONAL (ephemeral until the operator types something); a SEEDED one (Ctrl+G i) is a
   * written task — titled with the prompt and never provisional. kind 'claude' = an interactive
   * `claude [--dangerously-skip-permissions]`; kind 'shell' = a plain bash. Demo spawns the
   * isolated sandbox equivalent on attach.
   */
  launchTerminalSession(opts: { kind: "claude" | "shell"; repo: string; skipPermissions?: boolean; prompt?: string }): number {
    const kind = opts.kind;
    const baseTitle = kind === "shell" ? "shell" : "new claude session";
    // DURABLE PROMPT: a seeded quick-prompt (Ctrl+G i) is a WRITTEN TASK — it must be readable
    // on the card from the instant it exists, even if claude never boots. Titling the row with
    // the prompt is what guarantees the operator's words can't vanish with a crashed pane
    // (the 2026-06-11 vanished task died titled "new claude session" — text unrecoverable).
    // Slug/tmux/worktree names stay on baseTitle so external name-matching is unaffected.
    const seeded = kind === "claude" && !!(opts.prompt && opts.prompt.trim());
    const title = seeded ? opts.prompt!.trim().replace(/\s+/g, " ").slice(0, 80) : baseTitle;
    // A SEEDED launch is a written task — "used" by definition, so it is NEVER provisional:
    // no detach/cleanup path may ever delete the operator's words. Only the truly empty
    // Ctrl+G C/c terminals stay ephemeral-until-touched.
    const provisional = seeded ? 0 : 1;
    if (this.demo) {
      const id = upsertSession(this.db, {
        title, repo: "demo/sandbox", worktree_path: path.join(os.tmpdir(), `cockpit-demo-${kind}-${baseTitle}`),
        branch: `demo/${kind}`, pid: null, state: "WORKING", blocks_other_work: 0, deadline: null,
      });
      this.db.prepare("UPDATE sessions SET kind=?, provisional=? WHERE id=?").run(kind === "shell" ? "shell" : "claude", provisional, id);
      return id;
    }
    const nextId = (this.db.prepare("SELECT COALESCE(MAX(id),0)+1 AS n FROM sessions").get() as { n: number }).n;
    const slug = slugify(baseTitle) + "-" + nextId;
    let wtPath: string, branch: string;
    if (kind === "claude") {
      const wt = createWorktree(opts.repo, slug);
      wtPath = wt.path; branch = wt.branch;
      pretrust(wtPath);
    } else {
      wtPath = path.join(os.tmpdir(), `cockpit-shell-${slug}`);
      fs.mkdirSync(wtPath, { recursive: true });
      branch = `shell/${slug}`;
    }
    let pid: number | null = null;
    if (haveTmux()) {
      const name = tmuxName(slug);
      try { execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" }); } catch {}
      const cmd = kind === "claude" ? keepAliveWrap(claudeLaunchCmd(opts.skipPermissions, opts.prompt), opts.prompt) : "bash";
      execFileSync("tmux", ["new-session", "-d", "-s", name, "-c", wtPath, cmd], { env: envNoTmux() });
      try { pid = parseInt(execFileSync("tmux", ["list-panes", "-t", name, "-F", "#{pane_pid}"], { encoding: "utf8", env: envNoTmux() }).trim(), 10); } catch {}
    }
    const id = upsertSession(this.db, { title, repo: repoName(opts.repo), worktree_path: wtPath, branch, pid, state: "WORKING", blocks_other_work: 0, deadline: null });
    this.db.prepare("UPDATE sessions SET kind=?, provisional=? WHERE id=?").run(kind === "shell" ? "shell" : "claude", provisional, id);
    return id;
  }

  /** Tear down a provisional session that was never used: kill its tmux + remove its
   *  worktree/tmpdir (db rows are deleted by the caller). */
  killTerminalSession(session: SessionRow): void {
    try {
      if (this.demo) { try { this.demoTmux(["kill-session", "-t", `cockpit-demo-${session.id}`], { stdio: "ignore" }); } catch {} }
      else if (haveTmux()) { try { execFileSync("tmux", ["kill-session", "-t", this.cockpitName(session)], { stdio: "ignore", env: envNoTmux() }); } catch {} }
    } catch {}
    try {
      if (!this.demo && session.worktree_path) {
        if (session.kind === "shell") fs.rmSync(session.worktree_path, { recursive: true, force: true });
        else { try { removeWorktree(session.repo, session.worktree_path); } catch { try { fs.rmSync(session.worktree_path, { recursive: true, force: true }); } catch {} } }
      }
    } catch {}
  }

  /** Kill ONLY the tmux for a cockpit-launched session — no worktree removal, no db change
   *  (unlike killTerminalSession). Used by the nightly reaper to clear orphan terminals of
   *  long-completed tasks while preserving the git worktree/branch. A session can own TWO
   *  terminals: the launch session `cockpit-<slug>` AND the durable keep-alive view
   *  `claudeos-<id>` created when the operator first opens its terminal (Controller's
   *  terminalCmd) — the keep-alive shell outlives claude by design, so the reaper must clear
   *  BOTH names or every viewed task leaves an immortal terminal behind. Targets use tmux
   *  exact-match (`=name`) so reaping claudeos-1 can never prefix-match claudeos-12. We
   *  require hasSession() per name, so this is a safe no-op when the session is already
   *  closed OR was started externally (never ours to kill). Returns true iff at least one
   *  live session was actually killed. */
  killTmuxOnly(session: SessionRow): boolean {
    if (this.demo || !haveTmux()) return false;
    let killed = false;
    for (const name of [this.cockpitName(session), `claudeos-${session.id}`]) {
      if (!this.hasSession(`=${name}`)) continue;
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore", env: envNoTmux() });
        killed = true;
      } catch {}
    }
    return killed;
  }

  /** The cockpit-launched session's canonical tmux session name (may not exist). */
  private cockpitName(session: SessionRow): string {
    return tmuxName(session.branch.replace(/^cockpit\//, ""));
  }

  private hasSession(name: string): boolean {
    try {
      // Use envNoTmux so we query the SAME (default) socket the attach uses — otherwise a
      // cockpit started inside a tmux would look at the wrong server and "can't find session".
      execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore", env: envNoTmux() });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the live tmux pane target for a session. Works for BOTH cockpit-launched
   * sessions (named `cockpit-<slug>`) AND externally-running sessions (discovered /
   * registered) by matching the session's worktree_path to a live pane's current path.
   * Returns a tmux target ("session:win.pane" or session name) or null if none is live.
   */
  resolvePaneTarget(session: SessionRow): string | null {
    if (this.demo) return `demo:${session.id}`; // fake but always "live"
    if (!haveTmux()) return null;
    // 1) cockpit-launched session by canonical name.
    const cn = this.cockpitName(session);
    if (this.hasSession(cn)) return cn;
    // 2) external session: match worktree_path against every live pane's cwd, and PREFER
    // the pane actually running `claude` (so the operator talks to Claude, not a bash
    // shell that happens to share the cwd).
    if (!session.worktree_path) return null;
    let out = "";
    try {
      out = execFileSync(
        "tmux",
        ["list-panes", "-a", "-F", "#{pane_current_path}\t#{pane_current_command}\t#{session_name}:#{window_index}.#{pane_index}"],
        { encoding: "utf8", env: envNoTmux() } // same (default) socket the attach uses
      );
    } catch {
      return null;
    }
    const want = canonPath(session.worktree_path);
    const isClaude = (cmd: string) => /(^|\/)(claude|node)$/i.test(cmd) || cmd.toLowerCase().includes("claude");
    let exactAny: string | null = null;       // cwd matches, any command
    let underClaude: string | null = null;    // cwd inside worktree, running claude
    let underAny: string | null = null;       // cwd inside worktree, any command
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const cwd = canonPath(parts[0].trim());
      const cmd = parts[1].trim();
      const target = parts[2].trim();
      if (cwd === want) {
        if (isClaude(cmd)) return target;     // best: exact cwd AND running claude
        if (!exactAny) exactAny = target;
      } else if (cwd.startsWith(want + path.sep)) {
        if (isClaude(cmd) && !underClaude) underClaude = target;
        else if (!underAny) underAny = target;
      }
    }
    return exactAny || underClaude || underAny;
  }

  /**
   * Resolve the tmux ATTACH spec (argv + env) for the live terminal PTY. We always clear
   * $TMUX so `tmux attach` works even when the cockpit server itself runs inside a tmux
   * (otherwise tmux refuses to nest). DEMO sessions live on a DEDICATED tmux socket
   * (`-L`) so they never touch the operator's real tmux, and are genuine interactive
   * attached terminals (a fake Claude-Code-style TUI + sandbox shell).
   */
  ensureAttachSpec(session: SessionRow): { argv: string[]; env: NodeJS.ProcessEnv; resizeName?: string } | null {
    if (this.demo) {
      const name = `cockpit-demo-${session.id}`;
      if (!this.hasDemoSession(name)) this.spawnDemoTmux(name, session.title, (session as any).kind || "claude");
      if (!this.hasDemoSession(name)) return null;
      return { argv: ["-L", DEMO_SOCKET, "attach-session", "-t", name], env: envNoTmux() };
    }
    // Prefer the EXACT live-pane mapping captured at discovery (per-pane discovery): attach to
    // the session, then select the exact window + pane. The `;` are LITERAL argv elements —
    // tmux runs select-window/select-pane itself INSIDE the spawned pty, so they never touch
    // the Node event loop (running them in Node during the WS upgrade was the black-screen bug).
    // Caveat: select-pane is session-global, so if the operator is also attached to this session
    // elsewhere their active pane follows — acceptable (same person, same agent view).
    const liveTarget = (session as any).tmux_target as string | null;
    const paneId = (session as any).pane_id as string | null;
    if ((session as any).is_live_pane && liveTarget && liveTarget.includes(":")) {
      const sessionName = liveTarget.split(":")[0];
      const win = liveTarget.slice(sessionName.length + 1).split(".")[0];
      const argv = ["attach-session", "-f", "ignore-size", "-t", sessionName];
      argv.push(";", "select-window", "-t", `${sessionName}:${win}`);
      if (paneId) argv.push(";", "select-pane", "-t", paneId);
      return { argv, env: envNoTmux() };
    }
    // FIX D: ONLY attach to a cockpit-LAUNCHED session by its canonical name. We deliberately
    // do NOT fall back to cwd-matching a live pane: many real sessions share the same repo cwd
    // (/home/.../your-repo), so cwd-match would grab the WRONG operator pane (the classic
    // "clicking any session shows the same terminal" bug). A session with no exact captured pane
    // and no canonical cockpit session has NO safe pane → return null (caller shows its own
    // transcript read-only instead).
    const cn = this.cockpitName(session);
    if (this.hasSession(cn)) {
      // SIZE: this is OUR dedicated per-task session (single client, not a shared operator pane),
      // so the window MUST track the attaching xterm. We keep `-f ignore-size` (a stray second
      // client can't shrink it) and instead resize the window EXPLICITLY to the client's size via
      // `resizeName` — otherwise a freshly-launched session stays stuck at tmux's 80×24 default and
      // claude draws a tiny box in the top-left corner. (Foreign live panes above are the
      // operator's own terminal → never resize those.)
      return { argv: ["attach-session", "-f", "ignore-size", "-t", cn], env: envNoTmux(), resizeName: cn };
    }
    // PR-TERMINAL / durable-resume gap: the per-task tmux `claudeos-<id>` (created by the direct
    // resume path, the ssh local terminal, or a PR-card materialization) is ALSO ours and safe to
    // attach — same single-client dedicated-session semantics as `cockpit-<slug>` above. This
    // covers the window where a freshly-materialized PR terminal has no claude_session_id yet
    // (transcript not discovered) so directResumeSpec can't route it.
    const durable = `claudeos-${session.id}`;
    if (this.hasSession(durable)) {
      return { argv: ["attach-session", "-f", "ignore-size", "-t", durable], env: envNoTmux(), resizeName: durable };
    }
    return null;
  }

  private demoTmux(args: string[], opts: any = {}): Buffer | string {
    return execFileSync("tmux", ["-L", DEMO_SOCKET, ...args], { env: envNoTmux(), ...opts });
  }

  private hasDemoSession(name: string): boolean {
    try { this.demoTmux(["has-session", "-t", name], { stdio: "ignore" }); return true; } catch { return false; }
  }

  /**
   * Spawn a real throwaway tmux session (own socket) running a GENUINE interactive
   * `claude` in an ISOLATED, pre-trusted sandbox dir — so the demo terminal is a real
   * Claude Code session the operator can actually talk to (not a bash shell), yet it
   * cannot touch the operator's real repos/PRs/sessions. Falls back to a fake-TUI shell
   * only if the `claude` binary isn't found.
   */
  private spawnDemoTmux(name: string, title: string, kind: string = "claude"): void {
    if (!haveTmux()) return;
    try {
      const sandbox = path.join(os.tmpdir(), `cockpit-demo-sandbox-${name}`);
      try { fs.mkdirSync(sandbox, { recursive: true }); } catch {}
      let cmd: string[];
      const claudeBin = claudePath();
      if (kind === "shell") {
        // a plain interactive bash sandbox (for quick commands; never a Claude session)
        cmd = ["bash", "-lc", `cd ${JSON.stringify(sandbox)} && PS1='\\[\\033[36m\\]demo-shell\\[\\033[0m\\]:\\w$ ' exec bash --norc -i`];
      } else if (claudeBin) {
        pretrust(sandbox); // skip the trust dialog for the throwaway dir
        const isProvisional = /^new claude/i.test(title) || /shell/i.test(title) === false && title === "new claude session";
        const prompt = isProvisional
          ? "" // ← / Ctrl+B C: an EMPTY interactive Claude the operator can type into
          : `You are a DEMO Claude Code session in a throwaway sandbox — nothing is real and you have NO access to the operator's repos/PRs/sessions. The task is "${title}". Greet the operator in one line, say you're the demo sandbox, and wait.`;
        const promptArg = prompt ? ` ${JSON.stringify(prompt)}` : "";
        // skip-permissions in the sandbox (the operator's "cc" style); exec so it's foreground.
        cmd = ["bash", "-lc", `cd ${JSON.stringify(sandbox)} && exec ${JSON.stringify(claudeBin)} --dangerously-skip-permissions${promptArg}`];
      } else {
        cmd = ["bash", demoTuiScriptPath(), title];
      }
      this.demoTmux(["new-session", "-d", "-s", name, "-x", "120", "-y", "36", ...cmd]);
      try { this.demoTmux(["set-option", "-t", name, "aggressive-resize", "on"]); } catch {}
    } catch {
      /* tmux missing / spawn failed -> ensureAttachSpec returns null */
    }
  }

  /** Tear down the whole demo tmux server (its own socket) on shutdown. */
  killDemoTmux(): void {
    if (!haveTmux()) return;
    try { this.demoTmux(["kill-server"], { stdio: "ignore" }); } catch {}
  }

  /** The canned fake terminal screen for a demo session — looks like Claude AT WORK,
   *  writing real code (tool calls, a diff being produced, a spinner). */
  private demoScreen(session: SessionRow): string {
    // Real ANSI escapes so the xterm mirror renders this in color, like Claude's TUI.
    const O = "\x1b[38;5;208m"; // orange
    const C = "\x1b[36m"; // cyan
    const G = "\x1b[32m"; // green
    const R = "\x1b[31m"; // red
    const Y = "\x1b[33m"; // yellow
    const D = "\x1b[90m"; // dim gray
    const B = "\x1b[1m"; // bold
    const X = "\x1b[0m"; // reset
    return [
      `${O}╭───────────────────────────────────────────────────────────────────╮${X}`,
      `${O}│  ${B}✻ Claude Code${X}${O}  ·  ${Y}DEMO — Claude is working (nothing here is real)${O}  │${X}`,
      `${O}╰───────────────────────────────────────────────────────────────────╯${X}`,
      "",
      `  ${C}⏵${X} ${B}task:${X} ${session.title}`,
      "",
      `  ${C}⏺ Read${X}(${D}src/your-repo/training_pipeline/varlen_pack.py${X})`,
      `    ${D}⎿  read 412 lines${X}`,
      `  ${C}⏺ Grep${X}(${D}"def batched_patch_embed"${X})  ${D}⎿  3 matches${X}`,
      `  ${C}⏺ Edit${X}(${D}src/your-repo/training_pipeline/varlen_pack.py${X})`,
      `    ${D}⎿  Updated with ${G}14 additions${X}${D} and ${R}5 removals${X}`,
      `       ${D}42${X}  ${R}-    B_i = shapes[0]${X}`,
      `       ${D}42${X}  ${G}+    # group by per-sample B_i so mixed batches don't assert${X}`,
      `       ${D}43${X}  ${G}+    for b_i, group in itertools.groupby(sorted(shapes)):${X}`,
      `       ${D}44${X}  ${G}+        packed = torch.cat([t[g] for g in group], dim=3)${X}`,
      `       ${D}45${X}  ${G}+        out.append(_embed(packed, b_i))${X}`,
      `  ${C}⏺ Bash${X}(${D}pytest tests/test_varlen.py -q${X})`,
      `    ${D}⎿  ........  ${G}8 passed${X}${D} in 3.41s${X}`,
      "",
      `  ${Y}⠹${X} Writing the fixed-shape sampler update… ${D}(esc to interrupt)${X}`,
      "",
      `  I refactored the patch packing to group by B_i. ${B}Should I also update`,
      `  the sampler to emit fixed-shape batches?${X}  ${D}(yes/no)${X}`,
      "",
      `${G}>${X} `,
    ].join("\n");
  }

  private demoAppend(session: SessionRow, s: string): void {
    if (!this.demoBuffers.has(session.id)) this.demoBuffers.set(session.id, this.demoScreen(session));
    this.demoBuffers.set(session.id, this.demoBuffers.get(session.id)! + s);
  }

  /** Send the operator's answer to a tmux-hosted session (literal text + Enter). */
  sendInput(session: SessionRow, text: string): boolean {
    if (this.demo) {
      this.demoAppend(session, text + "\n  ▸ (demo) input received — nothing real was sent\n> ");
      return true;
    }
    // Prefer the EXACT discovered pane (pane_id %id / tmux_target) over the legacy cwd match: the
    // operator runs many sessions in one repo cwd, so resolvePaneTarget's cwd match can land on the
    // WRONG pane. The discovery pane mapping (paneForPid) is per-session-id, so it targets the right
    // one. pane_id is the most stable handle; fall back to tmux_target, then the cwd resolver.
    const exact = session.is_live_pane ? (session.pane_id || session.tmux_target) : null;
    const target = exact || this.resolvePaneTarget(session);
    if (!target) return false;
    try {
      // -l literal so text isn't interpreted as tmux key names, then a real Enter.
      execFileSync("tmux", ["send-keys", "-t", target, "-l", text], { env: envNoTmux() });
      execFileSync("tmux", ["send-keys", "-t", target, "Enter"], { env: envNoTmux() });
      return true;
    } catch {
      return false;
    }
  }

  /** Live snapshot of the session's tmux pane (the actual terminal screen), or null
   *  if there is no live tmux pane (e.g. a mock/registered session not running). */
  capturePane(session: SessionRow, lines = 200): string | null {
    if (this.demo) {
      if (!this.demoBuffers.has(session.id)) this.demoBuffers.set(session.id, this.demoScreen(session));
      return this.demoBuffers.get(session.id)!;
    }
    const target = this.resolvePaneTarget(session);
    if (!target) return null;
    try {
      // -p print, -e keep escape sequences (real ANSI colors), -S scrollback.
      // NOTE: we deliberately DON'T pass -J (join wrapped lines) so each visual screen
      // row stays one line — that keeps the fixed-grid xterm mirror aligned.
      return execFileSync("tmux", ["capture-pane", "-p", "-e", "-S", `-${lines}`, "-t", target], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: envNoTmux(),
      });
    } catch {
      return null;
    }
  }

  /** The live tmux pane's character grid size (columns × rows), so the xterm mirror
   *  can size itself to match and avoid mis-wrapping. Null if no live pane. */
  paneSize(session: SessionRow): { cols: number; rows: number } | null {
    if (this.demo) return { cols: 96, rows: 30 };
    const target = this.resolvePaneTarget(session);
    if (!target) return null;
    try {
      const out = execFileSync("tmux", ["display-message", "-p", "-t", target, "#{pane_width} #{pane_height}"], {
        encoding: "utf8",
      }).trim();
      const [c, r] = out.split(/\s+/).map((n) => parseInt(n, 10));
      if (c > 0 && r > 0) return { cols: c, rows: r };
    } catch {}
    return null;
  }

  /** Send a single key/keystroke to the session's pane. `key` is a tmux key name
   *  (Enter, Up, C-c, BSpace, …) when `named`, otherwise sent as literal text. */
  sendKey(session: SessionRow, key: string, named: boolean): boolean {
    if (this.demo) {
      // append typed keys to the fake buffer so the terminal viewer visibly works
      if (!named) this.demoAppend(session, key);
      else if (key === "Enter") this.demoAppend(session, "\n  ▸ (demo) keystroke received\n> ");
      else if (key === "BSpace") {
        const b = this.demoBuffers.get(session.id) || this.demoScreen(session);
        this.demoBuffers.set(session.id, b.slice(0, -1));
      }
      return true;
    }
    const target = this.resolvePaneTarget(session);
    if (!target) return false;
    try {
      const args = named
        ? ["send-keys", "-t", target, key]
        : ["send-keys", "-t", target, "-l", key];
      execFileSync("tmux", args, { env: envNoTmux() });
      return true;
    } catch {
      return false;
    }
  }

  /** tmux attach command the UI shows / runs to drop the operator into the session. */
  attachCommand(session: SessionRow): string {
    const slug = session.branch.replace(/^cockpit\//, "");
    return `tmux attach -t ${tmuxName(slug)}`;
  }

  processAlive(session: SessionRow): boolean {
    // Prefer tmux session liveness; fall back to pid probe.
    const slug = session.branch.replace(/^cockpit\//, "");
    if (haveTmux()) {
      try {
        execFileSync("tmux", ["has-session", "-t", tmuxName(slug)], { stdio: "ignore" });
        return true;
      } catch {
        // fall through to pid check (e.g. registered/non-tmux sessions)
      }
    }
    if (session.pid) {
      try {
        process.kill(session.pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** The operator's per-pane babysit flag for a session's live pane: 'babysit' (👶 — alive,
   *  monitoring its own long job) or 'waiting' (🕐 — blocked on its own script), else null.
   *  Set by ~/.claude/babysit.sh / waiting.sh as the pane-scoped @claude_status (the DECLARED
   *  mode — it survives turn-end, unlike the volatile @claude_pane_status the notify hooks
   *  rewrite per event). A pane whose volatile status is 'input' (❓) is never reported as
   *  babysitting — needs-input always overrides 👶/🕐, matching the tmux glyph precedence.
   *  All panes are read in ONE `tmux list-panes -a` call, cached ~2s, so the engine can consult
   *  this per session per tick for free. */
  private _paneFlags: { at: number; map: Map<string, string>; inputs?: Set<string> } | null = null;
  paneBabysit(paneId: string | null | undefined): "babysit" | "waiting" | null {
    if (!paneId || this.demo || !haveTmux()) return null;
    const now = Date.now();
    if (!this._paneFlags || now - this._paneFlags.at > 2000) {
      const map = new Map<string, string>();
      const inputs = new Set<string>();
      try {
        const out = execFileSync(
          "tmux",
          ["list-panes", "-a", "-F", "#{pane_id}\t#{@claude_status}\t#{@claude_pane_status}"],
          { encoding: "utf8", env: envNoTmux() }
        );
        for (const line of out.split("\n")) {
          const [id, declared, volatileStatus] = line.split("\t");
          if (!id) continue;
          const d = (declared || "").trim();
          const v = (volatileStatus || "").trim();
          if (v === "input") { inputs.add(id.trim()); continue; } // ❓ overrides 👶/🕐
          const f = d === "babysit" || d === "waiting" ? d : v === "babysit" || v === "waiting" ? v : "";
          if (f) map.set(id.trim(), f);
        }
      } catch {
        /* no tmux server reachable → no flags */
      }
      this._paneFlags = { at: now, map, inputs };
    }
    return (this._paneFlags.map.get(paneId) as "babysit" | "waiting" | undefined) ?? null;
  }

  /** TRUE when the pane's volatile @claude_pane_status is `input` (the ❓ glyph) — set by Claude
   *  Code's OWN notify hook the moment it needs the operator (AskUserQuestion dialog, permission
   *  prompt, idle prompt). This is in-process truth, independent of the transcript: the
   *  2026-06-11 session-337 incident #2 was a dialog ON SCREEN whose assistant message was never
   *  flushed to the .jsonl at all — no transcript-based layer (heuristic, sampler, model) could
   *  ever have seen it. Shares paneBabysit's 2s-cached `tmux list-panes -a` scan: zero extra cost. */
  paneInput(paneId: string | null | undefined): boolean {
    if (!paneId || this.demo || !haveTmux()) return false;
    this.paneBabysit(paneId); // ensure/refresh the shared cache
    return this._paneFlags?.inputs?.has(paneId) ?? false;
  }

  /** Locate (and cache) the transcript file for a session. */
  transcriptFor(session: SessionRow): string | null {
    if (session.transcript_path && fs.existsSync(session.transcript_path)) return session.transcript_path;
    // PREFER the exact match by claude_session_id: robust for background agents and for
    // sessions whose worktree differs from where `claude` ran, and it can't return a DIFFERENT
    // session's transcript that merely shares the cwd dir. (Was missing → bg-agent panes spammed
    // "(no transcript found for this session)".)
    if (session.claude_session_id) {
      const byId = findTranscriptById(session.claude_session_id, session.worktree_path);
      if (byId) {
        this.db.prepare("UPDATE sessions SET transcript_path=? WHERE id=?").run(byId, session.id);
        return byId;
      }
    }
    const t = findTranscript(session.worktree_path);
    if (t)
      this.db
        .prepare("UPDATE sessions SET transcript_path=? WHERE id=?")
        .run(t, session.id);
    return t;
  }

  list(): SessionRow[] {
    return allSessions(this.db);
  }
}
