/**
 * Parse a Claude Code transcript (.jsonl under ~/.claude/projects/<encoded-cwd>/).
 * We only need a thin view: the meaningful user/assistant turns and the last
 * assistant turn's stop_reason + text. Robust to the many bookkeeping line types
 * (mode, permission-mode, file-history-snapshot, attachment, ...).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { isCodexTranscriptPath } from "./codexTranscript";

export interface Turn {
  role: "user" | "assistant";
  text: string;
  stop_reason: string | null;
  hasToolUse: boolean;
  isToolResult: boolean; // user turn that is only a tool_result (continuation)
  isMeta: boolean; // harness-injected user turn (resume banner, hook output, …) — NOT operator-typed
  timestamp: string | null;
  toolUses: { id: string; name: string }[]; // tool_use blocks in this turn (id + tool name)
  toolResultIds: string[]; // tool_use_ids this turn answers via tool_result blocks
}

/** The operator-typed text in a user turn, with harness envelopes stripped. Returns "" when the
 *  turn is ONLY an injected envelope (a standalone <system-reminder>, a slash-command expansion,
 *  local-command stdout, a hook message, a "Caveat:" resume banner). Such turns arrive as
 *  role:"user" and would otherwise be picked as "what you last asked" — blanking the card (a pure
 *  reminder strips to nothing) or polluting it. A REAL prompt that merely has a reminder appended
 *  still returns its real text here, so it's correctly selected (the renderer strips the tail). */
export function operatorPromptText(text: string): string {
  return (text || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, " ")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, " ")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, " ")
    .replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, " ")
    .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, " ")
    .replace(/^Caveat:[\s\S]*?(\n\n|$)/m, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TranscriptView {
  turns: Turn[];
  lastAssistant: Turn | null;
  lastMeaningful: Turn | null; // last assistant, or last real user text
  lastUserPrompt: Turn | null; // the operator's most recent real prompt (not a tool_result)
  lastTimestamp: string | null;
  raw: string; // full text, for "expand to raw"
  cwd: string | null;
}

function textFromContent(content: any): {
  text: string; hasToolUse: boolean; isToolResult: boolean;
  toolUses: { id: string; name: string }[]; toolResultIds: string[];
} {
  if (typeof content === "string") return { text: content, hasToolUse: false, isToolResult: false, toolUses: [], toolResultIds: [] };
  if (!Array.isArray(content)) return { text: "", hasToolUse: false, isToolResult: false, toolUses: [], toolResultIds: [] };
  let text = "";
  let hasToolUse = false;
  let isToolResult = false;
  const toolUses: { id: string; name: string }[] = [];
  const toolResultIds: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text + "\n";
    else if (block.type === "tool_use") {
      hasToolUse = true;
      toolUses.push({ id: String(block.id || ""), name: String(block.name || "") });
    }
    else if (block.type === "tool_result") {
      isToolResult = true;
      if (block.tool_use_id) toolResultIds.push(String(block.tool_use_id));
      // include any human-visible text in a tool_result so questions inside still parse
      if (typeof block.content === "string") text += block.content + "\n";
      else if (Array.isArray(block.content)) {
        for (const c of block.content)
          if (c && c.type === "text" && typeof c.text === "string") text += c.text + "\n";
      }
    }
  }
  return { text: text.trim(), hasToolUse, isToolResult, toolUses, toolResultIds };
}

