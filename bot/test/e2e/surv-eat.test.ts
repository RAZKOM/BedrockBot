// PLAN.md task 7.11 on bds-surv (difficulty normal): the survival kit of the afk task eats when the
// food is lowered (bread fetched from the main inventory; food and saturation read by the truth pack,
// the server's item use log shows start -> complete), puts on iron armour given into the inventory
// (truth reads the equipment), and a zombie's hits do less damage with it than without. Also the
// `!eat`, `!equip` and `!inv` commands. Needs BDS_E2E=1 and bds-surv with the truth pack
// (`node scripts/bds.mjs --profile surv up` and `... pack`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centre, tracked } from './pve-truth.ts';
import { command, E2E, FEET_Y, flatten, loadout, prepareServer, privateArea, startSurvBot, teleport, until, type SurvBot } from './surv-truth.ts';

describe.skipIf(!E2E)('survival: eating and armour (task 7.11)', () => {
  let bot: SurvBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  const note = (s: string) => {
    console.log(s);
    measurements.push(s);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startSurvBot('SurvEat');
    await teleport(bot, centre(HOME));
    await flatten(bot, HOME.x, HOME.z, 8);
    await bot.truth.clearAround(centre(HOME), 32);
    await bot.truth.setHealth(bot.name, 20);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 32).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  });

  it('eats bread from the main inventory when the food is lowered (food rises, server use log start -> complete)', async () => {
    const b = bot!;
    const inv = b.built.mobility!.world.inventory;
    // hotbar: a sword and 7 stone stacks, slot 8 free; bread only in the main inventory
    const slots: Record<number, [string, number?]> = { 0: ['iron_sword'], 20: ['bread', 5] };
    for (let i = 1; i < 8; i++) slots[i] = ['stone', 64];
    await loadout(b, slots);
    const since = await b.truth.now();
    const t0 = Date.now();
    const before = await b.truth.setFood(b.name, 10, 0, 0);
    expect(before.food).toBe(10);
    const after = await until(async () => {
      const f = await b.truth.food(b.name);
      return f.food > 10 ? f : undefined;
    }, 20_000, 'food above 10', 100);
    const ms = Date.now() - t0;
    const uses = await b.truth.uselog(since, b.name);
    const start = uses.find((u) => u.kind === 'start');
    const done = uses.find((u) => u.kind === 'complete');
    const tinv = await b.truth.inv(b.name);
    note(`eat (main inventory): food 10 -> ${after.food}, saturation 0 -> ${after.saturation} after ${ms} ms; uses ${uses.map((u) => `${u.kind}@${u.tick}`).join(' ')}; bread left ${tinv.counts['minecraft:bread']} (slot ${tinv.slots.findIndex((s) => s?.typeId === 'minecraft:bread')})`);
    expect(after.food).toBe(15); // bread: 5 hunger
    expect(after.saturation).toBeCloseTo(6, 1);
    expect(start?.typeId).toBe('minecraft:bread');
    expect(done).toBeDefined();
    expect(done!.tick - start!.tick).toBeGreaterThanOrEqual(30);
    expect(tinv.counts['minecraft:bread']).toBe(4);
    expect(tinv.slots.findIndex((s) => s?.typeId === 'minecraft:bread')).toBe(8); // moved into the free hotbar slot
    // the model agrees and the sword is held again
    await until(() => (inv.slots[8]?.name === 'bread' && inv.slots[8].count === 4 ? true : undefined), 5_000, 'model bread 4 in slot 8');
    await until(() => (inv.selected === 0 ? true : undefined), 3_000, 'the sword selected again');
    expect(b.kit.eater.stats.eaten).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('keeps eating from the hotbar until food is 18 or more; never eats rotten flesh while bread is there', async () => {
    const b = bot!;
    await loadout(b, { 0: ['rotten_flesh', 8], 1: ['bread', 6] });
    const since = await b.truth.now();
    await b.truth.setFood(b.name, 4, 0, 0);
    const f = await until(async () => {
      const x = await b.truth.food(b.name);
      return x.food >= 18 ? x : undefined;
    }, 40_000, 'food 18 or more', 250);
    const uses = await b.truth.uselog(since, b.name);
    const eaten = uses.filter((u) => u.kind === 'complete').map((u) => u.typeId);
    const tinv = await b.truth.inv(b.name);
    note(`starving (food 4): ate ${eaten.join(', ')} -> food ${f.food}, rotten flesh left ${tinv.counts['minecraft:rotten_flesh']}`);
    expect(eaten.every((t) => t === 'minecraft:bread')).toBe(true);
    expect(eaten.length).toBe(3); // 4 + 5 x 3 = 19
    expect(tinv.counts['minecraft:rotten_flesh']).toBe(8);
  }, 60_000);

  it('!eat eats now; !inv summarises', async () => {
    const b = bot!;
    await loadout(b, { 0: ['iron_sword'], 3: ['cooked_beef', 2] });
    await b.truth.setFood(b.name, 19, 0, 0);
    await b.built.mobility!.loop.waitTicks(4);
    const r = await command(b, '!eat', 20_000);
    note(`!eat -> ${r}`);
    expect(r).toMatch(/^ate cooked_beef: food 19 -> 20/);
    const inv = await command(b, '!inv');
    note(`!inv -> ${inv}`);
    expect(inv).toMatch(/inv 2\/36, held 0 iron_sword x1/);
    expect(inv).toContain('cooked_beef x1');
  }, 60_000);

  /** Summon a zombie next to the bot, let it hit `hits` times (health reset to 20 in between), return the damage per hit. */
  async function zombieHits(hits: number): Promise<{ perHit: number[]; health: number[] }> {
    const b = bot!;
    b.pve.setGuard({ on: false });
    await teleport(b, centre(HOME));
    await b.truth.setHealth(b.name, 20);
    const since = await b.truth.now();
    const z = await b.truth.summon('zombie', { x: HOME.x + 0.5 + 1.5, y: FEET_Y, z: HOME.z + 0.5 });
    await tracked(b, z);
    const healthAfter: number[] = [];
    try {
      await until(async () => {
        const log = await b.truth.hurtlog(since, b.name);
        const mine = log.events.filter((e) => e.victimName === b.name && e.damagerType === 'minecraft:zombie');
        if (mine.length > healthAfter.length) {
          for (const e of mine.slice(healthAfter.length)) healthAfter.push(e.healthAfter ?? NaN);
          await b.truth.setHealth(b.name, 20);
        }
        return mine.length >= hits ? true : undefined;
      }, 60_000, `${hits} zombie hits`, 100);
    } finally {
      await b.truth.cleanup();
    }
    const log = await b.truth.hurtlog(since, b.name);
    const mine = log.events.filter((e) => e.victimName === b.name && e.damagerType === 'minecraft:zombie').slice(0, hits);
    return { perHit: mine.map((e) => +e.damage.toFixed(2)), health: healthAfter.slice(0, hits) };
  }

  it('puts on iron armour given into the inventory; a zombie hit does less damage with it', async () => {
    const b = bot!;
    // without armour
    await loadout(b, { 0: ['iron_sword'] });
    await b.truth.unequip(b.name);
    await b.truth.setFood(b.name, 20, 5, 0);
    const bare = await zombieHits(3);
    // armour into the main inventory and the hotbar
    const t0 = Date.now();
    await loadout(b, { 0: ['iron_sword'] });
    for (const [slot, piece] of [[2, 'iron_helmet'], [12, 'iron_chestplate'], [13, 'iron_leggings'], [30, 'iron_boots']] as const) await b.truth.setSlot(b.name, slot, piece);
    const eq = await until(async () => {
      const inv = await b.truth.inv(b.name);
      return Object.keys(inv.equipment).length >= 4 ? inv.equipment : undefined;
    }, 15_000, 'four armour pieces worn', 200);
    const wornMs = Date.now() - t0;
    expect(eq.Head?.typeId).toBe('minecraft:iron_helmet');
    expect(eq.Chest?.typeId).toBe('minecraft:iron_chestplate');
    expect(eq.Legs?.typeId).toBe('minecraft:iron_leggings');
    expect(eq.Feet?.typeId).toBe('minecraft:iron_boots');
    const tinv = await b.truth.inv(b.name);
    expect(Object.keys(tinv.counts).filter((k) => k.startsWith('minecraft:iron_') && k !== 'minecraft:iron_sword')).toEqual([]);
    expect(b.kit.armour.worn().map((w) => w?.name ?? null)).toEqual(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
    const armoured = await zombieHits(3);
    const mean = (xs: number[]) => xs.reduce((a, c) => a + c, 0) / xs.length;
    const lost = (hs: number[]) => hs.map((h) => +(20 - h).toFixed(2));
    note(`armour: worn after ${wornMs} ms; zombie damage per hit without ${bare.perHit.join(', ')} (health lost ${lost(bare.health).join(', ')}), with full iron ${armoured.perHit.join(', ')} (health lost ${lost(armoured.health).join(', ')})`);
    expect(mean(lost(armoured.health))).toBeLessThan(mean(lost(bare.health)));
  }, 180_000);

  it('!equip upgrades a worn piece (swap) and reports nothing better afterwards', async () => {
    const b = bot!;
    await b.truth.unequip(b.name);
    await loadout(b, { 0: ['iron_sword'], 15: ['leather_chestplate'] });
    await until(async () => ((await b.truth.inv(b.name)).equipment.Chest?.typeId === 'minecraft:leather_chestplate' ? true : undefined), 15_000, 'leather worn', 200);
    b.kit.overrides.autoArmour = false;
    await b.truth.setSlot(b.name, 16, 'diamond_chestplate');
    await until(() => (b.built.mobility!.world.inventory.slots[16]?.name === 'diamond_chestplate' ? true : undefined), 5_000, 'diamond in the model');
    const r = await command(b, '!equip', 20_000);
    note(`!equip -> ${r}`);
    expect(r).toBe('equip: wearing chest diamond_chestplate');
    const inv = await b.truth.inv(b.name);
    expect(inv.equipment.Chest?.typeId).toBe('minecraft:diamond_chestplate');
    expect(inv.slots[16]?.typeId).toBe('minecraft:leather_chestplate');
    const again = await command(b, '!equip', 20_000);
    expect(again).toMatch(/^equip: nothing better/);
    b.kit.overrides.autoArmour = true;
  }, 60_000);
});
