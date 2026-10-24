// Fakes for the Track V combat unit tests (targeting.test.ts, combat-survive.test.ts): a flat grid
// with solid cells, shaped like NavGrid for reachability and cover.
import type { GridLike } from '../../../src/skills/combat/targeting.ts';
import type { TerrainClass } from '../../../src/skills/terrain/classify.ts';

/** A flat floor (top of y = -61), plus solid cells; feet at -60. */
export class FlatGrid implements GridLike {
  readonly solid = new Set<string>();
  private readonly floorY: number;
  constructor(floorY = -61) {
    this.floorY = floorY;
  }
  add(x: number, y: number, z: number): this {
    this.solid.add(`${x},${y},${z}`);
    return this;
  }
  isSolid(x: number, y: number, z: number): boolean {
    return y <= this.floorY || this.solid.has(`${x},${y},${z}`);
  }
  cls(x: number, y: number, z: number): TerrainClass | undefined {
    const s = this.isSolid(x, y, z);
    return { boxes: s ? [[0, 0, 0, 1, 1, 1]] : [], top: s ? 1 : 0, leaves: false, floor: s } as unknown as TerrainClass;
  }
  stand(x: number, y: number, z: number): number {
    if (this.isSolid(x, y, z) || this.isSolid(x, y + 1, z) || !this.isSolid(x, y - 1, z)) return NaN;
    return y;
  }
}
