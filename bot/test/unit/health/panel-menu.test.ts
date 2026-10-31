// Track AR (docs/panel.md "Interaction", decision 0039): the panel's menu model (menu.ts, the same
// JavaScript the page runs), the map markers (GET /api/marks, marks.ts), the settings / mode markup,
// and the two new chat commands (!select, !offhand) against fakes.
import { describe, expect, it } from 'vitest';
import type { Chat, CommandDef } from '../../../src/chat/chat.ts';
import { findSlot, freeSlot, parseHotbarSlot, registerPanelCommands, type PanelCommandDeps, type PanelKit } from '../../../src/chat/commands-panel.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { liftTaskStatus, mapRoutes } from '../../../src/health/map/routes.ts';
import { mapMarks } from '../../../src/health/panel/marks.ts';
import { cellActions, logVisible, mapActions, modeChanges, modeOf, paletteMatch, parseLog, setCommand, settingActions, settingVisible, stackActions, wpName, type MenuAction } from '../../../src/health/panel/menu.ts';
import { enumValues, modesData, renderPanelPage } from '../../../src/health/panel/page.ts';
import { settingGroups } from '../../../src/chat/help.ts';
import type { ItemStack } from '../../../src/world/types.ts';
import { fullState, stack } from './panel-fixtures.ts';

const ids = (a: MenuAction[]): string[] => a.map((x) => x.id);
const cmd = (a: MenuAction[], id: string): string | undefined => a.find((x) => x.id === id)?.cmd;

describe('menu model: inventory cells', () => {
  const s = fullState();
  const inv = s.inventory!;

  it('a tool in a hotbar slot that is not held: select, drop (confirmed), unload', () => {
    const a = cellActions('s0', inv.slots[0]!, inv);
    expect(ids(a)).toEqual(['select', 'dropstack', 'unload']);
    expect(cmd(a, 'select')).toBe('!select 0');
    expect(a.find((x) => x.id === 'dropstack')).toMatchObject({ label: 'Drop', cmd: '!drop slot 0', confirm: true });
    expect(cmd(a, 'unload')).toBe('!unload');
  });

  it('the held slot offers no select', () => {
    expect(ids(cellActions('s2', inv.slots[2]!, inv))).not.toContain('select');
  });

  it('a stack: drop 1 (no confirm), the stack and all of that item (both confirmed)', () => {
    const a = cellActions('s9', inv.slots[9]!, inv);
    expect(ids(a)).toEqual(['drop1', 'dropstack', 'dropall', 'unload']);
    expect(a.find((x) => x.id === 'drop1')).toEqual({ id: 'drop1', label: 'Drop 1', cmd: '!drop cobblestone 1' });
    expect(a.find((x) => x.id === 'dropstack')).toMatchObject({ label: 'Drop the stack (64)', cmd: '!drop slot 9', confirm: true });
    expect(a.find((x) => x.id === 'dropall')).toMatchObject({ label: 'Drop all 1280 cobblestone', cmd: '!drop cobblestone', confirm: true });
  });

  it('food eats, armour equips, a shield or totem goes to the offhand, a box shows its contents', () => {
    expect(ids(cellActions('s4', inv.slots[4]!, inv))).toEqual(['select', 'eat', 'drop1', 'dropstack', 'unload']);
    const helmet = { name: 'iron_helmet', count: 1, icon: 'helmet', colour: '#c9ccd1', abbr: 'IHe' } as const;
    expect(cmd(cellActions('s20', helmet, inv), 'equip')).toBe('!equip');
    const shield = { name: 'shield', count: 1, icon: 'shield', colour: '#a9824f', abbr: 'Sh' } as const;
    expect(cmd(cellActions('s20', shield, inv), 'offhand')).toBe('!offhand shield');
    const totem = { name: 'totem_of_undying', count: 1, icon: 'item', colour: '#fff000', abbr: 'TOU' } as const;
    expect(cmd(cellActions('s20', totem, inv), 'offhand')).toBe('!offhand totem_of_undying');
    const box = cellActions('s31', inv.slots[31]!, inv);
    expect(box.find((x) => x.id === 'box')).toEqual({ id: 'box', label: 'Show contents' }); // local: no command
    expect(ids(box)).not.toContain('eat');
  });

  it('empty cells, the offhand and worn armour', () => {
    expect(cellActions('s5', null, inv)).toEqual([{ id: 'select', label: 'Select (hold slot 6)', cmd: '!select 5' }]);
    expect(cellActions('s2', null, inv)).toEqual([]); // already held
    expect(cellActions('s20', null, inv)).toEqual([]);
    expect(cellActions('off', inv.offhand, inv)).toEqual([{ id: 'offclear', label: 'Back into the inventory', cmd: '!offhand clear' }]);
    expect(cellActions('off', null, inv)).toEqual([]);
    expect(cellActions('a0', inv.armour[0]!, inv)).toEqual([]); // no command takes one piece off
    expect(cellActions('s0', inv.slots[0]!, null).map((x) => x.id)).toEqual(['select', 'dropstack', 'unload']);
  });
});

