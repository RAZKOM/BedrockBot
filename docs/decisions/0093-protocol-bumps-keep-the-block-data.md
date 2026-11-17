# 0093: Protocol bumps keep the block data (Track U1)

Date: 2026-11-16. Status: accepted. Details and numbers: [../versions.md](../versions.md) "1.26.65 and the npm
releases".

## Context

The update check reported BDS 1.26.65.1, bedrock-protocol 3.61.0 and minecraft-data 3.119.0. BDS 1.26.65.1 speaks
protocol 2225, the protocol of 1.26.60: the bot joined it and played on it unchanged. bedrock-protocol 3.61.0 is the
bot's git pin plus the 1.26.60 entry. The two minecraft-data releases differ:

- 3.118.0 adds bedrock 1.26.60's protocol data. Every table the bot reads is the same as in 3.117.0 with the bot's
  patch, apart from the `filtered_custom_name` fix (ADR 0092), which upstream still lacks.
- 3.119.0 regenerates the bedrock block and item data of every version (PR #1335). For 1.26.60: 1480 blocks, 23 960
  states and 2080 items instead of 1356, 16 913 and 1933; for 1.26.30 itself, hardness, materials, harvest tools,
  bounding boxes and item ids change (obsidian hardness 50 -> 35, ladder `block` -> `empty`, iron ore's material
  `incorrect_for_wooden_tool` -> `mineable/pickaxe`). The world model's state ids, collision shapes, dig times and
  stack sizes would all move at once.

## Decision

1. A version bump changes the protocol data only. The bot's dependencies move to bedrock-protocol 3.61.0 and
   minecraft-data 3.118.0, with a patch that holds the local protocol fixes alone. minecraft-data 3.119.0 and later
   are not taken until the world model is moved to their block data in a change of its own, with the nav, flight
   and dig suites run again.
2. A guard test, `bot/test/unit/world/data-pin.test.ts`, fingerprints the block, state, item, shape and material
   tables of every minecraft-data key the bot loads. A dependency bump that changes them fails the unit suite and
   names the key; the fingerprints change only together with the world model.
3. `tools/bump-version/make-patch.mjs` builds a patch for a minecraft-data release that already ships the version
   (`--package-version`): the version is not bumped, only the local fixes are applied. Patches are built from a
   minecraft-data commit (`--mcdata-ref`), not from master, because master changed 1.26.60's block data a day after
   its protocol data landed.
4. The test servers move to BDS 1.26.65.1, the current release (what a Realm runs once it updates). The bot keeps speaking `1.26.60`:
   bedrock-protocol checks only the protocol number. Its `!status` and logs name the version the server advertises.

## Consequences

- The update check keeps listing minecraft-data 3.119.0 as newer. That is expected until the block data move.
- When 1.26.70 (protocol 2259 in Mojang's preview docs) is released, its minecraft-data folder will point at new
  block data. The bump then needs either a patch of 3.118.0 that keeps the bot's keys on the 1.26.30 tables, or the
  block data move first; the guard test tells which tables changed.
- Rollback: the previous pins (bedrock-protocol git `c9e1fbf2`, minecraft-data 3.117.0 with its 1.26.60 patch) and
  BDS 1.26.60.6 in the compose files. The bot behaves the same on either.
