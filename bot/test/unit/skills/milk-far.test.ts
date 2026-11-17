// Track K3 (ADR 0096 decision 13, docs/pve.md "Milk on hand"): cows farther out. The mobs seen (MilkSightings), the range
// choice (farChoice: in view or seen, within milkRange, the nearest named when none is), the Milker's far walk (the normal
// walk, stopped by a hostile within 16 or the night), where a seen mob was and is no more, the job's reply and its walk
// home, and the setting (milkRange 24 by default: nothing walks farther until it is raised).
import { describe, expect, it } from 'vitest';
import { RuntimeSettings, SETTING_DEFS } from '../../../src/config/settings.ts';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { BUCKET, bucketCounts, candidateLine, farChoice, MILK, MILK_SEEN_MS, MilkSightings, Milker, type MilkResult } from '../../../src/skills/food/milk.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { MilkJob, milkRange, milkReply, type MilkDeps } from '../../../src/tasks/process/milk.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const item = (name: string, count: number): ItemStack => ({ name, networkId: 1, count, metadata: 0 });
function ent(rid: number, type: string, x: number, z: number, y = 0): EntityInfo {
  return { runtimeId: BigInt(rid), uniqueId: BigInt(rid), type: `minecraft:${type}`, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 };
}
const q = (center: Vec3, radius: number, now = 0) => ({ center, radius, me: center, isBaby: () => false, now });

describe('the mobs seen (MilkSightings)', () => {
  it('a milkable adult that goes out of view is remembered where it was; not a pig, a calf or a dead one; it expires', () => {
    let t = 0;
    const s = new MilkSightings(() => t);
    s.gone(ent(1, 'cow', 40, 0), false, false);
    s.gone(ent(2, 'pig', 10, 0), false, false);
    s.gone(ent(3, 'cow', 12, 0), true, false);
    s.gone(ent(4, 'goat', 14, 0), false, true);
    s.gone(ent(5, 'mooshroom', 30, 5), false, false);
    expect(s.list(new Map()).map((x) => [x.rid, x.kind])).toEqual([[1n, 'cow'], [5n, 'mooshroom']]);
    // back in view: the live entity counts, not the sighting
    expect(s.list(new Map([[1n, {}]])).map((x) => x.rid)).toEqual([5n]);
    t = MILK_SEEN_MS + 1;
    expect(s.list(new Map())).toEqual([]);
    expect(s.size).toBe(0);
  });
});

describe('the range choice (farChoice)', () => {
  it('the nearest within the range, in view or seen; none within: the nearest known one', () => {
    const live = [ent(1, 'cow', 50, 0), ent(2, 'pig', 5, 0)];
    const seen = [{ rid: 9n, kind: 'goat', feet: { x: 0, y: 0, z: 30 }, at: 0 }];
    const c = farChoice(live, seen, q({ x: 0, y: 0, z: 0 }, 64, 120_000));
    expect(c.target).toMatchObject({ rid: 9n, kind: 'goat', d: 30, live: false, ago: 120_000 });
    expect(candidateLine(c.target!)).toBe('a goat 30 blocks away (seen 2 min ago)');
    const none = farChoice(live, seen, q({ x: 0, y: 0, z: 0 }, 24));
    expect(none.target).toBeUndefined();
    expect(candidateLine(none.nearest!)).toBe('a goat 30 blocks away (seen 1 s ago)');
    expect(farChoice([], [], q({ x: 0, y: 0, z: 0 }, 96))).toEqual({});
    // up or down at most 16 (terrain, not a cave)
    expect(farChoice([ent(1, 'cow', 40, 0, -30)], [], q({ x: 0, y: 0, z: 0 }, 64)).target).toBeUndefined();
    expect(candidateLine(farChoice([ent(1, 'cow', 40, 0)], [], q({ x: 0, y: 0, z: 0 }, 64)).target!)).toBe('a cow 40 blocks away');
  });
});

