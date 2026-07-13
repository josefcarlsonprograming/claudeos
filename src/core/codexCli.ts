/**
 * Thin wrapper around the `codex exec` CLI in non-interactive mode — the Codex analog of
 * claude.ts's `claude -p`. Used by the cross-review feature (crossReview.ts) so a Claude-authored
 * diff can be reviewed by Codex. Runs the operator's own Codex CLI (their ChatGPT/OpenAI auth), so
 * no API key is needed and every call stays local + inspectable.
 *
 * `codex exec "<prompt>"` runs Codex to completion and streams the assistant's final message to
 * stdout. We run it with `--sandbox read-only` from a neutral cwd: the review prompt already
 * carries the full diff text, so the reviewer needs no write access and must not touch the repo.
 * Best-effort: any failure (Codex not installed, unknown flag, timeout) resolves to null and the
 * caller degrades gracefully.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CodexOpts {
  model?: string;      // -m <model> (e.g. "gpt-5-codex"); omit for the CLI default
  timeoutMs?: number;  // default 120s — a review reads a diff + reasons, slower than a triage call
  cwd?: string;        // working dir; defaults to a neutral temp dir
  label?: string;      // usage-ledger label, mirrors claude.ts
  sandbox?: string;    // --sandbox value; default "read-only" (a reviewer never writes)
}

const USAGE_LOG = path.resolve(__dirname, "../../.run/llm-usage.jsonl");
function logUsage(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(USAGE_LOG), { recursive: true });
    fs.appendFileSync(USAGE_LOG, JSON.stringify(entry) + "\n");
  } catch {}
}

let _neutralDir: string | null = null;
function neutralCwd(): string {
  if (_neutralDir === null) {
    try {
      const dir = path.join(os.tmpdir(), "cockpit-codex-neutral");
      fs.mkdirSync(dir, { recursive: true });
      _neutralDir = dir;
    } catch { _neutralDir = os.tmpdir(); }
  }
  return _neutralDir!;
}

/** Ensure ~/.local/bin (where user-installed CLIs live) is on PATH for our subprocess, mirroring
 *  discover.envNoTmux — the server runs under systemd --user with a minimal PATH. */
function codexEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  const localBin = `${os.homedir()}/.local/bin`;
  if (!e.PATH) e.PATH = localBin;
  else if (!e.PATH.split(":").includes(localBin)) e.PATH = `${localBin}:${e.PATH}`;
  return e;
}

/** Run `codex exec` and return the assistant's final text, or null on any failure. */
export async function codexExec(prompt: string, opts: CodexOpts = {}): Promise<string | null> {
  const args = ["exec", "--sandbox", opts.sandbox || "read-only"];
  if (opts.model) args.push("-m", opts.model);
  args.push(prompt);
  const cwd = opts.cwd || neutralCwd();
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", args, { cwd, env: codexEnv() });
    } catch (e: any) {
      logUsage({ ts: new Date().toISOString(), label: opts.label || "codex", tool: "codex", ms: Date.now() - t0, spawn_error: String(e?.code || e).slice(0, 60) });
      return resolve(null);
    }
    const finish = (val: string | null, extra: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      logUsage({ ts: new Date().toISOString(), label: opts.label || "codex", tool: "codex", ms: Date.now() - t0, ...extra });
      resolve(val);
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(null, { timeout: true }); }, opts.timeoutMs ?? 120000);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", () => {}); // swallow progress chatter
    child.on("error", (e: any) => finish(null, { spawn_error: String(e?.code || e).slice(0, 60) }));
    child.on("close", (code) => {
      const text = out.trim();
      if (code === 0 && text) finish(text, { out_chars: text.length });
      else finish(text || null, { exit: code });
    });
  });
}
