// Fakes for the bridge unit tests: a block map world, a tick-driven loop, scripted skills.
import type { ActionLoop, ActionSkills } from '../../../src/bridge/actions.ts';
import type { ObsWorld } from '../../../src/bridge/observation.ts';
import type { Goal, SkillResult } from '../../../src/skills/types.ts';
import type { BlockInfo, EntityInfo, FindOptions, ItemStack, Vec3 } from '../../../src/world/types.ts';

export function block(name: string, solid = name !== 'air' && name !== 'water' && name !== 'short_grass'): BlockInfo {
  return { name, stateId: 1, states: {}, hardness: 1, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** Flat world: grass at y = -61 and below (dirt), air above; `set` overrides; unloaded beyond |x|,|z| > 64. */
export class FakeWorld implements ObsWorld {
  readonly blocks = new Map<string, BlockInfo>();
  readonly entities = new Map<bigint, EntityInfo>();
  readonly self = { health: 20, food: 20 };
  inventory: { slots: (ItemStack | null)[] } = { slots: new Array<ItemStack | null>(36).fill(null) };

  set(x: number, y: number, z: number, name: string): void {
    this.blocks.set(key(x, y, z), block(name));
  }

  blockAt(p: Vec3): BlockInfo | undefined {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    if (Math.abs(x) > 64 || Math.abs(z) > 64) return undefined;
    return this.blocks.get(key(x, y, z)) ?? block(y < -61 ? 'dirt' : y === -61 ? 'grass_block' : 'air');
  }

  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: FindOptions): Vec3[] {
    const out: { p: Vec3; d: number }[] = [];
    for (const [k, b] of this.blocks) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      const p = { x, y, z };
      const d = Math.hypot(x + 0.5 - opts.origin.x, y + 0.5 - opts.origin.y, z + 0.5 - opts.origin.z);
      if (d <= opts.radius && b.name !== 'air' && pred(b, p)) out.push({ p, d });
    }
    return out.sort((a, b) => a.d - b.d).slice(0, opts.max).map((o) => o.p);
  }

  give(slot: number, name: string, count: number): void {
    this.inventory.slots[slot] = { name, networkId: 1, count, metadata: 0 };
  }

  addItem(id: bigint, pos: Vec3, name = 'oak_log'): void {
    this.entities.set(id, {
      runtimeId: id,
      uniqueId: id,
      type: 'minecraft:item',
      item: { name, networkId: 1, count: 1, metadata: 0 },
      pos,
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      headYaw: 0,
      onGround: true,
      updatedAt: 0,
    });
  }
}

/** A loop that advances one tick per waitTicks(1) call (on a microtask), moving the body with `forward`. */
export class FakeLoop implements ActionLoop {
  state = { pos: { x: 0.5, y: -60, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, onGround: true, collidedHorizontally: false, tick: 100n, ready: true, corrections: 0 };
  command = { yaw: 0, pitch: 0, forward: 0, jump: false };
  /** Blocks per tick while forward is held (0 = wall). */
  speed = 0.2;

  setCommand(c: Partial<{ yaw: number; pitch: number; forward: number; jump: boolean }>): void {
    this.command = { ...this.command, ...c };
  }

  release(): void {
    this.command = { ...this.command, forward: 0, jump: false };
  }

  private waiters: { until: bigint; resolve: () => void }[] = [];
  private pumping = false;

  /** Resolves after n ticks of the shared tick counter (several waiters share one clock, like InputLoop). */
  waitTicks(n: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ until: this.state.tick + BigInt(n), resolve });
      if (!this.pumping) {
        this.pumping = true;
        setImmediate(() => this.pump());
      }
    });
  }

  private pump(): void {
    this.state.tick++;
    if (this.command.forward) {
      const y = (this.command.yaw * Math.PI) / 180;
      this.state.pos = { ...this.state.pos, x: this.state.pos.x - Math.sin(y) * this.speed, z: this.state.pos.z + Math.cos(y) * this.speed };
      this.state.collidedHorizontally = this.speed === 0;
    }
    const due = this.waiters.filter((w) => w.until <= this.state.tick);
    this.waiters = this.waiters.filter((w) => w.until > this.state.tick);
    for (const w of due) w.resolve();
    if (this.waiters.length) setImmediate(() => this.pump());
    else this.pumping = false;
  }
}

export class FakeSkills implements ActionSkills {
  calls: string[] = [];
  digResult: SkillResult = { ok: true };
  gotoTicks = 5;
  cancelled = 0;
  private readonly loop: FakeLoop;
  private readonly world: FakeWorld;
  /** Ticks a goto/dig takes before it returns (to test the cap). */
  hang = false;

  constructor(loop: FakeLoop, world: FakeWorld) {
    this.loop = loop;
    this.world = world;
  }

  async goto(goal: Goal): Promise<SkillResult> {
    this.calls.push(`goto ${JSON.stringify(goal)}`);
    let stop = false;
    const c = this.cancelled;
    for (let i = 0; i < (this.hang ? 1000 : this.gotoTicks) && !stop; i++) {
      await this.loop.waitTicks(1);
      if (this.cancelled !== c) stop = true;
    }
    if (stop) return { ok: false, reason: 'interrupted' };
    if (goal.type === 'near') this.loop.state.pos = { x: goal.p.x - 2, y: -60, z: goal.p.z };
    return { ok: true };
  }

  async lookAt(p: Vec3): Promise<void> {
    this.calls.push(`lookAt ${p.x},${p.y},${p.z}`);
    const dx = p.x - this.loop.state.pos.x;
    const dz = p.z - this.loop.state.pos.z;
    this.loop.setCommand({ yaw: (-Math.atan2(dx, dz) * 180) / Math.PI, pitch: 0 });
    await this.loop.waitTicks(1);
  }

  async dig(p: Vec3): Promise<SkillResult> {
    this.calls.push(`dig ${p.x},${p.y},${p.z}`);
    await this.loop.waitTicks(15);
    if (this.digResult.ok) this.world.set(p.x, p.y, p.z, 'air');
    return this.digResult;
  }

  async collect(radius: number, timeoutTicks: number): Promise<SkillResult> {
    this.calls.push(`collect ${radius} ${timeoutTicks}`);
    await this.loop.waitTicks(3);
    return { ok: true };
  }

  cancel(): void {
    this.cancelled++;
  }
}
