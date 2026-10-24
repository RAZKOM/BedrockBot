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

Chat (afk task with walking, owners only): `!farm [radius]` (1..32, default 8) farms the farmland
within the radius of where the bot stands (`farming r=8 around 10 -60 3`); `!farm stop`
(`stopped; farm: stopped, 81 harvested, 81 planted, ...`); `!farm status`. `!farm` stops `!mine` and
the PvE foreground behaviour (follow / come / kill) first.

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

On a 9 x 9 field with a grass rim the middle column is 4.78 blocks from the rim for planting, beyond
the planning margin, so the bot steps onto the farmland for the middle cells (walking, no trample).

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
- **Act** at the chosen cell, everything in reach from where the body actually stopped: harvest and
  at once replant each mature crop; bone meal each growing crop until mature (at most 8 uses), then
  harvest and replant it; collect drops within 6 blocks; plant what is still empty.
- **Nothing to do**: collect drops still lying in the field, else state `waiting` and re-scan after
  `waitTicks` (1200) until `stop()`. With bone meal on, replanted crops are bone-mealed in the next
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
- `!stop` (PvE) does not stop `!farm`; the process manager (7.8) will. Guard / night safety may
  interrupt a skill call; the loop then simply re-scans.
- The trampling rule is a route check, not a planner rule (see the decision record).
