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
or `... no pickaxe`; `!mine stop` answers `mine coal_ore: stopped after 3/8`; `!mine status`
(`..., 12 seen (4 remembered)`). `!mine` stops a running `!farm` (they exclude each other).

**Track Z changes (decision 0021):** `!mine` is a user process; which ore is a target is the runtime
setting `mineSeenOnly` (default **off**: any ore the bot knows, tunnelling to it; on: the seen-face
rule below); seen ore is remembered across restarts in the world cache; an unreachable ore costs one
plan. Sections "As a process", "Candidates: `mineSeenOnly`", "Ore memory across restarts" and
"Unreachable ores" below.

## Files

| File | What |
|---|---|
| `bot/src/skills/mine/seen.ts` | `OreMemory` (the seen set, `known` blocks, `recall` / `scanMarks` / persistence through the world cache), `isOpen` / `openFaces` / `isExposed` (the exposure rule), `lineOfSight` / `firstHit` (voxel walk) |
| `bot/src/skills/mine/miner.ts` | `MineTask` (the loop, `pause` / `resume`, probe ranking, unreachable skip), `resolveTargets` (`coal` -> coal_ore + deepslate_coal_ore), `needsPickaxe`, `hasPickaxe`, `eyeGoal`, `noProgress` |
| `bot/src/skills/mine/wire.ts` | `createMinerFor(parts, { tunnelLen, seenOnly })`: MineTask with the bounded probe plan, Track R's blacklist, the navigator's `plan` and `breakBlocker` (what the chat commands use) |
| `bot/src/skills/farm/index.ts` | `createMiner(parts, { tunnelLen })`: the plain wave-6 wiring (no probe, no blacklist) |
| `bot/src/tasks/process/mine.ts` | `MineProcess` (Track Z) |
| `bot/src/chat/commands-farm.ts` | `!mine` (with `!farm`), `registerFarmCommands` (called from tasks/registry.ts), the passive ore scan |
| `bot/src/skills/mine/branch.ts` | wave 9 Track AI: branch mining (`branchMore`, the miner's hook when no target is known; `BranchRun`, the Y table `BRANCH_Y`), wired per bot by `attachBranch` in chat/commands-explore.ts |

## As a process (Track Z)

`!mine` adds a `MineProcess` (user priority 40) to the afk task's ProcessManager: guard / flee / night
/ a newer command pre-empt it (`MineTask.pause()`: the running goto / dig is cancelled at once; an
interrupted dig is not counted as a failure), it resumes with a fresh scan, `!pause` / `!resume` hold
and release it, `!stop` and `!mine stop` end it, `!status` lists it (`mine coal_ore 3/8 (dig, 1
skipped), eta 40 s`). It ends by itself (n mined, none left, low health, no pickaxe) and is dropped at
a death. The afk task's Hotbar and Containers are shared (no second Containers); `mineTunnelLen` and
`mineSeenOnly` come from the runtime settings.

A full inventory (fewer than 2 free slots, also at the start) pauses the task for the stash step (stash chest, a carried shulker box, junk dropped; `!get coal 4` is the front door for mining) and resumes it; still full ends the job `mine coal_ore: failed after 2/4 (inventory full)` (wave 8 Track AD, docs/get.md "Stash"). An ore within reach whose approach plan leads nowhere (buried under the floor) is no longer skipped as unreachable: its line of sight is dug instead (Track AD, one line in `mineOne`).

## Candidates: `mineSeenOnly` (owner decision 2026-10-29)

| `mineSeenOnly` | Targets of `!mine <block> n` |
|---|---|
| off (default) | every matching block the bot knows: the seen ones, the buried ones of the loaded chunks (the scan finds them anyway) and the world cache's marks of unloaded columns (approached through cached terrain, checked once loaded), nearest first, ranked by the probe plan; the bot tunnels to a buried one (navigator dig-through moves, then up to 3 line-of-sight digs) |
| on | only blocks with a seen face (the rule below), as in wave 6 |

The safety rules are the same either way: never next to water or lava (`next_to_liquid`), never
under sand or gravel, never the block under the feet, the tunnel cap `mineTunnelLen`. The setting
only chooses the candidate set; seen ore is recorded and persisted either way. "Legit" mining is an
option now, not the rule.

## The exposure rule (the seen-face rule, `mineSeenOnly` on)

BDS sends every block of a loaded chunk to the client, buried ores included (no anti-xray). With
`mineSeenOnly` on the bot keeps a rule of its own:

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
  positions are not targeted (no plan into unloaded world). Persisted in the world cache since Track
  Z (next section).

## Ore memory across restarts (Track Z)

Every record the OreMemory makes (scan, block update, own dig) flags the world cache's mark of that
block as **seen**: bit 1 of the mark's flags byte in the region record (format in
[world-cache.md](world-cache.md) "Seen marks"). So the records live per server (`<config
dir>/cache/<server id>/`) and survive a restart:

- `OreMemory.recall(origin, 96)` (run by every `!mine` scan) brings back the seen marks within 96
  blocks, loaded or not, as records of kind `cache`; a loaded position whose block is something else
  now is skipped. Remembered ore is a target with `mineSeenOnly` on too: it was seen once.
- A mark disappears with its block (mined, replaced), so the memory forgets it; a column that loads
  again keeps the flags of its remembered record.
- Passive recording: with a world cache attached, every 100 ticks (`oreScanTicks`) the mine controller
  runs `OreMemory.scanMarks(feet, 24)` over the cache's marks of the loaded columns (same exposure
  rule), so ores the bot only walks past are remembered too, without visiting every block.
- A block update can reach the memory before the cache has the mark; such records are flagged on the
  next passive scan.

Measured (`mine-memory`, bds-dig): run 1 (in process, cache in the CLI layout) recorded the 4 exposed
ores of a small cave in 1.9 to 2.5 ms and flagged 4 marks; after the restart a new CLI process
(`--set mineSeenOnly=on`) 48 blocks away (beyond the 32-block scan) got `!mine coal_ore 4`: the first
target was `coal_ore ... (cache, 46.0 blocks; 4 seen, 4 remembered)`, all 4 remembered ores were mined
24.7 to 28.6 s after the command (4 coal, truth), the 4 control ores built 48 blocks the other way
before the bot joined (never seen) were never touched.

## Unreachable ores (Track Z, coordinator request from the Realm log)

On the Realm every unreachable ore (behind water) cost three full goto attempts of about 3 s each
("no progress possible", 0 segments) before it was skipped. Now:

- the nearest `PROBE_CANDIDATES` (3) safe candidates are probed with a bounded plan (6 000 nodes /
  40 ms, `wire.ts`); the first whose plan leaves the start node wins. A probe without progress whose
  search was not cut short marks the ore unreachable at once; one cut short is taken only when no
  other candidate leads anywhere (then the full plan decides);
- the approach's full plan without progress (`none`, or a partial plan of one node) marks it
  unreachable without walking; a goto that ends without a single segment does too;
- unreachable = skipped for the rest of the session (`MineTask` keeps the set across runs) and put on
  Track R's navigator blacklist (all its failures at once, so the tree finder, the feller and later
  gotos skip it for 6 000 ticks). `stats.unreachable`, `stats.unreachableMs`, `stats.probes`.

Measured (`mine-cave`, bds-farm): two ores floating 7 blocks over the bot and one on the ground 10
blocks away: the ground ore first, both floating ones skipped as unreachable with 1 failed goto each
(the first walks under them), the whole run 12.9 s, 9 probe plans in 92 to 101 ms in total. Before,
each would have cost 3 failed gotos.

**Limits.** Exposure is not visibility: an ore facing a sealed air pocket inside the rock counts as
seen although no player could have looked into the pocket (the test cave's corridor is sealed on
purpose: the bot tunnels in). Water does not expose (an ore whose only open side is under water is
not seen); glass and leaves do not either (they have collision boxes). A stricter line-of-sight rule
for *targeting* would forget ores the bot walked past and was not used; line of sight is enforced
for the *dig* instead (below).

