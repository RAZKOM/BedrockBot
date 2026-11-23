// Track B8 (decision 0133, docs/build.md "Map art"): the valley re-height and its pixel proof, the supports a valley art
// gets (never seen, never a column's top, every block with something to click at its turn), the free stands of the
// planner and `!build file <name> map ... valley`.
//
// The pixel proof runs on a generated staircase art of the owner file's shape (256 x 257 columns, steps of -1, 0 and +1
// north to south, any step east to west, 27 kinds) and, when B8_MAPART_FILE names a map art file, on that file too
// (B8_PRINT=<file> writes the heights before and after, strip by strip).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readStructure } from '../../../src/skills/build/formats/index.ts';
import type { Structure } from '../../../src/skills/build/formats/mcstructure.ts';
import { BuildJob, placeSections, TILE_SIDE } from '../../../src/skills/build/job.ts';
import { BuildProgress } from '../../../src/skills/build/progress.ts';
import { BuildRunner } from '../../../src/skills/build/runner.ts';
import { MAP_COLOURS, MAP_SUPPORT, mapArtObstacles, mapPixels, mapSupports, pixelColour, pixelDiffs, plantLike, stepShade, TREE_RE, valley, valleyText } from '../../../src/skills/build/mapart.ts';
import { planBuild, type Plan } from '../../../src/skills/build/plan.ts';
import { parseSpec } from '../../../src/skills/build/spec.ts';
import { add, key, type BuildBlock, type Cell } from '../../../src/skills/build/types.ts';
import { FakeBot, FakeInventory, FLOOR_Y, FlatWorld } from './build-fakes.ts';

const F = FLOOR_Y + 1;
const KINDS = Object.keys(MAP_COLOURS).filter((k) => !/grass|leaves|purple_concrete|mycelium|amethyst/.test(k)).slice(0, 27);

/** A small deterministic random (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A staircase map art as a map art tool writes it: x strips of `sz` columns (z = 0 the noob line), each block 1 up, level
 * or 1 down from the one north of it, every strip lifted so its lowest block is at 0, then the strips set at any height
 * to each other (as tools stack them: up to 144 high).
 */
function staircase(sx: number, sz: number, seed: number): Structure {
  const r = rng(seed);
  const blocks: BuildBlock[] = [];
  let maxY = 0;
  for (let x = 0; x < sx; x++) {
    const ys: number[] = [0];
    // runs: long descents and climbs (a dark or a light area of the picture), levels between
    let dir = 0;
    for (let z = 1; z < sz; z++) {
      if (r() < 0.15) dir = [-1, 0, 1][Math.floor(r() * 3)]!;
      ys.push(ys[z - 1]! + dir);
    }
    const lo = Math.min(...ys);
    const lift = Math.floor(r() * 40);
    for (let z = 0; z < sz; z++) {
      const y = ys[z]! - lo + lift;
      maxY = Math.max(maxY, y);
      blocks.push({ pos: { x, y, z }, name: KINDS[Math.floor(r() * KINDS.length)]! });
    }
  }
  return { name: 'art', size: { x: sx, y: maxY + 1, z: sz }, blocks };
}

const pixelsText = (n: number) => `${n} pixel${n === 1 ? '' : 's'}`;

