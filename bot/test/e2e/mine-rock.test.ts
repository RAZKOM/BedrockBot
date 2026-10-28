// e2e (tag @bds), wave 10 Track AQ (docs/mining.md "Direct tunnels", decision 0038) on bds-explore (seed
// 7, natural terrain, peaceful; EXPLORE_BDS_HOST / EXPLORE_BDS_PORT / EXPLORE_BDS_CONTAINER, EXPLORE_AREA,
// EXPLORE_VERBOSE=1): the afk task wired like the CLI (default settings: mineSeenOnly off, mineDirect on)
// in a cave whose iron lies 5 to 10 blocks into the rock.
//   start    random far areas; on the bot's loaded blocks a standable cell under a roof (a cave) with no
//            exposed iron within 5 blocks, and truth:find shows 4 or more iron blocks 5 to 10 blocks from
//            its eye; the bot is put there
//   run      an iron pickaxe; `!mine iron_ore 4`: `mine iron_ore: 4/4 done` within 5 minutes, 4 raw iron or
//            more in the inventory (truth), no water or lava next to any opened cell (truth:find)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { isExposed } from '../../src/skills/mine/seen.ts';
import type { MineProcess } from '../../src/tasks/process/mine.ts';
import { E2E, invCounts, prepareServer, privateArea, sleep, standNear, startExploreBot, teleport, truthFind, type ExploreBot } from './explore-truth.ts';

const AREAS = 16;
const FIVE_MIN = 300_000;
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const N6 = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

