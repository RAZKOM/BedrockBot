// Track R7 (docs/pathfinding.md "A walk that starts or ends where the body is held low (Track R7)";
// decisions/0072-reachability.md "R7"): a fence under a roof's eave, the eave's block 1.5 over the fence's top. The
// server holds a body there crouched (its box 1.49 high, no sneak key: physics.ts heldLow). Before R7 such a top was no
// perch (NavGrid.perch asks 1.8 of head room): as a start no standable node and unreachable with no plan, as a goal
// unreachable after a minute of plans.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PHYSICS, heldLow, stepBody } from '../../../src/skills/input/physics.ts';
import { initialBody } from '../../../src/skills/input/types.ts';
import { findPath, locatePerch, locateStart, perchGoal } from '../../../src/skills/nav/astar.ts';
import type { BenchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import { V, Vox } from '../../../src/skills/nav/bench/vox.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { blockQueryOf } from '../../../src/skills/terrain/query.ts';
import { flatGen } from './genworld.ts';
import { runPair, type PairRun, type SimOptions } from './reach-sim.ts';

const GX = 20;
const GZ = 24;
const G = -60; // the feet level on the grass

/** The eave over the fence line: planks over the line only, planks over the line and the columns beside, stairs (bottom / top half). */
type Eave = 'block' | 'wide' | 'stairBottom' | 'stairTop';
const EAVES: Eave[] = ['block', 'wide', 'stairBottom', 'stairTop'];

/** A fence line along z (joined north and south) at GX on the grass, the eave 3 over the fence's block (1.5 over its top). */
function eaveSite(v: Vox, eave: Eave): void {
  for (let z = GZ - 2; z <= GZ + 2; z++) v.set(GX, G, z, V.fenceNS);
  const id = eave === 'stairBottom' ? V.stairBottom : eave === 'stairTop' ? V.stairTop : V.planks;
  const [x0, x1] = eave === 'wide' ? [GX - 1, GX + 2] : [GX, GX];
  v.fill({ x: x0, y: G + 3, z: GZ - 2 }, { x: x1, y: G + 3, z: GZ + 2 }, id);
}

function flatVox(): Vox {
  const v = new Vox(48, 48);
  for (let x = 0; x < 48; x++)
    for (let z = 0; z < 48; z++) {
      v.set(x, -64, z, V.bedrock);
      for (let y = -63; y <= -62; y++) v.set(x, y, z, V.stone);
      v.set(x, -61, z, V.grass);
    }
  return v;
}

describe('Track R7: the body held crouched under an eave (physics)', () => {
  const gw = flatGen();
  for (let z = 10; z <= 14; z++) gw.put(10, -60, z, 'spruce_fence');
  for (let z = 10; z <= 14; z++) gw.put(10, -57, z, 'oak_planks');
  const w = blockQueryOf(gw);
  const top = { x: 10.5, y: -58.5, z: 12.5 };
  it('held low on the top (the standing box meets the eave, the crouched one does not); standing on the grass', () => {
    expect(heldLow(w, top)).toBe(true);
    expect(heldLow(w, { x: 12.5, y: -60, z: 12.5 })).toBe(false);
    // inside a block both boxes meet it: not held low (the crawl pose's case, Track BH)
    expect(heldLow(w, { x: 10.5, y: -57.5, z: 12.5 })).toBe(false);
  });
  it('forward with no key: the sneak speed, the 1.49 box, no stop at the edge; then standing again on the grass', () => {
    let b = { ...initialBody(top, true) };
    const cmd = { forward: 1, strafe: 0, yaw: -90, pitch: 0, jump: false, sneak: false, sprint: false };
    const xs: number[] = [];
    let lowTicks = 0;
    for (let t = 0; t < 30; t++) {
      b = stepBody(b, cmd, w).state;
      xs.push(+b.pos.x.toFixed(3));
      if (b.low) lowTicks++;
      expect(b.sneaking).toBe(false); // (no start_sneaking is sent: the edge rule stays off)
    }
    // the per-tick positions BDS gave (bds-pve, 2026-11-14, `nav-low.test.ts` probe, every corrections count 0): 0.529,
    // 0.575, 0.630, 0.688 ... from 0.5 in the post's block
    [0.529, 0.575, 0.63, 0.688].forEach((x, i) => expect(xs[i]! - 10).toBeCloseTo(x, 2));
    expect(b.pos.y).toBeCloseTo(-60, 6); // off the top, on the grass
    expect(b.low).toBeUndefined();
    expect(lowTicks).toBeGreaterThan(5);
  });
  it('with the sneak key: the edge rule holds the body on the top (0.892)', () => {
    let b = { ...initialBody(top, true) };
    const cmd = { forward: 1, strafe: 0, yaw: -90, pitch: 0, jump: false, sneak: true, sprint: false };
    for (let t = 0; t < 30; t++) b = stepBody(b, cmd, w).state;
    expect(b.pos.x - 10).toBeCloseTo(0.892, 2);
    expect(b.pos.y).toBeCloseTo(-58.5, 6);
  });
  it('no eave: nothing changes (not held low)', () => {
    const og = flatGen();
    og.put(10, -60, 12, 'oak_fence');
    const o = blockQueryOf(og);
    expect(heldLow(o, top)).toBe(false);
    const a = stepBody(initialBody(top, true), { forward: 1, strafe: 0, yaw: -90, pitch: 0, jump: false, sneak: false, sprint: false }, o).state;
    expect(a.low).toBeUndefined();
    expect(PHYSICS.sneakHeight).toBe(1.49);
  });
});

describe('Track R7: the low perch (grid and planner)', () => {
  const world = (eave: string | undefined, states?: Record<string, unknown>) => {
    const w = flatGen();
    w.put(10, -60, 12, 'spruce_fence');
    if (eave) w.put(10, -57, 12, eave, states);
    return w;
  };
  it('a fence with a block 1.5 over its top: no perch, a low perch; a block 2 over it: a perch, no low perch', () => {
    for (const [name, states] of [['oak_planks', {}], ['spruce_stairs', { upside_down_bit: 0 }], ['spruce_stairs', { upside_down_bit: 1 }]] as const) {
      const g = new NavGrid(world(name, states));
      expect(Number.isNaN(g.perch(10, -59, 12)), name).toBe(true);
      expect(g.lowPerch(10, -59, 12), name).toBeCloseTo(-58.5, 9);
    }
    const w = flatGen();
    w.put(10, -60, 12, 'spruce_fence');
    w.put(10, -56, 12, 'oak_planks');
    const g = new NavGrid(w);
    expect(g.perch(10, -59, 12)).toBeCloseTo(-58.5, 9);
    expect(Number.isNaN(g.lowPerch(10, -59, 12)!)).toBe(true);
    // a block 1 over the top: not even the crouched box fits
    const w2 = flatGen();
    w2.put(10, -60, 12, 'spruce_fence');
    w2.put(10, -58, 12, 'oak_planks');
    expect(Number.isNaN(new NavGrid(w2).lowPerch(10, -59, 12)!)).toBe(true);
  });
  const onTop = { x: 10.5, y: -58.5, z: 12.5 };
  it('locateStart: the low perch only with `low` (locatePerch alone, the default, as before)', () => {
    const g = new NavGrid(world('oak_planks'));
    expect(locatePerch(g, onTop)).toBeUndefined();
    expect(locateStart(g, onTop, undefined, false)).toBeUndefined();
    expect(locateStart(g, onTop)).toMatchObject({ x: 10, y: -59, z: 12, perch: true, low: true });
  });
  it('the way off it: a drop down beside it (no jump, no step up)', () => {
    const g = new NavGrid(world('oak_planks'));
    const res = findPath(g, { x: 10, y: -59, z: 12 }, { type: 'block', p: { x: 16, y: -60, z: 12 } }, { startFeet: -58.5 });
    expect(res.status).toBe('found');
    expect(res.path[1]).toMatchObject({ y: -60, move: 'drop' });
  });
  it('no way off it where the crouched box meets something beside it; no step up off it onto a block beside it', () => {
    // a block 1 over the top in every neighbour column (the crouched head meets it while walking off)
    const w = world('oak_planks');
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) w.put(10 + dx, -58, 12 + dz, 'oak_planks');
    const res = findPath(new NavGrid(w), { x: 10, y: -59, z: 12 }, { type: 'block', p: { x: 16, y: -60, z: 12 } }, { startFeet: -58.5 });
    expect(res.status).not.toBe('found');
    expect(res.path.length).toBeLessThanOrEqual(1);
    // a full block beside it (its top 0.5 over the fence's): the step up would lift the crouched head into the eave
    const w2 = world('oak_planks');
    w2.put(11, -59, 12, 'oak_planks');
    w2.put(9, -59, 12, 'oak_planks');
    w2.put(10, -59, 11, 'oak_planks');
    w2.put(10, -59, 13, 'oak_planks');
    const r2 = findPath(new NavGrid(w2), { x: 10, y: -59, z: 12 }, { type: 'block', p: { x: 16, y: -60, z: 12 } }, { startFeet: -58.5 });
    expect(r2.path.some((n, i) => i > 0 && n.feet > -58.5 + 1e-6)).toBe(false);
  });
  it('as a goal: a perch goal never entered (low)', () => {
    const g = new NavGrid(world('oak_planks'));
    expect(perchGoal(g, 10, -59, 12)).toBeUndefined(); // (without `low`: as before R7)
    expect(perchGoal(g, 10, -59, 12, true)).toMatchObject({ enter: false, low: true, on: 'spruce_fence', block: { x: 10, y: -60, z: 12 } });
  });
});

