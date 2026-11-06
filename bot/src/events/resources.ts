// Low-resource warnings (decision 0059, docs/events.md "resource.low"). The bot has no single place
// that warns about running low (each skill refuses in its own words when it is out), so the warning
// is derived here from the inventory, against the settings the skills already use:
//
//   food       carried food (skills/survival/eat.ts FOODS, not the `bad` ones) at FOOD_LOW or fewer;
//              armed again from FOOD_OK
//   tools      the best usable pickaxe / axe / shovel / sword at toolWearLimit uses or fewer, while a
//              tool of that class is carried; armed again when the class is above it (or gone)
//   fireworks  with an elytra worn or carried: rockets under fireworksMin; armed again at fireworksMin
//
// One event per crossing, never repeated while it stays low. Checked a second after inventory changes.
import { foodInfo } from '../skills/survival/eat.ts';
import { durabilityLeft } from '../skills/survival/tools.ts';
import type { ItemStack } from '../world/types.ts';
import { events as defaultBus, type EventBus } from './bus.ts';
import { COUNTED_WINDOWS, type TallyInventory } from './items.ts';

export const FOOD_LOW = 2;
export const FOOD_OK = 5;
export const TOOL_CLASSES = ['pickaxe', 'axe', 'shovel', 'sword'] as const;
export const ROCKET_NAMES: ReadonlySet<string> = new Set(['firework_rocket', 'fireworks']);
const CHECK_MS = 1000;

export interface ResourceWatchOptions {
  inventory: TallyInventory;
  /** Setting toolWearLimit. */
  toolWearLimit?: () => number;
  /** Setting fireworksMin. */
  fireworksMin?: () => number;
  bus?: EventBus;
  /** Check synchronously on every change (tests). */
  immediate?: boolean;
}

function items(inv: Pick<TallyInventory, 'window'>): ItemStack[] {
  const out: ItemStack[] = [];
  for (const w of COUNTED_WINDOWS) {
    const slots = inv.window(w)?.slots ?? [];
    for (const s of w === 0 ? slots.slice(0, 36) : slots) if (s && s.count > 0) out.push(s);
  }
  return out;
}

export class ResourceWatch {
  private readonly o: ResourceWatchOptions;
  private readonly bus: EventBus;
  /** Low now (warned, not re-armed yet). */
  private readonly low = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly unsub: () => void;
  private enabled = false;

  constructor(o: ResourceWatchOptions) {
    this.o = o;
    this.bus = o.bus ?? defaultBus;
    this.unsub = o.inventory.onChange((w) => {
      if (!(COUNTED_WINDOWS as readonly number[]).includes(w) || !this.enabled) return;
      if (o.immediate) {
        this.check();
        return;
      }
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.check();
      }, CHECK_MS);
      this.timer.unref();
    });
  }

  /** Start checking (after the inventory arrived: wire.ts enables it a few seconds after the spawn). */
  enable(on = true): void {
    this.enabled = on;
    if (on) this.check();
  }

  check(): void {
    const all = items(this.o.inventory);
    // food
    const food = all.filter((s) => {
      const f = foodInfo(s.name);
      return f !== undefined && !f.bad;
    }).reduce((a, s) => a + s.count, 0);
    this.edge('food', food <= FOOD_LOW, food >= FOOD_OK, () => ({ resource: 'food', left: food, detail: food === 0 ? 'no food carried' : `${food} food item(s) left` }));
    // tools
    const limit = this.o.toolWearLimit?.() ?? 10;
    for (const cls of TOOL_CLASSES) {
      const tools = all.filter((s) => s.name.endsWith(`_${cls}`) && durabilityLeft(s) !== undefined);
      const best = tools.reduce((m, s) => Math.max(m, durabilityLeft(s) ?? 0), -1);
      const item = tools.find((s) => (durabilityLeft(s) ?? 0) === best)?.name ?? cls;
      this.edge(`tools:${cls}`, tools.length > 0 && best <= limit, tools.length === 0 || best > limit, () => ({ resource: 'tools', left: best, detail: `${item}: ${best} use(s) left (toolWearLimit ${limit})` }));
    }
    // fireworks (only with an elytra)
    const elytra = all.some((s) => s.name === 'elytra');
    const min = this.o.fireworksMin?.() ?? 16;
    const rockets = all.filter((s) => ROCKET_NAMES.has(s.name)).reduce((a, s) => a + s.count, 0);
    this.edge('fireworks', elytra && min > 0 && rockets < min, !elytra || rockets >= min, () => ({ resource: 'fireworks', left: rockets, detail: `${rockets} rocket(s) carried, fireworksMin ${min}` }));
  }

  private edge(key: string, isLow: boolean, isOk: boolean, payload: () => { resource: 'food' | 'tools' | 'fireworks'; left: number; detail: string }): void {
    if (isLow && !this.low.has(key)) {
      this.low.add(key);
      this.bus.emit('resource.low', payload());
    } else if (isOk) {
      this.low.delete(key);
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    this.unsub();
  }
}
