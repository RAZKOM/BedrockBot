// e2e (tag @bds), wave 11 Track BH (docs/flight.md "Glide down", "Ledge takeoff", "Prone after a glide"):
// on bds-fly (flat, peaceful, fall damage ON, truth pack). One afk-task bot:
//   pillar    a bedrock 3 x 3 pillar 40 high, the goal on the ground 60 blocks away (under flyMin), no
//             rockets: the walk finds no way, the bot glides down from an edge of the pillar and walks on
//   ledge     the same pillar, `!fly` 150 blocks away with rockets: no run for a jump, a ledge takeoff
//   noreach   a bedrock pillar 12 high, the goal 150 away, no rockets: no simulated glide lands there, the
//             owner is told and the walk failure stands (the bot stays on the pillar)
//   farm      the Realm farm replica (fly-overhang): the bot on the platform under the overhanging spawning
//             box, `!goto` a goal 400 away on the ground: steps off the platform edge, glides out from under
//             the box, climbs and flies, lands and walks
//   prone     the bot in a 1-high gap under persistent leaves (the crawl pose after a glide, the Realm
//             canopy 2026-10-31): `!goto` breaks the leaves over it, stands up and walks
// FLY_BH_SKIP=farm,prone skips cases. Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const SKIP = new Set((process.env.FLY_BH_SKIP ?? '').split(',').filter(Boolean));

interface Run {
  said: string[];
  logs: string[];
  flightLine: string | undefined;
  end: string | undefined;
  pos: Vec3;
  damage: number;
}

