// The furnace and smelting (Track E2, docs/early-game.md "The iron age", ADR 0099), owner-only like every command:
//   !furnace         a furnace set down where the cooker looks: within 16 blocks of home (the bot walks home first) or
//                    next to the bot without a home; crafted first from 8 cobblestone when none is carried; nothing
//                    placed when one stands there (`furnace: one stands at x y z already`)
//   !furnace status  the furnaces the cooker would use
//   !smelt [item] [n] the raw iron, gold and copper and the sand carried (or n of the item named: `!smelt iron 9`,
//                    `!smelt raw_iron 9`, `!smelt glass 4`) smelted in that furnace with the cooker's fuel rule; the bot
//                    waits by it and takes the ingots out; no furnace there: it places one first, as `!furnace` does
// Also wired here: the food job's cook step after a hunt sets a furnace down when none is near and the `cookFurnace`
// rule allows it (a furnace carried, or crafted from the cobblestone beyond the 16 the night shell keeps; near home
// only when the bot is within 64 of home). Registered by the afk task after the crafter and the obtain job
// (tasks/registry.ts).
import type { Vec3 } from '../connection/types.ts';
import { carried, planChain } from '../skills/craft/chain.ts';
import { foodControllerOf } from './commands-food.ts';
import { craftControlOf } from './commands-craft.ts';
import type { CookResult } from '../skills/food/cook.ts';
import { FURNACE, furnaceReasonText, furnacesCarried, placeFurnace, type FurnaceResult } from '../skills/food/furnace.ts';
import { PLANNED_SMELTS, SMELTS, smeltableCounts, smeltInputsOf } from '../skills/food/smelt.ts';
import { normaliseName } from '../skills/items/catalog.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { HOME_RETURN_NEAR } from '../tasks/process/food.ts';
import { SmeltJob, SmeltProcess, type SmeltDeps, type SmeltJobResult } from '../tasks/process/smelt.ts';
import type { ItemStack } from '../world/types.ts';
import { SmeltShell } from '../tasks/smelt-shell.ts'; // Track E3
import { NightProcess } from '../tasks/process/night.ts'; // Track E3

/** Cobblestone the automatic furnace leaves carried (the night shell's 10 cells and a few pillars: the stone kit's 16). */
export const FURNACE_KEEP_COBBLE = 16;
/** Most items one `!smelt` takes (a furnace's input stack). */
export const MAX_SMELT = 64;

const fmt = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;

/**
 * `!smelt` arguments -> the inputs to smelt and the count (undefined: all carried), or an error. `iron`, `raw_iron`,
 * `iron_ingot` and `iron_ore` all smelt the iron carried (raw first); `glass` and `sand` the sand.
 */
export function parseSmeltArgs(args: readonly string[]): { names: readonly string[] | undefined; label: string; n: number | undefined } | { error: string } {
  const words = args.filter((w) => w !== '');
  let n: number | undefined;
  const num = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
  if (num(words[words.length - 1])) n = Number(words.pop());
  else if (num(words[0])) n = Number(words.shift());
  if (n !== undefined && (n < 1 || n > MAX_SMELT)) return { error: `n is 1..${MAX_SMELT}` };
  if (words.length === 0) return { names: undefined, label: 'everything smeltable', n };
  const w = normaliseName(words.join('_'));
  const metal = /^(raw_)?(iron|gold|copper)(_ingot|_ore)?$/.exec(w.replace(/^deepslate_/, ''));
  const output = metal ? `${metal[2]}_ingot` : w === 'sand' || w === 'red_sand' ? 'glass' : w;
  const inputs = smeltInputsOf(output);
  if (inputs) return { names: inputs, label: output, n };
  if (SMELTS[w]) return { names: [w], label: SMELTS[w], n };
  return { error: `I smelt ${Object.keys(PLANNED_SMELTS).join(', ')} (raw ore or sand carried); food: !cook` };
}

/** The end line of `!furnace`. */
export function furnaceLine(r: SmeltJobResult): string {
  const f = r.furnace;
  if (!f) return `furnace: ${r.reason}`;
  if (!f.ok) return `furnace: ${furnaceReasonText(f.reason, f.detail)}${r.crafted ? ' (one was crafted)' : ''}`;
  if (f.already) return `furnace: one stands at ${fmt(f.pos)} already`;
  return `furnace placed at ${fmt(f.pos)}${f.walked ? ' by home' : ''}${r.crafted ? ' (crafted from 8 cobblestone)' : ''}`;
}

