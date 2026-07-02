#!/usr/bin/env bash
# Reliable ClaudeOS (re)deploy. Builds, then starts BOTH servers as systemd --user transient
# units (claudeos-real / claudeos-demo) so they are owned by systemd — NOT this shell's process
# group — and SURVIVE the deploy command returning (the previous `nohup … &` children were reaped
# by the agent harness's process-group cleanup, leaving a stale old process holding the port).
# Finally VERIFY the served build hash == HEAD (and the cache-bust ?v stamp), so a stale deploy is
# impossible to miss. Falls back to setsid+nohup if systemd --user is unavailable.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
REAL_PORT="${COCKPIT_REAL_PORT:-4317}"
DEMO_PORT="${COCKPIT_DEMO_PORT:-4318}"
LOG_DIR="${ROOT}/.run"
mkdir -p "$LOG_DIR"

# Portable listener helpers — work on macOS AND Linux (no `ss`/`fuser`, which macOS lacks). Kill by
# PORT so we reliably reap the real listener no matter how it was launched — in particular the
# launchd/absolute-path node (`/opt/homebrew/bin/node .../dist/server/server.js`), which a
# cmdline-pattern pkill for `node dist/...` can never match.
listeners() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null; }
kill_port()  { local p; p=$(listeners "$1"); [ -n "$p" ] && kill -9 $p 2>/dev/null || true; }

echo "==> building"
npm run build >/dev/null 2>&1 || { echo "BUILD FAILED"; npm run build 2>&1 | grep -iE 'error' | head; exit 1; }

HEAD="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
OLD_REAL_PID="$(listeners "$REAL_PORT" | head -1)"

have_systemd=0
have_launchd=0
# On macOS the real server is supervised by a launchd KeepAlive job (absolute-path node). Detect it so
# we redeploy by KICKING launchd (it kills the old instance + relaunches from the plist against the
# freshly built dist/) instead of fighting its respawn with pkill. Override the label with
# CLAUDEOS_LAUNCHD_LABEL; a fresh clone with no plist falls through to the plain nohup path.
LAUNCHD_REAL="${CLAUDEOS_LAUNCHD_LABEL:-se.biosonic.claudeos.server}"
GUI="gui/$(id -u)"
if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  have_systemd=1
elif command -v launchctl >/dev/null 2>&1 && launchctl print "${GUI}/${LAUNCHD_REAL}" >/dev/null 2>&1; then
  have_launchd=1
fi

echo "==> stopping previous servers"
if [ "$have_systemd" = 1 ]; then
  systemctl --user stop claudeos-real claudeos-demo >/dev/null 2>&1 || true
  systemctl --user reset-failed claudeos-real claudeos-demo >/dev/null 2>&1 || true
  kill_port "$REAL_PORT"; kill_port "$DEMO_PORT"
  pkill -9 -f 'dist/server/server.js' 2>/dev/null || true
elif [ "$have_launchd" = 1 ]; then
  # Real = launchd KeepAlive. `kickstart -k` kills the running instance and relaunches it from the
  # plist — the launchd-native redeploy (a plain pkill would just get respawned with old code). Demo
  # is NOT launchd-managed → reap it by port. Don't broad-pkill here: it would kill the real server we
  # just kicked and trigger a second respawn racing our verify.
  echo "    real: launchctl kickstart -k ${LAUNCHD_REAL}"
  launchctl kickstart -k "${GUI}/${LAUNCHD_REAL}" 2>/dev/null || true
  kill_port "$DEMO_PORT"
else
  # No supervisor: kill by port (reliable, any launch method) + broadened cmdline pattern. The pattern
  # is now the SCRIPT path (`dist/server/server.js`), a substring of BOTH the relative `node dist/...`
  # and the absolute `/opt/homebrew/bin/node /Users/Josef/claudeos/dist/...` command lines.
  kill_port "$REAL_PORT"; kill_port "$DEMO_PORT"
  pkill -9 -f 'dist/server/server.js' 2>/dev/null || true
fi
for _ in $(seq 1 25); do
  { [ -n "$(listeners "$REAL_PORT")" ] || [ -n "$(listeners "$DEMO_PORT")" ]; } || break
  # launchd re-binds the real port itself (KeepAlive) — only wait for it to be free in the paths
  # where WE are responsible for restarting it.
  [ "$have_launchd" = 1 ] && [ -z "$(listeners "$DEMO_PORT")" ] && break
  sleep 0.2
done

