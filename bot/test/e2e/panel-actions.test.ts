// Track AR on bds-core (docs/panel.md "Interaction", decision 0039): the control panel's menus drive a
// real bot. Every action below is what the page's menu model (health/panel/menu.ts, the same JavaScript
// the page runs) offers for the cell / column / row, sent through POST /api/cmd exactly as the page does:
//   1. a cell's Select makes that hotbar slot the held one (the state's `selected`, `!inv`);
//   2. a cell's Drop the stack drops it (truth inventory; the item entity when the pack has truth:items);
//   3. To the offhand moves a totem and a shield into the offhand (the state's `offhand`), Back into the
//      inventory empties it;
//   4. the map's Walk here (from /map.json's surface y of the column 6 blocks east) walks the bot there;
//   5. the map's Set waypoint here creates the waypoint (`!wp <name>`);
//   6. a setting's Reset returns it to its default;
//   7. the Stop button of a running `!goto` ends it (the stack empties, the bot stops short);
//   plus the page markers and sizes.
// Env: PANEL_ACTIONS_E2E_PORT (default a random port in 9650..9659) plus core-truth.ts (CORE_BDS_*).
// Needs BDS_E2E=1 and bds-core with the truth pack (`node scripts/bds.mjs --profile core up` and `... pack`).
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapJson } from '../../src/health/map/schema.ts';
import { PANEL_BUDGETS } from '../../src/health/panel/budgets.ts';
import { pointActions } from '../../src/health/panel/client/mapdefs.ts';
import { cellActions, settingActions, stackActions, type MenuAction } from '../../src/health/panel/menu.ts';
import { centre, clearArea, CORE_CONTAINER, CORE_TARGET, E2E, FEET_Y, hdist, prepareServer, privateArea, sleep, until, waitOnline, type CoreCli } from './core-truth.ts';
import { connectObserver, panelClient, panelPort, quitPanelCli, startPanelCli, type Observer, type PanelCli } from './panel-e2e.ts';
import type { PveTruth } from './pve-truth.ts';

const panel = panelClient(panelPort(process.env.PANEL_ACTIONS_E2E_PORT, 9650));
const { port: PORT, base: BASE, auth: AUTH } = panel;
const state = () => panel.state();
const cmd = (text: string) => panel.cmd(text);

/** The action `id` of a menu (fails the test when the menu does not offer it). */
function action(menu: MenuAction[], id: string): MenuAction {
  const a = menu.find((x) => x.id === id);
  expect(a, `menu offers ${id}: ${JSON.stringify(menu.map((x) => x.id))}`).toBeDefined();
  return a!;
}

/** The map screen's block actions for column (x, z) with surface y `sy` (decision 0062: mapdefs.ts, what the sheet offers). */
const mapActions = (x: number, z: number, sy: number | null, botY: number | null): MenuAction[] =>
  pointActions({ x: Math.floor(x), z: Math.floor(z), y: sy, block: null, bot: botY === null ? null : { x, y: botY, z }, elytra: false });

/** A reply that may come after the POST returned (async commands reply later): the panel chat. */
async function replyLike(re: RegExp, sinceTs: number, timeoutMs = 10_000): Promise<string> {
  return until(async () => (await state()).chat.find((c) => c.ts >= sinceTs && re.test(c.text))?.text, timeoutMs, `a reply like ${re}`, 200);
}

/** Surface y of column (x, z) from /map.json (int16 little endian, index z * 16 + x; -32768 = nothing), or null. */
function surfaceY(m: MapJson, x: number, z: number): number | null {
  const t = m.tiles.find((q) => q.cx === x >> 4 && q.cz === z >> 4);
  if (!t) return null;
  const ys = new Int16Array(new Uint8Array(Buffer.from(t.y, 'base64')).buffer);
  const y = ys[((z & 15) << 4) | (x & 15)]!;
  return y === -32768 ? null : y;
}

