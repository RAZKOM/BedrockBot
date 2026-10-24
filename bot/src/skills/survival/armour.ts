// Armour (PLAN.md task 7.11, Track S, docs/survival.md): wear the best piece per slot from the
// inventory. Verified on BDS 1.26.60.6 (truth:inv / truth:durability read the equipment through the
// Script API):
//
//   the armour container is window 120 ('armor', 5 slots in inventory_content: 0 head, 1 chest,
//   2 legs, 3 feet, 4 unused); slot type `armor` in item stack requests
//   with the inventory screen open (interact open_inventory -> container_open type 'inventory'):
//     item_stack_request place { count 1, source: { hotbar | inventory, slot, stack_id },
//                               destination: { armor, slot 0..3, stack_id 0 } }
//   -> inventory_slot { window armor, slot, the item (same stack id) } + item_stack_response ok
//   without the screen: status 50 (refused). A `swap` into an EMPTY armour slot: status 50; a swap
//   with a worn piece is what replaces it (an upgrade).
//
// Ranking per slot: armour points x 10 + toughness, a near-broken piece (toolOk false) last.
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemStack } from '../../world/types.ts';
import { inventorySlot, isOk, slotInfo, type StackRequests } from './screen.ts';

export const WINDOW_ARMOR = 120;
export type ArmourSlot = 0 | 1 | 2 | 3;
export const ARMOUR_SLOT_NAMES = ['head', 'chest', 'legs', 'feet'] as const;

const PIECES: Readonly<Record<string, ArmourSlot>> = { helmet: 0, chestplate: 1, leggings: 2, boots: 3 };
/** Armour points per material and slot (head, chest, legs, feet) and toughness. */
const MATERIALS: Readonly<Record<string, { points: readonly [number, number, number, number]; toughness: number }>> = {
  leather: { points: [1, 3, 2, 1], toughness: 0 },
  golden: { points: [2, 5, 3, 1], toughness: 0 },
  chainmail: { points: [2, 5, 4, 1], toughness: 0 },
  iron: { points: [2, 6, 5, 2], toughness: 0 },
  diamond: { points: [3, 8, 6, 3], toughness: 2 },
  netherite: { points: [3, 8, 6, 3], toughness: 3 },
};

/** The armour slot an item goes into (undefined: not armour). Turtle shell = head. */
export function armourSlotOf(name: string): ArmourSlot | undefined {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  if (n === 'turtle_helmet') return 0;
  const us = n.lastIndexOf('_');
  if (us < 0) return undefined;
  const slot = PIECES[n.slice(us + 1)];
  return slot !== undefined && MATERIALS[n.slice(0, us)] ? slot : undefined;
}

/** Higher is better; 0 for an empty slot or a non-armour item. */
export function armourScore(name: string | undefined): number {
  if (!name) return 0;
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  if (n === 'turtle_helmet') return 20;
  const slot = armourSlotOf(n);
  if (slot === undefined) return 0;
  const m = MATERIALS[n.slice(0, n.lastIndexOf('_'))]!;
  return m.points[slot] * 10 + m.toughness;
}

export interface ArmourMove {
  slot: ArmourSlot;
  /** Inventory slot (0..35) of the piece to wear. */
  from: number;
  item: string;
  /** What is worn now (null = nothing). */
  replaces: string | null;
}

/**
 * The pieces to put on: per armour slot the best piece in inventory slots 0..35 that beats what is
 * worn. `ok(item)` false (nearly broken) ranks a piece below every intact one.
 */
export function planArmour(
  slots: readonly (ItemStack | null | undefined)[],
  worn: readonly (ItemStack | null | undefined)[],
  ok: (item: ItemStack) => boolean = () => true,
): ArmourMove[] {
  const score = (it: ItemStack | null | undefined): number => (it ? armourScore(it.name) - (ok(it) ? 0 : 1000) : -Infinity);
  const out: ArmourMove[] = [];
  for (const s of [0, 1, 2, 3] as const) {
    const cur = worn[s] ?? null;
    let best: { from: number; item: ItemStack; score: number } | undefined;
    for (let i = 0; i < Math.min(slots.length, 36); i++) {
      const it = slots[i];
      if (!it || it.count <= 0 || armourSlotOf(it.name) !== s) continue;
      const sc = score(it);
      if (!best || sc > best.score) best = { from: i, item: it, score: sc };
    }
    if (best && best.score > score(cur)) out.push({ slot: s, from: best.from, item: best.item.name, replaces: cur?.name ?? null });
  }
  return out;
}

