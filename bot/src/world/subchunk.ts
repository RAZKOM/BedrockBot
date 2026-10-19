// Network subchunk decoder (runtime-id paletted storage, versions 1, 8 and 9) and the compact
// in-memory section format the chunk store keeps.
//
// Why not prismarine-chunk's 1.18 decoder: 1.41.0 has no 1.26 table entry (PLAN fact 3b), throws on
// a runtime id the registry does not know (blocks newer than the 1.26.30 block data), and its
// 0-bits-per-block path decodes the single runtime id with `readVarInt() >> 1` and then treats it as
// a state id, which is wrong for hashed ids. The unit tests cross-check this decoder against
// prismarine-chunk on recorded payloads.
import nbt from 'prismarine-nbt';

/** Index of a block inside a 16^3 section: x, then z, then y (Bedrock's XZY order). */
export function localIndex(x: number, y: number, z: number): number {
  return ((x & 15) << 8) | ((z & 15) << 4) | (y & 15);
}

/** One storage layer: a palette of state ids (with the wire runtime ids) and per-block palette indices. */
export class Layer {
  /** State id per palette entry; -1 = runtime id unknown to the registry. */
  palette: Int32Array;
  /** Wire runtime id per palette entry. */
  runtimeIds: Int32Array;
  /** Number of palette entries in use. */
  size: number;
  /** Palette index per block (localIndex order); null = every block is palette[0]. */
  index: Uint8Array | Uint16Array | null;

  constructor(palette: Int32Array, runtimeIds: Int32Array, size: number, index: Uint8Array | Uint16Array | null) {
    this.palette = palette;
    this.runtimeIds = runtimeIds;
    this.size = size;
    this.index = index;
  }

  static uniform(stateId: number, runtimeId: number): Layer {
    return new Layer(Int32Array.of(stateId), Int32Array.of(runtimeId), 1, null);
  }

  paletteIndexAt(i: number): number {
    return this.index ? this.index[i]! : 0;
  }

  stateAt(i: number): number {
    return this.palette[this.paletteIndexAt(i)]!;
  }

  runtimeIdAt(i: number): number {
    return this.runtimeIds[this.paletteIndexAt(i)]!;
  }

  /** Sets block i to a state (adding it to the palette when new). */
  set(i: number, stateId: number, runtimeId: number): void {
    let p = -1;
    for (let k = 0; k < this.size; k++) {
      if (this.runtimeIds[k] === runtimeId) {
        p = k;
        break;
      }
    }
    if (p === -1) {
      if (this.size === this.palette.length) {
        const cap = Math.max(4, this.size * 2);
        const np = new Int32Array(cap);
        np.set(this.palette);
        const nr = new Int32Array(cap);
        nr.set(this.runtimeIds);
        this.palette = np;
        this.runtimeIds = nr;
      }
      p = this.size++;
      this.palette[p] = stateId;
      this.runtimeIds[p] = runtimeId;
    }
    if (!this.index) {
      if (p === 0) return;
      this.index = new Uint8Array(4096);
    }
    if (p > 255 && this.index instanceof Uint8Array) this.index = Uint16Array.from(this.index);
    this.index[i] = p;
  }
}

/** A decoded 16^3 section: layer 0 (blocks) and optionally layer 1 (water in waterlogged blocks, snow). */
export class Section {
  readonly layers: Layer[];

  constructor(layers: Layer[]) {
    this.layers = layers;
  }

  static uniform(stateId: number, runtimeId: number): Section {
    return new Section([Layer.uniform(stateId, runtimeId)]);
  }

  stateAt(i: number, layer = 0): number | undefined {
    return this.layers[layer]?.stateAt(i);
  }
}

export interface DecodedSubChunk {
  version: number;
  /** Absolute subchunk index from the payload (version 9 only). */
  y: number | undefined;
  section: Section;
  /** Block entity NBT compounds (simplified) that followed the block storage. */
  blockEntities: Record<string, unknown>[];
  /** Bytes consumed. */
  size: number;
}