interface Row {
  mode: string;
  config: string;
  case: string;
  k: number;
  reply: string;
  note?: string;
  why?: string;
  ticks: number;
  damage: number;
  end: string;
  fromTop: number;
  plans: number;
  failures: number;
  perch: number;
  low: number;
  dug: number;
  died: boolean;
}
const rows: Row[] = [];
const CONFIGS: [string, SimOptions][] = [
  ['default', {}],
  ['live', { allowBreak: true, allowPlace: false, digPenalty: 500 }],
];
const N = Number(process.env.R7_N ?? 10);

function push(mode: string, config: string, name: string, k: number, r: PairRun, top: { x: number; y: number; z: number }): Row {
  const e = r.endPos;
  const row: Row = {
    mode,
    config,
    case: name,
    k,
    reply: r.reply,
    ...(r.note ? { note: r.note } : {}),
    ...(r.why ? { why: r.why } : {}),
    ticks: r.ticks,
    damage: +r.damage.toFixed(2),
    end: `${e.x},${e.y},${e.z}`,
    fromTop: +Math.hypot(e.x - top.x, e.y - top.y, e.z - top.z).toFixed(2),
    plans: r.plans,
    failures: r.failures,
    perch: r.perchStarts ?? 0,
    low: r.lowStarts ?? 0,
    dug: r.dug,
    died: r.died,
  };
  rows.push(row);
  return row;
}

