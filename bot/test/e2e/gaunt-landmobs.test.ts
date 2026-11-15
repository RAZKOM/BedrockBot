// Track M3 (docs/flight.md "The landing looks at hostile mobs", decisions/0086): a flight's landing with hostile mobs on
// and beside its landing cell, on a mob test server (bds-gaunt, or bds-pve with GAUNT_BDS_PORT / GAUNT_BDS_CONTAINER):
// flat world, midnight with the clock frozen, no natural spawns. Per run: the bot (no armour, a netherite sword, the
// elytra, rockets; guard on, radius 16; the reflex as it ships) stands LANDMOBS_DIST (default 120) blocks from a landing
// cell, the case's mobs are summoned there (a ticking area keeps the place loaded while the bot is away), and `!fly
// <x y z>` flies it to the cell. Cases (LANDMOBS_CASES): `creeper-on` a creeper on the cell, `creeper-3` one 3 blocks
// beside it, `zombie-on` a zombie on it, `skeleton-10` a skeleton 10 off, `phantom-over` a phantom 12 over it, `none`,
// and `creeper-late`: a creeper summoned 4 blocks from the landing once the flight is in its approach 14 blocks out
// (too late for the search and for the trip's look: the brain's own look).
// Each case runs LANDMOBS_RUNS times (default 10) with `flyLandMobs` off and as many with it on, alternating, on
// LANDMOBS_TERRAIN: `yard` (default: 8 pillars 5 high on a ring 6 out, so the landing is the brake over them and the
// elevator down with `flyWayDown` on, as most Realm landings are) or `open` (flat ground: the flare).
//
// Measured per run (one line, and one JSON line to MOBS_OUT): the flight's end and seconds, how far from the cell it
// stood, the nearest live creeper at the touchdown (the bot's own entity tracker), the damage by cause up to 2 s after
// the touchdown and in the 15 s after (truth:hurtlog, the server's record), the reflex's strikes while the flight held
// the body and how many the server showed a hurt for, the rounds flown for a creeper, and how far out the mobs were first
// known, the flight's go-arounds and its rounds for a creeper. Asserts only that the runs ran, and (the bar) that with the look on no flight touched down inside a live
// creeper's blast range.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { Vec3 } from '../../src/connection/types.ts';
import { flyControlOf } from '../../src/chat/commands-fly.ts';
import { LAND_MOBS, landMobsNear } from '../../src/skills/fly/landmobs.ts';
import { centre, E2E, FEET_Y, fill, gauntCmd, prepareServer, privateArea, sleep, startGauntBot, teleport, uniqueName, until, type GauntBot } from './gaunt-truth.ts';

const RUNS = Number(process.env.LANDMOBS_RUNS ?? 10);
const DIST = Number(process.env.LANDMOBS_DIST ?? 120);
const TERRAIN = process.env.LANDMOBS_TERRAIN === 'open' ? 'open' : 'yard';
const SIDES = (process.env.LANDMOBS_SIDES ?? 'off,on').split(',').map((s) => s.trim()).filter(Boolean);
const AFTER_S = Number(process.env.LANDMOBS_AFTER ?? 15);
const OUT = process.env.MOBS_OUT;
const LABEL = process.env.MOBS_LABEL ?? 'landmobs';
const r1 = (v: number): number => Math.round(v * 10) / 10;

