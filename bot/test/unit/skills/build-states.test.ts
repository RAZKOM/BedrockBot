// Track B1 (decision 0124, docs/build.md "Block states"): the rules a click follows for a block's states, the
// structure's states turned with it, and the planner and runner placing blocks with states on a flat fake world whose
// fake server applies the rules measured on BDS 1.26.60 (written out here on their own, not taken from states.ts).
import { describe, expect, it } from 'vitest';
import { planBuild, planLine, refusedLine, type Plan } from '../../../src/skills/build/plan.ts';
import { BuildRunner } from '../../../src/skills/build/runner.ts';
import {
  chooseClick,
  doorHinge,
  eyeSide,
  itemOf,
  placementOf,
  remaining,
  resolveBlocks,
  rotateStates,
  sameBlock,
  statesMatch,
  unsupportedBlock,
  viewCardinal,
  type Placement,
} from '../../../src/skills/build/states.ts';
import { placeStructure, type Rotation } from '../../../src/skills/build/formats/index.ts';
import { readSchem, writeSchem, type JavaCell } from '../../../src/skills/build/formats/schem.ts';
import { clickable } from '../../../src/skills/build/sim.ts';
import type { BuildBlock, BuildSpec, Cell } from '../../../src/skills/build/types.ts';
import { FakeBot, FakeInventory, FlatWorld, type FakeClick } from './build-fakes.ts';

const F = -60;
const START: Cell = { x: 0, y: F, z: 0 };

const pl = (name: string, states?: Record<string, unknown>): Placement => {
  const p = placementOf({ name, ...(states ? { states } : {}) });
  if ('refuse' in p || 'companion' in p) throw new Error(`${name}: ${JSON.stringify(p)}`);
  return p;
};

