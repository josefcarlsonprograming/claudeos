/**
 * Safe DEMO / SANDBOX mode. Lets the operator press EVERY button without anything
 * real happening: no auto-discovery, no GitHub scan, a throwaway DB wiped on startup,
 * and every mutating/external action is a no-op (terminal/PR are canned fakes).
 *
 * Enabled via COCKPIT_DEMO=1 (the server sets it up). The flag is threaded into
 * SessionManager (terminal/input no-ops) and Controller (PR no-ops) so the real code
 * paths are exercised end-to-end but never touch tmux or gh.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { SessionManager } from "./sessions";
import { gitEnv } from "./worktree";
import { upsertPr, setPinned, setManualImportance, upsertKanban, recordExample, bumpLearnedWeight } from "./db";
import { FullConfig } from "./config";

export function isDemo(): boolean {
  return process.env.COCKPIT_DEMO === "1";
}

/** A canned before/after PR diff (REVIEW_DIFF coloring renders +/- lines). */
export const FAKE_PR_DIFF = `diff --git a/src/server/analytics.ts b/src/server/analytics.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/server/analytics.ts
+++ b/src/server/analytics.ts
@@ -38,9 +38,16 @@ export async function getOverview(orgId: string) {
   const ch = clickhouse();
-  const rows = await ch.query(BIG_OVERVIEW_QUERY, { org: orgId });
-  return rows;
+  try {
+    const rows = await ch.query(BIG_OVERVIEW_QUERY, {
+      org: orgId,
+      max_memory_usage: OVERVIEW_MEM_GUARD,
+    });
+    return rows;
+  } catch (e) {
+    if (isClickhouseOOM(e)) return cachedOverview(orgId); // graceful fallback
+    throw e;
+  }
 }
diff --git a/src/server/alerts.ts b/src/server/alerts.ts
index aaaaaaa..bbbbbbb 100644
--- a/src/server/alerts.ts
+++ b/src/server/alerts.ts
@@ -12,6 +12,7 @@ export function fireAlarm(userId: string, kind: AlarmKind) {
-  notify(userId, kind);
+  if (dedupeAlarm(userId, kind)) return; // stop user-facing fire-alarm spam
+  notify(userId, kind);
 }`;

export const FAKE_PR_STATUS = {
  ok: true,
  reviewDecision: "REVIEW_REQUIRED",
  checks: "5✓ 0✗ 1…",
  state: "OPEN",
};

/** The canned fake Claude-Code terminal screen shown for a demo session. */
export function fakeTerminalScreen(title: string): string {
  return [
    "╭──────────────────────────────────────────────────────────────╮",
    "│  ✻ Claude Code  ·  (DEMO — not a real session)                │",
    "╰──────────────────────────────────────────────────────────────╯",
    "",
    `  task: ${title}`,
    "",
    "  ▸ Read  src/server/analytics.ts",
    "  ▸ Edit  src/server/analytics.ts  (+9 -2)",
    "  ▸ Bash  npm test   → 142 passing",
    "",
    "  I've guarded the ClickHouse overview query and de-duped the",
    "  fire-alarm notifications. Want me to open a PR?  (yes/no)",
    "",
    "> ",
  ].join("\n");
}

function writeTranscript(cwd: string, lines: { role: string; text?: string; stop_reason?: string; toolUse?: boolean }[], padBytes = 0): string {
  // IMPORTANT: write the demo transcript INSIDE the demo worktree, NOT in the real
  // ~/.claude/projects — otherwise the real cockpit's auto-discovery would pick up the
  // fake demo sessions. We register the session with this explicit transcript_path.
  const dir = cwd;
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [JSON.stringify({ type: "mode", timestamp: new Date(0).toISOString() })];
  for (const l of lines) {
    const content: any[] = [];
    if (l.toolUse) content.push({ type: "tool_use", id: "t1", name: "Bash", input: {} });
    else content.push({ type: "text", text: l.text || "" });
    out.push(
      JSON.stringify({
        type: l.role,
        cwd,
        message: { role: l.role, stop_reason: l.role === "assistant" ? l.stop_reason ?? "end_turn" : null, content },
      })
    );
  }
  // Optionally pad the transcript to a target byte size so the Overview's context-size bars
  // (≈ bytes ÷ 4 tokens) show a realistic red/amber/green spread in the demo. Filler turns are
  // inserted just AFTER the header and BEFORE the real turns, so the LAST turn (what state
  // detection reads) is untouched — a padded "running" session still reads as WORKING.
  if (padBytes > 0) {
    const filler = JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "x".repeat(2000) }] } });
    const fillers: string[] = [];
    let cur = Buffer.byteLength(out.join("\n") + "\n");
    while (cur < padBytes) { fillers.push(filler); cur += filler.length + 1; }
    out.splice(1, 0, ...fillers); // after the leading "mode" line, before the real turns
  }
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, out.join("\n") + "\n");
  const old = new Date(Date.now() - 60_000); // past quiet period
  fs.utimesSync(file, old, old);
  return file;
}

