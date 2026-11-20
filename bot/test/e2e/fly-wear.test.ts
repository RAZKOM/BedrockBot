// e2e (tag @bds), Track F20 (docs/flight.md "A flight never outlasts its elytra (Track F20)"; decisions/0107): the elytra's
// uses against the trip, on bds-fly (flat, peaceful, fall damage on, truth pack). One afk-task bot:
//   far      an elytra with 58 uses left and `!goto` to a goal 99 km away at y 500 (the owner's command of 2026-11-18): no
//            flight, a reply that says why, no death
//   fits     the same elytra and a flight of 150 blocks: flown and landed
//   heights  (FLY_WEAR_HEIGHTS=1, also in the default run) a flight from a pillar 150 / 350 / 600 over the ground whose
//            elytra is swapped in the air for one at the covered limit: the worn landing dives and stands with uses to spare
//   unbreaking  (Track F21) 60 uses and a flight of 600 blocks: refused bare, flown with Unbreaking III
//   retarget    (Track F21) a `!goto` sent to a flight in the air whose elytra (swapped for 80 uses) does not cover it from
//               there: `...; landing here first`, the landing, the walk
//   wornwalk    (Track F21) a `!goto` flight whose elytra is swapped in the cruise for one at the worn limit: `landed (the
//               elytra is worn) at ...; walking the rest`, the walk
//   probe    (FLY_WEAR_PROBE=1 only) the server's uses a second of gliding, bare and with Unbreaking
//            (FLY_WEAR_PROBE_LEVELS=0,3 by default; FLY_WEAR_PROBE_RUNS flights each), and how far the bot's own count
//            lags the server's
// FLY_WEAR_BEFORE=1: the `far` case only records (the tree before the track flies, climbs and falls to its death).
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1, FLY_WEAR_NOTE=<file>.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { readKit } from '../../src/skills/fly/kit.ts';
import { wornLimitAt } from '../../src/skills/fly/wear.ts';
import { ENCH_UNBREAKING } from '../../src/skills/survival/tools.ts';
import { E2E, FEET_Y, flyCmd, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const BEFORE = process.env.FLY_WEAR_BEFORE === '1';
const PROBE = process.env.FLY_WEAR_PROBE === '1';
const ONLY = process.env.FLY_WEAR_ONLY;
const NOTE = process.env.FLY_WEAR_NOTE;

interface Sample {
  ms: number;
  tick: number;
  y: number;
  gliding: boolean;
  health: number | null;
  /** The server's uses left on the chest slot's elytra, and the bot's own count. */
  server: number | undefined;
  own: number | undefined;
}

describe.skipIf(!E2E)('@bds fly: a flight never outlasts its elytra (Track F20)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const note = (line: string): void => {
    notes.push(line);
    if (NOTE) appendFileSync(NOTE, `${line}\n`);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Wear');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.clearAround(home, 24).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[fly-wear e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  const ownLeft = (b: FlyBot): number | undefined => readKit(b.built.mobility!.world.inventory).elytraLeft;
  const sample = async (b: FlyBot, t0: number): Promise<Sample> => {
    const g = await b.truth.glide(b.name);
    const c = await b.truth.chestSlot(b.name).catch(() => null);
    return { ms: Date.now() - t0, tick: g.tick, y: g.location.y, gliding: g.isGliding, health: g.health, server: c?.typeId.endsWith('elytra') ? 432 - c.damage : undefined, own: ownLeft(b) };
  };
  /** Samples every `everyMs` until `done` says so or `maxMs` passed. */
  const watch = async (b: FlyBot, done: (s: Sample) => boolean, maxMs: number, everyMs = 400): Promise<Sample[]> => {
    const out: Sample[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const s = await sample(b, t0).catch(() => undefined);
      if (s) {
        out.push(s);
        if (done(s)) break;
      }
      await sleep(everyMs);
    }
    return out;
  };
  const died = (b: FlyBot, from: number): string | undefined => b.logs.slice(from).find((l) => /\bdied \(death/.test(l));
  /**
   * Track F21: the kit's elytra replaced by one with Unbreaking `level` and `damage` spent, in hotbar slot 1 (the kit reads
   * the first carried one): set there, held for /enchant (the server enchants the held item), the hotbar back on slot 0.
   */
  const enchantedElytra = async (b: FlyBot, level: number, damage: number): Promise<void> => {
    await b.truth.setslot(b.name, 9, 'air');
    await b.truth.setslot(b.name, 1, 'elytra', 1, damage);
    const inv = b.built.mobility!.world.inventory;
    await until(() => (inv.slots[1]?.name === 'elytra' ? true : undefined), 5000, 'the elytra in hotbar slot 1');
    b.task.pve!.hotbar.select(1);
    await b.built.mobility!.loop.waitTicks(10);
    await flyCmd('enchant', b.name, 'unbreaking', String(level));
    await until(() => (inv.slots[1]?.enchants?.some((e) => e.id === ENCH_UNBREAKING && e.lvl === level) ? true : undefined), 5000, `Unbreaking ${level} on the elytra in the inventory model`);
    b.task.pve!.hotbar.select(0);
    await b.built.mobility!.loop.waitTicks(10);
  };
  /** The server's uses a second of gliding over the samples (the server's ticks while its `gliding` flag was on), and the bot's count's largest lag. */
  const rate = (ss: Sample[]): { uses: number; glideS: number; perS: number; lag: number } => {
    let ticks = 0;
    let lag = 0;
    const gl = ss.filter((s) => s.server !== undefined);
    for (let i = 1; i < gl.length; i++) if (gl[i]!.gliding && gl[i - 1]!.gliding) ticks += gl[i]!.tick - gl[i - 1]!.tick;
    for (const s of gl) if (s.gliding && s.own !== undefined && s.server !== undefined) lag = Math.max(lag, s.own - s.server);
    const first = gl.find((s) => s.gliding);
    const last = [...gl].reverse().find((s) => s.gliding);
    const uses = first && last ? first.server! - last.server! : 0;
    return { uses, glideS: ticks / 20, perS: ticks > 0 ? uses / (ticks / 20) : 0, lag };
  };

  it.skipIf(ONLY !== undefined && ONLY !== 'far')('an elytra with 58 uses left and a goal 99 km away at y 500: no death', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: 432 - 58 });
    const from = b.said.length;
    const logFrom = b.logs.length;
    const since = (await b.truth.glide(b.name)).tick;
    await b.command(`!goto ${area.x + 70000} 500 ${area.z + 70000}`);
    const first = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('walking') || s.startsWith('goto: ') || s.startsWith('elytra'), from, 20_000);
    // the trip is watched until it stands again after a flight, dies, or 30 s of a walk have shown that nothing takes off
    let air = false;
    const ss = await watch(
      b,
      (s) => {
        if (s.gliding) air = true;
        return died(b, logFrom) !== undefined || (air && !s.gliding && s.y < F + 2) || (!air && s.ms > 30_000);
      },
      170_000,
    );
    const death = died(b, logFrom);
    const dmg = await b.truth.damageSince(since, b.name);
    const maxY = Math.max(...ss.map((s) => s.y));
    const lost = ss.findIndex((s, i) => i > 0 && ss[i - 1]!.gliding && !s.gliding && s.y > F + 20);
    const r = rate(ss);
    const end = b.logs.slice(logFrom).find((l) => /flight: (ended|landed)/.test(l));
    note(`far (${BEFORE ? 'before' : 'after'}): first reply "${first}"; flew ${air}; max y ${maxY.toFixed(1)}; ${lost >= 0 ? `the glide lost at y ${ss[lost]!.y.toFixed(1)} (${(ss[lost]!.y - F).toFixed(0)} over the ground) with ${ss[lost]!.server} uses left on the server, the bot's count ${ss[lost]!.own}` : 'the glide never lost in the air'}; ${death ? `DIED: ${death.replace(/^\S+ \S+ /, '')}` : 'no death'}; damage ${dmg.total.toFixed(1)} (${dmg.causes.join(', ') || 'none'}); server uses ${r.uses} in ${r.glideS.toFixed(1)} s of gliding (${r.perS.toFixed(2)} a second), the bot's count at most ${r.lag} behind; said: ${b.said.slice(from).join(' | ')}; ${end?.replace(/^\S+ \S+ /, '').slice(0, 260) ?? 'no flight line'}`);
    await b.command('!stop');
    await sleep(1500);
    if (BEFORE) return;
    expect(death).toBeUndefined();
    expect(dmg.total).toBe(0);
    expect(air).toBe(false);
    expect(b.said.slice(from).some((s) => s.includes('the elytra has 58 uses left'))).toBe(true);
  }, 240_000);

  /** The server's uses left on the elytra wherever the bot carries it (the chest slot, else the inventory). */
  const serverLeft = async (b: FlyBot): Promise<number | undefined> => {
    const d = await b.truth.ok<{ slots: { typeId: string; damage: number }[]; equipment: Record<string, { typeId: string; damage: number | null } | null> }>('durability', [b.name]);
    const chest = d.equipment.Chest;
    if (chest?.typeId.endsWith('elytra')) return 432 - (chest.damage ?? 0);
    const s = d.slots.find((x) => x.typeId.endsWith('elytra'));
    return s ? 432 - s.damage : undefined;
  };

  it.skipIf(ONLY !== undefined && ONLY !== 'fits')('an elytra with 70 uses left and a flight of 150 blocks: flown and landed, the count the server\'s', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: 432 - 70 });
    const from = b.said.length;
    const since = (await b.truth.glide(b.name)).tick;
    const target = { x: area.x, y: F, z: area.z + 150 };
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra'), from, 20_000);
    const end = start.startsWith('flying to ') ? await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 90_000) : start;
    await sleep(1500);
    const server = await serverLeft(b);
    const dmg = await b.truth.damageSince(since, b.name);
    note(`fits: ${start} -> ${end}; uses left after: the bot's count ${ownLeft(b)}, the server's ${server}; damage ${dmg.total.toFixed(1)}`);
    expect(start).toMatch(/^flying to /);
    expect(end).toMatch(/^landed at /);
    expect(dmg.total).toBe(0);
    // (the wear the server named while the body glided is in the model: before the track the count stayed at 70)
    if (!BEFORE) expect(Math.abs((ownLeft(b) ?? 0) - (server ?? -99))).toBeLessThanOrEqual(1);
  }, 150_000);

  it.skipIf(BEFORE || (ONLY !== undefined && ONLY !== 'short'))('an elytra with 100 uses left and a flight of 1500 blocks (the trip needs what is left): refused with the numbers', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: 432 - 100 });
    const from = b.said.length;
    await b.command(`!fly ${area.x} ${F} ${area.z + 1500}`);
    const r = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra'), from, 20_000);
    note(`short: ${r}`);
    expect(r).toMatch(/^fly: the elytra has 100 uses left \(30 kept for the landing\) and the trip of 1500 blocks needs about \d+: not flying; no spare that covers it \(carried, in the boxes or at home in reach\) \(walk: !goto\)$/); // Track K4: the refusal says no spare helped
    await sleep(1500);
    expect(b.fly.controller.active).toBe(false);
  }, 60_000);

  // ---- Track F21 ----------------------------------------------------------------------------------------------------------
  it.skipIf(BEFORE || (ONLY !== undefined && ONLY !== 'unbreaking'))('Unbreaking at the takeoff: 60 uses and a flight of 600 blocks: refused bare; an Unbreaking III elytra with the same uses flies it', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: 432 - 60 });
    const target = { x: area.x - 40, y: F, z: area.z + 600 };
    let from = b.said.length;
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const bare = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra'), from, 20_000);
    await sleep(1000);
    expect(b.fly.controller.active).toBe(false);
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: 432 - 60 });
    await enchantedElytra(b, 3, 432 - 60);
    from = b.said.length;
    const since = (await b.truth.glide(b.name)).tick;
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra'), from, 20_000);
    const end = start.startsWith('flying to ') ? await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 90_000) : start;
    await sleep(1500);
    const server = await serverLeft(b);
    const dmg = await b.truth.damageSince(since, b.name);
    note(`unbreaking: bare "${bare}"; Unbreaking III "${start}" -> "${end}"; uses left after: the server's ${server} (60 at the takeoff), the bot's count ${ownLeft(b)}; damage ${dmg.total.toFixed(1)}`);
    expect(bare).toMatch(/^fly: the elytra has 60 uses left \(30 kept for the landing\) and the trip of 60\d blocks needs about 5\d: not flying; no spare that covers it \(carried, in the boxes or at home in reach\) \(walk: !goto\)$/);
    expect(start).toMatch(/^flying to /);
    expect(end).toMatch(/^landed at /);
    expect(dmg.total).toBe(0);
    expect(server ?? 0).toBeGreaterThan(30);
  }, 200_000);

  it.skipIf(BEFORE || (ONLY !== undefined && ONLY !== 'retarget'))('a new trip sent to a flight in the air that the elytra does not cover from there: `...; landing here first`, a landing with no damage, then the walk', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: 0 });
    const from = b.said.length;
    const logFrom = b.logs.length;
    const since = (await b.truth.glide(b.name)).tick;
    await b.command(`!fly ${area.x + 80} ${F} ${area.z + 900}`);
    const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: '), from, 30_000);
    expect(start).toMatch(/^flying to /);
    // in the cruise: the elytra on the back becomes one with 80 uses (over the worn limit for the height: no worn landing)
    const g0 = await until(async () => {
      const g = await b.truth.glide(b.name);
      return g.isGliding && Math.hypot(g.location.x - home.x, g.location.z - home.z) > 120 && g.location.y > F + 15 ? g : undefined;
    }, 60_000, 'the body in the cruise');
    await b.truth.equip(b.name, 'Chest', 'elytra', 1, 432 - 80);
    await until(() => (ownLeft(b) === 80 ? true : undefined), 5000, 'the model\'s count of the swapped elytra');
    // a goal 1 500 blocks on from where the body is (the trip needs about 100: 50 over the limit do not cover it)
    const goal = { x: Math.floor(g0.location.x), z: Math.floor(g0.location.z) + 1500 };
    await b.command(`!goto ${goal.x} ${F} ${goal.z}`);
    const line = await b.reply((s) => s.includes('landing here first'), from, 20_000);
    const landed = await until(async () => {
      const g = await b.truth.glide(b.name);
      return !g.isGliding && g.location.y < F + 1.5 && !b.fly.controller.active ? g : undefined;
    }, 90_000, 'the landing');
    const end = b.logs.slice(logFrom).find((l) => /flight: (ended|landed)/.test(l));
    // the trip then starts from the ground: walked (the elytra does not cover it there either)
    const p0 = b.task.position()!;
    const walked = await until(() => {
      const p = b.task.position();
      return p && Math.hypot(goal.x - p.x, goal.z - p.z) < Math.hypot(goal.x - p0.x, goal.z - p0.z) - 4 ? p : undefined;
    }, 30_000, 'the walk towards the goal').then(() => true, () => false);
    await b.command('!stop');
    await sleep(1500);
    const dmg = await b.truth.damageSince(since, b.name);
    note(`retarget: swapped at ${(g0.location.y - F).toFixed(0)} over the ground, ${Math.hypot(g0.location.x - home.x, g0.location.z - home.z).toFixed(0)} out; "${line}"; standing at ${landed.location.x.toFixed(1)} ${landed.location.y.toFixed(1)} ${landed.location.z.toFixed(1)}, ${Math.hypot(landed.location.x - g0.location.x, landed.location.z - g0.location.z).toFixed(0)} blocks on; walked towards the goal: ${walked}; damage ${dmg.total.toFixed(1)}; said: ${b.said.slice(from).join(' | ')}; ${end?.replace(/^\S+ \S+ /, '').slice(0, 200) ?? 'no flight line'}`);
    expect(line).toMatch(/^fly: the elytra has 80 uses left \(30 kept for the landing\) and the trip of \d+ blocks needs about \d+: not flying; landing here first$/);
    expect(end).toMatch(/ended \(stopped\)/);
    expect(dmg.total).toBe(0);
    expect(walked).toBe(true);
    await teleport(b, home);
  }, 240_000);

  it.skipIf(BEFORE || (ONLY !== undefined && ONLY !== 'wornwalk'))('the walk after a worn landing in the air: `landed (the elytra is worn) at ...; walking the rest`, no damage, the walk towards the goal', async () => {
    const b = bot!;
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64, elytraDamage: 0 });
    const from = b.said.length;
    const logFrom = b.logs.length;
    const since = (await b.truth.glide(b.name)).tick;
    const goal = { x: area.x + 60, z: area.z - 700 };
    await b.command(`!goto ${goal.x} ${F} ${goal.z}`);
    // (`walking to ...` comes first: the walk starts and hands over to the flight)
    const start = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('goto: '), from, 30_000);
    expect(start).toMatch(/^flying/);
    const g0 = await until(async () => {
      const g = await b.truth.glide(b.name);
      return g.isGliding && Math.hypot(g.location.x - home.x, g.location.z - home.z) > 150 && g.location.y > F + 15 ? g : undefined;
    }, 60_000, 'the body in the cruise');
    // the elytra on the back becomes one at the limit the rule gives for that height: the worn landing at once
    const limit = wornLimitAt(30, g0.location.y - F);
    await b.truth.equip(b.name, 'Chest', 'elytra', 1, 432 - limit);
    const line = await b.reply((s) => s.startsWith('landed (the elytra is worn)'), from, 90_000);
    const landedAt = b.task.position()!;
    const walked = await until(() => {
      const p = b.task.position();
      return p && Math.hypot(goal.x - p.x, goal.z - p.z) < Math.hypot(goal.x - landedAt.x, goal.z - landedAt.z) - 4 ? p : undefined;
    }, 30_000, 'the walk towards the goal').then(() => true, () => false);
    await b.command('!stop');
    await sleep(1500);
    const end = b.logs.slice(logFrom).find((l) => /flight: (ended|landed)/.test(l));
    const dmg = await b.truth.damageSince(since, b.name);
    const server = await serverLeft(b);
    note(`wornwalk: swapped at ${(g0.location.y - F).toFixed(0)} over the ground for an elytra with ${limit} uses; "${line}"; ${Math.hypot(goal.x - landedAt.x, goal.z - landedAt.z).toFixed(0)} from the goal at the landing; walked towards it: ${walked}; uses left ${server}; damage ${dmg.total.toFixed(1)}; said: ${b.said.slice(from).join(' | ')}; ${end?.replace(/^\S+ \S+ /, '').slice(0, 200) ?? 'no flight line'}`);
    expect(line).toMatch(/^landed \(the elytra is worn\) at .+; walking the rest$/);
    expect(end).toMatch(/ended \(elytra_worn\)/);
    expect(dmg.total).toBe(0);
    expect(walked).toBe(true);
    await teleport(b, home);
  }, 240_000);

  // ---- the way down from three heights: the elytra swapped in the air for one at the covered limit ---------------------
  for (const h of BEFORE ? [] : ([{ name: '150', up: 150 }, { name: '350', up: 350 }, { name: 'climb', up: 0 }] as const)) {
    it.skipIf(ONLY !== undefined && ONLY !== 'heights' && ONLY !== `heights-${h.name}`)(`the worn landing from ${h.up ? `${h.up} over the ground` : 'a climb to 500 over the ground'}: a dive, standing with uses to spare, no damage`, async () => {
      const b = bot!;
      const base = { x: area.x + 40 + (h.up ? h.up : 0), z: area.z - 60 };
      let startAt: Vec3 = home;
      if (h.up) {
        // a 5 x 5 platform `up` over the ground, the bot on it
        const top = F + h.up;
        await teleport(b, { x: base.x + 0.5, y: top + 1, z: base.z + 0.5 });
        await truthLoaded(b.truth, 'fill', [base.x - 2, top - 1, base.z - 2, base.x + 2, top - 1, base.z + 2, 'stone']);
        startAt = { x: base.x + 0.5, y: top, z: base.z + 0.5 };
      }
      await teleport(b, startAt);
      await giveFlightKit(b, { rockets: 64, elytraDamage: 0 });
      const from = b.said.length;
      const logFrom = b.logs.length;
      const since = (await b.truth.glide(b.name)).tick;
      // a goal far enough that the flight is still on its way: from a platform a glide of 900 blocks; for the climb a goal 560
      // over the ground in the air (nothing to land on: the flight climbs to it and holds)
      await b.command(h.up ? `!fly ${base.x} ${F} ${base.z + 900}` : `!fly ${area.x} ${F + 560} ${area.z + 400}`);
      const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: '), from, 30_000);
      expect(start).toMatch(/^flying to /);
      // in the air and at the height: the elytra on the back becomes one at the limit the rule gives for that height
      const want = h.up ? h.up - 25 : 480;
      const g0 = await until(async () => {
        const g = await b.truth.glide(b.name);
        return g.isGliding && (h.up ? g.location.y < F + want && g.location.y > F + 60 : g.location.y > F + want) ? g : undefined;
      }, 90_000, 'the body gliding at the height');
      const over = g0.location.y - F;
      const limit = wornLimitAt(30, over);
      await b.truth.equip(b.name, 'Chest', 'elytra', 1, 432 - limit);
      const t0 = Date.now();
      let low = Infinity;
      let fastest = 0;
      const ss = await watch(
        b,
        (s) => {
          low = Math.min(low, s.server ?? Infinity);
          return !s.gliding && s.y < F + 1.5 && s.ms > 2000;
        },
        120_000,
        250,
      );
      for (let i = 1; i < ss.length; i++) if (ss[i]!.tick > ss[i - 1]!.tick) fastest = Math.max(fastest, (ss[i - 1]!.y - ss[i]!.y) / (ss[i]!.tick - ss[i - 1]!.tick));
      const secs = (Date.now() - t0) / 1000;
      await sleep(2500);
      const end = b.logs.slice(logFrom).find((l) => /flight: (ended|landed)/.test(l));
      const worn = b.logs.slice(logFrom).filter((l) => /flight: (elytra worn|worn dive)/.test(l)).map((l) => l.replace(/^\S+ \S+ flight: /, ''));
      const dmg = await b.truth.damageSince(since, b.name);
      const server = await serverLeft(b);
      const lost = ss.findIndex((s, i) => i > 0 && ss[i - 1]!.gliding && !s.gliding && s.y > F + 3);
      note(`heights ${h.name}: swapped at ${over.toFixed(0)} over the ground for an elytra with ${limit} uses (the limit there); down in ${secs.toFixed(1)} s, the fastest sink ${fastest.toFixed(2)} a tick; uses left on the server ${server} (lowest seen in the air ${Number.isFinite(low) ? low : '?'}), the bot's count ${ownLeft(b)}; damage ${dmg.total.toFixed(1)} (${dmg.causes.join(', ') || 'none'}); ${lost >= 0 ? `GLIDE LOST at ${(ss[lost]!.y - F).toFixed(0)} over` : 'the glide held to the ground'}; ${died(b, logFrom) ? 'DIED' : 'no death'}; ${worn.join(' | ')}; ${end?.replace(/^\S+ \S+ /, '').slice(0, 300) ?? 'no flight line'}`);
      await b.command('!stop');
      await sleep(1000);
      if (h.up) {
        await teleport(b, { x: base.x + 0.5, y: F + h.up + 1, z: base.z + 0.5 });
        await truthLoaded(b.truth, 'fill', [base.x - 2, F + h.up - 1, base.z - 2, base.x + 2, F + h.up - 1, base.z + 2, 'air']).catch(() => undefined);
        await teleport(b, home);
      }
      expect(died(b, logFrom)).toBeUndefined();
      expect(dmg.total).toBe(0);
      expect(lost).toBe(-1);
      expect(end).toMatch(/ended \(elytra_worn\)/);
      expect(worn.some((l) => l.startsWith('worn dive:'))).toBe(true);
      // with uses to spare: the tool wear limit's 10 are still on it
      expect(server ?? 0).toBeGreaterThanOrEqual(10);
    }, 300_000);
  }

  // ---- the server's rule: uses a second of gliding ---------------------------------------------------------------------
  // (Track F21: FLY_WEAR_PROBE_LEVELS: the Unbreaking levels probed, default `0,3`; FLY_WEAR_PROBE_RUNS flights a level)
  const probeLevels = (process.env.FLY_WEAR_PROBE_LEVELS ?? '0,3').split(',').map(Number);
  const probeRuns = Number(process.env.FLY_WEAR_PROBE_RUNS ?? 1);
  for (const [unbreaking, run] of PROBE ? probeLevels.flatMap((l) => Array.from({ length: probeRuns }, (_, i) => [l, i + 1] as const)) : []) {
    it.skipIf(ONLY !== undefined && ONLY !== 'probe')(`probe: the uses a second of gliding${unbreaking ? ` with Unbreaking ${unbreaking}` : ''}, and the lag of the bot's count (run ${run})`, async () => {
      const b = bot!;
      await teleport(b, home);
      await giveFlightKit(b, { rockets: 64, elytraDamage: Number(process.env.FLY_WEAR_PROBE_DAMAGE ?? 0) });
      let enchanted = 'bare';
      if (unbreaking) {
        await enchantedElytra(b, unbreaking, Number(process.env.FLY_WEAR_PROBE_DAMAGE ?? 0));
        enchanted = `enchants ${JSON.stringify(b.built.mobility!.world.inventory.slots[1]?.enchants ?? null)}`;
      }
      const from = b.said.length;
      const target = { x: area.x, y: F, z: area.z + 1500 };
      // what the server sends of the wear while the body glides
      const wire: string[] = [];
      const t00 = Date.now();
      const onAny = (name: string) => (p: unknown) => {
        const json = JSON.stringify(p, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
        const dmg = /"Damage":\{[^}]*\}/.exec(json)?.[0] ?? '';
        if (wire.length < 400) wire.push(`${((Date.now() - t00) / 1000).toFixed(1)}s ${name} ${name === 'player_armor_damage' ? json : dmg} own=${ownLeft(b)}`);
      };
      const h1 = onAny('player_armor_damage');
      const h2 = (p: { window_id?: unknown }) => {
        if (String(p.window_id) === 'armor' || p.window_id === 120) onAny('inventory_slot')(p);
      };
      const h3 = (p: { window_id?: unknown }) => {
        if (String(p.window_id) === 'armor' || p.window_id === 120) onAny('inventory_content')(p);
      };
      const h4 = onAny('mob_armor_equipment');
      (b.conn as unknown as { on(n: string, f: (p: never) => void): void }).on('player_armor_damage', h1);
      (b.conn as unknown as { on(n: string, f: (p: never) => void): void }).on('inventory_slot', h2);
      (b.conn as unknown as { on(n: string, f: (p: never) => void): void }).on('inventory_content', h3);
      (b.conn as unknown as { on(n: string, f: (p: never) => void): void }).on('mob_armor_equipment', h4);
      await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
      const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: '), from, 20_000);
      let air = false;
      const ss = await watch(
        b,
        (s) => {
          if (s.gliding) air = true;
          return air && !s.gliding && s.y < F + 2;
        },
        150_000,
        300,
      );
      const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 30_000).catch(() => 'no end line');
      const r = rate(ss);
      // the uses by the second of gliding, for the shape (every second or in steps)
      const steps = ss.filter((s, i) => i > 0 && s.server !== ss[i - 1]!.server).map((s) => `${(s.ms / 1000).toFixed(1)}s:${s.server}`);
      const byName = new Map<string, number>();
      for (const w of wire) byName.set(w.split(' ')[1]!, (byName.get(w.split(' ')[1]!) ?? 0) + 1);
      note(`probe (${enchanted}) wire: ${[...byName].map(([k, v]) => `${k} x${v}`).join(', ') || 'nothing'}; first: ${wire.slice(0, 24).join(' || ')}`);
      note(`probe (${enchanted}): ${start} -> ${end}; server uses ${r.uses} in ${r.glideS.toFixed(1)} s of gliding: ${r.perS.toFixed(3)} a second; the bot's count at most ${r.lag} behind the server's; steps ${steps.slice(0, 12).join(' ')} ... ${steps.slice(-4).join(' ')}`);
      expect(air).toBe(true);
    }, 240_000);
  }

  // ---- the glide lost in the air anyway: what the body can still do (FLY_WEAR_PROBE=1, FLY_WEAR_ONLY=lost) -----------------
  // An elytra at its last uses is put on the back in the air: the server ends the glide a second or two later. With a water
  // bucket in the hotbar (FLY_WEAR_BUCKET=0: without) the fall is the fall guard's. Each height FLY_WEAR_RUNS times (3).
  for (const up of PROBE ? (process.env.FLY_WEAR_UPS ?? '100,200,350').split(',').map(Number) : []) {
    it.skipIf(ONLY !== 'lost')(`probe: the glide lost ${up} over the ground${process.env.FLY_WEAR_BUCKET === '0' ? '' : ', a water bucket in the hotbar'}`, async () => {
      const b = bot!;
      const bucket = process.env.FLY_WEAR_BUCKET !== '0';
      const base = { x: area.x + 80 + up, z: area.z + 120 };
      const top = F + up;
      for (let run = 0; run < Number(process.env.FLY_WEAR_RUNS ?? 3); run++) {
        await teleport(b, { x: base.x + 0.5, y: top + 1, z: base.z + 0.5 });
        await truthLoaded(b.truth, 'fill', [base.x - 2, top - 1, base.z - 2, base.x + 2, top - 1, base.z + 2, 'stone']);
        await teleport(b, { x: base.x + 0.5, y: top, z: base.z + 0.5 });
        await giveFlightKit(b, { rockets: 64, elytraDamage: 0 });
        if (bucket) await b.truth.setslot(b.name, 1, 'water_bucket', 1);
        // (FLY_WEAR_LOSTEND=0: the flight goes on asking for the glide, as before the track)
        (b.fly.controller as unknown as { d: { lostGlideEnds?: boolean } }).d.lostGlideEnds = process.env.FLY_WEAR_LOSTEND !== '0';
        await sleep(600);
        const from = b.said.length;
        const logFrom = b.logs.length;
        const since = (await b.truth.glide(b.name)).tick;
        await b.command(`!fly ${base.x} ${F} ${base.z + 900}`);
        await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: '), from, 30_000);
        const g0 = await until(async () => {
          const g = await b.truth.glide(b.name);
          return g.isGliding && g.location.y < F + up - 12 ? g : undefined;
        }, 60_000, 'the body gliding');
        await b.truth.equip(b.name, 'Chest', 'elytra', 1, 430);
        let lostY: number | undefined;
        let x0: { x: number; z: number } | undefined;
        let drift = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < 60_000) {
          const g = await b.truth.glide(b.name);
          if (!g.isGliding && lostY === undefined && g.location.y > F + 3) {
            lostY = g.location.y;
            x0 = { x: g.location.x, z: g.location.z };
          }
          if (x0) drift = Math.max(drift, Math.hypot(g.location.x - x0.x, g.location.z - x0.z));
          if ((g.isOnGround || g.location.y < F + 1.2) && lostY !== undefined) break;
          if (died(b, logFrom)) break;
          await sleep(120);
        }
        await sleep(3000);
        const dmg = await b.truth.damageSince(since, b.name);
        const g1 = await b.truth.glide(b.name);
        const lines = b.logs.slice(logFrom).filter((l) => /clutch|the glide is lost|fall guard|died \(/.test(l)).map((l) => l.replace(/^\S+ \S+ /, '').slice(0, 200));
        note(`lost ${up} run ${run + 1}${bucket ? ' (bucket)' : ' (no bucket)'}${process.env.FLY_WEAR_LOSTEND === '0' ? ' (the flight goes on asking, as before)' : ''}: said ${b.said.slice(from).filter((x) => x.startsWith('fly: the glide')).join(' | ') || '-'}; the elytra swapped at ${(g0.location.y - F).toFixed(0)} over, the glide lost at ${lostY !== undefined ? (lostY - F).toFixed(0) : '?'} over; drift in the fall ${drift.toFixed(1)}; damage ${dmg.total.toFixed(1)} (${dmg.causes.join(', ') || 'none'}); health ${g1.health}; ${died(b, logFrom) ? 'DIED' : 'alive'}; ${lines.join(' | ')}`);
        await b.command('!stop');
        await sleep(2500);
        await teleport(b, { x: base.x + 0.5, y: top + 1, z: base.z + 0.5 });
        await truthLoaded(b.truth, 'fill', [base.x - 2, top - 1, base.z - 2, base.x + 2, top - 1, base.z + 2, 'air']).catch(() => undefined);
        await teleport(b, home);
        await b.truth.clearAround({ x: base.x, y: F, z: base.z + 40 }, 48).catch(() => undefined);
      }
    }, 600_000);
  }

  it.skipIf(!PROBE || (ONLY !== undefined && ONLY !== 'armor'))('probe: which slot a player_armor_damage entry names, and what its damage is', async () => {
    const b = bot!;
    await teleport(b, home);
    await b.truth.ok('clear', [b.name]);
    await b.truth.setHealth(b.name, 20);
    await b.truth.equip(b.name, 'Head', 'iron_helmet', 1, 10);
    await b.truth.equip(b.name, 'Chest', 'iron_chestplate', 1, 20);
    await b.truth.equip(b.name, 'Legs', 'iron_leggings', 1, 30);
    await b.truth.equip(b.name, 'Feet', 'iron_boots', 1, 40);
    await sleep(1500);
    const wire: string[] = [];
    (b.conn as unknown as { on(n: string, f: (p: unknown) => void): void }).on('player_armor_damage', (p) => wire.push(JSON.stringify(p)));
    const armour = (): string => JSON.stringify((b.built.mobility!.world.inventory.window(120)?.slots ?? []).map((s) => (s ? `${s.name}:${s.damage ?? 0}` : null)));
    const before = armour();
    for (let i = 0; i < 3; i++) {
      await flyCmd('damage', b.name, '4', 'entity_attack');
      await sleep(900);
    }
    await sleep(1000);
    const d = await b.truth.ok<{ equipment: Record<string, { typeId: string; damage: number } | null> }>('durability', [b.name]);
    note(`armor probe: the model's armour before ${before}, after ${armour()}; the server's ${JSON.stringify(Object.fromEntries(Object.entries(d.equipment).map(([k, v]) => [k, v ? v.damage : null])))}; packets: ${wire.join(' ')}`);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('clear', [b.name]);
    for (const s of ['Head', 'Chest', 'Legs', 'Feet'] as const) await b.truth.equip(b.name, s, 'air').catch(() => undefined);
  }, 60_000);

  void truthLoaded;
});
