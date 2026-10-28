// Minimal Bedrock player movement model (PLAN.md task 3.1). Own implementation of the vanilla rules
// the BDS 1.26.51 server simulates from player_auth_input: ground walking with friction, air
// inertia, gravity with drag, jumping, full-cube collisions with auto-step. See docs/movement.md.
//
// Constants are the vanilla values. Where a Bedrock-specific value or the update order comes from
// LiteLDev/bedboo's measurements (LGPL-3.0, packages/mineflayer-bedrock/lib/physics/engine.js and
// docs/differences/U5.md) the comment says so; no code is copied from it.
import type { BlockQuery, BodyState, MoveCommand, PhysicsEngine, StepResult, Vec3 } from './types.ts';
import { cloneBody } from './types.ts';

const f32 = Math.fround;

export const PHYSICS = Object.freeze({
  gravity: 0.08,
  /** Vertical drag applied after gravity every tick. */
  drag: 0.98,
  /** Horizontal velocity multiplier in the air. */
  airInertia: 0.91,
  /** Default block slipperiness; ground inertia = 0.6 * 0.91 = 0.546. */
  groundFriction: 0.6,
  /** Base movement speed attribute (acceleration per tick on default ground before the 0.98 scale). */
  walkSpeed: 0.1,
  sprintMultiplier: 1.3,
  airAcceleration: 0.02,
  /** Air acceleration while sprinting (bedboo-measured Bedrock value). */
  airSprintAcceleration: 0.026,
  /** The move vector is scaled by 0.98 before it accelerates the body: 0.1 * 0.98 = 0.098 per tick. */
  impulseScale: 0.98,
  /** Move vector scale while sneaking. */
  sneakScale: 0.3,
  jumpVelocity: 0.42,
  sprintJumpBoost: 0.2,
  /** Ticks before a held jump key jumps again. */
  jumpCooldown: 10,
  /** Bedrock auto-step height (9/16; Java uses 0.6). */
  stepHeight: 0.5625,
  width: 0.6,
  height: 1.8,
  /** Box height while sneaking (bedboo-measured on BDS 1.26.51). */
  sneakHeight: 1.49,
  eyeHeight: 1.62,
  /** Vanilla ground acceleration factor: accel = speed * 0.16277136 / inertia^3 (= speed on default ground). */
  groundAccelFactor: 0.16277136,
  /** Velocity is zeroed when |v|^2 is below this (Bedrock: (1e-6)^2, bedboo-measured). */
  negligibleVelocitySq: 1e-12,
  /** Penetrations below this count as touching (positions are float32). */
  contactEpsilon: 1e-4,
});

export type Box = [minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number];

/** The player's box at feet position `p`. */
export function playerBox(p: Vec3, height: number = PHYSICS.height): Box {
  const w = PHYSICS.width / 2;
  return [p.x - w, p.y, p.z - w, p.x + w, p.y + height, p.z + w];
}

function offsetBox(b: Box, dx: number, dy: number, dz: number): Box {
  return [b[0] + dx, b[1] + dy, b[2] + dz, b[3] + dx, b[4] + dy, b[5] + dz];
}

/** Box grown to cover a move by (dx, dy, dz). */
function sweepBox(b: Box, dx: number, dy: number, dz: number): Box {
  return [
    dx < 0 ? b[0] + dx : b[0],
    dy < 0 ? b[1] + dy : b[1],
    dz < 0 ? b[2] + dz : b[2],
    dx > 0 ? b[3] + dx : b[3],
    dy > 0 ? b[4] + dy : b[4],
    dz > 0 ? b[5] + dz : b[5],
  ];
}

