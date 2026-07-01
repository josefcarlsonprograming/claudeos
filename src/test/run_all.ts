/**
 * THE one test script. Runs every ring of the suite in sequence and fails if ANY of them fails:
 *
 *   1. core harness      — fast, headless, deterministic (engine/ranking/feedback/undo/merge logic)
 *   2. server E2E        — boots the REAL web server (isolated demo sandbox) and drives every
 *                          HTTP endpoint, the terminal WebSocket, SSE, and a real throwaway merge
 *   3. UI click-through  — drives the REAL renderer in a headless browser: clicks every button,
 *                          presses every key (incl. Ctrl+Z undo, Ctrl +/- zoom), and asserts each
 *                          actually changed state
 *
 * Green here = nothing the operator touches is broken. Run with:  npm test
 * (or a single ring: node dist/test/run_all.js core | server | ui)
 */
import * as path from "path";
import { spawnSync } from "child_process";

const SUITES: [string, string][] = [
  ["core harness", "harness.js"],
  ["worktree base-ref (cockpit.baseref → session base branch)", "worktree_baseref_test.js"],
  ["transcript prompt extraction ('You asked' skips injected turns)", "transcript_prompt_test.js"],
  ["answer-feedback loop", "answer_feedback_test.js"],
  ["SOUL + reflect loop (persona sync · ANSWERING evolve · skills)", "soul_reflect_test.js"],
  ["overview metrics (this-session stats)", "metrics_test.js"],
  ["terminal size (new-terminal window sizing, real tmux)", "terminal_size_test.js"],
  ["terminal mode replay (scroll survives pty reuse)", "termmodes_test.js"],
  ["desktop terminal leak (reload reaps ptys · ids don't recycle)", "desktop_term_leak_test.js"],
  ["quick prompt (Ctrl+G i background Claude session)", "quick_prompt_test.js"],
  ["server E2E (HTTP · WS · SSE · real merge)", "e2e_server.js"],
  ["UI click-through (browser)", "e2e_ui.js"],
  ["quick prompt focus trap (browser)", "quick_prompt_ui.js"],
];

const only = (process.argv[2] || "").toLowerCase();
const pick = SUITES.filter(([name, file]) =>
  !only ? true : name.toLowerCase().includes(only) || file.includes(only)
);

const results: { name: string; ok: boolean; code: number | null }[] = [];
for (const [name, file] of pick) {
  console.log(`\n\n${"#".repeat(70)}\n##  ${name}\n${"#".repeat(70)}`);
  const r = spawnSync("node", [path.join(__dirname, file)], { stdio: "inherit" });
  results.push({ name, ok: r.status === 0, code: r.status });
}

console.log(`\n\n${"=".repeat(70)}\n  E2E SUMMARY\n${"=".repeat(70)}`);
for (const r of results) {
  console.log(`  ${r.ok ? "\x1b[32m✓ PASS\x1b[0m" : "\x1b[31m✗ FAIL\x1b[0m"}  ${r.name}${r.ok ? "" : `  (exit ${r.code})`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? "\n\x1b[32m  ALL SUITES GREEN — nothing the operator touches is broken.\x1b[0m\n"
    : `\n\x1b[31m  ${failed} suite(s) FAILED — see output above.\x1b[0m\n`
);
process.exit(failed === 0 ? 0 : 1);
