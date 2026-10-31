// Skills facade (PLAN.md section 4.3): lookAt / goto / dig / collect / openContainer / deposit /
// fellTree / cancel on top of the InputLoop and the world model.
//
//   const world = new World(conn);
//   const loop = new InputLoop(conn, { world: flatWorld() });   // the skills swap in real terrain
//   loop.start();
//   const hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
//   const containers = new Containers(conn, world.inventory);
//   const skills = new BotSkills({ loop, world, hotbar, containers, source: conn });
//   await conn.connect(target);
//   await skills.goto({ type: 'xz', x: 30, z: -12 });
//
// Skills are serialised: every public skill call first cancels the one that is running (goto, dig,
// lookAt, collect, fellTree, container use), so two of them never steer yaw/pitch at the same time.
// Compound skills (collect, fellTree) check a cancel epoch between their steps and use the
// navigator and the digger directly, one at a time.
import { silentLogger, type Logger } from '../log.ts';
import type { Containers } from '../world/containers.ts';
import type { Hotbar } from '../world/hotbar.ts';
import type { World } from '../world/index.ts';
import type { Inventory } from '../world/inventory.ts';
import type { ContainerView, EntityInfo, ItemStack, PacketSource, Vec3 } from '../world/types.ts';
import { collectItems, type CollectOptions, type CollectResult } from './collect/collect.ts';
import { ChestSkill, type DepositResult, type OpenOptions, type OpenResult } from './container/chest.ts';
import { Digger, type DigOptions, type DigResult } from './dig/digger.ts';
import type { InputLoop } from './input/inputLoop.ts';
import { PHYSICS } from './input/physics.ts';
import { Navigator, type GotoReport, type NavGotoOptions, type NavigatorOptions } from './nav/navigator.ts';
import type { NavGoal } from './nav/goals.ts'; // Track R
import { DEFAULT_THROWAWAY } from './nav/actions.ts';
import { oppositeFace } from './place/face.ts';
import { angleDiff, turnTowards, yawTowards } from './nav/follower.ts';
import { blockQueryOf, worldSource, type BlockStore } from './terrain/query.ts';
import { UseSkill, type UseOptions, type UseResult } from './interact/use.ts';
import { PlaceSkill, type PlaceOptions, type PlaceResult } from './place/place.ts';
import { clearScaffold, isNaturalTerrain, LATE_PLACE_TICKS, onScaffold, recordPlaced, ScaffoldRecord, type ClearResult } from './place/scaffold.ts';
import { HOSTILE_TYPES, bareType } from './combat/hostiles.ts';
import { DEFAULT_THROWAWAY_MIN } from './survival/keeper.ts';
import { estimateBreak } from './dig/breakTime.ts';
import { blockMining, toolOf } from '../data/mining.ts';
import type { GotoOptions } from './types.ts';
import { fellTree, type FellOptions, type FellResult } from './tree/feller.ts';
import { detectTree, treesFrom, type Tree, type TreeOptions } from './tree/tree.ts';
import type { SkillResult, Skills } from './types.ts'; // Track R: goto takes NavGoal / NavGotoOptions now
import { surfaceRefusal } from '../world/dimension.ts'; // Track AT
import { headInWater, swimUp } from './survival/surface.ts'; // Track BF

export type { Goal, GotoOptions, SkillResult, Skills, DigOptions, DigResult } from './types.ts';
export type { CollectOptions, CollectResult } from './collect/collect.ts';
export type { DepositResult, OpenResult, OpenOptions } from './container/chest.ts';
export type { FellOptions, FellResult } from './tree/feller.ts';
export type { Tree, TreeOptions } from './tree/tree.ts';
export type { PlaceOptions, PlaceResult, PlaceReason } from './place/place.ts';
export type { BlockFace } from './place/face.ts';
export type { UseOptions, UseResult, UseReason, UsableKind } from './interact/use.ts';

/**
 * The world model as the skills read it (`World` satisfies it). The optional parts enable dig
 * (blockAt, inventory), collect (entities, inventory), the chest skill (blockAt, inventory) and the
 * tree finder (find).
 */
export type SkillsWorld = BlockStore &
  Pick<World, 'onBlockUpdate'> & { self: Pick<World['self'], 'health' | 'food'> } & {
    blockAt?: World['blockAt'];
    inventory?: Inventory;
    entities?: ReadonlyMap<bigint, EntityInfo>;
    find?: World['find'];
  };

/** What dig / openContainer / deposit need besides the world (also settable later with `attach`). */
export interface SkillsInventoryParts {
  /** Hotbar slot switching (world/hotbar.ts): dig's tool choice and the held item of a click. */
  hotbar?: Hotbar;
  /** Container windows and item stack requests (world/containers.ts). */
  containers?: Containers;
  /** Where the click transaction is queued (the Connection). */
  source?: Pick<PacketSource, 'queue'>;
}

export interface BotSkillsOptions extends NavigatorOptions, SkillsInventoryParts {
  loop: InputLoop;
  world: SkillsWorld;
  logger?: Logger;
  /** Point the InputLoop's physics at the world model's real block shapes (default true). */
  usePhysicsWorld?: boolean;
}

