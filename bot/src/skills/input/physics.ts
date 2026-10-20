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

/** Which liquids the body box at feet `p` touches (box shrunk by 0.001, liquid surface heights respected). */
export function liquidContact(world: BlockQuery, p: Vec3, height: number = PHYSICS.height): { water: boolean; lava: boolean } {
  const out = { water: false, lava: false };
  if (!world.liquidAt) return out;
  const b = playerBox(p, height);
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
        if (y + l.height <= b[1] + d) continue;
        if (l.liquid === 'water') out.water = true;
        else out.lava = true;
      }
    }
  }
  return out;
}

const E = PHYSICS.contactEpsilon;

/** Clip a move of `d` along `axis` (0 = x, 1 = y, 2 = z) of box `b` against `obstacle`. */
export function clipAxis(obstacle: Box, b: Box, axis: Axis, d: number): number {
  const a1: Axis = axis === 0 ? 1 : 0;
  const a2: Axis = axis === 2 ? 1 : 2;
  // the boxes must overlap on the two other axes
  if (!(hi(obstacle, a1) > lo(b, a1) + E && lo(obstacle, a1) < hi(b, a1) - E)) return d;
  if (!(hi(obstacle, a2) > lo(b, a2) + E && lo(obstacle, a2) < hi(b, a2) - E)) return d;
  if (d > 0 && lo(obstacle, axis) >= hi(b, axis) - E) return Math.min(d, lo(obstacle, axis) - hi(b, axis));
  if (d < 0 && hi(obstacle, axis) <= lo(b, axis) + E) return Math.max(d, hi(obstacle, axis) - lo(b, axis));
  return d;
}

type Axis = 0 | 1 | 2;
const lo = (b: Box, a: Axis): number => (a === 0 ? b[0] : a === 1 ? b[1] : b[2]);
const hi = (b: Box, a: Axis): number => (a === 0 ? b[3] : a === 1 ? b[4] : b[5]);

function clipAll(boxes: Box[], b: Box, axis: Axis, d: number): number {
  for (const o of boxes) d = clipAxis(o, b, axis, d);
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
  const dy = clipAll(boxes, b, 1, wanted.y);
  b = offsetBox(b, 0, dy, 0);
  const dx = clipAll(boxes, b, 0, wanted.x);
  b = offsetBox(b, dx, 0, 0);
  const dz = clipAll(boxes, b, 2, wanted.z);
  let res = { dx, dy, dz };

  const blockedH = dx !== wanted.x || dz !== wanted.z;
  const landed = dy !== wanted.y && wanted.y < 0;
  if (blockedH && (wasOnGround || landed)) {
    let s = start;
    const up = clipAll(boxes, s, 1, step);
    s = offsetBox(s, 0, up, 0);
    const sx = clipAll(boxes, s, 0, wanted.x);
    s = offsetBox(s, sx, 0, 0);
    const sz = clipAll(boxes, s, 2, wanted.z);
    s = offsetBox(s, 0, 0, sz);
    const down = clipAll(boxes, s, 1, -up);
    if (sx * sx + sz * sz > dx * dx + dz * dz) res = { dx: sx, dy: up + down, dz: sz };
  }

  const collidedHorizontally = res.dx !== wanted.x || res.dz !== wanted.z;
  const collidedVertically = res.dy !== wanted.y;
  let onGround = collidedVertically && wanted.y < 0;
  // A body without vertical motion (e.g. right after a teleport) stays grounded while it rests on something.
  if (!onGround && wasOnGround && !collidedVertically && Math.abs(wanted.y) <= 1e-5) {
    const end = offsetBox(start, res.dx, res.dy, res.dz);
    onGround = clipAll(boxes, end, 1, -1e-3) !== -1e-3;
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
  const wet = liquidContact(world, s.pos, height);
  s.inWater = wet.water;
  s.inLava = wet.lava && !wet.water;
  if (wet.water || wet.lava) return stepInLiquid(s, cmd, world, height, wet.water ? LIQUID.water : LIQUID.lava, prev);

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
  const mv = moveVectorOf(cmd);
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
  return { state: s, jumped, simulated: true };
}

/**
 * Liquid movement (vanilla rules; constants as bedboo lists them for Bedrock: LiteLDev/bedboo,
 * LGPL-3.0, packages/mineflayer-bedrock/lib/physics/engine.js; no code copied). Water: acceleration
 * 0.02, drag 0.8 on all axes, gravity 0.005, jump key +0.04 per tick, +0.3 upwards when pushing
 * against a wall that can be climbed out of. Lava: drag 0.5, gravity 0.02. Flow push is not modelled
 * (the pathfinder never enters liquids; this only has to keep a body that fell in from being
 * corrected every tick).
 */
export const LIQUID = Object.freeze({
  water: { accel: 0.02, drag: 0.8, gravity: 0.005, jump: 0.04 },
  lava: { accel: 0.02, drag: 0.5, gravity: 0.02, jump: 0.04 },
  climbOut: 0.3,
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
    if (boxes && !boxes.some((o) => overlaps(o, moved))) v.y = f32(LIQUID.climbOut);
  }
  return { state: s, jumped: false, simulated: true };
}

function overlaps(a: Box, b: Box): boolean {
  return a[0] < b[3] - E && a[3] > b[0] + E && a[1] < b[4] - E && a[4] > b[1] + E && a[2] < b[5] - E && a[5] > b[2] + E;
}

/** The own engine as a PhysicsEngine. */
export const ownEngine: PhysicsEngine = { name: 'own', step: stepBody };
