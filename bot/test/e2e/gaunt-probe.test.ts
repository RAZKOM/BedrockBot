// Track M1 round 2 (docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): the server's numbers for the witch and the
// archers, measured on bds-gaunt (or bds-pve with GAUNT_BDS_PORT / GAUNT_BDS_CONTAINER), flat world, midnight, no natural
// spawns. Every case is a measurement: it prints one `probe ...` line (and appends it to PROBE_OUT) and asserts only that it
// ran. PROBE_ONLY=witch,arrow,... runs only the named cases (the first word of each title).
//   witch        a witch held in place at 4 / 8 / 12 / 16, the bot standing still, bare and in the live kit: her throws
//                (interval, distance, flight ticks), the effects on the bot (type, level, length), the damage by cause
//   witchmove    a witch at 8, the bot sidestepping at each throw (the reverse of its last step) or behind a wall of two
//   witchkill    a free witch, the live kit: the time to kill by the controller's fight, by sprint hits, by critical hits
//   weakness     a fist on a held zombie with and without weakness
//   arrow        a skeleton (and a pillager) held at 6 / 10 / 14: the arrows' flight ticks, whether it leads a strafing
//                target, the hits on a bot standing, strafing, reversing at each release, behind a 2-high pillar, in a 2-deep hole
//   corner       a free skeleton at 10, the bot walking 18 away round a wall: the arrows after the line of sight is broken
import { afterAll, beforeAll, describe, expect, it as vit } from 'vitest';
import { appendFileSync } from 'node:fs';
import type { Vec3 } from '../../src/world/types.ts';
import { yawTowards } from '../../src/skills/nav/follower.ts';
import { reachDistance } from '../../src/skills/combat/hostiles.ts';
import { EYE_HEIGHT } from '../../src/skills/combat/combat.ts';
import { centre, E2E, FEET_Y, fill, gauntCmd, prepareServer, privateArea, sleep, startGauntBot, teleport, tracked, until, type GauntBot } from './gaunt-truth.ts';

