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
import type { Vec3 } from '../../connection/types.ts';
import { mendQueue, pointsToMend, type MendPiece } from '../../skills/survival/mend.ts';

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
  | { kind: 'mine'; block: string; n: number; xp: number };

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
}

/** The step for the next points (see the file comment); `none` says what is missing. */
export function chooseMendSource(s: MendSourceState): MendStep | { kind: 'none'; why: string } {
  if (s.furnaces.length > 0) return { kind: 'collect', at: s.furnaces[0]! };
  const want = (xp: number, have: number): number => Math.max(1, Math.min(have, MEND_SMELT_MAX, Math.ceil(s.points / xp)));
  // carried stock, the most experience an item first
  const carried = [...s.carried].filter(([n, c]) => c > 0 && SMELT_XP[n] !== undefined && !s.tried.has(`smelt:${n}`)).sort((a, b) => SMELT_XP[b[0]]! - SMELT_XP[a[0]]! || b[1] - a[1]);
  const food = s.rawFood > 0 && !s.tried.has('cook');
  const best = carried[0];
  const fuel = s.fuelItems > 0;
  if (fuel && best && (!food || SMELT_XP[best[0]]! >= FOOD_XP)) return { kind: 'smelt', item: best[0], n: Math.min(want(SMELT_XP[best[0]]!, best[1]), s.fuelItems), from: 'carried', xp: SMELT_XP[best[0]]! };
  if (fuel && food) return { kind: 'cook', n: Math.min(s.rawFood, s.fuelItems), xp: FOOD_XP };
  // the chests at home in reach
  const home = [...s.home].filter(([n, c]) => c > 0 && SMELT_XP[n] !== undefined && !s.tried.has(`home:${n}`)).sort((a, b) => SMELT_XP[b[0]]! - SMELT_XP[a[0]]! || b[1] - a[1]);
  const h = home[0];
  if (fuel && h) return { kind: 'smelt', item: h[0], n: Math.min(want(SMELT_XP[h[0]]!, h[1]), s.fuelItems), from: 'home', xp: SMELT_XP[h[0]]! };
  if (s.ore && ORE_XP[s.ore.block] !== undefined && !s.tried.has(`mine:${s.ore.block}`) && !s.oreBlocked) {
    const xp = ORE_XP[s.ore.block]!;
    return { kind: 'mine', block: s.ore.block, n: Math.max(1, Math.min(s.ore.count, MEND_MINE_MAX, Math.ceil(s.points / xp))), xp };
  }
  const missing: string[] = [];
  if (!fuel && (best || food || h)) missing.push('fuel (coal, charcoal, planks or logs) for the smelt');
  else missing.push('something to smelt (raw iron, gold or copper, raw food, cobblestone: carried or in the chests at home in reach)');
  if (s.ore && s.oreBlocked && !s.tried.has(`mine:${s.ore.block}`)) missing.push(`or the ${s.ore.block} near mined (not now: ${s.oreBlocked})`);
  else missing.push('or a coal, lapis, redstone, diamond or quartz ore the bot has seen near with a pickaxe');
  return { kind: 'none', why: `no source of experience: needs ${missing.join(', ')}` };
}

/** The tried key of a step (a step that gave nothing is not chosen again in the job). */
export function stepKey(s: MendStep): string {
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

  constructor(d: MendJobDeps, want: string | undefined, minutes: number) {
    this.d = d;
    this.want = want;
    this.minutes = minutes;
    this.startedAt = d.now();
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
        const step = chooseMendSource({ points: need.points, furnaces, carried: d.carried(), rawFood: d.rawFood(), fuelItems: d.fuelItems(), home: d.home(), ore: d.ore(), tried, oreBlocked: d.oreBlocked?.() });
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
          d.log?.info(`mend: !${cmd}: ${last ?? 'no reply'}`);
        }
        const gained = usesOf(d.pieces()) - u0;
        if (n > 0) steps.push(stepDone(step, n));
        if (n <= 0 || gained <= 0) tried.add(key);
        // a step that paid nothing: the hand's last refusal says why (`not held: a zombie 5 blocks off with a clear way to me`)
        // (read through a function: the step's awaits set it, which the narrowing above does not see)
        const refused = gained <= 0 ? refusalOf(d.hand) : undefined;
        if (refused) cause = refused;
        d.log?.info(`mend: ${stepDone(step, n)}: +${gained} uses${refused ? ` (${refused})` : ''}`);
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