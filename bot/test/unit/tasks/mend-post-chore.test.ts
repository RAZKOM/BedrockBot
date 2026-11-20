// Track K6 (ADR 0110 addendum, docs/survival.md "Mending, part two (Track K6)"): the post (`mendPost`: kills by night as a
// `!mend` source, the fight rules unchanged) and the chore (`autoMend`: the furnace outputs and the home stock by day, a
// bound of items an hour). On fakes.
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import type { MendPiece } from '../../../src/skills/survival/mend.ts';
import {
  chooseMendSource,
  choreLow,
  choreState,
  HourLedger,
  MEND_CHORE_BACKOFF_MS,
  MEND_CHORE_ITEMS_HOUR,
  MendChore,
  MendJob,
  postCheck,
  postWithinGround,
  stepDone,
  stepKey,
  type MendChoreDeps,
  type MendJobDeps,
  type MendSourceState,
  type PostInput,
} from '../../../src/tasks/process/mend.ts';

const ok: PostInput = { dimension: 'overworld', night: true, guard: true, blade: true, chestplate: true, health: 20, food: 20, home: 2 };
const piece = (left: number, name = 'elytra', max = 432): MendPiece => ({ name, where: 'carried', slot: 3, left, max, mending: true, aside: false, wornOut: false });

describe('the post (postCheck)', () => {
  it('by night at home, guard on, a blade, a chestplate, health and food at 14 or more: the post is home', () => {
    expect(postCheck(ok)).toEqual({ ok: true, at: 'home' });
    const { home: _h, ...noHome } = ok;
    expect(postCheck(noHome)).toEqual({ ok: true, at: 'here (no home set)' });
    expect(postCheck({ ...ok, health: 14, food: 14 }).ok).toBe(true);
  });
  it('each refusal says why', () => {
    const why = (s: Partial<PostInput>): string => {
      const r = postCheck({ ...ok, ...s });
      return r.ok ? 'ok' : r.why;
    };
    expect(why({ dimension: 'nether' })).toBe('in the nether');
    expect(why({ night: undefined })).toBe('the time of day is not known');
    expect(why({ night: false })).toBe('it is not night');
    expect(why({ guard: false })).toBe('guard is off (the post is the fight rules killing what comes)');
    expect(why({ blade: false })).toBe('no sword or axe carried');
    expect(why({ chestplate: false })).toBe('no chestplate worn');
    expect(why({ health: 13.5 })).toBe('health 14 under 14');
    expect(why({ food: 10 })).toBe('food 10 under 14');
    expect(why({ nightRules: 'the night shelter' })).toBe('the night shelter takes me in tonight');
    expect(why({ home: 30 })).toBe('home is 30 blocks off (the post is home)');
  });
  it('once it stands, a guard fight within the guard radius + 8 of home does not end it', () => {
    expect(postWithinGround(undefined, 16)).toBe(true);
    expect(postWithinGround(20, 16)).toBe(true);
    expect(postWithinGround(24, 16)).toBe(true);
    expect(postWithinGround(24.5, 16)).toBe(false);
    expect(postWithinGround(12, 4)).toBe(true);
    expect(postWithinGround(12.5, 4)).toBe(false);
  });
  it('the post is the last source and is tried once a job; its refusal is named when nothing else is left', () => {
    const base: MendSourceState = { points: 100, furnaces: [], carried: new Map(), rawFood: 0, fuelItems: 0, home: new Map(), tried: new Set() };
    expect(chooseMendSource({ ...base, post: { ok: true, at: 'home' } })).toEqual({ kind: 'post', at: 'home' });
    expect(chooseMendSource({ ...base, post: { ok: true, at: 'home' }, carried: new Map([['raw_iron', 8]]), fuelItems: 8 }).kind).toBe('smelt');
    expect(chooseMendSource({ ...base, post: { ok: true, at: 'home' }, ore: { block: 'coal_ore', count: 3 } }).kind).toBe('mine');
    expect(chooseMendSource({ ...base, post: { ok: true, at: 'home' }, tried: new Set(['post']) }).kind).toBe('none');
    const none = chooseMendSource({ ...base, post: { ok: false, why: 'mendPost is off' } });
    expect(none).toMatchObject({ kind: 'none' });
    expect((none as { why: string }).why).toMatch(/, or a night at the post \(not now: mendPost is off\)$/);
    // by day with the setting off it is not named at all
    expect((chooseMendSource(base) as { why: string }).why).not.toContain('post');
    expect(stepKey({ kind: 'post', at: 'home' })).toBe('post');
    expect(stepDone({ kind: 'post', at: 'home' }, 3)).toBe('stood at the post (home) for 3 kills');
  });
});

