/**
 * Thin wrapper around the `claude` CLI in headless print mode. This uses the
 * operator's own Claude Code subscription (no ANTHROPIC_API_KEY needed) and keeps
 * every model call local and inspectable. Two tiers per the jarvis design:
 *   - cheap model (haiku) for high-volume triage
 *   - stronger model (sonnet) for the low-volume summaries the human reads
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ClaudeOpts {
  model?: string; // 'haiku' | 'sonnet' | full id
  timeoutMs?: number;
  cwd?: string;
  /** When true (the default), run from a neutral temp cwd with MCP + project/local
   *  settings skipped so the CLI never loads the repo's huge CLAUDE.md or connects
   *  MCP servers. That ~18k-token cache-creation load is what caused 90s cold calls;
   *  skipping it brings steady-state calls to ~2-4s. Set false to keep repo context. */
  lean?: boolean;
  /** WHO is asking, for the usage ledger ('state-gate', 'triage', 'enrich', 'eta', …).
   *  Every call is appended to .run/llm-usage.jsonl so the operator can answer "how much
   *  of my subscription does X drain?" with real numbers (scripts/llm-usage.js). */
  label?: string;
}

// ---------------------------------------------------------------------------------
// Usage ledger: one JSONL line per model call → <repo>/.run/llm-usage.jsonl.
// Append-only + best-effort (a logging failure must never break a model call).
// Summarize with: node scripts/llm-usage.js [hours]
// ---------------------------------------------------------------------------------
const USAGE_LOG = path.resolve(__dirname, "../../.run/llm-usage.jsonl");
function logUsage(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true });
    fs.appendFileSync(USAGE_LOG, JSON.stringify(entry) + "\n");
  } catch {}
}

// ---------------------------------------------------------------------------------
// Prompt log hook (Stage 2): every `claude -p` prompt+response can be persisted so the
// operator can review "all prompts, stored". claude.ts stays db-agnostic — the server sets
// this hook at boot to write into the chat_log table. Best-effort; a null hook = no-op.
// ---------------------------------------------------------------------------------
export interface PromptLogEntry { label: string; model: string; prompt: string; response: string | null; ms: number }
let _promptLog: ((e: PromptLogEntry) => void) | null = null;
export function setPromptLog(fn: ((e: PromptLogEntry) => void) | null): void { _promptLog = fn; }
function logPrompt(e: PromptLogEntry): void { try { _promptLog && _promptLog(e); } catch {} }

/**
 * Build (once) a neutral working directory + empty MCP config so `claude -p` starts
 * with NO project CLAUDE.md and NO MCP servers connected.
 */
let _leanDir: string | null = null;
let _emptyMcp: string | null = null;
function leanSetup(): { cwd: string; mcp: string } {
  if (_leanDir === null) {
    try {
      const dir = path.join(os.tmpdir(), "cockpit-claude-neutral");
      fs.mkdirSync(dir, { recursive: true });
      const mcp = path.join(dir, "empty-mcp.json");
      // A VALID empty MCP config FILE (not the literal string '{}'): with
      // --strict-mcp-config this means "use only these servers" => zero servers.
      if (!fs.existsSync(mcp)) fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
      _leanDir = dir;
      _emptyMcp = mcp;
    } catch {
      _leanDir = os.tmpdir();
      _emptyMcp = "";
    }
  }
  return { cwd: _leanDir!, mcp: _emptyMcp || "" };
}

/** Returns the assistant's text result, or null on any failure (callers degrade gracefully). */
export async function claudePrompt(prompt: string, opts: ClaudeOpts = {}): Promise<string | null> {
  const args = ["-p", prompt, "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);
  const lean = opts.lean !== false; // default ON
  let cwd = opts.cwd;
  if (lean) {
    const { cwd: leanCwd, mcp } = leanSetup();
    // Skip project + local settings (CLAUDE.md memory) — keep user-level auth — and
    // don't persist a session file for these throwaway enrichment calls.
    args.push("--setting-sources", "user", "--no-session-persistence");
    if (mcp) args.push("--strict-mcp-config", "--mcp-config", mcp);
    if (!cwd) cwd = leanCwd;
  }
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const child = spawn("claude", args, {
      cwd,
      env: process.env,
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      logUsage({ ts: new Date().toISOString(), label: opts.label || "unlabeled", model: opts.model || "default", ms: Date.now() - t0, timeout: true });
      resolve(null);
    }, opts.timeoutMs ?? 60000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Spawn failures (ENOENT: `claude` not on PATH — e.g. a systemd unit without
      // ~/.local/bin) must hit the ledger, or the whole model layer dies INVISIBLY.
      logUsage({ ts: new Date().toISOString(), label: opts.label || "unlabeled", model: opts.model || "default", ms: Date.now() - t0, spawn_error: String((e as any)?.code || e).slice(0, 60) });
      resolve(null);
    });
    child.on("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        const u = j.usage || {};
        logUsage({
          ts: new Date().toISOString(),
          label: opts.label || "unlabeled",
          model: opts.model || "default",
          ms: Date.now() - t0,
          in: u.input_tokens ?? null,
          cache_w: u.cache_creation_input_tokens ?? null,
          cache_r: u.cache_read_input_tokens ?? null,
          out: u.output_tokens ?? null,
          cost_usd: j.total_cost_usd ?? null, // API-equivalent price; subscription calls don't bill this
        });
        const result = typeof j.result === "string" ? j.result : null;
        logPrompt({ label: opts.label || "unlabeled", model: opts.model || "default", prompt, response: result, ms: Date.now() - t0 });
        resolve(result);
      } catch {
        logUsage({ ts: new Date().toISOString(), label: opts.label || "unlabeled", model: opts.model || "default", ms: Date.now() - t0, error: true });
        resolve(null);
      }
    });
  });
}

/** Ask for strict JSON and parse it; null on failure. */
export async function claudeJson<T>(prompt: string, opts: ClaudeOpts = {}): Promise<T | null> {
  const txt = await claudePrompt(
    prompt + "\n\nRespond with ONLY valid minified JSON, no prose, no code fences.",
    opts
  );
  if (!txt) return null;
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}
