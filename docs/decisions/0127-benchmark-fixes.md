# 0127: A benchmark of the common jobs, and what it fixed: near walks bounded, a blocked staircase goes round (Track EF1)

Date: 2026-11-22. Status: accepted. Two rules change for every bot: a walk to something near has a bound, and a
branch-mining staircase blocked at its tip backs up and turns. No new setting. A third change, sprinting through steps
and turns, was measured and dropped. Details and numbers: [../benchmarks.md](../benchmarks.md),
[../pathfinding.md](../pathfinding.md) "A near walk has a bound" and "Sprinting through steps and turns: measured and
dropped", [../mining.md](../mining.md) "A blocked staircase backs up and turns".

## Context

The jobs had been proven one by one, on flat test worlds or small fixtures, and their speed was an impression. Track
EF1 added one e2e suite (`bot/test/e2e/bench-jobs.test.ts`) that runs 17 common jobs five times each on a generated
world (the default generator, seed 7, reset before every run) and writes one JSON row a run: the time, the items, the
time to the first item, where every tick went (walk, plan, act, wait, dig, pickup, chest, job, idle), the failures and
their causes, corrections and stuck recoveries, and a player's pace for the same work. The rows read counters that now
live in the code they count: `Navigator.totals` and `Digger.stats`.

The "before" arm (base 9edb0880) ranked by failure rate and by distance from a player's pace:

1. **`!mine diamond_ore 4` failed 4 runs of 5**: the branch staircase down to y -58 was blocked at its tip on all three
   sides, by gravel over the step (at y 100, 70 and 22) or water beside it (y 52), and the run ended `blocked` 18 to 42
   steps down with no diamond.
2. **`!get oak_log 64` was 2.4 times a player's pace**, with 46 % of its ticks planning: 54 walks to an item or a stand
   cell by a tree timed out. A goal no short way reaches (a sapling on the leaves, a cell behind the trunk) was searched
   for in the whole loaded world until the search touched an unloaded chunk; "no progress" with unknown world in the
   way made the navigator wait and search again every 10 ticks until the walk's own timeout. One spot lost 6 181 of
   8 989 ticks that way; iron mining lost 426 ticks on one spot.
3. **The walks of 200 and 500 blocks were 2.2 to 2.3 times a player's pace.** About half of it is the way (1.2 to 4.4
   times the straight line round the mountain and the lakes, with digging and placing off, as they are by default);
   the rest is the walk's speed: 4.0 to 4.4 blocks a second where a sprint is 5.6. The sprint rule ends a sprint before
   every jump and drop and needs a straight run of 6 nodes to start one.

## Decision

1. **A walk to something near has a bound** (nav/nearway.ts, `GotoOptions.maxWay`, `PathOptions.maxCost`). The walk
   to an item on the ground (the collect: every job's pickups) and to a stand cell by a tree (the feller: its stand
   cells and the foot of a pillar) is worth 3 x the straight line + 16 blocks, at least 24. The planner expands no node
   whose cost from the start is over it, so a goal no such way reaches ends `unreachable` within a few ticks and the
   caller's existing rule for it (the collect skips the item after one retry, the feller tries its next cell) runs at
   once. A walk to anything far has no bound.
2. **A blocked staircase backs up and turns** (mine/branch.ts). A tip blocked straight on, right and left goes back 3
   steps up its own staircase and tries a step to the right, then to the left, of the way the staircase took from
   there, then one step further back, up to 6 back; the first step that passes the dig rules becomes the staircase. At
   most 6 detours a run (`DETOURS`), then a tip blocked all three ways ends the run as before, with the detours in its
   reason. The dig rules are unchanged: no detour digs beside water or lava or under gravel.
3. **The sprint rule stays.** A follower that counted a one-block step in the run a sprint needs, took it at a sprint
   and kept a sprint through a turn of up to 40 degrees was 2 to 12 % faster on BDS's walks and wood runs but drew 0 to
   32 server corrections a run (a median of 5) where the rule above draws 0 to 3, and made one iron-mining spot 19 %
   slower; it was dropped, not shipped off.
4. **The benchmark stays**: the suite, its protocol (docs/benchmarks.md), the counters, and the before / after table.
   A change meant to make a job faster is measured on it before and after, on the same spots.

## Consequences

- `!mine diamond_ore 4`: 1 of 5 runs done -> 5 of 5 (one detour on each of the 4 spots that had been blocked).
- `!get oak_log 64`: the median 252 -> 149 s (915 -> 1 594 logs an hour), the slowest spot 449 -> 139 s, timed-out
  walks 54 -> 2. `!mine iron_ore 16` with stone tools: one spot 103 -> 66 s. Every other job within its spread.
- A pickup or a stand cell no short way reaches is given up at once instead of after a timeout of 15 to 30 s. An item
  that a long way round would reach is left (a player leaves it too).
- A staircase can leave dead ends of up to 3 steps behind it.
- Still open (docs/benchmarks.md): the way back to the surface after a branch run (about 4 minutes in 2 of 5 runs),
  the way on foot round hills and lakes, farming's pace, a breed feed that does not take.
