// Track K5 (ADR 0110, docs/survival.md "Mending (Track K5)"): the hand that holds a damaged Mending piece the bot only
// carries while experience comes in, and gives the hand back after. Mending repairs only what is worn or held when the
// orbs are picked up (skills/survival/mend.ts), and the elytra, a spare tool or a trident are carried between uses; the
// main hand takes any item (the offhand refuses an elytra), so the piece goes there for that moment.
//
// - The furnace (skills/food/cook.ts CookerDeps.mend): before the furnace is opened a piece in the main inventory comes
//   into the hotbar (one swap with the inventory screen; the screen cannot be opened over the furnace's), it is held
//   for each output take (the furnace pays its experience as orbs at the body when the output is taken) and until the
//   orbs are gone, the slot held before comes back, and after the furnace is closed the swap is undone.
// - Orbs near (the watcher, every tick): orbs within ORB_NEAR of the feet with the hand free (no user process, no walk,
//   no fight, the survival kit idle, not gliding) and no hostile within MEND_THREAT: the same hold, and one short walk to
//   an orb that still lies farther than ORB_PICKED after ORB_WALK_AFTER ticks (a kill's orbs fall 4 to 6 blocks off). A reflex kill and
//   the end of a guard fight leave their orbs this way; while a hostile is near the blade stays in the hand.
// - The `!mend` mine step (skills/mine/miner.ts MinerDeps.afterOre): after each ore the same hold before the next dig.
// Nothing here takes armour off or touches the offhand: a fight keeps its blade, its shield and its armour.
import { silentLogger, type Logger } from '../log.ts';
import { gearPieces, turnPiece, type GearInventory, type MendPiece } from '../skills/survival/mend.ts';
import { maxDurability } from '../skills/survival/tools.ts';
import type { EntityInfo, Vec3 } from '../world/types.ts';

/** Orbs this near the feet are coming to the body (the game draws them in from about 8 blocks). */
export const ORB_NEAR = 8;
/** A hostile this near: no hold (the hand keeps the blade). */
export const MEND_THREAT = 16;
/** A hold waits this many ticks at least for the orbs to appear (a furnace take: they come with the response). */
export const HOLD_MIN_TICKS = 6;
/**
 * An ore's or a furnace take's hold waits this long at least: the orbs come into view some ticks after the break or
 * the take (measured on the test server: with the 6-tick minimum 3 of 5 points of a coal vein went to the bar, the
 * pickaxe already back in the hand; a take's last point went to the bar in 1 run of 15). The watcher's hold starts on
 * orbs already near and keeps HOLD_MIN_TICKS.
 */
export const HOLD_ORE_MIN_TICKS = 16;
/** ... ends after this many ticks with no orb near ... */
export const HOLD_CLEAR_TICKS = 4;
/** ... and lasts this long at most (measured: an orb summoned at the feet was picked up 0.03 to 3.1 s later). */
export const HOLD_MAX_TICKS = 70;
/** The watcher walks to an orb still farther than ORB_PICKED this many ticks into its hold. */
export const ORB_WALK_AFTER = 20;
/** An orb this near the feet is being picked up. */
export const ORB_PICKED = 1.5;
/** After a watcher hold that mended nothing, no watcher hold for this long (orbs that lie out of reach). */
export const WATCH_QUIET_TICKS = 200;

export interface MendHandDeps {
  inventory: GearInventory;
  select(slot: number): void;
  /** Two inventory slots exchanged (the survival kit's swap: the inventory screen). */
  swap(a: number, b: number): Promise<{ ok: boolean; reason?: string }>;
  /** A stack moved into an empty slot (the survival kit's moveSlot: the inventory screen, the enchantments kept). */
  move?(from: number, to: number): Promise<{ ok: boolean; reason?: string }>;
  entities(): ReadonlyMap<bigint, EntityInfo>;
  position(): Vec3;
  /**
   * The watcher's walk to an orb that lies (a kill's orbs fall 4 to 6 blocks off and were not drawn in: measured), feet
   * within 1 of it, no digging, a few seconds at most; ok when it got there. Without it no walk.
   */
  walkTo?(p: Vec3): Promise<boolean>;
  /** A hostile within MEND_THREAT (the line), or undefined. */
  threat(): string | undefined;
  /** The hand is free for the watcher: no user process, no walk, no fight, the kit idle, not gliding. */
  handFree(): boolean;
  /** `mendOnTheWay` and the worn-tool limits. */
  settings(): { on: boolean; toolWearLimit: number; mendAt: number };
  waitTicks(n: number): Promise<void>;
  log?: Logger;
}

