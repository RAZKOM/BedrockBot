# tools/bump-version

Run the bot's protocol stack against a Bedrock version that bedrock-protocol does not support yet, by
patching the `minecraft-data` npm package with data from minecraft-data's GitHub repo, then prove it
works end to end against a pinned local BDS. Plain Node ESM, no build step. The step-by-step procedure for
a game-update day is in [playbook.md](playbook.md).

Pinned stack (`package.json`): bedrock-protocol 3.60.1, minecraft-data 3.117.0, prismarine-registry
1.12.0, prismarine-chunk 1.41.0. BDS image: `itzg/minecraft-bedrock-server:2026.10.2`.

Hard rules baked in: BDS runs locally with `ONLINE_MODE=false`; `verify.mjs` only connects to
127.0.0.1 in offline mode; nothing here touches credentials, Realms or public servers.

## Commands

```sh
cd tools/bump-version

# What is new?
node run-bds.mjs --links                 # newest BDS builds (release + preview) from the official links API
node bump.mjs --list                     # bedrock folders + protocolVersions on minecraft-data master

# Patch a sandbox copy of minecraft-data with 1.26.60 (idempotent; prints the generated data.js entry)
node bump.mjs 1.26.60                    # target: .work/sandbox/node_modules/minecraft-data (npm, created on demand)
node bump.mjs 1.26.60 --target <dir>     # any npm-installed minecraft-data package dir (never a pnpm store path)
node bump.mjs 1.26.60 --mcdata-ref bedrock_1_26_60   # an upstream branch/PR instead of master
node bump.mjs 1.26.60 --from-dir <minecraft-data checkout>   # data you generated locally

# Start a pinned BDS and wait for "Server started" (reuses an existing container of that name)
node run-bds.mjs 1.26.51.1 --port 19138 --name bds51
node run-bds.mjs 1.26.60.6 --port 19134 --name bds60

# End-to-end check: login, spawn handshake, registry, subchunk decode, 20-tick walk, no corrections
node verify.mjs 1.26.51 --port 19138                 # deps from the sandbox
node verify.mjs 1.26.51 --port 19138 --deps self     # deps from this package's own (pnpm workspace) install
node verify.mjs 1.26.60 --port 19134

# Triage: which packet schemas changed between two versions (needs both in the sandbox)
node schema-diff.mjs 1.26.51 1.26.60
node schema-diff.mjs 1.26.51 1.26.60 --show packet_player_auth_input

# Make the bump persistent for a project, and prove the patch applies to a fresh install
node make-patch.mjs 1.26.60              # -> patches/minecraft-data@3.117.0.patch (pnpm format)
node make-patch.mjs 1.26.60 --patch-package   # also patches/minecraft-data+3.117.0.patch (patch-package format)
node test-patch.mjs 1.26.60              # pnpm patchedDependencies + patch-package, each in a temp dir
```

Every command prints a JSON result on stdout (progress goes to stderr) and exits non-zero on failure.

## What `bump.mjs` changes

