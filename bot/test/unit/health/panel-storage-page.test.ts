// Decision 0065 (docs/storage.md "The view"): the storage view on the fake DOM of panel-dom.ts. The third
// view beside the map and the cards (one switch, the choice remembered), the storage topic on the stream,
// search as you type (places, "in a shulker box", read ago), Bring... (the picks, the exact `!bring`
// command, one Send, the reply, who "me" is), Show on map (the map centred, follow off), the scan's
// confirm, the poll without a stream, and the map chest sheet's Bring... entry.
import { describe, expect, it } from 'vitest';
import { STORAGE_POLL_MS, SEARCH_DEBOUNCE_MS } from '../../../src/health/panel/client/storage.ts';
import { bringCommand, bringPicks, bringTarget, BRING_MAX } from '../../../src/health/panel/client/storedefs.ts';
import { STORAGE_PATH, VIEW_KEY, type StorageSearchAnswer, type StorageSummary } from '../../../src/health/panel/shared.ts';
import { renderPanelPage } from '../../../src/health/panel/page.ts';
import { answer, flush, runPage, type FakeEl, type Harness } from './panel-dom.ts';
import { fullState } from './panel-fixtures.ts';

const ok = (replies: string[]) => answer({ ok: true, command: '', replies });

const summary = (over: Partial<StorageSummary> = {}): StorageSummary => ({
  rev: 3,
  staleMs: 86_400_000,
  me: 'Owner',
  containers: { known: 4, read: 3, never: 1, stale: 1, unreachable: 0, oldestReadAt: 1, newestReadAt: 2, dims: { 0: 4 }, used: 20, size: 108 },
  totals: { items: 400, kinds: 6, carried: 2 },
  categories: [
    { id: 'ores', total: 71, kinds: 2, top: [['diamond', 69], ['coal', 2]] },
    { id: 'wood', total: 20, kinds: 1, top: [['oak_log', 20]] },
  ],
  fullest: [],
  recent: [{ id: 9, ts: Date.now() - 30_000, kind: 'deposit', at: [100, 64, -50], block: 'chest', items: [['diamond', 4]] }],
  ...over,
});

const place = (x: number, count: number, boxed: number) => ({ where: 'chest' as const, key: `0:${x},64,-50`, dim: 0, x, y: 64, z: -50, kind: 'chest', label: x === 100 ? 'ores' : null, count, loose: count - boxed, boxed, readAt: Date.now() - 120_000, distHome: 12, distBot: 4, unreachable: null });
const diamonds = (): StorageSearchAnswer => ({
  q: 'diamonds',
  group: null,
  results: [{ name: 'diamond', category: 'ores', stack: 64, score: 100, total: 71, loose: 5, boxed: 64, carried: 2, where: [{ where: 'carried', key: null, dim: null, x: null, y: null, z: null, kind: 'inventory', label: null, count: 2, loose: 2, boxed: 0, readAt: null, distHome: null, distBot: 0, unreachable: null }, place(104, 64, 64), place(100, 5, 0)], morePlaces: 0 }],
  more: 0,
  none: null,
  containers: 4,
  recent: { diamond: [{ ts: Date.now() - 30_000, kind: 'deposit', n: 4, at: [100, 64, -50], block: 'chest' }] },
});

const openStorage = (opts: { stream?: boolean; answers?: (() => Promise<unknown>)[] } = {}): Harness =>
  runPage(renderPanelPage(fullState()), { stream: opts.stream ?? true, storage: { [VIEW_KEY]: 'storage' }, ...(opts.answers ? { answers: opts.answers } : {}) });

const texts = (e: FakeEl): string[] => e.children.map((c) => c.textContent);
const deep = (e: FakeEl): string => [e.textContent, ...e.children.map(deep)].join(' ');
const buttonsIn = (e: FakeEl): FakeEl[] => [...(e.tagName === 'BUTTON' || e.type === 'button' ? [e] : []), ...e.children.flatMap(buttonsIn)];
const button = (e: FakeEl, label: string): FakeEl => buttonsIn(e).find((b) => b.textContent === label)!;

/** Type a query and run the debounced search with `a` as the answer. */
async function search(h: Harness, q: string, a: unknown): Promise<void> {
  h.els.get('st-q')!.value = q;
  h.els.get('st-q')!.fire('input');
  const t = h.timers.filter((x) => x.ms === SEARCH_DEBOUNCE_MS).at(-1)!;
  h.fetchQueue.push(answer(a));
  t.fn();
  await flush();
}

