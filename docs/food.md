# Food gathering: `!food`, `!cook` and the food chore (PLAN.md task 7.16)

Track X, wave 7. Why: on 2026-10-29 the Realm bot died 6 times and sat at health 5.5 for hours with
nothing to eat and no way to get food. The survival kit (docs/survival.md) eats what the bot carries;
this track makes sure it carries something. Decision record:
[decisions/0019-food-gathering.md](decisions/0019-food-gathering.md).

**Food v2** (Track AF, wave 8; [decisions/0027-food-v2-herds-pens-breeding.md](decisions/0027-food-v2-herds-pens-breeding.md)):
remembered herds beyond 48 blocks, pens (farm animals are spared), and breeding (`!breed`, the
breeding chore). Why: food runs stopped at 48 blocks, killed animals without replacing them, and the
Realm bot had `autoFood` off because the leave rule could not tell a farm animal from a wild one.
Sections: "Herd memory", "Pens", "Breeding"; numbers in "Measured (food v2)". Everything below was measured on
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
| `bot/src/skills/food/pen.ts` | Track AF: `detectPen` (flood fill), `PenDetector` (10 s memory per cell), `PEN_KEEP` 2, `penGates`, `penExit`, `leavePen`, `closePenGates`, `inPenOrRim`, `insidePen` |
| `bot/src/skills/food/herds.ts` | Track AF: `HerdMemory` (`observe` once a second, `next`, `liveCells`), `markOffers`, `HERD_RANGE` 200, `CLEAR_RADIUS` 32, `EMPTY_MS` 2.5 s, `TRACKED` 32 |
| `bot/src/skills/food/breed.ts` | Track AF: `BREED_FOOD`, `Breeder.breed` (pairs, feed, stand clear, babies), `feedTransaction`, `breedable`, `BREED_COOLDOWN_MS` 5 min |
| `bot/src/world/cache/herds.ts` | Track AF: `HerdMarks` (the herd mark store, `herds.json` beside the region files; `WorldCache.herds`) |
| `bot/src/tasks/process/food.ts` | Track AF additions: walks to remembered herds in `FoodJob`, `BreedProcess` (user), `BreedChore` (auto, `PRIORITY.chore`), `parseChorePen` |
| `bot/test/unit/skills/food-v2.test.ts` | Track AF: 20 unit tests on fakes |
| `bot/test/e2e/food-herds.test.ts`, `food-breed.test.ts` | Track AF: e2e on bds-food |

Shared files touched (one or two lines each, marked `// Track X`): `tasks/registry.ts` (one import,
one registration), `tasks/process/manager.ts` (`PRIORITY.chore = 30`), `config/settings.ts`
(`autoFood`, `foodMin`, `foodLeave`), `packs/truth/src/main.ts` (one import, one `Object.assign`),
`scripts/bds.mjs` (`food` profile, two lines), `bot/scripts/e2e-profile.ts` (`FOOD_BDS_*`),
docs/runbook.md (server row, two command rows, test line, per-track pointer).

## Commands (owner only, afk task with walking)

