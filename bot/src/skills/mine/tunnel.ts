// Direct tunnels (wave 10 Track AQ; docs/mining.md "Direct tunnels", docs/decisions/0038): when the walk
// planner finds no way to an ore (or only a long detour), the miner digs straight at it, one block at a
// time, and climbs back the same way. The same step primitive digs branch mining's staircase (branch.ts).
//
//   steps      flat     1 forward, 2 high (head, feet)
//              up       1 forward and 1 up: the head room over the old head, the new head, the new feet
//              down     1 forward and 1 down: the old head height of the next column, its feet height and
//                       the new feet (a diagonal staircase the walk planner climbs back)
//              shaft    straight down: the block under the feet (the bot stands on what it digs and drops
//                       into the cell); only on the shaft plan (owner, 2026-10-30)
//   plan       the whole route is planned on the world model before the first dig (greedy, straight at the
//              ore: each step the one that brings the feet closest, never back the way it came), so a rule
//              that blocks it costs nothing: the first blocked cell ends the plan with the reason
//   rules      every cell to dig passes the navigator's break rules (`breakRule`: protected area, built
//              blocks, liquids next to it, gravity blocks above it); a cell the plan has to stand on is
//              never dug later (the way back stays), every new feet cell needs a solid dry floor
//   shaft      on top of that, before each block: the block below it known and solid (never into a cave or
//              unknown), no liquid in it or its 4 side neighbours 1 or 2 blocks below, no pointed dripstone
//              in the 3 x 3 columns 1 to 3 blocks below, no gravity block over the shaft's top, and never
//              lower than 2 blocks above the world's floor
//   choice     the staircase plan unless the shaft plan digs at least SHAFT_SAVES (8) blocks fewer; a shaft
//              needs a way back: throwaway blocks for a pillar (depth + 4) or a staircase up from its
//              bottom (planned too, before the descent)
//   end        the eye within reach (4.5) of the ore and a clear line of sight, or the ore (or another of
//              the asked kind) is the next cell to dig: the miner's sight digs and dig take over
import type { BlockInfo, Vec3 } from '../../world/types.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import { EYE_HEIGHT } from '../dig/look.ts';
import { ruleCell } from '../nav/baritone/helper.ts'; // Track BB: the shared rule set
import type { Goal } from '../nav/goals.ts';
import type { TerrainClass } from '../terrain/classify.ts';
import { closestDistance } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { lineOfSight } from './seen.ts';

