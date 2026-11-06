// Track AR (docs/panel.md "Commands and status"): the log card, the last 50 lines filtered by level,
// module (every [module] seen so far is offered) and text; it follows new lines while scrolled down.
import { atBottom } from './dom.ts';
import { logVisible, parseLog } from './menu.ts';
import type { Lite, Page } from './page.ts';

export function setupLogs(page: Page): (s: Lite) => void {
  const { ui } = page;
  const level = ui.need('log-level');
  const mod = ui.need('log-mod');
  const q = ui.need('log-q');
  const mods = new Set<string>();
  const render = (s: Lite): void => {
    for (const l of s.logs) {
      const m = parseLog(l).module;
      if (m && !mods.has(m)) {
        mods.add(m);
        const o = ui.el('option', '', m);
        o.value = m;
        mod.appendChild(o);
      }
    }
    const lg = ui.need('logs');
    const follow = atBottom(lg);
    const lines = s.logs.filter((l) => logVisible(l, level.value || '', mod.value || '', q.value || ''));
    ui.text('logs', lines.length || !s.logs.length ? lines.join('\n') : '(no line matches the filter)');
    if (follow) lg.scrollTop = lg.scrollHeight;
  };
  const again = (): void => render(page.last);
  level.addEventListener('change', again);
  mod.addEventListener('change', again);
  q.addEventListener('input', again);
  return render;
}
