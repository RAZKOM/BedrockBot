# 0089: Worker threads without V8's wasm code GC (Track I1)

Date: 2026-11-15. Status: accepted; no setting (`BEDROCKBOT_WASM_CODE_GC=on` only to measure). Builds on
[0023](0023-planner-worker.md) (the planner worker). Details and numbers: [../pathfinding.md](../pathfinding.md)
"Worker threads and V8's wasm code GC (Track I1)", [../runbook.md](../runbook.md) "Tests on the Mac (Track I1)".

## Context

The unit suite on the test host (Apple silicon, Node 24.22.1, V8 13.6.233.17) lost a vitest worker about one run in
four with no failed test: the process aborted with SIGTRAP, `# Check failed: end > addr.`, while a navigator file
ran (`nav-r6`, `nav-r7`). Every deploy runs the suite before it restarts the bot, and 3 of 5 deploys failed their first
try on it. The host's crash reports put the abort on the thread named `planner` (the walk planner's Worker), in V8's
wasm code (`Runtime_TierUpWasmToJSWrapper` -> `WasmCodeRefScope::~WasmCodeRefScope` -> `WasmEngine::FreeDeadCode` ->
`WasmImportWrapperCache::Free` -> `ThreadIsolation::UnregisterWasmAllocation`).

What was found:

- **Whose wasm.** Node strips the types of each `.ts` file a thread loads with amaro, swc compiled to WebAssembly. A
  worker started on a `.js` file compiles no wasm; one on a 1-line `.ts` file compiles 348 wasm functions, the planner
  worker 759 (`--trace-wasm-compilation-times`, 2026-11-15). The bot's sources use no wasm of their own and no installed package ships a `.wasm`
  file. With a warm compile cache (`NODE_COMPILE_CACHE`) the stripped sources come from disk and a worker runs no
  wasm at all; the test host has none set, so every worker strips every file it loads.
- **What aborts.** Node 24's V8 keeps the wasm-to-JS import wrappers in one cache for the whole process. A worker that
  ends leaves its wrappers dead; the wasm code GC frees them while another thread, tiering a wrapper up, has taken a
  reference to the same dying wrapper and frees it again when its scope ends: V8's JIT page bookkeeping aborts. Known:
  nodejs/node#66366 and #66714 (the same stack, Node 24.18 to 24.22, macOS arm64, Linux, Windows); fixed in V8 by
  9b8ca54d5a ("[wasm] Fix lookup of wrappers marked is_dying"); Node 22 (V8 12.4: no shared cache) and Node 25+ do
  not abort; the Node 24 backport (nodejs/node#66376) is not released. The tests start and end a planner worker for
  every walk of the closed-loop simulator (`reach-sim.ts`), so a worker loads (wasm) right after the last one ended.
- **The live bot can hit it**, more rarely. It keeps its planner worker, but whenever a worker ends while another one
  loads its sources the race is the same: the cave proof of a `!fly route` with a shortcut runs in a worker that ends
  when the proof is done, and the route worker of the same command starts right after if it is not running yet; the
  planner is ended and started again when `plannerThreads` goes to 0 and back and 1 s after a crash; the route worker
  ends with the task. No `Check failed` line is in the live bot's console log so far.

## Decisions

1. **The wasm code GC is off where it races.** Every Worker the bot starts goes through `startWorker`
   (`bot/src/threads.ts`), which on V8 13.x (Node 24) first sets `--no-wasm-code-gc` once with `v8.setFlagsFromString`.
   V8 reads the flag each time code becomes dead, so setting it before the first worker can end is enough. It covers
   the live bot, the tests, the e2e harness and the benches with no change to the launch agent (installed by hand on
   the server) or the vitest config. A unit test (`threads.test.ts`) checks in a child process that the flag stops the
   code GC while planner workers strip their sources, and that no `new Worker(` is left outside `threads.ts` in `src`
   and `scripts`.
2. **Not the other ways.** A warm compile cache keeps wasm out of the workers, but misses on every changed file (the
   first start after an edit or a deploy strips again). A shared or pooled planner worker in the tests leaves the live
   bot as it was. A Node flag in the launch agent and in vitest's `execArgv` does the same as decision 1 in two places
   that drift (`NODE_OPTIONS` does not take V8 flags). Another Node is the owner's call: no Node 24 release has the fix.
3. **The deploy's test run stays as it is**: with the abort gone, a lost worker is a failure like any other.
4. **Removal**: when a Node 24 release carries the backport (its notes name #66376 or V8 9b8ca54d5a), or the bot moves
   to Node 25 or later, narrow `wasmCodeGcRaces` (it goes by V8's version) or drop the guard.

## Consequences

- Test host, 2026-11-15, the navigator files (nav-r2 to nav-r8, the three reach files, nav-worker: 11 files, 9 of them
  start planner workers; 4 vitest workers; load 6 to 10): with the guard off 3 of 16 runs lost a worker (all three in
  `nav-r7`); with it 0 of 40 (360 runs of the files that start workers). `nav-r7` alone at load 2 to 4: 0 of 9 either
  way, so load makes it likelier. The whole suite with the guard: 0 of 18 runs lost a worker; 16 exited 0, 2 failed by
  nav-worker's interim-and-splice test, a timing test that fails on the host with the guard off as well (3 of the 16
  navigator runs). The repro (`bot/scripts/worker-churn.ts`: processes that start and end 40 planner workers, 2 at a
  time): off 5 aborts in 1 769 processes (4 with the `Check failed` line, 1 SIGABRT at exit without one), on 0 in 476.
- Cost, same host: a planner worker's start and end 95.0 to 95.8 ms against 90.5 to 91.3 (one at a time, 40
  processes of 20 each way: +5 %, about 5 ms once per worker: the live bot starts its planner worker once, and that
  worker was ready 180 to 190 ms after its start on bds-move, pathfinding.md "Compute"); a process's memory after 20 workers 132.6 to 132.7 MB
  against 130.4 to 130.8 (dead wasm code stays allocated until its module goes with its last isolate). JavaScript is
  not touched: the reach bench at the live settings (161 pairs of 6 classes, 4 jobs) gave the same outcome and damage
  on 161 of 161 pairs, ticks -0.06 %, wall time -0.4 %.
- `BEDROCKBOT_WASM_CODE_GC=on` leaves V8's default, to measure the race (`scripts/mac/vitest-loop.sh`, the churn).
- The SIGABRT at exit (once, guard off, never with it) was not followed up.