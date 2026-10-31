// e2e (tag @bds), wave 11 Track BF (docs/flight.md "Landing v3"): flights end where the bot can walk to
// the goal, never in water; on bds-fly (flat, peaceful, fall damage ON, truth pack). One afk-task bot:
//   farm      the Realm's mob farm as a truth-built replica 300 blocks away: a 9 x 7 platform 70 over the
//             ground under a wide spawning box that overhangs it (12 blocks of headroom), a 4 x 4 shaft up
//             from the platform, a room under the platform with a ladder down from a hole (a bare hole:
//             the planner does not walk through an open trapdoor yet, Track BG); the goal is in the room.
//             `!goto` lands on the platform (in under the box along a corridor) and walks down the ladder
//   roof      a goal under a 41 x 41 roof 5 high: lands on the ground (not on the roof) and walks in
//   water     a goal in the middle of a pond: never lands in the water (lands on the shore)
//   seabed    the bot on the floor of a 10-deep pond: `!goto` to dry land swims up first (no start node
//             under water) and arrives; idle on the floor, the surface process swims up and walks out
//   sneak     the sneak measurements (docs/flight.md "Sneak at the touchdown"): sneak held while gliding
//             (does the glide end, corrections?), landings on a 3 x 3 pillar with and without sneak
// Every flight's go-arounds and rockets are noted (deliverable F: before / after); FLY_BF_SKIP=farm,roof
// skips cases. Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, hdist, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const SKIP = new Set((process.env.FLY_BF_SKIP ?? '').split(',').filter(Boolean));

interface Flight {
  said: string[];
  flightLine: string | undefined;
  rockets: number | undefined;
  goArounds: number | undefined;
  landedAt: Vec3 | undefined;
  arrived: string | undefined;
  pos: Vec3;
  damage: number;
  causes: string[];
  logs: string[];
}

function parseFlight(line: string | undefined): { rockets?: number; goArounds?: number; landedAt?: Vec3; corrections?: number; slide?: number } {
  if (!line) return {};
  const at = /at (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(line);
  const num = (re: RegExp) => {
    const m = re.exec(line);
    return m ? Number(m[1]) : undefined;
  };
  const out: { rockets?: number; goArounds?: number; landedAt?: Vec3; corrections?: number; slide?: number } = {};
  const r = num(/; (\d+) rockets/);
  if (r !== undefined) out.rockets = r;
  const g = num(/, (\d+) go-arounds/);
  if (g !== undefined) out.goArounds = g;
  const c = num(/, (\d+) corrections/);
  if (c !== undefined) out.corrections = c;
  const s = num(/slide ([\d.]+)/);
  if (s !== undefined) out.slide = s;
  if (at) out.landedAt = { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) };
  return out;
}

