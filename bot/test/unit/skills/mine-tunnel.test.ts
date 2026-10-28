// Direct tunnels, shafts, veins and the floor sweep (wave 10 Track AQ; docs/mining.md, decision 0038) on
// fixture voxel worlds: the plan's geometry (horizontal, staircase down / up, shaft), every dig and shaft
// rule (protected blocks, liquids next to a cell, liquid / dripstone / a cave / unknown below a shaft,
// gravity over the shaft, the world floor), the choice staircase vs shaft, the climb-back plan, the way
// back never undercut, runTunnel's re-check on the live world, the vein flood fill, the sweep helper.
import { describe, expect, it } from 'vitest';
import type { BlockInfo, EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { chooseTunnel, clearStep, planTunnel, runTunnel, SHAFT_SAVES, shaftRule, type TunnelIO, type TunnelPlan, type TunnelWorld } from '../../../src/skills/mine/tunnel.ts';
import { oreKind, veinFrom, VEIN_NEIGHBOURS } from '../../../src/skills/mine/vein.ts';
import { isWoodDrop, itemsOfKind, sweepItems } from '../../../src/skills/collect/sweep.ts';

const k = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const LIQ = new Set(['water', 'lava']);
const OPEN = new Set(['air']);
const PROTECT = new Set(['stone_bricks', 'chest']);
const GRAVITY = new Set(['sand', 'gravel']);
const HAZARD = new Set(['fire', 'sweet_berry_bush']); // Track BB: no box, "air" to the break rules, never walked into

/** Stone below `surface` (air from it up), with overrides; `unknown` cells answer undefined. */
class Voxels {
  readonly cells = new Map<string, string>();
  readonly surface: number;
  constructor(surface = 0) {
    this.surface = surface;
  }
  get(p: Vec3): string {
    return this.cells.get(k(p)) ?? (p.y < this.surface ? 'stone' : 'air');
  }
  set(p: Vec3, name: string): this {
    this.cells.set(k(p), name);
    return this;
  }
  box(a: Vec3, b: Vec3, name: string): this {
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) for (let z = a.z; z <= b.z; z++) this.set({ x, y, z }, name);
    return this;
  }
}

function tw(v: Voxels): TunnelWorld {
  const info = (n: string): BlockInfo => ({ name: n, stateId: 1, states: {}, hardness: 1, solid: !OPEN.has(n) && !LIQ.has(n), boxes: OPEN.has(n) || LIQ.has(n) ? [] : [{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }] as never });
  return {
    minY: -64,
    cell: (p) => {
      const n = v.get(p);
      if (n === 'unknown') return undefined;
      return { open: OPEN.has(n), solid: !OPEN.has(n) && !LIQ.has(n) && n !== 'pointed_dripstone' && !HAZARD.has(n), liquid: LIQ.has(n), gravity: GRAVITY.has(n), dripstone: n === 'pointed_dripstone', hazard: HAZARD.has(n) };
    },
    blockAt: (p) => (v.get(p) === 'unknown' ? undefined : info(v.get(p))),
    breakRule: (p) => {
      const n = v.get(p);
      if (n === 'unknown') return 'unknown';
      if (OPEN.has(n) || HAZARD.has(n)) return 'air';
      if (LIQ.has(n)) return 'liquid';
      if (PROTECT.has(n)) return 'protected';
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as const)
        if (LIQ.has(v.get({ x: p.x + dx, y: p.y + dy, z: p.z + dz }))) return 'next_to_liquid';
      if (GRAVITY.has(v.get({ ...p, y: p.y + 1 }))) return 'gravity_above';
      return undefined;
    },
  };
}

const O = { x: 0, y: 0, z: 0 };
const ore = (v: Voxels, p: Vec3, n = 'coal_ore') => (v.set(p, n), p);
const stairs = (v: Voxels, from: Vec3, p: Vec3, names?: Set<string>) => planTunnel(tw(v), from, { kind: 'ore', p }, { mode: 'stairs', ...(names ? { names } : {}) });
const shaft = (v: Voxels, from: Vec3, p: Vec3) => planTunnel(tw(v), from, { kind: 'ore', p }, { mode: 'shaft' });

/** No step digs a cell an earlier step (or the start) stands on. */
function wayBackIntact(plan: TunnelPlan, from: Vec3): boolean {
  const floors = [k({ ...from, y: from.y - 1 })];
  for (const st of plan.steps) {
    if (st.kind !== 'shaft' && st.dig.some((c) => floors.includes(k(c)))) return false;
    floors.push(k(st.floor));
  }
  return true;
}