/** The spots on the top: the centre and two offsets (along the line and across it), a little moved each run. */
const SPOTS: [string, number, number][] = [
  ['centre', 0.5, 0.5],
  ['offset along', 0.5, 0.78],
  ['offset across', 0.62, 0.36],
];

describe('Track R7: a walk that starts on the fence under the eave (the real navigator, the closed loop)', () => {
  for (const [config, o] of CONFIGS) {
    for (const eave of EAVES) {
      const bw = (): BenchWorld => {
        const v = flatVox();
        eaveSite(v, eave);
        return { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: GX, y: G + 1, z: GZ }, goal: { x: GX + 15, y: G, z: GZ }, tag: eave }] };
      };
      const topAt = { x: GX + 0.5, y: G + 1.5, z: GZ + 0.5 };
      it(`${config}: ${eave}: before R7 (no low perch): no standable node, unreachable with no plan`, async () => {
        const w = bw();
        const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, startPos: { x: GX + 0.5, y: G + 1.5, z: GZ + 0.5 }, timeoutTicks: 1200, noLow: true, ...o });
        push('before', config, `start ${eave}`, 0, r, topAt);
        expect(r.reply).toMatch(/^goto: unreachable/);
        expect(r.plans).toBe(0);
      }, 600_000);
      for (const [spot, fx, fz] of SPOTS) {
        it(`${config}: ${eave}: from the top (${spot}): arrived, no damage`, async () => {
          for (let k = 0; k < N; k++) {
            const w = bw();
            const j = N > 1 ? -0.04 + (0.08 * k) / (N - 1) : 0;
            const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, startPos: { x: GX + fx + j, y: G + 1.5, z: GZ + fz - j / 2 }, timeoutTicks: 1200, ...o });
            push('after', config, `start ${eave} ${spot}`, k, r, topAt);
            const tail = r.log.slice(-14).join('\n');
            expect(r.reply, tail).toBe('arrived');
            expect(r.damage, tail).toBe(0);
            expect(r.lowStarts ?? 0, tail).toBeGreaterThanOrEqual(1);
          }
        }, 600_000);
      }
    }
  }
});

