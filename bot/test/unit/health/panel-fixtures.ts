// Track AP: shared fixtures for the panel's unit tests: a full inventory (36 stacks, iron armour, a
// shield, shulker boxes with NBT contents), a state source with every Track AP status, and the raw
// wire items as BDS 1.26.60.6 sends them (`extra.nbt.nbt.value.Items` / `Damage`).
import { RuntimeSettings } from '../../../src/config/settings.ts';
import type { InventorySource } from '../../../src/health/panel/inventory.ts';
import { buildPanelState, type PanelState, type PanelStateSource } from '../../../src/health/panel/state.ts';
import type { ItemStack } from '../../../src/world/types.ts';

let nid = 100;
export const stack = (name: string, count = 1, extra: Partial<ItemStack> = {}): ItemStack => ({ name, networkId: nid++, count, metadata: 0, ...extra });

/** A raw wire shulker box item holding `items` ([name, count] per slot). */
export function rawBox(items: [string, number][]): unknown {
  return {
    network_id: 900,
    count: 1,
    metadata: 0,
    extra: {
      has_nbt: true,
      nbt: {
        version: 1,
        nbt: {
          type: 'compound',
          name: '',
          value: {
            Items: {
              type: 'list',
              value: {
                type: 'compound',
                value: items.map(([n, c], i) => ({ Name: { type: 'string', value: `minecraft:${n}` }, Count: { type: 'byte', value: c }, Slot: { type: 'byte', value: i }, Damage: { type: 'short', value: 0 } })),
              },
            },
          },
        },
      },
    },
  };
}

/** 27 different kinds: the worst case for a box's contents. */
export const BOX_27: [string, number][] = Array.from({ length: 27 }, (_, i) => [`test_item_number_${i}`, 64 - i]);

/** 36 stacks: tools in the hotbar, 20 cobblestone stacks, food, ores, 6 shulker boxes (one with 27 kinds); iron armour; a shield. */
export function fullInventory(): InventorySource & { raws: Map<string, unknown> } {
  const slots: ItemStack[] = [
    stack('iron_sword', 1, { damage: 125 }),
    stack('diamond_pickaxe', 1, { damage: 61 }),
    stack('stone_axe', 1, { damage: 120 }),
    stack('iron_shovel', 1),
    stack('bread', 12),
    stack('torch', 40),
    stack('water_bucket', 1),
    stack('bow', 1, { damage: 300 }),
    stack('cooked_beef', 7),
  ];
  for (let i = 0; i < 20; i++) slots.push(stack('cobblestone', 64, { blockRuntimeId: 5 }));
  slots.push(stack('iron_ore', 9, { blockRuntimeId: 6 }), stack('oak_log', 32, { blockRuntimeId: 7 }));
  for (let i = 0; i < 5; i++) slots.push(stack(i === 0 ? 'undyed_shulker_box' : `${['red', 'blue', 'lime', 'black'][i - 1]}_shulker_box`, 1, { blockRuntimeId: 8 }));
  const raws = new Map<string, unknown>();
  raws.set('0:31', rawBox(BOX_27));
  raws.set('0:32', rawBox([['cobblestone', 64], ['cobblestone', 64], ['iron_ingot', 10]]));
  raws.set('0:33', rawBox([]));
  // 34 and 35: no raw item (changed by a local prediction): contents unknown
  raws.set('0:34', undefined);
  const armour = [stack('iron_helmet', 1, { damage: 10 }), stack('iron_chestplate', 1), stack('iron_leggings', 1), stack('iron_boots', 1, { damage: 190 })];
  return {
    slots,
    selected: 2,
    raws,
    window: (id) => (id === 120 ? { slots: armour } : id === 119 ? { slots: [stack('shield', 1, { damage: 36 })] } : id === 0 ? { slots } : undefined),
    rawItem: (w, s) => raws.get(`${w}:${s}`),
  };
}

const LOG = (i: number): string => `2026-10-29T18:52:${String(i % 60).padStart(2, '0')}.123Z INFO  [move] goto 18311 -60 17027: arrived after 41 ticks, 12.3 blocks, 0 corrections (plan ${i})`;

/** A source with everything Track AP shows (and a busy log and chat). */
export function fullSource(over: Partial<PanelStateSource> = {}): PanelStateSource {
  const settings = new RuntimeSettings();
  const inv = fullInventory();
  return {
    name: () => 'PanelBot',
    server: '127.0.0.1:19180 (raknet)',
    task: 'afk',
    connState: () => 'spawned',
    healthy: () => true,
    gameVersion: () => '1.26.60',
    statusLines: () => ['status: up 2h 3m, session 2h 3m, reconnects 1, kicks 0, pos 18311.50 -60.00 17027.50, version 1.26.60, tick 147000, task afk, behaviour guard, nudges 0, corrections 2, deaths 1', 'processes: get (user 40, active, getting 32 oak_log: 12/32) > guard (auto 60, idle)'],
    stack: () => [
      { name: 'get', kind: 'user', priority: 40, state: 'active', held: false, line: 'getting 32 oak_log: 12/32 (fell 3 trees)', etaS: 95 },
      { name: 'guard', kind: 'auto', priority: 60, state: 'idle', held: false, line: 'guarding r=16', etaS: undefined },
      { name: 'build', kind: 'user', priority: 40, state: 'paused', held: true, line: 'build wall: 40/120 blocks', etaS: 300 },
    ],
    vitals: () => ({ health: 17.5, food: 18 }),
    position: () => ({ x: 18311.5, y: -60, z: 17027.5 }),
    dimension: () => 0,
    timeOfDay: () => 6000,
    settings,
    logs: () => Array.from({ length: 50 }, (_, i) => LOG(i)),
    chat: () => Array.from({ length: 30 }, (_, i) => ({ ts: 1761753600000 + i * 1000, text: `waypoint panel set to 18304 -60 17024 (${i})`, sent: true })),
    commands: () => Array.from({ length: 70 }, (_, i) => `command${i}`),
    inventory: () => inv,
    icons: () => true,
    saturation: () => 4.8,
    weather: () => 'rain',
    day: () => 12,
    deaths: () => ({ deaths: 1, lastDeath: { cause: 'death.attack.mob', ts: '2026-10-29T18:00:00.000Z', messages: ['%entity.zombie.name'] } }),
    combat: () => ({ fights: 14, kills: 12, retargets: 3, flees: 1, guardTriggers: 9, hits: 21, damageTaken: 37.5, lastHit: { damage: 3, agoS: 42 } }),
    memory: () => ({ chests: { known: 9, reachable: 8, unreachable: 1, read: 7 }, herds: 4, animals: 23, forests: 6, ores: 11, oreKinds: { iron_ore: 6, coal_ore: 4, diamond_ore: 1 }, radius: 64, ms: 1.2 }),
    planner: () => ({ threads: 1, running: true, plans: 120, interims: 14, results: 118, failed: 2, forwardMs: 230.4, maxForwardMs: 3.21, starts: 1, crashes: 0 }),
    conn: () => ({ server: '127.0.0.1:19180 (raknet)', version: '1.26.60', state: 'spawned', uptimeS: 7380, sessionS: 7300, reconnects: 1, disconnects: 1, kicks: 0, lastDisconnect: '2026-10-29T16:00:00.000Z closed: server restart' }),
    ...over,
  };
}

export function fullState(over: Partial<PanelStateSource> = {}): PanelState {
  return buildPanelState(fullSource(over), 1761753600000);
}
