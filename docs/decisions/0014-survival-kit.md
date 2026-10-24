# 0014: Survival kit: server-completed eating, armour and drops through item stack requests, avoidance as cost

Date: 2026-10-29. Status: accepted (PLAN.md task 7.11, Track S). Server: BDS 1.26.60.6 (`bds-surv`,
flat world, difficulty normal, truth pack). Details and numbers: [../survival.md](../survival.md).

## Decisions

1. **Eating is one `click_air`; the server finishes it.** Probed on BDS 1.26.60.6 against the truth
   pack's item use log: an `inventory_transaction` `item_use` / `click_air` with the food held starts
   the use (`itemStartUse`, duration 32) and the server completes it by itself 31 ticks later
   (`itemCompleteUse`, clientbound `item_release` / `consume`, new stack, hunger and saturation
   attributes). Nothing has to be held or released by the client; `item_release` / `release` (or a
   slot change) cancels. The `start_using_item` input flag, `player_action start_using_item` and a
   client `consume` were not needed. So the eater is a click plus a wait with a timeout, not a
   per-tick "hold use" state in the input loop.

2. **Eating waits for the navigator unless it is urgent.** The server slows a player who uses an item
   (6.3 instead of 11.9 blocks in 65 ticks, measured) and the client movement model does not know it:
   6 corrections in one walking bite. Automatic eating therefore starts only while the navigator is
   idle, except below food 6 or health 10. Never during a fight above health 6 (the combat skill's
   weapon switch would cancel the bite anyway); a hit of 4 or more stops eating above health 6.

3. **Armour goes on through `item_stack_request` into the `armor` container**, with the inventory
   screen open (`interact open_inventory` ... `container_close`), as PlaceSkill's main-to-hotbar move:
   `place` into an empty armour slot, `swap` with a worn piece. Without the screen BDS answers status
   50. (A `click_air` with the piece held also equips it; not used, the request path is explicit and
   does not touch the held slot.) Material ranking by armour points x 10 + toughness; a piece at the
   tool-wear limit ranks below every intact one.

4. **The survival kit sends its own item stack requests** (ids from -100001 down) and awaits its own
   responses, next to world/containers.ts (ids from -1), which keeps applying every ok response to the
   model. Containers.move would have needed armour-container and drop support; the kit stays outside
   that shared file. The armour window itself is updated by the server's `inventory_slot`.

5. **Drops are `item_stack_request` `drop`** (a hotbar slot works without the screen, the main
   inventory needs it; the legacy `world_interaction` transaction also works but is not used). The
   keeper never drops tools, weapons, armour, non-junk food, logs, planks, chests, torches, bones or
   gunpowder; junk is a configurable list (rotten flesh, poisonous potato, string, spider eye). An
   owner's `!drop` may drop anything.

6. **Tool wear reads the NBT `Damage`.** The world model now keeps `ItemStack.damage` (the item NBT's
   `Damage` int, verified in `inventory_transaction` / `inventory_slot` / `inventory_content`); the
   maximum comes from a Bedrock table. `toolOk(item)` is a predicate hook on the Digger and the
   CombatController (default always true): a worn slot counts as an empty hand / no weapon.

7. **Avoidance is planner cost, never a wall, and the follower must respect it.** A cell within
   `avoidMobRadius` (4) of a hostile or `avoidSpawnerRadius` (8) of a spawner costs `8 + 12 x (r + 1 -
   d)` ticks (at most 80 per source), built afresh for every plan from the entity tracker and a
   spawner index. A goal inside a zone stays reachable. The path follower's pure pursuit used to aim
   up to 6 nodes ahead whenever the straight line was walkable, which on open ground flattened every
   detour back into the straight line (measured: the plan bent to 9 blocks, the body passed at 0.8);
   it now refuses shortcuts through cells costing more than the nodes they skip.

## Rejected

- A per-tick "hold use item" state in the input loop (not needed: decision 1).
- Walls (infinite cost) around mobs and spawners: goals next to them (a chest near a spawner, a fight)
  would become unreachable.
- Editing world/containers.ts for armour and drops: a shared file with its own request id space; the
  kit's sender is 100 lines and does not change anybody else's behaviour.