describe.skipIf(!E2E)('@bds mine: iron 5 to 10 blocks into the rock of a cave (Track AQ)', () => {
  const notes: string[] = [];
  let bot: ExploreBot | undefined;
  const dug = new Map<string, Vec3>();
  let start: Vec3 | undefined;

  beforeAll(async () => {
    await prepareServer();
    bot = await startExploreBot('Rock', {}, process.env.MINE_MODE ? { settings: { mineMode: process.env.MINE_MODE } } : {}); // Track BD: MINE_MODE
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      const b = bot;
      for (const p of dug.values()) await b.truth.fill(p, p, 'stone').catch(() => undefined);
      if (start) await b.truth.clearAround(start, 40).catch(() => undefined);
      await b.stop();
    }
    process.stdout.write(`[mine-rock e2e]\n  ${notes.join('\n  ')}\n`);
  }, 300_000);

  /** A cave cell with 4+ iron 5 to 10 blocks from the eye in the rock and no exposed iron within 5. */
  async function pickStart(b: ExploreBot): Promise<{ feet: Vec3; iron: Vec3[] }> {
    const mob = b.built.mobility!;
    const world = mob.world;
    const grid = mob.skills.nav.grid;
    const isIron = (n: string) => n === 'iron_ore' || n === 'deepslate_iron_ore';
    const blockAt = (p: Vec3) => world.blockAt(p);
    const why = { noIron: 0, noCave: 0, exposed: 0, truth: 0 };
    for (let attempt = 0; attempt < AREAS; attempt++) {
      const a = privateArea();
      const land = await standNear(b, a.x, a.z);
      if (!land) continue;
      await world.waitForChunks(6, { center: land, timeoutMs: 60_000 }).catch(() => undefined);
      const irons = world.find((x) => isIron(x.name), { origin: land, radius: 64, max: 4096, cached: false }).filter((p) => p.y > -50 && !isExposed(blockAt, p));
      if (irons.length < 4) {
        why.noIron++;
        continue;
      }
      let checks = 0;
      for (const ore of irons.slice(0, 400)) {
        if (checks >= 12) break;
        // standable cave cells 5 to 10 from it: the feet cell and the head free, a roof over the head
        for (let dx = -9; dx <= 9; dx += 1) {
          for (let dz = -9; dz <= 9; dz += 1) {
            for (let dy = -6; dy <= 6; dy++) {
              const f = { x: ore.x + dx, y: ore.y + dy, z: ore.z + dz };
              const s = grid.stand(f.x, f.y, f.z);
              if (s === undefined || Number.isNaN(s)) continue;
              const eye = { x: f.x + 0.5, y: f.y + 1.62, z: f.z + 0.5 };
              const d = Math.hypot(ore.x + 0.5 - eye.x, ore.y + 0.5 - eye.y, ore.z + 0.5 - eye.z);
              if (d < 5 || d > 10) continue;
              const top = grid.source.columnTop?.(f.x, f.z);
              if (top === undefined || top < f.y + 6) {
                why.noCave++;
                continue;
              }
              const near = irons.filter((p) => {
                const e = Math.hypot(p.x + 0.5 - eye.x, p.y + 0.5 - eye.y, p.z + 0.5 - eye.z);
                return e >= 5 && e <= 10;
              });
              if (near.length < 4) continue;
              const exposed = world.find((x) => isIron(x.name), { origin: f, radius: 5, max: 64, cached: false }).filter((p) => isExposed(blockAt, p));
              if (exposed.length > 0) {
                why.exposed++;
                continue;
              }
              checks++;
              const found = await truthFind(b.truth, { x: f.x - 10, y: f.y - 9, z: f.z - 10 }, { x: f.x + 10, y: f.y + 11, z: f.z + 10 }, 'iron_ore').catch(() => undefined);
              if (!found) continue;
              const inRock = found.positions.map(([x, y, z]) => ({ x: x!, y: y!, z: z! })).filter((p) => {
                const e = Math.hypot(p.x + 0.5 - eye.x, p.y + 0.5 - eye.y, p.z + 0.5 - eye.z);
                return e >= 5 && e <= 10;
              });
              if (inRock.length < 4) {
                why.truth++;
                continue;
              }
              notes.push(`start ${key(f)} (area ${a.x},${a.z}): ${inRock.length} iron 5 to 10 blocks from the eye (truth), roof at ${top}; search ${JSON.stringify(why)}`);
              await teleport(b, { x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, 0, 4);
              return { feet: f, iron: inRock };
            }
            if (checks >= 12) break;
          }
          if (checks >= 12) break;
        }
      }
      notes.push(`area ${a.x},${a.z}: no start (${JSON.stringify(why)})`);
    }
    throw new Error(`no cave start in ${AREAS} areas: ${notes.join(' | ')}`);
  }

  it('!mine iron_ore 4 from a cave with the iron 5 to 10 blocks into the rock: done within 5 minutes', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const s = await pickStart(b);
    start = s.feet;
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_pickaxe', 1]);
    await sleep(1000);
    const off = mob.world.onBlockUpdate((p, before, after) => {
      const at = b.task.position();
      const near = at && Math.hypot(p.x + 0.5 - at.x, p.y + 0.5 - (at.y + 1.6), p.z + 0.5 - at.z) <= 7;
      if (near && before && before.boxes.length > 0 && after.boxes.length === 0 && !after.name.includes('water') && !after.name.includes('lava')) dug.set(key(p), { ...p });
    });
    let proc: MineProcess | undefined;
    const grab = setInterval(() => {
      proc ??= b.processes.find('mine')[0] as MineProcess | undefined;
    }, 50);
    try {
      const from = b.said.length;
      const t0 = Date.now();
      await b.command('!mine iron_ore 4');
      const end = await b.reply((x) => x.startsWith('mine iron_ore: '), from, FIVE_MIN);
      const ms = Date.now() - t0;
      const counts = await invCounts(b.truth, b.name);
      const st = proc?.task.stats;
      notes.push(`replies: ${b.said.slice(from).join(' | ')}`);
      notes.push(
        `mine ended after ${(ms / 1000).toFixed(1)} s: mined ${JSON.stringify(st?.minedAt)} at ${st?.minedMs.map((x) => (x / 1000).toFixed(1)).join(', ')} s; tunnels ${JSON.stringify(st?.tunnels)}; veins ${JSON.stringify(st?.veins)}; ` +
          `skipped ${JSON.stringify(st?.skipped)}; probes ${st?.probes} (${st?.probeMs.toFixed(0)} ms); tunnelled ${st?.tunnelled}; opened ${dug.size}; inventory ${JSON.stringify(counts)}`,
      );
      notes.push(`mine log: ${b.logs.filter((l) => l.includes(' mine: ')).slice(-40).join(' / ')}`);
      expect(end).toBe('mine iron_ore: 4/4 done');
      expect(ms).toBeLessThan(FIVE_MIN);
      expect(counts.raw_iron ?? 0).toBeGreaterThanOrEqual(4);
      const cells = [...dug.values()];
      const exposed: string[] = [];
      if (cells.length) {
        const lo = { x: Math.min(...cells.map((c) => c.x)) - 1, y: Math.min(...cells.map((c) => c.y)) - 1, z: Math.min(...cells.map((c) => c.z)) - 1 };
        const hi = { x: Math.max(...cells.map((c) => c.x)) + 1, y: Math.max(...cells.map((c) => c.y)) + 1, z: Math.max(...cells.map((c) => c.z)) + 1 };
        for (const liquid of ['water', 'lava']) {
          const f = await truthFind(b.truth, lo, hi, liquid);
          for (const [x, y, z] of f.positions) for (const [dx, dy, dz] of N6) if (dug.has(`${x! + dx},${y! + dy},${z! + dz}`)) exposed.push(`${liquid} at ${x},${y},${z}`);
        }
      }
      notes.push(`dig rules: ${cells.length} opened cells; liquid next to them: ${exposed.length ? exposed.join('; ') : 'none'}`);
      expect(exposed).toEqual([]);
    } finally {
      off();
      clearInterval(grab);
    }
  }, FIVE_MIN + 900_000);
});