export interface DamageEvent {
  tick: bigint;
  from: number;
  to: number;
  /** The body landed from a fall of more than 3 blocks within the 20 ticks before (fall damage). */
  falling: boolean;
  /** Height of that fall, blocks. */
  fallDistance?: number;
}

export interface SkillsStatus {
  health: number;
  food: number;
  /** Recent health drops, newest last (at most 20). */
  damage: DamageEvent[];
  corrections: number;
  motions: number;
  teleports: number;
  inWater: boolean;
  inLava: boolean;
  busy: boolean;
  /** The public skill running now (goto, dig, lookAt, collect, fell, container), if any. */
  running: string | undefined;
  lastGoto: GotoReport | undefined;
}

/** Max yaw / pitch change per tick for lookAt (degrees). */
const LOOK_TURN = 30;

export class BotSkills implements Skills {
  readonly nav: Navigator;
  private readonly loop: InputLoop;
  private readonly world: SkillsWorld;
  private readonly log: Logger;
  private readonly damage: DamageEvent[] = [];
  private lastHealth: number | undefined;
  private airTop: number | undefined;
  private landing: { tick: bigint; fall: number } | undefined;
  private look: { yaw: number; pitch: number; ticks: number; resolve: () => void } | undefined;
  private readonly unsubs: (() => void)[] = [];
  private parts: SkillsInventoryParts = {};
  private _digger: Digger | undefined;
  private _chest: ChestSkill | undefined;
  private _placer: PlaceSkill | undefined;
  private _user: UseSkill | undefined;
  /** Bumped by every public skill call and by cancel(); compound skills stop when it changes. */
  private epoch = 0;
  /** Blocks the navigator places / digs while a scaffold walk runs (scaffoldGoto): recorded and counted. */
  private navHook: { placed(p: Vec3): void; dug(p: Vec3): void } | undefined;
  /**
   * Decision 0051: the pending scaffold (pillar and pickup blocks placed only to reach something, not dug again yet).
   * It outlives the skill that placed it: a skill cancelled on top of its pillar leaves the cells here, and the next
   * skill that moves the bot (goto, collect, fellTree) or a cancel digs them down first (`descendFirst`).
   */
  readonly scaffold = new ScaffoldRecord();
  /** The dig-down running now (descendFirst); goto / collect / fellTree wait for it, stopAll leaves its digger alone. */
  private descent: Promise<void> | undefined;
  private disposed = false;
  /** Placements of a scaffold walk still being re-checked (a late server confirmation). */
  private lateChecks = 0;
  /** Compound skills that may place scaffold, running now (descendFirst waits for them: their last cell gets recorded). */
  private readonly placing = new Set<Promise<unknown>>();

  /** Track `p` in `placing` until it settles. */
  private whilePlacing<T>(p: Promise<T>): Promise<T> {
    this.placing.add(p);
    void p.finally(() => this.placing.delete(p)).catch(() => undefined);
    return p;
  }
  /** Throwaway blocks the keeper keeps (setting `throwawayMin`); scaffold may borrow them only while none was ever left behind. */
  throwawayReserve: () => number = () => DEFAULT_THROWAWAY_MIN;
  /** Throwaway blocks the navigator's pillar and the feller's pillar place (NavActions.throwawayItems). */
  private readonly throwawayItems: readonly string[];
  /** Item actors a collect already tried a walk with digging / placing for (one per item; trimmed at 256). */
  private readonly hardTried = new Set<bigint>();
  private runningName: string | undefined;
  private runningEpoch = -1;

