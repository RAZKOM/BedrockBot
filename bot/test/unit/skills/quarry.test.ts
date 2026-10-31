// Track BK (docs/mining.md "Quarry and tunnel", decision 0053): `!quarry` / `!tunnel` planning (boxes,
// slices, the staircase, the argument forms) and whole jobs on the builder's flat fake world (the bot
// walks by teleporting, digs at once): layer order, the stairs kept, refusals (liquids stop their
// columns, built blocks stay), stop and pause / resume, the tunnel's lane, floor and torches.
// Review fixes: the stairs stay a way out (1-wide refusals, the live tread check before each layer,
// treads walkable after the job), supports of built blocks stay, players, the stair head approach,
// the kept cells, the dig-time feet floor, the collect filter, narrow-tunnel torches.
import { describe, expect, it } from 'vitest';
import { isBuiltBlock } from '../../../src/skills/terrain/classify.ts';
import { boxOf, checkQuarryBox, checkQuarrySite, hereBox, overlapsBody, parseQuarryArgs, parseTunnelArgs, playerOver, quarrySlices, quarrySpec, QuarryJob, ringOf, stairHead, staircase, tunnelSpec, type Box, type QuarryHost, type QuarrySpec } from '../../../src/skills/mine/quarry.ts';
import { feetFloorOf } from '../../../src/skills/mine/wire.ts';
import { quarryTakes } from '../../../src/tasks/process/quarry.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { key } from '../../../src/skills/build/types.ts';
import { FakeBot, FakeInventory, FlatWorld } from './build-fakes.ts';

const F = -60;
const FEET: Vec3 = { x: 0, y: F, z: 0 };
const EAST = [1, 0] as const;
const SOUTH = [0, 1] as const;
const LIQ = /(^|_)(water|lava)$/;
const N6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/** The navigator's break rules in miniature: air, liquids and their neighbours, built blocks, gravity above. */
function rule(w: FlatWorld, p: Vec3): string | undefined {
  const b = w.blockAt(p)!;
  if (LIQ.test(b.name)) return 'liquid';
  if (b.boxes.length === 0) return 'air';
  if (isBuiltBlock(b.name)) return 'protected';
  for (const [dx, dy, dz] of N6) if (LIQ.test(w.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz })!.name)) return 'next_to_liquid';
  if (/^(sand|gravel)$/.test(w.blockAt({ ...p, y: p.y + 1 })!.name)) return 'gravity_above';
  return undefined;
}

function liquid(w: FlatWorld, p: Vec3, name = 'water'): void {
  w.cells.set(key(p), { name, boxes: [] });
}

function setup(o: { inv?: Record<string, number> } = {}) {
  const world = new FlatWorld();
  const inv = new FakeInventory({ diamond_pickaxe: 1, ...o.inv });
  const bot = new FakeBot(world, inv, { x: 0.5, y: F, z: 0.5 });
  const digs: Vec3[] = [];
  const deps = bot.deps();
  const host: QuarryHost = {
    ...deps,
    dig: (p) => {
      digs.push({ ...p });
      return deps.dig(p);
    },
    place: (p, opts) => deps.place(p, opts),
    breakRule: (p) => rule(world, p),
    slots: () => [...inv.items.entries()].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, networkId: 1, metadata: 0 })),
    throwawayMin: () => 0,
  };
  return { world, inv, bot, host, digs };
}

/** Every tread solid with its feet, head and step-up cells open (the live world after the job). */
function expectWalkable(w: FlatWorld, treads: readonly Vec3[]): void {
  for (const t of treads) {
    expect(w.blockAt(t)!.boxes.length, `tread ${key(t)}`).toBeGreaterThan(0);
    for (let dy = 1; dy <= 3; dy++) expect(w.name({ ...t, y: t.y + dy }), `over tread ${key(t)} +${dy}`).toBe('air');
  }
}

function solidIn(w: FlatWorld, b: Box): Vec3[] {
  const out: Vec3[] = [];
  for (let y = b.min.y; y <= b.max.y; y++) for (let x = b.min.x; x <= b.max.x; x++) for (let z = b.min.z; z <= b.max.z; z++) if (w.blockAt({ x, y, z })!.boxes.length > 0) out.push({ x, y, z });
  return out;
}

const spec = (r: ReturnType<typeof parseQuarryArgs>): QuarrySpec => {
  if ('error' in r) throw new Error(r.error);
  return r.spec;
};

