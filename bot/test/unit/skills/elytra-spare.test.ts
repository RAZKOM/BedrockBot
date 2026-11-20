// Track K4 (ADR 0108, docs/flight.md "An elytra on hand"): the stock rule's pure rules (skills/supply/elytra.ts), its job,
// process, chore and takeoff question (tasks/process/elytra.ts) on fakes, and the unloader's keep rule for worn spares.
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { RecipeIndex } from '../../../src/skills/craft/recipes.ts';
import { tripCover } from '../../../src/skills/fly/wear.ts';
import { planUnload, type UnloadSlot } from '../../../src/skills/home/unloader.ts';
import { boxElytra, chooseElytra, covers, ELYTRA_LOW_USES, elytraLine, elytraPieces, elytraToStore, limitOf, neverCovered, panelElytraLine, pieceLine, type ElytraPiece, type ElytraState } from '../../../src/skills/supply/elytra.ts';
import { ElytraController, ElytraJob, elytraReply, type ElytraDeps, type ElytraSource } from '../../../src/tasks/process/elytra.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const TW = 10; // toolWearLimit: the worn limit is 30 (44 with Mending)
const el = (left: number, mending = false): ItemStack => ({ name: 'elytra', count: 1, damage: 432 - left, ...(mending ? { enchants: [{ id: 26, level: 1 }] } : {}) }) as ItemStack;
const all = { boxes: true, home: true };
const carriedOnly = { boxes: true, home: false };
const piece = (source: ElytraPiece['source'], left: number, slot?: number, o: Partial<ElytraPiece> = {}): ElytraPiece => ({ source, left, mending: false, ...(slot !== undefined ? { slot } : {}), ...o });
const state = (current: ElytraPiece | undefined, spares: ElytraPiece[] = [], home = 0, homeInReach = false): ElytraState => ({ ...(current ? { current } : {}), spares, home, homeInReach });
/** A shulker box item's wire NBT holding the given elytra (box slot, damage, Mending). */
const boxRaw = (items: { slot: number; damage: number; mending?: boolean; name?: string }[]) => ({
  extra: { nbt: { nbt: { value: { Items: { value: { value: items.map((i) => ({ Name: { value: i.name ?? 'minecraft:elytra' }, Count: { value: 1 }, Slot: { value: i.slot }, tag: { value: { Damage: { value: i.damage }, ...(i.mending ? { ench: { value: { value: [{ id: { value: 26 }, lvl: { value: 1 } }] } } } : {}) } } })) } } } } } },
});

describe('what is to hand (elytraPieces, boxElytra)', () => {
  it('the one on the back first; else the first carried is the kit\'s (as readKit reads it); the rest are spares', () => {
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
    slots[9] = el(58);
    slots[14] = el(432);
    const s = elytraPieces({ slots }, []);
    expect(s.current).toEqual({ source: 'kit', slot: 9, left: 58, mending: false });
    expect(s.spares).toEqual([{ source: 'loose', slot: 14, left: 432, mending: false }]);
    const worn = elytraPieces({ slots, window: (id) => (id === 120 ? { slots: [null, el(200, true), null, null] } : undefined) }, []);
    expect(worn.current).toEqual({ source: 'back', left: 200, mending: true });
    expect(worn.spares.map((p) => p.slot)).toEqual([9, 14]);
  });

  it('the elytra inside a carried box by its NBT: the box slot, the uses left, Mending; nothing else counts', () => {
    expect(boxElytra(boxRaw([{ slot: 3, damage: 0 }, { slot: 5, damage: 400, mending: true }, { slot: 7, damage: 0, name: 'minecraft:firework_rocket' }]))).toEqual([
      { inBox: 3, left: 432, mending: false },
      { inBox: 5, left: 32, mending: true },
    ]);
    expect(boxElytra(undefined)).toEqual([]);
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
    slots[9] = el(58);
    slots[20] = { name: 'undyed_shulker_box', count: 1 } as ItemStack;
    const s = elytraPieces({ slots, rawItem: (_w, i) => (i === 20 ? boxRaw([{ slot: 0, damage: 0 }]) : undefined) }, [20], { count: 2, inReach: true });
    expect(s.spares).toEqual([{ source: 'box', slot: 20, inBox: 0, left: 432, mending: false }]);
    expect(s).toMatchObject({ home: 2, homeInReach: true });
    // a box the Supply does not offer (the fireworks box, one owed to a chest) is not read
    expect(elytraPieces({ slots, rawItem: () => boxRaw([{ slot: 0, damage: 0 }]) }, []).spares).toEqual([]);
  });
});

