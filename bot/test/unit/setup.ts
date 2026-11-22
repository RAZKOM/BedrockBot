// The unit project's setup (vitest.config.ts setupFiles; Track REL3, docs/testing.md "Time in the unit run"): the A*
// search's clock (nav/astar.ts searchClock) becomes a work clock. Its time budgets (`maxMs`: 250 for a findPath, the
// navigator's 40 ms main plan and 100 ms segment) and its per-tick slices (8 ms) were read off the wall clock, so on a
// loaded machine a search ran out of time after fewer nodes and a closed-loop test planned differently (a second plan,
// a partial path, a slower walk) and went red. The work clock moves WORK_MS at each reading; the search reads it once
// per 64 expansions (and at a slice's start and end), so a budget runs out after the same work on any machine under any
// load. WORK_MS is about this PC's idle rate (0.083 to 0.11 ms per 64 expansions, three rounds of astar.test.ts's 1000
// paths): tests see a fast idle machine. The coarse layer's search (coarse/search.ts coarseClock, a 500 ms budget by
// default, read once a volume expanded) gets the same clock at COARSE_WORK_MS a reading. A* expansions that dig cost
// more than walking ones (about 1 ms per 64 on this PC in nav-r3's dig search), so a dig-heavy search gets more nodes
// in its budget here than on a live machine: the unit run is the same everywhere, not a copy of a live budget.
// The wall-clock bounds themselves are in the perf project (test/perf).
import { coarseClock } from '../../src/skills/coarse/search.ts';
import { searchClock } from '../../src/skills/nav/astar.ts';

/** Work-clock ms per reading (about 64 expansions). */
export const WORK_MS = 0.08;

/**
 * Work-clock ms per coarse volume expanded. The unit tests' plans expand up to about 4 000 volumes (fly-corridor.test.ts,
 * coarse.test.ts's mixed fly and walk request), which an idle PC does inside the 500 ms default: at most 0.125 ms each.
 * 0.05 gives them 10 000. A cold volume that builds chunk graphs costs more (coarse-perf: about 1.5 ms on this PC).
 */
export const COARSE_WORK_MS = 0.05;

let t = 0;
searchClock.now = () => (t += WORK_MS);
coarseClock.now = () => (t += COARSE_WORK_MS);

/** The work clock's time without moving it (reach-sim.ts paces its ticks by it). */
export const workNow = (): number => t;
