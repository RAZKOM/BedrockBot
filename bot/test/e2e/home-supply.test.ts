// e2e (tag @bds), wave 12 Track BJ (decision 0052, docs/home.md "Supply"): the shulker-aware jobs on bds-home
// (flat, peaceful, truth pack). One afk-task bot (walking, the CLI's wiring, settings in memory) in its own
// random area and a home of 3 chests built by truth; the full boxes are filled by truth as blocks, broken
// and picked up by the bot (a box item with its NBT `Items`) and stored by it:
//   A  5 east of home    640 dirt loose (10 stacks) + 1 box of 1728 dirt
//   B  5 west of home    1 box of 1728 sand, nothing loose
//   C  5 south of home   empty (the unload's target)
//   big      `!bring dirt 1000 home`: the full box comes, not 10 loose stacks (A keeps its 640 loose dirt)
//   small    `!bring sand 10 home`: 10 sand taken out of the box next to the bot, the box back in B (1718 inside)
//   build    `!build fill` 5x3x5 cobblestone with 20 loose and 128 in a carried box (16 dirt as the reserve):
//            the build completes, 55 come out of the box, the box is carried again and nothing is left standing
//   crops    `!unload` with 192 carrots, 20 cooked beef, 64 wheat seeds: 44 carrots (the food reserve less the beef)
//            and 32 seeds stay, the beef stays, the rest goes into the chests
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts; default bds-home on 19196), HOME_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { E2E, FEET_Y, prepareServer, privateArea, sleep, startHomeBot, teleport, truthLoaded, until, type HomeBot } from './home-truth.ts';

const F = FEET_Y;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

