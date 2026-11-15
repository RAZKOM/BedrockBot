// e2e (tag @bds), Track W2 way (docs/pathfinding.md "A walk keeps to its way", decisions/0088-a-walk-keeps-to-its-way.md):
// the walk from a flight's landing at a cave's mouth to goals deep in the cave, on a server. The box of the bot's world
// cache is rebuilt as nav-cave-entry.test.ts rebuilds it (`truth:cave`, stone over the box, then its air and water),
// moved in x and z by a multiple of 16 to NAV_WAY_AT (default -80000,-80000), on the server FLY_BDS_PORT /
// FLY_BDS_CONTAINER name. The box is PRIVATE data: the extract, the waypoints and the pairs (fixture.json: a start cell
// and a goal waypoint each) come from the git-ignored bot/fixtures-private/cave-2026-11-14-wide (NAV_WAY_DIR) and this
// suite skips without it.
//
// Per run, from the start cell: the landing search's long probe (landprobe.ts, as findLanding asks it first) on the
// bot's own grid, then the goto to the goal's cell with the live walking settings (allowBreak on, allowPlace off,
// digPenalty 500, sprint), on one of two sides: `before` (Navigator.keepWays false: no handed, kept or resumed way) or
// `after` (the probe's path handed to the goto as GotoOptions.way, as the flight's walk after a landing does).
// NAV_WAY_GUARD=1: once the body is within 3 of the probe path's node at 0.3 of it, the goto is cancelled, the body
// walks to a cell 5 off the path, stands 40 ticks, and the same goto is asked again with `resume` (GotoProcess's resume
// after the guard; bds-cache is peaceful, so no mob is summoned). Per run: the probe's blocks, the blocks of path walked
// (the polyline of the path nodes the body passed, as the probe's blocks are counted), the blocks moved (the goto
// reports' distance), turns back (a cell stood in again after the body had been 6 or more from it), seconds, damage and
// each plan's INFO line. NAV_WAY_RUNS (10), NAV_WAY_GOALS (the pairs' tags), NAV_WAY_SIDES (before,after),
// NAV_WAY_REUSE=1 (the replica is still there), NAV_WAY_REPORT=<file> (JSON lines).
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boxMessages, CAVE_AIR, CAVE_STONE, CAVE_WATER, greedyBoxes } from '../../../packs/truth/src/cave-layout.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { attachCoarseLayer, type CoarseLayerImpl } from '../../src/skills/coarse/index.ts';
import { caveWorld, loadCaveFixture, shift } from '../../src/skills/fly/corridor/cave.ts';
import { landingProbe } from '../../src/skills/fly/landprobe.ts';
import { LONG_PROBE } from '../../src/skills/fly/landing.ts';
import { LAND_PROBE_SURFACE } from '../../src/chat/commands-fly.ts';
import { pathBlocks } from '../../src/skills/home/reach.ts';
import type { PathNode } from '../../src/skills/nav/astar.ts';
import { CLS_AIR, CLS_WATER } from '../../src/world/cache/types.ts';
import { WorldCache } from '../../src/world/cache/cache.ts';
import { E2E, prepareServer, sleep, startFlyBot, teleport, type FlyBot } from './fly-truth.ts';

const DIR = process.env.NAV_WAY_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures-private/cave-2026-11-14-wide');
const fix = loadCaveFixture(DIR);
const pairsFile = join(DIR, 'fixture.json');
const PAIRS: { start: Vec3; goal: string; tag: string }[] = existsSync(pairsFile) ? ((JSON.parse(readFileSync(pairsFile, 'utf8')) as { pairs?: { start: Vec3; goal: string; tag: string }[] }).pairs ?? []) : [];
const RUNS = Number(process.env.NAV_WAY_RUNS ?? 10);
const GOALS = process.env.NAV_WAY_GOALS?.split(',') ?? PAIRS.filter((p) => !p.tag.startsWith('guard')).map((p) => p.tag);
const SIDES = (process.env.NAV_WAY_SIDES ?? 'before,after').split(',') as ('before' | 'after')[];
const GUARD = process.env.NAV_WAY_GUARD === '1';
const REUSE = process.env.NAV_WAY_REUSE === '1';
const RUN_S = Number(process.env.NAV_WAY_RUN_S ?? 240);
const PART_CHARS = 1800;
const PART_JOBS = 6;

