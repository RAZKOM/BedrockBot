#!/usr/bin/env bash
# Update the Mac's checkout to the pushed main and restart the Realm bot (deploy/mac/README.md).
# Run on the Mac: bash ~/BedrockBot/deploy/mac/update.sh   (or from the dev machine: pnpm deploy:mac)
set -euo pipefail
export PATH="$HOME/.local/node/bin:$HOME/Library/Python/3.9/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$HOME/BedrockBot"
before=$(git rev-parse --short HEAD)
git pull -q
after=$(git rev-parse --short HEAD)
pnpm install --frozen-lockfile --reporter=silent
# raknet-native has no darwin-arm64 prebuild; rebuild when a fresh install dropped the binary.
RN=node_modules/.pnpm/raknet-native@1.2.3/node_modules/raknet-native
if [ -d "$RN" ] && [ ! -f "$RN/build/Release/node-raknet.node" ]; then
  (cd "$RN" && node ../../../cmake-js@6.3.2/node_modules/cmake-js/bin/cmake-js compile >/dev/null)
fi
pnpm --filter bot test --reporter=dot 2>&1 | grep -E "Tests|failed" | tail -n 2
label="gui/$(id -u)/com.bedrockbot.realm"
if launchctl print "$label" >/dev/null 2>&1; then
  launchctl kickstart -k "$label"
  echo "restarted com.bedrockbot.realm on $after (was $before)"
else
  echo "updated to $after (was $before); no launch agent loaded"
fi
