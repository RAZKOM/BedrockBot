// Track K5 (ADR 0110, docs/survival.md "Mending (Track K5)"): the one enchantment reader over every kind the bot uses,
// the piece rules (skills/survival/mend.ts), the hand (tasks/mend-hand.ts), the source choice and the job
// (tasks/process/mend.ts), the cooker's hold hook, on fakes.
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { boxElytra } from '../../../src/skills/supply/elytra.ts';
import { gearPieces, mendQueue, mendStatusLine, pointsToMend, turnPiece, USES_PER_XP, type GearInventory, type MendPiece } from '../../../src/skills/survival/mend.ts';
import { ENCH_MENDING, ENCH_UNBREAKING, enchantLevel, hasMending, makeToolOk, maxDurability } from '../../../src/skills/survival/tools.ts';
import { HOLD_MAX_TICKS, hotbarFor, MendHand, orbsNear, SETTLE_TICKS, type MendHandDeps } from '../../../src/tasks/mend-hand.ts';
import { chooseMendSource, gainLine, MendJob, parseMendArgs, stepCommand, stepKey, type MendJobDeps, type MendSourceState } from '../../../src/tasks/process/mend.ts';
import { itemEnchants, tagEnchants } from '../../../src/world/inventory.ts';
import { mendHint } from '../../../src/tasks/process/elytra.ts';
import { planKit } from '../../../src/skills/test/kit.ts';
import type { EntityInfo, ItemStack } from '../../../src/world/types.ts';

/** The wire item as BDS 1.26.60.6 sends it after `/enchant <bot> mending 1` and `unbreaking 3` (seen in the probe). */
const wire = (damage: number, ench: { id: number; lvl: number }[]) => ({
  extra: { nbt: { nbt: { value: { Damage: { type: 'int', value: damage }, ench: { type: 'list', value: { type: 'compound', value: ench.map((e) => ({ id: { type: 'short', value: e.id }, lvl: { type: 'short', value: e.lvl } })) } } } } } },
});
/** Every kind the reader was checked on with `/enchant` on the server (test/e2e/mend.test.ts MEND_RULES=reader). */
const KINDS = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'diamond_sword', 'diamond_axe', 'diamond_pickaxe', 'diamond_shovel', 'diamond_hoe', 'shield', 'trident', 'bow', 'fishing_rod', 'shears', 'flint_and_steel', 'elytra', 'crossbow', 'mace'];

const item = (name: string, left: number, mending = false): ItemStack => ({ name, count: 1, damage: maxDurability(name)! - left, ...(mending ? { enchants: [{ id: ENCH_MENDING, lvl: 1 }] } : {}) }) as ItemStack;
const invOf = (slots: (ItemStack | null)[], selected = 0, armour: (ItemStack | null)[] = [null, null, null, null], offhand: ItemStack | null = null): GearInventory & { slots: (ItemStack | null)[]; selected: number } => {
  const s: (ItemStack | null)[] = Array.from({ length: 36 }, (_, i) => slots[i] ?? null);
  return {
    slots: s,
    selected,
    window: (id) => (id === 120 ? { slots: armour } : id === 119 ? { slots: [offhand] } : undefined),
  };
};

describe('the one enchantment reader (world/inventory.ts tagEnchants, tools.ts hasMending)', () => {
  it.each(KINDS)('%s: Mending and Unbreaking read from the wire item', (k) => {
    const e = itemEnchants(wire(5, [{ id: ENCH_UNBREAKING, lvl: 3 }, { id: ENCH_MENDING, lvl: 1 }]));
    expect(e).toEqual([{ id: 17, lvl: 3 }, { id: 26, lvl: 1 }]);
    const it: ItemStack = { name: k, count: 1, damage: 5, enchants: e! } as ItemStack;
    expect(hasMending(it)).toBe(true);
    expect(enchantLevel(it, ENCH_UNBREAKING)).toBe(3);
    expect(maxDurability(k)).toBeGreaterThan(0);
  });
  it('the armour pieces the server sent with Mending only', () => {
    expect(itemEnchants(wire(5, [{ id: 26, lvl: 1 }]))).toEqual([{ id: 26, lvl: 1 }]);
  });
  it('nothing without an ench list; a box item by the same reader', () => {
    expect(itemEnchants({ extra: { nbt: { nbt: { value: { Damage: { value: 3 } } } } } })).toBeUndefined();
    expect(itemEnchants(undefined)).toBeUndefined();
    expect(tagEnchants({ ench: { value: { value: [{ id: { value: 26 }, lvl: { value: 1 } }] } } })).toEqual([{ id: 26, lvl: 1 }]);
    const box = { extra: { nbt: { nbt: { value: { Items: { value: { value: [{ Name: { value: 'minecraft:elytra' }, Count: { value: 1 }, Slot: { value: 2 }, tag: { value: { Damage: { value: 100 }, ench: { value: { value: [{ id: { value: 26 }, lvl: { value: 1 } }] } } } } }] } } } } } } };
    expect(boxElytra(box)).toEqual([{ inBox: 2, left: 332, mending: true }]);
  });
  it('a Mending piece stays worth keeping: the worn-tool rule sets it aside at mendAt, before the hard limit', () => {
    const ok = makeToolOk(() => 10, () => 10);
    expect(ok(item('diamond_pickaxe', 150, true))).toBe(false); // reserve 157
    expect(ok(item('diamond_pickaxe', 150))).toBe(true);
    expect(ok(item('diamond_pickaxe', 9))).toBe(false);
  });
});

