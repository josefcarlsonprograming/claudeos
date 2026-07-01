/**
 * Combined enrichment — ONE `claude -p` call per ready item.
 *
 * Replaces the old three-call fan-out (summarize=Sonnet + importance=Haiku + options).
 * A single Haiku call returns everything the operator-facing card needs:
 *   { one_liner, suggested_answer, options[], importance, importance_reason }
 * (plus diff_summary for REVIEW_DIFF). One cold CLI start instead of three, run from
 * a neutral cwd with MCP/project settings skipped (see claude.ts `lean`).
 *
 * Always degrades to deterministic fallbacks so the cockpit works offline / on failure.
 */
import { TriageCategory } from "./db";
import { claudeJson } from "./claude";

export interface EnrichInput {
  category: TriageCategory;
  title: string;
  questionText: string;
  lastPrompt: string; // the operator's most recent prompt to this session (verbatim, may be "")
  recentTranscript: string;
  diffStat?: string;
  diffPatch?: string;
  focus: string;
  changedLines: number;
  extraContextRequested?: boolean; // operator previously wanted more context here
  model: string; // cheap model (haiku) — this is one combined high-volume call
}

export interface EnrichOutput {
  one_liner: string;
  context: string | null; // 1-2 sentence RECAP of where the session stands (Claude's status; NOT the operator's ask)
  prompt_summary: string | null; // short "you asked …" summary when last_prompt is long; null => show it verbatim
  suggested_answer: string | null;
  diff_summary: string | null;
  options: string[] | null; // 2-4 distinct candidate answers (A/B/C/D)
  importance: number; // 0..100 (-1 if the judge failed)
  importance_reason: string;
}

function firstSentence(s: string, max = 140): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^.*?[.?!](\s|$)/);
  const out = (m ? m[0] : t).trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

export function enrichFallback(input: EnrichInput): EnrichOutput {
  return {
    one_liner: firstSentence(input.questionText || input.recentTranscript || "(no text)"),
    context: null,
    prompt_summary: null,
    suggested_answer: null,
    diff_summary: input.diffStat || null,
    options: null,
    importance: -1,
    importance_reason: "",
  };
}

// The RECAP shown on the Overview card, as a Goal/Next pair. The operator's own prompt is shown
// SEPARATELY (the "You asked" row), so context must NOT restate the request. Goal stays roughly
// stable across refreshes; Next is the ONE operator action for right now — re-derived on every
// enrichment so it always reflects the current state.
const CONTEXT_RULE = `context: exactly two short lines separated by a newline, no markdown. Line 1: "Goal: <the session's overall goal, a few words>". Line 2: "Next: <the ONE action the operator should take right now — e.g. review the diff, answer the question, pick an option, decide if it's done, look at the file/output and judge it>". Concrete and specific; do NOT restate the operator's request (shown separately).`;
// "You asked" summarizer: only when the operator's last prompt is long do we condense it; short
// prompts are shown verbatim, so return null for those.
const PROMPT_SUMMARY_RULE = `prompt_summary: if the operator's most recent request (below) is long (more than ~25 words), a single short sentence summarizing what they asked for, phrased starting with "you asked …"; otherwise null.`;

