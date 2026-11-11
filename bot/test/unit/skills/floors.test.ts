// Track M1 (docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): the guard tests for the health rule's order
// (pveFloor) and the seal-in's block choice and cells (skills/survival/seal.ts).
import { describe, expect, it, vi } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { canSealHere, digInCells, openSide, seal, SEAL_BLOCKS, sealCells, sealItems } from '../../../src/skills/survival/seal.ts';
import { EAT_BEFORE_SPRINT_LOST, eatWhileWalking } from '../../../src/skills/survival/index.ts';
import { FIRST_MAX_DY, FIRST_RETRY_MS } from '../../../src/skills/combat/targeting.ts';
import { FLY_HANDOVER_MS, FOOD_SPRINT_EAT, HOLD_MAX, holdGround, PveController, pveFloor, type FloorInput, type HoldInput } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';
import { FlatGrid } from './combat-fakes.ts';

const base: FloorInput = { danger: true, canDuel: false, nearest: 3, health: 6, food: 14, hasFood: true, failed: false, critical: false, fly: true, seal: true };
const f = (o: Partial<FloorInput>) => pveFloor({ ...base, ...o });

describe('the health rule (pveFloor): the floors in order', () => {
  it('no danger, or a duel worth it: fight on', () => {
    expect(f({ danger: false })).toBe('fight');
    expect(f({ canDuel: true, failed: true, critical: true })).toBe('fight');
  });

  it('clear of every mob by 8 with food: eat (before running, before the elytra)', () => {
    expect(f({ nearest: 8 })).toBe('eat');
    expect(f({ nearest: 9, failed: true })).toBe('eat');
    expect(f({ nearest: 9, hasFood: false })).toBe('backoff');
    expect(f({ nearest: 9, food: 20 })).toBe('backoff');
  });

  it('a mob near: back off (run with the reflex striking behind) while running works', () => {
    expect(f({})).toBe('backoff');
  });

  it('running failed, or critical next to a melee mob: the elytra flee, then the seal-in, then defend in place', () => {
    for (const k of ['failed', 'critical'] as const) {
      expect(f({ [k]: true })).toBe('fly');
      expect(f({ [k]: true, fly: false })).toBe('seal');
      expect(f({ [k]: true, fly: false, seal: false })).toBe('defend');
    }
  });
});

const stack = (name: string, count: number): ItemStack => ({ name, networkId: 1, count, metadata: 0 });

describe('the seal-in block choice (sealItems)', () => {
  it('throwaway kinds only, best first, the total over kinds', () => {
    const slots = [stack('diamond_block', 64), stack('sand', 64), stack('gravel', 64), stack('dirt', 5), stack('oak_log', 32), stack('cobblestone', 3), stack('tnt', 4), stack('chest', 2), null, stack('cobblestone', 2)];
    const r = sealItems(slots);
    expect(r.items).toEqual(['cobblestone', 'dirt']);
    expect(r.total).toBe(10);
  });

  it('never a falling, valuable or active block in the list', () => {
    for (const bad of ['sand', 'red_sand', 'gravel', 'concrete_powder', 'tnt', 'chest', 'shulker_box', 'diamond_block', 'iron_block', 'gold_block', 'oak_log', 'white_wool', 'oak_leaves', 'bed', 'diamond_ore']) expect(SEAL_BLOCKS).not.toContain(bad);
    expect(sealItems([stack('minecraft:netherrack', 9)]).items).toEqual(['netherrack']);
  });
});

