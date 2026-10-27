# 0023: The planner in a worker thread

Date: 2026-10-29. Status: accepted (Phase 7, wave 8 Track AB; follows [0009](0009-navigation-v2.md)).
Servers: BDS 1.26.60.6 (`bds-move`, `bds-cache`). Details and numbers: [../pathfinding.md](../pathfinding.md)
"Compute".

## Context

The owner asked whether the bot uses the Mac's compute or is "rated to the Realm tick speed". It was
the latter: A* ran on the main thread, in slices of 8 ms per 50 ms tick so the physics loop kept its
pace, with a budget of 40 ms for a main plan (the body stands and waits for it) and 100 ms / 20 000
nodes for a plan-ahead segment. Long or awkward routes (a forest 50 to 100 blocks away, the way home
through the house, around long walls) ended in partial segments: the body walked to the node that
looked closest to the goal, planned again from there, sometimes into a dead end, and with 3 failures
gave up `unreachable`. Meanwhile the other cores of the M4 idled.

Measured before the change (see the doc for the full table): the house walk and a 120-block cross
country stretch fit the old budgets (1 plan, 620 and 2 138 nodes); a sealed goal 100 blocks away gave 5 plans of 7 500 to 20 000
nodes, every one at its budget. A goal 120 blocks away behind a cup of walls (about 250 blocks around)
ended in-thread `unreachable` after 5 plans that all hit their budget (the body walked into the cup).

## Decisions

1. **A* runs in one `worker_threads` Worker** (`skills/nav/worker.ts`) with its own copy of what
   NavGrid reads (`worker-grid.ts` `MirrorWorld`): the layer-0 arrays of every loaded section (copied,
   not transferred: the main thread keeps using its own), the BlockInfo of each state id once (sent with
   the first palette that references it, not as a whole table: 73 states over a whole e2e run on the flat
   test world (natural terrain: more, not measured), of about 13 000), single block changes, and the world cache's summaries of unloaded columns along a
   plan's corridor. The worker answers with the same `PathResult` as the in-thread planner, from the same
   `PathSearch` code over a `NavGrid` on the mirror. Unit-tested: 200 random cells (blocks, classes,
   stand, crossing, sky) equal on loaded, updated and cached columns; 20 random start / goal pairs give
   the same status, cost and expansions in the worker thread as in-thread.
2. **Bigger budgets there**: a main plan 500 000 nodes / 2 s, a plan-ahead 60 000 / 300 ms
   (`path.maxNodes` / `path.maxMs` still override both, `workerBudgets` per navigator).
3. **The body never waits longer than before**: after `mainMs` (40 ms) of search the worker sends the
   best partial path so far (`PathSearch.peek()`); the navigator walks it and splices the final answer
   in at the first node of the remaining interim path the final path also visits. Without a common node
   a `found` final answer re-plans from where the body is (reason `upgrade`); a partial one leaves the
   interim path, whose end plans ahead as before. A search that finishes within `mainMs` has no interim.
4. **Stale answers are dropped**: every block change the planner reads (the movement signature
   changed) gets a generation number; a worker answer asked for before a change within the re-plan
   distance of its path (1 block sideways, y - 1 .. y + 2) is dropped (a main plan re-plans with reason
   `block`, a plan-ahead restarts).
5. **Fallbacks**: in-thread planning while the worker is not ready (start-up, the initial snapshot,
   restart after a crash), for options the worker cannot rebuild (a custom `breakTicks` or a `cellCost`
   function that is not the survival kit's avoidance snapshot, which now carries its sources), and when
   the worker does not answer within its budget + 2 s. A crash is logged once at WARN and restarted after
   1 s (at most 5 times). The world cache's record of what the planner read (so a column that loads later
   announces its changed cells as block updates) is fed by reading the cells around each worker path on
   the main thread.
6. **`plannerThreads`** runtime setting (0..1, default 1; `!set plannerThreads 0` = in-thread, today's
   behaviour), read every tick: the worker starts and stops with it. One thread: the navigator runs one
   search at a time (main plan or plan-ahead), so a second thread would idle.

## Consequences

- The tick no longer pays for planning: during a 2 s, 430 000-node search the navigator's longest
  tick was 1.2 ms (in-thread: 9 ms of slices for 40 ms plans); the cup walk is reached with one plan
  instead of failing; the cache-gather forest walk (CLI, natural terrain) took 1 worker plan, 1 segment,
  0 corrections, max tick 3.1 ms (before, another area: 2 plans, 2 segments, 1 correction, 13.7 ms).
- Forwarding costs main-thread time on every chunk load (copying the section arrays): measured on
  the flat world 4 761 columns, 19.7 MB, 53.8 ms in all, 1.6 ms the longest flush (about 0.01 ms and
  4 kB per flat column; natural columns carry more non-uniform sections, 4 to 8 kB each).
- Memory: the worker holds a second copy of the loaded sections (4 kB per non-uniform section:
  about 15 to 30 MB at view radius 10 on natural terrain, estimated from the section count) plus its own module heap.
- The interim answer is A*'s "closest so far" node, which can lead into a dead end; the final answer
  corrects the route (splice or re-plan) instead of the body discovering the dead end on foot.
- Planners outside the navigator (`navigator.plan()`, the mining probe, the e2e checks) still run
  in-thread with their own budgets.
