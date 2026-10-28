// A mine job pre-empted by a guard fight must resume and finish (Realm 2026-10-30, `!get sand 8640`:
// the guard paused the job during its pre-target drop sweep, the sweep resolved `interrupted`, the
// job ended silently with 'paused' and the guard's "no user process left" rule walked the bot 1500
// blocks home). On bds-gaunt (flat world, normal difficulty, midnight, no natural spawns): 12 patches
// of 2 x 2 sand let into the grass (each its own vein, so the loop's drop sweep runs between them), the
// afk task with guard on (r 16) and a home point 90 blocks away; the owner says `!mine sand 32`. Once 8
// are mined, at the end of a vein's collect three sand blocks near the bot are broken by the console
// (sand items on the floor), and when the job's next drop sweep (collect r=8, no grace, no origin)
// starts a zombie is summoned next to the bot: the guard fight pre-empts the sweep. The job must
// resume and end `done` with 32 mined, no home return in between. Twice, each on fresh patches. Needs
// BDS_E2E=1 and bds-gaunt with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CollectOptions } from '../../src/skills/collect/collect.ts';
import type { MineProcess } from '../../src/tasks/process/mine.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { centre, connectPlayer, E2E, FEET_Y, fill, gauntCmd, hdist, prepareServer, privateArea, saidSince, sleep, startGauntBot, teleport, uniqueName, until, type GauntBot } from './gaunt-truth.ts';

const RUNS = Number(process.env.GAUNT_RUNS ?? 2);
const COUNT = 32;
const GROUND = FEET_Y - 1; // grass top