describe('the stock rule (chooseElytra)', () => {
  const trip = { distance: 400 };
  it('a trip of 400 blocks: 58 uses (28 over the limit) do not cover it, 432 do', () => {
    expect(tripCover(58, 30, 400, {}).ok).toBe(false);
    expect(covers({ left: 58, mending: false }, TW, trip)).toBe(false);
    expect(covers({ left: 432, mending: false }, TW, trip)).toBe(true);
    expect(limitOf({ mending: true }, TW)).toBe(44);
  });

  it('covered: nothing to do', () => {
    expect(chooseElytra(state(piece('back', 300), [piece('loose', 432, 10)]), TW, trip, all).kind).toBe('ok');
  });

  it('the cheapest source first: loose, then a carried box, then the chests at home (in reach and allowed only)', () => {
    const s = state(piece('kit', 58, 9), [piece('box', 432, 20, { inBox: 0 }), piece('loose', 200, 12)], 1, true);
    expect(chooseElytra(s, TW, trip, all)).toMatchObject({ kind: 'swap', piece: { source: 'loose', slot: 12 }, why: 'a spare carried loose (200 uses)' });
    const nb = state(piece('kit', 58, 9), [piece('box', 432, 20, { inBox: 0 })], 1, true);
    expect(chooseElytra(nb, TW, trip, all)).toMatchObject({ kind: 'swap', piece: { source: 'box', inBox: 0 } });
    expect(chooseElytra(nb, TW, trip, { boxes: false, home: true })).toMatchObject({ kind: 'home' });
    const home = state(piece('kit', 58, 9), [], 1, true);
    expect(chooseElytra(home, TW, trip, all)).toEqual({ kind: 'home', why: '1 in the chests at home' });
    expect(chooseElytra(home, TW, trip, carriedOnly).kind).toBe('none'); // the trip readiness never walks to storage
    expect(chooseElytra(state(piece('kit', 58, 9), [], 1, false), TW, trip, all).kind).toBe('none'); // out of reach
  });

  it('within a source the most uses left of those that cover the trip; one that does not cover it is never put on', () => {
    const s = state(piece('back', 40), [piece('loose', 60, 10), piece('loose', 300, 11), piece('loose', 432, 12)]);
    expect(chooseElytra(s, TW, trip, all)).toMatchObject({ kind: 'swap', piece: { slot: 12 } });
    const short = state(piece('back', 40), [piece('loose', 60, 10)]);
    expect(chooseElytra(short, TW, trip, all)).toEqual({ kind: 'none', never: false, why: 'no spare that covers it (carried, in the boxes or at home in reach); the spare carried: 60/432' });
  });

  it('no elytra at hand: a boxed one becomes the kit\'s; a trip no elytra covers asks nothing', () => {
    expect(chooseElytra(state(undefined, [piece('box', 432, 20, { inBox: 4 })]), TW, trip, all)).toMatchObject({ kind: 'swap', piece: { source: 'box' } });
    expect(neverCovered(TW, { distance: 141_000 })).toBe(true);
    expect(chooseElytra(state(piece('back', 58), [piece('loose', 432, 10)]), TW, { distance: 141_000 }, all)).toMatchObject({ kind: 'none', never: true });
  });

  it('a number of uses (the chore, !elytra): ELYTRA_LOW_USES over the worn limit', () => {
    expect(ELYTRA_LOW_USES).toBe(100);
    expect(chooseElytra(state(piece('back', 131)), TW, { uses: 100 }, all).kind).toBe('ok');
    expect(chooseElytra(state(piece('back', 129), [piece('loose', 432, 10)]), TW, { uses: 100 }, all).kind).toBe('swap');
  });
});

