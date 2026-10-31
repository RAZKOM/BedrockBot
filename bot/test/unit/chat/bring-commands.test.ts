// Wave 10 Track AS (docs/home.md "Bring"): `!bring` (chat/commands-bring.ts) on a fake host with the
// real ProcessManager and BringProcess (tasks/process/bring.ts): the replies, the target (the sender,
// another player, home, the console), carried items first, the shortfall, the box note, a pre-emption
// in each phase (the withdrawal runs again for what is left; the walk starts again), stop and status;
// the `!get` hint (getSuggestsBring) and the !bring registration on the real afk registry.
import { describe, expect, it } from 'vitest';
import { BringController, endLine, type BringHost } from '../../../src/chat/commands-bring.ts';
import type { Sender } from '../../../src/chat/chat.ts';
import { GetController } from '../../../src/chat/commands-get.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { COMMAND_SPECS, parsePlan, planLine, stepCommand } from '../../../src/nl/plan.ts';
import { EXAMPLES } from '../../../src/nl/prompt.ts';
import { resolveBringItem } from '../../../src/skills/home/bring.ts';
import type { WithdrawReport } from '../../../src/skills/home/logistics.ts';
import type { ChestRecord } from '../../../src/world/cache/chests.ts';
import { BringProcess, type BringJob, type BringRunner, type DeliverResult } from '../../../src/tasks/process/bring.ts';
import { BaseProcess, PRIORITY, ProcessManager } from '../../../src/tasks/process/manager.ts';

const rec = (x: number, contents: Record<string, number>, extra: Partial<ChestRecord> = {}): ChestRecord => ({ x, y: 0, z: 0, kind: 'chest', size: 27, free: 20, stacks: 3, contents, room: {}, boxes: { empty: 0, full: 0 }, double: false, readAt: 1, ...extra });
const steve: Sender = { kind: 'player', name: 'Steve', xuid: '' };
const flush = () => new Promise((r) => setTimeout(r, 0));

const report = (o: Partial<WithdrawReport> = {}): WithdrawReport => ({ ok: true, taken: {}, from: [], boxes: [], carried: 0, chests: 0, requests: 0, ms: 5, ...o });

/** A fake host: the memory, the inventory, a runner whose phases the test resolves by hand. */
function host(records: ChestRecord[], inv: { name: string; count: number }[] = []) {
  const processes = new ProcessManager();
  const settings = new RuntimeSettings();
  const calls: string[] = [];
  const pending: { withdraw: ((r: WithdrawReport) => void)[]; deliver: ((r: DeliverResult) => void)[] } = { withdraw: [], deliver: [] };
  const runner: BringRunner = {
    withdraw: (_c, job) => {
      calls.push(`withdraw ${job.want} ${job.item.names.join('/')}`);
      return new Promise((r) => pending.withdraw.push(r));
    },
    deliver: (_c, job) => {
      calls.push(`deliver ${'player' in job.to ? job.to.player : 'home'}`);
      return new Promise((r) => pending.deliver.push(r));
    },
    cancel: () => calls.push('cancel'),
    remaining: () => 12,
  };
  const h: BringHost = { processes, records: () => records, inventory: () => inv, home: () => ({ x: 0, y: 0, z: 0 }), runner, settings };
  const c = new BringController(h);
  const said: string[] = [];
  const say = (m: string) => said.push(m);
  return { c, processes, settings, calls, pending, said, say, run: (args: string, sender: Sender = steve) => c.run(sender, args.split(' '), say) };
}

