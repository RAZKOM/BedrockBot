// Track W2 way (docs/pathfinding.md "A walk keeps to its way"): the walk from a flight's landing to a goal under a roof,
// offline. The landing search's probe (skills/fly/landprobe.ts, the live budget of its first, long probe) from the
// start, then the REAL navigator's goto in the reach bench's closed loop (test/unit/skills/reach-sim.ts, the live
// settings: allowBreak on, allowPlace off, digPenalty 500, the worker's budgets scaled to the owner's M4), every tick
// traced. Per run: the probe's path (blocks, planned seconds), each plan (reason, kind, status, nodes, its path's blocks,
// where it ends), the blocks of path walked (the polyline of the path nodes the body passed, as the probe's blocks are
// counted), the blocks the body moved (the goto reports' distance: every tick's 3D move), turns back (a cell stood in
// again after the body had been 6 or more blocks from it), seconds and damage.
//
//   node scripts/walk-way-bench.ts --fixture <name> [--pairs a,b] [--repeat 10] [--jobs 4] [--speed 1.25] [--out f.jsonl]
//                                  [--way off] [--handoff on] [--mobs f,f] [--mob-chase v] [--guard f:b] [--log] [--debug]
//
// `--way off`: the navigator as it was before Track W2 way (Navigator.keepWays false: no handed, kept or resumed way).
// `--handoff on`: the probe's path is handed to the goto (GotoOptions.way), as the flight's walk after a landing does.
// `--mobs f,f`: a zombie standing on the probe's path at each fraction of it (the avoidance's costs round it);
// `--mob-chase v`: each walks towards the body at v blocks a tick while within 24 of it.
// `--guard f:b`: a zombie b blocks beside the probe's path at fraction f of it; when the body comes within 8 of it the
// goto is cancelled, the body walks to it (as the guard does), stands 40 ticks, the zombie is gone, and the same goto is
// asked again (`resume`, as GotoProcess asks it after a pre-emption). The detour's own walk is not counted as walked.
//
// The fixture is private (the git-ignored bot/fixtures-private/<name>); without it the bench says so and exits.
import { fork } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capWorkers } from './workers.ts';
import { loadFixture } from '../src/skills/nav/bench/fixture.ts';
import { pathBlocks } from '../src/skills/home/reach.ts';
import { landingProbe } from '../src/skills/fly/landprobe.ts';
import { LONG_PROBE } from '../src/skills/fly/landing.ts';
import { LAND_PROBE_SURFACE } from '../src/chat/commands-fly.ts';
import { runPair } from '../test/unit/skills/reach-sim.ts';
import type { PathNode } from '../src/skills/nav/astar.ts';
import type { NavGotoOptions } from '../src/skills/nav/navigator.ts';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface PlanRow {
  tick: number;
  reason: string;
  kind: string;
  status: string;
  nodes: number;
  blocks: number;
  ends: string;
  expanded: number;
  ms: number;
}

export interface WalkRow {
  tag: string;
  rep: number;
  way: boolean;
  handoff: boolean;
  ok: boolean;
  reply: string;
  probe: { status: string; blocks?: number; s?: number; nodes?: number };
  plans: PlanRow[];
  moved: number;
  walked: number;
  ratio?: number;
  turns: { tick: number; cell: string; away: number }[];
  backtrack: number;
  ticks: number;
  seconds: number;
  damage: number;
  /** `--guard`: the tick the goto was cancelled for the detour and the tick it was asked again. */
  guard?: { at: number; back?: number; mob: string };
  log?: string[];
}

const TOOLS = ['iron_pickaxe', 'iron_shovel'];

interface NavView {
  active?: { path: PathNode[]; passedAbs: number; report: { distance: number; plans: { reason: string; tick: number; status: string; nodes: number; expanded: number; ms: number; interim?: boolean; upgrade?: boolean; way?: string; kept?: string }[] } };
  grid: { stand(x: number, y: number, z: number): number | undefined };
}

