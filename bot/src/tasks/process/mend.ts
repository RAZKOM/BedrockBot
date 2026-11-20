// Track K5 (ADR 0110, docs/survival.md "Mending (Track K5)"): `!mend` gathers experience on purpose until the damaged
// Mending pieces are mended (or one piece: `!mend elytra`), a time bound is reached, or no source is left; the
// background chore (`autoMend`, default off) does the same at home by day. The job dispatches the bot's own commands
// as steps (the obtain job's way, chat/commands-kit.ts) and the hand (tasks/mend-hand.ts) holds the piece that is only
// carried at each furnace take and after each ore:
//
//   chooseMendSource  the cheapest source at hand: the furnaces where the cooker looks (each opened once a job: what
//                     lies in the output pays the experience stored with it), then a smelt of what is carried (the most
//                     experience an item first, fuel carried), then the same out of the chests at home in reach (the chest
//                     memory says what is there), then an ore the ore memory knows near (a pickaxe that harvests it).
//                     The furnace sources come first: they move the body least (one furnace, the bot waits by it) and
//                     never leave home; mining walks and digs.
//   MendJob           the steps one after the other, the reply at the end
//
// Track K6 (ADR 0110 addendum, docs/survival.md "Mending, part two (Track K6)"): the post (`mendPost`, default off: by night,
// the last source, the bot standing at home or where it idles while the fight rules kill what comes; postCheck) and the
// chore (`autoMend`, default off: by day at home, the furnace outputs and the home stock of raw metal only, a bound of
// MEND_CHORE_ITEMS_HOUR items an hour; MendChore).
import type { Vec3 } from '../../connection/types.ts';
import { mendQueue, pointsToMend, type MendPiece } from '../../skills/survival/mend.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus } from './manager.ts';

/**
 * Experience a furnace pays an item it smelts (BDS 1.26.60.6: the game's table, the cases measured in
 * test/e2e/mend.test.ts MEND_PROBE=furnace). Only what a smelt does not waste: raw metal and ore, raw food, cobblestone
 * (logs and sand are kept: charcoal and glass are worth less to the owner than what goes in).
 */
export const SMELT_XP: Readonly<Record<string, number>> = {
  raw_gold: 1,
  gold_ore: 1,
  deepslate_gold_ore: 1,
  nether_gold_ore: 1,
  raw_iron: 0.7,
  iron_ore: 0.7,
  deepslate_iron_ore: 0.7,
  raw_copper: 0.7,
  copper_ore: 0.7,
  deepslate_copper_ore: 0.7,
  cobblestone: 0.1,
  cobbled_deepslate: 0.1,
};
/** Raw food cooked (`!cook`): 0.35 an item. */
export const FOOD_XP = 0.35;
/** The mean experience an ore pays when mined with a plain pickaxe (the game's ranges; the cases measured). */
export const ORE_XP: Readonly<Record<string, number>> = {
  coal_ore: 1,
  deepslate_coal_ore: 1,
  lapis_ore: 3.5,
  deepslate_lapis_ore: 3.5,
  redstone_ore: 3,
  deepslate_redstone_ore: 3,
  lit_redstone_ore: 3,
  diamond_ore: 5,
  deepslate_diamond_ore: 5,
  emerald_ore: 5,
  deepslate_emerald_ore: 5,
  quartz_ore: 3.5,
  nether_gold_ore: 0.5,
};
/** Most items one smelt step takes (a furnace's input stack). */
export const MEND_SMELT_MAX = 64;
/** Most ores one mine step asks for. */
export const MEND_MINE_MAX = 16;
/** The job's default time bound (minutes). */
export const MEND_DEFAULT_MIN = 15;

export type MendStep =
  | { kind: 'collect'; at: Vec3 }
  | { kind: 'smelt'; item: string; n: number; from: 'carried' | 'home'; xp: number }
  | { kind: 'cook'; n: number; xp: number }
  | { kind: 'mine'; block: string; n: number; xp: number }
  | { kind: 'post'; at: string };

