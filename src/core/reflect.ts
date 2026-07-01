/**
 * reflect.ts — the nightly conversation-review loop.
 *
 * ClaudeOS's dream tunes RANKING (which task first). reflect reviews the day's CONVERSATIONS —
 * the answer exchanges the cockpit mediated: for each session it drafted "ABC" candidate answers,
 * and the operator accepted / picked another / edited / rewrote one. That IS "how the operator does
 * his ABC questions", already captured in answer_feedback (see answerLog.ts). reflect:
 *
 *   1. EVOLVE config/ANSWERING.md — distill the day's edits into concise rules the ABC drafter
 *      follows (mirrors ranking.ts evolveRankingMd exactly: current file + revealed edits → rules).
 *   2. AUTO-WRITE SKILLS — where the operator's answer for a category is near-deterministic
 *      (he almost always accepts option A), draft a reviewable skill under skills/ so that answer
 *      can be automated. Guarded by sample-count + consistency thresholds so it can't spam.
 *   3. TRAJECTORY SCORE — score 0-100 whether the cockpit is getting BETTER at this over time
 *      (acceptance up, edit-distance down, rewrites down), into reflect_scores + dream_log.
 *
 * Auto-apply + log everything, git-reversible (commitAndPush), exactly like RANKING.md. Fully
 * interpretable: every change is a readable dream_log line and a git commit.
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";
import { readAnswering, writeAnswering, answeringPath } from "./soul";
import { commitAndPush, repoRoot } from "./ranking";
import { answerStats, AnswerRow } from "./answerLog";
import { claudePrompt } from "./claude";

/** Text generator; injected in tests, defaults to the lean `claude -p`. */
export type Gen = (prompt: string) => Promise<string | null>;

const EVOLVE_WINDOW_DAYS = 1; // "the day's conversations"
const SKILL_WINDOW_DAYS = 14; // wider window so an automatable pattern has enough samples
const SKILL_MIN_SAMPLES = 4; // need at least this many non-empty answers in a category
const SKILL_MIN_CONSISTENCY = 0.75; // and this accept-rate of option A before we automate it
const MAX_SKILLS_PER_RUN = 3; // never write more than this many skills in one nightly pass

const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();

function windowRows(db: DatabaseSync, days: number): AnswerRow[] {
  return db
    .prepare(`SELECT * FROM answer_feedback WHERE created_at >= datetime('now', ?) ORDER BY id DESC`)
    .all(`-${Math.max(1, days)} days`) as unknown as AnswerRow[];
}

function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "skill";
}

/**
 * Evolve config/ANSWERING.md from the day's answer exchanges. Mirrors evolveRankingMd: current file
 * + revealed edits → ≤~12 rules, preserve good rules, never blind-rewrite. Returns {changed}.
 */
export async function evolveAnsweringMd(db: DatabaseSync, gen: Gen): Promise<{ changed: boolean; text: string }> {
  const rows = windowRows(db, EVOLVE_WINDOW_DAYS).filter((r) => r.outcome !== "empty");
  if (!rows.length) return { changed: false, text: readAnswering() };
  const cur = readAnswering();
  const examples = rows
    .slice(0, 40)
    .map((r) => {
      const cat = r.category || "(none)";
      if (r.outcome === "accepted") return `- [${cat}] ACCEPTED option A verbatim: "${norm(r.suggested).slice(0, 140)}"`;
      if (r.outcome === "option_picked") return `- [${cat}] PICKED option ${String.fromCharCode(65 + Math.max(0, r.chosen_index))} instead of A — sent: "${norm(r.final).slice(0, 140)}" (A was: "${norm(r.suggested).slice(0, 100)}")`;
      if (r.outcome === "edited") return `- [${cat}] EDITED A → "${norm(r.final).slice(0, 140)}" (A was: "${norm(r.suggested).slice(0, 100)}")`;
      return `- [${cat}] REWROTE (threw A away) → "${norm(r.final).slice(0, 160)}" (A was: "${norm(r.suggested).slice(0, 100)}")`;
    })
    .join("\n");
  const prompt = `You maintain a SHORT markdown file of LEARNED ANSWERING RULES for a cockpit that drafts 2-4 candidate answers ("ABC" options) the operator sends back to his ~20 Claude Code sessions. The rules teach the drafter how the operator ACTUALLY answers, so option A gets accepted unedited more often.

CURRENT file:
"""
${cur}
"""

Today's revealed answers (what the cockpit suggested vs what the operator actually sent):
${examples}

EVOLVE the file: keep it concise (<= ~12 bullet rules). Capture durable patterns — e.g. "for SIMPLE_QUESTION yes/no he answers in one short line and says yes unless there's risk", "he strips hedging and pleasantries from option A", "for REVIEW_DIFF he asks for the risk, not a summary", "prefers Swedish warmth for Swedish threads". PRESERVE good existing rules — do NOT rewrite wholesale or invent rules the examples don't support. Output the FULL updated markdown file and nothing else.`;
  const out = await gen(prompt);
  if (!out || out.trim().length < 20) return { changed: false, text: cur };
  const text = out.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  if (text === cur) return { changed: false, text: cur };
  writeAnswering(text);
  return { changed: true, text };
}

