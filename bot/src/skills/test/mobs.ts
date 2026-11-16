// Track M1 (docs/pve.md "Never die to common mobs (Track M1)", docs/runbook.md, ADR 0079): `!test mobs`, a series of mob
// runs in the Realm test harness (Track T1). Each run:
//   restore   recovery.ts Harness.restore: health, food and the kit back, /tp to the run's start (where the series began)
//   summon    the set's mobs in a ring 7 blocks round the bot (flying ones 10 up), each with the series' name tag, by
//             `/summon <type> ~x ~ ~z 0 0 <spawn event> <tag>` (the bot's own command, relative to it)
//   watch     every POLL_MS: the damage taken (the bot's own health drops), a death, the mobs it summoned (new entities
//             of the set's types that appeared round it), until all of them are dead or gone, a death, the time limit
//             (default 60 s) or `!test stop`
//   remove    `/kill @e[name=<tag>]`: only the mobs this series summoned (a mob with that name tag), at the end of every
//             run and at once on `!test stop`
//   record    one MobRecord per run (a JSONL line), a chat line per run and a summary at the end
// The series refuses to start closer than MOBS_MIN_HOME (150) blocks to home, and the runs never touch anything but the
// mobs they summoned.
// Track M2 (docs/pve.md "Track M2"): before the first run it asks the server for two game rules (`/gamerule keepinventory`,
// `/gamerule mobgriefing`; the bot is op there) and looks at the ground of the ring, says all three in its first line, and
// refuses (preflightRefusal): keepInventory off or unread (a death would drop the kit in the owner's world); a set with a
// creeper while mobGriefing is on or unread (its blast digs the owner's ground) unless the command says `force`; a ring of 7
// whose points are mostly not standable ground (a mob summoned into a wall suffocates, one over a drop falls, one in water
// swims: the run would measure the place, not the bot). The ground is said as flat, mostly flat, a slope (points standable
// only up to 8 levels over or under the bot's: on the Realm's hillside a ring of 7 sent the set downhill) or rough; fewer
// than half the points level is refused.
// Track T2 (bare.ts): the word `bare` runs the series with no blade in the hotbar (the floors for a bot without one, the
// elytra flee first, run although the kit carries a sword): the blades move into the main inventory before the first run
// (a free slot, else in exchange with a stack that is no weapon; refused only when there is neither), pulls into the hotbar
// pass them over until the end, a blade the kit's restore gave into the hotbar goes out again after each restore, and they
// go back to their hotbar slots however the series ends (in exchange with whatever took the slot).
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { EntityInfo } from '../../world/types.ts';
import { bareType } from '../combat/hostiles.ts';
import { mobDeath } from './death.ts';
import { BARE_IDLE_MS, BareHold, hotbarBlades, stowedText, type BarePorts, type Stowed } from './bare.ts'; // Track T2
import { fmtCell, type RestoreResult } from './recovery.ts';

/** The series never runs closer than this to home (blocks, level). */
export const MOBS_MIN_HOME = 150;
/** A run's time limit by default (s), and the most a series may ask for. */
export const MOBS_SECONDS = 60;
export const MOBS_MAX_SECONDS = 300;
export const MOBS_MAX_RUNS = 20;
const POLL_MS = 250;
const RING = 7;

export interface MobSpec {
  type: string;
  event?: string;
  flying?: boolean;
}

const M = (type: string, extra: Partial<MobSpec> = {}): MobSpec => ({ type, ...extra });
const ONE: Readonly<Record<string, MobSpec>> = {
  zombie: M('zombie'),
  husk: M('husk'),
  baby: M('zombie', { event: 'minecraft:as_baby' }),
  drowned: M('drowned'),
  zvillager: M('zombie_villager_v2'),
  skeleton: M('skeleton'),
  stray: M('stray'),
  creeper: M('creeper'),
  spider: M('spider'),
  cavespider: M('cave_spider'),
  phantom: M('phantom', { flying: true }),
  witch: M('witch'),
  pillager: M('pillager'),
  slime: M('slime'),
};
const MIXED = [ONE.zombie!, ONE.skeleton!, ONE.creeper!, ONE.spider!, ONE.phantom!, ONE.baby!, ONE.witch!, ONE.husk!];

