// Track CB (ADR 0066, docs/coarse.md): the coarse layer on generated worlds. The owner's cases: a cave
// whose only entrance is far from the goal (a flight lands over the goal, the way in is 100 blocks
// back), a ravine that forces a detour, a mineshaft out of a hill; unknown space crossed at a price;
// portal ids stable across rebuilds; a failed portal re-routed and tried again after the decay; a
// fly-only corridor with a stub fly cost and a mixed one that lands at the cave mouth.
import { describe, expect, it } from 'vitest';
import { CoarseLayerImpl, terrainSource, type CoarseCost, type Corridor } from '../../../src/skills/coarse/index.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { FAILED_DECAY_MS, mineCost } from '../../../src/skills/coarse/costs.ts';
import { flatGen, GenWorld } from './genworld.ts';

const F = -60; // feet on the flat world's grass

const all = (c: Corridor): Vec3[] => c.legs.flatMap((l) => l.waypoints);
const near = (c: Corridor, p: { x?: number; y?: number; z?: number }, tol = 3): boolean =>
  all(c).some((w) => (p.x === undefined || Math.abs(w.x - p.x) <= tol) && (p.y === undefined || Math.abs(w.y - p.y) <= tol) && (p.z === undefined || Math.abs(w.z - p.z) <= tol));

function layerOf(gen: GenWorld, opts: { known?: (cx: number, cz: number) => boolean; now?: () => number } = {}) {
  const src = terrainSource(gen, { known: opts.known });
  const layer = new CoarseLayerImpl(src, { now: opts.now });
  return { layer, src };
}

/**
 * Ground at y -31 (feet -30). From the surface at x = 0 a 1-wide staircase goes down towards +x (step
 * k at x = k, feet -31 - k, 3 high) to feet -50, then a tunnel at feet -50 along x to a room at x
 * 100..110 (z -3..3, y -50..-46). The room's only way in is that staircase, 100 blocks from it.
 */
function caveWorld(): GenWorld {
  const gen = new GenWorld({ x: -96, y: -64, z: -32 }, { x: 256, y: 48, z: 64 });
  gen.fill({ x: -96, y: -64, z: -32 }, { x: 159, y: -64, z: 31 }, 'bedrock');
  gen.fill({ x: -96, y: -63, z: -32 }, { x: 159, y: -32, z: 31 }, 'stone');
  gen.fill({ x: -96, y: -31, z: -32 }, { x: 159, y: -31, z: 31 }, 'grass_block');
  for (let k = 0; k <= 19; k++) gen.fill({ x: k, y: -31 - k, z: 0 }, { x: k, y: -29 - k, z: 0 }, 'air');
  gen.fill({ x: 20, y: -50, z: 0 }, { x: 100, y: -48, z: 0 }, 'air');
  gen.fill({ x: 100, y: -50, z: -3 }, { x: 110, y: -46, z: 3 }, 'air');
  return gen;
}
const CAVE_GOAL = { x: 105.5, y: -50, z: 0.5 };

