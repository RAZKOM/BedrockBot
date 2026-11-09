// Learned flight paths (`!learn`, docs/flight.md "Learned paths"): the owner flies a path (through a cave mouth, from the
// xp farm home) while the bot watches; the bot records what the server tells it about that player (move_player: the eye
// position, the look, on-ground; add_entity: the rockets fired next to them) and keeps it as a named path. The path is a
// demonstration of a line that works, not a script: later flights recognise it and steer along it where it helps.
//
// The bot sees a player only within its view of the world (the server sends players in the chunks around it): a path
// flown out of that range has gaps, recorded as such. Coordinates are the owner's world: the files live in the config
// directory (never in the repository).
import type { EntityInfo } from '../../../world/types.ts';

/** Eye position over feet of a standing player (world/entities.ts PLAYER_EYE_HEIGHT). */
const EYE = 1.62;
/** No update for this long while recording: a gap (the player out of the bot's view). */
export const GAP_MS = 1000;
/** A recording ends by itself this long after the player landed and stood still... */
export const SETTLE_MS = 8000;
/** ...once it has flown at least this long. */
export const FLOWN_MS = 2000;
/** And at the latest after this long. */
export const MAX_MS = 10 * 60_000;
/** A rocket entity appearing within this many blocks of the player is one of theirs. */
const ROCKET_NEAR = 4;
/** Faster than this (blocks a second) off the ground: gliding. */
const GLIDE_SPEED = 6;

export interface LearnSample {
  /** ms since the recording started. */
  t: number;
  x: number;
  /** Feet height (the eye position the server sends less 1.62; a gliding body is lower, so this is approximate in the air). */
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  ground: boolean;
}

export interface LearnedPath {
  version: 1;
  name: string;
  player: string;
  /** ISO time of the start. */
  recorded: string;
  samples: LearnSample[];
  /** Rockets fired next to the player (ms since the start, where). */
  rockets: { t: number; x: number; y: number; z: number }[];
  /** Stretches with no update (the player out of view): ms since the start. */
  gaps: { from: number; to: number }[];
  /** Why the recording ended: `stop`, `landed`, `limit`, `lost`. */
  ended: string;
}

export interface RecorderDeps {
  entities: () => Iterable<EntityInfo>;
  onAdd: (fn: (e: EntityInfo) => void) => () => void;
  now: () => number;
}

export class PathRecorder {
  readonly name: string;
  readonly player: string;
  private readonly d: RecorderDeps;
  private readonly t0: number;
  private readonly startedAt = new Date();
  private readonly samples: LearnSample[] = [];
  private readonly rockets: LearnedPath['rockets'] = [];
  private readonly gaps: LearnedPath['gaps'] = [];
  private readonly off: () => void;
  private lastUpdate = -1;
  private lastSeen = -1;
  private gapFrom: number | undefined;
  private flownMs = 0;
  private stillSince: number | undefined;
  private done: string | undefined;

  constructor(name: string, player: string, d: RecorderDeps) {
    this.name = name;
    this.player = player;
    this.d = d;
    this.t0 = d.now();
    this.off = d.onAdd((e) => {
      if (!/fireworks?_rocket/.test(e.type)) return;
      const p = this.find();
      if (!p) return;
      const dx = e.pos.x - p.pos.x;
      const dy = e.pos.y - (p.pos.y - EYE);
      const dz = e.pos.z - p.pos.z;
      if (Math.hypot(dx, dy, dz) <= ROCKET_NEAR + EYE) this.rockets.push({ t: Math.round(d.now() - this.t0), x: round(p.pos.x), y: round(p.pos.y - EYE), z: round(p.pos.z) });
    });
  }

  private find(): EntityInfo | undefined {
    const want = this.player.toLowerCase();
    for (const e of this.d.entities()) if (e.type === 'minecraft:player' && e.username?.toLowerCase() === want) return e;
    return undefined;
  }

  /** The player is in view now. */
  visible(): boolean {
    return this.find() !== undefined;
  }