Inputs (downloaded into a fresh temp dir, parsed and validated as data, never executed):
`data/bedrock/<ver>/protocol.json`, `data/bedrock/<ver>/version.json`,
`data/bedrock/common/protocolVersions.json`, `data/bedrock/common/versions.json` (the `supportedVersions`
list; upstream's 1.26.60 PR touched it too), `data/dataPaths.json`. Validation: all parse;
`version.json.minecraftVersion` equals `<ver>`; protocolVersions has `<ver>` with the same protocol
number; versions.json lists `<ver>`; `dataPaths.bedrock[<ver>]` exists, its protocol and version point at `bedrock/<ver>`, and every
path matches `(bedrock|pc)/<name>`.

Edits to the target package:

| File | Change |
|---|---|
| `minecraft-data/data/bedrock/<ver>/protocol.json`, `version.json` | copied |
| `minecraft-data/data/bedrock/common/protocolVersions.json` | entry for `<ver>` merged in (whole-file replace with `--replace-common`) |
| `minecraft-data/data/bedrock/common/versions.json` | `<ver>` inserted in order (whole-file replace with `--replace-common`) |
| `minecraft-data/data/dataPaths.json` | `bedrock[<ver>]` merged in (whole-file replace with `--replace-common`) |
| `data.js` | a `'<ver>'` entry generated from `dataPaths.bedrock[<ver>]` the same way minecraft-data's `bin/generate_data.js` does, inserted after the newest older entry |

Merging is the default because upstream master's `dataPaths.json` also carries unrelated edits for
other versions (on 2026-10-28: 18 `pc/*` entries plus `bedrock/1.26.45` and `bedrock/1.26.51`, some
pointing at files the 3.117.0 tarball does not ship). The JSON output lists that drift under
`dataJs.upstreamDrift`. If `dataPaths.bedrock[<ver>]` references a JSON data file the package lacks
(e.g. a new `bedrock/<ver>/blocks.json`), it is fetched and validated too. The output also compares
the new entry with the previous version's entry (`sameAsBase`, `differsFromBase`) so you can see
whether blocks or items data moved. For 1.26.60 everything except protocol and version is the same
as 1.26.51; blocks, items and collision shapes still point at 1.26.30 (PLAN.md row 3a).

A self-check then loads the patched package in a fresh process (`minecraft-data('bedrock_<ver>')`).
Rerunning with the same inputs reports `"idempotentNoop": true`. The result for 1.26.60 is
identical (ignoring CRLF) to the hand-patched package from spike E, apart from the merged common
files.

### Why a sandbox and not `node_modules/minecraft-data`

This folder is a member of the root pnpm workspace (`tools/*`), so its `node_modules` entries are
symlinks into `node_modules/.pnpm`, whose files are hard links into the machine-wide pnpm content
store. Editing them in place would silently patch every project on the machine. `bump.mjs` refuses
any target whose real path is inside a `.pnpm` directory. Instead it installs the pinned stack with npm
into `.work/sandbox/` (git-ignored, about 12 s) and edits that copy. For pnpm projects, use the patch file
(below).

## Persisting the bump in a pnpm project (the bot)

**Status (2026-10-28): done for the bot workspace.** The 1.26.60 patch is at the repo root
(`patches/minecraft-data@3.117.0.patch`, byte-identical to `patches/` here) and listed in
`pnpm-workspace.yaml` `patchedDependencies`; `pnpm -r test` replays 1.26.60 fixtures and the e2e
suite passes against BDS 1.26.60.6 (`pnpm e2e:60`, docs/versions.md). Regenerate both copies together.

`patches/minecraft-data@3.117.0.patch` is a git-format diff with package-relative paths (`a/data.js`,
`a/minecraft-data/data/...`). That is the format `pnpm patch-commit` writes and `patchedDependencies`
reads. To consume it from the repo root:

1. Copy it to `patches/minecraft-data@3.117.0.patch` at the repo root.
2. Add to `pnpm-workspace.yaml`:
   ```yaml
   patchedDependencies:
     minecraft-data@3.117.0: patches/minecraft-data@3.117.0.patch
   ```
3. Run `pnpm install`. pnpm stores the patched copy under its own hash, so the global store stays clean.
   bedrock-protocol then lists 1.26.60 in `Options.Versions` (it derives versions from minecraft-data),
   so `createClient({ version: '1.26.60' })` works. Ping-based discovery also works, because it maps the
   server's protocol 2225 back to 1.26.60. bedrock-protocol itself needs no patch for a
   schema-only update; its `CURRENT_VERSION` is only the default when no version is given.
   The lockfile records the patch hash, so commit `pnpm-lock.yaml` after adding or regenerating the patch.
   A frozen install (CI) fails with "patchedDependencies configuration doesn't match the value found in
   the lockfile" until you do.
4. When an npm release of minecraft-data contains the version, bump the dependency and delete the patch
   and the `patchedDependencies` entry, all in the same change. The entry is keyed on the exact version,
   and pnpm 12.16.1 refuses to install with an unused entry ("The following patches were not used:
   minecraft-data@…"; checked 2026-10-28).
5. To bump again on top (say 1.26.70 while still on 3.117.0), regenerate with every version you need:
   `node make-patch.mjs 1.26.60 1.26.70`. A patch always starts from the pristine tarball.

Verified on 2026-10-28 with pnpm 12.16.1 (the root `packageManager`): a fresh project with
`patchedDependencies` installed and resolved `bedrock_1.26.60` (`test-patch.mjs`). A full pnpm-installed
stack (bedrock-protocol, minecraft-data with the patch, prismarine-*) passed `verify.mjs 1.26.60`
against BDS 1.26.60.6.

For npm projects, use patch-package: `make-patch.mjs --patch-package` writes
`patches/minecraft-data+3.117.0.patch` with `node_modules/minecraft-data/` paths (patch-package resolves
paths from the project root, pnpm from the package root). Add `"postinstall": "patch-package"`. You can
also apply the patch by hand: `patch -p1 -d node_modules/minecraft-data < patches/minecraft-data@3.117.0.patch`.

Patch files are byte-exact. `.editorconfig` here stops editors from trimming whitespace in `*.patch`.

## verify.mjs details

The spawn handshake is copied from spike E: answer `respawn` state 1 with state 2 and the runtime id; on
`play_status: player_spawn` send `serverbound_loading_screen` types 1 and 2. For the registry, it
calls `prismarine-registry('bedrock_<ver>').handleStartGame({ ...start_game, itemstates })` once both
`start_game` and `item_registry` have arrived. In 1.26.x `item_registry` arrives after `start_game`:
2076 item states on 1.26.51, 2080 on 1.26.60. Chunks: `subchunk_request` for chunk (0,0) at origin y = -4,
decoded with `prismarine-chunk/src/bedrock/1.18/chunk` (the 1.26 bypass). The run asserts that block (0,-61,0)
is `grass_block`; it also reports the block below (bedrock) and above (air).

Movement: 20 ticks of `player_auth_input` holding forward (`up`, `vertical_collision`, eye = feet + 1.62),
then 30 idle ticks to catch late corrections. The run fails on any `correct_player_move_prediction`.
Positions follow Bedrock ground-walking physics by default (`--walk physics`): each tick
`v += 0.098; z += v; v *= 0.546`, which settles at 0.2159 blocks/tick and coasts after release.
**A constant 0.2 blocks/tick (`--walk constant`) is corrected by BDS over 20 ticks:** 2 corrections
on both 1.26.51.1 and 1.26.60.6, with the server at z = 4.539 against the client's 4.3. Spike C's
6-tick walk at 0.2 passed only because the drift stayed under the 0.5-block acceptance threshold.

Decode errors (packets the schema cannot parse) are collected with packet id and name. By default
they fail the run (`stage: "decode"`); `--allow-decode-errors` downgrades them to a report entry.
The failure `stage` is one of `setup`, `ping`, `login`, `spawn`, `chunk`, `movement`, `decode`; see
playbook.md for what each means.

## raknet-native

No install script is needed. raknet-native 1.2.3 ships prebuilt binaries in the npm tarball
(`prebuilds/win32-10-x64`, `linux-5-x64`, `darwin-21-x64`). Its `install` script (`node buildChecks.js`)
only falls back to a cmake build when the prebuild fails to load. npm 11.19 blocks that script by
default (`allowScripts`), the root pnpm workspace denies it (`allowBuilds: raknet-native: false`), and
the sandbox installs with `--ignore-scripts`. In all three cases
`node -e "require('raknet-native')"` loads on Windows x64 with Node 24.22.1. On linux-arm64 or
darwin-arm64 there is no prebuild, so allow the script and have cmake plus a C++ toolchain available.

## Files

| File | Purpose |
|---|---|
| `bump.mjs` | download, validate, apply to a minecraft-data dir; `--list` upstream versions |
| `make-patch.mjs` | pristine install, bump a copy, write the diff of touched files |
| `test-patch.mjs` | apply the patch with pnpm and with patch-package in temp dirs and load the result |
| `run-bds.mjs` | start or reuse a pinned BDS container and wait for "Server started"; `--links` |
| `verify.mjs` | end-to-end login, chunk and movement check, JSON report |
| `schema-diff.mjs` | packet and type schema changes between two versions |
| `lib/upstream.mjs` | GitHub raw and contents API fetch, validation, local-checkout source |
| `lib/apply.mjs` | data.js entry generation and insertion, common-file merge, self-check, pnpm-store guard |
| `lib/sandbox.mjs` | npm sandbox install (`.work/sandbox`) |
| `lib/gitdiff.mjs` | dependency-free git-format diff writer (Myers) and path re-rooting |
| `patches/minecraft-data@3.117.0.patch` | the 1.26.60 bump for minecraft-data 3.117.0 (pnpm format) |
| `.bds/<name>/` | BDS data dirs of containers created by `run-bds.mjs` (git-ignored) |
| `.work/` | sandbox and scratch output (git-ignored) |
