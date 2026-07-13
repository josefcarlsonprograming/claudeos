/**
 * Parse an OpenAI **Codex CLI** rollout transcript into the SAME thin `TranscriptView`
 * the Claude parser produces (src/core/transcript.ts), so every downstream consumer —
 * state detection (stateDetector.ts), the read-only conversation view, enrichment — works on
 * a Codex session with zero branching. `parseTranscript`/`parseTranscriptTail` in transcript.ts
 * dispatch here by PATH (`isCodexTranscriptPath`).
 *
 * Codex stores sessions as newline-delimited JSON under
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * where each line is a `RolloutLine` wrapper: { timestamp, type, payload }. The line `type`s
 * we care about:
 *   - session_meta   → payload.{ id, cwd, git, ... }               (the header; cwd + session id)
 *   - response_item  → payload.type = message|function_call|function_call_output|reasoning|...
 *       message.role = user|assistant|developer|system, content = [{type:input_text|output_text,text}]
 *   - event_msg      → payload.type = user_message|agent_message|token_count|...  (replay copies)
 *
 * We build turns from the `response_item` message/tool lines (the authoritative record) and treat
 * `event_msg` copies as a fallback only. Older Codex builds wrote BARE SessionMeta/ResponseItem
 * objects (no {type,payload} wrapper) — we tolerate both by falling back to top-level fields.
 */
import type { Turn, TranscriptView } from "./transcript";

/** Is this transcript path a Codex rollout (vs a Claude ~/.claude/projects transcript)? */
export function isCodexTranscriptPath(p: string): boolean {
  if (!p) return false;
  return /[/\\]\.codex[/\\]sessions[/\\]/.test(p) || /(^|[/\\])rollout-[^/\\]*\.jsonl$/.test(p);
}

/** Pull readable text out of a Codex message `content` (string, or array of {type,text} blocks). */
function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let t = "";
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    // input_text (user), output_text (assistant), plain text — all carry a `.text`.
    if (typeof b.text === "string" && (b.type === "input_text" || b.type === "output_text" || b.type === "text" || b.type === "summary_text" || !b.type))
      t += b.text + "\n";
  }
  return t;
}

function mkTurn(role: "user" | "assistant", text: string, stop_reason: string | null, timestamp: string | null): Turn {
  return { role, text: (text || "").trim(), stop_reason, hasToolUse: false, isToolResult: false, isMeta: false, timestamp, toolUses: [], toolResultIds: [] };
}

/** Codex injects its own context as the FIRST user/developer message — an <environment_context> /
 *  <user_instructions> envelope, or a "## My request for Codex" wrapper. Such a message is not an
 *  operator prompt; treat it as meta so it never becomes the title or "what you asked". */
function isInjectedContext(text: string): boolean {
  const t = (text || "").trimStart();
  return t.startsWith("<environment_context") || t.startsWith("<user_instructions") ||
    t.startsWith("<") && /<\/(environment_context|user_instructions)>/.test(t);
}

