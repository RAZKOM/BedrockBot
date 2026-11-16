// Track M1 (docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): the server's own melee rules the reflex stands on,
// measured on bds-pve (BDS 1.26.60, difficulty normal) with the truth pack's meleelog / watch (packs/truth/src/combat.ts):
//   reach      a zombie held in place (slowness 255) at growing distances: which single attacks land (eye to box)
//   facing     the same zombie 2 blocks off with the bot looking 0 / 90 / 180 degrees away: do attacks land, and while walking away
//   hurt time  one attack every tick for 40 ticks on one zombie: the ticks the server takes a hit on
//   many       three zombies in reach attacked in the same tick: how many hits land that tick
//   knockback  fist, iron sword, Knockback I / II, a sprint hit: the zombie's displacement and its direction (from the bot,
//              or along the bot's view), facing it and facing away
//   mob reach  a free zombie hitting the bot that stands still: the distances of its hits (feet to feet)
//   eating     an attack during a bite: does it land, does the bite go on
//   critical   an attack while falling after a jump against one on the ground (fist)
// Every number is printed (`measurements:`); the asserts are only the facts the design stands on (an attack lands without
// facing the mob, the server takes one hit per mob per hurt time, several mobs can be hit in one tick).
// Needs BDS_E2E=1 and bds-pve with the truth pack. About 4 min.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it as vit } from 'vitest';
import { reachDistance } from '../../src/skills/combat/hostiles.ts';
import { EYE_HEIGHT } from '../../src/skills/combat/combat.ts';
import { yawTowards } from '../../src/skills/nav/follower.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, cleanSpot, E2E, FEET_Y, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, until, type MobInfo, type PveBot } from './pve-truth.ts';

interface MeleeRecord {
  tick: number;
  victimId: string;
  victimType: string;
  victimName: string | null;
  damagerType: string | null;
  damagerName: string | null;
  damage: number;
  cause: string;
  distance: number | null;
  hdistance: number | null;
  viewAngle: number | null;
  velocity: Vec3 | null;
}

interface Sample {
  tick: number;
  location: Vec3;
  velocity: Vec3;
}

const deg = (rad: number): number => (rad * 180) / Math.PI;
const angleBetween = (a: { x: number; z: number }, b: { x: number; z: number }): number => {
  const n = Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z);
  if (n < 1e-9) return NaN;
  return deg(Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.z * b.z) / n))));
};

