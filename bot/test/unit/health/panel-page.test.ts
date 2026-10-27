// Track AP (docs/panel.md "The page"): the page markup (41 inventory cells, a marker for every status
// block, no external URLs, under 120 KB) and the inline script run on a small fake DOM: the first
// render fills the cells and blocks from the embedded state, a poll updates only what changed, a
// failed poll shows the stale marker, a hidden tab polls every 10 s, the theme toggle survives a
// storage that throws.
import { describe, expect, it } from 'vitest';
import { HIDDEN_POLL_MS, PANEL_SCRIPT, POLL_MS } from '../../../src/health/panel/client.ts';
import { GLYPHS } from '../../../src/health/panel/glyphs.ts';
import { ICON_CLASSES } from '../../../src/health/panel/inventory.ts';
import { renderPanelPage, STATUS_BLOCKS } from '../../../src/health/panel/page.ts';
import { liteState, type PanelState } from '../../../src/health/panel/state.ts';
import { fullState } from './panel-fixtures.ts';

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

  it('a marker for every status block and every field the script writes', () => {
    const have = ids(html);
    for (const b of STATUS_BLOCKS) expect(have).toContain(b);
    const written = new Set([...PANEL_SCRIPT.matchAll(/text\('([a-z-]+)'/g), ...PANEL_SCRIPT.matchAll(/width\('([a-z-]+)'/g), ...PANEL_SCRIPT.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]!));
    expect(written.size).toBeGreaterThan(40);
    for (const id of written) expect([id, have.has(id)]).toEqual([id, true]);
    for (const m of ['id="panel-commands"', 'id="cmdform"', 'data-cmd="!home go"', 'id="panel-settings"', 'data-key="guardRadius"', 'id="panel-logs"', 'id="helpbox"', 'id="panel-map"', 'id="stale"', 'id="theme"', 'id="clock"', 'href="/api/chests"']) expect(html).toContain(m);
  });

  it('no external URLs, no external assets, under 120 KB', () => {
    expect(html.match(/https?:\/\//g)).toBeNull(); // the bot's own links are relative (/map, /api/chests)
    expect(html).not.toMatch(/<link\b|@import|url\(|\ssrc="(?!\/)/);
    const bytes = Buffer.byteLength(html);
    console.log(`panel page: ${bytes} bytes (script ${Buffer.byteLength(PANEL_SCRIPT)}, glyphs ${Buffer.byteLength(Object.values(GLYPHS).join(''))})`);
    expect(bytes).toBeLessThan(120_000);
  });

  it('the embedded state is the lite poll shape, with no closing script tag in it', () => {
    const m = /<script type="application\/json" id="initial">([^<]*)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual(JSON.parse(JSON.stringify(liteState(s))));
    const evil = renderPanelPage(fullState({ logs: () => ['</script><script>alert(1)</script>'] }));
    expect(evil).not.toContain('</script><script>alert(1)');
  });
});

// ---- a fake DOM: just what the script touches ----------------------------------------------------

class FakeClassList {
  readonly set = new Set<string>();
  toggle(c: string, on?: boolean): boolean {
    const want = on ?? !this.set.has(c);
    if (want) this.set.add(c);
    else this.set.delete(c);
    return want;
  }
  add(c: string): void {
    this.set.add(c);
  }
  remove(c: string): void {
    this.set.delete(c);
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
}

class FakeEl {
  textContent = '';
  className = '';
  hidden = false;
  title = '';
  value = '';
  open = false;
  src = '';
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  writes = 0;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  readonly listeners = new Map<string, (() => unknown)[]>();
  private readonly subs = new Map<string, FakeEl>();
  readonly id: string;
  constructor(id = '') {
    this.id = id;
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(t: string, fn: () => unknown): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  fire(t: string): unknown[] {
    return (this.listeners.get(t) ?? []).map((f) => f());
  }
  querySelector(sel: string): FakeEl {
    let e = this.subs.get(sel);
    if (!e) {
      e = new FakeEl();
      if (sel === '.dur') e.appendChild(new FakeEl());
      this.subs.set(sel, e);
    }
    return e;
  }
}

/** Counts writes of textContent per element (to see that an unchanged poll writes nothing). */
function counting(e: FakeEl): FakeEl {
  let t = '';
  Object.defineProperty(e, 'textContent', {
    get: () => t,
    set: (v: string) => {
      t = v;
      e.writes++;
    },
  });
  return e;
}

interface Harness {
  els: Map<string, FakeEl>;
  cells: Map<string, FakeEl>;
  timers: { fn: () => unknown; ms: number }[];
  doc: { hidden: boolean; body: FakeEl; documentElement: FakeEl; listeners: Map<string, (() => unknown)[]> };
  fetchQueue: (() => Promise<unknown>)[];
  fetched: string[];
  debug: string[];
  storage: Map<string, string>;
}

function runScript(html: string, opts: { storageThrows?: boolean; prefersLight?: boolean } = {}): Harness {
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    let e = els.get(id);
    if (!e) {
      e = counting(new FakeEl(id));
      els.set(id, e);
    }
    return e;
  };
  el('initial').textContent = /<script type="application\/json" id="initial">([^<]*)<\/script>/.exec(html)![1]!;
  const cells = new Map<string, FakeEl>();
  for (const m of html.matchAll(/data-slot="([^"]+)"/g)) {
    const c = new FakeEl();
    c.dataset.slot = m[1]!;
    cells.set(m[1]!, c);
  }
  const quick = [...html.matchAll(/data-cmd="([^"]+)"/g)].map((m) => {
    const b = new FakeEl();
    b.dataset.cmd = m[1]!;
    return b;
  });
  const h: Harness = {
    els,
    cells,
    timers: [],
    doc: { hidden: false, body: new FakeEl('body'), documentElement: new FakeEl('html'), listeners: new Map() },
    fetchQueue: [],
    fetched: [],
    debug: [],
    storage: new Map(),
  };
  const document = {
    getElementById: el,
    querySelectorAll: (sel: string) => (sel === '#inventory .cell' ? [...cells.values()] : sel === 'button.q' ? quick : []),
    querySelector: () => null,
    createElement: () => new FakeEl(),
    addEventListener: (t: string, fn: () => unknown) => h.doc.listeners.set(t, [...(h.doc.listeners.get(t) ?? []), fn]),
    get hidden() {
      return h.doc.hidden;
    },
    body: h.doc.body,
    documentElement: h.doc.documentElement,
    activeElement: null,
  };
  h.doc.documentElement.dataset.theme = opts.prefersLight ? 'light' : 'dark';
  const localStorage = {
    getItem: (k: string) => {
      if (opts.storageThrows) throw new Error('SecurityError');
      return h.storage.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.storageThrows) throw new Error('SecurityError');
      h.storage.set(k, v);
    },
  };
  const fetch = (url: string) => {
    h.fetched.push(url);
    const next = h.fetchQueue.shift();
    return next ? next() : Promise.reject(new Error('no answer queued'));
  };
  const setTimeout = (fn: () => unknown, ms: number) => h.timers.push({ fn, ms });
  const clearTimeout = () => undefined;
  const console = { debug: (m: string) => h.debug.push(m), log: () => undefined };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the page's own inline script, as the browser runs it
  const script = new Function('document', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout', 'console', 'location', PANEL_SCRIPT) as (...args: unknown[]) => void;
  script(document, localStorage, fetch, setTimeout, clearTimeout, console, { href: '/' });
  return h;
}

const answer = (s: unknown) => () => Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(s)), json: () => Promise.resolve(s) });

