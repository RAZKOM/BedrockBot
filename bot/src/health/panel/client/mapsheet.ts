// The map screen's sheet (decision 0062, docs/map.md "Actions"): what the owner tapped (a block: its
// name, height, when it was seen, what is there; a box: its corners, y range and size) and the actions
// that apply (mapdefs.ts). An action never sends on its own: it shows the exact `!command` (and the box
// size) with a Send button, and only Send posts it (POST /api/cmd, page.send), so one confirm tap. The
// reply shows in the sheet and as the toast. A waypoint asks its name first.
import type { El } from './dom.ts';
import { nice } from './dom.ts';
import { boxActions, boxSize, orderedBox, pointActions, type MapBox, type PointContext } from './mapdefs.ts';
import { wpName, type MenuAction } from './menu.ts';
import type { Page } from './page.ts';

export interface PointInfo {
  title: string;
  lines: string[];
  ctx: PointContext;
}

export interface Sheet {
  openPoint(p: PointInfo): void;
  /** A box (corners from the drag); y defaults to the surface range `surf` [low, high]. */
  openBox(b: MapBox, surf: [number, number] | null): void;
  /** The box's corners moved (a handle drag): keep the y range and the picked block. */
  moveBox(b: MapBox): void;
  box(): MapBox | null;
  close(): void;
  isOpen(): boolean;
}

export function setupSheet(page: Page, onClose: () => void): Sheet {
  const { ui } = page;
  const el = (id: string): El => ui.need(id);
  const sheet = el('map-sheet');
  const acts = el('sheet-acts');
  const confirm = el('sheet-confirm');
  const nameIn = el('sheet-name');
  const cmdEl = el('sheet-cmd');
  const send = el('sheet-send');
  const reply = el('sheet-reply');
  const boxRow = el('sheet-box');
  const y1 = el('box-y1');
  const y2 = el('box-y2');
  const pick = el('box-block');
  let box: MapBox | null = null;
  let pending: { a: MenuAction; size: string } | null = null;

  const hideConfirm = (): void => {
    confirm.hidden = true;
    nameIn.hidden = true;
    pending = null;
  };
  const resolved = (): string | null => {
    if (!pending) return null;
    const c = pending.a.cmd ?? '';
    if (!pending.a.prompt) return c;
    const n = wpName(nameIn.value);
    return n ? c.replace('{name}', n) : null;
  };
  const showCmd = (): void => {
    const c = resolved();
    const text = c ?? (pending?.a.cmd ?? '').replace('{name}', '<name>');
    cmdEl.textContent = pending?.size ? `${text}\n${pending.size}` : text;
    send.disabled = c === null;
  };
  function choose(a: MenuAction, size: string): void {
    pending = { a, size };
    confirm.hidden = false;
    nameIn.hidden = !a.prompt;
    if (a.prompt) {
      nameIn.value = '';
      nameIn.setAttribute('placeholder', a.prompt);
      nameIn.focus?.();
    }
    send.className = a.confirm ? 'danger' : 'primary';
    send.textContent = a.confirm ? `Send (${a.label.toLowerCase()})` : 'Send';
    showCmd();
  }
  function buttons(list: MenuAction[], size: string): void {
    ui.clear(acts);
    for (const a of list) {
      const b = ui.el('button', `act${a.confirm ? ' danger' : ''}`, a.label);
      b.type = 'button';
      b.dataset.act = a.id;
      b.addEventListener('click', () => choose(a, size));
      acts.appendChild(b);
    }
    if (!list.length) acts.appendChild(ui.el('span', 'muted small', 'nothing to do here'));
  }
  nameIn.addEventListener('input', showCmd);
  send.addEventListener('click', () => {
    const c = resolved();
    if (!c) return;
    reply.textContent = `> ${c}\n...`;
    hideConfirm();
    void page.send(c, true).then((out) => {
      reply.textContent = `> ${c}\n${out}`;
    });
  });
  el('sheet-cancel').addEventListener('click', hideConfirm);
  el('sheet-close').addEventListener('click', () => {
    close();
  });

  /** The blocks the bot carries (the picker): `cobblestone (64)`. */
  function fillPicker(): void {
    const keep = pick.value;
    const counts = new Map<string, number>();
    for (const s of page.last.inventory?.slots ?? []) if (s?.icon === 'block') counts.set(s.name, (counts.get(s.name) ?? 0) + s.count);
    ui.clear(pick);
    const none = ui.el('option', '', counts.size ? 'pick a block' : 'no blocks carried');
    none.value = '';
    pick.appendChild(none);
    for (const [n, k] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const o = ui.el('option', '', `${nice(n)} (${k})`);
      o.value = n;
      pick.appendChild(o);
    }
    if (keep && counts.has(keep)) pick.value = keep;
  }
  function boxNow(): MapBox | null {
    if (!box) return null;
    const a = Math.floor(Number(y1.value));
    const b = Math.floor(Number(y2.value));
    return { ...box, y1: Number.isFinite(a) ? a : box.y1, y2: Number.isFinite(b) ? b : box.y2 };
  }
  function renderBox(): void {
    const b = boxNow();
    if (!b) return;
    const o = orderedBox(b);
    const size = boxSize(o);
    ui.text('sheet-title', `box ${o.x1} ${o.z1} to ${o.x2} ${o.z2}`);
    ui.text('box-size', size.text);
    hideConfirm();
    buttons(boxActions(b, { block: pick.value || null }), size.text);
  }
  for (const e of [y1, y2]) e.addEventListener('change', renderBox);
  pick.addEventListener('change', renderBox);

  function open(): void {
    sheet.hidden = false;
    reply.textContent = '';
  }
  function close(): void {
    if (sheet.hidden) return;
    sheet.hidden = true;
    hideConfirm();
    box = null;
    onClose();
  }

  return {
    openPoint(p) {
      box = null;
      boxRow.hidden = true;
      open();
      ui.text('sheet-title', p.title);
      const body = el('sheet-body');
      ui.clear(body);
      for (const l of p.lines) body.appendChild(ui.el('div', '', l));
      hideConfirm();
      buttons(page.link.actions ? pointActions(p.ctx) : [], '');
      if (!page.link.actions) acts.appendChild(ui.el('div', 'note', `${page.link.title}: actions come back when the bot has spawned`));
    },
    openBox(b, surf) {
      box = b;
      boxRow.hidden = false;
      open();
      const lo = surf ? surf[0] : b.y1;
      const hi = surf ? surf[1] : b.y2;
      y1.value = String(lo);
      y2.value = String(hi);
      ui.clear(el('sheet-body'));
      el('sheet-body').appendChild(ui.el('div', '', surf ? `surface ${surf[0]}${surf[1] !== surf[0] ? ` to ${surf[1]}` : ''}; set the y range, drag a corner to change the box` : 'set the y range; drag a corner to change the box'));
      fillPicker();
      renderBox();
    },
    moveBox(b) {
      if (!box) return;
      box = { ...b, y1: box.y1, y2: box.y2 };
      renderBox();
    },
    box: () => boxNow(),
    close,
    isOpen: () => !sheet.hidden,
  };
}