describe('planTunnel: geometry', () => {
  it('an ore 8 blocks into a wall at head height: a straight horizontal tunnel', () => {
    const v = new Voxels(0).box({ x: 2, y: 0, z: -3 }, { x: 12, y: 5, z: 3 }, 'stone');
    const p = ore(v, { x: 9, y: 1, z: 0 });
    const plan = stairs(v, O, p);
    expect(plan.ok).toBe(true);
    expect(plan.end).toBe('reach');
    expect(plan.steps.every((s) => s.kind === 'flat' && s.dir![0] === 1)).toBe(true);
    expect(plan.dug).toBe(14); // x 2..8 (feet + head): the ore's face opens when x 8 is dug
    expect(plan.steps.at(-1)!.feet.x).toBeGreaterThanOrEqual(7);
  });

  it('an ore 4 under the floor: a diagonal staircase down, never a shaft, the way back intact', () => {
    const v = new Voxels(0);
    const p = ore(v, { x: 4, y: -5, z: 0 });
    const plan = stairs(v, O, p);
    expect(plan.ok).toBe(true);
    expect(plan.steps.some((s) => s.kind === 'down')).toBe(true);
    expect(plan.steps.some((s) => s.kind === 'shaft')).toBe(false);
    expect(wayBackIntact(plan, O)).toBe(true);
    // never digs the ore as a tunnel block
    expect(plan.steps.flatMap((s) => s.dig).some((c) => k(c) === k(p))).toBe(false);
  });

  it('an ore 6 up inside a hill: a staircase up', () => {
    const v = new Voxels(0).box({ x: 1, y: 0, z: -3 }, { x: 12, y: 12, z: 3 }, 'stone');
    const p = ore(v, { x: 5, y: 6, z: 0 });
    const plan = stairs(v, O, p);
    expect(plan.ok).toBe(true);
    expect(plan.steps.filter((s) => s.kind === 'up').length).toBeGreaterThanOrEqual(4);
    expect(wayBackIntact(plan, O)).toBe(true);
  });

  it('an ore straight below with little room: a spiral staircase (never back the way it came)', () => {
    const v = new Voxels(0);
    const p = ore(v, { x: 0, y: -6, z: 0 });
    const plan = stairs(v, O, p);
    expect(plan.ok).toBe(true);
    for (let i = 1; i < plan.steps.length; i++) {
      const a = plan.steps[i - 1]!.dir!;
      const b = plan.steps[i]!.dir!;
      expect(a[0] === -b[0] && a[1] === -b[1]).toBe(false);
    }
    expect(wayBackIntact(plan, O)).toBe(true);
  });

  it('another block of the asked kind in the line ends the tunnel there (the miner takes it next)', () => {
    const v = new Voxels(0).box({ x: 2, y: 0, z: -3 }, { x: 12, y: 5, z: 3 }, 'stone');
    const p = ore(v, { x: 9, y: 1, z: 0 });
    const q = ore(v, { x: 4, y: 0, z: 0 }, 'deepslate_coal_ore');
    const plan = stairs(v, O, p, new Set(['coal_ore', 'deepslate_coal_ore']));
    expect(plan.ok).toBe(true);
    expect(plan.end).toBe('ore');
    expect(plan.ore).toEqual(q);
  });
});

