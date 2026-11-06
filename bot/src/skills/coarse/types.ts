// Track CB (ADR 0066, docs/coarse.md): the shared long-range layer. A coarse graph over every chunk the
// bot has seen (the live world plus the persistent world cache, ADR 0015 / 0060): volumes of open space
// (open sky over the column tops, caves, tunnels, water) per chunk section, and portals where two volumes
// touch (a cave mouth, a shaft, a tunnel crossing a chunk border). One query, `CoarseLayer.plan`, returns
// a corridor: legs with a mode each (walk, mine, fly), the portals they cross and waypoints in world
// coordinates. The fine planners follow it a window at a time: nav/ (walk, mine) and fly/corridor/
// (Track F4b, the flight session). This file is the contract between them; change it only together.
//
// Unknown space (columns never loaded) is not blocked: it costs `unknownCost` per block and every leg
// says how much of it runs through unknown space (`unknownFraction`). The executor decides whether to
// commit (flight never commits a fly leg into unknown underground space; walking explores and the layer
// re-plans when the chunks arrive, `CoarseLayer.onChange`).
import type { Vec3 } from '../../world/types.ts';

/** How a leg is travelled. `mine` = walking that may dig through (allowBreak); the layer prices it, the walk executor carries it out. */
export type CoarseMode = 'walk' | 'mine' | 'fly';

/** How much of a volume or portal the layer has seen: every cell, some cells (a chunk partly cached), none. */
export type Knowledge = 'known' | 'partial' | 'unknown';

/**
 * What a volume is. `sky`: the open air above the column tops of a chunk (one per chunk and dimension),
 * `surface`: open air under a roof but with sky reachable sideways within the chunk (overhangs, under
 * trees), `cave`: enclosed air (caves, tunnels, mineshafts, buildings), `water`: liquid water, `unknown`:
 * a never-seen chunk section (one volume per section, crossable at `unknownCost`).
 */
export type VolumeKind = 'sky' | 'surface' | 'cave' | 'water' | 'unknown';

/** `${dim}:${cx}:${cz}:${sy}:${n}`: dimension, chunk, section index (sy = floor(y / 16)), component number in the section. Stable while the section's cells do not change. */
export type VolumeId = string;

/**
 * `${dim}:${axis}:${x}:${y}:${z}`: the portal's min opening cell and its axis. Stable across rebuilds while
 * the opening keeps its min cell, so `markPortal` feedback survives chunk reloads and restarts.
 */
export type PortalId = string;

/** A connected component of passable cells (air or water, never `avoid`) inside one chunk section (16 x 16 x 16), or the sky over a chunk. */
export interface Volume {
  id: VolumeId;
  kind: VolumeKind;
  dim: number;
  /**
   * Inclusive cell bounds. For a `sky` volume min.y is the HIGHEST column top in the chunk plus 1 (the
   * lowest y that is open sky over every column: edgeCost prices a climb over a ridge from it) and max.y
   * the world's top; for an `unknown` volume the section's real bounds (y = sy * 16 .. sy * 16 + 15).
   */
  min: Vec3;
  max: Vec3;
  /** Passable cells in the component. */
  cells: number;
  /** Cells with a standable floor under them (walkable without placing). 0 for a shaft or open water. */
  floorCells: number;
  /** Clear cells over the floor cells (feet up to the first solid), min and max over them; rough. Undefined without floor cells. */
  headroom?: { min: number; max: number };
  /** The narrowest horizontal cross-section of the component across its longest horizontal axis (blocks); rough, 16 for sky. */
  minSpan: number;
  known: Knowledge;
}

/**
 * Where an opening faces. 'y': a horizontal opening crossed vertically (a shaft, a hole in a roof, a cave
 * mouth that opens upwards); 'x' / 'z': a vertical opening crossed along that axis (a tunnel mouth, a door,
 * a chunk border inside a tunnel).
 */
export type PortalAxis = 'x' | 'y' | 'z';

