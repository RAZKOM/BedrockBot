// Metrics of the flight-envelope runs (Track F0, docs/flight-envelope.md): the same numbers from the
// server's samples and from the model flown open loop from the server's state (fly-envelope-harness.ts).
import type { Vec3 } from '../../src/connection/types.ts';
import type { BlockQuery } from '../../src/skills/input/index.ts';
import { burnRuns, compareRun, inferBoosts, openLoop, serverByTick, type RunRec } from './fly-envelope-harness.ts';

export interface Pt {
  tick: number;
  pos: Vec3;
  /** The move of this tick (pos - the previous pos). */
  vel: Vec3;
}

/** Server and model tracks over the same ticks from input `from` (the model open loop from there). */
export function tracks(run: RunRec, world: BlockQuery, from: number, o: { to?: number; burns?: Map<number, number> } = {}): { server: Pt[]; model: Pt[] } {
  const pts = openLoop(run, world, from, o);
  const server: Pt[] = [];
  const model: Pt[] = [];
  let prevS: Vec3 | undefined;
  for (const p of pts) {
    model.push({ tick: p.tick, pos: p.model.pos, vel: p.model.vel });
    if (p.server) {
      const pos = { x: p.server.x, y: p.server.y, z: p.server.z };
      const vel = prevS && server.at(-1)?.tick === p.tick - 1 ? sub(pos, prevS) : { x: p.server.vx, y: p.server.vy, z: p.server.vz };
      server.push({ tick: p.tick, pos, vel });
      prevS = pos;
    } else prevS = undefined;
  }
  return { server, model };
}

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const hOf = (v: Vec3): number => Math.hypot(v.x, v.z);
/** Bedrock yaw of a horizontal velocity (0 = +z, 90 = -x). */
export const headingOf = (v: Vec3): number => (Math.atan2(-v.x, v.z) * 180) / Math.PI;
export const r = (x: number | undefined, d = 2): number | undefined => (x === undefined || !Number.isFinite(x) ? undefined : Number(x.toFixed(d)));

export function at(track: Pt[], tick: number): Pt | undefined {
  return track.find((p) => p.tick === tick);
}

/** The brake / turn numbers of a track from tick `t0` (the tick before the manoeuvre): along the start heading `yaw0`. */
export function turnMetrics(track: Pt[], t0: number, yaw0: number): { h0?: number; h5?: number; h10?: number; h20?: number; stopTicks?: number; forward?: number; dy?: number; head3?: number; head10?: number; minH?: number } {
  const p0 = at(track, t0);
  if (!p0) return {};
  const fx = -Math.sin((yaw0 * Math.PI) / 180);
  const fz = Math.cos((yaw0 * Math.PI) / 180);
  const after = track.filter((p) => p.tick > t0);
  const stop = after.find((p) => hOf(p.vel) < 0.2);
  const end = stop ?? after.at(-1);
  const h = (k: number) => {
    const p = at(track, t0 + k);
    return p ? hOf(p.vel) : undefined;
  };
  const hd = (k: number) => {
    const p = at(track, t0 + k);
    return p ? headingOf(p.vel) : undefined;
  };
  return {
    h0: r(hOf(p0.vel)),
    h5: r(h(5)),
    h10: r(h(10)),
    h20: r(h(20)),
    stopTicks: stop ? stop.tick - t0 : undefined,
    forward: end ? r((end.pos.x - p0.pos.x) * fx + (end.pos.z - p0.pos.z) * fz) : undefined,
    dy: end ? r(end.pos.y - p0.pos.y) : undefined,
    head3: r(hd(3), 0),
    head10: r(hd(10), 0),
    minH: after.length ? r(Math.min(...after.map((p) => hOf(p.vel)))) : undefined,
  };
}

/** Station keeping over the window [t0, t1]: the sink a tick, the horizontal drift, the largest speed. */
export function hoverMetrics(track: Pt[], t0: number, t1: number): { sink?: number; drift?: number; maxH?: number; meanH?: number; ticks: number } {
  const w = track.filter((p) => p.tick >= t0 && p.tick <= t1);
  if (w.length < 2) return { ticks: w.length };
  const a = w[0]!;
  const b = w.at(-1)!;
  const n = b.tick - a.tick;
  const hs = w.slice(1).map((p) => hOf(p.vel));
  return { sink: r(-(b.pos.y - a.pos.y) / n, 3), drift: r(Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z)), maxH: r(Math.max(...hs), 3), meanH: r(hs.reduce((x, y) => x + y, 0) / hs.length, 3), ticks: n };
}

/**
 * Per fire tick: the burn as the server's samples show it. `fw` (the fireworks_rocket entities within 4
 * blocks of the body, truth:glidelog) is 1 on exactly the boosted samples (checked against the boost
 * inferred from the physics while the client still agrees with the server); the burn runs from the fire
 * tick to the last tick of the run of samples with a rocket (missing samples bridged). `exact` when the
 * tick after it has a sample (with none). `inferred`: the physics' own call (burnRuns), when it is sure.
 */
export function burns(run: RunRec, world: BlockQuery): { fire: number; ticks?: number; exact?: boolean; to?: number; maxFw?: number; inferred?: number; added?: number; removed?: number }[] {
  const at = serverByTick(run);
  const runs = burnRuns(inferBoosts(run, world));
  const fires = run.ticks.filter((t) => t.fired).map((t) => t.tick);
  const last = run.ticks.at(-1)?.tick ?? 0;
  return fires.map((f, i) => {
    const next = fires[i + 1] ?? last + 1;
    let to: number | undefined;
    let maxFw = 0;
    let miss = 0;
    for (let t = f; t < Math.max(next, f + 40) && t <= last; t++) {
      const s = at.get(t);
      if (!s) {
        if (++miss > 3) break;
        continue;
      }
      miss = 0;
      if (s.fw < 1) break;
      to = t;
      maxFw = Math.max(maxFw, s.fw);
    }
    const inf = runs.find((x) => x.sure && x.from >= f - 1 && x.from <= f + 1);
    const rk = run.rockets.find((x) => x.firedAt === f);
    return { fire: f, ...(to !== undefined ? { ticks: to - f + 1, to, exact: at.has(to + 1) && at.get(to + 1)!.fw < 1, maxFw } : {}), ...(inf ? { inferred: inf.ticks } : {}), added: rk?.addedAt, removed: rk?.removedAt };
  });
}

export function stats(xs: number[]): { n: number; min?: number; max?: number; mean?: number; median?: number; hist?: Record<string, number> } {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const hist: Record<string, number> = {};
  for (const x of s) hist[String(x)] = (hist[String(x)] ?? 0) + 1;
  return { n: s.length, min: s[0], max: s.at(-1), mean: r(s.reduce((a, b) => a + b, 0) / s.length, 2), median: s[Math.floor(s.length / 2)], hist };
}

export { compareRun, serverByTick };
