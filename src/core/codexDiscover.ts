/**
 * Auto-discover the operator's most-recently-active **OpenAI Codex CLI** sessions and register
 * them in the cockpit alongside Claude sessions (kind='codex'), so a mixed Claude+Codex workflow
 * shows up in one queue. Mirrors discover.ts's approach: take the N rollout transcripts written
 * most recently, derive cwd + a title + the resumable session id, and upsert.
 *
 * Codex rollouts live under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. We do NOT map
 * Codex sessions to tmux panes (that pipeline is Claude-specific); a discovered Codex session is a
 * roster entry that opens a dedicated `codex resume <id>` terminal on demand
 * (controller.directResumeSpec). State detection then decides if it's WAITING_INPUT/DONE.
 *
 * Cheap + safe when Codex is unused: if ~/.codex/sessions doesn't exist this is a no-op (zero cost),
 * so the engine can call it unconditionally every tick.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { DatabaseSync } from "node:sqlite";
import { upsertDiscoveredSession } from "./db";
import { deriveCodexMeta } from "./codexTranscript";

const execFileP = promisify(execFile);

/** ~/.codex/sessions (override with CODEX_HOME, matching the Codex CLI's own env knob). */
export function codexSessionsRoot(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "sessions");
}

/** Read only the HEAD (~64KB) of a rollout — session_meta + the first prompt live at the top. */
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

/** The uuid in a rollout filename: rollout-<timestamp>-<uuid>.jsonl → <uuid> (fallback session id). */
export function sessionIdFromRolloutName(file: string): string {
  const base = path.basename(file).replace(/\.jsonl$/, "");
  const m = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(base);
  if (m) return m[1];
  return base.replace(/^rollout-/, "");
}

/** Recursively collect *.jsonl rollout files under `root` (the YYYY/MM/DD tree), with a hard cap
 *  on directories walked so a huge history never stalls the tick. Newest dirs are walked first. */
async function collectRollouts(root: string, maxFiles = 400): Promise<{ file: string; mtimeMs: number }[]> {
  const fsp = fs.promises;
  const out: { file: string; mtimeMs: number }[] = [];
  // Walk the date hierarchy newest-first: sort each directory level descending so we hit recent
  // days before old ones and can stop once we have plenty.
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= maxFiles || depth > 6) return;
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl") && e.name.startsWith("rollout-")).map((e) => e.name);
    for (const f of files) {
      const fp = path.join(dir, f);
      try { out.push({ file: fp, mtimeMs: (await fsp.stat(fp)).mtimeMs }); } catch {}
      if (out.length >= maxFiles) return;
    }
    for (const d of dirs) {
      await walk(path.join(dir, d), depth + 1);
      if (out.length >= maxFiles) return;
    }
  }
  await walk(root, 0);
  return out;
}

const _gitInfoCache = new Map<string, { at: number; val: { repo: string; branch: string } }>();
async function gitInfo(cwd: string): Promise<{ repo: string; branch: string }> {
  const c = _gitInfoCache.get(cwd);
  if (c && Date.now() - c.at < 60_000) return c.val;
  let val: { repo: string; branch: string };
  try {
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

/**
 * Discover recent Codex sessions and upsert them (kind='codex'). Returns how many were upserted.
 * No-op (returns 0) when ~/.codex/sessions is absent — so a Claude-only machine pays nothing.
 */
export async function discoverCodexSessions(db: DatabaseSync, limit = 20): Promise<number> {
  const root = codexSessionsRoot();
  try { await fs.promises.access(root); } catch { return 0; }

  const files = await collectRollouts(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let seen = 0;
  let chunk = 0;
  for (const { file } of files) {
    if (seen >= limit) break;
    if (++chunk % 3 === 0) await new Promise<void>((r) => setImmediate(r)); // yield so the tick never blocks
    let head = "";
    try { head = await readHead(file); } catch { continue; }
    const meta = deriveCodexMeta(head, sessionIdFromRolloutName(file));
    if (!meta) continue;
    let cwdExists = false;
    try { await fs.promises.access(meta.cwd); cwdExists = true; } catch {}
    if (!cwdExists) continue;
    const { repo, branch } = await gitInfo(meta.cwd);
    upsertDiscoveredSession(db, {
      claude_session_id: meta.sessionId, // resumable id (codex resume <id>) — reuses the column
      title: meta.title,
      repo,
      worktree_path: meta.cwd,
      branch,
      transcript_path: file,
      pane_id: null,
      tmux_target: null,
      is_live_pane: 0,
      kind: "codex",
    });
    seen++;
  }
  return seen;
}