/** Unit boxes of the solid blocks that touch `region`, or undefined when any block in it is unknown. */
export function solidBoxes(world: BlockQuery, region: Box): Box[] | undefined {
  const out: Box[] = [];
  const x0 = Math.floor(region[0]);
  const y0 = Math.floor(region[1]);
  const z0 = Math.floor(region[2]);
  const x1 = Math.floor(region[3]);
  const y1 = Math.floor(region[4]);
  const z1 = Math.floor(region[5]);
  if (world.boxesAt) {
    // Real shapes; one layer lower for blocks taller than 1 (fences, walls: 1.5).
    for (let y = y0 - 1; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const bs = world.boxesAt(x, y, z);
          if (bs === undefined) {
            if (y < y0) continue; // the extra layer may be outside the loaded world
            return undefined;
          }
          for (const b of bs) {
            if (y < y0 && b[4]! <= 1) continue;
            out.push([x + b[0]!, y + b[1]!, z + b[2]!, x + b[3]!, y + b[4]!, z + b[5]!]);
          }
        }
      }
    }
    return out;
  }
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const s = world.solidAt(x, y, z);
        if (s === undefined) return undefined;
        if (s) out.push([x, y, z, x + 1, y + 1, z + 1]);
      }
    }
  }
  return out;
}

/** Ground slipperiness under feet `p`: the block at floor(y - 0.5) (bedboo-measured rule), air / unknown = 0.6. */
export function groundFriction(world: BlockQuery, p: Vec3): number {
  if (!world.frictionAt) return PHYSICS.groundFriction;
  return world.frictionAt(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z)) ?? PHYSICS.groundFriction;
}

/**
 * Which liquids the body box at feet `p` touches (box shrunk by 0.001, liquid surface heights
 * respected). `inset` also shrinks the box vertically at both ends: the water movement test uses 0.4
 * (Track AJ, measured on BDS 1.26.60: a body whose feet are less than 0.4 below the water surface
 * moves with air physics: no water drag, no jump-in-water impulse).
 */
export function liquidContact(world: BlockQuery, p: Vec3, height: number = PHYSICS.height, inset = 0): { water: boolean; lava: boolean } {
  const out = { water: false, lava: false };
  if (!world.liquidAt) return out;
  const b = playerBox(p, height);
  b[1] += inset;
  b[4] -= inset;
  const d = 0.001;
  const x0 = Math.floor(b[0] + d);
  const x1 = Math.floor(b[3] - d);
  const y0 = Math.floor(b[1] + d);
  const y1 = Math.floor(b[4] - d);
  const z0 = Math.floor(b[2] + d);
  const z1 = Math.floor(b[5] - d);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const l = world.liquidAt(x, y, z);
        if (!l) continue;
        if (y + (inset > 0 ? 1 : l.height) <= b[1] + d) continue; // Track AJ: the inset test reads whole cells
        if (l.liquid === 'water') out.water = true;
        else out.lava = true;
      }
    }
  }
  return out;
}

const E = PHYSICS.contactEpsilon;

/**
 * Track AJ: horizontal contact tolerance at position p: 1e-4, or 2^-21 x the larger of |x| and |z| when
 * that is more (about 10 float32 half-ulps; x 5000: 0.0024). Float32 positions far from the origin
 * snap past a face they stopped at; with 1e-4 the next tick walked into the block.
 */
export function contactEpsilon(p: Vec3): number {
  return Math.max(E, Math.max(Math.abs(p.x), Math.abs(p.z)) * 4.76837158203125e-7);
}

/**
 * Clip a move of `d` along `axis` (0 = x, 1 = y, 2 = z) of box `b` against `obstacle`. `e`: the
 * contact tolerance along a horizontal move axis (y, and the overlap test on the other axes, use E).
 */
export function clipAxis(obstacle: Box, b: Box, axis: Axis, d: number, e: number = E): number {
  const a1: Axis = axis === 0 ? 1 : 0;
  const a2: Axis = axis === 2 ? 1 : 2;
  const e1 = E; // (the overlap on the other axes keeps E: a larger tolerance there let the body slip past corners)
  const e2 = E;
  const ea = axis === 1 ? E : e;
  // the boxes must overlap on the two other axes
  if (!(hi(obstacle, a1) > lo(b, a1) + e1 && lo(obstacle, a1) < hi(b, a1) - e1)) return d;
  if (!(hi(obstacle, a2) > lo(b, a2) + e2 && lo(obstacle, a2) < hi(b, a2) - e2)) return d;
  // (Track AJ: a box within the tolerance stops the move but never pushes the body back by more than E)
  if (d > 0 && lo(obstacle, axis) >= hi(b, axis) - ea) return Math.min(d, Math.max(lo(obstacle, axis) - hi(b, axis), -E));
  if (d < 0 && hi(obstacle, axis) <= lo(b, axis) + ea) return Math.max(d, Math.min(hi(obstacle, axis) - lo(b, axis), E));
  return d;
}

