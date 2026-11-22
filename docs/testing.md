# Testing: the unit run, the perf project, CI

Three kinds of tests, each with its own command. The end-to-end suites and their servers are in
[runbook.md](runbook.md) "Tests"; this page is about the two that need no server, and the rules that keep them
trustworthy on any machine. The rules are ADR [0122](decisions/0122-tests-without-the-wall-clock.md).

```sh
pnpm lint                         # eslint and tsc, every package
pnpm test                         # the default unit run: bot (vitest project "unit") and the truth pack, no server
pnpm test:perf                    # the perf project: wall-clock bounds, on an idle machine only
BDS_E2E=1 pnpm --filter bot test:e2e   # end to end, against the local servers in Docker (runbook.md "Tests")
```

## The default unit run

`pnpm test` (the same as `pnpm -r test`) runs `vitest run --project unit` in `bot/` and the truth pack's unit tests.
It needs no server, no Docker, no config file and no network, and it must pass on a loaded machine: a red is a
fault, never the machine. To keep it so:

- **No wall-clock bound.** A test never asserts how many milliseconds something took. A timing check that is wanted
  goes into the perf project (below) with its bound, and the unit test keeps the work side of the same property:
  nodes expanded, ticks, steps, polls. Example: astar.test.ts holds 1000 random paths to their expansions (p99 under
  32 000, about the 50 ms budget at an idle rate of 0.1 ms per 64 expansions), and test/perf/astar.perf.test.ts holds
  the same paths to 50 ms.
- **No fixed sleep for async work.** Wait on the condition, with a generous limit: `await vi.waitFor(() =>
  expect(...), { timeout: 10_000 })`, not `await new Promise((r) => setTimeout(r, 50))`.
- **No clock read at load time.** A fixture time like `Date.now() - 60_000` is taken when the case runs (a function,
  not a constant), and a case that prints "60 s ago" holds the clock still (`vi.useFakeTimers({ toFake: ['Date'] })`).
- **Heavy cases get a long timeout.** The unit project's `testTimeout` is 120 s: under load a CPU-heavy deterministic
  case (a closed-loop bench walk, 300 paths) takes 3 to 4 times as long as alone. The timeout is a hang guard, not a
  speed check.

### Time in the unit run

The A* planner budgets its searches in milliseconds (a `findPath`'s 250 ms, the navigator's 40 ms main plan and 100 ms
segment, 8 ms slices a tick), and on a loaded machine those budgets ran out after fewer nodes: a closed-loop test then
planned twice, walked a partial path or took more ticks, and went red. In the unit run the planner's clock
(`searchClock` in bot/src/skills/nav/astar.ts) is a **work clock**: `test/unit/setup.ts` (the unit project's setup
file) makes it move 0.08 ms at each reading, and the search reads it once per 64 expansions, so a budget runs out
after the same work on any machine under any load. The bot itself reads `performance.now()`; nothing outside the unit
run changes the clock.

The reachability benches (test/unit/skills/reach-sim.ts: nav-r2 to nav-r8, nav-reach-stations) run the real planner
worker's loop, but in the test's own thread on a MessageChannel (test/unit/skills/thread-planner.ts, given to
`Navigator.attachPlanner` as `spawn`), so it reads the same work clock. While the navigator waits for it, each tick
lets it search `paceMs` of work (62.5 ms at the default speed), as a live tick lets the worker search 50 ms of wall
time on the owner's Mac. A real worker thread searched on the wall clock and at its own pace, so a loaded machine gave
those benches fewer nodes a tick and more ticks a search. The planner client's no-answer check reads the same clock.

The coarse layer's search (`coarseClock` in bot/src/skills/coarse/search.ts, a 500 ms budget by default) reads the same
work clock, at 0.05 ms a volume expanded: the unit tests' largest plans expand about 4 000 volumes, which an idle PC
does inside 500 ms. One step for every search is not every search's real cost: an A* expansion that digs costs about
10 times a walking one, so a dig-heavy search gets more nodes in its budget here than on a live machine. The unit run
is the same everywhere; how far a live budget reaches is for the e2e suites and the Realm.

What is still on the wall clock in the unit run: the flight route search (its tests pass a large `maxMs`), the coarse
graph builds' time stats (reported, never bounded), and the timers of async code (waited on by condition, or faked).

## The perf project

`pnpm test:perf` (`vitest run --project perf` in `bot/`, files in `bot/test/perf/`) holds the wall-clock bounds
the unit run left, each as it was: the planner's 1000 paths under 50 ms each (p99) and 200 cold-cache paths (p95),
the coarse corridor across 64 x 64 chunks under 500 ms cold and faster warm, the long-drop scan's cost and the note on a
refused fall, a navigator tick under 100 ms during a dig-heavy goto, the panel's render time, World.find's 100k-block
scan under 5 ms, the block registry's build under 2 s, the landing's look at 200 entities under 1 ms. It reads the real clock (no work clock, no setup
file) and runs its files one at a time. Run it on an idle machine: beside another test run or a game server its reds
measure the machine. It is not part of `pnpm test` and not part of CI.

## CI

`.github/workflows/ci.yml` runs on every push and pull request, on `ubuntu-latest`: Node from `.nvmrc`, pnpm at the
`packageManager` pin through corepack, the pnpm store cached on the lockfile's hash, then `pnpm install
--frozen-lockfile`, `pnpm lint`, `pnpm test`, `node scripts/docs-index.mjs --check` and `pnpm bot:check --
--no-config` (Node, pnpm, the dependencies and the patches; no config, no server, nothing contacted). No e2e (they
need game servers) and no perf project (a shared runner is not an idle machine). The workflow's shape is held by a
unit test (test/unit/ci-workflow.test.ts) that reads the file and checks those steps, their order and that every
script they name exists.

To run what CI runs on your machine, as CI has it (no config file):

```sh
pnpm install --frozen-lockfile && pnpm lint && pnpm test && node scripts/docs-index.mjs --check && pnpm bot:check -- --no-config
```

The unit run reads no config file of yours; to be sure, point `BEDROCKBOT_CONFIG` at an empty one
(`echo {} > /tmp/bb-ci.json; BEDROCKBOT_CONFIG=/tmp/bb-ci.json pnpm test`).