/** A bot with buckets at x 0 and mobs; `hold`: the walk waits until stopped; `back`: the entity in view again on arrival. */
function farRig(o: { mobs?: EntityInfo[]; buckets?: number; hold?: boolean; threatAt?: number; day?: () => boolean; back?: EntityInfo } = {}) {
  const entities = new Map<bigint, EntityInfo>();
  for (const e of o.mobs ?? [ent(1, 'cow', 50, 0)]) entities.set(e.runtimeId, e);
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  slots[0] = item(BUCKET, o.buckets ?? 2);
  const inv = { slots, selected: 0 };
  const pos = { x: 0, y: 0, z: 0 };
  const log: string[] = [];
  let ticks = 0;
  let release: ((r: { ok: boolean; reason?: string }) => void) | undefined;
  const milker = new Milker({
    entities: () => entities,
    mover: {
      goto: (g, opts) => {
        log.push(`goto ${g.type} ${opts?.timeoutTicks ?? ''}`);
        if (o.hold) return new Promise((res) => (release = res as never));
        if (g.type === 'near') {
          pos.x = g.p.x - 1;
          pos.z = g.p.z;
        }
        if (o.back && !entities.has(o.back.runtimeId)) entities.set(o.back.runtimeId, o.back);
        return Promise.resolve({ ok: true });
      },
    },
    loop: {
      state: { pos },
      setCommand: () => undefined,
      waitTicks: (n) => {
        ticks += n;
        return Promise.resolve();
      },
    },
    inventory: inv,
    hotbar: { select: () => true, rawItem: () => ({ network_id: 7, count: 1, metadata: 0, has_stack_id: false, block_runtime_id: 0 }) },
    source: {
      queue: (name) => {
        if (name !== 'inventory_transaction') return;
        const s = slots[0]!;
        if (s.count === 1) slots[0] = item(MILK, 1);
        else {
          slots[0] = item(BUCKET, s.count - 1);
          slots[slots.findIndex((x, i) => i >= 9 && x === null)] = item(MILK, 1);
        }
      },
    },
    isBaby: () => false,
    threat: () => (o.threatAt !== undefined && ticks >= o.threatAt ? 'a zombie 9 blocks away' : undefined),
    ...(o.day ? { isDay: o.day } : {}),
    stopWalk: () => {
      log.push('stop');
      release?.({ ok: false, reason: 'interrupted' });
    },
    log: { debug: () => undefined, info: (m: string) => log.push(m), warn: () => undefined, error: () => undefined },
  });
  return { milker, slots, log, entities, pos };
}

describe('the far walk (Milker)', () => {
  const o = { x: 0, y: 0, z: 0 };

  it('`far` within milkRange 64: walks to the cow 50 blocks out (time from the distance), milks both buckets', async () => {
    const r = farRig();
    const res = await r.milker.milk({ center: o, radius: 64, want: 2, far: true }, () => false);
    expect(res).toMatchObject({ ok: true, reason: 'done', milked: 2, walked: { kind: 'cow', d: 50 } });
    expect(r.log).toContain('milk: walking to a cow 50 blocks away (1000 ticks at most)');
    expect(r.log.find((l) => l.startsWith('goto'))).toBe('goto near 1000');
    expect(bucketCounts(r.slots)).toEqual({ milk: 2, empty: 0 });
  });

  it('the default range (24): the cow 50 blocks out is not walked to', async () => {
    const r = farRig();
    const res = await r.milker.milk({ center: o, radius: 24, want: 2 }, () => false);
    expect(res).toMatchObject({ reason: 'no_mob', milked: 0 });
    expect(r.log.filter((l) => l.startsWith('goto'))).toEqual([]);
  });

  it('a hostile within 16 during the walk stops it; so does the night, before it starts', async () => {
    const h = farRig({ hold: true, threatAt: 15 });
    const res = await h.milker.milk({ center: o, radius: 64, want: 2, far: true }, () => false);
    expect(res).toMatchObject({ reason: 'hostile', threat: 'a zombie 9 blocks away', milked: 0 });
    expect(h.log).toContain('stop');
    const n = farRig({ day: () => false });
    expect((await n.milker.milk({ center: o, radius: 64, want: 2, far: true }, () => false)).reason).toBe('night');
    expect(n.log.filter((l) => l.startsWith('goto'))).toEqual([]);
  });

  it('a cow seen out of view: walked to where it was, milked when it is there again; not there: forgotten', async () => {
    const cow = ent(7, 'cow', 40, 0);
    const r = farRig({ mobs: [], back: cow });
    r.milker.sightings.gone(cow, false, false);
    const res = await r.milker.milk({ center: o, radius: 64, want: 2, far: true }, () => false);
    expect(res).toMatchObject({ milked: 2, walked: { kind: 'cow', d: 40, live: false } });
    const gone = farRig({ mobs: [] });
    gone.milker.sightings.gone(cow, false, false);
    const g = await gone.milker.milk({ center: o, radius: 64, want: 2, far: true }, () => false);
    expect(g).toMatchObject({ reason: 'no_mob', milked: 0 });
    expect(gone.log).toContain('milk: no cow where one was seen');
    expect(gone.milker.sightings.size).toBe(0);
    // none within the range: the nearest known one is in the result
    const out = farRig({ mobs: [ent(3, 'goat', 80, 0)] });
    expect((await out.milker.milk({ center: o, radius: 64, want: 1, far: true }, () => false)).nearest).toMatchObject({ kind: 'goat', d: 80 });
  });
});