type Axis = 0 | 1 | 2;
const lo = (b: Box, a: Axis): number => (a === 0 ? b[0] : a === 1 ? b[1] : b[2]);
const hi = (b: Box, a: Axis): number => (a === 0 ? b[3] : a === 1 ? b[4] : b[5]);

function clipAll(boxes: Box[], b: Box, axis: Axis, d: number, e: number = E): number {
  for (const o of boxes) d = clipAxis(o, b, axis, d, e);
  return d;
}

export interface MoveResult {
  /** Applied movement. */
  dx: number;
  dy: number;
  dz: number;
  collidedHorizontally: boolean;
  collidedVertically: boolean;
  onGround: boolean;
}

/**
 * Move the box at feet `pos` by `wanted` through `world`: collide Y, then X, then Z; if a horizontal
 * axis was blocked while grounded (or landing this tick), retry stepped up by at most `stepHeight`
 * and keep whichever went further horizontally. Returns undefined when the world around is unknown.
 */
export function moveBody(
  world: BlockQuery,
  pos: Vec3,
  wanted: Vec3,
  wasOnGround: boolean,
  height: number = PHYSICS.height,
): MoveResult | undefined {
  const start = playerBox(pos, height);
  const step = PHYSICS.stepHeight;
  const region = sweepBox(sweepBox(start, wanted.x, wanted.y, wanted.z), 0, step, 0);
  region[1] -= 1; // the block under the feet, for the resting check
  const boxes = solidBoxes(world, region);
  if (!boxes) return undefined;

  let b = start;
  // Track AJ: float32 positions far from the origin snap past a face they stopped at (ulp 0.0005 at 5000):
  // the contact tolerance grows with the coordinates, or the next tick walks into the block
  const e = contactEpsilon(pos);
  const dy = clipAll(boxes, b, 1, wanted.y, e);
  b = offsetBox(b, 0, dy, 0);
  const dx = clipAll(boxes, b, 0, wanted.x, e);
  b = offsetBox(b, dx, 0, 0);
  const dz = clipAll(boxes, b, 2, wanted.z, e);
  let res = { dx, dy, dz };

  const blockedH = dx !== wanted.x || dz !== wanted.z;
  const landed = dy !== wanted.y && wanted.y < 0;
  if (blockedH && (wasOnGround || landed)) {
    const lifted = (up: number): { dx: number; dy: number; dz: number } => {
      let s = offsetBox(start, 0, up, 0);
      const sx = clipAll(boxes, s, 0, wanted.x, e);
      s = offsetBox(s, sx, 0, 0);
      const sz = clipAll(boxes, s, 2, wanted.z, e);
      s = offsetBox(s, 0, 0, sz);
      const down = clipAll(boxes, s, 1, -up, e);
      return { dx: sx, dy: up + down, dz: sz };
    };
    const better = (c: { dx: number; dz: number }) => c.dx * c.dx + c.dz * c.dz > res.dx * res.dx + res.dz * res.dz;
    const up = clipAll(boxes, start, 1, step, e);
    const a = lifted(up);
    if (better(a)) res = a;
    // Track AX: a second candidate lifted only as far as the box swept along the move fits (Java's
    // step: the lift clipped by what is overhead ahead, e.g. a door's lintel): from a dirt path
    // (0.0625 low) into a 2-high doorway the full 0.5625 lift puts the head into the lintel
    const upAhead = clipAll(boxes, sweepBox(start, wanted.x, 0, wanted.z), 1, step, e);
    if (upAhead < up - 1e-9 && upAhead > 0) {
      const b2 = lifted(upAhead);
      if (better(b2)) res = b2;
    }
  }

  const collidedHorizontally = res.dx !== wanted.x || res.dz !== wanted.z;
  const collidedVertically = res.dy !== wanted.y;
  let onGround = collidedVertically && wanted.y < 0;
  // A body without vertical motion (e.g. right after a teleport) stays grounded while it rests on something.
  if (!onGround && wasOnGround && !collidedVertically && Math.abs(wanted.y) <= 1e-5) {
    const end = offsetBox(start, res.dx, res.dy, res.dz);
    onGround = clipAll(boxes, end, 1, -1e-3, e) !== -1e-3;
  }
  return { ...res, collidedHorizontally, collidedVertically, onGround };
}