// ---- Track K6: the post (`mendPost`, default off) --------------------------------------------------------------------------
// Kills pay best (a zombie or a skeleton 5 points, 10 uses) and come to the bot at night where it idles. The post is that
// spot: home when one is set (the bot within POST_HOME_NEAR of it; guard centres on home while no command runs), else where
// the bot stands. The job stands there and lets the fight rules (guard, the reflex, the flight rules: none changed) kill what
// comes; the piece is held between kills by the hold rule and each kill's orbs walked to when the walk rule allows. It
// never looks for mobs (no `!kill`), never stays where the night rules would take the bot (a shelter, a bed), and stops at
// dawn, at the trip readiness's bounds (health or food under 14) and at the first flight on foot.

/** With a home set the post is home: the bot within this many blocks of it. */
export const POST_HOME_NEAR = 8;
/** The post's health and food bounds (the trip readiness's PREP_BELOW: under these the bot prepares before a trip). */
export const POST_BELOW = 14;
/**
 * Once the post stands, the bot may be this much farther from home than the guard's radius without the post ending:
 * a guard fight is the post's work (on the idle night fights took the bot 13 to 20 blocks off home, and the 8-block
 * bound with 30 s of grace ended the post in 7 of 10 nights while the guard went on killing).
 */
export const POST_GUARD_SPAN = 8;

/** Track K6: the standing post's home bound: within the guard's ground round home (no home: the post is where it stands). */
export function postWithinGround(home: number | undefined, guardRadius: number): boolean {
  return home === undefined || home <= guardRadius + POST_GUARD_SPAN;
}

/** What the post's rule reads (chat/commands-mend.ts wires the bot). */
export interface PostInput {
  /** Overworld, nether, the_end. */
  dimension: string;
  /** Night by the night process's clock (12 000 to 23 000); undefined: the time is not known. */
  night: boolean | undefined;
  guard: boolean;
  /** A sword or an axe carried (PveController.carriesBlade). */
  blade: boolean;
  /** A chestplate worn (the night rule of `!come`, `!follow` and `!kill` asks for one). */
  chestplate: boolean;
  health: number;
  food: number;
  /** The night rules that would take the bot tonight (`the night shelter`, `the bed`), if any. */
  nightRules?: string | undefined;
  /** Blocks to home when one is set. */
  home?: number | undefined;
}

/** May the post run now (and where it is), or why not. Asked before the step and every half second during it. */
export function postCheck(s: PostInput): { ok: true; at: string } | { ok: false; why: string } {
  if (s.dimension !== 'overworld') return { ok: false, why: `in the ${s.dimension}` };
  if (s.night === undefined) return { ok: false, why: 'the time of day is not known' };
  if (!s.night) return { ok: false, why: 'it is not night' };
  if (!s.guard) return { ok: false, why: 'guard is off (the post is the fight rules killing what comes)' };
  if (!s.blade) return { ok: false, why: 'no sword or axe carried' };
  if (!s.chestplate) return { ok: false, why: 'no chestplate worn' };
  if (s.health < POST_BELOW) return { ok: false, why: `health ${s.health.toFixed(0)} under ${POST_BELOW}` };
  if (s.food < POST_BELOW) return { ok: false, why: `food ${s.food.toFixed(0)} under ${POST_BELOW}` };
  if (s.nightRules) return { ok: false, why: `${s.nightRules} takes me in tonight` };
  if (s.home !== undefined && s.home > POST_HOME_NEAR) return { ok: false, why: `home is ${s.home.toFixed(0)} blocks off (the post is home)` };
  return { ok: true, at: s.home !== undefined ? 'home' : 'here (no home set)' };
}

/** What the post step did: the kills while it stood, why it ended. */
export interface PostResult {
  kills: number;
  why: string;
  ms: number;
}

// ---- Track K6: the chore (`autoMend`, default off) -------------------------------------------------------------------------
/** The chore starts with a Mending piece at or under this share of its uses. */
export const MEND_CHORE_SHARE = 0.75;
/**
 * Items the chore smelts out of the chests at home in an hour at most. 32 raw iron pay about 22 points (45 uses) in 320 s of
 * one furnace and burn 4 coal; a day of 24 such hours stops at 12 stacks, so a stock of ore the owner keeps is not turned
 * into ingots and the carried fuel is not burnt by a chore nobody asked for.
 */
