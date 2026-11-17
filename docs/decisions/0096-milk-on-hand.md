# 0096: Milk on hand (Track K1)

Date: 2026-11-17. Status: accepted. `milkKeep` 2 and `milkCraft` on by default; the background refill (`autoMilk`) ships
off. Details and numbers: [../pve.md](../pve.md) "Milk on hand".

## Context

Track M7's `milkCure` (ADR 0079, decisions 51 to 57) drinks a milk bucket once a witch's poison would still take more
than 3. In the gauntlet two buckets took the lowest health of `mixed-8` from a median 6.5 to 18.4 with the rush on both
sides. The rule needs milk, and the bot had no way to get it: it did not milk cows, no job took milk out of a carried
box or a home chest, and `!unload` stored every milk bucket and every empty bucket the drink left.

A milk bucket does not stack. Milk comes from an adult cow, mooshroom or goat, by a right click with an empty bucket.
An empty bucket costs 3 iron ingots at a crafting table.

## Decision

1. **A target count, `milkKeep` (default 2, 0 to 9).** The stock rule (`planMilk`, skills/food/milk.ts) takes the
   cheapest source first: milk out of the carried boxes, then milk out of the home chests (at home only), then empty
   buckets (loose, then boxed, then from the home chests at home) filled at a mob. Each step goes through the Supply
   layer (`Supply.ensure`, ADR 0052), so the carried box rules stay as they are.
2. **The trip readiness takes storage only.** Before a long trip (over 16 blocks) the readiness gains a `milk` phase:
   the missing milk buckets out of the carried boxes and (at home) the home chests. No walk to a cow and no craft
   happen before a trip.
3. **The unloader keeps the reserve.** `!unload` and the room chore keep `milkKeep` milk buckets (keep reason
   `milk_reserve`), and with fewer carried, the empty buckets that would refill the rest. Further milk and empty
   buckets are stored like loot, so the unload and the stock never undo each other, and empty buckets never pile up.
4. **Milking is a process.** `!milk [n] | status` is a user process (priority 40); the milk chore is an auto process
   at chore priority (30). Guard and flee pre-empt both. A job stops at once when a hostile is within 16 (`MILK_THREAT`).
   It only goes to adult mobs within 24 blocks (`MILK_RADIUS`) of the centre (home for the chore) and 4 blocks up or down,
   standing on dry ground (no water or lava at or under their feet), walking with the usual navigation and its safety
   rules. A mob that does not fill the bucket in 3 clicks is left alone for 30 s. Inside a pen the gates are closed
   behind the bot and it leaves the pen at the end.
5. **The click.** `interact` `mouse_over_entity`, then `inventory_transaction` `item_use_on_entity` with
   `action_type: 'interact'` and the empty bucket held: the packet the breeder sends with wheat (`feedTransaction`).
   BDS 1.26.60 answers it with the milk bucket in the inventory 2 to 3 ticks after the click (12 clicks on bds-home,
   checked against the server's inventory by truth). Only cows were milked there; mooshrooms and goats take the same
   click by the game's rules, not measured.
6. **The background refill ships off (`autoMilk`).** When on, it runs only by day, idle, within 16 blocks of home, with
   no hostile within 16, under `milkKeep`, and with a step to take. After a job that gained milk it may run again in
   30 s; after one that did not, or with no mob near home, it waits 10 minutes. It walks home after.
7. **The early game: one bucket, crafted (`milkCraft`, default on).** With no bucket anywhere (carried, boxed or in
   the home chests), 3 iron ingots carried and a crafting table carried or near, `!milk` and the chore craft one bucket.
   One at most: a second needs another 3 ingots, which the bot keeps for its other uses. With no iron nothing is done,
   and `!status` (`milk 0/2 (no bucket and no iron (3 iron ingots make one))`) and `!milk status` say so.
8. **Shown.** `!status` has a `milk N/K (...)` part while `milkKeep` is over 0 or milk is carried; the web panel's
   vitals have a `milk` row (`1 of 2 milk buckets, 1 empty (refilling)`).

## Consequences

- With `milkCure` on, the bot drinks what it keeps, and an idle bot with `autoMilk` on fills the empty bucket again
  (bds-home, 3 of 3: the drink 2.2 to 2.6 s after a 30 s poison, 2 milk buckets again 7.6 to 8.5 s after it).
- Two inventory slots go to milk by default. `milkKeep 0` gives them back and turns the stock and the reserve off.
- The panel's page grew by 1 829 bytes and its poll by 166 bytes (budgets raised: html 140 000, poll 21 100, full
  state 43 000). The settings help is 10 messages with chat lines on.
- Not covered: milking far from home, milking at night by the chore, buying or finding buckets, more than one craft.
