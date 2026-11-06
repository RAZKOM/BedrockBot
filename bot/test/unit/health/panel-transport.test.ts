// Decision 0061: how the page gets the state (client/transport.ts) on the fake DOM with a fake
// EventSource: the stream when it works (a snapshot, deltas, no polling), the poll when it does not
// (refused, never delivers, keeps dropping) and the stream again later, a dropped stream shows the stale
// badge and "Panel not answering" like a failed poll, a hidden tab closes the stream and polls every
// 10 s, a broken delta reopens the stream for a snapshot, and a command does not schedule a poll.
import { describe, expect, it } from 'vitest';
import { diffJson, type Json } from '../../../src/health/panel/client/delta.ts';
import { renderPanelPage } from '../../../src/health/panel/page.ts';
import { HIDDEN_POLL_MS, POLL_MS, STREAM_OPEN_MS, STREAM_RETRY_MS, STREAM_STALL_MS } from '../../../src/health/panel/shared.ts';
import { liteState } from '../../../src/health/panel/state.ts';
import { answer, flush, runPage, type Harness } from './panel-dom.ts';
import { fullState } from './panel-fixtures.ts';

const snapOf = (over: Parameters<typeof fullState>[0] = {}): Json => JSON.parse(JSON.stringify(liteState(fullState(over)))) as Json;
const lastTimer = (h: Harness, ms: number) => [...h.timers].reverse().find((t) => t.ms === ms);

