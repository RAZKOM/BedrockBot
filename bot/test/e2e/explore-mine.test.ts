// e2e (tag @bds), wave 9 Track AI (docs/mining.md "Branch mining"): `!mine iron_ore 3` with no iron
// known, on bds-explore (seed 7, natural terrain, peaceful). One afk-task bot (walking, the CLI's
// wiring, in-memory settings `mineSeenOnly on` so only ore the bot has seen counts as known, and
// `mineTunnelLen 64`), a world cache in a temp directory:
//   start    a random far area; the start is taken when, on the bot's own loaded blocks (a fill-free
//            scan), the staircase east to y 16 is clear of the dig rules' hazards, no exposed iron lies
//            within 32 blocks of it (nothing known), and truth:find shows iron next to the planned
//            tunnel cells at y 16 (3 or more blocks of veins touching the first 60 tunnel cells);
//            otherwise the next area
//   run      the bot faces east, gets an iron pickaxe; `!mine iron_ore 3`: the staircase down to y 16,
//            the tunnel and branches, 3 iron mined and picked up (truth:inv raw_iron), back on the
//            surface within 10 minutes
//   rules    every cell that turned from solid to open during the run has no water or lava next to it
//            (truth:find water / lava over the dug area)
//   cleanup  the dug cells are filled with stone again, drops removed
// Env: EXPLORE_BDS_HOST / EXPLORE_BDS_PORT / EXPLORE_BDS_CONTAINER (explore-truth.ts), EXPLORE_AREA,
// EXPLORE_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { branchRunOf, stairCells, tunnelCells, type Dir, type Step } from '../../src/skills/mine/branch.ts';
import { isExposed } from '../../src/skills/mine/seen.ts';
import { breakBlocker } from '../../src/skills/nav/actions.ts';
import type { MineProcess } from '../../src/tasks/process/mine.ts';
import { E2E, hdist, invCounts, prepareServer, privateArea, sleep, landFeet, standNear, startExploreBot, teleport, truthFind, until, type ExploreBot } from './explore-truth.ts';

/** The staircase directions tried at a start, with the Bedrock yaw that faces them. */
const DIRS: readonly (readonly [Dir, number])[] = [
  [[1, 0], -90],
  [[0, 1], 0],
  [[-1, 0], 90],
  [[0, -1], 180],
];
/** Random areas tried for a start. */
const AREAS = 16;
const TARGET_Y = 16;
const TEN_MIN = 600_000;

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const N6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

interface Start {
  feet: Vec3;
  dir: Dir;
  stairs: Step[];
  tunnel: Step[];
  /** Iron blocks next to the planned tunnel cells (truth). */
  ironNext: number;
  ironVein: number;
}

/** The planned tunnel cells in digging order: 3 main, left 16, right 16, 3 main, ... */
function tunnelOrder(bottom: Vec3, dir: Dir, pairs: number): Step[] {
  const { main, branches } = tunnelCells(bottom, dir, pairs);
  const out: Step[] = [];
  for (let p = 0; p < pairs; p++) out.push(...main.slice(p * 3, p * 3 + 3), ...branches[p * 2]!, ...branches[p * 2 + 1]!);
  return out;
}