describe('the seal-in cells (sealCells, openSide)', () => {
  const me: Vec3 = { x: 10.5, y: -60, z: 20.5 };
  const none = () => false;

  it('ten cells in the open: the feet ring, the head ring, a support for the roof, the roof; the side facing the nearest mob first', () => {
    const cells = sealCells(me, none, [{ x: 14, y: -60, z: 20.5 }]);
    expect(cells).toHaveLength(10);
    expect(cells[0]).toEqual({ x: 11, y: -60, z: 20 }); // east, towards the mob
    expect(cells.slice(0, 4).every((c) => c.y === -60)).toBe(true);
    expect(cells.slice(4, 8).every((c) => c.y === -59)).toBe(true);
    expect(cells[8]).toEqual({ x: 11, y: -58, z: 20 }); // on the east head block: the roof's face to go against
    expect(cells[9]).toEqual({ x: 10, y: -58, z: 20 });
    // a block over the roof cell already (a ceiling at 3): no support
    expect(sealCells(me, (x, y, z) => x === 10 && y === -57 && z === 20)).toHaveLength(9);
  });

  it('solid cells are left out (a wall at its back)', () => {
    const solid = (x: number, _y: number, _z: number) => x === 9;
    const cells = sealCells(me, solid);
    expect(cells).toHaveLength(7);
    expect(cells.some((c) => c.x === 9)).toBe(false);
  });

  it('opens the side away from the mobs', () => {
    const side = openSide(me, [{ x: 14, y: -60, z: 20.5 }, { x: 10.5, y: -60, z: 25 }]);
    expect(side).toEqual([
      { x: 9, y: -60, z: 20 },
      { x: 9, y: -59, z: 20 },
    ]);
  });

  it('seal(): places each open cell with the throwaway kinds, refuses without enough blocks', async () => {
    const placed: Vec3[] = [];
    const solidSet = new Set<string>();
    const deps = {
      place: (p: Vec3, o: { item: string[] }) => {
        expect(o.item).toEqual(['cobblestone']);
        placed.push(p);
        solidSet.add(`${p.x},${p.y},${p.z}`);
        return Promise.resolve({ ok: true });
      },
      dig: () => Promise.resolve({ ok: true }),
      solid: (x: number, y: number, z: number) => solidSet.has(`${x},${y},${z}`),
      position: () => me,
      threats: () => [],
      slots: () => [stack('cobblestone', 10)],
    };
    const r = await seal(deps, () => false);
    expect(r.ok).toBe(true);
    expect(placed).toHaveLength(10);
    const r2 = await seal({ ...deps, solid: () => false, slots: () => [stack('cobblestone', 9)] }, () => false);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/blocks 9 < 10/);
  });

  it('seal(): the cells a block would not go into get a second pass after the body is centred again, and are reported', async () => {
    let tries = 0;
    let centred = 0;
    const solidSet = new Set<string>();
    const deps = {
      place: (p: Vec3) => {
        // the east feet cell refuses its first 3 tries (the body overlaps it), then takes the block
        if (p.x === 11 && p.y === -60 && tries++ < 3) return Promise.resolve({ ok: false, reason: 'occupied' });
        solidSet.add(`${p.x},${p.y},${p.z}`);
        return Promise.resolve({ ok: true });
      },
      dig: () => Promise.resolve({ ok: true }),
      solid: (x: number, y: number, z: number) => solidSet.has(`${x},${y},${z}`),
      position: () => me,
      threats: () => [],
      slots: () => [stack('cobblestone', 10)],
      centre: () => {
        centred++;
        return Promise.resolve(true);
      },
    };
    const r = await seal(deps, () => false);
    expect(r.ok).toBe(true);
    expect(centred).toBe(2);
    // never: the cell stays open and is reported from the feet
    const r2 = await seal({ ...deps, solid: () => false, place: (p: Vec3) => Promise.resolve({ ok: !(p.x === 11 && p.y === -60) }) }, () => false);
    expect(r2.ok).toBe(false);
    expect(r2.openCells).toEqual([{ x: 1, y: 0, z: 0 }]);
  });
});

