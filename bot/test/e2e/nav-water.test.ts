// e2e (tag @bds), Track W1 (docs/pathfinding.md "Water (Track W1)", decisions/0070-water-travel.md): walking and
// following through water on bds-fly (udp 19204; WATER_BDS_PORT / WATER_BDS_CONTAINER move it). The truth pack
// builds each station of the water course (`truth:water build`: packs/truth/src/water-layout.ts, the same layouts
// the unit tests plan on) in a private area; the bot walks from each start to its goal with the server's air
// supply wired into its plans (as the session does), and follows a second client moved through a pool by
// truth:tp. Per station: completion, time, the air low-point (set_entity_data `air`, 0..300), damage (the
// lowest health the server reported) and corrections. W1_OUT=<file> writes the summary there as well.
// Track W2 (docs/pathfinding.md "Digging out of water (Track W2)"): the dig-out pools (DIG_OUT_STATIONS) with the
// inventory set per run: out over a dirt lip by hand, a stone lip refused by hand (trapped) and dug with a wooden
// pickaxe, a stair cut up a 3-high bank, a stone-brick rim refused (trapped); per run the blocks broken as well.
// Track W3 (docs/pathfinding.md "When the plain walk finds no way (Track W3)"): with the dig way on (as the
// session's setting digWay has it), a 2-high stone step and a 3-high dirt step dug by hand, a 6-high stone plateau
// dug down by hand with no fall damage, and a block goal in a 1-deep water floor (W3_STATIONS).
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import { silentLogger } from '../../src/log.ts';
import { FollowController } from '../../src/skills/follow/follow.ts';
import type { NavGoal } from '../../src/skills/nav/goals.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { DIG_OUT_STATIONS, W1_STATIONS, W3_STATIONS, WATER_STATIONS, waterStation, type WaterStationName } from '../../../packs/truth/src/water-layout.ts';
import { E2E_VERSION, bdsTarget } from './env.ts';
import { E2E, connectBot, describeCorrections, disconnectBot, fmt, sleep, teleport, type MoveBot } from './move-truth.ts';
import { privateOrigin } from './nav-worlds.ts';

const PORT = Number(process.env.WATER_BDS_PORT ?? 19204);
const CONTAINER = process.env.WATER_BDS_CONTAINER ?? 'bds-fly';
const TARGET = bdsTarget('127.0.0.1', PORT);
/** Stations along +x, this far apart (a footprint is x -4..4). */
const SPACING = 12;

interface Built {
  name: string;
  origin: Vec3;
  start: Vec3;
  deepStart?: Vec3;
  goal: Vec3;
  surfaceY: number;
  ticks: number;
}