describe('!bring', () => {
  it('64 torches from two chests to the sender: start line, withdraw, walk, end line', async () => {
    const t = host([rec(3, { torch: 40 }), rec(-8, { torch: 30 })]);
    t.run('torch 64');
    expect(t.said).toEqual(['bringing 64 torches to Steve (from 2 chests)']);
    expect(t.calls).toEqual(['withdraw 64 torch']);
    expect(t.c.status()).toBe('bring: bring 64 torch to Steve: taking from the chests (running)');
    t.pending.withdraw[0]!(report({ taken: { torch: 64 }, from: ['chest 3 0 0', 'chest -8 0 0'], carried: 64, chests: 2 }));
    await flush();
    expect(t.calls).toEqual(['withdraw 64 torch', 'deliver Steve']);
    expect(t.c.status()).toBe('bring: bring 64 torch to Steve: walking to Steve, 12 blocks left (running)');
    t.pending.deliver[0]!({ ok: true, at: 'player' });
    await flush();
    expect(t.said[1]).toBe('brought 64 torches (from 2 chests)');
    expect(t.processes.userProcesses()).toHaveLength(0);
    expect(t.c.status()).toBe('bring: idle (last: brought 64 torches (from 2 chests))');
  });

  it('to another player, home, the console; not online: home and says so', () => {
    const t = host([rec(3, { coal: 64 })]);
    t.run('coal 10 to Alex');
    expect(t.said.at(-1)).toBe('bringing 10 coal to Alex (from 1 chest)');
    t.run('coal home');
    expect(t.said.at(-1)).toBe('bringing 64 coal to home (from 1 chest)');
    t.run('coal 5', { kind: 'console' });
    expect(t.said.at(-1)).toBe('bringing 5 coal to home (from 1 chest) (the console has no position)');
    const job: BringJob = { item: resolveBringItem('coal', ['coal']), want: 5, to: { player: 'Alex' } };
    expect(endLine(job, { withdraw: report({ taken: { coal: 5 }, from: ['chest 3 0 0'], carried: 5 }), deliver: { ok: true, at: 'home', fallback: 'Alex is not online, so I took them home' } })).toBe('brought 5 coal home (from 1 chest); Alex is not online, so I took them home');
  });

  it('carried items count first; the shortfall is said at the start and the end', async () => {
    const t = host([rec(3, { iron_ingot: 8 })], [{ name: 'iron_ingot', count: 2 }]);
    t.run('iron 20');
    expect(t.said[0]).toBe('bringing 20 iron to Steve (2 carried, from 1 chest, only 10 known: 10 short)');
    expect(t.calls[0]).toBe('withdraw 20 iron_ingot/raw_iron');
    t.pending.withdraw[0]!(report({ taken: { iron_ingot: 8 }, from: ['chest 3 0 0'], carried: 10, chests: 1 }));
    await flush();
    t.pending.deliver[0]!({ ok: true, at: 'player' });
    await flush();
    expect(t.said[1]).toBe('brought 10 iron_ingots (from 1 chest; 10 short: the chests hold no more)');
  });

  it('Track BJ: a few out of a shulker box: taken out of it, the box goes back; said at the start and the end', async () => {
    const t = host([rec(3, { undyed_shulker_box: 1 }, { boxes: { empty: 0, full: 1 }, inBoxes: { diamond: 2 } })]);
    t.run('diamond 2');
    expect(t.said[0]).toBe('bringing 2 diamonds to Steve (from 1 chest, some taken out of a shulker box, which goes back)');
    t.pending.withdraw[0]!(report({ taken: { diamond: 2 }, extracted: [{ items: 2, from: 'chest 3 0 0', back: true }], from: ['chest 3 0 0'], carried: 2, chests: 2 }));
    await flush();
    expect(t.calls).toContain('deliver Steve');
    t.pending.deliver[0]!({ ok: true, at: 'player' });
    await flush();
    expect(t.said[1]).toBe('brought 2 diamonds (from 1 chest; 2 taken out of a shulker box from chest 3 0 0, the box went back)');
  });

  it('Track BJ: a big need: whole full boxes come along first, the rest loose', async () => {
    const box = { dirt: 1728 };
    const t = host([rec(3, { dirt: 300, undyed_shulker_box: 2 }, { boxes: { empty: 0, full: 2 }, inBoxes: { dirt: 3456 }, boxList: [box, box] })]);
    t.run('dirt 2000');
    expect(t.said[0]).toBe('bringing 2000 dirt to Steve (from 1 chest, a full shulker box comes along)');
    t.pending.withdraw[0]!(report({ taken: { undyed_shulker_box: 1, dirt: 272 }, boxes: [{ name: 'undyed_shulker_box', items: 1728, from: 'chest 3 0 0' }], from: ['chest 3 0 0'], carried: 272, chests: 1 }));
    await flush();
    t.pending.deliver[0]!({ ok: true, at: 'player' });
    await flush();
    expect(t.said[1]).toBe('brought 272 dirt and 1 shulker box holding 1728 dirt (from 1 chest; a full shulker box out of chest 3 0 0)');
    // the box stays with me: said
    const job: BringJob = { item: resolveBringItem('dirt', ['dirt']), want: 10, to: { player: 'Steve' } };
    expect(endLine(job, { withdraw: report({ taken: { dirt: 10 }, extracted: [{ items: 10, from: 'chest 3 0 0', back: false }], from: ['chest 3 0 0'], carried: 10 }), deliver: { ok: true, at: 'player' } })).toBe('brought 10 dirt (from 1 chest; 10 taken out of a shulker box from chest 3 0 0; the box stays with me)');
  });

  it('nothing known: no process; nothing found after all: the reply says so', async () => {
    const t = host([rec(3, { coal: 64 })]);
    t.run('torch 4');
    expect(t.said).toEqual(['bring: no torch in the 1 container I know (!stock torch; !get torch makes new ones)']);
    expect(t.processes.userProcesses()).toHaveLength(0);
    const none = host([]);
    none.run('torch');
    expect(none.said).toEqual(['bring: I know no chest near home yet (!chests scan)']);
    const stale = host([rec(3, { torch: 5 })]);
    stale.run('torch 5');
    stale.pending.withdraw[0]!(report({ carried: 0 }));
    await flush();
    expect(stale.calls).not.toContain('deliver Steve');
    expect(stale.said[1]).toMatch(/^bring: found no torch: the chests held less than remembered/);
    const bad = host([rec(3, { torch: 5 })]);
    bad.run('torch to');
    expect(bad.said).toEqual(['usage: !bring <item> [n] [to <player>|home] (to <player> or to home)']);
  });

  it('a pre-emption in each phase: the withdrawal runs again, then the walk starts again', async () => {
    const t = host([rec(3, { torch: 64 })]);
    t.run('torch 64');
    // a higher process (a guard fight) takes control during the withdrawal
    class Fight extends BaseProcess {
      readonly name = 'guard';
      readonly kind = 'auto' as const;
      on = true;
      get priority() {
        return PRIORITY.guard;
      }
      override wants() {
        return this.on;
      }
      protected run() {}
      protected halt() {}
      status() {
        return { line: 'fight' };
      }
    }
    const f = t.processes.add(new Fight());
    expect(t.calls).toEqual(['withdraw 64 torch', 'cancel']);
    t.pending.withdraw[0]!(report({ ok: false, reason: 'interrupted', taken: { torch: 30 }, from: ['chest 3 0 0'], carried: 30, chests: 1 }));
    await flush();
    expect(t.calls).toHaveLength(2); // stale run: no delivery
    f.on = false;
    t.processes.tick();
    expect(t.calls.at(-1)).toBe('withdraw 64 torch'); // again: the logistics takes only what is still missing
    t.pending.withdraw[1]!(report({ taken: { torch: 34 }, from: ['chest 3 0 0'], carried: 64, chests: 1 }));
    await flush();
    expect(t.calls.at(-1)).toBe('deliver Steve');
    f.on = true;
    t.processes.tick();
    expect(t.calls.at(-1)).toBe('cancel');
    f.on = false;
    t.processes.tick();
    expect(t.calls.at(-1)).toBe('deliver Steve'); // the walk starts again from where it stands
    t.pending.deliver[1]!({ ok: true, at: 'player' });
    await flush();
    expect(t.said.at(-1)).toBe('brought 64 torches (from 1 chest)');
    const p = t.c.last!.result!;
    expect(p.withdraw.taken).toEqual({ torch: 64 });
    expect(p.withdraw.chests).toBe(2);
  });

  it('!bring stop and status', () => {
    const t = host([rec(3, { torch: 64 })]);
    expect(t.c.stop()).toBe('bring: nothing to stop');
    t.run('torch 10');
    expect(t.c.stop()).toBe('stopped bring 10 torch to Steve: taking from the chests (running)');
    expect(t.processes.userProcesses()).toHaveLength(0);
    t.run('stop');
    expect(t.said.at(-1)).toBe('bring: nothing to stop');
    t.run('status');
    expect(t.said.at(-1)).toMatch(/^bring: idle/);
  });

  it('a failed walk: carrying, could not get there', () => {
    const job: BringJob = { item: resolveBringItem('torch', ['torch']), want: 64, to: { player: 'Steve' } };
    expect(endLine(job, { withdraw: report({ taken: { torch: 64 }, from: ['chest 3 0 0'], carried: 64 }), deliver: { ok: false, reason: 'not_found', at: 'player' } })).toBe('bring: carrying 64 torches but could not get to Steve: not_found');
    expect(endLine(job, undefined)).toBe('bring: stopped');
  });
});