describe('Track B8: the valley re-height', () => {
  it('keeps every step\'s shade and takes the least heights a Bedrock map shows it with: a step of 1 where the parity shows it, else 2', () => {
    // north to south: 5, 6, 6, 5, 4, 3, 9, 9, 2 -> up, level, down x3, up, level, down (x 0: z odd rises by 1, falls by 2)
    const ys = [5, 6, 6, 5, 4, 3, 9, 9, 2];
    const v = valley(ys.map((y, z) => ({ pos: { x: 0, y, z }, name: 'stone' })));
    // (z 2 and 7 are level steps the map shows level a block apart: up at z + x even, down at odd)
    expect(v.blocks.map((b) => b.pos.y)).toEqual([0, 4, 5, 3, 2, 0, 2, 1, 0]);
    expect(v.after).toBe(6);
    expect(v.before).toBe(8);
    expect(v.strips).toEqual([{ x: 0, before: [2, 9], after: [0, 5] }]);
    expect(valleyText(v)).toBe('valley 6 high (a strip 6 at the median), was 8');
    // one column east (the other parity): the steps of 1 and 2 swap
    const w = valley(ys.map((y, z) => ({ pos: { x: 0, y, z }, name: 'stone' })), { at: { x: 1, z: 0 } });
    expect(w.blocks.map((b) => b.pos.y)).toEqual([0, 4, 4, 3, 1, 0, 1, 2, 0]);
    expect(pixelDiffs(mapPixels(ys.map((y, z) => ({ pos: { x: 0, y, z }, name: 'stone' }))), mapPixels(w.blocks, { rule: 'bedrock', at: { x: 1, z: 0 } }))).toEqual([]);
  });

  it('starts a strip again after a gap in z, and refuses a column of two blocks', () => {
    const v = valley([
      { pos: { x: 0, y: 9, z: 0 }, name: 'stone' },
      { pos: { x: 0, y: 8, z: 1 }, name: 'stone' },
      { pos: { x: 0, y: 3, z: 3 }, name: 'stone' },
      { pos: { x: 0, y: 4, z: 4 }, name: 'stone' },
    ]);
    expect(v.blocks.map((b) => b.pos.y)).toEqual([2, 0, 0, 2]);
    expect(() =>
      valley([
        { pos: { x: 0, y: 1, z: 0 }, name: 'stone' },
        { pos: { x: 0, y: 2, z: 0 }, name: 'stone' },
      ]),
    ).toThrow(/1 columns hold more than one block/);
  });

  it('gives the same map, pixel for pixel, on a generated 2 x 2 map art (256 x 257 columns), much lower', () => {
    const s = staircase(256, 257, 7);
    const at = { x: -64, z: -65 };
    const v = valley(s.blocks, { at });
    const before = mapPixels(s.blocks);
    const after = mapPixels(v.blocks, { rule: 'bedrock', at });
    // the file as it is shows other shades on a Bedrock map (its steps of 1 at the wrong parity)
    expect(pixelDiffs(before, mapPixels(s.blocks, { rule: 'bedrock', at })).length).toBeGreaterThan(1000);
    expect(before.length).toBe(256 * 256);
    expect(pixelDiffs(before, after)).toEqual([]);
    expect(v.after).toBeLessThan(v.before);
    // every strip's lowest block at 0 (a strip of steps of 1 may grow: a Bedrock map needs 2 at half of them)
    for (const st of v.strips) expect(st.after[0]).toBe(0);
  });

  it('is minimal: lowering any one block changes a pixel or goes under 0', () => {
    const s = staircase(8, 129, 3);
    const v = valley(s.blocks);
    const after = mapPixels(v.blocks, { rule: 'bedrock' });
    for (let i = 0; i < v.blocks.length; i += 7) {
      const b = v.blocks[i]!;
      if (b.pos.y === 0) continue;
      const lower = v.blocks.map((c, j) => (j === i ? { ...c, pos: { ...c.pos, y: c.pos.y - 1 } } : c));
      expect(pixelDiffs(after, mapPixels(lower, { rule: 'bedrock' })).length).toBeGreaterThan(0);
    }
  });

  const file = process.env.B8_MAPART_FILE;
  it.skipIf(!file || !existsSync(file))('gives the same map on the map art file named by B8_MAPART_FILE (0 pixels differ), and reports its heights', () => {
    const s = readStructure(readFileSync(file!), 'litematic', 'art');
    // the build's corner for x z 0 0: the map square from -64 -64, the noob line one north of it
    const at = { x: -64, z: -65 };
    const v = valley(s.blocks, { at });
    const before = mapPixels(s.blocks);
    const diffs = pixelDiffs(before, mapPixels(v.blocks, { rule: 'bedrock', at }));
    const asIs = pixelDiffs(before, mapPixels(s.blocks, { rule: 'bedrock', at })).length;
    // and the build's own cells (the art re-heighted at its map corner, with its supports): the same pixels
    const r = parseSpec(['file', 'art', 'map', '0', String(F), '0', 'valley'], { load: () => s, solid: (_x, y) => y < F });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the map square holding 0 0 starts at -64 -64; the noob line one north of it
    const back = r.spec.places.map((p) => ({ ...p, pos: { x: p.pos.x + 64, y: p.pos.y - F, z: p.pos.z + 65 } }));
    const planDiffs = pixelDiffs(before, mapPixels(back, { rule: 'bedrock', at }));
    const highs = v.strips.map((x) => x.after[1] + 1).sort((a, b) => a - b);
    const line = `${s.blocks.length} blocks: ${pixelsText(before.length)}, ${diffs.length} differ re-heighted, ${planDiffs.length} differ in the build's cells (${r.spec.places.length - s.blocks.length} supports), ${asIs} differ built as it is on Bedrock; height ${v.before} -> ${v.after}; strips after: min ${highs[0]}, median ${highs[highs.length >> 1]}, p90 ${highs[Math.floor(highs.length * 0.9)]}, max ${highs.at(-1)}`;
    console.log(`[B8 valley] ${line}`);
    if (process.env.B8_PRINT) writeFileSync(process.env.B8_PRINT, `${line}\nx before_min before_max after_min after_max\n${v.strips.map((x) => `${x.x} ${x.before[0]} ${x.before[1]} ${x.after[0]} ${x.after[1]}`).join('\n')}\n`);
    expect(diffs).toEqual([]);
    expect(planDiffs).toEqual([]);
  });
});