/** The named sets: every single mob, `<mob>4` four of it (zombie, skeleton, creeper, spider, phantom), `mixed4`, `mixed8`. */
export const MOB_SETS: Readonly<Record<string, readonly MobSpec[]>> = {
  ...Object.fromEntries(Object.entries(ONE).map(([k, v]) => [k, [v]])),
  ...Object.fromEntries(['zombie', 'skeleton', 'creeper', 'spider', 'phantom'].map((k) => [`${k}4`, [ONE[k]!, ONE[k]!, ONE[k]!, ONE[k]!]])),
  mixed4: MIXED.slice(0, 4),
  mixed8: MIXED.slice(0, 8),
};

export interface MobsSpec {
  set: string;
  mobs: readonly MobSpec[];
  runs: number;
  seconds: number;
  /** Track M2: run a set with a creeper although mobGriefing is on (the command said `force`). */
  force?: boolean;
  /** Track T2: no blade in the hotbar for the series (the command said `bare`; bare.ts). */
  bare?: boolean;
}

/** `!test mobs <set> [n] [<seconds>s] [force] [bare]` -> the spec, or an error line. */
export function parseMobsArgs(args: readonly string[]): MobsSpec | { error: string } {
  const usage = `usage: !test mobs <set> [n] [<seconds>s] [force] [bare]; sets: ${Object.keys(MOB_SETS).join(' ')}`;
  const set = args[0]?.toLowerCase();
  if (!set) return { error: usage };
  const mobs = MOB_SETS[set];
  if (!mobs) return { error: `test mobs: no set "${set}" (${Object.keys(MOB_SETS).join(' ')})` };
  let runs = 1;
  let seconds = MOBS_SECONDS;
  let force = false;
  let bare = false;
  for (const w of args.slice(1)) {
    if (w.toLowerCase() === 'force') {
      force = true;
      continue;
    }
    if (w.toLowerCase() === 'bare') {
      bare = true;
      continue;
    }
    const s = /^(\d+)s$/i.exec(w);
    if (s) {
      seconds = Number(s[1]);
      if (seconds < 10 || seconds > MOBS_MAX_SECONDS) return { error: `test mobs: seconds must be 10..${MOBS_MAX_SECONDS}` };
    } else if (/^\d+$/.test(w)) {
      runs = Number(w);
      if (runs < 1 || runs > MOBS_MAX_RUNS) return { error: `test mobs: runs must be 1..${MOBS_MAX_RUNS}` };
    } else return { error: usage };
  }
  return { set, mobs, runs, seconds, ...(force ? { force } : {}), ...(bare ? { bare } : {}) };
}

// ---- Track M2: the checks before a series (for the owner's Realm) ----

/** Points on the ring the ground check looks at. */
export const RING_POINTS = 16;
/** At least this share of the ring's points must be standable ground. */
export const RING_MIN_SHARE = 0.5;

/**
 * The game rule's value from a `/gamerule <rule>` answer: `true` / `false` as a parameter (BDS 1.26.60: `commands.gamerule.query`
 * with the parameters [rule, value]) or at the end of one, else in the message id. undefined when there was no answer.
 */
export function ruleAnswer(r: { ok: boolean; messageId?: string; params?: readonly string[]; error?: string }): boolean | undefined {
  if (r.error) return undefined;
  for (const p of r.params ?? []) {
    const m = /(?:^|[\s=:])(true|false)\s*$/i.exec(p.trim());
    if (m) return m[1]!.toLowerCase() === 'true';
  }
  const m = /\b(true|false)\b/i.exec(r.messageId ?? '');
  return m ? m[1]!.toLowerCase() === 'true' : undefined;
}

/** The ring's points (feet cells at the summons' level), RING_POINTS of them round `start`. */
export function ringCells(start: Vec3, points = RING_POINTS): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points + 0.4;
    out.push({ x: Math.floor(start.x + 0.5 + RING * Math.cos(a)), y: start.y, z: Math.floor(start.z + 0.5 + RING * Math.sin(a)) });
  }
  return out;
}