describe('the post step in the job', () => {
  const rig = (o: { kills: number; why: string; mendPerKill?: number }) => {
    let elytra = 100;
    let now = 0;
    const stands: string[] = [];
    const d: MendJobDeps = {
      pieces: () => [piece(elytra)],
      hand: { want: undefined, job: false },
      furnaces: () => [],
      collect: () => Promise.resolve(0),
      carried: () => new Map(),
      rawFood: () => 0,
      fuelItems: () => 0,
      home: () => new Map(),
      withdraw: () => Promise.resolve(0),
      ore: () => undefined,
      run: () => Promise.resolve(undefined),
      post: () => ({ ok: true, at: 'home' }),
      stand: async (stop) => {
        await Promise.resolve();
        stands.push(stop() ?? 'running');
        elytra += o.kills * (o.mendPerKill ?? 10);
        now += 600_000;
        return { kills: o.kills, why: o.why, ms: 600_000 };
      },
      now: () => now,
    };
    return { d, stands, elytra: () => elytra };
  };
  it('stands until the post ends; the end line says the kills and why', async () => {
    const r = rig({ kills: 4, why: 'it is not night' });
    const rep = await new MendJob(r.d, undefined, 60).run();
    expect(r.stands).toEqual(['running']);
    expect(rep.uses).toBe(40);
    expect(rep.line).toMatch(/^mend: elytra 100 -> 140\/432 in 10 min: stood at the post \(home\) for 4 kills; stopped: the post: it is not night$/);
  });
  it('a post with no kills is still named in the end line (what was tried)', async () => {
    const r = rig({ kills: 0, why: 'a flight on foot (the post is not safe tonight)' });
    const rep = await new MendJob(r.d, undefined, 60).run();
    expect(rep.line).toContain('stood at the post (home) for 0 kills; stopped: the post: a flight on foot (the post is not safe tonight)');
  });
  it('the chore never stands at the post', async () => {
    const r = rig({ kills: 4, why: 'it is not night' });
    const rep = await new MendJob(r.d, undefined, 60, { cap: () => 32, spent: () => undefined }).run();
    expect(r.stands).toEqual([]);
    expect(rep.why).toMatch(/^no source of experience/);
  });
});

