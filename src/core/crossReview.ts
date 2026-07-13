/**
 * Cross-review: have Claude and Codex check each other's code. Given a session, we diff its branch
 * and send that diff to the OPPOSITE model for a second-opinion review — a Claude-authored change
 * is reviewed by Codex (`codex exec`), a Codex-authored change by Claude (`claude -p`). The review
 * comes back as markdown the operator reads in the cockpit (Ctrl+G V), so two models collaborate on
 * getting to the best result instead of one grading its own homework.
 *
 * The heavy dependencies (the two CLIs + the git diff) are injected so the logic is unit-testable
 * without either CLI installed (see src/test/harness.ts).
 */
import { branchVsBaseDiff, worktreeDiff } from "./diff";
import { claudePrompt } from "./claude";
import { codexExec } from "./codexCli";

export type Model = "claude" | "codex";

export interface CrossReviewResult {
  ok: boolean;
  reviewer: Model;   // who did the review
  author: Model;     // whose code was reviewed
  markdown: string;  // the review text (or an error message when ok=false)
  base: string;      // the base ref the diff was taken against ("" for a plain working-tree diff)
  changedLines: number;
  error?: string;
}

export interface CrossReviewDeps {
  claudeRun: (prompt: string) => Promise<string | null>;
  codexRun: (prompt: string) => Promise<string | null>;
  getDiff: (cwd: string, base: string) => Promise<{ patch: string; base: string; changedLines: number }>;
}

/** The reviewer is always the OTHER model from whoever authored the session. */
export function reviewerFor(sessionKind: string): { author: Model; reviewer: Model } {
  const author: Model = sessionKind === "codex" ? "codex" : "claude";
  const reviewer: Model = author === "claude" ? "codex" : "claude";
  return { author, reviewer };
}

/** Build the review prompt. Pure + exported so tests can assert on it. */
export function buildReviewPrompt(author: Model, reviewer: Model, diff: { patch: string; base: string }): string {
  const authorName = author === "claude" ? "Claude" : "Codex";
  const reviewerName = reviewer === "claude" ? "Claude" : "Codex";
  const against = diff.base ? `against \`${diff.base}\`` : "(uncommitted working-tree changes)";
  return (
    `You are ${reviewerName}, giving a second-opinion code review of a change written by ${authorName}. ` +
    `Be a rigorous but concise reviewer — you are the independent check that catches what the author missed.\n\n` +
    `Focus, in order:\n` +
    `1. Correctness bugs and edge cases that would actually break.\n` +
    `2. Security / data-loss / concurrency risks.\n` +
    `3. Missing or wrong tests.\n` +
    `4. Concrete, high-value simplifications (skip nitpicks).\n\n` +
    `Format: short markdown bullets grouped under those headings; cite \`file:line\` where you can. ` +
    `Lead with a one-line verdict (LGTM / minor / needs-work). If the change is genuinely clean, say so briefly — do not invent problems.\n\n` +
    `Here is the diff ${against}:\n\n\`\`\`diff\n${diff.patch}\n\`\`\`\n`
  );
}

export function defaultDeps(reviewModel?: string): CrossReviewDeps {
  return {
    claudeRun: (prompt) => claudePrompt(prompt, { model: reviewModel, timeoutMs: 180000, label: "cross-review", lean: true }),
    codexRun: (prompt) => codexExec(prompt, { model: undefined, timeoutMs: 180000, label: "cross-review" }),
    getDiff: async (cwd, base) => {
      const d = await branchVsBaseDiff(cwd, base || "main");
      if (d.patch && d.patch.trim()) return { patch: d.patch, base: d.base, changedLines: d.changedLines };
      // No branch/base diff (detached, or work is uncommitted vs HEAD) → fall back to working-tree diff.
      const w = await worktreeDiff(cwd);
      return { patch: w.patch, base: "", changedLines: w.changedLines };
    },
  };
}

const MAX_DIFF_CHARS = 200_000; // keep the prompt bounded; a huge diff is truncated with a note

/** Run a cross-review for a session. `session` needs { kind, worktree_path }. */
export async function runCrossReview(
  session: { kind: string; worktree_path: string | null },
  opts: { base?: string; deps?: CrossReviewDeps } = {}
): Promise<CrossReviewResult> {
  const { author, reviewer } = reviewerFor(session.kind);
  const deps = opts.deps || defaultDeps();
  const cwd = session.worktree_path || "";
  if (!cwd) return { ok: false, reviewer, author, markdown: "", base: "", changedLines: 0, error: "session has no working directory" };

  let diff: { patch: string; base: string; changedLines: number };
  try { diff = await deps.getDiff(cwd, opts.base || "main"); }
  catch (e: any) { return { ok: false, reviewer, author, markdown: "", base: "", changedLines: 0, error: `diff failed: ${String(e?.message || e).slice(0, 120)}` }; }

  if (!diff.patch || !diff.patch.trim())
    return { ok: false, reviewer, author, markdown: "", base: diff.base, changedLines: 0, error: "no changes to review (empty diff)" };

  let patch = diff.patch;
  if (patch.length > MAX_DIFF_CHARS) patch = patch.slice(0, MAX_DIFF_CHARS) + "\n\n… [diff truncated for review]";

  const prompt = buildReviewPrompt(author, reviewer, { patch, base: diff.base });
  const run = reviewer === "claude" ? deps.claudeRun : deps.codexRun;
  let text: string | null = null;
  try { text = await run(prompt); } catch { text = null; }

  if (!text || !text.trim()) {
    const who = reviewer === "claude" ? "Claude (claude -p)" : "Codex (codex exec)";
    return { ok: false, reviewer, author, markdown: "", base: diff.base, changedLines: diff.changedLines, error: `${who} returned no review (CLI missing, auth, or timeout)` };
  }
  return { ok: true, reviewer, author, markdown: text.trim(), base: diff.base, changedLines: diff.changedLines };
}