/** A piece brought into the hotbar for a hold (undone after). */
export interface MendPrep {
  piece: MendPiece;
  /** The hotbar slot it is held in. */
  hot: number;
  /** The swap or move that brought it there (undone after), when it was in the main inventory: slot a hotbar, b where it was. */
  swapped?: { a: number; b: number; move?: boolean };
}

export interface HoldResult {
  piece?: string;
  before?: number;
  after?: number;
  /** Why no hold: off, none (no damaged Mending piece only carried), hostile, busy, swap failed. */
  why?: string;
}

/** Orbs within `r` of `at`. */
export function orbsNear(entities: ReadonlyMap<bigint, EntityInfo>, at: Vec3, r = ORB_NEAR): number {
  let n = 0;
  for (const e of entities.values()) if (e.type.endsWith('xp_orb') && Math.hypot(e.pos.x - at.x, e.pos.y - at.y, e.pos.z - at.z) <= r) n++;
  return n;
}

/** The nearest orb within `r` of `at`. */
export function nearestOrb(entities: ReadonlyMap<bigint, EntityInfo>, at: Vec3, r = ORB_NEAR): { p: Vec3; d: number } | undefined {
  let best: { p: Vec3; d: number } | undefined;
  for (const e of entities.values()) {
    if (!e.type.endsWith('xp_orb')) continue;
    const d = Math.hypot(e.pos.x - at.x, e.pos.y - at.y, e.pos.z - at.z);
    if (d <= r && (!best || d < best.d)) best = { p: { ...e.pos }, d };
  }
  return best;
}

/**
 * The hotbar slot a piece in the main inventory is swapped into: one that is not held and holds an item without
 * durability other than rockets (a block, food: the hand keeps its blade or tool, the flight its rockets), the last
 * such first; undefined when there is none (no hold: a swap would take a blade or a tool out of the hotbar).
 */
export function hotbarFor(slots: readonly ({ name: string; count: number } | null)[], selected: number): number | undefined {
  for (let i = 8; i >= 0; i--) {
    const s = slots[i];
    if (i === selected || !s || s.count <= 0) continue;
    if (maxDurability(s.name) !== undefined || s.name === 'firework_rocket') continue;
    return i;
  }
  return undefined;
}

export class MendHand {
  private readonly d: MendHandDeps;
  private readonly log: Logger;
  private running = false;
  /** Uses mended in holds, by why (`furnace`, `orbs`, `ore`), and the holds made. */
  readonly stats: { holds: number; walks: number; uses: Record<string, number>; skipped: Record<string, number> } = { holds: 0, walks: 0, uses: {}, skipped: {} };
  /** `!mend <piece>`: the turn goes to this kind only (held pieces too); undefined: the rule's choice. */
  want: string | undefined;
  /** A `!mend` job runs: the holds are on whatever `mendOnTheWay` says, and the miner holds after each ore. */
  job = false;

  constructor(d: MendHandDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
  }

  get busy(): boolean {
    return this.running;
  }

  /** Holds are on: `mendOnTheWay`, or a `!mend` job. */
  on(): boolean {
    return this.job || this.d.settings().on;
  }

  /** The miner's hook (MineDeps.afterOre): in a `!mend` job only, a hold while the ore's orbs come. */
  async afterOre(): Promise<void> {
    if (!this.job) return;
    await this.catchOrbs('ore');
  }

  private pieces(): MendPiece[] {
    const s = this.d.settings();
    return gearPieces(this.d.inventory, s.toolWearLimit, s.mendAt);
  }

  /** The piece that would get the hand now (undefined: none, or the setting off). */
  turn(force = false): MendPiece | undefined {
    if (!force && !this.on()) return undefined;
    return turnPiece(this.pieces(), this.want);
  }

  private skip(why: string): HoldResult {
    this.stats.skipped[why] = (this.stats.skipped[why] ?? 0) + 1;
    return { why };
  }