/** The end line of `!smelt`. */
export function smeltLine(r: SmeltJobResult): string {
  const f = r.furnace;
  if (f && !f.ok) return `smelt: ${furnaceReasonText(f.reason, f.detail)}`;
  const placed = f?.ok && !f.already ? `; furnace placed at ${fmt(f.pos)}${r.crafted ? ' (crafted)' : ''}` : '';
  const c: CookResult | undefined = r.cook;
  if (!c) return `smelt: ${r.reason}${placed}`;
  const out = Object.entries(c.cooked).map(([k, v]) => `${v} ${k}`);
  const fuel = Object.entries(c.fuel).map(([k, v]) => `${v} ${k}`);
  const where = c.furnace ? ` in the ${c.block ?? 'furnace'} at ${fmt(c.furnace)}` : '';
  if (c.ok) return `smelted ${out.join(', ') || 'nothing'}${where} (${Math.round(c.ticks / 20)} s${fuel.length ? `, fuel ${fuel.join(', ')}` : ''})${placed}`;
  const why = c.reason === 'no_fuel' ? 'no fuel (coal, charcoal, planks or logs)' : c.reason === 'nothing_to_cook' ? 'nothing to smelt' : c.reason === 'no_furnace' ? 'no furnace within 16 blocks of home' : c.reason.replace(/_/g, ' ');
  return `smelt: ${why}${out.length ? ` (smelted ${out.join(', ')} first)` : ''}${where}${placed}`;
}

/** Inputs carried among `names` (all planned smeltables without names). */
function inputsFor(names: readonly string[] | undefined): (slots: readonly (ItemStack | null)[]) => Map<string, number> {
  return (slots) => {
    if (!names) return smeltableCounts(slots);
    const out = new Map<string, number>();
    for (let i = 0; i < Math.min(slots.length, 36); i++) {
      const s = slots[i];
      if (s && s.count > 0 && names.includes(s.name)) out.set(s.name, (out.get(s.name) ?? 0) + s.count);
    }
    // the raw metal first (the order of `names`)
    return new Map([...out].sort((a, b) => names.indexOf(a[0]) - names.indexOf(b[0])));
  };
}

export interface SmeltControl {
  /** The furnaces where the cooker looks (16 of home, else of the bot). */
  furnaces(): Vec3[];
  /** Start `!furnace` / `!smelt` as a process. */
  start(kind: 'furnace' | 'smelt', names?: readonly string[], n?: number): SmeltProcess;
}

const controls = new WeakMap<object, SmeltControl>();

/** The smelt control of a task (the obtain job, tests). */
export function smeltControlOf(task: object): SmeltControl | undefined {
  return controls.get(task);
}

