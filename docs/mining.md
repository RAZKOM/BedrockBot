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

Chat (afk task with walking, owners only): `!mine <block> [n]` (n 1..9216, default 1) answers
`mining 8 coal_ore/deepslate_coal_ore` and at the end `mine coal_ore: 8/8 done`,
`mine coal_ore: 5/8, no seen coal_ore left (1 skipped as unsafe)`, `... stopped at 3/8, health low`
or `... no pickaxe`; `!mine stop` answers `mine coal_ore: stopped after 3/8`; `!mine status`
(`..., 12 seen (4 remembered)`). `!mine` stops a running `!farm` (they exclude each other).

**Track Z changes (decision 0021):** `!mine` is a user process; which ore is a target is the runtime
setting `mineSeenOnly` (default **off**: any ore the bot knows, tunnelling to it; on: the seen-face
rule below); seen ore is remembered across restarts in the world cache; an unreachable ore costs one
plan. Sections "As a process", "Candidates: `mineSeenOnly`", "Ore memory across restarts" and
"Unreachable ores" below.

**Track AQ changes (wave 10, decision 0038):** a cheap walk probe before every approach, then the walk
or a direct tunnel / shaft straight to the ore (blocked: skipped with the reason at once); veins mined as
one group with every drop collected; the job's kind of items within 8 blocks picked up before each
target; several kinds with quotas in one trip (`!mine iron_ore 8 coal_ore 16`, `!get ores 32`); setting
`mineDirect`. Section "Mining v3" below.

**Track BD changes (wave 11, decision 0043):** setting `mineMode` (default `baritone`): Baritone's
MineProcess, every known ore in one composite goal of column goals and one planner search with the dig
moves, the cheapest reachable ore first; "mine until n" (both modes): with nothing known the job branch
mines round after round instead of ending. Section "Mining v4" below; `!set mineMode v3` is mining v3.

## Files

