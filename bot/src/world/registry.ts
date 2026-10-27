// Registry shim (PLAN.md task 2.1): builds the prismarine registry from `start_game` plus
// `item_registry` (either order), resolves hashed block runtime ids to state ids, and counts runtime
// ids it cannot resolve.
//
// Runtime ids (hashed, 1.26.x): FNV-1a 32 of the little-endian NBT { name, states sorted by key }
// (`blockHash`). minecraft-data's bedrock block states stop at 1.26.30; for game versions with a dumped
// BDS palette (shim.blockPalette, version-shims/palette.ts; wave 8 Track AC, decision 0024) the table is
// built from the dump: palette states equal to a minecraft-data state keep that state id (0 ..
// mdStates - 1), the others (1.26.60: stairs with `minecraft:corner`, fences / panes / fire with
// `minecraft:connection_*`, redstone wire connections, new blocks) get ids from mdStates up, with hardness
// and collision boxes borrowed from the closest minecraft-data state of the same block (or a shape donor,
// palette.ts `shapeDonor`). Without a dump, minecraft-data's states are all there is.
import { createRequire } from 'node:module';
import nbt from 'prismarine-nbt';
import { createLogger, type Logger } from '../log.ts';
import type { ItemRegistry, ItemStateEntry, StartGame } from './packets.ts';
import type { BlockInfo, Box } from './types.ts';
import { shimFor, SHIMS, type VersionShim } from './version-shims/index.ts';
import { fastBlockHash, loadPalette, shapeDonor, type BlockPalette } from './version-shims/palette.ts';

const require = createRequire(import.meta.url);

/** One minecraft-data block state: typed NBT values, e.g. { pillar_axis: { type: 'string', value: 'y' } }. */
export type TypedStates = Record<string, { type: string; value: unknown }>;

interface PBlockState {
  name: string;
  states: TypedStates;
}

interface PBlock {
  id: number;
  name: string;
  hardness: number | null;
  boundingBox: string;
  minStateId: number;
  maxStateId: number;
  defaultState: number;
  shapes?: number[][];
  stateShapes?: number[][][];
}

interface PItem {
  id: number;
  name: string;
  stackSize?: number;
}

/** The parts of prismarine-registry (bedrock flavour) this module uses. */
interface PRegistry {
  blockStates: PBlockState[];
  blocksByStateId: Record<number, PBlock | undefined>;
  blocksByName: Record<string, PBlock | undefined>;
  blocksByRuntimeId?: Record<string, { stateId: number } | undefined>;
  items: Record<number, PItem | undefined>;
  itemsByName: Record<string, PItem | undefined>;
  handleStartGame(packet: unknown): void;
}

const loadPrismarineRegistry = require('prismarine-registry') as (version: string) => PRegistry;

/** minecraft-data's per-state collision shapes (prismarine-registry does not attach them to bedrock blocks). */
interface CollisionShapes {
  blocks: Record<string, number | number[]>;
  shapes: Record<string, number[][]>;
}
const collisionShapes = new Map<string, CollisionShapes | undefined>();
function collisionShapesOf(registryVersion: string): CollisionShapes | undefined {
  if (!collisionShapes.has(registryVersion)) {
    const md = (require('minecraft-data') as (v: string) => { blockCollisionShapes?: CollisionShapes } | undefined)(registryVersion);
    collisionShapes.set(registryVersion, md?.blockCollisionShapes);
  }
  return collisionShapes.get(registryVersion);
}

/** Hashes of a palette's entries (same order), computed once per palette. */
const paletteHashes = new WeakMap<BlockPalette, Int32Array>();
function hashesOf(palette: BlockPalette): Int32Array {
  let h = paletteHashes.get(palette);
  if (!h) {
    h = new Int32Array(palette.entries.length);
    palette.entries.forEach((e, i) => (h![i] = fastBlockHash(e.name, e.states)));
    paletteHashes.set(palette, h);
  }
  return h;
}

/** A palette state minecraft-data does not have (id = mdStates + index). */
interface ExtState {
  name: string;
  states: TypedStates;
  /** minecraft-data state whose hardness and shape it borrows; -1 = none (a full solid cube); undefined = not looked up yet. */
  base?: number;
}

