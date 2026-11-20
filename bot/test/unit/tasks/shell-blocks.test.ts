// Track E7 (docs/early-game.md "The shell's blocks", ADR 0104): the night shell's 10 blocks dug out of the ground near the
// bot: dirt kinds by hand, natural stone with a pickaxe that harvests it, never under or next to the feet, never the base or
// a built block, never next to a liquid, only a cell with an open top; nearest first.
import { describe, expect, it } from 'vitest';
import { refillBlocks, refillCell, refillCells, REFILL_TRIES, SHELL_BLOCKS, shellBlocksCarried, shellShort, type RefillDeps, type RefillWorld } from '../../../src/skills/survival/shell-blocks.ts';
import { BlocksChore, BLOCKS_BACKOFF_MS, BLOCKS_CHECK_MS, REFILL_KEEP, refillDeps, type BlocksChoreDeps } from '../../../src/tasks/shell-refill.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const F = 64;
const block = (name: string, count: number): ItemStack => ({ name, networkId: 1, count, metadata: 0, blockRuntimeId: 7 });
const k = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

/** Flat ground: grass at F - 1, dirt under it, air over it; overrides by cell. */
function world(over: Record<string, string> = {}) {
  const at = (p: Vec3): BlockInfo => ({ name: over[k(p)] ?? (p.y >= F ? 'air' : p.y === F - 1 ? 'grass_block' : 'dirt') }) as BlockInfo;
  return at;
}

const w = (blockAt: (p: Vec3) => BlockInfo | undefined, o: Partial<RefillWorld> = {}): RefillWorld => ({ blockAt, allowed: () => true, harvests: () => false, ...o });
const feet = { x: 0.5, y: F, z: 0.5 };

describe('the count', () => {
  it('the shell takes 10 on open ground; what is carried counts (dirt, cobblestone)', () => {
    expect(SHELL_BLOCKS).toBe(10);
    expect(shellBlocksCarried([block('dirt', 4), block('cobblestone', 3), null])).toBe(7);
    expect(shellShort([block('dirt', 4), block('cobblestone', 3)])).toBe(3);
    expect(shellShort([block('cobblestone', 16)])).toBe(0);
    expect(shellShort([])).toBe(10);
  });
});

describe('refillCell / refillCells', () => {
  it('the grass round the bot, never within 1 of the feet (the shell and its floor)', () => {
    const at = world();
    expect(refillCell(w(at), { x: 0, y: F - 1, z: 0 }, feet)).toBe(false);
    expect(refillCell(w(at), { x: 1, y: F - 1, z: 1 }, feet)).toBe(false);
    expect(refillCell(w(at), { x: 2, y: F - 1, z: 0 }, feet)).toBe(true);
    const cells = refillCells(w(at), feet, 4);
    expect(cells).toHaveLength(4);
    for (const c of cells) {
      expect(Math.max(Math.abs(c.x), Math.abs(c.z))).toBe(2);
      expect(c.y).toBe(F - 1);
    }
  });

  it('a covered top (no hole under a block), a liquid next to it, the base, unknown neighbours: no', () => {
    const p = { x: 3, y: F - 1, z: 0 };
    expect(refillCell(w(world({ [k({ x: 3, y: F, z: 0 })]: 'oak_log' })), p, feet)).toBe(false);
    expect(refillCell(w(world({ [k({ x: 3, y: F, z: 0 })]: 'short_grass' })), p, feet)).toBe(true); // a tuft is open
    expect(refillCell(w(world({ [k({ x: 4, y: F - 1, z: 0 })]: 'water' })), p, feet)).toBe(false);
    expect(refillCell(w(world({ [k({ x: 3, y: F - 2, z: 0 })]: 'lava' })), p, feet)).toBe(false);
    expect(refillCell(w(world(), { allowed: () => false }), p, feet)).toBe(false);
    expect(refillCell(w((q) => (q.x === 4 ? undefined : world()(q))), p, feet)).toBe(false);
  });

  it('stone only with a pickaxe that harvests it; cobblestone (a built block) never', () => {
    const stone = world({ [k({ x: 3, y: F - 1, z: 0 })]: 'stone', [k({ x: 0, y: F - 1, z: 3 })]: 'cobblestone' });
    expect(refillCell(w(stone), { x: 3, y: F - 1, z: 0 }, feet)).toBe(false);
    expect(refillCell(w(stone, { harvests: (n) => n === 'stone' }), { x: 3, y: F - 1, z: 0 }, feet)).toBe(true);
    expect(refillCell(w(stone, { harvests: () => true }), { x: 0, y: F - 1, z: 3 }, feet)).toBe(false);
  });

  it('the ground a step down counts too, after the ground at the feet', () => {
    const at = (p: Vec3): BlockInfo => ({ name: p.x >= 3 ? (p.y >= F - 1 ? 'air' : 'dirt') : p.y >= F ? 'air' : 'dirt' }) as BlockInfo;
    const cells = refillCells(w(at), feet, 200, 3);
    expect(cells.some((c) => c.x === 3 && c.y === F - 2)).toBe(true);
    expect(cells[0]!.y).toBe(F - 1);
  });
});

