// The page's browser modules (decision 0061): the slice of the browser they use, as types, and the
// small helpers every card shares. The modules never read a browser global: main.ts start(env) gets
// everything through `Env` (boot.ts passes the real window; the unit tests pass a fake DOM), so they
// type-check without the DOM library and run unchanged on the fake DOM of panel-page.test.ts.

/** A DOM event as the handlers read it; handlers also run with no event at all (the fake DOM's fire()). */
export interface Ev {
  target?: El | null;
  key?: string;
  type?: string;
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  pointerType?: string;
  button?: number;
  deltaY?: number;
  preventDefault?(): void;
  stopPropagation?(): void;
}

export type Listener = (ev?: Ev) => unknown;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
}

/** What the map draws with (CanvasRenderingContext2D). */
export interface Ctx2D {
  imageSmoothingEnabled: boolean;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: El, x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  createImageData(w: number, h: number): { data: Uint8ClampedArray };
  putImageData(img: { data: Uint8ClampedArray }, x: number, y: number): void;
}

/** An element: every property any module touches (inputs, buttons, details, img, canvas). */
export interface El {
  textContent: string | null;
  className: string;
  hidden: boolean;
  title: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  open: boolean;
  src: string;
  type: string;
  tagName: string;
  maxLength: number;
  width: number;
  height: number;
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  clientWidth: number;
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string | undefined>;
  readonly classList: { toggle(c: string, on?: boolean): boolean; add(c: string): void; remove(c: string): void; contains(c: string): boolean };
  readonly firstChild: El | null;
  appendChild(c: El): El;
  replaceChildren?(): void;
  contains?(e: unknown): boolean;
  closest?(sel: string): El | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(t: string, fn: Listener, opts?: { passive?: boolean }): void;
  querySelector(sel: string): El | null;
  focus?(): void;
  scrollIntoView?(o: { block: string }): void;
  getBoundingClientRect?(): Rect;
  setPointerCapture?(id: number): void;
  getContext?(kind: '2d'): Ctx2D | null;
}

export interface Doc {
  getElementById(id: string): El | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
  createElement(tag: string): El;
  addEventListener(t: string, fn: Listener): void;
  readonly hidden: boolean;
  readonly body: El;
  readonly documentElement: El;
  readonly activeElement: unknown;
}

export interface FetchResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  cache?: string;
  credentials?: string;
}

/** A message of an EventSource listener. */
export interface StreamMessage {
  data: string;
  lastEventId: string;
}

export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(t: string, fn: (m: StreamMessage) => void): void;
  onerror: (() => void) | null;
  close(): void;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Everything the page reads from the browser. */
export interface Env {
  document: Doc;
  window: { devicePixelRatio?: number; addEventListener(t: string, fn: Listener): void };
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
  setTimeout(fn: () => unknown, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A getter that may throw (blocked storage): read it only through `Ui.store`. */
  localStorage: StorageLike;
  console: { debug(m: string): void };
  location: { href: string };
  performance: { now(): number };
  atob(s: string): string;
  /** Absent in an old browser: the page polls. */
  EventSource?: new (url: string) => EventSourceLike;
}

/** The helpers each card uses (one instance per page). */
export interface Ui {
  env: Env;
  doc: Doc;
  /** An element by id (null when the markup has none). */
  $: (id: string) => El | null;
  /** An element the markup always has (the guard test checks every id the modules name). */
  need: (id: string) => El;
  /** Write a text node only when it changed. */
  text: (id: string, v: string) => void;
  /** A bar's width in percent, written only when it changed. */
  width: (id: string, pct: number) => void;
  el: (tag: string, cls?: string, txt?: string | null) => El;
  clear: (e: El) => void;
  store: { get: (k: string) => string | null; set: (k: string, v: string | null) => void };
}

export function makeUi(env: Env): Ui {
  const doc = env.document;
  const $ = (id: string): El | null => doc.getElementById(id);
  const need = (id: string): El => {
    const e = doc.getElementById(id);
    if (!e) throw new Error(`panel: the page has no #${id}`);
    return e;
  };
  return {
    env,
    doc,
    $,
    need,
    text: (id, v) => {
      const e = $(id);
      if (e && e.textContent !== v) e.textContent = v;
    },
    width: (id, pct) => {
      const e = $(id);
      if (!e) return;
      const w = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
      if (e.style.width !== w) e.style.width = w;
    },
    el: (tag, cls, txt) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (txt != null) e.textContent = txt;
      return e;
    },
    clear: (e) => {
      if (e.replaceChildren) e.replaceChildren();
      else e.textContent = '';
    },
    store: {
      get: (k) => {
        try {
          return env.localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          if (v == null) env.localStorage.removeItem(k);
          else env.localStorage.setItem(k, v);
        } catch {
          /* storage blocked: the choice is not kept */
        }
      },
    },
  };
}

/** `iron_sword` -> `iron sword`. */
export const nice = (n: unknown): string => String(n).replace(/_/g, ' ');
/** A number for a card ('-' when unknown), d decimals. */
export const num = (v: number | null | undefined, d?: number): string => (v == null ? '-' : d ? Number(v).toFixed(d) : String(v));
/** Seconds as the cards say them: 12 s, 3 min, 1 h 5 min. */
export const dur = (s: number): string => {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
/** A scrolled box is at (or near) its bottom: keep following new lines. */
export const atBottom = (e: El): boolean => e.scrollHeight - e.scrollTop - e.clientHeight < 30;
/** s, or d when s is missing or empty (a text node, an optional name). */
export const orElse = (s: string | null | undefined, d: string): string => (s === null || s === undefined || s === '' ? d : s);
/** An error's message. */
export const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