/** Tile-local bottom-up check: in each tile every cell, placed a layer at a time, has a block or a placed cell to click. */
function clickOrderOk(cells: readonly Cell[], groundY: number, side: number, origin: { x: number; z: number }): { ok: boolean; stuck: Cell[] } {
  const tiles = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = `${Math.floor((c.x - origin.x) / side)},${Math.floor((c.z - origin.z) / side)}`;
    tiles.set(k, [...(tiles.get(k) ?? []), c]);
  }
  const stuck: Cell[] = [];
  for (const list of tiles.values()) {
    const placed = new Set<string>();
    const solid = (c: Cell) => c.y <= groundY || placed.has(key(c));
    const ys = [...new Set(list.map((c) => c.y))].sort((a, b) => a - b);
    for (const y of ys) {
      let todo = list.filter((c) => c.y === y);
      for (let moved = true; moved && todo.length; ) {
        moved = false;
        const next: Cell[] = [];
        for (const c of todo) {
          if ([add(c, 0, -1, 0), add(c, 1, 0, 0), add(c, -1, 0, 0), add(c, 0, 0, 1), add(c, 0, 0, -1)].some(solid)) {
            placed.add(key(c));
            moved = true;
          } else next.push(c);
        }
        todo = next;
      }
      stuck.push(...todo);
      for (const c of todo) placed.add(key(c)); // counted once
    }
  }
  return { ok: stuck.length === 0, stuck };
}

