# Farming: `!farm [radius]` (`bot/src/skills/farm`)

PLAN.md Phase 7 task 7.13 (Track U). Decision record: [decisions/0016-farming-and-mining.md](decisions/0016-farming-and-mining.md).
Everything below was measured on **BDS 1.26.60.6** (container `bds-farm`, udp/19186, RakNet, offline,
flat world, peaceful, survival, operator, `server-authoritative-block-breaking` on, TICK_DISTANCE 10)
with bedrock-protocol `c9e1fbf2` / minecraft-data 3.117.0 + the 1.26.60 patch on 2026-10-29. The loop
is the sibling of GatherWoodTask ([wood.md](wood.md)); placing is in [interaction.md](interaction.md),
digging in [digging.md](digging.md).

```ts
import { createFarmer } from './skills/farm/index.ts';
const { farm } = createFarmer({ skills, world, loop, source: conn, hotbar, containers }, { useBoneMeal: () => settings.useBoneMeal });
void farm.start({ center: { x: 10.5, y: -60, z: 3.5 }, radius: 8 });   // runs until farm.stop()
farm.state;   // scan | walk | harvest | bonemeal | plant | collect | to_chest | deposit | waiting | full | stopped | failed
farm.stats;   // harvested, planted, boneMealUsed, boneMealGrown, trips, deposited, trampleRoutesRefused, harvestTicks, plantTicks ...
```

Chat (afk task with walking, owners only): `!farm [radius] [wait]` (1..32, default 8) farms the farmland
around where the bot stands and **follows the field** as it walks (`farming r=8 around 10 -60 3, following
the field`; next section), ending `farm: done, nothing left to harvest or plant; ...`; `!farm 8 wait`
keeps the old mode (the field within the radius of the start, re-scanned every minute until stopped); `!farm stop`
(`stopped; farm: stopped, 81 harvested, 81 planted, ...`); `!farm status`. `!farm` stops a running
`!mine` (they exclude each other); since Track Z it is a user process of the afk task (next section).

## As a process (Track Z, decision 0021)

`!farm` adds a `FarmProcess` (`bot/src/tasks/process/farm.ts`, user priority 40) to the afk task's
ProcessManager ([processes.md](processes.md)):

| Event | Effect |
|---|---|
| guard / flee / night / a newer command wants control | `FarmTask.pause()`: the running dig / place / goto / click is cancelled at once, the loop holds (state `paused`), counters stay |
| control back | `FarmTask.resume()`: the loop scans the field again and goes on |
| `!pause` / `!resume` | the same pause / resume (`paused: farming (12 harvested) (!resume to continue)`) |
| `!stop`, `!farm stop`, `!mine` | the process is stopped (`FarmTask.stop()`) |
| `!status` | `processes: [active] farm r=3 at 10 -61 3: 25 harvested, 25 planted, 0 bone meal, 0 trips (waiting)` |
| death | the farm survives it (paused while dead, resumed after the respawn) |
| nothing to do | it keeps control (a later command stacks on top) but reports `idle()`, so the keepalive nudge runs |

The afk task's Hotbar (the PvE one) and Containers are passed in by the registration line; the farm
no longer creates its own (two Containers on one connection each logged the other's
`item_stack_response` as `unknown slot`). `useBoneMeal` comes from the runtime settings.

## Files

| File | What |
|---|---|
| `bot/src/skills/farm/crops.ts` | `CROPS` (block, seed, produce, mature stage), `growthOf`, `isMature`, `fieldCell`, `scanField` (pure) |
| `bot/src/skills/farm/farmer.ts` | `FarmTask` (the loop), `workInReach`, `routeTramples`, `floorOf`, `eyeAt` |
| `bot/src/skills/farm/click.ts` | `ItemClicker.useOn(p, item)`: an item used on a block (bone meal), resolved on the block's update |
| `bot/src/skills/farm/index.ts` | `createFarmer`, `createMiner` (wiring onto BotSkills / World / InputLoop / Hotbar / Containers) |
| `bot/src/chat/commands-farm.ts` | `!farm`, `!mine`; `registerFarmCommands` (called from tasks/registry.ts); Track E6: `farmerOf`, the `!farm new` hook |
| `bot/src/skills/farm/plot.ts` | Track E6: the starter plot's site (`findPlotSite`, `checkSite`), `ownBase`, `onRim`, `TILLABLE` (pure) |
| `bot/src/skills/farm/setup.ts` | Track E6: `FarmPlotJob` (seeds, water, clear, till, plant, fence), `fenceItems`, `hoeCarried`; Track E8: `breakForSeeds` |
| `bot/src/skills/farm/water.ts` | Track E8: surface water for the plot (`surfaceSource`, `openAbove`), pools (`poolsOf`, `waterPools`), the search legs (`searchLegs`) (pure) |
| `bot/src/tasks/process/farm-new.ts` | Track E6: `FarmNewProcess` (`farmnew`), `FarmChore` (`farmchore`, `farmFood`) |
| `bot/src/chat/commands-farm-new.ts` | Track E6: `!farm new [n]`, the site and own-base checks, the hoe and fence obtain steps, bread, `fieldCount`, `plotSizeAt` |
| `packs/truth/src/farm.ts` | `truth:field`, `truth:crops` |
| `docker/compose.farm.yml` | `bds-farm` |

