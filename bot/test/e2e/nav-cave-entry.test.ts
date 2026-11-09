// e2e (tag @bds), Track R2 (docs/pathfinding.md "Reachability (Track R1)", its R2 part; decisions/0072-reachability.md
// "R2"): the walk into a real cave with the owner's live walking settings. A box of the bot's world cache round a
// surface landing and a cave's entrance is rebuilt on bds-fly (udp 19204; NAV_ENTRY_BDS_PORT / FLY_BDS_CONTAINER move
// it) as fly-cave.test.ts rebuilds its cave (`truth:cave`, packs/truth/src/cave.ts: stone over the box, then its air
// and water as boxes), moved in x and z by a multiple of 16 to NAV_ENTRY_AT (default -80000,-80000). The box is PRIVATE
// data: the extract and the waypoints come from the git-ignored bot/fixtures-private/cave-entry (NAV_ENTRY_DIR; the
// waypoint file names the start `landing` and the goal `cave_start`) and this suite skips without it.
//
// As on the live bot: the world cache recorded by a fly-over of the box, the coarse layer over it, then `!goto` from
// the landing to the goal with allowBreak on, allowPlace off (the live settings since 2026-11-09; NAV_ENTRY_PLACE=1:
// on, as at the incident), digPenalty 500, sprint on, a pickaxe, a shovel, 2 cobblestone and 64 dirt in the inventory. NAV_ENTRY_RUNS runs (default 3), each from the landing, all gated to
// arrive; the table (arrived, distance left, seconds, damage, ticks in water, blocks placed and broken, plans) goes to
// the log and NAV_ENTRY_REPORT. NAV_ENTRY_REUSE=1 skips the build (the same replica is still there);
// NAV_ENTRY_LOGDIR=<dir> writes each run's log lines there (with FLY_LOG_DEBUG=1 the planner's too).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boxMessages, CAVE_AIR, CAVE_STONE, CAVE_WATER, greedyBoxes } from '../../../packs/truth/src/cave-layout.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { attachCoarseLayer, type CoarseLayerImpl } from '../../src/skills/coarse/index.ts';
import { caveWorld, loadCaveFixture, shift } from '../../src/skills/fly/corridor/cave.ts';
import { CLS_AIR, CLS_WATER } from '../../src/world/cache/types.ts';
import { WorldCache } from '../../src/world/cache/cache.ts';
import { E2E, prepareServer, sleep, startFlyBot, teleport, type FlyBot } from './fly-truth.ts';

const DIR = process.env.NAV_ENTRY_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures-private/cave-entry');
const fix = loadCaveFixture(DIR);
const RUNS = Number(process.env.NAV_ENTRY_RUNS ?? 3);
const REUSE = process.env.NAV_ENTRY_REUSE === '1';
/** allowPlace: off as on the live bot since 2026-11-09; NAV_ENTRY_PLACE=1 on (the incident's settings). */
const PLACE = process.env.NAV_ENTRY_PLACE === '1';
const RUN_S = Number(process.env.NAV_ENTRY_RUN_S ?? 240);
/** The characters of one `truth:cave part` message (a scriptevent message holds 2048), parts in flight at once. */
const PART_CHARS = 1800;
const PART_JOBS = 6;

function replicaAt(): { x: number; z: number } {
  const pinned = process.env.NAV_ENTRY_AT?.split(',').map(Number);
  if (pinned?.length === 2 && pinned.every(Number.isFinite)) return { x: pinned[0]!, z: pinned[1]! };
  return { x: -80000, z: -80000 };
}

interface Row {
  run: number;
  ok: boolean;
  off: number;
  seconds: number;
  damage: number;
  water: number;
  placed: number;
  broken: number;
  plans: string;
  reply: string;
}

