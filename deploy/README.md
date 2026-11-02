# Running the Realm AFK bot on a server

The bot is plain Node. It needs no Minecraft install: the Realm path is NetherNet over `werift`
(pure JavaScript), and the only native module (`raknet-native`, for local BDS) is not loaded on the Realm
path. Measured footprint on BDS and the Realm: about 300 MB RSS, a few percent of one core. Any small
macOS or Linux machine you can ssh to will do. The service runs as your user: no `sudo` is needed except
where marked.

`<host>` below is the ssh host of the server (an alias from `~/.ssh/config`, or `user@address`).

Layout in this folder:

| File | What |
|---|---|
| `update.sh` | on the server: pull, install, lint, unit tests, restart the service (launchd on macOS, systemd on Linux) |
| `launchd/com.bedrockbot.realm.plist` | the macOS launch agent |
| `systemd/bedrockbot.service` | the Linux systemd user unit (written from the unit semantics, not yet run on a Linux box: tell us what needs fixing) |
| `../scripts/deploy-server.mjs` | on the dev machine: `pnpm deploy:server` pushes main and runs `update.sh` over ssh |

## One-time setup

1. **Create the repo and the checkout on the server** (from the dev machine, in this repository):

   ```sh
   BEDROCKBOT_DEPLOY_HOST=<host> pnpm deploy:server -- --init     # bare repo ~/bedrockbot.git + checkout ~/BedrockBot
   ```

   (`BEDROCKBOT_DEPLOY_DIR` and `BEDROCKBOT_DEPLOY_REPO` change those two names; both are relative to the
   server's home. `--dry-run` prints the commands without running them.)

2. **Node 24 and pnpm** under `~/.local`, on the server (no package manager needed):

   ```sh
   V=v24.22.1; mkdir -p ~/.local && cd ~/.local
   OS=$(uname -s | tr A-Z a-z); ARCH=$(uname -m); case $ARCH in x86_64) ARCH=x64;; aarch64) ARCH=arm64;; esac
   curl -fsSL -o node.tgz "https://nodejs.org/dist/$V/node-$V-$OS-$ARCH.tar.gz"
   tar xzf node.tgz && mv "node-$V-$OS-$ARCH" node && rm node.tgz
   export PATH=~/.local/node/bin:$PATH      # add this line to your shell profile too
   corepack enable --install-directory ~/.local/node/bin
   cd ~/BedrockBot && pnpm install --frozen-lockfile && pnpm --filter bot test
   grep -c _triedDefaultHost bot/node_modules/bedrock-protocol/src/nethernet/signalling.js   # 2 = patched
   ```

3. **`raknet-native`** (local BDS targets only, never the Realm) has no prebuilt binary for some platforms,
   for example Apple silicon. `update.sh` rebuilds it from source when it does not load (about 2 minutes, needs
   `cmake`: `pip3 install --user cmake`, or your package manager). Skip it if the server only runs the Realm.

4. **Config** lives outside the repo in `~/.bedrockbot/config.json` (names only, never tokens):

   ```json
   {
     "realm": { "realmName": "Your Realm", "accountName": "bot", "record": false },
     "owners": ["YourGamertag"],
     "home": [100, 64, -50],
     "nudgeInterval": 240,
     "healthPort": 9465,
     "logDir": "/home/USER/.bedrockbot/logs",
     "metricsInterval": 60,
     "reconnect": true,
     "logLevel": "info"
   }
   ```

   (`logDir`: `/Users/USER/.bedrockbot/logs` on macOS.) `home` is only the starting value. `!home set x y z`
   in chat is saved next to the config (`~/.bedrockbot/waypoints/realm-<name>.json`) and wins over it at every
   later start, so it is typed once; `!home clear` forgets it and the config's `home` applies again. A `--home`
   in the service arguments would win over both (the shipped units have none).

## Sign in once (you, interactively)

Only one client per Microsoft account: stop any other bot on that account first, or the new login
kicks the old one.

```sh
ssh <host>
export PATH=~/.local/node/bin:$PATH
cd ~/BedrockBot/bot && node src/index.ts --task afk --target realm
```

Open the printed `https://www.microsoft.com/link` page, enter the code, sign in with the bot's
account. When the log says `spawned as <gamertag>`, press Ctrl+C. Tokens are now cached in
`~/.bedrockbot/profiles` and refresh by themselves (8 h of reconnects verified without a prompt).

## Keep it running

**macOS (launchd):**

```sh
sed "s#/Users/USER#$HOME#g" ~/BedrockBot/deploy/launchd/com.bedrockbot.realm.plist > ~/Library/LaunchAgents/com.bedrockbot.realm.plist
mkdir -p ~/.bedrockbot/logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bedrockbot.realm.plist
```

```sh
launchctl print gui/$(id -u)/com.bedrockbot.realm | head -20     # state, pid, last exit code
launchctl kickstart -k gui/$(id -u)/com.bedrockbot.realm          # restart now
launchctl bootout gui/$(id -u)/com.bedrockbot.realm               # stop and unload
```

**Linux (systemd user unit):**

```sh
mkdir -p ~/.config/systemd/user ~/.bedrockbot/logs
cp ~/BedrockBot/deploy/systemd/bedrockbot.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now bedrockbot.service
loginctl enable-linger "$USER"        # keep user services running after you log out (may need sudo)
```

```sh
systemctl --user status bedrockbot.service        # state, pid, last exit code
systemctl --user restart bedrockbot.service       # restart now
systemctl --user disable --now bedrockbot.service # stop and unload
```

Either way, `tail -f ~/.bedrockbot/logs/realm-console.log` follows the bot,
`curl -s http://127.0.0.1:9465/metrics` reads the metrics (from the server itself) and
`tail -n 5 ~/.bedrockbot/logs/disconnects.jsonl` shows every session end with its reason.

The service restarts the bot after any exit, 60 s apart. On a game update the Realm refuses the
old client (exit 3, `kicked: outdated_client`), so the agent keeps retrying once a minute until a
bumped build is pushed; the update notifier whispers the owners meanwhile.

## Updating the code

From the dev machine, after every merge that passed the gate:

```sh
BEDROCKBOT_DEPLOY_HOST=<host> pnpm deploy:server   # = git push <host>:bedrockbot.git main, then on the server: git pull && bash deploy/update.sh
```

`update.sh` pulls, installs, rebuilds `raknet-native` if needed, lints, runs the unit tests and restarts the
service (the bot is off the Realm for about 10 s). Features that are off by default are turned on
in `~/.bedrockbot/config.json`, e.g. `"tasks": { "afk": { "guard": 16, "fleeHealth": 8 } }`.

After the history of the repository was rewritten, the first deploy needs `-- --force` (force-push, and the
server's checkout is reset to it instead of pulled).

Keep the Realm on a commit that passed the full BDS gate (docs/versions.md); the dev machine's
worktree habit applies here too: push only what is green.

## Notes

- The server must not sleep. macOS: `pmset -g` should show `sleep 0`; prevent it in System Settings (or
  `sudo pmset -a sleep 0`). Linux servers normally do not sleep; check the power settings of a desktop install.
- Logs: `realm-console.log` grows slowly (one line per nudge, about 400 B/min); rotate it with
  `newsyslog` (macOS) or `logrotate` (Linux), or truncate when it bothers you. `--no-record` keeps the
  1 GB/day packet capture off (the shipped units pass it).
- `--health-port` binds 127.0.0.1 only; use `ssh -L 9465:127.0.0.1:9465 <host>` to read it remotely.
- Control panel on the LAN (docs/panel.md): with no change the panel is at `http://127.0.0.1:9465/` on
  the server itself (same port, nothing else changes). To use it from a phone or another machine on the
  home network, add to `~/.bedrockbot/config.json`:
  `"panel": { "host": "0.0.0.0", "port": 9466, "token": "<24 random characters>" }` (a fresh
  `pnpm config:init --print | grep '"token"'` shows a freshly generated one), then restart the service
  (`launchctl kickstart -k gui/$(id -u)/com.bedrockbot.realm` or `systemctl --user restart bedrockbot.service`).
  A separate port keeps `curl http://127.0.0.1:9465/metrics` token-free; `!panel` in game prints the URLs
  (`http://<server LAN address>:9466/`). Open `http://<address>:9466/?token=<token>` once per browser (a
  cookie remembers it). macOS may ask to allow incoming connections for `node`: allow it. The panel can make
  the bot walk, fight and quit: keep it on the LAN, never port-forward it on the router, and change the
  token if it leaks.
