// e2e (tag @bds), Track E3 (docs/early-game.md "The furnace wait", ADR 0100): a smelt by night with hostiles coming, no
// home or shelter. On a fresh world (Track E2) the bot died at its furnace at dusk 186 s into a 33-item smelt (arrows, a
// witch's poison, a creeper; the flight ran at 1 health).
//
// The case: the flat world, a furnace next to the bot, 8 raw iron, 1 coal, 32 cobblestone, a stone sword and bread;
// difficulty normal, the daylight cycle on from 21000 (dawn at 23000); `!smelt`; 3 s later two zombies and a skeleton
// are summoned 9 to 11 blocks off. A run ends with the smelt's end line, a death, or 300 s.
//   EARLY_SMELT_N      runs (default 1)
//   EARLY_SMELT_SHELL  on (the default) | off: the smeltShell setting, for an A/B; leave: smeltShell off, a shelter
//                      and home 10 blocks off with nightShell on; the smelt starts at 11500 (the furnace loaded by
//                      day), the night rule takes the bot to the shelter at dusk, the clock then goes to 21000 and the
//                      mobs come as in the other modes; the furnace smelts on and the smelt resumes after dawn
//   EARLY_SMELT_EXPECT 1 (the default with the shell on) asserts no death, 8 ingots and the shell opened; 0 only records
//   EARLY_OUT          a file each run's line is appended to
//   EARLY_LOGS         a file each run's whole bot log is appended to
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const N = Number(process.env.EARLY_SMELT_N ?? 1);
const MODE = process.env.EARLY_SMELT_SHELL ?? 'on';
const SHELL = MODE === 'on';
const LEAVE = MODE === 'leave';
const EXPECT = (process.env.EARLY_SMELT_EXPECT ?? (SHELL ? '1' : '0')) !== '0';
const ITEMS = 8;

function note(line: string): void {
  console.log(line);
  if (process.env.EARLY_OUT) appendFileSync(process.env.EARLY_OUT, `${line}\n`);
}