function gitRepoWithDiff(dir: string, changedLines: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv() });
  const f = path.join(dir, "file.txt");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    g(["init", "-q"]);
    g(["config", "user.email", "demo@demo"]);
    g(["config", "user.name", "demo"]);
    fs.writeFileSync(f, Array.from({ length: 5 }, (_, i) => `base${i}`).join("\n") + "\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "base"]);
  }
  fs.writeFileSync(f, Array.from({ length: 5 + changedLines }, (_, i) => `changed${i}`).join("\n") + "\n");
}

/** Build a REAL throwaway local git repo (main + a feature branch = the PR diff) so the
 *  demo PR has a genuine before/after diff and a genuine `git merge` — 100% local/sandbox,
 *  never touching GitHub or the operator's real repos. */
export function buildDemoPrRepo(): { path: string; head: string; base: string; commits: number } {
  const os = require("os");
  const dir = path.join(os.tmpdir(), `cockpit-demo-prrepo`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv() });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "demo@demo"]);
  g(["config", "user.name", "demo"]);
  fs.writeFileSync(path.join(dir, "sqs_consumer.py"), "def consume(msg):\n    process(msg)\n    ack(msg)\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# demo service\n\nA tiny sandbox service for the cockpit demo.\n");
  // a LONG file changed mid-file, so the diff view's expand-context arrows have real lines to reveal
  const guide = Array.from({ length: 60 }, (_, i) => `guide line ${i + 1}`);
  fs.writeFileSync(path.join(dir, "consumer_guide.md"), guide.join("\n") + "\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base: sqs consumer"]);
  g(["checkout", "-q", "-b", "feature/add-retry-sqs"]);
  guide[29] = "guide line 30 — the consumer now retries transient failures";
  fs.writeFileSync(path.join(dir, "consumer_guide.md"), guide.join("\n") + "\n");
  fs.writeFileSync(
    path.join(dir, "sqs_consumer.py"),
    "import time\n\n\ndef consume(msg, retries=3):\n    for attempt in range(retries):\n        try:\n            process(msg)\n            ack(msg)\n            return\n        except TransientError:\n            time.sleep(2 ** attempt)\n    dead_letter(msg)\n"
  );
  g(["add", "-A"]);
  g(["commit", "-qm", "feat: exponential-backoff retry so transient failures don't drop messages"]);
  fs.appendFileSync(path.join(dir, "README.md"), "\n## Retry\nThe SQS consumer now retries transient failures with exponential backoff.\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "docs: note retry behavior"]);
  g(["checkout", "-q", "main"]);
  return { path: dir, head: "feature/add-retry-sqs", base: "main", commits: 2 };
}

/** Reset the demo DB files so nothing persists across restarts. */
export function resetDemoDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {}
  }
}

/**
 * Seed a rich set of FAKE tasks covering every view + the never-surface rule.
 * Engine must be configured with { enrich:false, discover:false, pr:false }.
 */
