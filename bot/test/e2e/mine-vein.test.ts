// e2e (tag @bds), wave 10 Track AQ (docs/mining.md "Veins", "Produce on the floor", "Several kinds in one
// trip"; decision 0038) on bds-dig (flat world, truth pack; DIG_BDS_HOST / DIG_BDS_PORT / DIG_BDS_CONTAINER),
// in a private area (x, z from 80 000, a random 128-block cell; one 48-block row per case):
//   vein     a 7-block diamond vein in a stone wall (face and edge neighbours); `!mine diamond_ore 7` with a
//            plain iron pickaxe: one group (vein 7/7), every drop collected (truth: 7 diamonds); time from
//            the first to the last block
//   pickup   4 oak logs spawned by the truth pack 5 blocks from the bot, no tree anywhere: the gather task
//            (`!gather 4`) picks them up before looking for a tree and ends done
//   batch    4 iron, 6 coal and 2 diamond ores scattered within 20 blocks: three single-kind jobs back to
//            back (walked distance measured), then the same layout again with
//            `!mine iron_ore 4 coal_ore 6 diamond_ore 2` (chat, from the console): nearest first across the
//            kinds, the right counts, less walking than the three jobs
// MINE_BEFORE=1 runs the measurements without the assertions (the numbers of the code before Track AQ).
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chat } from '../../src/chat/chat.ts';
import { registerFarmCommands } from '../../src/chat/commands-farm.ts';
import { silentLogger } from '../../src/log.ts';
import type { MineTask } from '../../src/skills/mine/miner.ts';
import { createMinerFor } from '../../src/skills/mine/wire.ts';
import { GatherWoodTask, logsIn } from '../../src/tasks/gatherWood.ts';
import type { Mobility } from '../../src/tasks/mobility.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { DIG_CONTAINER, DIG_TARGET } from './dig-truth.ts';
import { E2E_VERSION } from './env.ts';
import { E2E, FEET_Y, clearArea, connectFarmBot, consoleCommand, killItemsNear, pollUntil, prepareServer, truthLoaded, type FarmBot, type TruthInv } from './farm-truth.ts';

const F = FEET_Y;
const STRICT = process.env.MINE_BEFORE !== '1';
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

