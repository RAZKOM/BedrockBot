// The prompt for the model (PLAN.md 7.18, Track Y; docs/natural-language.md "The prompt"): rules, the
// command reference (each step kind with the chat's own help text), the bot's state (status line,
// process stack, waypoint names, inventory, settings) and the worked examples. The user message is
// `request from <sender>: <text>`.
import { MAX_STEPS, STEP_KINDS, COMMAND_SPECS, type Plan, type StepKind } from './plan.ts';

export interface PromptContext {
  botName: string;
  /** `console` or the player's name. */
  sender: string;
  /** One line: position, behaviour, health ... */
  status: string;
  /** The process stack (`processes: ...`), or `none`. */
  stack: string;
  waypoints: readonly string[];
  /** Inventory summary (the !inv line), or `unknown`. */
  inventory: string;
  /** `key value, ...` */
  settings: string;
  /** The chat's registered help, `!name help` per command (Chat.helpText split, see helpByCommand). */
  help: ReadonlyMap<string, string>;
}

/** Split Chat.helpText() (`!a help | !b help ...`) into name -> `!a help`. */
export function helpByCommand(helpText: string, prefix = '!'): Map<string, string> {
  const out = new Map<string, string>();
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const part of helpText.split(new RegExp(` \\| (?=${esc}[a-z])`))) {
    const m = new RegExp(`^${esc}([a-z][\\w-]*)`).exec(part.trim());
    if (m) out.set(m[1]!, part.trim());
  }
  return out;
}

/** What each step kind means and its JSON form (the schema has the exact bounds). */
const STEP_DOCS: Record<StepKind, string> = {
  goto: '{"command":"goto","waypoint":"<name>"}: walk to a known waypoint (names from the waypoint list only)',
  goto_xyz: '{"command":"goto_xyz","x":X,"y":Y,"z":Z}: walk to coordinates, only when the request states all three numbers',
  come: '{"command":"come"}: walk to the person asking ("come here", "come to me"); "player" only when another player is named',
  follow: '{"command":"follow"}: follow the person asking until stopped; "player" only when another player is named; last step only',
  stop: '{"command":"stop"}: stop every running command',
  guard: '{"command":"guard","mode":"on"|"off","radius":R?}: fight hostile mobs near home; radius 2..64 only with on',
  kill: '{"command":"kill","type":"zombie","count":N}: kill N mobs of one type (singular mob id, e.g. zombie, skeleton, spider, creeper); count 1 when not said; never players',
  gather: '{"command":"gather","count":N}: gather N logs (wood); ask when no number is given',
  mine: '{"command":"mine","block":"iron_ore","count":N}: mine N seen blocks of one ore or block id (iron -> iron_ore, coal -> coal_ore, diamonds -> diamond_ore)',
  farm: '{"command":"farm","radius":R?}: farm the crops around the bot (harvest, replant) until stopped; last step only',
  food: '{"command":"food","pen":true?}: go and get food; pen true only when the request allows animals in pens', // Track AK
  eat: '{"command":"eat"}: eat now',
  equip: '{"command":"equip"}: put on the best armour',
  wp_set: '{"command":"wp_set","name":"<name>"}: save a waypoint where the bot stands; x y z only when the request states them',
  wp_del: '{"command":"wp_del","name":"<name>"}: delete a waypoint',
  set: '{"command":"set","key":"<setting>","value":V}: change a runtime setting (keys from the settings list)',
  sleep: '{"command":"sleep"}: sleep in a bed',
  pause: '{"command":"pause"}: hold the running command',
  resume: '{"command":"resume"}: continue after pause',
  get: '{"command":"get","item":"oak_log","count":N?}: get N NEW items (wood, ores, stone, dirt, sand, food, crops); the first choice for get / collect / make: it picks gather, mine, food or farm itself; never from the chests', // Track AD (Track AS: bring is the stored items)
  breed: '{"command":"breed","type":"cow"?,"pairs":N?}: feed pairs of adult animals so they breed (cow, mooshroom, sheep, pig, chicken, rabbit); pairs 1..8, only when said', // Track AK
  panel: '{"command":"panel"}: tell the control panel (web page) address', // Track AK
  drop: '{"command":"drop","what":"all"|"items"}: drop everything carried (all), or everything except food, armour, tools and weapons (items)', // Track AK
  build: '{"command":"build","shape":"fill"|"clear"|"wall"|"floor"|"pillar"|"file","x":X?,"y":Y?,"z":Z?,"x2":X?,"y2":Y?,"z2":Z?,"height":H?,"block":"cobblestone"?,"name":"<file>"?}: build from the inventory: fill / clear the box x y z to x2 y2 z2, a wall from x y z to x2 z2 H high, a floor x y z to x2 z2, a pillar H high at x y z, file = a saved structure by name (at x y z, else at the bot); no x y z = at the bot', // Track AL
  ...{ unload: '{"command":"unload","all":B?}: put the carried items away into the chests at home (keeps food, tools, armour); all: also empty full shulker boxes', stock: '{"command":"stock","item":"coal"?}: say how many of an item the chests at home hold (from memory), or the totals', chests: '{"command":"chests","scan":B?}: list the chests at home; scan: walk to them and look inside again' }, // Track AG
  bring: '{"command":"bring","item":"torch","count":N?,"to":"home"?}: take items ALREADY STORED in the chests at home and carry them to the person asking ("bring me", "fetch from home", "bring the diamonds to me"); "to" only for another named player or "home"; get makes new items and ends at home, bring takes from the chests and ends at the player', // Track AS
  explore: '{"command":"explore","radius":R?}: walk around the unexplored land near home (radius 16..1024 blocks) so the bot remembers it: ores, forests, animals', // Track AI
  ...{ nether: '{"command":"nether"}: go into the Nether through the nearest known nether portal (it does not build portals)', overworld: '{"command":"overworld"}: come back from the Nether through the paired portal' }, // Track AT
  question: '{"command":"question","text":"..."}: ask the person one short question instead of guessing; last step',
  answer: '{"command":"answer","text":"..."}: answer a question about the bot (what it can do, whether it can cook, what it is doing) in up to 200 characters; nothing runs; always the only step', // Track AM
};

