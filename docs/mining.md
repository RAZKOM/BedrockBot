# Legit mining: `!mine <block> [n]` (`bot/src/skills/mine`)

PLAN.md Phase 7 task 7.14 (Track U). Decision record: [decisions/0016-farming-and-mining.md](decisions/0016-farming-and-mining.md).
Everything below was measured on **BDS 1.26.60.6** (container `bds-farm`, udp/19186, RakNet, offline,
flat world, peaceful, survival, operator, `server-authoritative-block-breaking` on, TICK_DISTANCE 10)
with bedrock-protocol `c9e1fbf2` / minecraft-data 3.117.0 + the 1.26.60 patch on 2026-10-29. Digging
itself is in [digging.md](digging.md), the navigator's dig-through moves and break safety rules in
[pathfinding.md](pathfinding.md).

```ts
import { createMiner } from './skills/farm/index.ts';
const { mine, memory } = createMiner({ skills, world, loop, source: conn, hotbar, containers }, { tunnelLen: () => 32 });
const end = await mine.start({ block: 'coal', count: 8 });   // 'done' | 'none_left' | 'low_health' | 'no_pickaxe' | 'stopped' | 'failed'
mine.stats;        // mined, minedAt, targeted, unsafe, blacklisted, tunnelled, digTicks, collected, scans ...
mine.stop();       // cancels the running goto / dig at once
```

Chat (afk task with walking, owners only): `!mine <block> [n]` (n 1..256, default 1) answers
`mining 8 coal_ore/deepslate_coal_ore` and at the end `mine coal_ore: 8/8 done`,
`mine coal_ore: 5/8, no seen coal_ore left (1 skipped as unsafe)`, `... stopped at 3/8, health low`
or `... no pickaxe`; `!mine stop` answers `mine coal_ore: stopped after 3/8`; `!mine status`.
`!mine` stops `!farm` and the PvE foreground behaviour (follow / come / kill) first.

## Files

| File | What |
|---|---|
| `bot/src/skills/mine/seen.ts` | `OreMemory` (the seen set), `isOpen` / `openFaces` / `isExposed` (the exposure rule), `lineOfSight` / `firstHit` (voxel walk) |
| `bot/src/skills/mine/miner.ts` | `MineTask` (the loop), `resolveTargets` (`coal` -> coal_ore + deepslate_coal_ore), `needsPickaxe`, `hasPickaxe`, `eyeGoal` |
| `bot/src/skills/farm/index.ts` | `createMiner(parts, { tunnelLen })`: wires it to BotSkills, the navigator's `plan` and `breakBlocker`, the World |
| `bot/src/chat/commands-farm.ts` | `!mine` (with `!farm`), `registerFarmCommands` (called from tasks/registry.ts) |

## The exposure rule (what "legit" means here)

BDS sends every block of a loaded chunk to the client, buried ores included (no anti-xray). The bot
therefore keeps a rule of its own:

- A block is **seen** when at least one of its 6 neighbours is loaded and **open**: no collision box
  and not a liquid (air, cave air, torches, plants, crops ...). A player could look at that face.
- A block whose 6 neighbours are all solid, liquid or unloaded is **buried**. Scans count buried
  blocks (`stats.buriedSeen`, for the tests) but never store them, so they are never targets.
- Sources: (1) a scan of the loaded chunks around the bot before each target (`World.find`, radius
  32: 1.96 ms on the test cave); (2) block updates: a cell that becomes open (the bot dug it, someone
  removed a block) exposes its neighbours, a block placed next to an open cell is exposed; (3) the
  miner's own digs (`noteDug`).
- Memory: a seen position stays seen while the block there is unchanged, also after its chunk
  unloads (ore memory); when the world model shows another block there it is forgotten. Unloaded
  positions are not targeted (no plan into unloaded world). Memory only: task 7.12 can persist it.

**Limits.** Exposure is not visibility: an ore facing a sealed air pocket inside the rock counts as
seen although no player could have looked into the pocket (the test cave's corridor is sealed on
purpose: the bot tunnels in). Water does not expose (an ore whose only open side is under water is
not seen); glass and leaves do not either (they have collision boxes). A stricter line-of-sight rule
for *targeting* would forget ores the bot walked past and was not used; line of sight is enforced
for the *dig* instead (below).

## The loop (`MineTask`)

1. Stop when `mined >= n` (`done`), health < 8 (`low_health`), or the next target needs a pickaxe and
   none is in the inventory (`no_pickaxe`).
