// Track AL (docs/build.md "Commands"): `!build` on fakes: parsing, materials replies, refusing and
// fetching missing blocks, the build as a user process (status, stop, done line), the NL step text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BuildController, filesLines, unknownLines, type BuildHost } from '../../src/chat/commands-build.ts';
import type { Structure } from '../../src/skills/build/formats/index.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../src/skills/craft/recipes.ts';
import { SMELTS } from '../../src/skills/food/smelt.ts';
import type { ItemStack } from '../../src/world/types.ts';
import type { ChatLine } from '../../src/chat/text.ts';
import { silentLogger } from '../../src/log.ts';
import { BuildRunner } from '../../src/skills/build/runner.ts';
import { buildStepText, lineColumns, parseSpec, unknownRefusal } from '../../src/skills/build/spec.ts';
import { BaseProcess, PRIORITY, ProcessManager } from '../../src/tasks/process/manager.ts';
import { FakeBot, FakeInventory, FlatWorld } from './skills/build-fakes.ts';

const F = -60;
const LINE: ChatLine = { type: 'chat', source: 'Owner', message: '!build', body: '!build', xuid: '', truth: false };

function host(inv: Record<string, number> = {}): { h: BuildHost; said: string[]; dispatched: string[]; bot: FakeBot; pm: ProcessManager } {
  const world = new FlatWorld();
  const bot = new FakeBot(world, new FakeInventory(inv), { x: 0.5, y: F, z: 0.5 });
  const pm = new ProcessManager();
  const said: string[] = [];
  const dispatched: string[] = [];
  const h: BuildHost = {
    world,
    position: () => bot.feet,
    inventory: bot.inv,
    throwawayMin: () => 16,
    scaffold: () => true,
    processes: pm,
    runner: (plan) => new BuildRunner(plan, bot.deps()),
    dispatch: (_line, c) => {
      dispatched.push(c);
    },
    load: () => {
      throw new Error('no files');
    },
    say: (m) => said.push(m),
    log: silentLogger,
  };
  return { h, said, dispatched, bot, pm };
}

