// The plan schema (PLAN.md 7.18, Track Y; docs/natural-language.md "The plan schema"): what a model
// may answer. A plan is 1..8 steps; each step is one existing chat command with typed, bounded
// arguments, or a `question` when the request is ambiguous. Nothing else validates (strict objects,
// a closed list of commands). The same zod schema is the JSON schema the model is constrained to
// (z.toJSONSchema) and the validator of its answer.
//
// To add a command: one entry in STEP_SCHEMAS (its arguments), COMMAND_SPECS (the chat command, how
// the executor knows it finished), stepCommand (the chat text) and an example in nl/prompt.ts if it
// is not obvious. docs/natural-language.md "Adding a command".
import { z } from 'zod';
import { parseSettingValue, SETTING_KEYS, SettingError, type SettingKey } from '../config/settings.ts';

const XZ = 30_000_000;
const coordXZ = z.number().int().min(-XZ).max(XZ);
const coordY = z.number().int().min(-64).max(320);
/** Waypoint names as the store accepts them (waypoints/store.ts), lower case. */
const wpName = z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,31}$/);
/** One chat word: player names with spaces cannot be passed to !come / !follow. */
const playerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/);
const mobType = z.string().regex(/^(minecraft:)?[a-z][a-z0-9_]{1,39}$/);
const blockName = z.string().regex(/^(minecraft:)?[a-z][a-z0-9_]{1,63}$/);

/** Settings the model may change (`nlConfirm` is not one of them: only an owner's `!set` turns it off). */
export const NL_SETTING_KEYS = SETTING_KEYS.filter((k) => k !== 'nlConfirm') as [SettingKey, ...SettingKey[]];

export const STEP_SCHEMAS = {
  goto: z.strictObject({ command: z.literal('goto'), waypoint: wpName }),
  goto_xyz: z.strictObject({ command: z.literal('goto_xyz'), x: coordXZ, y: coordY, z: coordXZ }),
  come: z.strictObject({ command: z.literal('come'), player: playerName.optional() }),
  follow: z.strictObject({ command: z.literal('follow'), player: playerName.optional() }),
  stop: z.strictObject({ command: z.literal('stop') }),
  guard: z.strictObject({ command: z.literal('guard'), mode: z.enum(['on', 'off']), radius: z.number().int().min(2).max(64).optional() }),
  kill: z.strictObject({ command: z.literal('kill'), type: mobType, count: z.number().int().min(1).max(64) }),
  gather: z.strictObject({ command: z.literal('gather'), count: z.number().int().min(1).max(2304) }),
  mine: z.strictObject({ command: z.literal('mine'), block: blockName, count: z.number().int().min(1).max(256) }),
  farm: z.strictObject({ command: z.literal('farm'), radius: z.number().int().min(1).max(32).optional() }),
  food: z.strictObject({ command: z.literal('food') }),
  eat: z.strictObject({ command: z.literal('eat') }),
  equip: z.strictObject({ command: z.literal('equip') }),
  wp_set: z.strictObject({ command: z.literal('wp_set'), name: wpName, x: coordXZ.optional(), y: coordY.optional(), z: coordXZ.optional() }),
  wp_del: z.strictObject({ command: z.literal('wp_del'), name: wpName }),
  set: z.strictObject({ command: z.literal('set'), key: z.enum(NL_SETTING_KEYS), value: z.union([z.boolean(), z.number(), z.string().max(16)]) }),
  sleep: z.strictObject({ command: z.literal('sleep') }),
  pause: z.strictObject({ command: z.literal('pause') }),
  resume: z.strictObject({ command: z.literal('resume') }),
  get: z.strictObject({ command: z.literal('get'), item: blockName, count: z.number().int().min(1).max(2304).optional() }), // Track AD: !get, the first choice for getting items
  question: z.strictObject({ command: z.literal('question'), text: z.string().min(1).max(200) }),
} as const;

export type StepKind = keyof typeof STEP_SCHEMAS;
export const STEP_KINDS = Object.keys(STEP_SCHEMAS) as StepKind[];

