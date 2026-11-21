// Track E12 (`creeperRise`, off; docs/early-game.md "The mine's dangers (Track E12)", ADR 0119): a creeper whose fuse
// burns under the bot is let blow below it.
//
// A creeper cannot climb. A bot that has built up (a pillar to an ore in a cliff, the top of a shaft) and digs its way
// back down comes down onto one that waits at the foot: the fuse lights at about 3 blocks (feet to feet) and the blast
// comes 31 ticks later, with the body 2 to 3 blocks over it. Measured on a pillar of 8 with a creeper at its foot (stone
// kit, no armour): the blast took 1.6 to 18.6 of 20 health, 2 runs of 11 over 14; on a fresh world one such blast killed
// the bot from 20. The rule: while the fuse of a creeper at least RISE_BELOW under the feet and within RISE_SIDE of them
// level burns, the body goes RISE_BLOCKS up by the navigator's own pillar move (throwaway blocks, nothing dug), then
// stands until that creeper is gone (it blew, or died) or RISE_HOLD_MS. The blast then comes 4 to 5 blocks under the
// feet; the job's walk plans again afterwards.
//
// Not for a creeper beside the bot on the same level (a body that goes up 2 next to it stays in its blast: that is the
// flee's back-off, `creeperReach`), not without the blocks or the head room (then nothing changes).
import { silentLogger, type Logger } from '../log.ts';
import type { Vec3 } from '../world/types.ts';
import { BaseProcess, PRIORITY, type ProcessStatus } from './process/manager.ts';

/** The creeper's feet at least this far under the bot's feet. */
export const RISE_BELOW = 2;
/** ... and within this level distance of them (blocks). */
export const RISE_SIDE = 3;
/** Blocks the body goes up: from 2 to 3 over the creeper (where the fuse lights) to 4 to 5. */
export const RISE_BLOCKS = 2;
/** The rise's walk gives up after this (ticks): the blast comes 31 ticks after the fuse lit. */
export const RISE_TICKS = 40;
/** Up there, the body stands at most this long for the creeper to blow (ms). */
export const RISE_HOLD_MS = 3000;
/** One rise per this (ms): a fuse a strike cut and lit again is risen from again after it. */
export const RISE_RETRY_MS = 2000;

/** What the rule reads (the host fills it). */
export interface RiseView {
  me: Vec3;
  /** The live creepers within 8, with their fuse. */
  creepers: readonly { id: bigint; feet: Vec3; lit: boolean }[];
  /** Throwaway blocks carried (cobblestone, dirt, cobbled deepslate, netherrack). */
  blocks: number;
  /** The cells RISE_BLOCKS over the head are free to climb into. */
  room: boolean;
}

/** The creeper to rise from, if any: its fuse lit, at least RISE_BELOW under the feet, within RISE_SIDE level; the nearest. */
export function riseFrom(v: RiseView): bigint | undefined {
  if (v.blocks < RISE_BLOCKS || !v.room) return undefined;
  let best: bigint | undefined;
  let bd = Infinity;
  for (const c of v.creepers) {
    if (!c.lit) continue;
    const below = v.me.y - c.feet.y;
    if (below < RISE_BELOW) continue;
    const side = Math.hypot(c.feet.x - v.me.x, c.feet.z - v.me.z);
    if (side > RISE_SIDE) continue;
    const d = Math.hypot(side, below);
    if (d < bd) {
      bd = d;
      best = c.id;
    }
  }
  return best;
}

/** What the rise process needs from the PvE controller. */
export interface RiseHost {
  /** The setting (`creeperRise`). */
  on(): boolean;
  /** undefined: not now (inactive, not spawned, dead). */
  view(): RiseView | undefined;
  /** Walk to this feet cell with place moves only (no dig). */
  goto(p: Vec3, timeoutTicks: number): Promise<{ ok: boolean; reason?: string }>;
  cancel(): void;
  /** The creeper is still there and not dead. */
  alive(id: bigint): boolean;
  log?: Logger;
  now?: () => number;
}

export class RiseProcess extends BaseProcess {
  readonly name = 'rise';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  /** Rises started (status, tests). */
  rises = 0;
  private ep: { from: bigint; to: Vec3; phase: 'up' | 'hold'; at: number } | undefined;
  private pick: bigint | undefined;
  private next = 0;
  private readonly h: RiseHost;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(h: RiseHost) {
    super();
    this.h = h;
    this.log = h.log ?? silentLogger;
    this.now = h.now ?? (() => performance.now());
  }

  /** The flee's priority, added after it: a tie goes to the rise (a flight from a pillar plans down it). */
  get priority(): number {
    return PRIORITY.flee;
  }

  override wants(): boolean {
    if (this.ep) return true;
    this.pick = undefined;
    if (!this.h.on() || this.now() < this.next) return false;
    const v = this.h.view();
    if (!v || v.creepers.length === 0) return false;
    this.pick = riseFrom(v);
    return this.pick !== undefined;
  }

  protected run(t: number): void {
    if (!this.ep) {
      const v = this.h.view();
      const from = this.pick;
      if (!v || from === undefined) {
        this.yieldControl();
        return;
      }
      const me = v.me;
      const c = v.creepers.find((x) => x.id === from);
      const to = { x: Math.floor(me.x), y: Math.floor(me.y + 0.01) + RISE_BLOCKS, z: Math.floor(me.z) };
      this.ep = { from, to, phase: 'up', at: this.now() };
      this.rises++;
      this.next = this.now() + RISE_RETRY_MS;
      this.log.info(`rise: a creeper's fuse burns ${c ? `${(me.y - c.feet.y).toFixed(1)} under the feet, ${Math.hypot(c.feet.x - me.x, c.feet.z - me.z).toFixed(1)} off` : 'under the feet'}: up ${RISE_BLOCKS} blocks to let it blow below`);
    }
    const ep = this.ep;
    if (ep.phase !== 'up') return;
    void this.h.goto(ep.to, RISE_TICKS).then(
      (r) => {
        if (t !== this.token || this.ep !== ep) return;
        ep.phase = 'hold';
        ep.at = this.now();
        this.log.info(`rise: ${r.ok ? 'up' : `not up (${r.reason ?? 'no way'}): standing`}; waiting for the blast`);
      },
      () => {
        if (t !== this.token || this.ep !== ep) return;
        ep.phase = 'hold';
        ep.at = this.now();
      },
    );
  }

  tick(): void {
    const ep = this.ep;
    if (ep?.phase !== 'hold' || !this.controlled) return;
    const gone = !this.h.alive(ep.from);
    if (!gone && this.now() - ep.at < RISE_HOLD_MS) return;
    this.log.info(`rise: ${gone ? 'the creeper is gone' : `no blast in ${RISE_HOLD_MS / 1000} s`}: going on`);
    this.ep = undefined;
    this.yieldControl();
  }

  protected halt(): void {
    this.h.cancel();
  }

  protected override reset(): void {
    this.ep = undefined;
  }

  status(): ProcessStatus {
    return { line: this.ep ? `rise: ${this.ep.phase === 'up' ? 'going up from a creeper' : 'waiting for a creeper to blow below'}` : `rise ${this.h.on() ? 'on' : 'off'}` };
  }
}
