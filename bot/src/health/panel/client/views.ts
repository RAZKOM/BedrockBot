// The page's views (decisions 0062, 0065): the map, the cards and storage. One switch for all three: every
// element with `data-goview="<view>"` switches to it, the choice is kept in this browser (VIEW_KEY, try/catch
// storage), and a tiny script in <head> (page.ts VIEW_BOOT) applies it before the first paint. A view's
// module hears every switch through on() (the map joins its topics the first time it shows; storage too).
import { VIEW_KEY, VIEWS, type ViewName } from '../shared.ts';
import type { Page } from './page.ts';

export interface Views {
  show(v: ViewName): void;
  current(): ViewName;
  /** Called on every switch (and once by start() with the remembered view). */
  on(fn: (v: ViewName) => void): void;
  /** Show the remembered view (main.ts, after every view module registered). */
  start(): void;
}

export const viewOf = (s: string | null | undefined): ViewName => (VIEWS as readonly string[]).includes(s ?? '') ? (s as ViewName) : 'map';

export function setupViews(page: Page): Views {
  const { ui } = page;
  const root = ui.doc.documentElement;
  const fns: ((v: ViewName) => void)[] = [];
  let cur: ViewName = viewOf(root.dataset.view);
  const show = (v: ViewName): void => {
    cur = v;
    root.dataset.view = v; // the CSS shows one of the three
    ui.store.set(VIEW_KEY, v);
    for (const fn of fns) fn(v);
  };
  for (const b of ui.doc.querySelectorAll('[data-goview]')) b.addEventListener('click', () => show(viewOf(b.dataset.goview)));
  return {
    show,
    current: () => cur,
    on: (fn) => fns.push(fn),
    start: () => show(viewOf(ui.store.get(VIEW_KEY))),
  };
}
