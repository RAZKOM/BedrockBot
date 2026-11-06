// Track AP (docs/panel.md "Inventory"): the 41 cells the server rendered, each written only when its
// signature (item, count, colour, durability, box) changed; the item pictures (GET /icons/<name>.png,
// decision 0046) over the glyph once loaded, a 404 remembered per name; a tap or right-click opens the
// cell's menu (Track AR, menu.ts cellActions) and shows the details under the grid.
import { ICON_CLASSES, type PanelItem } from '../shared.ts';
import { nice, type El, type Ev } from './dom.ts';
import { cellActions } from './menu.ts';
import type { Lite, Page } from './page.ts';

const ICON_BASE = '/icons/';
const ARMOUR = ['head', 'chest', 'legs', 'feet'];
const ICONS = new Set<string>(ICON_CLASSES);

/** Where a cell key is, as the titles say it: `hotbar 1`, `inventory 12`, `head`, `offhand`. */
export const where = (k: string): string => (k === 'off' ? 'offhand' : k.startsWith('a') ? ARMOUR[Number(k.slice(1))]! : Number(k.slice(1)) < 9 ? `hotbar ${Number(k.slice(1)) + 1}` : `inventory ${k.slice(1)}`);

export function itemOf(s: Lite, k: string): PanelItem | null {
  const inv = s.inventory;
  if (!inv) return null;
  if (k === 'off') return inv.offhand;
  if (k.startsWith('a')) return inv.armour[Number(k.slice(1))] ?? null;
  return inv.slots[Number(k.slice(1))] ?? null;
}

const boxLine = (b: NonNullable<PanelItem['box']>): string =>
  !b.known ? 'contents unknown (moved since the server sent it)' : b.items.length === 0 ? 'empty' : `${b.items.map((x) => `${x[1]} ${nice(x[0])}`).join(', ')}${b.more ? `, +${b.more} more kinds` : ''} (${b.stacks}/27 slots)`;

export const itemLabel = (it: PanelItem): string =>
  `${nice(it.name)}${it.count > 1 ? ` x${it.count}` : ''}${it.dur ? `, durability ${it.dur.left}/${it.dur.max} (${it.dur.pct}%)` : ''}${it.box ? `, ${boxLine(it.box)}` : ''}`;

const durColour = (p: number): string => (p > 50 ? 'var(--ok)' : p > 20 ? 'var(--warn)' : 'var(--bad)');

/** A menu's anchor: the pointer, else under the element. */
export function anchor(ev: Ev | undefined, e: El | undefined): [number, number] {
  if (ev && (ev.clientX || ev.clientY)) return [ev.clientX ?? 0, ev.clientY ?? 0];
  const r = e?.getBoundingClientRect ? e.getBoundingClientRect() : { left: 8, bottom: 8 };
  return [r.left, r.bottom];
}

export function setupInventory(page: Page): (s: Lite) => void {
  const { ui } = page;
  const cells: Record<string, El> = {};
  for (const c of ui.doc.querySelectorAll('#inventory .cell')) cells[c.dataset.slot!] = c;
  const noPicture = new Set<string>();
  let pictures = false;
  let picked: string | null = null;

  function setPicture(cell: El, it: PanelItem | null): void {
    const img = cell.querySelector('img');
    if (!img || !it) return; // an empty cell hides its picture by CSS and keeps it for the next time
    if (!pictures || noPicture.has(it.name)) {
      if (img.dataset.n) {
        img.dataset.n = '';
        img.hidden = true;
        cell.classList.remove('tex');
      }
      return;
    }
    if (img.dataset.n === it.name) return;
    img.dataset.n = it.name;
    img.hidden = true;
    cell.classList.remove('tex');
    img.src = `${ICON_BASE}${it.name}.png`;
  }

  function setCell(cell: El, it: PanelItem | null, sel: boolean): void {
    const sig = it ? `${it.name}|${it.count}|${it.colour}|${it.dur ? it.dur.left : ''}|${it.box ? JSON.stringify(it.box) : ''}` : '';
    if (cell.dataset.sig !== sig) {
      cell.dataset.sig = sig;
      setPicture(cell, it);
      cell.querySelector('use')?.setAttribute('href', `#g-${it && ICONS.has(it.icon) ? it.icon : 'item'}`);
      cell.style.color = it ? it.colour : '';
      cell.classList.toggle('empty', !it);
      const ab = cell.querySelector('.ab');
      if (ab) ab.textContent = it ? it.abbr : '';
      const ct = cell.querySelector('.ct');
      if (ct) ct.textContent = it && it.count > 1 ? String(it.count) : '';
      const d = cell.querySelector('.dur');
      if (d) {
        d.hidden = !it?.dur;
        if (it?.dur && d.firstChild) {
          d.firstChild.style.width = `${it.dur.pct}%`;
          d.firstChild.style.background = durColour(it.dur.pct);
        }
      }
      cell.title = it ? itemLabel(it) : `${where(cell.dataset.slot!)}: empty`;
      cell.setAttribute('aria-label', cell.title);
    }
    if (cell.classList.contains('sel') !== sel) cell.classList.toggle('sel', sel);
  }

  function info(s: Lite): void {
    if (!ui.$('iteminfo')) return;
    if (picked === null) {
      ui.text('iteminfo', 'tap or right-click a slot: actions and details');
      return;
    }
    const it = itemOf(s, picked);
    const lines = [`${where(picked)}: ${it ? nice(it.name) : 'empty'}`];
    if (it) {
      lines.push(`count ${it.count}`);
      if (it.dur) lines.push(`durability ${it.dur.left} of ${it.dur.max} (${it.dur.pct}%)`);
      if (it.box) lines.push(`shulker box: ${boxLine(it.box)}`);
    }
    ui.text('iteminfo', lines.join('\n'));
  }

  function cellMenu(k: string, ev?: Ev): void {
    const it = itemOf(page.last, k);
    const p = anchor(ev, cells[k]);
    page.openMenu(`cell:${k}`, `${where(k)}: ${it ? itemLabel(it) : 'empty'}`, cellActions(k, it, page.last.inventory), p[0], p[1], () => {
      picked = k;
      info(page.last);
      ui.$('iteminfo')?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  for (const k in cells) {
    const cell = cells[k]!;
    const pic = cell.querySelector('img');
    if (pic) {
      pic.addEventListener('load', () => {
        if (pic.dataset.n) {
          pic.hidden = false;
          cell.classList.add('tex');
        }
      });
      pic.addEventListener('error', () => {
        if (pic.dataset.n) noPicture.add(pic.dataset.n);
        pic.dataset.n = '';
        pic.hidden = true;
        cell.classList.remove('tex');
      });
    }
    cell.addEventListener('click', (ev) => {
      if (picked !== null) cells[picked]?.classList.remove('picked');
      picked = picked === k ? null : k;
      if (picked !== null) cells[picked]?.classList.add('picked');
      info(page.last);
      if (picked === null) page.closeMenu();
      else cellMenu(k, ev);
    });
    cell.addEventListener('contextmenu', (ev) => {
      ev?.preventDefault?.();
      picked = k;
      info(page.last);
      cellMenu(k, ev);
    });
  }

  return (s) => {
    const inv = s.inventory;
    pictures = !!s.icons;
    for (const k in cells) setCell(cells[k]!, itemOf(s, k), !!inv && k.startsWith('s') && Number(k.slice(1)) === inv.selected);
    ui.text('inv-sum', inv ? `${36 - inv.free}/36 slots used, armour ${inv.armourPoints}/20${page.link.actions ? '' : ' (last known)'}` : 'no inventory (no world model)');
    info(s);
  };
}
