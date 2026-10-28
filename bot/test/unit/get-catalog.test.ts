// Wave 8 Track AD: the `!get` catalog (skills/items/catalog.ts) and the !get controller (chat/commands-get.ts) on fakes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetController, startLine } from '../../src/chat/commands-get.ts';
import type { ChatLine } from '../../src/chat/text.ts';
import { categories, commandFor, DEFAULT_COUNTS, entryFor, lookup, minedItem, parseGetArgs, unknownReply } from '../../src/skills/items/catalog.ts';
import type { Process } from '../../src/tasks/process/manager.ts';

describe('catalog: item -> strategy', () => {
  it('maps wood words to the gather process', () => {
    for (const n of ['wood', 'logs', 'log', 'oak', 'oak_log', 'oak_logs', 'minecraft:oak_log', 'Oak Logs', 'birch_log', 'spruce', 'tree', 'trees']) {
      expect(entryFor(n)?.strategy, n).toBe('gather');
    }
    expect(entryFor('oak')?.item).toBe('oak_log');
    expect(entryFor('birch')?.item).toBe('birch_log');
    expect(entryFor('wood')?.note).toBe('any log kind counts');
  });

  it('maps ores by drop, ore, raw and deepslate names to the mine process', () => {
    const cases: [string, string, string][] = [
      ['coal', 'coal_ore', 'coal'],
      ['coal_ore', 'coal_ore', 'coal'],
      ['deepslate_coal_ore', 'coal_ore', 'coal'],
      ['iron', 'iron_ore', 'raw_iron'],
      ['raw_iron', 'iron_ore', 'raw_iron'],
      ['iron_ore', 'iron_ore', 'raw_iron'],
      ['iron_ingot', 'iron_ore', 'raw_iron'],
      ['gold', 'gold_ore', 'raw_gold'],
      ['copper', 'copper_ore', 'raw_copper'],
      ['diamonds', 'diamond_ore', 'diamond'],
      ['minecraft:diamond', 'diamond_ore', 'diamond'],
      ['redstone', 'redstone_ore', 'redstone'],
      ['lapis', 'lapis_ore', 'lapis_lazuli'],
      ['lapis_lazuli', 'lapis_ore', 'lapis_lazuli'],
      ['emeralds', 'emerald_ore', 'emerald'],
    ];
    for (const [n, ore, item] of cases) {
      const e = entryFor(n);
      expect(e?.strategy, n).toBe('mine');
      expect(e?.target, n).toBe(ore);
      expect(e?.item, n).toBe(item);
    }
  });

  it('maps plain blocks to the mine process (what is dug)', () => {
    expect(entryFor('cobble')).toMatchObject({ strategy: 'mine', target: 'stone', item: 'cobblestone' });
    expect(entryFor('cobblestone')).toMatchObject({ strategy: 'mine', target: 'stone', item: 'cobblestone' });
    expect(entryFor('stone')).toMatchObject({ strategy: 'mine', target: 'stone' });
    expect(entryFor('dirt')).toMatchObject({ strategy: 'mine', target: 'dirt' });
    expect(entryFor('sand')).toMatchObject({ strategy: 'mine', target: 'sand' });
    expect(entryFor('gravel')).toMatchObject({ strategy: 'mine', target: 'gravel' });
    expect(entryFor('flint')).toMatchObject({ strategy: 'mine', target: 'gravel', item: 'flint' });
    expect(entryFor('flint')?.note).toMatch(/1 in 10 gravel/);
  });

  it('maps food to the food process and string to spiders', () => {
    for (const n of ['food', 'beef', 'steak', 'pork', 'porkchop', 'mutton', 'chicken', 'meat']) expect(entryFor(n)?.strategy, n).toBe('hunt');
    expect(commandFor(entryFor('food')!, 6)).toBe('food 6');
    expect(commandFor(entryFor('string')!, 4)).toBe('kill spider 4');
  });

  it('maps crops to the farm process', () => {
    expect(entryFor('wheat')).toMatchObject({ strategy: 'farm', target: 'wheat' });
    expect(entryFor('carrots')).toMatchObject({ strategy: 'farm', target: 'carrots', item: 'carrot' });
    expect(entryFor('potatoes')).toMatchObject({ strategy: 'farm', target: 'potatoes', item: 'potato' });
    expect(entryFor('beetroot')).toMatchObject({ strategy: 'farm', target: 'beetroot' });
    expect(commandFor(entryFor('wheat')!, 0)).toBe('farm');
  });

  it('knows nothing about bread, glass, or diamonds_sword', () => {
    for (const n of ['bread', 'glass', 'diamond_sword', 'planks', 'xyz']) expect(entryFor(n), n).toBeUndefined();
    expect(unknownReply('bread')).toBe(`get: I do not know how to get bread; I can get: ${categories()}`);
    expect(lookup('bread')).toEqual({ strategy: 'unknown', name: 'bread' });
  });

  it('counts default per strategy and are bounded by the command', () => {
    expect(DEFAULT_COUNTS).toEqual({ gather: 16, mine: 8, hunt: 6, farm: 0 });
    expect(lookup('oak_log')).toMatchObject({ count: 16, command: 'gather 16' });
    expect(lookup('coal')).toMatchObject({ count: 8, command: 'mine coal_ore 8' });
    expect(lookup('beef')).toMatchObject({ count: 6, command: 'food 6' });
    expect(lookup('wheat')).toMatchObject({ count: 0, command: 'farm' });
    expect(lookup('coal', 99999)).toMatchObject({ count: 9216, command: 'mine coal_ore 9216' });
    expect(lookup('beef', 100)).toMatchObject({ count: 64 });
  });

  it('parses the arguments in either order', () => {
    expect(parseGetArgs(['oak_log', '20'])).toEqual({ name: 'oak_log', count: 20 });
    expect(parseGetArgs(['20', 'oak_log'])).toEqual({ name: 'oak_log', count: 20 });
    expect(parseGetArgs(['iron', 'ore', '4'])).toEqual({ name: 'iron_ore', count: 4 });
    expect(parseGetArgs(['coal'])).toEqual({ name: 'coal', count: undefined });
    expect(parseGetArgs(['4'])).toEqual({ error: 'no item' });
    expect(parseGetArgs(['coal', '0'])).toEqual({ error: 'count must be 1 or more' });
    expect(parseGetArgs(['1', 'coal', '2'])).toEqual({ error: 'one count only' });
  });

  it('names the drop of a mined block', () => {
    expect(minedItem('coal_ore')).toBe('coal');
    expect(minedItem('deepslate_iron_ore')).toBe('raw_iron');
    expect(minedItem('lit_redstone_ore')).toBe('redstone');
    expect(minedItem('stone')).toBe('cobblestone');
    expect(minedItem('deepslate')).toBe('cobbled_deepslate');
    expect(minedItem('dirt')).toBe('dirt');
  });

  it('says which process it starts', () => {
    expect(startLine(lookup('oak_log', 20) as never)).toBe('getting 20 oak_log: gathering wood');
    expect(startLine(lookup('coal', 4) as never)).toBe('getting 4 coal: mining coal_ore');
    expect(startLine(lookup('wood') as never)).toBe('getting 16 logs: gathering wood (any log kind counts)');
    expect(startLine(lookup('wheat') as never)).toBe('getting wheat: farming wheat (one round of the field)');
  });
});