describe('the pieces (gearPieces, turnPiece, mendQueue, lines)', () => {
  const inv = invOf([item('diamond_sword', 1561, true), item('elytra', 131, true), item('diamond_pickaxe', 1200, true), item('trident', 1), item('diamond_axe', 1500), { name: 'cobblestone', count: 64 } as ItemStack], 0, [null, item('diamond_chestplate', 500, true), null, null]);
  const ps = gearPieces(inv, 10, 10);
  it('where each one is, its uses, Mending', () => {
    expect(ps.map((p) => `${p.name} ${p.where} ${p.slot} ${p.left}/${p.max}${p.mending ? ' M' : ''}${p.aside ? ' aside' : ''}${p.wornOut ? ' out' : ''}`)).toEqual([
      'diamond_chestplate worn 1 500/528 M',
      'diamond_sword held 0 1561/1561 M',
      'elytra carried 1 131/432 M',
      'diamond_pickaxe carried 2 1200/1561 M',
      'trident carried 3 1/250 out',
      'diamond_axe carried 4 1500/1561',
    ]);
  });
  it('the turn: a carried damaged Mending piece, the smallest share left first; never worn or full ones', () => {
    expect(turnPiece(ps)?.name).toBe('elytra');
    expect(turnPiece(ps.filter((p) => p.name !== 'elytra'))?.name).toBe('diamond_pickaxe');
    expect(turnPiece(ps.filter((p) => p.where !== 'carried'))).toBeUndefined();
  });
  it('a piece set aside goes first even with a larger share left', () => {
    const ps2 = gearPieces(invOf([null, item('elytra', 100, true), item('diamond_pickaxe', 150, true)]), 10, 10);
    expect(ps2.find((p) => p.name === 'diamond_pickaxe')?.aside).toBe(true);
    expect(turnPiece(ps2)?.name).toBe('diamond_pickaxe');
  });
  it('`!mend <piece>`: that kind only, held too; never a worn one (it mends where it is)', () => {
    expect(turnPiece(ps, 'diamond_pickaxe')?.slot).toBe(2);
    expect(turnPiece(ps, 'diamond_chestplate')).toBeUndefined();
    const held = gearPieces(invOf([item('elytra', 50, true)], 0), 10, 10);
    expect(turnPiece(held)).toBeUndefined();
    expect(turnPiece(held, 'elytra')?.where).toBe('held');
  });
  it('the queue, worst first, and the points', () => {
    expect(mendQueue(ps).map((p) => p.name)).toEqual(['elytra', 'diamond_pickaxe', 'diamond_chestplate']);
    expect(mendQueue(ps, 'elytra').map((p) => p.name)).toEqual(['elytra']);
    expect(pointsToMend({ left: 131, max: 432 })).toBe(Math.ceil(301 / USES_PER_XP));
  });
  it('the status line names Mending and wear, and a worn-out piece without Mending', () => {
    expect(mendStatusLine(ps)).toBe('mend: Mending on elytra 131/432, diamond_pickaxe 1200/1561, diamond_chestplate 500/528 (worn), diamond_sword full; no Mending: trident (1/250, worn out: cannot be mended), diamond_axe');
    expect(mendStatusLine([])).toBe('mend: nothing with durability carried, worn or held');
    expect(mendStatusLine(gearPieces(invOf([item('trident', 1)]), 10, 10))).toBe('mend: no Mending on anything; worn out: trident (1/250, worn out: cannot be mended)');
  });
});

