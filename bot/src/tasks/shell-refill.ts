// The shell's blocks as processes (Track E7, docs/early-game.md "The shell's blocks", ADR 0104), with `shellBlocks` on:
//   - `blocks` (a user process, priority 40: the flee, a guard fight and the night rule pre-empt it, a resume digs what
//     is still short): the dig of skills/survival/shell-blocks.ts for the obtain job (before dusk, after a death it goes
//     on from, at its end);
//   - `blockschore` (auto, the chores' priority): the same dig by day when nothing else runs and the reserve is short:
//     after a respawn (before the walk home, which is lower), the morning after a death in the night.
// Inside the base (the break rules' protected area round home) nothing is dug: the dig walks out of it first. Nor
// within REFILL_KEEP of the night rule's shelter (the shell's own ground).
import type { Vec3 } from '../connection/types.ts';
import type { Logger } from '../log.ts';
import { canHarvestCarried } from '../skills/craft/table-spot.ts';
import { baseExits } from '../skills/mine/branch.ts';
import { refillBlocks, type RefillDeps, type RefillResult } from '../skills/survival/shell-blocks.ts';
import { isBuiltBlock } from '../skills/terrain/classify.ts';
import type { BlockInfo, ItemStack } from '../world/types.ts';
import { BaseProcess, PRIORITY, type Process, type ProcessManager, type ProcessStatus } from './process/manager.ts';
import { WorkProcess } from './process/recover.ts';

/** Ways out of the base tried by one refill. */
export const REFILL_EXITS = 3;
/**
 * Nothing is dug within this many blocks (level, each axis) of the night rule's shelter: the shell's cells need their
 * floor (measured on the test server: a hole dug beside the shelter left 2 of the shell's cells open that night).
 */
export const REFILL_KEEP = 4;

export interface RefillHost {
  blockAt(p: Vec3): BlockInfo | undefined;
  position(): Vec3;
  slots(): readonly (ItemStack | null | undefined)[];
  /** The slots a dig may use (the worn-tool rule's: skills/items/wear.ts usableSlots); default slots(). */
  usable?(): readonly (ItemStack | null | undefined)[];
  /** The base (the break rules' protected area round home), never dug. */
  base(): { x: number; y: number; z: number; r: number } | undefined;
  /** Points whose ground stays as it is within REFILL_KEEP (the night rule's shelter, where the shell stands). */
  keep?(): (Vec3 | undefined)[];
  goto(p: Vec3, r: number): Promise<{ ok: boolean; reason?: string }>;
  /** Walk to a column (the way out of the base). */
  gotoColumn?(x: number, z: number): Promise<{ ok: boolean; reason?: string }>;
  dig(p: Vec3): Promise<{ ok: boolean; reason?: string }>;
  collect(at: Vec3): Promise<unknown>;
  log?: Logger;
}

/** The refill's ports from the walk's own pieces (the base and built blocks are never dug). */
export function refillDeps(h: RefillHost): RefillDeps {
  const inBase = (p: Vec3): boolean => {
    const b = h.base();
    return !!b && Math.hypot(p.x + 0.5 - b.x, p.y + 0.5 - b.y, p.z + 0.5 - b.z) <= b.r;
  };
  return {
    blockAt: (p) => h.blockAt(p),
    allowed: (p) => {
      if (inBase(p)) return false;
      for (const q of h.keep?.() ?? []) if (q && Math.max(Math.abs(p.x - Math.floor(q.x)), Math.abs(p.z - Math.floor(q.z))) <= REFILL_KEEP) return false;
      const n = h.blockAt(p)?.name;
      return !(n && isBuiltBlock(n));
    },
    harvests: (n) => canHarvestCarried(h.usable?.() ?? h.slots(), n),
    position: () => h.position(),
    slots: () => h.slots(),
    goto: (p, r) => h.goto(p, r),
    dig: (p) => h.dig(p),
    collect: (at) => h.collect(at),
    // out of the base by the mine's own ways out (skills/mine/branch.ts baseExits: the line away from home first)
    leaveBase: async () => {
      const b = h.base();
      if (!b || !h.gotoColumn) return false;
      const me = h.position();
      const feet = { x: Math.floor(me.x), y: Math.floor(me.y + 1e-3), z: Math.floor(me.z) };
      const exits = baseExits(feet, { x: b.x, z: b.z, r: b.r }).slice(0, REFILL_EXITS);
      for (const e of exits) {
        h.log?.info(`blocks: inside the base (${b.r} round home): walking out to ${e.x} ${e.z} before digging`);
        const r = await h.gotoColumn(e.x, e.z);
        if (r.ok) return true;
        if (r.reason === 'interrupted' || r.reason === 'cancelled') return false;
      }
      return false;
    },
  };
}

