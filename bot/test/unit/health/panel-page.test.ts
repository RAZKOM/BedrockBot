// Track AP (docs/panel.md "The page"): the page markup (41 inventory cells, a marker for every status
// block and every id the modules name, no external URLs) and the page's browser modules (decision 0061:
// client/main.ts start() on the fake DOM of panel-dom.ts, the poll fallback of an old browser): the
// first render fills the cells and blocks from the embedded state, a poll updates only what changed, a
// failed poll shows the stale marker, a hidden tab polls every 10 s, the theme toggle survives a
// storage that throws. Track AR: the context menus, confirmations, Stop / Pause, settings, quick
// buttons, log filter and palette. The stream transport: panel-transport.test.ts; budgets: panel-budgets.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIRM_MS, HIDDEN_POLL_MS, MAP_PREFS_KEY, POLL_MS, QUICK_KEY, VIEW_KEY } from '../../../src/health/panel/shared.ts';
import { clientModules } from '../../../src/health/panel/assets.ts';
import { answer, flush, runPage, type FakeEl, type Harness } from './panel-dom.ts';
import { GLYPHS } from '../../../src/health/panel/glyphs.ts';
import { ICON_CLASSES } from '../../../src/health/panel/inventory.ts';
import { renderPanelPage, STATUS_BLOCKS } from '../../../src/health/panel/page.ts';
import { liteState, QUICK_COMMANDS, type PanelState } from '../../../src/health/panel/state.ts';
import { fullInventory, fullState, stack } from './panel-fixtures.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const ids = (html: string): Set<string> => new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!));

