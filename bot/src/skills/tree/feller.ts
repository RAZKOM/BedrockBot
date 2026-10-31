// Felling (PLAN.md task 4.3): break every log of a tree from the bottom up. When the next log is
// out of reach, re-path: walk to the best standable cell from which it is in reach (most remaining
// logs in reach, close to the tree, close to the bot). Trees up to 7 logs are fully reachable from the
// ground next to the trunk (docs/wood.md "Reach").
//
// Pillar-up (docs/wood.md "Pillar-up", decision 0051): when no stand cell reaches the next log and the bot
// carries throwaway blocks, it walks to the foot of a column next to (or under) the log, pillars up in it
// (the PlaceSkill: jump, place under the feet) until the log is in reach, digging leaves and the tree's own
// logs that are in the way of the head, and fells on from there, extending the pillar while the next log is
// above. Every placed cell is recorded (place/scaffold.ts); when the next log cannot be reached from the
// pillar and at the end, the bot digs its own pillar down block by block (a 1-block drop each time) and
// picks the blocks up on the way. Nothing is placed and no leaves are dug inside the protected area (the
// owner's protectRadius around home): a log only a pillar there reaches is skipped with that reason.
//
// Blacklist (task 7.10): a log no stand cell could be reached for, or that failed to dig 3 times,
// counts one failure on the navigator's blacklist (nav/blacklist.ts); a blacklisted log is skipped
// at once, so after 3 failed attempts a gather stops walking back to it (the tree finder skips it too).
import { silentLogger, type Logger } from '../../log.ts';
import type { Vec3 } from '../../world/types.ts';
import { checkReach, DEFAULT_REACH, EYE_HEIGHT } from '../dig/look.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import type { Goal } from '../nav/goals.ts';
import { clearScaffold, onScaffold as standsOnScaffold, pillarStep, ScaffoldRecord, type ClearOptions, type ClearResult } from '../place/scaffold.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { isLeaves, isLog, remainingLogs, type BlockLookup, type Tree } from './tree.ts';

