// Track T2 (docs/pve.md "`bare` (Track T2)", ADR 0079 decision 28): `!test mobs <set> ... bare`, a
// mob series fought with no blade in the hotbar, so that the mob guard's floors for a bot without one (the elytra flee
// first, tasks/pve.ts `hasBlade()`) run on a world where the kit carries a sword.
//
//   stow      before the first run: every blade (a sword or an axe, combat.ts `bladeScore > 0`) in hotbar slots 0..8
//             moves into a free main-inventory slot (9..35), one whole-stack move each through the survival kit's
//             inventory screen (world/containers.ts `move`: nothing is destroyed, the enchantments stay). Not enough free
//             slots: the series is refused before anything moves.
//   hold      from the stow to the restore every pull from the main inventory into the hotbar passes blades over
//             (HotbarPuller.hold: the fight's weapon pull, the Digger's axe pull, a breeding pull all go through it)
//   keep      after each run's restore: a blade that came into the hotbar since (a /give of the kit lands in the first
//             free slot, a pickup) is stowed too
//   restore   when the series ends, however it ends (finished, `!test stop`, a death, an error): each blade back into the
//             hotbar slot it came from. An occupied slot has its item moved to a free main slot first; with no free slot
//             the blade goes into another empty hotbar slot, and with none of those it stays where it is (the line says so).
//             The hold ends in any case: the fight's weapon pull then brings a blade left out back at the next fight.
// keepInventory is on wherever the series runs (mobs.ts refuses without it), so a death keeps the slots; the restore looks
// for the blade where it was put and, if it moved, for the same item anywhere in the main inventory.
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemStack } from '../../world/types.ts';
import { bladeScore } from '../combat/combat.ts';

const HOTBAR = 9;
const SLOTS = 36;

type Slots = readonly (ItemStack | null | undefined)[];

/** A blade moved out of the hotbar: its name, the hotbar slot it left and the main-inventory slot it went to. */
export interface Stowed {
  item: string;
  from: number;
  to: number;
}

export interface BarePorts {
  /** The player inventory now (0..8 the hotbar, 9..35 the main inventory). */
  slots(): Slots;
  /** A whole stack from one slot into an empty one (SurvivalKit.moveSlot). */
  move(from: number, to: number): Promise<{ ok: boolean; reason?: string }>;
  /** Keep blades out of every hotbar pull (true) or not (false): HotbarPuller.hold. */
  hold(on: boolean): void;
  /**
   * The body may have its inventory screen opened now: not gliding, no flight (an elytra flee still in the air when its run
   * ends). The series waits for it before the next run's restore and before the blades go back. Undefined: always.
   */
  idle?(): boolean;
  log?: Logger;
}

/** At most this long (ms) the bare series waits for a flight to come down before a restore or the blades going back. */
export const BARE_IDLE_MS = 120_000;

/** A sword or an axe: what the mob guard counts as a blade. */
export function isBlade(it: ItemStack | null | undefined): it is ItemStack {
  return !!it && it.count > 0 && bladeScore(it) > 0;
}

/** The hotbar slots that hold a blade. */
export function hotbarBlades(slots: Slots): number[] {
  const out: number[] = [];
  for (let i = 0; i < HOTBAR; i++) if (isBlade(slots[i])) out.push(i);
  return out;
}

function freeMain(slots: Slots): number[] {
  const out: number[] = [];
  for (let i = HOTBAR; i < SLOTS; i++) if (!slots[i] || slots[i]!.count <= 0) out.push(i);
  return out;
}

/** Each hotbar blade to a free main-inventory slot (lowest first), or why not (too few free slots). */
export function planStow(slots: Slots): { moves: Stowed[] } | { error: string } {
  const blades = hotbarBlades(slots);
  const free = freeMain(slots);
  if (blades.length > free.length) {
    const names = blades.map((i) => `${slots[i]!.name} in slot ${i}`).join(', ');
    return { error: `test mobs: bare needs ${blades.length} free inventory slot${blades.length === 1 ? '' : 's'} for ${names}, ${free.length} free; make room first` };
  }
  return { moves: blades.map((from, k) => ({ item: slots[from]!.name, from, to: free[k]! })) };
}

/** `netherite_sword 0 -> 27, diamond_axe 3 -> 28`, or `no blade in the hotbar`. */
export function stowedText(s: readonly Stowed[]): string {
  return s.length ? s.map((x) => `${x.item} ${x.from} -> ${x.to}`).join(', ') : 'no blade in the hotbar';
}

export interface BareRestore {
  ok: boolean;
  /** `netherite_sword back in slot 0`, `diamond_axe in slot 5 (slot 3 holds stone)`, `netherite_sword not found`. */
  notes: string[];
}

