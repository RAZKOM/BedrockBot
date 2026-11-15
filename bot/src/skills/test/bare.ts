// Track T2 (docs/pve.md "`bare` (Track T2)", ADR 0079 decisions 28 and 30): `!test mobs <set> ... bare`, a
// mob series fought with no blade in the hotbar, so that the mob guard's floors for a bot without one (the elytra flee
// first, tasks/pve.ts `hasBlade()`) run on a world where the kit carries a sword.
//
//   stow      before the first run: every blade (a sword or an axe, combat.ts `bladeScore > 0`) in hotbar slots 0..8
//             moves into a free main-inventory slot (9..35), one whole-stack move each through the survival kit's
//             inventory screen (world/containers.ts `move`: nothing is destroyed, the enchantments stay). With no free
//             slot it exchanges places with a main-inventory stack the fight would not take as a weapon (weaponScore 0:
//             a block, food, a material, never a tool, a trident or another blade), one `swap` stack request
//             (SurvivalKit.swapSlots), so `bare` needs no free slot. No such stack either: the series is refused before
//             anything moves.
//   hold      from the stow to the restore every pull from the main inventory into the hotbar passes blades over
//             (HotbarPuller.hold: the fight's weapon pull, the Digger's axe pull, a breeding pull all go through it)
//   keep      after each run's restore: a blade that came into the hotbar since (a /give of the kit lands in the first
//             free slot, a pickup) is stowed too
//   restore   when the series ends, however it ends (finished, `!test stop`, a death, an error): each blade back into the
//             hotbar slot it came from. An empty slot takes it by a move; a slot that holds something (a mob's drop the
//             server put there on a pickup: it fills the first slot that stacks, else the first empty one, the hotbar
//             first) exchanges with it, so the occupant goes where the blade was and nothing needs a free slot. Without
//             the exchange (no swap port) the occupant is parked in a free main slot first, else the blade goes into
//             another empty hotbar slot, else it stays where it is (the line says so). The hold ends in any case.
// keepInventory is on wherever the series runs (mobs.ts refuses without it), so a death keeps the slots; the restore looks
// for the blade where it was put and, if it moved, for the same item anywhere in the inventory.
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemStack } from '../../world/types.ts';
import { bladeScore, weaponScore } from '../combat/combat.ts';
import { FOODS } from '../survival/eat.ts';
import { maxDurability } from '../survival/tools.ts';

const HOTBAR = 9;
const SLOTS = 36;

type Slots = readonly (ItemStack | null | undefined)[];

/** A blade moved out of the hotbar: its name, the hotbar slot it left, the main-inventory slot it went to, and the item it exchanged places with (a full inventory). */
export interface Stowed {
  item: string;
  from: number;
  to: number;
  swapped?: string;
}

export interface BarePorts {
  /** The player inventory now (0..8 the hotbar, 9..35 the main inventory). */
  slots(): Slots;
  /** A whole stack from one slot into an empty one (SurvivalKit.moveSlot). */
  move(from: number, to: number): Promise<{ ok: boolean; reason?: string }>;
  /** Two slots' stacks exchanged in one request (SurvivalKit.swapSlots). Undefined: only moves (a free slot needed). */
  swap?(a: number, b: number): Promise<{ ok: boolean; reason?: string }>;
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

const empty = (it: ItemStack | null | undefined): boolean => !it || it.count <= 0;

function freeMain(slots: Slots): number[] {
  const out: number[] = [];
  for (let i = HOTBAR; i < SLOTS; i++) if (empty(slots[i])) out.push(i);
  return out;
}

/**
 * Main-inventory stacks a blade may exchange places with at the stow: nothing the fight would take as a weapon
 * (weaponScore 0), least useful first (no durability and not food, then food, then the rest), then by slot.
 */
export function swapCandidates(slots: Slots): number[] {
  const rank = (it: ItemStack): number => (maxDurability(it.name) !== undefined ? 2 : FOODS[it.name] ? 1 : 0);
  const out: { i: number; r: number }[] = [];
  for (let i = HOTBAR; i < SLOTS; i++) {
    const it = slots[i];
    if (empty(it) || weaponScore(it!.name) > 0) continue;
    out.push({ i, r: rank(it!) });
  }
  return out.sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.i);
}

/**
 * Each hotbar blade to a free main-inventory slot (lowest first), then, with `swap`, in exchange for a main stack the fight
 * would not use (swapCandidates); or why not.
 */
export function planStow(slots: Slots, swap = false): { moves: Stowed[] } | { error: string } {
  const blades = hotbarBlades(slots);
  const free = freeMain(slots);
  const others = swap ? swapCandidates(slots) : [];
  if (blades.length > free.length + others.length) {
    const names = blades.map((i) => `${slots[i]!.name} in slot ${i}`).join(', ');
    return {
      error: swap
        ? `test mobs: bare needs ${blades.length} inventory slot${blades.length === 1 ? '' : 's'} free or holding something that is no weapon for ${names}, ${free.length + others.length} there; make room first`
        : `test mobs: bare needs ${blades.length} free inventory slot${blades.length === 1 ? '' : 's'} for ${names}, ${free.length} free; make room first`,
    };
  }
  return {
    moves: blades.map((from, k) => {
      const to = k < free.length ? free[k]! : others[k - free.length]!;
      return { item: slots[from]!.name, from, to, ...(k >= free.length ? { swapped: slots[to]!.name } : {}) };
    }),
  };
}