describe.skipIf(!E2E)('core: control panel actions (Track AR)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  let observer: Observer | undefined;
  let truth: PveTruth | undefined;
  let cli: CoreCli | undefined;
  let run: PanelCli | undefined;
  const inv = async (): Promise<Record<string, number>> => (await truth!.ok<{ counts: Record<string, number> }>('inv', [cli!.name])).counts;

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    observer = await connectObserver(`PanelAct${randomInt(1000, 9999)}`, CORE_TARGET, CORE_CONTAINER);
    truth = observer.truth;
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: FEET_Y, z: HOME.z - 24 + 0.5 }, 0, 0);
    await clearArea(truth, HOME, 14, 4);
    // panel-e2e.ts: the waypoints go to <tmp>/waypoints/, the map's tiles and markers to <tmp>, never the user's
    run = startPanelCli(panel, { prefix: 'bot-e2e-panel-act-cache-', args: ['--walk'] });
    cli = run.cli;
    await waitOnline(truth, cli.name);
    await truth.tp(cli.name, centre(HOME), 0, 0);
    await panel.healthy();
    await truth.ok('clear', [cli.name]);
    await truth.ok('give', [cli.name, 'iron_sword', 1]);
    await truth.ok('give', [cli.name, 'cobblestone', 128]);
    await truth.ok('give', [cli.name, 'totem_of_undying', 1]);
    await until(async () => {
      const s = (await state()).inventory;
      return s?.slots.filter((x) => x?.name === 'cobblestone').length === 2 && s.slots.some((x) => x?.name === 'totem_of_undying') ? true : undefined;
    }, 15_000, 'the loadout in the panel state', 250);
  }, 90_000);

  afterAll(async () => {
    await quitPanelCli(panel, cli);
    await truth?.cleanup().catch(() => undefined);
    await truth?.clearAround(centre(HOME), 40).catch(() => undefined);
    await observer?.close();
    run?.cleanup();
    console.log(`panel actions e2e (port ${PORT}, area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('the page has the menu, the palette, the map canvas and the grouped settings; sizes', async () => {
    const html = await fetch(`${BASE}/`, { headers: AUTH }).then((r) => r.text());
    for (const m of ['id="menu"', 'id="toast"', 'id="palette"', 'id="mapcv"', 'id="modes-data"', 'data-grp="safety"', 'data-reset="guardRadius"', 'id="btn-pause"', 'id="log-level"']) expect(html).toContain(m);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1[:/])/);
    expect(Buffer.byteLength(html)).toBeLessThan(PANEL_BUDGETS.html); // decision 0061
    const lite = await fetch(`${BASE}/api/state?lite=1`, { headers: AUTH }).then((r) => r.text());
    expect(lite.length).toBeLessThan(24_000);
    const marks = (await fetch(`${BASE}/api/marks`, { headers: AUTH }).then((r) => r.json())) as { chests: unknown[]; herds: unknown[] };
    expect(marks).toMatchObject({ chests: expect.any(Array) as unknown[], herds: expect.any(Array) as unknown[] }); // decision 0062: plus `blocks` (spawners, beds, ...) when the bot has a cache
    measurements.push(`page ${html.length} bytes, ?lite=1 ${lite.length} bytes, /api/marks ${JSON.stringify(marks).length} bytes`);
  });

  it('a cell\'s Select makes that hotbar slot the held one', async () => {
    const s = await state();
    const inv0 = s.inventory!;
    const slot = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((i) => i !== inv0.selected && inv0.slots[i] !== null) ?? (inv0.selected === 8 ? 7 : 8);
    const a = action(cellActions(`s${slot}`, inv0.slots[slot] ?? null, inv0), 'select');
    expect(a.cmd).toBe(`!select ${slot}`);
    const t0 = Date.now();
    const r = await cmd(a.cmd!);
    expect(r.body.replies[0]).toMatch(new RegExp(`^selected hotbar slot ${slot}: `));
    const after = await until(async () => ((await state()).inventory!.selected === slot ? true : undefined), 5_000, `selected = ${slot}`, 100);
    expect(after).toBe(true);
    expect((await cmd('!inv')).body.replies[0]).toMatch(new RegExp(`held ${slot} `));
    measurements.push(`Select: ${inv0.selected} -> ${slot} ("${r.body.replies[0]}", POST ${r.ms.toFixed(1)} ms, in the state after ${Date.now() - t0} ms)`);
  });

  it('a cell\'s Drop the stack drops it (truth inventory and the item entity)', async () => {
    const s = await state();
    const inv0 = s.inventory!;
    const slot = inv0.slots.findIndex((x) => x?.name === 'cobblestone');
    const menu = cellActions(`s${slot}`, inv0.slots[slot]!, inv0);
    expect(menu.map((x) => x.id)).toEqual(expect.arrayContaining(['drop1', 'dropstack', 'dropall']));
    const a = action(menu, 'dropstack');
    expect(a).toMatchObject({ cmd: `!drop slot ${slot}`, confirm: true }); // this slot only (since !drop slot)
    const before = (await inv())['minecraft:cobblestone'];
    expect(before).toBe(128);
    const t0 = Date.now();
    const at = await truth!.pos(cli!.name);
    await cmd(a.cmd!);
    const reply = await replyLike(/^dropped \d+ cobblestone|^drop /, t0 - 1000);
    expect(reply).toBe('dropped 64 cobblestone');
    const left = await until(async () => {
      const c = (await inv())['minecraft:cobblestone'];
      return c === 64 ? c : undefined;
    }, 5_000, 'cobblestone 64 left in the truth inventory', 100);
    const dropMs = Date.now() - t0;
    let entity: string;
    try {
      const items = await until(async () => {
        const x = await truth!.ok<{ items: { amount: number }[] }>('items', [at.location.x, at.location.y, at.location.z, 8, 'cobblestone']);
        return x.items.length ? x.items : undefined;
      }, 5_000, 'cobblestone item entity', 200);
      entity = `item entity ${items.reduce((n, i) => n + i.amount, 0)}`;
    } catch (e) {
      entity = `truth:items: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`;
    }
    measurements.push(`Drop the stack: "${reply}", truth cobblestone ${before} -> ${left} after ${dropMs} ms; ${entity}`);
    await truth!.clearAround(centre(HOME), 16).catch(() => undefined); // the dropped stack must not come back
  });

  it('To the offhand: a totem, then a shield (the state\'s offhand); Back into the inventory', async () => {
    let s = await state();
    const tslot = s.inventory!.slots.findIndex((x) => x?.name === 'totem_of_undying');
    const toOff = action(cellActions(`s${tslot}`, s.inventory!.slots[tslot]!, s.inventory), 'offhand');
    expect(toOff.cmd).toBe('!offhand totem_of_undying');
    const t0 = Date.now();
    await cmd(toOff.cmd!);
    const r1 = await replyLike(/^offhand/, t0 - 1000);
    expect(r1).toBe('offhand: totem_of_undying');
    s = await until(async () => {
      const st = await state();
      return st.inventory?.offhand?.name === 'totem_of_undying' && !st.inventory.slots.some((x) => x?.name === 'totem_of_undying') ? st : undefined;
    }, 5_000, 'the totem in the offhand', 100);
    const totemMs = Date.now() - t0;
    // Back into the inventory (the offhand cell's menu)
    const back = action(cellActions('off', s.inventory!.offhand, s.inventory), 'offclear');
    const t1 = Date.now();
    await cmd(back.cmd!);
    expect(await replyLike(/^offhand( clear)?: .*(back|refused|empty|slot)/, t1)).toBe('offhand: totem_of_undying moved back into the inventory');
    await until(async () => {
      const st = await state();
      return st.inventory?.offhand === null && st.inventory.slots.some((x) => x?.name === 'totem_of_undying') ? st : undefined;
    }, 5_000, 'the offhand empty, the totem back', 100);
    expect((await inv())['minecraft:totem_of_undying']).toBe(1);
    // a shield (the shield controller may move it first when the bot is idle: both end with the shield in the offhand)
    await truth!.ok('give', [cli!.name, 'shield', 1]);
    s = await until(async () => {
      const st = await state();
      return st.inventory?.slots.some((x) => x?.name === 'shield') || st.inventory?.offhand?.name === 'shield' ? st : undefined;
    }, 5_000, 'the shield arrives', 100);
    const sslot = s.inventory!.slots.findIndex((x) => x?.name === 'shield');
    let how = 'already there (shield controller)';
    if (sslot >= 0) {
      const sh = action(cellActions(`s${sslot}`, s.inventory!.slots[sslot]!, s.inventory), 'offhand');
      const t2 = Date.now();
      await cmd(sh.cmd!);
      how = await replyLike(/^offhand( shield)?: .*shield|^offhand shield: /, t2);
      expect(how).toMatch(/^offhand: (already holds )?shield$/);
    }
    await until(async () => ((await state()).inventory?.offhand?.name === 'shield' ? true : undefined), 5_000, 'the shield in the offhand', 100);
    measurements.push(`Offhand: totem in after ${totemMs} ms ("${r1}"), back out; shield: "${how}"`);
  });

  it('the map\'s Walk here walks the bot 6 blocks east (the column\'s surface from /map.json)', async () => {
    await truth!.tp(cli!.name, centre(HOME), 0, 0);
    await sleep(500);
    const start = (await truth!.pos(cli!.name)).location;
    const target = { x: Math.floor(start.x) + 6, z: Math.floor(start.z) };
    const m = await until(async () => {
      const j = (await fetch(`${BASE}/map.json?r=2`, { headers: AUTH }).then((r) => r.json())) as MapJson;
      return surfaceY(j, target.x, target.z) !== null ? j : undefined;
    }, 10_000, 'the target column in /map.json', 250);
    const sy = surfaceY(m, target.x, target.z);
    const menu = mapActions(target.x + 0.4, target.z + 0.6, sy, m.bot?.y ?? null);
    const walk = action(menu, 'walk');
    expect(walk.cmd).toBe(`!goto ${target.x} ${sy! + 1} ${target.z}`);
    const t0 = Date.now();
    const r = await cmd(walk.cmd!);
    expect(r.body.replies[0]).toBe(`walking to ${target.x} ${sy! + 1} ${target.z}`);
    const arrived = await until(async () => {
      const p = (await truth!.pos(cli!.name)).location;
      return hdist(p, { x: target.x + 0.5, z: target.z + 0.5 }) < 1 ? p : undefined;
    }, 30_000, 'the bot at the clicked column', 200);
    expect(hdist(arrived, start)).toBeGreaterThan(5);
    measurements.push(`Walk here: surface y ${sy} -> "${walk.cmd}", moved ${hdist(arrived, start).toFixed(2)} blocks in ${Date.now() - t0} ms`);
  }, 60_000);

  it('the map\'s Set waypoint here creates it', async () => {
    const p = (await truth!.pos(cli!.name)).location;
    const x = Math.floor(p.x) - 3;
    const z = Math.floor(p.z) + 2;
    const m = (await fetch(`${BASE}/map.json?r=2`, { headers: AUTH }).then((r) => r.json())) as MapJson;
    const sy = surfaceY(m, x, z);
    const wp = action(mapActions(x, z, sy, m.bot?.y ?? null), 'wp');
    expect(wp.prompt).toBeDefined();
    const name = `panelmap${randomInt(100, 999)}`;
    const text = wp.cmd!.replace('{name}', name);
    const r = await cmd(text);
    const fy = sy === null ? Math.floor(m.bot!.y) : sy + 1;
    expect(r.body.replies[0]).toBe(`waypoint ${name} set to ${x} ${fy} ${z}`);
    const show = await cmd(`!wp ${name}`);
    expect(show.body.replies[0]).toMatch(new RegExp(`^waypoint ${name}: ${x} ${fy} ${z}`));
    const j = (await fetch(`${BASE}/map.json?r=2`, { headers: AUTH }).then((q) => q.json())) as MapJson;
    expect(j.waypoints.some((w) => w.name === name)).toBe(true); // drawn on the map from the next poll
    measurements.push(`Set waypoint here: "${text}" -> "${r.body.replies[0]}"; on the map: ${JSON.stringify(j.waypoints.find((w) => w.name === name))}`);
  });

  it('a setting\'s Reset returns it to its default', async () => {
    expect((await cmd('!set guardRadius 20')).status).toBe(200);
    const row = (await state()).settings.find((x) => x.key === 'guardRadius')!;
    expect(row).toMatchObject({ value: '20', source: 'chat' });
    const reset = settingActions(row.key, row.value, row.default);
    expect(reset).toEqual([{ id: 'reset', label: `Reset to ${row.default}`, cmd: '!set guardRadius default' }]);
    const r = await cmd(reset[0]!.cmd!);
    const after = (await state()).settings.find((x) => x.key === 'guardRadius')!;
    expect(after.value).toBe(row.default);
    expect(settingActions(after.key, after.value, after.default)).toEqual([]); // the Reset button hides
    measurements.push(`Reset: guardRadius 20 -> "${r.body.replies[0]}" (now ${after.value}, source ${after.source})`);
  });

  it('the Stop button of a running !goto ends it', async () => {
    const start = (await truth!.pos(cli!.name)).location;
    const far = { x: Math.floor(start.x) + 30, y: FEET_Y, z: Math.floor(start.z) };
    const go = await cmd(`!goto ${far.x} ${far.y} ${far.z}`);
    expect(go.body.replies[0]).toBe(`walking to ${far.x} ${far.y} ${far.z}`);
    const s = await until(async () => {
      const st = await state();
      return st.stack.some((e) => e.kind === 'user') ? st : undefined;
    }, 5_000, 'the goto in the stack', 100);
    await sleep(800);
    const entry = s.stack.find((e) => e.kind === 'user')!;
    const stop = action(stackActions(entry), 'stop');
    const t0 = Date.now();
    const r = await cmd(stop.cmd!);
    expect(r.body.replies[0]).toMatch(/^stopped \(was /);
    await until(async () => ((await state()).stack.some((e) => e.kind === 'user') ? undefined : true), 5_000, 'no user process', 100);
    const stopMs = Date.now() - t0;
    const p1 = (await truth!.pos(cli!.name)).location;
    await sleep(1500);
    const p2 = (await truth!.pos(cli!.name)).location;
    expect(hdist(p2, p1)).toBeLessThan(1); // standing
    expect(hdist(p2, { x: far.x + 0.5, z: far.z + 0.5 })).toBeGreaterThan(5); // short of the goal
    measurements.push(`Stop: "${entry.name}: ${entry.line}" -> "${r.body.replies[0]}", stack empty after ${stopMs} ms, walked ${hdist(p2, start).toFixed(2)} of 30 blocks`);
  }, 30_000);
});
