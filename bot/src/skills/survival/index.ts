// Survival kit (PLAN.md task 7.11, Track S, docs/survival.md): eating, armour, tool wear, inventory
// keeping, and mob / spawner avoidance in the planner, as one controller on top of the movement stack.
//
//   const kit = new SurvivalKit({ skills, world, loop, hotbar, containers, source, combat: pve.combat, logger });
//   kit.eat(); kit.equip(); kit.drop('rotten_flesh', 8); kit.summary();
//
// Every 10 ticks (when spawned and alive), one inventory action at a time, in this order:
//   armour  a better piece is in the inventory (checked after inventory changes and on spawn)
//   eat     food < 18, or health < 10 and food < 20 (eat.ts), unless fighting (health >= 6), digging,
//           placing, or walking while not urgent (food >= 6 and health >= 10)
//   keeper  throwaway blocks to the hotbar, junk out when full (keeper.ts), not while fighting
// Hooks it installs: `toolOk` on the Digger and the CombatController (tools.ts), `cellCost` on the
// Navigator (nav/avoidance.ts). Settings come through an injected getter (`toolWearLimit`,
// `throwawayMin`, `avoidMobRadius`, `avoidSpawnerRadius`), so a settings registry can drive them.
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { EntityInfo, ItemStack, PacketSource, Vec3 } from '../../world/types.ts';
import { Avoidance, DEFAULT_AVOID_MOB_RADIUS, DEFAULT_AVOID_SPAWNER_RADIUS, SpawnerIndex, type SpawnerWorld } from '../nav/avoidance.ts';
import { wireItemOf } from '../place/place.ts';
import { ARMOUR_SLOT_NAMES, ArmourController, type EquipResult, type WearResult } from './armour.ts';
import { chooseFood, EatController, wantsToEat, type EatResult } from './eat.ts';
import { DEFAULT_JUNK, DEFAULT_THROWAWAY_MIN, hotbarThrowaway, InventoryKeeper, pickHotbarVictim, THROWAWAY_BLOCKS, type DropResult } from './keeper.ts';
import { inventorySlot, StackRequests, type ScreenContainers } from './screen.ts';
import { DEFAULT_TOOL_WEAR_LIMIT, durabilityLeft, makeToolOk, maxDurability } from './tools.ts';

export * from './armour.ts';
export * from './eat.ts';
export * from './keeper.ts';
export * from './screen.ts';
export * from './tools.ts';

export interface SurvivalSettings {
  /** A tool with this many uses left or fewer is not chosen. Default 10. */
  toolWearLimit: number;
  /** Throwaway blocks to keep in the hotbar. Default 16. */
  throwawayMin: number;
  /** Planner penalty radius around hostile mobs (0 = off). Default 4. */
  avoidMobRadius: number;
  /** Planner penalty radius around spawners (0 = off). Default 8. */
  avoidSpawnerRadius: number;
  throwaway: readonly string[];
  junk: readonly string[];
  /** Automatic behaviours (the commands work regardless). Default true. */
  autoEat: boolean;
  autoArmour: boolean;
  autoKeep: boolean;
}

export const DEFAULT_SURVIVAL_SETTINGS: Readonly<SurvivalSettings> = Object.freeze({
  toolWearLimit: DEFAULT_TOOL_WEAR_LIMIT,
  throwawayMin: DEFAULT_THROWAWAY_MIN,
  avoidMobRadius: DEFAULT_AVOID_MOB_RADIUS,
  avoidSpawnerRadius: DEFAULT_AVOID_SPAWNER_RADIUS,
  throwaway: THROWAWAY_BLOCKS,
  junk: DEFAULT_JUNK,
  autoEat: true,
  autoArmour: true,
  autoKeep: true,
});

/** The world model as the kit reads it (`World` satisfies it). */
export interface SurvivalWorld extends SpawnerWorld {
  readonly inventory: {
    readonly slots: readonly (ItemStack | null)[];
    readonly selected: number;
    window(id: number): { slots: readonly (ItemStack | null)[] } | undefined;
    rawItem(window: number, slot: number): ItemV4 | undefined;
    setItem(window: number, slot: number, item: ItemStack | null): void;
    freeSlots(): number[];
    onChange(fn: (window: number, slot: number | undefined) => void): () => void;
  };
  readonly self: { readonly food: number; readonly health: number; readonly runtimeId: bigint };
  readonly entities: ReadonlyMap<bigint, EntityInfo>;
}