describe('storage view (decision 0065, fake DOM)', () => {
  it('opens on the remembered view, joins the storage topic, renders the summary; the switch goes to the map and the cards', () => {
    const h = openStorage();
    expect(h.doc.documentElement.dataset.view).toBe('storage');
    expect(h.streams[0]!.url).toBe('/api/stream?topics=state,storage');
    h.streams[0]!.emit('storage', { snap: summary() }, 'b.1');
    expect(h.els.get('st-fresh')!.textContent).toBe('4 containers: 3 read, 1 never opened, 1 stale (read over 24 h ago); 20/108 slots used; carrying 2 items');
    expect(h.els.get('st-scan')!.hidden).toBe(false);
    expect(texts(h.els.get('st-cats')!)).toEqual(['ores 71', 'wood 20']);
    expect(deep(h.els.get('st-cats')!)).toContain('69 diamond');
    expect(deep(h.els.get('st-recent')!)).toMatch(/30 s ago: put 4 diamond into chest 100 64 -50/);
    // a delta updates it
    h.streams[0]!.emit('storage', { d: [['s', ['containers', 'stale'], 0], ['s', ['containers', 'never'], 0]] }, 'b.2');
    expect(h.els.get('st-scan')!.hidden).toBe(true);
    h.els.get('st-map')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('map');
    expect(h.storage.get(VIEW_KEY)).toBe('map');
    h.els.get('st-cards')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('cards');
    h.els.get('view-storage')!.fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('storage');
    expect(h.storage.get(VIEW_KEY)).toBe('storage');
  });

  it('search as you type: the item, its total, every place with its count, the box flag, read ago, its last changes', async () => {
    const h = openStorage();
    await search(h, 'diamonds', diamonds());
    expect(h.fetched.at(-1)).toBe('/api/storage/search?q=diamonds');
    const card = h.els.get('st-results')!.children[0]!;
    expect(card.dataset.item).toBe('diamond');
    const lines = deep(card);
    expect(lines).toContain('71 (2 carried)');
    expect(lines).toContain('2 carried by the bot');
    expect(lines).toContain('64 in chest 104 64 -50');
    expect(lines).toMatch(/in a shulker box · read 2 min ago · 12 blocks from home/);
    expect(lines).toContain('5 in chest 100 64 -50 "ores"');
    expect(lines).toMatch(/\+4 put into chest 100 64 -50, 30 s ago/);
    // nothing typed: no results, no fetch
    const n = h.fetched.length;
    h.els.get('st-q')!.value = '';
    h.els.get('st-q')!.fire('input');
    expect(h.els.get('st-results')!.children.length).toBe(0);
    expect(h.fetched.length).toBe(n);
  });

  it('none and nothing: the page says so', async () => {
    const h = openStorage();
    await search(h, 'emerald', { q: 'emerald', group: null, results: [], more: 0, none: 'emerald', containers: 4, recent: {} });
    expect(texts(h.els.get('st-results')!)).toEqual(['no emerald in the 4 containers I know (!get emerald makes new ones)']);
    await search(h, 'zzz', { q: 'zzz', group: null, results: [], more: 0, none: null, containers: 4, recent: {} });
    expect(texts(h.els.get('st-results')!)).toEqual(['nothing matches "zzz"']);
  });

  it('Bring...: the picks, the exact command (to me, or home), one Send posts it and shows the reply; who "me" is', async () => {
    const h = openStorage();
    h.streams[0]!.emit('storage', { snap: summary() }, 'b.1');
    h.streams[0]!.emit('state', h.started.page.last, 'b.0'); // online: actions on
    await search(h, 'diamonds', diamonds());
    button(h.els.get('st-results')!, 'Bring...').fire('click');
    expect(h.els.get('bring')!.hidden).toBe(false);
    expect(h.els.get('bring-title')!.textContent).toBe('Bring diamond (69 known)');
    expect(texts(h.els.get('bring-picks')!)).toEqual(['1', '16', '64', 'all (69)']);
    expect(h.els.get('bring-me-l')!.textContent).toBe('to Owner');
    expect(h.els.get('bring-note')!.textContent).toMatch(/!bring takes from the chests its planner picks/);
    expect(h.els.get('bring-cmd')!.textContent).toBe('!bring diamond 64');
    button(h.els.get('bring-picks')!, '1').fire('click');
    expect(h.els.get('bring-cmd')!.textContent).toBe('!bring diamond 1');
    h.els.get('bring-n')!.value = '2';
    h.els.get('bring-n')!.fire('input');
    expect(h.els.get('bring-cmd')!.textContent).toBe('!bring diamond 2');
    h.els.get('bring-me')!.checked = false;
    h.els.get('bring-home')!.checked = true;
    h.els.get('bring-home')!.fire('change');
    expect(h.els.get('bring-cmd')!.textContent).toBe('!bring diamond 2 home');
    expect(h.posted).toEqual([]); // nothing sent before Send
    h.fetchQueue.push(ok(['bring: 2 diamond, home']));
    h.els.get('bring-send')!.fire('click');
    await flush();
    expect(h.posted).toEqual(['!bring diamond 2 home']);
    expect(h.els.get('bring-reply')!.textContent).toBe('> !bring diamond 2 home\nbring: 2 diamond, home');
    h.els.get('bring-close')!.fire('click');
    expect(h.els.get('bring')!.hidden).toBe(true);
  });

  it('Show on map: the map shows, centred on the container, follow off; Read them now confirms before Send', async () => {
    const h = openStorage();
    h.streams[0]!.emit('storage', { snap: summary() }, 'b.1');
    await search(h, 'diamonds', diamonds());
    const line = h.els.get('st-results')!.children[0]!.children.find((c) => deep(c).includes('chest 104'))!;
    button(line, 'Map').fire('click');
    expect(h.doc.documentElement.dataset.view).toBe('map');
    expect(h.els.get('map-follow')!.classList.contains('on')).toBe(false);
    h.els.get('st-cards')!.fire('click');
    h.els.get('view-storage')!.fire('click');
    h.els.get('st-scan')!.fire('click');
    expect(h.els.get('st-confirm')!.hidden).toBe(false);
    expect(h.els.get('st-cmd')!.textContent).toBe('!chests scan');
    expect(h.posted).toEqual([]);
    h.fetchQueue.push(ok(['chests: scanning 1 container']));
    h.els.get('st-send')!.fire('click');
    await flush();
    expect(h.posted).toEqual(['!chests scan']);
    expect(h.els.get('st-reply')!.textContent).toBe('> !chests scan\nchests: scanning 1 container');
  });

  it('without the stream: GET /api/storage while the view shows, every STORAGE_POLL_MS', async () => {
    const h = openStorage({ stream: false, answers: [answer(summary())] });
    await flush();
    expect(h.fetched).toContain(STORAGE_PATH);
    expect(h.els.get('st-fresh')!.textContent).toMatch(/^4 containers/);
    const t = h.timers.filter((x) => x.ms === STORAGE_POLL_MS);
    expect(t.length).toBe(1);
  });

  it('the action helpers: picks, commands, the target', () => {
    expect(bringPicks(69, 64).map((p) => p.n)).toEqual([1, 16, 64, 69]);
    expect(bringPicks(5, 16).map((p) => p.label)).toEqual(['1', 'all (5)']);
    expect(bringPicks(9000, 16).at(-1)).toEqual({ label: `all (${BRING_MAX})`, n: BRING_MAX });
    expect(bringPicks(40, 1).map((p) => p.n)).toEqual([1, 16, 40]);
    expect(bringCommand('diamond', 0, false)).toBe('!bring diamond 1');
    expect(bringCommand('diamond', 99999, true)).toBe(`!bring diamond ${BRING_MAX} home`);
    expect(bringTarget(null).me).toBe('to me (home)');
  });
});