describe('refillBlocks', () => {
  function deps(start: ItemStack[], o: { digFails?: boolean; walkFails?: boolean } = {}) {
    const slots: (ItemStack | null)[] = [...start];
    const dug = new Set<string>();
    const at = (p: Vec3): BlockInfo => (dug.has(k(p)) ? ({ name: 'air' } as BlockInfo) : world()(p));
    const log: string[] = [];
    const d: RefillDeps = {
      ...w(at),
      position: () => feet,
      slots: () => slots,
      goto: (p) => {
        log.push(`goto ${p.x} ${p.z}`);
        return Promise.resolve(o.walkFails ? { ok: false, reason: 'no_path' } : { ok: true });
      },
      dig: (p) => {
        if (o.digFails) return Promise.resolve({ ok: false, reason: 'x' });
        dug.add(k(p));
        log.push(`dig ${k(p)}`);
        return Promise.resolve({ ok: true });
      },
      collect: () => {
        const s = slots.find((x) => x?.name === 'dirt');
        if (s) s.count++;
        else slots.push(block('dirt', 1));
        return Promise.resolve();
      },
    };
    return { d, slots, log, dug };
  }

  it('digs the shortfall and stops (6 carried: 4 dug), a cell once', async () => {
    const s = deps([block('cobblestone', 6)]);
    const r = await refillBlocks(s.d, SHELL_BLOCKS, () => false);
    expect(r).toMatchObject({ before: 6, after: 10, dug: 4 });
    expect(r.reason).toBeUndefined();
    expect(s.dug.size).toBe(4);
  });

  it('nothing to do with the reserve carried', async () => {
    const s = deps([block('dirt', 12)]);
    expect(await refillBlocks(s.d, SHELL_BLOCKS, () => false)).toMatchObject({ before: 12, after: 12, dug: 0 });
    expect(s.log).toEqual([]);
  });

  it('failing digs end after REFILL_TRIES times the shortfall; cancelled ends at once', async () => {
    const f = deps([], { digFails: true });
    const r = await refillBlocks(f.d, SHELL_BLOCKS, () => false);
    expect(r).toMatchObject({ before: 0, after: 0, dug: 0, reason: 'tries used up' });
    const c = deps([]);
    expect(await refillBlocks(c.d, SHELL_BLOCKS, () => true)).toMatchObject({ dug: 0, reason: 'cancelled' });
    expect(REFILL_TRIES).toBeGreaterThanOrEqual(2);
  });
});