/** BotSkills as the kit uses it. */
export interface SurvivalSkills {
  readonly nav: { readonly busy: boolean; cellCost: (() => ((x: number, y: number, z: number) => number) | undefined) | undefined };
  readonly digger?: { readonly busy: boolean; toolOk: (item: ItemStack) => boolean } | undefined;
  readonly placer?: { readonly busy: boolean } | undefined;
}

export interface SurvivalLoop {
  readonly state: { pos: Vec3; ready: boolean };
  waitTicks(n: number): Promise<void>;
  onBeforeStep(fn: (tick: bigint, state: { pos: Vec3; ready: boolean }) => void): () => void;
}

export interface SurvivalHotbar {
  select(slot: number): boolean;
  rawItem(slot: number): ItemV4 | undefined;
  noteRaw?(slot: number, item: ItemV4 | undefined): void;
}

export interface SurvivalContainers extends ScreenContainers {
  move(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean; reason?: string }>;
}

export interface SurvivalDeps {
  skills: SurvivalSkills;
  world: SurvivalWorld;
  loop: SurvivalLoop;
  hotbar: SurvivalHotbar;
  containers: SurvivalContainers;
  source: Pick<PacketSource, 'on' | 'queue'>;
  /** The PvE combat controller (fight state, weapon choice hook). */
  combat?: { readonly busy: boolean; readonly target: { runtimeId: bigint } | undefined; toolOk: (item: ItemStack) => boolean };
  /** Dead or not spawned: do nothing. */
  inactive?: () => boolean;
  /** Settings getter (a settings registry); unknown keys fall back to the defaults. */
  settings?: () => Partial<SurvivalSettings>;
  logger?: Logger;
}

const STEP_TICKS = 10;
const KEEPER_EVERY = 100;
const HIT_PAUSE_TICKS = 60;

export class SurvivalKit {
  readonly eater: EatController;
  readonly armour: ArmourController;
  readonly keeper: InventoryKeeper;
  readonly avoidance: Avoidance;
  readonly spawners: SpawnerIndex;
  readonly requests: StackRequests;
  readonly toolOk: (item: ItemStack) => boolean;
  private readonly d: SurvivalDeps;
  private readonly log: Logger;
  private readonly unsubs: (() => void)[] = [];
  private n = 0;
  private armourDirty = true;
  private keeperDirty = true;
  private lastKeeper = 0;
  private op: Promise<unknown> | undefined;
  private lastHealth: number | undefined;
  private pauseEatUntil = 0;
  readonly stats = { passes: 0 };