describe('quarry planning', () => {
  it('here: d forward from one block ahead, w wide around the bot (the extra column of an even width on the right), from under the feet down', () => {
    expect(hereBox(FEET, SOUTH, 3, 4, 2)).toEqual({ min: { x: -1, y: -62, z: 1 }, max: { x: 1, y: -61, z: 4 } });
    // facing east the right hand is south (+z): 8 wide = 3 to the left, 4 to the right
    expect(hereBox(FEET, EAST, 8, 8, 4)).toEqual({ min: { x: 1, y: -64, z: -3 }, max: { x: 8, y: -61, z: 4 } });
  });

  it('layers top first; a box larger than 64 on a side is refused with the reason', () => {
    const b = boxOf({ x: 0, y: -61, z: 0 }, { x: 2, y: -63, z: 2 });
    expect(quarrySlices(b).map((s) => s.min.y)).toEqual([-61, -62, -63]);
    expect(quarrySlices(b)[0]).toEqual({ min: { x: 0, y: -61, z: 0 }, max: { x: 2, y: -61, z: 2 } });
    expect(checkQuarryBox(boxOf({ x: 0, y: 0, z: 0 }, { x: 63, y: -63, z: 63 }))).toBeUndefined();
    expect(checkQuarryBox(boxOf({ x: 0, y: 0, z: 0 }, { x: 64, y: 0, z: 0 }))).toBe('65x1x1 is too big (at most 64 on every side)');
    const r = parseQuarryArgs(['0', '0', '0', '100', '-5', '3'], FEET, 0);
    expect(r).toEqual({ error: 'quarry: 101x6x4 is too big (at most 64 on every side)' });
  });

  it('arguments: here with the facing or a direction, two corners in any order, usage otherwise', () => {
    // yaw 0 = south
    expect(spec(parseQuarryArgs(['here', '3', '4', '2'], FEET, 0)).box).toEqual(hereBox(FEET, SOUTH, 3, 4, 2));
    expect(spec(parseQuarryArgs(['here', '8', '8', '4', 'east'], FEET, 0)).box).toEqual(hereBox(FEET, EAST, 8, 8, 4));
    const s = spec(parseQuarryArgs(['5', '-61', '5', '1', '-64', '2'], FEET, 0));
    expect(s.box).toEqual({ min: { x: 1, y: -64, z: 2 }, max: { x: 5, y: -61, z: 5 } });
    expect(s.label).toBe('quarry 5x4x4');
    for (const bad of [[], ['here', '3', '4'], ['here', '0', '4', '2'], ['here', '3', '4', '2', 'up'], ['1', '2', '3'], ['1', '2', '3', '4', '5', 'x']]) expect('error' in parseQuarryArgs(bad, FEET, 0)).toBe(true);
  });

  it('the staircase: one tread per layer along the perimeter from the corner nearest the bot, one lower each, depth - 1 of them', () => {
    const b = boxOf({ x: 0, y: -61, z: 0 }, { x: 3, y: -64, z: 3 });
    expect(staircase(b, { x: -0.5, y: F, z: 0.5 })).toEqual([
      { x: 0, y: -62, z: 0 },
      { x: 1, y: -63, z: 0 },
      { x: 2, y: -64, z: 0 },
    ]);
    // from the far corner it starts there and walks the ring on
    expect(staircase(b, { x: 4.5, y: F, z: 4.5 })[0]).toEqual({ x: 3, y: -62, z: 3 });
    const ring = ringOf(b, { x: -0.5, y: F, z: 0.5 });
    expect(ring.cycle).toBe(true);
    expect(ring.cells).toHaveLength(12);
    for (let i = 0; i < ring.cells.length; i++) {
      const a = ring.cells[i]!;
      const n = ring.cells[(i + 1) % ring.cells.length]!;
      expect(Math.abs(a.x - n.x) + Math.abs(a.z - n.z)).toBe(1); // side by side, round the corner too
    }
    // depth 1: no stairs
    expect(staircase(boxOf({ x: 0, y: -61, z: 0 }, { x: 3, y: -61, z: 3 }), FEET)).toEqual([]);
  });

  it('a spiral in a 2x2 shaft keeps 3 open cells over every tread; a 1-wide box gets a straight staircase as long as the box', () => {
    const shaft = boxOf({ x: 0, y: -50, z: 0 }, { x: 1, y: -61, z: 1 });
    const t = staircase(shaft, { x: -0.5, y: F, z: 0.5 });
    expect(t).toHaveLength(11);
    const keep = new Set(t.map(key));
    for (const p of t) for (let dy = 1; dy <= 3; dy++) expect(keep.has(key({ ...p, y: p.y + dy }))).toBe(false);
    const line = boxOf({ x: 0, y: -61, z: 1 }, { x: 0, y: -66, z: 3 });
    expect(staircase(line, FEET)).toEqual([
      { x: 0, y: -62, z: 1 },
      { x: 0, y: -63, z: 2 },
      { x: 0, y: -64, z: 3 },
    ]);
  });

  it('a 1x1 box deeper than 1 and a 1-wide box deeper than its length + 1 are refused (no room for the stairs)', () => {
    expect(checkQuarryBox(boxOf({ x: 0, y: -61, z: 0 }, { x: 0, y: -62, z: 0 }))).toBe('1x2x1: a 1x1 box can be 1 deep at most (no room for stairs out)');
    expect(checkQuarryBox(boxOf({ x: 0, y: -61, z: 0 }, { x: 0, y: -61, z: 0 }))).toBeUndefined();
    expect(checkQuarryBox(boxOf({ x: 0, y: -61, z: 0 }, { x: 0, y: -64, z: 2 }))).toBeUndefined(); // 3 long, 4 deep: 3 treads
    expect(checkQuarryBox(boxOf({ x: 0, y: -61, z: 0 }, { x: 0, y: -65, z: 2 }))).toBe('1x5x3: a 1-wide box can be its length + 1 (4) deep at most (no room for stairs out)');
    expect('error' in parseQuarryArgs(['here', '1', '1', '3'], FEET, 0)).toBe(true);
    expect('error' in parseQuarryArgs(['here', '1', '3', '4'], FEET, 0)).toBe(false);
    expect('error' in parseQuarryArgs(['here', '1', '3', '5'], FEET, 0)).toBe(true);
  });

  it('the stair head: outside the box beside the first tread, at the top, on the side of the bot; here says its direction', () => {
    const s = spec(parseQuarryArgs(['here', '4', '4', '3'], FEET, 0));
    expect(s.exit).toEqual(FEET); // the box starts one block ahead: the head is where the bot stands
    expect(s.dir).toEqual(SOUTH);
    expect(stairHead(boxOf({ x: 30, y: -61, z: 0 }, { x: 33, y: -63, z: 3 }), { x: 0.5, y: F, z: 0.5 })).toEqual({ x: 29, y: F, z: 0 });
    expect(spec(parseQuarryArgs(['1', '-61', '1', '3', '-62', '3'], FEET, 0)).dir).toBeUndefined();
  });

  it('the site: a box farther than 64 blocks or not loaded is refused; players in or over the box are found', () => {
    const b = boxOf({ x: 1, y: -61, z: 1 }, { x: 4, y: -63, z: 4 });
    const w = new FlatWorld();
    expect(checkQuarrySite(b, FEET, (p) => w.blockAt(p))).toBeUndefined();
    expect(checkQuarrySite(boxOf({ x: 100, y: -61, z: 0 }, { x: 103, y: -63, z: 3 }), FEET, (p) => w.blockAt(p))).toBe('the box is 100 blocks away (at most 64)');
    expect(checkQuarrySite(b, FEET, (p) => (p.x === 4 && p.z === 4 ? undefined : w.blockAt(p)))).toBe('the box is not loaded (4 -63 4)');
    expect(playerOver(b, [{ x: 2.5, y: F, z: 2.5 }])).toEqual({ x: 2.5, y: F, z: 2.5 }); // on the top layer
    expect(playerOver(b, [{ x: 0.5, y: F, z: 0.5 }])).toBeUndefined(); // beside it
    expect(playerOver(b, [{ x: 2.5, y: F + 5, z: 2.5 }])).toBeUndefined(); // high above
    expect(overlapsBody({ x: 2.5, y: F, z: 2.5 }, { x: 2, y: F, z: 2 })).toBe(true);
    expect(overlapsBody({ x: 2.5, y: F, z: 2.5 }, { x: 2, y: F - 1, z: 2 })).toBe(false);
    expect(overlapsBody({ x: 2.9, y: F, z: 2.5 }, { x: 3, y: F + 1, z: 2 })).toBe(true); // 0.3 over the edge
  });

  it('tunnel arguments: a direction or here, the length, WxH (default 3x3); cross-sections from one block ahead at the feet', () => {
    const s = spec(parseTunnelArgs(['here', '20'], FEET, -90)); // yaw -90 = east
    expect(s.label).toBe('tunnel east 20 (3x3)');
    expect(s.slices).toHaveLength(20);
    expect(s.slices[0]).toEqual({ min: { x: 1, y: F, z: -1 }, max: { x: 1, y: F + 2, z: 1 } });
    expect(s.slices[19]!.min.x).toBe(20);
    expect(s.box).toEqual({ min: { x: 1, y: F, z: -1 }, max: { x: 20, y: F + 2, z: 1 } });
    const n = spec(parseTunnelArgs(['north', '5', '1x2'], FEET, 0));
    expect(n.slices[0]).toEqual({ min: { x: 0, y: F, z: -1 }, max: { x: 0, y: F + 1, z: -1 } });
    for (const bad of [['east'], ['up', '5'], ['east', '0'], ['east', '257'], ['east', '5', '10x3'], ['east', '5', '3x1'], ['east', '5', '3by3']]) expect('error' in parseTunnelArgs(bad, FEET, 0)).toBe(true);
  });
});

