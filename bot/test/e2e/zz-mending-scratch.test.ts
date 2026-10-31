// SCRATCH (not to be committed): what BDS sends when XP orbs mend the held item.
import { describe, it } from 'vitest';
import { centre, clearArea, coreCmd, E2E, FEET_Y, prepareServer, privateArea, sleep, startCoreBot, teleport } from './core-truth.ts';

const rep = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

describe.skipIf(!E2E)('scratch: mending', () => {
  it('what the server sends when mending repairs', async () => {
    await prepareServer({ time: 'noon' });
    const area = privateArea();
    const HOME = { x: area.x, y: FEET_Y, z: area.z };
    const bot = await startCoreBot('Mend');
    const log: string[] = [];
    const t0 = Date.now();
    for (const n of ['inventory_slot', 'inventory_content', 'inventory_transaction', 'mob_armor_equipment', 'mob_equipment', 'player_armor_damage', 'update_attributes', 'take_item_entity', 'level_sound_event', 'item_stack_response']) {
      bot.conn.on(n, (p: unknown) => {
        const s = JSON.stringify(p, rep);
        if (n === 'level_sound_event' && !/orb|experience/i.test(s)) return;
        log.push(`${String(Date.now() - t0).padStart(6)} ${n} ${s.slice(0, 700)}`);
      });
    }
    await bot.truth.tp(bot.name, centre(HOME), 0, 0);
    await clearArea(bot.truth, HOME, 12, 4);
    await teleport(bot, centre(HOME));
    await bot.truth.ok('clear', [bot.name]);
    const inv = bot.built.mobility!.world.inventory;
    const show = (what: string): void => {
      const held = inv.held;
      console.log(`${what}: held=${held?.name} damage=${held?.damage} sel=${inv.selected}`);
    };
    await coreCmd('replaceitem', 'entity', bot.name, 'slot.weapon.mainhand', '0', 'diamond_pickaxe', '1', '1000');
    await sleep(1500);
    show('after replaceitem (data 1000)');
    await coreCmd('enchant', bot.name, 'mending');
    await sleep(1500);
    show('after enchant');
    const pos = bot.task.position()!;
    for (let i = 0; i < 40; i++) await coreCmd('summon', 'xp_orb', String(pos.x), String(pos.y), String(pos.z));
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      show(`t+${i + 1}s`);
    }
    console.log(`PACKETS (${log.length}):\n${log.join('\n')}`);
    await bot.stop();
  }, 120_000);
});