export const MEND_CHORE_ITEMS_HOUR = 32;
/** The chore smelts only what pays this much an item (raw iron, copper, gold): not cobblestone, not food. */
export const MEND_CHORE_MIN_XP = 0.7;
/** The chore runs with the bot this near home (blocks, horizontal) and no hostile this near. */
export const MEND_CHORE_HOME = 16;
/** One chore pass's time bound (minutes): a smelt of 32 is 320 s, with the walks and the withdrawal. */
export const MEND_CHORE_MINUTES = 10;
/** After a pass that mended nothing (ms). */
export const MEND_CHORE_BACKOFF_MS = 10 * 60_000;

/** The chore's sources only: the furnace outputs, and the home stock that pays MEND_CHORE_MIN_XP, `cap` items at most. */
export function choreState(s: MendSourceState, cap: number): MendSourceState {
  const home = new Map([...s.home].filter(([n]) => (SMELT_XP[n] ?? 0) >= MEND_CHORE_MIN_XP));
  return { ...s, carried: new Map(), rawFood: 0, home, ore: undefined, oreBlocked: undefined, post: undefined, maxItems: Math.max(0, cap) };
}

/** The items smelted in the last hour (the chore's bound): a ledger of (time, items). */
export class HourLedger {
  private readonly rows: { t: number; n: number }[] = [];
  add(t: number, n: number): void {
    if (n > 0) this.rows.push({ t, n });
  }
  used(now: number): number {
    while (this.rows.length && now - this.rows[0]!.t >= 3_600_000) this.rows.shift();
    return this.rows.reduce((a, r) => a + r.n, 0);
  }
  left(now: number, cap = MEND_CHORE_ITEMS_HOUR): number {
    return Math.max(0, cap - this.used(now));
  }
}

export interface MendSourceState {
  /** Points still wanted. */
  points: number;
  /** Furnaces where the cooker looks that this job has not opened yet. */
  furnaces: readonly Vec3[];
  /** What is carried, name -> count (slots 0..35). */
  carried: ReadonlyMap<string, number>;
  /** Raw food carried (the cooker's rawFoodCounts). */
  rawFood: number;
  /** Items the carried fuel smelts (smelt.ts fuelItems). */
  fuelItems: number;
  /** What the chests at home hold of the smeltables while they are in reach (the chest memory), name -> count. */
  home: ReadonlyMap<string, number>;
  /** An ore the ore memory knows near with a pickaxe that harvests it, and how many. */
  ore?: { block: string; count: number } | undefined;
  /** Sources that gave nothing in this job (`smelt:raw_iron`, `home:raw_iron`, `cook`, `mine:coal_ore`). */
  tried: ReadonlySet<string>;
  /** Why the ores near are not a source now (the strict rule: a hostile within 16 while the bot would walk and dig). */
  oreBlocked?: string | undefined;
  /** Track K6: the post (`mendPost`): may it run, where, or why not; undefined: not a source to name (off, by day). */
  post?: { ok: true; at: string } | { ok: false; why: string } | undefined;
  /** Track K6: a smelt takes at most this many items (the chore's hour bound). */
  maxItems?: number | undefined;
}