describe('menu model: map, settings, processes, palette, log', () => {
  it('map: walk / home / shelter / waypoint on the surface (feet = surface + 1)', () => {
    const a = mapActions(10.7, -3.2, 63, -60);
    expect(a.map((x) => [x.id, x.cmd, !!x.confirm])).toEqual([
      ['walk', '!goto 10 64 -4', false],
      ['home', '!home set 10 64 -4', true],
      ['shelter', '!shelter set 10 64 -4', true],
      ['wp', '!wp set {name} 10 64 -4', false],
    ]);
    expect(a[3]!.prompt).toMatch(/waypoint name/);
    expect(mapActions(0, 0, null, -60.4)[0]).toEqual({ id: 'walk', label: 'Walk here (height unknown)', cmd: '!goto 0 -61 0' });
    expect(mapActions(0, 0, -32768, 70)[0]!.cmd).toBe('!goto 0 70 0');
    expect(mapActions(0, 0, null, null)).toEqual([]);
    expect([wpName(' Base_1 '), wpName(''), wpName('a b'), wpName('x'.repeat(33))]).toEqual(['base_1', null, null, null]);
  });

  it('settings: reset only when changed, the set command per kind, the filters', () => {
    expect(settingActions('guardRadius', '16', '16')).toEqual([]);
    expect(settingActions('guardRadius', '20', '16')).toEqual([{ id: 'reset', label: 'Reset to 16', cmd: '!set guardRadius default' }]);
    expect([setCommand('sprint', 'boolean', true), setCommand('sprint', 'boolean', false), setCommand('guardRadius', 'number', ' 20 '), setCommand('stashChest', 'text', '1 2 3')]).toEqual(['!set sprint on', '!set sprint off', '!set guardRadius 20', '!set stashChest 1 2 3']);
    const row = { key: 'guardRadius', def: '16', description: 'fight hostiles within this radius', group: 'safety' };
    expect(settingVisible(row, '16', false, '')).toBe(true);
    expect(settingVisible(row, '16', true, '')).toBe(false);
    expect(settingVisible(row, '20', true, '')).toBe(true);
    expect(settingVisible(row, '16', false, 'HOSTILE')).toBe(true);
    expect(settingVisible(row, '16', false, 'safety')).toBe(true);
    expect(settingVisible(row, '16', false, 'sprint')).toBe(false);
  });

  it('modes: which one matches, what another would change', () => {
    const modes = modesData();
    expect(modes.map((m) => m.name)).toEqual(['careful', 'normal', 'bold']);
    const s = new RuntimeSettings();
    const values = Object.fromEntries(modes[1]!.values ? Object.keys(modes[1]!.values).map((k) => [k, modes[1]!.values[k]!]) : []);
    expect(modeOf(modes, values)).toBe('normal');
    expect(modeOf(modes, { ...values, fleeHealth: '9' })).toBe('custom');
    expect(modeChanges(modes, 'careful', values)).toEqual(expect.arrayContaining([{ key: 'fleeHealth', from: String(s.get('fleeHealth')), to: '12' }, { key: 'guardRadius', from: '16', to: '8' }]));
    expect(modeChanges(modes, 'normal', values)).toEqual([]);
  });

  it('processes: Stop on user processes only', () => {
    expect(stackActions({ kind: 'user' })).toEqual([{ id: 'stop', label: 'Stop', cmd: '!stop' }]);
    expect(stackActions({ kind: 'auto' })).toEqual([]);
  });

  it('palette: prefix matches first, then name and help, grouped by tier', () => {
    const cmds = [
      { name: 'goto', tier: 'more', group: 'go', help: 'walk to a waypoint' },
      { name: 'get', tier: 'front', group: 'work', help: 'get items' },
      { name: 'home', tier: 'front', group: 'home', help: 'home point; go walks there' },
      { name: 'wp', tier: 'more', group: 'go', help: 'waypoints' },
    ];
    expect(paletteMatch(cmds, '!ge').map((g) => [g.tier, g.items.map((c) => c.name)])).toEqual([['front', ['get']]]);
    expect(paletteMatch(cmds, 'go').map((g) => [g.tier, g.items.map((c) => c.name)])).toEqual([['front', ['home']], ['more', ['goto', 'wp']]]); // goto by name, home and wp by help / group
    expect(paletteMatch(cmds, 'walk').flatMap((g) => g.items.map((c) => c.name))).toEqual(['home', 'goto']);
    expect(paletteMatch(cmds, 'wp set base').flatMap((g) => g.items.map((c) => c.name))).toEqual(['wp']);
    expect(paletteMatch(cmds, '', 2).flatMap((g) => g.items.map((c) => c.name))).toEqual(['get', 'home']);
    expect(paletteMatch(cmds, 'zzz')).toEqual([]);
  });

  it('log: level and module from the logger format; the filter', () => {
    const info = '2026-10-29T18:52:53.123Z INFO  [health] panel: !wp set panel (as console)';
    const warn = '2026-10-29T18:52:54.000Z WARN  [survival] keeper: drop refused';
    expect(parseLog(info)).toEqual({ level: 'INFO', module: 'health' });
    expect(parseLog('garbage')).toEqual({ level: '', module: '' });
    expect([logVisible(info, '', '', ''), logVisible(info, 'WARN', '', ''), logVisible(warn, 'WARN', '', ''), logVisible(warn, '', 'health', ''), logVisible(info, '', 'health', 'WP SET')]).toEqual([true, false, true, false, true]);
  });
});

