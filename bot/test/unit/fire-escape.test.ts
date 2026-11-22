// Track M11 (docs/survival.md "The fire escape (Track M11)", ADR 0126) on fakes: the ways out ranked (water and powder snow
// count), the fire to put out on the way, the straight walk through fire, and FireProcess: Track N2's ledge (the nearest cell
// no walk reaches dropped, the fire it stands in put out), a failed walk dropping its cell, the hand walk with no start node,
// the potion and the pillar when nothing else is left, BurnWatch's fire resistance.
import { describe, expect, it } from 'vitest';
import { NavGrid } from '../../src/skills/nav/index.ts';
import { BurnWatch, climbWalk, clearOfFire, fireOuts, fireToPutOut, straightWalk } from '../../src/skills/survival/fire.ts';
import { ProcessManager } from '../../src/tasks/process/manager.ts';
import { FIRE_POTION_HEALTH, FireProcess } from '../../src/tasks/process/portal.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { flatGen } from './skills/genworld.ts';
import { FakeSource } from './skills/pve-fakes.ts';

describe('the fire escape that reaches its cell (Track M11)', () => {
  const burning = (over: Partial<BurnWatch> = {}): BurnWatch => ({ sample: () => undefined, hurtByFire: () => true, burning: () => true, onFire: true, fireResistant: () => false, touchesLava: () => false, ...over }) as unknown as BurnWatch;
  const run = async (fire: FireProcess, ticks = 40): Promise<void> => {
    const m = new ProcessManager();
    m.add(fire);
    for (let i = 0; i < ticks; i++) {
      m.tick();
      await new Promise((r) => setImmediate(r));
    }
  };

  it('fireOuts: clear cells nearest first, water ranked 2 nearer, powder snow an out; cells beside fire left out', () => {
    const w = flatGen();
    w.fill({ x: -1, y: -60, z: -1 }, { x: 1, y: -60, z: 1 }, 'fire');
    w.put(3, -61, 0, 'water'); // a water cell at the feet level - 1 (a pool in the floor), 3 off
    w.put(0, -61, -4, 'powder_snow');
    const outs = fireOuts(new NavGrid(w), { x: 0.5, y: -60, z: 0.5 });
    expect(outs.length).toBeGreaterThan(3);
    expect(outs[0]).toMatchObject({ p: { x: 3, y: -61, z: 0 }, kind: 'water' }); // d 3.2 - 2 beats ring 2's dry cells
    expect(outs.some((o) => o.kind === 'snow' && o.p.x === 0 && o.p.z === -4)).toBe(true);
    for (const o of outs.filter((o) => o.kind === 'cell')) expect(Math.max(Math.abs(o.p.x), Math.abs(o.p.z))).toBeGreaterThanOrEqual(3); // ring 2 touches the 3 x 3 of fire
    for (let i = 1; i < outs.length; i++) expect(outs[i]!.rank).toBeGreaterThanOrEqual(outs[i - 1]!.rank);
  });

  it('fireToPutOut: the own cell first, then the fire on the straight line to the way out; without one the 3 x 3 round it', () => {
    const w = flatGen();
    w.fill({ x: -2, y: -60, z: -2 }, { x: 2, y: -60, z: 2 }, 'fire');
    const grid = new NavGrid(w);
    const me = { x: 0.5, y: -60, z: 0.5 };
    const lane = fireToPutOut(grid, me, { x: 4, y: -60, z: 0 });
    expect(lane[0]).toEqual({ x: 0, y: -60, z: 0 });
    expect(lane).toContainEqual({ x: 1, y: -60, z: 0 });
    expect(lane).toContainEqual({ x: 2, y: -60, z: 0 });
    expect(lane.some((p) => p.z !== 0 || p.x < 0)).toBe(false); // only the lane
    const round = fireToPutOut(grid, me);
    expect(round).toHaveLength(9);
    expect(round[0]).toEqual({ x: 0, y: -60, z: 0 });
  });

  it('straightWalk: through fire over a floor, not over a gap, into a wall or over lava', () => {
    const w = flatGen();
    w.fill({ x: 0, y: -60, z: 0 }, { x: 2, y: -60, z: 0 }, 'fire');
    const grid = new NavGrid(w);
    const me = { x: 0.5, y: -60, z: 0.5 };
    expect(straightWalk(grid, me, { x: 4, y: -60, z: 0 })).toBe(true);
    expect(straightWalk(grid, me, { x: 4, y: -59, z: 0 })).toBe(false); // another level
    w.set(2, -61, 0, 'air');
    expect(straightWalk(new NavGrid(w), me, { x: 4, y: -60, z: 0 })).toBe(false);
    w.set(2, -61, 0, 'lava');
    expect(straightWalk(new NavGrid(w), me, { x: 4, y: -60, z: 0 })).toBe(false);
    w.set(2, -61, 0, 'stone');
    w.set(3, -59, 0, 'stone'); // the head level
    expect(straightWalk(new NavGrid(w), me, { x: 4, y: -60, z: 0 })).toBe(false);
    // the body over the edge of a burnt plank: the floor behind it is not asked as it leaves; walking back over it is
    const w2 = flatGen();
    w2.set(0, -61, 0, 'air');
    const edge = { x: 1.1, y: -60, z: 0.5 };
    expect(straightWalk(new NavGrid(w2), edge, { x: 4, y: -60, z: 0 })).toBe(true);
    expect(straightWalk(new NavGrid(w2), edge, { x: -3, y: -60, z: 0 })).toBe(false);
  });

  it("FireProcess (Track N2's ledge): the nearest cell planned unreachable is dropped, the fire it stands in and on the way put out, the walk ends out", async () => {
    // a ledge along x at feet -60 (the wall at z -1), fire in the bot's cell and both beside it; the pocket 2 down in front
    // (z 1) is the nearest clear cell and no walk reaches it
    const w = flatGen();
    w.fill({ x: -8, y: -61, z: 1 }, { x: 8, y: -61, z: 6 }, 'air');
    w.fill({ x: -8, y: -62, z: 1 }, { x: 8, y: -62, z: 6 }, 'air');
    w.fill({ x: -8, y: -60, z: -1 }, { x: 8, y: -57, z: -1 }, 'stone');
    w.fill({ x: -3, y: -60, z: 1 }, { x: 3, y: -59, z: 1 }, 'bedrock'); // the rail
    w.fill({ x: -1, y: -60, z: 0 }, { x: 1, y: -60, z: 0 }, 'fire');
    const grid = new NavGrid(w);
    let pos: Vec3 = { x: 0.5, y: -60, z: 0.5 };
    const struck: Vec3[] = [];
    const gotos: Vec3[] = [];
    const asked: Vec3[] = [];
    const fire = new FireProcess({
      watch: burning(),
      grid,
      mover: {
        goto: (g) => {
          const p = (g as { p: Vec3 }).p;
          gotos.push(p);
          pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
          return Promise.resolve({ ok: true });
        },
        cancel: () => undefined,
        nav: { busy: false },
      },
      position: () => pos,
      extinguish: (p) => {
        struck.push(p);
        w.set(p.x, p.y, p.z, 'air');
        grid.invalidate(p.x, p.y, p.z); // the world's block update (the bot's wiring invalidates the grid)
        return Promise.resolve(true);
      },
      // the planner on the grid: a walk on the ledge's level (no fire on the way), none to another level
      plans: (from, to) => {
        asked.push(to);
        const fy = Math.floor(from.y);
        if (to.y !== fy || to.z !== 0) return false;
        for (let x = Math.min(Math.floor(from.x), to.x); x <= Math.max(Math.floor(from.x), to.x); x++) if (grid.cls(x, fy, 0)?.name === 'fire') return false;
        return true;
      },
    });
    expect(fire.wants()).toBe(true);
    await run(fire);
    expect(struck[0]).toEqual({ x: 0, y: -60, z: 0 }); // the fire it stands in first
    expect(asked.some((p) => p.y < -60)).toBe(true); // the pocket was asked about and dropped
    expect(gotos).toHaveLength(1);
    expect(gotos[0]!).toMatchObject({ y: -60, z: 0 }); // along the ledge, not the pocket
    expect(clearOfFire(grid, gotos[0]!)).toBe(true); // the fire on the way put out: the cell beside is clear now
    expect(fire.lastEnd).toBe('out');
    expect(fire.stats).toMatchObject({ escapes: 1, noEscape: 0, failedWalks: 0 });
    expect(fire.stats.putOut).toBeGreaterThanOrEqual(2);
  });

  it('FireProcess: a walk that fails drops its cell and the next goes at once', async () => {
    const w = flatGen();
    w.put(0, -60, 0, 'fire');
    w.put(1, -60, 0, 'fire');
    const grid = new NavGrid(w);
    let pos: Vec3 = { x: 0.5, y: -60, z: 0.5 };
    const gotos: Vec3[] = [];
    const fire = new FireProcess({
      watch: burning(),
      grid,
      mover: {
        goto: (g) => {
          const p = (g as { p: Vec3 }).p;
          gotos.push(p);
          if (gotos.length === 1) return Promise.resolve({ ok: false, reason: 'unreachable' });
          pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
          return Promise.resolve({ ok: true });
        },
        cancel: () => undefined,
        nav: { busy: false },
      },
      position: () => pos,
      plans: () => true,
    });
    await run(fire);
    expect(gotos).toHaveLength(2);
    expect(gotos[1]).not.toEqual(gotos[0]);
    expect(fire.stats).toMatchObject({ walks: 2, failedWalks: 1 });
    expect(fire.lastEnd).toBe('out');
  });

  it('FireProcess: no start node and nothing to put out: straight through the fire by hand; no way at all: the potion, then a pillar', async () => {
    const w = flatGen();
    w.fill({ x: -2, y: -60, z: -2 }, { x: 2, y: -60, z: 2 }, 'fire');
    const grid = new NavGrid(w);
    const pos: Vec3 = { x: 0.5, y: -60, z: 0.5 };
    const cmds: { yaw?: number; forward?: number }[] = [];
    const loop = {
      state: { pos, ready: true },
      setCommand: (c: { yaw?: number; forward?: number }) => {
        cmds.push(c);
        pos.x += 0.3; // walks east
      },
      release: () => undefined,
      waitTicks: () => Promise.resolve(),
    };
    const fire = new FireProcess({ watch: burning(), grid, mover: { goto: () => Promise.resolve({ ok: false, reason: 'unreachable' }), cancel: () => undefined, nav: { busy: false } }, position: () => pos, plans: () => undefined, loop });
    await run(fire);
    expect(fire.stats.handWalks).toBeGreaterThanOrEqual(1);
    expect(cmds.length).toBeGreaterThan(3);
    expect(pos.x).toBeGreaterThan(3); // out of the 5 x 5 of fire
    // a pit of fire with walls all round: no out, no line: the potion first, then a pillar
    const w2 = flatGen();
    w2.fill({ x: -1, y: -60, z: -1 }, { x: 1, y: -57, z: 1 }, 'stone');
    w2.put(0, -60, 0, 'fire');
    w2.put(0, -59, 0, 'air');
    w2.put(0, -58, 0, 'air');
    const calls: string[] = [];
    const fire2 = new FireProcess({
      watch: burning(),
      grid: new NavGrid(w2),
      mover: { goto: () => Promise.resolve({ ok: false, reason: 'unreachable' }), cancel: () => undefined, nav: { busy: false } },
      position: () => ({ x: 0.5, y: -60, z: 0.5 }),
      plans: () => false,
      drinkFireResistance: () => {
        calls.push('drink');
        return Promise.resolve(false); // none carried
      },
      pillar: () => {
        calls.push('pillar');
        return Promise.resolve(true);
      },
    });
    await run(fire2);
    expect(calls).toEqual(['drink', 'pillar']);
    expect(fire2.lastEnd).toBe('none');
  });

  it('climbWalk and FireProcess: in lava a block deep (no start node) the body swims and climbs out to a way out one up', async () => {
    // a lava pool a block deep west of the bot and the cell it stands in (feet -61, on dirt)
    const w = flatGen();
    w.fill({ x: -3, y: -61, z: 0 }, { x: 0, y: -61, z: 0 }, 'lava');
    const grid = new NavGrid(w);
    const pos: Vec3 = { x: 0.5, y: -61, z: 0.5 };
    expect(climbWalk(grid, pos, { x: 2, y: -60, z: 0 })).toBe(true);
    expect(climbWalk(grid, pos, { x: 2, y: -59, z: 0 })).toBe(false); // two up, no floor under it
    const deep = flatGen();
    deep.fill({ x: -3, y: -62, z: 0 }, { x: 0, y: -61, z: 0 }, 'lava'); // 2 deep
    expect(climbWalk(new NavGrid(deep), { x: 0.5, y: -62, z: 0.5 }, { x: 2, y: -60, z: 0 })).toBe(true); // swims up 2
    expect(climbWalk(new NavGrid(deep), { x: 0.5, y: -62, z: 0.5 }, { x: 2, y: -59, z: 0 })).toBe(false); // 3 up
    expect(climbWalk(grid, pos, { x: 4, y: -60, z: 0 })).toBe(false); // more than 3 off
    expect(climbWalk(grid, pos, { x: -2, y: -60, z: 1 })).toBe(true); // over the pool to its far side
    w.set(0, -59, 0, 'stone'); // no room to rise out
    expect(climbWalk(new NavGrid(w), pos, { x: 2, y: -60, z: 0 })).toBe(false);
    w.set(0, -59, 0, 'air');
    const g2 = new NavGrid(w);
    let jumps = 0;
    const loop = {
      state: { pos, ready: true },
      setCommand: (c: { yaw?: number; forward?: number; jump?: boolean }) => {
        if (c.jump) {
          jumps++;
          pos.y = Math.min(-60, pos.y + 0.25); // rises in the lava, hops out at the edge
        }
        if (pos.y < -60.4) return; // against the edge until risen
        const r = ((c.yaw ?? 0) * Math.PI) / 180;
        pos.x += -Math.sin(r) * 0.25;
        pos.z += Math.cos(r) * 0.25;
      },
      release: () => undefined,
      waitTicks: () => Promise.resolve(),
    };
    const fire = new FireProcess({
      // the body touches the lava while its feet are under the lava cell's top in a pool column
      watch: burning({ touchesLava: () => pos.y < -60 - 1e-6 && Math.floor(pos.x) <= 0 && Math.floor(pos.x) >= -3 && Math.floor(pos.z) === 0 }),
      grid: g2,
      mover: { goto: () => Promise.resolve({ ok: false, reason: 'unreachable' }), cancel: () => undefined, nav: { busy: false } },
      position: () => pos,
      plans: () => undefined, // no start node in the lava
      loop,
      pillar: () => Promise.resolve(false),
    });
    await run(fire);
    expect(fire.stats.climbs).toBeGreaterThanOrEqual(1);
    expect(jumps).toBeGreaterThan(0);
    expect(pos.y).toBe(-60);
    expect(clearOfFire(g2, { x: Math.floor(pos.x), y: -60, z: Math.floor(pos.z) })).toBe(true);
    expect(fire.lastEnd).toBe('out');
    expect(fire.stats.pillars).toBe(0);
  });

  it('FireProcess: a fire resistance potion drunk ends the escape (resisted); BurnWatch reads the effect', async () => {
    const src = new FakeSource();
    let t = 0;
    const bw = new BurnWatch(src, { selfRuntimeId: () => 7n, health: () => 20, now: () => t });
    expect(bw.fireResistant()).toBe(false);
    src.emit('mob_effect', { runtime_entity_id: 7n, event_id: 'add', effect_id: 12, amplifier: 0, duration: 3600 });
    expect(bw.fireResistant()).toBe(true);
    t = 200_000;
    expect(bw.fireResistant()).toBe(false);
    src.emit('mob_effect', { runtime_entity_id: 7n, event_id: 'add', effect_id: 12, amplifier: 0, duration: 3600 });
    src.emit('mob_effect', { runtime_entity_id: 7n, event_id: 'remove', effect_id: 12 });
    expect(bw.fireResistant()).toBe(false);
    bw.dispose();
    const w = flatGen();
    w.fill({ x: -1, y: -60, z: -1 }, { x: 1, y: -57, z: 1 }, 'stone');
    w.put(0, -60, 0, 'fire');
    w.put(0, -59, 0, 'air');
    let resistant = false;
    const fire = new FireProcess({
      watch: burning({ fireResistant: () => resistant }),
      grid: new NavGrid(w),
      mover: { goto: () => Promise.resolve({ ok: false, reason: 'unreachable' }), cancel: () => undefined, nav: { busy: false } },
      position: () => ({ x: 0.5, y: -60, z: 0.5 }),
      plans: () => false,
      drinkFireResistance: () => {
        resistant = true;
        return Promise.resolve(true);
      },
    });
    await run(fire);
    expect(fire.lastEnd).toBe('resisted');
    expect(fire.stats.drinks).toBe(1);
  });

  it(`FireProcess: out of the fire, still burning at ${FIRE_POTION_HEALTH} health or less: the potion when one is carried; above it, not`, async () => {
    for (const [health, drinks] of [
      [8, 1],
      [14, 0],
    ] as const) {
      const w = flatGen();
      w.put(0, -60, 0, 'fire');
      let pos: Vec3 = { x: 0.5, y: -60, z: 0.5 };
      let drunk = 0;
      const fire = new FireProcess({
        watch: burning(),
        grid: new NavGrid(w),
        mover: {
          goto: (g) => {
            const p = (g as { p: Vec3 }).p;
            pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
            return Promise.resolve({ ok: true });
          },
          cancel: () => undefined,
          nav: { busy: false },
        },
        position: () => pos,
        health: () => health,
        drinkFireResistance: () => {
          drunk++;
          return Promise.resolve(true);
        },
      });
      await run(fire, 10);
      expect(fire.lastEnd, String(health)).toBe('out');
      expect(drunk, String(health)).toBe(drinks);
    }
  });
});