export const StepSchema = z.discriminatedUnion('command', [
  STEP_SCHEMAS.goto,
  STEP_SCHEMAS.goto_xyz,
  STEP_SCHEMAS.come,
  STEP_SCHEMAS.follow,
  STEP_SCHEMAS.stop,
  STEP_SCHEMAS.guard,
  STEP_SCHEMAS.kill,
  STEP_SCHEMAS.gather,
  STEP_SCHEMAS.mine,
  STEP_SCHEMAS.farm,
  STEP_SCHEMAS.food,
  STEP_SCHEMAS.eat,
  STEP_SCHEMAS.equip,
  STEP_SCHEMAS.wp_set,
  STEP_SCHEMAS.wp_del,
  STEP_SCHEMAS.set,
  STEP_SCHEMAS.sleep,
  STEP_SCHEMAS.pause,
  STEP_SCHEMAS.resume,
  STEP_SCHEMAS.get, // Track AD
  STEP_SCHEMAS.question,
]);
export type Step = z.infer<typeof StepSchema>;

export const MAX_STEPS = 8;

/** How the executor knows a step finished (nl/executor.ts). */
export interface CommandSpec {
  /** The chat command it runs (`!<chat>`). */
  chat: string;
  /**
   * `none`: done once the command answered (instant: guard, set, pause);
   * `process`: done when the process manager has no user process left (or `done` matched);
   * `reply`: done when a reply matches `done` (commands outside the manager: mine, eat, equip);
   * `endless`: runs until !stop (follow, farm): only allowed as the last step, done once started.
   */
  wait: 'none' | 'process' | 'reply' | 'endless';
  /** A reply that ends the step successfully. */
  done?: RegExp;
  /** A reply that ends the step and the plan (failure), besides the common ones (usage, needs walking, ...). */
  fail?: RegExp;
}

export const COMMAND_SPECS: Record<Exclude<StepKind, 'question'>, CommandSpec> = {
  goto: { chat: 'goto', wait: 'process', done: /^arrived at /, fail: /^(goto: |no waypoint )/ },
  goto_xyz: { chat: 'goto', wait: 'process', done: /^arrived at /, fail: /^goto: / },
  come: { chat: 'come', wait: 'process', done: /^here \(/, fail: /^come: / },
  follow: { chat: 'follow', wait: 'endless', fail: /^I cannot follow/ },
  stop: { chat: 'stop', wait: 'none' },
  guard: { chat: 'guard', wait: 'none' },
  kill: { chat: 'kill', wait: 'process', done: /^kill \S+: / },
  gather: { chat: 'gather', wait: 'process' },
  mine: { chat: 'mine', wait: 'reply', done: /^mine \S+: /, fail: /^mine: / },
  farm: { chat: 'farm', wait: 'endless', fail: /^farm: / },
  food: { chat: 'food', wait: 'process' },
  eat: { chat: 'eat', wait: 'reply', done: /^(ate |eat: )/ },
  equip: { chat: 'equip', wait: 'reply', done: /^equip: / },
  wp_set: { chat: 'wp', wait: 'none', fail: /^position unknown/ },
  wp_del: { chat: 'wp', wait: 'none', fail: /^no waypoint / },
  set: { chat: 'set', wait: 'none', fail: /( must be |^unknown setting|^!set failed)/ },
  sleep: { chat: 'sleep', wait: 'process' },
  pause: { chat: 'pause', wait: 'none' },
  resume: { chat: 'resume', wait: 'none' },
  get: { chat: 'get', wait: 'process', fail: /^get: / }, // Track AD
};

/** Replies that end any step and the plan. */
export const COMMON_FAIL = /(^usage: |^unknown command |needs a task that can walk|^refused|not available)/;

const ENDLESS = new Set<StepKind>(STEP_KINDS.filter((k) => k !== 'question' && COMMAND_SPECS[k].wait === 'endless'));

export const PlanSchema = z
  .strictObject({ steps: z.array(StepSchema).min(1).max(MAX_STEPS) })
  .superRefine((plan, ctx) => {
    plan.steps.forEach((s, i) => {
      const last = i === plan.steps.length - 1;
      if (s.command === 'question' && !last) ctx.addIssue({ code: 'custom', path: ['steps', i], message: 'a question must be the last step' });
      if (ENDLESS.has(s.command) && !last) ctx.addIssue({ code: 'custom', path: ['steps', i], message: `${s.command} runs until !stop: only as the last step` });
      if (s.command === 'guard' && s.mode === 'off' && s.radius !== undefined) ctx.addIssue({ code: 'custom', path: ['steps', i, 'radius'], message: 'a radius needs guard on' });
      if (s.command === 'wp_set') {
        const n = [s.x, s.y, s.z].filter((v) => v !== undefined).length;
        if (n !== 0 && n !== 3) ctx.addIssue({ code: 'custom', path: ['steps', i], message: 'wp_set takes all of x y z or none' });
      }
      if (s.command === 'set') {
        try {
          parseSettingValue(s.key, s.value);
        } catch (e) {
          ctx.addIssue({ code: 'custom', path: ['steps', i, 'value'], message: e instanceof SettingError ? e.message : String(e) });
        }
      }
      if (s.command === 'kill' && /^(minecraft:)?player$/.test(s.type)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'type'], message: 'never players' });
    });
  });
