// Track AF (wave 8, food v2, docs/food.md) on fakes: the chorePen / autoBreed settings, pen detection
// (flood fill over fences, walls, gates), the pen rules of the target choice, herd marks (store,
// persistence, observation, the stale-mark rule), the breeder's packets and pairs, walks to remembered
// herds in the food job, and the breeding chore's trigger.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeSetting, parseSettingValue, RuntimeSettings, SETTING_DEFS, SettingError } from '../../../src/config/settings.ts';
import { breedReply, foodReply } from '../../../src/chat/commands-food.ts';
import { Breeder, breedable, breedItemCount, breedFoodOf, feedTransaction, samePenPair } from '../../../src/skills/food/breed.ts';
import type { Cooker } from '../../../src/skills/food/cook.ts';
import { pickTarget } from '../../../src/skills/food/finder.ts';
import { cellKey, HerdMemory, markOffers } from '../../../src/skills/food/herds.ts';
import { Hunter } from '../../../src/skills/food/hunter.ts';
import { detectPen, inPenOrRim, PenDetector, penExit, penGates, penNear, type Pen } from '../../../src/skills/food/pen.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import type { FightResult } from '../../../src/skills/combat/combat.ts';
import { BREED_PERIOD_MS, FoodController, FoodJob, noPenLine, parseChorePen, type FoodDeps } from '../../../src/tasks/process/food.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { HerdMarks, type HerdMark } from '../../../src/world/cache/herds.ts';
import type { BlockInfo, EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const item = (name: string, count: number): ItemStack => ({ name, networkId: 1, count, metadata: 0 });

function ent(rid: number, type: string, x: number, z: number, y = 0): EntityInfo {
  return { runtimeId: BigInt(rid), uniqueId: BigInt(rid), type: `minecraft:${type}`, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 };
}

/** A flat test world: grass at y -1, air above, unless set; columns outside `bound` are not loaded. */
class PenWorldFake {
  readonly blocks = new Map<string, BlockInfo>();
  readonly bound: number;
  constructor(bound = 64) {
    this.bound = bound;
  }
  set(x: number, y: number, z: number, name: string, states: Record<string, unknown> = {}): void {
    this.blocks.set(`${x},${y},${z}`, blockInfoOf(name, states));
  }
  blockAt(p: Vec3): BlockInfo | undefined {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    if (Math.abs(x) > this.bound || Math.abs(z) > this.bound) return undefined;
    return this.blocks.get(`${x},${y},${z}`) ?? (y < 0 ? blockInfoOf('grass_block') : blockInfoOf('air'));
  }
  /** The truth `pen`: oak fence on the rim of x..x+w-1, z..z+d-1 at y 0, a gate in the middle of the north side. */
  pen(x0: number, z0: number, w: number, d: number, gate: { open?: boolean } | false = {}): Vec3 {
    for (let x = x0; x < x0 + w; x++) {
      for (let z = z0; z < z0 + d; z++) {
        if (x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + d - 1) this.set(x, 0, z, 'oak_fence');
      }
    }
    const g = { x: x0 + Math.floor(w / 2), y: 0, z: z0 };
    if (gate) this.set(g.x, 0, g.z, 'fence_gate', { open_bit: gate.open ? 1 : 0 });
    return g;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('settings: autoBreed, chorePen', () => {
  it('autoBreed is off by default; chorePen takes x y z or none', () => {
    expect(SETTING_DEFS.autoBreed.default).toBe(false);
    expect(SETTING_DEFS.chorePen.default).toBe('none');
    expect(parseSettingValue('chorePen', '10 -60 3')).toBe('10 -60 3');
    expect(parseSettingValue('chorePen', ' 10.7, -60, 3 ')).toBe('10 -60 3');
    expect(parseSettingValue('chorePen', 'NONE')).toBe('none');
    expect(() => parseSettingValue('chorePen', '10 -60')).toThrow(SettingError);
    expect(() => parseSettingValue('chorePen', 'home')).toThrow(/x y z/);
    expect(describeSetting('chorePen', 'none')).toMatch(/^chorePen none \(x y z\|none, default none\): /);
    const s = new RuntimeSettings();
    s.set('chorePen', '1 2 3');
    expect(s.get('chorePen')).toBe('1 2 3');
    expect(parseChorePen(s.get('chorePen'))).toEqual({ x: 1, y: 2, z: 3 });
    expect(parseChorePen('none')).toBeUndefined();
  });
});

describe('pens', () => {
  it('a fenced 7 x 7 with a closed or open gate is a pen; the interior is 5 x 5', () => {
    const w = new PenWorldFake();
    const g = w.pen(0, 0, 7, 7);
    const pen = detectPen(w, { x: 3.5, y: 0, z: 3.5 })!;
    expect(pen).toMatchObject({ id: '1,0,1', y: 0, min: { x: 1, z: 1 }, max: { x: 5, z: 5 }, cells: 25 });
    expect(pen.fences).toBe(20);
    // the same pen from another cell
    expect(detectPen(w, { x: 1.2, y: 0, z: 5.9 })?.id).toBe(pen.id);
    // an open gate is still the pen's wall
    w.set(g.x, 0, g.z, 'fence_gate', { open_bit: 1 });
    expect(detectPen(w, { x: 3.5, y: 0, z: 3.5 })?.id).toBe(pen.id);
    expect(penGates(w, pen)).toEqual([{ p: g, open: true }]);
    // outside the pen: not penned
    expect(detectPen(w, { x: 10.5, y: 0, z: 3.5 })).toBeUndefined();
  });

  it('a gap, a one-high wall, walls without fences, or unloaded blocks: not a pen', () => {
    const w = new PenWorldFake();
    w.pen(0, 0, 7, 7);
    w.set(0, 0, 3, 'air'); // a gap in the west side
    expect(detectPen(w, { x: 3.5, y: 0, z: 3.5 })).toBeUndefined();
    w.set(0, 0, 3, 'stone'); // one high: a cow hops over it
    expect(detectPen(w, { x: 3.5, y: 0, z: 3.5 })).toBeUndefined();
    w.set(0, 1, 3, 'stone'); // two high: a wall
    expect(detectPen(w, { x: 3.5, y: 0, z: 3.5 })).toBeDefined();
    // a room of 2-high stone without any fence is not a pen
    const s = new PenWorldFake();
    for (let i = 0; i < 7; i++) {
      for (const [x, z] of [
        [i, 0],
        [i, 6],
        [0, i],
        [6, i],
      ] as const) {
        s.set(x, 0, z, 'stone');
        s.set(x, 1, z, 'stone');
      }
    }
    expect(detectPen(s, { x: 3.5, y: 0, z: 3.5 })).toBeUndefined();
    // a cobblestone wall counts like a fence
    s.set(3, 0, 0, 'cobblestone_wall');
    s.set(3, 1, 0, 'air');
    expect(detectPen(s, { x: 3.5, y: 0, z: 3.5 })?.fences).toBe(1);
    // the fill reaches an unloaded block: unknown, not a pen
    const u = new PenWorldFake(3);
    u.pen(0, 0, 7, 7);
    expect(detectPen(u, { x: 2.5, y: 0, z: 2.5 })).toBeUndefined();
  });

  it('larger than 12 blocks from the mob on an axis: not a pen; PenDetector memoizes the whole interior', () => {
    const w = new PenWorldFake();
    w.pen(0, 0, 30, 5);
    expect(detectPen(w, { x: 2.5, y: 0, z: 2.5 })).toBeUndefined();
    const v = new PenWorldFake();
    v.pen(0, 0, 7, 7);
    let t = 0;
    const det = new PenDetector(v, { now: () => t });
    expect(det.penAt({ x: 2.5, y: 0, z: 2.5 })?.cells).toBe(25);
    expect(det.penAt({ x: 4.5, y: 0, z: 5.5 })?.cells).toBe(25);
    expect(det.fills).toBe(1);
    t = 20_000; // after the 10 s memory: a new fill
    det.penAt({ x: 4.5, y: 0, z: 5.5 });
    expect(det.fills).toBe(2);
  });

  it('the way out goes through the nearest gate, 3 blocks past it', () => {
    const w = new PenWorldFake();
    const g = w.pen(0, 0, 7, 7);
    const pen = detectPen(w, { x: 3.5, y: 0, z: 3.5 })!;
    expect(penExit(pen, { x: 3.5, y: 0, z: 5.5 }, [g])).toEqual({ x: g.x + 0.5, y: 0, z: g.z - 3 + 0.5 });
    // without gates: past the nearest side
    expect(penExit(pen, { x: 5.5, y: 0, z: 3.5 })).toEqual({ x: 9.5, y: 0, z: 3.5 });
    expect(inPenOrRim(pen, { x: 3.5, y: 0, z: 0.5 })).toBe(true); // in the gate
    expect(inPenOrRim(pen, { x: 3.5, y: 0, z: -1.5 })).toBe(false);
  });

  it('the hunt: wild mobs by the leave rule, penned ones only where allowed and never below 2 adults', () => {
    const w = new PenWorldFake();
    w.pen(0, 0, 7, 7);
    const det = new PenDetector(w);
    const penOf = (e: EntityInfo): Pen | undefined => det.penAt(e.pos);
    const penned = [ent(1, 'cow', 2.5, 2.5), ent(2, 'cow', 3.5, 2.5), ent(3, 'cow', 4.5, 4.5)];
    const wild = [ent(10, 'cow', 20.5, 0.5), ent(11, 'cow', 21.5, 0.5)];
    const q = { center: { x: 0, y: 0, z: 0 }, leave: 1, me: { x: 3.5, y: 0, z: -3 }, isBaby: () => false, penOf };
    // the pen cows are nearer, but only the wild ones count for the leave rule and are taken
    expect(pickTarget([...penned, ...wild], q)?.entity.runtimeId).toBe(10n);
    expect(pickTarget([...penned, ...wild.slice(0, 1)], q)).toBeUndefined(); // 1 wild cow: kept (leave 1)
    // allowed pen: down to 2 adults
    const allowed = { ...q, penAllowed: () => true };
    expect(pickTarget([...penned, ...wild.slice(0, 1)], allowed)?.pen).toBeDefined();
    expect(pickTarget([...penned.slice(0, 2), ...wild.slice(0, 1)], allowed)).toBeUndefined();
    // without penOf (v1 behaviour): every mob is wild
    expect(pickTarget([...penned, ...wild.slice(0, 1)], { ...q, penOf: undefined })?.entity.runtimeId).toBeDefined();
  });
});

describe('herd marks', () => {
  const mark = (cx: number, cz: number, at: number, cows = 3): HerdMark => ({ cx, cz, x: cx * 16 + 8, y: -60, z: cz * 16 + 8, wild: { cow: { adults: cows, babies: 0 } }, penned: {}, at });

  it('stores one mark per cell, nearest first, drops the oldest beyond max', () => {
    const s = new HerdMarks({ max: 3 });
    s.set(mark(0, 0, 1));
    s.set(mark(5, 0, 2));
    s.set(mark(1, 0, 3));
    s.set(mark(0, 0, 4, 5)); // same cell: replaced
    expect(s.size).toBe(3);
    expect(s.get(0, 0)?.wild.cow?.adults).toBe(5);
    expect(s.near({ x: 0, y: -60, z: 0 }, 200).map((m) => m.cx)).toEqual([0, 1, 5]);
    expect(s.near({ x: 0, y: -60, z: 0 }, 30).map((m) => m.cx)).toEqual([0, 1]);
    s.set(mark(9, 9, 5)); // over max: the oldest (cell 5,0 at 2) goes
    expect(s.get(5, 0)).toBeUndefined();
    expect(s.clear(9, 9)).toBe(true);
    expect(s.clear(9, 9)).toBe(false);
  });

  it('persists to herds.json beside the regions (per dimension) and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-herds-'));
    dirs.push(dir);
    let dim = 0;
    const a = new HerdMarks({ dir, dimension: () => dim });
    a.set(mark(2, 3, 10));
    dim = -1;
    a.set(mark(7, 7, 11));
    await a.flush();
    expect((JSON.parse(readFileSync(join(dir, 'herds.json'), 'utf8')) as { marks: unknown[] }).marks).toHaveLength(1);
    expect((JSON.parse(readFileSync(join(dir, 'dim-1', 'herds.json'), 'utf8')) as { marks: unknown[] }).marks).toHaveLength(1);
    dim = 0;
    const b = new HerdMarks({ dir, dimension: () => dim });
    expect(b.get(2, 3)?.wild.cow?.adults).toBe(3);
    expect(b.get(7, 7)).toBeUndefined();
    b.clear(2, 3);
    b.flushSync();
    expect(new HerdMarks({ dir }).size).toBe(0);
    // read-only stores never write
    const r = new HerdMarks({ dir, readOnly: true });
    r.set(mark(1, 1, 1));
    r.flushSync();
    expect(new HerdMarks({ dir }).size).toBe(0);
  });

  it('observes the tracker per 16-block cell (wild and penned), drops a mark the bot finds empty', () => {
    const w = new PenWorldFake(400);
    w.pen(0, 0, 7, 7);
    const det = new PenDetector(w);
    const entities = new Map<bigint, EntityInfo>();
    for (const e of [ent(1, 'cow', 2.5, 2.5), ent(2, 'cow', 3.5, 3.5), ent(3, 'pig', 100.5, 4), ent(4, 'pig', 101.5, 5), ent(5, 'zombie', 50, 50)]) entities.set(e.runtimeId, e);
    let me: Vec3 = { x: 0, y: 0, z: -10 };
    let now = 0;
    const babies = new Set([4n]);
    const h = new HerdMemory({ entities: () => entities, isBaby: (r) => babies.has(r), position: () => me, penOf: (e) => det.penAt(e.pos), clock: () => 1000, now: () => now });
    expect(h.observe()).toBe(2);
    expect(h.store.get(0, 0)).toMatchObject({ penned: { cow: { adults: 2, babies: 0 } }, wild: {}, at: 1000 });
    expect(h.store.get(6, 0)).toMatchObject({ wild: { pig: { adults: 1, babies: 1 } }, x: 101, z: 4.5 });
    // the pigs go out of sight, the bot walks there: kept while the tracker may lag, dropped after 2.5 s
    entities.delete(3n);
    entities.delete(4n);
    me = { x: 100, y: 0, z: 10 };
    h.observe();
    expect(h.store.get(6, 0)).toBeDefined();
    now = 3000;
    h.observe();
    expect(h.store.get(6, 0)).toBeUndefined();
    expect(h.stats.cleared).toBe(1);
  });

  it('next(): the nearest mark that offers something; stale marks near the bot are not followed', () => {
    const entities = new Map<bigint, EntityInfo>();
    const h = new HerdMemory({ entities: () => entities, isBaby: () => false, position: () => undefined });
    h.store.set({ ...mark(0, 0, 1, 2) }); // 2 cows: nothing with leave 2
    h.store.set({ ...mark(8, 0, 1, 4) }); // 128 blocks away, 4 cows
    h.store.set({ ...mark(0, 3, 1, 0), penned: { cow: { adults: 5, babies: 0 } } }); // a pen 56 blocks away
    const from = { x: 8, y: -60, z: 8 };
    expect(h.next(from, { leave: 2 })?.cx).toBe(8);
    expect(h.next(from, { leave: 2, penAllowed: () => true })?.cz).toBe(3);
    expect(h.next(from, { leave: 1 })?.cx).toBe(8); // the empty cell under the bot is stale: skipped
    entities.set(1n, ent(1, 'cow', 8, 8, -60));
    expect(h.next(from, { leave: 1 })?.cx).toBe(0);
    expect(h.next(from, { leave: 2, skip: new Set([cellKey(8, 0)]) })).toBeUndefined();
    expect(h.next(from, { leave: 2 }, 100)).toBeUndefined();
    expect(markOffers(mark(1, 1, 1, 5), { leave: 2, kinds: ['pig'] })).toEqual([]);
  });
});

