// e2e (tag @bds), Track E9 (docs/early-game.md "The way home and the morning after", ADR 0111), on a flat, peaceful
// server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another). One
// afk-task bot in its own area.
//   shaft    the place a mining walk leaves the body in: the foot of a one-wide shaft 10 deep in a block of stone 19
//            wide (the way out is more than the dig way's 12 blocks whichever way it goes), home 16 blocks off on the
//            ground, a furnace carried: `!furnace` walks home first. Before the rule: `furnace: the walk home failed
//            (unreachable)` at once. With it the goto says it is shut in, digs out and the furnace stands by home.
//   night    the same place at dusk with the shelter at home: the night rule's walk to its shelter gets there (before:
//            `night: shelter unreachable (unreachable), attempt 1/3`)
//   craft    the same place with gravel on the four sides of the feet (the crafter digs a stone cell for its table,
//            never a falling block), a crafting table and cobblestone carried: `!get furnace`. The craft finds no cell for its
//            table (`no_table`; before: the job's end); the job walks home (the goto digs out) and crafts there
//   morning  a job paused for the night at its shelter, a creeper held 10 blocks off in the morning (it does not burn):
//            the job stays paused (`morning: waiting ...`) until the creeper is gone, then goes on; with `jobMorning`
//            off it goes on at dawn at once
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, E9_OUT=<file> (the
// measured lines appended), E9_LOG=<file> (the bot's log), E9_CASE=shaft,night,craft,morning (a subset), E9_BEFORE=1 (the
// code before the track: the cases record what happens and assert nothing).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { clearArea, craftCmd, E2E, FEET_Y, hdist, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const ONLY = process.env.E9_CASE;
const want = (c: string) => !ONLY || ONLY.split(',').includes(c);
const BEFORE = process.env.E9_BEFORE === '1';
/** Half the width of the stone block and its height over the ground. */
const R = 9;
const H = 12;

describe.skipIf(!E2E)('@bds early home: the way home from a shaft, the morning after a night (Track E9)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const foot = { x: area.x + 0.5, y: F + 2, z: area.z + 0.5 };
  const home = { x: area.x + R + 7, y: F, z: area.z };

  async function ground(b: CraftBot): Promise<void> {
    await truthLoaded(b.truth, 'fill', [area.x - R, F, area.z - R, area.x + R, F + H, area.z + R, 'air']);
    await clearArea(b.truth, { x: area.x, z: area.z }, R + 12, 4);
    await craftCmd('kill', '@e[type=item]');
  }

  /** The block of stone with the shaft down its middle; the bot at the shaft's foot. */
  async function shaft(b: CraftBot): Promise<void> {
    await craftCmd('time', 'set', '6000');
    await b.command('!get stop');
    await sleep(1000);
    const placed = (await import('../../src/skills/items/placed.ts')).placedOf(b.task).all();
    for (const f of [...placed]) await truthLoaded(b.truth, 'fill', [f.p.x, f.p.y, f.p.z, f.p.x, f.p.y, f.p.z, 'air']);
    await teleport(b, { x: area.x + 0.5, y: F + H + 2, z: area.z + 0.5 });
    await ground(b);
    await truthLoaded(b.truth, 'fill', [area.x - R, F, area.z - R, area.x + R, F + H - 1, area.z + R, 'stone']);
    await truthLoaded(b.truth, 'fill', [area.x, F + 2, area.z, area.x, F + H - 1, area.z, 'air']);
    b.task.shelter!.set(undefined);
    b.task.home?.set(home);
    b.settings.set('protectRadius', '4');
    b.settings.set('nightShell', 'off');
    await teleport(b, foot);
  }

  const dugOf = (b: CraftBot, from: number): number => b.logs.slice(from).filter((l) => / dig \(-?\d+, -?\d+, -?\d+\): \w+ -> air/.test(l)).length;

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyHome');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.settings.set('shellBlocks', 'off');
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await teleport(bot, { x: area.x + 0.5, y: F + H + 2, z: area.z + 0.5 }).catch(() => undefined);
      await ground(bot).catch(() => undefined);
      await bot.stop();
    }
    const text = `[early-home e2e${BEFORE ? ', the code before' : ''}] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.E9_OUT) appendFileSync(process.env.E9_OUT, text);
    if (process.env.E9_LOG && bot) appendFileSync(process.env.E9_LOG, `${bot.logs.join('\n')}\n`);
  }, 120_000);

  it.runIf(want('shaft'))('shaft: `!furnace` from the foot of a shaft walks home (the goto digs out) and sets the furnace down there', async () => {
    const b = bot!;
    await shaft(b);
    await loadKit(b, [['stone_pickaxe', 1], ['furnace', 1], ['cobblestone', 8]]);
    const from = b.said.length;
    const logFrom = b.logs.length;
    const t0 = Date.now();
    await b.command('!furnace');
    const end = await b.reply((s) => /^furnace( placed|:)/.test(s) && !/crafting one|placing the one/.test(s), from, 240_000);
    const s = (Date.now() - t0) / 1000;
    const p = b.task.position()!;
    const shut = b.logs.slice(logFrom).find((l) => l.includes('goto: shut in')) ?? '';
    const refused = b.logs.slice(logFrom).find((l) => l.includes('goto unreachable without a segment')) ?? '';
    notes.push(`shaft: ${end}; ${s.toFixed(1)} s; ${dugOf(b, logFrom)} blocks dug; ${hdist(p, { x: home.x + 0.5, z: home.z + 0.5 }).toFixed(1)} from home at the end; ${shut ? shut.replace(/^.*goto: /, 'goto: ').slice(0, 200) : 'no shut-in line'}${refused ? `; ${refused.replace(/^.*goto unreachable/, 'goto unreachable').slice(0, 260)}` : ''}`);
    if (BEFORE) return;
    expect(end).toMatch(/^furnace placed at -?\d+ -?\d+ -?\d+ by home$/);
    expect(hdist(p, { x: home.x + 0.5, z: home.z + 0.5 })).toBeLessThanOrEqual(4.5);
    expect(dugOf(b, logFrom)).toBeGreaterThan(12);
    expect(shut).not.toBe('');
  }, 300_000);

  it.runIf(want('night'))('night: the night rule walks from the foot of the shaft to its shelter', async () => {
    const b = bot!;
    await shaft(b);
    await loadKit(b, [['stone_pickaxe', 1], ['cobblestone', 8]]);
    b.task.shelter!.set(home);
    const logFrom = b.logs.length;
    const t0 = Date.now();
    await craftCmd('time', 'set', '12100');
    const line = await until(() => b.logs.slice(logFrom).find((l) => /night: (inside the shelter|shelter unreachable)/.test(l)), 180_000, 'the night rule inside its shelter or refused', 250);
    const s = (Date.now() - t0) / 1000;
    const p = b.task.position()!;
    notes.push(`night: ${line.replace(/^.*night: /, 'night: ').slice(0, 220)}; ${s.toFixed(1)} s after the clock went to dusk; ${dugOf(b, logFrom)} blocks dug; ${hdist(p, { x: home.x + 0.5, z: home.z + 0.5 }).toFixed(1)} from the shelter`);
    await craftCmd('time', 'set', '6000');
    b.task.shelter!.set(undefined);
    if (BEFORE) return;
    expect(line).toContain('night: inside the shelter');
    expect(hdist(p, { x: home.x + 0.5, z: home.z + 0.5 })).toBeLessThan(1.1);
  }, 300_000);

  it.runIf(want('craft'))('craft: a job`s craft with no cell for its table at the foot of the shaft walks home and crafts there', async () => {
    const b = bot!;
    await shaft(b);
    // gravel on the four sides of the feet: the crafter digs a side cell of stone for its table, never a falling block
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) await truthLoaded(b.truth, 'fill', [area.x + dx, F + 2, area.z + dz, area.x + dx, F + 2, area.z + dz, 'gravel']);
    await loadKit(b, [['stone_pickaxe', 1], ['crafting_table', 1], ['cobblestone', 32]]);
    const from = b.said.length;
    const logFrom = b.logs.length;
    const t0 = Date.now();
    await b.command('!get furnace');
    const end = await b.reply((s) => /^get furnace: (done|stopped)/.test(s), from, 240_000);
    const s = (Date.now() - t0) / 1000;
    const p = b.task.position()!;
    const first = b.logs.slice(logFrom).find((l) => l.includes('!craft furnace 1 ->')) ?? '';
    notes.push(`craft: ${end.slice(0, 260)}; ${s.toFixed(1)} s; ${dugOf(b, logFrom)} blocks dug; ${hdist(p, { x: home.x + 0.5, z: home.z + 0.5 }).toFixed(1)} from home at the end; the first craft: ${first.replace(/^.*!craft furnace 1 -> /, '').slice(0, 160)}`);
    await b.command('!get stop');
    if (BEFORE) return;
    expect(first).toContain('no_table');
    // (the job sets the furnace it made down by home: its fourth step)
    expect(end).toMatch(/^get furnace: done in \d+ s, 4 steps; crafted again at home after no room for a table; .*steps: craft furnace 1, goto -?\d+ -?\d+ -?\d+, craft furnace 1, furnace$/);
    expect(hdist(p, { x: home.x + 0.5, z: home.z + 0.5 })).toBeLessThanOrEqual(4.5);
    expect(dugOf(b, logFrom)).toBeGreaterThan(12);
  }, 300_000);

  // ---- the morning after ------------------------------------------------------------------------------------------
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const shelter = { x: area.x - 6, y: F, z: area.z };
  const ring = (c: Vec3, dy: number): Vec3[] => [
    { x: c.x + 1, y: c.y + dy, z: c.z },
    { x: c.x - 1, y: c.y + dy, z: c.z },
    { x: c.x, y: c.y + dy, z: c.z + 1 },
    { x: c.x, y: c.y + dy, z: c.z - 1 },
  ];
  const shell = (c: Vec3): Vec3[] => [...ring(c, 0), ...ring(c, 1), { x: c.x, y: c.y + 2, z: c.z }];
  const solidCount = async (b: CraftBot, cells: Vec3[]): Promise<number> => {
    let n = 0;
    for (const q of cells) if ((await b.truth.block(q)).typeId !== 'minecraft:air') n++;
    return n;
  };
  /** A creeper in a closed stone box `d` blocks west of the shelter (it does not burn; a mob needs a difficulty above peaceful). */
  const boxAt = (d: number) => ({ x: shelter.x - d, y: F, z: shelter.z });
  async function creeper(d: number): Promise<void> {
    const c = boxAt(d);
    await craftCmd('difficulty', 'easy');
    await craftCmd('fill', String(c.x - 1), String(F - 1), String(c.z - 1), String(c.x + 1), String(F + 2), String(c.z + 1), 'stone', 'hollow');
    await craftCmd('summon', 'creeper', String(c.x), String(F), String(c.z));
    await sleep(2000);
  }
  async function noCreeper(d: number): Promise<void> {
    const c = boxAt(d);
    await craftCmd('kill', '@e[type=creeper]').catch(() => undefined);
    await craftCmd('difficulty', 'peaceful').catch(() => undefined);
    await craftCmd('fill', String(c.x - 1), String(F - 1), String(c.z - 1), String(c.x + 1), String(F + 2), String(c.z + 1), 'air').catch(() => undefined);
    await craftCmd('fill', String(c.x - 1), String(F - 1), String(c.z - 1), String(c.x + 1), String(F - 1), String(c.z + 1), 'grass_block').catch(() => undefined);
    await craftCmd('kill', '@e[type=item]').catch(() => undefined);
  }
  /** A job paused for the night at the shelter: 8 iron ore in the floor, dusk after the first one. */
  async function pausedJob(b: CraftBot, shellOn: boolean): Promise<number> {
    await craftCmd('time', 'set', '6000');
    await b.command('!get stop');
    await sleep(1000);
    await teleport(b, { x: area.x + 0.5, y: F + H + 2, z: area.z + 0.5 });
    await ground(b);
    b.task.home?.set(undefined);
    b.task.shelter!.set(shelter);
    b.settings.set('protectRadius', '48');
    b.settings.set('nightShell', shellOn ? 'on' : 'off');
    b.settings.set('jobDusk', 'on');
    await teleport(b, feet);
    for (let i = 0; i < 8; i++) await truthLoaded(b.truth, 'fill', [area.x + 4 + (i % 4), F - 1, area.z - 6 + Math.floor(i / 4), area.x + 4 + (i % 4), F - 1, area.z - 6 + Math.floor(i / 4), 'iron_ore']);
    await loadKit(b, [['stone_pickaxe', 1], ['crafting_table', 1], ['cobblestone', 26], ['oak_planks', 8], ['coal', 2]]);
    await craftCmd('time', 'set', '11900');
    await sleep(300);
    const from = b.said.length;
    await b.command('!get iron_chestplate');
    await until(() => (b.processes.userProcesses().some((x) => x.name === 'mine') && b.built.mobility!.world.inventory.count('raw_iron') >= 1 ? true : undefined), 60_000, 'the mine step with its first ore', 50);
    await craftCmd('time', 'set', '12100');
    await b.reply((x) => x.includes('paused for the night'), from, 60_000);
    if (shellOn) await until(async () => ((await solidCount(b, shell(shelter))) === 9 ? true : undefined), 60_000, 'the shell at the shelter', 1000);
    else await until(() => (hdist(b.task.position()!, { x: shelter.x + 0.5, z: shelter.z + 0.5 }) < 1 ? true : undefined), 60_000, 'the bot at the shelter', 250);
    return from;
  }

  it.runIf(want('morning'))('morning: a creeper 10 blocks off at dawn holds the paused job and the night shell; once it is gone the job goes on', async () => {
    const b = bot!;
    b.settings.set('jobMorning', 'on');
    const from = await pausedJob(b, true);
    const logFrom = b.logs.length;
    try {
      await creeper(10);
      const t0 = Date.now();
      // the clock is frozen on the test server: 1500 is past the tick the undead have burned by (MORNING_SUN + MORNING_BURN)
      // and before the wait's cap (2000), so only the creeper holds the job
      await craftCmd('time', 'set', '1500');
      const wait = await b.reply((x) => x.includes('morning: waiting'), from, 30_000);
      await sleep(6000);
      const shut = await solidCount(b, shell(shelter));
      const going = b.said.slice(from).some((x) => x.includes('dawn: going on'));
      notes.push(`morning: ${wait} ${((Date.now() - t0) / 1000).toFixed(1)} s after the clock went to 1500 (first line); ${shut} of 9 shell cells standing 6 s later; ${b.logs.slice(logFrom).filter((l) => l.includes('dawn: staying in the shelter')).map((l) => l.replace(/^.*dawn: /, 'dawn: ')).join(' | ')}`);
      if (!BEFORE) {
        expect(wait).toMatch(/^get iron_chestplate: morning: waiting \(a creeper (9|10|11) blocks off\)$/);
        expect(shut).toBe(9);
        expect(going).toBe(false);
        expect(b.processes.userProcesses()).toHaveLength(0);
      }
      const t1 = Date.now();
      await craftCmd('kill', '@e[type=creeper]');
      const dawn = await b.reply((x) => x.includes('dawn: going on'), from, 60_000);
      notes.push(`morning: creeper gone: ${dawn} ${((Date.now() - t1) / 1000).toFixed(1)} s later; ${b.logs.slice(logFrom).filter((l) => /night shell: (clear|still|opened)/.test(l)).map((l) => l.replace(/^.*night shell: /, 'night shell: ')).join(' | ')}`);
      if (!BEFORE) expect(dawn).toMatch(/^get iron_chestplate: dawn: going on after \d+ s \(paused at !mine iron_ore 8\)$/);
      // the job mines on
      await until(() => (b.processes.userProcesses().some((x) => x.name === 'mine') ? true : undefined), 30_000, 'the mine step again', 100);
    } finally {
      await b.command('!get stop');
      await noCreeper(10);
      b.settings.set('jobMorning', 'off');
      b.settings.set('nightShell', 'off');
      await craftCmd('time', 'set', '6000');
    }
  }, 420_000);

  it.runIf(want('morning'))('morning off (`jobMorning` off, no shell): the job goes on at dawn with the creeper still there', async () => {
    const b = bot!;
    b.settings.set('jobMorning', 'off');
    const from = await pausedJob(b, false);
    try {
      await creeper(10);
      const t0 = Date.now();
      await craftCmd('time', 'set', '1500');
      const dawn = await b.reply((x) => x.includes('dawn: going on'), from, 30_000);
      notes.push(`morning off: ${dawn} ${((Date.now() - t0) / 1000).toFixed(1)} s after the clock went to 1500, the creeper alive 10 blocks off`);
      expect(dawn).toBe('get iron_chestplate: dawn: going on (paused at !mine iron_ore 8)');
      expect(b.said.slice(from).some((x) => x.includes('morning:'))).toBe(false);
    } finally {
      await b.command('!get stop');
      await noCreeper(10);
      await craftCmd('time', 'set', '6000');
    }
  }, 300_000);
});
