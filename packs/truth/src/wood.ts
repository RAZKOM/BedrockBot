// Wood-gathering commands (PLAN.md Phase 4 tasks 4.3 to 4.6, Track H): container contents, tree
// placement and block search. Stable @minecraft/server 2.10.0 only. Registered by main.ts through
// `woodHandlers(deps)`; see ../README.md ("Wood commands").
import { BlockComponentTypes, BlockPermutation, system, type Block, type BlockInventoryComponent, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, box, int, iterateBox, nsId, type Box, type Vec3 } from './protocol.js';
import { TREE_KINDS, treeShape } from './woodShapes.js';

/** What main.ts lends to these handlers. */
export interface WoodDeps {
  reply(cmd: string, id: string | null, ok: boolean, data: unknown, reason?: string): void;
  replyError(cmd: string, id: string | null, e: unknown): void;
  getBlock(dim: Dimension, p: Vec3): Block;
  assertLoaded(dim: Dimension, b: Box): void;
  overworld(): Dimension;
}

interface WoodCtx {
  cmd: string;
  id: string | null;
  async: boolean;
}

type WoodHandler = (args: string[], ctx: WoodCtx) => unknown;

/** Max blocks scanned by `find` (a system.runJob, yields every FIND_STEP blocks). */
const MAX_FIND_VOLUME = 1 << 20;
const FIND_STEP = 2048;

export function woodHandlers(deps: WoodDeps): Record<string, WoodHandler> {
  const { reply, replyError, getBlock, assertLoaded, overworld } = deps;

  const inventoryOf = (b: Block) => {
    const inv = b.getComponent(BlockComponentTypes.Inventory) as BlockInventoryComponent | undefined;
    const c = inv?.container;
    if (!c) throw new TruthError('no_container', `${b.typeId} at ${b.location.x} ${b.location.y} ${b.location.z} has no inventory`, { typeId: b.typeId });
    return c;
  };

  return {
    /**
     * container x y z [clear] -> {x, y, z, typeId, size, slots:[{slot, typeId, amount} | null], counts, cleared?}
     * Reads (and with `clear` empties) a block's inventory (chest, barrel, ...).
     */
    container(args) {
      const p = blockPos(args, 0);
      const dim = overworld();
      assertLoaded(dim, box(p, p));
      const b = getBlock(dim, p);
      const c = inventoryOf(b);
      const slots: ({ slot: number; typeId: string; amount: number } | null)[] = [];
      const counts: Record<string, number> = {};
      let total = 0;
      for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (it) {
          slots.push({ slot: i, typeId: it.typeId, amount: it.amount });
          counts[it.typeId] = (counts[it.typeId] ?? 0) + it.amount;
          total += it.amount;
        } else {
          slots.push(null);
        }
      }
      const clear = args[3] === 'clear';
      if (clear) c.clearAll();
      return { ...p, typeId: b.typeId, size: c.size, slots, counts, total, ...(clear ? { cleared: total } : {}) };
    },

    /**
     * tree x y z height [kind=oak] [persistent=0] -> {kind, logs:[[x,y,z]...], leaves, base}
     * A log column from (x, y, z) up `height` blocks with a leaf canopy (woodShapes.treeShape). Leaves
     * never replace logs or other non-air blocks. persistent=1 sets persistent_bit (no leaf decay).
     */
    tree(args) {
      const base = blockPos(args, 0);
      const height = int(args[3], 'height');
      const kind = (args[4] ?? 'oak').toLowerCase();
      if (!(TREE_KINDS as readonly string[]).includes(kind)) throw new TruthError('bad_args', `unknown tree kind ${kind}`, { kinds: TREE_KINDS });
      const persistent = args[5] === '1' || args[5] === 'true';
      let shape;
      try {
        shape = treeShape(base.x, base.y, base.z, height);
      } catch (e) {
        throw new TruthError('bad_args', String(e instanceof Error ? e.message : e));
      }
      const dim = overworld();
      const all = [...shape.logs, ...shape.leaves];
      const lo = { x: Math.min(...all.map((p) => p.x)), y: base.y, z: Math.min(...all.map((p) => p.z)) };
      const hi = { x: Math.max(...all.map((p) => p.x)), y: Math.max(...all.map((p) => p.y)), z: Math.max(...all.map((p) => p.z)) };
      assertLoaded(dim, box(lo, hi));
      const logId = nsId(`${kind}_log`);
      for (const p of shape.logs) getBlock(dim, p).setType(logId);
      let leafPerm: BlockPermutation;
      try {
        leafPerm = BlockPermutation.resolve(nsId(`${kind}_leaves`), persistent ? { persistent_bit: true } : {});
      } catch (e) {
        throw new TruthError('bad_args', `cannot resolve ${kind}_leaves: ${String(e)}`);
      }
      let leaves = 0;
      for (const p of shape.leaves) {
        const b = getBlock(dim, p);
        if (b.typeId !== 'minecraft:air') continue;
        b.setPermutation(leafPerm);
        leaves++;
      }
      return { kind, base, height, logs: shape.logs.map((p) => [p.x, p.y, p.z]), leaves, persistent };
    },

    /**
     * find x1 y1 z1 x2 y2 z2 pattern [max=4096] -> {count, byType, positions:[[x,y,z]...], truncated}
     * Blocks whose typeId (with namespace) contains `pattern` (e.g. `_log`, `chest`). Runs as a job.
     */
    find(args, ctx) {
      const b = box(blockPos(args, 0), blockPos(args, 3));
      const pattern = args[6];
      if (!pattern) throw new TruthError('bad_args', 'usage: find x1 y1 z1 x2 y2 z2 pattern [max]');
      const max = args[7] === undefined ? 4096 : int(args[7], 'max');
      if (b.volume > MAX_FIND_VOLUME) throw new TruthError('volume_too_large', `volume ${b.volume} > ${MAX_FIND_VOLUME}`, { volume: b.volume, max: MAX_FIND_VOLUME });
      const dim = overworld();
      assertLoaded(dim, b);
      ctx.async = true;
      const { cmd, id } = ctx;
      system.runJob(
        (function* () {
          try {
            const positions: number[][] = [];
            const byType: Record<string, number> = {};
            let count = 0;
            let n = 0;
            for (const p of iterateBox(b)) {
              const t = getBlock(dim, p).typeId;
              if (t.includes(pattern)) {
                count++;
                byType[t] = (byType[t] ?? 0) + 1;
                if (positions.length < max) positions.push([p.x, p.y, p.z]);
              }
              if (++n % FIND_STEP === 0) yield;
            }
            reply(cmd, id, true, { from: b.min, to: b.max, pattern, count, byType, positions, truncated: count > positions.length });
          } catch (e) {
            replyError(cmd, id, e);
          }
        })(),
      );
      return undefined;
    },
  };
}