/** Bedrock yaw degrees -> (sin, cos) in float32, the way the server evaluates it (precise, no table). */
export function yawSinCos(yawDeg: number): { s: number; c: number } {
  const rad = f32(f32(yawDeg) * f32(Math.PI / 180));
  return { s: f32(Math.sin(rad)), c: f32(Math.cos(rad)) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The processed move vector the client reports and the server simulates: x = left (+) / right (-),
 * z = forward (+) / back (-); normalized when longer than 1, x 0.3 while sneaking.
 */
export function moveVectorOf(cmd: Pick<MoveCommand, 'forward' | 'strafe' | 'sneak'>): { x: number; z: number } {
  let x = clamp(-cmd.strafe, -1, 1);
  let z = clamp(cmd.forward, -1, 1);
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  if (cmd.sneak) {
    x *= PHYSICS.sneakScale;
    z *= PHYSICS.sneakScale;
  }
  // + 0 turns -0 into 0
  return { x: f32(x) + 0, z: f32(z) + 0 };
}

/** Add the move impulse (`left`, `forward`, already x 0.98) times `accel`, rotated by the yaw. */
export function applyImpulse(vel: Vec3, left: number, forward: number, accel: number, yawDeg: number): void {
  const lenSq = left * left + forward * forward;
  if (lenSq < 1e-4) return;
  const k = f32(accel / Math.max(Math.sqrt(lenSq), 1));
  const l = f32(left * k);
  const f = f32(forward * k);
  const { s, c } = yawSinCos(yawDeg);
  vel.x = f32(vel.x + f32(l * c - f * s));
  vel.z = f32(vel.z + f32(f * c + l * s));
}

/**
 * One tick of the body. Order (vanilla; confirmed for Bedrock by bedboo's recorded traces):
 * acceleration and friction from the PREVIOUS tick's ground state -> move impulse -> jump ->
 * collide (with step) -> blocked axes stop -> gravity + drag -> friction. Float32 throughout.
 */
export function stepBody(prev: BodyState, cmd: MoveCommand, world: BlockQuery): StepResult {
  const s = cloneBody(prev);
  const v = s.vel;
  if (v.x * v.x + v.y * v.y + v.z * v.z < PHYSICS.negligibleVelocitySq) {
    v.x = 0;
    v.y = 0;
    v.z = 0;
  }

  if (cmd.jump) {
    if (s.jumpTicks > 0) s.jumpTicks--;
  } else {
    s.jumpTicks = 0;
  }
  s.sneaking = cmd.sneak;
  s.sprinting = cmd.sprint && cmd.forward > 0 && !cmd.sneak;

  const height = s.sneaking ? PHYSICS.sneakHeight : PHYSICS.height;
  // Track AJ: water moves the body only when the box shrunk by 0.4 at both ends is in it (BDS 1.26.60)
  const touch = liquidContact(world, s.pos, height);
  const wet = touch.water ? { water: liquidContact(world, s.pos, height, LIQUID.waterInset).water, lava: touch.lava } : touch;
  s.inWater = wet.water;
  s.inLava = wet.lava && !wet.water;
  // Track AU: a firework boost that started before this tick (recorded in the input for replays)
  if (cmd.boostStart !== undefined) s.boostTicks = cmd.boostStart;
  if (wet.water || wet.lava) {
    s.gliding = false; // water ends a glide (BDS does the same)
    s.boostTicks = 0;
    return stepInLiquid(s, cmd, world, height, wet.water ? LIQUID.water : LIQUID.lava, prev);
  }
  // Track AU: the elytra glide starts on an airborne tick the glide is wanted (`glide: true`) and keeps
  // going until ground or water contact: BDS ignores a voluntary stop_gliding in the air (measured), so
  // only an explicit `glide: false` (the loop, when the server's flag ends or refuses it) stops the model
  s.gliding = cmd.glide === false ? false : (prev.gliding === true || cmd.glide === true) && !s.onGround;
  if (!s.gliding) s.boostTicks = 0;
  if (s.gliding) return stepGliding(s, cmd, world, prev);

  let accel: number;
  let inertia: number;
  if (s.onGround) {
    inertia = f32(groundFriction(world, s.pos) * PHYSICS.airInertia);
    const speed = f32(PHYSICS.walkSpeed * (s.sprinting ? PHYSICS.sprintMultiplier : 1));
    accel = f32(speed * f32(PHYSICS.groundAccelFactor / f32(inertia * inertia * inertia)));
  } else {
    inertia = PHYSICS.airInertia;
    accel = s.sprinting ? PHYSICS.airSprintAcceleration : PHYSICS.airAcceleration;
  }
  // Track AJ: BDS scales the move by the sneak factor also on the first tick after the sneak key is released
  const mv = moveVectorOf(!cmd.sneak && prev.sneaking ? { ...cmd, sneak: true } : cmd);
  applyImpulse(v, f32(mv.x * PHYSICS.impulseScale), f32(mv.z * PHYSICS.impulseScale), accel, cmd.yaw);

  let jumped = false;
  if (cmd.jump && s.onGround && s.jumpTicks === 0) {
    v.y = Math.max(f32(PHYSICS.jumpVelocity), v.y);
    if (s.sprinting) {
      const { s: sin, c: cos } = yawSinCos(cmd.yaw);
      v.x = f32(v.x - sin * PHYSICS.sprintJumpBoost);
      v.z = f32(v.z + cos * PHYSICS.sprintJumpBoost);
    }
    s.jumpTicks = PHYSICS.jumpCooldown;
    jumped = true;
  }

  // Track AJ: on a climbable block (ladder, vine ...) the fall speed is clamped and a climb lifts the body
  const climbing = onClimbable(world, s.pos);
  if (climbing) {
    const c = CLIMB.maxFall;
    if (v.y < -c) v.y = f32(-c);
    if (cmd.sneak && v.y < 0) v.y = 0;
    // the jump key climbs at once: the rise is this tick's move, also replacing a faster rise (BDS 1.26.60)
    if (cmd.jump) v.y = f32(CLIMB.up);
  }

  // Track AJ: a sneaking body on the ground does not walk off an edge (the move backs off in 0.05 steps)
  if (s.sneaking && s.onGround && v.y <= 0) {
    const b = backOffFromEdge(world, s.pos, v.x, v.z, height);
    if (b) {
      v.x = b.x;
      v.z = b.z;
    }
  }

  const m = moveBody(world, s.pos, v, s.onGround, height);
  if (!m) return { state: cloneBody(prev), jumped: false, simulated: false };
  s.pos = { x: f32(s.pos.x + m.dx), y: f32(s.pos.y + m.dy), z: f32(s.pos.z + m.dz) };
  s.collidedHorizontally = m.collidedHorizontally;
  s.collidedVertically = m.collidedVertically;
  s.onGround = m.onGround;
  if (m.dx !== v.x) v.x = 0;
  if (m.dz !== v.z) v.z = 0;
  if (m.dy !== v.y) v.y = 0;

  v.y = f32(f32(v.y - PHYSICS.gravity) * PHYSICS.drag);
  v.x = f32(v.x * inertia);
  v.z = f32(v.z * inertia);
  // Track AJ: pushing against a wall sets the next tick's rise after gravity and drag (BDS 1.26.60)
  if (climbing && m.collidedHorizontally) v.y = f32(CLIMB.up);
  return { state: s, jumped, simulated: true };
}

/**
 * Liquid movement (vanilla rules; constants as bedboo lists them for Bedrock: LiteLDev/bedboo,
 * LGPL-3.0, packages/mineflayer-bedrock/lib/physics/engine.js; no code copied). Water: acceleration
 * 0.02, drag 0.8 on all axes, gravity 0.005, jump key +0.04 per tick, +0.3 upwards when pushing
 * against a wall that can be climbed out of (Track AJ: the moved box must hold no collision and no
 * liquid cell). Lava: drag 0.5, gravity 0.02. Track AJ, measured on BDS 1.26.60: the water physics
 * (and its jump impulse) apply only while the body box shrunk by 0.4 at the feet and at the head
 * (`waterInset`) reaches into a water cell (whole cells); above that the body moves with air
 * physics. Flow push is not modelled: the planner swims only on still water (nav/grid.ts `swim`).
 */
export const LIQUID = Object.freeze({
  water: { accel: 0.02, drag: 0.8, gravity: 0.005, jump: 0.04 },
  lava: { accel: 0.02, drag: 0.5, gravity: 0.02, jump: 0.04 },
  climbOut: 0.3,
  /** Track AJ: the water movement test shrinks the body box by this much at the feet and the head. */
  waterInset: 0.4,
});

function stepInLiquid(
  s: BodyState,
  cmd: MoveCommand,
  world: BlockQuery,
  height: number,
  k: { accel: number; drag: number; gravity: number; jump: number },
  prev: BodyState,
): StepResult {
  const v = s.vel;
  if (cmd.jump) v.y = f32(v.y + k.jump);
  const mv = moveVectorOf(cmd);
  applyImpulse(v, f32(mv.x * PHYSICS.impulseScale), f32(mv.z * PHYSICS.impulseScale), k.accel, cmd.yaw);
  const m = moveBody(world, s.pos, v, s.onGround, height);
  if (!m) return { state: cloneBody(prev), jumped: false, simulated: false };
  s.pos = { x: f32(s.pos.x + m.dx), y: f32(s.pos.y + m.dy), z: f32(s.pos.z + m.dz) };
  s.collidedHorizontally = m.collidedHorizontally;
  s.collidedVertically = m.collidedVertically;
  s.onGround = m.onGround;
  if (m.dx !== v.x) v.x = 0;
  if (m.dz !== v.z) v.z = 0;
  if (m.dy !== v.y) v.y = 0;
  v.x = f32(v.x * k.drag);
  v.y = f32(f32(v.y * k.drag) - k.gravity);
  v.z = f32(v.z * k.drag);
  if (s.collidedHorizontally) {
    // vanilla isFree(vx, vy + 0.6 - dy, vz): the box moved there would not collide with anything
    const off = { x: v.x, y: v.y + 0.6 - m.dy, z: v.z };
    const region = sweepBox(playerBox(s.pos, height), off.x, off.y, off.z);
    const boxes = solidBoxes(world, region);
    const moved = offsetBox(playerBox(s.pos, height), off.x, off.y, off.z);
    // Track AJ: and holds no liquid (vanilla isLiquidPresentInAABB: free of collisions and of liquid cells)
    if (boxes && !boxes.some((o) => overlaps(o, moved, contactEpsilon(s.pos))) && !anyLiquid(world, moved)) v.y = f32(LIQUID.climbOut);
  }
  return { state: s, jumped: false, simulated: true };
}

/** Track AJ: some cell the box overlaps holds a liquid (whole cells; unknown cells count as liquid). */
function anyLiquid(world: BlockQuery, b: Box): boolean {
  if (!world.liquidAt) return false;
  for (let y = Math.floor(b[1]); y < Math.ceil(b[4]); y++)
    for (let z = Math.floor(b[2]); z < Math.ceil(b[5]); z++)
      for (let x = Math.floor(b[0]); x < Math.ceil(b[3]); x++) if (world.liquidAt(x, y, z) !== null) return true;
  return false;
}

function overlaps(a: Box, b: Box, e: number = E): boolean {
  return a[0] < b[3] - e && a[3] > b[0] + e && a[1] < b[4] - E && a[4] > b[1] + E && a[2] < b[5] - e && a[5] > b[2] + e;
}

/**
 * Track AJ: climbing, measured on BDS 1.26.60 (docs/pathfinding.md "Movement variety"). On a climbable
 * block (the block containing the feet: ladder, vines) the fall speed is clamped to `maxFall` before
 * the move (a slide of 0.2 blocks per tick), sneaking holds the body (no slide), the jump key sets
 * vy = `up` before the move (also replacing a faster rise), and a body that hit a wall during the move
 * gets vy = `up` after gravity and drag (the rise of the next tick). No horizontal clamp.
 */
export const CLIMB = Object.freeze({ maxFall: 0.2, up: 0.2 });

/** Track AJ: the edge test reads the box shrunk by this much on each horizontal side (fits the measured stops). */
const EDGE_INSET = 0.025;

/** Track AJ: the body with feet at `p` is on a climbable block (the block containing the feet). */
export function onClimbable(world: BlockQuery, p: Vec3): boolean {
  return world.climbableAt?.(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === true;
}

/**
 * Track AJ: sneak edge avoidance (vanilla maybeBackOffFromEdge, measured on BDS 1.26.60: a sneaking
 * body stops with its box 0.03 to 0.05 over the edge block). The horizontal move (dx, dz) is reduced
 * in 0.05 steps towards 0 while the box moved by it and `stepHeight` down meets no block: x first,
 * then z, then both (the test box is shrunk by EDGE_INSET on each horizontal side). undefined when
 * the world around is unknown.
 */
export function backOffFromEdge(world: BlockQuery, p: Vec3, dx: number, dz: number, height: number = PHYSICS.height): { x: number; z: number } | undefined {
  const box = playerBox(p, height);
  const down = -PHYSICS.stepHeight;
  const region = sweepBox(sweepBox(box, dx, down, dz), 0, 0, 0);
  const boxes = solidBoxes(world, region);
  if (!boxes) return undefined;
  const free = (ox: number, oz: number): boolean => {
    const moved = offsetBox(box, ox, down, oz);
    moved[0] += EDGE_INSET;
    moved[2] += EDGE_INSET;
    moved[3] -= EDGE_INSET;
    moved[5] -= EDGE_INSET;
    return !boxes.some((o) => overlaps(o, moved));
  };
  const towardsZero = (d: number): number => (d < 0.05 && d >= -0.05 ? 0 : d > 0 ? d - 0.05 : d + 0.05);
  while (dx !== 0 && free(dx, 0)) dx = towardsZero(dx);
  while (dz !== 0 && free(0, dz)) dz = towardsZero(dz);
  while (dx !== 0 && dz !== 0 && free(dx, dz)) {
    dx = towardsZero(dx);
    dz = towardsZero(dz);
  }
  return { x: f32(dx), z: f32(dz) };
}

/**
 * Track AU: the elytra glide, measured on BDS 1.26.60.6 (docs/flight.md "Physics"): the vanilla
 * (Java) fall-flying formula, bit for bit in float32, with the firework boost applied inside the
 * step after the lift, dive and heading terms and BEFORE the drag (per-tick server samples: every
 * boosted tick within 0.001 of the server; the Java order "boost in the rocket's tick" is off by 0.01
 * per tick). Per tick, with the look vector l (unit, pitch +90 = down), h = horizontal speed:
 *   vy += 0.08 * (-1 + cos(pitch)^2 * 0.75)                              (lift: less gravity when level)
 *   if vy < 0:  d = -0.1 * vy * cos^2;   v += (lx / cos, 1, lz / cos) * d  (a dive trades height for speed)
 *   if pitch < 0 (looking up):  d = h * -sin(pitch) * 0.04;  v += (-lx / cos * d, 3.2 * d, -lz / cos * d)
 *   v.xz += (l.xz / cos * h - v.xz) * 0.1                                 (the heading follows the look)
 *   boost (while a rocket lives): v += l * 0.1 + (l * 1.5 - v) * 0.5
 *   v *= (0.99, 0.98, 0.99); move with a 0.6-high box (the server sets boundingbox_height 0.6)
 * Measured: level flight sinks 0.15 to 0.17 blocks/tick, a flight-duration-1 rocket boosts 12 to 18
 * ticks (`boostTicks` 15 is the nominal; the rocket's remove_entity ends it) and pulls the speed
 * towards 1.7 blocks/tick along the look. The glide ends on the ground or in water.
 */
export const GLIDE = Object.freeze({
  gravity: 0.08,
  lift: 0.75,
  dive: 0.1,
  pull: 0.04,
  pullLift: 3.2,
  align: 0.1,
  dragH: 0.99,
  dragV: 0.98,
  /** Collision box height while gliding. */
  height: 0.6,
  boostPush: 0.1,
  boostTarget: 1.5,
  boostGain: 0.5,
  /** Nominal boost ticks of one flight-duration-1 rocket (measured 12 to 18 on bds-fly, median 15; vanilla 10 + random 0..11); the rocket's remove_entity ends it early or late. */
  boostTicks: 15,
});

/** Unit look vector in float32 for Bedrock yaw / pitch degrees (pitch +90 = down), with sin / cos(pitch). */
export function lookVector(yawDeg: number, pitchDeg: number): { x: number; y: number; z: number; cos: number; sin: number } {
  const yaw = f32(f32(yawDeg) * f32(Math.PI / 180));
  const pitch = f32(f32(pitchDeg) * f32(Math.PI / 180));
  const cp = f32(Math.cos(pitch));
  const sp = f32(Math.sin(pitch));
  return { x: f32(-f32(Math.sin(yaw)) * cp), y: f32(-sp), z: f32(f32(Math.cos(yaw)) * cp), cos: cp, sin: sp };
}

/** One glide tick on the velocity alone (no collisions): the formula above, float32. */
export function glideVelocity(vel: Vec3, yawDeg: number, pitchDeg: number, boosting: boolean): Vec3 {
  const l = lookVector(yawDeg, pitchDeg);
  let vx = vel.x;
  let vy = vel.y;
  let vz = vel.z;
  const h = f32(Math.sqrt(vx * vx + vz * vz));
  const cos2 = f32(l.cos * l.cos);
  vy = f32(vy + f32(GLIDE.gravity * f32(-1 + f32(cos2 * GLIDE.lift))));
  if (vy < 0 && l.cos > 0) {
    const d = f32(f32(vy * -GLIDE.dive) * cos2);
    vx = f32(vx + f32(f32(l.x * d) / l.cos));
    vy = f32(vy + d);
    vz = f32(vz + f32(f32(l.z * d) / l.cos));
  }
  if (pitchDeg < 0 && l.cos > 0) {
    const d = f32(f32(h * -l.sin) * GLIDE.pull);
    vx = f32(vx + f32(f32(-l.x * d) / l.cos));
    vy = f32(vy + f32(d * GLIDE.pullLift));
    vz = f32(vz + f32(f32(-l.z * d) / l.cos));
  }
  if (l.cos > 0) {
    vx = f32(vx + f32(f32(f32(f32(l.x / l.cos) * h) - vx) * GLIDE.align));
    vz = f32(vz + f32(f32(f32(f32(l.z / l.cos) * h) - vz) * GLIDE.align));
  }
  if (boosting) {
    vx = f32(vx + f32(f32(l.x * GLIDE.boostPush) + f32(f32(f32(l.x * GLIDE.boostTarget) - vx) * GLIDE.boostGain)));
    vy = f32(vy + f32(f32(l.y * GLIDE.boostPush) + f32(f32(f32(l.y * GLIDE.boostTarget) - vy) * GLIDE.boostGain)));
    vz = f32(vz + f32(f32(l.z * GLIDE.boostPush) + f32(f32(f32(l.z * GLIDE.boostTarget) - vz) * GLIDE.boostGain)));
  }
  return { x: f32(vx * GLIDE.dragH), y: f32(vy * GLIDE.dragV), z: f32(vz * GLIDE.dragH) };
}

/** Track AU: one gliding tick of the body (velocity by `glideVelocity`, then the 0.6-high box moves). */
function stepGliding(s: BodyState, cmd: MoveCommand, world: BlockQuery, prev: BodyState): StepResult {
  const boosting = (s.boostTicks ?? 0) > 0;
  const v = glideVelocity(s.vel, cmd.yaw, cmd.pitch, boosting);
  if (boosting) s.boostTicks = (s.boostTicks ?? 0) - 1;
  const m = moveBody(world, s.pos, v, false, GLIDE.height);
  if (!m) return { state: cloneBody(prev), jumped: false, simulated: false };
  s.pos = { x: f32(s.pos.x + m.dx), y: f32(s.pos.y + m.dy), z: f32(s.pos.z + m.dz) };
  s.collidedHorizontally = m.collidedHorizontally;
  s.collidedVertically = m.collidedVertically;
  s.onGround = m.onGround;
  if (m.dx !== v.x) v.x = 0;
  if (m.dz !== v.z) v.z = 0;
  if (m.dy !== v.y) v.y = 0;
  s.vel = v;
  if (s.onGround) {
    s.gliding = false; // ground contact ends the glide (stop_gliding goes out)
    s.boostTicks = 0;
  }
  return { state: s, jumped: false, simulated: true };
}

/** The own engine as a PhysicsEngine. */
export const ownEngine: PhysicsEngine = { name: 'own', step: stepBody };
