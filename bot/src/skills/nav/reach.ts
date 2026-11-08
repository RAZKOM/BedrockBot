// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): why a goto is unreachable.
// A `!goto` says "unreachable" only with its cause, one of four classes:
//
//   (a) world     the world closes the way: no walk, swim or dig gets there even with every owner's rule lifted
//   (b) rule      an owner's rule closes it, named: lifted alone (or with others, named too) the way opens
//   (c) unloaded  the goal is in unloaded world (the body walks towards it and plans again as it loads)
//   (d) budget    the search ran out of nodes or time before it could tell: a bug the bench (scripts/reach-bench.ts) hunts
//
// The navigator (nav/navigator.ts `explain`) runs the "why" searches when a goto with `explain` (the `!goto` command) is
// about to give up: one with every rule lifted first (none found: the world; cut by its budget: the budget); then the
// rules its path needed (`rulesOnPath`): one rule alone is the answer; several are tried alone each, the first that
// opens the way is named, none alone: all of them, joined. The searches only explain: no plan they find is walked.
//
// The rules (the bench oracle's names, nav/bench/oracle.ts RuleName):
//   protected_area  nothing is dug inside the base sphere (home, `protectRadius`)
//   built           a player's built block is never broken; the dig way digs natural terrain only
//   liquid          nothing with water or lava beside it is dug
//   gravity         nothing under a gravity block or beside an unsupported one is dug
//   falls           no fall leaves less than `fallMargin` HP
//   dig_budget      at most DIG_WAY_MAX_BLOCKS blocks a goto, none slower than DIG_WAY_MAX_TICKS
//   place           a goto never places a block (no pillar, no bridge)
import { fallDamage } from '../fall/damage.ts';
import { isNaturalTerrain } from '../place/scaffold.ts';
import { isBuiltBlock } from '../terrain/classify.ts';
import type { PathNode, PathOptions, PathRelax } from './astar.ts';
import { DIG_WAY_MAX_BLOCKS, DIG_WAY_MAX_TICKS } from './digway.ts';
import { isUnbreakable } from './baritone/helper.ts';
import { cellKey, type NavGrid } from './grid.ts';

export type ReachRule = 'protected_area' | 'built' | 'liquid' | 'gravity' | 'falls' | 'dig_budget' | 'place';
export const REACH_RULES: readonly ReachRule[] = ['protected_area', 'built', 'liquid', 'gravity', 'falls', 'dig_budget', 'place'];
export type ReachClass = 'world' | 'rule' | 'unloaded' | 'budget';

export interface ReachCause {
  cls: ReachClass;
  /** (b): the rules named (one, or several that only open the way together). */
  rules: ReachRule[];
}

/** The heuristic's weight in a "why" search (weighted A*: is there a way at all, found fast, not the best one). */
export const EXPLAIN_WEIGHT = 8;
/** Blocks a "why" search may dig with `dig_budget` lifted (no limit in practice). */
export const RELAXED_DIG_BLOCKS = 4096;
/** Throwaway blocks a "why" search pretends to carry with `place` lifted. */
export const RELAXED_THROWAWAY = 64;

/** What the relaxed options need from the body. */
export interface RelaxContext {
  /** Health + absorption now (undefined: 20). `falls` lifted: a fall may cost all but 1 HP. */
  hp?: number;
  /** Blocks the goto's dig way dug so far. */
  dug: number;
}

/**
 * The owner's options with `rules` lifted. `base` is the last level's options (the dig way and the falls that hurt
 * as the levels allow); every "why" search digs (the dig way's budget unless `dig_budget` is lifted).
 */
export function relaxOptions(base: PathOptions, rules: readonly ReachRule[], ctx: RelaxContext): PathOptions {
  // (whether a way exists, not how good it is: digs and placed blocks cost their time only, the heuristic weighted)
  const o: PathOptions = { ...base, allowBreak: true, digWay: { left: Math.max(0, base.digWay?.left ?? (base.allowBreak ? RELAXED_DIG_BLOCKS : 0)) }, costs: { ...base.costs, dig: 0 } };
  const relax: PathRelax = { ...base.relax, weight: EXPLAIN_WEIGHT };
  for (const r of rules) {
    switch (r) {
      case 'protected_area':
        delete o.protectedArea;
        break;
      case 'built':
        relax.built = true;
        break;
      case 'liquid':
        relax.liquid = true;
        break;
      case 'gravity':
        relax.gravity = true;
        break;
      case 'falls':
        if (o.falls) {
          const { blocked: _b, ...p } = o.falls;
          o.falls = { ...p, hpBudget: Math.max(p.hpBudget, (ctx.hp ?? 20) - 1) };
        }
        break;
      case 'dig_budget':
        o.digWay = { left: RELAXED_DIG_BLOCKS };
        relax.slow = true;
        break;
      case 'place':
        o.allowPlace = true;
        o.throwaway = Math.max(o.throwaway ?? 0, RELAXED_THROWAWAY);
        break;
    }
  }
  o.relax = relax;
  return o;
}

const SIDES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const NEIGHBOURS: readonly (readonly [number, number, number])[] = [...SIDES.map(([dx, dz]) => [dx, 0, dz] as const), [0, 1, 0], [0, -1, 0]];

/**
 * The owner's rules a path found with every rule lifted breaks, read off the path against `owner` (the options the
 * goto planned with): its placed blocks (place), its falls that cost more than the owner's budget (falls), the cells
 * it digs (built, protected_area, liquid, gravity, a slow block or more than the dig way's budget: dig_budget).
 */