describe('GET /api/marks: chests and herds near the bot', () => {
  it('nearest first, double-chest halves once, the radius, herd totals', () => {
    const chest = (x: number, z: number, extra: Record<string, unknown> = {}) => ({ x, y: -60, z, kind: 'chest', contents: {}, stacks: 0, size: 0, readAt: 0, ...extra });
    const src = {
      chests: { all: () => [chest(10, 0, { label: 'ores', partner: { x: 11, y: -60, z: 0 } }), chest(11, 0), chest(2, 0), chest(500, 0), chest(3, 0, { unreachable: 'no path' })] as never[] },
      herds: { near: () => [{ cx: 0, cz: 0, x: 5.5, y: -60, z: 5.5, wild: { cow: { adults: 3, babies: 1 } }, penned: { sheep: { adults: 1, babies: 0 } }, at: 0 }] as never[] },
    };
    const m = mapMarks(src, { x: 0, y: -60, z: 0 });
    expect(m.chests.map((c) => [c.x, c.label, c.unreachable])).toEqual([[2, null, false], [3, null, true], [10, 'ores', false]]);
    expect(m.chests.some((c) => c.x === 500)).toBe(false);
    expect(m.herds).toEqual([{ x: 5.5, y: -60, z: 5.5, n: 5, kind: 'cow', penned: true }]);
    expect(mapMarks(undefined, { x: 0, y: 0, z: 0 })).toEqual({ chests: [], herds: [] });
    expect(mapMarks(src, undefined)).toEqual({ chests: [], herds: [] });
  });
});

describe('page: the settings by group, the mode selector, the menu and map markup', () => {
  const s = fullState();
  const html = renderPanelPage(s);

  it('groups in !help settings order, a switch per boolean, a select for word choices, Reset only when changed', () => {
    const groups = [...html.matchAll(/data-grp="([^"]+)"/g)].map((m) => m[1]);
    expect(groups).toEqual(settingGroups().map(([g]) => g));
    expect(html).toMatch(/<tr data-row="sprint" data-def="on" data-kind="boolean" data-group="walking"><td>.*?<label class="sw"><input type="checkbox" data-key="sprint" checked/);
    expect(html).toContain('<select data-key="guardWhileWalking"><option>reach</option><option selected>near</option><option>all</option></select>');
    expect(enumValues('x y z|none')).toBeUndefined();
    expect(enumValues('version|none')).toBeUndefined();
    expect(html).toMatch(/data-row="guardRadius"[^>]*>.*?type="number"[^>]*min="2" max="64"/);
    expect(html).toMatch(/<button class="reset small" data-reset="guardRadius" hidden>/);
    const changed = new RuntimeSettings();
    changed.set('guardRadius', 20);
    const html2 = renderPanelPage(fullState({ settings: changed }));
    expect(html2).toMatch(/<tr data-row="guardRadius"[^>]*class="changed">/);
    expect(html2).toMatch(/<button class="reset small" data-reset="guardRadius">/);
    expect(html).toContain('data-mode="careful"');
    expect(JSON.parse(/<script type="application\/json" id="modes-data">([^<]*)<\/script>/.exec(html)![1]!)).toEqual(modesData());
  });

  it('menu, toast, palette, log filters, Pause / Resume, the map canvas and legend; under 160 KB', () => {
    for (const m of ['id="menu"', 'id="toast"', 'id="palette"', 'id="quick-edit"', 'id="log-level"', 'id="log-mod"', 'id="btn-pause"', 'id="btn-resume"', 'id="mapcv"', 'id="map-follow"', 'class="legend', 'id="set-changed"', 'id="set-q"']) expect(html).toContain(m);
    expect(html).not.toContain('<iframe');
    expect(Buffer.byteLength(html)).toBeLessThan(160_000);
  });
});

