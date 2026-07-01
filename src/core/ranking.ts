/**
 * RANKING.md — the human-readable, operator-owned layer of the learning loop.
 *
 * The nightly dream evolves a short markdown file of LEARNED ranking preferences from the
 * recent {state → predicted → correct} training examples (a lean `claude -p` call), and the
 * importance judge injects it into its prompt so the operator's qualitative taste applies at
 * scoring time. It lives in the config dir so the operator can read/edit it directly.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { configDir } from "./config";
import { claudePrompt } from "./claude";

export const DEFAULT_RANKING = `# Operator ranking preferences (learned)

These are concise, human-readable rules the cockpit has learned from how the operator
actually triages tasks. The nightly dream evolves them; the importance judge follows them.

- (no learned preferences yet — they appear here as the operator triages)
`;

export function rankingPath(): string {
  return path.join(configDir(), "RANKING.md");
}

export function readRanking(): string {
  try {
    const t = fs.readFileSync(rankingPath(), "utf8");
    return t && t.trim() ? t : DEFAULT_RANKING;
  } catch {
    return DEFAULT_RANKING;
  }
}

export function writeRanking(text: string): void {
  try {
    fs.mkdirSync(path.dirname(rankingPath()), { recursive: true });
    fs.writeFileSync(rankingPath(), text);
  } catch {}
}

/**
 * Evolve RANKING.md from recent training examples. `gen` is the text generator (defaults to
 * the lean `claude -p`); tests inject a stub. Returns {changed, text}. Never rewrites
 * wholesale — the model is told to preserve good existing rules.
 */
export async function evolveRankingMd(
  db: any,
  model: string,
  gen?: (prompt: string) => Promise<string | null>
): Promise<{ changed: boolean; text: string }> {
  const { recentExamples } = require("./db");
  const ex = recentExamples(db, 30) as any[];
  if (!ex.length) return { changed: false, text: readRanking() };
  const cur = readRanking();
  const examplesText = ex
    .map((e) => e.kind === "explicit_reason" && e.reason
      // FIX BB: the operator's EXPLICIT reasoned feedback is the strongest qualitative signal — give
      // the model the direction + their own words so the rule it writes reflects WHY.
      ? `- explicit_reason (operator pushed this task ${e.state && e.state.direction === "up" ? "UP — too low" : "DOWN — too high"}, category=${e.state && e.state.category}): "${String(e.reason).slice(0, 200)}"`
      : `- ${e.kind}: predicted=${JSON.stringify(e.predicted).slice(0, 180)} correct=${JSON.stringify(e.correct).slice(0, 180)}`)
    .join("\n");
  const prompt = `You maintain a SHORT markdown file of an operator's LEARNED TASK-RANKING PREFERENCES for a cockpit that ranks ~20 Claude Code sessions by how much they need the operator now.

CURRENT file:
"""
${cur}
"""

Recent revealed preferences (what the model predicted vs what the operator actually did):
${examplesText}

EVOLVE the file: keep it concise (<= ~12 bullet rules), refine or append rules that capture these revealed preferences (e.g. "prioritizes prod-reliability over cleanup", "defers long code reviews early in the day", "values focus-matched tasks above raw importance"). PRESERVE good existing rules — do NOT rewrite wholesale or invent preferences not supported by the examples. Output the FULL updated markdown file and nothing else.`;
  const generate = gen || ((p: string) => claudePrompt(p, { model, timeoutMs: 60000, label: "dream" }));
  const out = await generate(prompt);
  if (!out || out.trim().length < 20) return { changed: false, text: cur };
  // strip a wrapping ```markdown fence if the model added one
  const text = out.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  writeRanking(text);
  return { changed: true, text };
}

export type GitRunner = (args: string[], cwd: string) => string;
const defaultGit: GitRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The repo root for a config-relative pathspec (<repo>/config → <repo>). */
export function repoRoot(): string {
  return path.dirname(configDir());
}

/**
 * Auto-commit (and push) a SCOPED set of files after a nightly loop evolves them, so the operator
 * NEVER has to push the learning by hand. Staging is limited to the explicit `relPaths` pathspec —
 * it never stages or commits unrelated working-tree changes. Best-effort: a non-git dir (e.g. the
 * temp config dir used in tests), a red pre-push gate, or no network just returns a note; it never
 * throws into the dream. Push lands directly on the current branch (master) — this repo is
 * pre-authorized for direct master pushes of docs-like files (see CLAUDE.md).
 *
 * `relPaths` are repo-root-relative (e.g. "config/RANKING.md", "skills/answer-x.md").
 */
export function commitAndPush(
  relPaths: string[],
  message: string,
  opts?: { push?: boolean; git?: GitRunner; root?: string }
): { committed: boolean; pushed: boolean; note: string } {
  const git = opts?.git || defaultGit;
  const push = opts?.push !== false;
  const root = opts?.root || repoRoot();
  const rels = relPaths.map((p) => p.replace(/^\/+/, "")).filter(Boolean);
  if (!rels.length) return { committed: false, pushed: false, note: "no paths — nothing to commit" };
  try {
    git(["rev-parse", "--is-inside-work-tree"], root);
  } catch {
    return { committed: false, pushed: false, note: "not a git work tree — skipped" };
  }
  let dirty = false;
  try {
    dirty = git(["status", "--porcelain", "--", ...rels], root).trim().length > 0;
  } catch {
    return { committed: false, pushed: false, note: "git status failed — skipped" };
  }
  if (!dirty) return { committed: false, pushed: false, note: "unchanged — nothing to commit" };
  try {
    git(["add", "--", ...rels], root);
    git(["commit", "-m", message, "--", ...rels], root);
  } catch (e: any) {
    return { committed: false, pushed: false, note: "commit failed: " + String(e?.message || e).slice(0, 140) };
  }
  if (!push) return { committed: true, pushed: false, note: "committed (push disabled)" };
  try {
    git(["push"], root);
    return { committed: true, pushed: true, note: "committed + pushed " + rels.join(", ") };
  } catch (e: any) {
    return { committed: true, pushed: false, note: "committed; push failed (retries next run): " + String(e?.message || e).slice(0, 140) };
  }
}

/** Thin wrapper: commit+push ONLY config/RANKING.md after the dream evolves it. */
export function commitAndPushRankingMd(opts?: { push?: boolean; git?: GitRunner }): {
  committed: boolean;
  pushed: boolean;
  note: string;
} {
  const rel = path.relative(repoRoot(), rankingPath()) || "config/RANKING.md";
  const r = commitAndPush([rel], "dream: evolve RANKING.md from operator triage [auto]", opts);
  // Preserve the original, RANKING-specific note wording for existing callers/logs.
  if (r.committed && r.pushed) return { ...r, note: "committed + pushed RANKING.md" };
  if (!r.committed && r.note.startsWith("unchanged")) return { ...r, note: "RANKING.md unchanged — nothing to commit" };
  return r;
}
