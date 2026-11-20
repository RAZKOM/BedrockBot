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
| `bot/src/skills/survival/tools.ts` | `maxDurability` (Bedrock table), `durabilityLeft`, `makeToolOk(limit)`, `hasMending` and `enchantLevel` (Track K5: the one enchantment reader with world/inventory.ts `tagEnchants`) |
| `bot/src/skills/survival/keeper.ts` | `THROWAWAY_BLOCKS`, `DEFAULT_JUNK`, `neverDrop`, `planKeeper`, `InventoryKeeper` (stock, drop junk, `drop(name, n)`) |
| `bot/src/skills/survival/screen.ts` | `StackRequests`: own item stack requests (ids from -100001 down) and the inventory screen (`withScreen`) |
| `bot/src/skills/survival/index.ts` | `SurvivalKit` (the 10-tick rules, the hooks), `SurvivalSettings`, `DEFAULT_SURVIVAL_SETTINGS` |
| `bot/src/skills/nav/avoidance.ts` | `penalty`, `costFunction`, `Avoidance` (sources per plan), `SpawnerIndex` |
| `bot/src/chat/commands-survival.ts` | `registerSurvivalCommands`, `createSurvivalKit`, `survivalKitOf(task)`; `!eat` `!equip` `!inv` `!drop` |
| `bot/src/skills/survival/mend.ts` | Track K5: `gearPieces`, `turnPiece`, `mendQueue`, `mendStatusLine`, `USES_PER_XP` (the pure Mending rules) |
| `bot/src/tasks/mend-hand.ts` | Track K5: `MendHand` (the hold of a carried Mending piece while orbs come: the furnace takes, the watcher, the ore hook) |
| `bot/src/tasks/process/mend.ts` | Track K5: `chooseMendSource`, `MendJob` (`!mend`) |
| `bot/src/chat/commands-mend.ts` | Track K5: `registerMendCommands`, `mendControlOf(task)`; `!mend` |
| `bot/test/unit/skills/mend.test.ts`, `bot/test/e2e/mend.test.ts` | Track K5: unit tests (fakes); the e2e cases and the probes (`MEND_PROBE`) |
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
| `junk` | rotten_flesh, poisonous_potato, string, spider_eye | dropped when the inventory is full; Track V1: also by the room chore when idle away from the home chests with fewer than 4 free slots ([inventory.md](inventory.md)) |
| `autoEat`, `autoArmour`, `autoKeep` | true | the automatic rules (the commands work regardless) |

## Commands (owner only)

| Command | Reply |
|---|---|
| `!eat` | `ate cooked_beef: food 19 -> 20` / `eat: no food` / `eat: not hungry (food 20)` |
| `!equip` | the best armour (and forgets the pieces worn by hand): `equip: wearing chest diamond_chestplate` / `equip: nothing better (iron_helmet, ...)` |
| `!equip slot <0..35>`, `!equip <item>` | wear exactly that piece or the elytra, even a worse one (the panel's **Wear this**): `equip: wearing elytra (chest), netherite_chestplate into slot 14; kept on until !equip` |
| `!inv` | `inv 2/36, held 0 iron_sword x1; armour head -, chest -, legs -, feet -; food 20 (best cooked_beef); throwaway 0 in hotbar; tools iron_sword 250/250; items iron_sword x1, cooked_beef x1` |
| `!drop <item> [n]` | `dropped 10 stone` / `drop: no diamond` |
| `!mend [status]`, `!mend [<piece>] [minutes]`, `!mend stop` | Track K5 (below): `mend: Mending on elytra 131/432, ...; no Mending: ...` / `mend: elytra 132 -> 142/432 in 1 min: smelted 8 raw_iron; stopped: ...` |

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
   non-tool slot, `pickHotbarVictim` in keeper.ts: not the selected slot, and the rockets, elytra and
   shulker boxes, the fireworks box among them, only when nothing else is left; the stash step swaps
   its shulker box in the same way when the hotbar is full, since the place skill only fetches a box
   from the main inventory into an EMPTY hotbar slot and otherwise fails with `move_failed`). Not during a fight unless health < 6; not while digging / placing; **not while the
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

## Mending (Track K5)