/** Parse JSONL text into the thin transcript view (shared by full + tail readers). */
function viewFromRaw(raw: string): TranscriptView {
  const lines = raw.split("\n");
  const turns: Turn[] = [];
  let cwd: string | null = null;
  let lastTimestamp: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // FIX C perf: skip parsing giant lines (>80KB are bulky tool_results / attachments — never
    // the "state" turn). Avoids a single JSON.parse holding the main thread for tens of ms.
    if (t.length > 80_000) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.timestamp) lastTimestamp = o.timestamp;
    if (o.cwd) cwd = o.cwd;
    if (o.type !== "user" && o.type !== "assistant") continue;
    const msg = o.message;
    if (!msg) continue;
    const { text, hasToolUse, isToolResult, toolUses, toolResultIds } = textFromContent(msg.content);
    turns.push({
      role: o.type,
      text,
      stop_reason: msg.stop_reason ?? null,
      hasToolUse,
      isToolResult,
      isMeta: o.isMeta === true,
      timestamp: o.timestamp ?? null,
      toolUses,
      toolResultIds,
    });
  }
  let lastAssistant: Turn | null = null;
  for (let i = turns.length - 1; i >= 0; i--)
    if (turns[i].role === "assistant") { lastAssistant = turns[i]; break; }
  let lastMeaningful: Turn | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const tn = turns[i];
    if (tn.role === "assistant" || (tn.role === "user" && !tn.isToolResult && tn.text)) { lastMeaningful = tn; break; }
  }
  // The operator's most recent ACTUAL prompt (a real user turn with text, not a tool_result
  // continuation). This is "what you last asked this session" — shown verbatim on the card.
  // Skip harness-injected turns: isMeta (e.g. the "Continue from where you left off." resume
  // banner) and turns that are ONLY an envelope (a standalone <system-reminder> / slash-command
  // expansion / hook output) — both would otherwise win this scan and blank or pollute "You asked".
  let lastUserPrompt: Turn | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const tn = turns[i];
    if (tn.role === "user" && !tn.isToolResult && !tn.isMeta && operatorPromptText(tn.text)) { lastUserPrompt = tn; break; }
  }
  return { turns, lastAssistant, lastMeaningful, lastUserPrompt, lastTimestamp, raw, cwd };
}

/** Tools whose tool_use IS an interactive prompt to the operator (the up/down-arrow select UI /
 *  the plan-approval dialog). They never run anything on their own: the moment one is written to
 *  the transcript with no tool_result, the session is parked on a question waiting for a human —
 *  the exact state the queue exists to surface. (2026-06-11 incident, session
 *  new-claude-session-337: a pending AskUserQuestion read as "tool_use ⇒ WORKING" at every gate
 *  layer and the question card never surfaced — the operator found it by hand.) */
export const INTERACTIVE_PROMPT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** The name of an interactive prompt tool (AskUserQuestion / ExitPlanMode) that is currently
 *  PENDING — called in the last assistant turn with no tool_result for its id anywhere after —
 *  or null. Scans back over trailing tool_result turns so a parallel sibling tool answering
 *  first doesn't mask the still-open question. */
export function pendingInteractivePrompt(view: TranscriptView): string | null {
  const turns = view.turns;
  // Scan back over the trailing run of assistant turns + tool_result continuations (real
  // transcripts split one assistant message into one JSONL line per content block, and a parallel
  // sibling tool may answer before the question does). Stop at the operator's last real prompt:
  // an answered question always has its tool_result between it and here, so every tool_use seen
  // unanswered in this window is genuinely open.
  const answered = new Set<string>();
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "user" && !t.isToolResult && t.text) break; // real operator prompt — done
    for (const id of t.toolResultIds || []) answered.add(id); // hand-built Turns may omit the field
    if (t.role === "assistant") {
      const open = (t.toolUses || []).find((u) => INTERACTIVE_PROMPT_TOOLS.has(u.name) && !answered.has(u.id));
      if (open) return open.name;
    }
  }
  return null;
}

/** A session that STALLED after a tool call — the "type continue and it wakes up" failure
 *  (operator report 2026-06-15). The last meaningful turn is a tool_result the assistant never
 *  answered, AND the assistant that called the tool intended to keep going (stop_reason 'tool_use').
 *  Unambiguous vs the look-alikes the engine must NOT auto-nudge:
 *    - a pending QUESTION is a tool_use with NO tool_result yet (AskUserQuestion) — excluded;
 *    - a DONE turn ends on 'end_turn' — excluded (lastAssistant stop_reason);
 *    - an in-flight tool has a tool_use with no result yet — excluded;
 *    - a session mid-GENERATING the continuation is excluded by the engine's CPU-idle gate.
 *  The engine (auto_continue) sends one nudge per stall, capped + CPU-idle-gated. */
