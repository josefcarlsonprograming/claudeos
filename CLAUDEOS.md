# ClaudeOS

A personalized, single-operator **cockpit** for running ~20 independent Claude Code sessions on hard, exploratory ML/systems work. It watches every session, surfaces **only the ones that genuinely need you**, ranks them transparently, drafts the answer, lets you act in one keystroke, and learns from your feedback. The operator (the operator) runs many Claude sessions at once; ClaudeOS is the single pane that tells him *what needs him next*.

- **Repo:** `git@github.com:your-org/claudeos` (private)
- **Install path (the server):** `~/code/claudeos` (local on the server, like the your-repo repo — this is where all work happens now; the old `~/code/claudeos` copy is retired)
- **Runs as:** a web server on the server, viewed from the operator's your laptop browser (or the Electron shell in `desktop/`). Real instance on **:4317**, safe demo on **:4318**.
- **No API key:** all LLM calls go through the operator's Claude Code subscription via the `claude` CLI (`claude -p`).

---

## Repo workflow (rules for this repo — DIFFERENT from your-repo)

- The main branch is **`master`**.
- Prefer **branch-from-master → open PR → merge the PR into master**. Small things may be committed **directly to master**.
- **You are pre-authorized to merge PRs and push to master in this repo without asking.** Never ask the operator about merging here. (This is the opposite of the your-repo repo, where you must never push to master.)
- **Keep `master` green — an automated gate enforces it.** Git hooks live in `scripts/git-hooks/` and auto-activate via `npm install` (postinstall sets `core.hooksPath`); run `npm run hooks:install` to enable them by hand.
  - **pre-commit** → `npm run build`. A commit that doesn't compile is blocked. (This is the gate that catches the whole "broke the build, can't start the app" class — e.g. a stray backtick in a SQL template literal.)
  - **pre-push to `master`/`main`** → build + core harness + server E2E (~40s); the push goes through **only if green**. Pushing a **branch** skips the gate (iterate fast — gate when you merge to master). `FULL=1 git push` *or* `[full-test]` in the commit message also runs the browser UI click-through tier.
  - **`--no-verify` policy:** bypass the gate **only for small, non-dangerous commits** — docs, comments, a typo, a copy tweak, a `.md`. For **anything that changes behavior** (core/engine/server/renderer, `db.ts`/migrations, the terminal/merge/undo/ranking paths) you **must let the tests run** — never `--no-verify` those. When in doubt, run the tests; ~40s is cheap next to a broken master.
- This is a **private** repo; don't add secrets. Runtime data (`data/`, `*.db`), `node_modules/`, and `dist/` are gitignored.

## Run / build / test

```bash
npm install                 # deps (node:sqlite needs Node 22.5+; Electron 42 bundles Node 24)
npm run build               # tsc + copy-assets (renderer html/css + xterm/diff2html vendored locally)
npm run serve               # build + run the server (real)  on :4317
npm run demo:serve          # build + run the DEMO server     on :4318  (sandboxed, nothing real)
npm run restart             # pkill -9 both + restart both + verify listen-pid == spawned-pid  ← USE THIS to deploy
npm run reset-real          # wipe data/cockpit.db + re-discover (use after discovery/schema changes)
npm test                    # build + ALL 4 tiers (614 assertions, ~55s): core harness + answer-feedback (headless) · server E2E (HTTP/WS/SSE + real throwaway git merge) · UI click-through (real headless browser, clicks buttons/keys). Demo-sandboxed — never touches real data/git/kanban.
npm run test:core           #   just the fast headless harness    (460)
npm run test:answers        #   just the answer-feedback ring     (27)
npm run test:server         #   just the server E2E over the wire (80)
npm run test:ui             #   just the browser click-through    (47; needs Playwright chromium)
npm start                   # Electron desktop app (loads the local build)
```

**The stale-process gremlin (important):** restarting via tmux/Ctrl-C can leave an orphaned node child serving *old* code. Always deploy with **`npm run restart`** — it `pkill -9`s and verifies the listening pid is the one it just spawned. After any change, `npm run build` (or restart) then verify the deployed `dist/` actually contains your change (grep it) — don't trust that a restart picked it up.