describe('the keep rule (elytraToStore) and the unloader', () => {
  it('the one with the most uses stays; every other carried one under 100 uses over its limit is stored; a fresher spare is kept', () => {
    expect([...elytraToStore(state(piece('back', 400), [piece('loose', 58, 10), piece('loose', 20, 11), piece('loose', 300, 12)]), TW)].sort()).toEqual([10, 11]);
    expect([...elytraToStore(state(piece('kit', 432, 9), [piece('loose', 58, 10)]), TW)]).toEqual([10]);
    expect([...elytraToStore(state(piece('kit', 58, 9), [piece('loose', 432, 10)]), TW)]).toEqual([9]); // the worn one in the kit's slot
    expect([...elytraToStore(state(piece('kit', 410, 9), [piece('loose', 432, 10)]), TW)]).toEqual([]); // two good ones: both kept
    expect([...elytraToStore(state(piece('kit', 130, 9), [piece('loose', 432, 10)]), TW)]).toEqual([]); // 100 over the limit of 30: not low
  });

  it('all low: the best stays (the one on the back on a tie); Mending ones are kept to be mended; the back is never a slot', () => {
    expect([...elytraToStore(state(piece('kit', 25, 9), [piece('loose', 28, 10), piece('loose', 10, 11)]), TW)].sort()).toEqual([11, 9]);
    expect([...elytraToStore(state(piece('back', 20), [piece('loose', 28, 10)]), TW)]).toEqual([]);
    expect([...elytraToStore(state(piece('back', 28), [piece('loose', 28, 10)]), TW)]).toEqual([10]);
    expect([...elytraToStore(state(piece('back', 400), [piece('loose', 30, 10, { mending: true })]), TW)]).toEqual([]);
  });
  it('planUnload: a stored elytra goes into a chest like loot; an elytra not marked stays (gear)', () => {
    const chest = { key: 'a', pos: { x: 3, y: 0, z: 0 }, kind: 'chest', free: 27, contents: {}, room: {}, boxes: { empty: 0, full: 0 } };
    const slots: UnloadSlot[] = [
      { slot: 9, name: 'elytra', count: 1, store: true },
      { slot: 10, name: 'elytra', count: 1 },
      { slot: 11, name: 'dirt', count: 64 },
    ];
    const plan = planUnload(slots, [chest], { reserve: 0 });
    expect(plan.moves.filter((m) => m.name === 'elytra').map((m) => m.slot)).toEqual([9]);
    const before = planUnload(slots.map(({ store: _s, ...x }) => x), [chest], { reserve: 0 });
    expect(before.moves.some((m) => m.name === 'elytra')).toBe(false);
  });
});

describe('the lines', () => {
  it('pieceLine, the status line, the panel row', () => {
    expect(pieceLine({ left: 58, mending: false }, TW)).toMatch(/^58\/432 \(covers about \d+ blocks\)$/);
    expect(pieceLine({ left: 25, mending: false }, TW)).toBe('25/432 (worn: no flights)');
    expect(pieceLine({ left: 40, mending: true }, TW)).toBe('40/432 (set aside to be mended)');
    expect(elytraLine(state(piece('back', 58)), TW)).toMatch(/^elytra 58\/432 \(covers about \d+ blocks\) on; no spare \(carried, in the boxes or at home in reach\)$/);
    expect(elytraLine(state(piece('kit', 58, 9), [piece('loose', 20, 10)]), TW)).toMatch(/; no spare \(carried, in the boxes or at home in reach\); worn spares: 20 loose$/);
    expect(elytraLine(state(piece('kit', 58, 9), [piece('loose', 432, 10), piece('box', 400, 20, { inBox: 1 })], 2, false), TW)).toMatch(/; spares: 432 loose, 400 in a box, 2 at home \(out of reach\)$/);
    expect(elytraLine(state(undefined), TW)).toBe('no elytra; no spare (carried, in the boxes or at home in reach)');
    expect(panelElytraLine(state(piece('back', 410), [piece('box', 432, 20, { inBox: 0 })], 1), TW)).toBe('410/432 on, spares 432 (box), 1 at home');
    expect(panelElytraLine(state(piece('kit', 20, 9)), TW)).toBe('20/432 (worn)');
    expect(panelElytraLine(state(undefined), TW)).toBeUndefined();
  });
});

