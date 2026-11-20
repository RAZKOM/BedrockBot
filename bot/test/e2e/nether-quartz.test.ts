// e2e (tag @bds), Track K6 (docs/survival.md "Mending, part two (Track K6)", "Quartz and the Nether"): what a `!mend` quartz
// trip would find, on bds-nether (a generated default world, seed 7; nether-truth.ts). A measurement only (NETHER_PROBE=quartz).
// For NETHER_SITES random sites of the Nether (default 8; x, z within the area of nether-truth's privateArea / 8): the
// first standable cell near y 64 (solid under, two air cells, no lava within 2) stands in for a portal's arrival; the
// quartz ores within 32 of it (truth dfind) and of those the ones with a face open to air (the ones the miner can see);
// then on the first NETHER_MINE sites (default 3) `!mine quartz_ore 5` with an iron pickaxe: the ores mined, the time, the
// experience to the bar. Mob spawning is off (prepareServer): the hazards of mobs are not measured here.
// Lines to NETHER_OUT when set. Env: NETHER_BDS_* (nether-truth.ts).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { dimTeleport, E2E, hurtsSince, netherCmd, prepareServer, privateArea, serverTick, sleep, startNetherBot, teleport, truthRetry, until, type NetherBot } from './nether-truth.ts';

const PROBE = (process.env.NETHER_PROBE ?? '').split(',').includes('quartz');
const SITES = Number(process.env.NETHER_SITES ?? 8);
const MINE = Number(process.env.NETHER_MINE ?? 3);
const OUT = process.env.NETHER_OUT;
const R = 32;

/** Experience points to go from level `l` to `l + 1`. */
const xpToNext = (l: number): number => (l <= 15 ? 2 * l + 7 : l <= 30 ? 5 * l - 38 : 9 * l - 158);
const xpTotal = (l: number, progress: number): number => {
  let t = 0;
  for (let i = 0; i < l; i++) t += xpToNext(i);
  return t + progress * xpToNext(l);
};

