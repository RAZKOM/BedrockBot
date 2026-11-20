// e2e (tag @bds), Track E7 (docs/pve.md "A creeper in reach", ADR 0104): a creeper walking up to a bot that mines in a
// tunnel. On a fresh world the mine step of `!get kit iron` had a creeper (and a spider) come up to the bot by day; the
// reflex struck, the fuse burned out and the blast took the bot from 18 to 0. This case measures what the reflex's
// strikes do to a creeper by themselves, and the back-off rule tried against it (`creeperReach`, off).
//
// The case: on the flat world a stone block 21 x 5 x 4 with a tunnel one wide and two high along its middle, open at
// both ends; 16 iron ore in the tunnel's wall by its middle. The bot stands in the middle with the early kit (a stone
// pickaxe, a stone sword in the hotbar, cobblestone, bread), no armour, guard off, difficulty normal, and mines the ore
// (`!mine iron_ore 16`; with a wooden pickaxe, which harvests no ore, `!mine stone 16`). Once the mine step runs a
// creeper is summoned in the tunnel EARLY_CREEPER_AT blocks west of the bot. A run ends when the creeper is gone (dead or
// gone off), the bot died, or 45 s have passed.
//   EARLY_CREEPER_N       runs (default 1)
//   EARLY_CREEPER_RULE    off (the default, as shipped) | on: PveRules.creeperReach (the back-off), for the A/B
//   EARLY_CREEPER_AT      blocks west of the bot the creeper appears at (default 8: it walks in; 2: it is there at once
//                         and its fuse lights)
//   EARLY_CREEPER_SWORD   the sword in the hotbar (default stone_sword; none)
//   EARLY_CREEPER_PICK    the pickaxe (default stone_pickaxe: 5 strikes kill a creeper; wooden_pickaxe: 7, too weak to
//                         keep it off)
//   EARLY_CREEPER_END     open (the default) | dead: the tunnel's east end closed (nowhere to back off to)
//   EARLY_CREEPER_EXPECT  1 (the default) expects no death; 0 only records
//   EARLY_OUT             a file each run's line is appended to
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;
const N = Number(process.env.EARLY_CREEPER_N ?? 1);
const RULE = process.env.EARLY_CREEPER_RULE === 'on';
const AT = Number(process.env.EARLY_CREEPER_AT ?? 8);
const SWORD = process.env.EARLY_CREEPER_SWORD ?? 'stone_sword';
const PICK = process.env.EARLY_CREEPER_PICK ?? 'stone_pickaxe';
const DEAD_END = process.env.EARLY_CREEPER_END === 'dead';
const EXPECT = (process.env.EARLY_CREEPER_EXPECT ?? '1') !== '0';

function note(line: string): void {
  console.log(line);
  if (process.env.EARLY_OUT) appendFileSync(process.env.EARLY_OUT, `${line}\n`);
}

interface RunRow {
  run: number;
  rule: boolean;
  sword: string;
  pick: string;
  died: boolean;
  damage: number;
  lowest: number;
  /** Strikes the bot landed on the creeper (the server's record) and what they took. */
  strikes: number;
  creeperTook: number;
  /** The creeper went off (the bot took blast damage, or the creeper is gone with health left). */
  blast: boolean;
  blastDamage: number;
  creeperDead: boolean;
  flees: number;
  /** The fuse as the bot saw it: times it lit, and the longest it stayed lit (ticks). */
  lit: number;
  litMax: number;
  /** The nearest the creeper came to the bot's feet. */
  nearest: number;
  /** Ore mined when the run ended. */
  mined: number;
  seconds: number;
  end: string;
  causes: string;
}