## The loop (`MineTask`)

1. Stop when `mined >= n` (`done`), health < 8 (`low_health`), or the next target needs a pickaxe and
   none is in the inventory (`no_pickaxe`).
2. Scan (and recall the cache's seen marks), then take the candidates of the asked names (seen ones,
   plus the known ones with `mineSeenOnly` off), nearest first, that are not blacklisted or
   unreachable and that the navigator's break rules allow (`breakBlocker`: not next to water or lava
   (6 neighbours), no sand / gravel on top, not the block under the feet, not protected). An unsafe
   target is reported in `stats.unsafe` with the rule and blacklisted. No target left: `none_left`.
   Of the nearest 3 the first whose probe plan leads somewhere is chosen (Track Z, "Unreachable ores").
3. Approach: `goto` a `near` goal on the **eye** (feet + 1.62) within 3.5 blocks of the target's
   centre, `allowBreak: true`. Before walking, `nav.plan` is asked for the route and its dig cells
   are counted; more than `mineTunnelLen()` (default 32) blacklists the target for this run; a plan
   without progress marks it unreachable. A target that was unloaded when chosen is checked once its
   chunk is loaded (another block there now: blacklisted).
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

## Branch mining (wave 9, Track AI)

Decision record: [decisions/0030-explore-and-branch-mining.md](decisions/0030-explore-and-branch-mining.md).
`!mine <ore> n` used to end `none_left` when the bot knew no such ore. Now, for a branch ore (coal,
iron, copper, gold, redstone, lapis, diamond, emerald, with their deepslate twins), the loop's dead end
calls `branchMore` (skills/mine/branch.ts, one line in `MineTask.run`): each call digs one step of the
layout and returns to the loop, which scans again, so the normal mine loop mines whatever the new cells
exposed (or, with `mineSeenOnly` off, whatever came within its 32-block scan). Chat:
`branch mining iron_ore: none known, digging down to y 16 (staircase from 5760 66 -2008)` when it
starts; at the end, besides the usual `mine iron_ore: 3/3 done`, `branch iron_ore: 3/3 in 148 s; iron at y
16: staircase 50 steps, tunnel 3 + 8 in 1 branches, 3 finds, 169 blocks dug` (plus the reason when the
layout ended it: `, 64 blocks of tunnel without iron (mineTunnelLen 64)`, `health 9`, `no pickaxe`,
`staircase blocked at ...`).

**The Y** (`mineBranchY`, text setting: `auto` or a whole number -64..320; a number applies to every ore):

| Ore | auto Y | Vanilla 1.18+ distribution (as of 1.21; Minecraft Wiki "Ore" and the worldgen `placed_feature` files `ore_*`) |
|---|---|---|
| coal | 40 | `ore_coal_upper` uniform 136..320 plus `ore_coal_lower` triangle 0..192 (peak 96, less air exposure lower down); 40 keeps it under most of the terrain in stone, well inside the lower band |
| iron | 16 | `ore_iron_middle` triangle -24..56, peak 16 (plus small veins uniform -64..72 and the mountain band 80..384) |
| copper | 48 | `ore_copper` triangle -16..112, peak 48 |
| gold | -16 | `ore_gold` triangle -64..32, peak -16 (badlands: extra uniform 32..256) |
| redstone | -58 | `ore_redstone_lower` triangle -96..-32 (peak -64, clipped at the world floor) plus uniform -64..15; -58 is the lowest level with no bedrock in the tunnel |
| lapis | 0 | `ore_lapis` triangle -32..32, peak 0 (plus buried uniform -64..64) |
| diamond | -58 | `ore_diamond` triangle -144..16 (peak -64, clipped), most at the floor; -58 like redstone |
| emerald | 232 | mountain biomes only, triangle -16..480, peak 232: used only when the bot stands at or above 232 (on a mountain); below that the run is skipped (`none_left` as before) |