interface NavView {
  keepWays: boolean;
  active?: { path: PathNode[]; passedAbs: number; report: { distance: number } };
  grid: { stand(x: number, y: number, z: number): number | undefined };
}

interface Row {
  tag: string;
  side: string;
  run: number;
  ok: boolean;
  reply: string;
  probe: number | undefined;
  walked: number;
  ratio: number | undefined;
  moved: number;
  turns: number;
  seconds: number;
  damage: number;
  plans: string[];
  guard?: string;
}

describe.skipIf(!E2E || !fix || PAIRS.length === 0)('@bds nav: a walk keeps to its way, the landing to goals in a real cave (Track W2 way)', () => {
  if (!fix) return;
  const e = fix.extract;
  const world = caveWorld(e);
  const pinned = process.env.NAV_WAY_AT?.split(',').map(Number);
  const at = pinned?.length === 2 && pinned.every(Number.isFinite) ? { x: pinned[0]!, z: pinned[1]! } : { x: -80000, z: -80000 };
  const d: Vec3 = { x: Math.floor(at.x / 16) * 16 - Math.floor(e.box.min.x / 16) * 16, y: 0, z: Math.floor(at.z / 16) * 16 - Math.floor(e.box.min.z / 16) * 16 };
  // only the part of the box round the walks is built (NAV_WAY_MARGIN blocks round the starts and the goals by the plane,
  // the box's whole height): the whole box is some 66 million cells
  const MARGIN = Number(process.env.NAV_WAY_MARGIN ?? 48);
  const pts = PAIRS.flatMap((p) => [p.start, fix.waypoints.get(p.goal)].filter((q): q is Vec3 => q !== undefined));
  const box = {
    min: { x: Math.max(e.box.min.x, Math.min(...pts.map((p) => p.x)) - MARGIN), y: e.box.min.y, z: Math.max(e.box.min.z, Math.min(...pts.map((p) => p.z)) - MARGIN) },
    max: { x: Math.min(e.box.max.x, Math.max(...pts.map((p) => p.x)) + MARGIN), y: e.box.max.y, z: Math.min(e.box.max.z, Math.max(...pts.map((p) => p.z)) + MARGIN) },
  };
  const size = { x: box.max.x - box.min.x + 1, y: box.max.y - box.min.y + 1, z: box.max.z - box.min.z + 1 };
  const min = shift(box.min, d);
  const moved = (p: Vec3): Vec3 => ({ x: p.x + d.x, y: p.y, z: p.z + d.z });
  const centre = (p: Vec3): Vec3 => ({ x: p.x + d.x + 0.5, y: p.y, z: p.z + d.z + 0.5 });
  const feet = (p: Vec3): Vec3 => {
    const f = world.feetCell({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    if (!f) throw new Error('no standable cell at a fixture point');
    return f;
  };
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  let cache: WorldCache | undefined;
  let cacheDir: string | undefined;
  let coarse: { layer: CoarseLayerImpl; detach: () => void } | undefined;
  let offNav: (() => void) | undefined;

  async function buildReplica(b: FlyBot): Promise<void> {
    const t0 = performance.now();
    const code = (x: number, y: number, z: number): number => {
      const c = e.cls(box.min.x + x, box.min.y + y, box.min.z + z);
      return c === CLS_AIR ? CAVE_AIR : c === CLS_WATER ? CAVE_WATER : CAVE_STONE;
    };
    const boxes = [...greedyBoxes(size, code, CAVE_AIR), ...greedyBoxes(size, code, CAVE_WATER)];
    const parts = boxMessages(boxes, PART_CHARS);
    const session = `w${Math.random().toString(36).slice(2, 8)}`;
    const ok = async (args: (string | number)[], ms: number): Promise<Record<string, unknown>> => {
      const r = await b.truth.cmd<Record<string, unknown>>('cave', args, ms);
      if (!r.ok) throw new Error(`truth:cave ${String(args[0])} failed: ${r.reason} ${JSON.stringify(r.data)}`);
      return r.data;
    };
    await ok(['begin', session, min.x, min.y, min.z, size.x, size.y, size.z], 30_000);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < parts.length; i = next++) await ok(['part', session, i, parts[i]!], 60_000);
    };
    await Promise.all(Array.from({ length: PART_JOBS }, worker));
    const r = await ok(['build', session, parts.length], 3_600_000);
    notes.push(`build: box ${size.x} x ${size.y} x ${size.z}, ${boxes.length} boxes in ${parts.length} parts, ${String(r.pieces)} pieces, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }

  async function flyOver(b: FlyBot): Promise<void> {
    let n = 0;
    for (let x = box.min.x + 8; x <= box.max.x + 24; x += 48) {
      for (let z = box.min.z + 8; z <= box.max.z + 24; z += 48) {
        const cx = Math.min(x, box.max.x - 8);
        const cz = Math.min(z, box.max.z - 8);
        const top = e.top(cx, cz);
        const y = top !== undefined && top > -1000 ? Math.min(top + 1, box.max.y) : box.max.y;
        const f = world.feetCell({ x: cx, y, z: cz });
        if (!f) continue;
        await teleport(b, centre(f));
        n++;
      }
    }
    await b.built.mobility!.loop.waitTicks(20);
    notes.push(`fly-over: ${n} surface points`);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Wy');
    await bot.command('!set autoFly off');
    await sleep(300);
    const mob = bot.built.mobility!;
    const away: Vec3 = { x: min.x - 400.5, y: -60, z: min.z - 0.5 };
    await teleport(bot, away);
    if (!REUSE) await buildReplica(bot);
    else notes.push('build: reused (NAV_WAY_REUSE=1)');
    cacheDir = mkdtempSync(join(tmpdir(), 'bb-way-e2e-'));
    cache = new WorldCache({ dir: cacheDir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(mob.world);
    await flyOver(bot);
    await teleport(bot, away);
    coarse = attachCoarseLayer(mob.world);
    if (!coarse) throw new Error('no coarse layer: the world has no cache');
    offNav = mob.skills.nav.attachCoarse(coarse.layer, { minBlocks: () => 96 });
    for (const [k, v] of [
      ['allowBreak', 'on'],
      ['allowPlace', 'off'],
      ['digPenalty', '500'],
      ['sprint', 'on'],
    ] as const)
      bot.settings.set(k, v);
  }, 4_800_000);

  afterAll(async () => {
    offNav?.();
    coarse?.detach();
    if (bot) await bot.stop();
    cache?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    const q = (xs: number[], f: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(f * xs.length))] ?? NaN;
    const lines = ['| goal | side | runs | arrived | probe | walked / probe p50 / max | moved p50 | plans p50 / max | s p50 / max | turns back (runs) | damage max |', '|---|---|---|---|---|---|---|---|---|---|---|'];
    for (const tag of GOALS) {
      for (const side of SIDES) {
        const rs = rows.filter((r) => r.tag === tag && r.side === side);
        if (rs.length === 0) continue;
        const ratios = rs.map((r) => r.ratio ?? NaN);
        const pl = rs.map((r) => r.plans.length);
        const s = rs.map((r) => r.seconds);
        lines.push(`| ${tag} | ${side} | ${rs.length} | ${rs.filter((r) => r.ok).length} | ${rs[0]!.probe ?? '-'} | ${q(ratios, 0.5).toFixed(3)} / ${Math.max(...ratios).toFixed(3)} | ${q(rs.map((r) => r.moved), 0.5)} | ${q(pl, 0.5)} / ${Math.max(...pl)} | ${q(s, 0.5)} / ${Math.max(...s)} | ${rs.reduce((a, r) => a + r.turns, 0)} (${rs.filter((r) => r.turns > 0).length}) | ${Math.max(...rs.map((r) => r.damage))} |`);
      }
    }
    console.log(`[nav-way e2e] replica moved by a multiple of 16 to (${min.x}, ${min.z})${GUARD ? ', the walk interrupted at 0.3' : ''}\n${lines.join('\n')}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it(`the landing to each goal, ${RUNS} runs a side (${SIDES.join(', ')})${GUARD ? ', interrupted' : ''}`, async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const nav = mob.skills.nav as unknown as NavView;
    for (let run = 1; run <= RUNS; run++) {
      for (const tag of GOALS) {
        const pair = PAIRS.find((p) => p.tag === tag);
        const wp = pair && fix.waypoints.get(pair.goal);
        if (!pair || !wp) throw new Error(`no pair or waypoint ${tag}`);
        const start = feet(pair.start);
        const goal = moved(feet(wp));
        for (const side of SIDES) {
          await b.command('!stop');
          await sleep(400);
          await teleport(b, centre(start));
          await b.truth.setHealth(b.name, 20);
          await b.truth.ok('clear', [b.name]);
          await b.truth.setslot(b.name, 0, 'iron_pickaxe', 1);
          await b.truth.setslot(b.name, 1, 'iron_shovel', 1);
          await mob.loop.waitTicks(10);
          await teleport(b, centre(start));
          nav.keepWays = side === 'after';
          // the landing search's long probe, from where the body stands
          let way: PathNode[] | undefined;
          const probe = await landingProbe({ grid: mob.skills.nav.grid, planOptions: (o) => mob.skills.nav.planOptions(o) }, goal, { budget: { nodes: LONG_PROBE.nodes, ms: LONG_PROBE.ms }, surface: LAND_PROBE_SURFACE, onPath: (p) => (way = p) })(centre(start));
          const probeBlocks = probe.status === 'found' ? +probe.blocks.toFixed(1) : undefined;
          // the trace: cells stood in, path nodes passed, moved
          const cells: string[] = [];
          const cellAt: Vec3[] = [];
          const nodes: { x: number; feet: number; z: number }[] = [];
          let lastPath: unknown;
          let lastPassed = 0;
          let movedSum = 0;
          let act: NavView['active'];
          let paused = false;
          const off = mob.loop.onBeforeStep((_t, s) => {
            if (paused) return;
            if (s.onGround) {
              const c = { x: Math.floor(s.pos.x), y: Math.floor(s.pos.y + 1e-3), z: Math.floor(s.pos.z) };
              const k = `${c.x},${c.y},${c.z}`;
              if (cells.at(-1) !== k) {
                cells.push(k);
                cellAt.push(c);
              }
            }
            const a = nav.active;
            if (!a) return;
            if (act !== a) {
              if (act) movedSum += act.report.distance;
              act = a;
            }
            if (a.path !== lastPath) {
              lastPath = a.path;
              lastPassed = a.passedAbs;
              const n = a.path[a.passedAbs];
              const prev = nodes.at(-1);
              if (n && !(prev?.x === n.x && prev.feet === n.feet && prev.z === n.z)) nodes.push({ x: n.x, feet: n.feet, z: n.z });
            } else if (a.passedAbs > lastPassed) {
              for (let i = lastPassed + 1; i <= a.passedAbs; i++) {
                const n = a.path[i];
                if (n) nodes.push({ x: n.x, feet: n.feet, z: n.z });
              }
              lastPassed = a.passedAbs;
            }
          });
          const since = await b.truth.now();
          const n0 = b.logs.length;
          const t0 = performance.now();
          const target = { type: 'block' as const, p: goal };
          const opts = { timeoutTicks: RUN_S * 20, ...(side === 'after' && way ? { way } : {}) };
          let guard: string | undefined;
          let watch: Promise<void> | undefined;
          if (GUARD && way) {
            const w = way;
            const n = w[Math.floor(0.3 * w.length)]!;
            // a cell 5 off the path's node at 0.3 and 3 or more from every node of it
            let side5: Vec3 | undefined;
            for (let r = 0; r < 3 && !side5; r++) {
              for (let dx = -7; dx <= 7 && !side5; dx++) {
                for (let dz = -7; dz <= 7 && !side5; dz++) {
                  if (Math.abs(Math.hypot(dx, dz) - 5) > 0.5 + r * 0.5) continue;
                  for (let dy = -3; dy <= 3; dy++) {
                    const f = nav.grid.stand(n.x + dx, n.y + dy, n.z + dz);
                    if (f === undefined || Number.isNaN(f)) continue;
                    if (w.some((m) => Math.hypot(m.x - n.x - dx, m.feet - f, m.z - n.z - dz) < 3)) continue;
                    side5 = { x: n.x + dx + 0.5, y: f, z: n.z + dz + 0.5 };
                    break;
                  }
                }
              }
            }
            if (side5) {
              const to = side5;
              watch = (async () => {
                while (performance.now() - t0 < RUN_S * 1000) {
                  await mob.loop.waitTicks(1);
                  const p = b.task.position();
                  if (p && Math.hypot(p.x - n.x - 0.5, p.y - n.feet, p.z - n.z - 0.5) < 3) {
                    paused = true;
                    mob.skills.cancel();
                    await mob.loop.waitTicks(2);
                    await mob.skills.goto({ type: 'near', p: to, r: 1.5 }, { timeoutTicks: 400, allowBreak: false, allowPlace: false });
                    await mob.loop.waitTicks(40);
                    guard = `left the way at its node ${Math.floor(0.3 * w.length)} of ${w.length} for ${to.x - 0.5} ${to.y} ${to.z - 0.5}`;
                    paused = false;
                    return;
                  }
                }
              })();
            } else guard = 'no cell 5 off the path';
          }
          let res = await mob.skills.goto(target, opts);
          if (watch) {
            await watch;
            if (guard?.startsWith('left')) res = await mob.skills.goto(target, { ...opts, resume: true });
          }
          const seconds = (performance.now() - t0) / 1000;
          off();
          if (act) movedSum += act.report.distance;
          const dmg = await b.truth.damageSince(since, b.name);
          const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
          // turns back: a cell stood in again after the body had been 6 or more blocks from it
          let turns = 0;
          const first = new Map<string, number>();
          for (let i = 0; i < cells.length; i++) {
            const j = first.get(cells[i]!);
            first.set(cells[i]!, i);
            if (j === undefined) continue;
            let away = 0;
            for (let m = j + 1; m < i; m++) away = Math.max(away, Math.hypot(cellAt[m]!.x - cellAt[i]!.x, cellAt[m]!.y - cellAt[i]!.y, cellAt[m]!.z - cellAt[i]!.z));
            if (away >= 6) turns++;
          }
          const walked = +pathBlocks(nodes).toFixed(1);
          const row: Row = {
            tag,
            side,
            run,
            ok: res.ok,
            reply: res.ok ? 'arrived' : `${res.reason ?? ''}`.slice(0, 160),
            probe: probeBlocks,
            walked,
            ratio: probeBlocks ? +(walked / probeBlocks).toFixed(3) : undefined,
            moved: +movedSum.toFixed(1),
            turns,
            seconds: +seconds.toFixed(1),
            damage: dmg.total,
            plans: logs.filter((l) => l.startsWith('goto: plan') || l.startsWith('goto: walking') || l.startsWith('goto: back onto') || /goto: .*(its way|the fresh plan)/.test(l)).map((l) => l.slice(0, 260)),
            ...(guard ? { guard } : {}),
          };
          rows.push(row);
          if (process.env.NAV_WAY_REPORT) appendFileSync(process.env.NAV_WAY_REPORT, `${JSON.stringify(row)}\n`);
        }
      }
    }
    expect(rows.filter((r) => !r.ok).map((r) => `${r.tag} ${r.side} #${r.run}: ${r.reply}`)).toEqual([]);
  }, 14_400_000);
});
