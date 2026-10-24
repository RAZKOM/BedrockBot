// e2e (tag @bds), Track Z (PLAN.md 7.12 + 7.6; docs/world-cache.md "Remembered forests") on bds-cache
// (generated DEFAULT world, seed 7, peaceful, fall damage off):
//   run 1   an in-process bot with a world cache (the CLI's layout <root>/<server id>) finds a start
//           S and land F 100 blocks away, or closer (at least 52, beyond the gather's 48-block search) when natural logs are nearer
//           (seed 7 has trees almost everywhere: F must stay the nearest log cluster, 10 blocks nearer), checks that S -> F is
//           walkable, plants a forest of 5 oaks at F, stands there (the forest enters the world model
//           and the cache) and goes back to S; its cache is closed (the restart)
//   run 2   a NEW PROCESS (the CLI, `--task afk --walk`, BEDROCKBOT_CACHE_DIR = the same root) starts
//           at S; `!gather 8` (console tell) finds no tree within its 48-block search radius, asks the
//           forest finder (loaded and remembered logs) for the nearest cluster, walks there with an
//           `any` goal and gathers 8 logs (truth:inv); the log line names the forest it walked to.
// Natural terrain: an area with logs near S, without land at F or without a walkable line is replaced
// by another random one (up to ATTEMPTS). Env: CACHE_BDS_* (cache-truth.ts), CACHE_VERBOSE=1.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findPath, locateNode } from '../../src/skills/nav/astar.ts';
import { isLog } from '../../src/skills/tree/tree.ts';
import { FOREST_MAX_ABOVE, FOREST_MAX_BELOW } from '../../src/tasks/gatherWood.ts';
import { readRegion, serverIdFor } from '../../src/world/cache/index.ts';
import { decodeSeenMarks } from '../../src/world/cache/summary.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { CACHE_CONTAINER, CACHE_HOST, CACHE_PORT, E2E, VERBOSE, connectCacheBot, disconnectCacheBot, fmt, hdist, hop, landFeet, nearestLand, privateArea, settleChunks, sleep, standNear, uniqueName, type CacheBot } from './cache-truth.ts';
import { CLI_TARGET_ARGS } from './env.ts';
import { consoleCommand } from './skills-truth.ts';

/** Forest distance: 100 blocks, or closer when natural logs are nearer (seed 7 has trees almost everywhere). */
const DIST = 100;
/** The forest must be the nearest log cluster: natural logs at least this much farther than it. */
const MARGIN = 10;
/** Shortest forest distance accepted (beyond the gather search radius of 48). */
const MIN_DIST = 52;
const ATTEMPTS = 60;
const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
const D = Math.SQRT1_2;
const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [D, D],
  [D, -D],
  [-D, D],
  [-D, -D],
];

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string, every = 500): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}

