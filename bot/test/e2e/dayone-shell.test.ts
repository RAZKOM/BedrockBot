// e2e (tag @bds), Track E1 (docs/early-game.md "The first night", ADR 0098): the night shell on a flat, peaceful
// server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another one).
// One afk-task bot with 16 cobblestone, the shelter at its feet under the open sky and home 6 blocks away.
//   on   nightShell on, the clock to 13000: inside the shelter it walls itself in (the 8 cells round the feet and the
//        head, the roof and its support: 10 blocks, truth); the clock to 23100: one side is dug open and the bot
//        walks home
//   off  nightShell off (the default): the clock to 13000, nothing is placed
//   dawn walled in, a zombie in a stone box 8 east (difficulty easy for the case), the clock to 23100: the shell stays
//        shut while the zombie lives, opens once it is killed
//   litter leaf litter in every cell round the feet: the 4 litter cells are dug, then the shell closes (9 cells)
//   canopy / roof  leaves 3 over the head: walled in (9 blocks); planks: nothing placed, the roof named in the log
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { clearArea, craftCmd, E2E, FEET_Y, hdist, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds dayone shell: walled in at an open shelter by night, out at dawn (Track E1)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const home = { x: area.x + 6, y: F, z: area.z };
  const ring = (dy: number): Vec3[] => [
    { x: area.x + 1, y: F + dy, z: area.z },
    { x: area.x - 1, y: F + dy, z: area.z },
    { x: area.x, y: F + dy, z: area.z + 1 },
    { x: area.x, y: F + dy, z: area.z - 1 },
  ];
  const solidCount = async (b: CraftBot, cells: Vec3[]): Promise<number> => {
    let n = 0;
    for (const p of cells) if ((await b.truth.block(p)).typeId !== 'minecraft:air') n++;
    return n;
  };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('DayShell');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await craftCmd('time', 'set', '6000');
    await teleport(b, feet);
    await clearArea(b.truth, { x: area.x, z: area.z }, 8, 8);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 8, 8).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[dayone-shell e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('on: 10 blocks round the bot after dusk, one side dug at dawn, then home', async () => {
    const b = bot!;
    b.settings.set('nightShell', 'on');
    await loadKit(b, [['cobblestone', 16], ['stone_pickaxe', 1]]);
    // what `!home set` and `!shelter set` set where the owner stands
    b.task.home!.set(home);
    b.task.shelter!.set({ x: area.x, y: F, z: area.z });
    await teleport(b, feet);
    const t0 = Date.now();
    await craftCmd('time', 'set', '13000');
    const walls = [...ring(0), ...ring(1)];
    await until(async () => ((await solidCount(b, walls)) === 8 && (await solidCount(b, [{ x: area.x, y: F + 2, z: area.z }])) === 1 ? true : undefined), 60_000, 'the shell', 1000);
    const sealedS = (Date.now() - t0) / 1000;
    const inv = await b.truth.craftinv(b.name);
    const log = b.logs.filter((x) => x.includes('night shell')).slice(-2);
    notes.push(`on: walled in ${sealedS.toFixed(1)} s after the clock went to 13000; cobblestone left ${inv.counts.cobblestone}; ${log.join(' | ')}`);
    expect(inv.counts.cobblestone).toBe(6);
    await sleep(3000);
    const t1 = Date.now();
    await craftCmd('time', 'set', '23100');
    await until(async () => ((await solidCount(b, walls)) === 6 ? true : undefined), 60_000, 'one side open', 1000);
    const pos = await until(() => {
      const p = b.task.position();
      return p && hdist(p, { x: home.x + 0.5, z: home.z + 0.5 }) < 1.5 ? p : undefined;
    }, 60_000, 'home', 500);
    const log2 = b.logs.filter((x) => /night shell|dawn/.test(x)).slice(-3);
    notes.push(`on: out and home ${((Date.now() - t1) / 1000).toFixed(1)} s after the clock went to 23100 (at ${pos.x.toFixed(1)} ${pos.z.toFixed(1)}); ${log2.join(' | ')}`);
  }, 240_000);

  it('off (the default): nothing is placed at the shelter', async () => {
    const b = bot!;
    b.settings.set('nightShell', 'off');
    await craftCmd('time', 'set', '6000');
    await sleep(2000);
    await clearArea(b.truth, { x: area.x, z: area.z }, 3, 4);
    await craftCmd('kill', '@e[type=item]'); // the 'on' case's dug side dropped 2 cobblestone: none picked up here
    await loadKit(b, [['cobblestone', 16]]);
    await craftCmd('time', 'set', '13000');
    await until(() => {
      const p = b.task.position();
      return p && hdist(p, feet) < 1 ? true : undefined;
    }, 60_000, 'in the shelter', 500);
    await sleep(8000);
    const n = await solidCount(b, [...ring(0), ...ring(1), { x: area.x, y: F + 2, z: area.z }]);
    notes.push(`off: ${n} cells solid round the shelter after 8 s inside`);
    expect(n).toBe(0);
    expect((await b.truth.craftinv(b.name)).counts.cobblestone).toBe(16);
  }, 120_000);

  // the measured case: opened at 23000 with a skeleton near, the bot was shot from 20 to 6 at the open side
  it('dawn with a hostile near: the shell stays shut until it is gone, then opens', async () => {
    const b = bot!;
    await craftCmd('time', 'set', '6000');
    await sleep(2000);
    await clearArea(b.truth, { x: area.x, z: area.z }, 10, 4);
    await loadKit(b, [['cobblestone', 16], ['stone_pickaxe', 1]]);
    await teleport(b, feet);
    b.settings.set('nightShell', 'on');
    await craftCmd('time', 'set', '13000');
    const walls = [...ring(0), ...ring(1)];
    await until(async () => ((await solidCount(b, walls)) === 8 ? true : undefined), 60_000, 'the shell', 1000);
    // a zombie in a closed stone box 8 blocks east (a mob needs a difficulty above peaceful)
    const cx = area.x + 8;
    try {
      await craftCmd('difficulty', 'easy');
      await craftCmd('fill', String(cx - 1), String(F - 1), String(area.z - 1), String(cx + 1), String(F + 2), String(area.z + 1), 'stone', 'hollow');
      await craftCmd('summon', 'zombie', String(cx), String(F), String(area.z));
      await sleep(2000);
      const from = b.logs.length;
      const t0 = Date.now();
      await craftCmd('time', 'set', '23100');
      await until(() => (b.logs.slice(from).some((x) => x.includes('at dawn: shut')) ? true : undefined), 30_000, 'the dawn wait', 500);
      await sleep(5000);
      const shut = await solidCount(b, walls);
      notes.push(`dawn with a zombie at 8: ${shut} of 8 walls standing ${((Date.now() - t0) / 1000).toFixed(1)} s after the clock went to 23100`);
      expect(shut).toBe(8);
      await craftCmd('kill', '@e[type=zombie]');
      const t1 = Date.now();
      await until(async () => ((await solidCount(b, walls)) === 6 ? true : undefined), 30_000, 'opened after the zombie', 500);
      notes.push(`zombie gone: opened ${((Date.now() - t1) / 1000).toFixed(1)} s later; ${b.logs.slice(from).filter((x) => x.includes('night shell')).join(' | ')}`);
    } finally {
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await craftCmd('fill', String(cx - 1), String(F - 1), String(area.z - 1), String(cx + 1), String(F + 2), String(area.z + 1), 'air').catch(() => undefined);
      await craftCmd('fill', String(cx - 1), String(F - 1), String(area.z - 1), String(cx + 1), String(F - 1), String(area.z + 1), 'grass_block').catch(() => undefined);
      b.settings.set('nightShell', 'off');
    }
  }, 240_000);

  // the measured case: a shelter on leaf litter, 2 blocks placed and 5 cells open, the bot shot dead that night
  it('litter: leaf litter round the shelter is dug, then the shell closes', async () => {
    const b = bot!;
    await craftCmd('time', 'set', '6000');
    await sleep(2000);
    await clearArea(b.truth, { x: area.x, z: area.z }, 4, 4);
    await craftCmd('fill', String(area.x - 2), String(F), String(area.z - 2), String(area.x + 2), String(F), String(area.z + 2), 'leaf_litter');
    await loadKit(b, [['cobblestone', 16], ['stone_pickaxe', 1]]);
    b.task.home!.set(home);
    b.task.shelter!.set({ x: area.x, y: F, z: area.z });
    await teleport(b, feet);
    b.settings.set('nightShell', 'on');
    const from = b.logs.length;
    const t0 = Date.now();
    await craftCmd('time', 'set', '13000');
    const cells = [...ring(0), ...ring(1), { x: area.x, y: F + 2, z: area.z }];
    const n = await until(async () => {
      const k = await solidCount(b, cells);
      return k === 9 || b.logs.slice(from).some((x) => /night shell: .*(cell\(s\) open|walled in)/.test(x)) ? k : undefined;
    }, 60_000, 'the shell on litter', 1000);
    await sleep(2000);
    const k = await solidCount(b, cells);
    const lines = b.logs.slice(from).filter((x) => x.includes('night shell'));
    notes.push(`litter: ${k} of 9 cells solid ${((Date.now() - t0) / 1000).toFixed(1)} s after the clock went to 13000 (first count ${n}); ${lines.join(' | ')}`);
    b.settings.set('nightShell', 'off');
    expect(k).toBe(9);
    expect(lines.some((x) => x.includes('leaf_litter') && x.includes('cleared'))).toBe(true);
  }, 240_000);

  // the measured case: a kit's shelter under an oak's canopy two over the head counted as a roof, and no shell was built
  it('canopy and roof: walled in under leaves; under planks nothing is placed', async () => {
    const b = bot!;
    const night = async (over: string): Promise<{ n: number; log: string[] }> => {
      await craftCmd('time', 'set', '6000');
      await sleep(2000);
      await clearArea(b.truth, { x: area.x, z: area.z }, 3, 6);
      await craftCmd('fill', String(area.x - 1), String(F + 3), String(area.z - 1), String(area.x + 1), String(F + 4), String(area.z + 1), over);
      await loadKit(b, [['cobblestone', 16], ['stone_pickaxe', 1]]);
      await teleport(b, feet);
      b.settings.set('nightShell', 'on');
      const from = b.logs.length;
      await craftCmd('time', 'set', '13000');
      const cells = [...ring(0), ...ring(1), { x: area.x, y: F + 2, z: area.z }];
      const n = await until(async () => {
        const k = await solidCount(b, cells);
        return k === 9 || b.logs.slice(from).some((x) => x.includes('night shell: a roof')) ? k : undefined;
      }, 60_000, `the shell under ${over}`, 1000);
      await sleep(over === 'oak_leaves' ? 0 : 4000);
      return { n: over === 'oak_leaves' ? n : await solidCount(b, cells), log: b.logs.slice(from).filter((x) => x.includes('night shell')) };
    };
    const leaves = await night('oak_leaves');
    notes.push(`canopy: ${leaves.n} of 9 cells solid; ${leaves.log.join(' | ')}`);
    expect(leaves.n).toBe(9);
    const roof = await night('oak_planks');
    notes.push(`roof: ${roof.n} of 9 cells solid after 4 s more; ${roof.log.join(' | ')}`);
    expect(roof.n).toBe(0);
    expect(roof.log.some((x) => x.includes('a roof over the shelter (oak_planks'))).toBe(true);
    b.settings.set('nightShell', 'off');
  }, 240_000);
});