describe.skipIf(!E2E)('@bds explore: branch mining when no ore is known (Track AI)', () => {
  const notes: string[] = [];
  let bot: ExploreBot | undefined;
  const dug = new Map<string, Vec3>();
  let start: Start | undefined;

  beforeAll(async () => {
    await prepareServer();
    bot = await startExploreBot('Branch', {}, { settings: { mineSeenOnly: 'on', mineTunnelLen: '64', ...(process.env.MINE_MODE ? { mineMode: process.env.MINE_MODE } : {}) } }); // Track BD: MINE_MODE
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      const b = bot;
      for (const p of dug.values()) await b.truth.fill(p, p, 'stone').catch(() => undefined);
      if (start) await b.truth.clearAround(start.feet, 80).catch(() => undefined);
      await b.stop();
    }
    console.log(`[explore-mine e2e]\n  ${notes.join('\n  ')}`);
  }, 300_000);

  /**
   * A start whose staircase is clear, with nothing known and iron next to the planned tunnel. Per hop
   * (a random area, the bot dropped onto land there) every dry surface cell on a 6-block grid within
   * 48 blocks and each of the 4 directions is checked on the bot's loaded blocks (a fill-free scan);
   * the first few that pass are checked for iron with truth:find.
   */
  async function pickStart(b: ExploreBot): Promise<Start> {
    const mob = b.built.mobility!;
    const world = mob.world;
    const grid = mob.skills.nav.grid;
    const isIron = (n: string) => n === 'iron_ore' || n === 'deepslate_iron_ore';
    const blockAt = (p: Vec3) => world.blockAt(p);
    const why = { y: 0, stairs: 0, exposed: 0, iron: 0 };
    const stairRule = (stairs: Step[]): string | undefined => {
      for (const st of stairs) {
        for (const c of st.dig) {
          const r = breakBlocker(grid, c.x, c.y, c.z, {}, []);
          if (r && r !== 'air') return `${r} at ${key(c)}`;
        }
        const f = grid.cls(st.floor.x, st.floor.y, st.floor.z);
        if (!f || !f.floor || f.liquid || f.danger) return `no floor at ${key(st.floor)}`;
      }
      return undefined;
    };
    for (let attempt = 0; attempt < AREAS; attempt++) {
      const a = privateArea();
      const land = await standNear(b, a.x, a.z);
      if (!land) {
        notes.push(`area ${a.x},${a.z}: no land`);
        continue;
      }
      await mob.world.waitForChunks(8, { center: land, timeoutMs: 60_000 }).catch(() => undefined);
      let truthChecks = 0;
      for (let dx = -48; dx <= 48 && truthChecks < 16; dx += 6) {
        for (let dz = -48; dz <= 48 && truthChecks < 16; dz += 6) {
          const fx = land.x + dx;
          const fz = land.z + dz;
          const fy = landFeet(b, fx, fz);
          if (fy === undefined || fy < 64 || fy > 120) {
            why.y++;
            continue;
          }
          const feet = { x: fx, y: fy, z: fz };
          for (const [dir, yaw] of DIRS) {
            const stairs = stairCells(feet, dir, TARGET_Y);
            if (stairRule(stairs)) {
              why.stairs++;
              continue;
            }
            // nothing known on the way down: no exposed iron within 32 blocks of the staircase above y 32
            // (the miner would take it before the tunnel level); near the bottom and the planned tunnel
            // only exposed iron more than 4 below the tunnel counts against a start: ore in a cave deep
            // under the tunnel, which the navigator cannot dig down to, costs the miner minutes of failed
            // gotos (measured; an open point of the miner, docs/mining.md); higher cave iron the miner
            // simply mines once down there
            let seen = 0;
            const planned = tunnelOrder(stairs[stairs.length - 1]!.feet, dir, 2).slice(0, 60);
            const upper = stairs.filter((st, i) => st.feet.y >= TARGET_Y + 16 && i % 8 === 0);
            const lower = [...stairs.filter((st, i) => st.feet.y < TARGET_Y + 16 && i % 8 === 0), stairs[stairs.length - 1]!, ...planned.filter((_, i) => i % 10 === 9)];
            for (const [list, deepOnly] of [
              [upper, false],
              [lower, true],
            ] as const) {
              for (const st of list) {
                for (const p of world.find((x) => isIron(x.name), { origin: st.feet, radius: 32, max: 4096, cached: false })) if ((!deepOnly || p.y < TARGET_Y - 4) && isExposed(blockAt, p)) seen++;
                if (seen) break;
              }
            }
            if (seen > 0) {
              why.exposed++;
              continue;
            }
            truthChecks++;
            // no iron in or next to the staircase's cells either (the staircase would find it on the way down)
            const sc = stairs.flatMap((st) => st.dig);
            const slo = { x: Math.min(...sc.map((c) => c.x)) - 1, y: TARGET_Y - 1, z: Math.min(...sc.map((c) => c.z)) - 1 };
            const shi = { x: Math.max(...sc.map((c) => c.x)) + 1, y: feet.y + 3, z: Math.max(...sc.map((c) => c.z)) + 1 };
            const stairIron = await truthFind(b.truth, slo, shi, 'iron_ore').catch(() => undefined);
            if (!stairIron) continue;
            const scells = new Set(sc.map(key));
            const onStairs = stairIron.positions.filter(([x, y, z]) => scells.has(`${x},${y},${z}`) || N6.some(([ex, ey, ez]) => scells.has(`${x! + ex},${y! + ey},${z! + ez}`)));
            if (onStairs.length > 0) {
              why.exposed++;
              notes.push(`area ${a.x},${a.z}: start ${key(feet)} dir ${dir.join(',')}: ${onStairs.length} iron next to the staircase`);
              continue;
            }
            const bottom = stairs[stairs.length - 1]!.feet;
            const tunnel = tunnelOrder(bottom, dir, 2).slice(0, 60);
            const xs = tunnel.flatMap((s) => s.dig.map((c) => c.x));
            const zs = tunnel.flatMap((s) => s.dig.map((c) => c.z));
            const lo = { x: Math.min(...xs) - 2, y: TARGET_Y - 3, z: Math.min(...zs) - 2 };
            const hi = { x: Math.max(...xs) + 2, y: TARGET_Y + 4, z: Math.max(...zs) + 2 };
            // the pack answers for chunks in its ticking area only: a box out of it skips the candidate
            const iron = await truthFind(b.truth, lo, hi, 'iron_ore').catch((e: unknown) => {
              notes.push(`area ${a.x},${a.z}: start ${key(feet)}: ${e instanceof Error ? e.message : String(e)}`);
              return undefined;
            });
            if (!iron) continue;
            const ironSet = new Set(iron.positions.map(([x, y, z]) => `${x},${y},${z}`));
            // iron in a tunnel cell or next to one, and the veins those belong to
            const next = new Set<string>();
            for (const s of tunnel)
              for (const c of s.dig) {
                if (ironSet.has(key(c))) next.add(key(c));
                for (const [ex, ey, ez] of N6) {
                  const k = key({ x: c.x + ex, y: c.y + ey, z: c.z + ez });
                  if (ironSet.has(k)) next.add(k);
                }
              }
            const vein = new Set(next);
            for (let grow = 0; grow < 4; grow++)
              for (const k of [...vein]) {
                const [x, y, z] = k.split(',').map(Number) as [number, number, number];
                for (const [ex, ey, ez] of N6) {
                  const q = `${x + ex},${y + ey},${z + ez}`;
                  if (ironSet.has(q)) vein.add(q);
                }
              }
            notes.push(`area ${a.x},${a.z}: start ${key(feet)} dir ${dir.join(',')}, staircase ${stairs.length} steps clear, no exposed iron near it; iron in / next to the first 60 tunnel cells: ${next.size} (veins ${vein.size}; ${iron.count} in the box)`);
            if (vein.size < 3) {
              why.iron++;
              continue;
            }
            notes.push(`start search (area ${a.x},${a.z}): ${JSON.stringify(why)} candidates left out (surface y, staircase rules, exposed iron, too little iron)`);
            await teleport(b, { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }, yaw, 4);
            return { feet, dir, stairs, tunnel, ironNext: next.size, ironVein: vein.size };
          }
        }
      }
      notes.push(`area ${a.x},${a.z}: no start (${JSON.stringify(why)})`);
    }
    throw new Error(`no usable start in ${AREAS} areas: ${notes.join(' | ')}`);
  }

  it('!mine iron_ore 3 digs down to y 16, branch-mines 3 iron and returns to the surface', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const s = await pickStart(b);
    start = s;
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'diamond_pickaxe', 1]); // an iron one (250 uses) wore out in a run of 270 blocks
    await sleep(1000);
    let minY = Infinity;
    const off = mob.world.onBlockUpdate((p, before, after) => {
      // a cell the bot opened: solid before, open after, within its reach (leaf decay farther away is not a dig)
      const at = b.task.position();
      const near = at && Math.hypot(p.x + 0.5 - at.x, p.y + 0.5 - (at.y + 1.6), p.z + 0.5 - at.z) <= 7;
      if (near && before && before.boxes.length > 0 && after.boxes.length === 0 && !after.name.includes('water') && !after.name.includes('lava')) dug.set(key(p), { ...p });
    });
    const sampler = setInterval(() => {
      const p = b.task.position();
      if (p) minY = Math.min(minY, p.y);
    }, 100);
    let proc: MineProcess | undefined;
    const grab = setInterval(() => {
      proc ??= b.processes.find('mine')[0] as MineProcess | undefined;
    }, 50);
    try {
      const from = b.said.length;
      const t0 = Date.now();
      await b.command('!mine iron_ore 3');
      const first = await b.reply((x) => x.startsWith('mining '), from);
      expect(first).toBe('mining 3 iron_ore/deepslate_iron_ore');
      const end = await b.reply((x) => x.startsWith('mine iron_ore: '), from, TEN_MIN);
      const endMs = Date.now() - t0;
      const back = await until(
        () => {
          const p = b.task.position();
          return p && hdist(p, { x: s.feet.x + 0.5, z: s.feet.z + 0.5 }) < 3 && p.y >= s.feet.y - 1 && b.processes.userProcesses().length === 0 ? p : undefined;
        },
        Math.max(10_000, TEN_MIN - endMs),
        'back on the surface',
        500,
      );
      const totalMs = Date.now() - t0;
      const run = proc ? branchRunOf(proc.task) : undefined;
      const counts = await invCounts(b.truth, b.name);
      const st = run?.stats;
      notes.push(`replies: ${b.said.slice(from).join(' | ')}`);
      notes.push(
        `mine ended after ${(endMs / 1000).toFixed(1)} s, back on the surface ${(totalMs / 1000).toFixed(1)} s (${key({ x: Math.floor(back.x), y: Math.floor(back.y), z: Math.floor(back.z) })}); min y ${minY.toFixed(2)}; ` +
          `staircase ${st?.stairSteps} steps (y reached after ${((st?.reachedYMs ?? NaN) / 1000).toFixed(1)} s), tunnel ${st?.mainLen} main + ${st?.branchLen} branch in ${st?.branches} branches, ${st?.dug} blocks dug by the layout, ${dug.size} cells opened in all, finds at tunnel blocks ${st?.findAt.join(',')}, turns ${st?.turns}, pickup walks ${st?.pickupWalks}, blocked ${JSON.stringify(st?.blockedSteps)}; ` +
          `mined ${proc?.task.stats.mined}, tunnelled ${proc?.task.stats.tunnelled}, inventory ${JSON.stringify(counts)}`,
      );
      const ms = proc?.task.stats;
      const drops = ms?.minedAt[0] ? await b.truth.near(ms.minedAt[0], 12).catch(() => []) : [];
      notes.push(`miner: minedAt ${JSON.stringify(ms?.minedAt)}, collected ${JSON.stringify(ms?.collected)}, pickup walks ${ms?.pickupWalks}; entities near the first: ${JSON.stringify(drops).slice(0, 600)}`);
      notes.push(`mine log: ${b.logs.filter((l) => l.includes(' mine: ') || l.includes(' branch: ')).slice(-60).join(' / ')}`);
      expect(end).toBe('mine iron_ore: 3/3 done');
      expect(st?.reachedYMs).toBeDefined();
      expect(minY).toBeLessThan(TARGET_Y + 0.5);
      expect(st!.branches).toBeGreaterThanOrEqual(1);
      expect(counts.raw_iron ?? 0).toBeGreaterThanOrEqual(3);
      expect(totalMs).toBeLessThan(TEN_MIN);
      // the dig rules: no water or lava next to any opened cell (truth)
      // per 16-block section of opened cells, one truth:find box (plus one block around) per liquid
      const cells = [...dug.values()];
      const sections = new Map<string, Vec3[]>();
      for (const c of cells) {
        const k = `${c.x >> 4},${c.y >> 4},${c.z >> 4}`;
        const l = sections.get(k);
        if (l) l.push(c);
        else sections.set(k, [c]);
      }
      const exposed: string[] = [];
      for (const group of sections.values()) {
        const lo = { x: Math.min(...group.map((c) => c.x)) - 1, y: Math.min(...group.map((c) => c.y)) - 1, z: Math.min(...group.map((c) => c.z)) - 1 };
        const hi = { x: Math.max(...group.map((c) => c.x)) + 1, y: Math.max(...group.map((c) => c.y)) + 1, z: Math.max(...group.map((c) => c.z)) + 1 };
        for (const liquid of ['water', 'lava']) {
          const f = await truthFind(b.truth, lo, hi, liquid);
          for (const [x, y, z] of f.positions) {
            for (const [dx, dy, dz] of N6) if (dug.has(`${x! + dx},${y! + dy},${z! + dz}`)) exposed.push(`${liquid} at ${x},${y},${z}`);
          }
        }
      }
      notes.push(`dig rules: ${cells.length} opened cells in ${sections.size} sections; liquid next to them: ${exposed.length ? exposed.join('; ') : 'none'}`);
      expect(exposed).toEqual([]);
    } finally {
      off();
      clearInterval(sampler);
      clearInterval(grab);
      const p = b.task.position();
      notes.push(`said: ${b.said.join(' | ')}`);
      notes.push(`at the end: bot at ${p ? key({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) : '?'}, processes ${b.processes.userProcesses().map((x) => x.status().line).join('; ') || 'none'}`);
      notes.push(`log: ${b.logs.filter((l) => / (mine|branch|pve|goto|trip|nav): /.test(l) || l.includes('surface')).slice(-50).join(' / ')}`);
    }
  }, TEN_MIN + 1_500_000);
});
