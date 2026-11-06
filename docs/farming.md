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
| `bot/src/chat/commands-farm.ts` | `!farm`, `!mine`; `registerFarmCommands` (called from tasks/registry.ts) |
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

## Open points

- Sweet berries: click implemented (`ItemClicker`), not in the loop.
- No till (hoe on dirt / grass) and no water management: the farmer works existing farmland.
- While it waits for crops the farm keeps the user-process slot (a later command stacks on top and the
  farm resumes after it); a "farm in the background" mode would need a lower priority.
- The trampling rule is a route check, not a planner rule (see the decision record).
