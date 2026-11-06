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