// ---- breeding -----------------------------------------------------------------------------------------

function breedRig(opts: { wheat?: number; cows?: EntityInfo[]; refuse?: boolean } = {}) {
  const entities = new Map<bigint, EntityInfo>();
  for (const e of opts.cows ?? [ent(1, 'cow', 3, 0), ent(2, 'cow', 4, 1), ent(3, 'cow', 10, 0)]) entities.set(e.runtimeId, e);
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  slots[0] = item('iron_sword', 1);
  if (opts.wheat) slots[14] = item('wheat', opts.wheat);
  const inv = { slots, selected: 0 };
  const pos = { x: 0, y: 0, z: 0 };
  const sent: { name: string; params: Record<string, unknown> }[] = [];
  const love = new Set<bigint>();
  const babies = new Set<bigint>();
  const born: bigint[] = [];
  const log: string[] = [];
  const breeder = new Breeder({
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
        log.push(`select ${s}`);
        return true;
      },
      rawItem: (s) => (slots[s] ? { network_id: 7, count: slots[s].count, metadata: 0, has_stack_id: false, block_runtime_id: 0 } : undefined),
    },
    puller: {
      pull: () => {
        // main inventory -> hotbar slot 1, selected
        slots[1] = slots[14]!;
        slots[14] = null;
        inv.selected = 1;
        log.push('pull');
        return Promise.resolve({ ok: true });
      },
    },
    source: {
      queue: (name, params) => {
        sent.push({ name, params });
        if (name !== 'inventory_transaction' || opts.refuse) return;
        const td = (params.transaction as { transaction_data: { entity_runtime_id: bigint; hotbar_slot: number } }).transaction_data;
        const s = slots[td.hotbar_slot]!;
        slots[td.hotbar_slot] = s.count > 1 ? item(s.name, s.count - 1) : null;
        love.add(td.entity_runtime_id);
        if (love.size % 2 === 0) {
          const baby = ent(100 + love.size, 'cow', 3.5, 0.5);
          entities.set(baby.runtimeId, baby);
          babies.add(baby.runtimeId);
          born.push(baby.runtimeId);
        }
      },
    },
    isBaby: (r) => babies.has(r),
    isInLove: (r) => love.has(r),
    babiesSince: () => [...born],
  });
  return { breeder, entities, slots, inv, sent, love, log };
}

