// The night process with a bed (wave 7, Track W; docs/survival.md "Sleep") on fakes: it prefers the
// bed near home to the shelter, walks next to it, sleeps, holds control (no nudge) until the morning
// wake-up; a refusal because of monsters waits next to the bed and defends, retrying in 20 s; three
// failures give the beds up for the night (the shelter rule takes over); !sleep with auto-sleep off;
// an urgent command makes it yield.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SleepController, SleepEvent, SleepResult } from '../../src/skills/survival/sleep.ts';
import { NightSafety, type Mover } from '../../src/tasks/night.ts';
import { NightProcess, type NightBedEvent } from '../../src/tasks/process/night.ts';
import type { BlockInfo, Vec3 } from '../../src/world/types.ts';
import { FakeMover } from './skills/pve-fakes.ts';

class FakeSleeper {
  sleeping = false;
  bed: Vec3 | undefined;
  clicks: Vec3[] = [];
  answers: SleepResult[] = [];
  wakes = 0;
  private readonly fns = new Set<(e: SleepEvent) => void>();
  private awake: (() => void)[] = [];
  sleep(p: Vec3): Promise<SleepResult> {
    this.clicks.push(p);
    const r = this.answers.shift() ?? { ok: true };
    if (r.ok) {
      this.sleeping = true;
      this.bed = p;
    }
    return Promise.resolve(r);
  }
  waitAwake(): Promise<boolean> {
    return this.sleeping ? new Promise((r) => this.awake.push(() => r(true))) : Promise.resolve(true);
  }
  wake(): void {
    this.wakes++;
    this.wakeUp(1000);
  }
  wakeUp(ms: number): void {
    this.sleeping = false;
    for (const fn of [...this.fns]) fn({ kind: 'awake', ms });
    for (const r of this.awake.splice(0)) r();
  }
  cancel(): void {}
  onEvent(fn: (e: SleepEvent) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
}

const BED: BlockInfo = { name: 'bed', stateId: 1, states: { direction: 3, head_piece_bit: 1 }, hardness: 0.2, solid: true, boxes: [] };
const AIR: BlockInfo = { name: 'air', stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] };