describe('Track B8: the supports', () => {
  const art = (s: Structure): BuildBlock[] => valley(s.blocks).blocks.map((b) => ({ ...b, pos: { x: b.pos.x, y: F + b.pos.y, z: b.pos.z } }));

  it('none for blocks on the ground or beside a level neighbour; one under a block a step up; a chain for a big step', () => {
    // a strip north to south at heights 0, 0, 1, 1, 4 (over flat ground at F - 1)
    const cells = [0, 0, 1, 1, 4].map((h, z) => ({ pos: { x: 0, y: F + h, z } }));
    const sup = mapSupports(cells, { side: 32, origin: { x: 0, z: 0 } });
    // z 2 (h 1) beside z 1 (h 0)? no: one under z 2 or z 3 at h 0 (beside z 1); z 4 (h 4): a chain down to h 1 beside z 3
    expect(sup.length).toBe(1 + 3);
    for (const c of sup) expect(cells.some((a) => a.pos.x === c.x && a.pos.z === c.z && a.pos.y > c.y)).toBe(true);
    expect(sup.filter((c) => c.z === 4).map((c) => c.y)).toEqual([F + 3, F + 2, F + 1]);
  });

  it('on a generated art: every support under its own column art block, none a top, every cell placeable in tile order', () => {
    const s = staircase(96, 129, 11);
    const cells = art(s);
    const sup = mapSupports(cells, { side: TILE_SIDE, origin: { x: 0, z: 0 } });
    const top = new Map(cells.map((c) => [`${c.pos.x},${c.pos.z}`, c.pos.y] as const));
    for (const c of sup) expect(c.y).toBeLessThan(top.get(`${c.x},${c.z}`)!);
    expect(new Set(sup.map(key)).size).toBe(sup.length);
    const check = clickOrderOk([...cells.map((c) => c.pos), ...sup], F - 1, TILE_SIDE, { x: 0, z: 0 });
    expect(check.stuck).toEqual([]);
    // the map still the same with the supports in (they are under the tops)
    expect(pixelDiffs(mapPixels(cells), mapPixels([...cells, ...sup.map((c) => ({ pos: c, name: MAP_SUPPORT }))]))).toEqual([]);
    // short chains: this random art (runs of 1 to 7) about 1.3 a block; the map art measured 0.8
    expect(sup.length / cells.length).toBeLessThan(2);
  });

  it('reads the world: a block already there anchors, an unknown cell is taken as flat ground under the art', () => {
    const cells = [{ pos: { x: 0, y: F + 3, z: 0 } }];
    // a block beside the art cell's column at F + 1: the chain stops there (2 supports)
    expect(mapSupports(cells, { side: 32, origin: { x: 0, z: 0 }, solid: (x, y) => y < F || (x === 1 && y === F + 1) }).length).toBe(2);
    // the art block itself is there already (a resume): nothing
    expect(mapSupports(cells, { side: 32, origin: { x: 0, z: 0 }, solid: (_x, y) => y < F || y === F + 3 })).toEqual([]);
    // nothing known: the ground taken just under the art's lowest block (as if flat)
    expect(mapSupports(cells, { side: 32, origin: { x: 0, z: 0 }, solid: () => undefined })).toEqual([]);
  });
});

describe('Track B8: the map pixels', () => {
  it('shade by the block north of it, whatever the step, the colours of B7 measured on Bedrock', () => {
    const p = mapPixels([
      { pos: { x: 0, y: 5, z: 0 }, name: 'white_wool' },
      { pos: { x: 0, y: 9, z: 1 }, name: 'white_wool' },
      { pos: { x: 0, y: 9, z: 2 }, name: 'black_wool' },
      { pos: { x: 0, y: 1, z: 3 }, name: 'stone' },
    ]);
    expect(p.map((x) => x.shade)).toEqual(['higher', 'level', 'lower']);
    expect(pixelColour('white_wool', 'higher')).toEqual([255, 255, 255]);
    expect(pixelColour('white_wool', 'level')).toEqual([220, 220, 220]);
    expect(pixelColour('stone', 'lower')).toEqual([79, 79, 79]);
    expect(pixelColour('nonsense', 'level')).toBeUndefined();
  });

  it('a Bedrock map shows a step of 1 only at one parity (measured: up where x + z is odd, down where even), 2 or more always', () => {
    const at = (dy: number, p: number) => stepShade(dy, p, 0);
    expect([at(1, 1), at(1, 0), at(-1, 0), at(-1, 1)]).toEqual(['higher', 'level', 'lower', 'level']);
    for (const p of [0, 1]) expect([at(2, p), at(3, p), at(0, p), at(-2, p), at(-3, p)]).toEqual(['higher', 'higher', 'level', 'lower', 'lower']);
    // negative coordinates keep the parity
    expect(stepShade(1, -3, 0)).toBe('higher');
    expect(stepShade(1, -3, -1)).toBe('level');
    // what a Java art means: the sign
    expect([stepShade(1, 0, 0, 'java'), stepShade(-1, 1, 0, 'java')]).toEqual(['higher', 'lower']);
  });
});

