// Track B5 (ADR 0130, docs/build.md "Replies that fit the chat"): every `!build` reply fits the chat. On the Realm
// `!build materials file mountain_house` (9 573 blocks, 125 kinds) said dozens of lines and the chat's queue dropped
// all of them. The guard: a fixture of 125 kinds with every bill section full (from my boxes, from home, !get, craft
// first, a furnace, smelt, fuel, cannot get), refused and unknown blocks, small (one plan) and large (a job); every reply
// of every `!build` command stays within REPLY_LINES lines of LINE_BYTES bytes, what it leaves out is said (`+N more`)
// and `!build more` pages through all of it; through the real Chat sender a burst of those commands drops nothing.
//   B5_PRINT=<file>  appends every reply (and the reconstructed old materials reply) to the file (for a check by hand)
import { appendFileSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildController, splitMore, type BuildBoxes, type BuildHost } from '../../src/chat/commands-build.ts';
import { Chat, parseOwners } from '../../src/chat/chat.ts';
import type { ChatLine } from '../../src/chat/text.ts';
import type { TextPacket } from '../../src/connection/types.ts';
import { panelRoutes } from '../../src/health/panel/routes.ts';
import { silentLogger, type Logger } from '../../src/log.ts';
import { billItemText, billSteps, packLines, stepWords } from '../../src/skills/build/bill.ts';
import type { Structure } from '../../src/skills/build/formats/index.ts';
import { materialsLine } from '../../src/skills/build/materials.ts';
import { refusedLine } from '../../src/skills/build/plan.ts';
import { bytes, cutBytes, fitEntries, fitLines, LINE_BYTES, pageLines, REPLY_LINES, wrapLine } from '../../src/skills/build/reply.ts';
import { BuildRunner } from '../../src/skills/build/runner.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../src/skills/craft/recipes.ts';
import { ProcessManager } from '../../src/tasks/process/manager.ts';
import type { ItemStack } from '../../src/world/types.ts';
import { connectAndSpawn, setup } from './connection-fakes.ts';
import { FakeBot, FakeInventory, FlatWorld } from './skills/build-fakes.ts';

const F = -60;
const LINE: ChatLine = { type: 'chat', source: 'Owner', message: '!build', body: '!build', xuid: '', truth: false };
const PRINT = process.env.B5_PRINT;
const print = (s: string): void => {
  if (PRINT) appendFileSync(PRINT, `${s}\n`);
};