**The layout** (absolute coordinates, so it continues after the miner walked off to an ore, a
pre-emption, the stash step or `!pause`):

| Part | Rule |
|---|---|
| direction | the cardinal direction the bot faces (`world.self.yaw`) |
| staircase | from the feet cell where the run starts to the Y: one block down (up when the Y is above) per step; per step 3 cells of the next column are cleared (the old head height, the old feet height, the new feet), so the body never goes straight down and the planner climbs back up the same stairs; a blocked step turns right, then left; both blocked: the run ends `blocked` |
| main tunnel | 2 high, in the staircase's last direction; blocked: turns right / left |
| branches | after every 3 blocks of main tunnel one branch to the left and one to the right, 2 high, up to 16 blocks; a blocked branch ends there; the bot walks back to the junction between them |
| dig rules | every cell passes the navigator's `breakBlocker` (not next to water or lava, no sand / gravel above, not the block under the feet, nothing protected); every new feet cell needs a solid dry floor (cave gaps turn the staircase) |
| ore in the way | a layout cell holding the asked ore is left to the miner once (the step returns, the scan finds it in the corridor wall, the loop mines and collects it); still there the next time: dug as a tunnel block |
| torches | `allowPlace` on and torches carried: one on the floor of the cell just left, every 8 blocks of tunnel |
| stop | n mined (the miner), `mineTunnelLen` tunnel blocks (main + branches) at the Y without a find, health below 10, no pickaxe, blocked |
| end | a run that ended by itself (not `!stop` / `!mine stop`) walks back to the staircase's top (`walking back to the surface`, a user process through the PvE walk, so trip readiness applies) and then home when a home point is set |

With `mineSeenOnly` off (the default) the scan sees buried ore through the rock, so the run tunnels to
the first ore that comes within 32 blocks while it digs down, which can be above the best Y; the
layout then continues from where it was. Branch mining in the classic sense (only the faces the tunnels
open count) is `mineSeenOnly on`; the e2e runs that way with `mineTunnelLen 64`.

### Measured (`explore-mine`, bds-explore, seed 7)

Setup: `mineSeenOnly on`, `mineTunnelLen 64`, a diamond pickaxe (an iron one, 250 uses, wore out
after about 270 blocks in one run: `stopped at 0/3, no pickaxe`); a start whose staircase is clear of
the dig rules' hazards, with no exposed iron near the way down and iron touching the planned tunnel
(the e2e picks it; see the test file). Staircase from y 64 to 73 down to y 16.

