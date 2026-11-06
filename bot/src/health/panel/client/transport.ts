// How the page gets the state (docs/panel.md "Live updates", decision 0061):
//   stream  GET /api/stream?topics=state (Server-Sent Events): a snapshot, then deltas (delta.ts) about
//           once a second; EventSource reconnects by itself with Last-Event-ID (the server resumes or
//           sends a snapshot);
//   poll    GET /api/state?lite=1 every POLL_MS: the fallback when there is no EventSource (an old
//           browser), when the stream is refused (503: too many streams) or never delivers (a proxy that
//           buffers), or keeps dropping; after STREAM_RETRY_MS of polling (doubling per failure, at most
//           8 min) the stream is tried again;
//   hidden  a hidden tab closes the stream and polls every HIDDEN_POLL_MS (as before the stream): no
//           per-client throttle state on the server, no stream slot held by a background tab (phones
//           suspend them anyway); visible again reopens the stream at once (a fresh snapshot).
// A failed poll or a dropped stream calls `fail` (the stale badge and "Panel not answering"); the next
// state calls `ok`. Deltas apply only to a state that came from the same stream: a polled state drops
// the stream id, so the next stream starts with a snapshot.
import { HIDDEN_POLL_MS, POLL_MS, STATE_TOPIC, STREAM_OPEN_MS, STREAM_PATH, STREAM_RETRY_MS, STREAM_STALL_MS, HELLO_EVENT, HEARTBEAT_EVENT, type StreamHello } from '../shared.ts';
import { applyDelta, type DeltaOp, type Json } from './delta.ts';
import { why, type EventSourceLike, type StreamMessage } from './dom.ts';
import type { Lite, Page } from './page.ts';

export interface TransportHooks {
  /** A new state: the bytes it took on the wire, how it came. */
  state(s: Lite, bytes: number, via: 'poll' | 'snapshot' | 'delta'): void;
  ok(): void;
  fail(why: string): void;
}

export interface Transport {
  start(): void;
  /** After a command: poll in 300 ms (the stream pushes by itself). */
  refreshSoon(): void;
  mode(): 'stream' | 'poll';
  /** For the console line and the tests. */
  info(): { mode: 'stream' | 'poll'; boot: string; lastId: string; fails: number; retryAt: number };
  /**
   * Also listen to another stream topic (docs/panel.md "Add a topic"): `fn` gets each message's data
   * (JSON text) and id. Only while the page streams: a topic needs its own fallback for polling.
   * Registering while a stream is open reopens it with the new topic list (resuming from the last id).
   */
  on(topic: string, fn: (data: string, id: string) => void): void;
}

const CLOSED = 2;
const RETRY_MAX_MS = 8 * 60_000;