describe('the map chest sheet: Bring... (decision 0065, fake DOM)', () => {
  const b64 = (b: Buffer): string => b.toString('base64');
  const tilesAnswer = {
    ts: 0, dim: 0, rev: 5, center: { cx: 1144, cz: 1064 }, radius: 4, window: { cx0: 1140, cz0: 1060, cx1: 1148, cz1: 1068 },
    tiles: [{ cx: 1144, cz: 1064, live: true, rev: 5, updatedAt: 0, y: b64(Buffer.from(new Int16Array(256).fill(-61).buffer)), c: b64(Buffer.alloc(64, 0b01010101)), s: b64(Buffer.alloc(256, 0)), p: [0] }],
    palFrom: 0, palette: [{ name: 'grass_block', rgb: '#5f9f35' }],
  };
  const marks = { chests: [{ x: 18313, y: -60, z: 17030, kind: 'chest', label: 'ores', unreachable: false, stacks: 2, size: 27, top: [['coal', 12]], readAt: Date.now() - 60_000 }], herds: [], blocks: {} };

  it('a remembered chest offers Bring...; it opens the picker with what that chest holds', async () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true, storage: { [VIEW_KEY]: 'map' }, answers: [answer(tilesAnswer), answer(marks)] });
    await flush();
    const cv = h.els.get('mapcv')!;
    cv.fireWith('pointerdown', { pointerId: 1, clientX: 186, clientY: 329, button: 0 });
    cv.fireWith('pointerup', { pointerId: 1, clientX: 186, clientY: 329, button: 0 });
    const b = h.els.get('sheet-acts')!.children.find((c) => c.dataset.act === 'bring')!;
    expect(b.textContent).toBe('Bring...');
    h.fetchQueue.push(answer(summary({ me: null })));
    b.fire('click');
    expect(h.els.get('bring')!.hidden).toBe(false);
    expect(h.els.get('bring-title')!.textContent).toBe('Bring coal (12 known)');
    expect(h.els.get('bring-cmd')!.textContent).toBe('!bring coal 12');
    await flush();
    expect(h.fetched.at(-1)).toBe(STORAGE_PATH); // "to me" needs the summary's me
    expect(h.els.get('bring-me-l')!.textContent).toBe('to me (home)');
    expect(h.els.get('bring-note')!.textContent).toMatch(/^From chest 18313 -60 17030: the panel runs as the console/);
  });
});
