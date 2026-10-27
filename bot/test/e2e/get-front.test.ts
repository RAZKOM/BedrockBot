// e2e (tag @bds), wave 8 Track AD (docs/get.md): `!get` as the one front door, on bds-get (flat,
// peaceful, truth pack). One afk-task bot (walking, the CLI's wiring) in its own random area:
//   wood     an oak stand of 4 persistent trees (truth:tree), `!get 20 oak_log`: the reply names the
//            gather process, the gather ends `gather done: N/20 logs`, truth:inv counts >= 20 logs
//   coal     4 coal ore buried 3 blocks under the floor 2 blocks from the bot (dirt above, no face
//            open), `!get coal 4`: `getting 4 coal: mining coal_ore`, the mine process digs down to
//            them (mineSeenOnly off, the default) and ends `mine coal_ore: 4/4 done`, truth: 4 coal
//   unknown  `!get bread`: `get: I do not know how to get bread; I can get: ...`, no process started
// Env: GET_BDS_HOST / GET_BDS_PORT / GET_BDS_CONTAINER (get-truth.ts), GET_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { categories } from '../../src/skills/items/catalog.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startGetBot, teleport, truthLoaded, until, type GetBot } from './get-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds get: one front door (Track AD)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: GetBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startGetBot('Get');
    await teleport(bot, home);
    await clearArea(bot.truth, area, 24, 12);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await clearArea(bot.truth, area, 24, 12).catch(() => undefined);
      await bot.truth.clearAround(home, 40).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[get-front e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('!get 20 oak_log fells an oak stand through the gather process', async () => {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_axe', 1]);
    const bases = [
      { x: area.x + 6, z: area.z - 4 },
      { x: area.x + 6, z: area.z + 4 },
      { x: area.x + 10, z: area.z },
      { x: area.x + 11, z: area.z + 7 },
    ];
    let logs = 0;
    for (const t of bases) {
      const r = await truthLoaded<{ logs: number[][] }>(b.truth, 'tree', [t.x, F, t.z, 6, 'oak', 1]);
      logs += r.logs.length;
    }
    await sleep(1000);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get 20 oak_log');
    const first = await b.reply((s) => s.startsWith('getting '), from);
    expect(first).toBe('getting 20 oak_log: gathering wood');
    const end = await b.reply((s) => s.startsWith('gather '), from, 240_000);
    const ms = Date.now() - t0;
    const counts = await b.truth.counts(b.name);
    notes.push(`wood: ${logs} logs planted in 4 trees; replies: ${b.said.slice(from).join(' | ')}; ${(ms / 1000).toFixed(1)} s; inventory ${JSON.stringify(counts)}`);
    expect(end).toMatch(/^gather done: (2\d)\/20 logs/);
    expect(counts.oak_log ?? 0).toBeGreaterThanOrEqual(20);
  }, 300_000);

  it('!get coal 4 mines 4 coal ore buried 3 blocks under the floor', async () => {
    const b = bot!;
    await teleport(b, home);
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'stone_pickaxe', 1]);
    await b.truth.clearAround(home, 30);
    const ores: Vec3[] = [
      { x: area.x + 2, y: F - 3, z: area.z },
      { x: area.x + 3, y: F - 3, z: area.z },
      { x: area.x + 2, y: F - 3, z: area.z + 1 },
      { x: area.x + 3, y: F - 3, z: area.z + 1 },
    ];
    await truthLoaded(b.truth, 'fill', [area.x - 6, F - 3, area.z - 6, area.x + 8, F - 2, area.z + 6, 'stone']);
    for (const p of ores) await truthLoaded(b.truth, 'set', [p.x, p.y, p.z, 'coal_ore']);
    await sleep(1000);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get coal 4');
    const first = await b.reply((s) => s.startsWith('getting '), from);
    expect(first).toBe('getting 4 coal: mining coal_ore');
    const end = await b.reply((s) => s.startsWith('mine '), from, 240_000);
    const ms = Date.now() - t0;
    const counts = await until(async () => {
      const c = await b.truth.counts(b.name);
      return (c.coal ?? 0) >= 4 || Date.now() - t0 > ms + 15_000 ? c : undefined;
    }, 30_000, 'coal in the inventory', 500);
    const left = await Promise.all(ores.map(async (p) => String((await truthLoaded<{ typeId: string }>(b.truth, 'block', [p.x, p.y, p.z])).typeId).replace('minecraft:', '')));
    notes.push(`coal: replies ${b.said.slice(from).join(' | ')}; ${(ms / 1000).toFixed(1)} s; inventory ${JSON.stringify(counts)}; ores now ${left.join(',')}`);
    expect(end).toBe('mine coal_ore: 4/4 done');
    expect(counts.coal ?? 0).toBe(4);
    expect(left.every((n) => n !== 'coal_ore')).toBe(true);
  }, 300_000);

  it('!get bread answers with the catalog and starts nothing', async () => {
    const b = bot!;
    const from = b.said.length;
    await b.command('!get bread');
    const r = await b.reply((s) => s.startsWith('get: '), from);
    notes.push(`unknown: ${r}`);
    expect(r).toBe(`get: I do not know how to get bread; I can get: ${categories()}`); // 248 characters: fits a 256-character chat reply
    await sleep(500);
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 60_000);
});
