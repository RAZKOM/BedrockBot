// Track AR (wave 10, docs/panel.md "Interaction", decision 0039): the two inventory actions the control
// panel's context menu needs that had no chat command yet. Both are ordinary owner commands (the panel
// sends them through POST /api/cmd like any other), tier `more`, group `control`:
//   !select <slot>             make hotbar slot 0..8 the held item (mob_equipment, world/hotbar.ts)
//   !offhand <item> | clear    move an inventory stack into the offhand / the offhand back into a free slot
// The offhand move is the shield controller's verified request (skills/combat/shield.ts): with the
// inventory screen open, item_stack_request `place` from hotbar|inventory slot N to { container_id:
// 'offhand' } slot 1; `clear` is the same action the other way round. Both go through the survival kit's
// StackRequests (one screen at a time with the kit's own drops and armour moves). Note: with a shield in
// the inventory and an empty offhand the shield controller puts the shield back by itself (docs/pve.md).
import type { ItemStack } from '../world/types.ts';
import type { ItemV4 } from '../world/packets.ts';
import type { Chat } from './chat.ts';
import { wireItemOf } from '../skills/place/place.ts';
import { inventorySlot, isOk, slotInfo } from '../skills/survival/screen.ts';
import { survivalKitOf } from './commands-survival.ts';

const WINDOW_INVENTORY = 0;
const WINDOW_OFFHAND = 119;
/** The offhand container's request slot (window 119 slot 0 in the model). */
const OFFHAND_REQ_SLOT = 1;

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n.toLowerCase());

/** `!select` argument -> hotbar slot 0..8, or undefined. */
export function parseHotbarSlot(arg: string | undefined): number | undefined {
  if (arg === undefined || !/^\d$/.test(arg)) return undefined;
  const n = Number(arg);
  return n >= 0 && n <= 8 ? n : undefined;
}

/** The inventory slot (0..35) holding `name`: the hotbar first, then the main inventory. */
export function findSlot(slots: readonly (ItemStack | null)[], name: string): number | undefined {
  const want = bare(name);
  for (let i = 0; i < 36; i++) if (slots[i]?.name === want && slots[i]!.count > 0) return i;
  return undefined;
}

/** The first empty inventory slot, main inventory first (keep the hotbar), else undefined. */
export function freeSlot(slots: readonly (ItemStack | null)[]): number | undefined {
  for (let i = 9; i < 36; i++) if (!slots[i] || slots[i]!.count <= 0) return i;
  for (let i = 0; i < 9; i++) if (!slots[i] || slots[i]!.count <= 0) return i;
  return undefined;
}

/** What the commands read (CommandDeps satisfies it; unit tests pass fakes). */
export interface PanelCommandDeps {
  chat: Chat;
  task: object;
  world: { inventory: { readonly slots: readonly (ItemStack | null)[]; window(id: number): { slots: readonly (ItemStack | null)[] } | undefined; setItem(window: number, slot: number, item: ItemStack | null): void } } | undefined;
  pve: { hotbar: { select(slot: number): boolean; noteRaw(slot: number, item: ItemV4 | undefined): void } } | undefined;
  needsWalking(cmd: string): string;
}

/** The survival kit as the offhand move uses it: busy, and its inventory-screen requests. */
export interface PanelKit {
  readonly busy: boolean;
  readonly requests: {
    withScreen<T>(fn: () => Promise<T>): Promise<T | { ok: false; reason: string }>;
    send(actions: Record<string, unknown>[]): Promise<{ status: unknown }>;
  };
}