/** Run a plan's steps on a flat world (the planner's own view of each step), the stand moves and blocks walked. */
function apply(w: FlatWorld, plan: Plan, from: Cell): { at: Cell; moves: number; walked: number; pillars: number } {
  let at = from;
  let moves = 0;
  let walked = 0;
  let pillars = 0;
  const go = (c: Cell) => {
    const d = Math.hypot(c.x - at.x, c.y - at.y, c.z - at.z);
    if (d > 0) moves++;
    walked += d;
    at = c;
  };
  for (const st of plan.steps) {
    if (st.op === 'place') {
      if (st.stand) go(st.stand);
      w.set(st.pos, st.name);
    } else if (st.op === 'scaffold') {
      if (st.stand) go(st.stand);
      w.set(st.pos, 'netherrack');
    } else if (st.op === 'unscaffold') w.set(st.pos, 'air');
    else if (st.op === 'pillar') {
      go(st.base);
      pillars++;
      for (let k = 0; k < st.height; k++) w.set(add(st.base, 0, k, 0), 'netherrack');
      at = add(st.base, 0, st.height, 0);
    } else if (st.op === 'descend') {
      for (let k = 0; k < st.height; k++) w.set(add(st.base, 0, k, 0), 'air');
      at = st.base;
    }
  }
  return { at, moves, walked, pillars };
}

describe('Track B8: free stands for a valley map art', () => {
  // a generated art of one tile (32 x 32 columns), re-heighted, with its supports, over flat ground
  const s = staircase(32, 33, 5);
  const cells = valley(s.blocks).blocks.map((b) => ({ ...b, pos: { x: b.pos.x, y: F + b.pos.y, z: b.pos.z } }));
  const sup = mapSupports(cells, { side: TILE_SIDE, origin: { x: 0, z: 0 } });
  const places: BuildBlock[] = [...cells, ...sup.map((c) => ({ pos: c, name: MAP_SUPPORT }))];
  const run = (free: boolean) => {
    const w = new FlatWorld();
    const sec = placeSections({ kind: 'file', label: 'art', places }, { x: 16, y: F, z: 40 });
    let at: Cell = { x: 16, y: F, z: 40 };
    let moves = 0;
    let walked = 0;
    let pillars = 0;
    let skipped = 0;
    for (const se of sec.sections) {
      const plan = planBuild(w, se.spec, { start: at, area: se.area, maxColumn: 32, safeEdge: 3, ...(free ? { free: true } : {}) });
      skipped += plan.skipped.length;
      const r = apply(w, plan, at);
      at = r.at;
      moves += r.moves;
      walked += r.walked;
      pillars += r.pillars;
    }
    const right = places.filter((p) => w.name(p.pos) === p.name).length;
    return { moves, walked, pillars, skipped, right };
  };

  it('places every block and support, with fewer stand moves and less walking than layer by layer', () => {
    const layer = run(false);
    const free = run(true);
    expect(free.right).toBe(places.length);
    expect(free.skipped).toBe(0);
    expect(free.moves).toBeLessThan(layer.moves);
    expect(free.walked).toBeLessThan(layer.walked);
    // a stand places many blocks: on average several per move
    expect(places.length / Math.max(1, free.moves)).toBeGreaterThan(4);
  });

  it('never leaves a scaffold block: what stands at the end is the art and its supports, under the art blocks', () => {
    const w = new FlatWorld();
    const sec = placeSections({ kind: 'file', label: 'art', places }, { x: 16, y: F, z: 40 });
    let at: Cell = { x: 16, y: F, z: 40 };
    for (const se of sec.sections) at = apply(w, planBuild(w, se.spec, { start: at, area: se.area, maxColumn: 32, safeEdge: 3, free: true }), at).at;
    const want = new Map(places.map((p) => [key(p.pos), p.name] as const));
    for (const [k, b] of w.cells) if (b.name !== 'air') expect(want.get(k)).toBe(b.name);
  });
});