/** The job with a scripted milker result and a recorded walk home. */
function jobWith(res: Partial<MilkResult>, o: { at?: Vec3 } = {}) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  slots[0] = item(BUCKET, 2);
  const calls: string[] = [];
  const d: MilkDeps = {
    processes: new ProcessManager(),
    settings: new RuntimeSettings(),
    milker: {
      targets: () => [],
      milk: (m) => {
        calls.push(`milk ${m.radius}${m.far ? ' far' : ''}`);
        const n = res.milked ?? 0;
        if (n > 0) slots[0] = null;
        for (let i = 0; i < n; i++) slots[1 + i] = item(MILK, 1);
        return Promise.resolve({ ok: n > 0, reason: 'done', milked: n, kinds: n ? { cow: n } : {}, refused: 0, ms: 0, ...res });
      },
    },
    source: {
      input: (keep) => ({ keep, ...bucketCounts(slots), boxedMilk: 0, boxedEmpty: 0, homeMilk: 0, homeEmpty: 0, atHome: true, iron: 0, craft: true, table: false }),
      fromBoxes: () => Promise.resolve({ got: 0 }),
      fromHome: () => Promise.resolve({ got: 0 }),
      craft: () => Promise.resolve({ ok: false, line: 'no' }),
    },
    position: () => o.at ?? { x: 50, y: 0, z: 0 },
    home: () => ({ x: 0, y: 0, z: 0 }),
    inventory: { slots },
    isDay: () => true,
    threat: () => undefined,
    cancel: () => undefined,
    goHome: () => {
      calls.push('home');
      return Promise.resolve({ ok: true });
    },
  };
  return { d, calls };
}

describe('the job (`!milk far`): the reply and the walk home', () => {
  const opts = { keep: 2, cows: true, center: () => ({ x: 0, y: 0, z: 0 }), radius: 64, far: true };

  it('walked out and milked: home after, and the reply says both', async () => {
    const j = jobWith({ milked: 2, walked: { rid: 1n, kind: 'cow', feet: { x: 50, y: 0, z: 0 }, d: 50, live: true } });
    const r = await new MilkJob(opts).run(j.d, () => false);
    expect(j.calls).toEqual(['milk 64 far', 'home']);
    expect(milkReply(r)).toBe('milk: 2 milk buckets carried (2 from a cow); went to a cow 50 blocks away; walked home');
  });

  it('none known within the range: the reply names the nearest one (or none seen); nothing walks home', async () => {
    const j = jobWith({ milked: 0, reason: 'no_mob', ok: false, nearest: { rid: 3n, kind: 'cow', feet: { x: 80, y: 0, z: 0 }, d: 80, live: false, ago: 120_000 } }, { at: { x: 0, y: 0, z: 0 } });
    const r = await new MilkJob(opts).run(j.d, () => false);
    expect(milkReply(r)).toBe('milk: 0 milk buckets carried (nothing new); 2 short of 2: no cow, mooshroom or goat known within 64 blocks (the nearest I know: a cow 80 blocks away (seen 2 min ago)); 2 empty buckets left');
    expect(j.calls).toEqual(['milk 64 far']);
    const none = jobWith({ milked: 0, reason: 'no_mob', ok: false });
    expect(milkReply(await new MilkJob(opts).run(none.d, () => false))).toContain('no cow, mooshroom or goat known within 64 blocks (none seen)');
    // plain `!milk`: as before
    const plain = jobWith({ milked: 0, reason: 'no_mob', ok: false });
    expect(milkReply(await new MilkJob({ ...opts, radius: 24, far: false }).run(plain.d, () => false))).toContain('2 short of 2: no cow, mooshroom or goat within 24 blocks');
  });
});

describe('the setting (milkRange)', () => {
  it('24 by default (MILK_RADIUS: nothing walks farther), 24 to 96, in the food group; read clamped', () => {
    expect(SETTING_DEFS.milkRange).toMatchObject({ default: 24, min: 24, max: 96 });
    expect(SETTING_GROUPS.find(([g]) => g === 'food')![1]).toContain('milkRange');
    const s = new RuntimeSettings();
    expect(milkRange(s)).toBe(24);
    s.set('milkRange', 64);
    expect(milkRange(s)).toBe(64);
  });
});
