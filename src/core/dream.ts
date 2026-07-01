/**
 * The nightly "dream". While the operator sleeps, re-tune the ranking from the whole
 * decision history so tomorrow's ordering is better. It reads decision_log, computes a
 * net sentiment per category, and folds it into the per-category learned nudges that
 * the priority engine already applies — now including the SNOOZE signal (snoozing an
 * item means it was over-ranked).
 *
 * Fully interpretable: it writes a human-readable summary of every change to dream_log,
 * and only ever moves the existing transparent nudges. No black box.
 */
import { DatabaseSync } from "node:sqlite";

const STEP = 3; // points moved per net-unit of sentiment, bounded by feedback.bump clamp
const CLAMP = 40;

export interface DreamResult {
  summary: string;
  changes: { key: string; delta: number; net: number; counts: Record<string, number> }[];
  weightChanges?: { key: string; step: number; delta: number; from: string }[];
}

export function dream(db: DatabaseSync): DreamResult {
  // Aggregate feedback per category.
  const rows = db
    .prepare(
      `SELECT category, feedback, COUNT(*) AS n FROM decision_log
       WHERE category IS NOT NULL GROUP BY category, feedback`
    )
    .all() as unknown as { category: string; feedback: string; n: number }[];

  const byCat: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    byCat[r.category] = byCat[r.category] || {};
    byCat[r.category][r.feedback] = r.n;
  }

  const changes: DreamResult["changes"] = [];
  for (const [cat, counts] of Object.entries(byCat)) {
    // Implicit skip-learning (small nudges): picking a lower-ranked task means its
    // category was under-ranked (UP); being leapfrogged-over means over-ranked (DOWN).
    const up = (counts["priority_low"] || 0) + (counts["good"] || 0) + (counts["decided"] || 0) * 0.5 + (counts["leapfrogged_pick"] || 0) * 0.5;
    const down = (counts["priority_high"] || 0) + (counts["wrong"] || 0) + (counts["snoozed"] || 0) + (counts["leapfrogged_over"] || 0) * 0.5;
    const net = up - down;
    if (net === 0) continue;
    const key = `category:${cat}`;
    const delta = Math.max(-STEP * 3, Math.min(STEP * 3, Math.round(Math.sign(net) * Math.min(Math.abs(net), 3) * STEP)));
    db.prepare(
      `INSERT INTO signal_adjustments (key, adjustment, up_count, down_count)
       VALUES (?, ?, 0, 0)
       ON CONFLICT(key) DO UPDATE SET
         adjustment = MAX(-${CLAMP}, MIN(${CLAMP}, adjustment + ?)),
         updated_at = datetime('now')`
    ).run(key, Math.max(-CLAMP, Math.min(CLAMP, delta)), delta);
    changes.push({ key, delta, net, counts });
  }

  // ---- Stage B: small-LR numeric tuning of the ranking weight vector from the
  // captured training examples (perceptron-style pairwise ranking gradient). ----
  const weightChanges = tuneWeightsFromExamples(db);

  const parts: string[] = [];
  if (changes.length) parts.push(changes.map((c) => `${c.key} ${c.delta > 0 ? "+" : ""}${c.delta} (net ${c.net})`).join("; "));
  if (weightChanges.length) parts.push("weights: " + weightChanges.map((w) => `${w.key} ${w.step > 0 ? "+" : ""}${w.step}→${w.delta}`).join(", "));
  const summary = parts.length ? parts.join(" · ") : "no feedback signal yet — nothing to tune";
  db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run(summary);
  return { summary, changes, weightChanges } as DreamResult & { weightChanges: WeightChange[] };
}

export interface WeightChange { key: string; step: number; delta: number; from: string }