export function setupTransport(page: Page, hooks: TransportHooks): Transport {
  const env = page.ui.env;
  const doc = page.ui.doc;
  let es: EventSourceLike | null = null;
  let got = false; // a state arrived on the open stream
  let lastId = '';
  let boot = '';
  let fails = 0;
  let errors = 0;
  let retryAt = 0;
  let timer: unknown = 0;
  let watchdog: unknown = 0;
  const extra = new Map<string, (data: string, id: string) => void>(); // topics beyond the state (on())

  const schedule = (ms: number): void => {
    env.clearTimeout(timer);
    timer = env.setTimeout(poll, ms); // the promise is the timer's result (the tests await it)
  };
  const wantStream = (): boolean => !!env.EventSource && !doc.hidden && Date.now() >= retryAt;

  function closeStream(): void {
    env.clearTimeout(watchdog);
    if (es) {
      es.onerror = null;
      es.close();
    }
    es = null;
    got = false;
  }
  /** The stream does not work here: poll, try again later. */
  function fallback(reason: string): void {
    closeStream();
    fails++;
    retryAt = Date.now() + Math.min(RETRY_MAX_MS, STREAM_RETRY_MS * 2 ** (fails - 1));
    env.console.debug(`panel: stream off (${reason}); polling, next try in ${Math.round((retryAt - Date.now()) / 1000)} s`);
    schedule(0);
  }
  const watch = (ms: number, reason: string): void => {
    env.clearTimeout(watchdog);
    watchdog = env.setTimeout(() => fallback(reason), ms);
  };

  function onState(m: StreamMessage): void {
    let msg: { snap?: Lite; d?: DeltaOp[] };
    try {
      msg = JSON.parse(m.data) as { snap?: Lite; d?: DeltaOp[] };
      if (msg.snap) {
        page.last = msg.snap;
      } else if (msg.d && lastId) {
        page.last = applyDelta(page.last as unknown as Json, msg.d) as unknown as Lite;
      } else throw new Error('a delta before any snapshot');
    } catch (e) {
      // a broken delta: start over with a snapshot (a new stream without an id)
      env.console.debug(`panel: stream state ${why(e)}; reopening`);
      lastId = '';
      openStream();
      return;
    }
    got = true;
    lastId = m.lastEventId || lastId;
    errors = 0;
    fails = 0;
    watch(STREAM_STALL_MS, 'quiet');
    hooks.state(page.last, m.data.length, msg.snap ? 'snapshot' : 'delta');
    hooks.ok();
  }

  function openStream(): void {
    closeStream();
    env.clearTimeout(timer);
    const Source = env.EventSource;
    if (!Source) {
      schedule(0);
      return;
    }
    const topics = [STATE_TOPIC, ...extra.keys()].join(',');
    const url = `${STREAM_PATH}?topics=${topics}${lastId ? `&last=${encodeURIComponent(lastId)}` : ''}`;
    let s: EventSourceLike;
    try {
      s = new Source(url);
    } catch (e) {
      fallback(why(e));
      return;
    }
    es = s;
    watch(STREAM_OPEN_MS, 'no state after opening (a proxy buffering?)');
    s.addEventListener(HELLO_EVENT, (m) => {
      try {
        const h = JSON.parse(m.data) as StreamHello;
        if (!h.resumed) lastId = ''; // a snapshot follows; no delta applies to the old state
        boot = h.boot;
      } catch {
        /* the state messages decide */
      }
    });
    s.addEventListener(STATE_TOPIC, onState);
    s.addEventListener(HEARTBEAT_EVENT, () => {
      if (got) watch(STREAM_STALL_MS, 'quiet');
    });
    for (const [topic, fn] of extra) {
      s.addEventListener(topic, (m) => {
        if (lastId) lastId = m.lastEventId || lastId; // one sequence over every topic: resume after this
        if (got) watch(STREAM_STALL_MS, 'quiet');
        try {
          fn(m.data, m.lastEventId);
        } catch (e) {
          env.console.debug(`panel: stream ${topic}: ${why(e)}`);
        }
      });
    }
    s.onerror = () => {
      if (es !== s) return;
      if (s.readyState === CLOSED) {
        fallback('refused'); // not 200 text/event-stream (503 too many streams, 401): EventSource gave up
        return;
      }
      // the connection dropped; EventSource reconnects by itself (with Last-Event-ID)
      errors++;
      hooks.fail('offline: the stream dropped');
      if (errors >= 3) fallback('keeps dropping');
    };
  }

  async function poll(): Promise<void> {
    let good = false;
    try {
      const res = await env.fetch('/api/state?lite=1', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) {
        env.location.href = '/';
        return;
      }
      if (!res.ok) throw new Error(`state ${res.status}`);
      const body = await res.text();
      const s = JSON.parse(body) as Lite;
      page.last = s;
      lastId = ''; // a polled state: the next stream starts with a snapshot
      hooks.state(s, body.length, 'poll');
      hooks.ok();
      good = true;
    } catch (e) {
      hooks.fail(`offline: ${why(e)}`);
    }
    if (good && wantStream()) {
      openStream();
      return;
    }
    schedule(doc.hidden ? HIDDEN_POLL_MS : POLL_MS);
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) {
      if (es) {
        closeStream();
        schedule(HIDDEN_POLL_MS);
      }
      return;
    }
    if (wantStream()) openStream();
    else schedule(0);
  });

  const mode = (): 'stream' | 'poll' => (es ? 'stream' : 'poll');
  return {
    start: () => {
      if (wantStream()) openStream();
      else schedule(POLL_MS);
    },
    refreshSoon: () => {
      if (!es) schedule(300);
    },
    mode,
    info: () => ({ mode: mode(), boot, lastId, fails, retryAt }),
    on: (topic, fn) => {
      extra.set(topic, fn);
      if (es) openStream();
    },
  };
}
