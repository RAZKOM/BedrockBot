// Script building blocks for the flight-envelope suite (Track F0, docs/flight-envelope.md).
import type { Ctl, Script, ScriptCtx } from './fly-envelope-harness.ts';

/**
 * A prelude, then `measured` (its `i` counted from the hand-over, every tick marked 'm'):
 *   'level'   one rocket at pitch 0 as soon as the glide is confirmed, then pitch 0 until the rocket is
 *             gone and `coast` ticks more (a level glide at about 1.5 to 1.6 blocks a tick)
 *   'stopped' the glide from the teleport's standstill: hand over on the tick the glide is confirmed
 *   'dive'    pitch `divePitch` until the horizontal speed reaches `speed` (no rocket)
 */
export function withPrelude(kind: 'level' | 'stopped' | 'dive', yaw: number, measured: Script, o: { coast?: number; speed?: number; divePitch?: number; prePitch?: number } = {}): Script {
  return (c) => {
    const m = c.mem;
    if (m.handover === undefined) {
      const pre = prelude(kind, yaw, c, o);
      if (pre) return { ...pre, mark: 'pre' };
      m.handover = c.i;
    }
    const r = measured({ ...c, i: c.i - (m.handover as number) });
    return r ? { mark: 'm', ...r } : undefined;
  };
}

function prelude(kind: 'level' | 'stopped' | 'dive', yaw: number, c: ScriptCtx, o: { coast?: number; speed?: number; divePitch?: number; prePitch?: number }): Ctl | undefined {
  const m = c.mem;
  if (!c.glideConfirmed) {
    if (c.i > 60) throw new Error('the glide was never confirmed');
    // (the server holds the teleported body on the ground for a tick or two: a glide request then is a
    // jump; the request goes once the body falls at 0.2 a tick, a state the offline presim reproduces)
    return { yaw, pitch: o.prePitch ?? 0, glide: glideWanted(c) };
  }
  if (kind === 'stopped') return undefined;
  if (kind === 'dive') {
    if (c.h >= (o.speed ?? 1)) return undefined;
    if (c.i > 400) throw new Error('the dive never reached the speed');
    return { yaw, pitch: o.divePitch ?? 30 };
  }
  if (!m.fired) {
    m.fired = true;
    return { yaw, pitch: 0, fire: true };
  }
  if (c.rocketsAlive > 0 || c.sinceRocketGone === undefined) {
    if (c.i > 120) throw new Error('the rocket never went');
    return { yaw, pitch: 0 };
  }
  if (c.sinceRocketGone < (o.coast ?? 8)) return { yaw, pitch: 0 };
  return undefined;
}

/** The glide request once the teleported body falls (vy under -0.2), held from then on. */
export function glideWanted(c: ScriptCtx): boolean {
  if (c.st.vel.y < -0.2) c.mem.glideAsked = true;
  return c.mem.glideAsked === true;
}

/** From the teleport's standstill: fall, request the glide (vy under -0.2), then `ctl` every tick for `n` ticks (marked 'm' once gliding). */
export function fallThenGlide(n: number, ctl: Ctl | ((i: number, c: ScriptCtx) => Ctl | undefined)): Script {
  return (c) => {
    const glide = glideWanted(c);
    const k = c.i - ((c.mem.from as number | undefined) ?? c.i);
    if (glide && c.mem.from === undefined) c.mem.from = c.i;
    if (glide && k >= n) return undefined;
    const base = typeof ctl === 'function' ? ctl(glide ? k : -1, c) : ctl;
    if (!base) return undefined;
    return { ...base, glide, mark: glide ? 'm' : 'pre' };
  };
}

/** Hold a control for `n` ticks, then the next segment. */
export function segments(...segs: { n: number; ctl: Ctl | ((i: number, c: ScriptCtx) => Ctl) }[]): Script {
  return (c) => {
    let i = c.i;
    for (const s of segs) {
      if (i < s.n) return typeof s.ctl === 'function' ? s.ctl(i, c) : s.ctl;
      i -= s.n;
    }
    return undefined;
  };
}
