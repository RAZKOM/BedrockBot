// e2e (tag @bds), PLAN.md tasks 2.4 and 2.5: item drops from truth:spawnitem appear in the entity map
// at the truth location, and truth:give shows up in the inventory model. Needs bds-world and BDS_E2E=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import { silentLogger } from '../../src/log.ts';
import { World } from '../../src/world/index.ts';
import type { EntityInfo, Vec3 } from '../../src/world/types.ts';
import { E2E, Truth, WORLD_CONTAINER, WORLD_TARGET, consoleCommand, leave, pollUntil, sleep, uniqueName } from './world-truth.ts';

interface SpawnItemData {
  typeId: string;
  amount: number;
  entities: { entityId: string; amount: number; location: Vec3 }[];
}

interface InvData {
  selectedSlot: number;
  slots: ({ slot: number; typeId: string; amount: number } | null)[];
  counts: Record<string, number>;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe.skipIf(!E2E)('@bds world entities and inventory vs truth pack (bds-world)', () => {
  const name = uniqueName('WEnts');
  let conn: Connection;
  let world: World;
  let truth: Truth;
  const firstSeen = new Map<bigint, Vec3>();

  beforeAll(async () => {
    conn = new Connection({ version: '1.26.51', username: name, logger: silentLogger, reconnect: false });
    world = new World(conn, { logger: silentLogger });
    truth = new Truth(conn);
    world.entityTracker.onAdd((e: EntityInfo) => firstSeen.set(e.uniqueId, { ...e.pos }));
    await conn.connect(WORLD_TARGET);
    await world.waitForChunks(3, { timeoutMs: 30_000 });
    await consoleCommand(WORLD_CONTAINER, 'kill', '@e[type=item]');
  }, 60_000);

  afterAll(async () => {
    try {
      await consoleCommand(WORLD_CONTAINER, 'kill', '@e[type=item]');
    } catch {
      // best effort
    }
    truth?.dispose();
    world?.dispose();
    await leave(conn);
  });

  it('an item from truth:spawnitem appears within 0.5 blocks of truth, moves, and is removed', async () => {
    const at = { x: 6.5, y: -60, z: 6.5 };
    const data = await truth.ok<SpawnItemData>('spawnitem', [at.x, at.y, at.z, 'oak_log', 3]);
    expect(data.entities).toHaveLength(1);
    const truthItem = data.entities[0]!;
    const uid = BigInt(truthItem.entityId);
    const find = () => [...world.entities.values()].find((e) => e.uniqueId === uid);
    expect(await pollUntil(() => find() !== undefined, 500)).toBeGreaterThanOrEqual(0);
    const e = find()!;
    expect(e.type).toBe('minecraft:item');
    expect(e.item?.name).toBe('oak_log');
    expect(e.item?.count).toBe(3);
    const spawnPos = firstSeen.get(uid)!;
    const d0 = dist(spawnPos, truthItem.location);
    console.log(`[world-entities] item ${uid}: truth ${JSON.stringify(truthItem.location)} model at add ${JSON.stringify(spawnPos)} (distance ${d0.toFixed(3)})`);
    expect(d0).toBeLessThanOrEqual(0.5);

    // Items pop with a random velocity; move_entity_delta keeps the model current until it rests.
    await sleep(1500);
    const rest = find()!;
    console.log(`[world-entities] item at rest in the model: ${JSON.stringify(rest.pos)} onGround ${rest.onGround}`);
    expect(rest.onGround).toBe(true);
    expect(dist(rest.pos, spawnPos)).toBeGreaterThan(0);
    expect(dist(rest.pos, truthItem.location)).toBeLessThan(2);

    await consoleCommand(WORLD_CONTAINER, 'kill', '@e[type=item]');
    expect(await pollUntil(() => find() === undefined, 1000)).toBeGreaterThanOrEqual(0);
  });

  it('truth:give oak_log 5 shows 5 logs in the model, slot for slot like truth:inv', async () => {
    await truth.ok('clear', [name]);
    expect(await pollUntil(() => world.inventory.slots.every((s) => s === null), 1000)).toBeGreaterThanOrEqual(0);
    await truth.ok('give', [name, 'oak_log', 5]);
    await truth.ok('give', [name, 'stone', 70]);
    const waited = await pollUntil(() => world.inventory.count('oak_log') === 5 && world.inventory.count('stone') === 70, 1000);
    expect(waited, `model counts oak_log ${world.inventory.count('oak_log')} stone ${world.inventory.count('stone')}`).toBeGreaterThanOrEqual(0);

    const inv = await truth.ok<InvData>('inv', [name]);
    expect(inv.counts['minecraft:oak_log']).toBe(5);
    const model = world.inventory.slots.map((s, i) => (s ? { slot: i, typeId: `minecraft:${s.name}`, amount: s.count } : null));
    expect(model).toEqual(inv.slots);
    expect(world.inventory.selected).toBe(inv.selectedSlot);
    console.log(`[world-entities] inventory after give: ${JSON.stringify(model.filter(Boolean))} (seen after ${waited.toFixed(1)} ms)`);

    await truth.ok('clear', [name]);
    expect(await pollUntil(() => world.inventory.count('oak_log') === 0, 1000)).toBeGreaterThanOrEqual(0);
  });
});