export function rulesOnPath(grid: NavGrid, path: readonly PathNode[], owner: PathOptions): ReachRule[] {
  const used = new Set<ReachRule>();
  const budget = owner.falls?.blocked ? 0 : (owner.falls?.hpBudget ?? 0);
  const left = owner.digWay?.left ?? DIG_WAY_MAX_BLOCKS;
  const ticks = owner.breakTicks;
  const area = owner.protectedArea;
  let dug = 0;
  for (let i = 1; i < path.length; i++) {
    const n = path[i]!;
    const prev = path[i - 1]!;
    if (n.act?.place || n.move === 'pillar') used.add('place');
    const fall = prev.feet - n.feet;
    if (fall > 3 + 1e-6 && grid.cls(n.x, n.y, n.z)?.liquid !== 'water') {
      const floor = grid.cls(n.x, Math.floor(n.feet - 1e-6), n.z);
      const dmg = fallDamage(fall, floor?.name, owner.falls?.factor ?? 1);
      if (dmg > budget + 1e-9) used.add('falls');
    }
    for (const d of n.act?.dig ?? []) {
      const c = grid.cls(d.x, d.y, d.z);
      if (!c || (c.boxes.length === 0 && !c.liquid)) continue;
      dug++;
      const slow = ticks !== undefined && ticks(c) > DIG_WAY_MAX_TICKS;
      if (c.protect && isBuiltBlock(c.name)) used.add('built');
      else if (!isNaturalTerrain(c.name)) used.add(slow ? 'dig_budget' : 'built'); // obsidian: natural to the eye, slow to the dig way
      else if (slow) used.add('dig_budget');
      if (area && Math.hypot(d.x + 0.5 - area.x, d.y + 0.5 - area.y, d.z + 0.5 - area.z) <= area.r) used.add('protected_area');
      for (const [dx, dy, dz] of NEIGHBOURS) if (grid.cls(d.x + dx, d.y + dy, d.z + dz)?.liquid) used.add('liquid');
      if (gravityRefuses(grid, d.x, d.y, d.z)) used.add('gravity');
    }
  }
  if (dug > left) used.add('dig_budget');
  return REACH_RULES.filter((r) => used.has(r));
}

function gravityRefuses(grid: NavGrid, x: number, y: number, z: number): boolean {
  if (grid.cls(x, y + 1, z)?.gravity) return true;
  for (const [dx, dz] of SIDES) {
    if (!grid.cls(x + dx, y, z + dz)?.gravity) continue;
    const under = grid.cls(x + dx, y - 1, z + dz);
    if (under?.boxes.length === 0) return true;
  }
  return false;
}

/** Cells `sealedPocket` floods at most before it says "not sealed". */
export const SEALED_MAX_CELLS = 20_000;

/**
 * (a) at a glance: the goal's cell lies in a pocket the world seals: a flood from it through every cell a body could
 * ever open (air, water, anything breakable) stops at unbreakable blocks (bedrock, barriers) and lava within
 * SEALED_MAX_CELLS cells, touches no unloaded cell and does not hold `start`. No search with any rule lifted gets in
 * (nor out: the pocket is closed both ways). False whenever it cannot tell.
 */
export function sealedPocket(grid: NavGrid, goal: { x: number; y: number; z: number }, start: { x: number; y: number; z: number }, maxCells = SEALED_MAX_CELLS): boolean {
  const minY = grid.source.minY ?? -64;
  const maxY = grid.source.maxY ?? 320;
  const seen = new Set<number>();
  const queue: number[] = [goal.x, goal.y, goal.z];
  seen.add(cellKey(goal.x, goal.y, goal.z));
  const startKey = cellKey(start.x, start.y, start.z);
  for (let q = 0; q < queue.length; q += 3) {
    const x = queue[q]!;
    const y = queue[q + 1]!;
    const z = queue[q + 2]!;
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (ny < minY || ny >= maxY) continue;
      const k = cellKey(nx, ny, nz);
      if (seen.has(k)) continue;
      const c = grid.cls(nx, ny, nz);
      if (!c) return false; // unloaded: cannot tell
      if (c.liquid === 'lava' || (c.boxes.length > 0 && !c.liquid && isUnbreakable(c))) continue;
      if (k === startKey || seen.size >= maxCells) return false;
      seen.add(k);
      queue.push(nx, ny, nz);
    }
  }
  return true;
}

/** What each rule forbids, in a few words (the `!goto` reply names it). */
export const RULE_WORDS: Readonly<Record<ReachRule, string>> = {
  protected_area: 'no digging in the base (protectRadius)',
  built: 'no breaking built blocks',
  liquid: 'no digging beside water or lava',
  gravity: 'no digging under sand or gravel',
  falls: 'no fall below fallMargin',
  dig_budget: `at most ${DIG_WAY_MAX_BLOCKS} dug blocks a goto, none slow`,
  place: 'a goto places no blocks',
};

/** The cause as a tag (SkillResult `cause`): `world`, `rule:<rule>[+<rule>...]`, `unloaded`, `budget`. */
export function causeTag(c: ReachCause): string {
  return c.cls === 'rule' ? `rule:${c.rules.join('+')}` : c.cls;
}

/** The cause in words, for the `!goto` reply (`goto: unreachable (<this>)`). Short: well under the 480-byte wire limit. */
export function causeWords(c: ReachCause): string {
  switch (c.cls) {
    case 'world':
      return 'world: no walk, swim or dig gets there';
    case 'unloaded':
      return 'unloaded: the goal is in unloaded world, walk closer';
    case 'budget':
      return 'budget: the searches or the walk ran out before the goal';
    case 'rule':
      return `rule ${c.rules.join(' + ')}: ${c.rules.map((r) => RULE_WORDS[r]).join('; ')}`;
  }
}