2. Scan, then take the nearest seen target of the asked names that is not blacklisted and that the
   navigator's break rules allow (`breakBlocker`: not next to water or lava (6 neighbours), no sand /
   gravel on top, not the block under the feet, not protected). An unsafe target is reported in
   `stats.unsafe` with the rule and blacklisted. No target left: `none_left`.
3. Approach: `goto` a `near` goal on the **eye** (feet + 1.62) within 3.5 blocks of the target's
   centre, `allowBreak: true`. Before walking, `nav.plan` is asked for the route and its dig cells
   are counted; more than `mineTunnelLen()` (default 32) blacklists the target for this run.
4. Line of sight: rays from the eye to the centres of the target's open faces and its centre; when
   none reaches it, the first solid block on the ray is dug (same break rules), up to 3 blocks.
5. Dig with `requireHarvest: true` (the Digger's best hotbar tool; `no_tool` blacklists), note the
   dug cell, `collect` within 5 blocks for 120 ticks (approach radius 1.2). The drop of an ore in a
   wall usually stays in the hole it left, where nobody can stand: when that collect picked nothing
   up, the bot walks to the standable cell right next to the hole (`stats.pickupWalks`), waits 15
   ticks for the server's pickup and collects once more. (Found in the second e2e run: 4 of 8 coal
   were left in their holes.)
6. Any failure counts against the target; 3 failures blacklist it.

Nothing is placed and nothing is lit. `stop()` bumps the run's generation and cancels the running
skill synchronously (the Digger sends `abort_break` on the next tick).

## Measured (`mine-cave`, bds-farm)

Layout: stone 21 x 7 x 13 with a 3 x 3 x 17 corridor sealed by 2 blocks of stone at its west end;
9 exposed coal ores in the corridor walls at feet, head and ceiling height, one with a lava source
right behind it; 4 coal ores buried two blocks deep; the bot starts outside with a stone pickaxe.

| Measure | Result |
|---|---|
| `mine coal_ore` x 9 | `none_left` after 46.2 s (first run), 71.4 s (run A, while the farm suite ran on the same server), 41.9 s (run B): the 8 safe ores mined, the lava one skipped (`next_to_liquid`), the 4 buried never targeted and still there (truth), 8 coal in the inventory (truth), 0 corrections, 0 failures |
| drops | run B: 3 pickup walks next to the holes; before that fix a run ended with 4 of 8 coal in their holes |
| tunnel | 4 blocks (the 2 x 2 seal, by the navigator's dig-through); 0 line-of-sight digs |
| coal ore, stone pickaxe | 22 to 23 ticks (table 23: hardness 3 x 30 / speed 4) |
| scan (radius 32, flat world + cave) | 1.96 to 2.18 ms per scan |
| `!mine stop` | heard by the bot 3 ticks after the console command; stopped **0 ticks** after hearing it, mid-dig; the ore being dug was still there 40 ticks later |

## Tests

| Test | What |
|---|---|
| `bot/test/unit/skills/mine.test.ts` | exposure (walls, two-deep, behind water), memory updates (digging exposes, mining forgets), targets order, line of sight and the blocker, names, the loop with fake skills: nearest first, lava skipped, buried ignored, done / low_health / no_pickaxe, blacklist after 3 failures, tunnel cap, sight digs, stop |
| `bot/test/e2e/mine-cave.test.ts` | the cave above, and `!mine` / `!mine stop` through the real chat commands from the server console |

```sh
node scripts/bds.mjs --profile farm up      # bds-farm, udp/19186
node scripts/bds.mjs --profile farm pack    # truth pack (truth:field / truth:crops are in it)
cd bot
BDS_E2E=1 pnpm exec vitest run --project e2e mine-     # about 65 s
```

Env: `FARM_BDS_HOST` (127.0.0.1), `FARM_BDS_PORT` (19186), `FARM_BDS_CONTAINER` (bds-farm),
`FARM_VERBOSE=1` (skill logs). Every run builds in its own random 64-block cell from x, z = 6144
(`FarmArea`), uses run-unique truth ids, and clears the area at the end.

## Open points

- The Digger chooses tools from the hotbar only: a pickaxe in the main inventory counts for
  `no_pickaxe` but is not used (`no_tool` blacklists the target). The survival kit (7.11) moves tools.
- Targets in unloaded chunks are remembered but not approached.
- `!stop` (PvE) does not stop `!mine`; the process manager (7.8) will.
- Not tested in a natural cave (deepslate, gravel ceilings, water): the rules are the navigator's.