/** Normalize a captured feature row into the [0,1] signal vector the weights act on. */
function featVec(f: any): Record<string, number> {
  if (!f) return {};
  return {
    llm_importance: typeof f.llm_importance === "number" && f.llm_importance >= 0 ? f.llm_importance / 100 : 0,
    blocks_other_work: f.blocks_other_work ? 1 : 0,
    effort_small: f.effort_small || 0,
    staleness: f.staleness || 0,
    focus_match: f.focus_match || 0,
    deadline: f.deadline || 0,
  };
}
const WEIGHT_KEYS = ["llm_importance", "blocks_other_work", "effort_small", "staleness", "focus_match", "deadline"];

/** Perceptron/HINGE learning-to-rank over the unapplied training examples. Each pair says
 *  "the CORRECT item should outrank the one the model put above it"; we only update VIOLATED
 *  pairs (predicted score_skipped >= score_picked), step the SHARED weight vector by
 *  lr·(features_picked − features_skipped), and clamp the cumulative learned delta per weight
 *  to ±50% of its base so it can shift ranking but never run away or flip a sign. The
 *  manual-importance override is handled as a per-CATEGORY importance bias (signal_adjustments),
 *  not the weight vector. Every move is logged to dream_log; examples are marked applied. */
export function tuneWeightsFromExamples(db: DatabaseSync): WeightChange[] {
  const { unappliedExamples, markExamplesApplied, bumpLearnedWeight, getLearnedWeights } = require("./db");
  let lr = 0.05, baseW: any = {};
  let implicitW = 0.1; // SILENT signals (leapfrog pick / snooze) are VERY low signal; a typed reason teaches a LOT
  try { const c = require("./config").loadConfig(); lr = c.learning_rate ?? 0.05; baseW = c.weights || {}; implicitW = c.implicit_learn_weight ?? 0.1; } catch {}
  const examples = unappliedExamples(db, 500) as any[];
  if (!examples.length) return [];

  // current effective weights (base + learned) — used to score pairs for the hinge guard.
  const learned0 = getLearnedWeights(db);
  const eff: Record<string, number> = {};
  for (const k of WEIGHT_KEYS) eff[k] = (baseW[k] || 0) + (learned0[k] || 0);
  const score = (f: Record<string, number>) => WEIGHT_KEYS.reduce((s, k) => s + eff[k] * (f[k] || 0), 0);

  const grad: Record<string, number> = {};
  const drivers: Record<string, Set<string>> = {}; // weight -> kinds that drove it
  const add = (k: string, v: number, kind: string) => { grad[k] = (grad[k] || 0) + v; (drivers[k] = drivers[k] || new Set()).add(kind); };
  let violated = 0, skipped = 0;

  // manual-importance → per-category importance-bias accumulator
  const catBias: Record<string, { sum: number; n: number }> = {};

  for (const ex of examples) {
    if (ex.kind === "leapfrog" && Array.isArray(ex.state) && ex.correct) {
      const byId = new Map(ex.state.map((s: any) => [s.id, s]));
      const picked = byId.get(ex.correct.picked);
      if (!picked) continue;
      const pf = featVec(picked), ps = score(pf);
      for (const hid of ex.correct.skippedHigher || []) {
        const h = byId.get(hid); if (!h) continue;
        const hf = featVec(h);
        if (score(hf) < ps) { skipped++; continue; }   // pair already correct → hinge: no update
        violated++;
        for (const k of WEIGHT_KEYS) add(k, implicitW * lr * ((pf[k] || 0) - (hf[k] || 0)), "leapfrog");
      }
    } else if (ex.kind === "snooze_high" && ex.state && ex.state.item) {
      const itf = featVec(ex.state.item), is = score(itf);
      const rest = (ex.state.queue || []).filter((x: any) => x.id !== ex.state.item.id).map((x: any) => featVec(x));
      const viol = rest.filter((rf: any) => score(rf) <= is); // others currently ranked at/below it
      if (!viol.length) { skipped++; continue; }
      violated++;
      for (const k of WEIGHT_KEYS) {
        const avg = viol.reduce((a: number, rf: any) => a + (rf[k] || 0), 0) / viol.length;
        add(k, -implicitW * lr * ((itf[k] || 0) - avg), "snooze_high"); // silent snooze teaches only a little
      }
    } else if (ex.kind === "explicit_reason" && ex.state && ex.state.features) {
      // FIX BB: the operator EXPLICITLY said this item was ranked too high/low (+ why). Step the
      // weights of the features that drive its score in that direction, scaled by the example's
      // HIGH weight (so reasoned feedback moves more than an implicit leapfrog/snooze).
      const f = featVec(ex.state.features);
      const dir = ex.state.direction === "up" ? 1 : -1;
      const mult = ex.weight || 3;
      violated++;
      for (const k of WEIGHT_KEYS) add(k, dir * lr * mult * (f[k] || 0), "explicit_reason");
    } else if (ex.kind === "manual_importance" && ex.state) {
      const cat = ex.state.category;
      const pred = (ex.predicted && ex.predicted.llm_importance) || 0;
      const corr = (ex.correct && ex.correct.manual_importance) || 0;
      if (cat) { const b = (catBias[cat] = catBias[cat] || { sum: 0, n: 0 }); b.sum += (corr - pred) / 100; b.n++; }
    }
    // triage_wrong feeds the qualitative RANKING.md (Stage C).
  }

  const out: WeightChange[] = [];
  for (const k of WEIGHT_KEYS) {
    if (!grad[k]) continue;
    const step = Math.max(-2, Math.min(2, +grad[k].toFixed(3))); // bound the per-run step
    if (Math.abs(step) < 1e-3) continue;
    const cap = Math.max(2, Math.abs(baseW[k] || 0) * 0.5); // cumulative delta ≤ 50% of base
    const delta = bumpLearnedWeight(db, k, step, +cap.toFixed(2));
    out.push({ key: k, step, delta: +delta.toFixed(3), from: [...(drivers[k] || [])].join("+") });
  }

  // manual_importance → per-category importance bias (augments signal_adjustments, NOT weights).
  for (const [cat, b] of Object.entries(catBias)) {
    if (!b.n) continue;
    const nudge = Math.max(-3, Math.min(3, +(lr * 20 * (b.sum / b.n)).toFixed(2))); // LR-scaled, bounded
    if (Math.abs(nudge) < 0.1) continue;
    db.prepare(
      `INSERT INTO signal_adjustments (key, adjustment, up_count, down_count) VALUES (?, ?, 0, 0)
       ON CONFLICT(key) DO UPDATE SET adjustment = MAX(-40, MIN(40, adjustment + ?)), updated_at = datetime('now')`
    ).run(`category:${cat}`, Math.max(-40, Math.min(40, nudge)), nudge);
    out.push({ key: `category:${cat}`, step: nudge, delta: nudge, from: "manual_importance" });
  }

  // log each move + the hinge stats so the operator can read WHY a weight changed.
  if (out.length || violated || skipped) {
    const line = `learn: ${violated} violated pairs (skipped ${skipped} already-correct) → ` +
      (out.length ? out.map((o) => `${o.key} ${o.step > 0 ? "+" : ""}${o.step} [${o.from}]`).join(", ") : "no net change");
    db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run(line);
  }
  markExamplesApplied(db, examples.map((e) => e.id));
  return out;
}

