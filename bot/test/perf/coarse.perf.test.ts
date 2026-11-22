// The opt-in perf project (`pnpm test:perf`, Track REL3, docs/testing.md "The perf project"): coarse-perf.test.ts's
// former wall-clock bounds (Track CB, ADR 0066, docs/coarse.md "Budget": a corridor across a 64 x 64-chunk cached area
// in well under the 500 ms default, cold and warm), as they were. The unit run keeps the work side (statuses, the
// corridor's length, no chunk graph built again warm: coarse-perf.test.ts).
import { describe, expect, it } from 'vitest';
import { CoarseLayerImpl } from '../../src/skills/coarse/index.ts';
import { hillySource } from '../unit/skills/coarse-world.ts';

describe('coarse layer: budget (Track CB), wall clock', () => {
  it('plans across a 64 x 64-chunk area cold in well under 500 ms, warm faster', async () => {
    const src = hillySource(7);
    const layer = new CoarseLayerImpl(src, { maxChunks: 8192 });
    const start = { x: 8.5, y: -49, z: 8.5 };
    const goal = { x: 1015.5, y: -49, z: 1015.5 };
    const cold = await layer.plan({ start, goal, modes: ['walk'], maxMs: 5000, maxNodes: 2_000_000 });
    expect(cold.status, cold.reason).toBe('found');
    const warm = await layer.plan({ start, goal, modes: ['walk'], maxMs: 5000, maxNodes: 2_000_000 });
    expect(warm.status, warm.reason).toBe('found');
    const info = layer.info();
    console.log(
      `coarse perf: cold ${cold.ms.toFixed(1)} ms (${cold.expanded} expanded, ${Math.round(cold.blocks)} blocks, ${cold.legs[0]!.waypoints.length} waypoints), warm ${warm.ms.toFixed(1)} ms; ` +
        `${info.graph.builds} chunk builds ${info.graph.buildMs.toFixed(1)} ms, ${info.graph.borders} borders ${info.graph.borderMs.toFixed(1)} ms, ${info.chunks} graphs in memory`,
    );
    expect(cold.ms).toBeLessThan(500);
    expect(warm.ms).toBeLessThan(cold.ms);
    const mine = await layer.plan({ start, goal, modes: ['walk', 'mine'], maxMs: 5000, maxNodes: 2_000_000 });
    expect(mine.status, mine.reason).toBe('found');
    console.log(`coarse perf: walk + mine warm ${mine.ms.toFixed(1)} ms (${mine.expanded} expanded)`);
    expect(mine.ms).toBeLessThan(500);
  });
});
