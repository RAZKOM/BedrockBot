// Truth pack: ground truth and world control for tests and RL resets.
// Stable @minecraft/server 2.10.0 only. Protocol: see ../README.md.
import {
  BlockVolume,
  Dimension,
  EntityComponentTypes,
  EquipmentSlot,
  ItemStack,
  LocationInUnloadedChunkError,
  LocationOutOfWorldBoundariesError,
  Player,
  ScriptEventCommandMessageAfterEvent,
  StructureMirrorAxis,
  StructureRotation,
  StructureSaveMode,
  UnloadedChunksError,
  system,
  world,
  type Block,
  type EntityEquippableComponent,
  type EntityHealthComponent,
  type EntityInventoryComponent,
} from '@minecraft/server';
import {
  Fnv1a,
  RleEncoder,
  TruthError,
  blockPos,
  box,
  encodeReply,
  exactPos,
  int,
  num,
  iterateBox,
  nsId,
  parseRequest,
  structureId,
  type Box,
  type Reply,
  type Vec3,
} from './protocol.js';
import './rl.js'; // rl:* commands (RL resets, PLAN.md 6.1), own scriptevent namespace
import { woodHandlers } from './wood.js'; // truth:container, truth:tree, truth:find (Phase 4, Track H)
import { actEvents, actHandlers } from './act.js'; // truth:setblock, truth:door + place/interact events (7.3, Track O)
import { pveHandlers } from './pve.js'; // truth:summon, mobs, entity, sethealth, hurtlog, ... (Phase 7, PvE)
import { survHandlers } from './surv.js'; // Track S: truth:food, setfood, givedamaged, durability, unequip, items, uselog (7.11)
import { farmHandlers } from './farm.js'; // Track U: truth:field, truth:crops (7.13 farming)
import { foodHandlers } from './food.js'; // Track X: truth:furnace, setfurnace, herd, pen (7.16 food)
import { combatHandlers } from './combat.js'; // Track V: truth:combatlog, truth:held (wave 7 combat)
import { paletteHandlers } from './palette.js'; // Track AC: truth:palette (block states dump, wave 8)
import { gauntHandlers } from './gaunt.js'; // Track W: truth:bed, truth:sleeping (survival policy, sleeping)
import { getHandlers } from './get.js'; // Track AD: truth:stuff, getinv, boxitems (!get, stash)
import { buildHandlers } from './build.js'; // Track AL: truth:blocksdiff (builder)
import { homeHandlers } from './home.js'; // Track AG: truth:chestput (home logistics)
import { shieldHandlers } from './shield.js'; // Track AH: truth:stance, blocklog (shield, wave 9)
import { netherHandlers } from './nether.js'; // Track AT: truth:dimension, dimtp, dblock, dset, dfill, dfind, portal (wave 10)
import { flyHandlers } from './fly.js'; // Track AU: truth:glide, glidelog, equip, boxdrop (Elytra flight, wave 11)
import { craftHandlers } from './craft.js'; // Track AW: truth:kit, craftinv, table (crafting, wave 11)
import { courseHandlers } from './course.js'; // Track F4a: truth:course (the flight benchmark's obstacle courses)
import { caveHandlers } from './cave.js'; // Track F5a: truth:cave (a real cave rebuilt from the bot's world cache)

declare const __PACK_VERSION__: string;
/** QuickJS console (prints to the BDS content log). */
declare const console: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
const PACK_VERSION = __PACK_VERSION__;
const API_VERSION = '2.10.0';

/** Max blocks for `blocks` (answered in the same tick). */
const MAX_BLOCKS = 4096;
/** Max blocks for `checksum` and `fill` (run as a system.runJob, a few thousand blocks per tick). */
const MAX_JOB_VOLUME = 1 << 20;
/** fill splits into sub-volumes of at most this many blocks, one fillBlocks call per job step. */
const FILL_SLAB = 32768;
/** checksum yields to the scheduler every this many blocks. */
const CHECKSUM_STEP = 1024;
/** Longest chat line we send; longer replies are fragmented (see encodeReply). BDS 1.26.51 delivered
 * 500 kB text packets to bedrock-protocol intact, so 256 KiB leaves headroom and blocks (max 4096) always fits. */