function setup(opts: { shelter?: Vec3 } = {}) {
  const clock = { time: 6000 as number | undefined, known: true };
  const pos = { x: 0.5, y: -60, z: 0.5 };
  const mover = new FakeMover();
  const ref: { np?: NightProcess } = {};
  const night = new NightSafety({ clock, mover: mover as unknown as Mover, position: () => pos, shelter: opts.shelter, canMove: (): boolean => ref.np?.hasControl ?? false });
  const np = new NightProcess(night, { mover, position: () => pos });
  ref.np = np;
  const sleeper = new FakeSleeper();
  const beds = new Set<string>(['4,-60,0']);
  let defends = 0;
  const events: NightBedEvent[] = [];
  np.attachBed({
    sleeper: sleeper as unknown as SleepController,
    world: { blockAt: (p) => (beds.has(`${p.x},${p.y},${p.z}`) ? BED : AIR) },
    mover,
    position: () => pos,
    centres: () => [{ x: 0, y: -60, z: 0 }],
    waypoint: () => undefined,
    defend: () => {
      defends++;
      return Promise.resolve(false);
    },
  });
  np.onBedEvent((e) => events.push(e));
  return { clock, pos, mover, night, np, sleeper, beds, events, defends: () => defends };
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe('NightProcess with a bed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefers the bed near home at night: walks there, sleeps, holds until the morning wake-up', async () => {
    const s = setup({ shelter: { x: -10, y: -60, z: 0 } });
    expect(s.np.wants()).toBe(false); // day
    s.clock.time = 18000;
    expect(s.np.wants()).toBe(true);
    s.np.start();
    expect(s.np.hasControl).toBe(false); // NightSafety must not walk to the shelter meanwhile
    expect(s.mover.gotos.at(-1)!.goal).toEqual({ type: 'near', p: { x: 4.5, y: -60, z: 0.5 }, r: 1.8 });
    expect(s.np.behaviour()).toBe('going to bed');
    s.pos.x = 3;
    s.mover.finish({ ok: true });
    await flush();
    expect(s.sleeper.clicks).toEqual([{ x: 4, y: -60, z: 0 }]);
    expect(s.np.behaviour()).toBe('sleeping');
    expect(s.np.idle()).toBe(false); // no keepalive nudge in bed
    expect(s.np.status().line).toBe('night: sleeping in the bed 4 -60 0');
    expect(s.events[0]).toEqual({ kind: 'asleep', bed: { x: 4, y: -60, z: 0 } });
    // the night is skipped: the server wakes the bot in the morning
    s.clock.time = 24000 + 10;
    s.sleeper.wakeUp(5000);
    await flush();
    expect(s.events.at(-1)).toEqual({ kind: 'awake', morning: true, ms: 5000 });
    expect(s.np.wants()).toBe(false);
    expect(s.np.sleepStatus()).toMatchObject({ slept: 1, mornings: 1, phase: 'idle' });
  });

  it('monsters near: waits next to the bed defending, tries again 20 s later', async () => {
    const s = setup();
    s.clock.time = 18000;
    s.pos.x = 3.5;
    s.sleeper.answers.push({ ok: false, reason: 'monsters', text: 'notSafe' });
    expect(s.np.wants()).toBe(true);
    s.np.start();
    await flush();
    expect(s.mover.gotos).toHaveLength(0); // already next to it
    expect(s.events[0]).toEqual({ kind: 'refused', reason: 'monsters', bed: { x: 4, y: -60, z: 0 } });
    expect(s.np.behaviour()).toBe('waiting to sleep (monsters near)');
    expect(s.np.status().line).toMatch(/^night: waiting to sleep \(monsters near\), again in (19|20) s$/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.defends()).toBeGreaterThan(5);
    expect(s.sleeper.clicks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(s.sleeper.clicks).toHaveLength(2);
    expect(s.np.behaviour()).toBe('sleeping');
  });

  it('gives the beds up after 3 failures: the shelter rule takes over', async () => {
    const s = setup({ shelter: { x: -10, y: -60, z: 0 } });
    s.clock.time = 18000;
    s.pos.x = 3.5;
    for (let i = 0; i < 3; i++) s.sleeper.answers.push({ ok: false, reason: 'obstructed', text: 'obstructed' });
    s.np.start();
    await flush();
    await vi.advanceTimersByTimeAsync(21_000);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(s.sleeper.clicks).toHaveLength(3);
    expect(s.events.at(-1)).toEqual({ kind: 'gave_up', reason: 'obstructed' });
    expect(s.np.sleepStatus().gaveUp).toBe(true);
    // the shelter still wants the bot: back to NightSafety
    expect(s.np.wants()).toBe(true);
    s.np.tick();
    expect(s.np.hasControl).toBe(true);
    expect(s.np.behaviour()).toMatch(/going to the shelter|night/);
  });

  it('!sleep with auto-sleep off; by day and without a bed it says why; an urgent command makes it yield', () => {
    const s = setup();
    s.np.autoSleep = false;
    expect(s.np.requestSleep()).toEqual({ ok: false, reason: 'not_night', timeOfDay: 6000 });
    s.clock.time = 18000;
    expect(s.np.wants()).toBe(false); // auto off
    expect(s.np.requestSleep()).toEqual({ ok: true, bed: { x: 4, y: -60, z: 0 } });
    expect(s.np.wants()).toBe(true);
    let urgent = true;
    s.np.yieldWhile = () => urgent;
    expect(s.np.wants()).toBe(false);
    urgent = false;
    expect(s.np.wants()).toBe(true);
    s.beds.clear();
    s.np.autoSleep = true;
    const t = setup();
    t.beds.clear();
    t.clock.time = 18000;
    expect(t.np.requestSleep()).toEqual({ ok: false, reason: 'no_bed' });
    expect(t.np.wants()).toBe(false);
  });

  it('pre-empted while asleep (a flight): gets up', async () => {
    const s = setup();
    s.clock.time = 18000;
    s.pos.x = 3.5;
    s.np.start();
    await flush();
    expect(s.sleeper.sleeping).toBe(true);
    s.np.pause();
    expect(s.sleeper.wakes).toBe(1);
    expect(s.np.phase).toBe('idle');
  });
});
