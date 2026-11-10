// Track M1 round 2 (docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): the dodge's guard tests on a flat grid.
// Across the shooter's line (never along it), out of a witch's range, a turn only with no shot in the air, never onto a
// cell without a floor or into a wall (the other way, else straight out, else no dodge).
import { describe, expect, it } from 'vitest';
import { dodgeStep, DODGE_FLIP_TICKS, POTION_STEP_TICKS, potionSideStep, safeCell } from '../../../src/skills/combat/dodge.ts';
import type { TerrainClass } from '../../../src/skills/terrain/classify.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { FlatGrid } from './combat-fakes.ts';

const F = -60;
const me: Vec3 = { x: 0.5, y: F, z: 0.5 };
/** The heading of a yaw as a unit vector (yawTowards' inverse: yaw 0 looks along +z). */
const dirOf = (yaw: number) => ({ x: -Math.sin((yaw * Math.PI) / 180), z: Math.cos((yaw * Math.PI) / 180) });

/** A flat grid with holes (no floor) where `holes` says. */
class HoleGrid extends FlatGrid {
  readonly holes = new Set<string>();
  override cls(x: number, y: number, z: number): TerrainClass | undefined {
    if (y === F - 1 && this.holes.has(`${x},${z}`)) return { boxes: [], top: 0, floor: false } as unknown as TerrainClass;
    return super.cls(x, y, z);
  }
}

