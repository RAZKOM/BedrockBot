// Track E7 (docs/early-game.md "Dusk", "The shell's blocks", "The end line", ADR 0104): the obtain job's controller with
// a fake host at dusk: a mine step running when dusk comes is ended, the job says where it spends the night and waits,
// at dawn it says so and mines the rest; a job started by night runs on; the shell's blocks are dug before dusk and at
// the end; the end line goes through sayEnd (past the chat rate limit).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandEvent } from '../../../src/chat/chat.ts';
import { OBTAIN_COOK_RETRIES, OBTAIN_CRAFT_RETRIES, OBTAIN_HEAL_HEALTH, OBTAIN_HEAL_MS, OBTAIN_HEAL_WAITS, ObtainController } from '../../../src/chat/commands-kit.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import { MORNING_MAX } from '../../../src/chat/kit-morning.ts';
import type { ObtainBlocks, ObtainNight, ShelterPlan } from '../../../src/chat/kit-night.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { planChain } from '../../../src/skills/craft/chain.ts';
import { planCraft, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { ObtainOptions, ObtainTarget } from '../../../src/skills/items/obtain.ts';
import { DAWN, DUSK } from '../../../src/tasks/night.ts';
import type { Process } from '../../../src/tasks/process/manager.ts';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-iron-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fixture.items[String(id)]);
recipes.handle(fixture);
const keep = { keep: keepOnDropItems };
const LINE = { type: 'chat', source: 'Owner', message: '!get kit', body: '!get kit', xuid: '', truth: false } as unknown as ChatLine;
const FURNACE_AT: Vec3 = { x: 3, y: 64, z: 1 };
const START = [
  ['stone_pickaxe', 1],
  ['crafting_table', 1],
  ['cobblestone', 16],
  ['oak_planks', 8],
  ['coal', 2],
] as const;

interface Opts {
  /** The first mine step runs until stopped (raw iron 2 in it). */
  longMine?: boolean;
  time: { t: number };
  blocks?: { short: number; enabled?: boolean };
  jobDusk?: boolean;
  /** The night's plan (default the shelter). */
  plan?: ShelterPlan;
  /** The plan from where the bot stands (after the night rule gave up). */
  fallback?: ShelterPlan;
  /** Track E9: the morning rule's answers (mutable): why the job waits, what is still near, the census. */
  morning?: { why?: string | undefined; holding?: string | undefined };
  /** Track E9: the controller's wall clock (ms). */
  now?: () => number;
  /** Track E9: the first n crafts of this item make nothing and say `why` (through `say`, set by the test to the controller's observeReply). */
  craftFails?: { item: string; n: number; why: string; say?: (m: string) => void };
  /** Track E9: home, as the host reports it. */
  home?: { x: number; y: number; z: number };
  /** Track E9: the first n iron mines gain nothing and say `health low`; `health` is what the host reports. */
  mineLow?: { n: number; health: { v: number }; say?: (m: string) => void };
  /** Track E11: the night's wayOut port (`morningWay`): what it says when the job goes on; calls are counted. */
  wayOut?: { says: string | undefined; calls: number; at?: number[] };
  /** Track E11: the first n smelts make nothing and say `why` (`smelt: timeout in the furnace at ...`). */
  smeltFails?: { n: number; why: string; say?: (m: string) => void };
}