  /** Take a sample (every tick or so); the reason it ended by itself, once it has. */
  tick(): string | undefined {
    if (this.done) return this.done;
    const now = this.d.now();
    const t = now - this.t0;
    const p = this.find();
    if (p && p.updatedAt !== this.lastUpdate) {
      this.lastUpdate = p.updatedAt;
      if (this.gapFrom !== undefined) {
        this.gaps.push({ from: Math.round(this.gapFrom), to: Math.round(t) });
        this.gapFrom = undefined;
      }
      const prev = this.samples[this.samples.length - 1];
      const s: LearnSample = { t: Math.round(t), x: round(p.pos.x), y: round(p.pos.y - EYE), z: round(p.pos.z), yaw: round(p.yaw, 1), pitch: round(p.pitch, 1), ground: p.onGround };
      this.samples.push(s);
      this.lastSeen = t;
      if (prev && s.t > prev.t) {
        const dt = s.t - prev.t;
        const speed = (Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z) / dt) * 1000;
        if (!s.ground && speed > GLIDE_SPEED) this.flownMs += dt;
        if (s.ground && speed < 0.5) this.stillSince ??= t;
        else this.stillSince = undefined;
      }
    } else if (this.lastSeen >= 0 && t - this.lastSeen > GAP_MS && this.gapFrom === undefined) this.gapFrom = this.lastSeen;
    if (this.flownMs >= FLOWN_MS && this.stillSince !== undefined && t - this.stillSince >= SETTLE_MS) return this.finish('landed');
    if (t >= MAX_MS) return this.finish('limit');
    return undefined;
  }

  private finish(why: string): string {
    this.done = why;
    this.off();
    return why;
  }

  /** End the recording (if it has not ended by itself) and give the path. */
  stop(why = 'stop'): LearnedPath {
    if (!this.done) {
      if (this.gapFrom !== undefined) this.gaps.push({ from: Math.round(this.gapFrom), to: Math.round(this.d.now() - this.t0) });
      this.finish(why);
    }
    return {
      version: 1,
      name: this.name,
      player: this.player,
      recorded: this.startedAt.toISOString(),
      samples: [...this.samples],
      rockets: [...this.rockets],
      gaps: [...this.gaps],
      ended: this.done!,
    };
  }
}

export interface PathSummary {
  seconds: number;
  samples: number;
  /** Blocks along the path. */
  length: number;
  /** Blocks from the first sample to the last. */
  straight: number;
  /** Seconds off the ground faster than a run. */
  flownSeconds: number;
  rockets: number;
  maxSpeed: number;
  gaps: number;
  gapSeconds: number;
  minY: number;
  maxY: number;
}

export function summarizePath(p: LearnedPath): PathSummary {
  const s = p.samples;
  let length = 0;
  let flown = 0;
  let maxSpeed = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
    if (i === 0) continue;
    const a = s[i - 1]!;
    const d = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z);
    const dt = c.t - a.t;
    if (p.gaps.some((g) => a.t <= g.from && c.t >= g.to)) continue;
    length += d;
    if (dt > 0) {
      const v = (d / dt) * 1000;
      maxSpeed = Math.max(maxSpeed, v);
      if (!c.ground && v > GLIDE_SPEED) flown += dt;
    }
  }
  const first = s[0];
  const last = s[s.length - 1];
  return {
    seconds: first && last ? round((last.t - first.t) / 1000, 1) : 0,
    samples: s.length,
    length: Math.round(length),
    straight: first && last ? Math.round(Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z)) : 0,
    flownSeconds: round(flown / 1000, 1),
    rockets: p.rockets.length,
    maxSpeed: round(maxSpeed, 1),
    gaps: p.gaps.length,
    gapSeconds: round(p.gaps.reduce((n, g) => n + g.to - g.from, 0) / 1000, 1),
    minY: Number.isFinite(minY) ? Math.round(minY) : 0,
    maxY: Number.isFinite(maxY) ? Math.round(maxY) : 0,
  };
}

/** `cave_in: 14.2 s, 212 blocks (180 straight), flown 11.3 s, 2 rockets, top speed 31 b/s, y 48..131, 1 gap (2.1 s)` */
export function pathLine(p: LearnedPath): string {
  const m = summarizePath(p);
  const gaps = m.gaps ? `, ${m.gaps} gap${m.gaps === 1 ? '' : 's'} (${m.gapSeconds} s out of my view)` : '';
  return `${p.name}: ${m.seconds} s, ${m.length} blocks (${m.straight} straight), flown ${m.flownSeconds} s, ${m.rockets} rocket${m.rockets === 1 ? '' : 's'}, top speed ${m.maxSpeed} b/s, y ${m.minY}..${m.maxY}${gaps}`;
}

/** A path name: letters, digits, `_` and `-`, up to 32. */
export function validPathName(name: string): boolean {
  return /^[a-z0-9_-]{1,32}$/i.test(name);
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
