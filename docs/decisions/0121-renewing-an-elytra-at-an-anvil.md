# 0121: Renewing an elytra at an anvil: membranes first, the cost checked before paying (Track K7)

Date: 2026-11-22. Status: accepted. One new command, `!repair`, and one new setting, `autoRepair`, off by default.
Details and numbers: [../flight.md](../flight.md) "Renewing an elytra at an anvil (Track K7)".

## Context

An elytra has 432 uses. Track K4 (ADR 0108) puts a better one on when one is to hand and Track K5 (ADR 0110) mends one
with Mending from experience, but an elytra without Mending was used until it was worn out and then only replaced: the
bot had no way to renew one. The owner asked for the anvil, and asked first whether phantom membranes still repair an
elytra in current Bedrock.

Measured on BDS 1.26.60.6 (`test/e2e/repair.test.ts` `REPAIR_PROBE=wire` and `ops`, the levels paid read from the
experience attribute and the item read back from the server):

- **Phantom membranes do repair an elytra**: each gives back 108 uses (a quarter of 432) for 1 level; the server takes
  exactly the units the damage needs (`ceil(damage / 108)`, at most 4); a request that consumes more is refused.
- **Two elytras combined**: the uses of both plus 51 (12 % of 432), at most 432, for 2 levels when the target is
  damaged; the enchantments are merged. An enchantment the sacrifice brings costs its level times a multiplier (Mending
  4, from a book 2; Unbreaking 2 a level); one the target already has at that level costs nothing.
- **The prior-work penalty** (NBT `RepairCost`): 0, then 2 x the larger tag + 1 after each operation (1, 3, 7, 15, 31,
  63); every operation costs both pieces' tags in levels. Four renewals of one membrane each cost 1, 2, 4 and 8.
- **Too expensive at 40**: an operation of 40 levels is refused with status 9 (the status of too few levels); 38 and 39
  were paid.
- **The anvil does not take from the armour slot**: with the elytra on the back the request is refused.

## Decision

1. **`!repair [elytra|<item>] [membranes|combine] [last]`** (group `work`; `!repair status`). The elytra at hand (on
   the back, else the one the flight kit puts on) or the most worn carried item. The repair material first (phantom
   membranes for an elytra: they cost a level each and spend no second elytra), from the inventory, the carried boxes or
   the chests at home in reach (Supply.ensure); else a second one combined (carried, out of a carried box or out of the
   chests at home in reach: the elytra controller's own sources). `membranes` and `combine` force one.
2. **The base of a combine** is the piece whose enchantments the other lacks: the result has both pieces' uses and
   enchantments either way, and the enchanted one as the base costs fewer levels (a Mending elytra as the base 2, as the
   sacrifice 6). The reply names the base and the levels both ways.
3. **The checks before paying**, in this order, each a plain refusal and nothing moved: nothing to gain, too expensive
   (40 or more), the levels unknown or short, and the item's last renewal (one that leaves the tag at 63, after which
   every operation costs 40 or more) unless the command says `last`: the reply says the penalty and the next cost first.
   Every reply of a renewal says the penalty before and after and what the next one costs.
4. **The anvil**: one within 24 blocks of the bot, walked to; **never placed** (an anvil is 31 iron and a block in the
   owner's base; the bot uses one that is there). A worn elytra is taken off (the inventory screen), renewed and put on
   again; the result stays where the base was otherwise. The item's anvil name is sent back so it stays and costs
   nothing.
5. **`autoRepair`** (default off; a goal row): by day, idle within 16 of home, no hostile within 16, an anvil within 24,
   the elytra at hand under 100 uses over its worn limit, **without Mending** (a Mending elytra is mended with
   experience, which never raises the penalty), membranes to hand and the levels: the membranes only (a combine spends
   an elytra: the owner's call), never the last renewal. A pass that changed nothing waits 10 minutes.
6. **The takeoff's refusal** for the elytra (Track F20: the trip needs more uses than the elytra has) adds
   `; !repair renews it at an anvil (N phantom membranes, M levels: 432/432)` when the renewal `!repair` would pay covers
   the trip, or the levels it would need when only they are short.
7. **Phantom membranes are not hunted.** Phantoms come at night to a player who has not slept for three nights; the
   bot sleeps when it can (`autoSleep`), so it sees few. It reports what it has (`!repair status`).

## Consequences

- An elytra without Mending can be renewed about five times (the tag then is 31 and the next membrane renewal costs 32
  to 35 levels); the guard keeps the sixth, after which nothing renews it, behind `last`.
- Items other than the elytra use the game's documented materials and multipliers, not measured here; a wrong
  estimate costs a refusal by the server (it computes the cost itself and refuses what the levels do not cover), never
  levels the bot did not count.
- The anvil wears down by chance with use and breaks in the end (in the probes a fresh one went chipped after 1 to 3
  uses a few times; a chipped one worked alike); the bot uses any of the three stages and says when the anvil is gone.
- Not proven: anything on the Realm; the walk to an anvil farther than reach; membranes or a second elytra fetched from
  the carried boxes or the chests at home (unit tests only); the chore on a server; enchanted books (measured, not used
  by `!repair`).