/** The opening between two volumes: the shared face cells of a section or chunk border, or a volume's contact with the sky. */
export interface Portal {
  id: PortalId;
  /**
   * The two volumes it joins (edges are traversable both ways unless a mode's cost says otherwise). For
   * axis 'y' a is the UPPER volume and b the lower one (a shaft entered from above crosses a -> b); for
   * axis 'x' / 'z' a is the volume on the lower coordinate side.
   */
  a: VolumeId;
  b: VolumeId;
  axis: PortalAxis;
  /** Inclusive bounds of the opening cells (one cell thick along the axis). */
  min: Vec3;
  max: Vec3;
  /**
   * The centre of the largest clear rectangle in the opening (`clearance`), cell coordinates with .5 on
   * the axes where the rectangle is even (a waypoint aims here). For axis 'x' / 'z', y is the rectangle's
   * lowest cell (feet height), not its middle.
   */
  center: Vec3;
  /**
   * The largest clear rectangle in the opening: for axis 'x' / 'z' height = vertical extent, width =
   * horizontal extent across the axis; for axis 'y' height and width are the two horizontal extents (the
   * larger first). A 1 x 2 tunnel mouth: { height: 2, width: 1 }; a 1 x 1 shaft: { height: 1, width: 1 }.
   */
  clearance: { height: number; width: number };
  /** Lowest standable floor y under the opening (feet y), when one is within 3 below it. Undefined: no floor (a shaft, a drop). */
  floorY?: number;
  known: Knowledge;
  /**
   * Track CB addition (optional, docs/coarse.md "Dig portals"): a synthetic portal the layer offers to
   * the `mine` mode only, where two volumes are separated by solid: the number of solid blocks to dig
   * through (rough, at least 1). Its id ends in `:dig`; `CoarseLayer.portal` does not find it. Absent on
   * every real opening. Every other mode's cost must return Infinity for it.
   */
  dug?: number;
}

/** The outcome an executor reports for a portal it tried (`CoarseLayer.markPortal`). */
export type PortalOutcome = 'ok' | 'failed';

/**
 * A mode's prices on the coarse graph. The layer ships `walk` and `mine`; flight registers its own
 * (`CoarseLayer.setCost('fly', ...)`, Track F4b). Every cost is in ticks, so modes compare directly.
 */
export interface CoarseCost {
  mode: CoarseMode;
  /** The smallest opening the mode can pass at all (fly: 2 x 1 gliding in, 3 x 1 powered; walk: 2 x 1). */
  clearance: { height: number; width: number };
  /** Can the mode enter or leave a volume of this kind (fly: not into water; walk: sky only on its floor cells). */
  allows(kind: VolumeKind): boolean;
  /**
   * The cost of crossing `portal` from `from` to `to` plus travelling `blocks` inside `to` to the next
   * waypoint (Infinity: impassable for this mode). `outcome` is the last markPortal outcome for this mode, if any.
   */
  edgeCost(portal: Portal, from: Volume, to: Volume, blocks: number, outcome?: PortalOutcome): number;
  /**
   * Ticks per block through unknown space (high, not Infinity). A mode may price unknown volumes by their
   * y bounds instead inside edgeCost (high unknown sky nearly free for fly); this is the flat fallback.
   */
  unknownCost: number;
  /**
   * The cost of switching INTO this mode from `from` inside volume `at` (near portal `near` when the switch
   * is at one): Infinity where it is impossible (fly from water; walk from fly without a floor). Absent:
   * `PlanRequest.modeSwitchCost`.
   */
  switchCost?(from: CoarseMode, at: Volume, near?: Portal): number;
  /**
   * Track CB addition (optional): the mode's best ticks per block in the open (the search heuristic's
   * slope: the smallest over the requested modes scales the straight-line distance). Must not be above
   * the real best, or the corridor is no longer the cheapest. Absent: 0.5 (a fast flight; a weak but safe
   * estimate for walking, which then expands more nodes).
   */
  ticksPerBlock?: number;
}