describe('dodgeStep', () => {
  it('across the line of an archer at 12, drifting a little out of its range', () => {
    const s = dodgeStep({ me, shooters: [{ pos: { x: 12.5, y: F, z: 0.5 }, kind: 'archer' }], dir: 1, inFlight: false, sinceFlip: 0, grid: new FlatGrid() })!;
    const h = dirOf(s.yaw);
    // the line runs along x: the heading is mostly z (across), a little -x (away)
    expect(Math.abs(h.z)).toBeGreaterThan(0.9);
    expect(h.x).toBeLessThan(0);
    expect(s.d).toBeCloseTo(12);
  });

  it('a witch at 11 (inside her 13, an archer in its band): out faster', () => {
    const a = dodgeStep({ me, shooters: [{ pos: { x: 11.5, y: F, z: 0.5 }, kind: 'witch' }], dir: 1, inFlight: false, sinceFlip: 0, grid: new FlatGrid() })!;
    const b = dodgeStep({ me, shooters: [{ pos: { x: 11.5, y: F, z: 0.5 }, kind: 'archer' }], dir: 1, inFlight: false, sinceFlip: 0, grid: new FlatGrid() })!;
    expect(dirOf(a.yaw).x).toBeLessThan(dirOf(b.yaw).x); // more away from her (-x)
  });

  it('several shooters: away from all of them, the heading steady when the nearest changes', () => {
    const g = new FlatGrid();
    const a = { pos: { x: 8.5, y: F, z: 0.5 }, kind: 'archer' as const };
    const b = { pos: { x: 0.5, y: F, z: 8.5 }, kind: 'archer' as const };
    const one = dodgeStep({ me, shooters: [a, b], dir: 1, inFlight: true, sinceFlip: 0, grid: g })!;
    // b a little nearer: the same way (the escape direction is the weighted sum, not the nearest alone)
    const two = dodgeStep({ me, shooters: [a, { ...b, pos: { x: 0.5, y: F, z: 8.3 } }], dir: 1, inFlight: true, sinceFlip: 0, grid: g })!;
    expect(Math.abs(one.yaw - two.yaw)).toBeLessThan(5);
    // within DODGE_CLOSE: mostly away from both (-x and -z)
    const close = dodgeStep({ me, shooters: [{ ...a, pos: { x: 4.5, y: F, z: 0.5 } }, { ...b, pos: { x: 0.5, y: F, z: 4.5 } }], dir: 1, inFlight: true, sinceFlip: 0, grid: g })!;
    const h = dirOf(close.yaw);
    expect(h.x + h.z).toBeLessThan(-0.5);
  });

  it('turns only after DODGE_FLIP_TICKS and never with a shot in the air', () => {
    const sh = [{ pos: { x: 12.5, y: F, z: 0.5 }, kind: 'archer' as const }];
    const g = new FlatGrid();
    expect(dodgeStep({ me, shooters: sh, dir: 1, inFlight: false, sinceFlip: DODGE_FLIP_TICKS - 1, grid: g })!.flipped).toBe(false);
    expect(dodgeStep({ me, shooters: sh, dir: 1, inFlight: true, sinceFlip: DODGE_FLIP_TICKS + 5, grid: g })!.flipped).toBe(false);
    const t = dodgeStep({ me, shooters: sh, dir: 1, inFlight: false, sinceFlip: DODGE_FLIP_TICKS, grid: g })!;
    expect(t.flipped).toBe(true);
    expect(t.dir).toBe(-1);
  });

  it('a wall or a hole on the heading: the other way; both ways shut: straight out; all shut: no dodge', () => {
    const sh = [{ pos: { x: 12.5, y: F, z: 0.5 }, kind: 'archer' as const }];
    const first = dodgeStep({ me, shooters: sh, dir: 1, inFlight: true, sinceFlip: 0, grid: new FlatGrid() })!;
    const side = Math.sign(dirOf(first.yaw).z);
    const g = new HoleGrid();
    // a wall across that side, 2 out
    for (let x = -3; x <= 3; x++) g.add(x, F, side * 2).add(x, F + 1, side * 2);
    const other = dodgeStep({ me, shooters: sh, dir: 1, inFlight: true, sinceFlip: 0, grid: g })!;
    expect(Math.sign(dirOf(other.yaw).z)).toBe(-side);
    expect(other.dir).toBe(-1);
    // holes across the other side too: straight out (away from the archer)
    for (let x = -3; x <= 3; x++) g.holes.add(`${x},${-side * 2}`);
    const out = dodgeStep({ me, shooters: sh, dir: 1, inFlight: true, sinceFlip: 0, grid: g })!;
    expect(dirOf(out.yaw).x).toBeLessThan(-0.99);
    // and a wall behind: nothing safe
    for (let z = -3; z <= 3; z++) g.add(-2, F, z);
    expect(dodgeStep({ me, shooters: sh, dir: 1, inFlight: true, sinceFlip: 0, grid: g })).toBeUndefined();
  });

  it('the potion side step: at right angles to its flight, away from a melee mob, a safe side only', () => {
    const potion = { x: 6.5, y: F + 2, z: 0.5 };
    const vel = { x: -0.5, y: 0, z: 0 }; // along -x at the bot
    const a = potionSideStep({ me, potion, vel, grid: new FlatGrid() })!;
    expect(Math.abs(dirOf(a.yaw).z)).toBeGreaterThan(0.99);
    // a zombie on the +z side: the step goes -z
    const b = potionSideStep({ me, potion, vel, avoid: { x: 0.5, y: F, z: 4.5 }, grid: new FlatGrid() })!;
    expect(dirOf(b.yaw).z).toBeLessThan(-0.99);
    // a hole on the -z side: +z even with the zombie there
    const g = new HoleGrid();
    for (let x = -2; x <= 2; x++) g.holes.add(`${x},-2`);
    const c = potionSideStep({ me, potion, vel, avoid: { x: 0.5, y: F, z: 4.5 }, grid: g })!;
    expect(dirOf(c.yaw).z).toBeGreaterThan(0.99);
    // both sides shut: none
    for (let x = -2; x <= 2; x++) g.add(x, F, 2);
    expect(potionSideStep({ me, potion, vel, grid: g })).toBeUndefined();
    // a potion that hardly moves: at right angles to the line from it
    const d = potionSideStep({ me, potion: { x: 0.5, y: F + 2, z: 6.5 }, vel: { x: 0, y: -0.3, z: 0 }, grid: new FlatGrid() })!;
    expect(Math.abs(dirOf(d.yaw).x)).toBeGreaterThan(0.99);
    expect(POTION_STEP_TICKS).toBe(12);
  });

  it('no grid, no shooter: no dodge; safeCell needs a floor and room for the body', () => {
    expect(dodgeStep({ me, shooters: [], dir: 1, inFlight: false, sinceFlip: 0, grid: new FlatGrid() })).toBeUndefined();
    expect(dodgeStep({ me, shooters: [{ pos: { x: 5, y: F, z: 0 }, kind: 'archer' }], dir: 1, inFlight: false, sinceFlip: 0, grid: undefined })).toBeUndefined();
    const g = new HoleGrid();
    expect(safeCell(g, 3.5, F, 0.5)).toBe(true);
    g.holes.add('3,0');
    expect(safeCell(g, 3.5, F, 0.5)).toBe(false);
    g.add(4, F + 1, 0);
    expect(safeCell(g, 4.5, F, 0.5)).toBe(false);
  });
});
