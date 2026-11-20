// e2e (tag @bds), Track K4 (docs/flight.md "An elytra on hand"; decisions/0108): a worn elytra and a better one to hand,
// on bds-fly (flat, peaceful, fall damage on, truth pack). One afk-task bot; every case gives a worn elytra (58 uses left:
// 28 over the worn limit of 30, short of a trip of 400 blocks, which needs about 60) and `!goto` 400 blocks away:
//   loose    a new elytra loose in the inventory beside it: flown on the new one, the worn one still carried
//   back     the worn one on the back (no chestplate) and a new one loose: put on in its place, flown, the worn one carried
//   box      a new one in a carried shulker box: taken out, flown on it, the worn one carried
//   home     a new one in a chest at home, the bot at home (the chests in reach): taken, flown on it, the worn one carried
//   none     nothing better anywhere: refused with a line that says what is missing, and walked
//   unload   the worn one and a new one carried, `!unload` at home: the worn one goes into the chest, the new one stays
// K4_BEFORE=1: the cases only record, with elytraSpare off (the hooks then return before anything: the tree before).
// K4_PROBE=1: also the renewing probes (Mending worn and carried with experience orbs, `/xp`, the multi recipes).
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1, K4_NOTE=<file>, K4_ONLY=<case>.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { craftControlOf } from '../../src/chat/commands-craft.ts';
import { E2E, FEET_Y, flyCmd, giveFlightKit, hdist, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const BEFORE = process.env.K4_BEFORE === '1';
const PROBE = process.env.K4_PROBE === '1';
const ONLY = process.env.K4_ONLY;
const NOTE = process.env.K4_NOTE;
/** Uses spent on the worn elytra: 58 left. */
const WORN = 432 - 58;
const TRIP = 400;

interface Elytras {
  chest: number | undefined;
  /** Uses left of every elytra in the inventory, by slot. */
  slots: { slot: number; left: number }[];
}

describe.skipIf(!E2E)('@bds fly: an elytra on hand (Track K4)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const chest = { x: area.x + 3, y: F, z: area.z };
  const note = (line: string): void => {
    notes.push(line);
    if (NOTE) appendFileSync(NOTE, `${line}\n`);
  };
  const skip = (name: string): boolean => ONLY !== undefined && !ONLY.split(',').includes(name);

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Spare');
    if (BEFORE) bot.settings.set('elytraSpare', false);
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await noChest(bot).catch(() => undefined);
      await bot.truth.clearAround(home, 24).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[fly-elytra-spare e2e${BEFORE ? ' BEFORE' : ''}] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  const elytras = async (b: FlyBot): Promise<Elytras> => {
    const d = await b.truth.ok<{ slots: ({ slot?: number; typeId: string; damage: number } | null)[]; equipment: Record<string, { typeId: string; damage: number | null } | null> }>('durability', [b.name]);
    const c = d.equipment.Chest;
    const slots: { slot: number; left: number }[] = [];
    d.slots.forEach((s, i) => {
      if (s?.typeId.endsWith('elytra')) slots.push({ slot: s.slot ?? i, left: 432 - s.damage });
    });
    return { chest: c?.typeId.endsWith('elytra') ? 432 - (c.damage ?? 0) : undefined, slots };
  };
  const fmtE = (e: Elytras): string => `back ${e.chest ?? '-'}; carried ${e.slots.map((s) => `${s.left}@${s.slot}`).join(', ') || 'none'}`;
  const inv = (b: FlyBot) => b.built.mobility!.world.inventory;

  /** `!goto` 400 blocks east; the trip watched until it arrives (a flight) or 25 s of a walk; what flew and which elytra. */
  const trip = async (b: FlyBot, label: string): Promise<{ first: string; flew: boolean; arrived: boolean; said: string[]; before: Elytras; after: Elytras; dist: number; damage: number }> => {
    const before = await elytras(b);
    const goal = { x: area.x + TRIP, y: F, z: area.z };
    const from = b.said.length;
    const logFrom = b.logs.length;
    const since = await b.truth.now();
    const t0 = Date.now();
    await b.command(`!goto ${goal.x} ${goal.y} ${goal.z}`);
    const first = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('walking') || s.startsWith('goto: ') || s.startsWith('elytra'), from, 60_000).catch(() => 'no reply');
    let flew = false;
    let arrived = false;
    while (Date.now() - t0 < 200_000) {
      const g = await b.truth.glide(b.name).catch(() => undefined);
      if (g?.isGliding) flew = true;
      if (b.said.slice(from).some((s) => s.startsWith('arrived at ') || s.startsWith('goto: '))) {
        arrived = b.said.slice(from).some((s) => s.startsWith('arrived at '));
        break;
      }
      if (!flew && Date.now() - t0 > 25_000) break;
      await sleep(400);
    }
    await b.command('!stop');
    await sleep(1500);
    const g = await b.truth.glide(b.name);
    const after = await elytras(b);
    const dmg = await b.truth.damageSince(since, b.name);
    const said = b.said.slice(from);
    const r = { first, flew, arrived, said, before, after, dist: hdist(g.location, goal), damage: dmg.total };
    note(`${label} (${BEFORE ? 'before' : 'after'}): first "${first}"; flew ${flew}; arrived ${arrived}; ${r.dist.toFixed(0)} from the goal; damage ${dmg.total}; elytra before: ${fmtE(before)}; after: ${fmtE(after)}; ${((Date.now() - t0) / 1000).toFixed(0)} s; said: ${said.join(' | ')}; log: ${b.logs.slice(logFrom).filter((l) => /elytra|supply: /.test(l)).map((l) => l.replace(/^\S+ \S+ /, '').slice(0, 220)).slice(0, 8).join(' || ')}`);
    return r;
  };
  const status = async (b: FlyBot, label: string): Promise<string> => {
    const from = b.said.length;
    await b.command('!elytra status');
    const s = await b.reply((x) => x.startsWith('elytra') || x.startsWith('no elytra'), from, 10_000).catch(() => 'no reply');
    note(`${label} status: ${s}`);
    return s;
  };
  /** The worn elytra in slot 9 (the kit's), the chestplate on, 64 rockets. */
  const wornKit = async (b: FlyBot, chestplate = true): Promise<void> => {
    await b.command('!stop');
    await sleep(800);
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: WORN, chestplate });
  };
  /** The chest at home gone, and what it dropped (a chest broken drops its contents: the next case would pick an elytra up). */
  const noChest = async (b: FlyBot): Promise<void> => {
    await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'air']).catch(() => undefined);
    await sleep(300);
    await flyCmd('kill', `@e[type=item,x=${chest.x},y=${chest.y},z=${chest.z},r=12]`);
    await sleep(300);
  };
  const toHome = async (b: FlyBot): Promise<void> => {
    await teleport(b, home);
  };
  /** The flight went on a new elytra and the worn one is still carried. */
  const flownOnNew = (r: Awaited<ReturnType<typeof trip>>): void => {
    expect(r.flew, r.said.join(' | ')).toBe(true);
    expect(r.arrived, r.said.join(' | ')).toBe(true);
    expect(r.damage).toBe(0);
    const all = [...(r.after.chest !== undefined ? [r.after.chest] : []), ...r.after.slots.map((s) => s.left)];
    expect(all.some((l) => l === 58), `the worn one carried: ${fmtE(r.after)}`).toBe(true);
    expect(all.some((l) => l > 300 && l < 432), `the new one flown: ${fmtE(r.after)}`).toBe(true);
  };

  it.skipIf(skip('loose'))('a worn elytra and a new one loose: flown on the new one, the worn one carried', async () => {
    const b = bot!;
    await wornKit(b);
    await b.truth.setslot(b.name, 10, 'elytra', 1, 0);
    await until(() => (inv(b).slots[10]?.name === 'elytra' ? true : undefined), 5000, 'the new elytra in slot 10');
    await status(b, 'loose');
    const r = await trip(b, 'loose');
    await toHome(b);
    if (BEFORE) return;
    flownOnNew(r);
  }, 300_000);

  it.skipIf(skip('back'))('the worn elytra on the back and a new one loose: put on in its place', async () => {
    const b = bot!;
    await wornKit(b, false);
    await b.truth.setslot(b.name, 9, 'air');
    await b.truth.equip(b.name, 'Chest', 'elytra', 1, WORN);
    await b.truth.setslot(b.name, 12, 'elytra', 1, 0);
    await until(() => (inv(b).slots[12]?.name === 'elytra' && inv(b).window(120)?.slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the worn one on, the new one in slot 12');
    const r = await trip(b, 'back');
    await toHome(b);
    if (BEFORE) return;
    flownOnNew(r);
  }, 300_000);

  it.skipIf(skip('box'))('a worn elytra and a new one in a carried shulker box: taken out and flown', async () => {
    const b = bot!;
    await wornKit(b);
    const feet = b.task.position()!;
    const at = { x: Math.floor(feet.x) + 1, y: Math.floor(feet.y), z: Math.floor(feet.z) };
    await b.truth.boxdrop(at, 'elytra', 1, 1);
    const hasBox = () => (inv(b).slots.slice(0, 36).some((s) => s?.name.endsWith('shulker_box')) ? true : undefined);
    await sleep(1200);
    if (!hasBox()) await b.built.mobility!.skills.collect(4, 160, { origin: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 } });
    await until(hasBox, 10_000, 'the box in the inventory');
    await status(b, 'box');
    const r = await trip(b, 'box');
    await toHome(b);
    if (BEFORE) return;
    flownOnNew(r);
    expect(r.after.slots.length + (r.after.chest !== undefined ? 1 : 0)).toBe(2);
  }, 300_000);

  it.skipIf(skip('home'))('a worn elytra and a new one in a chest at home, the bot at home: taken and flown', async () => {
    const b = bot!;
    await wornKit(b);
    await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'chest']);
    await truthLoaded(b.truth, 'chestput', [chest.x, chest.y, chest.z, 'elytra', 1, 1]);
    b.task.home!.set({ x: area.x, y: F, z: area.z });
    const from = b.said.length;
    await b.command('!chests clear');
    await sleep(500);
    await b.command('!chests scan');
    await b.reply((s) => /^chests: \d+ within/.test(s), from, 60_000).catch(() => undefined);
    await status(b, 'home');
    const r = await trip(b, 'home');
    const noCounts: Record<string, number> = {};
    const left = await b.truth.blockInv(chest).catch(() => ({ counts: noCounts }));
    note(`home: the chest holds ${JSON.stringify(left.counts)}`);
    await toHome(b);
    await noChest(b);
    b.task.home!.set(undefined);
    await b.command('!chests clear');
    if (BEFORE) return;
    flownOnNew(r);
    expect(left.counts['minecraft:elytra'] ?? 0).toBe(0);
  }, 300_000);

  it.skipIf(skip('none'))('a worn elytra and nothing better anywhere: refused, the line says what is missing, walked', async () => {
    const b = bot!;
    await wornKit(b);
    const s = await status(b, 'none');
    const r = await trip(b, 'none');
    await toHome(b);
    if (BEFORE) return;
    expect(s).toContain('no spare (carried, in the boxes or at home in reach)');
    expect(r.flew).toBe(false);
    expect(r.said.some((x) => x.includes('the elytra has 58 uses left') && x.includes('no spare that covers it') && x.endsWith('; walking')), r.said.join(' | ')).toBe(true);
    expect(r.after.slots.map((x) => x.left)).toEqual([58]);
  }, 300_000);

  it.skipIf(skip('unload'))('the worn elytra and a new one carried, !unload at home: the worn one stored, the new one kept', async () => {
    const b = bot!;
    await wornKit(b);
    await b.truth.setslot(b.name, 10, 'elytra', 1, 0);
    await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'chest']);
    b.task.home!.set({ x: area.x, y: F, z: area.z });
    await b.truth.ok('give', [b.name, 'cobblestone', 64]);
    await until(() => (inv(b).slots[10]?.name === 'elytra' && inv(b).slots.some((x) => x?.name === 'cobblestone') ? true : undefined), 5000, 'the kit');
    const from = b.said.length;
    await b.command('!chests clear');
    await sleep(500);
    await b.command('!chests scan');
    await b.reply((s) => /^chests: \d+ within/.test(s), from, 60_000).catch(() => undefined);
    await b.command('!unload');
    const start = await b.reply((s) => s.startsWith('unloading ') || s.startsWith('unload: '), from, 30_000);
    const end = start.startsWith('unload: ') ? start : await b.reply((s) => s.startsWith('unloaded: ') || s.startsWith('unload: '), from, 120_000);
    const box = await b.truth.blockInv(chest);
    const after = await elytras(b);
    note(`unload (${BEFORE ? 'before' : 'after'}): ${start} -> ${end}; the chest holds ${JSON.stringify(box.counts)}; elytra: ${fmtE(after)}`);
    await noChest(b);
    b.task.home!.set(undefined);
    await b.command('!chests clear');
    if (BEFORE) return;
    expect(box.counts['minecraft:elytra'] ?? 0).toBe(1);
    expect(after.slots.map((x) => x.left)).toEqual([432]);
  }, 300_000);

  // ---- the renewing probes (K4_PROBE=1) --------------------------------------------------------------------------------
  /** Mending on the elytra in hotbar slot 1 (held for /enchant). */
  const mendingElytra = async (b: FlyBot, damage: number): Promise<void> => {
    await b.truth.setslot(b.name, 9, 'air');
    await b.truth.setslot(b.name, 1, 'elytra', 1, damage);
    await until(() => (inv(b).slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the elytra in hotbar slot 1');
    b.task.pve!.hotbar.select(1);
    await b.built.mobility!.loop.waitTicks(10);
    await flyCmd('enchant', b.name, 'mending', '1');
    await sleep(1000);
    b.task.pve!.hotbar.select(0);
    await b.built.mobility!.loop.waitTicks(10);
  };
  const orbs = async (b: FlyBot, n: number): Promise<void> => {
    const p = b.task.position()!;
    for (let i = 0; i < n; i++) await flyCmd('summon', 'xp_orb', String(Math.floor(p.x)), String(Math.floor(p.y) + 1), String(Math.floor(p.z)));
    await sleep(4000);
  };

  it.skipIf(!PROBE)('probe: Mending with experience orbs, worn and carried; /xp; the multi recipes', async () => {
    const b = bot!;
    // worn: the Mending elytra on the back, orbs at the feet
    await wornKit(b, false);
    await mendingElytra(b, 300);
    const from = b.said.length;
    await b.command('!equip slot 1');
    await b.reply((s) => s.length > 0, from, 5000).catch(() => undefined);
    await until(() => (inv(b).window(120)?.slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the elytra on');
    const w0 = await elytras(b);
    await orbs(b, 10);
    const w1 = await elytras(b);
    note(`probe mending worn: ${fmtE(w0)} -> 10 orbs -> ${fmtE(w1)}; enchants ${JSON.stringify(inv(b).window(120)?.slots[1]?.enchants ?? null)}`);
    await flyCmd('xp', '200', b.name);
    await sleep(1500);
    const w2 = await elytras(b);
    note(`probe /xp 200 with the Mending elytra worn: ${fmtE(w1)} -> ${fmtE(w2)}`);
    // carried: the chestplate on, the Mending elytra in the inventory
    await wornKit(b, true);
    await mendingElytra(b, 300);
    const c0 = await elytras(b);
    await orbs(b, 10);
    const c1 = await elytras(b);
    note(`probe mending carried (not worn, not held): ${fmtE(c0)} -> 10 orbs -> ${fmtE(c1)}`);
    // held in the main hand
    b.task.pve!.hotbar.select(1);
    await b.built.mobility!.loop.waitTicks(10);
    await orbs(b, 10);
    const c2 = await elytras(b);
    b.task.pve!.hotbar.select(0);
    note(`probe mending held in the main hand: ${fmtE(c1)} -> 10 orbs -> ${fmtE(c2)}`);
    // the recipes the server sends that the index drops
    const cc = craftControlOf(b.task);
    const grid = cc?.recipes.byOutput('elytra') ?? [];
    note(`probe recipes: multi recipes ${JSON.stringify(cc?.recipes.multi ?? null)}; grid recipes making an elytra ${grid.length}; kept ${cc?.recipes.stats.kept} of ${cc?.recipes.stats.seen}; phantom_membrane recipes as output ${cc?.recipes.byOutput('phantom_membrane').length ?? 0}`);
    expect(w1.chest).toBeDefined();
  }, 300_000);
});