const MAX_LINE = 262144;

let replySeq = 0;

function send(reply: Reply): void {
  const key = `r${++replySeq}`;
  for (const line of encodeReply(reply, MAX_LINE, key)) world.sendMessage(line);
}

function reply(cmd: string, id: string | null, ok: boolean, data: unknown, reason?: string): void {
  const r: Reply = { cmd, id, ok, tick: system.currentTick, data };
  if (!ok) r.reason = reason ?? 'error';
  send(r);
}

function replyError(cmd: string, id: string | null, e: unknown): void {
  if (e instanceof TruthError) {
    reply(cmd, id, false, { message: e.message, ...(e.data && typeof e.data === 'object' ? e.data : {}) }, e.reason);
    return;
  }
  const reason = classify(e);
  reply(cmd, id, false, { message: String(e instanceof Error ? e.message : e) }, reason);
}

function classify(e: unknown): string {
  if (e instanceof LocationInUnloadedChunkError || e instanceof UnloadedChunksError) return 'unloaded_chunk';
  if (e instanceof LocationOutOfWorldBoundariesError) return 'out_of_bounds';
  return 'error';
}

const overworld = (): Dimension => world.getDimension('overworld');

// ---------------------------------------------------------------- world access guards

function assertInHeight(dim: Dimension, b: Box): void {
  const hr = dim.heightRange; // min inclusive, max exclusive
  if (b.min.y < hr.min || b.max.y >= hr.max) {
    throw new TruthError('out_of_bounds', `y must be in [${hr.min}, ${hr.max - 1}]`, { minY: hr.min, maxY: hr.max - 1 });
  }
}

/** Throws unloaded_chunk if any chunk column touched by the box is not loaded. */
function assertLoaded(dim: Dimension, b: Box): void {
  assertInHeight(dim, b);
  const cx0 = Math.floor(b.min.x / 16);
  const cx1 = Math.floor(b.max.x / 16);
  const cz0 = Math.floor(b.min.z / 16);
  const cz1 = Math.floor(b.max.z / 16);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const at = { x: Math.max(b.min.x, cx * 16), y: b.min.y, z: Math.max(b.min.z, cz * 16) };
      if (!dim.isChunkLoaded(at)) {
        throw new TruthError('unloaded_chunk', `chunk ${cx},${cz} is not loaded`, { chunk: [cx, cz], at });
      }
    }
  }
}

function getBlock(dim: Dimension, p: Vec3): Block {
  let b: Block | undefined;
  try {
    b = dim.getBlock(p);
  } catch (e) {
    const reason = classify(e);
    if (reason !== 'error') throw new TruthError(reason, `${reason} at ${p.x} ${p.y} ${p.z}`, { at: p });
    throw e;
  }
  if (!b) throw new TruthError('unloaded_chunk', `unloaded_chunk at ${p.x} ${p.y} ${p.z}`, { at: p });
  return b;
}

function volumeLimit(b: Box, max: number): void {
  if (b.volume > max) throw new TruthError('volume_too_large', `volume ${b.volume} > ${max}`, { volume: b.volume, max });
}

// ---------------------------------------------------------------- players

function playerByName(name: string): Player {
  const found = world.getPlayers({ name });
  if (found.length === 0) {
    throw new TruthError('player_not_found', `no player named ${name}`, { online: world.getAllPlayers().map((p) => p.name) });
  }
  return found[0]!;
}

