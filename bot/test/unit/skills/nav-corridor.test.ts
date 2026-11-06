// Track CB (ADR 0066, docs/coarse.md "Following a corridor on foot"): the navigator on a coarse corridor.
// The helper's windowing (the farthest waypoint within 32 blocks of corridor, the real goal once the
// rest is short, waypoints passed within 4 blocks, changes near the corridor), then closed loops on a
// generated world: a wall on a chunk border with one gap 40 blocks off the straight line (the fine
// planner alone, on a small budget, walks into the wall; with the corridor it goes to the gap), the
// corridor skipped for a near goal or coarseMin 0, and the feedback when waypoints cannot be reached
// (portals marked failed, the raw goal as the fallback).
import { describe, expect, it } from 'vitest';
import { CoarseLayerImpl, terrainSource, type Corridor, type CorridorLeg, type Portal } from '../../../src/skills/coarse/index.ts';
import { BotSkills } from '../../../src/skills/index.ts';
import { advance, corridorState, fineTarget, GOAL_DIRECT, remainingBlocks, touches, WAYPOINT_REACH, WINDOW_BLOCKS } from '../../../src/skills/nav/corridor.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, type GenWorld } from './genworld.ts';

const F = -60;

const portal = (id: string, x: number, z: number, floorY?: number): Portal => ({ id, a: 'a', b: 'b', axis: 'x', min: { x, y: F, z }, max: { x, y: F + 1, z }, center: { x, y: F + 1, z }, clearance: { height: 2, width: 1 }, ...(floorY === undefined ? {} : { floorY }), known: 'known' });

/** A one-leg corridor along +x with a portal every `step` blocks. */
function corridorAlongX(n: number, step: number, status: Corridor['status'] = 'found'): Corridor {
  const portals: Portal[] = [];
  const waypoints: Vec3[] = [{ x: 0.5, y: F, z: 0.5 }];
  for (let i = 1; i <= n; i++) {
    portals.push(portal(`0:x:${i * step}:${F}:0`, i * step, 0, F));
    waypoints.push({ x: i * step, y: F + 1, z: 0 });
  }
  const goal = { x: (n + 1) * step + 0.5, y: F, z: 0.5 };
  if (status === 'found') waypoints.push(goal);
  const leg: CorridorLeg = { mode: 'walk', from: waypoints[0]!, to: status === 'found' ? goal : waypoints.at(-1)!, portals, volumes: [], waypoints: status === 'found' ? waypoints : waypoints, blocks: (n + 1) * step, cost: 0, unknownFraction: 0, minClearance: { height: 2, width: 1 } };
  return { status, start: waypoints[0]!, goal, dim: 0, legs: [leg], blocks: (n + 1) * step, cost: 0, unknownFraction: 0, expanded: 0, ms: 0, revision: 0 };
}

describe('corridor following: the window (Track CB)', () => {
  it('waypoints sit on their portals\' floors; the goal is last for a found corridor', () => {
    const st = corridorState(corridorAlongX(5, 20))!;
    expect(st.wps).toHaveLength(6);
    expect(st.wps[0]).toEqual({ x: 20, y: F, z: 0 }); // the portal centre lowered to floorY
    expect(st.portals[0]?.id).toBe(`0:x:20:${F}:0`);
    expect(st.portals[5]).toBeUndefined();
    expect(st.toGoal).toBe(true);
    expect(corridorState({ ...corridorAlongX(5, 20), status: 'none', legs: [] })).toBeUndefined();
    const partial = corridorState(corridorAlongX(5, 20, 'partial'))!;
    expect(partial.toGoal).toBe(false);
    expect(partial.wps).toHaveLength(5);
  });

  it('aims at the farthest waypoint within the window, then the goal once the rest is short', () => {
    const st = corridorState(corridorAlongX(10, 10))!; // portals every 10 blocks, goal at 110
    const t0 = fineTarget(st, { x: 0.5, y: F, z: 0.5 })!;
    expect(t0.index).toBe(2); // 10, 20, 30 within 32 blocks of corridor
    expect(t0.p.x).toBe(30);
    expect(WINDOW_BLOCKS).toBe(32);
    const t1 = fineTarget(st, { x: 30.5, y: F, z: 0.5 })!;
    expect(st.next).toBe(3); // 10, 20, 30 passed
    expect(t1.index).toBe(5);
    expect(remainingBlocks(st, { x: 30.5, y: F, z: 0.5 })).toBeCloseTo(80, 0);
    const t2 = fineTarget(st, { x: 65.5, y: F, z: 0.5 });
    expect(st.next).toBe(6); // re-aimed at 70, the nearest upcoming waypoint (40 .. 60 passed another way)
    expect(t2).toBeUndefined(); // 45 blocks left <= GOAL_DIRECT: the real goal
    expect(GOAL_DIRECT).toBe(48);
  });

  it('a partial corridor keeps its last waypoint as a target; passed waypoints are those within reach', () => {
    const st = corridorState(corridorAlongX(3, 10, 'partial'))!;
    expect(fineTarget(st, { x: 25.5, y: F, z: 0.5 })?.index).toBe(2);
    advance(st, { x: 30.5, y: F, z: 0.5 });
    expect(st.next).toBe(3);
    expect(fineTarget(st, { x: 30.5, y: F, z: 0.5 })).toBeUndefined();
    expect(WAYPOINT_REACH).toBe(4);
  });

  it('touches: a change in a chunk of, or next to, a remaining waypoint', () => {
    const st = corridorState(corridorAlongX(5, 20))!;
    advance(st, { x: 40.5, y: F, z: 0.5 }); // 20 and 40 passed
    expect(touches(st, [{ cx: 0, cz: 0, dim: 0 }], 0)).toBe(false); // chunk 0 holds the start and waypoint 20 (passed)
    expect(touches(st, [{ cx: 2, cz: 1, dim: 0 }], 0)).toBe(true); // next to 40 (the one before next) and 60
    expect(touches(st, [{ cx: 6, cz: 0, dim: 0 }], 0)).toBe(true); // the goal's chunk
    expect(touches(st, [{ cx: 6, cz: 0, dim: 1 }], 0)).toBe(false);
  });
});