describe('planTunnel: dig rules', () => {
  it('stone bricks in the line stop the plan with the reason, before any dig', () => {
    const v = new Voxels(0).box({ x: 2, y: 0, z: -3 }, { x: 12, y: 5, z: 3 }, 'stone');
    const p = ore(v, { x: 9, y: 1, z: 0 });
    v.set({ x: 5, y: 1, z: 0 }, 'stone_bricks');
    const plan = stairs(v, O, p);
    expect(plan.ok).toBe(false);
    expect(plan.why).toMatch(/^protected at 5 1 0/);
  });

  it('Track BB: fire in the line (no box: "air" to the break rules) stops the plan as a hazard', () => {
    const v = new Voxels(0).box({ x: 2, y: 0, z: -3 }, { x: 12, y: 5, z: 3 }, 'stone');
    const p = ore(v, { x: 9, y: 1, z: 0 });
    v.set({ x: 5, y: 0, z: 0 }, 'fire');
    const plan = stairs(v, O, p);
    expect(plan.ok).toBe(false);
    expect(plan.why).toMatch(/^hazard at 5 0 0/);
  });

  it('water over the line and lava under it stop the plan (next_to_liquid)', () => {
    const v = new Voxels(0).box({ x: 2, y: -2, z: -3 }, { x: 12, y: 5, z: 3 }, 'stone');
    const p = ore(v, { x: 9, y: 1, z: 0 });
    v.set({ x: 6, y: 2, z: 0 }, 'water');
    expect(stairs(v, O, p).why).toMatch(/next_to_liquid at 6 1 0/);
    v.set({ x: 6, y: 2, z: 0 }, 'stone').set({ x: 6, y: -1, z: 0 }, 'lava');
    expect(stairs(v, O, p).why).toMatch(/next_to_liquid at 6 0 0/);
  });

  it('a cave on the way (no floor for the next step) blocks it', () => {
    const v = new Voxels(0);
    const p = ore(v, { x: 6, y: -1, z: 0 });
    v.box({ x: 1, y: -3, z: -2 }, { x: 4, y: -1, z: 2 }, 'air');
    const plan = stairs(v, O, p);
    expect(plan.ok).toBe(false);
    expect(plan.why).toMatch(/no floor/);
  });

  it('an unloaded cell blocks it', () => {
    const v = new Voxels(0).box({ x: 2, y: 0, z: -3 }, { x: 12, y: 5, z: 3 }, 'stone');
    const p = ore(v, { x: 9, y: 1, z: 0 });
    v.box({ x: 4, y: 0, z: -3 }, { x: 4, y: 3, z: 3 }, 'unknown');
    expect(stairs(v, O, p).why).toMatch(/not loaded/);
  });
});

describe('shafts (owner, 2026-10-30)', () => {
  const tower = () => new Voxels(0);
  it('an ore 10 straight down with solid rock all the way: a shaft, chosen over the staircase', () => {
    const v = tower();
    const p = ore(v, { x: 0, y: -11, z: 0 });
    const a = stairs(v, O, p);
    const b = shaft(v, O, p);
    expect(b.ok).toBe(true);
    expect(b.steps.every((s) => s.kind === 'shaft')).toBe(true);
    expect(b.depth).toBe(10); // stands on the ore, then digs it
    expect(a.ok).toBe(true);
    expect(a.dug - b.dug).toBeGreaterThanOrEqual(SHAFT_SAVES);
    expect(chooseTunnel(a, b)).toBe(b);
  });

  it('the staircase when the shaft saves fewer than 8 blocks', () => {
    const v = tower();
    const p = ore(v, { x: 4, y: -4, z: 0 });
    const a = stairs(v, O, p);
    const b = shaft(v, O, p);
    expect(a.ok && b.ok).toBe(true);
    expect(a.dug - b.dug).toBeLessThan(SHAFT_SAVES);
    expect(chooseTunnel(a, b)).toBe(a);
  });

  it('the shaft goes horizontal first, then down next to the ore', () => {
    const v = tower();
    const p = ore(v, { x: 3, y: -12, z: 0 });
    const b = shaft(v, O, p);
    expect(b.ok).toBe(true);
    const kinds = b.steps.map((s) => s.kind);
    expect(kinds.slice(0, 2)).toEqual(['flat', 'flat']);
    expect(kinds.slice(2).every((x) => x === 'shaft')).toBe(true);
  });

  it('lava 2 blocks under the ore: blocked (liquid_below), and the choice keeps that reason', () => {
    const v = tower();
    const p = ore(v, { x: 0, y: -11, z: 0 });
    v.set({ x: 0, y: -13, z: 0 }, 'lava');
    const b = shaft(v, O, p);
    expect(b.ok).toBe(false);
    expect(b.why).toMatch(/^liquid_below at 0 -13 0/);
    const a = stairs(v, O, p);
    expect(chooseTunnel(a, b).why).toMatch(/liquid_below/);
  });

  it('water beside the column 2 below the next block: blocked', () => {
    const v = tower();
    const p = ore(v, { x: 0, y: -11, z: 0 });
    v.set({ x: 1, y: -6, z: 0 }, 'water');
    expect(shaft(v, O, p).why).toMatch(/liquid_below at 1 -6 0/);
  });

  it('pointed dripstone within 3 below: blocked (dripstone_below)', () => {
    const v = tower();
    const p = ore(v, { x: 0, y: -11, z: 0 });
    v.box({ x: -1, y: -14, z: -1 }, { x: 1, y: -13, z: 1 }, 'air').set({ x: 1, y: -14, z: 0 }, 'pointed_dripstone');
    expect(shaft(v, O, p).why).toMatch(/^dripstone_below at 1 -14 0/);
  });

  it('a cave right under the next block (a fall): blocked (no_floor_below)', () => {
    const v = tower();
    const p = ore(v, { x: 0, y: -11, z: 0 });
    v.box({ x: -2, y: -8, z: -2 }, { x: 2, y: -6, z: 2 }, 'air');
    expect(shaft(v, O, p).why).toMatch(/^no_floor_below at 0 -6 0/);
  });

  it('an unknown block below: blocked (unknown_below)', () => {
    const v = tower();
    const p = ore(v, { x: 0, y: -11, z: 0 });
    v.set({ x: 0, y: -5, z: 0 }, 'unknown');
    expect(shaft(v, O, p).why).toMatch(/^unknown_below/);
  });

  it('gravel over the shaft top: blocked (gravity_above)', () => {
    const v = tower();
    const p = ore(v, { x: 0, y: -11, z: 0 });
    v.set({ x: 0, y: 2, z: 0 }, 'gravel');
    expect(shaft(v, O, p).why).toMatch(/^gravity_above at 0 2 0/);
  });

  it('never closer than 2 blocks to the world floor', () => {
    const v = tower();
    const from = { x: 0, y: -55, z: 0 };
    v.box({ x: -3, y: -55, z: -3 }, { x: 3, y: -52, z: 3 }, 'air');
    const p = ore(v, { x: 0, y: -64, z: 0 });
    expect(shaft(v, from, p).why).toMatch(/world floor/);
    expect(shaftRule(tw(v), { x: 0, y: -63, z: 0 }, new Set(), false)).toMatch(/world floor/);
  });

  it('the climb back: a staircase up from the shaft bottom, planned with the descent opened', () => {
    const v = tower();
    const p = ore(v, { x: 0, y: -11, z: 0 });
    const b = shaft(v, O, p);
    const bottom = b.steps.at(-1)!.feet;
    const climb = planTunnel(tw(v), bottom, { kind: 'feet', p: O }, { mode: 'stairs', opened: b.opened });
    expect(climb.ok).toBe(true);
    expect(climb.end).toBe('feet');
    expect(climb.steps.every((s) => s.kind === 'up' || s.kind === 'flat')).toBe(true);
    expect(climb.steps.at(-1)!.feet.y).toBe(0);
  });
});

