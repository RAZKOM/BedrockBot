// Box checksum over block typeIds, the same rule as the truth pack's `truth:checksum`
// (packs/truth/README.md): visit the box in y, z, x order (x fastest), FNV-1a 32 over each typeId's
// ASCII bytes followed by one 0x00 byte; 8 lowercase hex digits.
import type { BlockInfo, Vec3 } from './types.ts';

export function typeIdOf(b: BlockInfo): string {
  return b.name.includes(':') ? b.name : `minecraft:${b.name}`;
}

export class Fnv1a32 {
  private h = 0x811c9dc5;

  update(s: string): void {
    let h = this.h;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    this.h = Math.imul(h, 0x01000193); // the 0x00 separator
  }

  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}

/** Checksum of the box between two corners (inclusive), or undefined if any block is not loaded. */
export function boxChecksum(blockAt: (p: Vec3) => BlockInfo | undefined, a: Vec3, b: Vec3): string | undefined {
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
  const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
  const f = new Fnv1a32();
  const p = { x: 0, y: 0, z: 0 };
  for (p.y = min.y; p.y <= max.y; p.y++) {
    for (p.z = min.z; p.z <= max.z; p.z++) {
      for (p.x = min.x; p.x <= max.x; p.x++) {
        const info = blockAt(p);
        if (!info) return undefined;
        f.update(typeIdOf(info));
      }
    }
  }
  return f.hex();
}