/** Levels above and below the bot's the ground check looks at for a ring point that is not standable at the bot's level. */
export const RING_SLOPE_LEVELS = 8; // steps of 1 a block put the ring's far side 7 under the bot

/** The ring's ground: points standable at the bot's level, points standable only up to RING_SLOPE_LEVELS higher or lower (a slope), of all. */
export interface RingGround {
  standable: number;
  /** Track M2: standable only off the bot's level (a hillside: a mob summoned there goes downhill). */
  slope: number;
  of: number;
}

/**
 * How many of the ring's points a mob summoned there would stand on at the bot's level, and how many only on another level
 * (`standable` from the bot's map; unknown counts as not). On the Realm's hillside a ring of 7 scattered the set downhill:
 * a witch went 6 to 12 blocks under the bot within 5 s.
 */
export function ringGround(start: Vec3, standable: (x: number, y: number, z: number) => boolean | undefined, points = RING_POINTS): RingGround {
  let n = 0;
  let slope = 0;
  for (const c of ringCells(start, points)) {
    if (standable(c.x, c.y, c.z) === true) n++;
    else {
      for (let dy = 1; dy <= RING_SLOPE_LEVELS; dy++) {
        if (standable(c.x, c.y + dy, c.z) === true || standable(c.x, c.y - dy, c.z) === true) {
          slope++;
          break;
        }
      }
    }
  }
  return { standable: n, slope, of: points };
}

/** `flat (16/16 level)`, `a slope (7/16 level, 8 on other levels)`, `rough (5/16 level, 2 on other levels)` */
export function groundText(g: RingGround | undefined): string {
  if (!g) return 'unknown';
  const what = g.standable === g.of ? 'flat' : g.standable >= Math.ceil(g.of * RING_MIN_SHARE) ? 'mostly flat' : g.slope >= g.of - g.standable - 2 && g.slope > 0 ? 'a slope' : 'rough';
  return `${what} (${g.standable}/${g.of} level${g.slope ? `, ${g.slope} on other levels` : ''})`;
}

export interface MobsPreflight {
  keepInventory: boolean | undefined;
  mobGriefing: boolean | undefined;
  ground: RingGround | undefined;
}

/** A set with a creeper in it (its blast breaks blocks while mobGriefing is on). */
export function hasCreeper(spec: Pick<MobsSpec, 'mobs'>): boolean {
  return spec.mobs.some((m) => bareType(m.type) === 'creeper');
}

/** `keepInventory on, mobGriefing off, ground flat (16/16 level)` */
export function preflightText(p: MobsPreflight): string {
  const v = (b: boolean | undefined): string => (b === undefined ? 'unknown' : b ? 'on' : 'off');
  return `keepInventory ${v(p.keepInventory)}, mobGriefing ${v(p.mobGriefing)}, ground ${groundText(p.ground)}`;
}

/** Why the series may not run (the server's rules, the ground), else undefined. See the file comment. */
export function preflightRefusal(spec: Pick<MobsSpec, 'mobs' | 'force'>, p: MobsPreflight): string | undefined {
  if (p.keepInventory !== true) return `test mobs: keepInventory is ${p.keepInventory === false ? 'off' : 'unknown (no answer to /gamerule keepinventory)'}: a death would drop the kit; not running`;
  if (hasCreeper(spec) && p.mobGriefing !== false && !spec.force) return `test mobs: mobGriefing is ${p.mobGriefing ? 'on' : 'unknown'} and the set has a creeper (its blast breaks blocks); add "force" to run it anyway`;
  if (!p.ground || p.ground.standable < Math.ceil(p.ground.of * RING_MIN_SHARE)) {
    const slope = groundText(p.ground).startsWith('a slope');
    return `test mobs: the ring ${RING} blocks round the bot is ${slope ? 'a slope (its mobs would go downhill)' : 'not standable ground'}: ${groundText(p.ground)}; find flat open ground`;
  }
  return undefined;
}

