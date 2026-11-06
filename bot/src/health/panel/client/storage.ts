// The storage view (decision 0065, docs/storage.md "The view"): the third view beside the map and the
// cards, phone first. A search box on top (results as you type from GET /api/storage/search: the item's
// icon, its total, then every place with its count, "in a shulker box", how long ago it was read; Bring...
// and Show on map), the base totals by category below it, a "never opened / stale" line with Read them
// now (`!chests scan`), and the recently changed list (the event store's container events). The `storage`
// topic (a snapshot, then deltas) keeps it current while the page streams; without the stream the view
// fetches GET /api/storage while it shows. Every action shows its exact command first (storedefs.ts).
import { STORAGE_PATH, STORAGE_SEARCH_PATH, STORAGE_TOPIC, type StoragePlace, type StorageSearchAnswer, type StorageSummary } from '../shared.ts';
import type { Bring } from './bring.ts';
import { applyDelta, type DeltaOp, type Json } from './delta.ts';
import { dur, nice, why, type El } from './dom.ts';
import type { Page } from './page.ts';
import { SCAN_COMMAND } from './storedefs.ts';
import type { Views } from './views.ts';

/** Typing: the search waits this long after the last key. */
export const SEARCH_DEBOUNCE_MS = 200;
/** Without the stream: GET /api/storage this often while the view shows. */
export const STORAGE_POLL_MS = 10_000;

const ago = (ts: number): string => `${dur(Math.max(0, Date.now() - ts) / 1000)} ago`;
const at = (p: { x: number | null; y: number | null; z: number | null }): string => `${p.x} ${p.y} ${p.z}`;
const DIM = ['', ' (nether)', ' (the end)'];

/** `30 in chest 100 64 -50 "ores"`, then the flags: `12 in a shulker box`, `read 3 min ago`, `4 blocks from home`. */
export function placeText(p: StoragePlace): { head: string; flags: string[] } {
  if (p.where === 'carried') return { head: `${p.count} carried by the bot`, flags: p.boxed ? [p.boxed === p.count ? 'in a shulker box' : `${p.boxed} in a shulker box`] : [] };
  const flags: string[] = [];
  if (p.boxed) flags.push(p.boxed === p.count ? 'in a shulker box' : `${p.boxed} in a shulker box`);
  if (p.readAt) flags.push(`read ${ago(p.readAt)}`);
  if (p.distHome !== null) flags.push(`${Math.round(p.distHome)} blocks from home`);
  if (p.unreachable) flags.push(`unreachable: ${p.unreachable}`);
  return { head: `${p.count} in ${nice(p.kind)} ${at(p)}${DIM[p.dim ?? 0] ?? ''}${p.label ? ` "${p.label}"` : ''}`, flags };
}

export interface StorageView {
  /** Fetch the summary once when none came yet (the map's Bring... needs `me`). */
  prime(): void;
}

