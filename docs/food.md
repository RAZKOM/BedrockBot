# Food gathering: `!food`, `!cook` and the food chore (PLAN.md task 7.16)

Track X, wave 7. Why: on 2026-10-29 the Realm bot died 6 times and sat at health 5.5 for hours with
nothing to eat and no way to get food. The survival kit (docs/survival.md) eats what the bot carries;
this track makes sure it carries something. Decision record:
[decisions/0019-food-gathering.md](decisions/0019-food-gathering.md). Everything below was measured on
**BDS 1.26.60.6** (`bds-food`, udp/19190, RakNet, offline, flat world, **difficulty easy**, truth pack)
with bedrock-protocol `c9e1fbf2` / minecraft-data 3.117.0 + the 1.26.60 patch on 2026-10-29.

## Files

| File | What |
|---|---|
| `bot/src/skills/food/finder.ts` | `FOOD_ANIMALS` (cow, mooshroom, pig, sheep, chicken, rabbit), `COOKED`, `fuelValue` / `fuelRank` / `isFuel`, `inventoryFoodPoints`, `foodItemCount`, `rawFoodCounts`, `babyFlag`, `BabyTracker`, `countHerd`, `pickTarget` (the leave rule), `COOKERS`, `findCookers` |
| `bot/src/skills/food/hunter.ts` | `Hunter.hunt(opts, cancelled)`: pick, `near` goal, `combat.fight`, `collect`; `peek`, `herdLine`, the 30 s ignore list |
| `bot/src/skills/food/cook.ts` | `Cooker.cook(opts, cancelled)`: furnace finder, walk (`getToBlock`), open, input / fuel / take requests, wait, close; `planFuel`, `CookRequests` (own request ids from -200001 down), slot constants |
| `bot/src/skills/food/index.ts` | re-exports |
| `bot/src/tasks/process/food.ts` | `FoodJob` (hunt, then cook; resumable), `FoodProcess` (user: `!food`, `!cook`), `FoodChore` (auto, `PRIORITY.chore` 30), `FoodController` |
| `bot/src/chat/commands-food.ts` | `registerFoodCommands(deps, { containers, clock })`: `!food [n]`, `!food status`, `!cook`; `isChoreTime`, `foodControllerOf(task)` |
| `packs/truth/src/food.ts` | truth commands `furnace`, `setfurnace`, `herd`, `pen` |
| `docker/compose.food.yml` | `bds-food` |
| `bot/test/unit/skills/food.test.ts` | 19 unit tests on fakes |
| `bot/test/e2e/food-gather.test.ts`, `food-truth.ts` | e2e on bds-food |

Shared files touched (one or two lines each, marked `// Track X`): `tasks/registry.ts` (one import,
one registration), `tasks/process/manager.ts` (`PRIORITY.chore = 30`), `config/settings.ts`
(`autoFood`, `foodMin`, `foodLeave`), `packs/truth/src/main.ts` (one import, one `Object.assign`),
`scripts/bds.mjs` (`food` profile, two lines), `bot/scripts/e2e-profile.ts` (`FOOD_BDS_*`),
docs/runbook.md (server row, two command rows, test line, per-track pointer).

## Commands (owner only, afk task with walking)

| Command | Reply |
|---|---|
| `!food [n]` | `gathering 6 food items (cow 4+1 baby within 48; keeping 2 of each)`, then `food: 6/6 items from 2 cow` (with a furnace near home and fuel: `; cooked 6 cooked_beef`), `food: 5/6 items from 2 cow, nothing left to hunt within 48 blocks (keeping 2 of each)`, `food: stopped after 2/6 items` (`!stop`). n is 1..64, default 8 |
| `!food status` | `food: 0 points carried (foodMin 10), auto on, day, next try in 512 s; cow 2 within 48; last chore: 4 items (none_left)` |
| `!cook` | `cooking 4 beef`, then `cooked 4 cooked_beef in the furnace at 7 -60 3 (41 s, fuel 1 coal); food carried 32 points`; errors `cook: no raw food`, `cook: no furnace or smoker within 16 blocks of home`, `cook: no fuel (coal, charcoal, planks, logs, dried kelp blocks)`, `cook: the furnace holds something else` |