describe('refillBlocks from the hole of the last block', () => {
  // measured on the test server: the pick-up walks into the hole the dig left, and from there the ground round the bot
  // is at the feet's own level: one block dug, then `no ground to dig within 10`
  it('the pick-up leaves the bot in the hole: the ground at the level of the feet is dug next, until 10 are carried', async () => {
    const slots: (ItemStack | null)[] = [];
    const dug = new Set<string>();
    let me = { ...feet };
    const d: RefillDeps = {
      blockAt: (p) => (dug.has(k(p)) ? ({ name: 'air' } as BlockInfo) : world()(p)),
      allowed: () => true,
      harvests: () => false,
      position: () => me,
      slots: () => slots,
      goto: () => Promise.resolve({ ok: true }),
      dig: (p) => {
        dug.add(k(p));
        return Promise.resolve({ ok: true });
      },
      collect: (at) => {
        me = { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y), z: Math.floor(at.z) + 0.5 }; // into the hole
        const st = slots.find((x) => x?.name === 'dirt');
        if (st) st.count++;
        else slots.push(block('dirt', 1));
        return Promise.resolve();
      },
    };
    const r = await refillBlocks(d, SHELL_BLOCKS, () => false);
    expect(r).toMatchObject({ before: 0, after: 10, dug: 10 });
    expect(r.reason).toBeUndefined();
  });

  it('the floor of a hole is never dug (every hole stays one deep); the ground beside a hole still is', () => {
    const hole = world({ [k({ x: 3, y: F - 1, z: 0 })]: 'air' }); // a one-deep hole at x 3
    expect(refillCell(w(hole), { x: 3, y: F - 2, z: 0 }, feet)).toBe(false); // its floor: walls on all four sides over it
    expect(refillCell(w(hole), { x: 4, y: F - 1, z: 0 }, feet)).toBe(true); // the surface next to it
    expect(refillCells(w(hole), feet, 500).some((c) => c.y < F - 1)).toBe(false);
    // a trench one wide: its floor has two walls over it: not dug either
    const trench = world({ [k({ x: 3, y: F - 1, z: 0 })]: 'air', [k({ x: 4, y: F - 1, z: 0 })]: 'air', [k({ x: 5, y: F - 1, z: 0 })]: 'air' });
    expect(refillCell(w(trench), { x: 4, y: F - 2, z: 0 }, feet)).toBe(false);
  });

  it('a cell at the level of the feet or one over it counts when its top is open; two over never', () => {
    const inHole = { x: 0.5, y: F - 1, z: 0.5 };
    expect(refillCell(w(world({ [k({ x: 0, y: F - 1, z: 0 })]: 'air' })), { x: 2, y: F - 1, z: 0 }, inHole)).toBe(true);
    const step = world({ [k({ x: 3, y: F, z: 0 })]: 'dirt', [k({ x: 3, y: F + 1, z: 0 })]: 'dirt', [k({ x: 4, y: F, z: 0 })]: 'dirt' });
    expect(refillCell(w(step), { x: 4, y: F, z: 0 }, feet)).toBe(true); // the top of a step up
    expect(refillCell(w(step), { x: 3, y: F + 1, z: 0 }, feet)).toBe(true);
    expect(refillCell(w(world({ [k({ x: 3, y: F + 2, z: 0 })]: 'dirt' })), { x: 3, y: F + 2, z: 0 }, feet)).toBe(false);
  });
});

describe('refillBlocks inside the base', () => {
  /** The base is everything within 20 (horizontally) of 0, 0; the bot starts at its middle. */
  function inBase(o: { noWay?: boolean } = {}) {
    const slots: (ItemStack | null)[] = [];
    const dug = new Set<string>();
    let me = { ...feet };
    const log: string[] = [];
    const d: RefillDeps = {
      blockAt: (p) => (dug.has(k(p)) ? ({ name: 'air' } as BlockInfo) : world()(p)),
      allowed: (p) => Math.hypot(p.x + 0.5, p.z + 0.5) > 20,
      harvests: () => false,
      position: () => me,
      slots: () => slots,
      goto: () => Promise.resolve({ ok: true }),
      dig: (p) => {
        dug.add(k(p));
        return Promise.resolve({ ok: true });
      },
      collect: () => {
        const s = slots.find((x) => x?.name === 'dirt');
        if (s) s.count++;
        else slots.push(block('dirt', 1));
        return Promise.resolve();
      },
      leaveBase: () => {
        log.push('leave');
        if (o.noWay) return Promise.resolve(false);
        me = { x: 23.5, y: F, z: 0.5 };
        return Promise.resolve(true);
      },
    };
    return { d, log, dug };
  }

  it('no cell near may be dug: walks out of the base once, then digs there', async () => {
    const s = inBase();
    const r = await refillBlocks(s.d, SHELL_BLOCKS, () => false);
    expect(r).toMatchObject({ before: 0, after: 10, dug: 10, left: true });
    expect(s.log).toEqual(['leave']);
    for (const c of s.dug) expect(Math.hypot(Number(c.split(',')[0]) + 0.5, Number(c.split(',')[2]) + 0.5)).toBeGreaterThan(20);
  });

  it('no way out: ends with the reason, nothing dug', async () => {
    const s = inBase({ noWay: true });
    const r = await refillBlocks(s.d, SHELL_BLOCKS, () => false);
    expect(r).toMatchObject({ before: 0, after: 0, dug: 0, reason: 'no ground to dig within 10' });
    expect(r.left).toBeUndefined();
    expect(s.dug.size).toBe(0);
  });
});