describe.skipIf(!E2E)('@bds mine: veins, produce on the floor, several kinds in one trip (Track AQ)', () => {
  let bot: FarmBot;
  const cell = randomInt(64);
  const X0 = 80_000 + 128 * (cell % 8) + 64;
  const Z0 = 80_000 + 128 * Math.floor(cell / 8) + 24;
  const notes: string[] = [];
  let row = 0;

  const fill = (a: Vec3, b: Vec3, block: string) => truthLoaded(bot.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block]);
  const set = (p: Vec3, block: string) => truthLoaded(bot.truth, 'set', [p.x, p.y, p.z, block]);
  const blockName = async (p: Vec3) => (await bot.block(p)).typeId.replace('minecraft:', '');
  const inv = async () => (await bot.truth.ok<TruthInv>('inv', [bot.name])).counts;
  const st = (m: MineTask) => m.stats as MineTask['stats'] & Record<string, unknown>;
  const parts = () => ({ skills: bot.skills, world: bot.world, loop: bot.loop, source: bot.conn, hotbar: bot.hotbar, containers: bot.containers, log: bot.logger });

  async function newSite(): Promise<{ x: number; z: number }> {
    const s = { x: X0, z: Z0 + 48 * row++ };
    await bot.teleport({ x: s.x + 0.5, y: F, z: s.z + 0.5 }, -90);
    await clearArea(bot.truth, s.x, s.z, 22, 10);
    await killItemsNear(s.x, s.z, 24, DIG_CONTAINER);
    return s;
  }

  /** Walked distance (3D, sampled every 100 ms) while `fn` runs. */
  async function walked<T>(fn: () => Promise<T>): Promise<{ r: T; dist: number }> {
    let last = { ...bot.loop.state.pos };
    let dist = 0;
    const t = setInterval(() => {
      const p = bot.loop.state.pos;
      const d = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
      if (d < 8) dist += d; // a teleport is no walk
      last = { ...p };
    }, 100);
    try {
      const r = await fn();
      return { r, dist };
    } finally {
      clearInterval(t);
    }
  }

  beforeAll(async () => {
    await prepareServer(DIG_CONTAINER);
    bot = await connectFarmBot('Vein', { target: DIG_TARGET, container: DIG_CONTAINER });
  }, 180_000);

  afterAll(async () => {
    process.stdout.write(`[mine-vein e2e] BDS ${E2E_VERSION}, area cell ${cell} (${X0}, ${Z0}), ${STRICT ? 'strict' : 'MINE_BEFORE (no assertions)'}\n  ${notes.join('\n  ')}\n`);
    if (bot) {
      for (let i = 0; i < row; i++) {
        await clearArea(bot.truth, X0, Z0 + 48 * i, 22, 10).catch(() => undefined);
        await killItemsNear(X0, Z0 + 48 * i, 24, DIG_CONTAINER).catch(() => undefined);
      }
      await bot.close();
    }
  }, 300_000);

  it('a 7-block diamond vein in a wall is mined as one group with every drop collected', async () => {
    const s = await newSite();
    await fill({ x: s.x + 2, y: F - 1, z: s.z - 4 }, { x: s.x + 10, y: F + 5, z: s.z + 4 }, 'stone');
    const vein: Vec3[] = [
      { x: s.x + 2, y: F + 1, z: s.z },
      { x: s.x + 2, y: F, z: s.z },
      { x: s.x + 3, y: F + 1, z: s.z },
      { x: s.x + 3, y: F + 2, z: s.z },
      { x: s.x + 3, y: F + 1, z: s.z + 1 },
      { x: s.x + 4, y: F + 2, z: s.z + 1 },
      { x: s.x + 4, y: F + 1, z: s.z - 1 },
    ];
    for (const p of vein) await set(p, 'diamond_ore');
    await bot.teleport({ x: s.x + 0.5, y: F, z: s.z + 0.5 }, -90);
    await bot.loadout([['iron_pickaxe', 1]]);
    expect(await pollUntil(() => vein.every((p) => bot.world.blockAt(p)?.name === 'diamond_ore'), 8_000)).toBeGreaterThanOrEqual(0);
    const { mine: m } = createMinerFor(parts(), { seenOnly: () => false, tunnelLen: () => 64 });
    let veinSeen = '';
    const watch = setInterval(() => {
      const v = (m as unknown as { vein?: { done: number; size: number } }).vein;
      if (v) veinSeen = `vein ${v.done}/${v.size}`;
    }, 50);
    const t0 = performance.now();
    const end = await m.start({ block: 'diamond_ore', count: 7 });
    clearInterval(watch);
    const s1 = (performance.now() - t0) / 1000;
    const c = await inv();
    const ms = st(m).minedMs;
    notes.push(
      `vein: ${end} after ${s1.toFixed(1)} s; first block at ${((ms[0] ?? 0) / 1000).toFixed(1)} s, last at ${((ms[ms.length - 1] ?? 0) / 1000).toFixed(1)} s ` +
        `(first to last ${(((ms[ms.length - 1] ?? 0) - (ms[0] ?? 0)) / 1000).toFixed(1)} s); mined ${st(m).mined}, order ${st(m).minedAt.map(key).join(' ')}; veins ${JSON.stringify(st(m).veins ?? 'n/a')}; ` +
        `last status seen '${veinSeen}'; diamonds (truth) ${c['minecraft:diamond'] ?? 0}; collected ${JSON.stringify(st(m).collected)}; pickup walks ${st(m).pickupWalks}; tunnelled ${st(m).tunnelled}`,
    );
    if (!STRICT) return;
    expect(end).toBe('done');
    expect(st(m).mined).toBe(7);
    for (const p of vein) expect(await blockName(p), key(p)).not.toBe('diamond_ore');
    expect(c['minecraft:diamond'] ?? 0).toBe(7);
    expect((st(m).veins as { size: number }[] | undefined)?.[0]?.size).toBe(7);
  }, 300_000);

  it('logs lying 5 blocks away are picked up when the gather job starts', async () => {
    const s = await newSite();
    await bot.teleport({ x: s.x + 0.5, y: F, z: s.z + 0.5 }, -90);
    await bot.loadout([['iron_pickaxe', 1]]);
    await truthLoaded(bot.truth, 'spawnitem', [s.x + 5.5, F + 0.2, s.z + 0.5, 'oak_log', 4]);
    await bot.loop.waitTicks(30);
    const g = new GatherWoodTask({
      skills: bot.skills,
      inventory: bot.world.inventory,
      position: () => (bot.loop.state.ready ? bot.loop.state.pos : undefined),
      ready: () => bot.loop.state.ready,
      waitTicks: (n) => bot.loop.waitTicks(n),
      corrections: () => bot.loop.state.corrections,
      entities: () => bot.world.entities,
      log: bot.logger,
    });
    const t0 = performance.now();
    const end = await g.start({ target: 4, noTreeRounds: 2, searchRadius: 16 });
    const s1 = (performance.now() - t0) / 1000;
    const c = await inv();
    notes.push(`pickup: gather 4 ended ${end} after ${s1.toFixed(1)} s (${g.lastError ?? '-'}); logs carried ${logsIn(bot.world.inventory.slots)}, truth oak_log ${c['minecraft:oak_log'] ?? 0}`);
    if (!STRICT) return;
    expect(end).toBe('done');
    expect(c['minecraft:oak_log'] ?? 0).toBe(4);
    expect(s1).toBeLessThan(20);
  }, 180_000);

  it('several kinds in one trip: nearest first across kinds, less walking than three jobs', async () => {
    const s = await newSite();
    // ores standing on the floor (feet level), scattered within 20 blocks of the start
    const layout: [string, number, number][] = [
      ['iron_ore', 4, 2],
      ['coal_ore', -6, 5],
      ['diamond_ore', 10, -4],
      ['coal_ore', 7, 9],
      ['iron_ore', -12, -6],
      ['coal_ore', 15, 3],
      ['iron_ore', 2, -14],
      ['coal_ore', -3, 12],
      ['diamond_ore', -16, 4],
      ['coal_ore', 13, -11],
      ['iron_ore', -9, 15],
      ['coal_ore', 18, 12],
    ];
    const ores = layout.map(([n, dx, dz]) => ({ name: n, p: { x: s.x + dx, y: F, z: s.z + dz } }));
    const build = async () => {
      for (const o of ores) await set(o.p, o.name);
      await pollUntil(() => ores.every((o) => bot.world.blockAt(o.p)?.name === o.name), 8_000);
    };
    await build();
    await bot.loadout([['iron_pickaxe', 1]]);
    // three single-kind jobs back to back
    const sep: string[] = [];
    let sepDist = 0;
    let sepS = 0;
    for (const [block, n] of [
      ['iron_ore', 4],
      ['coal_ore', 6],
      ['diamond_ore', 2],
    ] as const) {
      const { mine: m } = createMinerFor(parts(), { seenOnly: () => false, tunnelLen: () => 64 });
      const t0 = performance.now();
      const { r, dist } = await walked(() => m.start({ block, count: n }));
      sepDist += dist;
      sepS += (performance.now() - t0) / 1000;
      sep.push(`${block} ${n}: ${r}, ${st(m).mined} mined, ${dist.toFixed(1)} blocks walked`);
    }
    notes.push(`batch, three jobs: ${sep.join('; ')}; in all ${sepDist.toFixed(1)} blocks walked in ${sepS.toFixed(1)} s`);
    // the same layout again, one job through the chat command
    await killItemsNear(s.x, s.z, 24, DIG_CONTAINER);
    await bot.teleport({ x: s.x + 0.5, y: F, z: s.z + 0.5 }, -90);
    await build();
    await bot.loadout([['iron_pickaxe', 1]]);
    const chat = new Chat(bot.conn, { log: silentLogger });
    const mob: Mobility = { world: bot.world, loop: bot.loop, skills: bot.skills, position: () => (bot.loop.state.ready ? bot.loop.state.pos : undefined), dispose: () => undefined };
    const reg = registerFarmCommands({ chat, conn: bot.conn, mob, mineTunnelLen: () => 64, oreScanTicks: 0 });
    chat.start();
    const lines: string[] = [];
    chat.onLine((l) => lines.push(l.message));
    const said: string[] = [];
    bot.conn.on('text', (p) => {
      if ((p.source_name ?? '').startsWith(bot.name)) said.push(p.message);
    });
    const m = reg.mine!;
    const t0 = performance.now();
    const { dist } = await walked(async () => {
      await consoleCommand(DIG_CONTAINER, 'say', '!mine iron_ore 4 coal_ore 6 diamond_ore 2');
      await pollUntil(() => m.running, 15_000);
      await pollUntil(() => !m.running, 300_000);
    });
    const s1 = (performance.now() - t0) / 1000;
    const order = st(m).minedAt.map((p) => ores.find((o) => key(o.p) === key(p))?.name.replace('_ore', '') ?? `? ${key(p)}`);
    const c = await inv();
    notes.push(
      `batch, one job: ${m.state} after ${s1.toFixed(1)} s, ${dist.toFixed(1)} blocks walked (three jobs ${sepDist.toFixed(1)}); order ${order.join(' ')}; ` +
        `status '${(m as unknown as { quotaLine?: () => string }).quotaLine?.() ?? m.summary()}'; replies ${JSON.stringify(said.filter((x) => x.startsWith('min')))}; inventory ${JSON.stringify(c)}; collected ${JSON.stringify(st(m).collected)}, pickup walks ${st(m).pickupWalks}`,
    );
    if (!STRICT) return;
    expect(m.state).toBe('done');
    expect(order.filter((x) => x === 'iron').length).toBe(4);
    expect(order.filter((x) => x === 'coal').length).toBe(6);
    expect(order.filter((x) => x === 'diamond').length).toBe(2);
    expect(c['minecraft:raw_iron'] ?? 0).toBeGreaterThanOrEqual(4);
    expect(c['minecraft:coal'] ?? 0).toBeGreaterThanOrEqual(6);
    expect(c['minecraft:diamond'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(dist).toBeLessThan(sepDist);
  }, 900_000);
});