describe('placementOf: the click each family needs (measured)', () => {
  it('stairs: the view gives weirdo_direction, the face or the click height upside_down_bit', () => {
    const p = pl('oak_stairs', { weirdo_direction: 0, upside_down_bit: false });
    expect(p.need.cardinal).toBe('east');
    expect(p.need.faces).toEqual(['up', 'north', 'south', 'west', 'east']);
    expect(p.need.half).toBe('low');
    const top = pl('oak_stairs', { weirdo_direction: 3, upside_down_bit: true });
    expect(top.need.cardinal).toBe('north');
    expect(top.need.faces[0]).toBe('down');
    expect(top.need.half).toBe('high');
    expect(top.check).toEqual({ weirdo_direction: 3, upside_down_bit: true });
  });

  it('slabs: the half; a double slab is a bottom slab and one more click on its top', () => {
    expect(pl('oak_slab', { 'minecraft:vertical_half': 'top' }).need).toMatchObject({ faces: ['down', 'north', 'south', 'west', 'east'], half: 'high' });
    const d = pl('oak_double_slab', { 'minecraft:vertical_half': 'bottom' });
    expect(d).toMatchObject({ placed: 'oak_slab', item: 'oak_slab', merges: 1, check: { 'minecraft:vertical_half': 'bottom' } });
    expect(pl('double_cut_copper_slab', {}).placed).toBe('cut_copper_slab');
    expect(remaining(d, { name: 'oak_slab' }).merges).toBe(1);
    expect(remaining(d, { name: 'oak_double_slab' }).merges).toBe(0);
  });

  it('doors: the facing a quarter turn from the view, the upper half and its hinge with it, open by a tap', () => {
    const p = pl('wooden_door', { 'minecraft:cardinal_direction': 'east', upper_block_bit: false, open_bit: true, door_hinge_bit: false });
    expect(p.need).toMatchObject({ faces: ['up'], cardinal: 'north' });
    expect(p.extra).toEqual([{ offset: { x: 0, y: 1, z: 0 }, name: 'wooden_door', check: { upper_block_bit: true, door_hinge_bit: false } }]);
    expect(p).toMatchObject({ taps: 1, hinge: false, check: { open_bit: false }, final: { open_bit: true } });
    expect(placementOf({ name: 'wooden_door', states: { upper_block_bit: true } })).toEqual({ companion: { x: 0, y: -1, z: 0 } });
    expect(pl('iron_door', { 'minecraft:cardinal_direction': 'east', upper_block_bit: false, open_bit: true, door_hinge_bit: false }).taps).toBe(0);
  });

  it('beds: the foot, the head the way the view goes; tall plants: the lower half on soil', () => {
    const b = pl('bed', { direction: 3, head_piece_bit: false });
    expect(b.need).toMatchObject({ faces: ['up'], cardinal: 'east' });
    expect(b.extra[0]).toMatchObject({ offset: { x: 1, y: 0, z: 0 }, check: { head_piece_bit: true } });
    expect(placementOf({ name: 'bed', states: { direction: 3, head_piece_bit: true } })).toEqual({ companion: { x: -1, y: 0, z: 0 } });
    const t = pl('sunflower', { upper_block_bit: false });
    expect(t.need).toMatchObject({ faces: ['up'], soil: true });
    expect(t.extra[0]!.offset).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('attached blocks: the face clicked, never a scaffold block', () => {
    expect(pl('torch', { torch_facing_direction: 'west' }).need).toEqual({ faces: ['east'], realSupport: true });
    expect(pl('torch', { torch_facing_direction: 'top' }).need.faces).toEqual(['up']);
    expect(pl('lantern', { hanging: true }).need.faces).toEqual(['down']);
    expect(pl('ladder', { facing_direction: 2 }).need.faces).toEqual(['north']);
    expect(pl('stone_button', { facing_direction: 0 }).need.faces).toEqual(['down']);
    expect(pl('frame', { facing_direction: 5 }).need.faces).toEqual(['east']);
    expect(pl('skeleton_skull', { facing_direction: 2 }).need).toEqual({ faces: ['north'], realSupport: true });
    expect(pl('end_rod', { facing_direction: 4 }).need.faces).toEqual(['east']);
    expect(pl('amethyst_cluster', { 'minecraft:block_face': 'down' }).need.faces).toEqual(['down']);
    const hs = pl('oak_hanging_sign', { hanging: true, facing_direction: 2, attached_bit: false, ground_sign_direction: 4 });
    expect(hs.need).toMatchObject({ faces: ['down'], cardinal: 'south' });
    // ground_sign_direction counts only on a chain: a click leaves it 0, a structure turned by the game turns it
    expect(hs.check).toEqual({ hanging: true, facing_direction: 2, attached_bit: false });
    expect(hs.ignored).toContain('ground_sign_direction');
    expect(pl('oak_hanging_sign', { hanging: false, facing_direction: 2, attached_bit: false, ground_sign_direction: 0 }).need.faces).toEqual(['east', 'west']);
  });

  it('facing by the view: furnaces, chests, glazed terracotta, pots face back at the player; a campfire and an anvil do not', () => {
    expect(pl('furnace', { 'minecraft:cardinal_direction': 'north' }).need.cardinal).toBe('south');
    expect(pl('trapped_chest', { 'minecraft:cardinal_direction': 'east' }).need.cardinal).toBe('west');
    expect(pl('white_glazed_terracotta', { facing_direction: 2 }).need.cardinal).toBe('south');
    expect(pl('decorated_pot', { direction: 3 }).need.cardinal).toBe('west');
    expect(pl('campfire', { 'minecraft:cardinal_direction': 'north', extinguished: false }).need.cardinal).toBe('north');
    expect(pl('anvil', { 'minecraft:cardinal_direction': 'north', damage: 'undamaged' }).need.cardinal).toBe('east');
    expect(pl('pink_petals', { 'minecraft:cardinal_direction': 'north', growth: 0 }).need).toEqual({ faces: ['up'], cardinal: 'south' });
  });

  it('standing and hanging blocks, a hopper into its block, more in one cell, walls by their neighbours', () => {
    expect(pl('bell', { attachment: 'standing', direction: 1, toggle_bit: false })).toMatchObject({ family: 'bell', need: { faces: ['up'], cardinal: 'east' } });
    expect(pl('bell', { attachment: 'side', direction: 3, toggle_bit: false }).need).toEqual({ faces: ['east'], realSupport: true });
    expect(pl('grindstone', { attachment: 'hanging', direction: 2 }).need).toMatchObject({ faces: ['down'], cardinal: 'south' });
    expect(placementOf({ name: 'bell', states: { attachment: 'multiple', direction: 0 } })).toEqual({ refuse: 'a bell between two blocks (not measured)' });
    expect(pl('hopper', { facing_direction: 5, toggle_bit: false }).need.faces).toEqual(['west']); // the support is the block it points at
    expect(pl('hopper', { facing_direction: 0, toggle_bit: false }).need.faces).toEqual(['up', 'down']);
    expect(pl('tripwire_hook', { direction: 0, attached_bit: false, powered_bit: false })).toMatchObject({ need: { faces: ['south'] }, check: { direction: 0 }, derived: { attached_bit: false } });
    expect(pl('lightning_rod', { facing_direction: 1, powered_bit: false }).need.faces).toEqual(['up']);
    expect(pl('sea_pickle', { cluster_count: 1, dead_bit: true })).toMatchObject({ merges: 1, check: { cluster_count: 0 }, final: { cluster_count: 1 }, ignored: ['dead_bit'] });
    expect(pl('candle', { candles: 2, lit: false })).toMatchObject({ merges: 2, final: { candles: 2 } });
    const wall = pl('cobblestone_wall', { wall_connection_type_east: 'short', wall_connection_type_west: 'none', wall_post_bit: true, wall_block_type: 'cobblestone' });
    expect(wall).toMatchObject({ family: 'plain', check: {}, derived: { wall_connection_type_east: 'short', wall_connection_type_west: 'none', wall_post_bit: true } });
  });

  it('six-way blocks: the view on the level, the eye over or under the cell for up and down', () => {
    expect(pl('piston', { facing_direction: 5 }).need).toMatchObject({ cardinal: 'east', eye: 'level' });
    expect(pl('piston', { facing_direction: 1 }).need.eye).toBe('above');
    expect(pl('dispenser', { facing_direction: 4, triggered_bit: false }).need).toMatchObject({ cardinal: 'east' });
    expect(pl('dispenser', { facing_direction: 0, triggered_bit: false }).need.eye).toBe('below');
    expect(pl('observer', { 'minecraft:facing_direction': 'down', powered_bit: false }).need.eye).toBe('above');
    expect(pl('crafter', { orientation: 'up_west', crafting: false, triggered_bit: false }).need).toMatchObject({ eye: 'above', cardinal: 'east' });
    expect(pl('crafter', { orientation: 'west_up', crafting: false, triggered_bit: false }).need).toMatchObject({ eye: 'level', cardinal: 'east' });
    // the eye 1.0 off the centre and 2.62 over the bottom: above; 2.0 off: level; 1.62 over: level; under the bottom: below
    const t = { x: 0, y: 0, z: 0 };
    expect(eyeSide({ x: -0.5, y: 2.62, z: 0.5 }, t)).toBe('above');
    expect(eyeSide({ x: -1.5, y: 2.62, z: 0.5 }, t)).toBe('level');
    expect(eyeSide({ x: -0.5, y: 1.62, z: 0.5 }, t)).toBe('level');
    expect(eyeSide({ x: -0.5, y: -0.38, z: 0.5 }, t)).toBe('below');
    expect(eyeSide({ x: -1.5, y: 2.62, z: 0.5 }, t, 0.3)).toBe('edge');
  });

  it('redstone parts: dust and plates on a floor, repeaters and comparators tapped, a lever on is a power source placed off', () => {
    const r = pl('powered_repeater', { 'minecraft:cardinal_direction': 'south', repeater_delay: 2 });
    expect(r).toMatchObject({ name: 'unpowered_repeater', item: 'repeater', taps: 2, check: { repeater_delay: 0 }, final: { repeater_delay: 2 } });
    expect(r.need.cardinal).toBe('north');
    expect(remaining(r, { name: 'unpowered_repeater', states: { repeater_delay: 1 } }).taps).toBe(1);
    expect(remaining(r, { name: 'unpowered_repeater', states: { repeater_delay: 3 } }).taps).toBe(3);
    expect(pl('unpowered_comparator', { 'minecraft:cardinal_direction': 'south', output_subtract_bit: true, output_lit_bit: false }).taps).toBe(1);
    const lever = pl('lever', { lever_direction: 'up_north_south', open_bit: true });
    expect(lever).toMatchObject({ source: true, taps: 1, need: { faces: ['up'], axis: 'z' } });
    expect(pl('lever', { lever_direction: 'up_north_south', open_bit: false }).source).toBe(false);
    expect(pl('redstone_wire', { redstone_signal: 0 })).toMatchObject({ family: 'dust', need: { faces: ['up'] } });
    expect(pl('redstone_torch', { torch_facing_direction: 'top' }).source).toBe(true);
    expect(pl('stone_pressure_plate', { redstone_signal: 0 }).need.faces).toEqual(['up']);
    expect(pl('rail', { rail_direction: 1 }).derived).toEqual({ rail_direction: 1 });
  });

  it('refusals keep a reason per block; names typed by hand', () => {
    expect(placementOf({ name: 'water', states: { liquid_depth: 0 } })).toEqual({ refuse: 'no liquids' });
    const why = (b: Parameters<typeof placementOf>[0]): string => {
      const p = placementOf(b);
      return 'refuse' in p ? p.refuse : '';
    };
    expect(why({ name: 'wheat', states: { growth: 7 } })).toMatch(/seeds/);
    expect(why({ name: 'standing_banner', states: { ground_sign_direction: 0 } })).toMatch(/block entity/);
    expect(why({ name: 'vine', states: { vine_direction_bits: 1 } })).toMatch(/not measured/);
    expect(why({ name: 'candle_cake', states: { lit: false } })).toMatch(/candle on a cake/);
    expect(why({ name: 'red_candle_cake', states: {} })).toMatch(/candle on a cake/);
    expect(unsupportedBlock('cake')).toBeUndefined();
    expect(unsupportedBlock('candle')).toBeUndefined();
    expect(unsupportedBlock('oak_door')).toMatch(/two-cell/);
    expect(unsupportedBlock('bed')).toMatch(/two-cell/);
    expect(unsupportedBlock('repeater')).toBeUndefined();
    expect(unsupportedBlock('cobblestone')).toBeUndefined();
    expect(itemOf('oak_double_slab')).toBe('oak_slab');
    expect(itemOf('spruce_wall_sign')).toBe('spruce_sign');
    expect(itemOf('redstone_wire')).toBe('redstone');
    expect(sameBlock('furnace', 'lit_furnace')).toBe(true);
    expect(sameBlock('unpowered_repeater', 'powered_repeater')).toBe(true);
    expect(sameBlock('oak_slab', 'oak_double_slab')).toBe(false);
    expect(statesMatch({ open_bit: false, delay: 1 }, { open_bit: 0, delay: '1' })).toBe(true);
  });

  it('resolveBlocks: second cells joined to their first, an orphan refused, TNT refused beside a power source', () => {
    const blocks: BuildBlock[] = [
      { pos: { x: 0, y: 0, z: 0 }, name: 'wooden_door', states: { 'minecraft:cardinal_direction': 'east', upper_block_bit: false, open_bit: false, door_hinge_bit: false } },
      { pos: { x: 0, y: 1, z: 0 }, name: 'wooden_door', states: { 'minecraft:cardinal_direction': 'east', upper_block_bit: true, open_bit: false, door_hinge_bit: false } },
      { pos: { x: 5, y: 1, z: 0 }, name: 'wooden_door', states: { upper_block_bit: true } },
      { pos: { x: 3, y: 0, z: 0 }, name: 'tnt', states: { explode_bit: false } },
      { pos: { x: 4, y: 0, z: 0 }, name: 'redstone_block' },
    ];
    const r = resolveBlocks(blocks);
    expect(r.cells.map((c) => c.block.name)).toEqual(['wooden_door', 'redstone_block']);
    expect(r.refused.map((x) => x.reason)).toEqual(['the second cell of a two-cell block without its first', 'TNT in a build with a power source']);
    expect(refusedLine(r.refused.map((x) => ({ name: x.block.name, reason: x.reason })))).toBe('2 refused (wooden_door: the second cell of a two-cell block without its first; tnt: TNT in a build with a power source)');
  });
});

describe('rotateStates: a structure turned with its states', () => {
  it('turns every direction state a quarter clockwise per 90 degrees', () => {
    expect(rotateStates('oak_stairs', { weirdo_direction: 0, upside_down_bit: true }, 90)).toEqual({ weirdo_direction: 2, upside_down_bit: true }); // east -> south
    expect(rotateStates('furnace', { 'minecraft:cardinal_direction': 'north' }, 180)).toEqual({ 'minecraft:cardinal_direction': 'south' });
    expect(rotateStates('bed', { direction: 0, head_piece_bit: false }, 90)).toEqual({ direction: 1, head_piece_bit: false }); // south -> west
    expect(rotateStates('oak_trapdoor', { direction: 0, upside_down_bit: false, open_bit: false }, 90)).toMatchObject({ direction: 2 }); // west -> north
    expect(rotateStates('piston', { facing_direction: 5 }, 90)).toEqual({ facing_direction: 3 }); // east -> south
    expect(rotateStates('piston', { facing_direction: 1 }, 90)).toEqual({ facing_direction: 1 });
    expect(rotateStates('oak_log', { pillar_axis: 'x' }, 90)).toEqual({ pillar_axis: 'z' });
    expect(rotateStates('oak_log', { pillar_axis: 'x' }, 180)).toEqual({ pillar_axis: 'x' });
    expect(rotateStates('lever', { lever_direction: 'up_north_south', open_bit: false }, 90)).toMatchObject({ lever_direction: 'up_east_west' });
    expect(rotateStates('torch', { torch_facing_direction: 'north' }, 270)).toEqual({ torch_facing_direction: 'west' });
    expect(rotateStates('standing_sign', { ground_sign_direction: 14 }, 90)).toEqual({ ground_sign_direction: 2 });
    expect(rotateStates('rail', { rail_direction: 0 }, 90)).toEqual({ rail_direction: 1 });
    expect(rotateStates('rail', { rail_direction: 6 }, 90)).toEqual({ rail_direction: 7 });
    expect(rotateStates('golden_rail', { rail_direction: 2, rail_data_bit: false }, 90)).toMatchObject({ rail_direction: 5 });
    expect(rotateStates('crafter', { orientation: 'up_north' }, 90)).toEqual({ orientation: 'up_east' });
    expect(rotateStates('oak_fence', { 'minecraft:connection_north': true, 'minecraft:connection_east': false }, 90)).toEqual({ 'minecraft:connection_east': true, 'minecraft:connection_south': false });
  });

  it('placeStructure turns the states with the cells', () => {
    const s = { size: { x: 2, y: 1, z: 1 }, blocks: [{ pos: { x: 1, y: 0, z: 0 }, name: 'oak_stairs', states: { weirdo_direction: 0, upside_down_bit: false } }] };
    expect(placeStructure(s, { x: 10, y: 0, z: 10 }, 90)).toEqual([{ pos: { x: 10, y: 0, z: 11 }, name: 'oak_stairs', states: { weirdo_direction: 2, upside_down_bit: false } }]);
  });
});

describe('chooseClick and the door hinge', () => {
  const w = new FlatWorld();
  const opts = { clickable: (p: Cell) => clickable(w.blockAt(p)) };

  it('a stair from the west looking east: natural; from the north: the view turned east', () => {
    const p = pl('oak_stairs', { weirdo_direction: 0, upside_down_bit: false });
    const t = { x: 3, y: F, z: 0 };
    const fromWest = chooseClick(w, { x: 1.5, y: F + 1.62, z: 0.5 }, t, p.need, opts);
    expect(fromWest).toMatchObject({ face: 'up', natural: true });
    const fromNorth = chooseClick(w, { x: 3.5, y: F + 1.62, z: -1.5 }, t, p.need, opts);
    expect(fromNorth).toMatchObject({ face: 'up', natural: false, view: { yaw: -90 } });
    expect(viewCardinal(fromNorth!.view!.yaw)).toBe('east');
  });

  it('a top slab on a wall: the side clicked high', () => {
    const w2 = new FlatWorld();
    w2.set({ x: 2, y: F + 2, z: 0 }, 'stone');
    const p = pl('oak_slab', { 'minecraft:vertical_half': 'top' });
    const c = chooseClick(w2, { x: 0.5, y: F + 1.62, z: 0.5 }, { x: 1, y: F + 2, z: 0 }, p.need, { clickable: (q) => clickable(w2.blockAt(q)) });
    expect(c).toMatchObject({ face: 'west', click: { x: 0, y: 0.75, z: 0.5 } });
  });

  it('the hinge follows the neighbours at the click: a wall on the clockwise side gives 1, a door on the other side 1', () => {
    const w3 = new FlatWorld();
    const t = { x: 0, y: F, z: 0 };
    expect(doorHinge(w3, t, 'south')).toBe(false);
    w3.set({ x: -1, y: F, z: 0 }, 'cobblestone'); // looking south, clockwise is west
    expect(doorHinge(w3, t, 'south')).toBe(true);
    w3.set({ x: 1, y: F, z: 0 }, 'cobblestone');
    w3.set({ x: 1, y: F + 1, z: 0 }, 'cobblestone');
    expect(doorHinge(w3, t, 'south')).toBe(false); // two on the east against one on the west
    w3.set({ x: 1, y: F, z: 0 }, 'wooden_door');
    expect(doorHinge(w3, t, 'south')).toBe(true); // a door to the east (anticlockwise): the pair
  });
});

// ---- the fake server (the measured rules, written out on their own)

const CARD = ['south', 'west', 'north', 'east'] as const;
type Card = (typeof CARD)[number];
const cardOf = (yaw: number): Card => CARD[Math.floor(((((yaw % 360) + 360) % 360) + 45) / 90) % 4]!;
const CW: Record<Card, Card> = { north: 'east', east: 'south', south: 'west', west: 'north' };
const VEC: Record<Card, [number, number]> = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] };
const WEIRDO: Record<Card, number> = { east: 0, west: 1, south: 2, north: 3 };
const REV: Record<Card, Card> = { north: 'south', south: 'north', east: 'west', west: 'east' };

