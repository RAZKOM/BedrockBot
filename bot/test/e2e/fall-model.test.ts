// e2e (tag @bds), Track BH: the fall damage model and the waterloggable table against bds-gaunt
// (fall-truth.ts; the first measurements, 2026-10-30, are in docs/movement.md "Falls"):
//   heights      walking off stone pillars of 4 .. 20 blocks: truth:hurtlog's fall damage = damage.ts
//   landings     teleported over hay (22), honey (12, 22), water (22): the landing factors
//   enchantments Feather Falling IV boots (12: 4.16) and four Protection IV pieces + FF IV (22: 3.8, the cap),
//                enchanted with /enchant, worn with the bot's own armour code, read back from the item NBT
//   waterlog     a water bucket used on the top face of each block: the water goes into the block (layer 1)
//                exactly for the blocks waterlog.ts calls waterloggable, above it for the others; the empty
//                bucket clicked on the water's cell takes it back
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickBlockTransaction } from '../../src/skills/container/chest.ts';
import { countedFall, epfFactor, fallDamage, fallEpf } from '../../src/skills/fall/damage.ts';
import { isWaterloggable } from '../../src/skills/fall/waterlog.ts';
import { wireItemOf } from '../../src/skills/place/place.ts';
import { ArmourController } from '../../src/skills/survival/armour.ts';
import { StackRequests } from '../../src/skills/survival/screen.ts';
import { Containers } from '../../src/world/containers.ts';
import { Hotbar } from '../../src/world/hotbar.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { disconnectBot, sleep } from './move-truth.ts';
import { consoleCommand } from './skills-truth.ts';
import { E2E, FALL_CONTAINER, connectFallBot, fallArea, fallHurts, fillAt, kit, report, setHealth, tpBot, type FallBot } from './fall-truth.ts';