function host(o: Opts) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  const add = (name: string, n: number) => {
    const s = slots.find((x) => x?.name === name && !/_(pickaxe|sword|axe)$/.test(name));
    if (s) s.count += n;
    else slots[slots.indexOf(null)] = { name, count: n, networkId: 1, metadata: 0 };
  };
  for (const [n, c] of START) add(n, c);
  const take = (name: string, n: number) => {
    for (let i = 0; i < 36 && n > 0; i++) {
      const s = slots[i];
      if (s?.name !== name) continue;
      const t = Math.min(n, s.count);
      s.count -= t;
      n -= t;
      if (s.count === 0) slots[i] = null;
    }
  };
  let furnace = false;
  let longDone = false;
  const replies: string[] = [];
  const ends: string[] = [];
  const dispatched: string[] = [];
  const events: string[] = [];
  const procs: (Process & { finish(): void })[] = [];
  const listeners = new Set<(e: CommandEvent) => void>();
  const mk = (name: string, effect: () => void, auto = true): Process & { finish(): void } => {
    let done = false;
    const p = {
      name,
      kind: 'user',
      priority: 40,
      get done() {
        return done;
      },
      status: () => ({ line: `${name} running` }),
      finish: () => {
        if (done) return;
        effect();
        done = true;
      },
    } as unknown as Process & { finish(): void };
    procs.push(p);
    if (auto) setTimeout(() => p.finish(), 5);
    return p;
  };
  let busy = false;
  let gaveUp = false;
  const night: ObtainNight = {
    enabled: () => o.jobDusk !== false,
    time: () => o.time.t,
    dusk: DUSK,
    dawn: DAWN,
    plan: () => o.plan ?? { kind: 'shelter', set: undefined, text: 'at the shelter 1 64 1' },
    enter: (p) => {
      events.push(`enter ${p.kind}`);
      busy = true;
      gaveUp = false;
    },
    gaveUp: () => gaveUp,
    fallback: () => {
      events.push('fallback');
      return o.fallback ?? { kind: 'none', set: undefined, text: 'nowhere to shelter' };
    },
    release: () => events.push('release'),
    busy: () => busy,
    ...(o.morning ? { morning: () => o.morning!.why, holding: () => o.morning!.holding, census: () => 'creeper 9' } : {}),
    ...(o.wayOut
      ? {
          wayOut: () => {
            o.wayOut!.calls++;
            (o.wayOut!.at ??= []).push(dispatched.length);
            return o.wayOut!.says;
          },
        }
      : {}),
  };
  const bl = o.blocks;
  const blocks: ObtainBlocks | undefined = bl
    ? {
        enabled: () => bl.enabled !== false,
        short: () => bl.short,
        refill: () => {
          events.push(`refill at ${o.time.t % 24000}`);
          const before = 10 - bl.short;
          bl.short = 0;
          return { result: Promise.resolve({ before, after: 10, dug: 10 - before }) };
        },
      }
    : undefined;
  const h = {
    slots,
    replies,
    ends,
    dispatched,
    events,
    setBusy: (b: boolean) => (busy = b),
    giveUp: () => {
      gaveUp = true;
      busy = false;
    },
    host: {
      dispatch: (_line: ChatLine, command: string) => {
        dispatched.push(command);
        const [verb, ...rest] = command.split(' ');
        for (const fn of listeners) fn({ kind: 'run', name: verb!, sender: { name: 'Owner' } } as never);
        const n = Number(rest.at(-1));
        if (verb === 'mine' && rest[0] === 'iron_ore' && o.longMine && !longDone) {
          longDone = true;
          mk('mine', () => undefined, false);
          setTimeout(() => add('raw_iron', 2), 5);
        } else if (verb === 'mine' && rest[0] === 'iron_ore' && o.mineLow && o.mineLow.n > 0) {
          const f = o.mineLow;
          f.n--;
          mk('mine', () => f.say?.(`mine iron_ore: stopped at 0/${n}, health low`));
        } else if (verb === 'mine' && rest[0] === 'iron_ore') mk('mine', () => add('raw_iron', n));
        else if (verb === 'mine') mk('mine', () => add('cobblestone', n));
        else if (verb === 'furnace')
          mk('furnace', () => {
            take('furnace', 1);
            furnace = true;
          });
        else if (verb === 'smelt' && o.smeltFails && o.smeltFails.n > 0) {
          const f = o.smeltFails;
          f.n--;
          mk('smelt', () => f.say?.(f.why));
        } else if (verb === 'smelt')
          mk('smelt', () => {
            take(rest[0]!, n);
            add('iron_ingot', n);
          });
        else if (verb === 'goto') mk('goto', () => undefined);
        else if (verb === 'craft' && o.craftFails && o.craftFails.item === rest[0] && o.craftFails.n > 0) {
          const f = o.craftFails;
          f.n--;
          mk('craft', () => f.say?.(`craft: made no ${f.item} (${f.why}); crafting table kept at 1 64 1 for the next craft; stopped: ${f.why}`));
        } else if (verb === 'craft') {
          const item = rest[0]!;
          mk('craft', () => {
            const have = slots.reduce((a, s) => a + (s?.name === item ? s.count : 0), 0);
            const c = planChain(recipes, [{ item, n: n + have }], slots, keep);
            for (const st of c.steps) {
              const p = planCraft(recipes, st.item, st.n, slots, keep)!;
              for (const [k, v] of Object.entries(p.perCraft)) take(k, v * p.crafts);
              add(p.item, p.crafts * p.outputPer);
            }
          });
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
      options: (): ObtainOptions => ({ ...keep, worn: [], furnaceNear: furnace }),
      onCommand: (fn: (e: CommandEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      wait: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2))),
      furnace: () => (furnace ? FURNACE_AT : undefined),
      night,
      ...(blocks ? { blocks } : {}),
      ...(o.now ? { now: o.now } : {}),
      ...(o.mineLow ? { health: () => o.mineLow!.health.v } : {}),
      ...(o.home ? { home: () => o.home } : {}),
      sayEnd: (m: string) => ends.push(m),
    },
  };
  return h;
}

