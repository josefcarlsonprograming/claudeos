/**
 * SOUL + reflect loop test (the persona/voice layer + nightly conversation-review).
 * Verifies:
 *   - soul.ts read/write defaults + persona injection into the ABC drafter (enrich.buildPrompt).
 *   - syncSoulFromCrm() with an injected fake `gh` runner writes config/SOUL.md, and degrades
 *     safely (keeps the last copy) when the fetch fails.
 *   - reflect.ts: evolveAnsweringMd rewrites ANSWERING.md from the day's answers; skill detection
 *     fires ONLY past the sample+consistency thresholds; runReflect writes a reflect_scores row +
 *     a dream_log line, all with a stubbed generator (no real `claude` call).
 *
 * Standalone ring (registered in run_all.ts). Run: node dist/test/soul_reflect_test.js
 */
import * as path from "path";
import * as fs from "fs";
import { tmpHome, check, eq, summary } from "./helpers";

// Throwaway HOME/DB/config BEFORE importing core (same discipline as harness.ts / answer_feedback_test).
const HOME = tmpHome();
process.env.HOME = HOME;
process.env.COCKPIT_DB = path.join(HOME, "cockpit.db");
process.env.COCKPIT_CONFIG_DIR = path.join(HOME, "config");
fs.mkdirSync(process.env.COCKPIT_CONFIG_DIR, { recursive: true });
for (const f of ["weights.json", "keymap.json"]) {
  fs.copyFileSync(path.resolve(__dirname, "../../config/" + f), path.join(process.env.COCKPIT_CONFIG_DIR, f));
}

import { openDb } from "../core/db";
import { recordAnswer } from "../core/answerLog";
import {
  readSoul, writeSoul, readAnswering, writeAnswering, personaBlock, syncSoulFromCrm, soulPath, answeringPath,
} from "../core/soul";
import { buildPrompt } from "../core/enrich";
import {
  evolveAnsweringMd, detectSkillCandidates, writeSkills, scoreTrajectory, runReflect, skillsDir,
} from "../core/reflect";

function seedAccepted(db: any, category: string, n: number, text: string) {
  for (let i = 0; i < n; i++) {
    recordAnswer(db, { itemId: 1000 + i, sessionId: 1, category: category as any, state: "WAITING_INPUT", question: `${category} q${i}?`, suggested: text, options: [text, "No."], final: text });
  }
}
function seedRewritten(db: any, category: string, n: number) {
  for (let i = 0; i < n; i++) {
    recordAnswer(db, { itemId: 2000 + i, sessionId: 2, category: category as any, state: "WAITING_INPUT", question: `${category} q${i}?`, suggested: "Ship it.", options: ["Ship it.", "Hold."], final: `Actually redesign approach ${i} entirely and revisit tomorrow please.` });
  }
}

