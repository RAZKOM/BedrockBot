// The page's <script type="module"> (decision 0061): start the panel with the real browser. The only
// module that reads browser globals; everything else gets them through main.ts start(env).
import type { Env, NotifyLike } from './dom.ts';
import { start } from './main.ts';

const w = globalThis as unknown as Env & { window: Env['window'] };

// Track P5 (docs/away.md "Notifications"): the Notification API exists only in a secure context (https, localhost);
// Chrome on Android shows one only through a service worker, which is registered on a secure origin only.
type NotificationCtor = (new (title: string, o: { body: string; tag: string }) => unknown) & { permission: string; requestPermission(): Promise<string> | void };
interface SwReg {
  showNotification(title: string, o: { body: string; tag: string }): Promise<void>;
}
const g = globalThis as unknown as {
  Notification?: NotificationCtor;
  isSecureContext?: boolean;
  navigator?: { serviceWorker?: { register(url: string, o: { scope: string }): Promise<unknown>; ready: Promise<SwReg> } };
  AudioContext?: new () => { currentTime: number; destination: unknown; resume?(): unknown; createOscillator(): { frequency: { value: number }; connect(d: unknown): unknown; start(t: number): void; stop(t: number): void }; createGain(): { gain: { value: number }; connect(d: unknown): unknown } };
};
const N = typeof g.Notification === 'function' ? g.Notification : undefined;
const secure = g.isSecureContext === true;
let sw: Promise<SwReg> | undefined;
let audio: InstanceType<NonNullable<typeof g.AudioContext>> | undefined;
const notify: NotifyLike = {
  secure,
  permission: () => (N ? N.permission : 'unsupported'),
  request: () => (N ? Promise.resolve(N.requestPermission()).then(() => N.permission) : Promise.resolve('unsupported')),
  show: (title, body, tag) => {
    if (N?.permission !== 'granted') return Promise.resolve(false);
    try {
      return Promise.resolve(Boolean(new N(title, { body, tag })));
    } catch {
      // Chrome on Android: "Illegal constructor": only a service worker registration may show one
      const c = g.navigator?.serviceWorker;
      if (!c || !secure) return Promise.resolve(false);
      sw ??= c.register('/sw.js', { scope: '/' }).then(() => c.ready);
      return sw.then((r) => r.showNotification(title, { body, tag })).then(
        () => true,
        () => false,
      );
    }
  },
  unlock: () => {
    try {
      if (!audio && g.AudioContext) audio = new g.AudioContext();
      audio?.resume?.();
    } catch {
      audio = undefined;
    }
  },
  beep: () => {
    if (!audio) return false;
    try {
      const o = audio.createOscillator();
      const v = audio.createGain();
      o.frequency.value = 880;
      v.gain.value = 0.08;
      o.connect(v);
      v.connect(audio.destination);
      o.start(audio.currentTime);
      o.stop(audio.currentTime + 0.18);
      return true;
    } catch {
      return false;
    }
  },
};

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
  notify, // Track P5
});
