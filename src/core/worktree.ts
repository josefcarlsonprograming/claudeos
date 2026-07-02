/**
 * Git worktree management. Each Claude Code session runs fully isolated in its own
 * worktree on its own branch, so 20 sessions never touch each other's files.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Env whose PATH is augmented with the usual git/tool locations. node-pty and Node's own
 *  execFileSync resolve the bare command (`git`) against THIS PATH — and macOS GUI/launchd
 *  processes (the desktop app, systemd --user units) start with a minimal PATH that omits
 *  Homebrew (/opt/homebrew/bin) and ~/.local/bin. Without this, `execFileSync("git", …)`
 *  throws `spawnSync git ENOENT` even though git is installed. Mirrors envNoTmux() in
 *  sessions.ts and the node-pty env in controller.ts. */
export function gitEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  const home = os.homedir();
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  e.PATH = [...extra, ...String(e.PATH || "").split(":")].filter((p, i, a) => p && a.indexOf(p) === i).join(":");
  return e;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() });
}

/** Canonicalize a path (resolve symlinked prefixes). This matters on macOS, where `os.tmpdir()`
 *  yields `/var/folders/…` but git's `worktree list` reports the resolved real path
 *  `/private/var/folders/…`. Building every worktree path from the canonical repo root keeps our
 *  constructed paths byte-identical to what git reports, so the idempotency guard actually matches
 *  an existing worktree instead of re-running `worktree add` on an already-registered path (git
 *  exits 128) — and a session's stored worktree_path stays stable across re-opens. A not-yet-created
 *  path can't be resolved, so we fall back to a normalized absolute path. */
function realpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}
/** True when two filesystem paths point at the SAME location (symlink/normalization tolerant). */
function samePath(a: string, b: string): boolean {
  return realpath(a) === realpath(b);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  repo: string;
}

export function repoName(repo: string): string {
  return path.basename(repo.replace(/\/$/, ""));
}

/** Per-repo base-ref override, stored in the repo's own git config:
 *  `git config cockpit.baseref main`. Repos whose origin/HEAD points at a
 *  stale branch (your-repo: master lags main, so sessions cut from it miss
 *  .claude/commands etc.) set this once and every new session worktree starts from it. */
function configuredBaseRef(repo: string): string | null {
  try {
    return git(repo, ["config", "--local", "--get", "cockpit.baseref"]).trim() || null;
  } catch {
    return null;
  }
}

/** Resolve the ref new session branches are cut from: explicit baseRef > cockpit.baseref >
 *  origin/HEAD. Unconfigured repos keep the exact old behavior (local default branch, no
 *  network — local-only commits stay visible). A configured repo gets a best-effort bounded
 *  fetch and prefers origin/<name>, because the configured branch advances on GitHub (PR
 *  merges) while the local ref goes stale. A bad config value must degrade to the default
 *  branch, never brick every session launch in that repo. */