  /**
   * Bring the turn piece into the hotbar (a swap with the inventory screen when it is in the main inventory). Not with a
   * container open (the furnace calls this before it opens). Undefined: nothing to hold (`why` in the log only).
   */
  async prepare(force = false): Promise<MendPrep | undefined> {
    const p = this.turn(force);
    if (!p) return undefined;
    // a `!mend` job's piece already in the hotbar (stage): held from there, nothing to undo per hold
    const st = this.staged;
    if (st && this.d.inventory.slots[st.hot]?.name === st.piece.name && p.name === st.piece.name) return { piece: { ...p, slot: st.hot }, hot: st.hot };
    if (this.d.threat()) return undefined;
    if (p.slot < 9) return { piece: p, hot: p.slot };
    const inv = this.d.inventory;
    // an empty hotbar slot first (a move displaces nothing), else one holding no tool, weapon or rocket (a swap)
    let empty: number | undefined;
    for (let i = 0; i < 9 && this.d.move; i++) if (i !== inv.selected && !inv.slots[i]) empty = empty ?? i;
    if (empty !== undefined && this.d.move) {
      const m = await this.d.move(p.slot, empty);
      if (m.ok) return { piece: { ...p, slot: empty }, hot: empty, swapped: { a: empty, b: p.slot, move: true } };
    }
    const h = hotbarFor(inv.slots, inv.selected);
    if (h === undefined) return undefined;
    const r = await this.d.swap(h, p.slot);
    if (!r.ok) {
      this.log.info(`mend: could not bring the ${p.name} into the hotbar (${r.reason ?? 'refused'})`);
      return undefined;
    }
    return { piece: { ...p, slot: h }, hot: h, swapped: { a: h, b: p.slot } };
  }

  /** A `!mend` job's piece brought into the hotbar once for the whole job (the per-ore swap is slower than the orbs). */
  private staged: MendPrep | undefined;

  /** Track K5: a `!mend` job starts: its turn piece into the hotbar until unstage (the holds only select it). */
  async stage(): Promise<void> {
    await this.unstage();
    const p = await this.prepare(true);
    this.staged = p;
    if (p?.swapped) this.log.info(`mend: the ${p.piece.name} in hotbar slot ${p.hot} for the job`);
  }

  /** The job's end: the staged piece back where it was. */
  async unstage(): Promise<void> {
    const s = this.staged;
    this.staged = undefined;
    await this.unprepare(s);
  }

  /** Undo a prepare's swap (when both slots still hold what the swap put there). */
  async unprepare(prep: MendPrep | undefined): Promise<void> {
    if (!prep?.swapped) return;
    const inv = this.d.inventory;
    const { a, b, move } = prep.swapped;
    if (inv.slots[a]?.name !== prep.piece.name) return;
    // back where it was: by a move when that slot is empty now (the furnace took the stack the swap put there), else by
    // the swap back; a move whose slot was filled meanwhile leaves the piece in the hotbar
    const back = !inv.slots[b] ? (this.d.move ? this.d.move(a, b) : undefined) : move ? undefined : this.d.swap(a, b);
    if (!back) return;
    const r = await back;
    if (!r.ok) this.log.info(`mend: the ${prep.piece.name} stays in hotbar slot ${a} (${r.reason ?? 'refused'})`);
  }

