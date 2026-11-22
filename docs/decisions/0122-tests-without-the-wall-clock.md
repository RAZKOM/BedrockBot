# 0122: The unit run without the wall clock: a work clock for the planners, a perf project, CI (Track REL3)

Date: 2026-11-22. Status: accepted. A rule for every unit test; no setting, no change to the bot's behaviour. Details:
[../testing.md](../testing.md).

## Context

The default unit run (`pnpm test`) went red on a loaded machine and green alone, so a red said little. Beside 15 busy
processes on this PC's 32 cores, about 20 cases failed in one run. Each red came from one of three things:

- **Time bounds.** A test asserted milliseconds: A*'s 1000 paths with a p99 under 50 ms (161 ms measured under load),
  the coarse corridor under 500 ms (710), a navigator tick under 100 ms (136 idle beside the rest of the run), the
  long-drop scan, the panel's render time, the block registry's build, World.find's scan.
- **Search budgets on the wall clock.** The A* planner stops a search at `maxMs` (250 for a findPath, the navigator's 40
  ms main plan, 100 ms segment, 8 ms slices) and the coarse layer at 500 ms. Under load a search ran out after fewer
  nodes, and a closed-loop test planned twice, walked a partial path, took more ticks or timed out: nav-digway,
  nav-digout, nav-offpath, nav-r3, nav-r6, nav-shut-in, nav-v2, nav-variety, nav-water, nav-sim, survival, fall,
  coarse, fly-corridor. The reachability benches ran the real planner worker thread, which searched on the wall clock
  at its own pace while the test thread paced ticks by wall time.
- **Fixed sleeps and load-time clocks.** events/store's retention case slept 50 ms and then looked; panel-page's tap
  case took "61 s ago" from a timestamp made when the file loaded.

## Decision

1. **No wall-clock bound in the unit run.** A wanted time bound moves to the perf project as it was; the unit case keeps
   the work side of the same property (nodes expanded, blocks tested, ticks, polls).
2. **The perf project.** `bot/test/perf/**/*.test.ts`, vitest project `perf`, `pnpm test:perf`. The real clock, one file
   at a time, on an idle machine. Not part of `pnpm test`, not part of CI.
3. **A work clock for the planners in the unit run.** `searchClock` (skills/nav/astar.ts) and `coarseClock`
   (skills/coarse/search.ts) are `performance.now()` in the bot; the unit project's setup file (`test/unit/setup.ts`)
   replaces both with one counter that moves a fixed step a reading: 0.08 ms for A* (it reads once every 64 nodes
   popped and at a slice's start and end; this PC's idle rate on a walking search is 0.083 to 0.11 ms), 0.05 ms for the
   coarse layer (it reads once a volume; the unit tests' largest plans expand about 4 000, which an idle PC did inside
   500 ms). The planner client's no-answer check (skills/nav/worker.ts) reads `searchClock` too.
4. **The benches plan in the test's thread.** `Navigator.attachPlanner` takes a `spawn` option (a `PlannerWorker`); the
   reachability benches pass the worker's own loop (`runPlannerWorker`) on a MessageChannel, and while the navigator
   waits they let it search `paceMs` of work-clock time a tick.
5. **Async waits wait on a condition** (`vi.waitFor` with a generous limit) and a case that prints elapsed time holds
   the clock still (fake `Date` or fake timers). The unit project's `testTimeout` is 120 s, a hang guard: the
   closed-loop benches take 3 to 4 times as long beside a load as alone.
6. **CI** (`.github/workflows/ci.yml`): on push and pull request, Node from `.nvmrc`, pnpm at its pin through corepack,
   the pnpm store cached; a frozen install, lint, `pnpm test`, the docs index check, `pnpm bot:check -- --no-config`. A
   unit test reads the workflow and holds those steps.

## Consequences

- The unit run is the same on any machine under any load; a red is a fault. The perf project still measures speed,
  when someone runs it on an idle machine.
- A* expansions that dig cost more than walking ones (about 1 ms per 64 on this PC in nav-r3's dig search, 10 times a
  walking search), so on the work clock a dig-heavy search gets more nodes in its budget than on a live machine, and
  a bench case whose searches are cut off live may not be in the unit run. The unit run is deterministic, not a copy of
  a live budget; the live budgets are the e2e suites' and the Realm's to show. nav-r3's long trip takes about 90 s
  alone (30 s with the real worker thread).
- The planner client's no-answer check (fall back to an in-thread plan after the budget and 2 s) reads the search clock, so
  in the unit run a real worker thread that hangs is not given up on: the case ends at its timeout instead. In the bot
  the check is on the wall clock as before.
- The flight route search and the coarse graph builds' own time stats are still on the wall clock; no unit test bounds
  them (their tests pass a large `maxMs`).
- A new test that needs time passes a large `maxMs`, measures nodes, or goes into `test/perf`.