describe('the dig-in (no blocks: a hole under the feet, roofed with a dug block)', () => {
  const me: Vec3 = { x: 10.5, y: -60, z: 20.5 };
  // a flat world: grass at -61, dirt at -62 and -63, bedrock at -64; air from -60 up
  const flat = (y: number): string => (y === -61 ? 'grass_block' : y >= -63 && y <= -62 ? 'dirt' : y === -64 ? 'bedrock' : 'air');

  it('three cells straight down when they are dirt-like with solid walls and a floor', () => {
    const solid = (_x: number, y: number) => y <= -61;
    expect(digInCells(me, solid, (_x, y) => flat(y))).toEqual([
      { x: 10, y: -61, z: 20 },
      { x: 10, y: -62, z: 20 },
      { x: 10, y: -63, z: 20 },
    ]);
  });

  it('never in stone, sand or gravel, over a hole or next to a cave', () => {
    const solid = (_x: number, y: number) => y <= -61;
    expect(digInCells(me, solid, (_x, y) => (y === -62 ? 'stone' : flat(y)))).toBeUndefined();
    expect(digInCells(me, solid, (_x, y) => (y === -61 ? 'sand' : flat(y)))).toBeUndefined();
    expect(digInCells(me, solid, (_x, y) => (y === -63 ? 'gravel' : flat(y)))).toBeUndefined();
    expect(digInCells(me, (_x, y) => y <= -61 && y !== -64, (_x, y) => flat(y))).toBeUndefined(); // no floor
    expect(digInCells(me, (x, y) => y <= -61 && !(x === 11 && y === -63), (_x, y) => flat(y))).toBeUndefined(); // a cave at the feet
    expect(digInCells(me, solid, () => undefined)).toBeUndefined(); // not loaded
  });

  it('seal(): without blocks it digs in and roofs the hole with the dirt it dug', async () => {
    let pos: Vec3 = { ...me };
    const dug = new Set<string>();
    const held: ItemStack[] = [];
    const placed: Vec3[] = [];
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const solid = (x: number, y: number, z: number) => (placed.some((p) => p.x === x && p.y === y && p.z === z) ? true : y <= -61 && !dug.has(key(x, y, z)));
    const r = await seal(
      {
        place: (p, o) => {
          expect(o.item).toEqual(['dirt']);
          placed.push(p);
          return Promise.resolve({ ok: true });
        },
        dig: (p) => {
          dug.add(key(p.x, p.y, p.z));
          pos = { ...pos, y: p.y };
          held.splice(0, 1, stack('dirt', (held[0]?.count ?? 0) + 1));
          return Promise.resolve({ ok: true });
        },
        solid,
        position: () => pos,
        threats: () => [],
        slots: () => held,
        block: (x, y, z) => (dug.has(key(x, y, z)) ? 'air' : flat(y)),
        settle: () => Promise.resolve(),
      },
      () => false,
    );
    expect(r).toMatchObject({ ok: true, dugIn: true });
    expect(pos.y).toBe(-63);
    expect(placed).toEqual([{ x: 10, y: -61, z: 20 }]);
    expect(canSealHere({ solid: () => false, position: () => me, slots: () => [], block: () => 'dirt' })).toBe(false);
  });

  it('seal(): knocked onto the edge as the first cell goes, the body walks into the hole and the rest is dug under it', async () => {
    let pos: Vec3 = { ...me };
    const dug = new Set<string>();
    const held: ItemStack[] = [];
    const placed: Vec3[] = [];
    const digs: Vec3[] = [];
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const solid = (x: number, y: number, z: number) => (placed.some((p) => p.x === x && p.y === y && p.z === z) ? true : y <= -61 && !dug.has(key(x, y, z)));
    let first = true;
    const fallCalls: boolean[] = [];
    const r = await seal(
      {
        place: (p) => {
          placed.push(p);
          return Promise.resolve({ ok: true });
        },
        dig: (p) => {
          digs.push(p);
          dug.add(key(p.x, p.y, p.z));
          held.splice(0, 1, stack('dirt', (held[0]?.count ?? 0) + 1));
          if (first) {
            // an arrow: the body is on the next cell's edge and stays up
            first = false;
            pos = { x: 11.1, y: -60, z: 20.5 };
          } else pos = { ...pos, y: p.y };
          return Promise.resolve({ ok: true });
        },
        solid,
        position: () => pos,
        threats: () => [],
        slots: () => held,
        block: (x, y, z) => (dug.has(key(x, y, z)) ? 'air' : flat(y)),
        settle: () => Promise.resolve(),
        centre: (cell, o) => {
          fallCalls.push(o?.fall === true);
          pos = o?.fall ? { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 } : { x: cell.x + 0.5, y: pos.y, z: cell.z + 0.5 };
          return Promise.resolve(true);
        },
      },
      () => false,
    );
    expect(r).toMatchObject({ ok: true, dugIn: true });
    expect(fallCalls).toEqual([false, true]);
    expect(digs.map((d) => `${d.x} ${d.y} ${d.z}`)).toEqual(['10 -61 20', '10 -62 20', '10 -63 20']);
    expect(pos.y).toBe(-63);
    expect(placed).toEqual([{ x: 10, y: -61, z: 20 }]);
  });
});