describe('the chore (autoMend)', () => {
  it('its sources: the furnace outputs and the home stock that pays 0.7 an item or more; never carried stock, food, ores, the post', () => {
    const s: MendSourceState = {
      points: 100,
      furnaces: [],
      carried: new Map([['raw_iron', 30]]),
      rawFood: 8,
      fuelItems: 64,
      home: new Map([['raw_iron', 100], ['cobblestone', 500]]),
      tried: new Set(),
      ore: { block: 'diamond_ore', count: 3 },
      post: { ok: true, at: 'home' },
    };
    const c = choreState(s, 20);
    expect(chooseMendSource(c)).toEqual({ kind: 'smelt', item: 'raw_iron', n: 20, from: 'home', xp: 0.7 });
    expect(chooseMendSource(choreState({ ...s, furnaces: [{ x: 1, y: 2, z: 3 }] }, 0))).toEqual({ kind: 'collect', at: { x: 1, y: 2, z: 3 } });
    const spent = chooseMendSource(choreState(s, 0));
    expect(spent).toMatchObject({ kind: 'none' });
    expect((spent as { why: string }).why).toContain(`no more smelting this hour (the chore's bound: ${MEND_CHORE_ITEMS_HOUR} items an hour)`);
    expect(chooseMendSource(choreState({ ...s, home: new Map([['cobblestone', 500]]) }, 32)).kind).toBe('none');
  });
  it('the hour bound: items smelted in the last hour', () => {
    const l = new HourLedger();
    l.add(0, 20);
    l.add(1_000_000, 10);
    expect(l.used(2_000_000)).toBe(30);
    expect(l.left(2_000_000)).toBe(2);
    expect(l.left(3_600_000)).toBe(22);
    expect(l.left(5_000_000)).toBe(32);
  });
  it('the piece it starts for: at or under 75 % of its uses', () => {
    expect(choreLow([piece(330)])).toBeUndefined();
    expect(choreLow([piece(324)])?.left).toBe(324);
    expect(choreLow([piece(432), { ...piece(1000, 'diamond_pickaxe', 1561), where: 'held' }])?.name).toBe('diamond_pickaxe');
  });

  const choreRig = (o: { on?: boolean; day?: boolean; user?: number; home?: boolean; far?: boolean; threat?: string; left?: number; busy?: boolean }) => {
    let now = 0;
    const jobs: MendJob[] = [];
    const d: MendChoreDeps = {
      processes: { userProcesses: () => Array.from<never>({ length: o.user ?? 0 }) },
      settings: { get: () => o.on ?? true },
      isDay: () => o.day ?? true,
      home: () => (o.home === false ? undefined : { x: 0, y: 64, z: 0 }),
      position: () => ({ x: o.far ? 40 : 3, y: 64, z: 0 }),
      threat: () => o.threat,
      pieces: () => [piece(o.left ?? 200)],
      busy: () => o.busy ?? false,
      job: (c) => {
        const j = new MendJob(
          {
            pieces: () => [piece(o.left ?? 200)],
            hand: { want: undefined, job: false },
            furnaces: () => [],
            collect: () => Promise.resolve(0),
            carried: () => new Map(),
            rawFood: () => 0,
            fuelItems: () => 0,
            home: () => new Map(),
            withdraw: () => Promise.resolve(0),
            ore: () => undefined,
            run: () => Promise.resolve(undefined),
            now: () => now,
          },
          undefined,
          10,
          c,
        );
        jobs.push(j);
        return j;
      },
      cancel: () => undefined,
      now: () => now,
    };
    return { chore: new MendChore(d), jobs, tick: (ms: number) => (now += ms) };
  };
  it('wants control by day, idle, at home, no hostile near, a piece low and the bound not reached', () => {
    const r = choreRig({});
    expect(r.chore.wants()).toBe(true);
    expect(r.jobs.length).toBe(1);
    for (const o of [{ on: false }, { day: false }, { user: 1 }, { home: false }, { far: true }, { threat: 'a zombie 9 blocks off (within 16)' }, { left: 400 }, { busy: true }]) {
      const x = choreRig(o);
      expect(x.chore.wants(), JSON.stringify(o)).toBe(false);
      expect(x.jobs.length).toBe(0);
    }
    const spent = choreRig({});
    spent.chore.ledger.add(0, MEND_CHORE_ITEMS_HOUR);
    spent.tick(1000);
    expect(spent.chore.wants()).toBe(false);
    expect(spent.chore.lastWhy).toBe(`the bound of ${MEND_CHORE_ITEMS_HOUR} items smelted in the last hour`);
  });
  it('a pass that mended nothing waits the backoff; it is asked at most once a second', async () => {
    const r = choreRig({});
    expect(r.chore.wants()).toBe(true);
    const job = r.jobs[0]!;
    const rep = await job.run();
    expect(rep.uses).toBe(0);
    (r.chore as unknown as { end(j: MendJob, x: unknown): void }).end(job, rep);
    expect(r.chore.nextTry).toBe(MEND_CHORE_BACKOFF_MS);
    r.tick(MEND_CHORE_BACKOFF_MS - 1);
    expect(r.chore.wants()).toBe(false);
    r.tick(2);
    expect(r.chore.wants()).toBe(true);
    expect(r.chore.wants()).toBe(true); // running: wants control while by day with no hostile
  });
});

describe('the settings', () => {
  it('mendPost and autoMend are off by default and listed', () => {
    expect(SETTING_DEFS.mendPost.default).toBe(false);
    expect(SETTING_DEFS.autoMend.default).toBe(false);
    expect(SETTING_GROUPS.some(([, names]) => names.includes('mendPost') && names.includes('autoMend'))).toBe(true);
  });
});