const FULL_BOX: Box = [0, 0, 0, 1, 1, 1];
/** The wire runtime id of the `minecraft:unknown` block on hashed servers (a fixed id, not its hash). */
export const UNKNOWN_BLOCK_RUNTIME_ID = -2;

/** 32-bit FNV-1a over bytes, as a signed int32 (the form block runtime ids take on the wire). */
export function fnv1a32(buf: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of buf) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Bedrock's hashed block runtime id: FNV-1a 32 of the little-endian NBT compound
 * { name: "minecraft:<name>", states: { ...sorted by key } }. Same rule as prismarine-block's getHash.
 */
export function blockHash(name: string, states: TypedStates): number {
  const sorted: TypedStates = {};
  for (const key of Object.keys(states).sort()) sorted[key] = states[key]!;
  const tag = nbt.comp({
    name: { type: 'string', value: name.includes(':') ? name : `minecraft:${name}` },
    states: nbt.comp(sorted),
  });
  // prismarine-nbt's typings want a named root; the runtime accepts this shape (prismarine-block does the same).
  return fnv1a32(nbt.writeUncompressed(tag as unknown as nbt.NBT, 'little'));
}

function plainStates(states: TypedStates): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(states)) out[k] = v.value;
  return out;
}

export interface BlockRegistryOptions {
  /** Game version (bedrock-protocol version string). Default '1.26.60'. */
  version?: string;
  logger?: Logger;
}

/**
 * Wraps prismarine-registry for one connection. Feed it `start_game` and `item_registry`; it becomes
 * `ready` once both have arrived (or `finalize()` was called, e.g. at spawn, without item_registry).
 */
export class BlockRegistry {
  readonly shim: VersionShim;
  readonly version: string;
  private readonly log: Logger;
  private readonly reg: PRegistry;
  private startGame: StartGame | undefined;
  private itemRegistry: ItemRegistry | undefined;
  private _ready = false;
  private _hashed = true;
  private readonly readyFns = new Set<() => void>();
  /** runtime id -> state id */
  private readonly byRuntimeId = new Map<number, number>();
  /** state id -> runtime id */
  private runtimeIds: Int32Array = new Int32Array(0);
  private readonly infos: (BlockInfo | undefined)[] = [];
  private readonly unknownInfos = new Map<number, BlockInfo>();
  /** Unresolved runtime id -> number of times it was looked up (palette entries and updates). */
  readonly unknownRuntimeIds = new Map<number, number>();
  /** State id of `air` (used for all-air subchunks). */
  readonly airStateId: number;
  /** The dumped BDS palette for this version (undefined: minecraft-data's states only). */
  readonly palette: BlockPalette | undefined;
  /** Number of minecraft-data block states (state ids below this are minecraft-data's). */
  private readonly mdStates: number;
  /** Palette states minecraft-data does not have, by state id - mdStates. */
  private ext: ExtState[] = [];
  /** Block name -> state ids of its palette states, the default first (empty without a palette). */
  private readonly paletteByName = new Map<string, number[]>();

  constructor(opts: BlockRegistryOptions = {}) {
    this.version = opts.version ?? '1.26.60';
    this.log = opts.logger ?? createLogger('info', 'world');
    const shim = shimFor(this.version);
    if (!shim) {
      this.shim = SHIMS[0]!;
      this.log.warn(`no world version shim for ${this.version}; using ${this.shim.gameVersions.join(',')}`);
    } else {
      this.shim = shim;
    }
    this.reg = loadPrismarineRegistry(this.shim.registryVersion);
    const air = this.reg.blocksByName.air;
    if (!air) throw new Error(`registry ${this.shim.registryVersion} has no air block`);
    this.airStateId = air.defaultState;
    this.mdStates = this.reg.blockStates.length;
    this.palette = this.shim.blockPalette ? loadPalette(this.shim.blockPalette) : undefined;
    if (this.shim.blockPalette && !this.palette) this.log.warn(`no block palette file for ${this.shim.blockPalette}; using minecraft-data ${this.shim.blockDataVersion} block states`);
  }