/** Named player, else the command's source player, else the only player online. */
function resolvePlayer(name: string | undefined, ev: ScriptEventCommandMessageAfterEvent): Player {
  if (name !== undefined) return playerByName(name);
  if (ev.sourceEntity instanceof Player) return ev.sourceEntity;
  const all = world.getAllPlayers();
  if (all.length === 1) return all[0]!;
  if (all.length === 0) throw new TruthError('player_not_found', 'no players online', { online: [] });
  throw new TruthError('player_ambiguous', 'several players online; pass a name', { online: all.map((p) => p.name) });
}

function requireName(args: string[], i: number): string {
  const n = args[i];
  if (n === undefined) throw new TruthError('bad_args', 'missing playerName');
  return n;
}

function container(p: Player) {
  const inv = p.getComponent(EntityComponentTypes.Inventory) as EntityInventoryComponent | undefined;
  const c = inv?.container;
  if (!c) throw new TruthError('error', `player ${p.name} has no inventory container`);
  return c;
}

const ARMOR_SLOTS = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand];

function equippable(p: Player): EntityEquippableComponent | undefined {
  return p.getComponent(EntityComponentTypes.Equippable) as EntityEquippableComponent | undefined;
}

function vec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function playerState(p: Player) {
  const rot = p.getRotation();
  const health = p.getComponent(EntityComponentTypes.Health) as EntityHealthComponent | undefined;
  return {
    name: p.name,
    entityId: p.id,
    dimension: p.dimension.id,
    location: vec(p.location),
    isOnGround: p.isOnGround,
    velocity: vec(p.getVelocity()),
    rotation: { pitch: rot.x, yaw: rot.y },
    health: health?.currentValue ?? null,
    gameMode: p.getGameMode(),
    selectedSlot: p.selectedSlotIndex,
    tick: system.currentTick,
  };
}

/** Splits `amount` of `typeId` into ItemStacks of at most maxAmount each. */
function stacks(typeId: string, amount: number): ItemStack[] {
  if (!Number.isInteger(amount) || amount < 1) throw new TruthError('bad_args', `amount must be a positive integer: ${amount}`);
  if (amount > 64 * 64) throw new TruthError('bad_args', `amount too large: ${amount}`);
  let probe: ItemStack;
  try {
    probe = new ItemStack(typeId, 1);
  } catch (e) {
    throw new TruthError('unknown_item', `unknown item ${typeId}: ${String(e)}`, { typeId });
  }
  const max = probe.maxAmount;
  const out: ItemStack[] = [];
  for (let left = amount; left > 0; left -= max) out.push(new ItemStack(typeId, Math.min(max, left)));
  return out;
}

// ---------------------------------------------------------------- commands

type Handler = (args: string[], ctx: Ctx) => unknown;

interface Ctx {
  cmd: string;
  id: string | null;
  ev: ScriptEventCommandMessageAfterEvent;
  /** Set when the handler finishes asynchronously and will reply itself. */
  async: boolean;
}

const TIME_NAMES: Record<string, number> = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 };
const ROTATIONS: Record<string, StructureRotation> = {
  '0': StructureRotation.None,
  '90': StructureRotation.Rotate90,
  '180': StructureRotation.Rotate180,
  '270': StructureRotation.Rotate270,
};
const MIRRORS: Record<string, StructureMirrorAxis> = {
  none: StructureMirrorAxis.None,
  x: StructureMirrorAxis.X,
  z: StructureMirrorAxis.Z,
  xz: StructureMirrorAxis.XZ,
};

