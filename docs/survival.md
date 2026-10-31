# Survival kit: eating, armour, tool wear, inventory keeping, avoidance (PLAN.md task 7.11)

Track S, wave 6. Everything below was measured on **BDS 1.26.60.6** (`bds-surv`, udp/19182, RakNet,
offline, flat world, **difficulty normal**, truth pack) with bedrock-protocol `c9e1fbf2` /
minecraft-data 3.117.0 + the 1.26.60 patch on 2026-10-29. Decision record:
[decisions/0014-survival-kit.md](decisions/0014-survival-kit.md). Why: in the wave-5 full gate the bot
died once at night in a zombie crowd with no armour and no food.

The kit runs on the afk task whenever walking is on (`--walk`, `--home`, `--shelter`, a Realm target):
`tasks/registry.ts` calls `registerSurvivalCommands(...)`, which builds a `SurvivalKit` on the movement
stack and the PvE controller.

```ts
const kit = new SurvivalKit({ skills, world, loop, hotbar, containers, source, combat: pve.combat, inactive, settings, logger });
await kit.eat();              // !eat
await kit.equip();            // !equip
await kit.drop('string', 5);  // !drop string 5
kit.summary();                // !inv
kit.overrides.avoidMobRadius = 0;   // local override (a settings registry drives `settings` at merge)
```

## Files

| File | What |
|---|---|
| `bot/src/skills/survival/eat.ts` | `FOODS` (nutrition, saturation, use ticks), `wantsToEat`, `chooseFood`, `useItemTransaction` / `releaseItemTransaction`, `EatController` |
| `bot/src/skills/survival/armour.ts` | `armourSlotOf`, `armourScore`, `planArmour`, `ArmourController` (window 120) |
| `bot/src/skills/survival/tools.ts` | `maxDurability` (Bedrock table), `durabilityLeft`, `makeToolOk(limit)` |
| `bot/src/skills/survival/keeper.ts` | `THROWAWAY_BLOCKS`, `DEFAULT_JUNK`, `neverDrop`, `planKeeper`, `InventoryKeeper` (stock, drop junk, `drop(name, n)`) |
| `bot/src/skills/survival/screen.ts` | `StackRequests`: own item stack requests (ids from -100001 down) and the inventory screen (`withScreen`) |
| `bot/src/skills/survival/index.ts` | `SurvivalKit` (the 10-tick rules, the hooks), `SurvivalSettings`, `DEFAULT_SURVIVAL_SETTINGS` |
| `bot/src/skills/nav/avoidance.ts` | `penalty`, `costFunction`, `Avoidance` (sources per plan), `SpawnerIndex` |
| `bot/src/chat/commands-survival.ts` | `registerSurvivalCommands`, `createSurvivalKit`, `survivalKitOf(task)`; `!eat` `!equip` `!inv` `!drop` |
| `packs/truth/src/surv.ts` | truth commands `food`, `setfood`, `givedamaged`, `setslot`, `durability`, `unequip`, `items`, `uselog` |
| `docker/compose.surv.yml` | `bds-surv` |
| `bot/test/unit/skills/survival.test.ts` | unit tests (fakes) |
| `bot/test/e2e/surv-{eat,keep,avoid}.test.ts`, `surv-truth.ts` | e2e on bds-surv |

Shared files touched (small, marked `// Track S`): `world/types.ts` + `world/index.ts`
(`ItemStack.damage` from the NBT), `skills/dig/digger.ts` and `skills/combat/combat.ts` (`toolOk`
hooks), `skills/nav/astar.ts` (`PathOptions.cellCost` and its call in `relax`),
`skills/nav/navigator.ts` (`cellCost` option / field, used in `planOptions`, passed to the follower),
`skills/nav/follower.ts` (no pure-pursuit shortcut through penalised cells), `tasks/registry.ts` (one
import, one call), `packs/truth/src/main.ts` (one import, one `Object.assign`), `scripts/bds.mjs`
(`surv` profile), `bot/scripts/e2e-profile.ts` (`SURV_BDS_*`).

## Settings

Read through the injected getter (`SurvivalDeps.settings`, for the settings registry of task 7.9),
then `kit.overrides`, then the defaults:

| Setting | Default | Meaning |
|---|---|---|
| `toolWearLimit` | 10 | a tool / weapon / armour piece with this many uses left or fewer is not chosen |
| `throwawayMin` | 16 | throwaway blocks kept in the hotbar (when the inventory has them) |
| `avoidMobRadius` | 4 | planner penalty radius around hostile mobs (0 = off) |
| `avoidSpawnerRadius` | 8 | planner penalty radius around spawners (0 = off) |
| `throwaway` | cobblestone, dirt, cobbled_deepslate, netherrack | |
| `junk` | rotten_flesh, poisonous_potato, string, spider_eye | dropped when the inventory is full |
| `autoEat`, `autoArmour`, `autoKeep` | true | the automatic rules (the commands work regardless) |

## Commands (owner only)

| Command | Reply |
|---|---|
| `!eat` | `ate cooked_beef: food 19 -> 20` / `eat: no food` / `eat: not hungry (food 20)` |
| `!equip` | the best armour (and forgets the pieces worn by hand): `equip: wearing chest diamond_chestplate` / `equip: nothing better (iron_helmet, ...)` |
| `!equip slot <0..35>`, `!equip <item>` | wear exactly that piece or the elytra, even a worse one (the panel's **Wear this**): `equip: wearing elytra (chest), netherite_chestplate into slot 14; kept on until !equip` |
| `!inv` | `inv 2/36, held 0 iron_sword x1; armour head -, chest -, legs -, feet -; food 20 (best cooked_beef); throwaway 0 in hotbar; tools iron_sword 250/250; items iron_sword x1, cooked_beef x1` |
| `!drop <item> [n]` | `dropped 10 stone` / `drop: no diamond` |

Without walking every command answers `<cmd> needs a task that can walk (...)`.

## Behaviour

Every 10 ticks, while spawned and alive, at most one inventory action at a time, in this order:

1. **Armour** after an inventory change (and on spawn): every armour slot gets the best piece from the
   inventory (0..35) that beats what is worn; points x 10 + toughness (leather < golden = chainmail <
   iron < diamond < netherite per slot), a piece at the wear limit last. Not during a fight, not while
   digging or placing. Not over a piece worn by hand (below) or an elytra.

### Armour worn by hand

`!equip slot <n>` / `!equip <item>` (`SurvivalKit.wear`, `ArmourController.wearSlot`) puts that exact
piece on with the same request as the automatic pass (`place` into an empty armour slot, `swap` with
the worn piece, which lands in the slot the new one came from) and **pins** the armour slot to it.
While the pinned item is still worn, `plan()` skips the slot, so neither the automatic pass nor the
trip preparation (`prepareTrip`) swap the better piece back while walking. The pin ends:

- on `!equip` without arguments (`clearPins`: the best armour again);
- on any other `wear` of that slot: the flight kit's elytra before a takeoff and the chestplate after
  the landing (a feature that needs the slot takes it over; after a flight the chest slot is back to
  normal rules);
- by itself when the slot holds anything else (`!drop all`, a broken piece, a swap by the server).

The pins are in memory: a restart forgets them (the elytra stays on anyway: the pass never replaces
an elytra). `!inv` marks a pinned piece `(by hand)`; the kit's status has `armour.pinned`.
2. **Eat** when food < 18 (natural regeneration needs 18), or health < 10 and food < 20. Best food:
   saturation + 1.5 x the nutrition that is not wasted, raw chicken ranked down, golden apples only
   below health 6, rotten flesh / spider eye / pufferfish / poisonous potato only when nothing else is
   there and food < 6; chorus fruit, suspicious stew and enchanted golden apples never. A stack in the
   main inventory is moved into an empty hotbar slot first (else swapped with junk or the last
   non-tool slot). Not during a fight unless health < 6; not while digging / placing; **not while the
   navigator walks unless food < 6 or health < 10** (see Packets: eating slows the body and the
   movement model does not know it). A hit of 4 or more stops the bite (above health 6) and pauses
   automatic eating 3 s. The previously held slot is selected again afterwards.
3. **Keeper** (not during a fight): fewer than `throwawayMin` throwaway blocks in the hotbar and some
   in the main inventory -> the biggest stack moves into an empty hotbar slot (or onto a hotbar stack
   of the same block, or swaps with junk in the hotbar). No empty slot left -> drop junk (least useful
   first, biggest stacks first) until 2 slots are free. Never dropped by the keeper: tools, weapons,
   armour, shields (anything with durability), food (except the bad four), logs, stems, wood, planks,
   chests, torches, bones, gunpowder.

Hooks installed once (and re-applied every 10 ticks to a re-created Digger):
`digger.toolOk` and `pve.combat.toolOk` = `makeToolOk(toolWearLimit)`, `skills.nav.cellCost` = a fresh
avoidance cost function per plan.

## Packets (BDS 1.26.60.6, verified)

**Eat** (truth: `itemStartUse` / `itemCompleteUse` / `itemStopUse` / `itemReleaseUse` logged by
`truth:uselog`, hunger and saturation by `truth:food`):

| when | packet |
|---|---|
| not held | `mob_equipment` (Hotbar.select); main inventory: `interact open_inventory` -> `container_open` (inventory) -> `item_stack_request place` main -> hotbar -> `container_close` |
| start | `inventory_transaction { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [], transaction_data: { action_type: 'click_air', trigger_type: 'player_input', block_position: {0,0,0}, face: 255, hotbar_slot, hand: 'main_hand', held_item: <wire item>, player_pos: <eye>, click_pos: {0,0,0}, block_runtime_id: 0, client_prediction: 'success', client_cooldown_state: 'off' } }` |
| server | own actor flag `action` set (`set_entity_data`); truth `itemStartUse` (useDuration 32) 2 ticks later |
| +31 ticks | **the server finishes by itself**: clientbound `inventory_transaction { transaction_type: 'item_release', actions: [container slot: old -> new stack], transaction_data: { action_type: 'consume' } }`, `inventory_content` (inventory, armor, ui, offhand), `update_attributes` (`player.hunger`, `player.saturation`), actor flag `action` cleared, `level_sound_event burp`; truth `itemCompleteUse` + `itemStopUse` |
| cancel | `inventory_transaction { transaction_type: 'item_release', transaction_data: { action_type: 'release', hotbar_slot, held_item, head_pos: <eye>, hand: 'main_hand' } }` -> truth `itemReleaseUse` + `itemStopUse`, nothing eaten; selecting another slot also stops the use (`itemStopUse`) |
| food 20 | the click does nothing (no event, no change) |

Not needed: the `start_using_item` input flag, `player_action start_using_item`, a client `item_release
consume`. Measured: start -> complete 31 ticks in every timed bite (n = 5); bread 10 -> 15 food, saturation 0 -> 6.
**Eating while walking**: 6.3 blocks instead of 11.9 in 65 ticks and **6 corrections** in one bite (the
server applies the item-use slowdown, the client movement model does not), hence rule 2.

**Armour**: window 120 (`armor`, `inventory_content` has 5 slots: 0 head, 1 chest, 2 legs, 3 feet, 4
unused). With the inventory screen open: `item_stack_request { requests: [{ request_id, actions: [{
type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: 'hotbar' |
'inventory' }, slot, stack_id }, destination: { slot_type: { container_id: 'armor' }, slot: 0..3,
stack_id: 0 } }], custom_names: [], cause: 'chat_public' }] }` -> `inventory_slot { window_id: 'armor',
slot, item (same stack id) }` + `item_stack_response ok` (containers hotbar/inventory count 0, armor
count 1). Replacing a worn piece: `swap` (source the new piece, destination the armour slot).
Without the screen: status 50; a `swap` into an EMPTY armour slot: status 50. (`click_air` with the
piece held equips it too; not used.) world/containers.ts logs a harmless `item_stack_response ...:
1 items in unknown slot <screen window>:<slot>` for the armour part of the response.

**Drop**: `item_stack_request { actions: [{ type_id: 'drop', legacy_type_id: 3, count, source: {
slot_type: { container_id: 'hotbar' | 'inventory' }, slot, stack_id }, randomly: false }] }` -> response
ok with the slot's new count; the item entity appears about 2.5 blocks in front of the eye. From the
hotbar it works without the screen, from the main inventory only with it (status 49 otherwise). The
legacy `inventory_transaction normal` with a `world_interaction` action also drops (not used);
`player_action drop_item` does nothing.

**Durability**: the item NBT, e.g. `extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound',
name: '', value: { Damage: { type: 'int', value: 245 } } } } }`, in `inventory_transaction` (a give),
`inventory_slot` and `inventory_content`; after a block break the server resends the slot with the new
`Damage`. The world model keeps it as `ItemStack.damage`.

## Avoidance (planner cost)

`PathOptions.cellCost(x, y, z)` adds ticks to every move that ends in feet cell (x, y, z); the
navigator builds it afresh for every main plan (plan-ahead segments reuse the main plan's snapshot)
from `Avoidance.costFn()`:

| source | distance d | radius r | cost per source |
|---|---|---|---|
| hostile mob (`classify` = hostile, never players, not the current combat target) | horizontal from the cell centre to the mob's feet, only within 3 blocks of height | `avoidMobRadius` (4) | `8 + 12 x (r + 1 - d)` for d < r + 1, at most 80 |
| spawner (`mob_spawner`, `trial_spawner`) | 3D from the cell centre to the block centre | `avoidSpawnerRadius` (8) | same |

A sprinted block costs 3.56 ticks, so crossing the middle of a spawner zone costs about 1 100 extra
ticks (any detour shorter than about 300 blocks wins), one cell at the edge 8 to 20 ticks. A goal
inside a zone stays reachable (passable, never a wall). Spawners come from `SpawnerIndex`: a full
`world.find` scan within 48 blocks when the bot moved 8 blocks since the last scan (at most every
2 s) plus block updates that add or remove one. The heuristic stays admissible (costs only add).

The path follower's pure pursuit (aim at the farthest of the next 6 nodes in a walkable straight line)
skipped every detour on open ground: the plan bent to 9 blocks around a spawner, the body passed it at
0.8. It now refuses a straight line through a cell costing more than the nodes it skips.

## Measured (e2e on bds-surv)

Two full runs of the three suites (11 tests each, 95.6 s and 96.8 s), 2026-10-29:

| What | Result |
|---|---|
| Food set to 10, bread only in the main inventory | eaten 2.4 to 2.5 s after the truth `setfood` (fetch into hotbar slot 8, select, click, 31 ticks start -> complete), food 10 -> 15, saturation 0 -> 6, the sword selected again |
| Food set to 4 with rotten flesh in slot 0 and bread in slot 1 | 3 breads (4 -> 19), rotten flesh untouched |
| Full iron armour given into the hotbar and main inventory | all four worn 2.1 to 2.6 s after the first piece arrived (two screens: head + chest, then legs + feet as they arrive) |
| Zombie hits on normal (truth hurt log, health reset between hits) | health lost 3, 3, 3 without armour; 1.38, 1.38, 1.38 with full iron |
| Pickaxe with 5 uses left in slot 0 (selected) and a fresh one in slot 1 | stone dug with slot 1 in 7 to 8 ticks (its damage 0 -> 1, seen in the model), slot 0 still 245 |
| Worn diamond sword (5 left) and a stone sword | the combat skill picks the stone sword; with `toolWearLimit` 2 the diamond one |
| 40 cobblestone in slot 20, slot 8 free | in slot 8 after 0.25 to 0.55 s |
| Full inventory with 20 rotten flesh in slot 35 | dropped after 0.7 to 0.9 s (one item entity of 20 next to the bot), bones, stone, cobblestone, pickaxe kept |
| `!drop stone 10` | `dropped 10 stone`, one item entity of 10, 20 left |
| goto 32 blocks with a spawner on the straight line | closest approach 8.88 blocks (control with radius 0: 0.88), 149 instead of 128 ticks, 0 corrections, plan 3.5 ms / 202 nodes expanded |
| goto 32 blocks past a zombie in a glass box | closest approach 4.84 blocks (control: 1.89), 133 instead of 128 ticks, 0 corrections |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit survival            # 27 unit tests (fakes)
node scripts/bds.mjs --profile surv up && node scripts/bds.mjs --profile surv pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e surv-       # surv-eat, surv-keep, surv-avoid (~2 min)
BDS_E2E=1 PVE_BDS_PORT=19182 PVE_BDS_CONTAINER=bds-surv pnpm --filter bot exec vitest run --project e2e pve-combat pve-follow
```

Env: `SURV_BDS_HOST` (127.0.0.1), `SURV_BDS_PORT` (19182), `SURV_BDS_CONTAINER` (`bds-surv`),
`SURV_VERBOSE=1` (bot logs); version and transport from `bot/test/e2e/env.ts`. Every run uses its own
random 256-block cell from x, z = 12288, random truth request ids, a per-run summon tag, and removes its
mobs and drops at the end.

### Truth commands

| Command | Reply |
|---|---|
| `food player` | `{ name, food, saturation, exhaustion, health, tick }` |
| `setfood player food [sat] [exh]` | the same after setting |
| `givedamaged player typeId damage [n]` | n items with that durability damage in the first free slots |
| `setslot player slot typeId\|air [amount] [damage]` | one inventory slot exactly |
| `durability player` | `{ slots: [{ slot, typeId, amount, damage, maxDurability }], equipment: { Head: {...}, ... } }` |
| `unequip player` | empties the armour and offhand slots |
| `items x y z r [typeId]` | item entities within r with their item type and amount |
| `uselog [sinceTick] [player\|*]` | `{ now, events: [{ tick, kind: start\|complete\|stop\|release, player, typeId, useDuration }] }` |

## Sleep (wave 7, Track W)

Decision record: [decisions/0018-survival-policy.md](decisions/0018-survival-policy.md). Why: the
Realm bot met phantoms every night because it never slept.

| File | What |
|---|---|
| `bot/src/skills/survival/sleep.ts` | `SleepController` (click a bed, the sleeping state from `player_flags`, the refusal texts, the held position, `wake()`), `findBeds`, `bedHead`, `inSleepWindow`, `SLEEP_FROM` / `SLEEP_UNTIL`, `BED_TEXTS` |
| `bot/src/tasks/process/night.ts` | `NightProcess.attachBed`, `requestSleep`, `autoSleep`, `yieldWhile`, the bed routine (`bedLoop`), `sleepStatus` |
| `bot/src/chat/commands-pve.ts` | `!sleep [on \| off \| status]`; wires the sleep controller into the night process (`registerPveCommandsFor`) |
| `packs/truth/src/gaunt.ts` | truth `bed x y z direction` (both halves), `sleeping player` (`Player.isSleeping`, time of day) |
| `bot/test/unit/skills/sleep.test.ts`, `bot/test/unit/night-bed.test.ts` | unit tests (fakes) |
| `bot/test/e2e/gaunt-sleep.test.ts` | e2e on bds-gaunt |

**Rules.** In the sleep window (time of day 12542 to 23459) the night process wants control when a bed
is known: within 8 blocks of the shelter or of home, or within 2 of the `bed` waypoint (`!wp set bed`).
With both a bed and a shelter it prefers the bed (between dusk, 12000, and 12542 it still walks to the
shelter). It walks to within 1.8 blocks of the bed's head, clicks the bed and stays asleep until the
server wakes the bot; then the process ends normally (the dawn home return of night safety follows
when a shelter is set). A refusal because of monsters (`tile.bed.notSafe`) is not counted: the bot
stays next to the bed, fights what comes within reach without walking (guard in place) and tries again
every 20 s; `tile.bed.noSleep` (not night yet) likewise. Any other failure (obstructed, occupied, the
walk failed, no bed any more) counts; after 3 the beds are given up until the next night and the shelter
rule takes over. Woken in the night (hit, the bed broken): back to bed 2 s later. Pre-empted while
asleep (a flight, a fight in place): it gets up (`stop_sleeping`). An urgent command (`!come now`,
`!follow ... now`, `!kill ... now`) makes the night process yield; otherwise the night holds the
owner's commands until the morning, as with the shelter. The keepalive nudge never runs in bed.

| Command | Reply |
|---|---|
| `!sleep` | `going to bed at 24965 -60 26496`, then `sleeping (bed 24965 -60 26496)` and `good morning (slept 5 s)`; refusals: `sleep: refused (monsters near; guarding in place, again in 20 s)`, `sleep: giving up for tonight (obstructed)`; before: `sleep: not night (time of day 6000; beds work from 12542 to 23459)`, `sleep: no bed within 8 blocks of the shelter, home or me (or set the bed waypoint: !wp set bed)`. Works with auto-sleep off and also finds a bed within 8 of the bot |
| `!sleep off` / `!sleep on` | auto-sleep (default on; in memory) |
| `!sleep status` | `sleep: auto on, phase idle, bed 24965 -60 26496; slept 2, refused 1` |

**Phantoms and the night skip.** Sleeping resets the phantom insomnia counter (phantoms spawn only
around players who have not slept for 3 in-game days), so a bot that sleeps every night meets none.
The night is skipped when every player in the overworld sleeps (BDS `playerssleepingpercentage`, 100 by
default): with the owner asleep too (or the bot alone on the server) the server skips to the morning
about 100 ticks (5 s) after the last player lay down and wakes everyone. With the owner awake the bot
sleeps on until the morning; any urgent command wakes it.

**Packets (BDS 1.26.60.6, verified with truth:bed / truth:sleeping)**:

| when | packet |
|---|---|
| click | `inventory_transaction { item_use, click_block, block_position: <either half>, face, hotbar_slot, held_item, player_pos: <eye>, click_pos: <face centre>, block_runtime_id }` (the door / chest click, docs/interaction.md) |
| any click | `set_spawn_position { spawn_type: 'player', player_position, world_position: <the head> }` and the text `tile.bed.respawnSet`: the respawn point moves to the bed even when sleeping is refused |
| asleep | `level_event_generic` 19602 `{ ableToSleep 1, overworldPlayerCount, sleepingPlayerCount }`; own `set_entity_data { player_flags: 2, player_bed_position: <head block>, flags_extended ... }`; `update_block` of the head (`occupied_bit`); the server holds the body at the head's centre, feet 0.70625 above the block (truth `isSleeping` true) |
| refused | a json text `{"rawtext":[{"text":"§7"},{"translate":"tile.bed.<key>"}]}`: `noSleep` (time of day before 12542 or from 23459 on: 12400 and 23500 refused, 12550 and 23400 slept), `notSafe` (a zombie 4.5 blocks away, also one boxed in glass 5 blocks from the bed), `obstructed` (the bed walled in on every side; a block on top of it is fine), `tooFar` (4 blocks from the foot; 1.5 works) |
| wake | the server: `animate wake_up`, `level_event_generic` (sleepingPlayerCount 0), `set_entity_data { player_flags: 0, boundingbox ... }`, the head's `occupied_bit` cleared, a correction to the cell next to the bed. At the night skip (every player asleep 100 ticks; with `doDaylightCycle` false the time stays, the players are still woken) or when the time is set to the morning |
| get up | client `player_action { action: 'stop_sleeping' }` -> the same wake answer within 2 ticks |

While asleep the movement model does not know the sleeping pose: the input loop kept reporting its own
body and the server corrected it once every 16 ticks (37 corrections in 30 s). The controller now
reports the server's position (`InputLoop.setPose`, a slot of its own beside the digger's
`setTickExtras` since wave 9 Track AK: `position` = head centre + 0.90625, no movement): 0 corrections while asleep, 1 on entering and 1 on leaving the bed.

**Measured (gaunt-sleep e2e, bds-gaunt, every run)**: home = shelter, bed 4 blocks east, time set to
18000 with the daylight cycle on, a zombie boxed in glass 5 blocks from the bed: refused (monsters)
1.7 to 1.8 s after the time change, the bot waiting 0.4 blocks from the bed head (`waiting to sleep
(monsters near)`); zombie removed: asleep 22.3 to 22.4 s after the time change (the 20 s retry; truth
`isSleeping`, at the head, feet -59.294 on a -60 floor); the night skipped (the bot alone) and the bot
up 5 s later at time of day 2 to 8, next to the bed; 2 corrections in all (into and out of the bed);
the night process ended. `!sleep off` then night: still awake after 3 s; `!sleep`: `going to bed` ->
`sleeping (bed ...)` after 1.9 s -> `good morning (slept 5 s)` after 6.9 s.

## Open points

- Eating while walking is avoided, not fixed: the input loop could apply the item-use slowdown so a
  walking bite costs no corrections.
- The armour response logs a harmless warning in world/containers.ts (unknown slot of the screen
  window); armour and drops bypass `Containers.move`.
- Two Containers in one process would share request ids from -1 down; the kit creates the afk task's
  Containers (none existed). A task that already has one should pass it instead (`createSurvivalKit`).
- Avoidance does not look at mobs beyond 96 blocks or spawners beyond 48 (re-plans pick them up on the
  way); plan-ahead segments reuse the main plan's snapshot of moving mobs.
- The worn-tool rule treats a worn tool as an empty hand: with nothing else at hand the selected worn
  tool may still be used (the server breaks with what is held).
- Not tested on a Realm.