/**
 * Dream over ANSWER quality (separate from ranking — see answerLog.ts). This does NOT
 * move any ranking nudge; it only reflects, in a human-readable dream_log line, how often
 * the operator accepted vs edited vs rewrote our suggestions, and which A/B/C/D slot they
 * tend to pick. That reflection is what makes "save the suggested + the correction" useful:
 * over time the acceptance rate is the score for suggestion quality, glanceable in the log.
 */
export function dreamAnswers(db: DatabaseSync): { summary: string } {
  const { answerStats } = require("./answerLog");
  const s = answerStats(db, 30);
  if (!s.total) {
    const summary = "answers: no answer feedback yet — nothing to reflect on";
    db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run(summary);
    return { summary };
  }
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const hist = s.optionHistogram.length
    ? " · picks " + s.optionHistogram.map((n: number, i: number) => `${String.fromCharCode(65 + i)}:${n}`).join("/")
    : "";
  const worst = Object.entries(s.byCategory as Record<string, { total: number; acceptanceRate: number }>)
    .filter(([, v]) => v.total >= 3)
    .sort((a, b) => a[1].acceptanceRate - b[1].acceptanceRate)[0];
  const weak = worst ? ` · weakest suggestions: ${worst[0]} (${pct(worst[1].acceptanceRate)} accepted)` : "";
  const summary =
    `answers: ${s.total} sent · ${pct(s.acceptanceRate)} accepted as-is ` +
    `(${s.accepted} verbatim, ${s.optionPicked} option, ${s.edited} edited, ${s.rewritten} rewritten) ` +
    `· mean similarity ${s.meanSimilarity}${hist}${weak}`;
  db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run(summary);
  return { summary };
}

