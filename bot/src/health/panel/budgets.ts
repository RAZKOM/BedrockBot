// The panel's byte budgets (docs/panel.md "Budgets", decision 0061): one per piece instead of one cap
// on the whole page, so a new card raises the piece it lives in, not a global number. Enforced in
// three places: the unit tests (worst-case fixture; panel-budgets.test.ts), the e2e on bds-core
// (panel-stream.test.ts measures the real thing), and at run time (assets.ts refuses a module over
// its budget at startup; stream.ts logs once when a snapshot or delta goes over). Measured values
// (worst-case fixture, `PANEL_MEASURE=1 npx vitest run --project unit test/unit/health/panel-budgets.test.ts`)
// are in docs/panel.md "Measured"; raise a number only with the reason written there.
export const PANEL_BUDGETS = {
  /**
   * GET / : the server-rendered structure, the CSS, the glyphs and the embedded lite state (worst case 108 KB
   * before decision 0065). Decision 0065 raised it from 120 000: the storage view's markup, the Bring picker
   * and their CSS add about 5 KB; 121.6 KB in all (docs/panel.md "Budgets").
   */
  html: 128_000,
  /** One browser module after type stripping (client/*.ts, shared.ts; the largest, paint.ts and mapview.ts, about 15.5 KB). */
  module: 20_000,
  /**
   * All browser modules together, raw (94 KB before decision 0062; 32 KB gzip, fetched once, then
   * cached as immutable). Decision 0062 raised it from 120 000: the map screen (paint, tiles, view,
   * sheet, actions) replaces the 14.5 KB map card with about 80 KB; 160 KB in all. Decision 0065 raised it
   * from 170 000: the storage view, the Bring picker, their action table and the view switch (storage.ts,
   * bring.ts, storedefs.ts, views.ts) add about 19.6 KB raw (7.1 KB gzip); 184 KB in all (docs/panel.md "Budgets").
   */
  modules: 200_000,
  /** A state snapshot on the stream (= the lite poll; worst case 19.5 KB). */
  snapshot: 24_000,
  /** A state delta on a busy second (a few cells, a log line, chat, the clock, uptime; about 700 bytes). */
  delta: 4_000,
  /** One message on the events topic (an event with its text; typically 200 to 400 bytes). */
  event: 2_000,
  /**
   * Decision 0062: one `map` topic message. A walk across a chunk border loads a row of 21 tiles: about
   * 1.4 KB each on generated terrain, 3.6 KB each in the synthetic worst case (random heights over the
   * whole range, 60 names, liquid everywhere, the under-roof layer: 75 KB for the row).
   */
  mapMessage: 96_000,
  /** Decision 0062: a `map-live` snapshot (300 trail points, 64 entities, a path, waypoints). */
  mapLive: 24_000,
  /** Decision 0062: a `map-live` delta on a busy second (the bot, a trail point, moving entities). */
  mapLiveDelta: 4_000,
  /** Decision 0062: GET /api/map/tiles for a radius 8 window (289 tiles), gzipped: the map screen's first load (39 KB on generated terrain; random worst-case art does not compress and is only measured). */
  mapFetch: 120_000,
  /** Decision 0065: a `storage` topic snapshot (counts, 7 categories with their top 4, the 5 fullest containers, 8 recent changes; 2.8 KB worst case). */
  storage: 8_000,
  /** Decision 0065: a `storage` delta after a deposit (a few totals, a category's top, one recent change; 1.8 KB worst case). */
  storageDelta: 3_000,
  /** Decision 0065: one GET /api/storage/search answer (12 items, 8 places each, 5 recent changes each; 23 KB on the 512-container worst case). */
  storageSearch: 32_000,
  /** Decision 0065: GET /api/storage with 512 containers in the memory (every container by fullness; 120 KB worst case). */
  storageFetch: 160_000,
} as const;
