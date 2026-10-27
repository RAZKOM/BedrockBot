// e2e (tag @bds), wave 8 Track AD (docs/get.md "Stash"): the stash step on bds-get (flat, peaceful,
// truth pack). One afk-task bot (walking, the CLI's wiring) in its own random area, 4 coal ore buried
// 3 blocks under the floor next to it, the inventory full: stone pickaxe (slot 0), a shulker box
// (slot 1) and 34 stacks of cobblestone (truth:stuff), 0 slots free.
//   shulker  `!get coal 4`: the mine process pauses at once, the stash step places the shulker box next
//            to the bot, moves 27 stacks of cobblestone into it (27 item_stack_requests on the task's
//            Containers), breaks it and picks it up; the job finishes 4/4. Contents: the server's own
//            inventory packet for the box carries NBT `Items` with 1728 cobblestone, and the box placed
//            again holds 1728 cobblestone (truth:container); no box or drop is left in the world.
//            (Script API 2.10.0 has no reader for a shulker box item's contents: ItemInventoryComponent
//            is absent on it, verified with truth:getinv.)
//   chest    the same with `!set stashChest <x y z>` (a chest 10 blocks away): 27 stacks go into the
//            chest (truth:container), the shulker box stays in the inventory, empty
// Env: GET_BDS_HOST / GET_BDS_PORT / GET_BDS_CONTAINER (get-truth.ts), GET_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { stashFor, type StashAttempt } from '../../src/skills/container/stash.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startGetBot, teleport, truthLoaded, until, type GetBot } from './get-truth.ts';

const F = FEET_Y;

interface NbtItem {
  Name?: { value: string };
  Count?: { value: number };
}

/** Item counts in a shulker box item's NBT `Items` (the raw wire item of the inventory model). */
function nbtContents(raw: unknown): Record<string, number> {
  const list = (raw as { extra?: { nbt?: { nbt?: { value?: { Items?: { value?: { value?: NbtItem[] } } } } } } } | undefined)?.extra?.nbt?.nbt?.value?.Items?.value?.value ?? [];
  const out: Record<string, number> = {};
  for (const it of list) {
    const n = String(it.Name?.value ?? '?').replace(/^minecraft:/, '');
    out[n] = (out[n] ?? 0) + Number(it.Count?.value ?? 0);
  }
  return out;
}

