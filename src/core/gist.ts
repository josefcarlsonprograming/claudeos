/**
 * gist.ts — the SOUL-voiced "highlights" of a session's conversation.
 *
 * The chat interface (Pane A "chat" view) shows, instead of the raw terminal, a short feed of
 * BEATS: a few friendly, decisive one-liners in the operator's own voice (see soul.ts) that say
 * what Claude has been doing and — if it's waiting — what it's asking. "Like when Claude is
 * talking, just the highlights, not the whole thing."
 *
 * One cheap `claude -p` (haiku, lean) per gist, with personaBlock() injected so the beats read in
 * the operator's voice. Cached by (sessionId, transcript-mtime) so an unchanged session costs zero
 * model calls — exactly the enrich.ts discipline. Always degrades to a deterministic fallback so
 * the view never blanks offline / on failure. Every real generation is logged to chat_log (role
 * 'gist') so the operator can review what was distilled and where it diverged from reality.
 */
import { SessionState, TriageCategory, logChat } from "./db";
import { claudeJson } from "./claude";
import type { DatabaseSync } from "node:sqlite";

export interface GistInput {
  sessionId: number;
  title: string;
  state: SessionState;
  category?: TriageCategory | null;
  question?: string; // the ready question / final text (drives the closing ASK beat)
  conversation: string; // recent conversation tail, plain text (the caller renders it)
  lastPrompt?: string; // the operator's most recent request to this session (verbatim)
  model: string;
  maxBeats: number;
}

export interface Beat {
  kind: "beat" | "ask"; // 'beat' = a highlight of what happened; 'ask' = the open question / next call
  text: string;
}

export interface GistOutput {
  beats: Beat[];
}

/** Text generator; injected in tests, defaults to the lean `claude -p`. */
export type Gen = (prompt: string) => Promise<string | null>;

function firstSentence(s: string, max = 160): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^.*?[.?!](\s|$)/);
  const out = (m ? m[0] : t).trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

/** Deterministic beats when the model call fails / is offline. Honest and grounded: it only
 *  restates the state + the question + the tail of the conversation — never invents progress. */