const handlers: Record<string, Handler> = {
  ping(args) {
    return {
      pong: true,
      pack: PACK_VERSION,
      api: API_VERSION,
      tick: system.currentTick,
      players: world.getAllPlayers().map((p) => p.name),
      echo: args,
    };
  },

  help() {
    return { commands: Object.keys(handlers).sort() };
  },

  block(args) {
    const p = blockPos(args, 0);
    const dim = overworld();
    assertInHeight(dim, box(p, p));
    const b = getBlock(dim, p);
    return { ...p, typeId: b.typeId, states: b.permutation.getAllStates() };
  },

  blocks(args) {
    const b = box(blockPos(args, 0), blockPos(args, 3));
    volumeLimit(b, MAX_BLOCKS);
    const dim = overworld();
    assertLoaded(dim, b);
    const rle = new RleEncoder();
    for (const p of iterateBox(b)) rle.push(getBlock(dim, p).typeId);
    return { from: b.min, to: b.max, size: b.size, order: 'yzx', palette: rle.palette, runs: rle.runs };
  },

  set(args) {
    const p = blockPos(args, 0);
    const typeId = args[3];
    if (!typeId) throw new TruthError('bad_args', 'usage: set x y z typeId');
    const dim = overworld();
    assertInHeight(dim, box(p, p));
    const b = getBlock(dim, p);
    b.setType(nsId(typeId));
    return { ...p, typeId: b.typeId };
  },

  fill(args, ctx) {
    const b = box(blockPos(args, 0), blockPos(args, 3));
    const typeId = args[6];
    if (!typeId) throw new TruthError('bad_args', 'usage: fill x1 y1 z1 x2 y2 z2 typeId');
    volumeLimit(b, MAX_JOB_VOLUME);
    const dim = overworld();
    assertLoaded(dim, b);
    const id = nsId(typeId);
    // y-slabs of at most FILL_SLAB blocks
    const layer = b.size.x * b.size.z;
    const slabH = Math.max(1, Math.floor(FILL_SLAB / layer));
    const fillSlab = (y0: number): number => {
      const y1 = Math.min(b.max.y, y0 + slabH - 1);
      if (layer <= FILL_SLAB) {
        dim.fillBlocks(blockVolume({ ...b.min, y: y0 }, { ...b.max, y: y1 }), id);
      } else {
        // a single layer is larger than FILL_SLAB: split along z as well
        const rows = Math.max(1, Math.floor(FILL_SLAB / b.size.x));
        for (let z0 = b.min.z; z0 <= b.max.z; z0 += rows) {
          const z1 = Math.min(b.max.z, z0 + rows - 1);
          dim.fillBlocks(blockVolume({ x: b.min.x, y: y0, z: z0 }, { x: b.max.x, y: y1, z: z1 }), id);
        }
      }
      return y1;
    };
    const result = { from: b.min, to: b.max, volume: b.volume, typeId: id };
    if (b.volume <= FILL_SLAB) {
      dim.fillBlocks(blockVolume(b.min, b.max), id);
      return result;
    }
    ctx.async = true;
    const { cmd, id: reqId } = ctx;
    system.runJob(
      (function* () {
        try {
          for (let y = b.min.y; y <= b.max.y; ) {
            y = fillSlab(y) + 1;
            yield;
          }
          reply(cmd, reqId, true, result);
        } catch (e) {
          replyError(cmd, reqId, e);
        }
      })(),
    );
    return undefined;
  },

  checksum(args, ctx) {
    const b = box(blockPos(args, 0), blockPos(args, 3));
    volumeLimit(b, MAX_JOB_VOLUME);
    const dim = overworld();
    assertLoaded(dim, b);
    ctx.async = true;
    const { cmd, id } = ctx;
    const startTick = system.currentTick;
    system.runJob(
      (function* () {
        try {
          const h = new Fnv1a();
          let n = 0;
          for (const p of iterateBox(b)) {
            h.update(getBlock(dim, p).typeId);
            if (++n % CHECKSUM_STEP === 0) yield;
          }
          reply(cmd, id, true, {
            from: b.min,
            to: b.max,
            size: b.size,
            count: n,
            order: 'yzx',
            algo: 'fnv1a32',
            hash: h.hex(),
            ticks: system.currentTick - startTick,
          });
        } catch (e) {
          replyError(cmd, id, e);
        }
      })(),
    );
    return undefined;
  },

  pos(args, ctx) {
    return playerState(resolvePlayer(args[0], ctx.ev));
  },

  inv(args, ctx) {
    const p = resolvePlayer(args[0], ctx.ev);
    const c = container(p);
    const slots: ({ slot: number; typeId: string; amount: number } | null)[] = [];
    const counts: Record<string, number> = {};
    for (let i = 0; i < c.size; i++) {
      const it = c.getItem(i);
      if (it) {
        slots.push({ slot: i, typeId: it.typeId, amount: it.amount });
        counts[it.typeId] = (counts[it.typeId] ?? 0) + it.amount;
      } else {
        slots.push(null);
      }
    }
    const equipment: Record<string, { typeId: string; amount: number }> = {};
    const eq = equippable(p);
    if (eq) {
      for (const s of ARMOR_SLOTS) {
        const it = eq.getEquipment(s);
        if (it) equipment[s] = { typeId: it.typeId, amount: it.amount };
      }
    }
    return { name: p.name, selectedSlot: p.selectedSlotIndex, size: c.size, slots, counts, equipment };
  },

  give(args) {
    const p = playerByName(requireName(args, 0));
    const typeId = args[1];
    if (!typeId) throw new TruthError('bad_args', 'usage: give playerName typeId [amount]');
    const amount = args[2] === undefined ? 1 : int(args[2], 'amount');
    const id = nsId(typeId);
    const c = container(p);
    let given = 0;
    let leftover = 0;
    for (const st of stacks(id, amount)) {
      const want = st.amount;
      const rest = c.addItem(st);
      const left = rest?.amount ?? 0;
      given += want - left;
      leftover += left;
    }
    if (leftover > 0) throw new TruthError('inventory_full', `${leftover} ${id} did not fit`, { typeId: id, given, leftover });
    return { name: p.name, typeId: id, given };
  },

  clear(args) {
    const p = playerByName(requireName(args, 0));
    const c = container(p);
    let removed = 0;
    for (let i = 0; i < c.size; i++) removed += c.getItem(i)?.amount ?? 0;
    c.clearAll();
    const eq = equippable(p);
    if (eq) {
      for (const s of ARMOR_SLOTS) {
        const it = eq.getEquipment(s);
        if (it) {
          removed += it.amount;
          eq.setEquipment(s, undefined);
        }
      }
    }
    return { name: p.name, removed };
  },

  tp(args) {
    const p = playerByName(requireName(args, 0));
    const to = exactPos(args, 1);
    const yaw = args[4];
    const pitch = args[5];
    const rotation = yaw !== undefined ? { x: pitch !== undefined ? num(pitch, 'pitch') : 0, y: num(yaw, 'yaw') } : undefined;
    p.teleport(to, rotation ? { rotation } : undefined);
    return { name: p.name, to, rotation: rotation ? { pitch: rotation.x, yaw: rotation.y } : null };
  },

  time(args) {
    const a = args[0];
    if (a !== undefined) {
      const t = TIME_NAMES[a.toLowerCase()] ?? int(a, 'ticks');
      world.setTimeOfDay(((t % 24000) + 24000) % 24000);
    }
    return { timeOfDay: world.getTimeOfDay(), day: world.getDay(), absoluteTime: world.getAbsoluteTime() };
  },

  kill(args) {
    const p = playerByName(requireName(args, 0));
    return { name: p.name, killed: p.kill() };
  },

  spawnitem(args) {
    const at = exactPos(args, 0);
    const typeId = args[3];
    if (!typeId) throw new TruthError('bad_args', 'usage: spawnitem x y z typeId [amount]');
    const amount = args[4] === undefined ? 1 : int(args[4], 'amount');
    const dim = overworld();
    const bp = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
    assertLoaded(dim, box(bp, bp));
    const entities = stacks(nsId(typeId), amount).map((st) => {
      const e = dim.spawnItem(st, at);
      return { entityId: e.id, amount: st.amount, location: vec(e.location) };
    });
    return { typeId: nsId(typeId), amount, entities };
  },

  place(args) {
    const name = args[0];
    if (!name) throw new TruthError('bad_args', 'usage: place structureName x y z [0|90|180|270] [none|x|z|xz]');
    const at = blockPos(args, 1);
    const sid = structureId(name);
    const sm = world.structureManager;
    const s = sm.get(sid);
    if (!s) {
      throw new TruthError('unknown_structure', `no structure ${sid}`, {
        structure: sid,
        pack: sm.getPackStructureIds(),
        world: sm.getWorldStructureIds(),
      });
    }
    const rotKey = args[4] ?? '0';
    const mirKey = (args[5] ?? 'none').toLowerCase();
    const rotation = ROTATIONS[rotKey];
    const mirror = MIRRORS[mirKey];
    if (!rotation || !mirror) throw new TruthError('bad_args', `bad rotation ${rotKey} or mirror ${mirKey}`);
    const size = vec(s.size);
    const dim = overworld();
    const quarter = rotation === StructureRotation.Rotate90 || rotation === StructureRotation.Rotate270;
    const ext = quarter ? { x: size.z, y: size.y, z: size.x } : size;
    const b = box(at, { x: at.x + ext.x - 1, y: at.y + ext.y - 1, z: at.z + ext.z - 1 });
    assertLoaded(dim, b);
    sm.place(s, dim, at, { rotation, mirror, includeEntities: false });
    return { structure: sid, from: b.min, to: b.max, size };
  },

  save(args) {
    const name = args[0];
    if (!name) throw new TruthError('bad_args', 'usage: save structureName x1 y1 z1 x2 y2 z2 [world|memory]');
    const b = box(blockPos(args, 1), blockPos(args, 4));
    const mode = (args[7] ?? 'world').toLowerCase();
    if (mode !== 'world' && mode !== 'memory') throw new TruthError('bad_args', `bad save mode ${mode}`);
    const sid = structureId(name);
    const dim = overworld();
    assertLoaded(dim, b);
    const sm = world.structureManager;
    if (sm.getPackStructureIds().includes(sid)) {
      throw new TruthError('bad_args', `${sid} is a pack structure and cannot be overwritten`);
    }
    if (sm.get(sid)) sm.delete(sid);
    const s = sm.createFromWorld(sid, dim, b.min, b.max, {
      includeEntities: false,
      saveMode: mode === 'world' ? StructureSaveMode.World : StructureSaveMode.Memory,
    });
    return { structure: s.id, from: b.min, to: b.max, size: vec(s.size), saveMode: mode };
  },

  structures() {
    const sm = world.structureManager;
    return { pack: sm.getPackStructureIds(), world: sm.getWorldStructureIds() };
  },
};