describe.skipIf(!E2E)('@bds fall damage model and waterloggable blocks (bds-gaunt)', () => {
  let bot: FallBot;
  let hotbar: Hotbar;
  const o = fallArea();
  const summary: string[] = [];

  beforeAll(async () => {
    bot = await connectFallBot('FallModel', { x: o.x + 8, y: -60, z: o.z + 8 });
    hotbar = new Hotbar(bot.conn, { inventory: bot.world.inventory, runtimeId: () => bot.world.self.runtimeId });
    bot.skills.falls.settings = () => ({ longFalls: true, fallMargin: 8, clutch: false, clutchMaxDrop: 40 }); // no clutch while measuring
    await fillAt(bot, { x: o.x - 4, y: -60, z: o.z - 4 }, { x: o.x + 40, y: -38, z: o.z + 40 }, 'air');
    await fillAt(bot, { x: o.x - 4, y: -61, z: o.z - 4 }, { x: o.x + 40, y: -61, z: o.z + 40 }, 'grass_block');
  }, 180_000);

  afterAll(async () => {
    report(`fall-model e2e, area ${o.x},${o.z}`, summary);
    await disconnectBot(bot);
  });

  /** Walk east off a 1 x 1 stone pillar `h` high at (x, z); the server's fall damage. */
  async function walkOff(x: number, z: number, h: number): Promise<number> {
    await fillAt(bot, { x, y: -60, z }, { x, y: -61 + h, z }, 'stone');
    await tpBot(bot, { x: x + 0.5, y: -60 + h, z: z + 0.5 }, -90);
    await setHealth(bot, 20);
    const since = await bot.pve.now();
    bot.loop.setCommand({ yaw: -90, forward: 1 });
    for (let t = 0; t < 30 && bot.loop.state.onGround; t++) await bot.loop.waitTicks(1);
    bot.loop.setCommand({ forward: 0 });
    for (let t = 0; t < 120 && !bot.loop.state.onGround; t++) await bot.loop.waitTicks(1);
    await bot.loop.waitTicks(10);
    await sleep(100);
    return (await fallHurts(bot, since)).total;
  }

  /** Teleport `h` above the top of the block at (x, -61, z) and fall onto it. */
  async function dropOnto(x: number, z: number, top: number, h: number): Promise<number> {
    await tpBot(bot, { x: x + 0.5, y: top + h, z: z + 0.5 }, 0, 1);
    await setHealth(bot, 20);
    const since = await bot.pve.now();
    for (let t = 0; t < 120 && !(bot.loop.state.onGround || bot.loop.state.inWater); t++) await bot.loop.waitTicks(1);
    await bot.loop.waitTicks(15);
    await sleep(100);
    return (await fallHurts(bot, since)).total;
  }

  it('walking off stone pillars: the damage is the model one (ceil of the counted fall - 3)', async () => {
    await kit(bot, [['bread', 1]]);
    const heights = [4, 5, 8, 12, 13, 20];
    for (const [i, h] of heights.entries()) {
      const d = await walkOff(o.x + 3 * i, o.z, h);
      summary.push(`walk off ${h}: damage ${d}, model ${fallDamage(h)} (counted ${countedFall(h).toFixed(3)})`);
      expect(d, `height ${h}`).toBe(fallDamage(h));
    }
  }, 240_000);

  it('soft landings: hay x 0.2, honey x 0.5, water 0', async () => {
    const cases: { block: string; h: number; water?: boolean }[] = [
      { block: 'hay_block', h: 22 },
      { block: 'honey_block', h: 12 },
      { block: 'honey_block', h: 22 },
      { block: 'water', h: 22, water: true },
    ];
    for (const [i, c] of cases.entries()) {
      const x = o.x + 3 * i;
      const z = o.z + 6;
      await bot.truth.ok('setblock', [x, -61, z, c.block]);
      await bot.loop.waitTicks(5);
      const d = await dropOnto(x, z, c.water ? -61.1 : -60, c.h);
      const model = fallDamage(c.h, c.block);
      summary.push(`${c.block} from ${c.h}: damage ${d}, model ${model}`);
      expect(d, `${c.block} ${c.h}`).toBe(model);
    }
  }, 240_000);

  it('enchanted armour: Feather Falling IV, and Protection IV x 4 + FF IV (the cap)', async () => {
    const containers = new Containers(bot.conn, bot.world.inventory);
    const requests = new StackRequests({ source: bot.conn, containers, loop: bot.loop, runtimeId: () => bot.world.self.runtimeId });
    const armour = new ArmourController({ inventory: bot.world.inventory, requests });
    const sets: { label: string; h: number; pieces: [string, [string, number][]][] }[] = [
      { label: 'FF IV boots', h: 12, pieces: [['diamond_boots', [['feather_falling', 4]]]] },
      {
        label: 'P IV x 4 + FF IV',
        h: 22,
        pieces: [
          ['diamond_boots', [['feather_falling', 4], ['protection', 4]]],
          ['diamond_helmet', [['protection', 4]]],
          ['diamond_chestplate', [['protection', 4]]],
          ['diamond_leggings', [['protection', 4]]],
        ],
      },
    ];
    for (const [i, set] of sets.entries()) {
      await bot.truth.ok('clear', [bot.name]);
      await bot.loop.waitTicks(10);
      for (const [piece, enchants] of set.pieces) {
        hotbar.select(0);
        await bot.truth.ok('give', [bot.name, piece, 1]);
        await bot.loop.waitTicks(10);
        for (const [e, l] of enchants) await consoleCommand(FALL_CONTAINER, 'enchant', bot.name, e, String(l));
        await bot.loop.waitTicks(10);
        const r = await armour.equip();
        expect(r.ok, `${set.label}: ${piece} ${JSON.stringify(r)}`).toBe(true);
        await bot.loop.waitTicks(10);
      }
      const worn = bot.world.inventory.window(120)?.slots ?? [];
      const factor = epfFactor(fallEpf(worn));
      const d = await walkOff(o.x + 3 * i, o.z + 12, set.h);
      const model = fallDamage(set.h, 'stone', factor);
      summary.push(`${set.label} from ${set.h}: damage ${d.toFixed(2)}, model ${model.toFixed(2)} (EPF ${fallEpf(worn)}, worn ${worn.map((s) => `${s?.name ?? '-'}${s?.enchants ? JSON.stringify(s.enchants) : ''}`).join(' ')})`);
      expect(d).toBeCloseTo(model, 2);
    }
    await bot.truth.ok('clear', [bot.name]);
  }, 240_000);

  it("waterlog: water inside exactly the blocks the table calls waterloggable, above the others; the bucket takes it back", async () => {
    const blocks: [string, string[]][] = [
      ['stone', []],
      ['glass', []],
      ['oak_slab', ['minecraft:vertical_half=bottom']],
      ['oak_slab', ['minecraft:vertical_half=top']],
      ['oak_stairs', ['upside_down_bit=true']],
      ['oak_fence', []],
      ['cobblestone_wall', []],
      ['glass_pane', []],
      ['oak_leaves', []],
      ['copper_grate', []],
      ['lantern', []],
    ];
    for (const [i, [name, states]] of blocks.entries()) {
      const x = o.x + 4 * (i % 8);
      const z = o.z + 20 + 4 * Math.floor(i / 8);
      await bot.truth.ok('setblock', [x, -60, z, name, ...states]);
      await tpBot(bot, { x: x + 0.5, y: -60, z: z - 1.5 }, 0, 10);
      await kit(bot, [['water_bucket', 1]]);
      hotbar.select(0);
      await bot.loop.waitTicks(3);
      const inv = bot.world.inventory;
      const click = (p: Vec3) => {
        const eye = { x: bot.loop.state.pos.x, y: bot.loop.state.pos.y + 1.62, z: bot.loop.state.pos.z };
        bot.conn.queue('inventory_transaction', clickBlockTransaction({ pos: p, face: 1, hotbarSlot: 0, held: wireItemOf(inv.slots[0], hotbar.rawItem(0)), eye, blockRuntimeId: bot.world.chunks.runtimeIdAt(p.x, p.y, p.z) ?? 0 }));
      };
      click({ x, y: -60, z });
      await bot.loop.waitTicks(10);
      const layer1 = bot.world.registry.nameOf(bot.world.chunks.stateIdAt(x, -60, z, 1) ?? -1);
      const above = bot.world.blockAt({ x, y: -59, z })?.name;
      const inside = layer1 === 'water';
      const water: Vec3 = inside ? { x, y: -60, z } : { x, y: -59, z };
      const placed = inside || above === 'water';
      click(water);
      await bot.loop.waitTicks(10);
      const after = inside ? bot.world.registry.nameOf(bot.world.chunks.stateIdAt(x, -60, z, 1) ?? -1) : bot.world.blockAt(water)?.name;
      summary.push(`${name} ${states.join(' ')}: water ${inside ? 'inside (layer 1)' : above === 'water' ? 'above' : 'none'}, table ${isWaterloggable(name) ? 'waterloggable' : 'not'}; pickup -> ${after}, slot ${inv.slots[0]?.name}`);
      expect(placed, name).toBe(true);
      expect(inside, name).toBe(isWaterloggable(name));
      expect(after, name).not.toBe('water');
      expect(inv.slots[0]?.name).toBe('water_bucket');
      await fillAt(bot, { x: x - 2, y: -60, z: z - 2 }, { x: x + 2, y: -58, z: z + 2 }, 'air');
    }
  }, 300_000);
});