function fakeServer(world: FlatWorld): FakeClick {
  return (p, o, eye, item, here) => {
    const yaw = o.view?.yaw ?? (Math.atan2(-(p.x + 0.5 - eye.x), p.z + 0.5 - eye.z) * 180) / Math.PI;
    const view = cardOf(yaw);
    const high = o.face === 'down' || (o.face !== 'up' && (o.click?.y ?? 0.5) > 0.5);
    if (o.merge) {
      if (here.name.endsWith("_slab") && item === here.name) return { name: here.name.replace(/_slab$/, '_double_slab'), states: { 'minecraft:vertical_half': 'bottom' } };
      if (here.name === 'candle') return { name: 'candle', states: { candles: Number(here.states?.candles ?? 0) + 1 } };
      return undefined;
    }
    if (item === 'oak_stairs') return { name: item, states: { weirdo_direction: WEIRDO[view], upside_down_bit: high } };
    if (item === 'oak_slab') return { name: item, states: { 'minecraft:vertical_half': high ? 'top' : 'bottom' } };
    if (item === 'furnace') return { name: item, states: { 'minecraft:cardinal_direction': REV[view] } };
    if (item === 'repeater') return { name: 'unpowered_repeater', states: { 'minecraft:cardinal_direction': REV[view], repeater_delay: 0 } };
    if (item === 'lantern') return { name: item, states: { hanging: o.face === 'down' } };
    if (item === 'redstone_torch') return { name: item, states: { torch_facing_direction: 'top' } };
    if (item === 'wooden_door') {
      const facing = CW[view];
      const solid = (dx: number, dz: number) => [0, 1].filter((dy) => world.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz })!.name === 'cobblestone').length;
      const [ax, az] = VEC[CW[CW[CW[view]]]]; // anticlockwise of the view
      const [bx, bz] = VEC[CW[view]];
      const hinge = solid(bx, bz) > solid(ax, az);
      const st = { 'minecraft:cardinal_direction': facing, open_bit: false };
      return { name: item, states: { ...st, upper_block_bit: false }, extra: [{ pos: { x: p.x, y: p.y + 1, z: p.z }, name: item, states: { ...st, upper_block_bit: true, door_hinge_bit: hinge } }] };
    }
    return { name: item };
  };
}