const OUT = process.env.PROBE_OUT;
const only = (process.env.PROBE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const it = (title: string, fn: () => Promise<void>, ms?: number): void => {
  const key = title.split(/[: ]/)[0]!;
  (only.length && !only.includes(key) ? vit.skip : vit)(title, fn, ms);
};

interface CRec {
  tick: number;
  kind: string;
  player: string | null;
  entityId: string | null;
  typeId: string | null;
  item: string | null;
  distance: number | null;
  location: Vec3 | null;
  velocity?: Vec3 | null;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const med = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

describe.skipIf(!E2E)('gaunt: probes for the witch and the archers (Track M1 round 2)', () => {
  let bot: GauntBot | undefined;
  const area = privateArea();
  const lines: string[] = [];
  const note = (s: string): void => {
    console.log(`probe ${s}`);
    lines.push(s);
    if (OUT) appendFileSync(OUT, `${s}\n`, 'utf8');
  };
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x + 600 + 48 * (i % 20), y: FEET_Y, z: area.z + 600 + 48 * Math.floor(i / 20) };
  };
  const loopOf = (b: GauntBot) => b.built.mobility!.loop;

  async function setKit(b: GauntBot, kit: 'bare' | 'live'): Promise<void> {
    const t = b.truth;
    await t.ok('clear', [b.name]);
    await t.ok('unequip', [b.name]);
    await gauntCmd('replaceitem', 'entity', b.name, 'slot.weapon.offhand', '0', 'air');
    if (kit === 'bare') return;
    await t.give(b.name, 'netherite_sword', 1);
    for (const piece of ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']) await t.give(b.name, piece, 1);
    await t.give(b.name, 'shield', 1);
    await until(
      async () => {
        const eq = (await t.ok<{ equipment: Record<string, { typeId: string } | undefined> }>('durability', [b.name])).equipment;
        const st = await t.ok<{ offhand: { typeId: string } | null }>('stance', [b.name]);
        return eq.Head && eq.Chest && eq.Legs && eq.Feet && st.offhand?.typeId === 'minecraft:shield' ? true : undefined;
      },
      30_000,
      'netherite worn and the shield in the offhand',
      500,
    );
  }

  async function fresh(b: GauntBot): Promise<Vec3> {
    const at = nextSpot();
    const c = centre(at);
    await teleport(b, c);
    await fill(b, { x: at.x - 20, y: FEET_Y - 3, z: at.z - 20 }, { x: at.x + 20, y: FEET_Y - 2, z: at.z + 20 }, 'dirt');
    await fill(b, { x: at.x - 20, y: FEET_Y - 1, z: at.z - 20 }, { x: at.x + 20, y: FEET_Y - 1, z: at.z + 20 }, 'grass_block');
    await fill(b, { x: at.x - 20, y: FEET_Y, z: at.z - 20 }, { x: at.x + 20, y: FEET_Y + 6, z: at.z + 20 }, 'air');
    await b.truth.clearAround(c, 40);
    await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    await b.truth.setHealth(b.name, 20);
    await b.truth.setFood(b.name, 20, 5);
    return c;
  }

  /** Hold a mob in place (it still turns, aims and throws). */
  const hold = async (b: GauntBot, id: string): Promise<void> => {
    await b.truth.effect(id, 'slowness', 120, 255);
  };
  const log = async (b: GauntBot, since: number): Promise<CRec[]> => (await b.truth.ok<{ events: CRec[] }>('combatlog', [since, '*'], 20_000)).events;
  const effects = async (b: GauntBot): Promise<{ typeId: string; amplifier: number; duration: number }[]> =>
    (await b.truth.ok<{ effects: { typeId: string; amplifier: number; duration: number }[] }>('effects', [b.name])).effects;

  /**
   * Keep the bot alive through a measurement: every 300 ms, the effects seen (the strongest level and longest length of
   * each) are noted and the health is put back to 20 when it is under 10 (the refills are counted).
   */
  function keeper(b: GauntBot): { stop(): Promise<{ seen: Record<string, { level: number; ticks: number; times: number }>; refills: number }> } {
    const seen: Record<string, { level: number; ticks: number; times: number }> = {};
    const had = new Set<string>();
    let refills = 0;
    let on = true;
    const run = (async () => {
      while (on) {
        try {
          const fx = await effects(b);
          const now = new Set<string>();
          for (const f of fx) {
            const k = f.typeId.replace('minecraft:', '');
            now.add(k);
            const s = (seen[k] ??= { level: 0, ticks: 0, times: 0 });
            s.level = Math.max(s.level, f.amplifier + 1);
            s.ticks = Math.max(s.ticks, f.duration);
            if (!had.has(k)) s.times++;
          }
          had.clear();
          for (const k of now) had.add(k);
          if (b.pve.health() < 10 && !b.built.respawn!.dead) {
            refills++;
            await b.truth.setHealth(b.name, 20);
          }
        } catch {
          // the next poll
        }
        await sleep(300);
      }
    })();
    return {
      async stop() {
        on = false;
        await run;
        return { seen, refills };
      },
    };
  }

  const fmtSeen = (seen: Record<string, { level: number; ticks: number; times: number }>): string =>
    Object.entries(seen)
      .map(([k, v]) => `${k} ${v.level} x${v.times} (${r1(v.ticks / 20)} s)`)
      .join(', ') || 'none';

  /** The throws of `shooter` at the bot and where each ended: flight ticks and the landing's distance to the bot then. */
  function flights(events: CRec[], shooter: string, botAt: (tick: number) => Vec3 | undefined) {
    const throws = events.filter((e) => e.kind === 'throw' && e.item === `minecraft:${shooter}`);
    return throws.map((t) => {
      const land = events.find((e) => e.kind === 'land' && e.entityId === t.entityId);
      const me = land ? botAt(land.tick) : undefined;
      return {
        tick: t.tick,
        at: t.distance ?? NaN,
        ticks: land ? land.tick - t.tick : NaN,
        on: land?.item ?? 'lost',
        miss: land?.location && me ? Math.hypot(land.location.x - me.x, land.location.z - me.z) : NaN,
        vel: t.velocity,
        from: t.location,
      };
    });
  }

  /** The bot's feet by server tick (the truth's watch), for the landing distances. */
  async function track(b: GauntBot, ticks: number): Promise<(since: number) => Promise<(tick: number) => Vec3 | undefined>> {
    await b.truth.ok('watch', [b.name, ticks]);
    return async (since) => {
      const s = (await b.truth.ok<{ samples: { tick: number; location: Vec3 }[] }>('watchlog', [b.name, since], 20_000)).samples;
      return (tick) => {
        let best: { tick: number; location: Vec3 } | undefined;
        for (const x of s) if (!best || Math.abs(x.tick - tick) < Math.abs(best.tick - tick)) best = x;
        return best?.location;
      };
    };
  }

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startGauntBot('GtProbe');
    bot.pve.setGuard({ on: false });
    bot.pve.settings.set('mobReflex', false);
    await teleport(bot, centre(nextSpot()));
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      loopOf(bot).release();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
    console.log(`probes:\n  ${lines.join('\n  ')}`);
  });

  it('witch: her throws and the potions by distance and kit (held in place, the bot standing still, 25 s each)', async () => {
    const b = bot!;
    for (const kit of ['bare', 'live'] as const) {
      for (const d of [4, 8, 12, 16]) {
        const c = await fresh(b);
        await setKit(b, kit);
        const w = await b.truth.summon('witch', { x: c.x + d, y: FEET_Y, z: c.z });
        await hold(b, w.entityId);
        const since = await b.truth.now();
        const at = await track(b, 25 * 20 + 40);
        const k = keeper(b);
        await sleep(25_000);
        const { seen, refills } = await k.stop();
        const ev = await log(b, since);
        const fl = flights(ev, 'witch', await at(since));
        const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
        const byCause: Record<string, number> = {};
        for (const h of hurt) byCause[h.cause] = r1((byCause[h.cause] ?? 0) + h.damage);
        const gaps = fl.slice(1).map((f, i) => f.tick - fl[i]!.tick);
        const wh = (await b.truth.entity(w.entityId)) as { health?: number };
        note(
          `witch ${kit} at ${d}: ${fl.length} throws, interval median ${med(gaps)} ticks [${gaps.join(' ')}], flight ticks [${fl.map((f) => f.ticks).join(' ')}], landed on [${fl.map((f) => `${f.on.replace('minecraft:', '')}${Number.isFinite(f.miss) ? ` ${r1(f.miss)}` : ''}`).join(', ')}], effects ${fmtSeen(seen)}, damage ${JSON.stringify(byCause)} in ${hurt.length} hurts [${hurt.map((h) => r1(h.damage)).join(' ')}], refills ${refills}, her health ${wh.health ?? '?'}`,
        );
        await b.truth.cleanup();
      }
    }
    expect(lines.length).toBeGreaterThan(0);
  }, 600_000);

  it('witchmove: a witch at 8, the bot sidestepping at each throw / behind a wall of two (bare, 25 s each)', async () => {
    const b = bot!;
    for (const mode of ['stand', 'sidestep', 'wall', 'pillar'] as const) {
      const c = await fresh(b);
      await setKit(b, 'bare');
      const wAt = { x: c.x + 8, y: FEET_Y, z: c.z };
      if (mode === 'wall') await fill(b, { x: Math.floor(c.x) + 2, y: FEET_Y, z: Math.floor(c.z) - 2 }, { x: Math.floor(c.x) + 2, y: FEET_Y + 1, z: Math.floor(c.z) + 2 }, 'cobblestone');
      if (mode === 'pillar') await fill(b, { x: Math.floor(c.x) + 1, y: FEET_Y, z: Math.floor(c.z) }, { x: Math.floor(c.x) + 1, y: FEET_Y + 1, z: Math.floor(c.z) }, 'cobblestone');
      const w = await b.truth.summon('witch', wAt);
      await hold(b, w.entityId);
      const wRid = await tracked(b, w);
      const seenPotions = new Set<bigint>();
      let dir = 1;
      let stepUntil = 0;
      let n = 0;
      const off = loopOf(b).onBeforeStep(() => {
        n++;
        const me = loopOf(b).state.pos;
        const e = b.built.mobility!.world.entities.get(wRid);
        const yaw = e ? yawTowards(e.pos.x - me.x, e.pos.z - me.z) : 0;
        if (mode === 'sidestep') {
          for (const [rid, x] of b.built.mobility!.world.entities) {
            if (x.type === 'minecraft:splash_potion' && !seenPotions.has(rid)) {
              seenPotions.add(rid);
              dir = -dir;
              stepUntil = n + 12;
            }
          }
          // stay within 2 of the start across the line
          const side = me.z - c.z;
          if (Math.abs(side) > 2.2) dir = side > 0 ? -1 : 1;
        }
        const moving = mode === 'sidestep' && n < stepUntil;
        loopOf(b).setCommand({ yaw, pitch: 0, forward: 0, strafe: moving ? dir : 0, sprint: moving, jump: false, sneak: false });
      });
      const since = await b.truth.now();
      const at = await track(b, 25 * 20 + 40);
      const k = keeper(b);
      await sleep(25_000);
      off();
      loopOf(b).release();
      const { seen, refills } = await k.stop();
      const ev = await log(b, since);
      const fl = flights(ev, 'witch', await at(since));
      const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
      note(
        `witchmove ${mode}: ${fl.length} throws, landed [${fl.map((f) => `${f.on.replace('minecraft:', '')}${Number.isFinite(f.miss) ? ` ${r1(f.miss)}` : ''} ${f.ticks}t`).join(', ')}], effects ${fmtSeen(seen)}, damage ${r1(hurt.reduce((s, h) => s + h.damage, 0))} in ${hurt.length} hurts, refills ${refills}`,
      );
      await b.truth.cleanup();
    }
  }, 300_000);

  it('witchkill: a free witch, the live kit: the time to kill by the fight, sprint hits, critical hits (2 each)', async () => {
    const b = bot!;
    for (const method of ['fight', 'sprint', 'crit'] as const) {
      for (let run = 0; run < 2; run++) {
        const c = await fresh(b);
        await setKit(b, 'live');
        b.pve.combat.selectWeapon();
        const w = await b.truth.summon('witch', { x: c.x + 5, y: FEET_Y, z: c.z });
        const rid = await tracked(b, w);
        const since = await b.truth.now();
        const t0 = Date.now();
        let strikes = 0;
        let off = (): void => undefined;
        let fightP: Promise<unknown> | undefined;
        if (method === 'fight') {
          fightP = b.pve.combat.fight(rid, { reach: 3.0 });
        } else {
          let last = -100;
          let n = 0;
          off = loopOf(b).onBeforeStep(() => {
            n++;
            const e = b.built.mobility!.world.entities.get(rid);
            if (!e) return;
            const s = loopOf(b).state;
            const me = s.pos;
            const dist = Math.hypot(e.pos.x - me.x, e.pos.z - me.z);
            const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
            const reach = reachDistance(eye, e);
            const yaw = yawTowards(e.pos.x - me.x, e.pos.z - me.z);
            const close = dist < 2.2;
            if (method === 'sprint') {
              loopOf(b).setCommand({ yaw, pitch: 0, forward: close ? 0 : 1, strafe: 0, sprint: !close, jump: false, sneak: false });
              if (n - last >= 10 && reach <= 3.0) {
                b.pve.combat.attack(rid, { reach: 3.0 });
                last = n;
                strikes++;
              }
            } else {
              // jump when on the ground and close; strike on the way down
              loopOf(b).setCommand({ yaw, pitch: 0, forward: dist > 2.5 ? 1 : 0, strafe: 0, sprint: false, jump: s.onGround && reach <= 3.5, sneak: false });
              if (n - last >= 10 && reach <= 3.0 && !s.onGround && s.vel.y < 0) {
                b.pve.combat.attack(rid, { reach: 3.0 });
                last = n;
                strikes++;
              }
            }
          });
        }
        const k = keeper(b);
        let health: number[] = [];
        let dead = false;
        while (Date.now() - t0 < 40_000) {
          const st = (await b.truth.entity(w.entityId)) as { valid?: boolean; health?: number };
          if (st.valid === false || (st.health ?? 1) <= 0) {
            dead = true;
            break;
          }
          if (st.health !== undefined && health[health.length - 1] !== st.health) health.push(r1(st.health));
          await sleep(100);
        }
        const secs = r1((Date.now() - t0) / 1000);
        off();
        b.pve.combat.cancel();
        await fightP?.catch(() => undefined);
        loopOf(b).release();
        const { seen } = await k.stop();
        const hurt = (await b.truth.hurtlog(since)).events;
        const onHer = hurt.filter((h) => h.victimId === w.entityId);
        const onMe = hurt.filter((h) => h.victimName === b.name);
        const heals = health.slice(1).filter((h, i) => h > health[i]!).length;
        note(
          `witchkill ${method} ${run + 1}: ${dead ? `killed in ${secs} s` : `ALIVE after ${secs} s`}, ${onHer.length} hits on her [${onHer.map((h) => r1(h.damage)).join(' ')}]${method !== 'fight' ? ` of ${strikes} strikes` : ''}, her health [${health.join(' ')}] (${heals} heals), the bot took ${r1(onMe.reduce((s, h) => s + h.damage, 0))} (${fmtSeen(seen)})`,
        );
        health = [];
        await b.truth.cleanup();
      }
    }
  }, 600_000);

  it('weakness: a fist on a held zombie with and without weakness (bare, 4 hits each)', async () => {
    const b = bot!;
    const rows: string[] = [];
    for (const weak of [false, true]) {
      const c = await fresh(b);
      await setKit(b, 'bare');
      if (weak) await b.truth.effect(b.name, 'weakness', 30, 0);
      const z = await b.truth.summon('zombie', { x: c.x + 2, y: FEET_Y, z: c.z });
      await hold(b, z.entityId);
      await b.truth.effect(z.entityId, 'weakness', 60, 255);
      const rid = await tracked(b, z);
      const since = await b.truth.now();
      for (let i = 0; i < 4; i++) {
        const e = b.built.mobility!.world.entities.get(rid);
        const me = loopOf(b).state.pos;
        if (e) loopOf(b).setCommand({ yaw: yawTowards(e.pos.x - me.x, e.pos.z - me.z), pitch: 0, forward: 0, strafe: 0, sprint: false, jump: false, sneak: false });
        await sleep(150);
        b.pve.combat.attack(rid, { reach: 6 });
        await sleep(700);
      }
      loopOf(b).release();
      const hits = (await b.truth.hurtlog(since)).events.filter((h) => h.victimId === z.entityId);
      rows.push(`${weak ? 'weakness I' : 'no effect'}: ${hits.length} hits [${hits.map((h) => r1(h.damage)).join(' ')}]`);
      await b.truth.cleanup();
      await b.truth.ok('cleareffects', [b.name]).catch(() => undefined);
    }
    note(`weakness (a fist): ${rows.join('; ')}`);
  }, 120_000);

  it('arrow: archers held at 6 / 10 / 14, the bot standing, strafing, reversing at the release, behind a pillar, in a hole (bare, 15 s each)', async () => {
    const b = bot!;
    const plan: { shooter: string; d: number; mode: 'stand' | 'strafe' | 'reverse' | 'pillar' | 'hole' }[] = [];
    for (const d of [6, 10, 14]) for (const mode of ['stand', 'strafe', 'reverse'] as const) plan.push({ shooter: 'skeleton', d, mode });
    plan.push({ shooter: 'skeleton', d: 10, mode: 'pillar' }, { shooter: 'skeleton', d: 10, mode: 'hole' });
    for (const mode of ['stand', 'strafe', 'reverse', 'pillar'] as const) plan.push({ shooter: 'pillager', d: 10, mode });
    for (const p of plan) {
      const c = await fresh(b);
      await setKit(b, 'bare');
      const bx = Math.floor(c.x);
      const bz = Math.floor(c.z);
      if (p.mode === 'pillar') await fill(b, { x: bx + 1, y: FEET_Y, z: bz }, { x: bx + 1, y: FEET_Y + 1, z: bz }, 'cobblestone');
      if (p.mode === 'hole') {
        await fill(b, { x: bx, y: FEET_Y - 2, z: bz }, { x: bx, y: FEET_Y - 1, z: bz }, 'air');
        await b.truth.tp(b.name, { x: c.x, y: FEET_Y - 2, z: c.z }, 0, 0);
        await sleep(500);
      }
      const sk = await b.truth.summon(p.shooter, { x: c.x + p.d, y: FEET_Y, z: c.z });
      await hold(b, sk.entityId);
      const rid = await tracked(b, sk);
      const seenArrows = new Set<bigint>();
      let dir = 1;
      const off = loopOf(b).onBeforeStep(() => {
        const me = loopOf(b).state.pos;
        const e = b.built.mobility!.world.entities.get(rid);
        const yaw = e ? yawTowards(e.pos.x - me.x, e.pos.z - me.z) : 0;
        let strafe = 0;
        if (p.mode === 'strafe' || p.mode === 'reverse') {
          if (p.mode === 'reverse') {
            for (const [arid, x] of b.built.mobility!.world.entities) {
              if (x.type === 'minecraft:arrow' && !seenArrows.has(arid)) {
                seenArrows.add(arid);
                dir = -dir;
              }
            }
          }
          const side = me.z - c.z;
          if (side > 3) dir = -1;
          if (side < -3) dir = 1;
          strafe = dir;
        }
        loopOf(b).setCommand({ yaw, pitch: 0, forward: 0, strafe, sprint: strafe !== 0, jump: false, sneak: false });
      });
      const since = await b.truth.now();
      const at = await track(b, 15 * 20 + 40);
      const k = keeper(b);
      await sleep(15_000);
      off();
      loopOf(b).release();
      await k.stop();
      const ev = await log(b, since);
      const pos = await at(since);
      const fl = flights(ev, p.shooter, pos);
      // the lead: where the arrow's line at its spawn crosses the bot's x, against the bot's z then (blocks, signed by the
      // way the bot was moving: + = aimed ahead of it), and the bot's sideways speed (blocks a tick)
      const leads = fl
        .map((f) => {
          const me = pos(f.tick);
          const me2 = pos(f.tick + 5);
          if (!f.vel || !f.from || !me || !me2 || Math.abs(f.vel.x) < 1e-3) return '';
          const zAt = f.from.z + (f.vel.z * (me.x - f.from.x)) / f.vel.x;
          const v = (me2.z - me.z) / 5;
          const off = zAt - me.z;
          return Math.abs(v) < 0.02 ? `${r1(off)}` : `${r1(off * Math.sign(v))}@${v.toFixed(2)}`;
        })
        .filter(Boolean);
      const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
      note(
        `arrow ${p.shooter} at ${p.d} ${p.mode}: ${fl.length} shots, flight ticks [${fl.map((f) => f.ticks).join(' ')}], ended on [${fl.map((f) => `${f.on.replace('minecraft:', '')}${Number.isFinite(f.miss) ? ` ${r1(f.miss)}` : ''}`).join(', ')}], aim ahead of the bot [${leads.join(' ')}] blocks@speed, ${hurt.length} hurts (${r1(hurt.reduce((s, h) => s + h.damage, 0))})`,
      );
      await b.truth.cleanup();
    }
  }, 900_000);

  it('corner: a free skeleton at 10, the bot walking away behind a wall: the arrows once the line is broken (bare)', async () => {
    const b = bot!;
    const c = await fresh(b);
    await setKit(b, 'bare');
    const bx = Math.floor(c.x);
    const bz = Math.floor(c.z);
    // a wall 3 high along x from the bot's spot westwards, 1 north of it: the bot walks round its west end
    await fill(b, { x: bx - 6, y: FEET_Y, z: bz + 1 }, { x: bx + 1, y: FEET_Y + 2, z: bz + 1 }, 'cobblestone');
    const sk = await b.truth.summon('skeleton', { x: c.x + 6, y: FEET_Y, z: c.z - 8 });
    await tracked(b, sk);
    await sleep(1500);
    const since = await b.truth.now();
    const k = keeper(b);
    const t0 = Date.now();
    const r = await b.pve.walk({ type: 'block', p: { x: bx - 8, y: FEET_Y, z: bz + 8 } }, {}, 'probe corner');
    const walkS = r1((Date.now() - t0) / 1000);
    await sleep(10_000);
    await k.stop();
    const ev = await log(b, since);
    const shots = ev.filter((e) => e.kind === 'throw' && e.item === 'minecraft:skeleton');
    const hurt = (await b.truth.hurtlog(since)).events.filter((h) => h.victimName === b.name);
    const tickWalked = since + Math.round(walkS * 20);
    note(
      `corner: walk ${r.ok ? 'arrived' : 'failed'} in ${walkS} s; ${shots.length} shots (${shots.filter((s) => s.tick > tickWalked).length} after the bot was behind the wall), ${hurt.length} hurts (${r1(hurt.reduce((s, h) => s + h.damage, 0))}), ${hurt.filter((h) => h.tick > tickWalked).length} after`,
    );
    await b.truth.cleanup();
  }, 180_000);
});