describe('Track B8: !build file <name> map ... valley', () => {
  const s = staircase(256, 129, 9);
  const flat = (_x: number, y: number) => y < 71;
  const ctx = { feet: { x: 1000, y: 71, z: -10 }, load: () => s, ground: () => 70, solid: flat };

  it('re-heights the art, adds its supports, says what it chose, and resolves to args a resume parses the same', () => {
    const r = parseSpec(['file', 'art', 'map', 'valley', 'fetch'], ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = valley(s.blocks, { at: { x: 960, z: -65 } });
    expect(r.spec.label).toBe('file art map valley at 960 71 -65 (2x1 maps from 960 -64, noob line north)');
    expect(r.args).toEqual(['file', 'art', 'map', '960', '71', '-64', 'valley', 'fetch']);
    expect(r.spec.free).toBe(true);
    // its columns as high as the art needs (the job takes it over a lower buildColumnMax)
    expect(r.spec.column).toBe(Math.min(128, v.after - 3));
    const supports = r.spec.places.length - s.blocks.length;
    expect(supports).toBeGreaterThan(0);
    expect(r.spec.places.slice(s.blocks.length).every((p) => p.name === MAP_SUPPORT)).toBe(true);
    expect(r.spec.note).toBe(`${valleyText(v)}; y 71 over ground 70..70; ${supports} cobblestone supports under blocks with nothing to click`);
    expect(Math.max(...r.spec.places.map((p) => p.pos.y))).toBe(71 + v.after - 1);
    // the resolved args (no ground given): the same cells
    const again = parseSpec(r.args!, { load: () => s, solid: flat });
    expect(again.ok && again.spec.places.map((p) => key(p.pos)).sort()).toEqual(r.spec.places.map((p) => key(p.pos)).sort());
    // the same map as the file
    const back = r.spec.places.map((p) => ({ ...p, pos: { x: p.pos.x - 960, y: p.pos.y - 71, z: p.pos.z + 65 } }));
    expect(pixelDiffs(mapPixels(s.blocks), mapPixels(back, { rule: 'bedrock', at: { x: 960, z: -65 } }))).toEqual([]);
    // without valley: B7's build, as before
    const plain = parseSpec(['file', 'art', 'map', '960', '71', '-64'], ctx);
    expect(plain.ok && plain.spec.places.length).toBe(s.blocks.length);
    expect(plain.ok && plain.spec.free).toBeUndefined();
  });

  it('refuses what stands in or over the art (a tree), with the kinds and the first cells', () => {
    const above = (x: number, z: number) => (x === 1000 && z === 0 ? { y: 99, name: 'oak_leaves' } : x === 1001 && z === 0 ? { y: 98, name: 'oak_log' } : undefined);
    const r = parseSpec(['file', 'art', 'map', '960', '71', '-64', 'valley'], { ...ctx, above });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^map: 2 blocks stand in or over the art \(1 oak_leaves, 1 oak_log; 1000 99 0 oak_leaves, 1001 98 0 oak_log\): clear them first or give a higher y$/);
    expect(mapArtObstacles([{ pos: { x: 5, y: 3, z: 5 } }], () => undefined).n).toBe(0);
  });

  it('takes the ground under plants and trees (they are replaced or refused, not built over)', () => {
    expect(plantLike('short_grass')).toBe(true);
    expect(plantLike('water')).toBe(false);
    expect(plantLike('stone')).toBe(false);
    for (const n of ['oak_log', 'stripped_birch_log', 'oak_leaves', 'crimson_stem', 'brown_mushroom_block', 'vine', 'oak_wood']) expect(TREE_RE.test(n)).toBe(true);
    for (const n of ['stone', 'grass_block', 'dirt', 'oak_planks', 'water']) expect(TREE_RE.test(n)).toBe(false);
  });
});

