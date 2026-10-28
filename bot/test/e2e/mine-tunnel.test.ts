// e2e (tag @bds), wave 10 Track AQ (docs/mining.md "Direct tunnels", decision 0038) on bds-dig (flat
// world, truth pack; DIG_BDS_HOST / DIG_BDS_PORT / DIG_BDS_CONTAINER). Every case builds its own stone
// shapes (truth fills) in a private area (x, z from 70 000, a random 128-block cell; one 40-block row per
// case) and runs a MineTask wired like the chat command (`createMinerFor`, mineSeenOnly off, mineDirect on):
//   below    an ore 4 blocks under the floor of a stone mass: a staircase tunnel, mined within 60 s, the
//            bot back on the floor afterwards
//   wall     an ore 8 blocks into a stone wall at head height: a horizontal tunnel (iron pickaxe, then the
//            same with a netherite one: blocks per minute)
//   hill     an ore 6 blocks up inside a hill: a staircase up (never a pillar: nothing to place carried)
//   shaft    an ore 10 blocks straight down in a stone tower (solid all the way): a 1x1 shaft, the bot back
//            on the top (cobblestone carried: pillar up); then the same with a lava pocket 2 blocks under
//            the ore (stops with the reason) and with a dripstone cave below it (stops with the reason)
//   rules    stone bricks in the tunnel's line stop it with the reason (`protected`); water above and lava
//            under the tunnel line stop the straight tunnel (`next_to_liquid`; the dig-through walk may go
//            around) and no opened cell has a liquid next to it (truth:find over the opened cells)
//   cheap    an ore under the floor walled in by stone bricks: skipped as unreachable after one probe
//            and one tunnel plan (the time to the verdict is printed: the "unreachable" cost)
// MINE_BEFORE=1 runs the measurements without the assertions (the numbers of the code before Track AQ).
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MineTask } from '../../src/skills/mine/miner.ts';
import { createMinerFor } from '../../src/skills/mine/wire.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { DIG_CONTAINER, DIG_TARGET } from './dig-truth.ts';
import { E2E_VERSION } from './env.ts';
import { E2E, FEET_Y, clearArea, connectFarmBot, killItemsNear, pollUntil, prepareServer, truthLoaded, type FarmBot, type TruthInv } from './farm-truth.ts';

const F = FEET_Y;
const STRICT = process.env.MINE_BEFORE !== '1';
/** Track BD: `MINE_MODE=baritone` runs the suite in mode baritone (the tunnel-plan assertions are v3's). */
const MINE_MODE = process.env.MINE_MODE === 'baritone' ? 'baritone' : 'v3';
/** Track BD: the assertions on v3's own tunnel planner (tunnel records, the straight line, the probe verdict) hold in mode v3 only. */
const V3 = MINE_MODE === 'v3';
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const N6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