/** Register `!furnace` and `!smelt` (tasks/registry.ts, after the crafter and the food commands). */
export function registerSmeltCommands(d: CommandDeps): SmeltControl | undefined {
  const food = foodControllerOf(d.task);
  const craft = craftControlOf(d.task);
  const { processes, skills, world, mobility, pve } = d;
  if (!food || !craft || !processes || !skills || !world || !mobility || !pve) {
    for (const name of ['furnace', 'smelt']) d.chat.register({ name, help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking(name)) });
    return undefined;
  }
  const log = d.log;
  const cooker = food.d.cooker;
  const home = (): Vec3 | undefined => d.task.home?.get();
  const mover = settingsMover(skills, d.settings);
  const furnaces = (): Vec3[] => cooker.furnaces(16).filter((p) => (world.blockAt(p)?.name ?? FURNACE).replace(/^lit_/, '') === FURNACE);
  const place = (cancelled: () => boolean): Promise<FurnaceResult> =>
    placeFurnace({ world, loop: mobility.loop, skills: { place: (p, o) => skills.place(p, o), dig: (p) => skills.dig(p), goto: (g, o) => mover.goto(g, o) }, home, furnaces, log }, cancelled);
  /** One furnace crafted from what is carried, its chain first (planks, the table); `keep` cobblestone left over. */
  const make = async (cancelled: () => boolean, keep = 0): Promise<boolean> => {
    const slots = world.inventory.slots;
    const base = craft.chainOptions();
    const reserve = (n: string): number => (base.reserve?.(n) ?? 0) + (n === 'cobblestone' ? keep : 0);
    const plan = planChain(craft.recipes, [{ item: FURNACE, n: carried(slots, FURNACE) + 1 }], slots, { ...base, reserve });
    if (plan.missing.length > 0) {
      log.info(`furnace: none carried and none craftable (${plan.missing.map((m) => `${m.n} ${m.item}`).join(', ')} missing${keep ? `, ${keep} cobblestone kept` : ''})`);
      return false;
    }
    for (const s of plan.steps) {
      if (cancelled()) return false;
      const r = await craft.crafter.craft(s.item, s.n, cancelled);
      if (r.crafted < s.n) {
        log.info(`furnace: crafting ${s.n} ${s.item} made ${r.crafted} (${r.reason})`);
        return false;
      }
    }
    return furnacesCarried(world.inventory.slots) > 0;
  };
  const deps = (keep: number): SmeltDeps => ({
    cooker,
    placeFurnace: place,
    makeFurnace: (c) => make(c, keep),
    furnacesCarried: () => furnacesCarried(world.inventory.slots),
    slots: () => world.inventory.slots,
    cancel: () => {
      if (pve.mover.nav.busy) pve.mover.cancel();
      skills.cancel();
    },
    makeShell: () => shell(),
    log,
  });
  // Track E3: the smelt shell (smeltShell): the clock from the night process, the seal from PvE
  const shell = (): SmeltShell =>
    new SmeltShell({
      enabled: () => d.settings.get('smeltShell'),
      deps: () => pve.sealDeps(),
      time: () => processes.find('night').find((x): x is NightProcess => x instanceof NightProcess)?.timeOfDay(),
      shelters: () => [d.task.shelter?.get(), d.task.home?.get()].filter((v): v is Vec3 => v !== undefined),
      walkTo: async (cell, cancelled) => {
        const r = await mover.goto({ type: 'block', p: cell }, { timeoutTicks: 400 });
        return !cancelled() && r.ok;
      },
      blockAt: (q) => world.blockAt(q),
      log,
    });
  const control: SmeltControl = {
    furnaces,
    start: (kind, names, n) => processes.add(new SmeltProcess(deps(0), new SmeltJob({ kind, ...(kind === 'smelt' ? { inputs: inputsFor(names) } : {}), ...(n !== undefined ? { limit: n } : {}) }))),
  };
  controls.set(d.task, control);

  // the food job's cook step (after a hunt, or the owner's !cook): a furnace where none is, when the rule allows it
  food.d.ensureFurnace = async (cancelled, typed) => {
    if (!d.settings.get('cookFurnace')) return false;
    if ((!typed && cooker.furnaces(32, true).length > 0) || furnaces().length > 0) return true;
    const h = home();
    const me = mobility.loop.state.pos;
    if (!typed && h && Math.hypot(h.x - me.x, h.z - me.z) > HOME_RETURN_NEAR) return false; // a hunt far from home: the raw food is kept
    const job = new SmeltJob({ kind: 'furnace' });
    await job.run(deps(typed ? 0 : FURNACE_KEEP_COBBLE), cancelled);
    const r = job.result();
    log.info(`food: ${furnaceLine(r)}`);
    return r.ok;
  };
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    food.d.ensureFurnace = undefined;
    stop();
  };

  d.chat.register({
    name: 'furnace',
    group: 'work',
    example: '!furnace',
    auto: 'the cooker sets one down when raw food waits and none stands near (cookFurnace); !get furnace and !get kit iron run it as a step',
    help: '[status] (set a furnace down where I cook and smelt: within 16 blocks of home, or here without a home; crafted from 8 cobblestone when I carry none)',
    run: ({ args, reply }) => {
      const a = (args[0] ?? '').toLowerCase();
      if (a === 'status') {
        const list = furnaces();
        reply(list.length ? `furnace: ${list.length} where I cook (${list.slice(0, 4).map(fmt).join(', ')})${home() ? ' within 16 of home' : ' within 16 of me'}` : `furnace: none within 16 blocks of ${home() ? 'home' : 'me'}; ${furnacesCarried(world.inventory.slots)} carried`);
        return;
      }
      if (args.length > 0) return reply('usage: !furnace [status]');
      const there = furnaces()[0];
      if (there) return reply(`furnace: one stands at ${fmt(there)} already`);
      reply(`furnace: ${furnacesCarried(world.inventory.slots) > 0 ? 'placing the one I carry' : 'crafting one from 8 cobblestone'}${home() ? ' by home' : ' here'}${processes.paused ? ' (held: !resume)' : ''}`);
      void control.start('furnace').result.then((r) => reply(furnaceLine(r)));
    },
  });

  d.chat.register({
    name: 'smelt',
    group: 'work',
    example: '!smelt iron 9',
    auto: '!get iron_ingot, !get iron_pickaxe and !get kit iron run it as a step',
    help: '[item] [n] (smelt the raw iron, gold, copper or sand I carry, or n of one, in the furnace where I cook; one is set down first when none stands there; I wait by it)',
    run: ({ args, reply }) => {
      const p = parseSmeltArgs(args);
      if ('error' in p) return reply(`usage: !smelt [item] [n] (${p.error})`);
      const have = inputsFor(p.names)(world.inventory.slots);
      const total = [...have.values()].reduce((a, b) => a + b, 0);
      if (total === 0) return reply(`smelt: nothing to smelt (${p.names ? `no ${p.names.join(' or ')} carried` : 'no raw iron, gold, copper or sand carried'})`);
      const n = Math.min(p.n ?? total, total, MAX_SMELT);
      const there = furnaces()[0];
      reply(`smelting ${n} ${[...have.keys()].join(', ')}${there ? ` in the furnace at ${fmt(there)}` : '; setting a furnace down first'}${processes.paused ? ' (held: !resume)' : ''}`);
      void control.start('smelt', p.names ? [...have.keys()] : undefined, n).result.then((r) => reply(smeltLine(r)));
    },
  });
  return control;
}
