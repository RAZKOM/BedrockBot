// The command card (docs/panel.md "Commands and status"): send() posts one chat command to /api/cmd
// (refused locally when the bot is not in the game and the command needs it), the command box with the
// palette (GET /api/help once, type-ahead by tier), and the quick buttons, editable and kept in this
// browser (Track AR).
import { QUICK_KEY } from '../shared.ts';
import { why } from './dom.ts';
import { offlineOk, paletteMatch, type PaletteCommand } from './menu.ts';
import type { Page } from './page.ts';

interface CmdReply {
  command?: string;
  ok?: boolean;
  replies?: string[];
  error?: string;
}

export interface Commands {
  /** The palette's commands once loaded (the Help tab fills it too). */
  setHelp(cmds: PaletteCommand[]): void;
  hidePalette(): void;
}

export function setupCommands(page: Page): Commands {
  const { ui } = page;
  const env = ui.env;
  const replies = ui.need('replies');

  page.send = async (raw, pop) => {
    const cmd = raw.trim();
    if (!cmd) return '';
    if (!page.link.commands && !offlineOk(cmd)) {
      const msg = `> ${cmd}\nnot sent: ${page.link.title || 'the bot is not in the game'}. ${page.link.kind === 'down' ? 'The panel does not answer.' : '!status, !set, !help and !stop still work.'}`;
      replies.textContent = msg;
      if (pop) page.toast(msg);
      return msg;
    }
    replies.textContent = `> ${cmd}\n...`;
    let out: string;
    try {
      const res = await env.fetch('/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ text: cmd }) });
      const r = (await res.json()) as CmdReply;
      out = r.replies?.length ? r.replies.join('\n') : r.error ?? (r.ok ? '(no reply yet; see bot chat)' : 'failed');
      replies.textContent = `> ${r.command ?? cmd}\n${out}`;
    } catch (e) {
      out = `error: ${why(e)}`;
      replies.textContent = `> ${cmd}\n${out}`;
    }
    if (pop) page.toast(`${cmd}\n${out}`);
    page.refreshSoon();
    return out;
  };

  // ---- quick buttons: the server's defaults, or the list kept in this browser
  const quickBox = ui.need('quick');
  const defaults: string[] = [];
  for (const b of ui.doc.querySelectorAll('button.q')) {
    const c = b.dataset.cmd ?? '';
    defaults.push(c);
    b.addEventListener('click', () => void page.send(c));
  }
  let quick = defaults;
  const loadQuick = (): string[] | null => {
    try {
      const v: unknown = JSON.parse(ui.store.get(QUICK_KEY) ?? 'null');
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.slice(0, 24);
    } catch {
      /* bad JSON: the defaults */
    }
    return null;
  };
  const drawQuick = (list: string[]): void => {
    quick = list;
    ui.clear(quickBox);
    for (const q of list) {
      const b = ui.el('button', 'q', q);
      b.type = 'button';
      b.dataset.cmd = q;
      b.addEventListener('click', () => void page.send(q));
      quickBox.appendChild(b);
    }
  };
  const stored = loadQuick();
  if (stored && stored.join('\n') !== defaults.join('\n')) drawQuick(stored);
  ui.need('quick-edit').addEventListener('click', () => {
    const b = ui.need('quickbox');
    b.hidden = !b.hidden;
    if (!b.hidden) ui.need('quick-text').value = quick.join('\n');
  });
  ui.need('quick-save').addEventListener('click', () => {
    const list = ui
      .need('quick-text')
      .value.split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (x.startsWith('!') ? x : `!${x}`).slice(0, 256))
      .slice(0, 24);
    if (!list.length) return;
    ui.store.set(QUICK_KEY, JSON.stringify(list));
    drawQuick(list);
    ui.need('quickbox').hidden = true;
  });
  ui.need('quick-reset').addEventListener('click', () => {
    ui.store.set(QUICK_KEY, null);
    drawQuick(defaults);
    ui.need('quick-text').value = defaults.join('\n');
  });

  // ---- the palette: type-ahead over the registered commands, grouped by tier
  const input = ui.need('cmd');
  const pal = ui.need('palette');
  let help: PaletteCommand[] | null = null;
  let waiting = false;
  let on = false;
  const hidePalette = (): void => {
    on = false;
    if (!pal.hidden) pal.hidden = true;
  };
  const draw = (): void => {
    if (!on || !help) {
      if (!pal.hidden && !on) pal.hidden = true;
      return;
    }
    if (input.value.indexOf(' ') > 0) {
      pal.hidden = true; // arguments being typed: out of the way
      return;
    }
    const groups = paletteMatch(help, input.value, 12);
    ui.clear(pal);
    for (const g of groups) {
      pal.appendChild(ui.el('div', 'ph', g.tier === 'front' ? 'front door' : 'more'));
      for (const c of g.items) {
        const b = ui.el('button');
        b.type = 'button';
        b.appendChild(ui.el('b', '', `!${c.name}`));
        b.appendChild(ui.el('span', 'muted', `${c.syntax ? ` ${c.syntax}` : ''}  ${c.help ?? ''}`));
        b.addEventListener('pointerdown', (ev) => {
          ev?.preventDefault?.();
          input.value = `!${c.name} `;
          hidePalette();
          input.focus?.();
        });
        pal.appendChild(b);
      }
    }
    pal.hidden = groups.length === 0;
  };
  const load = async (): Promise<void> => {
    if (help || waiting) return;
    waiting = true;
    try {
      const res = await env.fetch('/api/help', { cache: 'no-store', credentials: 'same-origin' });
      if (res.ok) help = ((await res.json()) as { commands: PaletteCommand[] }).commands;
    } catch {
      /* the palette stays empty; the box still sends */
    }
    waiting = false;
    draw();
  };
  input.addEventListener('focus', () => {
    on = true;
    void load();
    draw();
  });
  input.addEventListener('input', () => {
    on = true;
    draw();
  });
  input.addEventListener('blur', hidePalette);
  ui.need('cmdform').addEventListener('submit', (ev) => {
    ev?.preventDefault?.();
    const v = input.value;
    input.value = '';
    hidePalette();
    void page.send(v);
  });

  return {
    setHelp: (cmds) => {
      help ??= cmds;
    },
    hidePalette,
  };
}