/** The step for the next points (see the file comment); `none` says what is missing. */
export function chooseMendSource(s: MendSourceState): MendStep | { kind: 'none'; why: string } {
  if (s.furnaces.length > 0) return { kind: 'collect', at: s.furnaces[0]! };
  const cap = s.maxItems ?? MEND_SMELT_MAX;
  const want = (xp: number, have: number): number => Math.max(1, Math.min(have, MEND_SMELT_MAX, cap, Math.ceil(s.points / xp)));
  // carried stock, the most experience an item first (Track K6: none past the chore's hour bound)
  const carried = [...s.carried].filter(([n, c]) => c > 0 && SMELT_XP[n] !== undefined && !s.tried.has(`smelt:${n}`)).sort((a, b) => SMELT_XP[b[0]]! - SMELT_XP[a[0]]! || b[1] - a[1]);
  const food = s.rawFood > 0 && !s.tried.has('cook') && cap > 0;
  const best = cap > 0 ? carried[0] : undefined;
  const fuel = s.fuelItems > 0;
  if (fuel && best && (!food || SMELT_XP[best[0]]! >= FOOD_XP)) return { kind: 'smelt', item: best[0], n: Math.min(want(SMELT_XP[best[0]]!, best[1]), s.fuelItems), from: 'carried', xp: SMELT_XP[best[0]]! };
  if (fuel && food) return { kind: 'cook', n: Math.min(s.rawFood, s.fuelItems), xp: FOOD_XP };
  // the chests at home in reach
  const home = [...s.home].filter(([n, c]) => c > 0 && SMELT_XP[n] !== undefined && !s.tried.has(`home:${n}`)).sort((a, b) => SMELT_XP[b[0]]! - SMELT_XP[a[0]]! || b[1] - a[1]);
  const h = cap > 0 ? home[0] : undefined;
  if (fuel && h) return { kind: 'smelt', item: h[0], n: Math.min(want(SMELT_XP[h[0]]!, h[1]), s.fuelItems), from: 'home', xp: SMELT_XP[h[0]]! };
  if (s.ore && ORE_XP[s.ore.block] !== undefined && !s.tried.has(`mine:${s.ore.block}`) && !s.oreBlocked) {
    const xp = ORE_XP[s.ore.block]!;
    return { kind: 'mine', block: s.ore.block, n: Math.max(1, Math.min(s.ore.count, MEND_MINE_MAX, Math.ceil(s.points / xp))), xp };
  }
  // Track K6: the post, last (it puts the body where the mobs come, and only by night)
  if (s.post?.ok && !s.tried.has('post')) return { kind: 'post', at: s.post.at };
  const missing: string[] = [];
  if (cap <= 0) missing.push(`no more smelting this hour (the chore's bound: ${MEND_CHORE_ITEMS_HOUR} items an hour)`);
  else if (!fuel && (best || food || h)) missing.push('fuel (coal, charcoal, planks or logs) for the smelt');
  else missing.push('something to smelt (raw iron, gold or copper, raw food, cobblestone: carried or in the chests at home in reach)');
  if (s.ore && s.oreBlocked && !s.tried.has(`mine:${s.ore.block}`)) missing.push(`or the ${s.ore.block} near mined (not now: ${s.oreBlocked})`);
  else missing.push('or a coal, lapis, redstone, diamond or quartz ore the bot has seen near with a pickaxe');
  if (s.post && !s.post.ok) missing.push(`or a night at the post (not now: ${s.post.why})`);
  return { kind: 'none', why: `no source of experience: needs ${missing.join(', ')}` };
}

/** The tried key of a step (a step that gave nothing is not chosen again in the job). */
export function stepKey(s: MendStep): string {
  if (s.kind === 'post') return 'post';
  return s.kind === 'collect' ? `collect:${s.at.x},${s.at.y},${s.at.z}` : s.kind === 'smelt' ? `${s.from === 'home' ? 'home' : 'smelt'}:${s.item}` : s.kind === 'cook' ? 'cook' : `mine:${s.block}`;
}

/** The command a step dispatches (the furnace collect and the home withdrawal are calls, not commands). */
export function stepCommand(s: MendStep): string | undefined {
  if (s.kind === 'smelt') return `smelt ${s.item} ${s.n}`;
  if (s.kind === 'cook') return 'cook';
  if (s.kind === 'mine') return `mine ${s.block} ${s.n}`;
  return undefined;
}

/** What a step did, for the end line: `smelted 64 raw_iron`, `took the output of the furnace at x y z`. */
export function stepDone(s: MendStep, n: number): string {
  if (s.kind === 'collect') return `took ${n} out of the furnace at ${s.at.x} ${s.at.y} ${s.at.z}`;
  if (s.kind === 'smelt') return `smelted ${n} ${s.item}${s.from === 'home' ? ' from the chests at home' : ''}`;
  if (s.kind === 'cook') return `cooked ${n} raw food`;
  if (s.kind === 'post') return `stood at the post (${s.at}) for ${n} kill${n === 1 ? '' : 's'}`;
  return `mined ${n} ${s.block}`;
}

/** The pieces the job mends (`want`: one kind) and the points they still need. */
export function mendNeed(pieces: readonly MendPiece[], want?: string): { queue: MendPiece[]; points: number } {
  const queue = mendQueue(pieces, want);
  return { queue, points: queue.reduce((a, p) => a + pointsToMend(p), 0) };
}

