// Stairs and partial blocks (docs/pathfinding.md "Stairs and partial blocks"): the classifier
// (stairs per direction, upside down, corners, the 1.26.60 `minecraft:corner` runtime ids, slabs,
// snow layers, carpets, farmland, dirt paths), the planner's stairs walks, `locateNode` on fractional
// feet heights, closed-loop staircases without a jump, and the "unreachable without a segment" line.
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../../src/skills/index.ts';
import { DEFAULT_COSTS, findPath, locateNode, NavGrid, type PathNode } from '../../../src/skills/nav/index.ts';
import { classify, halfTop } from '../../../src/skills/terrain/classify.ts';
import { blockInfoOf, resolveNewerState, stairBoxes, STAIRS_UP } from '../../../src/skills/terrain/shapes.ts';
import { blockHash } from '../../../src/world/registry.ts';
import type { BlockInfo, Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const cls = (name: string, states?: Record<string, unknown>) => classify(blockInfoOf(name, states));
const moves = (p: PathNode[]) => p.map((n) => n.move);
const W = DEFAULT_COSTS.walk;

/** The runtime id BDS 1.26.60 sends for a stairs state (hash with `minecraft:corner`). */
function stairsRid(name: string, dir: number, upsideDown = false, corner = 'none'): number {
  return blockHash(name, {
    'minecraft:corner': { type: 'string', value: corner },
    upside_down_bit: { type: 'byte', value: upsideDown ? 1 : 0 },
    weirdo_direction: { type: 'int', value: dir },
  });
}

/** What the world registry returns for a runtime id it cannot resolve. */
function unknownInfo(rid: number): BlockInfo {
  return { name: 'unknown', stateId: -1, states: { runtime_id: rid }, hardness: -1, solid: true, boxes: [[0, 0, 0, 1, 1, 1]] };
}

describe('classifier: stairs and partial blocks', () => {
  it('stairs: top 1, a floor; the low half is 0.5 on the side away from weirdo_direction', () => {
    for (let dir = 0; dir < 4; dir++) {
      const c = cls('oak_stairs', { weirdo_direction: dir });
      const [ux, uz] = STAIRS_UP[dir]!;
      expect(c.top).toBe(1);
      expect(c.floor).toBe(true);
      expect(halfTop(c, ux, uz), `dir ${dir} high half`).toBe(1);
      expect(halfTop(c, -ux, -uz), `dir ${dir} low half`).toBe(0.5);
      // the two sides: both halves meet them
      expect(halfTop(c, uz, ux)).toBe(1);
      expect(halfTop(c, -uz, -ux)).toBe(1);
      // the generated shape equals minecraft-data's
      expect(stairBoxes({ weirdo_direction: dir, upside_down_bit: 0 })).toEqual(c.boxes);
    }
  });

  it('upside-down stairs are a full-height floor with a 0.5 overhang', () => {
    const c = cls('oak_stairs', { weirdo_direction: 2, upside_down_bit: 1 });
    expect(c.top).toBe(1);
    expect(c.floor).toBe(true);
    for (const [dx, dz] of STAIRS_UP) expect(halfTop(c, dx, dz)).toBe(1);
    expect(c.boxes.some((b) => b[1] === 0.5 && b[4] === 1 && b[0] === 0 && b[3] === 1 && b[2] === 0 && b[5] === 1)).toBe(true);
    expect(stairBoxes({ weirdo_direction: 2, upside_down_bit: 1 })).toEqual(c.boxes);
  });

  it('corner shapes (Java StairBlock quarters): outer = one high quarter, inner = three', () => {
    const top = (boxes: readonly (readonly number[])[], qx: number, qz: number) =>
      Math.max(0, ...boxes.filter((b) => b[0]! < qx + 0.25 && b[3]! > qx + 0.25 && b[2]! < qz + 0.25 && b[5]! > qz + 0.25).map((b) => b[4]!));
    const quarters = (corner: string, dir = 0) => {
      const b = stairBoxes({ weirdo_direction: dir, upside_down_bit: 0, 'minecraft:corner': corner });
      return [top(b, 0, 0), top(b, 0.5, 0), top(b, 0, 0.5), top(b, 0.5, 0.5)]; // NW NE SW SE
    };
    // weirdo_direction 0 = high half east (facing east)
    expect(quarters('none')).toEqual([0.5, 1, 0.5, 1]);
    expect(quarters('outer_left')).toEqual([0.5, 1, 0.5, 0.5]); // east + counter-clockwise (north)
    expect(quarters('outer_right')).toEqual([0.5, 0.5, 0.5, 1]);
    expect(quarters('inner_left')).toEqual([1, 1, 0.5, 1]);
    expect(quarters('inner_right')).toEqual([0.5, 1, 1, 1]);
    // weirdo_direction 2 = facing south
    expect(quarters('none', 2)).toEqual([0.5, 0.5, 1, 1]);
    expect(quarters('outer_left', 2)).toEqual([0.5, 0.5, 0.5, 1]); // south + east
  });

  it('resolves the 1.26.60 runtime ids of stairs (with minecraft:corner) the registry reports as unknown', () => {
    // measured on BDS 1.26.60.6: oak_stairs weirdo_direction 0..3, upside_down_bit 0, corner none
    expect([0, 1, 2, 3].map((d) => stairsRid('oak_stairs', d))).toEqual([-122484237, -61009414, 465409, 61940232]);
    expect(stairsRid('oak_stairs', 2, true)).toBe(-852640284);
    const info = resolveNewerState(unknownInfo(465409))!;
    expect(info.name).toBe('oak_stairs');
    expect(info.states).toMatchObject({ weirdo_direction: 2, 'minecraft:corner': 'none' });
    const c = classify(unknownInfo(465409));
    expect(c.unknown).toBe(false);
    expect(c.name).toBe('oak_stairs');
    expect(c.boxes).toEqual(cls('oak_stairs', { weirdo_direction: 2 }).boxes);
    const outer = classify(unknownInfo(stairsRid('stone_brick_stairs', 0, false, 'outer_right')));
    expect(outer.name).toBe('stone_brick_stairs');
    expect(outer.boxes).toEqual(stairBoxes({ weirdo_direction: 0, upside_down_bit: 0, 'minecraft:corner': 'outer_right' }));
    // a runtime id nobody knows stays a 1.5-high obstacle
    const other = classify(unknownInfo(12345));
    expect(other.unknown).toBe(true);
    expect(other.top).toBe(1.5);
    expect(other.floor).toBe(false);
  });

  it('slabs, carpets, farmland, dirt paths and snow layers (the height state)', () => {
    expect([cls('smooth_stone_slab').top, cls('smooth_stone_slab').floor]).toEqual([0.5, true]);
    expect(cls('oak_slab', { 'minecraft:vertical_half': 'top' }).top).toBe(1);
    expect([cls('white_carpet').top, cls('moss_carpet').top]).toEqual([0.0625, 0.0625]);
    expect([cls('farmland').top, cls('grass_path').top]).toEqual([0.9375, 0.9375]);
    // snow layers: height 0 (one layer) has no collision (measured: the feet stay at the block's base)
    const one = cls('snow_layer', { height: 0 });
    expect([one.boxes.length, one.floor]).toEqual([0, false]);
    // two and more layers are a floor: height n -> n / 8 (measured: 1 -> 0.125, 3 -> 0.375)
    for (const h of [1, 3, 7]) {
      const c = cls('snow_layer', { height: h });
      expect(c.top).toBe(h / 8);
      expect(c.floor).toBe(true);
    }
  });
});

/** A staircase of 6 oak stairs along +z (weirdo_direction 2: high half south), stone under each, a landing on top. */
function staircase(dir = 2, opts: { unknown?: boolean } = {}): { gen: GenWorld; world: ReturnType<typeof fakeWorld> } {
  const gen = flatGen();
  for (let i = 0; i < 6; i++) {
    if (i > 0) gen.fill({ x: -1, y: -60, z: 3 + i }, { x: 1, y: -61 + i, z: 3 + i }, 'stone');
    gen.fill({ x: -1, y: -60 + i, z: 3 + i }, { x: 1, y: -60 + i, z: 3 + i }, 'oak_stairs', { weirdo_direction: dir });
  }
  gen.fill({ x: -1, y: -60, z: 9 }, { x: 1, y: -55, z: 12 }, 'stone'); // landing, feet -54
  const world = fakeWorld(gen);
  if (opts.unknown) {
    // 1.26.60: the stairs arrive as runtime ids the registry does not know
    const stairState = blockInfoOf('oak_stairs', { weirdo_direction: dir }).stateId;
    const rid = stairsRid('oak_stairs', dir);
    world.chunks.stateIdAt = (x: number, y: number, z: number) => {
      const s = gen.blockAt(x, y, z)?.stateId;
      return s === stairState ? -1 : s;
    };
    world.chunks.runtimeIdAt = () => rid;
    const known = world.registry.blockInfo;
    world.registry.blockInfo = (stateId: number, runtimeId?: number) => (stateId < 0 ? unknownInfo(runtimeId ?? 0) : known(stateId));
  }
  return { gen, world };
}

describe('planner: stairs walks', () => {
  const plan = (gen: GenWorld, from: [number, number, number], to: [number, number, number]) =>
    findPath(new NavGrid(gen), { x: from[0], y: from[1], z: from[2] }, { type: 'block', p: { x: to[0], y: to[1], z: to[2] } });

  it('walks a staircase up and down (no jump, no drop), a stairs step costs walk + stairs', () => {
    const { gen } = staircase();
    const up = plan(gen, [0, -60, 0], [0, -54, 10]);
    expect(up.status).toBe('found');
    expect(moves(up.path)).not.toContain('jump');
    expect(moves(up.path)).not.toContain('drop');
    expect(up.path.map((n) => n.feet).filter((f, i, a) => i > 0 && f > a[i - 1]!)).toEqual([-59, -58, -57, -56, -55, -54]);
    const step = up.path.find((n) => n.feet === -58)!;
    expect(step.move).toBe('walk');
    expect(step.cost).toBeCloseTo(W + DEFAULT_COSTS.stairs, 6);
    const down = plan(gen, [0, -54, 10], [0, -60, 0]);
    expect(down.status).toBe('found');
    expect(moves(down.path)).not.toContain('jump');
    expect(moves(down.path)).not.toContain('drop');
  });

  it('stairs met from the high side or from the side are jumps; upside-down stairs are jumps', () => {
    const away = staircase(3).gen; // weirdo_direction 3: high half north, facing the walker coming from -z
    const r = plan(away, [0, -60, 0], [0, -54, 10]);
    expect(r.status).toBe('found');
    expect(moves(r.path).filter((m) => m === 'jump').length).toBeGreaterThanOrEqual(6);
    const side = staircase(0).gen; // high half east: the walker meets the steps from the side
    expect(moves(plan(side, [0, -60, 0], [0, -54, 10]).path)).toContain('jump');
    const gen = flatGen();
    gen.put(0, -60, 3, 'oak_stairs', { weirdo_direction: 2, upside_down_bit: 1 });
    const ud = plan(gen, [0, -60, 0], [0, -59, 3]);
    expect(ud.status).toBe('found');
    expect(ud.path.at(-1)!.move).toBe('jump');
  });

  it('a 1.26.60 staircase (unknown runtime ids) plans the same as a known one', () => {
    const { world } = staircase(2, { unknown: true });
    const skills = new BotSkills({ loop: harness({ x: 0.5, y: -60, z: 0.5 }).loop, world });
    const r = skills.nav.plan({ type: 'block', p: { x: 0, y: -54, z: 10 } }, { x: 0.5, y: -60, z: 0.5 })!;
    expect(r.status).toBe('found');
    expect(moves(r.path)).not.toContain('jump');
    skills.dispose();
  });

  it('walks onto and off slabs, carpets, farmland, dirt paths and snow layers', () => {
    const gen = flatGen();
    gen.put(0, -60, 1, 'white_carpet');
    gen.put(0, -61, 2, 'farmland');
    gen.put(0, -61, 3, 'grass_path');
    gen.put(0, -60, 4, 'snow_layer', { height: 3 });
    gen.put(0, -60, 5, 'smooth_stone_slab');
    gen.put(0, -60, 6, 'snow_layer', { height: 1 });
    for (const x of [-1, 1]) for (let z = 0; z <= 8; z++) gen.put(x, -60, z, 'stone'); // walls: straight along z
    const r = plan(gen, [0, -60, 0], [0, -60, 8]);
    expect(r.status).toBe('found');
    expect(moves(r.path).slice(1).every((m) => m === 'walk')).toBe(true);
    expect(r.path.map((n) => n.feet)).toEqual([-60, -59.9375, -60.0625, -60.0625, -59.625, -59.5, -59.875, -60, -60]);
  });
});

describe('locateNode on fractional feet heights', () => {
  it('finds the node on a stairs block (low half 0.5, high half 1), slabs, carpets, farmland and snow', () => {
    const { gen } = staircase();
    gen.put(5, -60, 0, 'smooth_stone_slab');
    gen.put(6, -60, 0, 'white_carpet');
    gen.put(7, -61, 0, 'farmland');
    gen.put(8, -60, 0, 'snow_layer', { height: 3 });
    const g = new NavGrid(gen);
    // stairs at z 5, y -58 (weirdo 2: low half z 5.0..5.5 at -57.5, high half at -57)
    expect(locateNode(g, { x: 0.5, y: -57.5, z: 5.25 })).toEqual({ x: 0, y: -57, z: 5, feet: -57 });
    expect(locateNode(g, { x: 0.5, y: -57, z: 5.75 })).toEqual({ x: 0, y: -57, z: 5, feet: -57 });
    expect(locateNode(g, { x: 5.5, y: -59.5, z: 0.5 })).toEqual({ x: 5, y: -60, z: 0, feet: -59.5 });
    expect(locateNode(g, { x: 6.5, y: -59.9375, z: 0.5 })).toEqual({ x: 6, y: -60, z: 0, feet: -59.9375 });
    expect(locateNode(g, { x: 7.5, y: -60.0625, z: 0.5 })).toEqual({ x: 7, y: -61, z: 0, feet: -60.0625 });
    expect(locateNode(g, { x: 8.5, y: -59.625, z: 0.5 })).toEqual({ x: 8, y: -60, z: 0, feet: -59.625 });
  });
});

describe('closed loop: stairs without jumping', () => {
  async function run(world: ReturnType<typeof fakeWorld>, start: Vec3, goal: Vec3, logger?: { warn: (m: string) => void }) {
    const { conn, loop } = harness(start);
    const log = { debug() {}, info() {}, warn: logger?.warn ?? (() => {}), error() {} };
    const skills = new BotSkills({ loop, world, logger: log });
    conn.tick(5);
    const sent0 = conn.sent.length;
    const p = skills.goto({ type: 'block', p: goal });
    let t = 0;
    while (skills.nav.busy && t < 600) {
      conn.tick();
      t++;
    }
    const res = await p;
    const jumps = conn.sent.slice(sent0).filter((s) => s.input_data.includes('start_jumping')).length;
    const rep = skills.status().lastGoto!;
    skills.dispose();
    return { res, jumps, ticks: t, pos: loop.state.pos, rep };
  }

  it('climbs and descends a 6-step oak staircase (1.26.60 runtime ids) with 0 jumps', async () => {
    const { world } = staircase(2, { unknown: true });
    const up = await run(world, { x: 0.5, y: -60, z: 0.5 }, { x: 0, y: -54, z: 10 });
    expect(up.res).toEqual({ ok: true });
    expect(up.pos.y).toBeCloseTo(-54, 3);
    expect(up.jumps).toBe(0);
    const down = await run(world, { x: 0.5, y: -54, z: 10.5 }, { x: 0, y: -60, z: 0 });
    expect(down.res).toEqual({ ok: true });
    expect(down.pos.y).toBeCloseTo(-60, 3);
    expect(down.jumps).toBe(0);
  });

  it('starts standing on a stairs low half and on a slab', async () => {
    const { world, gen } = staircase(2, { unknown: true });
    gen.put(5, -60, 0, 'smooth_stone_slab');
    const fromStair = await run(world, { x: 0.5, y: -57.5, z: 5.2 }, { x: 0, y: -54, z: 11 });
    expect(fromStair.res).toEqual({ ok: true });
    expect(fromStair.rep.segments).toBeGreaterThan(0);
    const fromSlab = await run(world, { x: 5.5, y: -59.5, z: 0.5 }, { x: 5, y: -60, z: 8 });
    expect(fromSlab.res).toEqual({ ok: true });
  });

  it('a block goal inside a stairs cell (feet saved on the low half) is the node above it', async () => {
    const { world } = staircase(2, { unknown: true });
    const r = await run(world, { x: 0.5, y: -60, z: 0.5 }, { x: 0, y: -57, z: 6 }); // the stairs block at z 6
    expect(r.res).toEqual({ ok: true });
    expect(r.pos.y).toBeCloseTo(-56, 3);
  });

  it('logs one WARN line with the feet, the blocks, the start node and the reason when unreachable without a segment', async () => {
    const gen = flatGen();
    // a 1 x 1 cell walled in by 3-high stone, the goal outside
    for (const [x, z] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const)
      gen.fill({ x, y: -60, z }, { x, y: -58, z }, 'stone');
    const warns: string[] = [];
    const r = await run(fakeWorld(gen), { x: 0.5, y: -60, z: 0.5 }, { x: 5, y: -60, z: 5 }, { warn: (m) => warns.push(m) });
    expect(r.res).toEqual({ ok: false, reason: 'unreachable' });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^goto unreachable without a segment: feet \(0\.50, -60\.00, 0\.50\), in air, on grass_block, start node 0,-60,0 feet -60, goal .*"x":5.*, why no path \(exhaustive search, 1 nodes expanded\): no move from the start 0,-60,0 feet -60: \+x: -61 blocked \(grass_block\), -60 blocked \(stone\), -59 blocked \(stone\), -58 blocked \(stone\); -x: .*, plans start:none/);
  });
});
