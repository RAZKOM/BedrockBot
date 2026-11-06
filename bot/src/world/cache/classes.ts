// Per-block-state facts the cache needs, computed once per state id: the 2-bit class, whether the block
// is a roof for the planner's surface preference, whether it is "interesting" (kept by name), and the
// planner's movement signature (to tell which cells of a freshly loaded column differ from what the
// cache made the planner believe). Classification comes from the planner's own terrain/classify.ts.
import { classify, type TerrainClass } from '../../skills/terrain/classify.ts';
import type { BlockRegistry } from '../registry.ts';
import type { BlockInfo } from '../types.ts';
import { CLS_AIR, CLS_AVOID, CLS_SOLID, CLS_WATER, type CellClass } from './types.ts';

const KEEP_NAMES = new Set([
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'crafting_table',
  'furnace',
  'lit_furnace',
  'blast_furnace',
  'lit_blast_furnace',
  'smoker',
  'lit_smoker',
  'bed',
  'mob_spawner',
  'trial_spawner',
  'farmland',
  'ancient_debris',
  'crimson_stem',
  'warped_stem',
  'wooden_door',
  'iron_door',
]);

/** Blocks the cache remembers by name and position: logs, containers, workstations, beds, spawners, ores, farmland, doors. */
export function isInteresting(name: string): boolean {
  if (KEEP_NAMES.has(name)) return true;
  if (name.endsWith('_log')) return !name.startsWith('stripped_');
  return name.endsWith('_ore') || name.endsWith('_bed') || name.endsWith('_door') || name.endsWith('shulker_box'); // Track AG: shulker boxes are container marks like chests and barrels
}

// ---- Track PC (decision 0060): what the 2D map sees of a block --------------------------------------

/** The map looks past it (the surface is the block below). */
export const VIS_NONE = 0;
/** A visible block: the column's surface when nothing visible is above it. */
export const VIS_BLOCK = 1;
/** A liquid surface: the map records it, the floor under it and the depth. */
export const VIS_LIQUID = 2;
export type MapVisibility = typeof VIS_NONE | typeof VIS_BLOCK | typeof VIS_LIQUID;

/** Blocks the map looks through: air, technical blocks, clear glass, and things too small to see from above (torches, buttons, levers, tripwire). */
const SEE_THROUGH = new Set(['air', 'cave_air', 'void_air', 'light_block', 'barrier', 'structure_void', 'invisible_bedrock', 'moving_block', 'glass', 'glass_pane', 'hard_glass', 'hard_glass_pane', 'lever', 'trip_wire', 'tripwire', 'tripwire_hook', 'unknown_air']);

/**
 * How the map sees a block (Track PC, docs/world-cache.md "Surface layer"): liquids (water, lava and
 * the water plants the planner treats as water: seagrass, kelp, bubble columns) are a liquid surface,
 * named by their fluid; air, technical blocks, clear glass, torches, buttons, levers and tripwire are
 * looked through; everything else is visible, including what has no collision box (flowers, grass,
 * snow layers, carpets, rails, redstone), because that is what the ground looks like from above.
 */
export function mapView(name: string, c: Pick<TerrainClass, 'liquid'>): { vis: MapVisibility; name: string } {
  if (c.liquid) return { vis: VIS_LIQUID, name: c.liquid };
  if (SEE_THROUGH.has(name) || name.startsWith('light_block') || name.endsWith('_button') || /(^|_)torch$/.test(name) || name.startsWith('colored_torch')) return { vis: VIS_NONE, name };
  return { vis: VIS_BLOCK, name };
}

/** The cache class of a block as the planner sees it (layer 0). */
export function cellClassOf(c: TerrainClass): CellClass {
  if (c.danger) return CLS_AVOID;
  if (c.liquid) return CLS_WATER;
  return c.boxes.length > 0 ? CLS_SOLID : CLS_AIR;
}

/** Same fields as the navigator's movement signature (bot/src/skills/nav/navigator.ts). */
export function movementSignature(c: TerrainClass): string {
  return JSON.stringify([c.boxes, c.floor, c.liquid, c.liquidHeight, c.danger, c.costFactor, c.friction, c.roof, c.openable, c.open, c.connect, c.fullCube, c.gravity, c.protect, c.climbable]);
}

export interface StateFacts {
  cls: CellClass;
  roof: boolean;
  /** Name when the block is kept as a mark, else undefined. */
  mark: string | undefined;
  /** Small integer per distinct movement signature. */
  sig: number;
  /** Track PC: how the map sees it (VIS_NONE / VIS_BLOCK / VIS_LIQUID). */
  vis: MapVisibility;
  /** Track PC: the name the map records (the fluid for liquids: `water`, `lava`). */
  mapName: string;
}

/** Synthetic stand-ins: index by class, plus LEAVES for solid cells above the column's roof. */
export const SYN_LEAVES = 4;

export class StateTable {
  readonly registry: BlockRegistry;
  private readonly facts: (StateFacts | undefined)[] = [];
  private unknownFacts: StateFacts | undefined;
  private readonly sigIds = new Map<string, number>();
  private synInfos: BlockInfo[] | undefined;
  private synSigs: number[] | undefined;

  constructor(registry: BlockRegistry) {
    this.registry = registry;
  }

  private sigId(c: TerrainClass): number {
    const s = movementSignature(c);
    let id = this.sigIds.get(s);
    if (id === undefined) {
      id = this.sigIds.size;
      this.sigIds.set(s, id);
    }
    return id;
  }

  /** Facts for a state id (-1 = unknown runtime id: a solid obstacle). */
  of(stateId: number): StateFacts {
    if (stateId < 0) return (this.unknownFacts ??= this.make(this.registry.unknownInfo(0)));
    let f = this.facts[stateId];
    if (!f) this.facts[stateId] = f = this.make(this.registry.blockInfo(stateId));
    return f;
  }

  private make(info: BlockInfo): StateFacts {
    const c = classify(info);
    const view = mapView(info.name, c); // Track PC
    return { cls: cellClassOf(c), roof: c.roof, mark: isInteresting(info.name) ? info.name : undefined, sig: this.sigId(c), vis: view.vis, mapName: view.name };
  }

  /** Stand-in blocks: [air, stone, water, lava, oak_leaves]. Needs a ready registry. */
  synthetic(): readonly BlockInfo[] {
    if (!this.synInfos) {
      const r = this.registry;
      const by = (name: string, fallback: number) => r.blockInfo(r.stateIdOf(name) ?? fallback);
      const air = r.blockInfo(r.airStateId);
      this.synInfos = [air, by('stone', -1), by('water', r.airStateId), by('lava', -1), by('oak_leaves', -1)];
    }
    return this.synInfos;
  }

  /** Movement signature ids of the stand-ins (same order as `synthetic()`). */
  syntheticSigs(): readonly number[] {
    this.synSigs ??= this.synthetic().map((b) => this.sigId(classify(b)));
    return this.synSigs;
  }

  /** BlockInfo for a mark name (its default state), or undefined for names the registry does not know. */
  infoByName(name: string): BlockInfo | undefined {
    const s = this.registry.stateIdOf(name);
    return s === undefined ? undefined : this.registry.blockInfo(s);
  }
}
