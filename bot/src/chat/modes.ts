// `!mode careful | normal | bold | status` (wave 9, Track AM; docs/ux.md "Modes", decision 0034):
// bundles over existing runtime settings, applied through the same RuntimeSettings as `!set` (live,
// persisted to settings.json; `!set <key>` still changes one key afterwards). A key a mode leaves at
// its default is reset (removed from settings.json) rather than written.
//
// Also the afk task's UX wiring (registerUxCommands, one entry in tasks/registry.ts): `!mode`, the
// settings `!help settings` shows, the next-step hints (help.ts hintFor) and the welcome whisper.
import { formatSettingValue, SETTING_DEFS, type RuntimeSettings, type SettingKey } from '../config/settings.ts';
import { findCookers, rawFoodCounts } from '../skills/food/finder.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { registerStyleCommands } from './commands-style.ts';
import { hintFor } from './help.ts';
import { attachWelcome } from './welcome.ts';

export type ModeName = 'careful' | 'normal' | 'bold';
export const MODE_NAMES: readonly ModeName[] = ['careful', 'normal', 'bold'];

/** The keys the modes set (a mode leaves a key it does not name at the default). */
export const MODE_KEYS = ['fleeHealth', 'guardRadius', 'avoidMobRadius', 'avoidSpawnerRadius', 'allowBreak', 'allowPlace'] as const satisfies readonly SettingKey[];
export type ModeKey = (typeof MODE_KEYS)[number];
type ModeValues = Partial<Record<ModeKey, boolean | number>>;

/** What each mode changes from the defaults (docs/ux.md has the table). */
export const MODE_CHANGES: Record<ModeName, ModeValues> = {
  careful: { fleeHealth: 12, guardRadius: 8, avoidMobRadius: 8, avoidSpawnerRadius: 16, allowBreak: false },
  normal: {},
  bold: { fleeHealth: 6, guardRadius: 24, avoidMobRadius: 3, allowBreak: true, allowPlace: true },
};

/** Every MODE_KEYS value of a mode (defaults where it names none). */
export function modeValues(mode: ModeName): Record<ModeKey, boolean | number> {
  const out = {} as Record<ModeKey, boolean | number>;
  for (const k of MODE_KEYS) out[k] = MODE_CHANGES[mode][k] ?? SETTING_DEFS[k].default;
  return out;
}

type Getter = Pick<RuntimeSettings, 'get'>;

/** The keys where the current settings differ from `mode`. */
export function modeDiff(s: Getter, mode: ModeName): ModeKey[] {
  const want = modeValues(mode);
  return MODE_KEYS.filter((k) => s.get(k) !== want[k]);
}

/** The matching mode, else `custom` with the nearest mode and the keys that differ from it. */
export function currentMode(s: Getter): { mode: ModeName } | { mode: 'custom'; nearest: ModeName; differ: ModeKey[] } {
  let best: { nearest: ModeName; differ: ModeKey[] } | undefined;
  for (const m of MODE_NAMES) {
    const d = modeDiff(s, m);
    if (d.length === 0) return { mode: m };
    if (!best || d.length < best.differ.length) best = { nearest: m, differ: d };
  }
  return { mode: 'custom', ...best! };
}

const show = (k: ModeKey, v: boolean | number | string): string => `${k} ${formatSettingValue(k, v)}`;

/** `careful` / `custom (normal but fleeHealth 9)`. */
export function modeLine(s: Getter): string {
  const c = currentMode(s);
  if (c.mode !== 'custom') return c.mode;
  const want = modeValues(c.nearest);
  return `custom (${c.nearest} but ${c.differ.map((k) => `${show(k, s.get(k))} instead of ${formatSettingValue(k, want[k])}`).join(', ')})`;
}

/** Apply a mode: every MODE_KEYS key set (or reset when the mode wants the default). Returns the reply. */
export function applyMode(s: RuntimeSettings, mode: ModeName): string {
  const was = modeLine(s);
  const want = modeValues(mode);
  for (const k of MODE_KEYS) {
    if (want[k] === SETTING_DEFS[k].default) s.reset(k);
    else s.set(k, want[k]);
  }
  return `mode ${mode}: ${MODE_KEYS.map((k) => show(k, s.get(k))).join(', ')} (was ${was})${s.file ? '' : ', not saved (no settings file)'}`;
}

/** `!mode careful | normal | bold | status`. */
export function modeCommand(s: RuntimeSettings, args: readonly string[], prefix = '!'): string {
  const a = (args[0] ?? 'status').toLowerCase();
  if (a === 'status') return `mode ${modeLine(s)} (${prefix}mode careful|normal|bold; ${prefix}help settings lists every setting)`;
  if ((MODE_NAMES as readonly string[]).includes(a)) return applyMode(s, a as ModeName);
  return `usage: ${prefix}mode careful | normal | bold | status`;
}

/** The afk task's UX pieces (tasks/registry.ts, after every other registration). */
export function registerUxCommands(d: CommandDeps): void {
  const { chat, settings } = d;
  chat.register({
    name: 'mode', // Track AM
    help: 'careful | normal | bold | status (several safety settings at once; status: which one matches)',
    tier: 'more',
    group: 'control',
    example: '!mode careful',
    run: ({ args, reply }) => {
      reply(modeCommand(settings, args, chat.prefix));
    },
  });
  chat.helpSettings = { get: (k) => settings.get(k), mode: () => modeLine(settings) };
  // chat style (docs/chat-style.md): the two switches are read live on every message; `!colors` demos them
  chat.styleSource = { color: () => settings.get('chatColor'), lines: () => settings.get('chatLines'), via: () => settings.get('chatVia') };
  registerStyleCommands(chat);
  const world = d.world;
  // the End credits: no /me, /say or /tellraw until the server moves the bot out of the exit portal (world/credits.ts)
  chat.slashHold = world ? () => world.credits.showing : undefined;
  chat.hinter = (m) =>
    hintFor(
      m,
      {
        get freeSlots() {
          return world ? world.inventory.slots.slice(0, 36).filter((x) => !x || x.count <= 0).length : 36;
        },
        get rawFood() {
          return world ? [...rawFoodCounts(world.inventory.slots).values()].reduce((a, b) => a + b, 0) : 0;
        },
        get furnaceNearHome() {
          const at = d.task.home?.get() ?? d.position();
          return !world || !at ? true : findCookers(world, at, 16).length > 0;
        },
        get hasUnload() {
          return chat.has('unload');
        },
      },
      chat.prefix,
    );
  const offWelcome = attachWelcome({ chat, conn: d.conn, settings, log: d.log });
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    offWelcome();
    chat.hinter = undefined;
    chat.styleSource = undefined;
    chat.slashHold = undefined;
    stop();
  };
}