/** `elytra 131 -> 302/432, diamond_pickaxe 1200 -> 1250/1561` (pieces matched by name and the order they had). */
export function gainLine(before: readonly MendPiece[], after: readonly MendPiece[]): string {
  const used = new Set<MendPiece>();
  const parts: string[] = [];
  for (const b of before) {
    const a = after.find((x) => !used.has(x) && x.name === b.name && x.mending);
    if (!a) continue;
    used.add(a);
    if (a.left === b.left) continue;
    parts.push(`${b.name} ${b.left} -> ${a.left}/${a.max}`);
  }
  return parts.join(', ');
}

/** `!mend` arguments: `[piece] [minutes]`, `status`, `stop`. */
export function parseMendArgs(args: readonly string[]): { kind: 'status' } | { kind: 'stop' } | { kind: 'run'; want?: string; minutes: number } | { kind: 'error'; why: string } {
  const words = args.map((w) => w.toLowerCase().replace(/^minecraft:/, '')).filter((w) => w !== '');
  if (words.length === 1 && words[0] === 'status') return { kind: 'status' };
  if (words.length === 1 && words[0] === 'stop') return { kind: 'stop' };
  let minutes = MEND_DEFAULT_MIN;
  const last = words[words.length - 1];
  if (last !== undefined && /^\d+$/.test(last)) {
    minutes = Number(words.pop());
    if (minutes < 1 || minutes > 120) return { kind: 'error', why: 'minutes are 1..120' };
  }
  if (words.length > 1) return { kind: 'error', why: 'one piece at most' };
  return words[0] ? { kind: 'run', want: words[0], minutes } : { kind: 'run', minutes };
}

// ---- the job ------------------------------------------------------------------------------------------------------------

/** What the job reads and runs (chat/commands-mend.ts wires the bot; unit tests pass fakes). */
export interface MendJobDeps {
  pieces(): MendPiece[];
  /** The hand's job switches (tasks/mend-hand.ts): the piece to give the turn, the holds forced on, the ore hold. */
  hand: { want: string | undefined; job: boolean; stage?(): Promise<void>; unstage?(): Promise<void>; refusal?: string | undefined };
  /** The strict rule for the mine source (a hostile within 16: its line), or undefined. */
  oreBlocked?(): string | undefined;
  /** The furnaces where the cooker looks. */
  furnaces(): Vec3[];
  /** Wait out what is in the furnace at `at` and take its output (SmeltControl.collect); items taken. */
  collect(at: Vec3): Promise<number>;
  carried(): ReadonlyMap<string, number>;
  rawFood(): number;
  fuelItems(): number;
  /** The smeltables in the chests at home while they are in reach (the chest memory). */
  home(): ReadonlyMap<string, number>;
  /** Take `n` of `item` out of the chests at home (the home withdrawal); items taken. */
  withdraw(item: string, n: number): Promise<number>;
  /** An ore the ore memory knows near with a pickaxe that harvests it. */
  ore(): { block: string; count: number } | undefined;
  /** Dispatch a command and wait for its process (`name`) to end or `ms` to pass; the last reply meanwhile. */
  run(command: string, name: string, ms: number, aborted: () => boolean): Promise<string | undefined>;
  /** Track K6: may the post run now (postCheck with `mendPost`); undefined: not named (the setting off by day). */
  post?(): { ok: true; at: string } | { ok: false; why: string } | undefined;
  /** Track K6: stand at the post until `stop` says why or the post's rule ends it; the kills meanwhile. */
  stand?(stop: () => string | undefined): Promise<PostResult>;
  now(): number;
  log?: { info(m: string): void };
}

/** A step's time bound (ms): a smelt of 64 is 640 s. */
export const MEND_STEP_MS = 12 * 60_000;

export interface MendReport {
  line: string;
  /** Uses mended over every piece. */
  uses: number;
  steps: string[];
  why: string;
}

const refusalOf = (h: { refusal?: string | undefined }): string | undefined => h.refusal;

/** Uses over the Mending pieces (for the gain). */
const usesOf = (ps: readonly MendPiece[]): number => ps.filter((p) => p.mending).reduce((a, p) => a + p.left, 0);

/** One `!mend` (or chore) job: steps until mended, the time bound, no source, or stopped (see the file comment). */
export class MendJob {
  readonly want: string | undefined;
  readonly minutes: number;
  phase = 'starting';
  aborted: string | undefined;
  readonly startedAt: number;
  private readonly d: MendJobDeps;
  /** Track K6: the chore's job: its sources only (choreState), `cap()` items still allowed this hour, `spent` told each smelt. */
  readonly chore: { cap(): number; spent(n: number): void } | undefined;

