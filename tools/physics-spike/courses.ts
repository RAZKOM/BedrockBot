// Spike courses on the bds-phys flat world (grass top y = -61, feet -60). Terrain is built with
// truth:fill and known by construction (the bot's BlockQuery = flat world + these boxes).
import { flatWorld, withBoxes } from '../../bot/src/skills/input/index.ts';
import type { BlockBox, BlockQuery, InputLoopState, MoveCommand, Vec3 } from '../../bot/src/skills/input/index.ts';

export type Controller = (s: InputLoopState, t: number, start: Vec3) => Partial<MoveCommand> | null;

export interface Fill {
  from: Vec3;
  to: Vec3;
  block: string;
}

export interface Course {
  name: string;
  description: string;
  /** truth:fill commands, in order. */
  build: Fill[];
  world: BlockQuery;
  /** Feet position to teleport to, facing `yaw`. */
  start: Vec3;
  yaw: number;
  /** A fresh controller per run. Per tick: the command to hold, or null when the run is over (`t` from 0). */
  controller(): Controller;
  /** Give up after this many ticks. */
  maxTicks: number;
}

const toBoxes = (fills: Fill[]): BlockBox[] => fills.map((f) => ({ from: f.from, to: f.to, solid: f.block !== 'air' }));

function course(c: Omit<Course, 'world'>): Course {
  return { ...c, world: withBoxes(flatWorld(), toBoxes(c.build)) };
}

/** Holds `cmd` until `done` returns true, then coasts `coast` ticks idle. */
function untilThenCoast(cmd: Partial<MoveCommand>, done: (s: InputLoopState, start: Vec3) => boolean, coast = 20): () => Controller {
  return () => {
    let doneAt = -1;
    return (s, t, start) => {
      if (doneAt < 0 && done(s, start)) doneAt = t;
      if (doneAt < 0) return cmd;
      return t - doneAt < coast ? { forward: 0, strafe: 0, jump: false, sprint: false } : null;
    };
  };
}

// 1. 100 blocks straight on flat ground (+z). Nothing to build; the air box clears leftovers.
const FLAT_X = -30;
export const flat100 = course({
  name: 'flat-100',
  description: '100 blocks walking straight (+z) on flat ground, then 20 ticks coasting',
  build: [],
  start: { x: FLAT_X + 0.5, y: -60, z: -50.5 },
  yaw: 0,
  controller: untilThenCoast({ forward: 1 }, (s, st) => s.pos.z >= st.z + 100),
  maxTicks: 600,
});

// 2. 1-block-step staircase, 10 high, climbed by walking forward with jump held, onto a top platform.
const STAIR_X = 30;
const STAIR_Z = 31;
const stairs: Fill[] = [{ from: { x: STAIR_X - 1, y: -60, z: STAIR_Z - 4 }, to: { x: STAIR_X + 3, y: -40, z: STAIR_Z + 14 }, block: 'air' }];
for (let i = 0; i < 10; i++) {
  stairs.push({ from: { x: STAIR_X, y: -60, z: STAIR_Z + i }, to: { x: STAIR_X + 2, y: -60 + i, z: STAIR_Z + i }, block: 'stone' });
}
stairs.push({ from: { x: STAIR_X, y: -60, z: STAIR_Z + 10 }, to: { x: STAIR_X + 2, y: -51, z: STAIR_Z + 13 }, block: 'stone' });
export const stairs10 = course({
  name: 'stairs-10',
  description: '10-high staircase of 1-block steps (3 wide), forward + jump held until on the top platform, then 20 ticks idle',
  build: stairs,
  start: { x: STAIR_X + 1.5, y: -60, z: STAIR_Z - 2.5 },
  yaw: 0,
  controller: untilThenCoast({ forward: 1, jump: true }, (s) => s.onGround && s.pos.y >= -50 && s.pos.z >= STAIR_Z + 10.5),
  maxTicks: 400,
});

