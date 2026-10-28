// Track AX (2026-10-30): moves out of a node whose floor is a partial block in the node's own cell
// (a chest 0.95, a dirt path 0.9375, a slab 0.5). The owner's Realm report: the bot stood in a 1 x 1
// hole whose floor is a chest, the rim one block above the chest's cell (a rise of 1.05, a jump), and
// every plan failed with no move from the start node; the same with a dirt path in front of a door.
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../../src/skills/index.ts';
import { explainStart, findPath, NavGrid, type PathNode } from '../../../src/skills/nav/index.ts';
import { CROSS_CLEAR } from '../../../src/skills/nav/grid.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const moves = (p: PathNode[]) => p.map((n) => n.move);
const plan = (gen: GenWorld, from: [number, number, number], to: [number, number, number]) =>
  findPath(new NavGrid(gen), { x: from[0], y: from[1], z: from[2] }, { type: 'block', p: { x: to[0], y: to[1], z: to[2] } });

/** Flat world (grass top -60); a 1 x 1 hole at (0, 0) whose floor block sits in cell y = -62 (rim feet -60). */
function hole(floor: string, states?: Record<string, unknown>, depth = 2): GenWorld {
  const gen = flatGen();
  for (let y = -61; y > -61 - depth; y--) gen.put(0, y, 0, 'air');
  gen.put(0, -60 - depth, 0, floor, states);
  return gen;
}

/** A wall along x at z 3 across the whole world (3 high) with an open door at x 0 and a lintel; a dirt path in front of it at z 2. */
function doorWall(opts: { path?: boolean; dir?: string } = {}): GenWorld {
  const gen = flatGen();
  gen.fill({ x: -64, y: -60, z: 3 }, { x: 63, y: -58, z: 3 }, 'stone');
  const dir = opts.dir ?? 'west';
  gen.put(0, -60, 3, 'wooden_door', { 'minecraft:cardinal_direction': dir, upper_block_bit: 0, open_bit: 1 });
  gen.put(0, -59, 3, 'wooden_door', { 'minecraft:cardinal_direction': dir, upper_block_bit: 1, open_bit: 1 });
  if (opts.path !== false) gen.put(0, -61, 2, 'grass_path');
  return gen;
}

describe('planner: moves out of a partial-floor node (Track AX)', () => {
  it('jumps out of a 1 x 1 hole with a chest floor (feet +0.95, rim +1.05 higher)', () => {
    const gen = hole('chest', { 'minecraft:cardinal_direction': 'south' });
    const g = new NavGrid(gen);
    expect(g.stand(0, -62, 0)).toBeCloseTo(-61.05, 6);
    const r = plan(gen, [0, -62, 0], [1, -60, 0]);
    expect(r.status).toBe('found');
    expect(r.path.at(-1)!.move).toBe('jump');
    expect(r.path.at(-1)!.feet).toBe(-60);
    const far = plan(gen, [0, -62, 0], [5, -60, 0]);
    expect(far.status).toBe('found');
    // and back in: a drop onto the chest
    const back = plan(gen, [5, -60, 0], [0, -62, 0]);
    expect(back.status).toBe('found');
    expect(back.path.at(-1)!.feet).toBeCloseTo(-61.05, 6);
  });

  it('jumps out of a hole with a dirt path floor (+0.9375, a rise of 1.0625)', () => {
    const gen = hole('grass_path');
    const r = plan(gen, [0, -62, 0], [3, -60, 0]);
    expect(r.status).toBe('found');
    expect(r.path[1]!.move).toBe('jump');
  });

  it('a slab floor: walks out of a 1-deep hole (+0.5); a 2-deep one (a rise of 1.5) stays unreachable', () => {
    const shallow = hole('smooth_stone_slab', undefined, 1);
    const r = plan(shallow, [0, -61, 0], [3, -60, 0]);
    expect(r.status).toBe('found');
    expect(r.path[1]!.move).toBe('walk');
    const deep = hole('smooth_stone_slab');
    expect(plan(deep, [0, -62, 0], [3, -60, 0]).status).toBe('none');
  });

  it('no jump out of the chest hole without head room above the start (cell +3 blocked)', () => {
    const gen = hole('chest', { 'minecraft:cardinal_direction': 'south' });
    gen.put(0, -59, 0, 'stone'); // the apex head cell: the body's head reaches -57.2 at the rim's feet height
    expect(plan(gen, [0, -62, 0], [1, -60, 0]).status).toBe('none');
  });

  it('walks from a dirt path into an open doorway and on through it, and back', () => {
    const gen = doorWall();
    const g = new NavGrid(gen);
    expect(g.crossing(0, -60, 3, 2)).toBe(CROSS_CLEAR);
    const r = plan(gen, [0, -60, 0], [0, -60, 6]);
    expect(r.status).toBe('found');
    expect(r.path.some((n) => n.x === 0 && n.z === 3)).toBe(true);
    expect(r.path.find((n) => n.z === 2)!.feet).toBeCloseTo(-60.0625, 6);
    expect(moves(r.path).slice(1).every((m) => m === 'walk')).toBe(true);
    const fromPath = plan(gen, [0, -61, 2], [0, -60, 6]);
    expect(fromPath.status).toBe('found');
    const back = plan(gen, [0, -60, 6], [0, -60, 0]);
    expect(back.status).toBe('found');
    expect(back.path.some((n) => n.x === 0 && n.z === 3)).toBe(true);
    expect(moves(back.path).slice(1).every((m) => m === 'walk')).toBe(true);
  });

  it('says which moves the start node refused (the "why" of a plan with no move from the start)', () => {
    const gen = hole('smooth_stone_slab');
    const g = new NavGrid(gen);
    const r = findPath(g, { x: 0, y: -62, z: 0 }, { type: 'block', p: { x: 3, y: -60, z: 0 } });
    expect(r.status).toBe('none');
    expect(r.expanded).toBe(1);
    const why = explainStart(g, { x: 0, y: -62, z: 0, feet: -61.5 });
    expect(why).toMatch(/\+x: .*-60 feet -60 rise 1\.50 > 1\.25/);
  });
});

describe('closed loop: out of a chest hole, through a door from a dirt path (Track AX)', () => {
  async function run(gen: GenWorld, start: Vec3, goal: Vec3) {
    const { conn, loop } = harness(start);
    const skills = new BotSkills({ loop, world: fakeWorld(gen) });
    conn.tick(5);
    const p = skills.goto({ type: 'block', p: goal });
    let t = 0;
    while (skills.nav.busy && t < 600) {
      conn.tick();
      t++;
    }
    const res = await p;
    const rep = skills.status().lastGoto!;
    skills.dispose();
    return { res, ticks: t, pos: loop.state.pos, rep };
  }

  it('jumps out of the chest hole to a cell 5 blocks away', async () => {
    const gen = hole('chest', { 'minecraft:cardinal_direction': 'south' });
    const r = await run(gen, { x: 0.5, y: -61.05, z: 0.5 }, { x: 5, y: -60, z: 0 });
    expect(r.res).toEqual({ ok: true });
    expect(r.pos.y).toBeCloseTo(-60, 3);
    expect(r.ticks).toBeLessThan(200);
  });

  it('walks from a dirt path through an open door', async () => {
    const gen = doorWall();
    const r = await run(gen, { x: 0.5, y: -60.0625, z: 2.5 }, { x: 0, y: -60, z: 6 });
    expect(r.res).toEqual({ ok: true });
    expect(r.pos.z).toBeGreaterThan(6);
  });
});