export function pendingToolStall(view: TranscriptView | null): boolean {
  if (!view) return false;
  const turns = view.turns;
  if (!turns.length) return false;
  const last = turns[turns.length - 1];
  if (!(last.role === "user" && last.isToolResult)) return false; // last entry isn't an unanswered tool_result
  const la = view.lastAssistant;
  return !!la && (la.stop_reason === "tool_use" || la.hasToolUse); // the tool-caller meant to continue
}

export function parseTranscript(filePath: string): TranscriptView {
  // FULL read — only for the raw/pretty transcript display, NOT the hot tick path.
  const raw = fs.readFileSync(filePath, "utf8");
  if (isCodexTranscriptPath(filePath)) return require("./codexTranscript").codexViewFromRaw(raw);
  return viewFromRaw(raw);
}

// FIX C: the operator's active transcripts are 14–21 MB. The 5s tick only needs the END (state
// + last message live there), so read ONLY the TAIL (~128KB) async, cached by (path, mtime) —
// ~150× less I/O than the full file, and ZERO reads when a transcript hasn't changed.
const TAIL_BYTES = 128 * 1024;
const _tailCache = new Map<string, { mtimeMs: number; view: TranscriptView }>();
export async function parseTranscriptTail(filePath: string, mtimeMs: number): Promise<TranscriptView> {
  const c = _tailCache.get(filePath);
  if (c && c.mtimeMs === mtimeMs) return c.view;
  const fsp = fs.promises;
  let raw = "";
  const fh = await fsp.open(filePath, "r");
  try {
    const st = await fh.stat();
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    if (len > 0) {
      const buf = Buffer.alloc(Number(len));
      await fh.read(buf, 0, Number(len), start);
      raw = buf.toString("utf8");
      if (start > 0) { const nl = raw.indexOf("\n"); if (nl >= 0) raw = raw.slice(nl + 1); } // drop partial first line
    }
  } finally { await fh.close(); }
  const view = isCodexTranscriptPath(filePath) ? require("./codexTranscript").codexViewFromRaw(raw) : viewFromRaw(raw);
  _tailCache.set(filePath, { mtimeMs, view });
  return view;
}

/** Find the operator's most recent REAL prompt ("what you last asked"), scanning progressively
 *  larger tails — then the whole file — when the 128KB hot tail no longer contains it. Once
 *  Claude has done enough tool-call work, the operator's prompt scrolls out of the hot tail and
 *  parseTranscriptTail().lastUserPrompt goes null; this recovers it so the "You asked" card line
 *  never blanks mid-task. BOUNDED: returns at the FIRST hit, so it rarely reads past a few MB,
 *  and the caller stores the result so this only runs once per session (not every tick). */
export async function findLastUserPromptDeep(filePath: string): Promise<string> {
  const budgets = [1 << 20, 8 << 20, Number.POSITIVE_INFINITY]; // 1MB, 8MB, whole file
  const fsp = fs.promises;
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fsp.open(filePath, "r");
    const st = await fh.stat();
    for (const budget of budgets) {
      const start = budget === Number.POSITIVE_INFINITY ? 0 : Math.max(0, st.size - budget);
      const len = st.size - start;
      if (len <= 0) continue;
      const buf = Buffer.alloc(Number(len));
      await fh.read(buf, 0, Number(len), start);
      let raw = buf.toString("utf8");
      if (start > 0) { const nl = raw.indexOf("\n"); if (nl >= 0) raw = raw.slice(nl + 1); } // drop partial first line
      const v = viewFromRaw(raw);
      if (v.lastUserPrompt?.text) return v.lastUserPrompt.text;
      if (start === 0) break; // already scanned the whole file — nothing more to read
    }
  } catch { /* unreadable transcript → "" (caller keeps whatever it had) */ }
  finally { if (fh) await fh.close().catch(() => {}); }
  return "";
}