/** The summon command for mob `i` of `n` (relative to the bot: the command runs as it). */
export function summonCommand(m: MobSpec, i: number, n: number, tag: string): string {
  const a = (2 * Math.PI * i) / n + 0.4;
  const dx = (RING * Math.cos(a)).toFixed(1);
  const dz = (RING * Math.sin(a)).toFixed(1);
  return `/summon ${m.type} ~${dx} ~${m.flying ? 10 : 0} ~${dz} 0 0 ${m.event ?? 'minecraft:entity_spawned'} ${tag}`;
}

/** Removes the series' mobs only: every entity with its name tag. */
export function removeCommand(tag: string): string {
  return `/kill @e[name=${tag}]`;
}

/** Track M4: asks the server how many of the series' mobs are still there (the same selector as the removal). */
export function countCommand(tag: string): string {
  return `/testfor @e[name=${tag}]`;
}

/** Track M4: the server asked for the set's mobs at most this often (ms) while the bot sees none of them. */
export const COUNT_EVERY_MS = 2000;

/**
 * Track M4: the number of the series' mobs the server found from a `/testfor @e[name=<tag>]` answer: the success count (else
 * the names in the first parameter), 0 for "no target matched", undefined with no answer or another refusal (no rights).
 */
export function testforCount(r: { ok: boolean; successCount?: number; messageId?: string; params?: readonly string[]; error?: string }): number | undefined {
  if (r.error) return undefined;
  if (r.ok) {
    if (typeof r.successCount === 'number' && r.successCount > 0) return r.successCount;
    const names = (r.params?.[0] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return Math.max(1, names.length);
  }
  return /notarget|nomatch|no.?target/i.test(r.messageId ?? '') ? 0 : undefined;
}

export interface MobRecord {
  type: 'mobs';
  set: string;
  run: number;
  of: number;
  start: Vec3;
  startedAt: string;
  seconds: number;
  died: boolean;
  /** Track M5: the death message's key of a run that died (`death.attack.mob`, `death.attack.arrow`, `death.attack.inWall`). */
  deathCause?: string;
  damage: number;
  lowest: number;
  /** Hits taken by mob type (the bot's attacker guess). */
  hits: Record<string, number>;
  summoned: number;
  /** Mobs of the set left alive at the end. */
  left: number;
  cleared: boolean;
  clearSeconds: number | null;
  reflexHits: number;
  floors: Record<string, number>;
  end: 'cleared' | 'died' | 'timeout' | 'stopped' | 'setup';
  reason: string;
  /** Track T2: the series is `bare` (no blade in the hotbar). */
  bare?: boolean;
  /** Track T2: the blades out of the hotbar during this run (`netherite_sword 0 -> 27`), the stow and any keep so far. */
  stowed?: string[];
  /** Track T2: a blade in the hotbar at the run's start although the series is bare (none could be moved out). */
  bladeInHotbar?: boolean;
  /**
   * Track M4: mobs of the set the bot no longer saw (gone from its entity list without a death seen) that the server still
   * had (`/testfor`) at the run's end: they are not counted as cleared. Undefined when none vanished.
   */
  outOfSight?: number;
  /** Track M4: how the clear was judged: `seen` (every mob's death seen), `server` (`/testfor` found none), `unconfirmed` (no answer). */
  clearedBy?: 'seen' | 'server' | 'unconfirmed';
}

export interface MobSummary {
  type: 'mobs-summary';
  set: string;
  runs: number;
  planned: number;
  deaths: number;
  cleared: number;
  damage: number[];
  meanDamage: number;
  medianClear: number | null;
  reflexHits: number;
  floors: Record<string, number>;
  stopped: boolean;
  /** Track T2: the series was `bare`: what was stowed and where it went back to. */
  bare?: boolean;
  stowed?: string[];
  restored?: string[];
}

export interface MobSeriesPorts {
  /** A slash command as the bot (CommandRunner.run). */
  run(cmd: string): Promise<{ ok: boolean; successCount?: number; messageId?: string; params?: readonly string[]; error?: string }>;
  /** Track M2: a mob summoned with its feet in this cell stands there (a floor under it, room, no liquid); undefined = unknown. */
  standable?(x: number, y: number, z: number): boolean | undefined;
  restore(start: Vec3): Promise<RestoreResult>;
  position(): Vec3;
  home(): Vec3 | undefined;
  health(): number;
  deaths(): number;
  /** Track M5: the last death's message key (tasks/respawn.ts `lastDeath.cause`). */
  deathCause?(): string | undefined;
  /** Resolves once a death's recovery is over. */
  recovered(): Promise<void>;
  entities(): ReadonlyMap<bigint, EntityInfo>;
  dead(rid: bigint): boolean;
  /** The PvE counters now: reflex strikes, hits taken by type, floors taken. */
  counters(): { reflex: number; taken: Readonly<Record<string, number>>; floors: Readonly<Record<string, number>> };
  /** Called with every own health drop. */
  onDamage(fn: (damage: number) => void): () => void;
  say(m: string): void;
  write(rec: object): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Track T2: the inventory moves and the hold of a `bare` series (bare.ts); a bare series without them is refused. */
  bare?: BarePorts;
  log?: Logger;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const diff = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) if (v - (b[k] ?? 0) > 0) out[k] = v - (b[k] ?? 0);
  return out;
};
const fmtCounts = (c: Readonly<Record<string, number>>): string => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' ') || 'none';