**Verifying a change is live:** grep `dist/` (not just `src/`), confirm `curl -s localhost:4317/ -o /dev/null -w "%{http_code}"` is 200, and check the server pid changed. Renderer changes need a browser hard-reload (`Ctrl+Shift+R`).

---

## Architecture

```
Browser (your laptop)  ──http/ws──►  Node server on the server (:4317)  ──►  node:sqlite (data/cockpit.db)
  xterm.js + diff2html                 │
  renderer.ts (one big script)         ├─ engine.tick() every 5s:  discover → detect state → triage → rank → enrich
                                       ├─ /api/state (full state)  +  quick endpoints (snooze/ack/complete/…)
                                       └─ /api/term  WebSocket  ──►  node-pty  ──►  claude --resume / tmux attach
```

- **Server** (`src/server/server.ts`): HTTP + WebSocket. `tickLoop()` runs `engine.tick()` on `tick_interval_ms` (5s). Quick endpoints use `quickRerank()` (cheap re-sort), heavy ones `await tickLoop()`. `webapi.js` is a plain-JS fetch/SSE shim so the same renderer runs in browser and Electron.
- **Renderer** (`src/renderer/renderer.ts`): a single non-module script (no import/export). Global state object `S`. Two-pane layout: **Pane A** (left, overview/diff/html views) + **Pane B** (right, terminal). Master-key dispatch, xterm, diff2html.
- **Electron shell** (`desktop/`): a **thin wrapper** that `loadURL`s the server — gives full keyboard capture, native notifications on WAITING_INPUT, and a global summon hotkey. Does NOT make the terminal faster (same Chromium + WS). UI changes on the server are instant (just reload); only changing `desktop/main.js` needs a re-copy on your laptop.

### The pipeline (engine.tick)
1. **Discover** (`discover.ts`): scan `~/.claude/projects/<enc-cwd>/*.jsonl`, take the latest ~20, derive cwd + title, upsert sessions. **Reads only the HEAD (~64KB)** of each transcript for cwd/title; caches `gitInfo(cwd)` 60s; all fs/git **async** + chunked-yield so the tick never blocks the event loop (transcripts can be 20MB+).
2. **Detect state** (`stateDetector.ts` + `transcript.ts`): **tail-read the last ~128KB** of the transcript to find the last turn → `WAITING_INPUT | WORKING | DONE | UNKNOWN`. **CRITICAL RULE: only WAITING_INPUT/DONE ever produce an actionable item.** WORKING/UNKNOWN never appear in Up Next.
3. **Triage** (`triage.ts`): cheap rules first (blocked? diff size?), Claude only when uncertain → `SIMPLE_QUESTION | REVIEW_DIFF | COMPLEX_DECISION | FYI_DONE`.
4. **Rank** (`priority.ts`): transparent weighted score over `llm_importance`, `blocks_other_work`, `effort_small`, `staleness`, `focus_match`, `deadline` + per-category learned nudges. `PIN_BASE`, `ACTIVE_BASE` (opening a terminal boosts that task to #1). Every score has a readable breakdown.
5. **Enrich** (`enrich.ts`/`summarize.ts`): background `claude -p` for the one-liner, suggested answer, clean title. Fire-and-forget, cached, never blocks the tick.
6. **Learn** (`dream.ts`/`feedback.ts`/`ranking.ts`): nightly `runDream()` folds decision history into per-category nudges + a small-LR perceptron over the weight vector, and evolves `config/RANKING.md`. Fully interpretable (logged to `dream_log`).

### Queue vs Roster
- **Queue / "Up Next"** = only sessions that are READY (WAITING_INPUT/DONE) and not dismissed/completed. This is the actionable list.
- **Roster** = all discovered sessions (working ones shown greyed). A session never silently vanishes from the roster.
- **Selection is identity-based** (`S.selItemId`): the selection follows the *task*, not the index, so the queue can re-rank around it without moving the operator's focus. Only explicit nav/click/open changes selection.
- **Manual status override (right-click a card / click its status dot).** Claude auto-tags every session's status (WAITING_INPUT/WORKING/DONE); when it reads one **wrong**, the operator right-clicks the queue card or roster row — or left-clicks its status dot — and picks the right one (or "let Claude decide" to clear). Forcing WAITING_INPUT/DONE **surfaces** a mis-hidden session; forcing WORKING **silences** one out of Up Next. It's the *transient* status only — permanent "done + archive" stays the complete action (`Ctrl+G e`). The override is **sticky-until-reality-moves**: it holds until the auto-detector's reading actually changes off what it said when you corrected it, then auto-clears (so a silenced session can never strand a real question). Every correction is logged to `decision_log` (`feedback='manual_state'`, from→to) so the nightly dream can learn where detection was wrong. `controller.overrideState` → `POST /api/overrideState`; applied with final authority in `engine.applyManualOverride`; undoable. Tested in `harness.ts`, `e2e_server.ts`, `e2e_ui.ts`.

---

## The terminal model (this is the subtle part)

ClaudeOS opens a session's terminal in **Pane B** by routing on liveness (`controller.livenessForOpen`):

- **Idle session** (NOT a live process) → spawn `claude --resume <session-id> --dangerously-skip-permissions` **directly in node-pty** (NO tmux) → fast, dedicated, its own terminal.
- **Live session** → can't `--resume` (would double-run / corrupt the transcript) → fall back to `tmux attach` (read-mostly) or a read-only transcript view.

### The LOCAL terminal (Electron): ssh→tmux, NOT a streamed WebSocket  ← the robust path (2026-06-09)
**The bug was never tmux — it was the transport.** The original terminal wrapped each per-task tmux in a **node-pty on the server** and streamed it to the client over a **WebSocket**, with a pile of custom reconnect/heartbeat/`[exited]` handling that is fragile over the network (this caused the "no transcript found" spam loop, the `[exited]` flicker, the focus-steal, etc.). The fix: **run the terminal on the operator's machine** and let **ssh + tmux own the transport** (they're built for exactly this — durable, reattachable, multi-client).

