# Game-update day playbook

Goal: the bot plays the new Bedrock version before bedrock-protocol and minecraft-data publish npm
releases for it. Upstream normally ships them 1 to 11 days after the game release (median about 4;
PLAN.md row 2b). The path below took 1.26.51 to 1.26.60 on 2026-10-28, the day after the game release.

All commands run in `tools/bump-version/`. Example values: old version 1.26.51 (BDS 1.26.51.1, container
`bds51`, UDP 19138), new version 1.26.60 (BDS 1.26.60.6, container `bds60`, UDP 19134). Use only
container names and ports assigned to you; never stop or remove containers you did not create. Local BDS
only, `online-mode=false`, no credentials, no Realm or public servers. A human does the Realm step at the end.

## 0. Is there an update?

```sh
node run-bds.mjs --links      # {"release":"1.26.60.6","preview":"1.26.70.22", ...}
npm view bedrock-protocol version
npm view minecraft-data version
node bump.mjs --list          # bedrock/ folders + top of protocolVersions.json on minecraft-data master
```

- **BDS build.** The links API (`https://net-secondary.web.minecraft-services.net/api/v1.0/download/links`)
  gives the exact 4-part build in `serverBedrockLinux` and `serverBedrockPreviewLinux`. The game version is
  the first three parts.
- **Protocol number.** Within hours of a release, PrismarineJS's bot (`rom1504bot`) opens a
  "Support Minecraft <ver>" issue on bedrock-protocol. It contains the protocol number from a server pong and
  links to the gophertunnel and CloudburstMC protocol commits for that version (example: issue #840 for
  1.26.60, opened 2026-10-27 20:24 UTC, protocol 2225). The verify ping also reports it.
- **Upstream data.** Look for `data/bedrock/<ver>/` in `bump.mjs --list`. If present, go to step 2. If not,
  go to step 1.

## 1. If minecraft-data has no `bedrock/<ver>` folder yet

Check in this order:

1. **An open upstream PR.** minecraft-data's `Bedrock Version Bump` workflow
   (`.github/workflows/bedrock-version-bump.yml`, run with `version`, `protocolVersion` and `issueUrl`) runs
   `npm run version bedrock <ver> <protocol>`, `npm run build` and `npm test` in `tools/js`. It opens a PR titled
   "🎈 Add Minecraft bedrock <ver> data" from branch `bedrock_<ver with non-alphanumerics as _>`. Example:
   PR #1340, branch `bedrock_1_26_60`, opened by rom1504bot; a follow-up commit fixed the protocol schema and
   extremeheat merged it on 2026-10-28. You can bump straight from that branch before the merge:
   ```sh
   node bump.mjs 1.26.60 --mcdata-ref bedrock_1_26_60
   ```
   The bot's first commit is boilerplate: the previous protocol is copied forward. Check that the PR has a
   schema commit after the boilerplate, or expect decode errors in verify.