describe('quarry job (fake world)', () => {
  it('digs an 4x3x4 box layer by layer, keeps the stairs, and climbs back to the start', async () => {
    const { world, host, digs, bot } = setup();
    const s = spec(parseQuarryArgs(['here', '4', '4', '3'], FEET, 0)); // south: x -2..1, z 1..4, y -61..-63
    const job = new QuarryJob(s, host);
    const end = await job.start();
    expect(end).toBe('done');
    expect(s.keep).toEqual([
      { x: 0, y: -62, z: 1 },
      { x: 1, y: -63, z: 1 },
    ]);
    const left = solidIn(world, s.box);
    expect(left.map(key).sort()).toEqual(s.keep.map(key).sort());
    expect(job.stats.dug).toBe(48 - 2);
    expect(job.stats.skipped.size).toBe(0);
    expect(job.stats.dugBy).toEqual({ grass_block: 16, dirt: 30 });
    // top layer first: every dig of a layer before any of the next one
    const ys = digs.map((p) => p.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThanOrEqual(ys[i - 1]!);
    expect(Math.floor(bot.feet.y)).toBe(F); // back at the start's height
    expect(job.summary()).toBe('quarry 4x3x4: layer 3/3, 46 dug, 0 skipped');
  });

  it('water in the box: the water and its neighbours stay, and nothing under them is dug (the columns stop)', async () => {
    const { world, host } = setup();
    const s = quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 5, y: -63, z: 5 }), FEET);
    liquid(world, { x: 3, y: -61, z: 3 });
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('done');
    const side = [
      { x: 2, z: 3 },
      { x: 4, z: 3 },
      { x: 3, z: 2 },
      { x: 3, z: 4 },
    ];
    for (const c of side) for (const y of [-61, -62, -63]) expect(world.name({ x: c.x, y, z: c.z })).not.toBe('air');
    expect(world.name({ x: 3, y: -62, z: 3 })).not.toBe('air'); // under the water
    expect(world.name({ x: 3, y: -63, z: 3 })).not.toBe('air');
    expect(world.name({ x: 3, y: -61, z: 3 })).toBe('water');
    expect(world.name({ x: 2, y: -62, z: 2 })).toBe('air'); // diagonal: dug
    const reasons = [...job.stats.skipped.values()];
    expect(reasons.filter((r) => r === 'next_to_liquid')).toHaveLength(4); // beside it; the cells below are in stopped columns
    expect(reasons.filter((r) => r === 'stopped column (liquid)')).toHaveLength(10);
    expect(reasons).toContain('liquid');
  });

  it('built blocks are never dug, nor the cell under one; gravel over the box keeps the block under it', async () => {
    const { world, host } = setup();
    const s = quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 4, y: -62, z: 4 }), FEET);
    world.set({ x: 3, y: -61, z: 3 }, 'oak_planks');
    world.set({ x: 2, y: -60, z: 3 }, 'gravel'); // on top of the box (outside it)
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('done');
    expect(world.name({ x: 3, y: -61, z: 3 })).toBe('oak_planks');
    expect(world.name({ x: 3, y: -62, z: 3 })).toBe('dirt'); // its support
    expect(world.name({ x: 2, y: -61, z: 3 })).toBe('grass_block');
    expect(job.stats.skipped.get('3,-61,3')).toBe('protected');
    expect(job.stats.skipped.get('3,-62,3')).toBe('supports a block');
    expect(job.stats.skipped.get('2,-61,3')).toBe('gravity_above');
  });

  it('what hangs on a cell keeps it: a torch on top (no collision box), a wall torch beside; a torch in the box stays too', async () => {
    const { world, host } = setup();
    const s = quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 5, y: -62, z: 5 }), FEET);
    const thin = (p: Vec3, name: string) => world.cells.set(key(p), { name, boxes: [] });
    thin({ x: 3, y: -60, z: 3 }, 'torch'); // on the top layer, outside the box
    thin({ x: 6, y: -61, z: 2 }, 'torch'); // a wall torch on the box's east side, outside it
    thin({ x: 2, y: -62, z: 4 }, 'torch'); // in the box (the bottom layer)
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('done');
    expect(world.name({ x: 3, y: -60, z: 3 })).toBe('torch');
    expect(world.name({ x: 3, y: -61, z: 3 })).toBe('grass_block');
    expect(job.stats.skipped.get('3,-61,3')).toBe('supports a block');
    expect(world.name({ x: 5, y: -61, z: 2 })).toBe('grass_block'); // the wall torch hangs on it
    expect(job.stats.skipped.get('5,-61,2')).toBe('holds a wall block');
    expect(world.name({ x: 2, y: -62, z: 4 })).toBe('torch');
    expect(job.stats.skipped.get('2,-62,4')).toBe('protected');
    expect(world.name({ x: 4, y: -61, z: 4 })).toBe('air'); // the rest is dug
  });

  it('a player on a cell keeps it, at the plan and at the dig (one who walks on later)', async () => {
    const { world, host, bot, digs } = setup();
    const players: Vec3[] = [{ x: 2.5, y: F, z: 2.5 }];
    host.players = () => players;
    const s = quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 4, y: -61, z: 4 }), FEET);
    bot.onStep = () => {
      if (digs.length === 1 && players.length === 1) players.push({ x: 4.5, y: F, z: 4.5 }); // the far corner: dug last
    };
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('done');
    expect(world.name({ x: 2, y: -61, z: 2 })).toBe('grass_block');
    expect(world.name({ x: 4, y: -61, z: 4 })).toBe('grass_block');
    expect(job.stats.skipped.get('2,-61,2')).toBe('player on it');
    expect(job.stats.skipped.get('4,-61,4')).toBe('player on it');
    expect(job.stats.dug).toBe(14);
  });

  it('the treads are walkable after the job: a 4x4 box and a 2x2 spiral 8 deep, the bot back at the stair head', async () => {
    for (const box of [boxOf({ x: -2, y: -61, z: 1 }, { x: 1, y: -64, z: 4 }), boxOf({ x: 1, y: -61, z: 1 }, { x: 2, y: -68, z: 2 })]) {
      const { world, host, bot } = setup();
      const s = quarrySpec(box, FEET);
      const job = new QuarryJob(s, host);
      expect(await job.start()).toBe('done');
      expect(s.keep).toHaveLength(box.max.y - box.min.y);
      expectWalkable(world, s.keep);
      expect(solidIn(world, box).map(key).sort()).toEqual(s.keep.map(key).sort());
      expect(Math.floor(bot.feet.y)).toBe(F);
    }
  });

  it('a cave in a tread: no layer under it is dug, the job ends "no way out" and the bot climbs out', async () => {
    const { world, host, bot } = setup();
    const s = spec(parseQuarryArgs(['here', '4', '4', '4'], FEET, 0)); // treads 0 -62 1, 1 -63 1, 1 -64 2
    world.set(s.keep[1]!, 'air');
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('blocked');
    expect(job.lastError).toBe('no way out below y -62: the tread at 1 -63 1 is open (air)');
    expect(world.name({ x: -1, y: -62, z: 3 })).toBe('air'); // layers -61 and -62 dug
    expect(world.name({ x: -1, y: -63, z: 3 })).toBe('dirt'); // nothing deeper
    expectWalkable(world, s.keep.slice(0, 1));
    expect(Math.floor(bot.feet.y)).toBe(F);
  });

  it('water outside the wall beside a cell over a tread: that cell stays, so the job ends before it goes deeper', async () => {
    const { world, host, bot } = setup();
    const s = spec(parseQuarryArgs(['here', '4', '4', '4'], FEET, 0));
    liquid(world, { x: 2, y: -62, z: 1 }); // east of 1 -62 1, the cell over tread 1 -63 1
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('blocked');
    expect(job.lastError).toBe('no way out below y -62: dirt over the tread at 1 -63 1 stays (next_to_liquid)');
    expect(world.name({ x: 1, y: -62, z: 1 })).toBe('dirt');
    expect(world.name({ x: -1, y: -63, z: 3 })).toBe('dirt');
    expect(world.name({ x: 2, y: -62, z: 1 })).toBe('water');
    expectWalkable(world, s.keep.slice(0, 1));
    expect(Math.floor(bot.feet.y)).toBe(F);
  });

  it('a box away from the bot: it walks to the stair head first; the treads are held as kept cells for the job', async () => {
    const { host, bot } = setup();
    const calls: [number, boolean][] = [];
    host.keepCells = (cells, on) => calls.push([cells.length, on]);
    const s = quarrySpec(boxOf({ x: 30, y: -61, z: 0 }, { x: 33, y: -63, z: 3 }), FEET);
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('done');
    expect(bot.log[0]).toBe('goto 29,-60,0');
    expect(calls).toEqual([
      [2, true],
      [2, false],
    ]);
  });

  it('the dig-time recheck reads the live feet floor: the cell under the bot is never dug', async () => {
    const { world, host, bot } = setup();
    host.breakRule = (p) => (key(feetFloorOf(bot.feet)[0]!) === key(p) ? 'under_feet' : rule(world, p));
    const underDug: Vec3[] = [];
    const deps = bot.deps();
    host.dig = (p) => {
      if (key(feetFloorOf(bot.feet)[0]!) === key(p)) underDug.push(p);
      return deps.dig(p);
    };
    const job = new QuarryJob(quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 3, y: -62, z: 3 }), FEET), host);
    bot.feet = { x: 2.5, y: F, z: 2.5 };
    expect(job.refusal({ x: 2, y: -61, z: 2 })).toBe('under_feet'); // standing on it: refused at the dig
    // on the box at the plan: that cell is still planned (the runner digs it from another stand)
    expect(await job.start()).toBe('done');
    expect(world.name({ x: 2, y: -61, z: 2 })).toBe('air');
    expect(job.stats.skipped.size).toBe(0);
    expect(underDug).toEqual([]);
    expect(feetFloorOf({ x: 2.5, y: F + 1e-9, z: -0.5 })).toEqual([{ x: 2, y: F - 1, z: -1 }]);
  });

  it('collects with quarryKeepStone off leave the junk (the stash step dropped it) but take throwaway blocks while short', async () => {
    expect(quarryTakes('cobblestone', true, false)).toBe(true);
    expect(quarryTakes('cobblestone', false, false)).toBe(false);
    expect(quarryTakes('cobblestone', false, true)).toBe(true);
    expect(quarryTakes('stone', false, true)).toBe(false);
    expect(quarryTakes('coal', false, false)).toBe(true);
    const { host } = setup();
    const takes: (((n: string) => boolean) | undefined)[] = [];
    host.collect = (_r, _t, take) => {
      takes.push(take);
      return Promise.resolve({ ok: true });
    };
    const job = new QuarryJob(quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 4, y: -62, z: 4 }), FEET), host);
    job.take = (n) => quarryTakes(n, false, job.throwawayShort());
    expect(await job.start()).toBe('done');
    expect(takes.length).toBeGreaterThan(0);
    expect(takes.every((t) => t === job.take)).toBe(true);
  });

  it('stop mid-job: nothing more is dug and the job ends stopped', async () => {
    const { host, bot, digs } = setup();
    const job = new QuarryJob(quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 4, y: -62, z: 4 }), FEET), host);
    bot.onStep = () => {
      if (digs.length === 5) job.stop();
    };
    expect(await job.start()).toBe('stopped');
    expect(digs.length).toBeLessThanOrEqual(6);
    const n = digs.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(digs.length).toBe(n);
    expect(job.state).toBe('stopped');
  });

  it('pause and resume (an unload trip far away): the slice is planned again, the bot walks back, the box ends empty', async () => {
    const { world, host, bot, digs } = setup();
    const s = quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 4, y: -62, z: 4 }), FEET);
    const job = new QuarryJob(s, host);
    let paused = false;
    bot.onStep = () => {
      if (!paused && digs.length === 7) {
        paused = true;
        job.pause();
        setTimeout(() => {
          bot.feet = { x: 60.5, y: F, z: 60.5 }; // the stash step walked off
          job.resume();
        }, 5);
      }
    };
    expect(await job.start()).toBe('done');
    expect(paused).toBe(true);
    expect(solidIn(world, s.box).map(key)).toEqual(s.keep.map(key));
    expect(job.stats.plans).toBeGreaterThanOrEqual(3); // 2 layers + the one planned again
  });

  it('no pickaxe: the job ends at once with the reason', async () => {
    const { host, inv } = setup();
    inv.items.delete('diamond_pickaxe');
    const job = new QuarryJob(quarrySpec(boxOf({ x: 1, y: -61, z: 1 }, { x: 2, y: -61, z: 2 }), FEET), host);
    expect(await job.start()).toBe('failed');
    expect(job.lastError).toBe('no pickaxe');
  });
});

