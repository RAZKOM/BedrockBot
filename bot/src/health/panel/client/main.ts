// The page's entry (docs/panel.md "The page", decision 0061): start(env) wires every card to one Page
// and renders the state the server embedded at once, then the transport (stream, else polling) keeps
// it current. boot.ts calls it with the browser; the unit tests call it with a fake DOM. Each card is a
// module with a setup returning its render; a new card is one more module and one more line here.
import { THEME_KEY } from '../shared.ts';
import { dur, makeUi, type Env } from './dom.ts';
import { setupCards } from './cards.ts';
import { setupCommands } from './commands.ts';
import { setupInventory } from './inventory.ts';
import { setupLink } from './link.ts';
import { setupLogs } from './logs.ts';
import { setupMapView } from './mapview.ts';
import { linkView } from './menu.ts';
import type { Lite, Page } from './page.ts';
import { setupPopup } from './popup.ts';
import { setupSettings } from './settings.ts';
import { setupTables } from './tables.ts';
import { setupTransport, type Transport } from './transport.ts';

/** What start() hands back (the tests look at the transport). */
export interface Started {
  page: Page;
  transport: Transport;
}

export function start(env: Env): Started {
  const ui = makeUi(env);
  const initial = ui.need('initial').textContent ?? '{}';
  const last = JSON.parse(initial) as Lite;
  const unset = (): never => {
    throw new Error('panel: not wired yet');
  };
  const listeners: [string, (data: string, id: string) => void][] = [];
  const page: Page = {
    ui,
    last,
    link: linkView(last.link, Date.now(), null),
    send: unset,
    toast: unset,
    openMenu: unset,
    closeMenu: unset,
    menuKey: () => null,
    applyLink: unset,
    refreshSoon: () => undefined,
    listen: (topic, fn) => listeners.push([topic, fn]), // handed to the transport once it exists (below)
    streaming: () => !!env.EventSource, // until the transport exists (below): a browser with EventSource streams
  };

  // ---- theme (dark by default; prefers-color-scheme; a stored choice wins: page.ts sets it before the first paint)
  const root = ui.doc.documentElement;
  const themeBtn = ui.$('theme');
  const showTheme = (): void => {
    if (themeBtn) themeBtn.textContent = root.dataset.theme === 'light' ? 'dark' : 'light';
  };
  themeBtn?.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    ui.store.set(THEME_KEY, root.dataset.theme);
    showTheme();
  });
  showTheme();

  const commands = setupCommands(page); // binds page.send; the toast and the menu come next
  setupPopup(page, () => commands.hidePalette());
  page.applyLink = setupLink(page);
  const renderInventory = setupInventory(page);
  const renderCards = setupCards(page);
  const renderLogs = setupLogs(page);
  const renderSettings = setupSettings(page);
  const renderMap = setupMapView(page); // decision 0062: the map screen
  setupTables(page, (cmds) => commands.setHelp(cmds));

  function render(s: Lite): void {
    page.last = s;
    page.applyLink(linkView(s.link, Date.now(), null));
    renderInventory(s);
    renderCards(s);
    renderLogs(s);
    renderSettings(s);
    renderMap(s);
  }
  let renders = 0;
  const timed = (s: Lite, bytes: number, via: string): void => {
    const t0 = env.performance.now();
    render(s);
    const ms = env.performance.now() - t0;
    if (renders++ % 30 === 0) env.console.debug(`panel: render ${ms.toFixed(2)} ms, state ${bytes} bytes${via ? ` (${via})` : ''}`);
  };

  // ---- stale: the last state is old (a failed poll or a dropped stream), until the next one
  let lastOk = Date.now();
  let downSince: number | null = null;
  const stale = (on: boolean, why: string): void => {
    const e = ui.$('stale');
    if (e) {
      e.hidden = !on;
      if (on) e.textContent = `stale ${dur((Date.now() - lastOk) / 1000)}`;
    }
    const body = ui.doc.body;
    if (body.classList.contains('is-stale') !== on) body.classList.toggle('is-stale', on);
    ui.text('err', on ? why : '');
  };
  const transport = setupTransport(page, {
    state: (s, bytes, via) => timed(s, bytes, via === 'poll' ? '' : `stream ${via}`),
    ok: () => {
      lastOk = Date.now();
      downSince = null;
      stale(false, '');
    },
    fail: (why) => {
      downSince ??= lastOk;
      stale(true, why);
      page.applyLink(linkView(page.last.link, Date.now(), downSince));
    },
  });
  page.refreshSoon = () => transport.refreshSoon();
  for (const [topic, fn] of listeners.splice(0)) transport.on(topic, fn);
  page.listen = (topic, fn) => transport.on(topic, fn);
  page.streaming = () => transport.mode() === 'stream';

  timed(last, initial.length, '');
  transport.start();
  return { page, transport };
}
