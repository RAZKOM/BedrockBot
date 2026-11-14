// Track R7 (docs/pathfinding.md "A walk that starts or ends where the body is held low (Track R7)";
// decisions/0072-reachability.md "R7") on bds-pve: a fence under a roof's eave, the eave's block 1.5 over the fence's top,
// where the server holds the body crouched (its box 1.49 high) with no sneak key.
//   probe-*   what the server does with the body on that top: forward with no key, forward sneaking (the per-tick
//             positions, the corrections, the box height the server sends)
//   start-*   a walk from the top 15 blocks east onto the grass: start-before (low perches off: unreachable, no plan),
//             start-<eave>-<spot> (eave one / stairb / stairt; spot centre / along / across), start-over (set 0.5 over the
//             top and the walk at once, the teleport's answer calling the body grounded: the Realm's first failure)
//   goal-*    a walk from 15 blocks east to the cell over the fence under the eave: goal-before (unreachable), goal-one,
//             goal-stairb (next to it with the note)
//   kind-*    Part 2, a block goal nobody stands in 15 blocks off, with `beside` (the `!goto` command's) and -before without:
//             kind-planks (inside a block of planks), kind-headroom (planks where the head goes), kind-air2 (2 over the grass)
// R7_RUNS runs a case (default 10), R7_CASES a comma list, R7_OUT a JSONL of the rows. Needs BDS_E2E=1 and bds-pve with
// the truth pack (PVE_BDS_PORT / PVE_BDS_CONTAINER for another server with the pack: bds-core).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { yawTowards } from '../../src/skills/nav/follower.ts';
import { SETTLE_TICKS } from '../../src/skills/nav/navigator.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { botDamage, centre, E2E, FEET_Y, fill, prepareServer, privateArea, pveCmd, sleep, startPveBot, teleport, type PveBot } from './pve-truth.ts';

const RUNS = Number(process.env.R7_RUNS ?? 10);
const PROBES = ['probe-one', 'probe-wide', 'probe-stairb', 'probe-stairt'];
const STARTS = ['start-before', ...['one', 'stairb', 'stairt'].flatMap((e) => ['centre', 'along', 'across'].map((p) => `start-${e}-${p}`)), 'start-over'];
const GOALS = ['goal-before', 'goal-one', 'goal-stairb'];
const KINDS = ['kind-planks', 'kind-headroom', 'kind-air2'].flatMap((k) => [`${k}-before`, k]);
const ALL = [...PROBES, ...STARTS, ...GOALS, ...KINDS];
const CASES = (process.env.R7_CASES ?? ALL.join(',')).split(',').map((s) => s.trim());
const OUT = process.env.R7_OUT;