describe('tunnel job (fake world)', () => {
  /** Stone from x 1 to 30 around the lane (feet and 3 above), the flat floor under it. */
  function rock(world: FlatWorld): void {
    for (let x = 1; x <= 30; x++) for (let y = F; y <= F + 4; y++) for (let z = -3; z <= 3; z++) world.set({ x, y, z }, 'stone');
  }

  it('a 3x3 tunnel east 12: every cross-section dug, the floor kept, a torch on the left wall at block 8', async () => {
    const { world, host, inv } = setup({ inv: { torch: 4 } });
    rock(world);
    const s = tunnelSpec(FEET, EAST, 12, 3, 3);
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('done');
    const left = solidIn(world, s.box).filter((p) => world.name(p) !== 'torch');
    expect(left).toEqual([]);
    for (let x = 1; x <= 12; x++) expect(world.name({ x, y: F - 1, z: 0 })).toBe('grass_block');
    expect(world.name({ x: 13, y: F, z: 0 })).toBe('stone');
    expect(job.stats.dug).toBe(12 * 9);
    expect(job.stats.torches).toBe(1);
    expect(world.name({ x: 8, y: F, z: -1 })).toBe('torch'); // east: the left hand is north (-z)
    expect(inv.count('torch')).toBe(3);
  });

  it('a 1x2 tunnel: the torch goes on a floor cell clear of the bot (the lane behind it)', async () => {
    const { world, host, inv, bot } = setup({ inv: { torch: 2 } });
    rock(world);
    const s = tunnelSpec(FEET, EAST, 8, 1, 2);
    const at: Vec3[] = [];
    host.place = (p, o) => {
      if (o.item === 'torch') {
        at.push({ ...p });
        if (overlapsBody(bot.feet, p)) return Promise.resolve({ ok: false, reason: 'in_body' });
      }
      return bot.deps().place(p, o);
    };
    const job = new QuarryJob(s, host);
    expect(await job.start()).toBe('done');
    expect(job.stats.torches).toBe(1);
    expect(at).toHaveLength(1);
    expect(world.name(at[0]!)).toBe('torch');
    expect(inv.count('torch')).toBe(1);
  });

  it('a hole in the floor is filled with a throwaway block; water in the lane ends the tunnel there with the reason', async () => {
    const { world, host, inv } = setup({ inv: { cobblestone: 2 } });
    rock(world);
    world.set({ x: 3, y: F - 1, z: 0 }, 'air');
    liquid(world, { x: 7, y: F + 1, z: 0 });
    const job = new QuarryJob(tunnelSpec(FEET, EAST, 10, 3, 3), host);
    expect(await job.start()).toBe('blocked');
    expect(world.name({ x: 3, y: F - 1, z: 0 })).toBe('cobblestone');
    expect(inv.count('cobblestone')).toBe(1);
    expect(job.stats.floors).toBe(1);
    expect(job.lastError).toBe('blocked at 6 -60 0 (stopped column (liquid))'); // the head cell is next to the water, the feet cell under it is left too
    expect(world.name({ x: 5, y: F, z: 0 })).toBe('air');
  });
});