async function cmd(c: BuildController, text: string): Promise<string[]> {
  const out: string[] = [];
  await c.run(LINE, text.split(' '), (m) => out.push(m));
  return out;
}

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('!build', () => {
  it('materials for a 10x4 wall with an empty inventory', async () => {
    const { h } = host();
    const c = new BuildController(h);
    // Track B2: then the bill (the reserve's 16 got with the 40)
    const lines = ['materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)', 'bill for wall 10x4 cobblestone: cobblestone 40: have none; get 40 with !get', 'bill: !get 56 cobblestone'];
    expect(await cmd(c, `materials wall 0 ${F} 5 9 5 4 cobblestone`)).toEqual(lines);
    expect(await cmd(c, 'materials')).toEqual(lines);
  });

  it('refuses a build without the blocks, and says how to fetch them', async () => {
    const { h, pm } = host({ cobblestone: 10 });
    const c = new BuildController(h);
    const r = await cmd(c, `fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`);
    expect(r).toEqual([
      'build: fill 5x3x5 cobblestone: 75 cobblestone; need 75 more cobblestone (throwaway reserve 6 short, never built with) (add fetch to get, craft and smelt them first)',
      'bill for fill 5x3x5 cobblestone: cobblestone 75: have none; get 75 with !get',
      'bill: !get 81 cobblestone',
    ]);
    expect(pm.userProcesses()).toHaveLength(0);
  });

  it('fetch runs !get for the missing blocks first, and stops when a command changes nothing', async () => {
    const { h, dispatched } = host({ dirt: 16 });
    const c = new BuildController(h);
    const r = await cmd(c, `wall 0 ${F} 5 9 5 4 cobblestone fetch`);
    expect(dispatched).toEqual(['get cobblestone 40']);
    expect(r[0]).toBe('build wall 10x4 cobblestone: fetching first: !get 40 cobblestone');
    expect(r[1]).toBe('build: fetch for wall 10x4 cobblestone stopped after 1 command: !get cobblestone 40 changed nothing');
  });

  it('builds as a user process: building ..., status, the done line', async () => {
    const { h, said, pm, bot } = host({ cobblestone: 75, dirt: 16 });
    const c = new BuildController(h);
    const r = await cmd(c, `fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`);
    expect(r).toEqual(['building fill 5x3x5 cobblestone: 75 to place']);
    await until(() => said.length > 0);
    expect(said[0]).toMatch(/^build fill 5x3x5 cobblestone: done, 75 \/ 75 placed, 0 skipped in \d+ s/);
    expect(pm.userProcesses()).toHaveLength(0);
    expect(bot.world.name({ x: 4, y: F + 1, z: 4 })).toBe('cobblestone');
    expect(await cmd(c, 'status')).toEqual([`build: idle (last: ${said[0]})`]);
  });

  it('stop ends the build; status while it runs', async () => {
    const { h, pm, bot } = host({ stone: 100 });
    const c = new BuildController(h);
    let n = 0;
    let line = '';
    bot.onStep = () => {
      if (++n === 3) {
        line = c.status();
        pm.hold();
      }
    };
    await cmd(c, `floor 2 ${F} 0 9 0 stone`);
    await until(() => line !== '');
    expect(line).toMatch(/^build: [0-2] \/ 8 placed, 0 skipped/);
    expect(c.status()).toMatch(/\(paused\)$/);
    expect(await cmd(c, 'stop')).toEqual([expect.stringMatching(/^stopped build floor 8x1 stone: \d \/ 8 placed, 0 skipped$/)]);
    expect(pm.userProcesses()).toHaveLength(0);
    expect(await cmd(c, 'stop')).toEqual(['build: nothing to stop']);
  });

  it('usage and errors', async () => {
    const { h } = host();
    const c = new BuildController(h);
    expect((await cmd(c, 'fly'))[0]).toMatch(/^build: unknown build "fly"/);
    expect(await cmd(c, 'fill 1 2 3')).toEqual(['build: fill x1 y1 z1 x2 y2 z2 <block>']);
    expect(await cmd(c, 'pillar 0 0 0 3 water')).toEqual(['build: water: no liquids']);
    expect(await cmd(c, 'file hut')).toEqual(['build: no files']);
  });
});

// Track B2: the fetch through the bill on fakes: the home chests, a crafter, a furnace and a smelter that act at once
const fx = JSON.parse(readFileSync(new URL('./fixtures/crafting-data-build-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fx.items[String(id)]);
recipes.handle(fx);
const R: Record<string, { out: number; in: Record<string, number>; table?: boolean }> = {
  oak_planks: { out: 4, in: { oak_log: 1 } },
  crafting_table: { out: 1, in: { oak_planks: 4 } },
  oak_stairs: { out: 4, in: { oak_planks: 6 }, table: true },
  oak_slab: { out: 6, in: { oak_planks: 3 }, table: true },
  stone_bricks: { out: 4, in: { stone: 4 } },
  furnace: { out: 1, in: { cobblestone: 8 }, table: true },
};

function fetchHost(inv: Record<string, number>, home: Record<string, number>, structure: Structure) {
  const t = host(inv);
  const homeLeft = new Map(Object.entries(home));
  let furnace = false;
  let clock = 0;
  const items = t.bot.inv;
  const craft = (item: string, n: number): void => {
    const r = R[item]!;
    if (r.table && items.count('crafting_table') === 0) craft('crafting_table', 1);
    const crafts = Math.ceil(n / r.out);
    for (const [k, v] of Object.entries(r.in)) {
      const short = v * crafts - items.count(k);
      if (short > 0) craft(k, short);
      items.add(k, -v * crafts);
    }
    items.add(item, crafts * r.out);
  };
  const slots = (): ItemStack[] => [...items.items.entries()].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, networkId: 0, metadata: 0 }));
  t.h.slots = slots;
  t.h.bill = () => ({ recipes, chain: {}, furnaceNear: () => furnace, home: () => new Map(homeLeft) });
  t.h.now = () => clock;
  t.h.sleep = async (ms) => {
    clock += ms;
    await Promise.resolve();
  };
  t.h.load = () => ({ ...structure, file: 'test' });
  t.h.dispatch = (_l, c) => {
    t.dispatched.push(c);
    const w = c.split(' ');
    if (w[0] === 'bring') {
      const n = Math.min(Number(w[2]), homeLeft.get(w[1]!) ?? 0);
      homeLeft.set(w[1]!, (homeLeft.get(w[1]!) ?? 0) - n);
      items.add(w[1]!, n);
    } else if (w[0] === 'craft') craft(w[1]!, Number(w[2]));
    else if (w[0] === 'furnace') {
      if (items.count('furnace') === 0) craft('furnace', 1);
      items.add('furnace', -1);
      furnace = true;
    } else if (w[0] === 'smelt') {
      const n = Number(w[2]);
      items.add(w[1]!, -n);
      items.add(SMELTS[w[1]!]!, n);
      items.add('oak_planks', -Math.ceil(n / 1.5));
    }
  };
  return t;
}

