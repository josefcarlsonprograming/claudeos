/**
 * UI CLICK-THROUGH E2E — drives the REAL renderer in a real (headless) browser against the
 * isolated demo server, and actually clicks buttons / presses keys, asserting each one CHANGED
 * STATE (not merely "didn't throw"). This is the layer the headless harness can't reach: the
 * button → fetch(/api/…) → controller wiring where "I pressed it and nothing happened" bugs live.
 *
 *   node dist/test/e2e_ui.js
 */
import type { Browser, Page } from "playwright";
import { check, summary } from "./helpers";
import { startDemoServer, DemoServer, sleep, waitFor } from "./e2e_boot";

// Some very new host OSes (e.g. Ubuntu 26.04) aren't in Playwright 1.60's support table, so it
// can't locate the browser it downloaded under a compatible tag. If we're on a newer-than-24.04
// Ubuntu, pin the platform tag to the newest build Playwright ships — set BEFORE requiring
// playwright so its registry reads it. Harmless on supported hosts (only fires on bleeding-edge
// Ubuntu). Install the matching browser with:
//   PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright install chromium
if (!process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) {
  try {
    const rel = require("fs").readFileSync("/etc/os-release", "utf8");
    const id = (rel.match(/^ID=(.*)$/m) || [])[1]?.replace(/"/g, "");
    const ver = parseFloat(((rel.match(/^VERSION_ID=(.*)$/m) || [])[1] || "").replace(/"/g, ""));
    if (id === "ubuntu" && ver > 24.04) process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu24.04-x64";
  } catch {}
}
const { chromium } = require("playwright");

let SRV: DemoServer | null = null;
let page: Page;

const api = async (p: string) => (await fetch(SRV!.base + p)).json() as any;
const qstate = () => api("/api/state");
const sessOf = (st: any) => [...(st.sessions || []), ...((st.queue || []).map((q: any) => q.session))];
const sessById = (st: any, id: number) => sessOf(st).find((s: any) => s.id === id);

/** Run a named section; a thrown error becomes a single recorded failure (the run continues). */
async function section(name: string, fn: () => Promise<void>) {
  console.log("\n== " + name + " ==");
  try {
    await fn();
  } catch (e: any) {
    check(name + " (section threw)", false, String(e?.message || e).slice(0, 200));
  }
}

/** Click the queue row whose text contains `tok`; returns its DOM index (= index into state.queue). */
async function selectRow(tok: string): Promise<number> {
  return page.evaluate((t) => {
    const lis = Array.from(document.querySelectorAll("#queue li")) as HTMLElement[];
    const i = lis.findIndex((li) => (li.textContent || "").toLowerCase().includes(t));
    if (i >= 0) lis[i].click();
    return i;
  }, tok.toLowerCase());
}

/** The currently-selected row's index (the `.sel` data-i), or -1. */
async function selIndex(): Promise<number> {
  return page.evaluate(() => {
    const sel = document.querySelector("#queue li.sel") as HTMLElement | null;
    return sel ? Number(sel.getAttribute("data-i")) : -1;
  });
}

const ls = (k: string) => page.evaluate((key) => localStorage.getItem(key), k);
const uiScale = () =>
  page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale") || "1"));
/** Ctrl+key chord (key is a Playwright key name like "Equal"/"Minus"). */
async function ctrl(key: string) {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
}

/** Master sequence: Ctrl+G then a command key (TERMINAL-FIRST model: all action keys are gated
 *  behind the master — bare letters never trigger cockpit actions). */
async function master(key: string) {
  await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
  await page.keyboard.press(key);
}

/** Move keyboard focus to pane A (overview) DETERMINISTICALLY so global keys (Ctrl+Z, Ctrl +/-
 *  page-zoom) aren't captured by a focused terminal pane. A plain click can be re-stolen by the
 *  renderer's per-render terminal-focus re-assert (FIX LL), so we use the master sequence
 *  Ctrl+G then ← which calls focusPane("A") and works even from inside a focused terminal. */
async function focusA() {
  try { await page.locator("#pane-A-body").click({ position: { x: 8, y: 8 } }); } catch {}
  await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
  await page.keyboard.press("ArrowLeft"); // master ← → focusPane("A")
  await sleep(150);
}

/** Clear the answer-input so the renderer's "empty answer box = command bar" path is active
 *  (p/i/z/t only act as hotkeys while the box is empty; a stray char makes them literal text). */
async function clearAnswerInput() {
  await page.evaluate(() => {
    const i = document.getElementById("answer-input") as HTMLTextAreaElement | null;
    if (i) i.value = "";
  });
}

async function run() {
  // ── load ────────────────────────────────────────────────────────────────
  await section("Page loads the real renderer + queue", async () => {
    await page.goto(SRV!.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#queue li", { timeout: 15000 });
    const domCount = await page.locator("#queue li").count();
    const st = await qstate();
    check("queue renders one row per server item", domCount === st.queue.length, `dom=${domCount} server=${st.queue.length}`);
    check("DEMO banner is visible (safe sandbox)", await page.locator("#demo-banner").isVisible());
    check("a 'next' recommendation is present", !!st.next);
  });

  // ── re-prioritize button ───────────────────────────────────────────────────
  await section("Re-prioritize (↻) button next to the queue fires the endpoint", async () => {
    const btn = page.locator("#reprioritize-btn");
    check("the ↻ re-prioritize button is rendered next to the Tasks header", await btn.isVisible());
    // Click and assert it actually POSTs /api/reprioritize (the "button does nothing" bug-class).
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/reprioritize") && r.request().method() === "POST", { timeout: 8000 }),
      btn.click(),
    ]);
    check("clicking ↻ POSTs /api/reprioritize and the server answers ok:true", resp.ok() && (await resp.json()).ok === true);
    check("the queue is still intact after re-prioritizing (nothing dropped)", (await page.locator("#queue li").count()) === (await qstate()).queue.length);
  });

  // ── status dot / right-click → manual status override ─────────────────────
  await section("Status dot menu corrects a card's status (manual override)", async () => {
    const dot = page.locator("#queue li .statedot").first();
    check("queue cards render a clickable status dot", (await dot.count()) > 0 && (await dot.isVisible()));
    await dot.click(); // "press the status of the card"
    await page.waitForSelector(".ctx-menu", { timeout: 5000 });
    const workOpt = page.locator(".ctx-menu .ctx-item[data-state='WORKING']");
    check("clicking the status dot opens the status menu with state options", await workOpt.isVisible());
    // Choosing an option must actually POST /api/overrideState (the "menu does nothing" bug-class).
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/overrideState") && r.request().method() === "POST", { timeout: 8000 }),
      workOpt.click(),
    ]);
    check("choosing a status POSTs /api/overrideState and the server answers ok:true", resp.ok() && (await resp.json()).ok === true);
    check("the menu closes after choosing", (await page.locator(".ctx-menu").count()) === 0);
  });

  // ── CHAT-FIRST: the chat REPLACES the terminal; landing focuses the chat input (pane A) ──
  await section("Chat-first: selecting a task lands on the full-width chat (pane A), terminal hidden", async () => {
    await selectRow("gzip"); // a normal Claude task → pane A = chat, solo (pane B collapsed)
    const chatFocused = await waitFor(async () =>
      page.evaluate(() => {
        const S = (window as any).cockpitS;
        const aActive = (document.querySelector('.pane-tabs[data-tabs="A"] .tab.active') as HTMLElement | null)?.dataset.mode;
        return aActive === "chat" && S.focused === "A";
      }), 5000);
    check("landing on a Claude task focuses the chat (pane A)", chatFocused);
    const solo = await waitFor(async () =>
      page.evaluate(() => document.querySelector("#pane-B")?.classList.contains("pane-collapsed") === true), 5000);
    check("the chat replaces the terminal — pane B is collapsed (terminal lives in the drawer)", solo);
    const hasInput = await page.locator("#answer-input").count();
    check("the chat has a message input", hasInput > 0);
  });

  // ── CHAT view: SOUL-voiced gist feed + collapsible terminal drawer ──────────
  await section("Chat view: SOUL gist feed renders, and Ctrl+G t toggles the terminal drawer", async () => {
    await selectRow("gzip"); // a normal Claude task → pane A defaults to Chat
    const chatActive = await waitFor(async () =>
      page.evaluate(() => (document.querySelector('.pane-tabs[data-tabs="A"] .tab.active') as HTMLElement | null)?.dataset.mode === "chat"), 5000);
    check("a Claude task lands with pane A = Chat", chatActive);
    // beats arrive either on the item (tick cache) or via the on-demand /api/gist fetch
    const beats = await waitFor(async () => (await page.locator("#chat-gist .gist-beat").count()) > 0, 8000);
    check("the chat feed renders SOUL-voiced gist beats", beats);
    // focus pane A, then Ctrl+G t opens the drawer and mounts the SINGLE #term-host into it
    await focusA();
    await master("t");
    const opened = await waitFor(async () =>
      page.evaluate(() => {
        const d = document.getElementById("chat-term-drawer");
        const host = document.getElementById("term-host");
        return !!d && d.dataset.open === "true" && !!host && d.contains(host);
      }), 6000);
    check("Ctrl+G t opens the drawer and re-parents the single terminal into it", opened);
    await master("t"); // toggle back
    const closed = await waitFor(async () =>
      page.evaluate(() => document.getElementById("chat-term-drawer")?.dataset.open === "false"), 5000);
    check("Ctrl+G t again collapses the drawer", closed);
  });

  // ── keyboard navigation ──────────────────────────────────────────────────
  await section("Plain ↑/↓ move the selection — even from inside the terminal", async () => {
    await selectRow("gzip"); // terminal-focused by default (terminal-first)
    await sleep(300);
    const base = await selIndex();
    check("a row is selected", base >= 0);
    await page.keyboard.press("ArrowDown");
    check("ArrowDown moves the selection (not swallowed by the terminal)", await waitFor(async () => (await selIndex()) !== base, 3000), `from ${base}`);
    const afterDown = await selIndex();
    await page.keyboard.press("ArrowUp");
    check("ArrowUp moves the selection back", await waitFor(async () => (await selIndex()) !== afterDown, 3000), `from ${afterDown}`);
  });

  await section("Master j / k also move the selection", async () => {
    await selectRow("importer");
    await sleep(300);
    const base = await selIndex();
    await master("j");
    check("Ctrl+G j moves the selection", await waitFor(async () => (await selIndex()) !== base, 3000), `from ${base}`);
    const afterJ = await selIndex();
    await master("k");
    check("Ctrl+G k moves the selection back", await waitFor(async () => (await selIndex()) !== afterJ, 3000), `from ${afterJ}`);
  });

  await section("Bare action keys are GATED (no Ctrl+G → no action)", async () => {
    await selectRow("importer"); // review task → focus A (answer box) — bare letters must be literal
    await focusA();
    await clearAnswerInput();
    await page.keyboard.press("h"); // old DIRECT priority-feedback key
    await sleep(400);
    check("bare h does NOT open the reason input", !(await page.locator("#reason-input").isVisible().catch(() => false)));
    const sel = (await qstate()).queue.find((q: any) => /importer/i.test(q.session.title));
    await page.keyboard.press("p"); // old DIRECT pin key
    await sleep(400);
    check("bare p does NOT pin the selected task", sessById(await qstate(), sel?.session_id)?.pinned !== 1);
    await clearAnswerInput();
  });

  await section("Clicking a queue row selects it", async () => {
    const i = await selectRow("importer");
    check("clicking the importer row selects it", i >= 0 && (await selIndex()) === i);
  });

  // ── answering ──────────────────────────────────────────────────────────────
  await section("Answer via hotkey (y) consumes the item", async () => {
    const i = await selectRow("gzip");
    const before = await qstate();
    const item = before.queue[i];
    check("gzip row is answerable (y/n)", !!item && !!item.answer_options);
    await focusA(); // terminal-first: bare keys go to the terminal — answer from the (empty) box
    await clearAnswerInput();
    await page.keyboard.press("y");
    const ok = await waitFor(async () => !(await qstate()).queue.some((q: any) => q.id === item.id), 5000);
    check("pressing y sends the answer and the item leaves Up Next", ok);
  });

  await section("Answer via clicking a candidate answer consumes the item", async () => {
    const i = await selectRow("duplicate");
    const before = await qstate();
    const item = before.queue[i];
    // candidate answers render for the selected answerable card
    const haveChip = await page.locator(".ans[data-opt]").count();
    check("candidate answers render for the multi-choice card", haveChip > 0, `answers=${haveChip}`);
    if (haveChip > 0) {
      await page.locator('.ans[data-opt="0"]').click();
      const ok = await waitFor(async () => !(await qstate()).queue.some((q: any) => q.id === item.id), 5000);
      check("clicking answer A (recommended) sends it and the item leaves Up Next", ok);
    }
  });

  await section("Global task-queue stats panel renders in the Overview", async () => {
    await focusA(); // pane A → overview of the selected card; the panel sits at its bottom
    const qp = await page.evaluate(() => {
      const p = document.querySelector("#pane-A .queue-pulse");
      if (!p) return null;
      return {
        tiles: p.querySelectorAll(".qp-tile").length,
        svg: !!p.querySelector(".qp-chart svg.qp-svg"),
        lines: p.querySelectorAll(".qp-svg path.qp-line").length,
        area: !!p.querySelector(".qp-svg path.qp-area"),
        hovers: p.querySelectorAll(".qp-svg rect.qp-hov").length,
        chartH: (p.querySelector(".qp-chart") as HTMLElement | null)?.offsetHeight || 0,
        dnD: p.querySelector(".qp-svg path.qp-line.dn")?.getAttribute("d") || "",
        stD: p.querySelector(".qp-svg path.qp-line.st")?.getAttribute("d") || "",
        ymax: p.querySelector(".qp-ymax")?.textContent || "",
        hovTitle: p.querySelector(".qp-svg rect.qp-hov title")?.textContent || "",
        tagsRow: !!p.querySelector(".qp-tags"),
        tagChips: p.querySelectorAll(".qp-tags .qp-tag").length,
      };
    });
    check("panel present under the session stats", !!qp);
    check("4 stat tiles (queued / done·1h / started·1h / done·24h)", qp?.tiles === 4, `tiles=${qp?.tiles}`);
    check("smoothed SVG trend chart renders (2 lines + area fill)", qp?.svg === true && qp?.lines === 2 && qp?.area === true, `lines=${qp?.lines}`);
    check("24 per-hour hover strips carry the raw counts", qp?.hovers === 24, `hovers=${qp?.hovers}`);
    check("chart is tall (~120px, not the old 56px strip)", (qp?.chartH || 0) >= 100, `h=${qp?.chartH}`);
    // The smoothing/Catmull-Rom math is inline in renderQueuePulse (not headlessly importable),
    // so its shape is pinned HERE against the real renderer: a curve through 24 hourly points is
    // exactly one M + 23 cubic segments, for BOTH lines, whatever the data values are.
    const segs = (d: string) => (d.match(/C/g) || []).length;
    check("both curves are M + 23 cubic segments through the 24 points",
      /^M/.test(qp?.dnD || "") && segs(qp?.dnD || "") === 23 && /^M/.test(qp?.stD || "") && segs(qp?.stD || "") === 23,
      `dn=${segs(qp?.dnD || "")} st=${segs(qp?.stD || "")}`);
    check("y-axis peak label renders ('peak ~N/h')", /^peak ~[\d.]+\/h$/.test(qp?.ymax || ""), `ymax=${qp?.ymax}`);
    check("hover tooltip carries the RAW per-hour counts (HH:00 — N completed · N started · N answered)",
      /^\d{2}:00 — \d+ completed · \d+ started · \d+ answered$/.test(qp?.hovTitle || ""), `title=${qp?.hovTitle}`);
    // 'done by tag' chips ⇔ doneByTag data: no chip row when the data is empty (the demo seed
    // has no completions, so today this asserts ABSENCE — no phantom 'untagged 0'); otherwise the
    // renderer caps REAL tags at 8 and always appends the untagged row — mirror that exactly.
    const dbt = ((await qstate())?.metrics?.throughput?.doneByTag || []) as any[];
    const hasU = dbt.some((g: any) => g.tag === "untagged");
    const expectChips = Math.min(dbt.length - (hasU ? 1 : 0), 8) + (hasU ? 1 : 0);
    check("'done by tag' chip row mirrors doneByTag (absent when empty; 8 real tags + untagged cap)",
      qp?.tagsRow === (dbt.length > 0) && qp?.tagChips === expectChips,
      `chips=${qp?.tagChips} rows=${dbt.length}`);
    // The "in queue now" tile must agree with the live /api/state queue (after the SSE refresh).
    const ok = await waitFor(async () => {
      const st = await qstate();
      const queued = await page.evaluate(() =>
        parseInt(document.querySelector("#pane-A .qp-tile.q .qp-n")?.textContent || "-1", 10));
      return queued === st.queue.filter((q: any) => !q._team).length;
    }, 5000);
    check("'in queue now' tile matches the live queue length", ok);
  });

  // ── snooze / pin / importance ──────────────────────────────────────────────
  await section("Snooze (Ctrl+G Z) sinks the item but keeps it visible", async () => {
    const i = await selectRow("test-suite");
    const item = (await qstate()).queue[i];
    await master("Z");
    const ok = await waitFor(async () => sessById(await qstate(), item.session_id)?.snooze_penalty < 0, 4000);
    check("z applies a score penalty (session.snooze_penalty < 0)", ok);
    check("snoozed item still present (not hidden)", (await qstate()).queue.some((q: any) => q.id === item.id));
  });

  await section("Rename (Ctrl+G R) opens the inline editor and sets manual_title", async () => {
    await selectRow("test-suite");
    await master("R");
    const input = page.locator(".rename-input");
    const open = await input.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
    check("Ctrl+G R opens the inline rename input on the selected session", open);
    if (open) {
      // Read the session the editor actually opened on (its host carries data-sid) — that's the
      // session selectedItem() targeted; assert the rename persists THERE (no reliance on the
      // queue order, which the demo tick can re-rank between selection and keypress).
      const targetSid = await page.evaluate(() => {
        const host = document.querySelector(".rename-input")?.closest("[data-sid]");
        return host ? Number(host.getAttribute("data-sid")) : null;
      });
      check("the editor identifies its target session", typeof targetSid === "number" && (targetSid as number) > 0);
      const name = "renamed by ctrl-g-R";
      await input.fill(name);
      await page.keyboard.press("Enter");
      check("typing a name + Enter sets manual_title on that session", await waitFor(async () => sessById(await qstate(), targetSid as number)?.manual_title === name, 4000));
      // Clean up: clear the name (empty reverts to the auto name) so the renamed headline doesn't
      // shadow this session's title for the text-matching row selection later tests rely on.
      await page.evaluate((sid: number) => fetch("/api/renameSession", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid, title: "" }) }), targetSid as number);
      check("clearing the name reverts to the auto name (manual_title null)", await waitFor(async () => !sessById(await qstate(), targetSid as number)?.manual_title, 4000));
    }
  });

  await section("Pin (Ctrl+G p) toggles + Manual importance (Ctrl+G I) overlay", async () => {
    // The master works from ANY focus (terminal, answer box, nav) — no special row needed,
    // but keep "scratch" so the pin/unpin churn doesn't disturb answerable rows.
    const tok = "scratch";
    const item = (await qstate()).queue.find((q: any) => /scratch/i.test(q.session.title));
    const pinnedNow = async () => sessById(await qstate(), item.session_id)?.pinned;
    await selectRow(tok);
    await master("p");
    check("Ctrl+G p pins the session", await waitFor(async () => (await pinnedNow()) === 1, 5000));
    // unpin — retry: togglePin flips based on the (optimistic) client state, which can briefly lag.
    let unpinned = false;
    for (let attempt = 0; attempt < 3 && !unpinned; attempt++) {
      await sleep(600);
      await selectRow(tok); // re-select (it jumped to the top when pinned)
      await master("p");
      unpinned = await waitFor(async () => (await pinnedNow()) === 0, 3000);
    }
    check("Ctrl+G p again unpins it", unpinned);

    await selectRow(tok);
    await master("I");
    const impOpen = await page.locator("#imp-overlay").waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
    check("Ctrl+G I opens the importance overlay", impOpen);
    if (impOpen) {
      await page.locator("#imp-input").fill("77");
      await page.keyboard.press("Enter");
      check("typing 77 + Enter sets manual_importance=77", await waitFor(async () => sessById(await qstate(), item.session_id)?.manual_importance === 77, 4000));
    }
  });

  await section("Priority feedback (Ctrl+G H) opens a reason box and records it", async () => {
    const i = await selectRow("importer");
    const item = (await qstate()).queue[i];
    const before = (await qstate()).learning?.examples?.length ?? 0;
    await master("Shift+H");
    check("Ctrl+G H reveals the reason input", await page.locator("#reason-input").isVisible());
    await page.locator("#reason-input").fill("blocks the prod rollout");
    await page.keyboard.press("Enter");
    const grew = await waitFor(async () => ((await qstate()).learning?.examples?.length ?? 0) >= before, 4000);
    check("submitting a reason records a training example (learning grows)", grew);
    check("the reason box closes after submit", !(await page.locator("#reason-input").isVisible().catch(() => false)));
  });

  // ── UNDO via Ctrl+Z (headline) ─────────────────────────────────────────────
  await section("Ctrl+Z undoes the last action", async () => {
    const i = await selectRow("test-suite");
    const item = (await qstate()).queue[i];
    await focusA();
    // make a clean, observable action: pin it (master p — bare keys are gated)
    await master("p");
    check("setup: pinned before undo", await waitFor(async () => sessById(await qstate(), item.session_id)?.pinned === 1, 4000));
    await ctrl("z"); // Control+z
    check("Ctrl+Z reverts the pin (session.pinned back to 0)", await waitFor(async () => sessById(await qstate(), item.session_id)?.pinned === 0, 4000));
  });

  // ── UI ZOOM (Ctrl +/-) + persistence across reload ─────────────────────────
  await section("Ctrl +/- zooms the PAGE when a non-terminal pane is focused", async () => {
    await focusA(); // focus a non-terminal pane (overview)
    const start = await uiScale();
    const tz0 = await ls("cockpit.termFontZoom");
    await ctrl("Equal"); // Ctrl+= → zoom in
    const up = await waitFor(async () => (await uiScale()) > start, 3000);
    check("Ctrl += increases the page zoom (--ui-scale grows)", up, `${start} → ${await uiScale()}`);
    check("page zoom is persisted to localStorage", parseFloat((await ls("ui_font_scale")) || "0") > 1 - 1e-9);
    const mid = await uiScale();
    await ctrl("Minus"); // Ctrl+- → zoom out
    check("Ctrl +- decreases the page zoom", await waitFor(async () => (await uiScale()) < mid, 3000));
    check("page zoom did NOT touch the terminal font (focus routing)", (await ls("cockpit.termFontZoom")) === tz0);
  });

  // ── TERMINAL: open + identity + font zoom (focus routing) ──────────────────
  await section("Open terminal (Ctrl+G t) attaches a live terminal for THIS task", async () => {
    await selectRow("importer"); // a task still in the queue (gzip/duplicate were already answered)
    await master("t");
    const mounted = await waitFor(async () => (await page.locator("#term-host .xterm").count()) > 0, 10000);
    check("an xterm terminal mounts", mounted);
    check("the terminal host is visible", await page.locator("#term-host").isVisible());
    // it received real terminal bytes (the xterm has rendered rows / a canvas)
    const hasContent = await page.evaluate(() => {
      const h = document.querySelector("#term-host .xterm");
      return !!h && (h.querySelector("canvas") != null || (h.textContent || "").length > 0);
    });
    check("the terminal rendered content (bytes streamed in)", hasContent);
  });

  await section("Selecting terminal text copies it to the clipboard", async () => {
    // The terminal is already open from the previous section and has rendered content.
    const ready = await waitFor(async () => page.evaluate(() => !!(window as any).cockpitTerm), 5000);
    check("the xterm instance is reachable for the test", ready);

    // (1) onSelectionChange FIRES and the renderer records the selected text. Do the select + both
    //     reads in ONE synchronous evaluate: xterm fires onSelectionChange synchronously inside
    //     selectAll(), so `_lastTermCopy` is set before we read it — no race with live pty output.
    const r1 = await page.evaluate(() => {
      const t = (window as any).cockpitTerm;
      (window as any)._lastTermCopy = "";
      t.clearSelection();
      t.selectAll();
      return { sel: t.getSelection() as string, recorded: (window as any)._lastTermCopy as string };
    });
    check("a terminal selection is non-empty", !!r1.sel, JSON.stringify((r1.sel || "").slice(0, 40)));
    check("onSelectionChange fired → renderer recorded EXACTLY the selected text", !!r1.sel && r1.recorded === r1.sel);

    // (2) The mouseup → execCommand("copy") path fires a clipboard write. A document `copy` listener
    //     proves it: in a `copy` event clipboardData is write-only (getData returns ""), so detect
    //     that the event FIRED — it only fires because fallbackCopy() ran execCommand("copy") on the
    //     (non-empty) terminal selection. Re-establish the selection (headless xterm mouse-drag
    //     selection is unreliable), then deliver a BARE trusted mouseup over the terminal — no
    //     mousedown, so the selection survives, and the trusted gesture grants the activation
    //     execCommand("copy") needs. This drives the real `el` mouseup handler → copyTextToClipboard.
    await page.evaluate(() => {
      (window as any).__copyFired = false;
      document.addEventListener("copy", () => { (window as any).__copyFired = true; });
    });
    const box = await page.locator("#term-xterm").boundingBox();
    // Retry the (re-select → trusted bare-mouseup) gesture: live pty output can clear the xterm
    // selection in the gap between selecting and the mouseup, so we re-select immediately before
    // each attempt and stop as soon as the copy fires.
    let copyFired = false;
    for (let i = 0; i < 12 && !copyFired; i++) {
      await page.evaluate(() => { const t = (window as any).cockpitTerm; t.clearSelection(); t.selectAll(); });
      if (box) {
        await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(40, box.height / 2));
        await page.mouse.up(); // trusted mouseup (no preceding down → selection survives)
      }
      copyFired = await page.evaluate(() => !!(window as any).__copyFired);
      if (!copyFired) await sleep(150);
    }
    check("mouseup → execCommand('copy') fired a clipboard write for the selection", copyFired);
  });

  await section("Plain-drag copy: an OSC 52 escape (what tmux mouse-mode emits) routes to the clipboard", async () => {
    // With tmux `mouse on`, a drag is consumed by tmux and makes NO xterm selection — so the
    // selection/mouseup copy can't fire. tmux instead emits an OSC 52 escape with the selected text;
    // the ClipboardAddon decodes it into our custom provider → copyTextToClipboard + recordSelection.
    // We DON'T need a real tmux here: writing the exact escape tmux sends exercises the whole browser
    // half deterministically (no flaky headless mouse-drag, no live-pty timing).
    const ready = await waitFor(async () => page.evaluate(() => !!(window as any).cockpitTerm), 5000);
    check("the xterm instance is reachable for the OSC 52 test", ready);
    check("the clipboard addon is loaded (window.ClipboardAddon present)",
      await page.evaluate(() => !!(window as any).ClipboardAddon && !!(window as any).ClipboardAddon.ClipboardAddon));

    const secret = "osc52-clip-" + Date.now();
    // The EXACT bytes tmux sends on a mouse-copy: ESC ] 52 ; <selection> ; <base64> BEL, with an
    // EMPTY selection field (verified against live tmux 3.6: `\x1b]52;;<b64>\x07`). No xterm
    // selection is created, so _lastTermCopy can ONLY change via the OSC 52 → provider path.
    await page.evaluate((sec) => {
      const t = (window as any).cockpitTerm;
      try { t.clearSelection(); } catch {}
      (window as any)._lastTermCopy = "";
      t.write("\x1b]52;;" + btoa(sec) + "\x07");
    }, secret);
    // xterm.write is async (parsed on a later frame) → poll until the provider records the text.
    const routed = await waitFor(async () => page.evaluate((sec) => (window as any)._lastTermCopy === sec, secret), 3000);
    check("OSC 52 (tmux mouse-copy) decodes through the custom provider → copyTextToClipboard", routed,
      await page.evaluate(() => (window as any)._lastTermCopy));
  });

  await section("Ctrl +/- zooms the TERMINAL font when the terminal is focused", async () => {
    await page.locator("#term-xterm").click(); // focus the terminal
    const ui0 = await uiScale();
    const tz0 = parseInt((await ls("cockpit.termFontZoom")) || "0", 10);
    await ctrl("Equal"); // Ctrl+= with terminal focused → bigger terminal text
    const bigger = await waitFor(async () => parseInt((await ls("cockpit.termFontZoom")) || "0", 10) > tz0, 3000);
    check("Ctrl += enlarges the terminal font (termFontZoom grows)", bigger, `${tz0} → ${await ls("cockpit.termFontZoom")}`);
    check("terminal zoom did NOT touch the page zoom (focus routing)", Math.abs((await uiScale()) - ui0) < 1e-9);
    const tzMid = parseInt((await ls("cockpit.termFontZoom")) || "0", 10);
    await ctrl("Minus");
    check("Ctrl +- shrinks the terminal font", await waitFor(async () => parseInt((await ls("cockpit.termFontZoom")) || "0", 10) < tzMid, 3000));
  });

  await section("Ctrl+Z is swallowed by the terminal (does NOT undo) when focused", async () => {
    // Pin a NON-answerable task (so no answer-input is around to capture keystrokes), focus the
    // terminal, press Ctrl+Z → the xterm owns the keystroke, so the pin SURVIVES. (Undo while NOT
    // in the terminal is already proven by the "Ctrl+Z undoes the last action" section above.)
    const item = (await qstate()).queue.find((q: any) => /test-suite/i.test(q.session.title));
    // Set up an UNDOABLE action deterministically via the API (a pin pushes a server-side undo op).
    await page.evaluate((sid) => fetch("/api/pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sid, pinned: true }) }), item.session_id);
    const pinned = await waitFor(async () => sessById(await qstate(), item.session_id)?.pinned === 1, 5000);
    check("setup: an undoable pin is on the stack", pinned);
    await page.locator("#term-xterm").click(); // focus the terminal
    await ctrl("z"); // must be swallowed by the xterm, NOT trigger the app's undo
    await sleep(800);
    check("Ctrl+Z inside the terminal does NOT pop the app's undo (xterm owns the keystroke)", sessById(await qstate(), item.session_id)?.pinned === 1);
    // cleanup so later sections start clean
    await page.evaluate((sid) => fetch("/api/pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sid, pinned: false }) }), item.session_id);
  });

  await section("Alt+Backspace deletes a word (re-sent as Ctrl+W's 0x17, not xterm's \\x1b\\x7f)", async () => {
    // FIX WD: the renderer intercepts Alt+Backspace and sends 0x17 (C0 ETB = the exact byte Ctrl+W
    // sends → unix word-rubout), so it deletes a word identically to Ctrl+W in every shell/claude —
    // instead of xterm's default \x1b\x7f, which some apps in the pane don't honor.
    const ready = await waitFor(async () => page.evaluate(() => !!(window as any).cockpitTerm), 5000);
    check("the xterm instance is reachable for the Alt+Backspace test", ready);
    await page.locator("#term-xterm").click(); // focus the terminal so the key reaches xterm
    await page.evaluate(() => { (window as any)._lastTermSent = ""; });
    await page.keyboard.down("Alt");
    await page.keyboard.press("Backspace");
    await page.keyboard.up("Alt");
    const sent = await waitFor(async () => page.evaluate(() => (window as any)._lastTermSent === "\x17"), 3000);
    check("Alt+Backspace → 0x17 (\\x17) sent to the pty — same as Ctrl+W (delete word)", sent,
      JSON.stringify(await page.evaluate(() => (window as any)._lastTermSent)));
  });

  await section("Desktop (Electron) inject routing: main-process Alt+Backspace → live terminal / text field", async () => {
    // FIX WD (desktop path): in the Electron app, Chromium eats Alt+Backspace before the page, so the
    // in-page handler above can't fire — main.js catches it and IPC-forwards 0x17, which the renderer's
    // routeInjectedInput() routes by focus. The IPC half can't run headless, but routeInjectedInput IS
    // the routing brain — drive it directly (window._routeInjectedInput) to prove both branches.
    const ready = await waitFor(async () => page.evaluate(() => typeof (window as any)._routeInjectedInput === "function"), 5000);
    check("routeInjectedInput is exposed for the desktop-inject path", ready);

    // (1) terminal focused → the byte goes to the live pty (same as a real Alt+Backspace would)
    await page.locator("#term-xterm").click();
    const toPty = await page.evaluate(() => {
      (window as any)._lastTermSent = "";
      (window as any)._routeInjectedInput("\x17");
      return (window as any)._lastTermSent;
    });
    check("inject with the terminal focused → 0x17 sent to the pty", toPty === "\x17", JSON.stringify(toPty));

    // (2) a text field focused → in-field word-rubout (a text box keeps native-like behavior, the pty
    //     is NOT spammed). Use a throwaway textarea (the answer box only exists for answerable tasks),
    //     seed "hello world", caret at end, inject → "hello " and nothing to the pty. One synchronous
    //     evaluate so the renderer's focus re-assert can't steal focus mid-test.
    const r = await page.evaluate(() => {
      const el = document.createElement("textarea");
      document.body.appendChild(el);
      el.value = "hello world"; el.focus(); el.selectionStart = el.selectionEnd = el.value.length;
      (window as any)._lastTermSent = "";
      (window as any)._routeInjectedInput("\x17");
      const out = { val: el.value, sentToPty: (window as any)._lastTermSent as string };
      el.remove();
      return out;
    });
    check("inject with a text field focused → word deleted in-field ('hello world' → 'hello ')", r.val === "hello ", JSON.stringify(r.val));
    check("inject with a text field focused → pty NOT spammed", r.sentToPty === "", JSON.stringify(r.sentToPty));
  });

  // ── PERSISTENCE across a hard reload (Ctrl+Shift+R) ────────────────────────
  await section("Zoom levels PERSIST across a hard reload (Ctrl+Shift+R)", async () => {
    // terminal font up 3× (terminal focused)
    await page.locator("#term-xterm").click();
    await ctrl("Equal"); await ctrl("Equal"); await ctrl("Equal");
    const tzBefore = parseInt((await ls("cockpit.termFontZoom")) || "0", 10);
    check("setup: terminal zoom raised", tzBefore > 0);
    // DETACH the terminal (master q) so page-zoom keystrokes can't be routed into it, then bring
    // pane A to overview + focus it — now Ctrl +/- unambiguously drives the PAGE zoom.
    await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
    await page.keyboard.press("q"); // master q → closeTerminal()
    await sleep(300);
    await master("o"); // pane A → overview (bare 1/2/3 are gated now)
    await focusA();
    await sleep(150);
    await ctrl("Equal"); await ctrl("Equal");
    const uiBefore = parseFloat((await ls("ui_font_scale")) || "1");
    check("setup: page zoom raised", uiBefore > 1);
    // a normal reload exercises the SAME persistence path as Ctrl+Shift+R (localStorage survives
    // both; the only difference is the HTTP cache, which doesn't hold the zoom state).
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#queue li", { timeout: 15000 });
    check("page zoom restored after reload (localStorage intact)", parseFloat((await ls("ui_font_scale")) || "1") === uiBefore);
    check("page zoom re-applied to --ui-scale after reload", Math.abs((await uiScale()) - uiBefore) < 1e-6);
    check("terminal zoom level restored after reload", parseInt((await ls("cockpit.termFontZoom")) || "0", 10) === tzBefore);
  });

  // ── TERMINAL-FIRST: byte-level pty routing (what actually reaches the session) ──
  await section("Pty routing: letters → pty, plain arrows → queue only, Shift+arrows → real arrow", async () => {
    // "scratch" is a plain FYI task → pane B = terminal, terminal-first focuses it.
    await selectRow("scratch");
    // Spy on EVERY WS frame the renderer sends (survives re-attaches: prototype-level wrap).
    await page.evaluate(() => {
      const w = window as any;
      if (!w.__wsSpy) {
        w.__wsSpy = [];
        const orig = WebSocket.prototype.send;
        WebSocket.prototype.send = function (d: any) { try { w.__wsSpy.push(String(d)); } catch {} return orig.call(this, d); };
      } else w.__wsSpy.length = 0;
    });
    const mounted = await waitFor(async () => (await page.locator("#term-host .xterm").count()) > 0, 10000);
    check("a terminal mounts for the scratch task", mounted);
    await page.locator("#term-xterm").click();
    await sleep(200);
    const ptyInput = () => page.evaluate(() =>
      ((window as any).__wsSpy as string[])
        .map((f) => { try { return JSON.parse(f); } catch { return null; } })
        .filter((m) => m && m.t === "i")
        .map((m) => m.d as string));
    // (1) FRESH LANDING (nothing typed yet): a plain arrow moves the queue selection and sends
    // NOTHING to the pty. Direction adapts: scratch can sit at either end of the queue.
    await page.evaluate(() => (((window as any).__wsSpy as string[]).length = 0));
    const base = await selIndex();
    const away = base > 0 ? "ArrowUp" : "ArrowDown";
    const back = base > 0 ? "ArrowDown" : "ArrowUp";
    await page.keyboard.press(away);
    check("fresh landing: a plain arrow moves the selection (from inside the terminal)",
      await waitFor(async () => (await selIndex()) !== base, 3000));
    check("fresh landing: the plain arrow sent NO arrow bytes to any pty",
      !(await ptyInput()).some((d) => d.includes("\x1b[B") || d.includes("\x1b[A")));
    // back to the scratch task's terminal (this explicit nav also re-arms queue mode)
    await page.keyboard.press(back);
    await waitFor(async () => (await selIndex()) === base, 3000);
    await waitFor(async () => (await page.locator("#term-host .xterm").count()) > 0, 10000);
    await page.locator("#term-xterm").click().catch(() => {});
    await sleep(200);
    // (2) a bare letter typed with the terminal focused reaches the pty
    await page.evaluate(() => (((window as any).__wsSpy as string[]).length = 0));
    await page.keyboard.press("x");
    check("a bare letter reaches the pty (terminal-first: typing goes to the session)",
      await waitFor(async () => (await ptyInput()).some((d) => d.includes("x")), 4000));
    // (3) TYPE-AWARE NAV: after typing, a plain arrow belongs to the PTY (prompt history),
    // and the queue selection stays put.
    await page.evaluate(() => (((window as any).__wsSpy as string[]).length = 0));
    await page.keyboard.press("ArrowDown");
    check("after typing: a plain ArrowDown sends a REAL arrow (\\x1b[B) to the pty",
      await waitFor(async () => (await ptyInput()).includes("\x1b[B"), 4000));
    check("after typing: the plain arrow did NOT move the queue selection", (await selIndex()) === base);
    // (4) Shift+ArrowDown still sends a real arrow (always-pty escape hatch)
    await page.evaluate(() => (((window as any).__wsSpy as string[]).length = 0));
    await page.keyboard.press("Shift+ArrowDown");
    check("Shift+ArrowDown sends a REAL plain arrow (\\x1b[B) to the pty",
      await waitFor(async () => (await ptyInput()).includes("\x1b[B"), 4000));
    const selAfter = await selIndex();
    check("Shift+ArrowDown did NOT move the queue selection", selAfter === base);
    // (5) an explicit task nav (clicking a row = selectIndex) re-arms queue mode: plain arrows
    // walk the queue again on the fresh landing.
    await selectRow("scratch");
    await waitFor(async () => (await page.locator("#term-host .xterm").count()) > 0, 10000);
    await page.locator("#term-xterm").click().catch(() => {});
    await sleep(200);
    await page.keyboard.press(away);
    check("explicit nav re-arms queue mode (plain arrow moves the selection again)",
      await waitFor(async () => (await selIndex()) !== base, 3000));
    await page.keyboard.press(back);
    await waitFor(async () => (await selIndex()) === base, 3000);
  });

  // ── TERMINAL LEAK: a reconnect must CLOSE the old socket, never stack a second live one ──
  // Regression for the "three letters for every letter I type" bug (2026-06-16): over the VPN a
  // dropped pty socket can sit HALF-OPEN (readyState still OPEN) while the renderer reconnects. If
  // openTermWs doesn't tear down the previous socket first, BOTH keep painting tmux output into the
  // same xterm (doubled/tripled echo) and each lingering server-side `tmux attach` leaks a duplicate
  // tmux client (→ size-flap / "stuck writing"). Invariant: at most ONE /api/term socket is ever
  // simultaneously OPEN for the live terminal.
  await section("Terminal reconnect closes the old socket (no doubled-output / leaked tmux client)", async () => {
    await selectRow("scratch");
    // Wait for a live /api/term socket, then tag it so we can find it again after the reconnect.
    const liveWs = await waitFor(async () => await page.evaluate(() => {
      const ws = (window as any).cockpitS?.termWs;
      if (!ws || ws.readyState !== 1 || !String(ws.url).includes("/api/term")) return false;
      (window as any).__oldWs = ws; return true;
    }), 10000);
    check("a live /api/term socket is OPEN after attaching", liveWs);
    // Simulate a HALF-OPEN drop: invoke the socket's error handler (the renderer schedules a
    // reconnect) WITHOUT closing the TCP socket — so the old one is still OPEN when the reconnect
    // fires. This is the exact the VPN failure mode behind the doubled-output bug.
    await page.evaluate(() => { const ws = (window as any).cockpitS?.termWs; if (ws && ws.onerror) ws.onerror(new Event("error")); });
    await sleep(1500); // reconnect backoff (~300ms) + connect
    const res = await page.evaluate(() => {
      const oldWs = (window as any).__oldWs;
      const cur = (window as any).cockpitS?.termWs;
      return { swapped: !!cur && cur !== oldWs, curOpen: cur ? cur.readyState : -1, oldState: oldWs ? oldWs.readyState : -1 };
    });
    check("reconnect swapped in a FRESH socket (distinct object)", res.swapped === true);
    check("the new socket is OPEN (readyState 1)", res.curOpen === 1);
    // THE REGRESSION GUARD: without close-before-reopen the old half-open socket stays OPEN (1) and
    // keeps painting tmux output into the same xterm → "three letters per letter". The fix closes it.
    check("the OLD socket was CLOSED, not left half-open feeding the xterm (readyState 2/3)",
      res.oldState === 2 || res.oldState === 3);
  });

  // ── SCROLL FIX: the wheel NEVER becomes ↑/↓ arrows (prompt-history time travel) ──
  await section("Wheel in the terminal scrolls (mouse report), never synthesizes arrows", async () => {
    await selectRow("scratch");
    const mounted = await waitFor(async () => (await page.locator("#term-host .xterm").count()) > 0, 10000);
    check("a terminal mounts for the scratch task", mounted);
    await page.locator("#term-xterm").click().catch(() => {});
    await sleep(300);
    await page.evaluate(() => (((window as any).__wsSpy as string[]).length = 0));
    // Drive the REAL wheel path (xterm's own listeners) with a few hefty notches.
    await page.evaluate(() => {
      const el = document.querySelector("#term-xterm .xterm-screen") || document.querySelector("#term-xterm .xterm");
      if (!el) return;
      const r = (el as HTMLElement).getBoundingClientRect();
      for (let i = 0; i < 3; i++)
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, deltaMode: 0, bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    });
    await sleep(400);
    const frames = await page.evaluate(() =>
      ((window as any).__wsSpy as string[])
        .map((f) => { try { return JSON.parse(f); } catch { return null; } })
        .filter((m) => m && m.t === "i")
        .map((m) => m.d as string));
    check("the wheel sent NO arrow-key bytes to the pty (no prompt-history time travel)",
      !frames.some((d) => d.includes("\x1b[A") || d.includes("\x1b[B") || d.includes("\x1bOA") || d.includes("\x1bOB")));
    // In BOTH states (healthy mouse-report or synthetic fallback) a scroll surfaces as an SGR
    // wheel report — unless xterm scrolled its own normal-buffer scrollback (also fine, 0 frames).
    check("any pty bytes from the wheel are SGR mouse reports",
      frames.every((d) => /^(\x1b\[<6[45];\d+;\d+M)+$/.test(d)));
  });

  await section("Ctrl+G L (rank lower) + Ctrl+G ? (help overlay)", async () => {
    await selectRow("importer");
    await master("Shift+L");
    check("Ctrl+G L reveals the reason input", await page.locator("#reason-input").isVisible());
    await page.keyboard.press("Escape"); // direction-only submit (FIX BB)
    await sleep(250);
    await master("?");
    const helpOpen = await waitFor(async () => page.locator("#help-overlay").isVisible(), 3000);
    check("Ctrl+G ? opens the help overlay", helpOpen);
    if (helpOpen) {
      const txt = await page.locator("#help-table").innerText().catch(() => "");
      check("help documents the terminal-first model", /TERMINAL-FIRST/i.test(txt));
      await page.keyboard.press("Escape");
      check("Esc closes the help overlay", await waitFor(async () => !(await page.locator("#help-overlay").isVisible().catch(() => false)), 3000));
    }
  });

  // ── DIFF + MERGE buttons ───────────────────────────────────────────────────
  await section("Diff view (Ctrl+G d) renders a real diff", async () => {
    await selectRow("importer");
    await focusA();
    await master("d");
    // diff2html file BLOCKS lazy-mount on scroll (IntersectionObserver), but the file-tree (.dt-file)
    // and the format toggle render immediately — assert on those so we don't depend on scroll.
    const rendered = await waitFor(
      async () => (await page.locator(".dt-file, .d2h-file-wrapper, #diff-toggle-A, #diff-toggle-B").count()) > 0,
      12000
    );
    check("pressing x renders a diff (file tree / diff blocks appear)", rendered);
  });

  await section("Detached detail window: an ACTUAL PR (kind==='pr') still defaults to Diff over html", async () => {
    // MUST run while the demo's PR card is still kind==='pr' — the diff/merge sections below
    // open its terminal, which materializes the card (kind flips to 'claude').
    const fsx = require("fs"), pathx = require("path");
    const pr = (await qstate()).queue.find((q: any) => q.session.kind === "pr");
    check("a real PR task (kind==='pr') is present", !!pr);
    if (!pr) return;
    // give the PR task its own html viz — diff must STILL win (operator's rule: actual PR → Diff)
    const slug = String(pr.session.clean_title || pr.session.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const folder = pathx.join(SRV!.vizDir, slug);
    fsx.mkdirSync(folder, { recursive: true });
    fsx.writeFileSync(pathx.join(folder, "pr-extra.html"), "<html><body>pr viz</body></html>");
    const vizUp = await waitFor(async () => {
      const s = await qstate();
      const e = ((s.sessions as any[]) || []).find((x: any) => x.row && x.row.id === pr.session.id);
      return !!(e && e.viz && e.viz.length);
    }, 25000, 500);
    check("the server state exposes the new viz for the PR task", vizUp);
    const detail = await page.context().newPage();
    try {
      await detail.goto(SRV!.base + "/?view=detail");
      await detail.evaluate((id: number) => { new BroadcastChannel("claudeos-detail").postMessage({ type: "sel", id }); }, pr.id);
      const showsDiff = await waitFor(async () =>
        detail.evaluate(() => {
          const S = (window as any).cockpitS;
          return !!S && S.panes.A === "diff" && !document.querySelector("iframe.viz-frame");
        }), 15000, 300);
      check("detail window picks the DIFF view for a real PR even though html exists", showsDiff);
      // the HTML tab is offered (the task HAS a viz) and works as a manual override
      const htmlTabShown = await detail.evaluate(() => {
        const t = document.querySelector('.pane-tabs[data-tabs="A"] .tab-html') as HTMLElement | null;
        return !!t && t.style.display !== "none";
      });
      check("the HTML tab is still offered for the PR's viz (manual override available)", htmlTabShown);
      await detail.evaluate(() => (document.querySelector('.pane-tabs[data-tabs="A"] .tab[data-mode="html"]') as HTMLElement)?.click());
      const manualHtml = await waitFor(async () => detail.evaluate(() => (window as any).cockpitS.panes.A === "html"), 5000);
      check("clicking the HTML tab manually switches the PR's detail window to the html view", manualHtml);
    } finally { try { await detail.close(); } catch {} }
  });

  await section("Diff-view merge: header ⇲ Merge button + bare X (the advertised key) both work", async () => {
    // MUST run before the section below, which actually merges the demo's only PR item.
    const st = await qstate();
    const prItem = st.queue.find((q: any) => q.session.kind === "pr");
    check("a PR task is present", !!prItem);
    if (!prItem) return;
    await page.evaluate((title: string) => {
      const lis = Array.from(document.querySelectorAll("#queue li")) as HTMLElement[];
      const i = lis.findIndex((li) => (li.textContent || "").includes(title.slice(0, 24)));
      if (i >= 0) lis[i].click();
    }, String(prItem.session.title));
    await sleep(400); // STANDARD LAYOUT: PR tasks land Overview | Terminal now → switch B to diff
    await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
    await page.keyboard.press("d"); // master d = focused pane (B, terminal-first) → diff
    await sleep(400);
    // 1. the header renders a REAL clickable Merge button (the old <kbd>X</kbd> hint was dead UI)
    const btn = page.locator(".diff-merge-btn").first();
    check("diff header renders a clickable ⇲ Merge button for a PR item", (await btn.count()) > 0);
    await btn.click();
    const viaClick = await waitFor(async () => await page.locator("#merge-overlay").isVisible(), 4000);
    check("clicking ⇲ Merge opens the merge confirmation overlay", viaClick);
    if (viaClick) { await page.keyboard.press("Escape"); await sleep(200); }
    // 2. bare X while the diff pane is focused (exactly what the header hint advertises)
    await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
    await page.keyboard.press("ArrowRight"); // master → = focusPane("B") = the diff pane
    await sleep(150);
    await page.keyboard.press("Shift+X");
    const viaKey = await waitFor(async () => await page.locator("#merge-overlay").isVisible(), 4000);
    check("bare X with the diff pane focused opens the merge confirmation overlay", viaKey);
    if (viaKey) { await page.keyboard.press("Escape"); await sleep(200); }
  });

  await section("Diff expand-context: clicking the arrows reveals more of the file (GitHub-style)", async () => {
    // pane B still shows the PR diff from the previous section; consumer_guide.md is changed
    // MID-file in the sandbox repo, so expansion has ~53 hidden context lines to reveal.
    const block = page.locator('.diff-file-block[data-path="consumer_guide.md"]').first();
    const bar = block.locator('.de-btn[data-act="all"]').first();
    const mounted = await waitFor(async () => (await bar.count()) > 0, 10000);
    check("expand-context bars render on a mounted file block", mounted);
    if (!mounted) return;
    const rowsBefore = await block.locator("tr").count();
    await bar.click();
    const grew = await waitFor(async () => (await block.locator("tr").count()) > rowsBefore + 30, 10000);
    check("clicking '↕ whole file' actually mounts the rest of the file as context", grew);
    const flipped = await waitFor(async () => /whole file shown/i.test(await block.innerText().catch(() => "")), 5000);
    check("the expand bar flips to 'whole file shown' once fully expanded", flipped);
  });

  await section("Diff expand-context: +25 STEP via hunk-header click, auto-flip at file edges", async () => {
    // Re-open the PR diff so the previous section's whole-file expansion resets to default -U3
    // (a fresh patch render clears the per-file context map).
    await selectRow("importer");
    await sleep(300);
    const st = await qstate();
    const prItem = st.queue.find((q: any) => q.session.kind === "pr");
    check("the PR task is still present (runs before the merge section)", !!prItem);
    if (!prItem) return;
    await page.evaluate((title: string) => {
      const lis = Array.from(document.querySelectorAll("#queue li")) as HTMLElement[];
      const i = lis.findIndex((li) => (li.textContent || "").includes(title.slice(0, 24)));
      if (i >= 0) lis[i].click();
    }, String(prItem.session.title));
    await sleep(400);
    await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
    await page.keyboard.press("d"); // master d → focused pane (B) shows a FRESHLY fetched diff
    const block = page.locator('.diff-file-block[data-path="consumer_guide.md"]').first();
    const stepBtn = block.locator('.de-btn[data-act="step"]');
    const reset = await waitFor(async () => (await stepBtn.count()) > 0, 10000);
    check("re-rendering the diff resets the file to default context (step buttons are back)", reset);
    if (!reset) return;
    const hunkMarked = await waitFor(async () => (await block.locator(".d2h-info.de-hunk").count()) > 0, 4000);
    check("hunk headers (@@ rows) are marked clickable (de-hunk)", hunkMarked);
    const rows0 = await block.locator("tr").count();
    await block.locator(".d2h-info").first().click(); // hunk-header click = the same +25 step
    const grew = await waitFor(async () => (await block.locator("tr").count()) > rows0 + 30, 10000);
    check("clicking a hunk header reveals ~25 more context lines (+25 step path)", grew);
    if (!grew) return;
    const partialText = await block.innerText().catch(() => "");
    check("a PARTIAL expand keeps the expand buttons (no premature 'whole file shown')",
      !/whole file shown/i.test(partialText) && (await block.locator('.de-btn[data-act="step"]').count()) > 0);
    // two more +25 steps: ctx 3→28→53 covers all 60 guide lines; the NEXT (identical) fetch
    // must flip the bars via the unchanged-response heuristic — NOT the whole-file button.
    const rows1 = await block.locator("tr").count();
    await block.locator('.de-btn[data-act="step"]').first().click();
    const grew2 = await waitFor(async () => (await block.locator("tr").count()) > rows1 + 2, 10000);
    check("a second +25 step reaches the file edges (rows grow to the full file)", grew2);
    await block.locator('.de-btn[data-act="step"]').first().click();
    const flipped2 = await waitFor(async () => /whole file shown/i.test(await block.innerText().catch(() => "")), 5000);
    check("an UNCHANGED wider fetch flips to 'whole file shown' (edges-reached heuristic)", flipped2);
  });

  await section("Merge button (X) opens confirm + completes (demo-safe)", async () => {
    const st = await qstate();
    const prItem = st.queue.find((q: any) => q.session.pr_number);
    check("a PR task is present to merge", !!prItem);
    if (prItem) {
      await selectRow(String(prItem.session.title).split(" ").find((w: string) => w.length > 4)?.toLowerCase() || "retry");
      await master("Shift+X");
      const overlay = await waitFor(async () => await page.locator("#merge-overlay").isVisible(), 4000);
      check("Ctrl+G X opens the merge confirmation overlay", overlay);
      if (overlay) {
        // Confirm: the overlay now STAYS OPEN to show the ⏳→✅/❌ merge result (doMerge →
        // showMergeResult). A second Enter/Esc dismisses it. (Demo merge is GH-guarded → ❌.)
        await page.keyboard.press("Enter"); // confirm → run merge, render result in place
        const resultShown = await waitFor(
          async () => /Merged|Merge failed|Press/i.test(await page.locator("#merge-body").innerText().catch(() => "")),
          8000
        );
        check("confirming runs the merge and shows a result in the overlay (no crash)", resultShown);
        await page.keyboard.press("Enter"); // dismiss the result
        check("dismissing the result closes the overlay", await waitFor(async () => !(await page.locator("#merge-overlay").isVisible().catch(() => false)), 5000));
      }
    }
  });

  // ── master key sequence ────────────────────────────────────────────────────
  await section("Master key (Ctrl+G then d) switches the focused pane to Diff", async () => {
    await selectRow("importer");
    await focusA();
    await page.keyboard.down("Control"); await page.keyboard.press("g"); await page.keyboard.up("Control");
    await page.keyboard.press("d");
    // scope to pane A (the FOCUSED pane) so this proves master-d put the diff THERE — not that a
    // diff merely exists somewhere from the earlier `x` test.
    const showsDiff = await waitFor(async () => (await page.locator("#pane-A-body .dt-file, #pane-A-body .d2h-file-wrapper").count()) > 0, 8000);
    check("Ctrl+G d shows a diff in the focused pane (A)", showsDiff);
  });

  // \u2500\u2500 STANDARD LAYOUT regression guards (operator request 2026-06-11): every explicit nav lands
  //    Overview (A) | Terminal (B); manual choices and pre-existing html must never leak in. \u2500\u2500
  /** Click a queue row by (partial) session title \u2014 explicit nav, like selectRow but exact-item. */
  const selectByTitle = async (title: string) => {
    await page.evaluate((t: string) => {
      const lis = Array.from(document.querySelectorAll("#queue li")) as HTMLElement[];
      const i = lis.findIndex((li) => (li.textContent || "").includes(t.slice(0, 24)));
      if (i >= 0) lis[i].click();
    }, title);
    await sleep(400);
  };
  /** A plain (non-PR, non-importer) queue task still alive this late in the suite. */
  const plainTask = async () => {
    const s = await qstate();
    return s.queue.find((q: any) => q.session.kind !== "pr" && !(q.session.title || "").includes("importer"));
  };

  await section("Standard layout: a manual pane choice never leaks into the next task", async () => {
    const other = await plainTask();
    check("a plain second task is present", !!other);
    if (!other) return;
    await selectByTitle(other.session.title); // make the next selectRow a FRESH landing
    await selectRow("importer"); // review task \u2014 diffable, terminal-first focuses pane B
    await master("d"); // manual: focused pane (B) \u2192 diff
    const manualSet = await waitFor(async () =>
      page.evaluate(() => { const S = (window as any).cockpitS; return S.panes.B === "diff" && S.paneManual.B === true; }), 5000);
    check("Ctrl+G d manually switches pane B to diff (paneManual.B set)", manualSet);
    await selectByTitle(other.session.title); // explicit nav to a DIFFERENT task
    const reset = await waitFor(async () =>
      page.evaluate(() => {
        const S = (window as any).cockpitS;
        return S.panes.A === "chat" && S.panes.B === "terminal" && !S.paneManual.A && !S.paneManual.B;
      }), 5000);
    check("the next task lands on the default Chat | Terminal (manual flags cleared)", reset);
  });

  await section("Standard layout: pre-existing html never hijacks pane A; a NEW html still auto-opens", async () => {
    const fsx = require("fs"), pathx = require("path");
    const target = await plainTask();
    check("a plain target task is present", !!target);
    if (!target) return;
    // 1. while looking at ANOTHER task, the target task gets an html visualization on disk
    await selectRow("importer");
    const slug = String(target.session.clean_title || target.session.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const folder = pathx.join(SRV!.vizDir, slug);
    fsx.mkdirSync(folder, { recursive: true });
    fsx.writeFileSync(pathx.join(folder, "report.html"), "<html><body>pre-existing viz</body></html>");
    // server-side viz cache is ~10s + a tick \u2014 wait until the CLIENT's state has the viz, so the
    // landing below genuinely exercises the "html already existed on arrival" path (a server-only
    // wait would let the assert pass vacuously while the renderer still sees viz=[]).
    const vizSeen = await waitFor(async () =>
      page.evaluate((sid: number) => {
        const S = (window as any).cockpitS;
        const e = ((S.state && S.state.sessions) || []).find((x: any) => x.row && x.row.id === sid);
        return !!(e && e.viz && e.viz.length === 1);
      }, target.session.id), 25000, 500);
    check("the renderer's state picks up the viz for the task", vizSeen);
    // 2. NOW navigate to the task \u2192 the PRE-EXISTING html must NOT hijack pane A
    await selectByTitle(target.session.title);
    await sleep(800); // give a render tick a chance to (wrongly) auto-flip
    const landed = await page.evaluate(() => {
      const S = (window as any).cockpitS;
      const htmlTab = document.querySelector('.pane-tabs[data-tabs="A"] .tab-html') as HTMLElement | null;
      return { paneA: S.panes.A, tabShown: !!htmlTab && htmlTab.style.display !== "none" };
    });
    check("landing on a task with a pre-existing html keeps pane A = Chat (default)", landed.paneA === "chat", JSON.stringify(landed));
    check("\u2026while the HTML tab IS offered (the renderer does know about the viz)", landed.tabShown, JSON.stringify(landed));
    // 3. a NEW html written WHILE the task is in view must still auto-open (auto_html_on_viz)
    fsx.writeFileSync(pathx.join(folder, "report2.html"), "<html><body>new viz</body></html>");
    const flipped = await waitFor(async () =>
      page.evaluate(() => (window as any).cockpitS.panes.A === "html"), 30000, 500);
    check("a NEW html written while viewing the task auto-opens in pane A", flipped);
    // restore the default view so later sections aren't affected
    await master("o");
    await sleep(200);
  });

  await section("Standard layout: master chord survives DOM-focus limbo (terminal pane focused, xterm blurred)", async () => {
    const other = await plainTask();
    if (other) await selectByTitle(other.session.title); // terminal-first: pane B terminal focused
    // simulate the post-overlay gap: S.focused stays on the terminal pane but the xterm loses DOM focus
    await page.evaluate(() => { try { (document.activeElement as HTMLElement)?.blur?.(); } catch {} });
    await master("?");
    const helpOpen = await waitFor(async () => page.locator("#help-overlay").isVisible(), 4000);
    check("Ctrl+G ? still works when the xterm does not hold DOM focus", helpOpen);
    if (helpOpen) { await page.keyboard.press("Escape"); await sleep(200); }
  });

  await section("Session search: \u2315 button opens the overlay, typing filters, Esc closes", async () => {
    // Seed a fixture transcript into the demo sandbox search dir so a query has something to hit.
    const fsx = require("fs"), pathx = require("path");
    const dir = pathx.join(pathx.resolve(__dirname, "../.."), "data", "demo_session_search_projects", "-ui-e2e");
    fsx.mkdirSync(dir, { recursive: true });
    fsx.writeFileSync(pathx.join(dir, "ui-e2e-uuid-1.jsonl"), [
      JSON.stringify({ type: "mode", sessionId: "ui-e2e-uuid-1" }),
      JSON.stringify({ type: "user", cwd: "/tmp/ui-e2e", message: { content: "Profile the spectrogram pipeline hotspots" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "Spectrogram profiling" }),
    ].join("\n"));

    await page.click("#search-bar");
    const opened = await waitFor(async () => (await page.locator("#search-overlay").isVisible()), 3000);
    check("clicking the Tasks-header search bar opens the search overlay", opened);
    check("the search bar sits in the Tasks header, left of \u21bb", await page.evaluate(() => { const h = document.querySelector(".queue-h2"); const kids = h ? Array.from(h.children).map((c) => c.id) : []; return kids.indexOf("search-bar") >= 0 && kids.indexOf("search-bar") < kids.indexOf("reprioritize-btn"); }));
    check("search input takes keyboard focus",
      await waitFor(async () => page.evaluate(() => document.activeElement?.id === "search-input"), 3000));

    await page.fill("#search-input", "spectrogram");
    await page.locator("#search-input").dispatchEvent("input"); // fill() bypasses key events; fire the filter
    const gotHit = await waitFor(async () =>
      (await page.locator("#search-results .search-card").count()) > 0 &&
      /Spectrogram profiling/.test((await page.locator("#search-results").textContent()) || ""), 5000);
    check("typing live-filters: the seeded session appears as a card", gotHit);

    // Enter in DEMO = semantic endpoint \u2192 keyword-fallback (offline). Status must say so, results stay.
    await page.keyboard.press("Enter");
    const fellBack = await waitFor(async () => /keyword|demo/i.test((await page.locator("#search-status").textContent()) || ""), 5000);
    check("Enter (smart rank) in demo degrades gracefully + says why", fellBack);
    check("results survive the semantic pass", (await page.locator("#search-results .search-card").count()) > 0);

    await page.keyboard.press("Escape");
    const closed = await waitFor(async () => !(await page.locator("#search-overlay").isVisible()), 3000);
    check("Esc closes the search overlay", closed);
  });

  await section("Session search: clicking a result resumes it into the roster", async () => {
    await page.click("#search-bar");
    await page.fill("#search-input", "spectrogram");
    await page.locator("#search-input").dispatchEvent("input");
    await waitFor(async () => (await page.locator("#search-results .search-card").count()) > 0, 5000);
    const before = sessOf(await qstate()).length;
    await page.locator("#search-results .search-card").first().click();
    const landed = await waitFor(async () => {
      const st = await qstate();
      return sessOf(st).some((s: any) => /Spectrogram profiling/.test(s.row?.title || s.row?.clean_title || ""));
    }, 6000);
    check("clicked result is upserted into the roster (visible in /api/state)", landed);
    const closedAfterOpen = await waitFor(async () => !(await page.locator("#search-overlay").isVisible()), 3000);
    check("overlay closes after opening a result", closedAfterOpen);
    check("roster grew by the resumed session", sessOf(await qstate()).length >= before);
  });

  await section("Detached detail window: html outranks a non-PR diff (REVIEW_DIFF without a real PR)", async () => {
    const fsx = require("fs"), pathx = require("path");
    // the importer review task: a big local diff, triaged REVIEW_DIFF, but NOT an actual pull request
    const rev = (await qstate()).queue.find((q: any) => /importer/i.test(q.session.title || ""));
    check("the importer review task is present and is NOT an actual PR", !!rev && rev.session.kind !== "pr");
    if (!rev) return;
    const slug = String(rev.session.clean_title || rev.session.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const folder = pathx.join(SRV!.vizDir, slug);
    fsx.mkdirSync(folder, { recursive: true });
    fsx.writeFileSync(pathx.join(folder, "spectro.html"), "<html><body>spectrograms</body></html>");
    const vizUp = await waitFor(async () => {
      const s = await qstate();
      const e = ((s.sessions as any[]) || []).find((x: any) => x.row && x.row.id === rev.session.id);
      return !!(e && e.viz && e.viz.length);
    }, 25000, 500);
    check("the server state exposes the new viz for the review task", vizUp);
    const detail = await page.context().newPage();
    try {
      await detail.goto(SRV!.base + "/?view=detail");
      // drive the mirrored selection deterministically (what the main window broadcasts on nav)
      await detail.evaluate((id: number) => { new BroadcastChannel("claudeos-detail").postMessage({ type: "sel", id }); }, rev.id);
      const showsHtml = await waitFor(async () =>
        detail.evaluate(() => {
          const S = (window as any).cockpitS;
          return !!S && S.panes.A === "html" && !!document.querySelector("iframe.viz-frame");
        }), 15000, 300);
      check("detail window shows the HTML view (diff is not a PR → html wins)", showsHtml);
      // the Diff tab still works as a manual override
      await detail.evaluate(() => (document.querySelector('.pane-tabs[data-tabs="A"] .tab[data-mode="diff"]') as HTMLElement)?.click());
      const manualDiff = await waitFor(async () => detail.evaluate(() => (window as any).cockpitS.panes.A === "diff"), 5000);
      check("clicking the Diff tab still manually switches the detail window to the diff", manualDiff);
    } finally { try { await detail.close(); } catch {} }
  });

  await section("Detached detail window: a virtual-top / roster-only selection (unresolvable item id) still resolves by session id", async () => {
    // REPRODUCES the operator bug: when a session is opened/taken-over (no actionable queue item),
    // the main window selects a VIRTUAL item whose id exists only in its own queue. broadcastSel
    // sends that id + the session id. The detail window must resolve via the SESSION id, not fall
    // back to queue[0] (the "my PR never shows up in the detached window" report).
    const st = await qstate();
    const pr = (st.queue as any[]).find((q: any) => q.session.kind === "pr") || (st.queue as any[]).find((q: any) => q.session.pr_number);
    const target = pr || (st.queue as any[]).find((q: any) => /importer/i.test(q.session.title || ""));
    check("a diffable target session exists", !!target);
    if (!target) return;
    const sid = target.session.id;
    // queue[0] must be a DIFFERENT session, else the test can't distinguish the fix from the bug
    const head = (st.queue as any[])[0];
    check("queue[0] is a different session than the target (test is discriminating)", head.session.id !== sid);
    const detail = await page.context().newPage();
    try {
      await detail.goto(SRV!.base + "/?view=detail");
      // a virtual item id the detail window's server queue can NOT contain, paired with the real
      // session id — exactly what broadcastSel emits for a roster-only / opened session.
      await detail.evaluate((s: number) => {
        new BroadcastChannel("claudeos-detail").postMessage({ type: "sel", id: -1_000_000 - s, sessionId: s });
      }, sid);
      const resolved = await waitFor(async () =>
        detail.evaluate((s: number) => {
          const S = (window as any).cockpitS;
          if (!S) return false;
          // the resolved session id: a real queue item found by session id, OR a synthesized
          // roster item (stable id = -1_000_000 - sessionId).
          const it = (S.state.queue || []).find((x: any) => x.id === S.selItemId);
          const rid = it ? it.session.id : (S.selItemId != null && S.selItemId <= -1_000_000 ? -1_000_000 - S.selItemId : null);
          return rid === s; // the detail window is showing the TARGET session…
        }, sid), 15000, 300);
      check("the detail window resolves the selection to the target session (not queue[0])", resolved);
      // and concretely it did NOT silently fall back to queue[0]'s session
      const notHead = await detail.evaluate((h: number) => {
        const S = (window as any).cockpitS;
        const it = (S.state.queue || []).find((x: any) => x.id === S.selItemId);
        return !it || it.session.id !== h;
      }, head.session.id);
      check("the detail window did NOT fall back to queue[0]", notHead);

      // ROSTER-ONLY (synth) case: a session in the roster with NO queue item. The detail window
      // must SYNTHESIZE its item (negative stable id) AND every consumer (selectedItem → Merge /
      // Viewed / HTML) must target THAT session, not queue[0]. This is where the HIGH bugs lived.
      const rosterOnlyId = await detail.evaluate(() => {
        const S = (window as any).cockpitS;
        const qSids = new Set((S.state.queue || []).map((x: any) => x.session_id));
        const e = (S.state.sessions || []).find((s: any) => s.row && !qSids.has(s.row.id));
        return e ? e.row.id : null;
      });
      check("a roster-only session (no queue item) exists in the demo", rosterOnlyId != null);
      if (rosterOnlyId != null) {
        await detail.evaluate((s: number) => {
          new BroadcastChannel("claudeos-detail").postMessage({ type: "sel", id: -1_000_000 - s, sessionId: s });
        }, rosterOnlyId);
        const synthOk = await waitFor(async () =>
          detail.evaluate((s: number) => {
            const S = (window as any).cockpitS;
            // synth item: not in the queue, stable negative id, and selectedItem() (which Merge /
            // Viewed / HTML all call) must resolve to the roster session — never queue[0].
            const inQueue = (S.state.queue || []).some((x: any) => x.id === S.selItemId);
            return !inQueue && S.selItemId === -1_000_000 - s;
          }, rosterOnlyId), 15000, 300);
        check("a roster-only selection synthesizes an item targeting the right session (Merge/Viewed/HTML safe)", synthOk);
      }
    } finally { try { await detail.close(); } catch {} }
  });

  // ── ＋ NEW-TERMINAL launcher (upper-left) ───────────────────────────────────
  await section("＋ new-terminal button opens a repo picker and launches into the chosen repo", async () => {
    const btn = page.locator("#new-term-btn");
    check("the ＋ new-terminal button is rendered in the header", await btn.isVisible());
    // Menu starts hidden; clicking the ＋ reveals it.
    check("the repo menu starts hidden", await page.locator("#new-term-menu").isHidden());
    await btn.click();
    check("clicking ＋ opens the repo menu", await page.locator("#new-term-menu").isVisible());
    // The menu lists exactly the repos from config.sessions_repos (one <li> each, plus the header).
    const repos = (await qstate()).config?.sessions_repos || [];
    const rowCount = await page.locator("#new-term-menu li .repo-name").count();
    check("the menu lists one row per configured repo", rowCount === repos.length, `dom=${rowCount} cfg=${repos.length}`);
    // Clicking a repo actually fires POST /api/newSession with THAT repo (the "button does nothing"
    // bug-class) and returns a real session id.
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/newSession") && r.request().method() === "POST", { timeout: 8000 }),
      page.locator("#new-term-menu li .repo-name").first().click(),
    ]);
    const body = await resp.json().catch(() => ({}));
    check("picking a repo launches a new Claude session (ok + sessionId)", body.ok === true && typeof body.sessionId === "number");
    check("the repo menu closes after picking", await waitFor(async () => await page.locator("#new-term-menu").isHidden(), 4000));
  });

  // ── ✓ Archive button vs a PINNED task (the reported bug) ────────────────────
  await section("✓ Archive completes a PINNED task instead of just advancing", async () => {
    // Repro of "archive not working — it just drops me to the next item": the renderer used to
    // early-return (advance without archiving) when the selected task was pinned. Archive is an
    // EXPLICIT action, so a pin must not block it.
    const item = (await qstate()).queue.find((q: any) => /scratch/i.test(q.session.title));
    check("setup: a scratch task exists to archive", !!item);
    if (!item) return;
    const sid = item.session_id as number;
    await page.evaluate((s: number) => fetch("/api/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: s, pinned: true }) }), sid);
    check("setup: the task is pinned", await waitFor(async () => sessById(await qstate(), sid)?.pinned === 1, 4000));
    await selectRow("scratch"); // select the (now top-pinned) row so Archive acts on it
    await page.locator("#archive-btn").click();
    // completeTask marks it completed → allSessions excludes it → it leaves the queue AND the roster.
    check("clicking ✓ Archive on a pinned task archives it (session leaves the queue + roster)", await waitFor(async () => sessById(await qstate(), sid) == null, 5000));
  });
}

(async () => {
  let browser: Browser | null = null; // chromium.launch() is `any` (required late), so assignment widens — narrow back:
  let code = 2;
  try {
    console.log("booting isolated demo server…");
    SRV = await startDemoServer();
    console.log("demo server up on", SRV.base);
    browser = (await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-gl=swiftshader"] })) as Browser;
    const ctx = await browser!.newContext({ viewport: { width: 1400, height: 900 } });
    page = await ctx.newPage();
    page.setDefaultTimeout(4000); // a missing element should fail an assertion fast, not hang 30s
    page.on("pageerror", (e) => console.error("  [page error]", String(e).slice(0, 160)));
    await run();
    code = summary();
  } catch (e) {
    console.error("\nE2E UI ERROR:", e);
    if (SRV) console.error("\n--- server log tail ---\n" + SRV.log().slice(-1500));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { if (SRV) await SRV.stop(); } catch {}
  }
  process.exit(code);
})();
