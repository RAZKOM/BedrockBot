#!/usr/bin/env bash
# The test host's side of scripts/mac-run.mjs (docs/runbook.md "Tests on the Mac (Track I1)"). Started over ssh in
# the host's home directory with its settings as environment variables (MR_*, set by mac-run.mjs):
#   bash <test dir>/checkouts/<name>/scripts/mac/remote.sh run | bds <words...> | status
# run: wait while the live bot runs a `!test` series or the load is high, take a slot, install when asked, run the
# command (MR_CMD, base64) in the checkout at nice 10 in its own process group, with HOME pointed at a sandbox; when
# the ssh connection goes away (stdin closes) the whole group is killed. The exit code is the command's.
set -u

REAL_HOME="$HOME"
T="$REAL_HOME/$MR_DIR"
CO="$REAL_HOME/$MR_CO"
SLOTS="${MR_SLOTS:-2}"
MAX_LOAD="${MR_MAX_LOAD:-7}"
WORKERS="${MR_WORKERS:-4}"
NICE="${MR_NICE:-10}"
PY_BIN=""
for d in "$REAL_HOME"/Library/Python/*/bin; do [ -x "$d/cmake" ] && PY_BIN="$PY_BIN:$d"; done
export PATH="$REAL_HOME/$MR_NODE:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin$PY_BIN"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_HOME="$T/corepack"
export DOCKER_CONFIG="$REAL_HOME/.docker"   # keep Docker Desktop's context when HOME moves to the sandbox
export BEDROCKBOT_TEST_ROOT="$T"
export BEDROCKBOT_LIVE_HOME="$REAL_HOME"     # live.mjs reads the live bot's log there (read only)
LIVE="$CO/scripts/mac/live.mjs"
mkdir -p "$T/locks" "$T/homes" "$T/data" "$T/store"

say() { printf 'mac-run[%s]: %s\n' "$(hostname -s)" "$*" >&2; }
# a sleep the watchdog's TERM interrupts at once (a trap waits for a foreground command, not for `wait`)
nap() { sleep "$1" & wait $!; }
decode() { printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D; }

# ---- the wait rule and the slots ---------------------------------------------------------------------------------

SLOT=""
release() { [ -n "$SLOT" ] && rm -rf "$T/locks/slot$SLOT"; SLOT=""; }

try_slot() {
  local i owner pid
  for i in $(seq 1 "$SLOTS"); do
    if mkdir "$T/locks/slot$i" 2>/dev/null; then
      printf '%s %s %s\n' "$$" "$MR_NAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$T/locks/slot$i/owner"
      SLOT="$i"
      return 0
    fi
    owner=$(cat "$T/locks/slot$i/owner" 2>/dev/null || true)
    pid="${owner%% *}"
    # a slot whose holder is gone (killed host side, reboot) is freed; one without an owner file yet is being taken
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$T/locks/slot$i"; fi
  done
  return 1
}

holders() { cat "$T"/locks/slot*/owner 2>/dev/null | awk '{print $2 " since " $3}' | paste -sd ',' - ; }

acquire() {
  local said="" msg rc t0
  t0=$(date +%s)
  while :; do
    if [ "${MR_WAIT:-1}" = 1 ]; then
      msg=$(node "$LIVE" check --max-load "$MAX_LOAD"); rc=$?
      if [ "$rc" -ne 0 ]; then
        [ "$msg" != "$said" ] && say "waiting: $msg"
        said="$msg"; nap 20; continue
      fi
    fi
    try_slot && break
    msg="all $SLOTS slots taken ($(holders))"
    [ "$msg" != "$said" ] && say "waiting: $msg"
    said="$msg"; nap 10
  done
  [ -n "$said" ] && say "waited $(( $(date +%s) - t0 )) s"
  return 0
}

# ---- install -----------------------------------------------------------------------------------------------------

# raknet-native has no prebuild for Apple silicon, so it is built from source (cmake from pip, as deploy/update.sh does).
# RakNet casts the double -1 (UNSET_TIME_US) to an unsigned 64-bit time in CCRakNetSlidingWindow::ShouldSendACKs: undefined
# behaviour, and Apple clang 21 compiles the whole function to `brk #1`, so the first ACK of a RakNet connection kills the
# process with SIGTRAP. -fno-strict-float-cast-overflow keeps the hardware's conversion (the cast saturates to 0 on arm64,
# both sides of the comparison alike), which is what the code means.
RAKNET_FLAGS="-O3 -DNDEBUG -fno-strict-float-cast-overflow"
build_raknet() {
  local rn cj
  rn=$(ls -d "$CO"/node_modules/.pnpm/raknet-native@*/node_modules/raknet-native 2>/dev/null | head -n 1)
  [ -n "$rn" ] || return 0
  if node -e 'require(process.argv[1])' "$rn" >/dev/null 2>&1 \
     && { [ ! -d "$rn/build/Release" ] || grep -q -- '-fno-strict-float-cast-overflow' "$rn/build/CMakeCache.txt" 2>/dev/null; }; then
    return 0   # it loads from a prebuild (no build/), or from our own build with the flag
  fi
  say "building raknet-native for $(uname -m) ($RAKNET_FLAGS)"
  cj=$(ls -d "$CO"/node_modules/.pnpm/cmake-js@*/node_modules/cmake-js/bin/cmake-js 2>/dev/null | head -n 1)
  rm -rf "$rn/build"
  # (the real HOME: pip installed cmake under ~/Library/Python, which the sandbox HOME of a run hides)
  (cd "$rn" && HOME="$REAL_HOME" nice -n "$NICE" node "$cj" compile "--CDCMAKE_CXX_FLAGS_RELEASE=$RAKNET_FLAGS" >/dev/null) \
    || { say "raknet-native did not build (needs cmake): the e2e suites cannot connect"; return 1; }
}