export function gistFallback(input: GistInput): GistOutput {
  const beats: Beat[] = [];
  // A single "what happened" beat from the tail of the conversation. The conversation is raw JSONL,
  // so only use it if the tail reads as prose — never dump `{"type":...}` machinery as a "beat"
  // (this path runs when the model is offline/rate-limited, so it must still look clean).
  const convo = (input.conversation || "").replace(/\s+/g, " ").trim();
  const prose = convo.slice(-500).replace(/[{}\[\]"]/g, "").trim();
  const looksJson = /"(type|role|sessionId|mode|timestamp|message|content)"\s*:/.test(convo.slice(-500)) || convo.trim().startsWith("{");
  if (convo && !looksJson) {
    beats.push({ kind: "beat", text: firstSentence(prose) || "Claude's been working on this." });
  } else {
    beats.push({ kind: "beat", text: "Claude's been working — open the terminal to see the details." });
  }
  // The closing ASK / next-action beat, driven by the ready state.
  if (input.state === "DONE") {
    beats.push({ kind: "ask", text: input.question ? firstSentence(input.question) : "Looks done — take a look and call it." });
  } else if (input.state === "WAITING_INPUT") {
    beats.push({ kind: "ask", text: input.question ? firstSentence(input.question) : "It needs a decision from you." });
  } else if (input.question) {
    beats.push({ kind: "ask", text: firstSentence(input.question) });
  }
  return { beats: beats.slice(0, Math.max(1, input.maxBeats)) };
}

/** Build the single gist prompt, with the operator's persona injected. (Exported for tests.) */
export function buildGistPrompt(input: GistInput): string {
  let persona = "";
  try { persona = require("./soul").personaBlock() || ""; } catch {}
  const askBlock =
    input.lastPrompt && input.lastPrompt.trim()
      ? `\nThe operator's most recent request to this session:\n"""${input.lastPrompt.slice(0, 1200)}"""`
      : "";
  const stateLine =
    input.state === "DONE"
      ? "The session just FINISHED — the last beat should tell the operator to take a look and decide if it's done."
      : input.state === "WAITING_INPUT"
        ? "The session is WAITING on the operator — the last beat (kind 'ask') should be the actual question/decision it needs, phrased warmly."
        : "Summarize where the session stands.";
  return `You are narrating a Claude Code session to its operator, in HIS voice — short, warm, engaging, decisive, no corporate filler. Give the GIST: a few highlights of what's been happening, "like when Claude is talking" — NOT the whole transcript.
${persona}
${stateLine}

Return JSON: {"beats": [{"kind": "beat"|"ask", "text": "..."}]}
- ${input.maxBeats} beats MAX, newest-last, each ONE short sentence in his voice.
- "beat" = a highlight of what Claude did / found / decided. "ask" = the open question or the one next action. End with exactly one "ask" beat when the session is waiting or done.
- Ground every beat in the conversation below — never invent progress that isn't there.

Session title: ${input.title}
Recent conversation (tail):
"""${(input.conversation || "").slice(-3500)}"""${askBlock}`;
}

/** Generate a gist for one session. Best-effort: falls back deterministically, logs real calls. */
export async function generateGist(
  input: GistInput,
  opts?: { gen?: Gen; db?: DatabaseSync }
): Promise<GistOutput> {
  const fallback = gistFallback(input);
  const prompt = buildGistPrompt(input);
  const gen: Gen =
    opts?.gen || ((p: string) => require("./claude").claudePrompt(p + "\n\nRespond with ONLY valid minified JSON, no prose, no code fences.", { model: input.model, timeoutMs: 60000, label: "gist" }));

  let raw: string | null = null;
  try {
    raw = await gen(prompt);
  } catch {
    raw = null;
  }
  if (!raw) return fallback;

  let parsed: { beats?: { kind?: string; text?: string }[] } | null = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }

  let beats: Beat[] = [];
  if (parsed && Array.isArray(parsed.beats)) {
    beats = parsed.beats
      .filter((b) => b && typeof b.text === "string" && b.text.trim())
      .slice(0, Math.max(1, input.maxBeats))
      .map((b) => ({ kind: b.kind === "ask" ? "ask" : "beat", text: String(b.text).trim() }));
  }
  if (!beats.length) return fallback;

  const out: GistOutput = { beats };
  // Log the real generation (best-effort) — the durable record the operator reviews.
  if (opts?.db) {
    let persona = "";
    try { persona = require("./soul").personaBlock() || ""; } catch {}
    logChat(opts.db, {
      scope: "task",
      role: "gist",
      sessionId: input.sessionId,
      content: JSON.stringify(out.beats),
      prompt,
      personaSnapshot: persona || null,
      model: input.model,
    });
  }
  return out;
}

// --- cache (by sessionId → content key), so an unchanged session costs zero model calls. The key
// is any string that changes exactly when the gist should: the engine passes the ready-turn
// signature (stable while the same turn is parked); the server passes the transcript mtime. ---
const _gistCache = new Map<number, { key: string; out: GistOutput }>();

/** The last gist computed for a session (for the /api/state payload), or null. */
export function cachedGist(sessionId: number): GistOutput | null {
  return _gistCache.get(sessionId)?.out ?? null;
}

/** Return the cached gist when the content key is unchanged; otherwise regenerate + cache. */
export async function refreshGist(
  input: GistInput,
  cacheKey: string,
  opts?: { gen?: Gen; db?: DatabaseSync; force?: boolean }
): Promise<GistOutput> {
  const c = _gistCache.get(input.sessionId);
  if (c && c.key === cacheKey && !opts?.force) return c.out;
  const out = await generateGist(input, { gen: opts?.gen, db: opts?.db });
  _gistCache.set(input.sessionId, { key: cacheKey, out });
  return out;
}

/** Test hook: drop the cache. */
export function _clearGistCache(): void {
  _gistCache.clear();
}
