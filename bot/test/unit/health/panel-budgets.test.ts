// Decision 0061: the panel's byte budgets per piece (health/panel/budgets.ts, docs/panel.md "Budgets"),
// on the worst-case fixture (a full inventory with a 27-kind shulker box, a 50-line log, 30 chat lines,
// three processes): the page HTML, each browser module and all of them (raw and gzip), a state
// snapshot, a delta on a busy second, and a delta when much changes at once. A piece over its budget
// fails here first; raise the number in budgets.ts only with the reason in docs/panel.md "Measured".
import { describe, expect, it } from 'vitest';
import type { ItemStack } from '../../../src/world/types.ts';
import { loadClientModules } from '../../../src/health/panel/assets.ts';
import { PANEL_BUDGETS } from '../../../src/health/panel/budgets.ts';
import { diffJson, type Json } from '../../../src/health/panel/client/delta.ts';
import { renderPanelPage } from '../../../src/health/panel/page.ts';
import { liteState } from '../../../src/health/panel/state.ts';
import { fullInventory, fullSource, fullState, stack } from './panel-fixtures.ts';
import { gzipSync } from 'node:zlib';
import { GlobalPalette, packTile, type MapLiveJson } from '../../../src/health/map/data.ts';
import type { MapTile } from '../../../src/world/cache/cache.ts';
import { NO_NAME, type SurfaceData, type SurfaceLayer } from '../../../src/world/cache/surface.ts';

const lite = (s: ReturnType<typeof fullState>): Json => JSON.parse(JSON.stringify(liteState(s))) as Json;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
/** PANEL_MEASURE=1 prints every number (the 'Measured' table in docs/panel.md). */
const show = (what: string, n: number, budget: number): void => {
  if (process.env.PANEL_MEASURE) process.stdout.write(`panel budget: ${what} ${n} bytes (budget ${budget})\n`);
};
const LOG = (i: number): string => `2026-10-29T18:53:${String(i % 60).padStart(2, '0')}.456Z INFO  [move] goto 100 64 -50: arrived after 41 ticks, 12.3 blocks, 0 corrections (plan ${i})`;

describe('panel budgets (decision 0061)', () => {
  it('the page HTML, with the embedded worst-case state', () => {
    const html = Buffer.byteLength(renderPanelPage(fullState()));
    show('html', html, PANEL_BUDGETS.html);
    expect(html).toBeLessThan(PANEL_BUDGETS.html);
  });

  it('each browser module, and all of them (raw; gzip is what a browser fetches)', () => {
    const mods = loadClientModules();
    for (const m of mods) show(`module ${m.path} (gzip ${m.gz.length})`, m.body.length, PANEL_BUDGETS.module);
    for (const m of mods) expect(m.body.length, m.path).toBeLessThan(PANEL_BUDGETS.module);
    const raw = mods.reduce((n, m) => n + m.body.length, 0);
    const gz = mods.reduce((n, m) => n + m.gz.length, 0);
    show(`modules ${mods.length} (gzip ${gz})`, raw, PANEL_BUDGETS.modules);
    expect(raw).toBeLessThan(PANEL_BUDGETS.modules);
    expect(gz).toBeLessThan(raw / 2);
  });

  it('a state snapshot (the stream on connect, and the lite poll)', () => {
    show('snapshot', bytes({ snap: lite(fullState()) }), PANEL_BUDGETS.snapshot);
    expect(bytes({ snap: lite(fullState()) })).toBeLessThan(PANEL_BUDGETS.snapshot);
  });

  it('a delta on a busy second: the clock, vitals, position, two cells, a log line, a chat line, the stack', () => {
    const base = fullSource();
    const before = lite(fullState());
    const inv = fullInventory();
    (inv.slots as (ItemStack | null)[])[4] = stack('bread', 11);
    (inv.slots as (ItemStack | null)[])[9] = stack('cobblestone', 63, { blockRuntimeId: 5 });
    const after = lite(
      fullState({
        inventory: () => inv,
        timeOfDay: () => 6020,
        vitals: () => ({ health: 16.5, food: 18 }),
        position: () => ({ x: 18312.1, y: -60, z: 17027.9 }),
        logs: () => [...base.logs().slice(1), LOG(50)],
        chat: () => [...base.chat().slice(1), { ts: 1761753630000, text: 'arrived at 100 64 -50', sent: false }],
        stack: () => (base.stack?.() ?? []).map((p, i) => (i === 0 ? { ...p, line: 'getting 32 oak_log: 13/32 (fell 3 trees)', etaS: 90 } : p)),
        conn: () => {
          const c = base.conn?.();
          return c && { ...c, uptimeS: 7381, sessionS: 7301 };
        },
      }),
    );
    const ops = diffJson(before, after);
    expect(ops.length).toBeGreaterThan(5);
    show(`busy delta (${ops.length} ops)`, bytes({ d: ops }), PANEL_BUDGETS.delta);
    expect(bytes({ d: ops })).toBeLessThan(PANEL_BUDGETS.delta);
  });

  it('a delta when much changes at once (five log lines, the whole inventory moved) stays under the snapshot', () => {
    const base = fullSource();
    const before = lite(fullState());
    const inv = fullInventory();
    (inv.slots as (ItemStack | null)[]).reverse();
    const after = lite(fullState({ inventory: () => inv, logs: () => [...base.logs().slice(5), ...[50, 51, 52, 53, 54].map(LOG)] }));
    const d = bytes({ d: diffJson(before, after) });
    show('big delta', d, PANEL_BUDGETS.snapshot);
    expect(d).toBeLessThan(PANEL_BUDGETS.snapshot); // the hub sends a snapshot instead when a delta is longer
  });
});

