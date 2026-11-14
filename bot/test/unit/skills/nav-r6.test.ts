// Track R6 (docs/pathfinding.md "A goal on a top the stand rule has no node for (Track R6)"; decisions/0072-reachability.md
// "R6"): what a goto does with each kind of goal that is no node, and a goal on a perch top (a fence's, a wall's, a
// closed gate's 1.5; a cauldron's inside): walked onto by a step or a jump from a block beside it where there is one,
// else next to it, arrived, with a note saying so. Before R6 such a goal was `not standable` (allowBreak off) or
// unreachable after 28 plans in about 330 ticks (the live settings).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { probePath } from '../../../src/skills/home/reach.ts';
import { findPath, perchGoal } from '../../../src/skills/nav/astar.ts';
import type { BenchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import { V, Vox } from '../../../src/skills/nav/bench/vox.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { flatGen } from './genworld.ts';
import { runPair, type PairRun, type SimOptions } from './reach-sim.ts';

describe('Track R6: perch goals (grid and planner)', () => {
  /** A post on flat grass (made-up geometry), its top at -58.5; `beside` a block west of it. */
  const world = (name: string, beside?: string, states?: Record<string, unknown>) => {
    const w = flatGen();
    w.put(10, -60, 12, name, states);
    if (beside) w.put(9, -60, 12, beside);
    return w;
  };

  it('fences, walls and closed gates: a goal that may be entered; a cauldron, a composter, magma, a hopper: not', () => {
    for (const name of ['oak_fence', 'spruce_fence', 'cobblestone_wall', 'fence_gate']) {
      const pg = perchGoal(new NavGrid(world(name)), 10, -59, 12);
      expect(pg, name).toMatchObject({ enter: true, on: name, block: { x: 10, y: -60, z: 12 } });
      expect(pg!.feet).toBeCloseTo(-58.5, 9);
    }
    // a rim round a hollow (a centred body drops inside), magma (a hazard)
    for (const name of ['cauldron', 'composter', 'magma']) expect(perchGoal(new NavGrid(world(name)), 10, -59, 12)?.enter ?? false, name).toBe(false);
    // the inside of a cauldron: a perch in the cell itself, no move goes into it
    expect(perchGoal(new NavGrid(world('cauldron')), 10, -60, 12)).toMatchObject({ enter: false, block: { x: 10, y: -60, z: 12 } });
    // a node is no perch goal: the cell over a full block, a slab
    expect(perchGoal(new NavGrid(world('stone')), 10, -59, 12)).toBeUndefined();
    expect(perchGoal(new NavGrid(world('smooth_stone_slab')), 10, -60, 12)).toBeUndefined();
    // an open gate: nothing to stand on
    expect(perchGoal(new NavGrid(world('fence_gate', undefined, { open_bit: 1 })), 10, -59, 12)).toBeUndefined();
  });

  const goal = { type: 'block' as const, p: { x: 10, y: -59, z: 12 } };
  it('with a block beside the fence: a step up of 0.5 onto its top, the last move of the path', () => {
    const g = new NavGrid(world('oak_fence', 'oak_planks'));
    const res = findPath(g, { x: 3, y: -60, z: 12 }, goal, { perchGoal: true });
    expect(res.status).toBe('found');
    expect(res.path.at(-1)).toMatchObject({ x: 10, y: -59, z: 12, feet: -58.5, move: 'walk' });
    expect(res.path.at(-2)).toMatchObject({ x: 9, feet: -59 });
  });

  it('with a slab beside it: a jump of 1.0', () => {
    const g = new NavGrid(world('oak_fence', 'smooth_stone_slab'));
    const res = findPath(g, { x: 3, y: -60, z: 12 }, goal, { perchGoal: true });
    expect(res.status).toBe('found');
    expect(res.path.at(-1)).toMatchObject({ x: 10, feet: -58.5, move: 'jump' });
  });

  it('never without the option, never a jump of 1.5 from the ground, never down onto it, never into a perch that is not the goal', () => {
    expect(findPath(new NavGrid(world('oak_fence', 'oak_planks')), { x: 3, y: -60, z: 12 }, goal).status).not.toBe('found');
    expect(findPath(new NavGrid(world('oak_fence')), { x: 3, y: -60, z: 12 }, goal, { perchGoal: true }).status).not.toBe('found');
    // a block 2 high beside it: its top is 0.5 over the fence's, the way onto the fence would be a drop
    const w = world('oak_fence', 'oak_planks');
    w.put(9, -59, 12, 'oak_planks');
    w.put(8, -60, 12, 'oak_planks'); // (a stair up to it)
    expect(findPath(new NavGrid(w), { x: 3, y: -60, z: 12 }, goal, { perchGoal: true }).status).not.toBe('found');
    // another fence with a block beside it is no node of a path to a goal past it
    const w2 = world('oak_fence', 'oak_planks');
    const res = findPath(new NavGrid(w2), { x: 3, y: -60, z: 12 }, { type: 'block', p: { x: 16, y: -60, z: 12 } }, { perchGoal: true });
    expect(res.status).toBe('found');
    expect(res.path.some((n) => n.x === 10 && n.y === -59)).toBe(false);
  });

  it('no head room over the block beside it for the jump: no way onto it', () => {
    const w = world('oak_fence', 'smooth_stone_slab');
    w.put(9, -58, 12, 'stone'); // over the slab, 1.5 over its top: the body standing there fits, the jump up 1.0 does not
    const res = findPath(new NavGrid(w), { x: 3, y: -60, z: 12 }, goal, { perchGoal: true });
    expect(res.status).not.toBe('found');
  });
});

/** The goal shapes (made-up geometry): flat grass, the body 15 blocks west of the goal's column. */
interface GoalCase {
  name: string;
  build: (v: Vox) => void;
  goal: { x: number; y: number; z: number };
  /** After R6: `on` the top, `beside` it (the note), `arrived` (a node, as before), `unreachable`. */
  want: 'on' | 'beside' | 'arrived' | 'unreachable';
  /** The goto's goal when it is not the cell as a `block` goal (a column: `!goto x z`, a waypoint with no height). */
  column?: true;
}
const GX = 20;
const GZ = 24;
const G = -60; // the feet level on the grass
const fenceBeside = (beside: number, top: number = V.fence) => (v: Vox) => {
  v.set(GX, G, GZ, top);
  v.set(GX - 1, G, GZ, beside);
};
const CASES: GoalCase[] = [
  { name: 'inside a solid', build: (v) => v.fill({ x: GX, y: G, z: GZ }, { x: GX, y: G + 1, z: GZ }, V.planks), goal: { x: GX, y: G, z: GZ }, want: 'unreachable' },
  { name: 'in the air', build: () => undefined, goal: { x: GX, y: G + 3, z: GZ }, want: 'unreachable' },
  { name: 'over a fence', build: (v) => v.set(GX, G, GZ, V.fence), goal: { x: GX, y: G + 1, z: GZ }, want: 'beside' },
  { name: 'over a wall', build: (v) => v.set(GX, G, GZ, V.wall), goal: { x: GX, y: G + 1, z: GZ }, want: 'beside' },
  { name: 'over a closed gate', build: (v) => v.set(GX, G, GZ, V.gate), goal: { x: GX, y: G + 1, z: GZ }, want: 'beside' },
  { name: 'in a cauldron', build: (v) => v.set(GX, G, GZ, V.cauldron), goal: { x: GX, y: G, z: GZ }, want: 'beside' },
  { name: "a slab's upper half", build: (v) => v.set(GX, G, GZ, V.slabTop), goal: { x: GX, y: G, z: GZ }, want: 'arrived' },
  { name: 'no head room', build: (v) => v.set(GX, G + 1, GZ, V.planks), goal: { x: GX, y: G, z: GZ }, want: 'unreachable' },
  { name: 'over a fence, a block beside it', build: fenceBeside(V.planks), goal: { x: GX, y: G + 1, z: GZ }, want: 'on' },
  { name: 'over a wall, a block beside it', build: fenceBeside(V.planks, V.wall), goal: { x: GX, y: G + 1, z: GZ }, want: 'on' },
  { name: 'over a closed gate, a block beside it', build: fenceBeside(V.planks, V.gate), goal: { x: GX, y: G + 1, z: GZ }, want: 'on' },
  { name: 'over a fence, a slab beside it', build: fenceBeside(V.slabBottom), goal: { x: GX, y: G + 1, z: GZ }, want: 'on' },
  {
    // the block beside it walled in by glass 3 high: the step exists, no way to it: the plan towards the top finds none
    name: 'over a fence, the block beside it walled in',
    build: (v) => {
      fenceBeside(V.planks)(v);
      for (const [x, z] of [[GX - 2, GZ], [GX - 1, GZ - 1], [GX - 1, GZ + 1]] as const) v.fill({ x, y: G, z }, { x, y: G + 2, z }, V.glass);
    },
    goal: { x: GX, y: G + 1, z: GZ },
    want: 'beside',
  },
  {
    // a fence line joined north and south: the goal over its middle post, next to it from a side
    name: 'over a fence line',
    build: (v) => {
      for (let z = GZ - 3; z <= GZ + 3; z++) v.set(GX, G, z, V.fenceNS);
    },
    goal: { x: GX, y: G + 1, z: GZ },
    want: 'beside',
  },
  {
    // a fence on a tower of planks 3 high: no node next to it, nothing a walk reaches (a player pillars or flies)
    name: 'over a fence on a tower 3 high',
    build: (v) => {
      v.fill({ x: GX, y: G, z: GZ }, { x: GX, y: G + 2, z: GZ }, V.planks);
      v.set(GX, G + 3, GZ, V.fence);
    },
    goal: { x: GX, y: G + 4, z: GZ },
    want: 'unreachable',
  },
  {
    // a post in a deck of planks (the deck's top 0.5 under the fence's), its four cardinal neighbours posts too: no
    // step onto it, the diagonal deck cells beside it are a level over the fence's block (next to the goal's cell)
    name: 'a fence cross in a deck',
    build: (v) => {
      v.fill({ x: GX - 4, y: G, z: GZ - 4 }, { x: GX + 4, y: G, z: GZ + 4 }, V.planks);
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) v.set(GX + dx, G, GZ + dz, V.fence);
    },
    goal: { x: GX, y: G + 1, z: GZ },
    want: 'beside',
  },
  // a column goal (no height) whose top is a fence: the top as the goal
  { name: 'a column over a fence', build: (v) => v.set(GX, G, GZ, V.fence), goal: { x: GX, y: G + 1, z: GZ }, want: 'beside', column: true },
  { name: 'a column over a fence, a block beside it', build: fenceBeside(V.planks), goal: { x: GX, y: G + 1, z: GZ }, want: 'on', column: true },
];

