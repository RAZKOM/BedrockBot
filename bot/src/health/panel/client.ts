// Track AP (docs/panel.md "Live updates"): the panel page's inline script. It renders every poll's
// /api/state into the nodes the server rendered (no innerHTML of the page, each node written only when
// its text changed), marks the page stale when a poll fails, polls every 2 s (10 s while the tab is
// hidden), and keeps the command box, quick buttons, settings, Help tab and map of Track AE / AM.
// Track AR (docs/panel.md "Interaction"): context menus on the inventory cells and the map, the
// grouped settings with switches, Reset and the mode selector, the command palette, configurable quick
// buttons, Stop / Pause / Resume, the log filter and the panel's own map. Every action is a chat
// command sent to POST /api/cmd; the menu model is menu.ts MENU_JS, embedded here verbatim.
// Kept as a plain string (no build step); test/unit/health/panel-page.test.ts runs it on a fake DOM.
import { ICON_CLASSES } from './inventory.ts';
import { MENU_JS } from './menu.ts'; // Track AR

export const POLL_MS = 2000;
export const HIDDEN_POLL_MS = 10_000;
/** Track AR: the map section polls /map.json this often while it is open; /api/marks every 5th time. */
export const MAP_POLL_MS = 2000;
/** Track AR: a destructive menu action stays armed this long after the first tap. */
export const CONFIRM_MS = 4000;
/** Track AR: localStorage key of the quick buttons. */
export const QUICK_KEY = 'bbpanel-quick';

