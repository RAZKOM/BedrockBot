// RL resets for the truth pack (PLAN.md task 6.1, section 9 "Reset"). Stable @minecraft/server 2.10.0.
//
//   /scriptevent rl:reset [#id] <scenario> <seed> [origin=<x>,<z>] [tool=<item>] [player=<name>] [verify=1]
//   /scriptevent rl:plan  [#id] <scenario> <seed> [origin=<x>,<z>]       (the plan only, nothing is built)
//   /scriptevent rl:help
//
// reset builds the seeded arena of rl-layout.ts with fillBlocks / setType (no .mcstructure: see
// docs/decisions/0008-rl-bridge.md), removes item entities in the arena, clears the player's
// inventory and armour, puts the tool into hotbar slot 0 and selects it, restores health, teleports
// the player to the start facing the start yaw, sets the time to day and the weather to clear, and
// answers like a truth command:
//
//   @truth {"truth":{"cmd":"rl:reset","id":"..","ok":true,"tick":..,"data":{scenario, seed, origin,
//     box:{min,max}, start, yaw, tool, trees, logs, checksum, buildMs, waitedTicks[, worldChecksum]}}}
//
// `checksum` is the truth:checksum of `box` the plan produces (computed from the plan, not read back);
// with verify=1 the pack also reads the box back over a few ticks and adds `worldChecksum`.
// The player is the named one, else the command's source player, else the only player online.
// When the arena's chunks are not loaded (first reset at a far origin), the player is teleported to
// the start first and the build waits for the chunks (up to 20 s, `waitedTicks`).
import {
  BlockPermutation,
  BlockVolume,
  EntityComponentTypes,
  EquipmentSlot,
  ItemStack,
  Player,
  WeatherType,
  system,
  world,
  type Dimension,
  type EntityEquippableComponent,
  type EntityHealthComponent,
  type EntityInventoryComponent,
  type ScriptEventCommandMessageAfterEvent,
} from '@minecraft/server';
import { Fnv1a, TruthError, encodeReply, int, iterateBox, nsId, parseRequest, box as mkBox, type Reply } from './protocol.js';
import { LEAVES, SCENARIOS, parseOptions, planArena, planChecksum, type ArenaPlan } from './rl-layout.js';

const MAX_LINE = 262144;
/** Give up waiting for the arena chunks after this many ticks. */
const LOAD_WAIT_TICKS = 400;
/** Day time set on every reset (TimeOfDay.Day). */
const DAY = 1000;

let seq = 0;

function send(r: Reply): void {
  const key = `rl${++seq}`;
  for (const line of encodeReply(r, MAX_LINE, key)) world.sendMessage(line);
}

function reply(cmd: string, id: string | null, ok: boolean, data: unknown, reason?: string): void {
  const r: Reply = { cmd: `rl:${cmd}`, id, ok, tick: system.currentTick, data };
  if (!ok) r.reason = reason ?? 'error';
  send(r);
}

function replyError(cmd: string, id: string | null, e: unknown): void {
  if (e instanceof TruthError) {
    reply(cmd, id, false, { message: e.message, ...(e.data && typeof e.data === 'object' ? e.data : {}) }, e.reason);
    return;
  }
  const name = e instanceof Error ? e.name : '';
  const reason = /Unloaded|LocationInUnloadedChunk/.test(name) ? 'unloaded_chunk' : 'error';
  reply(cmd, id, false, { message: String(e instanceof Error ? e.message : e) }, reason);
}

function resolvePlayer(name: string | undefined, ev: ScriptEventCommandMessageAfterEvent): Player {
  if (name !== undefined) {
    const found = world.getPlayers({ name });
    if (found.length === 0) throw new TruthError('player_not_found', `no player named ${name}`, { online: world.getAllPlayers().map((p) => p.name) });
    return found[0]!;
  }
  if (ev.sourceEntity instanceof Player) return ev.sourceEntity;
  const all = world.getAllPlayers();
  if (all.length === 1) return all[0]!;
  if (all.length === 0) throw new TruthError('player_not_found', 'no players online', { online: [] });
  throw new TruthError('player_ambiguous', 'several players online; pass player=<name>', { online: all.map((p) => p.name) });
}

