// Track AP (docs/panel.md "Status blocks"): the header, Bot (vitals, clock), Status (job, process
// stack with Stop, Pause / Resume, Track AR), Combat, Memory, Planner, Connection and the bot chat. Each
// node is written only when its text, width or (for the stack) its signature changed.
import { atBottom, dur, nice, num } from './dom.ts';
import { stackActions } from './menu.ts';
import type { Lite, Page } from './page.ts';

export function setupCards(page: Page): (s: Lite) => void {
  const { ui } = page;
  const { text, width } = ui;

  function header(s: Lite): void {
    const dot = ui.need('dot');
    const dc = `dot${s.bot.healthy ? ' ok' : ''}`;
    if (dot.className !== dc) dot.className = dc;
    text('botname', s.bot.name || 'BedrockBot');
    text('conn', s.bot.state);
    text('server', s.bot.server);
    text('task', s.bot.task);
    text('ver', s.bot.gameVersion);
  }

  function vitals(s: Lite): void {
    const v = s.self;
    const inv = s.inventory;
    text('v-health', v.health == null ? '-' : `${num(Math.round(v.health * 10) / 10)} / 20`);
    width('b-health', v.health == null ? 0 : v.health * 5);
    text('v-food', v.food == null ? '-' : `${num(v.food)} / 20`);
    width('b-food', v.food == null ? 0 : v.food * 5);
    text('v-sat', v.saturation == null ? '-' : num(v.saturation, 1));
    width('b-sat', v.saturation == null ? 0 : v.saturation * 5);
    text('v-armour', inv ? `${inv.armourPoints} / 20` : '-');
    width('b-armour', inv ? inv.armourPoints * 5 : 0);
    const p = v.pos;
    text('v-pos', p ? `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` : '-');
    text('v-dimension', v.dimension ?? '-');
    if (v.timeOfDay == null) text('v-time', '-');
    else {
      const h = (v.timeOfDay / 1000 + 6) % 24;
      const hh = Math.floor(h);
      const mm = Math.floor((h - hh) * 60);
      text('v-time', `${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm} ${v.phase ?? ''}${v.day != null ? `, day ${v.day}` : ''} (${v.timeOfDay})`);
      const hand = ui.$('clock-hand');
      const rot = `rotate(${((h / 24) * 360 + 180).toFixed(1)} 10 10)`;
      if (hand && hand.getAttribute('transform') !== rot) hand.setAttribute('transform', rot);
      const face = ui.$('clock');
      const c = `clock ${v.phase ?? ''}`;
      if (face && face.getAttribute('class') !== c) face.setAttribute('class', c);
    }
    text('v-weather', v.weather ?? 'unknown');
    text('v-flight', v.flight ?? '-');
    text('v-deaths', v.deaths == null ? '-' : String(v.deaths));
    text('v-lastdeath', v.lastDeath ? `${v.lastDeath.cause}${v.lastDeath.messages.length ? ` (${v.lastDeath.messages.join(', ')})` : ''}, ${new Date(v.lastDeath.ts).toLocaleTimeString()}` : 'none');
  }

  let stackSig = '';
  function status(s: Lite): void {
    text('status', s.status.join('\n'));
    const j = s.job;
    text('job', j ? `${j.name} (${j.state}): ${j.line}${j.etaS != null ? `, eta ${dur(j.etaS)}` : ''}` : 'no job (idle)');
    text('paused', s.paused ? 'commands held (!pause)' : '');
    const pb = ui.need('btn-pause');
    const rb = ui.need('btn-resume');
    const pOff = s.paused === true || s.paused == null;
    if (pb.disabled !== pOff) pb.disabled = pOff;
    if (rb.disabled !== (s.paused !== true)) rb.disabled = s.paused !== true;
    const sig = JSON.stringify(s.stack);
    if (sig === stackSig) return;
    stackSig = sig;
    const st = ui.need('stack');
    ui.clear(st);
    if (s.stack.length === 0) st.appendChild(ui.el('li', 'muted', 'no processes'));
    for (const e of s.stack) {
      const li = ui.el('li');
      li.appendChild(ui.el('span', `badge st-${e.state}`, e.state));
      li.appendChild(ui.el('b', '', ` ${e.name}`));
      li.appendChild(ui.el('span', 'muted small', ` ${e.kind}, priority ${e.priority}`));
      for (const a of stackActions(e)) {
        const b = ui.el('button', 'stopbtn', a.label);
        b.type = 'button';
        b.dataset.cmd = a.cmd;
        b.title = `${a.cmd} (ends every user command)`;
        b.addEventListener('click', () => void page.send(a.cmd!, true));
        li.appendChild(b);
      }
      li.appendChild(ui.el('div', 'small', `${e.line}${e.etaS != null ? `, eta ${dur(e.etaS)}` : ''}`));
      st.appendChild(li);
    }
  }
  ui.need('btn-pause').addEventListener('click', () => void page.send('!pause', true));
  ui.need('btn-resume').addEventListener('click', () => void page.send('!resume', true));

  function numbers(s: Lite): void {
    const c = s.combat;
    text('c-fights', c ? String(c.fights) : '-');
    text('c-kills', c ? String(c.kills) : '-');
    text('c-retargets', c ? String(c.retargets) : '-');
    text('c-flees', c ? String(c.flees) : '-');
    text('c-guard', c ? String(c.guardTriggers) : '-');
    text('c-damage', c ? `${c.damageTaken} in ${c.hits} hits` : '-');
    text('c-lasthit', c?.lastHit ? `${c.lastHit.damage}, ${dur(c.lastHit.agoS)} ago` : 'none');
    const m = s.memory;
    text('m-chests', m ? `${m.chests.known} known: ${m.chests.reachable} reachable, ${m.chests.unreachable} unreachable` : 'no world cache');
    text('m-read', m ? String(m.chests.read) : '-');
    text('m-herds', m ? `${m.herds} (${m.animals} animals)` : '-');
    text('m-forests', m ? String(m.forests) : '-');
    text('m-ores', m ? `${m.ores}${m.ores ? `: ${Object.entries(m.oreKinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => `${x[1]} ${nice(x[0])}`).join(', ')}` : ''}` : '-');
    const p = s.planner;
    text('p-threads', p ? `${p.threads == null ? '-' : p.threads === 0 ? '0 (main thread)' : String(p.threads)}${p.running ? ', worker on' : ', no worker'}` : 'no planner');
    text('p-plans', p ? `${p.plans} (${p.interims} interims, ${p.results} results, ${p.failed} failed)` : '-');
    text('p-forward', p ? `${p.forwardMs} ms total, longest ${p.maxForwardMs} ms` : '-');
    text('p-crashes', p ? `${p.crashes} (${p.starts} starts)` : '-');
    const k = s.conn;
    text('k-server', k ? k.server : s.bot.server);
    text('k-version', k ? k.version : s.bot.gameVersion);
    text('k-state', k ? k.state : s.bot.state);
    text('k-uptime', k ? `${dur(k.uptimeS)}${k.sessionS != null ? `, session ${dur(k.sessionS)}` : ''}` : '-');
    text('k-reconnects', k ? `${k.reconnects} (${k.disconnects} disconnects)` : '-');
    text('k-kicks', k ? String(k.kicks) : '-');
    text('k-last', k?.lastDisconnect ?? 'none');
  }

  function chat(s: Lite): void {
    const ch = ui.need('chat');
    const follow = atBottom(ch);
    text('chat', s.chat.map((c) => `${new Date(c.ts).toLocaleTimeString()} ${c.text}${c.sent ? '' : '  (not sent to the game)'}`).join('\n'));
    if (follow) ch.scrollTop = ch.scrollHeight;
  }

  return (s) => {
    header(s);
    vitals(s);
    status(s);
    numbers(s);
    chat(s);
  };
}