/** A fake inventory of elytra: the back, slots, boxes, the home chests; the moves the job asks for. */
function fakeSource(o: { back?: number; slots?: Record<number, number>; boxes?: Record<number, number[]>; home?: number[]; inReach?: boolean }) {
  const s = { back: o.back, slots: { ...(o.slots ?? {}) } as Record<number, number>, boxes: Object.fromEntries(Object.entries(o.boxes ?? {}).map(([k, v]) => [k, [...v]])) as Record<string, number[]>, home: [...(o.home ?? [])] };
  const calls: string[] = [];
  const free = (): number => [...Array(36).keys()].find((i) => s.slots[i] === undefined && s.boxes[i] === undefined)!;
  const source: ElytraSource = {
    state: () => {
      const keys = Object.keys(s.slots).map(Number).sort((a, b) => a - b);
      const pieces = keys.map((k) => ({ slot: k, left: s.slots[k]! }));
      const current = s.back !== undefined ? piece('back', s.back) : pieces[0] ? piece('kit', pieces[0].left, pieces[0].slot) : undefined;
      const loose = (s.back !== undefined ? pieces : pieces.slice(1)).map((p) => piece('loose', p.left, p.slot));
      const boxed = Object.entries(s.boxes).flatMap(([slot, list]) => list.map((left, i) => piece('box', left, Number(slot), { inBox: i })));
      return state(current, [...loose, ...boxed], s.home.length, o.inReach ?? false);
    },
    wear: async (from) => {
      await Promise.resolve();
      calls.push(`wear ${from}`);
      const was = s.back;
      s.back = s.slots[from];
      if (was === undefined) delete s.slots[from];
      else s.slots[from] = was;
      return { ok: true };
    },
    swap: async (a, b) => {
      await Promise.resolve();
      calls.push(`swap ${a} ${b}`);
      const x = s.slots[a]!;
      s.slots[a] = s.slots[b]!;
      s.slots[b] = x;
      return { ok: true };
    },
    fromBox: async (slot, inBox) => {
      await Promise.resolve();
      calls.push(`box ${slot}:${inBox}`);
      const list = s.boxes[slot] ?? [];
      const left = list[inBox];
      if (left === undefined) return { got: 0, why: 'none there' };
      list.splice(inBox, 1);
      s.slots[free()] = left;
      return { got: 1, why: 'emptied partly' };
    },
    fromHome: async (pick) => {
      await Promise.resolve();
      calls.push('home');
      const ok = s.home.map((left, i) => ({ left, i })).filter((x) => pick.accept(el(x.left))).sort((a, b) => pick.rank(el(b.left)) - pick.rank(el(a.left)))[0];
      if (!ok) return { got: 0, why: 'none that covers it' };
      s.home.splice(ok.i, 1);
      s.slots[free()] = ok.left;
      return { got: 1 };
    },
  };
  return { s, calls, source };
}

function deps(source: ElytraSource, settings: Record<string, unknown> = {}, now = () => 0): ElytraDeps {
  const values: Record<string, unknown> = { toolWearLimit: TW, elytraSpare: true, autoElytra: false, autoFly: true, flyMin: 200, ...settings };
  return {
    processes: new ProcessManager(),
    settings: { get: ((k: string) => values[k]) as never },
    source,
    position: () => ({ x: 0, y: 64, z: 0 }),
    home: () => ({ x: 0, y: 64, z: 0 }),
    isDay: () => true,
    threat: () => undefined,
    cancel: () => {},
    waitTicks: () => Promise.resolve(),
    now,
  };
}