export interface ArmourInventory {
  readonly slots: readonly (ItemStack | null)[];
  window(id: number): { slots: readonly (ItemStack | null)[] } | undefined;
  setItem(window: number, slot: number, item: ItemStack | null): void;
  freeSlots(): number[];
}

export interface ArmourDeps {
  inventory: ArmourInventory;
  requests: StackRequests;
  toolOk?: (item: ItemStack) => boolean;
  logger?: Logger;
}

export interface EquipResult {
  ok: boolean;
  /** Pieces put on ("chest iron_chestplate"). */
  equipped: string[];
  failed: string[];
  reason?: string;
}

export class ArmourController {
  private readonly d: ArmourDeps;
  private readonly log: Logger;
  private running = false;
  readonly stats = { equipped: 0, failed: 0, passes: 0 };

  constructor(deps: ArmourDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
  }

  get busy(): boolean {
    return this.running;
  }

  /** What is worn now (armour window slots 0..3). */
  worn(): (ItemStack | null)[] {
    const w = this.d.inventory.window(WINDOW_ARMOR)?.slots ?? [];
    return [0, 1, 2, 3].map((i) => w[i] ?? null);
  }

  /** The pieces a pass would put on. */
  plan(): ArmourMove[] {
    return planArmour(this.d.inventory.slots, this.worn(), this.d.toolOk);
  }

  /** Put on every better piece (one screen for all of them). */
  async equip(): Promise<EquipResult> {
    if (this.running) return { ok: false, equipped: [], failed: [], reason: 'busy' };
    const moves = this.plan();
    if (moves.length === 0) return { ok: true, equipped: [], failed: [] };
    this.running = true;
    this.stats.passes++;
    const equipped: string[] = [];
    const failed: string[] = [];
    try {
      const r = await this.d.requests.withScreen(async () => {
        for (const m of moves) {
          const ok = await this.one(m);
          (ok ? equipped : failed).push(`${ARMOUR_SLOT_NAMES[m.slot]} ${m.item}`);
        }
        return true as const;
      });
      if (r !== true) return { ok: false, equipped, failed: moves.map((m) => `${ARMOUR_SLOT_NAMES[m.slot]} ${m.item}`), reason: r.reason };
    } finally {
      this.running = false;
    }
    this.stats.equipped += equipped.length;
    this.stats.failed += failed.length;
    this.log.info(`armour: wearing ${equipped.join(', ') || 'nothing new'}${failed.length ? `; failed ${failed.join(', ')}` : ''}`);
    return { ok: failed.length === 0, equipped, failed };
  }

  private async one(m: ArmourMove): Promise<boolean> {
    const inv = this.d.inventory;
    const piece = inv.slots[m.from];
    if (piece?.name !== m.item) return false;
    const worn = this.worn()[m.slot] ?? null;
    const src = inventorySlot(m.from, piece.stackId);
    const dst = slotInfo('armor', m.slot, worn?.stackId);
    if (!worn) {
      const r = await this.d.requests.send([{ type_id: 'place', legacy_type_id: 1, count: 1, source: src, destination: dst }]);
      if (!isOk(r)) {
        this.log.warn(`armour: place ${m.item} -> ${ARMOUR_SLOT_NAMES[m.slot]} refused (${String(r.status)})`);
        return false;
      }
      // the server confirms the armour slot with inventory_slot; the response empties the source
      inv.setItem(WINDOW_ARMOR, m.slot, { ...piece });
      if (inv.slots[m.from]?.name === m.item) inv.setItem(0, m.from, null);
      return true;
    }
    // swap the worn piece out (model first: Containers keeps the item kinds, only counts come back)
    inv.setItem(0, m.from, { ...worn });
    inv.setItem(WINDOW_ARMOR, m.slot, { ...piece });
    const r = await this.d.requests.send([{ type_id: 'swap', legacy_type_id: 2, source: src, destination: dst }]);
    if (isOk(r)) return true;
    inv.setItem(0, m.from, piece);
    inv.setItem(WINDOW_ARMOR, m.slot, worn);
    this.log.warn(`armour: swap ${m.item} <-> ${worn.name} refused (${String(r.status)})`);
    return false;
  }
}
