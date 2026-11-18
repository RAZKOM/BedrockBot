// Track M10 (docs/pve.md "Track M10: after the flight", ADR 0079 addendum): the guard tests for this track's rules.
import { describe, expect, it, vi } from 'vitest';
import { BACK_HOME_ARM, backHomeBlock, PveController, PVE_RULES_DEFAULT } from '../../../src/tasks/pve.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const F = -60;

function controller(health: number, home: Vec3 | undefined) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const ents = new Map<bigint, EntityInfo>();
  const mover = Object.assign(new FakeMover(), { collect: () => Promise.resolve({ ok: true }) });
  const self = { runtimeId: 1n, health, food: 20 };
  const pve = new PveController({ source: src, world: { entities: ents, inventory: new Inventory(() => null, () => 1n), self }, loop, skills: mover, home: () => home, shelter: () => undefined, inactive: () => false, options: { guard: { on: true, radius: 16 } } });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health });
  pve.settings.set('mobReflex', false);
  return { src, loop, ents, pve, mover, self };
}

const homeWalks = (m: FakeMover): number => m.gotos.filter((g) => (g.goal.type as string) === 'block' && (g.goal as unknown as { p: Vec3 }).p.x === 0 && (g.goal as unknown as { p: Vec3 }).p.z === 0).length;

/**
 * A flight from a pillager that starts at `start` with home at 0 0; the flight then ends at `out` (the minute is up) with
 * whatever `after` leaves in the world, and the loop runs on a second.
 */
function flightThenIdle(on: boolean, start: Vec3, out: Vec3, after: (ents: Map<bigint, EntityInfo>) => void) {
  const s = controller(20, { x: 0, y: F, z: 0 });
  s.pve.rules.backHome = on;
  s.loop.pos = start;
  s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: start.x + 9, y: F, z: start.z }));
  s.pve.setGuard({ on: true, radius: 16 });
  s.loop.step(30);
  expect(s.pve.processes.active?.name).toBe('flee');
  s.loop.pos = out;
  s.ents.delete(8n);
  after(s.ents);
  const t = performance.now();
  const spy = vi.spyOn(performance, 'now').mockReturnValue(t + 61_000); // past FLEE_MAX_MS: the flight gives up
  s.loop.step(6);
  spy.mockReturnValue(t + 64_000);
  s.loop.step(30);
  spy.mockRestore();
  return s;
}

describe('home ahead of a following archer (followHome)', () => {
  it('is off by default; on, the flight runs home with the pillager behind and closes the doors on the way; off, no home leg while it follows', () => {
    expect(PVE_RULES_DEFAULT.followHome).toBe(false);
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.followHome = on;
      s.loop.pos = { x: 30.5, y: F, z: 0.5 };
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 42.5, y: F, z: 1.5 }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(30);
      expect(s.pve.processes.active?.name).toBe('flee');
      const t = performance.now();
      const spy = vi.spyOn(performance, 'now');
      for (const dt of [3000, 6000, 9000]) {
        spy.mockReturnValue(t + dt);
        s.mover.finish({ ok: false, reason: 'interrupted' });
        s.loop.step(10);
      }
      spy.mockRestore();
      const i = s.mover.gotos.findIndex((g) => (g.goal.type as string) === 'block');
      if (!on) expect(i).toBe(-1);
      else {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(s.mover.gotoOpts[i]?.closeDoors).toBe(true);
      }
      s.pve.dispose();
    }
  });

  it('not with the pillager between the bot and home', () => {
    expect(
      ((): boolean => {
        const s = controller(20, { x: 0, y: F, z: 0 });
        s.pve.rules.followHome = true;
        s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 18.5, y: F, z: 1.5 }));
        const r = s.pve.homeAhead({ x: 30.5, y: F, z: 0.5 }, { x: 0, y: F, z: 0 });
        s.pve.dispose();
        return r;
      })(),
    ).toBe(false);
    const s = controller(20, { x: 0, y: F, z: 0 });
    expect(s.pve.homeAhead({ x: 30.5, y: F, z: 0.5 }, { x: 0, y: F, z: 0 })).toBe(false); // no archer known: nothing to be ahead of
    s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 42.5, y: F, z: 1.5 }));
    expect(s.pve.homeAhead({ x: 30.5, y: F, z: 0.5 }, { x: 0, y: F, z: 0 })).toBe(true);
    s.pve.dispose();
  });

  it('guard does not chase an archer with a fist (on); off, it does', () => {
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.followHome = on;
      s.pve.rules.bareArcher = false; // the archer out of the flight's reach: only guard looks at it
      s.loop.pos = { x: 0.5, y: F, z: 0.5 };
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 10.5, y: F, z: 0.5 }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(10);
      expect(s.pve.processes.active?.name === 'guard').toBe(!on);
      s.pve.dispose();
    }
  });
});

