// e2e (tag @bds), Track F15 (docs/flight.md "Takeoff from a floor the walk reaches (Track F15)"): a trip out of a room in a
// building in the air. On bds-fly (flat, peaceful, fall damage ON, truth pack). One afk-task bot with the flight kit; a
// made-up building in a private area, the goal 300 blocks away on the ground:
//   roof     a room (11 standable cells, 3 high) whose only way out is a ladder in a wall column up to a closed hatch in its
//            ceiling, the ceiling a 9 x 8 roof platform 64 over the ground, under a wider roof 19 over the platform:
//            `!goto` from the room walks up the ladder onto the platform and takes off from its ledge
//   sky      the same building under the open sky
//   closed   the same building with no ladder and no hatch (truly closed): the truthful refusal
//   low      the building 11 over the ground (the platform's edges too low for a ledge takeoff), under the wider roof, with
//            longFalls off (so the walk does not drop off the platform onto the ground): the truthful refusal
// Each case runs FLY_FLOORS_N trips (default 10). FLY_FLOORS_CASES=roof,sky picks cases; FLY_FLOORS_OUT=<file> appends one
// JSON line per trip (the case, the replies, the seconds from the command to the takeoff and to the end, damage).
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, hdist, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const N = Number(process.env.FLY_FLOORS_N ?? 10);
const CASES = new Set((process.env.FLY_FLOORS_CASES ?? 'roof,sky,closed,low').split(',').filter(Boolean));
const OUT = process.env.FLY_FLOORS_OUT;

interface Trip {
  case: string;
  run: number;
  first: string | undefined;
  end: string | undefined;
  flew: boolean;
  takeoffS: number | undefined;
  /** the seconds from the command to the floor search (after the walk out and its glide down found no way); none: it never ran */
  floorsS: number | undefined;
  endS: number;
  damage: number;
  at: Vec3;
  decision: string[];
}