// ---- !select and !offhand against fakes -------------------------------------------------------------

function fakeWorld(slots: (ItemStack | null)[], off: ItemStack | null = null) {
  const s = [...slots];
  while (s.length < 36) s.push(null);
  const offhand: (ItemStack | null)[] = [off];
  return {
    inventory: {
      slots: s,
      selected: 0,
      window: (id: number) => (id === 119 ? { slots: offhand } : undefined),
      setItem: (w: number, i: number, it: ItemStack | null) => {
        if (w === 0) s[i] = it;
        else if (w === 119) offhand[i] = it;
      },
    },
  };
}

function harness(world: ReturnType<typeof fakeWorld> | undefined, status: unknown = 'ok') {
  const defs = new Map<string, CommandDef>();
  const chat = { register: (d: CommandDef) => defs.set(d.name, d) } as unknown as Chat;
  const sent: Record<string, unknown>[][] = [];
  const selected: number[] = [];
  const noted: number[] = [];
  let screens = 0;
  const kit: PanelKit = {
    busy: false,
    requests: {
      withScreen: async (fn) => {
        screens++;
        return fn();
      },
      send: (actions) => {
        sent.push(actions);
        return Promise.resolve({ status });
      },
    },
  };
  const deps: PanelCommandDeps = {
    chat,
    task: {},
    world,
    pve: world ? { hotbar: { select: (n) => (selected.push(n), true), noteRaw: (n) => void noted.push(n) } } : undefined,
    needsWalking: (c) => `${c} needs a task that can walk`,
  };
  registerPanelCommands(deps, () => (world ? kit : undefined));
  const run = async (name: string, ...args: string[]): Promise<string[]> => {
    const out: string[] = [];
    defs.get(name)!.run({ args, reply: (m: string) => out.push(m) } as never);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    return out;
  };
  return { defs, run, sent, selected, noted, screens: () => screens };
}