describe.skipIf(!E2E)('@bds gather walks to a remembered forest after a restart (Track Z)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-cache-gather-'));
  const dir = join(root, serverIdFor(`${CACHE_HOST}:${CACHE_PORT}`));
  const notes: string[] = [];
  let bot: CacheBot | undefined;
  let cli: ChildProcess | undefined;
  let out = '';
  const planted: Vec3[] = [];

  afterAll(async () => {
    if (cli?.exitCode === null) cli.kill();
    if (bot) {
      // remove what is left of the planted trees (logs and leaves around each)
      for (const p of planted) {
        await bot.truth.tp(bot.name, { x: p.x + 0.5, y: p.y + 12, z: p.z + 0.5 }).catch(() => undefined);
        await sleep(500);
        await bot.truth.fill({ x: p.x - 3, y: p.y, z: p.z - 3 }, { x: p.x + 3, y: p.y + 9, z: p.z + 3 }, 'air').catch(() => undefined);
      }
      await disconnectCacheBot(bot).catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
    console.log(`[cache-gather e2e]\n  ${notes.join('\n  ')}`);
    if (VERBOSE) console.log(out);
  }, 120_000);

  it('!gather 8 from a treeless spot walks to the forest seen before the restart and finishes', async () => {
    bot = await connectCacheBot('CGather', { dir });
    const b = bot;
    let S: Vec3 | undefined;
    let F: Vec3 | undefined;
    let dist: number;
    for (let attempt = 0; attempt < ATTEMPTS && !F; attempt++) {
      const a = privateArea();
      const s = await standNear(b, a.x, a.z);
      if (!s) {
        notes.push(`attempt ${attempt}: ${a.x},${a.z}: no land at the start`);
        continue;
      }
      await settleChunks(b);
      // natural logs the forest finder would consider (its vertical window: underground ones are no forest)
      const logs = b.world
        .find((x) => isLog(x.name), { origin: s, radius: 160, max: 4096, class: 'log' })
        .filter((p) => p.y >= s.y - FOREST_MAX_BELOW && p.y <= s.y + FOREST_MAX_ABOVE);
      const nearest = Math.min(Infinity, ...logs.map((p) => hdist(s, p)));
      dist = Math.min(DIST, Math.floor(nearest - MARGIN));
      if (dist < MIN_DIST) {
        notes.push(`attempt ${attempt}: start ${fmt(s)}: natural logs ${nearest.toFixed(0)} blocks away`);
        continue;
      }
      for (const [dx, dz] of DIRS) {
        const f = nearestLand(b, Math.round(s.x + dx * dist), Math.round(s.z + dz * dist), 4);
        if (!f) continue;
        const start = locateNode(b.skills.nav.grid, b.loop.state.pos);
        const plan = start && findPath(b.skills.nav.grid, start, { type: 'near', p: { x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, r: 4 }, { ...b.skills.nav.planOptions(), maxNodes: 300_000, maxMs: 4000 });
        const ys = plan?.path.map((n) => n.y) ?? [];
        const yRange = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
        notes.push(`attempt ${attempt}: start ${fmt(s)} forest ${fmt(f)} (dir ${dx},${dz}): plan ${plan?.status} ${plan?.path.length} nodes, climbs ${yRange}`);
        if (plan?.status === 'found' && yRange <= 20) {
          S = s;
          F = f;
          break;
        }
      }
    }
    expect(F, `no treeless start with a walkable forest site ${MIN_DIST}..${DIST} blocks away`).toBeDefined();
    const s = S!;
    const f = F!;

    // plant 5 oaks at F (run 1 sees them), then back to S
    await hop(b, f.x, f.z, 3);
    await b.truth.tp(b.name, { x: f.x + 0.5, y: f.y, z: f.z + 0.5 });
    await sleep(1500);
    for (let i = 0; i < 40 && planted.length < 5; i++) {
      const ang = i * 2.4;
      const r = 3 + (i % 4);
      const x = f.x + Math.round(Math.cos(ang) * r);
      const z = f.z + Math.round(Math.sin(ang) * r);
      if (planted.some((p) => Math.hypot(p.x - x, p.z - z) < 3)) continue;
      const y = landFeet(b, x, z);
      if (y === undefined) continue;
      // a tree needs soil under its trunk for the tree finder (natural ground here may be stone or sand)
      await b.truth.cmd('set', [x, y - 1, z, 'grass_block'], 20_000);
      const rep = await b.truth.cmd('tree', [x, y, z, 5, 'oak', 1], 20_000);
      if (rep.ok) planted.push({ x, y, z });
    }
    expect(planted.length).toBeGreaterThanOrEqual(3);
    await until(() => (planted.every((p) => b.world.blockAt(p)?.name === 'oak_log') ? true : undefined), 10_000, 'planted logs in the world model', 100);
    await b.truth.tp(b.name, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
    await sleep(2000);
    const remembered = b.world.find((x) => isLog(x.name), { origin: s, radius: 200, max: 4096, class: 'log' }).length;
    // the restart: the cache is written; this connection stays only as the truth observer, its world without a cache
    b.cache.close();
    notes.push(`run 1: start ${fmt(s)}, forest ${fmt(f)} (${hdist(s, f).toFixed(0)} blocks), ${planted.length} oaks planted (${planted.map((p) => `${p.x},${p.y},${p.z}`).join(' ')}); ${remembered} logs known from S`);

    // ---- run 2: the CLI in a new process with the same cache root, at S
    const name = uniqueName('CGatCli');
    const logDir = mkdtempSync(join(tmpdir(), 'bb-cache-gather-log-'));
    cli = spawn(
      process.execPath,
      ['src/index.ts', '--task', 'afk', '--walk', '--host', CACHE_HOST, '--port', String(CACHE_PORT), ...CLI_TARGET_ARGS, '--username', name, '--no-reconnect', '--log-dir', logDir],
      { cwd: BOT_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BEDROCKBOT_CACHE_DIR: root } },
    );
    cli.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    cli.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    cli.on('exit', () => rmSync(logDir, { recursive: true, force: true }));
    await until(async () => ((await b.truth.ok<{ players: string[] }>('ping')).players.includes(name) ? true : undefined), 60_000, 'CLI bot online');
    await sleep(2000);
    await b.truth.tp(name, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
    await b.truth.ok('clear', [name]);
    await sleep(6000); // chunks around S
    const t0 = Date.now();
    await consoleCommand(CACHE_CONTAINER, 'tell', name, '!gather', '8');
    const logs = await until(
      async () => {
        const inv = await b.truth.ok<{ counts: Record<string, number> }>('inv', [name]);
        const n = Object.entries(inv.counts).filter(([k]) => k.endsWith('_log')).reduce((a, [, v]) => a + v, 0);
        return n >= 8 ? n : undefined;
      },
      300_000,
      '8 logs gathered',
      1000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}; CLI gather / goto lines:\n${out.split('\n').filter((l) => /\[gather\]|goto \{|failure \d/.test(l)).slice(0, 60).join('\n')}`);
    });
    const ms = Date.now() - t0;
    const pos = (await b.truth.pos(name)).location;
    const walk = out.split('\n').find((l) => l.includes('walking to a forest')) ?? '';
    const gone = (await Promise.all(planted.map(async (p) => String((await b.truth.ok<{ typeId: string }>('block', [p.x, p.y, p.z])).typeId)))).filter((t) => !t.endsWith('_log')).length;
    notes.push(`run 2: ${logs} logs ${ms} ms after !gather; bot at ${fmt(pos)}, ${hdist(pos, f).toFixed(1)} blocks from the forest; planted trunks felled ${gone}/${planted.length}`);
    notes.push(`walk: ${walk.replace(/^.*gather: /, '')}`);
    notes.push(`gather log: ${out.split('\n').filter((l) => l.includes('[gather]')).map((l) => l.replace(/^.*\[gather\] /, '')).join(' | ')}`);
    notes.push(`CLI: ${out.split('\n').filter((l) => /world cache:|gather: (done|failed)|blacklisted/.test(l)).slice(0, 6).join(' | ')}`);
    // the cost a loading column pays for carrying seen flags (Track Z): decodeSeenMarks over every stored record
    let n = 0;
    let carryMs = 0;
    for (const file of readdirSync(dir).filter((x) => /^r\.-?\d+\.-?\d+\.bin$/.test(x))) {
      const [, rx, rz] = /^r\.(-?\d+)\.(-?\d+)\.bin$/.exec(file)!;
      for (const data of readRegion(dir, Number(rx), Number(rz)).chunks.values()) {
        const t = performance.now();
        decodeSeenMarks(data);
        carryMs += performance.now() - t;
        n++;
      }
    }
    notes.push(`seen-flag carry cost: decodeSeenMarks over ${n} stored chunks: ${(carryMs / Math.max(1, n)).toFixed(3)} ms per chunk`);
    expect(walk).toMatch(/walking to a forest of \d+ logs/);
    expect(logs).toBeGreaterThanOrEqual(8);
    expect(hdist(pos, f)).toBeLessThan(30);
    expect(gone).toBeGreaterThanOrEqual(1);
  }, 900_000);
});
