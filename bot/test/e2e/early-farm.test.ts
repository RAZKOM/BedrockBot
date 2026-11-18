// e2e (tag @bds), Track E6 (docs/farming.md "A starter farm", ADR 0102): `!farm new` on a flat world.
//   1. home set, a hoe, seeds, an empty bucket and fences carried, a one-block pond 8 off, short grass over the ground:
//      a 5 x 5 plot next to home, the bucket filled at the pond and poured into the middle, 24 cells tilled and planted,
//      23 fences and the gate round it, the `farm` waypoint at the middle; `!farm new 5` again finds it set up.
//   2. the farm chore (farmFood on): every crop of that plot ripe, it harvests and replants and bakes the wheat into bread.
//   3. no hoe and no fences, planks and 2 cobblestone carried: the obtain job crafts a stone hoe, and after the planting
//      the fences and the gate (a 3 x 3 plot, dry: no bucket).
//   4. a block the bot did not set (planks) 3 from home with protectRadius 12: the plot lies past 14 from home.
//   5. no seeds carried: grass round the plot broken for seeds; the plot is dry, so as many cells are tilled as
//      seeds dropped (bare dry farmland turns back to dirt), each planted.
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts; a flat world), CRAFT_VERBOSE=1, EARLY_OUT.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { waypointStoreOf } from '../../src/chat/commands-nav.ts';
import { farmNewControlOf, FARM_WAYPOINT } from '../../src/chat/commands-farm-new.ts';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const G = F - 1; // the soil

function note(line: string): void {
  console.log(line);
  if (process.env.EARLY_OUT) appendFileSync(process.env.EARLY_OUT, `${line}\n`);
}

const END = /^farm new: (done|stopped|no |failed|already)/;

async function farmNew(b: CraftBot, words: string, timeoutMs: number): Promise<{ line: string; s: number; said: string[] }> {
  const from = b.said.length;
  const t0 = Date.now();
  await b.command(`!farm new${words ? ` ${words}` : ''}`);
  const line = await b.reply((s) => END.test(s), from, timeoutMs);
  return { line, s: (Date.now() - t0) / 1000, said: b.said.slice(from) };
}

/** What stands on the plot round `w` (size n, truth): farmland, crops, water in the middle, fences and gates on the rim. */
async function plotTruth(b: CraftBot, w: Vec3, n: number): Promise<{ farmland: number; crops: number; water: boolean; fences: number; gates: number }> {
  const h = (n - 1) / 2;
  const out = { farmland: 0, crops: 0, water: false, fences: 0, gates: 0 };
  for (let dx = -h - 1; dx <= h + 1; dx++)
    for (let dz = -h - 1; dz <= h + 1; dz++) {
      const rim = Math.max(Math.abs(dx), Math.abs(dz)) === h + 1;
      if (rim) {
        const t = (await b.truth.block({ x: w.x + dx, y: w.y + 1, z: w.z + dz })).typeId;
        if (t.endsWith('_fence')) out.fences++;
        else if (t.includes('fence_gate')) out.gates++;
        continue;
      }
      const g = (await b.truth.block({ x: w.x + dx, y: w.y, z: w.z + dz })).typeId;
      if (dx === 0 && dz === 0) out.water = g.includes('water');
      if (g === 'minecraft:farmland') out.farmland++;
      const up = (await b.truth.block({ x: w.x + dx, y: w.y + 1, z: w.z + dz })).typeId;
      if (up === 'minecraft:wheat') out.crops++;
    }
  return out;
}

function farmWater(b: CraftBot): Vec3 {
  const wp = waypointStoreOf(b.task)?.get(FARM_WAYPOINT);
  expect(wp).toBeDefined();
  return { x: wp!.x, y: wp!.y!, z: wp!.z };
}