async function main() {
  console.log("\n== SOUL + reflect loop ==");

  const db = openDb();

  // ---------- soul.ts: defaults + write/read ----------
  check("readSoul returns a non-empty default", readSoul().length > 20);
  check("readAnswering returns a default stub", /answering rules/i.test(readAnswering()));
  writeSoul("# SOUL\n\n- Writes SOUL_MARK short and warm.\n");
  check("writeSoul → readSoul round-trip", readSoul().includes("SOUL_MARK"));

  // ---------- persona injection into the ABC drafter ----------
  writeAnswering("# Learned answering rules\n\n- ANSWERING_MARK: he answers yes unless there's risk.\n");
  const block = personaBlock();
  check("personaBlock includes SOUL", block.includes("SOUL_MARK"));
  check("personaBlock includes ANSWERING rules", block.includes("ANSWERING_MARK"));
  check("personaBlock includes AGENT role", /AGENT/i.test(block));
  const prompt = buildPrompt({ category: "SIMPLE_QUESTION", title: "t", questionText: "Ship it? (yes/no)", lastPrompt: "", recentTranscript: "", focus: "", changedLines: 0, model: "haiku" });
  check("buildPrompt (SIMPLE_QUESTION) injects the SOUL voice", prompt.includes("SOUL_MARK"));
  check("buildPrompt injects the learned answering rules", prompt.includes("ANSWERING_MARK"));
  // REVIEW_DIFF has no ABC options → no persona needed there.
  const diffPrompt = buildPrompt({ category: "REVIEW_DIFF", title: "t", questionText: "review", lastPrompt: "", recentTranscript: "", focus: "", changedLines: 20, diffStat: "x | 1 +", model: "haiku" });
  check("buildPrompt (REVIEW_DIFF) does not force the persona block", !diffPrompt.includes("SOUL_MARK"));

  // ---------- syncSoulFromCrm: fake gh runner ----------
  const remoteSoul = "# SOUL — synced\n\n- Remote REMOTE_MARK voice bullet.\n";
  const fakeGh = (cmd: string, args: string[]) => {
    check("gh called with the contents API path", cmd === "gh" && args.join(" ").includes("contents/agent/SOUL.md"));
    return Buffer.from(remoteSoul, "utf8").toString("base64");
  };
  const okSync = syncSoulFromCrm({ run: fakeGh });
  check("syncSoulFromCrm reports synced", okSync.synced === true);
  check("config/SOUL.md now holds the remote content", readSoul().includes("REMOTE_MARK"));
  eq("SOUL.md is written to the config dir", soulPath(), path.join(process.env.COCKPIT_CONFIG_DIR!, "SOUL.md"));
  // failure path keeps the last synced copy (never throws)
  const failSync = syncSoulFromCrm({ run: () => { throw new Error("gh: not authenticated"); } });
  check("failed sync does NOT throw and reports not-synced", failSync.synced === false);
  check("failed sync keeps the last good SOUL.md", readSoul().includes("REMOTE_MARK"));

  // ---------- reflect: evolve ANSWERING.md ----------
  seedAccepted(db, "SIMPLE_QUESTION", 5, "Yes, ship it.");     // triggers a skill (rate 1.0, n=5)
  seedRewritten(db, "REVIEW_DIFF", 5);                         // rate 0 → no skill (consistency guard)
  seedAccepted(db, "COMPLEX_DECISION", 2, "Use approach A.");  // n=2 → no skill (sample guard)

  const EVOLVE_MARK = "EVOLVED_ANSWER_RULE_short_and_warm";
  const SKILL_BODY = "# Skill: answer SIMPLE_QUESTION\nSKILL_BODY_MARK\n";
  const gen = async (p: string): Promise<string> => {
    if (/Output ONLY JSON/i.test(p) && /score/i.test(p)) return '{"score": 82, "rationale": "acceptance rising, edits smaller"}';
    if (/Write a SKILL/i.test(p)) return SKILL_BODY;
    return `# Learned answering rules\n\n- ${EVOLVE_MARK}\n- keep option A decisive\n`;
  };

  const ev = await evolveAnsweringMd(db, gen);
  check("evolveAnsweringMd reports changed", ev.changed === true);
  check("ANSWERING.md written with the evolved rule", readAnswering().includes(EVOLVE_MARK));

  // ---------- reflect: skill detection thresholds ----------
  const cands = detectSkillCandidates(db);
  check("skill candidate: SIMPLE_QUESTION qualifies", cands.some((c) => c.category === "SIMPLE_QUESTION"));
  check("no skill for REVIEW_DIFF (consistency too low)", !cands.some((c) => c.category === "REVIEW_DIFF"));
  check("no skill for COMPLEX_DECISION (too few samples)", !cands.some((c) => c.category === "COMPLEX_DECISION"));

  const wrote = await writeSkills(db, gen);
  check("writeSkills wrote exactly one skill", wrote.length === 1, `got ${JSON.stringify(wrote)}`);
  check("the skill file exists on disk with the generated body", fs.existsSync(path.join(skillsDir(), "answer-simple-question.md")) && fs.readFileSync(path.join(skillsDir(), "answer-simple-question.md"), "utf8").includes("SKILL_BODY_MARK"));
  check("no REVIEW_DIFF skill file was written", !fs.existsSync(path.join(skillsDir(), "answer-review-diff.md")));
  const wrote2 = await writeSkills(db, gen);
  check("writeSkills is idempotent (does not re-write an existing skill)", wrote2.length === 0);

  // ---------- reflect: trajectory score ----------
  const sc = await scoreTrajectory(db, gen);
  eq("scoreTrajectory parses the score", sc.score, 82);

  // ---------- runReflect end-to-end (commit disabled in the tmp non-repo) ----------
  const before = db.prepare("SELECT COUNT(*) AS n FROM dream_log").get() as { n: number };
  const res = await runReflect(db, { gen, commit: false });
  eq("runReflect score", res.score, 82);
  check("runReflect reports ANSWERING changed OR unchanged (already evolved)", typeof res.answeringChanged === "boolean");
  const row = db.prepare("SELECT score, rationale FROM reflect_scores WHERE run_date = date('now')").get() as any;
  check("reflect_scores row upserted with the score", row && row.score === 82);
  const after = db.prepare("SELECT COUNT(*) AS n FROM dream_log").get() as { n: number };
  check("runReflect wrote a dream_log line", after.n > before.n);
  const last = db.prepare("SELECT summary FROM dream_log ORDER BY id DESC LIMIT 1").get() as any;
  check("dream_log line mentions the reflect score", /reflect: score 82/.test(last.summary), last.summary);

  eq("answeringPath is under the config dir", answeringPath(), path.join(process.env.COCKPIT_CONFIG_DIR!, "ANSWERING.md"));

  process.exit(summary());
}

main();
