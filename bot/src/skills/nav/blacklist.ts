// Failure blacklist (PLAN.md task 7.10, Baritone's "blacklist"): a goal, a member of an `any` goal,
// or an action cell (a block a dig failed on, a cell a pillar block could not be placed in, a door
// that did not open) that failed `failures` times (default 3) is skipped for `ticks` (default 6000,
// 5 minutes) and then forgotten. The Navigator consults it when planning (and reports what it
// skipped); the tree finder and the feller skip blacklisted logs, so a gather never loops on an
// unreachable log. See docs/pathfinding.md "Blacklist".
//
// Keys: `b:x,y,z` (the target block of a block / near / getToBlock goal), `xz:x,z`, `y:Y`, and for
// action cells `dig:x,y,z`, `place:x,y,z`, `use:x,y,z`. runAway and surface goals are never keyed.
import type { Vec3 } from '../../world/types.ts';
import type { NavGoal } from './goals.ts';
import { cellKey } from './grid.ts';

export type ActionKind = 'dig' | 'place' | 'use';

export interface BlacklistEntry {
  key: string;
  /** Failures counted (since the last success or expiry). */
  fails: number;
  /** Clock value (ticks) until which the key is skipped; undefined while below the threshold. */
  until: number | undefined;
  /** Clock value of the last failure. */
  last: number;
  /** Why it failed last (e.g. `unreachable`, `timeout`, `dig failed: ...`). */
  why: string | undefined;
}

export interface BlacklistOptions {
  /** Failures before a key is skipped. Default 3. */
  failures?: number;
  /** How long a blacklisted key is skipped, in clock ticks. Default 6000. */
  ticks?: number;
  /** The clock (ticks). Default: wall time / 50 ms. */
  now?: () => number;
}

const fl = Math.floor;
const k3 = (p: Vec3): string => `${fl(p.x)},${fl(p.y)},${fl(p.z)}`;

/** The blacklist key of a goal, or undefined (runAway, surface, any: its members are keyed one by one). */
export function goalKey(goal: NavGoal): string | undefined {
  switch (goal.type) {
    case 'block':
    case 'near':
    case 'getToBlock':
      return `b:${k3(goal.p)}`;
    case 'xz':
      return `xz:${fl(goal.x)},${fl(goal.z)}`;
    case 'yLevel':
      return `y:${fl(goal.y)}`;
    default:
      return undefined;
  }
}

/** Key of a block target (what the tree finder and the feller check). */
export const blockKey = (p: Vec3): string => `b:${k3(p)}`;
/** Key of an action cell. */
export const actionKey = (kind: ActionKind, p: Vec3): string => `${kind}:${k3(p)}`;

export class NavBlacklist {
  readonly failures: number;
  readonly ticks: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, BlacklistEntry>();

  constructor(opts: BlacklistOptions = {}) {
    this.failures = opts.failures ?? 3;
    this.ticks = opts.ticks ?? 6000;
    this.now = opts.now ?? (() => Date.now() / 50);
  }

  /** Count a failure. Returns true when this failure blacklisted the key. */
  fail(key: string, why?: string): boolean {
    const t = this.now();
    const e = this.live(key, t) ?? { key, fails: 0, until: undefined, last: t, why: undefined };
    e.fails++;
    e.last = t;
    e.why = why;
    this.entries.set(key, e);
    if (e.until === undefined && e.fails >= this.failures) {
      e.until = t + this.ticks;
      return true;
    }
    return false;
  }

  /** A success forgets the key's failures. */
  succeed(key: string): void {
    this.entries.delete(key);
  }

  /** The key is skipped now. */
  has(key: string): boolean {
    const e = this.live(key, this.now());
    return e?.until !== undefined;
  }

  /** The block target `p` is skipped now (tree finder, feller). */
  blocked(p: Vec3): boolean {
    return this.has(blockKey(p));
  }

  /** Count a failure for block target `p`. Returns true when it is blacklisted now. */
  failBlock(p: Vec3, why?: string): boolean {
    return this.fail(blockKey(p), why);
  }

  /** Failures counted for a key (0 when none or expired). */
  count(key: string): number {
    return this.live(key, this.now())?.fails ?? 0;
  }

  /** Number of keys skipped now. */
  get size(): number {
    return this.list().length;
  }

  /** Keys skipped now, with their failures. */
  list(): BlacklistEntry[] {
    const t = this.now();
    const out: BlacklistEntry[] = [];
    for (const k of [...this.entries.keys()]) {
      const e = this.live(k, t);
      if (e?.until !== undefined) out.push({ ...e });
    }
    return out;
  }

  /** cellKey()s of the blacklisted action cells of one kind (planner sets). */
  cells(kind: ActionKind): Set<number> {
    const out = new Set<number>();
    const prefix = `${kind}:`;
    for (const e of this.list()) {
      if (!e.key.startsWith(prefix)) continue;
      const [x, y, z] = e.key.slice(prefix.length).split(',').map(Number) as [number, number, number];
      out.add(cellKey(x, y, z));
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
  }

  /** The entry unless it expired (expired entries are dropped: the count starts again). */
  private live(key: string, t: number): BlacklistEntry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    const expired = e.until !== undefined ? t >= e.until : t - e.last >= this.ticks;
    if (expired) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }
}
