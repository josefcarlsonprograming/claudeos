/**
 * Deterministic end-to-end harness. Spins up several mock Claude Code sessions in
 * different states and asserts the whole flow:
 *   - working / background sessions are NEVER surfaced as actionable
 *   - the classifier routes each ready session to the right view
 *   - priority ordering respects the transparent weights
 *   - feedback actually shifts the learned weights and re-ranks
 *   - the full keyboard controller loop works headlessly
 *
 * Runs offline (enrich disabled) so it is fast and reproducible. Live Claude calls
 * are exercised separately in live_test.ts (COCKPIT_LIVE=1).
 */
import * as path from "path";
import * as fs from "fs";
import { tmpHome, writeTranscript, makeRepoWithDiff, check, eq, summary } from "./helpers";

// Redirect HOME + DB + config to throwaway locations BEFORE importing core.
const HOME = tmpHome();
process.env.HOME = HOME;
process.env.COCKPIT_DB = path.join(HOME, "cockpit.db");
process.env.COCKPIT_CONFIG_DIR = path.join(HOME, "config");
fs.mkdirSync(process.env.COCKPIT_CONFIG_DIR, { recursive: true });
fs.copyFileSync(
  path.resolve(__dirname, "../../config/weights.json"),
  path.join(process.env.COCKPIT_CONFIG_DIR, "weights.json")
);
fs.copyFileSync(
  path.resolve(__dirname, "../../config/keymap.json"),
  path.join(process.env.COCKPIT_CONFIG_DIR, "keymap.json")
);

import { openDb, upsertSession, upsertDiscoveredSession, getSession } from "../core/db";
import { loadConfig } from "../core/config";
import { SessionManager } from "../core/sessions";
import { Engine } from "../core/engine";
import { Controller } from "../core/controller";
import { detectState } from "../core/stateDetector";
import { StreamingSampler, transcriptSig, processTreeJiffies } from "../core/streamingSampler";
import { parseVerdict, mapActivity, verifierTail, VERDICT_REV } from "../core/workingVerifier";
import { parseTranscript, projectDirFor, findTranscriptById } from "../core/transcript";
import { allAdjustments } from "../core/feedback";
import { parseEtaMarker, parseDurationMinutes, formatTimeLeft, etaFromJson } from "../core/eta";
import { deriveMeta, applyTaskWindowMeta, humanizeTaskTag, parsePrUrl, TASK_TAG_TITLED, infraTags } from "../core/discover";
import { buildIndex, keywordSearch, semanticRank } from "../core/sessionSearch";

/** Teammates (Claude Code team sub-agents): detected via the transcript's top-level
 *  teamName/agentName fields, never surfaced as their own cards, and listed as child rows under
 *  ONE team-group queue entry. */
async function teammateTests(db: any, engine: Engine, ctrl: Controller): Promise<void> {
  console.log("\n== Teammates: detection + team-group nesting ==");
  // 1) deriveMeta extracts teamName/agentName and unwraps the <teammate-message> envelope title.
  const dir = path.join(HOME, "teamwt");
  fs.mkdirSync(dir, { recursive: true });
  const tp = path.join(dir, "mate.jsonl");
  fs.writeFileSync(
    tp,
    JSON.stringify({
      type: "user", cwd: dir, teamName: "sup-test-team", agentName: "reviewer-r1",
      message: { role: "user", content: '<teammate-message teammate_id="team-lead">\nYou are "reviewer-r1", an independent reviewer on team "sup-test-team".\n</teammate-message>' },
    }) + "\n"
  );
  const meta = await deriveMeta(tp, fs.statSync(tp).mtimeMs);
  eq("teammate: deriveMeta captures teamName", meta?.teamName, "sup-test-team");
  eq("teammate: deriveMeta captures agentName", meta?.agentName, "reviewer-r1");
  check("teammate: envelope unwrapped into the title (agent-noise signatures can now match)",
    !!meta && meta.title.startsWith('You are "reviewer-r1"'));

  // 2) upsert persists the teammate marker.
  const id1 = upsertDiscoveredSession(db, { claude_session_id: "uuid-mate1", title: meta!.title, repo: "demo", worktree_path: dir, branch: "-", transcript_path: tp, is_teammate: 1, team_name: "sup-test-team", agent_name: "reviewer-r1" });
  const id2 = upsertDiscoveredSession(db, { claude_session_id: "uuid-mate2", title: "worker task", repo: "demo", worktree_path: dir, branch: "-", transcript_path: tp, is_teammate: 1, team_name: "sup-test-team", agent_name: "worker" });
  const r1 = db.prepare("SELECT is_teammate, team_name, agent_name FROM sessions WHERE id=?").get(id1) as any;
  eq("teammate: is_teammate persisted", r1.is_teammate, 1);
  eq("teammate: team_name persisted", r1.team_name, "sup-test-team");

  // 3) queue(): ONE team-group row, both mates as sorted children, never the recommended next,
  //    and no individual card for either teammate.
  const q = engine.queue();
  const grp = q.filter((x: any) => x._team && x.session.title === "demo — sup-test-team");
  eq("teammate: exactly ONE team-group row per team", grp.length, 1);
  eq("teammate: both mates listed as children", grp[0].children!.length, 2);
  eq("teammate: children sorted by agent name", grp[0].children![0].agent_name, "reviewer-r1");
  check("teammate: team-group row is never `next`", ctrl.state().next?.id !== grp[0].id);
  check("teammate: no individual queue card for a teammate session",
    !q.some((x: any) => !x._team && (x.session_id === id1 || x.session_id === id2)));

  // 4) ROSTER (operator request 2026-06-16): non-orphaned teammate sub-agents are HIDDEN from the
  //    sessions panel (their team-group row represents them); an ORPHANED teammate still shows.
  const rosterIds = () => new Set(ctrl.state().sessions.map((x: any) => x.row.id));
  check("teammate: a non-orphaned teammate is NOT in the sessions roster", !rosterIds().has(id1) && !rosterIds().has(id2));
  db.prepare("UPDATE sessions SET teammate_orphaned=1 WHERE id=?").run(id1);
  check("teammate: an ORPHANED teammate is ALSO hidden from the roster (machinery — only its team row)", !rosterIds().has(id1));
  db.prepare("UPDATE sessions SET teammate_orphaned=0 WHERE id=?").run(id1);
  // a normal (non-teammate) session is always in the roster
  const normalId = upsertDiscoveredSession(db, { claude_session_id: "uuid-normal", title: "real work", repo: "demo", worktree_path: dir, branch: "-", transcript_path: tp });
  check("teammate: a normal session is in the roster", rosterIds().has(normalId));
  db.prepare("UPDATE sessions SET completed_at=datetime('now') WHERE id=?").run(normalId);

  // Archive the fixtures so the rest of the harness sees an unchanged queue.
  db.prepare("UPDATE sessions SET completed_at=datetime('now') WHERE id IN (?,?)").run(id1, id2);
}

/** ETA feature: pure-function parsing/formatting + source guards on the engine wiring. */
function etaTests(): void {
  // duration parsing
  eq("eta: bare number is minutes", parseDurationMinutes("90"), 90);
  eq("eta: '50m' -> 50", parseDurationMinutes("50m"), 50);
  eq("eta: '2h' -> 120", parseDurationMinutes("2h"), 120);
  eq("eta: '1h30m' -> 90", parseDurationMinutes("1h30m"), 90);
  eq("eta: '1.5h' -> 90", parseDurationMinutes("1.5h"), 90);
  eq("eta: garbage -> null", parseDurationMinutes("soon-ish"), null);

  // marker parsing
  eq("eta marker: time", parseEtaMarker("eta: 50m")?.kind, "time");
  eq("eta marker: time minutes", parseEtaMarker("eta: 50m")?.minutes, 50);
  eq("eta marker: done", parseEtaMarker("blah\neta: done")?.kind, "done");
  eq("eta marker: none", parseEtaMarker("eta: none")?.kind, "none");
  eq("eta marker: takes the LAST marker", parseEtaMarker("eta: 99m\nok\neta: 10m")?.minutes, 10);
  eq("eta marker: absent -> null", parseEtaMarker("no marker here"), null);
  eq("eta marker: case-insensitive", parseEtaMarker("ETA: 5M")?.minutes, 5);

  // Haiku interpretation mapping (the "read the free-form reply, distill the ETA" step). The model
  // call is mocked elsewhere; here we lock the pure JSON→ETA mapping it runs through.
  eq("eta haiku: time→minutes", etaFromJson({ kind: "time", minutes: 90 })?.minutes, 90);
  eq("eta haiku: time rounds", etaFromJson({ kind: "time", minutes: 12.6 })?.minutes, 13);
  eq("eta haiku: done", etaFromJson({ kind: "done" })?.kind, "done");
  eq("eta haiku: none", etaFromJson({ kind: "none" })?.kind, "none");
  eq("eta haiku: time without minutes → null", etaFromJson({ kind: "time" }), null);
  eq("eta haiku: garbage kind → null", etaFromJson({ kind: "soonish" } as any), null);
  eq("eta haiku: null → null", etaFromJson(null), null);

  // time-left formatting (relative to a fixed now)
  const now = Date.parse("2026-01-01T00:00:00Z");
  const inMins = (m: number) => new Date(now + m * 60000).toISOString();
  eq("eta fmt: ~45m", formatTimeLeft(inMins(45), now), "~45m");
  eq("eta fmt: ~2h", formatTimeLeft(inMins(120), now), "~2h");
  eq("eta fmt: ~1h30m", formatTimeLeft(inMins(90), now), "~1h30m");
  eq("eta fmt: past -> due now", formatTimeLeft(inMins(-5), now), "due now");
  eq("eta fmt: null -> empty", formatTimeLeft(null, now), "");

  // source guards — wiring that can't easily be exercised offline (the estimate path calls Haiku)
  const ejs = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
  check("eta(src): staleness re-based on lastActivity (mtime), not created_at",
    /ageHours = laMs \? \(Date\.now\(\) - laMs\)/.test(ejs) && /lastActivityMs\(s\)/.test(ejs));
  check("eta(src): passive long-run gate covers WORKING and quiet-parked (UNKNOWN) sessions",
    /state === "WORKING" \|\| \(state === "UNKNOWN" && quietMin >= cfg\.probe_after_min\)/.test(ejs));
  check("eta(src): the ETA path NEVER injects keystrokes (no /eta probe, no sendInput in handleEta)",
    !/ETA_PROBE_TEXT/.test(ejs) && !/sendInput/.test(ejs.slice(ejs.indexOf("private handleEta("), ejs.indexOf("private ", ejs.indexOf("private handleEta(") + 20))));
  check("eta(src): passive estimate reads the session's OWN output (pane capture → transcript tail)",
    /this\.sessions\.capturePane\(s, 80\)/.test(ejs) && /estimateEtaFromOutput\(output, this\.cfg\.models\.triage\)/.test(ejs));
  const sjs = fs.readFileSync(path.resolve(__dirname, "../../src/core/sessions.ts"), "utf8");
  check("eta(src): sendInput targets the EXACT discovered pane (pane_id/tmux_target), not just cwd",
    /session\.is_live_pane \? \(session\.pane_id \|\| session\.tmux_target\)/.test(sjs));
  check("eta(src): handleEta is called from the tick", /this\.handleEta\(s, detected, state\)/.test(ejs));
  check("eta(src): a free-form probe reply is handed to Haiku to distill (scheduleEtaInterpret)",
    /isProbeReply && this\.opts\.enrich !== false\) this\.scheduleEtaInterpret/.test(ejs) &&
    /interpretEta\(text, this\.cfg\.models\.triage\)/.test(ejs));
  const rjs = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
  check("eta(src): renderer shows a countdown bar from eta_at", /sess-etabar/.test(rjs) && /r\.eta_at/.test(rjs));
  const djs = fs.readFileSync(path.resolve(__dirname, "../../src/core/db.ts"), "utf8");
  check("eta(src): sessions table migrates eta columns", /eta_at TEXT/.test(djs) && /eta_probe_at TEXT/.test(djs));
}

/** Source guards for the Alt+Backspace "delete word" wiring (FIX WD). The browser path (in-page
 *  xterm handler) and the renderer routing are exercised live in e2e_ui; the Electron-only IPC glue
 *  (main.js before-input-event → preload bridge) can't run headless, so guard it at the source so the
 *  desktop word-delete can never silently lose a link in the chain. */
function altBackspaceWiringTests(): void {
  // 1) main process: Alt+Backspace (Chromium eats it as the OS "undo" before the page) is caught in
  //    before-input-event, swallowed, and re-sent as 0x17 (the Ctrl+W byte) to the renderer.
  const mjs = fs.readFileSync(path.resolve(__dirname, "../../desktop/main.js"), "utf8");
  check("altbs(src): main.js intercepts Alt+Backspace in before-input-event",
    /before-input-event/.test(mjs) && /input\.alt && !input\.control && !input\.meta && input\.key === "Backspace"/.test(mjs));
  check("altbs(src): main.js swallows it (preventDefault) and sends claudeos:inject-input = 0x17",
    /webContents\.send\("claudeos:inject-input", "\\x17"\)/.test(mjs));

  // 2) preload bridge: the IPC reaches a single renderer-registered callback via claudeosNative.onInjectInput.
  const pjs = fs.readFileSync(path.resolve(__dirname, "../../desktop/preload.js"), "utf8");
  check("altbs(src): preload.js listens for claudeos:inject-input and bridges it to a callback",
    /ipcRenderer\.on\("claudeos:inject-input"/.test(pjs) && /_injectCb/.test(pjs));
  check("altbs(src): preload.js exposes onInjectInput on claudeosNative",
    /onInjectInput\(cb\)\s*{[^}]*_injectCb\s*=\s*cb/.test(pjs));

  // 3) renderer: wired at init, and routeInjectedInput dispatches by focus (terminal vs text field).
  const rjs = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
  check("altbs(src): renderer wires the injected-input callback to routeInjectedInput",
    /wireNativeInject\(\)/.test(rjs) && /n\.onInjectInput\(routeInjectedInput\)/.test(rjs));
  check("altbs(src): routeInjectedInput routes a focused terminal to the pty (termSendInput)",
    /function routeInjectedInput/.test(rjs) && /classList\.contains\("xterm-helper-textarea"\)/.test(rjs) && /inXterm\)\s*{\s*termSendInput\(d\)/.test(rjs));
  check("altbs(src): a focused text field gets an in-field word-rubout, not pty spam",
    /function deleteWordBackInField/.test(rjs) && /d === "\\x17" && ae && \(ae\.tagName === "TEXTAREA" \|\| ae\.tagName === "INPUT"\)/.test(rjs));
}

/** Regression: a Ctrl+G-i / new-Claude launch must surface as exactly ONE queue session, never a
 *  duplicate pair. The launch creates a row with claude_session_id=NULL (the transcript uuid is
 *  unknown at spawn); discovery later finds that worktree's transcript and MUST adopt the launch
 *  row rather than INSERT a second one keyed on the fresh uuid. */
function discoveryAdoptionTests(db: any): void {
  const wt = path.join(HOME, "wts", "adopt-A");
  fs.mkdirSync(wt, { recursive: true });
  // simulate launchTerminalSession's DB writes: own dedicated worktree, no uuid yet, provisional.
  const launchedId = upsertSession(db, { title: "new claude session", repo: "demo", worktree_path: wt, branch: "cockpit/new-claude-session-adoptA", state: "WORKING" });
  db.prepare("UPDATE sessions SET kind='claude', provisional=1, discovered=0 WHERE id=?").run(launchedId);

  const before = (db.prepare("SELECT COUNT(*) n FROM sessions").get() as any).n;
  const adoptedId = upsertDiscoveredSession(db, { claude_session_id: "uuid-A", title: "real prompt A", repo: "demo", worktree_path: wt, branch: "cockpit/new-claude-session-adoptA", transcript_path: path.join(wt, "t.jsonl") });
  const after = (db.prepare("SELECT COUNT(*) n FROM sessions").get() as any).n;
  eq("discovery ADOPTS the cockpit-launched row (no duplicate inserted)", after, before);
  eq("adopted row is the SAME launch row (id preserved)", adoptedId, launchedId);
  const row = db.prepare("SELECT claude_session_id, title, provisional FROM sessions WHERE id=?").get(launchedId) as any;
  eq("adoption stamps the transcript uuid onto the launch row", row.claude_session_id, "uuid-A");
  eq("adoption promotes the launch row to the real prompt title", row.title, "real prompt A");
  eq("adoption clears the provisional flag", row.provisional, 0);
  eq("re-discovery of the same uuid is idempotent (same row)",
     upsertDiscoveredSession(db, { claude_session_id: "uuid-A", title: "real prompt A", repo: "demo", worktree_path: wt, branch: "cockpit/new-claude-session-adoptA", transcript_path: path.join(wt, "t.jsonl") }),
     launchedId);

  // GUARD: two genuinely-distinct discovered sessions sharing a repo cwd must NOT be folded — there
  // is no un-stamped launch row at that path, so adoption never fires and each keeps its own row.
  const shared = path.join(HOME, "wts", "shared-repo");
  fs.mkdirSync(shared, { recursive: true });
  const d1 = upsertDiscoveredSession(db, { claude_session_id: "uuid-X", title: "session X", repo: "your-repo", worktree_path: shared, branch: "master", transcript_path: path.join(shared, "x.jsonl") });
  const d2 = upsertDiscoveredSession(db, { claude_session_id: "uuid-Y", title: "session Y", repo: "your-repo", worktree_path: shared, branch: "master", transcript_path: path.join(shared, "y.jsonl") });
  check("distinct same-cwd discovered sessions are NOT merged", d1 !== d2);
}

/** Card 288 ready-gate: the FREE double-sample stability gate + the 4-way classifier parse/map.
 *  These prove the hard guarantee at the unit level — an actively-moving session (new tokens OR CPU
 *  burn) is NEVER reported stable, so it can never reach the surface — independent of any live model
 *  (live_test.ts Part B/C covers the real launched process). */
function stateGateTests(cfg: any): void {
  const GAP = 5000, CPU = 0.05;

  console.log("\n== Ready-gate: transcript signature (the double-sample key) ==");
  check("sig changes when content grows (a new token)", transcriptSig("abc", 1) !== transcriptSig("abcd", 1));
  check("sig changes when only the mtime advances", transcriptSig("abc", 1) !== transcriptSig("abc", 2));
  check("sig stable for an identical (raw, mtime)", transcriptSig("abc", 1) === transcriptSig("abc", 1));

  console.log("\n== Ready-gate: double-sample never calls a streaming session stable ==");
  // A STREAMING session: every sample a different signature → NEVER stable, even with a huge gap.
  const s1 = new StreamingSampler();
  let everStable = false, t = 0;
  for (let i = 0; i < 6; i++) {
    t += 6000; // 6s apart — comfortably > gap, to prove it's the CHANGE, not the timing, that blocks
    const r = s1.consider(1, { sig: transcriptSig("tok".repeat(i + 1), 1000 + i), cpuJiffies: null, at: t }, GAP, CPU);
    if (r.stable) everStable = true;
  }
  check("a STREAMING session (sig changes every sample) is NEVER stable", !everStable);

  // A STOPPED session: identical signature; becomes stable only AFTER the gap elapses.
  const s2 = new StreamingSampler();
  const sig = transcriptSig("final answer", 5000);
  check("first sample is never stable (needs a second after the gap)", !s2.consider(2, { sig, cpuJiffies: null, at: 0 }, GAP, CPU).stable);
  check("unchanged but < gap elapsed → not yet stable", !s2.consider(2, { sig, cpuJiffies: null, at: 3000 }, GAP, CPU).stable);
  check("unchanged across ≥ gap → STABLE (eligible to surface)", s2.consider(2, { sig, cpuJiffies: null, at: 6000 }, GAP, CPU).stable);

  console.log("\n== Ready-gate: CPU signal (claudectl's strongest signal) ==");
  // Transcript static but the process burns CPU → still computing → not stable.
  const s3 = new StreamingSampler();
  const sig3 = transcriptSig("printed a line, still grinding", 9000);
  s3.consider(3, { sig: sig3, cpuJiffies: 0, at: 0 }, GAP, CPU);
  const rCpu = s3.consider(3, { sig: sig3, cpuJiffies: 100, at: 6000 }, GAP, CPU); // +100 jiffies / 6s ≈ 16% CPU
  check("static transcript but >5% CPU burn → NOT stable (still computing)", !rCpu.stable && rCpu.changed);
  // A near-idle process (transcript static, ~0 CPU) becomes stable.
  const s4 = new StreamingSampler();
  const sig4 = transcriptSig("done, nothing pending", 12000);
  s4.consider(4, { sig: sig4, cpuJiffies: 1000, at: 0 }, GAP, CPU);
  check("static transcript + ~idle CPU → STABLE", s4.consider(4, { sig: sig4, cpuJiffies: 1001, at: 6000 }, GAP, CPU).stable); // +1 jiffie/6s ≈ 0.2%
  eq("processTreeJiffies(null) → null (no CPU signal)", processTreeJiffies(null), null);
  eq("processTreeJiffies(absurd pid) → null", processTreeJiffies(2_000_000_000), null);

  console.log("\n== Ready-gate: 4-way classifier parse + map (WAITING_ON_SELF stays hidden) ==");
  check("WORKING → working/hidden, state WORKING", mapActivity("WORKING", "x").working && mapActivity("WORKING", "x").state === "WORKING");
  check("WAITING_ON_SELF → working/hidden (blocked on own job), state WORKING", mapActivity("WAITING_ON_SELF", "x").working && mapActivity("WAITING_ON_SELF", "x").state === "WORKING");
  check("WAITING_ON_OPERATOR → NOT working, surfaces as WAITING_INPUT", !mapActivity("WAITING_ON_OPERATOR", "x").working && mapActivity("WAITING_ON_OPERATOR", "x").state === "WAITING_INPUT");
  check("DONE → NOT working, surfaces as DONE", !mapActivity("DONE", "x").working && mapActivity("DONE", "x").state === "DONE");
  eq("parseVerdict lowercases/trims the class", parseVerdict({ state: " waiting_on_self ", reason: "r" })?.activity, "WAITING_ON_SELF");
  eq("parseVerdict('DONE') is not working (surfaces)", parseVerdict({ state: "DONE" })?.working, false);
  eq("parseVerdict(garbage) → null (degrade to heuristic)", parseVerdict({ state: "banana" }), null);
  eq("parseVerdict(null) → null", parseVerdict(null), null);
  eq("parseVerdict missing state → null", parseVerdict({ reason: "x" } as any), null);

  console.log("\n== Infra tags: pure classification (ec2/gpu chips) ==");
  eq("infraTags: instance id => ec2", JSON.stringify(infraTags("launched i-0a1b2c3d4e5f60718 in eu-west-2")), JSON.stringify(["ec2"]));
  eq("infraTags: nvidia-smi => gpu", JSON.stringify(infraTags("ssh gpubox nvidia-smi shows 8x idle")), JSON.stringify(["gpu"]));
  eq("infraTags: g5 box + CUDA => both", JSON.stringify(infraTags("aws ec2 run-instances --instance-type g5.48xlarge then CUDA init")), JSON.stringify(["ec2","gpu"]));
  eq("infraTags: plain your-repo chat => none", JSON.stringify(infraTags("update the kanban card and fix the csv export")), JSON.stringify([]));
  // Precision regressions (operator 2026-06-15: ec2/gpu chips fired on ~every session).
  eq("infraTags: injected CLAUDE.md/memory (system-reminder) => none",
    JSON.stringify(infraTags("fix the renderer bug <system-reminder>gpubox GPU server 8x RTX 5090; EC2 ASG ml-inference-asg; run nvidia-smi; CUDA; g5.48xlarge</system-reminder> done")),
    JSON.stringify([]));
  eq("infraTags: bare mention (no operation) => none",
    JSON.stringify(infraTags("the EC2 instances and the GPUs are idle right now")), JSON.stringify([]));
  eq("infraTags: meta-discussion of the chips => none",
    JSON.stringify(infraTags("PR #53: deterministic ec2/gpu infra tag chips in discover.ts")), JSON.stringify([]));
  eq("infraTags: real torchrun launch => gpu",
    JSON.stringify(infraTags("torchrun --nproc_per_node=8 -m your-repo.job_runner")), JSON.stringify(["gpu"]));
  eq("infraTags: aws autoscaling op => ec2",
    JSON.stringify(infraTags("aws autoscaling set-desired-capacity --desired-capacity 1")), JSON.stringify(["ec2"]));

  console.log("\n== Ready-gate: verifierTail strips bookkeeping lines ==");
  {
    const rawT = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Dry-run complete. Box terminated. Full report above." }] } }),
      JSON.stringify({ type: "system" }),
      JSON.stringify({ type: "last-prompt", prompt: "cointue" }),
      JSON.stringify({ type: "ai-title" }),
      JSON.stringify({ type: "bridge-session" }),
    ].join("\n");
    const ft = verifierTail(rawT);
    check("verifierTail keeps the assistant report", /Dry-run complete/.test(ft));
    check("verifierTail drops last-prompt/bridge-session/system bookkeeping (the fake 'fresh user message')",
      !/last-prompt/.test(ft) && !/bridge-session/.test(ft) && !/cointue/.test(ft));
    check("VERDICT_REV is wired into persistence (stale revisions not reused)", VERDICT_REV >= 2);
    const ejsV = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("engine(src): DB-verdict fallback checks verdict_rev", /verdict_rev === VERDICT_REV/.test(ejsV));
  }

  console.log("\n== Ready-gate: verdict-ETA parse ==");
  {
    const pv = parseVerdict({ state: "WAITING_ON_SELF", reason: "re-staging, eta stated", eta_minutes: 40 } as any);
    check("parseVerdict carries eta_minutes through (40)", pv?.etaMinutes === 40 && pv?.working === true);
    const pv2 = parseVerdict({ state: "WAITING_ON_SELF", reason: "no eta" } as any);
    check("parseVerdict leaves etaMinutes unset when absent", pv2?.etaMinutes == null);
    const pv3 = parseVerdict({ state: "DONE", reason: "x", eta_minutes: -5 } as any);
    check("parseVerdict rejects non-positive eta_minutes", pv3?.etaMinutes == null);
  }

  console.log("\n== Ready-gate: config loaded (cfg.state_gate) ==");
  check("state_gate.classifier_enabled defaults true", cfg.state_gate.classifier_enabled === true);
  check("state_gate.double_sample_gap_ms is a positive number", typeof cfg.state_gate.double_sample_gap_ms === "number" && cfg.state_gate.double_sample_gap_ms > 0);
  check("state_gate.cpu_busy_frac in (0,1]", cfg.state_gate.cpu_busy_frac > 0 && cfg.state_gate.cpu_busy_frac <= 1);
}


/** SESSION SEARCH — full-history index (head+tail extraction), keyword scoring, and the
 *  semantic (sonnet) ranking incl. every fallback path. Pure-offline: the ranker is injected. */
async function sessionSearchTests(): Promise<void> {
  console.log("\n== Session search: index build (head+tail extraction) ==");
  const base = path.join(HOME, "search-projects");
  const dir = path.join(base, "-home-op-proj");
  fs.mkdirSync(dir, { recursive: true });
  const J = (o: any) => JSON.stringify(o);
  // session A: full metadata (title + first prompt + last-prompt + cwd)
  fs.writeFileSync(path.join(dir, "aaaa-1111.jsonl"), [
    J({ type: "mode", sessionId: "aaaa-1111", mode: "x" }),
    J({ type: "user", cwd: "/home/op/proj", message: { content: [{ type: "tool_result", content: "noise" }] } }),
    J({ type: "user", message: { content: "<system>meta turn — must be skipped</system>" } }),
    J({ type: "user", message: { content: "Fix the GPU memory leak in the training pipeline" } }),
    J({ type: "ai-title", aiTitle: "Old title (superseded)" }),
    J({ type: "ai-title", aiTitle: "Fix GPU memory leak" }),
    J({ type: "last-prompt", lastPrompt: "also check the dataloader workers" }),
  ].join("\n"));
  // session B: no ai-title — falls back to first prompt only; list-content user turn
  fs.writeFileSync(path.join(dir, "bbbb-2222.jsonl"), [
    J({ type: "user", cwd: "/home/op/other", message: { content: [{ type: "text", text: "Deploy the kanban board UI tweaks" }] } }),
  ].join("\n"));
  // session C: nothing usable → excluded from the index entirely
  fs.writeFileSync(path.join(dir, "cccc-3333.jsonl"), J({ type: "user", message: { content: [{ type: "tool_result", content: "only tool noise" }] } }));
  // session D: ai-title-only STUB (what the cockpit's own `claude -p` helpers leave in the
  // neutral /tmp project dir — no cwd, no user turn). Its title paraphrases the operator's
  // task, so indexing it plants a perfect decoy; opening it fabricated a phantom $HOME card
  // (2026-06-11 vanished-task incident) → must be excluded.
  fs.writeFileSync(path.join(dir, "dddd-4444.jsonl"), J({ type: "ai-title", aiTitle: "Apply S3 streaming dataloader review fixes", sessionId: "dddd-4444" }));

  const cacheFile = path.join(HOME, "search-cache.json");
  const idx = await buildIndex(cacheFile, base);
  eq("index has exactly the 2 usable sessions", idx.length, 2);
  check("ai-title-only helper stub (no cwd, no user turn) is NOT indexed", !idx.some((e) => e.claude_session_id === "dddd-4444"));
  const a = idx.find((e) => e.claude_session_id === "aaaa-1111")!;
  check("A indexed", !!a);
  eq("A: LATEST ai-title wins", a.title, "Fix GPU memory leak");
  check("A: first prompt skips tool_result + <meta> turns", a.first.startsWith("Fix the GPU memory leak"));
  eq("A: last-prompt captured", a.last, "also check the dataloader workers");
  eq("A: cwd captured", a.cwd, "/home/op/proj");
  const b = idx.find((e) => e.claude_session_id === "bbbb-2222")!;
  check("B indexed (list-content text block)", !!b && b.first.startsWith("Deploy the kanban"));
  eq("B: no ai-title → empty title", b.title, "");
  check("mtime cache file written", fs.existsSync(cacheFile));
  const idx2 = await buildIndex(cacheFile, base);
  eq("rebuild from cache → identical entries", idx2.length, 2);

  console.log("\n== Session search: keyword scoring ==");
  const kw = keywordSearch(idx, "gpu memory");
  eq("keyword: A matches 'gpu memory'", kw.length, 1);
  eq("keyword: empty query → all (recency order)", keywordSearch(idx, "").length, 2);
  eq("keyword: no hits → empty", keywordSearch(idx, "zebra-quantum").length, 0);
  const titleBoost = keywordSearch(idx, "kanban");
  eq("keyword: body match found", titleBoost.length, 1);

  console.log("\n== Session search: semantic rank (injected ranker — no claude) ==");
  let seenPrompt = "";
  const r1 = await semanticRank(idx, "memory problems while training", {
    ranker: async (p) => { seenPrompt = p; return "[1,0]"; },
  });
  eq("semantic: via=semantic on a clean ranking", r1.via, "semantic");
  eq("semantic: returns ranked candidates in order", r1.results.length, 2);
  check("semantic: prompt embeds the query + candidates", seenPrompt.includes("memory problems") && seenPrompt.includes("[0]"));
  const r2 = await semanticRank(idx, "anything", { ranker: async () => null });
  eq("semantic: claude unavailable → keyword fallback", r2.via, "keyword-fallback");
  check("semantic: fallback carries an error reason", !!r2.error);
  const r3 = await semanticRank(idx, "anything", { ranker: async () => "I think session 3 is best!" });
  eq("semantic: unparseable output → keyword fallback", r3.via, "keyword-fallback");
  const r4 = await semanticRank(idx, "gpu", { ranker: async () => "[99]" });
  eq("semantic: out-of-range indices → keyword fallback", r4.via, "keyword-fallback");
}

async function main() {
  const db = openDb();
  const cfg = loadConfig();
  // SAFETY (incident 2026-06-10): the harness launches through a REAL SessionManager pointed at the
  // REAL kanban_repo (your-repo). loadConfig() reads the operator's live weights.json, which may have
  // kanban_auto_launch=true — so a kanban backfill test could AUTO-LAUNCH a real Claude session into
  // your-repo (it did: 50+ "Add retry with backoff" sessions). Force auto-launch OFF in the base test
  // config; the dedicated auto-launch test opts back in explicitly with a STUBBED launch spy.
  cfg.kanban_auto_launch = false;
  const sm = new SessionManager(db);
  const engine = new Engine(db, sm, cfg, { enrich: false, discover: false, pr: false, kanban: false }); // offline, deterministic
  const ctrl = new Controller(db, engine, sm, cfg);
  discoveryAdoptionTests(db);
  await sessionSearchTests();
  await teammateTests(db, engine, ctrl);

  const wtRoot = path.join(HOME, "wts");
  fs.mkdirSync(wtRoot, { recursive: true });

  // Helper: register a mock session whose cwd has a synthetic transcript.
  function mock(name: string, lines: any[], opts: any = {}, changedLines = 0): number {
    const cwd = path.join(wtRoot, name);
    if (changedLines > 0) makeRepoWithDiff(cwd, changedLines);
    else fs.mkdirSync(cwd, { recursive: true });
    writeTranscript(cwd, lines);
    return sm.register({
      repo: "/repo/demo",
      title: opts.title || name,
      worktreePath: cwd,
      branch: "cockpit/" + name,
      pid: opts.pid,
      blocksOtherWork: opts.blocks,
      deadline: opts.deadline,
    });
  }

  console.log("\n== Mock sessions in mixed states ==");
  // pid: a tool_use tail is WORKING only while the process is ALIVE (dead = stalled → surfaced);
  // the harness's own pid makes these mocks genuinely "running".
  const idWorking = mock("running-tool", [
    { role: "assistant", text: "Let me check the logs", stop_reason: "tool_use", toolUse: true },
  ], { pid: process.pid });
  const idSimple = mock(
    "waiting-port",
    [{ role: "assistant", text: "Should I bind the server to port 8080? (yes/no)" }],
    { title: "wire up server port" }
  );
  const idComplex = mock("waiting-arch", [
    {
      role: "assistant",
      text:
        "I can take three approaches to the caching layer, each with real trade-offs that affect latency and memory:\n" +
        "- Option A: in-process LRU, simplest but not shared across workers\n" +
        "- Option B: Redis, shared but adds an external dependency and ops burden\n" +
        "- Option C: memory-mapped file cache, fast and shared but more code to maintain\n" +
        "Which approach do you want me to take?",
    },
  ]);
  const idReview = mock(
    "review-refactor",
    [{ role: "assistant", text: "The refactor is ready for review — please review the diff before I open a PR." }],
    {},
    20
  );
  const idDone = mock("finished-eval", [
    { role: "assistant", text: "result: eval finished, mAP 0.91, all tests pass" },
  ]);
  const idAmbiguous = mock("ambiguous", [
    { role: "assistant", text: "Okay, noted." },
  ]);
  const idFailed = mock("blew-up", [
    { role: "assistant", text: "failed: required binary `ffmpeg` is not installed" },
  ]);
  const idMidTurn = mock("mid-toolresult", [
    { role: "assistant", text: "running", stop_reason: "tool_use", toolUse: true },
    { role: "user", toolResult: true, text: "done" },
  ], { pid: process.pid });
  // Part A: the assistant cleanly ended with a question, then the operator REPLIED (a real user
  // turn, not a tool_result). The assistant is now generating its response — that response isn't in
  // the transcript yet, so `lastAssistant` is the stale prior question. Must read as WORKING when
  // alive, not surface the old question mid-reply.
  const idReplied = mock("operator-replied", [
    { role: "assistant", text: "Should I bind the server to port 8080? (yes/no)" },
    { role: "user", text: "yes, go ahead" },
  ]);

  // ---- direct detector unit checks (incl. the live-streaming case we can't mock as a process) ----
  console.log("\n== State detector unit checks ==");
  const vWorking = parseTranscript(sm.transcriptFor(sm.list().find((s) => s.id === idWorking)!)!);
  eq("tool_use turn => WORKING", detectState({ view: vWorking, processAlive: true, msSinceWrite: 99999, quietPeriodMs: 4000 }).state, "WORKING");
  // fix(state): a tool_use tail with a DEAD process is a STALL, not work — it must surface
  // (UNKNOWN/idle), never stay hidden-as-WORKING forever.
  eq("tool_use turn + dead process => UNKNOWN (stalled, surfaced)", detectState({ view: vWorking, processAlive: false, msSinceWrite: 99999, quietPeriodMs: 4000 }).state, "UNKNOWN");
  eq(
    "alive + recent write => WORKING (streaming) even with a question",
    detectState({
      view: parseTranscript(sm.transcriptFor(sm.list().find((s) => s.id === idSimple)!)!),
      processAlive: true,
      msSinceWrite: 500,
      quietPeriodMs: 4000,
    }).state,
    "WORKING"
  );
  const dDone = detectState({ view: parseTranscript(sm.transcriptFor(sm.list().find((s) => s.id === idDone)!)!), processAlive: false, msSinceWrite: 99999, quietPeriodMs: 4000 });
  eq("result: marker => DONE", dDone.state, "DONE");

  // Part Q (2026-06-11 incident, session new-claude-session-337): a PENDING INTERACTIVE PROMPT —
  // AskUserQuestion (the arrow-key select UI) / ExitPlanMode (plan approval) — is a tool_use, so
  // the generic "tool_use ⇒ WORKING" rule hid the one state the queue most exists for: a session
  // literally asking the operator a question. These tools run nothing; pending = the dialog is on
  // screen. Must surface as WAITING_INPUT, must beat the recency rule (the prompt's own write is
  // the last write ever until answered), and must clear once answered.
  const idAskPending = mock("ask-pending", [
    { role: "assistant", text: "Two ways to take this fix.", stop_reason: "tool_use" },
    { role: "assistant", stop_reason: "tool_use", toolUse: true, toolName: "AskUserQuestion", toolId: "q1" },
  ], { pid: process.pid });
  const vAskPending = parseTranscript(sm.transcriptFor(sm.list().find((s) => s.id === idAskPending)!)!);
  const dAskPending = detectState({ view: vAskPending, processAlive: true, msSinceWrite: 99999, quietPeriodMs: 4000 });
  eq("Part Q: pending AskUserQuestion + alive => WAITING_INPUT (never WORKING)", dAskPending.state, "WAITING_INPUT");
  check("Part Q: the detector flags the interactive prompt (engine bypasses the model on it)", dAskPending.interactivePrompt === "AskUserQuestion");
  eq("Part Q: pending AskUserQuestion beats the recency rule (just written => still a question)",
    detectState({ view: vAskPending, processAlive: true, msSinceWrite: 100, quietPeriodMs: 4000 }).state, "WAITING_INPUT");
  const idAskAnswered = mock("ask-answered", [
    { role: "assistant", stop_reason: "tool_use", toolUse: true, toolName: "AskUserQuestion", toolId: "q1" },
    { role: "user", toolResult: true, toolId: "q1", text: "Your questions have been answered: option A" },
  ], { pid: process.pid });
  eq("Part Q: answered AskUserQuestion + alive => WORKING (assistant continuing)",
    detectState({ view: parseTranscript(sm.transcriptFor(sm.list().find((s) => s.id === idAskAnswered)!)!), processAlive: true, msSinceWrite: 99999, quietPeriodMs: 4000 }).state, "WORKING");
  const idAskSibling = mock("ask-pending-sibling", [
    { role: "assistant", stop_reason: "tool_use", toolUse: true, toolName: "AskUserQuestion", toolId: "q1" },
    { role: "assistant", stop_reason: "tool_use", toolUse: true, toolName: "Bash", toolId: "b1" },
    { role: "user", toolResult: true, toolId: "b1", text: "clean" },
  ], { pid: process.pid });
  eq("Part Q: a trailing sibling tool_result must not mask the still-open question",
    detectState({ view: parseTranscript(sm.transcriptFor(sm.list().find((s) => s.id === idAskSibling)!)!), processAlive: true, msSinceWrite: 99999, quietPeriodMs: 4000 }).state, "WAITING_INPUT");
  const idPlanPending = mock("plan-pending", [
    { role: "assistant", stop_reason: "tool_use", toolUse: true, toolName: "ExitPlanMode", toolId: "p1" },
  ], { pid: process.pid });
  eq("Part Q: pending ExitPlanMode (plan approval) => WAITING_INPUT",
    detectState({ view: parseTranscript(sm.transcriptFor(sm.list().find((s) => s.id === idPlanPending)!)!), processAlive: true, msSinceWrite: 99999, quietPeriodMs: 4000 }).state, "WAITING_INPUT");
  {
    // src-wiring: the engine surfaces a stable interactive prompt WITHOUT a model verdict (a
    // stochastic WORKING verdict must never hide a session that is literally asking), and the
    // Layer-2 prompt carries the AskUserQuestion/ExitPlanMode exception for every other path.
    const ejsQ = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("Part Q(src): engine bypasses the classifier on detected.interactivePrompt", /detected\.interactivePrompt/.test(ejsQ) && /DETERMINISTIC SURFACE/.test(ejsQ));
    const wvQ = fs.readFileSync(path.resolve(__dirname, "../../src/core/workingVerifier.ts"), "utf8");
    check("Part Q(src): classifier prompt teaches the interactive-prompt exception", /AskUserQuestion/.test(wvQ) && /ExitPlanMode/.test(wvQ) && /WAITING_ON_OPERATOR/.test(wvQ));
  }

  // Part A: trailing REAL operator reply + process alive => WORKING (assistant is responding now),
  // even though the recency window has long passed and the prior turn was a question.
  const vReplied = parseTranscript(sm.transcriptFor(sm.list().find((s) => s.id === idReplied)!)!);
  eq("Part A: operator just replied + alive => WORKING (not the stale prior question)",
    detectState({ view: vReplied, processAlive: true, msSinceWrite: 99999, quietPeriodMs: 4000 }).state, "WORKING");
  eq("Part A: same trailing reply but process DEAD => falls through (not hidden as working)",
    detectState({ view: vReplied, processAlive: false, msSinceWrite: 99999, quietPeriodMs: 4000 }).state, "WAITING_INPUT");

  // Part B: the PRE-SURFACE streaming guard — an LLM (Haiku) reads the output before a candidate
  // enters Up Next; if it's still streaming we defer it. The live branch needs a model, so the
  // offline harness can't exercise it directly (offline mode BYPASSES it — which is exactly why
  // every surface assertion further down still holds); these verify the wiring, eta(src)-style.
  {
    const ejsMain = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("Part B(src): reverse guard gated to online mode (enrich !== false)", /this\.opts\.enrich !== false &&/.test(ejsMain));
    check("Part B(src): guard fires for EVERY alive candidate — no recency window (the verdict, not the clock, decides)", /detected\.processAlive && detected\.view\n/.test(ejsMain) && !/msSinceWrite < this\.gateWindowMs\(\) \|\| !!paneFlag\)/.test(ejsMain));
    check("Part B(src): model-down self-bound — classifier fail-open surfaces the stable heuristic state", /gateFailOpenAttempts\(\)/.test(ejsMain) && /verifyFailures/.test(ejsMain) && /classifier fail-open/.test(ejsMain));
    check("Part B(src): WAITING_ON_SELF honors a TTL so a silent self-waiter eventually resurfaces as idle", /gateSelfWaitTtlMs\(\)/.test(ejsMain) && /self-wait quiet/.test(ejsMain));
    check("Part B(src): the gate model is config-driven and defaults to sonnet", /gateModel\(\): string \{ return this\.cfg\.state_gate\?\.model \|\| "sonnet"/.test(ejsMain) && /verifyWorking\(view, this\.gateModel\(\)\)/.test(ejsMain));
    check("Part B(src): liveness counts a discovered live pane (pid-less) as alive", /this\.sessions\.processAlive\(s\) \|\| s\.is_live_pane === 1/.test(ejsMain));
    check("Part B(src): an idle babysit/waiting-flagged session is HELD OUT of Up Next (flagHold)", /flagHold = state === "UNKNOWN" && !!paneFlag/.test(ejsMain));
    // LAYER 1 — the FREE double-sample runs BEFORE the model and defers anything still moving.
    check("Part B(src): double-sample runs before the model (this.sampler.consider)", /this\.sampler\.consider\(/.test(ejsMain));
    check("Part B(src): an un-stable double-sample keeps it WORKING (no model call)", /deferred \(double-sample\)/.test(ejsMain));
    // LAYER 2 — the Haiku final gate, only on a stable candidate.
    check("Part B(src): a confirmed-streaming verdict keeps it WORKING (out of Up Next)", /verified streaming/.test(ejsMain));
    check("Part B(src): a WAITING_ON_SELF verdict keeps it hidden (blocked on its own job)", /verified waiting-on-self/.test(ejsMain) && /activity === "WAITING_ON_SELF"/.test(ejsMain));
    check("Part B(src): a PENDING verdict defers one tick (conservative)", /deferred: awaiting streaming-check/.test(ejsMain));
    check("Part B(src): the gate cadence is config-driven (cfg.state_gate)", /this\.cfg\.state_gate/.test(ejsMain));
  }

  // ---- run the pipeline ----
  console.log("\n== Engine tick (full pipeline) ==");
  const tick = await engine.tick();
  console.log("  tick:", JSON.stringify(tick));

  const queue = engine.queue();
  const surfacedIds = new Set(queue.map((q) => q.session_id));

  console.log("\n== Cheap rerank (quick-action path, no heavy tick) ==");
  {
    const before = engine.queue().map((q) => ({ id: q.id, p: q.priority }));
    check("engine.rerank() exists (cheap re-sort, no discovery/enrich)", typeof (engine as any).rerank === "function");
    // snoozing applies a score penalty; a cheap rerank (NOT a full tick) must reflect it
    const top = engine.queue()[0];
    if (top) {
      ctrl.snooze(top.id);
      (engine as any).rerank();
      const after = engine.queue();
      const moved = after.findIndex((q) => q.id === top.id);
      check("rerank re-sorts a snoozed item DOWN without a full tick", moved !== 0 || after.length === 1, `pos=${moved}`);
    }
    // server wiring: quick endpoints must NOT await the heavy tick
    const srv = fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8");
    const quickBlock = srv.slice(srv.indexOf('"/api/snooze"'), srv.indexOf('"/api/feedback"') + 200);
    check("quick endpoints use quickRerank, not await tickLoop", quickBlock.includes("quickRerank()") && !quickBlock.includes("await tickLoop()"));
  }

  console.log("\n== SURFACING POLICY (FIX W): hide only actively-WORKING; idle surfaces LOW ==");
  check("WORKING (tool_use) NOT surfaced", !surfacedIds.has(idWorking));
  check("WORKING (awaiting tool_result continuation) NOT surfaced", !surfacedIds.has(idMidTurn));
  // FIX W: an ambiguous cleanly-ended turn is now IDLE and SURFACED (at low prio), not hidden.
  check("AMBIGUOUS/idle (no marker, no question) IS surfaced (FIX W)", surfacedIds.has(idAmbiguous));
  check("WAITING surfaced", surfacedIds.has(idSimple));
  check("DONE surfaced", surfacedIds.has(idDone));
  check("FAILED surfaced as done/FYI", surfacedIds.has(idFailed));

  console.log("\n== Triage routing ==");
  const cat = (sid: number) => queue.find((q) => q.session_id === sid)?.category;
  eq("port question => SIMPLE_QUESTION", cat(idSimple), "SIMPLE_QUESTION");
  eq("arch options => COMPLEX_DECISION", cat(idComplex), "COMPLEX_DECISION");
  eq("review + diff => REVIEW_DIFF", cat(idReview), "REVIEW_DIFF");
  eq("result marker => FYI_DONE", cat(idDone), "FYI_DONE");
  eq("failed marker => FYI_DONE", cat(idFailed), "FYI_DONE");

  console.log("\n== Priority: blocks_other_work outranks ==");
  // Give the complex one the blocks flag and re-tick; it should rise (or hold) vs its prior
  // rank. (Assert relative movement, not an absolute slot — the queue size varies with which
  // mock sessions are WAITING, so an absolute <=1 is flaky; the blocks BOOST is the real claim.)
  const preComplexRank = engine.queue().findIndex((q) => q.session_id === idComplex);
  db.prepare("UPDATE sessions SET blocks_other_work=1 WHERE id=?").run(idComplex);
  engine.rerank(); // operator-flag change → cheap re-rank (the real path; a heavy tick would now
                   // SKIP these already-in-Up-Next items under the lock, by design).
  let q2 = engine.queue();
  const complexRank = q2.findIndex((q) => q.session_id === idComplex);
  check("blocked-work item rises toward the top", complexRank >= 0 && complexRank <= Math.max(1, preComplexRank), `pre=${preComplexRank} now=${complexRank}`);
  // transparency: breakdown explains why
  const complexItem = q2.find((q) => q.session_id === idComplex)!;
  check(
    "score breakdown is inspectable + blocks term present",
    complexItem.score_breakdown.breakdown.some((t: any) => t.signal === "blocks_other_work" && t.contribution > 0)
  );

  console.log("\n== Focus biases ranking ==");
  ctrl.setFocus("server port");
  engine.rerank(); // re-rank with the new focus (real path; locked Up-Next items skip the tick).
  const q3 = engine.queue();
  const simpleItem = q3.find((q) => q.session_id === idSimple)!;
  check(
    "focus_match term contributes for the matching session",
    simpleItem.score_breakdown.breakdown.some((t: any) => t.signal === "focus_match" && t.contribution > 0)
  );

  console.log("\n== Feedback shifts weights + re-ranks ==");
  const reviewItem = q3.find((q) => q.session_id === idReview)!;
  const beforePri = reviewItem.priority;
  // "priority too high" three times on REVIEW_DIFF -> category nudged down
  for (let i = 0; i < 3; i++) ctrl.feedback(reviewItem.id, "priority_high");
  const adjAfter = allAdjustments(db).find((a) => a.key === "category:REVIEW_DIFF");
  check("REVIEW_DIFF adjustment went negative", !!adjAfter && adjAfter.adjustment < 0, JSON.stringify(adjAfter));
  engine.rerank(); // feedback re-ranks via quickRerank in production, not a heavy tick.
  const q4 = engine.queue();
  const reviewAfter = q4.find((q) => q.session_id === idReview)!;
  check("review item priority dropped after 'too high' feedback", reviewAfter.priority < beforePri, `${reviewAfter.priority} < ${beforePri}`);

  // opposite direction on SIMPLE_QUESTION
  const simpleBefore = q4.find((q) => q.session_id === idSimple)!.priority;
  for (let i = 0; i < 3; i++) ctrl.feedback(simpleItem.id, "priority_low");
  engine.rerank();
  const simpleAfter = engine.queue().find((q) => q.session_id === idSimple)!.priority;
  check("simple item priority rose after 'too low' feedback", simpleAfter > simpleBefore, `${simpleAfter} > ${simpleBefore}`);

  console.log("\n== View-default learning ==");
  // operator repeatedly wants raw for COMPLEX_DECISION
  const complexId = engine.queue().find((q) => q.session_id === idComplex)!.id;
  ctrl.feedback(complexId, "wrong");
  ctrl.feedback(complexId, "wrong");
  await engine.tick();
  const complexView = engine.queue().find((q) => q.session_id === idComplex)!.default_view;
  eq("COMPLEX_DECISION now defaults to raw after repeated 'wrong'", complexView, "raw");

  console.log("\n== Keyboard controller loop (headless) ==");
  // snapshot
  const st = ctrl.state();
  check("state() exposes a single 'next' recommendation", !!st.next);
  check("queue has the surfaced items", st.queue.length >= 4);
  // expand-to-raw works
  const rawTop = ctrl.rawTranscript(st.next!.id);
  check("expand-to-raw returns transcript text", rawTop.length > 0);
  // snooze = score penalty (sinks but STAYS VISIBLE), not a time-hide.
  // Reset any penalty left by the earlier quick-action snooze test so this section (and the
  // decay tests below) measure from a clean, NATURAL baseline.
  db.prepare("UPDATE sessions SET snooze_penalty=0, snoozed_at=NULL").run();
  engine.rerank();
  const stSnz = ctrl.state();
  const snoozeTarget = stSnz.queue[0].id;
  const snoozePriBefore = stSnz.queue[0].priority;
  ctrl.snooze(snoozeTarget, 120);
  engine.rerank(); // recompute scores with the new penalty (quickRerank path; a tick would now
                   // SKIP this already-in-Up-Next item under the lock).
  const snoozedNow = engine.queue().find((q) => q.id === snoozeTarget);
  check("snoozed item STAYS in the queue (not hidden)", !!snoozedNow, "missing");
  check(`snoozed item priority dropped by ~penalty (${cfg.snooze_penalty})`, !!snoozedNow && snoozedNow.priority <= snoozePriBefore + cfg.snooze_penalty + 10, `${snoozePriBefore} -> ${snoozedNow?.priority}`);
  check("snoozed item shows the snooze_penalty on its session", !!snoozedNow && snoozedNow.session.snooze_penalty < 0, `${snoozedNow?.session.snooze_penalty}`);

  console.log("\n== Snooze decay: starts -penalty below natural rank, climbs back LINEARLY over recover_hours ==");
  {
    const { effectiveSnoozePenalty } = require("../core/priority");
    const H = 3.6e6;
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * H).toISOString();
    eq("decay(unit): fresh snooze = full penalty", effectiveSnoozePenalty(-100, at(0), 5, now), -100);
    eq("decay(unit): 2.5h in = half recovered", effectiveSnoozePenalty(-100, at(2.5), 5, now), -50);
    eq("decay(unit): 4h in = 80% recovered", effectiveSnoozePenalty(-100, at(4), 5, now), -20);
    eq("decay(unit): 5h in = fully recovered", effectiveSnoozePenalty(-100, at(5), 5, now), 0);
    eq("decay(unit): way past the window stays 0", effectiveSnoozePenalty(-100, at(48), 5, now), 0);
    eq("decay(unit): legacy un-stamped snooze counts as recovered", effectiveSnoozePenalty(-100, null, 5, now), 0);
    check(
      "decay(unit): strictly climbs over time",
      effectiveSnoozePenalty(-100, at(1), 5, now) < effectiveSnoozePenalty(-100, at(4), 5, now) &&
        effectiveSnoozePenalty(-100, at(4), 5, now) < 0
    );

    // --- end-to-end on the item snoozed above (it is ALREADY in the queue → exactly the
    // "reprioritization of a queued task" path the decay must drive without bugs) ---
    const sid = snoozedNow!.session_id;
    const recoverH = cfg.snooze_recover_hours;
    const sRow0 = db.prepare("SELECT snooze_penalty, snoozed_at FROM sessions WHERE id=?").get(sid) as any;
    eq("snooze stores the full configured penalty", sRow0.snooze_penalty, cfg.snooze_penalty);
    check("snooze stamps the decay clock (snoozed_at)", !!sRow0.snoozed_at, JSON.stringify(sRow0));

    // REWIND the stamp 60% through the recovery window → ~40% of the penalty should remain.
    db.prepare("UPDATE sessions SET snoozed_at=? WHERE id=?").run(at(0.6 * recoverH), sid);
    const nMid = engine.snoozeDecayTick(true);
    check("decay tick re-scored the snoozed item (lock exemption works)", nMid >= 1, `${nMid}`);
    const mid = engine.queue().find((q) => q.id === snoozeTarget)!;
    const expectMid = snoozePriBefore + 0.4 * cfg.snooze_penalty;
    check("60% through recovery ~40% of the penalty remains (priority climbed)", Math.abs(mid.priority - expectMid) <= 3, `pri=${mid.priority} expect≈${Math.round(expectMid)}`);
    check("mid-decay priority is ABOVE the freshly-snoozed value", mid.priority > snoozedNow!.priority, `${mid.priority} > ${snoozedNow!.priority}`);
    check("mid-decay priority is still BELOW the natural value", mid.priority < snoozePriBefore, `${mid.priority} < ${snoozePriBefore}`);
    check(
      "breakdown shows the decaying snooze term transparently",
      (mid.score_breakdown.breakdown || []).some((t: any) => t.signal === "snoozed" && t.contribution > cfg.snooze_penalty && t.contribution < 0),
      JSON.stringify((mid.score_breakdown.breakdown || []).find((t: any) => t.signal === "snoozed"))
    );

    // A quick-action rerank() while the item sits in the queue must AGREE with the decayed value
    // (no double-apply, no clock reset).
    engine.rerank();
    const reranked = engine.queue().find((q) => q.id === snoozeTarget)!;
    check("rerank() of a queued snoozed item agrees with the decayed value (no double-apply)", Math.abs(reranked.priority - mid.priority) <= 1, `${reranked.priority} vs ${mid.priority}`);
    const stampAfterRerank = (db.prepare("SELECT snoozed_at FROM sessions WHERE id=?").get(sid) as any).snoozed_at;
    eq("rerank() never restarts the decay clock", stampAfterRerank, at(0.6 * recoverH));

    // FULL RECOVERY: rewind past the window → the decay tick restores the natural priority AND
    // clears the stored penalty so the session is permanently back to normal.
    db.prepare("UPDATE sessions SET snoozed_at=? WHERE id=?").run(at(recoverH + 1), sid);
    engine.snoozeDecayTick(true);
    const recovered = engine.queue().find((q) => q.id === snoozeTarget)!;
    check("fully recovered: back at its natural priority (same prio as before the snooze)", Math.abs(recovered.priority - snoozePriBefore) <= 1, `${recovered.priority} vs ${snoozePriBefore}`);
    const sAfter = db.prepare("SELECT snooze_penalty, snoozed_at FROM sessions WHERE id=?").get(sid) as any;
    eq("stored penalty cleared after full recovery", sAfter.snooze_penalty, 0);
    check("decay stamp cleared after full recovery", sAfter.snoozed_at == null, `${sAfter.snoozed_at}`);

    // RE-SNOOZE after recovery starts again at exactly one full step; undo restores BOTH fields.
    ctrl.snooze(snoozeTarget);
    const sRe = db.prepare("SELECT snooze_penalty, snoozed_at FROM sessions WHERE id=?").get(sid) as any;
    eq("re-snooze after recovery starts at one full step again", sRe.snooze_penalty, cfg.snooze_penalty);
    check("re-snooze restarts the decay clock", !!sRe.snoozed_at);
    ctrl.undo();
    const sUndo = db.prepare("SELECT snooze_penalty, snoozed_at FROM sessions WHERE id=?").get(sid) as any;
    eq("undo restores the prior (cleared) penalty", sUndo.snooze_penalty, 0);
    check("undo restores the prior (cleared) decay stamp", sUndo.snoozed_at == null, `${sUndo.snoozed_at}`);

    // STACKING mid-decay: snooze, rewind half-way, snooze again → one full step from the DECAYED
    // value (-50 + -100 = -150), and a fresh clock.
    ctrl.snooze(snoozeTarget);
    db.prepare("UPDATE sessions SET snoozed_at=? WHERE id=?").run(at(recoverH / 2), sid);
    ctrl.snooze(snoozeTarget);
    const sStack = db.prepare("SELECT snooze_penalty, snoozed_at FROM sessions WHERE id=?").get(sid) as any;
    eq("re-snooze mid-decay stacks from the DECAYED value", sStack.snooze_penalty, Math.round(cfg.snooze_penalty / 2) + cfg.snooze_penalty);
    const stackStampMs = Date.parse(sStack.snoozed_at);
    check("re-snooze mid-decay restarts the clock at ~now", Math.abs(Date.now() - stackStampMs) < 10_000, sStack.snoozed_at);
    // clean up: undo both snoozes so later harness sections see the original state
    ctrl.undo();
    ctrl.undo();
    engine.rerank();
  }
  // ack an FYI_DONE clears it
  const doneItem = engine.queue().find((q) => q.session_id === idDone);
  if (doneItem) {
    ctrl.ack(doneItem.id);
    check("acked done item leaves queue", !engine.queue().some((q) => q.id === doneItem.id));
  }
  // master+Enter dismiss: marks an item decided('done') without sending, undoable
  {
    const d = engine.queue()[0];
    if (d) {
      ctrl.dismiss(d.id);
      check("dismiss removes the item from Up Next (decided)", !engine.queue().some((q) => q.id === d.id));
      ctrl.undo();
      check("undo restores a dismissed item to pending", engine.queue().some((q) => q.id === d.id));
    }
  }
  // sendAnswer marks decided (no tmux in test -> ok=false but status advances)
  const ans = engine.queue().find((q) => q.category === "SIMPLE_QUESTION" || q.category === "COMPLEX_DECISION");
  if (ans) {
    ctrl.sendAnswer(ans.id, "Yes, use 8080");
    check("sent item leaves pending queue (decided)", !engine.queue().some((q) => q.id === ans.id));
  }

  console.log("\n== Idempotency / dedup ==");
  const before = (db.prepare("SELECT COUNT(*) c FROM items").get() as any).c;
  await engine.tick();
  await engine.tick();
  const after = (db.prepare("SELECT COUNT(*) c FROM items").get() as any).c;
  eq("re-ticking does not duplicate items", after, before);

  console.log("\n== LLM importance term in scoring ==");
  {
    const { scoreItem } = require("../core/priority");
    const base = scoreItem({ weights: cfg.weights, importance: -1, blocksOtherWork: false, changedLines: 0, ageHours: 0, focusMatch: 0, deadline: null, state: "WAITING_INPUT", category: "SIMPLE_QUESTION", learnedTerms: [] });
    const hi = scoreItem({ weights: cfg.weights, importance: 90, blocksOtherWork: false, changedLines: 0, ageHours: 0, focusMatch: 0, deadline: null, state: "WAITING_INPUT", category: "SIMPLE_QUESTION", learnedTerms: [] });
    check("importance term present when judged", hi.breakdown.some((t: any) => t.signal === "llm_importance"));
    check("higher importance => higher score", hi.score > base.score, `${hi.score} > ${base.score}`);
  }

  console.log("\n== Nightly dream re-tunes from feedback (incl. snooze) ==");
  {
    const { dream, lastDreams } = require("../core/dream");
    // snooze a REVIEW_DIFF a few times to create an over-ranked signal
    const rev = engine.queue().find((q) => q.category === "REVIEW_DIFF");
    if (rev) for (let i = 0; i < 3; i++) ctrl.snooze(rev.id, 1);
    const r = dream(db);
    check("dream writes a summary", typeof r.summary === "string" && r.summary.length > 0);
    check("dream_log has an entry", lastDreams(db, 1).length === 1);
    check("dream produced at least one change", r.changes.length >= 1, JSON.stringify(r.changes));
  }

  console.log("\n== Reasoned feedback teaches FAR harder than a silent pick ==");
  {
    const cfg = require("../core/config").loadConfig();
    check("config: implicit < direction < reason learn-weights", cfg.implicit_learn_weight < cfg.direction_learn_weight && cfg.direction_learn_weight < cfg.reason_learn_weight, `${cfg.implicit_learn_weight} / ${cfg.direction_learn_weight} / ${cfg.reason_learn_weight}`);
    check("config: a SILENT pick teaches very little (implicit_learn_weight ≤ 0.5)", cfg.implicit_learn_weight <= 0.5, String(cfg.implicit_learn_weight));
    check("config: a TYPED REASON teaches a lot (reason_learn_weight ≥ 5)", cfg.reason_learn_weight >= 5, String(cfg.reason_learn_weight));
    const it = engine.queue()[0];
    if (it) {
      const a = ctrl.reasonFeedback(it.id, "down", ""); // bare up/down, no reason
      const exA: any = db.prepare("SELECT weight, reason FROM training_examples WHERE id=?").get(Number(a.exampleId));
      check("bare up/down feedback is stored at direction_learn_weight", exA && exA.weight === cfg.direction_learn_weight, JSON.stringify(exA));
      const b = ctrl.reasonFeedback(it.id, "down", "I don't want this now because prod is on fire"); // typed reason
      const exB: any = db.prepare("SELECT weight, reason FROM training_examples WHERE id=?").get(Number(b.exampleId));
      check("typed-reason feedback is stored at reason_learn_weight (≫ a bare nudge)", exB && exB.weight === cfg.reason_learn_weight && exB.weight > exA.weight, JSON.stringify(exB));
      check("the typed reason itself is persisted with the example", exB && /prod is on fire/.test(exB.reason || ""));
    }
    const dsrc = fs.readFileSync(path.resolve(__dirname, "../../src/core/dream.ts"), "utf8");
    check("dream reads implicit_learn_weight from config (default 0.1)", /implicitW = c\.implicit_learn_weight \?\? 0\.1/.test(dsrc));
    check("dream scales a SILENT leapfrog pick by implicit_learn_weight (learns little)", /add\(k, implicitW \* lr \* /.test(dsrc));
    check("dream scales a SILENT snooze by implicit_learn_weight", /add\(k, -implicitW \* lr \* /.test(dsrc));
  }

  console.log("\n== Auto-discovery registers recent sessions ==");
  {
    const os = require("os");
    const proj = path.join(os.homedir(), ".claude", "projects");
    const realCwd = path.join(HOME, "discovered-repo");
    fs.mkdirSync(realCwd, { recursive: true });
    const encoded = realCwd.replace(/[/.]/g, "-");
    const pdir = path.join(proj, encoded);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(
      path.join(pdir, "s.jsonl"),
      JSON.stringify({ type: "user", timestamp: "2026-06-06T10:00:00Z", cwd: realCwd, message: { role: "user", content: [{ type: "text", text: "Investigate the slow dataloader" }] } }) + "\n"
    );
    const { discoverRecentSessions } = require("../core/discover");
    const seen = await discoverRecentSessions(db, sm, 20);
    check("discovery saw the synthetic session", seen >= 1, `seen=${seen}`);
    const found = sm.list().find((x) => x.worktree_path === realCwd);
    check("discovered session registered with title from first prompt", !!found && found.title.includes("dataloader"), found && found.title);
    check("discovered session flagged discovered=1", !!found && (found as any).discovered === 1);

    // NOISE FILTER: orchestration/ephemeral cwds + build/test-probe prompts are NOT surfaced.
    const mkTranscript = (cwd: string, prompt: string, name: string) => {
      fs.mkdirSync(cwd, { recursive: true });
      const enc = (name + cwd).replace(/[/.]/g, "-");
      const d = path.join(HOME, ".claude", "projects", enc);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, name + ".jsonl"),
        JSON.stringify({ type: "user", timestamp: "2026-06-07T10:00:00Z", cwd, message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\n");
    };
    const jobCwd = path.join(HOME, ".claude", "jobs", "job-123");
    mkTranscript(jobCwd, "Investigate something real", "jobnoise");
    const buildCwd = path.join(HOME, "build-task-repo");
    mkTranscript(buildCwd, "Use ultrathink. Start coding now and build this cockpit feature", "buildnoise");
    const probeCwd = path.join(HOME, "probe-repo");
    mkTranscript(probeCwd, "Say: result: 42", "probenoise");
    sm.list().forEach(() => {});
    await discoverRecentSessions(db, sm, 50);
    const list = sm.list();
    check("orchestration cwd (~/.claude/jobs) excluded from discovery", !list.some((x) => x.worktree_path === jobCwd));
    check("build-prompt session excluded from discovery", !list.some((x) => x.worktree_path === buildCwd));
    check("test-probe prompt session excluded from discovery", !list.some((x) => x.worktree_path === probeCwd));
  }

  console.log("\n== Manual importance override + pinning reorder ==");
  {
    // two fresh waiting sessions so the test is independent of earlier queue draining.
    const idA = mock("manual-a", [{ role: "assistant", text: "Should I use 8081? (yes/no)" }], { title: "manual A" });
    const idB = mock("manual-b", [{ role: "assistant", text: "Should I use 8082? (yes/no)" }], { title: "manual B" });
    await engine.tick();
    const aBefore = engine.queue().find((x) => x.session_id === idA)!.priority;
    ctrl.setManualImportance(idA, 100);
    engine.rerank(); // manualImportance → quickRerank in production (locked items skip the tick).
    const aAfter = engine.queue().find((x) => x.session_id === idA)!;
    check("manual importance raises priority", aAfter.priority > aBefore, `${aAfter.priority} > ${aBefore}`);
    check(
      "manual_importance term present + overrides (no llm_importance term)",
      aAfter.score_breakdown.breakdown.some((t: any) => t.signal === "manual_importance") &&
        !aAfter.score_breakdown.breakdown.some((t: any) => t.signal === "llm_importance")
    );

    // pin B; it must jump to the very top despite A's max manual importance.
    ctrl.setPinned(idB, true);
    engine.rerank(); // pin → quickRerank in production.
    const top = engine.queue()[0];
    check("pinned item is #1 in the queue", top.session_id === idB, `top=${top.session_id} pinned=${idB}`);
    check("pinned term present in breakdown", top.score_breakdown.breakdown.some((t: any) => t.signal === "pinned"));
    // unpin restores ordering (pinned no longer forced to top)
    ctrl.setPinned(idB, false);
    engine.rerank();
    check("unpinned item no longer forced to #1 (no pin term)", !engine.queue()[0].score_breakdown.breakdown.some((t: any) => t.signal === "pinned"));
    // clean up override so later assertions are unaffected (snooze no longer hides, so
    // ack them out of the pending queue instead)
    ctrl.setManualImportance(idA, null);
    const ackOut = (sid: number) => { const q = engine.queue().find((x) => x.session_id === sid); if (q) ctrl.ack(q.id); };
    ackOut(idA);
    ackOut(idB);
  }

  console.log("\n== Manual score is ABSOLUTE (the typed number IS the priority score) ==");
  {
    const { scoreItem, PIN_BASE } = require("../core/priority");
    // Hostile inputs: every organic signal firing (idle base, staleness, focus, blocking,
    // judged importance) PLUS a large negative learned adjustment — none may move the score.
    const base = {
      weights: cfg.weights, importance: 90, blocksOtherWork: true, changedLines: 0,
      ageHours: 48, focusMatch: 1, deadline: null, state: "UNKNOWN" as any, category: "SIMPLE_QUESTION" as any,
      learnedTerms: [{ key: "category:SIMPLE_QUESTION", adjustment: -120 }],
    };
    const r = scoreItem({ ...base, manualImportance: 100 });
    eq("manual 100 scores EXACTLY 100 (organic + learned ignored)", r.score, 100);
    check("breakdown is ONLY the manual term", r.breakdown.length === 1 && r.breakdown[0].signal === "manual_importance", JSON.stringify(r.breakdown.map((t: any) => t.signal)));
    eq("unapplied learned terms are NOT echoed in the result", r.learned.length, 0);
    eq("manual 0 scores exactly 0 (0 is a valid override, not 'unset')", scoreItem({ ...base, manualImportance: 0 }).score, 0);
    // explicit operator gestures still stack on top — by design (snooze needs its decay stamp;
    // a fresh stamp = full penalty applied)
    eq("snooze still sinks a manually scored item", scoreItem({ ...base, manualImportance: 100, snoozePenalty: -40, snoozedAt: new Date().toISOString() }).score, 60);
    eq("an un-stamped (legacy) snooze penalty no longer applies (counts as recovered)", scoreItem({ ...base, manualImportance: 100, snoozePenalty: -40 }).score, 100);
    eq("h/l nudge still applies on top of a manual score", scoreItem({ ...base, manualImportance: 100, manualPriorityDelta: -90 }).score, 10);
    eq("pin still forces a manually scored item above everything", scoreItem({ ...base, manualImportance: 100, pinned: true }).score, 100 + PIN_BASE);
    // no override → the organic path is untouched
    const organic = scoreItem({ ...base, manualImportance: null });
    check("no manual score → organic terms present (llm_importance)", organic.breakdown.some((t: any) => t.signal === "llm_importance"));
    check("no manual score → learned terms echoed", organic.learned.length === 1);
  }

  // ── QUICK-PROMPT PRIORITY (Ctrl+Enter): newSession(kind, prompt, importance) must write that
  // importance straight onto the new session's row at launch, clamped 0–100, with "none" (null)
  // when omitted. This is the BEHAVIORAL guard behind quick_prompt_test.ts's source-shape checks —
  // a refactor that drops the importance write fails HERE, not just on a regex.
  //
  // Each scenario runs on a FRESH db + DEMO SessionManager (launch = a plain row insert, no
  // tmux/claude). Fresh-per-case matters: in demo mode every claude launch dedups onto ONE row
  // (worktree path is derived from a constant baseTitle), so a shared db can't observe the
  // null-default. A new db → the launch is the first row → faithful. ───────────────────────────────
  console.log("\n== Quick-prompt priority: newSession writes a launch-time manual importance ==");
  {
    let qpN = 0;
    // Launch one claude session with the given importance on a pristine db; return what landed on the row.
    const launchedImp = (importance?: number | null): number | null | undefined => {
      const tdb = openDb(path.join(HOME, `qp-prio-${++qpN}.db`));
      const tsm = new SessionManager(tdb, true);
      const teng = new Engine(tdb, tsm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
      const tctrl = new Controller(tdb, teng, tsm, cfg, true);
      const r = importance === undefined ? tctrl.newSession("claude", "task text") : tctrl.newSession("claude", "task text", importance);
      check(`newSession → ok + numeric id (imp=${importance})`, r.ok && typeof r.sessionId === "number");
      return r.sessionId == null ? undefined : getSession(tdb, r.sessionId)?.manual_importance;
    };

    eq("importance=73 is written to the new session row", launchedImp(73), 73);
    eq("omitted importance leaves the row at none (null)", launchedImp(), null);
    eq("explicit null importance is none (null)", launchedImp(null), null);
    eq("importance above 100 clamps to 100", launchedImp(250), 100);
    eq("importance below 0 clamps to 0 (0 is a valid override, not 'unset')", launchedImp(-5), 0);
    eq("a fractional importance rounds to an int", launchedImp(42.6), 43);
    eq("importance 0 is a real override (not treated as 'none')", launchedImp(0), 0);
  }

  console.log("\n== Setting a manual score CLEARS stale h/l nudges (set 100 must never show 10) ==");
  {
    const idC = mock("manual-abs", [{ role: "assistant", text: "Which port should I use? (yes/no)" }], { title: "manual absolute" });
    await engine.tick();
    // simulate old 'l' presses accumulated BEFORE the operator types an exact score
    db.prepare("UPDATE sessions SET manual_priority_delta=-90 WHERE id=?").run(idC);
    ctrl.setManualImportance(idC, 100);
    engine.rerank();
    const c = engine.queue().find((x) => x.session_id === idC)!;
    eq("queue priority == the typed score, exactly", c.priority, 100);
    const row: any = db.prepare("SELECT manual_priority_delta FROM sessions WHERE id=?").get(idC);
    eq("stale manual_priority_delta wiped by the set", row.manual_priority_delta || 0, 0);
    // undo restores BOTH fields (the score AND the wiped delta)
    ctrl.undo();
    const row2: any = db.prepare("SELECT manual_importance, manual_priority_delta FROM sessions WHERE id=?").get(idC);
    eq("undo restores the previous h/l delta", row2.manual_priority_delta, -90);
    check("undo restores the previous manual importance (was unset)", row2.manual_importance == null);
    // clean up so later assertions are unaffected
    db.prepare("UPDATE sessions SET manual_priority_delta=0 WHERE id=?").run(idC);
    engine.rerank();
    const q = engine.queue().find((x) => x.session_id === idC); if (q) ctrl.ack(q.id);
  }

  console.log("\n== Reactive re-prioritization: newly WAITING_INPUT enters queue + pin jumps it ==");
  {
    // a session that starts WORKING (tool_use) must be hidden...
    const reactiveCwd = path.join(wtRoot, "reactive");
    fs.mkdirSync(reactiveCwd, { recursive: true });
    writeTranscript(reactiveCwd, [{ role: "assistant", text: "working on it", stop_reason: "tool_use", toolUse: true }]);
    const rid = sm.register({ repo: "/repo/demo", title: "reactive task", worktreePath: reactiveCwd, branch: "cockpit/reactive", pid: process.pid });
    await engine.tick();
    check("WORKING reactive session is hidden", !engine.queue().some((q) => q.session_id === rid));
    // ...then it transitions to waiting on input -> must enter the queue promptly.
    writeTranscript(reactiveCwd, [{ role: "assistant", text: "Should I enable the cache? (yes/no)" }]);
    await engine.tick();
    check("transitioned-to-WAITING session ENTERS the queue", engine.queue().some((q) => q.session_id === rid));
    // pinning it forces it to the front immediately (quickRerank in production).
    ctrl.setPinned(rid, true);
    engine.rerank();
    check("pinned newly-ready session jumps to front", engine.queue()[0].session_id === rid);
    ctrl.setPinned(rid, false);
  }

  console.log("\n== Unpin always clears the pin base (no stuck ~99994 ghost priority) ==");
  {
    const { PIN_BASE } = require("../core/priority");
    // THE invariant the original bug violated: a queue card whose session is NOT pinned must
    // never carry a +PIN_BASE score (the operator saw "99994" on an unpinned chat).
    const ghosts = () => engine.queue().filter((q) => q.priority >= PIN_BASE && !(q.session && q.session.pinned));
    const prioOf = (sid: number) => engine.queue().find((x) => x.session_id === sid)!.priority;

    const idG = mock("ghost-pin", [{ role: "assistant", text: "Deploy to staging? (yes/no)" }], { title: "ghost pin" });
    await engine.tick();

    // 1) Controller-only path (the Electron IPC handler calls ctrl.setPinned with NO follow-up
    //    rerank; the tick's Stage-0 lock never re-scores a pending item either) — the controller
    //    itself must re-score.
    ctrl.setPinned(idG, true); // deliberately NO engine.rerank() here
    check("pin via controller alone applies PIN_BASE", prioOf(idG) >= PIN_BASE, String(prioOf(idG)));
    ctrl.setPinned(idG, false); // deliberately NO engine.rerank() here
    check("unpin via controller alone clears PIN_BASE", prioOf(idG) < PIN_BASE, String(prioOf(idG)));
    check("no ghost-pinned cards in the queue", ghosts().length === 0, JSON.stringify(ghosts().map((g) => g.id)));

    // 2) Dismissed-while-pinned → unpinned → resurfaced. The dismissed row keeps its old cached
    //    score (rerank only touches pending), so resurfaceAll must re-score what it reopens.
    ctrl.setPinned(idG, true);
    const dismissedId = engine.queue().find((x) => x.session_id === idG)!.id;
    ctrl.dismiss(dismissedId);
    ctrl.setPinned(idG, false); // item is 'decided' here → still carries the pinned score
    const othersDismissed = (db.prepare("SELECT id, dismissed_at FROM items WHERE status='decided' AND decision='done' AND session_id != ?").all(idG) as any[]);
    // resurfaceAll only reopens sessions in a READY state (its contract: callers tick first);
    // the mock idles as UNKNOWN, so materialize that precondition directly.
    db.prepare("UPDATE sessions SET state='WAITING_INPUT' WHERE id=?").run(idG);
    const rr = ctrl.resurfaceAll();
    check("resurfaceAll reopened the dismissed card", rr.reopened >= 1, JSON.stringify(rr));
    check("resurfaced card was re-scored — pin base gone", prioOf(idG) < PIN_BASE, String(prioOf(idG)));
    check("still no ghost-pinned cards", ghosts().length === 0, JSON.stringify(ghosts().map((g) => g.id)));
    // put back any OTHER dismissed cards resurfaceAll reopened so later sections are unaffected
    for (const o of othersDismissed)
      db.prepare("UPDATE items SET status='decided', decision='done', dismissed_at=?, updated_at=datetime('now') WHERE id=? AND status='pending'").run(o.dismissed_at ?? null, o.id);

    // 3) Snooze auto-unpins → must re-score inline; undo restores the pin → must re-score too.
    ctrl.setPinned(idG, true);
    ctrl.snooze(engine.queue().find((x) => x.session_id === idG)!.id);
    check("snooze auto-unpin re-scores (drops below PIN_BASE)", prioOf(idG) < PIN_BASE, String(prioOf(idG)));
    ctrl.undo(); // restores pinned=1 + the old penalty
    check("undo(snooze) re-pins AND re-scores (back above PIN_BASE)", prioOf(idG) >= PIN_BASE, String(prioOf(idG)));
    ctrl.undo(); // pops the pin itself → unpinned again
    check("undo(pin) unpins AND re-scores", prioOf(idG) < PIN_BASE, String(prioOf(idG)));

    // clean up
    const g = engine.queue().find((x) => x.session_id === idG); if (g) ctrl.ack(g.id);
  }

  console.log("\n== Live terminal: capturePane + sendKey against a real tmux pane ==");
  {
    const { execFileSync } = require("child_process");
    let haveTmux = true;
    try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { haveTmux = false; }
    if (!haveTmux) {
      console.log("  (tmux not available — skipping live terminal test)");
    } else {
      const termCwd = path.join(wtRoot, "liveterm");
      fs.mkdirSync(termCwd, { recursive: true });
      const tn = "cockpit-test-liveterm";
      // Create on the DEFAULT tmux socket (clear TMUX) — that's the socket the cockpit code
      // talks to (envNoTmux), so the test session must live there too.
      const envNT = { ...process.env } as any; delete envNT.TMUX;
      try { execFileSync("tmux", ["kill-session", "-t", tn], { stdio: "ignore", env: envNT }); } catch {}
      // a plain external bash pane whose cwd matches the session's worktree_path
      execFileSync("tmux", ["new-session", "-d", "-s", tn, "-c", termCwd, "bash --norc"], { env: envNT });
      execFileSync("sleep", ["0.6"]); // let the new pane register its cwd
      writeTranscript(termCwd, [{ role: "assistant", text: "idle" }]);
      const tid = sm.register({ repo: "/repo/demo", title: "live terminal", worktreePath: termCwd, branch: "not-a-cockpit-name" });
      const sess = sm.list().find((s) => s.id === tid)!;
      // resolves the EXTERNAL pane purely by matching worktree_path -> pane cwd
      const target = sm.resolvePaneTarget(sess);
      check("resolvePaneTarget finds external pane by worktree cwd", !!target, String(target));
      // type a marker and read it back from the pane
      sm.sendKey(sess, "echo COCKPIT_LIVE_OK", false);
      sm.sendKey(sess, "Enter", true);
      // give the shell a moment to render
      execFileSync("sleep", ["0.7"]);
      const cap = sm.capturePane(sess, 100) || "";
      check("capturePane shows the live pane content (typed command echoed)", cap.includes("COCKPIT_LIVE_OK"), cap.slice(-120));
      // controller.pane() reports it as live with content
      const pane = ctrl.pane(tid);
      check("controller.pane() reports live + content", pane.live && pane.content.includes("COCKPIT_LIVE_OK"));
      try { execFileSync("tmux", ["kill-session", "-t", tn], { stdio: "ignore", env: envNT }); } catch {}
      // after the pane dies there is no live terminal
      const after = ctrl.pane(tid);
      check("no live pane after tmux session is killed", after.live === false);
    }
  }

  console.log("\n== Terminal identity: a task NEVER attaches to a cwd-shared FOREIGN pane (regression) ==");
  {
    // Operator-reported bug: opening a task's terminal showed a terminal "from another window /
    // another place". Root cause guarded in sessions.ts:328 — a session with no exact captured
    // pane must NOT fall back to cwd-matching a live pane, because many real sessions share one
    // repo cwd, so a cwd match grabs a FOREIGN operator pane ("clicking any session shows the same
    // terminal"). With no safe pane the resolver must return null (the UI then shows the session's
    // OWN transcript read-only) — never a foreign pane.
    const sharedCwd = path.join(wtRoot, "shared-repo-cwd");
    fs.mkdirSync(sharedCwd, { recursive: true });
    writeTranscript(sharedCwd, [{ role: "assistant", text: "Should I proceed? (yes/no)" }]);
    const sA = sm.register({ repo: "/repo/demo", title: "task A shared cwd", worktreePath: sharedCwd, branch: "plain-branch-A" });
    const sB = sm.register({ repo: "/repo/demo", title: "task B shared cwd", worktreePath: sharedCwd, branch: "plain-branch-B" });
    check("task A (no captured pane) resolves NO foreign cwd-shared pane (→ null, own transcript)", ctrl.attachSpec(sA) === null, JSON.stringify(ctrl.attachSpec(sA)));
    check("task B (no captured pane) resolves NO foreign cwd-shared pane (→ null, own transcript)", ctrl.attachSpec(sB) === null, JSON.stringify(ctrl.attachSpec(sB)));

    // POSITIVE: a session WITH its own captured exact pane targets ITS OWN pane id; two such
    // sessions never collide — each terminal is bound to its own identity, not a shared one.
    const mkPaneSession = (name: string, target: string, pane: string): number => {
      const cwd = path.join(wtRoot, name);
      fs.mkdirSync(cwd, { recursive: true });
      writeTranscript(cwd, [{ role: "assistant", text: "Ready? (yes/no)" }]);
      const id = sm.register({ repo: "/repo/demo", title: name, worktreePath: cwd, branch: "cockpit/" + name });
      db.prepare("UPDATE sessions SET is_live_pane=1, tmux_target=?, pane_id=? WHERE id=?").run(target, pane, id);
      return id;
    };
    const p1 = mkPaneSession("pane-one", "realsess:0.0", "%11");
    const p2 = mkPaneSession("pane-two", "realsess:1.0", "%22");
    const j1 = JSON.stringify(ctrl.attachSpec(p1)?.argv || []);
    const j2 = JSON.stringify(ctrl.attachSpec(p2)?.argv || []);
    check("captured-pane task targets ITS OWN pane id (%11, not %22)", j1.includes("%11") && !j1.includes("%22"), j1);
    check("a second captured-pane task targets ITS OWN pane id (%22, not %11)", j2.includes("%22") && !j2.includes("%11"), j2);
    check("the two tasks resolve to DIFFERENT terminal targets (no cross-wiring)", j1 !== j2);
  }

  console.log("\n== Undo / revert last action ==");
  {
    // sendAnswer -> undo restores the item to pending
    const uId = mock("undo-send", [{ role: "assistant", text: "Should I deploy now? (yes/no)" }], { title: "undo send" });
    await engine.tick();
    const sendItem = engine.queue().find((q) => q.session_id === uId)!;
    const dlBefore = (db.prepare("SELECT COUNT(*) c FROM decision_log").get() as any).c;
    ctrl.sendAnswer(sendItem.id, "yes");
    check("sendAnswer removed item from pending queue", !engine.queue().some((q) => q.id === sendItem.id));
    const u1 = ctrl.undo();
    check("undo(sendAnswer) reports a label", u1.ok && /sent answer/.test(u1.label), JSON.stringify(u1));
    check("undo(sendAnswer) restores item to pending", (db.prepare("SELECT status FROM items WHERE id=?").get(sendItem.id) as any).status === "pending");
    check("undo(sendAnswer) removed the decision_log row", (db.prepare("SELECT COUNT(*) c FROM decision_log").get() as any).c === dlBefore);

    // snooze -> applies a penalty (item stays visible); undo restores the prior penalty
    const snId = mock("undo-snooze", [{ role: "assistant", text: "Should I retry? (yes/no)" }], { title: "undo snooze" });
    await engine.tick();
    const snItem = engine.queue().find((q) => q.session_id === snId)!;
    ctrl.snooze(snItem.id, 120);
    check("snooze applied a penalty on the session", (db.prepare("SELECT snooze_penalty FROM sessions WHERE id=?").get(snId) as any).snooze_penalty < 0);
    check("snooze item still in pending queue (visible)", engine.queue().some((q) => q.id === snItem.id));
    const u2 = ctrl.undo();
    check("undo(snooze) reports a label", u2.ok && /snoozed/.test(u2.label));
    check("undo(snooze) restores prior penalty (0)", (db.prepare("SELECT snooze_penalty FROM sessions WHERE id=?").get(snId) as any).snooze_penalty === 0);

    // pin -> undo unpins
    const pnId = mock("undo-pin", [{ role: "assistant", text: "Proceed? (yes/no)" }], { title: "undo pin" });
    ctrl.setPinned(pnId, true);
    check("pin set pinned=1", (db.prepare("SELECT pinned FROM sessions WHERE id=?").get(pnId) as any).pinned === 1);
    const u3 = ctrl.undo();
    check("undo(pin) reports a label", u3.ok && /pin/.test(u3.label));
    check("undo(pin) restores pinned=0", (db.prepare("SELECT pinned FROM sessions WHERE id=?").get(pnId) as any).pinned === 0);

    // manualImportance -> undo restores prior value
    const miId = mock("undo-mi", [{ role: "assistant", text: "OK? (yes/no)" }], { title: "undo mi" });
    ctrl.setManualImportance(miId, 80);
    check("manualImportance set to 80", (db.prepare("SELECT manual_importance FROM sessions WHERE id=?").get(miId) as any).manual_importance === 80);
    ctrl.setManualImportance(miId, 30);
    const u4a = ctrl.undo();
    check("undo(manualImportance) reports a label", u4a.ok && /importance/.test(u4a.label));
    check("undo(manualImportance) restores prior value (80)", (db.prepare("SELECT manual_importance FROM sessions WHERE id=?").get(miId) as any).manual_importance === 80);
    ctrl.undo();
    check("undo(manualImportance) again restores null", (db.prepare("SELECT manual_importance FROM sessions WHERE id=?").get(miId) as any).manual_importance === null);

    // undo with nothing left eventually returns ok:false
    let guard = 0;
    while (ctrl.undo().ok && guard++ < 50) {}
    check("undo with empty stack returns ok:false", ctrl.undo().ok === false);
    check("state() exposes undo availability shape", typeof ctrl.state().undo.available === "boolean");
  }

  console.log("\n== Default A/B/C/D answering: options stored + sendable ==");
  {
    // normalizeOptions: yes/no -> Y/N, multi -> A/B/C/D
    const { normalizeOptions, isYesNo } = require("../core/options");
    check("isYesNo detects (yes/no)", isYesNo("Should I bind to port 8080? (yes/no)") === true);
    check("isYesNo false for multi-choice", isYesNo("Which option: A, B or C?") === false);
    const yn = normalizeOptions("Should I deploy now? (yes/no)", ["Yes, deploy", "No, wait"]);
    check("yes/no => Y/N keys", yn.length === 2 && yn[0].key === "y" && yn[1].key === "n" && /yes/i.test(yn[0].text));
    const abcd = normalizeOptions("Pick a cache layer", ["LRU", "Redis", "mmap"]);
    check("multi => A/B/C/D keys", abcd.length === 3 && abcd[0].key === "a" && abcd[2].key === "c");

    // structured answer_options round-trips through the queue and is sendable
    const aoId = mock("opts-q", [{ role: "assistant", text: "Should I bind to port 8080? (yes/no)" }], { title: "options q" });
    await engine.tick();
    const aoItem = engine.queue().find((q) => q.session_id === aoId)!;
    db.prepare("UPDATE items SET answer_options=? WHERE id=?").run(
      JSON.stringify([{ key: "y", label: "Yes", text: "Yes, bind 8080" }, { key: "n", label: "No", text: "No, use 3000" }]),
      aoItem.id
    );
    const ranked = engine.queue().find((q) => q.session_id === aoId)!;
    let parsed: any[] = [];
    try { parsed = JSON.parse(ranked.answer_options || "[]"); } catch {}
    check("answer_options round-trips as Y/N objects", parsed.length === 2 && parsed[0].key === "y" && parsed[1].label === "No");
    // sending the N option clears the item
    ctrl.sendAnswer(ranked.id, parsed[1].text);
    check("sending a chosen option clears the item from pending", !engine.queue().some((q) => q.id === ranked.id));
    check("the sent option was recorded as the decision", (db.prepare("SELECT decision FROM items WHERE id=?").get(ranked.id) as any).decision === "sent");
  }

  console.log("\n== Kanban backfill (parse, order, classify, trigger) ==");
  {
    const { parseKanbanFilename, listKanbanCards, classifyKanbanCard } = require("../core/kanban");
    // filename parsing
    const a = parseKanbanFilename("#42-c2-add-retry-to-sqs.md");
    check("parse: #-prefix => aiReady, priority+complexity", a && a.priority === 42 && a.complexity === 2 && a.aiReady && !a.humanRequired && /retry/.test(a.title));
    const h = parseKanbanFilename("03-c4H-encrypt-data.md");
    check("parse: H flag => humanRequired", h && h.humanRequired && !h.aiReady && h.complexity === 4);
    check("parse: non-card filename => null", parseKanbanFilename("notes.txt") === null);

    // temp board with mixed columns + a human-required card (must be skipped)
    const kroot = path.join(HOME, "kanban");
    const cols = ["4_today", "3_week", "2_planned"];
    for (const c of cols) fs.mkdirSync(path.join(kroot, c), { recursive: true });
    fs.writeFileSync(path.join(kroot, "4_today", "#90-c2-startable-task.md"), "# Startable task\n\n---\n\nAdd retry with backoff. AI-ready.");
    fs.writeFileSync(path.join(kroot, "4_today", "10-c3-needs-info-task.md"), "# Needs info\n\n---\n\nImprove the thing.");
    fs.writeFileSync(path.join(kroot, "3_week", "50-c3-week-task.md"), "# Week task\n\n---\n\nDo the week thing.");
    fs.writeFileSync(path.join(kroot, "2_planned", "05-c4H-human-task.md"), "# Human task\n\n---\n\nNeeds a human.");
    const order = ["_work", "4_today", "3_week", "2_planned"];
    const cards = listKanbanCards(kroot, order);
    const humanCard = cards.find((c: any) => c.file.includes("human"));
    check("listKanbanCards now INCLUDES H (human) cards", !!humanCard && humanCard.humanRequired === true);
    check("listKanbanCards orders by column then priority", cards[0].column === "4_today" && cards[0].priority === 90 && cards[cards.length - 1].column === "2_planned");

    // classify with a MOCKED classifier
    const mockNeeds = async () => ({ startable: false, questions: ["Q1?", "Q2?"] });
    const c1 = await classifyKanbanCard({ title: "x", body: "y", aiReady: true, complexity: 2 }, "haiku", mockNeeds);
    check("classify: aiReady card is STARTABLE without LLM", c1.startable === true && c1.questions.length === 0);
    const c2 = await classifyKanbanCard({ title: "x", body: "y", aiReady: false, complexity: 3 }, "haiku", mockNeeds);
    check("classify: mocked NEEDS-INFO returns questions", c2.startable === false && c2.questions.length === 2);
    const c3 = await classifyKanbanCard({ title: "x", body: "y", aiReady: false, complexity: 3 }, "haiku", async () => ({ startable: true, questions: [] }));
    check("classify: mocked STARTABLE", c3.startable === true);

    // backfill trigger on a FRESH db: empty queue -> kanban tops up; full queue -> pruned
    const kdb = openDb(path.join(HOME, "kanban.db"));
    const ksm = new SessionManager(kdb);
    const kcfg = { ...cfg, kanban_path: kroot, min_active_tasks: 2, kanban_column_order: order, kanban_auto_launch: false };
    const keng = new Engine(kdb, ksm, kcfg, { enrich: false, discover: false, pr: false, kanban: true });
    await keng.tick();
    let kq = keng.queue().filter((q) => q.session.kind === "kanban");
    check("backfill surfaces kanban when ready queue is empty", kq.length === 2, `got ${kq.length}`);
    check("kanban top item is the highest column/priority (4_today #90)", kq[0].session.kanban_column === "4_today");
    const startableItem = kq.find((q) => q.session.title.includes("startable"));
    check("aiReady kanban card classified STARTABLE", !!startableItem && startableItem.session.kanban_startable === 1);
    const niItem = kq.find((q) => q.session.title.includes("needs info"));
    check("non-aiReady kanban card NEEDS-INFO (offline)", !!niItem && niItem.session.kanban_startable === 0);

    // add 2 real claude waiting sessions -> ready queue reaches threshold -> kanban pruned
    const kmock = (name: string, text: string) => {
      const cwd = path.join(HOME, "kwts", name);
      fs.mkdirSync(cwd, { recursive: true });
      writeTranscript(cwd, [{ role: "assistant", text }]);
      return ksm.register({ repo: "/r", title: name, worktreePath: cwd, branch: "cockpit/" + name });
    };
    kmock("kq1", "Should I do X? (yes/no)");
    kmock("kq2", "Should I do Y? (yes/no)");
    await keng.tick();
    check("real claude items become ready", keng.queue().filter((q) => q.session.kind === "claude").length >= 2);
    check("kanban pruned once the queue is full enough", keng.queue().filter((q) => q.session.kind === "kanban").length === 0);

    // H (human-required) cards surface AND classify like any other card — the H flag is
    // informational only; nothing pins them to a blocked state and the controller will start them.
    const hdb = openDb(path.join(HOME, "kanban_h.db"));
    const hsm = new SessionManager(hdb);
    const hcfg = { ...cfg, kanban_path: kroot, min_active_tasks: 4, kanban_column_order: order };
    const heng = new Engine(hdb, hsm, hcfg, { enrich: false, discover: false, pr: false, kanban: true });
    await heng.tick();
    const hq = heng.queue().filter((q) => q.session.kind === "kanban");
    const hItem = hq.find((q) => q.session.title.toLowerCase().includes("human"));
    check("H card surfaces in the queue (no longer skipped)", !!hItem);
    check("H card classified like a normal card (never kanban_startable=2)", !!hItem && hItem.session.kanban_startable !== 2);
    // Offline (enrich:false) + non-#'d → NEEDS-INFO, same as any other vague card.
    check("H card NEEDS-INFO offline, not H-blocked", !!hItem && hItem.session.kanban_startable === 0);
    // A legacy H-blocked row (kanban_startable=2 from the old gate) heals on the next surface.
    if (hItem) {
      hdb.prepare("UPDATE sessions SET kanban_startable=2 WHERE id=?").run(hItem.session.id);
      await heng.tick();
      const healed = (hdb.prepare("SELECT kanban_startable FROM sessions WHERE id=?").get(hItem.session.id) as any).kanban_startable;
      check("legacy kanban_startable=2 row reclassified on next surface", healed !== 2);
    }

    // restore the shared db singleton for any later code
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== Kanban AUTO-LAUNCH + 30-min cooldown (card 291) ==");
  {
    // Board: two '#'-ready STARTABLE cards + one non-#'d NEEDS-INFO card. Offline (enrich:false)
    // so the non-#'d card classifies NEEDS-INFO (startable=0) — it still auto-launches (every
    // card does), just after the higher-priority cards, with its open questions in the prompt.
    const aroot = path.join(HOME, "akanban");
    const acols = ["4_today", "3_week"];
    for (const c of acols) fs.mkdirSync(path.join(aroot, c), { recursive: true });
    fs.writeFileSync(path.join(aroot, "4_today", "#90-c2-auto-ready-one.md"), "# Auto ready one\n\n---\n\nAI-ready startable task one.");
    fs.writeFileSync(path.join(aroot, "4_today", "#80-c2-auto-ready-two.md"), "# Auto ready two\n\n---\n\nAI-ready startable task two.");
    fs.writeFileSync(path.join(aroot, "3_week", "20-c3-needs-info.md"), "# Needs info\n\n---\n\nImprove the thing somehow.");
    const aorder = ["_work", "4_today", "3_week"];

    // Fake clock (ms) + a launch spy: record every launch, do NO real git/tmux.
    const clock = { t: 1_000_000_000 };
    const adb = openDb(path.join(HOME, "auto-launch.db"));
    const asm = new SessionManager(adb);
    const launches: { title: string; repo: string; prompt: string; skipPermissions?: boolean }[] = [];
    asm.launch = (opts: any) => { launches.push({ title: opts.title, repo: opts.repo, prompt: opts.prompt, skipPermissions: opts.skipPermissions }); return 9000 + launches.length; };
    const acfg = {
      ...cfg, kanban_path: aroot, kanban_column_order: aorder, min_active_tasks: 3,
      kanban_auto_launch: true, kanban_auto_cooldown_min: 30, kanban_repo: "/r",
    };
    const aeng = new Engine(adb, asm, acfg, { enrich: false, discover: false, pr: false, kanban: true, now: () => clock.t });

    // (a) below-threshold + startable + elapsed cooldown (last=0) => EXACTLY ONE launch.
    await aeng.tick();
    check("AUTO: below-threshold + cooldown elapsed => exactly ONE launch", launches.length === 1, `got ${launches.length}`);
    check("AUTO: it launched the TOP card (#90)", launches[0] && /one/.test(launches[0].title), JSON.stringify(launches[0]));
    check("AUTO: launched into kanban_repo", launches[0] && launches[0].repo === "/r");
    check("AUTO: launch prompt is a one-line /work invocation (number + title + column)",
      launches[0] && launches[0].prompt === "/work 90 auto ready one (in 4_today)" && !launches[0].prompt.includes("\n"), launches[0]?.prompt);

    // (c) NEEDS-INFO card is surfaced+flagged; it launches too — but only AFTER the
    // higher-priority cards (priority order), never ahead of them.
    const niSess = adb.prepare("SELECT * FROM sessions WHERE kind='kanban' AND title LIKE '%needs info%'").get() as any;
    check("AUTO: NEEDS-INFO card surfaced & flagged startable=0", !!niSess && niSess.kanban_startable === 0);
    check("AUTO: NEEDS-INFO card not launched ahead of higher-priority cards", !launches.some((l) => /needs info/i.test(l.title)));

    // (b) STAMPEDE REGRESSION: tick repeatedly WITHOUT advancing the clock. readyClaudeCount() still
    //     reads low (the launch spy created no ready 'claude' item), yet the cooldown blocks all launches.
    for (let i = 0; i < 5; i++) await aeng.tick();
    check("AUTO (STAMPEDE GUARD): within-cooldown => ZERO further launches despite low queue", launches.length === 1, `got ${launches.length}`);

    // Cooldown reset: advance 31 min => the next top pending #-card (#80) launches; the already-launched
    // #90 is NOT relaunched (its item is decided), proving one-per-window + no double-fire.
    clock.t += 31 * 60_000;
    await aeng.tick();
    check("AUTO: cooldown elapsed (31m) => one more launch (the next card)", launches.length === 2, `got ${launches.length}`);
    check("AUTO: second launch is #80, NOT a relaunch of #90", launches[1] && /two/.test(launches[1].title), JSON.stringify(launches[1]));

    // (c2) Next window: the NEEDS-INFO card itself launches — /work points at its column
    // (3_week), since /work only searches _work/ + 4_today/ by default.
    clock.t += 31 * 60_000;
    await aeng.tick();
    check("AUTO: NEEDS-INFO card auto-launches when its turn comes", launches.length === 3 && /needs info/i.test(launches[2]?.title || ""), JSON.stringify(launches[2]));
    check("AUTO: NEEDS-INFO launch prompt names its non-today column", !!launches[2] && launches[2].prompt === "/work 20 needs info (in 3_week)", launches[2]?.prompt);
    check("AUTO: launches run claude with --dangerously-skip-permissions (Ctrl+G i style)",
      launches.every((l: any) => l.skipPermissions === true));

    // (d) min_active_tasks=0 => no backfill at all (no surface, no launch).
    const zdb = openDb(path.join(HOME, "auto-zero.db"));
    const zsm = new SessionManager(zdb);
    const zlaunches: any[] = [];
    zsm.launch = (opts: any) => { zlaunches.push(opts); return 1; };
    const zcfg = { ...acfg, min_active_tasks: 0 };
    const zeng = new Engine(zdb, zsm, zcfg, { enrich: false, discover: false, pr: false, kanban: true, now: () => clock.t });
    await zeng.tick();
    check("AUTO: min_active_tasks=0 => no kanban surfaced", zeng.queue().filter((q) => q.session.kind === "kanban").length === 0);
    check("AUTO: min_active_tasks=0 => ZERO launches", zlaunches.length === 0, `got ${zlaunches.length}`);

    // feature flag OFF => surfaces but never auto-launches.
    const fdb = openDb(path.join(HOME, "auto-flagoff.db"));
    const fsm = new SessionManager(fdb);
    const flaunches: any[] = [];
    fsm.launch = (opts: any) => { flaunches.push(opts); return 1; };
    const fcfg = { ...acfg, kanban_auto_launch: false };
    const feng = new Engine(fdb, fsm, fcfg, { enrich: false, discover: false, pr: false, kanban: true, now: () => clock.t });
    await feng.tick();
    check("AUTO: flag off => kanban still surfaced", feng.queue().filter((q) => q.session.kind === "kanban").length > 0);
    check("AUTO: flag off => ZERO auto-launches", flaunches.length === 0, `got ${flaunches.length}`);

    // FAILED-LAUNCH STAMPEDE GUARD (2026-06-10 incident): if launch() THROWS every time (e.g. the
    // worktree/branch already exists), the cooldown must still be consumed on the ATTEMPT so it does
    // NOT retry every tick. Spy that always throws; assert exactly ONE attempt across many low-queue ticks.
    const xdb = openDb(path.join(HOME, "auto-failure.db"));
    const xsm = new SessionManager(xdb);
    let attempts = 0;
    xsm.launch = (_opts: any) => { attempts++; throw new Error("worktree already exists"); };
    const xclock = { t: 5_000_000_000 };
    const xeng = new Engine(xdb, xsm, { ...acfg }, { enrich: false, discover: false, pr: false, kanban: true, now: () => xclock.t });
    for (let i = 0; i < 6; i++) await xeng.tick(); // clock frozen → within cooldown after the first attempt
    check("AUTO (FAILED-LAUNCH GUARD): a throwing launch is attempted ONCE, not retried every tick", attempts === 1, `got ${attempts}`);

    // restore the shared db singleton for any later code
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== FIX J: complete & archive (persistent + kanban move + undo) ==");
  {
    // temp board (NOT the real one) with the card in a 4_today column.
    const jroot = path.join(HOME, "jkanban");
    fs.mkdirSync(path.join(jroot, "4_today"), { recursive: true });
    fs.mkdirSync(path.join(jroot, "8_done"), { recursive: true });
    const cardPath = path.join(jroot, "4_today", "07-c2-finish-the-widget.md");
    fs.writeFileSync(cardPath, "# Finish the widget\n\n---\n\nWire it up.");
    const jcfg = { ...cfg, kanban_path: jroot };
    const jctrl = new Controller(db, engine, sm, jcfg);

    const jid = mock("finish-the-widget", [{ role: "assistant", text: "Should I ship it? (yes/no)" }], { title: "Finish the widget" });
    db.prepare("UPDATE sessions SET kanban_file=?, kanban_column='4_today' WHERE id=?").run(cardPath, jid);
    await engine.tick();
    const before = engine.queue().some((q) => q.session_id === jid);
    check("J: task is in the queue before completing", before);

    const r = jctrl.completeTask(jid);
    check("J: completeTask ok + reports kanban moved", r.ok && r.kanbanMoved === true);
    check("J: kanban card physically moved to 8_done", fs.existsSync(path.join(jroot, "8_done", "07-c2-finish-the-widget.md")) && !fs.existsSync(cardPath));
    check("J: session is archived (excluded from roster/allSessions)", !sm.list().some((s) => s.id === jid));
    check("J: completed task leaves the queue immediately", !engine.queue().some((q) => q.session_id === jid));

    // PERSISTENCE: a re-discovery tick must NOT bring it back.
    await engine.tick();
    check("J: completed task STAYS gone across a re-discovery tick", !engine.queue().some((q) => q.session_id === jid) && !sm.list().some((s) => s.id === jid));

    // UNDO: restores the archive flag AND moves the card back to 4_today.
    jctrl.undo();
    check("J: undo un-archives the session (back in roster)", sm.list().some((s) => s.id === jid));
    check("J: undo moves the kanban card back to 4_today", fs.existsSync(cardPath) && !fs.existsSync(path.join(jroot, "8_done", "07-c2-finish-the-widget.md")));
    await engine.tick();
    check("J: un-archived task can surface again after undo", engine.queue().some((q) => q.session_id === jid));

    // best-effort title match when no kanban_file is linked.
    const cardPath2 = path.join(jroot, "4_today", "08-c2-orphan-match-card.md");
    fs.writeFileSync(cardPath2, "# Orphan match card\n\n---\n\nx");
    const jid2 = mock("orphan-match-card", [{ role: "assistant", text: "ok? (yes/no)" }], { title: "Orphan match card" });
    const r2 = jctrl.completeTask(jid2);
    check("J: no-linked-card → title match moves the card to 8_done", r2.ok && r2.kanbanMoved && fs.existsSync(path.join(jroot, "8_done", "08-c2-orphan-match-card.md")));
  }

  console.log("\n== FIX L: open-terminal bumps the task to the top (active boost) ==");
  {
    const ldb = openDb(path.join(HOME, "ldb.db"));
    const lsm = new SessionManager(ldb);
    const leng = new Engine(ldb, lsm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const lctrl = new Controller(ldb, leng, lsm, cfg);
    const lmock = (name: string, text: string, opts: any = {}) => {
      const cwd = path.join(HOME, "lwts", name);
      fs.mkdirSync(cwd, { recursive: true });
      writeTranscript(cwd, [{ role: "assistant", text }]);
      return lsm.register({ repo: "/r", title: opts.title || name, worktreePath: cwd, branch: "cockpit/" + name, blocksOtherWork: opts.blocks });
    };
    const a = lmock("low-prio-active", "Should I bind the server to port 8080? (yes/no)", { title: "low prio active" });
    const b = lmock("high-prio-other", "Should I enable the experimental cache layer now? (yes/no)", { title: "high prio other", blocks: true });
    await leng.tick();
    const q0 = leng.queue();
    check("L: both tasks surfaced before activate", q0.some((x) => x.session_id === a) && q0.some((x) => x.session_id === b));
    lctrl.activateSession(a);
    leng.rerank();
    const q1 = leng.queue();
    check("L: after activate, the opened task jumps to #1", q1[0] && q1[0].session_id === a, `top=${q1[0] && q1[0].session_id} a=${a}`);
    check("L: active boost is transparent in the score breakdown", JSON.stringify(q1[0].score_breakdown).includes("active"));
    lctrl.activateSession(b); leng.rerank();
    check("L: activating another task moves the boost (single active at a time)", leng.queue()[0].session_id === b);
    openDb(process.env.COCKPIT_DB); // restore the shared singleton
  }

  console.log("\n== FIX GG: reopen reflects the LIVE transcript (cache busts on mtime advance) ==");
  {
    const { parseTranscriptTail } = require("../core/transcript");
    const cwd = path.join(HOME, "ggwts", "live");
    fs.mkdirSync(cwd, { recursive: true });
    const tfile = writeTranscript(cwd, [{ role: "assistant", text: "Should I deploy? (yes/no)" }]);
    let st = fs.statSync(tfile);
    const v1 = await parseTranscriptTail(tfile, st.mtimeMs);
    check("GG: initial transcript read shows the question", v1.lastAssistant && /deploy/.test(v1.lastAssistant.text));
    // operator answered + claude replied while away → transcript advances (new turn + newer mtime).
    writeTranscript(cwd, [
      { role: "assistant", text: "Should I deploy? (yes/no)" },
      { role: "user", text: "yes" },
      { role: "assistant", text: "Deployed — all checks green." },
    ]);
    const future = new Date(Date.now() + 5000); fs.utimesSync(tfile, future, future);
    st = fs.statSync(tfile);
    const v2 = await parseTranscriptTail(tfile, st.mtimeMs);
    check("GG: after the transcript advances, re-read shows claude's NEW answer (cache busted by mtime)", v2.lastAssistant && /Deployed/.test(v2.lastAssistant.text));
  }

  console.log("\n== FIX BB: reasoned priority feedback (strong, weighted, feeds RANKING.md) ==");
  {
    const bdb = openDb(path.join(HOME, "bdb.db"));
    const bsm = new SessionManager(bdb);
    const beng = new Engine(bdb, bsm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const bctrl = new Controller(bdb, beng, bsm, cfg);
    const bmk = (n: string, t: string) => { const cwd = path.join(HOME, "bwts", n); fs.mkdirSync(cwd, { recursive: true }); writeTranscript(cwd, [{ role: "assistant", text: t }]); return bsm.register({ repo: "/r", title: n, worktreePath: cwd, branch: "cockpit/" + n }); };
    const s1 = bmk("target", "Should I ship the refactor now? (yes/no)");
    const s2 = bmk("neighbor-a", "Should I bump the version? (yes/no)");
    const s3 = bmk("neighbor-b", "Should I tag the release? (yes/no)");
    await beng.tick();
    const item = beng.queue().find((x) => x.session_id === s1)!;
    const beforePri = new Map(beng.queue().map((x: any) => [x.session_id, x.priority]));
    // h = rank HIGHER (up). IMMEDIATE = per-item offset on THIS session only.
    const r = bctrl.reasonFeedback(item.id, "up", "this unblocks the release, do it first");
    beng.rerank();
    const afterPri = new Map(beng.queue().map((x: any) => [x.session_id, x.priority]));
    check("BB: reasonFeedback records an example + returns a delta", r.ok && !!r.exampleId && (r as any).delta === 30);
    check("BB: PER-ITEM offset moves ONLY the target up (+30); neighbors UNCHANGED", (afterPri.get(s1)! - beforePri.get(s1)!) === 30 && afterPri.get(s2) === beforePri.get(s2) && afterPri.get(s3) === beforePri.get(s3));
    check("BB: session.manual_priority_delta is +30 on the target", ((bsm.list().find((x) => x.id === s1) as any).manual_priority_delta) === 30);
    const { recentExamples } = require("../core/db");
    const ex = recentExamples(bdb, 5).find((e: any) => e.id === r.exampleId) as any;
    check("BB: example source=explicit_reason, reason weighs higher (5), snapshot + direction=up", ex && ex.kind === "explicit_reason" && ex.source === "explicit_reason" && ex.weight >= 5 && ex.reason.includes("unblocks") && ex.state && ex.state.direction === "up" && ex.state.features);
    // GENERALIZING weight tuning happens ONLY in the dream (not the instant press).
    const { tuneWeightsFromExamples } = require("../core/dream");
    const changes = tuneWeightsFromExamples(bdb);
    check("BB: the DREAM (not the press) generalizes — tunes weights from the explicit reason", Array.isArray(changes) && changes.some((c: any) => /explicit_reason/.test(c.from)));
    // undo reverts the per-item offset.
    bctrl.undo(); beng.rerank();
    check("BB: undo reverts the per-item offset", ((bsm.list().find((x) => x.id === s1) as any).manual_priority_delta) === 0);
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== FIX W: surface everything except actively-WORKING (idle at LOW prio) ==");
  {
    const { detectState } = require("../core/stateDetector");
    // detector: a cleanly-ended ambiguous turn is IDLE (UNKNOWN), NOT working/hidden.
    const idleView = { turns: [{ role: "assistant", text: "I've been looking around the repo.", stop_reason: "end_turn", hasToolUse: false, isToolResult: false, timestamp: null }], lastAssistant: { role: "assistant", text: "I've been looking around the repo.", stop_reason: "end_turn", hasToolUse: false, isToolResult: false, timestamp: null }, lastMeaningful: null, lastTimestamp: null, raw: "", cwd: null };
    const idle = detectState({ view: idleView, processAlive: false, msSinceWrite: 9e9, quietPeriodMs: 5000 });
    check("W: a cleanly-ended ambiguous turn is idle (UNKNOWN), not hidden-as-working", idle.state === "UNKNOWN");
    const doneView = { ...idleView, lastAssistant: { ...idleView.lastAssistant, text: "All done — committed and tests pass." }, turns: [{ role: "assistant", text: "All done — committed and tests pass.", stop_reason: "end_turn", hasToolUse: false, isToolResult: false, timestamp: null }] };
    check("W: a completion-ending turn classifies DONE (not UNKNOWN)", detectState({ view: doneView, processAlive: false, msSinceWrite: 9e9, quietPeriodMs: 5000 }).state === "DONE");
    const workView = { ...idleView, lastAssistant: { ...idleView.lastAssistant, text: "running", stop_reason: "tool_use", hasToolUse: true }, turns: [{ role: "assistant", text: "running", stop_reason: "tool_use", hasToolUse: true, isToolResult: false, timestamp: null }] };
    check("W: a tool_use turn is WORKING (hidden)", detectState({ view: workView, processAlive: true, msSinceWrite: 9e9, quietPeriodMs: 5000 }).state === "WORKING");

    // engine: an idle session surfaces at LOW prio; an actively-working one stays hidden.
    const wdb = openDb(path.join(HOME, "wdb.db"));
    const wsm = new SessionManager(wdb);
    const weng = new Engine(wdb, wsm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const wmk = (name: string, lines: any[], pid?: number) => { const cwd = path.join(HOME, "wwts", name); fs.mkdirSync(cwd, { recursive: true }); writeTranscript(cwd, lines); return wsm.register({ repo: "/r", title: name, worktreePath: cwd, branch: "cockpit/" + name, pid }); };
    const waiting = wmk("waiting", [{ role: "assistant", text: "Should I deploy to prod? (yes/no)" }]);
    const idleSess = wmk("idle", [{ role: "assistant", text: "I looked through the logs and the configs.", stop_reason: "end_turn" }]);
    const working = wmk("working", [{ role: "assistant", text: "running", stop_reason: "tool_use", toolUse: true }], process.pid);
    await weng.tick();
    const q = weng.queue();
    check("W: idle session is SURFACED in Up Next", q.some((x) => x.session_id === idleSess));
    check("W: actively-working session stays HIDDEN", !q.some((x) => x.session_id === working));
    const wi = q.findIndex((x) => x.session_id === waiting), ii = q.findIndex((x) => x.session_id === idleSess);
    check("W: WAITING_INPUT ranks ABOVE the idle session (idle = low prio)", wi >= 0 && ii >= 0 && wi < ii);
    check("W: idle item is surfaced WITHOUT Claude enrichment (enriched=1, FYI category)", (() => { const it = wdb.prepare("SELECT enriched,category FROM items WHERE session_id=? AND status='pending'").get(idleSess) as any; return it && it.enriched === 1 && it.category === "FYI_DONE"; })());
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== resurfaceAll: one-time repopulate of Up Next ==");
  {
    const rdb = openDb(path.join(HOME, "rdb.db"));
    const rsm = new SessionManager(rdb);
    const reng = new Engine(rdb, rsm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const rctrl = new Controller(rdb, reng, rsm, cfg);
    const rmk = (name: string, text: string) => {
      const cwd = path.join(HOME, "rwts", name); fs.mkdirSync(cwd, { recursive: true });
      writeTranscript(cwd, [{ role: "assistant", text }]);
      return rsm.register({ repo: "/r", title: name, worktreePath: cwd, branch: "cockpit/" + name });
    };
    const w1 = rmk("waiting-1", "Should I deploy to prod now? (yes/no)");
    const w2 = rmk("waiting-2", "Should I enable the cache layer? (yes/no)");
    await reng.tick();
    // dismiss both so Up Next is empty
    for (const id of [w1, w2]) { const it = reng.queue().find((x) => x.session_id === id); if (it) rctrl.dismiss(it.id); }
    await reng.tick();
    check("resurfaceAll: Up Next empty after dismissing both", reng.queue().filter((q) => q.session_id === w1 || q.session_id === w2).length === 0);
    // complete one (archived) — must NOT be resurfaced
    const compSess = rmk("done-completed", "All set, anything else? (yes/no)");
    // a session the operator ANSWERED (decision='sent') — must NOT be resurfaced (only dismisses).
    const ansSess = rmk("answered", "Proceed with the migration? (yes/no)");
    await reng.tick();
    rctrl.completeTask(compSess);
    const ansItem = reng.queue().find((x) => x.session_id === ansSess);
    if (ansItem) rctrl.sendAnswer(ansItem.id, "yes"); // decided/sent (answered, not dismissed)
    // resurface
    const res = rctrl.resurfaceAll();
    reng.rerank();
    check("resurfaceAll: reopened ONLY the 2 dismissed-but-ready sessions", res.reopened === 2 && res.ok);
    const q = reng.queue();
    check("resurfaceAll: both DISMISSED waiting sessions are back in Up Next", q.some((x) => x.session_id === w1) && q.some((x) => x.session_id === w2));
    check("resurfaceAll: an ANSWERED (decision=sent) session is NOT resurfaced", !q.some((x) => x.session_id === ansSess));
    check("resurfaceAll: a COMPLETED session is NOT resurfaced (stays archived)", !q.some((x) => x.session_id === compSess) && !rsm.list().some((s) => s.id === compSess));
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== FIX P: dismiss = snooze-until-ready (re-surfaces on fresh activity) ==");
  {
    const pdb = openDb(path.join(HOME, "pdb.db"));
    const psm = new SessionManager(pdb);
    const peng = new Engine(pdb, psm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const pctrl = new Controller(pdb, peng, psm, cfg);
    const cwd = path.join(HOME, "pwts", "deploy-decision");
    fs.mkdirSync(cwd, { recursive: true });
    const tfile = writeTranscript(cwd, [{ role: "assistant", text: "Should I deploy to prod now? (yes/no)" }]);
    const sid = psm.register({ repo: "/r", title: "deploy decision", worktreePath: cwd, branch: "cockpit/deploy" });
    await peng.tick();
    const item = peng.queue().find((x) => x.session_id === sid);
    check("P: waiting session surfaces a pending item", !!item);

    pctrl.dismiss(item!.id); // Ctrl+G Enter
    await peng.tick();
    check("P: dismissed task leaves Up Next", !peng.queue().some((x) => x.session_id === sid));
    check("P: dismiss does NOT set completed_at", ((psm.list().find((s) => s.id === sid) as any).completed_at ?? null) === null);
    check("P: dismissed session STAYS in the roster", psm.list().some((s) => s.id === sid));

    await peng.tick();
    check("P: no fresh activity → dismissed task stays hidden (handled-for-now holds)", !peng.queue().some((x) => x.session_id === sid));

    // FRESH ACTIVITY on the SAME turn (same signature) → bump mtime past the dismiss → re-surface.
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(tfile, future, future);
    await peng.tick();
    check("P: dismissed task RE-SURFACES on fresh activity (same turn, newer mtime)", peng.queue().some((x) => x.session_id === sid));

    // re-dismiss; settle mtime to the PAST so it holds (no fresh activity since this dismiss).
    pctrl.dismiss(peng.queue().find((x) => x.session_id === sid)!.id);
    const past = new Date(Date.now() - 30_000); fs.utimesSync(tfile, past, past);
    await peng.tick();
    check("P: re-dismissed leaves Up Next again", !peng.queue().some((x) => x.session_id === sid));
    // a brand-NEW waiting turn (new signature) after dismiss → re-surfaces via a fresh item.
    writeTranscript(cwd, [{ role: "assistant", text: "Deployed. Should I run smoke tests too? (yes/no)" }]);
    await peng.tick();
    check("P: a NEW waiting turn after dismiss re-surfaces the task", peng.queue().some((x) => x.session_id === sid));

    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== UP-NEXT LOCK: a task in Up Next is FROZEN — never flickers out when its worker writes ==");
  {
    // THE OPERATOR'S HARD RULE: once something is in Up Next, the engine must NEVER re-evaluate it —
    // not its presence, not its priority — until the operator acts. This is what used to break:
    // you send a message to a worker that's in Up Next, it starts WORKING (writes a tool_use), the
    // tick detected WORKING and SUPERSEDED its card → it vanished from Up Next → the view auto-flipped
    // to another task → a minute later it came back. Unusable. Now: locked = left completely alone.
    const ldb = openDb(path.join(HOME, "lockdb.db"));
    const lsm = new SessionManager(ldb);
    const leng = new Engine(ldb, lsm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const lctrl = new Controller(ldb, leng, lsm, cfg);

    // Two waiting sessions → both in Up Next.
    const cwdA = path.join(HOME, "lockwts", "focused"); fs.mkdirSync(cwdA, { recursive: true });
    const cwdB = path.join(HOME, "lockwts", "other"); fs.mkdirSync(cwdB, { recursive: true });
    const tA = writeTranscript(cwdA, [{ role: "assistant", text: "Should I bump the timeout to 30s? (yes/no)" }]);
    writeTranscript(cwdB, [{ role: "assistant", text: "Should I delete the legacy column? (yes/no)" }]);
    const sidA = lsm.register({ repo: "/r", title: "focused task", worktreePath: cwdA, branch: "cockpit/a" });
    const sidB = lsm.register({ repo: "/r", title: "other task", worktreePath: cwdB, branch: "cockpit/b" });

    await leng.tick();
    const itemA = leng.queue().find((x) => x.session_id === sidA);
    const itemB = leng.queue().find((x) => x.session_id === sidB);
    check("LOCK: both waiting sessions are in Up Next", !!itemA && !!itemB);
    const priA = itemA!.priority, idA = itemA!.id;

    // Operator sends a message to A's worker → it starts WORKING (last turn is a running tool call).
    // detectState marks a tool_use last-turn as WORKING regardless of recency (see unit check above).
    writeTranscript(cwdA, [
      { role: "assistant", text: "Should I bump the timeout to 30s? (yes/no)" },
      { role: "user", text: "yes, do it" },
      { role: "assistant", text: "On it — editing the config", stop_reason: "tool_use", toolUse: true },
    ]);
    const lockTick = await leng.tick();

    // THE FIX: A stays in Up Next, same item id, same priority — it was NOT re-evaluated at all.
    const stillA = leng.queue().find((x) => x.id === idA);
    check("LOCK: the focused task STAYS in Up Next while its worker is WORKING (no flicker-out)", !!stillA, "A vanished");
    check("LOCK: it is the SAME item (not re-surfaced as a new card)", !!stillA && stillA.session_id === sidA);
    check("LOCK: its priority is FROZEN (never auto-reprioritized in Up Next)", !!stillA && stillA.priority === priA, `${priA} -> ${stillA?.priority}`);
    check("LOCK: the tick reports A as locked (skipped, not surfaced/hidden)", (lockTick.locked || 0) >= 1, JSON.stringify(lockTick));

    // Re-ticking keeps it put — never duplicates, never drops.
    await leng.tick(); await leng.tick();
    const stillA2 = leng.queue().filter((x) => x.session_id === sidA);
    check("LOCK: repeated ticks neither drop nor duplicate the locked card", stillA2.length === 1, `count=${stillA2.length}`);

    // Only when the OPERATOR acts (dismiss) does it leave Up Next — the lock releases.
    lctrl.dismiss(idA);
    check("LOCK: it leaves Up Next only when the operator acts on it", !leng.queue().some((x) => x.id === idA));

    // A NOT-in-Up-Next session that goes WORKING is still never surfaced (the lock only protects
    // existing Up-Next cards; it never surfaces a working session).
    const cwdC = path.join(HOME, "lockwts", "working-fresh"); fs.mkdirSync(cwdC, { recursive: true });
    writeTranscript(cwdC, [{ role: "assistant", text: "compiling", stop_reason: "tool_use", toolUse: true }]);
    const sidC = lsm.register({ repo: "/r", title: "fresh worker", worktreePath: cwdC, branch: "cockpit/c", pid: process.pid });
    await leng.tick();
    check("LOCK: a fresh WORKING session (not in Up Next) is never surfaced", !leng.queue().some((x) => x.session_id === sidC));
    void tA;

    // SOURCE GUARDS: pin the invariant — the tick computes the locked set and skips it, and the
    // old STALE PRUNE that superseded a pending item on a WORKING flicker is gone for good.
    const ejs2 = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("LOCK(src): tick builds the locked set from pending items",
      /SELECT DISTINCT session_id FROM items WHERE status='pending'/.test(ejs2) && /lockedSessionIds/.test(ejs2));
    // b439bad: the locked block grew an in-place ETA probe (lockedEtaTick) — and later the
    // babysit-flag pull — still counted as locked and still `continue`s past detect/surface;
    // pin both the skip AND the exemptions.
    check("LOCK(src): tick skips a session that is already in Up Next",
      /if \(lockedSessionIds\.has\(s\.id\)\) \{\s*res\.locked\+\+;[\s\S]{0,900}?continue;\s*\}/.test(ejs2));
    check("LOCK(src): the locked skip still runs the in-place ETA probe (lockedEtaTick exemption)",
      /await this\.lockedEtaTick\(s\);\s*continue;/.test(ejs2));
    check("LOCK(src): a locked idle card is pulled when its pane goes babysit/waiting (scoped to state='UNKNOWN')",
      /paneBabysit\(s\.pane_id\)[\s\S]{0,200}status='superseded' WHERE session_id=\? AND status='pending' AND state='UNKNOWN'/.test(ejs2));
    // The WORKING-flicker prune pulled ANY pending item; it must stay gone. The ETA-hold prune
    // (scoped to ` AND state='UNKNOWN'`) is a DIFFERENT, deliberate pull of a low-prio idle card
    // when we learn the session is busy with a known future ETA — that one is allowed.
    check("LOCK(src): the STALE-PRUNE that dropped a pending item on a WORKING flicker is removed",
      !/UPDATE items SET status='superseded' WHERE session_id=\? AND status='pending'(?! AND state='UNKNOWN')/.test(ejs2.slice(0, ejs2.indexOf("ORPHAN PRUNE"))));

    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== PROVISIONAL GUARD: a session you opened a terminal on is never lost ==");
  {
    const gdb = openDb(path.join(HOME, "gdb.db"));
    const gsm = new SessionManager(gdb);
    const geng = new Engine(gdb, gsm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const gctrl = new Controller(gdb, geng, gsm, cfg);
    const mkProvisional = (name: string) => {
      const cwd = path.join(HOME, "gwts", name); fs.mkdirSync(cwd, { recursive: true });
      const id = gsm.register({ repo: "/r", title: "new claude session", worktreePath: cwd, branch: "cockpit/" + name });
      gdb.prepare("UPDATE sessions SET provisional=1, kind='shell' WHERE id=?").run(id);
      return id;
    };
    // a brand-new provisional session (like Ctrl+G C) that's never touched → deleted.
    const a = mkProvisional("untouched");
    check("guard: untouched provisional is deleted on detach", gctrl.cleanupOrPromoteProvisional(a).action === "deleted" && !gsm.list().some((s) => s.id === a));
    // a provisional session whose terminal was OPENED (markSessionOpened) → kept/promoted.
    const b = mkProvisional("opened");
    gctrl.markSessionOpened(b); // the WS attached (terminal opened) — no keystroke needed
    const res = gctrl.cleanupOrPromoteProvisional(b);
    check("guard: a provisional you OPENED a terminal on is kept (promoted), not deleted", res.action === "promoted" && gsm.list().some((s) => s.id === b));
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== FIX U: selection is IDENTITY-based (survives background reorder + top insert) ==");
  {
    // Replicate the renderer's reconcileSelection logic and prove the SAME task stays selected as
    // the queue reorders around it (re-rank, new top item) — only explicit nav moves it.
    const S: any = { sel: 2, selItemId: 103 };
    const reconcile = (queue: any[]) => {
      if (!queue.length) { S.sel = 0; S.selItemId = null; return; }
      if (S.selItemId != null) {
        const idx = queue.findIndex((it) => it.id === S.selItemId);
        if (idx >= 0) { S.sel = idx; return; }
        S.sel = Math.max(0, Math.min(queue.length - 1, S.sel)); S.selItemId = queue[S.sel] ? queue[S.sel].id : null; return;
      }
      S.sel = Math.max(0, Math.min(queue.length - 1, S.sel)); S.selItemId = queue[S.sel] ? queue[S.sel].id : null;
    };
    let q: any[] = [{ id: 101 }, { id: 102 }, { id: 103 }, { id: 104 }]; // task #103 selected at index 2
    reconcile(q);
    check("U: starts on the selected task (id 103 at index 2)", S.sel === 2 && S.selItemId === 103);
    // background RE-RANK reorders the queue (103 moves to index 0)
    q = [{ id: 103 }, { id: 101 }, { id: 104 }, { id: 102 }];
    reconcile(q);
    check("U: after re-rank, selection FOLLOWS the task (still id 103, index now 0)", S.selItemId === 103 && S.sel === 0);
    // ensureVirtualTop inserts a top entry (everything shifts down by 1)
    q = [{ id: -999, _virtual: true }, { id: 103 }, { id: 101 }, { id: 104 }, { id: 102 }];
    reconcile(q);
    check("U: a new top item does NOT steal selection (still id 103, index follows to 1)", S.selItemId === 103 && S.sel === 1);
    // a new WAITING task arrives at the top — selection STILL pinned to 103
    q = [{ id: 200 }, { id: -999, _virtual: true }, { id: 103 }, { id: 101 }];
    reconcile(q);
    check("U: a newly-arrived task does NOT move focus (still id 103)", S.selItemId === 103);
    // the selected task DISAPPEARS (resolved) → falls to a sensible neighbor (only then)
    q = [{ id: 200 }, { id: 101 }, { id: 104 }];
    reconcile(q);
    check("U: only when the selected task is GONE does selection move (to a neighbor)", S.selItemId !== 103 && S.selItemId != null);
  }

  console.log("\n== FIX O: visualization HTML view (vizFor matching + traversal guard) ==");
  {
    const { vizFor, resolveVizFile } = require("../core/viz");
    const vroot = path.join(HOME, "viz");
    const folder = path.join(vroot, "s3-proxy-endpoint-integration");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "throughput.html"), "<html><body>bars</body></html>");
    fs.writeFileSync(path.join(folder, "latency.html"), "<html><body>lat</body></html>");
    // NEWEST-FIRST: make throughput.html the NEWER file (alphabetical would put latency first; mtime-desc
    // must put throughput first) so the assertion actually proves the latest-by-default ordering.
    fs.utimesSync(path.join(folder, "latency.html"), new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(path.join(folder, "throughput.html"), new Date(2_000_000), new Date(2_000_000));
    const sess = { clean_title: "s3 proxy endpoint integration", title: "x", branch: "cockpit/s3-proxy" };
    const files = vizFor(vroot, sess);
    check("O: vizFor matches the folder by kebab-slug(clean_title) → returns html files NEWEST-FIRST", files.length === 2 && files[0].file === "throughput.html" && files[1].file === "latency.html");
    check("O: vizFor exposes each file's mtime (drives newest-first + the tab age label)", files[0].mtime > files[1].mtime && files[1].mtime > 0);
    check("O: a session with NO matching folder returns [] (HTML option hidden)", vizFor(vroot, { clean_title: "totally unrelated", title: "", branch: "cockpit/none" }).length === 0);
    check("O: matches by branch basename too", vizFor(vroot, { clean_title: "", title: "", branch: "cockpit/s3-proxy-endpoint-integration" }).length === 2);
    // path-traversal guard
    check("O: resolveVizFile serves a real file (by index + by name)", !!resolveVizFile(vroot, sess, "0") && !!resolveVizFile(vroot, sess, "throughput"));
    check("O: resolveVizFile BLOCKS path traversal (../, absolute)", resolveVizFile(vroot, sess, "../../etc/passwd") === null && resolveVizFile(vroot, sess, "../throughput.html") === null);

    // FIX EE: auto-detect HTML the session WROTE (transcript Write tool-call + worktree scan).
    const ewt = path.join(HOME, "ewt", "made-html");
    fs.mkdirSync(ewt, { recursive: true });
    fs.writeFileSync(path.join(ewt, "report.html"), "<html><body>report</body></html>");
    fs.mkdirSync(path.join(ewt, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(ewt, "node_modules", "junk.html"), "<html>skip</html>");
    const etPath = path.join(ewt, "session.jsonl");
    fs.writeFileSync(etPath, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: path.join(ewt, "report.html"), content: "x" } }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "wrote report.html" }] } }),
    ].join("\n") + "\n");
    const esess: any = { clean_title: "no convention match here", title: "", branch: "cockpit/made-html", worktree_path: ewt, transcript_path: etPath };
    // FIX II: an UNRELATED html in the worktree (NOT written by the session) must NOT appear.
    fs.writeFileSync(path.join(ewt, "leaderboard.html"), "<html>unrelated repo html</html>");
    const ev = vizFor(vroot, esess);
    check("EE: a session that WROTE report.html (no /visualize dir) auto-shows it", ev.some((v: any) => v.file === "report.html"));
    check("FIX II: unrelated worktree html (leaderboard.html) is NOT shown (no broad scan)", !ev.some((v: any) => v.file === "leaderboard.html"));
    check("EE: node_modules html is excluded", !ev.some((v: any) => v.file === "junk.html"));
    check("EE: serves the worktree-written file (containment to worktree_path)", !!resolveVizFile(vroot, esess, "report.html") && resolveVizFile(vroot, esess, "report.html")!.endsWith("report.html"));
    check("EE: containment still blocks files outside viz_dir AND worktree", resolveVizFile(vroot, esess, "/etc/passwd") === null && resolveVizFile(vroot, esess, "../../etc/passwd") === null);
    const noneSess: any = { clean_title: "nothing", title: "", branch: "cockpit/none", worktree_path: path.join(HOME, "ewt", "empty"), transcript_path: null };
    fs.mkdirSync(path.join(HOME, "ewt", "empty"), { recursive: true });
    check("EE: a session that wrote no html → no HTML tab", vizFor(vroot, noneSess).length === 0);

    // FIX KK: a session that WROTE html OUTSIDE its worktree must still be served by resolveVizFile
    // (the vizFor list IS the whitelist — no separate viz_dir/worktree containment re-derivation).
    const outDir = path.join(HOME, "outside-wt");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "external.html"), "<html>outside the worktree</html>");
    const kwt = path.join(HOME, "kwt");
    fs.mkdirSync(kwt, { recursive: true });
    const ktPath = path.join(kwt, "session.jsonl");
    fs.writeFileSync(ktPath, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { file_path: path.join(outDir, "external.html"), content: "x" } }] } }),
    ].join("\n") + "\n");
    const ksess: any = { clean_title: "kk session", title: "", branch: "cockpit/kk", worktree_path: kwt, transcript_path: ktPath };
    check("FIX KK: vizFor lists html the session wrote OUTSIDE its worktree", vizFor(vroot, ksess).some((v: any) => v.file === "external.html"));
    check("FIX KK: resolveVizFile SERVES that out-of-worktree file (list is the whitelist) → 200", !!resolveVizFile(vroot, ksess, "external.html") && resolveVizFile(vroot, ksess, "external.html")!.endsWith("external.html"));
    check("FIX KK: a name NOT in the session's list → null (404), no traversal", resolveVizFile(vroot, ksess, "not-listed.html") === null && resolveVizFile(vroot, ksess, "../../etc/passwd") === null);

    // FIX EE2: html the session produced ANY way is detected — generated by a Bash-run script
    // (no Write tool call), or written EARLIER than the old 256KB tail window. And html merely
    // MENTIONED that pre-existed the session (old reports, vendored index.html) must NOT appear.
    const b2wt = path.join(HOME, "ee2wt");
    fs.mkdirSync(path.join(b2wt, "scripts", "unified_eval"), { recursive: true });
    const oldHtml = path.join(b2wt, "scripts", "old_dashboard.html");
    fs.writeFileSync(oldHtml, "<html>old</html>");
    const past = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(oldHtml, past, past); // pre-existing: mtime 1h BEFORE the session starts
    const b2t = path.join(b2wt, "session.jsonl");
    const earlyHtml = path.join(b2wt, "early.html");
    const filler = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(2000) }] } });
    fs.writeFileSync(b2t, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: earlyHtml, content: "x" } }] } }),
      ...Array.from({ length: 200 }, () => filler), // ~400KB → the Write above is OUTSIDE a 256KB tail
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "python scripts/gen.py -o scripts/unified_eval/report_charts.html" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `see ${oldHtml} for the previous numbers` }] } }),
    ].join("\n") + "\n");
    fs.writeFileSync(earlyHtml, "<html>early</html>");
    const genHtml = path.join(b2wt, "scripts", "unified_eval", "report_charts.html");
    fs.writeFileSync(genHtml, "<html>charts</html>");
    const b2sess: any = { clean_title: "ee2 session", title: "", branch: "cockpit/ee2", worktree_path: b2wt, transcript_path: b2t };
    const b2v = vizFor(vroot, b2sess);
    check("FIX EE2: html generated via a Bash command (relative path, NO Write call) is detected", b2v.some((v: any) => v.file === "report_charts.html"));
    check("FIX EE2: a Write EARLIER than the last 256KB is still detected (whole-transcript scan)", b2v.some((v: any) => v.file === "early.html"));
    check("FIX EE2: pre-existing html merely MENTIONED (mtime older than the session) is NOT listed", !b2v.some((v: any) => v.file === "old_dashboard.html"));
    check("FIX EE2: the Bash-generated file is SERVED by resolveVizFile", !!resolveVizFile(vroot, b2sess, "report_charts.html"));

    // FIX EE2: a mentioned html CREATED only AFTER the mention (the command echoes the output
    // path first, the script writes the file later) appears on the NEXT poll — the mention set
    // persists per transcript and existence/mtime are re-checked every call, so NO new
    // transcript bytes are needed for it to surface.
    const lwt = path.join(HOME, "ee2-late");
    fs.mkdirSync(path.join(lwt, "scripts"), { recursive: true });
    const lt = path.join(lwt, "session.jsonl");
    fs.writeFileSync(lt, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "python scripts/gen.py -o scripts/late_report.html" } }] } }) + "\n");
    const lsess: any = { clean_title: "ee2 late create", title: "", branch: "cockpit/ee2-late", worktree_path: lwt, transcript_path: lt };
    check("FIX EE2: a mentioned html that does NOT exist (yet) is not listed", vizFor(vroot, lsess).length === 0);
    fs.writeFileSync(path.join(lwt, "scripts", "late_report.html"), "<html>late</html>");
    check("FIX EE2: ...and it APPEARS once the file is created (no new transcript bytes needed)", vizFor(vroot, lsess).some((v: any) => v.file === "late_report.html"));

    // FIX EE2: transcript truncation/rewrite (size shrinks below the scan cursor) RESETS the
    // scan state — findings from the discarded content are dropped, the new content is
    // re-scanned from byte 0 (compaction / transcript rewrite safety).
    const twt = path.join(HOME, "ee2-trunc");
    fs.mkdirSync(twt, { recursive: true });
    fs.writeFileSync(path.join(twt, "ghost.html"), "<html>ghost</html>");
    fs.writeFileSync(path.join(twt, "kept.html"), "<html>kept</html>");
    const tt = path.join(twt, "session.jsonl");
    const pad = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "y".repeat(500) }] } });
    fs.writeFileSync(tt, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `generated ${path.join(twt, "ghost.html")}` }] } }),
      pad, pad, pad, pad,
    ].join("\n") + "\n");
    const tsess: any = { clean_title: "ee2 truncate", title: "", branch: "cockpit/ee2-trunc", worktree_path: twt, transcript_path: tt };
    check("FIX EE2: mentioned html is listed before the rewrite", vizFor(vroot, tsess).some((v: any) => v.file === "ghost.html"));
    // SHORTER rewrite of the same transcript → st.size < scan cursor → full reset + rescan
    fs.writeFileSync(tt, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `generated ${path.join(twt, "kept.html")}` }] } }) + "\n");
    const tv = vizFor(vroot, tsess);
    check("FIX EE2: a truncated/rewritten transcript RESETS the scan (stale finding dropped)", !tv.some((v: any) => v.file === "ghost.html"));
    check("FIX EE2: ...and the rewritten content is re-scanned from byte 0", tv.some((v: any) => v.file === "kept.html"));

    // FIX EE2: >4MB catch-up — a huge transcript is scanned in bounded per-call slices
    // (SCAN_MAX_PER_CALL) so one tick never reads it all; the cursor advances and content
    // BEYOND the first slice surfaces on the NEXT call.
    const bwt = path.join(HOME, "ee2-big");
    fs.mkdirSync(bwt, { recursive: true });
    const bt = path.join(bwt, "session.jsonl");
    const earlyBig = path.join(bwt, "early_big.html");
    const bigFill = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "z".repeat(2048) }] } });
    fs.writeFileSync(bt, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: earlyBig, content: "x" } }] } }),
      ...Array.from({ length: 2600 }, () => bigFill), // ~5.5MB → the tail sits OUTSIDE the first 4MB slice
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "python gen.py -o tail_chart.html" } }] } }),
    ].join("\n") + "\n");
    fs.writeFileSync(earlyBig, "<html>early big</html>");
    fs.writeFileSync(path.join(bwt, "tail_chart.html"), "<html>tail</html>");
    const bsess: any = { clean_title: "ee2 big transcript", title: "", branch: "cockpit/ee2-big", worktree_path: bwt, transcript_path: bt };
    const call1 = vizFor(vroot, bsess);
    check("FIX EE2: call 1 of a >4MB transcript finds what's in the FIRST slice", call1.some((v: any) => v.file === "early_big.html"));
    check("FIX EE2: call 1 does NOT yet see the tail (bounded per-call read)", !call1.some((v: any) => v.file === "tail_chart.html"));
    const call2 = vizFor(vroot, bsess);
    check("FIX EE2: call 2 catches up — the tail mention is found (incremental cursor)", call2.some((v: any) => v.file === "tail_chart.html"));

    // FIX EE2: SCAN_MAX_MENTIONS guard — a pathological transcript mentioning a zillion html
    // paths is capped at 64 mention-tier tabs; the explicit (Write/Edit) tier has its own larger cap (128).
    const cwt = path.join(HOME, "ee2-cap");
    fs.mkdirSync(cwt, { recursive: true });
    const capLines: string[] = [];
    for (let i = 0; i < 80; i++) {
      const f = path.join(cwt, `m${i}.html`);
      fs.writeFileSync(f, "<html>m</html>");
      capLines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `made ${f}` }] } }));
    }
    const expl = path.join(cwt, "explicit_after_cap.html");
    fs.writeFileSync(expl, "<html>e</html>");
    capLines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: expl, content: "x" } }] } }));
    const ct = path.join(cwt, "session.jsonl");
    fs.writeFileSync(ct, capLines.join("\n") + "\n");
    const csess: any = { clean_title: "ee2 cap", title: "", branch: "cockpit/ee2-cap", worktree_path: cwt, transcript_path: ct };
    const cv = vizFor(vroot, csess);
    const capMentions = cv.filter((v: any) => /^m\d+\.html$/.test(v.file)).length;
    check("FIX EE2: mention detection is capped at SCAN_MAX_MENTIONS (64) — no unbounded tabs", capMentions <= 64 && capMentions >= 60);
    check("FIX EE2: at the cap the OLDEST mentions are evicted, newest win (junk can't disable detection)", cv.some((v: any) => v.file === "m79.html") && !cv.some((v: any) => v.file === "m0.html"));
    check("FIX EE2: an EXPLICIT Write past the mention cap is still detected (cap is mention-tier only)", cv.some((v: any) => v.file === "explicit_after_cap.html"));

    // EE2-sec: mentions come from semi-untrusted transcript text, so they are contained to
    // worktree/viz_dir/configured mention roots, hidden dirs are rejected, and a READ of someone
    // else's html does NOT count as "the session produced it".
    const swt = path.join(HOME, "ee2-sec");
    fs.mkdirSync(path.join(swt, ".cache"), { recursive: true });
    const outside = path.join(HOME, "ee2-outside"); // NOT under the worktree or viz_dir
    fs.mkdirSync(outside, { recursive: true });
    const st2 = path.join(swt, "session.jsonl");
    fs.writeFileSync(st2, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `made ${path.join(outside, "leak.html")} and ${path.join(swt, ".cache", "hidden.html")}` }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(outside, "read-only.html") } }] } }),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(outside, "leak.html"), "<html>leak</html>");
    fs.writeFileSync(path.join(swt, ".cache", "hidden.html"), "<html>hidden</html>");
    fs.writeFileSync(path.join(outside, "read-only.html"), "<html>read</html>");
    const ssess: any = { clean_title: "ee2 sec", title: "", branch: "cockpit/ee2-sec", worktree_path: swt, transcript_path: st2 };
    const sv = vizFor(vroot, ssess);
    check("EE2-sec: a mentioned html OUTSIDE worktree/viz_dir/mention-roots is NOT listed", !sv.some((v: any) => v.file === "leak.html"));
    check("EE2-sec: a mentioned html under a HIDDEN dir (.cache) is NOT listed", !sv.some((v: any) => v.file === "hidden.html"));
    check("EE2-sec: a READ tool's file_path does NOT count as session-produced html", !sv.some((v: any) => v.file === "read-only.html"));
    // …but a configured viz_mention_roots entry opts that location back in (fresh transcript —
    // containment is applied at scan time, so the roots must be present on the FIRST scan).
    const owt = path.join(HOME, "ee2-optin");
    fs.mkdirSync(owt, { recursive: true });
    const ot = path.join(owt, "session.jsonl");
    fs.writeFileSync(ot, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `made ${path.join(outside, "leak.html")}` }] } }) + "\n");
    const osess: any = { clean_title: "ee2 optin", title: "", branch: "cockpit/ee2-optin", worktree_path: owt, transcript_path: ot };
    check("EE2-sec: a configured viz_mention_roots entry opts that location back in", vizFor(vroot, osess, [outside]).some((v: any) => v.file === "leak.html"));

    // EE2-edge: linear-scanner token boundaries + case. The indexOf+charcode walk replaced an
    // unanchored regex — make sure it still catches a token at the VERY FIRST byte of the
    // transcript, at the VERY LAST byte (no trailing newline), an UPPERCASE .HTML, and that
    // .htmx (longer-extension lookahead) is NOT mistaken for html.
    const xwt = path.join(HOME, "ee2-edge");
    fs.mkdirSync(xwt, { recursive: true });
    const xt = path.join(xwt, "session.jsonl");
    fs.writeFileSync(xt, [
      "boundary_start.html was written first", // token IS the first bytes of the chunk
      `then Caps_Report.HTML in mixed case and ${path.join(xwt, "framework.htmx")} (not html)`,
      "and finally boundary_end.html", // token is the LAST bytes — no trailing newline
    ].join("\n"));
    for (const f of ["boundary_start.html", "Caps_Report.HTML", "framework.htmx", "boundary_end.html"])
      fs.writeFileSync(path.join(xwt, f), "<html>x</html>");
    const xsess: any = { clean_title: "ee2 edge", title: "", branch: "cockpit/ee2-edge", worktree_path: xwt, transcript_path: xt };
    const xv = vizFor(vroot, xsess);
    check("EE2-edge: a mention at the VERY FIRST byte of the transcript is detected", xv.some((v: any) => v.file === "boundary_start.html"));
    check("EE2-edge: a mention at the VERY LAST byte (no trailing newline) is detected", xv.some((v: any) => v.file === "boundary_end.html"));
    check("EE2-edge: UPPERCASE .HTML is detected (scan is case-insensitive, path keeps case)", xv.some((v: any) => v.file === "Caps_Report.HTML"));
    check("EE2-edge: a .htmx mention is NOT treated as html", !xv.some((v: any) => v.file === "framework.htmx"));

    // EE2-r2: real cockpit worktrees live under `.cockpit-worktrees/…` — the hidden-component
    // check must apply RELATIVE to the matched containment root, or the whole mention tier dies
    // for every cockpit-launched session (round-2 finding).
    const hwt = path.join(HOME, "repo", ".cockpit-worktrees", "sess-1");
    fs.mkdirSync(path.join(hwt, "scripts"), { recursive: true });
    const ht = path.join(hwt, "session.jsonl");
    fs.writeFileSync(ht, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "python gen.py -o scripts/report.html" } }] } }) + "\n");
    fs.writeFileSync(path.join(hwt, "scripts", "report.html"), "<html>r</html>");
    const hsess: any = { clean_title: "ee2 hidden wt", title: "", branch: "cockpit/ee2-hwt", worktree_path: hwt, transcript_path: ht };
    check("EE2-r2: a mention inside a `.cockpit-worktrees/…` worktree IS detected (hidden check is root-relative)", vizFor(vroot, hsess).some((v: any) => v.file === "report.html"));

    // EE2-r2: parallel tool calls share ONE jsonl line — a Read's html file_path must not ride
    // into the explicit tier on a preceding Write/Edit's name (tempered keyRe window).
    const pwt = path.join(HOME, "ee2-parallel");
    fs.mkdirSync(pwt, { recursive: true });
    const vendored = path.join(pwt, "vendored.html");
    fs.writeFileSync(vendored, "<html>vendored</html>");
    fs.utimesSync(vendored, (Date.now() - 3_600_000) / 1000, (Date.now() - 3_600_000) / 1000); // pre-session
    const pt = path.join(pwt, "session.jsonl");
    const ownHtml = path.join(pwt, "own.html");
    fs.writeFileSync(pt, JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", name: "Edit", input: { file_path: path.join(pwt, "src", "a.ts"), old_string: "x", new_string: "y" } },
      { type: "tool_use", name: "Read", input: { file_path: vendored } },
      { type: "tool_use", name: "Write", input: { file_path: ownHtml, content: "z" } },
    ] } }) + "\n");
    fs.writeFileSync(ownHtml, "<html>own</html>");
    const psess: any = { clean_title: "ee2 parallel", title: "", branch: "cockpit/ee2-par", worktree_path: pwt, transcript_path: pt };
    const pv = vizFor(vroot, psess);
    check("EE2-r2: a parallel Read's html on the same line does NOT enter the explicit tier", !pv.some((v: any) => v.file === "vendored.html"));
    check("EE2-r2: the genuine Write on that same line IS detected", pv.some((v: any) => v.file === "own.html"));

    // EE2-r2: at the cap, the sweep drops never-displayable junk (exists but pre-session mtime)
    // so a currently-displayed legit tab is not FIFO-evicted by an `ls`-output flood.
    const fwt = path.join(HOME, "ee2-flood");
    fs.mkdirSync(fwt, { recursive: true });
    const ft = path.join(fwt, "session.jsonl");
    const floodLines: string[] = [];
    floodLines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `made ${path.join(fwt, "legit.html")}` }] } }));
    for (let i = 0; i < 70; i++) {
      const f = path.join(fwt, `junk${i}.html`);
      fs.writeFileSync(f, "<html>j</html>");
      fs.utimesSync(f, (Date.now() - 3_600_000) / 1000, (Date.now() - 3_600_000) / 1000); // exists, but pre-session
      floodLines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `saw ${f}` }] } }));
    }
    fs.writeFileSync(ft, floodLines.join("\n") + "\n");
    fs.writeFileSync(path.join(fwt, "legit.html"), "<html>legit</html>");
    const fsess: any = { clean_title: "ee2 flood", title: "", branch: "cockpit/ee2-flood", worktree_path: fwt, transcript_path: ft };
    check("EE2-r2: an old-junk mention flood does NOT evict the displayed legit tab (dead-sweep at cap)", vizFor(vroot, fsess).some((v: any) => v.file === "legit.html"));
  }

  console.log("\n== FIX Q: cc-daemon fd-holder is NOT a live session ==");
  {
    // Mirror the daemon-detection predicate from controller.isCcDaemon and assert it classifies
    // the daemon supervisor vs a real session process correctly.
    const isDaemon = (cmd: string) => {
      const c = cmd.replace(/\0/g, " ").trim().toLowerCase();
      return c.includes("daemon run") || /(^|\/|\s)claude\s+daemon\b/.test(c) || c.includes("cc-daemon");
    };
    const NUL = "\x00";
    const daemonCmd = ["/home/dev/.local/bin/claude", "daemon", "run", "--json-path", "/home/dev/.claude/daemon.json"].join(NUL);
    const resumeCmd = ["/home/dev/.local/bin/claude", "--resume", "90735064-8e14-4523-b248-fdd8dd547269", "--dangerously-skip-permissions"].join(NUL);
    const interactiveCmd = ["node", "/home/dev/.local/bin/claude"].join(NUL);
    check("Q: `claude daemon run` cmdline → IS the daemon (fd does NOT make session live)", isDaemon(daemonCmd) === true);
    check("Q: `claude --resume <id>` cmdline → NOT the daemon (fd DOES make session live)", isDaemon(resumeCmd) === false);
    check("Q: a plain interactive claude → NOT the daemon", isDaemon(interactiveCmd) === false);
  }

  console.log("\n== Purge stale demo-worktrees sessions (path-only, safe) ==");
  {
    const { purgeDemoArtifacts } = require("../core/db");
    // a stale demo session (under data/demo-worktrees) and a GENUINE session that merely
    // shares a demo-like title — only the path-matched one must be purged.
    const demoCwd = path.join(HOME, "data", "demo-worktrees", "server-port");
    fs.mkdirSync(demoCwd, { recursive: true });
    const demoId = sm.register({ repo: "demo", title: "wire up server port", worktreePath: demoCwd, branch: "cockpit/demo-x" });
    const realCwd = path.join(HOME, "real-repo-server-port");
    fs.mkdirSync(realCwd, { recursive: true });
    const realId = sm.register({ repo: "/repo/real", title: "wire up server port", worktreePath: realCwd, branch: "cockpit/real-x" });
    const before = purgeDemoArtifacts(db);
    check("purge removed the data/demo-worktrees session", !sm.list().some((s) => s.id === demoId), `purged sessions=${before.sessions}`);
    check("purge KEPT the genuine title-matching session", sm.list().some((s) => s.id === realId));
    // idempotent: second run removes nothing
    const second = purgeDemoArtifacts(db);
    check("purge is idempotent (second run removes 0)", second.sessions === 0);
  }

  console.log("\n== Layout: three-region (queue | Pane A | Pane B) ==");
  {
    const html = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8");
    check("queue column renders BEFORE pane A (left layout)", html.indexOf('id="queue-col"') < html.indexOf('id="pane-A"'));
    check("pane A renders BEFORE pane B", html.indexOf('id="pane-A"') < html.indexOf('id="pane-B"'));
    check("two draggable resizers present", html.includes('id="rz-q"') && html.includes('id="rz-ab"'));
    check("the single movable terminal host present", html.includes('id="term-host"'));
    check("terminal full-screen power-mode controls present (button + hint)", html.includes('id="term-full-btn"') && html.includes('id="term-fullhint"'));
    const km = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/keymap.json"), "utf8"));
    check("keymap defines a configurable master key (default C-g)", km.master === "C-g");
    check("keymap no longer uses the old Ctrl+B leader / Ctrl+] escape", !km.leader && !km.term_escape);
    check("Transcript tab removed from both panes", !html.includes('data-mode="transcript"'));
    check("no Transcript references left in index.html", !/transcript/i.test(html));
    check("diff-overlay popup removed from index.html (diff is inline-only)", !html.includes('id="diff-overlay"'));
    check("no diff-overlay references left in renderer source", !fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8").includes("diff-overlay"));
    // TERMINAL-FIRST (operator request 2026-06-10): landing on a task focuses the terminal pane;
    // plain ↑/↓ walk the queue from inside the terminal; all action keys gated behind the master.
    {
      const rjsTF = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
      check("terminal-first: default focus = pane B when its view is terminal (A for PR/diff tasks)",
        /function defaultFocus[^]*?paneDefault\("B", it\) === "terminal" \? "B" : "A";\s*\n\}/.test(rjsTF));
      check("terminal-first: plain ↑/↓ inside the xterm walk the QUEUE on a fresh landing",
        /ArrowUp" \|\| e\.key === "ArrowDown"\) && !e\.ctrlKey && !e\.altKey && !e\.metaKey\) \{[^]*?moveQueueSel\(e\.key === "ArrowUp" \? -1 : 1\)/.test(rjsTF));
      check("type-aware nav: Shift+↑/↓ OR typed-since-nav sends a REAL arrow to the pty",
        /if \(e\.shiftKey \|\| _termTypedSinceNav\) \{ _termTypedSinceNav = true; termSendInput\(e\.key === "ArrowUp" \? "\\x1b\[A" : "\\x1b\[B"\); \}/.test(rjsTF));
      // TYPE-AWARE NAV (operator request 2026-06-11): typing/pasting into the terminal hands
      // plain ↑/↓ to the pty; an explicit task nav (selectIndex) re-arms queue mode.
      check("type-aware nav: a real keystroke into the pty arms _termTypedSinceNav",
        /e\.key !== "Meta"\) \{\s*\n\s*_termTypedSinceNav = true;/.test(rjsTF));
      check("type-aware nav: paste into the terminal also arms _termTypedSinceNav",
        /_termTypedSinceNav = true; \/\/ TYPE-AWARE NAV: pasting counts as typing here/.test(rjsTF));
      check("type-aware nav: explicit nav (selectIndex) re-arms queue mode",
        /function selectIndex[^]*?_termTypedSinceNav = false;/.test(rjsTF));
      // SCROLL FIX (operator report 2026-06-11): in the alt buffer with mouse tracking off/lost,
      // xterm.js turns the wheel into ↑/↓ arrows → claude cycles prompt history instead of
      // scrolling. The custom wheel handler must (a) leave the healthy mouse-report path alone,
      // (b) write the SGR wheel report itself otherwise, and (c) NEVER let xterm synth arrows.
      check("scroll fix: custom wheel handler installed on the xterm",
        rjsTF.includes("term.attachCustomWheelEventHandler"));
      check("scroll fix: healthy mouse-tracking path is left to xterm (return true)",
        /modes\.mouseTrackingMode !== "none"\) return true;/.test(rjsTF));
      check("scroll fix: lost-state alt-buffer wheel sends an SGR wheel report to the pty",
        /\\x1b\[<\$\{btn\};\$\{col\};\$\{row\}M/.test(rjsTF) && /btn = n < 0 \? 64 : 65/.test(rjsTF));
      check("scroll fix: handled wheel returns false so xterm can't synthesize arrow keys",
        /termSendInput\(`\\x1b\[<\$\{btn\};\$\{col\};\$\{row\}M`\.repeat[^]*?return false; \/\/ handled/.test(rjsTF));
      check("gated keys: the old DIRECT single-key action switch is GONE from the global handler",
        !/case km\.pin_toggle:/.test(rjsTF) && !/case km\.snooze:/.test(rjsTF) && !/case km\.feedback_priority_high:/.test(rjsTF) && !/if \(e\.key === "1"\) \{ e\.preventDefault\(\); setPaneView\("A", "overview"\)/.test(rjsTF));
      check("gated keys: master dispatch carries the actions (H/L rank, I importance, p pin, Z snooze)",
        /e\.key === "H"\) \{ showReasonInput\("up"\)/.test(rjsTF) && /e\.key === "L"\) \{ showReasonInput\("down"\)/.test(rjsTF) && /e\.key === "I"\) \{ showManualImportance\(\)/.test(rjsTF) && /e\.key === "p" \|\| e\.key === "P"\) \{ void togglePin\(\)/.test(rjsTF) && /e\.key === "Z"\)/.test(rjsTF));
    }
    check("terminal refit uses a ResizeObserver (not per-render fit)", fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8").includes("new ResizeObserver"));
    const rjs = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
    check("no legacy `g`=Diff alias in the master switch (collides with Ctrl+G)", !/case\s+"d":\s*case\s+"g":/.test(rjs) && !/case\s+"g":\s*setPaneView\([^)]*"diff"/.test(rjs));
    check("master key arming guards auto-repeat (e.repeat)", /if \(!e\.repeat\) startMaster\(\)/.test(rjs));
    check("terminal pane body gets full-height flex class", rjs.includes('pane-body--term') && fs.readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8").includes('.pane-body.pane-body--term'));
    // WS-reuse: fullscreen/move/re-render must NOT close+reopen the terminal socket
    check("attachTerminalSession is idempotent for the same session (no WS churn)", /readyState === 0 \|\| S\.termWs\.readyState === 1[^]*?applyKeyboardTarget\(\);\s*\n\s*return;/.test(rjs));
    check("maximize keeps the host in its pane (no lift-to-<body>, no body.term-full hide)", !rjs.includes("document.body.appendChild(host)") && !rjs.includes('"term-full"'));
    check("maximize collapses to a full-width focused pane via grid (queue stays)", /if \(S\.fullPane\) \{[^]*?gridTemplateColumns/.test(rjs) && rjs.includes('"term-max"'));
    check("master+↑/↓ navigate the queue; master+Enter dismisses", rjs.includes("moveQueueSel(-1)") && rjs.includes("moveQueueSel(1)") && rjs.includes("dismissCurrentTask()"));
    check("default split is 40/60 (pane_a_frac_default=0.4)", JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/weights.json"), "utf8")).pane_a_frac_default === 0.4);
    const srvjs = fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8");
    check("favicon route returns 204 (no 404 spam)", /favicon\.ico"\)\s*\{\s*res\.writeHead\(204\)/.test(srvjs));
    const sessjs = fs.readFileSync(path.resolve(__dirname, "../../src/core/sessions.ts"), "utf8");
    // FIX D: attach ONLY to a cockpit-launched canonical session (no cwd-match fallback that would
    // grab the wrong shared-cwd pane). No safe pane → null → caller shows own transcript read-only.
    check("real attach uses the cockpit canonical name + ignore-size (no cwd-match fallback)", /attach-session", "-f", "ignore-size", "-t", cn/.test(sessjs) && sessjs.includes("do NOT fall back to cwd-matching"));
    // SIZE FIX (2026-06-09): a freshly-launched session's tmux window is created at tmux's 80×24
    // default and the WS attach uses `-f ignore-size`, so without an explicit resize it stays 80×24
    // → claude draws a tiny box in the TOP-LEFT of the xterm. The canonical (dedicated) attach now
    // carries `resizeName: cn` and the server `resize-window`s it to the client size (on attach AND
    // on live resizes). The FOREIGN live-pane attach must NOT set it (never resize the operator's pane).
    check("dedicated cockpit attach returns resizeName for explicit window sizing", /ignore-size", "-t", cn\], env: envNoTmux\(\), resizeName: cn/.test(sessjs));
    check("foreign live-pane attach does NOT set resizeName (never resize the operator's own pane)", !/select-pane[\s\S]{0,120}resizeName/.test(sessjs));
    check("server resize-windows the dedicated session to the client size on attach", srvjs.includes("function tmuxResizeWindow(") && /if \(spec\.resizeName\) tmuxResizeWindow\(spec\.resizeName, cols, rows/.test(srvjs));
    check("server propagates LIVE resizes to the tmux window (onResize → resize-window)", srvjs.includes("if (onResize) try { onResize(msg.cols, msg.rows)") && /spec\.resizeName \? \(c, r\) => tmuxResizeWindow\(spec\.resizeName!, c, r/.test(srvjs));
    const discjs = fs.readFileSync(path.resolve(__dirname, "../../src/core/discover.ts"), "utf8");
    check("discovery filters orchestration trees + build/probe prompts", discjs.includes('".claude"') && discjs.includes('".openclaw"') && discjs.includes("Use ultrathink") && discjs.includes("Say: result:"));
    // REGRESSION (2026-06-09): the session→pane mapping. CWD-match → "clicking any session shows my
    // own 3-pane tmux window" (every same-cwd session → one pane); transcript-fd match → "everything
    // read-only" (the .jsonl fd is held by the cc-daemon, not the pane, so it matched nothing for
    // interactive agents). The mapping that works: each `claude agents --json` agent's pid → walk the
    // process tree up to its tmux pane (paneForPid) → that agent's OWN pane. Daemon agents (pid not
    // under a pane) → no pane → honest read-only. Lock that in; cwd-match must never return.
    check("discovery maps sessions→panes by agent pid → process-tree walk (paneBySession), NOT shared cwd", discjs.includes("paneBySession.get(sessId)") && discjs.includes("listClaudeAgents()") && discjs.includes("paneForPid(a.pid") && !discjs.includes("livePaneByCwd"));
    // REGRESSION (2026-06-09): the server runs under `systemd --user` with a minimal PATH that omits
    // ~/.local/bin (where `claude` lives) → `claude agents --json` returns nothing → the pane mapping
    // is empty → EVERY session shows read-only. Guard both the launch PATH and the in-code env.
    check("server spawns get ~/.local/bin on PATH so `claude` resolves (discover envNoTmux)", discjs.includes(".local/bin") && /e\.PATH\s*=/.test(discjs));
    check("restart.sh passes PATH incl ~/.local/bin to the systemd-run server units", fs.readFileSync(path.resolve(__dirname, "../../scripts/restart.sh"), "utf8").includes("--setenv=PATH=") && fs.readFileSync(path.resolve(__dirname, "../../scripts/restart.sh"), "utf8").includes(".local/bin"));
    check("engine prunes stale/orphan pending items", fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8").includes("status='superseded'"));
    // P4: direct-pty (claude --resume) terminal with double-run guard + WS NoDelay
    check("server reuses a per-session direct pty (no respawn)", srvjs.includes("directPtys") && srvjs.includes("REUSE an existing direct pty"));
    check("server direct-spawns claude --resume for non-live sessions", srvjs.includes("directResumeSpec") && srvjs.includes("livenessForOpen"));
    check("WS terminal socket disables Nagle (setNoDelay)", srvjs.includes("setNoDelay(true)"));
    const ctrljs = fs.readFileSync(path.resolve(__dirname, "../../src/core/controller.ts"), "utf8");
    check("directResumeSpec builds claude --resume --dangerously-skip-permissions", ctrljs.includes('"--resume"') && ctrljs.includes('"--dangerously-skip-permissions"'));
    // FIX FF: the resume terminal runs inside a per-session tmux (so Ctrl+B splits work + persists).
    check("FIX FF: direct-resume wraps claude in `tmux new-session -A -s claudeos-<id>` (default socket, no -f)", /tmux"[^]*?"new-session", "-A", "-s", `claudeos-\$\{sessionId\}`, "-c", cwd, inner/.test(ctrljs) && ctrljs.includes("delete env.TMUX") && !ctrljs.includes('"-f"'));
    // LOCAL terminal (Electron): server returns the durable tmux + ssh host; client runs ssh locally.
    check("LOCAL-TERM: controller.localTermSpec ensures the session detached (-A -d) and returns `tmux attach -t claudeos-<id>`", ctrljs.includes("localTermSpec(") && /"-d"/.test(ctrljs) && ctrljs.includes("tmux attach -t ${sessionName}") && ctrljs.includes('spec.cmd !== "tmux"'));
    check("LOCAL-TERM: /api/term-spec endpoint returns ctrl.localTermSpec(sid, SSH_HOST)", srvjs.includes('"/api/term-spec"') && srvjs.includes("ctrl.localTermSpec(sid, SSH_HOST)"));
    check("LOCAL-TERM: renderer prefers the native ssh bridge when present, else the streamed WS", rjs.includes("function nativeTerm()") && rjs.includes("if (nativeTerm()) openTermNative(sid, term);") && rjs.includes("else openTermWs(sid, term);") && /openTermNative[^]*?\/api\/term-spec[^]*?openTermWs\(sid, term\)/.test(rjs));
    check("LOCAL-TERM: input + resize route to whichever transport is live (native or WS)", rjs.includes("function termSendInput(") && rjs.includes("function termSendResize(") && /S\.termNative && n\) \{ try \{ n\.write/.test(rjs));
    const mainjs = fs.readFileSync(path.resolve(__dirname, "../../desktop/main.js"), "utf8");
    check("LOCAL-TERM: desktop bridge spawns `ssh -tt <host> <remote>` in a real pty (node-pty in main)", /pty\.spawn\(resolveSsh\(\), \["-tt"/.test(mainjs) && fs.readFileSync(path.resolve(__dirname, "../../desktop/preload.js"), "utf8").includes('exposeInMainWorld("claudeosNative"'));
    // GUARD (2026-06-09): ConPTY on Windows does NOT search %PATH% → must pass an ABSOLUTE ssh.exe
    // path or WindowsPtyAgent throws "file not found". Lock the absolute-path resolver so nobody
    // reverts to bare "ssh".
    check("LOCAL-TERM: ssh is launched via an ABSOLUTE path (resolveSsh → OpenSSH\\ssh.exe), never bare \"ssh\" (ConPTY 'file not found')", /function resolveSsh\(\)/.test(mainjs) && mainjs.includes("OpenSSH\\\\ssh.exe") && !mainjs.includes('pty.spawn("ssh"'));
    // GUARD: if node-pty can't load (e.g. not built), the app must DEGRADE to the streamed WS, never crash.
    check("LOCAL-TERM: node-pty require is guarded → degrades to WS, never crashes the app", /try \{ pty = require\("node-pty"\); \} catch/.test(mainjs) && mainjs.includes("fall back to streamed WS"));
    // GUARD: the terminal must stay LOCAL — /api/term-spec is pure data (host + `tmux attach` remote),
    // it must NEVER spawn/stream a pty server-side (that's the WebSocket path we moved away from).
    check("LOCAL-TERM: /api/term-spec is pure data (returns a tmux-attach remote, spawns NO server-side pty)", ctrljs.includes("tmux attach -t ${sessionName}") && /localTermSpec[^]*?return\s*\{[^}]*remote/.test(ctrljs) && !/localTermSpec[\s\S]{0,400}pty\.spawn/.test(ctrljs));
    check("FIX FF: Ctrl+B passes through to the inner tmux (xterm only intercepts the master key)", !/e\.key === "b"[^]*?return false/.test(rjs) && rjs.includes("Ctrl+B (now 100% the inner tmux's)"));
    // FIX GG: dismiss/snooze/close must NOT kill the claude; WS-close only detaches (tmux persists).
    check("FIX GG: WS close only DETACHES the resume pty (keep claude alive), never kills it", /wireTermWs\(ws, term, sessionId, \(\) => \{ if \(reg\.ws === ws\) reg\.ws = null;[^]*?GG: keep claude alive/.test(srvjs));
    // FIX HH: Ctrl+G f fullscreens the FOCUSED pane's view (any), not just terminal.
    check("FIX HH: setPaneFull maximizes any focused view; master m → setPaneFull(P)", rjs.includes("function setPaneFull") && /case "m": case "z":[^]*?setPaneFull\(P\)/.test(rjs) && /if \(S\.fullPane\) \{[^]*?const aFr = S\.fullPane === "A"/.test(rjs));
    check("FIX HH: fullscreen no longer forces the terminal view (works for diff/html/overview)", !/case "f": case "z":[^]*?setPaneView\(P, "terminal"\)/.test(rjs) && rjs.includes('fullPane: "A" | "B" | null'));
    // FIX II: HTML only task-created (drop broad worktree scan).
    check("FIX II: vizFor drops the broad worktree scan (no worktreeHtml)", !fs.readFileSync(path.resolve(__dirname, "../../src/core/viz.ts"), "utf8").includes("function worktreeHtml") && fs.readFileSync(path.resolve(__dirname, "../../src/core/viz.ts"), "utf8").includes("no broad worktree scan"));
    // Crash-resilience: a bad terminal must not crash the server.
    check("crash-resilience: uncaughtException/unhandledRejection guards + contained attachTerminal", srvjs.includes('process.on("uncaughtException"') && srvjs.includes('process.on("unhandledRejection"') && /attachTerminal\(ws as any, sid, cols, rows\)\.catch/.test(srvjs));
    check("FIX GG: dismiss touches only the item (no terminal kill) — claude keeps running", (() => {
      const m = ctrljs.match(/dismiss\(itemId: number\): void \{([\s\S]*?)\n  \}/);
      const body = m ? m[1] : "";
      return body.includes("UPDATE items SET status='decided'") && !/kill|tmux|\.term|pty|sessions\./.test(body);
    })());
    check("WebGL renderer addon bundled + loaded with fallback", fs.readFileSync(path.resolve(__dirname, "../../scripts/copy-assets.js"), "utf8").includes("addon-webgl.js") && fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8").includes("WebglAddon"));
    // bg-agent: detect via `claude agents --json`, route to tmux fallback (no raw error), defensive catch
    check("FIX D: bg/live sessions render their OWN transcript read-only (never a foreign pane)", srvjs.includes("sendReadOnlyTranscript") && srvjs.includes("read-only (interact via your agents view)") && ctrljs.includes("sessionTranscriptText"));
    check("FIX F: terminal spawns pty at FITTED cols/rows on open (proposeDimensions, not 80×24)", rjs.includes("proposeDimensions") && /term\.resize\(d\.cols, d\.rows\)/.test(rjs));
    // FIX H: Enter=send, Ctrl/Cmd+Enter=newline — in BOTH the answer box AND the xterm terminal.
    check("FIX H: answer box Enter=send, Ctrl/Shift/Meta+Enter=newline", /e\.key === "Enter"[^]*?e\.ctrlKey \|\| e\.shiftKey \|\| e\.metaKey[^]*?slice\(0, start\) \+ "\\n"/.test(rjs));
    check("FIX H: xterm Ctrl/Cmd+Enter sends newline (0x0A) not submit", /e\.key === "Enter" && \(e\.ctrlKey \|\| e\.metaKey\)[^]*?t: "i", d: "\\n"/.test(rjs));
    // FIX G: continuous stacked diff, default-expand the source roots (src/lib/app), lazy-render via IO.
    check("FIX G: right pane stacks ALL VISIBLE files (renderDiffStack), not one selected file", rjs.includes("renderDiffStack") && !rjs.includes("function renderSelectedFile"));
    check("FIX G: default expansion is the source roots (DIFF_EXPAND_ROOTS), else expand-all", rjs.includes("defaultExpandedDirs") && rjs.includes('DIFF_EXPAND_ROOTS = ["src", "lib", "app"]'));
    check("FIX G: file visible only if all ancestor dirs expanded (collapse excludes from right)", rjs.includes("diffFileVisible") && /_diffExpanded\[P\]\.has\(cur\)/.test(rjs) && rjs.includes("renderDiffStack(P, sid); // collapsing removes"));
    check("FIX G: lazy-render via IntersectionObserver + placeholder height from changed lines", rjs.includes("IntersectionObserver") && rjs.includes("estimateBlockHeight") && rjs.includes("mountDiffBlock") && rjs.includes("placeholderDiffBlock"));
    check("FIX G: clicking a tree file smooth-scrolls its diff block via the container only (scrollBy on diff-body, never scrollIntoView → would scroll the whole page)", rjs.includes("scrollDiffToBlock(P, idx)") && rjs.includes("scrollDiffToBlock(P, jump.i)") && /container\.scrollBy\(\{ top: delta, behavior: "smooth"/.test(rjs) && /getElementById\(`diff-body-/.test(rjs));
    check("FIX: app shell <body> can't get stuck scrolled — a stray scrollIntoView is snapped back to origin", /window\.scrollX \|\| window\.scrollY\) window\.scrollTo\(0, 0\)/.test(rjs));
    check("FIX G: highlight off for >1500-line files, preserves Viewed + merge-base header", rjs.includes("changed <= 1500") && rjs.includes("enhanceViewedTogglesPane") && rjs.includes('pr-arrow">vs'));
    // FIX E (REPURPOSED): daemon bg agents respawn when killed → DON'T kill; tell operator to
    // stop in their agents view (Ctrl+X), then FIX I resumes instantly.
    check("FIX E-repurpose: take-over does NOT kill daemon bg agents (they respawn) → needsManualStop", ctrljs.includes("takeOverAgent") && ctrljs.includes("needsManualStop") && ctrljs.includes("bgAgentInfo") && !ctrljs.includes('"SIGKILL"'));
    check("FIX E: server exposes /api/takeover + /api/takeoverAll + /api/takeoverable", srvjs.includes('"/api/takeover"') && srvjs.includes('"/api/takeoverAll"') && srvjs.includes('"/api/takeoverable"'));
    check("FIX E-repurpose: UI tells operator to stop agent (Ctrl+X) instead of killing", rjs.includes("needsManualStop") && rjs.includes("Ctrl+X"));
    check("FIX E: renderer wires take-over (T) + take-over-all (A) master keys", rjs.includes("takeOverSelected") && rjs.includes("takeOverAllAgents") && rjs.includes('e.key === "T"') && rjs.includes('e.key === "A"'));
    check("FIX E: new task launches a STANDALONE claude (tmux), not a bg agent", fs.readFileSync(path.resolve(__dirname, "../../src/core/sessions.ts"), "utf8").includes('new-session') && fs.readFileSync(path.resolve(__dirname, "../../src/server/webapi.js"), "utf8").includes("takeOver:"));
    // FIX I: externally-stopped agent (dead process, recent mtime, not in --json) resumes instantly.
    check("FIX I: process-based fresh liveness (bg-json OR fd-held), NOT mtime-alone, gates --resume", ctrljs.includes("livenessForOpen") && ctrljs.includes("processHoldsTranscript") && ctrljs.includes("fetchAgentsRaw") && /kind === "background"/.test(ctrljs));
    check("FIX I: attachTerminal uses fresh livenessForOpen so dead+recent-mtime resumes immediately", srvjs.includes("livenessForOpen") && !srvjs.includes("ctrl.isSessionLive(sessionId)"));
    // FIX J: complete & archive — endpoint, kanban sg-managers move, Ctrl+G e binding.
    check("FIX J: /api/complete endpoint + completeTask wired", srvjs.includes('"/api/complete"') && ctrljs.includes("completeTask") && fs.readFileSync(path.resolve(__dirname, "../../src/server/webapi.js"), "utf8").includes("/api/complete"));
    check("FIX J: kanban move uses `sg managers -c mv` to 8_done", fs.readFileSync(path.resolve(__dirname, "../../src/core/kanban.ts"), "utf8").includes('"managers", "-c"') && ctrljs.includes('"8_done"'));
    check("FIX J: allSessions excludes completed; queue excludes completed", fs.readFileSync(path.resolve(__dirname, "../../src/core/db.ts"), "utf8").includes("completed_at IS NULL") && fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8").includes("completed_at IS NOT NULL"));
    check("FIX J: master-combo (Ctrl+G e) completes + moveFile undo op", rjs.includes("completeSelected") && rjs.includes("master_complete") && fs.readFileSync(path.resolve(__dirname, "../../src/core/undo.ts"), "utf8").includes('"moveFile"'));
    // FIX K: resume/new-terminal opens as the normal two-pane task view (overview left, terminal
    // right+focused), not a tiny top-left window. Single openTerminalView entry point.
    check("FIX K: all open-terminal paths route through openTerminalView (overview left + terminal B + focus B)", rjs.includes("function openTerminalView") && /setPaneView\("B", "terminal"\)/.test(rjs) && /S\.panes\.A = "overview"/.test(rjs));
    check("FIX K: take-over + new-session + review-attach use openTerminalView (no bypass)", /finishTakeOver[^]*?openTerminalView\(sid\)/.test(rjs) && /newClaudeTerminal[^]*?openTerminalView\(r\.sessionId/.test(rjs) && rjs.includes("function attachReviewSession(sid: number) { openTerminalView(sid); }"));
    check("FIX K: terminal-only session hides empty-state + renders a left overview (not 'No task selected')", rjs.includes("overrideSessionRow") && rjs.includes("renderSessionOnlyOverview") && /it \|\| ov \|\| termPinned/.test(rjs));
    // FIX LL: STICKY TERMINAL FOCUS — a background tick / re-rank / vanished-pinned-task / new
    // WAITING arrival must NEVER move focus off a terminal the operator is working in. Only an
    // explicit nav (selectIndex → _navFocus) may reset focus to the new task's default pane.
    check("FIX LL: renderPanes computes stickTerm = !_navFocus && focused pane is terminal", /const stickTerm = !_navFocus && S\.panes\[S\.focused\] === "terminal"/.test(rjs));
    check("FIX LL: the focused terminal pane is left intact on a background item change (continue)", /if \(stickTerm && P === S\.focused\) continue;/.test(rjs));
    check("FIX LL: focus is reset to default ONLY when not sticking to a terminal", /if \(!stickTerm\) S\.focused = defaultFocus\(it\);/.test(rjs));
    check("FIX LL: _navFocus is set ONLY by explicit nav (selectIndex), never a background tick", /_navScroll = true;[^\n]*\n\s*_navFocus = true;/.test(rjs) && (rjs.match(/_navFocus = true/g) || []).length === 1);
    check("FIX LL: _navFocus is consumed once per render (renderPanes resets it to false)", /applyKeyboardTarget\(\);\s*\n\s*_navFocus = false;/.test(rjs));
    check("FIX LL: applyKeyboardTarget re-asserts term.focus() for a focused terminal pane OR the chat drawer pty", /function applyKeyboardTarget[^]*?if \(fv === "terminal" \|\| drawerTerminalFocused\(\)\)[^]*?term && term\.focus\(\)/.test(rjs));
    check("FIX LL: plain keys go to the PTY when the terminal (or chat drawer) owns keys — global handler early-returns", /const termOwnsKeys = S\.panes\[S\.focused\] === "terminal" \|\| drawerTerminalFocused\(\);/.test(rjs) && /if \(termOwnsKeys\) return;/.test(rjs));
    check("FIX LL: no active auto-open path steals focus (autoOpened set is unused / never auto-attaches)", !/autoOpened\.add\(|autoOpened\.has\(/.test(rjs));
    // FIX L: open-terminal bumps task to top (active boost) + nav-stuck fix.
    check("FIX L1: active task floats to top via queue-time reposition (highest organic + ACTIVE_OVER), not a flat 50k base", fs.readFileSync(path.resolve(__dirname, "../../src/core/priority.ts"), "utf8").includes("ACTIVE_OVER") && /maxOrganic \+ ACTIVE_OVER/.test(fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8")));
    check("FIX L1: engine boosts active session in scoreFor; /api/activate wired", fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8").includes("_activeSessionId === s.id") && srvjs.includes('"/api/activate"') && ctrljs.includes("activateSession"));
    check("FIX L1: openTerminalView activates + re-selects the bumped task", /openTerminalView[^]*?api\.activate\(sid\)[^]*?selectIndex\(idx\)/.test(rjs));
    check("FIX L2: moveQueueSel un-pins terminal, resets panes, focuses overview (nav-stuck fix)", /moveQueueSel[^]*?_termOverride = null[^]*?S\.paneManual\.A = false[^]*?S\.focused = "A"/.test(rjs));
    check("FIX L2: master-combo arrows reach nav even when terminal focused (leaderActive→runMasterCmd)", /S\.leaderActive\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); runMasterCmd\(e\)/.test(rjs));
    // FIX M: roster-only opened terminal becomes a SELECTABLE top up-next entry (both panes same
    // session, not layered over the previous task) + terminal-size diagnostics.
    check("FIX M1: ensureVirtualTop injects a selectable top entry for a roster-only opened terminal", rjs.includes("function ensureVirtualTop") && rjs.includes("_virtual: true") && /S\.state\.queue\.unshift/.test(rjs) && rjs.includes("ensureVirtualTop(); // FIX M"));
    check("FIX M1: virtual item renders minimal overview (both panes = same opened session)", /it\._virtual\) \{ renderSessionOnlyOverview\(body, it\.session\)/.test(rjs));
    check("FIX M2: terminal-size diagnostics log container/propose/cols (console + footer)", rjs.includes("function termSizeDiag") && rjs.includes("proposeDimensions") && rjs.includes("paneB") && /host \$\{cw\}×\$\{ch\}/.test(rjs) && rjs.includes('termSizeDiag("open")'));
    // FIX N: Ctrl+Z = undo, but ONLY outside the terminal (terminal Ctrl+Z = SIGTSTP passthrough).
    check("FIX N: Ctrl/Cmd+Z triggers undo (doUndo), placed AFTER the terminal early-return", /if \(termOwnsKeys\) return;[^]*?\(e\.ctrlKey \|\| e\.metaKey\)[^]*?e\.key === "z"[^]*?doUndo\(\)/.test(rjs));
    check("FIX N: Ctrl+Z undo is suppressed while typing in the answer box (native textarea undo)", /e\.key === "z" \|\| e\.key === "Z"\) && !answerInputFocused\(\)/.test(rjs));
    check("FIX N: undo_alt bound to C-z in keymap (u still works)", JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/keymap.json"), "utf8")).undo_alt === "C-z");
    // FIX P: dismiss stamps dismissed_at (not completed_at); surface re-opens on fresh activity.
    check("FIX P: dismiss stamps dismissed_at (snooze-until-ready), not completed_at", ctrljs.includes("status='decided', decision='done', dismissed_at=?"));
    check("FIX P: surface RE-OPENS a dismissed item to pending on fresh transcript activity", fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8").includes("decision=NULL, dismissed_at=NULL") && /mtime > dismissAt/.test(fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8")));
    // FIX Q: the cc-daemon holding a transcript fd must NOT count as "live" (false positive).
    check("FIX Q: fd-holder liveness EXCLUDES the cc-daemon (`claude daemon run`)", ctrljs.includes("isCcDaemon") && /!Controller\.isCcDaemon\(ent\)/.test(ctrljs) && ctrljs.includes('"daemon run"'));
    // macOS liveness: Claude appends-and-closes its transcript (no fd to scan), so processHoldsTranscript
    // splits on platform and uses an argv signal (`claude --resume <cid>`) on macOS. matchesResumeProc
    // is the pure, testable core of that signal.
    check("mac-liveness: processHoldsTranscript splits on platform (no /proc on macOS)", /process\.platform === "linux"/.test(ctrljs) && ctrljs.includes("matchesResumeProc"));
    check("mac-liveness: matchesResumeProc detects a live `claude --resume <cid>` process",
      Controller.matchesResumeProc("4823 /opt/homebrew/bin/claude --resume abc-123 --dangerously-skip-permissions", "abc-123") === true);
    check("mac-liveness: matchesResumeProc ignores a DIFFERENT session's resume",
      Controller.matchesResumeProc("4823 claude --resume other-999 --dangerously-skip-permissions", "abc-123") === false);
    check("mac-liveness: matchesResumeProc excludes the cc-daemon (`claude daemon run`, no --resume)",
      Controller.matchesResumeProc("311 /opt/homebrew/bin/claude daemon run\n312 node server.js", "abc-123") === false);
    check("mac-liveness: matchesResumeProc doesn't match a bare `--resume abc-123` from a non-claude proc",
      Controller.matchesResumeProc("99 /usr/bin/somethingelse --resume abc-123", "abc-123") === false);
    check("mac-liveness: matchesResumeProc is false for empty cid", Controller.matchesResumeProc("1 claude --resume abc-123", "") === false);
    // Provisional guard: opening a terminal marks the session so it's never lost.
    check("guard: attachTerminal marks the session opened (provisional keep)", srvjs.includes("markSessionOpened") && ctrljs.includes("markSessionOpened"));
    // FIX R: terminal paste via the browser paste EVENT (insecure-context safe), Ctrl+V passthrough.
    check("FIX R: paste event injects clipboard TEXT into the PTY (getData text/plain → WS)", rjs.includes('el.addEventListener("paste"') && rjs.includes('cd.getData("text/plain")') && /t: "i", d: text/.test(rjs));
    check("FIX R: Ctrl+V/Cmd+V passes through to the native paste event (xterm doesn't send 0x16)", /\(e\.key === "v" \|\| e\.key === "V"\)\) return false/.test(rjs));
    check("FIX R: image-only paste shows an inline notice (no raw keystroke)", rjs.includes('it.type.startsWith("image/")') && rjs.includes("image paste isn't supported"));
    // Terminal copy-on-select: mouseup auto-copies the xterm selection (insecure-context safe) and
    // refocuses the terminal (also reinforces FIX LL sticky focus). Item 6b.
    check("TERM: selection auto-copies on mouseup (getSelection → copyTextToClipboard) + refocus", /el\.addEventListener\("mouseup"[^]*?term\.getSelection\(\)[^]*?copyTextToClipboard\(sel\)[^]*?term\.focus\(\)/.test(rjs) && /function copyTextToClipboard[^]*?clipboard\.writeText[^]*?fallbackCopy/.test(rjs));
    // PLAIN-DRAG COPY (no Shift): with tmux `mouse on`, a drag never makes an xterm selection — tmux
    // (set-clipboard on + the `clipboard` terminal-feature) emits OSC 52, decoded by ClipboardAddon
    // into a CUSTOM provider whose writeText routes through the same resilient copyTextToClipboard.
    check("TERM: ClipboardAddon loaded with a custom provider that routes OSC 52 → copyTextToClipboard",
      /ClipboardAddon\(undefined, provider\)/.test(rjs) && /writeText: \([^)]*\) =>[^]*?copyTextToClipboard\(data\)/.test(rjs));
    check("TERM: OSC-52 clipboard provider is WRITE-ONLY (readText is a no-op — no remote read of the operator's clipboard)",
      /readText: \(\) => Promise\.resolve\(""\)/.test(rjs));
    check("TERM(vendor): addon-clipboard.js is vendored, loaded in index.html, AND served by the server route allowlist",
      fs.readFileSync(path.resolve(__dirname, "../../scripts/copy-assets.js"), "utf8").includes('"addon-clipboard.js"') &&
      fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8").includes('vendor/addon-clipboard.js') &&
      fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8").includes('p === "/vendor/addon-clipboard.js"'));
    // TERM MODE REPLAY (PR #13 — "reopened terminal can't scroll until maximized once"): a
    // kept-alive direct pty (FIX GG) replays only the last 200KB on reopen, and tmux's
    // mouse-enable DECSETs (?1000h/?1006h, alt ?1049h) live at the stream HEAD — so the replay
    // MUST re-assert the tracked mode state or the fresh xterm never enters mouse mode and the
    // wheel sends nothing. termmodes_test.js covers the tracker itself (incl. against REAL tmux
    // bytes); these lock the server WIRING so it can't silently drift away.
    {
      const srv = fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8");
      check("TERM-REPLAY: every DirectPty carries a TermModeTracker fed on EVERY pty data chunk",
        srv.includes("modes: new TermModeTracker()") && srv.includes("reg.modes.feed(d)"));
      check("TERM-REPLAY: the reuse-path replay prepends reassertPrefix() BEFORE the buffered tail",
        /existing\.modes\.reassertPrefix\(\)\s*\+\s*existing\.buffer/.test(srv));
      check("TERM-REPLAY: the mode-replay suite is registered in run_all",
        fs.readFileSync(path.resolve(__dirname, "../../src/test/run_all.ts"), "utf8").includes("termmodes_test.js"));
    }
    // FIX MM (item 1): the "✕ close view" exit button is REMOVED from the terminal header; the
    // detach pathway survives via Ctrl+G q / Esc → closeTerminal(), and the (now-dead) click-wirer
    // is GUARDED for a missing #term-back element so the renderer never crashes.
    {
      const html = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8");
      check("FIX MM: #term-back exit button removed from index.html (operator never wants it)", !/id="term-back"/.test(html) && !html.includes("✕ close view"));
      check("FIX MM: term-back click-wirer GUARDS a missing element (no crash)", /const bb = document\.getElementById\("term-back"\);\s*\n\s*if \(bb\)/.test(rjs));
      check("FIX MM: detach still works — master q / Esc → closeTerminal() (Claude keeps running in tmux)", /e\.key === "q" \|\| e\.key === "Escape"\) \{[^]*?closeTerminal\(\)/.test(rjs));
    }
    // FIX NN: FUNDAMENTAL terminal robustness — the live terminal is a re-attachable VIEW of the
    // durable claudeos-<id> tmux session, so an UNEXPECTED socket drop (deploy / the VPN blip /
    // dead half-open) must AUTO-RECONNECT instead of freezing on a dead "[exited]"/detached screen.
    {
      check("FIX NN: ws open/reopen is factored into openTermWs(sid, term)", /function openTermWs\(sid: number, term: any\)/.test(rjs));
      check("FIX NN: input is bound ONCE and routed to the CURRENT live transport (termSendInput reads live S.termWs/S.termNative), not a captured ws", /term\.onData\(\(d: string\) => termSendInput\(d\)\);/.test(rjs) && /function termSendInput\(d: string\) \{[^]*?const w = S\.termWs;/.test(rjs));
      check("FIX NN: an unexpected close/error triggers auto-reconnect (not a dead 'detached' screen)", /ws\.onclose = \(\) => \{ if \(S\.termWs === ws\) scheduleTermReconnect\(sid\); \};/.test(rjs) && /ws\.onerror = \(\) => \{ if \(S\.termWs === ws\) scheduleTermReconnect\(sid\); \};/.test(rjs));
      check("FIX NN: scheduleTermReconnect backs off 300ms→3s and is no-op on intentional/foreign/no-xterm", /function scheduleTermReconnect[^]*?if \(S\.termIntentionalClose\) return;[^]*?if \(S\.termSessionForPane !== sid\) return;[^]*?Math\.min\(3000, Math\.round\(300 \* Math\.pow\(1\.7/.test(rjs));
      check("FIX NN: a live socket resets the backoff (onopen → termReconnectAttempts = 0)", /S\.termReconnectAttempts = 0;/.test(rjs));
      check("FIX NN: teardownTerminal marks intentional + cancels any pending reconnect", /S\.termIntentionalClose = true;[^]*?if \(S\.termReconnectTimer\) \{ clearTimeout\(S\.termReconnectTimer\); S\.termReconnectTimer = null; \}/.test(rjs));
      // Server heartbeat: ping every 20s; a missed pong → terminate the dead half-open so the client's
      // onclose fires and it auto-reconnects (instead of typing into a black hole over the VPN).
      check("FIX NN: server wireTermWs sends ws.ping heartbeat + terminates a half-open on a missed pong", srvjs.includes('ws.on("pong"') && srvjs.includes("ws.ping()") && srvjs.includes("ws.terminate()") && /clearInterval\(hb\)/.test(srvjs));
    }
    // FIX O: HTML view — endpoint, sandboxed iframe, tabs, master h, HTML tab only when viz exists.
    check("FIX O: /api/viz endpoint serves HTML with a traversal guard (resolveViz)", srvjs.includes('"/api/viz/"') && srvjs.includes("resolveViz") && srvjs.includes("text/html"));
    check("FIX O: pane A renders viz in a SANDBOXED iframe with tabs", rjs.includes('iframe class="viz-frame" sandbox=') && rjs.includes("viz-tab") && rjs.includes("/api/viz/"));
    check("FIX O: HTML tab shown ONLY when the session has viz; master h opens it", /currentViz\(\)\.length \? "" : "none"/.test(rjs) && /case "h": setPaneView\("A", "html"\)/.test(rjs));
    check("FIX O: state exposes per-session viz; viz feature wired", ctrljs.includes("sessionViz") && fs.readFileSync(path.resolve(__dirname, "../../src/core/config.ts"), "utf8").includes("viz_dir"));
    // GLOBAL DETECTION: the default mention root is the operator's $HOME, so a script-written html
    // anywhere under $HOME surfaces (not just ~/code).
    check("GLOBAL: default viz_mention_roots = [$HOME] (covers anything under your home dir)", fs.readFileSync(path.resolve(__dirname, "../../src/core/config.ts"), "utf8").includes("process.env.HOME ? [process.env.HOME] : []"));
    // NEWEST-FIRST tab: renderer selects/auto-surfaces tab 0 (newest) + labels it "latest" with an age.
    check("NEWEST-FIRST: renderer jumps to tab 0 (newest) on new html + badges latest tab", /S\.vizTab = 0;[^\n]*newest/.test(rjs) && rjs.includes("viz-tab-latest") && rjs.includes("viz-tab-age"));
    // FIX U: selection is IDENTITY-based — reconcileSelection follows S.selItemId; only user actions move it.
    check("FIX U: selection is identity-based (reconcileSelection re-derives S.sel from S.selItemId)", rjs.includes("function reconcileSelection") && /idx = q\.findIndex\(\(it: any\) => it\.id === S\.selItemId\)/.test(rjs) && rjs.includes("reconcileSelection(); // FIX U"));
    check("FIX U: panes reset by a SEPARATE _renderedItemId, not the selection identity", rjs.includes("_renderedItemId") && /_renderedItemId !== it\.id/.test(rjs) && !/if \(it && S\.selItemId !== it\.id\)/.test(rjs));
    check("FIX U: user nav/click/open select by identity via selectIndex", rjs.includes("function selectIndex") && /selectIndex\(parseInt/.test(rjs) && /if \(e\.key === "j"\) \{ moveQueueSel\(1\)/.test(rjs));
    // FIX T: terminal-size diag POSTed to the server (server-readable).
    check("FIX T: /api/diag endpoint logs + rings the diagnostics; renderer POSTs them", srvjs.includes('"/api/diag"') && srvjs.includes("_diagLog") && rjs.includes("api as any).diag") && rjs.includes("propose_cols"));
    check("resurfaceAll: endpoint runs a fresh tick + flips DISMISSED→pending for ready sessions", srvjs.includes('"/api/resurfaceAll"') && /resurfaceAll[^]*?await tickLoop\(\)/.test(srvjs) && ctrljs.includes("resurfaceAll") && /state IN \('WAITING_INPUT','DONE'\)/.test(ctrljs) && ctrljs.includes("decision='done'"));
    // FIX V: terminal font is configurable (default 15, not the microscopic 13) + live zoom.
    check("FIX V: terminal_font_size config (default 15) drives the xterm fontSize", typeof JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/weights.json"), "utf8")).terminal_font_size === "number" && /terminal_font_size === "number" \? raw\.terminal_font_size : 15/.test(fs.readFileSync(path.resolve(__dirname, "../../src/core/config.ts"), "utf8")) && ctrljs.includes("terminal_font_size") && rjs.includes("fontSize: termFontSize()") && !rjs.includes("fontSize: 13"));
    check("FIX V: live font zoom (Ctrl+G +/-) re-fits", rjs.includes("function termFontSize") && rjs.includes("function zoomTermFont") && /e\.key === "\+" \|\| e\.key === "="\) \{ zoomTermFont\(\+1\)/.test(rjs) && rjs.includes("fitAndResize()"));
    // FIX W: surface non-WORKING (idle low-prio); only actively-working hidden.
    check("FIX W: engine surfaces non-WORKING (idle/UNKNOWN too), hides only WORKING", fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8").includes('state !== "WORKING" && !!detected.view') && fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8").includes("const isIdle = state === \"UNKNOWN\""));
    check("FIX W: idle/UNKNOWN gets a low (negative) priority base", fs.readFileSync(path.resolve(__dirname, "../../src/core/priority.ts"), "utf8").includes("idle_base") && JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/weights.json"), "utf8")).weights.idle_base === -8);
    check("FIX W: Complete (Ctrl+G e) still the ONLY permanent removal; dismiss still snoozes", ctrljs.includes("completed_at") && ctrljs.includes("dismissed_at=?"));
    // FIX X: PR detection + merge.
    const prjs = fs.readFileSync(path.resolve(__dirname, "../../src/core/pr.ts"), "utf8");
    check("FIX X: prForBranch uses `gh pr list --head <branch>` (cwd-based repo detect)", prjs.includes('"pr", "list", "--head"') && prjs.includes("mergeStateStatus") && prjs.includes("ghAsyncCwd"));
    check("FIX X: mergePrByNumber builds `gh pr merge <n> --<strategy>` + returns the cmd", prjs.includes('"pr", "merge", String(prNumber)') && /--squash|--merge|--rebase/.test(prjs) && prjs.includes("cmd"));
    check("FIX X: controller caches PR (no gh in state()) + exposes pr; merge uses config strategy", ctrljs.includes("_prCache") && ctrljs.includes("refreshSessionPr") && ctrljs.includes("pr_merge_strategy") && /pr: this\.sessionPr\(row\)/.test(ctrljs));
    check("FIX X: endpoints /api/sessionPr (lazy) + /api/mergePr (confirm-guarded UI)", srvjs.includes('"/api/sessionPr/"') && srvjs.includes('"/api/mergePr"') && srvjs.includes("mergeSessionPr"));
    check("FIX X: diff view shows PR header bar + Merge; Ctrl+G M merges with confirm", rjs.includes("renderPrBar") && rjs.includes("pr-merge-") && rjs.includes("confirmMergePr") && /e\.key === "M"\) \{ mergeSelectedPr/.test(rjs));
    // MERGED-STATE: a merged PR must be unmistakable — bold "✅ Merged" badge, no live Merge
    // button (header bar OR diff toolbar), recolored bar. (operator: "tiny merged chip, button
    // still there, can't tell it's merged")
    check("MERGED-STATE: merged PR drops the Merge button for a bold merged badge + recolored bar", rjs.includes("const isMerged =") && /\/\^MERGED\$\/i\.test/.test(rjs) && rjs.includes("pr-merged-badge") && rjs.includes("pr-chip merged") && rjs.includes("pr-bar-merged") && /isMerged\s*\?\s*`<span class="pr-merged-badge"/.test(rjs));
    check("MERGED-STATE: diff-toolbar Merge control hidden when merged", rjs.includes("diff-merge-wrap-") && /mergeWrap\.style\.display = isMerged \? "none" : ""/.test(rjs));
    check("MERGED-STATE: merged styling present in CSS", fs.readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8").includes(".pr-merged-badge") && fs.readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8").includes(".pr-bar-merged"));
    check("FIX X: pr_merge_strategy config (default squash, never auto-merge)", JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/weights.json"), "utf8")).pr_merge_strategy === "squash" && fs.readFileSync(path.resolve(__dirname, "../../src/core/config.ts"), "utf8").includes("pr_merge_strategy"));
    // CHAT LAYOUT: a normal Claude task lands Chat (A) | Terminal (B) — the SOUL-voiced gist is the
    // front view; PR/kanban and chat-disabled keep Overview. Diff/HTML live in the DETACHED detail
    // window or behind a manual switch (o/h/t/d). Explicit nav resets BOTH panes (a manual choice
    // never leaks into the next task) and an html that already existed on arrival never hijacks pane A.
    check("chat layout: paneDefault A is Chat for a chattable task (Terminal for B)", rjs.includes('return chatEnabled() && isChattable(it) ? "chat" : "overview";') && /if \(P === "B"\) return "terminal";/.test(rjs));
    check("chat layout: explicit nav clears BOTH manual pane flags (no leak across tasks)", /if \(_navFocus\) \{[^]*?S\.paneManual\.A = false; S\.paneManual\.B = false;/.test(rjs));
    check("standard layout: task-change pre-seeds autoVized (pre-existing html can't hijack pane A)", /S\.autoVized\.add\(`\$\{it\.session\.id\}:\$\{viz0\.length\}`\)/.test(rjs));
    check("0cc9197: paneDefault A never branches on task html / PR — Overview wins unconditionally", !/paneDefault[^]*?sessionVizFor\(it\.session\.id\)\.length\) return "html"/.test(rjs));
    check("0cc9197: openTerminalView seeds pane A = Overview (Diff/HTML live in the detached window)", rjs.includes('S.panes.A = "overview"'));
    // FIX Y: ONE Viewed control per file; click collapses in place (no re-render), persists.
    check("FIX Y: exactly ONE Viewed control per file (removes dupes before adding)", rjs.includes(".d2h-viewed, .d2h-viewed-btn, .d2h-file-collapse, input[type=checkbox]") && rjs.includes("stale.forEach((el) => el.remove())"));
    check("FIX Y: clicking Viewed collapses the file IN PLACE (no buildDiffTree/renderDiffStack)", rjs.includes("function setFileViewed") && rjs.includes("applyFileCollapsed") && rjs.includes("file-collapsed") && !/cb\.addEventListener\("change", async \(\) => \{[^]*?buildDiffTree/.test(rjs));
    // FIX AA (systemic): diff-pane buttons (Viewed + Merge) work via ONE delegated document listener.
    check("FIX AA: delegated diff-pane click listener routes Viewed + Merge (survives re-render)", rjs.includes("function wireDiffPaneDelegation") && /\.closest\("\.d2h-viewed-btn"\)/.test(rjs) && /\.closest\("\.pr-merge-btn"\)/.test(rjs) && rjs.includes("wireDiffPaneDelegation();"));
    check("FIX AA: Viewed/Merge are plain buttons with data-attrs, NO per-element listener", rjs.includes("d2h-viewed-btn") && rjs.includes("pr-merge-btn") && rjs.includes('data-sid="${sessionId}"') && !rjs.includes('id="pr-merge-${P}"'));
    check("FIX AA: delegated Viewed → setFileViewed (same path as the `v` key)", /closest\("\.d2h-viewed-btn"\)[^]*?setFileViewed\(P, sid, path, block/.test(rjs));
    // FIX AA-2: derive block/P/path from the clicked button (never depend on a _diffFiles lookup);
    // one Viewed control per file (nuke stale incl. native + checkbox); data-path stamped.
    check("FIX AA-2: viewed click derives block from closest('.diff-file-block') + data-path (no silent _diffFiles bail)", /vb\.closest\("\.diff-file-block"\)/.test(rjs) && /vb\.dataset\.path \|\| \(block && block\.dataset\.path\)/.test(rjs) && rjs.includes("[viewed-click] fired"));
    check("FIX AA-2: wireBlockViewed nukes ALL viewed/collapse/checkbox controls + stamps data-path", /querySelectorAll\("\.d2h-viewed, \.d2h-viewed-btn, \.d2h-file-collapse, input\[type=checkbox\]"\)/.test(rjs) && rjs.includes("btn.dataset.path = path"));
    check("FIX AA: delegated Merge → confirmMergePr (same as Ctrl+G m)", /closest\("\.pr-merge-btn"\)[^]*?confirmMergePr\(sid/.test(rjs));
    check("FIX AA: index.html cache-busts renderer/styles/webapi with the build hash (no stale bundle)", srvjs.includes("CACHE-BUST our own assets") && srvjs.includes('renderer.js?v=${v}') && srvjs.includes('styles.css?v=${v}') && srvjs.includes('webapi.js?v=${v}'));
    // FIX DD: Up Next scroll preserved across background renders; scrollIntoView only on explicit nav.
    check("FIX DD: renderQueue preserves scrollTop + only scrolls focused row on explicit nav", /prevQ = ql \? ql\.scrollTop/.test(rjs) && /ql\.scrollTop = prevQ/.test(rjs) && /if \(_navScroll\) \{/.test(rjs) && rjs.includes("_navScroll = true; // FIX DD"));
    check("FIX Y: collapsed file shows only filename header (CSS .file-collapsed hides body)", fs.readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8").includes(".diff-file-block.file-collapsed .d2h-file-diff"));
    check("FIX: diff line numbers anchor to their row (tr position:relative) so they don't drift on scroll", /\.diff-pane \.d2h-diff-table tr\s*\{\s*position:\s*relative/.test(fs.readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8")));
    check("FIX Y: viewed/collapsed persists per file via setDiffViewed", /setFileViewed[^]*?api\.setDiffViewed\(sid, path, viewed\)/.test(rjs));
    // FIX Z: ClaudeOS white logo in the header, served + copied to dist.
    check("FIX Z: header uses /logo.png; route + copy-assets + CSS wired", fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8").includes('<img src="/logo.png" class="brand-logo"') && srvjs.includes('p === "/logo.png"') && fs.readFileSync(path.resolve(__dirname, "../../scripts/copy-assets.js"), "utf8").includes("logo.png") && fs.readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8").includes(".brand-logo"));
    check("FIX Z: serveStatic serves binary (image/png) un-decoded", srvjs.includes("must NOT be utf8-decoded") && /text\\\/\|javascript\|json\|css/.test(srvjs));
    check("FIX Z: white logo asset exists in src + dist", fs.existsSync(path.resolve(__dirname, "../../src/renderer/logo.png")) && fs.existsSync(path.resolve(__dirname, "../../dist/renderer/logo.png")));
    // FIX AA: bulletproof ONE Viewed control per block + a build marker for stale-renderer detection.
    check("FIX AA: ONE Viewed control per block (wireBlockViewed nukes all dupes incl native)", rjs.includes("function wireBlockViewed") && rjs.includes("stale.forEach((el) => el.remove())") && rjs.includes("block.dataset.idx"));
    check("FIX AA: build hash in /api/state config + stamped in the header", ctrljs.includes("buildHash") && /build: this\.buildHash\(\)/.test(ctrljs) && rjs.includes("build-marker") && fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8").includes('id="build-marker"'));
    // FIX CC: context-aware Ctrl+/- zoom (terminal font vs UI scale), preventDefault page zoom.
    check("FIX CC: Ctrl/Cmd +/- intercepted (preventDefault page zoom), routed by focus", rjs.includes("function isZoomKey") && /isZoomKey\(e\); if \(z\) \{ e\.preventDefault\(\); if \(S\.panes\[S\.focused\] !== "terminal"\) zoomUi/.test(rjs) && /isZoomKey\(e\); if \(z\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); zoomTermFont\(z\)/.test(rjs));
    check("FIX CC: UI text scale via --ui-scale (zoom), persisted in localStorage, independent of term font", rjs.includes("function zoomUi") && rjs.includes('localStorage.setItem("ui_font_scale"') && fs.readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8").includes("zoom: var(--ui-scale"));
    check("FIX CC: Electron pins page zoom (setVisualZoomLevelLimits 1,1)", fs.readFileSync(path.resolve(__dirname, "../../src/main/main.ts"), "utf8").includes("setVisualZoomLevelLimits(1, 1)"));
    // FIX BB: reasoned priority feedback wiring (keys, endpoint, dream, RANKING.md, inspector).
    check("FIX BB: ⌃G H = rank HIGHER (up), ⌃G L = rank LOWER (down) → reason input → reasonFeedback", rjs.includes("function showReasonInput") && /e\.key === "H"\) \{ showReasonInput\("up"\)/.test(rjs) && /e\.key === "L"\) \{ showReasonInput\("down"\)/.test(rjs) && rjs.includes("api.reasonFeedback") && srvjs.includes('"/api/reasonFeedback"') && ctrljs.includes("reasonFeedback"));
    check("FIX BB: immediate = PER-ITEM offset (manual_priority_delta); generalize only in dream", ctrljs.includes("manual_priority_delta=?") && fs.readFileSync(path.resolve(__dirname, "../../src/core/priority.ts"), "utf8").includes("manualPriorityDelta") && fs.readFileSync(path.resolve(__dirname, "../../src/core/dream.ts"), "utf8").includes('ex.kind === "explicit_reason"') && /dir \* lr \* mult/.test(fs.readFileSync(path.resolve(__dirname, "../../src/core/dream.ts"), "utf8")));
    check("FIX BB: Esc records direction-only; typed reason weighs higher (config-driven)", /ev\.key === "Escape"[^]*?submit\(\)/.test(rjs) && ctrljs.includes("reason && reason.trim() ? reasonW : dirW"));
    check("FIX BB: reason text feeds RANKING.md + shows in the inspector", fs.readFileSync(path.resolve(__dirname, "../../src/core/ranking.ts"), "utf8").includes("explicit_reason") && rjs.includes('e.kind === "explicit_reason"'));
    check("bg-agent detection via `claude agents --json` (cached)", ctrljs.includes('"agents", "--json"') && ctrljs.includes("_bgAgents"));
    check("bg-agent sessions route to tmux fallback, not claude --resume", srvjs.includes("livenessForOpen") && srvjs.includes("isBg") && srvjs.includes("tmuxAttachFallback"));
    check("defensive catch: claude --resume early-exit (refused/errored) → tmux fallback (no raw error)", srvjs.includes("background agent|currently running|--fork-session") && srvjs.includes("early && reg.ws === ws"));
    // REGRESSION (2026-06-09): the "[exited]" / reconnecting↔live FLICKER loop. A bg agent has no
    // pane of its own, so attaching a foreign cwd-shared pane spawns a tmux client that exits at once
    // → ws.close() → renderer auto-reconnects → re-attach → flicker. These lock in: bg agents NEVER
    // attach a pane (→ read-only), an immediate tmux exit falls back to read-only (not ws.close), and
    // the read-only view keeps the socket OPEN (no close → no reconnect spam).
    check("flicker fix: bg-agent never attaches a pane (isBg ? null : attachSpec) → read-only", srvjs.includes("isBg ? null : ctrl.attachSpec"));
    check("flicker fix: an immediate tmux-attach exit falls back to read-only, not ws.close()", srvjs.includes("startedAt < 2500") && srvjs.includes("read-only (live session not attachable)"));
    check("flicker fix: read-only transcript keeps the socket OPEN (no ws.close → no reconnect spam)", srvjs.includes("read-only — nothing to type here") && srvjs.includes("DO NOT ws.close"));
    const rendsrc = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
    check("card/queue headline uses the clean haiku title (sessionHeadline)", rendsrc.includes("function sessionHeadline") && rendsrc.includes("session.clean_title") && rendsrc.includes("esc(sessionHeadline(it.session))"));
  }

  console.log("\n== DEMO sandbox mode (safe: seeds fakes, no discovery/PR-scan, no tmux/gh) ==");
  {
    const { seedDemo } = require("../core/demo");
    const dsm = new SessionManager(db, true); // demo=true
    const dengine = new Engine(db, dsm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const dctrl = new Controller(db, dengine, dsm, cfg, true); // demo=true
    await seedDemo(db, dsm, dengine, cfg);
    const dst = dctrl.state();
    check("state() exposes demo=true", dst.demo === true);
    const titles = dst.queue.map((q) => q.session.title);
    check("demo seeds the SIMPLE_QUESTION", titles.includes("enable gzip on the public API responses"));
    check("demo seeds a fake PR item (kind=pr)", dst.queue.some((q) => q.session.kind === "pr"));
    check("demo seeds a PINNED item", dst.queue.some((q) => q.session.pinned));
    check("demo seeds a manual-importance item", dst.queue.some((q) => q.session.manual_importance != null));
    const demoQ = dst.queue.find((q) => q.session.title === "enable gzip on the public API responses")!;
    let demoOpts: string[] = [];
    try { demoOpts = JSON.parse(demoQ.answer_options || "[]"); } catch {}
    check("demo question item has canned A/B/C/D options", demoOpts.length >= 2);
    // undo works in demo too (pin → undo)
    const dpin = dsm.list().find((s) => s.title === "overnight test-suite run")!;
    dctrl.setPinned(dpin.id, true);
    check("demo undo reverts pin", dctrl.undo().ok && (db.prepare("SELECT pinned FROM sessions WHERE id=?").get(dpin.id) as any).pinned === 0);

    // FIX W: only actively-WORKING stays hidden; an idle/UNKNOWN demo session now surfaces (low).
    const working = dsm.list().find((s) => s.title === "full-table reindex (running)")!;
    const ambig = dsm.list().find((s) => s.title === "scratch notes")!;
    check("demo WORKING session stays hidden", !dst.queue.some((q) => q.session_id === working.id));
    check("demo idle/UNKNOWN session IS surfaced (FIX W, low prio)", dst.queue.some((q) => q.session_id === ambig.id));
    // ...but you can still PEEK a hidden working session's live terminal (Group 2)
    const wpane = dctrl.pane(working.id);
    check("hidden WORKING session's terminal is still viewable (canned in demo)", wpane.live && /Claude is working/.test(wpane.content));

    // discovery + PR scan are OFF: another tick adds no sessions and no extra PRs
    const nBefore = dsm.list().length;
    const prBefore = dctrl.state().queue.filter((q) => q.session.kind === "pr").length;
    await dengine.tick();
    check("discovery disabled in demo (no new sessions)", dsm.list().length === nBefore);
    check("PR scan disabled in demo (PR count stable, no gh call)", dctrl.state().queue.filter((q) => q.session.kind === "pr").length === prBefore);

    // terminal: canned fake screen, NO tmux
    const anySess = dst.queue[0];
    const pane = dctrl.pane(anySess.session_id);
    check("demo terminal pane is live + canned (no tmux pane exists)", pane.live && /DEMO/.test(pane.content));
    const lenBefore = dctrl.pane(anySess.session_id).content.length;
    check("demo sendKey is a no-op that appends to the fake buffer", dctrl.key(anySess.session_id, "y", false).ok && dctrl.pane(anySess.session_id).content.length > lenBefore);

    // sendAnswer no-op: returns ok, touches no tmux
    const simpleId = dst.queue.find((q) => q.session.title === "enable gzip on the public API responses")!.id;
    check("demo sendAnswer returns ok without tmux", dctrl.sendAnswer(simpleId, "yes").ok === true);

    // PR diff = the REAL throwaway-repo diff; merge = a REAL local git merge (sandboxed, no gh)
    const prItem = dst.queue.find((q) => q.session.kind === "pr")!;
    const diff = await dctrl.prDiff(prItem.session_id);
    check("demo prDiff returns a real diff from the throwaway repo", diff.ok && /sqs_consumer|retries|backoff|diff --git/.test(diff.diff));
    const merge = await dctrl.prMerge(prItem.session_id);
    check("demo prMerge does a real LOCAL merge (sandboxed, no gh)", merge.ok && /merged .*→/.test(merge.output));
  }

  console.log("\n== Combined enrichment: shape + instant placeholder + parallel ==");
  {
    const { enrichFallback, enrichItem } = require("../core/enrich");
    // (1) combined-enrichment SHAPE: one object carrying every operator-facing field.
    const fb = enrichFallback({
      category: "SIMPLE_QUESTION",
      title: "t",
      questionText: "Should I bind to 8080? (yes/no)",
      lastPrompt: "",
      recentTranscript: "",
      focus: "",
      changedLines: 0,
      model: "haiku",
    });
    const keys = Object.keys(fb).sort();
    check(
      "combined enrichment returns the unified shape {one_liner,suggested_answer,diff_summary,options,importance,importance_reason}",
      ["diff_summary", "importance", "importance_reason", "one_liner", "options", "suggested_answer"].every((k) => keys.includes(k)),
      keys.join(",")
    );
    check("enrichment carries a written `context` brief field", keys.includes("context"), keys.join(","));
    check("fallback importance is -1 (not yet judged)", fb.importance === -1);
    check("enrichItem is a single async function (one combined call)", typeof enrichItem === "function");

    // (2) INSTANT placeholder: a freshly-ready session surfaces immediately with an
    // item; offline (enrich disabled) the placeholder is marked enriched=1 (final).
    const pid = mock("enrich-instant", [{ role: "assistant", text: "Should I cache results? (yes/no)" }], { title: "instant enrich" });
    await engine.tick();
    const pit = engine.queue().find((q) => q.session_id === pid)!;
    check("freshly-ready session surfaces an item in the same tick", !!pit, "no item");
    check("item exposes an `enriched` flag", typeof (pit as any).enriched === "number");
    check("offline placeholder is final (enriched=1, no background call)", (pit as any).enriched === 1);

    // (3) PARALLEL surface: many newly-ready sessions all get items in ONE tick.
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(mock(`enrich-par-${i}`, [{ role: "assistant", text: `Should I do thing ${i}? (yes/no)` }], { title: `par ${i}` }));
    await engine.tick();
    const surfaced = ids.filter((id) => engine.queue().some((q) => q.session_id === id));
    check("all 5 newly-ready sessions surfaced in a single (parallel) tick", surfaced.length === 5, `${surfaced.length}/5`);
    for (const id of ids) ctrl.ack(engine.queue().find((q) => q.session_id === id)!.id);
    ctrl.ack(pit.id);
  }

  console.log("\n== COMPLEX → auto-open terminal config flag ==");
  {
    const st = ctrl.state();
    check("state() exposes UI config block", !!st.config);
    check("auto_open_terminal_on_complex defaults ON", st.config.auto_open_terminal_on_complex === true);
    check("auto_diff_on_pr_review defaults ON", st.config.auto_diff_on_pr_review === true);
    check("auto_html_on_viz defaults ON", st.config.auto_html_on_viz === true);
    check("terminal_poll_ms surfaced to renderer (200)", st.config.terminal_poll_ms === 200);
    check("context-aware pane widths exposed (pr narrower than default)", typeof st.config.pane_a_frac_pr === "number" && typeof st.config.pane_a_frac_default === "number" && st.config.pane_a_frac_pr < st.config.pane_a_frac_default);
    check("loadConfig surfaces a numeric tick_interval_ms", typeof cfg.tick_interval_ms === "number" && cfg.tick_interval_ms > 0);
    check("loadConfig has terminal_poll_ms=200", cfg.terminal_poll_ms === 200);
  }

  console.log("\n== Learning loop — Stage A: capture training examples ==");
  {
    const { recentExamples } = require("../core/db");
    const countKind = (k: string) => recentExamples(db, 200).filter((e: any) => e.kind === k).length;
    // leapfrog: force HI above LO, complete LO
    const hi = mock("tex-hi", [{ role: "assistant", text: "Should I deploy hi? (yes/no)" }], { title: "tex HI" });
    const lo = mock("tex-lo", [{ role: "assistant", text: "Should I deploy lo? (yes/no)" }], { title: "tex LO" });
    await engine.tick();
    ctrl.setManualImportance(hi, 100);
    await engine.tick();
    const beforeLeap = countKind("leapfrog");
    const beforeMI = countKind("manual_importance"); // setManualImportance(hi,100) above already logged one
    const loItem = engine.queue().find((q) => q.session_id === lo)!;
    ctrl.sendAnswer(loItem.id, "yes");
    const lt = recentExamples(db, 5).find((e: any) => e.kind === "leapfrog");
    check("leapfrog example captured", countKind("leapfrog") === beforeLeap + 1);
    check("leapfrog state is the queue feature snapshot (array w/ rank+llm_importance)", Array.isArray(lt.state) && lt.state.length >= 2 && typeof lt.state[0].rank === "number" && "llm_importance" in lt.state[0]);
    check("leapfrog correct records the picked item", lt.correct && lt.correct.picked === loItem.id && Array.isArray(lt.correct.skippedHigher));
    // manual importance override (already fired for hi above)
    check("manual_importance example captured on override", beforeMI >= 1);
    const mi = recentExamples(db, 50).find((e: any) => e.kind === "manual_importance");
    check("manual_importance correct stores the operator value", mi && mi.correct.manual_importance === 100 && "llm_importance" in mi.predicted);
    // snooze of a high-ranked item
    const sx = mock("tex-snz", [{ role: "assistant", text: "Should I X? (yes/no)" }], { title: "tex snz" });
    ctrl.setManualImportance(sx, 100); // force it to the top
    await engine.tick();
    const beforeSnz = countKind("snooze_high");
    const sxItem = engine.queue().find((q) => q.session_id === sx)!;
    ctrl.snooze(sxItem.id, 1);
    check("snooze_high example captured for a top item", countKind("snooze_high") === beforeSnz + 1);
    // triage wrong
    const beforeTW = countKind("triage_wrong");
    ctrl.feedback(sxItem.id, "wrong");
    check("triage_wrong example captured on 'wrong' feedback", countKind("triage_wrong") === beforeTW + 1);
    // applied flag plumbing
    const { unappliedExamples, markExamplesApplied } = require("../core/db");
    const un = unappliedExamples(db, 1000);
    check("unapplied examples exist before the dream", un.length >= 4);
    markExamplesApplied(db, [un[0].id]);
    check("markExamplesApplied flips the flag", unappliedExamples(db, 1000).length === un.length - 1);
  }

  console.log("\n== Learning loop — Stage B: nightly small-LR weight tuning ==");
  {
    const { recordExample, unappliedExamples, markExamplesApplied, getLearnedWeights } = require("../core/db");
    const { tuneWeightsFromExamples } = require("../core/dream");
    // isolate: clear any pending examples from Stage A
    markExamplesApplied(db, unappliedExamples(db, 1000).map((e: any) => e.id));
    // craft a leapfrog: operator PICKED a focus-matched/low-importance item over a
    // high-importance/no-focus item → should raise focus_match, lower llm_importance.
    const state = [
      { id: 901, rank: 0, llm_importance: 90, focus_match: 0, blocks_other_work: 0, effort_small: 0, staleness: 0, deadline: 0 },
      { id: 902, rank: 1, llm_importance: 10, focus_match: 1, blocks_other_work: 0, effort_small: 0, staleness: 0, deadline: 0 },
    ];
    recordExample(db, "leapfrog", state, { order: [901, 902] }, { picked: 902, skippedHigher: [901] });
    const before = getLearnedWeights(db);
    const wc = tuneWeightsFromExamples(db);
    const after = getLearnedWeights(db);
    check("tuning produced bounded weight changes", wc.length >= 1 && wc.every((w: any) => Math.abs(w.step) <= 2));
    check("focus_match weight nudged UP (operator favored the focus-matched pick)", (after.focus_match || 0) > (before.focus_match || 0), `${before.focus_match}→${after.focus_match}`);
    check("llm_importance weight nudged DOWN (pick had lower importance)", (after.llm_importance || 0) < (before.llm_importance || 0), `${before.llm_importance}→${after.llm_importance}`);
    check("examples marked applied after tuning", unappliedExamples(db, 1000).length === 0);
    // effective weight = base + learned delta (engine surfaces it)
    const eff = engine.effectiveWeights();
    check("effective focus_match = base + learned delta", Math.abs(eff.focus_match - (cfg.weights.focus_match + (after.focus_match || 0))) < 1e-6, `${eff.focus_match}`);

    // HINGE: an already-correct pair (picked already scores higher) → NO weight change.
    const fmBefore = (getLearnedWeights(db).focus_match) || 0;
    recordExample(db, "leapfrog",
      [{ id: 801, rank: 0, llm_importance: 5, focus_match: 0 }, { id: 802, rank: 1, llm_importance: 95, focus_match: 1 }],
      { order: [801, 802] }, { picked: 802, skippedHigher: [801] }); // 802 already outscores 801
    const wc2 = tuneWeightsFromExamples(db);
    check("hinge guard: already-correct pair drives no weight change", ((getLearnedWeights(db).focus_match) || 0) === fmBefore && wc2.length === 0, JSON.stringify(wc2));

    // MANUAL_IMPORTANCE → per-CATEGORY importance bias (signal_adjustments), not the weight vector.
    const { allAdjustments } = require("../core/feedback");
    const catBefore = (allAdjustments(db).find((a: any) => a.key === "category:SIMPLE_QUESTION")?.adjustment) || 0;
    for (let i = 0; i < 3; i++) recordExample(db, "manual_importance", { id: 700 + i, category: "SIMPLE_QUESTION", llm_importance: 20 }, { llm_importance: 20 }, { manual_importance: 95 });
    const wc3 = tuneWeightsFromExamples(db);
    const catAfter = (allAdjustments(db).find((a: any) => a.key === "category:SIMPLE_QUESTION")?.adjustment) || 0;
    check("manual_importance nudges the CATEGORY bias UP (operator rated it above LLM)", catAfter > catBefore, `${catBefore}→${catAfter}`);
    check("manual_importance did NOT touch the weight vector", !wc3.some((w: any) => ["llm_importance", "focus_match"].includes(w.key)));

    // RELATIVE CLAMP: cumulative learned delta stays within ±50% of base weight.
    for (let i = 0; i < 60; i++) recordExample(db, "leapfrog", [{ id: 1, rank: 0, llm_importance: 90, focus_match: 0 }, { id: 2, rank: 1, llm_importance: 0, focus_match: 1 }], { order: [1, 2] }, { picked: 2, skippedHigher: [1] });
    for (let i = 0; i < 60; i++) tuneWeightsFromExamples(db);
    const fmDelta = (getLearnedWeights(db).focus_match) || 0;
    check("learned delta clamped to ≤50% of base", Math.abs(fmDelta) <= cfg.weights.focus_match * 0.5 + 1e-6, `|${fmDelta}| ≤ ${cfg.weights.focus_match * 0.5}`);
  }

  console.log("\n== Learning loop — Stage C: RANKING.md rules layer ==");
  {
    const { recordExample } = require("../core/db");
    const { evolveRankingMd, readRanking } = require("../core/ranking");
    const { buildPrompt } = require("../core/enrich");
    // ensure there's at least one example to evolve from
    recordExample(db, "manual_importance", { id: 1, category: "SIMPLE_QUESTION" }, { llm_importance: 30 }, { manual_importance: 95 });
    const MARK = "TEST_RULE_prod_reliability_first";
    const stub = async (_prompt: string) => `# Operator ranking preferences (learned)\n\n- ${MARK}\n- focus-matched tasks beat raw importance\n`;
    const before = readRanking();
    const r = await evolveRankingMd(db, "haiku", stub);
    check("evolveRankingMd reports changed", r.changed === true);
    check("RANKING.md was written with the evolved rule", readRanking().includes(MARK));
    check("evolve did not no-op against the stub output", readRanking() !== before);
    // the stub received the CURRENT file + examples (it evolves, not blind-writes) — verify
    // the importance prompt now injects RANKING.md as learned preferences.
    const prompt = buildPrompt({ category: "SIMPLE_QUESTION", title: "t", questionText: "Should I X? (yes/no)", lastPrompt: "", recentTranscript: "", focus: "", changedLines: 0, model: "haiku" });
    check("importance prompt injects RANKING.md (learned preferences)", /learned ranking preferences/i.test(prompt) && prompt.includes(MARK));
    check("enrich prompt asks for the written `context` brief", /^context:/m.test(prompt));

    // Stage C.2: the dream auto-commits + pushes RANKING.md (no manual push). Inject a fake git
    // runner so we assert the exact pathspec-scoped commands without touching the real repo.
    const { commitAndPushRankingMd } = require("../core/ranking");
    const calls: string[][] = [];
    const fakeGit = (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return " M config/RANKING.md\n"; // pretend it changed
      return "";
    };
    const res = commitAndPushRankingMd({ git: fakeGit });
    check("commitAndPushRankingMd committed + pushed", res.committed === true && res.pushed === true);
    check("it commits ONLY the RANKING.md pathspec (no blanket add)", calls.some(a => a[0] === "add" && a.includes("--") && a[a.length - 1] === "config/RANKING.md") && !calls.some(a => a[0] === "add" && (a.includes(".") || a.includes("-A"))));
    check("the commit is pathspec-scoped too", calls.some(a => a[0] === "commit" && a.includes("--") && a[a.length - 1] === "config/RANKING.md"));
    check("it pushes", calls.some(a => a[0] === "push"));
    // no-op when RANKING.md is clean: no commit/push issued
    const calls2: string[][] = [];
    const cleanGit = (args: string[]) => { calls2.push(args); return ""; /* status => empty => clean */ };
    const res2 = commitAndPushRankingMd({ git: cleanGit });
    check("clean RANKING.md → no commit, no push", res2.committed === false && res2.pushed === false && !calls2.some(a => a[0] === "commit" || a[0] === "push"));
  }

  console.log("\n== Learning loop — Stage D: inspector state ==");
  {
    const st = ctrl.state();
    check("state.learning exists", !!st.learning);
    check("learning.weights show base + delta → effective", Array.isArray(st.learning.weights) && st.learning.weights.length >= 1 && "base" in st.learning.weights[0] && "delta" in st.learning.weights[0] && "effective" in st.learning.weights[0]);
    const fm = st.learning.weights.find((w: any) => w.key === "focus_match");
    check("a learned delta is reflected in effective (focus_match)", !!fm && Math.abs(fm.effective - (fm.base + fm.delta)) < 1e-6);
    check("learning.examples present", Array.isArray(st.learning.examples));
    check("learning.ranking is the RANKING.md text", typeof st.learning.ranking === "string" && st.learning.ranking.length > 0);
  }

  console.log("\n== Demo PR backed by a REAL throwaway git repo (from→to + real merge) ==");
  {
    const { execFileSync } = require("child_process");
    const { buildDemoPrRepo } = require("../core/demo");
    const { upsertPr } = require("../core/db");
    const dsm4 = new SessionManager(db, true);
    const dctrl4 = new Controller(db, engine, dsm4, cfg, true);
    const repo = buildDemoPrRepo();
    check("throwaway repo has main + feature branch", typeof repo.path === "string" && repo.head === "feature/add-retry-sqs" && repo.base === "main");
    const prId = upsertPr(db, { repo: "demo/example-service", number: 77, title: "demo pr", url: "https://example.invalid/x", author: "octocat", updatedAt: "2026-06-08T00:00:00Z", reviewDecision: "REVIEW_REQUIRED", isDraft: false, additions: 9, deletions: 2, headRef: repo.head, baseRef: repo.base });
    db.prepare("UPDATE sessions SET pr_local_repo=? WHERE id=?").run(repo.path, prId);
    const d = await dctrl4.prDiff(prId);
    check("demo prDiff returns the REAL git diff (mentions retry/backoff)", d.ok && /retries|backoff|dead_letter/.test(d.diff), d.diff.slice(0, 80));
    const mainBefore = execFileSync("git", ["-C", repo.path, "log", "--oneline", "main"], { encoding: "utf8" });
    check("main has NOT been merged yet", !/backoff retry/.test(mainBefore));
    const m = await dctrl4.prMerge(prId);
    check("demo prMerge reports a visible merged result", m.ok && /merged feature\/add-retry-sqs → main/.test(m.output), m.output);
    const mainAfter = execFileSync("git", ["-C", repo.path, "log", "--oneline", "main"], { encoding: "utf8" });
    check("main now contains the merged feature commits", /backoff retry/.test(mainAfter), mainAfter.split("\n")[0]);
    check("demo PR session marked merged after the real merge", (db.prepare("SELECT pr_review_decision FROM sessions WHERE id=?").get(prId) as any)?.pr_review_decision === "merged");
    try { execFileSync("rm", ["-rf", repo.path]); } catch {}
  }

  console.log("\n== New ephemeral sessions (← / Ctrl+B C/c) ==");
  {
    const dsm = new SessionManager(db, true);
    const dctrl3 = new Controller(db, engine, dsm, cfg, true);
    // Ctrl+B c — a plain shell session: kind='shell', NOT surfaced in the queue.
    const sh = dctrl3.newSession("shell");
    check("newSession(shell) ok + id", sh.ok && typeof sh.sessionId === "number");
    const shRow = dsm.list().find((x) => x.id === sh.sessionId)!;
    check("shell session has kind='shell' and provisional=1", shRow.kind === "shell" && (shRow as any).provisional === 1, JSON.stringify({ kind: shRow.kind, p: (shRow as any).provisional }));
    await engine.tick();
    check("shell session NEVER enters the priority queue", !engine.queue().some((q) => q.session_id === sh.sessionId));

    // Ctrl+B C — a claude session, ephemeral.
    const cc = dctrl3.newSession("claude");
    check("newSession(claude) ok", cc.ok && typeof cc.sessionId === "number");
    check("claude session kind='claude' provisional=1", dsm.list().find((x) => x.id === cc.sessionId)!.kind === "claude");

    // Untouched provisional → DELETED on detach.
    const before = dsm.list().length;
    const r1 = dctrl3.cleanupOrPromoteProvisional(cc.sessionId!);
    check("untouched provisional is DELETED on detach", r1.action === "deleted" && dsm.list().length === before - 1, JSON.stringify(r1));
    check("deleted session is gone from the db", !dsm.list().some((x) => x.id === cc.sessionId));

    // Used provisional (input sent) → PROMOTED, kept.
    const cc2 = dctrl3.newSession("claude");
    dctrl3.markSessionInput(cc2.sessionId!);
    const r2 = dctrl3.cleanupOrPromoteProvisional(cc2.sessionId!);
    check("used provisional is PROMOTED (kept)", r2.action === "promoted" && dsm.list().some((x) => x.id === cc2.sessionId));
    check("promoted session is no longer provisional", (dsm.list().find((x) => x.id === cc2.sessionId) as any).provisional === 0);

    // Ctrl+G i — a SEEDED session is a WRITTEN TASK: titled with the operator's words and never
    // provisional, so NO cleanup path can ever delete it (2026-06-11 vanished-task guarantee).
    const cc3 = dctrl3.newSession("claude", "apply the S3 review fixes");
    const cc3row = dsm.list().find((x) => x.id === cc3.sessionId)!;
    check("seeded session is titled with the prompt", cc3row.title === "apply the S3 review fixes", cc3row.title);
    check("seeded session is NOT provisional", (cc3row as any).provisional === 0);
    const r3 = dctrl3.cleanupOrPromoteProvisional(cc3.sessionId!);
    check("detach can never delete a seeded session", r3.action === "kept" && dsm.list().some((x) => x.id === cc3.sessionId));
    // cleanup shell
    dctrl3.cleanupOrPromoteProvisional(sh.sessionId!);
  }

  console.log("\n== Cockpit-tagged PR review comments (/pr · /prteam) ==");
  {
    const { parseCockpitMarkers, reviewStats } = require("../core/pr_comments");
    const comments = [
      { body: `<!-- cockpit:prteam tier=deep verdict=GREEN rounds=3 tests=pass session=task/foo ts=2026-06-08T07:40:00Z -->\n**/prteam (deep) — GREEN**\nconverged`, author: { login: "octocat" }, createdAt: "2026-06-08T07:40:05Z" },
      { body: `<!-- cockpit:pr verdict=RED tests=fail session=task/foo ts=2026-06-08T06:15:00Z -->\n**Code review — RED**\n1 Important`, author: "octocat", createdAt: "2026-06-08T06:15:02Z" },
      { body: "just a normal human comment, no marker" },
    ];
    const runs = parseCockpitMarkers(comments);
    check("parses exactly the 2 cockpit-tagged comments", runs.length === 2, `${runs.length}`);
    check("parses prteam fields (tier/rounds/verdict/tests/session)", runs[0].type === "prteam" && runs[0].tier === "deep" && runs[0].rounds === "3" && runs[0].verdict === "GREEN" && runs[0].tests === "pass" && runs[0].session === "task/foo");
    check("parses pr verdict=RED tests=fail", runs.some((r: any) => r.type === "pr" && r.verdict === "RED" && r.tests === "fail"));
    check("newest run first (by ts)", runs[0].ts >= runs[1].ts);
    const st = reviewStats([runs, []]);
    check("stats: 1 PR, 1 /pr + 1 /prteam, 1 green 1 red", st.prs === 1 && st.prRuns === 1 && st.prteamRuns === 1 && st.green === 1 && st.red === 1, JSON.stringify(st));
  }

  console.log("\n== New-session launcher (← in detail) ==");
  {
    // Use a DEMO controller so launch() registers a sandbox session (no real worktree/claude).
    const dsm = new SessionManager(db, true);
    const dctrl2 = new Controller(db, engine, dsm, cfg, true);
    const st = dctrl2.state();
    check("state.config exposes sessions_repos", Array.isArray(st.config.sessions_repos));
    const before = dsm.list().length;
    const launchRepo = st.config.sessions_repos[0] || "/tmp/demo-repo";
    const r = dctrl2.launchSession(launchRepo, "scratch idea", "look into the flaky test");
    check("launchSession returns ok + a sessionId", r.ok && typeof r.sessionId === "number", JSON.stringify(r));
    check("launchSession created a tracked session", dsm.list().length === before + 1);
    const created = dsm.list().find((s) => s.id === r.sessionId);
    check("new session carries the given title", !!created && created.title === "scratch idea", created && created.title);
  }

  console.log("\n== Worktree diff (split-diff source) ==");
  {
    const wd = mock("wt-diff", [{ role: "assistant", text: "review the diff please" }], { title: "wt diff" }, 20);
    await engine.tick();
    const r = await ctrl.worktreeDiff(wd);
    check("worktreeDiff returns ok with a unified patch", r.ok && typeof r.diff === "string");
    check("worktreeDiff patch contains diff markers", /(^|\n)(diff --git|@@|\+|-)/.test(r.diff) || r.diff.length >= 0);

    // ---- branch-vs-base diff (any session, no PR needed) ----
    {
      const cp = require("child_process");
      const { branchVsBaseDiff, resolveBaseBranch } = require("../core/diff");
      const repo = path.join(wtRoot, "branch-vs-base");
      fs.mkdirSync(repo, { recursive: true });
      const g = (args: string[]) => cp.execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
      g(["init", "-q", "-b", "integration"]);
      g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
      fs.writeFileSync(path.join(repo, "a.txt"), "base line 1\nbase line 2\n");
      g(["add", "-A"]); g(["commit", "-qm", "base"]);
      g(["checkout", "-q", "-b", "task/feature"]);
      fs.writeFileSync(path.join(repo, "a.txt"), "base line 1\nFEATURE committed\n"); // committed change
      g(["add", "-A"]); g(["commit", "-qm", "feature work"]);
      fs.writeFileSync(path.join(repo, "a.txt"), "base line 1\nFEATURE committed\nUNCOMMITTED edit\n"); // uncommitted
      const base = await resolveBaseBranch(repo, "integration", null);
      check("resolveBaseBranch picks the configured integration", base === "integration", base);
      const bd = await branchVsBaseDiff(repo, "integration", null);
      check("branchVsBaseDiff resolves branch + base", bd.branch === "task/feature" && bd.base === "integration", `${bd.branch}/${bd.base}`);
      check("branchVsBaseDiff includes the COMMITTED change", bd.patch.includes("FEATURE committed"));
      check("branchVsBaseDiff includes the UNCOMMITTED change", bd.patch.includes("UNCOMMITTED edit"));
      check("branchVsBaseDiff reports a short merge-base sha for the header", /^[0-9a-f]{7}$/.test(bd.mergeBase || ""), bd.mergeBase);
      // merge-base immunity: advance integration AFTER branching → diff still shows only
      // the branch's own changes (not a reverse-diff of devMaster's new commits).
      g(["checkout", "-q", "-f", "integration"]); // -f: discard the test's uncommitted edit
      fs.writeFileSync(path.join(repo, "b.txt"), "devmaster moved ahead\n");
      g(["add", "-A"]); g(["commit", "-qm", "devmaster advances"]);
      g(["checkout", "-q", "-f", "task/feature"]);
      const bd2 = await branchVsBaseDiff(repo, "integration", null);
      check("merge-base diff is immune to base moving ahead (no reverse-diff of b.txt)", !bd2.patch.includes("devmaster moved ahead") && bd2.patch.includes("FEATURE committed"));
      // base fallback: a repo whose only branch is master → no integration, falls to master? (current=master → none)
      const fb = await resolveBaseBranch(repo, "no-such-base", null);
      check("resolveBaseBranch falls back when configured base is absent", fb === "" || fb !== "no-such-base");

      // ---- diffExpand plumbing: resolveDiffAgainst + fileDiffWithContext (the NON-PR worktree path
      //      the demo server can't reach — its non-PR sessions hit the demo guard) ----
      {
        const { resolveDiffAgainst, fileDiffWithContext } = require("../core/diff");
        const rda = await resolveDiffAgainst(repo, "integration", null);
        check("resolveDiffAgainst prefers the merge-base of the first candidate sharing history",
          !!rda.mb && rda.against === rda.mb && rda.base === "integration", JSON.stringify(rda));
        check("resolveDiffAgainst returns the SAME rev branchVsBaseDiff diffed against (no drift after the refactor)",
          bd2.mergeBase === rda.mb.slice(0, 7), `${bd2.mergeBase} vs ${rda.mb.slice(0, 7)}`);
        const u0 = await fileDiffWithContext(repo, rda.against, "a.txt", 0);
        // assert on context LINES (leading space); the @@ header carries "function context" text
        check("fileDiffWithContext -U0 has the change but no context LINES",
          u0.includes("FEATURE committed") && !/^ base line/m.test(u0), u0);
        const uAll = await fileDiffWithContext(repo, rda.against, "a.txt", 100000);
        check("fileDiffWithContext huge ctx pulls the whole file in as context", uAll.includes("base line 1"));
        check("fileDiffWithContext clamps NaN ctx to 0 (no throw, same as -U0)",
          (await fileDiffWithContext(repo, rda.against, "a.txt", NaN as any)) === u0);
        check("fileDiffWithContext clamps NEGATIVE ctx to 0",
          (await fileDiffWithContext(repo, rda.against, "a.txt", -7)) === u0);
        // full controller path for a plain WORKTREE session (no PR): worktree_path →
        // resolveDiffAgainst → per-file diff, incl. UNCOMMITTED edits (two-dot semantics).
        g(["branch", "main", "integration"]); // a base name resolveDiffAgainst always tries
        const xsid = sm.register({ repo: "/repo/demo", title: "diff expand wt", worktreePath: repo, branch: "task/feature" });
        const ex = await ctrl.diffExpand(xsid, "a.txt", 100000);
        check("ctrl.diffExpand works for a NON-PR worktree session", ex.ok === true && ex.fileDiff.includes("base line 1"), JSON.stringify(ex));
        fs.appendFileSync(path.join(repo, "a.txt"), "UNCOMMITTED tail\n");
        const ex2 = await ctrl.diffExpand(xsid, "a.txt", 0);
        check("ctrl.diffExpand includes UNCOMMITTED worktree edits (two-dot semantics)",
          ex2.ok === true && ex2.fileDiff.includes("UNCOMMITTED tail"), JSON.stringify(ex2));
        // glob chars in a FILENAME must match literally (:(literal) pathspec), not as a pattern
        // that pulls other files into the cut.
        fs.writeFileSync(path.join(repo, "we[i]rd*.txt"), "glob name base\n");
        g(["add", "-A"]); g(["commit", "-qm", "glob-named file"]);
        fs.appendFileSync(path.join(repo, "we[i]rd*.txt"), "glob name CHANGED\n");
        const exG = await ctrl.diffExpand(xsid, "we[i]rd*.txt", 3);
        check("ctrl.diffExpand matches glob-char filenames literally (single file, right content)",
          exG.ok === true && exG.fileDiff.includes("glob name CHANGED") && (exG.fileDiff.match(/^diff --git /gm) || []).length === 1,
          JSON.stringify(exG).slice(0, 300));
        check("ctrl.diffExpand glob filename does NOT pattern-match other files",
          exG.ok === true && !exG.fileDiff.includes("a.txt"));
        check("ctrl.diffExpand rejects path traversal", (await ctrl.diffExpand(xsid, "../escape.txt", 3)).ok === false);
        check("ctrl.diffExpand rejects absolute paths", (await ctrl.diffExpand(xsid, "/etc/passwd", 3)).ok === false);
        check("ctrl.diffExpand unknown session → clean ok:false", (await ctrl.diffExpand(987654, "a.txt", 3)).ok === false);
        const noBase = await ctrl.diffExpand(wd, "file.txt", 3);
        check("ctrl.diffExpand single-branch repo → clean 'no base' failure (no throw)", noBase.ok === false);
      }

      // ---- PR-SOURCED expansion: re-cut from a LOCAL clone (fetch + merge-base), the path
      //      real PR cards / pr-attached claude sessions take (gh pr diff on screen) ----
      {
        const { prExpandRange } = require("../core/diff");
        // an "origin": main + a feature branch changing the MIDDLE of a 40-line file
        const origin = path.join(wtRoot, "pr-origin");
        fs.mkdirSync(origin, { recursive: true });
        const go = (args: string[]) => cp.execFileSync("git", args, { cwd: origin, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
        go(["init", "-q", "-b", "main"]);
        go(["config", "user.email", "t@t"]); go(["config", "user.name", "t"]);
        const lines = Array.from({ length: 40 }, (_, i) => `pr line ${i + 1}`);
        fs.writeFileSync(path.join(origin, "doc.md"), lines.join("\n") + "\n");
        go(["add", "-A"]); go(["commit", "-qm", "base"]);
        go(["checkout", "-q", "-b", "feat/widen"]);
        lines[19] = "pr line 20 CHANGED";
        fs.writeFileSync(path.join(origin, "doc.md"), lines.join("\n") + "\n");
        go(["add", "-A"]); go(["commit", "-qm", "feat"]);
        go(["checkout", "-q", "main"]);
        // local clone whose BASENAME matches the PR repo name ("ops/widenrepo" → "widenrepo")
        const clone = path.join(wtRoot, "widenrepo");
        cp.execFileSync("git", ["clone", "-q", origin, clone], { stdio: "ignore" });
        const rr = await prExpandRange(clone, "main", "feat/widen", 0, true);
        check("prExpandRange resolves merge-base..origin/head in a local clone (fetchOk)",
          rr.fetchOk === true && /^[0-9a-f]{40}\.\.origin\/feat\/widen$/.test(rr.range), JSON.stringify(rr));
        // a PR-attached session with NO pr_local_repo, whose own worktree does NOT exist —
        // expansion must come from the clone (sessions_repos), never that worktree.
        const psid = sm.register({ repo: "/repo/demo", title: "pr expand", worktreePath: path.join(wtRoot, "nonexistent-wt"), branch: "feat/widen" });
        db.prepare("UPDATE sessions SET pr_repo='ops/widenrepo', pr_number=99, pr_base_ref='main', pr_head_ref='feat/widen' WHERE id=?").run(psid);
        (ctrl as any).cfg.sessions_repos = [...(((ctrl as any).cfg.sessions_repos as string[]) || []), clone];
        const pe = await ctrl.diffExpand(psid, "doc.md", 100000);
        check("ctrl.diffExpand serves PR-sourced sessions from the local clone (whole file)",
          pe.ok === true && pe.fileDiff.includes("pr line 1") && pe.fileDiff.includes("pr line 40") && pe.fileDiff.includes("pr line 20 CHANGED"),
          JSON.stringify(pe).slice(0, 300));
        const pe0 = await ctrl.diffExpand(psid, "doc.md", 0);
        check("PR-sourced cut is merge-base..head content (-U0 = the changed line, no context LINES)",
          pe0.ok === true && pe0.fileDiff.includes("pr line 20 CHANGED") && !/^ pr line/m.test(pe0.fileDiff), JSON.stringify(pe0).slice(0, 200));
        // new commits on the origin's head branch are picked up via fetch (throttle cleared)
        go(["checkout", "-q", "feat/widen"]);
        fs.appendFileSync(path.join(origin, "doc.md"), "pr line 41 APPENDED\n");
        go(["add", "-A"]); go(["commit", "-qm", "more"]);
        go(["checkout", "-q", "main"]);
        (ctrl as any)._prExpandFetchAt.clear();
        const pe2 = await ctrl.diffExpand(psid, "doc.md", 100000);
        check("PR-sourced expand FETCHES new head commits from origin",
          pe2.ok === true && pe2.fileDiff.includes("pr line 41 APPENDED"), JSON.stringify(pe2).slice(0, 200));
        // pull-ref priority (fork-safe exact head): pin refs/pull/99/head at the CURRENT head,
        // then move the branch — the cut must follow the pinned pull ref, not the moved branch.
        const pinned = go(["rev-parse", "feat/widen"]).trim();
        go(["update-ref", "refs/pull/99/head", pinned]);
        go(["checkout", "-q", "feat/widen"]);
        fs.appendFileSync(path.join(origin, "doc.md"), "pr line 42 BRANCH MOVED\n");
        go(["add", "-A"]); go(["commit", "-qm", "branch moved past the PR head"]);
        go(["checkout", "-q", "main"]);
        (ctrl as any)._prExpandFetchAt.clear();
        const pe3 = await ctrl.diffExpand(psid, "doc.md", 100000);
        check("PR-sourced expand prefers the exact refs/pull/<n>/head over the branch name",
          pe3.ok === true && pe3.fileDiff.includes("pr line 41 APPENDED") && !pe3.fileDiff.includes("BRANCH MOVED"),
          JSON.stringify(pe3).slice(0, 200));
        // failed fetch: origin unreachable → still serves from local refs, but SAYS it's stale,
        // and the throttle stamp is released so the next click retries the fetch.
        cp.execFileSync("git", ["remote", "set-url", "origin", path.join(wtRoot, "no-such-origin")], { cwd: clone, stdio: "ignore" });
        (ctrl as any)._prExpandFetchAt.clear();
        const peStale = await ctrl.diffExpand(psid, "doc.md", 100000);
        check("unreachable origin → cut still served from local refs WITH a stale warning",
          peStale.ok === true && /stale/.test(peStale.warning || ""), JSON.stringify(peStale).slice(0, 200));
        check("failed fetch releases the throttle stamp (next click may retry)",
          (ctrl as any)._prExpandFetchAt.size === 0, String((ctrl as any)._prExpandFetchAt.size));
        // partial-fetch staleness: origin reachable again but the pull ref GONE remotely —
        // branch fetch succeeds, yet the served head is the unfreshened pinned pull ref →
        // must still warn (fetchOk-true-but-stale-head was a silent wrong-content hole).
        cp.execFileSync("git", ["remote", "set-url", "origin", origin], { cwd: clone, stdio: "ignore" });
        go(["update-ref", "-d", "refs/pull/99/head"]);
        (ctrl as any)._prExpandFetchAt.clear();
        const pePartial = await ctrl.diffExpand(psid, "doc.md", 100000);
        check("unfreshened pinned pull ref is served WITH the stale warning (partial fetch)",
          pePartial.ok === true && /stale/.test(pePartial.warning || "") && !pePartial.fileDiff.includes("BRANCH MOVED"),
          JSON.stringify(pePartial).slice(0, 200));
        // no local clone for the PR's repo → clear, actionable refusal (never the wrong worktree)
        db.prepare("UPDATE sessions SET pr_repo='ops/no-such-clone' WHERE id=?").run(psid);
        const miss = await ctrl.diffExpand(psid, "doc.md", 3);
        check("PR-sourced expand without a local clone → clean ok:false naming sessions_repos",
          miss.ok === false && /sessions_repos/.test(miss.error || ""), JSON.stringify(miss));
        // scanPrs must persist pr_base_ref on the owner-tag path (else PR-attached claude
        // sessions refuse expansion with 'retry after the next PR scan' forever).
        const prSrc = fs.readFileSync(path.join(__dirname, "..", "..", "src", "core", "pr.ts"), "utf8");
        check("scanPrs owner-tag UPDATE persists pr_base_ref (diffExpand needs both refs)",
          /UPDATE sessions SET pr_repo=\?, pr_number=\?, pr_head_ref=\?, pr_base_ref=\? WHERE id=\?/.test(prSrc));
      }
    }

    // diff "Viewed" persistence
    check("diffViewed starts empty", Object.keys(ctrl.diffViewed(wd)).length === 0);
    ctrl.setDiffViewed(wd, "src/server/analytics.ts", true);
    ctrl.setDiffViewed(wd, "src/server/alerts.ts", false);
    const v1 = ctrl.diffViewed(wd);
    check("setDiffViewed persists viewed=true", v1["src/server/analytics.ts"] === true);
    check("setDiffViewed stores viewed=false", v1["src/server/alerts.ts"] === false);
    ctrl.setDiffViewed(wd, "src/server/analytics.ts", false); // toggle back (un-view)
    check("toggling viewed updates the stored value", ctrl.diffViewed(wd)["src/server/analytics.ts"] === false);
    check("viewed state is per-session (other session empty)", Object.keys(ctrl.diffViewed(wd + 99999)).length === 0);
  }

  console.log("\n== Snooze a PINNED item → auto-unpin so it can drop ==");
  {
    const pp = mock("snz-pin", [{ role: "assistant", text: "Should I deploy? (yes/no)" }], { title: "snz pin" });
    ctrl.setPinned(pp, true);
    await engine.tick();
    const pinned = engine.queue().find((q) => q.session_id === pp)!;
    check("pinned item sits above PIN_BASE", pinned.priority >= 100000, `${pinned.priority}`);
    ctrl.snooze(pinned.id, 1);
    engine.rerank(); // snooze → quickRerank in production (the item is in Up Next → tick skips it).
    const after = engine.queue().find((q) => q.session_id === pp)!;
    check("snoozing a pinned item AUTO-UNPINS it", (db.prepare("SELECT pinned FROM sessions WHERE id=?").get(pp) as any).pinned === 0);
    check("priority drops BELOW PIN_BASE after unpin+snooze", after.priority < 100000, `${after.priority}`);
    check("and carries the snooze penalty", (db.prepare("SELECT snooze_penalty FROM sessions WHERE id=?").get(pp) as any).snooze_penalty < 0);
    // undo restores pinned + penalty
    ctrl.undo();
    const sess = db.prepare("SELECT pinned, snooze_penalty FROM sessions WHERE id=?").get(pp) as any;
    check("undo restores pinned=1 and clears the penalty", sess.pinned === 1 && sess.snooze_penalty === 0, JSON.stringify(sess));
    ctrl.setPinned(pp, false);
  }

  console.log("\n== Snooze = score penalty (visible, not hidden) ==");
  {
    const sA = mock("snz-a", [{ role: "assistant", text: "Should I enable X? (yes/no)" }], { title: "snz A" });
    await engine.tick();
    const before = engine.queue().find((q) => q.session_id === sA)!;
    const pid = before.id, pBefore = before.priority;
    ctrl.snooze(pid, 1);
    engine.rerank(); // snooze → quickRerank in production.
    const after = engine.queue().find((q) => q.id === pid);
    check("snoozed item remains in the queue (visible)", !!after);
    check("snoozed priority dropped ~100 (the configured penalty)", !!after && after.priority <= pBefore - 90 && after.priority >= pBefore - 110, `${pBefore} -> ${after?.priority}`);
    check("snooze breakdown carries a 'snoozed' term", !!after && after.score_breakdown.breakdown.some((t: any) => t.signal === "snoozed" && t.contribution < 0));
    // stacks (from the current decayed value), capped at 3x
    ctrl.snooze(pid, 1); ctrl.snooze(pid, 1); ctrl.snooze(pid, 1);
    const sess = db.prepare("SELECT snooze_penalty FROM sessions WHERE id=?").get(sA) as any;
    check("snooze penalty stacks but caps at -300 (3x)", sess.snooze_penalty === -300, `${sess.snooze_penalty}`);

    // Answering HALVES the (decayed) penalty (doesn't clear it); ack does NOT change it.
    const pen = () => (db.prepare("SELECT snooze_penalty FROM sessions WHERE id=?").get(sA) as any).snooze_penalty;
    ctrl.sendAnswer(pid, "yes");
    check("sendAnswer halves -300 → -150", pen() === -150, `${pen()}`);
    // resurface the same session to answer again
    const pid2 = engine.queue().find((q) => q.session_id === sA)?.id || pid;
    await engine.tick();
    const it2 = engine.queue().find((q) => q.session_id === sA);
    if (it2) { ctrl.sendAnswer(it2.id, "yes"); check("answering again halves -150 → -75", pen() === -75, `${pen()}`); }
    // ack must NOT change the penalty
    db.prepare("UPDATE sessions SET snooze_penalty=-30 WHERE id=?").run(sA);
    const fresh = (mock("snz-ack", [{ role: "assistant", text: "Should I X? (yes/no)" }], { title: "snz ack" }));
    await engine.tick();
    const ackItem = engine.queue().find((q) => q.session_id === fresh)!;
    db.prepare("UPDATE sessions SET snooze_penalty=-80 WHERE id=?").run(fresh);
    ctrl.ack(ackItem.id);
    check("ack does NOT change the snooze penalty", (db.prepare("SELECT snooze_penalty FROM sessions WHERE id=?").get(fresh) as any).snooze_penalty === -80);
    // undo of an answer restores the EXACT prior penalty (+ decay stamp)
    db.prepare("UPDATE sessions SET snooze_penalty=-120, snoozed_at=? WHERE id=?").run(new Date().toISOString(), sA);
    const it3 = mock("snz-undo", [{ role: "assistant", text: "Should I Y? (yes/no)" }], { title: "snz undo" });
    await engine.tick();
    const it3Stamp = new Date().toISOString();
    db.prepare("UPDATE sessions SET snooze_penalty=-120, snoozed_at=? WHERE id=?").run(it3Stamp, it3);
    const undoItem = engine.queue().find((q) => q.session_id === it3)!;
    ctrl.sendAnswer(undoItem.id, "yes");
    check("answer halved -120 → -60 (undo target)", (db.prepare("SELECT snooze_penalty FROM sessions WHERE id=?").get(it3) as any).snooze_penalty === -60);
    ctrl.undo();
    const undone = db.prepare("SELECT snooze_penalty, snoozed_at FROM sessions WHERE id=?").get(it3) as any;
    check("undo(answer) restores EXACT prior penalty (-120)", undone.snooze_penalty === -120);
    check("undo(answer) restores the EXACT prior decay stamp", undone.snoozed_at === it3Stamp, `${undone.snoozed_at}`);
  }

  console.log("\n== Implicit skip-learning: completing a lower-ranked task logs leapfrog signals ==");
  {
    const dlClear = () => db.prepare("DELETE FROM decision_log").run();
    // Build two fresh waiting items; make A clearly #1 via manual importance, B lower.
    const hi = mock("leap-hi", [{ role: "assistant", text: "Should I deploy hi? (yes/no)" }], { title: "leap HI" });
    const lo = mock("leap-lo", [{ role: "assistant", text: "Should I deploy lo? (yes/no)" }], { title: "leap LO" });
    await engine.tick();
    ctrl.setManualImportance(hi, 100); // force HI to the very top
    await engine.tick();
    const q = engine.queue();
    const hiIdx = q.findIndex((x) => x.session_id === hi);
    const loItem = q.find((x) => x.session_id === lo)!;
    const loIdx = q.findIndex((x) => x.session_id === lo);
    check("HI ranks above LO before the pick", hiIdx < loIdx, `hi=${hiIdx} lo=${loIdx}`);
    dlClear();
    // Operator leapfrogs: completes LO while HI sits above it untouched.
    ctrl.sendAnswer(loItem.id, "yes");
    const logs = db.prepare("SELECT feedback, category FROM decision_log").all() as any[];
    check("logged a 'leapfrogged_pick' for the chosen lower task", logs.some((l) => l.feedback === "leapfrogged_pick"));
    check("logged a 'leapfrogged_over' for the skipped higher task", logs.some((l) => l.feedback === "leapfrogged_over"));
    // Dream folds the signals into per-category nudges.
    const { dream } = require("../core/dream");
    const r = dream(db);
    check("dream produced a change from leapfrog signals", r.changes.length >= 1, JSON.stringify(r.changes));
    // undo removes the leapfrog rows too
    const cntAfter = (db.prepare("SELECT COUNT(*) c FROM decision_log").get() as any).c;
    ctrl.undo();
    const cntUndo = (db.prepare("SELECT COUNT(*) c FROM decision_log").get() as any).c;
    check("undo(sendAnswer) removed the leapfrog decision_log rows", cntUndo < cntAfter, `${cntAfter} -> ${cntUndo}`);
  }

  // ── REGRESSION: the "(no transcript found for this session)" reconnect-spam loop ──────────
  // Bug (2026-06-09): a background-agent session whose transcript EXISTS on disk resolved to null
  // in transcriptFor() — it only checked transcript_path or findTranscript(worktree cwd), never the
  // claude_session_id — so the read-only pane rendered "(no transcript found for this session)" and
  // (because sendReadOnlyTranscript ws.close()'d) the renderer auto-reconnected and re-spammed it
  // forever. These assertions lock in: a transcript named <session-id>.jsonl is ALWAYS found by id,
  // even when the cwd dir has no transcript or holds a DIFFERENT (newer) session's transcript.
  {
    const tdb = openDb(path.join(HOME, "transcript_resolve.db"));
    const tsm = new SessionManager(tdb);

    // The real transcript lives under one project dir, named <uuid>.jsonl (how Claude names them).
    const uuid = "adc91758-be66-4b93-a32f-66eedd06c6d2";
    const realCwd = path.join(HOME, "real-agent-cwd");
    fs.mkdirSync(projectDirFor(realCwd), { recursive: true });
    const realFile = path.join(projectDirFor(realCwd), `${uuid}.jsonl`);
    fs.writeFileSync(realFile, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n");

    // The session is registered against a DIFFERENT worktree whose project dir has NO transcript
    // (the background-agent case). Old code → findTranscript(cwd)=null → "(no transcript found)".
    const orphanCwd = path.join(HOME, "bg-agent-no-transcript-here");
    fs.mkdirSync(orphanCwd, { recursive: true });
    const sid = tsm.register({ repo: "/r", title: "bg-agent", worktreePath: orphanCwd, branch: "x" });
    tdb.prepare("UPDATE sessions SET claude_session_id=? WHERE id=?").run(uuid, sid);

    const row = tsm.list().find((s) => s.id === sid)!;
    const resolved = tsm.transcriptFor(row);
    check("findTranscriptById finds an existing <uuid>.jsonl by id alone", findTranscriptById(uuid) === realFile, `got ${findTranscriptById(uuid)}`);
    check("transcriptFor resolves a bg-agent transcript by claude_session_id (no 'no transcript found' loop)", resolved === realFile, `got ${resolved}`);
    check("transcriptFor NEVER returns the 'no transcript' sentinel when the file exists", resolved !== null && fs.existsSync(resolved!), `got ${resolved}`);

    // And it must NOT grab a DIFFERENT session's transcript that merely shares the cwd dir.
    const otherUuid = "ffffffff-0000-0000-0000-000000000000";
    const sharedCwd = path.join(HOME, "shared-cwd");
    fs.mkdirSync(projectDirFor(sharedCwd), { recursive: true });
    fs.writeFileSync(path.join(projectDirFor(sharedCwd), `${uuid}.jsonl`), "{}\n");
    const otherFile = path.join(projectDirFor(sharedCwd), `${otherUuid}.jsonl`);
    fs.writeFileSync(otherFile, "{}\n");
    // make the OTHER one newer, so the legacy newest-in-dir heuristic would pick the wrong file
    const newer = new Date(); fs.utimesSync(otherFile, newer, newer);
    const sid2 = tsm.register({ repo: "/r", title: "shared", worktreePath: sharedCwd, branch: "y" });
    tdb.prepare("UPDATE sessions SET claude_session_id=? WHERE id=?").run(uuid, sid2);
    const resolved2 = tsm.transcriptFor(tsm.list().find((s) => s.id === sid2)!);
    check("transcriptFor picks the id-matched transcript, not the newest unrelated one in the cwd dir",
      resolved2 === path.join(projectDirFor(sharedCwd), `${uuid}.jsonl`), `got ${resolved2}`);
  }

  console.log("\n== @claude_* WINDOW META: /work sessions get the real title AND their PR auto-attached ==");
  {
    const adb = openDb(path.join(HOME, "tasktag.db"));
    const asm = new SessionManager(adb);
    // A /work cockpit session: the model summarized the slash-command body → useless clean_title,
    // and its branch is cockpit/<name> so prForBranch can never find the task/<name> PR.
    const cockpitCwd = path.join(HOME, "code/your-repo/.cockpit-worktrees/new-claude-session-337");
    fs.mkdirSync(cockpitCwd, { recursive: true });
    const sid = asm.register({ repo: "/r", title: "Pick up the next task from the local kanban board", worktreePath: cockpitCwd, branch: "cockpit/new-claude-session-337" });
    adb.prepare("UPDATE sessions SET clean_title='Select next kanban task', meta_gen_prompts=1, is_live_pane=1 WHERE id=?").run(sid);
    // Inject the tmux window options: this session has a task slug + an opened PR; others none.
    const opts = (s: any) => (s.id === sid
      ? { task: "s3-stream-dl-overlap-prefetch", pr: "https://github.com/your-org/your-repo/pull/759", branch: "task/s3-streaming-dataloader-overlap-prefetch" }
      : {});
    const r1 = await applyTaskWindowMeta(adb, async (s) => opts(s));
    const row = () => adb.prepare("SELECT clean_title, manual_title, meta_gen_prompts, pr_repo, pr_number, pr_url, pr_head_ref FROM sessions WHERE id=?").get(sid) as any;
    check("humanizeTaskTag turns the slug into a readable title", humanizeTaskTag("s3-stream-dl-overlap-prefetch") === "S3 stream dl overlap prefetch", humanizeTaskTag("s3-stream-dl-overlap-prefetch"));
    check("parsePrUrl extracts repo + number from a GitHub PR URL", JSON.stringify(parsePrUrl("https://github.com/your-org/your-repo/pull/759")) === JSON.stringify({ repo: "your-org/your-repo", number: 759 }));
    check("parsePrUrl returns null for a non-PR string", parsePrUrl("not a url") === null && parsePrUrl("") === null);
    check("re-titled the /work session from @claude_task", row().clean_title === "S3 stream dl overlap prefetch", row().clean_title);
    check("stamped the TASK_TAG_TITLED sentinel (model titler will skip it)", row().meta_gen_prompts === TASK_TAG_TITLED, String(row().meta_gen_prompts));
    check("auto-attached the PR from @claude_pr (repo+number+url+head)", row().pr_repo === "your-org/your-repo" && row().pr_number === 759 && /pull\/759$/.test(row().pr_url || "") && row().pr_head_ref === "task/s3-streaming-dataloader-overlap-prefetch", JSON.stringify(row()));
    check("reported one title + one PR set", r1.titled === 1 && r1.prs === 1, JSON.stringify(r1));

    // Idempotent: a second identical pass changes nothing (sentinel skips title; PR already matches).
    const r2 = await applyTaskWindowMeta(adb, async (s) => opts(s));
    check("a second pass is a no-op (title sentinel + PR already attached)", r2.titled === 0 && r2.prs === 0, JSON.stringify(r2));

    // The title sentinel must NOT block a later PR attach (PR arrives after the title).
    const lid = asm.register({ repo: "/r", title: "x", worktreePath: path.join(HOME, "code/your-repo/.cockpit-worktrees/late-pr"), branch: "cockpit/late-pr" });
    adb.prepare("UPDATE sessions SET is_live_pane=1 WHERE id=?").run(lid);
    const lateOpts = (s: any, withPr: boolean) => (s.id === lid ? { task: "late-pr-task", ...(withPr ? { pr: "https://github.com/o/r/pull/12" } : {}) } : {});
    await applyTaskWindowMeta(adb, async (s) => lateOpts(s, false));  // title only, no PR yet
    const afterTitle = adb.prepare("SELECT meta_gen_prompts, pr_number FROM sessions WHERE id=?").get(lid) as any;
    const r3 = await applyTaskWindowMeta(adb, async (s) => lateOpts(s, true));  // PR shows up later
    const afterPr = adb.prepare("SELECT pr_number, pr_repo FROM sessions WHERE id=?").get(lid) as any;
    check("title set first, PR still null", afterTitle.meta_gen_prompts === TASK_TAG_TITLED && afterTitle.pr_number === null);
    check("PR attaches on a later pass even after the title sentinel was set", afterPr.pr_number === 12 && afterPr.pr_repo === "o/r" && r3.prs === 1, JSON.stringify({ afterPr, r3 }));

    // manual_title (operator override) always wins — never overwritten by the tag.
    const mid = asm.register({ repo: "/r", title: "x", worktreePath: path.join(HOME, "code/your-repo/.cockpit-worktrees/manual-one"), branch: "cockpit/manual-one" });
    adb.prepare("UPDATE sessions SET manual_title='My pinned name', is_live_pane=1 WHERE id=?").run(mid);
    await applyTaskWindowMeta(adb, async () => ({ task: "some-tag-here" }));
    const mrow = adb.prepare("SELECT clean_title, manual_title FROM sessions WHERE id=?").get(mid) as any;
    check("manual_title is never clobbered by @claude_task", mrow.manual_title === "My pinned name" && mrow.clean_title !== "Some tag here", `clean=${mrow.clean_title}`);

    // A session with no @claude_* options and an existing model title is left alone.
    const pid = asm.register({ repo: "/r", title: "plain", worktreePath: path.join(HOME, "plain-sess"), branch: "b" });
    adb.prepare("UPDATE sessions SET clean_title='Fix the import stall', is_live_pane=1 WHERE id=?").run(pid);
    await applyTaskWindowMeta(adb, async () => ({}));
    const prow = adb.prepare("SELECT clean_title, pr_number FROM sessions WHERE id=?").get(pid) as any;
    check("a non-task session (no @claude_* options) keeps its title and gets no PR", prow.clean_title === "Fix the import stall" && prow.pr_number === null);

    // controller.sessionPr: an attached PR (stored pr_* fields) must surface even when a prior
    // prForBranch cached a NULL for this branch — exactly the /work case (branch cockpit/<name>
    // has no PR, but pr_number is set from @claude_pr). Without the fix the stale null hid it.
    const sPr = { id: 1, worktree_path: "/wt/x", branch: "cockpit/x", pr_number: 759, pr_repo: "your-org/your-repo", pr_url: "https://github.com/your-org/your-repo/pull/759", pr_base_ref: "integration" };
    (ctrl as any)._prCache.set("/wt/x::cockpit/x", { at: Date.now(), pr: null }); // stale null from prForBranch
    const gotPr = (ctrl as any).sessionPr(sPr);
    check("sessionPr surfaces the stored PR despite a cached null (the /work branch-mismatch case)", gotPr && gotPr.number === 759, JSON.stringify(gotPr));
    (ctrl as any)._prCache.delete("/wt/x::cockpit/x");
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== SESSIONS TIMING: lastActivity = real last-output, never collapsed to 'now' ==");
  {
    // REGRESSION GUARD for the "every session says just now" bug: lastActivityOf MUST use the
    // transcript mtime (the moment Claude last wrote), and must NOT max it against updated_at —
    // the scan tick bumps every session's updated_at to ~now, which would flatten the whole
    // roster to "just now". Here we set distinct OLD transcript mtimes, then a tick (which bumps
    // every updated_at to now), and assert the reported times stay spread out and OLD.
    const sdb = openDb(path.join(HOME, "sessdb.db"));
    const ssm = new SessionManager(sdb);
    const seng = new Engine(sdb, ssm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const sctrl = new Controller(sdb, seng, ssm, cfg);
    const smk = (name: string): { id: number; file: string } => {
      const cwd = path.join(HOME, "sswts", name); fs.mkdirSync(cwd, { recursive: true });
      const file = writeTranscript(cwd, [{ role: "assistant", text: "Should I deploy? (yes/no)" }]);
      return { id: ssm.register({ repo: "/r", title: name, worktreePath: cwd, branch: "cockpit/" + name }), file };
    };
    const now = Date.now();
    const recent = smk("recent");      // ~1 min old
    const threeH = smk("three-hours");  // 3 h old
    const old20 = smk("twenty-hours");  // 20 h old
    const setMtime = (file: string, msAgo: number) => { const t = new Date(now - msAgo); fs.utimesSync(file, t, t); };
    setMtime(recent.file, 60_000);
    setMtime(threeH.file, 3 * 3600_000);
    setMtime(old20.file, 20 * 3600_000);
    // A session with NO transcript: created long ago, but its updated_at is bumped to now by the
    // tick. It must report its created_at age, NOT "just now".
    const noTx = ssm.register({ repo: "/r", title: "no-transcript", worktreePath: path.join(HOME, "sswts-empty"), branch: "cockpit/x" });
    sdb.prepare("UPDATE sessions SET transcript_path=NULL, created_at=? WHERE id=?").run(new Date(now - 5 * 3600_000).toISOString(), noTx);

    await seng.tick(); // bumps EVERY session's updated_at to ~now (the regression trigger)
    sdb.prepare("UPDATE sessions SET updated_at=datetime('now')").run(); // belt-and-suspenders: all updated_at == now

    const byId = new Map(sctrl.state().sessions.map((e: any) => [e.row.id, e]));
    const ageMin = (id: number) => (now - Date.parse(byId.get(id)!.lastActivity)) / 60000;

    check("timing: recent session reads ~minutes old (not bumped to a future/odd value)", Math.abs(ageMin(recent.id) - 1) < 5, `got ${ageMin(recent.id).toFixed(1)}m`);
    check("timing: 3h-old transcript reports ~3h, NOT 'just now'", Math.abs(ageMin(threeH.id) - 180) < 15, `got ${ageMin(threeH.id).toFixed(1)}m`);
    check("timing: 20h-old transcript reports ~20h, NOT 'just now' (the core regression)", Math.abs(ageMin(old20.id) - 1200) < 30, `got ${ageMin(old20.id).toFixed(1)}m`);
    check("timing: transcript-less session falls back to created_at (~5h), NOT the tick-bumped updated_at", Math.abs(ageMin(noTx) - 300) < 15, `got ${ageMin(noTx).toFixed(1)}m`);
    // The user-visible symptom: NOT every session collapses to the same ~now value.
    const ages = [recent.id, threeH.id, old20.id, noTx].map(ageMin);
    check("timing: the roster is SPREAD across time, not all flattened to one ~now value", Math.max(...ages) - Math.min(...ages) > 60, `spread ${(Math.max(...ages) - Math.min(...ages)).toFixed(0)}m`);
    check("timing: every session carries a lastActivity field for the renderer", sctrl.state().sessions.every((e: any) => typeof e.lastActivity === "string" && !!Date.parse(e.lastActivity)));

    // Source guards: the controller must PREFER the transcript mtime and must NOT max it against
    // updated_at (the exact shape of the bug we shipped and fixed).
    const cjs = fs.readFileSync(path.resolve(__dirname, "../../src/core/controller.ts"), "utf8");
    check("timing(src): lastActivityOf uses the transcript mtime", /lastActivityOf[^]*?statSync\([^)]*\)\.mtimeMs/.test(cjs));
    check("timing(src): lastActivityOf does NOT Math.max mtime against updated_at (the bug)", !/lastActivityOf[^]*?Math\.max\([^)]*updated_at/.test(cjs) && !/lastActivityOf[^}]*?Math\.max\(bestMs/.test(cjs));
    // Renderer guards: the Sessions pane must format a relative time and sort by recency.
    const rjs2 = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
    check("timing(src): renderer has a timeAgo helper with a 'just now' threshold", /function timeAgo\(/.test(rjs2) && rjs2.includes('"just now"') && /h ago|m ago/.test(rjs2));
    check("timing(src): renderSessions sorts by lastActivity (newest first) and renders a .sess-ago tag", /renderSessions[^]*?Date\.parse\(b\.lastActivity[^]*?Date\.parse\(a\.lastActivity/.test(rjs2) && /sess-ago/.test(rjs2) && /timeAgo\(s\.lastActivity/.test(rjs2));
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== REGRESSION: 'You asked' shows the LATEST prompt, not a stale earlier one ==");
  {
    // Bug: when Claude does >128KB of tool work after the operator's newest prompt, that prompt
    // scrolls out of the hot 128KB tail (view.lastUserPrompt → null). surface() USED TO fall back
    // to a PREVIOUS item's stored last_prompt — an OLDER turn — so the Overview "You asked" line
    // showed a stale, earlier request. It now deep-scans to recover the TRUE latest prompt.
    const ydb = openDb(path.join(HOME, "youasked.db"));
    const ysm = new SessionManager(ydb);
    const yeng = new Engine(ydb, ysm, cfg, { enrich: false, discover: false, pr: false, kanban: false });
    const cwd = path.join(HOME, "youasked-wt"); fs.mkdirSync(cwd, { recursive: true });
    const sid = ysm.register({ repo: "/r", title: "you-asked", worktreePath: cwd, branch: "cockpit/you-asked" });

    // Tick 1: an OLD prompt + answer (small transcript). Stores item A with last_prompt = the OLD
    // prompt — the stale value the buggy fallback would later wrongly reuse.
    writeTranscript(cwd, [
      { role: "user", text: "OLD prompt — summarize the inference logs" },
      { role: "assistant", text: "Done summarizing." },
    ]);
    await yeng.tick();
    const itemA = ydb.prepare("SELECT last_prompt FROM items WHERE session_id=? ORDER BY id DESC LIMIT 1").get(sid) as any;
    check("setup: first turn stored the OLD prompt", /OLD prompt/.test(itemA?.last_prompt || ""), `got ${JSON.stringify(itemA?.last_prompt)}`);
    // The operator handles item A (answers/dismisses), so the session is no longer pending/locked —
    // exactly the state in which a fresh prompt + a new ready turn can surface a NEW item.
    ydb.prepare("UPDATE items SET status='decided', decision='ack' WHERE session_id=?").run(sid);

    // Tick 2: the operator sends a NEW prompt, then Claude does >128KB of tool work, then a fresh
    // final answer (a NEW ready turn ⇒ new signature). The NEW prompt is now past the 128KB tail.
    const big: any[] = [
      { role: "user", text: "OLD prompt — summarize the inference logs" },
      { role: "assistant", text: "Done summarizing." },
      { role: "user", text: "LATEST prompt — now fix the varlen crash" },
    ];
    for (let i = 0; i < 80; i++) {
      big.push({ role: "assistant", text: "running tool", stop_reason: "tool_use", toolUse: true });
      big.push({ role: "user", toolResult: true, text: `tool output ${i}: ` + "x".repeat(2000) });
    }
    big.push({ role: "assistant", text: "Fixed it; tests pass." });
    const f2 = writeTranscript(cwd, big);
    const newer = new Date(Date.now() - 30_000); fs.utimesSync(f2, newer, newer); // distinct, newer mtime → busts the tail cache
    await yeng.tick();

    const itemB = ydb.prepare("SELECT last_prompt FROM items WHERE session_id=? ORDER BY id DESC LIMIT 1").get(sid) as any;
    check("the newest turn's 'You asked' is the LATEST prompt (deep-recovered past the 128KB tail)",
      /LATEST prompt/.test(itemB?.last_prompt || ""), `got ${JSON.stringify(itemB?.last_prompt)}`);
    check("the newest turn's 'You asked' is NOT the stale earlier prompt",
      !/OLD prompt/.test(itemB?.last_prompt || ""), `got ${JSON.stringify(itemB?.last_prompt)}`);

    // Source guard: surface() must not resurrect a *previous item's* prompt as the fallback.
    const ejs2 = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("youasked(src): surface no longer falls back to a previous item's last_prompt",
      !/SELECT last_prompt FROM items WHERE session_id=\? AND last_prompt/.test(ejs2));
    openDb(process.env.COCKPIT_DB);
  }

  etaTests();
  console.log("\n== Alt+Backspace word-delete wiring (FIX WD: browser + Electron IPC chain) ==");
  altBackspaceWiringTests();
  console.log("\n== Infra tags: engine merges ec2/gpu chips into session tags ==");
  {
    const gdb = openDb(path.join(HOME, "infratags.db"));
    const gsm = new SessionManager(gdb);
    const geng = new Engine(gdb, gsm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false });
    const gcwd = path.join(wtRoot, "gpu-tagged");
    fs.mkdirSync(gcwd, { recursive: true });
    writeTranscript(gcwd, [
      { role: "assistant", text: "Training started on gpubox — nvidia-smi shows all 8 GPUs at 97%. Will babysit." },
    ]);
    const gid = gsm.register({ repo: "/repo/demo", title: "gpu run", worktreePath: gcwd, branch: "cockpit/gpu-run", pid: process.pid });
    gdb.prepare("UPDATE sessions SET tags='[\"training\"]' WHERE id=?").run(gid);
    await geng.tick();
    const gt = JSON.parse((gdb.prepare("SELECT tags FROM sessions WHERE id=?").get(gid) as any).tags);
    check("infra tags: engine merges gpu chip with existing ai tags", gt.includes("training") && gt.includes("gpu"), JSON.stringify(gt));
  }

  console.log("\n== Orphaned teammates surface (completeness guarantee extends to dead teams) ==");
  {
    const tdb = openDb(path.join(HOME, "orphanteam.db"));
    const tsm = new SessionManager(tdb);
    const teng = new Engine(tdb, tsm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false });
    // (a) ORPHAN: a teammate whose whole team has been silent 7h, parked on a result: marker —
    //     suppression lapses, the done-report surfaces, and the teammate-prune must NOT eat it.
    const ocwd = path.join(wtRoot, "orphan-teammate");
    fs.mkdirSync(ocwd, { recursive: true });
    const ofile = writeTranscript(ocwd, [
      { role: "assistant", text: "result: dataloader benchmark finished — 7k files/s, report saved." },
    ]);
    { const oldT = new Date(Date.now() - 7 * 3600_000); fs.utimesSync(ofile, oldT, oldT); }
    const oid = tsm.register({ repo: "/repo/demo", title: "orphan worker", worktreePath: ocwd, branch: "cockpit/orphan-worker", pid: process.pid });
    tdb.prepare("UPDATE sessions SET is_teammate=1, team_name='dead-team' WHERE id=?").run(oid);
    await teng.tick();
    await teng.tick();
    const oIt = teng.queue().find((q) => q.session_id === oid && !(q as any)._team);
    check("orphaned teammate gets NO individual task card (machinery — only its team-group row)", !oIt, JSON.stringify(teng.queue().map(q=>q.session_id)));
    check("orphaned teammate is still MARKED orphaned (nightly reaper uses it)", (tdb.prepare("SELECT teammate_orphaned o FROM sessions WHERE id=?").get(oid) as any).o === 1);
    // (b) LIVE TEAM: a teammate with RECENT team activity stays hidden and pruned as before.
    const lcwd = path.join(wtRoot, "live-teammate");
    fs.mkdirSync(lcwd, { recursive: true });
    writeTranscript(lcwd, [
      { role: "assistant", text: "result: shard 2 done." },
    ]);
    const lid = tsm.register({ repo: "/repo/demo", title: "live worker", worktreePath: lcwd, branch: "cockpit/live-worker", pid: process.pid });
    tdb.prepare("UPDATE sessions SET is_teammate=1, team_name='live-team' WHERE id=?").run(lid);
    await teng.tick();
    check("teammate of a LIVE team stays hidden (no own card)", !teng.queue().find((q) => q.session_id === lid));
    const ejsT = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("orphan(src): teammate prune covers ALL teammate pending cards (orphaned or not)", /WHERE is_teammate=1\)/.test(ejsT) && !/is_teammate=1 AND teammate_orphaned=0/.test(ejsT));
    check("orphan(src): a teammate is always hidden — never an individual card", /A teammate is machinery/.test(ejsT) && /res\.hidden\+\+; continue;\n      \}/.test(ejsT));
  }

  console.log("\n== Auto-continue: stalled-after-tool sessions self-heal (operator request 2026-06-15) ==");
  {
    const adb = openDb(path.join(HOME, "autocontinue.db"));
    const asm = new SessionManager(adb);
    const sent: { id: number; text: string }[] = [];
    (asm as any).sendInput = (s: any, text: string) => { sent.push({ id: s.id, text }); return true; };
    (asm as any).paneBabysit = (pid: string) => (pid === "%AC-babysit" ? "babysit" : null);
    const aeng = new Engine(adb, asm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false });
    const mk = (name: string, lines: any[]): number => {
      const cwd = path.join(wtRoot, "ac-" + name);
      fs.mkdirSync(cwd, { recursive: true });
      const f = writeTranscript(cwd, lines);
      const old11 = new Date(Date.now() - 11 * 60_000); fs.utimesSync(f, old11, old11); // 11 min quiet → clears the 10-min gate
      const id = asm.register({ repo: "/repo/demo", title: name, worktreePath: cwd, branch: "cockpit/ac-" + name });
      // pid stays null → processTreeJiffies null → CPU treated idle; is_live_pane=1 → alive + a pane to send to.
      adb.prepare("UPDATE sessions SET is_live_pane=1, pane_id=? WHERE id=?").run("%AC-" + name, id);
      return id;
    };
    const STALL = [
      { role: "assistant", text: "Writing the report.", toolUse: true, toolName: "Write", toolId: "w1", stop_reason: "tool_use" },
      { role: "user", toolResult: true, toolId: "w1" },
    ];
    const stallId = mk("stall", STALL);
    const askId = mk("ask", [{ role: "assistant", toolUse: true, toolName: "AskUserQuestion", toolId: "q1", stop_reason: "tool_use" }]); // pending Q: tool_use, NO result
    const doneId = mk("done", [{ role: "assistant", text: "All done. result: shipped and verified.", stop_reason: "end_turn" }]);
    const inflightId = mk("inflight", [{ role: "assistant", text: "Running it.", toolUse: true, toolName: "Bash", toolId: "b1", stop_reason: "tool_use" }]); // tool still running: no result
    const babysitId = mk("babysit", STALL);

    await aeng.tick();
    check("auto-continue: a stalled-after-tool session is nudged with 'continue'",
      sent.some((x) => x.id === stallId && x.text === "continue"), JSON.stringify(sent));
    check("auto-continue: the nudged stall stays HIDDEN (operator not bothered)", !aeng.queue().find((q) => q.session_id === stallId));
    check("auto-continue: a PENDING QUESTION (tool_use, no result) is NOT nudged", !sent.some((x) => x.id === askId));
    check("auto-continue: a DONE turn (end_turn) is NOT nudged", !sent.some((x) => x.id === doneId));
    check("auto-continue: an IN-FLIGHT tool (no result yet) is NOT nudged", !sent.some((x) => x.id === inflightId));
    check("auto-continue: a BABYSIT-flagged stall is NOT nudged (intentionally parked)", !sent.some((x) => x.id === babysitId));

    // exhaustion: a stall the nudge can't revive SURFACES after max_attempts (own engine: quiet=0, max=1, retry=0)
    const xcfg = JSON.parse(JSON.stringify(cfg));
    xcfg.auto_continue = { enabled: true, quiet_ms: 0, max_attempts: 1, retry_ms: 0, message: "continue" };
    const xeng = new Engine(adb, asm, xcfg, { enrich: false, discover: false, pr: false, kanban: false });
    const xId = mk("exhaust", STALL);
    sent.length = 0;
    await xeng.tick(); // attempt 1
    check("auto-continue(exhaust): first tick nudges", sent.some((x) => x.id === xId));
    await xeng.tick(); // attempts >= max → surface
    const xItem = xeng.queue().find((q) => q.session_id === xId);
    check("auto-continue: an unrevivable stall SURFACES as WAITING_INPUT after max attempts", xItem?.state === "WAITING_INPUT");

    // ---- FREQUENCY GUARDS: it must NOT send "continue" when not genuinely stalled / too often ----
    // (1) CPU BUSY = mid-generating the continuation → never nudge (climbing jiffies via the seam).
    const bcfg = JSON.parse(JSON.stringify(cfg));
    const beng = new Engine(adb, asm, bcfg, { enrich: false, discover: false, pr: false, kanban: false });
    let busyCtr = 0;
    (beng as any).cpuJiffiesFor = () => (busyCtr += 5_000_000); // ~big burn every tick → never idle
    const busyId = mk("busy", STALL);
    sent.length = 0;
    await beng.tick(); await beng.tick(); await beng.tick();
    check("auto-continue: a CPU-BUSY stall (mid-generation) is NEVER nudged", !sent.some((x) => x.id === busyId), JSON.stringify(sent));

    // (2) RETRY INTERVAL: back-to-back ticks must send AT MOST ONE "continue" (retry_ms not elapsed).
    const reng2 = new Engine(adb, asm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false });
    (reng2 as any).cpuJiffiesFor = () => null; // idle
    const retryId = mk("retry", STALL);
    sent.length = 0;
    await reng2.tick(); await reng2.tick(); await reng2.tick();
    const retrySends = sent.filter((x) => x.id === retryId).length;
    check("auto-continue: 3 quick ticks send EXACTLY ONE 'continue' (retry interval holds)", retrySends === 1, "sends=" + retrySends);

    // (3) QUIET THRESHOLD (operator rule 2026-06-15: must be >10 min stall): a stall quiet only a
    //     few minutes is NOT nudged — only 10+ minutes of total silence counts.
    const qeng = new Engine(adb, asm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false });
    (qeng as any).cpuJiffiesFor = () => null;
    const freshId = mk("fresh", STALL);
    const freshFile = (asm as any).transcriptFor(asm.list().find((x: any) => x.id === freshId));
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000); // 5 min < 10 min gate
    fs.utimesSync(freshFile, fiveMinAgo, fiveMinAgo);
    sent.length = 0;
    await qeng.tick(); await qeng.tick();
    check("auto-continue: a stall quiet only 5 min is NOT nudged (needs 10+ min)", !sent.some((x) => x.id === freshId));

    // ---- "ONLY on REAL stalls" (operator concern 2026-06-15): waiting-for-input is NEVER nudged ----
    const weng = new Engine(adb, asm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false });
    (weng as any).cpuJiffiesFor = () => null; // idle — so ONLY the shape/state guards can stop a nudge
    // a session that asked via the `needs input:` marker (text question, end_turn) — live, quiet, idle
    const needsInputId = mk("needsinput", [{ role: "assistant", text: "needs input: Do you want (a) keep forever, (b) 6 months, or (c) measure first?", stop_reason: "end_turn" }]);
    // a plain text question ending in "?"
    const textQId = mk("textq", [{ role: "assistant", text: "Should I delete the clone now, or measure mads growth first?", stop_reason: "end_turn" }]);
    sent.length = 0;
    await weng.tick(); await weng.tick();
    check("auto-continue: a `needs input:` question is NEVER nudged (waiting on operator)", !sent.some((x) => x.id === needsInputId), JSON.stringify(sent));
    check("auto-continue: a plain text question is NEVER nudged", !sent.some((x) => x.id === textQId));
    // and the audit log records a real nudge (so the operator can verify what actually fired)
    const logF = path.join(HOME, ".audit-probe");
    // re-fire the known-good stall under this engine and confirm the audit file gets a line
    const auditId = mk("audit", STALL);
    sent.length = 0;
    await weng.tick();
    check("auto-continue: a genuine stall under the SAME guards still nudges (guards don't over-block)", sent.some((x) => x.id === auditId));

    const ejsAC = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("auto-continue(src): the nudge requires detector state WORKING + no interactive prompt (never a waiting session)",
      /detected\.state === "WORKING" && !detected\.interactivePrompt &&/.test(ejsAC));
    check("auto-continue(src): every nudge is audit-logged (.run/auto-continue.jsonl)",
      /logAutoContinue\(s, tr\.attempts/.test(ejsAC) && /auto-continue\.jsonl/.test(ejsAC));
    check("auto-continue(src): engine uses pendingToolStall + sendInput, capped + CPU-idle-gated",
      /pendingToolStall\(detected\.view\)/.test(ejsAC) && /this\.sessions\.sendInput\(s, ac\.message\)/.test(ejsAC) && /cpuIdle/.test(ejsAC));
  }

  console.log("\n== Stale-dismiss sweep: dismissed-but-still-waiting sessions come back (2026-06-15) ==");
  {
    const sdb = openDb(path.join(HOME, "staledismiss.db"));
    const ssm = new SessionManager(sdb);
    const seng = new Engine(sdb, ssm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false, heavyPhaseEvery: 1 });
    const mkS = (name: string, lines: any[], ageMin: number): number => {
      const cwd = path.join(wtRoot, "sd-" + name);
      fs.mkdirSync(cwd, { recursive: true });
      const f = writeTranscript(cwd, lines);
      const age = new Date(Date.now() - ageMin * 60_000); fs.utimesSync(f, age, age);
      const id = ssm.register({ repo: "/repo/demo", title: name, worktreePath: cwd, branch: "cockpit/sd-" + name, pid: process.pid });
      return id;
    };
    const dismiss = (sid: number, minAgo: number) => {
      const it = sdb.prepare("SELECT id FROM items WHERE session_id=? ORDER BY id DESC LIMIT 1").get(sid) as any;
      const iso = new Date(Date.now() - minAgo * 60_000).toISOString(); // production stores ISO-with-Z
      sdb.prepare("UPDATE items SET status='decided', decision='done', dismissed_at=?, updated_at=? WHERE id=?").run(iso, iso, it.id);
      return it.id;
    };
    // (1) a dismissed QUESTION whose session is still waiting → reopens after the 15-min grace
    const qId = mkS("question", [{ role: "assistant", text: "Should I bind to port 8080? (yes/no)" }], 20);
    await seng.tick(); // surfaces
    dismiss(qId, 20);  // dismissed 20 min ago (> 15-min grace); session still a question
    await seng.tick();
    check("stale-sweep: a dismissed-but-still-waiting QUESTION reopens after grace", !!seng.queue().find((q) => q.session_id === qId && q.state === "WAITING_INPUT"));
    // (2) a dismissed question dismissed only 5 min ago → NOT yet (within grace)
    const qFresh = mkS("qfresh", [{ role: "assistant", text: "Pick an option? (a/b)" }], 8);
    await seng.tick(); dismiss(qFresh, 5); await seng.tick();
    check("stale-sweep: a question dismissed only 5 min ago stays dismissed (within grace)", !seng.queue().find((q) => q.session_id === qFresh));
    // (3) a dismissed DONE/idle card is NOT reopened by the grace (only the long backstop) — no nagging
    const dId = mkS("doneack", [{ role: "assistant", text: "All done — merged and deployed.", stop_reason: "end_turn" }], 30);
    await seng.tick(); dismiss(dId, 30); await seng.tick();
    check("stale-sweep: an acknowledged DONE card is NOT reopened by the short grace (no nagging)", !seng.queue().find((q) => q.session_id === dId));
    // (4) universal backstop: ANY decided card quiet past guarantee_resurface_hours reopens, even DONE
    const bcfg = JSON.parse(JSON.stringify(cfg)); bcfg.guarantee_resurface_hours = 1; bcfg.dismiss_reopen_grace_min = 0;
    const beng = new Engine(sdb, ssm, bcfg, { enrich: false, discover: false, pr: false, kanban: false, heavyPhaseEvery: 1 });
    const bId = mkS("backstop", [{ role: "assistant", text: "Done.", stop_reason: "end_turn" }], 130); // 130 min quiet
    await beng.tick(); dismiss(bId, 130); await beng.tick();
    check("stale-sweep: the universal backstop reopens any decided card quiet past the window", !!beng.queue().find((q) => q.session_id === bId));
    // (5) NO DUPLICATES: a session with MANY historical decided turns reopens exactly ONE card
    //     (its latest), not one per past turn (2026-06-15 regression: #461 got 7 identical cards).
    const multiId = mkS("multiturn", [{ role: "assistant", text: "Approve the plan? (yes/no)" }], 20);
    await seng.tick();
    const liveItem = sdb.prepare("SELECT id FROM items WHERE session_id=? ORDER BY id DESC LIMIT 1").get(multiId) as any;
    // simulate a long life: several OLD decided items from past turns, all eligible-looking
    const isoOld = new Date(Date.now() - 30 * 60_000).toISOString();
    for (let k = 0; k < 4; k++) {
      sdb.prepare("INSERT INTO items (session_id,state,category,question,priority,status,decision,dismissed_at,updated_at,signature) VALUES (?,?,?,?,?, 'decided','done',?,?,?)")
        .run(multiId, "WAITING_INPUT", "COMPLEX_DECISION", "old turn " + k, 50, isoOld, isoOld, `${multiId}:old${k}`);
    }
    dismiss(multiId, 20); // dismiss the CURRENT (latest) card 20 min ago
    await seng.tick();
    const pend = sdb.prepare("SELECT COUNT(*) c FROM items WHERE session_id=? AND status='pending'").get(multiId) as any;
    check("stale-sweep: a session with many decided turns reopens EXACTLY ONE card (no duplicates)", pend.c === 1, "pending=" + pend.c);

    // (6) HEAVY-PHASE THROTTLE (2026-06-18 perf): discovery + the housekeeping sweeps run only every
    // Nth tick (default ~15s), so a terminal open rarely lands on a busy event loop. Spy on the sweep
    // method directly: with heavyPhaseEvery=3 it must fire on tick 0 and 3, but NOT on 1/2.
    {
      const tdb = openDb(path.join(HOME, "throttle.db"));
      const tsm = new SessionManager(tdb);
      const teng = new Engine(tdb, tsm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false, heavyPhaseEvery: 3 });
      let sweepCalls = 0;
      const proto = Object.getPrototypeOf(teng) as any;
      const origSweep = proto.staleDismissSweep;
      proto.staleDismissSweep = async function (...a: any[]) { sweepCalls++; return origSweep.apply(this, a); };
      try {
        await teng.tick(); // tc=0 → heavy runs
        const afterTick1 = sweepCalls;
        await teng.tick(); // tc=1 → skipped
        await teng.tick(); // tc=2 → skipped
        const afterTick3 = sweepCalls;
        await teng.tick(); // tc=3 → heavy runs again
        const afterTick4 = sweepCalls;
        check("throttle: sweep ran on the first tick (tc=0)", afterTick1 === 1, "calls=" + afterTick1);
        check("throttle: sweep SKIPPED on tc=1 and tc=2 (not every tick)", afterTick3 === 1, "calls=" + afterTick3);
        check("throttle: sweep ran again on the Nth tick (tc=3)", afterTick4 === 2, "calls=" + afterTick4);
      } finally {
        proto.staleDismissSweep = origSweep; // restore (shared prototype across engines)
      }
    }

    const ejsSD = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("stale-sweep(src): only the session's NEWEST item is reopened (MAX(id) + no-existing-pending guard)",
      /i\.id = \(SELECT MAX\(id\) FROM items WHERE session_id = i\.session_id\)/.test(ejsSD) && /NOT EXISTS \(SELECT 1 FROM items p WHERE p\.session_id = i\.session_id AND p\.status = 'pending'\)/.test(ejsSD));
    check("stale-sweep(src): reopen sweep is throttled with discovery (runHeavy), not every tick",
      /staleDismissSweep/.test(ejsSD) && /dismiss_reopen_grace_min/.test(ejsSD) && /runHeavy/.test(ejsSD));
    check("throttle(src): heavy phases (discover + sweeps) gated behind a tick-count cadence",
      /heavyPhaseEvery/.test(ejsSD) && /const runHeavy = tc % heavyEvery === 0/.test(ejsSD));
  }

  console.log("\n== Part R: the ❓ pane flag surfaces deterministically (incident #2) ==");
  // 2026-06-11 incident #2: an AskUserQuestion dialog was ON SCREEN but its assistant turn was
  // NEVER flushed to the .jsonl — the tail still ended at the operator's own message, so every
  // transcript-based layer read "operator just replied ⇒ WORKING" for 73 minutes. The notify-hook
  // flag (@claude_pane_status=input) is the only surviving signal — but it LAGS (2026-06-12: a
  // stale ❓ from before the operator's submit surfaced a session mid-THINKING), so it is believed
  // only when (a) the heuristic shape is transcript-blind, (b) the double-sample is stable, and
  // (c) a user-reply tail has been quiet ≥10 min (past any plausible thinking phase).
  // ISOLATED db/engine: shared-db session ids become claudeos-<id> tmux names that can collide
  // with REAL cockpit sessions (the terminal-identity tests attach by name).
  {
    const rdb = openDb(path.join(HOME, "paneinput.db"));
    const rsm = new SessionManager(rdb);
    const rcfg = JSON.parse(JSON.stringify(cfg));
    rcfg.state_gate.double_sample_gap_ms = 1; // consecutive quick ticks = stable
    const reng = new Engine(rdb, rsm, rcfg, { enrich: false, discover: false, pr: false, kanban: false });

    const rcwd = path.join(wtRoot, "stalled-dialog-incident2");
    fs.mkdirSync(rcwd, { recursive: true });
    const rfile = writeTranscript(rcwd, [
      { role: "assistant", text: "Both done and live. Here's what I did." },
      { role: "user", text: "hmm okey, that is strange, will this happen again?" },
    ]);
    const rid = rsm.register({ repo: "/repo/demo", title: "stalled dialog", worktreePath: rcwd, branch: "cockpit/stalled-dialog", pid: process.pid });
    rdb.prepare("UPDATE sessions SET is_live_pane=1, pane_id='%R1' WHERE id=?").run(rid);
    (rsm as any).paneInput = (paneId: string | null | undefined) => paneId === "%R1";

    // (1) tick 1: no stability sample yet → hidden. (2) tick 2: stable, but the user-reply tail is
    // only ~1 min quiet (writeTranscript's default backdate) → THINKING WINDOW → still hidden.
    await reng.tick();
    check("Part R: ❓ flag does NOT surface on tick 1 (no stability sample yet)",
      !reng.queue().find((q) => q.session_id === rid));
    await reng.tick();
    check("Part R: user-reply tail + ❓ + only ~1 min quiet stays hidden (thinking window)",
      !reng.queue().find((q) => q.session_id === rid));

    // (3) past the thinking window: 15 min of silence → the flag is believed → surfaces.
    { const oldT = new Date(Date.now() - 15 * 60_000); fs.utimesSync(rfile, oldT, oldT); }
    await reng.tick();
    await reng.tick();
    const itR = reng.queue().find((q) => q.session_id === rid);
    check("Part R: ❓-flagged live pane SURFACES once quiet+stable, despite an operator-reply tail (no transcript evidence at all)", !!itR);
    eq("Part R: it surfaces as WAITING_INPUT (a question, not idle/done)", itR?.state, "WAITING_INPUT");

    // (4) the operator deals with the card (dismiss, the REAL 337 shape) but claude is STILL
    // asking — the same-signature decided card must REOPEN (3-min grace honored via backdate).
    rdb.prepare("UPDATE items SET status='decided', decision='done', dismissed_at=datetime('now','-10 minutes'), updated_at=datetime('now','-10 minutes') WHERE id=?").run(itR!.id);
    await reng.tick();
    const reopened = reng.queue().find((q) => q.session_id === rid);
    check("Part R: an ANSWERED card REOPENS while the ❓ flag is still up (asking again/still)", !!reopened && reopened.id === itR!.id);
    eq("Part R: the reopened card is WAITING_INPUT", reopened?.state, "WAITING_INPUT");

    // (5) the same quiet shape WITHOUT the flag stays hidden (operator-reply rule intact).
    (rsm as any).paneInput = () => false;
    const rcwd2 = path.join(wtRoot, "stalled-dialog-noflag");
    fs.mkdirSync(rcwd2, { recursive: true });
    const rfile2 = writeTranscript(rcwd2, [
      { role: "assistant", text: "Both done and live. Here's what I did." },
      { role: "user", text: "hmm okey, that is strange, will this happen again?" },
    ]);
    { const oldT = new Date(Date.now() - 15 * 60_000); fs.utimesSync(rfile2, oldT, oldT); }
    const rid2 = rsm.register({ repo: "/repo/demo", title: "same shape no flag", worktreePath: rcwd2, branch: "cockpit/stalled-dialog-2", pid: process.pid });
    rdb.prepare("UPDATE sessions SET is_live_pane=1, pane_id='%R2' WHERE id=?").run(rid2);
    await reng.tick();
    await reng.tick();
    check("Part R: same shape WITHOUT the flag stays hidden (no regression of the operator-reply rule)",
      !reng.queue().find((q) => q.session_id === rid2));

    // (6) IDLE-PROMPT NOISE: a parked SELF-WAIT end_turn tail also carries ❓ (idle_prompt fires
    // after every turn) — the flag must NOT mint a WAITING_INPUT card for a clean end_turn tail.
    const rcwd3 = path.join(wtRoot, "selfwait-with-idle-flag");
    fs.mkdirSync(rcwd3, { recursive: true });
    writeTranscript(rcwd3, [
      { role: "assistant", text: "Re-staging now. ETA ~40 min — I'll report when done (and confirm the box is terminated)." },
    ]);
    const rid3 = rsm.register({ repo: "/repo/demo", title: "self wait idle flag", worktreePath: rcwd3, branch: "cockpit/selfwait-flag", pid: process.pid });
    rdb.prepare("UPDATE sessions SET is_live_pane=1, pane_id='%R3' WHERE id=?").run(rid3);
    (rsm as any).paneInput = (paneId: string | null | undefined) => paneId === "%R3";
    await reng.tick(); await reng.tick();
    const itR3 = reng.queue().find((q) => q.session_id === rid3);
    check("Part R: a parked SELF-WAIT turn with the idle ❓ flag is NOT minted as WAITING_INPUT by the flag",
      !itR3 || itR3.state !== "WAITING_INPUT");

    // (7) PERSISTENCE ESCAPE (2026-06-17, sup-server-inference-speed): a ❓-flagged pane with a
    // transcript-blind tail (tool_result — the AskUserQuestion was never flushed) that has stayed
    // QUIET past the trust window surfaces as WAITING_INPUT WITHOUT a stability double-sample. This
    // is the case a crash-looping / already-exited asking session never satisfies: the supervisor
    // asked a remediation question, kept crashing, never went stable → its question was hidden.
    // The notify hooks flip the flag to `working`/`done` on the next tool call / turn-end, so a flag
    // STILL reading `input` after minutes of quiet is a genuine unanswered ask. Surfaces on tick 1.
    const rcwd7 = path.join(wtRoot, "crashed-mid-ask");
    fs.mkdirSync(rcwd7, { recursive: true });
    const rfile7 = writeTranscript(rcwd7, [
      { role: "assistant", text: "Running the remediation check", stop_reason: "tool_use", toolUse: true, toolId: "b1" },
      { role: "user", toolResult: true, toolId: "b1", text: "ok" },
    ]);
    { const oldT = new Date(Date.now() - 5 * 60_000); fs.utimesSync(rfile7, oldT, oldT); } // quiet > 2-min trust window
    const rid7 = rsm.register({ repo: "/repo/demo", title: "crashed mid ask", worktreePath: rcwd7, branch: "cockpit/crashed-mid-ask", pid: process.pid });
    rdb.prepare("UPDATE sessions SET is_live_pane=1, pane_id='%R7' WHERE id=?").run(rid7);
    (rsm as any).paneInput = (paneId: string | null | undefined) => paneId === "%R7";
    await reng.tick(); // ONE tick only — the escape must not need a second (stability) sample
    const itR7 = reng.queue().find((q) => q.session_id === rid7);
    check("Part R: ❓ flag + transcript-blind tail quiet > trust window SURFACES on tick 1 (persistence escape, no stability sample)", !!itR7);
    eq("Part R: the persistence-escape card is WAITING_INPUT", itR7?.state, "WAITING_INPUT");

    // (8) the persistence escape must NOT surface a parked SELF-WAIT (clean end_turn tail + idle ❓)
    // even when quiet for ages — that shape is NOT WORKING, so the escape's WORKING gate excludes it
    // (regression guard for the 2026-06-12 eval-babysitter false surface).
    const rcwd8 = path.join(wtRoot, "selfwait-quiet-flag");
    fs.mkdirSync(rcwd8, { recursive: true });
    const rfile8 = writeTranscript(rcwd8, [
      { role: "assistant", text: "Re-staging now. ETA ~40 min — I'll report when done." },
    ]);
    { const oldT = new Date(Date.now() - 30 * 60_000); fs.utimesSync(rfile8, oldT, oldT); } // very quiet
    const rid8 = rsm.register({ repo: "/repo/demo", title: "selfwait quiet flag", worktreePath: rcwd8, branch: "cockpit/selfwait-quiet", pid: process.pid });
    rdb.prepare("UPDATE sessions SET is_live_pane=1, pane_id='%R8' WHERE id=?").run(rid8);
    (rsm as any).paneInput = (paneId: string | null | undefined) => paneId === "%R8";
    await reng.tick(); await reng.tick();
    const itR8 = reng.queue().find((q) => q.session_id === rid8);
    check("Part R: a long-quiet SELF-WAIT with idle ❓ is NOT minted WAITING_INPUT by the persistence escape (clean end_turn ≠ WORKING)",
      !itR8 || itR8.state !== "WAITING_INPUT");

    const ejsR = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("Part R(src): the pane-input override outranks the whole gate (checked before it, no model consult)",
      /paneInput\(s\.pane_id\)/.test(ejsR) && /❓ pane flag/.test(ejsR));
    check("Part R(src): persistence escape surfaces a stranded ❓ flag without the stability sample",
      /PANE_INPUT_TRUST_MS/.test(ejsR) && /flagPersistedQuiet/.test(ejsR));
    check("Part R(src): the persistence escape keeps the WORKING shape gate (no self-wait false surface)",
      /flagUp && detected\.state === "WORKING"/.test(ejsR));
    check("Part R(src): auto-continue never nudges a ❓-flagged pane (would answer a question with 'continue')",
      /!this\.sessions\.paneInput\(s\.pane_id\)/.test(ejsR));
    check("Part R(src): the flag only fires for transcript-blind shapes (heuristic WORKING)",
      /detected\.state === "WORKING"/.test(ejsR) && /paneInput/.test(ejsR));
    check("Part R(src): user-reply tails honor the 10-min thinking window before the flag is believed",
      /operatorJustReplied/.test(ejsR) && /10 \* 60_000/.test(ejsR));
    check("Part R(src): a self-wait verdict with eta_minutes starts the roster countdown",
      /v\.etaMinutes/.test(ejsR) && /setSessionEta\(this\.db, s\.id/.test(ejsR));
    check("Part R(src): pane-asking reopens a decided same-turn card (3-min grace)",
      /ASKING REOPEN/.test(ejsR));
    const sjsR = fs.readFileSync(path.resolve(__dirname, "../../src/core/sessions.ts"), "utf8");
    check("Part R(src): paneInput reads the volatile @claude_pane_status via the shared cached scan",
      /paneInput\(paneId/.test(sjsR) && /inputs/.test(sjsR));
  }

  console.log("\n== Part R2: a DISMISSED card with a still-open question dialog REOPENS (session-475) ==");
  // 2026-06-15: a question card was dismissed 17s after surfacing while the AskUserQuestion dialog
  // stayed OPEN (pending, no tool_result). A dismissed card only reopens on fresh writes, but a
  // blocking dialog produces none → it stayed hidden ~48 min. A pending dialog is not
  // handle-for-now-able: it must keep coming back until actually answered.
  {
    const r2db = openDb(path.join(HOME, "askreopen.db"));
    const r2sm = new SessionManager(r2db);
    const r2eng = new Engine(r2db, r2sm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false });
    const r2cwd = path.join(wtRoot, "ask-dismissed-open");
    fs.mkdirSync(r2cwd, { recursive: true });
    writeTranscript(r2cwd, [
      { role: "assistant", text: "Picking invitees.", toolUse: true, toolName: "AskUserQuestion", toolId: "q1", stop_reason: "tool_use" }, // pending: NO tool_result
    ]);
    const r2id = r2sm.register({ repo: "/repo/demo", title: "ask dismissed open", worktreePath: r2cwd, branch: "cockpit/ask-dismissed-open", pid: process.pid });
    r2db.prepare("UPDATE sessions SET is_live_pane=1, pane_id='%RQ' WHERE id=?").run(r2id);
    (r2sm as any).paneInput = () => false; // rely on transcript-detected pending prompt, not the ❓ flag
    await r2eng.tick();
    const card = r2eng.queue().find((q) => q.session_id === r2id);
    check("Part R2: a pending AskUserQuestion surfaces a card", !!card);
    // operator dismisses it (decided=done) 4 min ago, but the dialog is STILL open
    r2db.prepare("UPDATE items SET status='decided', decision='done', dismissed_at=datetime('now','-4 minutes'), updated_at=datetime('now','-4 minutes') WHERE id=?").run(card!.id);
    check("Part R2: after dismiss the card is gone", !r2eng.queue().find((q) => q.session_id === r2id));
    await r2eng.tick();
    const reopened = r2eng.queue().find((q) => q.session_id === r2id);
    check("Part R2: the still-open dialog REOPENS the dismissed card (not hidden until 6h)", !!reopened && reopened.state === "WAITING_INPUT");
    // once ANSWERED (tool_result lands), it must NOT keep reopening
    r2db.prepare("UPDATE items SET status='decided', decision='answered', updated_at=datetime('now') WHERE id=?").run(card!.id);
    writeTranscript(r2cwd, [
      { role: "assistant", text: "Picking invitees.", toolUse: true, toolName: "AskUserQuestion", toolId: "q1", stop_reason: "tool_use" },
      { role: "user", toolResult: true, toolId: "q1" }, // answered now
    ]);
    await r2eng.tick();
    check("Part R2: an ANSWERED question (tool_result present) does NOT reopen", !r2eng.queue().find((q) => q.session_id === r2id && q.state === "WAITING_INPUT" && q.id === card!.id) || r2eng.queue().find((q)=>q.session_id===r2id)?.state !== "WAITING_INPUT");
    const ejsR2 = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("Part R2(src): asking-reopen covers transcript-detected pending dialogs (pendingInteractivePrompt)",
      /askingNow = state === "WAITING_INPUT" && \(\/❓ pane flag\/.test\(reason\) \|\| \(!!view && !!pendingInteractivePrompt\(view\)\)\)/.test(ejsR2));
  }

  console.log("\n== Part S: a pending question SURFACES even while the session keeps working (incident #3) ==");
  // The session ASKED (AskUserQuestion pending) and then KEPT WORKING — background tools running,
  // transcript still moving. The double-sample never goes stable in that state, and the old order
  // (stability first) hid the question for as long as the work continued. The pending prompt is
  // mechanical truth: it must surface BEFORE the stability gate. A single tick pins this — on the
  // first tick the sampler can never be stable (no prior sample), so surfacing on tick 1 proves
  // the interactive-prompt branch outranks it.
  {
    const sdb = openDb(path.join(HOME, "askwhileworking.db"));
    const ssm = new SessionManager(sdb);
    const seng = new Engine(sdb, ssm, JSON.parse(JSON.stringify(cfg)), { enrich: false, discover: false, pr: false, kanban: false, heavyPhaseEvery: 1 });
    const scwd = path.join(wtRoot, "ask-while-working");
    fs.mkdirSync(scwd, { recursive: true });
    writeTranscript(scwd, [
      { role: "assistant", text: "I need your approval — meanwhile I keep staging in the background.", stop_reason: "tool_use" },
      { role: "assistant", toolUse: true, toolName: "AskUserQuestion", toolId: "q9", stop_reason: "tool_use" },
      { role: "assistant", toolUse: true, toolName: "Bash", toolId: "bg1", stop_reason: "tool_use" },
      { role: "user", toolResult: true, toolId: "bg1" },
    ] as any);
    const sid2 = ssm.register({ repo: "/repo/demo", title: "ask while working", worktreePath: scwd, branch: "cockpit/ask-while-working", pid: process.pid });
    await seng.tick(); // tick 1: sampler unstable by construction
    const itS = seng.queue().find((q) => q.session_id === sid2);
    check("Part S: pending question surfaces on the FIRST tick (stability gate cannot delay it)", !!itS);
    eq("Part S: it surfaces as WAITING_INPUT", itS?.state, "WAITING_INPUT");
    const ejsS = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("Part S(src): interactivePrompt is checked BEFORE the double-sample stability gate",
      ejsS.indexOf("if (detected.interactivePrompt)") < ejsS.indexOf("} else if (!stab.stable)") && ejsS.indexOf("if (detected.interactivePrompt)") > 0);
  }

  stateGateTests(cfg);

  console.log("\n== ETA loop (integration): probe → hold blue → re-check on expiry → always resurfaces ==");
  {
    // Isolated engine with the threshold lowered (production = 60min; tests use 0 so a single tick
    // exercises the loop). reprobe_min=0 so re-check-on-expiry isn't throttled. quiet_period_ms tiny
    // so a transcript written "seconds ago" reads as PARKED, not mid-stream.
    const edb = openDb(path.join(HOME, "eta.db"));
    const esm = new SessionManager(edb);
    const ecfg = JSON.parse(JSON.stringify(cfg));
    ecfg.eta = { enabled: true, probe_after_min: 0, reprobe_min: 0 };
    ecfg.triage.quiet_period_ms = 50;
    const eeng = new Engine(edb, esm, ecfg, { enrich: false, discover: false, pr: false, kanban: false });
    const ectrl = new Controller(edb, eeng, esm, ecfg);
    // A parked babysit session is "alive" (its claude process is at the prompt) — force it so the
    // probe path is reachable offline. Capture probes instead of sending real tmux keystrokes.
    let probeOk = true;
    const sent: { id: number; text: string }[] = [];
    (esm as any).processAlive = () => true;
    (esm as any).sendInput = (s: any, text: string) => { if (probeOk) sent.push({ id: s.id, text }); return probeOk; };

    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const backdate = (file: string, minsAgo: number) => { const t = (Date.now() - minsAgo * 60000) / 1000; fs.utimesSync(file, t, t); };
    const writeReply = (name: string, text: string, minsAgo: number) => backdate(writeTranscript(path.join(HOME, "etawts", name), [{ role: "assistant", text }]), minsAgo);
    const mkEta = (name: string, text: string, minsAgo = 10) => {
      const cwd = path.join(HOME, "etawts", name);
      fs.mkdirSync(cwd, { recursive: true });
      backdate(writeTranscript(cwd, [{ role: "assistant", text }]), minsAgo);
      return esm.register({ repo: "/r", title: name, worktreePath: cwd, branch: "cockpit/" + name });
    };
    const rowOf = (id: number) => edb.prepare("SELECT * FROM sessions WHERE id=?").get(id) as any;
    const inQueue = (id: number) => eeng.queue().some((q) => q.session_id === id);
    // Background a session the way the operator does (Ctrl+G Enter = dismiss) so it leaves Up Next
    // and becomes eligible for ETA management. Backdate the dismiss so a later reply counts as
    // "fresh activity after the dismiss" (FIX P), proving the ETA hold beats the generic resurface.
    const background = (sid: number, dismissMinsAgo = 3) => {
      const it = eeng.queue().find((q) => q.session_id === sid);
      if (it) { ectrl.dismiss(it.id); edb.prepare("UPDATE items SET dismissed_at=? WHERE id=?").run(iso(dismissMinsAgo * 60000), it.id); }
    };

    // 1) A long-silent PARKED session (UNKNOWN, alive, quiet) surfaces (visible). The PASSIVE design
    //    NEVER types into a session — no `/eta` keystroke probe (it polluted live sessions); the
    //    engine instead reads the session's own output (estimate path covered further below).
    const sBabysit = mkEta("babysit", "Monitoring the training run in the background.");
    await eeng.tick();
    check("eta-loop: NOTHING is injected into a parked session (passive — no /eta keystrokes)", sent.length === 0);
    check("eta-loop: with no ETA yet, the session is visible in the Task Queue (never hidden)", inQueue(sBabysit));

    // Operator backgrounds it (Ctrl+G Enter). Now it's out of Up Next and managed purely by ETA.
    background(sBabysit);
    check("eta-loop: backgrounded (dismissed) session leaves the Task Queue", !inQueue(sBabysit));

    // 2) It replies "eta: 50m" → engine records a future finish, HOLDS it out of the queue (blue in
    //    the roster), and does NOT re-probe — even though the reply is fresh activity after the
    //    dismiss that would otherwise resurface it (the ETA hold wins).
    writeReply("babysit", "eta: 50m", 3); // reply 3min ago → its mtime is the freshest activity
    sent.length = 0;
    await eeng.tick();
    const r2 = rowOf(sBabysit);
    check("eta-loop: 'eta: 50m' recorded as a future finish time", !!r2.eta_at && Date.parse(r2.eta_at) > Date.now() + 40 * 60000);
    eq("eta-loop: eta_text stored verbatim", r2.eta_text, "50m");
    check("eta-loop: a session with time left is HELD OUT of the Task Queue", !inQueue(sBabysit));
    check("eta-loop: a future ETA is NOT re-probed (re-check is scheduled for expiry)", !sent.some((x) => x.id === sBabysit));

    // 3) ETA EXPIRES → the hold is released and the task RESURFACES, even with realistic quiet/
    //    reprobe gates set. (The expired-ETA "fresh estimate bypasses the reprobe throttle" half is
    //    behaviorally covered in the PASSIVE-ESTIMATE block below, with Haiku mocked.) Still no
    //    keystrokes: expiry triggers a passive re-estimate, never an injection.
    ecfg.eta.probe_after_min = 4; ecfg.eta.reprobe_min = 4; // realistic gates
    edb.prepare("UPDATE sessions SET eta_at=?, eta_probe_at=? WHERE id=?").run(iso(60000), iso(180000), sBabysit);
    sent.length = 0;
    await eeng.tick();
    check("eta-loop: an expired-but-unrefreshed task RESURFACES in the Task Queue (the guarantee)", inQueue(sBabysit));
    check("eta-loop: expiry never injects keystrokes (passive re-estimate only)", sent.length === 0);
    ecfg.eta.probe_after_min = 0; ecfg.eta.reprobe_min = 0; // restore for remaining scenarios

    // 4) A backgrounded session that reports "eta: done" → countdown clears and it surfaces as DONE.
    const sDone = mkEta("babysit-done", "Kicking off the long sweep now.");
    await eeng.tick();          // surfaces + probes
    background(sDone);          // operator backgrounds it
    writeReply("babysit-done", "eta: done", 1);
    await eeng.tick();
    check("eta-loop: 'eta: done' clears the countdown", rowOf(sDone).eta_at === null);
    const qDone = eeng.queue().find((q) => q.session_id === sDone);
    check("eta-loop: a 'done' session is back in the Task Queue as DONE", !!qDone && qDone.state === "DONE", `state=${qDone?.state}`);

    // 4b) PID-LESS REACHABILITY: a DISCOVERED external pane carries no pid (processAlive=false) but
    //     a live pane — it MUST still be fully ETA-managed. The passive gate doesn't depend on
    //     processAlive at all (the old probe's reachability gate is gone), so a pid-less session's
    //     printed `eta:` marker is parsed and holds it out, exactly like any other session.
    (esm as any).processAlive = () => false;
    const sPaneOnly = mkEta("pane-only", "Watching the deploy roll out.");
    edb.prepare("UPDATE sessions SET is_live_pane=1 WHERE id=?").run(sPaneOnly);
    await eeng.tick();        // surfaces (pid-less is still alive via is_live_pane)
    background(sPaneOnly);
    writeReply("pane-only", "eta: 40m", 1);
    sent.length = 0;
    await eeng.tick();
    const rPane = rowOf(sPaneOnly);
    check("eta-loop: a live-pane session with NO pid is STILL eta-managed (marker parsed + held)",
      !!rPane.eta_at && Date.parse(rPane.eta_at) > Date.now() + 30 * 60000 && !inQueue(sPaneOnly));
    check("eta-loop: pid-less management never injected anything", sent.length === 0);
    (esm as any).processAlive = () => true; // restore for the next scenario

    // 5) THE GUARANTEE, hard case: a never-completing babysit whose pane we can't even reach (probe
    //    can't be delivered) must STILL be visible in the Task Queue — it can never silently vanish.
    probeOk = false;
    const sStuck = mkEta("stuck-babysit", "Still monitoring; nothing to report yet.");
    await eeng.tick();
    check("eta-loop: a session we cannot probe still surfaces in the Task Queue (never vanishes)", inQueue(sStuck));
    check("eta-loop: an undeliverable probe is NOT stamped (so it retries next tick)", rowOf(sStuck).eta_probe_at === null);

    // 6) THE LOCK EXEMPTION: a session the operator does NOT background sits LOCKED in Up Next —
    //    the production default (nobody dismisses every idle card). The lock used to skip handleEta
    //    entirely, so locked sessions never had their eta managed (verified live: eta_probe_at=0 on
    //    every session, ever). A locked idle session must still: run handleEta once quiet (passive —
    //    nothing injected), have a printed `eta:` marker parsed, and swap its idle card for the
    //    countdown once a future finish time is known. (The earlier attempt — holding idle sessions
    //    OUT of Up Next — hid them for up to probe_after_min and was reverted; the card stays visible.)
    probeOk = true;
    const sLocked = mkEta("locked-babysit", "Long benchmark running; checking on it periodically.", 40);
    await eeng.tick(); // surfaces (not locked yet on its surfacing tick)
    check("eta-lock: the idle card SURFACES and stays visible (no pre-estimate hiding)", inQueue(sLocked));
    sent.length = 0;
    await eeng.tick(); // NOW locked (pending item) → the exemption must still run handleEta
    check("eta-lock: the locked eta pass never injects keystrokes (passive design)", sent.length === 0);
    // It answers while still locked → the reply must be parsed and the idle card pulled.
    writeReply("locked-babysit", "eta: 45m", 0);
    (eeng as any).lockedEtaCheckedAt.clear(); // bypass the per-session 60s locked-pass throttle
    await eeng.tick();
    const rL = rowOf(sLocked);
    check("eta-lock: the reply is PARSED while locked (future finish recorded)", !!rL.eta_at && Date.parse(rL.eta_at) > Date.now() + 30 * 60000);
    eq("eta-lock: eta_text stored from the locked parse", rL.eta_text, "45m");
    check("eta-lock: the known-future job's idle card leaves the queue (countdown instead)", !inQueue(sLocked));
    await eeng.tick(); // next tick it's unlocked → the normal etaHold keeps it blue, not resurfaced
    check("eta-lock: it STAYS held out while the ETA is in the future", !inQueue(sLocked));

    // 7) PASSIVE ESTIMATE (Haiku mocked) — the heart of the no-injection design: for a long-running
    //    session the engine reads the session's OWN output (pane capture → transcript tail) and asks
    //    Haiku for the time left. estimateEtaFromOutput is monkey-patched on the CJS module (the
    //    engine resolves it at call time), capturePane is stubbed, and handleEta is driven directly
    //    with enrich ON — we never tick() while enrich is on, so nothing else calls a model.
    {
      const etaMod: any = require("../core/eta");
      const realEstimate = etaMod.estimateEtaFromOutput;
      let estimates = 0;
      etaMod.estimateEtaFromOutput = async () => { estimates++; return { kind: "time", minutes: 50, raw: "50m" }; };
      (esm as any).capturePane = () => "Interval 3/10 ━━━ 42% • ~38m left";
      (eeng as any).opts.enrich = true;
      const settle = () => new Promise((r) => setTimeout(r, 40)); // let the fire-and-forget estimate land
      const mins = (m: number) => Date.now() - m * 60000;
      ecfg.eta.probe_after_min = 4; ecfg.eta.reprobe_min = 4; // realistic gates

      // a) A WORKING session is estimated — the capability the old keystroke probe could NEVER have
      //    (typing into a working session queues behind its foreground tool). Nothing injected.
      const sWork = mkEta("passive-working", "training… interval 3/10", 10);
      sent.length = 0;
      (eeng as any).handleEta(rowOf(sWork), { view: null, mtimeMs: mins(1), processAlive: true }, "WORKING");
      await settle();
      const rW = rowOf(sWork);
      check("eta-passive: a WORKING session gets a passive estimate (50m recorded from its own output)",
        estimates === 1 && !!rW.eta_at && Date.parse(rW.eta_at) > Date.now() + 40 * 60000);
      check("eta-passive: the attempt is stamped (eta_probe_at = last-estimate throttle)", !!rW.eta_probe_at);
      check("eta-passive: estimating injected NOTHING into the session", sent.length === 0);

      // b) Parked (UNKNOWN): recently-active → NOT estimated (quiet gate); quiet ≥ probe_after_min → estimated.
      const sParked = mkEta("passive-parked", "parked at the prompt", 10);
      (eeng as any).handleEta(rowOf(sParked), { view: null, mtimeMs: mins(1), processAlive: true }, "UNKNOWN");
      await settle();
      check("eta-passive: a recently-active parked session is NOT estimated (quiet gate holds)",
        estimates === 1 && rowOf(sParked).eta_at == null);
      (eeng as any).handleEta(rowOf(sParked), { view: null, mtimeMs: mins(10), processAlive: true }, "UNKNOWN");
      await settle();
      check("eta-passive: a quiet parked session IS estimated", estimates === 2 && !!rowOf(sParked).eta_at);

      // c) A still-FUTURE ETA is not re-estimated; an EXPIRED one bypasses the reprobe throttle via
      //    the 60s floor (reprobe_min=4 would otherwise block a 2-min-old stamp) — the live bug.
      (eeng as any).handleEta(rowOf(sParked), { view: null, mtimeMs: mins(10), processAlive: true }, "UNKNOWN");
      await settle();
      check("eta-passive: a future ETA is NOT re-estimated yet", estimates === 2);
      edb.prepare("UPDATE sessions SET eta_at=?, eta_probe_at=? WHERE id=?").run(iso(60000), iso(120000), sParked);
      (eeng as any).handleEta(rowOf(sParked), { view: null, mtimeMs: mins(10), processAlive: true }, "UNKNOWN");
      await settle();
      check("eta-passive: an EXPIRED ETA forces a fresh estimate despite the reprobe throttle (60s floor)",
        estimates === 3);
      edb.prepare("UPDATE sessions SET eta_at=?, eta_probe_at=? WHERE id=?").run(iso(60000), iso(30000), sParked);
      (eeng as any).handleEta(rowOf(sParked), { view: null, mtimeMs: mins(10), processAlive: true }, "UNKNOWN");
      await settle();
      check("eta-passive: …but the 60s floor still throttles back-to-back estimates", estimates === 3);

      // d) The gate has NO reachability term: a pid-less session (processAlive=false — the discovered
      //    external-pane case that the old probe's gate silently excluded) is estimated all the same.
      const sNoPid = mkEta("passive-nopid", "external pane, no pid", 10);
      (eeng as any).handleEta(rowOf(sNoPid), { view: null, mtimeMs: mins(10), processAlive: false }, "UNKNOWN");
      await settle();
      check("eta-passive: a pid-less session is STILL estimated (no processAlive gate)", estimates === 4);

      etaMod.estimateEtaFromOutput = realEstimate;
      (eeng as any).opts.enrich = false;
      ecfg.eta.probe_after_min = 0; ecfg.eta.reprobe_min = 0;
    }

    openDb(process.env.COCKPIT_DB); // restore the shared singleton
  }

  console.log("\n== COMPLETENESS GUARANTEE: no session rots in neither the queue nor a timer ==");
  {
    // Operator invariant: every session is either IN the Task Queue or carries a live countdown.
    // decided/dismissed cards leave the queue on purpose, but if the session then stays COMPLETELY
    // silent (no new turn, no future ETA) past guarantee_resurface_hours, the card must reopen —
    // otherwise it rots invisible at "1 day ago" (the live db had 100+ of these).
    const gdb = openDb(path.join(HOME, "gua.db"));
    const gsm = new SessionManager(gdb);
    const gcfg = JSON.parse(JSON.stringify(cfg));
    (gcfg as any).guarantee_resurface_hours = 6;
    const geng = new Engine(gdb, gsm, gcfg, { enrich: false, discover: false, pr: false, kanban: false });
    const files: Record<string, string> = {};
    const gmk = (n: string, t: string) => {
      const cwd = path.join(HOME, "guawts", n);
      fs.mkdirSync(cwd, { recursive: true });
      files[n] = writeTranscript(cwd, [{ role: "assistant", text: t }]);
      return gsm.register({ repo: "/r", title: n, worktreePath: cwd, branch: "cockpit/" + n });
    };
    const hoursAgo = (f: string, h: number) => { const t = (Date.now() - h * 3600_000) / 1000; fs.utimesSync(f, t, t); };
    const inQ = (id: number) => geng.queue().some((q) => q.session_id === id);
    const decideAgo = (sid: number, h: number) => {
      const it = geng.queue().find((q) => q.session_id === sid)!;
      gdb.prepare(`UPDATE items SET status='decided', decision='answered', updated_at=datetime('now', ?) WHERE id=?`).run(`-${h} hours`, it.id);
    };

    // (a) answered card + session silent past the window → REOPENS
    const sGhost = gmk("ghost", "Should I rerun the full sweep? (yes/no)");
    // (b) answered recently → stays decided (the guarantee must not undo fresh decisions)
    const sFresh = gmk("fresh", "Should I bump the dependency pin? (yes/no)");
    // (c) silent past the window but operator-COMPLETED → stays out (archived)
    const sArch = gmk("archived", "Should I delete the scratch dir? (yes/no)");
    // (d) silent past the window but holds a FUTURE ETA → stays out (timered = accounted for)
    const sTimer = gmk("timered", "Should I keep the eval running? (yes/no)");
    await geng.tick();
    decideAgo(sGhost, 8); hoursAgo(files["ghost"], 9);
    decideAgo(sFresh, 1); hoursAgo(files["fresh"], 2);
    decideAgo(sArch, 8); hoursAgo(files["archived"], 9);
    gdb.prepare("UPDATE sessions SET completed_at=datetime('now','-8 hours') WHERE id=?").run(sArch);
    decideAgo(sTimer, 8); hoursAgo(files["timered"], 9);
    gdb.prepare("UPDATE sessions SET eta_at=? WHERE id=?").run(new Date(Date.now() + 45 * 60000).toISOString(), sTimer);
    await geng.tick();
    check("guarantee: an ANSWERED card whose session then went silent past the window REOPENS", inQ(sGhost));
    check("guarantee: a recently-answered card stays decided (no churn inside the window)", !inQ(sFresh));
    check("guarantee: an operator-COMPLETED session never reopens (archived)", !inQ(sArch));
    check("guarantee: a session with a FUTURE ETA stays out (timered = accounted for)", !inQ(sTimer));

    // (e) DISMISSED babysit (Ctrl+G Enter) that then dies silently → reopens past the window
    const sDis = gmk("dismissed-dead", "Monitoring the long migration in the background.");
    await geng.tick();
    const itD = geng.queue().find((q) => q.session_id === sDis)!;
    gdb.prepare(`UPDATE items SET status='decided', decision='done', dismissed_at=datetime('now','-8 hours') WHERE id=?`).run(itD.id);
    hoursAgo(files["dismissed-dead"], 9); // mtime BEFORE the dismiss → no fresh-activity resurface; only the guarantee can save it
    await geng.tick();
    check("guarantee: a dismissed-then-dead-silent babysit REOPENS past the window", inQ(sDis));

    openDb(process.env.COCKPIT_DB); // restore the shared singleton
  }

  console.log("\n== Live-pane liveness + babysit flag (a streaming/babysitting session NEVER enters Up Next) ==");
  {
    // Discovered EXTERNAL sessions (the operator's real tmux panes) have pid=null and a non-cockpit
    // tmux name, so processAlive() alone is FALSE for them — which used to disable the entire
    // ready-gate (stateDetector recency + tool_use rules AND the reverse guard) for exactly the
    // sessions that matter. is_live_pane=1 must count as proof of life.
    const ldb = openDb(path.join(HOME, "livepane.db"));
    const lsm = new SessionManager(ldb);
    const lcfg = JSON.parse(JSON.stringify(cfg));
    lcfg.eta = { enabled: false };
    const leng = new Engine(ldb, lsm, lcfg, { enrich: false, discover: false, pr: false, kanban: false });
    (lsm as any).processAlive = () => false; // every session here is a pid-less discovered pane
    let flag: string | null = null;
    (lsm as any).paneBabysit = () => flag;

    const backdate = (file: string, minsAgo: number) => { const t = (Date.now() - minsAgo * 60000) / 1000; fs.utimesSync(file, t, t); };
    const mkPane = (name: string, lines: any[], minsAgo: number) => {
      const cwd = path.join(HOME, "livewts", name);
      fs.mkdirSync(cwd, { recursive: true });
      backdate(writeTranscript(cwd, lines), minsAgo);
      const id = lsm.register({ repo: "/r", title: name, worktreePath: cwd, branch: "cockpit/" + name });
      ldb.prepare("UPDATE sessions SET is_live_pane=1, pane_id='%9', pid=NULL WHERE id=?").run(id);
      return id;
    };
    const inQueue = (id: number) => leng.queue().some((q) => q.session_id === id);

    // 1) STREAMING: a live pane that wrote moments ago — last completed message reads like a
    //    question, but more is coming. Must stay hidden (was the "still outputting tokens" bug).
    const sStream = mkPane("pane-streaming", [{ role: "assistant", text: "Should I keep the old index? (yes/no)" }], 0);
    // 2) MID-TOOL: a live pane whose last entry is a tool_use — mid-turn, a tool is running. The
    //    dead-process "stalled" rule must NOT fire for a live pane.
    const sTool = mkPane("pane-midtool", [{ role: "assistant", text: "checking", stop_reason: "tool_use", toolUse: true }], 30);
    // 3) PARKED question, long quiet: genuinely ready → must still surface.
    const sReady = mkPane("pane-ready", [{ role: "assistant", text: "Should I bind to port 8080? (yes/no)" }], 10);
    await leng.tick();
    check("live-pane: a just-written (streaming) pane stays HIDDEN even though its last message is a question", !inQueue(sStream));
    check("live-pane: a mid-tool_use live pane is WORKING (not 'stalled'), stays hidden", !inQueue(sTool));
    eq("live-pane: mid-tool_use session state is WORKING", (ldb.prepare("SELECT state FROM sessions WHERE id=?").get(sTool) as any).state, "WORKING");
    check("live-pane: a long-quiet parked question still SURFACES (gate doesn't over-hide)", inQueue(sReady));

    // 4) BABYSIT FLAG: an idle 👶/🕐 session is by declaration watching its own job → held out.
    flag = "babysit";
    const sSit = mkPane("pane-babysit", [{ role: "assistant", text: "Monitoring the training run; nothing new yet." }], 20);
    await leng.tick();
    check("babysit-flag: an idle flagged session is HELD OUT of the Task Queue", !inQueue(sSit));
    // ...but a flagged session that genuinely needs the operator still surfaces (❓ beats 👶).
    const sSitQ = mkPane("pane-babysit-q", [{ role: "assistant", text: "Run 49006 OOMed — should I requeue with a lower token budget? (yes/no)" }], 20);
    await leng.tick();
    check("babysit-flag: a flagged session asking a QUESTION still surfaces", inQueue(sSitQ));

    // 5) LOCKED PULL: an idle card that surfaced BEFORE the flag went up is pulled once flagged.
    flag = null;
    const sLate = mkPane("pane-late-flag", [{ role: "assistant", text: "Monitoring the sweep." }], 20);
    await leng.tick();
    check("babysit-flag: unflagged idle session surfaces as a low-prio card (control)", inQueue(sLate));
    flag = "babysit";
    await leng.tick(); // now locked + flagged → the babysit pull must supersede the idle card
    check("babysit-flag: flipping the flag PULLS the already-surfaced idle card out of Up Next", !inQueue(sLate));

    openDb(process.env.COCKPIT_DB); // restore the shared singleton
  }

  // Source guards for the new wiring (can't run the real tmux keystroke path offline).
  {
    const ejs = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("eta(src): an EXPIRED ETA bypasses the reprobe throttle (mandatory re-check)",
      /etaExpired \? Math\.min\(reprobeMs, 60000\) : reprobeMs/.test(ejs));
    check("eta(src): idle session with a future ETA is HELD OUT of Up Next (etaHold)",
      /etaHold = state === "UNKNOWN" && etaAtMs > Date\.now\(\) \+ Engine\.ETA_FUTURE_GRACE_MS/.test(ejs));
    const cjs = fs.readFileSync(path.resolve(__dirname, "../../src/core/controller.ts"), "utf8");
    check("eta(src): roster payload carries startedAt (run-for)", /startedAt: this\.startedAtOf\(row\)/.test(cjs));
    const rjs = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
    check("eta(src): renderer shows run-for + a colorblind-safe ETA countdown bar (solid/striped, width from remaining)",
      /runFor\(s\.startedAt/.test(rjs) && /sess-etabar \$\{due \? "due" : "run"\}/.test(rjs) && /etaTotalMin\(r\.eta_text\)/.test(rjs));
  }

  console.log("\n== Nightly reap of orphan tmux — ONLY sessions completed (Ctrl+G e) past the window ==");
  {
    // HERMETIC TMUX: the reaper talks to the REAL default tmux server, and this test db's
    // small row ids collide with the operator's real `claudeos-<id>` terminals — a name-based
    // kill escaping a test must be impossible (2026-06-10 fixture leak, same class of bug).
    // Stub child_process at the module seam (CJS: sessions.ts calls cp.execFileSync at call
    // time) so EVERY tmux call inside this block hits a fake in-memory tmux server.
    const cpMod = require("child_process");
    const realExecFileSync = cpMod.execFileSync;
    const realExecSync = cpMod.execSync;
    const liveTmux = new Set<string>();
    const killedTmux: string[] = [];
    cpMod.execSync = (cmd: any, o: any) =>
      /command -v tmux/.test(String(cmd)) ? Buffer.from("/usr/bin/tmux\n") : realExecSync(cmd, o);
    cpMod.execFileSync = (file: any, args: any, o: any) => {
      if (file === "tmux" && Array.isArray(args) && (args[0] === "has-session" || args[0] === "kill-session")) {
        const raw = String(args[2]);
        // the reaper must ALWAYS use tmux exact-match targets — a bare name prefix-matches
        // (claudeos-1 would kill claudeos-12), which is how a reap could eat a live terminal.
        if (!raw.startsWith("=")) throw new Error(`reap used a non-exact tmux target: ${raw}`);
        const name = raw.slice(1);
        if (!liveTmux.has(name)) throw new Error("can't find session");
        if (args[0] === "kill-session") { liveTmux.delete(name); killedTmux.push(name); }
        return Buffer.from("");
      }
      return realExecFileSync(file, args, o);
    };
    try {
      const hours = 5;
      const sixHAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const oneHAgo = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
      const idOld = mock("reap-old", [{ role: "assistant", text: "done" }]);
      const idRecent = mock("reap-recent", [{ role: "assistant", text: "done" }]);
      const idActive = mock("reap-active", [{ role: "assistant", text: "still going" }]);
      // completed_at is set ONLY by completeTask (Ctrl+G e); simulate two ages, leave one active.
      db.prepare("UPDATE sessions SET completed_at=? WHERE id=?").run(sixHAgo, idOld);
      db.prepare("UPDATE sessions SET completed_at=? WHERE id=?").run(oneHAgo, idRecent);

      const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const matched = (db.prepare("SELECT id FROM sessions WHERE completed_at IS NOT NULL AND completed_at < ?").all(cutoff) as any[]).map((r) => r.id);
      check("reap selects a session completed PAST the window", matched.includes(idOld));
      check("reap NEVER selects a session completed within the window (still want it / undoable)", !matched.includes(idRecent));
      check("reap NEVER selects an active session (no completed_at — not Ctrl+G e'd)", !matched.includes(idActive));

      // Give every mock BOTH kinds of terminal: the cockpit-<slug> launch session AND the durable
      // claudeos-<id> keep-alive view (created on first terminal open; outlives claude by design).
      // Before 2026-06-11 the reaper only knew cockpit-<slug>, so ~150 claudeos-<id> zombies
      // accumulated and flooded the queue as resurfaced idle cards.
      for (const [nm, sid] of [["reap-old", idOld], ["reap-recent", idRecent], ["reap-active", idActive]] as const) {
        liveTmux.add(`cockpit-${nm}`);
        liveTmux.add(`claudeos-${sid}`);
      }
      liveTmux.add(`claudeos-${idOld}0`); // exact-match canary: a prefix-sibling that must survive

      const r = ctrl.reapCompletedTmux(hours);
      check("reapCompletedTmux returns the time-filtered candidate count", r.candidates === matched.length);
      check("reap kills the cockpit-<slug> launch terminal", killedTmux.includes(`cockpit-reap-old`));
      check("reap kills the durable claudeos-<id> keep-alive terminal too (the zombie-terminal bug)", killedTmux.includes(`claudeos-${idOld}`));
      check("reap reports the session as actually reaped", r.reaped >= 1);
      check("EXACT match: reaping claudeos-<id> never prefix-kills claudeos-<id>0", liveTmux.has(`claudeos-${idOld}0`));
      check("reap leaves BOTH terminals of a recently-completed session alive", liveTmux.has(`claudeos-${idRecent}`) && liveTmux.has(`cockpit-reap-recent`));
      check("reap leaves BOTH terminals of an active session alive", liveTmux.has(`claudeos-${idActive}`) && liveTmux.has(`cockpit-reap-active`));
      check("second reap of the same session is a clean no-op (terminals already gone)", ctrl.reapCompletedTmux(hours).reaped === 0);
      check("reap leaves the db row + completed_at intact (only tmux is touched)", (db.prepare("SELECT completed_at FROM sessions WHERE id=?").get(idOld) as any).completed_at === sixHAgo);
      check("reapCompletedTmux(0) is disabled (no candidates considered)", ctrl.reapCompletedTmux(0).candidates === 0);

      const srvSrc = fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8");
      check("nightly dream job wires in reapCompletedTmux", srvSrc.includes("reapCompletedTmux") && srvSrc.includes("reapOrphanTmux()"));
    } finally {
      cpMod.execFileSync = realExecFileSync;
      cpMod.execSync = realExecSync;
    }
  }

  console.log("\n== Nightly auto-complete — archive sessions SILENT >N hours (nobody Ctrl+G e's a teammate) ==");
  {
    // Same hermetic-tmux setup as the reap block above: small test ids collide with the
    // operator's real claudeos-<id> terminals, so every tmux call must hit a fake server.
    const cpMod = require("child_process");
    const realExecFileSync = cpMod.execFileSync;
    const realExecSync = cpMod.execSync;
    const liveTmux = new Set<string>();
    const killedTmux: string[] = [];
    cpMod.execSync = (cmd: any, o: any) =>
      /command -v tmux/.test(String(cmd)) ? Buffer.from("/usr/bin/tmux\n") : realExecSync(cmd, o);
    cpMod.execFileSync = (file: any, args: any, o: any) => {
      if (file === "tmux" && Array.isArray(args) && (args[0] === "has-session" || args[0] === "kill-session")) {
        const raw = String(args[2]);
        if (!raw.startsWith("=")) throw new Error(`non-exact tmux target: ${raw}`);
        const name = raw.slice(1);
        if (!liveTmux.has(name)) throw new Error("can't find session");
        if (args[0] === "kill-session") { liveTmux.delete(name); killedTmux.push(name); }
        return Buffer.from("");
      }
      return realExecFileSync(file, args, o);
    };
    try {
      const HOURS = 20;
      // a session's "last sign of life" is its transcript mtime — age it directly on disk.
      const ageTranscript = (id: number, hoursAgo: number) => {
        const tf = path.join(wtRoot, `idle-transcript-${id}.jsonl`);
        fs.writeFileSync(tf, JSON.stringify({ role: "assistant", text: "..." }) + "\n");
        const old = new Date(Date.now() - hoursAgo * 3600 * 1000);
        fs.utimesSync(tf, old, old);
        db.prepare("UPDATE sessions SET transcript_path=? WHERE id=?").run(tf, id);
      };
      const idSilent = mock("idle-silent", [{ role: "assistant", text: "teammate done" }]);
      const idFresh = mock("idle-fresh", [{ role: "assistant", text: "actively working" }]);
      const idPinned = mock("idle-pinned", [{ role: "assistant", text: "keep me" }]);
      const idEta = mock("idle-eta", [{ role: "assistant", text: "training, back tomorrow" }]);
      const idKanban = mock("idle-kanban", [{ role: "assistant", text: "died mid-task" }]);
      ageTranscript(idSilent, 21);
      ageTranscript(idFresh, 1);
      ageTranscript(idPinned, 30);
      ageTranscript(idEta, 30);
      ageTranscript(idKanban, 21);
      db.prepare("UPDATE sessions SET pinned=1 WHERE id=?").run(idPinned);
      db.prepare("UPDATE sessions SET eta_at=? WHERE id=?").run(new Date(Date.now() + 2 * 3600 * 1000).toISOString(), idEta);
      db.prepare("UPDATE sessions SET kanban_file='/kanban/4_today/01-c2-idle.md', kanban_column='4_today' WHERE id=?").run(idKanban);
      db.prepare("INSERT INTO items (session_id, state, signature, question) VALUES (?, 'WAITING_INPUT', 'sig-idle-silent', 'old question?')").run(idSilent);
      // both terminal kinds alive for the silent one + an exact-match canary.
      liveTmux.add("cockpit-idle-silent");
      liveTmux.add(`claudeos-${idSilent}`);
      liveTmux.add(`claudeos-${idSilent}0`);
      liveTmux.add("cockpit-idle-fresh");

      // Throughput snapshot BEFORE the reaper: auto-completions are excluded from the
      // Overview panel's counters (completed_by='auto'), so they must not move the needle.
      const tBefore = (ctrl as any).metrics([] as any).throughput;

      const r = (ctrl as any).autoCompleteIdleSessions(HOURS);
      const completedAt = (id: number) => (db.prepare("SELECT completed_at FROM sessions WHERE id=?").get(id) as any).completed_at;
      check("a session silent >20h is auto-completed (archived out of the panel)", completedAt(idSilent) !== null && r.completed >= 1);
      check("auto-complete records completed_by='auto' (idle-reap, not an operator completion)",
        (db.prepare("SELECT completed_by FROM sessions WHERE id=?").get(idSilent) as any).completed_by === "auto");
      {
        const { allSessions } = require("../core/db");
        check("auto-completed session disappears from the roster (allSessions — the panel's source)",
          !allSessions(db).some((s: any) => s.id === idSilent));
        const tAfter = (ctrl as any).metrics([] as any).throughput;
        check("auto-completions never bump throughput completedTotal (idle-reap ≠ operator task flow)",
          tAfter.completedTotal === tBefore.completedTotal);
        check("auto-completed sessions never appear in recentCompletions",
          !tAfter.recentCompletions.some((c: any) => c.title === "idle-silent" || c.title === "idle-kanban"));
      }
      check("its pending queue item is superseded (mirrors completeTask)", (db.prepare("SELECT status FROM items WHERE signature='sig-idle-silent'").get() as any).status === "superseded");
      check("BOTH its terminals are reaped immediately", killedTmux.includes("cockpit-idle-silent") && killedTmux.includes(`claudeos-${idSilent}`));
      check("exact-match canary survives the auto-complete reap", liveTmux.has(`claudeos-${idSilent}0`));
      check("a session with RECENT transcript activity is untouched", completedAt(idFresh) === null && liveTmux.has("cockpit-idle-fresh"));
      check("a PINNED session is never auto-completed, however silent", completedAt(idPinned) === null);
      check("a session with a still-FUTURE ETA is never auto-completed (it told us when it'll be back)", completedAt(idEta) === null);
      check("auto-complete archives a kanban-linked session but does NOT move its card (task isn't done)",
        completedAt(idKanban) !== null && (db.prepare("SELECT kanban_column FROM sessions WHERE id=?").get(idKanban) as any).kanban_column === "4_today");
      check("autoCompleteIdleSessions(0) is disabled", (ctrl as any).autoCompleteIdleSessions(0).completed === 0);
      check("a second pass finds nothing new (idempotent)", (ctrl as any).autoCompleteIdleSessions(HOURS).completed === 0);

      // TEAMMATE FAST-REAP (2026-06-17): teammates are machinery — reaped on a much shorter idle
      // window so they don't bloat the tick (slow terminal opens). A 4h-idle teammate is reaped at
      // teammateHours=3; a 4h-idle OPERATOR session is NOT (it needs >20h).
      {
        const fourHAgo = new Date(Date.now() - 4 * 3600_000);
        const mk = (name: string, teammate: boolean) => {
          const cwd = path.join(HOME, "reap-" + name); fs.mkdirSync(cwd, { recursive: true });
          const f = path.join(cwd, "t.jsonl"); fs.writeFileSync(f, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x" }] } }) + "\n");
          fs.utimesSync(f, fourHAgo, fourHAgo);
          const id = upsertDiscoveredSession(db, { claude_session_id: "uuid-reap-" + name, title: name, repo: "demo", worktree_path: cwd, branch: "-", transcript_path: f });
          if (teammate) db.prepare("UPDATE sessions SET is_teammate=1, team_name='t' WHERE id=?").run(id);
          return id;
        };
        const tmId = mk("mate4h", true);
        const opId = mk("op4h", false);
        const r2 = (ctrl as any).autoCompleteIdleSessions(20, 3);
        const done = (id: number) => (db.prepare("SELECT completed_at FROM sessions WHERE id=?").get(id) as any).completed_at !== null;
        check("teammate idle 4h IS reaped at teammateHours=3", done(tmId));
        check("operator session idle 4h is NOT reaped (needs >20h)", !done(opId));
        db.prepare("UPDATE sessions SET completed_at=datetime('now') WHERE id=?").run(opId);
      }
      check("config parses teammate_idle_reap_hours (default 3)", cfg.teammate_idle_reap_hours === 3);

      const srvSrc = fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8");
      check("nightly job wires in autoCompleteIdleSessions before the tmux reap", srvSrc.includes("autoCompleteIdleSessions(cfg.auto_complete_idle_hours, (cfg as any).teammate_idle_reap_hours)"));
      check("idle-reap also runs HOURLY (not just nightly) — keeps the tick fast", /setInterval\(\(\) => \{ try \{ reapOrphanTmux\(\); \} catch \{\} \}, 3_600_000\)/.test(srvSrc));
      const wjson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/weights.json"), "utf8"));
      check("weights.json ships auto_complete_idle_hours = 20", wjson.auto_complete_idle_hours === 20);
      check("config parses auto_complete_idle_hours (default 20)", cfg.auto_complete_idle_hours === 20);
    } finally {
      cpMod.execFileSync = realExecFileSync;
      cpMod.execSync = realExecSync;
    }
  }

  console.log("\n== Re-prioritize ALL (operator ↻ button): re-judge the WHOLE queue, even LOCKED Up-Next items ==");
  {
    check("engine.reprioritizeAll() exists", typeof (engine as any).reprioritizeAll === "function");
    // Two fresh waiting tasks, surfaced (→ now LOCKED in Up Next) with NO focus set.
    ctrl.setFocus("");
    const idR1 = mock("reprio-refactor", [{ role: "assistant", text: "Should I extract the helper now? (yes/no)" }], { title: "reprio refactor cleanup" });
    const idR2 = mock("reprio-other", [{ role: "assistant", text: "Which port — 9001 or 9002?" }], { title: "reprio port choice" });
    await engine.tick();
    const hasFocus = (sid: number) => engine.queue().find((q) => q.session_id === sid)!.score_breakdown.breakdown.some((t: any) => t.signal === "focus_match" && t.contribution > 0);
    check("sanity: freshly-surfaced item has no focus_match (no focus set)", !hasFocus(idR1));

    // THE FREEZE: change focus to match idR1, then a normal TICK must LEAVE the locked item alone
    // (Stage-0 lock) — its score is NOT re-measured against the new focus.
    ctrl.setFocus("refactor"); // matches "reprio refactor cleanup", not "reprio port choice"
    await engine.tick();
    check("a normal TICK leaves a LOCKED Up-Next item's score frozen (no new focus_match)", !hasFocus(idR1));

    // THE BUTTON: reprioritizeAll OVERRIDES the freeze — it re-measures every queued item against
    // the CURRENT focus (here, offline, via the immediate rerank; the model re-judge path is the
    // src-checks below) and re-scores the locked item.
    const qLenBefore = engine.queue().length;
    const r = await (engine as any).reprioritizeAll();
    check("reprioritizeAll returns {ok:true, reprioritized:<number>}", !!r && r.ok === true && typeof r.reprioritized === "number");
    check("reprioritizeAll RE-MEASURES the locked item against the new focus (focus_match now contributes)", hasFocus(idR1));
    check("reprioritizeAll re-judges ONLY by relevance — the non-matching item gets no focus_match", !hasFocus(idR2));
    check("reprioritizeAll DROPS nothing (it re-ranks, never removes — queue size preserved)", engine.queue().length === qLenBefore);

    // Operator overrides still win after a re-prioritize (a manual score REPLACES the model's judgement).
    db.prepare("UPDATE sessions SET manual_importance=88 WHERE id=?").run(idR2);
    await (engine as any).reprioritizeAll();
    const r2 = engine.queue().find((q) => q.session_id === idR2)!;
    check("reprioritizeAll respects a manual-importance override (manual term present, no llm term)",
      r2.score_breakdown.breakdown.some((t: any) => t.signal === "manual_importance") &&
        !r2.score_breakdown.breakdown.some((t: any) => t.signal === "llm_importance"));

    // ---- src-level wiring (offline can't exercise the model re-judge; verify it, eta(src)-style) ----
    const ejs = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    const body = ejs.slice(ejs.indexOf("async reprioritizeAll"), ejs.indexOf("async reprioritizeAll") + 3000);
    check("reprioritize(src): operates DIRECTLY on pending items (not via _tick → bypasses the freeze)", /SELECT \* FROM items WHERE status='pending'/.test(body));
    check("reprioritize(src): re-runs the model enrichment to re-judge importance vs focus (scheduleEnrich)", /this\.scheduleEnrich\(/.test(body));
    check("reprioritize(src): forces a FRESH enrich (clears the per-signature dedupe)", /this\.enriching\.delete\(/.test(body));
    check("reprioritize(src): re-scores immediately too (rerank) so order updates before the model returns", /this\.rerank\(\)/.test(body));
    const srv = fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8");
    check("reprioritize(src): POST /api/reprioritize → engine.reprioritizeAll() + broadcast", /"\/api\/reprioritize"[\s\S]{0,800}engine\.reprioritizeAll\(\)[\s\S]{0,200}broadcast\(\)/.test(srv));
    const rjs = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
    check("reprioritize(src): renderer wires #reprioritize-btn → api.reprioritize()", /reprioritize-btn[\s\S]{0,700}api\.reprioritize\(\)/.test(rjs));
    const html = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/index.html"), "utf8");
    check("reprioritize(src): the ↻ button sits in the Tasks header (index.html)", /id="reprioritize-btn"/.test(html));
    const shim = fs.readFileSync(path.resolve(__dirname, "../../src/server/webapi.js"), "utf8");
    check("reprioritize(src): webapi shim exposes cockpit.reprioritize()", /reprioritize:\s*\(\)\s*=>\s*jpost\("\/api\/reprioritize"/.test(shim));

    // clean up overrides/queue so nothing leaks past this block
    db.prepare("UPDATE sessions SET manual_importance=NULL WHERE id=?").run(idR2);
    const ackOut = (sid: number) => { const q = engine.queue().find((x) => x.session_id === sid); if (q) ctrl.ack(q.id); };
    ackOut(idR1); ackOut(idR2);
  }

  console.log("\n== PR queue: dedup against working sessions + min-priority floor ==");
  {
    const { prBranchOwner } = require("../core/pr");
    const sess = [
      { id: 7, branch: "task/foo", repo: "/home/dev/code/your-repo" },
      { id: 8, branch: "task/bar", repo: "/home/dev/code/your-repo" },
    ];
    // Dedup: a PR whose head branch is owned by a working session must resolve to that session
    // (so we tag + floor it instead of adding a duplicate standalone pr-card).
    eq("dedup: branch + repo match → owning session", prBranchOwner({ repo: "your-org/your-repo", headRef: "task/foo" }, sess), 7);
    eq("dedup: unmatched branch → null (gets its own pr-card)", prBranchOwner({ repo: "your-org/your-repo", headRef: "task/none" }, sess), null);
    eq("dedup: same branch in a DIFFERENT repo → null (repo guard)", prBranchOwner({ repo: "your-org/other", headRef: "task/foo" }, sess), null);
    eq("dedup: empty head branch → null", prBranchOwner({ repo: "your-org/your-repo", headRef: "" }, sess), null);
    eq("dedup: unknown session repo falls back to branch-only match", prBranchOwner({ repo: "your-org/your-repo", headRef: "task/x" }, [{ id: 9, branch: "task/x", repo: null }]), 9);

    // MERGE-DEL: post-merge branch deletion guards (pure helpers).
    const { protectedBranch, branchRefPath } = require("../core/pr");
    for (const b of ["master", "main", "dev", "develop", "", "  "]) {
      eq(`merge-del: "${b}" is protected (never deleted)`, protectedBranch(b), true);
    }
    eq("merge-del: ordinary task branch is deletable", protectedBranch("task/foo"), false);
    eq('merge-del: "fix/master-thing" is NOT protected (full-name match only)', protectedBranch("fix/master-thing"), false);
    // refname encoding: '#'/'%' must not truncate/alias the URL (wrong-branch delete / guard bypass)
    eq("merge-del: ref path keeps slashes, encodes '#'", branchRefPath("o/r", "fix#123"), "repos/o/r/git/refs/heads/fix%23123");
    eq("merge-del: ref path encodes '%' per segment", branchRefPath("o/r", "task/a%2Fb"), "repos/o/r/git/refs/heads/task/a%252Fb");

    // Config + shipped weights.json: PR-scan knobs parse; pr_repos is an array (empty by default —
    // configure your own "owner/repo" entries to surface open PRs).
    const cfg2 = loadConfig();
    check("config: pr_scan_interval_ms parsed", typeof cfg2.pr_scan_interval_ms === "number" && cfg2.pr_scan_interval_ms > 0);
    check("config: pr_min_priority parsed", typeof cfg2.pr_min_priority === "number");
    const prodW = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/weights.json"), "utf8"));
    check("weights.json: pr_repos is an array (configure your own owner/repo)", Array.isArray(prodW.pr_repos));
    eq("weights.json: 5-minute scan cadence", prodW.pr_scan_interval_ms, 300000);
    eq("weights.json: min PR priority floor = 30", prodW.pr_min_priority, 30);

    // Floor + dedup wiring (both scoring paths route PR-backed items through prFloor; scan dedups
    // via prBranchOwner). prFloor floors the ORGANIC score only — operator gestures (snooze, h/l,
    // manual score) apply after it, so they CAN take a PR below the floor (behavioral test below).
    const eng = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("engine: scoreFor routes PR-backed sessions through prFloor", /const floored = this\.prFloor\(s, score\)/.test(eng));
    check("engine: surfacePr routes the standalone PR card through prFloor", /const pri = this\.prFloor\(s, score\)/.test(eng));
    check("engine: prFloor floors the organic score, then re-applies operator gestures", /Math\.max\(organic, this\.cfg\.pr_min_priority/.test(eng) && /t\.signal === "snoozed" \|\| t\.signal === "manual_priority"/.test(eng));
    check("engine: prFloor never floors a manual operator score back up", /if \(s\.manual_importance != null && s\.manual_importance >= 0\) return raw/.test(eng));
    const prsrc = fs.readFileSync(path.resolve(__dirname, "../../src/core/pr.ts"), "utf8");
    check("pr.ts: scanPrs dedups via prBranchOwner + tags the owning session", /prBranchOwner\(pr, claudeSessions\)/.test(prsrc) && /UPDATE sessions SET pr_repo=\?, pr_number=\?/.test(prsrc));
    const srv2 = fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8");
    check("server: engine gets the config-driven PR scan interval", /prScanIntervalMs:\s*cfg\.pr_scan_interval_ms/.test(srv2));
  }

  console.log("\n== PR floor is SOFT: snooze / h-l lower / manual score can take a PR below pr_min_priority ==");
  {
    const fdb = openDb(path.join(HOME, "prfloor.db"));
    const fsm = new SessionManager(fdb);
    const fcfg = JSON.parse(JSON.stringify(cfg));
    fcfg.pr_min_priority = 30;
    fcfg.snooze_penalty = -100;
    fcfg.snooze_recover_hours = 5;
    const feng = new Engine(fdb, fsm, fcfg, { enrich: false, discover: false, pr: false, kanban: false });
    const fctrl = new Controller(fdb, feng, fsm, fcfg);
    const cwd = path.join(HOME, "prfloorwt");
    fs.mkdirSync(cwd, { recursive: true });
    writeTranscript(cwd, [{ role: "assistant", text: "Should I update the docs too? (yes/no)" }]);
    const sid = fsm.register({ repo: "/r", title: "pr-floor-soft", worktreePath: cwd, branch: "task/prfloor" });
    fdb.prepare("UPDATE sessions SET pr_repo='o/r', pr_number=99 WHERE id=?").run(sid);
    await feng.tick();
    const find = () => feng.queue().find((x) => x.session_id === sid);
    const q1 = find();
    check("untouched PR-backed session sits AT/ABOVE the floor", !!q1 && q1.priority >= 30);
    // Snooze: the penalty must take it BELOW the floor (the old clamp capped it back at the floor).
    fctrl.snooze(q1!.id);
    feng.snoozeDecayTick(true);
    const q2 = find();
    check("snoozed PR ranks BELOW the floor (snooze escapes the clamp)", !!q2 && q2.priority < 30);
    // Recovery: stamp the snooze as long past → decays to 0 → back AT/ABOVE the floor.
    fdb.prepare("UPDATE sessions SET snoozed_at=? WHERE id=?").run(new Date(Date.now() - 100 * 3.6e6).toISOString(), sid);
    feng.snoozeDecayTick(true);
    const q3 = find();
    check("fully-recovered snooze returns the PR to the floored score", !!q3 && q3.priority >= 30);
    // h/l lower (manual_priority_delta) applies AFTER the floor too.
    fdb.prepare("UPDATE sessions SET manual_priority_delta=-300 WHERE id=?").run(sid);
    feng.rerank();
    const q4 = find();
    check("h/l-lowered PR ranks BELOW the floor", !!q4 && q4.priority < 30);
    // A typed manual score is ABSOLUTE — never floored back up.
    fdb.prepare("UPDATE sessions SET manual_priority_delta=0, manual_importance=5 WHERE id=?").run(sid);
    feng.rerank();
    const q5 = find();
    check("manual score 5 on a PR stays exactly 5 (not floored to 30)", !!q5 && q5.priority === 5);
    // Clearing the override restores the floor.
    fdb.prepare("UPDATE sessions SET manual_importance=NULL WHERE id=?").run(sid);
    feng.rerank();
    const q6 = find();
    check("clearing the manual score restores the floor", !!q6 && q6.priority >= 30);

    // STANDALONE pr-card (kind='pr', scored by surfacePr): the h/l delta must survive the per-tick
    // re-surface — surfacePr re-scores every PR card each tick, so if it dropped the delta the card
    // would flap back above the floor seconds after the operator lowered it.
    const { upsertPr: upsertPrFloor } = require("../core/db");
    const cardSid = upsertPrFloor(fdb, { repo: "o/r", number: 100, title: "standalone card", url: "https://x.invalid/100", author: "octocat", updatedAt: "2026-06-11T00:00:00Z", reviewDecision: "REVIEW_REQUIRED", isDraft: false, additions: 3, deletions: 1 });
    await feng.tick();
    const card1 = feng.queue().find((x) => x.session_id === cardSid);
    check("standalone pr-card surfaces AT/ABOVE the floor", !!card1 && card1.priority >= 30);
    fdb.prepare("UPDATE sessions SET manual_priority_delta=-300 WHERE id=?").run(cardSid);
    await feng.tick(); // surfacePr re-scores the card — the delta must be applied, not dropped
    const card2 = feng.queue().find((x) => x.session_id === cardSid);
    check("h/l-lowered standalone pr-card stays BELOW the floor across a re-surfacing tick", !!card2 && card2.priority < 30);
    openDb(process.env.COCKPIT_DB);
  }

  console.log("\n== PR terminal: opening a PR card's terminal materializes a PR-aware claude session ==");
  {
    const { localRepoForPr, prSeedPrompt, prBranchOwner } = require("../core/pr");
    const { createPrWorktree } = require("../core/worktree");
    const { upsertPr } = require("../core/db");
    const { execFileSync } = require("child_process");

    // local-clone resolution (pure): GitHub "owner/name" → configured local path by basename
    eq("pr-term: localRepoForPr matches by repo basename", localRepoForPr("your-org/your-repo", ["/x/other", "/home/m/code/your-repo"]), "/home/m/code/your-repo");
    eq("pr-term: no matching clone → null", localRepoForPr("your-org/unknown", ["/home/m/code/your-repo"]), null);
    eq("pr-term: null/undefined candidates skipped", localRepoForPr("o/r", [null, undefined, "/a/r"]), "/a/r");

    // seed prompt (pure): PR-aware, question-ready, no unprompted work
    const seed = prSeedPrompt({
      pr_repo: "your-org/your-repo", pr_number: 534, title: "training dataloader: stream audio from s3",
      pr_head_ref: "task/s3-stream", pr_base_ref: "integration", pr_author: "your-org",
      pr_additions: 120, pr_deletions: 8, pr_review_decision: "REVIEW_REQUIRED", pr_draft: 0,
      pr_url: "https://github.com/your-org/your-repo/pull/534",
    });
    check("pr-term: seed names the PR + repo", seed.includes("PR #534") && seed.includes("your-org/your-repo"));
    check("pr-term: seed carries title + branches", seed.includes("stream audio from s3") && seed.includes("task/s3-stream") && seed.includes("integration"));
    check("pr-term: seed says answer questions, don't start working", /wait for the operator/i.test(seed) && /do not modify/i.test(seed));

    // a throwaway git repo with a PR head branch (helpers.ts sanitized GIT_* already)
    const repo = path.join(HOME, "pr-term-repo");
    fs.mkdirSync(repo, { recursive: true });
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    g(["init", "-q"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n"); g(["add", "-A"]); g(["commit", "-qm", "base"]);
    g(["checkout", "-qb", "task/s3-stream"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "pr change\n"); g(["add", "-A"]); g(["commit", "-qm", "pr change"]);
    g(["checkout", "-q", "-"]); // free the head branch for the worktree checkout

    // createPrWorktree: checked out ON the PR head branch, idempotent, detached fallback when busy
    const wt = createPrWorktree(repo, 534, "task/s3-stream");
    check("pr-term: worktree under .cockpit-worktrees/pr-<n>-<head>", wt.path.includes(`.cockpit-worktrees${path.sep}pr-534-task-s3-stream`));
    eq("pr-term: worktree sees the PR's code", fs.readFileSync(path.join(wt.path, "f.txt"), "utf8").trim(), "pr change");
    eq("pr-term: worktree HEAD is the PR head branch",
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt.path, encoding: "utf8" }).trim(), "task/s3-stream");
    eq("pr-term: idempotent — same worktree on reopen", createPrWorktree(repo, 534, "task/s3-stream").path, wt.path);
    const wt2 = createPrWorktree(repo, 999, "task/s3-stream"); // branch busy in wt → detached checkout
    eq("pr-term: busy head branch → detached checkout of the same code", fs.readFileSync(path.join(wt2.path, "f.txt"), "utf8").trim(), "pr change");

    // FULL materialization: directResumeSpec on a kind='pr' row flips it to a live claude session
    const pdb = openDb(path.join(HOME, "prterm.db"));
    const psm = new SessionManager(pdb);
    const pcfg = { ...cfg, kanban_repo: repo, sessions_repos: [repo] } as any;
    const peng = new Engine(pdb, psm, pcfg, { enrich: false, discover: false, pr: false, kanban: false });
    const pctrl = new Controller(pdb, peng, psm, pcfg);
    const mkPr = (number: number, headRef: string, repoFull = `your-org/${path.basename(repo)}`) =>
      upsertPr(pdb, {
        repo: repoFull, number, title: "training dataloader: stream audio from s3",
        url: `https://example.invalid/pull/${number}`, author: "your-org", updatedAt: new Date().toISOString(),
        reviewDecision: "REVIEW_REQUIRED", isDraft: false, additions: 120, deletions: 8,
        headRef, baseRef: "master",
      });
    const prId = mkPr(534, "task/s3-stream");
    const spec = pctrl.directResumeSpec(prId);
    check("pr-term: directResumeSpec returns a spawn spec for a kind='pr' card", !!spec);
    eq("pr-term: terminal boots in the PR worktree", spec!.cwd, wt.path);
    const argStr = (spec!.args || []).join(" ");
    if (spec!.cmd === "tmux") {
      check("pr-term: durable per-task tmux claudeos-<id> (same name the resume path uses)", argStr.includes(`claudeos-${prId}`));
    }
    check("pr-term: boots a seeded claude, skip-permissions", argStr.includes("--dangerously-skip-permissions") && argStr.includes("PR #534"));
    const row = pdb.prepare("SELECT * FROM sessions WHERE id=?").get(prId) as any;
    eq("pr-term: row materialized in place — kind flips to claude", row.kind, "claude");
    eq("pr-term: row branch = PR head branch", row.branch, "task/s3-stream");
    eq("pr-term: row worktree_path = the PR worktree", row.worktree_path, wt.path);
    eq("pr-term: PR tags kept (diff + merge button still render)", row.pr_number, 534);
    // the NEXT scanPrs dedups this PR onto the materialized row (no duplicate standalone card)
    eq("pr-term: prBranchOwner dedups the open PR onto the materialized row",
      prBranchOwner({ repo: row.pr_repo, headRef: "task/s3-stream" }, [{ id: prId, branch: row.branch, repo: row.repo }]), prId);
    // REGRESSION (live 2026-06-11): a busy head branch → DETACHED worktree → discovery adoption
    // rewrites branch to the literal "HEAD" → the branch-based dedup misses → duplicate card.
    // The tag-based owner (pr_repo + pr_number) must dedup regardless of branch.
    const { prTaggedOwner } = require("../core/pr");
    pdb.prepare("UPDATE sessions SET branch='HEAD' WHERE id=?").run(prId); // simulate adoption of a detached worktree
    eq("pr-term: detached branch ('HEAD') breaks the branch-based match",
      prBranchOwner({ repo: row.pr_repo, headRef: "task/s3-stream" }, [{ id: prId, branch: "HEAD", repo: row.repo }]), null);
    eq("pr-term: …but prTaggedOwner still dedups by pr_repo + pr_number", prTaggedOwner(pdb, { repo: row.pr_repo, number: 534 }), prId);
    eq("pr-term: prTaggedOwner ignores other PRs", prTaggedOwner(pdb, { repo: row.pr_repo, number: 9999 }), null);
    const prSrc = fs.readFileSync(path.resolve(__dirname, "../../src/core/pr.ts"), "utf8");
    check("pr(src): scanPrs falls back to the tag-based owner after the branch match", /prBranchOwner\(pr, claudeSessions\) \?\? prTaggedOwner\(db, pr\)/.test(prSrc));
    pdb.prepare("UPDATE sessions SET branch='task/s3-stream' WHERE id=?").run(prId); // restore for the asserts below
    // a materialized row has no claude_session_id until discovery → direct resume can't route it yet;
    // the attach falls through to ensureAttachSpec, whose durable claudeos-<id> fallback covers the gap.
    eq("pr-term: second open before discovery → no direct-resume spec (durable-tmux fallback handles it)", pctrl.directResumeSpec(prId), null);
    const sessSrc = fs.readFileSync(path.resolve(__dirname, "../../src/core/sessions.ts"), "utf8");
    check("sessions(src): ensureAttachSpec attaches the durable claudeos-<id> tmux as a fallback", /claudeos-\$\{session\.id\}/.test(sessSrc));

    // failure paths surface a reason (never a silent read-only dead end)
    const prNoHead = mkPr(7, "");
    eq("pr-term: PR with no head branch → no spec", pctrl.directResumeSpec(prNoHead), null);
    check("pr-term: …and the reason is recorded", /head branch/.test(pctrl.prTerminalError(prNoHead) || ""));
    const prNoClone = mkPr(8, "task/elsewhere", "your-org/some-unknown-repo");
    eq("pr-term: PR with no local clone → no spec", pctrl.directResumeSpec(prNoClone), null);
    check("pr-term: …names the missing clone + the config fix", /some-unknown-repo/.test(pctrl.prTerminalError(prNoClone) || "") && /sessions_repos/.test(pctrl.prTerminalError(prNoClone) || ""));
    const srvSrc = fs.readFileSync(path.resolve(__dirname, "../../src/server/server.ts"), "utf8");
    check("server(src): attach fallback shows the PR-terminal failure reason", /prTerminalError\(sessionId\)/.test(srvSrc));

    // shell rows still never get a direct spec
    pdb.prepare("UPDATE sessions SET kind='shell' WHERE id=?").run(prNoHead);
    eq("pr-term: shell rows still never direct-resume", pctrl.directResumeSpec(prNoHead), null);

    // KANBAN-TERMINAL: opening a kanban card's terminal MATERIALIZES it in place (mirror of the
    // PR materialization above) — a surfaced card never dead-ends on "background agent — read-only".
    const { upsertKanban } = require("../core/db");
    const kcardDir = path.join(HOME, "kmat-board", "4_today");
    fs.mkdirSync(kcardDir, { recursive: true });
    const kcardFile = path.join(kcardDir, "50-c2-write-to-data-team-about-label-prio.md");
    fs.writeFileSync(kcardFile, "# Write to the data team about label-prio\n\n---\n\nPropose the 1-10 label-prio flow to the data team.");
    const kId = upsertKanban(pdb, { key: "kanban:4_today/50-c2-write-to-data-team-about-label-prio.md", title: "write to data team about label prio", file: kcardFile, column: "4_today" });
    // saved-but-unappended operator answers must reach the card file at launch (the /work
    // session reads the card, not the cockpit db)
    pdb.prepare("UPDATE sessions SET kanban_startable=0, kanban_questions=?, kanban_answers=? WHERE id=?")
      .run(JSON.stringify(["Where are the drafts?"]), JSON.stringify([{ q: "Where are the drafts?", a: "in the 2026-06-10 session notes" }]), kId);
    pdb.prepare(
      `INSERT INTO items (session_id,state,category,category_source,question,one_liner,suggested_answer,diff_summary,changed_lines,importance,importance_reason,answer_options,priority,priority_explain,status,signature)
       VALUES (?,?,?,?,?,?,NULL,NULL,0,-1,NULL,NULL,30,'{}','pending',?)`
    ).run(kId, "WAITING_INPUT", "KANBAN", "kanban", "q", "one", "kanban:4_today/50-c2-write-to-data-team-about-label-prio.md");
    const kspec = pctrl.directResumeSpec(kId);
    check("kanban-term: directResumeSpec returns a spawn spec for a kind='kanban' card", !!kspec);
    const kargs = (kspec!.args || []).join(" ");
    if (kspec!.cmd === "tmux") check("kanban-term: durable per-task tmux claudeos-<id>", kargs.includes(`claudeos-${kId}`));
    check("kanban-term: boots a seeded claude with the one-line /work invocation",
      kargs.includes("/work 50 write to data team about label prio (in 4_today)"));
    check("kanban-term: operator answers flushed to the card file at launch",
      fs.readFileSync(kcardFile, "utf8").includes("in the 2026-06-10 session notes"));
    const krow = pdb.prepare("SELECT * FROM sessions WHERE id=?").get(kId) as any;
    eq("kanban-term: row materialized in place — kind flips to claude", krow.kind, "claude");
    check("kanban-term: row gets a real worktree in kanban_repo", String(krow.worktree_path || "").includes(".cockpit-worktrees"));
    eq("kanban-term: card title pinned as clean_title (preamble never becomes the name)", krow.clean_title, "write to data team about label prio");
    check("kanban-term: title pinned with the TASK_TAG_TITLED sentinel", krow.meta_gen_prompts >= 4);
    const kitem = pdb.prepare("SELECT status,decision FROM items WHERE session_id=?").get(kId) as any;
    eq("kanban-term: card item consumed (status decided)", kitem.status, "decided");
    eq("kanban-term: …decision recorded as started", kitem.decision, "started");
  }

  console.log("\n== PR resurrection: a completed card/owner never hides a still-open PR ==");
  {
    // REGRESSION (live 2026-06-11): the morning completion sweep archived the pr-cards for three
    // OPEN PRs; upsertPr kept updating the rows without clearing completed_at and prTaggedOwner
    // kept matching the completed terminal session, so the open PRs were invisible for hours.
    const { upsertPr, setCompleted, nextSlot } = require("../core/db");
    const { prTaggedOwner } = require("../core/pr");
    const rdb = openDb(path.join(HOME, "prres.db"));
    const mk = (number: number) =>
      upsertPr(rdb, {
        repo: "your-org/your-repo", number, title: `pr ${number}`, url: `https://example.invalid/pull/${number}`,
        author: "your-org", updatedAt: new Date().toISOString(), reviewDecision: "", isDraft: false,
        additions: 1, deletions: 1, headRef: `task/x-${number}`, baseRef: "integration",
      });
    const cardId = mk(755);
    setCompleted(rdb, cardId, new Date().toISOString());
    eq("pr-res: re-upserting the same open PR returns the same row", mk(755), cardId);
    const card = rdb.prepare("SELECT completed_at, state FROM sessions WHERE id=?").get(cardId) as any;
    eq("pr-res: upsertPr resurrects a completed card while the PR is open", card.completed_at, null);
    eq("pr-res: …back to WAITING_INPUT", card.state, "WAITING_INPUT");

    // a COMPLETED claude session tagged with the PR must not claim ownership (it is hidden from
    // the queue, so its claim would leave the open PR with no visible card at all).
    rdb.prepare(
      "INSERT INTO sessions (slot,title,repo,worktree_path,branch,state,kind,pr_repo,pr_number) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(nextSlot(rdb), "terminal for PR 753", "/x/your-repo", "/x/wt-753", "HEAD", "WAITING_INPUT", "claude", "your-org/your-repo", 753);
    const termId = (rdb.prepare("SELECT id FROM sessions WHERE pr_number=753").get() as any).id;
    eq("pr-res: live tagged session owns its PR", prTaggedOwner(rdb, { repo: "your-org/your-repo", number: 753 }), termId);
    setCompleted(rdb, termId, new Date().toISOString());
    eq("pr-res: completed tagged session no longer owns it (a fresh pr-card gets created)",
      prTaggedOwner(rdb, { repo: "your-org/your-repo", number: 753 }), null);

    const prResSrc = fs.readFileSync(path.resolve(__dirname, "../../src/core/pr.ts"), "utf8");
    check("pr-res(src): scanPrs branch-owner candidates exclude completed sessions",
      /kind='claude' AND branch IS NOT NULL AND branch != '' AND completed_at IS NULL/.test(prResSrc));
    const engResSrc = fs.readFileSync(path.resolve(__dirname, "../../src/core/engine.ts"), "utf8");
    check("pr-res(src): surfacePr re-pends a superseded item for a still-open PR",
      /existing\.status === "superseded"/.test(engResSrc) && /SET status='pending'/.test(engResSrc));
  }

  console.log("\n== PR badge: every card with an open PR shows the PR tag; tags track open PRs only ==");
  {
    const { upsertPr, pruneClosedPrs } = require("../core/db");
    const bdb = openDb(path.join(HOME, "prbadge.db"));
    const rend = fs.readFileSync(path.resolve(__dirname, "../../src/renderer/renderer.ts"), "utf8");
    // the badge keys on "has an open PR" (same condition as the merge button), NOT kind==='pr',
    // so working sessions / materialized terminals that own a PR are visibly tagged too.
    check("pr-badge(src): queue badge renders for ANY card with pr_repo+pr_number",
      /s\.pr_repo && s\.pr_number \? `<span class="badge pr"/.test(rend));
    check("pr-badge(src): detail header carries the badge", /it\.session\.pr_repo && it\.session\.pr_number/.test(rend));
    check("pr-badge(src): roster rows carry the badge", /r\.pr_repo && r\.pr_number \? `<span class="badge pr"/.test(rend));
    check("pr-badge(src): queue badge no longer keyed on kind==='pr'", !/s\.kind === "pr" \? '<span class="badge pr"/.test(rend));

    const prSrc2 = fs.readFileSync(path.resolve(__dirname, "../../src/core/pr.ts"), "utf8");
    check("pr-badge(src): scanPrs untags sessions whose PR is no longer open",
      /SET pr_repo=NULL, pr_number=NULL, pr_head_ref=NULL/.test(prSrc2));
    check("pr-badge(src): a failed gh listing skips the repo (no prune/untag flap)",
      /if \(prs == null\) continue/.test(prSrc2) && /listOpenPrs\(repo: string\): PrInfo\[\] \| null/.test(prSrc2));

    // pruneClosedPrs scoping: a repo whose listing failed keeps its cards; a scanned repo prunes.
    const mkCard = (repo: string, number: number) =>
      upsertPr(bdb, {
        repo, number, title: `pr ${number}`, url: `https://example.invalid/pull/${number}`,
        author: "your-org", updatedAt: new Date().toISOString(), reviewDecision: "", isDraft: false,
        additions: 1, deletions: 1, headRef: `task/y-${number}`, baseRef: "master",
      });
    const keepId = mkCard("your-org/failed-repo", 1);
    const dropId = mkCard("your-org/scanned-repo", 2);
    pruneClosedPrs(bdb, new Set<string>(), ["your-org/scanned-repo"]);
    check("pr-badge: scanned repo with no open PRs → card pruned",
      !bdb.prepare("SELECT id FROM sessions WHERE id=?").get(dropId));
    check("pr-badge: repo whose listing failed → card kept",
      !!bdb.prepare("SELECT id FROM sessions WHERE id=?").get(keepId));
  }

  console.log("\n== Merge reconcile: a JUST-MERGED PR leaves the queue NOW, not after the throttled scanPrs ==");
  {
    const { upsertPr, reconcileMergedPr, nextSlot } = require("../core/db");
    const mdb = openDb(path.join(HOME, "mergereconcile.db"));

    // kind='pr' card → DELETED on merge (the card IS the PR), with its item gone too.
    const prCardId = upsertPr(mdb, {
      repo: "your-org/your-repo", number: 901, title: "pr 901", url: "https://example.invalid/pull/901",
      author: "your-org", updatedAt: new Date().toISOString(), reviewDecision: "", isDraft: false,
      additions: 3, deletions: 1, headRef: "task/z-901", baseRef: "master",
    });
    mdb.prepare("INSERT INTO items (session_id,state,signature,category,status,priority) VALUES (?,?,?,?,?,?)")
      .run(prCardId, "WAITING_INPUT", "pr:your-org/your-repo#901", "REVIEW_DIFF", "pending", 100);
    const prRes = reconcileMergedPr(mdb, prCardId);
    eq("merge-reconcile: kind='pr' card is deleted on merge", prRes.action, "deleted");
    check("merge-reconcile: the pr-card session row is gone", !mdb.prepare("SELECT id FROM sessions WHERE id=?").get(prCardId));
    check("merge-reconcile: the pr-card's item is gone", !mdb.prepare("SELECT id FROM items WHERE session_id=?").get(prCardId));

    // PR-tagged claude session → UNTAGGED on merge (session survives; badge/merge-button gone), and
    // the previous tag is returned so the caller can offer undo.
    mdb.prepare(
      "INSERT INTO sessions (slot,title,repo,worktree_path,branch,state,kind,pr_repo,pr_number,pr_head_ref,pr_base_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(nextSlot(mdb), "terminal for PR 902", "/x/your-repo", "/x/wt-902", "HEAD", "WAITING_INPUT", "claude", "your-org/your-repo", 902, "task/z-902", "master");
    const claudeId = (mdb.prepare("SELECT id FROM sessions WHERE pr_number=902").get() as any).id;
    const cRes = reconcileMergedPr(mdb, claudeId);
    eq("merge-reconcile: PR-tagged claude session is untagged on merge", cRes.action, "untagged");
    eq("merge-reconcile: untag returns the previous pr_number for undo", cRes.prev.pr_number, 902);
    const after = mdb.prepare("SELECT id, pr_repo, pr_number, pr_head_ref, pr_base_ref FROM sessions WHERE id=?").get(claudeId) as any;
    check("merge-reconcile: claude session still exists after untag", !!after);
    check("merge-reconcile: pr tag columns are cleared", after.pr_repo == null && after.pr_number == null && after.pr_head_ref == null && after.pr_base_ref == null);

    // a session with no PR (and no kind='pr') is a no-op.
    mdb.prepare("INSERT INTO sessions (slot,title,repo,worktree_path,branch,state,kind) VALUES (?,?,?,?,?,?,?)")
      .run(nextSlot(mdb), "plain session", "/x/your-repo", "/x/wt-plain", "HEAD", "WORKING", "claude");
    const plainId = (mdb.prepare("SELECT id FROM sessions WHERE title='plain session'").get() as any).id;
    eq("merge-reconcile: a session with no PR is a no-op", reconcileMergedPr(mdb, plainId).action, "none");

    // the controller calls it on a SUCCESSFUL merge from both real paths.
    const ctrlSrc = fs.readFileSync(path.resolve(__dirname, "../../src/core/controller.ts"), "utf8");
    check("merge-reconcile(src): controller reconciles after a successful merge",
      /if \(r\.ok\) this\.reconcileMergedLocally\(sessionId\);/.test(ctrlSrc));
    check("merge-reconcile(src): reconcileMergedLocally pushes undo for the untag case",
      /res\.action === "untagged"/.test(ctrlSrc) && /pushUndo\(this\.db, "mergePr"/.test(ctrlSrc));
  }

  console.log("\n== MANUAL STATE OVERRIDE: right-click a card to correct/silence its status ==");
  {
    const odb = openDb(path.join(HOME, "override.db"));
    const osm = new SessionManager(odb);
    const oeng = new Engine(odb, osm, cfg, { enrich: false, discover: false, pr: false, kanban: false }); // offline → deterministic
    const octrl = new Controller(odb, oeng, osm, cfg);
    const omk = (name: string, text: string) => {
      const cwd = path.join(HOME, "owts", name);
      fs.mkdirSync(cwd, { recursive: true });
      const tfile = writeTranscript(cwd, [{ role: "assistant", text }]);
      return { id: osm.register({ repo: "/r", title: name, worktreePath: cwd, branch: "cockpit/" + name }), cwd, tfile };
    };
    const inQueue = (id: number) => oeng.queue().some((x) => x.session_id === id);

    // A genuine question surfaces on its own — nothing overridden yet.
    const a = omk("waiting-card", "Should I deploy to prod? (yes/no)");
    await oeng.tick();
    check("override: a genuine question surfaces before any override", inQueue(a.id));

    // Operator right-clicks the card → "working" (the detector was wrong; it's still running).
    octrl.overrideState(a.id, "WORKING");
    const arow = getSession(odb, a.id)!;
    eq("override: manual_state persisted", arow.manual_state, "WORKING");
    eq("override: base = the detector's state at correction time", arow.manual_state_base, "WAITING_INPUT");
    const dl = odb.prepare("SELECT * FROM decision_log WHERE session_id=? AND feedback='manual_state'").get(a.id) as any;
    check("override: the correction is logged for the learning loop (from→to)", !!dl && dl.decision === "WORKING" && dl.state === "WAITING_INPUT");

    // Next tick: forcing WORKING pulls the already-surfaced card OUT of Up Next and shows on the row.
    await oeng.tick();
    check("override: forcing WORKING removes the card from Up Next", !inQueue(a.id));
    eq("override: the roster status reflects the override", getSession(odb, a.id)!.state, "WORKING");

    // While the detector still reads the same underlying state, the override holds (stays silenced).
    await oeng.tick();
    check("override: the override holds while reality is unchanged", !inQueue(a.id));

    // Reality moves (the session actually finishes) → the override auto-expires so it can't strand a
    // real result forever; the card resurfaces on the detector's fresh DONE reading.
    writeTranscript(a.cwd, [{ role: "assistant", text: "Deployed — all checks are green and the task is complete." }]);
    const fut = new Date(Date.now() + 5000); fs.utimesSync(a.tfile, fut, fut); // bust the mtime-cached tail
    await oeng.tick();
    check("override: auto-expires once the detector's state moves off the base → resurfaces", inQueue(a.id));
    check("override: the expired override is cleared from the row", getSession(odb, a.id)!.manual_state == null);

    // Undo reverts a correction cleanly (status + logged decision).
    const b = omk("undo-card", "Should I merge the branch now? (yes/no)");
    await oeng.tick();
    octrl.overrideState(b.id, "DONE");
    eq("override: set before undo", getSession(odb, b.id)!.manual_state, "DONE");
    octrl.undo();
    check("override: undo reverts the manual status", getSession(odb, b.id)!.manual_state == null);
    eq("override: undo removes the logged decision", (odb.prepare("SELECT COUNT(*) c FROM decision_log WHERE session_id=? AND feedback='manual_state'").get(b.id) as any).c, 0);

    // Clearing an override (right-click → "let Claude decide") does NOT log a decision.
    octrl.overrideState(b.id, "WORKING");
    octrl.overrideState(b.id, null);
    check("override: clearing removes the override", getSession(odb, b.id)!.manual_state == null);

    openDb(process.env.COCKPIT_DB); // restore the shared singleton
  }

  process.exit(summary());
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
