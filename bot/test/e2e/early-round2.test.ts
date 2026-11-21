// e2e (tag @bds), Track E11 (docs/early-game.md "Early-game leftovers, round two (Track E11)", ADR 0117), on a flat,
// peaceful server with the truth pack (bds-craft by default; CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER point it at another).
// One afk-task bot in its own area.
//   gather  a gather paused by the night rule (a shelter set, the clock to dusk) and stopped while it is paused
//           (`!gather stop`, as the job's flight rule and `!get stop` stop a gather the flight on foot holds), then by
//           day `!get oak_log 4` among four trees. Before: the new gather stays at `gather 0/4 logs (find, 0 trees)`
//           with nothing logged after its start (the pause of the run before was never cleared). After: 4 logs
//   short   a furnace by the bot, 2 raw beef and 1 oak plank (fuel for 1.5 items): the plank burns out with the second
//           beef half cooked. Before: `cook: timeout in the furnace` when the server's cook lags our clock by a poll,
//           the cooked beef left in the furnace. After: `cook: no fuel ... (cooked 1 cooked_beef first)`, the cooked
//           and the raw beef carried, the furnace empty
//   mix     Track E9's river run as its inventory was at the cook step (2 raw beef, 1 oak plank, 6 oak logs, bread),
//           the furnace 8 blocks off and a bread eaten as the walk ends (`!eat`, the food lowered first): all 2 cooked.
//           On Track E9's tree (the planks first, no second fuelling, the deadline before the fuel check) this case
//           ended `cook: timeout`; E11_COOK_E9=1 records it without asserting
//   way     a job paused for the night at its shelter, a zombie held still (slowness 255, fire resistance) 15 blocks
//           off on the straight line from the shelter to the job's mine 30 blocks off, `jobMorning` off so the job goes
//           on at once: with `morningWay` on the walk back out keeps away from it. E11_WAY_OFF=1: the setting off (the
//           walk as before the track), recorded without asserting
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1, E11_OUT=<file> (the
// measured lines appended), E11_LOG=<file> (the bot's log), E11_CASE=gather,short,mix,way (a subset), E11_BEFORE=1
// (records without asserting: the tree before).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entityFeet } from '../../src/skills/combat/hostiles.ts';
import { clearArea, craftCmd, E2E, FEET_Y, hdist, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, truthLoaded, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const ONLY = process.env.E11_CASE;
const want = (c: string) => !ONLY || ONLY.split(',').includes(c);
const BEFORE = process.env.E11_BEFORE === '1' || process.env.E11_COOK_E9 === '1';
/** The way case with `morningWay` off on this tree (the walk as before the track), recorded without asserting. */
const WAY_OFF = process.env.E11_WAY_OFF === '1';

describe.skipIf(!E2E)('@bds early leftovers, round two: the gather after a stopped pause, the cooker, the walk out in the morning (Track E11)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: CraftBot | undefined;
  const feet = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const note = (s: string): void => {
    notes.push(s);
    if (process.env.E11_OUT) appendFileSync(process.env.E11_OUT, `${new Date().toISOString()} ${BEFORE ? 'before' : 'after'} ${s}\n`);
  };

  async function fresh(b: CraftBot, r = 14): Promise<void> {
    b.settings.set('nightShell', 'off');
    await craftCmd('time', 'set', '6000');
    await b.command('!stop');
    await b.command('!get stop');
    await sleep(1500);
    b.task.shelter!.set(undefined);
    b.task.home?.set(undefined);
    await b.truth.ok('clear', [b.name]);
    await clearArea(b.truth, { x: area.x, z: area.z }, r, 8);
    await craftCmd('kill', '@e[type=item]');
    await teleport(b, feet);
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyR2');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.settings.set('shellBlocks', 'off');
    await teleport(b, feet);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 30, 8).catch(() => undefined);
      await bot.stop();
    }
    const text = `[early-round2 e2e${BEFORE ? ', before' : ''}] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    if (process.env.E11_LOG && bot) appendFileSync(process.env.E11_LOG, `${bot.logs.join('\n')}\n`);
  }, 120_000);

  it.runIf(want('gather'))('gather: a gather stopped while the night rule held it paused; the next `!get oak_log 2` gathers', async () => {
    const b = bot!;
    await fresh(b);
    for (const [dx, dz] of [
      [5, 0],
      [-5, 0],
      [0, 5],
      [0, -5],
    ] as const)
      await truthLoaded(b.truth, 'tree', [area.x + dx, F, area.z + dz, 5, 'oak', 1]);
    await teleport(b, feet);
    // the first gather, paused by the night rule (its walk to the shelter) and stopped while paused
    b.task.shelter!.set({ x: area.x - 2, y: F, z: area.z + 2 });
    let from = b.said.length;
    await b.command('!gather 12');
    await until(() => (b.processes.userProcesses().some((p) => p.name === 'gather') && b.built.mobility!.world.inventory.count('oak_log') >= 1 ? true : undefined), 60_000, 'the first gather with a log', 250);
    await craftCmd('time', 'set', '13000');
    await until(() => (b.processes.active?.name === 'night' ? true : undefined), 30_000, 'the night rule holding the body', 100);
    const paused = b.processes.userProcesses().map((p) => p.status().line).join('; ');
    await b.command('!gather stop');
    const stopped = await b.reply((s) => s.startsWith('stopped') || s.startsWith('not gathering'), from, 10_000);
    await sleep(1000);
    await craftCmd('time', 'set', '6000');
    b.task.shelter!.set(undefined);
    await until(() => (b.processes.active?.name !== 'night' ? true : undefined), 30_000, 'the night rule letting go', 250);
    await sleep(1500);
    // the logs of the first gather out of the way (a total carried would end the next gather at once)
    await b.truth.ok('clear', [b.name]);
    await until(() => (b.built.mobility!.world.inventory.count('oak_log') === 0 ? true : undefined), 10_000, 'no logs carried', 100);
    const logs0 = b.built.mobility!.world.inventory.count('oak_log');
    const l0 = b.logs.length;
    from = b.said.length;
    const t0 = Date.now();
    await b.command('!get oak_log 4');
    let end: string;
    await sleep(1500);
    try {
      await until(() => (b.processes.userProcesses().length === 0 && b.built.mobility!.world.inventory.count('oak_log') >= 4 ? true : undefined), 90_000, 'the gather of 4 logs', 250);
      end = `ended: ${b.said.slice(from).join(' | ')}`;
    } catch {
      end = `not ended in 90 s: processes ${b.processes.userProcesses().map((p) => p.status().line).join('; ')}; said ${b.said.slice(from).join(' | ')}`;
    }
    const s = (Date.now() - t0) / 1000;
    const logs = b.built.mobility!.world.inventory.count('oak_log');
    const after = b.logs.slice(l0).filter((x) => x.includes(':gather '));
    note(`gather: paused as ${paused}; ${stopped}; then !get oak_log 4 with ${logs0} carried: ${end}; ${s.toFixed(1)} s; ${logs} logs carried; gather lines after its start: ${after.length} (${after.slice(0, 3).map((x) => x.replace(/^.*:gather \w+ /, '')).join(' | ')})`);
    await b.command('!get stop');
    if (!BEFORE) {
      expect(logs).toBeGreaterThanOrEqual(4);
      expect(s).toBeLessThan(90);
    }
  }, 300_000);

  it.runIf(want('short'))('short: 2 beef on 1 plank: the cooker says `no fuel` with the beef it cooked, and takes the output and the raw beef back', async () => {
    const b = bot!;
    await fresh(b);
    const fp = { x: area.x + 2, y: F, z: area.z };
    await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'furnace']);
    await loadKit(b, [
      ['beef', 2],
      ['oak_planks', 1],
    ]);
    await teleport(b, feet);
    const from = b.said.length;
    const l0 = b.logs.length;
    const t0 = Date.now();
    await b.command('!cook');
    const end = await b.reply((s) => s.startsWith('cooked') || s.startsWith('cook:'), from, 120_000);
    const s = (Date.now() - t0) / 1000;
    await sleep(1000);
    const inv = (await b.truth.craftinv(b.name)).counts;
    const box = await b.truth.box(fp);
    note(`short: ${end}; ${s.toFixed(1)} s; carried cooked_beef ${inv.cooked_beef ?? 0}, beef ${inv.beef ?? 0}; the furnace holds ${JSON.stringify(box.counts)}; ${b.logs.slice(l0).filter((x) => /cook: (the fuel|place|take)/.test(x)).slice(-3).join(' | ')}`);
    await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'air']);
    if (!BEFORE) {
      expect(end).toMatch(/^cook: no fuel .*\(cooked 1 cooked_beef first\)/);
      expect(inv.cooked_beef).toBe(1);
      expect(inv.beef).toBe(1);
      expect(box.total).toBe(0);
    }
  }, 240_000);

  it.runIf(want('mix'))('mix: the river run`s cook step (2 beef, 1 plank, 6 logs, a bread eaten at the furnace): both cooked', async () => {
    const b = bot!;
    await fresh(b);
    const fp = { x: area.x + 8, y: F, z: area.z };
    await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'furnace']);
    await loadKit(b, [
      ['beef', 2],
      ['oak_planks', 1],
      ['oak_log', 6],
      ['bread', 4],
    ]);
    await teleport(b, feet);
    // the food under 20, so the eat at the furnace eats (peaceful keeps the food bar full: easy until the eat is done)
    await craftCmd('difficulty', 'easy');
    await craftCmd('effect', b.name, 'hunger', '60', '255', 'true');
    await until(() => (b.built.mobility!.world.self.food <= 16 ? true : undefined), 60_000, 'the food under 17', 100);
    await craftCmd('effect', b.name, 'clear');
    const from = b.said.length;
    const l0 = b.logs.length;
    const t0 = Date.now();
    await b.command('!cook');
    // the eat as the walk ends (in Track E9's run the bread was taken 0.2 s before the furnace opened)
    await until(() => (b.logs.slice(l0).some((x) => /goto \{"type":"getToBlock".*: ok/.test(x)) ? true : undefined), 60_000, 'the walk to the furnace', 20);
    await b.command('!eat');
    const end = await b.reply((s) => s.startsWith('cooked') || s.startsWith('cook:'), from, 120_000).finally(() => craftCmd('difficulty', 'peaceful'));
    const s = (Date.now() - t0) / 1000;
    await sleep(1000);
    const inv = (await b.truth.craftinv(b.name)).counts;
    const box = await b.truth.box(fp);
    const ate = b.logs.slice(l0).filter((x) => x.includes('eat: bread')).map((x) => x.replace(/^.*eat: /, 'eat: '));
    const opened = b.logs.slice(l0).find((x) => x.includes('cook: opened'))?.replace(/^.*cook: /, 'cook: ') ?? '';
    note(`mix: ${end}; ${s.toFixed(1)} s; ${ate.join(' | ') || 'no eat'}; ${opened}; carried cooked_beef ${inv.cooked_beef ?? 0}, beef ${inv.beef ?? 0}, planks ${inv.oak_planks ?? 0}, logs ${inv.oak_log ?? 0}; the furnace holds ${JSON.stringify(box.counts)}`);
    await truthLoaded(b.truth, 'fill', [fp.x, fp.y, fp.z, fp.x, fp.y, fp.z, 'air']);
    if (!BEFORE) {
      expect(end).toMatch(/^cooked 2 cooked_beef /);
      expect(inv.cooked_beef).toBe(2);
      expect(ate.length).toBeGreaterThan(0);
    }
  }, 240_000);

  it.runIf(want('way'))('way: the walk out after a night with a zombie held still on the line to the mine (`morningWay`)', async () => {
    const b = bot!;
    const on = !WAY_OFF && !BEFORE;
    await fresh(b, 32);
    const shelter = { x: area.x - 6, y: F, z: area.z };
    const zom = { x: area.x + 9, y: F, z: area.z };
    const ores: { x: number; z: number }[] = [{ x: area.x + 3, z: area.z }];
    for (let i = 0; i < 7; i++) ores.push({ x: area.x + 24 + (i % 4), z: area.z - 1 + Math.floor(i / 4) });
    try {
      b.task.shelter!.set(shelter);
      b.settings.set('jobDusk', 'on');
      b.settings.set('jobMorning', 'off');
      if (!BEFORE) b.settings.set('morningWay', on ? 'on' : 'off');
      for (const o of ores) await truthLoaded(b.truth, 'fill', [o.x, F - 1, o.z, o.x, F - 1, o.z, 'iron_ore']);
      await loadKit(b, [['stone_pickaxe', 1], ['crafting_table', 1], ['cobblestone', 26], ['oak_planks', 8], ['coal', 2]]);
      await teleport(b, feet);
      await craftCmd('time', 'set', '11900');
      await sleep(300);
      const from = b.said.length;
      await b.command('!get iron_chestplate');
      await until(() => (b.processes.userProcesses().some((x) => x.name === 'mine') && b.built.mobility!.world.inventory.count('raw_iron') >= 1 ? true : undefined), 60_000, 'the mine step with its first ore', 50);
      await craftCmd('time', 'set', '12100');
      await b.reply((x) => x.includes('paused for the night'), from, 60_000);
      await until(() => (hdist(b.task.position()!, { x: shelter.x + 0.5, z: shelter.z + 0.5 }) < 1 ? true : undefined), 60_000, 'the bot at the shelter', 250);
      // the zombie on the straight line from the shelter to the far ores, held still and kept from burning
      await craftCmd('difficulty', 'easy');
      await craftCmd('summon', 'zombie', String(zom.x), String(F), String(zom.z));
      await craftCmd('effect', '@e[type=zombie]', 'slowness', '600', '255', 'true');
      await craftCmd('effect', '@e[type=zombie]', 'fire_resistance', '600', '0', 'true');
      await sleep(2500);
      const l0 = b.logs.length;
      await craftCmd('time', 'set', '1500');
      const dawn = await b.reply((x) => x.includes('dawn: going on'), from, 60_000);
      const t0 = Date.now();
      let min = Infinity;
      let passed = false;
      while (Date.now() - t0 < 60_000) {
        const me = b.task.position();
        const z = [...b.built.mobility!.world.entities.values()].find((e) => e.type === 'minecraft:zombie');
        if (me && z) min = Math.min(min, hdist(me, entityFeet(z)));
        if (me && me.x > area.x + 20) {
          passed = true;
          break;
        }
        await sleep(100);
      }
      const s = (Date.now() - t0) / 1000;
      const logs = b.logs.slice(l0);
      const way = logs.find((x) => x.includes('morning: the walk out keeps'))?.replace(/^.*morning: /, '') ?? 'no way-out line';
      const hurt = logs.filter((x) => /pve: took [\d.]+ damage/.test(x)).length;
      const flee = logs.filter((x) => /flee: .*running away/.test(x)).length;
      note(`way (${on ? 'on' : 'off'}): ${dawn}; ${way}; the walk ${passed ? `past the zombie in ${s.toFixed(1)} s` : `not past x+20 in ${s.toFixed(1)} s`}; nearest the zombie ${min.toFixed(1)} blocks; hurt ${hurt}, flights ${flee}`);
      if (!BEFORE && !WAY_OFF) {
        expect(way).toMatch(/^the walk out keeps 16 blocks from hostiles for 120 s \(near: zombie (14|15|16)\)$/);
        expect(passed).toBe(true);
        expect(min).toBeGreaterThan(10);
      }
    } finally {
      await b.command('!get stop');
      await craftCmd('kill', '@e[type=zombie]').catch(() => undefined);
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      for (const o of ores) await truthLoaded(b.truth, 'fill', [o.x, F - 1, o.z, o.x, F - 1, o.z, 'grass_block']).catch(() => undefined);
      if (!BEFORE) b.settings.set('morningWay', 'off');
      b.settings.set('jobDusk', 'on');
      await craftCmd('time', 'set', '6000');
    }
  }, 360_000);
});