describe('home again after a flight (backHome)', () => {
  it('backHomeBlock: a melee mob within 24 of the bot, an archer or a witch within 16 of it, of home or of the way, else clear', () => {
    const clear = { melee: 0, shooter: false, homeShot: false, wayShot: false };
    expect(backHomeBlock(clear)).toBeUndefined();
    expect(backHomeBlock({ ...clear, melee: 1 })).toMatch(/hostile within 24/);
    expect(backHomeBlock({ ...clear, shooter: true })).toMatch(/within 16$/);
    expect(backHomeBlock({ ...clear, homeShot: true })).toMatch(/of home/);
    expect(backHomeBlock({ ...clear, wayShot: true })).toMatch(/way home/);
  });

  it('is on by default; on, a flight from near home that ends with nothing near walks home; off, the bot stays out', () => {
    expect(PVE_RULES_DEFAULT.backHome).toBe(true);
    for (const on of [false, true]) {
      const s = flightThenIdle(on, { x: 6.5, y: F, z: 0.5 }, { x: 80.5, y: F, z: 0.5 }, () => undefined);
      expect(homeWalks(s.mover)).toBe(on ? 1 : 0);
      if (on) expect(s.pve.processes.active?.name).toBe('home');
      s.pve.dispose();
    }
  });

  it('waits while an archer stands near home, and walks once it is gone', () => {
    const s = flightThenIdle(true, { x: 6.5, y: F, z: 0.5 }, { x: 80.5, y: F, z: 0.5 }, (ents) => ents.set(9n, mob(9n, 'minecraft:skeleton', { x: 5.5, y: F, z: 3.5 })));
    expect(homeWalks(s.mover)).toBe(0);
    s.ents.delete(9n);
    s.loop.step(20);
    // gone while 75 off: remembered at its last place for SHOOTER_MEMORY_MS (it may only be out of the server's range)
    expect(homeWalks(s.mover)).toBe(0);
    const spy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 130_000);
    s.loop.step(20);
    spy.mockRestore();
    expect(homeWalks(s.mover)).toBe(1);
    s.pve.dispose();
  });

  it('waits while a hostile is within 24 of the bot (seen or not)', () => {
    const s = flightThenIdle(true, { x: 6.5, y: F, z: 0.5 }, { x: 80.5, y: F, z: 0.5 }, (ents) => ents.set(9n, mob(9n, 'minecraft:zombie', { x: 100.5, y: F, z: 0.5 })));
    expect(homeWalks(s.mover)).toBe(0);
    s.pve.dispose();
  });

  it(`a flight that starts more than ${BACK_HOME_ARM} from home does not arm it`, () => {
    const start = { x: BACK_HOME_ARM + 10.5, y: F, z: 0.5 };
    const s = flightThenIdle(true, start, { x: 150.5, y: F, z: 0.5 }, () => undefined);
    expect(homeWalks(s.mover)).toBe(0);
    s.pve.dispose();
  });

  it('an archer 20 off to the side of the way does not hold the walk', () => {
    const s = flightThenIdle(true, { x: 6.5, y: F, z: 0.5 }, { x: 80.5, y: F, z: 0.5 }, (ents) => ents.set(9n, mob(9n, 'minecraft:skeleton', { x: 70.5, y: F, z: 20.5 })));
    expect(homeWalks(s.mover)).toBe(1);
    s.pve.dispose();
  });

  it('a flight that starts on the home point arms it (its start is not "home again"); a skeleton 30 off and away from the way does not hold the walk', () => {
    const s = controller(20, { x: 0, y: F, z: 0 });
    s.pve.rules.backHome = true;
    s.loop.pos = { x: 0.5, y: F, z: 0.5 };
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: 7.5, y: F, z: 0.5 }));
    s.pve.setGuard({ on: true, radius: 16 });
    s.loop.step(30);
    expect(s.pve.processes.active?.name).toBe('flee');
    expect(s.pve.backHomeArmed).toBeDefined();
    s.loop.pos = { x: 57.5, y: F, z: 0.5 };
    s.ents.set(8n, mob(8n, 'minecraft:skeleton', { x: 30.5, y: F, z: 30.5 }));
    const t = performance.now();
    const spy = vi.spyOn(performance, 'now');
    for (let dt = 61_000; dt < 66_000; dt += 500) {
      spy.mockReturnValue(t + dt);
      s.mover.finish({ ok: false, reason: 'interrupted' });
      s.loop.step(10);
    }
    spy.mockRestore();
    expect(s.pve.processes.active?.name).toBe('home');
    expect(s.pve.backHomes).toBe(1);
    s.pve.dispose();
  });

  it('a blade carried: not armed (the kits with a blade are untouched)', () => {
    const s = controller(20, { x: 0, y: F, z: 0 });
    s.pve.rules.backHome = true;
    vi.spyOn(s.pve, 'carriesBlade').mockReturnValue(true);
    s.pve.noteFlightStart({ x: 6.5, y: F, z: 0.5 });
    expect(s.pve.backHomeArmed).toBeUndefined();
    s.pve.dispose();
  });

  it('in the flight: no home leg past an archer that stands on the way home, beyond 24 (on); off, the leg goes home', () => {
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.backHome = on;
      s.pve.rules.followRun = false; // its way check (archerNearWay) keeps this leg out too: backHome's own A/B
      s.loop.pos = { x: 6.5, y: F, z: 0.5 };
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 15.5, y: F, z: 0.5 }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(30);
      expect(s.pve.processes.active?.name).toBe('flee');
      // 60 out; a skeleton 26 off, between the bot and home
      s.loop.pos = { x: 60.5, y: F, z: 0.5 };
      s.ents.delete(8n);
      s.ents.set(9n, mob(9n, 'minecraft:skeleton', { x: 34.5, y: F, z: 2.5 }));
      const t = performance.now();
      const spy = vi.spyOn(performance, 'now');
      for (const dt of [3000, 6000, 9000]) {
        spy.mockReturnValue(t + dt);
        s.mover.finish({ ok: false, reason: 'interrupted' });
        s.loop.step(10);
      }
      spy.mockRestore();
      expect(homeWalks(s.mover) > 0).toBe(!on);
      s.pve.dispose();
    }
  });

  it('in the flight: no home leg with a pillager beyond 24 of the bot whose way home passes within 24 of it (18 off the way), on or off', () => {
    for (const on of [false, true]) {
      const s = controller(20, { x: 0, y: F, z: 0 });
      s.pve.rules.backHome = on;
      s.loop.pos = { x: 6.5, y: F, z: 0.5 };
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 15.5, y: F, z: 0.5 }));
      s.pve.setGuard({ on: true, radius: 16 });
      s.loop.step(30);
      expect(s.pve.processes.active?.name).toBe('flee');
      // 60 out; the pillager 24.8 from the bot, behind it towards home and 18 off the way (beyond SHOOTER_WAY's 16)
      s.loop.pos = { x: 60.5, y: F, z: 0.5 };
      s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 43.5, y: F, z: 18.5 }));
      const t = performance.now();
      const spy = vi.spyOn(performance, 'now');
      for (const dt of [3000, 6000, 9000]) {
        spy.mockReturnValue(t + dt);
        s.mover.finish({ ok: false, reason: 'interrupted' });
        s.loop.step(10);
      }
      spy.mockRestore();
      expect(homeWalks(s.mover)).toBe(0);
      s.pve.dispose();
    }
  });

  it('in the flight: the home leg with a pillager beyond 24 whose way home stays beyond 24 of it (off to the side, behind the bot)', () => {
    const s = controller(20, { x: 0, y: F, z: 0 });
    s.pve.rules.backHome = false;
    s.loop.pos = { x: 6.5, y: F, z: 0.5 };
    s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 15.5, y: F, z: 0.5 }));
    s.pve.setGuard({ on: true, radius: 16 });
    s.loop.step(30);
    // 60 out; the pillager 26 off, beyond the bot (away from home): the way home runs from it
    s.loop.pos = { x: 60.5, y: F, z: 0.5 };
    s.ents.set(8n, mob(8n, 'minecraft:pillager', { x: 70.5, y: F, z: 24.5 }));
    const t = performance.now();
    const spy = vi.spyOn(performance, 'now');
    for (const dt of [3000, 6000, 9000]) {
      spy.mockReturnValue(t + dt);
      s.mover.finish({ ok: false, reason: 'interrupted' });
      s.loop.step(10);
    }
    spy.mockRestore();
    expect(homeWalks(s.mover)).toBeGreaterThan(0);
    s.pve.dispose();
  });

  it('a stop or a death disarms it', () => {
    const s = controller(20, { x: 0, y: F, z: 0 });
    s.pve.rules.backHome = true;
    s.pve.noteFlightStart({ x: 6.5, y: F, z: 0.5 });
    expect(s.pve.backHomeArmed).toBeDefined();
    s.pve.stop();
    expect(s.pve.backHomeArmed).toBeUndefined();
    s.pve.noteFlightStart({ x: 6.5, y: F, z: 0.5 });
    s.pve.onDeath();
    expect(s.pve.backHomeArmed).toBeUndefined();
    s.pve.dispose();
  });
});