describe.skipIf(!E2E)('gaunt: a mine job survives a guard fight (Realm 2026-10-30)', () => {
  let bot: GauntBot | undefined;
  let player: Awaited<ReturnType<typeof connectPlayer>> | undefined;
  const playerName = uniqueName('GmOwner');
  const area = privateArea();
  const home: Vec3 = { x: area.x - 90, y: FEET_Y, z: area.z }; // beyond protectRadius (48) of the patches
  const lines: string[] = [];

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startGauntBot('GtMine', { home }, { owners: [playerName], values: { guard: '16' } });
    await teleport(bot, centre({ x: area.x, y: FEET_Y, z: area.z - 60 }));
    await bot.truth.clearAround(centre({ x: area.x, y: FEET_Y, z: area.z }), 80);
    player = await connectPlayer(playerName);
    await bot.truth.tp(playerName, centre({ x: area.x + 60, y: FEET_Y, z: area.z + 60 }), 0, 0);
  }, 120_000);

  afterAll(async () => {
    await player?.close().catch(() => undefined);
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre({ x: area.x, y: FEET_Y, z: area.z }), 80).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${lines.join('\n  ')}`);
  });

  async function kit(b: GauntBot): Promise<void> {
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('unequip', [b.name]);
    await b.truth.give(b.name, 'iron_sword', 1);
    await b.truth.give(b.name, 'iron_shovel', 1);
    for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await b.truth.give(b.name, piece, 1);
    const inv = b.built.mobility!.world.inventory;
    await until(() => (inv.window(120)?.slots.filter(Boolean).length === 4 && inv.slots.some((s) => s?.name === 'iron_shovel') ? true : undefined), 20_000, 'armour worn, shovel in the inventory');
    await b.truth.setHealth(b.name, 20);
    await b.truth.setFood(b.name, 20, 5);
  }

  for (let run = 0; run < RUNS; run++) {
    it(`run ${run + 1}/${RUNS}: !mine sand ${COUNT}, a zombie during a drop sweep, the job resumes and ends done`, async () => {
      const b = bot!;
      const p = player!;
      const c = { x: area.x, z: area.z - 20 + run * 40 };
      await b.truth.clearAround(centre({ x: c.x, y: FEET_Y, z: c.z }), 20);
      // 4 x 3 patches of 2 x 2 sand in place of the grass, 2 blocks of grass between them: every patch is
      // its own vein, so the loop's drop sweep runs between them (one layer: nothing falls)
      const sand: Vec3[] = [];
      for (const gx of [-7, -3, 1, 5])
        for (const gz of [-5, -1, 3]) {
          await fill(b, { x: c.x + gx, y: GROUND, z: c.z + gz }, { x: c.x + gx + 1, y: GROUND, z: c.z + gz + 1 }, 'sand');
          for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) sand.push({ x: c.x + gx + dx, y: GROUND, z: c.z + gz + dz });
        }
      await teleport(b, centre({ x: c.x - 9, y: FEET_Y, z: c.z }));
      await kit(b);
      const skills = b.built.mobility!.skills;
      const collect0 = skills.collect.bind(skills);
      const stats0 = { ...b.pve.stats };
      let mp: MineProcess | undefined;
      let stage: 'wait' | 'dropping' | 'armed' | 'summoned' = 'wait';
      let zombieAt: number | undefined;
      let destroyed = 0;
      let homeSeen = false;
      // three sand blocks near the bot broken by the console (sand items on the floor for the next sweep)
      const dropSand = async (): Promise<void> => {
        const me = b.pve.position();
        for (const q of sand) {
          if (destroyed >= 3) break;
          const d = hdist(me, { x: q.x + 0.5, z: q.z + 0.5 });
          if (d < 2 || d > 6) continue;
          if ((await b.truth.ok<{ typeId: string }>('block', [q.x, q.y, q.z])).typeId !== 'minecraft:sand') continue;
          await gauntCmd('setblock', String(q.x), String(q.y), String(q.z), 'air', 'destroy');
          destroyed++;
        }
      };
      // after 8 mined, at the end of a vein's own collect (it has an origin): drops on the floor; at the
      // loop's next drop sweep (sweepItems: graceTicks 0, a filter, no origin) a zombie next to the bot
      skills.collect = async (radius: number, ticks: number, opts?: CollectOptions) => {
        if (stage === 'armed' && opts?.graceTicks === 0 && opts.filter && !opts.origin) {
          stage = 'summoned';
          zombieAt = Date.now();
          const me = b.pve.position();
          void b.truth.summon('zombie', { x: me.x + 3, y: FEET_Y, z: me.z + 0.5 }).catch(() => undefined);
        }
        const r = await collect0(radius, ticks, opts);
        if (stage === 'wait' && opts?.origin && (mp?.task.stats.mined ?? 0) >= 8) {
          stage = 'dropping';
          await dropSand();
          await sleep(800); // the item entities reach the bot
          stage = 'armed';
        }
        return r;
      };
      const n0 = b.said.length;
      const t0 = Date.now();
      try {
        p.say(`!mine sand ${COUNT}`);
        mp = await until(() => b.task.processes?.find('mine')[0] as MineProcess | undefined, 10_000, 'the mine process');
        const job = mp;
        let result: string | undefined;
        void job.result.then((s) => (result = s));
        while (result === undefined && Date.now() - t0 < 240_000) {
          if (b.task.processes?.find('home').length) homeSeen = true;
          await sleep(200);
        }
        const st = b.pve.stats;
        const fights = st.guardTriggers - stats0.guardTriggers;
        const inv = b.built.mobility!.world.inventory.slots.reduce((a, s) => a + (s?.name === 'sand' ? s.count : 0), 0);
        const end = await until(() => saidSince(b, n0, 'mine sand'), 5_000, 'the end line').catch(() => undefined);
        const line =
          `run ${run + 1}: ${result ?? 'no end in 240 s'} after ${((Date.now() - t0) / 1000).toFixed(1)} s; mined ${job.task.stats.mined}/${COUNT}, sand in the inventory ${inv}; ` +
          `${destroyed} broken by the console, zombie summoned ${zombieAt ? `${((zombieAt - t0) / 1000).toFixed(1)} s in (at a drop sweep)` : 'never'}; guard fights ${fights}, kills ${st.kills - stats0.kills}; ` +
          `home return ${homeSeen ? 'STARTED' : 'none'}; end line ${JSON.stringify(end)}`;
        console.log(line);
        lines.push(line);
        expect(zombieAt).toBeDefined();
        expect(fights).toBeGreaterThan(0);
        expect(homeSeen).toBe(false);
        expect(result).toBe('done');
        expect(job.task.stats.mined).toBeGreaterThanOrEqual(COUNT);
        expect(end).toMatch(/done/);
      } finally {
        skills.collect = collect0;
        if (mp && !mp.done) b.task.processes?.stop(mp, 'stopped');
        await b.truth.cleanup().catch(() => undefined);
      }
    }, 300_000);
  }
});