export type Dir = readonly [number, number];
export const DIRS: readonly Dir[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export type StepKind = 'flat' | 'up' | 'down' | 'shaft';

/** One step: the cells to clear (top first), the floor the feet will stand on, the new feet cell. */
export interface Step {
  feet: Vec3;
  dig: Vec3[];
  floor: Vec3;
  kind?: StepKind;
  dir?: Dir;
}

const up = (p: Vec3, dy: number): Vec3 => ({ x: p.x, y: p.y + dy, z: p.z });
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const fmt = (p: Vec3) => `${p.x} ${p.y} ${p.z}`;

/** A staircase step from feet cell `tip` in `dir`, one block down (dy -1) or up (dy 1). */
export function stairStep(tip: Vec3, dir: Dir, dy: -1 | 1): Step {
  const feet = { x: tip.x + dir[0], y: tip.y + dy, z: tip.z + dir[1] };
  if (dy < 0) {
    // walking forward over the edge needs the next column clear at the old head height and above it
    return { feet, dig: [up(feet, 2), up(feet, 1), feet], floor: up(feet, -1), kind: 'down', dir };
  }
  // the jump needs the head room above the old head, the new column its two body cells
  return { feet, dig: [up(tip, 2), up(feet, 1), feet], floor: up(feet, -1), kind: 'up', dir };
}

/** A flat 2-high tunnel step from `tip` in `dir`. */
export function flatStep(tip: Vec3, dir: Dir): Step {
  const feet = { x: tip.x + dir[0], y: tip.y, z: tip.z + dir[1] };
  return { feet, dig: [up(feet, 1), feet], floor: up(feet, -1), kind: 'flat', dir };
}

/** Straight down: dig the block under the feet and drop into its cell. */
export function shaftStep(tip: Vec3): Step {
  const feet = up(tip, -1);
  return { feet, dig: [feet], floor: up(feet, -1), kind: 'shaft' };
}

/** What the planner reads of a cell (Track BB: nav/baritone/helper.ts `RuleCell`, built by `tunnelCell`). */
export interface TunnelCell {
  /** The body passes: Baritone `canWalkThrough` (no collision box, no liquid, no hazard). */
  open: boolean;
  /** A floor the body may stand on: Baritone `canWalkOn` (a box top covering the centre, not a liquid, not a hazard). */
  solid: boolean;
  liquid: boolean;
  gravity: boolean;
  dripstone: boolean;
  /** Track BB: the body must never move into it (Baritone `avoidWalkingInto`: liquids and hazards such as fire or a berry bush, with or without a box). Optional for older fakes. */
  hazard?: boolean;
}

/** Track BB: the tunnel planner's cell facts of a classified block, from the shared rule set (wire.ts builds `TunnelWorld.cell` with it). */
export function tunnelCell(c: TerrainClass): TunnelCell {
  return ruleCell(c);
}

export interface TunnelWorld {
  /** The navigator's break rules for a dig (nav/actions.ts breakBlocker without the under-feet rule): undefined = may, `air` = open, else the reason. */
  breakRule(p: Vec3): string | undefined;
  /** undefined = not loaded. */
  cell(p: Vec3): TunnelCell | undefined;
  blockAt(p: Vec3): BlockInfo | undefined;
  /** Lowest y of the world (bedrock floor); default -64. */
  minY?: number;
}

export type TunnelGoal = { kind: 'ore'; p: Vec3 } | { kind: 'feet'; p: Vec3 };
export type TunnelMode = 'stairs' | 'shaft';

export interface TunnelPlanOptions {
  mode: TunnelMode;
  /** Eye to the ore's closest point; default MINE_TUNNEL_REACH (4.5). */
  reach?: number;
  /** Steps at most; default 64. */
  maxSteps?: number;
  /** Block names that end the tunnel when they are the next cell to dig (the asked ore kinds). */
  names?: ReadonlySet<string>;
  /** Cells already dug (a climb-back plan after a planned descent). */
  opened?: Iterable<string>;
}

export interface TunnelPlan {
  ok: boolean;
  mode: TunnelMode;
  steps: Step[];
  /** Solid blocks the plan digs. */
  dug: number;
  /** reach: the ore is in reach and in sight; ore: another block of the asked kinds is next (`ore`); feet: the feet goal's level. */
  end?: 'reach' | 'ore' | 'feet';
  ore?: Vec3;
  why?: string;
  /** Where the plan was blocked. */
  at?: Vec3;
  /** Shaft steps (blocks of depth). */
  depth: number;
  /** Every cell open at the end of the plan (the world's open cells not included). */
  opened: Set<string>;
}

/** Eye to the ore's closest point at which the tunnel ends (the Digger's own reach is 5). */
export const MINE_TUNNEL_REACH = 4.5;
/** The shaft plan is taken when it digs at least this many blocks fewer than the staircase (owner, 2026-10-30). */
export const SHAFT_SAVES = 8;
/** Throwaway blocks a pillar back up needs beyond the depth. */
export const PILLAR_SPARE = 4;

const AIR: BlockInfo = { name: 'air', stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] };

/** Why the shaft may not dig `q` (the block under the feet), undefined when it may. `first`: the first block of a shaft. */
export function shaftRule(w: TunnelWorld, q: Vec3, opened: ReadonlySet<string>, first: boolean): string | undefined {
  const minY = w.minY ?? -64;
  if (q.y < minY + 2) return `world floor below ${fmt(q)}`;
  for (let dy = 1; dy <= 2; dy++)
    for (const [dx, dz] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const c = w.cell({ x: q.x + dx, y: q.y - dy, z: q.z + dz });
      if (c?.liquid) return `liquid_below at ${fmt({ x: q.x + dx, y: q.y - dy, z: q.z + dz })}`;
    }
  for (let dy = 1; dy <= 3; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const p = { x: q.x + dx, y: q.y - dy, z: q.z + dz };
        if (w.cell(p)?.dripstone) return `dripstone_below at ${fmt(p)}`;
      }
  const below = up(q, -1);
  const b = w.cell(below);
  if (!b) return `unknown_below at ${fmt(below)}`;
  if (opened.has(key(below)) || !b.solid) return `no_floor_below at ${fmt(below)}`;
  if (first) {
    // the shaft's column over the bot: nothing may fall in once the bot is down there
    const over = up(q, 3);
    if (w.cell(over)?.gravity) return `gravity_above at ${fmt(over)}`;
  }
  return undefined;
}

interface Cand {
  st: Step;
  score: number;
  sum: number;
  same: number;
  /** Turn preference while the way down / up is longer than the way across: right, left, straight on (a spiral). */
  turn: number;
  why?: string;
  stop?: { end: 'reach' | 'ore'; ore?: Vec3 };
}