function note(row: Record<string, unknown>): void {
  console.log(JSON.stringify(row));
  if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

/** The eave over the fence line: `one` planks over the line only, `wide` planks over it and the columns beside, `stairb` / `stairt` spruce stairs (bottom / top half) over the line. */
type Eave = 'one' | 'wide' | 'stairb' | 'stairt';

describe.skipIf(!E2E)('nav: Track R7 a fence under an eave', () => {
  let bot: PveBot | undefined;
  const area = privateArea();
  let next = 0;
  const flags: string[] = [];

  /** A fresh site: grass, air over it, a spruce fence line along z at x0 (z0 - 2 .. z0 + 2), the eave 3 over the fence's block. */
  async function site(b: PveBot, eave: Eave): Promise<{ x0: number; z0: number; top: number }> {
    const i = next++;
    const x0 = area.x + 40 * (i % 6) - 100;
    const z0 = area.z + 40 * Math.floor(i / 6) - 100;
    await teleport(b, centre({ x: x0 - 3, y: FEET_Y, z: z0 }));
    await fill(b, { x: x0 - 8, y: FEET_Y - 1, z: z0 - 8 }, { x: x0 + 28, y: FEET_Y - 1, z: z0 + 8 }, 'grass_block');
    await fill(b, { x: x0 - 8, y: FEET_Y, z: z0 - 8 }, { x: x0 + 28, y: FEET_Y + 8, z: z0 + 8 }, 'air');
    await pveCmd('fill', `${x0}`, `${FEET_Y}`, `${z0 - 2}`, `${x0}`, `${FEET_Y}`, `${z0 + 2}`, 'spruce_fence');
    const ey = FEET_Y + 3;
    if (eave === 'one') await fill(b, { x: x0, y: ey, z: z0 - 2 }, { x: x0, y: ey, z: z0 + 2 }, 'oak_planks');
    else if (eave === 'wide') await fill(b, { x: x0 - 1, y: ey, z: z0 - 2 }, { x: x0 + 2, y: ey, z: z0 + 2 }, 'oak_planks');
    else {
      const up = eave === 'stairt' ? 'true' : 'false';
      await pveCmd('fill', `${x0}`, `${ey}`, `${z0 - 2}`, `${x0}`, `${ey}`, `${z0 + 2}`, 'spruce_stairs', `["upside_down_bit"=${up},"weirdo_direction"=0]`);
    }
    await sleep(300);
    await b.truth.clearAround({ x: x0, y: FEET_Y, z: z0 }, 48);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    return { x0, z0, top: FEET_Y + 1.5 };
  }

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    bot = await startPveBot('R7Low');
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
    const self = bot.conn.runtimeId;
    (bot.conn as unknown as { on(e: string, f: (p: { runtime_entity_id: bigint | number; metadata?: { key?: string; value?: unknown }[] }) => void): void }).on('set_entity_data', (p) => {
      if (BigInt(p.runtime_entity_id) !== (self ?? bot!.conn.runtimeId)) return;
      const f = p.metadata?.find((m) => m.key === 'flags')?.value as Record<string, boolean> | undefined;
      const h = p.metadata?.find((m) => m.key === 'boundingbox_height')?.value as number | undefined;
      if (f || h !== undefined) flags.push(`${f ? `sneaking=${String(f.sneaking)}` : ''}${h !== undefined ? ` h=${String(h)}` : ''}`);
    });
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
  });

  /** On the top's centre, then `ticks` of forward towards +x (off the line onto the grass), sneaking or not. */
  async function probe(eave: Eave, sneak: boolean, k: number): Promise<Record<string, unknown>> {
    const b = bot!;
    const { x0, z0, top } = await site(b, eave);
    const at: Vec3 = { x: x0 + 0.5, y: top, z: z0 + 0.5 + (k % 3) * 0.1 - 0.1 };
    await teleport(b, at);
    const loop = b.built.mobility!.loop;
    flags.length = 0;
    await loop.waitTicks(10);
    const pose0 = loop.state.poseHeight;
    const c0 = loop.state.corrections;
    const yaw = yawTowards(1, 0);
    const trace: string[] = [];
    const fixes: string[] = [];
    const offEv = loop.onEvent((e) => {
      if (e.kind === 'correction') fixes.push(`${e.local ? `${(e.local.x - x0).toFixed(3)},${(e.local.y - FEET_Y).toFixed(3)}` : '?'}->${(e.server.x - x0).toFixed(3)},${(e.server.y - FEET_Y).toFixed(3)}`);
    });
    let ticks = 0;
    let offTick = -1;
    await new Promise<void>((resolve) => {
      const off = loop.onBeforeStep((_t, s) => {
        ticks++;
        if (offTick < 0 && s.pos.x > x0 + 1 + 0.3) offTick = ticks;
        trace.push(`${(s.pos.x - x0).toFixed(3)},${(s.pos.y - FEET_Y).toFixed(3)}${s.onGround ? 'g' : ''}${s.poseHeight !== undefined ? `h${s.poseHeight.toFixed(2)}` : ''}`);
        loop.setCommand({ yaw, pitch: 0, forward: 1, strafe: 0, sprint: false, jump: false, sneak });
        if (ticks >= 40) {
          off();
          loop.release();
          resolve();
        }
      });
    });
    await loop.waitTicks(10);
    offEv();
    const server = (await b.truth.pos(b.name)).location;
    const end = loop.state.pos;
    const row = {
      case: `probe-${eave}`,
      sneak,
      run: k,
      pose0,
      corrections: loop.state.corrections - c0,
      off: offTick,
      end: `${(end.x - x0).toFixed(3)},${(end.y - FEET_Y).toFixed(3)}`,
      server: `${(server.x - x0).toFixed(3)},${(server.y - FEET_Y).toFixed(3)}`,
      flags: [...new Set(flags)].join(' | '),
      fixes: fixes.join(' '),
      trace: trace.join(' '),
    };
    note(row);
    return row;
  }

  /** A walk: from `at` (teleported; `over`: set there with no wait for the server's answer) to `goal`; the row. */
  async function walkRun(kase: string, k: number, at: Vec3, goal: Vec3, opts: { beside?: boolean; over?: boolean }, x0: number, z0: number): Promise<Record<string, unknown> & { ok: boolean; died: boolean; damage: number; plans: number; note?: string }> {
    const b = bot!;
    const nav = b.built.mobility!.skills.nav;
    if (opts.over) {
      await b.truth.tp(b.name, at, 0, 0);
      const t1 = Date.now();
      while (Date.now() - t1 < 5000 && Math.hypot((b.task.position()?.x ?? 0) - at.x, (b.task.position()?.z ?? 0) - at.z) > 0.05) await sleep(20);
    } else await teleport(b, at);
    const startPos = b.task.position()!;
    const loop = b.built.mobility!.loop;
    const startOnGround = loop.state.onGround;
    const c0 = loop.state.corrections;
    const deaths0 = b.built.respawn!.deaths;
    const since = await b.truth.now();
    const t0 = Date.now();
    const r = await b.pve.walk({ type: 'block', p: goal }, { explain: true, ...(opts.beside ? { beside: true } : {}) }, 'r7 walk');
    const s = (Date.now() - t0) / 1000;
    await sleep(500);
    const dmg = botDamage((await b.truth.hurtlog(since, b.name)).events, b.name);
    const rep = nav.lastReport;
    const end = b.task.position()!;
    const row = {
      case: kase,
      run: k,
      start: `${(startPos.x - x0).toFixed(3)},${(startPos.y - FEET_Y).toFixed(3)},${(startPos.z - z0).toFixed(3)}`,
      startOnGround,
      ok: r.ok,
      ...(r.note ? { note: r.note } : {}),
      ...(r.ok ? {} : { reason: r.reason }),
      s: +s.toFixed(1),
      ticks: rep?.ticks ?? 0,
      plans: rep?.plans.length ?? 0,
      failures: rep?.failures ?? 0,
      perch: rep?.perchStarts ?? 0,
      low: rep?.lowStarts ?? 0,
      settle: rep?.settleTicks ?? 0,
      corrections: loop.state.corrections - c0,
      ...(rep?.perchGoal ? { perchGoal: `${rep.perchGoal.end} ${rep.perchGoal.dist ?? ''}` } : {}),
      ...(rep?.beside ? { beside: `${rep.beside.kind} ${rep.beside.dist ?? ''}` } : {}),
      end: `${(end.x - x0).toFixed(2)},${(end.y - FEET_Y).toFixed(3)},${(end.z - z0).toFixed(2)}`,
      fromGoal: +Math.hypot(end.x - (goal.x + 0.5), end.y - goal.y, end.z - (goal.z + 0.5)).toFixed(2),
      fall: dmg.byCause.fall ?? 0,
      damage: dmg.total,
      died: b.built.respawn!.deaths !== deaths0,
    };
    note(row);
    return row;
  }

  const SPOTS: Record<string, [number, number]> = { centre: [0.5, 0.5], along: [0.5, 0.78], across: [0.62, 0.36] };

  for (const kase of STARTS) {
    it.skipIf(!CASES.includes(kase))(`${kase}: ${RUNS} runs`, async () => {
      const b = bot!;
      const nav = b.built.mobility!.skills.nav;
      const parts = kase.split('-');
      const eave = (kase === 'start-before' || kase === 'start-over' ? 'one' : parts[1]) as Eave;
      const [fx, fz] = SPOTS[parts[2] ?? 'centre']!;
      for (let k = 0; k < RUNS; k++) {
        nav.lowPerch = kase !== 'start-before';
        nav.settleTicks = SETTLE_TICKS;
        const { x0, z0, top } = await site(b, eave);
        const j = RUNS > 1 ? -0.04 + (0.08 * k) / (RUNS - 1) : 0;
        const over = kase === 'start-over';
        const r = await walkRun(kase, k, { x: x0 + fx + j, y: top + (over ? 0.5 : 0), z: z0 + fz - j / 2 }, { x: x0 + 15, y: FEET_Y, z: z0 }, { over }, x0, z0);
        expect(r.died).toBe(false);
        if (kase === 'start-before') {
          expect(r.ok).toBe(false);
          expect(r.plans).toBe(0);
          continue;
        }
        expect(r.ok, String(r.note ?? r.reason)).toBe(true);
        expect(r.damage).toBe(0);
      }
      nav.lowPerch = true;
    }, RUNS * 120_000);
  }

  for (const kase of GOALS) {
    it.skipIf(!CASES.includes(kase))(`${kase}: ${RUNS} runs`, async () => {
      const b = bot!;
      const nav = b.built.mobility!.skills.nav;
      const eave = (kase === 'goal-stairb' ? 'stairb' : 'one') as Eave;
      for (let k = 0; k < RUNS; k++) {
        nav.lowPerch = kase !== 'goal-before';
        const { x0, z0 } = await site(b, eave);
        const j = RUNS > 1 ? -0.08 + (0.16 * k) / (RUNS - 1) : 0;
        const r = await walkRun(kase, k, { x: x0 + 15.5, y: FEET_Y, z: z0 + 0.5 + j }, { x: x0, y: FEET_Y + 1, z: z0 }, {}, x0, z0);
        expect(r.died).toBe(false);
        expect(r.damage).toBe(0);
        if (kase === 'goal-before') {
          expect(r.ok).toBe(false);
          continue;
        }
        expect(r.ok, String(r.note ?? r.reason)).toBe(true);
        expect(r.note ?? '').toMatch(/cannot be stood on \(under 1\.8 of head room/);
      }
      nav.lowPerch = true;
    }, RUNS * 120_000);
  }

  for (const kase of KINDS) {
    it.skipIf(!CASES.includes(kase))(`${kase}: ${RUNS} runs`, async () => {
      const b = bot!;
      const before = kase.endsWith('-before');
      const kind = kase.replace(/-before$/, '');
      for (let k = 0; k < RUNS; k++) {
        const i = next++;
        const x0 = area.x + 40 * (i % 6) - 100;
        const z0 = area.z + 40 * Math.floor(i / 6) - 100;
        await teleport(b, centre({ x: x0 + 15, y: FEET_Y, z: z0 }));
        await fill(b, { x: x0 - 8, y: FEET_Y - 1, z: z0 - 8 }, { x: x0 + 28, y: FEET_Y - 1, z: z0 + 8 }, 'grass_block');
        await fill(b, { x: x0 - 8, y: FEET_Y, z: z0 - 8 }, { x: x0 + 28, y: FEET_Y + 8, z: z0 + 8 }, 'air');
        let goal: Vec3 = { x: x0, y: FEET_Y, z: z0 };
        if (kind === 'kind-planks') await fill(b, goal, goal, 'oak_planks');
        else if (kind === 'kind-headroom') await fill(b, { x: x0, y: FEET_Y + 1, z: z0 }, { x: x0, y: FEET_Y + 1, z: z0 }, 'oak_planks');
        else goal = { x: x0, y: FEET_Y + 2, z: z0 };
        await sleep(300);
        await b.truth.clearAround({ x: x0, y: FEET_Y, z: z0 }, 48);
        await b.truth.setHealth(b.name, 20);
        const j = RUNS > 1 ? -0.08 + (0.16 * k) / (RUNS - 1) : 0;
        const r = await walkRun(kase, k, { x: x0 + 15.5, y: FEET_Y, z: z0 + 0.5 + j }, goal, { beside: !before }, x0, z0);
        expect(r.died).toBe(false);
        expect(r.damage).toBe(0);
        if (before) {
          expect(r.ok).toBe(false);
          continue;
        }
        expect(r.ok, String(r.note ?? r.reason)).toBe(true);
        expect(r.note ?? '').toMatch(/cannot be stood on/);
      }
    }, RUNS * 120_000);
  }

  for (const kind of PROBES) {
    it.skipIf(!CASES.includes(kind))(`${kind}: ${RUNS} runs a key`, async () => {
      const eave = kind.slice('probe-'.length) as Eave;
      for (let k = 0; k < RUNS; k++) {
        await probe(eave, false, k);
        await probe(eave, true, k);
      }
      expect(true).toBe(true);
    }, RUNS * 120_000);
  }
});