describe.skipIf(!E2E || !PROBE)('@bds nether: quartz near a portal site (Track K6, a measurement)', () => {
  let bot: NetherBot | undefined;
  const notes: string[] = [];
  const note = (l: string): void => {
    notes.push(l);
    console.log(l);
    if (OUT) appendFileSync(OUT, `${new Date().toISOString()} ${l}\n`);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startNetherBot('Quartz');
  }, 240_000);

  afterAll(async () => {
    console.log(`[nether-quartz] ${notes.join('\n[nether-quartz] ')}`);
    if (bot) {
      await dimTeleport(bot, 'overworld', { x: 0.5, y: 100, z: 0.5 }).catch(() => undefined);
      await bot.stop();
    }
  }, 120_000);

  /** A standable cell near (x, 64, z) by the bot's world model, nearest to y 64 first, or undefined. */
  const standable = (b: NetherBot, x: number, z: number): Vec3 | undefined => {
    const w = b.built.mobility!.world;
    const solid = (p: Vec3): boolean => {
      const k = w.blockAt(p);
      return !!k && k.boxes.length > 0 && !/lava|magma|fire|soul_sand/.test(k.name);
    };
    const air = (p: Vec3): boolean => {
      const k = w.blockAt(p);
      return !!k && k.boxes.length === 0 && !/lava|fire|portal/.test(k.name);
    };
    const lavaNear = (p: Vec3): boolean => {
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) if ((w.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz })?.name ?? '').includes('lava')) return true;
      return false;
    };
    for (let dy = 0; dy <= 40; dy++) {
      for (const y of dy === 0 ? [64] : [64 + dy, 64 - dy]) {
        if (y < 33 || y > 118) continue;
        for (let r = 0; r <= 8; r++) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              const p = { x: x + dx, y, z: z + dz };
              if (solid({ x: p.x, y: y - 1, z: p.z }) && air(p) && air({ x: p.x, y: y + 1, z: p.z }) && !lavaNear(p)) return p;
            }
          }
        }
      }
    }
    return undefined;
  };

  it('quartz ores within 32 of a site, those open to air, and `!mine quartz_ore 5` there', async () => {
    const b = bot!;
    const a = privateArea();
    const w = b.built.mobility!.world;
    const xp = (): number => xpTotal(w.self.level ?? 0, w.self.xpProgress ?? 0);
    let mined = 0;
    for (let i = 0; i < SITES; i++) {
      const x = Math.round(a.x / 8) + i * 160;
      const z = Math.round(a.z / 8) + ((i * 97) % 300);
      await dimTeleport(b, 'nether', { x: x + 0.5, y: 120, z: z + 0.5 }).catch(() => undefined);
      await w.waitForChunks(3, { center: { x, y: 64, z }, timeoutMs: 60_000 }).catch(() => undefined);
      const s = standable(b, x, z);
      if (!s) {
        note(`site ${i + 1} at ${x} ${z}: no standable cell near y 64 within 8 (skipped)`);
        continue;
      }
      await teleport(b, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
      await w.waitForChunks(3, { center: s, timeoutMs: 60_000 }).catch(() => undefined);
      // the ores in a 65-block cube round the site, in slabs under the truth's 32 768-block bound
      const ores: Vec3[] = [];
      for (let y = s.y - R; y <= s.y + R; y += 7) {
        const y1 = Math.min(s.y + R, y + 6);
        const r = await truthRetry<{ positions: number[][] }>(b, 'dfind', ['nether', s.x - R, Math.max(0, y), s.z - R, s.x + R, Math.min(127, y1), s.z + R, 'quartz_ore', 4096]).catch(() => ({ positions: [] as number[][] }));
        for (const [px, py, pz] of r.positions) ores.push({ x: px!, y: py!, z: pz! });
      }
      const within = ores.filter((o) => Math.hypot(o.x + 0.5 - s.x - 0.5, o.y + 0.5 - s.y, o.z + 0.5 - s.z - 0.5) <= R);
      const open = within.filter((o) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => w.blockAt({ x: o.x + dx!, y: o.y + dy!, z: o.z + dz! })?.name === 'air'));
      const near16 = within.filter((o) => Math.hypot(o.x - s.x, o.y - s.y, o.z - s.z) <= 16).length;
      const nearest = within.length ? Math.min(...within.map((o) => Math.hypot(o.x + 0.5 - s.x - 0.5, o.y + 0.5 - s.y, o.z + 0.5 - s.z - 0.5))) : undefined;
      let mineLine = '';
      if (mined < MINE && within.length > 0) {
        mined++;
        await netherCmd('clear', b.name);
        await netherCmd('give', b.name, 'iron_pickaxe', '1');
        await netherCmd('xp', '-30000L', b.name);
        await sleep(1500);
        const x0 = xp();
        const t0 = Date.now();
        const tick0 = await serverTick(b);
        const from = b.said.length;
        await b.command('!mine quartz_ore 5');
        const end = await b.reply((m) => m.startsWith('mine '), from, 300_000).catch(() => 'no end line in 300 s');
        await sleep(3000);
        const hurts = await hurtsSince(b, tick0).catch(() => []);
        const me = b.task.position();
        mineLine = `; !mine quartz_ore 5: ${end.slice(0, 160)} in ${((Date.now() - t0) / 1000 - 3).toFixed(0)} s, experience +${(xp() - x0).toFixed(1)}, damage ${hurts.reduce((t, h) => t + h.damage, 0)}${hurts.length ? ` (${[...new Set(hurts.map((h) => h.cause))].join(' ')})` : ''}, ended ${me ? Math.hypot(me.x - s.x - 0.5, me.z - s.z - 0.5).toFixed(0) : '?'} from the site`;
        await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 10_000, 'idle').catch(() => undefined);
      }
      note(`site ${i + 1} at ${s.x} ${s.y} ${s.z}: quartz ores within ${R}: ${within.length} (${open.length} with a face open to air; within 16: ${near16}; nearest ${nearest?.toFixed(1) ?? '-'})${mineLine}`);
    }
    expect(true).toBe(true);
  }, 3 * 3_600_000);
});