export async function seedDemo(
  db: DatabaseSync,
  sm: SessionManager,
  engine: { tick: () => Promise<any>; rerank?: () => void },
  _cfg: FullConfig
): Promise<void> {
  const root = path.join(os.tmpdir(), "cockpit-demo-wts");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const reg = (
    title: string,
    branch: string,
    lines: { role: string; text?: string; stop_reason?: string; toolUse?: boolean }[],
    opts: { blocks?: boolean; deadline?: string | null; diffLines?: number; padBytes?: number; pid?: number } = {}
  ): number => {
    const wt = path.join(root, branch.replace(/[^a-z0-9]+/gi, "-"));
    if (opts.diffLines) gitRepoWithDiff(wt, opts.diffLines);
    else fs.mkdirSync(wt, { recursive: true });
    const tp = writeTranscript(wt, lines, opts.padBytes);
    const id = sm.register({ repo: "/demo/your-repo", title, worktreePath: wt, branch, blocksOtherWork: opts.blocks, deadline: opts.deadline, pid: opts.pid });
    db.prepare("UPDATE sessions SET transcript_path=? WHERE id=?").run(tp, id);
    return id;
  };

  // --- surfaced (ready) sessions: fresh, realistic tasks (one per view) ---
  const idSimple = reg("enable gzip on the public API responses", "demo/gzip", [
    { role: "assistant", text: "Benchmarks show gzip cuts average response size ~68% (940KB→300KB) at negligible CPU cost. Should I enable it for the public API? (yes/no)" },
  ], { padBytes: 1_360_000 }); // big transcript → RED ("abandon")
  const idComplex = reg("choose the duplicate-record merge strategy", "demo/dedupe", [
    {
      role: "assistant",
      text:
        "Found ~2.04M duplicate user records across the nightly import batches. How should I merge?\n" +
        "- Option A: keep latest updated_at (simple, but loses some hand-edited rows)\n" +
        "- Option B: edited-beats-recency (correct, ~1108 conflicts to resolve)\n" +
        "- Option C: keep both, tag duplicates for later\n" +
        "Which approach do you want me to take?",
    },
  ], { padBytes: 980_000 }); // big transcript → AMBER
  const idReview = reg(
    "fix the CSV importer crash on mixed delimiters",
    "demo/csv-importer",
    [{ role: "assistant", text: "The fix detects comma vs. semicolon per file so mixed-delimiter uploads stop crashing the importer. Ready for review — please review the diff before I open a PR." }],
    { diffLines: 22, padBytes: 700_000 } // mid transcript → AMBER
  );
  const idDone = reg("overnight test-suite run", "demo/nightly-tests", [
    { role: "assistant", text: "result: nightly test-suite finished — 1843 passed, 0 failed, coverage 87.4%; full report saved to the artifacts bucket." },
  ]);
  const idBlock = reg(
    "approve the prod deploy rollback",
    "demo/deploy-rollback",
    [{ role: "assistant", text: "needs input: prod is on the new release and the error rate is climbing. Roll back to the previous release now? (yes/no)" }],
    { blocks: true, deadline: new Date(Date.now() + 3 * 3.6e6).toISOString() }
  );

  // --- never-surface rule: these must stay HIDDEN ---
  // pid: a tool_use tail only reads WORKING while the process is ALIVE (dead = stalled, surfaced);
  // the seeder's own pid keeps this demo session genuinely "running".
  reg("full-table reindex (running)", "demo/reindex", [
    { role: "assistant", text: "Running the full-table reindex and watching the progress counter", stop_reason: "tool_use", toolUse: true },
  ], { padBytes: 1_280_000, pid: process.pid }); // big transcript → RED while still WORKING (bloated long-runner)
  reg("scratch notes", "demo/scratch", [{ role: "assistant", text: "Okay, noted." }]);

  // --- a fake GitHub PR (no gh call) — OBVIOUSLY synthetic data so the operator is
  //     never fooled into thinking the demo is touching a real repo/PR. Repo/author/
  //     number are fake and the URL is a non-routable example.invalid (never github.com). ---
  // backed by a REAL throwaway local git repo so the diff is genuine and X actually merges.
  let demoRepo: { path: string; head: string; base: string; commits: number } | null = null;
  try { demoRepo = buildDemoPrRepo(); } catch { demoRepo = null; }
  const prId = upsertPr(db, {
    repo: "demo/example-service",
    number: 1,
    title: '(demo) feat: add exponential-backoff retry to the SQS consumer',
    url: "https://example.invalid/demo/example-service/pull/1",
    author: "octocat",
    updatedAt: new Date(Date.now() - 2 * 3.6e6).toISOString(),
    reviewDecision: "REVIEW_REQUIRED",
    isDraft: false,
    additions: 9,
    deletions: 2,
    headRef: demoRepo ? demoRepo.head : "feature/add-retry-sqs",
    baseRef: demoRepo ? demoRepo.base : "main",
  });
  if (demoRepo) db.prepare("UPDATE sessions SET pr_local_repo=? WHERE id=?").run(demoRepo.path, prId);

  // --- fake KANBAN backfill cards (board scan is OFF in demo) ---
  const kStart = upsertKanban(db, {
    key: "kanban:4_today/#42-c2-add-retry-to-sqs-consumer.md",
    title: "add retry to sqs consumer",
    file: "/demo/kanban/4_today/#42-c2-add-retry-to-sqs-consumer.md",
    column: "4_today",
  });
  db.prepare("UPDATE sessions SET kanban_startable=1, kanban_questions='[]' WHERE id=?").run(kStart);
  const kNeed = upsertKanban(db, {
    key: "kanban:3_week/17-c3-improve-search-ranking.md",
    title: "improve search ranking",
    file: "/demo/kanban/3_week/17-c3-improve-search-ranking.md",
    column: "3_week",
  });
  db.prepare("UPDATE sessions SET kanban_startable=0, kanban_questions=? WHERE id=?").run(
    JSON.stringify([
      "Which relevance signals should the ranker weight most?",
      "Is there a labeled eval set, and where does it live?",
      "What's the current baseline metric to beat?",
    ]),
    kNeed
  );

  // generate items through the real pipeline (offline, no discovery/PR scan)
  await engine.tick();

  // enrich the demo items with canned content so every view is rich + exercisable.
  const setItem = (sessionId: number, fields: Record<string, any>) => {
    const keys = Object.keys(fields);
    const sql = `UPDATE items SET ${keys.map((k) => `${k}=?`).join(", ")}, updated_at=datetime('now') WHERE session_id=?`;
    db.prepare(sql).run(...keys.map((k) => fields[k]), sessionId);
  };
  // yes/no question -> Y / N hotkeys
  setItem(idSimple, {
    last_prompt: "shrink the public API responses — they're bottlenecked on payload size",
    context:
      "Profiled the API and found large JSON payloads dominate response time. It's proposing gzip compression to cut transfer size ~68% and wants your go-ahead before enabling it on the public API.",
    suggested_answer: "Yes, enable gzip compression",
    answer_options: JSON.stringify([
      { key: "y", label: "Yes", text: "Yes — enable gzip on the API responses; the size win is worth it." },
      { key: "n", label: "No", text: "No — keep responses uncompressed for now; revisit later." },
    ]),
    importance: 64,
    importance_reason: "speeds up the public API, low risk",
  });
  // multi-choice decision -> A / B / C / D hotkeys
  setItem(idComplex, {
    last_prompt: "de-duplicate the imported user records across the nightly batches",
    context:
      "Found ~1108 duplicate pairs where the two copies disagree, and it's unsure which copy should win. It's asking whether to keep the most recently updated row or let a hand-edited copy override recency.",
    importance: 78,
    importance_reason: "data-correctness choice, affects ~1108 conflicts",
    // suggested_answer === options[0] (as real enrichment always emits) so the card's ↵/★ marks A.
    suggested_answer: "Edited beats recency — resolve the ~1108 conflicts in favor of the hand-edited copy.",
    answer_options: JSON.stringify([
      { key: "a", label: "A", text: "Edited beats recency — resolve the ~1108 conflicts in favor of the hand-edited copy." },
      { key: "b", label: "B", text: "Keep the most recently updated row — simplest." },
      { key: "c", label: "C", text: "Keep both copies, tag the duplicates for later." },
      { key: "d", label: "D", text: "Edited-beats-recency, but auto-resolve where only one side is edited." },
    ]),
  });
  setItem(idReview, {
    last_prompt: "fix the CSV importer crash on uploads that mix comma and semicolon delimiters",
    context:
      "Reworked the CSV importer to sniff the delimiter per file and added a fixed-shape fast path for the common case. It's now asking you to review the diff before it opens the PR.",
    diff_summary:
      "+ detects comma vs. semicolon delimiter per file so mixed uploads don't crash\n+ adds a fast path for the common comma case\n- removes the hard-coded ',' split in csv_importer.ts:212\n~ 22 lines changed",
    importance: 58,
  });
  // the blocking item is a yes/no too -> Y / N
  setItem(idBlock, {
    // long prompt → exercises the LLM-summarized "you asked …" path (prompt_summary set)
    last_prompt:
      "keep an eye on prod after the release we shipped this morning — watch the error rate and queue depth on every box, and if you see the same hang pattern as last week where workers get stuck and stop processing, flag it to me immediately with whether we should roll back",
    prompt_summary: "you asked it to watch prod after the release and flag any error-rate/hang regression.",
    context:
      "The error rate is climbing and several boxes are stuck and never draining the queue — the same hang pattern as before. It wants approval to roll the prod deploy back to the previous release immediately.",
    importance: 88,
    importance_reason: "blocks prod, error rate climbing, deadline soon",
    suggested_answer: "Yes, roll back now",
    answer_options: JSON.stringify([
      { key: "y", label: "Yes", text: "Yes — roll prod back to the previous release now." },
      { key: "n", label: "No", text: "No — hold; investigate the errors first." },
    ]),
  });

  // feature 3 demo: a pinned task + a manual-importance override
  setManualImportance(db, idComplex, 90);
  setPinned(db, idBlock, true);

  // insert kanban items directly (engine kanban scan is off in demo)
  const kanbanItem = (sid: number, oneLiner: string, question: string, priority: number) => {
    db.prepare(
      `INSERT INTO items (session_id,state,category,category_source,question,one_liner,suggested_answer,diff_summary,changed_lines,importance,importance_reason,answer_options,priority,priority_explain,status,signature)
       VALUES (?, 'WAITING_INPUT','KANBAN','kanban',?,?,NULL,NULL,0,-1,NULL,NULL,?,?, 'pending', ?)
       ON CONFLICT(signature) DO NOTHING`
    ).run(sid, question, oneLiner, priority, JSON.stringify({ breakdown: [{ signal: "kanban_backfill", raw: 1, weight: priority, contribution: priority, note: "top-up from board" }], learned: [] }), `kanban-demo:${sid}`);
  };
  kanbanItem(kStart, "4_today · c2 · add retry to sqs consumer", "Add exponential-backoff retry to the SQS consumer so transient failures don't drop messages. AI-ready (#).", 27);
  kanbanItem(kNeed, "3_week · c3 · improve search ranking", "Improve the search ranking end-to-end. Needs clarification before starting.", 24);

  // --- learning-loop demo data: a couple of training examples + a learned weight delta so
  //     the Learning inspector shows real content (RANKING.md is read from the config dir). ---
  recordExample(db, "leapfrog",
    [{ id: 101, rank: 0, category: "REVIEW_DIFF", llm_importance: 70, focus_match: 0 }, { id: 102, rank: 2, category: "COMPLEX_DECISION", llm_importance: 40, focus_match: 1 }],
    { order: [101, 102] }, { picked: 102, skippedHigher: [101] });
  recordExample(db, "manual_importance",
    { id: 103, category: "SIMPLE_QUESTION", llm_importance: 35, focus_match: 1 },
    { llm_importance: 35 }, { manual_importance: 90 });
  recordExample(db, "snooze_high",
    { item: { id: 104, rank: 0, category: "REVIEW_DIFF", llm_importance: 65 }, queue: [] },
    { rank: 0 }, { shouldRankLower: true });
  try { bumpLearnedWeight(db, "focus_match", 1.2, 25); bumpLearnedWeight(db, "llm_importance", -0.8, 25); } catch {}

  // Re-rank the seeded items to apply the manual-importance / pin overrides set above. These are
  // already in Up Next (pending), so the heavy tick now SKIPS them under the Up-Next lock — the
  // operator-override re-rank goes through rerank() (the same path the live quick actions use).
  if (engine.rerank) engine.rerank();
  await engine.tick();
}
