// Pure helpers shared by the pack, its unit tests and (by copy or import) the bot's parser.
// No @minecraft/server imports here.

/** Prefix of every complete reply line. The rest of the line is compact JSON: {"truth":{...}}. */
export const MARKER = '@truth ';
/** Prefix of a fragment when a reply is too long for one chat message. */
export const PART_MARKER = '@truth+ ';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Reply {
  cmd: string;
  id: string | null;
  ok: boolean;
  tick: number;
  data: unknown;
  reason?: string;
}

/** Error with a machine-readable reason code; becomes {ok:false, reason, data}. */
export class TruthError extends Error {
  readonly reason: string;
  readonly data: unknown;
  constructor(reason: string, message?: string, data: unknown = null) {
    super(message ?? reason);
    this.reason = reason;
    this.data = data;
  }
}

/**
 * Splits a /scriptevent message into tokens. Whitespace separates tokens; double quotes group
 * (for player names with spaces). Backslash escapes the next character inside quotes.
 */
export function tokenize(message: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  let has = false;
  for (let i = 0; i < message.length; i++) {
    const c = message[i]!;
    if (inQuotes) {
      if (c === '\\' && i + 1 < message.length) {
        cur += message[++i];
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** Parses "truth:<cmd>" + message into {cmd, id, args}. A first token "#<id>" is the request id. */
export function parseRequest(eventId: string, message: string): { cmd: string; id: string | null; args: string[] } {
  const colon = eventId.indexOf(':');
  const cmd = colon >= 0 ? eventId.slice(colon + 1) : eventId;
  const args = tokenize(message ?? '');
  let id: string | null = null;
  if (args.length > 0 && args[0]!.startsWith('#') && args[0]!.length > 1) {
    id = args.shift()!.slice(1);
  }
  return { cmd, id, args };
}

export function num(s: string | undefined, what: string): number {
  if (s === undefined || s.trim() === '') throw new TruthError('bad_args', `missing ${what}`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new TruthError('bad_args', `${what} is not a number: ${s}`);
  return n;
}

export function int(s: string | undefined, what: string): number {
  return Math.floor(num(s, what));
}

/** Block coordinates (floored) from args[i..i+2]. */
export function blockPos(args: string[], i: number): Vec3 {
  return { x: int(args[i], 'x'), y: int(args[i + 1], 'y'), z: int(args[i + 2], 'z') };
}

/** Exact (float) coordinates from args[i..i+2]. */
export function exactPos(args: string[], i: number): Vec3 {
  return { x: num(args[i], 'x'), y: num(args[i + 1], 'y'), z: num(args[i + 2], 'z') };
}

export interface Box {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  volume: number;
}

/** Normalised inclusive box from two corners. */
export function box(a: Vec3, b: Vec3): Box {
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
  const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
  const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  return { min, max, size, volume: size.x * size.y * size.z };
}

/**
 * Canonical iteration order for `blocks` and `checksum`: y outermost, then z, then x innermost.
 * Index i of the block at (x,y,z) is ((y - min.y) * size.z + (z - min.z)) * size.x + (x - min.x).
 */
export function* iterateBox(b: Box): Generator<Vec3> {
  for (let y = b.min.y; y <= b.max.y; y++) {
    for (let z = b.min.z; z <= b.max.z; z++) {
      for (let x = b.min.x; x <= b.max.x; x++) {
        yield { x, y, z };
      }
    }
  }
}

/** Palette + run-length encoder. `runs` is a list of [paletteIndex, count] pairs. */
export class RleEncoder {
  readonly palette: string[] = [];
  readonly runs: [number, number][] = [];
  private readonly index = new Map<string, number>();

  push(value: string): void {
    let i = this.index.get(value);
    if (i === undefined) {
      i = this.palette.length;
      this.palette.push(value);
      this.index.set(value, i);
    }
    const last = this.runs[this.runs.length - 1];
    if (last && last[0] === i) last[1]++;
    else this.runs.push([i, 1]);
  }
}

/** Expands palette + runs back into a flat list in canonical order. */
export function rleDecode(palette: string[], runs: [number, number][]): string[] {
  const out: string[] = [];
  for (const [i, n] of runs) for (let k = 0; k < n; k++) out.push(palette[i]!);
  return out;
}

/**
 * 32-bit FNV-1a. Each typeId is hashed as its bytes (typeIds are ASCII) followed by one 0x00
 * separator byte, in canonical order. Offset basis 0x811c9dc5, prime 0x01000193.
 */
export class Fnv1a {
  private h = 0x811c9dc5;

  update(s: string): void {
    let h = this.h;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    // separator byte 0x00: h ^= 0 is a no-op, the multiply still happens
    h = Math.imul(h, 0x01000193);
    this.h = h;
  }

  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}

export function fnv1aOf(values: Iterable<string>): string {
  const f = new Fnv1a();
  for (const v of values) f.update(v);
  return f.hex();
}

/** "stone" -> "minecraft:stone"; namespaced ids pass through. */
export function nsId(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`;
}

/** Structure ids without a namespace get Bedrock's default "mystructure:" namespace. */
export function structureId(name: string): string {
  return name.includes(':') ? name : `mystructure:${name}`;
}

/**
 * Serialises a reply into one or more chat lines. A reply that fits is one line "@truth {json}".
 * A longer reply becomes lines "@truth+ <key> <i>/<n> <fragment>"; concatenating the fragments
 * of one key in order 1..n gives the {json} of the full reply.
 */
export function encodeReply(reply: Reply, maxLen: number, key: string): string[] {
  const json = JSON.stringify({ truth: reply });
  if (MARKER.length + json.length <= maxLen) return [MARKER + json];
  const body = Math.max(64, maxLen - PART_MARKER.length - key.length - 16);
  const n = Math.ceil(json.length / body);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${PART_MARKER}${key} ${i + 1}/${n} ${json.slice(i * body, (i + 1) * body)}`);
  }
  return out;
}

/** Reassembles reply lines (in arrival order). `feed` returns a reply once it is complete. */
export class ReplyParser {
  private readonly parts = new Map<string, (string | undefined)[]>();

  /** Feed one chat line (the text already extracted from rawtext). Returns a reply or null. */
  feed(line: string): Reply | null {
    if (line.startsWith(MARKER)) {
      return (JSON.parse(line.slice(MARKER.length)) as { truth: Reply }).truth;
    }
    if (!line.startsWith(PART_MARKER)) return null;
    const rest = line.slice(PART_MARKER.length);
    const m = /^(\S+) (\d+)\/(\d+) /.exec(rest);
    if (!m) return null;
    const key = m[1]!;
    const i = Number(m[2]);
    const n = Number(m[3]);
    const arr = this.parts.get(key) ?? new Array<string | undefined>(n).fill(undefined);
    arr[i - 1] = rest.slice(m[0].length);
    this.parts.set(key, arr);
    if (arr.every((x) => x !== undefined)) {
      this.parts.delete(key);
      return (JSON.parse(arr.join('')) as { truth: Reply }).truth;
    }
    return null;
  }
}

/** Extracts the plain text of a bedrock-protocol `text` packet (rawtext JSON or plain). */
export function textOf(packet: { type?: string; message?: string }): string {
  const msg = packet.message ?? '';
  if (packet.type === 'json' || packet.type === 'json_whisper' || packet.type === 'json_announcement') {
    try {
      const parsed = JSON.parse(msg) as { rawtext?: { text?: string }[] };
      return (parsed.rawtext ?? []).map((r) => r.text ?? '').join('');
    } catch {
      return msg;
    }
  }
  return msg;
}
