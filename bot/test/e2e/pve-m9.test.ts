// Track M9 (docs/pve.md "Track M9: losing a following archer", ADR 0079 addendum) on bds-pve: what the shipped rule stands on.
//   follow   no blade (16 bread only), a pillager summoned 7 off, guard on, resistance (the case is about the choices, not the
//            bolts), until the second flight starts (at most 75 s) a side: with `followRun` the far legs run past FLEE_FAR
//            (followRunRadius: the leg key `far:long`), no home leg while the pillager is within 24, and the flight that gives up
//            at 60 s starts again at once, with no guard and no fist strike in between; off, the far legs stop at FLEE_FAR.
//            M9_TRACE=1 adds a line a second (leg, process, health, the pillager's distance and sight) and the hurt log
// Needs BDS_E2E=1 and bds-pve with the truth pack.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, cleanSpot, E2E, expectAlive, FEET_Y, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, uniqueName, type PveBot } from './pve-truth.ts';

function note(line: string): void {
  console.log(line);
  if (process.env.M9_OUT) appendFileSync(process.env.M9_OUT, `${line}\n`);
}

/** M9_TRACE=1: a line a second (the leg, the process, the health, the pillager's distance and whether it has a line on the bot). */
const TRACE = process.env.M9_TRACE === '1';
function traceLine(b: PveBot, on: boolean, t0: number, c: Vec3, pid: bigint, k: string | undefined): void {
  const pve = b.pve as unknown as { position(): Vec3; health(): number; bareArcher(me: Vec3): unknown; d: { world: { entities: Map<bigint, { pos: Vec3 }> } } };
  const me = pve.position();
  const e = pve.d.world.entities.get(pid);
  const pd = e ? Math.hypot(e.pos.x - me.x, e.pos.z - me.z).toFixed(1) : '-';
  const ph = e ? Math.hypot(e.pos.x - c.x, e.pos.z - c.z).toFixed(1) : '-';
  note(`trace ${on ? 'on' : 'off'} t=${((Date.now() - t0) / 1000).toFixed(0)} leg=${k ?? '-'} proc=${b.pve.processes.active?.name ?? '-'} hp=${pve.health().toFixed(1)} out=${Math.hypot(me.x - c.x, me.z - c.z).toFixed(1)} pillager=${pd} (home ${ph}) seen=${pve.bareArcher(me) ? 'y' : 'n'}`);
}