| Command | Reply |
|---|---|
| `!food [n]` | `gathering 6 food items (cow 4+1 baby within 48; wild animals, pens left alone)` (with `foodLeave` 2: `keeping 2 wild of each`), then `food: 6/6 items from 2 cow` (with a furnace near home and fuel: `; cooked 6 cooked_beef`), `food: 5/6 items from 2 cow, nothing left to hunt within 48 blocks (keeping 2 of each)`, `food: stopped after 2/6 items` (`!stop`). n is 1..64, default 8 |
| `!food status` | `food: 0 points carried (foodMin 10), auto on, day, next try in 512 s; cow 2 within 48; last chore: 4 items (none_left)` |
| `!food [n] pen` (Track AF) | the same; animals inside pens may be taken too, never below 2 adults of a kind (`gathering 6 food items (no wild food mobs; in pens cow 4+1 baby within 48; keeping 2 of each, pens down to 2 of each)`) |
| `!food herds` (Track AF) | `food: 2 herd(s) remembered: 22155 -59 21132 (4 blocks, 0 min ago): cow 1 \| ...` (wild counts, then `pen cow 3`) |
| `!breed [type] [n]` (Track AF) | `breeding 1 cow pair`, then `breed: fed 1/1 cow pair, 1 baby so far`; `breed: no wheat for the cows (2 per pair)`, `breed: no two cows ready within 16 blocks (babies, and parents fed in the last 5 minutes, do not count)`, `breed: the cows did not take the food`, `breed: stopped after 0/1 pairs`. type: cow, sheep, mooshroom, pig, chicken, rabbit (plural accepted); n 1..8, default 1; no type: the kind with the most ready adults the bot has food for |
| `!cook` | `cooking 4 beef`, then `cooked 4 cooked_beef in the furnace at 7 -60 3 (41 s, fuel 1 coal); food carried 32 points`; errors `cook: no raw food`, `cook: no furnace or smoker within 16 blocks of home`, `cook: no fuel (coal, charcoal, planks, logs, dried kelp blocks)`, `cook: the furnace holds something else` |

Without walking both answer `<cmd> needs a task that can walk (...)`.

`!get beef` / `!get food 6` start the same hunt (docs/get.md). Before a hunt starts or resumes, a full inventory (fewer than 2 free slots) runs the stash step (stash chest, a carried shulker box, junk dropped; food itself is always kept); still full ends the job with reason `inventory_full` (wave 8 Track AD, docs/get.md "Stash").

## Settings

| Key | Default | Bounds | Meaning |
|---|---|---|---|
| `autoFood` | on | on/off | the food chore may run by itself |
| `foodMin` | 10 | 0..200 hunger points | the chore runs when the food carried totals fewer points (cooked beef 8, raw beef 3, bread 5, ...; rotten flesh, spider eyes, pufferfish, poisonous potatoes do not count) |
| `foodLeave` | 0 | 0..16 mobs | wild adults of a kind left alive within the 48-block radius (`!food` and the chore); 0: every wild adult may be hunted. Animals in pens are never hunted unless asked (`!food n pen`, `chorePen`), and then down to 2 (see "Pens"). Was 2 until the owner asked for only the pens to be kept; raise it near a farm the pen detector misses |
| `autoBreed` | off | on/off | Track AF: the breeding chore may run (needs `chorePen`) |
| `chorePen` | none | `x y z` or `none` | Track AF: a block inside the owner's pen: the hunt may take its animals down to 2 adults of a kind, and `autoBreed` breeds it. `!set chorePen 120 64 -30` |

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

**Cook** (`Cooker`): after a hunt (when raw food and fuel are carried) and on `!cook`. After a hunt
only a furnace or smoker within `COOK_NEAR` (32) blocks **of the bot**: a hunt far from home keeps its
raw food instead of walking home to cook it (`cook: no furnace or smoker within 32 blocks; the raw food
is kept (!cook cooks it at home)`), and a `!food` started more than `HOME_RETURN_NEAR` (64) blocks from
home stays where it is afterwards (the chores and jobs near home still walk home). `!cook`: a furnace or
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

## Herd memory (Track AF)

Every second (`HerdMemory.observe`, 0.15 ms mean, 1.2 ms max measured) the entity tracker's passive food
mobs (cow, mooshroom, pig, sheep, chicken, rabbit; dead ones left out) are grouped by **16-block cell**
(chunk column) and each occupied cell's **herd mark** is rewritten: mean feet position, adults and babies
of each kind, split into wild and penned, and the time. A mark is dropped when the bot is within
**32 blocks** of it and the tracker has shown no food mob in its cell for **2.5 s** (the tracker keeps
cows up to **75 to 81 blocks** away, measured, so 32 is safe; the 2.5 s cover the moment after an
arrival or a teleport before `add_entity` comes).

