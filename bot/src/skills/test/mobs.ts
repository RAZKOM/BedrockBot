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
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { EntityInfo } from '../../world/types.ts';
import { bareType } from '../combat/hostiles.ts';
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
}

/** `!test mobs <set> [n] [<seconds>s]` -> the spec, or an error line. */
export function parseMobsArgs(args: readonly string[]): MobsSpec | { error: string } {
  const usage = `usage: !test mobs <set> [n] [<seconds>s]; sets: ${Object.keys(MOB_SETS).join(' ')}`;
  const set = args[0]?.toLowerCase();
  if (!set) return { error: usage };
  const mobs = MOB_SETS[set];
  if (!mobs) return { error: `test mobs: no set "${set}" (${Object.keys(MOB_SETS).join(' ')})` };
  let runs = 1;
  let seconds = MOBS_SECONDS;
  for (const w of args.slice(1)) {
    const s = /^(\d+)s$/i.exec(w);
    if (s) {
      seconds = Number(s[1]);
      if (seconds < 10 || seconds > MOBS_MAX_SECONDS) return { error: `test mobs: seconds must be 10..${MOBS_MAX_SECONDS}` };
    } else if (/^\d+$/.test(w)) {
      runs = Number(w);
      if (runs < 1 || runs > MOBS_MAX_RUNS) return { error: `test mobs: runs must be 1..${MOBS_MAX_RUNS}` };
    } else return { error: usage };
  }
  return { set, mobs, runs, seconds };
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

export interface MobRecord {
  type: 'mobs';
  set: string;
  run: number;
  of: number;
  start: Vec3;
  startedAt: string;
  seconds: number;
  died: boolean;
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
}

export interface MobSeriesPorts {
  /** A slash command as the bot (CommandRunner.run). */
  run(cmd: string): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  restore(start: Vec3): Promise<RestoreResult>;
  position(): Vec3;
  home(): Vec3 | undefined;
  health(): number;
  deaths(): number;
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
  return `test mobs ${r.set} run ${r.run}/${r.of}: ${r.died ? 'DIED' : 'alive'}, damage ${r.damage} (lowest ${r.lowest}), hits ${fmtCounts(r.hits)}, ${r.cleared ? `cleared in ${r.clearSeconds} s` : `${r.left} left after ${r.seconds} s${r.end === 'stopped' ? ' (stopped)' : ''}`}, reflex ${r.reflexHits}, floors ${fmtCounts(r.floors)}`;
}

/** The summary line. */
export function mobSummaryLine(s: MobSummary): string {
  return `test mobs ${s.set}: ${s.runs}/${s.planned} runs${s.stopped ? ' (stopped)' : ''}, ${s.deaths} death${s.deaths === 1 ? '' : 's'}, cleared ${s.cleared}/${s.runs}, damage ${s.damage.join('/') || '-'} (mean ${s.meanDamage}), clear median ${s.medianClear ?? '-'} s, reflex ${s.reflexHits}, floors ${fmtCounts(s.floors)}`;
}

export class MobSeries {
  readonly spec: MobsSpec;
  readonly tag: string;
  current = 0;
  private stopped = false;
  private readonly p: MobSeriesPorts;
  private readonly log: Logger;
  private readonly start: Vec3;

  constructor(spec: MobsSpec, ports: MobSeriesPorts, tag: string) {
    this.spec = spec;
    this.p = ports;
    this.tag = tag;
    this.log = ports.log ?? silentLogger;
    const s = ports.position();
    this.start = { x: Math.floor(s.x), y: Math.floor(s.y + 1e-3), z: Math.floor(s.z) };
  }

  /** Why the series may not run here (closer than MOBS_MIN_HOME to home), else undefined. */
  refusal(): string | undefined {
    const h = this.p.home();
    if (!h) return undefined;
    const d = Math.hypot(h.x + 0.5 - (this.start.x + 0.5), h.z + 0.5 - (this.start.z + 0.5));
    return d < MOBS_MIN_HOME ? `test mobs: ${Math.round(d)} blocks from home; go at least ${MOBS_MIN_HOME} away first` : undefined;
  }

  stop(): void {
    this.stopped = true;
    // at once: the mobs go now, not when the run's loop sees the flag
    void this.p.run(removeCommand(this.tag));
  }

  status(): string {
    return `test mobs ${this.spec.set}: run ${this.current}/${this.spec.runs} from ${fmtCell(this.start)}`;
  }

  async run(): Promise<MobSummary> {
    const recs: MobRecord[] = [];
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
    } finally {
      await this.p.run(removeCommand(this.tag));
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
    };
    this.p.write(sum);
    return sum;
  }

  private async one(i: number): Promise<MobRecord> {
    const p = this.p;
    const startedAt = new Date(p.now()).toISOString();
    const base = { type: 'mobs' as const, set: this.spec.set, run: i, of: this.spec.runs, start: this.start, startedAt };
    const blank = (end: MobRecord['end'], reason: string): MobRecord => ({ ...base, seconds: 0, died: false, damage: 0, lowest: p.health(), hits: {}, summoned: 0, left: 0, cleared: false, clearSeconds: null, reflexHits: 0, floors: {}, end, reason });
    const rest = await p.restore(this.start);
    if (!rest.ok) return blank('setup', `restore: ${rest.why ?? '?'}`);
    const why = this.refusal();
    if (why) {
      this.stopped = true;
      return blank('setup', why);
    }
    const c0 = p.counters();
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
          clearS = r1((now - t0) / 1000);
          end = 'cleared';
          break;
        }
        if (now - t0 >= this.spec.seconds * 1000) break;
      }
      const seconds = r1((p.now() - t0) / 1000);
      const left = [...ours].filter((rid) => p.entities().has(rid) && !p.dead(rid)).length;
      await p.run(removeCommand(this.tag));
      const c1 = p.counters();
      return {
        ...base,
        seconds,
        died: end === 'died',
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
        reason: end === 'cleared' ? `cleared in ${clearS} s` : end === 'died' ? 'died' : end === 'stopped' ? 'stopped' : `${left} left after ${seconds} s`,
      };
    } finally {
      off();
    }
  }
}
