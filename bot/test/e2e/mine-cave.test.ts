// e2e (tag @bds) for PLAN.md task 7.14 (legit mining) on bds-farm (BDS_E2E=1; docker/compose.farm.yml,
// truth pack deployed with `node scripts/bds.mjs --profile farm pack`):
//   a stone block (21 x 7 x 13) with a 3 x 3 corridor (the cave) sealed by a 2-block wall at its west
//   end; in the corridor walls 9 exposed coal ores, one of them with lava right behind it; 4 coal ores
//   buried two blocks deep (stone between them and the corridor). The bot starts outside.
//   mine     `coal_ore` x 9: the 8 safe exposed ores are mined (the bot tunnels through the seal),
//            the lava-adjacent one is skipped (break safety rule), the buried 4 are never targeted
//            and still there (truth), 8 coal in the inventory; then 'none_left'
//   stop     `!mine coal_ore 4` / `!mine stop` from the server console through the real chat
//            commands: the bot stops within 20 ticks of the stop line, mid-dig, and the ore stays
// Prints dig ticks per ore, tunnel digs, scan times.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chat } from '../../src/chat/chat.ts';
import { registerFarmCommands } from '../../src/chat/commands-farm.ts';
import { silentLogger } from '../../src/log.ts';
import { createMiner } from '../../src/skills/farm/index.ts';
import type { MineTask } from '../../src/skills/mine/miner.ts';
import type { Mobility } from '../../src/tasks/mobility.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E_VERSION } from './env.ts';
import {
  E2E,
  FEET_Y,
  FarmArea,
  FARM_CONTAINER,
  clearArea,
  connectFarmBot,
  consoleCommand,
  killItemsNear,
  pollUntil,
  prepareServer,
  stats,
  truthLoaded,
  type FarmBot,
  type TruthInv,
} from './farm-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds mine: legit mining in a cave (7.14)', () => {
  let bot: FarmBot;
  const area = new FarmArea();
  const mx = area.x0;
  const mz = area.z0;
  const notes: string[] = [];
  let mine: MineTask;
  // exposed ores in the corridor walls (z = mz - 2 north wall, mz + 2 south wall)
  const exposed: Vec3[] = [
    { x: mx - 6, y: F, z: mz - 2 },
    { x: mx - 3, y: F + 1, z: mz - 2 },
    { x: mx, y: F + 2, z: mz - 2 },
    { x: mx + 4, y: F + 1, z: mz - 2 },
    { x: mx - 5, y: F + 1, z: mz + 2 },
    { x: mx - 1, y: F, z: mz + 2 },
    { x: mx + 2, y: F + 2, z: mz + 2 },
    { x: mx + 6, y: F, z: mz + 2 },
  ];
  const lavaOre: Vec3 = { x: mx + 1, y: F, z: mz - 2 };
  const lava: Vec3 = { x: mx + 1, y: F, z: mz - 3 };
  // buried: stone at z = mz -/+ 2 and -/+ 3 between them and the corridor air
  const buried: Vec3[] = [
    { x: mx - 2, y: F + 1, z: mz - 4 },
    { x: mx + 3, y: F, z: mz + 4 },
    { x: mx + 7, y: F + 2, z: mz - 4 },
    { x: mx - 7, y: F + 1, z: mz + 4 },
  ];
  const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

  const fill = (a: Vec3, b: Vec3, block: string) => truthLoaded(bot.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block]);
  const blockName = async (p: Vec3) => (await bot.block(p)).typeId.replace('minecraft:', '');

  async function buildCave(): Promise<void> {
    await clearArea(bot.truth, mx, mz, 18, 9);
    await killItemsNear(mx, mz, 20);
    await fill({ x: mx - 10, y: F - 1, z: mz - 6 }, { x: mx + 10, y: F + 5, z: mz + 6 }, 'stone');
    await fill({ x: mx - 8, y: F, z: mz - 1 }, { x: mx + 8, y: F + 2, z: mz + 1 }, 'air');
    for (const p of [...exposed, lavaOre, ...buried]) await truthLoaded(bot.truth, 'set', [p.x, p.y, p.z, 'coal_ore']);
    await truthLoaded(bot.truth, 'set', [lava.x, lava.y, lava.z, 'lava']);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await connectFarmBot('Mine');
    await bot.teleport({ x: mx - 13.5, y: F, z: mz + 0.5 }, -90);
    await buildCave();
    await bot.loadout([['stone_pickaxe', 1]]);
    expect(await pollUntil(() => bot.world.blockAt(buried[3]!)?.name === 'coal_ore' && bot.world.blockAt(lava)?.name === 'lava', 5_000)).toBeGreaterThanOrEqual(0);
    ({ mine } = createMiner({ skills: bot.skills, world: bot.world, loop: bot.loop, source: bot.conn, hotbar: bot.hotbar, containers: bot.containers, log: bot.logger }));
  }, 180_000);

  afterAll(async () => {
    mine?.stop();
    process.stdout.write(`[mine-cave e2e] BDS ${E2E_VERSION}, area cell ${area.cell} (${mx}, ${mz})\n  ${notes.join('\n  ')}\n`);
    if (bot) {
      await clearArea(bot.truth, mx, mz, 18, 9).catch(() => undefined);
      await killItemsNear(mx, mz, 20).catch(() => undefined);
      await bot.close();
    }
  });

  it('mines the 8 exposed coal ores, skips the lava-adjacent one, never targets the buried 4', async () => {
    const t0 = performance.now();
    const c0 = bot.loop.state.corrections;
    const end = await mine.start({ block: 'coal_ore', count: 9 });
    const s = (performance.now() - t0) / 1000;
    const st = mine.stats;
    const i = await bot.truth.ok<TruthInv>('inv', [bot.name]);
    notes.push(
      `mine: ${end} after ${s.toFixed(1)} s: ${st.mined} mined, targeted ${st.targeted.length}, ${st.failures} failures, ${st.tunnelled} blocks tunnelled (${st.sightDigs} sight digs), ${st.pickupWalks} pickup walk(s), ` +
        `unsafe ${JSON.stringify(st.unsafe)}, ${bot.loop.state.corrections - c0} corrections; dig ticks (stone_pickaxe) ${stats(st.digTicks)}; ` +
        `${st.scans} scans, ${(st.scanMs / Math.max(1, st.scans)).toFixed(2)} ms each, buried seen by the scans (not recorded) ${st.buriedSeen}; collected ${JSON.stringify(st.collected)}; inventory ${JSON.stringify(i.counts)}`,
    );
    expect(end).toBe('none_left');
    expect(st.mined).toBe(8);
    expect(new Set(st.minedAt.map(key))).toEqual(new Set(exposed.map(key)));
    // never targeted: buried ores and the lava one
    const targeted = new Set(st.targeted.map(key));
    for (const b of buried) expect(targeted.has(key(b)), `buried ${key(b)} targeted`).toBe(false);
    expect(targeted.has(key(lavaOre))).toBe(false);
    expect(st.unsafe.map((u) => key(u.p))).toContain(key(lavaOre));
    expect(st.unsafe.find((u) => key(u.p) === key(lavaOre))?.why).toBe('next_to_liquid');
    expect(st.buriedSeen).toBeGreaterThanOrEqual(4);
    // truth: the 8 are gone, the buried 4 and the lava one are still there, lava untouched
    for (const p of exposed) expect(await blockName(p), key(p)).not.toBe('coal_ore');
    for (const p of [...buried, lavaOre]) expect(await blockName(p), key(p)).toBe('coal_ore');
    expect(await blockName(lava)).toBe('lava');
    expect(i.counts['minecraft:coal'] ?? 0).toBe(8);
    expect(st.tunnelled).toBeGreaterThanOrEqual(2); // through the sealed entrance
  }, 600_000);

  it('!mine from chat starts, !mine stop stops within 20 ticks mid-dig', async () => {
    // four new exposed ores along the corridor (far from the bot, so it walks and digs)
    const fresh: Vec3[] = [
      { x: mx + 7, y: F + 1, z: mz - 2 },
      { x: mx + 7, y: F + 1, z: mz + 2 },
      { x: mx - 7, y: F + 2, z: mz - 2 },
      { x: mx - 7, y: F + 2, z: mz + 2 },
    ];
    for (const p of fresh) await truthLoaded(bot.truth, 'set', [p.x, p.y, p.z, 'coal_ore']);
    expect(await pollUntil(() => fresh.every((p) => bot.world.blockAt(p)?.name === 'coal_ore'), 5_000)).toBeGreaterThanOrEqual(0);
    const chat = new Chat(bot.conn, { log: silentLogger });
    const mob: Mobility = { world: bot.world, loop: bot.loop, skills: bot.skills, position: () => (bot.loop.state.ready ? bot.loop.state.pos : undefined), dispose: () => undefined };
    const reg = registerFarmCommands({ chat, conn: bot.conn, mob });
    chat.start();
    const cmdMine = reg.mine!;
    const lines: { text: string; tick: bigint }[] = [];
    chat.onLine((l) => lines.push({ text: l.message, tick: bot.conn.tick }));
    await consoleCommand(FARM_CONTAINER, 'say', '!mine coal_ore 4');
    expect(await pollUntil(() => cmdMine.state === 'dig' && cmdMine.stats.targeted.length > 0, 60_000), `mine state ${cmdMine.state}`).toBeGreaterThanOrEqual(0);
    // let the dig run a few ticks, then stop from chat
    await bot.loop.waitTicks(4);
    const digging = cmdMine.stats.targeted.at(-1)!;
    const sentAt = bot.conn.tick;
    await consoleCommand(FARM_CONTAINER, 'say', '!mine stop');
    expect(await pollUntil(() => lines.some((l) => l.text.includes('!mine stop')), 10_000)).toBeGreaterThanOrEqual(0);
    const heardAt = lines.find((l) => l.text.includes('!mine stop'))!.tick;
    let stoppedAt: bigint | undefined;
    for (let k = 0; k < 40; k++) {
      if (cmdMine.state === 'stopped' && !bot.skills.status().busy && !bot.skills.digger?.busy) {
        stoppedAt = bot.conn.tick;
        break;
      }
      await bot.loop.waitTicks(1);
    }
    await bot.loop.waitTicks(40);
    const still = await blockName(digging);
    notes.push(
      `stop: '!mine stop' heard ${Number(heardAt - sentAt)} ticks after the console command, stopped ${stoppedAt === undefined ? 'never' : Number(stoppedAt - heardAt)} ticks after hearing it; ` +
        `state ${cmdMine.state}, ${cmdMine.stats.mined} mined before; ore being dug ${key(digging)} is ${still} 40 ticks later; replies: ${JSON.stringify(lines.filter((l) => l.text.startsWith('mine') || l.text.startsWith('mining') || l.text.startsWith('stopped')).map((l) => l.text))}`,
    );
    expect(stoppedAt).toBeDefined();
    expect(Number(stoppedAt! - heardAt)).toBeLessThanOrEqual(20);
    expect(cmdMine.state).toBe('stopped');
    expect(still).toBe('coal_ore');
  }, 300_000);
});