describe('fetch through the bill (Track B2)', () => {
  const blocks = (names: string[]) => names.map((name, i) => ({ pos: { x: i, y: 0, z: 0 }, name }));
  const S: Structure = { name: 'hut', size: { x: 6, y: 1, z: 1 }, blocks: blocks(['oak_planks', 'oak_planks', 'oak_stairs', 'oak_stairs', 'glass', 'stone_bricks']), format: 'schem' };

  it('brings from home, crafts, sets a furnace down, smelts, crafts what waited, then builds', async () => {
    const t = fetchHost({ dirt: 16 }, { oak_log: 10, sand: 4, cobblestone: 20 }, S);
    const c = new BuildController(t.h);
    const r = await cmd(c, 'file hut 2 -60 5 fetch');
    expect(r[0]).toMatch(/^build file hut at 2 -60 5: fetching first: from home: /);
    expect(t.dispatched[0]).toMatch(/^bring oak_log \d+ home$/);
    expect(t.dispatched).toContain('furnace');
    const at = (x: string) => t.dispatched.findIndex((d) => d.startsWith(x));
    expect(at('furnace')).toBeGreaterThan(at('bring cobblestone'));
    expect(at('smelt cobblestone')).toBeGreaterThan(at('furnace'));
    expect(at('craft stone_bricks')).toBeGreaterThan(at('smelt cobblestone'));
    expect(at('smelt sand')).toBeGreaterThan(at('furnace'));
    expect(r[r.length - 1]).toBe('building file hut at 2 -60 5: 6 to place');
    expect(c.fetched).toEqual(t.dispatched);
    await until(() => t.said.length > 0);
    expect(t.said[0]).toMatch(/^build file hut at 2 -60 5: done, 6 \/ 6 placed/);
    expect(t.bot.world.name({ x: 6, y: F, z: 5 })).toBe('glass');
  });

  it('the fetch is a user process: status names the step, !build stop and !stop end it', async () => {
    class Step extends BaseProcess {
      readonly kind = 'user' as const;
      readonly name: string;
      constructor(name: string) {
        super();
        this.name = name;
      }
      get priority(): number {
        return PRIORITY.user;
      }
      protected run(): void {}
      protected halt(): void {}
      status() {
        return { line: this.name };
      }
    }
    for (const how of ['build stop', 'stop'] as const) {
      const t = fetchHost({ dirt: 16 }, { oak_log: 10, sand: 4, cobblestone: 20 }, S);
      const seen: string[] = [];
      let n = 0;
      const sleep0 = t.h.sleep!.bind(t.h);
      t.h.dispatch = (_l, command) => {
        t.dispatched.push(command);
        t.pm.add(new Step(command.split(' ')[0]!));
      };
      const c = new BuildController(t.h);
      t.h.sleep = async (ms) => {
        if (++n === 5) {
          seen.push(c.status(), t.pm.userProcesses().map((p) => p.name).sort().join(','));
          if (how === 'build stop') seen.push(c.stop());
          else seen.push(t.pm.stopUser().join(','));
        }
        await sleep0(ms);
      };
      const r = await cmd(c, 'file hut 2 -60 5 fetch');
      expect(seen[0]).toMatch(/^build: fetching materials for file hut at 2 -60 5: step 1, !bring oak_log \d+ home \(\d+ s; \d+ s in all\)$/);
      expect(seen[1]).toBe('bring,build');
      if (how === 'build stop') {
        expect(seen[2]).toMatch(/^build: fetch for file hut at 2 -60 5 cancelled \(at step 1, !bring oak_log \d+ home\)$/);
        expect(t.pm.userProcesses().map((p) => p.name)).toEqual(['bring']); // the step's own process is its command's
      } else {
        expect(c.status()).toMatch(/^build: idle \(last: build: fetch for file hut at 2 -60 5 ended at step 1: stopped\)$/);
        expect(t.pm.userProcesses()).toEqual([]);
      }
      expect(t.dispatched).toHaveLength(1);
      expect(r).toHaveLength(1);
    }
  });

  it('cannot get: refused before any command', async () => {
    const t = fetchHost({}, {}, { ...S, blocks: blocks(['end_stone']) });
    const c = new BuildController(t.h);
    const r = await cmd(c, 'file hut 2 -60 5 fetch');
    expect(r).toEqual(['build: nothing fetched: cannot get 1 end_stone (no recipe and !get does not know it)', 'materials for file hut at 2 -60 5: 1 end_stone; need 1 more end_stone (throwaway reserve 16 short, never built with)']);
    expect(t.dispatched).toEqual([]);
  });

  it('a file with unknown blocks is refused with them; skip unknown builds without them; materials lists them a line each', async () => {
    const u: Structure = { ...S, blocks: blocks(['oak_planks']), unknown: [{ java: 'create:gearbox[axis=x]', count: 4, reason: 'not a Bedrock block' }, { java: 'id 300', count: 1, reason: 'not a vanilla block id' }] };
    const t = fetchHost({ oak_planks: 1, dirt: 16 }, {}, u);
    const c = new BuildController(t.h);
    expect(await cmd(c, 'file hut 2 -60 5')).toEqual(['build: hut: 5 blocks have no Bedrock block: create:gearbox[axis=x] x 4 (not a Bedrock block), id 300 x 1 (not a vanilla block id) (add skip unknown to build without them; !build materials lists them)']);
    const m = await cmd(c, 'materials file hut 2 -60 5');
    expect(m.slice(1)).toEqual(['unknown: create:gearbox[axis=x] x 4 (not a Bedrock block)', 'unknown: id 300 x 1 (not a vanilla block id)']);
    expect(m[0]).toBe('materials for file hut at 2 -60 5: 1 oak_planks; have everything');
    expect(await cmd(c, 'file hut 2 -60 5 skip unknown')).toEqual(['building file hut at 2 -60 5, 5 unknown skipped: 1 to place']);
    expect(unknownLines(Array.from({ length: 10 }, (_, i) => ({ java: `m:b${i}`, count: 2, reason: 'not a Bedrock block' })))).toHaveLength(9);
  });

  it('every reply fits one chat reply (the chat cuts at 256): many unknown kinds, a long fetch line', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ java: `somemod:a_rather_long_block_name_${i}[facing=north,powered=false]`, count: 3, reason: 'not a Bedrock block' }));
    const t = fetchHost({ oak_planks: 1, dirt: 16 }, {}, { ...S, blocks: blocks(['oak_planks']), unknown: many });
    const r = await cmd(new BuildController(t.h), 'file hut 2 -60 5');
    expect(r).toHaveLength(1);
    expect(r[0]!.length).toBeLessThanOrEqual(256);
    expect(r[0]).toMatch(/^build: hut: 36 blocks have no Bedrock block: somemod:a_rather_long_block_name_0\[facing=north,powered=false\] x 3 \(not a Bedrock block\), 11 more kinds \(add skip unknown to build without them; !build materials lists them\)$/);
    const one = unknownRefusal('hut', [{ java: `somemod:${'x'.repeat(300)}`, count: 1, reason: 'not a Bedrock block' }]);
    expect(one.length).toBeLessThanOrEqual(240);
    expect(one).toMatch(/^hut: 1 block has no Bedrock block: somemod:x+\.\.\. x 1 \(not a Bedrock block\) \(add skip unknown/);
    // the fetch's first lines: the steps split where a line is full
    const t2 = fetchHost({ dirt: 16 }, { oak_log: 64, sand: 64, cobblestone: 64, clay_ball: 64, spruce_log: 64 }, S);
    t2.h.dispatch = (_l, command) => t2.dispatched.push(command);
    const r2 = await cmd(new BuildController(t2.h), 'file hut 2 -60 5 fetch');
    expect(r2[0]).toMatch(/^build file hut at 2 -60 5: fetching first: from home: /);
    for (const l of r2) expect(l.length).toBeLessThanOrEqual(256);
    // a long materials line: the fetch hint on a line of its own
    const kinds = ['stone_bricks', 'smooth_stone', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'];
    const t3 = fetchHost({ dirt: 16 }, {}, { name: 'kinds', size: { x: 10, y: 1, z: 1 }, blocks: blocks(kinds) });
    const r3 = await cmd(new BuildController(t3.h), 'file kinds 2 -60 5');
    expect(r3[0]).toMatch(/^build: file kinds at 2 -60 5: /);
    expect(r3[1]).toBe('build: add fetch to get, craft and smelt them first');
    expect(r3[2]).toMatch(/^bill for file kinds at 2 -60 5: /);
  });

  it('a file over 4096 blocks is refused with its size', async () => {
    const big: Structure = { name: 'castle', size: { x: 20, y: 11, z: 20 }, blocks: Array.from({ length: 4400 }, (_, i) => ({ pos: { x: i % 20, y: Math.floor(i / 400), z: Math.floor(i / 20) % 20 }, name: 'stone' })) };
    const t = fetchHost({}, {}, big);
    expect(await cmd(new BuildController(t.h), 'file castle 0 -60 0')).toEqual(['build: castle: 4400 blocks in 20x11x20 is too big (at most 4096)']);
  });

  it('!build files', async () => {
    const t = fetchHost({}, {}, S);
    t.h.files = () => ({ files: [{ name: 'hut', file: 'x', format: 'schem', bytes: 1300, size: { x: 6, y: 1, z: 1 }, blocks: 6, unknown: 2 }, { name: 'bad', file: 'y', format: 'nbt', bytes: 4, error: 'no size [x, y, z]' }], more: 0 });
    expect(await cmd(new BuildController(t.h), 'files')).toEqual([expect.stringMatching(/^build files: hut \(schem, 6x1x1, 6 blocks, 2 unknown, 1\.3 KB\), bad \(nbt, 4 B: no size \[x, y, z\]\)$/)]);
    expect(filesLines({ files: [], more: 0 })).toEqual(['build files: none in the build folders (.mcstructure, .json, .schem, .schematic, .litematic, .nbt)']);
  });
});

