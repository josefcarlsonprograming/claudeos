/**
 * gist.ts — the friendly co-worker summary of a session (the "Jarvis" voice).
 *
 * Instead of the raw terminal, the chat view shows ONE short, warm message in the operator's own
 * voice (see soul.ts) — like a co-worker giving you the gist: what's been done here, and what (if
 * anything) is needed from you. Plus 2-4 SUGGESTED REPLIES he can click to respond in one tap.
 *
 * Style (from the operator's OpenClaw/Jarvis assistant he likes): at most ~2 sentences, clean and
 * human — no headers, no bullet lists. Uses 🔴 = needs you · 🔵 = nothing needed, close it ·
 * 🥳/✅ = a win · 😊 = warmth. Nothing else.
 *
 * One cheap `claude -p` (haiku, lean) per gist, personaBlock() injected. Cached by (sessionId,
 * content-key) so an unchanged session costs zero model calls. Always degrades to a deterministic
 * fallback so the view never blanks. Every real generation is logged to chat_log (role 'gist').
 */
import { SessionState, TriageCategory, logChat } from "./db";
import { claudeJson } from "./claude";
import type { DatabaseSync } from "node:sqlite";

export interface GistInput {
  sessionId: number;
  title: string;
  state: SessionState;
  category?: TriageCategory | null;
  question?: string; // the ready question / final text
  conversation: string; // recent conversation tail, plain text
  lastPrompt?: string; // the operator's most recent request to this session (verbatim)
  model: string;
  maxBeats: number; // legacy knob; now used only to cap suggestions
}

export interface GistOutput {
  summary: string; // ONE friendly co-worker message: what's done + what's needed (≤ ~2 sentences)
  suggestions: string[]; // 2-4 one-tap replies the operator can send back, best-first
}

/** Text generator; injected in tests, defaults to the lean `claude -p`. */
export type Gen = (prompt: string) => Promise<string | null>;

function firstSentence(s: string, max = 200): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^.*?[.?!](\s|$)/);
  const out = (m ? m[0] : t).trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

/** Deterministic summary when the model is offline/rate-limited — honest, never invents progress. */
export function gistFallback(input: GistInput): GistOutput {
  const convo = (input.conversation || "").replace(/\s+/g, " ").trim();
  const looksJson = /"(type|role|sessionId|mode|timestamp|message|content)"\s*:/.test(convo.slice(-500)) || convo.trim().startsWith("{");
  const did = convo && !looksJson ? firstSentence(convo.slice(-400)) : "Claude's been working on this.";
  let need: string;
  if (input.state === "WAITING_INPUT") need = input.question ? "🔴 " + firstSentence(input.question) : "🔴 It needs a decision from you.";
  else if (input.state === "DONE") need = input.question ? "🔵 " + firstSentence(input.question) : "🔵 Looks done — nothing needed, you can close it.";
  else need = "🔵 Nothing needed right now.";
  const suggestions =
    input.state === "WAITING_INPUT" ? ["Yes, go ahead 😊", "Hold on — let me check first", "Do it your way"]
    : ["Looks good, thanks! 😊", "One more thing…", "Close it out"];
  return { summary: `${did} ${need}`.trim(), suggestions: suggestions.slice(0, Math.max(2, Math.min(4, input.maxBeats || 3))) };
}

/** Build the gist prompt — one friendly co-worker message + suggested replies. (Exported for tests.) */
export function buildGistPrompt(input: GistInput): string {
  let persona = "";
  try { persona = require("./soul").personaBlock() || ""; } catch {}
  const askBlock =
    input.lastPrompt && input.lastPrompt.trim()
      ? `\nThe operator's most recent request to this session:\n"""${input.lastPrompt.slice(0, 1200)}"""`
      : "";
  const stateLine =
    input.state === "DONE" ? "This session just FINISHED — say what it did, and that it's ready for a look (usually 🔵 nothing needed)."
    : input.state === "WAITING_INPUT" ? "This session is WAITING on the operator — end with 🔴 the ONE thing you need from him, phrased as his own words."
    : "Summarize where it stands.";
  return `You are ClaudeOS — the operator's friendly AI co-worker (like his "Jarvis"). Summarize this Claude Code session for him in HIS voice: warm, short, decisive, human, no corporate filler.
${persona}
${stateLine}

Write ONE short message (NOT a list, NOT separate lines, NO markdown/headers/bullets), at most 2 sentences:
1. What's been done here (one sentence).
2. What's needed from him — one sentence, specific — or that nothing is.
Emojis: use ONLY 🔴 (needs him) · 🔵 (nothing needed / close it) · 🥳 or ✅ (a win) · 😊 (warmth). Put the marker right before the "what's needed" part. Keep it clean and real.

Also give 2-4 SUGGESTED REPLIES he can click to respond — short, in his voice, exactly what he'd type back (best first). For a finished/idle session, suggest natural next things (e.g. "Looks good, thanks! 😊", a follow-up ask, or "Close it out").

Return JSON ONLY: {"summary":"<the one message>","suggestions":["<reply 1>","<reply 2>","<reply 3>"]}

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
  try { raw = await gen(prompt); } catch { raw = null; }
  if (!raw) return fallback;

  let parsed: { summary?: string; suggestions?: string[] } | null = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }

  const summary = parsed && typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "";
  let suggestions: string[] = [];
  if (parsed && Array.isArray(parsed.suggestions)) {
    suggestions = parsed.suggestions.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, 4);
  }
  if (!summary) return fallback;
  if (!suggestions.length) suggestions = fallback.suggestions;

  const out: GistOutput = { summary, suggestions };
  if (opts?.db) {
    let persona = "";
    try { persona = require("./soul").personaBlock() || ""; } catch {}
    logChat(opts.db, {
      scope: "task", role: "gist", sessionId: input.sessionId,
      content: JSON.stringify(out), prompt, personaSnapshot: persona || null, model: input.model,
    });
  }
  return out;
}

// --- cache (by sessionId → content key), so an unchanged session costs zero model calls. ---
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