describe('the per-mob rules (PveController)', () => {
  function setup(health: number) {
    const src = new FakeSource();
    const loop = new FakeLoop();
    const ents = new Map<bigint, EntityInfo>();
    const inventory = new Inventory(() => null, () => 1n);
    const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health } }, loop, skills: Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) }), home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
    pve.settings.set('mobReflex', false); // each rule without the reflex unless the case turns it on (on by default since Track M2)
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health });
    const blade = () => inventory.setItem(0, 0, stack('netherite_sword', 1));
    return { ents, pve, me: loop.pos, blade };
  }

  it('with a blade, up to two archers alone are a duel (closed in on); a third, or a zombie with them, is not; bare, never', () => {
    const s = setup(14);
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: s.me.x + 8, y: s.me.y, z: s.me.z }));
    expect(s.pve.canDuel(s.me)).toBe(false); // bare: a fist needs about 20 hits
    s.blade();
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: s.me.x + 8, y: s.me.y, z: s.me.z }));
    expect(s.pve.canDuel(s.me)).toBe(true);
    s.ents.set(8n, mob(8n, 'minecraft:stray', { x: s.me.x - 8, y: s.me.y, z: s.me.z }));
    expect(s.pve.canDuel(s.me)).toBe(true);
    s.ents.set(9n, mob(9n, 'minecraft:skeleton', { x: s.me.x, y: s.me.y, z: s.me.z + 8 }));
    expect(s.pve.canDuel(s.me)).toBe(false);
    s.ents.delete(9n);
    s.ents.set(10n, mob(10n, 'minecraft:zombie', { x: s.me.x, y: s.me.y, z: s.me.z + 8 }));
    expect(s.pve.canDuel(s.me)).toBe(false);
  });

  it('Track M2: the elytra flee hands the body to the takeoff: guard and the flee stand down while the trip lives, at most FLY_HANDOVER_MS', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const s = setup(7);
      s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: s.me.x + 1.5, y: s.me.y, z: s.me.z }));
      const guard = (s.pve as unknown as { guardProcess: { wants(): boolean } }).guardProcess;
      expect(guard.wants()).toBe(true);
      s.pve.startFlyHandover();
      expect(s.pve.flyHandover()).toBe(true); // its first second: the trip may not be listed yet
      expect(guard.wants()).toBe(false);
      vi.advanceTimersByTime(1500);
      expect(s.pve.flyHandover()).toBe(false); // no `fly` process: the send came to nothing
      // a live trip holds it until FLY_HANDOVER_MS
      const trip = { name: 'fly', done: false };
      const pm = (s.pve as unknown as { processes: { find(n: string): unknown[] } }).processes;
      const find = pm.find.bind(pm);
      pm.find = (n: string) => (n === 'fly' ? [trip] : find(n));
      expect(s.pve.flyHandover()).toBe(true);
      expect(guard.wants()).toBe(false);
      trip.done = true;
      expect(s.pve.flyHandover()).toBe(false);
      trip.done = false;
      vi.advanceTimersByTime(FLY_HANDOVER_MS);
      expect(s.pve.flyHandover()).toBe(false);
      expect(guard.wants()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Track M2: the witch 8 under the bot (a hillside) is a target; written off as unreachable, fought again after FIRST_RETRY_MS', () => {
    const s = setup(16);
    s.blade();
    const w = mob(8n, 'minecraft:witch', { x: s.me.x + 3, y: s.me.y - 8, z: s.me.z });
    s.ents.set(8n, w);
    expect(s.pve.pickThreat(s.me, false)?.e.runtimeId).toBe(8n);
    // a zombie there is not (MAX_DY)
    s.ents.delete(8n);
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: s.me.x + 3, y: s.me.y - 8, z: s.me.z }));
    expect(s.pve.pickThreat(s.me, false)).toBeUndefined();
    s.ents.delete(9n);
    s.ents.set(8n, w);
    // the fight's verdict `unreachable`: ignored for a moment, then fought again
    const note = (at: number) => {
      s.pve.ignore.set(8n, performance.now() + 60_000);
      s.pve.ignoreWhy.set(8n, { reason: 'fight unreachable', at, type: w.type });
    };
    note(performance.now() - 1000);
    expect(s.pve.pickThreat(s.me, false)).toBeUndefined();
    note(performance.now() - FIRST_RETRY_MS - 100);
    expect(s.pve.pickThreat(s.me, false)?.e.runtimeId).toBe(8n);
    expect(FIRST_MAX_DY).toBeGreaterThanOrEqual(8);
  });

  it('the witch first with a blade at 8 health or more, within 12, the way to her clear of other melee mobs', () => {
    const s = setup(12);
    const w = mob(8n, 'minecraft:witch', { x: s.me.x + 7, y: s.me.y, z: s.me.z });
    s.ents.set(8n, w);
    expect(s.pve.firstTarget(w, s.me)).toBe(false); // bare
    s.blade();
    expect(s.pve.firstTarget(w, s.me)).toBe(true);
    // a zombie on the way (4.5 out, 1 off the line): not first
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: s.me.x + 4.5, y: s.me.y, z: s.me.z + 1 }));
    expect(s.pve.firstTarget(w, s.me)).toBe(false);
    // Track M2: with the reflex on the zombie on the way is struck in passing: she is first
    s.pve.settings.set('mobReflex', true);
    expect(s.pve.firstTarget(w, s.me)).toBe(true);
    s.pve.settings.set('mobReflex', false);
    // next to the bot it is the reflex's, not on the way
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: s.me.x + 1.5, y: s.me.y, z: s.me.z }));
    expect(s.pve.firstTarget(w, s.me)).toBe(true);
    const far = mob(10n, 'minecraft:witch', { x: s.me.x - 13, y: s.me.y, z: s.me.z });
    expect(s.pve.firstTarget(far, s.me)).toBe(false);
    // at low health: within her throw range (8) still first (a run does not get out of it), farther not
    const low = setup(7);
    low.blade();
    low.ents.set(8n, w);
    expect(low.pve.firstTarget(w, low.me)).toBe(true);
    const w10 = mob(12n, 'minecraft:witch', { x: low.me.x + 10, y: low.me.y, z: low.me.z });
    low.ents.delete(8n);
    low.ents.set(12n, w10);
    expect(low.pve.firstTarget(w10, low.me)).toBe(false);
    // just after her throw (a splash potion seen next to her): first at any health within 12, for WITCH_WINDOW_MS
    low.ents.set(20n, mob(20n, 'minecraft:splash_potion', { x: low.me.x + 10, y: low.me.y + 1.5, z: low.me.z }));
    (low.pve as unknown as { noteWitchThrows(): void }).noteWitchThrows();
    expect(low.pve.witchJustThrew(12n)).toBe(true);
    expect(low.pve.firstTarget(w10, low.me)).toBe(true);
    const w11 = mob(11n, 'minecraft:witch', { x: low.me.x - 11, y: low.me.y, z: low.me.z });
    expect(low.pve.firstTarget(w11, low.me)).toBe(false); // she did not throw
  });

  it('guard collects the drops only with no other hostile within 16 (the one just killed left out)', () => {
    const s = setup(20);
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: s.me.x + 2, y: s.me.y, z: s.me.z }));
    expect(s.pve.otherThreatWithin(s.me, 16, 7n)).toBe(false);
    s.ents.set(8n, mob(8n, 'minecraft:witch', { x: s.me.x + 4.5, y: s.me.y, z: s.me.z }));
    expect(s.pve.otherThreatWithin(s.me, 16, 7n)).toBe(true);
    s.ents.set(8n, mob(8n, 'minecraft:witch', { x: s.me.x + 17, y: s.me.y, z: s.me.z }));
    expect(s.pve.otherThreatWithin(s.me, 16, 7n)).toBe(false);
  });

  it('guard: the witch first is approached even in place (low health), and not left alone after an out-of-range fight', () => {
    const s = setup(5);
    s.blade();
    const w = mob(8n, 'minecraft:witch', { x: s.me.x + 6, y: s.me.y, z: s.me.z });
    s.ents.set(8n, w);
    const p = s.pve.pickThreat(s.me, true);
    expect(p?.e.runtimeId).toBe(8n);
    expect(p?.inPlace).toBe(false);
    // ignored after a fight that ended out of range: picked again
    s.pve.ignore.set(8n, performance.now() + 10_000);
    s.pve.ignoreWhy.set(8n, { reason: 'fight out_of_range', at: performance.now(), type: w.type });
    expect(s.pve.pickThreat(s.me, false)?.e.runtimeId).toBe(8n);
    // a path verdict holds
    s.pve.ignore.set(8n, performance.now() + 10_000);
    s.pve.ignoreWhy.set(8n, { reason: 'no path', at: performance.now(), type: w.type });
    expect(s.pve.pickThreat(s.me, false)).toBeUndefined();
  });

  it('under 3 shooters with the shell possible, critical from 14 health with a hit in the last 3 s; the defaults unchanged', () => {
    const src = new FakeSource();
    const loop = new FakeLoop();
    loop.pos = { x: 0.5, y: -60, z: 0.5 };
    const ents = new Map<bigint, EntityInfo>();
    const inventory = new Inventory(() => null, () => 1n);
    inventory.setItem(0, 0, stack('cobblestone', 32));
    const mover = Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }), place: () => Promise.resolve({ ok: true }), dig: () => Promise.resolve({ ok: true }) });
    Object.assign(mover.nav, { grid: new FlatGrid() });
    const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health: 12 } }, loop, skills: mover, home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: false, radius: 16 } } });
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health: 12 });
    for (const [i, dx, dz] of [[7n, 10, 0], [8n, -10, 0], [9n, 0, 10]] as const) ents.set(i, mob(i, 'minecraft:skeleton', { x: 0.5 + dx, y: -60, z: 0.5 + dz }));
    (pve as unknown as { recentHits: { damage: number; at: number }[] }).recentHits.push({ damage: 4, at: performance.now() });
    const me = { x: 0.5, y: -60, z: 0.5 };
    expect(pve.shootersWithin(me, 16)).toBe(3);
    expect(pve.critical(me)).toBe(false); // sealIn off (the default): as before (12 > 8)
    pve.settings.set('sealIn', true);
    expect(pve.critical(me)).toBe(true);
    ents.delete(9n);
    expect(pve.critical(me)).toBe(false); // 2 shooters
    pve.dispose();
  });

  it('the potion side step: with the keys free, at right angles to a potion coming at the bot, released after it', () => {
    const src = new FakeSource();
    const loop = new FakeLoop();
    loop.pos = { x: 0.5, y: -60, z: 0.5 };
    const ents = new Map<bigint, EntityInfo>();
    const inventory = new Inventory(() => null, () => 1n);
    const mover = Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) });
    Object.assign(mover.nav, { grid: new FlatGrid() });
    const pve = new PveController({ source: src, world: { entities: ents, inventory, self: { runtimeId: 1n, health: 20 } }, loop, skills: mover, home: () => undefined, shelter: () => undefined, inactive: () => false, options: { guard: { on: false, radius: 16 } } });
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health: 20 });
    pve.settings.set('mobReflex', true); // the side step comes with the reflex
    // a potion going away from the bot: nothing
    ents.set(30n, mob(30n, 'minecraft:splash_potion', { x: 6.5, y: -58, z: 0.5 }, { vel: { x: 0.5, y: 0, z: 0 } }));
    loop.step();
    expect(pve.potionSteps).toBe(0);
    // one coming at it along -x: a sprint along z
    ents.set(31n, mob(31n, 'minecraft:splash_potion', { x: 6.5, y: -58, z: 0.5 }, { vel: { x: -0.5, y: -0.1, z: 0 } }));
    loop.step();
    expect(pve.potionSteps).toBe(1);
    expect(loop.cmd.forward).toBe(1);
    expect(loop.cmd.sprint).toBe(true);
    expect(Math.abs(Math.cos((loop.cmd.yaw * Math.PI) / 180))).toBeGreaterThan(0.99); // yaw 0 or 180: along z
    // the same potion is not stepped for twice; gone: released
    ents.delete(31n);
    loop.step();
    expect(loop.cmd.forward).toBe(0);
    expect(pve.potionSteps).toBe(1);
    // no velocity on the entity (a projectile's is not kept up): its motion between two ticks
    for (let i = 0; i < 13; i++) loop.step(); // the step is over
    ents.set(33n, mob(33n, 'minecraft:splash_potion', { x: 0.5, y: -58, z: 8.5 }));
    loop.step();
    expect(pve.potionSteps).toBe(1); // standing still: not coming
    ents.set(33n, mob(33n, 'minecraft:splash_potion', { x: 0.5, y: -57.8, z: 8.1 }));
    loop.step();
    expect(pve.potionSteps).toBe(2);
    expect(Math.abs(Math.sin((loop.cmd.yaw * Math.PI) / 180))).toBeGreaterThan(0.99); // along x
    ents.delete(33n);
    for (let i = 0; i < 13; i++) loop.step();
    // Track M2: guard fighting the witch: no step (the approach keeps the keys); fighting a zombie: the step as before
    const pm = (pve as unknown as { processes: object }).processes;
    const activeOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pm), 'active');
    Object.defineProperty(pm, 'active', { configurable: true, get: () => pve.guardProcess });
    let fighting: string | undefined = 'witch';
    Object.defineProperty(pve.guardProcess, 'fighting', { configurable: true, get: () => fighting });
    ents.set(34n, mob(34n, 'minecraft:splash_potion', { x: 6.5, y: -58, z: 0.5 }, { vel: { x: -0.5, y: -0.1, z: 0 } }));
    loop.step();
    expect(pve.potionSteps).toBe(2);
    ents.delete(34n);
    fighting = 'zombie';
    ents.set(35n, mob(35n, 'minecraft:splash_potion', { x: 6.5, y: -58, z: 0.5 }, { vel: { x: -0.5, y: -0.1, z: 0 } }));
    loop.step();
    expect(pve.potionSteps).toBe(3);
    ents.delete(35n);
    loop.step();
    if (activeOf) delete (pm as { active?: unknown }).active;
    // the reflex off: nothing
    pve.settings.set('mobReflex', false);
    ents.set(32n, mob(32n, 'minecraft:splash_potion', { x: 6.5, y: -58, z: 0.5 }, { vel: { x: -0.5, y: -0.1, z: 0 } }));
    loop.step();
    expect(pve.potionSteps).toBe(3);
    pve.dispose();
  });

  it('the dodge: only with mobDodge on, no blade, a shooter within 16 and no melee mob within 6', () => {
    const s = setup(20);
    s.ents.set(7n, mob(7n, 'minecraft:skeleton', { x: s.me.x + 10, y: s.me.y, z: s.me.z }));
    expect(s.pve.dodgeShooters(s.me)).toHaveLength(0); // off by default
    s.pve.settings.set('mobDodge', true);
    const shooters = s.pve.dodgeShooters(s.me);
    expect(shooters).toHaveLength(1);
    expect(shooters[0]!.kind).toBe('archer');
    expect(shooters[0]!.pos.x).toBe(s.me.x + 10);
    expect(s.pve.fleeReason(s.me)?.threat.runtimeId).toBe(7n); // at full health: the flight (the dodge in it)
    s.ents.set(9n, mob(9n, 'minecraft:zombie', { x: s.me.x + 4, y: s.me.y, z: s.me.z }));
    expect(s.pve.dodgeShooters(s.me)).toHaveLength(0);
    s.ents.delete(9n);
    s.blade();
    expect(s.pve.dodgeShooters(s.me)).toHaveLength(0);
  });

  it('no bite in a ranged mob\'s range: the eat clearance is 0 while one is within 16', () => {
    const s = setup(10);
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: s.me.x + 10, y: s.me.y, z: s.me.z }));
    expect(s.pve.eatClearance(s.me, 10)).toBe(10);
    s.ents.set(8n, mob(8n, 'minecraft:witch', { x: s.me.x + 14, y: s.me.y, z: s.me.z }));
    expect(s.pve.eatClearance(s.me, 10)).toBe(0);
  });

  it('Track M2: holding the ground: with the reflex on, low health and up to 3 melee mobs it stands instead of running', () => {
    const s = setup(4);
    s.ents.set(7n, mob(7n, 'minecraft:zombie', { x: s.me.x + 3, y: s.me.y, z: s.me.z }));
    expect(s.pve.fleeReason(s.me)?.threat.runtimeId).toBe(7n); // the reflex off (the default): the flight as before
    s.pve.settings.set('mobReflex', true);
    expect(s.pve.holds(s.me)).toBe(true);
    expect(s.pve.fleeReason(s.me)).toBeUndefined();
    // three melee mobs (the reflex strikes 3 a tick): still; a fourth: run
    s.ents.set(8n, mob(8n, 'minecraft:husk', { x: s.me.x - 3, y: s.me.y, z: s.me.z }));
    s.ents.set(9n, mob(9n, 'minecraft:spider', { x: s.me.x, y: s.me.y, z: s.me.z + 3 }));
    expect(s.pve.fleeReason(s.me)).toBeUndefined();
    s.ents.set(10n, mob(10n, 'minecraft:zombie', { x: s.me.x, y: s.me.y, z: s.me.z - 3 }));
    expect(s.pve.holds(s.me)).toBe(false);
    expect(s.pve.fleeReason(s.me)).toBeDefined();
    s.ents.delete(10n);
    // a creeper within 8 or a skeleton in sight within 16: a stand does not answer them
    s.ents.set(11n, mob(11n, 'minecraft:creeper', { x: s.me.x + 6, y: s.me.y, z: s.me.z }));
    expect(s.pve.holds(s.me)).toBe(false);
    s.ents.delete(11n);
    s.ents.set(12n, mob(12n, 'minecraft:skeleton', { x: s.me.x + 12, y: s.me.y, z: s.me.z }));
    expect(s.pve.holds(s.me)).toBe(false);
    s.ents.delete(12n);
    expect(s.pve.holds(s.me)).toBe(true);
    // two melee hits within 3 s: the fist is not holding them, run
    const times = (s.pve as unknown as { meleeHitTimes: number[] }).meleeHitTimes;
    times.push(performance.now() - 500, performance.now() - 100);
    expect(s.pve.holds(s.me)).toBe(false);
    expect(s.pve.fleeReason(s.me)).toBeDefined();
    times.splice(0);
    times.push(performance.now() - 100);
    expect(s.pve.holds(s.me)).toBe(true); // one hit (it is why the health is low): stand
  });

  it('Track M2: holdGround, the pure rule', () => {
    const h = (o: Partial<HoldInput>) => holdGround({ reflex: true, melee: 1, other: false, meleeHits: 0, ...o });
    expect(h({})).toBe(true);
    expect(h({ reflex: false })).toBe(false);
    expect(h({ melee: 0 })).toBe(false);
    expect(h({ melee: HOLD_MAX })).toBe(true);
    expect(h({ melee: HOLD_MAX + 1 })).toBe(false);
    expect(h({ other: true })).toBe(false);
    expect(h({ meleeHits: 1 })).toBe(true);
    expect(h({ meleeHits: 2 })).toBe(false);
  });

  it('a witch within 16 starts a flight below 14 health (above fleeHealth)', () => {
    const s = setup(12);
    s.ents.set(8n, mob(8n, 'minecraft:witch', { x: s.me.x + 10, y: s.me.y, z: s.me.z }));
    expect(s.pve.fleeReason(s.me)?.threat.runtimeId).toBe(8n);
    const t = setup(16);
    t.ents.set(8n, mob(8n, 'minecraft:witch', { x: t.me.x + 10, y: t.me.y, z: t.me.z }));
    expect(t.pve.fleeReason(t.me)).toBeUndefined();
  });
});

