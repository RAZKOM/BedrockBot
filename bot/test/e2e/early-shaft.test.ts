// e2e (tag @bds), Track E3 (docs/early-game.md "A mob at the top of a shaft", ADR 0100): a bot pillaring up a one-wide
// shaft with a zombie in the shaft over it. On a fresh world (Track E2's run 10) the mine step's walk pillared up a shaft
// of its own digging, a zombie came down it, and the bot died 20 to 0 in 6 s: the reflex struck it 14 times with the
// cobblestone the pillar holds (1 a strike, the zombie has 20), guard was off, and the flight at 6 health found no way
// out of the shaft.
//
// The case: a 5 x 5 obsidian block 10 high on the flat world, a one-wide shaft down its middle open to the sky, the bot at
// its bottom with the early kit (a stone sword, a stone pickaxe, cobblestone), difficulty normal for the case, `!goto` to
// the top of the block. Once the bot's feet are 2 up the shaft a zombie is summoned 6 over them in the shaft: it falls
// onto the bot. A run ends when the bot is on the top, dead, or 60 s have passed.
//   EARLY_SHAFT_N        runs a case (default 1)
//   EARLY_SHAFT_SWAP     on (the default) | off: the reflex's blade strike (PveRules.bladeStrike) for an A/B
//   EARLY_SHAFT_GUARD    off (the default, as an early bot) | on: guard on (radius 16, as the live bot)
//   EARLY_SHAFT_MOB      zombie (default) | skeleton | husk
//   EARLY_SHAFT_AT       shaft (default: summoned EARLY_SHAFT_DY (6) over the feet in the shaft once they are 2 up) |
//                        rim (on the block's top next to the opening, at the start)
//   EARLY_SHAFT_HEIGHT   the block's height (default 10)
//   EARLY_SHAFT_WALL     the block's material (default obsidian: no way out but up, as with the body kept in the air
//                        by the hits on the fresh world, where the walk never planned the dig out; stone: the walk
//                        digs round the zombie with the pickaxe, which kills it with the old code too)
//   EARLY_SHAFT_EXPECT   1 (the default) expects the bot alive at the end; 0 only records
//   EARLY_OUT            a file each run's line is appended to
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const N = Number(process.env.EARLY_SHAFT_N ?? 1);
const SWAP = (process.env.EARLY_SHAFT_SWAP ?? 'on') !== 'off';
const GUARD = process.env.EARLY_SHAFT_GUARD === 'on';
const MOB = process.env.EARLY_SHAFT_MOB ?? 'zombie';
const EXPECT = (process.env.EARLY_SHAFT_EXPECT ?? '1') !== '0';
const HEIGHT = Number(process.env.EARLY_SHAFT_HEIGHT ?? 10);
const AT = process.env.EARLY_SHAFT_AT ?? 'shaft';
const DY = Number(process.env.EARLY_SHAFT_DY ?? 6);
const WALL = process.env.EARLY_SHAFT_WALL ?? 'obsidian';

function note(line: string): void {
  console.log(line);
  if (process.env.EARLY_OUT) appendFileSync(process.env.EARLY_OUT, `${line}\n`);
}

interface RunRow {
  run: number;
  swap: boolean;
  guard: boolean;
  mob: string;
  died: boolean;
  top: boolean;
  mobDead: boolean;
  damage: number;
  lowest: number;
  hits: number;
  reflex: number;
  seconds: number;
  flees: number;
  end: string;
  causes: string;
  mobTook: number;
  mobCauses: string;
}