/** One chat line per run. */
export function mobRunLine(r: MobRecord): string {
  return `test mobs ${r.set} run ${r.run}/${r.of}: ${r.died ? `DIED${r.deathCause ? ` (${r.deathCause}${mobDeath(r.deathCause) ? '' : ': not a mob'})` : ''}` : 'alive'}, damage ${r.damage} (lowest ${r.lowest}), hits ${fmtCounts(r.hits)}, ${r.cleared ? `cleared in ${r.clearSeconds} s${r.clearedBy === 'server' ? ' (the server has none)' : r.clearedBy === 'unconfirmed' ? ' (none in sight, the server did not answer)' : ''}` : `${r.left} left after ${r.seconds} s${r.outOfSight ? ` (${r.outOfSight} out of sight)` : ''}${r.end === 'stopped' ? ' (stopped)' : ''}`}, reflex ${r.reflexHits}, floors ${fmtCounts(r.floors)}${r.bare ? `, bare${r.bladeInHotbar ? ' (a blade still in the hotbar)' : ''}` : ''}`;
}

/** The summary line. */
export function mobSummaryLine(s: MobSummary): string {
  return `test mobs ${s.set}: ${s.runs}/${s.planned} runs${s.stopped ? ' (stopped)' : ''}, ${s.deaths} death${s.deaths === 1 ? '' : 's'}, cleared ${s.cleared}/${s.runs}, damage ${s.damage.join('/') || '-'} (mean ${s.meanDamage}), clear median ${s.medianClear ?? '-'} s, reflex ${s.reflexHits}, floors ${fmtCounts(s.floors)}${s.bare ? `, bare: ${s.stowed?.length ? s.stowed.join(', ') : 'no blade in the hotbar'}${s.restored?.length ? `; ${s.restored.join(', ')}` : ''}` : ''}`;
}

export class MobSeries {
  readonly spec: MobsSpec;
  readonly tag: string;
  current = 0;
  private stopped = false;
  private readonly p: MobSeriesPorts;
  private readonly log: Logger;
  private readonly start: Vec3;
  /** Track T2: the bare series' stow and hold (bare.ts), undefined without `bare`. */
  readonly bare: BareHold | undefined;
  /** Track T2: every blade stowed in this series (for the records and the summary). */
  private readonly stowedAll: Stowed[] = [];

  constructor(spec: MobsSpec, ports: MobSeriesPorts, tag: string) {
    this.spec = spec;
    this.p = ports;
    this.tag = tag;
    this.log = ports.log ?? silentLogger;
    const s = ports.position();
    this.start = { x: Math.floor(s.x), y: Math.floor(s.y + 1e-3), z: Math.floor(s.z) };
    this.bare = spec.bare && ports.bare ? new BareHold({ ...ports.bare, log: ports.bare.log ?? this.log }) : undefined;
  }

