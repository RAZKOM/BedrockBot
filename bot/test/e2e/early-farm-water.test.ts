// e2e (tag @bds), Track E8 (docs/farming.md "Water for the plot", ADR 0105): the starter plot's water and seeds on a
// flat world. Each case sets home in its own corner of the run's area, `!farm new 5` with a stone hoe and an empty bucket.
//   pool      a sealed water layer 2 under the ground round home and a 3 x 3 pond 20 off: the pond fills the bucket (a
//             fresh world's plot had a cave pool under it and the search tried only that one; the tree before this track
//             also filled here: the flat case is a guard, the fault is shown by the unit test and the fresh-world runs);
//   far       one pond 132 from the plot (loaded, past the old 96): filled there;
//   seen      one pond 230 off that the bot saw before (the world cache's map layer), not loaded now: walked to and filled;
//   search    one pond 223 off never seen: the search walk's first leg brings it in view;
//   none      no water within 256: the plot dry, the reply says how far it looked;
//   late      the pour's place answer read `rejected` while the water goes in a moment later: the plot counts as wet;
//   fern      no seeds, ferns round home: seeds from ferns, planted;
//   rate      no seeds, short grass round home, a water bucket carried, `!farm new 9`: grass broken in the seed step;
//   topup     the farm chore (farmFood on), a watered 5 x 5 with 4 crops and 20 cells bare, grass round it: seeds got and
//             planted by the chore.
// E8_BEFORE=1 records without asserting (the tree before this track). Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT /
// CRAFT_BDS_CONTAINER (craft-truth.ts; a flat world), CRAFT_VERBOSE=1, EARLY_OUT, E8_CASES (comma list; default all).
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { waypointStoreOf } from '../../src/chat/commands-nav.ts';
import { farmNewControlOf, FARM_WAYPOINT } from '../../src/chat/commands-farm-new.ts';
import { openWorldCache } from '../../src/world/cache/index.ts';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const G = F - 1; // the soil
const BEFORE = process.env.E8_BEFORE === '1';
const CASES = (process.env.E8_CASES ?? '').split(',').filter(Boolean);
const want = (c: string): boolean => CASES.length === 0 || CASES.includes(c);
const check = (f: () => void): void => {
  if (!BEFORE) f();
};

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

async function plotTruth(b: CraftBot, w: Vec3, n: number): Promise<{ farmland: number; crops: number; water: boolean }> {
  const h = (n - 1) / 2;
  const out = { farmland: 0, crops: 0, water: false };
  for (let dx = -h; dx <= h; dx++)
    for (let dz = -h; dz <= h; dz++) {
      const g = (await b.truth.block({ x: w.x + dx, y: w.y, z: w.z + dz })).typeId;
      if (dx === 0 && dz === 0) out.water = g.includes('water');
      if (g === 'minecraft:farmland') out.farmland++;
      if ((await b.truth.block({ x: w.x + dx, y: w.y + 1, z: w.z + dz })).typeId === 'minecraft:wheat') out.crops++;
    }
  return out;
}

function farmWater(b: CraftBot): Vec3 | undefined {
  const wp = waypointStoreOf(b.task)?.get(FARM_WAYPOINT);
  return wp && typeof wp.y === 'number' ? { x: wp.x, y: wp.y, z: wp.z } : undefined;
}

/** A 3 x 3 pond one deep at the soil round `c` (still sources). */
const pond = (c: { x: number; z: number }, block = 'water'): Promise<void> => craftCmd('fill', String(c.x - 1), String(G), String(c.z - 1), String(c.x + 1), String(G), String(c.z + 1), block);

