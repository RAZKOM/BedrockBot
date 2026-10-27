// Fakes for the builder unit tests (Track AL): a flat block world and a bot that walks by teleporting,
// places and digs instantly, pillars up and falls.
import type { Vec3 } from '../../../src/world/types.ts';
import type { RunnerDeps } from '../../../src/skills/build/runner.ts';
import type { BlockLike } from '../../../src/skills/build/sim.ts';
import { key, type Cell } from '../../../src/skills/build/types.ts';
import { supportsOf } from '../../../src/skills/build/sim.ts';

export const FLOOR_Y = -61; // grass top at -61, feet at -60
const FULL: readonly (readonly number[])[] = [[0, 0, 0, 1, 1, 1]];

export function block(name: string): BlockLike {
  return name === 'air' ? { name, boxes: [] } : { name, boxes: FULL, hardness: name === 'bedrock' ? -1 : 1 };
}

/** Flat world: grass at FLOOR_Y, dirt below, air above; `set` changes cells. */
export class FlatWorld {
  readonly cells = new Map<string, BlockLike>();

  blockAt(p: Cell): BlockLike | undefined {
    const b = this.cells.get(key(p));
    if (b) return b;
    if (p.y > FLOOR_Y) return block('air');
    return block(p.y === FLOOR_Y ? 'grass_block' : 'dirt');
  }

  set(p: Cell, name: string): void {
    this.cells.set(key(p), block(name));
  }

  name(p: Cell): string {
    return this.blockAt(p)!.name;
  }
}

export class FakeInventory {
  readonly items = new Map<string, number>();
  constructor(init: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(init)) this.items.set(k, v);
  }
  count(name: string): number {
    return this.items.get(name) ?? 0;
  }
  add(name: string, n: number): void {
    this.items.set(name, this.count(name) + n);
  }
}

export interface FakeBotOptions {
  /** Refuse the first n placements (rejected). */
  rejectFirst?: number;
  /** goto fails for these feet cells. */
  unreachable?: Set<string>;
}

/** A bot over a FlatWorld for BuildRunner (RunnerDeps). */
export class FakeBot {
  readonly world: FlatWorld;
  readonly inv: FakeInventory;
  feet: Vec3;
  ground = true;
  readonly log: string[] = [];
  places = 0;
  digs = 0;
  gotos = 0;
  pillarJumps = 0;
  cancelled = 0;
  maxFeetY: number;
  private o: FakeBotOptions;
  throwawayMin = 16;
  onStep?: () => void;

  constructor(world: FlatWorld, inv: FakeInventory, feet: Vec3, o: FakeBotOptions = {}) {
    this.world = world;
    this.inv = inv;
    this.feet = feet;
    this.maxFeetY = feet.y;
    this.o = o;
  }

  private cell(): Cell {
    return { x: Math.floor(this.feet.x), y: Math.floor(this.feet.y + 1e-3), z: Math.floor(this.feet.z) };
  }

  private fall(): void {
    const c = this.cell();
    let y = c.y;
    while (this.world.blockAt({ x: c.x, y: y - 1, z: c.z })!.boxes.length === 0 && y > FLOOR_Y - 5) y--;
    this.feet = { ...this.feet, y };
  }

  deps(): RunnerDeps {
    return {
      blockAt: (p) => this.world.blockAt(p),
      position: () => this.feet,
      onGround: () => this.ground,
      goto: (g) => {
        this.gotos++;
        this.onStep?.();
        const goals = g.type === 'any' ? g.goals : [g];
        const first = goals.find((x) => x.type === 'block' && !this.o.unreachable?.has(key(x.p)));
        if (first?.type !== 'block') return Promise.resolve({ ok: false, reason: 'unreachable' });
        this.feet = { x: first.p.x + 0.5, y: first.p.y, z: first.p.z + 0.5 };
        this.log.push(`goto ${key(first.p)}`);
        return Promise.resolve({ ok: true });
      },
      place: (p, o) => {
        this.places++;
        this.onStep?.();
        if ((this.o.rejectFirst ?? 0) > 0) {
          this.o.rejectFirst!--;
          return Promise.resolve({ ok: false, reason: 'rejected' });
        }
        const items = Array.isArray(o.item) ? o.item : o.item ? [o.item] : [];
        const item = items.find((i) => this.inv.count(i) > 0);
        if (!item) return Promise.resolve({ ok: false, reason: 'no_item' });
        const c = this.cell();
        const pillar = p.x === c.x && p.y === c.y && p.z === c.z;
        if (this.world.blockAt(p)!.boxes.length > 0) return Promise.resolve({ ok: false, reason: 'occupied' });
        if (!pillar && supportsOf(this.world, p).length === 0) return Promise.resolve({ ok: false, reason: 'no_face' });
        if (!pillar && p.x === c.x && p.z === c.z && p.y === c.y + 1) return Promise.resolve({ ok: false, reason: 'in_body' });
        this.world.set(p, item);
        this.inv.add(item, -1);
        if (pillar) {
          this.pillarJumps++;
          this.feet = { ...this.feet, y: p.y + 1 };
          this.maxFeetY = Math.max(this.maxFeetY, this.feet.y);
        }
        this.log.push(`place ${key(p)} ${item}${pillar ? ' (pillar)' : ''}`);
        return Promise.resolve({ ok: true });
      },
      dig: (p) => {
        this.digs++;
        this.onStep?.();
        const b = this.world.blockAt(p)!;
        if (b.name === 'air') return Promise.resolve({ ok: false, reason: 'no_block' });
        this.world.set(p, 'air');
        this.inv.add(b.name, 1); // the drop, picked up at once
        this.log.push(`dig ${key(p)} ${b.name}`);
        this.fall();
        return Promise.resolve({ ok: true });
      },
      collect: () => Promise.resolve({ ok: true }),
      waitTicks: () => Promise.resolve(),
      inventory: this.inv,
      reserve: () => ({ throwawayMin: this.throwawayMin }),
      cancel: () => {
        this.cancelled++;
      },
    };
  }
}