export interface FellDeps {
  blockAt: BlockLookup;
  /** Feet position and the correction counter (InputLoop.state). */
  state: () => { pos: Vec3; corrections: number; onGround?: boolean; tick?: bigint };
  dig: (p: Vec3, opts?: DigOptions) => Promise<DigResult>;
  goto: (goal: Goal, opts?: GotoOptions) => Promise<SkillResult>;
  /** Feet height of a body standing in cell (x, y, z), NaN = blocked, undefined = unknown (NavGrid.stand). */
  stand: (x: number, y: number, z: number) => number | undefined;
  /** True once the operation was cancelled (BotSkills.cancel or a newer skill). */
  cancelled: () => boolean;
  logger?: Logger;
  /** The navigator's failure blacklist (logs the bot could not get to are skipped). */
  blacklist?: { blocked(p: Vec3): boolean; failBlock(p: Vec3, why?: string): boolean };
  /** Pillar-up: put a throwaway block into the feet cell (jump, place under the feet, land). Without it no pillar. */
  place?: (p: Vec3) => Promise<{ ok: boolean; reason?: string; block?: string }>;
  /** Throwaway blocks carried (the pillar's budget; none = no pillar, as before). */
  throwaways?: () => number;
  /** Inside the protected area (the base around home): nothing is placed there and no leaves are dug. */
  protectedAt?: (p: Vec3) => boolean;
  /** Wait n ticks (landing after a dug scaffold block). Needed for the pillar. */
  waitTicks?: (n: number) => Promise<void>;
  /** The pending scaffold (BotSkills.scaffold): outlives this call, so a cancelled fell's pillar is dug down by whoever moves the bot next. Default a fresh one. */
  scaffold?: ScaffoldRecord;
  /** A hostile mob within about 12 blocks: no pillar is started or grown, and a bot on its pillar comes down. */
  hostileNear?: () => boolean;
  /** Hold sneak while standing on scaffold (knockback, a correction do not push it off). */
  sneak?: (on: boolean) => void;
  /** Positions of log item drops near the tree (the canopy check before coming down). */
  drops?: () => Vec3[];
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
  /** Pillar up next to the trunk when no stand cell reaches a log (needs `place` and throwaway blocks). Default true. */
  pillar?: boolean;
  /** Highest pillar in blocks. Default 40. */
  maxScaffold?: number;
  /** Ticks for the whole fell at most once a pillar was needed (the rest is reported). Default 1200 + 60 per log. */
  maxTicks?: number;
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
  /** Pillars started (climbs from the ground). */
  pillars?: number;
  /** Scaffold blocks placed / dug again / left in the world (with why). */
  scaffoldPlaced?: number;
  scaffoldRemoved?: number;
  scaffoldLeft?: { p: Vec3; why: string }[];
  /** Leaves dug out of a pillar's way. */
  leavesDug?: number;
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

/** A pillar column next to (or under) a log: the feet cell at its foot and the feet height from which the log is in reach. */
export interface PillarSpot {
  /** Feet cell at the foot of the pillar (on the ground). */
  foot: Vec3;
  /** Feet y on top of the finished pillar (foot.y + blocks). */
  top: number;
  /** Blocks to place. */
  blocks: number;
  /** Leaves in the column that must be dug. */
  leaves: number;
  score: number;
}

export interface PillarContext {
  blockAt: BlockLookup;
  stand: FellDeps['stand'];
  protectedAt?: FellDeps['protectedAt'];
  /** Keys of the tree's logs ("x,y,z"): they may be dug out of the column. */
  treeLogs: ReadonlySet<string>;
  reach: number;
  /** Blocks at most (throwaway blocks carried, maxScaffold). */
  maxBlocks: number;
}

/** A cell the pillar may rise through: no collision box, leaves (dug unless protected) or a log of the tree (dug). */
function passable(ctx: PillarContext, p: Vec3): 'free' | 'leaves' | 'log' | undefined {
  const b = ctx.blockAt(p);
  if (!b || b.name === 'unknown') return undefined;
  if (ctx.treeLogs.has(key(p)) && isLog(b.name)) return 'log';
  if (b.boxes.length === 0) return 'free';
  if (isLeaves(b.name)) return 'leaves';
  return undefined;
}

/**
 * The pillar in column (x, z) from feet cell y = `foot` that brings `target` within reach: every cell from the
 * foot to 2 above the top feet must be passable (the jump's head room), none inside the protected area.
 */
export function planColumn(x: number, z: number, foot: number, target: Vec3, ctx: PillarContext): { top: number; blocks: number; leaves: number } | { why: string } {
  let top: number | undefined;
  for (let f = foot; f <= foot + ctx.maxBlocks; f++) {
    // the body stays below a log in its own column
    if (x === target.x && z === target.z && f + 2 > target.y) break;
    if (checkReach({ x: x + 0.5, y: f + EYE_HEIGHT, z: z + 0.5 }, target, ctx.reach).ok) {
      top = f;
      break;
    }
  }
  if (top === undefined) return { why: ctx.maxBlocks <= 0 ? 'no throwaway blocks' : `out of reach within ${ctx.maxBlocks} blocks` };
  let leaves = 0;
  for (let y = foot; y <= top + 2; y++) {
    const c = { x, y, z };
    if (ctx.protectedAt?.(c)) return { why: 'inside the protected area (no scaffold in the base)' };
    const k = passable(ctx, c);
    if (!k) return { why: `blocked at ${key(c)} (${ctx.blockAt(c)?.name ?? 'unloaded'})` };
    if (k === 'leaves') leaves++;
  }
  return { top, blocks: top - foot, leaves };
}

/**
 * Pillar columns within 2 blocks (horizontally) of `target`, best first: the ground under each column, the
 * blocks to place (at most `maxBlocks`), leaves to dig, logs reachable from the top, the walk there.
 */
export function pillarSpots(target: Vec3, ctx: PillarContext, opts: { from: Vec3; others: readonly Vec3[] }): { spots: PillarSpot[]; why: string[] } {
  const spots: PillarSpot[] = [];
  const why = new Set<string>();
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const x = target.x + dx;
      const z = target.z + dz;
      // the ground: the first cell down from the log's height that is not passable
      let foot: number | undefined;
      for (let y = target.y + 1; y > target.y - 64; y--) {
        if (!passable(ctx, { x, y, z })) {
          foot = y + 1;
          break;
        }
      }
      if (foot === undefined || foot > target.y) continue;
      const feet = ctx.stand(x, foot, z);
      if (feet === undefined || Number.isNaN(feet) || Math.abs(feet - foot) > 1e-6) continue;
      // walk in: feet and head cells free (no leaves or logs to dig on the ground)
      if (ctx.blockAt({ x, y: foot, z })?.boxes.length !== 0 || ctx.blockAt({ x, y: foot + 1, z })?.boxes.length !== 0) continue;
      const c = planColumn(x, z, foot, target, ctx);
      if ('why' in c) {
        why.add(c.why);
        continue;
      }
      if (c.blocks <= 0) continue; // the ground reaches it: a stand cell, not a pillar
      const eye = { x: x + 0.5, y: c.top + EYE_HEIGHT, z: z + 0.5 };
      const reachable = opts.others.filter((o) => checkReach(eye, o, ctx.reach).ok).length;
      const walk = Math.hypot(x + 0.5 - opts.from.x, foot - opts.from.y, z + 0.5 - opts.from.z);
      const score = c.blocks + 0.5 * c.leaves - 2 * reachable + 0.1 * walk;
      spots.push({ foot: { x, y: foot, z }, top: c.top, blocks: c.blocks, leaves: c.leaves, score });
    }
  }
  if (spots.length === 0 && why.size === 0) why.add('no ground next to it');
  return { spots: spots.sort((a, b) => a.score - b.score), why: [...why] };
}