How it fits together (3 pieces):
1. **Server (`/api/term-spec`, stays on the server):** given a sessionId, it **ensures the durable per-task tmux session exists** (`tmux new-session -A -d -s claudeos-<id>` running `claude --resume`, byte-identical keep-alive — no dupes) and returns `{ ok, host, remote: "tmux attach -t claudeos-<id>" }`. **No pty, no execution server-side** — it just tells the client where to attach. Returns `{ ok:false }` for sessions that aren't safely attachable (live/bg/non-resumable) so the client falls back to the WS.
2. **Electron desktop app (`desktop/`, runs on your laptop):** `preload.js` exposes **`window.claudeosNative`**; `main.js` keeps a `Map<id, node-pty>` and, on `term:open`, spawns a **LOCAL** pty running **`ssh -tt <host> "tmux attach -t claudeos-<id>"`** and bridges its bytes to the renderer's xterm over Electron **IPC**. Bytes flow **your laptop ↔ the server straight over ssh+tmux** — the WS and all its reconnect plumbing are out of the path. A dropped ssh just ends the pty; reopening re-attaches (tmux kept the session alive) — so there's **no custom reconnect logic here**.
3. **Renderer (transport abstraction):** input (`termSendInput`) and resize (`termSendResize`) route to **whichever transport is live** — the native ssh pty (`S.termNative`, via `nativeTerm()` = `window.claudeosNative`) or the WS. `openTermNative()` fetches `/api/term-spec`; if `ok` **and** `window.claudeosNative` is present (i.e. running in the Electron app) → use the local ssh pty; **otherwise** (plain browser tab, or a live/bg/non-resumable session) → fall back to the streamed WS, **unchanged**. So browser users see zero change; desktop users get the robust path.

**Why the server still lives on the server:** it reads the server's filesystem every 5s tick (transcripts, git, tmux, `claude agents`) — it can't move without doing all that over the network. So *only the UI and the terminals* are local; the server is a read-only data feed the local UI reads over http. If that feed hiccups, the terminals (pure ssh+tmux) are **unaffected** — kill/restart the cockpit server and an open local terminal keeps running, which is the quickest way to *prove* the WS is out of the path.

