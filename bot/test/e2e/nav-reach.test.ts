// e2e (tag @bds), Track R1 (docs/pathfinding.md "Reachability (Track R1)", decisions/0072-reachability.md): a station
// for each failure class the reachability bench (scripts/reach-bench.ts) found, and for the "why unreachable" answers,
// on bds-fly (udp 19204; REACH_BDS_PORT / REACH_BDS_CONTAINER move it). The truth pack builds each station
// (`truth:water build`: packs/truth/src/water-layout.ts R1_STATIONS, the geometry the unit tests walk in the bench's
// closed loop, nav-reach-stations.test.ts); the bot walks from its start to its goal as `!goto` does (the dig way on,
// the planner worker, `explain`):
//   lavaRun    the path through a lava floor with two corners: walked to its end, unhurt
//   tower3     the 3-high stone column: climbed by the dig way, the goal's floor kept
//   vault      the room sealed in bedrock: unreachable, cause `world`, nothing broken
//   brickRoom  the closed stone-brick room: unreachable, cause `rule:built`, nothing broken
// REACH_OUT=<file> writes the summary there as well.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NavGoal } from '../../src/skills/nav/goals.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { R1_STATIONS, type WaterStationName } from '../../../packs/truth/src/water-layout.ts';
import { bdsTarget } from './env.ts';
import { E2E, connectBot, describeCorrections, disconnectBot, fmt, sleep, teleport, type MoveBot } from './move-truth.ts';
import { privateOrigin } from './nav-worlds.ts';

const PORT = Number(process.env.REACH_BDS_PORT ?? 19204);
const CONTAINER = process.env.REACH_BDS_CONTAINER ?? 'bds-fly';
const TARGET = bdsTarget('127.0.0.1', PORT);
/** Stations along +x, this far apart (a footprint is x -4..4), on a row of their own (z + ROW: past the water course's). */
const SPACING = 12;
const ROW = 48;

interface Built {
  name: string;
  origin: Vec3;
  start: Vec3;
  goal: Vec3;
  ticks: number;
}

