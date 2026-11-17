// Track M9 (docs/pve.md "Track M9: losing a following archer", ADR 0079): a blade crafted when an archer is in sight and
// none is carried (PveRules `craftBlade`, off by default: the craft places a crafting table and digs it up again).
//
// A bot with no blade runs from an archer at any health (Track M6, `bareArcher`), and a pillager follows such a flight for
// minutes at about a sprint's speed: in the long case most runs died in the second minute. A stone sword fights a lone
// pillager or skeleton in a few seconds (Track M4's stone kit took 4 to 7 damage from one pillager). So with the
// materials carried (the crafter's plan: cobblestone and sticks, planks or a table for the 3 x 3 grid) and the health at
// BLADE_CRAFT_HEALTH or over, a lone archer (no other hostile within BLADE_LONE) and no melee mob within BLADE_MELEE_CLEAR, the bot crafts the best sword it can
// (BLADE_ITEMS) where it stands; the flight on foot from that archer waits for it (PveController.fleeReason), then guard
// fights with the sword. Below BLADE_ABORT_HEALTH the craft is left to the flight. A craft that fails is not tried again
// for BLADE_RETRY_MS.
import type { Logger } from '../../log.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import { BaseProcess, PRIORITY, type ProcessStatus } from './manager.ts';

/** Craft only at this health or over (two bolts of a pillager while the table goes up and comes down). */
export const BLADE_CRAFT_HEALTH = 14;
/** ... and the craft under way is left to the flight below this. */
export const BLADE_ABORT_HEALTH = 10;
/** No melee mob within this (blocks) while it crafts. */
export const BLADE_MELEE_CLEAR = 8;
/** ... and no other hostile within this (blocks): a lone archer only (with four skeletons the craft took 2 to 5 hits and the fight with no armour more). */
export const BLADE_LONE = 24;
/** A craft that failed is not tried again for this long (ms). */
export const BLADE_RETRY_MS = 30_000;
/** The swords it crafts, best first. */
export const BLADE_ITEMS = ['iron_sword', 'stone_sword', 'wooden_sword'] as const;
/** Over the guard (fighting in place, 85) and under the flight (100). */
export const BLADE_PRIORITY = PRIORITY.defend + 5;

/** The crafter's side (chat/commands-craft.ts wires the Crafter): the best sword the inventory can make now, and the craft. */
export interface BladeSmith {
  item(): string | undefined;
  craft(item: string, cancelled: () => boolean): Promise<{ ok: boolean; line: string }>;
}

/** What the process reads from the PvE controller. */
export interface BladeHost {
  readonly bladeSmith: BladeSmith | undefined;
  readonly log: Logger;
  readonly rules: { readonly craftBlade: boolean };
  position(): Vec3;
  health(): number;
  /** Track M6: no blade carried and an archer with a line on the bot within 16. */
  bareArcher(me: Vec3): EntityInfo | undefined;
  meleeWithin(me: Vec3, r: number): boolean;
  threatsNear(me: Vec3, r: number): readonly unknown[];
  readonly d: { readonly metrics?: { inc(name: string): void } | undefined };
}

/** The rule (pure): craft a blade now. */
export function bladeNow(i: { on: boolean; smith: boolean; item: boolean; archer: boolean; health: number; melee: boolean; retry: boolean; hostiles: number }): boolean {
  return i.on && i.smith && i.item && i.archer && i.hostiles <= 1 && i.health >= BLADE_CRAFT_HEALTH && !i.melee && !i.retry;
}

export class BladeProcess extends BaseProcess {
  readonly name = 'blade';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  private ep: { item: string; startAt: number; cancelled: boolean } | undefined;
  private retryAt = 0;
  private readonly h: BladeHost;

  constructor(h: BladeHost) {
    super();
    this.h = h;
  }

  get priority(): number {
    return BLADE_PRIORITY;
  }

  override wants(): boolean {
    const h = this.h;
    if (this.ep) return h.health() >= BLADE_ABORT_HEALTH;
    const smith = h.bladeSmith;
    if (!h.rules.craftBlade || !smith) return false;
    const me = h.position();
    return bladeNow({ on: true, smith: true, archer: h.bareArcher(me) !== undefined, health: h.health(), melee: h.meleeWithin(me, BLADE_MELEE_CLEAR), hostiles: h.threatsNear(me, BLADE_LONE).length, retry: performance.now() < this.retryAt, item: smith.item() !== undefined });
  }

  protected run(t: number): void {
    const h = this.h;
    const smith = h.bladeSmith;
    const item = this.ep?.item ?? smith?.item();
    if (!smith || !item) {
      this.ep = undefined;
      this.yieldControl();
      return;
    }
    const ep = { item, startAt: performance.now(), cancelled: false };
    this.ep = ep;
    const a = h.bareArcher(h.position());
    h.log.warn(`blade: no blade with ${a ? `${a.type.replace('minecraft:', '')} in sight` : 'an archer near'} (health ${h.health().toFixed(1)}): crafting a ${item}`);
    h.d.metrics?.inc('pve.blade');
    void smith
      .craft(item, () => ep.cancelled || t !== this.token)
      .catch((e: unknown) => ({ ok: false, line: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        if (this.ep !== ep) return;
        this.ep = undefined;
        h.log.warn(`blade: ${r.ok ? 'crafted' : 'no'} ${item} after ${((performance.now() - ep.startAt) / 1000).toFixed(1)} s (${r.line})`);
        if (!r.ok) this.retryAt = performance.now() + BLADE_RETRY_MS;
        this.yieldControl();
      });
  }

  protected halt(): void {
    if (!this.ep) return;
    this.ep.cancelled = true;
    this.h.log.info(`blade: the ${this.ep.item} left (health ${this.h.health().toFixed(1)})`);
    this.ep = undefined;
    this.retryAt = performance.now() + BLADE_RETRY_MS;
  }

  protected override reset(): void {
    if (this.ep) this.ep.cancelled = true;
    this.ep = undefined;
  }

  /** A craft is under way (the flight on foot from the archer in sight waits for it). */
  busy(): boolean {
    return this.ep !== undefined;
  }

  behaviour(): string {
    return 'crafting a blade';
  }

  status(): ProcessStatus {
    return { line: this.ep ? `crafting a ${this.ep.item} (no blade, an archer near)` : 'blade: watching' };
  }
}