interface Case {
  name: string;
  mobs: { type: string; dx: number; dy: number; dz: number }[];
  /** A creeper summoned this far from the cell once the flight is in its approach within LATE_WITHIN blocks of it: too late for the search and the late look, the brain's own case. */
  late?: number;
}
const LATE_WITHIN = 14;
const ALL: Case[] = [
  { name: 'creeper-on', mobs: [{ type: 'creeper', dx: 0, dy: 0, dz: 0 }] },
  { name: 'creeper-3', mobs: [{ type: 'creeper', dx: 3, dy: 0, dz: 0 }] },
  { name: 'zombie-on', mobs: [{ type: 'zombie', dx: 0, dy: 0, dz: 0 }] },
  { name: 'skeleton-10', mobs: [{ type: 'skeleton', dx: 10, dy: 0, dz: 0 }] },
  { name: 'phantom-over', mobs: [{ type: 'phantom', dx: 0, dy: 12, dz: 0 }] },
  { name: 'none', mobs: [] },
  { name: 'creeper-late', mobs: [], late: 4 },
];
const FILTER = (process.env.LANDMOBS_CASES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const CASES = FILTER.length ? ALL.filter((c) => FILTER.includes(c.name)) : ALL;

describe.skipIf(!E2E)('gaunt: a landing with hostile mobs at the cell (Track M3)', () => {
  let bot: GauntBot | undefined;
  const ownerName = uniqueName('LmOwner');
  const area = privateArea();
  const lines: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const tick = uniqueName('lm').toLowerCase().slice(0, 12);

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startGauntBot('GtLand', {}, { owners: [ownerName], values: { guard: '16' } });
    bot.pve.settings.set('flyWayDown', true); // as live
    bot.pve.settings.set('autoFly', true);
  }, 120_000);

  afterAll(async () => {
    await gauntCmd('tickingarea', 'remove', tick).catch(() => undefined);
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
    console.log(`landing with mobs (${TERRAIN}):\n  ${lines.join('\n  ')}`);
  });

  it(`${CASES.map((c) => c.name).join(', ')}: ${RUNS} runs a side (${SIDES.join(' / ')}), ${TERRAIN}`, async () => {
    const b = bot!;
    const t = b.truth as unknown as { ok<T>(n: string, a: (string | number)[]): Promise<T> } & GauntBot['truth'];
    const control = flyControlOf(b.task)!;
    const world = b.built.mobility!.world;
    const loop = b.built.mobility!.loop as unknown as { onBeforeStep(fn: () => void): () => void; state: { gliding: boolean; onGround: boolean; pos: Vec3; vel: Vec3 }; waitTicks(n: number): Promise<void> };
    const say = (m: string): void => b.chat.handle({ type: 'chat', source: ownerName, xuid: '', message: m, body: m, truth: false });
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
    let n = 0;
    for (const c of CASES) {
      for (let run = 1; run <= RUNS; run++) {
        for (const side of SIDES) {
          n++;
          const look = side === 'on';
          b.pve.settings.set('flyLandMobs', look);
          // a fresh spot a run: the start, and the landing DIST north of it
          const sx = area.x - 96 + 48 * ((n - 1) % 5);
          const sz = area.z - 120;
          const start = { x: sx, y: FEET_Y, z: sz };
          const land = { x: sx, y: FEET_Y, z: sz + DIST };
          // the landing's ground first (the bot there): flat grass, the air over it, the terrain's pillars
          await teleport(b, centre({ x: land.x, y: FEET_Y, z: land.z - 30 }));
          await fillR({ x: land.x - 28, y: FEET_Y - 1, z: land.z - 28 }, { x: land.x + 28, y: FEET_Y - 1, z: land.z + 28 }, 'grass_block');
          await fillR({ x: land.x - 28, y: FEET_Y, z: land.z - 28 }, { x: land.x + 28, y: FEET_Y + 14, z: land.z + 28 }, 'air');
          if (TERRAIN === 'yard') {
            for (let k = 0; k < 8; k++) {
              const a = (k * Math.PI) / 4 + Math.PI / 8;
              const px = Math.round(land.x + Math.cos(a) * 6);
              const pz = Math.round(land.z + Math.sin(a) * 6);
              await fillR({ x: px, y: FEET_Y, z: pz }, { x: px, y: FEET_Y + 4, z: pz }, 'stone');
            }
          }
          await b.truth.clearAround(centre(land), 48);
          await gauntCmd('tickingarea', 'remove', tick).catch(() => undefined);
          await gauntCmd('tickingarea', 'add', 'circle', String(land.x), String(FEET_Y), String(land.z), '2', tick);
          // the bot to the start, the kit, full health
          await teleport(b, centre(start));
          await fillR({ x: start.x - 6, y: FEET_Y - 1, z: start.z - 6 }, { x: start.x + 6, y: FEET_Y - 1, z: start.z + 6 }, 'grass_block');
          await fillR({ x: start.x - 6, y: FEET_Y, z: start.z - 6 }, { x: start.x + 6, y: FEET_Y + 14, z: start.z + 6 }, 'air');
          await t.ok('clear', [b.name]);
          await t.ok('unequip', [b.name]);
          await gauntCmd('replaceitem', 'entity', b.name, 'slot.weapon.offhand', '0', 'air');
          await t.ok('setslot', [b.name, 0, 'netherite_sword', 1]);
          await t.ok('setslot', [b.name, 1, 'firework_rocket', 64]);
          await t.ok('setslot', [b.name, 2, 'bread', 8]);
          await t.ok('setslot', [b.name, 9, 'elytra', 1]);
          b.task.home!.set(start);
          await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
          await b.truth.setFood(b.name, 20, 5);
          await b.truth.setHealth(b.name, 20);
          await until(() => (b.pve.health() > 19.4 ? true : undefined), 5_000, 'health 20').catch(() => undefined);
          // the mobs at the landing (the place ticks; the bot is DIST away: they do not know of it)
          const summoned: string[] = [];
          for (const m of c.mobs) {
            const info = await b.truth.summon(m.type, { x: land.x + 0.5 + m.dx, y: FEET_Y + m.dy, z: land.z + 0.5 + m.dz });
            summoned.push(info.entityId);
          }
          await sleep(500);
          // (the run counts only with its mobs really there: the server's own list)
          let present = 0;
          for (const id of summoned) if ((await b.truth.entity(id).catch(() => undefined))?.valid !== false) present++;
          b.pve.setGuard({ on: true, radius: 16 });
          const deaths0 = b.built.respawn!.deaths;
          const since = await b.truth.now();
          const hits0 = { ...b.pve.reflex.totals };
          let touchdownAt: number | undefined;
          let touchdownPos: Vec3 | undefined;
          let creeperAtTouchdown: number | null = null;
          let firstKnown: number | null = null;
          let airHits = 0;
          let airLanded = 0;
          let wasActive = false;
          let wasGliding = false;
          let maxY = -Infinity;
          // the flight's own report: the go-arounds, and the rounds flown for a creeper (the brain's look)
          let rounds: number | null = null;
          let goArounds: number | null = null;
          let watched: unknown;
          const t0 = Date.now();
          const off = loop.onBeforeStep(() => {
            const p = loop.state.pos;
            maxY = Math.max(maxY, p.y - FEET_Y);
            const active = control.controller.active;
            const trip = control.current();
            if (trip && trip !== watched) {
              watched = trip;
              void trip.result.then((o) => {
                rounds = o.report?.mobRounds ?? 0;
                goArounds = o.report?.goArounds ?? 0;
              });
            }
            if (active) {
              wasActive = true;
              if (firstKnown === null) {
                const known = landMobsNear(world.entities.values(), b.pve.mobs, { x: land.x + 0.5, z: land.z + 0.5 }, 24);
                if (known.length) firstKnown = Math.hypot(p.x - (land.x + 0.5), p.z - (land.z + 0.5));
              }
            }
            if (touchdownAt === undefined && wasGliding && !loop.state.gliding && loop.state.onGround) {
              touchdownAt = Date.now() - t0;
              touchdownPos = { ...p };
              const cr = landMobsNear(world.entities.values(), b.pve.mobs, p, 64).filter((m) => m.kind === 'creeper');
              creeperAtTouchdown = cr.length ? Math.min(...cr.map((m) => Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z))) : null;
            }
            wasGliding = loop.state.gliding;
            if (wasActive && !active && airHits === 0 && airLanded === 0) {
              airHits = b.pve.reflex.totals.hits - hits0.hits;
              airLanded = b.pve.reflex.totals.landed - hits0.landed;
            }
          });
          const said0 = b.said.length;
          say(`!fly ${land.x} ${land.y} ${land.z}`);
          let died = false;
          let lateDone = false;
          // the flight: until the controller has been active and is not any more (or 90 s)
          while (Date.now() - t0 < 90_000) {
            if (b.built.respawn!.deaths > deaths0) {
              died = true;
              break;
            }
            if (wasActive && !control.controller.active) break;
            if (c.late !== undefined && !lateDone) {
              const st = control.controller.status();
              if ((st.phase === 'approach' || st.phase === 'land') && st.distance !== undefined && st.distance < LATE_WITHIN) {
                lateDone = true;
                const tgt = st.target ?? { x: land.x + 0.5, z: land.z + 0.5 };
                const info = await b.truth.summon('creeper', { x: tgt.x + c.late, y: FEET_Y, z: tgt.z });
                summoned.push(info.entityId);
                present++;
              }
            }
            await sleep(100);
          }
          const flightMs = Date.now() - t0;
          const report = control.controller.lastEnd;
          const strikesInFlight = { hits: b.pve.reflex.totals.hits - hits0.hits, landed: b.pve.reflex.totals.landed - hits0.landed };
          const mid = await b.truth.now();
          // the seconds after the touchdown (the guard and the walk to the goal have the body)
          const tA = Date.now();
          while (Date.now() - tA < AFTER_S * 1000 && !died) {
            if (b.built.respawn!.deaths > deaths0) died = true;
            await sleep(250);
          }
          off();
          const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
          // (the server's ticks: 20 a second; the touchdown's tick is the flight's end less the settle)
          const cut = mid + 40;
          const by = (evs: typeof hurt): Record<string, number> => {
            const o: Record<string, number> = {};
            for (const h of evs) {
              const k = h.damagerType ? h.damagerType.replace('minecraft:', '') : h.cause;
              o[k] = r1((o[k] ?? 0) + h.damage);
            }
            return o;
          };
          const early = hurt.filter((h) => h.tick <= cut);
          const late = hurt.filter((h) => h.tick > cut);
          const sum = (evs: typeof hurt): number => r1(evs.reduce((s, h) => s + h.damage, 0));
          const me = b.pve.position();
          const at = touchdownPos ?? me;
          const notes = b.said.slice(said0).filter((m) => /fly|land|flying/i.test(m)).map((m) => m.slice(0, 120));
          const row = {
            label: LABEL,
            terrain: TERRAIN,
            case: c.name,
            look: side,
            run,
            mobs: `${present}/${summoned.length}`,
            flew: wasActive,
            end: report ?? 'landed',
            died,
            flightS: r1((touchdownAt ?? flightMs) / 1000),
            fromCell: r1(Math.hypot(at.x - (land.x + 0.5), at.z - (land.z + 0.5))),
            creeperAtTouchdown: creeperAtTouchdown === null ? null : r1(creeperAtTouchdown),
            inBlast: creeperAtTouchdown !== null && creeperAtTouchdown < LAND_MOBS.blast,
            damageLanding: sum(early),
            byLanding: by(early),
            damageAfter: sum(late),
            byAfter: by(late),
            strikesInFlight: strikesInFlight.hits,
            strikesLanded: strikesInFlight.landed,
            firstKnown: firstKnown === null ? null : r1(firstKnown),
            goArounds,
            mobRounds: rounds,
            maxY: r1(maxY),
            said: notes,
          };
          rows.push(row);
          const line = `${LABEL} ${TERRAIN} ${c.name} look ${side} run ${run}: ${row.flew ? `${row.end} after ${row.flightS} s, ${row.fromCell} from the cell` : 'NO FLIGHT'}${row.creeperAtTouchdown !== null ? `, creeper ${row.creeperAtTouchdown} off at the touchdown${row.inBlast ? ' (IN ITS BLAST RANGE)' : ''}` : ''}; damage ${row.damageLanding} at the landing (${Object.entries(row.byLanding).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'}), ${row.damageAfter} in the ${AFTER_S} s after (${Object.entries(row.byAfter).map(([k, v]) => `${k} ${v}`).join(' ') || 'none'})${died ? ', DIED' : ''}; reflex under the flight ${row.strikesInFlight} strikes, ${row.strikesLanded} landed; mobs first known ${row.firstKnown ?? '-'} out; ${row.goArounds ?? '?'} go-arounds, ${row.mobRounds ?? '?'} rounds for a creeper`;
          lines.push(line);
          console.log(line);
          if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`, 'utf8');
          // clean up: stop the trip, the mobs, the craters
          b.pve.setGuard({ on: false });
          say('!stop');
          control.supersede();
          await until(() => (!loop.state.gliding && !control.controller.active ? true : undefined), 30_000, 'down').catch(() => undefined);
          b.pve.stop();
          await b.truth.cleanup();
          if (died) {
            // the respawn, and the trip home the respawn starts by itself: stopped before the next run
            await until(() => (!b.built.respawn!.dead ? true : undefined), 30_000, 'respawned').catch(() => undefined);
            await sleep(4000);
            say('!stop');
            control.supersede();
            if (control.controller.active) control.controller.landNow('stopped');
            await until(() => (!loop.state.gliding && loop.state.onGround && !control.controller.active ? true : undefined), 60_000, 'down after the respawn').catch(() => undefined);
            b.pve.stop();
            await sleep(2000);
          }
          await sleep(1500);
        }
      }
    }
    expect(rows.length).toBe(CASES.length * RUNS * SIDES.length);
    const on = rows.filter((r) => r.look === 'on' && r.flew === true);
    expect(on.filter((r) => r.inBlast === true).map((r) => `${String(r.case)} run ${String(r.run)}`)).toEqual([]);
  }, CASES.length * RUNS * SIDES.length * 150_000);
});