The owner: a tool, an armour piece or an elytra with Mending is not worn down to breaking, and the bot mends whatever
it can from the experience it gathers itself. Decision: [decisions/0110-mending.md](decisions/0110-mending.md).

### The rules Mending follows (measured)

On the test server (BDS 1.26.60.6, flat, peaceful; test/e2e/mend.test.ts `MEND_PROBE=rules,furnace,ores,mobs`, n3 a
case unless said):

| Where the damaged Mending piece is | 10 orbs summoned at the feet | the experience bar |
| --- | --- | --- |
| nothing with Mending | - | +10 points (level 1) |
| carried (a hotbar slot not held) | 0 uses | +10 |
| held in the main hand | +20 uses | 0 |
| worn (the elytra on the back) | +20 uses | 0 |
| the offhand: an elytra | refused by the server (item_stack_request status 55) | +10 |
| the offhand: a shield | +20 uses | 0 |

- One orb summoned is one point; a point mends 2 uses (`USES_PER_XP`) and is used up.
- Several damaged Mending pieces worn or held: each orb goes whole to one of them, not by damage (counts of single
  orbs: an elytra held at 332/432, a chestplate at 128/528 and leggings at 445/495 worn: 7 / 3 / 10, 8 / 9 / 3,
  5 / 6 / 9 of 20; a worn elytra and a held pickaxe: 9 / 1, 7 / 3, 5 / 5, 6 / 4, 7 / 3 of 10).
- The model follows the mend: a worn piece by `player_armor_damage` (one packet an orb; the entry's slot is half the
  byte, the chest slot arrives named `leggings`, as Track F20 found), a held one by its slot update; in every case the
  bot's count equalled the server's.

### What each source pays

