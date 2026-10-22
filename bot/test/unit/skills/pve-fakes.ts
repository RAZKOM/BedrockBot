// Fakes for the PvE / follow unit tests (combat.test.ts, follow.test.ts, pve.test.ts): a packet
// source, a loop that moves the body 0.2 blocks per tick along the yaw (no physics), and a mover
// whose goto stays pending until finish() or cancel().
import type { CombatLoop, CombatMover } from '../../../src/skills/combat/combat.ts';
import type { MoveCommand } from '../../../src/skills/input/types.ts';
import type { Goal } from '../../../src/skills/nav/goals.ts';
import type { SkillResult } from '../../../src/skills/types.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';

export class FakeSource {
  readonly handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  readonly sent: { name: string; params: Record<string, unknown> }[] = [];
  on(name: string, fn: (p: Record<string, unknown>) => void): () => void {
    let s = this.handlers.get(name);
    if (!s) this.handlers.set(name, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }
  emit(name: string, p: Record<string, unknown>): void {
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(p);
  }
  queue(name: string, params: Record<string, unknown>): void {
    this.sent.push({ name, params });
  }
}

type StepFn = (tick: bigint, s: { pos: Vec3; onGround: boolean; collidedHorizontally: boolean; ready: boolean }) => void;

/** A loop that moves the body by `forward` along the yaw (0.2 blocks per tick), no physics. */
export class FakeLoop implements CombatLoop {
  pos: Vec3 = { x: 0, y: -60, z: 0 };
  cmd: MoveCommand = { forward: 0, strafe: 0, yaw: 0, pitch: 0, jump: false, sneak: false, sprint: false };
  private readonly fns = new Set<StepFn>();
  tick = 0n;
  get state() {
    return { pos: { ...this.pos }, onGround: true, collidedHorizontally: false, ready: true };
  }
  get command(): Readonly<MoveCommand> {
    return { ...this.cmd };
  }
  setCommand(c: Partial<MoveCommand>): void {
    this.cmd = { ...this.cmd, ...c };
  }
  release(): void {
    this.setCommand({ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false });
  }
  onBeforeStep(fn: StepFn): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.tick++;
      for (const fn of [...this.fns]) fn(this.tick, this.state);
      const r = (this.cmd.yaw * Math.PI) / 180;
      // Bedrock yaw: 0 = +z, 90 = -x
      this.pos = { x: this.pos.x - Math.sin(r) * 0.2 * this.cmd.forward, y: this.pos.y, z: this.pos.z + Math.cos(r) * 0.2 * this.cmd.forward };
    }
  }
}

export class FakeMover implements CombatMover {
  gotos: { goal: Goal; sprint: boolean | undefined }[] = [];
  cancels = 0;
  private pending: ((r: SkillResult) => void) | undefined;
  readonly nav = { busy: false };
  goto(goal: Goal, opts?: { sprint?: boolean }): Promise<SkillResult> {
    this.cancel();
    this.gotos.push({ goal, sprint: opts?.sprint });
    this.nav.busy = true;
    return new Promise((r) => {
      this.pending = r;
    });
  }
  cancel(): void {
    this.cancels++;
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      this.nav.busy = false;
      p({ ok: false, reason: 'interrupted' });
    }
  }
  finish(r: SkillResult): void {
    const p = this.pending;
    this.pending = undefined;
    this.nav.busy = false;
    p?.(r);
  }
}

export function mob(rid: bigint, type: string, pos: Vec3, extra: Partial<EntityInfo> = {}): EntityInfo {
  return { runtimeId: rid, uniqueId: -rid, type, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0, ...extra };
}