export interface SkillCandidate {
  category: string;
  samples: number;
  acceptRate: number; // accept-rate of option A (accepted verbatim / non-empty)
  example: string; // a representative accepted answer
}

/** Deterministic detection of automatable patterns (pure DB stats — the LLM only writes the body). */
export function detectSkillCandidates(db: DatabaseSync): SkillCandidate[] {
  const rows = windowRows(db, SKILL_WINDOW_DAYS).filter((r) => r.outcome !== "empty");
  const byCat: Record<string, { n: number; acceptedA: number; example: string }> = {};
  for (const r of rows) {
    const cat = r.category || "(none)";
    const b = (byCat[cat] ||= { n: 0, acceptedA: 0, example: "" });
    b.n++;
    if (r.outcome === "accepted") {
      b.acceptedA++;
      if (!b.example) b.example = norm(r.suggested).slice(0, 200);
    }
  }
  const out: SkillCandidate[] = [];
  for (const [category, b] of Object.entries(byCat)) {
    if (b.n < SKILL_MIN_SAMPLES) continue;
    const acceptRate = b.acceptedA / b.n;
    if (acceptRate < SKILL_MIN_CONSISTENCY) continue;
    out.push({ category, samples: b.n, acceptRate: Number(acceptRate.toFixed(3)), example: b.example });
  }
  // Strongest patterns first; bound how many we write per run.
  return out.sort((a, b) => b.acceptRate - a.acceptRate || b.samples - a.samples).slice(0, MAX_SKILLS_PER_RUN);
}

export function skillsDir(): string {
  return path.join(repoRoot(), "skills");
}

/**
 * For each automatable pattern, draft a reviewable skill markdown (once — never clobber an existing
 * one). Returns the repo-relative paths written. The LLM writes the body; the decision to write is
 * the deterministic detectSkillCandidates() above.
 */
export async function writeSkills(db: DatabaseSync, gen: Gen): Promise<string[]> {
  const candidates = detectSkillCandidates(db);
  const written: string[] = [];
  const dir = skillsDir();
  for (const c of candidates) {
    const rel = `skills/answer-${slug(c.category)}.md`;
    const abs = path.join(dir, path.basename(rel));
    if (fs.existsSync(abs)) continue; // don't churn a skill that already exists
    const prompt = `Write a SKILL: a short markdown file that captures an AUTOMATABLE answering pattern for a cockpit operating ~20 Claude Code sessions.

Evidence: for category ${c.category}, over the last ${SKILL_WINDOW_DAYS} days the operator ACCEPTED the cockpit's option-A answer verbatim ${Math.round(c.acceptRate * 100)}% of the time across ${c.samples} answers. A representative accepted answer was: "${c.example}".

Output ONLY the markdown, structured as:
# Skill: answer <category> questions like the operator
## When this applies
<one or two lines: the kind of question this covers>
## The operator's canonical answer
<the pattern of what he sends, in his voice — short, concrete>
## Automation
<one line: how the drafter should use this — make option A this, and note it's a strong auto-accept candidate>
## Evidence
- ${c.samples} samples, ${Math.round(c.acceptRate * 100)}% accepted verbatim (auto-generated ${SKILL_WINDOW_DAYS}d window)`;
    const body = await gen(prompt);
    if (!body || body.trim().length < 20) continue;
    const text = body.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(abs, text + "\n");
      written.push(rel);
    } catch {}
  }
  return written;
}