describe('the hand (tasks/mend-hand.ts)', () => {
  const orb = (x: number): EntityInfo => ({ runtimeId: BigInt(x + 100), type: 'minecraft:xp_orb', pos: { x, y: 0, z: 0 } }) as EntityInfo;
  it('orbs near and the hotbar slot a carried piece is swapped into', () => {
    expect(orbsNear(new Map([[1n, orb(2)], [2n, orb(20)]]), { x: 0, y: 0, z: 0 })).toBe(1);
    const slots = [item('diamond_sword', 100), { name: 'firework_rocket', count: 10 }, { name: 'cobblestone', count: 64 }, null, null, null, null, null, item('diamond_pickaxe', 100)] as ({ name: string; count: number } | null)[];
    expect(hotbarFor(slots, 0)).toBe(2);
    expect(hotbarFor(slots, 2)).toBeUndefined();
  });

  /** A hand over a fake inventory: orbs come when the act runs, the elytra is mended by them while held. */
  type Threat = { why: string; pending?: boolean } | undefined;
  const rig = (o: { slots: (ItemStack | null)[]; selected?: number; threat?: () => Threat; near?: () => string | undefined; on?: boolean; move?: boolean; far?: boolean; noPick?: boolean; walkBlocked?: MendHandDeps['walkBlocked'] }) => {
    const inv = invOf(o.slots, o.selected ?? 0);
    const ents = new Map<bigint, EntityInfo>();
    const log: string[] = [];
    const swaps: [number, number][] = [];
    const moves: [number, number][] = [];
    const selects: number[] = [];
    let ticks = 0;
    const walks: number[] = [];
    const d: MendHandDeps = {
      inventory: inv,
      select: (s) => {
        selects.push(s);
        inv.selected = s;
      },
      swap: (a, b) => {
        swaps.push([a, b]);
        const t = inv.slots[a] ?? null;
        inv.slots[a] = inv.slots[b] ?? null;
        inv.slots[b] = t;
        return Promise.resolve({ ok: true });
      },
      ...(o.move
        ? {
            move: (a: number, b: number) => {
              moves.push([a, b]);
              inv.slots[b] = inv.slots[a] ?? null;
              inv.slots[a] = null;
              return Promise.resolve({ ok: true });
            },
          }
        : {}),
      ...(o.far
        ? {
            walkTo: (p: { x: number }) => {
              walks.push(p.x);
              return Promise.resolve(true);
            },
          }
        : {}),
      entities: () => ents,
      position: () => ({ x: 0, y: 0, z: 0 }),
      threat: o.threat ?? (() => undefined),
      ...(o.near ? { near: o.near } : {}),
      ...(o.walkBlocked ? { walkBlocked: o.walkBlocked } : {}),
      handFree: () => true,
      settings: () => ({ on: o.on ?? true, toolWearLimit: 10, mendAt: 10 }),
      waitTicks: (n) => {
        ticks += n;
        // the orbs are picked up 3 ticks after they appear; each mends the held piece by 2
        if (!o.noPick && ents.size && ticks % 3 === 0 && (!o.far || walks.length > 0)) {
          ents.clear();
          const h = inv.slots[inv.selected];
          if (h && hasMending(h)) inv.slots[inv.selected] = { ...h, damage: Math.max(0, (h.damage ?? 0) - 6) };
        }
        return Promise.resolve();
      },
      log: { info: (m: string) => log.push(m), warn: (m: string) => log.push(m), error: (m: string) => log.push(m), debug: () => undefined },
    };
    const hand = new MendHand(d);
    return { hand, inv, ents, log, swaps, moves, selects, walks, orbs: (n: number, x = 1) => { for (let i = 0; i < n; i++) ents.set(BigInt(i), orb(x)); }, ticks: () => ticks };
  };

  it('a carried elytra in the main inventory: swapped into the hotbar, held for the take, the slot held before back, the swap undone', async () => {
    const r = rig({ slots: [item('diamond_sword', 1561), null, { name: 'cobblestone', count: 64 } as ItemStack, null, null, null, null, null, null, null, item('elytra', 100, true)] });
    const prep = await r.hand.prepare();
    expect(prep).toMatchObject({ hot: 2, swapped: { a: 2, b: 10 } });
    expect(r.inv.slots[2]?.name).toBe('elytra');
    const res = await r.hand.hold(prep!, 'furnace', () => {
      r.orbs(3);
      return Promise.resolve(7);
    });
    expect(res.value).toBe(7);
    expect(res.hold).toEqual({ piece: 'elytra', before: 100, after: 106 });
    expect(r.inv.selected).toBe(0); // the sword back in the hand
    expect(r.selects).toEqual([2, 0]);
    await r.hand.unprepare(prep);
    expect(r.inv.slots[10]?.name).toBe('elytra');
    expect(r.inv.slots[2]?.name).toBe('cobblestone');
    expect(r.hand.stats.uses).toEqual({ furnace: 6 });
    expect(r.log.some((l) => /held the elytra for furnace \d+ ticks \(orbs near: 3; ended: [^)]+\): 100 -> 106\/432/.test(l))).toBe(true);
  });

  it('an empty hotbar slot first (a move, back by a move); a swap whose stack the furnace took comes back by a move', async () => {
    const r = rig({ move: true, slots: [item('diamond_sword', 1561), null, { name: 'raw_iron', count: 8 } as ItemStack, null, null, null, null, null, null, null, item('elytra', 100, true)] });
    const prep = await r.hand.prepare();
    expect(prep).toMatchObject({ hot: 1, swapped: { a: 1, b: 10, move: true } });
    await r.hand.unprepare(prep);
    expect(r.moves).toEqual([[10, 1], [1, 10]]);
    expect(r.inv.slots[10]?.name).toBe('elytra');
    const full = [item('diamond_sword', 1561), ...Array.from({ length: 7 }, () => item('diamond_axe', 1561)), { name: 'raw_iron', count: 8 } as ItemStack];
    const s = rig({ move: true, slots: [...full, null, item('elytra', 100, true)] });
    const p2 = await s.hand.prepare();
    expect(p2).toMatchObject({ hot: 8, swapped: { a: 8, b: 10 } });
    expect(s.inv.slots[10]?.name).toBe('raw_iron');
    s.inv.slots[10] = null; // the cooker put the raw iron into the furnace
    await s.hand.unprepare(p2);
    expect(s.moves).toEqual([[8, 10]]);
    expect((s.inv.slots as (ItemStack | null)[])[10]?.name).toBe('elytra');
  });

  it('a !mend job stages its piece once: the holds only select it; the end puts it back', async () => {
    const r = rig({ move: true, slots: [item('diamond_sword', 1561), null, null, null, null, null, null, null, null, null, item('elytra', 100, true)] });
    r.hand.job = true;
    await r.hand.stage();
    expect(r.moves).toEqual([[10, 1]]);
    const p = await r.hand.prepare();
    expect(p).toEqual(expect.objectContaining({ hot: 1 }));
    expect(p?.swapped).toBeUndefined();
    await r.hand.unprepare(p);
    expect(r.moves).toEqual([[10, 1]]);
    await r.hand.unstage();
    expect(r.moves).toEqual([[10, 1], [1, 10]]);
  });
  it('no hold: the setting off (unless a !mend job), a hostile near, no slot to swap into, nothing carried to mend', async () => {
    const slots = [item('diamond_sword', 1561), { name: 'cobblestone', count: 64 } as ItemStack, item('elytra', 100, true)];
    expect(await rig({ slots, on: false }).hand.prepare()).toBeUndefined();
    const job = rig({ slots, on: false });
    job.hand.job = true;
    expect((await job.hand.prepare())?.hot).toBe(2);
    const z = rig({ slots, threat: () => ({ why: 'a zombie 5 blocks off with a clear way to me (6 path blocks)' }) });
    expect(await z.hand.prepare()).toBeUndefined();
    // the refusal is logged and kept for `!mend`'s end line (it was silent)
    expect(z.log).toContain('mend: not held: a zombie 5 blocks off with a clear way to me (6 path blocks)');
    expect(z.hand.refusal).toBe('not held: a zombie 5 blocks off with a clear way to me (6 path blocks)');
    const full = Array.from({ length: 9 }, () => item('diamond_sword', 1561));
    const f = rig({ slots: [...full, item('elytra', 100, true)] });
    expect(await f.hand.prepare()).toBeUndefined();
    expect(f.hand.refusal).toBe('not held: no hotbar slot free of tools, weapons and rockets to bring the elytra into');
    expect(await rig({ slots: [item('diamond_sword', 1561), item('elytra', 432, true)] }).hand.prepare()).toBeUndefined();
  });

  it('a hostile mid-hold ends it at once; the take still runs when the piece moved', async () => {
    let t = false;
    const r = rig({ slots: [item('diamond_sword', 1561), item('elytra', 100, true)], threat: () => (t ? { why: 'a zombie 9 blocks off with a clear way to me (10 path blocks)' } : undefined) });
    const prep = (await r.hand.prepare())!;
    const res = await r.hand.hold(prep, 'orbs', () => {
      t = true;
      return Promise.resolve(1);
    });
    expect(r.ticks()).toBeLessThan(5);
    expect(r.inv.selected).toBe(0);
    expect(res.value).toBe(1);
    expect(r.log.some((l) => l.includes('ended: a hostile (a zombie 9 blocks off with a clear way to me (10 path blocks))'))).toBe(true);
    expect(r.hand.refusal).toBe('hold ended: a zombie 9 blocks off with a clear way to me (10 path blocks)');
    r.inv.slots[1] = null;
    expect((await r.hand.hold(prep, 'furnace', () => Promise.resolve(2))).value).toBe(2);
  });

  it("the watcher and the ore hold walk once to orbs that lie where they fell; the furnace take never walks, the job's end does", async () => {
    const r = rig({ far: true, slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    r.orbs(3, 5);
    const res = await r.hand.catchOrbs('orbs');
    expect(r.walks).toEqual([5]);
    expect(res.after).toBeGreaterThan(res.before!);
    expect(r.hand.stats.walks).toBe(1);
    const f = rig({ far: true, slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    const prep = (await f.hand.prepare())!;
    await f.hand.hold(prep, 'furnace', () => {
      f.orbs(2, 5);
      return Promise.resolve(0);
    });
    expect(f.walks).toEqual([]);
    // the furnace job's end (the window closed): the orbs still lying there are walked to, then the piece goes back
    await f.hand.finish(prep);
    expect(f.walks).toEqual([5]);
    expect(f.inv.slots[1]?.damage).toBeLessThan(332);
    expect(f.inv.selected).toBe(0);
    // nothing near: finish only puts the piece back
    const g = rig({ slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    const pg = (await g.hand.prepare())!;
    await g.hand.finish(pg);
    expect(g.hand.stats.holds).toBe(0);
    // the ore hold
    const o = rig({ far: true, slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    o.hand.job = true;
    o.orbs(2, 5);
    await o.hand.afterOre();
    expect(o.walks).toEqual([5]);
  });
  it('a path probe still running: waited for (up to SETTLE_TICKS); a take with a threat runs without the hold', async () => {
    let n = 0;
    const r = rig({ slots: [item('diamond_sword', 1561), item('elytra', 100, true)], threat: () => (n++ < 3 ? { why: 'a zombie 4 blocks off, its way to me not known yet', pending: true } : undefined) });
    const prep = await r.hand.prepare();
    expect(prep?.hot).toBe(1);
    expect(r.ticks()).toBe(6);
    const s = rig({ slots: [item('diamond_sword', 1561), item('elytra', 100, true)], threat: () => ({ why: 'a zombie 4 blocks off, its way to me not known yet', pending: true }) });
    expect(await s.hand.prepare()).toBeUndefined();
    expect(s.ticks()).toBe(SETTLE_TICKS);
    let hostile = false;
    const h = rig({ slots: [item('diamond_sword', 1561), item('elytra', 100, true)], threat: () => (hostile ? { why: 'a skeleton 12 blocks off with a line on me' } : undefined) });
    const p2 = (await h.hand.prepare())!;
    hostile = true;
    const res = await h.hand.hold(p2, 'furnace', () => Promise.resolve(5));
    expect(res.value).toBe(5);
    expect(h.selects).toEqual([]); // never selected
    expect(h.log).toContain('mend: not held for furnace: a skeleton 12 blocks off with a line on me');
  });

  it('the watcher stays awake after a hold a hostile ended (the kill comes next), not after one whose orbs never came', async () => {
    const settle = () => new Promise((res) => setTimeout(res, 20));
    // orbs lying 5 off that never come (no walk in this rig): the hold runs out, mends nothing, the watcher is quiet
    const q = rig({ noPick: true, slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    q.orbs(2, 5);
    q.hand.tick();
    await settle();
    expect(q.hand.stats.holds).toBe(1);
    q.hand.tick();
    expect(q.hand.busy).toBe(false);
    // a zombie comes in mid-hold (from the 5th look on): the hold ends, and the next tick tries again once it is gone
    let calls = 0;
    let gone = false;
    const r = rig({ noPick: true, slots: [item('diamond_sword', 1561), item('elytra', 100, true)], threat: () => (!gone && ++calls >= 5 ? { why: 'a zombie 10 blocks off with a clear way to me (11 path blocks)' } : undefined) });
    r.orbs(2, 5);
    r.hand.tick();
    await settle();
    expect(r.log.some((l) => l.includes('ended: a hostile'))).toBe(true);
    gone = true;
    r.hand.tick();
    expect(r.hand.busy).toBe(true);
  });

  it('the walk to orbs keeps the strict rule: a hostile within 16 (whatever its way) and no walk, said in the log', async () => {
    const r = rig({ far: true, near: () => 'a drowned 9 blocks off (within 16)', slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    r.orbs(3, 5);
    await r.hand.catchOrbs('orbs');
    expect(r.walks).toEqual([]);
    expect(r.log.some((l) => /^mend: no walk to the orbs 5\.0 blocks off: a drowned 9 blocks off \(within 16\)$/.test(l))).toBe(true);
  });

  it('Track K6: the ore preselect: the staged piece in the hand at the break, the ore hold keeps it and gives the pickaxe slot back; a hostile gives it back at once', async () => {
    const slots = [item('diamond_pickaxe', 1561), null, null, null, null, null, null, null, null, null, item('elytra', 100, true)];
    const r = rig({ move: true, slots });
    r.hand.job = true;
    await r.hand.stage();
    expect(r.inv.slots[1]?.name).toBe('elytra');
    r.hand.preselect();
    expect(r.inv.selected).toBe(1);
    r.orbs(2);
    await r.hand.afterOre();
    expect(r.inv.selected, r.log.join(' | ')).toBe(0); // the pickaxe's slot back after the hold
    expect(r.inv.slots[1]?.damage, r.log.join(' | ')).toBeLessThan(332);
    // a hostile when the hold is asked: the hand back at once, no hold
    let t = false;
    const h = rig({ move: true, slots: [item('diamond_pickaxe', 1561), null, null, null, null, null, null, null, null, null, item('elytra', 100, true)], threat: () => (t ? { why: 'a zombie 3 blocks off in strike reach' } : undefined) });
    h.hand.job = true;
    await h.hand.stage();
    h.hand.preselect();
    expect(h.inv.selected).toBe(1);
    t = true;
    await h.hand.afterOre();
    expect(h.inv.selected).toBe(0);
    // no preselect outside a job, or with a hostile that can hurt the bot
    const o = rig({ move: true, slots: [item('diamond_pickaxe', 1561), item('elytra', 100, true)] });
    o.hand.preselect();
    expect(o.inv.selected).toBe(0);
  });

  it('Track K6: the hold line counts what the worn Mending pieces took (each orb goes whole to one piece)', async () => {
    const chest = item('iron_chestplate', 140, true);
    const armour: (ItemStack | null)[] = [null, chest, null, null];
    const inv = invOf([item('diamond_sword', 1561), item('elytra', 100, true)], 0, armour);
    const log: string[] = [];
    let n = 0;
    const hand = new MendHand({
      inventory: inv,
      select: (s) => {
        inv.selected = s;
      },
      swap: () => Promise.resolve({ ok: true }),
      entities: () => new Map(),
      position: () => ({ x: 0, y: 0, z: 0 }),
      threat: () => undefined,
      handFree: () => true,
      settings: () => ({ on: true, toolWearLimit: 10, mendAt: 10 }),
      waitTicks: () => {
        // the first tick an orb goes to the worn chestplate (4 uses)
        if (n++ === 0) armour[1] = { ...chest, damage: (chest.damage ?? 0) - 4 };
        return Promise.resolve();
      },
      log: { info: (m: string) => log.push(m), warn: () => undefined, error: () => undefined, debug: () => undefined },
    });
    const prep = (await hand.prepare())!;
    await hand.hold(prep, 'furnace', () => Promise.resolve(0));
    expect(log.some((l) => /held the elytra for furnace \d+ ticks .*: 100 -> 100\/432; worn: iron_chestplate \+4$/.test(l))).toBe(true);
  });

  it('Track K6: the walk rule (walkBlocked) replaces the strict one: allowed with hostiles that cannot reach; a probe running is waited for, then refused', async () => {
    // hostiles within 16 that cannot reach (walkBlocked says no threat): the walk is made
    const a = rig({ far: true, near: () => 'a drowned 9 blocks off (within 16)', walkBlocked: () => undefined, slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    a.orbs(3, 5);
    await a.hand.catchOrbs('orbs');
    expect(a.walks).toEqual([5]);
    // one that can: refused with its reason
    const b = rig({ far: true, walkBlocked: () => ({ why: 'a zombie 12 blocks off with a clear way to me (14 path blocks)' }), slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    b.orbs(3, 5);
    await b.hand.catchOrbs('orbs');
    expect(b.walks).toEqual([]);
    expect(b.log).toContain('mend: no walk to the orbs 5.0 blocks off: a zombie 12 blocks off with a clear way to me (14 path blocks)');
    // a probe running: asked again, the walk made once it answers
    let n = 0;
    const c = rig({ far: true, walkBlocked: () => (n++ < 4 ? { why: 'a zombie 12 blocks off, its way to me not known yet', pending: true } : undefined), slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    c.orbs(3, 5);
    await c.hand.catchOrbs('orbs');
    expect(c.walks).toEqual([5]);
    // a probe that never answers: refused after SETTLE_TICKS
    const e = rig({ far: true, walkBlocked: () => ({ why: 'a zombie 12 blocks off, its way to me not known yet', pending: true }), slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    e.orbs(3, 5);
    await e.hand.catchOrbs('orbs');
    expect(e.walks).toEqual([]);
    expect(e.log.some((l) => l.startsWith('mend: no walk to the orbs 5.0 blocks off: a zombie 12 blocks off, its way'))).toBe(true);
  });

  it('the watcher: orbs near with the hand free start a hold; none mended: quiet for a while; the ore hook only in a job', async () => {
    const r = rig({ slots: [item('diamond_sword', 1561), item('elytra', 100, true)] });
    r.hand.tick();
    expect(r.hand.busy).toBe(false);
    r.orbs(1);
    r.hand.tick();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.inv.slots[1]?.damage).toBeLessThan(332);
    expect(r.hand.stats.uses.orbs).toBeGreaterThan(0);
    const before = r.hand.stats.holds;
    await r.hand.afterOre();
    expect(r.hand.stats.holds).toBe(before);
    r.hand.job = true;
    await r.hand.afterOre();
    expect(r.hand.stats.holds).toBe(before + 1);
    expect(r.ticks()).toBeLessThanOrEqual(3 * (HOLD_MAX_TICKS + 2));
  });
});

describe('the source (chooseMendSource) and the job (MendJob)', () => {
  const base: MendSourceState = { points: 150, furnaces: [], carried: new Map(), rawFood: 0, fuelItems: 0, home: new Map(), tried: new Set() };
  it('a furnace first, then carried stock (the most experience an item), food, the home chests, an ore', () => {
    expect(chooseMendSource({ ...base, furnaces: [{ x: 1, y: 2, z: 3 }] })).toEqual({ kind: 'collect', at: { x: 1, y: 2, z: 3 } });
    const carried = new Map([['cobblestone', 64], ['raw_iron', 30], ['raw_gold', 5]]);
    expect(chooseMendSource({ ...base, carried, fuelItems: 64 })).toEqual({ kind: 'smelt', item: 'raw_gold', n: 5, from: 'carried', xp: 1 });
    expect(chooseMendSource({ ...base, carried: new Map([['raw_iron', 300]]), fuelItems: 40 })).toMatchObject({ kind: 'smelt', item: 'raw_iron', n: 40 });
    expect(chooseMendSource({ ...base, carried: new Map([['cobblestone', 64]]), rawFood: 10, fuelItems: 64 })).toEqual({ kind: 'cook', n: 10, xp: 0.35 });
    expect(chooseMendSource({ ...base, home: new Map([['raw_iron', 128]]), fuelItems: 64 })).toMatchObject({ kind: 'smelt', item: 'raw_iron', n: 64, from: 'home' });
    expect(chooseMendSource({ ...base, ore: { block: 'coal_ore', count: 30 } })).toEqual({ kind: 'mine', block: 'coal_ore', n: 16, xp: 1 });
    expect(chooseMendSource({ ...base, ore: { block: 'diamond_ore', count: 2 }, points: 6 })).toMatchObject({ kind: 'mine', n: 2 });
  });
  it('none: says what it needs; a source that gave nothing is not chosen again', () => {
    expect(chooseMendSource(base)).toEqual({ kind: 'none', why: 'no source of experience: needs something to smelt (raw iron, gold or copper, raw food, cobblestone: carried or in the chests at home in reach), or a coal, lapis, redstone, diamond or quartz ore the bot has seen near with a pickaxe' });
    expect((chooseMendSource({ ...base, carried: new Map([['raw_iron', 5]]) }) as { why: string }).why).toContain('fuel');
    expect(chooseMendSource({ ...base, carried: new Map([['raw_iron', 5]]), fuelItems: 8, tried: new Set(['smelt:raw_iron']) }).kind).toBe('none');
    expect(stepKey({ kind: 'smelt', item: 'raw_iron', n: 5, from: 'home', xp: 0.7 })).toBe('home:raw_iron');
    expect(stepCommand({ kind: 'mine', block: 'coal_ore', n: 4, xp: 1 })).toBe('mine coal_ore 4');
  });
  it('the arguments', () => {
    expect(parseMendArgs([])).toEqual({ kind: 'run', minutes: 15 });
    expect(parseMendArgs(['elytra', '30'])).toEqual({ kind: 'run', want: 'elytra', minutes: 30 });
    expect(parseMendArgs(['status'])).toEqual({ kind: 'status' });
    expect(parseMendArgs(['stop'])).toEqual({ kind: 'stop' });
    expect(parseMendArgs(['0']).kind).toBe('error');
    expect(gainLine([{ name: 'elytra', left: 131, max: 432, mending: true } as MendPiece], [{ name: 'elytra', left: 302, max: 432, mending: true } as MendPiece])).toBe('elytra 131 -> 302/432');
  });

  /** A job over fakes: a smelt of raw iron mends 1.4 uses an item, the furnace output 10 uses. */
  const jobRig = (o: { carried?: Record<string, number>; furnaces?: number; fuel?: number; home?: Record<string, number>; elytra?: number; pickaxe?: number }) => {
    let elytra = o.elytra ?? 131;
    let pickaxe = o.pickaxe ?? 1561;
    const carried = new Map(Object.entries(o.carried ?? {}));
    const home = new Map(Object.entries(o.home ?? {}));
    let furnaces = Array.from({ length: o.furnaces ?? 0 }, (_, i) => ({ x: i, y: 0, z: 0 }));
    let now = 0;
    const cmds: string[] = [];
    const hand = { want: undefined as string | undefined, job: false, refusal: undefined as string | undefined };
    let refuse: string | undefined;
    const mend = (uses: number): void => {
      if (elytra < 432) elytra = Math.min(432, elytra + uses);
      else pickaxe = Math.min(1561, pickaxe + uses);
    };
    const d: MendJobDeps = {
      pieces: () => [
        { name: 'elytra', where: 'carried', slot: 3, left: elytra, max: 432, mending: true, aside: false, wornOut: false },
        { name: 'diamond_pickaxe', where: 'held', slot: 0, left: pickaxe, max: 1561, mending: true, aside: false, wornOut: false },
      ],
      hand,
      furnaces: () => furnaces,
      collect: async () => {
        await Promise.resolve();
        furnaces = furnaces.slice(1);
        mend(10);
        now += 5_000;
        return 8;
      },
      carried: () => carried,
      rawFood: () => 0,
      fuelItems: () => o.fuel ?? 0,
      home: () => home,
      withdraw: async (it, n) => {
        await Promise.resolve();
        const h = home.get(it) ?? 0;
        const got = Math.min(h, n);
        home.set(it, h - got);
        carried.set(it, (carried.get(it) ?? 0) + got);
        return got;
      },
      ore: () => undefined,
      run: async (cmd) => {
        await Promise.resolve();
        cmds.push(cmd);
        expect(hand.job).toBe(true);
        if (refuse) {
          // the hand refused every take: the smelt ran, nothing was mended
          hand.refusal = refuse;
          carried.set('raw_iron', 0);
          return 'smelted 8 iron_ingot';
        }
        const [, it, n] = cmd.split(' ');
        const k = it === 'iron' ? 'raw_iron' : it!;
        const take = Math.min(Number(n), carried.get(k) ?? 0);
        carried.set(k, (carried.get(k) ?? 0) - take);
        mend(Math.round(take * 1.4));
        now += take * 10_000;
        return `smelted ${take} iron_ingot`;
      },
      now: () => now,
    };
    return { d, cmds, hand, state: () => ({ elytra, pickaxe }), refuseWith: (s: string) => (refuse = s) };
  };

  it('furnace outputs, then the carried stock, then the home chests; the end line', async () => {
    const r = jobRig({ furnaces: 1, carried: { raw_iron: 64 }, fuel: 200, home: { raw_iron: 200 } });
    const rep = await new MendJob(r.d, undefined, 120).run();
    // the last smelt sized to the points still wanted (0.7 an item)
    expect(r.cmds).toEqual(['smelt raw_iron 64', 'smelt raw_iron 64', 'smelt raw_iron 64', 'smelt raw_iron 16']);
    expect(r.state().elytra).toBe(432);
    expect(rep.line).toMatch(/^mend: elytra 131 -> 432\/432 in \d+ min: took 8 out of the furnace at 0 0 0, smelted 64 raw_iron, smelted 64 raw_iron from the chests at home/);
    expect(rep.why).toBe('every Mending piece is mended');
    expect(r.hand.job).toBe(false);
  });
  it('one piece named: stops when it is mended; the time bound; no source', async () => {
    const r = jobRig({ carried: { raw_iron: 300 }, fuel: 400, pickaxe: 1000 });
    const rep = await new MendJob(r.d, 'elytra', 120).run();
    expect(rep.why).toBe('the elytra is mended');
    expect(r.state().elytra).toBe(432);
    const t = jobRig({ carried: { raw_iron: 300 }, fuel: 400, elytra: 10 });
    expect((await new MendJob(t.d, undefined, 5).run()).why).toBe('the 5-minute bound');
    const none = jobRig({});
    expect((await new MendJob(none.d, undefined, 15).run()).line).toMatch(/^mend: nothing mended in 1 min; stopped: no source of experience: needs something to smelt/);
    const full = jobRig({ elytra: 432 });
    expect((await new MendJob(full.d, undefined, 15).run()).line).toBe('mend: every Mending piece is mended');
    expect((await new MendJob(full.d, 'trident', 15).run()).line).toBe('mend: no trident with Mending carried, worn or held');
  });
  it('nothing mended: the end line says uses gained 0 and why (the hand\'s refusal)', async () => {
    const r = jobRig({ carried: { raw_iron: 8 }, fuel: 8 });
    r.refuseWith('not held: a zombie 5 blocks off with a clear way to me (6 path blocks)');
    const rep = await new MendJob(r.d, 'elytra', 15).run();
    expect(rep.uses).toBe(0);
    expect(rep.line).toMatch(/^mend: nothing mended \(uses gained 0: not held: a zombie 5 blocks off with a clear way to me \(6 path blocks\)\) in 1 min: smelted 8 raw_iron; stopped: no source/);
  });
  it('the mine source keeps the strict rule: a hostile within 16 and the ores near wait, said in the reply', () => {
    const s = chooseMendSource({ points: 10, furnaces: [], carried: new Map(), rawFood: 0, fuelItems: 0, home: new Map(), tried: new Set(), ore: { block: 'coal_ore', count: 5 }, oreBlocked: 'a zombie 9 blocks off (within 16)' });
    expect(s).toEqual({ kind: 'none', why: 'no source of experience: needs something to smelt (raw iron, gold or copper, raw food, cobblestone: carried or in the chests at home in reach), or the coal_ore near mined (not now: a zombie 9 blocks off (within 16))' });
  });
  it('stopped by the owner', async () => {
    const r = jobRig({ carried: { raw_iron: 300 }, fuel: 400, elytra: 10 });
    const j = new MendJob(r.d, undefined, 120);
    j.aborted = '!stop';
    expect((await j.run()).why).toBe('stopped (!stop)');
  });
});

describe('the setting', () => {
  it('mendOnTheWay is on by default and listed', () => {
    expect(SETTING_DEFS.mendOnTheWay.default).toBe(true);
    expect(SETTING_GROUPS.some(([, names]) => names.includes('mendOnTheWay'))).toBe(true);
  });
});

describe('the elytra rules know Mending (Track K4 lines, the test kit)', () => {
  it('`!elytra status` and a refusal say a damaged Mending elytra can be mended', () => {
    expect(mendHint({ current: { source: 'back', left: 131, mending: true }, spares: [], home: 0, homeInReach: false })).toBe('; it has Mending: !mend elytra mends it (151 experience)');
    expect(mendHint({ current: { source: 'back', left: 131, mending: false }, spares: [], home: 0, homeInReach: false })).toBe('');
    expect(mendHint({ current: { source: 'back', left: 432, mending: true }, spares: [], home: 0, homeInReach: false })).toBe('');
  });
  it('the test kit keeps a Mending elytra under elytraMin (a fresh one would lose it) and still replaces a plain one', () => {
    const worn = { head: null, chest: item('elytra', 60, true), legs: null, feet: null, offhand: null };
    const slots = Array.from({ length: 36 }, () => null as ItemStack | null);
    slots[5] = item('elytra', 40);
    slots[6] = item('elytra', 40, true);
    const p = planKit([], { slots, worn }, { elytraMin: 250 });
    expect(p.commands).toEqual(['/replaceitem entity @s slot.hotbar 5 elytra']);
    expect(p.notes).toEqual(['elytra on the back: kept, it has Mending (60 uses left; !mend elytra)', 'elytra in slot 5: a fresh one (it had 40 uses left)', 'elytra in slot 6: kept, it has Mending (40 uses left; !mend elytra)']);
  });
});