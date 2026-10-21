// Fallback for collect_drops while the Skills facade's collect() is a stub (Track H fills it in,
// PLAN.md task 4.4): walk onto each item drop within `radius`, nearest first, until none is left
// or the tick budget is spent. Pickup itself is the server's (the bot only has to stand close).
import type { Goal, GotoOptions, SkillResult } from '../skills/types.ts';
import type { EntityInfo, Vec3 } from '../world/types.ts';

export interface CollectDeps {
  world: { readonly entities: ReadonlyMap<bigint, EntityInfo> };
  loop: { readonly state: { pos: Vec3; tick: bigint }; waitTicks(n: number): Promise<void> };
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  /** True once cancel() was called for this run. */
  cancelled(): boolean;
}

const hd = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

export function dropsNear(entities: ReadonlyMap<bigint, EntityInfo>, feet: Vec3, radius: number): EntityInfo[] {
  const out: EntityInfo[] = [];
  for (const e of entities.values()) {
    if (e.type !== 'minecraft:item') continue;
    if (hd(e.pos, feet) <= radius && Math.abs(e.pos.y - feet.y) <= 4) out.push(e);
  }
  return out.sort((a, b) => hd(a.pos, feet) - hd(b.pos, feet));
}

export async function collectDrops(d: CollectDeps, radius: number, timeoutTicks: number): Promise<SkillResult> {
  const start = d.loop.state.tick;
  const left = () => timeoutTicks - Number(d.loop.state.tick - start);
  const tried = new Set<bigint>();
  for (;;) {
    if (d.cancelled()) return { ok: false, reason: 'interrupted' };
    const feet = d.loop.state.pos;
    const drops = dropsNear(d.world.entities, feet, radius);
    if (drops.length === 0) return { ok: true };
    const next = drops.find((e) => !tried.has(e.runtimeId));
    if (!next) return { ok: false, reason: 'unreachable' };
    if (left() <= 0) return { ok: false, reason: 'timeout' };
    tried.add(next.runtimeId);
    const r = await d.goto({ type: 'xz', x: next.pos.x, z: next.pos.z }, { timeoutTicks: Math.max(1, left()), sprint: false });
    if (!r.ok && (r.reason === 'interrupted' || d.cancelled())) return { ok: false, reason: 'interrupted' };
    // Give the server a few ticks to hand the item over.
    for (let i = 0; i < 4 && d.world.entities.has(next.runtimeId) && left() > 0; i++) await d.loop.waitTicks(1);
  }
}