| Source | Experience (n) | How it reaches the body | Uses a unit | Time a unit with the bot's skills |
| --- | --- | --- | --- | --- |
| raw iron in a furnace | 8 items: 6 points (n6) | orbs at the furnace when the output is taken, about 2 blocks off, picked up 0.03 to 2.2 s later | 1.5 an item | 10 s (furnace), 81 s for 8 |
| raw beef in a furnace | 8 items: 3 (n3) | the same | 0.75 | 10 s |
| cobblestone in a furnace | 8 items: 1 (n3) | the same | 0.25 | 10 s |
| coal ore, mined with an iron pickaxe | 0, 1, 0 (n3) | orbs at the block, about 2.8 blocks off, picked up 0.4 to 1 s after the break | 0 to 2 | about 10 s an ore (`!mine coal_ore 1` from 3 blocks off) |
| lapis ore | 5, 3, 3 | the same | 6 to 10 | the same |
| redstone ore | 2, 1, 2 | the same | 2 to 4 | the same |
| diamond ore | 7, 7, 5 | the same | 10 to 14 | the same |
| nether quartz ore | 2, 3, 3 | the same | 4 to 6 | the same (in the Nether) |
| nether gold ore | 0, 0, 1 | the same | 0 to 2 | the same (in the Nether) |
| a zombie killed (diamond sword, the bot's reflex), the elytra carried | 5 points (n6: 10 uses mended in each run whose orbs were picked up) | 3 orbs at the mob, 3.9 to 4.8 blocks from the feet; not drawn in: before the walk 1 of 3 runs picked up 2 of 3 orbs, after it 3 of 3 runs all | 10 | killed in 3.9 to 4.7 s |
| a skeleton killed | 5 points | 3 orbs 5.3 to 6.3 blocks off; before the walk 0 of 3 runs picked any up, after it 2 of 3 runs all | 10 | 12.5 to 12.9 s |
| a spider | not killed in 60 s in 2 of 3 runs (it walked off by day); killed in 6 s once, its orbs 4.1 blocks off not picked up (before the walk) | | | |
| a phantom (summoned 6 up by day) | burned in the daylight 67 to 70 blocks away in 3 of 3: no orbs near the bot | | | |

The furnace pays everything it has stored when the output is taken (the cooker takes it once a batch, so one take pays
the whole batch); a worn Mending elytra gained 12 uses from 8 raw iron, the bar 0.

### What the bot does

- **The one reader**: Mending (`ench` id 26) and Unbreaking (17) come from the item NBT's `ench` list
  (world/inventory.ts `tagEnchants`, the same function for an item inside a carried shulker box); `hasMending` and
  `enchantLevel` in skills/survival/tools.ts. Checked on the server with `/enchant` for the four armour pieces, sword,
  axe, pickaxe, shovel, hoe, shield, trident, bow, crossbow, mace, fishing rod, shears, flint and steel and elytra.
- **Set aside** (`mendAt`, default 10 %, 0 = off): the survival kit's tool rule (`makeToolOk`) refuses a Mending
  item at or under `mendAt` percent of its durability (a diamond pickaxe at 157 of 1561 uses), on top of
  `toolWearLimit`. The Digger does not dig with it, the armour choice does not pick it, the weapon choice takes a
  worn blade without Mending before it and the Mending one only when there is nothing else. Mining ends `no_pickaxe`
  with the reason when the only pickaxe is set aside. A Mending elytra is set aside at 10 % (44 of 432 uses).
  The owner is told once when an item goes under its reserve.
- **Whose turn** (`turnPiece`, skills/survival/mend.ts): worn and held pieces mend where they are. Of the damaged
  Mending pieces only carried, the one set aside first, then the smallest share of its uses left, the elytra on a tie.
- **The hold** (tasks/mend-hand.ts): the piece comes into an empty hotbar slot, else one holding no tool, weapon or
  rocket (a move, or one swap with the inventory screen, undone after; with no such slot no hold), is selected while
  the orbs come (at least 16 ticks after a furnace take or an ore, whose orbs come into view later, 6 for the watcher's hold; then until 4 ticks with no orb
  within 8, at most 70), and the slot held before comes back. The miner holds after every ore it digs, also those its
  walk dug on the way. A hostile that can hurt the bot during the hold (the hold rule, below) or a skill taking the hand
  ends it, and no hold is made while one can. Armour is never taken off; the offhand is never touched. Every refusal
  is logged: `mend: not held: a zombie 5 blocks off with a clear way to me (6 path blocks)`, `mend: not held for
  furnace: a skeleton 12 blocks off with a line on me`, `mend: not held: no hotbar slot free of tools, weapons and
  rockets to bring the elytra into`, and the hold's own line says what ended it (`ended: a hostile (...)`, `no orb
  near`, `the time limit`, `the hand was taken (...)`).
- **On the way** (`mendOnTheWay`, default on): every furnace output take holds the turn piece (skills/food/cook.ts
  `CookerDeps.mend`: `!cook`, `!smelt`, the food chore, the obtain job's smelt and cook steps). Orbs within 8 with
  the hand free (no user process: a command's own steps hold at their takes; no walk, no fight, the survival kit
  idle, not gliding) and no hostile that can hurt the bot during the hold start the same hold: the orbs of a reflex
  kill or of a guard fight once it is over. A kill's orbs fall 4 to 6 blocks off and lay there (measured below), so a
  watcher hold walks once to the nearest orb still farther than 1.5 blocks 20 ticks in (no digging, 5 s at most), only
  with no hostile within 16 at all (the body leaves where it stands: `mend: no walk to the orbs 5.3 blocks off: a
  zombie 13 blocks off (within 16)`); an ore's hold does the same, and a
  furnace job's end (the window closed) walks to its orbs still lying within 8 (in 2 of 15 runs a take's hold ran its
  70 ticks with 2 orbs near the furnace that never came, and a point went to the bar). The take itself never walks. A watcher hold that mended nothing
  waits 200 ticks (not one a hostile ended: the kill's orbs come next). In a fight the blade, the shield and the armour
  stay as they are (skills/combat is unchanged).
- **`!mend [<piece>] [minutes]`**: gathers experience until the damaged Mending pieces are mended (worst share first)
  or the one named is, the bound (default 15, 1 to 120 minutes) or no source. Sources, cheapest first: the furnaces
  where the cooker looks (their output taken, once a job); a smelt of what is carried (`SMELT_XP`: raw gold 1 an item,
  raw iron and copper 0.7, raw food 0.35 by `!cook`, cobblestone 0.1; logs and sand are kept), sized to the points
  wanted and to the fuel carried; the same out of the chests at home while they are in reach (the home withdrawal);
  then the ore near (within 24, outside the base: coal, lapis, redstone, diamond, quartz) with a pickaxe that harvests
  it, the turn piece held after each ore while its orbs come. The piece comes into the hotbar once for the whole job
  (a move or swap per ore takes longer than the orbs: in the first runs 3 of 5 points of six coal ores went to the bar). A step that gave nothing is not chosen again. The end
  line: `mend: elytra 132 -> 143/432 in 2 min: smelted 8 raw_iron; stopped: no source of experience: needs ...`.
  With nothing mended it names the cause, the hand's last refusal in a step that paid nothing: `mend: nothing mended
  (uses gained 0: not held: a zombie 5 blocks off with a clear way to me (6 path blocks)) in 1 min: smelted 8 raw_iron;
  stopped: ...`. The mine source walks and digs away from where the bot stands, so it keeps the strict rule: with a
  hostile within 16 the ores wait and the reply says so (`or the coal_ore near mined (not now: a zombie 9 blocks off
  (within 16))`). The smelt sources stand at the furnace and use the hold rule: drowned in the lake beside the base no
  longer refuse a smelt at home.
  `!mend stop`, `!stop` and every command that moves the bot end the job.
- **`!mend status`**: `mend: Mending on elytra 131/432, diamond_pickaxe 1200/1561, diamond_chestplate 500/528 (worn),
  diamond_sword full; no Mending: trident (1/250, worn out: cannot be mended), diamond_axe`. `!inv` marks
  `(Mending)` on tools and worn armour and `(worn: !mend)` on a worn-out Mending one. `!elytra status` and the
  takeoff's refusal add `it has Mending: !mend elytra mends it (151 experience)` for a damaged Mending elytra.
- **The test harness** keeps an elytra with Mending under `elytraMin` (a fresh one from `/replaceitem` has no
  enchantments) and notes `elytra on the back: kept, it has Mending (60 uses left; !mend elytra)`.

### The hold rule: which hostiles stop a hold (tasks/mend-threat.ts)

A hold puts a piece that is no blade (an elytra, a spare tool) in the main hand for 0.3 to 3.5 s while the bot stands
where it is, its armour on and the shield in the offhand. The first rule was a radius: any hostile within 16 blocks, its
way to the bot never looked at. At a home by a lake and caves that is every hour: on the Realm three drowned lay within
16 at noon and eleven hostiles within 32, none fighting and none able to reach the bot through its walls, and a smelt
of 8 raw iron there mended nothing by night (`held the elytra for furnace 0 ticks`) and by day (no hold: the refusal
was not logged). The same on the test server, a walled and roofed room with the furnace inside, drowned in a lake
beside it, a zombie in a pit, zombies and a skeleton behind the walls (7 within 16): the take 0 uses, the 6 points to
the bar.

Now a hostile stops a hold only when it can hurt the bot during it, by the fight rules' own tests (skills/combat,
unchanged), nearest first:

- it hit the bot in the last 10 s (the mob tracker's hit guess);
- it is within the reflex's strike reach (3.9 + 1, eye to box) with a line on the bot;
- a creeper with its fuse lit within 8;
- a shooter (an archer, a witch, a blaze, a ghast, a breeze, a shulker, an evoker, a drowned holding a trident)
  within 16 with a line of sight to the bot's eye (targeting.ts `lineOfSight`: glass and walls block it, a window does
  not);
- a flying mob within its walk bound (below) with a line of sight;
- any other mob whose walking path to the bot (the guard's path probe, pathReach.ts: the bot's own walk, no digging, no
  placing) is no longer than what it walks in the hold (reflex.ts `mobSpeed` x 70 ticks) plus its reach plus one block:
  a zombie 11.2 path blocks, a baby zombie 16.8, a spider 14.6, a creeper 11, an enderman 24.4. A cached path counts 3
  blocks shorter than it was found (the mob may have come that much nearer since), never shorter than the straight
  line; while a new probe runs, a mob that had a path counts by its straight distance and one that had none still has
  none. A mob never probed yet stops a hold within 6 blocks only (a hold or a take waits up to 30 ticks for the probe).

The rule is asked before the piece is moved, before the take and every tick of the hold, and the hand comes back the
tick it says no. Where the body walks away from where it stands, the old radius stays: the walk to lying orbs and
`!mend`'s mine source wait while any hostile is within 16.

Measured (test/e2e/mend.test.ts `MEND_PROBE=reach`, flat open ground, easy, midnight, guard off so only the reflex
fights, a diamond sword in the hotbar, no armour, the mob summoned 15 blocks off and 3 orbs 5 blocks behind the bot,
n5 a side):

| Mob | How far it came in 3.5 s while charging | With holds (mendOnTheWay on) | Without holds | Damage on / off |
| --- | --- | --- | --- | --- |
| zombie | 8 to 8.5 blocks (2.3 to 2.5 a second); a baby 15 to 5 in about 2 s | 4 of 5: a hold made at 14.5 to 14.9, ended by the rule at 10.9 to 11.0 (`a zombie 11 blocks off with a clear way to me (10 path blocks)`), the zombie in strike reach 2.9 to 3.0 s later; 1 of 5 a baby: `not held for orbs: a zombie 15 blocks off with a clear way to me (14 path blocks)` | no hold | 0 / 0 in every run |
| spider | 13 blocks (3.7 to 3.8 a second) | a hold ended by the rule at 14.3 to 14.5 in 2 of 5 (strike reach 2.5 and 2.6 s later); 3 of 5 the spider walked off or waited, the hold ran out or its orbs came | no hold | 0 / 0 |
| skeleton | an arrow crosses 16 blocks in well under a second; it shoots about every 3 s, so a hold in its line would see one | 3 of 5 never held (within 16 with a line); 1 held while it was farther, ended when it came within 16 with a line (`a skeleton 16 blocks off with a line on me`); 1 held with no line to it | no hold | 3, 8, 0, 0, 0 / 7, 0, 0, 0, 0 (one arrow 3 or 4 on easy, no armour; the holds had no part in them) |

The reflex kills a zombie on easy with a diamond sword before it lands a hit, so the damage says little; what it shows
is that no hold was in the hand when a mob came within strike reach, in any run.

What a hold in a fight would do (the same probe with the rule switched off, `MEND_FORCE=1`, a zombie 8 off, n3): the
zombie came within strike reach with the elytra in the hand 3 of 3, and the hand stayed on the elytra 1.2 to 2.2 s
longer; the reflex's blade strike (Track E3, combat.ts `swapHandOk`) does not take an elytra out of the hand, it
strikes with it, and the hold ended by its own rule (`no orb near`, `the time limit`), never `the hand was taken`. A
held pickaxe, shovel or hoe would be swapped for the blade for the strike's tick and back, and the hold would go on.
So nothing in the fight ends a hold: the hold rule has to.

### Before and after (test/e2e/mend.test.ts, bds-farm, 2026-11-20)

A Mending elytra at 132/432 carried in main-inventory slot 20 unless said; n is runs of the case.

| Case | Before (the tree without K5) | After |
| --- | --- | --- |
| `!smelt iron 8` near a furnace (on the way) | 0 uses; the 5 or 6 points to the bar (the rules probe: a carried piece gets nothing, n3) | a hold at the take only: 10 to 12 uses in 13 of 15 runs, the bar 0; in 2 the hold ran its 70 ticks with 2 orbs near the furnace that never came, 8 uses and 1 point to the bar; with the walk at the job's end: 10 to 12 uses in 6 of 6, the bar 0; the held slot and slot 20 back each time |
| the same with a Mending iron chestplate worn at 140/240 | the chestplate alone mended | elytra + chestplate 10 to 12 uses in 14 runs (for example 0 + 12, 8 + 2, 12 + 0, 6 + 4, 0 + 10, 6 + 6), the bar 0; `!mend status` lists both, the chestplate `(worn)` |
| `!mend elytra 10` with 8 raw iron and 2 coal carried | no such command (the old `!mend` moved a tool to the offhand) | `mend: elytra 132 -> 140..144/432 in 1 min: smelted 8 raw_iron; stopped: no source of experience: ...` in 15 runs (138 once, before the walk at the job's end) |
| `!mend 5` with an iron pickaxe and a coal vein in the floor 3 blocks off | - | 6 ores with a swap per ore and a 6-tick hold: +4, +4 uses, 3 and 5 points to the bar (n2); 10 ores, the piece staged once, 16 ticks, the walk's own ore digs held too: +10 to +20 uses in 11 of 12 runs (0 to 7 points to the bar), 0 uses and 3 points in 1 (a run before the hold lines were logged); with the walk to an ore's orbs: +10 to +16 uses in 6 of 6, 2 to 4 points to the bar |
| `!smelt iron 8` in a walled, roofed room, 7 hostiles within 16 that cannot reach (drowned in a lake beside it, a zombie in a pit, zombies and a skeleton behind the walls), midnight, easy | the first hold rule (K5 as merged): 0 uses, 6 points to the bar | the hold rule: 12 uses, the bar 0 (`held the elytra for furnace 16 ticks (orbs near: 2; ended: no orb near): 132 -> 144/432`) |
| a zombie killed inside that room (it was summoned 1 block from the bot) | 0 uses, 5 points to the bar | 0 uses, 5 to the bar: the orbs fell on the bot and were picked up before the fight's end freed the hand (`held the elytra for orbs 6 ticks (orbs near: 0 ...)`); a kill's orbs that lie 4 to 6 off still wait for no hostile within 16 (the walk's rule) |
| a zombie / a skeleton killed by the reflex, the elytra carried (the watcher) | 1 of 3 / 0 of 3 runs mended (orbs 4 to 6 off, not drawn in) | with the walk to the orbs: zombie 10 uses 3 of 3, skeleton 10 uses 2 of 3 (one run's orbs lay 9.6 off, out of reach of the 8-block look) |

### Uses an hour (computed from the rates above, not measured over a day)

- Smelting on one furnace, the bot standing by it: raw iron 0.7 points an item, 360 items an hour: about 500 uses an
  hour; raw food about 250; cobblestone about 70.
- A `!mend` on a coal vein beside the bot: 10 ores in 25 to 45 s for 12 to 20 uses, about 1 000 to 2 800 an hour while
  the vein lasts (veins are small; lapis and diamond pay 3 to 7 times more an ore).
- On the way (no command): what the bot smelts and cooks anyway plus the reflex's kills. `!get kit iron` smelts 9 to
  24 raw iron (13 to 34 uses), a stack of 8 food cooked about 6, each hostile killed near 10. A flight costs about 1.2
  uses a second (a 150-block trip about 31 with its margins, docs/flight.md), so a normal day on the way pays back a
  short flight or two; a long trip needs `!mend` (an hour of iron smelting mends more than a whole elytra's 432 uses).

### Not built

- **A background chore** (`autoMend`): `!mend` is typed. A chore would smelt the home stock or dig ore near home with
  nobody asking; the K4 and K1 chores show the shape (by day, idle, within 16 of home, no hostile within 16), and the
  job here is the work it would run.
- **Kills on purpose**: a kill pays 5 points (10 uses, measured for a zombie and a skeleton) in 4 to 13 s plus the walk
  to its orbs, so a stream of hostiles (a mob farm, a dark area at night) would be about 1 000 to 2 000 uses an hour.
  It would take a `!mend` source that seeks hostiles at night (`!kill <mob>` steps, the watcher's hold and walk after
  each kill, built), the night rules (the shelter, health, the reflex) and the armour kept on; it risks the bot, so it
  would ship off. Spiders by day walked off (2 of 3 not killed in 60 s) and a phantom summoned by day burned 67 to 70
  blocks away, so neither was measured.
- **The Nether**: quartz ore paid 2 to 3 points (n3, 4 to 6 uses) and nether gold ore 0 to 1; the ore source already
  takes `quartz_ore` when it is near, so `!mend` in the Nether digs it. A trip there on purpose (the portal, the
  Nether's rules in docs/nether.md, ghasts and piglins) is not built.
- **Several furnaces at once**: the cooker uses one furnace a batch; a raw-iron smelt pays about 500 uses an hour on
  one furnace, the bot standing by it.
- **The offhand**: the server refuses an elytra there, and a Mending shield in the offhand is mended where it is; no
  other piece is moved into the offhand (the shield goes back only into an empty one).

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