/** Build the single combined prompt, tailored to the category. (Exported for tests.) */
export function buildPrompt(input: EnrichInput): string {
  const { category } = input;
  const focusLine = input.focus
    ? `The operator's CURRENT FOCUS is "${input.focus}"; items matching it deserve more attention.`
    : `The operator has not set a current focus.`;
  const ctxLine = input.extraContextRequested
    ? "The operator previously wanted MORE context for this kind of item, so make one_liner 1-2 lines."
    : "Keep one_liner to a single line.";

  let learnedPrefs = "";
  try {
    const { readRanking } = require("./ranking");
    const md = readRanking();
    if (md && md.trim()) learnedPrefs = `\nThe operator's LEARNED ranking preferences (follow these qualitative rules):\n"""\n${md.slice(0, 1500)}\n"""`;
  } catch {}
  const importanceRules = `importance: integer 0 (ignore) to 100 (do immediately) — how much THIS deserves the operator's attention right now. Consider: is it blocking real progress? consequential vs trivial? quick to clear? just an FYI? does it match focus? A trivial yes/no is low; a consequential architectural decision or a broken/blocked task is high. ${focusLine}${learnedPrefs}
importance_reason: <=14 words on why.`;
  // The operator's most recent prompt — feeds both prompt_summary and the recap (so context can
  // describe Claude's RESPONSE to it without us re-echoing the request itself).
  const askBlock = input.lastPrompt && input.lastPrompt.trim()
    ? `\nThe operator's most recent request to this session:\n"""${input.lastPrompt.slice(0, 1500)}"""`
    : `\n(The operator's most recent request is not available — set prompt_summary to null.)`;

  if (category === "FYI_DONE") {
    return `A Claude Code session just FINISHED. ${ctxLine}
Return JSON with keys:
one_liner: <=14 words on what it accomplished.
${CONTEXT_RULE}
${PROMPT_SUMMARY_RULE}
suggested_answer: null
options: []
${importanceRules}
Session title: ${input.title}
Final output:
"""${input.questionText.slice(0, 3000)}"""${askBlock}`;
  }

  if (category === "REVIEW_DIFF") {
    return `A Claude Code session wants the operator to REVIEW a code change. ${ctxLine}
Return JSON with keys:
one_liner: a one-line gist of the change.
${CONTEXT_RULE}
${PROMPT_SUMMARY_RULE}
diff_summary: 2-4 short bullet lines of what changed and any risk.
suggested_answer: null
options: []
${importanceRules}
Session title: ${input.title}
Diff stat:
${input.diffStat || ""}
Patch (may be truncated):
"""${(input.diffPatch || "").slice(0, 8000)}"""${askBlock}`;
  }

  // SIMPLE_QUESTION or COMPLEX_DECISION
  // Persona block: the operator's SOUL (voice) + AGENT (role) + learned ANSWERING rules, so the
  // drafted options read as HE would type them, not as a generic assistant. Best-effort (require,
  // like readRanking above) so a missing soul layer never breaks enrichment.
  let persona = "";
  try { persona = require("./soul").personaBlock() || ""; } catch {}
  return `A Claude Code session is WAITING on its operator. ${ctxLine}
${persona}
Return JSON with keys:
one_liner: a single line of context so the operator understands the question without reading the transcript.
${CONTEXT_RULE}
${PROMPT_SUMMARY_RULE}
options: an array of 2-4 DISTINCT candidate answers, each phrased exactly as what the operator would type back to the session (in HIS voice above) — concrete and decisive, best-first. For a yes/no include both. For a multiple-choice decision, one per choice.
suggested_answer: the single best answer (equal to options[0]).
${importanceRules}
Session title: ${input.title}
Changed lines in worktree: ${input.changedLines}
Question / situation:
"""${input.questionText.slice(0, 4000)}"""
Recent transcript tail (for context):
"""${(input.recentTranscript || "").slice(-3000)}"""${askBlock}`;
}

/** ONE combined Haiku call. Returns enriched fields, falling back deterministically. */
export async function enrichItem(input: EnrichInput): Promise<EnrichOutput> {
  const fallback = enrichFallback(input);
  const j = await claudeJson<{
    one_liner?: string;
    context?: string | null;
    prompt_summary?: string | null;
    suggested_answer?: string | null;
    diff_summary?: string | null;
    options?: string[];
    importance?: number;
    importance_reason?: string;
  }>(buildPrompt(input), { model: input.model, timeoutMs: 60000, label: "enrich" });

  if (!j) return fallback;

  let options: string[] | null = null;
  if (Array.isArray(j.options)) {
    options = j.options.filter((o) => typeof o === "string" && o.trim()).slice(0, 4).map((o) => o.trim());
    if (!options.length) options = null;
  }
  const importance =
    typeof j.importance === "number" ? Math.max(0, Math.min(100, Math.round(j.importance))) : -1;

  const context = typeof j.context === "string" && j.context.trim() ? j.context.trim() : null;
  // Only keep a prompt_summary when the operator's prompt was actually long — short prompts are
  // shown verbatim on the card, so a summary there would be noise (or a fabrication).
  const promptIsLong = (input.lastPrompt || "").split(/\s+/).filter(Boolean).length > 25;
  const prompt_summary =
    promptIsLong && typeof j.prompt_summary === "string" && j.prompt_summary.trim()
      ? j.prompt_summary.trim()
      : null;
  return {
    one_liner: j.one_liner || fallback.one_liner,
    context,
    prompt_summary,
    suggested_answer:
      input.category === "FYI_DONE" || input.category === "REVIEW_DIFF"
        ? null
        : j.suggested_answer || (options ? options[0] : null),
    diff_summary:
      input.category === "REVIEW_DIFF" ? j.diff_summary || input.diffStat || null : null,
    options,
    importance,
    importance_reason: j.importance_reason || "",
  };
}