const fx = JSON.parse(readFileSync(new URL('./fixtures/crafting-data-build-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fx.items[String(id)]);
recipes.handle(fx);

const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

/**
 * 125 kinds, `total` blocks: the big ones of the Realm's house (smooth quartz, azalea leaves, moss: nothing makes them),
 * planks, stairs, slabs and fences made from logs (in my boxes and at home), glass, stone, smooth stone and bricks
 * smelted, dirt and gravel got, some stone bricks carried; then colours (concrete, glazed terracotta, wool, stained
 * glass, terracotta, carpet) to 125 kinds.
 */
function kinds125(total: number, scale = 1): [string, number][] {
  const big: [string, number][] = (
    [
      ['smooth_quartz', 2297], ['stone_bricks', 900], ['oak_planks', 800], ['azalea_leaves', 364], ['moss_block', 311], ['glass', 300],
      ['spruce_planks', 250], ['oak_stairs', 200], ['oak_slab', 180], ['stone', 150], ['smooth_stone', 120], ['dirt', 100], ['gravel', 90],
      ['spruce_stairs', 80], ['oak_fence', 60], ['brick_block', 40], ['birch_planks', 40], ['cobblestone', 30], ['oak_log', 30], ['sandstone', 30],
    ] as [string, number][]
  ).map(([k, n]) => [k, Math.max(1, Math.round(n * scale))]);
  const rest: string[] = [];
  for (const fam of ['concrete', 'glazed_terracotta', 'wool', 'stained_glass', 'terracotta', 'carpet', 'concrete_powder']) for (const c of COLOURS) rest.push(`${c}_${fam}`);
  const names = rest.slice(0, 125 - big.length);
  const left = total - big.reduce((a, [, n]) => a + n, 0);
  return [...big, ...names.map((k, i) => [k, Math.floor(left / names.length) + (i < left % names.length ? 1 : 0)] as [string, number])];
}

/** Blocks the builder refuses, one reason each (Track B1's table), and Java blocks with no Bedrock block (Track B2). */
const REFUSED = ['water', 'lava', 'fire', 'bedrock', 'wheat', 'standing_banner', 'kelp', 'farmland', 'barrier', 'vine'];
const UNKNOWN = Array.from({ length: 12 }, (_, i) => ({ java: `create:mechanical_part_${i}[facing=north]`, count: 3 + i, reason: 'not a Bedrock block' }));

function structure(name: string, counts: readonly [string, number][], refused = REFUSED, unknown = UNKNOWN): Structure {
  const blocks: Structure['blocks'] = [];
  const side = 30;
  let i = 0;
  const put = (n: string) => {
    blocks.push({ pos: { x: i % side, y: Math.floor(i / (side * side)), z: Math.floor(i / side) % side }, name: n });
    i++;
  };
  for (const [k, n] of counts) for (let j = 0; j < n; j++) put(k);
  for (const k of refused) put(k);
  const y = Math.floor((i - 1) / (side * side)) + 1;
  return { name, size: { x: side, y, z: side }, blocks, format: 'litematic', ...(unknown.length ? { unknown } : {}) };
}

const LARGE = structure('mountain_house', kinds125(9573));
const SMALL = structure('cottage', kinds125(260, 0.02));

/** A controller on fakes: the recipes, carried shulker boxes of logs, home chests of raw materials, no furnace near. */
function host(s: Structure, o: { files?: number; log?: Logger } = {}) {
  const world = new FlatWorld();
  const inv = new FakeInventory({ stone_bricks: 64, dirt: 16, oak_planks: 3 });
  const bot = new FakeBot(world, inv, { x: 0.5, y: F, z: 0.5 });
  const pm = new ProcessManager();
  const said: string[] = [];
  const dispatched: string[] = [];
  const inBoxes = new Map(Object.entries({ oak_log: 128, spruce_log: 64 }));
  const bx: BuildBoxes = {
    contents: () => new Map([...inBoxes].filter(([, n]) => n > 0)),
    room: () => 20,
    carried: () => 2,
    take: () => Promise.resolve({ taken: {}, boxes: 0 }),
    stow: () => Promise.resolve({ stowed: {}, boxes: 0 }),
    outstanding: () => ({ standing: [], left: [] }),
    recover: () => Promise.resolve(),
    watch: () => undefined,
    adopt: () => undefined,
    pickUp: () => Promise.resolve(0),
  };
  let clock = 0;
  const h: BuildHost = {
    world,
    position: () => bot.feet,
    inventory: inv,
    slots: (): ItemStack[] => [...inv.items.entries()].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, networkId: 0, metadata: 0 })),
    boxed: (n) => inBoxes.get(n) ?? 0,
    boxes: () => bx,
    bill: () => ({ recipes, chain: {}, furnaceNear: () => false, home: () => new Map(Object.entries({ oak_log: 640, sand: 400, cobblestone: 600, clay_ball: 40 })) }),
    files: () => ({
      files: Array.from({ length: o.files ?? 3 }, (_, i) => ({ name: `castle_of_the_northern_mountains_${i}`, file: `f${i}`, format: 'litematic' as const, bytes: 123_456 + i, size: { x: 61, y: 40, z: 77 }, blocks: 40_000 + i, unknown: i % 3 })),
      more: 0,
    }),
    throwawayMin: () => 16,
    scaffold: () => true,
    processes: pm,
    runner: (plan, hooks) => new BuildRunner(plan, { ...bot.deps(), ...hooks }),
    dispatch: (_l, c) => {
      dispatched.push(c);
    },
    load: () => ({ ...s, file: 'test' }),
    say: (m) => said.push(m),
    log: o.log ?? silentLogger,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await Promise.resolve();
    },
  };
  return { h, said, dispatched, pm, inv, world };
}

async function cmd(c: BuildController, text: string): Promise<string[]> {
  const out: string[] = [];
  await c.run(LINE, text.split(' '), (m) => out.push(m));
  print(`> !build ${text}`);
  for (const l of out) print(`  ${l}  [${bytes(l)} B]`);
  return out;
}

/** The budget: at most REPLY_LINES lines, each at most LINE_BYTES bytes. */
function fits(r: readonly string[], n = REPLY_LINES): void {
  expect(r.length).toBeGreaterThan(0);
  expect(r.length).toBeLessThanOrEqual(n);
  for (const l of r) expect(bytes(l)).toBeLessThanOrEqual(LINE_BYTES);
}

