// Track AP (docs/panel.md "The page"): the page markup (41 inventory cells, a marker for every status
// block and every id the modules name, no external URLs) and the page's browser modules (decision 0061:
// client/main.ts start() on the fake DOM of panel-dom.ts, the poll fallback of an old browser): the
// first render fills the cells and blocks from the embedded state, a poll updates only what changed, a
// failed poll shows the stale marker, a hidden tab polls every 10 s, the theme toggle survives a
// storage that throws. Track AR: the context menus, confirmations, Stop / Pause, settings, quick
// buttons, log filter and palette. The stream transport: panel-transport.test.ts; budgets: panel-budgets.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIRM_MS, HIDDEN_POLL_MS, POLL_MS, QUICK_KEY } from '../../../src/health/panel/shared.ts';
import { clientModules } from '../../../src/health/panel/assets.ts';
import { answer, flush, FakeEl, runPage, type Harness } from './panel-dom.ts';
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
    for (const m of ['id="panel-commands"', 'id="cmdform"', 'data-cmd="!home go"', 'id="panel-settings"', 'data-key="guardRadius"', 'id="panel-logs"', 'id="helpbox"', 'id="panel-map"', 'id="stale"', 'id="theme"', 'id="clock"', 'href="/api/chests"']) expect(html).toContain(m);
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

describe('panel page script: the map (Track AR, fake DOM and canvas)', () => {
  it('opening the map polls /map.json and /api/marks; a right-click opens the column menu; Walk here sends !goto on the surface', async () => {
    const h = runPage(renderPanelPage(fullState()));
    const y = Buffer.from(new Int16Array(256).fill(-61).buffer).toString('base64');
    const c = Buffer.alloc(64, 0b01010101).toString('base64'); // class 1 (solid) everywhere
    const mapJson = {
      v: 1, ts: 0, server: null, dimension: 0, rev: 5, center: { cx: 6, cz: 12 }, radius: 8, window: { cx0: -2, cz0: 4, cx1: 14, cz1: 20 },
      tiles: [{ cx: 6, cz: 12, live: true, rev: 5, updatedAt: 0, y, c }],
      bot: { x: 100.5, y: -60, z: 200.5, yaw: 0 }, trail: [], nav: { busy: false, running: null, path: null, goal: null, result: null, plans: 0 },
      entities: [], home: { x: 98, y: -60, z: 200 }, shelter: null, waypoints: [{ name: 'base', x: 101, y: -60, z: 203 }], cache: null,
    };
    h.fetchQueue.push(answer(mapJson), answer({ chests: [{ x: 99, y: -60, z: 198, kind: 'chest', label: 'ores', unreachable: false }], herds: [] }));
    const view = new FakeEl('mapview');
    view.clientWidth = 400;
    view.clientHeight = 380;
    h.els.set('mapview', view);
    const radius = new FakeEl('map-r');
    radius.value = '8'; // the selected option
    h.els.set('map-r', radius);
    const follow = new FakeEl('map-follow');
    follow.checked = true; // checked in the markup
    h.els.set('map-follow', follow);
    h.els.get('mapbox')!.open = true;
    h.els.get('mapbox')!.fire('toggle');
    await flush();
    expect(h.fetched.slice(-2)).toEqual(['/map.json?r=8&since=-1', '/api/marks']);
    expect(h.els.get('map-info')!.textContent).toBe('idle; 1 chests, 0 herds');
    // the bot is at the centre (200, 190 on a 400 x 380 canvas, 4 px per block): 6 blocks east = x 224
    h.els.get('mapcv')!.fireWith('contextmenu', { clientX: 224, clientY: 190 });
    const menu = h.els.get('menu')!;
    expect(menu.hidden).toBe(false);
    expect(menu.children[0]!.textContent).toBe('106 200: solid at y -61');
    expect(labels(h)).toEqual(['Walk here', 'Set home here', 'Set shelter here', 'Set waypoint here...']);
    h.fetchQueue.push(ok(['walking to 106 -60 200']));
    pick(h, 'walk').fire('click');
    await flush();
    expect(h.posted).toEqual(['!goto 106 -60 200']);
    // the waypoint asks for a name in the menu, then sends
    h.els.get('mapcv')!.fireWith('contextmenu', { clientX: 228, clientY: 194 });
    pick(h, 'wp').fire('click');
    const input = menu.children.find((x) => x.maxLength === 32)!;
    input.value = 'Panel_Map';
    h.fetchQueue.push(ok(['waypoint panel_map set to 107 -60 201']));
    menu.children.find((x) => x.textContent === 'Set waypoint')!.fire('click');
    await flush();
    expect(h.posted.at(-1)).toBe('!wp set panel_map 107 -60 201');
    // a marker under the cursor names itself in the menu title (the home square at 98.5, 200.5)
    h.els.get('mapcv')!.fireWith('contextmenu', { clientX: 200 - 8, clientY: 190 });
    expect(menu.children[0]!.textContent).toBe('home (98 200: solid at y -61)');
    // closing the section stops the map's polling
    h.els.get('mapbox')!.open = false;
    h.els.get('mapbox')!.fire('toggle');
  });
});