describe.skipIf(!E2E)('@bds mine: direct tunnels and shafts (Track AQ)', () => {
  let bot: FarmBot;
  let detachPlanner: (() => void) | undefined; // Track BD
  const cell = randomInt(64);
  const X0 = 70_000 + 128 * (cell % 8) + 64;
  const Z0 = 70_000 + 128 * Math.floor(cell / 8) + 16;
  const notes: string[] = [];
  let row = 0;
  /** Cells the bot opened (solid before, open after, within 7 blocks of its eye) during the current case. */
  const opened = new Map<string, Vec3>();
  let tracking = false;

  const fill = (a: Vec3, b: Vec3, block: string) => truthLoaded(bot.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block]);
  const set = (p: Vec3, block: string) => truthLoaded(bot.truth, 'set', [p.x, p.y, p.z, block]);
  const blockName = async (p: Vec3) => (await bot.block(p)).typeId.replace('minecraft:', '');
  const waitName = async (p: Vec3, name: string) => (await pollUntil(() => bot.world.blockAt(p)?.name === name, 8_000)) >= 0;
  const st = (m: MineTask) => m.stats as MineTask['stats'] & Record<string, unknown>;
  const fmtPos = () => {
    const p = bot.loop.state.pos;
    return `${p.x.toFixed(1)} ${p.y.toFixed(2)} ${p.z.toFixed(1)}`;
  };

  /** A fresh 40-block row: cleared flat floor, no items. */
  async function newSite(): Promise<{ x: number; z: number }> {
    const s = { x: X0, z: Z0 + 40 * row++ };
    await bot.teleport({ x: s.x - 6.5, y: F, z: s.z + 0.5 }, -90);
    await clearArea(bot.truth, s.x, s.z, 16, 16);
    await killItemsNear(s.x, s.z, 18, DIG_CONTAINER);
    opened.clear();
    return s;
  }

  function miner(direct = true): MineTask {
    const parts = { skills: bot.skills, world: bot.world, loop: bot.loop, source: bot.conn, hotbar: bot.hotbar, containers: bot.containers, log: bot.logger };
    // `direct` is Track AQ's `mineDirect` (ignored by the code before it)
    return createMinerFor(parts, { seenOnly: () => false, tunnelLen: () => 64, direct: () => direct, mode: () => MINE_MODE }).mine; // Track BD: MINE_MODE=baritone runs the suite in mode baritone
  }

  async function run(m: MineTask, block: string, count: number, limitMs = 240_000): Promise<{ end: string; s: number }> {
    const t0 = performance.now();
    tracking = true;
    const timer = setTimeout(() => m.stop(), limitMs);
    const end = await m.start({ block, count });
    clearTimeout(timer);
    tracking = false;
    return { end, s: (performance.now() - t0) / 1000 };
  }

  function line(name: string, m: MineTask, r: { end: string; s: number }): string {
    const s = st(m);
    return (
      `${name}: ${r.end} after ${r.s.toFixed(1)} s; mined ${JSON.stringify(s.minedAt)} at ${s.minedMs.map((x) => (x / 1000).toFixed(1)).join(', ')} s; ` +
      `tunnelled ${s.tunnelled} (${s.sightDigs} sight digs), opened ${opened.size}; tunnels ${JSON.stringify(s.tunnels ?? 'n/a')}; ` +
      `unreachable ${JSON.stringify(s.unreachable)} at ${s.unreachableMs.map((x) => (x / 1000).toFixed(2)).join(', ')} s; probes ${s.probes} (${s.probeMs.toFixed(0)} ms); failures ${s.failures}; ` +
      `skips ${JSON.stringify(s.skipped ?? s.unsafe)}; bot at ${fmtPos()}; last error ${m.lastError ?? '-'}`
    );
  }

  /** Liquid next to any opened cell (truth:find over their box), as `water at x,y,z` lines. */
  async function liquidNextToOpened(): Promise<string[]> {
    const cells = [...opened.values()];
    if (cells.length === 0) return [];
    const lo = { x: Math.min(...cells.map((c) => c.x)) - 1, y: Math.min(...cells.map((c) => c.y)) - 1, z: Math.min(...cells.map((c) => c.z)) - 1 };
    const hi = { x: Math.max(...cells.map((c) => c.x)) + 1, y: Math.max(...cells.map((c) => c.y)) + 1, z: Math.max(...cells.map((c) => c.z)) + 1 };
    const out: string[] = [];
    for (const liquid of ['water', 'lava']) {
      const f = await truthLoaded<{ positions: number[][] }>(bot.truth, 'find', [lo.x, lo.y, lo.z, hi.x, hi.y, hi.z, liquid, 4096]);
      for (const [x, y, z] of f.positions) for (const [dx, dy, dz] of N6) if (opened.has(`${x! + dx},${y! + dy},${z! + dz}`)) out.push(`${liquid} at ${x},${y},${z}`);
    }
    return out;
  }

  beforeAll(async () => {
    await prepareServer(DIG_CONTAINER);
    bot = await connectFarmBot('Tunnel', { target: DIG_TARGET, container: DIG_CONTAINER });
    // Track BD: mode baritone plans its dig-heavy composite goals in the planner worker (the Realm's configuration)
    if (MINE_MODE === 'baritone') {
      detachPlanner = bot.skills.nav.attachPlanner(bot.world);
      expect(await pollUntil(() => !!bot.skills.nav.planner?.ready, 20_000)).toBeGreaterThanOrEqual(0);
    }
    bot.world.onBlockUpdate((p, before, after) => {
      if (!tracking) return;
      const at = bot.loop.state.pos;
      const near = Math.hypot(p.x + 0.5 - at.x, p.y + 0.5 - (at.y + 1.6), p.z + 0.5 - at.z) <= 7;
      if (near && before && before.boxes.length > 0 && after.boxes.length === 0 && !after.name.includes('water') && !after.name.includes('lava')) opened.set(key(p), { ...p });
    });
  }, 180_000);

  afterAll(async () => {
    process.stdout.write(`[mine-tunnel e2e] BDS ${E2E_VERSION}, area cell ${cell} (${X0}, ${Z0}), ${STRICT ? 'strict' : 'MINE_BEFORE (no assertions)'}\n  ${notes.join('\n  ')}\n`);
    if (bot) {
      for (let i = 0; i < row; i++) {
        await clearArea(bot.truth, X0, Z0 + 40 * i, 16, 16).catch(() => undefined);
        await killItemsNear(X0, Z0 + 40 * i, 18, DIG_CONTAINER).catch(() => undefined);
      }
      detachPlanner?.();
      await bot.close();
    }
  }, 300_000);

  it('an ore 4 blocks under the floor: a staircase tunnel, mined within 60 s, back on the floor', async () => {
    const s = await newSite();
    // stone mass, top at y -53 (feet -52); the ore 4 blocks under the top, 4 east of the bot
    await fill({ x: s.x - 8, y: F - 3, z: s.z - 5 }, { x: s.x + 8, y: F + 7, z: s.z + 5 }, 'stone');
    const top = F + 8;
    const ore = { x: s.x + 1, y: top - 5, z: s.z };
    await set(ore, 'coal_ore');
    await bot.teleport({ x: s.x - 3 + 0.5, y: top, z: s.z + 0.5 }, -90);
    await bot.loadout([['iron_pickaxe', 1]]);
    expect(await waitName(ore, 'coal_ore')).toBe(true);
    const m = miner();
    const r = await run(m, 'coal_ore', 1, 120_000);
    const i = await bot.truth.ok<TruthInv>('inv', [bot.name]);
    const p = bot.loop.state.pos;
    notes.push(`${line('below (4 under the floor)', m, r)}; coal ${i.counts['minecraft:coal'] ?? 0}`);
    if (!STRICT) return;
    expect(r.end).toBe('done');
    expect(st(m).minedMs[0]!).toBeLessThan(60_000);
    expect(await blockName(ore)).not.toBe('coal_ore');
    if (V3) expect((st(m).tunnels as { mode: string }[] | undefined)?.[0]?.mode).toBe('stairs');
    expect(p.y).toBeGreaterThanOrEqual(top - 0.1); // back on the floor
  }, 300_000);

  for (const pick of ['iron_pickaxe', 'netherite_pickaxe'] as const) {
    it(`an ore 8 blocks into a wall at head height: a horizontal tunnel (${pick})`, async () => {
      const s = await newSite();
      await fill({ x: s.x + 2, y: F - 1, z: s.z - 4 }, { x: s.x + 14, y: F + 6, z: s.z + 4 }, 'stone');
      const ore = { x: s.x + 9, y: F + 1, z: s.z };
      await set(ore, 'coal_ore');
      await bot.teleport({ x: s.x + 0.5, y: F, z: s.z + 0.5 }, -90);
      await bot.loadout([[pick, 1]]);
      expect(await waitName(ore, 'coal_ore')).toBe(true);
      const m = miner();
      const r = await run(m, 'coal_ore', 1, 120_000);
      const t = (st(m).tunnels as { dug: number; ms: number }[] | undefined)?.[0];
      const bpm = t ? (t.dug / (t.ms / 60_000)).toFixed(0) : (st(m).tunnelled / (((st(m).minedMs[0] ?? r.s * 1000) / 60_000) || 1)).toFixed(0);
      notes.push(`${line(`wall 8 deep (${pick})`, m, r)}; ${bpm} blocks per minute in the tunnel`);
      if (!STRICT) return;
      expect(r.end).toBe('done');
      expect(await blockName(ore)).not.toBe('coal_ore');
      if (V3) expect(opened.size).toBeLessThanOrEqual(16); // 1 wide, 2 high, straight
    }, 300_000);
  }

  it('an ore 6 blocks up inside a hill: a staircase up', async () => {
    const s = await newSite();
    await fill({ x: s.x + 2, y: F - 1, z: s.z - 4 }, { x: s.x + 13, y: F + 11, z: s.z + 4 }, 'stone');
    const ore = { x: s.x + 6, y: F + 6, z: s.z };
    await set(ore, 'coal_ore');
    await bot.teleport({ x: s.x + 0.5, y: F, z: s.z + 0.5 }, -90);
    await bot.loadout([['iron_pickaxe', 1]]);
    expect(await waitName(ore, 'coal_ore')).toBe(true);
    const m = miner();
    const places0 = bot.places.length; // Track BD: this case's own placements (the list is the whole suite's)
    const r = await run(m, 'coal_ore', 1, 120_000);
    notes.push(`${line('hill (6 up)', m, r)}; placed ${bot.places.length - places0}`);
    if (!STRICT) return;
    expect(r.end).toBe('done');
    expect(await blockName(ore)).not.toBe('coal_ore');
    if (V3) expect((st(m).tunnels as { mode: string }[] | undefined)?.[0]?.mode).toBe('stairs');
    expect(bot.places.length - places0).toBe(0); // no pillar (Track BD: counted for this case only; mode baritone staircases up too)
  }, 300_000);

  /** A 13 x 13 stone tower 13 high (top y -49, feet -48) with the ore 10 below the feet in its middle. */
  async function tower(s: { x: number; z: number }): Promise<{ ore: Vec3; top: number }> {
    await fill({ x: s.x - 6, y: F - 3, z: s.z - 6 }, { x: s.x + 6, y: F + 11, z: s.z + 6 }, 'stone');
    const top = F + 12;
    const ore = { x: s.x, y: top - 10, z: s.z };
    await set(ore, 'coal_ore');
    return { ore, top };
  }

  it('an ore 10 blocks straight down: a 1x1 shaft, and back up on the top', async () => {
    const s = await newSite();
    const { ore, top } = await tower(s);
    await bot.teleport({ x: s.x + 0.5, y: top, z: s.z + 0.5 }, -90);
    await bot.loadout([
      ['iron_pickaxe', 1],
      ['cobblestone', 20],
    ]);
    expect(await waitName(ore, 'coal_ore')).toBe(true);
    const m = miner();
    const r = await run(m, 'coal_ore', 1, 180_000);
    const p = bot.loop.state.pos;
    const t = (st(m).tunnels as { mode: string; dug: number; ms: number; placed?: number }[] | undefined) ?? [];
    const down = t.find((x) => x.mode === 'shaft');
    const up = t.find((x) => x.mode === 'climb');
    notes.push(
      `${line('shaft (10 down)', m, r)}; down ${down ? `${down.dug} blocks in ${(down.ms / 1000).toFixed(1)} s = ${(down.dug / (down.ms / 60_000)).toFixed(0)} blocks/min` : 'n/a'}, ` +
        `up ${up ? `${up.placed ?? 0} placed / ${up.dug} dug in ${(up.ms / 1000).toFixed(1)} s = ${((up.placed ?? up.dug) / (up.ms / 60_000)).toFixed(0)} blocks/min` : 'n/a'}; places ${bot.places.length}`,
    );
    if (!STRICT) return;
    expect(r.end).toBe('done');
    expect(await blockName(ore)).not.toBe('coal_ore');
    if (V3) expect(down).toBeDefined();
    expect(p.y).toBeGreaterThanOrEqual(top - 0.1);
  }, 300_000);

  it('the same shaft with a lava pocket 2 blocks under the ore stops with the reason', async () => {
    const s = await newSite();
    const { ore, top } = await tower(s);
    const lava = { x: ore.x, y: ore.y - 2, z: ore.z };
    await set(lava, 'lava');
    await bot.teleport({ x: s.x + 0.5, y: top, z: s.z + 0.5 }, -90);
    await bot.loadout([
      ['iron_pickaxe', 1],
      ['cobblestone', 20],
    ]);
    expect(await waitName(lava, 'lava')).toBe(true);
    const m = miner();
    const r = await run(m, 'coal_ore', 1, 120_000);
    notes.push(line('shaft over lava', m, r));
    const liquid = await liquidNextToOpened();
    if (!STRICT) return;
    expect(r.end).toBe('none_left');
    expect(await blockName(ore)).toBe('coal_ore');
    expect(await blockName(lava)).toBe('lava');
    expect(`${m.lastError ?? ''} ${JSON.stringify(st(m).skipped)} ${JSON.stringify(st(m).unsafe)}`).toMatch(/liquid/); // Track BD: mode baritone's prune reports in unsafe
    expect(liquid).toEqual([]);
  }, 300_000);

  it('the same shaft with a dripstone cave below the ore stops with the reason', async () => {
    const s = await newSite();
    const { ore, top } = await tower(s);
    // a cave 2 high under the ore's floor block, pointed dripstone standing on its floor
    await fill({ x: ore.x - 1, y: ore.y - 3, z: ore.z - 1 }, { x: ore.x + 1, y: ore.y - 2, z: ore.z + 1 }, 'air');
    const drip = { x: ore.x, y: ore.y - 3, z: ore.z };
    await set(drip, 'pointed_dripstone');
    await bot.teleport({ x: s.x + 0.5, y: top, z: s.z + 0.5 }, -90);
    await bot.loadout([
      ['iron_pickaxe', 1],
      ['cobblestone', 20],
    ]);
    expect(await waitName(drip, 'pointed_dripstone')).toBe(true);
    const m = miner();
    const r = await run(m, 'coal_ore', 1, 120_000);
    notes.push(line('shaft over dripstone', m, r));
    if (!STRICT) return;
    expect(r.end).toBe('none_left');
    expect(await blockName(ore)).toBe('coal_ore');
    expect(`${m.lastError ?? ''} ${JSON.stringify(st(m).skipped)} ${JSON.stringify(st(m).unsafe)}`).toMatch(/dripstone/);
  }, 300_000);

  it('dig rules: stone bricks in the line stop the tunnel with the reason', async () => {
    const s = await newSite();
    await fill({ x: s.x + 2, y: F - 1, z: s.z - 4 }, { x: s.x + 14, y: F + 6, z: s.z + 4 }, 'stone');
    const ore = { x: s.x + 9, y: F + 1, z: s.z };
    const brick = { x: s.x + 5, y: F + 1, z: s.z };
    await set(ore, 'coal_ore');
    await set(brick, 'stone_bricks');
    await bot.teleport({ x: s.x + 0.5, y: F, z: s.z + 0.5 }, -90);
    await bot.loadout([['iron_pickaxe', 1]]);
    expect(await waitName(brick, 'stone_bricks')).toBe(true);
    const m = miner();
    const r = await run(m, 'coal_ore', 1, 120_000);
    notes.push(line('stone bricks in the line', m, r));
    if (!STRICT) return;
    expect(await blockName(brick)).toBe('stone_bricks');
    if (!V3) return; // Track BD: the planner digs round the brick (the straight line is v3's rule)
    expect(r.end).toBe('none_left');
    expect(await blockName(ore)).toBe('coal_ore');
    expect(m.lastError ?? JSON.stringify(st(m).skipped)).toMatch(/protected/);
    expect(opened.size).toBe(0); // planned before any dig: nothing opened
  }, 300_000);

  it('dig rules: water above and lava under the tunnel line stop it; no opened cell next to a liquid', async () => {
    const s = await newSite();
    await fill({ x: s.x + 2, y: F - 2, z: s.z - 4 }, { x: s.x + 14, y: F + 6, z: s.z + 4 }, 'stone');
    const oreA = { x: s.x + 9, y: F + 1, z: s.z - 2 };
    const water = { x: s.x + 6, y: F + 2, z: s.z - 2 };
    const oreB = { x: s.x + 9, y: F + 1, z: s.z + 2 };
    const lava = { x: s.x + 6, y: F - 1, z: s.z + 2 };
    await set(oreA, 'coal_ore');
    await set(oreB, 'coal_ore');
    await set(water, 'water');
    await set(lava, 'lava');
    await bot.teleport({ x: s.x + 0.5, y: F, z: s.z + 0.5 }, -90);
    await bot.loadout([['iron_pickaxe', 1]]);
    expect(await waitName(lava, 'lava')).toBe(true);
    const m = miner();
    const r = await run(m, 'coal_ore', 2, 180_000);
    const liquid = await liquidNextToOpened();
    notes.push(`${line('water / lava by the line', m, r)}; liquid next to opened cells: ${liquid.length ? liquid.join('; ') : 'none'}`);
    if (!STRICT) return;
    expect(liquid).toEqual([]);
    expect(await blockName(water)).toBe('water');
    expect(await blockName(lava)).toBe('lava');
    // the straight tunnel stops at the liquid's neighbour; the dig-through walk (same rules) may still find a way around
  }, 300_000);

  it('the unreachable verdict is cheap: an ore walled in by stone bricks under the floor', async () => {
    const s = await newSite();
    await fill({ x: s.x - 8, y: F - 3, z: s.z - 5 }, { x: s.x + 8, y: F + 7, z: s.z + 5 }, 'stone');
    const top = F + 8;
    const ore = { x: s.x + 2, y: top - 4, z: s.z };
    await fill({ x: ore.x - 1, y: ore.y - 1, z: ore.z - 1 }, { x: ore.x + 1, y: ore.y + 1, z: ore.z + 1 }, 'stone_bricks');
    await set(ore, 'coal_ore');
    await bot.teleport({ x: s.x - 3 + 0.5, y: top, z: s.z + 0.5 }, -90);
    await bot.loadout([['iron_pickaxe', 1]]);
    expect(await waitName(ore, 'coal_ore')).toBe(true);
    const m = miner();
    const r = await run(m, 'coal_ore', 1, 600_000);
    notes.push(`${line('unreachable (bricks)', m, r)}; verdict after ${((st(m).unreachableMs[0] ?? r.s * 1000) / 1000).toFixed(2)} s`);
    if (!STRICT) return;
    expect(r.end).toBe('none_left');
    expect(st(m).unreachable.map(key)).toEqual([key(ore)]);
    if (V3) expect(st(m).unreachableMs[0]!).toBeLessThan(2_000); // Track BD: mode baritone's verdict is one failed composite plan (printed)
    if (V3) expect(opened.size).toBe(0);
  }, 900_000);
});
