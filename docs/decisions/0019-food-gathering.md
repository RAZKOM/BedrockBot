# 0019: Food gathering: hunt passive mobs as a process, cook over item stack requests, an automatic chore below user commands

Date: 2026-10-29. Status: accepted (PLAN.md task 7.16, Track X). Server: BDS 1.26.60.6 (`bds-food`,
flat world, difficulty easy, truth pack). Details and numbers: [../food.md](../food.md).

## Context

On 2026-10-29 the Realm bot died 6 times; its health sat at 5.5 for hours because it carried no food
and had no way to get any. The survival kit (0014) eats what is carried; nothing put food into the
inventory. Survival of the bot outranks finishing any command, but an automatic behaviour must not
fight the owner's commands or the protective processes (flee, guard, night; 0012).

## Decisions

1. **Hunting reuses the PvE stack.** Targets come from the entity tracker; the walk is a `near` goal
   through the settings mover (so the planner opens gates and honours `closeDoors`); the kill is
   `CombatController.fight` (which refuses players on its own); drops come from `collect`. No combat,
   nav or collect code changed. Food is counted as the inventory delta around each kill.

2. **Never empty a herd; never kill babies.** A kind is hunted only while it has more than
   `foodLeave` (default 2) adults within the 48-block radius; babies are skipped (they drop nothing)
   and do not count as herd. Babies come from the `baby` actor flag in `add_entity` /
   `set_entity_data` metadata, tracked by a small listener in skills/food (combat/hostiles.ts was not
   this track's). Nearest first, weighted by the expected food per kill.

3. **Cooking is a furnace window driven by item stack requests (verified, not guessed).** The probe
   pinned window 2 / type `furnace` or `smoker`, slots 0 input, 1 fuel, 2 output, slot types
   `furnace_ingredient` / `smoker_ingredient`, `furnace_fuel`, `furnace_output`, `place` into the
   first two and `take` from the output, all `ok` with the chest-style click to open. The cooker
   sends its own requests (ids from -200001, disjoint from world/containers.ts and the survival kit),
   predicts the destination slot so world/containers.ts can apply the response, records hotbar wire
   items, and waits at the furnace until the batch is done. Without fuel or a furnace the food stays
   raw: eating raw beef beats starving, and the eat rules already rank raw below cooked.

4. **`!food` and `!cook` are user processes; the automatic trigger is a new chore priority 30.**
   Between user commands (40) and the home return (20): anything the owner asks for, and every
   protective process, pre-empts it; it still beats walking home. It starts only when `autoFood` is
   on, no user process exists (so never during a `!goto`), it is day (23000 to 11500), the food
   carried is below `foodMin` (10) hunger points and a target is in range. One process object,
   registered once (persistent), holds at most one job; at night it stops wanting control and goes
   on the next day.

5. **Backoff instead of searching.** When the trigger sees nothing to hunt, or an attempt gains
   nothing, the next attempt is 10 minutes later (30 s after one that gained food). The chore does
   not roam beyond 48 blocks looking for animals; that would be a long unplanned trip away from
   home and the shelter.

6. **Wiring through the stable registration point.** One import and one line in the afk task's
   registration list (`registerFoodCommands(d, { containers, clock })`), one priority constant, three
   settings, one truth file; everything else lives in the track's own files.

## Consequences

- A bot with no food now feeds itself by day when animals are near: in the e2e the chore started
  within about 1 s of the food being cleared and gathered 3 to 5 items from 2 cows; it never started
  during a `!goto`, and started 0.2 to 0.4 s after the arrival.
- The leave rule protects herds but cannot tell the owner's animals from wild ones; near a breeding
  pen the owner should raise `foodLeave` or switch `autoFood` off. Without breeding, a herd near home
  ends at `foodLeave` adults and the chore then backs off every 10 minutes.
- With 2 cows allowed per 4, the loot table (1 to 3 beef per cow) decides whether `!food 6` reaches 6;
  the e2e asserts the kills and survivors, not a fixed yield.
- The cooker blocks the bot at the furnace for 10 s per item (5 s in a smoker); a guard fight or flight
  pre-empts it and the next run collects what was cooked meanwhile.
- PRIORITY gains a fourth auto level; later chores (farming rounds, restocking) can share it.

## Rejected

- **Hunting inside the survival kit's 10-tick rules**: the kit acts in place (eat, equip, drop); a
  hunt walks and fights and must yield to guard, flee and night, which only the process manager does.
- **Starting the chore while a user command is paused or queued**: the owner's intent comes first;
  the chore waits for an empty user stack.
- **Loading the furnace and leaving**: needs a memory of furnaces and their contents across restarts;
  waiting 40 s for a typical batch is simpler and was measured.
- **Killing until n items regardless of the herd**: emptying the area of animals ends the food supply.
