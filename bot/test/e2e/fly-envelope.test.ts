// e2e (tag @bds), Track F0 (docs/flight-envelope.md): what bds-fly does for the flight-v2 manoeuvres,
// flown by scripts (fly-envelope-harness.ts) and compared tick by tick with the model stepped from the
// server's state. FLY_ENV=<case,case> picks cases (default: smoke, the quick check; all: the whole envelope, about 90 min); FLY_ENV_N scales the repetitions;
// FLY_ENV_OUT=<dir> keeps every run's JSON (default: the OS temp dir's fly-envelope folder).
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import type { BlockQuery } from '../../src/skills/input/index.ts';
import { align, boostRuns, compareRun, presim, runScript, summarize, type Ctl, type RunOptions, type RunRec, type Script, type ScriptCtx, type TickCompare } from './fly-envelope-harness.ts';
import { burns, hOf, serverByTick, hoverMetrics, r, stats, tracks, turnMetrics, type Pt } from './fly-envelope-metrics.ts';
import { fallThenGlide, glideWanted, segments, withPrelude } from './fly-envelope-scripts.ts';
import { flatWorld, glideVelocity, GLIDE_START_FLAGS } from '../../src/skills/input/index.ts';
import { E2E, FEET_Y, prepareServer, privateArea, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const CASES = (process.env.FLY_ENV ?? 'smoke').split(',').map((s) => s.trim());
const want = (n: string): boolean => CASES.includes('all') || CASES.includes(n);
const N = Number(process.env.FLY_ENV_N ?? 1);
const OUT = process.env.FLY_ENV_OUT ?? join(tmpdir(), 'fly-envelope');

describe.skipIf(!E2E)('@bds fly envelope (Track F0)', () => {
  // near the origin: float32 positions keep 6e-5 there (60 000 out they step by 0.0078, so do the server's samples)
  const area = process.env.FLY_AREA ? privateArea() : { x: 400, z: 400, cell: -1 };
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const ground: Vec3 = { x: area.x + 0.5, y: FEET_Y, z: area.z + 0.5 };
  const air = (dx = 0, dz = 0, y = 120): Vec3 => ({ x: area.x + 0.5 + dx, y, z: area.z + 0.5 + dz });

  const save = (name: string, data: unknown): void => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)));
  };
  const fly = async (name: string, o: RunOptions): Promise<{ run: RunRec; cmp: TickCompare[] }> => {
    const run = await runScript(bot!, name, o);
    const cmp = compareRun(run, bot!.built.mobility!.loop.world);
    save(name, { run, cmp });
    return { run, cmp };
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Env');
    bot.settings.set('autoFly', false);
    await teleport(bot, ground);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    console.log(`[fly-envelope e2e] area cell ${area.cell} (${area.x}, ${area.z}); out ${OUT}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it.skipIf(!want('smoke'))('smoke: a level glide with one rocket matches the model within 0.002 a tick', async () => {
    for (let k = 0; k < N; k++) {
      const { run, cmp } = await fly(`smoke-${k}`, { start: air(), script: withPrelude('level', 0, segments({ n: 40, ctl: { yaw: 0, pitch: 0 } }), { coast: 20 }) });
      const s = summarize(run, cmp);
      const sm = summarize(run, cmp, 'm');
      notes.push(`smoke ${k}: ${JSON.stringify(s)}; measured ${sm.compared} ticks, max err ${sm.maxErr.toFixed(5)}`);
      // 40 measured inputs; when the input timer drifts against the server tick up to 2 in 3 share a server
      // tick with a neighbour (no sample; the comparison needs the one before too): the check is the error
      expect(sm.compared).toBeGreaterThanOrEqual(8);
      expect(sm.maxErr).toBeLessThan(0.002);
    }
  }, 300_000);

  const world = (): BlockQuery => bot!.built.mobility!.loop.world;
  const handover = (run: RunRec): number => run.ticks.find((t) => t.ctl.mark === 'm')!.tick;
  /** The latest input at or before `tick` that has a server sample (a sample may be missing: two inputs in one server tick). */
  const sampled = (run: RunRec, tick: number): number => {
    const at = serverByTick(run);
    for (let t = tick; t > tick - 5; t--) if (at.has(t) && at.has(t - 1)) return t;
    return tick;
  };
  const row = (kind: string, o: Record<string, unknown>): Record<string, unknown> => {
    const line = { kind, ...o };
    notes.push(JSON.stringify(line));
    return line;
  };
  const mCor = (run: RunRec, cmp: TickCompare[]) => {
    const s = summarize(run, cmp, 'm');
    return { cors: s.corrections, maxCor: r(s.maxCorrection, 3), maxErr: r(s.maxErr, 4), over001: s.over001, compared: s.compared, dmg: s.damage, causes: s.causes.join(','), glideEnded: s.glideEnded };
  };

  // 1. one-tick yaw snaps while gliding, and the 180 brake at three pitches
  it.skipIf(!want('snap'))('1. one-tick yaw snaps (45 / 90 / 135 / 180) and the 180 brake at pitch -30 / -15 / 0: server vs model, corrections', async () => {
    const rows: Record<string, unknown>[] = [];
    const variants = [
      { d: 45, p: 0 },
      { d: 90, p: 0 },
      { d: 135, p: 0 },
      { d: 180, p: 0 },
      { d: 180, p: -15 },
      { d: 180, p: -30 },
    ];
    const reps = Math.max(1, 3 * N);
    for (const v of variants) {
      for (let k = 0; k < reps; k++) {
        const name = `snap-${v.d}-p${-v.p}-${k}`;
        const { run, cmp } = await fly(name, { start: air(0, 0, 140), script: withPrelude('level', 0, segments({ n: 5, ctl: { yaw: 0, pitch: v.p } }, { n: 45, ctl: { yaw: v.d, pitch: v.p } }), { coast: 20 }) });
        const t0 = sampled(run, handover(run) + 4);
        const tr = tracks(run, world(), t0);
        rows.push(row('snap', { name, d: v.d, p: v.p, ...mCor(run, cmp), server: turnMetrics(tr.server, t0, 0), model: turnMetrics(tr.model, t0, 0) }));
      }
    }
    save('case-snap', rows);
    expect(rows.length).toBe(variants.length * reps);
  }, 3_600_000);

  // 2. hover / station keeping: the look flipped 180 degrees every 1, 2, 5 ticks
  it.skipIf(!want('hover'))('2. hover: the look flipped 180 every 1 / 2 / 5 ticks for 240 ticks at pitch 0 and -15: sink, drift, corrections', async () => {
    const rows: Record<string, unknown>[] = [];
    const reps = Math.max(1, 2 * N);
    for (const p of [0, -15]) {
      for (const every of [1, 2, 5]) {
        for (let k = 0; k < reps; k++) {
          const name = `hover-e${every}-p${-p}-${k}`;
          const { run, cmp } = await fly(name, { start: air(0, 0, 150), maxTicks: 400, script: withPrelude('stopped', 0, segments({ n: 240, ctl: (i) => ({ yaw: (Math.floor(i / every) % 2) * 180, pitch: p }) })) });
          const t0 = sampled(run, handover(run));
          const tr = tracks(run, world(), t0);
          const w0 = t0 + 40;
          const w1 = t0 + 239;
          rows.push(row('hover', { name, every, p, ...mCor(run, cmp), server: hoverMetrics(tr.server, w0, w1), model: hoverMetrics(tr.model, w0, w1) }));
        }
      }
    }
    save('case-hover', rows);
    expect(rows.length).toBe(6 * reps);
  }, 3_600_000);

  /** Fire, wait for the rocket's removal and `gap` ticks more, fire again; `rockets` times. */
  const rocketTrain = (rockets: number, o: { pitch?: number; gap?: number; extra?: (n: number, sinceFire: number) => Ctl | undefined } = {}) => {
    return (c: ScriptCtx): Ctl | undefined => {
      const m = c.mem;
      const fired = (m.fires as number | undefined) ?? 0;
      const since = c.i - ((m.lastFire as number | undefined) ?? -999);
      const extra = o.extra?.(fired, since);
      if (extra) return extra;
      const idle = { yaw: 0, pitch: o.pitch ?? 0 };
      if (fired > 0 && (c.rocketsAlive > 0 || since < 4)) {
        if (since > 80) throw new Error('the rocket never went');
        return idle;
      }
      if (fired > 0 && (c.sinceRocketGone ?? 0) < (o.gap ?? 14)) return idle;
      if (fired >= rockets) return undefined;
      m.fires = fired + 1;
      m.lastFire = c.i;
      return { ...idle, fire: true };
    };
  };

  // 3. the rocket's burn: its length, and how add_entity / remove_entity relate to the boosted ticks
  it.skipIf(!want('burn'))('3. the rocket burn length (n >= 50) and the remove_entity timing', async () => {
    const all: ReturnType<typeof burns> = [];
    const meta: unknown[] = [];
    const runs = Math.max(1, 6 * N);
    for (let k = 0; k < runs; k++) {
      const name = `burn-${k}`;
      const { run, cmp } = await fly(name, { start: air(0, 0, 130), maxTicks: 600, script: withPrelude('level', 0, rocketTrain(10), { coast: 16 }) });
      const b = burns(run, world());
      all.push(...b);
      meta.push(...run.rockets.map((x) => ({ fired: x.firedAt, added: x.addedAt, removed: x.removedAt, burn: b.find((y) => y.fire === x.firedAt)?.ticks, metadata: x.metadata, add: x.add })));
      row('burn', { name, ...mCor(run, cmp), burns: b.map((x) => x.ticks), removedAfterLast: b.map((x) => (x.removed !== undefined && x.to !== undefined ? x.removed - x.to : undefined)) });
    }
    const ok = all.filter((x) => x.ticks !== undefined && x.exact);
    row('burn-stats', {
      burn: stats(ok.map((x) => x.ticks!)),
      inferredAgrees: ok.filter((x) => x.inferred !== undefined).map((x) => x.inferred === x.ticks).reduce((a, y) => a + (y ? 1 : 0), 0) + ' of ' + ok.filter((x) => x.inferred !== undefined).length,
      addedAfterFire: stats(all.filter((x) => x.added !== undefined).map((x) => x.added! - x.fire)),
      removedAfterLastBoost: stats(ok.filter((x) => x.removed !== undefined).map((x) => x.removed! - x.to!)),
      inexact: all.filter((x) => x.ticks !== undefined && !x.exact).length,
      unmatched: all.filter((x) => x.ticks === undefined).length,
    });
    save('case-burn', { burns: all, meta });
    expect(ok.length).toBeGreaterThanOrEqual(Math.min(50, 8 * runs));
  }, 3_600_000);

  // 4. a second rocket while the first burns
  it.skipIf(!want('stack'))('4. a second rocket used while one burns: extend, double or refresh?', async () => {
    const rows: Record<string, unknown>[] = [];
    const reps = Math.max(1, 3 * N);
    for (const after of [3, 6, 10]) {
      for (let k = 0; k < reps; k++) {
        const name = `stack-${after}-${k}`;
        const script = withPrelude('level', 0, (c) => {
          if (c.i === 0) return { yaw: 0, pitch: 0, fire: true };
          if (c.i === after) return { yaw: 0, pitch: 0, fire: true };
          if (c.i > after && c.rocketsAlive === 0 && (c.sinceRocketGone ?? 0) >= 14) return undefined;
          if (c.i > 120) return undefined;
          return { yaw: 0, pitch: 0 };
        }, { coast: 16 });
        const { run, cmp } = await fly(name, { start: air(0, 0, 130), script });
        const t0 = handover(run);
        const boosted = cmp.filter((c) => c.boosted && c.tick >= t0 - 1);
        const overlap = cmp.filter((c) => c.tick >= t0 + after && c.tick <= t0 + after + 6);
        rows.push(row('stack', { name, after, ...mCor(run, cmp), rockets: run.rockets.map((x) => [x.firedAt === undefined ? undefined : x.firedAt - t0, x.addedAt - t0, x.removedAt === undefined ? undefined : x.removedAt - t0]), boostRuns: boostRuns(cmp).map((b) => [b.from - t0, b.to - t0, b.gap]), boostedTicks: boosted.length, overlapErr: overlap.map((c) => r(c.err, 4)), overlapOther: overlap.map((c) => r(c.errOther, 3)) }));
      }
    }
    save('case-stack', rows);
    expect(rows.length).toBe(3 * reps);
  }, 3_600_000);

  // 5. the owner's trick: switch the hotbar slot mid-rocket; rockets from the offhand
  it.skipIf(!want('slot'))('5. a hotbar slot switch mid-rocket, and rockets in the offhand', async () => {
    const rows: Record<string, unknown>[] = [];
    const reps = Math.max(1, 3 * N);
    const b = bot!;
    for (const k of [1, 3, 6]) {
      for (let j = 0; j < reps; j++) {
        const name = `slot-${k}-${j}`;
        await b.truth.setslot(b.name, 1, 'stone', 16);
        const script = withPrelude('level', 0, (c) => {
          if (c.i === 0) return { yaw: 0, pitch: 0, fire: true };
          if (c.i === k) return { yaw: 0, pitch: 0, select: 1 };
          if (c.i > k && c.rocketsAlive === 0 && (c.sinceRocketGone ?? 0) >= 14) return undefined;
          if (c.i > 120) return undefined;
          return { yaw: 0, pitch: 0 };
        }, { coast: 16 });
        const { run, cmp } = await fly(name, { start: air(0, 0, 130), script });
        const t0 = handover(run);
        rows.push(row('slot', { name, k, ...mCor(run, cmp), rockets: run.rockets.map((x) => [x.addedAt - t0, x.removedAt === undefined ? undefined : x.removedAt - t0]), burns: burns(run, world()).map((x) => [x.ticks, x.exact, x.maxFw]) }));
        b.task.pve!.hotbar.select(0);
      }
    }
    for (const how of ['offhand', 'offhand-main'] as const) {
      for (let j = 0; j < reps; j++) {
        const name = `offhand-${how}-${j}`;
        await b.truth.ok('clear', [b.name]);
        await b.truth.equip(b.name, 'Offhand', 'firework_rocket', 64);
        b.task.pve!.hotbar.select(2);
        const script = withPrelude('dive', 0, (c) => {
          if (c.i === 0) return { yaw: 0, pitch: 0, fire: how };
          if (c.i > 4 && c.rocketsAlive === 0 && ((c.sinceRocketGone ?? 0) >= 14 || c.i > 40)) return undefined;
          if (c.i > 100) return undefined;
          return { yaw: 0, pitch: 0 };
        }, { speed: 0.8, divePitch: 25 });
        const { run, cmp } = await fly(name, { start: air(0, 0, 130), rockets: 0, script });
        const inv = await b.truth.getinv(b.name).catch(() => undefined);
        rows.push(row('offhand', { name, how, ...mCor(run, cmp), rockets: run.rockets.length, burns: burns(run, world()).map((x) => [x.ticks, x.exact, x.maxFw]), offhandAfter: (await b.truth.ok<{ equipment: Record<string, { typeId: string; amount?: number } | null> }>('durability', [b.name]).catch(() => undefined))?.equipment?.Offhand ?? null, counts: inv?.counts }));
      }
    }
    await b.truth.equip(b.name, 'Offhand', 'air');
    b.task.pve!.hotbar.select(0);
    save('case-slot', rows);
    expect(rows.length).toBe(5 * reps);
  }, 3_600_000);

  // 6. rockets looking straight up / down / back; the glide started at pitch -90 / +90
  it.skipIf(!want('vertical'))('6. rockets straight up, straight down and backwards; the glide started at pitch -90 / +90', async () => {
    const rows: Record<string, unknown>[] = [];
    const reps = Math.max(1, 2 * N);
    const cases: { name: string; script: Script; start?: number }[] = [
      { name: 'upstart', script: withPrelude('stopped', 0, segments({ n: 1, ctl: { yaw: 0, pitch: -90, fire: true } }, { n: 40, ctl: { yaw: 0, pitch: -90 } }), { prePitch: -90 }), start: 100 },
      { name: 'upstart89', script: withPrelude('stopped', 0, segments({ n: 1, ctl: { yaw: 0, pitch: -89, fire: true } }, { n: 40, ctl: { yaw: 0, pitch: -89 } }), { prePitch: -89 }), start: 100 },
      { name: 'downstart', script: withPrelude('stopped', 0, segments({ n: 30, ctl: { yaw: 0, pitch: 90 } }), { prePitch: 90 }), start: 200 },
      { name: 'uplevel', script: withPrelude('level', 0, segments({ n: 1, ctl: { yaw: 0, pitch: -90, fire: true } }, { n: 40, ctl: { yaw: 0, pitch: -90 } }), { coast: 20 }), start: 100 },
      { name: 'downlevel', script: withPrelude('level', 0, segments({ n: 1, ctl: { yaw: 0, pitch: 90, fire: true } }, { n: 22, ctl: { yaw: 0, pitch: 90 } }), { coast: 20 }), start: 220 },
      { name: 'back', script: withPrelude('level', 0, segments({ n: 1, ctl: { yaw: 180, pitch: 0, fire: true } }, { n: 30, ctl: { yaw: 180, pitch: 0 } }), { coast: 20 }), start: 140 },
    ];
    for (const c of cases) {
      for (let k = 0; k < reps; k++) {
        const name = `vert-${c.name}-${k}`;
        const { run, cmp } = await fly(name, { start: air(0, 0, c.start ?? 120), script: c.script });
        const t0 = sampled(run, handover(run) - 1);
        const tr = tracks(run, world(), t0, { burns: new Map(burns(run, world()).filter((x) => x.ticks).map((x) => [x.fire, x.ticks!])) });
        const last = (t: Pt[]) => t.at(-1);
        const sum = (t: Pt[]) => {
          const a = t[0];
          const z = last(t);
          if (!a || !z) return {};
          return { dy: r(z.pos.y - a.pos.y), dh: r(Math.hypot(z.pos.x - a.pos.x, z.pos.z - a.pos.z)), dz: r(z.pos.z - a.pos.z), vEnd: [r(z.vel.x, 3), r(z.vel.y, 3), r(z.vel.z, 3)], maxUp: r(Math.max(...t.map((p) => p.pos.y)) - a.pos.y), minH: r(Math.min(...t.slice(1).map((p) => hOf(p.vel))), 3), ticks: z.tick - a.tick };
        };
        rows.push(row('vertical', { name, ...mCor(run, cmp), glides: run.glides.map((g) => [g.at - t0, g.gliding]), burns: burns(run, world()).map((x) => [x.ticks, x.exact, x.maxFw]), server: sum(tr.server), model: sum(tr.model) }));
      }
    }
    // the vertical takeoff from the ground (brain.ts verticalTakeoff): jump, the glide request on the first falling tick looking straight up, a rocket once confirmed
    for (let k = 0; k < reps; k++) {
      const name = `vert-groundup-${k}`;
      const script: Script = (c) => {
        const m = c.mem;
        if (c.i < 2) return { yaw: 0, pitch: -90, glide: false };
        if (c.i === 2) return { yaw: 0, pitch: -90, glide: false, jump: true, mark: 'm' };
        const glide = m.asked === true || c.st.vel.y < 0;
        if (glide) m.asked = true;
        if (c.glideConfirmed && !m.fired) {
          m.fired = true;
          return { yaw: 0, pitch: -90, fire: true, mark: 'm' };
        }
        if (c.i > 60) return undefined;
        return { yaw: 0, pitch: -90, glide, mark: 'm' };
      };
      const { run, cmp } = await fly(name, { start: ground, script });
      const t0 = sampled(run, handover(run));
      const tr = tracks(run, world(), t0);
      const confirmed = run.glides.find((g) => g.gliding);
      const top = (t: Pt[]) => r(Math.max(...t.map((p) => p.pos.y)) - FEET_Y);
      const drift = (t: Pt[]) => r(Math.max(...t.map((p) => Math.hypot(p.pos.x - ground.x, p.pos.z - ground.z))));
      rows.push(row('vertical', { name, ...mCor(run, cmp), jumpAt: t0, confirmedAfterJump: confirmed ? confirmed.at - handover(run) : undefined, burns: burns(run, world()).map((x) => [x.ticks, x.exact, x.maxFw]), server: { top: top(tr.server), drift: drift(tr.server) }, model: { top: top(tr.model), drift: drift(tr.model) } }));
    }
    save('case-vertical', rows);
    expect(rows.length).toBe((cases.length + 1) * reps);
  }, 3_600_000);

  /** Build with truth:fill after teleporting next to it (the chunk must be loaded), then back to `park`. */
  const build = async (park: Vec3, near: Vec3, fills: [Vec3, Vec3, string][], sets: [Vec3, string, string[]][] = []): Promise<void> => {
    const b = bot!;
    await teleport(b, near);
    for (const [p, q, block] of fills) await truthLoaded(b.truth, 'fill', [p.x, p.y, p.z, q.x, q.y, q.z, block]);
    for (const [p, block, states] of sets) await truthLoaded(b.truth, 'setblock', [p.x, p.y, p.z, block, ...states]);
    await teleport(b, park);
    await b.built.mobility!.world.waitForChunks(4, { center: near, timeoutMs: 20_000 }).catch(() => undefined);
  };
  /** The first matched input whose server sample shows the body's front within `eps` of the face `faceZ` (moving +z). */
  const contactTick = (run: RunRec, faceZ: number, eps = 0.01): number | undefined => {
    for (const a of align(run)) if (a.s.z + 0.3 >= faceZ - eps) return a.tick;
    return undefined;
  };
  /** The model's intended velocity for input `tick` from the server's state at `tick - 1` (before the collision clips it). */
  const intended = (run: RunRec, tick: number): Vec3 | undefined => {
    const at = serverByTick(run);
    const a = at.get(tick - 1);
    const p = at.get(tick - 2);
    const t = run.ticks.find((x) => x.tick === tick);
    if (!a || !p || !t) return undefined;
    return glideVelocity({ x: a.x - p.x, y: a.y - p.y, z: a.z - p.z }, t.yaw, t.ctl.pitch, false);
  };
  const glideAfter = (run: RunRec, tick: number, n = 10): { gliding: number; samples: number; ground: number } => {
    const at = serverByTick(run);
    let gliding = 0;
    let samples = 0;
    let groundN = 0;
    for (let t = tick; t < tick + n; t++) {
      const s = at.get(t);
      if (!s) continue;
      samples++;
      if (s.gliding) gliding++;
      if (s.ground) groundN++;
    }
    return { gliding, samples, ground: groundN };
  };

  // 7. wall impact damage (head-on and glancing), ceiling bumps
  it.skipIf(!want('wall'))('7. wall impacts at 0.1 to 1.5 blocks a tick, head-on and glancing; the threshold and the formula; ceiling bumps', async () => {
    const rows: Record<string, unknown>[] = [];
    const WX = area.x + 120;
    const WZ = area.z + 60;
    const park: Vec3 = { x: WX + 0.5, y: FEET_Y, z: WZ - 40.5 };
    const top = FEET_Y + 75;
    await build(park, { x: WX + 0.5, y: FEET_Y, z: WZ - 3.5 }, [[{ x: WX - 30, y: FEET_Y - 1, z: WZ }, { x: WX + 30, y: top, z: WZ }, 'stone']]);
    const flat = flatWorld();
    const reps = Math.max(1, N);
    const shots: { h: number; yaw: number }[] = [
      ...[0.1, 0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5].map((h) => ({ h, yaw: 0 })),
      ...[0.6, 1.0, 1.5].map((h) => ({ h, yaw: 45 })),
      ...[1.0, 1.5].map((h) => ({ h, yaw: 70 })),
    ];
    for (const shot of shots) {
      for (let k = 0; k < reps; k++) {
        const pitch = shot.h < 0.5 ? 0 : shot.h < 1.1 ? 15 : 30;
        const startY = FEET_Y + 60;
        // the free glide from a standstill at the origin of the presim; contact on the tick after the speed is reached
        const probe = fallThenGlide(400, { yaw: shot.yaw, pitch });
        const sim = presim(probe, { x: 0.5, y: startY, z: 0.5 }, flat, { maxTicks: 400 });
        const n = sim.findIndex((p) => p.state.gliding && hOf(p.state.vel) >= shot.h);
        if (n < 0) throw new Error(`no presim speed ${shot.h}`);
        const sn = sim[n]!.state;
        const startZ = WZ - 0.3 - (sn.pos.z - 0.5) - 0.4 * sn.vel.z;
        const startX = WX + 0.5 - (sn.pos.x - 0.5);
        const name = `wall-${shot.yaw}-${shot.h}-${k}`;
        const { run, cmp } = await fly(name, { start: { x: startX, y: startY, z: startZ }, park, script: fallThenGlide(n - sim.findIndex((p) => p.state.gliding) + 25, { yaw: shot.yaw, pitch }) });
        const t = contactTick(run, WZ);
        const v = t !== undefined ? intended(run, t) : undefined;
        const hBefore = v ? hOf(v) : undefined;
        const hAfter = v ? Math.abs(v.x) : undefined; // the z axis clipped
        const dmg = run.hurt.filter((h) => h.cause !== 'fall');
        rows.push(row('wall', { name, yaw: shot.yaw, target: shot.h, pitch, contact: t, hBefore: r(hBefore, 3), normal: r(v ? v.z : undefined, 3), loss: r(hBefore !== undefined && hAfter !== undefined ? hBefore - hAfter : undefined, 3), damage: dmg.reduce((a, h) => a + h.damage, 0), hurt: run.hurt.map((h) => `${h.cause}:${h.damage}`).join(','), after: t !== undefined ? glideAfter(run, t + 1) : undefined, ...mCor(run, cmp) }));
      }
    }
    // ceiling bumps: a stone ceiling over the start; a rocket at pitch -40, a rocket straight up, a pull-up without a rocket
    const CX = area.x + 240;
    const CZ = area.z;
    const cy = FEET_Y + 40;
    await build({ x: CX + 0.5, y: FEET_Y, z: CZ - 20.5 }, { x: CX + 0.5, y: FEET_Y, z: CZ + 0.5 }, [[{ x: CX - 12, y: cy, z: CZ - 12 }, { x: CX + 12, y: cy, z: CZ + 60 }, 'stone']]);
    const ceilings: { name: string; startY: number; script: Script }[] = [
      { name: 'ceil-rocket40', startY: cy - 4, script: withPrelude('stopped', 0, segments({ n: 1, ctl: { yaw: 0, pitch: -40, fire: true } }, { n: 40, ctl: { yaw: 0, pitch: -40 } })) },
      { name: 'ceil-rocket90', startY: cy - 8, script: withPrelude('stopped', 0, segments({ n: 1, ctl: { yaw: 0, pitch: -90, fire: true } }, { n: 28, ctl: { yaw: 0, pitch: -90 } }, { n: 60, ctl: { yaw: 0, pitch: 0 } }), { prePitch: -90 }) }, // level after the boost: at -90 the fall is free (no lift) and kills from 40 up
      { name: 'ceil-pullup', startY: cy - 2.5, script: withPrelude('dive', 0, segments({ n: 30, ctl: { yaw: 0, pitch: -50 } }), { speed: 1.2, divePitch: 10 }) },
    ];
    for (const c of ceilings) {
      for (let k = 0; k < reps; k++) {
        const name = `${c.name}-${k}`;
        const { run, cmp } = await fly(name, { start: { x: CX + 0.5, y: c.startY, z: CZ + 0.5 }, park: { x: CX + 0.5, y: FEET_Y, z: CZ - 20.5 }, script: c.script });
        const at = align(run);
        const bump = at.find((a) => a.s.y + 0.6 >= cy - 0.01);
        rows.push(row('ceiling', { name, bump: bump?.tick, maxTop: r(Math.max(...at.map((a) => a.s.y + 0.6)) - cy, 3), damage: run.hurt.reduce((a, h) => a + h.damage, 0), hurt: run.hurt.map((h) => `${h.cause}:${h.damage}`).join(','), after: bump ? glideAfter(run, bump.tick + 1) : undefined, ...mCor(run, cmp) }));
      }
    }
    save('case-wall', rows);
    expect(rows.length).toBe((shots.length + ceilings.length) * reps);
  }, 3_600_000);

  // 8. touchdown: the vertical speed where fall damage starts while gliding; touch-and-go
  it.skipIf(!want('touch'))('8. touchdown fall damage by the vertical speed; touch-and-go and the sprint-jump takeoff', async () => {
    const rows: Record<string, unknown>[] = [];
    const TX = area.x + 360;
    const TZ = area.z;
    const park: Vec3 = { x: TX + 0.5, y: FEET_Y, z: TZ - 30.5 };
    await teleport(bot!, park);
    const reps = Math.max(1, N);
    const dives: { h: number; pitch: number }[] = [
      ...[3, 5, 8, 12, 16, 20, 25, 30, 40, 55].map((h) => ({ h, pitch: 80 })),
      ...[15, 30, 60].map((h) => ({ h, pitch: 45 })),
      ...[10, 30].map((h) => ({ h, pitch: 0 })),
    ];
    for (const d of dives) {
      for (let k = 0; k < reps; k++) {
        const name = `touch-p${d.pitch}-h${d.h}-${k}`;
        const { run, cmp } = await fly(name, { start: { x: TX + 0.5, y: FEET_Y + d.h, z: TZ + 0.5 }, park, maxTicks: 600, script: (c) => (c.mem.down !== undefined && c.i - (c.mem.down as number) > 15 ? undefined : (c.st.onGround && c.i > 3 && c.mem.down === undefined ? ((c.mem.down = c.i), { yaw: 0, pitch: d.pitch, glide: true, mark: 'm' }) : { yaw: 0, pitch: d.pitch, glide: glideWanted(c), mark: 'm' })) });
        const at = align(run);
        const g = at.findIndex((a) => a.s.ground);
        const last = g > 0 ? at[g - 1] : undefined;
        const prev = g > 1 ? at[g - 2] : undefined;
        const vy = last && prev && last.tick === prev.tick + 1 ? last.s.y - prev.s.y : last?.s.vy;
        const fallen = at.length ? at[0]!.s.y - FEET_Y : undefined;
        rows.push(row('touch', { name, pitch: d.pitch, height: d.h, vyLast: r(vy, 3), hLast: r(last && prev ? Math.hypot(last.s.x - prev.s.x, last.s.z - prev.s.z) : undefined, 3), fallen: r(fallen), damage: run.hurt.reduce((a, h) => a + h.damage, 0), hurt: run.hurt.map((h) => `${h.cause}:${h.damage}`).join(','), maxVyDown: r(Math.max(...at.slice(1, g > 0 ? g : undefined).map((a, i) => at[i]!.s.y - a.s.y)), 3), ...mCor(run, cmp) }));
      }
    }
    // touch-and-go: a low glide at pitch 0 to the ground, then the jump and the glide request again
    const variants = ['next', 'held', 'flag'] as const;
    for (const v of variants) {
      for (let k = 0; k < Math.max(2, 2 * N); k++) {
        const name = `tg-${v}-${k}`;
        const script: Script = (c) => {
          const m = c.mem;
          if (m.landed === undefined && c.st.onGround && c.i > 5) m.landed = c.i;
          if (m.landed === undefined) return { yaw: 0, pitch: 0, glide: glideWanted(c), jump: v === 'held' && c.glideConfirmed, mark: 'pre' };
          const j = c.i - (m.landed as number);
          if (j > 40) return undefined;
          return { yaw: 0, pitch: 0, glide: true, jump: true, ...(v === 'flag' && j === 0 ? { flags: ['start_gliding'] } : {}), mark: 'm' };
        };
        const { run, cmp } = await fly(name, { start: { x: TX + 0.5, y: FEET_Y + 6, z: TZ + 0.5 }, park, script });
        const at = align(run);
        const ground = at.find((a) => a.s.ground);
        const lifted = ground ? at.find((a) => a.tick > ground.tick && !a.s.ground) : undefined;
        const reglide = ground ? at.find((a) => a.tick > ground.tick && a.s.gliding) : undefined;
        const ev = run.glides.filter((g) => g.gliding).at(-1);
        rows.push(row('touchgo', { name, v, groundAt: ground?.tick, airborneAfter: lifted && ground ? lifted.tick - ground.tick : undefined, reglideAfter: reglide && ground ? reglide.tick - ground.tick : undefined, confirmEventAfter: ev && ground ? ev.at - ground.tick : undefined, groundSamples: ground ? at.filter((a) => a.s.ground && a.tick >= ground.tick).length : undefined, damage: run.hurt.reduce((a, h) => a + h.damage, 0), ...mCor(run, cmp) }));
      }
    }
    // the sprint-jump takeoff from standing
    for (let k = 0; k < Math.max(2, 2 * N); k++) {
      const name = `sprintjump-${k}`;
      const script: Script = (c) => {
        const m = c.mem;
        if (c.i < 4) return { yaw: 0, pitch: 0, glide: false };
        if (c.i < 16) return { yaw: 0, pitch: 0, glide: false, forward: 1, sprint: true, mark: 'pre' };
        if (c.i === 16) return { yaw: 0, pitch: 0, glide: false, forward: 1, sprint: true, jump: true, mark: 'm' };
        if (c.i > 60) return undefined;
        m.jumpTick ??= c.i;
        return { yaw: 0, pitch: -10, glide: true, forward: 1, sprint: true, mark: 'm' };
      };
      const { run, cmp } = await fly(name, { start: { x: TX + 4.5, y: FEET_Y, z: TZ + 0.5 }, park, script });
      const t0 = run.ticks.find((t) => t.ctl.jump)!.tick;
      const ev = run.glides.find((g) => g.gliding);
      const at = align(run);
      const reglide = at.find((a) => a.tick >= t0 && a.s.gliding);
      rows.push(row('sprintjump', { name, jumpTick: t0, glideSampleAfterJump: reglide ? reglide.tick - t0 : undefined, confirmEventAfterJump: ev ? ev.at - t0 : undefined, minY: r(Math.min(...at.filter((a) => a.tick > t0).map((a) => a.s.y)) - FEET_Y), ...mCor(run, cmp) }));
    }
    save('case-touch', rows);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);

  // 8b. when after a jump the server takes the glide request: the request on the first tick the body's
  // vertical speed is under `thr` (0.5: the first airborne tick, still rising), from a sprint-jump on
  // the ground and from a touch-and-go (a low glide meets the ground, the jump on contact)
  it.skipIf(!want('reglide'))('8b. the glide request after a jump: from what vertical speed the server takes it (sprint-jump and touch-and-go)', async () => {
    const rows: Record<string, unknown>[] = [];
    const TX = area.x + 360;
    const TZ = area.z + 60;
    const park: Vec3 = { x: TX + 0.5, y: FEET_Y, z: TZ - 30.5 };
    await teleport(bot!, park);
    const reps = Math.max(2, 2 * N);
    for (const from of ['sprint', 'touch'] as const) {
      for (const thr of [0.5, 0.3, 0.2, 0.05, 0, -0.1, -0.3]) {
        for (let k = 0; k < reps; k++) {
          const name = `reglide-${from}-${thr}-${k}`;
          const script: Script = (c) => {
            const m = c.mem;
            if (from === 'sprint') {
              if (c.i < 4) return { yaw: 0, pitch: 0, glide: false };
              if (c.i < 16) return { yaw: 0, pitch: 0, glide: false, forward: 1, sprint: true, mark: 'pre' };
              if (c.i === 16) {
                m.jump = c.i;
                return { yaw: 0, pitch: 0, glide: false, forward: 1, sprint: true, jump: true, mark: 'm' };
              }
            } else {
              if (m.landed === undefined && c.st.onGround && c.i > 5) m.landed = c.i;
              if (m.landed === undefined) return { yaw: 0, pitch: 0, glide: glideWanted(c), mark: 'pre' };
              if (m.jump === undefined) {
                m.jump = c.i;
                return { yaw: 0, pitch: 0, glide: false, jump: true, mark: 'm' };
              }
            }
            const j = c.i - (m.jump as number);
            if (j > 50) return undefined;
            if (m.req === undefined && !c.st.onGround && c.st.vel.y < thr) {
              m.req = c.i;
              m.reqVy = c.st.vel.y;
            }
            return { yaw: 0, pitch: 0, glide: m.req !== undefined, forward: from === 'sprint' ? 1 : 0, sprint: from === 'sprint', mark: 'm' };
          };
          const { run, cmp } = await fly(name, { start: from === 'sprint' ? { x: TX + 0.5 + k * 2, y: FEET_Y, z: TZ + 0.5 } : { x: TX + 0.5 + k * 2, y: FEET_Y + 6, z: TZ + 0.5 }, park, script });
          const at = align(run);
          const jt = run.ticks.find((t) => t.ctl.jump && t.ctl.mark === 'm')?.tick;
          const rq = run.ticks.find((t, i) => t.ctl.glide === true && t.ctl.mark === 'm' && i > 0 && run.ticks[i - 1]!.ctl.glide !== true && jt !== undefined && t.tick > jt)?.tick;
          const g = jt !== undefined ? at.find((a) => a.tick > jt && a.s.gliding) : undefined;
          const ev = jt !== undefined ? run.glides.find((e) => e.gliding && e.at > jt) : undefined;
          // the server's vertical speed entering the request tick (its own move of the tick before)
          const sv = serverByTick(run);
          const s1 = rq !== undefined ? sv.get(rq - 1) : undefined;
          const s0 = rq !== undefined ? sv.get(rq - 2) : undefined;
          rows.push(row('reglide', { name, from, thr, jump: jt, requestAfter: rq !== undefined && jt !== undefined ? rq - jt : undefined, vyAtRequest: s1 && s0 ? r(s1.y - s0.y, 3) : undefined, glideSampleAfter: g && jt !== undefined ? g.tick - jt : undefined, confirmAfter: ev && jt !== undefined ? ev.at - jt : undefined, glided: g !== undefined, refusedAt: run.glides.filter((e) => e.refused).map((e) => (jt !== undefined ? e.at - jt : e.at)), ...mCor(run, cmp) }));
        }
      }
    }
    save('case-reglide', rows);
    expect(rows.length).toBe(2 * 7 * reps);
  }, 3_600_000);

  // 8c. the takeoff from a standing jump: the rise, the first glide tick, the first rocket that works; the
  // same under a ceiling 2 above the ground (the jump clipped); the request at once after a teleport into
  // the air; a level glide flown into a 2-high bore
  it.skipIf(!want('takeoff'))('8c. takeoff: a standing jump (glide request tick, the first rocket that works), a 2-high clipped jump, a request after a teleport, a 2-high bore', async () => {
    const rows: Record<string, unknown>[] = [];
    const TX = area.x + 720;
    const TZ = area.z + 60;
    const park: Vec3 = { x: TX + 0.5, y: FEET_Y, z: TZ - 30.5 };
    const reps = Math.max(2, 2 * N);
    // the ceiling: one stone layer 2 above the feet (2 of air: the 1.8 body has 0.2 to rise)
    const CZ = TZ + 12;
    await build(park, { x: TX + 0.5, y: FEET_Y, z: CZ + 0.5 }, [[{ x: TX - 3, y: FEET_Y + 2, z: CZ - 3 }, { x: TX + 3 + 2 * reps, y: FEET_Y + 2, z: CZ + 3 }, 'stone']]);
    // `raw`: start_gliding (with its jump press) sent by hand on that input, the loop not asking (it holds a
    // request on the input after a jump): does the server take it on the jump input or the 1st airborne one?
    const takeoffs: { name: string; ceil: boolean; req: number; fire?: number; raw?: number; pitch: number }[] = [];
    for (const req of [1, 2, 3, 4, 7]) takeoffs.push({ name: `stand-req${req}`, ceil: false, req, pitch: 0 });
    for (const fire of [1, 2, 3, 4, 6]) takeoffs.push({ name: `stand-req2-fire${fire}`, ceil: false, req: 2, fire, pitch: -45 });
    for (const req of [1, 2, 3, 4]) takeoffs.push({ name: `ceil-req${req}`, ceil: true, req, pitch: 0 });
    takeoffs.push({ name: 'ceil-req2-fire3', ceil: true, req: 2, fire: 3, pitch: -20 });
    for (const raw of [0, 1]) for (const ceil of [false, true]) takeoffs.push({ name: `${ceil ? 'ceil' : 'stand'}-raw${raw}`, ceil, req: 99, raw, pitch: 0 });
    for (const v of takeoffs) {
      for (let k = 0; k < reps; k++) {
        const name = `takeoff-${v.name}-${k}`;
        const JUMP = 6;
        const script: Script = (c) => {
          if (c.i < JUMP) return { yaw: 0, pitch: v.pitch, glide: false, mark: 'pre' };
          const j = c.i - JUMP;
          if (j > 45) return undefined;
          return { yaw: 0, pitch: v.pitch, glide: j >= v.req, ...(j === 0 ? { jump: true } : {}), ...(v.fire === j ? { fire: true } : {}), ...(v.raw === j ? { flags: [...GLIDE_START_FLAGS] } : {}), mark: 'm' };
        };
        const { run, cmp } = await fly(name, { start: { x: TX + 0.5 + k * 2, y: FEET_Y, z: (v.ceil ? CZ : TZ) + 0.5 }, park, script });
        const sv = serverByTick(run);
        const jt = run.ticks.find((t) => t.ctl.jump === true)?.tick;
        const at = align(run);
        const dy = (t: number): number | undefined => {
          const a = sv.get(t);
          const b = sv.get(t - 1);
          return a && b ? a.y - b.y : undefined;
        };
        let rise = 0;
        let top = 0;
        if (jt !== undefined) {
          for (let t = jt; t < jt + 20; t++) {
            const d = dy(t);
            if (d === undefined) continue;
            if (d > 0) rise = t - jt + 1;
            const s = sv.get(t);
            if (s) top = Math.max(top, s.y - FEET_Y);
          }
        }
        const rq = jt !== undefined ? jt + v.req : undefined;
        const g = jt !== undefined ? at.find((a) => a.tick > jt && a.s.gliding) : undefined;
        const ev = jt !== undefined ? run.glides.find((e) => e.gliding && e.at > jt) : undefined;
        const ft = v.fire !== undefined && jt !== undefined ? jt + v.fire : undefined;
        const rocket = ft !== undefined ? run.rockets.find((x) => x.firedAt === ft) : undefined;
        const fs = ft !== undefined ? sv.get(ft - 1) : undefined;
        const later = ft !== undefined ? [...sv.entries()].filter(([t]) => t >= ft && t < ft + 30).map(([, s]) => s) : [];
        rows.push(row('takeoff', {
          name, variant: v.name, ceil: v.ceil, req: v.req, fire: v.fire, raw: v.raw, pitch: v.pitch,
          serverGlideAfter: jt !== undefined ? ([...sv.entries()].find(([t, s]) => t > jt && s.gliding)?.[0] ?? jt - 1) - jt : undefined,
          rise, top: r(top, 3),
          vyAtRequest: rq !== undefined ? r(dy(rq - 1), 3) : undefined,
          localGlideAt: jt !== undefined ? run.ticks.find((t) => t.tick > jt && t.local?.gliding)?.tick : undefined,
          glideSampleAfter: g && jt !== undefined ? g.tick - jt : undefined,
          confirmAfter: ev && jt !== undefined ? ev.at - jt : undefined,
          glided: g !== undefined,
          refusedAt: run.glides.filter((e) => e.refused).map((e) => (jt !== undefined ? e.at - jt : e.at)),
          rocket: ft !== undefined ? { entity: rocket !== undefined, addLag: rocket ? rocket.addedAt - ft : undefined, serverGlidingAtFire: fs?.gliding, fwSamples: later.filter((s) => s.fw > 0).length, gain: later.length ? r(Math.max(...later.map((s) => s.y)) - (fs?.y ?? FEET_Y), 2) : undefined } : undefined,
          damage: run.hurt.reduce((x, h) => x + h.damage, 0),
          ...mCor(run, cmp),
        }));
      }
    }
    // the glide request on the first input after a teleport into the air, 1.6 / 3 / 6 above the ground
    for (const h of [1.6, 3, 6]) {
      for (let k = 0; k < reps; k++) {
        const name = `takeoff-tp-${h}-${k}`;
        const script: Script = (c) => {
          if (c.i > 40) return undefined;
          return { yaw: 0, pitch: 0, glide: true, mark: 'm' };
        };
        const { run, cmp } = await fly(name, { start: { x: TX + 0.5 + k * 2, y: FEET_Y + h, z: TZ + 30.5 }, park, script });
        const t0 = run.ticks[0]!.tick;
        const at = align(run);
        const g = at.find((a) => a.s.gliding);
        const ev = run.glides.find((e) => e.gliding);
        const land = at.find((a) => a.s.ground);
        rows.push(row('takeoff-tp', { name, h, glideSampleAfter: g ? g.tick - t0 : undefined, heightAtGlide: g ? r(g.s.y - FEET_Y, 2) : undefined, confirmAfter: ev ? ev.at - t0 : undefined, landedAfter: land ? land.tick - t0 : undefined, glidingAtLanding: land ? at.find((a) => a.tick === land.tick - 1)?.s.gliding : undefined, refusedAt: run.glides.filter((e) => e.refused).map((e) => e.at - t0), damage: run.hurt.reduce((x, hr) => x + hr.damage, 0), ...mCor(run, cmp) }));
      }
    }
    // a level glide flown into a 2-high, 3-wide bore 10 long: does the server end the glide in it?
    const BZ = TZ + 120;
    const flat = flatWorld();
    for (const shot of [{ speed: 1.4, pitch: 0 }, { speed: 1.4, pitch: -10 }, { speed: 0.8, pitch: -10 }]) {
      const script = (n: number): Script => withPrelude('dive', 0, segments({ n, ctl: { yaw: 0, pitch: shot.pitch } }), { speed: shot.speed, divePitch: 30, prePitch: 30 });
      const startY = FEET_Y + 70;
      const sim = presim(script(200), { x: 0.5, y: startY, z: 0.5 }, flat, { maxTicks: 600 });
      const h0 = sim.findIndex((p) => p.ctl.mark === 'm');
      const frac = (y: number): number => y - Math.floor(y);
      const cross = sim.findIndex((p, i) => i > h0 + 6 && frac(p.state.pos.y) >= 0.55 && frac(p.state.pos.y) <= 0.75);
      const c = sim[cross]!.state;
      const Y = Math.floor(c.pos.y);
      const startZ = BZ - 0.3 - (c.pos.z - 0.5) - 0.05;
      await build(park, { x: TX + 0.5, y: FEET_Y, z: BZ - 6.5 }, [
        [{ x: TX - 6, y: Y - 6, z: BZ - 2 }, { x: TX + 6, y: Y + 6, z: BZ + 12 }, 'air'],
        [{ x: TX - 4, y: Y - 3, z: BZ }, { x: TX + 4, y: Y + 4, z: BZ + 9 }, 'stone'],
        [{ x: TX - 1, y: Y, z: BZ }, { x: TX + 1, y: Y + 1, z: BZ + 9 }, 'air'],
      ]);
      for (let k = 0; k < reps; k++) {
        const name = `takeoff-bore-${shot.speed}-${shot.pitch}-${k}`;
        const { run, cmp } = await fly(name, { start: { x: TX + 0.5, y: startY, z: startZ }, park, tagStep: 0.0005, script: script(cross - h0 + 25) });
        const at = align(run);
        const inside = at.filter((a) => a.s.z + 0.3 >= BZ && a.s.z - 0.3 <= BZ + 10);
        const out = at.find((a) => a.s.z - 0.3 > BZ + 10);
        rows.push(row('bore', { name, speed: shot.speed, pitch: shot.pitch, bore: { y: Y, z: BZ }, entryBottom: inside[0] ? r(inside[0].s.y - Y, 3) : undefined, inside: inside.length, glidingInside: inside.filter((a) => a.s.gliding).length, groundInside: inside.filter((a) => a.s.ground).length, minBottom: inside.length ? r(Math.min(...inside.map((a) => a.s.y)) - Y, 3) : undefined, through: out !== undefined, glidingOut: out?.s.gliding, hOut: out ? r(Math.hypot(out.s.vx, out.s.vz), 3) : undefined, damage: run.hurt.reduce((x, hr) => x + hr.damage, 0), ...mCor(run, cmp) }));
      }
    }
    save('case-takeoff', rows);
    expect(rows.length).toBe((takeoffs.length + 3 + 3) * reps);
  }, 3_600_000);

  // 9. soft landings: water, slime, hay, honey, powder snow, scaffolding, cobweb; ladders and vines
  it.skipIf(!want('soft'))('9. soft landings, and touching a ladder or vines in a glide', async () => {
    const rows: Record<string, unknown>[] = [];
    const SX = area.x + 480;
    const SZ = area.z;
    const park: Vec3 = { x: SX + 0.5, y: FEET_Y, z: SZ - 40.5 };
    const G = FEET_Y - 1; // the grass top
    // pads 9 x 9, 14 apart along x; `top`: where the body first meets it
    const pads: { block: string; top: number; fills: (x: number) => [Vec3, Vec3, string][] }[] = [
      { block: 'stone', top: G + 1, fills: (x) => [[{ x: x - 4, y: G, z: SZ - 4 }, { x: x + 4, y: G, z: SZ + 4 }, 'stone']] },
      { block: 'water', top: G + 1, fills: (x) => [[{ x: x - 4, y: G - 2, z: SZ - 4 }, { x: x + 4, y: G, z: SZ + 4 }, 'water']] },
      { block: 'slime', top: G + 1, fills: (x) => [[{ x: x - 4, y: G, z: SZ - 4 }, { x: x + 4, y: G, z: SZ + 4 }, 'slime']] },
      { block: 'hay', top: G + 1, fills: (x) => [[{ x: x - 4, y: G, z: SZ - 4 }, { x: x + 4, y: G, z: SZ + 4 }, 'hay_block']] },
      { block: 'honey', top: G + 1, fills: (x) => [[{ x: x - 4, y: G, z: SZ - 4 }, { x: x + 4, y: G, z: SZ + 4 }, 'honey_block']] },
      { block: 'powder_snow', top: G + 1, fills: (x) => [[{ x: x - 4, y: G - 1, z: SZ - 4 }, { x: x + 4, y: G, z: SZ + 4 }, 'powder_snow']] },
      { block: 'scaffolding', top: G + 2, fills: (x) => [[{ x: x - 4, y: G + 1, z: SZ - 4 }, { x: x + 4, y: G + 1, z: SZ + 4 }, 'scaffolding']] },
      { block: 'web', top: G + 3, fills: (x) => [[{ x: x - 4, y: G + 1, z: SZ - 4 }, { x: x + 4, y: G + 2, z: SZ + 4 }, 'web']] },
    ];
    const padX = (i: number) => SX + i * 14;
    for (let i = 0; i < pads.length; i++) await build(park, { x: padX(i) + 0.5, y: FEET_Y, z: SZ - 6.5 }, pads[i]!.fills(padX(i)));
    await teleport(bot!, park);
    const reps = Math.max(1, N);
    const approaches = [
      { name: 'gentle', up: 5, pitch: 0 },
      { name: 'steep', up: 22, pitch: 80 },
    ];
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i]!;
      for (const a of approaches) {
        const startY = pad.top + a.up;
        const probe = fallThenGlide(400, { yaw: 0, pitch: a.pitch });
        const sim = presim(probe, { x: 0.5, y: startY, z: 0.5 }, flatWorld(pad.top - 1), { maxTicks: 400 });
        const td = sim.find((p) => p.state.onGround)!;
        const startZ = SZ + 0.5 - (td.state.pos.z - 0.5);
        for (let k = 0; k < reps; k++) {
          const name = `soft-${pad.block}-${a.name}-${k}`;
          const { run, cmp } = await fly(name, {
            start: { x: padX(i) + 0.5, y: startY, z: startZ },
            park,
            maxTicks: 500,
            script: (c) => {
              const m = c.mem;
              if (m.touch === undefined && c.i > 3 && (c.st.onGround || c.st.inWater || c.st.pos.y < pad.top + 0.05)) m.touch = c.i;
              if (m.touch !== undefined && c.i - (m.touch as number) > 30) return undefined;
              return { yaw: 0, pitch: a.pitch, glide: glideWanted(c), mark: 'm' };
            },
          });
          const at = align(run);
          const t = at.findIndex((x) => x.s.y < pad.top + 0.3 && x.tick > run.ticks[3]!.tick);
          const before = t > 1 ? at[t - 1] : undefined;
          const before2 = t > 1 ? at[t - 2] : undefined;
          const vy = before && before2 ? before.s.y - before2.s.y : undefined;
          const after = t >= 0 ? at.slice(t, t + 30) : [];
          const bounce = after.length ? Math.max(...after.map((x) => x.s.y)) - pad.top : undefined;
          rows.push(row('soft', { name, block: pad.block, approach: a.name, vyIn: r(vy, 3), hIn: r(before && before2 ? Math.hypot(before.s.x - before2.s.x, before.s.z - before2.s.z) : undefined, 3), damage: run.hurt.reduce((x, h) => x + h.damage, 0), hurt: run.hurt.map((h) => `${h.cause}:${h.damage}`).join(','), glidingAfter: after.filter((x) => x.s.gliding).length, samplesAfter: after.length, groundAfter: after.filter((x) => x.s.ground).length, bounce: r(bounce, 2), slide: r(after.length ? Math.hypot(after.at(-1)!.s.x - after[0]!.s.x, after.at(-1)!.s.z - after[0]!.s.z) : undefined), padX: padX(i), endPos: run.end?.location, ...mCor(run, cmp) }));
        }
      }
    }
    // ladders and vines on a wall face: a slow head-on touch and a glancing pass along them. A dive to
    // the speed, then level (no rocket: the presim says where the body meets the plane); the band of
    // climbables is built around that height, a stone wall behind it.
    const LX = SX;
    const LZ = SZ + 40;
    const climb: { block: string; states: string[] }[] = [
      { block: 'ladder', states: ['facing_direction=2'] },
      { block: 'vine', states: ['vine_direction_bits=1'] },
    ];
    const flatC = flatWorld();
    for (const cl of climb) {
      for (const shot of [{ h: 0.3, yaw: 0 }, { h: 0.8, yaw: 0 }, { h: 1.0, yaw: 60 }]) {
        const pitch = shot.h < 0.5 ? 0 : 10;
        const startY = FEET_Y + 60;
        const script = (n: number): Script => withPrelude('dive', shot.yaw, segments({ n, ctl: { yaw: shot.yaw, pitch } }), { speed: shot.h, divePitch: shot.h < 0.5 ? 5 : 30, prePitch: 0 });
        const sim = presim(script(60), { x: 0.5, y: startY, z: 0.5 }, flatC, { maxTicks: 600 });
        const h0 = sim.findIndex((p) => p.ctl.mark === 'm');
        const c = sim[h0 + 6]!.state;
        const Y = Math.floor(c.pos.y);
        // the ladder's plate (3/16 thick) lies against the stone; a vine is a face plate too (no collision)
        const face = LZ - 0.1875;
        const ox = shot.yaw === 0 ? 0 : 4; // the glancing pass meets the band right of its centre, then runs along it
        const start = { x: LX + 0.5 + ox - (c.pos.x - 0.5), y: startY, z: face - 0.3 - (c.pos.z - 0.5) - 0.02 };
        const sets: [Vec3, string, string[]][] = [];
        for (let x = LX - 6; x <= LX + 6; x++) for (let y = Y - 4; y <= Y + 4; y++) sets.push([{ x, y, z: LZ - 1 }, cl.block, cl.states]);
        await build(park, { x: LX + 0.5, y: FEET_Y, z: LZ - 8.5 }, [[{ x: LX - 8, y: Y - 8, z: LZ - 1 }, { x: LX + 8, y: Y + 8, z: LZ - 1 }, 'air'], [{ x: LX - 8, y: Y - 8, z: LZ }, { x: LX + 8, y: Y + 8, z: LZ }, 'stone']], sets);
        for (let k = 0; k < reps; k++) {
          const name = `climb-${cl.block}-${shot.yaw}-${shot.h}-${k}`;
          const { run, cmp } = await fly(name, { start, park, script: script(40) });
          const at = align(run);
          const t = at.find((a) => a.s.z + 0.3 >= LZ - 1);
          const touched = at.find((a) => a.s.z + 0.3 >= face - 0.01);
          const after = touched ? at.filter((a) => a.tick >= touched.tick && a.tick < touched.tick + 20) : [];
          rows.push(row('climb', { name, block: cl.block, yaw: shot.yaw, target: shot.h, band: { y: Y, z: LZ - 1 }, predictedY: r(c.pos.y, 2), enter: t?.tick, touch: touched ? { tick: touched.tick, y: r(touched.s.y - Y, 2), h: r(Math.hypot(touched.s.vx, touched.s.vz), 3) } : undefined, maxZ: r(Math.max(...at.map((a) => a.s.z)) + 0.3 - LZ, 3), after: touched ? glideAfter(run, touched.tick, 15) : undefined, vyAfter: after.slice(1, 8).map((a, i) => r(a.s.y - after[i]!.s.y, 3)), damage: run.hurt.reduce((x, h) => x + h.damage, 0), hurt: run.hurt.map((h) => `${h.cause}:${h.damage}`).join(','), ...mCor(run, cmp) }));
        }
      }
    }
    save('case-soft', rows);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);

  // 10. threading a 1 x 1 hole and a 1-high slot at speed
  it.skipIf(!want('thread'))('10. threading a 1-high 1-wide hole and a 1-high slot at speed: allowed? pose? corrections?', async () => {
    const rows: Record<string, unknown>[] = [];
    const TX = area.x + 600;
    const TZ = area.z + 80;
    const park: Vec3 = { x: TX + 0.5, y: FEET_Y, z: TZ - 120.5 };
    const reps = Math.max(2, 2 * N);
    const flat = flatWorld();
    // `aim`: the box's bottom above the hole's floor on the last tick before its front meets the wall
    // plane. The Y-first sweep (the vertical move resolved at the old z) lets the floor's lip catch a box
    // that sinks under it while still inside the wall: clean needs the bottom high enough for the ticks inside
    for (const shot of [{ speed: 1.4, aim: 'clean', lo: 0.33, hi: 0.4 }, { speed: 1.4, aim: 'low', lo: 0.12, hi: 0.25 }, { speed: 0.8, aim: 'clean', lo: 0.33, hi: 0.4 }]) {
      const speed = shot.speed;
      // a dive to the speed, then level: deterministic (no rocket), so the presim says where the body crosses the wall
      const script = (n: number): Script => withPrelude('dive', 0, segments({ n, ctl: { yaw: 0, pitch: 0 } }), { speed, divePitch: 30, prePitch: 30 });
      const startY = FEET_Y + 70;
      const sim = presim(script(200), { x: 0.5, y: startY, z: 0.5 }, flat, { maxTicks: 600 });
      const h0 = sim.findIndex((p) => p.ctl.mark === 'm');
      const frac = (y: number): number => y - Math.floor(y);
      const cross = sim.findIndex((p, i) => i > h0 + 8 && frac(p.state.pos.y) >= shot.lo && frac(p.state.pos.y) <= shot.hi);
      const c = sim[cross]!.state;
      const Y = Math.floor(c.pos.y);
      const startZ = TZ - 0.3 - (c.pos.z - 0.5) - 0.05;
      for (const kind of ['hole', 'slot'] as const) {
        const fills: [Vec3, Vec3, string][] = [
          [{ x: TX - 6, y: Y - 5, z: TZ }, { x: TX + 6, y: Y + 5, z: TZ }, 'stone'],
          kind === 'hole' ? [{ x: TX, y: Y, z: TZ }, { x: TX, y: Y, z: TZ }, 'air'] : [{ x: TX - 6, y: Y, z: TZ }, { x: TX + 6, y: Y, z: TZ }, 'air'],
        ];
        await build(park, { x: TX + 0.5, y: FEET_Y, z: TZ - 6.5 }, fills);
        for (let k = 0; k < reps; k++) {
          const name = `thread-${kind}-${speed}-${shot.aim}-${k}`;
          const { run, cmp } = await fly(name, { start: { x: TX + 0.5, y: startY, z: startZ }, park, tagStep: 0.0005, script: script(cross - h0 + 30) });
          const at = align(run);
          const through = at.find((a) => a.s.z > TZ + 1.4);
          const atWall = at.find((a) => a.s.z + 0.3 >= TZ);
          const pre = atWall ? at.find((a) => a.tick === atWall.tick - 1) : undefined;
          const near = at.filter((a) => a.s.z + 0.3 >= TZ && a.s.z - 0.3 <= TZ + 3);
          const out = through ? at.filter((a) => a.tick > through.tick && a.tick <= through.tick + 3) : [];
          const speedOf = (a: { s: { vx: number; vz: number } } | undefined) => (a ? r(Math.hypot(a.s.vx, a.s.vz), 3) : undefined);
          rows.push(row('thread', { name, shape: kind, aim: shot.aim, speed, bottomBefore: pre ? r(pre.s.y - Y, 3) : undefined, lipTouch: near.some((a) => a.s.ground), hBefore: speedOf(pre), hAfter: speedOf(out.at(-1)), hole: { x: TX, y: Y, z: TZ }, predicted: { y: r(c.pos.y, 3) }, atWall: atWall ? { tick: atWall.tick, y: r(atWall.s.y, 3), x: r(atWall.s.x - TX, 3), h: r(Math.hypot(atWall.s.vx, atWall.s.vz), 3) } : undefined, through: through !== undefined, after: through ? glideAfter(run, through.tick, 10) : undefined, pose: run.pose.map((p) => [p.at, p.crawling, p.swimming, p.height]), damage: run.hurt.reduce((x, h) => x + h.damage, 0), hurt: run.hurt.map((h) => `${h.cause}:${h.damage}`).join(','), ...mCor(run, cmp) }));
        }
      }
    }
    save('case-thread', rows);
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);
});
