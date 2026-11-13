// Track R5 (docs/pathfinding.md "A walk starts from wherever the body stands (Track R5)"; decisions/0072-reachability.md
// "R5"): a body resting on a top the stand rule has no node for (a fence's, a wall's, a closed gate's 1.5; a rim whose
// top does not cover the centre) gets a start: the perch (astar `locatePerch`), from which only walks, jumps, drops and
// long drops leave. Before R5 such a goto failed three times in two seconds with `no standable node` and ended
// `unreachable` with no plan (the Realm, 2026-11-13: a flight home ended on a fence's top 20 blocks from its goal).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findPath, locateNode, locatePerch, locateStart } from '../../../src/skills/nav/astar.ts';
import type { BenchPair, BenchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import { V, Vox } from '../../../src/skills/nav/bench/vox.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { fallDamage } from '../../../src/skills/fall/damage.ts';
import { flatGen } from './genworld.ts';
import { runPair, type PairRun, type SimOptions } from './reach-sim.ts';

describe('Track R5: the perch (grid)', () => {
  /** A fence line along z on flat grass (made-up geometry), its posts' tops at -58.5. */
  const fenceWorld = (name = 'oak_fence') => {
    const w = flatGen();
    for (let z = 8; z <= 16; z++) w.put(10, -60, z, name);
    return w;
  };

  it('a body on a fence top over open ground has no node (before) and a perch (now), with a path off it', () => {
    const g = new NavGrid(fenceWorld());
    for (const pos of [
      { x: 10.5, y: -58.5, z: 12.5 }, // on a post
      { x: 10.5, y: -58.5, z: 13.0 }, // on the rail between two posts
      { x: 10.46, y: -58.5, z: 12.3 }, // the Realm's place on its post
      { x: 10.915, y: -58.5, z: 12.5 }, // at the post's edge (0.01 over it)
      { x: 10.5, y: -58.5, z: 16.5 }, // the line's end
    ]) {
      expect(locateNode(g, pos), JSON.stringify(pos)).toBeUndefined();
      const p = locatePerch(g, pos);
      expect(p, JSON.stringify(pos)).toBeDefined();
      expect(p!.perch).toBe(true);
      expect(p!.feet).toBeCloseTo(-58.5, 9);
      expect(p!.x).toBe(10);
      const res = findPath(g, p!, { type: 'block', p: { x: 30, y: -60, z: 12 } }, { startFeet: p!.feet });
      expect(res.status, JSON.stringify(pos)).toBe('found');
      expect(res.path[0]).toMatchObject({ x: 10, y: -59, feet: -58.5, move: 'start' });
      // off the top by a 1.5 drop beside the fence (never along it: the next post is no floor)
      expect(res.path[1]!.feet).toBe(-60);
      expect(res.path[1]!.x).not.toBe(10);
    }
  });

  it('without startFeet (or with a feet the cell does not give) the search has no start, as before', () => {
    const g = new NavGrid(fenceWorld());
    const start = { x: 10, y: -59, z: 12 };
    expect(findPath(g, start, { type: 'block', p: { x: 30, y: -60, z: 12 } }).path).toEqual([]);
    expect(findPath(g, start, { type: 'block', p: { x: 30, y: -60, z: 12 } }, { startFeet: -58.9 }).path).toEqual([]);
  });

  it('a body over open air beside the fence, not on it, has no perch; one high above it neither', () => {
    const g = new NavGrid(fenceWorld());
    expect(locatePerch(g, { x: 11.5, y: -58.5, z: 12.5 })).toBeUndefined(); // the footprint misses the post
    expect(locatePerch(g, { x: 10.5, y: -58.3, z: 12.5 })).toBeUndefined(); // 0.2 over the top: in the air
  });

  it('a body on the post where a block beside it stands level with the fence base still uses that node (unchanged)', () => {
    const w = fenceWorld();
    w.put(11, -60, 12, 'stone'); // the neighbour's floor 0.5 under the fence's top
    const g = new NavGrid(w);
    const n = locateStart(g, { x: 10.96, y: -58.5, z: 12.5 });
    expect(n).toMatchObject({ x: 11, y: -59, feet: -59 });
    expect(n!.perch).toBeUndefined();
  });

  it('the perch is never a node the planner walks into', () => {
    const g = new NavGrid(fenceWorld());
    const res = findPath(g, { x: 5, y: -60, z: 12 }, { type: 'block', p: { x: 10, y: -59, z: 12 } });
    expect(res.status).not.toBe('found');
    expect(res.path.some((n) => n.x === 10 && n.y === -59)).toBe(false);
  });
});

/** Every shape the body can rest on gets a start: a regular node or a perch (made-up geometry, flat stone round it). */
describe('Track R5: the shapes', () => {
  const cases: [string, Record<string, unknown>?][] = [
    ['oak_fence'],
    ['spruce_fence'],
    ['nether_brick_fence'],
    ['cobblestone_wall'],
    ['cobblestone_wall', { wall_connection_type_north: 'tall', wall_connection_type_south: 'tall', wall_post_bit: 0 }],
    ['mud_brick_wall', { wall_connection_type_east: 'short', wall_post_bit: 1 }],
    ['fence_gate'],
    ['spruce_fence_gate', { 'minecraft:cardinal_direction': 'east' }],
    ['cauldron'],
    ['composter'],
    ['composter', { composter_fill_level: 8 }],
    ['magma'],
    ['hopper'],
    ['glass_pane'],
    ['iron_bars'],
    ['chest'],
    ['oak_stairs'],
    ['smooth_stone_slab'],
    ['bed'],
    ['anvil'],
    ['lantern'],
    ['end_rod'],
    ['lightning_rod'],
    ['iron_chain'],
    ['pointed_dripstone'],
    ['bell'],
    ['brewing_stand'],
    ['grindstone'],
    ['stonecutter_block'],
    ['lectern'],
    ['enchanting_table'],
    ['daylight_detector'],
    ['flower_pot'],
    ['cake'],
    ['campfire'],
    ['cactus'],
    ['soul_sand'],
    ['farmland'],
    ['snow_layer', { height: 3 }],
    ['white_carpet'],
    ['moss_carpet'],
    ['scaffolding'],
    ['honey_block'],
    ['mud'],
    ['decorated_pot'],
    ['candle'],
    ['sea_pickle'],
    ['dragon_egg'],
    ['conduit'],
    ['piston_arm_collision'],
    ['trapdoor'],
    ['iron_trapdoor'],
    ['ladder'],
  ];
  const rows: { block: string; top: number; at: string; before: string; now: string }[] = [];
  for (const [name, states] of cases) {
    const label = states ? `${name} ${JSON.stringify(states)}` : name;
    it(`${label}: a body resting on it gets a start`, () => {
      const w = flatGen();
      let info;
      try {
        w.put(10, -60, 12, name, states);
        info = w.blockAt(10, -60, 12)!;
      } catch {
        rows.push({ block: label, top: Number.NaN, at: '-', before: 'not in the data', now: 'not in the data' });
        return;
      }
      const g = new NavGrid(w);
      const c = g.cls(10, -60, 12)!;
      if (!c.boxes.length || c.liquid || c.top > 1.5) {
        rows.push({ block: label, top: c.top, at: '-', before: 'no top to rest on', now: 'no top to rest on' });
        return;
      }
      // the body's centre over each point of the top (the boxes' tops), the highest box under its footprint
      for (const [ox, oz] of [
        [0.5, 0.5],
        [0.2, 0.5],
        [0.8, 0.5],
        [0.5, 0.15],
        [0.5, 0.85],
      ] as const) {
        const pos = { x: 10 + ox, y: 0, z: 12 + oz };
        // what the body rests on there: the highest box top under its 0.6 footprint
        let top = -Infinity;
        for (const b of info.boxes) if (b[0] < ox + 0.3 && b[3] > ox - 0.3 && b[2] < oz + 0.3 && b[5] > oz - 0.3) top = Math.max(top, b[4]);
        if (!Number.isFinite(top)) continue;
        pos.y = -60 + top;
        const before = locateNode(g, pos);
        const now = locateStart(g, pos);
        const word = (n: typeof now) => (n ? `${n.perch ? 'perch' : 'node'} ${n.x},${n.y},${n.z} feet ${+n.feet.toFixed(4)}` : 'none');
        rows.push({ block: label, top: +top.toFixed(4), at: `${ox},${oz}`, before: word(before), now: word(now) });
        if (name === 'scaffolding' || name === 'ladder') continue; // their own rules (decision 0051, climb nodes)
        expect(now, `${name} at ${ox},${oz} feet ${pos.y}`).toBeDefined();
        if (before) expect(now).toEqual(before); // a regular node stays the start
        // and the walk leaves it towards a goal on the floor 8 blocks off
        const res = findPath(g, now!, { type: 'block', p: { x: 18, y: -60, z: 12 } }, now!.perch ? { startFeet: now!.feet } : {});
        expect(res.status, `${name} at ${ox},${oz}`).toBe('found');
      }
    });
  }
  it('(the table)', () => {
    const out = process.env.R5_SHAPES_OUT;
    if (out) writeFileSync(out, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

/** The closed loop: a fence line on flat grass, the goal 20 blocks off (made-up geometry). */
function fenceWorld(opts: { tower?: number; steps?: boolean } = {}): BenchWorld {
  const v = new Vox(48, 48);
  const t = opts.tower ?? 0;
  for (let x = 0; x < 48; x++)
    for (let z = 0; z < 48; z++) {
      v.set(x, -64, z, V.bedrock);
      for (let y = -63; y <= -62; y++) v.set(x, y, z, V.stone);
      v.set(x, -61, z, V.grass);
    }
  // a wall of planks `t` high under the fence (a built block: never dug), the fence line on top along z
  for (let z = 8; z <= 16; z++) {
    for (let k = 0; k < t; k++) v.set(10, -60 + k, z, V.planks);
    v.set(10, -60 + t, z, V.fenceNS);
  }
  // a stair of planks down from beside the fence's top (the harmless way), when asked
  if (opts.steps) for (let k = 0; k < t; k++) for (let y = -60; y < -60 + t - k; y++) v.set(11 + k, y, 12, V.planks);
  return { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: 10, y: -59 + t, z: 12 }, goal: { x: 30, y: -60, z: 12 }, tag: 'fence' }] };
}

interface Row {
  mode: string;
  pos: string;
  reply: string;
  ticks: number;
  damage: number;
  plans: number;
  failures: number;
  died: boolean;
  perch: boolean;
}
const rows: Row[] = [];
const fromPerch = (r: PairRun): boolean => r.log.some((l) => l.includes('starting from a perch'));
async function run(mode: string, bw: BenchWorld, pair: BenchPair, pos: { x: number; y: number; z: number }, o: SimOptions = {}): Promise<PairRun> {
  const r = await runPair(bw, pair, new Map(), { speed: 1.25, startPos: pos, ...o });
  rows.push({ mode, pos: `${pos.x},${pos.y},${pos.z}`, reply: r.reply, ticks: r.ticks, damage: +r.damage.toFixed(2), plans: r.plans, failures: r.failures, died: r.died, perch: fromPerch(r) });
  return r;
}

/** Runs a case a test (R5_N, default 10). */
const N = Number(process.env.R5_N ?? 10);
/** Run k's offset (blocks) along one axis: -0.08 to 0.08 in nine steps, never off the top it is meant to be on. */
const jitter = (k: number, span = 0.08): number => (N > 1 ? -span + (2 * span * k) / (N - 1) : 0);

describe('Track R5: the closed loop (the real navigator, a fence line on flat grass, the goal 20 blocks off)', () => {
  const bw = fenceWorld();
  const pair = bw.pairs[0]!;
  const TOP = -58.5;
  const places: [string, (k: number) => { x: number; y: number; z: number }][] = [
    ['post', (k) => ({ x: 10.5 + jitter(k), y: TOP, z: 12.5 + jitter(N - 1 - k) })],
    ['rail', (k) => ({ x: 10.5 + jitter(k), y: TOP, z: 13.0 })],
    ['realm', (k) => ({ x: 10.46, y: TOP, z: 12.3 + jitter(k) })],
    ['edge', (k) => ({ x: 10.915 - 0.1 * (k / Math.max(1, N - 1)), y: TOP, z: 12.5 + jitter(k) })],
    ['end', (k) => ({ x: 10.5 + jitter(k), y: TOP, z: 16.5 })],
  ];

  it('before R5: no standable node, three failures, unreachable with no plan', async () => {
    const r = await run('before', bw, pair, places[2]![1](0), { noPerch: true, navSettleTicks: 0 });
    expect(r.reply).toBe('goto: unreachable');
    expect(r.plans).toBe(0);
    expect(r.failures).toBe(3);
    expect(r.why).toMatch(/^no standable node at/);
  }, 120_000);

  it('the control: from the grass beside the fence', async () => {
    for (let k = 0; k < N; k++) {
      const r = await run('ground', bw, pair, { x: 11.5 + jitter(k), y: -60, z: 12.5 });
      expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
    }
  }, 600_000);

  for (const [name, at] of places) {
    it(`on the fence (${name}): the walk starts from the perch and arrives, the 1.5 drop no damage`, async () => {
      for (let k = 0; k < N; k++) {
        const r = await run(name, bw, pair, at(k));
        expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
        expect(fromPerch(r), r.log.slice(0, 10).join('\n')).toBe(true);
        expect(r.damage).toBe(0);
        expect(r.failures).toBe(0);
      }
    }, 600_000);
  }

  it('just landed: the goto is asked while the body still falls onto the post; it waits, then starts from the perch', async () => {
    for (let k = 0; k < N; k++) {
      const r = await run('landing', bw, pair, { x: 10.5 + jitter(k), y: TOP + 0.5 + k * 0.1, z: 12.5 }, { settleTicks: 0 });
      expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
      expect(r.failures).toBe(0);
      expect(r.damage).toBe(0);
      expect(r.log.some((l) => l.includes('while the body is in the air'))).toBe(true);
    }
  }, 600_000);

  it('just landed, before R5 (no wait, no perch): unreachable', async () => {
    const r = await run('landing-before', bw, pair, { x: 10.5, y: TOP + 1, z: 12.5 }, { settleTicks: 0, noPerch: true, navSettleTicks: 0 });
    expect(r.reply).toBe('goto: unreachable');
    expect(r.plans).toBe(0);
  }, 120_000);
});

/** The zombie the "server" brings near at tick `from` and takes away at tick `to` (as nav-r4.test.ts). */
function zombie(from: number, to: number): SimOptions['onTick'] {
  return (t, src) => {
    if (t === from) src.emit('add_entity', { unique_id: -77n, runtime_id: 77n, entity_type: 'minecraft:zombie', position: { x: 10.5, y: -60, z: 24.5 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0 });
    if (t === to) src.emit('remove_entity', { entity_id_self: -77n });
  };
}

describe('Track R5: the drop off a high perch (a fence on a wall of planks 4 high: 5.5 down to the grass)', () => {
  const FALL = fallDamage(5.5, 'grass_block');
  it('with a stair beside the top, the walk takes the stair: no damage', async () => {
    const bw = fenceWorld({ tower: 4, steps: true });
    for (let k = 0; k < N; k++) {
      const r = await run('stair', bw, bw.pairs[0]!, { x: 10.5 + jitter(k), y: -54.5, z: 12.5 });
      expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
      expect(fromPerch(r)).toBe(true);
      expect(r.damage).toBe(0);
    }
  }, 600_000);

  it('with no way down but the drop, it is taken under the fall rules: its damage only', async () => {
    const bw = fenceWorld({ tower: 4 });
    for (let k = 0; k < N; k++) {
      const r = await run('drop', bw, bw.pairs[0]!, { x: 10.5 + jitter(k), y: -54.5, z: 12.5 });
      expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
      expect(r.damage).toBeCloseTo(FALL, 5);
    }
  }, 600_000);

  it('the same drop with a zombie 12 blocks off for 60 ticks: Track R4 holds, then the drop, its damage only', async () => {
    const bw = fenceWorld({ tower: 4 });
    for (let k = 0; k < N; k++) {
      const r = await run('drop-hostile', bw, bw.pairs[0]!, { x: 10.5 + jitter(k), y: -54.5, z: 12.5 }, { onTick: zombie(0, 60 + 10 * k) });
      expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
      expect(r.log.some((l) => l.includes('holding up to'))).toBe(true);
      expect(r.damage).toBeCloseTo(FALL, 5);
    }
  }, 600_000);

  it('the same drop with the falls that hurt closed (health under the margin): unreachable, not taken', async () => {
    const bw = fenceWorld({ tower: 4 });
    const r = await run('drop-closed', bw, bw.pairs[0]!, { x: 10.5, y: -54.5, z: 12.5 }, { health: 8 });
    expect(r.reply).toMatch(/^goto: unreachable \(rule falls/);
    expect(r.damage).toBe(0);
    expect(r.plans).toBeGreaterThan(0);
  }, 120_000);

  it('(results)', () => {
    const out = process.env.R5_OUT;
    if (out) writeFileSync(out, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