Marks are kept by the world cache when one is open (the CLI; `WorldCache.herds`): one JSON file
`herds.json` beside the region files (`<cache dir>/<server id>/herds.json`, other dimensions in
`dim<n>/`), written atomically with every cache flush (30 s) and at exit, read on the first lookup, at
most 2048 marks per dimension (the oldest are dropped). Without a cache (tests,
`BEDROCKBOT_CACHE=0`) the marks live in memory. Block marks (logs, ores) are rebuilt from the chunk's
blocks whenever it loads, so an animal cannot ride on them; hence the sidecar (decision 0027).

**Use**: `!food` and the food chore hunt the entity tracker within 48 blocks first (unchanged). When
that finds nothing more and items are still wanted, the job asks for the **nearest mark within 200
blocks** that offers something: a kind with more than `foodLeave` wild adults, or penned adults above 2
in a pen the hunt may take (the `chorePen` cell, or `!food n pen`). Marks of cells already visited by
this job are skipped, and so is a mark within 32 blocks whose cell has no mob in the tracker now (it is
stale: the mobs moved or were just killed). The bot walks there with the normal walk (a `near` goal of
4 blocks, timeout 15 ticks per block, at least 30 s), waits 20 ticks for the tracker, and hunts again
around the mark. At most **4 walks** per job. A fight or a flight pre-empts the walk like any user
process; the resume walks on to the same mark. The reply counts the walks: `food: 4/4 items from 2 cow
(1 walk to remembered herds)`. The chore starts on a mark too (`... and no herd remembered within 200;
next look in 10 min` otherwise).

## Pens (Track AF)

The rule, as the owner can predict it: **an animal standing inside a fenced area is a farm animal. The
bot never kills farm animals, except in the pen you named with `!set chorePen x y z` or when you type
`!food n pen`, and even then it leaves at least 2 adults of each kind in every pen. Babies are never
killed. Wild animals (outside fences) follow `foodLeave` as before.**

