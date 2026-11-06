// Track AE on bds-core (docs/panel.md, decision 0026): the LAN control panel on a real bot process.
//   1. the CLI with --health-port (9640..9649) and a token (BEDROCKBOT_PANEL_TOKEN): GET /api/state
//      without the token is 401, with it the status and the process stack;
//   2. the page renders (markers, cookie flow from ?token=);
//   3. POST /api/cmd `!wp set panel` creates the waypoint (reply, then `!wp panel`), `!goto` from the
//      panel moves the bot (truth position), and the log tail shows the command lines;
//   4. Track AP: with iron armour, a sword, 20 cobblestone stacks and a shulker box holding items
//      (placed, filled, broken, picked up), `/api/state` carries them in `inventory` (counts, the
//      armour in its slots, durability, the box's contents), the page has the 41-cell grid and every
//      status block, and `!set` from the panel shows in the settings block;
//   5. `!panel` prints the loopback URL (no token in it).
// Env: PANEL_E2E_PORT (default a random port in 9640..9649) plus core-truth.ts (CORE_BDS_*).
// Needs BDS_E2E=1 and bds-core with the truth pack (`node scripts/bds.mjs --profile core up` and `... pack`).
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PANEL_BUDGETS } from '../../src/health/panel/budgets.ts';
import { STATUS_BLOCKS } from '../../src/health/panel/page.ts'; // Track AP
import type { PveTruth } from './pve-truth.ts';
import { centre, clearArea, coreCmd, CORE_CONTAINER, CORE_TARGET, E2E, FEET_Y, hdist, prepareServer, privateArea, sleep, until, waitOnline, type CoreCli } from './core-truth.ts';
import { connectObserver, panelClient, panelPort, startPanelCli, type Observer, type PanelCli } from './panel-e2e.ts';

const panel = panelClient(panelPort(process.env.PANEL_E2E_PORT, 9640));
const { port: PORT, token: TOKEN, base: BASE, auth: AUTH } = panel;
const state = () => panel.state();
const cmd = (text: string, raw = false) => panel.cmd(text, raw);