// Wood-gathering commands (wood.ts): container, tree, find.
Object.assign(handlers, woodHandlers({ reply, replyError, getBlock, assertLoaded, overworld }));
// Interaction commands (act.ts): setblock, door.
Object.assign(handlers, actHandlers({ getBlock, assertLoaded, overworld }));
// PvE / follow commands (pve.ts): summon, mobs, near, entity, killmobs, clearmobs, sethealth, movemob, effect, hurtlog.
Object.assign(handlers, pveHandlers({ overworld }));
Object.assign(handlers, survHandlers({ overworld })); // Track S
Object.assign(handlers, farmHandlers({ getBlock, assertLoaded, overworld })); // Track U: field, crops
Object.assign(handlers, foodHandlers({ getBlock, assertLoaded, overworld })); // Track X: furnace, setfurnace, herd, pen
Object.assign(handlers, combatHandlers({ overworld })); // Track V: combatlog, held
Object.assign(handlers, paletteHandlers({ getBlock, assertLoaded, overworld })); // Track AC: palette, palettestrip, palettestates
Object.assign(handlers, gauntHandlers({ getBlock, assertLoaded, overworld })); // Track W: bed, sleeping
Object.assign(handlers, getHandlers({ overworld })); // Track AD: stuff, getinv, boxitems
Object.assign(handlers, buildHandlers({ getBlock, assertLoaded, overworld })); // Track AL: blocksdiff
Object.assign(handlers, homeHandlers({ getBlock, assertLoaded, overworld })); // Track AG: chestput
Object.assign(handlers, shieldHandlers({ overworld })); // Track AH: stance, blocklog
Object.assign(handlers, netherHandlers({ getBlock, assertLoaded })); // Track AT: dimensions, portals
Object.assign(handlers, flyHandlers()); // Track AU: glide, glidelog, equip, boxdrop
Object.assign(handlers, craftHandlers({ getBlock, assertLoaded, overworld })); // Track AW: kit, craftinv, table
Object.assign(handlers, courseHandlers({ reply, replyError, overworld })); // Track F4a: course
Object.assign(handlers, caveHandlers({ reply, replyError, overworld })); // Track F5a: cave