/** Build a Claude-shaped TranscriptView from raw Codex rollout JSONL (full text or a tail slice). */
export function codexViewFromRaw(raw: string): TranscriptView {
  const turns: Turn[] = [];
  let cwd: string | null = null;
  let lastTimestamp: string | null = null;
  // If the file carries authoritative response_item messages we IGNORE event_msg copies (they are
  // replay duplicates); if it has none (rare), we fall back to event_msg. Decide in one pass by
  // buffering event_msg turns separately.
  const eventTurns: Turn[] = [];
  let sawResponseMessage = false;

  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (s.length > 200_000) continue; // giant tool blobs — never the state turn
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    const ts = typeof o.timestamp === "string" ? o.timestamp : null;
    if (ts) lastTimestamp = ts;
    // Wrapper form { type, payload } (current) vs bare object (legacy) — normalize.
    const wrapType: string = typeof o.type === "string" ? o.type : "";
    const payload = o.payload && typeof o.payload === "object" ? o.payload : o;
    const pt: string = typeof payload.type === "string" ? payload.type : "";

    if (wrapType === "session_meta" || pt === "session_meta") {
      if (typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
      continue;
    }
    if (typeof payload.cwd === "string" && payload.cwd && !cwd) cwd = payload.cwd;
    if (wrapType === "turn_context") continue;

    // ---- response_item: the authoritative conversation record ----
    if (wrapType === "response_item" || pt === "message" || pt === "function_call" || pt === "local_shell_call" ||
        pt === "custom_tool_call" || pt === "function_call_output" || pt === "local_shell_call_output" ||
        pt === "custom_tool_call_output" || pt === "reasoning") {
      if (pt === "message") {
        const role = payload.role;
        const text = textOf(payload.content).trim();
        if (role === "assistant") {
          sawResponseMessage = true;
          turns.push(mkTurn("assistant", text, "end_turn", ts));
        } else if (role === "user") {
          sawResponseMessage = true;
          const turn = mkTurn("user", text, null, ts);
          if (isInjectedContext(text)) turn.isMeta = true;
          turns.push(turn);
        } else if (text) {
          // developer / system → injected instructions; keep as meta so state/prompt logic skips it.
          const turn = mkTurn("user", text, null, ts);
          turn.isMeta = true;
          turns.push(turn);
        }
      } else if (pt === "function_call" || pt === "local_shell_call" || pt === "custom_tool_call") {
        const name = payload.name || payload.tool_name || (pt === "local_shell_call" ? "shell" : "tool");
        const id = String(payload.call_id || payload.id || "");
        turns.push({ role: "assistant", text: "", stop_reason: "tool_use", hasToolUse: true, isToolResult: false, isMeta: false, timestamp: ts, toolUses: [{ id, name: String(name) }], toolResultIds: [] });
      } else if (pt === "function_call_output" || pt === "local_shell_call_output" || pt === "custom_tool_call_output") {
        const id = String(payload.call_id || payload.id || "");
        turns.push({ role: "user", text: "", stop_reason: null, hasToolUse: false, isToolResult: true, isMeta: false, timestamp: ts, toolUses: [], toolResultIds: id ? [id] : [] });
      }
      // pt === "reasoning" → internal thinking, not a turn; skip.
      continue;
    }

    // ---- event_msg: replay copies (used only if no response_item messages exist) ----
    if (wrapType === "event_msg") {
      if (pt === "user_message") {
        const text = String(payload.message ?? payload.text ?? "").trim();
        const turn = mkTurn("user", text, null, ts);
        if (isInjectedContext(text)) turn.isMeta = true;
        eventTurns.push(turn);
      } else if (pt === "agent_message") {
        eventTurns.push(mkTurn("assistant", String(payload.message ?? payload.text ?? "").trim(), "end_turn", ts));
      }
      continue;
    }
  }

  const finalTurns = sawResponseMessage ? turns : (turns.length ? turns : eventTurns);

  let lastAssistant: Turn | null = null;
  for (let i = finalTurns.length - 1; i >= 0; i--)
    if (finalTurns[i].role === "assistant") { lastAssistant = finalTurns[i]; break; }
  let lastMeaningful: Turn | null = null;
  for (let i = finalTurns.length - 1; i >= 0; i--) {
    const tn = finalTurns[i];
    if (tn.role === "assistant" || (tn.role === "user" && !tn.isToolResult && tn.text)) { lastMeaningful = tn; break; }
  }
  let lastUserPrompt: Turn | null = null;
  for (let i = finalTurns.length - 1; i >= 0; i--) {
    const tn = finalTurns[i];
    if (tn.role === "user" && !tn.isToolResult && !tn.isMeta && tn.text) { lastUserPrompt = tn; break; }
  }
  return { turns: finalTurns, lastAssistant, lastMeaningful, lastUserPrompt, lastTimestamp, raw, cwd };
}

export interface CodexMeta {
  sessionId: string;   // the resumable Codex session id (session_meta.id, or the filename uuid)
  cwd: string;         // working directory the session ran in
  title: string;       // first real operator prompt, trimmed to a headline
}

/** Derive { sessionId, cwd, title } from the HEAD of a rollout file (session_meta + first prompt).
 *  `fallbackId` is the uuid parsed from the filename, used when session_meta lacks an id. */
export function deriveCodexMeta(headRaw: string, fallbackId: string): CodexMeta | null {
  let sessionId = "";
  let cwd = "";
  let title = "";
  for (const line of headRaw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    const wrapType: string = typeof o.type === "string" ? o.type : "";
    const payload = o.payload && typeof o.payload === "object" ? o.payload : o;
    const pt: string = typeof payload.type === "string" ? payload.type : "";
    if (wrapType === "session_meta" || pt === "session_meta") {
      if (!sessionId && typeof payload.id === "string" && payload.id) sessionId = payload.id;
      if (!cwd && typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
      continue;
    }
    if (!cwd && typeof payload.cwd === "string" && payload.cwd) cwd = payload.cwd;
    if (!title) {
      let text = "";
      if (pt === "message" && payload.role === "user") text = textOf(payload.content).trim();
      else if (wrapType === "event_msg" && pt === "user_message") text = String(payload.message ?? payload.text ?? "").trim();
      if (text && !isInjectedContext(text) && !text.startsWith("<"))
        title = text.replace(/\s+/g, " ").slice(0, 80);
    }
    if (sessionId && cwd && title) break;
  }
  if (!sessionId) sessionId = fallbackId;
  if (!cwd) return null; // no working directory → an unusable / torn transcript head
  if (!title) title = "Codex session";
  return { sessionId, cwd, title };
}