describe.skipIf(!E2E)('core: LAN control panel (Track AE)', () => {
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const measurements: string[] = [];
  let observer: Observer | undefined;
  let truth: PveTruth | undefined;
  let cli: CoreCli | undefined;
  let run: PanelCli | undefined;

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    observer = await connectObserver(`PanelObs${randomInt(1000, 9999)}`, CORE_TARGET, CORE_CONTAINER);
    truth = observer.truth;
    await truth.tp(observer.name, { x: HOME.x + 0.5, y: FEET_Y, z: HOME.z - 24 + 0.5 }, 0, 0);
    await clearArea(truth, HOME, 12, 4);
    // panel-e2e.ts: the token, a config file (`!wp set panel` writes <tmp>/waypoints/) and the world cache
    // (Track AP: the memory block) in a temporary directory, never under the user's config directory
    run = startPanelCli(panel, { prefix: 'bot-e2e-panel-cache-', args: ['--walk'] });
    cli = run.cli;
    await waitOnline(truth, cli.name);
    await truth.tp(cli.name, centre(HOME), 0, 0);
    await panel.healthy();
  }, 90_000);

  afterAll(async () => {
    cli?.kill(); // only if a test failed before !quit
    await truth?.cleanup().catch(() => undefined);
    await truth?.clearAround(centre(HOME), 32).catch(() => undefined);
    await observer?.close();
    run?.cleanup();
    console.log(`panel e2e (port ${PORT}, area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('GET /api/state: 401 without the token, the status and stack with it', async () => {
    expect((await fetch(`${BASE}/api/state`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/state`, { headers: { authorization: 'Bearer wrongwrongwrongwrongwrong' } })).status).toBe(401);
    expect((await fetch(`${BASE}/metrics`)).status).toBe(401);
    expect((await fetch(`${BASE}/healthz`)).status).toBe(200);
    const s = await state();
    expect(s.bot.name).toBe(cli!.name);
    expect(s.bot.state).toBe('spawned');
    expect(s.status[0]).toMatch(/^status: up /);
    expect(s.status.some((l) => l.startsWith('processes: '))).toBe(true);
    expect(Array.isArray(s.stack)).toBe(true);
    expect(s.self.dimension).toBe('overworld');
    expect(s.self.health).toBeGreaterThan(0);
    expect(s.self.timeOfDay).not.toBeNull();
    expect(s.settings.length).toBeGreaterThan(10);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await state();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const line = `/api/state: ${JSON.stringify(s).length} bytes, median ${times[10]!.toFixed(1)} ms, max ${times[19]!.toFixed(1)} ms over 20; stack ${JSON.stringify(s.stack.map((e) => `${e.state} ${e.name}`))}; status "${s.status.join(' | ').slice(0, 160)}"`;
    console.log(line);
    measurements.push(line);
    expect(times[10]).toBeLessThan(250);
  });

  it('the page renders (cookie from ?token=, markers, no token in the HTML)', async () => {
    const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(r.status).toBe(303);
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const page = await fetch(`${BASE}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    for (const m of ['<title>BedrockBot panel</title>', 'id="panel-status"', 'id="cmdform"', 'data-cmd="!home go"', 'data-key="guardRadius"', 'id="mapscreen"', cli!.name]) expect(html).toContain(m);
    expect(html).not.toContain(TOKEN);
    expect((await fetch(`${BASE}/map`, { headers: { cookie } })).status).toBe(200);
    measurements.push(`page: ${html.length} bytes`);
  });

  it('POST /api/cmd: !wp set panel, !goto moves the bot, the log tail shows the commands', async () => {
    const start = (await truth!.pos(cli!.name)).location;
    const t0 = Date.now();
    const wp = await cmd('!wp set panel');
    const wpMs = Date.now() - t0;
    expect(wp.status).toBe(200);
    expect(wp.body.replies).toHaveLength(1);
    expect(wp.body.replies[0]).toMatch(/^waypoint panel set to -?\d+ -?\d+ -?\d+$/);
    const show = await cmd('wp panel');
    expect(show.body.command).toBe('!wp panel');
    expect(show.body.replies[0]).toMatch(/^waypoint panel: /);
    expect((await state()).logs.some((l) => l.includes('panel: !wp set panel (as console)'))).toBe(true);

    const target = { x: HOME.x + 7, y: FEET_Y, z: HOME.z + 3 };
    const t1 = Date.now();
    const go = await cmd(`!goto ${target.x} ${target.y} ${target.z}`);
    expect(go.body.replies[0]).toBe(`walking to ${target.x} ${target.y} ${target.z}`);
    const during = await state();
    expect(during.logs.some((l) => l.includes(`panel: !goto ${target.x} ${target.y} ${target.z} (as console)`))).toBe(true);
    expect(during.stack.some((e) => e.kind === 'user' && e.line.includes('walking to'))).toBe(true);
    measurements.push(`stack while walking: ${JSON.stringify(during.stack)}`);
    const arrived = await until(async () => {
      const p = (await truth!.pos(cli!.name)).location;
      return hdist(p, centre(target)) < 1 ? p : undefined;
    }, 30_000, 'bot at the !goto target', 200);
    const gotoMs = Date.now() - t1;
    expect(hdist(arrived, start)).toBeGreaterThan(5);
    const s = await until(async () => {
      const st = await state();
      return st.chat.some((c) => c.text.startsWith('arrived at')) ? st : undefined;
    }, 10_000, 'arrived reply in the panel chat', 250);
    expect(s.chat.map((c) => c.text)).toEqual(expect.arrayContaining([wp.body.replies[0], `walking to ${target.x} ${target.y} ${target.z}`]));
    const back = await cmd('!goto panel');
    expect(back.body.replies[0]).toMatch(/^walking to panel \(/);
    await until(async () => (hdist((await truth!.pos(cli!.name)).location, start) < 1.5 ? true : undefined), 30_000, 'back at the waypoint', 200);
    const line = `!wp set panel answered in ${wpMs} ms ("${wp.body.replies[0]}"); !goto +7,+3 from the panel: arrived after ${gotoMs} ms, moved ${hdist(arrived, start).toFixed(2)} blocks; !goto panel walked back`;
    console.log(line);
    measurements.push(line);
  }, 90_000);

  it('Track AP: the inventory block (iron armour, a sword, 20 cobblestone stacks, a shulker box with contents), the page grid, !set in the settings', async () => {
    const name = cli!.name;
    await truth!.tp(name, centre(HOME), 0, 0);
    await truth!.ok('clear', [name]);
    // a shulker box holding 2 cobblestone stacks and 10 iron ingots: placed, filled, broken (it drops with its contents), picked up
    const boxAt = { x: HOME.x + 2, y: FEET_Y, z: HOME.z + 2 };
    await truth!.ok('set', [boxAt.x, boxAt.y, boxAt.z, 'undyed_shulker_box']);
    // vanilla replaceitem (the bds-core pack may predate truth:chestput)
    for (const [slot, item, n] of [[0, 'cobblestone', 64], [1, 'cobblestone', 64], [2, 'iron_ingot', 10]] as const) await coreCmd('replaceitem', 'block', String(boxAt.x), String(boxAt.y), String(boxAt.z), 'slot.container', String(slot), item, String(n));
    expect((await truth!.ok<{ counts: Record<string, number> }>('container', [boxAt.x, boxAt.y, boxAt.z])).counts).toEqual({ 'minecraft:cobblestone': 128, 'minecraft:iron_ingot': 10 });
    await coreCmd('setblock', String(boxAt.x), String(boxAt.y), String(boxAt.z), 'air', 'destroy');
    await truth!.tp(name, centre(boxAt), 0, 0);
    await until(async () => (Object.keys((await truth!.ok<{ counts: Record<string, number> }>('inv', [name])).counts).some((k) => k.endsWith('shulker_box')) ? true : undefined), 15_000, 'shulker box picked up', 250);
    for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword']) await truth!.ok('give', [name, piece, 1]);
    await truth!.ok('give', [name, 'cobblestone', 20 * 64]); // split into 20 full stacks
    const t0 = Date.now();
    let equipSent = false;
    const s = await until(
      async () => {
        const st = await state();
        const inv = st.inventory;
        if (!inv) return undefined;
        const worn = inv.armour.every((a) => a?.name.startsWith('iron_'));
        if (!worn && !equipSent && Date.now() - t0 > 4000) {
          equipSent = true; // the survival kit puts armour on by itself after an inventory change; !equip if it has not yet
          measurements.push(`!equip from the panel: ${JSON.stringify((await cmd('!equip')).body.replies)}`);
        }
        const cobble = inv.slots.filter((x) => x?.name === 'cobblestone');
        return worn && cobble.length === 20 && inv.slots.some((x) => x?.name === 'iron_sword') && inv.slots.some((x) => x?.box?.known && x.box.items.length > 0) ? st : undefined;
      },
      30_000,
      'inventory block: iron armour worn, the sword, 20 cobblestone stacks, the box with contents',
      500,
    );
    const inv = s.inventory!;
    expect(inv.armour.map((a) => a?.name)).toEqual(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
    expect(inv.armour.map((a) => a?.dur?.pct)).toEqual([100, 100, 100, 100]);
    expect(inv.armour.map((a) => a?.icon)).toEqual(['helmet', 'chestplate', 'leggings', 'boots']);
    expect(inv.armourPoints).toBe(15);
    const cobble = inv.slots.filter((x) => x?.name === 'cobblestone');
    expect(cobble.map((x) => x!.count)).toEqual(Array(20).fill(64));
    expect(cobble[0]).toMatchObject({ icon: 'block', abbr: 'Co', colour: '#8d8f93' });
    expect(inv.slots.find((x) => x?.name === 'iron_sword')).toMatchObject({ count: 1, icon: 'sword', dur: { left: 250, max: 250, pct: 100 } });
    const box = inv.slots.find((x) => x?.name.endsWith('shulker_box'))!;
    expect(box).toMatchObject({ icon: 'box', count: 1, box: { known: true, stacks: 3, items: [['cobblestone', 128], ['iron_ingot', 10]], more: 0 } });
    expect(inv.selected).toBeGreaterThanOrEqual(0);
    expect(inv.selected).toBeLessThan(9);
    // the same as the server's view
    const real = await truth!.ok<{ slots: ({ typeId: string; amount: number } | null)[] }>('inv', [name]);
    expect(inv.slots.map((x) => (x ? `${x.name} ${x.count}` : null))).toEqual(real.slots.map((x) => (x ? `${x.typeId.replace(/^minecraft:/, '')} ${x.amount}` : null)));
    expect(36 - inv.free).toBe(22);
    // the statuses
    expect(s.self.health).toBeGreaterThan(0);
    expect(s.self.day).not.toBeNull();
    expect(s.self.deaths).toBe(0);
    expect(s.combat).toMatchObject({ fights: 0, kills: 0 });
    expect(s.conn).toMatchObject({ state: 'spawned', reconnects: 0, kicks: 0 });
    expect(s.planner).not.toBeNull();
    expect(s.memory).not.toBeNull();
    expect((await fetch(`${BASE}/api/chests`, { headers: AUTH }).then((r) => r.json())) as unknown[]).toEqual([]);
    const lite = await fetch(`${BASE}/api/state?lite=1`, { headers: AUTH });
    const liteText = await lite.text();
    const full = JSON.stringify(s).length;
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = performance.now();
      await fetch(`${BASE}/api/state?lite=1`, { headers: AUTH }).then((r) => r.text());
      times.push(performance.now() - a);
    }
    times.sort((a, b) => a - b);
    expect(liteText.length).toBeLessThan(20_000);
    // the page: the grid and every status block
    const html = await fetch(`${BASE}/`, { headers: AUTH }).then((r) => r.text());
    expect(html.match(/class="cell /g)).toHaveLength(41);
    for (const id of STATUS_BLOCKS) expect(html).toContain(`id="${id}"`);
    for (const m of ['id="theme"', 'id="stale"', 'id="clock"', 'id="helpbox"', '<symbol id="g-sword"']) expect(html).toContain(m);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1[:/])/); // only the bot's own URL (the log line `control panel: http://127.0.0.1:<port>/`)
    expect(Buffer.byteLength(html)).toBeLessThan(PANEL_BUDGETS.html); // decision 0061: the page without its script (the modules have their own budgets)
    // !set from the panel shows in the settings block
    const set = await cmd('!set guardRadius 20');
    expect(set.status).toBe(200);
    const after = await state();
    expect(after.settings.find((r) => r.key === 'guardRadius')).toMatchObject({ value: '20', source: 'chat' });
    const liteAfter = (await fetch(`${BASE}/api/state?lite=1`, { headers: AUTH }).then((r) => r.json())) as { settings: { key: string; value: string; source: string }[] };
    expect(liteAfter.settings.find((r) => r.key === 'guardRadius')).toEqual({ key: 'guardRadius', value: '20', source: 'chat' });
    await cmd('!set guardRadius 16');
    const line = `Track AP: /api/state ${full} bytes, ?lite=1 ${liteText.length} bytes (median ${times[5]!.toFixed(1)} ms over 10); page ${html.length} bytes; inventory ${JSON.stringify(inv).length} bytes, ${36 - inv.free} slots used, armour ${inv.armourPoints}; box ${JSON.stringify(box.box)}; memory ${JSON.stringify(s.memory)}; planner ${JSON.stringify(s.planner)}; !set reply "${set.body.replies[0]}"`;
    console.log(line);
    measurements.push(line);
  }, 90_000);

  it('!panel prints the loopback URL; 5 commands per second', async () => {
    await sleep(1100); // Track AP: past the rate-limit window of the previous test
    const r = await cmd('!panel');
    expect(r.body.replies[0]).toBe(`panel: http://127.0.0.1:${PORT}/ (this machine only; panel.host 0.0.0.0 + panel.token for the LAN)`);
    expect(r.body.replies[0]).not.toContain(TOKEN);
    await sleep(1100);
    const codes = await Promise.all(Array.from({ length: 7 }, () => cmd('!pos', true).then((x) => x.status)));
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
    measurements.push(`rate limit: 7 parallel !pos -> ${JSON.stringify(codes)}`);
  });

  it('!quit from the panel exits the bot with code 0', async () => {
    await sleep(1100); // past the rate-limit window of the previous test
    const r = await cmd('!quit');
    expect(r.body.replies[0]).toBe('bye (quit by console)');
    const t0 = Date.now();
    const code = await Promise.race([cli!.exit, sleep(15_000).then(() => 'timeout' as const)]);
    measurements.push(`!quit from the panel: exit ${String(code)} after ${Date.now() - t0} ms`);
    expect(code).toBe(0);
    cli = undefined;
  }, 30_000);
});
