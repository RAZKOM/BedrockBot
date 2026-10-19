// Test helpers for the world model: fixture loading, a replay packet source, a registry built from a
// recorded login, and a network subchunk encoder (the inverse of src/world/subchunk.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createDeserializer } from '../../../src/connection/protocol.ts';
import { parseRecording, type RecordLine } from '../../../src/connection/recorder.ts';
import { silentLogger } from '../../../src/log.ts';
import type { ItemRegistry, StartGame } from '../../../src/world/packets.ts';
import { BlockRegistry } from '../../../src/world/registry.ts';
import type { PacketSource } from '../../../src/world/types.ts';

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/1.26.51/${name}`, import.meta.url));
}

const cache = new Map<string, RecordLine[]>();

export function loadFixture(name: string): RecordLine[] {
  let lines = cache.get(name);
  if (!lines) {
    lines = parseRecording(gunzipSync(readFileSync(fixturePath(name))).toString('utf8'));
    cache.set(name, lines);
  }
  return lines;
}

/** Inbound packets of a fixture, decoded from the recorded raw bytes (Buffers and bigints as live). */
export function decodedInbound(name: string): { name: string; params: Record<string, unknown>; line: RecordLine }[] {
  const des = createDeserializer('1.26.51');
  const out: { name: string; params: Record<string, unknown>; line: RecordLine }[] = [];
  for (const line of loadFixture(name)) {
    if (line.dir !== 'in' || !line.raw) continue;
    const parsed = des.parsePacketBuffer(Buffer.from(line.raw, 'base64'));
    if (parsed.data.name === 'start_game' || parsed.data.name === 'item_registry') {
      const states = (parsed.data.params.itemstates ?? []) as { name: string; runtime_id: number }[];
      const shield = states.find((s) => s.name === 'minecraft:shield');
      if (shield) des.proto.setVariable('ShieldItemID', shield.runtime_id);
    }
    out.push({ name: parsed.data.name, params: parsed.data.params, line });
  }
  return out;
}

/** A PacketSource fed by hand: `emit` dispatches to subscribers; outbound packets are collected. */
export class ReplaySource implements PacketSource {
  readonly sent: { name: string; params: Record<string, unknown> }[] = [];
  private readonly handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  private readonly tickFns = new Set<(tick: bigint) => void>();
  private tick = 0n;

  on(name: string, fn: (p: Record<string, unknown>) => void): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  queue(name: string, params: Record<string, unknown>): void {
    this.sent.push({ name, params });
  }

  onTick(fn: (tick: bigint) => void): () => void {
    this.tickFns.add(fn);
    return () => this.tickFns.delete(fn);
  }

  emit(name: string, params: Record<string, unknown>): void {
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(params);
  }

  step(): void {
    this.tick++;
    for (const fn of [...this.tickFns]) fn(this.tick);
  }

  listenerCount(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }
}

/** start_game and item_registry params (JSON-safe, as recorded) from the login-idle fixture. */
export function recordedLogin(): { startGame: StartGame; itemRegistry: ItemRegistry } {
  const lines = loadFixture('login-idle.jsonl.gz');
  const sg = lines.find((l) => l.name === 'start_game')?.params as StartGame;
  const ir = lines.find((l) => l.name === 'item_registry')?.params as ItemRegistry;
  return { startGame: sg, itemRegistry: ir };
}

let shared: BlockRegistry | undefined;

/** A ready BlockRegistry built from the recorded login (shared across tests; treat as read-only). */
export function readyRegistry(): BlockRegistry {
  if (!shared) {
    const { startGame, itemRegistry } = recordedLogin();
    shared = new BlockRegistry({ logger: silentLogger });
    shared.handleStartGame(startGame);
    shared.handleItemRegistry(itemRegistry);
  }
  return shared;
}

// ---- network subchunk encoder (tests only) -------------------------------------------------------

function varuint(out: number[], v: number): void {
  let x = v >>> 0;
  while (x >= 0x80) {
    out.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  out.push(x);
}

function zigzag(out: number[], v: number): void {
  varuint(out, ((v << 1) ^ (v >> 31)) >>> 0);
}

/** One storage layer: runtime id per block in localIndex order (x << 8 | z << 4 | y). */
export function encodeLayer(out: number[], blocks: readonly number[], forceBits?: number): void {
  const palette: number[] = [];
  const idx = blocks.map((rid) => {
    let i = palette.indexOf(rid);
    if (i < 0) {
      i = palette.length;
      palette.push(rid);
    }
    return i;
  });
  let bits = forceBits ?? 0;
  if (forceBits === undefined && palette.length > 1) {
    const need = Math.ceil(Math.log2(palette.length));
    bits = [1, 2, 3, 4, 5, 6, 8, 16].find((b) => b >= need)!;
  }
  out.push((bits << 1) | 1);
  if (bits === 0) {
    zigzag(out, palette[0]!);
    return;
  }
  const perWord = Math.floor(32 / bits);
  const words = Math.ceil(4096 / perWord);
  for (let w = 0; w < words; w++) {
    let word = 0;
    for (let k = 0; k < perWord; k++) {
      const i = w * perWord + k;
      if (i >= 4096) break;
      word |= idx[i]! << (k * bits);
    }
    const u = word >>> 0;
    out.push(u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff);
  }
  zigzag(out, palette.length);
  for (const rid of palette) zigzag(out, rid);
}

/** A version 9 (default) or 8 network subchunk payload. */
export function encodeSubChunk(layers: readonly (readonly number[])[], opts: { version?: 8 | 9; y?: number; forceBits?: number; trailing?: Uint8Array } = {}): Buffer {
  const out: number[] = [];
  const version = opts.version ?? 9;
  out.push(version, layers.length);
  if (version === 9) out.push((opts.y ?? 0) & 0xff);
  for (const l of layers) encodeLayer(out, l, opts.forceBits);
  const buf = Buffer.from(out);
  return opts.trailing ? Buffer.concat([buf, opts.trailing]) : buf;
}

/** 4096 runtime ids from a function of local coordinates. */
export function fillSection(fn: (x: number, y: number, z: number) => number): number[] {
  const out = new Array<number>(4096);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) out[(x << 8) | (z << 4) | y] = fn(x, y, z);
  return out;
}
