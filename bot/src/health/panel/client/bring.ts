// The Bring picker (decision 0065, docs/storage.md "Actions"), shared by the storage view and the map's
// chest sheet. It picks how many (quick picks 1 / 16 / 64 / a stack / all, or a number) and where to (the
// player the panel runs as, or home), shows the exact `!bring` command, and only Send posts it (POST
// /api/cmd, page.send): one confirm tap, the reply shown under it. `!bring` takes from where its own planner
// decides (nearest chest first, loose stacks before boxes), so the picker says so instead of naming a chest.
import type { El } from './dom.ts';
import { nice } from './dom.ts';
import type { Page } from './page.ts';
import { bringCommand, bringPicks, bringTarget, BRING_MAX } from './storedefs.ts';

export interface BringItem {
  name: string;
  /** How many are known (stored and carried; in that chest when opened from the map). */
  total: number;
  /** Stack size, when known. */
  stack: number | null;
}

export interface BringOpen {
  items: BringItem[];
  /** Where the picker was opened from (`chest 100 64 -50`): said in the note. */
  from?: string;
}

export interface Bring {
  open(o: BringOpen): void;
  close(): void;
  isOpen(): boolean;
  /** Show the target and the command again (the summary's `me` arrived). */
  update(): void;
}

export function setupBring(page: Page, me: () => string | null): Bring {
  const { ui } = page;
  const el = (id: string): El => ui.need(id);
  const box = el('bring');
  const pick = el('bring-item');
  const picks = el('bring-picks');
  const nIn = el('bring-n');
  const toMe = el('bring-me');
  const toHome = el('bring-home');
  const cmdEl = el('bring-cmd');
  const send = el('bring-send');
  const reply = el('bring-reply');
  let items: BringItem[] = [];
  let from = '';

  const item = (): BringItem | undefined => items.find((i) => i.name === pick.value) ?? items[0];
  const count = (): number => {
    const n = Math.floor(Number(nIn.value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, BRING_MAX) : 0;
  };
  function command(): string | null {
    const it = item();
    const n = count();
    return it && n ? bringCommand(it.name, n, !!toHome.checked) : null;
  }
  function show(): void {
    const c = command();
    cmdEl.textContent = c ?? 'pick how many';
    send.disabled = c === null || !page.link.actions;
    const t = bringTarget(me());
    ui.text('bring-me-l', t.me);
    ui.text('bring-note', `${page.link.actions ? '' : `${page.link.title}: send works again when the bot has spawned. `}${from ? `From ${from}: ` : ''}${t.note}.`);
  }
  function renderPicks(): void {
    const it = item();
    ui.clear(picks);
    if (!it) return;
    ui.text('bring-title', `Bring ${nice(it.name)} (${it.total} known)`);
    for (const p of bringPicks(it.total, it.stack)) {
      const b = ui.el('button', 'small', p.label);
      b.type = 'button';
      b.dataset.n = String(p.n);
      b.addEventListener('click', () => {
        nIn.value = String(p.n);
        show();
      });
      picks.appendChild(b);
    }
    if (!count()) nIn.value = String(Math.min(it.total, it.stack ?? 64, BRING_MAX) || 1);
    show();
  }
  for (const e of [nIn, toMe, toHome]) {
    e.addEventListener('input', show);
    e.addEventListener('change', show);
  }
  pick.addEventListener('change', () => {
    nIn.value = '';
    renderPicks();
  });
  send.addEventListener('click', () => {
    const c = command();
    if (!c || !page.link.actions) return;
    reply.textContent = `> ${c}\n...`;
    void page.send(c, true).then((out) => {
      reply.textContent = `> ${c}\n${out}`;
    });
  });
  el('bring-close').addEventListener('click', () => {
    box.hidden = true;
  });

  return {
    open(o) {
      items = o.items.filter((i) => i.total > 0);
      from = o.from ?? '';
      ui.clear(pick);
      for (const i of items) {
        const opt = ui.el('option', '', `${nice(i.name)} (${i.total})`);
        opt.value = i.name;
        pick.appendChild(opt);
      }
      pick.value = items[0]?.name ?? '';
      pick.hidden = items.length < 2;
      nIn.value = '';
      toMe.checked = true;
      toHome.checked = false;
      reply.textContent = '';
      box.hidden = false;
      renderPicks();
    },
    close: () => {
      box.hidden = true;
    },
    isOpen: () => !box.hidden,
    update: () => {
      if (!box.hidden) show();
    },
  };
}
