// e2e (tag @bds), wave 11 Track BD (docs/mining.md "Mining v4: MineProcess (Track BD)") on bds-bari (flat
// world, truth pack; BARI_BDS_HOST / BARI_BDS_PORT / BARI_BDS_CONTAINER), the planner worker attached (the
// Realm's configuration). Every run builds the same truth-built stone block (17 x 17, 15 high, the bot on its
// top) in its own 40-block row of a private area (x, z from 90 000, a random 128-block cell) and mines iron
// with a MineTask wired like the chat command (`createMinerFor`), in both modes (`mineMode` v3 / baritone)
// x both `mineSeenOnly` settings, 3 runs each:
//   below   an ore straight below the start under a 3-block stone floor (depth 4)
//   shallow an ore 2 deep, a single 6 deep, a single 8 deep
//   lava    an ore behind a lava pocket (lava beside it): skipped with the reason (`next_to_liquid`), never dug
//   gravel  an ore under gravel: skipped (gravity above, the Track BB rule), never dug
//   vein    a 5-ore vein 6 to 7 deep
//   cave    3 ores in the walls / floor / ceiling of a closed cave 7 to 8 deep (exposed: an open face)
// mineSeenOnly off: 12 minable (2 skipped); on: the 3 cave ores (plus any the run's own digs expose). The
// numbers per run (ores mined, time, failed gotos, skipped, unreachable, digs, blocks placed) are printed; the
// last case checks mode baritone matches or beats v3 on ores mined and time (the mean of 3; time within 10 %),
// with mineSeenOnly off and on.
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MineTask } from '../../src/skills/mine/miner.ts';
import { createMinerFor } from '../../src/skills/mine/wire.ts';
import type { Vec3 } from '../../src/world/types.ts';
import type { ConnectTarget } from '../../src/connection/types.ts';
import { E2E_VERSION, bdsTarget } from './env.ts';
import { E2E, FEET_Y, clearArea, connectFarmBot, killItemsNear, pollUntil, prepareServer, truthLoaded, type FarmBot, type TruthInv } from './farm-truth.ts';

const BARI_HOST = process.env.BARI_BDS_HOST ?? '127.0.0.1';
const BARI_PORT = Number(process.env.BARI_BDS_PORT ?? 19206);
const BARI_CONTAINER = process.env.BARI_BDS_CONTAINER ?? 'bds-bari';
const BARI_TARGET: ConnectTarget = bdsTarget(BARI_HOST, BARI_PORT);
const RUNS = Number(process.env.MINE_BARI_RUNS ?? 3);
const F = FEET_Y;
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

type Mode = 'v3' | 'baritone';
interface Run {
  mode: Mode;
  seenOnly: boolean;
  end: string;
  mined: number;
  s: number;
  failures: number;
  calcFailed: number;
  skipped: number;
  unreachable: number;
  digs: number;
  places: number;
  lavaKept: boolean;
  gravelKept: boolean;
  why: string;
}

