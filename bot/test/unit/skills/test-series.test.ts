// Track T1 (ADR 0075): the run loop (skills/test/series.ts) against a scripted bot on a virtual clock.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/connection/types.ts';
import type { RestoreResult } from '../../../src/skills/test/recovery.ts';
import { parseTripStats, runLine, summaryLine, TestSeries, type RunRecord, type RunSpec, type SeriesPorts, type SeriesSummary } from '../../../src/skills/test/series.ts';

/** One trip: per 100 ms step what the body does; the script ends with replies and the bot idle. */
interface Step {
  dx?: number;
  glide?: boolean;
  health?: number;
  die?: boolean;
  say?: string;
}

class Bot {
  t = 0;
  pos: Vec3 = { x: 0, y: 64, z: 0 };
  health = 20;
  deaths = 0;
  gliding = false;
  busy = false;
  replies = new Set<(m: string) => void>();
  said: string[] = [];
  dispatched: string[] = [];
  restores: Vec3[] = [];
  records: (RunRecord | SeriesSummary)[] = [];
  heals = 0;
  stops = 0;
  recoverAt: number | undefined;
  restoreFails = false;
  private script: Step[] = [];
  /** The script of each dispatched trip, in order. */
  trips: Step[][] = [];

  tick(): void {
    if (this.recoverAt !== undefined && this.t >= this.recoverAt) this.recoverAt = undefined;
    const s = this.script.shift();
    if (!s) {
      this.busy = false;
      this.gliding = false;
      return;
    }
    this.busy = true;
    this.gliding = s.glide ?? false;
    if (s.dx) this.pos = { ...this.pos, x: this.pos.x + s.dx };
    if (s.health !== undefined) this.health = s.health;
    if (s.die) {
      this.health = 0;
      this.deaths++;
      this.script = [];
      this.busy = false;
      this.recoverAt = this.t + 3000;
    }
    if (s.say) for (const fn of [...this.replies]) fn(s.say);
  }

  ports(): SeriesPorts {
    return {
      restore: (start): Promise<RestoreResult> => {
        this.restores.push(start);
        if (this.restoreFails) return Promise.resolve({ ok: false, steps: [], why: 'tp: refused commands.generic.permission.selector', commands: 1 });
        this.pos = { x: start.x + 0.5, y: start.y, z: start.z + 0.5 };
        this.health = 20;
        return Promise.resolve({ ok: true, steps: [`tp ${start.x} ${start.y} ${start.z}`], commands: 1 });
      },
      heal: () => {
        this.heals++;
        this.health = 20;
        return Promise.resolve(true);
      },
      dispatch: (cmd) => {
        this.dispatched.push(cmd);
        this.script = [...(this.trips.shift() ?? [])];
        this.busy = this.script.length > 0;
      },
      onReply: (fn) => {
        this.replies.add(fn);
        return () => this.replies.delete(fn);
      },
      busy: () => this.busy,
      position: () => ({ ...this.pos }),
      gliding: () => this.gliding,
      health: () => this.health,
      deaths: () => this.deaths,
      recovered: () => {
        while (this.recoverAt !== undefined) {
          this.t += 100;
          this.tick();
        }
        this.health = 20;
        return Promise.resolve();
      },
      stopTrip: () => {
        this.stops++;
        this.script = [];
        this.busy = false;
        this.gliding = false;
      },
      healBelow: () => 14,
      write: (r) => this.records.push(r),
      say: (m) => this.said.push(m),
      now: () => this.t,
      sleep: (ms) => {
        this.t += ms;
        this.tick();
        return Promise.resolve();
      },
    };
  }
}

const walk = (n: number, end: string): Step[] => [...Array.from({ length: n }, () => ({ dx: 1 })), { say: end }];
const GOTO: RunSpec = { kind: 'goto', name: 'goto base', start: { x: 0, y: 64, z: 0 }, goal: { x: 20, y: 64, z: 0 }, command: 'goto base' };
const opts = { timeoutMs: 120_000, stuckMs: 10_000, quietMs: 5000 };

