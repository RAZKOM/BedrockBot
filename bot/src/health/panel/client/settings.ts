// Track AR (docs/panel.md "Settings"): the !set rows the server rendered by group: switches sent when
// flipped, numbers / text sent with Enter or `set`, a select for word choices, Reset when the value
// differs from the default, the changed-only and search filters, and the mode bar (the first tap shows
// what a mode would change, the second sends `!mode <name>`). Every action is one chat command.
import { orElse, type El } from './dom.ts';
import { modeChanges, modeOf, setCommand, settingActions, settingVisible, type ModeDef } from './menu.ts';
import type { Lite, Page } from './page.ts';

interface Row {
  tr: El;
  key: string;
  def: string;
  kind: string;
  group: string;
  description: string;
}

export function setupSettings(page: Page): (s: Lite) => void {
  const { ui } = page;
  const doc = ui.doc;
  const modes = JSON.parse(orElse(ui.$('modes-data')?.textContent, '[]')) as ModeDef[];
  const vals: Record<string, string> = {};
  const rows: Row[] = [];
  for (const tr of doc.querySelectorAll('#settings tr[data-row]')) rows.push({ tr, key: tr.dataset.row!, def: tr.dataset.def ?? '', kind: tr.dataset.kind ?? 'text', group: tr.dataset.group ?? '', description: tr.textContent ?? '' });
  const groups = [...doc.querySelectorAll('#settings tr[data-grp]')];
  const changedOnly = ui.need('set-changed');
  const search = ui.need('set-q');
  const inputOf = (key: string): El | null => doc.querySelector(`[data-key="${key}"]:not(button)`);
  let modeArmed: string | null = null;

  function filter(): void {
    const shown: Record<string, boolean> = {};
    for (const r of rows) {
      const v = vals[r.key];
      const ch = v !== undefined && v !== r.def;
      if (r.tr.classList.contains('changed') !== ch) r.tr.classList.toggle('changed', ch);
      const rb = r.tr.querySelector('button.reset');
      if (rb && rb.hidden !== !ch) rb.hidden = !ch;
      const vis = settingVisible(r, v ?? r.def, !!changedOnly.checked, search.value || '');
      if (r.tr.hidden !== !vis) r.tr.hidden = !vis;
      if (vis) shown[r.group] = true;
    }
    for (const g of groups) {
      const h = !shown[g.dataset.grp ?? ''];
      if (g.hidden !== h) g.hidden = h;
    }
  }
  changedOnly.addEventListener('change', filter);
  search.addEventListener('input', filter);

  for (const r of rows) {
    const inp = inputOf(r.key);
    if (inp && (inp.type === 'checkbox' || inp.tagName === 'SELECT')) inp.addEventListener('change', () => void page.send(setCommand(r.key, r.kind, inp.type === 'checkbox' ? inp.checked : inp.value), true));
    else if (inp) {
      inp.addEventListener('input', () => {
        inp.dataset.dirty = '1';
      });
      inp.addEventListener('keydown', (ev) => {
        if (ev?.key === 'Enter') {
          delete inp.dataset.dirty;
          void page.send(setCommand(r.key, r.kind, inp.value), true);
        }
      });
    }
    r.tr.querySelector('button.reset')?.addEventListener('click', () => {
      const a = settingActions(r.key, vals[r.key], r.def)[0];
      if (a?.cmd) {
        if (inp) delete inp.dataset.dirty;
        void page.send(a.cmd, true);
      }
    });
  }
  for (const b of doc.querySelectorAll('button.setbtn'))
    b.addEventListener('click', () => {
      const inp = inputOf(b.dataset.key ?? '');
      if (!inp) return;
      delete inp.dataset.dirty;
      void page.send(setCommand(b.dataset.key ?? '', 'text', inp.value), true);
    });
  for (const b of doc.querySelectorAll('button.mode'))
    b.addEventListener('click', () => {
      const m = b.dataset.mode ?? '';
      if (modeArmed === m) {
        modeArmed = null;
        ui.text('mode-diff', '');
        void page.send(`!mode ${m}`, true);
        return;
      }
      const d = modeChanges(modes, m, vals);
      modeArmed = d.length ? m : null;
      ui.text('mode-diff', d.length ? `${m} changes ${d.map((x) => `${x.key} ${x.from} -> ${x.to}`).join(', ')}; tap ${m} again to apply` : `the settings already match ${m}`);
    });

  return (s) => {
    for (const r of s.settings) {
      vals[r.key] = r.value;
      const src = doc.querySelector(`[data-src="${r.key}"]`);
      if (src && src.textContent !== r.source) src.textContent = r.source;
      const inp = inputOf(r.key);
      if (!inp || doc.activeElement === inp || inp.dataset.dirty) continue;
      if (inp.type === 'checkbox') {
        if (inp.checked !== (r.value === 'on')) inp.checked = r.value === 'on';
      } else if (inp.value !== r.value) inp.value = r.value;
    }
    filter();
    const now = modeOf(modes, vals);
    ui.text('mode-now', now);
    for (const b of doc.querySelectorAll('button.mode')) {
      const on = b.dataset.mode === now;
      if (b.classList.contains('on') !== on) b.classList.toggle('on', on);
    }
  };
}