  /** Where block states come from, for logs: `palette 1.26.60 (BDS 1.26.60.6)` or `minecraft-data 1.26.30`. */
  get blockDataSource(): string {
    return this.palette ? `palette ${this.palette.version} (BDS ${this.palette.bds})` : `minecraft-data ${this.shim.blockDataVersion}`;
  }

  /** Number of palette states minecraft-data does not have (0 without a palette or before the build). */
  get extraStateCount(): number {
    return this.ext.length;
  }

  get ready(): boolean {
    return this._ready;
  }

  /** True when the server uses hashed runtime ids (start_game.block_network_ids_are_hashes). */
  get hashed(): boolean {
    return this._hashed;
  }

  /** Number of state ids: minecraft-data's block states plus the palette states it does not have. */
  get stateCount(): number {
    return this.mdStates + this.ext.length;
  }

  /** Runs `fn` once the registry is ready (immediately if it already is). */
  onReady(fn: () => void): void {
    if (this._ready) fn();
    else this.readyFns.add(fn);
  }

  handleStartGame(p: StartGame): void {
    this.startGame = p;
    this._ready = false;
    this.tryBuild(false);
  }

  handleItemRegistry(p: ItemRegistry): void {
    this.itemRegistry = p;
    if (this._ready && this.startGame) {
      // A late item_registry (after finalize): reload the item table only.
      this._ready = false;
    }
    this.tryBuild(false);
  }

  /** Build with whatever arrived (call at spawn). No-op when already ready or start_game is missing. */
  finalize(): void {
    this.tryBuild(true);
  }

  private tryBuild(force: boolean): void {
    if (this._ready || !this.startGame) return;
    let itemstates = this.shim.itemStates(this.startGame, this.itemRegistry);
    if (!itemstates) {
      if (!force) return;
      this.log.warn('building the registry without item states (no item_registry seen)');
      itemstates = [];
    }
    this.build(this.startGame, itemstates);
  }

  private build(startGame: StartGame, itemstates: ItemStateEntry[]): void {
    const t0 = performance.now();
    this._hashed = startGame.block_network_ids_are_hashes !== false;
    this.reg.handleStartGame({ ...startGame, itemstates, block_network_ids_are_hashes: this._hashed });
    this.byRuntimeId.clear();
    this.paletteByName.clear();
    this.ext = [];
    const mdRuntimeIds = new Int32Array(this.mdStates);
    for (const [rid, entry] of Object.entries(this.reg.blocksByRuntimeId ?? {})) {
      if (!entry) continue;
      const id = Number(rid) | 0;
      this.byRuntimeId.set(id, entry.stateId);
      mdRuntimeIds[entry.stateId] = id;
    }
    // Sequential runtime ids are minecraft-data's order; the palette only applies to hashed ids.
    const palette = this._hashed ? this.palette : undefined;
    if (palette) {
      const hashes = hashesOf(palette);
      const extIds: number[] = [];
      palette.entries.forEach((e, i) => {
        const h = hashes[i]!;
        let s = this.byRuntimeId.get(h);
        if (s === undefined) {
          s = this.mdStates + this.ext.length;
          this.ext.push({ name: e.name, states: e.states });
          extIds.push(h);
          this.byRuntimeId.set(h, s);
        }
        let list = this.paletteByName.get(e.name);
        if (!list) this.paletteByName.set(e.name, (list = []));
        list.push(s);
      });
      this.runtimeIds = new Int32Array(this.mdStates + this.ext.length);
      this.runtimeIds.set(mdRuntimeIds);
      this.runtimeIds.set(extIds, this.mdStates);
    } else {
      this.runtimeIds = mdRuntimeIds;
    }
    if (this._hashed) {
      // BDS 1.26.60.6 sends `minecraft:unknown` as runtime id -2, not as its hash (seen with truth:palettestrip).
      const unknownBlock = this.stateIdOf('unknown');
      if (unknownBlock !== undefined && !this.byRuntimeId.has(UNKNOWN_BLOCK_RUNTIME_ID)) this.byRuntimeId.set(UNKNOWN_BLOCK_RUNTIME_ID, unknownBlock);
    }
    this._ready = true;
    this.log.debug(
      `registry ${this.shim.registryVersion} ready: ${this.byRuntimeId.size} block runtime ids (${this._hashed ? 'hashed' : 'sequential'}, ${this.blockDataSource}${palette ? `, ${this.ext.length} states beyond minecraft-data ${this.shim.blockDataVersion}` : ''}), ${itemstates.length} items, ${Math.round(performance.now() - t0)} ms`,
    );
    const fns = [...this.readyFns];
    this.readyFns.clear();
    for (const fn of fns) fn();
  }