| File | What |
|---|---|
| `bot/src/skills/mine/seen.ts` | `OreMemory` (the seen set, `known` blocks, `recall` / `scanMarks` / persistence through the world cache), `isOpen` / `openFaces` / `isExposed` (the exposure rule), `lineOfSight` / `firstHit` (voxel walk) |
| `bot/src/skills/mine/miner.ts` | `MineTask` (the loop, `pause` / `resume`, probe ranking, unreachable skip), `resolveTargets` (`coal` -> coal_ore + deepslate_coal_ore), `needsPickaxe`, `hasPickaxe`, `eyeGoal`, `noProgress` |
| `bot/src/skills/mine/wire.ts` | `createMinerFor(parts, { tunnelLen, seenOnly })`: MineTask with the bounded probe plan, Track R's blacklist, the navigator's `plan` and `breakBlocker` (what the chat commands use) |
| `bot/src/skills/farm/index.ts` | `createMiner(parts, { tunnelLen })`: the plain wave-6 wiring (no probe, no blacklist) |
| `bot/src/tasks/process/mine.ts` | `MineProcess` (Track Z) |
| `bot/src/chat/commands-farm.ts` | `!mine` (with `!farm`), `registerFarmCommands` (called from tasks/registry.ts), the passive ore scan |
| `bot/src/skills/mine/tunnel.ts` | Track AQ: `planTunnel` (the direct tunnel / shaft plan on the world model), `shaftRule`, `chooseTunnel`, `clearStep` (the step primitive, also branch mining's), `runTunnel`, `stairStep` / `flatStep` / `shaftStep`; Track BB: `tunnelCell` (the cell view from the shared rule set, nav/baritone/helper.ts) |
| `bot/src/skills/mine/vein.ts` | Track AQ: `veinFrom` (18-connected flood fill of one ore kind), `oreKind`, `veinCentre` / `veinRadius` |
| `bot/src/skills/collect/sweep.ts` | Track AQ: `sweepItems` (the floor sweep: one entity scan when nothing is near), `isWoodDrop`, `isFoodDrop` |
| `miner.ts` `jobDropNames` / `isJobDrop` | what a job's sweeps and hole walks pick up: the ore drops (`isMineDrop`) plus the job's own block kinds and what they drop (`BLOCK_DROPS`: stone to cobblestone, gravel to gravel and flint, grass to dirt ...). Before 2026-10-30 only ore drops counted, so `!get sand 256` left every sand item on the floor |
| `bot/src/skills/mine/baritone/mineProcess.ts` | wave 11 Track BD, ported from Baritone `MineProcess.java` (LGPL-3.0, `./LICENSE` points at nav/baritone/LICENSE): `coalesce`, `prune`, `plausibleToBreak`, `droppedItems`, `compositeOf`, the mine settings as constants |
| `bot/src/skills/mine/branch.ts` | wave 9 Track AI: branch mining (`branchMore`, the miner's hook when no target is known; `BranchRun`, the Y table `BRANCH_Y`), wired per bot by `attachBranch` in chat/commands-explore.ts |

## As a process (Track Z)

`!mine` adds a `MineProcess` (user priority 40) to the afk task's ProcessManager: guard / flee / night
/ a newer command pre-empt it (`MineTask.pause()`: the running goto / dig is cancelled at once; an
interrupted dig is not counted as a failure), it resumes with a fresh scan (a pre-emption during a
drop sweep or the end-of-job pickup goes back to the loop's wait, never out of `run()`: Realm
2026-10-30 the job was lost silently and the guard walked the bot home), `!pause` / `!resume` hold
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

This is the loop of mode `v3` (with Track AQ's approach below); mode `baritone` (the default since Track
BD) replaces steps 2 and 3 by one prune and one composite goto: "Mining v4" below. Both modes share
steps 1, 4 to 6 and "mine until n" (a dead end explores instead of ending `none_left`).

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
   dug cell, `collect` within 5 blocks for 120 ticks (approach radius 1.2; everything but the keeper's junk `DEFAULT_JUNK`, which the stash step throws away: rotten flesh it dropped was picked up again at every ore, 2026-10-31 Realm). The drop of an ore in a
   wall usually stays in the hole it left, where nobody can stand: when that collect picked nothing
   up, the bot walks to the standable cell right next to the hole (`stats.pickupWalks`), waits 15
   ticks for the server's pickup and collects once more. (Found in the second e2e run: 4 of 8 coal
   were left in their holes.)
6. Any failure counts against the target; 3 failures blacklist it.

Nothing is placed and nothing is lit. `stop()` bumps the run's generation and cancels the running
skill synchronously (the Digger sends `abort_break` on the next tick).

## Mining v3 (wave 10, Track AQ)

Decision record: [decisions/0038-mining-v3-tunnels-veins-batches.md](decisions/0038-mining-v3-tunnels-veins-batches.md).
The owner on the Realm, 2026-10-30: "why is it struggling so bad to mine through stuff to reach ores?
Shouldn't it just mine directly to the ores, break the group, pick them up, then proceed to the next
nearest group?", "it can 100% dig straight down", "if I say get wood, and drop wood on the floor it
should try to pick it up", and batching several ores into one trip. Files: `skills/mine/tunnel.ts`
(plan, rules, step primitive, run), `skills/mine/vein.ts` (flood fill), `skills/collect/sweep.ts` (the
floor sweep), the loop in `skills/mine/miner.ts`, the wiring in `skills/mine/wire.ts`.

### The approach: a cheap probe, then walk or tunnel

Before every approach (setting `mineDirect`, default on) the miner asks for a walk without digging: a
bounded probe plan (home logistics' `probePath`: 4 000 nodes, 300 ms of search, sliced with yields, so
physics never waits). A path that is at most 3 x the straight line + 8 blocks is walked (the approach
of wave 9, dig-through allowed). No path, or a longer detour: the direct tunnel. An ore that cannot be
reached costs one probe and one tunnel plan (the whole verdict in 0 to 20 ms in the e2e) instead of
three full plans of 100 000 nodes and their gotos. `mineDirect off` is the wave-9 approach.

### Direct tunnels (`tunnel.ts`)

| Step | Cells dug (top first) | Note |
|---|---|---|
| flat | the head and feet cells of the next column | horizontal tunnels into walls: the default |
| up | the head room over the old head, the next column's head and feet one higher | a staircase up, never a pillar |
| down | the next column at the old head height, the feet height and one lower | a diagonal staircase the walk planner climbs back |
| shaft | the block under the feet | the bot stands on what it digs and drops into it (owner, 2026-10-30) |

- **Planned whole before the first dig**, on the world model: each step the one that brings the feet
  closest to where the ore can be mined from (ore at feet or head height beside the feet), never back
  the way it came; with more height than ground to cover it turns right / left every step (a 2 x 2
  spiral), so an ore straight below is reached by stairs too. The plan ends when the eye is within 4.5
  of the ore with a clear line of sight, or when the ore (or another block of the asked kinds) is the
  next cell to dig: the miner's sight digs and dig take over.
- **Rules for every cell**: the navigator's break rules (`nav.breakRules()`, `breakBlocker` without the
  under-feet rule; since wave 11 Track BB one shared rule set, `nav/baritone/helper.ts` `avoidBreaking`,
  the table in docs/pathfinding.md "Rules"): the protected area around home (`protectRadius`), built blocks
  (`isBuiltBlock`) and containers, liquid in or next to the cell, a gravity block over it (or an
  unsupported one beside it), ice, infested and unknown blocks. The planner's cell view (`TunnelCell`:
  open / solid / hazard) comes from the same set (`tunnelCell`: Baritone's `canWalkThrough` / `canWalkOn` /
  `avoidWalkingInto`): a ladder's or vine's cell counts as open (walked through, not dug; before Track BB a
  ladder was a block to dig), and a hazard without a box in the line (fire, a berry bush: "air" to the break
  rules) ends the plan with `hazard at x y z` instead of being walked into. A cell the way back
  stands on is never dug; every new feet cell needs a solid dry floor (a step blocked only by the shape
  of the ground may go one step round, e.g. walk to the hill's foot first). The first blocked cell ends
  the plan and the ore is skipped with the reason (`tunnel blocked: protected at 70965 -59 70296`) before
  anything is dug. Every cell is checked again on the live world right before its dig. A straight line
  blocked by a liquid falls back to the dig-through walk (same rules; it may go around); a protected block
  does not.
- **Shafts**: extra rules before each block: the block below known and solid (never into a cave or an
  unknown block), no liquid in the column or its 4 side neighbours 1 or 2 blocks below, no pointed
  dripstone in the 3 x 3 below within 3 blocks, no gravity block over the shaft's top, never within 2
  blocks of the world's floor. The staircase plan is taken unless the shaft plan digs 8 or more blocks
  fewer (`SHAFT_SAVES`); the shaft goes horizontal to the ore's column first, then down. A shaft needs a
  way back before it starts: throwaway blocks for a pillar (depth + 4) or a staircase up from its bottom
  (planned too). When the shaft is the short way and finds a hazard under the ore (liquid, dripstone, a
  cave), the ore is skipped with that reason instead of a long staircase down beside it.
- `mineTunnelLen` caps the planned blocks of one tunnel (plan longer: skipped for the run).
- **Back up**: a run that tunnelled below its first tunnel's start goes back there at its end (done or
  nothing left): the walk (staircases are climbable), a pillar with throwaway blocks (the navigator's
  pillar-up moves), or a staircase dug up (`planTunnel` with a feet goal).
