// Track AO (wave 9, docs/pve.md "Path-reachable targets", decision 0036): can the bot walk to a mob,
// and how far? The owner on the Realm: "It also gets stuck trying to fight mobs behind walls when on
// its way to places." The terrain rule of targeting.ts (`reachability`: the mob stands on a standable
// cell) says nothing about a path: a zombie behind a glass wall, a fence or a window passed it, the
// fight pre-empted the walk, and the approach failed `unreachable` again and again.
//
// Before guard commits to a mob that is not within reach, a bounded probe plan (Track AN's pattern,
// skills/home/reach.ts: 4 000 nodes, 300 ms, sliced on the main thread with a yield between slices,
// never digging or placing, no mob-avoidance cost) looks for a path from the bot's feet to a cell
// within PROBE_GOAL_R (1.5 blocks, 3D, cell centre to the mob's feet: the mob's own cell or a
// neighbour, never the far side of a 1-thick wall, which is 1.8 at the least) of the mob. Its length
// in blocks (`pathBlocks`) is the mob's walking distance.
//
// - One probe at a time; a verdict is cached per mob for CACHE_MS (5 s) and probed again when the mob
//   moved more than MOVED (3) blocks, or the bot did (the distance is from the bot's feet).
// - A start that is not standable (the bot in the air, in water) gives no verdict: tried again after
//   RETRY_MS.
// - `stats` counts the probes and their cost (docs/pve.md has the measured numbers).
import type { Logger } from '../../log.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import type { PathResult } from '../nav/astar.ts';
import type { NavGoal } from '../nav/goals.ts';
import { pathBlocks, probePath, PROBE_MS, PROBE_NODES, type ProbeNav } from '../home/reach.ts';
import { entityFeet } from './hostiles.ts';

/** A verdict is good this long (ms) ... */
export const CACHE_MS = 5000;
/** ... unless the mob (or the bot) moved more than this many blocks since. */
export const MOVED = 3;
/** No verdict (start not standable, no grid): ask again after this long (ms). */
export const RETRY_MS = 500;
/** The probe's goal: a cell centre this close (3D) to the mob's feet. */
export const PROBE_GOAL_R = 1.5;

export type PathVerdict =
  /** A path of `blocks` blocks to a cell next to the mob. */
  | { ok: true; blocks: number }
  /** No path within the probe's budget (`reason`: 'no path', 'no path within 4000 nodes', ...). */
  | { ok: false; reason: string };

interface Entry {
  /** When the verdict (or the failed attempt) was made (performance.now()). */
  at: number;
  /** The mob's feet and the bot's feet the verdict was made for. */
  mob: Vec3;
  from: Vec3;
  verdict: PathVerdict | undefined;
}

export interface PathReachDeps {
  /** The navigator (its grid and plan options); undefined = no probes (every lookup says 'none'). */
  nav: () => ProbeNav | undefined;
  log?: Logger;
  /** The probe (tests replace it). Default: reach.ts `probePath` with this file's budget. */
  probe?: (nav: ProbeNav, goal: NavGoal, from: Vec3) => Promise<PathResult | undefined>;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The probe's goal for a mob at `feet`. */
export function mobGoal(feet: Vec3): NavGoal {
  return { type: 'near', p: { x: feet.x, y: feet.y, z: feet.z }, r: PROBE_GOAL_R };
}

/** What a probe result says (no length limit here: the caller compares `blocks` with its own). */
export function pathVerdict(r: PathResult): PathVerdict {
  if (r.status === 'found') return { ok: true, blocks: pathBlocks(r.path) };
  if (r.status === 'none') return { ok: false, reason: 'no path' };
  if (r.limited) return { ok: false, reason: `no path within ${PROBE_NODES} nodes` };
  return { ok: false, reason: 'no path in the loaded world' };
}

export class PathReach {
  private readonly d: PathReachDeps;
  private readonly cache = new Map<bigint, Entry>();
  private busy: bigint | undefined;
  /** Probes run, their summed and largest search time (ms), nodes expanded, cache answers. */
  readonly stats = { probes: 0, ms: 0, maxMs: 0, expanded: 0, maxExpanded: 0, found: 0, failed: 0, cached: 0 };