export type Plan = z.infer<typeof PlanSchema>;

let jsonSchema: Record<string, unknown> | undefined;
/** The JSON schema handed to the model (`format` for Ollama). Refinements are checked after parsing. */
export function planJsonSchema(): Record<string, unknown> {
  jsonSchema ??= z.toJSONSchema(PlanSchema, { target: 'draft-7' }) as Record<string, unknown>;
  return jsonSchema;
}

export type ParseResult = { ok: true; plan: Plan } | { ok: false; error: string };

/** Parse the model's answer text. Never throws. */
export function parsePlan(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the answer is not JSON' };
  }
  const r = PlanSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, error: issues.join('; ') };
  }
  return { ok: true, plan: r.data };
}

/** The chat command name a step runs (`goto`, `wp`, ...); undefined for a question. */
export function stepChatName(s: Step): string | undefined {
  return s.command === 'question' ? undefined : COMMAND_SPECS[s.command].chat;
}

function settingText(v: boolean | number | string): string {
  return typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);
}

/** The chat command text of a step without the prefix: `goto home`, `kill zombie 3`; a question: its text. */
export function stepCommand(s: Step): string {
  switch (s.command) {
    case 'goto':
      return `goto ${s.waypoint}`;
    case 'goto_xyz':
      return `goto ${s.x} ${s.y} ${s.z}`;
    case 'come':
    case 'follow':
      return s.player ? `${s.command} ${s.player}` : s.command;
    case 'guard':
      return s.mode === 'on' && s.radius !== undefined ? `guard ${s.radius}` : `guard ${s.mode}`;
    case 'kill':
      return `kill ${s.type} ${s.count}`;
    case 'gather':
      return `gather ${s.count}`;
    case 'mine':
      return `mine ${s.block} ${s.count}`;
    case 'farm':
      return s.radius !== undefined ? `farm ${s.radius}` : 'farm';
    case 'wp_set':
      return s.x !== undefined && s.y !== undefined && s.z !== undefined ? `wp set ${s.name} ${s.x} ${s.y} ${s.z}` : `wp set ${s.name}`;
    case 'wp_del':
      return `wp del ${s.name}`;
    case 'set':
      return `set ${s.key} ${settingText(s.value)}`;
    case 'get': // Track AD
      return s.count !== undefined ? `get ${s.item} ${s.count}` : `get ${s.item}`;
    case 'question':
      return s.text;
    default:
      return s.command;
  }
}

/** `plan: goto home, then guard on` (a question shows as `ask "..."`). */
export function planLine(plan: Plan): string {
  return `plan: ${plan.steps.map((s) => (s.command === 'question' ? `ask "${s.text}"` : stepCommand(s))).join(', then ')}`;
}