| What | Result |
|---|---|
| staircase | 47 to 60 steps, y 16 reached after 100.9 to 131.1 s (2.1 to 2.3 s per step of 3 blocks, the walk onto the step included); 0 turns in the selected starts |
| tunnel to 3 iron | 3 + 3 to 6 + 36 blocks of tunnel (1 to 4 branches; branches ended early under gravel twice), finds after 6 to 42 tunnel blocks |
| blocks dug by the layout | 163 to 263; cells opened in all (the miner's own tunnels to ore it saw in caves within 32 blocks included) 141 to 404 |
| whole run | `mine iron_ore: 3/3 done` 117 to 274 s after the command; back on the staircase's top 26 to 62 s later (163 to 330 s in all; the two gate runs 163.6 and 231.9 s) |
| dig rules (truth) | no water or lava next to any of the 141 to 404 opened cells in every run checked |
| drops | the miner's collect left drops in their holes in 2 of 7 runs before the hole walk existed (0 to 3 iron in the inventory); with it 3 to 6 raw iron in every later run |

Iron along a branch tunnel at y 16 (unbiased: every layout the e2e start search checked with
truth:find, 26 layouts of 60 tunnel blocks = 120 blocks dug): 2.65 iron blocks in or next to the
tunnel cells on average (4.4 per 100 blocks of tunnel, 2.2 per 100 blocks dug), 5.3 counting the rest
of the veins those belong to (what mining them uncovers); 10 of 26 layouts touched a vein of 3 or more.
With `mineSeenOnly off` the 32-block scan sees much more than that (every buried iron block in a
sphere of 32), which is why the default finds ore long before the tunnel level.

Seen on the way (not this track's modules, in Open points below): exposed ore in a cave 15 blocks below
the tunnel cost the miner about 10 minutes of failed gotos (the navigator does not dig down to it; each
target needs 3 failed gotos of 3 plans each); the bot fell into a pocket off the miner's own tunnel and
the plain walk up failed (the return walk now allows digging).

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
| Track Z: the cave case with `mineSeenOnly` on | `none_left` after 48.0 s, the same 8 mined, buried 4 never targeted, 4 pickup walks |
| Track Z: unreachable skip | see "Unreachable ores": 2 floating ores skipped, 1 failed goto each, run 12.9 s, probes 92 to 101 ms in total |
| Track Z: a buried ore behind 6 blocks of stone (a 10-thick wall, never exposed) | `mineSeenOnly` on: `none_left`, not targeted, still there; off: `done` after 16.8 to 17.1 s, 5 blocks tunnelled (3 of them line-of-sight digs), the ore gone, coal in the inventory |

## Tests

| Test | What |
|---|---|
| `bot/test/unit/skills/mine.test.ts` | exposure (walls, two-deep, behind water), memory updates (digging exposes, mining forgets), targets order, line of sight and the blocker, names, the loop with fake skills: nearest first, lava skipped, buried ignored, done / low_health / no_pickaxe, blacklist after 3 failures, tunnel cap, sight digs, stop |
| `bot/test/e2e/mine-cave.test.ts` | the cave above (`mineSeenOnly` on), and `!mine` / `!mine stop` through the real chat commands from the server console; Track Z: the unreachable skip and the buried-ore case with `mineSeenOnly` on / off |
| `bot/test/unit/skills/mine.test.ts` (Track Z) | buried ore targeted with `mineSeenOnly` off, one plan without progress = unreachable for the session and on the blacklist, a goto without segments, pause / resume, records persisted and recalled, `scanMarks` |
| `bot/test/e2e/mine-memory.test.ts` (Track Z, bds-dig) | ore seen in run 1 mined by a new CLI process from memory (see "Ore memory across restarts"); env `DIG_BDS_HOST` / `DIG_BDS_PORT` / `DIG_BDS_CONTAINER`, `MINE_VERBOSE=1` (the CLI's output) |
| `bot/test/unit/skills/branch.test.ts` (Track AI) | the Y table, layout geometry, BranchRun on a fake voxel world (staircase, tunnel, branches, turns at water / gaps / gravel, stop rules, the ore left to the miner, torches, the hole walk), `branchMore` (announce, end line, return) |
| `bot/test/e2e/explore-mine.test.ts` (Track AI, bds-explore) | `!mine iron_ore 3` with no iron known: staircase to y 16, branches, 3 iron picked up, back on the surface within 10 min, no liquid next to any opened cell (truth); env `EXPLORE_BDS_*` (docs/explore.md) |

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
- Seen targets in unloaded chunks are remembered but not approached; with `mineSeenOnly` off the
  cache's marks of unloaded columns are candidates (approached through cached terrain), not covered
  by an e2e yet.
- A floating / walled-off ore still costs one failed goto when the probe plan was cut short and the
  bot first walks under it.
- Not tested in a natural cave (deepslate, gravel ceilings, water): the rules are the navigator's.
- Wave 9 (Track AI): a seen ore deep below the bot in a cave the navigator cannot dig down to costs
  3 failed gotos of 3 plans (100 000+ nodes each) per target before it is blacklisted; measured about
  10 minutes for 6 such ores during a branch run. A cheap "is it below a solid floor I may not dig"
  check, or marking it unreachable after the first full goto without progress, would fix it (miner /
  navigator, not Track AI's files).
