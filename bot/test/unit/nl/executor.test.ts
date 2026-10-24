// PLAN.md 7.18 (Track Y): confirmation, step-by-step execution, dropping, failures, addressed chat.
import { describe, expect, it } from 'vitest';
import { addressedText, checkPlan, numbersIn } from '../../../src/nl/executor.ts';
import { consoleLine, FakeChat, makeFrontEnd, standardCommands, until } from './helpers.ts';

const steps = (...s: Record<string, unknown>[]) => ({ steps: s });
const origin = { line: consoleLine('!do x'), sender: 'console' };

describe('nl executor', () => {
  it('waits for the previous step to finish (no user process left) before the next', async () => {
    const procs: unknown[] = [];
    const chat = new FakeChat();
    standardCommands(chat);
    chat.commands.set('gather', (a, r) => {
      procs.push('gather');
      r(`gathering ${a[0]} logs`);
    });
    const { fe } = makeFrontEnd([[/wood/, steps({ command: 'gather', count: 4 }, { command: 'goto', waypoint: 'home' })]], { chat, procs });
    await fe.request('get 4 wood and go home', origin);
    fe.yes('console');
    await until(() => chat.handled.length === 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(chat.handled).toEqual(['!gather 4']);
    expect(fe.busy).toBe(true);
    procs.length = 0;
    await until(() => !fe.busy);
    expect(chat.handled).toEqual(['!gather 4', '!goto home']);
    expect(chat.said.at(-1)).toBe('plan done (2 steps)');
  });

  it('!no drops a waiting plan; !yes then has nothing to run', async () => {
    const { chat, fe } = makeFrontEnd([[/home/, steps({ command: 'goto', waypoint: 'home' })]]);
    standardCommands(chat);
    await fe.request('walk home', origin);
    expect(fe.waiting).toBeDefined();
    fe.no();
    expect(chat.said.at(-1)).toBe('plan dropped');
    fe.yes('console');
    expect(chat.said.at(-1)).toBe('no plan waiting (!do <what to do>)');
    expect(chat.handled).toEqual([]);
  });

  it('a plan waits for !yes only so long', async () => {
    const { chat, fe } = makeFrontEnd([[/home/, steps({ command: 'goto', waypoint: 'home' })]], { confirmMs: 30 });
    standardCommands(chat);
    await fe.request('walk home', origin);
    await until(() => fe.waiting === undefined);
    expect(chat.said.at(-1)).toBe('plan dropped (no !yes within 0 s)');
  });

  it('only the owner who asked can say !yes', async () => {
    const { chat, fe } = makeFrontEnd([[/home/, steps({ command: 'goto', waypoint: 'home' })]]);
    standardCommands(chat);
    await fe.request('walk home', origin);
    fe.yes('Alex');
    expect(chat.said.at(-1)).toBe("the waiting plan is console's");
    expect(fe.waiting).toBeDefined();
  });

  it('runs at once with nlConfirm off', async () => {
    const { chat, fe } = makeFrontEnd([[/home/, steps({ command: 'goto', waypoint: 'home' })]], { confirm: () => false });
    standardCommands(chat);
    await fe.request('walk home', origin);
    await until(() => !fe.busy && chat.handled.length === 1);
    expect(chat.said).toEqual(['plan: goto home', 'arrived at home']);
  });

  it('a failing step ends the plan', async () => {
    const { chat, fe } = makeFrontEnd([[/home/, steps({ command: 'goto', waypoint: 'home' }, { command: 'guard', mode: 'on' })]]);
    standardCommands(chat);
    chat.commands.set('goto', (_a, r) => r('goto: unreachable'));
    await fe.request('walk home and guard', origin);
    fe.yes('console');
    await until(() => !fe.busy);
    expect(chat.handled).toEqual(['!goto home']);
    expect(chat.said.at(-1)).toBe('plan stopped at step 1/2 (goto home): goto: unreachable');
  });

  it('a command the chat does not have: not available', async () => {
    const { chat, fe } = makeFrontEnd([[/sleep/, steps({ command: 'sleep' })]]);
    standardCommands(chat);
    chat.commands.delete('sleep');
    const r = await fe.request('go to sleep', origin);
    expect(r).toEqual({ kind: 'unavailable', command: 'sleep' });
    expect(chat.said).toEqual(['not available: sleep']);
    // and at run time, when it went away after the plan was shown
    chat.commands.set('sleep', () => undefined);
    await fe.request('go to sleep', origin);
    chat.commands.delete('sleep');
    fe.yes('console');
    await until(() => !fe.busy);
    expect(chat.said.at(-1)).toBe('not available: sleep');
  });

  it('!no or an owner !stop drops the rest of a running plan', async () => {
    const procs: unknown[] = [];
    const chat = new FakeChat();
    standardCommands(chat);
    chat.commands.set('goto', (a, r) => {
      procs.push('goto');
      r(`walking to ${a[0]}`);
    });
    const { fe } = makeFrontEnd([[/x/, steps({ command: 'goto', waypoint: 'home' }, { command: 'guard', mode: 'on' })]], { chat, procs });
    await fe.request('x', origin);
    fe.yes('console');
    await until(() => chat.handled.length === 1);
    fe.no();
    expect(chat.said.at(-1)).toBe('plan dropped after step 1/2 (the running command goes on; !stop ends it)');
    await until(() => !fe.busy);
    expect(chat.handled).toEqual(['!goto home']);

    await fe.request('x', origin);
    fe.yes('console');
    await until(() => chat.handled.length === 2);
    chat.ownerCommand('stop');
    await until(() => !fe.busy);
    expect(chat.handled).toEqual(['!goto home', '!goto home']);
  });

  it('a busy front end refuses a second request; provider errors and invalid answers are replied', async () => {
    const { chat, fe } = makeFrontEnd([
      [/broken/, '{"steps":[{"command":"teleport"}]}'],
      [/prose/, 'Sure! I will walk home.'],
    ]);
    standardCommands(chat);
    await fe.request('nothing matches', origin);
    expect(chat.said.at(-1)).toBe('nl: fake: no answer for "nothing matches"');
    await fe.request('broken', origin);
    expect(chat.said.at(-1)).toMatch(/^I could not make a plan of that \(steps\.0\.command: Invalid discriminator/);
    await fe.request('prose', origin);
    expect(chat.said.at(-1)).toMatch(/^I could not make a plan of that \(the answer is not JSON\)/);
  });

  it('without a provider !do says natural language is off', async () => {
    const chat = new FakeChat();
    const { fe } = makeFrontEnd([], { chat, provider: undefined });
    expect(fe.enabled).toBe(false);
    await fe.request('walk home', origin);
    expect(chat.said).toEqual(['natural language is off (nl.provider is none; docs/natural-language.md)']);
  });
});

describe('nl checks', () => {
  it('numbersIn', () => {
    expect([...numbersIn('go to 10 -60 3, radius 8')]).toEqual([10, -60, 3, 8]);
  });

  it('a radius the owner did not say is a question', () => {
    const r = checkPlan(steps({ command: 'guard', mode: 'on', radius: 30 }) as never, { text: 'guard please', sender: 'console', waypoints: [], commands: ['guard'] });
    expect(r).toEqual({ kind: 'question', text: 'Which radius?' });
  });

  it('addressed chat', () => {
    expect(addressedText('Bot, go home', 'Bot')).toBe('go home');
    expect(addressedText('bot: go home', 'Bot')).toBe('go home');
    expect(addressedText('@Bot go home', 'Bot')).toBe('go home');
    expect(addressedText('@bot, come here', 'Bot')).toBe('come here');
    expect(addressedText('Bot go home', 'Bot')).toBeUndefined();
    expect(addressedText('@Bottle go home', 'Bot')).toBeUndefined();
    expect(addressedText('hello Bot, go home', 'Bot')).toBeUndefined();
    expect(addressedText('!do go home', 'Bot')).toBeUndefined();
    expect(addressedText('Bot,', 'Bot')).toBeUndefined();
  });
});