export function registerPanelCommands(d: PanelCommandDeps, kitOf: (task: object) => PanelKit | undefined = survivalKitOf): void {
  const { chat } = d;
  chat.register({
    name: 'select',
    help: '<slot 0..8> (hold the item in that hotbar slot)',
    tier: 'more',
    group: 'control',
    example: '!select 2',
    auto: 'it holds the right tool or weapon by itself while digging and fighting',
    run: ({ args, reply }) => {
      const hotbar = d.pve?.hotbar;
      const world = d.world;
      if (!hotbar || !world) {
        reply(d.needsWalking('select'));
        return;
      }
      const slot = parseHotbarSlot(args[0]);
      if (slot === undefined) {
        reply('usage: !select <slot 0..8>');
        return;
      }
      hotbar.select(slot);
      const it = world.inventory.slots[slot];
      reply(`selected hotbar slot ${slot}: ${it ? `${it.name} x${it.count}` : 'empty'}`);
    },
  });

  chat.register({
    name: 'offhand',
    help: '[<item> | clear] (move an item into the offhand, or the offhand back into the inventory)',
    tier: 'more',
    group: 'control',
    example: '!offhand shield',
    auto: 'a shield in the inventory goes into an empty offhand by itself',
    run: ({ args, reply }) => {
      const world = d.world;
      const kit = kitOf(d.task);
      if (!world || !kit) {
        reply(d.needsWalking('offhand'));
        return;
      }
      const inv = world.inventory;
      const held = (): ItemStack | null => inv.window(WINDOW_OFFHAND)?.slots[0] ?? null;
      const a = args[0]?.toLowerCase();
      if (!a) {
        const h = held();
        reply(`offhand: ${h ? `${h.name} x${h.count}` : 'empty'} (!offhand <item> | clear)`);
        return;
      }
      if (kit.busy) {
        reply('offhand: busy (the survival kit is moving items), try again');
        return;
      }
      const note = (slot: number): void => {
        if (slot < 9) d.pve?.hotbar.noteRaw(slot, wireItemOf(inv.slots[slot], undefined));
      };
      /** The offhand stack back into a free slot (the model predicted first, as the response only carries counts). */
      const clear = async (): Promise<string | undefined> => {
        const h = held();
        if (!h) return undefined;
        const dst = freeSlot(inv.slots);
        if (dst === undefined) return 'no free inventory slot';
        inv.setItem(WINDOW_INVENTORY, dst, { ...h });
        const r = await kit.requests.send([{ type_id: 'place', legacy_type_id: 1, count: h.count, source: slotInfo('offhand', OFFHAND_REQ_SLOT, h.stackId), destination: inventorySlot(dst, 0) }]);
        if (!isOk(r)) {
          if (inv.slots[dst]?.name === h.name) inv.setItem(WINDOW_INVENTORY, dst, null);
          return `refused (${String(r.status)})`;
        }
        inv.setItem(WINDOW_OFFHAND, 0, null);
        note(dst);
        return undefined;
      };
      if (a === 'clear' || a === 'empty' || a === 'none') {
        const h = held();
        if (!h) {
          reply('offhand: already empty');
          return;
        }
        void kit.requests
          .withScreen(async () => (await clear()) ?? 'ok')
          .then((r) => {
            reply(r === 'ok' ? `offhand: ${h.name} moved back into the inventory` : `offhand clear: ${typeof r === 'string' ? r : r.reason}`);
          });
        return;
      }
      const want = bare(a);
      if (held()?.name === want) {
        reply(`offhand: already holds ${want}`);
        return;
      }
      if (findSlot(inv.slots, want) === undefined) {
        reply(`offhand: no ${want} in the inventory`);
        return;
      }
      void kit.requests
        .withScreen(async (): Promise<string> => {
          const err = await clear();
          if (err) return `could not empty the offhand first: ${err}`;
          const slot = findSlot(inv.slots, want);
          const it = slot === undefined ? undefined : inv.slots[slot];
          if (slot === undefined || !it) return `no ${want} in the inventory`;
          const r = await kit.requests.send([{ type_id: 'place', legacy_type_id: 1, count: it.count, source: inventorySlot(slot, it.stackId), destination: slotInfo('offhand', OFFHAND_REQ_SLOT, 0) }]);
          if (!isOk(r)) return `refused (${String(r.status)})`;
          // the server also sends inventory_content 119; keep the model right meanwhile (as the shield controller does)
          inv.setItem(WINDOW_OFFHAND, 0, { ...it });
          if (inv.slots[slot]?.name === it.name) inv.setItem(WINDOW_INVENTORY, slot, null);
          note(slot);
          return 'ok';
        })
        .then((r) => {
          reply(r === 'ok' ? `offhand: ${want}` : `offhand ${want}: ${typeof r === 'string' ? r : r.reason}`);
        });
    },
  });
}