describe.skipIf(!E2E)('@bds get: the stash step (Track AD)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: GetBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  /** Fresh floor, stone 2 deep under it, 4 coal ore at 3 under the floor 2 blocks east of `at`. */
  async function buildOres(at: { x: number; z: number }): Promise<Vec3[]> {
    const b = bot!;
    await clearArea(b.truth, at, 16, 6);
    await truthLoaded(b.truth, 'fill', [at.x - 6, F - 3, at.z - 6, at.x + 8, F - 2, at.z + 6, 'stone']);
    const ores = [
      { x: at.x + 2, y: F - 3, z: at.z },
      { x: at.x + 3, y: F - 3, z: at.z },
      { x: at.x + 2, y: F - 3, z: at.z + 1 },
      { x: at.x + 3, y: F - 3, z: at.z + 1 },
    ];
    for (const p of ores) await truthLoaded(b.truth, 'set', [p.x, p.y, p.z, 'coal_ore']);
    return ores;
  }

  /** Pickaxe (slot 0), shulker box (slot 1), 34 stacks of cobblestone: 0 slots free (truth and model). */
  async function fillInventory(): Promise<void> {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'stone_pickaxe', 1]);
    await b.truth.ok('give', [b.name, 'undyed_shulker_box', 1]);
    const s = await b.truth.stuff(b.name, 'cobblestone', 34);
    expect(s.stacks).toBe(34);
    const inv = b.built.mobility!.world.inventory;
    await until(() => (inv.freeSlots().length === 0 ? true : undefined), 10_000, 'a full inventory in the model');
  }

  async function runCoal(label: string): Promise<{ attempt: StashAttempt; ms: number; replies: string[] }> {
    const b = bot!;
    const stash = stashFor(b.processes)!;
    const n0 = stash.attempts.length;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!get coal 4');
    expect(await b.reply((s) => s.startsWith('getting '), from)).toBe('getting 4 coal: mining coal_ore');
    const end = await b.reply((s) => s.startsWith('mine '), from, 240_000);
    const ms = Date.now() - t0;
    const replies = b.said.slice(from);
    const attempt = stash.attempts[n0];
    notes.push(`${label}: ${replies.join(' | ')}; ${(ms / 1000).toFixed(1)} s; stash log: ${b.logs.filter((l) => l.includes('stash (mine)')).slice(-2).join(' / ')}`);
    if (end !== 'mine coal_ore: 4/4 done') notes.push(`${label} log:\n    ${b.logs.filter((l) => /:(farm|stash|process|survival|nav) /.test(l)).slice(-60).join('\n    ')}`);
    expect(end).toBe('mine coal_ore: 4/4 done');
    expect(attempt).toBeDefined();
    return { attempt: attempt!, ms, replies };
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startGetBot('Stash');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await clearArea(bot.truth, area, 16, 6).catch(() => undefined);
      await bot.truth.clearAround(home, 30).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[get-stash e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('a carried shulker box takes 27 stacks and comes back with them; the job finishes', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    await teleport(b, home);
    const ores = await buildOres(area);
    await fillInventory();
    await sleep(500);
    const { attempt } = await runCoal('shulker');
    const step = attempt.steps.find((s) => s.kind === 'shulker');
    notes.push(`shulker attempt: free ${attempt.freeBefore} -> ${attempt.freeAfter} in ${attempt.ms} ms; ${JSON.stringify(step)}`);
    expect(attempt.freeBefore).toBe(0);
    expect(attempt.ok).toBe(true);
    expect(step?.moved).toEqual({ cobblestone: 27 * 64 });
    expect(step?.requests).toBe(27);
    expect(step?.shared ?? 0).toBeGreaterThanOrEqual(27);
    expect(step?.pickedUp).toBe(true);
    // the inventory: the box, 4 coal, the cobblestone that did not fit (7 stacks + what the digs dropped)
    const counts = await until(async () => {
      const c = await b.truth.counts(b.name);
      return (c.coal ?? 0) >= 4 ? c : undefined;
    }, 20_000, '4 coal', 500);
    notes.push(`shulker: inventory ${JSON.stringify(counts)}`);
    expect(counts.undyed_shulker_box).toBe(1);
    expect(counts.coal).toBe(4);
    expect(counts.cobblestone ?? 0).toBeGreaterThanOrEqual(7 * 64);
    // no box and no box drop left where it stood
    const where = step!.where!;
    expect(String((await truthLoaded<{ typeId: string }>(b.truth, 'block', [where.x, where.y, where.z])).typeId)).toBe('minecraft:air');
    expect((await b.truth.boxItems({ x: where.x + 0.5, y: where.y, z: where.z + 0.5 }, 3)).filter((i) => i.typeId.endsWith('shulker_box'))).toHaveLength(0);
    // contents: the server's inventory packet (NBT Items) ...
    const inv = mob.world.inventory;
    const slot = inv.slots.findIndex((s) => s?.name === 'undyed_shulker_box');
    const nbt = nbtContents(inv.rawItem(0, slot));
    notes.push(`shulker: box item NBT Items ${JSON.stringify(nbt)}`);
    expect(nbt).toEqual({ cobblestone: 27 * 64 });
    // ... and truth: the box placed again holds them (truth:container)
    const spot = { x: Math.floor(home.x) - 2, y: F, z: Math.floor(home.z) - 2 };
    await teleport(b, home);
    const pr = await mob.skills.place(spot, { face: 'up', item: 'undyed_shulker_box' });
    expect(pr.ok).toBe(true);
    const box = await b.truth.blockInv(spot);
    notes.push(`shulker: placed again at ${spot.x} ${spot.y} ${spot.z}: ${box.typeId} ${JSON.stringify(box.counts)}`);
    expect(box.counts['minecraft:cobblestone']).toBe(27 * 64);
    await b.truth.ok('set', [spot.x, spot.y, spot.z, 'air']);
    expect(ores.length).toBe(4);
  }, 300_000);

  it('with stashChest set, a chest 10 blocks away takes the 27 stacks instead', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    const at = { x: area.x + 40, z: area.z };
    const start = { x: at.x + 0.5, y: F, z: at.z + 0.5 };
    await teleport(b, start);
    await buildOres(at);
    const chest = { x: at.x - 10, y: F, z: at.z };
    await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'chest']);
    const from = b.said.length;
    await b.command(`!set stashChest ${chest.x} ${chest.y} ${chest.z}`);
    expect(await b.reply((s) => s.startsWith('stashChest = '), from)).toMatch(new RegExp(`^stashChest = ${chest.x} ${chest.y} ${chest.z} \\(was none\\)`));
    await fillInventory();
    await sleep(500);
    try {
      const { attempt } = await runCoal('chest');
      const step = attempt.steps.find((s) => s.kind === 'chest');
      notes.push(`chest attempt: free ${attempt.freeBefore} -> ${attempt.freeAfter} in ${attempt.ms} ms; steps ${attempt.steps.map((s) => s.kind).join(',')}; ${JSON.stringify(step)}`);
      expect(attempt.ok).toBe(true);
      expect(attempt.steps.map((s) => s.kind)).toEqual(['chest']);
      expect(step?.moved).toEqual({ cobblestone: 27 * 64 });
      expect(step?.requests).toBe(27);
      expect(step?.shared ?? 0).toBeGreaterThanOrEqual(27);
      const c = await b.truth.blockInv(chest);
      notes.push(`chest: ${c.typeId} ${JSON.stringify(c.counts)}`);
      expect(c.counts['minecraft:cobblestone']).toBe(27 * 64);
      const counts = await b.truth.counts(b.name);
      notes.push(`chest: inventory ${JSON.stringify(counts)}`);
      expect(counts.undyed_shulker_box).toBe(1);
      expect(counts.coal).toBe(4);
      const inv = mob.world.inventory;
      expect(nbtContents(inv.rawItem(0, inv.slots.findIndex((s) => s?.name === 'undyed_shulker_box')))).toEqual({});
    } finally {
      const f2 = b.said.length;
      await b.command('!set stashChest default');
      await b.reply((s) => s.startsWith('stashChest = '), f2).catch(() => undefined);
      await truthLoaded(b.truth, 'container', [chest.x, chest.y, chest.z, 'clear']).catch(() => undefined);
      await truthLoaded(b.truth, 'set', [chest.x, chest.y, chest.z, 'air']).catch(() => undefined);
      await clearArea(b.truth, at, 16, 6).catch(() => undefined);
    }
  }, 300_000);
});
