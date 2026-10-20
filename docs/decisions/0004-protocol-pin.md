# 0004: bedrock-protocol pin for the Realm join

Date: 2026-10-28. Status: accepted (PLAN.md task 1.5, Realm readiness checklist item 1).

## Question

The Realm readiness checklist (PLAN.md section 2) asks for bedrock-protocol "pinned to a commit at
or after PR #839, or to the release that contains it". Which pin does the bot use?

## Facts (checked 2026-10-28)

- npm: newest bedrock-protocol is **3.60.1** (2026-09-22). `npm view bedrock-protocol versions`
  lists nothing newer. No GitHub release after 3.60.1.
- master since the 3.60.1 release commit `69c5141f` (GitHub compare API):

  | Commit | PR | Change |
  |---|---|---|
  | `f4fe1e8a` | #835 | CI gate (`.github` only) |
  | `f0ac6151` | #834 | `nbtLoop` read size fix in `src/datatypes/compiler-minecraft.js` (affects `level_event_generic`) |
  | `c9e1fbf2` | #839 | `src/client/auth.js`: use the regional signalling host `signal-<region>.franchise.minecraft-services.net` only if it resolves in DNS, else keep the default `signal.franchise.minecraft-services.net`. Fixes #832 (Realm join fails with `ENOTFOUND` in most regions) |
  | `de199f0f` | #838 | docs spelling (head of master) |

  The `src/` difference between 3.60.1 and `c9e1fbf2` is those two files only. `package.json` still
  says `3.60.1` (no version bump), `minecraft-data` is still `^3.117.0`.
- Why #839 matters: in 3.60.1, `realmAuthenticate()` sets `options.nethernet._signallingHost` to
  `signal-<regionName>.franchise.minecraft-services.net` from the Realms join answer
  (`sessionRegionData.regionName`) unconditionally. Most regions have no such DNS name, so the
  services-signalling WebSocket fails and the join never starts. This is the most likely failure
  of a first Realm join with 3.60.1 (PLAN.md risk "Realm join over NetherNet fails").

## Options

1. **Stay on npm 3.60.1** and wait. Simple, but the first Realm join probably fails in most regions.
2. **pnpm git dependency on the #839 merge commit** (`github:PrismarineJS/bedrock-protocol#c9e1fbf2...`).
3. **pnpm patch of 3.60.1** backporting #839 (and #834), like `patches/minecraft-data@3.117.0.patch`.
   Keeps the npm tarball, but the patch is our own code to maintain and can drift from upstream.
4. Own fork on GitHub. Needs an account and pushes; out of scope for agents (playbook step 5).

## Decision

Option 2. `bot/package.json`:

```json
"bedrock-protocol": "github:PrismarineJS/bedrock-protocol#c9e1fbf21dc6abde8d89920996575791b79e66cf"
```

The pin is the #839 merge commit itself (master head `de199f0f` only adds a docs change).
`packs/truth` (dev dependency, used for its own e2e helper) and `tools/bump-version` (sandbox
verification) stay on npm 3.60.1; they never join a Realm.

## Verification (2026-10-28, pnpm 12.16.1, Node 24.22.1, Windows 11)

- `pnpm install` resolved it in under 2 s; the lockfile records
  `https://codeload.github.com/PrismarineJS/bedrock-protocol/tar.gz/c9e1fbf2...` with
  `gitHosted: true` and a sha512 integrity.
- A fresh `pnpm install --frozen-lockfile` with an empty store (a scratch copy of the workspace
  manifests, lockfile and `patches/`) installed 431 packages in 12 s. In it: `src/client/auth.js`
  contains the DNS fallback, `Options.Versions['1.26.60'] === 2225` (the minecraft-data patch
  still applies through the root `overrides`), and `raknet-native` loads its Windows prebuild
  (no build script; `allowBuilds: raknet-native: false` unchanged).
- No `prepare`/`install` script in bedrock-protocol, so pnpm needs no build step for the git
  dependency; the git tree has the same runtime files as the npm tarball.
- Unit tests: `bot/test/unit/realm.test.ts` runs the installed `realmAuthenticate()` with the bot's
  Realm options against a stubbed Realms API and stubbed DNS: a resolvable regional host is used,
  an unresolvable one falls back to the default (fails on 3.60.1).
- e2e: the whole Phase 1 suite plus world-* and skills-input passed with the pin against BDS
  1.26.60.6 (`bds60`, RakNet, game version 1.26.60) and against BDS 1.26.51.1 over NetherNet
  (`bds-nn`). See docs/versions.md for the tables.

## Risks and exit

- GitHub archive tarballs are not guaranteed byte-stable. If codeload ever serves a different
  tarball for the commit, a frozen install fails with an integrity error (it does not silently
  install something else). Fix: `pnpm install` to re-lock, after checking the diff.
- Installs need network access to codeload.github.com.
- **Exit**: when an npm release newer than 3.60.1 contains #839 (check HISTORY.md for "Fall back to
  the default signalling host"), replace the specifier with that exact version, re-lock, rerun unit
  and e2e on both transports. If that release also ships minecraft-data with 1.26.60, drop
  `patches/minecraft-data@3.117.0.patch` and its `patchedDependencies` entry in the same change.
- Rollback: set `"bedrock-protocol": "3.60.1"` and `pnpm install`. Everything except the Realm
  signalling fallback keeps working (the realm.test.ts fallback case then fails, on purpose).

## Still needed before the Realm join (not code)

The pin covers checklist item 1 only. The Realm runs the newest game version (1.26.60 today), so the
bot must speak it (`--version 1.26.60`, or flip the default, see docs/versions.md), the human signs
in once (docs/runbook.md "Realm join"), and co-players are told about the bot.