export function setupStorage(page: Page, views: Views, bring: Bring, focus: (x: number, y: number, z: number, dim: number) => void, onSummary?: (s: StorageSummary) => void): StorageView {
  const { ui } = page;
  const env = ui.env;
  const el = (id: string): El => ui.need(id);
  const qIn = el('st-q');
  const results = el('st-results');
  const confirm = el('st-confirm');
  let sum: StorageSummary | null = null;
  let shown = false;
  let joined = false;
  let searchT: unknown = 0;
  let pollT: unknown = 0;
  let asked = '';
  let lastRev = 0;
  let pending: string | null = null;

  const get = async <T>(url: string): Promise<T> => {
    const r = await env.fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${url.split('?')[0]} ${r.status}`);
    return (await r.json()) as T;
  };

  // ---- confirm before Send (the scan; the Bring picker has its own)
  function choose(cmd: string): void {
    pending = cmd;
    confirm.hidden = false;
    ui.text('st-cmd', cmd);
    el('st-send').disabled = !page.link.actions;
  }
  el('st-cancel').addEventListener('click', () => {
    confirm.hidden = true;
    pending = null;
  });
  el('st-send').addEventListener('click', () => {
    const c = pending;
    if (!c) return;
    confirm.hidden = true;
    pending = null;
    ui.text('st-reply', `> ${c}\n...`);
    void page.send(c, true).then((out) => ui.text('st-reply', `> ${c}\n${out}`));
  });
  el('st-scan').addEventListener('click', () => choose(SCAN_COMMAND));

  // ---- search as you type
  function search(now = false): void {
    env.clearTimeout(searchT);
    searchT = 0;
    const q = qIn.value.trim();
    if (!q) {
      asked = '';
      ui.clear(results);
      return;
    }
    if (!now) {
      searchT = env.setTimeout(() => search(true), SEARCH_DEBOUNCE_MS);
      return;
    }
    asked = q;
    void get<StorageSearchAnswer>(`${STORAGE_SEARCH_PATH}?q=${encodeURIComponent(q)}`).then(
      (a) => {
        if (asked === q) renderResults(a);
      },
      (e: unknown) => env.console.debug(`panel: storage search: ${why(e)}`),
    );
  }
  qIn.addEventListener('input', () => search());

  function icon(name: string): El | null {
    if (!page.last.icons) return null;
    const img = ui.el('img', 'ic');
    img.setAttribute('alt', '');
    img.addEventListener('error', () => {
      img.hidden = true;
    });
    img.src = `/icons/${name}.png`;
    return img;
  }
  function button(label: string, fn: () => void, cls = 'small'): El {
    const b = ui.el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function renderResults(a: StorageSearchAnswer): void {
    ui.clear(results);
    if (a.group) results.appendChild(ui.el('div', 'muted small', `${nice(a.group.id)}: ${a.group.total} in all, ${a.group.kinds} kinds`));
    if (a.none) results.appendChild(ui.el('div', 'muted', `no ${nice(a.none)} in the ${a.containers} containers I know (!get ${a.none} makes new ones)`));
    if (!a.results.length && !a.none) results.appendChild(ui.el('div', 'muted', `nothing matches "${a.q}"`));
    for (const r of a.results) {
      const card = ui.el('div', 'st-item');
      card.dataset.item = r.name;
      const head = ui.el('div', 'st-head');
      const img = icon(r.name);
      if (img) head.appendChild(img);
      head.appendChild(ui.el('b', '', nice(r.name)));
      head.appendChild(ui.el('span', 'st-total', `${r.total}${r.carried ? ` (${r.carried} carried)` : ''}`));
      const stored = r.total - r.carried;
      if (stored > 0) head.appendChild(button('Bring...', () => bring.open({ items: [{ name: r.name, total: stored, stack: r.stack }] }), 'small primary'));
      card.appendChild(head);
      for (const p of r.where) {
        const t = placeText(p);
        const line = ui.el('div', 'st-place');
        line.appendChild(ui.el('span', '', t.head));
        if (t.flags.length) line.appendChild(ui.el('span', 'muted', ` · ${t.flags.join(' · ')}`));
        if (p.where === 'chest') line.appendChild(button('Map', () => showOnMap(p)));
        card.appendChild(line);
      }
      if (r.morePlaces) card.appendChild(ui.el('div', 'muted small', `and ${r.morePlaces} more places`));
      for (const c of a.recent[r.name] ?? []) card.appendChild(ui.el('div', 'muted small', `${c.kind === 'deposit' ? '+' : '-'}${c.n} ${c.kind === 'deposit' ? 'put into' : 'taken from'} ${nice(c.block ?? 'container')} ${c.at.join(' ')}, ${ago(c.ts)}`));
      results.appendChild(card);
    }
    if (a.more) results.appendChild(ui.el('div', 'muted small', `${a.more} more items match: type more`));
  }

  function showOnMap(p: StoragePlace): void {
    if (p.x === null || p.y === null || p.z === null) return;
    views.show('map');
    focus(p.x, p.y, p.z, p.dim ?? 0);
  }

  // ---- the summary: totals by category, freshness, recent changes
  function renderSummary(s: StorageSummary): void {
    const c = s.containers;
    ui.text('st-fresh', c.known ? `${c.known} containers: ${c.read} read, ${c.never} never opened, ${c.stale} stale (read over ${Math.round(s.staleMs / 3_600_000)} h ago)${c.unreachable ? `, ${c.unreachable} unreachable` : ''}; ${c.used}/${c.size} slots used; carrying ${s.totals.carried} items` : 'no container remembered yet: Read them now walks to the containers near home');
    el('st-scan').hidden = c.known > 0 && c.never + c.stale === 0;
    const cats = el('st-cats');
    ui.clear(cats);
    for (const k of s.categories) {
      const b = button(`${nice(k.id)} ${k.total}`, () => {
        qIn.value = k.id;
        search(true);
      }, 'st-cat');
      b.appendChild(ui.el('span', 'muted small', ` ${k.kinds} kinds: ${k.top.map(([n, v]) => `${v} ${nice(n)}`).join(', ')}`));
      cats.appendChild(b);
    }
    if (!s.categories.length) cats.appendChild(ui.el('div', 'muted small', 'nothing stored that I know of'));
    const rec = el('st-recent');
    ui.clear(rec);
    for (const r of s.recent) rec.appendChild(ui.el('div', 'small', `${ago(r.ts)}: ${r.kind === 'deposit' ? 'put' : 'took'} ${r.items.map(([n, v]) => `${v} ${nice(n)}`).join(', ')} ${r.kind === 'deposit' ? 'into' : 'from'} ${nice(r.block ?? 'container')} ${r.at.join(' ')}`));
    if (!s.recent.length) rec.appendChild(ui.el('div', 'muted small', 'no deposits or withdrawals recorded yet'));
  }
  function take(s: StorageSummary): void {
    sum = s;
    onSummary?.(s);
    if (shown) renderSummary(s);
    if (s.rev !== lastRev) {
      lastRev = s.rev;
      if (asked && shown) search(); // what the results show may have changed
    }
  }
  const refresh = (): void => {
    void get<StorageSummary>(STORAGE_PATH).then(take, (e: unknown) => env.console.debug(`panel: storage: ${why(e)}`));
  };
  /** Without the stream: the summary every STORAGE_POLL_MS while the view shows. */
  const poll = (): void => {
    env.clearTimeout(pollT);
    pollT = 0;
    if (!shown) return;
    if (!page.streaming()) refresh();
    pollT = env.setTimeout(poll, STORAGE_POLL_MS);
  };

  views.on((v) => {
    shown = v === 'storage';
    if (!shown) return;
    if (!joined) {
      joined = true;
      page.listen(STORAGE_TOPIC, (data) => {
        const m = JSON.parse(data) as { snap?: StorageSummary; d?: DeltaOp[] };
        if (m.snap) take(m.snap);
        else if (m.d && sum) take(applyDelta(sum as unknown as Json, m.d) as unknown as StorageSummary);
      });
    }
    if (sum) renderSummary(sum);
    poll();
  });

  return {
    prime: () => {
      if (!sum) refresh();
    },
  };
}
