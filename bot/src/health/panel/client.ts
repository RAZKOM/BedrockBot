// Track AP (docs/panel.md "Live updates"): the panel page's inline script. It renders every poll's
// /api/state into the nodes the server rendered (no innerHTML of the page, each node written only when
// its text changed), marks the page stale when a poll fails, polls every 2 s (10 s while the tab is
// hidden), and keeps the command box, quick buttons, settings, Help tab and map of Track AE / AM.
// Kept as a plain string (no build step); test/unit/health/panel-page.test.ts runs it on a fake DOM.
import { ICON_CLASSES } from './inventory.ts';

export const POLL_MS = 2000;
export const HIDDEN_POLL_MS = 10_000;

/** The script (between <script> tags; contains no backticks and no closing script tag). */
export const PANEL_SCRIPT = String.raw`(() => {
  const $ = (id) => document.getElementById(id);
  const text = (id, v) => { const e = $(id); if (e && e.textContent !== v) e.textContent = v; };
  const ICONS = new Set(ICON_LIST);
  const POLL = POLL_MS_V, HIDDEN = HIDDEN_MS_V;
  let last = JSON.parse($('initial').textContent);
  let renders = 0, lastOk = Date.now(), timer = 0, picked = null, bytes = $('initial').textContent.length;
  const atBottom = (e) => e.scrollHeight - e.scrollTop - e.clientHeight < 30;
  const nice = (n) => String(n).replace(/_/g, ' ');
  const num = (v, d) => (v == null ? '-' : (d ? Number(v).toFixed(d) : String(v)));
  const dur = (s) => { s = Math.round(s); if (s < 60) return s + ' s'; if (s < 3600) return Math.floor(s / 60) + ' min'; return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min'; };
  const width = (id, pct) => { const e = $(id); if (!e) return; const w = Math.max(0, Math.min(100, pct)).toFixed(1) + '%'; if (e.style.width !== w) e.style.width = w; };
  const durColour = (p) => (p > 50 ? 'var(--ok)' : p > 20 ? 'var(--warn)' : 'var(--bad)');
  // ---- theme (dark by default; prefers-color-scheme; a stored choice wins) ----
  const root = document.documentElement;
  const themeBtn = $('theme');
  const showTheme = () => { if (themeBtn) themeBtn.textContent = root.dataset.theme === 'light' ? 'dark' : 'light'; };
  if (themeBtn) themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('bbpanel-theme', root.dataset.theme); } catch (e) { /* storage blocked */ }
    showTheme();
  });
  showTheme();
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
    if (picked === null) { text('iteminfo', 'tap a slot for the details'); return; }
    const it = itemOf(s, picked);
    const lines = [where(picked) + ': ' + (it ? nice(it.name) : 'empty')];
    if (it) {
      lines.push('count ' + it.count);
      if (it.dur) lines.push('durability ' + it.dur.left + ' of ' + it.dur.max + ' (' + it.dur.pct + '%)');
      if (it.box) lines.push('shulker box: ' + boxLine(it.box));
    }
    text('iteminfo', lines.join('\n'));
  }
  for (const k in cells) cells[k].addEventListener('click', () => {
    if (picked !== null && cells[picked]) cells[picked].classList.remove('picked');
    picked = picked === k ? null : k;
    if (picked !== null) cells[picked].classList.add('picked');
    info(last);
  });
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
    text('v-deaths', v.deaths == null ? '-' : String(v.deaths));
    text('v-lastdeath', v.lastDeath ? v.lastDeath.cause + (v.lastDeath.messages.length ? ' (' + v.lastDeath.messages.join(', ') + ')' : '') + ', ' + new Date(v.lastDeath.ts).toLocaleTimeString() : 'none');
  }
  let stackSig = '';
  function renderStatus(s) {
    text('status', s.status.join('\n'));
    const j = s.job;
    text('job', j ? j.name + ' (' + j.state + '): ' + j.line + (j.etaS != null ? ', eta ' + dur(j.etaS) : '') : 'no job (idle)');
    const sig = JSON.stringify(s.stack);
    if (sig === stackSig) return;
    stackSig = sig;
    const st = $('stack'); st.textContent = '';
    if (s.stack.length === 0) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'no processes'; st.appendChild(li); }
    for (const e of s.stack) {
      const li = document.createElement('li');
      const b = document.createElement('span'); b.className = 'badge st-' + e.state; b.textContent = e.state; li.appendChild(b);
      const n = document.createElement('b'); n.textContent = ' ' + e.name; li.appendChild(n);
      const k = document.createElement('span'); k.className = 'muted small'; k.textContent = ' ' + e.kind + ', priority ' + e.priority; li.appendChild(k);
      const l = document.createElement('div'); l.className = 'small'; l.textContent = e.line + (e.etaS != null ? ', eta ' + dur(e.etaS) : ''); li.appendChild(l);
      st.appendChild(li);
    }
  }
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
  function render(s) {
    last = s;
    const dot = $('dot'), dc = 'dot' + (s.bot.healthy ? ' ok' : ''); if (dot.className !== dc) dot.className = dc;
    text('botname', s.bot.name || 'BedrockBot'); text('conn', s.bot.state); text('server', s.bot.server); text('task', s.bot.task); text('ver', s.bot.gameVersion);
    renderInventory(s);
    renderVitals(s);
    renderStatus(s);
    renderNumbers(s);
    const lg = $('logs'), lb = atBottom(lg); text('logs', s.logs.join('\n')); if (lb) lg.scrollTop = lg.scrollHeight;
    const ch = $('chat'), cb = atBottom(ch);
    text('chat', s.chat.map((c) => new Date(c.ts).toLocaleTimeString() + ' ' + c.text + (c.sent ? '' : '  (not sent to the game)')).join('\n'));
    if (cb) ch.scrollTop = ch.scrollHeight;
    for (const r of s.settings) {
      const src = document.querySelector('[data-src="' + r.key + '"]'); if (src && src.textContent !== r.source) src.textContent = r.source;
      const inp = document.querySelector('[data-key="' + r.key + '"]:not(button)');
      if (inp && document.activeElement !== inp && !inp.dataset.dirty && inp.value !== r.value) inp.value = r.value;
    }
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
  async function send(cmd) {
    cmd = cmd.trim(); if (!cmd) return;
    $('replies').textContent = '> ' + cmd + '\n...';
    try {
      const res = await fetch('/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ text: cmd }) });
      const r = await res.json();
      $('replies').textContent = '> ' + (r.command || cmd) + '\n' + ((r.replies && r.replies.length) ? r.replies.join('\n') : (r.error || (r.ok ? '(no reply yet; see bot chat)' : 'failed')));
    } catch (e) { $('replies').textContent = '> ' + cmd + '\nerror: ' + (e && e.message ? e.message : e); }
    schedule(300);
  }
  $('cmdform').addEventListener('submit', (ev) => { ev.preventDefault(); const v = $('cmd').value; $('cmd').value = ''; send(v); });
  for (const b of document.querySelectorAll('button.q')) b.addEventListener('click', () => send(b.dataset.cmd));
  for (const b of document.querySelectorAll('button.setbtn')) b.addEventListener('click', () => {
    const inp = document.querySelector('[data-key="' + b.dataset.key + '"]:not(button)');
    if (!inp) return; delete inp.dataset.dirty; send('!set ' + b.dataset.key + ' ' + inp.value);
  });
  for (const i of document.querySelectorAll('#settings input, #settings select')) i.addEventListener('input', () => { i.dataset.dirty = '1'; });
  $('mapbox').addEventListener('toggle', () => {
    const w = $('mapwrap');
    if ($('mapbox').open && !w.firstChild) { const f = document.createElement('iframe'); f.src = '/map'; f.title = 'map'; w.appendChild(f); }
    else if (!$('mapbox').open) w.textContent = '';
  });
  // ---- tables fetched on demand: the Help tab (Track AM, GET /api/help) and the chest list (GET /api/chests) ----
  function table(head, rows) {
    const t = document.createElement('table'), tr = document.createElement('tr');
    for (const h of head) { const th = document.createElement('td'); th.className = 'muted small'; th.textContent = h; tr.appendChild(th); }
    t.appendChild(tr);
    for (const r of rows) { const row = document.createElement('tr'); for (const c of r) { const td = document.createElement('td'); td.textContent = c; row.appendChild(td); } t.appendChild(row); }
    return t;
  }
  function h2(t) { const e = document.createElement('h2'); e.style.marginTop = '12px'; e.textContent = t; return e; }
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
  .replace('ICON_LIST', JSON.stringify(ICON_CLASSES))
  .replace('POLL_MS_V', String(POLL_MS))
  .replace('HIDDEN_MS_V', String(HIDDEN_POLL_MS));