sup='setsid+nohup'; [ "$have_systemd" = 1 ] && sup='systemd --user'; [ "$have_launchd" = 1 ] && sup="launchd(${LAUNCHD_REAL})+nohup demo"
echo "==> starting fresh: real :${REAL_PORT}, demo :${DEMO_PORT} (${sup})"
if [ "$have_systemd" = 1 ]; then
  # systemd --user gives a MINIMAL PATH that omits ~/.local/bin — where `claude` lives. Without it,
  # the server's `claude agents --json` (session→pane mapping + bg-agent liveness) silently returns
  # nothing and EVERY session falls back to read-only. Pass an explicit PATH including ~/.local/bin.
  SRV_PATH="$HOME/.local/bin:$HOME/bin:$PATH"
  # PERSISTENT UNITS FIRST (2026-06-11): the prod-port-guard fix installed real unit FILES
  # (~/.config/systemd/user/claudeos-{real,demo}.service, pinned to the canonical checkout).
  # `systemd-run --unit=<name>` REFUSES to create a transient unit shadowing an existing unit
  # file — and with 2>/dev/null that failure was invisible: every deploy stopped the cockpit
  # and never started it again. If the unit file exists, start it; transient is the fallback.
  if systemctl --user cat claudeos-real >/dev/null 2>&1; then
    systemctl --user start claudeos-real claudeos-demo || echo "    (systemctl start failed: $?)"
  else
  # Restart=always: with ~6 sessions all running restart/test:ui/pkill against one repo, a stray
  # `pkill -9 -f 'node dist/server/server.js'` (or a crash/OOM) used to kill the server and nothing
  # brought it back — the cockpit just stayed down. Self-heal: systemd respawns it within RestartSec.
  # A legitimate redeploy still works because we `systemctl stop` first (a stopped unit isn't restarted).
  # CPUWeight/IOWeight keep the cockpit responsive when the host is saturated by the agent fleet
  # (load ~40 on 32 cores) — cgroup-based, always permitted for --user units, mirrors the property
  # baked into the persistent unit files so both start paths get the same priority boost.
  systemd-run --user --unit=claudeos-real --collect \
    --property=Restart=always --property=RestartSec=1 \
    --property=CPUWeight=10000 --property=IOWeight=10000 \
    --working-directory="$ROOT" --setenv=PATH="$SRV_PATH" --setenv=COCKPIT_PORT="$REAL_PORT" \
    node dist/server/server.js >/dev/null 2>&1
  systemd-run --user --unit=claudeos-demo --collect \
    --property=Restart=always --property=RestartSec=1 \
    --working-directory="$ROOT" --setenv=PATH="$SRV_PATH" --setenv=COCKPIT_DEMO=1 --setenv=COCKPIT_PORT="$DEMO_PORT" \
    node dist/server/server.js >/dev/null 2>&1
  fi
elif [ "$have_launchd" = 1 ]; then
  # Real was already relaunched by `launchctl kickstart -k` above (launchd owns it). Only the demo is
  # ours to start — detached via nohup (macOS has no `setsid`). Prepend ~/.local/bin so the demo's
  # `claude` calls resolve, matching the PATH launchd hands the real server via the plist.
  COCKPIT_DEMO=1 COCKPIT_PORT="${DEMO_PORT}" PATH="$HOME/.local/bin:$HOME/bin:$PATH" \
    nohup node dist/server/server.js >"${LOG_DIR}/demo.log" 2>&1 &
else
  # macOS has no `setsid`; `nohup … &` already detaches from the controlling terminal there.
  SETSID="$(command -v setsid || true)"
  COCKPIT_PORT="${REAL_PORT}" $SETSID nohup node dist/server/server.js >"${LOG_DIR}/real.log" 2>&1 &
  COCKPIT_DEMO=1 COCKPIT_PORT="${DEMO_PORT}" $SETSID nohup node dist/server/server.js >"${LOG_DIR}/demo.log" 2>&1 &
fi

rc_real=000
for _ in $(seq 1 40); do
  rc_real=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${REAL_PORT}/" 2>/dev/null || echo 000)
  [ "$rc_real" = "200" ] && break
  sleep 0.25
done
rc_demo=000
for _ in $(seq 1 20); do
  rc_demo=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${DEMO_PORT}/" 2>/dev/null || echo 000)
  [ "$rc_demo" = "200" ] && break
  sleep 0.25
done

BUILD=$(curl -s "http://localhost:${REAL_PORT}/api/state" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["config"]["build"])' 2>/dev/null || echo '?')
VSTAMP=$(curl -s "http://localhost:${REAL_PORT}/" 2>/dev/null | grep -o 'renderer.js?v=[a-f0-9]*' | head -1)
PID=$(listeners "$REAL_PORT" | head -1)

echo "==> verify"
fresh='?'; [ -n "$PID" ] && { [ "$PID" != "$OLD_REAL_PID" ] && fresh='fresh' || fresh='STALE'; }
echo "    real :${REAL_PORT} http ${rc_real} | demo :${DEMO_PORT} http ${rc_demo} | listen-pid ${PID:-?} (was ${OLD_REAL_PID:-none}, ${fresh})"
echo "    HEAD=${HEAD}  build-marker=${BUILD}  ${VSTAMP}"
# A clean deploy means: real serving 200, its build marker == HEAD, AND the listener is a NEW process
# (pid changed) — i.e. we actually replaced the stale server rather than leaving it holding the port.
if [ "$BUILD" = "$HEAD" ] && [ "$rc_real" = "200" ] && [ -n "$PID" ] && [ "$PID" != "$OLD_REAL_PID" ]; then
  echo "==> OK: deployed — build marker matches HEAD (${HEAD}); real=${rc_real} demo=${rc_demo}; fresh listen-pid ${PID}."
  exit 0
else
  echo "==> WARNING: deploy did NOT take (marker=${BUILD} vs HEAD=${HEAD}, real=${rc_real}, demo=${rc_demo}, pid=${PID:-none} was=${OLD_REAL_PID:-none})."
  exit 2
fi