## Crops (block states on BDS 1.26.60)

| Crop block | Seed item (planted) | Produce | States | Mature | Drops seen (one crop each) |
|---|---|---|---|---|---|
| `wheat` | `wheat_seeds` | `wheat` | `growth` 0..7 | 7 | 1 wheat + 0..3 seeds |
| `carrots` | `carrot` | `carrot` | `growth` 0..7 | 7 | 2 carrots (probe) |
| `potatoes` | `potato` | `potato` | `growth` 0..7 | 7 | 3 potatoes (probe) |
| `beetroot` | `beetroot_seeds` | `beetroot` | `growth` 0..7 | 7 | 1 beetroot + 2 seeds (probe) |

Farmland is `farmland` (`moisturized_amount` 0..7; collision top 0.9375, so the planner stands on it
as a partial floor in its own cell). Crops have no collision box and hardness 0. Sweet berries are
not farmed: harvesting them is a click with a hand that does NOT hold bone meal, and the bush is a
hazard in the planner (`terrain/classify.ts`); `ItemClicker.useOn(p, null, { avoid: ['bone_meal'] })`
can do the click, the loop does not use it yet.

## Packet facts (verified)

- **Planting** is PlaceSkill's placement unchanged: `inventory_transaction` item_use / click_block
  on the **top face (1) of the farmland** with the seed in the selected slot as `held_item`
  (`skills.place(cropCell, { face: 'up', item: 'wheat_seeds' })`). The server answers 1 to 2 ticks
  after the click with `update_block` = the crop at `growth` 0 (3 to 4 ticks from the call with the
  look); the truth pack sees `playerInteractWithBlock` (farmland, face Up, the seed) and
  `playerPlaceBlock` (the crop block). Same for carrot, potato, beetroot_seeds.
- **Bone meal** is the same click on the **crop** (face up) with `bone_meal` held. The server answers
  2 ticks after the click with the crop's new `growth` (probe: 0 -> 4 -> 7, i.e. 2 to 5 stages per
  use, two uses from 0) and one bone meal less; `playerInteractWithBlock` (wheat, Up, bone_meal).
  On a mature crop the click does nothing the farmer needs. `ItemClicker` resolves on that
  `update_block` (`rejected` when the block came back unchanged).
- **Harvest** is a dig of the crop: hardness 0, 1 bot tick from the call to the `update_block`
  (any tool, the hand is chosen when no tool helps). An immature crop is never dug by the farmer.

## Trampling (measured)

The truth pack read the farmland after each try (`probe-trample`, 4 tries per height, fresh cells):

| Fall onto farmland | Trampled |
|---|---|
| 0.3, 0.5, 0.6, 0.75 | 0/4 each |
| 0.9, 1.0, 1.1 | 1/4 each |
| 1.25 | 2/4 |
| 1.5, 2, 3 | 4/4 each |
| jump in place on farmland (fall 1.25) | 4/6 |
| walking over a 6-cell strip 6 times (sprint allowed) | 0 |
| a 1-block drop (goto) onto farmland | 0/1 (but see 1.0 above) |
| a jump up onto farmland one block higher (fall about 0.3) | 0/1 |

**Sneaking does not prevent it** (2026-11-06, `farm-sneak-land`, BDS 1.26.60.6): fresh lanes (a 2-block stone
ledge 1 or 2 high, then 4 moist farmland cells without crops), the bot walks off (no sprint, no sneak on the
ledge) and with sneak holds the key from its first airborne tick until 20 ticks after landing (25 to 27 ticks
of sneak per try); the truth pack reads the lane (any `dirt` = trampled). Conditions interleaved try by try.

| Ledge (fall onto farmland) | Without sneak | Sneak from mid-air through the landing |
|---|---|---|
| 1 block (1.0625) | 5/16 (a 2-try first run: 0/2) | 8/16 (first run: 2/2) |
| 2 blocks (2.0625) | 16/16 (first run: 2/2) | 16/16 (first run: 2/2) |

Sneak is no better at 1 block (if anything worse, within noise) and changes nothing at 2, so the follower does
not sneak on drops and the farmer's limits (`SAFE_FALL`, `TERRACE_FALL`, `HOE_FALL`) stay as they are.

So: walking never tramples; jumping in place and dropping onto farmland can. The planner has no
per-cell hook this wave, so the farmer:

1. stands to work: it chooses the standing cell (NavGrid.stand) that reaches the most work, with a
   +4 penalty for cells on farmland, harvests weighted 3, plantings and bone meal 2, plus 0.3 x the
   distance from the bot; reaches are planned with a 0.35-block margin (the body stops up to 0.3 off
   the centre): dig 5 (eye to the closest point) and the server's 10 (corner), click 5 and 7.19;
2. asks `nav.plan` for the route to each of the 12 best cells and refuses a route with a `drop` of
   more than 0.75 blocks (`SAFE_FALL`) whose landing floor is farmland (`stats.trampleRoutesRefused`;
   the planner calls the 0.0625 step from grass onto farmland a drop too, that one is fine);
3. never presses jump itself. `collect` walks to drops over the field (walks only on a flat field).