/** A 3-high wall on the chunk border x = 15 across z -56..55 with a 2-wide gap at z 40..41. */
function wallWorld(): GenWorld {
  const gen = flatGen({ x: -32, y: -64, z: -64 }, { x: 224, y: 24, z: 128 });
  gen.fill({ x: 15, y: F, z: -56 }, { x: 15, y: F + 2, z: 55 }, 'stone');
  gen.fill({ x: 15, y: F, z: 40 }, { x: 15, y: F + 2, z: 41 }, 'air');
  return gen;
}

async function walk(gen: GenWorld, goal: Vec3, opts: { minBlocks: number; maxNodes?: number; ticks?: number }) {
  const { conn, loop } = harness({ x: 0.5, y: F, z: 0.5 });
  const skills = new BotSkills({ loop, world: fakeWorld(gen), ...(opts.maxNodes ? { path: { maxNodes: opts.maxNodes } } : {}) });
  const layer = new CoarseLayerImpl(terrainSource(gen));
  skills.nav.attachCoarse(layer, { minBlocks: () => opts.minBlocks });
  conn.tick(5);
  const p = skills.goto({ type: 'block', p: goal });
  for (let t = 0; t < (opts.ticks ?? 6000) && skills.nav.busy; t++) {
    conn.tick();
    await new Promise((r) => setImmediate(r)); // the corridor search runs in slices between ticks
  }
  skills.cancel();
  const result = await p;
  const rep = skills.status().lastGoto!;
  skills.dispose();
  return { result, rep, layer, pos: loop.state.pos };
}

describe('corridor following: closed loop (Track CB)', () => {
  it('walks through the gap 40 blocks off the line to a goal 120 blocks away, following the corridor', async () => {
    const { result, rep, pos } = await walk(wallWorld(), { x: 120, y: F, z: 0 }, { minBlocks: 96, maxNodes: 3000 });
    expect(result, JSON.stringify(rep.plans)).toEqual({ ok: true });
    expect(rep.corridor?.status).toBe('found');
    expect(rep.corridor?.requests).toBe(1);
    expect(rep.corridor?.waypoints).toBeGreaterThanOrEqual(3); // the gap and the chunk borders beyond it
    expect(rep.corridor?.passed).toBeGreaterThanOrEqual(1);
    expect(rep.corridor?.failed).toBe(0);
    expect(Math.hypot(pos.x - 120.5, pos.z - 0.5)).toBeLessThan(2);
    const plain = await walk(wallWorld(), { x: 120, y: F, z: 0 }, { minBlocks: 0, maxNodes: 3000 });
    console.log(`corridor goto: ${rep.ticks} ticks, ${rep.plans.length} plans; without the corridor: ${JSON.stringify(plain.result)} after ${plain.rep.ticks} ticks, ${plain.rep.plans.length} plans`);
  }, 60_000);

  it('no corridor for a goal nearer than coarseMin, or with coarseMin 0', async () => {
    const near = await walk(flatGen(), { x: 30, y: F, z: 0 }, { minBlocks: 96 });
    expect(near.result).toEqual({ ok: true });
    expect(near.rep.corridor).toBeUndefined();
    const off = await walk(wallWorld(), { x: 120, y: F, z: 0 }, { minBlocks: 0, ticks: 200 });
    expect(off.rep.corridor).toBeUndefined();
  }, 30_000);

  it('waypoints the fine planner cannot reach mark their portals failed and fall back to the raw goal', async () => {
    const { result, rep, layer } = await walk(wallWorld(), { x: 120, y: F, z: 0 }, { minBlocks: 96, maxNodes: 2 });
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
    expect(rep.corridor?.failed).toBeGreaterThanOrEqual(1);
    expect(rep.corridor!.requests).toBeGreaterThanOrEqual(2); // a fresh corridor after each failed waypoint
    expect(layer.marks.size).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
