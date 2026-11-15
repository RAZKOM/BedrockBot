# 0088: A walk keeps to its way (Track W2 way)

Date: 2026-11-15. Status: accepted; no setting (see decision 9). Builds on [0066](0066-coarse-layer.md) (the coarse
layer and its corridor), [0072](0072-reachability.md) (the walk's reach and its probes) and the landing search that
prices a landing by the probe of its walk (docs/flight.md "L2: the walk priced by its path, probes that finish"). It is
a new record, not an addendum to 0066 or 0072: neither the corridor nor the reach rules change. The navigator gains a
way that it keeps across re-plans, and the flight hands it one. Details and numbers:
[../pathfinding.md](../pathfinding.md) "A walk keeps to its way (Track W2 way, decision 0088)", and
[../flight.md](../flight.md) "The walk after a landing takes the probe's way".

## Context

The owner's goal: a trip flies where it can, and walks the rest by the way a player would take, once, without turning
back.

On the Realm (2026-11-14 and 15), trips to five goals deep in a cave under a mountain landed at the cave's mouth. The
landing search had probed the walk from the landing cell to the goal, 76 to 166 blocks of path, and the trip walked the
rest. That walk went wrong in three ways:

- The end lines said 141 to 214 blocks for probed paths of 112 to 167.
- Twice in 12 trips it turned back to its landing cell, after 98 and 169 ticks.
- Once it wandered: 298 blocks in 7 plans, two fights, three `dive` move timeouts, and 355 s where three repeats of
  the trip took 101 to 154 s.

The live log had only each goto's end line.

Reproduced offline with the reach bench's closed loop over a world-cache extract of the cave (`walk-way-bench.ts`, the
live walking settings and the worker's budgets):

- **Farther: another unit.** The end line's `blocks` is every tick's 3D motion. The probe's is the polyline of its node
  centres. Offline, the walk's own path was 0.93 to 0.99 of the probe's in the probe's unit. Its motion was 1.26 to
  1.37 of it, which is what the Realm's end lines show (1.25 to 1.28).
- **The turn back and the wander: hostiles round the way.** Their costs pushed the walk's first full search past its
  budget, and it ended partial 14 nodes out. The plan-ahead from that end took its best partial end 160 nodes down a
  side passage. The next plan came back. With two zombies on the probed way: 2.3 times the probe's blocks, and 36 turns
  back in 12 of 20 runs on two goals. The probe has no hostile costs, so it had found the whole way.
- **The dive.** A body on a pool's dry rim over a `dive` node sneaked: the follower's sink rule for a body above the
  node. A sneaking body does not step off an edge.
- **A drop beside lava.** The follower creeps off it (about 60 ticks), longer than the move's timeout (34). The retreat
  after the timeout turned the body back onto the step it had left.

## Decisions

1. **A goto can be handed a way** (`GotoOptions.way`). When the body stands on one of its nodes, the way is walked from
   there with no search. On a node means within `WAY_ON_H` 1 by the plane and `WAY_ON_V` 0.6 by height. Not a level
   off: a resumed walk beside its way, 1 block over a node left by a drop of 3, fell 4 and was hurt.
2. **Off the way, the body rejoins it or plans afresh.**
   - Off the way by up to `REJOIN_MAX` 8 blocks, a small in-thread search rejoins it: any node from the nearest plus
     the distance, rounded up, to `WAY_AHEAD` 48 past the last node passed. Its budget is `REJOIN_NODES` 6000 nodes and
     `REJOIN_MS` 120 ms.
   - Farther off, or with a node of the way no longer standable, the goto plans afresh as before.
   - Any re-plan other than the start, a correction or off_path drops the way.
3. **A fresh plan replaces a kept way only when it is clearly shorter.** The goto's ordinary search runs beside a handed
   way at the start. Its plan is taken only when it is shorter in blocks of path than the way's rest by `KEEP_MARGIN`
   0.2 of it and by at least `KEEP_MIN_BLOCKS` 8 blocks, with no more actions than the way. It is spliced in where the
   two meet; if they do not meet, the goto re-plans from where the body is.
   - Why 20 %: the walk's own plans and the probe's differ by 3 to 8 % on the same ground, and the walk's own differ
     with their budget. 20 % is over twice that.
   - Why 8 blocks: on a short way, 20 % is within what the moves' own costs decide.
4. **A walk taken up again goes on along its way.** An interrupted goto that was walking a kept way remembers the rest
   of it for `RESUME_KEEP_MS` 180000 ms. `GotoProcess` asks the goto again with `resume` after a pre-emption, and the
   goto takes that way as a handed one, for the same goal only.
5. **The goto's own way is kept only where the body stands on it.** A goto's own plan that reaches the goal is a kept
   way. After a correction or off_path it is walked on only when the body stands on one of its nodes, from `WAY_BACK` 4
   behind the last node passed to `WAY_AHEAD` 48 ahead. Off it, the goto plans afresh, as before. A rejoin there makes a
   kink that pure pursuit cuts across, which gave a second off_path in the open (the nav-offpath shove case).
6. **No corridor at the start while a handed way is walked.** The coarse layer's corridor is asked only once the way is
   dropped.
7. **One INFO line a plan** for a walk to a place: the reason, the kind (`interim`, `final`, `ahead`, `rejoin`,
   `beside the way`, `the way`), the status, nodes, the blocks of its path in the probe's unit, expanded, ms, and where
   it ends. Each decision of decisions 1 to 5 also has a line of its own.
8. **The follower's two fixes.**
   - The move timeout counts the creep off a drop beside lava (`DROP_CREEP_TICKS` 30 added to the move's estimate).
   - On dry ground over a dive node the sink rule is skipped, so the body walks off the rim and sinks once wet.
9. **No setting.** A goto with no way handed walks as before:
   - offline, tick for tick on the five goals;
   - the nav unit suites and the nav e2e unchanged.

   A handed way is walked only when the body stands on it or within 8 blocks, and it is dropped when it breaks.

## Consequences

- With the probe's way handed, offline, 10 runs a goal: the walk is 1.007 to 1.018 of the probe's blocks, with no turns
  back, with or without hostiles on the way. A walk interrupted and resumed beside its way: 0.991 to 1.031 (the PC and the test host alike), no turn
  back, no damage.
- The probe's way can be a little slower than the walk's own plan, up to 5.3 s on one goal of the five. The probe takes
  no long falls, and its way was not clearly longer, so it is kept.
- The probe plans with no hostile costs. The body walks its way past a hostile that its own plan would have gone round,
  and the guard deals with one that comes close.
- The search beside the way costs what the goto's own first search cost before, and it runs while the body walks. A
  rejoin is a search of some tens of nodes.
- Not done:
  - a way from anything but the landing probe (a learned path, a corridor's) is not handed;
  - a hostile does not make a kept way give way.
