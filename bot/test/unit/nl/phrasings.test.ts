// PLAN.md 7.18 (Track Y): 20 phrasings map to the right plans and chat commands, 3 ambiguous ones end
// in a question. The FakeProvider stands in for the model (its answers are what a model should say);
// the test covers everything after it: schema validation, the checks against what the owner said,
// the plan line, and the commands fed to the chat one by one.
import { describe, expect, it } from 'vitest';
import type { FakeAnswer, FakeRule } from '../../../src/nl/fake.ts';
import { consoleLine, makeFrontEnd, playerLine, standardCommands, until } from './helpers.ts';

interface Case {
  text: string;
  answer: FakeAnswer;
  line: string;
  commands: string[];
}

const steps = (...s: Record<string, unknown>[]) => ({ steps: s });

const CASES: Case[] = [
  { text: 'walk to home', answer: steps({ command: 'goto', waypoint: 'home' }), line: 'plan: goto home', commands: ['!goto home'] },
  { text: 'come here', answer: steps({ command: 'come' }), line: 'plan: come', commands: ['!come'] },
  { text: 'follow me', answer: steps({ command: 'follow' }), line: 'plan: follow', commands: ['!follow'] },
  { text: 'stop that', answer: steps({ command: 'stop' }), line: 'plan: stop', commands: ['!stop'] },
  { text: 'guard the base with radius 24', answer: steps({ command: 'guard', mode: 'on', radius: 24 }), line: 'plan: guard 24', commands: ['!guard 24'] },
  { text: 'kill 3 zombies', answer: steps({ command: 'kill', type: 'zombie', count: 3 }), line: 'plan: kill zombie 3', commands: ['!kill zombie 3'] },
  { text: 'gather 32 logs', answer: steps({ command: 'gather', count: 32 }), line: 'plan: gather 32', commands: ['!gather 32'] },
  { text: 'mine 10 iron', answer: steps({ command: 'mine', block: 'iron_ore', count: 10 }), line: 'plan: mine iron_ore 10', commands: ['!mine iron_ore 10'] },
  { text: 'farm the field', answer: steps({ command: 'farm' }), line: 'plan: farm', commands: ['!farm'] },
  { text: 'go get some food', answer: steps({ command: 'food' }), line: 'plan: food', commands: ['!food'] },
  { text: 'eat something', answer: steps({ command: 'eat' }), line: 'plan: eat', commands: ['!eat'] },
  { text: 'put your armour on', answer: steps({ command: 'equip' }), line: 'plan: equip', commands: ['!equip'] },
  { text: 'save this spot as base2', answer: steps({ command: 'wp_set', name: 'base2' }), line: 'plan: wp set base2', commands: ['!wp set base2'] },
  { text: 'go to the base waypoint', answer: steps({ command: 'goto', waypoint: 'base' }), line: 'plan: goto base', commands: ['!goto base'] },
  { text: 'go to sleep', answer: steps({ command: 'sleep' }), line: 'plan: sleep', commands: ['!sleep'] },
  { text: 'wait a moment', answer: steps({ command: 'pause' }), line: 'plan: pause', commands: ['!pause'] },
  { text: 'carry on', answer: steps({ command: 'resume' }), line: 'plan: resume', commands: ['!resume'] },
  {
    text: 'walk home then guard',
    answer: steps({ command: 'goto', waypoint: 'home' }, { command: 'guard', mode: 'on' }),
    line: 'plan: goto home, then guard on',
    commands: ['!goto home', '!guard on'],
  },
  {
    text: 'kill 2 skeletons and then come to me',
    answer: steps({ command: 'kill', type: 'skeleton', count: 2 }, { command: 'come' }),
    line: 'plan: kill skeleton 2, then come',
    commands: ['!kill skeleton 2', '!come'],
  },
  {
    text: 'go to 10 -60 3 and set the guard radius to 8',
    answer: steps({ command: 'goto_xyz', x: 10, y: -60, z: 3 }, { command: 'set', key: 'guardRadius', value: 8 }),
    line: 'plan: goto 10 -60 3, then set guardRadius 8',
    commands: ['!goto 10 -60 3', '!set guardRadius 8'],
  },
];

const AMBIGUOUS: { text: string; answer: FakeAnswer; question: RegExp }[] = [
  // the model asks itself
  { text: 'get some wood', answer: steps({ command: 'question', text: 'How many logs should I gather?' }), question: /^How many logs should I gather\?$/ },
  // the model names a waypoint that does not exist: the executor asks
  { text: 'go to the castle', answer: steps({ command: 'goto', waypoint: 'castle' }), question: /^I know no waypoint "castle" \(known: home, base, farm, mine\)\. Which one, or which x y z\?$/ },
  // the model makes up coordinates: the executor asks
  { text: 'go up the mountain', answer: steps({ command: 'goto_xyz', x: 120, y: 90, z: -40 }), question: /^Which coordinates\? Say x y z\.$/ },
];

const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

describe('natural language: 20 phrasings', () => {
  const rules: FakeRule[] = [...CASES, ...AMBIGUOUS].map((c) => [exact(c.text), c.answer]);

  it('has 20 phrasings and 3 ambiguous ones', () => {
    expect(CASES).toHaveLength(20);
    expect(AMBIGUOUS).toHaveLength(3);
  });

  for (const c of CASES) {
    it(`"${c.text}" -> ${c.line}`, async () => {
      const { chat, fe } = makeFrontEnd(rules);
      standardCommands(chat);
      const r = await fe.request(c.text, { line: consoleLine(`!do ${c.text}`), sender: 'console' });
      expect(r?.kind).toBe('plan');
      expect(chat.said.at(-1)).toBe(`${c.line} (!yes to run, !no to drop)`);
      expect(chat.handled).toEqual([]);
      fe.yes('console');
      await until(() => !fe.busy);
      expect(chat.handled).toEqual(c.commands);
      if (c.commands.length > 1) expect(chat.said.at(-1)).toBe(`plan done (${c.commands.length} steps)`);
    });
  }

  for (const a of AMBIGUOUS) {
    it(`"${a.text}" -> a question`, async () => {
      const { chat, fe } = makeFrontEnd(rules);
      standardCommands(chat);
      const r = await fe.request(a.text, { line: consoleLine(`!do ${a.text}`), sender: 'console' });
      expect(r?.kind).toBe('question');
      expect(chat.said).toHaveLength(1);
      expect(chat.said[0]).toMatch(a.question);
      expect(fe.waiting).toBeUndefined();
      fe.yes('console');
      expect(chat.handled).toEqual([]);
    });
  }

  it('"come to me" with the sender named by the model runs a plain !come', async () => {
    const { chat, fe } = makeFrontEnd([[/come to me/, steps({ command: 'come', player: 'Steve' })]]);
    standardCommands(chat);
    await fe.request('come to me', { line: playerLine('Steve', '!do come to me'), sender: 'Steve' });
    expect(chat.said.at(-1)).toBe('plan: come (!yes to run, !no to drop)');
  });

  it('a player the owner did not name becomes a question', async () => {
    const { chat, fe } = makeFrontEnd([[/follow him/, steps({ command: 'follow', player: 'Alex' })]]);
    standardCommands(chat);
    const r = await fe.request('follow him', { line: playerLine('Steve', '!do follow him'), sender: 'Steve' });
    expect(r).toEqual({ kind: 'question', text: 'Who should I follow?' });
  });
});
