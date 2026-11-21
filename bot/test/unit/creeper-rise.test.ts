// Track E12 (`creeperRise`): a creeper whose fuse burns under the bot is let blow below it (tasks/creeper-rise.ts).
import { describe, expect, it } from 'vitest';
import { RISE_BLOCKS, RISE_HOLD_MS, RISE_RETRY_MS, riseFrom, RiseProcess, type RiseHost, type RiseView } from '../../src/tasks/creeper-rise.ts';
import { BaseProcess, PRIORITY, ProcessManager, type ProcessStatus } from '../../src/tasks/process/manager.ts';
import type { Vec3 } from '../../src/world/types.ts';

const me = { x: 10.5, y: 72, z: 20.5 };
const view = (o: Partial<RiseView> = {}): RiseView => ({ me, creepers: [{ id: 7n, feet: { x: 11.5, y: 64, z: 21.5 }, lit: true }], blocks: 16, room: true, ...o });

describe('riseFrom', () => {
  it('rises from a lit creeper under the feet', () => {
    expect(riseFrom(view({ creepers: [{ id: 7n, feet: { x: 11.5, y: 69, z: 21.5 }, lit: true }] }))).toBe(7n);
  });
  it('not from one whose fuse does not burn', () => {
    expect(riseFrom(view({ creepers: [{ id: 7n, feet: { x: 11.5, y: 69, z: 21.5 }, lit: false }] }))).toBeUndefined();
  });
  it('not from one on the same level or one block under (rising beside it stays in its blast)', () => {
    expect(riseFrom(view({ creepers: [{ id: 7n, feet: { x: 12.5, y: 72, z: 20.5 }, lit: true }] }))).toBeUndefined();
    expect(riseFrom(view({ creepers: [{ id: 7n, feet: { x: 12.5, y: 71, z: 20.5 }, lit: true }] }))).toBeUndefined();
  });
  it('not from one farther than 3 level', () => {
    expect(riseFrom(view({ creepers: [{ id: 7n, feet: { x: 14.5, y: 69, z: 20.5 }, lit: true }] }))).toBeUndefined();
  });
  it('not without the blocks or the head room', () => {
    const c = [{ id: 7n, feet: { x: 11.5, y: 69, z: 21.5 }, lit: true }];
    expect(riseFrom(view({ creepers: c, blocks: RISE_BLOCKS - 1 }))).toBeUndefined();
    expect(riseFrom(view({ creepers: c, room: false }))).toBeUndefined();
  });
  it('the nearest of two', () => {
    expect(
      riseFrom(
        view({
          creepers: [
            { id: 1n, feet: { x: 12.5, y: 68, z: 20.5 }, lit: true },
            { id: 2n, feet: { x: 10.5, y: 69, z: 21.5 }, lit: true },
          ],
        }),
      ),
    ).toBe(2n);
  });
});

/** A user process standing for the job (the mine). */
class Job extends BaseProcess {
  readonly name = 'mine';
  readonly kind = 'user' as const;
  runs = 0;
  halts = 0;
  get priority(): number {
    return PRIORITY.user;
  }
  protected run(): void {
    this.runs++;
  }
  protected halt(): void {
    this.halts++;
  }
  status(): ProcessStatus {
    return { line: 'mine' };
  }
}

function setup(o: { on?: boolean; v?: RiseView | undefined; ok?: boolean } = {}) {
  let now = 1000;
  let v: RiseView | undefined = o.v ?? view({ creepers: [{ id: 7n, feet: { x: 11.5, y: 69, z: 21.5 }, lit: true }] });
  let alive = true;
  const walks: Vec3[] = [];
  let resolve: ((r: { ok: boolean; reason?: string }) => void) | undefined;
  let cancels = 0;
  const lines: string[] = [];
  const host: RiseHost = {
    on: () => o.on ?? true,
    view: () => v,
    goto: (p) => {
      walks.push(p);
      return new Promise((r) => {
        resolve = r;
      });
    },
    cancel: () => {
      cancels++;
    },
    alive: () => alive,
    now: () => now,
    log: { info: (s: string) => lines.push(s), warn: (s: string) => lines.push(s), error: (s: string) => lines.push(s), debug: () => {} },
  };
  const m = new ProcessManager();
  const job = m.add(new Job());
  const rise = m.add(new RiseProcess(host));
  return {
    m,
    job,
    rise,
    walks,
    lines,
    get cancels() {
      return cancels;
    },
    finishWalk: (ok = o.ok ?? true) => resolve?.({ ok, ...(ok ? {} : { reason: 'no path' }) }),
    setView: (x: RiseView | undefined) => {
      v = x;
    },
    kill: () => {
      alive = false;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('RiseProcess', () => {
  it('pre-empts the job, walks up 2 from the feet cell, holds until the creeper is gone, then gives the job back', async () => {
    const s = setup();
    s.m.tick();
    expect(s.m.active?.name).toBe('rise');
    expect(s.walks).toEqual([{ x: 10, y: 72 + RISE_BLOCKS, z: 20 }]);
    s.finishWalk();
    await flush();
    s.m.tick();
    expect(s.m.active?.name).toBe('rise'); // holding
    s.kill();
    s.m.tick();
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
    expect(s.rise.rises).toBe(1);
    expect(s.lines.some((l) => l.includes('the creeper is gone'))).toBe(true);
  });

  it('a walk up that fails stands where it is for the blast (not back down)', async () => {
    const s = setup({ ok: false });
    s.m.tick();
    s.finishWalk(false);
    await flush();
    s.m.tick();
    expect(s.m.active?.name).toBe('rise');
    expect(s.lines.some((l) => l.includes('not up (no path): standing'))).toBe(true);
  });

  it('gives up the hold after RISE_HOLD_MS with no blast (a fuse that went out: the job again)', async () => {
    const s = setup();
    s.m.tick();
    s.finishWalk();
    await flush();
    s.setView(view({ creepers: [{ id: 7n, feet: { x: 11.5, y: 69, z: 21.5 }, lit: false }] }));
    s.advance(RISE_HOLD_MS - 1);
    s.m.tick();
    expect(s.m.active?.name).toBe('rise');
    s.advance(2);
    s.m.tick();
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
    expect(s.lines.some((l) => l.includes('no blast in 3 s'))).toBe(true);
  });

  it('waits RISE_RETRY_MS before another rise', async () => {
    const s = setup();
    s.m.tick();
    s.finishWalk();
    await flush();
    s.kill();
    s.m.tick();
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
    s.advance(RISE_RETRY_MS - 1);
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
    s.advance(2);
    s.m.tick();
    expect(s.m.active?.name).toBe('rise');
    expect(s.rise.rises).toBe(2);
  });

  it('off: nothing', () => {
    const s = setup({ on: false });
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
    expect(s.walks).toEqual([]);
  });

  it('no lit creeper under the feet: nothing', () => {
    const s = setup({ v: view({ creepers: [{ id: 7n, feet: { x: 11.5, y: 69, z: 21.5 }, lit: false }] }) });
    s.m.tick();
    expect(s.m.active?.name).toBe('mine');
  });
});