  constructor(d: MendJobDeps, want: string | undefined, minutes: number, chore?: { cap(): number; spent(n: number): void }) {
    this.d = d;
    this.want = want;
    this.minutes = minutes;
    this.startedAt = d.now();
    this.chore = chore;
  }

  async run(): Promise<MendReport> {
    const d = this.d;
    const before = d.pieces();
    const first = mendNeed(before, this.want);
    if (first.queue.length === 0) {
      const has = before.filter((p) => p.mending && (!this.want || p.name === this.want));
      const why = this.want ? (has.length ? `the ${this.want} is mended (${has.map((p) => `${p.left}/${p.max}`).join(', ')})` : `no ${this.want} with Mending carried, worn or held`) : has.length ? 'every Mending piece is mended' : 'nothing with Mending carried, worn or held';
      return { line: `mend: ${why}`, uses: 0, steps: [], why };
    }
    const tried = new Set<string>();
    const opened = new Set<string>();
    const steps: string[] = [];
    let why: string;
    /** The last refusal of the hand in a step that mended nothing. */
    let cause: string | undefined;
    /** Track K6: why the post ended (dawn, a bound, a flight): the job's end. */
    let postEnd: string | undefined;
    d.hand.want = this.want;
    d.hand.job = true;
    try {
      await d.hand.stage?.();
      for (;;) {
        if (this.aborted) {
          why = `stopped (${this.aborted})`;
          break;
        }
        if (d.now() - this.startedAt > this.minutes * 60_000) {
          why = `the ${this.minutes}-minute bound`;
          break;
        }
        const need = mendNeed(d.pieces(), this.want);
        if (need.points <= 0) {
          why = this.want ? `the ${this.want} is mended` : 'every Mending piece is mended';
          break;
        }
        const furnaces = d.furnaces().filter((p) => !opened.has(`${p.x},${p.y},${p.z}`));
        const state: MendSourceState = { points: need.points, furnaces, carried: d.carried(), rawFood: d.rawFood(), fuelItems: d.fuelItems(), home: d.home(), ore: this.chore ? undefined : d.ore(), tried, oreBlocked: this.chore ? undefined : d.oreBlocked?.(), post: this.chore ? undefined : d.post?.() };
        const step = chooseMendSource(this.chore ? choreState(state, this.chore.cap()) : state);
        if (step.kind === 'none') {
          why = step.why;
          break;
        }
        const u0 = usesOf(d.pieces());
        const key = stepKey(step);
        d.hand.refusal = undefined;
        let n = 0;
        if (step.kind === 'collect') {
          opened.add(`${step.at.x},${step.at.y},${step.at.z}`);
          this.phase = `the output of the furnace at ${step.at.x} ${step.at.y} ${step.at.z}`;
          n = await d.collect(step.at);
        } else if (step.kind === 'post') {
          // Track K6: stand at the post until dawn, the bounds, a flight, the time bound, mended, or stopped
          this.phase = `at the post (${step.at}) by night`;
          const stop = (): string | undefined => {
            if (this.aborted) return `stopped (${this.aborted})`;
            if (d.now() - this.startedAt > this.minutes * 60_000) return `the ${this.minutes}-minute bound`;
            if (mendNeed(d.pieces(), this.want).points <= 0) return 'mended';
            return undefined;
          };
          const r = d.stand ? await d.stand(stop) : { kills: 0, why: 'no post', ms: 0 };
          n = r.kills;
          tried.add(key);
          postEnd = r.why === 'mended' ? undefined : `the post: ${r.why}`;
          d.log?.info(`mend: the post ended after ${Math.round(r.ms / 1000)} s: ${r.why}`);
        } else {
          if (step.kind === 'smelt' && step.from === 'home') {
            this.phase = `${step.n} ${step.item} out of the chests at home`;
            const got = await d.withdraw(step.item, step.n);
            if (got <= 0 || this.aborted) {
              tried.add(key);
              continue;
            }
          }
          const cmd = stepCommand(step)!;
          const name = step.kind === 'smelt' ? 'smelt' : step.kind === 'cook' ? 'cook' : 'mine';
          const c0 = step.kind === 'smelt' ? (d.carried().get(step.item) ?? 0) : step.kind === 'cook' ? d.rawFood() : 0;
          this.phase = `!${cmd}`;
          const last = await d.run(cmd, name, MEND_STEP_MS, () => this.aborted !== undefined || d.now() - this.startedAt > this.minutes * 60_000);
          n = step.kind === 'smelt' ? c0 - (d.carried().get(step.item) ?? 0) : step.kind === 'cook' ? c0 - d.rawFood() : Number(/(\d+)\/\d+/.exec(last ?? '')?.[1] ?? 0);
          if (step.kind === 'smelt' && n > 0) this.chore?.spent(n);
          d.log?.info(`mend: !${cmd}: ${last ?? 'no reply'}`);
        }
        const gained = usesOf(d.pieces()) - u0;
        if (n > 0 || step.kind === 'post') steps.push(stepDone(step, n));
        if (n <= 0 || gained <= 0) tried.add(key);
        // a step that paid nothing: the hand's last refusal says why (`not held: a zombie 5 blocks off with a clear way to me`)
        // (read through a function: the step's awaits set it, which the narrowing above does not see)
        const refused = gained <= 0 ? refusalOf(d.hand) : undefined;
        if (refused) cause = refused;
        d.log?.info(`mend: ${stepDone(step, n)}: +${gained} uses${refused ? ` (${refused})` : ''}`);
        if (postEnd) {
          why = postEnd;
          break;
        }
      }
    } finally {
      await d.hand.unstage?.();
      d.hand.want = undefined;
      d.hand.job = false;
      this.phase = 'done';
    }
    const after = d.pieces();
    const uses = usesOf(after) - usesOf(before);
    const min = Math.max(1, Math.round((d.now() - this.startedAt) / 60_000));
    const gain = gainLine(first.queue, after);
    // nothing mended: the line names the cause (the hand's refusal, or that the steps paid experience the piece never got)
    // (no step at all: the stop reason says why)
    const zero = cause ?? (steps.length ? 'no orb reached a Mending piece in the hand or worn' : undefined);
    const none = uses > 0 || !zero ? '' : ` (uses gained 0: ${zero})`;
    return { line: `mend: ${gain || 'nothing mended'}${none} in ${min} min${steps.length ? `: ${steps.join(', ')}` : ''}; stopped: ${why}`, uses, steps, why };
  }
}