/**
 * Plan a direct tunnel from feet cell `from` to `goal` on the world model (nothing is dug). The plan
 * is straight: each step the one that brings the feet closest to where the ore can be mined from
 * (`stairs`: diagonal staircases, at most one block of height per step; `shaft`: horizontal to the
 * ore's column first, then straight down), never the way back.
 */
export function planTunnel(w: TunnelWorld, from: Vec3, goal: TunnelGoal, o: TunnelPlanOptions): TunnelPlan {
  const reach = o.reach ?? MINE_TUNNEL_REACH;
  const opened = new Set<string>(o.opened ?? []);
  const floors = new Set<string>([key(up(from, -1))]);
  const steps: Step[] = [];
  let dug = 0;
  let depth = 0;
  let c = { ...from };
  let last: Dir | undefined;
  let lastKind: StepKind | undefined;
  const T = goal.p;
  const isOpen = (p: Vec3) => opened.has(key(p)) || w.cell(p)?.open === true;
  const view = (p: Vec3): BlockInfo | undefined => (opened.has(key(p)) ? AIR : w.blockAt(p));
  const eye = (f: Vec3) => ({ x: f.x + 0.5, y: f.y + EYE_HEIGHT, z: f.z + 0.5 });
  const plan = (ok: boolean, extra: Partial<TunnelPlan> = {}): TunnelPlan => ({ ok, mode: o.mode, steps, dug, depth, opened, ...extra });
  const scoreOf = (f: Vec3): { score: number; h: number; v: number } => {
    const hd = Math.abs(T.x - f.x) + Math.abs(T.z - f.z);
    if (goal.kind === 'feet') {
      const v = Math.max(0, T.y - f.y);
      return { score: v, h: hd, v }; // up to the level first; the walk covers the ground after
    }
    const dy = T.y - f.y;
    let h = Math.max(0, hd - 1);
    let v = dy < 0 ? -dy : dy > 1 ? dy - 1 : 0;
    if (o.mode === 'shaft' && hd === 0 && dy < 0) {
      v = -dy - 1; // stand on it, then dig it from above
      h = 0;
    }
    return { score: o.mode === 'shaft' ? h + v : Math.max(h, v), h, v };
  };

  for (let i = 0; i <= (o.maxSteps ?? 64); i++) {
    // end?
    if (goal.kind === 'feet') {
      if (c.y >= T.y) return plan(true, { end: 'feet' });
    } else if (T.x === c.x && T.z === c.z && T.y === c.y - 1) {
      // the ore is the block under the feet: only a shaft digs it, under the shaft's rules
      if (o.mode === 'shaft') {
        const why = shaftRule(w, T, opened, lastKind !== 'shaft');
        return why ? plan(false, { why, at: { ...T } }) : plan(true, { end: 'reach' });
      }
    } else {
      const e = eye(c);
      if (closestDistance(e, T) <= reach && lineOfSight(view, e, T).clear) return plan(true, { end: 'reach' });
    }
    if (i === o.maxSteps) break;
    // candidate steps
    const sts: Step[] = [];
    const dy = T.y - c.y;
    const hd = Math.abs(T.x - c.x) + Math.abs(T.z - c.z);
    for (const d of DIRS) {
      if (last && d[0] === -last[0] && d[1] === -last[1]) continue; // never back the way it came
      sts.push(flatStep(c, d));
      if (goal.kind === 'feet' ? T.y > c.y : dy >= 2) sts.push(stairStep(c, d, 1));
      if (o.mode === 'stairs' && goal.kind === 'ore' && dy < 0) sts.push(stairStep(c, d, -1));
    }
    if (o.mode === 'shaft' && goal.kind === 'ore' && dy < 0 && hd <= 1) sts.push(shaftStep(c));
    const here = scoreOf(c);
    const spiral = here.v > here.h; // more height to go than ground to cover: turn every step (a 2 x 2 spiral)
    const cands: Cand[] = sts.map((st) => {
      const s = scoreOf(st.feet);
      const same = !!last && !!st.dir && st.dir[0] === last[0] && st.dir[1] === last[1];
      const right = !!last && !!st.dir && st.dir[0] === -last[1] && st.dir[1] === last[0];
      const left = !!last && !!st.dir && st.dir[0] === last[1] && st.dir[1] === -last[0];
      const cand: Cand = { st, score: s.score, sum: s.h + s.v, same: same ? 0 : 1, turn: !last || !st.dir || right ? 0 : left ? 1 : same ? 2 : 3 };
      const r = checkStep(st, cand);
      if (r) cand.why = r;
      return cand;
    });
    cands.sort((a, b) => a.score - b.score || (spiral ? a.turn - b.turn : 0) || a.sum - b.sum || a.same - b.same || kindRank(a.st) - kindRank(b.st));
    const best = cands[0];
    if (!best) return plan(false, { why: 'no step' });
    // the best steps blocked only by the shape of the ground (no floor for it, the way back under it): one
    // step that is worse by 1 may go round (a flat step onto the floor before the stairs up); a dig rule
    // (protected, liquid, unknown) ends the plan
    const geometric = cands.filter((x) => x.score === best.score).every((x) => !x.why || GEOMETRIC.test(x.why));
    const pick = cands.find((x) => !x.why && x.score <= best.score) ?? (geometric ? cands.find((x) => !x.why && x.score <= best.score + 1) : undefined);
    if (!pick) return plan(false, { why: best.why ?? 'blocked', at: { ...best.st.feet } });
    if (pick.stop) return plan(true, { end: pick.stop.end, ...(pick.stop.ore ? { ore: pick.stop.ore } : {}) });
    for (const q of pick.st.dig) {
      if (!isOpen(q)) dug++;
      opened.add(key(q));
    }
    if (pick.st.kind === 'shaft') {
      floors.delete(key(pick.st.dig[0]!));
      depth++;
    }
    floors.add(key(pick.st.floor));
    steps.push(pick.st);
    c = { ...pick.st.feet };
    if (pick.st.dir) last = pick.st.dir;
    lastKind = pick.st.kind;
  }
  return plan(false, { why: `more than ${o.maxSteps ?? 64} steps`, at: { ...c } });

  function checkStep(st: Step, cand: Cand): string | undefined {
    let stop: Cand['stop'];
    for (const q of st.dig) {
      if (goal.kind === 'ore' && q.x === T.x && q.y === T.y && q.z === T.z) {
        // the ore is the next cell: mined from here when it is in reach (the other cells are checked too: the sight digs take them)
        if (closestDistance(eye(c), T) > reach) return `the ore is in the way at ${fmt(q)}`;
        stop = { end: 'reach' };
        continue;
      }
      if (isOpen(q)) continue;
      const cell = w.cell(q);
      if (!cell) return `not loaded at ${fmt(q)}`;
      const name = w.blockAt(q)?.name;
      if (o.names && name && o.names.has(name) && st.kind !== 'shaft') {
        stop ??= { end: 'ore', ore: { ...q } };
        continue;
      }
      if (st.kind !== 'shaft' && floors.has(key(q))) return `would dig the floor of the way back at ${fmt(q)}`;
      const rule = w.breakRule(q);
      if (rule && rule !== 'air') return `${rule} at ${fmt(q)}`;
      // Track BB: a hazard without a box (fire, a berry bush) is "air" to the break rules but never walked into
      if (rule === 'air' && cell.hazard) return `hazard at ${fmt(q)}`;
    }
    if (st.kind === 'shaft') {
      const why = shaftRule(w, st.dig[0]!, opened, lastKind !== 'shaft');
      if (why) return why;
      if (o.names?.has(w.blockAt(st.dig[0]!)?.name ?? '')) stop ??= { end: 'ore', ore: { ...st.dig[0]! } };
    } else if (!stop) {
      const f = st.floor;
      const cell = w.cell(f);
      if (!cell) return `floor not loaded at ${fmt(f)}`;
      if (opened.has(key(f)) || !cell.solid) return `no floor at ${fmt(f)}`;
    }
    if (stop) cand.stop = stop;
    return undefined;
  }
}

