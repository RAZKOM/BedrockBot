// The offline banner (docs/panel.md "When the bot is not connected"): what the link is doing (the
// state's `link` through menu.ts linkView, or the panel itself not answering), the greyed actions
// (body.is-offline), the quick buttons that need the game disabled; back to normal when the bot spawns.
import { offlineOk, type LinkView } from './menu.ts';
import type { Page } from './page.ts';

export function setupLink(page: Page): (v: LinkView) => void {
  const { ui } = page;
  let rowsSig = '';
  return (v) => {
    page.link = v;
    const sec = ui.need('panel-link');
    if (sec.hidden !== !v.show) sec.hidden = !v.show;
    const cls = `wide link link-${v.kind}`;
    if (sec.className !== cls) sec.className = cls;
    const body = ui.doc.body;
    if (body.classList.contains('is-offline') !== !v.actions) body.classList.toggle('is-offline', !v.actions);
    for (const b of ui.doc.querySelectorAll('button.q')) {
      const off = !v.commands && !offlineOk(b.dataset.cmd);
      if (b.disabled !== off) {
        b.disabled = off;
        b.title = off ? 'the bot is not in the game' : '';
      }
    }
    if (!v.show) return;
    ui.text('link-title', v.title);
    ui.text('link-detail', v.detail);
    const sig = JSON.stringify(v.rows);
    if (sig !== rowsSig) {
      rowsSig = sig;
      const dl = ui.need('link-rows');
      ui.clear(dl);
      for (const r of v.rows) {
        dl.appendChild(ui.el('dt', '', r[0]));
        dl.appendChild(ui.el('dd', '', r[1]));
      }
    }
    const si = ui.need('link-signin');
    const on = !!v.signIn && (!!v.signIn.url || !!v.signIn.code);
    if (si.hidden !== !on) si.hidden = !on;
    if (on && v.signIn) {
      const a = ui.need('link-url');
      const url = v.signIn.url ?? '';
      const u = url.startsWith('https://') ? url : '';
      if (u && a.getAttribute('href') !== u) a.setAttribute('href', u);
      a.hidden = !u;
      ui.text('link-code', v.signIn.code ?? '-');
    }
  };
}