  /** State id for a wire runtime id, or -1 (counted in unknownRuntimeIds) when unknown. */
  stateIdFromRuntimeId(runtimeId: number): number {
    const rid = runtimeId | 0;
    const s = this.byRuntimeId.get(rid);
    if (s !== undefined) return s;
    const prev = this.unknownRuntimeIds.get(rid);
    this.unknownRuntimeIds.set(rid, (prev ?? 0) + 1);
    if (prev === undefined) {
      this.log.warn(
        `unknown block runtime id ${rid} (${this._ready ? `registry data is from ${this.blockDataSource}` : 'registry not ready'}); treated as a solid "unknown" block`,
      );
    }
    return -1;
  }

  /** Wire runtime id of a state id (the hash on 1.26.x). */
  runtimeIdOf(stateId: number): number {
    if (!this._ready) throw new Error('registry not ready');
    const rid = this.runtimeIds[stateId];
    if (rid === undefined) throw new Error(`no state ${stateId}`);
    return rid;
  }

  /**
   * State id for a block name (with or without `minecraft:`) and optional plain states. Missing
   * states take the block's default. Undefined when no state matches. With a palette, the server's states
   * come first (the palette default for a bare name); minecraft-data's are the fallback.
   */
  stateIdOf(name: string, states?: Record<string, unknown>): number | undefined {
    const short = name.startsWith('minecraft:') ? name.slice(10) : name;
    const list = this.paletteByName.get(short);
    if (list && list.length > 0) {
      if (!states || Object.keys(states).length === 0) return list[0];
      const want = { ...plainStates(this.typedStatesOf(list[0]!) ?? {}), ...states };
      for (const s of list) {
        const have = plainStates(this.typedStatesOf(s) ?? {});
        if (Object.entries(want).every(([k, v]) => have[k] === v)) return s;
      }
    }
    const block = this.reg.blocksByName[short];
    if (!block) return undefined;
    if (!states || Object.keys(states).length === 0) return block.defaultState;
    const def = plainStates(this.reg.blockStates[block.defaultState]?.states ?? {});
    const want = { ...def, ...states };
    for (let s = block.minStateId; s <= block.maxStateId; s++) {
      const have = plainStates(this.reg.blockStates[s]?.states ?? {});
      if (Object.entries(want).every(([k, v]) => have[k] === v)) return s;
    }
    return undefined;
  }

  /** Name (no namespace) for a state id. */
  nameOf(stateId: number): string | undefined {
    if (stateId >= this.mdStates) return this.ext[stateId - this.mdStates]?.name;
    return this.reg.blockStates[stateId]?.name;
  }

  /** Typed (NBT) states of a state id, as used for hashing. */
  typedStatesOf(stateId: number): TypedStates | undefined {
    if (stateId >= this.mdStates) return this.ext[stateId - this.mdStates]?.states;
    return this.reg.blockStates[stateId]?.states;
  }