/** The pages of `!build more` until the last: every page fits, and their lines are the whole full text. */
async function allPages(c: BuildController, first: readonly string[]): Promise<string[]> {
  const lines = [...first];
  const pages = Number(/\(page 1 of (\d+)/.exec(first.at(-1) ?? '')?.[1] ?? 1);
  for (let p = 2; p <= pages; p++) {
    const r = await cmd(c, `more ${p}`);
    fits(r);
    expect(r.at(-1)).toContain(`(page ${p} of ${pages}`);
    lines.push(...r);
  }
  return lines;
}

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('build replies fit the chat (Track B5)', () => {
  const at = '0 -60 4';

  it('the fixture: 125 kinds, 9 573 blocks, every bill section full', () => {
    const counts = new Map<string, number>();
    for (const b of LARGE.blocks) if (!REFUSED.includes(b.name)) counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
    expect(counts.size).toBe(125);
    expect([...counts.values()].reduce((a, n) => a + n, 0)).toBe(9573);
    const t = host(LARGE);
    const c = new BuildController(t.h);
    const bill = c.billFor({ materials: Object.fromEntries(counts), scaffoldPeak: 24 });
    print(`bill sections: unbox ${bill.unbox.length}, bring ${bill.bring.length}, get ${bill.get.length}, crafts ${bill.crafts.length}, furnace ${bill.furnace}, smelts ${bill.smelts.length}, fuel ${bill.fuel.length}, cannot ${bill.cannot.length}`);
    for (const k of ['unbox', 'bring', 'get', 'smelts', 'fuel', 'cannot'] as const) expect(bill[k].length).toBeGreaterThan(0);
    expect(bill.crafts.filter((x) => !bill.items.some((i) => i.item === x.item)).length).toBeGreaterThan(0); // craft first
    expect(bill.furnace).toBe(true);
    // before (the code before Track B5, reconstructed from the same line makers): the lines `!build materials` said
    const m = { lines: [...counts].map(([item, need]) => ({ item, need, have: 0, missing: need })), reserveShort: 0, scaffoldShort: 0, ok: false };
    // (the old cannot step named the reason after every item)
    const oldSteps = billSteps(bill).map((x) => (x.startsWith('cannot get ') ? `cannot get ${bill.cannot.map((c) => `${c.n} ${c.item} (${c.why})`).join(', ')}` : x));
    const label = 'file mountain_house at 0 -60 4';
    const entries = bill.items.map(billItemText);
    const oldBill = [...packLines([`bill for ${label}:`, ...entries.map((e, i) => (i < entries.length - 1 ? `${e} |` : e))]), ...packLines(['bill:', ...stepWords(oldSteps)])];
    const before = [`${materialsLine(label, m)}; ${refusedLine(REFUSED.map((n) => ({ name: n, reason: n })))}`.slice(0, 256), ...oldBill, ...UNKNOWN.slice(0, 8).map((u) => `unknown: ${u.java} x ${u.count} (${u.reason})`), 'unknown: 4 more kinds'];
    print(`before: !build materials said ${before.length} lines (${before.reduce((a, l) => a + bytes(l), 0)} bytes); the first 3: ${before.slice(0, 3).join(' || ')}`);
    expect(before.length).toBeGreaterThan(24); // more than the chat sends and queues (8 + 16): the Realm's dropped lines
  });

  for (const [what, s] of [['large (a job)', LARGE], ['small (one plan)', SMALL]] as const) {
    it(`${what}: every !build reply fits, the rest is said and !build more has all of it`, async () => {
      const t = host(s);
      const c = new BuildController(t.h);
      // the materials: the totals and what cannot be got first, the biggest items, the bill's steps, where the rest is
      const m = await cmd(c, `materials file ${s.name} ${at}`);
      fits(m);
      expect(m[0]).toMatch(new RegExp(`^materials for file ${s.name} at ${at}: \\d+ blocks, 125 kinds: \\d+ have \\(\\d+ at home\\), \\d+ to make or !get, \\d+ cannot get \\(smooth_quartz \\d+, .*\\+\\d+ more\\)$`));
      expect(m[1]).toMatch(/^most: smooth_quartz \d+, stone_bricks \d+, .*, \+\d+ more$/);
      expect(m[2]).toMatch(/^bill: from my boxes: .*; from home: .*; !get .*; .*10 refused \(\d+ reasons\); \d+ unknown \(12 kinds\) \(all: !build more\)$/);
      // every page of the full text fits; together they hold every item, every unknown and every refusal
      const p1 = await cmd(c, 'more');
      fits(p1);
      const all = (await allPages(c, p1)).join(' ');
      for (const b of new Set(s.blocks.map((x) => x.name))) expect(all).toMatch(new RegExp(`(^|[ (])${b}[ ,:;)]`));
      for (const u of UNKNOWN) expect(all).toContain(u.java);
      expect(all).toContain('bill for ');
      // `materials ... more [page]` and `page N` page through the same text
      fits(await cmd(c, `materials file ${s.name} ${at} more`));
      fits(await cmd(c, `materials file ${s.name} ${at} more 3`));
      expect((await cmd(c, 'page 2'))[0]).toBe((await cmd(c, 'more 2'))[0]);
      fits(await cmd(c, 'more 999')); // past the end: the last page
      // the build refused for its unknown blocks, then for its materials (no fetch), then for what cannot be got (fetch)
      fits(await cmd(c, `file ${s.name} ${at}`));
      const r = await cmd(c, `file ${s.name} ${at} skip unknown`);
      fits(r);
      expect(r[0]).toMatch(/^build: file .*: \d+ blocks, 125 kinds: /);
      expect(r.at(-1)).toMatch(/\(add fetch to get, craft and smelt them (first|as it goes); all: !build more\)$/);
      const f = await cmd(c, `file ${s.name} ${at} skip unknown fetch`);
      fits(f);
      expect(f[0]).toMatch(/^build: nothing fetched: cannot get \d+ blocks of \d+ kinds \(no recipe and !get does not know it\): \d+ smooth_quartz, .*\+\d+ more$/);
      expect(f[1]).toMatch(/\(all: !build more\)$/);
      const fp = await allPages(c, await cmd(c, 'more'));
      for (const c0 of new Set(s.blocks.map((x) => x.name).filter((n) => !REFUSED.includes(n) && /concrete|wool|carpet|terracotta|stained|azalea|moss|quartz/.test(n)))) expect(fp.join(' ')).toMatch(new RegExp(`\\d+ ${c0}[ ,]`));
      expect(fp.join(' ')).toContain('(no recipe and !get does not know it)');
      expect(t.dispatched).toEqual([]);
      // status, stop
      fits(await cmd(c, 'status'));
      fits(await cmd(c, 'stop'));
    });
  }

  it('a fetch that starts: its steps in two lines at most (the handed-over boxes line makes three); its stop fits', async () => {
    const counts = kinds125(4000, 0.01).filter(([k]) => !/quartz|azalea|moss|concrete|glazed|wool|stained|terracotta|carpet|sandstone/.test(k));
    const s = structure('hall', counts.slice(0, 40).map(([k, n]) => [k, Math.min(n, 4)] as [string, number]), [], []);
    const t = host(s);
    const c = new BuildController(t.h);
    const r = await cmd(c, `file hall ${at} fetch`);
    expect(r.length).toBeGreaterThan(1);
    const first = r.filter((l) => l.startsWith('build file hall') || !l.startsWith('build'));
    fits(r.slice(0, -1), 2);
    expect(r[0]).toMatch(/^build file hall at .*: fetching first: from my boxes: /);
    for (const l of r) expect(bytes(l)).toBeLessThanOrEqual(LINE_BYTES);
    expect(first.length).toBeGreaterThan(0);
  });

  it('!build files: many files in three lines, all of them by !build files more', async () => {
    const t = host(SMALL, { files: 40 });
    const c = new BuildController(t.h);
    const r = await cmd(c, 'files');
    fits(r);
    expect(r[0]).toMatch(/^build files: 40 files: castle_of_the_northern_mountains_0 \(litematic, 61x40x77, 40000 blocks, 120\.6 KB\)/);
    expect(r.at(-1)).toMatch(/, \+\d+ more \(all: !build more\)$/);
    const all = (await allPages(c, await cmd(c, 'files more'))).join(' ');
    for (let i = 0; i < 40; i++) expect(all).toContain(`castle_of_the_northern_mountains_${i} (`);
    expect((await cmd(c, 'files more 2')).at(-1)).toMatch(/\(page 2 of \d+: !build more 3\)$/);
    expect(await cmd(c, 'files')).toHaveLength(r.length);
  });

  it('the plan line and the end line of a build with many refusals; status with a long last line', async () => {
    const s: Structure = { name: 'hut', size: { x: 13, y: 1, z: 1 }, blocks: [...['oak_planks', 'oak_planks', 'oak_planks'], ...REFUSED].map((name, i) => ({ pos: { x: i, y: 0, z: 0 }, name })) };
    const t = host(s);
    const c = new BuildController(t.h);
    const r = await cmd(c, 'file hut 2 -60 5');
    fits(r);
    expect(r[0]).toMatch(/^building file hut at 2 -60 5: 3 to place, 10 refused \(water lava: no liquids; fire bedrock kelp \+\d+ more: not placeable by the builder; .*; \+\d+ more reasons\)/);
    await until(() => t.said.length > 0);
    fits(t.said);
    expect(t.said[0]).toMatch(/^build file hut at 2 -60 5: done, 3 \/ 3 placed/);
    // the end's lists in full
    const all = (await allPages(c, await cmd(c, 'more'))).join(' ');
    for (const b of REFUSED) expect(all).toContain(b);
    c.ends.push(`build file hut at 2 -60 5: done, 3 / 3 placed, 0 skipped in 1 s; skipped: ${Array.from({ length: 40 }, (_, i) => `${i} -60 5 (out of reach)`).join(', ')}`);
    const st = await cmd(c, 'status');
    fits(st);
    expect(st.at(-1)).toMatch(/\(\+\d+ more lines: !build more\)$/);
    const stAll = (await allPages(c, await cmd(c, 'more'))).join(' ');
    expect(stAll).toContain('39 -60 5 (out of reach)');
  });

  it('`more` with nothing kept; splitMore keeps a file named more', async () => {
    const c = new BuildController(host(SMALL).h);
    expect(await cmd(c, 'more')).toEqual(['build: nothing more to show (a reply that leaves something out says +N more; !build more then shows the rest)']);
    expect(splitMore(['file', 'more'])).toEqual({ args: ['file', 'more'] });
    expect(splitMore(['file', 'more', 'more'])).toEqual({ args: ['file', 'more'], page: 1 });
    expect(splitMore(['file', 'hut', 'more', '3'])).toEqual({ args: ['file', 'hut'], page: 3 });
    expect(splitMore(['page', '2'])).toEqual({ args: [], page: 2 });
    expect(splitMore(['wall', '1', '2', '3', '4', '5', '6', 'stone'])).toEqual({ args: ['wall', '1', '2', '3', '4', '5', '6', 'stone'] });
  });

  it('the full text goes to the log once, a line a line, and to the panel (GET /api/build)', async () => {
    const logged: string[] = [];
    const log = { ...silentLogger, info: (m: string) => logged.push(m) } as Logger;
    const t = host(LARGE, { log });
    const c = new BuildController(t.h);
    await cmd(c, `materials file mountain_house ${at}`);
    const full = logged.filter((l) => /^build: \[\d+\/\d+\] /.test(l));
    expect(logged.some((l) => /^build: materials for file mountain_house at 0 -60 4: the full text, \d+ lines \(!build more pages through it\)$/.test(l))).toBe(true);
    expect(full.length).toBe(c.texts()[0]!.lines.length);
    await cmd(c, 'more 2');
    await cmd(c, `materials file mountain_house ${at}`);
    expect(logged.filter((l) => /^build: \[\d+\/\d+\] /.test(l)).length).toBe(full.length); // the same text: not logged again
    // the panel's route
    const route = panelRoutes({ state: () => ({}) as never, run: () => ({ ok: true, replies: [] }), build: () => ({ texts: c.texts() }) });
    let body = '';
    let status = 0;
    const res = { writeHead: (s: number) => (status = s), end: (b?: string) => (body = b ?? '') } as never;
    expect(route('/api/build', { method: 'GET', url: '/api/build' } as never, res)).toBe(true);
    expect(status).toBe(200);
    const j = JSON.parse(body) as { texts: { topic: string; title: string; lines: string[] }[] };
    expect(j.texts[0]!.topic).toBe('materials');
    expect(j.texts[0]!.lines.join(' ')).toContain('smooth_quartz');
  });
});

describe('the reply helpers (Track B5)', () => {
  it('wrapLine splits at list separators, cuts a word longer than a line, keeps bytes (not characters)', () => {
    const l = wrapLine(Array.from({ length: 60 }, (_, i) => `item_${i} ${i}`).join(', '), 100);
    for (const x of l) expect(bytes(x)).toBeLessThanOrEqual(100);
    expect(l.join(' ')).toBe(Array.from({ length: 60 }, (_, i) => `item_${i} ${i}`).join(', '));
    expect(wrapLine('x'.repeat(300), 100).every((x) => bytes(x) <= 100)).toBe(true);
    expect(bytes(cutBytes('é'.repeat(200), 101))).toBeLessThanOrEqual(101);
    expect(fitEntries('head: ', ['a', 'b', 'c'], ' (tail)', 1, 20)).toEqual(['head: a, b, c (tail)']);
    expect(fitEntries('head: ', ['aaaa', 'bbbb', 'cccc'], ' (tail)', 1, 26)).toEqual(['head: aaaa, +2 more (tail)']);
    expect(fitEntries('head: ', ['aaaa', 'bbbb', 'cccc'], ' (tail)', 1, 26, '; ', 'steps')).toEqual(['head: +3 more steps (tail)']);
    expect(fitLines(['a', 'b', 'c', 'd', 'e']).lines).toEqual(['a', 'b', 'c... (+3 more lines: !build more)']);
    expect(pageLines(['a', 'b', 'c', 'd'], 1).lines).toEqual(['a', 'b', 'c (page 1 of 2: !build more 2)']);
    expect(pageLines(['a', 'b', 'c', 'd'], 2).lines).toEqual(['d (page 2 of 2)']);
  });
});

// Through the real sender: the 8 a 10 s limit, the queue of 16. A burst of the commands above (each answered within its
// budget) loses nothing, and never more than 8 messages go out in 10 s.
describe('the chat queue never drops a build reply (Track B5)', () => {
  const consoleSay = (msg: string): TextPacket => ({ needs_translation: false, category: 'authored', type: 'announcement', source_name: 'Server', message: `[Server] ${msg}`, xuid: '' });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('eight !build commands typed in one go with the 125-kind house: every line sent, none dropped', async () => {
    const { conn, clients } = setup({ username: 'Bot' });
    const warned: string[] = [];
    const chat = new Chat(conn, { owners: parseOwners(['Steve']), log: { ...silentLogger, warn: (m: string) => warned.push(m) } });
    const t = host(LARGE);
    const c = new BuildController(t.h);
    const replies: string[] = [];
    chat.register({
      name: 'build',
      help: '(test)',
      run: ({ line, args, reply }) => {
        void c.run(line, args, (m) => {
          replies.push(m);
          reply(m);
        });
      },
    });
    chat.start();
    const client = await connectAndSpawn(conn, clients);
    const wire: [number, string][] = [];
    const t0 = Date.now();
    const q = client.queue.bind(client);
    client.queue = (name: string, params: object) => {
      if (name === 'text') wire.push([Date.now() - t0, String((params as { message: unknown }).message)]);
      q(name, params);
    };
    const burst = [`materials file mountain_house ${at()}`, 'more 2', 'more 3', `file mountain_house ${at()}`, `file mountain_house ${at()} skip unknown`, `file mountain_house ${at()} skip unknown fetch`, 'files', 'status'];
    for (const b of burst) {
      client.receive('text', consoleSay(`!build ${b}`));
      await vi.advanceTimersByTimeAsync(150);
    }
    await vi.advanceTimersByTimeAsync(90_000);
    print(`queue: ${burst.length} commands, ${replies.length} replies, ${wire.length} messages on the wire, ${warned.filter((w) => /dropping|dropped/.test(w)).length} drops`);
    expect(replies.length).toBeGreaterThanOrEqual(burst.length);
    expect(replies.length).toBeLessThanOrEqual(burst.length * REPLY_LINES);
    expect(warned.filter((w) => /queue full|dropped/.test(w))).toEqual([]);
    expect(wire.map(([, m]) => m).some((m) => /lines? dropped/.test(m))).toBe(false);
    const sent = wire.map(([, m]) => m).join(' || ');
    for (const r of replies) expect(sent).toContain(r); // every reply on the wire (some joined with the line before)
    expect(wire.length).toBeLessThanOrEqual(replies.length);
    let most = 0;
    for (const [s] of wire) most = Math.max(most, wire.filter(([x]) => x >= s && x < s + 10_000).length);
    expect(most).toBeLessThanOrEqual(8);
    expect(chat.waitingCount).toBe(0);
  });

  function at(): string {
    return '0 -60 4';
  }
});