/** Start the dig as the `blocks` user process: until `need` shell blocks are carried. */
export function startRefill(processes: Pick<ProcessManager, 'add'>, deps: RefillDeps, need: number, cancel: () => void, log?: Logger): { process: Process; result: Promise<RefillResult | undefined> } {
  const p = processes.add(
    new WorkProcess(
      'blocks',
      `digging blocks for the night shell (${need} wanted)`,
      async (cancelled) => {
        const r = await refillBlocks(deps, need, cancelled);
        log?.info(`blocks: ${r.before} -> ${r.after} shell blocks, ${r.dug} dug${r.left ? ', outside the base' : ''}${r.reason ? ` (${r.reason})` : ''}`);
        return r;
      },
      cancel,
    ),
  );
  return { process: p, result: p.result };
}

/** The chore looks this often (ms). */
export const BLOCKS_CHECK_MS = 2000;
/** After a refill that ended short the chore waits this long (ms): no ground near, a walk that failed. */
export const BLOCKS_BACKOFF_MS = 5 * 60_000;

export interface BlocksChoreDeps {
  /** The `shellBlocks` setting. */
  enabled(): boolean;
  /** Blocks the shell is short of now. */
  short(): number;
  /** The chores' day (not from just before dusk to dawn). */
  isDay(): boolean;
  /** A hostile near: the chore waits. */
  threat(): boolean;
  /** Something else has the bot (a user process, an obtain job, a respawn another rule claimed). */
  busy(): boolean;
  refill(cancelled: () => boolean): Promise<RefillResult>;
  cancel(): void;
  now?: () => number;
  log?: Logger;
}

/**
 * The blocks chore (auto, PRIORITY.chore): by day, with nothing else running and no hostile near, a bot short of the
 * shell's blocks digs them. It is what gets them back after a death (the respawn's walk home is lower and goes on after
 * it; a death in the night is made good in the morning). A refill that ends short waits BLOCKS_BACKOFF_MS.
 */
export class BlocksChore extends BaseProcess {
  readonly kind = 'auto' as const;
  readonly name = 'blockschore';
  private readonly d: BlocksChoreDeps;
  private readonly now: () => number;
  private running = false;
  private lastCheck = -Infinity;
  nextTry = -Infinity;
  readonly stats = { started: 0, filled: 0, short: 0 };
  last: RefillResult | undefined;

  constructor(d: BlocksChoreDeps) {
    super();
    this.d = d;
    this.persistent = true;
    this.now = d.now ?? (() => performance.now());
  }

  get priority(): number {
    return PRIORITY.chore;
  }

  override wants(): boolean {
    const d = this.d;
    if (this.running) return d.enabled() && d.isDay() && !d.threat();
    const now = this.now();
    if (now - this.lastCheck < BLOCKS_CHECK_MS || now < this.nextTry) return false;
    this.lastCheck = now;
    if (!d.enabled() || !d.isDay() || d.busy() || d.threat() || d.short() <= 0) return false;
    this.running = true;
    this.stats.started++;
    d.log?.info(`blocks chore: the night shell is ${d.short()} blocks short: digging`);
    return true;
  }

  protected run(t: number): void {
    if (!this.running) return;
    void this.d.refill(() => t !== this.token).then(
      (r) => {
        if (t !== this.token || r.reason === 'cancelled') return;
        this.end(r);
      },
      (e: unknown) => {
        this.d.log?.warn(`blocks chore: ${e instanceof Error ? e.message : String(e)}`);
        if (t === this.token) this.end(undefined);
      },
    );
  }

  private end(r: RefillResult | undefined): void {
    this.running = false;
    this.last = r;
    const left = this.d.short();
    if (left > 0) {
      this.stats.short++;
      this.nextTry = this.now() + BLOCKS_BACKOFF_MS;
    } else this.stats.filled++;
    this.d.log?.info(`blocks chore: ${r ? `${r.before} -> ${r.after} shell blocks, ${r.dug} dug${r.left ? ', outside the base' : ''}${r.reason ? ` (${r.reason})` : ''}` : 'failed'}${left > 0 ? `; ${left} short, next look in ${BLOCKS_BACKOFF_MS / 60_000} min` : ''}`);
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override reset(): void {
    this.running = false;
  }

  behaviour(): string {
    return 'digging blocks for the night shell (auto)';
  }

  status(): ProcessStatus {
    return { line: this.behaviour() };
  }
}
