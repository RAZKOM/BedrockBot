// Track F0 (docs/flight-envelope.md, ADR 0056): the model changes the flight-envelope measurements on
// BDS asked for, pinned here: the rocket boost runs until the rocket's remove_entity (up to the longest
// burn measured), a second rocket extends it, and the expected boost left the planners see.
import { describe, expect, it } from 'vitest';
import { GLIDE, InputLoop, boostTicksExpected, flatWorld, glideFallStep, stepBody, wallImpactDamage, type BodyState, type InputLoopEvent, type MoveCommand } from '../../../src/skills/input/index.ts';
import { damageForCounted } from '../../../src/skills/fall/damage.ts';
import { FakeConnection } from './fakes.ts';

const sky = { solidAt: () => false };
const CMD: Partial<MoveCommand> = { yaw: 0, pitch: -10, glide: true, forward: 0 };

/** A loop gliding in an empty sky (the elytra on), a few ticks into the glide. */
function gliding(): { conn: FakeConnection; loop: InputLoop } {
  const conn = new FakeConnection({ x: 0.5, y: 200, z: 0.5 });
  const loop = new InputLoop(conn, { world: sky, canGlide: () => true });
  loop.start();
  conn.spawn();
  loop.setCommand(CMD);
  conn.tick(2);
  conn.receive('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { gliding: true } }], tick: 2n });
  conn.tick(3);
  expect(loop.state.gliding).toBe(true);
  return { conn, loop };
}

function snapshot(loop: InputLoop): BodyState {
  const s = loop.state;
  return { pos: s.pos, vel: s.vel, onGround: s.onGround, collidedHorizontally: false, collidedVertically: false, jumpTicks: 0, sprinting: false, sneaking: false, inWater: false, inLava: false, gliding: true, boostTicks: 0 };
}

/** The same inputs offline: `n` ticks with the boost on the ticks `boosted` says. */
function offline(from: BodyState, n: number, boosted: (i: number) => boolean): BodyState {
  let b = from;
  for (let i = 0; i < n; i++) {
    const cmd: MoveCommand = { forward: 0, strafe: 0, jump: false, sprint: false, sneak: false, yaw: 0, pitch: -10, glide: true, boostStart: boosted(i) ? 1 : 0 };
    b = stepBody(b, cmd, sky).state;
  }
  return b;
}

const near = (a: BodyState, pos: { x: number; y: number; z: number }) => {
  expect(pos.x).toBeCloseTo(a.pos.x, 5);
  expect(pos.y).toBeCloseTo(a.pos.y, 5);
  expect(pos.z).toBeCloseTo(a.pos.z, 5);
};

describe('flight envelope: the rocket boost in the input loop (Track F0)', () => {
  it('without a remove_entity the boost runs GLIDE.boostMaxTicks inputs (the longest burn measured, 21, and a tick)', () => {
    expect(GLIDE.boostMaxTicks).toBe(22);
    const { conn, loop } = gliding();
    const s0 = snapshot(loop);
    loop.boost();
    conn.tick(30);
    near(offline(s0, 30, (i) => i < GLIDE.boostMaxTicks), loop.state.pos);
    expect(loop.state.boostTicks).toBe(0);
  });

  it('remove_entity cuts it: the inputs from GLIDE.boostEndLag back on are replayed without the boost', () => {
    expect(GLIDE.boostEndLag).toBe(2);
    const { conn, loop } = gliding();
    const s0 = snapshot(loop);
    loop.boost();
    conn.tick(12);
    loop.endBoost(); // the removal 3 inputs after the last boosted one (the most common lag measured)
    near(offline(s0, 12, (i) => i < 9), loop.state.pos);
    expect(loop.state.boostTicks).toBe(0);
    conn.tick(5);
    near(offline(s0, 17, (i) => i < 9), loop.state.pos);
  });

  it('a remove_entity that arrives after the model ran out still takes back the ticks boosted too long', () => {
    const { conn, loop } = gliding();
    const s0 = snapshot(loop);
    loop.boost();
    conn.tick(22); // the model boosted 22; the rocket burnt 17 and its removal arrives 5 inputs later
    loop.endBoost(4);
    near(offline(s0, 22, (i) => i < 17), loop.state.pos);
  });

  it('a remove_entity with nothing boosted in its window changes nothing', () => {
    const { conn, loop } = gliding();
    loop.boost();
    conn.tick(30);
    const before = loop.state.pos;
    loop.endBoost(4);
    expect(loop.state.pos).toEqual(before);
  });

  it('a second rocket while one burns extends the boost to its own end (measured: the union, no stronger push)', () => {
    const { conn, loop } = gliding();
    const s0 = snapshot(loop);
    loop.boost();
    conn.tick(5);
    loop.boost();
    conn.tick(30);
    near(offline(s0, 35, (i) => i < 5 + GLIDE.boostMaxTicks), loop.state.pos);
  });

  it('an explicit shorter boost while one burns does not shorten it', () => {
    const { conn, loop } = gliding();
    const s0 = snapshot(loop);
    loop.boost();
    conn.tick(2);
    loop.boost(3);
    conn.tick(25);
    near(offline(s0, 27, (i) => i < GLIDE.boostMaxTicks), loop.state.pos);
  });

  it('the state shows the expected boost left, at least 1 while the model boosts', () => {
    const { conn, loop } = gliding();
    loop.boost();
    conn.tick();
    expect(loop.state.boostTicks).toBe(14); // the nominal 15 minus the tick burnt
    conn.tick(15);
    expect(loop.state.boostTicks).toBe(2); // 16 burnt: a rocket still burning gives 2.3 more (measured)
    conn.tick(3);
    expect(loop.state.boostTicks).toBe(1);
    conn.tick(2);
    expect(loop.state.boostTicks).toBe(1); // 21 burnt: still 1 until the cap or the removal
    conn.tick();
    expect(loop.state.boostTicks).toBe(0);
  });
});

describe('flight envelope: a glide request the server never confirms (Track F0)', () => {
  const setup = () => {
    const conn = new FakeConnection({ x: 0.5, y: 200, z: 0.5 });
    const loop = new InputLoop(conn, { world: sky, canGlide: () => true });
    const events: InputLoopEvent[] = [];
    loop.onEvent((e) => events.push(e));
    loop.start();
    conn.spawn();
    return { conn, loop, events };
  };
  const falls = (from: BodyState, n: number): BodyState => {
    let b = from;
    for (let i = 0; i < n; i++) b = stepBody(b, { forward: 0, strafe: 0, jump: false, sprint: false, sneak: false, yaw: 0, pitch: -10, glide: false }, sky).state;
    return b;
  };

  it('is taken back after GLIDE.confirmTicks inputs: the inputs since replay as a fall, and the next input asks again', () => {
    const { conn, loop, events } = setup();
    conn.tick(); // the first input reports the spawn
    const s0 = snapshot(loop);
    loop.setCommand(CMD);
    conn.tick(GLIDE.confirmTicks + 1); // the request and confirmTicks inputs after it
    expect(loop.state.gliding).toBe(true); // still waiting for the flag
    expect(events.some((e) => e.kind === 'glide')).toBe(false);
    expect(conn.sent.filter((p) => p.input_data.includes('start_gliding'))).toHaveLength(1);
    conn.tick();
    // the request is refused: the model fell all along, and this input asked again
    expect(events.some((e) => e.kind === 'glide' && e.refused === true && !e.gliding)).toBe(true);
    const fell = falls({ ...s0, gliding: false }, GLIDE.confirmTicks + 1);
    expect(conn.sent.filter((p) => p.input_data.includes('start_gliding'))).toHaveLength(2);
    expect(loop.state.gliding).toBe(true);
    // the inputs replayed without the glide end where a plain fall ends (the new request glides one input on from there)
    const again = stepBody(fell, { forward: 0, strafe: 0, jump: false, sprint: false, sneak: false, yaw: 0, pitch: -10, glide: true }, sky).state;
    near(again, loop.state.pos);
  });

  it('no glide request on the input right after a ground jump (refused on BDS 4 of 4); the next input asks', () => {
    const conn = new FakeConnection({ x: 0.5, y: -60, z: 0.5 });
    const loop = new InputLoop(conn, { world: flatWorld(), canGlide: () => true });
    loop.start();
    conn.spawn();
    conn.tick(3);
    expect(loop.state.onGround).toBe(true);
    loop.setCommand({ jump: true, glide: false });
    conn.tick();
    expect(loop.state.onGround).toBe(false); // jumped
    loop.setCommand({ jump: false, glide: true });
    conn.tick();
    expect(loop.state.gliding).toBe(false);
    expect(conn.sent.at(-1)!.input_data).not.toContain('start_gliding');
    conn.tick();
    expect(loop.state.gliding).toBe(true);
    expect(conn.sent.at(-1)!.input_data).toContain('start_gliding');
  });

  it('a rocket on an input the body enters without gliding boosts nothing (BDS: no rocket entity, also with the glide start); from the next input it boosts', () => {
    const run = (fireOn: 'start' | 'after'): { boosted: number; y: number } => {
      const conn = new FakeConnection({ x: 0.5, y: 200, z: 0.5 });
      const loop = new InputLoop(conn, { world: sky, canGlide: () => true });
      loop.start();
      conn.spawn();
      loop.setCommand({ ...CMD, glide: false });
      conn.tick(3); // falling, not gliding
      loop.setCommand(CMD);
      if (fireOn === 'start') loop.boost();
      conn.tick(); // the glide starts on this input
      conn.receive('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { gliding: true } }], tick: 4n });
      if (fireOn === 'after') loop.boost();
      let boosted = 0;
      for (let i = 0; i < 25; i++) {
        conn.tick();
        if (loop.state.boostTicks > 0) boosted++;
      }
      return { boosted, y: loop.state.pos.y };
    };
    const start = run('start');
    const after = run('after');
    expect(start.boosted).toBe(0);
    expect(after.boosted).toBeGreaterThan(15);
    expect(after.y).toBeGreaterThan(start.y);
  });

  it('a confirmed request is kept', () => {
    const { conn, loop, events } = setup();
    conn.tick();
    loop.setCommand(CMD);
    conn.tick(2);
    conn.receive('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { gliding: true } }], tick: 3n });
    conn.tick(GLIDE.confirmTicks + 5);
    expect(loop.state.gliding).toBe(true);
    expect(events.some((e) => e.kind === 'glide' && e.refused === true)).toBe(false);
  });
});

describe('flight envelope: wall and touchdown damage (measured rules)', () => {
  it('wallImpactDamage: 10 x the horizontal speed lost minus 3 (bds-fly head-on 0.37 / 0.42 / 0.52 / 0.82 / 1.51, glancing 45 at 1.0)', () => {
    // [the speed the glide step gave, what the wall left, the measured damage]
    const shots: [number, number, number][] = [
      [0.3723, 0, 0.7229],
      [0.4177, 0, 1.1774],
      [0.5146, 0, 2.1461],
      [0.8167, 0, 5.1673],
      [1.5133, 0, 12.1327],
    ];
    for (const [a, b, d] of shots) expect(wallImpactDamage(a, b)).toBeCloseTo(d, 3);
    expect(wallImpactDamage(0.216, 0)).toBe(0);
    expect(wallImpactDamage(1.012, 1.012 - 0.295)).toBe(0); // a 45-degree scrape at 1.0 a tick
  });

  /** A body teleported `h` above flat ground: it falls, asks for the glide under -0.2 and dives at `pitch`; the damage on touchdown. */
  const dive = (h: number, pitch: number): number => {
    const world = flatWorld();
    let b: BodyState = { pos: { x: 0.5, y: -60 + h, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: false, collidedHorizontally: false, collidedVertically: false, jumpTicks: 0, sprinting: false, sneaking: false, gliding: false, boostTicks: 0 };
    let fall = 0;
    let glide = false;
    for (let t = 0; t < 400; t++) {
      glide ||= b.vel.y < -0.2;
      const vyIn = b.vel.y;
      const wasGliding = b.gliding === true;
      const n = stepBody(b, { forward: 0, strafe: 0, jump: false, sprint: false, sneak: false, yaw: 0, pitch, glide }, world).state;
      if (n.onGround) return damageForCounted(fall); // the landing tick's move is not counted
      const dy = n.pos.y - b.pos.y;
      fall = wasGliding || n.gliding ? glideFallStep(fall, vyIn, dy) : fall + Math.max(0, -dy);
      b = n;
    }
    throw new Error('never landed');
  };

  it('glideFallStep + damageForCounted reproduce the measured touchdowns (pitch 80 / 45 / 0 from 3 to 55 blocks)', () => {
    // [height, pitch, the damage bds-fly dealt]
    const measured: [number, number, number][] = [
      [3, 80, 0],
      [5, 80, 2],
      [8, 80, 4],
      [12, 80, 9],
      [16, 80, 12],
      [20, 80, 16],
      [25, 80, 21],
      [30, 80, 26],
      [40, 80, 37],
      [55, 80, 51],
      [15, 45, 8],
      [30, 45, 23],
      [60, 45, 53],
      [10, 0, 0],
      [30, 0, 0],
    ];
    const got = measured.map(([h, p]) => dive(h, p));
    expect(got).toEqual(measured.map((m) => m[2]));
  });
});

describe('flight envelope: boostTicksExpected (the measured burn tail)', () => {
  it('maps the ticks left to the cap to the expected ticks left', () => {
    expect(boostTicksExpected(0)).toBe(0);
    expect(boostTicksExpected(-1)).toBe(0);
    expect(boostTicksExpected(GLIDE.boostMaxTicks)).toBe(GLIDE.boostTicks);
    // the mean ticks left of a rocket still burning after `burnt` ticks (175 burns on bds-fly)
    const measured: [number, number][] = [[10, 5.73], [11, 5.02], [12, 4.32], [13, 3.65], [14, 3.05], [15, 2.62], [16, 2.3], [17, 1.91], [18, 1.71], [19, 1.13], [20, 1]];
    for (const [burnt, left] of measured) expect(Math.abs(boostTicksExpected(GLIDE.boostMaxTicks - burnt) - left)).toBeLessThan(0.75);
    expect(boostTicksExpected(1)).toBe(1);
    for (let left = 1; left <= GLIDE.boostMaxTicks; left++) {
      expect(boostTicksExpected(left)).toBeGreaterThanOrEqual(1);
      expect(boostTicksExpected(left)).toBeLessThanOrEqual(left);
    }
  });
});