  constructor(opts: BotSkillsOptions) {
    this.loop = opts.loop;
    this.world = opts.world;
    this.log = opts.logger ?? silentLogger;
    this.throwawayItems = opts.actions?.throwawayItems ?? DEFAULT_THROWAWAY;
    this.attach(opts);
    const source = worldSource(opts.world);
    if (opts.usePhysicsWorld ?? true) this.loop.world = blockQueryOf(source);
    const inventory = opts.world.inventory;
    // Track BC: section (re)placements reach the navigator's grid too (chunks re-sent after a teleport carry fills that never came as block updates)
    // and a dropped column (unloaded, or replaced by a re-sent level_chunk, which arrives as a fresh unloaded column) leaves
    // stale cells behind too, so it counts as a reload
    const chunks = (
      opts.world as {
        chunks?: {
          onSection?: (fn: (col: { loaded: boolean }, rel: number) => void) => () => void;
          onColumnUnloaded?: (fn: (cx: number, cz: number) => void) => () => void;
        };
      }
    ).chunks;
    const onSection =
      typeof chunks?.onSection === 'function'
        ? (fn: (reloaded: boolean) => void) => {
            const offSection = chunks.onSection!((col) => fn(col.loaded));
            const offUnload = typeof chunks.onColumnUnloaded === 'function' ? chunks.onColumnUnloaded(() => fn(true)) : undefined;
            return () => {
              offSection();
              offUnload?.();
            };
          }
        : undefined;
    this.nav = new Navigator(
      this.loop,
      { source, onBlockUpdate: (fn) => opts.world.onBlockUpdate(fn), ...(onSection ? { onSection } : {}) },
      {
        ...opts,
        logger: this.log,
        // the navigator's dig-through move breaks blocks with the Digger directly (not this.dig(), which would cancel the goto)
        actions: {
          dig: (p) => {
            // a scaffold walk (a pickup's hard walk) digs natural terrain only, never the owner's builds (decision 0051)
            const name = this.world.blockAt?.(p)?.name;
            if (this.navHook && name && !isNaturalTerrain(name) && !this.scaffold.has(p)) return Promise.resolve({ ok: false as const, reason: 'not_natural' });
            return (this.digger?.dig(p) ?? Promise.resolve({ ok: false as const, reason: 'no_digger' })).then((r) => {
              if (r.ok) this.navHook?.dug(p); // a scaffold walk counts its digs
              return r;
            });
          },
          // pillar-up and door moves use the PlaceSkill / UseSkill objects directly for the same reason; the navigator names
          // the neighbour it clicks across `face` (pillar: 'down'), the PlaceSkill the support face it clicks (pillar: 'up')
          place: (p, face) =>
            // a scaffold walk places the kinds that come back when dug again (scaffoldItems)
            {
              const hook = this.navHook;
              const kinds = hook ? this.scaffoldItems() : [...(opts.actions?.throwawayItems ?? DEFAULT_THROWAWAY)];
              if (hook && kinds.length === 0) return Promise.resolve({ ok: false as const, reason: 'no_scaffold_item' });
              const before = this.world.blockAt?.(p);
              const wasFree = !!before && before.boxes.length === 0 && before.name !== 'unknown'; // only a cell free before the click is ever ours
              return (this.placer?.place(p, { face: oppositeFace(face), item: kinds, look: false }) ?? Promise.resolve({ ok: false as const, reason: 'no_placer' })).then((r) => {
                // a scaffold walk records what it placed, also a click the server confirmed late (re-checked in the background)
                if (hook && wasFree && this.world.blockAt) {
                  this.lateChecks++;
                  void recordPlaced(this.scaffold, p, r, { blockAt: this.world.blockAt.bind(this.world), waitTicks: (n) => this.loop.waitTicks(n) }, kinds)
                    .then((placed) => {
                      if (placed) hook.placed(p);
                    })
                    .finally(() => this.lateChecks--);
                }
                return r;
              });
            },
          useBlock: (p) => this.user?.useBlock(p, { want: 'toggle' }) ?? Promise.resolve({ ok: false as const, reason: 'no_user' }),
          ...opts.actions,
        },
        inventory: opts.inventory ?? (inventory ? () => inventory : undefined),
        // Track BE: abort the Digger's job when the navigator gives up on a dig; plan with the Digger's tool filter
        cancelDig: opts.cancelDig ?? (() => this._digger?.cancel()),
        toolOk:
          opts.toolOk ??
          (() => {
            const d = this._digger;
            return d ? (it) => d.toolOk(it as ItemStack) : undefined;
          }),
      },
    );
    this.unsubs.push(
      this.loop.onBeforeStep((tick, s) => {
        this.trackFall(tick, s.onGround, s.pos.y, s.inWater);
        this.trackHealth(tick);
        this.stepLook();
      }),
    );
  }

  /**
   * Enable dig / openContainer / deposit. Parts may come after construction (e.g. a task that got
   * the movement stack from tasks/mobility.ts adds its Hotbar and Containers).
   */
  attach(parts: SkillsInventoryParts): void {
    const next: SkillsInventoryParts = { ...this.parts };
    if (parts.hotbar) next.hotbar = parts.hotbar;
    if (parts.containers) next.containers = parts.containers;
    if (parts.source) next.source = parts.source;
    if (next.hotbar !== this.parts.hotbar && !this._digger?.busy) this._digger = undefined;
    if (next.containers !== this.parts.containers || next.source !== this.parts.source) this._chest = undefined;
    if (next.hotbar !== this.parts.hotbar || next.containers !== this.parts.containers || next.source !== this.parts.source) {
      if (!this._placer?.busy) this._placer = undefined;
      if (!this._user?.busy) this._user = undefined;
    }
    this.parts = next;
  }

  /** The digger (needs world.blockAt and world.inventory; the hotbar enables tool switching). */
  get digger(): Digger | undefined {
    const w = this.world;
    if (!this._digger && w.blockAt && w.inventory) {
      const blockAt = w.blockAt.bind(w);
      const inventory = w.inventory;
      this._digger = new Digger({
        loop: this.loop,
        world: { blockAt, onBlockUpdate: (fn) => w.onBlockUpdate(fn), inventory },
        hotbar: this.parts.hotbar,
        logger: this.log,
      });
    }
    return this._digger;
  }

  /** The chest skill (needs world.blockAt, world.inventory, containers and a packet source). */
  get chest(): ChestSkill | undefined {
    const w = this.world;
    const { containers, source, hotbar } = this.parts;
    if (!this._chest && w.blockAt && w.inventory && containers && source) {
      this._chest = new ChestSkill({
        source,
        loop: this.loop,
        world: { blockAt: w.blockAt.bind(w), chunks: w.chunks, inventory: w.inventory },
        containers,
        rawHotbarItem: (slot) => hotbar?.rawItem(slot),
        logger: this.log,
      });
    }
    return this._chest;
  }

