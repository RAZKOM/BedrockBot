// Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101): the walk back to a death spot and the pick-up of the
// drops as a user process (pre-empted and resumed like any command), and the generic WorkProcess the table sweep runs in.
import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { RecoverProcess, WorkProcess, type RecoverDeps } from '../../../src/tasks/process/recover.ts';

const tick = () => new Promise((r) => setTimeout(r, 1));

function deps(o: { walkOk?: boolean } = {}) {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const d: RecoverDeps = {
    goto: (g) => {
      calls.push(`goto ${g.type}`);
      return new Promise((r) => {
        release = () => r(o.walkOk === false ? { ok: false, reason: 'no_path' } : { ok: true });
      });
    },
    collect: (radius, ticks, opts) => {
      calls.push(`collect ${radius} ${ticks} ${opts?.origin ? `${opts.origin.x} ${opts.origin.z}` : '-'}`);
      return Promise.resolve({ ok: true, gained: { iron_ingot: 30, cobblestone: 16 }, pickedUp: 2, skipped: 0, ticks: 40, corrections: 0 });
    },
    cancel: () => calls.push('cancel'),
  };
  return { d, calls, walk: () => release?.() };
}

describe('RecoverProcess', () => {
  it('walks to the spot, collects round it, ends with what it picked up', async () => {
    const m = new ProcessManager();
    const { d, calls, walk } = deps();
    const p = m.add(new RecoverProcess(d, { spot: { x: 30, y: 64, z: 40 }, walkTicks: 1000, collectTicks: 400, radius: 8 }));
    expect(p.status().line).toBe('walking back to 30 64 40 for the drops');
    await tick();
    walk();
    const r = await p.result;
    expect(r).toEqual({ arrived: true, reason: 'done', gained: { iron_ingot: 30, cobblestone: 16 } });
    expect(calls).toEqual(['goto near', 'collect 8 400 30 40']);
    expect(p.done).toBe(true);
  });

  it('a failed walk ends it with the nav reason; a stop resolves it interrupted', async () => {
    const m = new ProcessManager();
    const f = deps({ walkOk: false });
    const p = m.add(new RecoverProcess(f.d, { spot: { x: 1, y: 2, z: 3 }, walkTicks: 600, collectTicks: 100, radius: 8 }));
    await tick();
    f.walk();
    expect(await p.result).toMatchObject({ arrived: false, reason: 'walk_failed (no_path)' });
    const s = deps();
    const q = m.add(new RecoverProcess(s.d, { spot: { x: 1, y: 2, z: 3 }, walkTicks: 600, collectTicks: 100, radius: 8 }));
    m.stop(q, 'death');
    expect(await q.result).toMatchObject({ arrived: false, reason: 'interrupted' });
    expect(s.calls).toContain('cancel');
  });
});

describe('WorkProcess', () => {
  it('runs its work once, resolves with the result; a pause cancels and the resume runs it again', async () => {
    const m = new ProcessManager();
    let runs = 0;
    const cancels: string[] = [];
    const p = m.add(
      new WorkProcess(
        'tables',
        'picking up the crafting table',
        async (cancelled) => {
          runs++;
          await tick();
          return cancelled() ? -1 : runs;
        },
        () => cancels.push('cancel'),
      ),
    );
    expect(p.status().line).toBe('picking up the crafting table');
    p.pause();
    expect(cancels).toEqual(['cancel']);
    p.resume();
    expect(await p.result).toBe(2);
    expect(p.done).toBe(true);
  });
});
