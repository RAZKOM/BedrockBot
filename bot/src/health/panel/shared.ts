// The panel's shared file (docs/panel.md "Files", decision 0061): constants and wire types that the
// server (Node) and the page's browser modules (health/panel/client/) both import. Rules, checked by
// test/unit/health/panel-modules.test.ts:
//   - no runtime import at all: only `export type ... from` (erased when the server strips the types,
//     so the browser never asks for a server module);
//   - plain values only (numbers, strings, frozen arrays): no Node API, no DOM.

/** The page's poll of /api/state?lite=1 when the stream is not used (fallback), and while the tab is hidden. */
export const POLL_MS = 2000;
export const HIDDEN_POLL_MS = 10_000;
/** Decision 0062: the map screen asks for its tiles this often only while the stream does not deliver (fallback). */
export const MAP_POLL_MS = 2000;

// ---- decision 0062: the map screen (docs/map.md) ------------------------------------------------------

/** Stream topics of the map (health/map/live.ts): tile changes (event) and the overlays (state). */
export const MAP_TOPIC = 'map';
export const MAP_LIVE_TOPIC = 'map-live';
/** Routes of the map screen (behind the token). */
export const MAP_TILES_PATH = '/api/map/tiles';
export const MAP_SLICE_PATH = '/api/map/slice';
/** Largest window radius (chunks) of a tiles fetch and of a slice. */
export const MAP_TILES_MAX_R = 16;
export const MAP_SLICE_MAX_R = 8;
/** A registered window lives this long after its last fetch; the page fetches (0 tiles when nothing changed) every WINDOW_TOUCH_MS. */
export const WINDOW_TTL_MS = 120_000;
export const WINDOW_TOUCH_MS = 45_000;
/** The map's marks (chests, ores, beds ...) are fetched again this often while the map shows. */
export const MARKS_REFRESH_MS = 15_000;
/** Top-face textures: GET /tex/<block>.png (16 x 16). */
export const TEX_PREFIX = '/tex/';
/** localStorage keys: the view (map / cards), the map's overlays and layer. */
export const VIEW_KEY = 'bbpanel-view';
export const MAP_PREFS_KEY = 'bbpanel-map';
/** A destructive menu action stays armed this long after the first tap. */
export const CONFIRM_MS = 4000;
/** localStorage keys: the quick buttons, the theme. */
export const QUICK_KEY = 'bbpanel-quick';
export const THEME_KEY = 'bbpanel-theme';

/** The item glyph classes (inventory.ts iconClassOf picks one; glyphs.ts draws each). */
export const ICON_CLASSES = ['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'bow', 'shield', 'helmet', 'chestplate', 'leggings', 'boots', 'food', 'block', 'ore', 'box', 'bucket', 'torch', 'item'] as const;
export type IconClass = (typeof ICON_CLASSES)[number];

// ---- the push channel (stream.ts on the server, client/transport.ts in the page) --------------------

/** Server-Sent Events: GET this path (same token / cookie as every route). `?topics=a,b` picks topics, `?last=<id>` resumes. */
export const STREAM_PATH = '/api/stream';
/** The panel state topic: a snapshot on connect, then deltas (client/delta.ts). */
export const STATE_TOPIC = 'state';
/** The event topic: every new bot event (decision 0059) with its display text, published by index.ts. */
export const EVENTS_TOPIC = 'events';
/** The first message of every stream (no id): what the client needs to know about the server. */
export const HELLO_EVENT = 'hello';
/** Sent when a stream has been quiet this long (so the client and any proxy know it is alive). */
export const HEARTBEAT_EVENT = 'hb';
export const HEARTBEAT_MS = 5000;
/** The client: no message for this long = the stream is broken (fall back to polling, then try again). */
export const STREAM_STALL_MS = 15_000;
/** The client: no snapshot this long after opening = a proxy buffers the stream (fall back to polling). */
export const STREAM_OPEN_MS = 6000;
/** The client: after a fallback, try the stream again after this long (doubling per failure, up to 8 min). */
export const STREAM_RETRY_MS = 30_000;
/** The server samples the panel state this often while a stream listens to it. */
export const STATE_SAMPLE_MS = 1000;

/** The hello message's data. */
export interface StreamHello {
  /** Changes on every bot start: an id from another boot cannot resume. */
  boot: string;
  /** True when the events after `last` were replayed; false = snapshots follow. */
  resumed: boolean;
  /** The topics this stream carries. */
  topics: string[];
  /** HEARTBEAT_MS of the server. */
  hb: number;
}

// ---- wire types (type-only: erased before the page gets this file) ---------------------------------
export type { PanelState, PanelStateLite, PanelLink, PanelSetting, PanelChatLine } from './state.ts';
export type { PanelItem, PanelInventory } from './inventory.ts';
export type { PanelMarks } from './marks.ts';
export type { PanelChestRow } from './memory.ts';
export type { MapJson, MapTileJson, CompactTileJson, SliceTileJson } from '../map/schema.ts';
export type { MapLiveJson } from '../map/data.ts';
