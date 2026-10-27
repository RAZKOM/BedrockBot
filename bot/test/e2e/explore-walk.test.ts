// e2e (tag @bds), wave 9 Track AI (docs/explore.md): `!explore` on bds-explore (seed 7, natural
// terrain, peaceful). One afk-task bot (walking, the CLI's wiring, in-memory settings) with a world
// cache of its own in a temp directory:
//   walk     a fresh spawn in a random far area (dry land); `!explore 64`: `!pause` after the first
//            visited cell holds the walk (still for 2 s), `!resume` goes on; the run ends by itself with
//            the summary line; the cache knows at least 12 more columns than before (counted on the
//            cache itself, not from the explorer's numbers) and those columns hold ore or log marks
//   stop     `!explore 128` from there, `!explore stop` after the first cell: `stopped; ...`, no
//            process left, the bot stands still
// Env: EXPLORE_BDS_HOST / EXPLORE_BDS_PORT / EXPLORE_BDS_CONTAINER (explore-truth.ts), EXPLORE_AREA,
// EXPLORE_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { explorerOf } from '../../src/chat/commands-explore.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { classify } from '../../src/world/find.ts';
import { E2E, hdist, landFeet, prepareServer, privateArea, sleep, standNear, startExploreBot, until, type ExploreBot } from './explore-truth.ts';

/** Columns the cache knows in a box of `r` chunks around `at`. */
function knownColumns(b: ExploreBot, at: Vec3, r: number): Set<string> {
  const out = new Set<string>();
  const cx0 = Math.floor(at.x) >> 4;
  const cz0 = Math.floor(at.z) >> 4;
  for (let cx = cx0 - r; cx <= cx0 + r; cx++) for (let cz = cz0 - r; cz <= cz0 + r; cz++) if (b.cache.known(cx, cz)) out.add(`${cx},${cz}`);
  return out;
}

describe.skipIf(!E2E)('@bds explore: the frontier walk fills the world cache (Track AI)', () => {
  const notes: string[] = [];
  let bot: ExploreBot | undefined;
  let spawn: Vec3 | undefined;

  beforeAll(async () => {
    await prepareServer();
    bot = await startExploreBot('Explore');
    // inland: a spawn above sea level (63), so the walk is not mostly over water
    for (let i = 0; i < 10 && !spawn; i++) {
      const a = privateArea();
      const s = await standNear(bot, a.x, a.z);
      // and land around (not an island): dry land 32 blocks out in each direction
      const around = s ? [[32, 0], [-32, 0], [0, 32], [0, -32]].filter(([dx, dz]) => landFeet(bot!, s.x + dx!, s.z + dz!) !== undefined).length : 0;
      if (s && s.y >= 64 && around === 4) spawn = s;
      else notes.push(`area ${a.x},${a.z}: ${s ? `y ${s.y}, land ${around}/4 around` : 'no land'}`);
    }
    if (!spawn) throw new Error('no dry land in 10 areas');
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      if (spawn) await bot.truth.clearAround(spawn, 160).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[explore-walk e2e]\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('!explore 64 walks the frontier (with !pause / !resume) and the cache learns new columns with marks', async () => {
    const b = bot!;
    const at = spawn!;
    const before = knownColumns(b, at, 30);
    const herdsBefore = b.cache.herds.size;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!explore 64');
    const first = await b.reply((s) => s.startsWith('exploring '), from);
    expect(first).toMatch(/^exploring r=64 around here \(/);
    const ex = explorerOf(b.task)!;
    // !pause after the first visited cell: the bot holds still
    await until(() => (ex.stats.visited >= 1 ? true : undefined), 120_000, 'the first visited cell', 200);
    const p0 = await (async () => {
      await b.command('!pause');
      await b.reply((s) => s.startsWith('paused'), from, 10_000);
      await sleep(500);
      return b.task.position()!;
    })();
    await sleep(2000);
    const p1 = b.task.position()!;
    const held = hdist(p0, p1);
    const visitedHeld = ex.stats.visited;
    await b.command('!resume');
    await b.reply((s) => s.startsWith('resumed'), from, 10_000);
    const end = await b.reply((s) => s.startsWith('explore r=64:'), from, 600_000);
    const ms = Date.now() - t0;
    const after = knownColumns(b, at, 30);
    const fresh = [...after].filter((k) => !before.has(k));
    let ores = 0;
    let logs = 0;
    for (const k of fresh) {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      for (const m of b.cache.summary(cx, cz)?.markList() ?? []) {
        if (m.name.endsWith('_ore')) ores++;
        else if (classify(m.name) === 'log') logs++;
      }
    }
    const s = ex.stats;
    notes.push(`spawn ${at.x} ${at.y} ${at.z}; replies: ${b.said.slice(from).join(' | ')}`);
    notes.push(
      `${(ms / 1000).toFixed(1)} s; cells ${s.cells}: visited ${s.visited}, water ${s.water}, lava ${s.lava}, unreachable ${s.unreachable}, covered ${s.covered}; walks ${s.walks}, ${s.distance.toFixed(0)} blocks; ` +
        `explorer: ${s.newColumns} new columns, ${s.ores} ores, ${s.forests} forests (${s.logs} logs), ${s.herds} herds, ${s.containers} containers; ` +
        `cache: ${before.size} -> ${after.size} columns (${fresh.length} new: ${ores} ore marks, ${logs} log marks), herds ${herdsBefore} -> ${b.cache.herds.size}; held ${held.toFixed(3)} blocks in 2 s at ${visitedHeld} cells; path ${s.path.map((p) => `${p.cx},${p.cz}@${(p.ms / 1000).toFixed(0)}s`).join(' ')}`,
    );
    notes.push(`explore log: ${b.logs.filter((l) => l.includes(' explore: ')).slice(-30).join(' / ')}`);
    expect(held).toBeLessThan(0.05);
    expect(s.visited).toBeGreaterThan(visitedHeld);
    expect(fresh.length).toBeGreaterThanOrEqual(12);
    expect(ores + logs).toBeGreaterThan(0);
    expect(end).toContain('new chunks cached');
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 700_000);

  it('!explore stop ends the walk at once', async () => {
    const b = bot!;
    const ex = explorerOf(b.task)!;
    const from = b.said.length;
    await b.command('!explore 128');
    await b.reply((s) => s.startsWith('exploring r=128'), from);
    await until(() => (ex.state === 'walk' ? true : undefined), 60_000, 'a walk', 100);
    await sleep(1000);
    notes.push(`stop: explorer ${ex.state} at ${ex.stats.walks} walks`);
    await b.command('!explore stop');
    const r = await b.reply((s) => s.startsWith('stopped; ') || s === 'not exploring', from, 10_000);
    await sleep(500);
    const p0 = b.task.position()!;
    await sleep(2000);
    const moved = hdist(p0, b.task.position()!);
    const navBusy = b.built.mobility!.skills.nav.busy;
    notes.push(`stop: ${r}; moved ${moved.toFixed(3)} blocks in 2 s after it, navigator busy ${navBusy}`);
    expect(r).toMatch(/^stopped; explore r=128: /);
    expect(b.processes.userProcesses()).toHaveLength(0);
    // no walk any more (a slope or water may still drift the body a little: measured 0.47 blocks once)
    expect(navBusy).toBe(false);
    expect(moved).toBeLessThan(1);
  }, 120_000);
});
