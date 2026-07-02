/**
 * Gist + chat_log test (the SOUL-voiced chat interface's core).
 * Verifies:
 *   - gistFallback synthesizes grounded beats offline (never blanks).
 *   - buildGistPrompt injects the operator's SOUL voice (personaBlock).
 *   - generateGist parses the model's beats AND logs a chat_log row (role 'gist', prompt captured).
 *   - refreshGist caches on the content key (same key → zero extra model calls; new key → regenerate).
 *   - db.logChat / db.recentChat round-trip + filter by scope/session.
 *
 * Standalone ring (registered in run_all.ts). Run: node dist/test/gist_test.js
 */
import * as path from "path";
import * as fs from "fs";
import { tmpHome, check, eq, summary } from "./helpers";

// Throwaway HOME/DB/config BEFORE importing core (same discipline as soul_reflect_test).
const HOME = tmpHome();
process.env.HOME = HOME;
process.env.COCKPIT_DB = path.join(HOME, "cockpit.db");
process.env.COCKPIT_CONFIG_DIR = path.join(HOME, "config");
fs.mkdirSync(process.env.COCKPIT_CONFIG_DIR, { recursive: true });
for (const f of ["weights.json", "keymap.json"]) {
  fs.copyFileSync(path.resolve(__dirname, "../../config/" + f), path.join(process.env.COCKPIT_CONFIG_DIR, f));
}

import { openDb, logChat, recentChat } from "../core/db";
import { writeSoul } from "../core/soul";
import { gistFallback, buildGistPrompt, generateGist, refreshGist, cachedGist, _clearGistCache } from "../core/gist";

function baseInput(over: any = {}) {
  return {
    sessionId: 7,
    title: "dataloader refactor",
    state: "WAITING_INPUT" as const,
    category: "SIMPLE_QUESTION" as const,
    question: "Should I also update the callers?",
    conversation: "Claude migrated the loader and is now asking whether to update the callers too.",
    lastPrompt: "refactor the dataloader",
    model: "haiku",
    maxBeats: 6,
    ...over,
  };
}

async function main() {
  console.log("\n== Gist + chat_log ==");
  const db = openDb();

  // ---------- deterministic fallback (offline) ----------
  const fb = gistFallback(baseInput());
  check("gistFallback returns at least one beat", fb.beats.length >= 1);
  check("gistFallback ends on an 'ask' beat when WAITING_INPUT", fb.beats[fb.beats.length - 1].kind === "ask");
  check("gistFallback respects maxBeats", gistFallback(baseInput({ maxBeats: 1 })).beats.length === 1);
  const done = gistFallback(baseInput({ state: "DONE", question: "" }));
  check("gistFallback DONE still yields an ask/next beat", done.beats.some((b) => b.kind === "ask"));

  // ---------- persona injection ----------
  writeSoul("# SOUL\n\n- Writes GIST_SOUL_MARK short and warm.\n");
  const prompt = buildGistPrompt(baseInput());
  check("buildGistPrompt injects the SOUL voice", prompt.includes("GIST_SOUL_MARK"));
  check("buildGistPrompt asks for a beats JSON shape", /beats/.test(prompt) && /"kind"/.test(prompt));
  check("buildGistPrompt includes the conversation tail", prompt.includes("update the callers"));

  // ---------- generateGist: parse model beats + log to chat_log ----------
  const gen = async (_p: string) =>
    '{"beats":[{"kind":"beat","text":"Migrated the loader clean."},{"kind":"ask","text":"Want the callers updated too?"}]}';
  const out = await generateGist(baseInput(), { gen, db });
  eq("generateGist parsed 2 beats", out.beats.length, 2);
  check("generateGist kept the ask beat kind", out.beats[1].kind === "ask");
  const logged = recentChat(db, { scope: "task", roles: ["gist"], limit: 5 });
  check("generateGist logged a chat_log gist row", logged.length === 1);
  check("chat_log row captured the prompt", !!logged[0].prompt && logged[0].prompt!.includes("GIST_SOUL_MARK"));
  eq("chat_log row is on the right session", logged[0].session_id, 7);

  // ---------- generateGist falls back on an unparseable / empty model reply ----------
  const bad = await generateGist(baseInput(), { gen: async () => "sorry, no json here" });
  check("generateGist falls back when the model returns no JSON", bad.beats.length >= 1);

  // ---------- refreshGist caching on the content key ----------
  _clearGistCache();
  let calls = 0;
  const counting = async (_p: string) => { calls++; return '{"beats":[{"kind":"beat","text":"x"}]}'; };
  await refreshGist(baseInput(), "sig-1", { gen: counting });
  await refreshGist(baseInput(), "sig-1", { gen: counting });
  eq("refreshGist reuses the cache on an unchanged key", calls, 1);
  check("cachedGist exposes the last gist", (cachedGist(7)?.beats.length || 0) >= 1);
  await refreshGist(baseInput(), "sig-2", { gen: counting });
  eq("refreshGist regenerates on a new key", calls, 2);

  // ---------- db.logChat / recentChat directly ----------
  logChat(db, { scope: "global", role: "user", content: "what needs me?" });
  logChat(db, { scope: "global", role: "assistant", content: "the dataloader wants a yes/no." });
  const globalRows = recentChat(db, { scope: "global", limit: 10 });
  eq("recentChat filters to the global scope", globalRows.length, 2);
  check("recentChat is newest-first", globalRows[0].role === "assistant");
  const taskRows = recentChat(db, { sessionId: 7, limit: 10 });
  check("recentChat filters by session", taskRows.length >= 1 && taskRows.every((r) => r.session_id === 7));

  process.exit(summary());
}

main();