Without walking both answer `<cmd> needs a task that can walk (...)`.

## Settings

| Key | Default | Bounds | Meaning |
|---|---|---|---|
| `autoFood` | on | on/off | the food chore may run by itself |
| `foodMin` | 10 | 0..200 hunger points | the chore runs when the food carried totals fewer points (cooked beef 8, raw beef 3, bread 5, ...; rotten flesh, spider eyes, pufferfish, poisonous potatoes do not count) |
| `foodLeave` | 2 | 0..16 mobs | never reduce a kind below this many **adults** within the 48-block radius (`!food` and the chore) |

`!set autoFood off` etc. as for every setting (docs/processes.md "Settings").

## Rules

**Targets** (`pickTarget`, re-evaluated before every kill): cows, mooshrooms, pigs, sheep, chickens and
rabbits from the entity tracker, within 48 blocks (horizontal; 16 up or down) of where the job started.
Adults only: babies drop nothing (the `baby` actor flag, see Packets). A kind is hunted only while it
has more than `foodLeave` adults within the radius (babies do not count towards the herd, so a herd of
2 adults and 3 calves is left alone). Among the allowed, nearest first, worth-weighted by 2 blocks per
expected food item (cow / pig 2, sheep 1.5, chicken 1, rabbit 0.5). Players are never targets (and the
combat skill refuses them by itself); a target whose approach was unplannable or whose fight ended
other than `killed` is ignored for 30 s.

**Hunt** (`Hunter`): farther than 4 blocks, a `near` goal (r 2.5, 400 ticks) through the settings
mover (closed gates and doors are opened by the planner; `closeDoors` closes them behind); then
`combat.fight` (it re-plans after the fleeing mob, strikes with the best weapon); then `collect(8, 200)`.
Food items are counted as the inventory delta around each kill (leather, feathers, wool are picked up
but not counted). Stops at n items or when no target is left.

**Cook** (`Cooker`): after a hunt (when raw food and fuel are carried) and on `!cook`. A furnace or
smoker (lit or not; blast furnaces do not cook food) within 16 blocks of home (of the bot without a
home), found with `World.find` (cached marks too when a world cache is open), nearest to the bot
first; walk to it (`getToBlock`, reach 4), open it, take out whatever lies in the output slot, then per
raw kind (largest count first): put the stacks into the input slot (up to 64), add fuel for the whole
batch (`planFuel`: charcoal / coal 8 items each, dried kelp block 20, coal block 80, planks / logs 1.5;
the best fuel first, counting what lies in the fuel slot; nether wood does not burn), wait 10 ticks at a
time until the input slot is empty (deadline: items x 200 ticks + 200; a smoker 100 per item), take the
output into a matching stack or an empty slot, close. No fuel: the raw food comes back out and stays
raw (the eat rules eat it raw when nothing better is there). A furnace whose input holds something
else is left alone (`furnace_busy`). An interrupted cook (a guard fight) leaves the food in the
furnace; the next `!cook` / hunt takes the output and goes on.

**Processes**: `!food` and `!cook` are user processes (40): guard (60), night (80) and flee (100)
pre-empt them and they go on afterwards with the next target; `!stop` ends them; `!pause` holds them.
The chore is an auto process at **`PRIORITY.chore` = 30** (between user commands 40 and the home
return 20). It wants control when `autoFood` is on, **no user process exists**, it is day (time of day
23000 to 11500; an unknown clock counts as day), the food carried totals fewer than `foodMin` points,
and the hunter sees a target; it hunts `max(4, ceil((2 x foodMin - points) / 3))` items (7 from
nothing), then cooks if it can. A user command pre-empts it (it resumes after); a `!food` / `!cook`
replaces it; from 11500 it pauses until dawn. When an attempt found nothing (no target at the check,
or 0 items gained) the next look is **10 minutes** later; after an attempt that gained food, 30 s.
After any job the home-return process walks home (when a home is set and no command is queued).