export interface Example {
  request: string;
  plan: Plan;
}

/** Worked examples (they also serve as FakeProvider answers in the tests; Track AD added get, Track AK breed, drop, food pen). */
export const EXAMPLES: readonly Example[] = [
  { request: 'walk home and then guard', plan: { steps: [{ command: 'goto', waypoint: 'home' }, { command: 'guard', mode: 'on' }] } },
  { request: 'come here please', plan: { steps: [{ command: 'come' }] } },
  { request: 'kill 3 zombies', plan: { steps: [{ command: 'kill', type: 'zombie', count: 3 }] } },
  { request: 'remember this spot as mine', plan: { steps: [{ command: 'wp_set', name: 'mine' }] } },
  { request: 'go to the castle', plan: { steps: [{ command: 'question', text: 'I know no waypoint "castle". Which waypoint, or which x y z?' }] } },
  { request: 'mine 10 iron then come back to me', plan: { steps: [{ command: 'mine', block: 'iron_ore', count: 10 }, { command: 'come' }] } },
  { request: 'get me 20 oak logs', plan: { steps: [{ command: 'get', item: 'oak_log', count: 20 }] } }, // Track AD
  { request: 'get me 8 iron and a stack of coal', plan: { steps: [{ command: 'get', item: 'iron', count: 8, more: [{ item: 'coal', count: 64 }] }] } }, // Track AQ: several ores, one trip
  { request: 'mine 4 diamonds and 10 redstone on one trip', plan: { steps: [{ command: 'mine', block: 'diamond_ore', count: 4, more: [{ block: 'redstone_ore', count: 10 }] }] } }, // Track AQ
  { request: 'breed two pairs of cows', plan: { steps: [{ command: 'breed', type: 'cow', pairs: 2 }] } }, // Track AK
  { request: 'empty your pockets but keep your gear', plan: { steps: [{ command: 'drop', what: 'items' }] } }, // Track AK
  { request: 'get food, the penned animals too', plan: { steps: [{ command: 'food', pen: true }] } }, // Track AK
  { request: 'what can you do', plan: { steps: [{ command: 'answer', text: 'I come, follow, guard, go home and get things (!get wood, !get iron, !get food); !help lists the commands. Or just tell me what to do.' }] } }, // Track AM
  { request: 'can you cook?', plan: { steps: [{ command: 'answer', text: 'Yes: after a hunt I cook raw food at a furnace or smoker within 16 blocks of home when I carry fuel; !cook does it now.' }] } }, // Track AM
  { request: 'build a cobblestone wall from 0 -60 0 to 9 0, 4 high', plan: { steps: [{ command: 'build', shape: 'wall', x: 0, y: -60, z: 0, x2: 9, z2: 0, height: 4, block: 'cobblestone' }] } }, // Track AL
  ...[{ request: 'put your stuff away', plan: { steps: [{ command: 'unload' }] } }, { request: 'how much coal do we have', plan: { steps: [{ command: 'stock', item: 'coal' }] } }, { request: 'check what is in the chests', plan: { steps: [{ command: 'chests', scan: true }] } }] as Example[], // Track AG
  { request: 'look around the area within 200 blocks', plan: { steps: [{ command: 'explore', radius: 200 }] } }, // Track AI
  { request: 'bring me 64 torches', plan: { steps: [{ command: 'bring', item: 'torch', count: 64 }] } }, // Track AS
  { request: 'go to the nether', plan: { steps: [{ command: 'nether' }] } }, // Track AT
];