describe('breeding', () => {
  it('knows what each kind eats and counts the items carried', () => {
    expect(breedFoodOf('minecraft:cow')).toEqual(['wheat']);
    expect(breedFoodOf('pig')).toContain('carrot');
    expect(breedFoodOf('chicken')).toContain('wheat_seeds');
    expect(breedFoodOf('rabbit')).toContain('dandelion');
    expect(breedFoodOf('zombie')).toEqual([]);
    expect(breedItemCount([item('wheat', 3), item('minecraft:wheat', 2), item('carrot', 9)], 'sheep')).toBe(5);
  });

  it('the feed packet: item_use_on_entity, action interact, with the held item', () => {
    const p = feedTransaction({ target: 7n, hotbarSlot: 2, held: { network_id: 5, count: 3, metadata: 0, has_stack_id: false, block_runtime_id: 0 }, eye: { x: 1, y: 2, z: 3 }, click: { x: 0, y: 0.8, z: 0 } }) as {
      transaction: { transaction_type: string; transaction_data: Record<string, unknown> };
    };
    expect(p.transaction.transaction_type).toBe('item_use_on_entity');
    expect(p.transaction.transaction_data).toMatchObject({ entity_runtime_id: 7n, action_type: 'interact', hotbar_slot: 2, hand: 'main_hand', player_pos: { x: 1, y: 2, z: 3 }, click_pos: { x: 0, y: 0.8, z: 0 } });
    expect((p.transaction.transaction_data.held_item as { network_id: number }).network_id).toBe(5);
  });

  it('feeds the nearest pair with the food pulled into the hand, then counts the baby', async () => {
    const r = breedRig({ wheat: 4 });
    const res = await r.breeder.breed({ kind: 'cow', pairs: 1, center: { x: 0, y: 0, z: 0 }, radius: 16 }, () => false);
    expect(res).toMatchObject({ ok: true, reason: 'done', kind: 'cow', fed: 2, pairs: 1, babies: 1, refused: 0 });
    const tx = r.sent.filter((s) => s.name === 'inventory_transaction').map((s) => (s.params.transaction as { transaction_data: { entity_runtime_id: bigint } }).transaction_data.entity_runtime_id);
    expect(tx).toEqual([1n, 2n]);
    expect(r.sent.filter((s) => s.name === 'interact').every((s) => s.params.action_id === 'mouse_over_entity')).toBe(true);
    expect(r.log).toContain('pull');
    expect(r.slots[1]).toMatchObject({ name: 'wheat', count: 2 });
    // the parents are spared for 5 minutes, and not fed again
    expect(r.breeder.fedRecently(1n)).toBe(true);
    expect(r.breeder.candidates({ kind: 'cow', center: { x: 0, y: 0, z: 0 }, radius: 16 }).get('cow')?.map((e) => e.runtimeId)).toEqual([3n]);
  });

  it('no food, no pair, refused', async () => {
    expect((await breedRig({ wheat: 1 }).breeder.breed({ kind: 'cow', pairs: 1, center: { x: 0, y: 0, z: 0 }, radius: 16 }, () => false)).reason).toBe('no_food');
    expect((await breedRig({ wheat: 4, cows: [ent(1, 'cow', 3, 0)] }).breeder.breed({ kind: 'cow', pairs: 1, center: { x: 0, y: 0, z: 0 }, radius: 16 }, () => false)).reason).toBe('no_pair');
    expect((await breedRig({ wheat: 4 }).breeder.breed({ pairs: 1, center: { x: 0, y: 0, z: 0 }, radius: 16 }, () => false)).kind).toBe('cow');
    const ref = await breedRig({ wheat: 4, refuse: true }).breeder.breed({ kind: 'cow', pairs: 1, center: { x: 0, y: 0, z: 0 }, radius: 16 }, () => false);
    expect(ref).toMatchObject({ ok: false, reason: 'refused', fed: 0 });
    // babies and mobs in love are not breedable
    const list = breedable([ent(1, 'cow', 0, 0), ent(2, 'cow', 1, 0), ent(3, 'cow', 2, 0), ent(4, 'zombie', 0, 0)], { center: { x: 0, y: 0, z: 0 }, radius: 8, isBaby: (r) => r === 1n, isInLove: (r) => r === 2n });
    expect(list.get('cow')?.map((e) => e.runtimeId)).toEqual([3n]);
  });

  it('a pair is two animals in the same pen (or both outside any): never split by a fence', () => {
    const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
    // nearest first: 1 in pen A, 2 just over the fence in pen B, 3 in pen A further away, 4 and 5 wild
    const list = [ent(1, 'cow', 1, 0), ent(2, 'cow', 2, 0), ent(3, 'cow', 6, 0), ent(4, 'cow', 20, 0), ent(5, 'cow', 21, 0)];
    const pen = (e: EntityInfo) => ({ 1: 'A', 2: 'B', 3: 'A' } as Record<string, string>)[String(e.runtimeId)];
    expect(samePenPair(list, pen, dist)?.map((e) => e.runtimeId)).toEqual([1n, 3n]);
    // 2 is alone in its pen: the next pair is the two wild ones
    expect(samePenPair([list[1]!, list[3]!, list[4]!], pen, dist)?.map((e) => e.runtimeId)).toEqual([4n, 5n]);
    expect(samePenPair([list[0]!, list[1]!], pen, dist)).toBeUndefined();
  });

  it('the pen at a given point: the feet block, the ground block under it (what the debug screen shows), or one above', () => {
    const found: Pen = { id: 'p', y: -60, min: { x: 0, z: 0 }, max: { x: 4, z: 4 }, cells: 25, fences: 20 };
    const penAt = (f: Vec3) => (f.y === -60 ? found : undefined);
    expect(penNear(penAt, { x: 2, y: -60, z: 2 })).toBe(found);
    expect(penNear(penAt, { x: 2, y: -61, z: 2 })).toBe(found); // the ground block
    expect(penNear(penAt, { x: 2, y: -59, z: 2 })).toBe(found);
    expect(penNear(penAt, { x: 2, y: -63, z: 2 })).toBeUndefined();
  });

  it('replies', () => {
    expect(breedReply({ ok: true, reason: 'done', kind: 'cow', fed: 2, pairs: 1, babies: 1, refused: 0, ms: 3000 }, 1)).toBe('breed: fed 1/1 cow pair, 1 baby so far');
    expect(breedReply({ ok: false, reason: 'no_food', kind: 'pig', fed: 0, pairs: 0, babies: 0, refused: 0, ms: 0 }, 2)).toBe('breed: no food for the pigs (carrot / potato / beetroot)');
    expect(breedReply({ ok: false, reason: 'no_pair', kind: undefined, fed: 0, pairs: 0, babies: 0, refused: 0, ms: 0 }, 2)).toMatch(/^breed: no two adults of a kind ready within 16 blocks/);
  });
});

