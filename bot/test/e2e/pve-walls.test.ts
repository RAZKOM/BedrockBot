// Track AO (wave 9, docs/pve.md "Path-reachable targets", decision 0036) on bds-pve (difficulty normal,
// midnight): the owner reported the bot getting stuck fighting mobs behind walls on its way to places.
// Guard on (radius 16), iron armour and an iron sword, food 20; each run on a fresh spot of a random
// 256-block cell from x, z = 8192, its mobs summoned with a per-run tag (pve-truth.ts):
//   (a) wall: a zombie 4 blocks from the bot in a closed 3-high glass pen (the wall 2 blocks from the
//       bot), then `!goto` 30 blocks past it: the walk arrives within 40 s, no fight starts (stats.fights
//       unchanged) and the zombie is on the ignore list with a reason;
//   (b) window: the same pen beside the route with a 1-block window towards it: the bot could hit
//       through the window but not reach the zombie: the walk arrives within 40 s, and every guard fight
//       that starts has the zombie within reach (eye to box) at its start;
//   (c) open: a zombie in the open 5 blocks off the route walks up to the bot during the walk: it is
//       fought (pve-combat's regression in the walking case), then the walk arrives.
// The probe costs (PathReach.stats) are printed. PVE_WALLS_OLD=1 runs with `guardReach 0` and
// `guardWhileWalking all` (the terrain rule; the fast failure stays) for comparison: then only the
// measurements count, the expectations of (a) and (b) are not checked.
// Needs BDS_E2E=1 and bds-pve with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EYE_HEIGHT } from '../../src/skills/combat/combat.ts';
import { reachDistance } from '../../src/skills/combat/hostiles.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, E2E, FEET_Y, fill, hdist, prepareServer, privateArea, pveCmd, sleep, startPveBot, teleport, tracked, until, type MobInfo, type PveBot } from './pve-truth.ts';

const OLD = process.env.PVE_WALLS_OLD === '1';