describe('the !get hint (getSuggestsBring)', () => {
  const line: ChatLine = { type: 'chat', source: 'Steve', message: '!get coal 4', body: '!get coal 4', xuid: '' } as ChatLine;

  it('the chests hold enough: the hint, and !get still makes new ones', () => {
    const t = host([rec(3, { coal: 64 }), rec(5, { undyed_shulker_box: 1 }, { inBoxes: { raw_iron: 100 } })]);
    const dispatched: string[] = [];
    const g = new GetController({ dispatch: (_l, cmd) => dispatched.push(cmd), processes: { userProcesses: () => [], stop: () => true, find: () => [] } });
    g.stockHint = (f, typed) => t.c.hint(f, typed);
    const said: string[] = [];
    g.run(line, ['coal', '4'], (m) => said.push(m));
    expect(said).toEqual(['getting 4 coal: the chests hold 64 (!bring coal 4 fetches it); mining coal_ore anyway']);
    expect(dispatched).toEqual(['mine coal_ore 4']);
    g.run(line, ['coal', '100'], (m) => said.push(m));
    expect(said.at(-1)).toBe('getting 100 coal: mining coal_ore');
    g.run(line, ['iron', '16'], (m) => said.push(m));
    expect(said.at(-1)).toBe('getting 16 iron: the chests hold 100 (!bring iron 16 fetches it); mining iron_ore anyway'); // box contents count
    t.settings.set('getSuggestsBring', false);
    g.run(line, ['coal', '4'], (m) => said.push(m));
    expect(said.at(-1)).toBe('getting 4 coal: mining coal_ore');
  });
});