describe.skipIf(!E2E || !fix?.waypoints.has('landing') || !fix.waypoints.has('cave_start'))('@bds nav: the walk into a real cave with the live settings (Track R2, bds-fly)', () => {
  if (!fix) return; // (Track R3: vitest collects a skipped block too; without the private fixture it is skipped, not a crash)
  const e = fix.extract;
  const world = caveWorld(e);
  const at = replicaAt();
  const d: Vec3 = { x: Math.floor(at.x / 16) * 16 - Math.floor(e.box.min.x / 16) * 16, y: 0, z: Math.floor(at.z / 16) * 16 - Math.floor(e.box.min.z / 16) * 16 };
  const min = shift(e.box.min, d);
  const centre = (p: Vec3): Vec3 => ({ x: p.x + d.x + 0.5, y: p.y, z: p.z + d.z + 0.5 });
  const cell = (name: string): Vec3 => {
    const w = fix.waypoints.get(name)!;
    const f = world.feetCell({ x: Math.floor(w.x), y: Math.floor(w.y), z: Math.floor(w.z) });
    if (!f) throw new Error(`no standable cell at the fixture's ${name}`);
    return f;
  };
  const start = cell('landing');
  const goal = cell('cave_start');
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  let cache: WorldCache | undefined;
  let cacheDir: string | undefined;
  let coarse: { layer: CoarseLayerImpl; detach: () => void } | undefined;
  let offNav: (() => void) | undefined;
  let water = 0;
  let offWater: (() => void) | undefined;

  async function buildReplica(b: FlyBot): Promise<void> {
    const t0 = performance.now();
    const code = (x: number, y: number, z: number): number => {
      const c = e.cls(e.box.min.x + x, e.box.min.y + y, e.box.min.z + z);
      return c === CLS_AIR ? CAVE_AIR : c === CLS_WATER ? CAVE_WATER : CAVE_STONE;
    };
    const boxes = [...greedyBoxes(e.size, code, CAVE_AIR), ...greedyBoxes(e.size, code, CAVE_WATER)];
    const parts = boxMessages(boxes, PART_CHARS);
    const session = `e${Math.random().toString(36).slice(2, 8)}`;
    const ok = async (args: (string | number)[], ms: number): Promise<Record<string, unknown>> => {
      const r = await b.truth.cmd<Record<string, unknown>>('cave', args, ms);
      if (!r.ok) throw new Error(`truth:cave ${String(args[0])} failed: ${r.reason} ${JSON.stringify(r.data)}`);
      return r.data;
    };
    await ok(['begin', session, min.x, min.y, min.z, e.size.x, e.size.y, e.size.z], 30_000);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < parts.length; i = next++) await ok(['part', session, i, parts[i]!], 60_000);
    };
    await Promise.all(Array.from({ length: PART_JOBS }, worker));
    const r = await ok(['build', session, parts.length], 1_800_000);
    notes.push(`build: box ${e.size.x} x ${e.size.y} x ${e.size.z}, ${boxes.length} boxes in ${parts.length} parts, ${String(r.pieces)} pieces, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }

  /** Teleports over the box's surface (every 48 blocks), so the cache records the replica's chunks. */
  async function flyOver(b: FlyBot): Promise<void> {
    let n = 0;
    for (let x = e.box.min.x + 8; x <= e.box.max.x + 24; x += 48) {
      for (let z = e.box.min.z + 8; z <= e.box.max.z + 24; z += 48) {
        const cx = Math.min(x, e.box.max.x - 8);
        const cz = Math.min(z, e.box.max.z - 8);
        const top = e.top(cx, cz);
        const y = top !== undefined && top > -1000 ? Math.min(top + 1, e.box.max.y) : e.box.max.y;
        const feet = world.feetCell({ x: cx, y, z: cz });
        if (!feet) continue;
        await teleport(b, centre(feet));
        n++;
      }
    }
    await b.built.mobility!.loop.waitTicks(20);
    notes.push(`fly-over: ${n} surface points`);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Ce');
    await bot.command('!set autoFly off');
    await sleep(300);
    const mob = bot.built.mobility!;
    offWater = mob.loop.onBeforeStep((_t, s) => {
      if (s.inWater) water++;
    });
    const away: Vec3 = { x: min.x - 400.5, y: -60, z: min.z - 0.5 };
    await teleport(bot, away);
    if (!REUSE) await buildReplica(bot);
    else notes.push('build: reused (NAV_ENTRY_REUSE=1)');
    cacheDir = mkdtempSync(join(tmpdir(), 'bb-entry-e2e-'));
    cache = new WorldCache({ dir: cacheDir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(mob.world);
    await flyOver(bot);
    await teleport(bot, away);
    coarse = attachCoarseLayer(mob.world);
    if (!coarse) throw new Error('no coarse layer: the world has no cache');
    offNav = mob.skills.nav.attachCoarse(coarse.layer, { minBlocks: () => 96 });
    // the owner's live walking settings
    for (const [k, v] of [
      ['allowBreak', 'on'],
      ['allowPlace', PLACE ? 'on' : 'off'],
      ['digPenalty', '500'],
      ['sprint', 'on'],
    ] as const)
      bot.settings.set(k, v);
  }, 2_400_000);

  afterAll(async () => {
    offWater?.();
    offNav?.();
    coarse?.detach();
    if (bot) await bot.stop();
    cache?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const table = [
      `${pad('run', 5)}${pad('ok', 5)}${pad('off', 7)}${pad('s', 7)}${pad('damage', 8)}${pad('water', 7)}${pad('placed', 8)}${pad('broken', 8)}${pad('plans', 24)}reply`,
      ...rows.map((r) => `${pad(r.run, 5)}${pad(r.ok ? 'yes' : 'NO', 5)}${pad(r1(r.off), 7)}${pad(r1(r.seconds), 7)}${pad(r1(r.damage), 8)}${pad(r.water, 7)}${pad(r.placed, 8)}${pad(r.broken, 8)}${pad(r.plans, 24)}${r.reply}`),
    ];
    const text = `[nav-cave-entry e2e] replica moved by a multiple of 16 to (${min.x}, ${min.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`;
    console.log(text);
    if (process.env.NAV_ENTRY_REPORT) writeFileSync(process.env.NAV_ENTRY_REPORT, `${text}\n`);
  }, 60_000);

  it(`the landing to the cave's entrance by \`!goto\`, ${RUNS} runs, every run arrives`, async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const to = centre(goal);
    for (let run = 1; run <= RUNS; run++) {
      await b.command('!stop');
      await sleep(500);
      await teleport(b, centre(start));
      await b.truth.setHealth(b.name, 20);
      await b.truth.ok('clear', [b.name]);
      await b.truth.setslot(b.name, 0, 'iron_pickaxe', 1);
      await b.truth.setslot(b.name, 1, 'iron_shovel', 1);
      await b.truth.setslot(b.name, 2, 'cobblestone', 2);
      await b.truth.setslot(b.name, 3, 'dirt', 64);
      await mob.loop.waitTicks(10);
      await teleport(b, centre(start));
      const since = await b.truth.now();
      const n0 = b.logs.length;
      const from = b.said.length;
      const w0 = water;
      const t0 = performance.now();
      await b.command(`!goto ${goal.x + d.x} ${goal.y} ${goal.z + d.z}`);
      const reply = await b.reply((s) => s.startsWith('arrived') || s.startsWith('goto'), from, RUN_S * 1000).catch((err: unknown) => `no reply: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      const seconds = (performance.now() - t0) / 1000;
      await b.command('!stop');
      await sleep(800);
      const p = (await b.truth.glide(b.name)).location;
      const off = Math.hypot(p.x - to.x, p.y - to.y, p.z - to.z);
      const dmg = await b.truth.damageSince(since, b.name);
      const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
      const end = logs.find((l) => l.startsWith('goto {"type":"block"')) ?? '';
      const plans = /(\d+ plan\(s\)[^,]*), (\d+ segment)/.exec(end);
      rows.push({
        run,
        ok: reply.startsWith('arrived') && off < 2.5,
        off,
        seconds,
        damage: dmg.total,
        water: water - w0,
        placed: logs.filter((l) => l.startsWith('place (')).length,
        broken: logs.filter((l) => /^dig \([^)]*\): \S+ -> /.test(l)).length,
        plans: plans ? `${plans[1]}` : '?',
        reply: reply.slice(0, 160),
      });
      if (process.env.NAV_ENTRY_LOGDIR) writeFileSync(join(process.env.NAV_ENTRY_LOGDIR, `run-${run}.log`), `${b.logs.slice(n0).join('\n')}\n`);
      notes.push(`run ${run}: ${reply}\n    ${logs.filter((l) => /^goto|^place|^surface|^corridor/.test(l)).slice(0, 40).map((l) => l.slice(0, 300)).join('\n    ')}`);
    }
    expect(rows.filter((r) => r.ok).length, rows.map((r) => `${r.run}: ${r.reply}`).join(' | ')).toBe(RUNS);
  }, 3_600_000);
});
