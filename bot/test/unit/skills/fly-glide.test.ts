// Track BH (docs/flight.md "Glide down" and "Ledge takeoff"): the ledge search, the ledge takeoff of the
// brain on stepBody, the glide down simulated from a pillar / a cliff, the glide that cannot reach, and the
// takeoff from under an overhang (the Realm's farm platform under the spawning box).
import { describe, expect, it } from 'vitest';
import { flatWorld, withBoxes, type BlockQuery } from '../../../src/skills/input/index.ts';
import { findLedges, jumpTakeoff, ledgeFall, ledgeTakeoff, planGlideDown, simulateFlight, smallPlatform, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { headCells, recoverProne } from '../../../src/skills/fly/prone.ts';
import { columnKey, cruiseHeight, yawDiff, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';

const FEET = -60;
interface Box {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  solid: boolean;
}

function rig(boxes: Box[]) {
  const world: BlockQuery = withBoxes(flatWorld(), boxes);
  const cell: CellQuery = (x, y, z) => world.solidAt(x, y, z);
  const skyTop = (x: number, z: number): number => {
    for (let y = 200; y >= -64; y--) if (world.solidAt(x, y, z)) return y;
    return -64;
  };
  const groundAt = (x: number, z: number, fromY = 200): number => {
    for (let y = Math.floor(fromY); y >= -64; y--) if (world.solidAt(x, y, z)) return y + 1;
    return -63;
  };
  const deps: SimDeps & { cell: CellQuery } = { world, cell, skyTop, groundAt };
  return { world, cell, deps };
}

/** A walk landing on the flat ground: a square of cells around (x, z). */
function groundTarget(x: number, z: number, r = 3): LandingTarget {
  const cells = new Set<number>();
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) cells.add(columnKey(x + dx, z + dz));
  return { x: x + 0.5, z: z + 0.5, top: FEET, half: r + 0.5, cells, walk: true };
}

/** A 3 x 3 pillar centred on (0, 0) whose top is `up` blocks over the ground (the feet on it at FEET + up). */
const pillar = (up: number): Box => ({ from: { x: -1, y: FEET, z: -1 }, to: { x: 1, y: FEET + up - 1, z: 1 }, solid: true });

describe('fly glide: the ledges of a platform', () => {
  it('a 3 x 3 pillar is a small platform with an edge on every side; the best faces the target', () => {
    const { cell } = rig([pillar(40)]);
    const from = { x: 0.5, y: FEET + 40, z: 0.5 };
    expect(smallPlatform(cell, from)).toBe(true);
    expect(smallPlatform(rig([]).cell, { x: 0.5, y: FEET, z: 0.5 })).toBe(false);
    const r = findLedges(cell, from, 0); // the target towards +z
    expect(r.ledges.length).toBeGreaterThanOrEqual(8);
    expect(Math.abs(yawDiff(r.ledges[0]!.yaw, 0))).toBeLessThan(1);
    expect(r.ledges[0]!.z).toBe(1); // the +z row of the pillar
    expect(r.ledges[0]!.drop).toBe(40);
  });

  it('a wall in the fall corridor or too little drop rules an edge out', () => {
    const wall: Box = { from: { x: -3, y: FEET, z: 6 }, to: { x: 3, y: FEET + 45, z: 6 }, solid: true };
    const { cell } = rig([pillar(40), wall]);
    const r = findLedges(cell, { x: 0.5, y: FEET + 40, z: 0.5 }, 0);
    expect(r.ledges.every((l) => Math.abs(yawDiff(l.yaw, 0)) > 1)).toBe(true);
    const low = findLedges(rig([pillar(6)]).cell, { x: 0.5, y: FEET + 6, z: 0.5 }, 0);
    expect(low.ledges).toHaveLength(0);
    expect(low.why).toMatch(/less than 12 blocks of drop/);
  });

  it('the brain steps off the edge sneaking, glides as the fall begins and flies within the minimum drop', async () => {
    const { deps, cell } = rig([pillar(40)]);
    const l = findLedges(cell, { x: 0.5, y: FEET + 40, z: 0.5 }, 0).ledges[0]!;
    const f = await ledgeFall(deps, l);
    expect(f.ok, f.why).toBe(true);
    expect(f.drop!).toBeGreaterThan(0.5);
    expect(f.drop!).toBeLessThan(11);
  });
});

describe('fly glide: the glide down', () => {
  it('from a 3 x 3 pillar 40 up to the ground 60 blocks away: lands on the cells without a rocket, no hit', async () => {
    const { deps } = rig([pillar(40)]);
    const target = groundTarget(0, 60);
    const g = await planGlideDown(deps, { x: 0.5, y: FEET + 40, z: 0.5 }, target, { minDrop: 10, minDistance: 16 });
    expect(g.ok, g.line).toBe(true);
    if (!g.ok) return;
    expect(g.sim.stats.rockets).toBe(0);
    expect(g.sim.hits).toBe(0);
    expect(g.sim.stats.ledgeDrop).toBeDefined();
  });

  it('from a cliff top (a wide plateau 40 up) to the ground 80 blocks out: walks to the edge on the target side', async () => {
    const cliff: Box = { from: { x: -30, y: FEET, z: -30 }, to: { x: 30, y: FEET + 39, z: 5 }, solid: true };
    const { deps } = rig([cliff]);
    const g = await planGlideDown(deps, { x: 0.5, y: FEET + 40, z: 0.5 }, groundTarget(0, 80), { minDrop: 10, minDistance: 16 });
    expect(g.ok, g.line).toBe(true);
    if (!g.ok) return;
    expect(g.ledge.z).toBe(5);
    expect(Math.abs(yawDiff(g.ledge.yaw, 0))).toBeLessThan(1);
  });

  it('a pillar 12 up with the goal 150 away: no simulated glide lands there (the walk failure stands)', async () => {
    const { deps } = rig([pillar(12)]);
    const g = await planGlideDown(deps, { x: 0.5, y: FEET + 12, z: 0.5 }, groundTarget(0, 150), { minDrop: 10, minDistance: 16 });
    expect(g.ok).toBe(false);
    expect(g.ok ? '' : g.why).toMatch(/no simulated glide lands there/);
  });

  it('the goal not lower than the drop limit: refused before any simulation', async () => {
    const { deps } = rig([pillar(40)]);
    const g = await planGlideDown(deps, { x: 0.5, y: FEET + 40, z: 0.5 }, { ...groundTarget(0, 60), top: FEET + 35 }, { minDrop: 10, minDistance: 16 });
    expect(g.ok).toBe(false);
    expect(g.ok ? '' : g.why).toMatch(/only 5 blocks below/);
  });
});

describe('fly glide: the ledge takeoff from under an overhang (the Realm farm, 2026-10-31)', () => {
  // the farm replica of fly-overhang: a 9 x 7 platform 70 up, a spawning box 12 over it overhanging it on every side but +x (it ends a block past the platform)
  const Y = FEET + 70;
  const farm: Box[] = [
    { from: { x: -4, y: Y - 1, z: -3 }, to: { x: 4, y: Y - 1, z: 3 }, solid: true },
    { from: { x: -26, y: Y + 12, z: -15 }, to: { x: 5, y: Y + 23, z: 14 }, solid: true },
  ];
  it('a far goal: the takeoff steps off the platform, glides out from under the box and climbs without a hit', async () => {
    const { deps } = rig(farm);
    const from = { x: 0.5, y: Y, z: 0.5 };
    const target: LandingTarget = { x: 2000.5, z: 0.5, top: FEET, half: 1 }; // far away towards +x, far lower
    const cz = cruiseHeight(from, target, deps.skyTop!, {});
    const r = await ledgeTakeoff(deps, from, target, { cruiseY: cz.y }, 64);
    expect(r.ledge, r.line).toBeDefined();
    // the whole first 40 s of that flight on the model: no hit, never in the box
    const l = r.ledge!;
    const sim = await simulateFlight(deps, { x: l.x + 0.5, y: l.feet, z: l.z + 0.5 }, target, { cruiseY: cz.y, ledge: { yaw: l.yaw } }, { rockets: 64, maxTicks: 800 });
    expect(sim.hits).toBe(0);
    expect(sim.end).toBeUndefined();
    expect(sim.body.pos.y).toBeGreaterThan(Y + 23);
  });
});

describe('fly glide: the jump takeoff simulated (the Realm canopy, 2026-10-31 04:46Z)', () => {
  it('a wide canopy 8 to 13 up across the takeoff heading: that heading hits, another one clears', async () => {
    const canopy: Box = { from: { x: -12, y: FEET + 8, z: 4 }, to: { x: 12, y: FEET + 13, z: 30 }, solid: true };
    const { deps } = rig([canopy]);
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const target: LandingTarget = { x: 0.5, z: 600.5, top: FEET, half: 1 };
    const cz = cruiseHeight(from, target, deps.skyTop!, {});
    const straight = await jumpTakeoff(deps, from, target, { cruiseY: cz.y }, 64, [0]);
    expect(straight.line).toMatch(/heading 0: (clear only by steering|hits a solid)/);
    const any = await jumpTakeoff(deps, from, target, { cruiseY: cz.y }, 64, [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]);
    expect(any.yaw, any.line).toBeDefined();
    expect(Math.abs(yawDiff(any.yaw!, 0))).toBeGreaterThan(1);
  });
});

describe('fly glide: prone after a glide (the cells over the body)', () => {
  it('a body prone under leaves 1 above: the leaves over it are broken first; a protected block refuses', async () => {
    const solid = new Map<string, string>([
      ['0,1,0', 'oak_leaves'],
      ['1,1,0', 'oak_log'],
    ]);
    const block = (x: number, y: number, z: number) => {
      const n = solid.get(`${x},${y},${z}`);
      return n ? { name: n, solid: true } : { name: 'air', solid: false };
    };
    expect(headCells({ x: 0.5, y: 0, z: 0.5 }, block).map((c) => c.name)).toEqual(['oak_leaves']);
    expect(headCells({ x: 0.8, y: 0, z: 0.5 }, block).map((c) => c.name)).toEqual(['oak_leaves', 'oak_log']);
    let prone = true;
    const dug: string[] = [];
    const r = await recoverProne({
      pos: () => ({ x: 0.5, y: 0, z: 0.5 }),
      prone: () => prone,
      block,
      breakBlocker: () => undefined,
      dig: (p) => {
        dug.push(`${p.x},${p.y},${p.z}`);
        solid.delete(`${p.x},${p.y},${p.z}`);
        prone = false;
        return Promise.resolve({ ok: true });
      },
      waitTicks: () => Promise.resolve(),
    });
    expect(r.ok).toBe(true);
    expect(dug).toEqual(['0,1,0']);
    const refused = await recoverProne({
      pos: () => ({ x: 0.5, y: 0, z: 0.5 }),
      prone: () => true,
      block: (_x, y) => (y === 1 ? { name: 'chest', solid: true } : { name: 'air', solid: false }),
      breakBlocker: () => 'protected',
      dig: () => Promise.resolve({ ok: true }),
      waitTicks: () => Promise.resolve(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.why).toMatch(/may not be broken \(protected\)/);
  });
});
