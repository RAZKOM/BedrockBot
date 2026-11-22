// The opt-in perf project (`pnpm test:perf`, Track REL3, docs/testing.md "The perf project"): nav-digmoves.test.ts's
// former tick-time bound (Track BC: a dig-heavy goto with sliced searches at the worker-sized budget keeps every
// navigator tick under 100 ms), on the wall clock as it was. The unit case keeps the dig way and the arrival.
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../src/skills/index.ts';
import type { NavActions } from '../../src/skills/nav/index.ts';
import type { SkillResult } from '../../src/skills/types.ts';
import { fakeWorld, harness } from '../unit/skills/fakes.ts';
import { flatGen } from '../unit/skills/genworld.ts';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('navigator tick time (Track BC budgets), wall clock', () => {
  it('a dig-heavy goto (a goal inside a dirt block, sliced searches with the worker-sized budget) keeps every navigator tick under 100 ms', async () => {
    const gen = flatGen({ x: -24, y: -64, z: -24 }, { x: 48, y: 24, z: 48 });
    gen.fill({ x: -6, y: -60, z: 4 }, { x: 6, y: -56, z: 16 }, 'dirt');
    const { conn, loop } = harness({ x: 0.5, y: -60, z: 0.5 });
    let digs = 0;
    const actions: NavActions = {
      dig: async (p) => {
        digs++;
        await loop.waitTicks(8);
        gen.set(p.x, p.y, p.z, 'air');
        return { ok: true };
      },
      throwawayItems: ['cobblestone'],
    };
    const skills = new BotSkills({ loop, world: fakeWorld(gen), inventory: () => ({ slots: [{ name: 'cobblestone', count: 64 }], selected: 0 }), mainMs: 2000, segmentMs: 2000, segmentNodes: 500_000, actions });
    conn.tick(3);
    let result: SkillResult | undefined;
    const p = skills.goto({ type: 'block', p: { x: 0, y: -60, z: 12 } }, { allowBreak: true }).then((r) => (result = r));
    for (let t = 0; t < 4000 && skills.nav.busy; t++) {
      conn.tick();
      await flush();
    }
    skills.cancel();
    await p;
    expect(result).toEqual({ ok: true });
    const rep = skills.status().lastGoto!;
    console.log(`[nav tick perf] max navigator tick ${rep.maxTickMs} ms, ${digs} digs`);
    expect(digs).toBeGreaterThanOrEqual(10);
    expect(rep.maxTickMs).toBeLessThan(100);
  });
});
