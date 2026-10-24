// Felling (PLAN.md task 4.3): break every log of a tree from the bottom up. When the next log is
// out of reach, re-path: walk to the best standable cell from which it is in reach (most remaining
// logs in reach, close to the tree, close to the bot). Pillar-up (placing blocks under the feet) is
// not implemented: trees up to 7 logs are fully reachable from the ground next to the trunk
// (docs/wood.md "Reach").
//
// Blacklist (task 7.10): a log no stand cell could be reached for, or that failed to dig 3 times,
// counts one failure on the navigator's blacklist (nav/blacklist.ts); a blacklisted log is skipped
// at once, so after 3 failed attempts a gather stops walking back to it (the tree finder skips it too).
import { silentLogger, type Logger } from '../../log.ts';
import type { Vec3 } from '../../world/types.ts';
import { checkReach, DEFAULT_REACH, EYE_HEIGHT } from '../dig/look.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { isLog, remainingLogs, type BlockLookup, type Tree } from './tree.ts';

export interface FellDeps {
  blockAt: BlockLookup;
  /** Feet position and the correction counter (InputLoop.state). */
  state: () => { pos: Vec3; corrections: number };
  dig: (p: Vec3, opts?: DigOptions) => Promise<DigResult>;
  goto: (goal: Goal, opts?: GotoOptions) => Promise<SkillResult>;
  /** Feet height of a body standing in cell (x, y, z), NaN = blocked, undefined = unknown (NavGrid.stand). */
  stand: (x: number, y: number, z: number) => number | undefined;
  /** True once the operation was cancelled (BotSkills.cancel or a newer skill). */
  cancelled: () => boolean;
  logger?: Logger;
  /** The navigator's failure blacklist (logs the bot could not get to are skipped). */
  blacklist?: { blocked(p: Vec3): boolean; failBlock(p: Vec3, why?: string): boolean };
}

export interface FellOptions {
  /** Dig options for every log (default tool 'best'). */
  dig?: DigOptions;
  /** Own reach for choosing where to stand (eye to the closest point). Default DEFAULT_REACH - 0.25. */
  reach?: number;
  /** Max re-path attempts per log. Default 4. */
  repathTries?: number;
  /** goto timeout per re-path. Default 600 ticks. */
  gotoTimeoutTicks?: number;
  /** Blocks other than logs that may be dug (default none: logs only). */
  allowDig?: (name: string) => boolean;
  /** Horizontal search radius for stand cells around a log. Default 4. */
  standRadius?: number;
}