describe('coarse layer: the owner\'s cases', () => {
  it('a cave whose only entrance is 100 blocks from the goal: the corridor goes to the entrance first', async () => {
    const { layer } = layerOf(caveWorld());
    const c = await layer.plan({ start: { x: -60.5, y: -30, z: 0.5 }, goal: CAVE_GOAL, modes: ['walk'] });
    expect(c.status, c.reason).toBe('found');
    expect(c.legs).toHaveLength(1);
    expect(near(c, { x: 0, y: -31 }, 2)).toBe(true); // the surface opening
    const last = c.legs[0]!.waypoints.at(-1)!;
    expect(last).toEqual(CAVE_GOAL);
    expect(c.legs[0]!.volumes.some((v) => v.includes(':-4:') || v.includes(':-3:'))).toBe(true); // through cave sections
    expect(c.unknownFraction).toBe(0);
  });

  it('standing on the surface right over the goal: the corridor walks back to the entrance (what the landing above the goal could not)', async () => {
    const { layer } = layerOf(caveWorld());
    const c = await layer.plan({ start: { x: 105.5, y: -30, z: 0.5 }, goal: CAVE_GOAL, modes: ['walk'] });
    expect(c.status, c.reason).toBe('found');
    const xs = all(c).map((w) => w.x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(2);
    expect(c.blocks).toBeGreaterThan(200);
  });

  it('the entrance closed: no corridor for walk, a dug one for mine', async () => {
    const gen = caveWorld();
    gen.fill({ x: 0, y: -34, z: 0 }, { x: 3, y: -29, z: 0 }, 'stone'); // the first four steps
    const { layer } = layerOf(gen);
    const walk = await layer.plan({ start: { x: 105.5, y: -30, z: 0.5 }, goal: CAVE_GOAL, modes: ['walk'] });
    expect(walk.status).toBe('none');
    const mine = await layer.plan({ start: { x: 105.5, y: -30, z: 0.5 }, goal: CAVE_GOAL, modes: ['walk', 'mine'] });
    expect(mine.status, mine.reason).toBe('found');
    expect(mine.legs.some((l) => l.mode === 'mine')).toBe(true);
    expect(mine.legs.some((l) => l.portals.some((p) => p.dug !== undefined))).toBe(true);
    // at the default dig price (digPenalty: 13 walked blocks per dug block) the long walk through the dug-open
    // stairs is about as cheap as a 20-block shaft; with a cheap pickaxe the shaft straight down wins
    layer.setCost('mine', mineCost({ digTicks: 20 }));
    const shaft = await layer.plan({ start: { x: 105.5, y: -30, z: 0.5 }, goal: CAVE_GOAL, modes: ['walk', 'mine'] });
    expect(shaft.status, shaft.reason).toBe('found');
    expect(shaft.blocks).toBeLessThan(80);
    expect(shaft.cost).toBeLessThan(mine.cost);
  });

  /** Ground at feet F; a ravine 16 wide (chunk column cx = 2, x 32..47) and 15 deep across z -64..31; the ground is whole at z 32..63. */
  function ravineWorld(crossing: boolean): GenWorld {
    const gen = new GenWorld({ x: -32, y: -80, z: -64 }, { x: 128, y: 40, z: 128 });
    gen.fill({ x: -32, y: -80, z: -64 }, { x: 95, y: -80, z: 63 }, 'bedrock');
    gen.fill({ x: -32, y: -79, z: -64 }, { x: 95, y: -62, z: 63 }, 'stone');
    gen.fill({ x: -32, y: -61, z: -64 }, { x: 95, y: -61, z: 63 }, 'grass_block');
    gen.fill({ x: 32, y: -76, z: -64 }, { x: 47, y: -61, z: crossing ? 31 : 63 }, 'air');
    return gen;
  }

  it('a ravine across the way: the corridor detours round its end', async () => {
    const { layer } = layerOf(ravineWorld(true));
    const c = await layer.plan({ start: { x: 0.5, y: F, z: 0.5 }, goal: { x: 80.5, y: F, z: 0.5 }, modes: ['walk'] });
    expect(c.status, c.reason).toBe('found');
    expect(Math.max(...all(c).map((w) => w.z))).toBeGreaterThanOrEqual(31);
    expect(c.blocks).toBeGreaterThan(100);
  });

  it('a ravine with no known way round: walk goes round through never-seen chunks at a price, mine digs straight across', async () => {
    const { layer } = layerOf(ravineWorld(false));
    const walk = await layer.plan({ start: { x: 0.5, y: F, z: 0.5 }, goal: { x: 80.5, y: F, z: 0.5 }, modes: ['walk'] });
    expect(walk.status, walk.reason).toBe('found');
    expect(walk.unknownFraction).toBeGreaterThan(0); // round the end of the box, through unknown chunks
    expect(walk.blocks).toBeGreaterThan(150);
    const mine = await layer.plan({ start: { x: 0.5, y: F, z: 0.5 }, goal: { x: 80.5, y: F, z: 0.5 }, modes: ['walk', 'mine'] });
    expect(mine.status, mine.reason).toBe('found');
    expect(mine.blocks).toBeLessThan(100);
    expect(mine.cost).toBeLessThan(walk.cost);
  });

  /** The open-sky-exit mineshaft: a stone hill x 0..30 (top F + 15), a room at its foot x 24..26 and a 1-wide staircase rising towards -x to the top. */
  function mineshaft(): GenWorld {
    const gen = flatGen();
    gen.fill({ x: 0, y: F, z: -5 }, { x: 30, y: F + 15, z: 5 }, 'stone');
    gen.fill({ x: 24, y: F, z: 0 }, { x: 26, y: F + 2, z: 0 }, 'air');
    for (let k = 0; k <= 16; k++) gen.fill({ x: 24 - k, y: F + k, z: 0 }, { x: 24 - k, y: F + k + 2, z: 0 }, 'air');
    return gen;
  }

  it('from the foot of a mineshaft: up the shaft to the hill top; the ground behind the 15-block cliff is none on foot', async () => {
    const { layer } = layerOf(mineshaft());
    const top = await layer.plan({ start: { x: 26.5, y: F, z: 0.5 }, goal: { x: 4.5, y: F + 16, z: 0.5 }, modes: ['walk'] });
    expect(top.status, top.reason).toBe('found');
    expect(top.legs[0]!.portals.length).toBeGreaterThanOrEqual(2); // section borders of the staircase and the mouth
    expect(Math.max(...all(top).map((w) => w.y))).toBeGreaterThanOrEqual(F + 14);
    const cliff = await layer.plan({ start: { x: 26.5, y: F, z: 0.5 }, goal: { x: -30.5, y: F, z: 0.5 }, modes: ['walk'] });
    expect(cliff.status).toBe('none');
  });
});

describe('coarse layer: unknown space, stable ids, feedback, fly', () => {
  it('crosses never-seen chunks at a price and says how much of the corridor is unknown', async () => {
    const gen = flatGen({ x: -64, y: -64, z: -32 }, { x: 192, y: 24, z: 64 });
    const { layer } = layerOf(gen, { known: (cx) => cx < 0 || cx > 1 });
    const c = await layer.plan({ start: { x: -20.5, y: F, z: 0.5 }, goal: { x: 50.5, y: F, z: 0.5 }, modes: ['walk'] });
    expect(c.status, c.reason).toBe('found');
    expect(c.unknownFraction).toBeGreaterThan(0.2);
    expect(c.unknownFraction).toBeLessThan(0.8);
    const known = await layerOf(gen).layer.plan({ start: { x: -20.5, y: F, z: 0.5 }, goal: { x: 50.5, y: F, z: 0.5 }, modes: ['walk'] });
    expect(c.cost).toBeGreaterThan(known.cost * 1.5); // unknown blocks cost more than known ones
  });

  it('portal ids and volume ids are stable across a rebuild and a change elsewhere in the chunk', async () => {
    const gen = caveWorld();
    const { layer, src } = layerOf(gen);
    const req = { start: { x: -60.5, y: -30, z: 0.5 }, goal: CAVE_GOAL, modes: ['walk'] as const };
    const a = await layer.plan(req);
    const ids = (c: Corridor) => c.legs.flatMap((l) => l.portals.map((p) => p.id));
    expect(ids(a).length).toBeGreaterThan(5);
    const rev = layer.revision;
    for (const l of a.legs) for (const v of l.volumes) layer.invalidate(Number(v.split(':')[1]), Number(v.split(':')[2]));
    expect(layer.revision).toBeGreaterThan(rev);
    const b = await layer.plan(req);
    expect(ids(b)).toEqual(ids(a));
    expect(b.legs[0]!.volumes).toEqual(a.legs[0]!.volumes);
    // a pillar placed far from the tunnel in the room's chunk: the tunnel's openings keep their ids
    gen.fill({ x: 108, y: -31, z: 2 }, { x: 108, y: -25, z: 2 }, 'stone');
    src.reset(108 >> 4, 2 >> 4);
    layer.invalidate(108 >> 4, 2 >> 4);
    const c = await layer.plan(req);
    expect(ids(c)).toEqual(ids(a));
    for (const id of ids(a)) expect(layer.portal(id)?.id).toBe(id);
  });

  /** A 3-high wall on the chunk border x = 15 across z -40..39 with 2-wide gaps at z -20 and z 20. */
  function gapsWorld(): GenWorld {
    const gen = flatGen();
    gen.fill({ x: 15, y: F, z: -40 }, { x: 15, y: F + 2, z: 39 }, 'stone');
    gen.fill({ x: 15, y: F, z: -21 }, { x: 15, y: F + 2, z: -20 }, 'air');
    gen.fill({ x: 15, y: F, z: 20 }, { x: 15, y: F + 2, z: 21 }, 'air');
    return gen;
  }

  it('markPortal failed re-routes through the other gap; the failure decays after 30 minutes', async () => {
    let now = 1_000_000;
    const { layer } = layerOf(gapsWorld(), { now: () => now });
    const req = { start: { x: 0.5, y: F, z: 0.5 }, goal: { x: 40.5, y: F, z: 0.5 }, modes: ['walk'] as const };
    const a = await layer.plan(req);
    expect(a.status, a.reason).toBe('found');
    const gap = a.legs[0]!.portals.find((p) => p.axis === 'x' && Math.floor(p.center.x) === 15)!;
    expect(gap).toBeDefined();
    expect(Math.abs(Math.abs(gap.center.z) - 20.5)).toBeLessThanOrEqual(1);
    expect(gap.clearance).toEqual({ height: 3, width: 2 });
    layer.markPortal(gap.id, 'walk', 'failed');
    const b = await layer.plan(req);
    expect(b.status, b.reason).toBe('found');
    const other = b.legs[0]!.portals.find((p) => p.axis === 'x' && Math.floor(p.center.x) === 15)!;
    expect(other.id).not.toBe(gap.id);
    expect(Math.sign(other.center.z)).toBe(-Math.sign(gap.center.z));
    layer.markPortal(other.id, 'walk', 'failed');
    const none = await layer.plan(req);
    expect(none.status === 'none' || none.blocks > 80).toBe(true); // round the wall's end (about 90 blocks) or nothing
    now += FAILED_DECAY_MS + 1;
    const again = await layer.plan(req);
    expect(again.status, again.reason).toBe('found');
    expect(again.blocks).toBeLessThan(70);
  });

  const stubFly = (): CoarseCost => ({
    mode: 'fly',
    clearance: { height: 3, width: 1 },
    ticksPerBlock: 0.7,
    unknownCost: 2,
    allows: (k) => k !== 'water',
    edgeCost(p, _from, to, blocks) {
      if (p.dug !== undefined || p.clearance.height < 3) return Infinity;
      return 5 + blocks * (to.kind === 'unknown' ? 2 : 0.7);
    },
    switchCost: (from, at) => (from === 'fly' ? 0 : at.floorCells > 0 ? 60 : Infinity),
  });

  it('a fly-only request with a stub fly cost: one fly leg, takeoff paid, far cheaper than walking', async () => {
    const gen = flatGen({ x: -64, y: -64, z: -32 }, { x: 320, y: 24, z: 64 });
    const { layer } = layerOf(gen);
    layer.setCost('fly', stubFly());
    const req = { start: { x: 0.5, y: F, z: 0.5 }, goal: { x: 200.5, y: F, z: 0.5 } };
    const fly = await layer.plan({ ...req, modes: ['fly'] });
    expect(fly.status, fly.reason).toBe('found');
    expect(fly.legs.every((l) => l.mode === 'fly')).toBe(true);
    expect(fly.legs[0]!.from).toEqual(req.start);
    expect(fly.legs.at(-1)!.to).toEqual(req.goal);
    const walk = await layer.plan({ ...req, modes: ['walk'] });
    expect(fly.cost).toBeLessThan(walk.cost / 2);
    expect(fly.cost).toBeGreaterThan(60); // the takeoff
    const gliding = await layer.plan({ ...req, modes: ['fly'], startMode: 'fly' });
    expect(gliding.cost).toBeLessThan(fly.cost); // already in the air: no takeoff
  });

  it('a mixed request lands at the cave mouth and walks in: the fly leg ends on the entry portal\'s floor', async () => {
    const { layer } = layerOf(caveWorld());
    layer.setCost('fly', stubFly());
    const c = await layer.plan({ start: { x: -60.5, y: -30, z: 0.5 }, goal: CAVE_GOAL, modes: ['walk', 'fly'] });
    expect(c.status, c.reason).toBe('found');
    expect(c.legs.map((l) => l.mode)).toEqual(['fly', 'walk']);
    const [fly, walk] = c.legs as [Corridor['legs'][0], Corridor['legs'][0]];
    expect(fly.to).toEqual(walk.from);
    expect(walk.entry).toBeDefined();
    expect(fly.to.y).toBe(walk.entry!.floorY);
    expect(Math.abs(fly.to.x)).toBeLessThanOrEqual(3);
    expect(fly.exit?.id).toBe(walk.entry?.id);
  });

  it('a partial corridor under a tiny node budget, none for a goal in solid', async () => {
    const { layer } = layerOf(caveWorld());
    const p = await layer.plan({ start: { x: -60.5, y: -30, z: 0.5 }, goal: CAVE_GOAL, modes: ['walk'], maxNodes: 3 });
    expect(p.status).toBe('partial');
    expect(p.reason).toContain('nodes');
    const solid = await layer.plan({ start: { x: -60.5, y: -30, z: 0.5 }, goal: { x: 50.5, y: -45, z: 10.5 }, modes: ['walk'] });
    expect(solid.status).toBe('none');
    expect(solid.reason).toContain('solid');
  });

  it('volumeAt and the graph shapes: sky over flat ground has its floor, the tunnel has a 2 x 1 clearance', async () => {
    const { layer } = layerOf(caveWorld());
    const sky = layer.volumeAt({ x: 5, y: -30, z: 5 })!;
    expect(sky.kind).toBe('sky');
    expect(sky.min.y).toBe(-30);
    expect(sky.floorCells).toBe(253); // 256 columns less the three staircase cells open at y -31 (x 0, 1, 2)
    const tunnel = layer.volumeAt({ x: 50, y: -50, z: 0 })!;
    expect(tunnel.kind).toBe('cave');
    expect(tunnel.floorCells).toBeGreaterThan(0);
    expect(tunnel.headroom?.min).toBe(3);
    expect(tunnel.minSpan).toBe(1);
    expect(layer.volumeAt({ x: 50, y: -55, z: 0 })).toBeUndefined();
    const c = await layer.plan({ start: { x: 30.5, y: -50, z: 0.5 }, goal: { x: 70.5, y: -50, z: 0.5 }, modes: ['walk'] });
    expect(c.status).toBe('found');
    expect(c.legs[0]!.minClearance).toEqual({ height: 2, width: 1 });
    expect(c.legs[0]!.portals.every((p) => p.floorY === -50)).toBe(true);
  });
});