describe('refillDeps: the base and built blocks', () => {
  it('leaveBase walks to the nearest way out of the base (the line away from home first), the next when that fails; outside: nothing', async () => {
    const walks: string[] = [];
    const host = (fail: number, pos = { x: 5.5, y: F, z: 0.5 }) => ({
      blockAt: world(),
      position: () => pos,
      slots: () => [],
      base: () => ({ x: 0.5, y: F, z: 0.5, r: 16 }),
      goto: () => Promise.resolve({ ok: true }),
      gotoColumn: (x: number, z: number) => {
        walks.push(`${x} ${z}`);
        return Promise.resolve(walks.length <= fail ? { ok: false, reason: 'unreachable' } : { ok: true });
      },
      dig: () => Promise.resolve({ ok: true }),
      collect: () => Promise.resolve(),
    });
    expect(await refillDeps(host(0)).leaveBase!()).toBe(true);
    expect(walks).toEqual(['19 0']); // 16 + 3 out on the line home -> bot
    walks.length = 0;
    expect(await refillDeps(host(1)).leaveBase!()).toBe(true);
    expect(walks).toHaveLength(2);
    walks.length = 0;
    expect(await refillDeps(host(9)).leaveBase!()).toBe(false);
    expect(walks).toHaveLength(3); // REFILL_EXITS
    walks.length = 0;
    expect(await refillDeps(host(0, { x: 40.5, y: F, z: 0.5 })).leaveBase!()).toBe(false); // outside already
    expect(walks).toEqual([]);
  });


  it('nothing within protectRadius of home is dug; a built block never', () => {
    const at = world({ [k({ x: 30, y: F - 1, z: 0 })]: 'oak_planks' });
    const d = refillDeps({ blockAt: at, position: () => feet, slots: () => [], base: () => ({ x: 0.5, y: F, z: 0.5, r: 16 }), goto: () => Promise.resolve({ ok: true }), dig: () => Promise.resolve({ ok: true }), collect: () => Promise.resolve() });
    expect(d.allowed({ x: 5, y: F - 1, z: 0 })).toBe(false);
    expect(d.allowed({ x: 20, y: F - 1, z: 0 })).toBe(true);
    expect(d.allowed({ x: 30, y: F - 1, z: 0 })).toBe(false);
  });

  it('nothing is dug within REFILL_KEEP of the shelter (the ground the shell stands on), with no base set too', () => {
    const d = refillDeps({ blockAt: world(), position: () => feet, slots: () => [], base: () => undefined, keep: () => [{ x: 20, y: F, z: 0 }, undefined], goto: () => Promise.resolve({ ok: true }), dig: () => Promise.resolve({ ok: true }), collect: () => Promise.resolve() });
    expect(d.allowed({ x: 20 - REFILL_KEEP, y: F - 1, z: REFILL_KEEP })).toBe(false);
    expect(d.allowed({ x: 21, y: F - 1, z: -1 })).toBe(false);
    expect(d.allowed({ x: 20 - REFILL_KEEP - 1, y: F - 1, z: 0 })).toBe(true);
    expect(d.allowed({ x: 20, y: F - 1, z: REFILL_KEEP + 1 })).toBe(true);
  });

  it('the worn-tool rule: a pickaxe the rule leaves out harvests nothing', () => {
    const pick: ItemStack = { name: 'stone_pickaxe', networkId: 2, count: 1, metadata: 0 };
    const base = { blockAt: world(), position: () => feet, base: () => undefined, goto: () => Promise.resolve({ ok: true }), dig: () => Promise.resolve({ ok: true }), collect: () => Promise.resolve() };
    expect(refillDeps({ ...base, slots: () => [pick] }).harvests('stone')).toBe(true);
    expect(refillDeps({ ...base, slots: () => [pick], usable: () => [null] }).harvests('stone')).toBe(false);
  });
});