export function buildSystemPrompt(c: PromptContext): string {
  const ref = STEP_KINDS.map((k) => {
    const chat = k === 'question' || k === 'answer' ? undefined : COMMAND_SPECS[k].chat;
    const help = chat === undefined ? '' : (c.help.get(chat) ?? `!${chat} (not available on this bot)`);
    return `- ${STEP_DOCS[k]}${help ? ` [chat: ${help}]` : ''}`;
  });
  const examples = EXAMPLES.map((e) => `request: ${e.request}\nanswer: ${JSON.stringify(e.plan)}`);
  return [
    `You turn requests to the Minecraft bot "${c.botName}" into a plan of its chat commands.`,
    `Answer with JSON only: {"steps":[...]} with 1 to ${MAX_STEPS} steps, each step one of the commands below.`,
    'Rules:',
    '- Use only these commands and only the arguments the request gives. Never invent coordinates, names or numbers.',
    '- A place must be a waypoint from the waypoint list, or coordinates the request states. Otherwise answer one question step.',
    '- "me", "here", "to me" mean the person asking: come / follow without a player.',
    '- When the request is unclear, unsafe, about attacking players, or not about these commands, answer one question step.',
    '- follow and farm run until stopped: only as the last step. A question is always the last step.',
    // Track AM: answers
    '- When the person asks about the bot (what it can do, can you cook, what are you doing) and asks for no action, answer one answer step, from the command reference and the bot state below only. Never invent abilities: what is not listed, the bot cannot do.',
    '- When the person asks for an action, answer a plan, not an answer step. An answer is always the only step.',
    '',
    'Commands:',
    ...ref,
    '',
    'Every chat command of this bot (for answers; "also on its own" happens without a command):',
    ...[...c.help.values()].map((h) => `- ${h}`),
    '',
    'Bot state:',
    `status: ${c.status}`,
    `processes: ${c.stack}`,
    `waypoints: ${c.waypoints.length ? c.waypoints.join(', ') : '(none)'}`,
    `inventory: ${c.inventory}`,
    `settings: ${c.settings}`,
    '',
    'Examples:',
    ...examples,
  ].join('\n');
}

export function buildUserMessage(sender: string, text: string): string {
  return `request from ${sender}: ${text.replace(/[\r\n]+/g, ' ').trim()}`;
}