// ---- decision 0062: the map screen's pieces, on synthetic worst cases --------------------------------

/** A deterministic pseudo-random sequence (the same worst case on every run). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A worst-case tile: heights over the whole -64..200 range (no compact heights), a surface below the
 * height in every column (no compact `sd`), 60 names, liquid in half the columns, and the under-roof
 * layer; `mild` = a generated-looking overworld tile (smooth hills, grass with patches of sand and
 * stone, water below y 62).
 */
function mapTile(cx: number, cz: number, r: () => number, mild = false): MapTile {
  const y = new Int16Array(256);
  const cls = new Uint8Array(256);
  const layer = (): SurfaceLayer => ({ idx: new Uint8Array(256), y: new Int16Array(256), floor: new Uint8Array(256).fill(NO_NAME), depth: new Uint8Array(256) });
  const top = layer();
  const under = layer();
  const n = mild ? 12 : 60;
  for (let i = 0; i < 256; i++) {
    if (mild) {
      const x = cx * 16 + (i & 15);
      const z = cz * 16 + (i >> 4);
      const h = Math.round(64 + 7 * Math.sin(x / 11) + 5 * Math.cos(z / 9));
      const wet = h < 62;
      y[i] = wet ? 62 : h;
      cls[i] = wet ? 2 : 1;
      top.idx[i] = wet ? 1 : Math.sin(x / 5 + z / 7) > 0.9 ? 2 : h > 70 ? 3 : 0;
      top.y[i] = y[i]!;
      if (wet) {
        top.floor[i] = 4;
        top.depth[i] = 62 - h;
      }
      continue;
    }
    y[i] = -64 + Math.floor(r() * 264);
    cls[i] = 1 + Math.floor(r() * 3);
    top.idx[i] = Math.floor(r() * n);
    top.y[i] = y[i]! - 1 - Math.floor(r() * 120);
    if (r() < 0.5) {
      top.floor[i] = Math.floor(r() * n);
      top.depth[i] = 1 + Math.floor(r() * 30);
    }
    under.idx[i] = Math.floor(r() * n);
    under.y[i] = 30 + Math.floor(r() * 60);
  }
  const names = Array.from({ length: n }, (_, k) => `block_name_${k}`);
  return { cx, cz, live: true, rev: 1, updatedAt: Date.now(), y, cls, surf: { names, top, under: mild ? undefined : under } as unknown as SurfaceData };
}