  /**
   * The block placer (skills/place; needs world.blockAt, world.inventory and a packet source; the
   * hotbar for slot switching, containers to fetch items from the main inventory). Navigators call it
   * directly (not through `place`, which would cancel the goto that is running).
   */
  get placer(): PlaceSkill | undefined {
    const w = this.world;
    const { source, hotbar, containers } = this.parts;
    if (!this._placer && w.blockAt && w.inventory && source) {
      this._placer = new PlaceSkill({
        source,
        loop: this.loop,
        world: { blockAt: w.blockAt.bind(w), onBlockUpdate: (fn) => w.onBlockUpdate(fn), chunks: w.chunks, inventory: w.inventory },
        ...(hotbar ? { hotbar } : {}),
        ...(containers ? { containers } : {}),
        runtimeId: () => (w.self as { runtimeId?: bigint }).runtimeId ?? 0n,
        logger: this.log,
      });
    }
    return this._placer;
  }

  /** Doors, gates, trapdoors, buttons, levers (skills/interact; same needs as the placer). */
  get user(): UseSkill | undefined {
    const w = this.world;
    const { source, hotbar } = this.parts;
    if (!this._user && w.blockAt && w.inventory && source) {
      this._user = new UseSkill({
        source,
        loop: this.loop,
        world: { blockAt: w.blockAt.bind(w), onBlockUpdate: (fn) => w.onBlockUpdate(fn), chunks: w.chunks, inventory: w.inventory },
        rawHotbarItem: (slot) => hotbar?.rawItem(slot),
        logger: this.log,
      });
    }
    return this._user;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this._digger?.cancel(); // a dig-down off the scaffold stops too
    this.nav.dispose();
    for (const u of this.unsubs.splice(0)) u();
  }

  // ---- serialisation ---------------------------------------------------------------------------

  /** Cancel whatever runs and mark `name` as running. Returns the token for `isCurrent` / `end`. */
  private begin(name: string): number {
    this.stopAll();
    const token = ++this.epoch;
    this.runningName = name;
    this.runningEpoch = token;
    if (name !== 'fell') void this.descendFirst(); // decision 0051: off the pillar first (the feller handles its own)
    return token;
  }

  private end(token: number): void {
    if (this.runningEpoch === token) this.runningName = undefined;
  }

  private stopAll(): void {
    this.nav.cancel();
    if (!this.descent) this._digger?.cancel(); // a dig-down off the scaffold finishes (decision 0051)
    this._placer?.cancel();
    this._user?.cancel();
    this.look?.resolve();
    this.look = undefined;
  }

  private async run<T>(name: string, fn: (cancelled: () => boolean) => Promise<T>): Promise<T> {
    const token = this.begin(name);
    try {
      return await fn(() => this.epoch !== token);
    } finally {
      this.end(token);
    }
  }

  // ---- skills ----------------------------------------------------------------------------------