describe('the Track M1 settings', () => {
  it('mobReflex on by default (Track M2: ADR 0079 decision 26), fleeFly, sealIn and mobDodge off; each in a help group', () => {
    const s = new RuntimeSettings();
    expect(s.get('mobReflex')).toBe(true);
    expect(s.get('fleeFly')).toBe(false);
    expect(s.get('sealIn')).toBe(false);
    expect(s.get('mobDodge')).toBe(false);
    const grouped = SETTING_GROUPS.flatMap(([, keys]) => keys);
    for (const k of ['mobReflex', 'fleeFly', 'sealIn', 'mobDodge']) expect(grouped).toContain(k);
  });
});

describe('Track M2: eat before the food stops the sprint', () => {
  it('the automatic bite goes in during a walk from food 10 down (6 before), or below health 10', () => {
    expect(EAT_BEFORE_SPRINT_LOST).toBeGreaterThanOrEqual(7); // below 7 the body cannot sprint
    expect(FOOD_SPRINT_EAT).toBe(EAT_BEFORE_SPRINT_LOST);
    expect(eatWhileWalking(10, 20)).toBe(true);
    expect(eatWhileWalking(7, 20)).toBe(true);
    expect(eatWhileWalking(11, 20)).toBe(false);
    expect(eatWhileWalking(17, 9.5)).toBe(true);
    expect(eatWhileWalking(17, 10)).toBe(false);
  });
});