describe.skipIf(!E2E)('@bds early shaft: a mob over a bot pillaring up a one-wide shaft (Track E3)', () => {
  const area = privateArea();
  let bot: CraftBot | undefined;
  const rows: RunRow[] = [];

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyShft');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.settings.set('allowPlace', 'on'); // the walk pillars (the mine step's walks plan with it on)
    await craftCmd('gamerule', 'keepinventory', 'true');
    await craftCmd('gamerule', 'doimmediaterespawn', 'false');
    await craftCmd('time', 'set', 'midnight'); // no burning zombie
    await teleport(b, { x: area.x + 0.5, y: F, z: area.z + 0.5 });
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await craftCmd('time', 'set', 'noon').catch(() => undefined);
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 6, HEIGHT + 4).catch(() => undefined);
      await bot.stop();
    }
    if (process.env.EARLY_LOG && bot) appendFileSync(process.env.EARLY_LOG, `${bot.logs.join('\n')}\n`);
    const died = rows.filter((r) => r.died).length;
    note(`[early-shaft e2e] area cell ${area.cell}; ${rows.length} runs, ${died} deaths, damage ${rows.map((r) => r.damage).join(' ')}, top ${rows.filter((r) => r.top).length}`);
  }, 120_000);

  it(`${N} run(s): ${MOB} in the shaft, swap ${SWAP ? 'on' : 'off'}, guard ${GUARD ? 'on' : 'off'}`, async () => {
    const b = bot!;
    const pve = b.task.pve!;
    pve.rules.bladeStrike = SWAP;
    pve.setGuard(GUARD ? { on: true, radius: 16 } : { on: false });
    for (let run = 1; run <= N; run++) {
      // a fresh block each run (the last run's pillar and drops gone)
      const x = area.x + (run % 2 === 0 ? 12 : 0);
      const z = area.z;
      await craftCmd('difficulty', 'peaceful');
      await b.truth.cleanup().catch(() => undefined);
      await clearArea(b.truth, { x, z }, 5, HEIGHT + 4);
      await craftCmd('kill', '@e[type=item]');
      await craftCmd('fill', String(x - 2), String(F), String(z - 2), String(x + 2), String(F + HEIGHT - 1), String(z + 2), WALL);
      await craftCmd('fill', String(x), String(F), String(z), String(x), String(F + HEIGHT - 1), String(z), 'air');
      await teleport(b, { x: x + 0.5, y: F, z: z + 0.5 });
      // the kit: the sword in the hotbar but not held (the mine step holds the pickaxe, the pillar the cobblestone)
      await loadKit(b, [['stone_pickaxe', 1], ['stone_sword', 1], ['cobblestone', 32], ['bread', 8]]);
      await b.truth.setHealth(b.name, 20);
      await b.truth.ok('setfood', [b.name, 20, 5]).catch(() => undefined);
      await sleep(1000);
      await craftCmd('difficulty', 'normal');
      const from = b.logs.length;
      const flees0 = pve.stats.flees;
      const reflex0 = pve.reflex.totals.hits;
      const since = await b.truth.now();
      const t0 = Date.now();
      let summoned: string | undefined;
      if (AT === 'rim') summoned = (await b.truth.summon(MOB, { x: x + 1.5, y: F + HEIGHT, z: z + 0.5 })).entityId;
      await b.command(`!goto ${x + 2} ${F + HEIGHT} ${z}`);
      let lowest = 20;
      let end = 'timeout';
      while (Date.now() - t0 < 60_000) {
        await sleep(100);
        const p = b.task.position();
        lowest = Math.min(lowest, pve.health());
        if (b.logs.slice(from).some((l) => l.includes('died (death'))) {
          end = 'died';
          break;
        }
        if (!summoned && p && p.y >= F + 2) {
          const m = await b.truth.summon(MOB, { x: x + 0.5, y: Math.min(F + HEIGHT - 1, Math.floor(p.y) + DY), z: z + 0.5 });
          summoned = m.entityId;
        }
        if (p && p.y >= F + HEIGHT - 0.1 && Math.hypot(p.x - (x + 2.5), p.z - (z + 0.5)) < 1.6) {
          end = 'top';
          break;
        }
        if (!summoned && Date.now() - t0 > 30_000) {
          end = 'never climbed';
          break;
        }
      }
      const seconds = (Date.now() - t0) / 1000;
      await sleep(1500);
      const all = (await b.truth.hurtlog(since, '*')).events;
      const hurt = all.filter((e) => e.victimName === b.name);
      const mobTook = all.filter((e) => e.victimId === summoned).reduce((a, e) => a + e.damage, 0);
      const causes = hurt.map((e) => `${e.cause}${e.damagerType ? `:${e.damagerType.replace(/^minecraft:/, '')}` : ''} ${e.damage}`).join(', ');
      const damage = hurt.reduce((a, e) => a + e.damage, 0);
      let mobDead = true;
      if (summoned) {
        try {
          const m = await b.truth.entity(summoned);
          mobDead = m.valid === false || (m.health ?? 0) <= 0;
        } catch {
          mobDead = true;
        }
      }
      await craftCmd('difficulty', 'peaceful');
      const row: RunRow = {
        run,
        swap: SWAP,
        guard: GUARD,
        mob: MOB,
        died: end === 'died',
        top: end === 'top',
        mobDead,
        damage: Math.round(damage * 10) / 10,
        lowest: Math.round(lowest * 10) / 10,
        hits: hurt.length,
        reflex: pve.reflex.totals.hits - reflex0,
        seconds: Math.round(seconds * 10) / 10,
        flees: pve.stats.flees - flees0,
        end,
        causes,
        mobTook: Math.round(mobTook * 10) / 10,
        mobCauses: all.filter((e) => e.victimId === summoned).map((e) => `${e.cause}${e.damagerName ? `:${e.damagerName === b.name ? 'bot' : e.damagerName}` : ''} ${Math.round(e.damage * 10) / 10}`).join(', '),
      };
      rows.push(row);
      const lines = b.logs.slice(from).filter((l) => /reflex|flee|combat:|died|fight/.test(l)).slice(0, 12);
      note(`[early-shaft] ${JSON.stringify(row)}\n    ${lines.join('\n    ')}`);
      if (end === 'died') {
        await until(() => (b.task.position() && pve.health() > 0 ? true : undefined), 30_000, 'the respawn', 500).catch(() => undefined);
        await sleep(2000);
      }
      await b.command('!stop');
      await sleep(1000);
    }
    if (EXPECT) {
      expect(rows.filter((r) => r.died)).toEqual([]);
      expect(rows.every((r) => r.top)).toBe(true);
    }
  }, 30_000 + N * 120_000);
});