describe.skipIf(!E2E)('@bds home: shulker-aware jobs (Track BJ)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  const c = area;
  const L = {
    home: { x: c.x, y: F, z: c.z },
    a: { x: c.x + 5, y: F, z: c.z },
    b: { x: c.x - 5, y: F, z: c.z },
    c: { x: c.x, y: F, z: c.z + 5 },
    spot: { x: c.x + 2, y: F, z: c.z - 2 },
    /** Out of homeChestRadius (16): a box block there is no home container for the chore to read. */
    far: { x: c.x - 14, y: F, z: c.z + 14 },
  };

  const clearBox = async (b: HomeBot) => {
    await truthLoaded(b.truth, 'fill', [c.x - 16, F - 3, c.z - 16, c.x + 16, F - 2, c.z + 16, 'stone']);
    await truthLoaded(b.truth, 'fill', [c.x - 16, F - 1, c.z - 16, c.x + 16, F - 1, c.z + 16, 'grass_block']);
    await truthLoaded(b.truth, 'fill', [c.x - 16, F, c.z - 16, c.x + 16, F + 6, c.z + 16, 'air']);
  };

  /** The inventory slots holding a shulker box. */
  const boxSlots = (b: HomeBot): number[] => {
    const inv = b.built.mobility!.world.inventory;
    return inv.slots.flatMap((s, k) => (k < 36 && !!s && isShulkerBox(s.name) ? [k] : []));
  };

  /**
   * A full box of `item` (`stacks` stacks of 64) in the bot's inventory: filled by truth as a block, broken and picked up by
   * the bot. Robust against an earlier file on the same server (review of dc333dd: the setup flaked after home-bring):
   * stray items around the cell are removed first, the box's contents are polled by truth (no fixed sleep), and the box
   * picked up is matched by what it holds (its NBT may arrive a moment after the slot); the pickup is retried.
   */
  async function makeBox(b: HomeBot, item: string, stacks: number, at: Vec3 = L.spot): Promise<number> {
    const mob = b.built.mobility!;
    const want = 64 * stacks;
    await b.truth.ok('clearmobs', [at.x + 0.5, at.y, at.z + 0.5, 8]); // stray boxes and items of earlier runs
    const before = new Set(boxSlots(b));
    await truthLoaded(b.truth, 'set', [at.x, at.y, at.z, 'undyed_shulker_box']);
    await b.truth.chestPut(at, item, 64, stacks);
    await until(async () => ((await b.truth.box(at)).counts[item] === want ? true : undefined), 10_000, `truth: the box holds ${want} ${item}`);
    const dg = await mob.skills.dig(at);
    if (!dg.ok) throw new Error(`breaking the box: ${dg.reason}`);
    const mine = (): number | undefined => boxSlots(b).find((k) => !before.has(k) && shulkerContents(mob.world.inventory.rawItem(0, k))[item] === want);
    for (let attempt = 0; attempt < 3 && mine() === undefined; attempt++) {
      await mob.skills.collect(5 + 3 * attempt, 100, { origin: centre(at), filter: (i) => isShulkerBox(i.name) });
      await until(() => mine(), 4_000, 'the box in the inventory').catch(() => undefined);
    }
    const slot = mine();
    if (slot === undefined) throw new Error(`the box was not picked up (new box slots: ${JSON.stringify(boxSlots(b).filter((k) => !before.has(k)).map((k) => shulkerContents(mob.world.inventory.rawItem(0, k))))})`);
    return slot;
  }

  async function store(b: HomeBot, slot: number, at: Vec3): Promise<void> {
    const mob = b.built.mobility!;
    const o = await mob.skills.open(at);
    if (!o.ok) throw new Error(`opening ${at.x} ${at.z}: ${o.reason}`);
    const dep = await mob.skills.chest!.depositSlots(o.view, [{ slot, count: 1 }]);
    await mob.skills.closeContainer(o.view);
    if (dep.total !== 1) throw new Error(`storing the box: ${dep.reason}`);
  }

  async function reset(b: HomeBot, at: Vec3 = L.home): Promise<void> {
    await teleport(b, centre(at));
    await b.truth.ok('clear', [b.name]);
    await until(() => (b.built.mobility!.world.inventory.slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    await sleep(300);
  }

  async function bring(b: HomeBot, cmd: string): Promise<{ start: string; end: string; ms: number }> {
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(cmd);
    const start = await b.reply((s) => s.startsWith('bringing ') || s.startsWith('bring: '), from);
    const end = start.startsWith('bring: ') ? start : await b.reply((s) => s.startsWith('brought ') || (s.startsWith('bring: ') && s !== start), from, 180_000);
    return { start, end, ms: Date.now() - t0 };
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('Supply');
    bot = b;
    b.settings.set('autoUnload', 'off');
    await teleport(b, centre(L.home));
    await clearBox(b);
    for (const p of [L.a, L.b, L.c]) await truthLoaded(b.truth, 'set', [p.x, p.y, p.z, 'chest']);
    await b.truth.chestPut(L.a, 'dirt', 64, 10);
    await b.truth.ok('clear', [b.name]);
    await sleep(500);
    for (const [item, at] of [['dirt', L.a], ['sand', L.b]] as const) {
      await teleport(b, centre({ x: L.spot.x, y: F, z: L.spot.z + 2 }));
      const slot = await makeBox(b, item, 27);
      await teleport(b, centre({ x: at.x + (at.x > c.x ? -2 : 2), y: F, z: at.z }));
      await store(b, slot, at);
    }
    b.task.home!.set(L.home);
    await teleport(b, centre(L.home));
    const from = b.said.length;
    await b.command('!chests scan');
    notes.push(`scan: ${await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000)}`);
    const a = b.home.memory().get(L.a);
    notes.push(`A in memory: ${JSON.stringify(a?.contents)} boxList ${JSON.stringify(a?.boxList)}`);
    if (a?.boxList?.[0]?.dirt !== 1728) throw new Error('the memory does not know the box of dirt');
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      for (const p of [L.a, L.b, L.c]) await truthLoaded(bot.truth, 'container', [p.x, p.y, p.z, 'clear']).catch(() => undefined);
      await clearBox(bot).catch(() => undefined);
      await bot.truth.clearAround(centre(L.home), 40).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[home-supply e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('!bring dirt 1000: the full box comes, not the loose stacks', async () => {
    const b = bot!;
    await reset(b);
    const r = await bring(b, '!bring dirt 1000 home');
    const counts = await b.truth.counts(b.name);
    const ta = await b.truth.box(L.a);
    notes.push(`big: ${r.start} | ${r.end} (${(r.ms / 1000).toFixed(1)} s; truth inventory ${JSON.stringify(counts)}; A ${JSON.stringify(ta.counts)})`);
    expect(r.start).toBe('bringing 1000 dirt to home (from 1 chest, a full shulker box comes along)');
    expect(r.end).toBe(`brought 1 shulker box holding 1728 dirt home (from 1 chest; a full shulker box out of chest ${L.a.x} ${L.a.y} ${L.a.z})`);
    expect(counts.undyed_shulker_box).toBe(1);
    expect(counts.dirt ?? 0).toBe(0);
    expect(ta.counts.dirt).toBe(640);
    expect(ta.counts.undyed_shulker_box ?? 0).toBe(0);
  }, 240_000);

  it('!bring sand 10 from a box only: 10 sand out of the box next to the bot, the box goes back', async () => {
    const b = bot!;
    await reset(b);
    const r = await bring(b, '!bring sand 10 home');
    await sleep(500);
    const counts = await b.truth.counts(b.name);
    const tb = await b.truth.box(L.b);
    const mem = b.home.memory().get(L.b);
    notes.push(`small: ${r.start} | ${r.end} (${(r.ms / 1000).toFixed(1)} s; truth inventory ${JSON.stringify(counts)}; B ${JSON.stringify(tb.counts)}; memory ${JSON.stringify(mem?.boxList)})`);
    expect(r.start).toBe('bringing 10 sand to home (from 1 chest, some taken out of a shulker box, which goes back)');
    expect(r.end).toBe(`brought 10 sand home (from 1 chest; 10 taken out of a shulker box from chest ${L.b.x} ${L.b.y} ${L.b.z}, the box went back)`);
    expect(counts.sand).toBe(10);
    expect(counts.undyed_shulker_box ?? 0).toBe(0);
    expect(tb.counts.undyed_shulker_box).toBe(1);
    expect(mem?.boxList).toEqual([{ sand: 1718 }]);
    // nothing left standing around home
    const items = await b.truth.boxItems(centre(L.home), 12);
    expect(items.filter((i) => i.typeId.includes('shulker'))).toEqual([]);
  }, 240_000);

  it('!build fill with 20 cobblestone loose and 128 in a carried box: refilled from the box, the box carried again', async () => {
    const b = bot!;
    const stand = { x: c.x - 4, y: F, z: c.z - 4 };
    await reset(b, { x: L.far.x, y: F, z: L.far.z - 2 });
    const slot = await makeBox(b, 'cobblestone', 2, L.far);
    await teleport(b, centre(stand));
    await b.truth.ok('give', [b.name, 'cobblestone', 20]);
    await b.truth.ok('give', [b.name, 'dirt', 16]);
    await sleep(800);
    const min = { x: c.x - 11, y: F, z: c.z - 11 };
    const max = { x: c.x - 7, y: F + 2, z: c.z - 7 };
    const box = `${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z}`;
    let from = b.said.length;
    await b.command(`!build materials fill ${box} cobblestone`);
    const m = await b.reply((s) => s.startsWith('materials '), from);
    from = b.said.length;
    const t0 = Date.now();
    await b.command(`!build fill ${box} cobblestone`);
    const first = await b.reply((s) => s.startsWith('building ') || s.startsWith('build'), from);
    const end = await b.reply((s) => s.startsWith('build fill '), from, 400_000);
    await sleep(1000);
    const counts = await b.truth.counts(b.name);
    const inv = b.built.mobility!.world.inventory;
    const boxes = boxSlots(b).map((k) => shulkerContents(inv.rawItem(0, k)));
    const refills = b.logs.filter((l) => l.includes('out of my shulker boxes') || l.includes('supply:'));
    notes.push(`build: ${m} | ${first} | ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s; truth ${JSON.stringify(counts)}; boxes ${JSON.stringify(boxes)}; ${refills.join(' / ')})`);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(m).toBe('materials for fill 5x3x5 cobblestone: 75 cobblestone; have everything (out of my shulker boxes as needed: 55 cobblestone)');
    expect(first).toBe('building fill 5x3x5 cobblestone: 75 to place');
    expect(end).toMatch(/^build fill 5x3x5 cobblestone: done, 75 \/ 75 placed, 0 skipped/);
    expect(boxes).toEqual([{ cobblestone: 73 }]);
    expect(counts.cobblestone ?? 0).toBe(0);
    expect(counts.dirt).toBe(16);
    const left = await b.truth.boxItems(centre(stand), 16);
    expect(left.filter((i) => i.typeId.includes('shulker'))).toEqual([]);
  }, 480_000);

  it('!unload with a farm haul: the crop and seed surplus goes, the food reserve and the cooked food stay', async () => {
    const b = bot!;
    await reset(b);
    for (const [it, n] of [['carrot', 64], ['carrot', 64], ['carrot', 64], ['cooked_beef', 20], ['wheat_seeds', 64]] as const) await b.truth.ok('give', [b.name, it, n]);
    await sleep(800);
    const from = b.said.length;
    await b.command('!unload');
    const start = await b.reply((s) => s.startsWith('unloading ') || s.startsWith('unload: '), from);
    const end = await b.reply((s) => s.startsWith('unloaded') || (s.startsWith('unload: ') && s !== start), from, 180_000);
    await sleep(500);
    const counts = await b.truth.counts(b.name);
    notes.push(`crops: ${start} | ${end} (truth ${JSON.stringify(counts)}; known ${b.home.memory().all().map((r) => `${r.kind} ${r.x} ${r.z}`).join(', ')})`);
    expect(counts.carrot).toBe(44);
    expect(counts.wheat_seeds).toBe(32);
    expect(counts.cooked_beef).toBe(20);
    expect(end).toContain('kept');
    expect(end).toContain('44 carrot');
  }, 240_000);
});