/** One stretch of a corridor travelled in one mode. */
export interface CorridorLeg {
  mode: CoarseMode;
  /**
   * Where the leg starts and ends (feet positions for walk / mine, body positions for fly). A fly leg
   * followed by a walk / mine leg ends on a standable feet cell (a floor), so the flight can land on it;
   * so does the last fly leg when `PlanRequest.goalStanding`.
   */
  from: Vec3;
  to: Vec3;
  /** The portal the leg enters through (undefined for the first leg) and the one it leaves by (undefined for the last). */
  entry?: Portal;
  exit?: Portal;
  /** Every portal crossed inside the leg, in order (entry and exit included). */
  portals: Portal[];
  /** The volumes the leg runs through, in order. */
  volumes: VolumeId[];
  /** Waypoints in world coordinates: from, the centre of every portal crossed, to. The fine planner aims at them a window at a time. */
  waypoints: Vec3[];
  /** Length along the waypoints (blocks) and the coarse cost (ticks). */
  blocks: number;
  cost: number;
  /** Share of `blocks` through unknown volumes (0..1). */
  unknownFraction: number;
  /** The tightest opening on the leg. */
  minClearance: { height: number; width: number };
}

export type CorridorStatus =
  /** A corridor to the goal. */
  | 'found'
  /** Search limit hit: the corridor ends at the volume nearest the goal (re-plan from its end). */
  | 'partial'
  /** Exhaustive: no corridor in the allowed modes (every known way tried, unknown space included). */
  | 'none';

export interface Corridor {
  status: CorridorStatus;
  start: Vec3;
  goal: Vec3;
  dim: number;
  legs: CorridorLeg[];
  /** Totals over the legs. */
  blocks: number;
  cost: number;
  unknownFraction: number;
  /** Why `partial` / `none`, for the log and the chat line. */
  reason?: string;
  /** Graph nodes expanded and search time (ms). */
  expanded: number;
  ms: number;
  /** The layer's revision the plan was made on (a re-plan is due when `CoarseLayer.revision` moved past it near the corridor). */
  revision: number;
}

export interface PlanRequest {
  start: Vec3;
  goal: Vec3;
  /** Dimension; default the current one. */
  dim?: number;
  /** Modes the corridor may use; ['fly'] asks for a fly-only corridor (takeoff and landing included), to compare against a mixed one. */
  modes: readonly CoarseMode[];
  /** Ticks added at every change of mode (a takeoff, a landing) where the entered mode's cost has no `switchCost`. Default 40. */
  modeSwitchCost?: number;
  /** The mode the bot is in at the start (default 'walk'): a bot already gliding pays no takeoff. */
  startMode?: CoarseMode;
  /** The corridor ends standing on the goal's floor (default true); false for a passing waypoint (the flight need not land). */
  goalStanding?: boolean;
  /** Search limits; defaults 200 000 nodes / 500 ms (the search runs in a worker). */
  maxNodes?: number;
  maxMs?: number;
}

/** The layer as its users see it. */
export interface CoarseLayer {
  /** Plan a corridor. Never throws: a failure is a `none` / `partial` corridor with a reason. */
  plan(req: PlanRequest): Promise<Corridor>;
  /** Register or replace a mode's prices (flight registers 'fly'). */
  setCost(mode: CoarseMode, cost: CoarseCost): void;
  /** Executor feedback: this portal worked or failed for this mode. A failure decays (default 30 min) so a cleared tunnel is tried again. */
  markPortal(id: PortalId, mode: CoarseMode, outcome: PortalOutcome): void;
  /** The volume holding cell p (feet cell for walk), or undefined when p is solid or out of the world. */
  volumeAt(p: Vec3, dim?: number): Volume | undefined;
  /** A portal by id, if it still exists. */
  portal(id: PortalId): Portal | undefined;
  /** Bumped whenever volumes or portals change (a chunk loads, a block update changes a section). */
  readonly revision: number;
  /** Called with the chunk columns whose volumes changed; returns the unsubscribe. */
  onChange(fn: (chunks: readonly { cx: number; cz: number; dim: number }[]) => void): () => void;
}
