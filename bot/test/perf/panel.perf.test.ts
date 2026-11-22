// The opt-in perf project (`pnpm test:perf`, Track REL3, docs/testing.md "The perf project"): panel-page.test.ts's
// former render-time bound (the fake DOM, a full inventory, every cell changing: the median of 50 polls under 20 ms),
// as it was. The unit case keeps the 50 polls and what they render.
import { describe, expect, it } from 'vitest';
import { renderPanelPage } from '../../src/health/panel/page.ts';
import { liteState, type PanelState } from '../../src/health/panel/state.ts';
import { answer, runPage } from '../unit/health/panel-dom.ts';
import { fullState } from '../unit/health/panel-fixtures.ts';

describe('panel page render time, wall clock', () => {
  it('render time with a full inventory (fake DOM; the browser logs its own in the console)', async () => {
    const s = liteState(fullState()) as unknown as PanelState;
    const h = runPage(renderPanelPage(fullState()));
    const empty = liteState(fullState({ inventory: () => ({ slots: [], selected: 0, window: () => undefined, rawItem: () => undefined }) }));
    const times: number[] = [];
    for (let i = 0; i < 50; i++) h.fetchQueue.push(answer(i % 2 ? s : empty)); // every poll changes all 36 cells
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      await h.timers.at(-1)!.fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(`panel render (fake DOM, every cell changing): median ${times[25]!.toFixed(2)} ms, max ${times[49]!.toFixed(2)} ms over 50 polls`);
    expect(times[25]).toBeLessThan(20);
  });
});