const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

function start(h: ReturnType<typeof host>, targets: readonly ObtainTarget[]): Promise<string> {
  const c = new ObtainController(h.host);
  const job = c.start(LINE, 'test', targets, (m) => h.replies.push(m));
  expect(job).toBeDefined();
  return job!.result;
}

describe('Track E9: a craft step that made nothing for a table that did not open (or a refused request)', () => {
  const run = async (n: number, why: string, home?: Opts['home']): Promise<{ end: string; dispatched: string[] }> => {
    const craftFails: NonNullable<Opts['craftFails']> = { item: 'furnace', n, why };
    const h = host({ time: { t: 6000 }, craftFails, ...(home ? { home } : {}) });
    const c = new ObtainController(h.host);
    craftFails.say = (m) => c.observeReply(m);
    const job = c.start(LINE, 'test', [{ item: 'iron_helmet', n: 1 }], (m) => h.replies.push(m))!;
    return { end: await job.result, dispatched: h.dispatched };
  };

  it('is tried again: the job goes on and says so at its end', async () => {
    const r = await run(1, 'open_failed');
    expect(r.dispatched.filter((d) => d === 'craft furnace 1')).toHaveLength(2);
    expect(r.end).toMatch(/^get test: done in \d+ s, \d+ steps; crafted again after a table that did not open; steps: mine iron_ore 5, craft furnace 1, craft furnace 1, furnace, /);
    const q = await run(2, 'request_failed status 49');
    expect(q.dispatched.filter((d) => d === 'craft furnace 1')).toHaveLength(3);
    expect(q.end).toMatch(/^get test: done in .*crafted again after a refused request; steps: /);
  });

  it(`at most ${OBTAIN_CRAFT_RETRIES} times a job; another reason is the end at once, as before`, async () => {
    const r = await run(OBTAIN_CRAFT_RETRIES + 1, 'open_failed');
    expect(r.dispatched.filter((d) => d === 'craft furnace 1')).toHaveLength(OBTAIN_CRAFT_RETRIES + 1);
    expect(r.end).toMatch(/^get test: stopped after \d+ s, \d+ steps: !craft furnace 1 got nothing \(craft: made no furnace \(open_failed\)/);
    const q = await run(1, 'missing');
    expect(q.dispatched.filter((d) => d === 'craft furnace 1')).toHaveLength(1);
    expect(q.end).toMatch(/^get test: stopped after \d+ s, \d+ steps: !craft furnace 1 got nothing \(craft: made no furnace \(missing\)/);
  });

  it('no cell for the table, or a table that did not open: home first, then the craft; a refused request is tried where the bot stands', async () => {
    const home = { x: 10.5, y: 64, z: -3.5 };
    const r = await run(1, 'no_table', home);
    expect(r.dispatched.slice(0, 4)).toEqual(['mine iron_ore 5', 'craft furnace 1', 'goto 10 64 -4', 'craft furnace 1']);
    expect(r.end).toMatch(/^get test: done in .*; crafted again at home after no room for a table; steps: mine iron_ore 5, craft furnace 1, goto 10 64 -4, craft furnace 1, /);
    const q = await run(1, 'open_failed', home);
    expect(q.dispatched.slice(1, 4)).toEqual(['craft furnace 1', 'goto 10 64 -4', 'craft furnace 1']);
    expect(q.end).toMatch(/crafted again at home after a table that did not open/);
    const w = await run(1, 'request_failed status 49', home);
    expect(w.dispatched.slice(1, 3)).toEqual(['craft furnace 1', 'craft furnace 1']);
    // no home: where the bot stands
    const n = await run(1, 'no_table');
    expect(n.dispatched.slice(1, 3)).toEqual(['craft furnace 1', 'craft furnace 1']);
    expect(n.end).toMatch(/crafted again after no room for a table/);
  });
});

describe('Track E11: a smelt or cook step that ran out on the furnace (a timeout, a refused request)', () => {
  const run = async (n: number, why: string): Promise<{ end: string; dispatched: string[] }> => {
    const smeltFails: NonNullable<Opts['smeltFails']> = { n, why };
    const h = host({ time: { t: 6000 }, smeltFails });
    const c = new ObtainController(h.host);
    smeltFails.say = (m) => c.observeReply(m);
    const job = c.start(LINE, 'test', [{ item: 'iron_helmet', n: 1 }], (m) => h.replies.push(m))!;
    return { end: await job.result, dispatched: h.dispatched };
  };

  it(`is tried once more (OBTAIN_COOK_RETRIES ${OBTAIN_COOK_RETRIES}) and the end line says so; a second one, or another reason, is the end as before`, async () => {
    const r = await run(1, 'smelt: timeout in the furnace at 3 64 1');
    expect(r.dispatched.filter((d) => d === 'smelt raw_iron 5')).toHaveLength(2);
    expect(r.end).toMatch(/^get test: done in \d+ s, \d+ steps; smelted again after a furnace timeout; steps: .*smelt raw_iron 5, smelt raw_iron 5, craft iron_helmet 1$/);
    const q = await run(1, 'smelt: request failed in the furnace at 3 64 1');
    expect(q.end).toMatch(/smelted again after a refused request/);
    const twice = await run(OBTAIN_COOK_RETRIES + 1, 'smelt: timeout in the furnace at 3 64 1');
    expect(twice.dispatched.filter((d) => d === 'smelt raw_iron 5')).toHaveLength(OBTAIN_COOK_RETRIES + 1);
    expect(twice.end).toMatch(/^get test: stopped after \d+ s, \d+ steps: !smelt raw_iron 5 got nothing \(smelt: timeout in the furnace at 3 64 1\)/);
    const fuel = await run(1, 'smelt: no fuel (coal, charcoal, planks, logs, dried kelp blocks) in the furnace at 3 64 1');
    expect(fuel.dispatched.filter((d) => d === 'smelt raw_iron 5')).toHaveLength(1);
    expect(fuel.end).toMatch(/^get test: stopped after .*!smelt raw_iron 5 got nothing \(smelt: no fuel/);
  });
});

describe('Track E9: a mine step that stopped for low health', () => {
  it('is waited out: the job plans again when the health is back, caps nothing and says so at its end', async () => {
    const mineLow: NonNullable<Opts['mineLow']> = { n: 1, health: { v: 1 } };
    const h = host({ time: { t: 6000 }, mineLow });
    const c = new ObtainController(h.host);
    mineLow.say = (m) => c.observeReply(m);
    const job = c.start(LINE, 'test', [{ item: 'iron_helmet', n: 1 }], (m) => h.replies.push(m))!;
    await until(() => (c.status() ?? '').includes('waiting for health'));
    expect(h.dispatched).toEqual(['mine iron_ore 5']);
    mineLow.health.v = OBTAIN_HEAL_HEALTH;
    const end = await job.result;
    expect(h.dispatched.filter((d) => d === 'mine iron_ore 5')).toHaveLength(2);
    expect(end).toMatch(/^get test: done in \d+ s, \d+ steps; waited for health after a step that stopped for it; steps: mine iron_ore 5, mine iron_ore 5, /);
  });

  it(`at most ${OBTAIN_HEAL_MS / 1000} s, ${OBTAIN_HEAL_WAITS} times a job: then the end as before`, async () => {
    // the health never comes back: the wait runs to its bound on the controller's clock
    let t = 0;
    let waiting = false;
    const mineLow: NonNullable<Opts['mineLow']> = { n: 9, health: { v: 3 } };
    const h = host({ time: { t: 6000 }, mineLow, now: () => (waiting ? (t += 20_000) : t) });
    const c = new ObtainController(h.host);
    mineLow.say = (m) => {
      c.observeReply(m);
      waiting = true;
    };
    const end = await c.start(LINE, 'test', [{ item: 'iron_helmet', n: 1 }], (m) => h.replies.push(m))!.result;
    expect(h.dispatched).toEqual(['mine iron_ore 5']);
    expect(end).toMatch(/^get test: stopped after \d+ s, 1 step: !mine iron_ore 5 got nothing \(mine iron_ore: stopped at 0\/5, health low\)/);
    // it comes back each time, the step stops again each time: two waits, then the end
    const low: NonNullable<Opts['mineLow']> = { n: 9, health: { v: 20 } };
    const g = host({ time: { t: 6000 }, mineLow: low });
    const d = new ObtainController(g.host);
    low.say = (m) => d.observeReply(m);
    const end2 = await d.start(LINE, 'test', [{ item: 'iron_helmet', n: 1 }], (m) => g.replies.push(m))!.result;
    expect(g.dispatched).toEqual(Array(OBTAIN_HEAL_WAITS + 1).fill('mine iron_ore 5'));
    expect(end2).toMatch(/^get test: stopped after \d+ s, 3 steps: !mine iron_ore 5 got nothing \(mine iron_ore: stopped at 0\/5, health low\); waited for health/);
  });
});

describe('Track E7: the obtain job at dusk (jobDusk)', () => {
  it('a mine step at dusk is ended; the job waits out the night where the bot shelters and mines the rest at dawn', async () => {
    const time = { t: 6000 };
    const h = host({ longMine: true, time });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    expect(h.replies.find((r) => r.includes('paused'))).toBe('get test: paused for the night at step 1 (mine iron_ore 5: 2 of 5), at the shelter 1 64 1; resuming at dawn');
    expect(h.events).toEqual(['enter shelter']);
    // the night: nothing is dispatched
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dispatched).toEqual(['mine iron_ore 5']);
    // dawn, but the night process still holds the bot (its shell shut): still waiting
    time.t = 24000 + 100;
    await new Promise((r) => setTimeout(r, 20));
    expect(h.dispatched).toEqual(['mine iron_ore 5']);
    h.setBusy(false);
    const end = await result;
    expect(h.replies.find((r) => r.includes('dawn: going on'))).toBe('get test: dawn: going on (paused at !mine iron_ore 5)');
    expect(h.events).toEqual(['enter shelter', 'release']);
    expect(h.dispatched[1]).toBe('mine iron_ore 3');
    expect(end).toMatch(/^get test: done in \d+ s, \d+ steps; paused for 1 night; steps: mine iron_ore 5, mine iron_ore 3, /);
    expect(h.ends).toEqual([end]); // the end line through sayEnd
    expect(h.replies).not.toContain(end);
  });

  it('Track E9: the morning rule holds the job after the night; when it clears the job goes on and says how long it waited', async () => {
    const time = { t: 6000 };
    const morning: { why?: string | undefined; holding?: string | undefined } = {};
    const h = host({ longMine: true, time, morning });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    // dawn: the night process lets go, but a creeper stands 9 blocks off
    morning.why = 'a creeper 9 blocks off';
    time.t = 24000 + 100;
    h.setBusy(false);
    await until(() => h.replies.some((r) => r.includes('morning: waiting')));
    expect(h.replies.filter((r) => r.includes('morning:'))).toEqual(['get test: morning: waiting (a creeper 9 blocks off)']);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dispatched).toEqual(['mine iron_ore 5']); // nothing dispatched while it waits
    expect(h.replies.filter((r) => r.includes('morning:'))).toHaveLength(1); // said once
    expect(h.replies.some((r) => r.includes('dawn: going on'))).toBe(false);
    morning.why = undefined;
    const end = await result;
    expect(h.replies.find((r) => r.includes('dawn: going on'))).toMatch(/^get test: dawn: going on after \d+ s \(paused at !mine iron_ore 5\)$/);
    expect(h.dispatched[1]).toBe('mine iron_ore 3');
    expect(end).toMatch(/^get test: done in \d+ s, \d+ steps; paused for 1 night;/);
  });

  it('Track E11 (`morningWay`): the walk out is set up once as the job goes on after the night, before its next step; said in the end line', async () => {
    const time = { t: 6000 };
    const wayOut: NonNullable<Opts['wayOut']> = { says: 'the walk out keeps 16 blocks from hostiles for 120 s (near: creeper 9)', calls: 0 };
    const h = host({ longMine: true, time, morning: {}, wayOut });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    expect(wayOut.calls).toBe(0); // not by day before a night
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    time.t = 24000 + 100;
    h.setBusy(false);
    const end = await result;
    expect(wayOut.calls).toBe(1);
    expect(wayOut.at).toEqual([1]); // before `mine iron_ore 3`, the step that walks out
    expect(h.dispatched[1]).toBe('mine iron_ore 3');
    expect(end).toMatch(/^get test: done in \d+ s, \d+ steps; paused for 1 night; walked out wide of the hostiles after a night; steps: /);
    // the port says nothing (off, or nothing near): no note
    const w2: NonNullable<Opts['wayOut']> = { says: undefined, calls: 0 };
    const t2 = { t: 6000 };
    const g = host({ longMine: true, time: t2, morning: {}, wayOut: w2 });
    const r2 = start(g, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => g.dispatched.length === 1 && g.slots.some((s) => s?.name === 'raw_iron'));
    t2.t = DUSK + 100;
    await until(() => g.replies.some((r) => r.includes('paused for the night')));
    t2.t = 24000 + 100;
    g.setBusy(false);
    expect(await r2).not.toContain('walked out wide');
    expect(w2.calls).toBe(1);
  });

  it('Track E9: a wait that ends at its cap says what is still near; a clear morning says nothing more than before', async () => {
    const time = { t: 6000 };
    const morning: { why?: string | undefined; holding?: string | undefined } = {};
    const h = host({ longMine: true, time, morning });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    morning.why = 'a witch 4 blocks off';
    morning.holding = 'witch 4 blocks off';
    time.t = 24000 + 100;
    h.setBusy(false);
    await until(() => h.replies.some((r) => r.includes('morning: waiting')));
    morning.why = undefined; // the cap: the rule lets go, the witch is still there
    await result;
    expect(h.replies.find((r) => r.includes('dawn: going on'))).toMatch(/^get test: dawn: going on after \d+ s \(the morning did not clear: witch 4 blocks off\) \(paused at !mine iron_ore 5\)$/);
    // a clear morning (the rule on, nothing near): the line of Track E7, no morning line
    const t2 = { t: 6000 };
    const g = host({ longMine: true, time: t2, morning: {} });
    const r2 = start(g, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => g.dispatched.length === 1 && g.slots.some((s) => s?.name === 'raw_iron'));
    t2.t = DUSK + 100;
    await until(() => g.replies.some((r) => r.includes('paused for the night')));
    t2.t = 24000 + 100;
    g.setBusy(false);
    await r2;
    expect(g.replies.find((r) => r.includes('dawn: going on'))).toBe('get test: dawn: going on (paused at !mine iron_ore 5)');
    expect(g.replies.some((r) => r.includes('morning:'))).toBe(false);
  });

  it('Track E9: a clock that stands still: the wait ends after MORNING_MAX ticks of wall clock', async () => {
    const time = { t: 6000 };
    const clock = { ms: 1_000_000 };
    const morning: { why?: string | undefined; holding?: string | undefined } = {};
    const h = host({ longMine: true, time, morning, now: () => clock.ms });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    // the server's clock is set to the morning and stands there: the rule's answer never changes
    morning.why = 'the sun is not up';
    time.t = 24000 + 100;
    h.setBusy(false);
    await until(() => h.replies.some((r) => r.includes('morning: waiting')));
    clock.ms += (MORNING_MAX * 50) / 2;
    await new Promise((r) => setTimeout(r, 20));
    expect(h.replies.some((r) => r.includes('dawn: going on'))).toBe(false);
    clock.ms += (MORNING_MAX * 50) / 2;
    await result;
    expect(h.replies.find((r) => r.includes('dawn: going on'))).toBe(`get test: dawn: going on after ${(MORNING_MAX * 50) / 1000} s (paused at !mine iron_ore 5)`);
  });

  it('Track E9: `!get stop` ends the morning wait as it ends the night`s', async () => {
    const time = { t: 6000 };
    const morning: { why?: string | undefined; holding?: string | undefined } = {};
    const h = host({ longMine: true, time, morning });
    const c = new ObtainController(h.host);
    const job = c.start(LINE, 'test', [{ item: 'iron_helmet', n: 1 }], (m) => h.replies.push(m))!;
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    expect(c.nightPaused).toBe(true);
    morning.why = 'a creeper 9 blocks off';
    time.t = 24000 + 100;
    h.setBusy(false);
    await until(() => h.replies.some((r) => r.includes('morning: waiting')));
    expect(c.nightPaused).toBe(true); // the night shell's hold reads this
    expect(c.status()).toContain('waiting for the morning to clear');
    expect(c.stop()).toMatch(/^stopped get test after 1 step/);
    await job.result;
    expect(c.nightPaused).toBe(false);
    expect(h.dispatched).toEqual(['mine iron_ore 5']);
    expect(h.events).toEqual(['enter shelter', 'release']);
  });

  it('a job started by night runs on (it pauses at the next dusk only); jobDusk off: no pause', async () => {
    const time = { t: DUSK + 500 };
    const h = host({ time });
    const end = await start(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(end).toMatch(/^get test: done in/);
    expect(h.replies.some((r) => r.includes('paused'))).toBe(false);
    const t2 = { t: 6000 };
    const off = host({ longMine: true, time: t2, jobDusk: false });
    const r2 = start(off, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => off.dispatched.length === 1);
    t2.t = DUSK + 100;
    await new Promise((r) => setTimeout(r, 30));
    expect(off.replies.some((r) => r.includes('paused'))).toBe(false);
    off.host.processes.userProcesses().forEach((p) => off.host.processes.stop(p));
    await r2;
  });

  it('nowhere to spend the night: the step is not ended and the job works on (said in the end line)', async () => {
    const time = { t: 6000 };
    const h = host({ longMine: true, time, plan: { kind: 'none', set: undefined, text: 'nowhere to shelter' } });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await new Promise((r) => setTimeout(r, 40));
    expect(h.replies.some((r) => r.includes('paused'))).toBe(false);
    expect(h.events).toEqual([]); // no shelter entered
    expect(h.host.processes.userProcesses()).toHaveLength(1); // the mine step still runs
    h.host.processes.userProcesses().forEach((p) => h.host.processes.stop(p));
    const end = await result;
    expect(end).toContain('worked through a night (nowhere to shelter)');
  });

  it('the shelter out of reach: the plan from where the bot stands once; nowhere there: the pause ends and the job goes on', async () => {
    const time = { t: 6000 };
    const h = host({ longMine: true, time, fallback: { kind: 'enclosed', set: { x: 4, y: 40, z: 4 }, text: 'in the roofed spot at 4 40 4' } });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    h.giveUp();
    await until(() => h.events.includes('enter enclosed'));
    expect(h.events).toEqual(['enter shelter', 'fallback', 'enter enclosed']);
    // the roofed spot is out of reach too: no second fallback, the job goes on tonight
    h.giveUp();
    const end = await result;
    expect(h.events).toEqual(['enter shelter', 'fallback', 'enter enclosed', 'release']);
    expect(h.replies.some((r) => r.includes('going on tonight'))).toBe(true);
    expect(h.dispatched[1]).toBe('mine iron_ore 3');
    expect(end).toContain('worked through a night (the shelter out of reach)');
    expect(end).not.toContain('paused for');
  });
});

describe('Track E7: the shell blocks in the job (shellBlocks)', () => {
  it('short before dusk: dug first (once that day); the reserve there: nothing', async () => {
    const time = { t: DUSK - 600 };
    const h = host({ time, blocks: { short: 6 } });
    await start(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(h.events).toEqual([`refill at ${DUSK - 600}`]);
    expect(h.dispatched[0]).toBe('mine iron_ore 5');
    const full = host({ time: { t: DUSK - 600 }, blocks: { short: 0 } });
    await start(full, [{ item: 'iron_helmet', n: 1 }]);
    expect(full.events).toEqual([]);
  });

  it('by day far from dusk: dug at the end, before the end line; the setting off: never', async () => {
    const h = host({ time: { t: 2000 }, blocks: { short: 4 } });
    const end = await start(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(h.events).toEqual(['refill at 2000']);
    expect(end).toMatch(/dug the night shell's blocks/);
    const off = host({ time: { t: 2000 }, blocks: { short: 4, enabled: false } });
    await start(off, [{ item: 'iron_helmet', n: 1 }]);
    expect(off.events).toEqual([]);
  });
});