describe.skipIf(!E2E)('@bds fly: a takeoff from a floor the walk reaches (Track F15)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Floors');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    console.log(`[fly-floors e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  /** The building centred on (cx, cz), the room's floor feet at R. */
  async function build(cx: number, cz: number, R: number, o: { ladder: boolean; wide: boolean }): Promise<void> {
    const b = bot!;
    await teleport(b, { x: cx + 0.5, y: F, z: cz + 20.5 });
    const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string, ...states: string[]) => truthLoaded(b.truth, 'fill', [cx + x1, y1, cz + z1, cx + x2, y2, cz + z2, block, ...states]);
    // the room: walls and floor of stone, the interior 3 x 4 and 3 high (feet R .. R + 2)
    await fill(-2, R - 1, -2, 2, R + 2, 3, 'stone');
    await fill(-1, R, -1, 1, R + 2, 2, 'air');
    // the roof platform (the room's ceiling), 9 x 8, its top at R + 3 (feet on it at R + 4)
    await fill(-4, R + 3, -3, 4, R + 3, 4, 'stone');
    if (o.ladder) {
      // the ladder in the interior's corner column against the +x wall, up through the hatch's hole, a closed trapdoor on the platform over it
      await fill(1, R + 3, 2, 1, R + 3, 2, 'air');
      for (let y = R; y <= R + 3; y++) await truthLoaded(b.truth, 'setblock', [cx + 1, y, cz + 2, 'ladder', 'facing_direction=4']);
      await hatch(cx, cz, R);
    }
    // the wider roof 19 over the platform's feet
    if (o.wide) await fill(-14, R + 23, -14, 14, R + 23, 14, 'stone');
  }

  async function hatch(cx: number, cz: number, R: number): Promise<void> {
    await truthLoaded(bot!.truth, 'setblock', [cx + 1, R + 4, cz + 2, 'spruce_trapdoor', 'open_bit=false', 'direction=3', 'upside_down_bit=false']);
  }

  async function clear(cx: number, cz: number, R: number): Promise<void> {
    const b = bot!;
    await teleport(b, { x: cx + 0.5, y: F, z: cz + 20.5 });
    await truthLoaded(b.truth, 'fill', [cx - 14, R - 1, cz - 14, cx + 14, R + 23, cz + 14, 'air']);
  }

  async function trip(label: string, run: number, cx: number, cz: number, R: number, goal: Vec3, ladder: boolean): Promise<Trip> {
    const b = bot!;
    await b.command('!stop');
    await sleep(1000);
    const start: Vec3 = { x: cx - 0.5, y: R, z: cz - 0.5 };
    await teleport(b, start);
    if (ladder) await hatch(cx, cz, R);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    const t0 = Date.now();
    let takeoffAt: number | undefined;
    let floorsAt: number | undefined;
    let done = false;
    const watch = (async () => {
      while (!done) {
        if (takeoffAt === undefined && b.logs.slice(n0).some((l) => l.includes('flight: to '))) takeoffAt = Date.now();
        if (floorsAt === undefined && b.logs.slice(n0).some((l) => l.includes('the floors the walk reaches from'))) floorsAt = Date.now();
        await sleep(100);
      }
    })();
    await b.command(`!goto ${goal.x} ${goal.y} ${goal.z}`);
    const first = await b.reply((s) => s.startsWith('fly: ') || s.startsWith('flying') || s.startsWith('goto: ') || (s.startsWith('walking ') && s.includes('to take off from')), from, 30_000).catch(() => undefined);
    const end = await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('goto: '), from, 240_000).catch(() => undefined);
    const endS = (Date.now() - t0) / 1000;
    done = true;
    await watch;
    await sleep(500);
    // a trip of a second can end between two looks of the watch: the search's line, timed by its own stamp (else the end)
    if (floorsAt === undefined) {
      const l = b.logs.slice(n0).find((s) => s.includes('the floors the walk reaches from'));
      if (l) {
        const at = Date.parse(l.split(' ')[0] ?? '');
        floorsAt = Number.isFinite(at) ? at : t0 + endS * 1000;
      }
    }
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn) /, ''));
    const decision = logs.filter((l) => /takeoff-site search|floor|ledge takeoff|walking out|leg \d|no glide|flight: to |flight: landed|flight: ended|unreachable/.test(l)).map((l) => l.slice(0, 600));
    const t: Trip = { case: label, run, first, end, flew: takeoffAt !== undefined, takeoffS: takeoffAt !== undefined ? (takeoffAt - t0) / 1000 : undefined, floorsS: floorsAt !== undefined ? (floorsAt - t0) / 1000 : undefined, endS, damage: dmg.total, at: g.location, decision };
    if (OUT) appendFileSync(OUT, `${JSON.stringify(t)}\n`);
    notes.push(`${label} ${run}: ${b.said.slice(from).join(' | ')} | takeoff ${t.takeoffS?.toFixed(1) ?? '-'} s, end ${endS.toFixed(1)} s, damage ${dmg.total} | at ${g.location.x.toFixed(1)} ${g.location.y.toFixed(1)} ${g.location.z.toFixed(1)}`);
    return t;
  }

  async function series(label: string, dx: number, R: number, o: { ladder: boolean; wide: boolean; longFalls?: boolean }): Promise<Trip[]> {
    const b = bot!;
    const cx = area.x + dx;
    const cz = area.z + 100;
    const goal = { x: cx, y: F, z: cz + 300 };
    if (o.longFalls === false) b.settings.set('longFalls', false);
    await build(cx, cz, R, o);
    const out: Trip[] = [];
    try {
      for (let i = 1; i <= N; i++) out.push(await trip(label, i, cx, cz, R, goal, o.ladder));
    } finally {
      await b.command('!stop');
      await sleep(1000);
      await clear(cx, cz, R);
      if (o.longFalls === false) b.settings.set('longFalls', true);
      await teleport(b, home);
    }
    const flown = out.filter((t) => t.flew).length;
    const arrived = out.filter((t) => t.end?.startsWith('arrived at ')).length;
    const tk = out.filter((t) => t.takeoffS !== undefined).map((t) => t.takeoffS!);
    notes.push(`${label}: ${arrived}/${out.length} arrived, ${flown} flown, takeoff ${tk.length ? `${Math.min(...tk).toFixed(1)}-${Math.max(...tk).toFixed(1)} s (mean ${(tk.reduce((a, s) => a + s, 0) / tk.length).toFixed(1)})` : '-'}, damage ${out.reduce((a, t) => a + t.damage, 0)}`);
    return out;
  }

  it.skipIf(!CASES.has('roof'))('the room under a wider roof: the walk out finds no way, then up the ladder onto the platform and off its ledge', async () => {
    const out = await series('roof', 100, F + 60, { ladder: true, wide: true });
    for (const t of out) {
      expect(t.floorsS, JSON.stringify(t)).toBeDefined();
      expect(t.takeoffS!).toBeGreaterThan(t.floorsS!);
      expect(t.end, JSON.stringify(t)).toBe(`arrived at ${area.x + 100} ${F} ${area.z + 400}`);
      expect(t.flew).toBe(true);
      expect(t.damage).toBe(0);
      expect(hdist(t.at, { x: area.x + 100.5, z: area.z + 400.5 })).toBeLessThan(2.5);
    }
  }, 3_600_000);

  it.skipIf(!CASES.has('sky'))('the room under the open sky: as before the track (the walk out finds the roof and takes off; no floor search)', async () => {
    const out = await series('sky', 160, F + 60, { ladder: true, wide: false });
    for (const t of out) {
      expect(t.floorsS, JSON.stringify(t)).toBeUndefined();
      expect(t.decision.some((l) => l.includes('walking out towards')), JSON.stringify(t)).toBe(true);
      expect(t.end, JSON.stringify(t)).toBe(`arrived at ${area.x + 160} ${F} ${area.z + 400}`);
      expect(t.flew).toBe(true);
      expect(t.damage).toBe(0);
    }
  }, 3_600_000);

  it.skipIf(!CASES.has('closed'))('a room with no ladder: no takeoff from here or from any floor the walk reaches, said so', async () => {
    const out = await series('closed', 220, F + 60, { ladder: false, wide: true });
    for (const t of out) {
      expect(t.flew).toBe(false);
      expect(t.floorsS, JSON.stringify(t)).toBeDefined();
      expect(t.end, JSON.stringify(t)).toMatch(/^goto: unreachable/);
      expect(t.end).toMatch(/or from any floor the walk reaches/);
      expect(t.damage).toBe(0);
    }
  }, 3_600_000);

  it.skipIf(!CASES.has('low'))('the platform 11 over the ground (its edges too low for a ledge takeoff): the refusal, said so', async () => {
    const out = await series('low', 280, F + 7, { ladder: true, wide: true, longFalls: false });
    for (const t of out) {
      expect(t.flew).toBe(false);
      expect(t.floorsS, JSON.stringify(t)).toBeDefined();
      expect(t.end, JSON.stringify(t)).toMatch(/^goto: unreachable/);
      expect(t.end).toMatch(/or from any floor the walk reaches/);
      expect(t.damage).toBe(0);
    }
  }, 3_600_000);
});
