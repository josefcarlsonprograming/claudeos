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
import { queueSummary, buildAssistantPrompt, parseAssistantReply } from "../core/assistant";

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
  check("gistFallback returns a summary", typeof fb.summary === "string" && fb.summary.length > 0);
  check("gistFallback WAITING_INPUT summary carries a 🔴 needs-you marker", /🔴/.test(fb.summary));
  check("gistFallback offers suggested replies", fb.suggestions.length >= 2);
  const done = gistFallback(baseInput({ state: "DONE", question: "" }));
  check("gistFallback DONE summary uses 🔵 nothing-needed", /🔵/.test(done.summary));

  // ---------- persona injection ----------
  writeSoul("# SOUL\n\n- Writes GIST_SOUL_MARK short and warm.\n");
  const prompt = buildGistPrompt(baseInput());
  check("buildGistPrompt injects the SOUL voice", prompt.includes("GIST_SOUL_MARK"));
  check("buildGistPrompt asks for a {summary,suggestions} JSON shape", /"summary"/.test(prompt) && /"suggestions"/.test(prompt));
  check("buildGistPrompt asks for ONE message (co-worker voice)", /co-worker|ONE short message/i.test(prompt));
  check("buildGistPrompt includes the conversation tail", prompt.includes("update the callers"));

  // ---------- generateGist: parse model summary+suggestions + log to chat_log ----------
  const gen = async (_p: string) =>
    '{"summary":"Migrated the loader clean. 🔴 Want the callers updated too?","suggestions":["Yes, update them 😊","No, leave them","Show me the diff"]}';
  const out = await generateGist(baseInput(), { gen, db });
  check("generateGist parsed the summary", /Migrated the loader/.test(out.summary));
  eq("generateGist parsed 3 suggestions", out.suggestions.length, 3);
  const logged = recentChat(db, { scope: "task", roles: ["gist"], limit: 5 });
  check("generateGist logged a chat_log gist row", logged.length === 1);
  check("chat_log row captured the prompt", !!logged[0].prompt && logged[0].prompt!.includes("GIST_SOUL_MARK"));
  eq("chat_log row is on the right session", logged[0].session_id, 7);

  // ---------- generateGist falls back on an unparseable / empty model reply ----------
  const bad = await generateGist(baseInput(), { gen: async () => "sorry, no json here" });
  check("generateGist falls back when the model returns no JSON", bad.summary.length >= 1 && bad.suggestions.length >= 2);

  // ---------- refreshGist caching on the content key ----------
  _clearGistCache();
  let calls = 0;
  const counting = async (_p: string) => { calls++; return '{"summary":"x done. 🔵 nothing needed","suggestions":["ok 😊","more"]}'; };
  await refreshGist(baseInput(), "sig-1", { gen: counting });
  await refreshGist(baseInput(), "sig-1", { gen: counting });
  eq("refreshGist reuses the cache on an unchanged key", calls, 1);
  check("cachedGist exposes the last gist", !!cachedGist(7)?.summary);
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

  // ---------- Stage 3: global assistant (pure prompt-build + parse) ----------
  console.log("\n== Assistant (global cockpit chat) ==");
  const qs = queueSummary([{ sessionId: 5, title: "dataloader", category: "SIMPLE_QUESTION", state: "WAITING_INPUT", one_liner: "asks yes/no" }]);
  check("queueSummary lists the session id + title", qs.includes("session 5") && qs.includes("dataloader"));
  check("queueSummary handles an empty queue", /empty/i.test(queueSummary([])));
  writeSoul("# SOUL\n\n- ASSIST_SOUL_MARK warm and short.\n");
  const ap = buildAssistantPrompt(require("../core/soul").personaBlock(), qs, "what needs me?", [{ role: "user", content: "hi" }]);
  check("buildAssistantPrompt injects the SOUL voice", ap.includes("ASSIST_SOUL_MARK"));
  check("buildAssistantPrompt includes the queue summary + action vocabulary", ap.includes("dataloader") && /answer\|dismiss\|complete\|focus\|none/.test(ap));
  check("buildAssistantPrompt carries recent history", ap.includes("hi"));
  const r1 = parseAssistantReply('{"say":"On it — sending yes.","action":{"type":"answer","sessionId":5,"text":"yes"}}');
  check("parseAssistantReply extracts say", r1.say === "On it — sending yes.");
  check("parseAssistantReply extracts a valid action", r1.action.type === "answer" && r1.action.sessionId === 5 && r1.action.text === "yes");
  const r2 = parseAssistantReply("just some prose, no json");
  check("parseAssistantReply degrades to say + none for non-JSON", r2.action.type === "none" && r2.say.length > 0);
  const r3 = parseAssistantReply('{"say":"hm","action":{"type":"nuke","sessionId":9}}');
  check("parseAssistantReply rejects an unknown action type (→ none)", r3.action.type === "none");
  const r4 = parseAssistantReply(null);
  check("parseAssistantReply handles a null model reply", r4.action.type === "none" && r4.say.length > 0);

  process.exit(summary());
}

main();
