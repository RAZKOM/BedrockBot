// e2e (tag @bds), Track E7 (docs/early-game.md "Dusk", ADR 0104): the obtain job at dusk (`jobDusk`), on a flat,
// peaceful server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another).
// One afk-task bot in its own area, no home set.
//   pause    a shelter 6 blocks off under the open sky, `nightShell` on, 26 cobblestone, 8 iron ore in the floor, the
//            clock just before dusk: `!get iron_chestplate` starts its mine step, the clock goes to dusk after its
//            first ore and ends it (`paused for the night at
//            step 1 (mine iron_ore 8: n of 8), at the shelter ...; resuming at dawn`), the bot walks to the shelter and
//            walls in; nothing is dispatched in the night; the clock to dawn: out, `dawn: going on`, the rest is mined,
//            smelted and crafted (`paused for 1 night` in the end line)
//   smelt    a furnace and 8 raw iron carried: the smelt is ended at dusk with its input in
//            the furnace, which smelts on; at dawn the job takes the 8 ingots out first, then crafts
//   here     no shelter, no home, `nightShell` on: the bot walls in where it stands, and the night rule's shelter is
//            unset again at dawn
//   nowhere  no shelter, no home, `nightShell` off: nowhere to spend the night: the job works on and says so at its end
//   pit      no job: the shelter in a one-deep hole inside the base (`protectRadius` 8 round home 6 blocks off),
//            `nightShell` on: walled in over the hole (the head ring and the roof), and at dawn out by a step up (the
//            head cell of a side and the roof dug, the shell's own blocks) and home
//   off      `jobDusk` off (the code before): the night rule holds the bot at the shelter with the step paused; no pause
//            line (recorded for 20 s, then the job is stopped)
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, E7_OUT=<file> (the
// measured lines appended), E7_LOG=<file> (the bot's log), E7_CASE=pause,smelt,here,nowhere,pit,off (a subset).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { clearArea, craftCmd, E2E, FEET_Y, hdist, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const ONLY = process.env.E7_CASE;
const want = (c: string) => !ONLY || ONLY.split(',').includes(c);

describe.skipIf(!E2E)('@bds early dusk: the obtain job pauses at dusk and goes on at dawn (Track E7)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const shelter = { x: area.x - 6, y: F, z: area.z };
  const ring = (c: Vec3, dy: number): Vec3[] => [
    { x: c.x + 1, y: c.y + dy, z: c.z },
    { x: c.x - 1, y: c.y + dy, z: c.z },
    { x: c.x, y: c.y + dy, z: c.z + 1 },
    { x: c.x, y: c.y + dy, z: c.z - 1 },
  ];
  const shell = (c: Vec3): Vec3[] => [...ring(c, 0), ...ring(c, 1), { x: c.x, y: c.y + 2, z: c.z }];
  let shellSeen = 0;
  const solidCount = async (b: CraftBot, cells: Vec3[]): Promise<number> => {
    let n = 0;
    for (const p of cells) if ((await b.truth.block(p)).typeId !== 'minecraft:air') n++;
    shellSeen = n;
    return n;
  };
  async function ores(x: number, z: number, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await truthLoaded(bot!.truth, 'fill', [x + (i % 4), F - 1, z + Math.floor(i / 4), x + (i % 4), F - 1, z + Math.floor(i / 4), 'iron_ore']);
  }
  /** The clock (frozen on the test server) to dusk once the job's step of this kind runs and has dug its first ore. */
  async function duskInStep(b: CraftBot, name: string): Promise<void> {
    await until(() => (b.processes.userProcesses().some((p) => p.name === name) && b.built.mobility!.world.inventory.count('raw_iron') >= 1 ? true : undefined), 60_000, `the ${name} step with its first ore`, 50);
    await craftCmd('time', 'set', '12100');
  }

  /** The floor and the air over it as new, the last case's furnaces and drops gone, by day. */
  async function fresh(b: CraftBot): Promise<void> {
    await craftCmd('time', 'set', '6000');
    await b.command('!get stop');
    await sleep(1500);
    const placed = (await import('../../src/skills/items/placed.ts')).placedOf(b.task).all();
    for (const f of [...placed]) await truthLoaded(b.truth, 'fill', [f.p.x, f.p.y, f.p.z, f.p.x, f.p.y, f.p.z, 'air']);
    await clearArea(b.truth, { x: area.x, z: area.z }, 14, 6);
    await truthLoaded(b.truth, 'fill', [area.x - 14, F - 1, area.z - 14, area.x + 14, F - 1, area.z + 14, 'grass_block']);
    await craftCmd('kill', '@e[type=item]');
    b.task.shelter!.set(undefined);
    b.task.home?.set(undefined);
    b.settings.set('jobDusk', 'on');
    b.settings.set('nightShell', 'off');
    b.settings.set('protectRadius', '48');
    await teleport(b, feet);
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyDusk');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.settings.set('shellBlocks', 'off');
    await teleport(b, feet);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await craftCmd('kill', '@e[type=item]').catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 14, 6).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [area.x - 14, F - 1, area.z - 14, area.x + 14, F - 1, area.z + 14, 'grass_block']).catch(() => undefined);
      await bot.stop();
    }
    const text = `[early-dusk e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.E7_OUT) appendFileSync(process.env.E7_OUT, text);
    if (process.env.E7_LOG && bot) appendFileSync(process.env.E7_LOG, `${bot.logs.join('\n')}\n`);
  }, 120_000);

  it.runIf(want('pause'))('pause: a mine step is ended at dusk, the bot walls in at the shelter, and the job goes on at dawn', async () => {
    const b = bot!;
    await fresh(b);
    b.settings.set('nightShell', 'on');
    b.task.shelter!.set(shelter);
    await ores(area.x + 4, area.z - 6, 8);
    await loadKit(b, [['stone_pickaxe', 1], ['crafting_table', 1], ['cobblestone', 26], ['oak_planks', 8], ['coal', 2]]);
    await craftCmd('time', 'set', '11900');
    await sleep(300);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_chestplate');
    await duskInStep(b, 'mine');
    const pause = await b.reply((s) => s.includes('paused for the night'), from, 60_000);
    const pauseS = (Date.now() - t0) / 1000;
    expect(pause).toMatch(/^get iron_chestplate: paused for the night at step 1 \(mine iron_ore 8: [1-7] of 8\), at the shelter -?\d+ -?\d+ -?\d+; resuming at dawn$/);
    // at the shelter, walled in (the 8 cells round the body and the roof)
    await until(async () => ((await solidCount(b, shell(shelter))) === 9 ? true : undefined), 60_000, 'the shell at the shelter', 1000).catch((e: unknown) => {
      // what the bot was doing instead (kept in the notes: a silent refusal is otherwise invisible)
      notes.push(`pause: no shell: night ${b.task.shelter!.state()}, at ${JSON.stringify(b.task.position())}, stack ${JSON.stringify(b.processes.stack().map((x) => `${x.name}:${x.state}`))}, shell cells solid ${String(shellSeen)}`);
      throw e;
    });
    const shutS = (Date.now() - t0) / 1000;
    const p = b.task.position()!;
    expect(hdist(p, { x: shelter.x + 0.5, z: shelter.z + 0.5 })).toBeLessThan(1);
    // the night: no step runs
    const steps0 = b.said.slice(from).filter((s) => /^(mining|mine |smelting|crafted)/.test(s)).length;
    await sleep(6000);
    expect(b.processes.userProcesses()).toHaveLength(0);
    expect(b.said.slice(from).filter((s) => /^(mining|mine |smelting|crafted)/.test(s)).length).toBe(steps0);
    const t1 = Date.now();
    await craftCmd('time', 'set', '23100');
    const dawn = await b.reply((s) => s.includes('dawn: going on'), from, 60_000);
    const dawnS = (Date.now() - t1) / 1000;
    expect(dawn).toBe('get iron_chestplate: dawn: going on (paused at !mine iron_ore 8)');
    const end = await b.reply((s) => s.startsWith('get iron_chestplate: ') && !/paused for the night|dawn: going on/.test(s), from, 420_000);
    const got = (await b.truth.craftinv(b.name)).counts;
    notes.push(`pause: ${pause} (${pauseS.toFixed(1)} s after the command); walled in at ${shutS.toFixed(1)} s; ${dawn} ${dawnS.toFixed(1)} s after the clock went to 23100; ${end}; ${((Date.now() - t0) / 1000).toFixed(1)} s in all; inventory ${JSON.stringify(got)}`);
    expect(end).toMatch(/^get iron_chestplate: done in \d+ s, \d+ steps; .*paused for 1 night.*; steps: mine iron_ore 8, mine iron_ore \d, .*craft iron_chestplate 1$/);
    expect(b.task.shelter!.get()).toEqual(shelter); // the owner's shelter as it was
  }, 660_000);

  it.runIf(want('smelt'))('smelt: the smelt is ended at dusk, the furnace smelts on, the output is taken at dawn', async () => {
    const b = bot!;
    await fresh(b);
    b.settings.set('nightShell', 'on');
    b.task.shelter!.set(shelter);
    await loadKit(b, [['furnace', 1], ['raw_iron', 8], ['coal', 2], ['crafting_table', 1], ['cobblestone', 16]]);
    await craftCmd('time', 'set', '11900');
    await sleep(300);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_chestplate');
    await until(() => (b.processes.userProcesses().some((p) => p.name === 'smelt') && b.built.mobility!.world.inventory.count('raw_iron') === 0 ? true : undefined), 60_000, 'the raw iron in the furnace', 100);
    await sleep(1000);
    await craftCmd('time', 'set', '12100');
    const pause = await b.reply((s) => s.includes('paused for the night'), from, 90_000);
    expect(pause).toMatch(/^get iron_chestplate: paused for the night at step \d \(smelt raw_iron 8: 8 of 8 in the furnace\), at the shelter -?\d+ -?\d+ -?\d+; resuming at dawn$/);
    await until(async () => ((await solidCount(b, shell(shelter))) === 9 ? true : undefined), 60_000, 'the shell at the shelter', 1000);
    // the 8 items take 80 s in the furnace
    await sleep(Math.max(0, 95_000 - (Date.now() - t0)));
    await craftCmd('time', 'set', '23100');
    const dawn = await b.reply((s) => s.includes('dawn: going on'), from, 120_000);
    const end = await b.reply((s) => s.startsWith('get iron_chestplate: ') && !/paused for the night|dawn: going on/.test(s), from, 300_000);
    const got = (await b.truth.craftinv(b.name)).counts;
    notes.push(`smelt: ${pause}; ${dawn}; ${end}; ${((Date.now() - t0) / 1000).toFixed(1)} s in all; inventory ${JSON.stringify(got)}`);
    expect(dawn).toMatch(/^get iron_chestplate: dawn: going on \(paused at !smelt raw_iron 8\); .*8 iron_ingot/);
    expect(end).toMatch(/^get iron_chestplate: done in \d+ s, \d+ steps; .*paused for 1 night/);
  }, 660_000);

  it.runIf(want('here'))('here: no shelter and no home, nightShell on: walled in where it stands, the shelter unset again at dawn', async () => {
    const b = bot!;
    await fresh(b);
    b.settings.set('nightShell', 'on');
    await ores(area.x + 4, area.z - 6, 8);
    await loadKit(b, [['stone_pickaxe', 1], ['crafting_table', 1], ['cobblestone', 26], ['oak_planks', 8], ['coal', 2]]);
    await craftCmd('time', 'set', '11900');
    await sleep(300);
    const from = b.said.length;
    await b.command('!get iron_chestplate');
    await duskInStep(b, 'mine');
    const pause = await b.reply((s) => s.includes('paused for the night'), from, 60_000);
    expect(pause).toMatch(/^get iron_chestplate: paused for the night at step 1 \(mine iron_ore 8: [1-7] of 8\), walled in where it stands \(-?\d+ -?\d+ -?\d+\); resuming at dawn$/);
    const at = /stands \((-?\d+) (-?\d+) (-?\d+)\)/.exec(pause)!;
    const cell = { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) };
    // (a cell over a dug ore has no floor: the shell closes what has a face; the walls and the roof are counted)
    const shut = await until(async () => ((await solidCount(b, shell(cell))) >= 8 ? await solidCount(b, shell(cell)) : undefined), 60_000, 'the shell where it stands', 1000);
    expect(b.task.shelter!.get()).toEqual(cell);
    await sleep(3000);
    await craftCmd('time', 'set', '23100');
    await b.reply((s) => s.includes('dawn: going on'), from, 60_000);
    expect(b.task.shelter!.get()).toBeUndefined();
    const end = await b.reply((s) => s.startsWith('get iron_chestplate: ') && !/paused for the night|dawn: going on/.test(s), from, 420_000);
    notes.push(`here: ${pause}; ${shut} of 9 shell cells solid; ${end}`);
    expect(end).toMatch(/^get iron_chestplate: done in \d+ s, \d+ steps; .*paused for 1 night/);
  }, 660_000);

  it.runIf(want('nowhere'))('nowhere: no shelter, no home, nightShell off: the job works on through the night and says so', async () => {
    const b = bot!;
    await fresh(b);
    await ores(area.x + 4, area.z - 6, 8);
    await loadKit(b, [['stone_pickaxe', 1], ['crafting_table', 1], ['cobblestone', 26], ['oak_planks', 8], ['coal', 2]]);
    await craftCmd('time', 'set', '11900');
    await sleep(300);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get iron_chestplate');
    await duskInStep(b, 'mine');
    const end = await b.reply((s) => s.startsWith('get iron_chestplate: '), from, 420_000);
    notes.push(`nowhere: ${end}; ${((Date.now() - t0) / 1000).toFixed(1)} s; ${b.logs.filter((l) => l.includes('dusk:')).slice(-1).join('')}`);
    expect(end).toMatch(/^get iron_chestplate: done in \d+ s, \d+ steps; .*worked through a night \(nowhere to shelter\).*; steps: mine iron_ore 8, .*craft iron_chestplate 1$/);
    expect(b.said.slice(from).some((s) => s.includes('paused for the night'))).toBe(false);
    expect(b.task.shelter!.get()).toBeUndefined();
  }, 480_000);

  it.runIf(want('pit'))('pit: a shell over a one-deep hole in the base opens by a step up at dawn (the base is never dug)', async () => {
    const b = bot!;
    await fresh(b);
    const hole = { x: area.x - 6, y: F - 1, z: area.z };
    const home = { x: area.x, y: F, z: area.z };
    await truthLoaded(b.truth, 'fill', [hole.x, hole.y, hole.z, hole.x, hole.y, hole.z, 'air']);
    b.settings.set('nightShell', 'on');
    b.settings.set('protectRadius', '8');
    b.task.home!.set(home);
    b.task.shelter!.set(hole);
    await loadKit(b, [['cobblestone', 16], ['stone_pickaxe', 1]]);
    await teleport(b, { x: hole.x + 0.5, y: hole.y, z: hole.z + 0.5 });
    const from = b.logs.length;
    await craftCmd('time', 'set', '13000');
    await until(() => (b.logs.slice(from).some((l) => l.includes('night shell: walled in')) ? true : undefined), 60_000, 'the shell over the hole', 500);
    const shut = b.logs.slice(from).filter((l) => l.includes('night shell:')).slice(-1)[0] ?? '';
    await sleep(2000);
    const t0 = Date.now();
    await craftCmd('time', 'set', '23100');
    const pos = await until(() => {
      const p = b.task.position();
      return p && p.y >= F - 0.01 && hdist(p, { x: home.x + 0.5, z: home.z + 0.5 }) < 1.5 ? p : undefined;
    }, 60_000, 'out of the hole and home', 500);
    const opened = b.logs.slice(from).filter((l) => l.includes('night shell: opened')).slice(-1)[0] ?? '';
    // nothing of the base's ground was dug: the hole's four walls stand
    const walls = await solidCount(b, ring(hole, 0));
    notes.push(`pit: ${shut}; ${opened}; home ${((Date.now() - t0) / 1000).toFixed(1)} s after the clock went to 23100 (at ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}); ${walls} of 4 walls of the hole standing`);
    expect(walls).toBe(4);
    b.settings.set('protectRadius', '48');
  }, 240_000);

  it.runIf(want('off'))('off: jobDusk off: the night rule holds the bot at the shelter with the step paused, no pause line', async () => {
    const b = bot!;
    await fresh(b);
    b.settings.set('jobDusk', 'off');
    b.task.shelter!.set(shelter);
    await ores(area.x + 4, area.z - 6, 8);
    await loadKit(b, [['stone_pickaxe', 1], ['crafting_table', 1], ['cobblestone', 26], ['oak_planks', 8], ['coal', 2]]);
    await craftCmd('time', 'set', '11900');
    await sleep(300);
    const from = b.said.length;
    await b.command('!get iron_chestplate');
    await duskInStep(b, 'mine');
    await until(() => {
      const p = b.task.position();
      return p && hdist(p, { x: shelter.x + 0.5, z: shelter.z + 0.5 }) < 1 ? true : undefined;
    }, 60_000, 'in the shelter', 500);
    await sleep(20_000);
    const mine = b.processes.userProcesses().map((p) => p.name);
    notes.push(`off: 20 s into the night at the shelter: user processes [${mine.join(', ')}], replies ${b.said.slice(from).join(' | ')}`);
    expect(b.said.slice(from).some((s) => s.includes('paused for the night'))).toBe(false);
    expect(mine).toContain('mine'); // the step waits under the night rule (its 10 minutes run on)
    await b.command('!get stop');
    await sleep(1500);
    b.settings.set('jobDusk', 'on');
  }, 240_000);
});