describe.skipIf(!E2E)('pve: guard and walls on the way (Track AO)', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  let spot = 0;
  /** A fresh route start (the route runs 30 blocks along +x; pens on its -z side). */
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: HOME.x - 100 + 50 * (i % 4), y: FEET_Y, z: HOME.z - 90 + 30 * Math.floor(i / 4) };
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startPveBot('PveWalls');
    const b = bot;
    if (OLD) {
      b.pve.settings.set('guardReach', 0);
      b.pve.settings.set('guardWhileWalking', 'all');
    }
    await teleport(b, centre(HOME));
    await b.truth.clearAround(centre(HOME), 128);
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('unequip', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_sword', 1]);
    for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await b.truth.ok('give', [b.name, piece, 1]);
    await until(
      async () => {
        const eq = (await b.truth.ok<{ equipment: Record<string, { typeId: string } | undefined> }>('durability', [b.name])).equipment;
        return eq.Head?.typeId === 'minecraft:iron_helmet' && eq.Chest && eq.Legs && eq.Feet ? true : undefined;
      },
      20_000,
      'iron armour worn',
      500,
    );
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 160).catch(() => undefined);
      await bot.truth.ok('unequip', [bot.name]).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  });

  /** A closed 3-high glass pen with a 3 x 3 floor around cell `c` (walls 2 from it); `window`: a 1-block hole at head height in the +z wall. */
  async function pen(b: PveBot, c: { x: number; z: number }, window: boolean): Promise<void> {
    await fill(b, { x: c.x - 2, y: FEET_Y, z: c.z - 2 }, { x: c.x + 2, y: FEET_Y + 2, z: c.z + 2 }, 'glass');
    await fill(b, { x: c.x - 1, y: FEET_Y, z: c.z - 1 }, { x: c.x + 1, y: FEET_Y + 2, z: c.z + 1 }, 'air');
    if (window) await fill(b, { x: c.x, y: FEET_Y + 1, z: c.z + 2 }, { x: c.x, y: FEET_Y + 1, z: c.z + 2 }, 'air');
  }

  async function unpen(b: PveBot, c: { x: number; z: number }): Promise<void> {
    await fill(b, { x: c.x - 2, y: FEET_Y, z: c.z - 2 }, { x: c.x + 2, y: FEET_Y + 2, z: c.z + 2 }, 'air').catch(() => undefined);
  }

  async function freshStart(b: PveBot): Promise<Vec3> {
    const at = nextSpot();
    await b.truth.cleanup();
    await b.truth.clearAround(centre(at), 40);
    b.pve.stop();
    await teleport(b, centre(at));
    b.task.home!.set(undefined);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    await b.truth.setHealth(b.name, 20);
    await until(() => (b.pve.health() >= 20 ? true : undefined), 5_000, 'health 20');
    b.pve.setGuard({ on: true, radius: 16 });
    return at;
  }

  interface WalkRun {
    arrivedMs: number | undefined;
    fights: number;
    /** Zombie reach (eye to box, world model) at the start of each guard fight seen. */
    startReach: number[];
    behaviours: string[];
  }

  /** `!goto` the route's end (console tell), sample until there or `limitMs`. */
  async function walkRoute(b: PveBot, start: Vec3, zombie: bigint | (() => Promise<bigint>), limitMs: number): Promise<WalkRun> {
    const end = { x: start.x + 30, y: FEET_Y, z: start.z };
    const fights0 = b.pve.stats.fights;
    const startReach: number[] = [];
    const behaviours = new Set<string>();
    let fighting = false;
    const t0 = Date.now();
    await pveCmd('tell', b.name, '!goto', String(end.x), String(end.y), String(end.z));
    // a mob summoned once the walk runs (the walking rule decides about it)
    const zombieRid = typeof zombie === 'bigint' ? zombie : await zombie();
    let arrivedMs: number | undefined;
    while (Date.now() - t0 < limitMs) {
      const beh = b.pve.behaviour();
      behaviours.add(beh.replace(/\d+ blocks left.*/, ''));
      const now = beh.startsWith('fighting');
      if (now && !fighting) {
        const e = b.built.mobility!.world.entities.get(zombieRid);
        const p = b.task.position();
        if (e && p) startReach.push(+reachDistance({ x: p.x, y: p.y + EYE_HEIGHT, z: p.z }, e).toFixed(2));
      }
      fighting = now;
      const p = b.task.position();
      if (p && hdist(p, centre(end)) < 1.5 && !b.pve.processes.userProcesses().length) {
        arrivedMs = Date.now() - t0;
        break;
      }
      await sleep(50);
    }
    return { arrivedMs, fights: b.pve.stats.fights - fights0, startReach, behaviours: [...behaviours] };
  }

  const probeLine = (b: PveBot): string => {
    const s = b.pve.pathReach.stats;
    return `probes ${s.probes} (found ${s.found}, failed ${s.failed}, cached answers ${s.cached}), ${s.ms.toFixed(1)} ms in all, max ${s.maxMs.toFixed(1)} ms / ${s.maxExpanded} nodes, mean ${(s.probes ? s.ms / s.probes : 0).toFixed(1)} ms`;
  };

  it('(a) wall: a zombie 4 blocks away in a glass pen; !goto 30 blocks past it arrives within 40 s without a fight, the zombie ignored with a reason', async () => {
    const b = bot!;
    const start = await freshStart(b);
    const c = { x: Math.floor(start.x), z: Math.floor(start.z) - 4 };
    await pen(b, c, false);
    const z = await b.truth.summon('zombie', { x: c.x + 0.5, y: FEET_Y, z: c.z + 0.5 });
    const rid = await tracked(b, z);
    await sleep(1500); // let it press against the glass
    const run = await walkRoute(b, start, rid, 40_000);
    const ignored = b.pve.ignored().find((x) => x.runtimeId === String(rid));
    const line = `${OLD ? '(old rule) ' : ''}wall: ${run.arrivedMs !== undefined ? `arrived after ${(run.arrivedMs / 1000).toFixed(1)} s` : 'NOT arrived in 40 s'}, fights ${run.fights}, zombie ignored: ${ignored ? `${ignored.reason} (${ignored.leftS} s left)` : 'no'}; behaviours ${run.behaviours.join(' | ')}; ${probeLine(b)}`;
    console.log(line);
    measurements.push(line);
    await b.truth.cleanup();
    await unpen(b, c);
    if (OLD) return;
    expect(run.arrivedMs).toBeDefined();
    expect(run.arrivedMs!).toBeLessThan(40_000);
    expect(run.fights).toBe(0);
    expect(ignored).toBeDefined();
    expect(ignored!.reason.length).toBeGreaterThan(0);
  }, 90_000);

  it('(b) window: the pen beside the route with a 1-block window: no fight unless the zombie is within reach, the walk arrives within 40 s', async () => {
    const b = bot!;
    const start = await freshStart(b);
    const c = { x: Math.floor(start.x) + 10, z: Math.floor(start.z) - 4 };
    await pen(b, c, true);
    let z: MobInfo | undefined;
    let rid = 0n;
    const run = await walkRoute(b, start, async () => {
      z = await b.truth.summon('zombie', { x: c.x + 0.5, y: FEET_Y, z: c.z + 0.5 });
      rid = await tracked(b, z);
      return rid;
    }, 40_000);
    const ignored = b.pve.ignored().find((x) => x.runtimeId === String(rid));
    const alive = (await b.truth.entity(z!.entityId)).valid !== false;
    const line = `${OLD ? '(old rule) ' : ''}window: ${run.arrivedMs !== undefined ? `arrived after ${(run.arrivedMs / 1000).toFixed(1)} s` : 'NOT arrived in 40 s'}, fights ${run.fights} (zombie reach at their start ${run.startReach.join(', ') || '-'}), zombie ${alive ? 'alive' : 'dead'}, ignored: ${ignored ? ignored.reason : 'no'}; behaviours ${run.behaviours.join(' | ')}; ${probeLine(b)}`;
    console.log(line);
    measurements.push(line);
    await b.truth.cleanup();
    await unpen(b, c);
    if (OLD) return;
    expect(run.arrivedMs).toBeDefined();
    expect(run.arrivedMs!).toBeLessThan(40_000);
    // 0.6 of slack: the sample runs every 50 ms while the bot walks past at up to 5.6 blocks/s
    for (const r of run.startReach) expect(r).toBeLessThanOrEqual(3.2 + 0.6);
    expect(run.fights).toBeLessThanOrEqual(run.startReach.length + 1);
  }, 90_000);

  it('(c) open: a zombie 5 blocks off the route walks up during the walk and is fought; the walk arrives', async () => {
    const b = bot!;
    const start = await freshStart(b);
    let z: MobInfo | undefined;
    const run = await walkRoute(b, start, async () => {
      z = await b.truth.summon('zombie', { x: start.x + 12.5, y: FEET_Y, z: start.z - 4.5 });
      return tracked(b, z);
    }, 60_000);
    const dead = (await b.truth.entity(z!.entityId)).valid === false;
    const line = `${OLD ? '(old rule) ' : ''}open: ${run.arrivedMs !== undefined ? `arrived after ${(run.arrivedMs / 1000).toFixed(1)} s` : 'NOT arrived in 60 s'}, fights ${run.fights} (zombie reach at their start ${run.startReach.join(', ') || '-'}), zombie ${dead ? 'dead' : 'alive'}; behaviours ${run.behaviours.join(' | ')}; ${probeLine(b)}`;
    console.log(line);
    measurements.push(line);
    await b.truth.cleanup();
    expect(run.fights).toBeGreaterThanOrEqual(1);
    expect(dead).toBe(true);
    expect(run.arrivedMs).toBeDefined();
    expect(b.built.respawn!.dead).toBe(false);
  }, 90_000);
});