async function runJob(fixtureName: string, pairIndex: number, rep: number, speed: number): Promise<WalkRow> {
  const f = loadFixture(fixtureName);
  if (!f) throw new Error(`no fixture ${fixtureName}`);
  const bw = f.world;
  const pair = bw.pairs[pairIndex]!;
  const way = arg('way') !== 'off';
  const handoff = arg('handoff') === 'on';
  const guardArg = arg('guard')?.split(':').map(Number);
  let probe: WalkRow['probe'] = { status: 'none' };
  let probePath: PathNode[] | undefined;
  const cells: { x: number; y: number; z: number; t: number }[] = [];
  const plans: PlanRow[] = [];
  let seenActive: unknown;
  let seenPlans = 0;
  let lastPath: unknown;
  let lastPassed = 0;
  const nodes: { x: number; feet: number; z: number }[] = [];
  const mobs: { id: bigint; x: number; y: number; z: number }[] = [];
  let guardMob: { x: number; y: number; z: number } | undefined;
  let guard: WalkRow['guard'];
  let detouring = false;
  let tickNow = 0;
  let moved = 0;
  let movedActive: { report: { distance: number } } | undefined;
  const waitTicks = async (n: number): Promise<void> => {
    const until = tickNow + n;
    while (tickNow < until) await new Promise((r) => setImmediate(r));
  };
  const r = await runPair(bw, pair, new Map(), {
    tools: TOOLS,
    speed,
    allowBreak: true,
    allowPlace: false,
    digPenalty: 500,
    preload: true,
    timeoutTicks: 12_000,
    logLines: 600,
    ...(way ? {} : { noWay: true }),
    ...(process.argv.includes('--debug') ? { debug: true } : {}),
    before: async (skills) => {
      // the landing search's first probe from the landing cell (the long one: LONG_PROBE), as findLanding asks it
      const nav = skills.nav;
      let path: PathNode[] | undefined;
      const pr = landingProbe({ grid: nav.grid, planOptions: (o) => nav.planOptions(o) }, pair.goal, { budget: { nodes: LONG_PROBE.nodes, ms: LONG_PROBE.ms }, surface: LAND_PROBE_SURFACE, onPath: (p) => (path = p) });
      const out = await pr({ x: pair.start.x + 0.5, y: pair.start.y, z: pair.start.z + 0.5 });
      probe = out.status === 'found' ? { status: 'found', blocks: +out.blocks.toFixed(1), s: out.ticks !== undefined ? +(out.ticks / 20).toFixed(1) : undefined, nodes: path?.length } : { status: out.status };
      probePath = path;
      // `--guard f:b`: a standable cell b (within 1.5) blocks from the path's node at f, 3 or more from every node of it
      if (guardArg && path) {
        const [fr, b] = [guardArg[0]!, guardArg[1]!];
        const n = path[Math.min(path.length - 1, Math.floor(fr * path.length))]!;
        let best: { x: number; y: number; z: number; d: number } | undefined;
        for (let dx = -b - 2; dx <= b + 2; dx++) {
          for (let dz = -b - 2; dz <= b + 2; dz++) {
            const d = Math.hypot(dx, dz);
            if (Math.abs(d - b) > 1.5) continue;
            for (let dy = -3; dy <= 3; dy++) {
              const [x, y, z] = [n.x + dx, n.y + dy, n.z + dz];
              const feet = (nav.grid as NavView['grid']).stand(x, y, z);
              if (feet === undefined || Number.isNaN(feet)) continue;
              if (path.some((m) => Math.hypot(m.x - x, m.feet - feet, m.z - z) < 3)) continue;
              const score = Math.abs(d - b) + Math.abs(dy) * 0.5;
              if (!best || score < best.d) best = { x, y: feet, z, d: score };
            }
          }
        }
        if (best) guardMob = { x: best.x + 0.5, y: best.y, z: best.z + 0.5 };
      }
      return handoff && path ? { way: path } : {};
    },
    trace: (tick, pos, onGround, navU) => {
      tickNow = tick;
      const nav = navU as NavView;
      const a = nav.active;
      if (detouring) return;
      if (onGround) {
        const c = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-3), z: Math.floor(pos.z) };
        const last = cells.at(-1);
        if (last?.x !== c.x || last.y !== c.y || last.z !== c.z) cells.push({ ...c, t: tick });
      }
      if (!a) return;
      if (a !== seenActive) {
        seenActive = a;
        seenPlans = 0;
      }
      if (movedActive !== a) {
        if (movedActive) moved += movedActive.report.distance;
        movedActive = a;
      }
      const ps = a.report.plans;
      for (; seenPlans < ps.length; seenPlans++) {
        const p = ps[seenPlans]!;
        const path = a.path;
        const end = path.at(-1);
        const kind = p.way ? `way-${p.way}` : p.interim ? 'interim' : p.upgrade ? (p.kept ? `beside(${p.kept})` : 'final') : 'plain';
        plans.push({ tick, reason: p.reason, kind, status: p.status, nodes: p.nodes, blocks: +pathBlocks(path).toFixed(1), ends: end ? `${end.x} ${end.feet} ${end.z}` : '-', expanded: p.expanded, ms: p.ms });
      }
      // the way walked: the path's nodes the body passed, in order (a new path from the node it passed last)
      const pa = a.passedAbs;
      if (a.path !== lastPath) {
        lastPath = a.path;
        lastPassed = pa;
        const n = a.path[pa];
        const prev = nodes.at(-1);
        if (n && !(prev?.x === n.x && prev.feet === n.feet && prev.z === n.z)) nodes.push({ x: n.x, feet: n.feet, z: n.z });
      } else if (pa > lastPassed) {
        for (let i = lastPassed + 1; i <= pa; i++) {
          const n = a.path[i];
          if (n) nodes.push({ x: n.x, feet: n.feet, z: n.z });
        }
        lastPassed = pa;
      }
    },
    onTick: (tick, src, pos) => {
      const spawn = (i: number, p: { x: number; y: number; z: number }): void => {
        mobs.push({ id: BigInt(900 + i), ...p });
        src.emit('add_entity', { unique_id: -BigInt(900 + i), runtime_id: BigInt(900 + i), entity_type: 'minecraft:zombie', position: p, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0 });
      };
      if (tick === 0 && probePath) {
        arg('mobs')?.split(',').map(Number).forEach((q, i) => {
          const n = probePath![Math.min(probePath!.length - 1, Math.floor(q * probePath!.length))]!;
          spawn(i, { x: n.x + 0.5, y: n.feet, z: n.z + 0.5 });
        });
        if (guardMob) spawn(50, guardMob);
      }
      if (guardMob && tick === 1 && guard === undefined) guard = { at: -1, mob: `${guardMob.x - 0.5} ${guardMob.y} ${guardMob.z - 0.5}` };
      const v = Number(arg('mob-chase') ?? 0);
      if (v > 0 && tick > 0) {
        for (const m of mobs) {
          const d = Math.hypot(pos.x - m.x, pos.z - m.z);
          if (d > 24 || d < 2) continue;
          m.x += ((pos.x - m.x) / d) * v;
          m.z += ((pos.z - m.z) / d) * v;
          src.emit('move_entity', { runtime_entity_id: m.id, flags: 0, position: { x: m.x, y: m.y, z: m.z }, rotation: { x: 0, y: 0, z: 0, head_yaw: 0 } });
        }
      }
      if (guard && guard.back === undefined && guard.at >= 0 && !detouring) guard.back = tick;
      if (guard?.at === -2) {
        // the fight is over: the zombie is gone
        guard.at = tick;
        src.emit('remove_entity', { entity_id_self: -BigInt(950) });
      }
    },
    interrupt: (tick, skills, pos) => {
      if (!guardMob || guard?.at !== -1) return undefined;
      if (Math.hypot(pos.x - guardMob.x, pos.y - guardMob.y, pos.z - guardMob.z) > 8) return undefined;
      const mob = guardMob;
      return async () => {
        detouring = true;
        const at = tick;
        // the guard: to the hostile, a fight's 40 ticks, then the walk goes on
        await skills.goto({ type: 'near', p: mob, r: 2.5 }, { timeoutTicks: 400, allowBreak: false, allowPlace: false });
        await waitTicks(40);
        guard!.at = -2;
        await waitTicks(1);
        guard!.at = at;
        detouring = false;
      };
    },
    resumeOpts: { resume: true } satisfies Partial<NavGotoOptions>,
  });
  if (movedActive) moved += movedActive.report.distance;
  const walked = pathBlocks(nodes);
  // turns back: a cell stood in again after the body had been 6 or more blocks (straight line) from it
  const turns: WalkRow['turns'] = [];
  let backtrack = 0;
  const firstAt = new Map<string, number>();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const k = `${c.x},${c.y},${c.z}`;
    const j = firstAt.get(k);
    if (j === undefined) {
      firstAt.set(k, i);
      continue;
    }
    let away = 0;
    for (let m = j + 1; m < i; m++) away = Math.max(away, Math.hypot(cells[m]!.x - c.x, cells[m]!.y - c.y, cells[m]!.z - c.z));
    if (away >= 6) {
      turns.push({ tick: c.t, cell: k, away: +away.toFixed(1) });
      for (let m = j + 1; m <= i; m++) backtrack += Math.hypot(cells[m]!.x - cells[m - 1]!.x, cells[m]!.y - cells[m - 1]!.y, cells[m]!.z - cells[m - 1]!.z) / 2;
    }
    firstAt.set(k, i);
  }
  return {
    tag: pair.tag,
    rep,
    way,
    handoff,
    ok: r.ok,
    reply: r.reply,
    probe,
    plans,
    moved: +moved.toFixed(1),
    walked: +walked.toFixed(1),
    ...(probe.blocks ? { ratio: +(walked / probe.blocks).toFixed(3) } : {}),
    turns,
    backtrack: +backtrack.toFixed(1),
    ticks: r.ticks,
    seconds: +(r.ticks / 20).toFixed(1),
    damage: r.damage,
    ...(guard ? { guard } : {}),
    ...(process.argv.includes('--log') ? { log: r.log } : {}),
  };
}

