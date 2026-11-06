// A small Server-Sent Events reader for the panel's stream tests (unit and e2e): fetch the stream,
// parse each message (id, event, data) as it arrives, wait for the next one that matches.

export interface SseMessage {
  id: string;
  event: string;
  data: string;
  /** Bytes of the message on the wire. */
  bytes: number;
  at: number;
}

export interface SseStream {
  status: number;
  headers: Headers;
  messages: SseMessage[];
  /** The next message (after the ones already taken) matching `event`, within ms. */
  next(event?: string, ms?: number): Promise<SseMessage>;
  close(): void;
  /** Resolves when the server ended the stream. */
  ended: Promise<void>;
}

/**
 * Ports fetch() refuses ("bad port", the Fetch standard's list). A server on port 0 can get one where
 * the OS's dynamic range starts at 1024 (Windows with Docker / Hyper-V): start another then.
 */
export const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/**
 * Starts a server on port 0 until it gets a port fetch() can reach (not in FETCH_BAD_PORTS): `make` builds
 * a fresh one, `start` returns its port, `stop` closes one that got a bad port. Every unit test that
 * fetches from a port-0 server starts it through this.
 */
export async function onFetchablePort<S>(make: () => S, start: (s: S) => Promise<number>, stop: (s: S) => unknown): Promise<{ server: S; port: number }> {
  for (let i = 0; i < 20; i++) {
    const server = make();
    const port = await start(server);
    if (!FETCH_BAD_PORTS.has(port)) return { server, port };
    await stop(server);
  }
  throw new Error('no port fetch() accepts in 20 tries');
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseStream> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal });
  const messages: SseMessage[] = [];
  const waiters: (() => void)[] = [];
  let taken = 0;
  let endedResolve: () => void = () => undefined;
  const ended = new Promise<void>((r) => {
    endedResolve = r;
  });
  if (res.ok && res.body) {
    void (async () => {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const m: SseMessage = { id: '', event: 'message', data: '', bytes: raw.length + 2, at: Date.now() };
            const data: string[] = [];
            for (const line of raw.split('\n')) {
              const c = line.indexOf(':');
              if (c === 0) continue;
              const k = c < 0 ? line : line.slice(0, c);
              const v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
              if (k === 'id') m.id = v;
              else if (k === 'event') m.event = v;
              else if (k === 'data') data.push(v);
            }
            if (!data.length) continue; // retry: lines and comments
            m.data = data.join('\n');
            messages.push(m);
            for (const w of waiters.splice(0)) w();
          }
        }
      } catch {
        /* aborted */
      }
      endedResolve();
      for (const w of waiters.splice(0)) w();
    })();
  } else endedResolve();
  let isEnded = false;
  void ended.then(() => {
    isEnded = true;
  });
  return {
    status: res.status,
    headers: res.headers,
    messages,
    ended,
    async next(event, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        while (taken < messages.length) {
          const m = messages[taken++]!;
          if (!event || m.event === event) return m;
        }
        if (isEnded) throw new Error(`stream ended before ${event ?? 'a message'}`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no ${event ?? 'message'} within ${ms} ms`);
        await new Promise<void>((r) => {
          const t = setTimeout(r, left);
          waiters.push(() => {
            clearTimeout(t);
            r();
          });
        });
      }
    },
    close: () => ac.abort(),
  };
}