// ---- Track K6: the chore ---------------------------------------------------------------------------------------------------

/** The Mending piece the chore is for: one at or under MEND_CHORE_SHARE of its uses (worst share first), or undefined. */
export function choreLow(pieces: readonly MendPiece[]): MendPiece | undefined {
  return mendQueue(pieces).find((p) => p.left / p.max <= MEND_CHORE_SHARE);
}

/** What the chore reads (chat/commands-mend.ts wires the bot; unit tests pass fakes). */
export interface MendChoreDeps {
  processes: Pick<ProcessManager, 'userProcesses'>;
  settings: { get(k: 'autoMend'): boolean };
  /** By day (the chores' clock). */
  isDay(): boolean;
  home(): Vec3 | undefined;
  position(): Vec3;
  /** A hostile within MEND_CHORE_HOME (the strict rule: the chore walks to the chests and the furnace), its line. */
  threat(): string | undefined;
  /** Not held by a test save or a respawn. */
  idle?(): boolean;
  pieces(): MendPiece[];
  /** A typed `!mend` job runs. */
  busy(): boolean;
  /** A job with the chore's sources (MendJob with `chore`). */
  job(chore: { cap(): number; spent(n: number): void }): MendJob;
  /** Stop what the job runs (the walk, the furnace). */
  cancel(): void;
  now?(): number;
  log?: { info(m: string): void; warn(m: string): void };
}

/**
 * autoMend (auto, PRIORITY.chore, default off): by day, no user process, the bot within MEND_CHORE_HOME of home, no hostile
 * that near, a Mending piece at or under MEND_CHORE_SHARE of its uses and the hour's bound not reached: a `!mend` job with
 * the cheap sources only (the furnace outputs where the cooker looks, a smelt of raw metal out of the chests at home in
 * reach), never the ore near or the post. A pass that mended nothing waits MEND_CHORE_BACKOFF_MS.
 */
