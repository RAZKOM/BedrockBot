// Track E10 (docs/early-game.md "A step lost to flights", ADR 0112): the obtain job counts the flights on foot while a step
// runs, says them in the step's record and the end line, and ends a step that is mostly flight; `!get status` names the
// last obtain job once it ended.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandEvent } from '../../../src/chat/chat.ts';
import { ObtainController } from '../../../src/chat/commands-kit.ts';
import { GetController } from '../../../src/chat/commands-get.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import { FLIGHT_GAIN_MS, FLIGHT_MIN, FLIGHT_SHARE, FLIGHT_STEP_MIN_MS, flightLine, preemptPort, StepFlights, type Preempt } from '../../../src/chat/kit-flights.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { ObtainOptions } from '../../../src/skills/items/obtain.ts';
import type { Process } from '../../../src/tasks/process/manager.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-iron-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fixture.items[String(id)]);
recipes.handle(fixture);
const keep = { keep: keepOnDropItems };
const LINE = { type: 'chat', source: 'Owner', message: '!get oak_planks 16', body: '!get oak_planks 16', xuid: '', truth: false } as unknown as ChatLine;
const FLEE: Preempt = { by: 'flee', mobs: ['minecraft:skeleton'] };

describe('Track E10: StepFlights', () => {
  it('preemptPort: only the flee process counts; the live hostile kinds within 24', () => {
    let active: { name: string } | undefined = { name: 'guard' };
    const ents = [
      { runtimeId: 1n, type: 'minecraft:skeleton', pos: { x: 10, y: 65.62, z: 0 } },
      { runtimeId: 2n, type: 'minecraft:zombie', pos: { x: 40, y: 65.62, z: 0 } },
      { runtimeId: 3n, type: 'minecraft:sheep', pos: { x: 2, y: 65.62, z: 0 } },
      { runtimeId: 4n, type: 'minecraft:creeper', pos: { x: 3, y: 65.62, z: 0 } },
    ] as never[];
    const port = preemptPort({ active: () => active, position: () => ({ x: 0, y: 64, z: 0 }), entities: () => ents, dead: (id) => id === (4n as never) });
    expect(port()).toBeUndefined();
    active = { name: 'flee' };
    expect(port()).toEqual({ by: 'flee', mobs: ['minecraft:skeleton'] });
  });

  it('counts each flight once, its time, the kinds; a step is mostly flight only past all three bounds', () => {
    const f = new StepFlights();
    expect(f.text(0)).toBeUndefined();
    let t = 0;
    // 3 flights of 30 s with 10 s between them
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 30; k++, t += 1000) f.observe(FLEE, t);
      for (let k = 0; k < 10; k++, t += 1000) f.observe(undefined, t);
    }
    expect(f.n).toBe(3);
    expect(f.ms(t)).toBe(90_000);
    expect(f.text(t)).toBe('3 flights took 90 s (skeleton)');
    // 120 s, 90 of them fleeing (0.75 >= FLIGHT_SHARE), 3 flights, nothing gained: mostly flight
    expect(t).toBe(120_000);
    expect(f.mostly(t, t)).toBe(true);
    // under the time bound: not yet
    expect(f.mostly(FLIGHT_STEP_MIN_MS - 1, t)).toBe(false);
    // the share: 90 s of 240 s is not mostly
    expect(f.mostly(240_000, t)).toBe(false);
    // 4 items in 120 s (one every 30 s): the step goes on; 3: mostly flight
    expect(f.mostly(t, t, 120_000 / FLIGHT_GAIN_MS)).toBe(false);
    expect(f.mostly(t, t, 120_000 / FLIGHT_GAIN_MS - 1)).toBe(true);
    // one long flight is not a step lost to flights
    const one = new StepFlights();
    for (let k = 0; k <= 130; k++) one.observe(k > 0 ? { by: 'flee', mobs: ['zombie'] } : undefined, k * 1000);
    expect(one.n).toBe(1);
    expect(one.mostly(130_000, 130_000)).toBe(false);
    expect(one.text(130_000)).toBe('1 flight took 129 s (zombie)'); // from the poll at 1 s
    // another process holding the body is not a flight
    const other = new StepFlights();
    other.observe({ by: 'night', mobs: ['zombie'] }, 0);
    expect(other.n).toBe(0);
    expect(FLIGHT_MIN).toBe(3);
    expect(FLIGHT_SHARE).toBe(0.4);
    expect(flightLine('gather 4', '0 of 4 logs', 182.4, '6 flights took 141 s (skeleton)')).toBe('!gather 4: 0 of 4 logs in 182 s: 6 flights took 141 s (skeleton)');
  });
});