describe.skipIf(!E2E)('@bds early smelt: a smelt by night with hostiles near (Track E3)', () => {
  const area = privateArea();
  let bot: CraftBot | undefined;
  const rows: { died: boolean; ingots: number; shell: boolean; opened: boolean; end: string }[] = [];

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlySmlt');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.settings.set('smeltShell', SHELL ? 'on' : 'off');
    b.settings.set('nightShell', LEAVE ? 'on' : 'off');
    await craftCmd('gamerule', 'keepinventory', 'true');
    await craftCmd('gamerule', 'doimmediaterespawn', 'false');
    await teleport(b, { x: area.x + 0.5, y: F, z: area.z + 0.5 });
  }, 180_000);

  afterAll(async () => {
    await craftCmd('difficulty', 'peaceful').catch(() => undefined);
    await craftCmd('gamerule', 'dodaylightcycle', 'false').catch(() => undefined);
    await craftCmd('time', 'set', 'noon').catch(() => undefined);
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await bot.stop();
    }
    note(`[early-smelt e2e] area cell ${area.cell}; mode ${MODE}; ${rows.length} runs, ${rows.filter((r) => r.died).length} deaths, ingots ${rows.map((r) => r.ingots).join(' ')}`);
  }, 120_000);

  it(`${N} run(s), mode ${MODE}`, async () => {
    const b = bot!;
    const pve = b.task.pve!;
    for (let run = 1; run <= N; run++) {
      const x = area.x + (run % 2 === 0 ? 20 : 0);
      const z = area.z;
      await craftCmd('difficulty', 'peaceful');
      await craftCmd('gamerule', 'dodaylightcycle', 'false');
      await b.truth.cleanup().catch(() => undefined);
      await teleport(b, { x: x + 0.5, y: F, z: z + 0.5 });
      await clearArea(b.truth, { x, z }, LEAVE ? 24 : 14, 6);
      if (LEAVE) {
        // what `!shelter set` and `!home set` set where the owner stands, 10 blocks off (the cooker looks within 16 of home)
        b.task.shelter!.set({ x, y: F, z: z - 10 });
        b.task.home!.set({ x, y: F, z: z - 10 });
      } else {
        b.task.shelter?.set(undefined);
        b.task.home?.set(undefined);
      }
      await craftCmd('kill', '@e[type=item]');
      await craftCmd('setblock', String(x + 1), String(F), String(z), 'furnace');
      await loadKit(b, [['raw_iron', ITEMS], ['coal', 1], ['cobblestone', 32], ['stone_sword', 1], ['bread', 8]]);
      await b.truth.setHealth(b.name, 20);
      await b.truth.ok('setfood', [b.name, 20, 5]).catch(() => undefined);
      await craftCmd('time', 'set', LEAVE ? '11500' : '21000');
      await craftCmd('gamerule', 'dodaylightcycle', 'true');
      await craftCmd('difficulty', 'normal');
      const from = b.logs.length;
      const said0 = b.said.length;
      const since = await b.truth.now();
      const t0 = Date.now();
      await b.command('!smelt');
      if (LEAVE) {
        // the furnace loaded by day, then dusk: the night rule walks to the shelter and walls in; then the night's end
        await until(() => (b.logs.slice(from).some((l) => /night shell: (walled in|\d+ cell)/.test(l)) ? true : undefined), 90_000, 'the night shell at the shelter', 500).catch(() => undefined);
        await craftCmd('time', 'set', '21000');
      }
      await sleep(3000);
      const mobs = [
        await b.truth.summon('zombie', { x: x + 10.5, y: F, z: z + 0.5 }),
        await b.truth.summon('zombie', { x: x + 0.5, y: F, z: z + 9.5 }),
        await b.truth.summon('skeleton', { x: x - 10.5, y: F, z: z + 0.5 }),
      ];
      let end = 'timeout';
      let lowest = 20;
      while (Date.now() - t0 < 300_000) {
        await sleep(250);
        lowest = Math.min(lowest, pve.health());
        if (b.logs.slice(from).some((l) => l.includes('died (death'))) {
          end = 'died';
          break;
        }
        const r = b.said.slice(said0).find((s) => /^smelted |^smelt: (?!.*setting a furnace)/.test(s) && !s.startsWith("smelting "));
        if (r) {
          end = r;
          break;
        }
      }
      const seconds = (Date.now() - t0) / 1000;
      await sleep(1000);
      const hurt = (await b.truth.hurtlog(since, '*')).events.filter((e) => e.victimName === b.name);
      const damage = Math.round(hurt.reduce((a, e) => a + e.damage, 0) * 10) / 10;
      const inv = (await b.truth.craftinv(b.name)).counts;
      const logs = b.logs.slice(from);
      const row = {
        run,
        mode: MODE,
        died: end === 'died',
        damage,
        lowest: Math.round(lowest * 10) / 10,
        hits: hurt.length,
        causes: [...new Set(hurt.map((e) => `${e.cause}${e.damagerType ? `:${e.damagerType.replace(/^minecraft:/, '')}` : ''}`))].join(' '),
        ingots: inv.iron_ingot ?? 0,
        closed: logs.some((l) => l.includes('smelt shell: closed')),
        nightShell: logs.some((l) => /night shell: (closed|sealed|walled)/.test(l)),
        opened: logs.some((l) => l.includes('smelt shell: opened')),
        flees: logs.filter((l) => /flee: (health|recovering)/.test(l)).length,
        seconds: Math.round(seconds * 10) / 10,
        end: end.slice(0, 140),
      };
      if (process.env.EARLY_LOGS) appendFileSync(process.env.EARLY_LOGS, `== run ${run} (${MODE})\n${logs.join('\n')}\n`);
      rows.push({ died: row.died, ingots: row.ingots, shell: row.closed, opened: row.opened, end });
      note(`[early-smelt] ${JSON.stringify(row)}\n    ${logs.filter((l) => /smelt shell|night shell|flee|died|reflex.*down|smelt: resum/.test(l)).slice(0, 10).join('\n    ')}`);
      void mobs;
      await craftCmd('difficulty', 'peaceful');
      await craftCmd('gamerule', 'dodaylightcycle', 'false');
      if (end === 'died') await until(() => (b.task.position() && pve.health() > 0 ? true : undefined), 30_000, 'the respawn', 500).catch(() => undefined);
      await b.command('!stop');
      await sleep(1500);
    }
    if (EXPECT) {
      expect(rows.filter((r) => r.died)).toEqual([]);
      expect(rows.every((r) => r.ingots === ITEMS && (LEAVE || (r.shell && r.opened)))).toBe(true);
    }
  }, 60_000 + N * 300_000);
});
