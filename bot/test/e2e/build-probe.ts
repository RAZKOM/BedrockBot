// Track B1 (docs/build.md "Block states", decision 0124): a skills-level bot on bds-build for measuring how the
// server sets a placed block's states from a click (the face, the point on it, the view) and for the build-rules
// e2e that asserts those rules. The full skill stack (Connection -> World -> InputLoop -> Hotbar / Containers ->
// BotSkills), the shape of act-truth.ts on the builder's server, plus a raw click (`click`) for clicks the
// PlaceSkill does not make: on the block itself (a double slab, a repeater's delay).
// Env: BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_VERBOSE=1.
import { ReplyParser, textOf, type Reply } from '../../../packs/truth/src/protocol.ts';
import { Connection } from '../../src/connection/connection.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { clickBlockTransaction } from '../../src/skills/container/chest.ts';
import { EYE_HEIGHT, type Face } from '../../src/skills/dig/look.ts';
import { faceIndex, type BlockFace } from '../../src/skills/place/face.ts';
import { wireItemOf } from '../../src/skills/place/place.ts';
import { BotSkills } from '../../src/skills/index.ts';
import { InputLoop, flatWorld } from '../../src/skills/input/index.ts';
import { Containers } from '../../src/world/containers.ts';
import { Hotbar, World } from '../../src/world/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { BUILD_CONTAINER, BUILD_TARGET, VERBOSE } from './build-truth.ts';
import { DigTruth } from './dig-truth.ts';
import { E2E_VERSION } from './env.ts';
import { pollUntil, sleep, uniqueName } from './world-truth.ts';

export interface TruthBlock {
  x: number;
  y: number;
  z: number;
  typeId: string;
  states: Record<string, unknown>;
}

export interface ProbeBot {
  name: string;
  conn: Connection;
  world: World;
  loop: InputLoop;
  hotbar: Hotbar;
  skills: BotSkills;
  truth: DigTruth;
  teleport(feet: Vec3, yaw?: number): Promise<void>;
  /** Empty inventory, then the items in order (the first nine land in the hotbar). */
  loadout(items: [string, number][]): Promise<void>;
  block(p: Vec3): Promise<TruthBlock>;
  /**
   * A raw click on face `face` of block `pos` (no placement logic): the item in the hotbar slot holding `item`
   * (or the held one), the view `view`, the point `at` (block-relative; default the face centre).
   */
  click(pos: Vec3, face: BlockFace, o?: { item?: string; view?: { yaw: number; pitch: number }; at?: Vec3 }): Promise<void>;
  close(): Promise<void>;
}

/** Run a truth command, retrying while its chunks are not loaded yet. */
export async function truthOk<T = Record<string, unknown>>(truth: DigTruth, cmd: string, args: (string | number)[], timeoutMs = 20_000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const r = await truth.cmd(cmd, args, 30_000);
    if (r.ok) return r.data as T;
    if (r.reason !== 'unloaded_chunk' || performance.now() - t0 > timeoutMs) throw new Error(`truth:${cmd} ${args.join(' ')} failed: ${r.reason} ${JSON.stringify(r.data)}`);
    await sleep(300);
  }
}

export async function connectProbeBot(prefix = 'Rule'): Promise<ProbeBot> {
  const name = uniqueName(prefix);
  const logger = VERBOSE ? createLogger('debug', 'probe') : silentLogger;
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
  const loop = new InputLoop(conn, { world: flatWorld(), logger: silentLogger });
  const hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
  const containers = new Containers(conn, world.inventory, { logger });
  const skills = new BotSkills({ loop, world, hotbar, containers, source: conn, logger });
  const truth = new DigTruth(BUILD_CONTAINER);
  const parser = new ReplyParser();
  conn.on('text', (p) => {
    let r: Reply | null;
    try {
      r = parser.feed(textOf(p));
    } catch {
      return;
    }
    if (r && r.cmd !== 'event') truth.receive(r);
  });
  loop.start();
  await conn.connect(BUILD_TARGET);
  await world.waitForChunks(2, { timeoutMs: 30_000 });
  await loop.waitTicks(10);

  const teleport = async (feet: Vec3, yaw = 0): Promise<void> => {
    const seen = new Promise<void>((resolve) => {
      const off = loop.onEvent((e) => {
        if (e.kind === 'teleport' && Math.hypot(e.to.x - feet.x, e.to.y - feet.y, e.to.z - feet.z) < 0.01) {
          off();
          resolve();
        }
      });
    });
    skills.cancel();
    loop.release();
    await truth.ok('tp', [name, feet.x, feet.y, feet.z, yaw, 0]);
    await seen;
    loop.setCommand({ yaw, pitch: 0 });
    await world.waitForChunks(3, { center: feet, timeoutMs: 30_000 });
    await loop.waitTicks(20);
  };

  const loadout = async (items: [string, number][]): Promise<void> => {
    await truth.ok('clear', [name]);
    for (const [n, c] of items) await truth.ok('give', [name, n, c]);
    const want = items.reduce((a, [, c]) => a + c, 0);
    const ok = await pollUntil(() => world.inventory.slots.reduce((a, s) => a + (s?.count ?? 0), 0) === want, 5_000);
    if (ok < 0) throw new Error(`inventory model never showed ${want} items: ${JSON.stringify(world.inventory.slots.filter(Boolean).map((s) => `${s!.name}x${s!.count}`))}`);
    await loop.waitTicks(2);
  };

  const block = (p: Vec3) => truthOk<TruthBlock>(truth, 'block', [p.x, p.y, p.z]);

  const click = async (pos: Vec3, face: BlockFace, o: { item?: string; view?: { yaw: number; pitch: number }; at?: Vec3 } = {}): Promise<void> => {
    const inv = world.inventory;
    let slot = inv.selected;
    if (o.item) {
      slot = inv.slots.findIndex((s, i) => i < 9 && s?.name === o.item);
      if (slot < 0) throw new Error(`no ${o.item} in the hotbar`);
      if (slot !== inv.selected) hotbar.select(slot);
    }
    if (o.view) loop.setCommand(o.view);
    await loop.waitTicks(2);
    const f = loop.state.pos;
    conn.queue(
      'inventory_transaction',
      clickBlockTransaction({
        pos,
        face: faceIndex(face) as Face,
        hotbarSlot: slot,
        held: wireItemOf(inv.slots[slot], inv.rawItem(0, slot) ?? hotbar.rawItem(slot)),
        eye: { x: f.x, y: f.y + EYE_HEIGHT, z: f.z },
        blockRuntimeId: world.chunks.runtimeIdAt(pos.x, pos.y, pos.z) ?? 0,
        clickPos: o.at,
      }),
    );
    await loop.waitTicks(6);
  };

  const close = async (): Promise<void> => {
    skills.cancel();
    if (conn.state === 'spawned') await loop.waitTicks(2);
    skills.dispose();
    containers.dispose();
    hotbar.dispose();
    loop.stop();
    world.dispose();
    await conn.disconnectAndFlush('test done');
  };

  return { name, conn, world, loop, hotbar, skills, truth, teleport, loadout, block, click, close };
}