/** A host whose gather never ends by itself and whose clock moves by every wait; `flee(t)` says when the flee holds the body. */
function host(flee: (t: number) => boolean) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  const clock = { t: 1_000_000 };
  const replies: string[] = [];
  const ends: string[] = [];
  const dispatched: string[] = [];
  const procs: (Process & { finish(): void })[] = [];
  const listeners = new Set<(e: CommandEvent) => void>();
  let logs = 0;
  return {
    clock,
    replies,
    ends,
    dispatched,
    host: {
      dispatch: (_line: ChatLine, command: string) => {
        dispatched.push(command);
        const [verb] = command.split(' ');
        for (const fn of listeners) fn({ kind: 'run', name: verb!, sender: { name: 'Owner' } } as never);
        let done = false;
        const p = {
          name: verb,
          kind: 'user',
          priority: 40,
          get done() {
            return done;
          },
          status: () => ({ line: `${verb} running` }),
          finish: () => {
            done = true;
          },
        } as unknown as Process & { finish(): void };
        procs.push(p);
        // the gather gets 1 log in its first poll window, then nothing (the flights take the body)
        if (verb === 'gather' && logs === 0) {
          logs = 1;
          slots[0] = { name: 'oak_log', count: 1, networkId: 1, metadata: 0 };
        }
      },
      processes: {
        userProcesses: () => procs.filter((p) => !p.done),
        stop: (p: Process) => {
          (p as Process & { finish(): void }).finish();
          return true;
        },
      },
      slots: () => slots,
      recipes,
      options: (): ObtainOptions => ({ ...keep, worn: [] }),
      onCommand: (fn: (e: CommandEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      wait: (ms: number) => {
        clock.t += ms;
        return new Promise<void>((r) => setTimeout(r, 0));
      },
      now: () => clock.t,
      sayEnd: (m: string) => ends.push(m),
      preempt: () => (flee(clock.t) ? FLEE : undefined),
    },
  };
}

describe('Track E10: the obtain job and the flights', () => {
  it('a gather step that is mostly flight ends early; the end line says what took the time', async () => {
    // from 10 s in: 40 s of flight, 10 s of work, again and again
    const h = host((t) => {
      const s = (t - 1_000_000) / 1000;
      return s >= 10 && (s - 10) % 50 < 40;
    });
    const c = new ObtainController(h.host);
    const job = c.start(LINE, 'oak_planks', ObtainController.targetsFor('oak_planks', 16).targets, (m) => h.replies.push(m));
    const end = await job!.result;
    expect(h.dispatched[0]).toMatch(/^gather \d+$/);
    expect(end).toMatch(/^get oak_planks: stopped after \d+ s, 1 step: !gather \d+: 1 of \d+ logs in \d+ s: 3 flights took \d+ s \(skeleton\); the step was mostly flight$/);
    const s = Number(/in (\d+) s: 3/.exec(end)![1]);
    expect(s).toBeGreaterThanOrEqual(FLIGHT_STEP_MIN_MS / 1000);
    expect(s).toBeLessThan(600);
    expect(h.ends).toEqual([end]);
  });

  it('a step with a flight that is not mostly flight runs on; its flights are noted in the end line', async () => {
    // one flight of 20 s at 5 s in; the gather ends (2 logs) at 60 s
    let gatherDone: (() => void) | undefined;
    const h = host((t) => {
      const s = (t - 1_000_000) / 1000;
      if (s >= 60) gatherDone?.();
      return s >= 5 && s < 25;
    });
    const orig = h.host.dispatch;
    h.host.dispatch = (line, command) => {
      orig(line, command);
      const p = h.host.processes.userProcesses().at(-1) as Process & { finish(): void };
      if (command.startsWith('gather'))
        gatherDone = () => {
          const n = Number(command.split(' ')[1]);
          h.host.slots()[0] = { name: 'oak_log', count: n, networkId: 1, metadata: 0 };
          p.finish();
          gatherDone = undefined;
        };
      else p.finish();
    };
    const c = new ObtainController(h.host);
    const job = c.start(LINE, 'oak_planks', ObtainController.targetsFor('oak_planks', 16).targets, (m) => h.replies.push(m));
    const end = await job!.result;
    expect(end).not.toMatch(/mostly flight/);
    expect(end).toMatch(/!gather \d+: \d+ of \d+ logs in 6\d s: 1 flight took 20 s \(skeleton\)/);
  });

  it('`!get status` names the obtain job that ended after the last plain `!get`', () => {
    const h = host(() => false);
    let ended = false;
    h.host.dispatch = (_l, command) => {
      h.dispatched.push(command);
      ended = true;
    };
    const get = new GetController({ dispatch: () => undefined, processes: { userProcesses: () => [], stop: () => true, find: () => undefined } as never });
    // a plain `!get` first (its job record), then an obtain job's end line
    get.job = { item: { item: 'oak_log', count: 8, command: 'gather 8' } as never, command: 'gather 8', process: undefined, startedAt: Date.now() - 1000 };
    expect(get.status()).toBe('get: idle (last: 8 oak_log via !gather 8)');
    const line = 'get oak_planks: done in 111 s, 3 steps (gather 4, craft oak_planks 16)';
    get.obtain = { run: () => true, stop: () => undefined, status: () => undefined, last: () => ({ line, at: Date.now() }) };
    expect(get.status()).toBe(`get: idle (last: ${line})`);
    // a plain `!get` after the job: that one is the last again
    get.job = { ...get.job, startedAt: Date.now() + 1000 };
    expect(get.status()).toBe('get: idle (last: 8 oak_log via !gather 8)');
    // a long end line is cut
    const long = `get kit: done in 900 s, 20 steps (${'mine stone 3, '.repeat(20)})`;
    get.obtain = { run: () => true, stop: () => undefined, status: () => undefined, last: () => ({ line: long, at: Date.now() + 5000 }) };
    expect(get.status()).toBe(`get: idle (last: ${long.slice(0, 157)}...)`);
    expect(ended).toBe(false);
  });
});