function caseWorld(c: GoalCase): BenchWorld {
  const v = new Vox(48, 48);
  for (let x = 0; x < 48; x++)
    for (let z = 0; z < 48; z++) {
      v.set(x, -64, z, V.bedrock);
      for (let y = -63; y <= -62; y++) v.set(x, y, z, V.stone);
      v.set(x, -61, z, V.grass);
    }
  c.build(v);
  return { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: 5, y: G, z: GZ }, goal: c.goal, tag: c.name }] };
}

interface Row {
  mode: string;
  config: string;
  goal: string;
  k: number;
  reply: string;
  note?: string;
  why?: string;
  ticks: number;
  damage: number;
  end: string;
  endDist: number;
  /** The body's feet from the top's centre at the end (3D). */
  fromTop: number;
  plans: number;
  failures: number;
  dug: number;
  died: boolean;
}
const rows: Row[] = [];
const CONFIGS: [string, SimOptions][] = [
  ['default', {}],
  ['live', { allowBreak: true, allowPlace: false, digPenalty: 500 }],
];
/** Runs a case (R6_N, default 10 for the cases R6 changes; the table's others once). */
const N = Number(process.env.R6_N ?? 10);

/** The top's feet of a goal case (the fence's 1.5, the cauldron's floor), or the goal cell's floor. */
const topFeet = (c: GoalCase): number => (c.name.startsWith('in a cauldron') ? c.goal.y + 0.25 : c.want === 'on' || c.want === 'beside' ? c.goal.y + 0.5 : c.goal.y);