class Reader {
  pos: number;
  private readonly view: DataView;
  readonly buf: Uint8Array;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.pos = pos;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError('subchunk: unexpected end of data');
    return this.buf[this.pos++]!;
  }

  i8(): number {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }

  u32le(): number {
    if (this.pos + 4 > this.buf.length) throw new RangeError('subchunk: unexpected end of data');
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Unsigned LEB128 varint, up to 32 bits. */
  varuint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 28) {
        const last = this.u8();
        result |= (last & 0x0f) << 28;
        return result >>> 0;
      }
    }
  }

  /** ZigZag-encoded signed varint32. */
  zigzag32(): number {
    const v = this.varuint();
    return (v >>> 1) ^ -(v & 1);
  }
}

const VALID_BITS = new Set([1, 2, 3, 4, 5, 6, 8, 16]);

function readLayer(r: Reader, resolve: (runtimeId: number) => number): Layer {
  const header = r.u8();
  if ((header & 1) !== 1) throw new Error('subchunk: expected network runtime-id palette (header bit 0 clear)');
  const bits = header >> 1;
  if (bits === 0) {
    // Single block type: no words, no palette size, one zigzag runtime id.
    const rid = r.zigzag32();
    return Layer.uniform(resolve(rid), rid);
  }
  if (!VALID_BITS.has(bits)) throw new Error(`subchunk: invalid bits per block ${bits}`);
  const perWord = Math.floor(32 / bits);
  const words = Math.ceil(4096 / perWord);
  const mask = (1 << bits) - 1;
  const raw = new Uint16Array(4096);
  let i = 0;
  for (let w = 0; w < words; w++) {
    let word = r.u32le();
    for (let k = 0; k < perWord && i < 4096; k++) {
      raw[i++] = word & mask;
      word >>>= bits;
    }
  }
  const size = r.zigzag32();
  if (size < 1 || size > 4096) throw new Error(`subchunk: invalid palette size ${size}`);
  const palette = new Int32Array(size);
  const runtimeIds = new Int32Array(size);
  for (let k = 0; k < size; k++) {
    const rid = r.zigzag32();
    runtimeIds[k] = rid;
    palette[k] = resolve(rid);
  }
  for (let k = 0; k < 4096; k++) {
    if (raw[k]! >= size) throw new Error(`subchunk: palette index ${raw[k]} out of range (${size} entries)`);
  }
  if (size === 1) return new Layer(palette, runtimeIds, 1, null);
  const index = size <= 256 ? Uint8Array.from(raw) : raw;
  return new Layer(palette, runtimeIds, size, index);
}

/**
 * Decodes one network subchunk payload (`subchunk` entry with result `success`, or a section of a
 * `level_chunk` payload). `resolve` maps a wire runtime id to a state id (-1 = unknown).
 */
export function decodeSubChunk(buf: Uint8Array, resolve: (runtimeId: number) => number, maxVersion = 9): DecodedSubChunk {
  const r = new Reader(buf);
  const version = r.u8();
  let layerCount = 1;
  let y: number | undefined;
  if (version === 8 || version === 9) {
    if (version > maxVersion) throw new Error(`subchunk: version ${version} newer than the shim allows (${maxVersion})`);
    layerCount = r.u8();
    if (version === 9) y = r.i8();
  } else if (version !== 1) {
    throw new Error(`subchunk: unsupported storage version ${version}`);
  }
  if (layerCount < 1 || layerCount > 2) {
    // Bedrock never sends more than two layers; zero would mean an empty section.
    if (layerCount === 0) throw new Error('subchunk: zero storage layers');
    throw new Error(`subchunk: unexpected layer count ${layerCount}`);
  }
  const layers: Layer[] = [];
  for (let l = 0; l < layerCount; l++) layers.push(readLayer(r, resolve));
  const blockEntities = readBlockEntities(buf, r);
  return { version, y, section: new Section(layers), blockEntities, size: r.pos };
}

/** Little-endian varint NBT compounds (block entities) as long as the next byte is a compound tag. */
function readBlockEntities(buf: Uint8Array, r: Reader): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (r.pos >= buf.length || buf[r.pos] !== 0x0a) return out;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const proto = nbt.protos.littleVarint as {
    parsePacketBuffer(type: string, buf: Buffer, offset: number): { data: nbt.NBT; metadata: { size: number } };
  };
  while (r.pos < b.length && b[r.pos] === 0x0a) {
    const { data, metadata } = proto.parsePacketBuffer('nbt', b, r.pos);
    r.pos += metadata.size;
    out.push(nbt.simplify(data) as Record<string, unknown>);
  }
  return out;
}

export { Reader as SubChunkReader };