  constructor(deps: PathReachDeps) {
    this.d = deps;
  }

  /** A probe is running. */
  get probing(): boolean {
    return this.busy !== undefined;
  }

  /**
   * The cached verdict for `e` seen from `me`, if it is fresh; otherwise a probe is started (when none
   * runs) and the answer is 'pending'. 'none' = no navigator to probe with.
   */
  lookup(e: EntityInfo, me: Vec3): PathVerdict | 'pending' | 'none' {
    const nav = this.d.nav();
    if (!nav) return 'none';
    const now = performance.now();
    const feet = entityFeet(e);
    const c = this.cache.get(e.runtimeId);
    if (c && this.fresh(c, feet, me, now)) {
      if (c.verdict) {
        this.stats.cached++;
        return c.verdict;
      }
      return 'pending'; // the last attempt had no standable start: wait RETRY_MS
    }
    if (this.busy === undefined) this.start(nav, e.runtimeId, feet, me);
    return 'pending';
  }

  /** The cached verdict without starting anything (status, tests). */
  peek(rid: bigint): PathVerdict | undefined {
    return this.cache.get(rid)?.verdict;
  }

  /** Forget a mob (dead, gone) or everything. */
  forget(rid?: bigint): void {
    if (rid === undefined) this.cache.clear();
    else this.cache.delete(rid);
  }

  /** Drop entries older than CACHE_MS (called now and then; the map stays small). */
  prune(): void {
    const now = performance.now();
    for (const [k, c] of this.cache) if (now - c.at > CACHE_MS) this.cache.delete(k);
  }

  private fresh(c: Entry, feet: Vec3, me: Vec3, now: number): boolean {
    const ttl = c.verdict ? CACHE_MS : RETRY_MS;
    return now - c.at < ttl && dist(c.mob, feet) <= MOVED && dist(c.from, me) <= MOVED;
  }

  private start(nav: ProbeNav, rid: bigint, feet: Vec3, me: Vec3): void {
    this.busy = rid;
    const from = { ...me };
    const mob = { ...feet };
    const probe = this.d.probe ?? ((n: ProbeNav, g: NavGoal, f: Vec3) => probePath(n, g, f, { nodes: PROBE_NODES, ms: PROBE_MS }));
    void probe(nav, mobGoal(mob), from)
      .then((r) => {
        let verdict: PathVerdict | undefined;
        if (r) {
          verdict = pathVerdict(r);
          this.stats.probes++;
          this.stats.ms += r.ms;
          this.stats.maxMs = Math.max(this.stats.maxMs, r.ms);
          this.stats.expanded += r.expanded;
          this.stats.maxExpanded = Math.max(this.stats.maxExpanded, r.expanded);
          if (verdict.ok) this.stats.found++;
          else this.stats.failed++;
          this.d.log?.debug(`guard: probe to #${rid}: ${verdict.ok ? `${verdict.blocks.toFixed(1)} blocks` : verdict.reason} (${r.expanded} nodes, ${r.ms.toFixed(1)} ms)`);
        }
        this.cache.set(rid, { at: performance.now(), mob, from, verdict });
      })
      .catch((err: unknown) => {
        this.d.log?.warn(`guard: probe to #${rid} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.cache.set(rid, { at: performance.now(), mob, from, verdict: undefined });
      })
      .finally(() => {
        this.busy = undefined;
      });
  }
}

/** The navigator behind a mover, as a probe needs it (`Navigator` has `grid` and `planOptions`); no mob-avoidance cost. */
export function probeNavOf(mover: { readonly nav: unknown } | undefined): ProbeNav | undefined {
  const n = mover?.nav as Partial<ProbeNav> | undefined;
  if (!n || typeof n.planOptions !== 'function' || !n.grid) return undefined;
  const grid = n.grid;
  const planOptions = n.planOptions.bind(n);
  return {
    grid,
    planOptions: (o) => {
      const opts = { ...planOptions(o) };
      delete opts.cellCost;
      return opts;
    },
  };
}