**Prereqs / gotchas (Windows your laptop):**
- `node-pty` is a **native module** → `desktop/` `postinstall` runs `electron-rebuild`. Building it on Windows needs **VS C++ workload** (`VC.Tools.x86.x64`), the **MSVC v143 Spectre-mitigated libs** (winpty sub-project requires them — `MSB8040`), and **Python** (node-gyp). If it can't build, the app **degrades to the streamed WS** (no crash).
- **ConPTY does NOT search `%PATH%`** for the executable → pass the **absolute** `ssh.exe` path (`C:\Windows\System32\OpenSSH\ssh.exe`), else `WindowsPtyAgent` throws "file not found". (`resolveSsh()` in `main.js`.)
- Needs **`ssh <host>` working from your laptop** (key-based). `host` defaults to `<host>` (a `~/.ssh/config` alias → the server's IP `localhost`); override with `CLAUDEOS_SSH_HOST` / cockpit URL with `CLAUDEOS_URL` (default `http://localhost:4317`).
- **Verify it's the local path:** on the server, `ps | grep "tmux attach -t claudeos"` and `tmux list-clients` show your terminals as live tmux clients, plus an incoming ssh from your laptop — vs the WS path which shows a `/api/term` socket and no `tmux attach`. The renderer's term-foot also reads **"attaching (local ssh)…"**.
- Tests: `npm run test:server` covers `/api/term-spec` (ensures + returns the right attach, no dup sessions). The Electron half is mocked-and-tested headless in `src/test/desktop_term_leak_test.ts` (drives the real `desktop/main.js`/`preload.js` with stubbed `electron`/`node-pty`).

### The desktop terminal must reap its ptys on RELOAD — the cross-session-bleed bug (2026-06-16)
Symptom: opening a new task's terminal showed **another session's output** ("I see other things there"), and **Ctrl+Shift+R made it WORSE over time**, not better — plus dozens of leaked `tmux attach` clients piling up on the server. Two bugs in `desktop/`, same shape (a stale terminal left alive when a new one attaches):
1. **`main.js` only killed its ssh→tmux ptys on app QUIT, never on a renderer reload.** The `terms` Map lives in the **main process**, which survives `win.reload()`. So every Ctrl+Shift+R threw away the renderer but left **all** its ssh ptys alive → leaked tmux clients that keep `e.sender.send("term:data", …)`-ing into the (new) renderer.
2. **`preload.js` reset its handle-id counter (`_seq=0`) on every load.** The new page's first terminal got id **`t1`** again — colliding with an orphaned `t1` still emitting. `preload`'s `term:data` routes by id, so the **old session's bytes painted into the new xterm**. Each reload orphaned more ptys, so it **compounded** (why a reload only ever helped for a second).

**Crucial:** `main.js`/`preload.js` load **only at app startup**, *never* on Ctrl+Shift+R — so a **full app restart** is the only way a desktop fix takes effect; a hard-reload can never fix a main-process bug. (Renderer-only fixes DO load on reload, since the renderer is served from the server.)

Fix: `killAllTerms()` on `webContents` **`did-start-navigation`** (main-frame, non-in-place) + **`render-process-gone`** + quit; a **collision guard** in `term:open` (kill any pty already on that id); and a **per-load random id tag** in `preload.js` so ids can't recycle across a reload. Regression-tested in `desktop_term_leak_test.ts` (reload reaps all ptys, guard doesn't over-fire on in-place/sub-frame nav, recycled id kills the stale pty, ids from two loads never collide). **Deploy:** your laptop is a git checkout at `C:\Users\bioso\claudeos` on `master` → `git checkout origin/master -- desktop/main.js desktop/preload.js`, then the operator **fully quits (Ctrl+Alt+Q) and reopens via the `ClaudeOS` desktop shortcut** (start = `electron .` in `desktop/`). The app is launched **manually** (no scheduled task, not in Startup) — **never kill it from ssh**, nothing would relaunch it. The restart's `will-quit` also reaps every leaked attach in one go.