  /**
   * Track T2: for a `bare` series, the blades out of the hotbar and the hold on (bare.ts), before the start line; the
   * refusal line (no slot for a blade, a move refused, no inventory moves here), else undefined with what was stowed.
   * `run()` puts them back however it ends. Without `bare` nothing is touched.
   */
  async stowBlades(): Promise<{ refusal?: string; stowed: string }> {
    if (!this.spec.bare) return { stowed: '' };
    if (!this.bare) return { refusal: 'test mobs: bare: no inventory moves here', stowed: '' };
    const r = await this.bare.stow();
    if (!r.ok) return { refusal: r.reason, stowed: '' };
    this.stowedAll.push(...r.stowed);
    return { stowed: stowedText(r.stowed) };
  }

  /** Why the series may not run here (closer than MOBS_MIN_HOME to home), else undefined. */
  refusal(): string | undefined {
    const h = this.p.home();
    if (!h) return undefined;
    const d = Math.hypot(h.x + 0.5 - (this.start.x + 0.5), h.z + 0.5 - (this.start.z + 0.5));
    return d < MOBS_MIN_HOME ? `test mobs: ${Math.round(d)} blocks from home; go at least ${MOBS_MIN_HOME} away first` : undefined;
  }

  /** Track M2: the game rules and the ground before the first run (see the file comment): the start line's part and the refusal. */
  async preflight(): Promise<{ checks: MobsPreflight; line: string; refusal: string | undefined }> {
    const keepInventory = ruleAnswer(await this.p.run('/gamerule keepinventory'));
    const mobGriefing = ruleAnswer(await this.p.run('/gamerule mobgriefing'));
    const standable = this.p.standable?.bind(this.p);
    const ground = standable ? ringGround(this.start, standable) : undefined;
    const checks = { keepInventory, mobGriefing, ground };
    return { checks, line: preflightText(checks), refusal: preflightRefusal(this.spec, checks) };
  }

  stop(): void {
    this.stopped = true;
    // at once: the mobs go now, not when the run's loop sees the flag
    void this.p.run(removeCommand(this.tag));
  }

  status(): string {
    return `test mobs ${this.spec.set}${this.spec.bare ? ' bare' : ''}: run ${this.current}/${this.spec.runs} from ${fmtCell(this.start)}`;
  }

  /** Track T2: the stowed blades back (after a death's recovery: the moves need the living body). */
  private async unstow(): Promise<string[] | undefined> {
    if (!this.bare) return undefined;
    await this.p.recovered();
    await this.untilIdle();
    return (await this.bare.restore()).notes;
  }

  /** Track T2: a bare series' elytra flee still in the air: wait for it to come down (at most BARE_IDLE_MS). */
  private async untilIdle(): Promise<void> {
    const ports = this.p.bare;
    if (!this.bare || !ports?.idle) return;
    const idle = (): boolean => ports.idle?.() ?? true;
    const t0 = this.p.now();
    if (idle()) return;
    this.log.info('test mobs: bare: waiting for the flight to come down');
    while (!idle() && this.p.now() - t0 < BARE_IDLE_MS) await this.p.sleep(POLL_MS);
  }

