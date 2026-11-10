#!/usr/bin/env bash
# Update the server's checkout to the pushed main and restart the Realm bot (deploy/README.md).
# Run on the server: bash ~/BedrockBot/deploy/update.sh   (or from the dev machine: pnpm deploy:server)
# Restarts the launchd agent on macOS or the systemd user unit on Linux; on other systems it only updates.
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/Library/Python/3.9/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$(dirname "$0")/.."
before=$(git rev-parse --short HEAD)
git pull -q
after=$(git rev-parse --short HEAD)
pnpm install --frozen-lockfile --reporter=silent
# raknet-native (local BDS targets only; the Realm path never loads it) has no prebuild for some platforms,
# for example Apple silicon: rebuild it from source when it does not load, as a fresh install drops the binary.
RN=node_modules/.pnpm/raknet-native@1.2.3/node_modules/raknet-native
# Apple clang turns a double-to-unsigned cast in its ACK code into a trap unless -fno-strict-float-cast-overflow (Track I1): every
# local RakNet connection died with SIGTRAP at its first ACK. Rebuilt when it does not load or was built without the flag.
if [ -d "$RN" ] && { ! node -e 'require(process.argv[1])' "$PWD/$RN" >/dev/null 2>&1 || { [ "$(uname -s)" = Darwin ] && ! grep -q -- '-fno-strict-float-cast-overflow' "$RN/build/CMakeCache.txt" 2>/dev/null; }; }; then
  (cd "$RN" && node ../../../cmake-js@6.3.2/node_modules/cmake-js/bin/cmake-js compile --CDCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG -fno-strict-float-cast-overflow" >/dev/null) \
    || echo "warning: raknet-native did not build (needs cmake); the Realm bot does not use it, local BDS targets do"
fi
# low priority and 4 workers, so the running bot keeps its ticks during the checks (Track I1: an uncapped run cost it
# up to 64 ticks in 5 s for 40 s)
nice -n 10 pnpm --filter bot lint >/dev/null   # eslint + tsc; set -e stops the update on a failure
# (a failing test's name and its assertion are shown too: a failed update has to say which test stopped it)
VITEST_MAX_WORKERS=4 nice -n 10 pnpm --filter bot test --reporter=dot 2>&1 | grep -E "FAIL|AssertionError|Tests|failed" | tail -n 12
case "$(uname -s)" in
  Darwin)
    label="gui/$(id -u)/com.bedrockbot.realm"
    if launchctl print "$label" >/dev/null 2>&1; then
      launchctl kickstart -k "$label"
      echo "restarted com.bedrockbot.realm on $after (was $before)"
    else
      echo "updated to $after (was $before); no launch agent loaded"
    fi
    ;;
  Linux)
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"   # a non-interactive ssh has none
    if systemctl --user cat bedrockbot.service >/dev/null 2>&1; then
      systemctl --user restart bedrockbot.service
      echo "restarted bedrockbot.service on $after (was $before)"
    else
      echo "updated to $after (was $before); no systemd user unit bedrockbot.service installed"
    fi
    ;;
  *)
    echo "updated to $after (was $before); restart the bot yourself on this system"
    ;;
esac