const fakeTap = (_p: Cell, here: { name: string; states?: Readonly<Record<string, unknown>> }) => {
  if (here.name === 'unpowered_repeater') return { ...here.states, repeater_delay: (Number(here.states?.repeater_delay ?? 0) + 1) % 4 };
  if (here.name === 'wooden_door') return { ...here.states, open_bit: true };
  return undefined;
};

async function build(world: FlatWorld, blocks: BuildBlock[], inv: Record<string, number>, o: { server?: FakeClick; lateDrops?: boolean } = {}): Promise<{ plan: Plan; runner: BuildRunner; bot: FakeBot }> {
  const spec: BuildSpec = { kind: 'file', label: 'states', places: blocks };
  const plan = planBuild(world, spec, { start: START });
  const bot = new FakeBot(world, new FakeInventory({ cobblestone: 64, ...inv }), { x: 0.5, y: F, z: 0.5 }, { click: o.server ?? fakeServer(world), tap: fakeTap, ...(o.lateDrops ? { lateDrops: true } : {}) });
  const runner = new BuildRunner(plan, bot.deps());
  const end = await runner.run();
  expect(end).toEqual({ state: 'done' });
  return { plan, runner, bot };
}

describe('planner and runner: blocks with states', () => {
  it('a row of stairs facing east, a top slab and a double slab come out as the build says', async () => {
    const w = new FlatWorld();
    const blocks: BuildBlock[] = [
      ...[2, 3, 4].map((x) => ({ pos: { x, y: F, z: 2 }, name: 'oak_stairs', states: { weirdo_direction: 0, upside_down_bit: false } })),
      { pos: { x: 2, y: F, z: 4 }, name: 'oak_stairs', states: { weirdo_direction: 3, upside_down_bit: true } },
      { pos: { x: 3, y: F, z: 4 }, name: 'oak_double_slab', states: { 'minecraft:vertical_half': 'bottom' } },
    ];
    const { plan, runner } = await build(w, blocks, { oak_stairs: 8, oak_slab: 8 });
    expect(plan.materials).toMatchObject({ oak_stairs: 4, oak_slab: 2 });
    for (const x of [2, 3, 4]) expect(w.blockAt({ x, y: F, z: 2 })!.states).toEqual({ weirdo_direction: 0, upside_down_bit: false });
    expect(w.blockAt({ x: 2, y: F, z: 4 })!.states).toEqual({ weirdo_direction: 3, upside_down_bit: true });
    expect(w.name({ x: 3, y: F, z: 4 })).toBe('oak_double_slab');
    expect(runner.stats.wrong ?? []).toEqual([]);
    expect(runner.stats.verified).toBe(5);
  });

  it('a rotated .schem with stairs: the Java states mapped by the reader, turned once by placeStructure and built so', async () => {
    // Track B2's Java reader and Track B1's turner meet here: one turn only (a second would put an east stair at 90 west)
    const cells: JavaCell[] = [
      { pos: { x: 0, y: 0, z: 0 }, java: 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]' },
      { pos: { x: 2, y: 0, z: 0 }, java: 'minecraft:oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]' },
      { pos: { x: 0, y: 0, z: 2 }, java: 'minecraft:furnace[facing=north,lit=false]' },
    ];
    const s = readSchem(writeSchem({ x: 3, y: 1, z: 3 }, cells), 'stairs');
    expect(s.blocks.find((b) => b.pos.x === 0 && b.pos.z === 0)?.states).toMatchObject({ weirdo_direction: 0, upside_down_bit: 0 }); // the reader does not turn
    // written out by hand, clockwise seen from above: east -> south -> west -> north; weirdo east 0, west 1, south 2, north 3
    const want: Record<Rotation, { bottom: number; top: number; furnace: string }> = {
      0: { bottom: 0, top: 3, furnace: 'north' },
      90: { bottom: 2, top: 0, furnace: 'east' },
      180: { bottom: 1, top: 2, furnace: 'south' },
      270: { bottom: 3, top: 1, furnace: 'west' },
    };
    for (const rot of [0, 90, 180, 270] as const) {
      const w = new FlatWorld();
      const base = fakeServer(w);
      // a straight stair has the game's corner state
      const server: FakeClick = (p, o, eye, item, here) => {
        const r = base(p, o, eye, item, here);
        return r && item === 'oak_stairs' ? { ...r, states: { ...r.states, 'minecraft:corner': 'none' } } : r;
      };
      const blocks = placeStructure(s, { x: 2, y: F, z: 2 }, rot);
      const { runner } = await build(w, blocks, { oak_stairs: 4, furnace: 2 }, { server });
      for (const b of blocks) {
        const got = w.blockAt(b.pos)!.states;
        if (b.name === 'furnace') expect(got?.['minecraft:cardinal_direction'], `${rot} furnace`).toBe(want[rot].furnace);
        else expect(Number(got?.weirdo_direction), `${rot} ${b.states?.upside_down_bit ? 'top' : 'bottom'} stair`).toBe(b.states?.upside_down_bit ? want[rot].top : want[rot].bottom);
      }
      expect(runner.stats.wrong ?? [], `${rot}`).toEqual([]);
    }
  });

  it('a door with its hinge on the wall side: a scaffold block beside it for the click, dug after', async () => {
    const w = new FlatWorld();
    const blocks: BuildBlock[] = [
      { pos: { x: 3, y: F, z: 3 }, name: 'wooden_door', states: { 'minecraft:cardinal_direction': 'west', upper_block_bit: false, open_bit: true, door_hinge_bit: true } },
      { pos: { x: 3, y: F + 1, z: 3 }, name: 'wooden_door', states: { 'minecraft:cardinal_direction': 'west', upper_block_bit: true, open_bit: true, door_hinge_bit: true } },
    ];
    const { plan, runner, bot } = await build(w, blocks, { wooden_door: 2 });
    expect(plan.materials).toEqual({ wooden_door: 1 });
    expect(plan.steps.map((s) => s.op)).toEqual(['scaffold', 'place', 'unscaffold']);
    const lower = w.blockAt({ x: 3, y: F, z: 3 })!;
    const upper = w.blockAt({ x: 3, y: F + 1, z: 3 })!;
    expect(lower.states).toMatchObject({ 'minecraft:cardinal_direction': 'west', open_bit: true });
    expect(upper.states).toMatchObject({ door_hinge_bit: true });
    expect(runner.stats.wrong ?? []).toEqual([]);
    expect(bot.log.filter((l) => l.startsWith('tap'))).toHaveLength(1);
    expect(w.name({ x: 3, y: F, z: 2 })).toBe('air'); // the scaffold went again
  });

  it('a repeater tapped to its delay, a lantern under a ceiling waits for the ceiling, a power source goes last', async () => {
    const w = new FlatWorld();
    const blocks: BuildBlock[] = [
      { pos: { x: 3, y: F, z: 3 }, name: 'redstone_torch', states: { torch_facing_direction: 'top' } },
      { pos: { x: 4, y: F, z: 3 }, name: 'powered_repeater', states: { 'minecraft:cardinal_direction': 'west', repeater_delay: 3 } },
      { pos: { x: 5, y: F + 1, z: 3 }, name: 'lantern', states: { hanging: true } },
      { pos: { x: 5, y: F + 2, z: 3 }, name: 'cobblestone' },
    ];
    const { plan, runner, bot } = await build(w, blocks, { redstone_torch: 2, repeater: 2, lantern: 2 });
    const order = plan.steps.filter((s) => s.op === 'place').map((s) => (s.op === 'place' ? s.name : ''));
    expect(order).toEqual(['unpowered_repeater', 'cobblestone', 'lantern', 'redstone_torch']);
    expect(w.blockAt({ x: 4, y: F, z: 3 })!.states).toEqual({ 'minecraft:cardinal_direction': 'west', repeater_delay: 3 });
    expect(bot.log.filter((l) => l.startsWith('tap'))).toHaveLength(3);
    expect(w.blockAt({ x: 5, y: F + 1, z: 3 })!.states).toEqual({ hanging: true });
    expect(runner.stats.wrong ?? []).toEqual([]);
  });

  it('a wrong state is dug and placed again, then kept and reported', async () => {
    const w = new FlatWorld();
    let n = 0;
    const base = fakeServer(w);
    // the first click faces the furnace the wrong way, the second right; a second furnace always wrong
    const server: FakeClick = (p, o, eye, item, here) => {
      if (item === 'furnace' && p.x === 2 && n++ === 0) return { name: 'furnace', states: { 'minecraft:cardinal_direction': 'east' } };
      if (item === 'furnace' && p.x === 4) return { name: 'furnace', states: { 'minecraft:cardinal_direction': 'east' } };
      return base(p, o, eye, item, here);
    };
    const blocks: BuildBlock[] = [2, 4].map((x) => ({ pos: { x, y: F, z: 3 }, name: 'furnace', states: { 'minecraft:cardinal_direction': 'north' } }));
    const { runner } = await build(w, blocks, { furnace: 8 }, { server });
    expect(w.blockAt({ x: 2, y: F, z: 3 })!.states).toEqual({ 'minecraft:cardinal_direction': 'north' });
    expect(runner.stats.redone).toBeGreaterThanOrEqual(3);
    expect(runner.stats.wrong).toEqual([{ pos: { x: 4, y: F, z: 3 }, name: 'furnace', diff: ['cardinal_direction=north not east'] }]);
  });

  it('exactly the items and a wrong one dug: its drop is picked up wider before the item counts as out', async () => {
    const w = new FlatWorld();
    let n = 0;
    const base = fakeServer(w);
    const server: FakeClick = (p, o, eye, item, here) => (item === 'furnace' && n++ === 0 ? { name: 'furnace', states: { 'minecraft:cardinal_direction': 'east' } } : base(p, o, eye, item, here));
    const blocks: BuildBlock[] = [{ pos: { x: 2, y: F, z: 3 }, name: 'furnace', states: { 'minecraft:cardinal_direction': 'north' } }];
    const { runner, bot } = await build(w, blocks, { furnace: 1 }, { server, lateDrops: true });
    expect(w.blockAt({ x: 2, y: F, z: 3 })!.states).toEqual({ 'minecraft:cardinal_direction': 'north' });
    expect(runner.stats.redone).toBe(1);
    expect(bot.dropped).toEqual([]);
  });

  it('a file lists its refused blocks and builds the rest; a typed build stops at the first', () => {
    const w = new FlatWorld();
    const blocks: BuildBlock[] = [
      { pos: { x: 2, y: F, z: 2 }, name: 'cobblestone' },
      { pos: { x: 3, y: F, z: 2 }, name: 'water', states: { liquid_depth: 0 } },
    ];
    const plan = planBuild(w, { kind: 'file', label: 'f', places: blocks }, { start: START });
    expect(plan.refused).toEqual([{ pos: { x: 3, y: F, z: 2 }, name: 'water', reason: 'no liquids' }]);
    expect(plan.work).toBe(1);
    expect(planLine(plan)).toBe('f: 1 to place, 1 refused (water: no liquids)');
    expect(() => planBuild(w, { kind: 'fill', label: 'x', places: blocks }, { start: START })).toThrow(/water: no liquids/);
  });

  it('a block already there with the build states counts as there; with other states it is occupied', () => {
    const w = new FlatWorld();
    w.set({ x: 2, y: F, z: 2 }, 'furnace', { 'minecraft:cardinal_direction': 'north' });
    w.set({ x: 3, y: F, z: 2 }, 'furnace', { 'minecraft:cardinal_direction': 'east' });
    const blocks: BuildBlock[] = [2, 3].map((x) => ({ pos: { x, y: F, z: 2 }, name: 'furnace', states: { 'minecraft:cardinal_direction': 'north' } }));
    const plan = planBuild(w, { kind: 'file', label: 'f', places: blocks }, { start: START });
    expect(plan.already).toBe(1);
    expect(plan.occupied).toBe(1);
    expect(plan.steps).toEqual([]);
  });
});