describe('panel page markup', () => {
  const s = fullState();
  const html = renderPanelPage(s);

  it('the inventory grid: 36 + 5 cells, hotbar after the main inventory', () => {
    expect(html.match(/class="cell /g)).toHaveLength(41);
    const slots = [...html.matchAll(/data-slot="([^"]+)"/g)].map((m) => m[1]!);
    expect(slots).toEqual(['a0', 'a1', 'a2', 'a3', 'off', ...Array.from({ length: 27 }, (_, i) => `s${i + 9}`), ...Array.from({ length: 9 }, (_, i) => `s${i}`)]);
    for (const c of ICON_CLASSES) expect(html).toContain(`<symbol id="g-${c}" viewBox="0 0 16 16">`);
    expect(Object.keys(GLYPHS).sort()).toEqual([...ICON_CLASSES].sort());
  });

  it('a marker for every status block and every id the modules name', () => {
    const have = ids(html);
    for (const b of STATUS_BLOCKS) expect(have).toContain(b);
    const dir = new URL('../../../src/health/panel/client/', import.meta.url);
    const src = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
    const named = new Set([...src.matchAll(/\b(?:text|width|\$|need)\('([a-z-]+)'/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(60);
    for (const id of named) expect([id, have.has(id)]).toEqual([id, true]);
    for (const m of ['id="panel-commands"', 'id="cmdform"', 'data-cmd="!home go"', 'id="panel-settings"', 'data-key="guardRadius"', 'id="panel-logs"', 'id="helpbox"', 'id="mapscreen"', 'id="view-map"', 'id="stale"', 'id="theme"', 'id="clock"', 'href="/api/chests"']) expect(html).toContain(m);
  });

  it('no external URLs or assets: the only script is the entry module, the only links preload the modules', () => {
    expect(html.match(/https?:\/\//g)).toBeNull(); // the bot's own links are relative (/map, /api/chests, /ui/...)
    expect(html).not.toMatch(/@import|url\(|\ssrc="(?!\/)/);
    const m = clientModules();
    expect([...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((x) => x[1])).toEqual([m.url('client/boot.ts')]);
    expect([...html.matchAll(/<link\b[^>]*>/g)].map((x) => x[0])).toEqual(m.urls().map((u) => `<link rel="modulepreload" href="${u}">`));
    expect(html).not.toMatch(/<script>(?!\(function\(\)\{var t=null;try\{t=localStorage)/); // the theme boot is the only inline classic script
  });

  it('the embedded state is the lite poll shape, with no closing script tag in it', () => {
    const m = /<script type="application\/json" id="initial">([^<]*)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual(JSON.parse(JSON.stringify(liteState(s))));
    const evil = renderPanelPage(fullState({ logs: () => ['</script><script>alert(1)</script>'] }));
    expect(evil).not.toContain('</script><script>alert(1)');
  });
});


describe('panel page script (fake DOM)', () => {
  it('the first render fills the cells and the status blocks from the embedded state', () => {
    const s = fullState();
    const h = runPage(renderPanelPage(s));
    const sword = h.cells.get('s0')!;
    expect(sword.querySelector('use').getAttribute('href')).toBe('#g-sword');
    expect(sword.style.color).toBe('#c9ccd1');
    expect(sword.querySelector('.ab').textContent).toBe('ISw');
    expect(sword.querySelector('.ct').textContent).toBe(''); // count 1
    expect(sword.querySelector('.dur').hidden).toBe(false);
    expect(sword.querySelector('.dur').firstChild!.style.width).toBe('50%');
    expect(sword.title).toBe('iron sword, durability 125/250 (50%)');
    expect(h.cells.get('s9')!.querySelector('.ct').textContent).toBe('64');
    expect(h.cells.get('s9')!.querySelector('.dur').hidden).toBe(true);
    expect(h.cells.get('s2')!.classList.contains('sel')).toBe(true);
    expect(h.cells.get('s0')!.classList.contains('sel')).toBe(false);
    expect(h.cells.get('a1')!.querySelector('use').getAttribute('href')).toBe('#g-chestplate');
    expect(h.cells.get('off')!.querySelector('use').getAttribute('href')).toBe('#g-shield');
    expect(h.cells.get('s32')!.title).toBe('red shulker box, 128 cobblestone, 10 iron ingot (3/27 slots)');
    const t = (id: string) => h.els.get(id)!.textContent;
    expect(t('v-health')).toBe('17.5 / 20');
    expect(h.els.get('b-health')!.style.width).toBe('87.5%');
    expect(t('v-sat')).toBe('4.8');
    expect(t('v-armour')).toBe('15 / 20');
    expect(t('v-time')).toBe('12:00 day, day 12 (6000)');
    expect(h.els.get('clock-hand')!.getAttribute('transform')).toBe('rotate(360.0 10 10)');
    expect(t('v-weather')).toBe('rain');
    expect(t('v-deaths')).toBe('1');
    expect(t('job')).toBe('get (active): getting 32 oak_log: 12/32 (fell 3 trees), eta 1 min');
    expect(h.els.get('stack')!.children).toHaveLength(3);
    expect(t('c-damage')).toBe('37.5 in 21 hits');
    expect(t('m-chests')).toBe('9 known: 8 reachable, 1 unreachable');
    expect(t('m-ores')).toBe('11: 6 iron ore, 4 coal ore, 1 diamond ore');
    expect(t('p-plans')).toBe('120 (14 interims, 118 results, 2 failed)');
    expect(t('k-reconnects')).toBe('1 (1 disconnects)');
    expect(t('inv-sum')).toBe('36/36 slots used, armour 15/20');
    expect(h.debug[0]).toMatch(/^panel: render \d+\.\d\d ms, state \d+ bytes$/);
    expect(h.timers.at(-1)!.ms).toBe(POLL_MS);
  });

  it('item pictures (decision 0046): a cell asks for /icons/<name>.png, shows it once loaded, keeps its glyph for a 404 and asks once per name', async () => {
    const h = runPage(renderPanelPage(fullState()));
    const sword = h.cells.get('s0')!;
    const img = sword.querySelector('img');
    expect(img.src).toBe('/icons/iron_sword.png');
    expect(img.hidden).toBe(true); // the glyph shows until the picture is in
    expect(sword.classList.contains('tex')).toBe(false);
    img.fire('load');
    expect(img.hidden).toBe(false);
    expect(sword.classList.contains('tex')).toBe(true);
    // the same item in two cells: one 404 teaches the page that the name has none
    const [c9, c10] = [h.cells.get('s9')!, h.cells.get('s10')!];
    expect(c9.querySelector('img').src).toBe('/icons/cobblestone.png');
    c10.querySelector('img').fire('load');
    expect(c10.classList.contains('tex')).toBe(true);
    c9.querySelector('img').fire('error');
    expect(c9.querySelector('img').hidden).toBe(true);
    expect(c9.classList.contains('tex')).toBe(false);
    const inv = fullInventory();
    (inv.slots as (ItemStack | null)[])[10] = stack('cobblestone', 63); // s10 changes, the item is the same
    (inv.slots as (ItemStack | null)[])[0] = stack('diamond_pickaxe', 1); // s0 is another item
    h.fetchQueue.push(answer(liteState(fullState({ inventory: () => inv }))));
    await h.timers.at(-1)!.fn();
    expect(c10.querySelector('img').hidden).toBe(true); // no new request for a name that has none
    expect(c10.classList.contains('tex')).toBe(false);
    expect(sword.querySelector('img').src).toBe('/icons/diamond_pickaxe.png');
    expect(sword.querySelector('img').hidden).toBe(true); // until the new one loads
    expect(sword.classList.contains('tex')).toBe(false);
  });

  it('item pictures: nothing is requested when the server has none, or for an empty cell', () => {
    const h = runPage(renderPanelPage(fullState({ icons: () => false })));
    for (const c of h.cells.values()) expect(c.querySelector('img').src).toBe('');
    const empty = runPage(renderPanelPage(fullState({ inventory: () => ({ slots: [], selected: 0, window: () => undefined, rawItem: () => undefined }) })));
    for (const c of empty.cells.values()) expect(c.querySelector('img').src).toBe('');
  });

  it('a poll writes only what changed; tapping a slot shows its details', async () => {
    const s = fullState();
    const h = runPage(renderPanelPage(s));
    const writes = () => [...h.els.values()].reduce((n, e) => n + e.writes, 0);
    const before = writes();
    h.fetchQueue.push(answer(liteState(s)));
    await h.timers.at(-1)!.fn();
    expect(h.fetched).toEqual(['/api/state?lite=1']);
    expect(writes()).toBe(before); // same state: no text node touched
    const moved = fullState({ vitals: () => ({ health: 9, food: 18 }), inventory: () => ({ slots: [], selected: 4, window: () => undefined, rawItem: () => undefined }) });
    h.fetchQueue.push(answer(liteState(moved)));
    await h.timers.at(-1)!.fn();
    expect(h.els.get('v-health')!.textContent).toBe('9 / 20');
    expect(h.cells.get('s0')!.classList.contains('empty')).toBe(true);
    expect(h.cells.get('s4')!.classList.contains('sel')).toBe(true);
    expect(h.cells.get('s0')!.title).toBe('hotbar 1: empty');
    h.fetchQueue.push(answer(liteState(s)));
    await h.timers.at(-1)!.fn();
    h.cells.get('s31')!.fire('click');
    expect(h.els.get('iteminfo')!.textContent).toBe('inventory 31: undyed shulker box\ncount 1\nshulker box: 64 test item number 0, 63 test item number 1, 62 test item number 2, 61 test item number 3, 60 test item number 4, 59 test item number 5, 58 test item number 6, 57 test item number 7, +19 more kinds (27/27 slots)');
    h.cells.get('a3')!.fire('click');
    expect(h.els.get('iteminfo')!.textContent).toBe('feet: iron boots\ncount 1\ndurability 5 of 195 (3%)');
  });

  it('a failed poll shows the stale marker; a hidden tab polls every 10 s; visible again polls at once', async () => {
    const s = fullState();
    const h = runPage(renderPanelPage(s));
    h.fetchQueue.push(() => Promise.reject(new Error('Failed to fetch')));
    await h.timers.at(-1)!.fn();
    expect(h.els.get('stale')!.hidden).toBe(false);
    expect(h.els.get('stale')!.textContent).toMatch(/^stale \d+ s$/);
    expect(h.doc.body.classList.contains('is-stale')).toBe(true);
    expect(h.els.get('err')!.textContent).toBe('offline: Failed to fetch');
    h.doc.hidden = true;
    h.fetchQueue.push(answer(liteState(s)));
    await h.timers.at(-1)!.fn();
    expect(h.els.get('stale')!.hidden).toBe(true);
    expect(h.doc.body.classList.contains('is-stale')).toBe(false);
    expect(h.timers.at(-1)!.ms).toBe(HIDDEN_POLL_MS);
    h.doc.hidden = false;
    for (const f of h.doc.listeners.get('visibilitychange') ?? []) f();
    expect(h.timers.at(-1)!.ms).toBe(0);
  });

  it('theme: the toggle flips and stores the choice; a storage that throws changes nothing else', () => {
    const html = renderPanelPage(fullState());
    const h = runPage(html);
    expect(h.els.get('theme')!.textContent).toBe('light');
    h.els.get('theme')!.fire('click');
    expect(h.doc.documentElement.dataset.theme).toBe('light');
    expect(h.storage.get('bbpanel-theme')).toBe('light');
    expect(h.els.get('theme')!.textContent).toBe('dark');
    const blocked = runPage(html, { storageThrows: true, prefersLight: true });
    expect(blocked.els.get('theme')!.textContent).toBe('dark');
    expect(() => blocked.els.get('theme')!.fire('click')).not.toThrow();
    expect(blocked.doc.documentElement.dataset.theme).toBe('dark');
    expect(html).toContain("try{t=localStorage.getItem('bbpanel-theme')}catch(e){}");
  });

  it('render time with a full inventory (fake DOM; the browser logs its own in the console)', () => {
    const s = liteState(fullState()) as unknown as PanelState;
    const h = runPage(renderPanelPage(fullState()));
    const empty = liteState(fullState({ inventory: () => ({ slots: [], selected: 0, window: () => undefined, rawItem: () => undefined }) }));
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      h.fetchQueue.push(answer(i % 2 ? s : empty)); // every poll changes all 36 cells
    }
    return (async () => {
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now();
        await h.timers.at(-1)!.fn();
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      console.log(`panel render (fake DOM, every cell changing): median ${times[25]!.toFixed(2)} ms, max ${times[49]!.toFixed(2)} ms over 50 polls`);
      expect(times[25]).toBeLessThan(20);
    })();
  });
});

// ---- Track AR: the interactions on the fake DOM ----------------------------------------------------

const menuButtons = (h: Harness): FakeEl[] => h.els.get('menu')!.children.filter((c) => c.dataset.act);
const labels = (h: Harness): string[] => menuButtons(h).map((b) => b.textContent);
const pick = (h: Harness, id: string): FakeEl => menuButtons(h).find((b) => b.dataset.act === id)!;
const ok = (replies: string[]) => answer({ ok: true, command: '', replies });

describe('panel page script: menus and controls (Track AR, fake DOM)', () => {
  it('tapping a cell opens its menu; an action sends its chat command and toasts the reply', async () => {
    const h = runPage(renderPanelPage(fullState()));
    const menu = h.els.get('menu')!;
    expect(menu.hidden).toBe(true);
    h.cells.get('s0')!.fire('click');
    expect(menu.hidden).toBe(false);
    expect(menu.children[0]!.textContent).toBe('hotbar 1: iron sword, durability 125/250 (50%)');
    expect(labels(h)).toEqual(['Select (hold slot 1)', 'Drop', 'Unload now']);
    h.fetchQueue.push(ok(['selected hotbar slot 0: iron_sword x1']));
    pick(h, 'select').fire('click');
    await flush();
    expect(h.posted).toEqual(['!select 0']);
    expect(menu.hidden).toBe(true);
    expect(h.els.get('toast')!.hidden).toBe(false);
    expect(h.els.get('toast')!.textContent).toBe('!select 0\nselected hotbar slot 0: iron_sword x1');
    expect(h.timers.at(-1)!.ms).toBe(300); // the state is polled again right after
  });

  it('destructive drops need a second tap; the first only arms the button', async () => {
    const h = runPage(renderPanelPage(fullState()));
    h.cells.get('s9')!.fire('click');
    expect(labels(h)).toEqual(['Drop 1', 'Drop the stack (64)', 'Drop all 1280 cobblestone', 'Unload now']);
    const stackBtn = pick(h, 'dropstack');
    stackBtn.fire('click');
    await flush();
    expect(h.posted).toEqual([]);
    expect(stackBtn.textContent).toBe('tap again: Drop the stack (64)');
    expect(h.timers.at(-1)!.ms).toBe(CONFIRM_MS);
    h.fetchQueue.push(ok(['dropped 64 cobblestone']));
    stackBtn.fire('click');
    await flush();
    expect(h.posted).toEqual(['!drop slot 9']);
    // disarmed after 4 s: a later single tap only arms again
    h.cells.get('s10')!.fire('click');
    const all = pick(h, 'dropall');
    all.fire('click');
    h.timers.at(-1)!.fn(); // the 4 s timer
    expect(all.textContent).toBe('Drop all 1280 cobblestone');
    all.fire('click');
    await flush();
    expect(h.posted).toEqual(['!drop slot 9']);
  });

  it('a shulker box shows its contents locally; the offhand cell clears; tapping the same cell closes', async () => {
    const h = runPage(renderPanelPage(fullState()));
    h.cells.get('s32')!.fire('click');
    pick(h, 'box').fire('click');
    expect(h.posted).toEqual([]);
    expect(h.els.get('iteminfo')!.textContent).toContain('shulker box: 128 cobblestone, 10 iron ingot (3/27 slots)');
    h.cells.get('off')!.fire('click');
    expect(labels(h)).toEqual(['Back into the inventory']);
    h.fetchQueue.push(ok(['offhand: shield moved back into the inventory']));
    pick(h, 'offclear').fire('click');
    await flush();
    expect(h.posted).toEqual(['!offhand clear']);
    h.cells.get('s4')!.fire('click');
    expect(h.els.get('menu')!.hidden).toBe(false);
    h.cells.get('s4')!.fire('click');
    expect(h.els.get('menu')!.hidden).toBe(true);
  });

  it('Stop on each user process, Pause / Resume by the paused flag', async () => {
    const h = runPage(renderPanelPage(fullState({ paused: () => false })));
    const items = h.els.get('stack')!.children;
    const stops = items.map((li) => li.children.find((c) => c.dataset.cmd === '!stop')).filter((b): b is FakeEl => b !== undefined);
    expect(stops).toHaveLength(2); // get and build (user); guard (auto) has none
    expect(h.els.get('btn-pause')!.disabled).toBe(false);
    expect(h.els.get('btn-resume')!.disabled).toBe(true);
    h.fetchQueue.push(ok(['stopped (was get)']));
    stops[0]!.fire('click');
    await flush();
    h.fetchQueue.push(ok(['paused']));
    h.els.get('btn-pause')!.fire('click');
    await flush();
    expect(h.posted).toEqual(['!stop', '!pause']);
    h.fetchQueue.push(answer(liteState(fullState({ paused: () => true }))));
    await h.timers.at(-1)!.fn();
    expect(h.els.get('btn-pause')!.disabled).toBe(true);
    expect(h.els.get('btn-resume')!.disabled).toBe(false);
    expect(h.els.get('paused')!.textContent).toBe('commands held (!pause)');
  });

  it('settings: Reset when changed, a switch sends on / off, the mode needs a second tap, changed-only and search filter', async () => {
    const h = runPage(renderPanelPage(fullState({ settings: new RuntimeSettings() })));
    const guard = h.rows.get('guardRadius')!;
    expect(guard.querySelector('button.reset').hidden).toBe(true);
    expect(h.inputs.get('sprint')!.checked).toBe(true);
    expect(h.els.get('mode-now')!.textContent).toBe('normal');
    const changed = new RuntimeSettings();
    changed.set('guardRadius', 20);
    h.fetchQueue.push(answer(liteState(fullState({ settings: changed }))));
    await h.timers.at(-1)!.fn();
    expect(guard.classList.contains('changed')).toBe(true);
    expect(guard.querySelector('button.reset').hidden).toBe(false);
    expect(h.inputs.get('guardRadius')!.value).toBe('20');
    expect(h.els.get('mode-now')!.textContent).toBe('custom');
    h.fetchQueue.push(ok(['guardRadius = 16 (was 20)']));
    guard.querySelector('button.reset').fire('click');
    await flush();
    const sprint = h.inputs.get('sprint')!;
    sprint.checked = false;
    h.fetchQueue.push(ok(['sprint = off']));
    sprint.fire('change');
    await flush();
    expect(h.posted).toEqual(['!set guardRadius default', '!set sprint off']);
    const careful = h.modeButtons.find((b) => b.dataset.mode === 'careful')!;
    careful.fire('click');
    expect(h.els.get('mode-diff')!.textContent).toMatch(/^careful changes fleeHealth 8 -> 12, guardRadius 20 -> 8, .*; tap careful again to apply$/);
    expect(h.posted).toHaveLength(2);
    h.fetchQueue.push(ok(['mode careful: ...']));
    careful.fire('click');
    await flush();
    expect(h.posted.at(-1)).toBe('!mode careful');
    h.els.get('set-changed')!.checked = true;
    h.els.get('set-changed')!.fire('change');
    expect(guard.hidden).toBe(false);
    expect(h.rows.get('sprint')!.hidden).toBe(true);
    h.els.get('set-changed')!.checked = false;
    h.els.get('set-q')!.value = 'sprint';
    h.els.get('set-q')!.fire('input');
    expect(h.rows.get('sprint')!.hidden).toBe(false);
    expect(guard.hidden).toBe(true);
  });

  it('quick buttons kept in this browser, the log filter, the palette from /api/help', async () => {
    const html = renderPanelPage(fullState());
    expect(runPage(html).els.get('quick')!.children).toHaveLength(0); // no stored list: the server's buttons stay
    const h = runPage(html, { storage: { [QUICK_KEY]: JSON.stringify(['!pos', '!inv']) } });
    const q = h.els.get('quick')!.children;
    expect(q.map((b) => b.dataset.cmd)).toEqual(['!pos', '!inv']);
    h.fetchQueue.push(ok(['pos 1 2 3']));
    q[0]!.fire('click');
    await flush();
    expect(h.posted).toEqual(['!pos']);
    h.els.get('quick-edit')!.fire('click');
    expect(h.els.get('quick-text')!.value).toBe('!pos\n!inv');
    h.els.get('quick-text')!.value = 'status\n\n!guard on';
    h.els.get('quick-save')!.fire('click');
    expect(h.storage.get(QUICK_KEY)).toBe(JSON.stringify(['!status', '!guard on']));
    expect(h.els.get('quick')!.children.map((b) => b.dataset.cmd)).toEqual(['!status', '!guard on']);
    h.els.get('quick-reset')!.fire('click');
    expect(h.storage.has(QUICK_KEY)).toBe(false);
    expect(h.els.get('quick')!.children.map((b) => b.dataset.cmd)).toEqual(QUICK_COMMANDS);
    // the log: the modules seen are offered; level and text filters
    expect(h.els.get('log-mod')!.children.map((o) => o.value)).toEqual(['move']);
    h.els.get('log-level')!.value = 'WARN';
    h.els.get('log-level')!.fire('change');
    expect(h.els.get('logs')!.textContent).toBe('(no line matches the filter)');
    h.els.get('log-level')!.value = '';
    h.els.get('log-q')!.value = '(plan 7)';
    h.els.get('log-q')!.fire('input');
    expect(h.els.get('logs')!.textContent.split('\n')).toHaveLength(1);
    // the palette
    h.fetchQueue.push(answer({ commands: [{ name: 'goto', tier: 'more', group: 'go', syntax: 'x y z', help: 'walk to a feet block' }, { name: 'get', tier: 'front', group: 'work', syntax: '<item> [n]', help: 'get items' }] }));
    h.els.get('cmd')!.fire('focus');
    await flush();
    expect(h.fetched.at(-1)).toBe('/api/help');
    h.els.get('cmd')!.value = 'go';
    h.els.get('cmd')!.fire('input');
    const pal = h.els.get('palette')!;
    expect(pal.hidden).toBe(false);
    expect(pal.children.map((c) => c.textContent || c.children.map((x) => x.textContent).join(''))).toEqual(['more', '!goto x y z  walk to a feet block']);
    pal.children[1]!.fire('pointerdown');
    expect(h.els.get('cmd')!.value).toBe('!goto ');
    expect(pal.hidden).toBe(true);
  });
});

describe('panel page script: the offline banner (fake DOM)', () => {
  const kickedState = (now: number) =>
    fullState({
      connState: () => 'connecting',
      healthy: () => false,
      link: () => ({ state: 'connecting', since: now - 3000, retryAt: now + 20_000, attempt: 2, lastDisconnect: { ts: new Date(now - 60_000).toISOString(), kind: 'kick', reason: 'kicked_for_idle' } }),
    });
  const rows = (h: Harness): string[] => h.els.get('link-rows')!.children.map((c) => c.textContent);

  it('the markup: the banner is hidden while online and shown for a disconnected state', () => {
    expect(renderPanelPage(fullState())).toMatch(/<section id="panel-link" class="wide link" role="status" aria-live="polite" hidden>/);
    expect(renderPanelPage(kickedState(Date.now()))).toMatch(/<section id="panel-link" class="wide link" role="status" aria-live="polite">/);
  });

  it('reconnecting: the banner says why and when, actions are greyed, world commands are not sent; it all comes back when the bot spawns', async () => {
    const h = runPage(renderPanelPage(kickedState(Date.now())));
    const banner = h.els.get('panel-link')!;
    expect(banner.hidden).toBe(false);
    expect(banner.className).toBe('wide link link-bad');
    expect(h.els.get('link-title')!.textContent).toBe('Kicked: reconnecting');
    expect(h.els.get('link-detail')!.textContent).toMatch(/not in the game/);
    const r = rows(h);
    expect(r.slice(0, 2)).toEqual(['last disconnect', 'kick: kicked_for_idle (1 min ago)']);
    expect(r[2]).toBe('next try');
    expect(r[3]).toMatch(/^in (19|20) s \(attempt 2\)$/);
    expect(h.els.get('link-signin')!.hidden).toBe(true);
    expect(h.doc.body.classList.contains('is-offline')).toBe(true);
    expect(h.els.get('inv-sum')!.textContent).toBe('36/36 slots used, armour 15/20 (last known)');
    const q = (c: string) => h.quick.find((b) => b.dataset.cmd === c)!;
    expect(q('!status').disabled).toBe(false);
    expect(q('!home go').disabled).toBe(true);
    expect(q('!stop').disabled).toBe(false);
    // a cell's menu: no command actions, a note instead; a box still shows its contents (local)
    h.cells.get('s0')!.fire('click');
    expect(labels(h)).toEqual([]);
    expect(h.els.get('menu')!.children.map((c) => c.textContent)).toContain('Kicked: reconnecting: actions come back when the bot has spawned');
    h.cells.get('s32')!.fire('click');
    expect(labels(h)).toEqual(['Show contents']);
    // the command box: a world command is not sent, !status is
    h.els.get('cmd')!.value = '!goto 1 2 3';
    h.els.get('cmdform')!.fireWith('submit', {});
    await flush();
    expect(h.posted).toEqual([]);
    expect(h.els.get('replies')!.textContent).toBe('> !goto 1 2 3\nnot sent: Kicked: reconnecting. !status, !set, !help and !stop still work.');
    h.fetchQueue.push(ok(['status: up 2h']));
    h.els.get('cmd')!.value = '!status';
    h.els.get('cmdform')!.fireWith('submit', {});
    await flush();
    expect(h.posted).toEqual(['!status']);
    // the bot spawns again: the next poll clears the banner and brings the actions back
    h.fetchQueue.push(answer(liteState(fullState())));
    await h.timers.at(-1)!.fn();
    expect(banner.hidden).toBe(true);
    expect(h.doc.body.classList.contains('is-offline')).toBe(false);
    expect(q('!home go').disabled).toBe(false);
    expect(h.els.get('inv-sum')!.textContent).toBe('36/36 slots used, armour 15/20');
    h.cells.get('s0')!.fire('click');
    expect(labels(h)).toEqual(['Select (hold slot 1)', 'Drop', 'Unload now']);
  });

  it('sign-in and dead: the code and link, the respawn countdown (commands still go through while dead)', async () => {
    const now = Date.now();
    const h = runPage(renderPanelPage(fullState({ connState: () => 'connecting', link: () => ({ state: 'connecting', since: now, attempt: 0, signIn: { verification_uri: 'https://microsoft.com/link', user_code: 'ABCD1234', expires_in: 900, at: now } }) })));
    expect(h.els.get('link-title')!.textContent).toBe('Not signed in');
    expect(h.els.get('link-signin')!.hidden).toBe(false);
    expect(h.els.get('link-url')!.getAttribute('href')).toBe('https://microsoft.com/link');
    expect(h.els.get('link-code')!.textContent).toBe('ABCD1234');
    h.fetchQueue.push(answer(liteState(fullState({ link: () => ({ state: 'spawned', dead: { since: now - 500, cause: 'death.attack.mob', respawnAt: now + 1500 } }) }))));
    await h.timers.at(-1)!.fn();
    expect(h.els.get('link-title')!.textContent).toBe('Dead: respawning');
    expect(h.els.get('panel-link')!.className).toBe('wide link link-dead');
    expect(h.els.get('link-signin')!.hidden).toBe(true);
    expect(h.doc.body.classList.contains('is-offline')).toBe(true);
    expect(h.quick.find((b) => b.dataset.cmd === '!home go')!.disabled).toBe(false);
    h.fetchQueue.push(ok(['ok']));
    h.els.get('cmd')!.value = '!guard on';
    h.els.get('cmdform')!.fireWith('submit', {});
    await flush();
    expect(h.posted).toEqual(['!guard on']);
  });

  it('the panel does not answer (the bot process restarts): the banner says so, and the first answer clears it', async () => {
    const h = runPage(renderPanelPage(fullState()));
    expect(h.els.get('panel-link')!.hidden).toBe(true);
    h.fetchQueue.push(() => Promise.reject(new Error('Failed to fetch')));
    await h.timers.at(-1)!.fn();
    expect(h.els.get('panel-link')!.hidden).toBe(false);
    expect(h.els.get('panel-link')!.className).toBe('wide link link-down');
    expect(h.els.get('link-title')!.textContent).toBe('Panel not answering');
    expect(h.doc.body.classList.contains('is-offline')).toBe(true);
    expect(h.els.get('err')!.textContent).toBe('offline: Failed to fetch');
    h.fetchQueue.push(answer(liteState(fullState())));
    await h.timers.at(-1)!.fn();
    expect(h.els.get('panel-link')!.hidden).toBe(true);
    expect(h.doc.body.classList.contains('is-offline')).toBe(false);
  });
});

describe('panel page script: the map screen (decision 0062, fake DOM and canvas)', () => {
  // the fixture's bot stands at 18311.5 -60 17027.5: chunk 1144, 1064; the canvas is 360 x 640 (the
  // fallback size of the fake DOM), 3 px per block, so the screen centre (180, 320) is the bot
  const b64 = (b: Buffer): string => b.toString('base64');
  const tile = (over: Record<string, unknown> = {}) => ({
    cx: 1144, cz: 1064, live: true, rev: 5, updatedAt: 0,
    y: b64(Buffer.from(new Int16Array(256).fill(-61).buffer)), c: b64(Buffer.alloc(64, 0b01010101)), s: b64(Buffer.alloc(256, 0)), p: [0],
    ...over,
  });
  const tilesAnswer = (over: Record<string, unknown> = {}) => ({
    ts: 0, dim: 0, rev: 5, center: { cx: 1144, cz: 1064 }, radius: 4, window: { cx0: 1140, cz0: 1060, cx1: 1148, cz1: 1068 },
    tiles: [tile()], palFrom: 0, palette: [{ name: 'grass_block', rgb: '#5f9f35' }], ...over,
  });
  const marks = { chests: [{ x: 18313, y: -60, z: 17030, kind: 'chest', label: 'ores', unreachable: false, stacks: 2, size: 27, top: [['coal', 12]], readAt: Date.now() - 60_000 }], herds: [], blocks: { ore: [[18308, -61, 17026, 'iron_ore']] } };
  const actsOf = (h: Harness): FakeEl[] => h.els.get('sheet-acts')!.children.filter((b) => b.dataset.act);
  const act = (h: Harness, id: string): FakeEl => actsOf(h).find((b) => b.dataset.act === id)!;
  const tap = (h: Harness, x: number, y: number): void => {
    const cv = h.els.get('mapcv')!;
    cv.fireWith('pointerdown', { pointerId: 1, clientX: x, clientY: y, button: 0 });
    cv.fireWith('pointerup', { pointerId: 1, clientX: x, clientY: y, button: 0 });
  };
  /** Runs the pending draws (the view draws in a 16 ms timer) and returns the status line. */
  const status = (h: Harness): string => {
    for (const t of h.timers.filter((x) => x.ms === 16)) t.fn();
    return h.els.get('map-status')!.textContent;
  };
  const open = (opts: { stream?: boolean; storage?: Record<string, string> } = {}): Harness =>
    runPage(renderPanelPage(fullState()), { stream: opts.stream ?? true, storage: { [VIEW_KEY]: 'map', ...opts.storage }, answers: [answer(tilesAnswer()), answer(marks)] });

  it('opens on the map: tiles and marks for the window, the map topics on the stream, the HUD, and one tap back to the cards', async () => {
    const h = open();
    await flush();
    expect(h.doc.documentElement.dataset.view).toBe('map');
    expect(h.fetched[0]).toMatch(/^\/api\/map\/tiles\?cid=m[0-9a-z]+&r=\d+&cx=1144&cz=1064&pal=0$/); // streaming: no live=1
    expect(h.fetched[1]).toMatch(/^\/api\/marks\?cx=1144&cz=1064&r=\d+$/);
    expect(h.streams[0]!.url).toBe('/api/stream?topics=state,map,map-live');
    expect(status(h)).toBe('1 chunks');
    expect(h.els.get('hud-hp')!.textContent).toBe('17.5');
    expect(h.els.get('hud-job')!.textContent).toMatch(/^get: getting 32 oak_log: 12\/32/);
    h.els.get('view-cards')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('cards');
    expect(h.storage.get(VIEW_KEY)).toBe('cards');
    h.els.get('view-map')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('map');
    expect(h.storage.get(VIEW_KEY)).toBe('map');
  });

  it('a page on the cards joins no map topic and fetches no tile until the map shows', () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true });
    expect(h.doc.documentElement.dataset.view).toBe('cards');
    expect(h.streams[0]!.url).toBe('/api/stream?topics=state');
    expect(h.fetched.filter((u) => u.startsWith('/api/map'))).toEqual([]);
  });

  it('tiles over the stream: a message adds its tiles, a gap (from newer than our rev) fetches what changed since our rev, a dimension change starts over', async () => {
    const h = open();
    await flush();
    const es = h.streams[0]!;
    es.emit('map', { from: 5, rev: 7, dim: 0, tiles: [tile({ cx: 1145, rev: 7 })] }, 'b.1');
    expect(status(h)).toBe('2 chunks');
    h.fetchQueue.push(answer(tilesAnswer({ rev: 9, tiles: [] })));
    es.emit('map', { from: 8, rev: 9, dim: 0, tiles: [] }, 'b.2'); // we have 7: one was missed
    expect(h.fetched.at(-1)).toMatch(/&since=7&win=1140%2C1060%2C1148%2C1068$/);
    await flush();
    h.fetchQueue.push(answer(tilesAnswer({ dim: 1, rev: 10 })));
    es.emit('map', { from: 9, rev: 10, dim: 1, reset: true }, 'b.3');
    expect(h.fetched.at(-1)).not.toContain('since=');
  });

  it('tap a block: the sheet names it and what is there; Go here shows the exact command and sends it only on Send', async () => {
    const h = open();
    await flush();
    tap(h, 186, 329); // 2 blocks east, 3 south of the bot: 18313 17030 (the chest)
    expect(h.els.get('map-sheet')!.hidden).toBe(false);
    expect(h.els.get('sheet-title')!.textContent).toBe('18313 17030: grass_block, y -61');
    const body = h.els.get('sheet-body')!.children.map((c) => c.textContent);
    expect(body).toEqual(['loaded now', 'chest "ores" (y -60)', '  holds 12 coal (2/27 slots)', '  read 60 s ago']);
    expect(actsOf(h).map((b) => b.dataset.act)).toEqual(['walk', 'wp', 'home', 'shelter', 'dig', 'bring']); // decision 0065: a remembered chest offers Bring...
    act(h, 'walk').fire('click');
    expect(h.els.get('sheet-confirm')!.hidden).toBe(false);
    expect(h.els.get('sheet-cmd')!.textContent).toBe('!goto 18313 -60 17030');
    expect(h.posted).toEqual([]);
    h.fetchQueue.push(ok(['walking to 18313 -60 17030']));
    h.els.get('sheet-send')!.fire('click');
    await flush();
    expect(h.posted).toEqual(['!goto 18313 -60 17030']);
    expect(h.els.get('sheet-reply')!.textContent).toBe('> !goto 18313 -60 17030\nwalking to 18313 -60 17030');
    // a waypoint asks its name; Send stays off until it is a valid one
    act(h, 'wp').fire('click');
    expect(h.els.get('sheet-name')!.hidden).toBe(false);
    expect(h.els.get('sheet-send')!.disabled).toBe(true);
    expect(h.els.get('sheet-cmd')!.textContent).toBe('!wp set <name> 18313 -60 17030');
    h.els.get('sheet-name')!.value = 'Panel_Map';
    h.els.get('sheet-name')!.fire('input');
    expect(h.els.get('sheet-send')!.disabled).toBe(false);
    expect(h.els.get('sheet-cmd')!.textContent).toBe('!wp set panel_map 18313 -60 17030');
    // dig: one block, through !build clear
    act(h, 'dig').fire('click');
    expect(h.els.get('sheet-cmd')!.textContent).toBe('!build clear 18313 -61 17030 18313 -61 17030');
    h.els.get('sheet-cancel')!.fire('click');
    expect(h.els.get('sheet-confirm')!.hidden).toBe(true);
    h.els.get('sheet-close')!.fire('click');
    expect(h.els.get('map-sheet')!.hidden).toBe(true);
  });

  it('box mode: drag a box; the sheet shows the size and the y range from the surface; Clear shows its command, then sends', async () => {
    const h = open();
    await flush();
    h.els.get('map-box')!.fire('click');
    const cv = h.els.get('mapcv')!;
    cv.fireWith('pointerdown', { pointerId: 1, clientX: 180, clientY: 320, button: 0 }); // 18311 17027
    cv.fireWith('pointermove', { pointerId: 1, clientX: 192, clientY: 326, button: 0 }); // 18315 17029
    cv.fireWith('pointerup', { pointerId: 1, clientX: 192, clientY: 326, button: 0 });
    expect(h.els.get('map-sheet')!.hidden).toBe(false);
    expect(h.els.get('sheet-box')!.hidden).toBe(false);
    expect(h.els.get('sheet-title')!.textContent).toBe('box 18311 17027 to 18315 17029');
    expect([h.els.get('box-y1')!.value, h.els.get('box-y2')!.value]).toEqual(['-61', '-61']);
    expect(h.els.get('box-size')!.textContent).toBe('5 x 1 x 3 = 15 blocks');
    expect(actsOf(h).map((b) => b.dataset.act)).toEqual(['clear', 'quarry']); // fill / floor / wall need a picked block
    act(h, 'clear').fire('click');
    expect(h.els.get('sheet-cmd')!.textContent).toBe('!build clear 18311 -61 17027 18315 -61 17029\n5 x 1 x 3 = 15 blocks');
    h.fetchQueue.push(ok(['clearing 15 blocks']));
    h.els.get('sheet-send')!.fire('click');
    await flush();
    expect(h.posted).toEqual(['!build clear 18311 -61 17027 18315 -61 17029']);
    // a picked block offers fill / floor / wall
    h.els.get('box-block')!.value = 'cobblestone';
    h.els.get('box-block')!.fire('change');
    expect(actsOf(h).map((b) => b.dataset.act)).toEqual(['clear', 'fill', 'floor', 'wall', 'quarry']);
    act(h, 'floor').fire('click');
    expect(h.els.get('sheet-cmd')!.textContent).toBe('!build floor 18311 -61 17027 18315 17029 cobblestone\n5 x 1 x 3 = 15 blocks');
  });

  it('layers: the Y-slice fetches its height and the switches are kept in this browser; overlays from the map-live topic', async () => {
    const h = open();
    await flush();
    const slice = h.layers.find((l) => l.dataset.layer === 'slice')!;
    slice.checked = true;
    slice.fire('change');
    expect(h.els.get('map-slice')!.hidden).toBe(false);
    expect(h.els.get('map-yv')!.textContent).toBe('y -60');
    h.fetchQueue.push(answer({ ts: 0, y: -60, tiles: [{ cx: 1144, cz: 1064, live: true, updatedAt: 0, y: -60, c: b64(Buffer.alloc(64, 0)) }], palFrom: 1, palette: [] }));
    await h.timers.find((t) => t.ms === 250)!.fn();
    await flush();
    expect(h.fetched.at(-1)).toMatch(/^\/api\/map\/slice\?y=-60&cx=1144&cz=1064&r=\d+&pal=1$/);
    expect(status(h)).toBe('1 chunks, slice y -60 (1)');
    h.els.get('map-yup')!.fire('click');
    expect(h.els.get('map-yv')!.textContent).toBe('y -59');
    expect(JSON.parse(h.storage.get(MAP_PREFS_KEY)!)).toMatchObject({ layer: 'slice' });
    const items = h.overlays.find((o) => o.dataset.ov === 'items')!;
    items.checked = true;
    items.fire('change');
    expect((JSON.parse(h.storage.get(MAP_PREFS_KEY)!) as { ov: Record<string, boolean> }).ov.items).toBe(true);
    // follow mode moves with the bot; a pan turns it off, the target button turns it on again
    h.streams[0]!.emit('map-live', { snap: { dim: 0, bot: [18400.5, -60, 17100.5, 90], trail: [], path: null, goal: null, busy: false, result: null, ents: {}, home: null, shelter: null, wps: [] } }, 'b.1');
    tap(h, 180, 320);
    expect(h.els.get('sheet-title')!.textContent).toMatch(/^18400 17100: /);
    const cv = h.els.get('mapcv')!;
    cv.fireWith('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    cv.fireWith('pointermove', { pointerId: 1, clientX: 160, clientY: 100, button: 0 });
    cv.fireWith('pointerup', { pointerId: 1, clientX: 160, clientY: 100, button: 0 });
    expect(h.els.get('map-follow')!.classList.contains('on')).toBe(false);
    h.els.get('map-follow')!.fire('click');
    expect(h.els.get('map-follow')!.classList.contains('on')).toBe(true);
  });

  it('without the stream the tiles are polled with the overlays (live=1); a storage that throws still shows the map', async () => {
    const h = open({ stream: false });
    await flush();
    expect(h.fetched[0]).toMatch(/&live=1$/);
    const blocked = runPage(renderPanelPage(fullState()), { storageThrows: true });
    expect(blocked.doc.documentElement.dataset.view).toBe('map');
  });
});
