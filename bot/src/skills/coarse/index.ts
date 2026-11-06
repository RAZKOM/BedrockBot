// Track CB (ADR 0066, docs/coarse.md): the shared long-range layer.
//
//   const { layer } = attachCoarseLayer(world)!;                 // over the world cache, kept current
//   const c = await layer.plan({ start, goal, modes: ['walk'] }); // a corridor: legs, waypoints
//   layer.markPortal(c.legs[0].portals[0].id, 'walk', 'failed');  // executor feedback (30-minute decay)
//   layer.setCost('fly', flyCost);                                // flight registers its prices
export type * from './types.ts';
export { CoarseLayerImpl, attachCoarseLayer, type CoarseLayerOptions, type CoarseWorld, type CoarsePlanStats } from './layer.ts';
export { CoarseGraph, chunkKey, type CoarseGraphOptions, type CoarseGraphStats } from './graph.ts';
export { cacheSource, terrainSource, ClassGrid, type CoarseSource, type ChunkCells, type CacheLike } from './source.ts';
export { walkCost, mineCost, walkable, PortalMarks, WALK_TICKS, DIG_TICKS, UNKNOWN_TICKS, PORTAL_TICKS, FAILED_DECAY_MS } from './costs.ts';
export { planCorridor, DEFAULT_MAX_NODES, DEFAULT_MAX_MS, SLICE_MS, type SearchDeps } from './search.ts';
export { buildKnownChunk, buildUnknownChunk, borderPortals, portalOf, largestRectangle, labelAt, volumeAtCell, SKY, type ChunkGraph } from './chunk.ts';
