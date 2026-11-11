// Track M2 (docs/pve.md "Track M2"): the elytra flee (setting `fleeFly`, tasks/pve.ts FleeProcess.flyNow: `!fly home` as the
// owner's command through the flight skill's own entry point) on a test server for the first time. On bds-gaunt (flat world,
// midnight, no natural spawns): the bot bare-handed with the flight kit (an elytra in the inventory, 64 rockets in the
// hotbar, 8 bread), health FLEEFLY_HEALTH (default 10), guard on (radius 16), `fleeFly` on, home FLEEFLY_HOME blocks east
// (default 200) in the open; it stands in a pen of stone 3 high (5 x 5 inside, open to the sky) with FLEEFLY_ZOMBIES (4)
// zombies in it round it, so running fails (cornered or caught) and the floors come to the elytra flee. Per run (60 s): the
// floors, when the flee was asked for, the first gliding tick, the highest point, where it came down and how far from home,
// the damage before the takeoff and after, a death, the bot's chat lines about the flight. Measures only: asserts that the
// runs ran. One line per run and one JSON line per run to MOBS_OUT. The flight code is not changed by this track.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { Vec3 } from '../../src/connection/types.ts';
import { centre, E2E, FEET_Y, fill, gauntCmd, prepareServer, privateArea, sleep, startGauntBot, teleport, uniqueName, until, type GauntBot } from './gaunt-truth.ts';

const RUNS = Number(process.env.FLEEFLY_RUNS ?? 3);
const SECONDS = Number(process.env.FLEEFLY_SECONDS ?? 60);
const HEALTH = Number(process.env.FLEEFLY_HEALTH ?? 10);
const HOME = Number(process.env.FLEEFLY_HOME ?? 200);
const ZOMBIES = Number(process.env.FLEEFLY_ZOMBIES ?? 4);
const OPEN = process.env.FLEEFLY_OPEN === '1'; // no pen: the crowd in the open (running fails by being caught)
const OUT = process.env.MOBS_OUT;
const LABEL = process.env.MOBS_LABEL ?? 'fleefly';
const r1 = (v: number): number => Math.round(v * 10) / 10;

