// Track K1 (ADR 0096, docs/pve.md "Milk on hand") on fakes: the stock rule (planMilk), the early game's craft choice, the
// refill choice (milkTargets), the click packet, the Milker (a cow fills the buckets, a hostile ends it, a refusal is left
// alone), the unloader's milk reserve, the job's order of sources, the chore's trigger and the settings.
import { describe, expect, it } from 'vitest';
import { RuntimeSettings, SETTING_DEFS } from '../../../src/config/settings.ts';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { BUCKET, bucketCounts, craftChoice, homeChestReach, MILK, milkTargets, milkTransaction, Milker, planMilk, wetCell, type MilkStockInput } from '../../../src/skills/food/milk.ts';
import type { Pen } from '../../../src/skills/food/pen.ts';
import { milkReserve, planUnload, type UnloadSlot } from '../../../src/skills/home/unloader.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { MILK_BACKOFF_MS, MilkController, MilkJob, milkReply, type MilkDeps, type MilkSource } from '../../../src/tasks/process/milk.ts';
import type { BlockInfo, EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const item = (name: string, count: number): ItemStack => ({ name, networkId: 1, count, metadata: 0 });

function ent(rid: number, type: string, x: number, z: number, y = 0): EntityInfo {
  return { runtimeId: BigInt(rid), uniqueId: BigInt(rid), type: `minecraft:${type}`, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 };
}

const base = (o: Partial<MilkStockInput> = {}): MilkStockInput => ({ keep: 2, milk: 0, empty: 0, boxedMilk: 0, boxedEmpty: 0, homeMilk: 0, homeEmpty: 0, atHome: false, iron: 0, craft: true, table: false, ...o });

describe('the stock rule (planMilk)', () => {
  it('nothing to do at or over the target', () => {
    expect(planMilk(base({ milk: 2 }), { cows: true })).toEqual({ want: 0, steps: [] });
    expect(planMilk(base({ keep: 0 }), { cows: true })).toEqual({ want: 0, steps: [] });
  });

  it('the cheapest source first: the carried boxes, the chests at home (only there), then the cows', () => {
    expect(planMilk(base({ boxedMilk: 1, homeMilk: 5, atHome: true }), { cows: true }).steps).toEqual([
      { kind: 'boxes', item: MILK, n: 1 },
      { kind: 'home', item: MILK, n: 1 },
    ]);
    // away from home the chests are no source; the empty bucket goes to a cow
    expect(planMilk(base({ boxedMilk: 1, homeMilk: 5, empty: 3 }), { cows: true }).steps).toEqual([
      { kind: 'boxes', item: MILK, n: 1 },
      { kind: 'cows', n: 1 },
    ]);
  });

  it('buckets for the cows: loose, then out of the boxes, then from the chests at home', () => {
    expect(planMilk(base({ keep: 3, empty: 1, boxedEmpty: 1, homeEmpty: 4, atHome: true }), { cows: true }).steps).toEqual([
      { kind: 'boxes', item: BUCKET, n: 1 },
      { kind: 'home', item: BUCKET, n: 1 },
      { kind: 'cows', n: 3 },
    ]);
    const p = planMilk(base({ keep: 3, empty: 1 }), { cows: true });
    expect(p.steps).toEqual([{ kind: 'cows', n: 1 }]);
    expect(p.short).toBe('2 more need a bucket');
  });

  it('the trip readiness takes storage only (no cows, no craft)', () => {
    const p = planMilk(base({ boxedMilk: 1, empty: 2, iron: 9, table: true }), { cows: false });
    expect(p.steps).toEqual([{ kind: 'boxes', item: MILK, n: 1 }]);
    expect(p.short).toBe('1 more from a cow (!milk)');
  });

  it('the early game: one bucket crafted with none anywhere, 3 iron and a table; otherwise it says why', () => {
    expect(planMilk(base({ iron: 3, table: true }), { cows: true }).steps).toEqual([{ kind: 'craft', n: 1 }, { kind: 'cows', n: 1 }]);
    expect(planMilk(base({ iron: 2, table: true }), { cows: true })).toMatchObject({ steps: [], short: 'no bucket and no iron (3 iron ingots make one)' });
    expect(planMilk(base({ iron: 3 }), { cows: true })).toMatchObject({ steps: [], short: 'no bucket and no crafting table near' });
    expect(planMilk(base({ iron: 3, table: true, craft: false }), { cows: true })).toMatchObject({ steps: [], short: 'no bucket (milkCraft is off)' });
    // a bucket in the chests at home (the bot is away): no iron is spent, it is fetched there
    expect(planMilk(base({ iron: 3, table: true, homeEmpty: 1 }), { cows: true })).toMatchObject({ steps: [], short: '2 more: 1 bucket in the chests at home, taken there' });
    // every bucket carried is full: nothing to fill, no iron spent
    expect(planMilk(base({ keep: 3, milk: 1, iron: 3, table: true }), { cows: true })).toMatchObject({ steps: [], short: '2 more need a bucket' });
  });
});

describe('the craft choice', () => {
  it('only with no bucket at all, milkCraft on, 3 iron and a table', () => {
    expect(craftChoice({ craft: true, iron: 3, table: true, anyBucket: false })).toEqual({ craft: true });
    expect(craftChoice({ craft: true, iron: 3, table: true, anyBucket: true })).toMatchObject({ craft: false });
    expect(craftChoice({ craft: false, iron: 9, table: true, anyBucket: false })).toMatchObject({ craft: false, why: 'no bucket (milkCraft is off)' });
    expect(craftChoice({ craft: true, iron: 2, table: true, anyBucket: false })).toMatchObject({ craft: false });
    expect(craftChoice({ craft: true, iron: 3, table: false, anyBucket: false })).toMatchObject({ craft: false });
  });
});

describe('the refill choice (milkTargets)', () => {
  const water = new Map<string, BlockInfo>([['20,-1,0', blockInfoOf('water', {})]]);
  const blockAt = (p: Vec3): BlockInfo | undefined => water.get(`${p.x},${p.y},${p.z}`) ?? blockInfoOf(p.y < 0 ? 'grass_block' : 'air', {});
  const list = [
    ent(1, 'cow', 10, 0),
    ent(2, 'goat', 3, 0),
    ent(3, 'mooshroom', 6, 0),
    ent(4, 'cow', 2, 0), // a calf
    ent(5, 'pig', 1, 0), // gives no milk
    ent(6, 'cow', 30, 0), // out of the radius
    ent(7, 'cow', 5, 0, -6), // under the base
    ent(8, 'cow', 20.5, 0.5), // in water
    ent(9, 'cow', 4, 1), // ignored (gave no milk)
  ];
  it('adult cows, mooshrooms and goats within the radius and 4 up or down, dry, nearest first', () => {
    const got = milkTargets(list, { center: { x: 0, y: 0, z: 0 }, radius: 24, me: { x: 0, y: 0, z: 0 }, isBaby: (r) => r === 4n, ignored: (r) => r === 9n, blockAt });
    expect(got.map((e) => Number(e.runtimeId))).toEqual([2, 3, 1]);
    expect(wetCell(blockAt, { x: 20.5, y: 0, z: 0.5 })).toBe(true);
  });
});

describe('the click (milkTransaction)', () => {
  it('a right click on the mob with the bucket held: item_use_on_entity, interact', () => {
    const held = { network_id: 361, count: 1, metadata: 0, has_stack_id: true, stack_id: 5, block_runtime_id: 0 };
    const p = milkTransaction({ target: 42n, hotbarSlot: 3, held, eye: { x: 1, y: 2.62, z: 3 }, click: { x: 0, y: 0.84, z: 0 } }) as { transaction: { transaction_type: string; transaction_data: Record<string, unknown> } };
    expect(p.transaction.transaction_type).toBe('item_use_on_entity');
    expect(p.transaction.transaction_data).toMatchObject({ entity_runtime_id: 42n, action_type: 'interact', hotbar_slot: 3, hand: 'main_hand', held_item: held, player_pos: { x: 1, y: 2.62, z: 3 }, click_pos: { x: 0, y: 0.84, z: 0 } });
  });
});

/** A bot with buckets and mobs: a click on a cow turns one empty bucket into a milk bucket (unless `refuse`). */
function milkRig(o: { buckets?: number; mobs?: EntityInfo[]; refuse?: boolean; hostileAfter?: number; pen?: Pen; penAt?: (p: Vec3) => Pen | undefined } = {}) {
  const entities = new Map<bigint, EntityInfo>();
  for (const e of o.mobs ?? [ent(1, 'cow', 6, 0)]) entities.set(e.runtimeId, e);
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  slots[0] = item('iron_sword', 1);
  if (o.buckets) slots[20] = item(BUCKET, o.buckets);
  const inv = { slots, selected: 0 };
  const pos = { x: 0, y: 0, z: 0 };
  const sent: { name: string; params: Record<string, unknown> }[] = [];
  const log: string[] = [];
  let clicks = 0;
  const milker = new Milker({
    entities: () => entities,
    mover: {
      goto: (g) => {
        if (g.type === 'near') {
          pos.x = g.p.x - 1;
          pos.z = g.p.z;
        }
        log.push(`goto ${g.type}`);
        return Promise.resolve({ ok: true });
      },
    },
    loop: { state: { pos }, setCommand: () => undefined, waitTicks: () => Promise.resolve() },
    inventory: inv,
    hotbar: {
      select: (s) => {
        inv.selected = s;
        return true;
      },
      rawItem: (s) => (slots[s] ? { network_id: 7, count: slots[s].count, metadata: 0, has_stack_id: false, block_runtime_id: 0 } : undefined),
    },
    puller: {
      pull: () => {
        slots[1] = slots[20]!;
        slots[20] = null;
        inv.selected = 1;
        log.push('pull');
        return Promise.resolve({ ok: true });
      },
    },
    source: {
      queue: (name, params) => {
        sent.push({ name, params });
        if (name !== 'inventory_transaction' || o.refuse) return;
        clicks++;
        const td = (params.transaction as { transaction_data: { hotbar_slot: number } }).transaction_data;
        const s = slots[td.hotbar_slot]!;
        // BDS: a stack of one becomes the milk bucket; a bigger stack loses one and the milk goes to a free slot
        if (s.count === 1) slots[td.hotbar_slot] = item(MILK, 1);
        else {
          slots[td.hotbar_slot] = item(BUCKET, s.count - 1);
          slots[slots.findIndex((x, i) => i >= 9 && x === null)] = item(MILK, 1);
        }
      },
    },
    isBaby: () => false,
    threat: () => (o.hostileAfter !== undefined && clicks >= o.hostileAfter ? 'a zombie 7 blocks away' : undefined),
    ...(o.pen
      ? {
          penOf: () => o.pen,
          penAt: (p: Vec3) => o.penAt?.(p),
          leavePen: (pen: Pen) => {
            log.push(`leave ${pen.id}`);
            return Promise.resolve({ ok: true, closed: 1 });
          },
          closeGates: (pen: Pen) => {
            log.push(`close ${pen.id}`);
            return Promise.resolve(1);
          },
        }
      : {}),
  });
  return { milker, slots, sent, log, entities };
}

describe('the Milker', () => {
  it('fills every bucket at one cow (a stack of 3 buckets pulled into the hotbar)', async () => {
    const r = milkRig({ buckets: 3 });
    const res = await r.milker.milk({ center: { x: 0, y: 0, z: 0 }, radius: 24, want: 3 }, () => false);
    expect(res).toMatchObject({ ok: true, reason: 'done', milked: 3, kinds: { cow: 3 } });
    expect(bucketCounts(r.slots)).toEqual({ milk: 3, empty: 0 });
    expect(r.log).toContain('pull');
    const tx = r.sent.filter((s) => s.name === 'inventory_transaction');
    expect(tx).toHaveLength(3);
    expect(r.sent.filter((s) => s.name === 'interact')).toHaveLength(3); // the hover before every click
  });

  it('no bucket, no mob, a hostile, a mob that gives none', async () => {
    expect((await milkRig({ buckets: 0 }).milker.milk({ center: { x: 0, y: 0, z: 0 }, radius: 24, want: 1 }, () => false)).reason).toBe('no_bucket');
    expect((await milkRig({ buckets: 1, mobs: [ent(1, 'pig', 3, 0)] }).milker.milk({ center: { x: 0, y: 0, z: 0 }, radius: 24, want: 1 }, () => false)).reason).toBe('no_mob');
    const h = await milkRig({ buckets: 3, hostileAfter: 1 }).milker.milk({ center: { x: 0, y: 0, z: 0 }, radius: 24, want: 3 }, () => false);
    expect(h).toMatchObject({ reason: 'hostile', milked: 1, threat: 'a zombie 7 blocks away' });
    const ref = milkRig({ buckets: 1, refuse: true });
    const rr = await ref.milker.milk({ center: { x: 0, y: 0, z: 0 }, radius: 24, want: 1 }, () => false);
    expect(rr).toMatchObject({ ok: false, reason: 'refused', milked: 0, refused: 1 });
    expect(ref.milker.ignored(1n)).toBe(true); // left alone for 30 s
    expect(await ref.milker.milk({ center: { x: 0, y: 0, z: 0 }, radius: 24, want: 1 }, () => true)).toMatchObject({ reason: 'interrupted' });
  });

  it('Track K2: milked from the open gateway (the rim; the fill from there escapes): the pen is still left and its gate closed', async () => {
    // the cow at x 6 inside a pen 6..12; the walk ends at x 5, the fence line, where penAt finds nothing
    const pen: Pen = { id: '6,0,-3', y: 0, min: { x: 6, z: -3 }, max: { x: 12, z: 3 }, cells: 49, fences: 32 };
    const r = milkRig({ buckets: 1, pen });
    expect((await r.milker.milk({ center: { x: 0, y: 0, z: 0 }, radius: 24, want: 1 }, () => false)).milked).toBe(1);
    expect(r.log).toContain('leave 6,0,-3');
    // walked back out of reach of the rim before the end: the gate is closed from where it stands
    const far = milkRig({ buckets: 1, pen, mobs: [ent(1, 'cow', 20, 0)] });
    await far.milker.milk({ center: { x: 0, y: 0, z: 0 }, radius: 24, want: 1 }, () => false);
    expect(far.log.filter((l) => l.startsWith('leave') || l.startsWith('close'))).toEqual(['close 6,0,-3']);
  });
});

describe('the unloader keeps the milk on hand', () => {
  const slot = (s: number, name: string, count: number): UnloadSlot => ({ slot: s, name, count });
  it('milkKeep milk buckets and the empty buckets that refill the rest; the surplus is unloaded', () => {
    expect([...milkReserve([slot(1, 'milk_bucket', 1), slot(2, 'bucket', 5)], 2)]).toEqual([['milk_bucket', 1], ['bucket', 1]]);
    expect([...milkReserve([slot(1, 'milk_bucket', 1), slot(2, 'milk_bucket', 1), slot(3, 'milk_bucket', 1), slot(4, 'bucket', 2)], 2)]).toEqual([['milk_bucket', 2]]);
    expect(milkReserve([slot(1, 'milk_bucket', 1)], 0).size).toBe(0);
    const chest = { key: 'a', pos: { x: 3, y: 0, z: 0 }, kind: 'chest', free: 27, contents: {}, room: {}, boxes: { empty: 0, full: 0 } };
    const plan = planUnload([slot(10, 'milk_bucket', 1), slot(11, 'milk_bucket', 1), slot(12, 'milk_bucket', 1), slot(13, 'bucket', 4), slot(14, 'dirt', 64)], [chest], { milkKeep: 2, reserve: 0 });
    expect(plan.kept).toContainEqual({ name: 'milk_bucket', count: 2, why: 'milk_reserve' });
    expect(plan.moves.filter((m) => m.name === 'milk_bucket').reduce((a, m) => a + m.count, 0)).toBe(1);
    expect(plan.moves.filter((m) => m.name === 'bucket').reduce((a, m) => a + m.count, 0)).toBe(4);
    // one milk bucket carried: one empty bucket stays to refill the second
    const p2 = planUnload([slot(10, 'milk_bucket', 1), slot(13, 'bucket', 4)], [chest], { reserve: 0 });
    expect(p2.kept).toEqual(expect.arrayContaining([{ name: 'milk_bucket', count: 1, why: 'milk_reserve' }, { name: 'bucket', count: 1, why: 'milk_reserve' }]));
    expect(p2.moves.find((m) => m.name === 'bucket')?.count).toBe(3);
  });
});

/** The job and the chore on fakes: a source that records its calls, a milker that fills the buckets. */
function jobRig(o: { input?: Partial<MilkStockInput>; settings?: Record<string, unknown>; at?: Vec3; cows?: number; day?: boolean; threat?: string } = {}) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  const input = { ...base(), ...o.input };
  const put = (name: string, n: number): void => {
    for (let k = 0; k < n; k++) slots[slots.findIndex((x) => x === null)] = item(name, 1);
  };
  put(MILK, input.milk);
  if (input.empty) slots[30] = item(BUCKET, input.empty);
  const calls: string[] = [];
  const take = (where: string) => (name: string, n: number) => {
    calls.push(`${where} ${n} ${name}`);
    const pool = where === 'boxes' ? (name === MILK ? 'boxedMilk' : 'boxedEmpty') : name === MILK ? 'homeMilk' : 'homeEmpty';
    const got = Math.min(n, input[pool]);
    input[pool] -= got;
    if (name === MILK) put(MILK, got);
    else slots[31] = item(BUCKET, (slots[31]?.count ?? 0) + got);
    return Promise.resolve({ got });
  };
  const source: MilkSource = {
    input: (keep) => ({ ...input, keep, ...bucketCounts(slots) }),
    fromBoxes: take('boxes'),
    fromHome: take('home'),
    craft: () => {
      calls.push('craft');
      slots[32] = item(BUCKET, 1);
      return Promise.resolve({ ok: true, line: 'crafted 1 bucket' });
    },
  };
  const settings = new RuntimeSettings();
  for (const [k, v] of Object.entries(o.settings ?? {})) settings.set(k as never, v);
  const processes = new ProcessManager();
  let t = 0;
  const cows = Array.from({ length: o.cows ?? 1 }, (_, i) => ent(i + 1, 'cow', 5 + i, 0));
  const d: MilkDeps = {
    processes,
    settings,
    milker: {
      targets: () => cows,
      milk: (q) => {
        calls.push(`milk ${q.want}`);
        let n = 0;
        for (let i = 0; i < 36 && n < q.want && cows.length; i++) {
          const s = slots[i];
          if (s?.name !== BUCKET) continue;
          while (s.count > 0 && n < q.want) {
            s.count--;
            n++;
            put(MILK, 1);
          }
          if (s.count === 0) slots[i] = null;
        }
        const kinds: Record<string, number> = n ? { cow: n } : {};
        return Promise.resolve({ ok: n > 0, reason: n > 0 ? 'done' : cows.length ? 'no_bucket' : 'no_mob', milked: n, kinds, refused: 0, ms: 0 });
      },
    },
    source,
    position: () => o.at ?? { x: 0, y: 0, z: 0 },
    home: () => ({ x: 0, y: 0, z: 0 }),
    inventory: { slots },
    isDay: () => o.day ?? true,
    threat: () => o.threat,
    cancel: () => undefined,
    now: () => t,
  };
  return { d, calls, slots, processes, settings, advance: (ms: number) => (t += ms) };
}

