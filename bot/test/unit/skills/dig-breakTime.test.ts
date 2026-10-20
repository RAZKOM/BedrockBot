// Break-time table and mining data (PLAN.md 4.1). Expected values: Minecraft Wiki "Breaking"
// (Bedrock), checked 2026-10-28, and the BDS 1.26.51 measurements in docs/digging.md.
import { describe, expect, it } from 'vitest';
import { blockMining, toolOf } from '../../../src/data/mining.ts';
import { breakTicks, canHarvest, estimateBreak, MODIFIERS } from '../../../src/skills/dig/breakTime.ts';

describe('toolOf', () => {
  it('parses tier and type from item names', () => {
    expect(toolOf('stone_axe')).toEqual({ type: 'axe', tier: 'stone' });
    expect(toolOf('minecraft:diamond_pickaxe')).toEqual({ type: 'pickaxe', tier: 'diamond' });
    expect(toolOf('golden_shovel')).toEqual({ type: 'shovel', tier: 'golden' });
    expect(toolOf('copper_hoe')).toEqual({ type: 'hoe', tier: 'copper' });
    expect(toolOf('netherite_sword')).toEqual({ type: 'sword', tier: 'netherite' });
    expect(toolOf('shears')).toEqual({ type: 'shears', tier: undefined });
  });
  it('returns null for non-tools', () => {
    for (const n of [null, undefined, '', 'stick', 'oak_log', 'stone_pressure_plate', 'wooden_door', 'iron_ingot']) expect(toolOf(n)).toBeNull();
  });
});

describe('blockMining (minecraft-data bedrock 1.26.51 -> 1.26.30 block data)', () => {
  it('has the hardness of the wood-gathering blocks', () => {
    expect(blockMining('grass_block')?.hardness).toBe(0.6);
    expect(blockMining('dirt')?.hardness).toBe(0.5);
    expect(blockMining('oak_log')?.hardness).toBe(2);
    expect(blockMining('minecraft:oak_planks')?.hardness).toBe(2);
    expect(blockMining('oak_leaves')?.hardness).toBe(0.2);
    expect(blockMining('stone')?.hardness).toBe(1.5);
    expect(blockMining('bedrock')?.hardness).toBe(-1);
    expect(blockMining('no_such_block')).toBeUndefined();
  });
  it('maps materials to effective tools', () => {
    expect(blockMining('oak_log')?.effective).toEqual(['axe']);
    expect(blockMining('dirt')?.effective).toEqual(['shovel']);
    expect(blockMining('grass_block')?.effective).toEqual(['shovel']);
    expect(blockMining('stone')?.effective).toEqual(['pickaxe']);
    expect(blockMining('iron_ore')?.effective).toEqual(['pickaxe']);
    expect(blockMining('oak_leaves')?.effective).toEqual(['hoe', 'shears']);
  });
  it('decodes harvest requirements', () => {
    expect(blockMining('oak_log')?.harvest).toBeUndefined();
    expect(blockMining('stone')?.harvest).toEqual({ types: ['pickaxe'], minTier: 'wooden' });
    expect(blockMining('iron_ore')?.harvest).toEqual({ types: ['pickaxe'], minTier: 'stone' });
    expect(blockMining('gold_ore')?.harvest).toEqual({ types: ['pickaxe'], minTier: 'iron' });
    expect(blockMining('diamond_ore')?.harvest).toEqual({ types: ['pickaxe'], minTier: 'iron' });
    expect(blockMining('obsidian')?.harvest).toEqual({ types: ['pickaxe'], minTier: 'diamond' });
    expect(blockMining('snow_layer')?.harvest).toEqual({ types: ['shovel'], minTier: 'wooden' });
    expect(blockMining('web')?.harvest?.types.toSorted()).toEqual(['shears', 'sword']);
  });
});

describe('break ticks', () => {
  it('oak_log: hand 60, wooden 30, stone 15, iron 10, diamond 8, netherite 7, golden 5 (PLAN.md 7b)', () => {
    const got = Object.fromEntries(
      [null, 'wooden_axe', 'stone_axe', 'copper_axe', 'iron_axe', 'diamond_axe', 'netherite_axe', 'golden_axe'].map((t) => [t ?? 'hand', breakTicks('oak_log', t)]),
    );
    expect(got).toEqual({ hand: 60, wooden_axe: 30, stone_axe: 15, copper_axe: 12, iron_axe: 10, diamond_axe: 8, netherite_axe: 7, golden_axe: 5 });
  });
  it('grass_block and dirt: axes do not help (measured on BDS 1.26.51)', () => {
    for (const t of [null, 'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'wooden_pickaxe']) {
      expect(breakTicks('grass_block', t)).toBe(18);
      expect(breakTicks('dirt', t)).toBe(15);
    }
    expect(breakTicks('dirt', 'wooden_shovel')).toBe(8);
    expect(breakTicks('grass_block', 'iron_shovel')).toBe(3);
  });
  it('a wrong tool gives hand speed', () => {
    expect(breakTicks('oak_log', 'wooden_pickaxe')).toBe(60);
    expect(breakTicks('oak_log', 'diamond_shovel')).toBe(60);
    expect(breakTicks('oak_log', 'stick')).toBe(60);
  });
  it('blocks that need a tool take damage / 100 without it', () => {
    expect(breakTicks('stone', null)).toBe(150); // 7.5 s
    expect(breakTicks('stone', 'wooden_pickaxe')).toBe(23); // 1.15 s
    expect(breakTicks('stone', 'stone_pickaxe')).toBe(12); // 0.6 s
    expect(breakTicks('iron_ore', 'wooden_pickaxe')).toBe(150); // wooden cannot harvest iron ore
    expect(breakTicks('iron_ore', 'stone_pickaxe')).toBe(23);
    expect(breakTicks('obsidian', 'diamond_pickaxe')).toBe(188); // 9.4 s
    expect(canHarvest(blockMining('iron_ore')!, toolOf('wooden_pickaxe'))).toBe(false);
    expect(canHarvest(blockMining('iron_ore')!, toolOf('copper_pickaxe'))).toBe(true);
  });
  it('instant and unbreakable blocks', () => {
    expect(breakTicks('short_grass', null)).toBe(0);
    expect(breakTicks('bedrock', 'netherite_pickaxe')).toBe(Infinity);
    expect(breakTicks('oak_leaves', null)).toBe(6);
  });
  it('documented modifiers', () => {
    const log = blockMining('oak_log')!;
    expect(MODIFIERS.efficiencyBonus(0)).toBe(0);
    expect(MODIFIERS.efficiencyBonus(3)).toBe(10);
    expect(estimateBreak(log, toolOf('stone_axe'), { efficiency: 1 }).ticks).toBe(10); // speed 4 + 2
    expect(estimateBreak(log, null, { offGround: true }).ticks).toBe(300);
    expect(estimateBreak(log, null, { inWater: true, offGround: true }).ticks).toBe(1500);
    expect(estimateBreak(log, toolOf('iron_axe'), { haste: 2 }).ticks).toBe(8); // 6 * 1.4 = 8.4 -> 7.14 -> 8
    expect(estimateBreak(log, null, { miningFatigue: 1 }).ticks).toBe(200);
    // efficiency does nothing for a tool that is not effective
    expect(estimateBreak(log, toolOf('stone_pickaxe'), { efficiency: 5 }).ticks).toBe(60);
  });
  it('unknown blocks give undefined', () => {
    expect(breakTicks('no_such_block', null)).toBeUndefined();
  });
});
