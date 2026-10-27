# 0035: Home containers by walking distance, an unreachable memory, a read cap per scan

Date: 2026-10-29. Status: accepted (PLAN.md Phase 7 wave 9, Track AN; follow-up to 0028).
Server: BDS 1.26.60.6 (`bds-home`). Details and numbers: [../home.md](../home.md) "Walking distance".

## Context

On the owner's Realm the first session scan found 181 containers within `homeChestRadius` 16 of home
and walked to each one; every chest above floor level ended `goto: unreachable` after several plans,
and the next session tried them all again. The owner asked for "walking distance ... or a toggleable
thing".

## Decisions

1. **Radius as the filter, the planner's path length as the distance.** Every candidate gets a bounded
   probe plan (4 000 nodes / 300 ms, sliced on the main thread like the miner's probes, no digging or
   pillaring) from home, or from the bot when it stands at home. No path, or a path longer than the new
   setting `homeChestWalk` (32 path blocks), makes the container unreachable. `homeChestWalk 0` is the
   toggle: no probes, the radius alone, as before.
2. **Unreachable is remembered.** The chest record keeps the reason and the time (`chests.json`); scans
   skip it for an hour, `!chests scan` retries at once, a read clears it, `!chests clear` forgets it.
   Unreachable containers are never unload targets. `!chests unreachable` lists them (3 messages at most).
3. **Probe all, then read at most 64.** Probes are cheap (8 to 9 ms per candidate on bds-home); walks are
   not. The nearest 64 by path length are read per scan, the rest is pending for the chore's next idle
   moment at home.
4. **One goal for the probe and the walk**: `getToBlock`, reach 4, `face: false` (main's container
   rule), and a new option `low: 3`: from a side column the feet may be up to 3 blocks below the
   container (3-high stacks, pillars, shelves), reach still decides.

## Consequences

- 181 candidates cost about 2 s of probing and at most 64 walks per scan; the 41-odd unreachable ones
  cost nothing for an hour.
- A container reachable only by digging or pillaring counts as unreachable (the owner's base is not
  dug into); a probe from home with no standable start falls back to the radius alone.
- The scan line changed: `chests: 181 within 16 blocks, 140 reachable within 32 path blocks, read 64
  (76 pending), 41 unreachable, in 95 s`.