### Background agents & the cc-daemon (key gotcha)
The operator often runs work via Claude Code's **`claude agents`** view — a multi-agent dashboard managed by a background **`cc-daemon`** (`claude daemon run`, pid is the daemon). Consequences ClaudeOS must respect:
- **You cannot attach to one specific background agent** (no per-agent attach CLI; `claude agents --json` lists them, that's it).
- **Killing a bg agent is NOT durable** — the daemon respawns it with a new pid. So "take over by killing" was removed; instead ClaudeOS tells the operator to **stop it in the agents view (`Ctrl+X`)**, after which it's a normal resumable session.
- **The daemon holds old transcripts' fds open forever.** So `livenessForOpen`'s "a process holds the transcript fd" check **excludes the cc-daemon** (`isCcDaemon`, matches `claude daemon run`). A fd-holder only counts as live if it's a real `claude --resume`/agent process.
- Liveness for opening a terminal = `(in fresh \`claude agents --json\` bg set) OR (a NON-daemon claude process runs this exact session)`. Transcript mtime alone is **not** a blocker (a session whose process is dead resumes immediately, no 60s wait).
- The migration the operator wants: **`Ctrl+X` an agent in the agents view → click it in ClaudeOS → instant dedicated `claude --resume` terminal.** New tasks launched *from* ClaudeOS are standalone (not bg agents) and dedicated from birth.

### The read-only transcript view must NEVER close its socket (reconnect-spam bug)
When a session can't be `--resume`d and has no safe pane, `sendReadOnlyTranscript` renders the session's own transcript read-only into the WS (`server.ts`). **It must NOT `ws.close()` after sending.** The renderer treats *any* unexpected socket close as a dropped terminal and **auto-reconnects** (`ws.onclose → scheduleTermReconnect`, term-foot shows `reconnecting… (try N)`). If the read-only path closes the socket, the renderer reconnects → re-opens → re-sends the same dump → **infinite spam loop** (`● background agent — read-only …` / `(no transcript found for this session)` repeating, top-right flapping reconnecting→live→reconnecting). Fix (2026-06-09): keep the socket **open and idle** after sending; ignore incoming keystrokes (read-only). It's torn down only when the operator navigates away (an *intentional* close) or the process exits.

### Resolving a session's transcript — by id, not by cwd (the "no transcript found" bug)
`transcriptFor(session)` must resolve via **`claude_session_id`** (`findTranscriptById` → `~/.claude/projects/*/<session-id>.jsonl`), not only `findTranscript(worktree cwd)`. The cwd→project-dir mapping breaks for **background agents** (worktree differs from where `claude` actually ran) and the newest-`.jsonl`-in-dir heuristic can return a **different** session's transcript that merely shares the cwd. Both failure modes surfaced as `(no transcript found for this session)` (or the wrong conversation) in the read-only pane. Order: cached `transcript_path` → exact `findTranscriptById(claude_session_id)` → newest-in-cwd fallback. **Regression-tested** in `harness.ts` ("the reconnect-spam loop" block): a `<uuid>.jsonl` that exists on disk is always found by id, even when the cwd dir is empty or holds a newer unrelated transcript. If you touch transcript resolution or the read-only WS path, those assertions must stay green (`npm test`).

### Session→pane mapping is by transcript fd, NOT cwd ("every session showed my own window" bug)
`discover.ts` correlates a session to its live tmux pane via the pane that has the session's **own transcript `.jsonl` open** (`scanOpenTranscripts()` /proc-fd scan → `paneForPid()` parent-walk → `paneByTranscript`). It must **never** map by cwd: the operator runs many sessions in one repo cwd, so a cwd map collapses them all onto the single live pane for that cwd → **clicking any session opens the operator's own (3-pane) tmux window**. Consequence of the exact mapping: a session is `is_live_pane`/attachable only when its own claude process lives in a tmux pane. **Daemon-managed background agents** (transcript held by the orphaned cc-daemon, no tmux-pane ancestor) and plain transcript-on-disk sessions resolve to **no pane → read-only roster** — which is honest, since the cockpit can't attach to one specific bg agent anyway (interact via the agents view, or direct `claude --resume` for idle sessions). Regression-tested in `harness.ts` ("by transcript fd … NOT shared cwd"). Note `sessions.ts:resolvePaneTarget` still contains the legacy cwd matcher — `ensureAttachSpec` (the path actually used) does **not** call it; don't reintroduce cwd-matching into the attach path.

### Other terminal facts
- WebSocket has `setNoDelay(true)` (kills ~40ms Nagle/keystroke over the network) + output coalescing + WebGL xterm renderer.
- **Paste:** the operator is on `http://localhost:4317` (insecure context → `navigator.clipboard` is blocked). Paste uses the browser **`paste` event** → sends clipboard text to the PTY. `Ctrl+V` is NOT forwarded as 0x16 (which Claude reads as image-paste). Image paste isn't supported (PTY is text-only; Claude on the server can't see your laptop clipboard).
- **Ctrl+Enter = newline, Enter = send** (in the answer box and in the xterm, where Ctrl+Enter sends `\n`).
- Residual latency is **the network RTT + box load**, not the server (server answers in ~2ms). Electron won't fix it; the lever is direct-pty + NoDelay + (optionally) mosh-style predictive echo.