Detection (`detectPen`, `PenDetector`): a flood fill on the mob's feet level over the loaded blocks,
4-connected. A cell is a wall when it holds a fence, a wall, a fence gate (**open or closed**: an open
gate is still the owner's pen) or anything 1.5 high, or a block with a collision box whose cell above
has one too (a two-high wall). Everything else is open: air, plants, water, a single solid block a cow
can hop onto. The mob is penned when the fill stays within **12 blocks** of it on both axes and touched
at least one fence, wall or gate (a cave pocket or a stone room is not a pen). An unloaded block makes it
unknown (not a pen). The fill visits at most 625 cells; its result is remembered for every interior cell
for 10 s. The pen's id is its interior's lowest cell, so all mobs of a pen agree.

Counting: the leave rule counts **wild** adults only (penned ones are protected by their own rule);
penned adults are counted per pen and kind. `!food status` and the start reply show both: `cow 2; in
pens cow 2 within 48`.

Gates: the hunter and the breeder walk into a pen with `closeDoors` and, once inside, close the pen's
open gates within reach (`useBlock want closed`; a walk that ends just inside the gate would leave it
open). After hunting or feeding in a pen the bot walks out through the nearest gate to 3 blocks past
it and closes every open gate of the pen within 4.5 blocks. Measured: the gate stood open 1.1 s while
the bot entered, 1.0 s while it left; truth `open_bit` false after every run.

## Breeding (Track AF)

`!breed [type] [n]` is a user process (40; `!stop` ends it, guard / flee / night pre-empt it and it goes
on with the pairs left). Per pair: the nearest ready adult of the kind within 16 blocks, then the ready
adult nearest to it ("ready": adult, alive, not in love, not fed within the last 5 minutes, the vanilla
breeding cooldown). Per animal: walk to 1.8 blocks (`near`, 300 ticks), put the food in the hand (the
selected slot, else a hotbar slot, else pulled from the main inventory by the combat skill's
`HotbarPuller`), look at the animal (60 % of its height), send the click (Packets), and wait up to 20
ticks for the item count to drop or the `inlove` flag; up to 3 tries per animal. Then stand clear
(inside a pen: walk out and close the gate; else 4 blocks from the pair) and wait up to 10 s for
babies near the pairs. Fed animals are remembered for 5 minutes: never fed again, and the hunt spares
them (and any mob in love).

| Kind | Food (first preferred) |
|---|---|
| cow, mooshroom, sheep | wheat |
| pig | carrot, potato, beetroot |
| chicken | wheat seeds, beetroot seeds, pumpkin seeds, melon seeds, torchflower seeds, pitcher pod |
| rabbit | dandelion (`yellow_flower` on older data), carrot, golden carrot |

**The breeding chore** (`BreedChore`, auto, `PRIORITY.chore` 30, registered after the food chore): it
wants control when `autoBreed` is on, `chorePen` is set and within 200 blocks, it is day, no user
process exists and the food chore is not running, at most once per **10 minutes**: a kind in the pen
has fewer than **8 adults**, at least 2 ready ones, and the bot carries 2+ of its food. It walks to the
pen (a `near` goal of 3 blocks when farther than 8), feeds `min(ready / 2, 8 - adults, food / 2)`
pairs, and leaves the pen closing the gate. A pen out of view is judged by its herd mark (its penned
counts). Every check that finds nothing says why in `!food status` (`chorePen ... (cow 8 adults (8
wanted))`, `no wheat for the cows`, `the pen is 260 blocks away (more than 200)`).

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

**Feeding** (Track AF, verified by the food-breed e2e, 6 of 6 feeds taken):

| Step | Packet | Server answer |
|---|---|---|
| hover | `interact { action_id: 'mouse_over_entity', target_entity_id, has_position: true, position: aim point }` | none needed (sent like the client does) |
| click | `inventory_transaction { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use_on_entity', actions: [], transaction_data: { entity_runtime_id, action_type: 'interact', hotbar_slot: selected, hand: 'main_hand', held_item: the wheat as the server sent it, player_pos: eye, click_pos: aim point - mob position } } }`, the food selected and the view on the mob, eye within 3 blocks | the wheat count drops by 1 (`inventory_slot`) and `set_entity_data` carries `flags.inlove: true` within 2 to 3 ticks; the two parents walk together and `add_entity` of a cow with `flags.baby: true` follows **3.1 to 3.4 s** after the second feed |

So the right click on a mob is the attack packet with `action_type: 'interact'`. bedrock-protocol decodes
the love-mode actor flag as `inlove` (`BabyTracker.inLove`); the bot saw it on both parents in every
run (once only on one parent within the 20-tick wait: the item count decided).

## Measured (e2e on bds-food)

`food-gather` (3 tests), runs of 2026-10-29; the two gate runs: 3/3 green in 112.4 s and 103.4 s:

| What | Results |
|---|---|
| `!food 6`, 4 adult cows + 1 calf in a 7 x 7 oak-fence pen 18 to 24 blocks from home, closed gate | done in 9.7 to 13.2 s (walk 20 blocks, gate opened 5 ticks after the click, 2 kills of 13 to 20 ticks with 2 hits each, pickup); 2 cows killed every time, 2 adults and the calf left; raw beef in the inventory (truth) 5, 5, 6, 6, 4 over five runs; then home again |
| `!cook`: furnace 3 blocks from home, 4 beef and 2 coal | `cooked 4 cooked_beef ... (41 s, fuel 1 coal)` 41.7 to 41.9 s after the command (4 x 10 s cooking + walk + requests); truth: 4 cooked beef, 0 beef, 1 coal left, furnace empty |
| auto trigger, idle at home | the chore started 0.75 to 1.04 s after the truth `clear` of the inventory food (its check runs every second), killed 2 of 4 adults, 3 to 4 beef |
| auto trigger during a 40-block `!goto` | 0 starts in 121 to 124 samples (every 50 ms) during the walk although the food was cleared 7.8 s before the arrival; the chore started 0.17 to 0.38 s after the arrival, 2 kills, 4 to 5 items, 2 cows left |

## Measured (food v2, e2e on bds-food)

`food-herds` (2 tests) and `food-breed` (3 tests), runs of 2026-10-29 / 30; the two gate runs of all `food-` suites: 8/8 green in 242.3 s and 226.2 s:

| What | Results |
|---|---|
| herd mark | 4 cows summoned 120 blocks east, the bot 6 blocks from them: one mark `{"cow":{"adults":4}}` in their cell within 1 s |
| entity tracker range | walking away, the cows stayed in the tracker up to 75.0 to 81.0 blocks; at home (112 blocks) none |
| `!food 4` from 112 blocks, `foodLeave 0` | the walk back to the mark (121 blocks) and the hunt: done in 28.3 to 34.7 s, 2 to 3 kills, 4 to 6 beef (truth inventory), `(1 walk to remembered herds)` |
| `!food 6`, 2 cows in a 7 x 7 pen, 2 free, `foodLeave 0` | the 2 free cows killed in 5.8 to 8.0 s, the pen untouched (truth: 2 in the pen, 0 outside), no walk to the stale mark of the cows just killed |
| `!breed cow 1`, 2 cows in a pen, 16 wheat | both fed 2.6 to 6.6 s after the command (walk 7 to 15 blocks, each feed taken in 2 to 3 ticks), calf 3.1 to 3.4 s after the second feed (5.6 to 10.0 s after the command); 14 wheat left; gate closed |
| `autoBreed on`, 4 adults in the chorePen (2 just bred) | the chore started 0.8 to 1.0 s after the `!set`, walked 13 blocks into the pen, fed the 2 ready cows, calf; next look 10 min later |
| `autoBreed off` | 8 s with a chorePen, wheat and 2 cows: no check, no process, no wheat used |
| `!food 6 pen` (food-gather test 1 with the new rules) | 2 of 4 penned cows killed, 2 adults and the calf left, gate closed afterwards |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit food                     # 39 unit tests (fakes; 20 of them Track AF in food-v2.test.ts)
node scripts/bds.mjs --profile food up && node scripts/bds.mjs --profile food pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e food- --silent=false   # ~5 min (gather 3, herds 2, breed 3)
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

- Track AF: pens are found on the mob's own level with a 12-block fill. A pen larger than 25 x 25, a pen
  on a slope whose fence steps up, or a pen in a chunk that is not fully loaded reads as no pen (its
  animals count as wild and follow `foodLeave`); raise `foodLeave` near such farms. A barn of two-high
  walls without any fence, wall or gate is not a pen either.
- Track AF: the home return after a job walks with the owner's `closeDoors` setting; the hunt and the
  breeder already left the pen and closed its gate, so only other doors on the way are affected.
- Track AF: herd marks record what the tracker sees; a herd that moved is found again only when the bot
  passes within about 80 blocks. Marks are not shared between bots.
- Track AF: breeding was verified with cows (wheat); the other kinds' foods are vanilla facts, not
  measured here. No sheep shearing, no egg collection.
- The leave rule keeps `foodLeave` wild adults of each kind within 48 blocks (default 0 since the owner
  asked; Track AF: pens are recognised, see "Pens"). A pen the detector misses counts as wild.
- With `foodLeave` 2 and 4 cows, `!food 6` can kill only 2 cows: 2 to 6 beef by the loot table (the e2e
  saw 4 to 6). The test therefore asserts the 2 kills, the 2 survivors and at least 2 beef, and logs
  when fewer than 4 came.
- Fish are not caught, crops are left to `!farm`; cooked mutton / chicken / rabbit / porkchop and
  smokers are covered by the unit tests and the probe (smoker: 5 s per item) but only beef in a furnace
  runs in the e2e.
- The cooker waits at the furnace (10 s per item); it could load the furnace and come back later.
- Track AF: the chore hunts within 48 blocks first, then walks to remembered herds within 200 blocks
  (it no longer stops at 48). With nothing in range and no herd remembered it looks again every 10
  minutes.
- Not yet tested on a Realm.
