import { describe, expect, it } from 'vitest';
import {
  IDLE_COMMAND,
  applyCorrection,
  applyTeleport,
  flatWorld,
  initialBody,
  ownEngine,
  serverStateFromCorrection,
  type BodyState,
  type HistoryEntry,
  type MoveCommand,
} from '../../../src/skills/input/index.ts';

const world = flatWorld();
const walk: MoveCommand = { ...IDLE_COMMAND, forward: 1 };

/** History of `n` walking ticks from (0.5, -60, 0.5), ticks 1..n. */
function walkHistory(n: number): { history: HistoryEntry[]; current: BodyState } {
  let s = initialBody({ x: 0.5, y: -60, z: 0.5 }, true);
  const history: HistoryEntry[] = [];
  for (let i = 1; i <= n; i++) {
    s = ownEngine.step(s, walk, world).state;
    history.push({ tick: BigInt(i), cmd: walk, state: s, simulated: true });
  }
  return { history, current: s };
}

describe('applyCorrection', () => {
  it('converts the packet: eye -> feet, delta = velocity', () => {
    const s = serverStateFromCorrection({
      prediction_type: 'player',
      position: { x: 1, y: -58.38, z: 2 },
      delta: { x: 0, y: -0.0784, z: 0.1 },
      rotation: { x: 0, y: 0 },
      on_ground: true,
      tick: 7n,
    });
    expect(s.pos.y).toBeCloseTo(-60, 5);
    expect(s.tick).toBe(7n);
    expect(s.vel).toEqual({ x: 0, y: -0.0784, z: 0.1 });
  });

  it('rewinds to the corrected tick, takes the server state and replays the later inputs', () => {
    const { history, current } = walkHistory(10);
    const at = history[5]!; // tick 6
    const server = { tick: 6n, pos: { ...at.state.pos, x: at.state.pos.x + 1 }, vel: at.state.vel, onGround: true };
    const out = applyCorrection(history, current, server, ownEngine, world);
    expect(out.replayed).toBe(4);
    expect(out.predicted).toEqual(at.state.pos);
    // the 4 replayed walking ticks keep the shift, z is unchanged
    expect(out.state.pos.x).toBeCloseTo(current.pos.x + 1, 5);
    expect(out.state.pos.z).toBeCloseTo(current.pos.z, 5);
    expect(out.history).toHaveLength(10);
    // inputs are not mutated
    expect(history[5]!.state.pos.x).toBe(at.state.pos.x);
  });

  it('a correction of the newest tick replaces the current state', () => {
    const { history, current } = walkHistory(3);
    const out = applyCorrection(history, current, { tick: 3n, pos: { x: 5, y: -60, z: 5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true }, ownEngine, world);
    expect(out.replayed).toBe(0);
    expect(out.state.pos).toEqual({ x: 5, y: -60, z: 5 });
  });

  it('a tick outside the history is adopted as is and clears the history', () => {
    const { history, current } = walkHistory(3);
    const out = applyCorrection(history, current, { tick: 99n, pos: { x: 5, y: -60, z: 5 }, vel: { x: 0, y: -0.0784, z: 0 }, onGround: true }, ownEngine, world);
    expect(out.predicted).toBeUndefined();
    expect(out.state.pos).toEqual({ x: 5, y: -60, z: 5 });
    expect(out.state.onGround).toBe(true);
    expect(out.history).toEqual([]);
  });
});

describe('applyTeleport', () => {
  const target = { tick: 10n, pos: { x: 20.5, y: -60, z: 20.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true };

  it('without inputs in flight: adopt, zero velocity, skip the simulation of the next input', () => {
    const { history, current } = walkHistory(10);
    const out = applyTeleport(history, current, target, ownEngine, world);
    expect(out.skipNext).toBe(true);
    expect(out.inFlight).toBe(0);
    expect(out.state.pos).toEqual(target.pos);
    expect(out.state.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(out.history).toEqual([]);
  });

  it('with inputs in flight: the first takes the target unsimulated, the rest are replayed from it', () => {
    const { history, current } = walkHistory(13); // ticks 11..13 in flight
    const out = applyTeleport(history, current, target, ownEngine, world);
    expect(out.skipNext).toBe(false);
    expect(out.inFlight).toBe(3);
    expect(out.history[0]!.simulated).toBe(false);
    expect(out.history[0]!.state.pos).toEqual(target.pos);
    expect(out.state.pos.z).toBeGreaterThan(target.pos.z);
    expect(out.state.pos.x).toBe(target.pos.x);
  });
});