function child(): void {
  const speed = Number(arg('speed') ?? 1.25);
  process.on('message', (j: { pair: number; rep: number } | { done: true }) => {
    if ('done' in j) process.exit(0);
    runJob(arg('fixture')!, j.pair, j.rep, speed).then(
      (row) => process.send!({ row }),
      (e: unknown) => process.send!({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) }),
    );
  });
  process.send!({ ready: true });
}

async function main(): Promise<void> {
  const name = arg('fixture');
  const f = name ? loadFixture(name) : undefined;
  if (!f) {
    console.log(`no fixture ${name ?? '(none given)'}: skipped`);
    return;
  }
  const want = arg('pairs')?.split(',');
  const repeat = Number(arg('repeat') ?? 1);
  const jobs: { pair: number; rep: number }[] = [];
  for (let rep = 1; rep <= repeat; rep++) f.world.pairs.forEach((p, i) => (!want || want.includes(p.tag)) && jobs.push({ pair: i, rep }));
  const out = arg('out') ?? 'walk-way-bench.jsonl';
  writeFileSync(out, '');
  const rows: WalkRow[] = [];
  const self = fileURLToPath(import.meta.url);
  let next = 0;
  let errors = 0;
  await Promise.all(
    Array.from({ length: Math.min(capWorkers(Number(arg('jobs') ?? 4)), jobs.length) }, () => {
      return new Promise<void>((resolve) => {
        const c = fork(self, ['--child', ...process.argv.slice(2)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=6144'] });
        const give = (): void => {
          const j = jobs[next++];
          c.send(j ?? { done: true });
        };
        c.on('message', (m: { ready?: boolean; row?: WalkRow; error?: string }) => {
          if (m.row) {
            rows.push(m.row);
            appendFileSync(out, JSON.stringify(m.row) + '\n');
            const w = m.row;
            console.log(`${w.tag} #${w.rep}${w.way ? '' : ' (way off)'}${w.handoff ? ' handoff' : ''}: ${w.ok ? 'arrived' : w.reply} probe ${w.probe.status}${w.probe.blocks !== undefined ? ` ${w.probe.blocks} (${w.probe.s} s)` : ''}; walked ${w.walked} (x${w.ratio ?? '?'}), moved ${w.moved}, ${w.plans.length} plans, ${w.seconds} s, turns ${w.turns.length} (back ${w.backtrack}), damage ${w.damage}${w.guard ? `, guard at t${w.guard.at} back t${w.guard.back ?? '-'} (mob ${w.guard.mob})` : ''}`);
            for (const p of w.plans) console.log(`    t${p.tick} ${p.reason} ${p.kind} ${p.status} ${p.nodes} nodes ${p.blocks} blocks -> ${p.ends} (${p.expanded} expanded, ${p.ms} ms)`);
          }
          if (m.error) {
            errors++;
            console.error(`job error: ${m.error}`);
          }
          if (m.ready || m.row || m.error) give();
        });
        c.on('exit', () => resolve());
      });
    }),
  );
  // summary per goal: walked / probe, plans, seconds, turns back, damage
  const tags = [...new Set(rows.map((r) => r.tag))];
  console.log('| goal | runs | arrived | probe blocks | walked p50 / max | walked / probe p50 / max | moved p50 | plans p50 / max | s p50 / max | turns back (runs) | damage max |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? NaN;
  for (const t of tags) {
    const rs = rows.filter((r) => r.tag === t);
    const pb = [...new Set(rs.map((r) => r.probe.blocks))].join('/');
    const ratios = rs.map((r) => r.ratio ?? 0);
    console.log(`| ${t} | ${rs.length} | ${rs.filter((r) => r.ok).length} | ${pb} | ${med(rs.map((r) => r.walked))} / ${Math.max(...rs.map((r) => r.walked))} | ${med(ratios).toFixed(3)} / ${Math.max(...ratios).toFixed(3)} | ${med(rs.map((r) => r.moved))} | ${med(rs.map((r) => r.plans.length))} / ${Math.max(...rs.map((r) => r.plans.length))} | ${med(rs.map((r) => r.seconds))} / ${Math.max(...rs.map((r) => r.seconds))} | ${rs.reduce((s, r) => s + r.turns.length, 0)} (${rs.filter((r) => r.turns.length > 0).length}) | ${Math.max(...rs.map((r) => r.damage))} |`);
  }
  console.log(`${rows.length} runs, ${errors} errors; results in ${out}`);
  if (errors) process.exitCode = 1;
}

if (process.argv.includes('--child')) child();
else void main();
