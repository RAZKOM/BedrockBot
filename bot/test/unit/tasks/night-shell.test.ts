// Track E1 (docs/early-game.md "The first night", ADR 0098): the night shell's rules on a fake world: only under the
// open sky, only with blocks for every open cell, at most two tries a night, opened at dawn on a side it placed itself,
// and NightSafety opening it before the walk home.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import type { SealDeps } from '../../../src/skills/survival/seal.ts';
import { NIGHT_SHELL_DAWN_WAIT, NIGHT_SHELL_TRIES, NightShell, shellExit, shellStepOut, underOpenSky } from '../../../src/tasks/night-shell.ts';
import { NightSafety } from '../../../src/tasks/night.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Flat ground at y 63 (feet at 64), solid cells in a set, a cobblestone stack. */
function fake(o: { blocks?: number; roofAt?: number; threats?: Vec3[] } = {}) {
  const solid = new Set<string>();
  if (o.roofAt !== undefined) solid.add(key(10, o.roofAt, 10));
  const slots: (ItemStack | null)[] = [{ name: 'cobblestone', count: o.blocks ?? 16, networkId: 1, metadata: 0 }];
  const placed: string[] = [];
  const dug: string[] = [];
  const pos = { x: 10.5, y: 64, z: 10.5 };
  const threats: Vec3[] = o.threats ?? [{ x: 20, y: 64, z: 10.5 }];
  const waits = { ticks: 0 };
  const deps: SealDeps = {
    place: (p) => {
      solid.add(key(p.x, p.y, p.z));
      placed.push(key(p.x, p.y, p.z));
      slots[0]!.count--;
      return Promise.resolve({ ok: true });
    },
    dig: (p) => {
      solid.delete(key(p.x, p.y, p.z));
      dug.push(key(p.x, p.y, p.z));
      return Promise.resolve({ ok: true });
    },
    solid: (x, y, z) => y <= 63 || solid.has(key(x, y, z)),
    position: () => pos,
    threats: () => threats,
    slots: () => slots,
    block: () => 'dirt',
    settle: (n) => {
      waits.ticks += n;
      return Promise.resolve();
    },
  };
  return { deps, solid, placed, dug, slots, pos, threats, waits };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('night shell rules (Track E1)', () => {
  it('under the open sky: nothing solid over the head', () => {
    const f = fake();
    expect(underOpenSky(f.pos, f.deps.solid)).toBe(true);
    const roofed = fake({ roofAt: 70 });
    expect(underOpenSky(roofed.pos, roofed.deps.solid)).toBe(false);
    expect(underOpenSky(f.pos, () => undefined)).toBe(false); // unknown counts as a roof: never walled blind
    // a tree's canopy is no roof (a kit ended under oak leaves 2 over the head); planks are
    const canopy = (x: number, y: number, z: number) => (y >= 66 && y <= 70 && x === 10 && z === 10) || y <= 63;
    expect(underOpenSky(f.pos, canopy, (_x, y) => (y >= 66 && y <= 69 ? 'oak_leaves' : y === 70 ? 'oak_log' : 'air'))).toBe(true);
    expect(underOpenSky(f.pos, canopy, (_x, y) => (y === 66 ? 'oak_planks' : 'oak_leaves'))).toBe(false);
  });

  it('walls in with 10 blocks on open ground (never the dig-in), opens the side away from the mob at dawn, placed cells only', async () => {
    const f = fake();
    const s = new NightShell({ deps: () => f.deps, enabled: () => true, log: silentLogger });
    s.onInside(() => true);
    await flush();
    await flush();
    expect(f.placed).toHaveLength(10); // 8 round the body, a support for the roof, the roof
    expect(s.closed).toBe(true);
    await s.open();
    // the mob is east (+x): the west side opens
    expect(f.dug).toEqual([key(9, 64, 10), key(9, 65, 10)]);
    expect(s.closed).toBe(false);
    expect(s.built.size).toBe(8);
  });

  it('the next night: only the opened side is placed again, the old roof is not a roof', async () => {
    const f = fake();
    const s = new NightShell({ deps: () => f.deps, enabled: () => true, log: silentLogger });
    s.onInside(() => true);
    await flush();
    await flush();
    await s.open();
    s.newNight();
    f.placed.length = 0;
    s.onInside(() => true);
    await flush();
    await flush();
    expect(f.placed.sort()).toEqual([key(9, 64, 10), key(9, 65, 10)].sort());
  });

  it('off, short of blocks, or under a roof: nothing is placed; short of blocks is said once a night', async () => {
    const off = fake();
    new NightShell({ deps: () => off.deps, enabled: () => false, log: silentLogger }).onInside(() => true);
    const short = fake({ blocks: 5 });
    const lines: string[] = [];
    const s = new NightShell({ deps: () => short.deps, enabled: () => true, log: { ...silentLogger, info: (m: string) => lines.push(m) } });
    for (let i = 0; i < 5; i++) s.onInside(() => true);
    const roof = fake({ roofAt: 80 });
    new NightShell({ deps: () => roof.deps, enabled: () => true, log: silentLogger }).onInside(() => true);
    await flush();
    expect(off.placed).toEqual([]);
    expect(short.placed).toEqual([]);
    expect(roof.placed).toEqual([]);
    expect(lines.filter((l) => l.includes('throwaway blocks'))).toHaveLength(1);
  });

  it('at dawn with a hostile within 16 it stays shut until none is, at most NIGHT_SHELL_DAWN_WAIT ticks', async () => {
    const f = fake({ threats: [] });
    const s = new NightShell({ deps: () => f.deps, enabled: () => true, log: silentLogger });
    s.onInside(() => true);
    await flush();
    await flush();
    // a skeleton near at dawn, gone after 3 s
    f.threats.push({ x: 20, y: 64, z: 10.5 });
    const settle = f.deps.settle!;
    f.deps.settle = (n) => {
      if (f.waits.ticks >= 40) f.threats.length = 0;
      return settle(n);
    };
    await s.open();
    expect(f.waits.ticks).toBe(60);
    expect(f.dug).toHaveLength(2);
    expect(s.stats.dawnWaits).toBe(1);
    // a mob that never leaves: opened after the cap
    const g = fake();
    const t = new NightShell({ deps: () => g.deps, enabled: () => true, log: silentLogger });
    t.onInside(() => true);
    await flush();
    await flush();
    await t.open();
    expect(g.waits.ticks).toBe(NIGHT_SHELL_DAWN_WAIT);
    expect(g.dug).toHaveLength(2);
    // nobody near: no wait
    const h = fake({ threats: [] });
    const u = new NightShell({ deps: () => h.deps, enabled: () => true, log: silentLogger });
    u.onInside(() => true);
    await flush();
    await flush();
    await u.open();
    expect(h.waits.ticks).toBe(0);
    expect(h.dug).toHaveLength(2);
  });

  it('leaf litter in the cells is dug first, then the shell closes (measured: 2 placed, 5 open on litter)', async () => {
    const f = fake({ threats: [] });
    const litter = new Set([key(11, 64, 10), key(10, 64, 11), key(10, 64, 9)]);
    // the fake placer refuses a cell that holds litter, as the server's placer did
    const place = f.deps.place;
    f.deps.place = (p, o) => (litter.has(key(p.x, p.y, p.z)) ? Promise.resolve({ ok: false, reason: 'occupied' }) : place(p, o));
    const dig = f.deps.dig;
    f.deps.dig = (p) => {
      litter.delete(key(p.x, p.y, p.z));
      return dig(p);
    };
    const info = (name: string): BlockInfo => ({ name, stateId: 1, states: {}, hardness: 0, solid: false, boxes: [] });
    const s = new NightShell({
      deps: () => f.deps,
      blockAt: (p) => (litter.has(key(p.x, p.y, p.z)) ? info('leaf_litter') : f.solid.has(key(p.x, p.y, p.z)) ? { ...info('cobblestone'), solid: true, boxes: [[0, 0, 0, 1, 1, 1]] } : info('air')),
      enabled: () => true,
      log: silentLogger,
    });
    s.onInside(() => true);
    for (let i = 0; i < 6; i++) await flush();
    expect(f.dug.sort()).toEqual([...[key(11, 64, 10), key(10, 64, 11), key(10, 64, 9)]].sort());
    expect(f.placed).toHaveLength(10);
    expect(s.stats.closed).toBe(1);
  });

  it('a wall that was there is never dug: no exit when every side has a cell it did not place', () => {
    const solid = (x: number, y: number) => y <= 65; // every ring cell solid, none placed
    expect(shellExit({ x: 10.5, y: 64, z: 10.5 }, new Set(), solid, [])).toBeUndefined();
    expect(shellExit({ x: 10.5, y: 64, z: 10.5 }, new Set([key(11, 64, 10), key(11, 65, 10)]), solid, [])).toEqual([
      { x: 11, y: 64, z: 10 },
      { x: 11, y: 65, z: 10 },
    ]);
  });

  it(`at most ${NIGHT_SHELL_TRIES} tries a night (a cell a mob stands in stays open)`, async () => {
    const f = fake();
    let calls = 0;
    const deps: SealDeps = { ...f.deps, place: () => (calls++, Promise.resolve({ ok: false, reason: 'occupied' })) };
    const s = new NightShell({ deps: () => deps, enabled: () => true, log: silentLogger });
    for (let i = 0; i < 4; i++) {
      s.onInside(() => true);
      await flush();
      await flush();
    }
    expect(calls).toBe(NIGHT_SHELL_TRIES * 2 * 10 * 3); // 2 tries x 2 passes x 10 cells x 3 clicks
  });
});

describe('NightSafety with a shell (Track E1)', () => {
  it('walls in once inside after dusk, and opens before the walk home at dawn', async () => {
    let time = 13_000;
    const order: string[] = [];
    const shell = {
      closed: false,
      newNight: () => order.push('newNight'),
      forget: () => order.push('forget'),
      onInside: () => {
        order.push('inside');
        shell.closed = true;
      },
      open: () => {
        order.push('open');
        shell.closed = false;
        return Promise.resolve();
      },
    };
    const pos: Vec3 = { x: 0.5, y: 64, z: 0.5 };
    const n = new NightSafety({
      clock: {
        known: true,
        get time() {
          return time;
        },
      },
      mover: { goto: () => Promise.resolve({ ok: true }), cancel: () => undefined } as never,
      position: () => pos,
      shelter: { x: 0, y: 64, z: 0 },
      home: () => ({ x: 5, y: 64, z: 5 }),
      walkHome: () => {
        order.push('walkHome');
        return Promise.resolve({ ok: true });
      },
    });
    n.shell = shell;
    time = 11_000;
    n.check();
    time = 13_000;
    n.check();
    expect(order).toEqual(['newNight', 'inside']);
    time = 23_100;
    n.check();
    await flush();
    await flush();
    expect(order).toEqual(['newNight', 'inside', 'open', 'walkHome']);
  });

  it('Track E3: control is kept after dawn while the shell is still shut (a resumed process would plan inside it)', async () => {
    let time = 13_000;
    let release: () => void = () => undefined;
    const shell = {
      closed: false,
      newNight: () => undefined,
      forget: () => undefined,
      onInside: () => {
        shell.closed = true;
      },
      open: () =>
        new Promise<void>((r) => {
          release = () => {
            shell.closed = false;
            r();
          };
        }),
    };
    const pos: Vec3 = { x: 0.5, y: 64, z: 0.5 };
    const n = new NightSafety({
      clock: {
        known: true,
        get time() {
          return time;
        },
      },
      mover: { goto: () => Promise.resolve({ ok: true }), cancel: () => undefined } as never,
      position: () => pos,
      shelter: { x: 0, y: 64, z: 0 },
    });
    n.shell = shell;
    time = 11_000;
    n.check();
    time = 13_000;
    n.check();
    expect(n.wantsControl()).toBe(true);
    time = 23_100;
    n.check(); // dawn: the open starts (a hostile near holds it)
    expect(n.wantsControl()).toBe(true);
    release();
    await flush();
    expect(n.wantsControl()).toBe(false);
  });
});

describe('NightSafety.retryNow (Track E7)', () => {
  it('a walk cut short by another rule does not count: the next check retreats again at once, with a fresh budget', async () => {
    let time = 11_000;
    let now = 0;
    const walks: ((r: { ok: boolean; reason?: string }) => void)[] = [];
    const pos: Vec3 = { x: 20.5, y: 64, z: 0.5 };
    const n = new NightSafety({
      clock: {
        known: true,
        get time() {
          return time;
        },
      },
      mover: { goto: () => new Promise((r) => walks.push(r)), cancel: () => undefined } as never,
      position: () => pos,
      shelter: { x: 0, y: 64, z: 0 },
      now: () => now,
    });
    n.check();
    time = 12_100;
    n.check();
    expect(walks).toHaveLength(1);
    walks[0]!({ ok: false, reason: 'interrupted' });
    await flush();
    expect(n.state).toBe('unreachable');
    expect(n.attempts).toBe(1);
    now += 1000;
    n.check();
    expect(walks).toHaveLength(1); // the retry waits its 60 s
    n.retryNow();
    expect(n.attempts).toBe(0);
    n.check();
    expect(walks).toHaveLength(2); // at once
    expect(n.state).toBe('going');
  });

  it('after giving up for the night it retreats again too', async () => {
    let time = 11_000;
    let now = 0;
    const walks: ((r: { ok: boolean; reason?: string }) => void)[] = [];
    const n = new NightSafety({
      clock: {
        known: true,
        get time() {
          return time;
        },
      },
      mover: { goto: () => new Promise((r) => walks.push(r)), cancel: () => undefined } as never,
      position: () => ({ x: 20.5, y: 64, z: 0.5 }),
      shelter: { x: 0, y: 64, z: 0 },
      now: () => now,
    });
    n.check();
    time = 12_100;
    for (let i = 0; i < 3; i++) {
      n.check();
      walks[i]!({ ok: false, reason: 'unreachable' });
      await flush();
      now += 61_000;
    }
    expect(n.state).toBe('gave_up');
    n.check();
    expect(walks).toHaveLength(3);
    n.retryNow();
    n.check();
    expect(walks).toHaveLength(4);
  });
});

describe('shellStepOut (Track E7): the way out of a shell built over a hole', () => {
  const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  // the body stands in a one-deep hole at 0 63 0: natural walls at y 63 on every side; the shell placed the head ring
  // (y 64), the roof (0 65 0) and its support (1 65 0)
  const placed = new Set([k(1, 64, 0), k(-1, 64, 0), k(0, 64, 1), k(0, 64, -1), k(0, 65, 0), k(1, 65, 0)]);
  const solid = (x: number, y: number, z: number): boolean => y <= 62 || (y === 63 && !(x === 0 && z === 0)) || placed.has(k(x, y, z));
  const me = { x: 0.5, y: 63, z: 0.5 };

  it('no side opens at the feet (shellExit): the step up digs the head cell of a side and the roof, blocks of the shell only', () => {
    expect(shellExit(me, placed, solid, [])).toBeUndefined();
    const cells = shellStepOut(me, placed, solid, [{ x: 10.5, y: 64, z: 0.5 }])!; // a threat east: out to the west
    expect(cells).toEqual([
      { x: -1, y: 64, z: 0 },
      { x: 0, y: 65, z: 0 },
    ]);
    for (const c of cells) expect(placed.has(k(c.x, c.y, c.z))).toBe(true);
    // east, the roof's support stands over the side's head cell: it goes too
    expect(shellStepOut(me, placed, solid, [{ x: -10.5, y: 64, z: 0.5 }])).toEqual([
      { x: 1, y: 64, z: 0 },
      { x: 0, y: 65, z: 0 },
      { x: 1, y: 65, z: 0 },
    ]);
  });

  it('a block that was there in the way (a natural roof, a wall at head height) rules that side out; none left: undefined', () => {
    const roofed = (x: number, y: number, z: number): boolean => solid(x, y, z) || (x === 0 && y === 65 && z === 0);
    expect(shellStepOut(me, new Set([...placed].filter((c) => c !== k(0, 65, 0))), roofed, [])).toBeUndefined(); // the roof is not the shell's
    const wall = (x: number, y: number, z: number): boolean => solid(x, y, z) || (x === -1 && y === 64 && z === 0);
    const without = new Set([...placed].filter((c) => c !== k(-1, 64, 0)));
    const cells = shellStepOut(me, without, wall, [{ x: 10.5, y: 64, z: 0.5 }])!;
    expect(cells.some((c) => c.x === -1)).toBe(false); // not through the wall that was there
  });

  it('on level ground there is no wall to step onto: undefined (shellExit has the side)', () => {
    const flat = (_x: number, y: number): boolean => y <= 62;
    expect(shellStepOut(me, new Set(), flat, [])).toBeUndefined();
  });
});
