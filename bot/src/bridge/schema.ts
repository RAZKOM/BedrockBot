// Bot <-> Python message schema (PLAN.md section 4.5), WebSocket text frames with one JSON object
// each, one env per connection. Extensions to 4.5 are additive (docs/rl.md lists them):
//   - action kinds: the 4.5 names (goto_nearest, dig_facing, collect, noop) and the section 9 v1
//     names (goto_nearest_log, dig_facing_block, collect_drops, turn_left, turn_right, step_forward,
//     jump_forward) are both accepted; replies name the v1 kind.
//   - reset takes optional `options` {origin:[x,z], tool}; its reply is an `obs` whose `info` carries
//     the reset result (seed, checksum, reset_ms, ...).
//   - `obs` adds `terminated` / `truncated` (Gymnasium) beside `done`, `self.pitch`,
//     `nearest_log.in_reach`, `last_skill.{action,reason,ticks}`, `reward_signals.log_in_reach`,
//     and info {corrections, episode_corrections, step, episode_ticks, logs, reason}.
//   - bot -> Python: `hello` on connect, `closed` after a `close`.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

/** Action space v1 (PLAN.md section 9), in Discrete-index order. */
export const ACTIONS_V1 = ['noop', 'goto_nearest_log', 'dig_facing_block', 'collect_drops', 'turn_left', 'turn_right', 'step_forward', 'jump_forward'] as const;
export type ActionKind = (typeof ACTIONS_V1)[number];

/** Grid cell classes (PLAN.md section 9), id = index. */
export const GRID_CLASSES = ['air', 'solid', 'log', 'leaves', 'water', 'lava', 'item_drop', 'other', 'unknown'] as const;
export type GridClass = (typeof GRID_CLASSES)[number];
/** Grid extent: x (9) by z (9) by y (5), around the feet block; y from feet - 1 to feet + 3. */
export const GRID_SHAPE = [9, 9, 5] as const;
export const GRID_SIZE = GRID_SHAPE[0] * GRID_SHAPE[1] * GRID_SHAPE[2];
export const GRID_Y_MIN = -1;

const actionAliases: Record<string, ActionKind> = {
  noop: 'noop',
  goto_nearest: 'goto_nearest_log',
  goto_nearest_log: 'goto_nearest_log',
  dig_facing: 'dig_facing_block',
  dig_facing_block: 'dig_facing_block',
  collect: 'collect_drops',
  collect_drops: 'collect_drops',
  turn_left: 'turn_left',
  turn_right: 'turn_right',
  step_forward: 'step_forward',
  jump_forward: 'jump_forward',
};

export const ActionSchema = z
  .object({
    kind: z.string().refine((k) => k in actionAliases, { message: `unknown action kind (one of ${Object.keys(actionAliases).join(', ')})` }),
    /** goto_nearest: block name (`oak_log`) or the class `log` (default). */
    block: z.string().min(1).optional(),
  })
  .loose();
export type ActionMsg = z.infer<typeof ActionSchema>;

export interface Action {
  kind: ActionKind;
  /** goto_nearest_log target: `log` (any natural log) or one block name. */
  block: string;
}

export function normaliseAction(a: ActionMsg): Action {
  return { kind: actionAliases[a.kind]!, block: a.block ?? 'log' };
}

const Id = z.number().int().nonnegative();

export const ResetMsg = z.object({
  t: z.literal('reset'),
  id: Id,
  scenario: z.string().regex(/^[a-z0-9_]+$/).default('forest_small'),
  seed: z.number().int().default(0),
  options: z
    .object({
      origin: z.tuple([z.number().int(), z.number().int()]).optional(),
      tool: z.string().regex(/^[a-z0-9_:]+$/).optional(),
    })
    .optional(),
});
export const StepMsg = z.object({ t: z.literal('step'), id: Id, action: ActionSchema });
export const CloseMsg = z.object({ t: z.literal('close'), id: Id });
export const InboundSchema = z.discriminatedUnion('t', [ResetMsg, StepMsg, CloseMsg]);
export type Inbound = z.infer<typeof InboundSchema>;

// ---- bot -> Python ------------------------------------------------------------------------------

const Num = z.number();
export const SkillResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  action: z.string().optional(),
  ticks: z.number().int().nonnegative().optional(),
});

export const ObservationSchema = z.object({
  grid: z.array(z.number().int().min(0).max(GRID_CLASSES.length - 1)).length(GRID_SIZE),
  self: z.object({
    pos: z.tuple([Num, Num, Num]),
    yaw: Num,
    pitch: Num,
    health: Num,
    food: Num,
    on_ground: z.boolean(),
  }),
  inventory: z.record(z.string(), z.number().int().nonnegative()),
  nearest_log: z.object({ dx: Num, dy: Num, dz: Num, dist: Num, in_reach: z.boolean() }).nullable(),
  last_skill: SkillResultSchema,
});
export type Observation = z.infer<typeof ObservationSchema>;

export const RewardSignalsSchema = z.object({
  logs_delta: z.number().int().nonnegative(),
  died: z.boolean(),
  ticks_used: z.number().int().nonnegative(),
  log_in_reach: z.boolean(),
});
export type RewardSignals = z.infer<typeof RewardSignalsSchema>;

export const ObsMsg = z.object({
  t: z.literal('obs'),
  id: Id,
  tick: z.number().int(),
  obs: ObservationSchema,
  reward_signals: RewardSignalsSchema,
  done: z.boolean(),
  terminated: z.boolean(),
  truncated: z.boolean(),
  info: z.object({ corrections: z.number().int().nonnegative() }).loose(),
});
export type ObsMessage = z.infer<typeof ObsMsg>;

export const ErrorMsg = z.object({ t: z.literal('error'), id: Id.nullable(), message: z.string() });
export const HelloMsg = z.object({
  t: z.literal('hello'),
  protocol: z.literal(PROTOCOL_VERSION),
  actions: z.array(z.string()),
  grid: z.object({ shape: z.tuple([z.number(), z.number(), z.number()]), order: z.string(), y_min: z.number(), classes: z.array(z.string()) }),
  episode: z.object({ max_steps: z.number(), max_ticks: z.number(), target_logs: z.number(), action_ticks: z.number() }),
  bot: z.string(),
});
export const ClosedMsg = z.object({ t: z.literal('closed'), id: Id });
export const OutboundSchema = z.discriminatedUnion('t', [ObsMsg, ErrorMsg, HelloMsg, ClosedMsg]);
export type Outbound = z.infer<typeof OutboundSchema>;

/** Parses one inbound text frame; returns the message or an error string. */
export function parseInbound(text: string): { ok: true; msg: Inbound } | { ok: false; id: number | null; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, id: null, message: `bad json: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = InboundSchema.safeParse(raw);
  if (r.success) return { ok: true, msg: r.data };
  const id = typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'number' ? (raw as { id: number }).id : null;
  return { ok: false, id: id !== null && Number.isInteger(id) && id >= 0 ? id : null, message: `bad message: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
}