describe.skipIf(!E2E)('@bds early farm water and seeds (Track E8)', () => {
  // a region of its own (the ponds lie up to 236 from a home; the shared private areas are 128 wide): x, z from 40 960
  const cellE8 = privateArea().cell;
  const area = { x: 40_960 + 4096 * (cellE8 % 8), z: 40_960 + 4096 * Math.floor(cellE8 / 8) };
  let bot: CraftBot | undefined;
  /** Each case's home: far apart in the run's area so no case's water reaches another's plot. */
  const used: Vec3[] = [];
  const ponds: { x: number; z: number }[] = [];
  const homeOf = (i: number): Vec3 => ({ x: area.x - 600 + 1200 * (i % 2), y: F, z: area.z - 1500 + 600 * Math.floor(i / 2) });
  const goTo = async (b: CraftBot, h: Vec3): Promise<void> => {
    waypointStoreOf(b.task)?.delete(FARM_WAYPOINT);
    await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
    await clearArea(b.truth, h, 20, 4);
    used.push(h);
    b.task.home!.set(h);
    // water left by an earlier run that stopped before its tidy would be found first: back to grass
    const world = b.built.mobility!.world;
    const stray = world.find((x) => x.name.includes('water'), { origin: { x: h.x + 0.5, y: F, z: h.z + 0.5 }, radius: 160, max: 400 });
    for (const p of stray) await craftCmd('setblock', String(p.x), String(p.y), String(p.z), p.y === G ? 'grass_block' : 'air');
    if (stray.length) note(`[early-farm-water] ${stray.length} stray water cells near ${h.x} ${h.z} set back (first ${stray[0]!.x} ${stray[0]!.y} ${stray[0]!.z})`);
  };
  /** Back to grass: this case's ponds and the plot's middle water. */
  const tidy = async (b: CraftBot): Promise<void> => {
    for (const p of ponds.splice(0)) {
      await teleport(b, { x: p.x + 0.5, y: F, z: p.z + 3.5 }).catch(() => undefined);
      await pond(p, 'grass_block').catch(() => undefined);
    }
    const w = farmWater(b);
    if (w) await craftCmd('setblock', String(w.x), String(w.y), String(w.z), 'grass_block').catch(() => undefined);
  };
  const run = async (b: CraftBot, name: string, words: string, kit: readonly (readonly [string, number])[], timeoutMs: number) => {
    await loadKit(b, kit);
    const r = await farmNew(b, words, timeoutMs);
    const w = farmWater(b);
    const t = w ? await plotTruth(b, w, Number(words.split(' ')[0] ?? 5)) : undefined;
    note(`[early-farm-water] ${name}: ${r.line} (${r.s.toFixed(1)} s); truth ${JSON.stringify(t)}; bucket ${b.built.mobility!.world.inventory.count('bucket')}, water_bucket ${b.built.mobility!.world.inventory.count('water_bucket')}`);
    return { ...r, t };
  };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyWater');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await craftCmd('gamerule', 'keepinventory', 'true');
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      if (process.env.EARLY_OUT) appendFileSync(`${process.env.EARLY_OUT}.log`, `${bot.logs.join('\n')}\n--- said\n${bot.said.join('\n')}\n`);
      await tidy(bot).catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      for (const h of used) {
        await teleport(bot, { x: h.x + 0.5, y: F, z: h.z + 0.5 }).catch(() => undefined);
        await clearArea(bot.truth, h, 20, 4).catch(() => undefined);
        await craftCmd('fill', String(h.x - 20), String(F - 2), String(h.z - 20), String(h.x + 20), String(F - 3), String(h.z + 20), 'dirt').catch(() => undefined);
      }
      await bot.stop();
    }
  }, 600_000);

  it.skipIf(!want('pool'))('pool: a sealed pool under the plot and a pond 20 off: the pond fills the bucket', async () => {
    const b = bot!;
    const h = homeOf(0);
    await goTo(b, h);
    await craftCmd('fill', String(h.x - 18), String(F - 3), String(h.z - 18), String(h.x + 18), String(F - 3), String(h.z + 18), 'water');
    const p = { x: h.x - 20, z: h.z };
    await pond(p);
    ponds.push(p);
    await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
    const r = await run(b, 'pool', '5', [['stone_hoe', 1], ['wheat_seeds', 30], ['bucket', 1]], 300_000);
    await craftCmd('fill', String(h.x - 18), String(F - 3), String(h.z - 18), String(h.x + 18), String(F - 3), String(h.z + 18), 'dirt');
    await tidy(b);
    check(() => {
      expect(r.line).toMatch(/water poured \(filled \d+ off\)/);
      expect(r.t?.water).toBe(true);
    });
  }, 420_000);

  it.skipIf(!want('far'))('far: one pond 132 from the plot (loaded, past 96): filled there', async () => {
    const b = bot!;
    const h = homeOf(1);
    await goTo(b, h);
    const p = { x: h.x - 125, z: h.z };
    await teleport(b, { x: p.x + 0.5, y: F, z: p.z + 4.5 });
    await pond(p);
    ponds.push(p);
    await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
    const r = await run(b, 'far', '5', [['stone_hoe', 1], ['wheat_seeds', 30], ['bucket', 1]], 420_000);
    await tidy(b);
    check(() => {
      expect(r.line).toMatch(/water poured \(filled 1[0-3]\d off\)/);
      expect(r.t?.water).toBe(true);
    });
  }, 600_000);

  it.skipIf(!want('seen'))('seen: a pond 230 off seen before, not loaded now: walked to and filled', async () => {
    const b = bot!;
    const world = b.built.mobility!.world;
    const cache = openWorldCache(world, { root: mkdtempSync(join(tmpdir(), 'e8cache-')), server: 'e2e' });
    try {
      const h = homeOf(2);
      await goTo(b, h);
      const p = { x: h.x - 230, z: h.z };
      await teleport(b, { x: p.x + 0.5, y: F, z: p.z + 4.5 });
      await pond(p);
      ponds.push(p);
      // away and back: the pond's column loads again and is summarized with the pond in its map layer
      await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
      await sleep(2000);
      await teleport(b, { x: p.x + 0.5, y: F, z: p.z + 4.5 });
      await sleep(3000);
      await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
      await until(() => (world.blockAt({ x: p.x, y: G, z: p.z }) === undefined ? true : undefined), 20_000, 'the pond out of the loaded chunks');
      note(`[early-farm-water] seen: the pond remembered as ${JSON.stringify(cache.surfaceAt(p.x, p.z))}`);
      const r = await run(b, 'seen', '5', [['stone_hoe', 1], ['wheat_seeds', 30], ['bucket', 1]], 540_000);
      await tidy(b);
      check(() => {
        expect(r.line).toMatch(/water poured \(filled 2[23]\d off, seen before\)/);
        expect(r.t?.water).toBe(true);
      });
    } finally {
      cache.close();
    }
  }, 720_000);

  it.skipIf(!want('search'))('search: a pond 223 off never seen: the search walk finds it', async () => {
    const b = bot!;
    const h = homeOf(3);
    await goTo(b, h);
    const p = { x: h.x + 230, z: h.z };
    await teleport(b, { x: p.x + 0.5, y: F, z: p.z + 4.5 });
    await pond(p);
    ponds.push(p);
    await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
    const world = b.built.mobility!.world;
    await until(() => (world.blockAt({ x: p.x, y: G, z: p.z }) === undefined ? true : undefined), 20_000, 'the pond out of the loaded chunks');
    const r = await run(b, 'search', '5', [['stone_hoe', 1], ['wheat_seeds', 30], ['bucket', 1]], 540_000);
    await tidy(b);
    check(() => {
      expect(r.line).toMatch(/water poured \(filled 2\d\d off, walked \d+ looking\)/);
      expect(r.t?.water).toBe(true);
    });
  }, 720_000);

  it.skipIf(!want('none'))('none: no water within 256: dry, the reply says how far it looked', async () => {
    const b = bot!;
    const h = homeOf(4);
    await goTo(b, h);
    const r = await run(b, 'none', '5', [['stone_hoe', 1], ['wheat_seeds', 30], ['bucket', 1]], 600_000);
    await tidy(b);
    check(() => {
      expect(r.line).toMatch(/water dry \(none seen within 256, walked \d+ looking\)/);
      expect(r.t?.water).toBe(false);
      expect(r.t?.crops).toBe(24);
    });
  }, 720_000);

  it.skipIf(!want('late'))('late: the pour answer reads rejected, the water shows a moment later: wet', async () => {
    const b = bot!;
    const h = homeOf(5);
    await goTo(b, h);
    const skills = b.built.mobility!.skills;
    const place = skills.place.bind(skills);
    let faked = 0;
    // the place answer comes back at once as `rejected`; the real pour goes on and shows a few ticks later
    skills.place = (p: Vec3, o?: Parameters<typeof place>[1]) => {
      if (o?.item === 'water_bucket') {
        faked++;
        void place(p, o);
        return Promise.resolve({ ok: false, reason: 'rejected' });
      }
      return place(p, o);
    };
    try {
      const r = await run(b, 'late', '5', [['stone_hoe', 1], ['wheat_seeds', 30], ['water_bucket', 1]], 300_000);
      const late = b.logs.filter((l) => l.includes('the pour read'));
      note(`[early-farm-water] late: ${faked} pours answered rejected; ${late.join(' | ')}`);
      await tidy(b);
      check(() => {
        expect(faked).toBe(1);
        expect(r.line).toMatch(/water poured/);
        expect(r.t?.water).toBe(true);
        expect(late).toHaveLength(1);
      });
    } finally {
      skills.place = place;
    }
  }, 420_000);

  it.skipIf(!want('fern'))('fern: no seeds, ferns round home: seeds from the ferns, planted', async () => {
    const b = bot!;
    const h = homeOf(6);
    await goTo(b, h);
    await craftCmd('fill', String(h.x - 16), String(F), String(h.z - 16), String(h.x + 16), String(F), String(h.z + 16), 'fern');
    await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
    const r = await run(b, 'fern', '5', [['stone_hoe', 1], ['water_bucket', 1]], 420_000);
    await tidy(b);
    check(() => {
      expect(r.line).toMatch(/^farm new: done in .*, \d+ planted \(\d+ seeds from \d+ grass\)/);
      expect(r.t?.crops ?? 0).toBeGreaterThan(0);
    });
  }, 600_000);

  it.skipIf(!want('rate'))('rate: no seeds, short grass round home, a 9 x 9 with a water bucket: grass broken in the seed step', async () => {
    const b = bot!;
    const h = homeOf(7);
    await goTo(b, h);
    await craftCmd('fill', String(h.x - 20), String(F), String(h.z - 20), String(h.x + 20), String(F), String(h.z + 20), 'short_grass');
    await teleport(b, { x: h.x + 0.5, y: F, z: h.z + 0.5 });
    const r = await run(b, 'rate', '9', [['stone_hoe', 1], ['water_bucket', 1]], 540_000);
    const seedLine = b.logs.filter((l) => /grass broken, \d+ wheat seeds carried/.test(l)).at(-1);
    note(`[early-farm-water] rate: ${seedLine}`);
    await tidy(b);
    const m = /\((\d+) seeds from (\d+) grass\)/.exec(r.line);
    check(() => {
      expect(m).not.toBeNull();
      // a guard, not a before/after: one walk a plant broke 321 here, every plant in reach of a stand 358 (n1 each)
      expect(Number(m![2])).toBeGreaterThan(250);
    });
  }, 720_000);

  it.skipIf(!want('topup'))('topup: the farm chore breaks grass for the bare cells and plants them', async () => {
    const b = bot!;
    const h = homeOf(8);
    await goTo(b, h);
    const w = { x: h.x + 8, y: G, z: h.z };
    await craftCmd('fill', String(w.x - 2), String(G), String(w.z - 2), String(w.x + 2), String(G), String(w.z + 2), 'farmland', '["moisturized_amount"=7]');
    await craftCmd('setblock', String(w.x), String(G), String(w.z), 'water');
    await craftCmd('fill', String(w.x - 2), String(F), String(w.z - 2), String(w.x - 1), String(F), String(w.z - 1), 'wheat');
    await craftCmd('fill', String(h.x - 20), String(F), String(h.z + 4), String(h.x + 20), String(F), String(h.z + 20), 'short_grass');
    waypointStoreOf(b.task)?.set(FARM_WAYPOINT, w, { auto: true });
    await loadKit(b, [['stone_hoe', 1]]);
    const control = farmNewControlOf(b.task)!;
    const t0 = Date.now();
    b.settings.set('farmFood', 'on');
    await until(() => (control.chore.stats.finished > 0 || Date.now() - t0 > 150_000 ? true : undefined), 160_000, 'a farm chore run', 500);
    b.settings.set('farmFood', 'off');
    const t = await plotTruth(b, w, 5);
    note(`[early-farm-water] topup: ${JSON.stringify(control.chore.stats)} in ${((Date.now() - t0) / 1000).toFixed(1)} s; truth ${JSON.stringify(t)}`);
    await tidy(b);
    check(() => {
      expect(control.chore.stats.finished).toBeGreaterThan(0);
      expect(t.crops).toBeGreaterThan(4);
    });
  }, 300_000);
});
