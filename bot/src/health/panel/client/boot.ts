// The page's <script type="module"> (decision 0061): start the panel with the real browser. The only
// module that reads browser globals; everything else gets them through main.ts start(env).
import type { Env } from './dom.ts';
import { start } from './main.ts';

const w = globalThis as unknown as Env & { window: Env['window'] };
start({
  document: w.document,
  window: w.window,
  fetch: (url, init) => w.fetch(url, init),
  setTimeout: (fn, ms) => w.setTimeout(fn, ms),
  clearTimeout: (h) => w.clearTimeout(h),
  get localStorage() {
    return w.localStorage; // may throw (blocked storage): dom.ts Ui.store catches it
  },
  console: w.console,
  location: w.location,
  performance: w.performance,
  atob: (s) => w.atob(s),
  ...(typeof w.EventSource === 'function' ? { EventSource: w.EventSource } : {}),
});