describe('BringProcess', () => {
  it('is a user process named bring; stopped: resolves undefined', async () => {
    const runner: BringRunner = { withdraw: () => new Promise(() => undefined), deliver: () => new Promise(() => undefined), cancel: () => undefined };
    const m = new ProcessManager();
    const p = m.add(new BringProcess(runner, { item: resolveBringItem('torch', ['torch']), want: 1, to: { home: true } }));
    expect(p.kind).toBe('user');
    expect(p.priority).toBe(PRIORITY.user);
    expect(p.behaviour()).toBe('taking torch out of the chests');
    m.stop(p);
    expect(await p.result).toBeUndefined();
  });
});

describe('NL: the bring step', () => {
  it('chat text, plan line, the example; get stays get', () => {
    const r = parsePlan(JSON.stringify({ steps: [{ command: 'bring', item: 'torch', count: 64 }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(planLine(r.plan)).toBe('plan: bring torch 64');
    expect(stepCommand({ command: 'bring', item: 'diamond', to: 'Alex' })).toBe('bring diamond to Alex');
    expect(stepCommand({ command: 'bring', item: 'coal', to: 'home' })).toBe('bring coal home');
    expect(COMMAND_SPECS.bring.done!.test('brought 64 torches (from 2 chests)')).toBe(true);
    expect(COMMAND_SPECS.bring.fail!.test('bring: no torch in the 5 containers I know')).toBe(true);
    expect(COMMAND_SPECS.bring.fail!.test('bringing 64 torches to Steve (from 2 chests)')).toBe(false);
    expect(EXAMPLES.find((e) => e.request === 'bring me 64 torches')?.plan.steps).toEqual([{ command: 'bring', item: 'torch', count: 64 }]);
    expect(EXAMPLES.find((e) => e.request.startsWith('get me'))?.plan.steps[0]?.command).toBe('get');
  });
});
