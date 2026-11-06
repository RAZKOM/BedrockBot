// Track AR (docs/panel.md "Interaction"): the toast (a menu action's reply, wherever the page is
// scrolled) and the context menu: one floating list; destructive actions arm on the first tap and send
// on a second within CONFIRM_MS; a waypoint asks for its name inside the menu.
import { CONFIRM_MS } from '../shared.ts';
import type { El, Ev } from './dom.ts';
import { wpName, type MenuAction } from './menu.ts';
import type { Page } from './page.ts';

export function setupPopup(page: Page, onEscape: () => void): void {
  const { ui } = page;
  const root = ui.doc.documentElement;
  let toastT: unknown = 0;
  page.toast = (t) => {
    const e = ui.need('toast');
    e.textContent = t;
    e.hidden = false;
    ui.env.clearTimeout(toastT);
    toastT = ui.env.setTimeout(() => {
      e.hidden = true;
    }, 5000);
  };

  const menu = ui.need('menu');
  let key: string | null = null;
  let armed: El | null = null;
  let armT: unknown = 0;
  const closeMenu = (): void => {
    if (!menu.hidden) menu.hidden = true;
    key = null;
    armed = null;
  };
  const placeMenu = (x: number, y: number, n: number): void => {
    const W = root.clientWidth || 360;
    const H = root.clientHeight || 640;
    menu.style.left = `${Math.max(4, Math.min(x, W - 236))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, H - 44 * (n + 1) - 8))}px`;
  };
  const askName = (a: MenuAction): void => {
    const title = menu.firstChild ? (menu.firstChild.textContent ?? '') : '';
    ui.clear(menu);
    menu.appendChild(ui.el('div', 'mt', `${title}: ${a.prompt}`));
    const inp = ui.el('input');
    inp.type = 'text';
    inp.maxLength = 32;
    inp.setAttribute('aria-label', a.prompt ?? 'name');
    menu.appendChild(inp);
    const ok = ui.el('button', 'mi', 'Set waypoint');
    ok.type = 'button';
    menu.appendChild(ok);
    const go = (): void => {
      const n = wpName(inp.value);
      if (!n) {
        page.toast('a waypoint name is 1..32 of a-z 0-9 _ -');
        return;
      }
      closeMenu();
      void page.send(a.cmd!.replace('{name}', n), true);
    };
    ok.addEventListener('click', (ev) => {
      ev?.stopPropagation?.();
      go();
    });
    inp.addEventListener('keydown', (ev) => {
      if (ev?.key === 'Enter') go();
    });
    inp.focus?.();
  };
  const act = (a: MenuAction, b: El, local?: (a: MenuAction) => void): void => {
    if (!a.cmd) {
      closeMenu();
      local?.(a);
      return;
    }
    if (a.confirm && armed !== b) {
      armed = b;
      b.textContent = `tap again: ${a.label}`;
      b.classList.add('armed');
      ui.env.clearTimeout(armT);
      armT = ui.env.setTimeout(() => {
        if (armed === b) {
          armed = null;
          b.textContent = a.label;
          b.classList.remove('armed');
        }
      }, CONFIRM_MS);
      return;
    }
    if (a.prompt) {
      askName(a);
      return;
    }
    closeMenu();
    void page.send(a.cmd, true);
  };
  page.openMenu = (k, title, actions, x, y, local) => {
    ui.clear(menu);
    key = k;
    armed = null;
    menu.appendChild(ui.el('div', 'mt', title));
    // the bot is not in the game: only local actions (a box's contents); the rest come back when it spawns
    if (!page.link.actions) {
      const n = actions.length;
      actions = actions.filter((a) => !a.cmd);
      if (n > actions.length) menu.appendChild(ui.el('div', 'note', `${page.link.title || 'not in the game'}: actions come back when the bot has spawned`));
    } else if (!actions.length) menu.appendChild(ui.el('div', 'mt', 'no action for this'));
    for (const a of actions) {
      const b = ui.el('button', `mi${a.confirm ? ' danger' : ''}`, a.label);
      b.type = 'button';
      b.dataset.act = a.id;
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', (ev) => {
        ev?.stopPropagation?.();
        act(a, b, local);
      });
      menu.appendChild(b);
    }
    menu.hidden = false;
    placeMenu(x, y, actions.length);
  };
  page.closeMenu = closeMenu;
  page.menuKey = () => key;
  ui.doc.addEventListener('click', (ev?: Ev) => {
    const t = ev?.target;
    if (menu.hidden || !t || menu.contains?.(t) || t.closest?.('.cell, #mapcv')) return;
    closeMenu();
  });
  ui.doc.addEventListener('keydown', (ev?: Ev) => {
    if (ev?.key === 'Escape') {
      closeMenu();
      onEscape();
    }
  });
}
