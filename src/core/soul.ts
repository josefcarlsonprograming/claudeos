/**
 * SOUL / AGENT / ANSWERING — the persona + voice layer, shared in spirit with the CRM's Jarvis.
 *
 * Three interpretable markdown files, all under config/ so the operator owns them in the open:
 *   - SOUL.md      — WHO the operator is + HOW he communicates (greeting style, brevity, emoji
 *                    rules, tone, Swedish code-switching, ownership language). This is the SYNCED
 *                    layer: its canonical source is the CRM (`voice-learner.js` distills it nightly
 *                    from real sent emails + call transcripts); `syncSoulFromCrm()` pulls it here.
 *   - AGENT.md     — this app's ROLE + hard rules (the cockpit operator-aide). Owned locally.
 *   - ANSWERING.md — LEARNED rules for how to draft the ABC candidate answers for the operator
 *                    (which slot he favors per category, edits he makes). Evolved nightly by
 *                    reflect.ts from ClaudeOS's OWN answer log. Owned locally.
 *
 * Everything degrades gracefully: a missing file → a sensible default; a failed sync → the last
 * synced copy is kept. Mirrors ranking.ts (readRanking/writeRanking) exactly.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { configDir, loadConfig } from "./config";

export const DEFAULT_SOUL = `# SOUL — who the operator is & how he communicates

_Canonical source is the CRM (Jarvis \`voice-learner.js\`); synced here nightly. Until the first
sync lands, this is a neutral placeholder — do not hand-edit; edit it in the CRM._

- Writes short, warm, decisive messages; a few sentences at most.
- Prefers plain, concrete language over hedging or corporate filler.
`;

export const DEFAULT_AGENT = `# AGENT — ClaudeOS cockpit operator-aide

You draft the operator-facing card for ~20 concurrent Claude Code sessions: a one-line recap, the
single next action, and 2-4 candidate answers ("ABC" options) the operator can send in one keystroke.

Operating rules:
- Draft the candidate answers exactly as the operator would type them back to the session — in his
  voice (see SOUL.md), concrete and decisive, best-first. For a yes/no, offer both.
- Optimise for a one-keystroke accept: option A should be what he most likely wants.
- Never invent facts about a session; ground every option in the question + transcript you were given.
- Respect the learned ANSWERING rules — they encode how he actually answers this kind of question.
`;

export const DEFAULT_ANSWERING = `# Learned answering rules (how the operator does his ABC questions)

Concise, human-readable rules the cockpit has learned from how the operator actually answers.
The nightly reflect loop evolves them; the ABC drafter follows them.

- (no learned answering rules yet — they appear here as the operator answers sessions)
`;

function p(name: string): string {
  return path.join(configDir(), name);
}
export function soulPath(): string { return p("SOUL.md"); }
export function agentPath(): string { return p("AGENT.md"); }
export function answeringPath(): string { return p("ANSWERING.md"); }

function readOr(file: string, fallback: string): string {
  try {
    const t = fs.readFileSync(file, "utf8");
    return t && t.trim() ? t : fallback;
  } catch {
    return fallback;
  }
}
function writeFile(file: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  } catch {}
}

export function readSoul(): string { return readOr(soulPath(), DEFAULT_SOUL); }
export function readAgent(): string { return readOr(agentPath(), DEFAULT_AGENT); }
export function readAnswering(): string { return readOr(answeringPath(), DEFAULT_ANSWERING); }
export function writeSoul(t: string): void { writeFile(soulPath(), t); }
export function writeAnswering(t: string): void { writeFile(answeringPath(), t); }

/**
 * The compact persona block injected into the ABC drafter (enrich.ts). Bounds each file so a long
 * SOUL/ANSWERING can't blow up the prompt. Returns "" if there's nothing meaningful to add.
 */
export function personaBlock(): string {
  const soul = readSoul().trim();
  const agent = readAgent().trim();
  const answering = readAnswering().trim();
  const parts: string[] = [];
  if (soul) parts.push(`The operator's SOUL — write in THIS voice:\n"""\n${soul.slice(0, 1500)}\n"""`);
  if (agent) parts.push(`Your ROLE (AGENT):\n"""\n${agent.slice(0, 800)}\n"""`);
  if (answering) parts.push(`LEARNED answering rules (follow these):\n"""\n${answering.slice(0, 1200)}\n"""`);
  return parts.length ? "\n" + parts.join("\n") : "";
}

export type ShellRunner = (cmd: string, args: string[]) => string;
const defaultRun: ShellRunner = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });

export interface SoulSyncResult {
  synced: boolean;
  note: string;
}

/**
 * Pull the canonical SOUL.md from the CRM repo's GitHub remote (read-only Contents API) and write
 * it to config/SOUL.md. Config-driven source (config/weights.json `soul_source: { repo, path }`) so
 * nothing is hardcoded. Best-effort: if `gh` is missing, unauthenticated, offline, or the file is
 * absent, we KEEP the last synced copy and return a note — this NEVER throws into the dream.
 *
 * `run` is injected in tests (fake gh); production uses `gh api …`.
 */
export function syncSoulFromCrm(opts?: { run?: ShellRunner }): SoulSyncResult {
  const run = opts?.run || defaultRun;
  let src: { repo?: string; path?: string } = {};
  try { src = (loadConfig() as any).soul_source || {}; } catch {}
  if (!src.repo || !src.path) return { synced: false, note: "no soul_source configured — skipped" };
  let content = "";
  try {
    // `gh api repos/<owner>/<repo>/contents/<path> --jq .content` returns base64; decode it.
    const b64 = run("gh", ["api", `repos/${src.repo}/contents/${src.path}`, "--jq", ".content"]).trim();
    if (!b64) return { synced: false, note: `empty response from ${src.repo}/${src.path} — kept last copy` };
    content = Buffer.from(b64, "base64").toString("utf8");
  } catch (e: any) {
    return { synced: false, note: "gh fetch failed — kept last copy: " + String(e?.message || e).slice(0, 120) };
  }
  if (!content.trim() || content.trim().length < 20) {
    return { synced: false, note: "fetched SOUL too small — kept last copy" };
  }
  if (content === readSoul()) return { synced: false, note: "SOUL.md already up to date" };
  writeSoul(content);
  return { synced: true, note: `synced SOUL.md from ${src.repo}/${src.path}` };
}