/** Score whether the cockpit is getting better at drafting the operator's answers. */
export async function scoreTrajectory(db: DatabaseSync, gen: Gen): Promise<{ score: number | null; rationale: string; stats: any }> {
  const stats = { day: answerStats(db, 1), week: answerStats(db, 7) };
  if (!stats.week.total) return { score: null, rationale: "no answer feedback yet", stats };
  const prompt = `You score a loop that drafts candidate answers ("ABC" options) for an operator's Claude Code sessions and learns from how he actually answers. Higher = the loop is WORKING: acceptance rate rising, edits smaller (mean similarity high), fewer rewrites, weak categories improving. Lower = he keeps rewriting the suggestions.

Stats (day vs week):
${JSON.stringify(stats, null, 2)}

Output ONLY JSON: {"score": <0-100 integer>, "rationale": "<one or two sentences>"}`;
  const raw = await gen(prompt);
  if (!raw) return { score: null, rationale: "", stats };
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { score: null, rationale: "", stats };
  try {
    const parsed = JSON.parse(m[0]);
    const score = Number.isFinite(Number(parsed.score)) ? Math.max(0, Math.min(100, Math.round(Number(parsed.score)))) : null;
    return { score, rationale: String(parsed.rationale || "").slice(0, 500), stats };
  } catch {
    return { score: null, rationale: "", stats };
  }
}

export interface ReflectResult {
  summary: string;
  answeringChanged: boolean;
  skills: string[];
  score: number | null;
}

/**
 * The full nightly conversation-review. Best-effort throughout: any sub-step failing logs a note but
 * never throws (the dream keeps going). `opts.gen` is injected in tests; production uses `claude -p`.
 */
export async function runReflect(
  db: DatabaseSync,
  opts?: { gen?: Gen; model?: string; commit?: boolean; git?: any }
): Promise<ReflectResult> {
  const model = opts?.model || "haiku";
  const gen: Gen = opts?.gen || ((p: string) => claudePrompt(p, { model, timeoutMs: 60000, label: "reflect" }));

  // 1. Evolve ANSWERING.md.
  let answeringChanged = false;
  try {
    const r = await evolveAnsweringMd(db, gen);
    answeringChanged = r.changed;
  } catch { /* best-effort */ }

  // 2. Auto-write skills for automatable patterns.
  let skills: string[] = [];
  try {
    skills = await writeSkills(db, gen);
  } catch { /* best-effort */ }

  // 3. Trajectory score.
  let score: number | null = null;
  let rationale = "";
  try {
    const s = await scoreTrajectory(db, gen);
    score = s.score;
    rationale = s.rationale;
    if (score !== null) {
      db.prepare(
        `INSERT INTO reflect_scores (run_date, score, window_stats_json, rationale)
         VALUES (date('now'), ?, ?, ?)
         ON CONFLICT(run_date) DO UPDATE SET score=excluded.score,
           window_stats_json=excluded.window_stats_json, rationale=excluded.rationale`
      ).run(score, JSON.stringify(s.stats), rationale);
    }
  } catch { /* best-effort */ }

  const parts = [
    `reflect: score ${score ?? "n/a"}`,
    answeringChanged ? "ANSWERING.md evolved" : "ANSWERING.md unchanged",
    skills.length ? `wrote ${skills.length} skill(s): ${skills.map((s) => path.basename(s)).join(", ")}` : "no new skills",
  ];
  if (rationale) parts.push(rationale);
  const summary = parts.join(" · ");
  try { db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run(summary); } catch {}

  // 4. Commit the evolved rules + any new skills (auto-apply, git-reversible).
  if (opts?.commit !== false && (answeringChanged || skills.length)) {
    try {
      const rel = path.relative(repoRoot(), answeringPath()) || "config/ANSWERING.md";
      const paths = [answeringChanged ? rel : "", ...skills].filter(Boolean);
      const g = commitAndPush(paths, "reflect: evolve ANSWERING.md + skills from answer log [auto]", { git: opts?.git });
      if (g.committed) db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run("git: " + g.note);
    } catch { /* never let git break the dream */ }
  }

  return { summary, answeringChanged, skills, score };
}
