// e2e (tag @bds), Track E10 (docs/early-game.md "Early-game leftovers (Track E10)", ADR 0112), on a flat, peaceful server
// with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another). One afk-task bot.
//   step    the night shell on a step down: the ground one lower along one side of the shelter (a river bank's measured
//           case); 16 cobblestone, `nightShell` on, the clock to dusk: every cell of the shell solid (the cell under that
//           side's feet cell filled first). Before: that side's feet and head cells open (no face)
//   table   a crafting table in the south feet-ring cell (the job's own table by the shelter): the cell over it is closed
//           against a brace on its corner. Before: that cell open
//   fuel    a furnace by the bot, 6 raw beef, 3 oak planks and 2 oak logs carried: `!cook` cooks all 6 (the planks, then
//           the logs once the slot is empty). Before: `cook: no fuel ... (cooked 4 cooked_beef first)`
//   flee    no blade, a skeleton (no bow, held still, a helmet against the sun) by four trees, difficulty easy for the case:
//           `!get oak_planks 16` gathers by the skeleton, the flight on foot fires again and again; the job ends the step
//           once it is mostly flight and the end line says what took the time. Before: the step runs on (E10_FLEE_S, 180 s)
//   bed     no sheep within 32 and none remembered, a flock of 6 held still 110 east (past the server's mob range), 3 planks and a table carried: `!get
//           bed` searches along the axes, walks to the flock and makes the bed. Before: `!kill sheep 3 got nothing`
//   status  `!get oak_log 2` (a plain gather), then `!get stick 4` (an obtain job): `!get status` names the job's end
//           line as the last
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, E10_OUT=<file> (the measured
// lines appended), E10_CASE=step,table,... (a subset), E10_BEFORE=1 (records without asserting: the tree before),
// E10_FLEE_S (the before side's watch, default 180).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const ONLY = process.env.E10_CASE;
const want = (c: string) => !ONLY || ONLY.split(',').includes(c);
const BEFORE = process.env.E10_BEFORE === '1';

describe.skipIf(!E2E)('@bds early leftovers: the shell\'s open sides, the fuel, a step lost to flights, the status (Track E10)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const note = (s: string): void => {
    notes.push(s);
    if (process.env.E10_OUT) appendFileSync(process.env.E10_OUT, `${new Date().toISOString()} ${BEFORE ? 'before' : 'after'} ${s}\n`);
  };
  const ring = (c: { x: number; z: number }, dy: number): Vec3[] => [
    { x: c.x + 1, y: F + dy, z: c.z },
    { x: c.x - 1, y: F + dy, z: c.z },
    { x: c.x, y: F + dy, z: c.z + 1 },
    { x: c.x, y: F + dy, z: c.z - 1 },
  ];
  const shell = (c: { x: number; z: number }): Vec3[] => [...ring(c, 0), ...ring(c, 1), { x: c.x, y: F + 2, z: c.z }];
  const open = async (b: CraftBot, cells: Vec3[]): Promise<Vec3[]> => {
    const out: Vec3[] = [];
    for (const p of cells) if ((await b.truth.block(p)).typeId === 'minecraft:air') out.push(p);
    return out;
  };
  async function fresh(b: CraftBot, r = 12): Promise<void> {
    b.settings.set('nightShell', 'off');
    await craftCmd('time', 'set', '6000');
    await b.command('!stop');
    await sleep(1500);
    b.task.shelter!.set(undefined);
    b.task.home?.set(undefined);
    await b.truth.ok('clear', [b.name]);
    await clearArea(b.truth, { x: area.x, z: area.z }, r, 8);
    await craftCmd('kill', '@e[type=item]');
    await teleport(b, feet);
  }
  /** The night shell at the shelter where the bot stands: the clock to dusk, then the shell's lines. */
  async function night(b: CraftBot): Promise<string[]> {
    b.settings.set('nightShell', 'on');
    b.task.shelter!.set({ x: area.x, y: F, z: area.z });
    const from = b.logs.length;
    await craftCmd('time', 'set', '13000');
    await until(() => (b.logs.slice(from).some((x) => /night shell: (walled in|\d+ cell\(s\) open)/.test(x)) ? true : undefined), 60_000, 'the shell', 500);
    await sleep(3000);
    const lines = b.logs.slice(from).filter((x) => /night shell|seal: /.test(x));
    await craftCmd('time', 'set', '6000');
    return lines;
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyLeft');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await teleport(b, feet);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 24, 8).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[early-leftovers e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it.skipIf(!want('step'))('step: the shell on a step down closes (the cell under that side filled first)', async () => {
    const b = bot!;
    await fresh(b);
    // the ground one lower north of the shelter: the floor row at z - 1 and beyond goes, grass one under it
    await truthLoaded(b.truth, 'fill', [area.x - 4, F - 1, area.z - 4, area.x + 4, F - 1, area.z - 1, 'air']);
    await truthLoaded(b.truth, 'fill', [area.x - 4, F - 2, area.z - 4, area.x + 4, F - 2, area.z - 1, 'grass_block']);
    await loadKit(b, [['cobblestone', 16]]);
    await teleport(b, feet);
    const lines = await night(b);
    const left = await open(b, shell(area));
    const under = (await b.truth.block({ x: area.x, y: F - 1, z: area.z - 1 })).typeId;
    note(`step: ${left.length} of 9 cells open (${left.map((c) => `${c.x - area.x} ${c.y - F} ${c.z - area.z}`).join(', ')}); the cell under the north feet cell ${under}; ${lines.join(' | ')}`);
    if (!BEFORE) {
      expect(left).toEqual([]);
      expect(under).toBe('minecraft:cobblestone');
    }
  }, 150_000);

  it.skipIf(!want('table'))('table: the cell over a crafting table in the ring is closed against a brace', async () => {
    const b = bot!;
    await fresh(b);
    await truthLoaded(b.truth, 'fill', [area.x, F, area.z + 1, area.x, F, area.z + 1, 'crafting_table']);
    await loadKit(b, [['cobblestone', 16]]);
    await teleport(b, feet);
    const lines = await night(b);
    const cells = shell(area).filter((c) => !(c.y === F && c.z === area.z + 1 && c.x === area.x));
    const left = await open(b, cells);
    note(`table: ${left.length} of 8 cells open (${left.map((c) => `${c.x - area.x} ${c.y - F} ${c.z - area.z}`).join(', ')}); ${lines.join(' | ')}`);
    if (!BEFORE) expect(left).toEqual([]);
  }, 150_000);

  it.skipIf(!want('fuel'))('fuel: 6 beef on 3 planks and 2 logs: all 6 cooked, the logs after the planks', async () => {
    const b = bot!;
    await fresh(b);
    await truthLoaded(b.truth, 'fill', [area.x + 2, F, area.z, area.x + 2, F, area.z, 'furnace']);
    await loadKit(b, [
      ['beef', 6],
      ['oak_planks', 3],
      ['oak_log', 2],
    ]);
    await teleport(b, feet);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!cook');
    const end = await b.reply((s) => s.startsWith('cooked') || s.startsWith('cook:'), from, 180_000);
    const s = (Date.now() - t0) / 1000;
    const inv = (await b.truth.craftinv(b.name)).counts;
    note(`fuel: ${end}; ${s.toFixed(1)} s; cooked_beef ${inv.cooked_beef ?? 0}, beef ${inv.beef ?? 0}, planks ${inv.oak_planks ?? 0}, logs ${inv.oak_log ?? 0}; ${b.logs.filter((x) => x.includes('fuelled again')).slice(-2).join(' | ')}`);
    if (!BEFORE) {
      expect(end).toMatch(/^cooked 6 cooked_beef /);
      expect(inv.cooked_beef).toBe(6);
      expect(end).not.toMatch(/no fuel/);
    }
  }, 240_000);

  it.skipIf(!want('status'))('status: after an obtain job `!get status` names its end line', async () => {
    const b = bot!;
    await fresh(b);
    for (const [dx, dz] of [
      [4, 0],
      [-4, 0],
    ] as const)
      await truthLoaded(b.truth, 'tree', [area.x + dx, F, area.z + dz, 5, 'oak', 1]);
    await teleport(b, feet);
    // (before the flee case: a gather started after it stayed in its first part, the pick-up of wood lying near, with
    // no log line for 90 s, on the tree before this track too; the gather's end is read from the processes)
    const l0 = b.logs.length;
    await b.command('!get oak_log 2');
    await sleep(1500);
    try {
      await until(() => (b.processes.userProcesses().length === 0 && b.built.mobility!.world.inventory.count('oak_log') >= 2 ? true : undefined), 90_000, 'the gather of 2 logs', 500);
    } catch (e) {
      note(`status: the gather did not end: processes ${b.processes.userProcesses().map((p) => p.status().line).join('; ')}; active ${b.processes.active?.name}; logs ${b.built.mobility!.world.inventory.count('oak_log')}; said ${b.said.slice(-4).join(' | ')}; ${b.logs.slice(l0).slice(-12).join(' | ')}`);
      throw e;
    }
    await sleep(1500);
    let from = b.said.length;
    await b.command('!get stick 4');
    const end = await b.reply((s) => s.startsWith('get stick: '), from, 120_000);
    await sleep(1000);
    from = b.said.length;
    await b.command('!get status');
    const st = await b.reply((s) => s.startsWith('get'), from, 10_000);
    note(`status: ${end} -> ${st}`);
    if (!BEFORE) expect(st.startsWith(`get: idle (last: ${end.length > 160 ? `${end.slice(0, 157)}...` : end})`)).toBe(true); // (the stash's part after it)
  }, 240_000);
  it.skipIf(!want('flee'))('flee: a gather step that is mostly flight ends early and says what took the time', async () => {
    const b = bot!;
    await fresh(b, 24);
    // four trees 5 east of the shelter, the skeleton among them
    const tx = area.x + 6;
    for (const [dx, dz] of [
      [0, -4],
      [0, 4],
      [4, 0],
      [-4, 0],
    ] as const)
      await truthLoaded(b.truth, 'tree', [tx + dx, F, area.z + dz, 5, 'oak', 1]);
    await loadKit(b, [['bread', 4]]);
    await teleport(b, feet);
    const watch = Number(process.env.E10_FLEE_S ?? (BEFORE ? 180 : 300));
    let flights = 0;
    let fleeMs = 0;
    let fleeing = false;
    let since = 0;
    let stopWatch = false;
    try {
      await craftCmd('difficulty', 'easy');
      await craftCmd('summon', 'skeleton', String(tx), String(F), String(area.z));
      await sleep(1500);
      await craftCmd('replaceitem', 'entity', '@e[type=skeleton]', 'slot.weapon.mainhand', '0', 'air');
      await craftCmd('replaceitem', 'entity', '@e[type=skeleton]', 'slot.armor.head', '0', 'leather_helmet');
      await craftCmd('effect', '@e[type=skeleton]', 'slowness', '600', '255', 'true');
      await craftCmd('effect', '@e[type=skeleton]', 'fire_resistance', '600', '0', 'true');
      await craftCmd('effect', '@e[type=skeleton]', 'resistance', '600', '255', 'true');
      const from = b.said.length;
      const t0 = Date.now();
      const poll = (async () => {
        while (!stopWatch) {
          const a = b.processes.active?.name === 'flee';
          if (a && !fleeing) {
            flights++;
            since = Date.now();
          }
          if (!a && fleeing) fleeMs += Date.now() - since;
          fleeing = a;
          await sleep(250);
        }
        if (fleeing) fleeMs += Date.now() - since;
      })();
      await b.command('!get oak_planks 16');
      let end: string | undefined;
      try {
        end = await b.reply((s) => /^get oak_planks: (done|stopped)/.test(s), from, watch * 1000);
      } catch {
        end = undefined;
      }
      const s = (Date.now() - t0) / 1000;
      stopWatch = true;
      await poll;
      if (!end) await b.command('!get stop');
      const logs = b.built.mobility!.world.inventory.count('oak_log');
      note(`flee: ${end ?? `no end line in ${watch} s`}; ${s.toFixed(0)} s; ${flights} flights, ${(fleeMs / 1000).toFixed(0)} s fleeing; ${logs} logs carried; ${b.logs.filter((x) => /mostly flight|flights took/.test(x)).slice(-2).join(' | ')}`);
      if (!BEFORE) {
        expect(end).toMatch(/^get oak_planks: stopped after \d+ s, \d+ steps?: !gather \d+: \d+ of \d+ logs in \d+ s: \d+ flights? took \d+ s \(skeleton\)/);
        expect(s).toBeLessThan(300);
      }
    } finally {
      stopWatch = true;
      await craftCmd('kill', '@e[type=skeleton]').catch(() => undefined);
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await b.command('!get stop').catch(() => undefined);
    }
  }, 420_000);

  it.skipIf(!want('bed'))('bed: no sheep within 32 and no herd known: the hunt searches along the axes and finds a flock 110 off', async () => {
    const b = bot!;
    await fresh(b);
    await craftCmd('kill', '@e[type=sheep]');
    // the flock 110 east, past the 64 to 80 the server sends mobs within (measured on this server: sheep 39 and 65 off
    // sent, 80 to 192 not), held still (any colour: the hunt takes more when a colour leaves the wool short); a clear
    // strip to it
    // the far chunks loaded by a ticking area, not by the bot (it would see the flock and remember it)
    await craftCmd('tickingarea', 'add', String(area.x + 80), String(F), String(area.z - 8), String(area.x + 120), String(F), String(area.z + 8), 'e10flock');
    await sleep(3000);
    await truthLoaded(b.truth, 'fill', [area.x, F - 1, area.z - 8, area.x + 120, F - 1, area.z + 8, 'grass_block']);
    await truthLoaded(b.truth, 'fill', [area.x, F, area.z - 8, area.x + 120, F + 4, area.z + 8, 'air']);
    for (const dz of [-2, 0, 2, 4, -4, 1]) await craftCmd('summon', 'sheep', String(area.x + 110), String(F), String(area.z + dz));
    await sleep(1500);
    await craftCmd('effect', '@e[type=sheep]', 'slowness', '600', '255', 'true');
    await loadKit(b, [
      ['oak_planks', 3],
      ['crafting_table', 1],
      ['wooden_sword', 1],
    ]);
    await teleport(b, feet);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get bed');
    let end: string;
    try {
      end = await b.reply((s) => /^get (bed|white_bed): (done|stopped)/.test(s), from, 360_000);
    } catch {
      end = 'no end line in 360 s';
      await b.command('!get stop');
    }
    const s = (Date.now() - t0) / 1000;
    const inv = b.built.mobility!.world.inventory;
    const wool = inv.slots.reduce((a, x) => a + (x?.name.endsWith('_wool') ? x.count : 0), 0);
    note(`bed: ${end}; ${s.toFixed(0)} s; wool carried ${wool}; ${b.logs.filter((x) => /looking 96 out|looked for sheep/.test(x)).slice(-2).join(' | ')}`);
    await craftCmd('kill', '@e[type=sheep]').catch(() => undefined);
    await craftCmd('kill', '@e[type=item]').catch(() => undefined);
    await craftCmd('tickingarea', 'remove', 'e10flock').catch(() => undefined);
    if (!BEFORE) {
      expect(end).toMatch(/^get (white_)?bed: done/);
      expect(end).toMatch(/looked for sheep: walked \d+ along the axes in \d+ s, one seen \d+ off/);
    }
  }, 420_000);
});