describe.skipIf(!E2E)('gaunt: the elytra flee (Track M2)', () => {
  let bot: GauntBot | undefined;
  const ownerName = uniqueName('GffOwner');
  const area = privateArea();
  const lines: string[] = [];

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startGauntBot('GtFfly', {}, { owners: [ownerName], values: { guard: '16' } });
    bot.pve.settings.set('fleeFly', true);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
    console.log(`elytra flee:\n  ${lines.join('\n  ')}`);
  });

  it(`${RUNS} runs cornered by ${ZOMBIES} zombies at health ${HEALTH}`, async () => {
    const b = bot!;
    const t = b.truth as unknown as { ok<T>(n: string, a: (string | number)[]): Promise<T> } & GauntBot['truth'];
    for (let run = 1; run <= RUNS; run++) {
      const at = { x: area.x - 800 + 400 * (run - 1), y: FEET_Y, z: area.z - 800 };
      const c = centre(at);
      await teleport(b, c);
      // the flat world's own ground lies between here and home (a fill that far out hits unloaded chunks); only the spot is made
      const fillR = async (a: Vec3, z: Vec3, block: string): Promise<void> => {
        for (let i = 0; ; i++) {
          try {
            await fill(b, a, z, block);
            return;
          } catch (e) {
            if (i >= 20 || !String(e).includes('unloaded_chunk')) throw e;
            await sleep(500);
          }
        }
      };
      await fillR({ x: at.x - 12, y: FEET_Y - 1, z: at.z - 12 }, { x: at.x + 12, y: FEET_Y - 1, z: at.z + 12 }, 'grass_block');
      await fillR({ x: at.x - 12, y: FEET_Y, z: at.z - 12 }, { x: at.x + 12, y: FEET_Y + 20, z: at.z + 12 }, 'air');
      if (!OPEN) {
        await fillR({ x: at.x - 3, y: FEET_Y, z: at.z - 3 }, { x: at.x + 3, y: FEET_Y + 2, z: at.z + 3 }, 'stone');
        await fillR({ x: at.x - 2, y: FEET_Y, z: at.z - 2 }, { x: at.x + 2, y: FEET_Y + 2, z: at.z + 2 }, 'air');
      }
      await b.truth.clearAround(c, 40);
      // the kit: no weapon, no armour, the elytra in the inventory, rockets and bread in the hotbar
      await t.ok('clear', [b.name]);
      await t.ok('unequip', [b.name]);
      await gauntCmd('replaceitem', 'entity', b.name, 'slot.weapon.offhand', '0', 'air');
      await t.ok('setslot', [b.name, 1, 'firework_rocket', 64]);
      await t.ok('setslot', [b.name, 2, 'bread', 8]);
      await t.ok('setslot', [b.name, 9, 'elytra', 1]);
      const home = { x: at.x + HOME, y: FEET_Y, z: at.z };
      b.task.home!.set(home);
      await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
      await b.truth.setFood(b.name, 20, 5);
      await b.truth.setHealth(b.name, HEALTH);
      await until(() => (Math.abs(b.pve.health() - HEALTH) < 0.6 ? true : undefined), 5_000, `health ${HEALTH}`).catch(() => undefined);
      await sleep(1000);
      b.pve.setGuard({ on: true, radius: 16 });
      const deaths0 = b.built.respawn!.deaths;
      const fly0 = b.metrics.snapshot().counters['pve.floor.fly'] ?? 0;
      const said0 = b.said.length;
      const since = await b.truth.now();
      for (let i = 0; i < ZOMBIES; i++) {
        const a = (2 * Math.PI * i) / ZOMBIES + 0.4;
        await b.truth.summon('zombie', { x: c.x + 1.8 * Math.cos(a), y: FEET_Y, z: c.z + 1.8 * Math.sin(a) });
      }
      const loop = b.built.mobility!.loop as unknown as { onBeforeStep(fn: () => void): () => void; state: { gliding: boolean; onGround: boolean; pos: Vec3 } };
      const t0 = Date.now();
      let askedAt: number | undefined;
      let glideAt: number | undefined;
      let maxY = -Infinity;
      let glideTicks = 0;
      let hpAtAsk: number | undefined;
      let hpAtGlide: number | undefined;
      let minHealth = 20;
      const procs = new Set<string>();
      const off = loop.onBeforeStep(() => {
        const ms = Date.now() - t0;
        if (askedAt === undefined && (b.metrics.snapshot().counters['pve.floor.fly'] ?? 0) > fly0) {
          askedAt = ms;
          hpAtAsk = b.pve.health();
        }
        if (loop.state.gliding) {
          glideTicks++;
          if (glideAt === undefined) {
            glideAt = ms;
            hpAtGlide = b.pve.health();
          }
        }
        maxY = Math.max(maxY, loop.state.pos.y - FEET_Y);
        const p = b.task.processes?.active?.name;
        if (p) procs.add(p);
      });
      let died = false;
      while (Date.now() - t0 < SECONDS * 1000) {
        minHealth = Math.min(minHealth, b.pve.health());
        if (b.built.respawn!.deaths > deaths0) {
          died = true;
          break;
        }
        // down again after a flight, out of the air for 3 s: the run is over
        if (glideAt !== undefined && !loop.state.gliding && loop.state.onGround && Date.now() - t0 - glideAt > 5000) {
          await sleep(3000);
          if (!loop.state.gliding) break;
        }
        await sleep(250);
      }
      off();
      const me = b.pve.position();
      const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
      const by: Record<string, number> = {};
      for (const h of hurt) by[h.cause] = r1((by[h.cause] ?? 0) + h.damage);
      const flyLines = b.said.slice(said0).filter((m) => /fly|flight|land|glid|rocket|takeoff|elytra/i.test(m)).map((m) => m.slice(0, 140));
      const res = {
        label: LABEL,
        run,
        open: OPEN,
        died,
        damage: r1(hurt.reduce((s, h) => s + h.damage, 0)),
        damageByCause: by,
        askedS: askedAt !== undefined ? r1(askedAt / 1000) : null,
        healthAtAsk: hpAtAsk !== undefined ? r1(hpAtAsk) : null,
        glideS: glideAt !== undefined ? r1(glideAt / 1000) : null,
        healthAtGlide: hpAtGlide !== undefined ? r1(hpAtGlide) : null,
        glideTicks,
        maxY: r1(maxY),
        endFromStart: r1(Math.hypot(me.x - c.x, me.z - c.z)),
        endFromHome: r1(Math.hypot(me.x - (home.x + 0.5), me.z - (home.z + 0.5))),
        endY: r1(me.y - FEET_Y),
        minHealth: r1(minHealth),
        processes: [...procs],
        floors: Object.fromEntries(Object.entries(b.metrics.snapshot().counters).filter(([k]) => k.startsWith('pve.floor.'))),
        said: flyLines,
      };
      const line = `${LABEL} run ${run}${OPEN ? ' (open)' : ''}: ${died ? 'DIED' : 'alive'}, damage ${res.damage} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}), lowest ${res.minHealth}, elytra flee asked ${res.askedS ?? '-'} s at health ${res.healthAtAsk ?? '-'}, gliding ${res.glideS ?? '-'} s at health ${res.healthAtGlide ?? '-'} (${glideTicks} ticks, top ${res.maxY}), ended ${res.endFromStart} from the start and ${res.endFromHome} from home at y ${res.endY}; processes ${res.processes.join(' ')}; said: ${flyLines.join(' | ') || 'nothing'}`;
      lines.push(line);
      console.log(line);
      if (OUT) appendFileSync(OUT, `${JSON.stringify(res)}\n`, 'utf8');
      b.pve.setGuard({ on: false });
      const stop = '!stop';
      b.chat.handle({ type: 'chat', source: ownerName, xuid: '', message: stop, body: stop, truth: false });
      await until(() => (!loop.state.gliding ? true : undefined), 30_000, 'down').catch(() => undefined);
      b.pve.stop();
      await b.truth.cleanup();
      if (died) {
        await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned').catch(() => undefined);
        // a `!fly home` sent before the death started after the respawn in the first series (run 2 began in the air):
        // note it, and stop it before the next run
        await sleep(3000);
        const after = b.task.processes?.active?.name;
        const flyingAfter = loop.state.gliding;
        const l2 = `${LABEL} run ${run}: after the respawn the active process is ${after ?? 'none'}${flyingAfter ? ', gliding' : ''}`;
        lines.push(l2);
        console.log(l2);
        b.chat.handle({ type: 'chat', source: ownerName, xuid: '', message: stop, body: stop, truth: false });
        await until(() => (!loop.state.gliding && loop.state.onGround ? true : undefined), 60_000, 'down after the respawn').catch(() => undefined);
        b.pve.stop();
      }
      await sleep(2000);
    }
    expect(lines).toHaveLength(RUNS);
  }, RUNS * (SECONDS + 90) * 1000);
});