describe('panel page script (fake DOM)', () => {
  it('the first render fills the cells and the status blocks from the embedded state', () => {
    const s = fullState();
    const h = runScript(renderPanelPage(s));
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

  it('a poll writes only what changed; tapping a slot shows its details', async () => {
    const s = fullState();
    const h = runScript(renderPanelPage(s));
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
    const h = runScript(renderPanelPage(s));
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
    const h = runScript(html);
    expect(h.els.get('theme')!.textContent).toBe('light');
    h.els.get('theme')!.fire('click');
    expect(h.doc.documentElement.dataset.theme).toBe('light');
    expect(h.storage.get('bbpanel-theme')).toBe('light');
    expect(h.els.get('theme')!.textContent).toBe('dark');
    const blocked = runScript(html, { storageThrows: true, prefersLight: true });
    expect(blocked.els.get('theme')!.textContent).toBe('dark');
    expect(() => blocked.els.get('theme')!.fire('click')).not.toThrow();
    expect(blocked.doc.documentElement.dataset.theme).toBe('dark');
    expect(html).toContain("try{t=localStorage.getItem('bbpanel-theme')}catch(e){}");
  });

  it('render time with a full inventory (fake DOM; the browser logs its own in the console)', () => {
    const s = liteState(fullState()) as unknown as PanelState;
    const h = runScript(renderPanelPage(fullState()));
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