---

## Keybindings (TERMINAL-FIRST + master key model, 2026-06-10)

**The model:** landing on a task focuses its **live terminal** (Pane B) — whatever you type goes straight to the session. Two exceptions, by operator request:

- **Plain `↑` / `↓` ALWAYS walk the queue**, from anywhere — they are never sent to the terminal. `Shift+↑`/`Shift+↓` is the escape hatch that sends a real arrow to the pty (Claude Code menus, shell history).
- **Every other cockpit action is gated behind the master key** — bare letters never trigger anything (no more stray `h`/`l`/`i` firing while you meant to type). PR/review tasks (Pane B = Diff) still land on the Overview/answer box, since there's no terminal to type into.

**`Ctrl+G`** is the ClaudeOS leader (configurable `keymap.json` `master`), chosen so **`Ctrl+B` stays free for the operator's inner tmux.** After `Ctrl+G` (one-shot; capitals dodge the view bindings):

| Key | Action |
|---|---|
| `↑` / `↓` · `j` / `k` | prev / next task (works even inside the terminal; identity-stable) |
| `Enter` | **dismiss** ("handled for now") — snooze-until-ready; **re-surfaces** when the session is waiting/done again (NOT permanent) |
| `e` | **complete** — permanent: archive + move the kanban card to `~/kanban/8_done/` |
| `a` / `E` | accept & send the suggested answer / edit it first |
| `H` / `L` | rank this task **H**igher / **L**ower (+ optional reason) |
| `I` | set manual importance (0–100) |
| `p` / `Z` / `u` | pin · snooze · undo |
| `o` / `t` / `d` / `h` | Overview / Terminal / Diff / HTML(viz) view |
| `m` (or `z`) | maximize the focused pane (keeps the queue) |
| `f` | set current focus (biases ranking) |
| `;` / `←` `→` | switch pane focus |
| `C` / `c` / `i` | new Claude terminal / new shell / quick background prompt |
| `n` | new session · `T` take-over (→ tells you to Ctrl+X a bg agent) · `q`/`Esc` back |
| `m` / `X` | merge the session's PR / merge a PR-kind item (both guarded) |
| `w` `g` `O` `N` | feedback: wrong / good / too much output / need more context |
| `F` / `r` / `R` / `G` / `?` | set focus · refresh · **rename** the selected session (inline; empty reverts to the auto name) · jump (then digit) · help |

- **`Ctrl+Z`** = undo (outside the terminal; passes through as SIGTSTP when the terminal is focused). `Ctrl+G u` also undoes.
- Undo stack covers snooze, dismiss, complete (+ kanban move back), feedback, manual importance, pin.
- In the **answer box** (focus pane A: `Ctrl+G ←` or `Ctrl+G o`): A/B/C/D (or Y/N) pick a candidate answer while the box is empty, `Enter` sends, typing is always literal — the old empty-box command-bar letters are gone.

---

## Pinning sessions by description (operator runbook)

When the operator says "pin the sessions that are doing X" (e.g. "pin the ones babysitting training/inference"), do exactly this — it worked well on 2026-06-10:

