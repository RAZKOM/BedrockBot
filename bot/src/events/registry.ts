// The event registry (decision 0059, docs/events.md): every kind the bot can record, with its
// metadata. The bus (bus.ts) only accepts these names (`events.emit('job.finished', {...})` does not
// compile for an unknown kind or a wrong payload: the payload type is inferred from the schema), the
// guide's table is generated from it (`eventTable()`, a unit test compares), and the panel API serves
// it at GET /api/events/kinds.
//
// Adding a kind: one entry here (category = the part before the dot, a severity by the rules in
// docs/events.md, one line of doc, a zod schema, a formatter), regenerate the table in docs/events.md
// (the guard test prints it), then one emit line at the seam. Never rename a kind: stored lines keep it.
import { z } from 'zod';

export const SEVERITIES = ['info', 'notable', 'alert'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { info: 0, notable: 1, alert: 2 };

export const CATEGORIES = ['connection', 'life', 'combat', 'job', 'items', 'container', 'home', 'resource', 'command'] as const;
export type Category = (typeof CATEGORIES)[number];

const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
/** Item (or cause) name -> count. */
const counts = z.record(z.string(), z.number());
const text = z.string().max(400);

export interface EventDef<S extends z.ZodType = z.ZodType> {
  category: Category;
  severity: Severity;
  /** One line for the guide's table and the kinds endpoint. */
  doc: string;
  schema: S;
  /** One line for the timeline (`killed a zombie`, `job mine failed: no_pickaxe (3 min 5 s)`). */
  format(d: z.infer<S>): string;
}

function def<S extends z.ZodType>(d: EventDef<S>): EventDef<S> {
  return d;
}

const xyz = (p: { x: number; y: number; z: number } | undefined): string => (p ? `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}` : '?');
/** `iron_ingot x3, coal x12` (the largest first, at most 6). */
export function countsText(c: Record<string, number>, max = 6): string {
  const e = Object.entries(c).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const s = e.slice(0, max).map(([k, n]) => `${k} x${n}`).join(', ');
  return e.length > max ? `${s}, +${e.length - max} more` : s || 'nothing';
}
/** `12 s`, `3 min 5 s`, `2 h 4 min`. */
export function durationText(s: number): string {
  const r = Math.max(0, Math.round(s));
  if (r < 60) return `${r} s`;
  if (r < 3600) return `${Math.floor(r / 60)} min ${r % 60} s`;
  return `${Math.floor(r / 3600)} h ${Math.floor((r % 3600) / 60)} min`;
}
const by = (b: string | undefined): string => (b ? ` by ${b}` : '');
/** Cut a payload string to `n` characters (the schemas allow 400; the seams keep reasons to 200). */
export function clipText(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export const EVENT_KINDS = {
  // ---- connection (index.ts wireEvents: Connection.onSpawn / onClose) ---------------------------
  'connection.connected': def({
    category: 'connection',
    severity: 'info',
    doc: 'first spawn of this run',
    schema: z.object({ server: text, version: text }),
    format: (d) => `connected to ${d.server} (${d.version})`,
  }),
  'connection.reconnected': def({
    category: 'connection',
    severity: 'notable',
    doc: 'spawned again after a lost connection',
    schema: z.object({ server: text, offlineS: z.number() }),
    format: (d) => `reconnected to ${d.server} after ${durationText(d.offlineS)} offline`,
  }),
  'connection.disconnected': def({
    category: 'connection',
    severity: 'notable',
    doc: 'the session ended and a reconnect is scheduled (kicks have their own kind)',
    schema: z.object({ reason: text, kind: text, sessionS: z.number(), retryInS: z.number().optional() }),
    format: (d) => `disconnected (${d.reason})${d.retryInS !== undefined ? `, retrying in ${durationText(d.retryInS)}` : ''}`,
  }),
  'connection.kicked': def({
    category: 'connection',
    severity: 'alert',
    doc: 'the server sent a disconnect packet',
    schema: z.object({ reason: text, message: text.optional(), willReconnect: z.boolean() }),
    format: (d) => `kicked: ${d.message ?? d.reason}${d.willReconnect ? ' (reconnecting)' : ' (not reconnecting)'}`,
  }),
  'connection.lost': def({
    category: 'connection',
    severity: 'alert',
    doc: 'the session ended for good: a version mismatch, retries used up, reconnect off (the bot leaving on purpose is not recorded)',
    schema: z.object({ reason: text, kind: text }),
    format: (d) => `connection closed for good (${d.reason})`,
  }),
  // ---- life (RespawnController.onEvent) -------------------------------------------------------
  'life.died': def({
    category: 'life',
    severity: 'alert',
    doc: 'the bot died (cause from death_info when the server sent one)',
    schema: z.object({ n: z.number(), cause: text, messages: z.array(text).optional(), at: vec3.optional() }),
    format: (d) => `died (${d.cause.replace(/^death\.attack\./, '')}) at ${xyz(d.at)}`,
  }),
  'life.respawned': def({
    category: 'life',
    severity: 'info',
    doc: 'back alive after a death',
    schema: z.object({ at: vec3 }),
    format: (d) => `respawned at ${xyz(d.at)}`,
  }),
  // ---- combat (skills/combat/combat.ts, tasks/pve.ts, MobTracker.onHit batched) -----------------
  'combat.fight': def({
    category: 'combat',
    severity: 'info',
    doc: 'one fight ended: the damage summary (attacks, hits landed, damage taken, kills)',
    schema: z.object({ mob: text, outcome: text, ticks: z.number(), attacks: z.number(), landed: z.number(), damageTaken: z.number(), kills: z.number() }),
    format: (d) => `fight with a ${d.mob}: ${d.outcome}, ${d.landed}/${d.attacks} hits landed, ${d.damageTaken} damage taken, ${d.kills} kill(s), ${durationText(d.ticks / 20)}`,
  }),
  'combat.kill': def({
    category: 'combat',
    severity: 'info',
    doc: 'a mob the bot fought died',
    schema: z.object({ mob: text }),
    format: (d) => `killed a ${d.mob}`,
  }),
  'combat.flee': def({
    category: 'combat',
    severity: 'notable',
    doc: 'a flight started (low health, a creeper, recovering)',
    schema: z.object({ why: text, from: text, health: z.number() }),
    format: (d) => `fled from a ${d.from} (${d.why}, health ${d.health})`,
  }),
  'combat.damage': def({
    category: 'combat',
    severity: 'info',
    doc: 'damage taken, batched: one event per minute with hits (and before a death)',
    schema: z.object({ hits: z.number(), damage: z.number(), by: counts, periodS: z.number() }),
    format: (d) => `took ${d.damage} damage in ${d.hits} hit(s) (${countsText(d.by)})`,
  }),
  // ---- job (tasks/process/manager.ts: add / finished / remove) -----------------------------------
  'job.started': def({
    category: 'job',
    severity: 'info',
    doc: 'a process that ends (a command, a chore episode, the home return) was added',
    schema: z.object({ job: text, kind: z.enum(['user', 'auto']), line: text, by: text.optional() }),
    format: (d) => `started ${d.job}: ${d.line}${by(d.by)}`,
  }),
  'job.finished': def({
    category: 'job',
    severity: 'info',
    doc: 'a job ended by itself with a good result',
    schema: z.object({ job: text, result: text, durationS: z.number() }),
    format: (d) => `finished ${d.job}: ${d.result} (${durationText(d.durationS)})`,
  }),
  'job.failed': def({
    category: 'job',
    severity: 'notable',
    doc: 'a job ended by itself without its goal, with the reason',
    schema: z.object({ job: text, reason: text, durationS: z.number() }),
    format: (d) => `${d.job} failed: ${d.reason} (${durationText(d.durationS)})`,
  }),
  'job.stopped': def({
    category: 'job',
    severity: 'info',
    doc: 'a job was stopped before it ended (!stop, replaced, a death), and by whom when a command did it',
    schema: z.object({ job: text, reason: text, durationS: z.number(), by: text.optional() }),
    format: (d) => `${d.job} stopped (${d.reason})${by(d.by)} after ${durationText(d.durationS)}`,
  }),
  // ---- items (inventory diffs outside storage containers, batched) -------------------------------
  'items.changed': def({
    category: 'items',
    severity: 'info',
    doc: 'what the inventory gained and lost outside chests, batched: at the end of each job and once a minute',
    schema: z.object({ gained: counts, lost: counts, jobs: z.array(text), periodS: z.number() }),
    format: (d) => `items: +${countsText(d.gained)}; -${countsText(d.lost)}${d.jobs.length ? ` (${d.jobs.join(', ')})` : ''}`,
  }),
  // ---- container (container_open / container_close with the inventory diff between) --------------
  'container.deposit': def({
    category: 'container',
    severity: 'info',
    doc: 'items put into a chest, barrel or shulker box (one event per open)',
    schema: z.object({ at: vec3, block: text.optional(), items: counts }),
    format: (d) => `stored ${countsText(d.items)} in the ${d.block ?? 'container'} at ${xyz(d.at)}`,
  }),
  'container.withdraw': def({
    category: 'container',
    severity: 'info',
    doc: 'items taken out of a chest, barrel or shulker box (one event per open)',
    schema: z.object({ at: vec3, block: text.optional(), items: counts }),
    format: (d) => `took ${countsText(d.items)} from the ${d.block ?? 'container'} at ${xyz(d.at)}`,
  }),
  // ---- home ------------------------------------------------------------------------------------
  'home.arrived': def({
    category: 'home',
    severity: 'info',
    doc: 'the home return (after a fight, at dawn, after a respawn) arrived',
    schema: z.object({ durationS: z.number() }),
    format: (d) => `arrived home (${durationText(d.durationS)})`,
  }),
  // ---- resource (derived from the inventory: events/resources.ts) --------------------------------
  'resource.low': def({
    category: 'resource',
    severity: 'notable',
    doc: 'carried food, a tool class or rockets (with an elytra) ran low; once until it recovers',
    schema: z.object({ resource: z.enum(['food', 'tools', 'fireworks']), left: z.number(), detail: text }),
    format: (d) => `low on ${d.resource}: ${d.detail}`,
  }),
  // ---- command (Chat.onCommand; the panel marks its own) -----------------------------------------
  'command.received': def({
    category: 'command',
    severity: 'info',
    doc: 'an owner command ran (from the game chat, the server console or the panel)',
    schema: z.object({ command: text, text, source: z.enum(['chat', 'console', 'panel']), sender: text }),
    format: (d) => `${d.text} from ${d.sender} (${d.source})`,
  }),
} as const satisfies Record<string, EventDef>;

export type EventKind = keyof typeof EVENT_KINDS;
export type EventData<K extends EventKind> = z.infer<(typeof EVENT_KINDS)[K]['schema']>;
export const EVENT_KIND_NAMES = Object.keys(EVENT_KINDS) as EventKind[];

/** One recorded event (a line of the JSONL files). */
export interface BotEvent<K extends EventKind = EventKind> {
  /** Increasing across restarts (the store resumes after the last stored id). */
  id: number;
  /** Wall-clock ms. */
  ts: number;
  kind: K;
  /** Copied from the registry when recorded (filters keep working if the registry changes). */
  sev: Severity;
  data: EventData<K>;
}

export function isEventKind(k: string): k is EventKind {
  return Object.hasOwn(EVENT_KINDS, k);
}

export function eventDef(k: EventKind): EventDef {
  return EVENT_KINDS[k];
}

/** The timeline line of a recorded event; a kind no longer registered (an old line) shows its name. */
export function formatEvent(e: { kind: string; data: unknown }): string {
  if (!isEventKind(e.kind)) return e.kind;
  try {
    return eventDef(e.kind).format(e.data);
  } catch {
    return e.kind;
  }
}

/** Validate a payload against its kind's schema: undefined when it fits, else the first problem. */
export function checkPayload(kind: EventKind, data: unknown): string | undefined {
  const r = eventDef(kind).schema.safeParse(data);
  if (r.success) return undefined;
  const i = r.error.issues[0];
  return i ? `${i.path.join('.') || '(payload)'}: ${i.message}` : 'invalid';
}

/** Registry metadata (GET /api/events/kinds; the guide's table). */
export function kindList(): { kind: EventKind; category: Category; severity: Severity; doc: string; fields: string[] }[] {
  return EVENT_KIND_NAMES.map((kind) => {
    const d = eventDef(kind);
    const shape = (d.schema as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
    const fields = Object.entries(shape).map(([k, s]) => (s.safeParse(undefined).success ? `${k}?` : k));
    return { kind, category: d.category, severity: d.severity, doc: d.doc, fields };
  });
}

/** The guide's table (docs/events.md between the `events:kinds` markers), generated from the registry. */
export function eventTable(): string {
  const rows = kindList().map((k) => `| \`${k.kind}\` | ${k.severity} | ${k.fields.map((f) => `\`${f}\``).join(' ')} | ${k.doc} |`);
  return ['| kind | severity | fields | when |', '|---|---|---|---|', ...rows].join('\n');
}