describe.skipIf(!E2E)('pve: Track M9 rules', () => {
  let bot: PveBot | undefined;
  const ownerName = uniqueName('M9Owner');
  const area = privateArea();
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x + 300 + 160 * i, y: FEET_Y, z: area.z + 1020 };
  };

  /** No flight outlives a side: health up first (else the flee starts again at once), then stop until none runs. */
  async function quiet(b: PveBot): Promise<void> {
    b.pve.setGuard({ on: false });
    await b.truth.cleanup();
    await b.truth.setHealth(b.name, 20);
    const t0 = Date.now();
    do {
      b.pve.stop();
      await sleep(250);
    } while (b.pve.processes.active?.name === 'flee' && Date.now() - t0 < 5000);
  }

  async function fresh(b: PveBot): Promise<Vec3> {
    const at = nextSpot();
    const c = centre(at);
    await quiet(b);
    await teleport(b, c).catch(async () => {
      await sleep(1000);
      await teleport(b, c);
    });
    await cleanSpot(b, c, { r: 32, up: 5, entities: 70 });
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    b.task.home?.set(at);
    return c;
  }

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startPveBot('PveM9', {}, { owners: [ownerName] });
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('unequip', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  it('follow: no blade and a pillager that follows: on, far legs past FLEE_FAR and the next flight at once after the minute; off, far legs to FLEE_FAR', async () => {
    const b = bot!;
    const out: Record<string, { long: boolean; legs: string[]; second: boolean; guardTicks: number; strikes: number; homeFollowed: number }> = {};
    /** The flight's leg as it planned it (`far`, `far:long`, `away`, ...). */
    const leg = (): string | undefined => (b.pve.fleeProcess as unknown as { ep?: { goalKey?: string } }).ep?.goalKey;
    try {
      for (const on of [false, true]) {
        const c = await fresh(b);
        b.pve.rules.followRun = on;
        const legs = new Set<string>();
        await b.truth.effect(b.name, 'resistance', 90, 4);
        const deaths0 = b.built.respawn!.deaths;
        const since = await b.truth.now();
        // (read before the summon: the first flight starts as soon as the bot sees the pillager, often before tracked() returns)
        const flees0 = b.pve.stats.flees;
        const p = await b.truth.summon('pillager', { x: c.x + 7, y: FEET_Y, z: c.z });
        const pid = await tracked(b, p);
        b.pve.setGuard({ on: true, radius: 16 });
        let guardTicks = 0;
        let homeFollowed = 0; // samples of a home leg with the pillager within FLEE_SCAN + 8 (24) of the bot
        const pillagerAt = (): number => {
          const pve = b.pve as unknown as { position(): Vec3; d: { world: { entities: Map<bigint, { pos: Vec3 }> } } };
          const e = pve.d.world.entities.get(pid);
          const me = pve.position();
          return e ? Math.hypot(e.pos.x - me.x, e.pos.z - me.z) : Infinity;
        };
        const t0 = Date.now();
        // on: until the second flight; off: the same 64 s (off's next flight waits out the cooldown and guard's chase)
        while (Date.now() - t0 < (on ? 75_000 : 64_000) && b.built.respawn!.deaths === deaths0) {
          if (on && b.pve.stats.flees - flees0 >= 2) break;
          const k = leg();
          if (k) legs.add(k.replace(/^home:.*/, 'home'));
          if (k?.startsWith('home') && pillagerAt() <= 24) homeFollowed++;
          if (Date.now() - t0 > 55_000 && b.pve.processes.active?.name === 'guard') guardTicks++;
          if (TRACE && (Date.now() - t0) % 1000 < 110) traceLine(b, on, t0, c, pid, k);
          await sleep(100);
        }
        const second = b.pve.stats.flees - flees0 >= 2;
        const hurt = (await b.truth.hurtlog(since)).events;
        const strikes = hurt.filter((h) => h.damagerName === b.name && h.victimId === p.entityId).length;
        if (TRACE) for (const h of hurt) note(`hurt ${on ? 'on' : 'off'} tick ${h.tick - since} ${h.victimName ?? h.victimType} by ${h.damagerName ?? h.damagerType ?? '-'} ${h.cause} ${h.damage}`);
        const long = [...legs].some((k) => k.endsWith(':long'));
        out[on ? 'on' : 'off'] = { long, legs: [...legs], second, guardTicks, strikes, homeFollowed };
        note(`follow (followRun ${on ? 'on' : 'off'}): legs ${[...legs].join(', ') || '-'}; a second flight ${second ? 'yes' : 'no'} after ${((Date.now() - t0) / 1000).toFixed(1)} s; guard samples after 55 s ${guardTicks}; fist strikes ${strikes}; home-leg samples with the pillager within 24 ${homeFollowed}${b.built.respawn!.deaths > deaths0 ? ', DIED' : ''} (#${pid})`);
        expectAlive(b, deaths0, `follow, followRun ${on ? 'on' : 'off'}`);
        await quiet(b);
      }
    } finally {
      b.pve.rules.followRun = true;
    }
    expect(out.off!.long).toBe(false);
    expect(out.on!.long).toBe(true);
    expect(out.on!.second).toBe(true);
    expect(out.on!.guardTicks).toBe(0);
    expect(out.on!.strikes).toBe(0);
    expect(out.on!.homeFollowed).toBe(0);
  }, 240_000);
});