export async function fellTree(tree: Tree, deps: FellDeps, opts: FellOptions = {}): Promise<FellResult> {
  const log = deps.logger ?? silentLogger;
  const reach = opts.reach ?? DEFAULT_REACH - 0.25;
  const tries = opts.repathTries ?? 4;
  const allow = (name: string | undefined) => isLog(name) || (!!name && !!opts.allowDig?.(name));
  const c0 = deps.state().corrections;
  const res: FellResult = { ok: false, broken: [], left: [], repaths: 0, digFailures: 0, corrections: 0, ticksDigging: 0, pillars: 0, scaffoldPlaced: 0, scaffoldRemoved: 0, scaffoldLeft: [], leavesDug: 0 };
  const skipped = new Set<string>();
  const failsAt = new Map<string, number>();
  const pillarTries = new Map<string, number>();
  const scaffold = deps.scaffold ?? new ScaffoldRecord();
  const t0 = deps.state().tick;
  const maxTicks = opts.maxTicks ?? 1200 + 60 * tree.logs.length;
  const overTime = () => t0 !== undefined && deps.state().tick !== undefined && Number(deps.state().tick! - t0) > maxTicks;
  const sneakReach = 0.35; // the sneaking eye is lower: plan with less reach on the pillar
  const treeLogs = new Set(tree.logs.map(key));
  const waitTicks = deps.waitTicks;
  const place = deps.place;
  const canPillar = (opts.pillar ?? true) && !!place && !!waitTicks;
  const maxScaffold = opts.maxScaffold ?? 40;
  const ctx = (): PillarContext => ({
    blockAt: deps.blockAt,
    stand: deps.stand,
    ...(deps.protectedAt ? { protectedAt: deps.protectedAt } : {}),
    treeLogs,
    reach,
    maxBlocks: Math.max(0, Math.min(maxScaffold - scaffold.size, deps.throwaways?.() ?? 0)),
  });
  const feetCell = (): Vec3 => {
    const p = deps.state().pos;
    return { x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) };
  };
  const onScaffold = (): boolean => standsOnScaffold(scaffold, deps);
  /** Dig the pillar down (every recorded block that is still there), back on the ground. */
  const comeDown = async (copts: ClearOptions = {}): Promise<ClearResult | undefined> => {
    if (scaffold.size === 0 || !waitTicks) return undefined;
    const c = await clearScaffold(scaffold, {
      blockAt: deps.blockAt,
      state: deps.state,
      dig: (p) => deps.dig(p, { tool: 'best' }),
      goto: deps.goto,
      waitTicks,
      ...(place ? { place } : {}),
      ...(deps.throwaways ? { throwaways: deps.throwaways } : {}),
      ...(deps.sneak ? { sneak: deps.sneak } : {}),
      cancelled: deps.cancelled,
      logger: log,
    }, copts);
    res.scaffoldRemoved! += c.removed.length;
    res.scaffoldLeft!.push(...c.left.filter((l) => l.why !== 'interrupted' && l.why !== 'not reached'));
    return c;
  };
  /**
   * Before leaving the pillar: a log drop that bounced onto the canopy (it rests on leaves, out of any later walk's
   * reach) gets the leaf under it dug, so it falls to the ground (2026-10-30 e2e: 1 of 20 spruce logs stayed on the
   * leaves for 90 s). At most 6 leaves, in reach of the sneaking eye, never inside the protected area.
   */
  const dropStuckLogs = async (): Promise<void> => {
    if (!deps.drops || !onScaffold()) return;
    let dug = 0;
    for (const p of deps.drops()) {
      if (dug >= 6 || deps.cancelled()) break;
      const leaf = { x: Math.floor(p.x), y: Math.floor(p.y - 0.5), z: Math.floor(p.z) };
      if (!isLeaves(deps.blockAt(leaf)?.name) || deps.protectedAt?.(leaf)) continue;
      const s = deps.state().pos;
      if (!checkReach({ x: s.x, y: s.y + EYE_HEIGHT - sneakReach, z: s.z }, leaf, reach).ok) continue;
      const r = await deps.dig(leaf, { tool: 'best' });
      if (r.ok) {
        dug++;
        res.leavesDug!++;
      }
    }
    if (dug > 0) {
      log.info(`fell: dug ${dug} leaf block(s) under log drops on the canopy`);
      await waitTicks?.(10);
    }
  };
  /** Clear the head room of the next jump (2 and 3 above the feet): leaves and the tree's own logs, nothing else. */
  const headRoom = async (): Promise<boolean> => {
    const f = feetCell();
    for (const dy of [2, 3]) {
      const c = { x: f.x, y: f.y + dy, z: f.z };
      const b = deps.blockAt(c);
      if (!b || b.boxes.length === 0) continue;
      const treeLog = treeLogs.has(key(c)) && isLog(b.name);
      if (!treeLog && !(isLeaves(b.name) && !deps.protectedAt?.(c))) return false;
      const r = await deps.dig(c, { tool: 'best', ...(treeLog ? opts.dig : {}) });
      if (!r.ok) return false;
      if (treeLog) {
        res.broken.push(c);
        res.ticksDigging += r.ticks ?? 0;
      } else res.leavesDug!++;
    }
    return true;
  };
  /** Pillar up in the current column until the feet are at `top`. */
  const climb = async (top: number): Promise<'ok' | 'failed' | 'interrupted' | 'hostile'> => {
    let fails = 0;
    while (feetCell().y < top) {
      if (deps.cancelled()) return 'interrupted';
      if (deps.hostileNear?.()) return 'hostile';
      if ((deps.throwaways?.() ?? 0) <= 0 || scaffold.size >= maxScaffold) return 'failed';
      if (!(await headRoom())) {
        log.info(`fell: no head room to pillar at ${key(feetCell())}`);
        return 'failed';
      }
      if (deps.cancelled()) return 'interrupted';
      const r = await pillarStep(scaffold, { blockAt: deps.blockAt, state: deps.state, place: place!, waitTicks: waitTicks! });
      if (r.ok) {
        res.scaffoldPlaced!++;
        deps.sneak?.(true);
        continue;
      }
      if (r.reason === 'interrupted') return 'interrupted';
      log.info(`fell: pillar block at ${key(feetCell())} failed (${r.reason})`);
      if (++fails >= 3) return 'failed';
      await waitTicks!(4);
    }
    return 'ok';
  };
  const finish = (ok: boolean, reason?: string): FellResult => {
    res.ok = ok;
    if (reason) res.reason = reason;
    res.left = remainingLogs(deps.blockAt, tree);
    res.corrections = deps.state().corrections - c0;
    for (const c of scaffold.cells) if (!res.scaffoldLeft!.some((l) => key(l.p) === key(c.p))) res.scaffoldLeft!.push({ p: c.p, why: reason ?? 'not cleared' });
    const pil = res.pillars ? `, ${res.pillars} pillar(s): ${res.scaffoldPlaced} block(s) placed, ${res.scaffoldRemoved} dug again, ${res.scaffoldLeft!.length} left, ${res.leavesDug} leaves dug` : '';
    log.info(`fell ${tree.kind} tree at ${key(tree.base)}: ${res.broken.length}/${tree.logs.length} logs, ${res.left.length} left, ${res.repaths} re-path(s)${pil}, ${res.digFailures} dig failure(s), ${res.corrections} correction(s)${reason ? ` (${reason})` : ''}`);
    return res;
  };

  // a pillar left by an earlier fell (cancelled, a death): dig it down first
  if (scaffold.size > 0 && waitTicks) {
    const d = await comeDown();
    if (d?.interrupted) return finish(false, 'interrupted');
  }
  for (let iter = 0; iter < 8 * tree.logs.length + 16; iter++) {
    if (deps.cancelled()) return finish(false, 'interrupted');
    if (res.pillars && overTime()) {
      log.warn(`fell: over ${maxTicks} ticks; stopping`);
      const d = await comeDown();
      if (d?.interrupted) return finish(false, 'interrupted');
      return finish(false, 'time_cap');
    }
    if (onScaffold() && deps.hostileNear?.()) {
      // down to the last block (a fall of 1 is harmless; its hits spoil every dig at the foot): the rest stays
      // pending and the next fell (or cancel / goto) digs it
      log.warn('fell: a hostile mob is near; coming down from the pillar');
      const d = await comeDown({ downOnly: true, lowEnough: 1 });
      if (d?.interrupted) return finish(false, 'interrupted');
      return finish(false, 'hostile_near');
    }
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
    const up = onScaffold();
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT - (up ? sneakReach : 0), z: s.pos.z };
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
    // On the pillar: extend it while the log is in reach of this column, else come down first (never walk off it).
    if (up) {
      const f = feetCell();
      const c = planColumn(f.x, f.z, f.y, target, { ...ctx(), reach: reach - sneakReach });
      if (!('why' in c) && c.blocks > 0 && (pillarTries.get(key(target)) ?? 0) < 2) {
        pillarTries.set(key(target), (pillarTries.get(key(target)) ?? 0) + 1);
        const r = await climb(c.top);
        if (r === 'interrupted') return finish(false, 'interrupted');
        if (r === 'ok' || r === 'hostile') continue; // hostile: the loop top comes down
      }
      await dropStuckLogs();
      const d = await comeDown();
      if (d?.interrupted) return finish(false, 'interrupted');
      if (onScaffold()) break; // could not come down: stop (what is left is reported)
      continue;
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
    // Pillar up next to it (twice per log at most).
    let why = `no stand cell reaches it (${spots.length} candidates)`;
    if (!moved && canPillar && deps.hostileNear?.()) {
      log.info(`fell: ${key(target)}: no pillar with a hostile mob near`);
      return finish(false, 'hostile_near');
    }
    if (!moved && canPillar && (pillarTries.get(key(target)) ?? 0) < 2) {
      pillarTries.set(key(target), (pillarTries.get(key(target)) ?? 0) + 1);
      const c = { ...ctx(), reach: reach - sneakReach };
      const p = pillarSpots(target, c, { from: s.pos, others: remaining });
      if (p.spots.length === 0) why += `; no pillar: ${p.why.join('; ')}`;
      for (const spot of p.spots.slice(0, 2)) {
        res.repaths++;
        const g = await deps.goto({ type: 'block', p: spot.foot }, { timeoutTicks: opts.gotoTimeoutTicks ?? 600 });
        if (!g.ok && g.reason === 'interrupted') return finish(false, 'interrupted');
        const f = feetCell();
        if (!g.ok || f.x !== spot.foot.x || f.z !== spot.foot.z || f.y !== spot.foot.y) {
          why += `; walk to the pillar foot ${key(spot.foot)} failed`;
          log.info(`fell: walk to the pillar foot ${key(spot.foot)} for ${key(target)} failed (${g.ok ? `at ${key(f)}` : g.reason})`);
          continue;
        }
        res.pillars!++;
        log.info(`fell: pillar of ${spot.blocks} block(s) at ${key(spot.foot)} for ${key(target)} (${spot.leaves} leaves in the way)`);
        const r = await climb(spot.top);
        if (r === 'interrupted') return finish(false, 'interrupted');
        if (r === 'ok' || r === 'hostile') {
          moved = true; // hostile: the loop top comes down
          break;
        }
        why += '; the pillar stopped';
        const d = await comeDown();
        if (d?.interrupted) return finish(false, 'interrupted');
      }
    } else if (!moved && canPillar && (deps.throwaways?.() ?? 0) <= 0) why += '; no throwaway blocks for a pillar';
    if (!moved) {
      log.info(`fell: ${key(target)}: ${why}; skipping it`);
      skipped.add(key(target));
      if (deps.blacklist?.failBlock(target, 'no stand cell reached')) log.info(`fell: ${key(target)} is blacklisted now`);
    }
  }
  if (scaffold.size > 0) {
    await dropStuckLogs();
    const d = await comeDown();
    if (d?.interrupted) return finish(false, 'interrupted');
  }
  const left = remainingLogs(deps.blockAt, tree);
  return finish(left.length === 0, left.length ? 'logs_left' : undefined);
}
