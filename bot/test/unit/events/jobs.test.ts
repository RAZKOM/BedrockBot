// Job events from the process manager (decision 0059, docs/events.md "Jobs"): outcomes from the
// result promise, stops with the manager's reason and the actor, persistent processes ignored.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setActor } from '../../../src/events/actor.ts';
import { events } from '../../../src/events/bus.ts';
import { outcomeOf } from '../../../src/events/jobs.ts';
import type { BotEvent } from '../../../src/events/registry.ts';
import { BaseProcess, PRIORITY, ProcessManager, type ProcessKind, type ProcessStatus } from '../../../src/tasks/process/manager.ts';

class Job extends BaseProcess {
  readonly kind: ProcessKind;
  readonly name: string;
  readonly result: Promise<unknown>;
  resolve!: (v: unknown) => void;
  constructor(name: string, kind: ProcessKind = 'user', opts: { persistent?: boolean } = {}) {
    super();
    this.name = name;
    this.kind = kind;
    this.persistent = opts.persistent ?? false;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }
  get priority(): number {
    return this.kind === 'user' ? PRIORITY.user : PRIORITY.home;
  }
  protected run(): void {}
  protected halt(): void {}
  protected override onStopped(): void {
    this.resolve('stopped');
  }
  end(v: unknown): void {
    this.finish();
    this.resolve(v);
  }
  status(): ProcessStatus {
    return { line: `${this.name} line` };
  }
}

/** A process without a result promise. */
class Plain extends Job {
  override readonly result = undefined as unknown as Promise<unknown>;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('job events', () => {
  let seen: BotEvent[];
  beforeEach(() => {
    events.reset();
    events.strict = true;
    seen = [];
    events.subscribe((e) => seen.push(e));
  });
  afterEach(() => {
    events.reset();
  });

  it('outcomeOf classifies the result shapes the processes use', () => {
    expect(outcomeOf({ ok: true })).toEqual({ kind: 'finished', result: 'ok' });
    expect(outcomeOf({ ok: true, reason: 'done', killed: 3, want: 3, fights: [] })).toEqual({ kind: 'finished', result: 'done (killed 3, want 3)' });
    expect(outcomeOf({ ok: false, reason: 'unreachable' })).toEqual({ kind: 'failed', reason: 'unreachable' });
    expect(outcomeOf({ ok: false, reason: 'interrupted' })).toEqual({ kind: 'stopped', reason: 'interrupted' });
    expect(outcomeOf('done')).toEqual({ kind: 'finished', result: 'done' });
    expect(outcomeOf('none_left')).toEqual({ kind: 'failed', reason: 'none_left' });
    expect(outcomeOf('stopped')).toEqual({ kind: 'stopped', reason: 'stopped' });
    expect(outcomeOf({ state: 'cancelled', reason: 'stopped' })).toEqual({ kind: 'stopped', reason: 'cancelled' });
    expect(outcomeOf({ state: 'failed', reason: 'no blocks' })).toEqual({ kind: 'failed', reason: 'failed: no blocks' });
    expect(outcomeOf(undefined)).toEqual({ kind: 'finished', result: 'done' });
    expect(outcomeOf({ withdraw: {}, deliver: undefined })).toEqual({ kind: 'finished', result: 'done' });
  });

  it('started, then finished with the duration; failed with the reason', async () => {
    const m = new ProcessManager();
    const a = m.add(new Job('mine'));
    a.end('done');
    await flush();
    const b = m.add(new Job('goto'));
    b.end({ ok: false, reason: 'no path' });
    await flush();
    expect(seen.map((e) => e.kind)).toEqual(['job.started', 'job.finished', 'job.started', 'job.failed']);
    expect(seen[0]!.data).toEqual({ job: 'mine', kind: 'user', line: 'mine line' });
    expect(seen[1]!.data).toMatchObject({ job: 'mine', result: 'done' });
    expect(seen[3]!.data).toMatchObject({ job: 'goto', reason: 'no path' });
    expect(typeof (seen[3]!.data as { durationS: number }).durationS).toBe('number');
  });

  it('stopped by the manager with its reason and the command actor; the late result does not add a second event', async () => {
    const m = new ProcessManager();
    setActor({ name: 'Steve', source: 'chat', command: 'kill' });
    const a = m.add(new Job('kill'));
    const b = m.add(new Job('kill')); // replaces a
    await flush(); // the actor is gone after the synchronous run
    setActor({ name: 'console', source: 'panel', command: 'stop' });
    m.stopUser();
    await flush();
    const kinds = seen.map((e) => `${e.kind} ${(e.data as { job: string }).job}`);
    expect(kinds).toEqual(['job.started kill', 'job.stopped kill', 'job.started kill', 'job.stopped kill']);
    expect(seen[0]!.data).toMatchObject({ by: 'Steve' });
    expect(seen[1]!.data).toMatchObject({ reason: 'replaced', by: 'Steve' });
    expect(seen[3]!.data).toMatchObject({ reason: 'stopped', by: 'console' });
    expect(a.done && b.done).toBe(true);
  });

  it('persistent processes are not jobs; the home return records home.arrived; a process without a result finishes done', async () => {
    const m = new ProcessManager();
    m.add(new Job('guard', 'auto', { persistent: true }));
    const home = m.add(new Job('home', 'auto'));
    home.end({ ok: true });
    await flush();
    const plain = m.add(new Plain('come'));
    plain.done = true;
    m.tick(); // the manager drops done processes
    await flush();
    expect(seen.map((e) => `${e.kind} ${(e.data as { job?: string }).job ?? ''}`)).toEqual(['job.started home', 'job.finished home', 'home.arrived ', 'job.started come', 'job.finished come']);
    expect(seen[0]!.data).toMatchObject({ kind: 'auto' });
  });

  it('a death drops the user processes as stopped (death)', async () => {
    const m = new ProcessManager();
    m.add(new Job('goto'));
    m.onDeath();
    await flush();
    expect(seen.map((e) => e.kind)).toEqual(['job.started', 'job.stopped']);
    expect(seen[1]!.data).toMatchObject({ reason: 'death' });
  });
});
