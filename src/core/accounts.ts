/**
 * Manual account picker for ClaudeOS.
 *
 * The `claude` CLI keeps its auth in `~/.claude.json`. That file holds exactly ONE
 * logged-in account at a time, so when you switch Anthropic accounts via `claude
 * login` the previous credentials are overwritten. This module lets you SNAPSHOT
 * the current `~/.claude.json` under a friendly label (e.g. "josef", "hello",
 * "support"), then later SWITCH back to a snapshot in one step — no logout/login
 * dance required. Useful when one account hits the weekly Claude usage cap and
 * you want to keep ClaudeOS's triage/summary calls flowing under a different one.
 *
 * Manual only — there is no auto-rotation. You decide when to switch (see
 * `src/cli.ts` → `account` subcommand).
 *
 * Snapshots live at <repo>/data/accounts/<label>.json (gitignored alongside
 * cockpit.db). A .pre-switch.json safety copy is written on every switch so
 * `switchTo(prev)` (or restoring by hand) is always possible.
 *
 * Caveat: discovery of session transcripts (~/.claude/projects) is account-
 * AGNOSTIC — every conversation from every account already lands in the same
 * dir, so switching here doesn't add/remove queue cards. It only changes which
 * subscription is billed for ClaudeOS's own `claude -p` triage calls.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type Account = {
  label: string;
  snapshotPath: string;
  mtimeMs: number;
  size: number;
};
export type AccountsState = { activeLabel?: string };

const HOME = os.homedir();
const CLAUDE_JSON = path.join(HOME, ".claude.json");

export function accountsDir(): string {
  return path.resolve(__dirname, "../../data/accounts");
}
function statePath(): string {
  return path.join(accountsDir(), "state.json");
}
function ensureDir(): void {
  fs.mkdirSync(accountsDir(), { recursive: true });
}
function snapshotFile(label: string): string {
  const safe = label.replace(/[^a-z0-9_.@-]/gi, "_");
  if (!safe) throw new Error(`invalid account label "${label}"`);
  return path.join(accountsDir(), `${safe}.json`);
}

export function loadState(): AccountsState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}
function saveState(s: AccountsState): void {
  ensureDir();
  fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
}

export function listAccounts(): { accounts: Account[]; activeLabel?: string } {
  ensureDir();
  const out: Account[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(accountsDir());
  } catch {
    /* fresh install, no dir */
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    if (f === "state.json" || f.startsWith(".")) continue;
    const fp = path.join(accountsDir(), f);
    let st: fs.Stats;
    try {
      st = fs.statSync(fp);
    } catch {
      continue;
    }
    out.push({
      label: f.replace(/\.json$/, ""),
      snapshotPath: fp,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { accounts: out, activeLabel: loadState().activeLabel };
}

/**
 * Snapshot the CURRENT ~/.claude.json under `label`. Throws if no auth file is
 * present (run `claude login` first).
 */
export function snapshotCurrent(label: string): Account {
  if (!fs.existsSync(CLAUDE_JSON)) {
    throw new Error(
      `~/.claude.json not found — log in once with \`claude login\` before snapshotting.`
    );
  }
  ensureDir();
  const dst = snapshotFile(label);
  fs.copyFileSync(CLAUDE_JSON, dst);
  const s = loadState();
  // Treat the most recently captured account as the active one when none is set.
  if (!s.activeLabel) {
    s.activeLabel = label;
    saveState(s);
  }
  const st = fs.statSync(dst);
  return { label, snapshotPath: dst, mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * Atomically swap ~/.claude.json with the named snapshot. Writes a `.pre-switch.json`
 * backup of the CURRENT credentials first so a bad swap can be rolled back by hand.
 * Returns the previously-active label (if any) for the caller's audit log.
 */
export function switchTo(label: string): string | undefined {
  const src = snapshotFile(label);
  if (!fs.existsSync(src)) {
    throw new Error(`unknown account "${label}" — try \`account list\``);
  }
  ensureDir();
  if (fs.existsSync(CLAUDE_JSON)) {
    fs.copyFileSync(CLAUDE_JSON, path.join(accountsDir(), ".pre-switch.json"));
  }
  // Use a temp file + rename for an atomic replace on the live ~/.claude.json.
  const tmp = `${CLAUDE_JSON}.claudeos.tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, CLAUDE_JSON);
  const prev = loadState().activeLabel;
  saveState({ activeLabel: label });
  return prev;
}

export function removeAccount(label: string): void {
  const fp = snapshotFile(label);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  const s = loadState();
  if (s.activeLabel === label) {
    delete s.activeLabel;
    saveState(s);
  }
}