describe.skipIf(!E2E)('@bds nav: water (Track W1, bds-fly)', () => {
  let bot: MoveBot;
  const o = { ...privateOrigin(), y: -60 };
  const summary: string[] = [];
  const built = new Map<string, Built>();
  /** The server's air supply for the bot (set_entity_data `air`). */
  let air: number | undefined;
  const at = (i: number): Vec3 => ({ x: o.x + i * SPACING, y: o.y, z: o.z });
  const FOLLOW_AT = W1_STATIONS.length; // the follow pool after the six W1 stations
  /** Track W2: the station index of every station (the dig-out pools after the follow pool). */
  const indexOf = (name: WaterStationName): number => {
    const i = (W1_STATIONS as readonly string[]).indexOf(name);
    if (i >= 0) return i;
    const d = (DIG_OUT_STATIONS as readonly string[]).indexOf(name);
    return d >= 0 ? FOLLOW_AT + 1 + d : FOLLOW_AT + 1 + DIG_OUT_STATIONS.length + (W3_STATIONS as readonly string[]).indexOf(name); // Track W3 after them
  };

  const water = async (sub: 'build' | 'clear', name: WaterStationName, p: Vec3): Promise<Built> => {
    const r = await bot.truth.cmd<Built>('water', [sub, name, p.x, p.y, p.z], 180_000);
    if (!r.ok) throw new Error(`truth:water ${sub} ${name}: ${r.reason}`);
    return r.data;
  };

  beforeAll(async () => {
    bot = await connectBot('NavWater', { target: TARGET, container: CONTAINER });
    bot.conn.on('set_entity_data', (p) => {
      if (String(p.runtime_entity_id) !== String(bot.world.self.runtimeId)) return;
      for (const m of (p.metadata ?? []) as { key: string; value: unknown }[]) if (m.key === 'air' && typeof m.value === 'number') air = m.value;
    });
    bot.skills.nav.air = () => air; // as the session wires it (chat/commands-portal.ts)
    await teleport(bot, { x: o.x + 0.5, y: o.y, z: o.z - 1.5 });
    for (const name of WATER_STATIONS) {
      const b = await water('build', name, at(indexOf(name)));
      built.set(name, b);
      summary.push(`built ${name} at ${fmt(b.origin)} in ${b.ticks} ticks`);
    }
    built.set('follow', await water('build', 'pool2', at(FOLLOW_AT)));
  }, 600_000);

  afterAll(async () => {
    const text = `[nav-water e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`;
    console.log(text);
    if (process.env.W1_OUT) writeFileSync(process.env.W1_OUT, text);
    try {
      if (bot) {
        await teleport(bot, { x: o.x + 0.5, y: o.y, z: o.z - 1.5 });
        for (const name of WATER_STATIONS) await water('clear', name, at(indexOf(name)));
        await water('clear', 'pool2', at(FOLLOW_AT));
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 600_000);

  /** Watch the run: the air low-point, the lowest health, the ticks in water and with the head under. */
  function watch() {
    let minAir = air ?? 300;
    let minHealth = bot.world.self.health;
    let wet = 0;
    let minFeet = Infinity;
    const off = bot.loop.onBeforeStep((_t, s) => {
      if (air !== undefined) minAir = Math.min(minAir, air);
      minHealth = Math.min(minHealth, bot.world.self.health);
      if (s.inWater) wet++;
      minFeet = Math.min(minFeet, s.pos.y);
    });
    return {
      stop: () => {
        off();
        return { minAir, minHealth, wet, minFeet };
      },
    };
  }

  /**
   * The station's water as the bot's world model has it against the layout (its water ops and `flows`): cells
   * with water the layout does not have (a fill that flowed out) and layout water the world lacks.
   */
  function waterCheck(name: WaterStationName, origin: Vec3): { stray: string[]; missing: string[] } {
    const st = waterStation(name, origin)!;
    const want = new Set<string>();
    const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
    for (const op of st.ops)
      for (let y = op.from.y; y <= op.to.y; y++)
        for (let z = op.from.z; z <= op.to.z; z++)
          for (let x = op.from.x; x <= op.to.x; x++) {
            if (op.block === 'water') want.add(key(x, y, z));
            else want.delete(key(x, y, z));
          }
    for (const f of st.flows) want.add(key(f.p.x, f.p.y, f.p.z));
    const stray: string[] = [];
    const missing: string[] = [];
    const { min, max } = st.bounds;
    for (let y = min.y; y <= max.y; y++)
      for (let z = min.z; z <= max.z; z++)
        for (let x = min.x; x <= max.x; x++) {
          const b = bot.world.blockAt({ x, y, z });
          const wet = b?.name === 'water' || b?.name === 'flowing_water';
          const rel = `${x - origin.x},${y - origin.y},${z - origin.z}`;
          if (wet && !want.has(key(x, y, z))) stray.push(`${rel}${JSON.stringify(b.states)}`);
          if (!wet && want.has(key(x, y, z))) missing.push(`${rel} ${b?.name ?? 'unloaded'}`);
        }
    return { stray, missing };
  }

  async function station(label: string, from: Vec3, goal: Vec3, navGoal: NavGoal = { type: 'block', p: goal }) {
    await teleport(bot, from, 0);
    const c0 = bot.corrections.length;
    const plan = bot.skills.nav.plan(navGoal);
    const w = watch();
    const t0 = performance.now();
    const res = await bot.skills.goto(navGoal, { timeoutTicks: 1500 });
    const ms = performance.now() - t0;
    await bot.loop.waitTicks(10);
    const m = w.stop();
    const rep = bot.skills.status().lastGoto!;
    const got = bot.corrections.slice(c0);
    const truth = await bot.truth.pos(bot.name);
    const health = (truth as unknown as { health: number | null }).health;
    const moves = plan ? plan.path.map((n) => n.move) : [];
    const count = (k: string): number => moves.filter((x) => x === k).length;
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks (${(ms / 1000).toFixed(1)} s), ${rep.distance.toFixed(1)} blocks, plan ${plan?.status ?? 'none'} ` +
      `(swim ${count('swim')}, dive ${count('dive')}, swimOut ${count('swimOut')}, dug ${plan ? plan.path.reduce((k, n) => k + (n.act?.dig?.length ?? 0), 0) : 0}), broken ${rep.actions.dig}, ` +
      `in water ${m.wet} ticks, air low ${m.minAir}, min health ${m.minHealth}, truth health ${health}, ${rep.why ? `why "${rep.why}", ` : ''}` +
      `${got.length} correction(s), stuck ${rep.stuck}, end ${fmt(truth.location)}${describeCorrections(got)}`;
    summary.push(line);
    return { res, rep, got, m, moves, line, truth, health };
  }

  const near = (p: Vec3, goal: Vec3): boolean => Math.hypot(p.x - (goal.x + 0.5), p.z - (goal.z + 0.5)) < 1.2 && Math.abs(p.y - goal.y) < 0.6;

  for (const name of W1_STATIONS) {
    it(`${name}: from the start to the goal, no damage, air kept`, async () => {
      const b = built.get(name)!;
      const r = await station(name, b.start, b.goal);
      const wc = waterCheck(name, b.origin);
      summary.push(`  ${name} water vs the layout: ${wc.stray.length} stray ${wc.stray.slice(0, 6).join(' ')}, ${wc.missing.length} missing ${wc.missing.slice(0, 6).join(' ')}`);
      expect(wc.stray, `${name}: water the layout does not have`).toEqual([]);
      expect(r.res, r.line).toEqual({ ok: true });
      expect(near(r.truth.location, b.goal), r.line).toBe(true);
      expect(r.m.minHealth, r.line).toBe(20);
      expect(r.m.minAir, r.line).toBeGreaterThan(100);
      if (name === 'lip') expect(r.moves).toContain('swimOut');
      if (name === 'column' || name === 'waterfall' || name === 'tunnel') expect(r.moves).toContain('dive');
    }, 180_000);
  }

  // ---- Track W2: digging out of water ---------------------------------------------------------------------

  /** The inventory for a dig-out run: emptied, then `item` in hotbar slot 0 (once the inventory model shows it). */
  async function kit(item: string | null): Promise<void> {
    await bot.truth.ok('clear', [bot.name]);
    if (item) await bot.truth.ok('setslot', [bot.name, 0, item, 1]);
    for (let i = 0; i < 100; i++) {
      const slots = bot.world.inventory.slots;
      if (item ? slots[0]?.name === item : slots.slice(0, 36).every((x) => !x)) break;
      await sleep(50);
    }
    await bot.loop.waitTicks(5);
  }

  /** The rim cells (the ring beside the pit, one above the water's top cell) that are no longer the station's block. */
  function rimBroken(b: Built, block: string): string[] {
    const out = new Set<string>();
    const { x, y, z } = b.origin;
    for (let i = -3; i <= 3; i++)
      for (const [cx, cz] of [[x + i, z + 1], [x + i, z + 7], [x - 3, z + 4 + i], [x + 3, z + 4 + i]] as const) {
        const n = bot.world.blockAt({ x: cx, y: y - 1, z: cz })?.name;
        if (n !== block) out.add(`${cx - x},${cz - z} ${n}`);
      }
    return [...out];
  }

  async function digOut(name: WaterStationName, item: string | null) {
    const b = built.get(name)!;
    const label = `${name} (${item ?? 'hand'})`;
    await kit(item);
    const r = await station(label, b.start, b.goal);
    const wc = waterCheck(name, b.origin);
    summary.push(`  ${label} water vs the layout: ${wc.stray.length} stray ${wc.stray.slice(0, 6).join(' ')}, ${wc.missing.length} missing ${wc.missing.slice(0, 6).join(' ')}`);
    expect(wc.stray, `${name}: water flowed where the layout has none`).toEqual([]);
    return { ...r, b };
  }

  it('lipDirt: no swim exit; digs a step into the grass lip by hand while treading water, climbs out, walks to the goal', async () => {
    const r = await digOut('lipDirt', null);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(near(r.truth.location, r.b.goal), r.line).toBe(true);
    expect(r.rep.actions.dig, r.line).toBe(1);
    expect(r.rep.actions.failed, r.line).toBe(0);
    expect(rimBroken(r.b, 'grass_block').length, r.line).toBe(1);
    expect(r.m.minHealth, r.line).toBe(20);
    expect(r.m.minAir, r.line).toBeGreaterThan(250);
  }, 180_000);

  it('lipStone: by hand the stone lip is refused (trapped, nothing broken); with a wooden pickaxe it is dug', async () => {
    const hand = await digOut('lipStone', null);
    expect(hand.res, hand.line).toEqual({ ok: false, reason: 'unreachable' });
    expect(hand.rep.why ?? '', hand.line).toMatch(/^trapped in water: no swim exit and no step to dig \(stone: no tool breaks it in time/);
    expect(hand.rep.actions.dig, hand.line).toBe(0);
    expect(rimBroken(hand.b, 'stone'), hand.line).toEqual([]);
    expect(hand.m.minHealth, hand.line).toBe(20);
    const wood = await digOut('lipStone', 'wooden_pickaxe');
    expect(wood.res, wood.line).toEqual({ ok: true });
    expect(near(wood.truth.location, wood.b.goal), wood.line).toBe(true);
    expect(wood.rep.actions.dig, wood.line).toBe(1);
    expect(rimBroken(wood.b, 'stone').length, wood.line).toBe(1);
    expect(wood.m.minHealth, wood.line).toBe(20);
    expect(wood.m.minAir, wood.line).toBeGreaterThan(250);
  }, 300_000);

  it('bank3: cuts a 1-wide stair up the 3-high bank by hand and ends on top', async () => {
    const r = await digOut('bank3', null);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(near(r.truth.location, r.b.goal), r.line).toBe(true);
    expect(r.rep.actions.dig, r.line).toBeGreaterThanOrEqual(4);
    expect(r.rep.actions.failed, r.line).toBe(0);
    expect(r.m.minHealth, r.line).toBe(20);
    expect(r.m.minAir, r.line).toBeGreaterThan(250);
  }, 300_000);

  it('lipBuilt: a stone-brick rim is never broken, even with a pickaxe: trapped, reported, no damage', async () => {
    const r = await digOut('lipBuilt', 'iron_pickaxe');
    expect(r.res, r.line).toEqual({ ok: false, reason: 'unreachable' });
    expect(r.rep.why ?? '', r.line).toMatch(/^trapped in water: no swim exit and no step to dig \(stone_bricks: protected or built/);
    expect(r.rep.actions.dig, r.line).toBe(0);
    expect(rimBroken(r.b, 'stone_bricks'), r.line).toEqual([]);
    expect(r.m.minHealth, r.line).toBe(20);
    expect(r.m.minAir, r.line).toBeGreaterThan(250);
  }, 180_000);

  it('pool6 from its floor (6 under the surface): up and out, never sinking', async () => {
    const b = built.get('pool6')!;
    const r = await station('pool6 from the floor', b.deepStart!, b.goal);
    expect(r.res, r.line).toEqual({ ok: true });
    expect(near(r.truth.location, b.goal), r.line).toBe(true);
    expect(r.m.minFeet, r.line).toBeGreaterThan(b.deepStart!.y - 0.3);
    expect(r.m.minHealth, r.line).toBe(20);
  }, 180_000);

  it('pool6 from the bank down to a point on its floor (a waypoint under water): done there', async () => {
    const b = built.get('pool6')!;
    const p = { x: b.origin.x + 0.5, y: b.origin.y, z: b.origin.z + 12.5 };
    const r = await station('pool6 bank to the floor', b.start, b.goal, { type: 'near', p, r: 1.5 });
    expect(r.res, r.line).toEqual({ ok: true });
    expect(r.moves.at(-1), r.line).toBe('dive');
    // the goal's node within 1.5 of the point, the body near that node's centre (and the idle sink after the end)
    expect(Math.hypot(r.truth.location.x - p.x, r.truth.location.y - p.y, r.truth.location.z - p.z), r.line).toBeLessThan(2.4);
    expect(r.m.minHealth, r.line).toBe(20);
    expect(r.m.minAir, r.line).toBeGreaterThan(150);
  }, 180_000);

  it('follows a player through a pool: treads water while close, out the far side, no stall', async () => {
    const b = built.get('follow')!;
    const x = b.origin.x + 0.5;
    const z0 = b.origin.z;
    const name = `Swim${Math.random().toString(36).slice(2, 8)}`;
    const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
    await conn.connect(TARGET);
    const follow = new FollowController({ loop: bot.loop, mover: bot.skills, entities: () => bot.world.entities });
    try {
      const tp = (p: Vec3) => bot.truth.tp(name, p, 0, 0);
      await teleport(bot, { x, y: o.y, z: z0 + 0.5 }, 0);
      await tp({ x, y: o.y, z: z0 + 3.5 });
      const w = watch();
      const done = follow.follow({ playerName: name });
      const t0 = performance.now();
      // across the pool (feet in its top water cell), a block every 250 ms, a stop in the middle, out on the far bank
      for (let z = 4; z <= 8; z++) {
        await tp({ x, y: z >= 4 && z <= 12 ? o.y - 1 : o.y, z: z0 + z + 0.5 });
        await sleep(250);
      }
      // the stop in the middle: the bot comes up to the swimmer and treads water there (its lowest feet and air while it waits)
      await sleep(3000);
      const waitFrom = bot.loop.state.pos.y;
      let lowWhileClose = Infinity;
      const airAtWait = air ?? 300;
      const offLow = bot.loop.onBeforeStep((_t, s) => {
        lowWhileClose = Math.min(lowWhileClose, s.pos.y);
      });
      await sleep(4000);
      offLow();
      const airAfterWait = air ?? 300;
      const midState = follow.status();
      for (let z = 9; z <= 15; z++) {
        await tp({ x, y: z <= 12 ? o.y - 1 : o.y, z: z0 + z + 0.5 });
        await sleep(250);
      }
      const goal = { x, y: o.y, z: z0 + 15.5 };
      let reached = -1;
      for (let i = 0; i < 300; i++) {
        const p = bot.loop.state.pos;
        if (Math.hypot(p.x - goal.x, p.y - goal.y, p.z - goal.z) < 3.5 && p.y > o.y - 0.4) {
          reached = performance.now() - t0;
          break;
        }
        await sleep(100);
      }
      const st = follow.status();
      follow.stop();
      const res = await done;
      const m = w.stop();
      const line =
        `follow through a pool: ${reached >= 0 ? `with the target on the far bank after ${(reached / 1000).toFixed(1)} s` : 'never reached the target'}, follow ${JSON.stringify(res)}, ` +
        `mid-pool ${midState.state} at ${midState.distance?.toFixed(1)} (feet ${waitFrom.toFixed(2)}, lowest over 4 s ${lowWhileClose.toFixed(2)}, air ${airAtWait} -> ${airAfterWait}), end ${st.state} at ${st.distance?.toFixed(1)}, ` +
        `in water ${m.wet} ticks, air low ${m.minAir}, min health ${m.minHealth}, end ${fmt(bot.loop.state.pos)}`;
      summary.push(line);
      expect(reached, line).toBeGreaterThan(0);
      expect(m.minHealth, line).toBe(20);
      // treading water: never down to the pool's floor (feet -62) while waiting by the swimming target, breathing
      expect(midState.distance!, line).toBeLessThan(4.5);
      expect(lowWhileClose, line).toBeGreaterThan(o.y - 1.75);
      expect(airAfterWait, line).toBeGreaterThan(250);
    } finally {
      follow.dispose();
      await conn.disconnectAndFlush('test done');
    }
  }, 180_000);

  // ---- Track W3: the dig way, a goal cell in water --------------------------------------------------------

  /** A W3 run: the inventory emptied (by hand, as the flight kit has it), the dig way on as the session has it. */
  async function w3(name: WaterStationName, digWay = true) {
    const b = built.get(name)!;
    await kit(null);
    bot.skills.nav.digWay = () => digWay;
    // the planner worker, as the session has it (plannerThreads 1): a dig-way search is bigger than the in-thread 40 ms
    const detach = bot.skills.nav.attachPlanner(bot.world, { threads: () => 1 });
    await sleep(1500);
    try {
      const r = await station(digWay ? name : `${name} (dig way off)`, b.start, b.goal);
      return { ...r, b };
    } finally {
      bot.skills.nav.digWay = () => false;
      detach();
    }
  }

  it('W3 step2: the dig way off: unreachable, nothing broken; on: one block of the 2-high stone step dug by hand, on top', async () => {
    const off = await w3('step2', false);
    expect(off.res, off.line).toEqual({ ok: false, reason: 'unreachable' });
    expect(off.rep.actions.dig, off.line).toBe(0);
    const r = await w3('step2');
    expect(r.res, r.line).toEqual({ ok: true });
    expect(near(r.truth.location, r.b.goal), r.line).toBe(true);
    expect(r.rep.actions.dig, r.line).toBe(1);
    expect(r.rep.actions.failed, r.line).toBe(0);
    expect(r.m.minHealth, r.line).toBe(20);
  }, 300_000);

  it('W3 step3: a stair of three blocks cut into the 3-high dirt step by hand, on top', async () => {
    const r = await w3('step3');
    expect(r.res, r.line).toEqual({ ok: true });
    expect(near(r.truth.location, r.b.goal), r.line).toBe(true);
    expect(r.rep.actions.dig, r.line).toBeGreaterThanOrEqual(3);
    expect(r.rep.actions.dig, r.line).toBeLessThanOrEqual(12);
    expect(r.m.minHealth, r.line).toBe(20);
  }, 300_000);

  it('W3 drop6: off a 6-high stone plateau by digging down by hand, no fall damage', async () => {
    const r = await w3('drop6');
    expect(r.res, r.line).toEqual({ ok: true });
    expect(near(r.truth.location, r.b.goal), r.line).toBe(true);
    expect(r.rep.actions.dig, r.line).toBeGreaterThanOrEqual(3);
    expect(r.m.minHealth, r.line).toBe(20);
    expect(r.health, r.line).toBe(20);
  }, 300_000);

  it('W3 wetGoal: a block goal in a 1-deep water floor: done in that cell', async () => {
    const r = await w3('wetGoal');
    expect(r.res, r.line).toEqual({ ok: true });
    const c = { x: Math.floor(r.truth.location.x), y: Math.floor(r.truth.location.y + 0.01), z: Math.floor(r.truth.location.z) };
    expect(c, r.line).toEqual(r.b.goal);
    expect(r.rep.actions.dig, r.line).toBe(0);
    expect(r.m.minHealth, r.line).toBe(20);
  }, 180_000);
});