describe('BlocksChore (shellBlocks): the reserve by day when nothing else runs', () => {
  function chore(o: Partial<BlocksChoreDeps> & { shortNow?: number } = {}) {
    const st = { t: 0, short: o.shortNow ?? 10, day: true, threat: false, busy: false, on: true, refills: 0, cancels: 0, give: 10 };
    let finish: ((r: { before: number; after: number; dug: number; reason?: string }) => void) | undefined;
    const logs: string[] = [];
    const c = new BlocksChore({
      enabled: () => st.on,
      short: () => st.short,
      isDay: () => st.day,
      threat: () => st.threat,
      busy: () => st.busy,
      refill: () => {
        st.refills++;
        return new Promise((r) => (finish = r));
      },
      cancel: () => st.cancels++,
      now: () => st.t,
      log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } as never,
      ...o,
    });
    const done = async (after: number, reason?: string) => {
      st.short = 10 - after;
      finish!({ before: 0, after, dug: after, ...(reason ? { reason } : {}) });
      await new Promise((r) => setTimeout(r, 0));
    };
    return { c, st, logs, done };
  }

  it('wants control when short by day with nothing else running; not at night, with a hostile near, while busy, or off', () => {
    for (const [key, val] of [['day', false], ['threat', true], ['busy', true], ['on', false]] as const) {
      const h = chore();
      (h.st as Record<string, unknown>)[key] = val;
      expect(h.c.wants(), key).toBe(false);
    }
    const full = chore({ shortNow: 0 });
    expect(full.c.wants()).toBe(false);
    const h = chore();
    expect(h.c.wants()).toBe(true);
    expect(h.c.kind).toBe('auto');
    expect(h.c.priority).toBe(30); // the chores' priority: over the walk home, under the owner's commands
  });

  it('digs until the reserve is carried, then wants nothing more', async () => {
    const h = chore();
    expect(h.c.wants()).toBe(true);
    h.c.start();
    expect(h.st.refills).toBe(1);
    await h.done(10);
    h.st.t += BLOCKS_CHECK_MS + 1;
    expect(h.c.wants()).toBe(false);
    expect(h.c.stats).toMatchObject({ started: 1, filled: 1, short: 0 });
  });

  it('a refill that ends short waits BLOCKS_BACKOFF_MS before the next', async () => {
    const h = chore();
    expect(h.c.wants()).toBe(true);
    h.c.start();
    await h.done(3, 'no ground to dig within 10');
    h.st.t += BLOCKS_CHECK_MS + 1;
    expect(h.c.wants()).toBe(false);
    h.st.t += BLOCKS_BACKOFF_MS;
    expect(h.c.wants()).toBe(true);
    expect(h.logs.some((l) => l.includes('7 short'))).toBe(true);
  });

  it('dusk or a hostile during the dig: lets go (the dig is cancelled) and digs on when it may again', () => {
    const h = chore();
    expect(h.c.wants()).toBe(true);
    h.c.start();
    h.st.day = false;
    expect(h.c.wants()).toBe(false);
    h.c.release();
    expect(h.st.cancels).toBe(1);
    h.st.day = true;
    expect(h.c.wants()).toBe(true);
    h.c.start();
    expect(h.st.refills).toBe(2);
  });
});