describe('the job (ElytraJob) on a fake source', () => {
  const trip = { distance: 400 };
  it('the worn one on the back, a new one loose: one armour swap, the worn one into the spare\'s slot', async () => {
    const f = fakeSource({ back: 58, slots: { 12: 432 } });
    const r = await new ElytraJob(trip, all).run(deps(f.source), () => false);
    expect(f.calls).toEqual(['wear 12']);
    expect(f.s).toMatchObject({ back: 432, slots: { 12: 58 } });
    expect(r).toMatchObject({ ok: true, before: 58, after: 432, from: 'loose', reason: 'done', already: false });
    expect(elytraReply(r, f.source.state(), TW)).toMatch(/^elytra: put on the spare carried loose: 432\/432 \(covers about \d+ blocks\); the worn one \(58\) is carried$/);
  });

  it('the worn one in the kit\'s slot (not worn), a new one later: one slot exchange (the kit reads the first)', async () => {
    const f = fakeSource({ slots: { 9: 58, 10: 432 } });
    const r = await new ElytraJob(trip, all).run(deps(f.source), () => false);
    expect(f.calls).toEqual(['swap 9 10']);
    expect(f.s.slots).toEqual({ 9: 432, 10: 58 });
    expect(r.ok).toBe(true);
  });

  it('a new one in a carried box: taken out (that box slot only); in a slot before the worn one it is the kit\'s at once', async () => {
    const f = fakeSource({ slots: { 9: 58 }, boxes: { 20: [100, 432] } });
    const r = await new ElytraJob(trip, all).run(deps(f.source), () => false);
    expect(f.calls).toEqual(['box 20:1']);
    expect(f.s.slots).toEqual({ 0: 432, 9: 58 });
    expect(r).toMatchObject({ ok: true, from: 'box' });
  });

  it('a new one in the chests at home in reach: taken (only one that covers the trip, the most uses first), then put on', async () => {
    const f = fakeSource({ back: 58, home: [40, 300, 432], inReach: true });
    const r = await new ElytraJob(trip, all).run(deps(f.source), () => false);
    expect(f.calls).toEqual(['home', 'wear 0']);
    expect(f.s.home).toEqual([40, 300]);
    expect(r).toMatchObject({ ok: true, from: 'home', after: 432 });
    expect(elytraReply(r, f.source.state(), TW)).toMatch(/^elytra: put on the spare from the chests at home/);
  });

  it('the chests hold only worn ones: nothing taken, the line says so', async () => {
    const f = fakeSource({ back: 58, home: [40], inReach: true });
    const r = await new ElytraJob(trip, all).run(deps(f.source), () => false);
    expect(f.calls).toEqual(['home']);
    expect(r).toMatchObject({ ok: false, reason: 'short', after: 58 });
    expect(r.why).toMatch(/^the chests at home gave none that covers it/);
  });

  it('nothing anywhere: no move, the why of the refusal', async () => {
    const f = fakeSource({ back: 58 });
    const r = await new ElytraJob(trip, all).run(deps(f.source), () => false);
    expect(f.calls).toEqual([]);
    expect(r).toMatchObject({ ok: false, reason: 'short', why: 'no spare that covers it (carried, in the boxes or at home in reach)' });
  });
});

