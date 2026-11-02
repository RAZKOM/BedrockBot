# 0045: Crafting through the normal screens, and compaction as its first use

Date: 2026-10-30. Status: accepted (Phase 7, wave 11 Track AW). Server: BDS 1.26.60.6 (`bds-craft`,
udp/19208). Details: [../crafting.md](../crafting.md).

## Context

The owner asked that a full chest holding iron blocks and iron ore, with the bot trying to drop off
more iron ore, get its ore crafted into blocks so the load fits. Decision 0039 had left crafting to a
skills track with a guess at the packets (`craft_recipe`, `results_deprecated`, a `consume` per
ingredient, a `place` from `created_output`), unverified. The bot plays on a Realm with other
players: it may only do what a vanilla client can do through the crafting screens.

## Decisions

1. **Measure before modelling.** A probe with a `PacketRecorder` on bds-craft settled the shapes:
   the recipe list in `crafting_data` (grid size decides between the inventory and a table, every
   grid recipe has `block: 'crafting_table'`), the 2 x 2 grid as `crafting_input` 28..31 in the
   inventory screen and 32..40 in a `workbench` window, a batch as two requests (the fill, then
   `craft_recipe` + one `consume` per cell + a `place` from `creative_output` slot 50 whose stack id
   is the request's own id), the error statuses (35 wrong grid, 17 no result transfer, 3 / 49 lone
   actions), and two facts that shaped the code: BDS **destroys items left in the grid at close**
   (the vanilla client moves them back itself), and the craft action's second header byte must be
   **BDS's own enum value 12**, not minecraft-data 3.117.0's 10 (its mapping lacks the two bundle
   actions), else the server answers a terminating `packet_violation_warning` and closes the
   connection. `craft_recipe_auto` is not sendable with the current definition and is not used; the
   clean fix is a renumbered action mapping in `patches/minecraft-data@3.117.0.patch` (the TODO at
   `CRAFT_RECIPE_WIRE_TYPE`), after which the constant and the name agree.
2. **The vanilla UI path, not the recipe book.** Fill the grid, craft, take the output, give the grid
   back, close: what a player does by hand. One extra request per batch; no server sees anything a
   client cannot send.
3. **A pure recipe index and plan.** `RecipeIndex` keeps the server's grid recipes by output;
   `planCraft` chooses the recipe by what the inventory allows now, resolves tags against item names,
   caps batches at one stack of output, and reports the shortfall. The keep rules of `!drop items`
   (tools, armour, food, totems, shulker boxes, ender chests), the flight kit and a `craftReserve`
   setting shrink the pool before any plan: nothing protected is ever an ingredient.
4. **A table is borrowed, placed or made, and always picked up again.** A crafting table within reach
   and in sight is used as it stands (one behind a wall is walked to); else the carried one is placed
   on a free cell next to the feet (not on a container or a built block), used and dug (only that
   cell, only while it still holds a crafting table); with planks but no table the bot crafts one
   first. A table left standing (a refused or pre-empted dig) is remembered and picked up at the next
   craft; the reply says when one was left.
7. **Nothing in the grid is ever abandoned.** The output slot is chosen before the fill (a full
   inventory refuses before anything moves); the give-back plans destinations with their counts,
   retries cell by cell and drops on the ground as a last resort; a request without an answer is
   waited for and then resolved against the server by the give-back itself.
5. **Compaction is a 9 -> 1 table, not a guess.** Raw metals, ingots, gems, coal, redstone, lapis,
   netherite; never sand, cobblestone or anything that does not come back as the same item.
   `!compact` compacts everything carried in nines; the unload plan carries a `compact` step
   (unloader.ts `compactPlanner`) when a kind overflows or its target chest would end with no free
   slot, and the unload job (Track AV, under its serial lock) runs it through `compactRunner`
   (installed by commands-craft.ts, reset when the task stops), saying `compacted 54 raw_iron into 6
   raw_iron_block` before its moves. No wrapper around `HomeLogistics.unload`: a craft opens its own
   screen and must not race the job's container. `compactOnUnload` turns it off.
6. **Commands as user processes.** `!craft` and `!compact` (tier more, group work) run on the
   process manager: `!stop` ends them between batches, a pre-emption pauses and the job resumes for
   what is left; the NL front end gets a `craft` step.

## Consequences

- Timings on bds-craft: 2 requests and about 0.4 s per batch (up to 64 output items), 0.8 s from a
  `!craft oak_planks 32` to its end line; a 3 x 3 craft with the carried table 6.6 s (the dig of the
  table with the bare hand is most of it), 0.5 s with a table standing; the owner's unload case 1.5 s.
- The crafter keeps its own request ids (-400001 down) and predicts the output into the inventory
  model: crafting responses carry counts only and no `inventory_slot` follows.
- The compaction decision uses the chest memory as it is (a chest changed since its last read within
  10 minutes is not re-read by a scan); a needless compaction only turns items into storage blocks.
- Shared files touched, all marked `// Track AW`: `skills/home/unloader.ts` (the `compact` field and
  its planner hook), `config/settings.ts` (two settings and the reserve parser), `tasks/registry.ts`
  (one import, one line), `nl/plan.ts` + `nl/prompt.ts` (the step, one example), `packs/truth/src/main.ts`
  (one import, one `Object.assign`), `scripts/bds.mjs` (`craft` profile), `bot/scripts/e2e-profile.ts`
  (`CRAFT_BDS_*`), the plan test's example count.