export class MendChore extends BaseProcess {
  readonly kind = 'auto' as const;
  readonly name = 'mend';
  private run0: MendJob | undefined;
  private lastCheck = -Infinity;
  nextTry = -Infinity;
  readonly ledger = new HourLedger();
  readonly stats = { started: 0, finished: 0, uses: 0 };
  last: MendReport | undefined;
  lastWhy = '';
  private readonly d: MendChoreDeps;

  constructor(d: MendChoreDeps) {
    super();
    this.d = d;
    this.persistent = true;
  }

  private now(): number {
    return (this.d.now ?? (() => performance.now()))();
  }

  get priority(): number {
    return PRIORITY.chore;
  }

  get running(): boolean {
    return this.run0 !== undefined;
  }

  /** The pass running now. */
  get current(): MendJob | undefined {
    return this.run0;
  }

  override wants(): boolean {
    const d = this.d;
    if (this.run0) return d.isDay() && !d.threat();
    const now = this.now();
    if (now - this.lastCheck < 1000 || now < this.nextTry) return false;
    this.lastCheck = now;
    if (!d.settings.get('autoMend')) return false;
    if (!d.isDay() || d.busy() || d.processes.userProcesses().length > 0 || !(d.idle?.() ?? true)) return false;
    const home = d.home();
    if (!home) {
      this.lastWhy = 'no home set';
      return false;
    }
    const me = d.position();
    if (Math.hypot(me.x - home.x, me.z - home.z) > MEND_CHORE_HOME) return false;
    if (d.threat()) return false;
    const low = choreLow(d.pieces());
    if (!low) {
      this.lastWhy = `no Mending piece at or under ${Math.round(MEND_CHORE_SHARE * 100)} % of its uses`;
      return false;
    }
    if (this.ledger.left(now) <= 0) {
      this.lastWhy = `the bound of ${MEND_CHORE_ITEMS_HOUR} items smelted in the last hour`;
      this.nextTry = now + 60_000;
      return false;
    }
    this.run0 = d.job({ cap: () => this.ledger.left(this.now()), spent: (n) => this.ledger.add(this.now(), n) });
    this.stats.started++;
    this.lastWhy = '';
    d.log?.info(`mend chore: the ${low.name} at ${low.left}/${low.max}`);
    return true;
  }

  protected run(t: number): void {
    const job = this.run0;
    if (job?.phase !== 'starting') return;
    void job.run().then(
      (r) => {
        if (this.run0 !== job) return;
        this.end(job, r);
      },
      (err: unknown) => {
        this.d.log?.warn(`mend chore: ${err instanceof Error ? err.message : String(err)}`);
        if (this.run0 === job) this.end(job, undefined);
      },
    );
    void t;
  }

  private end(job: MendJob, r: MendReport | undefined): void {
    this.run0 = undefined;
    this.last = r;
    this.stats.finished++;
    const gained = (r?.uses ?? 0) > 0;
    if (r) this.stats.uses += r.uses;
    // a pass cut short (a command, a fight, the night) is asked again soon; one that mended nothing waits
    this.nextTry = this.now() + (gained || job.aborted ? 1000 : MEND_CHORE_BACKOFF_MS);
    this.d.log?.info(`mend chore: ${r ? r.line : 'error'}`);
    this.yieldControl();
  }

  protected halt(): void {
    const job = this.run0;
    if (job && !job.aborted) job.aborted = 'the chore was pre-empted';
    this.d.cancel();
  }

  protected override reset(): void {
    if (this.run0) this.run0.aborted = 'stopped';
  }

  /** Stop the running pass (a typed `!mend`). */
  drop(): void {
    if (this.run0) this.run0.aborted = 'a typed !mend';
  }

  status(): ProcessStatus {
    return { line: this.run0 ? `mend chore: ${this.run0.phase}` : 'mend (auto)' };
  }

  /** `autoMend on, running: !smelt raw_iron 16; 16 of 32 items this hour` for `!mend status`. */
  line(): string {
    const on = this.d.settings.get('autoMend');
    const used = this.ledger.used(this.now());
    return `autoMend ${on ? 'on' : 'off'}${this.run0 ? `, running: ${this.run0.phase}` : ''}${used ? `; ${used} of ${MEND_CHORE_ITEMS_HOUR} items this hour` : ''}${on && this.lastWhy ? ` (${this.lastWhy})` : ''}`;
  }
}