describe('the job (MilkJob) and the reply', () => {
  it('runs the plan in order and says what it got', async () => {
    const r = jobRig({ input: { keep: 3, boxedMilk: 1, empty: 0, boxedEmpty: 1, homeEmpty: 2, atHome: true } });
    const rep = await new MilkJob({ keep: 3, cows: true, center: () => ({ x: 0, y: 0, z: 0 }), radius: 24 }).run(r.d, () => false);
    expect(r.calls).toEqual(['boxes 1 milk_bucket', 'boxes 1 bucket', 'home 1 bucket', 'milk 2']);
    expect(rep).toMatchObject({ ok: true, before: 0, after: 3, fromBoxes: 1, milked: 2, reason: 'done' });
    expect(milkReply(rep)).toBe('milk: 3 milk buckets carried (1 out of a carried box, 2 from a cow)');
  });

  it('the early game: a bucket crafted, then milked', async () => {
    const r = jobRig({ input: { keep: 2, iron: 3, table: true } });
    const rep = await new MilkJob({ keep: 2, cows: true, center: () => ({ x: 0, y: 0, z: 0 }), radius: 24 }).run(r.d, () => false);
    expect(r.calls).toEqual(['craft', 'milk 1']);
    expect(milkReply(rep)).toBe('milk: 1 milk bucket carried (a bucket crafted from 3 iron ingots, 1 from a cow); 1 short of 2: 1 more need a bucket');
  });

  it('no iron: nothing, and the reply says so', async () => {
    const r = jobRig({ input: { keep: 2 } });
    const rep = await new MilkJob({ keep: 2, cows: true, center: () => ({ x: 0, y: 0, z: 0 }), radius: 24 }).run(r.d, () => false);
    expect(r.calls).toEqual([]);
    expect(milkReply(rep)).toBe('milk: 0 milk buckets carried (nothing new); 2 short of 2: no bucket and no iron (3 iron ingots make one)');
  });
});