  async run(): Promise<MobSummary> {
    const recs: MobRecord[] = [];
    let restored: string[] | undefined;
    let failed = false;
    try {
      for (let i = 1; i <= this.spec.runs && !this.stopped; i++) {
        this.current = i;
        const r = await this.one(i);
        recs.push(r);
        this.p.write(r);
        const line = mobRunLine(r);
        this.log.info(line);
        this.p.say(line);
        if (r.died) await this.p.recovered();
      }
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      await this.p.run(removeCommand(this.tag));
      try {
        restored = await this.unstow();
      } catch (e) {
        restored = [`the blades not put back: ${e instanceof Error ? e.message : String(e)}`];
      }
      // a series ended by an error has no summary: the restore is said on its own
      if (failed && restored?.length) this.p.say(`test mobs ${this.spec.set}: bare: ${restored.join(', ')}`);
    }
    const clears = recs.filter((r) => r.clearSeconds !== null).map((r) => r.clearSeconds!).sort((a, b) => a - b);
    const floors: Record<string, number> = {};
    for (const r of recs) for (const [k, v] of Object.entries(r.floors)) floors[k] = (floors[k] ?? 0) + v;
    const sum: MobSummary = {
      type: 'mobs-summary',
      set: this.spec.set,
      runs: recs.length,
      planned: this.spec.runs,
      deaths: recs.filter((r) => r.died).length,
      cleared: recs.filter((r) => r.cleared).length,
      damage: recs.map((r) => r.damage),
      meanDamage: recs.length ? r1(recs.reduce((s, r) => s + r.damage, 0) / recs.length) : 0,
      medianClear: clears.length ? clears[Math.floor(clears.length / 2)]! : null,
      reflexHits: recs.reduce((s, r) => s + r.reflexHits, 0),
      floors,
      stopped: this.stopped,
      ...(this.spec.bare ? { bare: true, stowed: this.stowedAll.map((s) => stowedText([s])), restored: restored ?? [] } : {}),
    };
    this.p.write(sum);
    return sum;
  }