describe('runTunnel and clearStep', () => {
  function io(v: Voxels, start: Vec3): TunnelIO & { pos: Vec3; dug: Vec3[] } {
    const w = tw(v);
    const s = {
      pos: { x: start.x + 0.5, y: start.y, z: start.z + 0.5 },
      dug: [] as Vec3[],
      alive: () => true,
      breakRule: (p: Vec3) => w.breakRule(p),
      free: (p: Vec3) => v.get(p) === 'air',
      dig: (p: Vec3) => {
        v.set(p, 'air');
        s.dug.push(p);
        // a dug block under the feet: the body drops into it
        if (Math.floor(s.pos.x) === p.x && Math.floor(s.pos.z) === p.z && Math.floor(s.pos.y) - 1 === p.y) s.pos = { ...s.pos, y: p.y };
        return Promise.resolve({ ok: true });
      },
      goto: (g: { type: string; p?: Vec3 }) => {
        if (g.p) s.pos = { x: g.p.x + 0.5, y: g.p.y, z: g.p.z + 0.5 };
        return Promise.resolve({ ok: true });
      },
      position: () => s.pos,
      waitTicks: () => Promise.resolve(),
    };
    return s as never;
  }

  it('digs the planned cells and ends where the plan ends', async () => {
    const v = new Voxels(0).box({ x: 2, y: 0, z: -3 }, { x: 12, y: 5, z: 3 }, 'stone');
    const p = ore(v, { x: 9, y: 1, z: 0 });
    const plan = stairs(v, O, p);
    const i = io(v, O);
    const r = await runTunnel(i, tw(v), plan);
    expect(r.ok).toBe(true);
    expect(r.dug).toBe(plan.dug);
    expect(Math.floor(i.pos.x)).toBe(plan.steps.at(-1)!.feet.x);
  });

  it('a shaft: drops into each dug cell', async () => {
    const v = new Voxels(0);
    const p = ore(v, { x: 0, y: -11, z: 0 });
    const plan = shaft(v, O, p);
    const i = io(v, O);
    const r = await runTunnel(i, tw(v), plan);
    expect(r.ok).toBe(true);
    expect(i.pos.y).toBe(-10);
  });

  it('re-checks the rules on the live world: lava that appeared after planning stops it', async () => {
    const v = new Voxels(0).box({ x: 2, y: 0, z: -3 }, { x: 12, y: 5, z: 3 }, 'stone');
    const p = ore(v, { x: 9, y: 1, z: 0 });
    const plan = stairs(v, O, p);
    v.set({ x: 5, y: 2, z: 0 }, 'lava');
    const i = io(v, O);
    const r = await runTunnel(i, tw(v), plan);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/next_to_liquid/);
    expect(i.dug.some((c) => c.x >= 5)).toBe(false);
  });

  it('clearStep hands a deferred cell back without digging it', async () => {
    const v = new Voxels(0).box({ x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, 'stone');
    const i = io(v, O);
    const r = await clearStep(i, { feet: { x: 1, y: 0, z: 0 }, dig: [{ x: 1, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }], floor: { x: 1, y: -1, z: 0 } }, { skip: (c) => (c.y === 0 ? 'defer' : undefined) });
    expect(r).toBe('interrupted');
    expect(i.dug).toEqual([{ x: 1, y: 1, z: 0 }]);
  });
});