describe('spec', () => {
  it('~ is the bot position', () => {
    const r = parseSpec('pillar ~2 ~ ~-1 3 stone'.split(' '), { feet: { x: 10.7, y: -60, z: 5.2 } });
    expect(r.ok && r.spec.places.map((b) => b.pos)).toEqual([
      { x: 12, y: -60, z: 4 },
      { x: 12, y: -59, z: 4 },
      { x: 12, y: -58, z: 4 },
    ]);
  });

  it('walls follow straight and diagonal lines', () => {
    expect(lineColumns(0, 0, 3, 0)).toHaveLength(4);
    expect(lineColumns(0, 0, 3, 3)).toEqual([0, 1, 2, 3].map((i) => ({ x: i, z: i })));
    const r = parseSpec(`wall 0 ${F} 5 9 5 4 cobblestone`.split(' '));
    expect(r.ok && r.spec.places).toHaveLength(40);
  });

  it('NL step text', () => {
    expect(buildStepText({ shape: 'wall', x: 0, y: -60, z: 0, x2: 9, z2: 0, height: 4, block: 'cobblestone' })).toBe('build wall 0 -60 0 9 0 4 cobblestone');
    expect(buildStepText({ shape: 'pillar', height: 7, block: 'stone' })).toBe('build pillar ~ ~ ~ 7 stone');
    expect(buildStepText({ shape: 'file', name: 'hut' })).toBe('build file hut');
    expect(buildStepText({ shape: 'fill', x: 1, y: 2, z: 3, block: 'stone' })).toBe('build fill 1 2 3 ? ? ? stone');
  });
});
