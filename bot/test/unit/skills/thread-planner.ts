// Track REL3 (docs/testing.md "Time in the unit run"): the planner worker's own loop (nav/worker.ts runPlannerWorker)
// on a MessageChannel in the test's thread, for Navigator.attachPlanner's `spawn`. The real worker thread searched on
// the wall clock and at its own pace, so a closed-loop bench (reach-sim.ts) saw a search end after fewer nodes and cost
// more ticks on a loaded machine; here the search reads the unit run's work clock (test/unit/setup.ts) and runs only
// while the test lets it (reach-sim's pacing), so a bench run is the same every time. The messages are structured
// clones as between threads.
import { MessageChannel } from 'node:worker_threads';
import { runPlannerWorker, type PlannerWorker } from '../../../src/skills/nav/worker.ts';

export function threadPlanner(): PlannerWorker {
  const { port1, port2 } = new MessageChannel();
  runPlannerWorker(port2);
  let closed = false;
  return {
    postMessage: (m) => {
      if (!closed) port1.postMessage(m);
    },
    on: (event, fn) => (event === 'message' ? port1.on('message', fn) : undefined),
    terminate: () => {
      closed = true;
      port1.close();
      port2.close();
    },
    unref: () => {
      port1.unref();
      port2.unref();
    },
  };
}