describe.skipIf(!E2E)('@bds fly: glide down and ledge takeoff (Track BH)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Bh');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    console.log(`[fly-glide-down e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string, ...states: string[]) =>
    truthLoaded(bot!.truth, 'fill', [x1, y1, z1, x2, y2, z2, block, ...states]);

  /** A command from `start` (teleported there, the kit given): its replies, the logs, the flight line, the truth position and damage. */
  async function run(label: string, start: Vec3, command: string, o: { rockets: number; endMs?: number; end: (s: string) => boolean }): Promise<Run> {
    const b = bot!;
    await b.command('!stop');
    await sleep(1500);
    await teleport(b, start);
    await giveFlightKit(b, { rockets: o.rockets });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(command);
    let end: string | undefined;
    try {
      end = await b.reply(o.end, from, o.endMs ?? 300_000);
    } catch {
      end = undefined;
    }
    await sleep(800);
    const said = b.said.slice(from);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn) /, ''));
    const flightLine = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const decisions = logs.filter((l) => /glide down|ledge|walk to .* ended|no glide|takeoff|walking out|leg \d|pose:|prone|landing for /.test(l));
    notes.push(
      `${label} (${((Date.now() - t0) / 1000).toFixed(0)} s): ${said.join(' | ')} | truth ${g.location.x.toFixed(1)} ${g.location.y.toFixed(1)} ${g.location.z.toFixed(1)} | damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${flightLine ?? 'no flight'} | ${decisions.join(' ; ')}`,
    );
    return { said, logs, flightLine, end, pos: g.location, damage: dmg.total };
  }

  const arrivedOrFailed = (s: string) => s.startsWith('arrived at ') || s.startsWith('walked to ') || s.startsWith('goto: ') || /failed|unreachable|no path|no progress/.test(s);

  /** A bedrock 3 x 3 pillar `up` high centred on (cx, cz); built while standing beside it. */
  async function pillar(cx: number, cz: number, up: number): Promise<void> {
    await teleport(bot!, { x: cx + 3.5, y: F, z: cz + 0.5 });
    await fill(cx - 1, F, cz - 1, cx + 1, F + up - 1, cz + 1, 'bedrock');
  }
  async function unpillar(cx: number, cz: number, up: number): Promise<void> {
    await teleport(bot!, { x: cx + 3.5, y: F, z: cz + 0.5 });
    await fill(cx - 1, F, cz - 1, cx + 1, F + up - 1, cz + 1, 'air');
    await teleport(bot!, home);
  }

  it.skipIf(SKIP.has('pillar'))('a 3 x 3 pillar 40 high, the goal on the ground 60 away, no rockets: glides down from the edge and walks on', async () => {
    const cx = area.x + 100;
    const cz = area.z + 100;
    await pillar(cx, cz, 40);
    const goal = { x: cx, y: F, z: cz + 60 };
    const r = await run('pillar', { x: cx + 0.5, y: F + 40, z: cz + 0.5 }, `!goto ${goal.x} ${goal.y} ${goal.z}`, { rockets: 0, end: (s) => s.startsWith('arrived at ') || s.startsWith('fly: no glide') || s.includes('failed') });
    expect(r.said.some((s) => s.startsWith('gliding down to '))).toBe(true);
    expect(r.logs.some((l) => l.includes('ledge takeoff'))).toBe(true);
    expect(r.flightLine).toMatch(/flight: (landed|ended)/);
    expect(r.end).toBe(`arrived at ${goal.x} ${goal.y} ${goal.z}`);
    expect(r.damage).toBe(0);
    await unpillar(cx, cz, 40);
  }, 600_000);

  it.skipIf(SKIP.has('ledge'))('the 3 x 3 pillar, !fly 150 away with rockets: a ledge takeoff (no run for a jump), landed', async () => {
    const cx = area.x + 200;
    const cz = area.z + 100;
    await pillar(cx, cz, 40);
    const goal = { x: cx, y: F, z: cz + 150 };
    const r = await run('ledge', { x: cx + 0.5, y: F + 40, z: cz + 0.5 }, `!fly ${goal.x} ${goal.y} ${goal.z}`, {
      rockets: 64,
      end: (s) => s.startsWith('landed') || s.includes('landed') || s.startsWith('fly: ') || s.startsWith('walked to ') || s.startsWith('arrived at '),
    });
    await until(() => (bot!.logs.some((l) => l.includes('flight: landed') || l.includes('flight: ended')) ? true : undefined), 120_000, 'the flight end').catch(() => undefined);
    const logs = bot!.logs.map((l) => l.replace(/^\S+ (info|warn) /, ''));
    expect(logs.some((l) => l.includes('ledge takeoff'))).toBe(true);
    const line = r.flightLine ?? logs.reverse().find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    expect(line).toMatch(/flight: landed/);
    const g = await bot!.truth.glide(bot!.name);
    expect(Math.abs(g.location.y - F)).toBeLessThan(0.6);
    expect(r.damage).toBe(0);
    await unpillar(cx, cz, 40);
  }, 600_000);

  it.skipIf(SKIP.has('noreach'))('a pillar 12 high, the goal 150 away, no rockets: no glide reaches, the owner is told and the walk failure stands', async () => {
    const cx = area.x + 300;
    const cz = area.z + 100;
    await pillar(cx, cz, 12);
    const goal = { x: cx, y: F, z: cz + 150 };
    const r = await run('noreach', { x: cx + 0.5, y: F + 12, z: cz + 0.5 }, `!goto ${goal.x} ${goal.y} ${goal.z}`, { rockets: 0, end: (s) => s.startsWith('fly: no glide down') });
    expect(r.end).toMatch(/^fly: no glide down to /);
    await until(() => bot!.said.slice(-3).find((s) => s !== r.end && arrivedOrFailed(s)), 20_000, 'the walk failure').catch(() => undefined);
    notes.push(`noreach after: ${bot!.said.slice(-3).join(' | ')}`);
    expect(r.flightLine).toBeUndefined();
    expect(Math.abs(r.pos.y - (F + 12))).toBeLessThan(0.6); // still on the pillar
    expect(r.damage).toBe(0);
    await unpillar(cx, cz, 12);
  }, 600_000);

  it.skipIf(SKIP.has('farm'))('the farm platform under the overhanging box, !goto 400 away and far lower: steps off the edge, glides out, flies and arrives', async () => {
    const b = bot!;
    const cx = area.x + 120;
    const cz = area.z + 400;
    const Y = F + 70;
    await teleport(b, { x: cx + 8.5, y: F, z: cz + 0.5 });
    // the platform, the shaft up to the box, the spawning box overhanging the platform on every side but +x (fly-overhang's replica)
    await fill(cx - 4, Y - 1, cz - 3, cx + 4, Y - 1, cz + 3, 'stone');
    await fill(cx - 4, Y, cz - 2, cx - 1, Y + 11, cz + 1, 'stone');
    await fill(cx - 3, Y, cz - 1, cx - 2, Y + 11, cz, 'air');
    await fill(cx - 26, Y + 12, cz - 15, cx + 5, Y + 23, cz + 14, 'stone');
    await fill(cx - 25, Y + 13, cz - 14, cx + 4, Y + 22, cz + 13, 'air');
    const goal = { x: cx + 400, y: F, z: cz };
    const r = await run('farm', { x: cx + 2.5, y: Y, z: cz + 0.5 }, `!goto ${goal.x} ${goal.y} ${goal.z}`, { rockets: 64, endMs: 420_000, end: arrivedOrFailed });
    expect(r.logs.some((l) => l.includes('ledge takeoff'))).toBe(true);
    expect(r.flightLine).toMatch(/flight: landed/);
    expect(r.end).toBe(`arrived at ${goal.x} ${goal.y} ${goal.z}`);
    expect(r.damage).toBe(0);
    await teleport(b, { x: cx + 8.5, y: F, z: cz + 0.5 });
    await fill(cx - 26, Y - 1, cz - 15, cx + 5, Y + 23, cz + 14, 'air');
    await teleport(b, home);
  }, 720_000);

  it.skipIf(SKIP.has('prone'))('prone in a 1-high gap under leaves: !goto breaks the leaves over it, stands up and walks', async () => {
    const b = bot!;
    const loop = b.built.mobility!.loop;
    const cx = area.x + 40;
    const cz = area.z + 200;
    await teleport(b, { x: cx + 8.5, y: F, z: cz + 0.5 });
    // a 1-high gap: persistent oak leaves at F + 1 over 7 x 7
    await fill(cx - 3, F + 1, cz - 3, cx + 3, F + 1, cz + 3, 'oak_leaves', 'persistent_bit=true');
    const how: string[] = [];
    const proneNow = async (ms: number): Promise<boolean> => {
      try {
        await until(() => (loop.state.prone ? true : undefined), ms, 'prone', 100);
        return true;
      } catch {
        return false;
      }
    };
    await b.command('!stop');
    await sleep(1000);
    // 1) teleported into the gap
    await teleport(b, { x: cx + 0.5, y: F, z: cz + 0.5 });
    let prone = await proneNow(3000);
    how.push(`teleport: ${prone ? 'prone' : 'standing'}`);
    if (!prone) {
      // 2) gliding into the gap: the kit, a glide started 6 up beside it, teleported in while gliding
      await giveFlightKit(b, { rockets: 0 });
      await teleport(b, { x: cx + 0.5, y: F + 12, z: cz + 10.5 }, 180);
      loop.setCommand({ yaw: 180, pitch: 20, forward: 1, glide: true, jump: true });
      await until(() => (loop.state.gliding ? true : undefined), 5000, 'gliding', 50).catch(() => undefined);
      await b.truth.tp(b.name, { x: cx + 0.5, y: F + 0.1, z: cz + 0.5 }, 180, 0);
      prone = await proneNow(3000);
      loop.setCommand({ yaw: 180, pitch: 0 });
      how.push(`glide then teleport: ${prone ? 'prone' : 'standing'} (gliding ${loop.state.gliding})`);
    }
    notes.push(`prone setup: ${how.join(', ')}`);
    if (!prone) {
      notes.push('prone: BDS never put the body prone here; the recovery is covered by the unit tests only');
      await fill(cx - 3, F + 1, cz - 3, cx + 3, F + 1, cz + 3, 'air');
      await teleport(b, home);
      return;
    }
    const goal = { x: cx, y: F, z: cz + 12 };
    const n0 = b.logs.length;
    const from = b.said.length;
    await b.command(`!goto ${goal.x} ${goal.y} ${goal.z}`);
    const end = await b.reply(arrivedOrFailed, from, 120_000).catch(() => undefined);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn) /, ''));
    notes.push(`prone: ${b.said.slice(from).join(' | ')} | ${logs.filter((l) => /prone|pose:|standing|dig |digging/.test(l)).join(' ; ')}`);
    expect(logs.some((l) => /goto: prone at .*standing again/.test(l))).toBe(true);
    expect(end).toBe(`arrived at ${goal.x} ${goal.y} ${goal.z}`);
    await fill(cx - 3, F + 1, cz - 3, cx + 3, F + 1, cz + 3, 'air');
    await teleport(b, home);
  }, 300_000);
});
