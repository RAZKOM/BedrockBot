// Tables fetched on demand: the Help tab (Track AM, GET /api/help, once) and the chest list (Track
// AP, GET /api/chests, again on every open: it changes).
import type { PanelChestRow } from '../shared.ts';
import { nice, why, type El } from './dom.ts';
import type { PaletteCommand } from './menu.ts';
import type { Page } from './page.ts';

interface HelpJson {
  commands: (PaletteCommand & { group: string; syntax: string; help: string; example: string; auto: string })[];
  modes: { name: string; values: Record<string, string> }[];
  mode: string;
  settings: { key: string; group: string; value: string; default: string; description: string }[];
}

export function setupTables(page: Page, onHelp: (cmds: PaletteCommand[]) => void): void {
  const { ui } = page;
  const table = (head: string[], rows: string[][]): El => {
    const t = ui.el('table');
    const tr = ui.el('tr');
    for (const h of head) tr.appendChild(ui.el('td', 'muted small', h));
    t.appendChild(tr);
    for (const r of rows) {
      const row = ui.el('tr');
      for (const c of r) row.appendChild(ui.el('td', '', c));
      t.appendChild(row);
    }
    return t;
  };
  const h2 = (t: string): El => {
    const e = ui.el('h2', '', t);
    e.style.marginTop = '12px';
    return e;
  };
  const onOpen = <T>(boxId: string, wrapId: string, url: string, again: boolean, fill: (w: El, data: T) => void): void => {
    const box = ui.need(boxId);
    box.addEventListener('toggle', () => {
      const w = ui.need(wrapId);
      if (!box.open || w.dataset.loaded) return;
      w.dataset.loaded = '1';
      w.textContent = 'loading...';
      void (async () => {
        try {
          const res = await ui.env.fetch(url, { cache: 'no-store', credentials: 'same-origin' });
          if (!res.ok) throw new Error(`${url} ${res.status}`);
          const data = (await res.json()) as T;
          w.textContent = '';
          fill(w, data);
          if (again) delete w.dataset.loaded;
        } catch (e) {
          delete w.dataset.loaded;
          w.textContent = `${url}: ${why(e)}`;
        }
      })();
    });
  };
  onOpen<HelpJson>('helpbox', 'helpwrap', '/api/help', false, (w, h) => {
    onHelp(h.commands);
    w.appendChild(h2('Commands'));
    w.appendChild(table(['tier', 'group', 'syntax', 'help', 'example', 'also on its own'], h.commands.map((c) => [c.tier === 'front' ? 'front door' : 'more', c.group, `!${c.name}${c.syntax ? ` ${c.syntax}` : ''}`, c.help, c.example, c.auto])));
    w.appendChild(h2(`Modes (now: ${h.mode})`));
    const keys = h.modes.length ? Object.keys(h.modes[0]!.values) : [];
    w.appendChild(table(['!mode', ...keys], h.modes.map((m) => [m.name, ...keys.map((k) => m.values[k] ?? '')])));
    w.appendChild(h2('Settings'));
    w.appendChild(table(['group', 'setting', 'value', 'default', 'description'], h.settings.map((s) => [s.group, s.key, s.value, s.default, s.description])));
  });
  onOpen<PanelChestRow[]>('chestbox', 'chestwrap', '/api/chests', true, (w, rows) => {
    if (!rows.length) {
      w.textContent = 'none remembered (!chests scan near home)';
      return;
    }
    w.appendChild(
      table(
        ['where', 'kind', 'slots', 'top', 'state'],
        rows.map((r) => [`${r.x} ${r.y} ${r.z}`, `${nice(r.kind)}${r.label ? ` "${r.label}"` : ''}`, r.size ? `${r.stacks}/${r.size}` : '-', r.top.map((x) => `${x[1]} ${nice(x[0])}`).join(', '), r.unreachable ? `unreachable: ${r.unreachable}` : r.readAt ? 'read' : 'not read yet']),
      ),
    );
  });
}