  constructor(deps: SurvivalDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    const { world, loop, hotbar, containers, source } = deps;
    this.toolOk = makeToolOk(() => this.settings().toolWearLimit);
    this.requests = new StackRequests({ source, containers, loop, runtimeId: () => world.self.runtimeId });
    this.eater = new EatController({
      loop,
      inventory: world.inventory,
      self: world.self,
      hotbar,
      source,
      toHotbar: (slot) => this.toHotbar(slot),
      logger: this.log,
    });
    this.armour = new ArmourController({ inventory: world.inventory, requests: this.requests, toolOk: this.toolOk, logger: this.log });
    this.keeper = new InventoryKeeper({
      inventory: world.inventory,
      requests: this.requests,
      mover: containers,
      settings: () => {
        const s = this.settings();
        return { throwawayMin: s.throwawayMin, throwaway: s.throwaway, junk: s.junk };
      },
      noteHotbar: (slot) => hotbar.noteRaw?.(slot, wireItemOf(world.inventory.slots[slot], undefined)),
      logger: this.log,
    });
    this.spawners = new SpawnerIndex(world, () => (loop.state.ready ? loop.state.pos : undefined));
    this.avoidance = new Avoidance({
      entities: () => world.entities,
      spawners: () => this.spawners.spawners(),
      mobRadius: () => this.settings().avoidMobRadius,
      spawnerRadius: () => this.settings().avoidSpawnerRadius,
      exclude: () => {
        const t = deps.combat?.target?.runtimeId;
        return t !== undefined ? [t] : [];
      },
      origin: () => (loop.state.ready ? loop.state.pos : undefined),
      lavaWorld: world, // Track AT: lava proximity costs (nav/avoidance.ts LavaIndex)
    });
    deps.skills.nav.cellCost = () => this.avoidance.costFn();
    if (deps.combat) deps.combat.toolOk = this.toolOk;
    this.installDiggerHook();
    this.unsubs.push(
      world.inventory.onChange((window) => {
        if (window === 0 || window === 120) {
          this.armourDirty = true;
          this.keeperDirty = true;
        }
      }),
      loop.onBeforeStep((_t, s) => {
        if (!s.ready) return;
        this.watchHits();
        if (++this.n % STEP_TICKS === 0) this.step();
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.eater.cancel();
    this.requests.dispose();
    this.spawners.dispose();
    if (this.d.skills.nav.cellCost) this.d.skills.nav.cellCost = undefined;
  }

  /** Local overrides on top of the injected settings (tests; until a settings registry drives them). */
  readonly overrides: Partial<SurvivalSettings> = {};

  settings(): SurvivalSettings {
    return { ...DEFAULT_SURVIVAL_SETTINGS, ...this.d.settings?.(), ...this.overrides };
  }

  get busy(): boolean {
    return this.op !== undefined;
  }

  /** `!eat`: eat now (best food), even above the automatic threshold (the server refuses at food 20). */
  eat(): Promise<EatResult> {
    return this.exclusive<EatResult>(() => this.eater.eat({ force: true }), { ok: false, reason: 'busy' });
  }

  /** `!equip`: an armour pass now. `reset` (the command) forgets the manual choices first: the best armour again. */
  equip(opts: { reset?: boolean } = {}): Promise<EquipResult> {
    return this.exclusive<EquipResult>(
      () => {
        if (opts.reset) this.armour.clearPins();
        return this.armour.equip();
      },
      { ok: false, equipped: [], failed: [], reason: 'busy' },
    );
  }

  /** `!equip slot <n>` / `!equip <item>` (the panel's "Wear this"): that piece or the elytra on, kept on by the automatic pass (armour.ts pins). */
  wear(from: number): Promise<WearResult> {
    return this.exclusive<WearResult>(() => this.armour.wearSlot(from), { ok: false, reason: 'busy' });
  }

  /** `!drop <item> [n]`. */
  drop(name: string, n?: number, skip?: ReadonlySet<number>): Promise<DropResult> {
    return this.exclusive<DropResult>(() => this.keeper.drop(name, n, skip), { ok: false, item: name, dropped: 0, reason: 'busy' }); // Track AV: skip
  }

  /** Move a main-inventory stack into the hotbar (the stash step's box); its hotbar slot, undefined when busy or refused. */
  hotbar(slot: number): Promise<number | undefined> {
    return this.exclusive(() => this.toHotbar(slot), undefined);
  }

  /** `!drop all`: the worn armour and the offhand too. */
  dropWorn(): Promise<{ dropped: string[]; refused: string[] }> {
    return this.exclusive(() => this.keeper.dropWorn(), { dropped: [], refused: ['busy'] });
  }

  /** One-line inventory summary for `!inv`. */
  summary(): string {
    const inv = this.d.world.inventory;
    const slots = inv.slots.slice(0, 36);
    const used = slots.filter(Boolean).length;
    const held = inv.slots[inv.selected];
    const counts = new Map<string, number>();
    for (const s of slots) if (s) counts.set(s.name, (counts.get(s.name) ?? 0) + s.count);
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k} x${v}`)
      .join(', ');
    const pins = this.armour.pinned();
    const worn = this.armour.worn().map((w, i) => `${ARMOUR_SLOT_NAMES[i]} ${w ? w.name : '-'}${pins.has(i as 0 | 1 | 2 | 3) ? ' (by hand)' : ''}`);
    const tools = slots
      .filter((s): s is ItemStack => !!s && maxDurability(s.name) !== undefined)
      .map((s) => `${s.name} ${durabilityLeft(s)}/${maxDurability(s.name)}${this.toolOk(s) ? '' : ' (worn)'}`);
    const food = chooseFood(slots, { food: 0, health: 20 });
    const s = this.settings();
    return (
      `inv ${used}/36, held ${inv.selected} ${held ? `${held.name} x${held.count}` : 'empty'}; armour ${worn.join(', ')}; ` +
      `food ${this.d.world.self.food}${food ? ` (best ${food.name})` : ' (none)'}; throwaway ${hotbarThrowaway(slots, s.throwaway)} in hotbar; ` +
      `tools ${tools.join(', ') || 'none'}; items ${top || 'none'}`
    );
  }

  status(): Record<string, unknown> {
    return {
      busy: this.busy,
      eat: this.eater.stats,
      armour: { ...this.armour.stats, pinned: Object.fromEntries([...this.armour.pinned()].map(([s, n]) => [ARMOUR_SLOT_NAMES[s], n])) },
      keeper: this.keeper.stats,
      avoidance: this.avoidance.last,
      spawnerScans: this.spawners.scans,
    };
  }

  // ---- internals ---------------------------------------------------------------------------------

  private installDiggerHook(): void {
    const dg = this.d.skills.digger;
    if (dg && dg.toolOk !== this.toolOk) dg.toolOk = this.toolOk;
  }

  /** After a hard hit (4 or more at once) automatic eating waits 3 s (the eater itself stops on it). */
  private watchHits(): void {
    const h = this.d.world.self.health;
    const prev = this.lastHealth;
    this.lastHealth = h;
    if (prev !== undefined && prev - h >= 4) this.pauseEatUntil = this.n + HIT_PAUSE_TICKS;
  }

  private fighting(): boolean {
    return this.d.combat?.busy ?? false;
  }

  private exclusive<T, B = T>(fn: () => Promise<T>, busy: B): Promise<T | B> {
    if (this.op) return Promise.resolve(busy);
    const p: Promise<T> = fn().finally(() => {
      if (this.op === p) this.op = undefined;
    });
    this.op = p;
    return p;
  }

  private step(): void {
    this.installDiggerHook();
    if (this.d.inactive?.() || this.op) return;
    this.stats.passes++;
    const s = this.settings();
    const sk = this.d.skills;
    const handsBusy = (sk.digger?.busy ?? false) || (sk.placer?.busy ?? false);
    const self = this.d.world.self;
    if (s.autoArmour && this.armourDirty && !this.fighting() && !handsBusy) {
      this.armourDirty = false;
      if (this.armour.plan().length > 0) {
        void this.exclusive(() => this.armour.equip(), undefined);
        return;
      }
    }
    if (s.autoEat && wantsToEat(self) && this.n >= this.pauseEatUntil) {
      const urgent = self.food < 6 || self.health < 10;
      const blocked = (this.fighting() && self.health >= 6) || handsBusy || (sk.nav.busy && !urgent);
      if (!blocked && chooseFood(this.d.world.inventory.slots, self)) {
        void this.exclusive(() => this.eater.eat(), undefined);
        return;
      }
    }
    if (s.autoKeep && !this.fighting() && !handsBusy && (this.keeperDirty || this.n - this.lastKeeper >= KEEPER_EVERY)) {
      this.keeperDirty = false;
      this.lastKeeper = this.n;
      if (this.keeper.plan().length > 0) void this.exclusive(() => this.keeper.pass(), undefined);
    }
  }

  /** Move a main-inventory stack into the hotbar (an empty slot) with the inventory screen open. */
  private async toHotbar(slot: number): Promise<number | undefined> {
    const inv = this.d.world.inventory;
    const it = inv.slots[slot];
    if (!it) return undefined;
    let dst = -1;
    for (let i = 0; i < 9 && dst < 0; i++) if (!inv.slots[i]) dst = i;
    if (dst < 0) {
      // swap with the hotbar slot that is least useful: junk, else the last non-tool slot (keeper.ts pickHotbarVictim)
      dst = pickHotbarVictim(inv.slots, inv.selected, this.settings().junk);
      if (dst < 0) {
        this.log.warn(`hotbar: no slot to swap ${it.name} (slot ${slot}) into: every hotbar slot is a tool or the selected one`);
        return undefined;
      }
      const other = inv.slots[dst]!;
      const r = await this.requests.withScreen(async () => {
        inv.setItem(0, slot, { ...other });
        inv.setItem(0, dst, { ...it });
        const res = await this.requests.send([
          { type_id: 'swap', legacy_type_id: 2, source: inventorySlot(slot, it.stackId), destination: inventorySlot(dst, other.stackId) },
        ]);
        if (res.status === 'ok' || res.status === 0) return true;
        inv.setItem(0, slot, it);
        inv.setItem(0, dst, other);
        return false;
      });
      if (r !== true) {
        this.log.warn(`hotbar: swapping ${it.name} (slot ${slot}) with ${other.name} (hotbar slot ${dst}) was refused`);
        return undefined;
      }
    } else {
      const r = await this.requests.withScreen(() => this.d.containers.move({ window: 0, slot }, { window: 0, slot: dst }, it.count));
      if (!r.ok) {
        this.log.warn(`hotbar: moving ${it.name} (slot ${slot}) into hotbar slot ${dst} failed: ${r.reason ?? 'refused'}`);
        return undefined;
      }
    }
    this.d.hotbar.noteRaw?.(dst, wireItemOf(inv.slots[dst], undefined));
    return dst;
  }
}
