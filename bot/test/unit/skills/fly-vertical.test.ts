// The vertical takeoff (docs/flight.md "Vertical takeoff"): straight up the open column over the bot when
// the jump takeoff is refused on every heading (a clearing in a forest, a courtyard, a shaft), then the
// usual climb from above. The brain on stepBody, and the choice of the hand-over height (glide.ts
// verticalTakeoff: the open column, the sky check from that height, the simulated climb).
import { describe, expect, it } from 'vitest';
import { FlightBrain } from '../../../src/skills/fly/brain.ts';
import { jumpTakeoff, verticalTakeoff, VERTICAL_SPARE, type SimDeps } from '../../../src/skills/fly/glide.ts';
import { cruiseHeight, onTarget, takeoffSky, type CellQuery, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { flatWorld, GLIDE, IDLE_COMMAND, initialBody, stepBody, withBoxes, type BlockBox, type BlockQuery } from '../../../src/skills/input/index.ts';

const FEET = -60;
const ALL = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180];

function rig(boxes: BlockBox[]) {
  const world: BlockQuery = withBoxes(flatWorld(), boxes);
  const cell: CellQuery = (x, y, z) => world.solidAt(x, y, z);
  const skyTop = (x: number, z: number): number => {
    for (let y = 200; y >= -64; y--) if (world.solidAt(x, y, z)) return y;
    return -64;
  };
  const groundAt = (x: number, z: number, fromY = 200): number => {
    for (let y = Math.floor(fromY); y >= -64; y--) if (world.solidAt(x, y, z)) return y + 1;
    return -63;
  };
  const deps: SimDeps & { cell: CellQuery } = { world, cell, skyTop, groundAt };
  return { world, cell, skyTop, deps };
}

/** A forest `h` high, 40 x 40, with a clearing `r` cells each side of the origin (r 1: 3 x 3, r 0: a 1 x 1 shaft). */
const forest = (h: number, r: number): BlockBox[] => [
  { from: { x: -20, y: FEET, z: -20 }, to: { x: 20, y: FEET + h - 1, z: 20 }, solid: true },
  { from: { x: -r, y: FEET, z: -r }, to: { x: r, y: FEET + h - 1, z: r }, solid: false },
];

describe('the vertical takeoff', () => {
  it('the jump takeoff is refused on every heading in a 3 x 3 clearing of a 20-high forest, and so is the sky check', async () => {
    const { deps, cell } = rig(forest(20, 1));
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const target: LandingTarget = { x: 0.5, z: 300.5, top: FEET, half: 1 };
    const cz = cruiseHeight(from, target, deps.skyTop!, {});
    expect(takeoffSky(from, target, cz.y, 12, cell).ok).toBe(false);
    const jump = await jumpTakeoff(deps, from, target, { cruiseY: cz.y }, 64, ALL);
    expect(jump.yaw).toBeUndefined();
  });

  it('the brain goes straight up the clearing (no drift, no hit), hands over above the canopy and lands 300 away', () => {
    const { world, skyTop } = rig(forest(20, 1));
    const start = { x: 0.5, y: FEET, z: 0.5 };
    const target: LandingTarget = { x: 0.5, z: 300.5, top: FEET, half: 1 };
    const notes: string[] = [];
    const brain = new FlightBrain(target, { cruiseY: Math.max(cruiseHeight(start, target, skyTop, {}).y, FEET + 40), vertical: { top: 22 }, takeoffYaw: 0, groundAt: () => FEET, skyTop, obstacle: (x, y, z) => world.solidAt(x, y, z) === true, seed: 5, note: (m) => notes.push(m) });
    let body = initialBody(start, true);
    let cmd = { ...IDLE_COMMAND };
    let lastFire = -100;
    let hits = 0;
    let drift = 0;
    for (let t = 1; t < 8000; t++) {
      const fb = { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 };
      const out = brain.step({ tick: t, body: fb, yaw: cmd.yaw, pitch: cmd.pitch, rockets: 64, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
      const c = out.control;
      cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide };
      if (c.fire) lastFire = t;
      body = stepBody(body, { ...cmd, ...(c.fire ? { boostStart: GLIDE.boostTicks } : {}) }, world).state;
      if (brain.phase === 'takeoff') drift = Math.max(drift, Math.hypot(body.pos.x - 0.5, body.pos.z - 0.5));
      if (body.gliding && (body.collidedHorizontally || (body.collidedVertically && !body.onGround))) hits++;
      if (out.end) {
        expect(out.end.ok).toBe(true);
        expect(onTarget(target, body.pos)).toBe(true);
        break;
      }
    }
    expect(hits).toBe(0);
    expect(drift).toBeLessThan(0.3);
    expect(brain.stats.verticalTop).toBeGreaterThanOrEqual(22);
    expect(brain.stats.verticalRockets).toBe(1);
    expect(notes.some((n) => n.startsWith('vertical takeoff: '))).toBe(true);
  });

  it('verticalTakeoff picks a hand-over over the canopy and the climb from there clears (a 3 x 3 clearing, a 1 x 1 shaft)', async () => {
    for (const r of [1, 0]) {
      const { deps } = rig(forest(20, r));
      const from = { x: 0.5, y: FEET, z: 0.5 };
      const target: LandingTarget = { x: 0.5, z: 300.5, top: FEET, half: 1 };
      const cz = cruiseHeight(from, target, deps.skyTop!, {});
      const v = await verticalTakeoff(deps, from, target, { cruiseY: cz.y }, 64, 12);
      expect(v.top, `${r}: ${v.line}`).toBeDefined();
      expect(v.top!).toBeGreaterThanOrEqual(20);
      expect(v.line).toMatch(/clear$/);
    }
  });

  it('refused: a roof over the head, too few rockets, a column closed under the canopy top', async () => {
    const from = { x: 0.5, y: FEET, z: 0.5 };
    const target: LandingTarget = { x: 0.5, z: 300.5, top: FEET, half: 1 };
    const roofed = rig([...forest(20, 1), { from: { x: 0, y: FEET + 4, z: 0 }, to: { x: 0, y: FEET + 4, z: 0 }, solid: true }]);
    const cz = cruiseHeight(from, target, roofed.deps.skyTop!, {});
    const a = await verticalTakeoff(roofed.deps, from, target, { cruiseY: cz.y }, 64, 12);
    expect(a.top).toBeUndefined();
    expect(a.line).toBe(`the column over the start is open only 3 up`);
    const open = rig(forest(20, 1));
    expect((await verticalTakeoff(open.deps, from, target, { cruiseY: cz.y }, 0, 12)).line).toBe('no rockets for a straight climb');
    // a branch over the shaft 18 up (under the canopy's top): no hand-over height has VERTICAL_SPARE open cells over it above the trees
    const branch = rig([...forest(20, 0), { from: { x: 0, y: FEET + 18, z: 0 }, to: { x: 0, y: FEET + 18, z: 0 }, solid: true }]);
    const c = await verticalTakeoff(branch.deps, from, target, { cruiseY: cz.y }, 64, 12);
    expect(c.top, c.line).toBeUndefined();
    expect(VERTICAL_SPARE).toBeGreaterThan(0);
  });
});