describe('Track B8: no scaffold stays out at the end of a free build', () => {
  it('digs the scaffold blocks the progress still has in the world once the sections and the sweep are done', async () => {
    const w = new FlatWorld();
    const places: BuildBlock[] = [0, 1, 2].map((x) => ({ pos: { x, y: F, z: 4 }, name: 'stone' }));
    const box = { min: { x: 0, y: F, z: 4 }, max: { x: 2, y: F, z: 4 } };
    const progress = new BuildProgress(undefined, { args: [], feet: { x: 0, y: F, z: 0 }, label: 'art', kind: 'file', box, total: 3, fetch: false });
    // a section left a 2-high scaffold column out (out of reach then), and one block was dug by someone since
    for (const y of [F, F + 1]) {
      w.set({ x: 6, y, z: 6 }, 'dirt');
      progress.scaffold({ x: 6, y, z: 6 }, true);
    }
    progress.scaffold({ x: 9, y: F, z: 9 }, true);
    const run = async (free: boolean) => {
      const bot = new FakeBot(w, new FakeInventory({ stone: 3, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
      const spec = { kind: 'file' as const, label: 'art', places, ...(free ? { free: true } : {}) };
      const job = new BuildJob(spec, { x: 0, y: F, z: 0 }, {
        world: bot.world,
        position: () => bot.feet,
        plan: (s, o) => Promise.resolve(planBuild(bot.world, s, o)),
        runner: (plan, hooks) => new BuildRunner(plan, { ...bot.deps(), ...hooks }),
        options: { scaffold: true, maxColumn: 6, safeEdge: 3 },
        have: (it) => bot.inv.count(it),
        log: undefined,
        progress,
      });
      return job.run();
    };
    // not free (any other build): left as it was
    expect(await run(false)).toEqual({ state: 'done' });
    expect(w.name({ x: 6, y: F + 1, z: 6 })).toBe('dirt');
    for (const p of places) w.set(p.pos, 'air');
    expect(await run(true)).toEqual({ state: 'done' });
    for (const y of [F, F + 1]) expect(w.name({ x: 6, y, z: 6 })).toBe('air');
    for (const p of places) expect(w.name(p.pos)).toBe('stone');
    expect(progress.scaffoldCells().filter((c) => c.x === 6)).toEqual([]);
  });
});
describe('Track B8: a valley build pillars as high as its art needs', () => {
  it('plans free, with the spec\'s column over a lower buildColumnMax (never under it)', async () => {
    const seen: { free?: boolean; maxColumn?: number }[] = [];
    const run = async (column: number | undefined, setting: number) => {
      const w = new FlatWorld();
      const bot = new FakeBot(w, new FakeInventory({ stone: 1, dirt: 16 }), { x: 0.5, y: F, z: 0.5 });
      const spec = { kind: 'file' as const, label: 'art', places: [{ pos: { x: 2, y: F, z: 2 }, name: 'stone' }], free: true, ...(column ? { column } : {}) };
      const job = new BuildJob(spec, { x: 0, y: F, z: 0 }, {
        world: bot.world,
        position: () => bot.feet,
        plan: (s, o) => {
          seen.push({ ...(o.free !== undefined ? { free: o.free } : {}), ...(o.maxColumn !== undefined ? { maxColumn: o.maxColumn } : {}) });
          return Promise.resolve(planBuild(bot.world, s, o));
        },
        runner: (plan, hooks) => new BuildRunner(plan, { ...bot.deps(), ...hooks }),
        options: { scaffold: true, maxColumn: setting, safeEdge: 3 },
        have: (it) => bot.inv.count(it),
        log: undefined,
      });
      return job.run();
    };
    expect(await run(103, 6)).toEqual({ state: 'done' });
    expect(await run(20, 32)).toEqual({ state: 'done' });
    expect(await run(undefined, 6)).toEqual({ state: 'done' });
    expect(seen).toEqual([
      { free: true, maxColumn: 103 },
      { free: true, maxColumn: 32 },
      { free: true, maxColumn: 6 },
    ]);
  });
});