interface Request {
  plan: ArenaPlan;
  checksum: string;
  verify: boolean;
  player?: string;
}

function parse(args: string[]): Request {
  const scenario = args[0];
  if (!scenario || !SCENARIOS[scenario]) throw new TruthError('bad_args', `usage: reset <scenario> <seed> [origin=x,z] [tool=item] [player=name] [verify=1]; scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  const seed = int(args[1], 'seed');
  let opts: Record<string, string>;
  try {
    opts = parseOptions(args.slice(2));
  } catch (e) {
    throw new TruthError('bad_args', String(e instanceof Error ? e.message : e));
  }
  let ox = 0;
  let oz = 0;
  if (opts.origin !== undefined) {
    const [x, z] = opts.origin.split(',');
    ox = int(x, 'origin x');
    oz = int(z, 'origin z');
  }
  const plan = planArena(scenario, seed, ox, oz, opts.tool !== undefined ? nsId(opts.tool) : undefined);
  const req: Request = { plan, checksum: planChecksum(plan), verify: opts.verify === '1' || opts.verify === 'true' };
  if (opts.player !== undefined) req.player = opts.player;
  return req;
}

function loaded(dim: Dimension, plan: ArenaPlan): boolean {
  const { min, max } = plan.box;
  for (let cx = Math.floor(min.x / 16); cx <= Math.floor(max.x / 16); cx++) {
    for (let cz = Math.floor(min.z / 16); cz <= Math.floor(max.z / 16); cz++) {
      if (!dim.isChunkLoaded({ x: Math.max(min.x, cx * 16), y: min.y, z: Math.max(min.z, cz * 16) })) return false;
    }
  }
  return true;
}

let leavesPerm: BlockPermutation | string | undefined;

/** Persistent oak leaves (never decay, so a seed's checksum is stable); plain leaves if the state is unknown. */
function leaves(): BlockPermutation | string {
  if (leavesPerm === undefined) {
    try {
      leavesPerm = BlockPermutation.resolve(LEAVES, { persistent_bit: true });
    } catch {
      leavesPerm = LEAVES;
    }
  }
  return leavesPerm;
}

function build(dim: Dimension, plan: ArenaPlan): void {
  for (const op of plan.ops) {
    const block = op.block === LEAVES ? leaves() : op.block;
    if (op.kind === 'fill') {
      dim.fillBlocks(new BlockVolume(op.from, op.to), block);
    } else {
      const b = dim.getBlock(op.p);
      if (!b) throw new TruthError('unloaded_chunk', `unloaded_chunk at ${op.p.x} ${op.p.y} ${op.p.z}`, { at: op.p });
      if (typeof block === 'string') b.setType(block);
      else b.setPermutation(block);
    }
  }
}

function removeLooseEntities(dim: Dimension, plan: ArenaPlan): number {
  const { min, max } = plan.box;
  const center = { x: (min.x + max.x + 1) / 2, y: (min.y + max.y + 1) / 2, z: (min.z + max.z + 1) / 2 };
  const r = Math.hypot(max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1) / 2 + 1;
  let n = 0;
  for (const type of ['minecraft:item', 'minecraft:xp_orb', 'minecraft:arrow']) {
    for (const e of dim.getEntities({ type, location: center, maxDistance: r })) {
      const l = e.location;
      if (l.x < min.x || l.x > max.x + 1 || l.z < min.z || l.z > max.z + 1) continue;
      try {
        e.remove();
        n++;
      } catch {
        // already gone
      }
    }
  }
  return n;
}

function resetPlayer(p: Player, plan: ArenaPlan): void {
  const inv = p.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined;
  const c = inv?.container;
  if (!c) throw new TruthError('error', `player ${p.name} has no inventory container`);
  c.clearAll();
  const eq = p.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
  if (eq) {
    for (const s of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) {
      if (eq.getEquipment(s)) eq.setEquipment(s, undefined);
    }
  }
  c.setItem(0, toolStack(plan));
  p.selectedSlotIndex = 0;
  (p.getComponent(EntityComponentTypes.Health) as EntityHealthComponent | undefined)?.resetToMaxValue();
  p.teleport(plan.start, { rotation: { x: 0, y: plan.yaw } });
}

function toolStack(plan: ArenaPlan): ItemStack {
  try {
    return new ItemStack(plan.tool, 1);
  } catch (e) {
    throw new TruthError('unknown_item', `unknown item ${plan.tool}: ${String(e)}`, { typeId: plan.tool });
  }
}

function worldChecksum(dim: Dimension, plan: ArenaPlan, done: (hex: string) => void, fail: (e: unknown) => void): void {
  const b = mkBox(plan.box.min, plan.box.max);
  system.runJob(
    (function* () {
      try {
        const h = new Fnv1a();
        let n = 0;
        for (const q of iterateBox(b)) {
          h.update(dim.getBlock(q)?.typeId ?? 'unloaded');
          if (++n % 2048 === 0) yield;
        }
        done(h.hex());
      } catch (e) {
        fail(e);
      }
    })(),
  );
}

function reset(id: string | null, args: string[], ev: ScriptEventCommandMessageAfterEvent): void {
  const req = parse(args);
  const p = resolvePlayer(req.player, ev);
  const dim = world.getDimension('overworld');
  const { plan } = req;
  toolStack(plan); // refuse an unknown tool before touching the world
  const t0 = system.currentTick;
  const finish = () => {
    const ms0 = Date.now();
    build(dim, plan);
    const removed = removeLooseEntities(dim, plan);
    resetPlayer(p, plan);
    world.setTimeOfDay(DAY);
    dim.setWeather(WeatherType.Clear);
    const data: Record<string, unknown> = {
      scenario: plan.scenario,
      seed: plan.seed,
      origin: plan.origin,
      box: plan.box,
      start: plan.start,
      yaw: plan.yaw,
      tool: plan.tool,
      player: p.name,
      trees: plan.trees.length,
      logs: plan.logs,
      checksum: req.checksum,
      removedEntities: removed,
      buildMs: Date.now() - ms0,
      waitedTicks: system.currentTick - t0,
    };
    if (!req.verify) {
      reply('reset', id, true, data);
      return;
    }
    worldChecksum(
      dim,
      plan,
      (hex) => reply('reset', id, true, { ...data, worldChecksum: hex }),
      (e) => replyError('reset', id, e),
    );
  };
  if (loaded(dim, plan)) {
    finish();
    return;
  }
  // Far origin: go there first so the chunks load, then build.
  p.teleport(plan.start, { rotation: { x: 0, y: plan.yaw } });
  const handle = system.runInterval(() => {
    try {
      if (loaded(dim, plan)) {
        system.clearRun(handle);
        finish();
      } else if (system.currentTick - t0 > LOAD_WAIT_TICKS) {
        system.clearRun(handle);
        reply('reset', id, false, { message: `arena chunks not loaded after ${LOAD_WAIT_TICKS} ticks`, box: plan.box }, 'unloaded_chunk');
      }
    } catch (e) {
      system.clearRun(handle);
      replyError('reset', id, e);
    }
  }, 1);
}

function plan(id: string | null, args: string[]): void {
  const req = parse(args);
  const { plan: pl } = req;
  reply('plan', id, true, {
    scenario: pl.scenario,
    seed: pl.seed,
    origin: pl.origin,
    box: pl.box,
    start: pl.start,
    yaw: pl.yaw,
    tool: pl.tool,
    trees: pl.trees,
    logs: pl.logs,
    checksum: req.checksum,
  });
}

system.afterEvents.scriptEventReceive.subscribe(
  (ev) => {
    let cmd = ev.id.slice(ev.id.indexOf(':') + 1);
    let id: string | null = null;
    try {
      const r = parseRequest(ev.id, ev.message);
      cmd = r.cmd;
      id = r.id;
      if (cmd === 'reset') reset(id, r.args, ev);
      else if (cmd === 'plan') plan(id, r.args);
      else if (cmd === 'help') reply('help', id, true, { commands: ['help', 'plan', 'reset'], scenarios: Object.keys(SCENARIOS) });
      else reply(cmd, id, false, { message: `unknown command rl:${cmd}`, commands: ['help', 'plan', 'reset'] }, 'unknown_command');
    } catch (e) {
      replyError(cmd, id, e);
    }
  },
  { namespaces: ['rl'] },
);

export const RL_COMMANDS = ['help', 'plan', 'reset'] as const;
