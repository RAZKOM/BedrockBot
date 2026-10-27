// Track AL (docs/build.md "Commands"): `!build` on fakes: parsing, materials replies, refusing and
// fetching missing blocks, the build as a user process (status, stop, done line), the NL step text.
import { describe, expect, it } from 'vitest';
import { BuildController, type BuildHost } from '../../src/chat/commands-build.ts';
import type { ChatLine } from '../../src/chat/text.ts';
import { silentLogger } from '../../src/log.ts';
import { BuildRunner } from '../../src/skills/build/runner.ts';
import { buildStepText, lineColumns, parseSpec } from '../../src/skills/build/spec.ts';
import { ProcessManager } from '../../src/tasks/process/manager.ts';
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
    expect(await cmd(c, `materials wall 0 ${F} 5 9 5 4 cobblestone`)).toEqual(['materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)']);
    expect(await cmd(c, 'materials')).toEqual(['materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)']);
  });

  it('refuses a build without the blocks, and says how to fetch them', async () => {
    const { h, pm } = host({ cobblestone: 10 });
    const c = new BuildController(h);
    const r = await cmd(c, `fill 2 ${F} 2 6 ${F + 2} 6 cobblestone`);
    expect(r).toEqual(['build: fill 5x3x5 cobblestone: 75 cobblestone; need 75 more cobblestone (throwaway reserve 6 short, never built with) (add fetch to get them with !get first)']);
    expect(pm.userProcesses()).toHaveLength(0);
  });

  it('fetch runs !get for the missing blocks first', async () => {
    const { h, dispatched } = host({ dirt: 16 });
    const c = new BuildController(h);
    const r = await cmd(c, `wall 0 ${F} 5 9 5 4 cobblestone fetch`);
    expect(dispatched).toEqual(['get cobblestone 40']);
    expect(r[0]).toBe('build wall 10x4 cobblestone: fetching 40 cobblestone with !get first');
    expect(r[1]).toMatch(/^build: still short after fetching: /);
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
