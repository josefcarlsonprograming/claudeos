/**
 * SERVER E2E — boots the REAL web server (isolated demo sandbox) and drives it over the wire:
 * every HTTP endpoint, the terminal WebSocket, the SSE stream, the real (throwaway) git merge,
 * and the request→controller→db wiring that the headless harness bypasses by calling methods
 * directly. If this is green, the HTTP/WS layer the browser talks to actually works.
 *
 *   node dist/test/e2e_server.js
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import { execFileSync } from "child_process";
import WebSocket from "ws";
import { check, eq, summary } from "./helpers";
import { startDemoServer, DemoServer, sleep, waitFor } from "./e2e_boot";

async function run(srv: DemoServer) {
  const get = async (p: string) => fetch(srv.base + p);
  const getJson = async (p: string) => (await get(p)).json() as any;
  const post = async (p: string, body: any = {}) =>
    fetch(srv.base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const postJson = async (p: string, body: any = {}) => (await post(p, body)).json() as any;
  const state = () => getJson("/api/state");
  const sessionsOf = (st: any) => [...(st.sessions || []), ...((st.queue || []).map((q: any) => q.session))];

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== Static assets serve (the browser bundle) ==");
  {
    const idx = await get("/");
    const html = await idx.text();
    check("GET / → 200 html", idx.status === 200 && /text\/html/.test(idx.headers.get("content-type") || ""));
    check("index.html injects webapi.js shim before renderer.js", html.includes("webapi.js") && html.includes("renderer.js"));
    for (const [p, type] of [
      ["/renderer.js", "javascript"],
      ["/styles.css", "css"],
      ["/webapi.js", "javascript"],
      ["/vendor/xterm.js", "javascript"],
      ["/logo.png", "image/png"],
    ] as const) {
      const r = await get(p);
      check(`GET ${p} → 200 (${type})`, r.status === 200 && (r.headers.get("content-type") || "").includes(type.split("/").pop()!));
    }
    check("GET /favicon.ico → 204 (silenced)", (await get("/favicon.ico")).status === 204);
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== Read endpoints (shape) ==");
  let st = await state();
  check("/api/state has a seeded queue (>0) + a 'next'", st.queue.length > 0 && !!st.next);
  check("/api/state exposes demo=true (sandbox)", st.demo === true);
  check("/api/keymap returns an action→key map", typeof (await getJson("/api/keymap")) === "object");
  check("/api/diag (GET) returns recent[]", Array.isArray((await getJson("/api/diag")).recent));
  check("/api/takeoverable returns agents[]", Array.isArray((await getJson("/api/takeoverable")).agents));
  const firstItem = st.queue[0];
  const firstSid = firstItem.session_id;
  check("/api/pane?sessionId returns a pane", typeof (await getJson(`/api/pane?sessionId=${firstSid}`)) === "object");
  check("/api/raw?itemId returns transcript text", typeof (await getJson(`/api/raw?itemId=${firstItem.id}`)).raw === "string");
  check("/api/pretty?itemId returns text", typeof (await getJson(`/api/pretty?itemId=${firstItem.id}`)).text === "string");
  check("/api/attach?sessionId returns a command field", "command" in (await getJson(`/api/attach?sessionId=${firstSid}`)));
  check("/api/sessionPr/<id> returns {pr}", "pr" in (await getJson(`/api/sessionPr/${firstSid}`)));
  const gistResp = await getJson(`/api/gist/${firstSid}`);
  check("/api/gist/<id> returns a {summary,suggestions}", typeof gistResp.summary === "string" && Array.isArray(gistResp.suggestions));
  check("/api/gist/<id> summary is non-empty + suggestions are strings", gistResp.summary.length > 0 && gistResp.suggestions.every((s: any) => typeof s === "string"));
  check("GET /api/gist/abc → 400 (bad sessionId)", (await get("/api/gist/abc")).status === 400);
  check("GET /api/chat-log returns rows[]", Array.isArray((await getJson("/api/chat-log?limit=5")).rows));
  const cc = await post("/api/cockpit-chat", { message: "what needs me?" });
  const ccBody = await cc.json();
  check("POST /api/cockpit-chat returns a spoken reply + action", cc.status === 200 && typeof ccBody.say === "string" && ccBody.say.length > 0 && !!ccBody.action);
  check("POST /api/cockpit-chat missing message → 400", (await post("/api/cockpit-chat", {})).status === 400);
  check("cockpit-chat logged a global thread turn", (await getJson("/api/chat-log?scope=global&limit=5")).rows.length > 0);

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== Bad input is rejected (no 500s, no crashes) ==");
  check("GET /api/raw?itemId=abc → 400", (await get("/api/raw?itemId=abc")).status === 400);
  check("POST /api/key bad sessionId → 400", (await post("/api/key", { sessionId: "nope", key: "x" })).status === 400);
  check("POST /api/sendAnswer missing itemId → 400", (await post("/api/sendAnswer", { answer: "hi" })).status === 400);
  check("POST /api/pin bad sessionId → 400", (await post("/api/pin", { pinned: true })).status === 400);
  check("POST /api/overrideState bad state → 400", (await post("/api/overrideState", { sessionId: firstSid, state: "BOGUS" })).status === 400);
  check("POST /api/overrideState missing sessionId → 400", (await post("/api/overrideState", { state: "WORKING" })).status === 400);
  check("unknown route → 404", (await get("/api/does-not-exist")).status === 404);

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== Mutations are WIRED: request → controller → db → state ==");
  // pin
  await postJson("/api/pin", { sessionId: firstSid, pinned: true });
  st = await state();
  check("POST /api/pin sets session.pinned=1", sessionsOf(st).find((s) => s.id === firstSid)?.pinned === 1);
  await postJson("/api/pin", { sessionId: firstSid, pinned: false });
  check("POST /api/pin unpin clears it", sessionsOf(await state()).find((s) => s.id === firstSid)?.pinned === 0);

  // manual importance — pick a session that has NO override yet
  const miSid = (st.queue.find((q: any) => q.session.manual_importance == null) || st.queue[0]).session_id;
  await postJson("/api/manualImportance", { sessionId: miSid, value: 55 });
  check("POST /api/manualImportance sets the value", sessionsOf(await state()).find((s) => s.id === miSid)?.manual_importance === 55);
  await postJson("/api/manualImportance", { sessionId: miSid, value: null });
  check("POST /api/manualImportance null clears it", sessionsOf(await state()).find((s) => s.id === miSid)?.manual_importance == null);

  // manual STATE override (right-click a card → correct/silence its status)
  const msOf = (st: any, id: number): any => {
    const q = (st.queue || []).find((x: any) => x.session_id === id);
    if (q) return q.session?.manual_state ?? null;
    const r = (st.sessions || []).find((x: any) => (x.row?.id ?? x.id) === id);
    return (r?.row ?? r)?.manual_state ?? null;
  };
  const osItem = st.queue.find((q: any) => q.session.manual_state == null) || st.queue[0];
  const osSid = osItem.session_id;
  await postJson("/api/overrideState", { sessionId: osSid, state: "WORKING" });
  const osSt = await state();
  check("POST /api/overrideState sets session.manual_state", msOf(osSt, osSid) === "WORKING");
  check("POST /api/overrideState (WORKING) drops the card from Up Next", !osSt.queue.some((q: any) => q.session_id === osSid));
  await postJson("/api/overrideState", { sessionId: osSid, state: "" });
  check("POST /api/overrideState clear removes the override", msOf(await state(), osSid) == null);

  // quick-prompt PRIORITY: /api/newSession accepts a launch-time importance (Ctrl+Enter in the
  // overlay) and returns ok+id. (The importance→db-row write + clamping is asserted deterministically
  // in the core harness — here we just guard that the endpoint accepts the field without 500ing.)
  {
    const r = await postJson("/api/newSession", { kind: "claude", prompt: "fix the priority test", importance: 73 });
    check("POST /api/newSession (with importance) returns {ok, sessionId}", r.ok === true && typeof r.sessionId === "number");
    const r2 = await postJson("/api/newSession", { kind: "claude", prompt: "no priority here" });
    check("POST /api/newSession (no importance) still returns {ok, sessionId}", r2.ok === true && typeof r2.sessionId === "number");
    // The ＋ new-terminal picker passes a `repo` (one of config.sessions_repos). The endpoint must
    // accept it (server validates it against the allow-list) and still return ok+id.
    const st0 = await state();
    const repo = (st0 as any).config?.sessions_repos?.[0];
    const r3 = await postJson("/api/newSession", { kind: "claude", prompt: "in a chosen repo", repo });
    check("POST /api/newSession (with a repo) returns {ok, sessionId}", r3.ok === true && typeof r3.sessionId === "number");
  }

  // snooze applies a visible penalty
  const snItem = (await state()).queue.find((q: any) => q.session.snooze_penalty === 0) || (await state()).queue[0];
  await postJson("/api/snooze", { itemId: snItem.id, minutes: 60 });
  check("POST /api/snooze applies a score penalty (item stays visible)", sessionsOf(await state()).find((s) => s.id === snItem.session_id)?.snooze_penalty < 0);

  // focus biases ranking
  await postJson("/api/focus", { focus: "inference latency" });
  check("POST /api/focus updates state.focus", (await state()).focus === "inference latency");

  // /api/key dispatch (demo: no-op into fake buffer, must not error)
  check("POST /api/key (valid) → 200", (await post("/api/key", { sessionId: firstSid, key: "x", named: false })).status === 200);

  // reasonFeedback persists a strong training example
  const rf = await postJson("/api/reasonFeedback", { itemId: firstItem.id, direction: "down", reason: "e2e: not urgent right now" });
  check("POST /api/reasonFeedback persists an example (exampleId returned)", !!rf.exampleId || rf.ok === true);

  // re-prioritize ALL: the operator ↻ button re-judges the whole queue vs the current focus and
  // re-ranks (overriding the Up-Next freeze). Over the wire it must answer {ok,reprioritized:N},
  // never drop a queued task, and never 404/500.
  {
    const qBefore = (await state()).queue.length;
    const rp = await post("/api/reprioritize", {});
    check("POST /api/reprioritize → 200 (route exists)", rp.status === 200);
    const rpj = await rp.json();
    check("POST /api/reprioritize returns {ok:true, reprioritized:<number>}", rpj.ok === true && typeof rpj.reprioritized === "number");
    check("re-prioritize drops nothing (queue size preserved)", (await state()).queue.length === qBefore);
  }

  // diff viewed round-trips
  const dvSid = (await state()).queue.find((q: any) => q.category === "REVIEW_DIFF")?.session_id || firstSid;
  await postJson("/api/setDiffViewed", { sessionId: dvSid, filePath: "src/server/analytics.ts", viewed: true });
  const viewed = (await postJson("/api/diffViewed", { sessionId: dvSid })).viewed || {};
  check("POST /api/setDiffViewed → /api/diffViewed reflects it", viewed["src/server/analytics.ts"] === true);

  // worktree + PR diffs return real content
  const wd = await postJson("/api/worktreeDiff", { sessionId: dvSid });
  check("POST /api/worktreeDiff returns a unified diff", typeof wd.diff === "string" && wd.diff.length > 0);

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== sendAnswer consumes an item; undo restores it ==");
  {
    const ans = (await state()).queue.find((q: any) => q.answer_options); // an answerable one
    if (ans) {
      await postJson("/api/sendAnswer", { itemId: ans.id, answer: "Yes, do it" });
      check("sent item leaves the pending queue", !(await state()).queue.some((q: any) => q.id === ans.id));
      const u = await postJson("/api/undo", {});
      check("POST /api/undo reports a label", u.ok && typeof u.label === "string");
      check("undo restores the item to the queue", (await state()).queue.some((q: any) => q.id === ans.id));
    } else check("answerable item present to send/undo", false, "none found");
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== complete & archive is DEMO-SAFE (never moves a real kanban card) ==");
  {
    // Pick an operator claude task (not a pr card / teammate) so the throughput counters below
    // are guaranteed to see the completion — same filter as controller.throughput()'s DONE.
    const untaggedN = (st: any) =>
      ((st?.metrics?.throughput?.doneByTag || []).find((g: any) => g.tag === "untagged")?.n as number) || 0;
    const before = await state();
    const target = before.queue.find(
      (q: any) => q.category !== "FYI_DONE" && q.session?.kind === "claude" && !q.session?.is_teammate
    );
    if (target) {
      const r = await postJson("/api/complete", { sessionId: target.session_id });
      check("POST /api/complete → ok", r.ok === true);
      check("complete in demo does NOT touch the kanban board (kanbanMoved=false)", r.kanbanMoved === false);
      // doneByTag over live HTTP: demo sessions carry no tags, so the completion must surface
      // in the 'untagged' bucket — and ONLY count once.
      const stDone = await state();
      check("completing a tagless task bumps doneByTag 'untagged' by exactly 1",
        untaggedN(stDone) === untaggedN(before) + 1,
        `before=${untaggedN(before)} after=${untaggedN(stDone)}`);
      await postJson("/api/undo", {}); // restore so later sections still have items
      check("undo removes the completion from doneByTag again",
        untaggedN(await state()) === untaggedN(before));
    } else check("a completable item exists", false);
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== diffExpand: per-file context widens like GitHub's expand arrows ==");
  {
    const prSess = sessionsOf(await state()).find((s: any) => s.pr_local_repo && s.pr_base_ref && s.pr_head_ref);
    check("a demo PR session with a local sandbox repo exists", !!prSess);
    if (prSess) {
      // the default PR diff cuts consumer_guide.md at 3 context lines — line 1 is NOT in it
      const base = await postJson("/api/prDiff", { sessionId: prSess.id });
      check("default PR diff includes the guide hunk but NOT the file's first line",
        /consumer_guide\.md/.test(base.diff || "") && !/guide line 1\b/.test(base.diff || ""));
      const wide = await postJson("/api/diffExpand", { sessionId: prSess.id, path: "consumer_guide.md", ctx: 100 });
      check("POST /api/diffExpand widens ONE file's context to the whole file",
        wide.ok === true && /guide line 1\b/.test(wide.fileDiff || "") && /guide line 60\b/.test(wide.fileDiff || ""));
      check("diffExpand returns ONLY the requested file", !/sqs_consumer\.py/.test(wide.fileDiff || ""));
      const step = await postJson("/api/diffExpand", { sessionId: prSess.id, path: "consumer_guide.md", ctx: 10 });
      check("a smaller ctx returns a narrower cut (line 20 in, line 15 out)",
        step.ok === true && /guide line 20\b/.test(step.fileDiff || "") && !/guide line 15\b/.test(step.fileDiff || ""));
      const bad = await postJson("/api/diffExpand", { sessionId: prSess.id, path: "../../etc/passwd", ctx: 10 });
      check("path traversal is rejected", bad.ok === false);
      const miss = await postJson("/api/diffExpand", { sessionId: prSess.id, path: "no_such_file.txt", ctx: 10 });
      check("an unknown file is a clean ok:false (no 500)", miss.ok === false);
      const abs = await postJson("/api/diffExpand", { sessionId: prSess.id, path: "/etc/passwd", ctx: 10 });
      check("an absolute path is rejected", abs.ok === false);
      const neg = await postJson("/api/diffExpand", { sessionId: prSess.id, path: "consumer_guide.md", ctx: -7 });
      // NOTE: assert on context LINES (leading space); the @@ header carries "function context".
      check("negative ctx clamps to 0 (change only, no context LINES)",
        neg.ok === true && /guide line 30 — the consumer/.test(neg.fileDiff || "") && !/^ guide line/m.test(neg.fileDiff || ""),
        JSON.stringify(neg).slice(0, 300));
    }
    // non-PR DEMO sessions have no local PR repo to widen against → must fail CLEAN, not 500
    const plainSess = sessionsOf(await state()).find((s: any) => !s.pr_local_repo && Number.isFinite(Number(s.id)));
    check("a non-PR demo session exists", !!plainSess);
    if (plainSess) {
      const r = await postJson("/api/diffExpand", { sessionId: plainSess.id, path: "file.txt", ctx: 10 });
      check("non-PR demo session → clean ok:false with a readable error (demo guard)",
        r.ok === false && /not available/i.test(r.error || ""),
        `session ${plainSess.id} → ${JSON.stringify(r).slice(0, 300)}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== REAL git merge happens in a THROWAWAY repo; the GitHub path is a no-op ==");
  {
    const prSess = sessionsOf(await state()).find((s: any) => s.pr_local_repo || s.pr_head_ref);
    check("a demo PR session exists", !!prSess);
    if (prSess) {
      // the GitHub-facing merge is guarded off in demo (never touches a real repo/PR)
      const ghMerge = await postJson("/api/mergePr", { sessionId: prSess.id });
      check("/api/mergePr (GitHub path) is a guarded no-op in demo", ghMerge.ok === false && /demo/i.test(ghMerge.error || ""));
      // the local throwaway merge actually runs real git
      const realMerge = await postJson("/api/prMerge", { sessionId: prSess.id, method: "merge" });
      check("/api/prMerge runs a real git merge in the sandbox repo", realMerge.ok === true && /merged/i.test(realMerge.output || ""));
      // prove it with git itself: main now contains the feature commit
      const repo = (prSess.pr_local_repo as string) || path.join(os.tmpdir(), "cockpit-demo-prrepo");
      let log = "";
      try { log = execFileSync("git", ["-C", repo, "log", "--oneline", "main"], { encoding: "utf8" }); } catch {}
      check("sandbox repo 'main' now contains the merged retry commit", /retry/i.test(log));
      check("the throwaway repo lives under /tmp (NOT a real repo)", repo.startsWith(os.tmpdir()));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== Terminal WebSocket: connects, streams bytes, accepts input + resize ==");
  {
    const termSid = (await state()).queue[0].session_id;
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/term?sessionId=${termSid}&cols=100&rows=30`);
    let bytes = 0;
    let closedEarly = false;
    ws.on("message", (d: any) => (bytes += d.length));
    ws.on("close", () => (closedEarly = true));
    const opened = await new Promise<boolean>((res) => {
      ws.on("open", () => res(true));
      ws.on("error", () => res(false));
      setTimeout(() => res(false), 5000);
    });
    check("terminal WS connects (open)", opened);
    if (opened) {
      ws.send(JSON.stringify({ t: "i", d: "echo COCKPIT_E2E\r" }));
      ws.send(JSON.stringify({ t: "r", cols: 90, rows: 24 }));
      ws.send(JSON.stringify({ t: "used" }));
      await waitFor(async () => bytes > 0, 4000, 100);
      check("terminal WS streams terminal bytes to the browser", bytes > 0, `bytes=${bytes}`);
      check("terminal WS stays open through input + resize (no instant close)", !closedEarly);
    }
    try { ws.close(); } catch {}
  }

  // ──────────────────────────────────────────────────────────────────────────
  // REGRESSION (operator-reported): opening a task's terminal showed a terminal "from another
  // window / another place" — i.e. it attached to a FOREIGN tmux pane that merely shared the cwd
  // instead of the task's own session. sessions.ts:328 calls this "the classic 'clicking any
  // session shows the same terminal' bug". These assertions fail if a task's terminal ever points
  // at anything but its OWN session — both structurally (the resolved target) and behaviorally
  // (the bytes actually streamed).
  console.log("\n== Terminal is bound to ITS OWN task — never a foreign window (regression) ==");
  {
    st = await state();
    const targets = new Map<number, string>();
    for (const q of st.queue) {
      const cmd = (await getJson(`/api/attach?sessionId=${q.session_id}`)).command as string;
      targets.set(q.session_id, cmd || "");
    }
    const cmds = [...targets.values()];
    check("every task resolves to a non-empty terminal target", cmds.every((c) => c.length > 0), JSON.stringify(cmds));
    // the core invariant: NO TWO tasks may share a terminal target (that IS the bug).
    check("no two tasks share the same terminal target (no cross-wiring)", new Set(cmds).size === cmds.length, JSON.stringify(cmds));
    // each non-PR task's terminal target references ITS OWN branch — proof it's connected to THIS task.
    for (const q of st.queue) {
      const branchTail = String(q.session.branch || "").split("/").pop() || "";
      if (!branchTail || q.session.pr_number) continue; // PR sessions key off the PR number, not branch
      const cmd = targets.get(q.session_id) || "";
      check(`terminal for “${String(q.session.title).slice(0, 26)}…” targets its OWN branch (${branchTail})`, cmd.includes(branchTail), cmd);
    }

    // BEHAVIORAL: open one task's LIVE terminal and prove its byte stream never contains a
    // DISTINCTIVE token belonging to a different task (which is what the operator saw).
    const tokenOf = (q: any): string | null => {
      const m = String(q.session.branch || "").match(/([a-z0-9]{4,})$/i);
      return m ? m[1].toLowerCase() : null;
    };
    const cand = st.queue.map((q: any) => ({ q, tok: tokenOf(q) })).filter((x: any) => x.tok);
    if (cand.length >= 2) {
      const A = cand[0], B = cand[1];
      const grab = (sid: number, ms: number) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/term?sessionId=${sid}&cols=100&rows=30`);
          let s = "";
          ws.on("message", (d: any) => (s += d.toString("utf8")));
          ws.on("error", () => {});
          setTimeout(() => { try { ws.close(); } catch {} resolve(s); }, ms);
        });
      const streamA = await grab(A.q.session_id, 1800);
      const streamB = await grab(B.q.session_id, 1800);
      check(`task A (“${A.tok}”) terminal received bytes`, streamA.length > 0, `len=${streamA.length}`);
      check(`task A's terminal must NOT show task B's content (“${B.tok}”)`, !streamA.toLowerCase().includes(B.tok), `leaked B token`);
      check(`task B's terminal must NOT show task A's content (“${A.tok}”)`, !streamB.toLowerCase().includes(A.tok), `leaked A token`);
    } else {
      check("two distinctively-named tasks available for the cross-wiring test", false, `cand=${cand.length}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== SSE /api/events pushes an 'update' after a tick ==");
  {
    const got = await new Promise<boolean>((resolve) => {
      let buf = "";
      let settled = false;
      const fin = (v: boolean) => { if (settled) return; settled = true; try { req.destroy(); } catch {}; resolve(v); };
      const req = http.get(srv.base + "/api/events", (res) => {
        res.setEncoding("utf8");
        res.on("data", (c) => {
          buf += c;
          if (/event:\s*update/.test(buf)) fin(true);
        });
      });
      req.on("error", () => fin(false));
      // trigger a broadcast
      setTimeout(() => { post("/api/tick", {}).catch(() => {}); }, 300);
      setTimeout(() => fin(false), 6000);
    });
    check("SSE client receives an 'update' event after POST /api/tick", got);
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== Nightly dream is reachable + returns a summary ==");
  {
    const r = await postJson("/api/dream", {});
    check("POST /api/dream returns a summary", typeof r.summary === "string" && r.summary.length > 0);
  }

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n== Session search: keyword + semantic (demo = offline fallback) + open ==");
  {
    // Seed a fixture transcript into the DEMO sandbox dir (the demo server scans this
    // throwaway dir, NEVER the operator's real ~/.claude/projects).
    const searchDir = path.join(path.resolve(__dirname, "../.."), "data", "demo_session_search_projects", "-tmp-e2e");
    fs.mkdirSync(searchDir, { recursive: true });
    const J = (o: any) => JSON.stringify(o);
    fs.writeFileSync(path.join(searchDir, "e2e-search-uuid-1.jsonl"), [
      J({ type: "mode", sessionId: "e2e-search-uuid-1" }),
      J({ type: "user", cwd: "/tmp/e2e-proj", message: { content: "Investigate the flaky websocket reconnect bug" } }),
      J({ type: "ai-title", aiTitle: "Flaky websocket reconnect" }),
      J({ type: "last-prompt", lastPrompt: "now add a regression test" }),
    ].join("\n"));

    const kw = await getJson("/api/session-search?q=websocket");
    check("GET /api/session-search finds the seeded fixture", Array.isArray(kw.results) && kw.results.some((e: any) => e.claude_session_id === "e2e-search-uuid-1"));
    const hit = kw.results.find((e: any) => e.claude_session_id === "e2e-search-uuid-1");
    check("search result carries title + first prompt + cwd", hit && hit.title === "Flaky websocket reconnect" && /flaky websocket/i.test(hit.first) && hit.cwd === "/tmp/e2e-proj");
    const none = await getJson("/api/session-search?q=zebra-quantum-nonsense");
    check("no-hit query → empty results (not an error)", Array.isArray(none.results) && none.results.length === 0);

    const sem = await getJson("/api/session-search/semantic?q=websocket reconnect problems");
    check("semantic in DEMO degrades to keyword-fallback (never calls claude)", sem.via === "keyword-fallback" && Array.isArray(sem.results));
    check("semantic fallback still returns the fixture", sem.results.some((e: any) => e.claude_session_id === "e2e-search-uuid-1"));

    const opened = await postJson("/api/session-search/open", { claudeSessionId: "e2e-search-uuid-1" });
    check("POST open upserts the historical session → roster id", opened.ok === true && typeof opened.sessionId === "number");
    const again = await postJson("/api/session-search/open", { claudeSessionId: "e2e-search-uuid-1" });
    check("re-opening is idempotent (same roster row, no duplicate)", again.ok === true && again.sessionId === opened.sessionId);
    st = await state();
    check("opened session appears in /api/state with the searched title",
      sessionsOf(st).some((s: any) => (s.row?.id ?? s.id) === opened.sessionId));
    check("POST open with a bogus id → 404, no crash", (await post("/api/session-search/open", { claudeSessionId: "no-such-uuid" })).status === 404);
    check("POST open with no id → 400", (await post("/api/session-search/open", {})).status === 400);
  }
}

(async () => {
  let srv: DemoServer | null = null;
  let code = 2;
  try {
    console.log("booting isolated demo server…");
    srv = await startDemoServer();
    console.log("demo server up on", srv.base);
    await run(srv);
    code = summary();
  } catch (e) {
    console.error("\nE2E SERVER ERROR:", e);
    if (srv) console.error("\n--- server log tail ---\n" + srv.log().slice(-2000));
  } finally {
    if (srv) await srv.stop();
  }
  process.exit(code);
})();
