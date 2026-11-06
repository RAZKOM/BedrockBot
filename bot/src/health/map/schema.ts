// GET /map.json (PLAN.md task 7.15): the debug map's data. One schema for the builder (data.ts), the
// page (page.ts) and the tests. Chunk tiles carry per column the surface y and its cache class
// (0 air / nothing, 1 solid, 2 water, 3 avoid) as base64: `y` = 256 x int16 little endian (index
// z * 16 + x, -32768 = nothing), `c` = 256 x 2 bits (4 columns per byte, low bits first).
// Track PC (decision 0060), additive: the surface layer (`s`, `p`, `sy`, `f`, `d`, `u`) and the
// response's `palette` (block names and map colours); see docs/world-cache.md "Debug map".
import { z } from 'zod';

export const MAP_JSON_VERSION = 1;

const num = z.number().refine(Number.isFinite, 'finite number');
const int = z.number().int();
export const Vec3Schema = z.object({ x: num, y: num, z: num });
const b64 = (bytes: number) => z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).length(Math.ceil(bytes / 3) * 4);

export const MapTileSchema = z.object({
  cx: int,
  cz: int,
  /** Loaded now (live summary) or only remembered (cache). */
  live: z.boolean(),
  rev: int.nonnegative(),
  /** Wall-clock ms of the last change the cache saw. */
  updatedAt: num,
  y: b64(512),
  c: b64(64),
  /** Track PC: surface block per column, 256 x u8 indices into `p` (255 = nothing recorded). Absent for a record without surface data. */
  s: b64(256).optional(),
  /** Track PC: the tile's name table as indices into the response's `palette` (with `s`). */
  p: z.array(int.nonnegative()).max(255).optional(),
  /** Track PC: surface y per column (256 x int16), only when it differs from `y` somewhere. */
  sy: b64(512).optional(),
  /** Track PC: floor under a liquid surface, 256 x u8 indices into `p` (255 = none); only when the tile has a liquid column. */
  f: b64(256).optional(),
  /** Track PC: liquid depth per column, 256 x u8 (0 = not a liquid; 255 = 255 or deeper); with `f`. */
  d: b64(256).optional(),
  /** Track PC: the under-roof layer (roofed dimensions: the Nether), same encoding, y always present. */
  u: z.object({ s: b64(256), sy: b64(512), f: b64(256).optional(), d: b64(256).optional() }).optional(),
});

/** Track PC: a block name of the response and its map colour (`#rrggbb`), null when there is no art for it (draw the class colour). */
export const MapPaletteEntrySchema = z.object({ name: z.string().min(1).max(64), rgb: z.string().regex(/^#[0-9a-f]{6}$/).nullable() });

export const MapEntitySchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().optional(),
  kind: z.enum(['player', 'hostile', 'neutral', 'passive', 'item', 'other']),
  /** Feet position. */
  x: num,
  y: num,
  z: num,
});

export const MapWaypointSchema = z.object({ name: z.string(), x: num, y: num, z: num });

export const MapJsonSchema = z
  .object({
    v: z.literal(MAP_JSON_VERSION),
    ts: num,
    server: z.string().nullable(),
    dimension: int,
    /** Tiles changed after this rev are newer than this response (pass it back as `since`). */
    rev: int.nonnegative(),
    /** The window: chunks cx0..cx1, cz0..cz1 around `center`. */
    center: z.object({ cx: int, cz: int }),
    radius: int.min(0).max(64),
    window: z.object({ cx0: int, cz0: int, cx1: int, cz1: int }),
    /** Tiles of the window that changed since `since`, plus every tile outside the caller's previous window. */
    tiles: z.array(MapTileSchema),
    /** Track PC: block names the tiles' `p` tables point at, with their map colours. */
    palette: z.array(MapPaletteEntrySchema),
    bot: z.object({ x: num, y: num, z: num, yaw: num }).nullable(),
    /** Feet positions sampled about once a second (newest last). */
    trail: z.array(Vec3Schema),
    nav: z.object({
      busy: z.boolean(),
      running: z.string().nullable(),
      /** The current planned path when the navigator report exposes one (`lastGoto.path`), else null. */
      path: z.array(Vec3Schema).nullable(),
      /** The goal of the last goto as a point (block / near goals; xz goals at the bot's y), or null. */
      goal: Vec3Schema.nullable(),
      result: z.string().nullable(),
      plans: int.nonnegative(),
    }),
    entities: z.array(MapEntitySchema),
    home: Vec3Schema.nullable(),
    shelter: Vec3Schema.nullable(),
    waypoints: z.array(MapWaypointSchema),
    cache: z
      .object({
        dir: z.string(),
        live: int.nonnegative(),
        decoded: int.nonnegative(),
        regions: int.nonnegative(),
        approxBytes: int.nonnegative(),
        lookups: int.nonnegative(),
        corrections: int.nonnegative(),
        errors: int.nonnegative(),
      })
      .nullable(),
  })
  .strict();

export type MapJson = z.infer<typeof MapJsonSchema>;
export type MapTileJson = z.infer<typeof MapTileSchema>;
export type MapEntityJson = z.infer<typeof MapEntitySchema>;
export type MapPaletteEntry = z.infer<typeof MapPaletteEntrySchema>;