function resolveBase(repo: string, baseRef?: string): string {
  if (baseRef) return baseRef;
  const cfg = configuredBaseRef(repo);
  if (!cfg) return defaultBranch(repo);
  const name = cfg.replace(/^origin\//, "");
  try {
    execFileSync("git", ["fetch", "origin", name], {
      cwd: repo, stdio: "ignore", timeout: 5000, env: gitEnv(),
    });
  } catch { /* offline / no remote — stale refs below still work */ }
  const ok = (ref: string) => { try { git(repo, ["rev-parse", "--verify", ref]); return true; } catch { return false; } };
  if (ok(`refs/remotes/origin/${name}`)) return `origin/${name}`;
  if (ok(`refs/heads/${name}`)) return name;
  return defaultBranch(repo);
}

/** Create (or reuse) an isolated worktree + branch for a task. */
export function createWorktree(repo: string, taskSlug: string, baseRef?: string): WorktreeInfo {
  repo = realpath(repo); // canonical root → constructed paths match git's `worktree list` output
  const branch = `cockpit/${taskSlug}`;
  const wtRoot = path.join(repo, ".cockpit-worktrees");
  fs.mkdirSync(wtRoot, { recursive: true });
  const wtPath = path.join(wtRoot, taskSlug);

  // Already present?
  const existing = listWorktrees(repo).find((w) => samePath(w.path, wtPath));
  if (existing) return existing;

  // Create branch if missing. Base resolution (and its possible fetch) only happens when
  // the branch is actually being created — relaunching an existing slug stays instant.
  let branchExists = true;
  try {
    git(repo, ["rev-parse", "--verify", branch]);
  } catch {
    branchExists = false;
  }
  if (branchExists) git(repo, ["worktree", "add", wtPath, branch]);
  // --no-track: when base is origin/<name> the new cockpit branch must not adopt it as
  // upstream, or a bare `git push` in the session targets the protected base branch.
  else git(repo, ["worktree", "add", "--no-track", "-b", branch, wtPath, resolveBase(repo, baseRef)]);
  return { path: wtPath, branch, repo };
}

/** PR-TERMINAL: create (or reuse) a worktree checked out on a PR's HEAD branch, so a terminal
 *  opened on a PR card sees the PR's actual code. Unlike createWorktree this never creates a new
 *  `cockpit/` branch — it checks out the existing PR branch (fetching it from origin if missing),
 *  and falls back to a DETACHED checkout of origin/<head> when the branch is already checked out
 *  in another worktree (git refuses the same branch in two worktrees). */
export function createPrWorktree(repo: string, prNumber: number, headRef: string): WorktreeInfo {
  repo = realpath(repo); // canonical root → constructed paths match git's `worktree list` output
  const wtRoot = path.join(repo, ".cockpit-worktrees");
  fs.mkdirSync(wtRoot, { recursive: true });
  const slug =
    `pr-${prNumber}-` +
    (headRef.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "head");
  const wtPath = path.join(wtRoot, slug);
  const existing = listWorktrees(repo).find((w) => samePath(w.path, wtPath));
  if (existing) return { ...existing, branch: headRef };

  // Best-effort fetch so a PR pushed from another machine is checkout-able (offline / no-remote
  // repos — e.g. the demo's throwaway PR repo — still work off their local refs).
  try { git(repo, ["fetch", "origin", headRef]); } catch {}
  const hasRef = (ref: string) => { try { git(repo, ["rev-parse", "--verify", ref]); return true; } catch { return false; } };
  if (hasRef(headRef)) {
    try { git(repo, ["worktree", "add", wtPath, headRef]); return { path: wtPath, branch: headRef, repo }; }
    catch { /* branch checked out elsewhere → detached fallback below */ }
  } else if (hasRef(`origin/${headRef}`)) {
    try { git(repo, ["worktree", "add", "--track", "-b", headRef, wtPath, `origin/${headRef}`]); return { path: wtPath, branch: headRef, repo }; }
    catch { /* racing branch creation → detached fallback below */ }
  }
  const ref = hasRef(`origin/${headRef}`) ? `origin/${headRef}` : headRef;
  git(repo, ["worktree", "add", "--detach", wtPath, ref]); // throws if the ref truly doesn't exist
  return { path: wtPath, branch: headRef, repo };
}

export function defaultBranch(repo: string): string {
  try {
    const head = git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim();
    return head.replace("refs/remotes/origin/", "");
  } catch {
    // fall back to current branch
    try {
      return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    } catch {
      return "HEAD";
    }
  }
}

export function listWorktrees(repo: string): WorktreeInfo[] {
  let out = "";
  try {
    out = git(repo, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const infos: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9).trim(), repo };
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "").trim();
    else if (line === "") {
      if (cur.path) infos.push({ path: cur.path, branch: cur.branch || "(detached)", repo });
      cur = {};
    }
  }
  if (cur.path) infos.push({ path: cur.path, branch: cur.branch || "(detached)", repo });
  return infos;
}

export function removeWorktree(repo: string, wtPath: string): void {
  try {
    git(repo, ["worktree", "remove", "--force", wtPath]);
  } catch {
    /* best effort */
  }
}
