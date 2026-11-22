// Cells of a Java structure file to BuildBlocks (Track B2, docs/build.md "Java blocks"): each palette entry is
// mapped once (java.ts), air is left out, and a block with no Bedrock block is counted under its Java state with
// the reason, for `!build materials` and the refusal (or `skip unknown`).
import type { BuildBlock } from '../types.ts';
import { javaToBedrock, type JavaBlock, type Mapped } from './java.ts';
import type { StructureFormat, Structure, UnknownBlock } from './mcstructure.ts';

export class JavaCells {
  readonly blocks: BuildBlock[] = [];
  private readonly unknown = new Map<string, UnknownBlock>();
  private readonly version: string | undefined;

  constructor(version?: string) {
    this.version = version;
  }

  /** Map a palette (one Mapped per entry). */
  palette(entries: readonly JavaBlock[]): Mapped[] {
    return entries.map((b) => javaToBedrock(b, this.version));
  }

  add(x: number, y: number, z: number, m: Mapped): void {
    if (!m.ok) {
      const u = this.unknown.get(m.java);
      if (u) u.count++;
      else this.unknown.set(m.java, { java: m.java, count: 1, reason: m.reason });
      return;
    }
    if (m.name === 'air') return;
    this.blocks.push({ pos: { x, y, z }, name: m.name, ...(Object.keys(m.states).length ? { states: m.states } : {}) });
  }

  /** A cell the file names by something other than a block state (an MCEdit id no table knows). */
  addUnknown(java: string, reason: string): void {
    const u = this.unknown.get(java);
    if (u) u.count++;
    else this.unknown.set(java, { java, count: 1, reason });
  }

  structure(name: string, size: Structure['size'], format: StructureFormat): Structure {
    const unknown = [...this.unknown.values()].sort((a, b) => b.count - a.count || a.java.localeCompare(b.java));
    return { name, size, blocks: this.blocks, format, ...(unknown.length ? { unknown } : {}) };
  }
}
