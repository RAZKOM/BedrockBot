// Track P4: `!queue` and `!goals` on the real afk registry (docs/queue.md): registered with walking, the add and its
// refusals as the owner sees them, a typed command pausing the queue while a job's own dispatch does not, the file
// written under BEDROCKBOT_QUEUE_DIR and read back by the next start, `!status` carrying the queue's line.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goalsOf, queueOf } from '../../../src/chat/commands-queue.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import type { QueueData } from '../../../src/tasks/queue.ts';
import type { WalkingTask } from '../../../src/tasks/registry.ts';
import { afkChat } from './afk-chat.ts';

const consoleLine = (text: string): ChatLine => ({ type: 'announcement', source: 'Server', message: `[Server] ${text}`, body: text, xuid: '', truth: false });

describe('!queue on the afk registry', () => {
  let dir: string;
  const env = process.env.BEDROCKBOT_QUEUE_DIR;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-afk-'));
    process.env.BEDROCKBOT_QUEUE_DIR = dir;
  });
  afterAll(() => {
    if (env === undefined) delete process.env.BEDROCKBOT_QUEUE_DIR;
    else process.env.BEDROCKBOT_QUEUE_DIR = env;
    rmSync(dir, { recursive: true, force: true });
  });

  function bot() {
    const b = afkChat();
    const said: string[] = [];
    const say = b.chat.say.bind(b.chat);
    b.chat.say = (m: string) => {
      said.push(m);
      return say(m);
    };
    const send = (text: string, typed = false): string[] => {
      const n = said.length;
      b.chat.handle(consoleLine(text), typed);
      return said.slice(n);
    };
    return { ...b, said, send };
  }

  it('adds, refuses, lists; a typed command that works pauses it, an answer or the queue\'s own does not; the file is read back', () => {
    const b = bot();
    const q = queueOf(b.task)!;
    expect(q).toBeDefined();
    expect(goalsOf(b.task)).toBeDefined();
    expect(b.send('!queue add !goto 1 2 3')).toEqual(['queue: added #1 !goto 1 2 3 (1 of 1)']);
    expect(b.send('!queue add get kit iron')).toEqual(['queue: added #2 !get kit iron (2 of 2)']);
    expect(b.send('!queue add !follow Steve')).toEqual(['queue: cannot queue !follow: it never ends by itself']);
    expect(b.send('!queue add !nosuch')).toEqual(['queue: cannot queue !nosuch: no command !nosuch']);
    expect(b.send('!queue add !farm')).toEqual(['queue: cannot queue !farm: it farms until stopped (!farm new sets a plot up and ends)']);
    expect(b.send('!queue')[0]).toBe('queue: waiting #1 !goto 1 2 3, #2 !get kit iron'); // (the tick says why it waits: not in the game)
    b.send('!status', true);
    b.send('!set autoMilk on', true);
    expect(q.paused).toBe(false);
    b.send('!goto 5 5 5'); // not typed (a job's step, the plan's dispatch)
    expect(q.paused).toBe(false);
    const kept = b.chat.keptCount;
    b.send('!goto 5 5 5', true);
    expect(q.paused).toBe(true);
    expect(q.snapshot().why).toBe('!goto was typed');
    expect(b.chat.keptCount).toBe(kept + 1); // the owner's line waits for the bot to be in the game (sayKept)
    expect(b.send('!queue resume')).toEqual(['queue: resumed; next #1 !goto 1 2 3']);
    expect(b.send('!queue move 2 1')).toEqual(['queue: #2 !get kit iron is 1 of 2']);
    expect(b.send('!queue onfail stop')).toEqual(['queue: a failed job pauses the queue']);
    expect(b.send('!queue remove 1')).toEqual(['queue: removed #1 !goto 1 2 3']);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const d = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as QueueData;
    expect(d).toMatchObject({ v: 1, onFail: 'stop', paused: false, jobs: [{ id: 2, command: '!get kit iron', by: 'console', via: 'console', state: 'waiting' }] });
    // the next start reads it
    const c = bot();
    expect(queueOf(c.task)!.waiting().map((j) => j.command)).toEqual(['!get kit iron']);
    expect(c.send('!queue add !goto 7 7 7')).toEqual(['queue: added #3 !goto 7 7 7 (2 of 2)']);
    expect((c.task as WalkingTask).processLines?.().at(-1)).toMatch(/^queue \(a failure pauses it\): waiting #2 !get kit iron, #3 !goto 7 7 7/);
    const goals = c.send('!goals').join(' ');
    expect(goals).toMatch(/^goals: food on \(autoFood; at least \d+ hunger points carried\)/);
    expect(goals).toContain('milk off (autoMilk; ');
    expect(goals).toMatch(/!set <setting> on\|off switches one$/);
    c.task.stop();
    b.task.stop();
  });
});
