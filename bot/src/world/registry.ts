// Registry shim (PLAN.md task 2.1): builds the prismarine registry from `start_game` plus
// `item_registry` (either order), resolves hashed block runtime ids to minecraft-data state ids,
// and counts runtime ids it cannot resolve (blocks newer than the registry's block data).
import { createRequire } from 'node:module';
import nbt from 'prismarine-nbt';
import { createLogger, type Logger } from '../log.ts';
import type { ItemRegistry, ItemStateEntry, StartGame } from './packets.ts';
import type { BlockInfo, Box } from './types.ts';
import { shimFor, SHIMS, type VersionShim } from './version-shims/index.ts';

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

const FULL_BOX: Box = [0, 0, 0, 1, 1, 1];

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
  /** Game version (bedrock-protocol version string). Default '1.26.51'. */
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

  constructor(opts: BlockRegistryOptions = {}) {
    this.version = opts.version ?? '1.26.51';
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
  }

  get ready(): boolean {
    return this._ready;
  }

  /** True when the server uses hashed runtime ids (start_game.block_network_ids_are_hashes). */
  get hashed(): boolean {
    return this._hashed;
  }

  /** Number of block states in the registry data. */
  get stateCount(): number {
    return this.reg.blockStates.length;
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
    const n = this.reg.blockStates.length;
    this.runtimeIds = new Int32Array(n);
    for (const [rid, entry] of Object.entries(this.reg.blocksByRuntimeId ?? {})) {
      if (!entry) continue;
      const id = Number(rid) | 0;
      this.byRuntimeId.set(id, entry.stateId);
      this.runtimeIds[entry.stateId] = id;
    }
    this._ready = true;
    this.log.debug(
      `registry ${this.shim.registryVersion} ready: ${this.byRuntimeId.size} block states (${this._hashed ? 'hashed' : 'sequential'} runtime ids, data from ${this.shim.blockDataVersion}), ${itemstates.length} items, ${Math.round(performance.now() - t0)} ms`,
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
        `unknown block runtime id ${rid} (${this._ready ? `registry data is from ${this.shim.blockDataVersion}` : 'registry not ready'}); treated as a solid "unknown" block`,
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
   * states take the block's default. Undefined when no state matches.
   */
  stateIdOf(name: string, states?: Record<string, unknown>): number | undefined {
    const short = name.startsWith('minecraft:') ? name.slice(10) : name;
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
    return this.reg.blockStates[stateId]?.name;
  }

  /** Typed (NBT) states of a state id, as used for hashing. */
  typedStatesOf(stateId: number): TypedStates | undefined {
    return this.reg.blockStates[stateId]?.states;
  }

  /** Cached BlockInfo for a state id (-1 = unknown). */
  blockInfo(stateId: number, runtimeId = 0): BlockInfo {
    if (stateId < 0) return this.unknownInfo(runtimeId);
    const cached = this.infos[stateId];
    if (cached) return cached;
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