describe('the chore (autoMilk) and the trip readiness', () => {
  const tick = (r: ReturnType<typeof jobRig>, n = 1) => {
    for (let i = 0; i < n; i++) {
      r.advance(1000);
      r.processes.tick();
    }
  };
  it('off by default; on: idle at home by day with an empty bucket and a cow near, it refills', async () => {
    const off = jobRig({ input: { keep: 2, milk: 1, empty: 1 } });
    const c0 = new MilkController(off.d);
    tick(off, 3);
    expect(c0.chore.stats.started).toBe(0);
    expect(SETTING_DEFS.autoMilk.default).toBe(false);
    const on = jobRig({ input: { keep: 2, milk: 1, empty: 1 }, settings: { autoMilk: true } });
    const c = new MilkController(on.d);
    tick(on);
    expect(c.chore.stats.started).toBe(1);
    await new Promise((res) => setTimeout(res, 0));
    tick(on);
    expect(bucketCounts(on.slots).milk).toBe(2);
    expect(on.calls).toEqual(['milk 1']);
  });

  it('not by night, away from home or with a hostile near; no cow: backs off 10 min', () => {
    for (const o of [{ day: false }, { at: { x: 30, y: 0, z: 0 } }, { threat: 'a zombie 6 blocks away' }]) {
      const r = jobRig({ input: { keep: 2, milk: 1, empty: 1 }, settings: { autoMilk: true }, ...o });
      const c = new MilkController(r.d);
      tick(r, 2);
      expect(c.chore.stats.started).toBe(0);
    }
    const r = jobRig({ input: { keep: 2, milk: 1, empty: 1 }, settings: { autoMilk: true }, cows: 0 });
    const c = new MilkController(r.d);
    tick(r);
    expect(c.chore.stats.started).toBe(0);
    expect(c.chore.lastWhy).toBe('no cow, mooshroom or goat within 24 blocks of home');
    expect(c.chore.nextTry).toBe(MILK_BACKOFF_MS); // checked when it was added (t 0)
  });

  it('the trip readiness: only when the boxes (or the chests at home, there) hold milk; storage only', async () => {
    expect(new MilkController(jobRig({ input: { keep: 2, empty: 2, iron: 9, table: true } }).d).tripNeeded()).toBe(false);
    expect(new MilkController(jobRig({ input: { keep: 2, homeMilk: 3 } }).d).tripNeeded()).toBe(false); // away from home
    const r = jobRig({ input: { keep: 2, homeMilk: 3, atHome: true, empty: 1 } });
    const c = new MilkController(r.d);
    expect(c.tripNeeded()).toBe(true);
    const rep = await c.tripRun(() => true);
    expect(r.calls).toEqual(['home 2 milk_bucket']);
    expect(rep.after).toBe(2);
  });

  it('the status part', () => {
    expect(new MilkController(jobRig({ input: { keep: 2, milk: 1, empty: 1 } }).d).statusPart()).toBe('1/2 (1 empty bucket)');
    expect(new MilkController(jobRig({ input: { keep: 2 } }).d).statusPart()).toBe('0/2 (no bucket and no iron (3 iron ingots make one))');
    expect(new MilkController(jobRig({ input: { keep: 0 }, settings: { milkKeep: 0 } }).d).statusPart()).toBeUndefined();
  });
});