describe('TestSeries', () => {
  it('3 runs: restore before each, the command dispatched, arrival measured at the goal, a line per run and a summary', async () => {
    const bot = new Bot();
    bot.trips = [walk(20, 'arrived at base (20 64 0)'), walk(20, 'arrived at base (20 64 0)'), walk(12, 'goto: unreachable')];
    const s = new TestSeries(GOTO, bot.ports(), { ...opts, runs: 3 });
    const sum = await s.run();
    expect(bot.dispatched).toEqual(['goto base', 'goto base', 'goto base']);
    expect(bot.restores).toHaveLength(3);
    const runs = bot.records.filter((r): r is RunRecord => r.type === 'run');
    expect(runs.map((r) => r.end)).toEqual(['arrived', 'arrived', 'failed']);
    expect(runs[0]).toMatchObject({ arrived: true, endDistance: 0, deaths: 0, damage: 0, flownShare: 0, pathBlocks: 20, reason: 'arrived at base (20 64 0)', run: 1, of: 3 });
    expect(runs[2]).toMatchObject({ arrived: false, endDistance: 8, reason: 'goto: unreachable' });
    expect(sum).toMatchObject({ type: 'summary', runs: 3, planned: 3, arrived: 2, deaths: 0, ends: { arrived: 2, failed: 1 } });
    expect(bot.said).toHaveLength(3);
    expect(bot.said[0]).toMatch(/^test goto base 1\/3: arrived in \d+ s; damage 0, flown 0%$/);
    expect(summaryLine(sum)).toMatch(/^test goto base: 2\/3 arrived, [\d.]+ s a run, damage 0, 0 deaths, flown 0%, 0 bail-outs; ends arrived 2, failed 1$/);
  });

  it('a death ends the run, the recovery is waited for, the series goes on', async () => {
    const bot = new Bot();
    bot.trips = [walk(20, 'arrived at base (20 64 0)'), [{ dx: 1 }, { dx: 1, health: 12 }, { dx: 1 }, { die: true }], walk(20, 'arrived at base (20 64 0)')];
    const s = new TestSeries(GOTO, bot.ports(), { ...opts, runs: 3 });
    const sum = await s.run();
    const runs = bot.records.filter((r): r is RunRecord => r.type === 'run');
    expect(runs.map((r) => r.end)).toEqual(['arrived', 'died', 'arrived']);
    expect(runs[1]).toMatchObject({ deaths: 1, arrived: false, endDistance: null, heals: 1 });
    expect(runs[1]!.damage).toBeGreaterThanOrEqual(20); // 20 -> 12 (healed to 20) -> 0
    expect(runs[1]!.endAt).toMatchObject({ x: 3.5 }); // where it died, not where the recovery put it
    expect(sum).toMatchObject({ deaths: 1, arrived: 2, ends: { arrived: 2, died: 1 } });
  });

  it('flown share from the gliding flag; bail-outs and rockets from the corridor end line', async () => {
    const bot = new Bot();
    const end = 'arrived at cave_end along a corridor (fly 30, walk 10); 4 rockets, 1 cruise, 2 underground (1 bailed out), 1 walk, 0 re-plans, 12.3 s';
    bot.trips = [[...Array.from({ length: 10 }, () => ({ dx: 1, glide: true })), ...Array.from({ length: 10 }, () => ({ dx: 1 })), { say: end }]];
    const spec: RunSpec = { kind: 'cave', name: 'cave', start: { x: 0, y: 64, z: 0 }, goal: { x: 20, y: 64, z: 0 }, command: 'fly cave_end' };
    await new TestSeries(spec, bot.ports(), { ...opts, runs: 1 }).run();
    const r = bot.records[0] as RunRecord;
    expect(r).toMatchObject({ end: 'arrived', flownShare: 0.5, flownBlocks: 10, pathBlocks: 20, bailouts: 1, rockets: 4 });
    expect(runLine(r)).toContain('flown 50%, 1 bail-out');
  });

  it('a corridor trip between its steps (no process, no reply) is not taken for the end', async () => {
    const bot = new Bot();
    const quiet = Array.from({ length: 80 }, () => ({})); // 8 s of nothing (a proof in the worker)
    bot.trips = [[{ say: 'flying route r1 (4 waypoints) (cave style); elytra 400/432' }, { dx: 1 }, ...quiet, ...walk(19, 'arrived at r1_end along a corridor (fly 20); 2 rockets, 1 cruise, 1 underground, 0 walks, 0 re-plans, 9 s')]];
    const spec: RunSpec = { kind: 'route', name: 'route r1', start: { x: 0, y: 64, z: 0 }, goal: { x: 20, y: 64, z: 0 }, command: 'fly route r1' };
    const ports = bot.ports();
    const s = new TestSeries(spec, { ...ports, busy: () => bot.busy && bot.t % 1000 < 100 /* no process most of the time: the gaps between the corridor's steps */ }, { ...opts, runs: 1, quietMs: 3000 });
    await s.run();
    expect((bot.records[0] as RunRecord).end).toBe('arrived');
  });

  it('stuck: no progress while busy ends the run, the trip is stopped and the bot sent back to the start', async () => {
    const bot = new Bot();
    bot.trips = [[{ dx: 1 }, ...Array.from({ length: 200 }, () => ({ dx: 0.001 }))]];
    await new TestSeries(GOTO, bot.ports(), { ...opts, runs: 1 }).run();
    const r = bot.records[0] as RunRecord;
    expect(r.end).toBe('stuck');
    expect(bot.stops).toBe(1);
    expect(bot.restores).toHaveLength(2); // before the run, and back to the start after it
    expect(r.restore.some((x) => x.startsWith('after: tp'))).toBe(true);
  });

  it('quiet: no end line and idle', async () => {
    const bot = new Bot();
    bot.trips = [[{ dx: 1 }, { dx: 1 }]];
    await new TestSeries(GOTO, bot.ports(), { ...opts, runs: 1 }).run();
    expect(bot.records[0]).toMatchObject({ end: 'quiet', arrived: false });
  });

  it('stop() ends the run in progress and starts no more; a failed restore ends the series', async () => {
    const bot = new Bot();
    bot.trips = [walk(200, 'arrived at base'), walk(20, 'arrived at base')];
    const s = new TestSeries(GOTO, bot.ports(), { ...opts, runs: 2 });
    const done = s.run();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    s.stop();
    const sum = await done;
    expect(sum).toMatchObject({ runs: 1, planned: 2, stopped: true, ends: { stopped: 1 } });
    expect(summaryLine(sum)).toContain('(1 of 2 runs, stopped)');
    const b2 = new Bot();
    b2.restoreFails = true;
    const sum2 = await new TestSeries(GOTO, b2.ports(), { ...opts, runs: 3 }).run();
    expect(sum2).toMatchObject({ runs: 1, ends: { setup: 1 } });
    expect(b2.dispatched).toEqual([]);
  });

  it('timeout', async () => {
    const bot = new Bot();
    bot.trips = [walk(2000, 'arrived at base')];
    await new TestSeries(GOTO, bot.ports(), { ...opts, runs: 1, timeoutMs: 5000 }).run();
    expect(bot.records[0]).toMatchObject({ end: 'timeout' });
  });
});

describe('parseTripStats', () => {
  it('reads the corridor end line', () => {
    expect(parseTripStats('fly: the corridor to x failed: stopped: died (fly 20); 1 rocket, 1 cruise, 3 underground (2 bailed out), 0 walks, 1 re-plan, 30 s')).toEqual({ bailouts: 2, rockets: 1 });
    expect(parseTripStats('landed at 1 2 3, 0.4 from the aim (home); 3 rockets, 0 go-arounds, 20 s')).toEqual({ rockets: 3 });
    expect(parseTripStats('arrived at base (1 2 3)')).toEqual({});
  });
});