describe.skipIf(!E2E)('@bds fly: landing v3 (Track BF)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const stats: { label: string; rockets: number | undefined; goArounds: number | undefined }[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Bf');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    const per = stats.filter((s) => s.rockets !== undefined);
    const sum = (k: 'rockets' | 'goArounds') => per.reduce((a, s) => a + (s[k] ?? 0), 0);
    console.log(
      `[fly-overhang e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}\n  per landing: ${per.length ? `${(sum('rockets') / per.length).toFixed(1)} rockets, ${(sum('goArounds') / per.length).toFixed(2)} go-arounds over ${per.length} landings` : 'no landings'}`,
    );
  }, 60_000);

  async function gotoFlight(label: string, start: Vec3, command: string, o: { arriveMs?: number; expectArrive?: boolean } = {}): Promise<Flight> {
    const b = bot!;
    await b.command('!stop');
    await sleep(1500);
    await teleport(b, start);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    await b.command(command);
    await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('goto: '), from, 30_000);
    let arrived: string | undefined;
    try {
      arrived = await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('walked to ') || s.startsWith('goto: ') || /walk to .* failed/.test(s), from, o.arriveMs ?? 300_000);
    } catch (e) {
      if (o.expectArrive !== false) throw e;
    }
    await sleep(500);
    const said = b.said.slice(from);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ info /, ''));
    const flightLine = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    const p = parseFlight(flightLine);
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const decisions = logs.filter((l) => /landing for |go-around|holding|corridor|no landing|retarget|swam up|surface:/.test(l));
    notes.push(
      `${label}: ${said.join(' | ')} | truth ${g.location.x.toFixed(2)} ${g.location.y.toFixed(2)} ${g.location.z.toFixed(2)} | damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${flightLine ?? 'no flight'} | ${decisions.join(' ; ')}`,
    );
    stats.push({ label, rockets: p.rockets, goArounds: p.goArounds });
    return { said, flightLine, rockets: p.rockets, goArounds: p.goArounds, landedAt: p.landedAt, arrived, pos: g.location, damage: dmg.total, causes: dmg.causes, logs };
  }

  const blockName = async (p: Vec3): Promise<string> => {
    const r = await truthLoaded<{ typeId: string }>(bot!.truth, 'block', [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]);
    return r.typeId.replace(/^minecraft:/, '');
  };

  it.skipIf(SKIP.has('farm'))('the mob farm: lands on the platform under the overhanging box and walks down the ladder into the room', async () => {
    const b = bot!;
    const cx = area.x + 120;
    const cz = area.z + 300;
    const Y = F + 70;
    const goal = { x: cx, y: Y - 4, z: cz };
    await teleport(b, { x: cx + 8.5, y: F, z: cz + 0.5 });
    const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => truthLoaded(b.truth, 'fill', [cx + x1, y1, cz + z1, cx + x2, y2, cz + z2, block]);
    // the room under the platform
    await fill(-3, Y - 5, -3, 3, Y - 2, 3, 'stone');
    await fill(-2, Y - 4, -2, 2, Y - 2, 2, 'air');
    // the platform with the hole over the ladder
    await fill(-4, Y - 1, -3, 4, Y - 1, 3, 'stone');
    await fill(2, Y - 1, 0, 2, Y - 1, 0, 'air');
    for (let y = Y - 4; y <= Y - 1; y++) await truthLoaded(b.truth, 'setblock', [cx + 2, y, cz, 'ladder', 'facing_direction=4']);
    if (y0Trapdoor()) await truthLoaded(b.truth, 'setblock', [cx + 2, Y - 1, cz, 'trapdoor', 'open_bit=true', 'direction=0']);
    // the shaft up to the box
    await fill(-4, Y, -2, -1, Y + 11, 1, 'stone');
    await fill(-3, Y, -1, -2, Y + 11, 0, 'air');
    // the spawning box overhanging the platform
    await fill(-26, Y + 12, -15, 5, Y + 23, 14, 'stone');
    await fill(-25, Y + 13, -14, 4, Y + 22, 13, 'air');
    const start = { x: cx + 0.5, y: F, z: area.z + 0.5 };
    const r = await gotoFlight('farm', start, `!goto ${goal.x} ${goal.y} ${goal.z}`);
    expect(r.flightLine).toMatch(/flight: landed/);
    expect(r.landedAt!.y).toBeGreaterThan(Y - 0.6); // on the platform (not the ground, not the box)
    expect(r.landedAt!.y).toBeLessThan(Y + 0.6);
    expect(r.arrived).toBe(`arrived at ${goal.x} ${goal.y} ${goal.z}`);
    expect(Math.abs(r.pos.y - goal.y)).toBeLessThan(0.6);
    expect(r.damage).toBe(0);
    await teleport(b, { x: cx + 8.5, y: F, z: cz + 0.5 });
    await fill(-26, Y - 5, -15, 5, Y + 23, 14, 'air');
    await teleport(b, home);
  }, 480_000);

  it.skipIf(SKIP.has('roof'))('a goal under a big roof: lands on the ground, never on the roof, and walks in', async () => {
    const b = bot!;
    const cx = area.x + 200;
    const cz = area.z + 300;
    const goal = { x: cx, y: F, z: cz };
    await teleport(b, { x: cx + 0.5, y: F, z: cz + 0.5 });
    await truthLoaded(b.truth, 'fill', [cx - 20, F + 5, cz - 20, cx + 20, F + 5, cz + 20, 'stone']);
    for (const [px, pz] of [
      [-20, -20],
      [20, -20],
      [-20, 20],
      [20, 20],
    ] as const)
      await truthLoaded(b.truth, 'fill', [cx + px, F, cz + pz, cx + px, F + 4, cz + pz, 'stone']);
    const start = { x: cx + 0.5, y: F, z: area.z + 0.5 };
    const r = await gotoFlight('roof', start, `!goto ${goal.x} ${goal.y} ${goal.z}`);
    expect(r.flightLine).toMatch(/flight: landed/);
    expect(Math.abs(r.landedAt!.y - F)).toBeLessThan(0.6); // the ground, not the roof top (F + 6)
    expect(r.arrived).toBe(`arrived at ${goal.x} ${goal.y} ${goal.z}`);
    expect(r.damage).toBe(0);
    await truthLoaded(b.truth, 'fill', [cx - 20, F, cz - 20, cx + 20, F + 5, cz + 20, 'air']);
    await teleport(b, home);
  }, 480_000);

  it.skipIf(SKIP.has('water'))('a goal in the middle of a pond: lands on dry ground at the shore, not in the water', async () => {
    const b = bot!;
    const cx = area.x + 280;
    const cz = area.z + 300;
    await teleport(b, { x: cx + 0.5, y: F, z: cz + 0.5 });
    await truthLoaded(b.truth, 'fill', [cx - 15, F - 4, cz - 15, cx + 15, F - 1, cz + 15, 'water']);
    const goal = { x: cx, y: F - 1, z: cz };
    const start = { x: cx + 0.5, y: F, z: area.z + 0.5 };
    const r = await gotoFlight('water', start, `!goto ${goal.x} ${goal.y} ${goal.z}`, { expectArrive: false });
    expect(r.flightLine).toMatch(/flight: (landed|ended)/);
    const at = r.landedAt!;
    // dry: neither the feet cell nor the floor under them is water
    expect(await blockName({ x: at.x, y: at.y, z: at.z })).not.toMatch(/water/);
    expect(await blockName({ x: at.x, y: at.y - 1, z: at.z })).not.toMatch(/water/);
    expect(r.damage).toBe(0);
    await teleport(b, { x: cx + 0.5, y: F, z: cz + 20.5 });
    await truthLoaded(b.truth, 'fill', [cx - 15, F - 4, cz - 15, cx + 15, F - 4, cz + 15, 'bedrock']);
    await truthLoaded(b.truth, 'fill', [cx - 15, F - 3, cz - 15, cx + 15, F - 2, cz + 15, 'dirt']);
    await truthLoaded(b.truth, 'fill', [cx - 15, F - 1, cz - 15, cx + 15, F - 1, cz + 15, 'grass_block']);
    await teleport(b, home);
  }, 480_000);

  it.skipIf(SKIP.has('seabed'))('on the floor of a 10-deep pond: !goto swims up first and arrives; idle, the surface process swims up and walks out', async () => {
    const b = bot!;
    const cx = area.x + 40;
    const cz = area.z + 40;
    await teleport(b, { x: cx + 0.5, y: F, z: cz + 8.5 });
    await truthLoaded(b.truth, 'fill', [cx - 4, F - 10, cz - 4, cx + 4, F - 1, cz + 4, 'water']);
    await truthLoaded(b.truth, 'fill', [cx - 4, F - 11, cz - 4, cx + 4, F - 11, cz + 4, 'stone']);
    const floor = { x: cx + 0.5, y: F - 10, z: cz + 0.5 };
    // !goto from the floor
    await b.command('!stop');
    await sleep(500);
    await teleport(b, floor);
    const n0 = b.logs.length;
    const from = b.said.length;
    const target = { x: cx, y: F, z: cz + 12 };
    await b.command(`!goto ${target.x} ${target.y} ${target.z}`);
    const arrived = await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('goto: '), from, 90_000);
    const logs1 = b.logs.slice(n0).map((l) => l.replace(/^\S+ info /, ''));
    notes.push(`seabed goto: ${b.said.slice(from).join(' | ')} | ${logs1.filter((l) => /swam up|failure|surface:/.test(l)).join(' ; ')}`);
    expect(arrived).toBe(`arrived at ${target.x} ${target.y} ${target.z}`);
    // idle on the floor
    await teleport(b, floor);
    const n1 = b.logs.length;
    const t0 = Date.now();
    const out = await until(
      async () => {
        const g = await b.truth.glide(b.name);
        return g.location.y > F - 0.6 && g.isOnGround && hdist(g.location, { x: cx + 0.5, z: cz + 0.5 }) > 4.5 ? g : undefined;
      },
      60_000,
      'out of the pond',
      1000,
    );
    const logs2 = b.logs.slice(n1).map((l) => l.replace(/^\S+ (info|warn) /, ''));
    notes.push(`seabed idle: out at ${out.location.x.toFixed(1)} ${out.location.y.toFixed(1)} ${out.location.z.toFixed(1)} after ${((Date.now() - t0) / 1000).toFixed(0)} s | ${logs2.filter((l) => /surface:|drown/.test(l)).join(' ; ')}`);
    expect(logs2.some((l) => l.includes('surface: head under water'))).toBe(true);
    await truthLoaded(b.truth, 'fill', [cx - 4, F - 11, cz - 4, cx + 4, F - 5, cz + 4, 'stone']);
    await truthLoaded(b.truth, 'fill', [cx - 4, F - 4, cz - 4, cx + 4, F - 2, cz + 4, 'dirt']);
    await truthLoaded(b.truth, 'fill', [cx - 4, F - 1, cz - 4, cx + 4, F - 1, cz + 4, 'grass_block']);
    await teleport(b, home);
  }, 300_000);

  it.skipIf(SKIP.has('sneak'))('sneak measurements: sneak while gliding, landings on a 3 x 3 pillar with and without sneak', async () => {
    const b = bot!;
    const loop = b.built.mobility!.loop;
    const cx = area.x + 360;
    const cz = area.z + 300;
    const top = F + 30;
    await teleport(b, { x: cx + 0.5, y: F, z: cz + 0.5 });
    await truthLoaded(b.truth, 'fill', [cx - 1, F, cz - 1, cx + 1, top - 1, cz + 1, 'stone']);
    // 1) sneak held while gliding: 40 ticks forced on in the cruise
    {
      const start = { x: cx + 0.5, y: F, z: area.z + 0.5 };
      await b.command('!stop');
      await sleep(1000);
      await teleport(b, start);
      await giveFlightKit(b, { rockets: 64 });
      const from = b.said.length;
      const n0 = b.logs.length;
      await b.command(`!fly ${cx} ${top} ${cz}`);
      await until(() => (loop.state.gliding && loop.state.pos.y > F + 40 ? true : undefined), 60_000, 'gliding high', 100);
      await sleep(3000);
      const set = loop.setCommand.bind(loop);
      const c0 = loop.state.corrections;
      const samples: string[] = [];
      loop.setCommand = (c) => set({ ...c, sneak: true });
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        const g = await b.truth.glide(b.name);
        samples.push(`${g.isGliding ? 'G' : '-'}${g.velocity.y.toFixed(2)}`);
      }
      loop.setCommand = set;
      const c1 = loop.state.corrections;
      notes.push(`sneak while gliding (2 s): server gliding/vy ${samples.join(' ')}; client gliding ${loop.state.gliding}; corrections ${c1 - c0}`);
      await b.reply((s) => s.startsWith('fly: ') || s.startsWith('landed') || s.startsWith('walked to') || /landed/.test(s), from, 240_000).catch(() => undefined);
      await sleep(1000);
      const line = b.logs.slice(n0).find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
      notes.push(`sneak while gliding flight: ${line ?? '?'}`);
    }
    // 2) landings with and without sneak at the touchdown
    for (const sneak of [false, true, false, true]) {
      b.settings.set('flySneakLand', sneak);
      const start = { x: cx + 0.5, y: F, z: area.z + 0.5 };
      const r = await gotoFlight(`pillar ${sneak ? 'sneak' : 'no sneak'}`, start, `!fly ${cx} ${top} ${cz}`, { arriveMs: 240_000, expectArrive: false });
      const p = parseFlight(r.flightLine);
      const g = await b.truth.glide(b.name);
      notes.push(`pillar ${sneak ? 'sneak' : 'no sneak'}: on the pillar ${g.location.y > top - 0.6 ? 'yes' : 'NO'}, slide ${p.slide ?? '?'}, corrections ${p.corrections ?? '?'}, sneak key after ${String((loop.command as { sneak?: boolean }).sneak)}`);
    }
    b.settings.set('flySneakLand', true);
    await teleport(b, { x: cx + 3.5, y: F, z: cz + 0.5 });
    await truthLoaded(b.truth, 'fill', [cx - 1, F, cz - 1, cx + 1, top - 1, cz + 1, 'air']);
    await teleport(b, home);
  }, 1_200_000);
});

/** FLY_BF_TRAPDOOR=1: an open trapdoor in the farm's hole (the owner's farm; the planner refuses it until Track BG). */
function y0Trapdoor(): boolean {
  return process.env.FLY_BF_TRAPDOOR === '1';
}
