// A fake DOM for the panel page's browser modules (decision 0061): just what client/*.ts touches,
// built from the page's real markup (renderPanelPage), and a fake EventSource. runPage() calls
// client/main.ts start(env) with it, exactly as boot.ts does with the browser.
import { start, type Started } from '../../../src/health/panel/client/main.ts';
import type { Env } from '../../../src/health/panel/client/dom.ts';
import { VIEW_KEY } from '../../../src/health/panel/shared.ts';

export class FakeClassList {
  readonly set = new Set<string>();
  toggle(c: string, on?: boolean): boolean {
    const want = on ?? !this.set.has(c);
    if (want) this.set.add(c);
    else this.set.delete(c);
    return want;
  }
  add(c: string): void {
    this.set.add(c);
  }
  remove(c: string): void {
    this.set.delete(c);
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
}

export class FakeEl {
  textContent = '';
  className = '';
  hidden = false;
  title = '';
  value = '';
  open = false;
  src = '';
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  writes = 0;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  readonly listeners = new Map<string, (() => unknown)[]>();
  private readonly subs = new Map<string, FakeEl>();
  readonly id: string;
  constructor(id = '') {
    this.id = id;
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  checked = false;
  disabled = false;
  type = '';
  tagName = '';
  maxLength = 0;
  replaceChildren(): void {
    this.children.length = 0;
  }
  contains(e: unknown): boolean {
    return e === this || this.children.some((c) => c.contains(e));
  }
  clientWidth = 0;
  /** A canvas context that accepts every call (the map draws into it). */
  getContext(): unknown {
    return new Proxy({}, { get: (_t, k) => (k === 'createImageData' ? () => ({ data: new Uint8ClampedArray(1024) }) : () => undefined), set: () => true });
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; bottom: number } {
    return { left: 0, top: 0, width: 400, height: 380, bottom: 380 };
  }
  /** Fire with an event object (the handlers read clientX / key / preventDefault). */
  fireWith(t: string, ev: Record<string, unknown>): unknown[] {
    return (this.listeners.get(t) ?? []).map((f) => (f as (e: unknown) => unknown)({ preventDefault: () => undefined, stopPropagation: () => undefined, ...ev }));
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(t: string, fn: () => unknown): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  fire(t: string): unknown[] {
    return (this.listeners.get(t) ?? []).map((f) => f());
  }
  querySelector(sel: string): FakeEl {
    let e = this.subs.get(sel);
    if (!e) {
      e = new FakeEl();
      if (sel === '.dur') e.appendChild(new FakeEl());
      this.subs.set(sel, e);
    }
    return e;
  }
}

/** Counts writes of textContent per element (to see that an unchanged state writes nothing). */
function counting(e: FakeEl): FakeEl {
  let t = '';
  Object.defineProperty(e, 'textContent', {
    get: () => t,
    set: (v: string) => {
      t = v;
      e.writes++;
    },
  });
  return e;
}

/** A fake EventSource: the test plays the server with emit() / error(). */
export class FakeEventSource {
  static opened: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, ((m: { data: string; lastEventId: string }) => void)[]>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }
  addEventListener(t: string, fn: (m: { data: string; lastEventId: string }) => void): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  /** One server message. */
  emit(event: string, data: unknown, id = ''): void {
    this.readyState = 1;
    for (const f of this.listeners.get(event) ?? []) f({ data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId: id });
  }
  /** The connection failed: `closed` = EventSource gave up (a refused stream), else it reconnects. */
  error(closed = false): void {
    this.readyState = closed ? 2 : 0;
    this.onerror?.();
  }
}

export interface Harness {
  els: Map<string, FakeEl>;
  cells: Map<string, FakeEl>;
  timers: { fn: () => unknown; ms: number }[];
  doc: { hidden: boolean; body: FakeEl; documentElement: FakeEl; listeners: Map<string, (() => unknown)[]> };
  fetchQueue: (() => Promise<unknown>)[];
  fetched: string[];
  debug: string[];
  storage: Map<string, string>;
  /** POST bodies' commands, the settings rows, their inputs, the mode buttons. */
  posted: string[];
  rows: Map<string, FakeEl>;
  inputs: Map<string, FakeEl>;
  modeButtons: FakeEl[];
  /** The quick buttons (button.q). */
  quick: FakeEl[];
  /** Decision 0062: the map's layer radios ([data-layer]) and overlay switches ([data-ov]). */
  layers: FakeEl[];
  overlays: FakeEl[];
  started: Started;
  /** The streams the page opened (with `stream: true`). */
  streams: FakeEventSource[];
  /** Fire the document's visibilitychange. */
  visibility(hidden: boolean): void;
}

export interface PageOptions {
  storageThrows?: boolean;
  prefersLight?: boolean;
  storage?: Record<string, string>;
  /** Answers queued before the page starts (the map screen fetches while start() runs). */
  answers?: (() => Promise<unknown>)[];
  /** Give the page an EventSource (the push channel); without one it polls like an old browser. */
  stream?: boolean;
}

/** Run the page's modules on a fake DOM built from the markup. */
export function runPage(html: string, opts: PageOptions = {}): Harness {
  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    let e = els.get(id);
    if (!e) {
      e = counting(new FakeEl(id));
      els.set(id, e);
    }
    return e;
  };
  el('initial').textContent = /<script type="application\/json" id="initial">([^<]*)<\/script>/.exec(html)![1]!;
  el('modes-data').textContent = /<script type="application\/json" id="modes-data">([^<]*)<\/script>/.exec(html)?.[1] ?? '[]';
  for (const m of html.matchAll(/<\w+ id="([^"]+)"[^>]*\shidden[\s>]/g)) el(m[1]!).hidden = true;
  const cells = new Map<string, FakeEl>();
  for (const m of html.matchAll(/data-slot="([^"]+)"/g)) {
    const c = new FakeEl();
    c.dataset.slot = m[1]!;
    cells.set(m[1]!, c);
  }
  const quick = [...html.matchAll(/data-cmd="([^"]+)"/g)].map((m) => {
    const b = new FakeEl();
    b.dataset.cmd = m[1]!;
    return b;
  });
  const rows = new Map<string, FakeEl>();
  const inputs = new Map<string, FakeEl>();
  const srcs = new Map<string, FakeEl>();
  for (const m of html.matchAll(/<tr data-row="([^"]+)" data-def="([^"]*)" data-kind="([^"]+)" data-group="([^"]+)"([^>]*)>/g)) {
    const tr = new FakeEl();
    Object.assign(tr.dataset, { row: m[1]!, def: m[2]!, kind: m[3]!, group: m[4]! });
    tr.textContent = m[1]!;
    if (m[5]!.includes('changed')) tr.classList.add('changed');
    rows.set(m[1]!, tr);
    const inp = new FakeEl();
    inp.type = m[3] === 'boolean' ? 'checkbox' : m[3] === 'number' ? 'number' : 'text';
    inp.tagName = 'INPUT';
    inputs.set(m[1]!, inp);
    srcs.set(m[1]!, new FakeEl());
  }
  const grps = [...html.matchAll(/data-grp="([^"]+)"/g)].map((m) => {
    const g = new FakeEl();
    g.dataset.grp = m[1]!;
    return g;
  });
  const modeButtons = [...html.matchAll(/data-mode="([^"]+)"/g)].map((m) => {
    const b = new FakeEl();
    b.dataset.mode = m[1]!;
    return b;
  });
  // decision 0062: the map screen's layer radios and overlay switches
  const layers = [...html.matchAll(/data-layer="([^"]+)"/g)].map((m) => {
    const r = new FakeEl();
    r.dataset.layer = m[1]!;
    r.checked = m[1] === 'surface';
    return r;
  });
  const overlays = [...html.matchAll(/data-ov="([^"]+)"/g)].map((m) => {
    const c = new FakeEl();
    c.dataset.ov = m[1]!;
    return c;
  });
  // decision 0065: the view switches (every [data-goview] element has an id: the same element getElementById hands out)
  const goviews = [...html.matchAll(/<\w+[^>]*?\sid="([^"]+)"[^>]*\sdata-goview="([^"]+)"/g)].map((m) => {
    const b = el(m[1]!);
    b.dataset.goview = m[2]!;
    return b;
  });
  const h = {
    layers,
    overlays,
    quick,
    posted: [],
    rows,
    inputs,
    modeButtons,
    els,
    cells,
    timers: [],
    doc: { hidden: false, body: new FakeEl('body'), documentElement: new FakeEl('html'), listeners: new Map() },
    fetchQueue: [...(opts.answers ?? [])],
    fetched: [],
    debug: [],
    // decision 0062: the page opens on the map screen; the card tests start on the cards (a map test passes { [VIEW_KEY]: 'map' })
    storage: new Map(Object.entries({ [VIEW_KEY]: 'cards', ...opts.storage })),
    streams: [],
  } as unknown as Harness;
  const document = {
    getElementById: el,
    querySelectorAll: (sel: string) =>
      sel === '#inventory .cell' ? [...cells.values()] : sel === 'button.q' ? quick : sel === '#settings tr[data-row]' ? [...rows.values()] : sel === '#settings tr[data-grp]' ? grps : sel === 'button.mode' ? modeButtons : sel === '[data-layer]' ? layers : sel === '[data-ov]' ? overlays : sel === '[data-goview]' ? goviews : [],
    querySelector: (sel: string) => {
      const k = /^\[data-key="([^"]+)"\]:not\(button\)$/.exec(sel)?.[1];
      if (k) return inputs.get(k) ?? null;
      const src = /^\[data-src="([^"]+)"\]$/.exec(sel)?.[1];
      return src ? (srcs.get(src) ?? null) : null;
    },
    createElement: () => new FakeEl(),
    addEventListener: (t: string, fn: () => unknown) => h.doc.listeners.set(t, [...(h.doc.listeners.get(t) ?? []), fn]),
    get hidden() {
      return h.doc.hidden;
    },
    body: h.doc.body,
    documentElement: h.doc.documentElement,
    activeElement: null,
  };
  h.doc.documentElement.dataset.theme = opts.prefersLight ? 'light' : 'dark';
  const localStorage = {
    getItem: (k: string) => {
      if (opts.storageThrows) throw new Error('SecurityError');
      return h.storage.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.storageThrows) throw new Error('SecurityError');
      h.storage.set(k, v);
    },
    removeItem: (k: string) => {
      if (opts.storageThrows) throw new Error('SecurityError');
      h.storage.delete(k);
    },
  };
  const fetch = (url: string, init?: { method?: string; body?: string }) => {
    h.fetched.push(url);
    if (init?.method === 'POST') h.posted.push((JSON.parse(init.body!) as { text: string }).text);
    const next = h.fetchQueue.shift();
    return next ? next() : Promise.reject(new Error('no answer queued'));
  };
  const Source = class extends FakeEventSource {
    constructor(url: string) {
      super(url);
      h.streams.push(this);
    }
  };
  const env = {
    document,
    window: { devicePixelRatio: 1, addEventListener: () => undefined },
    fetch,
    setTimeout: (fn: () => unknown, ms: number) => h.timers.push({ fn, ms }),
    clearTimeout: () => undefined,
    localStorage,
    console: { debug: (m: string) => h.debug.push(m) },
    location: { href: '/' },
    performance,
    atob: (s: string) => atob(s),
    ...(opts.stream ? { EventSource: Source } : {}),
  };
  h.visibility = (hidden) => {
    h.doc.hidden = hidden;
    for (const f of h.doc.listeners.get('visibilitychange') ?? []) f();
  };
  h.started = start(env as unknown as Env);
  return h;
}

export const answer = (s: unknown) => () => Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(s)), json: () => Promise.resolve(s) });

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