export class BareHold {
  private readonly p: BarePorts;
  private readonly log: Logger;
  /** Everything stowed in this series (the stow and every keep), in order. */
  readonly stowed: Stowed[] = [];
  holding = false;

  constructor(p: BarePorts) {
    this.p = p;
    this.log = p.log ?? silentLogger;
  }

  /** Why a stow cannot be made here (too few free slots), else undefined. Nothing is moved. */
  refusal(): string | undefined {
    const plan = planStow(this.p.slots());
    return 'error' in plan ? plan.error : undefined;
  }

  /** The blades out of the hotbar and the hold on. A failed move puts back what was moved and ends the hold. */
  async stow(): Promise<{ ok: true; stowed: Stowed[] } | { ok: false; reason: string }> {
    const plan = planStow(this.p.slots());
    if ('error' in plan) return { ok: false, reason: plan.error };
    // the hold first: no weapon pull between the moves brings one back
    this.p.hold(true);
    this.holding = true;
    for (const m of plan.moves) {
      const r = await this.p.move(m.from, m.to);
      if (!r.ok) {
        await this.restore();
        return { ok: false, reason: `test mobs: bare: moving the ${m.item} out of hotbar slot ${m.from} failed (${r.reason ?? 'refused'})` };
      }
      this.stowed.push(m);
    }
    this.log.info(`test mobs: bare: ${stowedText(plan.moves)}`);
    return { ok: true, stowed: plan.moves };
  }

  /** Between runs: a blade that came into the hotbar since the stow goes out too. Returns what moved now. */
  async keep(): Promise<Stowed[]> {
    if (!this.holding || hotbarBlades(this.p.slots()).length === 0) return [];
    const plan = planStow(this.p.slots());
    if ('error' in plan) {
      this.log.warn(`${plan.error} (a blade came back into the hotbar)`);
      return [];
    }
    const out: Stowed[] = [];
    for (const m of plan.moves) {
      const r = await this.p.move(m.from, m.to);
      if (!r.ok) {
        this.log.warn(`test mobs: bare: moving the ${m.item} out of hotbar slot ${m.from} again failed (${r.reason ?? 'refused'})`);
        continue;
      }
      this.stowed.push(m);
      out.push(m);
    }
    if (out.length) this.log.info(`test mobs: bare: again ${stowedText(out)}`);
    return out;
  }

  /** Every stowed blade back into its hotbar slot (see the file comment); the hold ends whatever happens. */
  async restore(): Promise<BareRestore> {
    const notes: string[] = [];
    let ok = true;
    try {
      const claimed = new Set<number>();
      for (const s of this.stowed) {
        const slots = this.p.slots();
        let at: number | undefined = slots[s.to]?.name === s.item && slots[s.to]!.count > 0 && !claimed.has(s.to) ? s.to : undefined;
        for (let i = HOTBAR; i < SLOTS && at === undefined; i++) if (!claimed.has(i) && slots[i]?.name === s.item && slots[i]!.count > 0) at = i;
        if (at === undefined) {
          // already back in the hotbar (moved by hand), else lost
          if (slots[s.from]?.name === s.item) notes.push(`${s.item} back in slot ${s.from}`);
          else {
            ok = false;
            notes.push(`${s.item} not found`);
          }
          continue;
        }
        let to = s.from;
        const there = slots[to];
        if (there && there.count > 0) {
          const park = freeMain(slots)[0];
          const r = park !== undefined ? await this.p.move(to, park) : { ok: false };
          if (!r.ok) {
            const now = this.p.slots();
            let h = -1;
            for (let i = 0; i < HOTBAR && h < 0; i++) if (!now[i] || now[i]!.count <= 0) h = i;
            if (h < 0) {
              ok = false;
              notes.push(`${s.item} stays in slot ${at} (slot ${s.from} holds ${there.name}, no free slot)`);
              claimed.add(at);
              continue;
            }
            to = h;
          }
        }
        const r = await this.p.move(at, to);
        if (!r.ok) {
          ok = false;
          notes.push(`${s.item} stays in slot ${at} (the move failed: ${r.reason ?? 'refused'})`);
          claimed.add(at);
          continue;
        }
        notes.push(to === s.from ? `${s.item} back in slot ${s.from}` : `${s.item} in slot ${to} (slot ${s.from} holds ${there?.name ?? '?'})`);
      }
    } finally {
      this.p.hold(false);
      this.holding = false;
      this.stowed.length = 0;
    }
    if (notes.length) this.log[ok ? 'info' : 'warn'](`test mobs: bare: ${notes.join(', ')}`);
    return { ok, notes };
  }
}