// ---- the controller on fakes --------------------------------------------------------------------

interface FakeProc extends Process {
  task?: { state: string; stats: { harvested: number; harvestedByCrop: Record<string, number>; rounds: number } };
}

function fakeProcess(name: string): FakeProc {
  return {
    name,
    kind: 'user',
    priority: 40,
    done: false,
    wants: () => true,
    start: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    stop: () => undefined,
    status: () => ({ line: `${name} line` }),
  };
}

const LINE: ChatLine = { type: 'whisper', source: 'Server', message: '!get coal 4', body: '!get coal 4', xuid: '', truth: false };

function harness() {
  const procs: FakeProc[] = [];
  const dispatched: string[] = [];
  const stopped: string[] = [];
  const c = new GetController({
    dispatch: (_line, command) => {
      dispatched.push(command);
      const name = command.split(' ')[0]!;
      procs.push(fakeProcess(name === 'kill' ? 'kill' : name));
    },
    processes: {
      userProcesses: () => procs.filter((p) => !p.done),
      find: (n: string) => procs.filter((p) => p.name === n),
      stop: (p: Process) => {
        (p as { done: boolean }).done = true;
        stopped.push(p.name);
        return true;
      },
    },
  });
  const replies: string[] = [];
  const run = (args: string) => c.run(LINE, args.split(' ').filter(Boolean), (m) => replies.push(m));
  return { c, procs, dispatched, stopped, replies, run };
}

