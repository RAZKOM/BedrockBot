// The panel's byte budgets (docs/panel.md "Budgets", decision 0061): one per piece instead of one cap
// on the whole page, so a new card raises the piece it lives in, not a global number. Enforced in
// three places: the unit tests (worst-case fixture; panel-budgets.test.ts), the e2e on bds-core
// (panel-stream.test.ts measures the real thing), and at run time (assets.ts refuses a module over
// its budget at startup; stream.ts logs once when a snapshot or delta goes over). Measured values
// (worst-case fixture, `PANEL_MEASURE=1 npx vitest run --project unit test/unit/health/panel-budgets.test.ts`)
// are in docs/panel.md "Measured"; raise a number only with the reason written there.
export const PANEL_BUDGETS = {
  /** GET / : the server-rendered structure, the CSS, the glyphs and the embedded lite state (worst case 108 KB). */
  html: 120_000,
  /** One browser module after type stripping (client/*.ts, shared.ts; the largest, map.ts, 14.5 KB). */
  module: 20_000,
  /** All browser modules together, raw (94 KB; 32 KB gzip, fetched once, then cached as immutable). */
  modules: 120_000,
  /** A state snapshot on the stream (= the lite poll; worst case 19.5 KB). */
  snapshot: 24_000,
  /** A state delta on a busy second (a few cells, a log line, chat, the clock, uptime; about 700 bytes). */
  delta: 4_000,
  /** One message on the events topic (an event with its text; typically 200 to 400 bytes). */
  event: 2_000,
} as const;
