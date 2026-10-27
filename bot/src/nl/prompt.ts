// The prompt for the model (PLAN.md 7.18, Track Y; docs/natural-language.md "The prompt"): rules, the
// command reference (each step kind with the chat's own help text), the bot's state (status line,
// process stack, waypoint names, inventory, settings) and seven worked examples. The user message is
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
  food: '{"command":"food"}: go and get food',
  eat: '{"command":"eat"}: eat now',
  equip: '{"command":"equip"}: put on the best armour',
  wp_set: '{"command":"wp_set","name":"<name>"}: save a waypoint where the bot stands; x y z only when the request states them',
  wp_del: '{"command":"wp_del","name":"<name>"}: delete a waypoint',
  set: '{"command":"set","key":"<setting>","value":V}: change a runtime setting (keys from the settings list)',
  sleep: '{"command":"sleep"}: sleep in a bed',
  pause: '{"command":"pause"}: hold the running command',
  resume: '{"command":"resume"}: continue after pause',
  get: '{"command":"get","item":"oak_log","count":N?}: get N of an item (wood, ores, stone, dirt, sand, food, crops); the first choice for get / bring / collect: it picks gather, mine, food or farm itself', // Track AD
  build: '{"command":"build","shape":"fill"|"clear"|"wall"|"floor"|"pillar"|"file","x":X?,"y":Y?,"z":Z?,"x2":X?,"y2":Y?,"z2":Z?,"height":H?,"block":"cobblestone"?,"name":"<file>"?}: build from the inventory: fill / clear the box x y z to x2 y2 z2, a wall from x y z to x2 z2 H high, a floor x y z to x2 z2, a pillar H high at x y z, file = a saved structure by name (at x y z, else at the bot); no x y z = at the bot', // Track AL
  question: '{"command":"question","text":"..."}: ask the person one short question instead of guessing; last step',
};

export interface Example {
  request: string;
  plan: Plan;
}

/** Seven worked examples (they also serve as FakeProvider answers in the tests; Track AD added get). */
export const EXAMPLES: readonly Example[] = [
  { request: 'walk home and then guard', plan: { steps: [{ command: 'goto', waypoint: 'home' }, { command: 'guard', mode: 'on' }] } },
  { request: 'come here please', plan: { steps: [{ command: 'come' }] } },
  { request: 'kill 3 zombies', plan: { steps: [{ command: 'kill', type: 'zombie', count: 3 }] } },
  { request: 'remember this spot as mine', plan: { steps: [{ command: 'wp_set', name: 'mine' }] } },
  { request: 'go to the castle', plan: { steps: [{ command: 'question', text: 'I know no waypoint "castle". Which waypoint, or which x y z?' }] } },
  { request: 'mine 10 iron then come back to me', plan: { steps: [{ command: 'mine', block: 'iron_ore', count: 10 }, { command: 'come' }] } },
  { request: 'get me 20 oak logs', plan: { steps: [{ command: 'get', item: 'oak_log', count: 20 }] } }, // Track AD
  { request: 'build a cobblestone wall from 0 -60 0 to 9 0, 4 high', plan: { steps: [{ command: 'build', shape: 'wall', x: 0, y: -60, z: 0, x2: 9, z2: 0, height: 4, block: 'cobblestone' }] } }, // Track AL
];

export function buildSystemPrompt(c: PromptContext): string {
  const ref = STEP_KINDS.map((k) => {
    const chat = k === 'question' ? undefined : COMMAND_SPECS[k].chat;
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
    '',
    'Commands:',
    ...ref,
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