- **One primitive**: `clearStep` digs the direct tunnels and branch mining's staircase and tunnels
  (`BranchRun.doStep`); `stairStep` / `flatStep` live in tunnel.ts (branch.ts re-exports them).

### Veins (`vein.ts`)

After the first block of a vein the group is the flood fill of the same kind through face and edge
neighbours (18-connected; deepslate twins and lit redstone count as one kind; at most 64 blocks). The
miner takes it from where it stands: the nearest block in reach (4.6) and in sight, a line-of-sight dig
(same rules) when one is in reach but hidden, a step into the vein's own holes (no digging) when the
next block is out of reach; no scan or re-plan between blocks; it stops when the kind's quota is met.
Then one collect over the whole group and a walk into each hole whose drop is still there (the rock over
a hole without head room is dug first when the rules allow). `!status`: `mine diamond_ore 3/7 (dig, 0
skipped, vein 3/7)`; `stats.veins` has each group (size, mined, first and last block, collected).

### Produce on the floor (`collect/sweep.ts`)

Before it chooses its next target every work job picks up its own kind of items within 8 blocks (its
own drops left behind, what the owner dropped): mine (ore drops), gather wood (logs, saplings, sticks,
apples: `!get wood` with logs on the floor takes them before a tree), food (food items, leather,
feathers, wool). Nothing of the kind near: one scan of the entities, no collect call, no grace wait (the
miner's old per-target sweep waited 10 ticks every time). Before the job ends the miner also walks into
the holes of its run whose drop is still there. Farm and build are not wired (not this track's files).

### Several kinds in one trip

`!mine iron_ore 8 coal_ore 16 diamond_ore 4` (and `!get iron 8 coal 16`, `!get ores 32`, docs/get.md):
one job with a quota per kind. The candidates are the kinds still below their quota, nearest first across
kinds from wherever the bot stands; a kind drops out when its quota is met; the job ends when every
quota is met or nothing is left. `ores` is every ore kind with one quota. Status `mine: iron 5/8, coal
16/16, diamond 0/4 (dig, 0 skipped)`, start `mining in one trip: 8 iron_ore, 16 coal_ore, 4 diamond_ore`,
end `mine iron+coal+diamond: iron 8/8, coal 16/16, diamond 4/4 done`. The NL step `mine` takes
`more: [{block, count}]`. One kind behaves as before.

### Settings

| Setting | Default | What |
|---|---|---|
| `mineDirect` | on | the walk probe and the direct tunnels / shafts; off: the wave-9 approach (dig-through walk only) |
| `mineTunnelLen` | 32 | blocks of one direct tunnel at most (and branch mining's tunnel without a find) |
| `digPenalty`, `protectRadius` | 60, 48 | (2026-10-30, navigator) every dug block of a walk costs 60 ticks; nothing is dug within 48 of home; built blocks never: the tunnels obey the same rules |

### Measured (Track AQ, BDS 1.26.60.6)

e2e `mine-tunnel`, `mine-vein` (bds-dig, flat, truth-built shapes) and `mine-rock` (bds-explore, seed 7) on
2026-10-30. "Before" is the code before Track AQ (`MINE_BEFORE=1`: the same cases, no assertions); "after"
two runs where both are given.

| Case | Before (wave 9) | After (Track AQ) |
|---|---|---|
| ore 4 under the floor, 4 across | not reached: unreachable after 0.5 s | staircase of 12 blocks, mined at 10.6 / 10.6 s, back on the floor 2.7 s later (job 15.7 / 15.7 s) |
| ore 8 into a wall at head height, iron pickaxe | mined at 9.3 s (7 blocks dug through + 3 sight digs, a walk around the wall's side; job 25.3 s) | straight tunnel 14 blocks in 11.3 / 11.3 s = 74 / 74 blocks per minute, mined at 12.2 / 12.2 s (job 14.5 / 14.5 s) |
| the same, netherite pickaxe | mined at 8.1 s (job 24.1 s) | 14 blocks in 9.1 / 9.3 s = 92 / 90 blocks per minute, mined at 9.7 / 9.9 s (job 12.1 / 12.3 s) |
| ore 6 up inside a hill, 4 in | not reached: unreachable after 7.45 s (1 failed goto) | staircase up of 11 blocks, mined at 10.8 / 11.0 s, no block placed |
| ore 10 straight down (stone tower) | not reached: unreachable after 0.5 s | shaft 9 blocks in 7.4 / 7.5 s = 73 / 72 blocks per minute down, mined at 8.3 / 8.4 s; pillar back up 10 blocks in 6.1 / 6.1 s = 98 blocks per minute (cobblestone carried); the staircase back without throwaway blocks is unit-tested only |
| the same, lava 2 under the ore | (unreachable after 0.5 s) | skipped in 0.00 / 0.01 s: `tunnel blocked: liquid_below at x -60 z`, nothing dug |
| the same, dripstone cave under the ore | (unreachable after 0.5 s) | skipped in 0.00 s: `tunnel blocked: dripstone_below at x -61 z` |
| stone bricks in the tunnel's line | the dig-through walk went around the brick (mined) | skipped in 0.02 s: `tunnel blocked: protected at ...`, nothing opened, brick and ore intact |
| water over / lava under the line, 2 ores | both mined (43.5 s), no liquid next to an opened cell | straight line blocked (`next_to_liquid`), the walk mined one, a 6-block tunnel round the other side the second (28.9 / 29.0 s), no liquid next to any opened cell (truth:find) |
| unreachable verdict (ore walled in by stone bricks under the floor) | 0.49 s (one bounded probe + one full plan in-thread; the flat test world is small) | 0.00 s (probe 1 ms + tunnel plan); the Realm log before: 10 minutes for 6 ores (3 failed gotos of 3 plans each) |
| 7-block diamond vein in a wall, plain iron pickaxe | 17.8 s from the first to the last block, a re-scan between blocks, 6 of 7 diamonds picked up (job 32.5 s) | one group (`vein 7/7`), 9.0 / 9.1 s first to last, 7 of 7 diamonds (truth), job 12.0 / 12.0 s |
| 4 logs spawned 5 blocks away, `gather 4`, no tree | failed after 5 s (`no trees within 16 blocks`), 0 logs | done in 1.2 / 1.1 s, 4 logs (truth) |
| 4 iron + 6 coal + 2 diamond within 20 blocks | three single jobs: 154.3 blocks walked, 76.0 s | three single jobs (new code) 152.0 / 156.3 blocks walked in 63.1 / 64.4 s; one job `!mine iron_ore 4 coal_ore 6 diamond_ore 2`: 112.3 / 105.9 blocks in 57.2 / 53.1 s (28 % / 32 % less walking), nearest first across kinds (`iron diamond coal iron iron diamond coal coal iron coal coal coal`), 4 raw iron, 6 coal, 2 diamonds (truth) |
| bds-explore: `!mine iron_ore 4` from a cave, iron 5 to 10 into the rock | (not run) | `4/4 done` in 89.7 / 23.7 s (run 1: a staircase of 9, a shaft of 17, a pillar of 13 back up; run 2: a staircase of 14 to a vein of 4, walked back up), 4 raw iron, no liquid next to the 33 / 21 opened cells; two earlier runs (44.8 and 52.4 s) left one drop in a hole without head room: fixed by digging the rock over the hole and the end-of-run hole walk |

The walk probe costs 1 to 21 ms on the flat world (3 probes in 53 ms in the cave). The direct tunnel's
pace (73 to 74 blocks per minute with iron, 90 with netherite on stone) includes the walk into each new
cell; the Digger's break time alone is 8 / 5 ticks per stone block.

## Mining v4: MineProcess (Track BD)

Wave 11, the Baritone port (decision 0043; Baritone `23723891`, LGPL-3.0, THIRD_PARTY_NOTICES.md).
Setting **`mineMode`** (`v3` | `baritone`, default `baritone` since this track, see "Default" below). Mining v3 joins three
planners by hand-tuned thresholds (the walk probe, the "3 x straight line + 8" detour rule, the straight
tunnel / shaft planner with `SHAFT_SAVES` and `mineTunnelLen`, the sight-dig fallback) and picks one
target at a time. Baritone's `MineProcess` puts every known ore into one `GoalComposite` of column goals
and runs the normal pathfinder, where digging is a move cost (Track BC's dig moves): tunnels, staircases
and shafts fall out of one search and the planner picks the cheapest reachable ore by itself.

Files: `bot/src/skills/mine/baritone/mineProcess.ts` (ported: `coalesce`, `internalMiningGoal`,
`prune`, `plausibleToBreak`, `isNextToAir`, `droppedItems`, `goalComposite`, the settings as constants),
the goals `twoBlocks` / `threeBlocks` in `nav/goals.ts` (Baritone `GoalTwoBlocks` /
`MineProcess.GoalThreeBlocks`; `any` is `GoalComposite`; mirrored in `nav/worker.ts`, keyed by the ore
block in `nav/blacklist.ts`), the loop in `mine/miner.ts` (`// Track BD` blocks: `mineComposite`,
`gotoComposite`, `pruneNow`, `dugOnTheWay`, `nothingKnown`), `mine/tunnel.ts` `shaftHazard` (the hazard
half of `shaftRule`, shared).

### The loop in mode `baritone`

1. Stop rules as before (n mined, health, no pickaxe for the heading ore).
2. Scan, then **prune** the memory's candidates (`OreMemory.targets` under the current `mineSeenOnly`)
   and the job's dropped items: dedupe; a loaded position that is not an asked block any more is
   dropped; `plausibleToBreak` (rule table) refuses with the reason (reported once in `stats.unsafe`,
   blacklisted); the Y limits; the blacklists (the run's, the session's unreachable set, Track R's
   navigator blacklist); nearest first by our estimate (octile distance of the columns + the height
   difference); at most 64 (`mineMaxOreLocationsCount`). An ore no hotbar tool harvests (`canHarvest`,
   the Digger's rule: diamond with a stone pickaxe) is no candidate; when only such ores are left the job
   ends `no_pickaxe` (`no tool in the inventory harvests diamond_ore`; any slot counts, the Digger pulls a main-inventory pickaxe into the hotbar; with another wanted kind still harvestable the job explores for that one instead), and an ore the walk digs counts only
   while a harvesting tool is carried.
3. **One goto** to the composite of every candidate's goal (`coalesce`: `threeBlocks` = the feet in the
   ore's cell or one / two below it, `twoBlocks` when a gravity block sits on the ore; a drop: its
   cell), `allowBreak` and **always `allowPlace`**, whatever the owner's `allowPlace` setting for walks
   (the dig-down move needs the pillar back up; the navigator drops place without throwaway blocks;
   no block is placed inside `protectRadius` of home, in the thread and the worker alike), planned
   in the planner worker when one is attached. Every 40 ticks on the way (`MINE_GOAL_UPDATE_TICKS`;
   Baritone 5) the memory is scanned and pruned again; the member the body heads for gone (mined,
   blacklisted, something else) cancels the walk and the loop builds a new composite.
4. On arrival: the reached member (`GotoReport.reached`) is mined as in v3 (`takeOre`: line-of-sight
   digs, `requireHarvest`, the vein from it, the collect and the hole walk); an ore the walk dug itself
   (the feet in its cell) counts as mined, and so does any other ore of the composite the path dug on
   the way (`dugOnTheWay`; found in the e2e: the cave's ores were dug by the path to their neighbour,
   3 raw iron picked up and 1 counted). A drop member whose collect gains nothing counts as a failure
   (3 blacklist it), so the same drop goal does not come back forever.
5. Failures: a goto that never got a segment or whose last plan found no path (no path to any member)
   blacklists the candidate nearest the feet by straight line for the session (Baritone
   `blacklistClosestOnFailure`); a second such goto in a row from the same feet cell blacklists every
   member of its composite for the run (ours, 2026-10-31: one member per round spun the bot in place for
   15 minutes over 64 members; the next round takes other ores or explores); any other failure
   counts against the heading member, 3 failures blacklist it (ours).
6. Nothing left after prune: "mine until n" (next section).

Not used in mode `baritone` (left intact for `v3`): the walk probe, the detour ratio
(`WALK_DETOUR` / `WALK_SLACK`), `SHAFT_SAVES`, `mineTunnelLen` for the approach, the straight tunnel
planner. Kept from v3: the floor sweep before each target, the vein, the drop pickup walk, `returnUp`
(the climb back to where the first dig below the start began), pause / resume / stop (a pause during a
sweep keeps the job), `protectRadius` and built blocks.

### Mine until n (both modes)

When prune (or v3's candidate list) leaves nothing and the job is below n, the job does not end: it
runs the explore fallback, which is our existing branch mining (`mine/branch.ts` `branchMore`, wired by
`attachBranch`; Baritone's `exploreForBlocks` / `GoalRunAway` branch point is not ported, see the rule
table), one layout step per loop pass with a rescan after each. The memory learning ore ends the
round and mining resumes; the next dead end starts round + 1 (a round counts once the explorer took a
step; the same branch run continues where it
was). `none_left` only when the explorer itself gives up (its own budget: `mineTunnelLen` blocks of
tunnel at the Y without a find, blocked, health, no pickaxe, or not a branch ore). The status line
while exploring: `mine iron_ore 212/1000: exploring (round 3, 420 blocks)` (`!status`, `!get status`);
the end line says how far it explored: `mine iron_ore: 212/1000, no seen iron_ore left, explored 3
rounds (420 blocks dug)`.

### Rule table (Baritone vs ours)

| Baritone (`MineProcess.java` / `Settings.java`) | Ours | Kept | Why |
|---|---|---|---|
| `coalesce` with `forceInternalMining` false: `GoalThreeBlocks` unless a `FallingBlock` is above, then `GoalTwoBlocks` | same (`coalesce`); the `forceInternalMining` branch ported too (unit-tested, off) | Baritone's | the goal shape is the point of the port |
| `GoalComposite` (heuristic = min over members) | our `any` goal (already the same) | the same | |
| `GoalThreeBlocks` / `GoalTwoBlocks` heuristic: `GoalBlock.calculate` (xz + y part) | `columnH`: max(octile, levels to the feet range), plus the levels beyond 4 priced from our costs (docs/pathfinding.md "Goals") | Baritone's (y part taken, 2026-10-31) | octile only scored a body straight over an ore 0: no partial path ever left the start (Realm, coal 13 below) |
| `mineGoalUpdateInterval` 5 ticks, re-validates the whole goal | 40 ticks; re-plans only when the heading member is gone | ours | a scan is 2 ms on the main thread and a changed composite re-plans in the worker; every 5 ticks would cancel more walks than it finds ore |
| `mineMaxOreLocationsCount` 64 | 64 | Baritone's | |
| sort by straight-line `distSqr` from the feet | octile of the columns + height difference | ours | a walk-cost estimate; an ore 8 down ranks behind one 8 across |
| `blacklistClosestOnFailure` (true): no path, the closest known ore put on the process' own blacklist | same rule; ours (`markUnreachable`) is broader: skipped for the whole session (across `!mine` jobs) and put on Track R's navigator blacklist (6 000 ticks, every other skill skips it too) | Baritone's rule, our reach | the Track Z unreachable rule: an ore with no path is not worth a second plan in this session; plus ours: 3 failures of the same cell blacklist it |
| `plausibleToBreak`: `getMiningDurationTicks < COST_INF` and not `avoidBreaking`; not bedrock above and below | the shared rule set (`breakRule`: `breakBlocker` without the under-feet rule: liquid beside, gravity above, unknown, `protectRadius`, `isBuiltBlock`) + Baritone's bedrock rule + the shaft hazards under a candidate below the feet (`shaftHazard`: a liquid 1-2 below, dripstone within 3 below) | ours (stricter) | rule 6: the owner's rules by name; Baritone's `MovementDownward` / `MovementFall` are less careful |
| `allowOnlyExposedOres` + `allowOnlyExposedOresDistance` 1 (`isNextToAir`) | `mineSeenOnly` (off by default: buried ore too); the memory's 6-neighbour exposure rule | ours | the owner's setting; both modes gated |
| `legitMine`, `legitMineYLevel`, `legitMineIncludeDiagonals` (mine only what is seen, strip-mine at a Y) | not ported: `mineSeenOnly on` + branch mining (`mineBranchY`) | ours | the same behaviour exists, measured (Track AI) |
| `exploreForBlocks` (true): `GoalRunAway` from a branch point at `legitMineYLevel` | branch mining (`branchMore`) round after round | ours | reuse, not a second explorer; ours digs a planned layout under the dig rules |
| `minYLevelWhileMining` / `maxYLevelWhileMining` (0 / 2031) | constants -64 / 320 | ours | the overworld's limits |
| `mineScanDroppedItems` (true) + `droppedItemsScan`; a drop within 3 blocks of a plausible ore is not its own goal | same over the entity list with the job's drop names (`isJobDrop`), radius = the scan radius | Baritone's | |
| `mineDropLoiterDurationMSThanksLouca` (keep a mined position as a goal while its drop may still land) | the collect after each dig, the hole walk, the floor sweep, the end-of-job pickup | ours | measured since Track AQ (7 of 7 diamonds) |
| `WorldScanner` / `CachedWorld` (`maxCachedWorldScanCount`), unloaded positions kept | the ore memory (`seen.ts`, recall from the world cache); unloaded (cached) candidates kept, never read | the same rule | rule 7: never a block outside the world model |
| in goal: `MineProcess` turns to and breaks every known ore it can reach | `takeOre`: line-of-sight digs, `requireHarvest`, the vein flood fill; `dugOnTheWay` counts ores the path took | ours | the Digger and the vein are measured |
| `notificationOnMineFail` | the `!mine` end line with the skip reasons and how far it explored | ours | chat replies |
| path costs (`ActionCosts`, Java break times) | `nav/costs.ts`, `digPenalty` 60 ticks per dug block | ours | rule 5: our Bedrock tick costs are measured |

### Default

**`baritone` since Track BD** (flipped in the same track after the gate below passed: `mine-baritone`
twice, mode baritone mined as many ores as v3 in less time with `mineSeenOnly` off and on, and the
regression suites `mine-cave`, `mine-tunnel`, `mine-vein`, `mine-memory`, `mine-rock`, `explore-mine`
passed in both modes; `gaunt-mine` was not run, its container is not this track's). `!set mineMode v3`
brings back mining v3, whose code stays until the cleanup track. The library default without the option
(`createMinerFor(parts, {})`, `new MineTask(deps)`) is still v3, so the unit and e2e tests that do not
name a mode keep measuring v3; the chat command and `!get` read the setting.

### Measured (Track BD, BDS 1.26.60.6)

e2e `mine-baritone` (bds-bari, flat, truth-built, planner worker attached) on 2026-10-30: one 17 x 17 x 15
stone block with 14 iron ores at depths 2 to 9 (one straight under the start under 3 blocks of stone, one
beside a 2-cell lava pocket, one under gravel, a 5-ore vein 6 to 7 deep, 3 in the walls / floor / ceiling
of a closed cave 7 to 8 deep, singles 2, 6 and 8 deep), `!mine iron_ore 20`-shaped jobs (none_left once
the block is mined out), 3 runs per mode and setting, the suite run twice (6 runs per cell in all).
"Skipped" counts the lava and gravel ores (plus the previous row's lava ore, still in the world model).

| `mineSeenOnly` | Mode | Ores mined (each run) | Time (mean of 6) | s per ore | Failed gotos | Unreachable | Digs (cells) | Placed | Lava / gravel ore |
|---|---|---|---|---|---|---|---|---|---|
| off | v3 | 12 x 6 | 114.4 s (108.9 to 116.7) | 9.5 | 0 to 1 | 0 to 2 | 71 to 82 | 0 | skipped (`next_to_liquid`, `gravity_above`), intact |
| off | baritone | 12 x 6 | 85.9 s (85.4 to 87.0) | 7.2 | 0 | 0 | 45 | 16 (pillars back up from the deep members) | skipped, intact |
| on | v3 | 3 x 6 (the cave) | 33.5 s (31.6 to 36.5) | 11.2 | 0 | 0 | 14 | 5 | not candidates, intact |
| on | baritone | 3 x 6 | 26.8 s (24.3 to 28.8) | 8.9 | 0 | 0 | 8 to 9 | 6 | not candidates, intact |

Mode baritone: 8 composites of 52 members in all per run with `mineSeenOnly` off (3 of 6 with it on),
25 rescans on the way, 0 to 2 re-plans, 6 ores taken by the walk's own digs (2 with it on). The first
smoke run counted 1 of 3 cave ores (3 raw iron picked up): the path to one cave ore dug the other two;
fixed by `dugOnTheWay`. No rockets, no liquid touched. After the review fixes (no place move inside `protectRadius`, the harvest rule, the drop
failure) a third run gave the same picture: `mineSeenOnly` off v3 109.9 s / baritone 85.9 s for 12 ores,
on v3 34.6 s / baritone 27.4 s for 3; `mine-tunnel` in mode baritone 10 / 10 with the same times.

The regression suites in both modes (`MINE_MODE=v3` / `baritone`; bds-dig for the first four, bds-explore
for the last two):

| Suite | v3 | baritone |
|---|---|---|
| `mine-tunnel` (10 cases) | 10 / 10 | 10 / 10 (after two fixes, below); ore 4 under the floor 14.4 s, 8 into a wall 14.5 s (iron) / 13.0 s (netherite), 6 up in a hill 13.3 s (staircase, nothing placed), 10 straight down 15.6 s (pillar back up 10 placed), lava / dripstone under the ore skipped in 0.0 s with the reason, stone bricks in the line: dug round them (v3: skipped by design), water / lava by the line: both ores mined in 21.4 s, no liquid next to an opened cell; the brick-walled ore's unreachable verdict 8.2 s (v3 0.0 s: one failed composite plan in the worker instead of the probe) |
| `mine-vein` (3) | 3 / 3; vein 7/7 first to last 9.1 s; one job 61.8 s / 115.4 blocks walked | 3 / 3; vein 7 mined, first to last 9.0 s; one job 53.4 s / 104.5 blocks |
| `mine-memory` (1) | pass | pass: 4 remembered ores mined 29.0 s after `!mine`, the first composite's nearest member 47 blocks away, control ores untouched |
| `mine-cave` (4) | 4 / 4 | 4 / 4; the two floating ores unreachable after 9.5 / 9.6 s, 0 failures (after the fix below) |
| `mine-rock` (1) | 4/4 in 10.6 s | 4/4 in 19.2 s (a 64-member composite; another start in the generated world) |
| `explore-mine` (1) | pass | pass |

Fixes the gate found: (1) without the planner worker attached (the e2e helpers' default) the in-thread
plan budget cut the dig-heavy composite searches short (hill, shaft: "unreachable" after 2.7 s); the
suites attach the worker in mode baritone, as the Realm bot does (`plannerThreads` 1). (2) A goto that
walked and then found no path (two ores floating over the bot) counted 3 failures per ore; a last plan
with status `none` now counts as Baritone's `calcFailed` and blacklists the closest member at once.

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
| `bot/test/e2e/gaunt-mine.test.ts` (bds-gaunt) | `!mine sand 32` on 12 2 x 2 sand patches, guard on, home 90 blocks away: a zombie summoned at the loop's drop sweep pre-empts it, the job resumes and ends `done` 32/32 with no home return (twice); the unfixed code ended `paused after 8/32` and walked home |
| `bot/test/e2e/mine-cave.test.ts` | the cave above (`mineSeenOnly` on), and `!mine` / `!mine stop` through the real chat commands from the server console; Track Z: the unreachable skip and the buried-ore case with `mineSeenOnly` on / off |
| `bot/test/unit/skills/mine.test.ts` (Track Z) | buried ore targeted with `mineSeenOnly` off, one plan without progress = unreachable for the session and on the blacklist, a goto without segments, pause / resume, records persisted and recalled, `scanMarks` |
| `bot/test/e2e/mine-memory.test.ts` (Track Z, bds-dig) | ore seen in run 1 mined by a new CLI process from memory (see "Ore memory across restarts"); env `DIG_BDS_HOST` / `DIG_BDS_PORT` / `DIG_BDS_CONTAINER`, `MINE_VERBOSE=1` (the CLI's output) |
| `bot/test/unit/skills/branch.test.ts` (Track AI) | the Y table, layout geometry, BranchRun on a fake voxel world (staircase, tunnel, branches, turns at water / gaps / gravel, stop rules, the ore left to the miner, torches, the hole walk), `branchMore` (announce, end line, return) |
| `bot/test/e2e/explore-mine.test.ts` (Track AI, bds-explore) | `!mine iron_ore 3` with no iron known: staircase to y 16, branches, 3 iron picked up, back on the surface within 10 min, no liquid next to any opened cell (truth); env `EXPLORE_BDS_*` (docs/explore.md) |
| `bot/test/unit/skills/mine-tunnel.test.ts` (Track AQ) | fixture worlds: tunnel geometry (horizontal, staircase down / up, spiral, another ore in the line), every dig rule, every shaft rule (liquid / dripstone / cave / unknown below, gravity over the top, world floor), staircase vs shaft, the climb-back plan, runTunnel's re-check, clearStep's defer, the vein fill, the sweep |
| `bot/test/unit/skills/mine-v3.test.ts` (Track AQ) | the MineTask loop: probe then walk / tunnel, a long detour tunnels, a blocked tunnel skips at once with the reason, `mineDirect` off, shaft + pillar back, shaft + staircase back, lava under the ore, veins as one group (status, one collect, quota), several kinds nearest first, `ores`, `!mine` / `!get` forms, the NL steps |
| `bot/test/e2e/mine-tunnel.test.ts` (Track AQ, bds-dig) | ore 4 under the floor (staircase, back on the floor), 8 into a wall (iron and netherite pickaxe), 6 up in a hill, 10 straight down (shaft, pillar back), lava / dripstone under the ore, stone bricks in the line, water / lava by the line (no liquid next to an opened cell, truth), the cheap unreachable verdict; `MINE_BEFORE=1` runs it without assertions |
| `bot/test/e2e/mine-vein.test.ts` (Track AQ, bds-dig) | a 7-block diamond vein (one group, 7 diamonds, truth), logs spawned 5 blocks away picked up by the gather job, `!mine iron_ore 4 coal_ore 6 diamond_ore 2` against three single jobs (walked distance) |
| `bot/test/unit/skills/mine-baritone.test.ts` (Track BD) | `coalesce` (the three goal shapes, the asked block above / below, `forceInternalMining`), the goals in the planner (done set, heuristic, blacklist key), `prune` (loaded, still ore, protected, built, beside lava, gravity above, bedrock, the shaft hazard below, Y limits, blacklist, nearest N by estimate, dropped items), the loop in mode baritone (buried ore with `mineSeenOnly` off / not with on, the real planner digging to it, ore dug by the walk, another ore dug on the way, quotas, `blacklistClosestOnFailure` with and without segments, the rescan interval and re-plan, the rules at prune time, no pickaxe, the setting), mine until n in both modes (explore -> ore learnt -> mined -> explore again -> done), a pause during a sweep keeps the job |
| `bot/test/unit/skills/nav-goals.test.ts`, `nav-worker.test.ts` (Track BD cases) | `twoBlocks` / `threeBlocks` done sets, heuristic and key; 20 mine-shaped composite queries (buried members with `mineSeenOnly` off, exposed with it on) plan identically in the worker (status, cost, expansions, length, break set, member) |
| `bot/test/e2e/mine-baritone.test.ts` (Track BD, bds-bari) | the stone block of "Mining v4: Measured" in both modes x both `mineSeenOnly`, 3 runs each, then mode baritone against v3 on ores and seconds per ore (within 10 %); env `BARI_BDS_*`, `MINE_BARI_RUNS` (3) |
| `bot/test/e2e/mine-rock.test.ts` (Track AQ, bds-explore) | `!mine iron_ore 4` from a cave with the iron 5 to 10 blocks into the rock (start chosen with truth:find): done within 5 min, 4 raw iron (truth), no liquid next to an opened cell |

Track AQ's e2e run on bds-dig (`DIG_BDS_*`, `farm-truth.ts connectFarmBot(prefix, { target, container })`)
and bds-explore (`EXPLORE_BDS_*`); `mine-cave` runs on bds-dig too with `FARM_BDS_PORT=19148
FARM_BDS_CONTAINER=bds-dig`. Track BD: `MINE_MODE=v3` / `baritone` runs `mine-cave`, `mine-tunnel`,
`mine-vein`, `mine-memory`, `mine-rock` and `explore-mine` in that mode (unset: the createMinerFor
suites run v3, the CLI suites the setting's default); in mode baritone the createMinerFor suites attach
the planner worker and v3's own tunnel-plan assertions are skipped.

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

- Track BD: `gaunt-mine` (bds-gaunt) and the `!get` e2e suites were not run in mode baritone (not this
  track's containers); the pause-during-a-sweep rule is unit-tested in mode baritone.
- Track BD: the unreachable verdict in mode baritone is one failed composite plan in the worker (8.2 s for
  a brick-walled ore on the flat test world against v3's 0.0 s probe), and the e2e helpers plan in-thread
  unless a suite attaches the worker: a dig-heavy composite there runs out of budget.
- Track BD: mode baritone forces `allowPlace` for its gotos and pillars back up from deep members with the
  cobblestone its digs picked up (16 blocks placed on the test block): the pillar replaces v3's staircase
  back up. Never inside `protectRadius` (no place move there, Track BD review); outside it the owner's
  `allowPlace off` does not stop a mining job from pillaring.
- Track BD: Baritone's `legitMine` strip mining and `GoalRunAway` explore are not ported (branch mining
  covers them); the rescan is 40 ticks, not 5 (measured cost, see the rule table).
- The Digger chooses tools from the hotbar only: a pickaxe in the main inventory counts for
  `no_pickaxe` but is not used (`no_tool` blacklists the target). The survival kit (7.11) moves tools.
- Seen targets in unloaded chunks are remembered but not approached; with `mineSeenOnly` off the
  cache's marks of unloaded columns are candidates (approached through cached terrain), not covered
  by an e2e yet.
- A floating / walled-off ore still costs one failed goto when the probe plan was cut short and the
  bot first walks under it.
- Not tested in a natural cave (deepslate, gravel ceilings, water): the rules are the navigator's.
- Wave 9 (Track AI): a seen ore deep below the bot in a cave the navigator cannot dig down to cost 3
  failed gotos of 3 plans per target (about 10 minutes for 6 ores). Fixed by Track AQ: the walk probe and
  the direct tunnel / shaft reach it, or skip it at once with the reason.
- Track AQ: the tunnel is straight by design: a protected block in its line skips the ore even when a
  detour through other rock exists (the owner wants the stop); a liquid in its line falls back to the
  dig-through walk. A shaft without throwaway blocks digs its staircase back only at the end of the run.
- Track AQ: the floor sweep is wired for mine, gather wood and the food hunt; farm and build clear do
  not sweep their produce yet (not this track's files).
- Track AQ: a natural cave can hold built blocks (mineshaft planks): they are never dug, so a vein
  member behind one costs 3 failed sight digs before it is skipped.