  /**
   * Hold the prepared piece in the hand while orbs come (`act`: the take that pays them, run with the piece held), then
   * the slot held before comes back. Ends early when a hostile comes within MEND_THREAT.
   */
  async hold<T>(prep: MendPrep, why: string, act?: () => Promise<T>): Promise<{ hold: HoldResult; value?: T }> {
    const inv = this.d.inventory;
    const before = inv.slots[prep.hot];
    if (before?.name !== prep.piece.name) {
      const hold = this.skip('moved');
      return act ? { hold, value: await act() } : { hold };
    }
    const prev = inv.selected;
    const left0 = prep.piece.left;
    let ticks = 0;
    let seen = 0;
    // why the hold ended, for its line (a hold that ends at once mends nothing: the line must say what ended it)
    let ended = 'the time limit';
    this.running = true;
    let value: T | undefined;
    try {
      if (prev !== prep.hot) this.d.select(prep.hot);
      await this.d.waitTicks(1);
      if (act) value = await act();
      let clear = 0;
      let walked = false;
      for (; ticks < HOLD_MAX_TICKS; ticks++) {
        const t = ticks;
        await this.d.waitTicks(1);
        const threat = this.d.threat();
        if (threat) {
          ended = `a hostile near (${threat})`;
          break;
        }
        if (inv.selected !== prep.hot) {
          ended = `the hand was taken (hotbar slot ${inv.selected}: ${inv.slots[inv.selected]?.name ?? 'empty'})`; // a skill took the hand
          break;
        }
        // orbs that lie where they fell (a kill's, an ore's, a furnace's behind its block): one short walk to the nearest
        // (the hold goes on meanwhile); not during a furnace take, whose window is open
        if (why !== 'furnace' && !walked && t >= ORB_WALK_AFTER && this.d.walkTo) {
          const o = nearestOrb(this.d.entities(), this.d.position());
          if (o && o.d > ORB_PICKED) {
            walked = true;
            this.stats.walks++;
            await this.d.walkTo(o.p);
            continue;
          }
        }
        const n = orbsNear(this.d.entities(), this.d.position());
        seen = Math.max(seen, n);
        clear = n === 0 ? clear + 1 : 0;
        if (t >= (why === 'orbs' ? HOLD_MIN_TICKS : HOLD_ORE_MIN_TICKS) && clear >= HOLD_CLEAR_TICKS) {
          ended = 'no orb near';
          break;
        }
      }
    } finally {
      if (inv.selected === prep.hot && prev !== prep.hot) this.d.select(prev);
      this.running = false;
    }
    const now = this.pieces().find((x) => x.name === prep.piece.name && (x.slot === prep.hot || x.where === 'held')) ?? undefined;
    const after = now?.left ?? left0;
    this.stats.holds++;
    if (after > left0) this.stats.uses[why] = (this.stats.uses[why] ?? 0) + (after - left0);
    this.log.info(`mend: held the ${prep.piece.name} for ${why} ${ticks} ticks (orbs near: ${seen}; ended: ${ended}): ${left0} -> ${after}/${prep.piece.max}`);
    return { hold: { piece: prep.piece.name, before: left0, after }, ...(act ? { value: value as T } : {}) };
  }

  /**
   * A furnace job's end (the window closed): orbs of its takes still lying within ORB_NEAR (measured: 2 runs of 15 the
   * take's hold ran its 70 ticks with 2 orbs near that never came) are walked to with the piece held; then the piece
   * goes back.
   */
  async finish(prep: MendPrep | undefined): Promise<void> {
    try {
      if (prep && !this.running && !this.d.threat() && orbsNear(this.d.entities(), this.d.position()) > 0) await this.hold(prep, 'furnace orbs');
    } finally {
      await this.unprepare(prep);
    }
  }

  /** prepare, hold, unprepare: the watcher's and the miner's hold (no container open). */
  async catchOrbs(why: string, force = false): Promise<HoldResult> {
    if (this.running) return this.skip('busy');
    if (!force && !this.on()) return this.skip('off');
    if (this.d.threat()) return this.skip('hostile');
    this.running = true;
    let prep: MendPrep | undefined;
    try {
      prep = await this.prepare(force);
    } finally {
      this.running = false;
    }
    if (!prep) return this.skip('none');
    try {
      return (await this.hold(prep, why)).hold;
    } finally {
      await this.unprepare(prep);
    }
  }

  /** Watcher ticks; no watcher hold before quietUntil (after a hold that mended nothing: orbs that do not come). */
  private ticks = 0;
  private quietUntil = 0;

  /** The watcher (every tick): orbs near with the hand free and no hostile near: a hold. */
  tick(): void {
    this.ticks++;
    if (this.running || this.ticks < this.quietUntil || !this.on()) return;
    if (orbsNear(this.d.entities(), this.d.position()) === 0) return;
    if (!this.d.handFree() || this.d.threat()) return;
    if (!this.turn()) return;
    void this.catchOrbs('orbs')
      .then((r) => {
        if (r.after === undefined || r.after === r.before) this.quietUntil = this.ticks + WATCH_QUIET_TICKS;
      })
      .catch((err: unknown) => this.log.warn(`mend: ${err instanceof Error ? err.message : String(err)}`));
  }
}