describe('veins', () => {
  const info = (n: string) => ({ name: n }) as BlockInfo;
  it('18 neighbours: faces and edges, not corners', () => {
    expect(VEIN_NEIGHBOURS.length).toBe(18);
    const v = new Voxels(10);
    const cells = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 }, // face
      { x: 2, y: 1, z: 0 }, // edge of the last
      { x: 3, y: 2, z: 1 }, // corner of the last: not part of it
    ];
    for (const c of cells) v.set(c, 'diamond_ore');
    const g = veinFrom((p) => info(v.get(p)), cells[0]!, 'diamond_ore');
    expect(g.map(k).sort()).toEqual(cells.slice(0, 3).map(k).sort());
  });
  it('deepslate and normal variants are one kind; the seed may be mined already', () => {
    const v = new Voxels(10).set({ x: 1, y: 0, z: 0 }, 'deepslate_iron_ore').set({ x: 1, y: 1, z: 0 }, 'iron_ore').set({ x: 5, y: 0, z: 0 }, 'iron_ore');
    v.set({ x: 0, y: 0, z: 0 }, 'air');
    expect(oreKind('lit_deepslate_redstone_ore')).toBe('redstone_ore');
    const g = veinFrom((p) => info(v.get(p)), { x: 0, y: 0, z: 0 }, 'iron_ore');
    expect(g.length).toBe(2);
  });
  it('at most max blocks', () => {
    const v = new Voxels(-100).box({ x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 0 }, 'coal_ore');
    expect(veinFrom((p) => info(v.get(p)), { x: 0, y: 0, z: 0 }, 'coal_ore', 20).length).toBe(20);
  });
});

describe('sweepItems (produce on the floor)', () => {
  const item = (id: number, name: string, p: Vec3): [bigint, EntityInfo] => [BigInt(id), { runtimeId: BigInt(id), uniqueId: BigInt(id), type: 'minecraft:item', pos: p, item: { name, count: 1 } } as unknown as EntityInfo];
  it('one entity scan and no collect when nothing of the kind is near', async () => {
    let calls = 0;
    const ents = new Map([item(1, 'cobblestone', { x: 2, y: 0, z: 0 }), item(2, 'oak_log', { x: 20, y: 0, z: 0 })]);
    const r = await sweepItems(
      () => {
        calls++;
        return Promise.resolve({});
      },
      isWoodDrop,
      { entities: () => ents, position: () => ({ x: 0, y: 0, z: 0 }) },
    );
    expect(r).toBeUndefined();
    expect(calls).toBe(0);
  });
  it('collects the kind within 8 blocks with a filter and no grace wait', async () => {
    const seen: { r: number; opts: { graceTicks?: number; filter?: (i: { name: string }) => boolean } }[] = [];
    const ents = new Map([item(1, 'oak_log', { x: 5, y: 0, z: 0 })]);
    expect(itemsOfKind(ents, { x: 0, y: 0, z: 0 }, 8, isWoodDrop)).toBe(1);
    await sweepItems(
      (r, _t, opts) => {
        seen.push({ r, opts: opts as never });
        return Promise.resolve({ ok: true });
      },
      isWoodDrop,
      { entities: () => ents, position: () => ({ x: 0, y: 0, z: 0 }) },
    );
    expect(seen.length).toBe(1);
    expect(seen[0]!.r).toBe(8);
    expect(seen[0]!.opts.graceTicks).toBe(0);
    expect(seen[0]!.opts.filter!({ name: 'oak_sapling' })).toBe(true);
    expect(seen[0]!.opts.filter!({ name: 'dirt' })).toBe(false);
  });
});
