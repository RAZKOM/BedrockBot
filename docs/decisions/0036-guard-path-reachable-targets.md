# 0036: Guard fights only path-reachable mobs, holds back during walks, gives up fast

Date: 2026-10-29. Status: accepted (PLAN.md Phase 7 wave 9, Track AO; follow-up to 0017 and 0029).
Server: BDS 1.26.60.6 (`bds-pve`, `bds-gaunt`). Details and numbers: [../pve.md](../pve.md)
"Path-reachable targets".

## Context

The owner reported from the Realm that the bot got stuck fighting mobs behind walls on its way to
places. Guard's reachability rule (0017) was a terrain check (the mob stands on a standable cell), not
a path. On a walk a mob behind a wall, a fence or a window passed it, the fight pre-empted the walk,
the approach failed `unreachable` up to 3 times (each goto with the navigator's own 3 failed plans),
the mob was ignored for 10 s and the next guard tick picked it again or its neighbour.

## Decisions

1. **A bounded probe plan before guard commits to a mob not within reach**, reusing Track AN's probe
   (0035: 4 000 nodes, 300 ms, sliced on the main thread, no digging or placing; here also without the
   mob-avoidance cost) to a cell within 1.5 blocks of the mob. Longer than the new setting
   `guardReach` (24 path blocks; 0 = the old terrain rule) or no path: ignored for 30 s with the
   reason, the next candidate in the same evaluation. One probe at a time, verdicts cached per mob
   for 5 s (again when the mob or the bot moved more than 3 blocks); while the best candidate is being
   probed only mobs within reach are picked.
2. **Within reach needs a line of sight** (glass blocks it, a window does not). BDS accepts melee hits
   through glass, but a mob behind glass cannot hit the bot either: not worth leaving a walk for.
3. **Restraint while a user process walks**, new setting `guardWhileWalking` (`reach` | `near` |
   `all`, default `near`): only a mob within reach, or a melee threat, creeper or archer that targets
   the bot within 6 path blocks. The walk's mob avoidance keeps the distance from the rest. Every user
   process except a kill job counts as a walk (simpler and safer than a list of walking commands).
4. **Fast failure in the combat skill**: one approach ending `unreachable` ends the target
   (`approachTries` 1), and a stall watchdog ends it when the bot neither gets 0.5 blocks closer nor
   lands a hit for 60 ticks (out of reach, or 5 strikes in reach without a hit). `unreachable` ignores
   the mob for 30 s (was 10 s). A mob that hits the bot after it was ignored is a target again.

## Consequences

- A walk past a penned zombie (glass, 2 blocks off the route) arrives without a fight in 6.4 s (with
  the old rule: a detour to kill it through the glass). A probe that runs to its budget costs about
  24 ms of search time spread over slices; one that finds its mob in the open well under 1 ms.
- During walks the bot no longer clears mobs farther than 6 path blocks: skeletons that do not aim at
  it, zombies across a river. It fights what comes to it; flee and the walk's avoidance cover the rest.
- A mob reachable only by digging or pillaring is not chased by guard (the probe never digs).
- The stall watchdog also ends fights against a mob that keeps its distance (a skeleton backing off
  as fast as the bot closes in) after 3 s without progress; it is ignored for 30 s.