function blockVolume(a: Vec3, b: Vec3): BlockVolume {
  return new BlockVolume(a, b);
}

// ---------------------------------------------------------------- dispatch

system.afterEvents.scriptEventReceive.subscribe(
  (ev) => {
    let req: { cmd: string; id: string | null; args: string[] };
    try {
      req = parseRequest(ev.id, ev.message);
    } catch (e) {
      replyError(ev.id, null, e);
      return;
    }
    const { cmd, id, args } = req;
    const h = Object.prototype.hasOwnProperty.call(handlers, cmd) ? handlers[cmd] : undefined;
    if (!h) {
      reply(cmd, id, false, { message: `unknown command ${cmd}`, commands: Object.keys(handlers).sort() }, 'unknown_command');
      return;
    }
    const ctx: Ctx = { cmd, id, ev, async: false };
    try {
      const data = h(args, ctx);
      if (!ctx.async) reply(cmd, id, true, data ?? null);
    } catch (e) {
      replyError(cmd, id, e);
    }
  },
  { namespaces: ['truth'] },
);

// ---------------------------------------------------------------- events (cmd "event", id null)

function emit(type: string, data: Record<string, unknown>): void {
  try {
    send({ cmd: 'event', id: null, ok: true, tick: system.currentTick, data: { type, ...data } });
  } catch {
    // never let event reporting break the game
  }
}