/** Reasons that come from the shape of the ground, not from a dig rule. */
const GEOMETRIC = /^(no floor|would dig the floor of the way back|the ore is in the way)/;

function kindRank(st: Step): number {
  return st.kind === 'flat' ? 0 : st.kind === 'shaft' ? 1 : 2;
}

/** Which plan to dig: the staircase unless the shaft saves SHAFT_SAVES blocks or more (and the shaft has a way back). */
export function chooseTunnel(stairs: TunnelPlan, shaft: TunnelPlan | undefined): TunnelPlan {
  if (!shaft) return stairs;
  if (stairs.ok && shaft.ok) return stairs.dug - shaft.dug >= SHAFT_SAVES ? shaft : stairs;
  if (shaft.ok) return shaft;
  // the shaft found a hazard under the ore (liquid, dripstone, a cave): when the shaft is the short way
  // that is the reason to skip the ore, not a long staircase down next to the hazard
  const hazard = (shaft.why ?? '').includes('_below');
  if (hazard && (!stairs.ok || stairs.dug - shaft.dug >= SHAFT_SAVES)) return shaft;
  return stairs;
}

// ---- digging ---------------------------------------------------------------------------------------

/** What digging a step needs. */
export interface StepIO {
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  /** The break rules (`air` for an open cell). */
  breakRule(p: Vec3): string | undefined;
  /** The body may be in this cell (no collision, no liquid). */
  free?(p: Vec3): boolean | undefined;
  /** Still the same run (not stopped, not paused). */
  alive(): boolean;
}

