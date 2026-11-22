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
   * and their CSS add about 5 KB; 121.6 KB in all (docs/panel.md "Budgets"). Track F9c raised it from 128 000: the
   * settings rows added since (each a few hundred bytes, in the markup and in the embedded state) had taken the worst
   * case to within one row of it, and the `flyLearnedEntry` row took it to 128 663. Track M1 raised it from 130 000:
   * the mob group's four rows (mobReflex, fleeFly, sealIn, mobDodge) add 2.4 KB; 131 066 in all. Track F11 raised it
   * from 134 000: the rows since had taken it to 133 866, and the `flyLandOver` row (777 bytes) took it to 134 643.
   * Track M3 raised it from 136 000: the rows since had taken it to 135 390, and the `flyLandMobs` row with the longer
   * `fleeFly` description (866 bytes) took it to 136 256. Track F17 raised it from 137 000: the rows since had taken it
   * to 136 990, and the `flyCaveWindows` row (709 bytes) took it to 137 699. Track K1 raised it from 138 500: the
   * `milkKeep`, `autoMilk` and `milkCraft` rows and the milk vitals row (1 829 bytes) took it to 139 528. Track R9 raised it
   * from 140 000: the `fireworksKeep` and `autoRockets` rows and the rockets vitals row (1 467 bytes) took it to 140 995.
   * Track K3 raised it from 141 500: the `milkRange` row (710 bytes) took it to 141 705.
   * Track E1's `nightShell` row (617 bytes) took it to 142 263. Track E2 raised it from 142 500: the `cookFurnace` row
   * (633 bytes) took it to 142 896. Track E3 raised it from 143 500: the `smeltShell` row (615 bytes) took it to 143 511.
   * Track E4 raised it from 144 000: the `deathReturn` row (596 bytes) took it to 144 107.
   * Track K4 raised it from 145 000: the rows since had taken it to 144 727, and the `elytraSpare` and `autoElytra` rows and
   * the elytra vitals row (1 351 bytes) took it to 146 078.
   * Track E7's `jobDusk` and `shellBlocks` rows (1 263 bytes) took it to 147 341: raised from 146 500.
   * Track K5's `mendOnTheWay` row (630 bytes) took it to 147 971: raised from 147 500.
   * Track E9's `jobMorning` row with its description took it to 148 685, over the 148 500 it had: raised to 149 000.
   * Track P4: the Jobs view's markup and CSS, its header and map buttons and the Queue buttons of the map's sheet, storage
   * and Bring (3 171 bytes) took it from 148 037 to 151 208 on its base: with E9's row 151 922 on the merged tree: raised
   * to 152 500.
   * Track K6's `mendPost` and `autoMend` rows took it to 149 260 on its base (from 148 500) and to 153 211 on the merged
   * tree (after E9 and P4): raised to 154 000.
   * Track P5: the Away view's markup and banner (1 842 bytes), its CSS (1 583), the Away buttons of the header, the map,
   * storage and jobs (699) and the `notify`, `askOwner` and `askWaitS` rows (1 678, and their values in the embedded state)
   * took it from 153 211 to 159 144: raised to 160 000.
   * Track E11's `morningWay` row (to 159 771) and Track N1's `notifyDiscord` row took it to 160 487: raised to 161 000.
   * Track D1's `discordBot`, `discordUsers`, `discordChannels` and `discordNotes` rows (2 453 bytes) took it from 160 487 to
   * 162 940: raised to 163 500.
   * Track E12's `workGuard` and `creeperRise` rows (1 273 bytes) took it from 162 940 to 164 213: raised to 165 000.
   * Track D3's `discordText` row and the Away view's Discord section with its CSS (807 bytes) took it from 164 302 to
   * 165 109: raised to 166 000.
   * Track E13's `workArchers` row (692 bytes on its base) took it to 165 806 on the merged tree: raised to 167 000.
   */
  html: 167_000,
  /** One browser module after type stripping (client/*.ts, shared.ts; the largest, paint.ts and mapview.ts, about 15.5 KB). */
  module: 20_000,
  /**
   * All browser modules together, raw (94 KB before decision 0062; 32 KB gzip, fetched once, then
   * cached as immutable). Decision 0062 raised it from 120 000: the map screen (paint, tiles, view,
   * sheet, actions) replaces the 14.5 KB map card with about 80 KB; 160 KB in all. Decision 0065 raised it
   * from 170 000: the storage view, the Bring picker, their action table and the view switch (storage.ts,
   * bring.ts, storedefs.ts, views.ts) add about 19.6 KB raw (7.1 KB gzip); 184 KB in all (docs/panel.md "Budgets").
   * Track P5 raised it from 200 000: client/away.ts (13 959 raw, 4 609 gzip) and the notifications in boot.ts and dom.ts
   * took it from 195 255 to 214 277 (70 598 gzip): raised to 216 000.
   * Track D3: the Away view's Discord lines (client/away.ts 13 948 -> 16 272 raw) and their type and timer in shared.ts
   * (7 420 -> 7 930) took it from 214 611 to 217 445 (70 759 -> 71 430 gzip): raised to 218 500.
   */
  modules: 218_500,
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
  /** Track P4: a `jobs` topic snapshot (the running job, 32 waiting of 200 characters, 10 ended with 200-character end lines, 9 goals with long last lines; 20.2 KB worst case). */
  jobs: 24_000,
  /** Track P4: a `jobs` delta when a job ends or the next starts (the lists scroll: one op each; 480 bytes worst case). */
  jobsDelta: 2_000,
  /** Track P5: the `away` block's share of the lite state with 4 open questions of 6 choices and 3 notes, all at their length limits (4 738 bytes). */
  away: 8_000,
  /**
   * Track P5: one GET /api/timeline answer, worst case (48 job groups, each with 10 head lines of 160 characters, a 160-character
   * end line, 300 characters of facts and its folded counts: 149 313 bytes). Fetched only while the Away view shows, and again at
   * most every 3 s while the mark moves; never streamed. A real night's is a few KB.
   */
  timeline: 160_000,
} as const;