describe('map screen budgets (decision 0062)', () => {
  it('a map topic message: a walk across a chunk border loads a row of 21 worst-case tiles, with their palette', () => {
    const r = rng(62);
    const pal = new GlobalPalette(null);
    const tiles = Array.from({ length: 21 }, (_, i) => packTile(mapTile(i, 0, r), pal, true));
    const m = { from: 1, rev: 2, dim: 0, tiles, palFrom: 0, palette: pal.entriesFrom(0) };
    show('map message (21 worst-case tiles)', bytes(m), PANEL_BUDGETS.mapMessage);
    expect(bytes(m)).toBeLessThan(PANEL_BUDGETS.mapMessage);
  });

  it('the first tiles fetch, radius 8 (289 tiles), gzipped: worst case and a realistic overworld', () => {
    for (const mild of [false, true]) {
      const r = rng(8);
      const pal = new GlobalPalette(null);
      const tiles = [];
      for (let cx = -8; cx <= 8; cx++) for (let cz = -8; cz <= 8; cz++) tiles.push(packTile(mapTile(cx, cz, r, mild), pal, true));
      const body = JSON.stringify({ ts: 0, dim: 0, rev: 1, center: { cx: 0, cz: 0 }, radius: 8, window: { cx0: -8, cz0: -8, cx1: 8, cz1: 8 }, tiles, palFrom: 0, palette: pal.entriesFrom(0) });
      const gz = gzipSync(body).length;
      show(`tiles fetch r=8 ${mild ? 'overworld' : 'worst case'} (raw ${body.length})`, gz, PANEL_BUDGETS.mapFetch);
      if (mild) expect(gz).toBeLessThan(PANEL_BUDGETS.mapFetch); // random worst-case art does not compress: measured only
    }
  });

  it('a map-live snapshot (300 trail points, 64 named entities, a 200-step path, 40 waypoints) and a busy delta', () => {
    const snap: MapLiveJson = {
      dim: 0,
      bot: [100.5, 64, -49.5, 135.2],
      trail: Array.from({ length: 300 }, (_, i): [number, number] => [100.5 + i * 0.7, -49.5 - i * 0.3]),
      path: Array.from({ length: 200 }, (_, i): [number, number, number] => [100 + i, 64, -50 - (i >> 1)]),
      goal: [300, 64, -150],
      busy: true,
      result: 'running',
      ents: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [String(1000 + i), ['hostile', 'skeleton_horse', 100.5 + i, 64, -50.5 - i, `a_long_name_${i}`]])),
      home: [100, 64, -50],
      shelter: [110, 64, -40],
      wps: Array.from({ length: 40 }, (_, i): [string, number, number, number] => [`waypoint_name_${i}`, 100 + i * 10, 64, -50 - i * 10]),
    };
    show('map-live snapshot', bytes({ snap }), PANEL_BUDGETS.mapLive);
    expect(bytes({ snap })).toBeLessThan(PANEL_BUDGETS.mapLive);
    const next = JSON.parse(JSON.stringify(snap)) as MapLiveJson;
    next.bot = [101.2, 64, -50.1, 140];
    next.trail = [...next.trail.slice(1), [101.2, -50.1]];
    for (const [k, e] of Object.entries(next.ents).slice(0, 20)) next.ents[k] = [e[0]!, e[1]!, Number(e[2]) + 0.4, e[3]!, Number(e[4]) - 0.3, e[5]!];
    const d = bytes({ d: diffJson(snap as unknown as Json, next as unknown as Json) });
    show('map-live busy delta (bot, trail, 20 entities)', d, PANEL_BUDGETS.mapLiveDelta);
    expect(d).toBeLessThan(PANEL_BUDGETS.mapLiveDelta);
  });
});