describe.skipIf(!E2E)('@bds mine: Baritone MineProcess vs v3 on one stone block (Track BD)', () => {
  let bot: FarmBot;
  let detach: (() => void) | undefined;
  const cell = randomInt(64);
  const X0 = 90_000 + 128 * (cell % 8) + 64;
  const Z0 = 90_000 + 128 * Math.floor(cell / 8) + 16;
  const notes: string[] = [];
  const runs: Run[] = [];
  let row = 0;

  const fill = (a: Vec3, b: Vec3, block: string) => truthLoaded(bot.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block]);
  const set = (p: Vec3, block: string) => truthLoaded(bot.truth, 'set', [p.x, p.y, p.z, block]);
  const blockName = async (p: Vec3) => (await bot.block(p)).typeId.replace('minecraft:', '');

  /** The block: stone y F-3 .. F+11 (the top at F+11, the feet at F+12), the ores and hazards. */
  async function build(s: { x: number; z: number }) {
    const top = F + 12;
    await fill({ x: s.x - 8, y: F - 3, z: s.z - 8 }, { x: s.x + 8, y: F + 11, z: s.z + 8 }, 'stone');
    const at = (dx: number, d: number, dz: number): Vec3 => ({ x: s.x + dx, y: top - d, z: s.z + dz });
    const below = at(0, 4, 0);
    const shallow = [at(3, 2, 2), at(-5, 6, -1), at(-2, 8, 6)];
    const lavaOre = at(5, 5, 5);
    const lava = [at(4, 5, 5), at(4, 5, 4)];
    const gravelOre = at(-4, 3, 3);
    const gravel = at(-4, 2, 3);
    const vein = [at(-5, 7, -5), at(-4, 7, -5), at(-3, 7, -5), at(-4, 6, -5), at(-4, 7, -4)];
    // the cave: air x +3..+6, depth 7..8, z -6..-4; ores in its east wall, floor and ceiling
    await fill(at(3, 8, -6), at(6, 7, -4), 'air');
    const cave = [at(7, 7, -5), at(4, 9, -5), at(5, 6, -4)];
    for (const p of [below, ...shallow, lavaOre, gravelOre, ...vein, ...cave]) await set(p, 'iron_ore');
    for (const p of lava) await set(p, 'lava');
    await set(gravel, 'gravel');
    return { top, below, lavaOre, gravelOre, lava, cave, all: [below, ...shallow, lavaOre, gravelOre, ...vein, ...cave] };
  }

  beforeAll(async () => {
    await prepareServer(BARI_CONTAINER);
    bot = await connectFarmBot('MineBari', { target: BARI_TARGET, container: BARI_CONTAINER });
    // the Realm's configuration: the planner worker (Track BC: a dig-heavy search is 10-20x per expansion)
    detach = bot.skills.nav.attachPlanner(bot.world);
    expect(await pollUntil(() => !!bot.skills.nav.planner?.ready, 20_000)).toBeGreaterThanOrEqual(0);
  }, 180_000);

  afterAll(async () => {
    const table = runs.map(
      (r) =>
        `${r.mode.padEnd(8)} seenOnly ${r.seenOnly ? 'on ' : 'off'}: ${r.end}, ${r.mined} mined in ${r.s.toFixed(1)} s, failed gotos ${r.failures} (no path ${r.calcFailed}), skipped ${r.skipped}, unreachable ${r.unreachable}, digs ${r.digs}, placed ${r.places}, lava ore kept ${r.lavaKept}, gravel ore kept ${r.gravelKept}; ${r.why}`,
    );
    process.stdout.write(`[mine-baritone e2e] BDS ${E2E_VERSION} on ${BARI_CONTAINER}, area cell ${cell} (${X0}, ${Z0}), ${RUNS} runs each\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}\n`);
    detach?.();
    if (bot) {
      for (let i = 0; i < row; i++) {
        await clearArea(bot.truth, X0, Z0 + 40 * i, 10, 16).catch(() => undefined);
        await killItemsNear(X0, Z0 + 40 * i, 12, BARI_CONTAINER).catch(() => undefined);
      }
      await bot.close();
    }
  }, 600_000);

  for (const seenOnly of [false, true])
    for (const mode of ['v3', 'baritone'] as const)
      for (let i = 1; i <= RUNS; i++)
        it(`${mode}, mineSeenOnly ${seenOnly ? 'on' : 'off'}, run ${i}`, async () => {
          const s = { x: X0, z: Z0 + 40 * row++ };
          await bot.teleport({ x: s.x - 10.5, y: F, z: s.z + 0.5 }, -90);
          await clearArea(bot.truth, s.x, s.z, 10, 16);
          await killItemsNear(s.x, s.z, 12, BARI_CONTAINER);
          const b = await build(s);
          await bot.teleport({ x: s.x + 0.5, y: b.top, z: s.z + 0.5 }, -90);
          await bot.loadout([
            ['iron_pickaxe', 1],
            ['cobblestone', 32],
          ]);
          expect(await pollUntil(() => b.all.every((p) => bot.world.blockAt(p)?.name === 'iron_ore') && bot.world.blockAt(b.lava[0]!)?.name === 'lava', 10_000)).toBeGreaterThanOrEqual(0);
          const placesBefore = bot.places.length;
          const parts = { skills: bot.skills, world: bot.world, loop: bot.loop, source: bot.conn, hotbar: bot.hotbar, containers: bot.containers, log: bot.logger };
          const m: MineTask = createMinerFor(parts, { seenOnly: () => seenOnly, tunnelLen: () => 64, mode: () => mode }).mine;
          const t0 = performance.now();
          const timer = setTimeout(() => m.stop(), 360_000);
          const end = await m.start({ block: 'iron_ore', count: 20 });
          clearTimeout(timer);
          const secs = (performance.now() - t0) / 1000;
          const st = m.stats;
          const inv = await bot.truth.ok<TruthInv>('inv', [bot.name]);
          const r: Run = {
            mode,
            seenOnly,
            end,
            mined: st.mined,
            s: secs,
            failures: st.failures,
            calcFailed: st.calcFailed,
            skipped: st.unsafe.length + st.skipped.length,
            unreachable: st.unreachable.length,
            digs: st.tunnelled,
            places: bot.places.length - placesBefore,
            lavaKept: (await blockName(b.lavaOre)) === 'iron_ore',
            gravelKept: (await blockName(b.gravelOre)) === 'iron_ore',
            why: `skips ${JSON.stringify([...st.unsafe, ...st.skipped].map((x) => `${key(x.p)} ${x.why}`))}; raw_iron ${inv.counts['minecraft:raw_iron'] ?? 0}; composites ${st.composites} (${st.compositeMembers} members), rescans ${st.rescans}, replans ${st.replans}, walk-dug ${st.walkDug}; probes ${st.probes}; last error ${m.lastError ?? '-'}`,
          };
          runs.push(r);
          // the safety rules hold in every mode
          expect(r.lavaKept).toBe(true);
          for (const p of b.lava) expect(await blockName(p)).toBe('lava');
          if (!seenOnly) {
            expect(JSON.stringify([...st.unsafe, ...st.skipped])).toMatch(/liquid/);
            expect(r.mined).toBeGreaterThanOrEqual(mode === 'baritone' ? 11 : 1);
          } else {
            expect(r.mined).toBeGreaterThanOrEqual(mode === 'baritone' ? 3 : 1);
          }
          expect(end).not.toBe('stopped');
        }, 420_000);

  it('mode baritone matches or beats v3 on ores mined and time (mean of the runs), mineSeenOnly off and on', () => {
    for (const seenOnly of [false, true]) {
      const of = (mode: Mode) => runs.filter((r) => r.mode === mode && r.seenOnly === seenOnly);
      const mean = (rs: Run[], f: (r: Run) => number) => rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length);
      const v3 = of('v3');
      const bar = of('baritone');
      const line = `seenOnly ${seenOnly ? 'on' : 'off'}: v3 ${mean(v3, (r) => r.mined).toFixed(1)} ores in ${mean(v3, (r) => r.s).toFixed(1)} s (${(mean(v3, (r) => r.s) / Math.max(0.1, mean(v3, (r) => r.mined))).toFixed(1)} s/ore), baritone ${mean(bar, (r) => r.mined).toFixed(1)} ores in ${mean(bar, (r) => r.s).toFixed(1)} s (${(mean(bar, (r) => r.s) / Math.max(0.1, mean(bar, (r) => r.mined))).toFixed(1)} s/ore)`;
      notes.push(line);
      expect(bar.length, line).toBe(RUNS);
      expect(v3.length, line).toBe(RUNS);
      expect(mean(bar, (r) => r.mined), line).toBeGreaterThanOrEqual(mean(v3, (r) => r.mined));
      // time per ore mined (a mode that mines more ores spends more time on them)
      expect(mean(bar, (r) => r.s) / Math.max(1, mean(bar, (r) => r.mined)), line).toBeLessThanOrEqual((1.1 * mean(v3, (r) => r.s)) / Math.max(1, mean(v3, (r) => r.mined)));
    }
  });
});