Terraced fields (2026-11-06, a large sloping carrot field on the Realm: rows of farmland one block apart):

- the farmer's plans and gotos pass `avoidFarmlandDrops` (GotoOptions), which sets the planner's
  `farmlandDropCost` (200 ticks, about a 40-block detour) on any move falling more than 0.75 onto farmland
  (`nav/astar.ts` relax; it crosses to the planner worker), so routes take the steps and paths around the
  terraces instead of jumping off a terrace onto the crops;
- up to `STAND_TRIES` (24) standing cells are planned per round; when every route still falls onto farmland,
  the first whose deepest such fall is at most `TERRACE_FALL` (1.1, one terrace) is taken
  (`stats.terraceSteps`; measured 1 in 4 such falls trample). Deeper falls are never taken;
- **a hoe repairs trampling** (the owner's call: one broken farmland is no blocker): every farmland block seen
  in the run is remembered; one that is `dirt` with air above later was trampled and becomes `till` work (the
  hoe used on its top face, `ItemClicker`), then it is planted with the crop remembered for it
  (`stats.tilled`). With a hoe carried, the fallback route may fall up to `HOE_FALL` (3, no damage) onto
  farmland; without one only `TERRACE_FALL`, and the job's end logs the cells left as dirt. A cell trampled
  after the scan is `blocked` for planting (`fieldCell` checks the soil) until it is tilled;
- a round with no standing cell sets aside only the work the refused cells were picked for (before, every work
  item of the whole followed field was failed, so three such rounds ended the job `done` after 94 of 1491 cells).

The same run planted nothing: the harvested carrots went to the main inventory behind a full hotbar and
PlaceSkill / ItemClicker gave up (`move_failed`) when no hotbar slot was empty. Both now park the least useful
hotbar item (`hotbarRoom` in `place/place.ts`: no tools, the selected slot last) in a free main slot first.

On a 9 x 9 field with a grass rim the middle column is 4.78 blocks from the rim for planting, beyond
the planning margin, so the bot steps onto the farmland for the middle cells (walking, no trample).

## Following the field (`follow`, the default for `!farm`)

The owner's ask: find the nearest crops, harvest and replant them, and keep going as more come into view,
until nothing is ready to harvest and no empty farmland can be planted. With `follow` (FarmOptions):

- **Scan centres** (`areas`): the start, then every place the bot worked from, and farmland found within
  1 of a scan's edge (the field goes on there). A new centre within half the radius of another, farther
  than `maxRange` (`FARM_FOLLOW_RANGE`, 64) from the start, or past `FARM_FOLLOW_AREAS` (128; was 32, a big
  field filled them) is not added.
  Each round scans around every centre and works the union (cells counted once): a strip 30 long is
  worked end to end with radius 3.
- **Planting**: an empty cell gets the crop remembered for it (or the field's most common crop) when its
  seed is carried, else the seed carried most, so an empty field is planted and a field whose own seed
  ran out gets what the bot has.
- **The end**: no harvest, plant or bone meal work left in any centre: drops are collected around the bot,
  then the job ends `done` (no waiting for crops to grow). The deposit chest is looked for around the start,
  then around the bot.
- `!farm status` shows `following (N areas)`. `!get wheat` drives the same `!farm` and gets its done line.

## The loop (`FarmTask`)

Each round: inventory check -> scan -> work -> stand -> act:

- **Inventory full** (fewer than `minFreeSlots`, 2, free slots and something to deposit): walk to the
  chest (`opts.chest`, else the nearest chest or barrel within radius + 16 of the centre), open,
  deposit produce and surplus seeds (of each seed item the largest stack stays for replanting;
  anything else, e.g. tools and blocks, stays), close. No chest: state `full`, re-check after
  `waitTicks`.
- **Scan** the farmland within the radius (x and z, 4 up / down); empty cells get the crop last seen
  there (memory per farmland block), else the field's most common crop.
- **Work**: harvest mature crops; plant empty cells whose seed is carried; bone meal growing crops when
  `useBoneMeal()` (default true, read every round) and bone meal is carried. A cell that failed 3
  times is left alone until the next wait.
- **Act** at the chosen cell, everything in reach from where the body actually stopped: harvest each
  mature crop; bone meal each growing crop until mature (at most 8 uses), then harvest it; plant the
  empty cells (each planting waits while a fresh seed drop lies within pickup range, below); collect
  drops within 6 blocks; plant what is still empty. (Wave 6 replanted each crop at once after its
  harvest; Track Z harvests first, see "Rejected plantings".)
- **Nothing to do**: collect drops still lying in the field, then following: `done`; else (`wait`)
  state `waiting` and re-scan after `waitTicks` (1200) until `stop()`. With bone meal on, replanted crops are bone-mealed in the next
  rounds until the bone meal is gone.

## Measured

`farm-field` on bds-farm (random ticks off), 9 x 9 wheat, grass rim, chest 4 blocks west of the field,
16 wheat seeds to start. Two consecutive green runs (A, B); the first attempts failed and taught:

- the planner calls the 0.0625 step from grass down onto farmland a `drop`: the first trampling check
  refused every route into the field (0 harvests). The check now counts only drops of more than 0.75
  (`SAFE_FALL`, from the trampling table);
- BDS refused (`rejected`) plantings into cells next to the body and some right after harvests while
  drops were being picked up (the seed stack changed under the click): cells the body (+0.15) touches
  are not planted from there, and a `rejected` planting is retried once after 3 ticks
  (`stats.plantRetries`, 4 to 5 per cycle).

| Measure | Run A | Run B |
|---|---|---|
| cycle 1: 81 mature -> harvested / replanted | 72.2 s, 81 / 81, 4 stands, 0 corrections | 71.5 s, 81 / 81, 5 stands, 0 corrections |
| cycle 1 truth | farmland 81, wheat 81 all growth 0; wheat drops 81 = 81 in the inventory; seed drops 139, inventory 74 = 16 + 139 - 81 | farmland 81, wheat 81 all growth 0; wheat drops 81 = 81 in the inventory; seed drops 136, inventory 71 = 16 + 136 - 81 |
| cycle 2 (inventory filled up to 2 free slots) | 68.2 s, 81 / 81, 1 deposit trip (149 wheat, 51 seeds into the chest), cobblestone never deposited; wheat in inventory + chest = 162 | 62.0 s, 81 / 81, 1 deposit trip (128 wheat, 18 seeds), wheat in inventory + chest = 162 |
| bone meal (3 x 3 at growth 0, 16 bone meal) | 9.9 s: all 16 used, 5 crops grown to maturity, harvested and replanted; off with `useBoneMeal()` false (0 used) | 8.5 s: 16 used, 6 crops grown, harvested and replanted; off: 0 used |
| trampling | 0 farmland lost in any run; 0 routes refused (the field is flat) | |
| harvest | 1 tick median (0 to 2), table 0 (hardness 0) | |
| planting | 4 ticks median (3 to 4) from the call (2 look ticks + 1 to 2 for the answer) | |

About 0.9 s per crop for a full harvest-and-replant cycle of a 9 x 9 field, walking and collecting
included. The bot works the middle of the field standing on the farmland (one stand reaches about 60
cells) and the edges from the rim.

## Rejected plantings (Track Z: the cause, measured 2026-10-29)

Wave 6 saw 4 to 8 `rejected` plantings per cycle right after harvests (the farmer retried). A packet
trace of the real farmer on a 9 x 9 field (temporary probe in `farm-process.test.ts`, every
`update_block`, inventory packet and click with ticks) showed the same pattern for **10 of 10**
rejections:

```
129 -> click 6816,6431 slot 0 held 16#923 model 16#923      (seed stack: count 16, stack id 923)
129 <- inventory_transaction slot 0: 16 -> 17 #925          (a seed drop picked up into that stack)
131 <- update_block 6816,6431 air  (x2)                     (the click refused: the old block)
131 <- inventory_content (inventory, armor, ui, offhand)    (full resync)
```

The click carries the held stack (count, stack id) and the server compares it with the slot when it
processes the click. Harvest drops are picked up about 10 ticks after they spawn; when such a pickup
merges into the held seed stack in the server tick before the click is read, the stacks differ and
the click is refused. The client model was current when the click was built (the server decides the
pickup 1 to 2 ticks later), so refreshing the held item cannot fix it alone. Fix:

1. the farmer harvests everything in reach first and plants afterwards (the nearby drops are picked
   up meanwhile), and before each planting waits (at most `SETTLE_TICKS` 16) while a **fresh** drop
   (seen less than 1 s ago) of that seed lies within 2 blocks of the body (`stats.settleTicks`);
2. PlaceSkill re-checks the slot and the selection right before the click and selects again when
   the stack moved (stale-model cases); the held item is built from the slot at that moment;
3. the single retry after a `rejected` stays as a safety net (`stats.plantRejected` counts them).

| Measure (`farm-field`, bds-farm) | Before (wave 6 code, this machine) | Track Z |
|---|---|---|
| `rejected` plantings over cycles 1 + 2 (162 plantings) | 22 log lines (`place ... rejected`), 8 retries in cycle 1 | **0** in each of 3 runs (no `rejected` log line, `plantRejected` 0, `plant retries 0`) |
| cycle 1 / cycle 2 | 74.5 s / 65.6 s | 71.6 / 75.6 s, gate run A 72.3 / 75.9 s, gate run B 75.9 / 77.2 s |
| ticks waited for pickups | - | 0 (the harvest-first order already lets them settle) |

One run with this order left a wheat and a seed drop in a corner of the field: the final collect
looked for drops in a square (`dropsNear`) but collected in a circle of the same radius (6 around the
centre; a 9 x 9 field's corner drop lies up to 6.4 away). The final collect now uses the square's
circumradius (`ceil((radius + 2) x sqrt 2)`, 9 for radius 4).

A first version that waited for any drop within 2.5 blocks (old ones that lie out of the server's
pickup range included) also gave 0 rejections but cost 113.9 s / 135.4 s per cycle; only fresh drops
count now.

## Measured as a process (`farm-process`, bds-core, normal difficulty)

5 x 5 mature wheat, the bot in the middle, guard on, `!farm 3`, a zombie summoned 7 blocks away
after 4 harvests:

| Measure | Result |
|---|---|
| guard pre-empts the farm | `fighting zombie` 61 to 109 ms after the summon; stack `guard:active farm:paused`, `FarmTask.state` `paused` |
| zombie dead / farm resumed | 3.4 to 4.4 s / 6.7 to 7.3 s after the summon (the fight's drop pickup first) |
| field done | 28 to 35 s after `!farm`: 25 farmland, 25 wheat (truth); 0 rejected plantings |
| `!pause` / `!resume` / `!stop` | `paused: farming (25 harvested) ...`, the farmer `paused`; `resumed: farming ...`; `stopped (was farm ...)`, stack empty |

A crop being dug at the moment of the pre-emption may still break on the server (one run: 24
harvested, 25 planted, the field complete).

## Truth commands (`packs/truth/src/farm.ts`)

| Command | Args | `data` on success |
|---|---|---|
| `field` | `x y z w d crop growth [moist]` | `{from, to, cells, crop, growth, moist}`: farmland (`moisturized_amount` = moist, default 7) on x..x+w-1, z..z+d-1 at y, `crop` (`none` = air) with `growth` at y + 1; at most 1024 cells |
| `crops` | `x y z w d` | `{w, d, soil[], crop[], growth[], soilCounts, cropCounts}`: per cell (x fastest, then z) the block at y and the crop at y + 1 (`null` / -1 when air) |

## Tests

| Test | What |
|---|---|
| `bot/test/unit/skills/farm.test.ts` | crops and growth, field scan and crop memory, reaches (the 9-wide field's middle), floors, `routeTramples`; the loop with a fake world and skills: 3 x 3 harvest + replant from off-field cells, bone meal on / off, deposit when full keeping one seed stack, a trampling route refused, stop; `!farm` / `!mine` parsing |
| `bot/test/e2e/farm-field.test.ts` | the 9 x 9 wheat field, two cycles, chest deposit when full, bone meal (see Measured) |
| `bot/test/unit/skills/farm.test.ts` (Track Z) | harvest-first order and the pickup wait, pause / resume, `FarmProcess` pre-empted by a fake guard and resumed, `!stop` |
| `bot/test/e2e/farm-sneak-land.test.ts` (probe) | drops off 1- and 2-block ledges onto fresh farmland with and without sneak held in the air; prints trampled / tries per condition (env `SNEAK_TRIES`, default 12) |
| `bot/test/unit/skills/farm-new.test.ts` (Track E6) | the plot site (flat, covers, soil, built blocks, no floor, the rim, a farm set up before, the protected base), `ownBase`, `!farm new` words, fence names, the plot job's phases on a fake world (pond water, dry, no hoe, no seeds, a pause), the farm chore's trigger and `canFeed` |
| `bot/test/e2e/early-farm.test.ts` (Track E6) | `!farm new` 5 x 5 with water, fences and gate; the farm chore and bread; no hoe and no fences (crafted); not the bot's own base; seeds from grass (env `CRAFT_BDS_*`, a flat world) |
| `bot/test/unit/skills/farm-water.test.ts` (Track E8) | surface water and caves, pools, a pool under the plot with water 23 off, a pool not reached, remembered water, the search walk, nothing within 256, none reached, the walk back out of reach, a cancel; seeds from one stand, ferns, the wide ring; the farm chore's seed top-up |
| `bot/test/e2e/early-farm-water.test.ts` (Track E8) | water: a sealed pool under the plot and a pond 20 off, a pond 117 off, a pond 222 off remembered by the world cache, a pond 236 off found by the search walk, none within 256, a pour answered `rejected`; seeds: ferns, a 9 x 9 in dense grass; the chore's top-up (env `CRAFT_BDS_*`, `E8_CASES`, `E8_BEFORE=1` records without asserting) |
| `bot/test/e2e/farm-process.test.ts` (Track Z, bds-core) | `!farm` as a process: guard pre-emption and resume, `!status`, `!pause` / `!resume` / `!stop` (env `CORE_BDS_*`, `CORE_VERBOSE=1`) |

```sh
node scripts/bds.mjs --profile farm up      # bds-farm, udp/19186
node scripts/bds.mjs --profile farm pack    # truth pack with truth:field / truth:crops
cd bot
BDS_E2E=1 pnpm exec vitest run --project e2e farm-
```

Env: `FARM_BDS_HOST` (127.0.0.1), `FARM_BDS_PORT` (19186), `FARM_BDS_CONTAINER` (bds-farm),
`FARM_VERBOSE=1` (skill logs). Every run builds in its own random 64-block cell from x, z = 6144
(`FarmArea`), uses run-unique truth ids, sets `randomtickspeed 0` for the suite (exact stages; set
back to 1 at the end) and clears the area at the end.

## A starter farm (`!farm new [n]`, Track E6, ADR 0102)

`!farm` works farmland that exists; `!farm new [n]` makes a plot first, then `!farm` (and the farm chore) work it.
n is odd, 3 to 9 (default 9): one water source keeps farmland moist up to 4 cells away, so a 9 x 9 round one water
cell (80 cells to plant) is the largest plot one bucket waters.

```
!farm new 5
farm new: a 5x5 plot round 13 -61 2 (7 from home; 0 of 24 tilled already, no water yet)
farm new: done in 43 s: 24 of 24 tilled, 24 planted (0 seeds from 0 grass), water poured; 23 of 23 fences and the gate; !farm harvests it (farmFood off: no farm chore)
```

The site (`skills/farm/plot.ts`, pure, unit-tested): the nearest n x n of `grass_block`, `dirt` or a path (or farmland
already) at one height round the anchor (home, else where the bot stands) within 24 blocks, with air or a plant a hand
clears (grass, a flower, leaf litter) over each cell and air or a plant over that, a full block under the middle and a
floor under every cell of the ring one out (the fence line; a solid block there holds the line as it is). No plot cell
within 3 of the anchor, no built block. The owner's builds are never touched: inside `protectRadius` of home the plot
may lie only when the base is the bot's own (no built block within protectRadius of home but a bed, a crafting table,
a furnace and the fence of its own farm); else every plot cell lies past protectRadius + 2, and the start line says
why (`outside the base: 3 built blocks within 48 of home, oak_planks at x y z`). Built blocks more than 8 under home
do not count: a farm on the surface touches no cellar, and the world generates "built" kinds deep down (the raw
copper and raw iron blocks of large ore veins). A refusal names the
commonest reasons with their counts (`no 9x9 site of flat grass or dirt within 24 of home (<n> tried: something
over the ground <n>, not grass or dirt <n>, ...); try a smaller n`).

The work, in order (`skills/farm/setup.ts`, a user process `farmnew` that guard, flee and night pre-empt; a resume
goes on with the step it was in, and each step looks at the world again):

| Step | What |
|---|---|
| hoe | with none carried, the obtain job ([early-game.md](early-game.md)) gets a stone hoe, else a wooden one |
| seeds | the bot walks to the plot first when it is more than 24 off (the hoe's log trip can end out of range of the plot's chunks); short and tall grass, ferns and large ferns within 24 of the plot broken (wheat seeds drop from 1 in 8), every one in reach of a stand before the next walk, and the drops picked up, until there is a seed for every cell without a crop, none is left, or 150 s; with none left within 24 and time left, out to 48 (see "Seeds") |
| water | the empty bucket filled at surface water seen or found (see "Water for the plot"), the walk back to the middle, the middle dug and the bucket emptied into it; with no bucket or no water the plot stays dry (crops grow, slower) and the end line says why |
| clear, till | the plants on the soil dug (the hoe refuses a covered cell), each cell clicked with the best hoe carried; on a dry plot only as many cells as there are seeds carried (bare dry farmland turns back to dirt) |
| plant | the farmer's loop (following the field, as `!farm`) plants the farmland with the seeds carried |
| fence | the fences for the free rim cells and a gate, from the obtain job, placed round the plot, the gate in the side facing home; after the planting, so a wood trip does not hold the crops back. The wood: a kind carried that covers the whole fence (planks, or logs at 4 planks each), else the commonest logs within 32 of the plot, else the kind carried most, else oak (`oak_fence` and `fence_gate`, `birch_fence` and `birch_fence_gate`, ...). A try that ends short is followed by one more from the wood carried then, of mixed kinds if no one kind makes it all |
| home | the walk home, when home is set |

The `farm` waypoint marks the water cell (the plot's size is read back off the farmland round it). Run again, it does
what is left: on a plot set up, 1 s (`24 of 24 tilled, 0 planted ..., water already; no fence needed`). `!farm stop`
stops it, `!farm status` adds its step and the farm chore's state.

### The farm chore and bread (`farmFood`, off by default)

With `farmFood` on, the farm chore (`tasks/process/farm-new.ts`, PRIORITY.chore) works the bot's own farm by day with
no user process and the food chore idle, when the `farm` waypoint is within 64: when 16 crops are ripe (or a quarter
of the crops when they are fewer than 64: a watered plot keeps all its cells tilled but plants only the seeds
carried), or the food carried is under `foodMin` and the ripe crops and the wheat carried make a loaf (3). It harvests
and replants the plot with the farmer's loop, picks up from beside it what fell into the middle water (and works the
field again when it did), walks out of the plot and crafts all the wheat into bread (3 wheat a
loaf, 5 food points; a crafting table carried or crafted, set down and picked up again), then walks home. After a run
that harvested nothing it looks again after 5 minutes. While the farm can feed the bot (a loaf from the ripe crops and the
wheat carried, a run going) the food chore starts no hunt; it hunts when the farm has nothing to give. Off by default: it digs crops
and places seeds by itself.

The seed top-up (Track E8): with nothing to harvest and 8 or more farmland cells bare (no crop on them), the chore
breaks plants within 40 of the plot for up to 60 s and the farmer's loop plants what it got (`farm chore: 22 of 80
cells bare, 0 seeds carried: seeds for the bare cells`); at most once every 10 minutes. With seeds carried for them
it breaks nothing and plants. A harvest that is due goes first. A watered plot keeps all its cells tilled whatever
the seeds were, so this is how its bare cells fill without waiting for the harvests' seeds.

## Water for the plot (Track E8, ADR 0105)

The rules (`skills/farm/water.ts`, pure, unit-tested), for any world:

| Rule | What |
|---|---|
| surface water | a still source with no water on it and the cells above it open (air, plants, leaves) for 24 and up to the plot's height plus 8. Caves are left out: a cave can be more than 24 high, and a pool reached through a cave strands the bot below the plot |
| pools | the sources grouped (within 4 on x and z, 2 on y), nearest the plot first; one try a pool (a walk to its nearest cell, then a click on a source in reach), at most 4 before the search and 4 more during it |
| seen | the loaded blocks within 160 of the bot are read first-hand; with the world cache, a column its map layer remembers with water on top is a candidate up to 256 from the plot, and the walk there decides |
| search | with nothing known within 256: out 96 from the plot along +x, +z, -x, -z, 32 at a time, a look after each step (the server loads the chunks round the bot as it walks); at most 300 s |
| back | the walk back to the middle is tried once more with a looser goal and twice the time when it ends out of reach; still out of reach, the plot stays dry, the water is kept, and a rerun pours |

The end line always says wet or dry and why:

| End line | When |
|---|---|
| `water poured (filled 17 off)` | a loaded pool 17 from the plot |
| `water poured (filled 161 off, seen before)` | a pool the cache remembered |
| `water poured (filled 236 off, walked 227 looking)` | found on the search walk |
| `water poured (carried)` | a water bucket was carried |
| `water dry (none seen within 256, walked 529 looking)` | nothing found |
| `water dry (2 tried, none reached, nearest 21 off, walked N)` | pools known, none reached |
| `water dry (water carried, not back at the plot (reason))` | the bucket is full, the middle out of reach |
| `water dry (no bucket)`, `water dry (not poured (reason))` | no bucket; the pour refused and no water showed within 2 s |

A pour answered `rejected` whose water shows within 2 s counts as poured and is logged (`the pour read rejected; the
water showed within 500 ms`). Water carried on a trip that crosses dusk is part of the `farmnew` process, so the
night process pre-empts it as any user process; the resume runs the water step again from where the bot is.

Dropped: filling the bucket whenever a job passes water (it touches every walk for one bucket, and the world cache
already remembers the water those walks saw); siting the plot by the water (the site rules stay; the fetch is paid
once); an endless water source at home (one plot needs one bucket).

## Seeds (Track E8)

Wheat seeds come from short grass, tall grass, ferns and large ferns, 1 in 8 a plant on BDS (the e2e fern case: 201
ferns gave 25 seeds). The set-up's seed step breaks every plant in reach of a stand before it walks to the next, and
when none is left within 24 of the plot with time left it goes on out to 48 (a mountain plot had 11 plants within
24). The step stays capped at 150 s: it breaks about 1.2 plants a second on a fresh world either way (146 to 216 in
the 150 s), so more time would delay the planting; the farm chore's top-up fills the rest of a watered plot later.

### Measured (e2e early-farm-water, flat test world)

A 5 x 5 by home, a stone hoe and 30 seeds unless said, an empty bucket. Before: the rules of Track E6, recorded with
`E8_BEFORE=1` on the tree before this track (n1).

| Case | Before | After (3 runs) |
|---|---|---|
| a sealed water layer under the plot, a pond 20 off | poured (40 s) | poured, `filled 12 off`, 43 to 44 s |
| one pond 117 off, loaded | dry (38 s) | poured, `filled 117 off`, 80 to 81 s |
| one pond 222 off, remembered by the world cache, not loaded | not run | poured, `filled 222 off, seen before`, 117 to 119 s |
| one pond 236 off, never seen | not run | poured, `filled 236 off, walked 227 looking`, 123 to 124 s |
| no water within 256 | not run | dry, `none seen within 256, walked 530 looking`, 157 to 159 s |
| the pour answered `rejected`, the water in a moment later | poured, nothing logged | poured, `the pour read rejected; the water showed within 500 ms` |
| no seeds, ferns round home, a water bucket | `stopped after 0 s in the seeds step` (no seeds) | 24 of 24 planted, 24 to 27 seeds from 198 to 243 ferns |
| 9 x 9, no seeds, dense short grass, a water bucket | 39 seeds from 321 plants, 53 planted | 42 to 49 seeds from 372 to 394 plants, 50 to 58 planted |
| the farm chore, a watered 5 x 5 with 4 crops and 20 cells bare, grass round it | not run (no top-up before) | 18 to 22 seeds, 18 to 20 planted, the run 80 to 88 s |

### Measured (e2e early-farm, flat test world)

| Case | Result |
|---|---|
| 5 x 5 by home, a stone hoe, 30 seeds, an empty bucket, 23 fences and a gate carried, a one-block pond 8 off, short grass over the ground | 43 to 50 s: the bucket filled and poured into the middle, 24 of 24 tilled and planted, 23 fences and the gate; again: 1 s, nothing to do |
| the farm chore on that plot, every crop ripe, `farmFood` on | 24 harvested and replanted, 8 bread in 34 s |
| 3 x 3, no hoe and no fences, 40 oak planks and 2 cobblestone | the stone hoe crafted in 3 s, the plot dry (no water near), 15 fences and the gate crafted in 4 s and placed, 19 s in all |
| a planks block 3 from home (not the bot's own), protectRadius 12 | every plot cell more than 14 from home, the planks untouched |
| no seeds carried | 40 grass broken gave 8 seeds, the 8 cells planted, 52 s |

Fixes found on the way: inside a fenced plot every cell round the feet is a crop or a fence, so the bread craft found
no cell for a table (`craft: no free cell next to the bot for a crafting table`, 24 wheat and 0 bread): the chore
walks out of the plot first. On a dry 3 x 3 plot the farmer's loop stood on the middle (the only stand off the
farmland reaching every cell), its planting of the cell next to the body was refused before any click, and it chose
the same stand for ever (the e2e case hung in the plant step for 300 s): a stand where nothing got done now counts as a
failed one (two and it is left; `farm.test.ts`).

Fixes from the fresh world (early-game.md "A farm" has the runs):

- **A dry plot over-tilled.** With no water within 48, every one of the 80 cells was tilled for 18 seeds; bare
  farmland with no water near turns back to dirt, so it was tilled again and the end line read `92 of 80 tilled`. A
  dry plot now tills only as many cells as there are seeds carried, and the count is read off the world.
- **No water within 48.** The bucket now looks within 96 when nothing is within 48.
- **The fence wood.** The fence came from `oak_fence`. In a mixed wood the obtain job's log trip brought 12 birch and
  5 oak logs, too few of either kind for 35 posts (16 logs of one kind), and the job ended `!gather 8 got nothing
  (gather done: 17/8 logs)`: the gather counts logs of any kind. The kind is now chosen from what is carried, then from
  the logs round the plot. When the first try ends short, a second one uses the wood carried: one kind if it makes the
  whole fence, else a mixed fence (`mixedFence`: the gate from the kind carried most, then each kind's posts as far as
  its own planks go; posts of different woods join).
- **An ore vein read as a build.** Large copper veins generate `raw_copper_block`, a "built" kind: 8 of them 21 to 35
  under home made the base foreign and pushed the plot 65 blocks out. Built blocks more than 8 under home no longer
  count.
- **Seeds after the log trip.** The hoe's obtain job walked 120 blocks for logs, and the seed step then searched the
  plot's unloaded chunks from there (`0 grass broken`, the job stopped on no seeds). The step now walks to the plot
  first.
- **Left out there.** After `!farm new` the bot stood at the plot, 60 blocks from home, until the next chore; it now
  walks home.
- **The middle dug once.** One dig of the middle cell timed out (`timeout after 19 ticks`), the water was refused
  (`not poured (occupied)`) and the plot stayed dry. The dig is now tried up to 3 times.
- **A pour read as refused.** The place came back `rejected`, the end line said `water dry`, and yet the water
  showed and the bucket emptied about a second later: the plot was wet. After a pour that does not show at once the
  job now looks at the middle again every 500 ms for up to 2 s before it calls the plot dry.
- **A walk for one wheat.** With food short one ripe crop started a run: on a watered plot's days 4 to 6 the bot
  walked out 7 times for 11 wheat (1 or 2 a run, most of them no loaf), and while a crop stood ripe the food chore
  held its hunt back. A run now starts while food is short only when the ripe crops and the wheat carried make a
  loaf, and the hunt goes first until then (days 4 to 6 of a second watered plot: 1 run, 6 harvested, 2 loaves).

Fixes from the e2e on a second test server:

- **A plot set up read as a new site.** A fence post there has collision boxes but is not a full block. The site
  check's fence-line rule refused it (`rim`), so `!farm new` run again laid out a second plot next to the first (154
  s, and the chore case then ran on the second plot: 24 harvested, 2 bread). A fence or a gate on the line now holds
  it.
- **The fence step spun.** A place refused before any click comes back at once (`in_body`: the bot stood on the
  last free cell of the fence line). The loop asked for that cell again for ever without yielding to the event loop:
  19 minutes of one core, and the case's own timeout could not fire. The bot now steps two cells off the line after
  such a refusal, leaves a cell refused 3 times, and the step ends after 3 rounds per line cell.
- **Drops in the middle water.** Wheat broken next to the water cell can fall into it. The farmer's pickup then
  walks for the hole and times out (`collect r=6: timeout`), so 12 wheat and 10 seeds were left floating: 13 of 24
  cells replanted and 4 bread where 8 were due. After the harvest, the farm chore now walks to the cells beside the
  water (the pickup box reaches 1.3 out), picks those drops up, and works the field once more so the seeds plant
  the bare cells.
- **An open gate read as no gate.** The walk home goes out through the gate and leaves it open, and an open gate has
  no collision box. `!farm new` run again took the gate cell for a free one and made a wood trip for a gate
  (`!gather 2 got nothing`, 22 s in place of 1). A fence or a gate on the line is never a free cell now.
- **Two processes named `farm`.** The farm chore was first named `farm`, the name of `!farm`'s own process, and the
  farm-process e2e looks that process up by name: it found the chore, which has no farmer's stats, and failed at
  once. The chore is `farmchore` (`!status` and the process table show that name).

Fresh-world numbers: [early-game.md](early-game.md) "A farm".

## Open points

- Sweet berries: click implemented (`ItemClicker`), not in the loop.
- Till and water exist only in `!farm new` (Track E6); `!farm` itself re-tills a trampled cell and works the field
  as it is.
- While it waits for crops the farm keeps the user-process slot (a later command stacks on top and the
  farm resumes after it); a "farm in the background" mode would need a lower priority.
- The trampling rule is a route check, not a planner rule (see the decision record).