describe('the controller: the takeoff, the readiness, the chore', () => {
  it('forTrip: puts the spare on; elytraSpare off asks nothing; a walk (act false) moves nothing; ask says what a refusal adds', async () => {
    const f = fakeSource({ back: 58, slots: { 12: 432 } });
    const c = new ElytraController(deps(f.source));
    expect(c.ask(400)).toEqual({ act: true });
    expect(await c.forTrip(400, { act: false })).toEqual({ changed: false });
    expect(f.calls).toEqual([]);
    expect(await c.forTrip(400)).toEqual({ changed: true });
    expect(f.calls).toEqual(['wear 12']);
    expect(c.ask(400)).toEqual({ act: false });
    c.dispose();
    const none = fakeSource({ back: 58 });
    const c2 = new ElytraController(deps(none.source));
    expect(c2.ask(400)).toEqual({ act: false, line: '; no spare that covers it (carried, in the boxes or at home in reach)' });
    expect(c2.ask(141_000)).toEqual({ act: false }); // the cover line says "more than a new elytra has" already
    c2.dispose();
    const off = fakeSource({ back: 58, slots: { 12: 432 } });
    const c3 = new ElytraController(deps(off.source, { elytraSpare: false }));
    expect(await c3.forTrip(400)).toEqual({ changed: false });
    expect(c3.ask(400)).toEqual({ act: false });
    expect(off.calls).toEqual([]);
    c3.dispose();
  });

  it('the readiness: carried spares only (never the home chests), from flyMin on, autoFly on', async () => {
    const f = fakeSource({ back: 58, boxes: { 20: [432] }, home: [432], inReach: true });
    const c = new ElytraController(deps(f.source));
    expect(c.tripNeeded(150)).toBe(false);
    expect(c.tripNeeded(400)).toBe(true);
    await c.tripRun(400, () => true);
    expect(f.calls).toEqual(['box 20:0', 'wear 0']);
    c.dispose();
    const h = fakeSource({ back: 58, home: [432], inReach: true });
    const ch = new ElytraController(deps(h.source));
    expect(ch.tripNeeded(400)).toBe(false);
    ch.dispose();
    const nf = new ElytraController(deps(fakeSource({ back: 58, slots: { 10: 432 } }).source, { autoFly: false }));
    expect(nf.tripNeeded(400)).toBe(false);
    nf.dispose();
  });

  it('the chore: off by default; on, at home by day under ELYTRA_LOW_USES with a better one in a box: it runs; with none it waits 10 minutes', () => {
    let now = 5000;
    const f = fakeSource({ back: 120, boxes: { 20: [432] } });
    const off = new ElytraController(deps(f.source, {}, () => now));
    expect(off.chore.wants()).toBe(false);
    off.dispose();
    const on = new ElytraController(deps(f.source, { autoElytra: true }, () => now));
    expect(on.chore.wants()).toBe(true);
    on.dispose();
    const fine = new ElytraController(deps(fakeSource({ back: 200, boxes: { 20: [432] } }).source, { autoElytra: true }, () => now));
    expect(fine.chore.wants()).toBe(false); // 170 over the limit
    fine.dispose();
    const empty = new ElytraController(deps(fakeSource({ back: 58 }).source, { autoElytra: true }, () => now));
    expect(empty.chore.wants()).toBe(false);
    expect(empty.chore.nextTry).toBe(now + 10 * 60_000);
    expect(empty.statusLine()).toMatch(/^elytra 58\/432 .* on; no spare \(carried, in the boxes or at home in reach\); worn limit 30; autoElytra on, next look in 600 s \(no spare that covers it/);
    now += 1;
    empty.dispose();
  });
});

describe('the settings and the recipe evidence', () => {
  it('elytraSpare on (a carried swap is not risky), autoElytra off (the chore moves the body), both in the flight group', () => {
    expect(SETTING_DEFS.elytraSpare.default).toBe(true);
    expect(SETTING_DEFS.autoElytra.default).toBe(false);
    const flight = SETTING_GROUPS.find(([g]) => g === 'flight')?.[1] ?? [];
    expect(flight).toEqual(expect.arrayContaining(['elytraSpare', 'autoElytra']));
  });

  it('RecipeIndex keeps the multi recipes\' ids (the server-side recipes: the repair of two worn items among them)', () => {
    const idx = new RecipeIndex(() => undefined);
    idx.handle({ shaped_recipes: [], shapeless_recipes: [], multi_recipes: [{ uuid: '00000000-0000-0000-0000-000000000001', network_id: 7 }] });
    expect(idx.multi).toEqual(['00000000-0000-0000-0000-000000000001']);
    expect(idx.byOutput('elytra')).toEqual([]);
  });
});
