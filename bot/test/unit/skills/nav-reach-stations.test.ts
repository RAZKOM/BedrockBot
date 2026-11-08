// Track R1 (docs/pathfinding.md "Reachability (Track R1)", decisions/0072-reachability.md): the reachability stations
// (packs/truth/src/water-layout.ts R1_STATIONS, the very geometry the nav-reach e2e walks on bds-fly) walked by the REAL
// navigator in the bench's closed loop (reach-sim.ts: the worker, the coarse layer, chunks round the body) and judged
// by the oracle (nav/bench/oracle.ts): the lava path walked unhurt, the 3-high column climbed with its top kept, the
// bedrock vault unreachable as `world`, the brick room unreachable as `rule:built`.
// Then the bench pairs that died beside lava, and the causes for a mid-air goal, a goal cell in the rock and an unloaded
// goal from a pocket the owner's rules close.
import { afterAll, describe, expect, it } from 'vitest';
import { R1_STATIONS, waterStation, type WaterBlock, type WaterStationName } from '../../../../packs/truth/src/water-layout.ts';
import { OWNER_RULES, verdict } from '../../../src/skills/nav/bench/oracle.ts';
import { V, Vox } from '../../../src/skills/nav/bench/vox.ts';
import { benchWorld, type BenchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { runPair, type PairRun } from './reach-sim.ts';

const O = { x: 24, y: -60, z: 12 };
const TOOLS = ['iron_pickaxe', 'iron_shovel'];
const BLOCK: Record<WaterBlock, number> = { air: V.air, stone: V.stone, dirt: V.dirt, grass_block: V.grass, water: V.water, stone_bricks: V.bricks, lava: V.lava, bedrock: V.bedrock };

/** The flat world (bedrock -64, dirt -63 and -62, grass -61) with the station built on it. */
function stationWorld(name: WaterStationName): { bw: BenchWorld; start: Vec3; goal: Vec3 } {
  const st = waterStation(name, O)!;
  const v = new Vox(48, 48);
  v.fill({ x: 0, y: -64, z: 0 }, { x: 47, y: -64, z: 47 }, V.bedrock);
  v.fill({ x: 0, y: -63, z: 0 }, { x: 47, y: -62, z: 47 }, V.dirt);
  v.fill({ x: 0, y: -61, z: 0 }, { x: 47, y: -61, z: 47 }, V.grass);
  for (const op of st.ops) v.fill(op.from, op.to, BLOCK[op.block]);
  const start = { x: Math.floor(st.start.x), y: Math.floor(st.start.y), z: Math.floor(st.start.z) };
  const bw: BenchWorld = { cls: 'builds', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start, goal: st.goal, tag: name }] };
  return { bw, start, goal: st.goal };
}

const runs = new Map<string, PairRun>();
async function walk(name: WaterStationName): Promise<{ run: PairRun; bw: BenchWorld; goal: Vec3; oracle: ReturnType<typeof verdict> }> {
  const { bw, start, goal } = stationWorld(name);
  const oracle = verdict(bw.vox, start, goal, { ...OWNER_RULES, tools: TOOLS });
  const run = await runPair(bw, bw.pairs[0]!, new Map(), { tools: TOOLS, logLines: 200 });
  runs.set(name, run);
  return { run, bw, goal, oracle };
}

describe('Track R1 stations (water-layout R1_STATIONS) in the closed loop', () => {
  afterAll(() => {
    for (const [name, r] of runs) if (!r.ok && r.cause === undefined) console.log(`${name}: ${r.reply}\n  ${r.log.slice(-30).join('\n  ')}`);
  });

  it('names every station', () => {
    expect([...R1_STATIONS]).toEqual(['lavaRun', 'tower3', 'vault', 'brickRoom']);
  });

  it('lavaRun: the path through the lava floor is walked to its end, unhurt', async () => {
    const { run, oracle } = await walk('lavaRun');
    expect(oracle.verdict).toBe('reachable');
    expect(run.ok, run.reply).toBe(true);
    expect(run.damage).toBe(0);
    expect(run.died).toBe(false);
  }, 120_000);

  it('tower3: the 3-high column is climbed by the dig way, its top (the goal floor) kept', async () => {
    const { run, goal, oracle } = await walk('tower3');
    expect(oracle.verdict).toBe('reachable');
    expect(run.ok, run.reply).toBe(true);
    expect(run.dug).toBeGreaterThan(0);
    expect(run.dug).toBeLessThanOrEqual(12);
    // (runPair puts the world back afterwards: the floor is read off the run's log of digs)
    expect(run.log.some((l) => l.includes(`dig ${goal.x},${goal.y - 1},${goal.z} `))).toBe(false);
  }, 120_000);

  it('vault: a room sealed in bedrock is unreachable, the world closing it (cause world)', async () => {
    const { run, oracle } = await walk('vault');
    expect(oracle.verdict).toBe('world');
    expect(run.ok).toBe(false);
    expect(run.reason).toBe('unreachable');
    expect(run.cause).toBe('world');
    expect(run.note).toMatch(/^world: /);
  }, 120_000);

  it('brickRoom: a closed room of built blocks is unreachable by the rule on built blocks (cause rule:built)', async () => {
    const { run, oracle } = await walk('brickRoom');
    expect(oracle.verdict).toBe('rule');
    expect(oracle.rules).toContain('built');
    expect(run.ok).toBe(false);
    expect(run.reason).toBe('unreachable');
    expect(run.cause).toBe('rule:built');
    expect(run.note).toMatch(/built blocks/);
  }, 120_000);
});