/** `netherite_sword 0 -> 27, diamond_axe 3 <-> 28 (cobblestone)`, or `no blade in the hotbar`. */
export function stowedText(s: readonly Stowed[]): string {
  return s.length ? s.map((x) => (x.swapped ? `${x.item} ${x.from} <-> ${x.to} (${x.swapped})` : `${x.item} ${x.from} -> ${x.to}`)).join(', ') : 'no blade in the hotbar';
}

export interface BareRestore {
  ok: boolean;
  /** `netherite_sword back in slot 0`, `netherite_sword back in slot 8 (exchanged with gunpowder)`, `netherite_sword not found`. */
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

  private get canSwap(): boolean {
    return typeof this.p.swap === 'function';
  }

  private one(m: Stowed): Promise<{ ok: boolean; reason?: string }> {
    return m.swapped ? this.p.swap!(m.from, m.to) : this.p.move(m.from, m.to);
  }

  /** Why a stow cannot be made here (no slot for a blade), else undefined. Nothing is moved. */
  refusal(): string | undefined {
    const plan = planStow(this.p.slots(), this.canSwap);
    return 'error' in plan ? plan.error : undefined;
  }

  /** The blades out of the hotbar and the hold on. A failed move puts back what was moved and ends the hold. */
  async stow(): Promise<{ ok: true; stowed: Stowed[] } | { ok: false; reason: string }> {
    const plan = planStow(this.p.slots(), this.canSwap);
    if ('error' in plan) return { ok: false, reason: plan.error };
    // the hold first: no weapon pull between the moves brings one back
    this.p.hold(true);
    this.holding = true;
    for (const m of plan.moves) {
      const r = await this.one(m);
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
    const plan = planStow(this.p.slots(), this.canSwap);
    if ('error' in plan) {
      this.log.warn(`${plan.error} (a blade came back into the hotbar)`);
      return [];
    }
    const out: Stowed[] = [];
    for (const m of plan.moves) {
      const r = await this.one(m);
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

  /** Where the blade of `s` is now: its main slot, else the same item in the main inventory, else in the hotbar; not in `claimed`. */
  private where(s: Stowed, slots: Slots, claimed: ReadonlySet<number>): number | undefined {
    const is = (i: number): boolean => !claimed.has(i) && slots[i]?.name === s.item && !empty(slots[i]);
    if (is(s.to)) return s.to;
    for (let i = HOTBAR; i < SLOTS; i++) if (is(i)) return i;
    if (is(s.from)) return s.from;
    for (let i = 0; i < HOTBAR; i++) if (is(i)) return i;
    return undefined;
  }

  /** Every stowed blade back into its hotbar slot (see the file comment); the hold ends whatever happens. */
  async restore(): Promise<BareRestore> {
    const notes: string[] = [];
    let ok = true;
    try {
      const claimed = new Set<number>();
      for (const s of this.stowed) {
        const slots = this.p.slots();
        const at = this.where(s, slots, claimed);
        if (at === undefined) {
          ok = false;
          notes.push(`${s.item} not found`);
          continue;
        }
        if (at === s.from) {
          claimed.add(at);
          notes.push(`${s.item} back in slot ${s.from}`);
          continue;
        }
        const there = slots[s.from];
        let r: { ok: boolean; reason?: string };
        let to = s.from;
        if (empty(there)) r = await this.p.move(at, to);
        else if (this.canSwap) r = await this.p.swap!(at, to);
        else {
          // no exchange here: park the occupant, else another empty hotbar slot
          const park = freeMain(slots)[0];
          const pr = park !== undefined ? await this.p.move(to, park) : { ok: false };
          if (!pr.ok) {
            const now = this.p.slots();
            let h = -1;
            for (let i = 0; i < HOTBAR && h < 0; i++) if (empty(now[i])) h = i;
            if (h < 0) {
              ok = false;
              notes.push(`${s.item} stays in slot ${at} (slot ${s.from} holds ${there!.name}, no free slot)`);
              claimed.add(at);
              continue;
            }
            to = h;
          }
          r = await this.p.move(at, to);
        }
        if (!r.ok) {
          ok = false;
          notes.push(`${s.item} stays in slot ${at} (the ${empty(there) || !this.canSwap ? 'move' : 'exchange'} failed: ${r.reason ?? 'refused'})`);
          claimed.add(at);
          continue;
        }
        claimed.add(to);
        notes.push(
          to !== s.from
            ? `${s.item} in slot ${to} (slot ${s.from} holds ${there?.name ?? '?'})`
            : !empty(there) && this.canSwap
              ? `${s.item} back in slot ${s.from} (exchanged with ${there!.name}, now in slot ${at})`
              : `${s.item} back in slot ${s.from}`,
        );
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