export type StepResult = 'ok' | 'blocked' | 'interrupted' | 'failed';

/**
 * Clear the cells of a step (top first), re-checking the break rules on the live world right before
 * each dig. `skip(c)` may hand a cell back ('defer': the step returns 'interrupted' without digging it:
 * branch mining leaves an asked ore to the miner). `onDug` gets every broken cell.
 */
export async function clearStep(io: StepIO, st: Step, hooks: { skip?(c: Vec3): 'defer' | undefined; onDug?(c: Vec3): void; onFail?(c: Vec3, why: string): void } = {}): Promise<StepResult> {
  for (const c of st.dig) {
    if (io.free?.(c) === true) continue;
    const rule = io.breakRule(c);
    if (rule === 'air') continue;
    if (rule) return 'blocked';
    if (hooks.skip?.(c) === 'defer') return 'interrupted';
    const r = await io.dig(c);
    if (!io.alive()) return 'interrupted';
    if (!r.ok) {
      hooks.onFail?.(c, r.reason ?? 'failed');
      return r.reason === 'interrupted' || r.reason === 'cancelled' ? 'interrupted' : 'failed';
    }
    hooks.onDug?.(c);
  }
  return 'ok';
}

/** What running a planned tunnel needs (the miner wires it). */
export interface TunnelIO extends StepIO {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  position(): Vec3 | undefined;
  waitTicks(n: number): Promise<void>;
}

export interface TunnelRun {
  ok: boolean;
  dug: number;
  steps: number;
  why?: string;
  interrupted?: boolean;
}

/**
 * Dig a planned tunnel step by step and walk (or drop) into each new cell. Every cell is checked again
 * against the break rules right before its dig, shaft blocks against the shaft rules too.
 */
export async function runTunnel(io: TunnelIO, w: TunnelWorld, plan: TunnelPlan, onDug?: (p: Vec3) => void): Promise<TunnelRun> {
  let dug = 0;
  let n = 0;
  let shaftCells = new Set<string>();
  let prevKind: StepKind | undefined;
  for (const st of plan.steps) {
    if (!io.alive()) return { ok: false, dug, steps: n, interrupted: true };
    if (st.kind === 'shaft') {
      const why = shaftRule(w, st.dig[0]!, shaftCells, prevKind !== 'shaft');
      if (why) return { ok: false, dug, steps: n, why };
    }
    const r = await clearStep(io, st, {
      onDug: (c) => {
        dug++;
        onDug?.(c);
      },
    });
    if (r === 'interrupted') return { ok: false, dug, steps: n, interrupted: true };
    if (r === 'blocked') return { ok: false, dug, steps: n, why: `blocked at ${fmt(st.feet)} (${st.dig.map((c) => io.breakRule(c)).filter((x) => x && x !== 'air').join(', ') || 'rules'})` };
    if (r === 'failed') return { ok: false, dug, steps: n, why: `dig failed at ${fmt(st.feet)}` };
    if (st.kind === 'shaft') {
      shaftCells = new Set([...shaftCells, key(st.feet)]);
      let landed = false;
      for (let t = 0; t < 40 && io.alive(); t++) {
        const p = io.position();
        if (p && p.y < st.feet.y + 0.2) {
          landed = true;
          break;
        }
        await io.waitTicks(1);
      }
      if (!io.alive()) return { ok: false, dug, steps: n, interrupted: true };
      if (!landed) return { ok: false, dug, steps: n, why: `did not drop into ${fmt(st.feet)}` };
      await io.waitTicks(2);
    } else {
      let g = await io.goto({ type: 'block', p: st.feet }, { allowBreak: false, allowPlace: false, timeoutTicks: 200 });
      if (!io.alive()) return { ok: false, dug, steps: n, interrupted: true };
      if (!g.ok && g.reason !== 'interrupted') g = await io.goto({ type: 'block', p: st.feet }, { allowBreak: true, allowPlace: false, timeoutTicks: 300 });
      if (!io.alive() || (!g.ok && g.reason === 'interrupted')) return { ok: false, dug, steps: n, interrupted: true };
      if (!g.ok) return { ok: false, dug, steps: n, why: `could not step into ${fmt(st.feet)}: ${g.reason}` };
    }
    prevKind = st.kind;
    n++;
  }
  return { ok: true, dug, steps: n };
}
