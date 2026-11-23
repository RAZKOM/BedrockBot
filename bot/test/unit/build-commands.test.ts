// Track AL (docs/build.md "Commands"): `!build` on fakes: parsing, materials replies, refusing and
// fetching missing blocks, the build as a user process (status, stop, done line), the NL step text.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BuildController, filesLines, unknownLines, type BuildHost } from '../../src/chat/commands-build.ts';
import type { Structure } from '../../src/skills/build/formats/index.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../src/skills/craft/recipes.ts';
import { SMELTS } from '../../src/skills/food/smelt.ts';
import type { ItemStack } from '../../src/world/types.ts';
import type { ChatLine } from '../../src/chat/text.ts';
import { silentLogger } from '../../src/log.ts';
import { BuildProgress } from '../../src/skills/build/progress.ts';
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
    runner: (plan, hooks) => new BuildRunner(plan, { ...bot.deps(), ...hooks }),
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

  it('Track B3: a fetch step that changed nothing away from home is tried once more at home', async () => {
    const { h, dispatched } = host({ dirt: 16 });
    const approached: unknown[] = [];
    h.home = () => ({ x: 40, y: F, z: 40 });
    h.approach = (p) => {
      approached.push(p);
      return Promise.resolve(true);
    };
    const c = new BuildController(h);
    const r = await cmd(c, `wall 0 ${F} 5 9 5 4 cobblestone fetch`);
    expect(dispatched).toEqual(['get cobblestone 40', 'get cobblestone 40']);
    expect(approached).toEqual([{ x: 40, y: F, z: 40 }]);
    expect(r[1]).toBe('build: fetch for wall 10x4 cobblestone stopped after 2 commands: !get cobblestone 40 changed nothing');
    // at home already: no walk, no second try
    const near = host({ dirt: 16 });
    near.h.home = () => ({ x: 2, y: F, z: 2 });
    near.h.approach = (p) => {
      approached.push(p);
      return Promise.resolve(true);
    };
    await cmd(new BuildController(near.h), `wall 0 ${F} 5 9 5 4 cobblestone fetch`);
    expect(near.dispatched).toEqual(['get cobblestone 40']);
    expect(approached).toHaveLength(1);
  });

  it('Track B3: a round short of scaffold blocks gets them, the carried ones counted once', () => {
    // 20 cobblestone carried (16 of them the reserve), a peak of 21: 1 short (the scaffold takes the reserve too); the
    // usable 4 beyond the reserve are the scaffold's already, so they do not cover it a second time (e2e castle: a
    // round that brought nothing, then a column top with no block)
    const { h } = host({ cobblestone: 20, stone_bricks: 10 });
    const c = new BuildController(h);
    const bill = c.billFor({ materials: { stone_bricks: 10 }, scaffoldPeak: 21 });
    expect(bill.ok).toBe(false);
    expect(bill.get).toEqual([expect.objectContaining({ item: 'cobblestone', n: 1 })]);
    // the build's own cobblestone is still covered by what is carried beyond the reserve: 10 placed, 21 scaffold, 30
    // carried -> 1 short
    const own = host({ cobblestone: 30 });
    const b2 = new BuildController(own.h).billFor({ materials: { cobblestone: 10 }, scaffoldPeak: 21 });
    expect(b2.get).toEqual([expect.objectContaining({ item: 'cobblestone', n: 1 })]);
    // enough carried: nothing to fetch
    const enough = host({ cobblestone: 21, stone_bricks: 10 });
    expect(new BuildController(enough.h).billFor({ materials: { stone_bricks: 10 }, scaffoldPeak: 21 }).ok).toBe(true);
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

  it('Track B1: materials of a file list its refused blocks with their reasons; the build places the rest', async () => {
    const { h, said } = host({ oak_stairs: 2, dirt: 16 });
    h.load = (name) => ({
      name,
      file: `${name}.mcstructure`,
      size: { x: 3, y: 1, z: 1 },
      blocks: [
        { pos: { x: 0, y: 0, z: 0 }, name: 'oak_stairs', states: { weirdo_direction: 0, upside_down_bit: false } },
        { pos: { x: 1, y: 0, z: 0 }, name: 'water', states: { liquid_depth: 0 } },
        { pos: { x: 2, y: 0, z: 0 }, name: 'oak_stairs', states: { weirdo_direction: 0, upside_down_bit: false } },
      ],
    });
    const c = new BuildController(h);
    expect(await cmd(c, `materials file hut 2 ${F} 2`)).toEqual(['materials for file hut at 2 -60 2: 2 oak_stairs; have everything; 1 refused (water: no liquids)']);
    const r = await cmd(c, `file hut 2 ${F} 2`);
    expect(r[0]).toMatch(/^building file hut at 2 -60 2: 2 to place, 1 refused \(water: no liquids\)/);
    await until(() => said.length > 0);
    expect(said[0]).toMatch(/^build file hut at 2 -60 2: done, 2 \/ 2 placed, 0 skipped in \d+ s.*; 1 refused \(water: no liquids\)$/);
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
      // `!bring <item> <n>`: n in all, what is carried counting first (Track B3: the bill names carried + home)
      const n = Math.min(Math.max(0, Number(w[2]) - items.count(w[1]!)), homeLeft.get(w[1]!) ?? 0);
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

  it('both tracks in one file: the refused Bedrock blocks (Track B1) on the materials line, the bill, then the unknown Java blocks (Track B2)', async () => {
    const u: Structure = { ...S, blocks: [...blocks(['oak_planks', 'stone_bricks']), { pos: { x: 0, y: 1, z: 0 }, name: 'water' }], unknown: [{ java: 'create:gearbox[axis=x]', count: 4, reason: 'not a Bedrock block' }] };
    const t = fetchHost({ oak_planks: 1, dirt: 16 }, {}, u);
    const c = new BuildController(t.h);
    const m = await cmd(c, 'materials file hut 2 -60 5');
    expect(m[0]).toBe('materials for file hut at 2 -60 5: 1 oak_planks, 1 stone_bricks; need 1 more stone_bricks; 1 refused (water: no liquids)');
    expect(m[1]).toMatch(/^bill for file hut at 2 -60 5: /);
    expect(m.at(-1)).toBe('unknown: create:gearbox[axis=x] x 4 (not a Bedrock block)');
    // a materials line too long for the chat with the refusals: they go on a line of their own
    const long = Array.from({ length: 9 }, (_, i) => ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'cyan'][i]! + '_glazed_terracotta');
    const t2 = fetchHost({ dirt: 16 }, {}, { ...S, blocks: [...blocks(long), { pos: { x: 0, y: 1, z: 0 }, name: 'lava' }] });
    const m2 = await cmd(new BuildController(t2.h), 'materials file hut 2 -60 5');
    expect(m2[0]).not.toMatch(/refused/);
    expect(m2[1]).toBe('build: 1 refused (lava: no liquids)');
    expect(m2[2]).toMatch(/^bill for file hut at 2 -60 5: /);
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

  it('a file over 262 144 blocks is refused with its size (Track B3: 4096 before)', async () => {
    const big: Structure = { name: 'castle', size: { x: 66, y: 66, z: 66 }, blocks: Array.from({ length: 262_145 }, (_, i) => ({ pos: { x: i % 66, y: Math.floor(i / 4356), z: Math.floor(i / 66) % 66 }, name: 'stone' })) };
    const t = fetchHost({}, {}, big);
    expect(await cmd(new BuildController(t.h), 'file castle 0 -60 0')).toEqual(['build: castle: 262145 blocks in 66x66x66 is too big (at most 262144)']);
  });

  it('!build files', async () => {
    const t = fetchHost({}, {}, S);
    t.h.files = () => ({ files: [{ name: 'hut', file: 'x', format: 'schem', bytes: 1300, size: { x: 6, y: 1, z: 1 }, blocks: 6, unknown: 2 }, { name: 'bad', file: 'y', format: 'nbt', bytes: 4, error: 'no size [x, y, z]' }], more: 0 });
    expect(await cmd(new BuildController(t.h), 'files')).toEqual([expect.stringMatching(/^build files: hut \(schem, 6x1x1, 6 blocks, 2 unknown, 1\.3 KB\), bad \(nbt, 4 B: no size \[x, y, z\]\)$/)]);
    expect(filesLines({ files: [], more: 0 })).toEqual(['build files: none in the build folders (.mcstructure, .json, .schem, .schematic, .litematic, .nbt)']);
  });
});

// Track B3 (ADR 0128): fetch rounds for what does not fit, the progress, !build resume, the resume after a restart
describe('large builds (Track B3)', () => {
  const junk = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`junk_${i}`, 1]));
  const tmp = mkdtempSync(join(tmpdir(), 'b3-commands-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('blocks that do not fit in the inventory come in rounds as the build goes', async () => {
    const t = fetchHost({ dirt: 16, ...junk }, { stone: 400 }, { name: 'x', size: { x: 1, y: 1, z: 1 }, blocks: [] });
    const c = new BuildController(t.h);
    const r = await cmd(c, `fill 0 ${F} 5 9 ${F + 2} 12 stone fetch`);
    expect(r).toEqual(['building fill 10x3x8 stone: 240 to place in 1 section; fetching in rounds as it goes']);
    await until(() => t.said.length > 0);
    await until(() => t.said.length > 0 && t.pm.userProcesses().length === 0);
    expect(t.said[0]).toMatch(/^build fill 10x3x8 stone: done, 240 \/ 240 placed, 0 skipped in \d+ s.* \(1 section, 4 fetch rounds\)/);
    // one stack a round (36 slots less 31 kinds of junk less 4 kept free), each brings what makes the round in all
    expect(t.dispatched).toEqual(['bring stone 64 home', 'bring stone 64 home', 'bring stone 64 home', 'bring stone 48 home']);
    for (let x = 0; x <= 9; x++) for (let z = 5; z <= 12; z++) expect(t.bot.world.name({ x, y: F + 2, z })).toBe('stone');
  });

  it('a build over one section is planned a section at a time; materials of it come from its blocks', async () => {
    const t = host({ stone: 5000, dirt: 16 });
    const c = new BuildController(t.h);
    expect(await cmd(c, `materials floor 0 ${F} 10 69 69 stone`)).toEqual(['materials for floor 70x60 stone: 4200 stone; have everything']);
    const r = await cmd(c, `floor 0 ${F} 10 69 69 stone`);
    expect(r).toEqual(['building floor 70x60 stone: 4200 to place in 2 sections']);
    expect(c.status()).toMatch(/^build: \d+ \/ 4200 placed, \d+ skipped, section [12] of 2/);
    await until(() => t.said.length > 0);
    for (let i = 0; i < 400 && t.said.length === 0; i++) await new Promise((res) => setTimeout(res, 20));
    expect(t.said[0]).toMatch(/^build floor 70x60 stone: done, 4200 \/ 4200 placed, 0 skipped .*\(2 sections\)/);
  });

  it('!build stop, then !build resume: the cells done are checked first, a changed one is reported and left', async () => {
    const file = join(tmp, 'stop.json');
    const t = host({ stone: 100, dirt: 16 });
    t.h.progressFile = () => file;
    const c = new BuildController(t.h);
    let n = 0;
    let stopped = '';
    t.bot.onStep = () => {
      if (++n === 12) stopped = c.stop();
    };
    await cmd(c, `floor 2 ${F} 2 6 6 stone`);
    await until(() => stopped !== '' && t.pm.userProcesses().length === 0);
    expect(stopped).toMatch(/^stopped build floor 5x5 stone: \d+ \/ 25 placed/);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { state: string; count: number; args: string[] };
    expect(saved.state).toBe('stopped');
    expect(saved.args).toEqual(['floor', '2', String(F), '2', '6', '6', 'stone']);
    expect(saved.count).toBeGreaterThan(2);
    // someone takes a done block and puts another one in its place
    const done = [...new BuildProgress(file, saved as never).cells()];
    t.bot.world.set(done[0]!, 'oak_planks');
    t.bot.onStep = undefined;
    const r = await cmd(c, 'resume');
    expect(r[0]).toMatch(new RegExp(`^resuming build floor 5x5 stone: ${saved.count - 1} of 25 done; 1 changed since, 1 another block \\(left\\): ${done[0]!.x} ${F} ${done[0]!.z} oak_planks$`));
    await until(() => t.said.length > 0 && t.pm.userProcesses().length === 0);
    // a block placed as the stop came is not marked: the plan finds it there (already) and does not count it
    expect(t.said.at(-1)).toMatch(/^build floor 5x5 stone: done, (23 \/ 23|24 \/ 24) placed/);
    expect(t.bot.world.name(done[0]!)).toBe('oak_planks');
    expect((JSON.parse(readFileSync(file, 'utf8')) as { state: string }).state).toBe('done');
    expect(await cmd(c, 'resume')).toEqual(['build: floor 5x5 stone is done (nothing to resume)']);
  });

  it('!build stop on a column: the scaffold comes down in a process of its own; the progress forgets it', async () => {
    const file = join(tmp, 'column.json');
    const t = host({ stone: 40, cobblestone: 32, dirt: 16 });
    t.h.progressFile = () => file;
    t.h.columnMax = () => 12;
    const c = new BuildController(t.h);
    let stopped = '';
    t.bot.onStep = () => {
      if (!stopped && c.perched() && t.bot.feet.y > F + 5) stopped = c.stop();
    };
    await cmd(c, `wall 0 ${F} 6 2 6 12 stone`);
    await until(() => stopped !== '' && t.pm.userProcesses().length === 0);
    expect(stopped).toMatch(/^stopped build wall 3x12 stone: \d+ \/ 36 placed, 0 skipped; taking \d+ scaffold blocks? down$/);
    for (const [k, b] of t.bot.world.cells) if (b.name === 'cobblestone') expect(Number(k.split(',')[1])).toBeLessThanOrEqual(-61);
    expect(t.bot.feet.y).toBe(F);
    await until(() => (JSON.parse(readFileSync(file, 'utf8')) as { scaffolds?: string[] }).scaffolds === undefined);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { state: string; scaffolds?: string[] }).scaffolds).toBeUndefined();
  });

  it('a build running when the task stops goes on after a restart (buildResume), as who started it', async () => {
    const file = join(tmp, 'restart.json');
    const t = host({ stone: 100, dirt: 16 });
    t.h.progressFile = () => file;
    const c = new BuildController(t.h);
    let n = 0;
    t.bot.onStep = () => {
      if (++n === 10) {
        // as the task stops: the controller's dispose, then the build process stopped by another part first (with
        // `stopped`, not `dispose`), then the manager's dispose
        c.dispose();
        for (const p of t.pm.userProcesses()) t.pm.stop(p, 'stopped');
        t.pm.dispose();
      }
    };
    await cmd(c, `wall 0 ${F} 9 9 9 2 stone`);
    await until(() => t.pm.userProcesses().length === 0 && (JSON.parse(readFileSync(file, 'utf8')) as { state: string }).state === 'running');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { state: string; owner: { source: string } };
    expect(saved.state).toBe('running');
    expect(saved.owner.source).toBe('Owner');
    // the bot is back: a new controller on the same file
    const t2 = host({ stone: 100, dirt: 16 });
    t2.bot.world.cells.clear();
    for (const [k, v] of t.bot.world.cells) t2.bot.world.cells.set(k, v);
    t2.h.progressFile = () => file;
    const c2 = new BuildController(t2.h);
    // back far from it (a respawn at the world spawn): not walked to by itself
    const home = { ...t2.bot.feet };
    t2.bot.feet = { x: 400, y: F, z: 9 };
    c2.autoResume();
    expect(t2.said).toEqual(['build: wall 10x2 stone was running when I went away, but it is 391 blocks away: !build resume goes on']);
    expect(t2.pm.userProcesses()).toEqual([]);
    t2.said.length = 0;
    t2.bot.feet = home;
    c2.autoResume();
    await until(() => t2.said.length >= 2 && t2.pm.userProcesses().length === 0);
    expect(t2.said[0]).toMatch(/^resuming build wall 10x2 stone: \d+ of 20 done$/);
    // a block placed as the task stopped is not marked: found there, not counted
    expect(t2.said[1]).toMatch(/^build wall 10x2 stone: done, (19 \/ 19|20 \/ 20) placed/);
    for (let x = 0; x <= 9; x++) expect(t2.bot.world.name({ x, y: F + 1, z: 9 })).toBe('stone');
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