world.afterEvents.playerBreakBlock.subscribe((ev) => {
  emit('playerBreakBlock', {
    player: ev.player.name,
    x: ev.block.location.x,
    y: ev.block.location.y,
    z: ev.block.location.z,
    typeId: ev.brokenBlockPermutation.type.id,
    tool: ev.itemStackBeforeBreak?.typeId ?? null,
  });
});

world.afterEvents.entityDie.subscribe(
  (ev) => {
    const p = ev.deadEntity;
    let location: Vec3 | null = null;
    let name: string | null = null;
    try {
      location = vec(p.location);
      name = p instanceof Player ? p.name : p.nameTag;
    } catch {
      // entity may already be invalid
    }
    emit('playerDie', {
      player: name,
      entityId: p.id,
      location,
      cause: ev.damageSource.cause,
      damager: ev.damageSource.damagingEntity?.typeId ?? null,
    });
  },
  { entityTypes: ['minecraft:player'] },
);

actEvents(emit); // playerPlaceBlock, playerInteractWithBlock

world.afterEvents.playerSpawn.subscribe((ev) => {
  emit('playerSpawn', { player: ev.player.name, initialSpawn: ev.initialSpawn, location: vec(ev.player.location) });
});

world.afterEvents.worldLoad.subscribe(() => {
  emit('loaded', { pack: PACK_VERSION, api: API_VERSION });
  console.log(`[truth] pack ${PACK_VERSION} loaded (@minecraft/server ${API_VERSION})`);
});