install_deps() {
  local t0
  t0=$(date +%s)
  say "pnpm install (store $MR_DIR/store)"
  (cd "$CO" && nice -n "$NICE" pnpm install --frozen-lockfile --store-dir "$T/store" --reporter=append-only) || return 1
  build_raknet || return 1
  say "install done in $(( $(date +%s) - t0 )) s"
}

# ---- modes -------------------------------------------------------------------------------------------------------

mode="${1:-}"; shift || true
case "$mode" in
  run)
    PGID=""; WD=""; MON=""
    set -m   # background jobs get their own process groups: the command's can be ended as a whole (vitest, bots, workers)
    cleanup() {
      trap - EXIT HUP INT TERM PIPE
      if [ -n "$PGID" ]; then
        kill -TERM -- "-$PGID" 2>/dev/null
        ( sleep 5; kill -KILL -- "-$PGID" 2>/dev/null ) > /dev/null 2>&1 &
      fi
      [ -n "$WD" ] && kill "$WD" 2>/dev/null
      [ -n "$MON" ] && kill "$MON" 2>/dev/null
      release
    }
    trap 'cleanup; exit 129' HUP PIPE
    trap 'cleanup; exit 130' INT TERM
    trap cleanup EXIT
    # the watchdog, from the start (also while waiting for a slot): mac-run keeps ssh's stdin open; EOF means the
    # caller went away (Ctrl+C, a dropped connection), and this script ends itself and the command's group
    exec 3<&0
    ( cat <&3 > /dev/null; kill -TERM $$ 2>/dev/null ) &
    WD=$!
    disown "$WD"   # no "Terminated" job report when it is ended
    exec 3<&-
    # the sandbox home: nothing a run (or its install: cmake-js, corepack) does lands in the real home or ~/.bedrockbot
    export HOME="$T/homes/$MR_NAME"
    mkdir -p "$HOME"
    if [ "${MR_LOCK:-1}" = 1 ]; then acquire; fi
    if [ "${MR_INSTALL:-0}" = 1 ] || [ ! -f "$CO/node_modules/.modules.yaml" ]; then
      if [ "${MR_LOCK:-1}" = 1 ] || [ "${MR_INSTALL:-0}" = 1 ]; then install_deps || exit 1; fi
    elif [ "${MR_LOCK:-1}" = 1 ]; then
      build_raknet || exit 1   # a copy installed before the RakNet fix gets the fixed build
    fi
    CMD=$(decode "${MR_CMD:-}")
    export BEDROCKBOT_MAX_WORKERS="$WORKERS"   # the benches (bot/scripts/workers.ts)
    export VITEST_MAX_WORKERS="$WORKERS"       # vitest reads it itself
    [ -d "$T/private/cave" ] && export CAVE_FIXTURE_DIR="$T/private/cave"
    while IFS= read -r kv; do [ -n "$kv" ] && export "$kv"; done <<< "$(decode "${MR_ENV:-}")"
    t0=$(date +%s)
    printf '%s start %s slot=%s load=%s cmd=%s\n' "$(date -u +%FT%TZ)" "$MR_NAME" "${SLOT:--}" "$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')" "$CMD" >> "$T/runs.log"
    say "running in $MR_CO (nice $NICE, $WORKERS workers${SLOT:+, slot $SLOT of $SLOTS}): $CMD"
    POLICY=""
    # --as-live: the live bot's launchd agent is ProcessType Background (PRI 4): background QoS, the efficiency cores
    [ "${MR_AS_LIVE:-0}" = 1 ] && command -v taskpolicy > /dev/null && POLICY="taskpolicy -b"
    ( cd "$CO" && exec $POLICY nice -n "$NICE" bash -c "$CMD" ) < /dev/null &
    PGID=$!
    # a `!test` series that starts during the run: lower the run to nice 20 and say so (once)
    if [ "${MR_LOCK:-1}" = 1 ]; then
      ( said=0; while sleep 30; do
          if ! node "$LIVE" check --max-load 1000 > /dev/null 2>&1 && [ "$said" = 0 ]; then
            renice 20 -g "$PGID" > /dev/null 2>&1; say "a !test series started on the live bot: this run continues at nice 20"; said=1
          fi
        done ) &
      MON=$!
      disown "$MON"
    fi
    wait "$PGID"; rc=$?
    PGID=""
    dt=$(( $(date +%s) - t0 ))
    printf '%s end %s rc=%s %ss load=%s\n' "$(date -u +%FT%TZ)" "$MR_NAME" "$rc" "$dt" "$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')" >> "$T/runs.log"
    say "exit $rc after $dt s"
    exit "$rc"
    ;;
  bds)
    export HOME="$T/homes/$MR_NAME"
    mkdir -p "$HOME"
    if [ "${MR_INSTALL:-0}" = 1 ] || [ ! -f "$CO/node_modules/.modules.yaml" ]; then install_deps || exit 1; fi
    cd "$CO" && exec node scripts/mac/bds.mjs "$@"
    ;;
  status)
    say "slots ($SLOTS): $(holders || true)"
    say "load: $(sysctl -n vm.loadavg)"
    node "$LIVE" check --max-load "$MAX_LOAD" | sed 's/^/mac-run: live bot: /' >&2
    say "checkouts: $(ls "$T/checkouts" 2>/dev/null | paste -sd ' ' -)"
    docker ps --filter name=bds- --format '{{.Names}} {{.Status}}' 2>/dev/null | sed 's/^/mac-run: container /' >&2
    tail -n 5 "$T/runs.log" 2>/dev/null | sed 's/^/mac-run: last runs: /' >&2
    exit 0
    ;;
  *)
    say "unknown mode ${mode}"; exit 2
    ;;
esac