/** The full nightly dream: sync numeric/weight tuning + async RANKING.md evolution.
 *  Server/cron call this; tests can call dream() (numeric) + evolveRankingMd() separately. */
export async function runDream(db: DatabaseSync): Promise<DreamResult & { ranking?: { changed: boolean }; answers?: { summary: string } }> {
  const r = dream(db) as DreamResult & { weightChanges?: any[] };
  // Reflect on answer quality too (never perturbs ranking — prioritization stays primary).
  let answers: { summary: string } | undefined;
  try { answers = dreamAnswers(db); } catch { /* answer reflection is best-effort */ }

  // Sync the shared SOUL (voice) from the CRM, then run the conversation-review loop that evolves
  // ANSWERING.md + writes skills from the day's answer exchanges. Both best-effort — a failure logs
  // a note but never throws into the dream. See soul.ts / reflect.ts.
  try {
    const { syncSoulFromCrm, soulPath } = require("./soul");
    const { commitAndPush } = require("./ranking");
    const path = require("path");
    const s = syncSoulFromCrm();
    db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run("soul: " + s.note);
    if (s.synced) {
      try {
        const rel = path.relative(require("./ranking").repoRoot(), soulPath()) || "config/SOUL.md";
        const g = commitAndPush([rel], "dream: sync SOUL.md from CRM (Jarvis voice) [auto]");
        if (g.committed) db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run("git: " + g.note);
      } catch { /* git best-effort */ }
    }
  } catch { /* soul sync best-effort */ }
  try {
    const { runReflect } = require("./reflect");
    const { loadConfig } = require("./config");
    await runReflect(db, { model: loadConfig().models.triage });
  } catch { /* reflect is best-effort */ }

  try {
    const { evolveRankingMd, commitAndPushRankingMd } = require("./ranking");
    const { loadConfig } = require("./config");
    const model = loadConfig().models.triage;
    const rk = await evolveRankingMd(db, model);
    if (rk.changed) {
      db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run("RANKING.md evolved from recent operator preferences");
      // Auto-commit + push the evolved rules so the operator never pushes the nightly learning by
      // hand. Best-effort + pathspec-scoped (see commitAndPushRankingMd); only log when it lands.
      try {
        const g = commitAndPushRankingMd();
        if (g.committed) db.prepare("INSERT INTO dream_log (summary) VALUES (?)").run("git: " + g.note);
      } catch { /* never let git break the dream */ }
    }
    return { ...r, answers, ranking: { changed: rk.changed } };
  } catch {
    return { ...r, answers };
  }
}

export function lastDreams(db: DatabaseSync, limit = 5): { ran_at: string; summary: string }[] {
  return db
    .prepare("SELECT ran_at, summary FROM dream_log ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as { ran_at: string; summary: string }[];
}