describe.skipIf(!E2E)('@bds early farm: !farm new, the farm chore, bread (Track E6)', () => {
  const area = privateArea();
  let bot: CraftBot | undefined;
  const homeA = { x: area.x - 24, y: F, z: area.z - 24 };
  const homeB = { x: area.x + 24, y: F, z: area.z - 24 };
  const homeC = { x: area.x - 24, y: F, z: area.z + 24 };
  const homeD = { x: area.x + 24, y: F, z: area.z + 24 };
  /** Each case clears its own area once the bot stands there (the truth fill needs the chunks loaded). */
  const goTo = async (b: CraftBot, h: Vec3): Promise<void> => {
    // the last case's plot and fence go first (a fence within protectRadius of the next home is a build not the bot's)
    const last = used[used.length - 1];
    if (last) await clearArea(b.truth, last, 20, 4);
    waypointStoreOf(b.task)?.delete(FARM_WAYPOINT);
    await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
    await clearArea(b.truth, h, 20, 4);
    used.push(h);
  };
  const used: Vec3[] = [];

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyFarm');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await craftCmd('gamerule', 'keepinventory', 'true');
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      if (process.env.EARLY_OUT) appendFileSync(`${process.env.EARLY_OUT}.log`, `${bot.logs.join('\n')}\n--- said\n${bot.said.join('\n')}\n`);
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      for (const h of used) {
        await teleport(bot, { x: h.x + 0.5, y: F, z: h.z + 0.5 }).catch(() => undefined);
        await clearArea(bot.truth, h, 20, 4).catch(() => undefined);
      }
      await bot.stop();
    }
  }, 300_000);

  it('5 x 5 by home: the pond water poured in the middle, tilled, planted, fenced with a gate; again: set up', async () => {
    const b = bot!;
    await goTo(b, homeA);
    b.task.home!.set(homeA);
    // a one-block pond 8 off, short grass over the ground round home
    await craftCmd('fill', String(homeA.x - 14), String(F), String(homeA.z - 14), String(homeA.x + 14), String(F), String(homeA.z + 14), 'short_grass');
    await craftCmd('setblock', String(homeA.x - 8), String(F), String(homeA.z), 'air');
    await craftCmd('setblock', String(homeA.x - 8), String(G), String(homeA.z), 'water');
    await teleport(b, { x: homeA.x + 0.5, y: F, z: homeA.z + 0.5 });
    await loadKit(b, [['stone_hoe', 1], ['wheat_seeds', 30], ['bucket', 1], ['oak_fence', 23], ['fence_gate', 1]]);
    const r = await farmNew(b, '5', 240_000);
    note(`[early-farm] 5x5: ${r.line} (${r.s.toFixed(1)} s)`);
    expect(r.line).toMatch(/^farm new: done in/);
    const w = farmWater(b);
    expect(Math.max(Math.abs(w.x - homeA.x), Math.abs(w.z - homeA.z))).toBeLessThanOrEqual(24);
    const t = await plotTruth(b, w, 5);
    note(`[early-farm] 5x5 truth: ${JSON.stringify(t)}`);
    expect(t.water).toBe(true);
    expect(t.farmland).toBe(24);
    expect(t.crops).toBe(24);
    expect(t.fences).toBe(23);
    expect(t.gates).toBe(1);
    expect(b.built.mobility!.world.inventory.count('water_bucket')).toBe(0);
    // again: nothing left to do but a check
    const again = await farmNew(b, '5', 120_000);
    note(`[early-farm] 5x5 again: ${again.line} (${again.s.toFixed(1)} s)`);
    expect(again.line).toMatch(/^farm new: done in .*24 of 24 tilled/);
    // the walk home went out through the gate and left it open: an open gate is still the gate (no wood trip for one)
    expect(again.line).toMatch(/no fence needed/);
    expect(farmWater(b)).toEqual(w);
  }, 420_000);

  it('the farm chore: a ripe field harvested, replanted, baked into bread', async () => {
    const b = bot!;
    const w = farmWater(b);
    await craftCmd('fill', String(w.x - 2), String(w.y + 1), String(w.z - 2), String(w.x + 2), String(w.y + 1), String(w.z + 2), 'wheat', '["growth"=7]', 'replace', 'wheat');
    await loadKit(b, [['crafting_table', 1]]);
    const control = farmNewControlOf(b.task)!;
    expect(control.chore.why()).toBe('farmFood off');
    const t0 = Date.now();
    b.settings.set('farmFood', 'on');
    await until(() => (control.chore.stats.finished > 0 ? true : undefined), 180_000, 'the farm chore run', 500);
    const s = (Date.now() - t0) / 1000;
    b.settings.set('farmFood', 'off');
    const inv = b.built.mobility!.world.inventory;
    const t = await plotTruth(b, w, 5);
    note(`[early-farm] chore: ${JSON.stringify(control.chore.stats)} in ${s.toFixed(1)} s; bread ${inv.count('bread')}, wheat ${inv.count('wheat')}, seeds ${inv.count('wheat_seeds')}; truth ${JSON.stringify(t)}`);
    expect(control.chore.stats.harvested).toBeGreaterThanOrEqual(20);
    expect(inv.count('bread')).toBeGreaterThanOrEqual(6);
    expect(inv.count('wheat')).toBeLessThan(3);
    expect(t.crops).toBeGreaterThanOrEqual(20);
  }, 240_000);

  it('no hoe, no fences: the stone hoe crafted first, the fences and gate crafted from planks after the planting', async () => {
    const b = bot!;
    waypointStoreOf(b.task)?.delete(FARM_WAYPOINT);
    await goTo(b, homeB);
    b.task.home!.set(homeB);
    await teleport(b, { x: homeB.x + 0.5, y: F, z: homeB.z + 0.5 });
    await loadKit(b, [['oak_planks', 40], ['cobblestone', 2], ['wheat_seeds', 8]]);
    const r = await farmNew(b, '3', 300_000);
    note(`[early-farm] crafted: ${r.line} (${r.s.toFixed(1)} s); ${r.said.filter((x) => x.startsWith('get ')).join(' | ')}`);
    expect(r.line).toMatch(/^farm new: done in/);
    const inv = b.built.mobility!.world.inventory;
    expect(inv.count('stone_hoe')).toBe(1);
    const t = await plotTruth(b, farmWater(b), 3);
    note(`[early-farm] crafted truth: ${JSON.stringify(t)}`);
    expect(t.farmland).toBe(8);
    expect(t.crops).toBe(8);
    // no bucket carried: the plot stays dry (with one, water left by other runs' plots within 96 made it a walk of
    // its own, so the case would depend on the world's past)
    expect(t.water).toBe(false);
    expect(r.line).toMatch(/8 of 8 tilled, 8 planted .*water dry/);
    expect(t.fences).toBe(15);
    expect(t.gates).toBe(1);
  }, 420_000);

  it('the base is not the bot own (planks near home): the plot past protectRadius + 2', async () => {
    const b = bot!;
    waypointStoreOf(b.task)?.delete(FARM_WAYPOINT);
    await goTo(b, homeC);
    b.task.home!.set(homeC);
    b.settings.set('protectRadius', '12');
    await craftCmd('setblock', String(homeC.x + 3), String(F), String(homeC.z), 'oak_planks');
    await teleport(b, { x: homeC.x + 0.5, y: F, z: homeC.z + 0.5 });
    await loadKit(b, [['stone_hoe', 1], ['wheat_seeds', 8]]);
    const r = await farmNew(b, '3', 240_000);
    b.settings.set('protectRadius', '48');
    note(`[early-farm] base: ${r.line} (${r.s.toFixed(1)} s)`);
    expect(r.line).toMatch(/^farm new: done in/);
    const w = farmWater(b);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) expect(Math.hypot(w.x + dx + 0.5 - homeC.x, w.z + dz + 0.5 - homeC.z)).toBeGreaterThan(14);
    expect((await plotTruth(b, w, 3)).farmland).toBe(8);
    expect((await b.truth.block({ x: homeC.x + 3, y: F, z: homeC.z })).typeId).toMatch(/planks/);
  }, 300_000);

  it('no seeds carried: grass broken round the plot, what dropped planted', async () => {
    const b = bot!;
    waypointStoreOf(b.task)?.delete(FARM_WAYPOINT);
    await goTo(b, homeD);
    b.task.home!.set(homeD);
    await craftCmd('fill', String(homeD.x - 14), String(F), String(homeD.z - 14), String(homeD.x + 14), String(F), String(homeD.z + 14), 'short_grass');
    await teleport(b, { x: homeD.x + 0.5, y: F, z: homeD.z + 0.5 });
    await loadKit(b, [['stone_hoe', 1]]);
    const r = await farmNew(b, '3', 300_000);
    const inv = b.built.mobility!.world.inventory;
    note(`[early-farm] seeds: ${r.line} (${r.s.toFixed(1)} s), ${inv.count('wheat_seeds')} seeds left`);
    expect(r.line).toMatch(/^farm new: done in/);
    const t = await plotTruth(b, farmWater(b), 3);
    note(`[early-farm] seeds truth: ${JSON.stringify(t)}`);
    // a dry plot: as many cells tilled as there were seeds, each planted
    expect(t.crops).toBeGreaterThan(0);
    expect(t.farmland).toBe(t.crops);
    await sleep(500);
  }, 420_000);
});
