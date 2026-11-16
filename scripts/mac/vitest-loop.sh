#!/usr/bin/env bash
# Track I1 (decision 0089): run a vitest selection again and again on the test host and count the runs a lost worker
# ended (V8's `Check failed`, `Worker exited unexpectedly`) apart from the runs a test failed. One line a run, a summary.
#
#   node scripts/mac-run.mjs -- bash scripts/mac/vitest-loop.sh <seconds> [vitest filters...]
#   node scripts/mac-run.mjs -- BEDROCKBOT_WASM_CODE_GC=on bash scripts/mac/vitest-loop.sh 780 nav-r nav-worker
#
# No filters: the whole unit suite. A run starts only while the time is not up; the last one may run past it.
set -u
secs="${1:-780}"; shift || true
cd "$(dirname "$0")/../../bot" || exit 2
export NO_COLOR=1 FORCE_COLOR=0   # plain summary lines to read
log="${HOME:-/tmp}/vitest-loop.$$.log"
end=$((SECONDS + secs)); i=0; lost=0; failed=0; clean=0
while [ "$SECONDS" -lt "$end" ]; do
  i=$((i + 1)); t0=$SECONDS
  ./node_modules/.bin/vitest run --project unit --reporter=dot "$@" > "$log.raw" 2>&1; rc=$?
  sed $'s/\x1b\\[[0-9;]*m//g' "$log.raw" > "$log"
  checks=$(grep -c 'Check failed' "$log"); exited=$(grep -c 'Worker exited unexpectedly' "$log")
  tests=$(grep -E '^ +Tests ' "$log" | tr -s ' ' | sed 's/^ //'); files=$(grep -E '^ +Test Files ' "$log" | tr -s ' ' | sed 's/^ //')
  if [ "$rc" -eq 0 ]; then clean=$((clean + 1)); kind=clean
  elif grep -qE '^ +Tests .*failed' "$log"; then failed=$((failed + 1)); kind=failed
  elif [ "$checks" -gt 0 ] || [ "$exited" -gt 0 ]; then lost=$((lost + 1)); kind=lost
  else failed=$((failed + 1)); kind=other; fi
  echo "run $i rc=$rc $kind checks=$checks exited=$exited s=$((SECONDS - t0)) load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}') | $files | $tests"
  if [ "$kind" != clean ]; then grep -E 'Check failed|exited unexpectedly|FAIL ' "$log" | head -n 6 | sed 's/^/    /'; fi
done
rm -f "$log" "$log.raw"
echo "summary runs=$i clean=$clean lost=$lost failed=$failed BEDROCKBOT_WASM_CODE_GC=${BEDROCKBOT_WASM_CODE_GC:-}"
[ "$lost" -eq 0 ] && [ "$failed" -eq 0 ]