async function run(mode: string, config: string, o: SimOptions, c: GoalCase, k: number): Promise<PairRun> {
  const bw = caseWorld(c);
  // the body's start moved a little each run (never off its cell)
  const r = await runPair(bw, bw.pairs[0]!, new Map(), { speed: 1.25, startPos: { x: 5.5 + 0.03 * (k - 4.5), y: G, z: GZ + 0.5 + 0.02 * (k - 4.5) }, timeoutTicks: 1200, ...(c.column ? { goal: { type: 'xz' as const, x: c.goal.x, z: c.goal.z } } : {}), ...o });
  const e = r.endPos;
  rows.push({
    mode,
    config,
    goal: c.name,
    k,
    reply: r.reply,
    ...(r.note ? { note: r.note } : {}),
    ...(r.why ? { why: r.why } : {}),
    ticks: r.ticks,
    damage: +r.damage.toFixed(2),
    end: `${e.x},${e.y},${e.z}`,
    endDist: r.endDist,
    fromTop: +Math.hypot(e.x - (c.goal.x + 0.5), e.y - topFeet(c), e.z - (c.goal.z + 0.5)).toFixed(2),
    plans: r.plans,
    failures: r.failures,
    dug: r.dug,
    died: r.died,
  });
  return r;
}

describe('Track R6: the goals that are no node (the real navigator, the closed loop)', () => {
  for (const [config, o] of CONFIGS) {
    for (const c of CASES) {
      const changed = c.want === 'on' || c.want === 'beside';
      it(`${config}: ${c.name}: before R6 (perch goals off)`, async () => {
        const r = await run('before', config, { ...o, noPerchGoal: true }, c, 0);
        expect(r.died).toBe(false);
        if (changed) expect(r.reply).toMatch(/^goto: unreachable/);
      }, 600_000);
      it(`${config}: ${c.name}: ${c.want}`, async () => {
        for (let k = 0; k < (changed ? N : 1); k++) {
          const r = await run('after', config, o, c, k);
          const tail = r.log.slice(-12).join('\n');
          expect(r.died).toBe(false);
          expect(r.damage, tail).toBe(0);
          const row = rows.at(-1)!;
          if (c.want === 'unreachable') expect(r.reply, tail).toMatch(/^goto: unreachable/);
          else expect(r.reply, tail).toBe('arrived');
          if (c.want === 'on') {
            expect(r.endPos.y, tail).toBeCloseTo(c.goal.y + 0.5, 3); // standing on the top
            expect(row.fromTop).toBeLessThan(0.45);
            expect(r.note).toBeUndefined();
          }
          if (c.want === 'beside') {
            expect(r.note, tail).toMatch(/^the goal's cell .* cannot be stood on \(no (step or jump leads|move goes) onto it\): stopped [\d.]+ blocks from it$/);
            expect(Math.abs(r.endPos.x - (c.goal.x + 0.5)), tail).toBeLessThan(1.8); // in a column next to it
            expect(Math.abs(r.endPos.z - (c.goal.z + 0.5)), tail).toBeLessThan(1.8);
            expect(row.fromTop).toBeLessThan(2.3);
          }
        }
      }, 600_000);
    }
  }
});

// A column goal whose top is a fence and which has a node lower down: a room of 3 x 3 under a roof of planks 2 over
// the grass (open on every side), a fence on the roof over the goal's column. The column's floor is a node, so the
// plain column goal arrives there; R6 must leave it so (before the coordinator's fix it was sent onto the roof's fence
// and ended unreachable).
const ROOF_CASE: GoalCase = {
  name: 'a column: a fence on a roof over a floor',
  build: (v) => {
    v.fill({ x: GX - 1, y: G + 2, z: GZ - 1 }, { x: GX + 1, y: G + 2, z: GZ + 1 }, V.planks);
    v.set(GX, G + 3, GZ, V.fence);
  },
  goal: { x: GX, y: G + 4, z: GZ },
  want: 'arrived',
  column: true,
};

describe('Track R6: a column goal with a node under its fence top is left as it was', () => {
  for (const [config, o] of CONFIGS) {
    it(`${config}: ${ROOF_CASE.name}: before and after arrive at the floor, the same ticks and end`, async () => {
      const seen: string[] = [];
      const want: string[] = [];
      for (let k = 0; k < N; k++) {
        const b = await run('before', config, { ...o, noPerchGoal: true }, ROOF_CASE, k);
        const a = await run('after', config, o, ROOF_CASE, k);
        const tail = a.log.slice(-12).join('\n');
        expect(b.reply, b.log.slice(-12).join('\n')).toBe('arrived');
        expect(a.reply, tail).toBe('arrived');
        expect(a.note, tail).toBeUndefined();
        expect(a.damage).toBe(0);
        expect(Math.floor(a.endPos.x)).toBe(GX);
        expect(Math.floor(a.endPos.z)).toBe(GZ);
        expect(Math.floor(a.endPos.y + 1e-6)).toBe(G); // on the floor under the roof
        // the end, the plans and the path the same; the closed loop's finish tick moves by 1 from run to run (the
        // control: the before run twice, `before2`, moves the same way), so the ticks are asked within 1
        const b2 = await run('before2', config, { ...o, noPerchGoal: true }, ROOF_CASE, k);
        expect(Math.abs(a.ticks - b.ticks), `${k}: ${a.ticks} t after, ${b.ticks} before, ${b2.ticks} before again`).toBeLessThanOrEqual(1);
        seen.push(`${k}: ${a.plans} plans, end ${a.endPos.x},${a.endPos.y},${a.endPos.z}`);
        want.push(`${k}: ${b.plans} plans, end ${b.endPos.x},${b.endPos.y},${b.endPos.z}`);
      }
      expect(seen).toEqual(want);
    }, 600_000);
  }
});

describe('Track R6: the probes from the body (home/reach.ts probePath `body`)', () => {
  const w = flatGen();
  for (let z = 8; z <= 16; z++) w.put(10, -60, z, 'oak_fence');
  const nav = { grid: new NavGrid(w), planOptions: () => ({}) };
  const onPost = { x: 10.5, y: -58.5, z: 12.5 };
  const goal = { type: 'near' as const, p: { x: 20.5, y: -60, z: 12.5 }, r: 1 };
  it('a cell only considered (the default: a landing cell, home): a fence top is no start, as before', async () => {
    expect(await probePath(nav, goal, onPost)).toBeUndefined();
  });
  it("the body's own feet (`body`: the mine's probes, the guard's): from the perch", async () => {
    const r = await probePath(nav, goal, onPost, { body: true });
    expect(r?.status).toBe('found');
    expect(r!.path[0]).toMatchObject({ x: 10, y: -59, feet: -58.5 });
  });
  it('a body on the ground: the same start either way', async () => {
    const a = await probePath(nav, goal, { x: 5.5, y: -60, z: 12.5 });
    const b = await probePath(nav, goal, { x: 5.5, y: -60, z: 12.5 }, { body: true });
    expect(b!.path).toEqual(a!.path);
  });
});

describe('Track R6: a start inside a bowl (an empty cauldron, a composter): the rim is jumped', () => {
  for (const [name, id] of [['cauldron', V.cauldron], ['composter', V.composter]] as const) {
    it(`${name}: the walk out arrives from its centre and off it`, async () => {
      const v = new Vox(48, 48);
      for (let x = 0; x < 48; x++)
        for (let z = 0; z < 48; z++) {
          v.set(x, -64, z, V.bedrock);
          for (let y = -63; y <= -62; y++) v.set(x, y, z, V.stone);
          v.set(x, -61, z, V.grass);
        }
      v.set(GX, G, GZ, id);
      const bw: BenchWorld = { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: GX, y: G, z: GZ }, goal: { x: GX + 15, y: G, z: GZ }, tag: name }] };
      // the floor inside (NavGrid.perch of the bowl's own cell: the cauldron's 0.3125, the composter's 0.125)
      const fw = flatGen();
      fw.put(10, -60, 12, name);
      const floor = new NavGrid(fw).perch(10, -60, 12)! + 60;
      for (let k = 0; k < N; k++) {
        // the centre and offsets up to 0.25 along x and z (inside the rim: 0.125 to 0.875 less the half width)
        const ox = k === 0 ? 0 : 0.25 * Math.cos((k * 2 * Math.PI) / Math.max(1, N - 1));
        const oz = k === 0 ? 0 : 0.25 * Math.sin((k * 2 * Math.PI) / Math.max(1, N - 1));
        const r = await runPair(bw, bw.pairs[0]!, new Map(), { speed: 1.25, startPos: { x: GX + 0.5 + ox, y: G + floor, z: GZ + 0.5 + oz }, timeoutTicks: 1200 });
        const tail = r.log.slice(-12).join('\n');
        rows.push({ mode: 'bowl', config: 'default', goal: `start in a ${name}`, k, reply: r.reply, ...(r.why ? { why: r.why } : {}), ticks: r.ticks, damage: +r.damage.toFixed(2), end: `${r.endPos.x},${r.endPos.y},${r.endPos.z}`, endDist: r.endDist, fromTop: 0, plans: r.plans, failures: r.failures, dug: r.dug, died: r.died });
        expect(r.reply, tail).toBe('arrived');
        expect(r.damage).toBe(0);
        expect(r.failures, tail).toBe(0);
      }
    }, 600_000);
  }
});

describe('Track R6: onto a fence at the edge of a pit (a slip off its far side is a 4.5-block fall)', () => {
  const c: GoalCase = {
    name: 'over a fence at a pit, a block beside it',
    build: (v) => {
      fenceBeside(V.planks)(v);
      v.fill({ x: GX + 1, y: -63, z: GZ - 3 }, { x: GX + 4, y: -61, z: GZ + 3 }, V.air);
    },
    goal: { x: GX, y: G + 1, z: GZ },
    want: 'on',
  };
  it('the step onto it: on the top, nothing over its edge', async () => {
    for (let k = 0; k < N; k++) {
      const r = await run('after', 'live', CONFIGS[1]![1], c, k);
      const tail = r.log.slice(-12).join('\n');
      expect(r.reply, tail).toBe('arrived');
      expect(r.damage, tail).toBe(0);
      expect(r.endPos.y).toBeCloseTo(G + 1.5, 3);
    }
  }, 600_000);
  it('(results)', () => {
    const out = process.env.R6_OUT;
    if (out) writeFileSync(out, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