describe('Track K2: empty buckets only in the chests at home (the Realm bug)', () => {
  const home = { x: 100, y: 64, z: 100 };
  it('the chests count within homeChestRadius + 8 of home across and 16 up or down, not only the logistics 8', () => {
    expect(homeChestReach(home, { x: 102.5, y: 64, z: 100.5 }, 16)).toEqual({ inReach: true });
    // the bot idle in its shelter 20 blocks off and a floor up: the logistics' atHome said no; the chests count
    expect(homeChestReach(home, { x: 120.5, y: 70, z: 100.5 }, 16)).toEqual({ inReach: true });
    expect(homeChestReach(home, { x: 130.5, y: 64, z: 100.5 }, 16)).toEqual({ inReach: false, why: 'I am 30 blocks from home (they count within 24)' });
    expect(homeChestReach(home, { x: 100.5, y: 40, z: 100.5 }, 16)).toEqual({ inReach: false, why: 'I am 24 blocks below home (they count within 16 up or down)' });
    expect(homeChestReach(undefined, { x: 0, y: 0, z: 0 }, 16)).toEqual({ inReach: false, why: 'no home set' });
  });

  it('the plan: in reach, 2 buckets from the chests at home then the cows; out of reach, the reason in the short', () => {
    const i = base({ keep: 2, homeEmpty: 213, atHome: true });
    expect(planMilk(i, { cows: true })).toEqual({ want: 2, steps: [{ kind: 'home', item: BUCKET, n: 2 }, { kind: 'cows', n: 2 }] });
    const away = planMilk(base({ keep: 2, homeEmpty: 213, homeWhy: 'I am 30 blocks from home (they count within 24)' }), { cows: true });
    expect(away).toMatchObject({ steps: [], short: '2 more: 213 buckets in the chests at home, out of reach: I am 30 blocks from home (they count within 24)' });
  });

  it('a take that got less: the reply names the step and its reason (not the plan\'s description), and the log has a line', async () => {
    const r = jobRig({ input: { keep: 2, homeEmpty: 213, atHome: true } });
    const lines: string[] = [];
    r.d.log = { debug: () => undefined, info: (m: string) => lines.push(m), warn: () => undefined, error: () => undefined };
    r.d.source.fromHome = (name, n) => {
      r.calls.push(`home ${n} ${name}`);
      return Promise.resolve({ got: 0, why: 'the chests at home gave none (fewer there than remembered)' });
    };
    const rep = await new MilkJob({ keep: 2, cows: true, center: () => ({ x: 0, y: 0, z: 0 }), radius: 24 }).run(r.d, () => false);
    expect(r.calls).toEqual(['home 2 bucket']); // no milking with no bucket
    expect(rep.failed).toBe('buckets out of the chests at home: the chests at home gave none (fewer there than remembered)');
    expect(milkReply(rep)).toBe('milk: 0 milk buckets carried (nothing new); 2 short of 2: buckets out of the chests at home: the chests at home gave none (fewer there than remembered)');
    expect(lines).toContain('milk: plan for 2: 2 bucket from the chests at home, 2 at the cows');
    expect(lines).toContain('milk: buckets out of the chests at home: got 0 of 2 (the chests at home gave none (fewer there than remembered))');
  });

  it('a take with no reason given: `got n of m`; a part of them is milked and the reply still names the step', async () => {
    const r = jobRig({ input: { keep: 2, homeEmpty: 1, atHome: true } }); // the rig's chests give only 1 of 2
    r.d.source.input = (keep) => ({ ...base({ keep, homeEmpty: 213, atHome: true }), ...bucketCounts(r.slots) });
    const rep = await new MilkJob({ keep: 2, cows: true, center: () => ({ x: 0, y: 0, z: 0 }), radius: 24 }).run(r.d, () => false);
    expect(r.calls).toEqual(['home 2 bucket', 'milk 1']);
    expect(milkReply(rep)).toBe('milk: 1 milk bucket carried (1 from a cow); 1 short of 2: buckets out of the chests at home: got 1 of 2');
  });

  it('nothing to do: the plan line says why, and the reply keeps the plan\'s reason', async () => {
    const r = jobRig({ input: { keep: 2, homeEmpty: 213, homeWhy: 'I am 30 blocks from home (they count within 24)' } });
    const lines: string[] = [];
    r.d.log = { debug: () => undefined, info: (m: string) => lines.push(m), warn: () => undefined, error: () => undefined };
    const rep = await new MilkJob({ keep: 2, cows: true, center: () => ({ x: 0, y: 0, z: 0 }), radius: 24 }).run(r.d, () => false);
    expect(r.calls).toEqual([]);
    expect(lines).toEqual(['milk: plan for 2: nothing to do (2 more: 213 buckets in the chests at home, out of reach: I am 30 blocks from home (they count within 24))']);
    expect(milkReply(rep)).toContain('2 short of 2: 2 more: 213 buckets in the chests at home, out of reach: I am 30 blocks');
  });

  it('the trip readiness and the chore take the same chests: milk from home in reach, buckets from home for the chore', async () => {
    const t = jobRig({ input: { keep: 2, homeMilk: 3, atHome: true } });
    const rep = await new MilkController(t.d).tripRun(() => true);
    expect(t.calls).toEqual(['home 2 milk_bucket']);
    expect(rep.after).toBe(2);
    const c = jobRig({ input: { keep: 2, homeEmpty: 213, atHome: true }, settings: { autoMilk: true } });
    const ctl = new MilkController(c.d);
    c.advance(1000);
    c.processes.tick();
    expect(ctl.chore.stats.started).toBe(1);
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    expect(c.calls).toEqual(['home 2 bucket', 'milk 2']);
    // the chore's status names a failed take too
    const f = jobRig({ input: { keep: 2, homeEmpty: 213, atHome: true }, settings: { autoMilk: true } });
    f.d.source.fromHome = () => Promise.resolve({ got: 0, why: 'the chests at home gave none (fewer there than remembered)' });
    const fc = new MilkController(f.d);
    f.advance(1000);
    f.processes.tick();
    for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));
    expect(fc.chore.lastWhy).toBe('buckets out of the chests at home: the chests at home gave none (fewer there than remembered)');
  });
});

describe('the settings', () => {
  it('milkKeep 2, autoMilk off, milkCraft on, all in the food group', () => {
    expect(SETTING_DEFS.milkKeep.default).toBe(2);
    expect(SETTING_DEFS.milkCraft.default).toBe(true);
    const food = SETTING_GROUPS.find(([g]) => g === 'food')![1];
    for (const k of ['milkKeep', 'autoMilk', 'milkCraft']) expect(food).toContain(k);
  });
});