describe.skipIf(!E2E)('pve: the server rules for melee (Track M1)', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const out: string[] = [];
  const note = (s: string): void => {
    console.log(s);
    out.push(s);
    if (process.env.RULES_OUT) appendFileSync(process.env.RULES_OUT, `${s}\n`, 'utf8');
  };
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: HOME.x - 96 + 24 * (i % 9), y: FEET_Y, z: HOME.z - 96 + 24 * Math.floor(i / 9) };
  };
  const melee = async (b: PveBot, since: number): Promise<MeleeRecord[]> => (await b.truth.ok<{ events: MeleeRecord[] }>('meleelog', [since, b.name], 20_000)).events;
  const watchlog = async (b: PveBot, ref: string, since: number): Promise<Sample[]> => (await b.truth.ok<{ samples: Sample[] }>('watchlog', [ref, since], 20_000)).samples;

  async function fresh(b: PveBot): Promise<Vec3> {
    const at = nextSpot();
    await b.truth.cleanup();
    await teleport(b, centre(at));
    await cleanSpot(b, at, { r: 10, entities: 24 }); // Track M5: clean ground whatever earlier runs left
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    return centre(at);
  }

  /** A zombie that cannot walk (slowness 255) nor hurt (weakness 255), with resistance so it survives many hits. */
  async function dummy(b: PveBot, at: Vec3, type = 'zombie'): Promise<{ mob: MobInfo; rid: bigint }> {
    const mob = await b.truth.summon(type, at);
    await b.truth.effect(mob.entityId, 'slowness', 300, 255);
    await b.truth.effect(mob.entityId, 'weakness', 300, 255);
    await b.truth.effect(mob.entityId, 'resistance', 300, 2);
    const rid = await tracked(b, mob);
    return { mob, rid };
  }

  const loopOf = (b: PveBot) => b.built.mobility!.loop;
  const eyeOf = (b: PveBot): Vec3 => {
    const p = loopOf(b).state.pos;
    return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
  };
  /** Hold the body still, looking `offset` degrees off the direction to `p`. */
  const look = (b: PveBot, p: Vec3, offset = 0, extra: Record<string, unknown> = {}): void => {
    const me = loopOf(b).state.pos;
    loopOf(b).setCommand({ yaw: yawTowards(p.x - me.x, p.z - me.z) + offset, pitch: 0, forward: 0, strafe: 0, sprint: false, jump: false, sneak: false, ...extra });
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startPveBot('PveRules');
    await teleport(bot, centre(HOME));
    await cleanSpot(bot, HOME, { r: 10, entities: 96 });
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('unequip', [bot.name]);
    bot.pve.setGuard({ on: false });
    bot.pve.settings.set('mobReflex', false); // the probe's own attacks only (the reflex would take the hurt time first)
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      loopOf(bot).release();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 128).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${out.join('\n  ')}`);
  });

  // RULES_ONLY=reach,shield,... runs only the named cases (the first word of each title)
  const only = (process.env.RULES_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const it = (title: string, fn: () => Promise<void>, ms?: number): void => {
    const key = title.split(/[: ]/)[0]!;
    (only.length && !only.includes(key) ? vit.skip : vit)(title, fn, ms);
  };

  it('reach: single attacks on a zombie held at growing distances', async () => {
    const b = bot!;
    const c = await fresh(b);
    const { mob, rid } = await dummy(b, { x: c.x + 2, y: FEET_Y, z: c.z });
    const rows: string[] = [];
    let maxLanded = 0;
    let minMissed = Infinity;
    for (const d of [2.5, 3.0, 3.4, 3.8, 4.2, 4.5, 4.8, 5.1, 5.5, 6.0, 6.5, 7.0, 8.0]) {
      const at = { x: c.x + d, y: FEET_Y, z: c.z };
      await b.truth.moveMob(mob.entityId, at);
      await until(() => {
        const e = b.built.mobility!.world.entities.get(rid);
        return e && Math.abs(e.pos.x - at.x) < 0.05 ? true : undefined;
      }, 5000, 'the zombie moved', 50);
      await loopOf(b).waitTicks(12);
      look(b, at);
      await loopOf(b).waitTicks(2);
      const e = b.built.mobility!.world.entities.get(rid)!;
      const r = reachDistance(eyeOf(b), e);
      const since = await b.truth.now();
      b.pve.combat.attack(rid, { reach: 10 });
      await sleep(700);
      const hits = (await melee(b, since)).filter((h) => h.damagerName === b.name && h.victimId === mob.entityId);
      if (hits.length) maxLanded = Math.max(maxLanded, r);
      else minMissed = Math.min(minMissed, r);
      rows.push(`${d.toFixed(1)} (eye to box ${r.toFixed(2)}): ${hits.length ? `hit (server ${hits[0]!.distance?.toFixed(2)} feet to feet)` : 'no hit'}`);
    }
    note(`reach (fist, zombie, feet ${FEET_Y}): ${rows.join('; ')}; landed up to eye-to-box ${maxLanded.toFixed(2)}, missed from ${minMissed.toFixed(2)}`);
    expect(maxLanded).toBeGreaterThan(2.9);
    await b.truth.cleanup();
  }, 120_000);

  it('facing: attacks land looking 0 / 90 / 180 degrees away, standing and walking away', async () => {
    const b = bot!;
    const rows: string[] = [];
    const landed: Record<string, boolean> = {};
    for (const [label, off, walk] of [['0', 0, false], ['90', 90, false], ['180', 180, false], ['180 walking away', 180, true]] as const) {
      const c = await fresh(b);
      const at = { x: c.x + 2, y: FEET_Y, z: c.z };
      const { mob, rid } = await dummy(b, at);
      look(b, at, off, walk ? { forward: 1 } : {});
      await loopOf(b).waitTicks(walk ? 3 : 4);
      const since = await b.truth.now();
      const e = b.built.mobility!.world.entities.get(rid)!;
      const r = reachDistance(eyeOf(b), e);
      b.pve.combat.attack(rid, { reach: 10 });
      await loopOf(b).waitTicks(2);
      loopOf(b).release();
      await sleep(700);
      const hits = (await melee(b, since)).filter((h) => h.damagerName === b.name && h.victimId === mob.entityId);
      landed[label] = hits.length > 0;
      rows.push(`${label}: ${hits.length ? `hit (server view angle ${hits[0]!.viewAngle ?? '?'} deg, reach ${r.toFixed(2)})` : `no hit (reach ${r.toFixed(2)})`}`);
      await b.truth.cleanup();
    }
    note(`facing (fist, zombie 2 blocks off): ${rows.join('; ')}`);
    expect(landed['180']).toBe(true);
  }, 120_000);

  it('hurt time: one attack every tick for 40 ticks on one zombie', async () => {
    const b = bot!;
    const c = await fresh(b);
    const at = { x: c.x + 2, y: FEET_Y, z: c.z };
    const { mob, rid } = await dummy(b, at);
    look(b, at);
    await loopOf(b).waitTicks(4);
    const since = await b.truth.now();
    let sent = 0;
    const off = loopOf(b).onBeforeStep(() => {
      if (sent >= 40) return;
      sent++;
      // the knockback moves it: put it back each tick so it stays in reach
      b.pve.combat.attack(rid, { reach: 10 });
    });
    const keep = setInterval(() => void b.truth.moveMob(mob.entityId, at).catch(() => undefined), 150);
    await until(() => (sent >= 40 ? true : undefined), 10_000, '40 attacks', 50);
    off();
    clearInterval(keep);
    await sleep(700);
    const hits = (await melee(b, since)).filter((h) => h.damagerName === b.name && h.victimId === mob.entityId);
    const gaps = hits.slice(1).map((h, i) => h.tick - hits[i]!.tick);
    note(`hurt time (fist, an attack every tick for 40 ticks): ${hits.length} hits land, gaps ${gaps.join(', ')} ticks`);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.length).toBeLessThanOrEqual(5);
    await b.truth.cleanup();
  }, 60_000);

  it('many: three zombies in reach attacked in the same tick', async () => {
    const b = bot!;
    const c = await fresh(b);
    const mobs: { mob: MobInfo; rid: bigint }[] = [];
    for (const [dx, dz] of [[2, 0], [-2, 0.5], [0.3, -2]] as const) mobs.push(await dummy(b, { x: c.x + dx, y: FEET_Y, z: c.z + dz }));
    await loopOf(b).waitTicks(4);
    const res: string[] = [];
    let best = 0;
    for (let round = 0; round < 3; round++) {
      await loopOf(b).waitTicks(12);
      const since = await b.truth.now();
      await new Promise<void>((resolve) => {
        const off = loopOf(b).onBeforeStep(() => {
          off();
          for (const m of mobs) b.pve.combat.attack(m.rid, { reach: 10 });
          resolve();
        });
      });
      await sleep(700);
      const hits = (await melee(b, since)).filter((h) => h.damagerName === b.name);
      const ticks = new Set(hits.map((h) => h.tick));
      best = Math.max(best, hits.length);
      res.push(`round ${round + 1}: ${hits.length} hits in ${ticks.size} tick(s)`);
    }
    note(`many targets (fist, 3 zombies in reach, one attack each in the same tick): ${res.join('; ')}`);
    expect(best).toBe(3);
    await b.truth.cleanup();
  }, 60_000);

  it('knockback: fist, iron sword, Knockback I / II, a sprint hit; facing the zombie and facing away', async () => {
    const b = bot!;
    const rows: string[] = [];
    const weapons: { label: string; item?: string; kb: number; sprint?: boolean }[] = [
      { label: 'fist', kb: 0 },
      { label: 'iron sword', item: 'iron_sword', kb: 0 },
      { label: 'iron sword KB I', item: 'iron_sword', kb: 1 },
      { label: 'iron sword KB II', item: 'iron_sword', kb: 2 },
      { label: 'fist sprinting', kb: 0, sprint: true },
      { label: 'iron sword KB II sprinting', item: 'iron_sword', kb: 2, sprint: true },
    ];
    for (const w of weapons) {
      for (const off of w.sprint ? [0] : [0, 180]) {
        const c = await fresh(b);
        await b.truth.ok('clear', [b.name]);
        if (w.item) await b.truth.ok('givekb', [b.name, w.item, w.kb, 0]);
        if (b.built.mobility!.world.inventory.selected !== 0) b.pve.hotbar.select(0);
        // a zombie that cannot walk (slowness 255) but takes knockback; no weakness needed: it is not near enough to hit back for long
        const at = { x: c.x + (w.sprint ? 4.5 : 2.2), y: FEET_Y, z: c.z };
        const mob = await b.truth.summon('zombie', at);
        await b.truth.effect(mob.entityId, 'slowness', 60, 255);
        await b.truth.effect(mob.entityId, 'resistance', 60, 2);
        await b.truth.effect(mob.entityId, 'weakness', 60, 255);
        const rid = await tracked(b, mob);
        await sleep(400);
        let hitTick = -1;
        const t0 = await b.truth.now();
        await b.truth.ok('watch', [mob.entityId, 40]);
        if (w.sprint) {
          // run at it, sprinting, and strike at 2.8 eye to box
          await new Promise<void>((resolve) => {
            let n = 0;
            const off2 = loopOf(b).onBeforeStep(() => {
              n++;
              const e = b.built.mobility!.world.entities.get(rid);
              if (!e) return;
              const me = loopOf(b).state.pos;
              loopOf(b).setCommand({ yaw: yawTowards(e.pos.x - me.x, e.pos.z - me.z), pitch: 0, forward: 1, sprint: true });
              if (n > 3 && reachDistance(eyeOf(b), e) < 2.8) {
                b.pve.combat.attack(rid, { reach: 10 });
                hitTick = n;
                off2();
                loopOf(b).release();
                resolve();
              } else if (n > 60) {
                off2();
                loopOf(b).release();
                resolve();
              }
            });
          });
        } else {
          look(b, at, off);
          await loopOf(b).waitTicks(4);
          b.pve.combat.attack(rid, { reach: 10 });
          hitTick = 0;
        }
        const me0 = { ...loopOf(b).state.pos };
        const yaw0 = loopOf(b).command.yaw;
        await sleep(2200);
        const samples = await watchlog(b, mob.entityId, t0);
        const hits = (await melee(b, t0)).filter((h) => h.damagerName === b.name && h.victimId === mob.entityId);
        if (!hits.length || samples.length < 3) {
          rows.push(`${w.label}${off ? ' facing away' : ''}: no hit (${hitTick < 0 ? 'never in reach' : 'refused'})`);
          await b.truth.cleanup();
          continue;
        }
        const h0 = hits[0]!;
        const before = samples.filter((s) => s.tick <= h0.tick).pop() ?? samples[0]!;
        const after = samples.filter((s) => s.tick > h0.tick);
        const end = after.filter((s) => s.tick <= h0.tick + 20).pop() ?? after[after.length - 1] ?? before;
        const disp = { x: end.location.x - before.location.x, z: end.location.z - before.location.z };
        const away = { x: before.location.x - me0.x, z: before.location.z - me0.z };
        const view = { x: -Math.sin((yaw0 * Math.PI) / 180), z: Math.cos((yaw0 * Math.PI) / 180) };
        const v1 = after[0]?.velocity ?? { x: 0, y: 0, z: 0 };
        rows.push(
          `${w.label}${off ? ' facing away' : ''}: pushed ${Math.hypot(disp.x, disp.z).toFixed(2)} blocks in 20 ticks (first tick ${Math.hypot(v1.x, v1.z).toFixed(3)} b/t level, ${v1.y.toFixed(3)} up), ${angleBetween(disp, away).toFixed(0)} deg off the line from the bot, ${angleBetween(disp, view).toFixed(0)} deg off the bot's view; damage ${h0.damage}`,
        );
        await b.truth.cleanup();
      }
    }
    note(`knockback (a zombie held by slowness 255; displacement over the 20 ticks after the hit): ${rows.join('; ')}`);
    await b.truth.ok('clear', [b.name]);
  }, 300_000);

  it('mobkb: a fist hit on each mob type (held by slowness 255): how far it goes', async () => {
    const b = bot!;
    const rows: string[] = [];
    await b.truth.ok('clear', [b.name]);
    for (const type of ['zombie', 'husk', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'pillager', 'enderman', 'slime', 'drowned', 'zombie_villager_v2']) {
      const c = await fresh(b);
      const at = { x: c.x + 2.2, y: FEET_Y, z: c.z };
      const mob = await b.truth.summon(type, at);
      await b.truth.effect(mob.entityId, 'slowness', 60, 255);
      await b.truth.effect(mob.entityId, 'resistance', 60, 2);
      await b.truth.effect(mob.entityId, 'weakness', 60, 255);
      const rid = await tracked(b, mob);
      await sleep(400);
      const t0 = await b.truth.now();
      await b.truth.ok('watch', [mob.entityId, 40]);
      const e = b.built.mobility!.world.entities.get(rid);
      if (e) look(b, e.pos);
      await loopOf(b).waitTicks(3);
      b.pve.combat.attack(rid, { reach: 10 });
      await sleep(2000);
      const samples = await watchlog(b, mob.entityId, t0);
      const hits = (await melee(b, t0)).filter((h) => h.damagerName === b.name && h.victimId === mob.entityId);
      if (!hits.length || samples.length < 3) {
        rows.push(`${type}: no hit`);
      } else {
        const before = samples.filter((s) => s.tick <= hits[0]!.tick).pop() ?? samples[0]!;
        const end = samples.filter((s) => s.tick > hits[0]!.tick && s.tick <= hits[0]!.tick + 20).pop() ?? before;
        rows.push(`${type} ${Math.hypot(end.location.x - before.location.x, end.location.z - before.location.z).toFixed(2)}`);
      }
      await b.truth.cleanup();
    }
    note(`knockback by mob type (fist, blocks in 20 ticks): ${rows.join('; ')}`);
  }, 300_000);

  it('shield: a raised shield (sneak) against a zombie coming from 0 / 45 / 90 / 135 / 180 degrees off the view', async () => {
    const b = bot!;
    const rows: string[] = [];
    for (const off of [0, 45, 90, 135, 180, -1]) {
      const c = await fresh(b);
      await b.truth.ok('clear', [b.name]);
      if (off >= 0) {
        await b.truth.ok('give', [b.name, 'shield', 1]);
        await until(async () => ((await b.truth.ok<{ offhand: { typeId: string } | null }>('stance', [b.name])).offhand?.typeId === 'minecraft:shield' ? true : undefined), 20_000, 'the shield in the offhand', 500);
      }
      const at = { x: c.x + 2.5, y: FEET_Y, z: c.z };
      const mob = await b.truth.summon('zombie', at);
      const rid = await tracked(b, mob);
      let swings = 0;
      let lastSwing = b.pve.mobs.get(rid)?.lastSwingAt;
      const off2 = loopOf(b).onBeforeStep(() => {
        const e = b.built.mobility!.world.entities.get(rid);
        if (!e) return;
        const me = loopOf(b).state.pos;
        loopOf(b).setCommand({ yaw: yawTowards(e.pos.x - me.x, e.pos.z - me.z) + Math.max(0, off), pitch: 0, forward: 0, strafe: 0, sprint: false, jump: false, sneak: off >= 0 });
        const sw = b.pve.mobs.get(rid)?.lastSwingAt;
        if (sw !== undefined && sw !== lastSwing) {
          swings++;
          lastSwing = sw;
        }
      });
      const since = await b.truth.now();
      await sleep(6000);
      off2();
      loopOf(b).release();
      const hurt = (await melee(b, since)).filter((h) => h.victimName === b.name && h.damagerType === 'minecraft:zombie');
      rows.push(`${off < 0 ? 'no shield (control)' : `${off} deg`}: ${swings} swings, ${hurt.length} hurt (${hurt.map((h) => h.damage.toFixed(1)).join(' ') || '-'})`);
      await b.truth.cleanup();
      await b.truth.setHealth(b.name, 20);
    }
    note(`shield (zombie on a bot sneaking, 6 s each): ${rows.join('; ')}`);
    await b.truth.ok('clear', [b.name]);
  }, 180_000);

  it('strike: does a strike while blocking let an arrow through (a skeleton 8 away, the shield up, a held zombie struck every N ticks)', async () => {
    const b = bot!;
    const rows: string[] = [];
    const all: number[] = [];
    const allBlocked: number[] = [];
    for (const [every, secs] of [
      [0, 45],
      [10, 45],
      [20, 45],
      [4, 45],
      [-1, 20],
    ] as const) {
      const c = await fresh(b);
      await b.truth.ok('clear', [b.name]);
      if (every >= 0) {
        await b.truth.ok('give', [b.name, 'shield', 1]);
        await until(async () => ((await b.truth.ok<{ offhand: { typeId: string } | null }>('stance', [b.name])).offhand?.typeId === 'minecraft:shield' ? true : undefined), 20_000, 'the shield in the offhand', 500);
      }
      await b.truth.effect(b.name, 'resistance', secs + 10, 3); // 80 % less: an arrow that gets through still shows, the bot lives
      const sk = await b.truth.summon('skeleton', { x: c.x + 8, y: FEET_Y, z: c.z });
      await b.truth.effect(sk.entityId, 'slowness', 300, 255);
      const skRid = await tracked(b, sk);
      // the held zombie 1.6 off the bot, 25 degrees off the line to the skeleton (inside the shield's arc, out of the arrows'
      // line), put back every second (the strikes knock it away)
      const zAt = { x: c.x + 1.45, y: FEET_Y, z: c.z + 0.68 };
      const z = await dummy(b, zAt);
      let n = 0;
      const strikeMs: number[] = [];
      const off2 = loopOf(b).onBeforeStep(() => {
        n++;
        const e = b.built.mobility!.world.entities.get(skRid);
        if (!e) return;
        const me = loopOf(b).state.pos;
        loopOf(b).setCommand({ yaw: yawTowards(e.pos.x - me.x, e.pos.z - me.z), pitch: 0, forward: 0, strafe: 0, sprint: false, jump: false, sneak: every >= 0 });
        if (every > 0 && n % every === 0 && b.pve.combat.attack(z.rid, { reach: 10 })) strikeMs.push(Date.now());
      });
      const back = setInterval(() => void b.truth.ok('movemob', [z.mob.entityId, zAt.x, zAt.y, zAt.z]).catch(() => undefined), 1000);
      const since = await b.truth.now();
      const ms0 = Date.now();
      await sleep(secs * 1000);
      clearInterval(back);
      off2();
      loopOf(b).release();
      // a strike's server tick: the wall clock against the server's 20 a second from the start (a tick or two either way)
      const strikeTicks = strikeMs.map((ms) => since + Math.round((ms - ms0) / 50));
      const arrows = (await b.truth.ok<{ events: { tick: number; kind: string; sneaking: boolean; shieldDamage: number | null }[] }>('blocklog', [since, b.name], 20_000)).events.filter((r) => r.kind === 'projectile');
      const hurt = (await melee(b, since)).filter((h) => h.victimName === b.name && h.cause === 'projectile');
      const since1 = (t: number): number => {
        const prev = strikeTicks.filter((x) => x <= t).pop();
        return prev === undefined ? 999 : t - prev;
      };
      const gaps = hurt.map((h) => since1(h.tick));
      const blockedGaps = arrows.filter((a) => !hurt.some((h) => Math.abs(h.tick - a.tick) <= 1)).map((a) => since1(a.tick));
      if (every > 0) {
        all.push(...gaps);
        allBlocked.push(...blockedGaps);
      }
      await b.truth.ok('cleareffects', [b.name]);
      rows.push(
        `${every < 0 ? 'no shield (control)' : every === 0 ? 'shield, no strikes' : `shield, a strike every ${every} ticks`} (${secs} s): ${strikeMs.length} strikes, ${arrows.length} arrows reached, ${hurt.length} hurt (${hurt.reduce((s2, h) => s2 + h.damage, 0).toFixed(1)}), ticks since the last strike at each hurt [${gaps.join(' ')}], at each blocked [${blockedGaps.join(' ')}]`,
      );
      await b.truth.cleanup();
      await b.truth.setHealth(b.name, 20);
    }
    const win = (k: number): string => `${all.filter((g) => g <= k).length} hurt / ${allBlocked.filter((g) => g <= k).length} blocked`;
    note(`strike while blocking (skeleton at 8): ${rows.join('; ')}; arrows within k ticks of a strike: k=2 ${win(2)}, k=4 ${win(4)}, k=6 ${win(6)}, k=10 ${win(10)}; later: ${all.filter((g) => g > 10).length} hurt / ${allBlocked.filter((g) => g > 10).length} blocked`);
    await b.truth.ok('clear', [b.name]);
  }, 600_000);

  it('creeper: where the fuse lights against a creeper walking in, and does a fist hit at reach keep it off', async () => {
    const b = bot!;
    const rows: string[] = [];
    // (a) the fuse: a free creeper walks in to the bot standing still; the distance when `ignited` first shows
    for (let i = 0; i < 2; i++) {
      const c = await fresh(b);
      const mob = await b.truth.summon('creeper', { x: c.x + 8, y: FEET_Y, z: c.z + (i ? 1 : -1) });
      const rid = await tracked(b, mob);
      let lit: number | undefined;
      await until(() => {
        const e = b.built.mobility!.world.entities.get(rid);
        if (e && b.pve.mobs.get(rid)?.ignited) {
          const me = loopOf(b).state.pos;
          lit = Math.hypot(e.pos.x - me.x, e.pos.y - me.y, e.pos.z - me.z);
          return true;
        }
        return undefined;
      }, 20_000, 'the fuse', 25).catch(() => undefined);
      rows.push(`walk-in ${i + 1}: lit at ${lit?.toFixed(2) ?? 'never'} (feet to feet)`);
      // get away before it blows: kill it from the truth side
      await b.truth.cleanup();
      await b.truth.setHealth(b.name, 20);
    }
    // (b) a fist hit every 10 ticks whenever it is within eye-to-box 3.9: does it ever light, how much damage
    {
      const c = await fresh(b);
      const mob = await b.truth.summon('creeper', { x: c.x + 8, y: FEET_Y, z: c.z });
      const rid = await tracked(b, mob);
      let last = -100;
      let n = 0;
      let lit = false;
      let strikes = 0;
      let closest = Infinity;
      const off = loopOf(b).onBeforeStep(() => {
        n++;
        const e = b.built.mobility!.world.entities.get(rid);
        if (!e) return;
        const me = loopOf(b).state.pos;
        closest = Math.min(closest, Math.hypot(e.pos.x - me.x, e.pos.z - me.z));
        if (b.pve.mobs.get(rid)?.ignited) lit = true;
        if (n - last >= 10 && reachDistance(eyeOf(b), e) <= 3.9) {
          b.pve.combat.attack(rid, { reach: 10 });
          last = n;
          strikes++;
        }
      });
      const since = await b.truth.now();
      await sleep(15_000);
      off();
      const hurt = (await melee(b, since)).filter((h) => h.victimName === b.name);
      const alive = (await b.truth.entity(mob.entityId)).valid !== false;
      rows.push(`kept off by fist hits at 3.9: ${strikes} strikes, fuse ${lit ? 'LIT' : 'never lit'}, closest ${closest.toFixed(2)} (level, feet), damage taken ${hurt.reduce((s, h) => s + h.damage, 0).toFixed(1)}, creeper ${alive ? 'alive' : 'dead'}`);
      await b.truth.cleanup();
      await b.truth.setHealth(b.name, 20);
    }
    note(`creeper: ${rows.join('; ')}`);
  }, 120_000);

  it('kite: a free zombie struck at eye-to-box 3.9 every 10 ticks (fist): hits taken in 20 s', async () => {
    const b = bot!;
    const rows: string[] = [];
    for (const reach of [3.0, 3.5, 3.9]) {
      const c = await fresh(b);
      await b.truth.ok('clear', [b.name]);
      const mob = await b.truth.summon('zombie', { x: c.x + 6, y: FEET_Y, z: c.z });
      const rid = await tracked(b, mob);
      let last = -100;
      let n = 0;
      let strikes = 0;
      let closest = Infinity;
      const off = loopOf(b).onBeforeStep(() => {
        n++;
        const e = b.built.mobility!.world.entities.get(rid);
        if (!e) return;
        const me = loopOf(b).state.pos;
        closest = Math.min(closest, Math.hypot(e.pos.x - me.x, e.pos.z - me.z));
        if (n - last >= 10 && reachDistance(eyeOf(b), e) <= reach) {
          b.pve.combat.attack(rid, { reach: 10 });
          last = n;
          strikes++;
        }
      });
      const since = await b.truth.now();
      await sleep(20_000);
      off();
      const hurt = (await melee(b, since)).filter((h) => h.victimName === b.name);
      rows.push(`reach ${reach}: ${strikes} strikes, ${hurt.length} hits taken (${hurt.reduce((s, h) => s + h.damage, 0).toFixed(1)} damage), closest ${closest.toFixed(2)}`);
      await b.truth.cleanup();
      await b.truth.setHealth(b.name, 20);
    }
    note(`kite (one zombie, fist, the bot standing still): ${rows.join('; ')}`);
  }, 120_000);

  it('mob reach: where a free zombie hits a bot standing still', async () => {
    const b = bot!;
    const dists: number[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await fresh(b);
      const since = await b.truth.now();
      const mob = await b.truth.summon('zombie', { x: c.x + 5, y: FEET_Y, z: c.z + (i - 1) });
      await tracked(b, mob);
      await until(async () => ((await melee(b, since)).filter((h) => h.victimName === b.name && h.damagerType === 'minecraft:zombie').length >= 2 ? true : undefined), 20_000, 'two zombie hits', 250);
      for (const h of (await melee(b, since)).filter((x) => x.victimName === b.name && x.damagerType === 'minecraft:zombie')) if (h.distance !== null) dists.push(h.distance);
      await b.truth.cleanup();
      await b.truth.setHealth(b.name, 20);
    }
    dists.sort((a, b2) => a - b2);
    note(`mob reach (zombie on the bot standing still, feet to feet 3D): ${dists.map((d) => d.toFixed(2)).join(', ')}`);
    expect(dists.length).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('eating: an attack during a bite', async () => {
    const b = bot!;
    const c = await fresh(b);
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'bread', 8]);
    await b.truth.ok('setfood', [b.name, 10, 0]);
    const at = { x: c.x + 2, y: FEET_Y, z: c.z };
    const { mob, rid } = await dummy(b, at);
    look(b, at);
    const kit = b.pve.kit?.();
    expect(kit).toBeDefined();
    const since = await b.truth.now();
    const eating = kit!.eat();
    await loopOf(b).waitTicks(12);
    b.pve.combat.attack(rid, { reach: 10 });
    const r = await eating;
    await sleep(700);
    const hits = (await melee(b, since)).filter((h) => h.damagerName === b.name && h.victimId === mob.entityId);
    const food = await b.truth.ok<{ food: number }>('food', [b.name]);
    note(`eating: attack 12 ticks into the bite ${hits.length ? 'landed' : 'did not land'}; the bite ${r.ok ? `finished (${r.item ?? '?'})` : `ended ${r.reason ?? '?'}`}; food 10 -> ${food.food}`);
    await b.truth.cleanup();
  }, 60_000);

  it('critical: a falling attack against one on the ground (iron sword)', async () => {
    const b = bot!;
    const rows: string[] = [];
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_sword', 1]);
    await until(() => (b.built.mobility!.world.inventory.slots.some((s) => s?.name === 'iron_sword') ? true : undefined), 5000, 'sword');
    b.pve.combat.selectWeapon();
    for (const falling of [false, true, false, true]) {
      const c = await fresh(b);
      const at = { x: c.x + 2, y: FEET_Y, z: c.z };
      const { mob, rid } = await dummy(b, at);
      look(b, at);
      await loopOf(b).waitTicks(4);
      const since = await b.truth.now();
      if (falling) {
        loopOf(b).setCommand({ jump: true });
        let peaked = false;
        await new Promise<void>((resolve) => {
          let n = 0;
          const off = loopOf(b).onBeforeStep((_t, s) => {
            n++;
            if (n === 2) loopOf(b).setCommand({ jump: false });
            const vy = (s as unknown as { vel?: Vec3 }).vel?.y ?? 0;
            if (n > 3 && vy < -0.1 && !peaked) {
              peaked = true;
              b.pve.combat.attack(rid, { reach: 10 });
              off();
              resolve();
            } else if (n > 30) {
              off();
              resolve();
            }
          });
        });
      } else b.pve.combat.attack(rid, { reach: 10 });
      await sleep(800);
      const hits = (await melee(b, since)).filter((h) => h.damagerName === b.name && h.victimId === mob.entityId);
      rows.push(`${falling ? 'falling' : 'standing'}: ${hits.length ? `${hits[0]!.damage} damage (resistance III on the zombie)` : 'no hit'}`);
      await b.truth.cleanup();
    }
    note(`critical (iron sword): ${rows.join('; ')}`);
    await b.truth.ok('clear', [b.name]);
  }, 120_000);
});
