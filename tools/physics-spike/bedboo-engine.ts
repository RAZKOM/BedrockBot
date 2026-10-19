// Loads LiteLDev/bedboo's Bedrock physics engine (LGPL-3.0, prismarine-physics fork) from the
// fetched tree in .work/bedboo (see fetch.mjs) and wraps it as the bot's PhysicsEngine, so the same
// InputLoop (flags, ticks, corrections) can drive either engine. Nothing from bedboo is copied:
// its files are `require`d from .work at run time. It needs only `vec3` (this package's dependency,
// found by walking up from .work) and a shim for the registry and world objects it reads:
//   registry: { blocksByName: { name: { id } }, blocksArray: [{ id, name, friction }] }
//   world.getBlock(vec3) -> { type, name, shapes: [[x0,y0,z0,x1,y1,z1]], boundingBox, metadata } | null
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moveVectorOf, solidBoxes, playerBox } from '../../bot/src/skills/input/index.ts';
import type { BlockQuery, BodyState, MoveCommand, PhysicsEngine, StepResult } from '../../bot/src/skills/input/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const BEDBOO_PHYSICS = join(here, '.work', 'bedboo', 'packages', 'mineflayer-bedrock', 'lib', 'physics', 'index.js');

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface BedbooEntity {
  pos: V3;
  vel: V3;
  onGround: boolean;
  control: Record<string, boolean>;
  yaw: number;
  pitch: number;
  jumpTicks: number;
  moveVector: { x: number; z: number };
  isCollidedHorizontally?: boolean;
  isCollidedVertically?: boolean;
  jumped?: boolean;
}
interface BedbooBlock {
  type: number;
  name: string;
  shapes: number[][];
  boundingBox: string;
  metadata: number;
}
interface BedbooWorld {
  getBlock(p: V3): BedbooBlock | null;
}
interface BedbooModule {
  Physics(registry: unknown, world: BedbooWorld): { simulatePlayer(entity: BedbooEntity, world: BedbooWorld): BedbooEntity };
}

const AIR: BedbooBlock = { type: 0, name: 'air', shapes: [], boundingBox: 'empty', metadata: 0 };
const STONE: BedbooBlock = { type: 1, name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block', metadata: 0 };
const REGISTRY = {
  blocksByName: { air: { id: 0, name: 'air' }, stone: { id: 1, name: 'stone' } },
  blocksArray: [
    { id: 0, name: 'air', friction: 0.6 },
    { id: 1, name: 'stone', friction: 0.6 },
  ],
};

export function bedbooAvailable(): boolean {
  return existsSync(BEDBOO_PHYSICS);
}

/** A PhysicsEngine backed by bedboo's `simulatePlayer`. */
export function loadBedbooEngine(): PhysicsEngine {
  if (!bedbooAvailable()) throw new Error(`bedboo not fetched: ${BEDBOO_PHYSICS} missing (run \`node fetch.mjs\`)`);
  const require = createRequire(import.meta.url);
  const mod = require(BEDBOO_PHYSICS) as BedbooModule;
  const { Vec3 } = require('vec3') as { Vec3: new (x: number, y: number, z: number) => V3 };

  let current: BlockQuery = { solidAt: () => false };
  const world: BedbooWorld = {
    getBlock(p) {
      const s = current.solidAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (s === undefined) return null;
      return s ? STONE : AIR;
    },
  };
  const physics = mod.Physics(REGISTRY, world);

  return {
    name: 'bedboo',
    step(prev: BodyState, cmd: MoveCommand, q: BlockQuery): StepResult {
      // same "unknown world" rule as the own engine: do not simulate without data
      const b = playerBox(prev.pos);
      if (!solidBoxes(q, [b[0] - 2, b[1] - 2, b[2] - 2, b[3] + 2, b[4] + 2, b[5] + 2])) {
        return { state: { ...prev, pos: { ...prev.pos }, vel: { ...prev.vel } }, jumped: false, simulated: false };
      }
      current = q;
      const sprint = cmd.sprint && cmd.forward > 0 && !cmd.sneak;
      const entity: BedbooEntity = {
        pos: new Vec3(prev.pos.x, prev.pos.y, prev.pos.z),
        vel: new Vec3(prev.vel.x, prev.vel.y, prev.vel.z),
        onGround: prev.onGround,
        control: {
          forward: cmd.forward > 0,
          back: cmd.forward < 0,
          left: cmd.strafe < 0,
          right: cmd.strafe > 0,
          jump: cmd.jump,
          sprint,
          sneak: cmd.sneak,
        },
        // mineflayer yaw (radians, 0 = -z, counter-clockwise); bedboo converts back to Bedrock degrees
        yaw: Math.PI - (cmd.yaw * Math.PI) / 180,
        pitch: (-cmd.pitch * Math.PI) / 180,
        jumpTicks: prev.jumpTicks,
        moveVector: moveVectorOf(cmd),
        isCollidedHorizontally: prev.collidedHorizontally,
        isCollidedVertically: prev.collidedVertically,
      };
      const out = physics.simulatePlayer(entity, world);
      return {
        state: {
          pos: { x: out.pos.x, y: out.pos.y, z: out.pos.z },
          vel: { x: out.vel.x, y: out.vel.y, z: out.vel.z },
          onGround: out.onGround,
          collidedHorizontally: !!out.isCollidedHorizontally,
          collidedVertically: !!out.isCollidedVertically,
          jumpTicks: out.jumpTicks,
          sprinting: sprint,
          sneaking: cmd.sneak,
        },
        jumped: !!out.jumped,
        simulated: true,
      };
    },
  };
}