describe.skipIf(!E2E)('@bds early creeper: a creeper walks up to a bot mining in a tunnel (Track E7)', () => {
  const area = privateArea();
  let bot: CraftBot | undefined;
  const rows: RunRow[] = [];

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyCrpr');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    b.task.home?.set(undefined);
    await craftCmd('gamerule', 'keepinventory', 'true');
    await craftCmd('gamerule', 'doimmediaterespawn', 'false');
    await craftCmd('gamerule', 'mobgriefing', 'false'); // the blast hurts as it does; the tunnel stays for the next run
    await craftCmd('time', 'set', 'noon');
    await teleport(b, { x: area.x + 0.5, y: F, z: area.z + 0.5 });
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await craftCmd('difficulty', 'peaceful').catch(() => undefined);
      await craftCmd('gamerule', 'mobgriefing', 'true').catch(() => undefined);
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await craftCmd('kill', '@e[type=item]').catch(() => undefined);
      await clearArea(bot.truth, { x: area.x, z: area.z }, 14, 6).catch(() => undefined);
      await bot.stop();
    }
    if (process.env.EARLY_LOG && bot) appendFileSync(process.env.EARLY_LOG, `${bot.logs.join('\n')}\n`);
    note(`[early-creeper e2e] area cell ${area.cell}; rule ${RULE ? 'on' : 'off'}, ${PICK}, ${SWORD}, from ${AT}, ${DEAD_END ? 'dead end' : 'open'}: ${rows.length} runs, ${rows.filter((r) => r.died).length} deaths, damage ${rows.map((r) => r.damage).join(' ')}, strikes ${rows.map((r) => r.strikes).join(' ')}, fuse lit at most ${rows.map((r) => r.litMax).join(' ')} ticks, flights ${rows.map((r) => r.flees).join(' ')}, blasts ${rows.filter((r) => r.blast).length}, creepers killed ${rows.filter((r) => r.creeperDead).length}`);
  }, 120_000);

  it(`${N} run(s): a creeper from ${AT} west, creeperReach ${RULE ? 'on' : 'off'}, ${SWORD}`, async () => {
    const b = bot!;
    const pve = b.task.pve!;
    pve.rules.creeperReach = RULE;
    pve.setGuard({ on: false });
    const x = area.x;
    const z = area.z;
    for (let run = 1; run <= N; run++) {
      await craftCmd('difficulty', 'peaceful');
      await b.truth.cleanup().catch(() => undefined);
      await clearArea(b.truth, { x, z }, 14, 6);
      await craftCmd('kill', '@e[type=item]');
      // the stone block, the tunnel along x through its middle, the ore in the south wall by the middle
      await craftCmd('fill', String(x - 10), String(F), String(z - 2), String(x + 10), String(F + 3), String(z + 2), 'stone');
      await craftCmd('fill', String(x - 10), String(F), String(z), String(x + (DEAD_END ? 3 : 10)), String(F + 1), String(z), 'air');
      await craftCmd('fill', String(x - 1), String(F), String(z + 1), String(x + 2), String(F + 1), String(z + 2), 'iron_ore');
      await teleport(b, { x: x + 0.5, y: F, z: z + 0.5 });
      const kit: [string, number][] = [[PICK, 1], ['cobblestone', 32], ['bread', 8]];
      if (SWORD !== 'none') kit.splice(1, 0, [SWORD, 1]);
      await loadKit(b, kit);
      await b.truth.setHealth(b.name, 20);
      await b.truth.ok('setfood', [b.name, 20, 5]).catch(() => undefined);
      await sleep(1000);
      await craftCmd('difficulty', 'normal');
      const from = b.logs.length;
      const flees0 = pve.stats.flees;
      const since = await b.truth.now();
      await b.command(PICK === 'wooden_pickaxe' ? '!mine stone 16' : '!mine iron_ore 16');
      await until(() => (b.processes.userProcesses().some((p) => p.name === 'mine') ? true : undefined), 15_000, 'the mine step', 100);
      await sleep(1500);
      const t0 = Date.now();
      const creeper = (await b.truth.summon('creeper', { x: x - AT + 0.5, y: F, z: z + 0.5 })).entityId;
      let lowest = 20;
      let end = 'timeout';
      let last = 20;
      let lit = 0;
      let litMax = 0;
      let wasLit = false;
      let nearest = 99;
      const world = b.built.mobility!.world;
      while (Date.now() - t0 < 45_000) {
        await sleep(50);
        lowest = Math.min(lowest, pve.health());
        const me = b.task.position();
        for (const e of world.entities.values()) {
          if (!e.type.endsWith('creeper')) continue;
          const t = pve.mobs.ticksLit(e.runtimeId);
          if (t > 0 && !wasLit) lit++;
          wasLit = t > 0;
          litMax = Math.max(litMax, t);
          if (me) nearest = Math.min(nearest, Math.hypot(e.pos.x - me.x, e.pos.y - me.y, e.pos.z - me.z));
        }
        if (b.logs.slice(from).some((l) => l.includes('died (death'))) {
          end = 'died';
          break;
        }
        if ((Date.now() - t0) % 500 < 60) {
          try {
            const m = await b.truth.entity(creeper);
            if (m.valid === false || (m.health ?? 0) <= 0) {
              end = 'creeper gone';
              break;
            }
            last = m.health ?? last;
          } catch {
            end = 'creeper gone';
            break;
          }
        }
      }
      const seconds = (Date.now() - t0) / 1000;
      await sleep(1500);
      const all = (await b.truth.hurtlog(since, '*')).events;
      const hurt = all.filter((e) => e.victimName === b.name);
      const onCreeper = all.filter((e) => e.victimId === creeper);
      const byBot = onCreeper.filter((e) => e.damagerName === b.name);
      const blasts = hurt.filter((e) => /explosion/i.test(e.cause));
      const creeperTook = onCreeper.reduce((a, e) => a + e.damage, 0);
      const mined = b.built.mobility!.world.inventory.count('raw_iron') + (PICK === 'wooden_pickaxe' ? b.built.mobility!.world.inventory.count('cobblestone') - 32 : 0);
      await craftCmd('difficulty', 'peaceful');
      const row: RunRow = {
        run,
        rule: RULE,
        sword: SWORD,
        pick: PICK,
        died: end === 'died',
        damage: Math.round(hurt.reduce((a, e) => a + e.damage, 0) * 10) / 10,
        lowest: Math.round(lowest * 10) / 10,
        strikes: byBot.length,
        creeperTook: Math.round(creeperTook * 10) / 10,
        blast: blasts.length > 0 || (end === 'creeper gone' && creeperTook < 19.5),
        blastDamage: Math.round(blasts.reduce((a, e) => a + e.damage, 0) * 10) / 10,
        creeperDead: end === 'creeper gone' && creeperTook >= 19.5,
        flees: pve.stats.flees - flees0,
        lit,
        litMax: Math.round(litMax),
        nearest: Math.round(nearest * 10) / 10,
        mined,
        seconds: Math.round(seconds * 10) / 10,
        end,
        causes: hurt.map((e) => `${e.cause}${e.damagerType ? `:${e.damagerType.replace(/^minecraft:/, '')}` : ''} ${Math.round(e.damage * 10) / 10}`).join(', '),
      };
      void last;
      rows.push(row);
      const lines = b.logs.slice(from).filter((l) => /reflex|flee|combat:|died|creeper/.test(l)).slice(0, 14);
      note(`[early-creeper] ${JSON.stringify(row)}\n    ${lines.join('\n    ')}`);
      if (end === 'died') {
        await until(() => (b.task.position() && pve.health() > 0 ? true : undefined), 30_000, 'the respawn', 500).catch(() => undefined);
        await sleep(2000);
      }
      await b.command('!stop');
      await sleep(1000);
    }
    if (EXPECT) expect(rows.filter((r) => r.died)).toEqual([]);
  }, 30_000 + N * 120_000);
});