describe.skipIf(!E2E)('@bds nav: reachability stations (Track R1, bds-fly)', () => {
  let bot: MoveBot;
  const o = { ...privateOrigin(), y: -60 };
  const summary: string[] = [];
  const built = new Map<string, Built>();
  const at = (i: number): Vec3 => ({ x: o.x + i * SPACING, y: o.y, z: o.z + ROW });

  const water = async (sub: 'build' | 'clear', name: WaterStationName, p: Vec3): Promise<Built> => {
    const r = await bot.truth.cmd<Built>('water', [sub, name, p.x, p.y, p.z], 180_000);
    if (!r.ok) throw new Error(`truth:water ${sub} ${name}: ${r.reason}`);
    return r.data;
  };

  beforeAll(async () => {
    bot = await connectBot('NavReach', { target: TARGET, container: CONTAINER });
    await teleport(bot, { x: o.x + 0.5, y: o.y, z: o.z + ROW - 3.5 });
    for (const [i, name] of R1_STATIONS.entries()) {
      const b = await water('build', name, at(i));
      built.set(name, b);
      summary.push(`built ${name} at ${fmt(b.origin)} in ${b.ticks} ticks`);
    }
  }, 600_000);

  afterAll(async () => {
    const text = `[nav-reach e2e] area ${o.x},${o.z + ROW}\n  ${summary.join('\n  ')}`;
    console.log(text);
    if (process.env.REACH_OUT) writeFileSync(process.env.REACH_OUT, text);
    try {
      if (bot) {
        await teleport(bot, { x: o.x + 0.5, y: o.y, z: o.z + ROW - 3.5 });
        for (const [i, name] of R1_STATIONS.entries()) await water('clear', name, at(i));
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 600_000);

  /** The inventory emptied (by hand, as the flight kit has it). */
  async function emptyHands(): Promise<void> {
    await bot.truth.ok('clear', [bot.name]);
    for (let i = 0; i < 100; i++) {
      if (bot.world.inventory.slots.slice(0, 36).every((x) => !x)) break;
      await sleep(50);
    }
    await bot.loop.waitTicks(5);
  }

  /** A `!goto` as the session runs it: the dig way on, the planner worker, `explain`; the lowest health watched. */
  async function station(name: WaterStationName) {
    const b = built.get(name)!;
    await emptyHands();
    bot.skills.nav.digWay = () => true;
    const detach = bot.skills.nav.attachPlanner(bot.world, { threads: () => 1 });
    await sleep(1500);
    try {
      await teleport(bot, b.start, 0);
      await bot.loop.waitTicks(10);
      const c0 = bot.corrections.length;
      let minHealth = bot.world.self.health;
      const off = bot.loop.onBeforeStep(() => {
        minHealth = Math.min(minHealth, bot.world.self.health);
      });
      const t0 = performance.now();
      const navGoal: NavGoal = { type: 'block', p: b.goal };
      const res = await bot.skills.goto(navGoal, { timeoutTicks: 1500, explain: true });
      const ms = performance.now() - t0;
      await bot.loop.waitTicks(10);
      off();
      const rep = bot.skills.status().lastGoto!;
      const got = bot.corrections.slice(c0);
      const truth = await bot.truth.pos(bot.name);
      const health = (truth as unknown as { health: number | null }).health;
      const line =
        `${name}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks (${(ms / 1000).toFixed(1)} s), ${rep.distance.toFixed(1)} blocks, ${rep.plans.length} plan(s), broken ${rep.actions.dig}, ` +
        `min health ${minHealth}, truth health ${health}, ${rep.why ? `why "${rep.why}", ` : ''}${got.length} correction(s), stuck ${rep.stuck}, end ${fmt(truth.location)}${describeCorrections(got)}`;
      summary.push(line);
      return { res, rep, minHealth, health, truth, line, b };
    } finally {
      bot.skills.nav.digWay = () => false;
      detach();
    }
  }

  const near = (p: Vec3, goal: Vec3): boolean => Math.hypot(p.x - (goal.x + 0.5), p.z - (goal.z + 0.5)) < 1.2 && Math.abs(p.y - goal.y) < 0.6;

  it('lavaRun: the path through the lava floor, two corners: walked to its end, unhurt', async () => {
    const r = await station('lavaRun');
    expect(r.res, r.line).toEqual({ ok: true });
    expect(near(r.truth.location, r.b.goal), r.line).toBe(true);
    expect(r.minHealth, r.line).toBe(20);
    expect(r.health, r.line).toBe(20);
  }, 180_000);

  it('tower3: the 3-high stone column climbed by the dig way, the goal floor kept', async () => {
    const r = await station('tower3');
    expect(r.res, r.line).toEqual({ ok: true });
    expect(near(r.truth.location, r.b.goal), r.line).toBe(true);
    expect(r.rep.actions.dig, r.line).toBeGreaterThan(0);
    expect(r.rep.actions.dig, r.line).toBeLessThanOrEqual(12);
    expect(bot.world.blockAt({ x: r.b.goal.x, y: r.b.goal.y - 1, z: r.b.goal.z })?.name, r.line).toBe('stone');
    expect(r.minHealth, r.line).toBe(20);
  }, 300_000);

  it('vault: the room sealed in bedrock is unreachable, the world closing it (cause world), nothing broken', async () => {
    const r = await station('vault');
    expect(r.res.ok, r.line).toBe(false);
    expect(r.res, r.line).toMatchObject({ reason: 'unreachable', cause: 'world' });
    expect(r.rep.actions.dig, r.line).toBe(0);
  }, 180_000);

  it('brickRoom: the closed room of built blocks is unreachable by the rule on built blocks (cause rule:built), nothing broken', async () => {
    const r = await station('brickRoom');
    expect(r.res.ok, r.line).toBe(false);
    expect(r.res, r.line).toMatchObject({ reason: 'unreachable', cause: 'rule:built' });
    expect(r.rep.actions.dig, r.line).toBe(0);
  }, 180_000);
});