  lookAt(p: Vec3): Promise<void> {
    const token = this.begin('lookAt');
    const s = this.loop.state;
    const eye = { x: s.pos.x, y: s.pos.y + PHYSICS.eyeHeight, z: s.pos.z };
    const dx = p.x - eye.x;
    const dy = p.y - eye.y;
    const dz = p.z - eye.z;
    const yaw = Math.hypot(dx, dz) > 1e-6 ? yawTowards(dx, dz) : this.loop.command.yaw;
    const pitch = (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    return new Promise((resolve) => {
      this.look = {
        yaw,
        pitch,
        ticks: 0,
        resolve: () => {
          this.end(token);
          resolve();
        },
      };
    });
  }

  goto(goal: NavGoal, opts?: NavGotoOptions): Promise<SkillResult> { // Track R: every task 7.10 goal type
    // Track AT: under the Nether's bedrock ceiling there is no surface (the search would only exhaust its budget)
    const noSurface = goal.type === 'surface' ? surfaceRefusal((this.world.self as { dimension?: number }).dimension) : undefined;
    if (noSurface) return Promise.resolve({ ok: false, reason: noSurface });
    // Synchronous start (callers check nav.busy right after the call).
    const token = this.begin('goto');
    if (this.descent) {
      // decision 0051: standing on scaffold: dig it down first, then walk. The waiting goto counts as nav.busy, and a
      // cancel (or a newer call) drops it: `if (nav.busy) cancel()` callers take it back as from a walking one.
      const d = this.descent;
      return new Promise<SkillResult>((resolve) => {
        let dropped = false;
        const release = this.nav.queue(() => {
          dropped = true;
          this.end(token);
          resolve({ ok: false, reason: 'interrupted' });
        });
        void d.then(async () => {
          if (dropped) return;
          release();
          if (this.runningEpoch !== token || this.epoch !== token) {
            resolve({ ok: false, reason: 'interrupted' });
            return;
          }
          const r = await this.nav.goto(goal, opts).then((x) => this.surfaceAndRetry(x, token, goal, opts));
          this.end(token);
          resolve(r);
        });
      });
    }
    const p = this.nav.goto(goal, opts).then((r) => this.surfaceAndRetry(r, token, goal, opts));
    void p.finally(() => {
      this.end(token);
    });
    return p;
  }

  /**
   * Track BF: a goto that failed with the head under water (the planner has no start node on a sea
   * floor: it swims on the surface only) swims straight up (skills/survival/surface.ts) and plans once
   * more from the surface.
   */
  private async surfaceAndRetry(r: SkillResult, token: number, goal: NavGoal, opts?: NavGotoOptions): Promise<SkillResult> {
    const w = this.world;
    if (r.ok || r.reason !== 'unreachable' || !w.blockAt || token !== this.epoch) return r;
    const blockAt = w.blockAt.bind(w);
    if (!headInWater(blockAt, this.loop.state.pos)) return r;
    const from = this.loop.state.pos;
    const up = await swimUp(this.loop, blockAt, { cancelled: () => token !== this.epoch });
    this.log.info(
      `goto: no path under water at ${Math.floor(from.x)} ${Math.floor(from.y)} ${Math.floor(from.z)}; swam up ${up.rose.toFixed(1)} blocks in ${up.ticks} ticks${up.ok ? '' : ' (still under water)'}`,
    );
    if (!up.ok || token !== this.epoch) return r;
    return this.nav.goto(goal, opts);
  }

  /** Break one block (docs/digging.md). Needs world.blockAt + world.inventory; the hotbar for tool switching. */
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult> {
    const d = this.digger;
    if (!d) return Promise.resolve({ ok: false, reason: 'no_digger' });
    const token = this.begin('dig');
    const r = d.dig(p, opts);
    void r.finally(() => {
      this.end(token);
    });
    return r;
  }

  /**
   * Walk over item entities within `radius` of the bot until none is left that fits, or
   * `timeoutTicks` pass. `{ ok: false, reason: 'inventory_full' }` when only items that do not fit
   * are left (skills/collect/collect.ts).
   */
  collect(radius: number, timeoutTicks: number, opts: CollectOptions = {}): Promise<CollectResult> {
    const { entities, inventory } = this.world;
    if (!entities || !inventory) {
      return Promise.resolve({ ok: false, reason: 'no_entities', gained: {}, pickedUp: 0, skipped: 0, ticks: 0, corrections: 0 });
    }
    if (this.hardTried.size > 256) this.hardTried.clear();
    return this.run('collect', async (cancelled) => {
      await this.descendFirst(); // decision 0051: off the scaffold first
      return collectItems(
        radius,
        timeoutTicks,
        {
          entities: () => entities,
          state: () => this.loop.state,
          goto: (g, o) => this.nav.goto(g, o),
          waitTicks: (n) => this.loop.waitTicks(n),
          inventory,
          cancelled,
          logger: this.log,
          hardGoto: (g, o, _record, maxBlocks) => this.whilePlacing(this.scaffoldGoto(g, o, maxBlocks)),
          hardTried: this.hardTried,
          scaffold: this.scaffold,
          clearScaffold: () => this.clearScaffold(cancelled),
        },
        opts,
      );
    });
  }

  /**
   * Decision 0051: standing on pending scaffold, dig it down (sneaking, one block at a time) and wait for it; at once
   * otherwise. One dig-down at a time; a cancel or a newer skill does not stop it (only dispose or death does).
   */
  descendFirst(): Promise<void> {
    if (this.descent) return this.descent;
    const w = this.world;
    const d = this.digger;
    if (!w.blockAt || !d) return Promise.resolve();
    const blockAt = w.blockAt.bind(w);
    const state = () => this.loop.state;
    // N2: a placement may still be settling (a pillar step's jump, a late confirmation): its cell is not recorded yet
    const settling = this.placing.size > 0 || this.lateChecks > 0 || !!this._placer?.busy || this.airborneOverScaffold();
    if (!settling && (this.scaffold.size === 0 || !onScaffold(this.scaffold, { blockAt, state }))) return Promise.resolve();
    const run = (async () => {
      if (settling) {
        const placing = Promise.allSettled([...this.placing]);
        let done = false;
        void placing.then(() => (done = true));
        for (let i = 0; i < LATE_PLACE_TICKS + 30 && !this.disposed; i++) {
          if (done && this.lateChecks === 0 && !this._placer?.busy && this.loop.state.onGround) break;
          await this.loop.waitTicks(1);
        }
      }
      if (this.scaffold.size === 0 || !onScaffold(this.scaffold, { blockAt, state })) return;
      this.log.info(`scaffold: on the pillar with ${this.scaffold.size} block(s) pending; digging down first`);
      await clearScaffold(
        this.scaffold,
        {
          blockAt,
          state,
          dig: (p, o) => d.dig(p, o),
          waitTicks: (n) => this.loop.waitTicks(n),
          sneak: (on) => this.loop.setCommand({ sneak: on }),
          // N1: with a hostile near (checked every pass) the last block (a fall of 1) stays pending: its hits spoil every dig
          hostileNear: () => this.hostileNear(12),
          cancelled: () => this.disposed || this.world.self.health <= 0,
          logger: this.log,
        },
        { downOnly: true },
      );
    })().catch(() => undefined);
    this.descent = run.finally(() => {
      this.descent = undefined;
    });
    return this.descent;
  }

  /** In the air (a pillar jump) over a recorded scaffold cell within 2 blocks below the feet. */
  private airborneOverScaffold(): boolean {
    const s = this.loop.state;
    if (s.onGround || this.scaffold.size === 0) return false;
    const x = Math.floor(s.pos.x);
    const z = Math.floor(s.pos.z);
    const y = Math.floor(s.pos.y + 1e-3);
    for (let dy = 1; dy <= 3; dy++) if (this.scaffold.has({ x, y: y - dy, z })) return true;
    return false;
  }

  /** On pending scaffold, or digging down from it: combat strikes but does not move, flee comes down first. */
  onScaffold(): boolean {
    if (this.descent) return true;
    const w = this.world;
    if (!w.blockAt || this.scaffold.size === 0) return false;
    return onScaffold(this.scaffold, { blockAt: w.blockAt.bind(w), state: () => this.loop.state }) || this.airborneOverScaffold();
  }

  /** A hostile mob within `r` blocks (the feller does not pillar then, and comes down). */
  hostileNear(r = 12): boolean {
    const ents = this.world.entities;
    if (!ents) return false;
    const p = this.loop.state.pos;
    for (const e of ents.values()) {
      if (!HOSTILE_TYPES.has(bareType(e.type))) continue;
      if (Math.hypot(e.pos.x - p.x, e.pos.y - p.y, e.pos.z - p.z) <= r) return true;
    }
    return false;
  }

  /**
   * A goto that may dig and place (the navigator's allowBreak / allowPlace, under the same rules: protected area,
   * digPenalty, throwaway blocks): every block it places goes into `record` (scaffold to dig again later), and it
   * stops with 'block_budget' once it placed and dug more than `maxBlocks` blocks. Not a public skill: the
   * compound skills call it between their own steps.
   */
  async scaffoldGoto(goal: NavGoal, o: GotoOptions, maxBlocks: number): Promise<SkillResult> {
    let n = 0;
    let over = false;
    const count = () => {
      if (++n > maxBlocks && !over) {
        over = true;
        this.nav.cancel();
      }
    };
    const hook = {
      placed: () => count(),
      dug: (p: Vec3) => {
        this.scaffold.delete(p);
        count();
      },
    };
    this.navHook = hook;
    try {
      const r = await this.nav.goto(goal, o);
      // a placement still being confirmed (late under lag) is recorded before the walk counts as over
      for (let i = 0; i < LATE_PLACE_TICKS + 5 && this.lateChecks > 0; i++) await this.loop.waitTicks(1);
      return over ? { ok: false, reason: 'block_budget' } : r;
    } finally {
      if (this.navHook === hook) this.navHook = undefined;
    }
  }

  /** Dig the pending scaffold again (place/scaffold.ts): down its column, else from the side when safe, else climbing beside it. */
  async clearScaffold(cancelled: () => boolean = () => false): Promise<ClearResult> {
    await this.descendFirst();
    const w = this.world;
    const d = this.digger;
    const record = this.scaffold;
    if (!w.blockAt || !d) return { removed: [], left: record.cells.map((c) => ({ p: c.p, why: 'no digger' })), gone: [] };
    const placer = this.placer;
    return clearScaffold(record, {
      blockAt: w.blockAt.bind(w),
      state: () => this.loop.state,
      dig: (p, o) => d.dig(p, o),
      goto: (g, o) => this.nav.goto(g, o),
      waitTicks: (n) => this.loop.waitTicks(n),
      ...(placer ? { place: (p: Vec3) => this.pillarPlace(p), throwaways: () => this.scaffoldBudget() } : {}),
      sneak: (on) => this.loop.setCommand({ sneak: on }),
      cancelled: () => cancelled() || this.disposed,
      logger: this.log,
    });
  }

  /** Throwaway blocks carried (inventory and hotbar), of `kinds` (default every throwaway kind). */
  throwawayCount(kinds: readonly string[] = this.throwawayItems): number {
    const inv = this.world.inventory;
    if (!inv) return 0;
    let n = 0;
    for (const s of inv.slots.slice(0, 36)) if (s && kinds.includes(s.name)) n += s.count;
    return n;
  }

  /**
   * The throwaway kinds carried that make good scaffold, best first: kinds the hotbar's best tool (or the hand) harvests
   * (they drop when dug again: cobblestone without a pickaxe is lost and takes 10 s per block), then the fastest to dig.
   * Only harvestable kinds (2026-10-30 e2e: cobblestone dug by hand, 200 ticks a block, no drop): none when the
   * tools at hand harvest none of the kinds carried, and then nothing is pillared.
   */
  scaffoldItems(): string[] {
    const inv = this.world.inventory;
    if (!inv) return [];
    const carried = this.throwawayItems.filter((n) => this.throwawayCount([n]) > 0);
    const ok = this._digger ? (it: ItemStack) => this._digger!.toolOk(it) : () => true; // worn tools count as an empty hand (Track S)
    const tools = [null, ...inv.slots.slice(0, 9).map((s) => (s && ok(s) ? s.name : null))];
    const rank = (name: string): { harvest: boolean; ticks: number } => {
      const b = blockMining(name);
      if (!b) return { harvest: false, ticks: Infinity };
      let best = { harvest: false, ticks: Infinity };
      for (const t of tools) {
        const e = estimateBreak(b, toolOf(t));
        if ((e.canHarvest && !best.harvest) || (e.canHarvest === best.harvest && e.ticks < best.ticks)) best = { harvest: e.canHarvest, ticks: e.ticks };
      }
      return best;
    };
    return carried
      .map((n) => ({ n, ...rank(n) }))
      .filter((r) => r.harvest)
      .sort((a, b) => a.ticks - b.ticks)
      .map((r) => r.n);
  }

  /**
   * Scaffold blocks the bot may place now: the harvestable kinds carried. The keeper's throwaway reserve
   * (`throwawayReserve`) is lent only while no scaffold block was ever left behind; after one was, the reserve stays.
   */
  scaffoldBudget(): number {
    const have = this.throwawayCount(this.scaffoldItems());
    if (this.scaffold.lost === 0) return have;
    const others = this.throwawayCount() - have;
    return Math.max(0, have - Math.max(0, this.throwawayReserve() - others));
  }

  /** One pillar block under the feet with a harvestable scaffold kind (the PlaceSkill directly: not a public skill). */
  private pillarPlace(p: Vec3): Promise<{ ok: boolean; reason?: string; block?: string }> {
    const kinds = this.scaffoldItems();
    if (kinds.length === 0) return Promise.resolve({ ok: false, reason: 'no_scaffold_item' });
    return this.placer?.place(p, { face: 'up', item: kinds, look: false }) ?? Promise.resolve({ ok: false, reason: 'no_placer' });
  }

  /** Inside the protected area (the base around home, protectRadius): the navigator's break rules' distance test. */
  private inProtectedArea(p: Vec3): boolean {
    const a = this.nav.breakRules().protectedArea;
    return !!a && Math.hypot(p.x + 0.5 - a.x, p.y + 0.5 - a.y, p.z + 0.5 - a.z) <= a.r;
  }

  /** Open a chest or barrel next to the bot; rejects with the reason when it does not open. */
  async openContainer(p: Vec3, opts?: OpenOptions): Promise<ContainerView> {
    const r = await this.open(p, opts);
    if (!r.ok) throw new Error(`openContainer ${p.x} ${p.y} ${p.z}: ${r.reason}`);
    return r.view;
  }

  /** Like openContainer, but resolves with `{ ok: false, reason }` instead of rejecting. */
  open(p: Vec3, opts?: OpenOptions): Promise<OpenResult> {
    const chest = this.chest;
    if (!chest) return Promise.resolve({ ok: false, reason: 'no_containers' });
    return this.run('container', () => chest.open(p, opts));
  }

  /** Move every inventory stack that passes `filter` into the open window. */
  deposit(view: ContainerView, filter: (i: ItemStack) => boolean): Promise<DepositResult> {
    const chest = this.chest;
    if (!chest) return Promise.resolve({ ok: false, reason: 'no_containers', moved: {}, total: 0, requests: 0, errors: 0 });
    return this.run('container', () => chest.deposit(view, filter));
  }

  /** Close a container window (waits for the server's container_close). */
  closeContainer(view: ContainerView | number): Promise<boolean> {
    const chest = this.chest;
    if (!chest) return Promise.resolve(false);
    const id = typeof view === 'number' ? view : view.id;
    return this.run('container', () => chest.close(id));
  }

  /**
   * Put a block into cell `p` (docs/interaction.md): by clicking `opts.face` of the neighbour (default:
   * the best one in reach), with `opts.item` (default: the held block item). `p` = the cell the feet
   * stand in builds a pillar (jump, place below, land).
   */
  place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult> {
    const placer = this.placer;
    if (!placer) return Promise.resolve({ ok: false, reason: 'no_placer' });
    return this.run('place', () => placer.place(p, opts));
  }

  /** Open / close a door, gate or trapdoor, press a button, flip a lever (docs/interaction.md). */
  useBlock(p: Vec3, opts?: UseOptions): Promise<UseResult> {
    const user = this.user;
    if (!user) return Promise.resolve({ ok: false, reason: 'no_user' });
    return this.run('use', () => user.useBlock(p, opts));
  }

  /** Door / gate / trapdoor open, lever on, button pressed, per the world model; undefined for other blocks. */
  isOpen(p: Vec3): boolean | undefined {
    return this.user?.isOpen(p);
  }

  /** The tree containing the log at `p` (skills/tree/tree.ts), or undefined. */
  treeAt(p: Vec3, opts?: TreeOptions): Tree | undefined {
    const w = this.world;
    if (!w.blockAt) return undefined;
    return detectTree(w.blockAt.bind(w), p, opts);
  }

  /** Trees with a log within `radius` of `origin` (default the bot), closest base first. */
  findTrees(radius: number, opts: TreeOptions & { origin?: Vec3; maxLogs?: number } = {}): Tree[] {
    const w = this.world;
    if (!w.blockAt || !w.find) return [];
    const origin = opts.origin ?? this.loop.state.pos;
    const logs = w.find((b) => b.name.endsWith('_log') && !b.name.startsWith('stripped_'), { origin, radius, max: 4096, class: 'log' });
    // never a tree inside the base (protectRadius of home): the owner's own trees and log builds stay
    const area = this.nav.breakRules().protectedArea;
    const inBase = (p: Vec3) => !!area && Math.hypot(p.x + 0.5 - area.x, p.y + 0.5 - area.y, p.z + 0.5 - area.z) <= area.r;
    return treesFrom(w.blockAt.bind(w), logs, origin, { skip: (p) => this.nav.blacklist.blocked(p), ...opts }).filter((t) => !t.logs.some(inBase)); // Track R: skip blacklisted logs
  }

  /** Fell a tree from the bottom up, re-pathing when the next log is out of reach (skills/tree/feller.ts). */
  fellTree(tree: Tree, opts: FellOptions = {}): Promise<FellResult> {
    const w = this.world;
    const d = this.digger;
    if (!w.blockAt || !d) {
      return Promise.resolve({ ok: false, reason: 'no_digger', broken: [], left: tree.logs, repaths: 0, digFailures: 0, corrections: 0, ticksDigging: 0 });
    }
    const blockAt = w.blockAt.bind(w);
    return this.run('fell', async (cancelled) => {
      await this.descent; // a dig-down already running finishes first; the feller handles the rest of the scaffold
      return this.whilePlacing(fellTree(
        tree,
        {
          blockAt,
          state: () => this.loop.state,
          dig: (p, o) => d.dig(p, o),
          goto: (g, o) => this.nav.goto(g, o),
          stand: (x, y, z) => this.nav.grid.stand(x, y, z),
          cancelled,
          logger: this.log,
          blacklist: this.nav.blacklist, // Track R
          // pillar-up next to a tall trunk (decision 0051): the PlaceSkill directly (not this.place, which would cancel the fell)
          ...(this.placer ? { place: (p: Vec3) => this.pillarPlace(p), throwaways: () => this.scaffoldBudget() } : {}),
          protectedAt: (p) => this.inProtectedArea(p),
          waitTicks: (n) => this.loop.waitTicks(n),
          scaffold: this.scaffold, // decision 0051: pending scaffold outlives the fell
          hostileNear: () => this.hostileNear(12),
          sneak: (on) => this.loop.setCommand({ sneak: on }),
          drops: () => {
            const out: Vec3[] = [];
            const b = tree.base;
            for (const e of this.world.entities?.values() ?? []) {
              if (e.type !== 'minecraft:item' || !e.item?.name.endsWith('_log')) continue;
              if (Math.hypot(e.pos.x - b.x - 0.5, e.pos.z - b.z - 0.5) <= 8) out.push(e.pos);
            }
            return out;
          },
        },
        opts,
      ));
    });
  }

  cancel(): void {
    this.epoch++;
    this.runningName = undefined;
    this.stopAll();
    void this.descendFirst(); // decision 0051: a cancel on top of the pillar still comes down
  }

  status(): SkillsStatus {
    const s = this.loop.state;
    return {
      health: this.world.self.health,
      food: this.world.self.food,
      damage: [...this.damage],
      corrections: s.corrections,
      motions: s.motions,
      teleports: s.teleports,
      inWater: s.inWater,
      inLava: s.inLava,
      busy: this.nav.busy || this.runningName !== undefined || this.descent !== undefined,
      running: this.runningName,
      lastGoto: this.nav.lastReport,
    };
  }

  private trackHealth(tick: bigint): void {
    const h = this.world.self.health;
    if (this.lastHealth !== undefined && h < this.lastHealth) {
      const l = this.landing;
      const falling = l !== undefined && l.fall > 3 && tick - l.tick <= 20n;
      const e: DamageEvent = { tick, from: this.lastHealth, to: h, falling, ...(falling ? { fallDistance: +l.fall.toFixed(3) } : {}) };
      this.damage.push(e);
      if (this.damage.length > 20) this.damage.shift();
      this.log.info(`health ${e.from} -> ${e.to}${e.falling ? ' (fall)' : ''}`);
    }
    this.lastHealth = h;
  }

  private trackFall(tick: bigint, onGround: boolean, y: number, inWater: boolean): void {
    if (inWater) {
      this.airTop = undefined;
      return;
    }
    if (!onGround) {
      this.airTop = Math.max(this.airTop ?? y, y);
    } else if (this.airTop !== undefined) {
      this.landing = { tick, fall: this.airTop - y };
      this.airTop = undefined;
    }
  }

  private stepLook(): void {
    const l = this.look;
    if (!l) return;
    const cmd = this.loop.command;
    const yaw = turnTowards(cmd.yaw, l.yaw, LOOK_TURN);
    const dp = l.pitch - cmd.pitch;
    const pitch = Math.abs(dp) <= LOOK_TURN ? l.pitch : cmd.pitch + Math.sign(dp) * LOOK_TURN;
    this.loop.setCommand({ yaw, pitch });
    l.ticks++;
    if ((Math.abs(angleDiff(yaw, l.yaw)) < 0.01 && Math.abs(pitch - l.pitch) < 0.01) || l.ticks > 40) {
      this.look = undefined;
      l.resolve();
    }
  }
}

export { Navigator } from './nav/navigator.ts';
export type { GotoReport, NavWorld, NavigatorOptions } from './nav/navigator.ts';
export { ChestSkill, maxStackOf } from './container/chest.ts';
export { detectTree, treesFrom, remainingLogs, logKind, isLog, isLeaves } from './tree/tree.ts';
export { fellTree, standSpots } from './tree/feller.ts';
export { collectItems } from './collect/collect.ts';
export { PlaceSkill, SERVER_CLICK_REACH, DEFAULT_CLICK_REACH } from './place/place.ts';
export { UseSkill, usableKind, openState } from './interact/use.ts';
export { faceIndex, faceOf, faceOffset, neighbour, supportOf, oppositeFace, BLOCK_FACES } from './place/face.ts';
