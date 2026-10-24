// PLAN.md task 7.11 on bds-surv: tool wear (a pickaxe with 5 uses left is not chosen while a fresh one
// exists; a nearly broken sword is not the weapon), and the inventory keeper (cobblestone from the main
// inventory into the hotbar; rotten flesh dropped when the inventory is full, the item entity read by
// the truth pack; `!drop`). Needs BDS_E2E=1 and bds-surv with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { centre } from './pve-truth.ts';
import { command, E2E, FEET_Y, fill, flatten, loadout, prepareServer, privateArea, startSurvBot, teleport, until, type SurvBot } from './surv-truth.ts';

describe.skipIf(!E2E)('survival: tool wear and the inventory keeper (task 7.11)', () => {
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
    bot = await startSurvBot('SurvKeep');
    await teleport(bot, centre(HOME));
    await flatten(bot, HOME.x, HOME.z, 8);
    await bot.truth.clearAround(centre(HOME), 32);
    await bot.truth.setHealth(bot.name, 20);
    await bot.truth.setFood(bot.name, 20, 5, 0);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.clearAround(centre(HOME), 32).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  });

  it('digs with the fresh pickaxe, not the one with 5 uses left; picks the intact sword', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    await loadout(b, { 0: ['iron_pickaxe', 1, 245], 1: ['iron_pickaxe'], 2: ['diamond_sword', 1, 1556], 3: ['stone_sword'] });
    expect(mob.world.inventory.slots[0]?.damage).toBe(245); // the model reads the NBT Damage
    expect(mob.world.inventory.slots[1]?.damage).toBeUndefined();
    expect(b.kit.toolOk(mob.world.inventory.slots[0]!)).toBe(false);
    mob.skills.attach({}); // no-op: the kit's hook stays on the digger
    const target = { x: HOME.x + 2, y: FEET_Y, z: HOME.z };
    await fill(b, target, target, 'stone');
    await until(() => (mob.world.blockAt(target)?.name === 'stone' ? true : undefined), 5_000, 'stone in the model');
    const r = await mob.skills.dig(target);
    const d = await b.truth.durability(b.name);
    note(`tool wear: dig ${r.ok ? 'ok' : r.reason} with slot ${r.slot} (${r.item}) in ${r.ticks} ticks; durability after ${d.slots.map((s) => `${s.slot}:${s.typeId.slice(10)} ${s.damage}/${s.maxDurability}`).join(', ')}`);
    expect(r.ok).toBe(true);
    expect(r.slot).toBe(1);
    expect(d.slots.find((s) => s.slot === 0)?.damage).toBe(245);
    expect(d.slots.find((s) => s.slot === 1)?.damage).toBe(1);
    // the model follows the wear the server reports
    await until(() => (mob.world.inventory.slots[1]?.damage === 1 ? true : undefined), 5_000, 'damage 1 in the model');
    // weapon: the diamond sword with 5 uses left is skipped
    expect(b.pve.combat.selectWeapon()).toBe('stone_sword');
    b.kit.overrides.toolWearLimit = 2;
    expect(b.pve.combat.selectWeapon()).toBe('diamond_sword');
    delete b.kit.overrides.toolWearLimit;
  }, 60_000);

  it('moves cobblestone from the main inventory into a free hotbar slot', async () => {
    const b = bot!;
    const slots: Record<number, [string, number?]> = { 0: ['iron_pickaxe'] };
    for (let i = 1; i < 8; i++) slots[i] = ['stone', 64];
    b.kit.overrides.autoKeep = false;
    await loadout(b, { ...slots, 20: ['cobblestone', 40] });
    const t0 = Date.now();
    b.kit.overrides.autoKeep = true;
    const inv = await until(async () => {
      const x = await b.truth.inv(b.name);
      return x.slots[8]?.typeId === 'minecraft:cobblestone' ? x : undefined;
    }, 15_000, 'cobblestone in hotbar slot 8', 200);
    note(`keeper: 40 cobblestone 20 -> 8 after ${Date.now() - t0} ms; slot 20 now ${JSON.stringify(inv.slots[20])}`);
    expect(inv.slots[8]?.amount).toBe(40);
    expect(inv.slots[20]).toBeNull();
    expect(b.built.mobility!.world.inventory.slots[8]?.name).toBe('cobblestone');
  }, 60_000);

  it('drops rotten flesh when the inventory is full; keeps the rest', async () => {
    const b = bot!;
    const at = (await b.truth.pos(b.name)).location;
    await b.truth.clearAround(centre(HOME), 16);
    b.kit.overrides.autoKeep = false;
    await loadout(b, { 0: ['iron_pickaxe'] });
    await b.truth.ok('give', [b.name, 'cobblestone', 512]); // hotbar 1..8
    await b.truth.ok('give', [b.name, 'stone', 64 * 25]); // 9..33
    await b.truth.setSlot(b.name, 34, 'bone', 5);
    await b.truth.setSlot(b.name, 35, 'rotten_flesh', 20);
    const inv = b.built.mobility!.world.inventory;
    await until(() => (inv.freeSlots().length === 0 && inv.slots[35]?.name === 'rotten_flesh' ? true : undefined), 10_000, 'full inventory in the model');
    const t0 = Date.now();
    b.kit.overrides.autoKeep = true;
    const drops = await until(async () => {
      const items = await b.truth.items(at, 8, 'rotten_flesh');
      return items.length ? items : undefined;
    }, 15_000, 'a rotten flesh item entity', 200);
    const tinv = await b.truth.inv(b.name);
    note(`keeper (full): dropped rotten flesh after ${Date.now() - t0} ms: ${JSON.stringify(drops.map((d) => ({ amount: d.amount, at: [+d.location.x.toFixed(2), +d.location.z.toFixed(2)] })))}; bot at ${at.x.toFixed(2)} ${at.z.toFixed(2)}; left ${JSON.stringify(tinv.counts)}`);
    expect(drops.reduce((a, d) => a + d.amount, 0)).toBe(20);
    expect(tinv.counts['minecraft:rotten_flesh']).toBeUndefined();
    expect(tinv.counts['minecraft:bone']).toBe(5);
    expect(tinv.counts['minecraft:stone']).toBe(64 * 25);
    expect(tinv.counts['minecraft:iron_pickaxe']).toBe(1);
    await b.truth.clearAround(centre(HOME), 16);
  }, 90_000);

  it('!drop <item> [n] drops on request', async () => {
    const b = bot!;
    const at = (await b.truth.pos(b.name)).location;
    await loadout(b, { 0: ['iron_pickaxe'], 1: ['dirt', 64], 12: ['stone', 30] });
    const r = await command(b, '!drop stone 10', 20_000);
    const items = await until(async () => {
      const x = await b.truth.items(at, 8, 'stone');
      return x.length ? x : undefined;
    }, 10_000, 'stone item entity', 200);
    const tinv = await b.truth.inv(b.name);
    note(`!drop stone 10 -> ${r}; items ${JSON.stringify(items.map((i) => i.amount))}; stone left ${tinv.counts['minecraft:stone']}`);
    expect(r).toBe('dropped 10 stone');
    expect(items.reduce((a, i) => a + i.amount, 0)).toBe(10);
    expect(tinv.counts['minecraft:stone']).toBe(20);
    expect(await command(b, '!drop diamond')).toBe('drop: no diamond');
    await b.truth.clearAround(centre(HOME), 16);
  }, 60_000);
});