describe('Track R7: a walk to the cell over the fence under the eave (a low perch goal)', () => {
  for (const [config, o] of CONFIGS) {
    for (const eave of EAVES) {
      const bw = (): BenchWorld => {
        const v = flatVox();
        eaveSite(v, eave);
        return { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: GX + 15, y: G, z: GZ }, goal: { x: GX, y: G + 1, z: GZ }, tag: eave }] };
      };
      const topAt = { x: GX + 0.5, y: G + 1.5, z: GZ + 0.5 };
      it(`${config}: ${eave}: before R7: unreachable`, async () => {
        const w = bw();
        const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, timeoutTicks: 2400, noLow: true, ...o });
        push('before', config, `goal ${eave}`, 0, r, topAt);
        expect(r.reply).toMatch(/^goto: unreachable/);
      }, 600_000);
      it(`${config}: ${eave}: next to it with the note, no damage`, async () => {
        for (let k = 0; k < N; k++) {
          const w = bw();
          const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, timeoutTicks: 2400, startPos: { x: GX + 15.5, y: G, z: GZ + 0.3 + (0.4 * k) / Math.max(1, N - 1) }, ...o });
          const row = push('after', config, `goal ${eave}`, k, r, topAt);
          const tail = r.log.slice(-14).join('\n');
          expect(r.reply, tail).toBe('arrived');
          expect(r.note ?? '', tail).toMatch(/cannot be stood on \(under 1\.8 of head room/);
          expect(r.damage, tail).toBe(0);
          expect(row.fromTop, tail).toBeLessThan(2.6);
        }
      }, 600_000);
    }
  }
  it('a start 0.5 over the top (the teleport\'s answer called it grounded): it settles onto the top and walks off', async () => {
    for (let k = 0; k < N; k++) {
      const v = flatVox();
      eaveSite(v, 'block');
      const w: BenchWorld = { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: GX, y: G + 1, z: GZ }, goal: { x: GX + 15, y: G, z: GZ }, tag: 'over' }] };
      const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, startPos: { x: GX + 0.5, y: G + 2, z: GZ + 0.5 }, timeoutTicks: 1200 });
      push('after', 'default', 'start block +0.5', k, r, { x: GX + 0.5, y: G + 1.5, z: GZ + 0.5 });
      expect(r.reply, r.log.slice(-14).join('\n')).toBe('arrived');
      expect(r.damage).toBe(0);
    }
  }, 600_000);
});

/** Part 2: the kinds of `block` goal nobody stands in, at (GX, y, GZ) on the grass; `set` builds the site, `y` the goal's level. */
const KINDS: { name: string; y: number; set: (v: Vox) => void }[] = [
  { name: 'inside natural stone (underground)', y: G - 2, set: () => {} },
  { name: 'inside a built block (planks)', y: G, set: (v) => v.set(GX, G, GZ, V.planks) },
  { name: 'inside natural stone (a boulder)', y: G, set: (v) => v.set(GX, G, GZ, V.stone) },
  { name: 'no head room (planks over the cell)', y: G, set: (v) => v.set(GX, G + 1, GZ, V.planks) },
  { name: 'no head room (stone over the cell)', y: G, set: (v) => v.set(GX, G + 1, GZ, V.stone) },
  { name: 'in the air 1 over the floor', y: G + 1, set: () => {} },
  { name: 'in the air 2 over the floor', y: G + 2, set: () => {} },
  { name: 'in the air 5 over the floor', y: G + 5, set: () => {} },
  { name: 'in the air 6 over the floor', y: G + 6, set: () => {} },
  { name: "inside a fence block's own cell", y: G, set: (v) => v.set(GX, G, GZ, V.fence) },
  { name: 'in water', y: G - 1, set: (v) => v.set(GX, G - 1, GZ, V.water) },
  { name: 'in lava', y: G - 1, set: (v) => v.set(GX, G - 1, GZ, V.lava) },
  {
    name: 'a perch with nothing in reach (a fence on a tower 3 high)',
    y: G + 4,
    set: (v) => {
      for (let y = G; y <= G + 2; y++) v.set(GX, y, GZ, V.stone);
      v.set(GX, G + 3, GZ, V.fence);
    },
  },
];
const KIND_MODES = (process.env.R7_KIND_MODES ?? 'before,after').split(',');
const KIND_N = Number(process.env.R7_KIND_N ?? 1);

describe('Track R7: a block goal nobody stands in (the real navigator, the closed loop)', () => {
  for (const mode of KIND_MODES) {
    for (const [config, o] of CONFIGS) {
      for (const kind of KINDS) {
        it(`${mode}: ${config}: ${kind.name}`, async () => {
          for (let k = 0; k < KIND_N; k++) {
            const v = flatVox();
            kind.set(v);
            const w: BenchWorld = { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: GX + 15, y: G, z: GZ }, goal: { x: GX, y: kind.y, z: GZ }, tag: kind.name }] };
            const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, timeoutTicks: 2400, startPos: { x: GX + 15.5, y: G, z: GZ + 0.3 + (0.4 * k) / Math.max(1, KIND_N - 1) }, ...o, ...(mode === 'after' ? { gotoOpts: { beside: true } } : {}) });
            push(mode, config, kind.name, k, r, { x: GX + 0.5, y: kind.y + 0.5, z: GZ + 0.5 });
            expect(r.died).toBe(false);
          }
        }, 600_000);
      }
    }
  }
});

describe('Track R7: (results)', () => {
  it('rows', () => {
    const out = process.env.R7_OUT;
    if (out) writeFileSync(out, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