// ---- the food job's walks to remembered herds, the breeding chore ---------------------------------------

function jobRig(opts: { herdAt?: Vec3; cows?: number; autoBreed?: boolean; chorePen?: string; wheat?: number; penned?: number } = {}) {
  const settings = new RuntimeSettings();
  settings.set('foodLeave', 2); // the herd tests check the keep rule (the default is 0)
  settings.set('autoFood', false); // the food chore would hunt the chorePen pen first
  if (opts.autoBreed) settings.set('autoBreed', true);
  if (opts.chorePen) settings.set('chorePen', opts.chorePen);
  const pm = new ProcessManager();
  let now = 0;
  const pos = { x: 0, y: -60, z: 0 };
  const entities = new Map<bigint, EntityInfo>();
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  if (opts.wheat) slots[3] = item('wheat', opts.wheat);
  const walks: Vec3[] = [];
  let pending = 0;
  const hunter = new Hunter({
    entities: () => entities,
    position: () => pos,
    isBaby: () => false,
    inventory: { slots },
    mover: {
      goto: (g) => {
        if (g.type === 'near') {
          walks.push({ ...g.p });
          pos.x = g.p.x;
          pos.z = g.p.z;
          // arriving at the remembered herd: the tracker shows the cows
          if (opts.herdAt && Math.hypot(g.p.x - opts.herdAt.x, g.p.z - opts.herdAt.z) < 1) {
            for (let i = 0; i < (opts.cows ?? 4); i++) entities.set(BigInt(50 + i), ent(50 + i, 'cow', opts.herdAt.x + i, opts.herdAt.z, -60));
          }
        }
        return Promise.resolve({ ok: true });
      },
      collect: () => {
        slots[0] = item('beef', (slots[0]?.count ?? 0) + pending);
        pending = 0;
        return Promise.resolve({ ok: true });
      },
    },
    combat: {
      fight: (rid) => {
        entities.delete(rid);
        pending = 2;
        return Promise.resolve({ ok: true, reason: 'killed', runtimeId: rid, type: 'minecraft:cow', ticks: 20, attacks: 2, landed: 2, damageTaken: 0, weapon: 'iron_sword' } as FightResult);
      },
    },
  });
  const herds = new HerdMemory({ entities: () => entities, isBaby: () => false, position: () => pos });
  const fakeCooker = { canCook: () => false, cook: () => Promise.resolve({ ok: false, reason: 'no_furnace', cooked: {}, fuel: {}, ticks: 0 }), phase: 'idle' } as unknown as Cooker;
  const breeder = new Breeder({
    entities: () => entities,
    mover: { goto: () => Promise.resolve({ ok: true }) },
    loop: { state: { pos }, setCommand: () => undefined, waitTicks: () => Promise.resolve() },
    inventory: { slots, selected: 0 },
    hotbar: { select: () => true, rawItem: () => undefined },
    source: { queue: () => undefined },
    isBaby: () => false,
  });
  const deps: FoodDeps = {
    processes: pm,
    settings,
    hunter,
    cooker: fakeCooker,
    position: () => pos,
    inventory: { slots },
    isDay: () => true,
    cancel: () => undefined,
    now: () => now,
    herds,
    waitTicks: () => Promise.resolve(),
    breeder,
    entities: () => entities,
  };
  return { pm, deps, herds, entities, walks, pos, settings, advance: (ms: number) => (now += ms) };
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('food job: remembered herds', () => {
  it('nothing within 48 blocks: walks to the nearest remembered herd and hunts there', async () => {
    const herdAt = { x: 120.5, y: -60, z: 0.5 };
    const r = jobRig({ herdAt, cows: 4 });
    r.herds.store.set({ cx: 7, cz: 0, x: herdAt.x, y: -60, z: herdAt.z, wild: { cow: { adults: 4, babies: 0 } }, penned: {}, at: 1 });
    const job = new FoodJob(4, { hunt: true, cook: false });
    expect(await job.run(r.deps, () => false)).toBe(true);
    const res = job.result();
    expect(res).toMatchObject({ ok: true, gained: 4, killed: 2 });
    expect(res.trips).toHaveLength(1);
    expect(res.trips![0]).toMatch(/^121 1: 121 blocks, reached/);
    expect(r.walks[0]).toEqual({ x: herdAt.x, y: -60, z: herdAt.z });
    expect(r.entities.size).toBe(2); // foodLeave 2
    expect(foodReply(res, 4, 2)).toBe('food: 4/4 items from 2 cow (1 walk to remembered herds)');
  });

  it('no mark worth the walk (beyond 200 blocks, or at most foodLeave adults): no trip', async () => {
    const r = jobRig();
    r.herds.store.set({ cx: 20, cz: 0, x: 320, y: -60, z: 0, wild: { cow: { adults: 9, babies: 0 } }, penned: {}, at: 1 });
    r.herds.store.set({ cx: 3, cz: 0, x: 50, y: -60, z: 0, wild: { cow: { adults: 2, babies: 0 } }, penned: {}, at: 1 });
    const job = new FoodJob(4, { hunt: true, cook: false });
    await job.run(r.deps, () => false);
    expect(job.result()).toMatchObject({ reason: 'none_left', gained: 0, trips: [] });
    expect(r.walks).toHaveLength(0);
  });

  it('a pause during the walk: the resume walks on to the same mark', async () => {
    const herdAt = { x: 100.5, y: -60, z: 0.5 };
    const r = jobRig({ herdAt, cows: 3 });
    r.herds.store.set({ cx: 6, cz: 0, x: herdAt.x, y: -60, z: herdAt.z, wild: { cow: { adults: 3, babies: 0 } }, penned: {}, at: 1 });
    const job = new FoodJob(2, { hunt: true, cook: false });
    let stop = true;
    expect(await job.run(r.deps, () => stop && r.walks.length > 0)).toBe(false);
    expect(job.trip?.cx).toBe(6);
    stop = false;
    expect(await job.run(r.deps, () => false)).toBe(true);
    expect(job.result()).toMatchObject({ gained: 2, killed: 1 });
    expect(job.result().trips).toHaveLength(1);
  });
});

describe('breeding chore', () => {
  it('never looks while autoBreed is off; with it on and a chorePen it starts, then waits 10 minutes', async () => {
    const off = jobRig({ chorePen: '120 -60 0', wheat: 8 });
    const offCtl = new FoodController(off.deps);
    for (let i = 0; i < 5; i++) {
      off.advance(2000);
      off.pm.tick();
    }
    expect(offCtl.breedChore!.stats.checks).toBe(0);
    expect(off.pm.active).toBeUndefined();

    const r = jobRig({ autoBreed: true, chorePen: '120 -60 0', wheat: 8 });
    // the pen is out of view: its herd mark tells what is there
    r.herds.store.set({ cx: 7, cz: 0, x: 121, y: -60, z: 1, wild: {}, penned: { cow: { adults: 4, babies: 0 } }, at: 1 });
    const ctl = new FoodController(r.deps);
    r.advance(2000);
    r.pm.tick();
    expect(ctl.breedChore!.stats.started).toBe(1);
    expect(r.pm.active?.name).toBe('breed');
    expect(r.pm.active?.kind).toBe('auto');
    expect(r.pm.active?.priority).toBe(30);
    await flush();
    r.pm.tick();
    // walked to the pen; no fenced pen found there in this fake: nothing fed (it used to breed whatever stood
    // near the point, wild animals included), done, next look in 10 minutes
    expect(r.walks[0]).toMatchObject({ x: 120, z: 0 });
    expect(ctl.breedChore!.running).toBe(false);
    expect(ctl.breedChore!.lastWhy).toBe(noPenLine('120 -60 0'));
    expect(ctl.breedChore!.last).toMatchObject({ fed: 0, reason: 'no_pair' });
    expect(ctl.breedChore!.nextTry).toBe(2000 + BREED_PERIOD_MS);
  });

  it('skips: no chorePen, a full pen, no food, too far', () => {
    const none = jobRig({ autoBreed: true, wheat: 8 });
    const c0 = new FoodController(none.deps);
    none.advance(2000);
    none.pm.tick();
    expect(c0.breedChore!.stats.checks).toBe(0);
    const full = jobRig({ autoBreed: true, chorePen: '120 -60 0', wheat: 8 });
    full.herds.store.set({ cx: 7, cz: 0, x: 121, y: -60, z: 1, wild: {}, penned: { cow: { adults: 8, babies: 0 } }, at: 1 });
    const c1 = new FoodController(full.deps);
    full.advance(2000);
    full.pm.tick();
    expect(c1.breedChore!.lastWhy).toBe('cow 8 adults (8 wanted)');
    const nofood = jobRig({ autoBreed: true, chorePen: '120 -60 0' });
    nofood.herds.store.set({ cx: 7, cz: 0, x: 121, y: -60, z: 1, wild: {}, penned: { cow: { adults: 3, babies: 0 } }, at: 1 });
    const c2 = new FoodController(nofood.deps);
    nofood.advance(2000);
    nofood.pm.tick();
    expect(c2.breedChore!.lastWhy).toBe('no wheat for the cows');
    const far = jobRig({ autoBreed: true, chorePen: '500 -60 0', wheat: 8 });
    const c3 = new FoodController(far.deps);
    far.advance(2000);
    far.pm.tick();
    expect(c3.breedChore!.lastWhy).toBe('the pen is 500 blocks away (more than 200)');
  });
});