## Packets (BDS 1.26.60.6, verified)

Probe (raw requests with the truth pack reading the block inventory every second) and the e2e runs:

| Step | Packet | Server answer |
|---|---|---|
| open | the chest click (docs/wood.md): `inventory_transaction { transaction_type: 'item_use', transaction_data: { action_type: 'click_block', block_position: furnace, face, hotbar_slot, held_item, player_pos: eye, click_pos: face centre, block_runtime_id: the furnace's } }` | `container_set_data` window 2 properties 2 and 3 = 0, `container_open { window_id: 2, window_type: 'furnace'` (smoker: `'smoker'`)`, coordinates, runtime_entity_id: -1 }`, `inventory_content { window_id: 2, input: 3 items }` (also inventory, armor, ui, offhand, then window 2 again) |
| input | `item_stack_request { requests: [{ request_id, actions: [{ type_id: 'place', legacy_type_id: 1, count: 4, source: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 5 }, destination: { slot_type: { container_id: 'furnace_ingredient' }, slot: 0, stack_id: 0 } }], custom_names: [], cause: 'chat_public' }] }`; smoker: `container_id: 'smoker_ingredient'` | `inventory_slot { window_id: 2, slot: 0, beef x4 (same stack id) }`, `item_stack_response ok` with containers `hotbar` slot 0 count 0 and `furnace_ingredient` slot 0 count 4 |
| fuel | the same with `destination: { container_id: 'furnace_fuel', slot: 1 }` (smoker too) | `inventory_slot` slot 1, response ok (hotbar count 1 left, `furnace_fuel` count 1 with a new stack id); the coal is taken at once (`inventory_slot` slot 1 empty), the block turns `lit_furnace` / `lit_smoker`, `container_set_data` property 2 = 1600 (smoker 800), property 1 counting down every tick |
| cooking | (none) | every 200 ticks (smoker 100): `inventory_slot` slot 2 (output +1) and slot 0 (input -1) |
| output | `{ type_id: 'take', legacy_type_id: 0, count: 4, source: { container_id: 'furnace_output', slot: 2, stack_id }, destination: { container_id: 'hotbar', slot: 0, stack_id: 0 } }` (smoker too) | `inventory_slot` slot 2 empty, response ok (`furnace_output` count 0, `hotbar` slot 0 count 4 with the output's stack id) |
| close | `container_close { window_id: 2, window_type: 'furnace', server: false }` | `container_close { window_id: 2, window_type: 'none', server: false }` |

So: **window slots 0 input, 1 fuel, 2 output; slot types `furnace_ingredient` (smoker
`smoker_ingredient`), `furnace_fuel`, `furnace_output`** (ContainerSlotType 25 / 46, 24, 26). The
window id is the next free container id (2 for the first). Main-inventory slots (9..35) work as sources
and destinations while the furnace window is open. The response's `hotbar` / `inventory` part is
applied by world/containers.ts; the cooker predicts the destination slot first so that part lands on a
known slot, and records the hotbar wire item (`Hotbar.noteRaw`) so later clicks echo the right held item.

**Baby flag**: `add_entity.metadata` / `set_entity_data.metadata` entry `{ key: 'flags', value: { ..., baby: true } }`
(bedrock-protocol decodes the actor flags into named booleans). Verified in the e2e run: a cow summoned
with `minecraft:entity_born` was the only one of five the tracker marked as a baby. A Script API
`spawnEntity('minecraft:cow')` is a baby about 1 time in 20 (the cow's `entity_spawned` event), so the
e2e summons its adults with `summon cow x y z 0 0 minecraft:ageable_grow_up`.

**Loot** (Bedrock tables, seen in the runs): a cow gave 1 to 3 beef and 0 to 2 leather per kill.

## Measured (e2e on bds-food)

`food-gather` (3 tests), runs of 2026-10-29; the two gate runs: 3/3 green in 112.4 s and 103.4 s:

| What | Results |
|---|---|
| `!food 6`, 4 adult cows + 1 calf in a 7 x 7 oak-fence pen 18 to 24 blocks from home, closed gate | done in 9.7 to 13.2 s (walk 20 blocks, gate opened 5 ticks after the click, 2 kills of 13 to 20 ticks with 2 hits each, pickup); 2 cows killed every time, 2 adults and the calf left; raw beef in the inventory (truth) 5, 5, 6, 6, 4 over five runs; then home again |
| `!cook`: furnace 3 blocks from home, 4 beef and 2 coal | `cooked 4 cooked_beef ... (41 s, fuel 1 coal)` 41.7 to 41.9 s after the command (4 x 10 s cooking + walk + requests); truth: 4 cooked beef, 0 beef, 1 coal left, furnace empty |
| auto trigger, idle at home | the chore started 0.75 to 1.04 s after the truth `clear` of the inventory food (its check runs every second), killed 2 of 4 adults, 3 to 4 beef |
| auto trigger during a 40-block `!goto` | 0 starts in 121 to 124 samples (every 50 ms) during the walk although the food was cleared 7.8 s before the arrival; the chore started 0.17 to 0.38 s after the arrival, 2 kills, 4 to 5 items, 2 cows left |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit food                     # 19 unit tests (fakes)
node scripts/bds.mjs --profile food up && node scripts/bds.mjs --profile food pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e food- --silent=false   # ~2 min
```

Env: `FOOD_BDS_HOST` (127.0.0.1), `FOOD_BDS_PORT` (19190), `FOOD_BDS_CONTAINER` (`bds-food`),
`FOOD_VERBOSE=1` (bot logs); version and transport from `bot/test/e2e/env.ts`. Every run works in its
own random 256-block cell from x, z = 20480, uses random truth request ids and a run tag, and at the end
removes every entity within 80 blocks of home and resets the 71 x 71 area (pen and furnace included).

### Truth commands (`packs/truth/src/food.ts`)

| Command | Reply |
|---|---|
| `furnace x y z` | `{ x, y, z, typeId, lit, size, slots: [{slot, typeId, amount} \| null] }` (furnace, smoker, blast furnace) |
| `setfurnace x y z slot typeId\|air [n]` | the same after setting one slot |
| `herd x y z r [tag]` | `{ mobs: [{ entityId, typeId, baby, location, tags }] }`: food mobs within r (`baby` from the `minecraft:is_baby` component) |
| `pen x y z w d` | `{ from, to, gate }`: oak fence on the rim of the w x d box at feet level, air inside, a closed fence gate in the middle of the north side |

## Open points

- The leave rule keeps 2 adults of each kind within 48 blocks, but on a Realm those may be the owner's
  farm animals; set `foodLeave` higher (or `autoFood off`) near a breeding pen. No breeding yet (wheat,
  carrots, seeds), so a herd shrinks to `foodLeave` and stays there.
- With `foodLeave` 2 and 4 cows, `!food 6` can kill only 2 cows: 2 to 6 beef by the loot table (the e2e
  saw 4 to 6). The test therefore asserts the 2 kills, the 2 survivors and at least 2 beef, and logs
  when fewer than 4 came.
- Fish are not caught, crops are left to `!farm`; cooked mutton / chicken / rabbit / porkchop and
  smokers are covered by the unit tests and the probe (smoker: 5 s per item) but only beef in a furnace
  runs in the e2e.
- The cooker waits at the furnace (10 s per item); it could load the furnace and come back later.
- The chore hunts within 48 blocks of where the bot stands; it does not go looking farther. With
  nothing in range it looks again every 10 minutes.
- Not yet tested on a Realm.