describe('!get controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replies first, then runs the command for the strategy', () => {
    const h = harness();
    h.run('20 oak_log');
    h.run('coal 4');
    h.run('beef');
    h.run('string 3');
    expect(h.replies).toEqual(['getting 20 oak_log: gathering wood', 'getting 4 coal: mining coal_ore', 'getting 6 beef: hunting food mobs (any food mob counts)', 'getting 3 string: hunting spiders (counting spiders killed)']);
    expect(h.dispatched).toEqual(['gather 20', 'mine coal_ore 4', 'food 6', 'kill spider 3']);
    expect(h.c.job?.process?.name).toBe('kill');
  });

  it('answers unknown items and bad arguments without running anything', () => {
    const h = harness();
    h.run('bread');
    h.run('');
    h.run('4');
    expect(h.replies[0]).toMatch(/^get: I do not know how to get bread; I can get: wood/);
    expect(h.replies[1]).toBe('usage: !get <item> [n] | stop | status');
    expect(h.replies[2]).toBe('usage: !get <item> [n] (no item)');
    expect(h.dispatched).toEqual([]);
  });

  it('stop and status name the process it started', () => {
    const h = harness();
    h.run('status');
    h.run('stop');
    h.run('coal 4');
    h.run('status');
    h.run('stop');
    h.run('status');
    expect(h.replies).toEqual(['get: idle', 'get: nothing to stop', 'getting 4 coal: mining coal_ore', 'get: 4 coal via !mine coal_ore 4: mine line', 'stopped mine line', 'get: idle (last: 4 coal via !mine coal_ore 4)']);
    expect(h.stopped).toEqual(['mine']);
  });

  it('farm: stops the farm process after one round of the field, or after n of the crop', () => {
    vi.useFakeTimers();
    const h = harness();
    h.run('wheat');
    const p = h.procs[0]!;
    p.task = { state: 'harvest', stats: { harvested: 3, harvestedByCrop: { wheat: 3 }, rounds: 1 } };
    vi.advanceTimersByTime(1000);
    expect(h.stopped).toEqual([]);
    p.task.state = 'waiting';
    vi.advanceTimersByTime(1000);
    expect(h.stopped).toEqual(['farm']);
    expect(h.replies.at(-1)).toBe('get wheat: 3 wheat harvested (3 crops in all), the field is done');
    h.run('carrots 5');
    const q = h.procs[1]!;
    q.task = { state: 'harvest', stats: { harvested: 4, harvestedByCrop: { carrots: 4 }, rounds: 1 } };
    vi.advanceTimersByTime(1000);
    expect(h.stopped).toEqual(['farm']);
    q.task.stats.harvestedByCrop.carrots = 5;
    vi.advanceTimersByTime(1000);
    expect(h.stopped).toEqual(['farm', 'farm']);
    expect(h.replies.at(-1)).toBe('get carrot: 5 carrots harvested (4 crops in all)');
  });
});
