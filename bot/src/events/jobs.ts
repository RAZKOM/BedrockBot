// Job events from the process manager (decision 0059, docs/events.md "Jobs"). The manager calls one
// line at each transition (tasks/process/manager.ts: add, finished, remove); this file turns them into
// job.started / job.finished / job.failed / job.stopped (and home.arrived for the home return).
//
// A job is any process that ends: the owner's commands, a chore's episode, the home return. The
// persistent auto processes (flee, guard, night, the chore watchers) are registered once and never
// end, so they are not jobs (flee has its own event). The outcome comes from the process's `result`
// promise when it has one (every job process does: SkillResult `{ok, reason}`, a state string like
// `done` / `failed` / `none_left`, `{state}` for a build); a process without one finishes `done`.
import type { Process, StopReason } from '../tasks/process/manager.ts';
import { currentActor } from './actor.ts';
import { events } from './bus.ts';
import { clipText as clip } from './registry.ts';

interface Tracked {
  t0: number;
  settled: boolean;
  hasResult: boolean;
}

const tracked = new WeakMap<Process, Tracked>();

const STOP_WORDS = new Set(['stopped', 'interrupted', 'replaced', 'cancelled', 'canceled', 'preempted', 'death', 'dispose', 'dropped']);
const OK_WORDS = new Set(['done', 'finished', 'complete', 'completed', 'arrived', 'ok', 'full']);
/** Numbers worth showing next to a result (`killed 3, want 3`). */
const DETAIL_KEYS = ['killed', 'want', 'gained', 'crafted', 'wanted', 'fed', 'pairs', 'deposited', 'taken', 'placed', 'dug', 'distance', 'seconds'];

export type JobOutcome = { kind: 'finished'; result: string } | { kind: 'failed'; reason: string } | { kind: 'stopped'; reason: string };

function details(o: Record<string, unknown>): string {
  const parts = DETAIL_KEYS.filter((k) => typeof o[k] === 'number').slice(0, 4).map((k) => `${k} ${String(o[k])}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** Classify a process result (pure; unit-tested). */
export function outcomeOf(v: unknown): JobOutcome {
  if (v === undefined || v === null) return { kind: 'finished', result: 'done' };
  if (typeof v === 'string') {
    if (STOP_WORDS.has(v)) return { kind: 'stopped', reason: v };
    if (OK_WORDS.has(v)) return { kind: 'finished', result: v };
    return { kind: 'failed', reason: clip(v) };
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const reason = o.reason === undefined ? undefined : typeof o.reason === 'string' ? o.reason : JSON.stringify(o.reason);
    if (typeof o.ok === 'boolean') {
      if (o.ok) return { kind: 'finished', result: clip(`${reason ?? 'ok'}${details(o)}`) };
      if (reason && STOP_WORDS.has(reason)) return { kind: 'stopped', reason };
      return { kind: 'failed', reason: clip(`${reason ?? 'failed'}${details(o)}`) };
    }
    if (typeof o.state === 'string') {
      const r = outcomeOf(o.state);
      return r.kind === 'failed' && reason ? { kind: 'failed', reason: clip(`${o.state}: ${reason}`) } : r;
    }
    return { kind: 'finished', result: `done${details(o)}` };
  }
  return { kind: 'finished', result: clip(typeof v === 'number' || typeof v === 'boolean' ? String(v) : 'done') };
}

function isPersistent(p: Process): boolean {
  return (p as unknown as { persistent?: unknown }).persistent === true;
}

function lineOf(p: Process): string {
  try {
    return clip(p.status().line);
  } catch {
    return p.name;
  }
}

const seconds = (t: Tracked): number => Math.round((Date.now() - t.t0) / 100) / 10;

function settle(p: Process, o: JobOutcome): void {
  const t = tracked.get(p);
  if (!t || t.settled) return;
  t.settled = true;
  const durationS = seconds(t);
  if (o.kind === 'finished') {
    events.emit('job.finished', { job: p.name, result: o.result, durationS });
    if (p.name === 'home') events.emit('home.arrived', { durationS });
  } else if (o.kind === 'failed') {
    events.emit('job.failed', { job: p.name, reason: o.reason, durationS });
  } else {
    const by = currentActor()?.name;
    events.emit('job.stopped', { job: p.name, reason: o.reason, durationS, ...(by ? { by } : {}) });
  }
}

/** ProcessManager.add: a job started (persistent processes are not jobs). */
export function jobAdded(p: Process): void {
  if (isPersistent(p) || tracked.has(p)) return;
  const result = (p as unknown as { result?: unknown }).result;
  const hasResult = result instanceof Promise;
  tracked.set(p, { t0: Date.now(), settled: false, hasResult });
  const by = currentActor()?.name;
  events.emit('job.started', { job: p.name, kind: p.kind, line: lineOf(p), ...(by ? { by } : {}) });
  if (hasResult) {
    (result as Promise<unknown>).then(
      (v) => {
        settle(p, outcomeOf(v));
      },
      (e: unknown) => {
        settle(p, { kind: 'failed', reason: clip(e instanceof Error ? e.message : String(e)) });
      },
    );
  }
}

/** ProcessManager.finished: it ended by itself; the result promise says how (a process without one: done). */
export function jobFinished(p: Process): void {
  const t = tracked.get(p);
  if (t && !t.hasResult) settle(p, { kind: 'finished', result: 'done' });
}

/** ProcessManager.remove: stopped before it ended (`!stop`, replaced, a death, the bot exiting). */
export function jobRemoved(p: Process, reason: StopReason): void {
  settle(p, { kind: 'stopped', reason });
}
