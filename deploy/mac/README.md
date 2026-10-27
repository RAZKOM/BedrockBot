# Running the Realm AFK bot on a Mac server

The bot is plain Node. It needs no Minecraft install: the Realm path is NetherNet over `werift`
(pure JavaScript), and the only native module (`raknet-native`, for local BDS) ships macOS builds.
Measured footprint on BDS and the Realm: about 300 MB RSS, a few percent of one core.

Everything below is per user account, needs no `sudo`, and touches only `~/.local`, `~/BedrockBot`,
`~/.bedrockbot` and `~/Library/LaunchAgents`.

## One-time setup (done for `chat` on 2026-10-29)

```sh
# Node 24 + pnpm under ~/.local (no Homebrew needed)
V=v24.22.1; mkdir -p ~/.local && cd ~/.local
curl -fsSL -o node.tgz "https://nodejs.org/dist/$V/node-$V-darwin-arm64.tar.gz"
tar xzf node.tgz && mv "node-$V-darwin-arm64" node && rm node.tgz
export PATH=~/.local/node/bin:$PATH
corepack enable --install-directory ~/.local/node/bin

# code: a bare repo the dev machine pushes to, and a checkout of it
git init --bare ~/bedrockbot.git          # on the dev machine: git push chat:bedrockbot.git main
git clone ~/bedrockbot.git ~/BedrockBot
cd ~/BedrockBot && pnpm install --frozen-lockfile && pnpm --filter bot test
grep -c _triedDefaultHost bot/node_modules/bedrock-protocol/src/nethernet/signalling.js   # 2 = patched

# raknet-native ships prebuilds for darwin-x64 only, so on Apple silicon build it once from source
# (about 2 min). The Realm path is NetherNet-only and never loads it; local BDS targets (and
# their ping) do. Repeat after any pnpm install that recreates node_modules.
pip3 install --user cmake && export PATH=~/Library/Python/3.9/bin:$PATH
cd ~/BedrockBot/node_modules/.pnpm/raknet-native@1.2.3/node_modules/raknet-native
node ../../../cmake-js@6.3.2/node_modules/cmake-js/bin/cmake-js compile   # -> build/Release/node-raknet.node
cd ~/BedrockBot
```

Config lives outside the repo in `~/.bedrockbot/config.json` (names only, never tokens):

```json
{
  "realm": { "realmName": "Your Realm", "accountName": "bot", "record": false },
  "owners": ["YourGamertag"],
  "home": [100, 64, -50],
  "nudgeInterval": 240,
  "healthPort": 9465,
  "logDir": "/Users/USER/.bedrockbot/logs",
  "metricsInterval": 60,
  "reconnect": true,
  "logLevel": "info"
}
```

## Sign in once (you, interactively)

Only one client per Microsoft account: stop any other bot on that account first, or the new login
kicks the old one.

```sh
ssh chat
export PATH=~/.local/node/bin:$PATH
cd ~/BedrockBot/bot && node src/index.ts --task afk --target realm
```

Open the printed `https://www.microsoft.com/link` page, enter the code, sign in with the bot's
account. When the log says `spawned as <gamertag>`, press Ctrl+C. Tokens are now cached in
`~/.bedrockbot/profiles` and refresh by themselves (8 h of reconnects verified without a prompt).

## Keep it running with launchd

```sh
sed "s#/Users/USER#$HOME#g" ~/BedrockBot/deploy/mac/com.bedrockbot.realm.plist > ~/Library/LaunchAgents/com.bedrockbot.realm.plist
mkdir -p ~/.bedrockbot/logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bedrockbot.realm.plist
```

Useful afterwards:

```sh
launchctl print gui/$(id -u)/com.bedrockbot.realm | head -20     # state, pid, last exit code
tail -f ~/.bedrockbot/logs/realm-console.log                      # the bot's log
curl -s http://127.0.0.1:9465/metrics                             # metrics (from the Mac itself)
tail -n 5 ~/.bedrockbot/logs/disconnects.jsonl                    # every session end with its reason
launchctl kickstart -k gui/$(id -u)/com.bedrockbot.realm          # restart now
launchctl bootout gui/$(id -u)/com.bedrockbot.realm               # stop and unload
```

`KeepAlive` restarts the bot after any exit, 60 s apart. On a game update the Realm refuses the
old client (exit 3, `kicked: outdated_client`), so the agent keeps retrying once a minute until a
bumped build is pushed; the update notifier whispers the owners meanwhile.

## Updating the code

From the dev machine, after every merge that passed the gate:

```sh
pnpm deploy:mac        # = git push chat:bedrockbot.git main && ssh chat "cd ~/BedrockBot && git pull -q && bash deploy/mac/update.sh"
```

`update.sh` pulls, installs, rebuilds raknet-native if needed, runs the unit tests and restarts the
launch agent (the bot is off the Realm for about 10 s). Features that are off by default are turned on
in `~/.bedrockbot/config.json`, e.g. `"tasks": { "afk": { "guard": 16, "fleeHealth": 8 } }`.

Keep the Realm on a commit that passed the full BDS gate (docs/versions.md); the dev machine's
worktree habit applies here too: push only what is green.

## Notes

- The Mac must not sleep (`pmset -g`: `sleep 0`); `chat` has sleep prevented already.
- Logs: `realm-console.log` grows slowly (one line per nudge, about 400 B/min); rotate it with
  `newsyslog` or truncate when it bothers you. `--no-record` keeps the 1 GB/day packet capture off.
- `--health-port` binds 127.0.0.1 only; use `ssh -L 9465:127.0.0.1:9465 chat` to read it remotely.
- Control panel on the LAN (docs/panel.md): with no change the panel is at `http://127.0.0.1:9465/` on
  the Mac itself (same port, nothing else changes). To use it from a phone or another machine on the
  home network, add to `~/.bedrockbot/config.json`:
  `"panel": { "host": "0.0.0.0", "port": 9466, "token": "<24 random characters>" }` (a fresh
  `pnpm config:init --print | grep '"token"'` shows a freshly generated one), then `launchctl kickstart -k
  gui/$(id -u)/com.bedrockbot.realm`. A separate port keeps `curl http://127.0.0.1:9465/metrics`
  token-free; `!panel` in game prints the URLs (`http://<mac LAN address>:9466/`). Open
  `http://<address>:9466/?token=<token>` once per browser (a cookie remembers it). macOS may ask to
  allow incoming connections for `node`: allow it. The panel can make the bot walk, fight and quit:
  keep it on the LAN, never port-forward it on the router, and change the token if it leaks.