  /**
   * The minecraft-data state a palette-only state borrows hardness and shape from: the state of the same
   * block (or of its shape donor) that shares the most state values; -1 when there is none.
   */
  baseStateOf(stateId: number): number {
    if (stateId < this.mdStates) return stateId;
    const e = this.ext[stateId - this.mdStates];
    if (!e) return -1;
    if (e.base !== undefined) return e.base;
    const donor = this.reg.blocksByName[e.name] ?? this.reg.blocksByName[shapeDonor(e.name) ?? ''];
    let best = -1;
    if (donor) {
      const want = plainStates(e.states);
      let bestScore = -1;
      for (let s = donor.minStateId; s <= donor.maxStateId; s++) {
        const have = plainStates(this.reg.blockStates[s]?.states ?? {});
        let score = 0;
        for (const [k, v] of Object.entries(want)) if (have[k] === v) score++;
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
    }
    e.base = best;
    return best;
  }

  /** Cached BlockInfo for a state id (-1 = unknown). */
  blockInfo(stateId: number, runtimeId = 0): BlockInfo {
    if (stateId < 0) return this.unknownInfo(runtimeId);
    const cached = this.infos[stateId];
    if (cached) return cached;
    if (stateId >= this.mdStates) return this.extInfo(stateId, runtimeId);
    const state = this.reg.blockStates[stateId];
    const block = this.reg.blocksByStateId[stateId];
    if (!state || !block) return this.unknownInfo(runtimeId);
    const shapes = block.stateShapes?.[stateId - block.minStateId] ?? block.shapes ?? (block.boundingBox === 'block' ? [[...FULL_BOX]] : []);
    const boxes = shapes.map((s) => Object.freeze([s[0], s[1], s[2], s[3], s[4], s[5]] as unknown as Box));
    const info: BlockInfo = Object.freeze({
      name: state.name,
      stateId,
      states: Object.freeze(plainStates(state.states)),
      hardness: block.hardness ?? -1,
      solid: boxes.length > 0,
      boxes: Object.freeze(boxes),
    });
    this.infos[stateId] = info;
    return info;
  }

  /**
   * BlockInfo of a palette-only state: its own name and states; hardness and collision boxes (minecraft-data
   * blockCollisionShapes, as skills/terrain/shapes.ts reads them) of its base state; a full solid cube without one.
   */
  private extInfo(stateId: number, runtimeId: number): BlockInfo {
    const e = this.ext[stateId - this.mdStates];
    if (!e) return this.unknownInfo(runtimeId);
    const base = this.baseStateOf(stateId);
    const block = base >= 0 ? this.reg.blocksByStateId[base] : undefined;
    let boxes: Box[] = [[...FULL_BOX]];
    if (block) {
      const shapes = collisionShapesOf(this.shim.registryVersion);
      const entry = shapes?.blocks[block.name];
      if (entry === undefined || !shapes) {
        boxes = block.boundingBox === 'block' ? [[...FULL_BOX]] : [];
      } else {
        const id = typeof entry === 'number' ? entry : (entry[base - block.minStateId] ?? entry[0]);
        boxes = (id === undefined ? undefined : shapes.shapes[String(id)])?.map((b) => [b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!] as unknown as Box) ?? [];
      }
    }
    const info: BlockInfo = Object.freeze({
      name: e.name,
      stateId,
      states: Object.freeze(plainStates(e.states)),
      hardness: block?.hardness ?? -1,
      solid: boxes.length > 0,
      boxes: Object.freeze(boxes.map((b) => Object.freeze(b))),
    });
    this.infos[stateId] = info;
    return info;
  }

  /** BlockInfo for an unresolved runtime id: name `unknown`, treated as a solid full block. */
  unknownInfo(runtimeId: number): BlockInfo {
    let info = this.unknownInfos.get(runtimeId);
    if (!info) {
      info = Object.freeze({
        name: 'unknown',
        stateId: -1,
        states: Object.freeze({ runtime_id: runtimeId }),
        hardness: -1,
        solid: true,
        boxes: Object.freeze([FULL_BOX]),
      });
      this.unknownInfos.set(runtimeId, info);
    }
    return info;
  }

  /** Item name (no namespace) for a network item id, or undefined. Needs item_registry. */
  itemName(networkId: number): string | undefined {
    return this.reg.items[networkId]?.name;
  }

  /** Network item id for an item name (with or without namespace). */
  itemId(name: string): number | undefined {
    const short = name.startsWith('minecraft:') ? name.slice(10) : name;
    return this.reg.itemsByName[short]?.id;
  }

  /** One-line summary of unresolved runtime ids, e.g. for a shutdown log. */
  unknownSummary(): string {
    if (this.unknownRuntimeIds.size === 0) return 'no unknown block runtime ids';
    const parts = [...this.unknownRuntimeIds.entries()].sort((a, b) => b[1] - a[1]).map(([rid, n]) => `${rid} x${n}`);
    return `${this.unknownRuntimeIds.size} unknown block runtime id(s): ${parts.join(', ')}`;
  }
}