1. **Don't trust titles.** Most `sessions.title`/`clean_title` are junk ("New Claude session", "I need more context…"). Identify sessions by **reading their transcripts**.
2. **List candidates** from the cockpit DB (no `sqlite3` binary on the server — use node's built-in driver):
   ```bash
   cd ~/code/claudeos && node -e "
   const {DatabaseSync} = require('node:sqlite');
   const db = new DatabaseSync('data/cockpit.db');
   for (const r of db.prepare(\"SELECT id, clean_title, title, transcript_path, pinned FROM sessions WHERE completed_at IS NULL\").all())
     console.log(r.id, r.pinned, (r.clean_title||r.title||'').slice(0,80));"
   ```
3. **Classify by transcript content** (`transcript_path` → `~/.claude/projects/*/<id>.jsonl`):
   - For *babysitting*: the precise signal is the last `babysit.sh on` appearing **after** the last `babysit.sh off` in the transcript (`lastIndexOf` both). Keyword-grepping "inference/training" matches everything in your-repo — too loose.
   - Then read each candidate's **last assistant text message** to confirm what it's actually watching, and check transcript **mtime** for staleness (idle for days → probably finished, don't pin).
4. **Pin through the live server, NOT raw SQL** (UI re-ranks + broadcasts instantly): `POST http://localhost:4317/api/pin` with `{"sessionId": <id>, "pinned": true}` (port = `COCKPIT_PORT`, default 4317; `pinned:false` unpins). Verify with a quick DB read of `pinned=1`.
5. **Report a table**: id | app title | what it's *actually* doing — and list near-misses you deliberately did NOT pin, with reasons. Pinned items get `PIN_BASE` (100000) in `priority.ts`, so they sit above all organic scores; pins are undoable (`Ctrl+Z`).

The same recipe generalizes to any "find sessions doing X and <act>" request: DB list → transcript-content classification → act via the server API → verify in DB → report with exclusions.

## Diff view
GitHub "Files changed" style: a **collapsible file tree on the left**, the diff stacked + continuously scrollable on the right, **lazy-rendered per file** (IntersectionObserver) so big diffs stay smooth. **By default only `src/your-repo` is expanded** (others collapsed → hidden from the right). Diffs against the **merge-base** of `origin/main` (immune to the base moving), header shows `vs <base> @ <sha>`. Per-file "Viewed" toggle.

## Visualizations (HTML view)
Folder convention: `~/.claudeos/visualizations/<task-folder>/*.html` (one folder per task; matched to a session by kebab-slug of clean_title/title or branch). When a session has viz files, Pane A shows an **HTML** view that renders them in a sandboxed iframe via `GET /api/viz/<sid>/<i>`, with **tabs** for multiple files. (`src/core/viz.ts`.)

---

## File map

| File | Purpose |
|---|---|
| `src/server/server.ts` | HTTP + WS server, endpoints, `attachTerminal`, tick loop |
| `src/server/webapi.js` | browser/Electron fetch+SSE shim (plain JS, not compiled) |
| `src/renderer/renderer.ts` | the entire UI (one script): panes, master keys, xterm, diff2html, viz |
| `src/renderer/{index.html,styles.css}` | shell + styles |
| `src/core/engine.ts` | `tick()`, `surface()` (creates/re-ranks items + dismiss re-surface), `setActiveSession` |
| `src/core/discover.ts` | transcript discovery (head-read, gitInfo cache, async) |
| `src/core/stateDetector.ts`,`transcript.ts` | state detection via tail-read |
| `src/core/triage.ts`,`importance.ts` | classify + importance |
| `src/core/priority.ts` | transparent scoring (weights + learned + ACTIVE_BASE/PIN_BASE) |
| `src/core/enrich.ts`,`summarize.ts`,`claude.ts` | `claude -p` enrichment (lean mode, no MCP/CLAUDE.md) |
| `src/core/controller.ts` | actions: sendAnswer, ack, **dismiss** (snooze), **completeTask** (kanban), takeOverAgent, livenessForOpen, bgAgentSessionIds |
| `src/core/sessions.ts` | tmux helpers, `resolvePaneTarget`, `ensureAttachSpec`, demo sessions |
| `src/core/diff.ts` | merge-base diff, file tree |
| `src/core/dream.ts`,`feedback.ts`,`ranking.ts`,`undo.ts` | learning loop + undo |
| `src/core/kanban.ts` | kanban card matching + move-to-done (`sg managers` NFS quirk) |
| `src/core/viz.ts` | visualization folder matching + html listing |
| `src/core/db.ts` | sqlite schema + queries (`completed_at`, `dismissed_at`, items, learned_weights, …) |
| `src/core/pr.ts`,`pr_comments.ts` | optional GitHub PR surfacing (off by default: `weights.json pr_repos: []`) |
| `src/main/*` | Electron entry (local-bundled variant; the thin wrapper is `desktop/`) |
| `config/weights.json` | weights, `tick_interval_ms`, pane fractions, `default_base_branch`, `pr_repos` |
| `config/keymap.json` | `master` key + bindings |
| `config/RANKING.md` | human-readable learned ranking rules (evolved nightly) |
| `scripts/restart.sh`,`reset-real.sh`,`copy-assets.js` | deploy + asset bundling |
| `desktop/` | Electron thin-wrapper (loads the server URL) + README |

## Conventions for editing
- Plain **JavaScript-compatible TypeScript** in the renderer (it's a non-module script — no import/export there). Core/server are normal TS modules.
- New config knobs → `config/weights.json` (or `keymap.json`), not env vars (except machine-specific like host/port via `COCKPIT_*`).
- Keep internal identifiers as `cockpit*` (tmux socket names, `cockpit.db`, `COCKPIT_*` env, install path); only user-facing branding is "ClaudeOS".
- **Every new feature/behavior MUST ship with tests — non-negotiable, a feature without a test is NOT finished.** Workflow for any new feature:
  1. **Write tests** for it, in the right tier: `src/test/harness.ts` for core logic (engine/ranking/feedback/dream/undo/db…), `e2e_server.ts` for a new/changed HTTP endpoint or WS/SSE behavior, `e2e_ui.ts` for a new button / keybinding / UI interaction (assert it actually **changed state**, not just "didn't throw"). New deterministic feature with its own concern → can be its own ring (like `answer_feedback_test.ts`, registered in `run_all.ts`).
  2. **Run them and make them pass** — `npm test` (all 4 tiers, ~55s) or the per-tier `npm run test:core|test:server|test:ui|test:answers`. Don't call the feature done until green.
  3. **They then run automatically, forever.** The **pre-push gate** (see *Repo workflow*) runs the suite before anything reaches `master` and blocks the push if red — so the behavior you just added can never silently regress. This is why step 1 is mandatory: an untested feature is invisible to the gate. **Keep the suite green; never `--no-verify` a behavior change.**
- After changing discovery/schema, run `npm run reset-real`. After any change, `npm run restart` and verify in `dist/`.

## Known gotchas / hard-won facts
- Transcripts can be **14–21MB** → never read whole on the tick (head/tail only) or it freezes the event loop (~300ms/tick).
- The **cc-daemon respawns** killed bg agents and **holds old transcript fds** — see the terminal section.
- **Read-only transcript view must never `ws.close()`** (renderer auto-reconnects on any drop → spam loop), and **`transcriptFor` resolves by `claude_session_id`** not cwd — both regression-tested in `harness.ts`; see the two terminal-section subsections (2026-06-09 "no transcript found" bug).
- **Server PATH must include `~/.local/bin`** (where `claude` lives). The server runs under `systemd --user` with a minimal PATH; if `claude` isn't resolvable, `claude agents --json` returns nothing → the session→pane mapping is empty → **every session shows read-only**. Fixed in `restart.sh` (`--setenv=PATH=…`) + `discover.ts:envNoTmux()`; regression-tested. Symptom to recognize: all sessions read-only despite live `claude` panes existing.
- **Session→pane mapping is by `claude agents --json` pid → process-tree walk** (`paneForPid`), NOT cwd and NOT transcript-fd. cwd-match → "every session shows my window"; fd-match → "everything read-only" (the cc-daemon holds the fd, not the pane). Each interactive agent → its own pane (typeable); daemon agents → no pane → read-only. See the terminal-section subsection.
- Insecure-context (`http://<lan-ip>`) blocks the clipboard API → use the **paste event**.
- `~/data` top-level is **immutable** (`chattr +i`) + root-squashed; create subdirs via the NAS root with `chattr -i`/`+i`, and writes need `sg managers -c` (NFS primary-gid quirk).
- Server answers in ~2ms; felt lag is the network + box load, not the code.