2. **Generate the data yourself** in a local clone of PrismarineJS/minecraft-data (a plain clone, no fork, no
   push), following `doc/bedrock.md`:
   - copy `data/bedrock/latest/*` into `data/bedrock/<previous version>/`;
   - edit `data/bedrock/latest/proto.yml` (packets) and `types.yml` (shared types) to match the new
     protocol and change `!version` at the top. Sources for what changed: the gophertunnel and CloudburstMC
     commits linked in the bedrock-protocol issue, and Mojang's protocol docs
     (https://github.com/Mojang/bedrock-protocol-docs);
   - in `tools/js`: `npm install`, `npm run version bedrock <ver> <protocol>` (the workflow's
     first step, `tools/js/incrementVersion.js`; PR #1340 shows the files it touches: `bedrock/<ver>/`,
     `protocolVersions.json`, `versions.json`, `dataPaths.json`), `npm run build` (compiles the YAML
     to `protocol.json`), `npm test`;
   - then bump from the checkout: `node bump.mjs <ver> --from-dir <clone>`.
3. **Check the schema against a real server** with bedrock-protocol's `tools/dumpPackets.js`, run in a
   bedrock-protocol clone with your patched minecraft-data: `node tools/dumpPackets.js <ver> [outDir]`. It
   downloads and starts a vanilla BDS, joins offline, and writes up to 5 samples per clientbound packet to
   `<out>/from-server/<packet>/N.bin|json`. It also writes `<out>/README.md` and `metadata/packets_info.json`
   listing collected and missing packets. Caveats from reading the source on 2026-10-28:
   - it binds a **random port between 19130 and 19229**, which can collide with other agents' containers;
   - it deletes `bds-<ver>` next to the output dir;
   - its per-packet counter checks `packet.name`, which is undefined, so in practice it keeps only `1.bin`.

   `verify.mjs` covers the same ground for the packets the bot needs, on a port you choose.

## 2. Bump, start BDS, verify

```sh
node bump.mjs 1.26.60                             # patches .work/sandbox (npm copy); prints JSON, idempotent
node run-bds.mjs 1.26.60.6 --port 19134 --name bds60   # first start downloads ~100 MB; waits up to 4 min
node verify.mjs 1.26.60 --port 19134              # exit 0 + JSON report = done
node verify.mjs 1.26.51 --port 19138              # regression: the old version still works with the patched data
```

Read the `bump.mjs` output before you trust it:
- `dataJs.differsFromBase` shows whether upstream pointed blocks, items or collision data at a new folder.
  If it did, the bot's world model may see new block names; re-run the Phase 2 block tests.
- `dataJs.upstreamDrift` shows edits on upstream master to other versions. They are not applied in merge
  mode; that is expected.

## 3. If verify fails

The report's `failure.stage` tells you which layer changed. `node schema-diff.mjs <old> <new>` lists every
packet and type whose schema changed and flags the ones each stage depends on (`watched`).
`--show <type>` prints both versions of one type.

| Stage | Symptom | What changed | What to do |
|---|---|---|---|
| `setup` | "do not know <ver>" | bump not applied to the deps you loaded | run `bump.mjs`, or pass the right `--deps` |
| `ping` | no RakNet answer | container down, still downloading, `TRANSPORT` not raknet, or RakNet removed from BDS | `docker logs <name>`. RakNet is deprecated since 26.50 and BDS 1.26.60 prints a "TRANSPORT TYPE ERROR" banner but still accepts it. Once it is removed, verify must move to NetherNet (bedrock-protocol `transport: 'nethernet'`, PLAN.md row 2d) |
| `login` | "server advertises X protocol P" | wrong BDS build or version argument | match `run-bds` build and `verify` version |
| `login` | kick or `play_status` `failed_client`/`failed_spawn`/`outdated_*`, error before `login_success`, or a decode error in `network_settings`, `server_to_client_handshake`, `resource_packs_info` or `start_game` | **login, auth or encryption flow changed** (it happened in 1.26.10 and 1.26.40) or those packets' schemas | not fixable with data alone: needs bedrock-protocol code (`src/client.js`, `src/handshake/*`, `src/client/auth.js`). Check bedrock-protocol master and open PRs first, then gophertunnel's login code for the new version. Pin a fixed commit (PLAN.md section 7) |
| `spawn` | timeout after `login_success` | spawn handshake changed: `respawn` states, `serverbound_loading_screen`, `set_local_player_as_initialized`, or a new required ack | `schema-diff --show packet_respawn` and the other `watched.spawn` packets. Compare with gophertunnel or Geyser's join sequence. Update the handshake in the bot's Connection layer and in `verify.mjs` |
| `chunk` | `registry.handleStartGame failed` | block palette or `start_game`/`item_registry` shape changed | prismarine-registry may need a shim (as with `item_registry` in 1.26). Fix it in the bot's per-version registry shim module (PLAN.md section 2, change 2) |
| `chunk` | wrong block name, decode throws, or `subchunkResult` not `success` | subchunk wire format (prismarine-chunk), hashed block ids or block states data | check that `dataPaths.bedrock[<ver>].blockStates` exists. New blocks fall back to air while upstream block data is frozen at 1.26.30 (PLAN.md row 3a); grass_block is unaffected. For a format change, the prismarine-chunk 1.18 bypass needs a new implementation: watch prismarine-chunk PR #338 and its successors |
| `movement` | `correct_player_move_prediction` | `player_auth_input` fields or `InputFlag` values changed, or the movement physics or server thresholds changed | `schema-diff --show packet_player_auth_input` and `--show InputFlag`. If the schema is unchanged, compare `--walk constant` with `--walk physics` and check `server.properties` for new movement keys. Fix it in the bot's input or physics layer |
| `decode` | `unknownPackets` listed | `protocol.json` is wrong for those packets (often a field added at the end, like `level_chunk.client_biome_update` in 1.26.60) | fix `proto.yml` upstream (step 1) and re-bump; `--allow-decode-errors` gets past packets the bot does not use |

## 4. Make it persistent for the bot

```sh
node make-patch.mjs 1.26.60          # -> patches/minecraft-data@3.117.0.patch (list every version you need)
node test-patch.mjs 1.26.60          # applies with pnpm patchedDependencies and patch-package in temp dirs
```

Then, on a branch in the main repo:

1. Copy the patch to the root `patches/` folder and add `patchedDependencies: { minecraft-data@3.117.0:
   patches/minecraft-data@3.117.0.patch }` to `pnpm-workspace.yaml`.
2. Run `pnpm install` and commit `pnpm-lock.yaml`; frozen installs fail until the lockfile has the patch hash.
3. Pin the new BDS build in `docker/compose.dev.yml` (and the NetherNet profile). Pass the new version to the
   bot's Connection explicitly, or rely on ping discovery: bedrock-protocol maps the server's protocol number
   to a version through minecraft-data, so no bedrock-protocol patch is needed for a data-only update.
4. Run `@minecraft/server` against the new BDS. The truth pack's module version may need to change
   (PLAN.md section 7).
5. Re-record fixtures, run unit and e2e tests on both transports, then a 30-minute soak (PLAN.md section 7). Only
   then use the bump on the Realm (a human does this).
6. When npm ships a minecraft-data release containing the version: bump the dependency and delete the patch
   and its `patchedDependencies` entry in the same change. pnpm refuses unused patch entries.

## 5. Upstream the bump (human with a GitHub account; agents do not create forks or PRs)

For a data-only update, the bedrock-protocol change is three one-line edits. Example: PR #823, "Support
Minecraft 1.26.51", by extremeheat, merged 2026-09-22:

| File | Edit |
|---|---|
| `README.md` | append `, <ver>` to the supported-versions line |
| `package.json` | `"minecraft-data": "^<release that contains ver>"` |
| `src/options.js` | `const CURRENT_VERSION = '<ver>'` |

The prerequisite is a minecraft-data npm release containing the version: merge the minecraft-data PR,
then release node-minecraft-data. Then run `npm install`, `npm run build` and `npm test` in bedrock-protocol
(docs/CONTRIBUTING.md). The tests start vanilla BDS servers through `tools/startVanillaServer.js`. Before opening anything, check bedrock-protocol's open
PRs and the "Support Minecraft <ver>" issue: maintainers usually do this bump themselves within days. If the
update needed code changes (step 3, `login` or `spawn` stage), the PR carries those instead and is no
longer a 3-line change.