/** Render a transcript as a readable conversation (not raw JSONL). Tool calls are
 *  collapsed to a short marker so the human-facing text stays legible. */
export function renderConversation(view: TranscriptView): string {
  const DIM = "\x1b[2m", CYAN = "\x1b[36m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
  const sep = `${DIM}──────────────────────────────────────────────${RESET}`;
  // Make a raw message body readable in a terminal read-only view: strip CRs, condense the machine
  // envelopes (teammate-message / inbox-routing JSON / tool blobs) that otherwise dump as a wall of
  // JSON, collapse blank-line runs, and cap a single huge message so one tool dump can't bury the
  // conversation.
  const clean = (s: string): string => {
    let t = s.replace(/\r/g, "").trim();
    t = t.replace(/<teammate-message[^>]*>[\s\S]*?<\/teammate-message>/g, `${DIM}‹teammate message›${RESET}`);
    // a bare JSON object/array that fills the message (inbox routing, tool envelope) → one-line marker
    if (/^[[{][\s\S]*[\]}]$/.test(t) && t.length > 200) t = `${DIM}‹${t.length}-char JSON payload elided›${RESET}`;
    t = t.replace(/\n{3,}/g, "\n\n");
    const lines = t.split("\n");
    if (lines.length > 40) t = lines.slice(0, 40).join("\n") + `\n${DIM}… (${lines.length - 40} more lines)${RESET}`;
    return t;
  };
  const out: string[] = [];
  for (const t of view.turns) {
    if (t.role === "assistant") {
      if (t.text) out.push(`${sep}\n${CYAN}▸ Claude${RESET}\n${clean(t.text)}`);
      else if (t.hasToolUse) out.push(`${sep}\n${CYAN}▸ Claude${RESET} ${DIM}[running a tool…]${RESET}`);
    } else {
      if (t.isToolResult && !t.text) continue; // skip empty tool-result echoes
      if (t.text) out.push(`${sep}\n${GREEN}▸ You${RESET}\n${clean(t.text)}`);
    }
  }
  return out.join("\n\n").trim() || "(no readable conversation yet)";
}

/** Encode a cwd to the ~/.claude/projects directory name Claude Code uses. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function projectDirFor(cwd: string): string {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectDir(cwd));
}

/** Resolve a transcript by its EXACT Claude session-id (the `.jsonl` is named
 *  `<session-id>.jsonl`). This is the reliable resolver: it does NOT depend on the
 *  session's cwd mapping cleanly to a project dir (which fails for background agents
 *  and for sessions whose worktree differs from where `claude` actually ran), and it
 *  never returns a *different* session's transcript that merely shares the cwd dir.
 *  Tries the cwd-hint's project dir first (fast), then scans every project dir.
 *  Without this, `transcriptFor` fell through to null → the terminal pane spammed
 *  "(no transcript found for this session)" on every reconnect. */
export function findTranscriptById(sessionId: string, cwdHint?: string | null): string | null {
  if (!sessionId) return null;
  const tryDir = (dir: string): string | null => {
    const p = path.join(dir, `${sessionId}.jsonl`);
    try { return fs.existsSync(p) ? p : null; } catch { return null; }
  };
  if (cwdHint) { const hit = tryDir(projectDirFor(cwdHint)); if (hit) return hit; }
  const base = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(base)) return null;
  try {
    for (const d of fs.readdirSync(base)) {
      const hit = tryDir(path.join(base, d));
      if (hit) return hit;
    }
  } catch { /* unreadable projects dir → null */ }
  return null;
}

/** Find the newest transcript .jsonl for a given worktree cwd, if any. */
export function findTranscript(cwd: string): string | null {
  const dir = projectDirFor(cwd);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

/** Stable signature of the current ready turn, for dedup of items. */
export function turnSignature(sessionId: number, lastAssistant: Turn | null): string {
  const basis = (lastAssistant?.text || "") + "|" + (lastAssistant?.timestamp || "");
  return sessionId + ":" + crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}