  private async one(i: number): Promise<MobRecord> {
    const p = this.p;
    const startedAt = new Date(p.now()).toISOString();
    const base0 = { type: 'mobs' as const, set: this.spec.set, run: i, of: this.spec.runs, start: this.start, startedAt };
    let base: typeof base0 & Pick<MobRecord, 'bare' | 'stowed' | 'bladeInHotbar'> = base0;
    const bareFields = (): void => {
      if (!this.spec.bare) return;
      const left = this.p.bare ? hotbarBlades(this.p.bare.slots()).length > 0 : false;
      base = { ...base0, bare: true, stowed: this.stowedAll.map((s) => stowedText([s])), ...(left ? { bladeInHotbar: true } : {}) };
    };
    bareFields();
    const blank = (end: MobRecord['end'], reason: string): MobRecord => ({ ...base, seconds: 0, died: false, damage: 0, lowest: p.health(), hits: {}, summoned: 0, left: 0, cleared: false, clearSeconds: null, reflexHits: 0, floors: {}, end, reason });
    await this.untilIdle(); // Track T2: the run before's elytra flee down first (no /tp in the air)
    const rest = await p.restore(this.start);
    if (!rest.ok) return blank('setup', `restore: ${rest.why ?? '?'}`);
    // Track T2: the kit's restore may have given a blade into the hotbar (the first free slot): out with it too
    if (this.bare) {
      this.stowedAll.push(...(await this.bare.keep()));
      bareFields();
    }
    const why = this.refusal();
    if (why) {
      this.stopped = true;
      return blank('setup', why);
    }
    // copies: the PvE controller hands out its live counters (`pve.taken`, `pve.floors`), which the run's end would read
    // again as the same objects (bds-pve 2026-11-15: an elytra flee in a run said `floors none` until this was a copy)
    const cn = p.counters();
    const c0 = { reflex: cn.reflex, taken: { ...cn.taken }, floors: { ...cn.floors } };
    const deaths0 = p.deaths();
    const before = new Set(p.entities().keys());
    const types = new Set(this.spec.mobs.map((m) => m.type));
    let damage = 0;
    let lowest = p.health();
    const off = p.onDamage((d) => {
      damage += d;
    });
    try {
      for (let k = 0; k < this.spec.mobs.length && !this.stopped; k++) {
        const r = await p.run(summonCommand(this.spec.mobs[k]!, k, this.spec.mobs.length, this.tag));
        if (!r.ok) this.log.warn(`test mobs: summon ${this.spec.mobs[k]!.type} refused (${r.messageId ?? r.error ?? '?'})`);
      }
      const t0 = p.now();
      // the summoned mobs: new entities of the set's types within 16 blocks of the start, seen in the first 3 s
      const ours = new Set<bigint>();
      // Track M4: the mobs whose death the bot saw; one that left the entity list without it may only be out of sight (an
      // elytra flee of 96 blocks takes every mob out of view, and the run said `cleared` with all of them alive)
      const deadSeen = new Set<bigint>();
      const vanished = (): number => [...ours].filter((rid) => !deadSeen.has(rid) && !p.entities().has(rid)).length;
      let askedAt = -Infinity;
      let serverLeft: number | undefined;
      let clearedBy: MobRecord['clearedBy'];
      let clearS: number | null = null;
      let end: MobRecord['end'] = 'timeout';
      for (;;) {
        await p.sleep(POLL_MS);
        const now = p.now();
        lowest = Math.min(lowest, p.health());
        if (now - t0 < 3000) {
          for (const [rid, e] of p.entities()) {
            if (before.has(rid) || ours.has(rid) || !types.has(bareType(e.type))) continue;
            if (Math.hypot(e.pos.x - (this.start.x + 0.5), e.pos.z - (this.start.z + 0.5)) <= 16) ours.add(rid);
          }
        }
        for (const rid of ours) if (p.entities().has(rid) && p.dead(rid)) deadSeen.add(rid);
        if (p.deaths() > deaths0) {
          end = 'died';
          break;
        }
        if (this.stopped) {
          end = 'stopped';
          break;
        }
        const alive = [...ours].filter((rid) => p.entities().has(rid) && !p.dead(rid)).length;
        if (now - t0 >= 3000 && alive === 0) {
          if (vanished() === 0) {
            clearedBy = 'seen';
          } else if (now - askedAt >= COUNT_EVERY_MS) {
            askedAt = now;
            const r = await p.run(countCommand(this.tag));
            serverLeft = testforCount(r);
            // a rate-limited ask is asked again; no answer at all clears as before, said as unconfirmed
            if (serverLeft === undefined && r.error !== 'rate_limited') clearedBy = 'unconfirmed';
            else if (serverLeft === 0) clearedBy = 'server';
          }
          if (clearedBy) {
            clearS = r1((now - t0) / 1000);
            end = 'cleared';
            break;
          }
        } else serverLeft = undefined;
        if (now - t0 >= this.spec.seconds * 1000) break;
      }
      const seconds = r1((p.now() - t0) / 1000);
      const seen = [...ours].filter((rid) => p.entities().has(rid) && !p.dead(rid)).length;
      // mobs out of sight at the end: the server's count when it was asked for this (a timeout with none in sight asks once more)
      if (end === 'timeout' && seen === 0 && vanished() > 0 && serverLeft === undefined) serverLeft = testforCount(await p.run(countCommand(this.tag)));
      const outOfSight = end !== 'cleared' && seen === 0 && serverLeft !== undefined && serverLeft > 0 ? serverLeft : undefined;
      const left = Math.max(seen, outOfSight ?? 0);
      await p.run(removeCommand(this.tag));
      const c1 = p.counters();
      // the death message can come a moment after the health 0 that ended the run
      let deathCause = end === 'died' ? p.deathCause?.() : undefined;
      for (let i = 0; p.deathCause && end === 'died' && i < 5 && (deathCause === undefined || deathCause === 'health_zero' || deathCause === 'unknown'); i++) {
        await p.sleep(200);
        deathCause = p.deathCause();
      }
      return {
        ...base,
        seconds,
        died: end === 'died',
        ...(deathCause ? { deathCause } : {}),
        damage: r1(damage),
        lowest: r1(lowest),
        hits: diff(c1.taken, c0.taken),
        summoned: ours.size,
        left,
        cleared: end === 'cleared',
        clearSeconds: clearS,
        reflexHits: c1.reflex - c0.reflex,
        floors: diff(c1.floors, c0.floors),
        end,
        reason: end === 'cleared' ? `cleared in ${clearS} s` : end === 'died' ? 'died' : end === 'stopped' ? 'stopped' : `${left} left after ${seconds} s${outOfSight ? ' (out of sight)' : ''}`,
        ...(outOfSight ? { outOfSight } : {}),
        ...(clearedBy && clearedBy !== 'seen' ? { clearedBy } : {}),
      };
    } finally {
      off();
    }
  }
}