describe('!select and !offhand (Track AR, tier more, group control)', () => {
  it('registered as more / control with an example', () => {
    const h = harness(fakeWorld([]));
    for (const n of ['select', 'offhand']) expect(h.defs.get(n)).toMatchObject({ tier: 'more', group: 'control', example: expect.stringMatching(new RegExp(`^!${n} `)) as string });
  });

  it('!select: hotbar 0..8 through the hotbar, usage otherwise, needs walking', async () => {
    const h = harness(fakeWorld([null, null, stack('iron_sword')]));
    expect(await h.run('select', '2')).toEqual(['selected hotbar slot 2: iron_sword x1']);
    expect(h.selected).toEqual([2]);
    expect(await h.run('select', '9')).toEqual(['usage: !select <slot 0..8>']);
    expect(await h.run('select')).toEqual(['usage: !select <slot 0..8>']);
    expect(await harness(undefined).run('select', '1')).toEqual(['select needs a task that can walk']);
    expect([parseHotbarSlot('0'), parseHotbarSlot('8'), parseHotbarSlot('-1'), parseHotbarSlot('1.5')]).toEqual([0, 8, undefined, undefined]);
  });

  it('!offhand <item>: one place request from the slot to offhand slot 1 with the screen open; the model follows', async () => {
    const w = fakeWorld([null, null, null, null, stack('shield', 1, { stackId: 77 })]);
    const h = harness(w);
    expect(await h.run('offhand', 'shield')).toEqual(['offhand: shield']);
    expect(h.screens()).toBe(1);
    expect(h.sent).toEqual([[{ type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: 'hotbar' }, slot: 4, stack_id: 77 }, destination: { slot_type: { container_id: 'offhand' }, slot: 1, stack_id: 0 } }]]);
    expect(w.inventory.window(119)!.slots[0]?.name).toBe('shield');
    expect(w.inventory.slots[4]).toBeNull();
    expect(h.noted).toEqual([4]);
    expect(await h.run('offhand', 'shield')).toEqual(['offhand: already holds shield']);
    expect(await h.run('offhand', 'totem_of_undying')).toEqual(['offhand: no totem_of_undying in the inventory']);
    expect(await h.run('offhand')).toEqual(['offhand: shield x1 (!offhand <item> | clear)']);
  });

  it('!offhand clear: back into the first free main slot (predicted first); a swap empties the offhand first', async () => {
    const w = fakeWorld([stack('dirt', 64)], stack('shield', 1, { stackId: 5 }));
    const h = harness(w);
    expect(await h.run('offhand', 'clear')).toEqual(['offhand: shield moved back into the inventory']);
    expect(h.sent[0]).toEqual([{ type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: 'offhand' }, slot: 1, stack_id: 5 }, destination: { slot_type: { container_id: 'inventory' }, slot: 9, stack_id: 0 } }]);
    expect(w.inventory.slots[9]?.name).toBe('shield');
    expect(w.inventory.window(119)!.slots[0]).toBeNull();
    expect(await h.run('offhand', 'clear')).toEqual(['offhand: already empty']);
    // a totem while the shield is held: the shield goes back first, then the totem in
    const w2 = fakeWorld([stack('totem_of_undying', 1, { stackId: 9 })], stack('shield', 1, { stackId: 5 }));
    const h2 = harness(w2);
    expect(await h2.run('offhand', 'totem_of_undying')).toEqual(['offhand: totem_of_undying']);
    expect(h2.sent.map((a) => [a[0]!.source, a[0]!.destination])).toEqual([
      [{ slot_type: { container_id: 'offhand' }, slot: 1, stack_id: 5 }, { slot_type: { container_id: 'inventory' }, slot: 9, stack_id: 0 }],
      [{ slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 9 }, { slot_type: { container_id: 'offhand' }, slot: 1, stack_id: 0 }],
    ]);
    expect(w2.inventory.window(119)!.slots[0]?.name).toBe('totem_of_undying');
    expect(w2.inventory.slots[9]?.name).toBe('shield');
  });

  it('a refused request leaves the model as it was', async () => {
    const w = fakeWorld([stack('dirt', 64)], stack('shield', 1));
    const h = harness(w, 50);
    expect(await h.run('offhand', 'clear')).toEqual(['offhand clear: refused (50)']);
    expect(w.inventory.slots[9]).toBeNull();
    expect(w.inventory.window(119)!.slots[0]?.name).toBe('shield');
    expect([findSlot(w.inventory.slots, 'minecraft:dirt'), findSlot(w.inventory.slots, 'stone'), freeSlot(w.inventory.slots)]).toEqual([0, undefined, 9]);
  });
});

describe('map routes: the task status lifted for the map (Track AR)', () => {
  it('nav.waypoints and night.shelter become waypoints / shelter; the map JSON carries them', () => {
    const status = { home: { x: 1, y: -60, z: 2 }, nav: { waypoints: [{ name: 'base', x: 5, y: -60, z: 6, auto: false, at: 't' }, { name: 'far', x: 9, y: null, z: 9, auto: false, at: 't' }] }, night: { shelter: { x: 3, y: -60, z: 4 } } };
    expect(liftTaskStatus(status)).toMatchObject({ waypoints: [{ name: 'base', x: 5, y: -60, z: 6 }, { name: 'far', x: 9, y: 0, z: 9 }], shelter: { x: 3, y: -60, z: 4 } });
    expect(liftTaskStatus({ waypoints: [], nav: { waypoints: [{ name: 'x', x: 1, y: 1, z: 1 }] } })).toMatchObject({ waypoints: [] });
    expect(liftTaskStatus(undefined)).toBeUndefined();
    const m = mapRoutes({ taskStatus: () => status }).builder.build();
    expect(m.waypoints.map((w) => w.name)).toEqual(['base', 'far']);
    expect(m.shelter).toEqual({ x: 3, y: -60, z: 4 });
    expect(m.home).toEqual({ x: 1, y: -60, z: 2 });
  });
});