describe('page transport: the stream', () => {
  it('opens the stream at once, renders the snapshot and the deltas, and does not poll', () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true });
    expect(h.streams).toHaveLength(1);
    const es = h.streams[0]!;
    expect(es.url).toBe('/api/stream?topics=state');
    expect(h.timers.some((t) => t.ms === POLL_MS)).toBe(false);
    expect(h.started.transport.mode()).toBe('stream');
    const s0 = snapOf();
    es.emit('hello', { boot: 'b', resumed: false, topics: ['state'], hb: 5000 });
    es.emit('state', { snap: s0 }, 'b.1');
    const s1 = snapOf({ vitals: () => ({ health: 9, food: 18 }) });
    es.emit('state', { d: diffJson(s0, s1) }, 'b.2');
    expect(h.els.get('v-health')!.textContent).toBe('9 / 20');
    expect(h.started.transport.info()).toMatchObject({ mode: 'stream', boot: 'b', lastId: 'b.2', fails: 0 });
    expect(h.debug.filter((l) => l.startsWith('panel: render'))).toHaveLength(1); // the embedded state; then every 30th
    expect(h.timers.some((t) => t.ms === POLL_MS)).toBe(false); // still no poll
    // a command: no poll after it either (the server pushes the effect)
    const before = h.timers.length;
    h.fetchQueue.push(answer({ ok: true, command: '!pos', replies: ['pos 1 2 3'] }));
    h.els.get('cmd')!.value = '!pos';
    h.els.get('cmdform')!.fireWith('submit', {});
    return flush().then(() => {
      expect(h.posted).toEqual(['!pos']);
      expect(h.timers.slice(before).some((t) => t.ms === 300)).toBe(false);
    });
  });

  it('a delta before any snapshot, or one that does not apply, reopens the stream without an id (a snapshot follows)', () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true });
    const es = h.streams[0]!;
    es.emit('state', { d: [['s', ['self', 'health'], 3]] }, 'b.5');
    expect(es.closed).toBe(true);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1]!.url).toBe('/api/stream?topics=state');
    const es2 = h.streams[1]!;
    es2.emit('state', { snap: snapOf() }, 'b.6');
    es2.emit('state', { d: [['s', ['no', 'such', 'path'], 1]] }, 'b.7');
    expect(h.streams).toHaveLength(3);
    expect(h.streams[2]!.url).toBe('/api/stream?topics=state');
  });

  it('a dropped stream shows the stale badge and the banner; EventSource reconnects, a resumed stream clears them', () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true });
    const es = h.streams[0]!;
    const s0 = snapOf();
    es.emit('state', { snap: s0 }, 'b.1');
    es.error(); // CONNECTING: it retries by itself
    expect(h.els.get('stale')!.hidden).toBe(false);
    expect(h.els.get('err')!.textContent).toBe('offline: the stream dropped');
    expect(h.els.get('link-title')!.textContent).toBe('Panel not answering');
    expect(h.streams).toHaveLength(1); // the same EventSource reconnects
    es.emit('hello', { boot: 'b', resumed: true, topics: ['state'], hb: 5000 });
    es.emit('state', { d: diffJson(s0, snapOf({ vitals: () => ({ health: 12, food: 18 }) })) }, 'b.2');
    expect(h.els.get('stale')!.hidden).toBe(true);
    expect(h.els.get('panel-link')!.hidden).toBe(true);
    expect(h.els.get('v-health')!.textContent).toBe('12 / 20');
  });

  it('refused (503, 401) or three drops in a row: poll, then try the stream again later', async () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true });
    h.streams[0]!.error(true); // CLOSED: EventSource gave up
    expect(h.started.transport.mode()).toBe('poll');
    const retry = h.started.transport.info().retryAt;
    expect(retry - Date.now()).toBeGreaterThan(STREAM_RETRY_MS - 1000);
    expect(h.debug.at(-1)).toMatch(/^panel: stream off \(refused\); polling, next try in 30 s$/);
    expect(h.timers.at(-1)!.ms).toBe(0);
    h.fetchQueue.push(answer(liteState(fullState({ vitals: () => ({ health: 5, food: 18 }) }))));
    await h.timers.at(-1)!.fn();
    expect(h.els.get('v-health')!.textContent).toBe('5 / 20');
    expect(h.fetched.at(-1)).toBe('/api/state?lite=1');
    expect(h.timers.at(-1)!.ms).toBe(POLL_MS); // before retryAt: keep polling
    // three drops without a state in between: polling too, and the wait doubles
    const g = runPage(renderPanelPage(fullState()), { stream: true });
    const es = g.streams[0]!;
    es.error();
    es.error();
    expect(g.started.transport.mode()).toBe('stream');
    es.error();
    expect(g.started.transport.mode()).toBe('poll');
    expect(g.started.transport.info().fails).toBe(1);
  });

  it('a stream that never delivers (a buffering proxy) or goes quiet falls back by its watchdog', () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true });
    const open = lastTimer(h, STREAM_OPEN_MS)!;
    open.fn();
    expect(h.streams[0]!.closed).toBe(true);
    expect(h.started.transport.mode()).toBe('poll');
    const g = runPage(renderPanelPage(fullState()), { stream: true });
    g.streams[0]!.emit('state', { snap: snapOf() }, 'b.1');
    lastTimer(g, STREAM_STALL_MS)!.fn();
    expect(g.streams[0]!.closed).toBe(true);
    expect(g.debug.some((l) => l.includes('stream off (quiet)'))).toBe(true);
  });

  it('a hidden tab closes the stream and polls every 10 s; visible again reopens it (resuming from the last id)', () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true });
    h.streams[0]!.emit('state', { snap: snapOf() }, 'b.4');
    h.visibility(true);
    expect(h.streams[0]!.closed).toBe(true);
    expect(h.timers.at(-1)!.ms).toBe(HIDDEN_POLL_MS);
    h.visibility(false);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1]!.url).toBe('/api/stream?topics=state&last=b.4');
  });

  it('another topic (docs/panel.md "Add a topic"): page.listen joins the stream; its ids move the resume point', () => {
    const h = runPage(renderPanelPage(fullState()), { stream: true });
    h.streams[0]!.emit('state', { snap: snapOf() }, 'b.1');
    const got: [string, string][] = [];
    h.started.page.listen('events', (data, id) => got.push([data, id]));
    expect(h.streams[0]!.closed).toBe(true); // reopened with the new topic list, resuming
    const es = h.streams[1]!;
    expect(es.url).toBe('/api/stream?topics=state,events&last=b.1');
    es.emit('events', { text: 'chest emptied' }, 'b.2');
    expect(got).toEqual([['{"text":"chest emptied"}', 'b.2']]);
    expect(h.started.transport.info().lastId).toBe('b.2');
    h.started.page.listen('jobs', () => {
      throw new Error('a broken card');
    });
    h.streams[2]!.emit('jobs', { n: 1 }, 'b.3'); // a throwing listener is logged, the stream goes on
    expect(h.debug.at(-1)).toBe('panel: stream jobs: a broken card');
    expect(h.streams[2]!.closed).toBe(false);
  });

  it('no EventSource (an old browser): the page polls as before', () => {
    const h = runPage(renderPanelPage(fullState()));
    expect(h.streams).toHaveLength(0);
    expect(h.started.transport.mode()).toBe('poll');
    expect(h.timers.at(-1)!.ms).toBe(POLL_MS);
  });
});