export interface FellResult {
  ok: boolean;
  reason?: string;
  /** Logs broken, in order. */
  broken: Vec3[];
  /** Logs left (unreachable or failed), positions. */
  left: Vec3[];
  repaths: number;
  digFailures: number;
  /** Corrections received while felling. */
  corrections: number;
  ticksDigging: number;
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/** Standable cells from which `target` is in reach, best first. */
export function standSpots(
  target: Vec3,
  deps: Pick<FellDeps, 'stand'>,
  opts: { reach: number; radius: number; from: Vec3; others: readonly Vec3[] },
): { cell: Vec3; feet: number; score: number }[] {
  const out: { cell: Vec3; feet: number; score: number }[] = [];
  const r = opts.radius;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -6; dy <= 1; dy++) {
        const cell = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
        const feet = deps.stand(cell.x, cell.y, cell.z);
        if (feet === undefined || Number.isNaN(feet)) continue;
        const eye = { x: cell.x + 0.5, y: feet + EYE_HEIGHT, z: cell.z + 0.5 };
        if (!checkReach(eye, target, opts.reach).ok) continue;
        const reachable = opts.others.filter((o) => checkReach(eye, o, opts.reach).ok).length;
        const toTarget = Math.hypot(cell.x + 0.5 - (target.x + 0.5), cell.z + 0.5 - (target.z + 0.5));
        const toBot = Math.hypot(cell.x + 0.5 - opts.from.x, feet - opts.from.y, cell.z + 0.5 - opts.from.z);
        const score = -3 * reachable + toTarget + 0.3 * toBot + 0.5 * Math.abs(feet - opts.from.y);
        out.push({ cell, feet, score });
      }
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

export async function fellTree(tree: Tree, deps: FellDeps, opts: FellOptions = {}): Promise<FellResult> {
  const log = deps.logger ?? silentLogger;
  const reach = opts.reach ?? DEFAULT_REACH - 0.25;
  const tries = opts.repathTries ?? 4;
  const allow = (name: string | undefined) => isLog(name) || (!!name && !!opts.allowDig?.(name));
  const c0 = deps.state().corrections;
  const res: FellResult = { ok: false, broken: [], left: [], repaths: 0, digFailures: 0, corrections: 0, ticksDigging: 0 };
  const skipped = new Set<string>();
  const failsAt = new Map<string, number>();
  const finish = (ok: boolean, reason?: string): FellResult => {
    res.ok = ok;
    if (reason) res.reason = reason;
    res.left = remainingLogs(deps.blockAt, tree);
    res.corrections = deps.state().corrections - c0;
    log.info(`fell ${tree.kind} tree at ${key(tree.base)}: ${res.broken.length}/${tree.logs.length} logs, ${res.left.length} left, ${res.repaths} re-path(s), ${res.digFailures} dig failure(s), ${res.corrections} correction(s)${reason ? ` (${reason})` : ''}`);
    return res;
  };

  for (let iter = 0; iter < 8 * tree.logs.length + 16; iter++) {
    if (deps.cancelled()) return finish(false, 'interrupted');
    const remaining = remainingLogs(deps.blockAt, tree).filter((p) => !skipped.has(key(p)));
    const listed = remaining.find((p) => deps.blacklist?.blocked(p));
    if (listed) {
      log.info(`fell: ${key(listed)} is blacklisted; skipping it`);
      skipped.add(key(listed));
      continue;
    }
    const target = remaining[0];
    if (!target) break;
    const name = deps.blockAt(target)?.name;
    if (!allow(name)) {
      skipped.add(key(target));
      continue;
    }
    const s = deps.state();
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
    if (checkReach(eye, target, reach + 0.25).ok) {
      const r = await deps.dig(target, { tool: 'best', ...opts.dig });
      if (r.ok) {
        res.broken.push(target);
        res.ticksDigging += r.ticks ?? 0;
        continue;
      }
      if (r.reason === 'interrupted') return finish(false, 'interrupted');
      if (r.reason !== 'unreachable') {
        res.digFailures++;
        const n = (failsAt.get(key(target)) ?? 0) + 1;
        failsAt.set(key(target), n);
        log.info(`fell: dig ${key(target)} failed (${r.reason}), attempt ${n}`);
        if (n >= 3) {
          skipped.add(key(target));
          deps.blacklist?.failBlock(target, `dig failed: ${r.reason}`);
        }
        continue;
      }
    }
    // Re-path to a cell from which the log is in reach.
    const spots = standSpots(target, deps, { reach, radius: opts.standRadius ?? 4, from: s.pos, others: remaining });
    let moved = false;
    for (const spot of spots.slice(0, tries)) {
      res.repaths++;
      const g = await deps.goto({ type: 'block', p: spot.cell }, { timeoutTicks: opts.gotoTimeoutTicks ?? 600 });
      if (g.ok) {
        moved = true;
        break;
      }
      if (!g.ok && g.reason === 'interrupted') return finish(false, 'interrupted');
      log.info(`fell: re-path to ${key(spot.cell)} for ${key(target)} failed (${g.reason})`);
    }
    if (!moved) {
      log.info(`fell: no stand cell reaches ${key(target)} (${spots.length} candidates); skipping it`);
      skipped.add(key(target));
      if (deps.blacklist?.failBlock(target, 'no stand cell reached')) log.info(`fell: ${key(target)} is blacklisted now`);
    }
  }
  const left = remainingLogs(deps.blockAt, tree);
  return finish(left.length === 0, left.length ? 'logs_left' : undefined);
}