describe('Track R1: the bench pairs that died beside lava (a turn by a lava cell, the lava flowing as the server has it)', () => {
  for (const [seed, pair] of [
    [6, 0],
    [6, 10],
    [7, 10],
    [4, 12],
    [11, 10],
    [20, 9],
    [2, 12],
  ] as const) {
    it(`lava:${seed}:${pair}: no death, no lava damage`, async () => {
      const bw = benchWorld('lava', seed);
      const run = await runPair(bw, bw.pairs[pair]!, new Map(), { tools: TOOLS });
      expect(run.died, run.reply).toBe(false);
      expect(run.damage).toBe(0);
    }, 120_000);
  }
});

describe('Track R1: plans that lead back (a dead end, two partial ends, a flooded tunnel)', () => {
  it('hills:20:13: sent back off the path to one cell again and again is no progress: the next level, then arrived', async () => {
    const bw = benchWorld('hills', 20);
    const run = await runPair(bw, bw.pairs[13]!, new Map(), { tools: TOOLS, speed: 1.25 });
    expect(run.reply).toBe('arrived');
    expect(run.ticks).toBeLessThan(4500); // (the goto's cap is 6000: it timed out there)
  }, 120_000);

  it('lava:14:10: partial ends that lead to each other are no progress: the next level, then arrived (not the goto cap)', async () => {
    const bw = benchWorld('lava', 14);
    const run = await runPair(bw, bw.pairs[10]!, new Map(), { tools: TOOLS, speed: 1.25 });
    expect(run.died).toBe(false);
    expect(run.reply).toBe('arrived');
  }, 120_000);

  it('water:12:8: the dive into a flooded tunnel two high is sunk under its roof, no drowning', async () => {
    const bw = benchWorld('water', 12);
    const run = await runPair(bw, bw.pairs[8]!, new Map(), { tools: TOOLS, speed: 1.25 });
    expect(run.died, run.reply).toBe(false);
    expect(run.reply).toBe('arrived');
  }, 120_000);
});

describe('Track R1: the cause when the goal cell or the loaded world closes the way', () => {
  it('a goal cell in mid-air over open ground is a block placed under it away: rule:place', async () => {
    const v = new Vox(48, 48);
    v.fill({ x: 0, y: -64, z: 0 }, { x: 47, y: -64, z: 47 }, V.bedrock);
    v.fill({ x: 0, y: -63, z: 0 }, { x: 47, y: -61, z: 47 }, V.dirt);
    const start = { x: 24, y: -60, z: 12 };
    const goal = { x: 24, y: -57, z: 30 };
    const bw: BenchWorld = { cls: 'builds', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start, goal, tag: 'midAir' }] };
    const oracle = verdict(v, start, goal, { ...OWNER_RULES, tools: TOOLS });
    expect(oracle.verdict).toBe('rule');
    expect(oracle.rules).toContain('place');
    const run = await runPair(bw, bw.pairs[0]!, new Map(), { tools: TOOLS, logLines: 200 });
    expect(run.ok).toBe(false);
    expect(run.cause, run.reply).toBe('rule:place');
  }, 120_000);

  it('a goal cell inside a natural block is dug out by the dig way and reached (a corridor portal cell in the rock)', async () => {
    const v = new Vox(48, 48);
    v.fill({ x: 0, y: -64, z: 0 }, { x: 47, y: -64, z: 47 }, V.bedrock);
    v.fill({ x: 0, y: -63, z: 0 }, { x: 47, y: -61, z: 47 }, V.dirt);
    v.fill({ x: 22, y: -60, z: 28 }, { x: 26, y: -59, z: 32 }, V.stone);
    const start = { x: 24, y: -60, z: 12 };
    const goal = { x: 24, y: -60, z: 30 };
    const bw: BenchWorld = { cls: 'caves', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start, goal, tag: 'inRock' }] };
    const run = await runPair(bw, bw.pairs[0]!, new Map(), { tools: TOOLS, logLines: 200 });
    expect(run.ok, `${run.reply}\n${run.log.slice(-12).join('\n')}`).toBe(true);
    expect(run.dug).toBeGreaterThan(0);
    expect(run.dug).toBeLessThanOrEqual(12);
  }, 120_000);

  it('a goal in unloaded world from a pocket the owner rules close (20 blocks of stone overhead): the rule, not "unloaded"', async () => {
    const v = new Vox(192, 48);
    v.fill({ x: 0, y: -64, z: 0 }, { x: 191, y: -64, z: 47 }, V.bedrock);
    v.fill({ x: 0, y: -63, z: 0 }, { x: 191, y: -30, z: 47 }, V.stone);
    v.fill({ x: 0, y: -29, z: 0 }, { x: 191, y: -29, z: 47 }, V.grass);
    v.fill({ x: 8, y: -50, z: 20 }, { x: 10, y: -48, z: 22 }, V.air);
    const start = { x: 9, y: -50, z: 21 };
    const goal = { x: 180, y: -28, z: 21 };
    const bw: BenchWorld = { cls: 'caves', seed: 0, vox: v, loadRadius: 2, coarse: false, pairs: [{ start, goal, tag: 'pocket' }] };
    const run = await runPair(bw, bw.pairs[0]!, new Map(), { tools: TOOLS, logLines: 200 });
    expect(run.ok).toBe(false);
    expect(run.reason).toBe('unreachable');
    expect(run.cause, `${run.reply}\n${run.log.slice(-12).join('\n')}`).toBe('rule:dig_budget');
  }, 180_000);
});