/** The script (between <script> tags; contains no backticks and no closing script tag). */
export const PANEL_SCRIPT = String.raw`(() => {
  MENU_JS_V
  const $ = (id) => document.getElementById(id);
  const text = (id, v) => { const e = $(id); if (e && e.textContent !== v) e.textContent = v; };
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const clear = (e) => { if (e.replaceChildren) e.replaceChildren(); else e.textContent = ''; };
  const ICONS = new Set(ICON_LIST);
  const POLL = POLL_MS_V, HIDDEN = HIDDEN_MS_V, CONFIRM = CONFIRM_V;
  let last = JSON.parse($('initial').textContent);
  let renders = 0, lastOk = Date.now(), timer = 0, picked = null, bytes = $('initial').textContent.length;
  const atBottom = (e) => e.scrollHeight - e.scrollTop - e.clientHeight < 30;
  const nice = (n) => String(n).replace(/_/g, ' ');
  const num = (v, d) => (v == null ? '-' : (d ? Number(v).toFixed(d) : String(v)));
  const dur = (s) => { s = Math.round(s); if (s < 60) return s + ' s'; if (s < 3600) return Math.floor(s / 60) + ' min'; return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min'; };
  const width = (id, pct) => { const e = $(id); if (!e) return; const w = Math.max(0, Math.min(100, pct)).toFixed(1) + '%'; if (e.style.width !== w) e.style.width = w; };
  const durColour = (p) => (p > 50 ? 'var(--ok)' : p > 20 ? 'var(--warn)' : 'var(--bad)');
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } } };
  // ---- theme (dark by default; prefers-color-scheme; a stored choice wins) ----
  const root = document.documentElement;
  const themeBtn = $('theme');
  const showTheme = () => { if (themeBtn) themeBtn.textContent = root.dataset.theme === 'light' ? 'dark' : 'light'; };
  if (themeBtn) themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    store.set('bbpanel-theme', root.dataset.theme);
    showTheme();
  });
  showTheme();
  // ---- toast: the reply of a menu action, wherever the page is scrolled (Track AR) ----
  let toastT = 0;
  function toast(t) { const e = $('toast'); e.textContent = t; e.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { e.hidden = true; }, 5000); }
  // ---- the context menu (Track AR): one floating list; destructive actions need a second tap ----
  const menu = $('menu');
  let menuKey = null, armed = null, armT = 0;
  function closeMenu() { if (!menu.hidden) menu.hidden = true; menuKey = null; armed = null; }
  function placeMenu(x, y, n) {
    const W = root.clientWidth || 360, H = root.clientHeight || 640;
    menu.style.left = Math.max(4, Math.min(x, W - 236)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, H - 44 * (n + 1) - 8)) + 'px';
  }
  function openMenu(key, title, actions, x, y, local) {
    clear(menu); menuKey = key; armed = null;
    menu.appendChild(el('div', 'mt', title));
    if (!actions.length) menu.appendChild(el('div', 'mt', 'no action for this'));
    for (const a of actions) {
      const b = el('button', 'mi' + (a.confirm ? ' danger' : ''), a.label);
      b.type = 'button'; b.dataset.act = a.id; b.setAttribute('role', 'menuitem');
      b.addEventListener('click', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); act(a, b, local); });
      menu.appendChild(b);
    }
    menu.hidden = false;
    placeMenu(x, y, actions.length);
  }
  function act(a, b, local) {
    if (!a.cmd) { closeMenu(); if (local) local(a); return; }
    if (a.confirm && armed !== b) {
      armed = b; b.textContent = 'tap again: ' + a.label; b.classList.add('armed');
      clearTimeout(armT);
      armT = setTimeout(() => { if (armed === b) { armed = null; b.textContent = a.label; b.classList.remove('armed'); } }, CONFIRM);
      return;
    }
    if (a.prompt) { askName(a); return; }
    closeMenu(); send(a.cmd, true);
  }
  function askName(a) {
    const title = menu.firstChild ? menu.firstChild.textContent : '';
    clear(menu); menu.appendChild(el('div', 'mt', title + ': ' + a.prompt));
    const inp = el('input'); inp.type = 'text'; inp.maxLength = 32; inp.setAttribute('aria-label', a.prompt); menu.appendChild(inp);
    const ok = el('button', 'mi', 'Set waypoint'); ok.type = 'button'; menu.appendChild(ok);
    const go = () => { const n = wpName(inp.value); if (!n) { toast('a waypoint name is 1..32 of a-z 0-9 _ -'); return; } closeMenu(); send(a.cmd.replace('{name}', n), true); };
    ok.addEventListener('click', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); go(); });
    inp.addEventListener('keydown', (ev) => { if (ev && ev.key === 'Enter') go(); });
    if (inp.focus) inp.focus();
  }
  document.addEventListener('click', (ev) => {
    const t = ev && ev.target;
    if (menu.hidden || !t || (menu.contains && menu.contains(t)) || (t.closest && t.closest('.cell, #mapcv'))) return;
    closeMenu();
  });
  document.addEventListener('keydown', (ev) => { if (ev && ev.key === 'Escape') { closeMenu(); hidePalette(); } });
  // ---- inventory ----
  const cells = {};
  for (const c of document.querySelectorAll('#inventory .cell')) cells[c.dataset.slot] = c;
  const ARMOUR = ['head', 'chest', 'legs', 'feet'];
  const where = (k) => (k === 'off' ? 'offhand' : k.charAt(0) === 'a' ? ARMOUR[Number(k.slice(1))] : Number(k.slice(1)) < 9 ? 'hotbar ' + (Number(k.slice(1)) + 1) : 'inventory ' + k.slice(1));
  const itemOf = (s, k) => { const inv = s.inventory; if (!inv) return null; if (k === 'off') return inv.offhand; if (k.charAt(0) === 'a') return inv.armour[Number(k.slice(1))] || null; return inv.slots[Number(k.slice(1))] || null; };
  const boxLine = (b) => (!b.known ? 'contents unknown (moved since the server sent it)' : b.items.length === 0 ? 'empty' : b.items.map((x) => x[1] + ' ' + nice(x[0])).join(', ') + (b.more ? ', +' + b.more + ' more kinds' : '') + ' (' + b.stacks + '/27 slots)');
  const label = (it) => nice(it.name) + (it.count > 1 ? ' x' + it.count : '') + (it.dur ? ', durability ' + it.dur.left + '/' + it.dur.max + ' (' + it.dur.pct + '%)' : '') + (it.box ? ', ' + boxLine(it.box) : '');
  function setCell(el, it, sel) {
    const sig = it ? it.name + '|' + it.count + '|' + it.colour + '|' + (it.dur ? it.dur.left : '') + '|' + (it.box ? JSON.stringify(it.box) : '') : '';
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      const use = el.querySelector('use');
      if (use) use.setAttribute('href', '#g-' + (it && ICONS.has(it.icon) ? it.icon : 'item'));
      el.style.color = it ? it.colour : '';
      el.classList.toggle('empty', !it);
      el.querySelector('.ab').textContent = it ? it.abbr : '';
      el.querySelector('.ct').textContent = it && it.count > 1 ? String(it.count) : '';
      const d = el.querySelector('.dur');
      d.hidden = !(it && it.dur);
      if (it && it.dur) { d.firstChild.style.width = it.dur.pct + '%'; d.firstChild.style.background = durColour(it.dur.pct); }
      el.title = it ? label(it) : where(el.dataset.slot) + ': empty';
      el.setAttribute('aria-label', el.title);
    }
    if (el.classList.contains('sel') !== !!sel) el.classList.toggle('sel', !!sel);
  }
  function info(s) {
    const box = $('iteminfo');
    if (!box) return;
    if (picked === null) { text('iteminfo', 'tap or right-click a slot: actions and details'); return; }
    const it = itemOf(s, picked);
    const lines = [where(picked) + ': ' + (it ? nice(it.name) : 'empty')];
    if (it) {
      lines.push('count ' + it.count);
      if (it.dur) lines.push('durability ' + it.dur.left + ' of ' + it.dur.max + ' (' + it.dur.pct + '%)');
      if (it.box) lines.push('shulker box: ' + boxLine(it.box));
    }
    text('iteminfo', lines.join('\n'));
  }
  const pos = (ev, e) => { if (ev && (ev.clientX || ev.clientY)) return [ev.clientX, ev.clientY]; const r = e.getBoundingClientRect ? e.getBoundingClientRect() : { left: 8, bottom: 8 }; return [r.left, r.bottom]; };
  function cellMenu(k, ev) {
    const it = itemOf(last, k);
    const p = pos(ev, cells[k]);
    openMenu('cell:' + k, where(k) + ': ' + (it ? label(it) : 'empty'), cellActions(k, it, last.inventory), p[0], p[1], () => { picked = k; info(last); if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest' }); });
  }
  const box = $('iteminfo');
  for (const k in cells) {
    cells[k].addEventListener('click', (ev) => {
      if (picked !== null && cells[picked]) cells[picked].classList.remove('picked');
      picked = picked === k ? null : k;
      if (picked !== null) cells[picked].classList.add('picked');
      info(last);
      if (picked === null) closeMenu(); else cellMenu(k, ev);
    });
    cells[k].addEventListener('contextmenu', (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); picked = k; info(last); cellMenu(k, ev); });
  }
  function renderInventory(s) {
    const inv = s.inventory;
    for (const k in cells) setCell(cells[k], itemOf(s, k), !!inv && k.charAt(0) === 's' && Number(k.slice(1)) === inv.selected);
    text('inv-sum', inv ? (36 - inv.free) + '/36 slots used, armour ' + inv.armourPoints + '/20' : 'no inventory (no world model)');
    info(s);
  }
  // ---- statuses ----
  function renderVitals(s) {
    const v = s.self, inv = s.inventory;
    text('v-health', v.health == null ? '-' : num(Math.round(v.health * 10) / 10) + ' / 20'); width('b-health', v.health == null ? 0 : v.health * 5);
    text('v-food', v.food == null ? '-' : num(v.food) + ' / 20'); width('b-food', v.food == null ? 0 : v.food * 5);
    text('v-sat', v.saturation == null ? '-' : num(v.saturation, 1)); width('b-sat', v.saturation == null ? 0 : v.saturation * 5);
    text('v-armour', inv ? inv.armourPoints + ' / 20' : '-'); width('b-armour', inv ? inv.armourPoints * 5 : 0);
    const p = v.pos;
    text('v-pos', p ? p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ' + p.z.toFixed(1) : '-');
    text('v-dimension', v.dimension || '-');
    if (v.timeOfDay == null) text('v-time', '-');
    else {
      const h = (v.timeOfDay / 1000 + 6) % 24, hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
      text('v-time', (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ' ' + (v.phase || '') + (v.day != null ? ', day ' + v.day : '') + ' (' + v.timeOfDay + ')');
      const hand = $('clock-hand'), rot = 'rotate(' + ((h / 24) * 360 + 180).toFixed(1) + ' 10 10)';
      if (hand && hand.getAttribute('transform') !== rot) hand.setAttribute('transform', rot);
      const face = $('clock'); if (face) { const c = 'clock ' + (v.phase || ''); if (face.getAttribute('class') !== c) face.setAttribute('class', c); }
    }
    text('v-weather', v.weather || 'unknown');
    text('v-flight', v.flight || '-');
    text('v-deaths', v.deaths == null ? '-' : String(v.deaths));
    text('v-lastdeath', v.lastDeath ? v.lastDeath.cause + (v.lastDeath.messages.length ? ' (' + v.lastDeath.messages.join(', ') + ')' : '') + ', ' + new Date(v.lastDeath.ts).toLocaleTimeString() : 'none');
  }
  let stackSig = '';
  function renderStatus(s) {
    text('status', s.status.join('\n'));
    const j = s.job;
    text('job', j ? j.name + ' (' + j.state + '): ' + j.line + (j.etaS != null ? ', eta ' + dur(j.etaS) : '') : 'no job (idle)');
    text('paused', s.paused ? 'commands held (!pause)' : '');
    const pb = $('btn-pause'), rb = $('btn-resume');
    if (pb.disabled !== (s.paused === true || s.paused == null)) pb.disabled = s.paused === true || s.paused == null;
    if (rb.disabled !== (s.paused !== true)) rb.disabled = s.paused !== true;
    const sig = JSON.stringify(s.stack);
    if (sig === stackSig) return;
    stackSig = sig;
    const st = $('stack'); clear(st);
    if (s.stack.length === 0) st.appendChild(el('li', 'muted', 'no processes'));
    for (const e of s.stack) {
      const li = document.createElement('li');
      li.appendChild(el('span', 'badge st-' + e.state, e.state));
      li.appendChild(el('b', '', ' ' + e.name));
      li.appendChild(el('span', 'muted small', ' ' + e.kind + ', priority ' + e.priority));
      for (const a of stackActions(e)) { const b = el('button', 'stopbtn', a.label); b.type = 'button'; b.dataset.cmd = a.cmd; b.title = a.cmd + ' (ends every user command)'; b.addEventListener('click', () => send(a.cmd, true)); li.appendChild(b); }
      li.appendChild(el('div', 'small', e.line + (e.etaS != null ? ', eta ' + dur(e.etaS) : '')));
      st.appendChild(li);
    }
  }
  $('btn-pause').addEventListener('click', () => send('!pause', true));
  $('btn-resume').addEventListener('click', () => send('!resume', true));
  function renderNumbers(s) {
    const c = s.combat;
    text('c-fights', c ? String(c.fights) : '-'); text('c-kills', c ? String(c.kills) : '-'); text('c-retargets', c ? String(c.retargets) : '-');
    text('c-flees', c ? String(c.flees) : '-'); text('c-guard', c ? String(c.guardTriggers) : '-');
    text('c-damage', c ? c.damageTaken + ' in ' + c.hits + ' hits' : '-');
    text('c-lasthit', c && c.lastHit ? c.lastHit.damage + ', ' + dur(c.lastHit.agoS) + ' ago' : 'none');
    const m = s.memory;
    text('m-chests', m ? m.chests.known + ' known: ' + m.chests.reachable + ' reachable, ' + m.chests.unreachable + ' unreachable' : 'no world cache');
    text('m-read', m ? String(m.chests.read) : '-');
    text('m-herds', m ? m.herds + ' (' + m.animals + ' animals)' : '-');
    text('m-forests', m ? String(m.forests) : '-');
    text('m-ores', m ? m.ores + (m.ores ? ': ' + Object.entries(m.oreKinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[1] + ' ' + nice(x[0])).join(', ') : '') : '-');
    const p = s.planner;
    text('p-threads', p ? (p.threads == null ? '-' : p.threads === 0 ? '0 (main thread)' : String(p.threads)) + (p.running ? ', worker on' : ', no worker') : 'no planner');
    text('p-plans', p ? p.plans + ' (' + p.interims + ' interims, ' + p.results + ' results, ' + p.failed + ' failed)' : '-');
    text('p-forward', p ? p.forwardMs + ' ms total, longest ' + p.maxForwardMs + ' ms' : '-');
    text('p-crashes', p ? p.crashes + ' (' + p.starts + ' starts)' : '-');
    const k = s.conn;
    text('k-server', k ? k.server : s.bot.server); text('k-version', k ? k.version : s.bot.gameVersion); text('k-state', k ? k.state : s.bot.state);
    text('k-uptime', k ? dur(k.uptimeS) + (k.sessionS != null ? ', session ' + dur(k.sessionS) : '') : '-');
    text('k-reconnects', k ? k.reconnects + ' (' + k.disconnects + ' disconnects)' : '-');
    text('k-kicks', k ? String(k.kicks) : '-');
    text('k-last', k && k.lastDisconnect ? k.lastDisconnect : 'none');
  }
  // ---- the log, filtered by level, module and text (Track AR) ----
  const logLevel = $('log-level'), logMod = $('log-mod'), logQ = $('log-q'), mods = new Set();
  function renderLogs(s) {
    for (const l of s.logs) { const m = parseLog(l).module; if (m && !mods.has(m)) { mods.add(m); const o = el('option', '', m); o.value = m; logMod.appendChild(o); } }
    const lg = $('logs'), lb = atBottom(lg);
    const lines = s.logs.filter((l) => logVisible(l, logLevel.value || '', logMod.value || '', logQ.value || ''));
    text('logs', lines.length || !s.logs.length ? lines.join('\n') : '(no line matches the filter)');
    if (lb) lg.scrollTop = lg.scrollHeight;
  }
  logLevel.addEventListener('change', () => renderLogs(last)); logMod.addEventListener('change', () => renderLogs(last)); logQ.addEventListener('input', () => renderLogs(last));
  // ---- settings: grouped rows, switches, Reset, filters, the mode selector (Track AR) ----
  const modes = JSON.parse($('modes-data').textContent || '[]');
  const vals = {};
  const srows = [];
  for (const tr of document.querySelectorAll('#settings tr[data-row]')) srows.push({ tr, key: tr.dataset.row, def: tr.dataset.def, kind: tr.dataset.kind, group: tr.dataset.group, description: tr.textContent });
  const grps = document.querySelectorAll('#settings tr[data-grp]');
  const setChanged = $('set-changed'), setQ = $('set-q');
  const inputOf = (key) => document.querySelector('[data-key="' + key + '"]:not(button)');
  let modeArmed = null;
  function renderSettings(s) {
    for (const r of s.settings) {
      vals[r.key] = r.value;
      const src = document.querySelector('[data-src="' + r.key + '"]'); if (src && src.textContent !== r.source) src.textContent = r.source;
      const inp = inputOf(r.key);
      if (!inp || document.activeElement === inp || inp.dataset.dirty) continue;
      if (inp.type === 'checkbox') { if (inp.checked !== (r.value === 'on')) inp.checked = r.value === 'on'; }
      else if (inp.value !== r.value) inp.value = r.value;
    }
    filterSettings();
    text('mode-now', modeOf(modes, vals));
    for (const b of document.querySelectorAll('button.mode')) { const on = b.dataset.mode === modeOf(modes, vals); if (b.classList.contains('on') !== on) b.classList.toggle('on', on); }
  }
  function filterSettings() {
    const shown = {};
    for (const r of srows) {
      const v = vals[r.key], ch = v !== undefined && v !== r.def;
      if (r.tr.classList.contains('changed') !== ch) r.tr.classList.toggle('changed', ch);
      const rb = r.tr.querySelector('button.reset'); if (rb && rb.hidden !== !ch) rb.hidden = !ch;
      const vis = settingVisible(r, v === undefined ? r.def : v, !!setChanged.checked, setQ.value || '');
      if (r.tr.hidden !== !vis) r.tr.hidden = !vis;
      if (vis) shown[r.group] = 1;
    }
    for (const g of grps) { const h = !shown[g.dataset.grp]; if (g.hidden !== h) g.hidden = h; }
  }
  setChanged.addEventListener('change', filterSettings); setQ.addEventListener('input', filterSettings);
  for (const r of srows) {
    const inp = inputOf(r.key);
    if (inp && (inp.type === 'checkbox' || inp.tagName === 'SELECT')) inp.addEventListener('change', () => send(setCommand(r.key, r.kind, inp.type === 'checkbox' ? inp.checked : inp.value), true));
    else if (inp) {
      inp.addEventListener('input', () => { inp.dataset.dirty = '1'; });
      inp.addEventListener('keydown', (ev) => { if (ev && ev.key === 'Enter') { delete inp.dataset.dirty; send(setCommand(r.key, r.kind, inp.value), true); } });
    }
    const rb = r.tr.querySelector('button.reset');
    if (rb) rb.addEventListener('click', () => { const a = settingActions(r.key, vals[r.key], r.def)[0]; if (a) { if (inp) delete inp.dataset.dirty; send(a.cmd, true); } });
  }
  for (const b of document.querySelectorAll('button.setbtn')) b.addEventListener('click', () => {
    const inp = inputOf(b.dataset.key);
    if (!inp) return; delete inp.dataset.dirty; send(setCommand(b.dataset.key, 'text', inp.value), true);
  });
  for (const b of document.querySelectorAll('button.mode')) b.addEventListener('click', () => {
    const m = b.dataset.mode;
    if (modeArmed === m) { modeArmed = null; text('mode-diff', ''); send('!mode ' + m, true); return; }
    const d = modeChanges(modes, m, vals);
    modeArmed = d.length ? m : null;
    text('mode-diff', d.length ? m + ' changes ' + d.map((x) => x.key + ' ' + x.from + ' -> ' + x.to).join(', ') + '; tap ' + m + ' again to apply' : 'the settings already match ' + m);
  });
  function render(s) {
    last = s;
    const dot = $('dot'), dc = 'dot' + (s.bot.healthy ? ' ok' : ''); if (dot.className !== dc) dot.className = dc;
    text('botname', s.bot.name || 'BedrockBot'); text('conn', s.bot.state); text('server', s.bot.server); text('task', s.bot.task); text('ver', s.bot.gameVersion);
    renderInventory(s);
    renderVitals(s);
    renderStatus(s);
    renderNumbers(s);
    renderLogs(s);
    const ch = $('chat'), cb = atBottom(ch);
    text('chat', s.chat.map((c) => new Date(c.ts).toLocaleTimeString() + ' ' + c.text + (c.sent ? '' : '  (not sent to the game)')).join('\n'));
    if (cb) ch.scrollTop = ch.scrollHeight;
    renderSettings(s);
  }
  function stale(on, why) {
    const e = $('stale');
    if (e) { e.hidden = !on; if (on) e.textContent = 'stale ' + dur((Date.now() - lastOk) / 1000); }
    if (document.body.classList.contains('is-stale') !== on) document.body.classList.toggle('is-stale', on);
    text('err', on ? why : '');
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
  function timed(s) {
    const t0 = performance.now();
    render(s);
    const ms = performance.now() - t0;
    if (renders++ % 30 === 0) console.debug('panel: render ' + ms.toFixed(2) + ' ms, state ' + bytes + ' bytes');
  }
  async function poll() {
    try {
      const res = await fetch('/api/state?lite=1', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) { location.href = '/'; return; }
      if (!res.ok) throw new Error('state ' + res.status);
      const body = await res.text();
      bytes = body.length;
      timed(JSON.parse(body));
      lastOk = Date.now();
      stale(false, '');
    } catch (e) { stale(true, 'offline: ' + (e && e.message ? e.message : e)); }
    schedule(document.hidden ? HIDDEN : POLL);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  // ---- commands ----
  async function send(cmd, pop) {
    cmd = cmd.trim(); if (!cmd) return;
    $('replies').textContent = '> ' + cmd + '\n...';
    let out;
    try {
      const res = await fetch('/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ text: cmd }) });
      const r = await res.json();
      out = (r.replies && r.replies.length) ? r.replies.join('\n') : (r.error || (r.ok ? '(no reply yet; see bot chat)' : 'failed'));
      $('replies').textContent = '> ' + (r.command || cmd) + '\n' + out;
    } catch (e) { out = 'error: ' + (e && e.message ? e.message : e); $('replies').textContent = '> ' + cmd + '\n' + out; }
    if (pop) toast(cmd + '\n' + out);
    schedule(300);
    return out;
  }
  $('cmdform').addEventListener('submit', (ev) => { ev.preventDefault(); const v = $('cmd').value; $('cmd').value = ''; hidePalette(); send(v); });
  // quick buttons: the server's defaults, or the list kept in this browser (Track AR)
  const quickBox = $('quick');
  const QDEF = [];
  for (const b of document.querySelectorAll('button.q')) { QDEF.push(b.dataset.cmd); b.addEventListener('click', () => send(b.dataset.cmd)); }
  let quick = QDEF;
  function loadQuick() { try { const v = JSON.parse(store.get(QUICK_KEY_V) || 'null'); if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.slice(0, 24); } catch (e) { /* bad JSON */ } return null; }
  function drawQuick(list) {
    quick = list; clear(quickBox);
    for (const q of list) { const b = el('button', 'q', q); b.type = 'button'; b.dataset.cmd = q; b.addEventListener('click', () => send(q)); quickBox.appendChild(b); }
  }
  const storedQuick = loadQuick();
  if (storedQuick && storedQuick.join('\n') !== QDEF.join('\n')) drawQuick(storedQuick);
  $('quick-edit').addEventListener('click', () => { const b = $('quickbox'); b.hidden = !b.hidden; if (!b.hidden) $('quick-text').value = quick.join('\n'); });
  $('quick-save').addEventListener('click', () => {
    const list = $('quick-text').value.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => (x.charAt(0) === '!' ? x : '!' + x).slice(0, 256)).slice(0, 24);
    if (!list.length) return;
    store.set(QUICK_KEY_V, JSON.stringify(list)); drawQuick(list); $('quickbox').hidden = true;
  });
  $('quick-reset').addEventListener('click', () => { store.set(QUICK_KEY_V, null); drawQuick(QDEF); $('quick-text').value = QDEF.join('\n'); });
  // the command palette: type-ahead over the registered commands (GET /api/help once), grouped by tier (Track AR)
  const cmdIn = $('cmd'), pal = $('palette');
  let helpCmds = null, helpWait = false, palOn = false;
  async function loadCmds() {
    if (helpCmds || helpWait) return;
    helpWait = true;
    try { const res = await fetch('/api/help', { cache: 'no-store', credentials: 'same-origin' }); if (res.ok) helpCmds = (await res.json()).commands; } catch (e) { /* the palette stays empty; the box still sends */ }
    helpWait = false; drawPalette();
  }
  function hidePalette() { palOn = false; if (!pal.hidden) pal.hidden = true; }
  function drawPalette() {
    if (!palOn || !helpCmds) { if (!pal.hidden && !palOn) pal.hidden = true; return; }
    const v = cmdIn.value;
    if (v.indexOf(' ') > 0) { pal.hidden = true; return; } // arguments being typed: out of the way
    const groups = paletteMatch(helpCmds, v, 12);
    clear(pal);
    for (const g of groups) {
      pal.appendChild(el('div', 'ph', g.tier === 'front' ? 'front door' : 'more'));
      for (const c of g.items) {
        const b = el('button'); b.type = 'button';
        b.appendChild(el('b', '', '!' + c.name)); b.appendChild(el('span', 'muted', (c.syntax ? ' ' + c.syntax : '') + '  ' + c.help));
        b.addEventListener('pointerdown', (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); cmdIn.value = '!' + c.name + ' '; hidePalette(); if (cmdIn.focus) cmdIn.focus(); });
        pal.appendChild(b);
      }
    }
    pal.hidden = groups.length === 0;
  }
  cmdIn.addEventListener('focus', () => { palOn = true; loadCmds(); drawPalette(); });
  cmdIn.addEventListener('input', () => { palOn = true; drawPalette(); });
  cmdIn.addEventListener('blur', hidePalette);
  // ---- the map (Track AR): /map.json tiles, the bot, path, home, shelter, waypoints, chests, herds; a menu per column ----
  const MAP_COL = { bot: '#ffffff', path: '#f5c542', home: '#4ce08a', shelter: '#c08cff', wp: '#5cd6ff', chest: '#b5793a', herd: '#b0e57c', hostile: '#ff5050', player: '#e8e8e8', passive: '#9fcf6a', neutral: '#ffa94d', item: '#ffd27f', other: '#cccccc' };
  const M = { on: false, cv: null, g: null, tiles: new Map(), data: null, marks: { chests: [], herds: [] }, since: -1, win: null, scale: 4, view: { x: 0, z: 0 }, t: 0, n: 0, busy: false, down: null, lp: 0 };
  const b64 = (s) => { const bin = atob(s), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
  function tileColour(cls, y, live) {
    let c = cls === 2 ? [47, 111, 208] : cls === 3 ? [224, 83, 31] : cls === 1 ? (y > 90 ? [150, 150, 140] : [72 + Math.max(0, Math.min(60, y)), 130, 56]) : [24, 26, 30];
    if (cls === 1) { const f = 0.8 + ((((y % 4) + 4) % 4) / 10); c = c.map((v) => Math.min(255, v * f)); }
    return live ? c : c.map((v) => v * 0.55);
  }
  function tileImage(t) {
    const ys = new Int16Array(b64(t.y).buffer), cs = b64(t.c), c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const g = c.getContext('2d'), img = g.createImageData(16, 16);
    for (let i = 0; i < 256; i++) { const cls = (cs[i >> 2] >> ((i & 3) * 2)) & 3, y = ys[i], rgb = y === -32768 ? [24, 26, 30] : tileColour(cls, y, t.live), o = i * 4; img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255; }
    g.putImageData(img, 0, 0);
    return { t, img: c, ys, cs };
  }
  const dpr = () => window.devicePixelRatio || 1;
  const toScreen = (x, z) => [(x - M.view.x) * M.scale + M.cv.width / 2, (z - M.view.z) * M.scale + M.cv.height / 2];
  const toWorld = (sx, sy) => [(sx - M.cv.width / 2) / M.scale + M.view.x, (sy - M.cv.height / 2) / M.scale + M.view.z];
  /** Surface y and class of a column (null: not in the cache). */
  function column(bx, bz) {
    const tile = M.tiles.get((bx >> 4) + ',' + (bz >> 4));
    if (!tile) return null;
    const i = ((bz & 15) << 4) | (bx & 15), y = tile.ys[i];
    return { y: y === -32768 ? null : y, cls: (tile.cs[i >> 2] >> ((i & 3) * 2)) & 3, live: tile.t.live };
  }
  /** Markers drawn on the map, as [x, z, colour, label, kind]. */
  function markers() {
    const d = M.data, out = [];
    if (!d) return out;
    if (d.home) out.push([d.home.x + 0.5, d.home.z + 0.5, MAP_COL.home, 'home', 'sq']);
    if (d.shelter) out.push([d.shelter.x + 0.5, d.shelter.z + 0.5, MAP_COL.shelter, 'shelter', 'sq']);
    for (const w of d.waypoints) out.push([w.x + 0.5, w.z + 0.5, MAP_COL.wp, 'waypoint ' + w.name, 'wp']);
    for (const c of M.marks.chests) out.push([c.x + 0.5, c.z + 0.5, MAP_COL.chest, nice(c.kind) + (c.label ? ' "' + c.label + '"' : '') + (c.unreachable ? ' (unreachable)' : ''), 'chest']);
    for (const h of M.marks.herds) out.push([h.x, h.z, MAP_COL.herd, 'herd: ' + h.n + ' ' + nice(h.kind) + (h.penned ? ' (penned)' : ''), 'herd']);
    for (const e of d.entities) if (e.kind !== 'item') out.push([e.x, e.z, MAP_COL[e.kind] || MAP_COL.other, e.name || nice(e.type), 'ent']);
    if (d.bot) out.push([d.bot.x, d.bot.z, MAP_COL.bot, 'bot ' + d.bot.x.toFixed(1) + ' ' + d.bot.y.toFixed(1) + ' ' + d.bot.z.toFixed(1), 'bot']);
    return out;
  }
  function drawMap() {
    if (!M.on) return;
    const cv = M.cv, g = M.g, view = $('mapview'), r = dpr();
    const w = Math.round(view.clientWidth * r), h = Math.round(view.clientHeight * r);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    g.imageSmoothingEnabled = false; g.fillStyle = '#0b0d10'; g.fillRect(0, 0, w, h);
    for (const { t, img } of M.tiles.values()) { const p = toScreen(t.cx * 16, t.cz * 16), s = 16 * M.scale; if (p[0] > w || p[1] > h || p[0] + s < 0 || p[1] + s < 0) continue; g.drawImage(img, p[0], p[1], s, s); }
    const d = M.data;
    if (!d) return;
    const line = (pts, style, lw) => { if (!pts || pts.length < 2) return; g.strokeStyle = style; g.lineWidth = lw * r; g.beginPath(); pts.forEach((p, i) => { const q = toScreen(p.x, p.z); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.stroke(); };
    line(d.trail, 'rgba(255,255,255,0.35)', 1.5);
    line(d.nav.path && d.nav.path.map((p) => ({ x: p.x + 0.5, z: p.z + 0.5 })), MAP_COL.path, 2.5);
    if (d.nav.goal) { const q = toScreen(d.nav.goal.x + 0.5, d.nav.goal.z + 0.5), k = 6 * r; g.strokeStyle = MAP_COL.path; g.lineWidth = 2 * r; g.beginPath(); g.moveTo(q[0] - k, q[1] - k); g.lineTo(q[0] + k, q[1] + k); g.moveTo(q[0] + k, q[1] - k); g.lineTo(q[0] - k, q[1] + k); g.stroke(); }
    for (const m of markers()) {
      const q = toScreen(m[0], m[1]), k = (m[4] === 'ent' || m[4] === 'chest' ? 3 : 5) * r;
      g.fillStyle = m[2]; g.strokeStyle = '#000'; g.lineWidth = r;
      if (m[4] === 'bot') { const yaw = (d.bot.yaw * Math.PI) / 180, dx = -Math.sin(yaw), dz = Math.cos(yaw), a = 10 * r, b = 6 * r; g.beginPath(); g.moveTo(q[0] + dx * a, q[1] + dz * a); g.lineTo(q[0] - dx * b - dz * b, q[1] - dz * b + dx * b); g.lineTo(q[0] - dx * b + dz * b, q[1] - dz * b - dx * b); g.closePath(); g.fill(); g.stroke(); }
      else if (m[4] === 'herd' || m[4] === 'ent') { g.beginPath(); g.arc(q[0], q[1], k, 0, Math.PI * 2); g.fill(); g.stroke(); }
      else if (m[4] === 'wp') { g.beginPath(); g.moveTo(q[0], q[1] - k); g.lineTo(q[0] + k, q[1]); g.lineTo(q[0], q[1] + k); g.lineTo(q[0] - k, q[1]); g.closePath(); g.fill(); g.stroke(); }
      else { g.fillRect(q[0] - k, q[1] - k, 2 * k, 2 * k); g.strokeRect(q[0] - k, q[1] - k, 2 * k, 2 * k); }
    }
  }
  /** What is under a canvas point: the nearest marker within 10 px, else the column. */
  function describeAt(sx, sy) {
    let best = null, bd = 10 * dpr();
    for (const m of markers()) { const q = toScreen(m[0], m[1]), dd = Math.hypot(q[0] - sx, q[1] - sy); if (dd < bd) { bd = dd; best = m; } }
    const wpt = toWorld(sx, sy), bx = Math.floor(wpt[0]), bz = Math.floor(wpt[1]), c = column(bx, bz);
    const col = bx + ' ' + bz + ': ' + (!c ? 'unknown' : c.y === null ? 'nothing' : ['air', 'solid', 'water', 'avoid'][c.cls] + ' at y ' + c.y + (c.live ? '' : ' (remembered)'));
    return { bx, bz, c, text: best ? best[3] + ' (' + col + ')' : col };
  }
  async function mapPoll() {
    clearTimeout(M.t);
    if (!M.on) return;
    if (!M.busy) {
      M.busy = true;
      try {
        const p = new URLSearchParams({ r: $('map-r').value, since: String(M.since) });
        if (!$('map-follow').checked) { p.set('cx', String(Math.floor(M.view.x / 16))); p.set('cz', String(Math.floor(M.view.z / 16))); }
        if (M.win) p.set('win', [M.win.cx0, M.win.cz0, M.win.cx1, M.win.cz1].join(','));
        const res = await fetch('/map.json?' + p.toString(), { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) throw new Error('map.json ' + res.status);
        const d = await res.json();
        for (const t of d.tiles) M.tiles.set(t.cx + ',' + t.cz, tileImage(t));
        const w0 = d.window;
        for (const [k, v] of M.tiles) if (v.t.cx < w0.cx0 - 2 || v.t.cx > w0.cx1 + 2 || v.t.cz < w0.cz0 - 2 || v.t.cz > w0.cz1 + 2) M.tiles.delete(k);
        M.win = w0; M.since = d.rev; M.data = d;
        if ($('map-follow').checked && d.bot) M.view = { x: d.bot.x, z: d.bot.z };
        if (M.n++ % 5 === 0) { const mr = await fetch('/api/marks', { cache: 'no-store', credentials: 'same-origin' }); if (mr.ok) M.marks = await mr.json(); }
        text('map-info', (d.nav.busy ? 'walking' : 'idle') + (d.nav.result ? ', last goto ' + d.nav.result : '') + '; ' + M.marks.chests.length + ' chests, ' + M.marks.herds.length + ' herds');
      } catch (e) { text('map-info', 'map: ' + (e && e.message ? e.message : e)); }
      M.busy = false;
      drawMap();
    }
    M.t = setTimeout(mapPoll, MAP_POLL_V);
  }
  function mapPoint(ev) { const r = M.cv.getBoundingClientRect(); return [(ev.clientX - r.left) * dpr(), (ev.clientY - r.top) * dpr()]; }
  function mapMenu(ev) {
    const p = mapPoint(ev), at = describeAt(p[0], p[1]);
    const key = 'map:' + at.bx + ',' + at.bz;
    if (menuKey === key && !menu.hidden) return;
    openMenu(key, at.text, mapActions(at.bx, at.bz, at.c ? at.c.y : null, M.data && M.data.bot ? M.data.bot.y : null), ev.clientX, ev.clientY);
  }
  function tip(ev) {
    const p = mapPoint(ev), at = describeAt(p[0], p[1]), t = $('maptip'), r = M.cv.getBoundingClientRect();
    t.textContent = at.text; t.hidden = false;
    t.style.left = Math.min(ev.clientX - r.left + 12, r.width - 160) + 'px'; t.style.top = (ev.clientY - r.top + 12) + 'px';
  }
  function initMap() {
    M.cv = $('mapcv'); M.g = M.cv.getContext('2d');
    const cv = M.cv;
    cv.addEventListener('contextmenu', (ev) => { ev.preventDefault(); if (Date.now() - M.lp < 800) return; mapMenu(ev); });
    cv.addEventListener('pointerdown', (ev) => {
      M.down = { x: ev.clientX, y: ev.clientY, vx: M.view.x, vz: M.view.z, moved: false, id: ev.pointerId };
      if (cv.setPointerCapture) cv.setPointerCapture(ev.pointerId);
      clearTimeout(M.lpT);
      if (ev.pointerType !== 'mouse') M.lpT = setTimeout(() => { if (M.down && !M.down.moved) { M.lp = Date.now(); mapMenu(ev); } }, 550);
    });
    cv.addEventListener('pointermove', (ev) => {
      const d = M.down;
      if (d) {
        if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 8) { d.moved = true; clearTimeout(M.lpT); }
        if (d.moved) { $('map-follow').checked = false; M.view = { x: d.vx - ((ev.clientX - d.x) * dpr()) / M.scale, z: d.vz - ((ev.clientY - d.y) * dpr()) / M.scale }; drawMap(); }
      } else if (ev.pointerType === 'mouse') tip(ev);
    });
    const up = (ev) => {
      clearTimeout(M.lpT); const d = M.down; M.down = null;
      if (!d || d.moved || ev.type !== 'pointerup' || Date.now() - M.lp < 800) return;
      if (ev.button === 0 && !menu.hidden && menuKey && menuKey.indexOf('map:') === 0) closeMenu();
      tip(ev);
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { $('maptip').hidden = true; });
    cv.addEventListener('wheel', (ev) => { ev.preventDefault(); M.scale = Math.max(0.5, Math.min(24, M.scale * (ev.deltaY < 0 ? 1.25 : 0.8))); drawMap(); }, { passive: false });
    $('map-zin').addEventListener('click', () => { M.scale = Math.min(24, M.scale * 1.25); drawMap(); });
    $('map-zout').addEventListener('click', () => { M.scale = Math.max(0.5, M.scale * 0.8); drawMap(); });
    $('map-r').addEventListener('change', () => { M.since = -1; M.win = null; mapPoll(); });
    $('map-follow').addEventListener('change', () => { M.since = -1; M.win = null; if ($('map-follow').checked && M.data && M.data.bot) M.view = { x: M.data.bot.x, z: M.data.bot.z }; mapPoll(); });
    window.addEventListener('resize', drawMap);
  }
  $('mapbox').addEventListener('toggle', () => {
    M.on = !!$('mapbox').open;
    if (!M.on) { clearTimeout(M.t); return; }
    if (!M.cv) initMap();
    mapPoll();
  });
  // ---- tables fetched on demand: the Help tab (Track AM, GET /api/help) and the chest list (GET /api/chests) ----
  function table(head, rows) {
    const t = document.createElement('table'), tr = document.createElement('tr');
    for (const h of head) tr.appendChild(el('td', 'muted small', h));
    t.appendChild(tr);
    for (const r of rows) { const row = document.createElement('tr'); for (const c of r) row.appendChild(el('td', '', c)); t.appendChild(row); }
    return t;
  }
  function h2(t) { const e = el('h2', '', t); e.style.marginTop = '12px'; return e; }
  function onOpen(boxId, wrapId, url, fill) {
    $(boxId).addEventListener('toggle', async () => {
      const w = $(wrapId);
      if (!$(boxId).open || w.dataset.loaded) return;
      w.dataset.loaded = '1'; w.textContent = 'loading...';
      try {
        const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) throw new Error(url + ' ' + res.status);
        const data = await res.json();
        w.textContent = '';
        fill(w, data);
        if (boxId === 'chestbox') delete w.dataset.loaded; // the list changes: fetched again on every open
      } catch (e) { delete w.dataset.loaded; w.textContent = url + ': ' + (e && e.message ? e.message : e); }
    });
  }
  onOpen('helpbox', 'helpwrap', '/api/help', (w, h) => {
    if (!helpCmds) helpCmds = h.commands;
    w.appendChild(h2('Commands'));
    w.appendChild(table(['tier', 'group', 'syntax', 'help', 'example', 'also on its own'], h.commands.map((c) => [c.tier === 'front' ? 'front door' : 'more', c.group, '!' + c.name + (c.syntax ? ' ' + c.syntax : ''), c.help, c.example, c.auto])));
    w.appendChild(h2('Modes (now: ' + h.mode + ')'));
    const keys = h.modes.length ? Object.keys(h.modes[0].values) : [];
    w.appendChild(table(['!mode'].concat(keys), h.modes.map((m) => [m.name].concat(keys.map((k) => m.values[k])))));
    w.appendChild(h2('Settings'));
    w.appendChild(table(['group', 'setting', 'value', 'default', 'description'], h.settings.map((s) => [s.group, s.key, s.value, s.default, s.description])));
  });
  onOpen('chestbox', 'chestwrap', '/api/chests', (w, rows) => {
    if (!rows.length) { w.textContent = 'none remembered (!chests scan near home)'; return; }
    w.appendChild(table(['where', 'kind', 'slots', 'top', 'state'], rows.map((r) => [r.x + ' ' + r.y + ' ' + r.z, nice(r.kind) + (r.label ? ' "' + r.label + '"' : ''), r.size ? r.stacks + '/' + r.size : '-', r.top.map((x) => x[1] + ' ' + nice(x[0])).join(', '), r.unreachable ? 'unreachable: ' + r.unreachable : r.readAt ? 'read' : 'not read yet'])));
  });
  timed(last);
  schedule(POLL);
})();`
  .replace('MENU_JS_V', () => MENU_JS.trim())
  .replace('ICON_LIST', JSON.stringify(ICON_CLASSES))
  .replace('POLL_MS_V', String(POLL_MS))
  .replace('HIDDEN_MS_V', String(HIDDEN_POLL_MS))
  .replace('CONFIRM_V', String(CONFIRM_MS))
  .replace('MAP_POLL_V', String(MAP_POLL_MS))
  .replaceAll('QUICK_KEY_V', JSON.stringify(QUICK_KEY));