// 3. Walk off a 3-block-high platform and keep walking 4 blocks.
const DROP_X = 60;
const DROP_Z = 30;
export const drop3 = course({
  name: 'drop-3',
  description: 'walk off a 3-high platform (+z), fall 3 blocks, walk on 4 blocks, then 20 ticks coasting',
  build: [
    { from: { x: DROP_X - 1, y: -60, z: DROP_Z - 2 }, to: { x: DROP_X + 3, y: -50, z: DROP_Z + 12 }, block: 'air' },
    { from: { x: DROP_X, y: -60, z: DROP_Z }, to: { x: DROP_X + 2, y: -58, z: DROP_Z + 5 }, block: 'stone' },
  ],
  start: { x: DROP_X + 1.5, y: -57, z: DROP_Z + 0.5 },
  yaw: 0,
  controller: untilThenCoast({ forward: 1 }, (s) => s.onGround && s.pos.y <= -60 && s.pos.z >= DROP_Z + 10),
  maxTicks: 300,
});

// ---- extra courses that discriminate between the engines (beyond PLAN.md 3.2) ----------------------

/** Holds `cmd` for `ticks` ticks, then 20 ticks with all keys released. */
function forTicks(cmd: Partial<MoveCommand>, ticks: number): () => Controller {
  const idle = { forward: 0, strafe: 0, jump: false, sprint: false, sneak: false };
  return () => (_s, t) => (t < ticks ? cmd : t < ticks + 20 ? idle : null);
}

// 4. Sprint-jumping diagonally on flat ground (sprint multiplier, air sprint acceleration, sprint-jump boost, yaw trig).
export const sprintJumpDiag = course({
  name: 'sprint-jump-diag',
  description: 'sprint + jump held for 80 ticks at yaw -37 (towards +x/+z) on flat ground, then 20 ticks coasting',
  build: [],
  start: { x: -60.5, y: -60, z: -20.5 },
  yaw: -37,
  controller: forTicks({ forward: 1, sprint: true, jump: true }, 80),
  maxTicks: 200,
});

// 5. A 10-high staircase of 1-block steps, 11 wide, climbed diagonally while sprinting (corner collisions, step + jump).
const DIAG_X = -80;
const DIAG_Z = 40;
const diag: Fill[] = [{ from: { x: DIAG_X - 1, y: -60, z: DIAG_Z - 4 }, to: { x: DIAG_X + 11, y: -40, z: DIAG_Z + 14 }, block: 'air' }];
for (let i = 0; i < 10; i++) {
  diag.push({ from: { x: DIAG_X, y: -60, z: DIAG_Z + i }, to: { x: DIAG_X + 10, y: -60 + i, z: DIAG_Z + i }, block: 'stone' });
}
diag.push({ from: { x: DIAG_X, y: -60, z: DIAG_Z + 10 }, to: { x: DIAG_X + 10, y: -51, z: DIAG_Z + 13 }, block: 'stone' });
export const stairsDiag = course({
  name: 'stairs-diag',
  description: '10-high staircase (11 wide) climbed at yaw -10 while sprinting with jump held, then 20 ticks idle',
  build: diag,
  start: { x: DIAG_X + 1.5, y: -60, z: DIAG_Z - 2.5 },
  yaw: -10,
  controller: untilThenCoast({ forward: 1, jump: true, sprint: true }, (s) => s.onGround && s.pos.y >= -50 && s.pos.z >= DIAG_Z + 10.5),
  maxTicks: 400,
});

// 6. Sneaking forward over the edge of a 3-high platform: vanilla sneak edge avoidance keeps the player on it.
const SNEAK_X = 90;
const SNEAK_Z = 30;
export const sneakEdge = course({
  name: 'sneak-edge',
  description: 'sneak forward for 80 ticks towards the edge of a 3-high platform (vanilla: stops at the edge), then 20 ticks idle',
  build: [
    { from: { x: SNEAK_X - 1, y: -60, z: SNEAK_Z - 2 }, to: { x: SNEAK_X + 3, y: -50, z: SNEAK_Z + 8 }, block: 'air' },
    { from: { x: SNEAK_X, y: -60, z: SNEAK_Z }, to: { x: SNEAK_X + 2, y: -58, z: SNEAK_Z + 2 }, block: 'stone' },
  ],
  start: { x: SNEAK_X + 1.5, y: -57, z: SNEAK_Z + 0.5 },
  yaw: 0,
  controller: forTicks({ forward: 1, sneak: true }, 80),
  maxTicks: 200,
});

export const COURSES: Course[] = [flat100, stairs10, drop3, sprintJumpDiag, stairsDiag, sneakEdge];
