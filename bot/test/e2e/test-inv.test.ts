// e2e (tag @bds), Track T3: `!test inv <preset>` and `!test inv restore` (skills/test/inv.ts) on bds-home (flat, peaceful,
// cheats on, every player an operator, the truth pack). One afk-task bot (walking, the CLI's wiring, settings in memory,
// testMode on, the tests folder a temporary one) in its own random area away from any home. The owner's inventory is set
// slot by slot by truth: netherite armour worn, an enchanted sword (/enchant on the held slot), a worn pickaxe, the elytra,
// a fireworks box of 165, a named box, loose rockets, food and drops. For each preset, by the bot's own slash commands:
//   1. the preset: every kept slot (gear, elytra, boxes) still holds what it held, the free and restorable slots hold the
//      preset's stacks (the server's inventory read by truth:inv, every slot and its count)
//   2. the room chore acts on its own (a pass line, or for fullbar the place skill's exchange), `!test inv status` says so
//   3. `!test inv restore sweep`: every slot as it was (typeId and count by truth, the worn pieces too), the model agrees,
//      the boxes' contents changed only by what the chore boxed (the rockets preset)
// Then the refusals: a user process running, a second preset before the restore (each one INFO line).
// Track T3 follow-up, a waiting save never leaks the preset: the food chore asking to run (the restore goes first, on its
// own), a restore asked during a fight (zombies summoned, difficulty easy for the case: it waits, then runs), the time
// limit (shortened to 20 s: restored on its own), an unload due at home (chests unchanged for 25 s, `!unload` refused).
// Env: HOME_BDS_PORT / HOME_BDS_CONTAINER (default bds-home on 19196), HOME_VERBOSE=1, T3_OUT (a file for the notes),
// T3_PRESETS=early,rockets (a subset).
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { isShulkerBox, shulkerContents, shulkerSlotsUsed, stackKey } from '../../src/skills/container/chest.ts';
import { itemDisplayName } from '../../src/world/inventory.ts';
import { carriedCounts, countsDiff, INV_PRESETS, planPreset } from '../../src/skills/test/inv.ts';
import { testControlOf } from '../../src/chat/commands-test.ts';
import { BaseProcess, PRIORITY, type ProcessKind } from '../../src/tasks/process/manager.ts';
import { inventoryFoodPoints } from '../../src/skills/food/finder.ts';
import { foodControllerOf } from '../../src/chat/commands-food.ts';
import { buildHome, clearAreaHome, E2E, FEET_Y, homeCmd, prepareServer, privateArea, removeHome, sleep, startHomeBot, teleport, until, type HomeBot, type HomeLayout } from './home-truth.ts';

const TESTS_DIR = mkdtempSync(join(tmpdir(), 'bedrockbot-t3-'));
process.env.BEDROCKBOT_TESTS_DIR = TESTS_DIR;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

class Hold extends BaseProcess {
  readonly name = 'hold';
  readonly kind: ProcessKind = 'user';
  get priority(): number {
    return PRIORITY.user;
  }
  protected run(): void {}
  protected halt(): void {}
  status() {
    return { line: 'hold' };
  }
}

type Slot = [item: string, count: number];
/** The owner's inventory (the fireworks box and a named box of sand are picked up into the first free slots). */
const OWNER: Slot[] = [
  ['netherite_sword', 1], ['netherite_pickaxe', 1], ['firework_rocket', 64], ['cooked_beef', 24], ['bread', 12], ['air', 0], ['cobblestone', 16], ['air', 0], ['golden_carrot', 20],
  ['elytra', 1], ['firework_rocket', 38], ['bone', 7], ['air', 0], ['redstone', 17], ['air', 0], ['wheat_seeds', 4], ['air', 0], ['air', 0],
];
/**
 * Track V1c: the Realm's layout for the rockets and early presets: the hotbar full (the boxes come into the main
 * inventory), so the box and rocket steps bring the box into a full hotbar first.
 */
const OWNER_FULL_HOTBAR: Slot[] = OWNER.map((s, i): Slot => (i === 5 ? ['torch', 16] : i === 7 ? ['oak_planks', 20] : s));
const FULL_HOTBAR_PRESETS = new Set(['rockets', 'early']);

interface TruthInv {
  slots: ({ slot: number; typeId: string; amount: number } | null)[];
  equipment: Record<string, { typeId: string; amount: number }>;
}
const bare = (s: string) => s.replace(/^minecraft:/, '');
/** The restore's end line, or a refusal (Track T3 follow-up: the first line `started` or `waiting for ...` is not it). */
const RESTORED = /^test inv (restore: (\d+ -> \d+ free|stopped|.* still after)|: )/;

describe.skipIf(!E2E)('@bds test inv: presets and the restore (Track T3)', () => {
  const area = privateArea();
  const at = { x: area.x + 60, y: FEET_Y, z: area.z };
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  let homeLayout: HomeLayout | undefined; // Track T3 follow-up: the unload case's home
  const note = (s: string) => {
    notes.push(s);
    if (process.env.T3_OUT) appendFileSync(process.env.T3_OUT, `${s}\n`);
  };
  const inv = (b: HomeBot) => b.built.mobility!.world.inventory;
  const truthInv = async (b: HomeBot): Promise<TruthInv> => b.truth.ok<TruthInv>('inv', [b.name]);
  /** Slot i -> `typeId x n` from the server (the 36 slots), and the worn pieces. */
  const truthSlots = (t: TruthInv): string[] => [
    ...t.slots.slice(0, 36).map((s) => (s ? `${bare(s.typeId)} x${s.amount}` : '-')),
    ...Object.entries(t.equipment)
      .sort()
      .map(([k, v]) => `${k} ${bare(v.typeId)}`),
  ];
  const modelSlots = (b: HomeBot): string[] => inv(b).slots.slice(0, 36).map((s) => (s && s.count > 0 ? `${s.name} x${s.count}` : '-'));
  const boxed = (b: HomeBot): Record<string, number> => {
    const out: Record<string, number> = {};
    inv(b).slots.slice(0, 36).forEach((s, i) => {
      if (s && isShulkerBox(s.name)) for (const [k, v] of Object.entries(shulkerContents(inv(b).rawItem(0, i)))) out[k] = (out[k] ?? 0) + v;
    });
    return out;
  };
  const ask = async (b: HomeBot, text: string, match: RegExp, ms = 240_000): Promise<string> => {
    const from = b.said.length;
    await b.command(text);
    return b.reply((s) => match.test(s), from, ms);
  };

  async function ownerInventory(b: HomeBot, layout: Slot[] = OWNER): Promise<void> {
    await b.truth.ok('clear', [b.name]);
    await until(() => (inv(b).slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    for (let i = 0; i < layout.length; i++) {
      const [item, n] = layout[i]!;
      if (item !== 'air') await b.truth.ok('setslot', [b.name, i, item, n]);
    }
    const feet = b.task.position()!;
    const box = { x: Math.floor(feet.x) + 1, y: Math.floor(feet.y), z: Math.floor(feet.z) };
    const boxWith = (item: string) => () => {
      const k = inv(b).slots.slice(0, 36).findIndex((s, i) => !!s && isShulkerBox(s.name) && shulkerContents(inv(b).rawItem(0, i))[item]);
      return k >= 0 ? k : undefined;
    };
    // Track V1c: the owner's empty box with a name of its own (not bot_loot): the room chore never fills it
    await b.truth.ok('give', [b.name, 'undyed_shulker_box', 1]);
    const empty = await until(() => {
      const k = inv(b).slots.slice(0, 36).findIndex((s, i) => !!s && isShulkerBox(s.name) && inv(b).rawItem(0, i) !== undefined && shulkerSlotsUsed(inv(b).rawItem(0, i)) === 0);
      return k >= 0 ? k : undefined;
    }, 10_000, 'the empty box in the inventory');
    await b.truth.ok('nameinv', [b.name, empty, 'owner_stuff']);
    await until(() => (itemDisplayName(inv(b).rawItem(0, empty)) === 'owner_stuff' ? true : undefined), 10_000, 'the box named owner_stuff');
    if (layout === OWNER_FULL_HOTBAR) {
      // and a plain empty box (the Realm bot's spares): the loot box of the early preset's box step
      await b.truth.ok('give', [b.name, 'undyed_shulker_box', 1]);
      await until(() => (inv(b).slots.slice(0, 36).filter((s, i) => !!s && isShulkerBox(s.name) && itemDisplayName(inv(b).rawItem(0, i)) === undefined).length === 1 ? true : undefined), 10_000, 'the plain box');
    }
    // then the fireworks box (rockets put in by the truth pack: their NBT differs from the preset's /replaceitem ones)
    for (const [item, amount, stacks] of [['firework_rocket', 55, 3]] as const) {
      await b.truth.ok('boxdrop', [box.x, box.y, box.z, item, amount, stacks]);
      await sleep(1200);
      if (boxWith(item)() === undefined) await b.built.mobility!.skills.collect(4, 160, { origin: centre(box), filter: (it) => isShulkerBox(it.name) });
      await until(boxWith(item), 10_000, `the box of ${item} in the inventory`);
    }
    // the sword in the held slot (0) gets an enchantment (the kept "enchanted" case)
    const run = testControlOf(b.task)!.runner;
    const hotbar = (b.built.mobility!.skills as unknown as { parts: { hotbar?: { select(slot: number): boolean } } }).parts.hotbar;
    hotbar?.select(0);
    await b.built.mobility!.loop.waitTicks(4);
    const e = await run.run('/enchant @s sharpness 3', { pace: true });
    note(`/enchant: ${e.ok} ${e.messageId}`);
    await sleep(1000);
  }

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('Inv');
    bot = b;
    b.settings.set('testMode', 'on');
    await teleport(b, centre(at));
    await clearAreaHome(b.truth, at, 10, 5);
    await b.truth.ok('equip', [b.name, 'Head', 'netherite_helmet']);
    await b.truth.ok('equip', [b.name, 'Chest', 'netherite_chestplate']);
    await b.truth.ok('equip', [b.name, 'Legs', 'netherite_leggings']);
    await b.truth.ok('equip', [b.name, 'Feet', 'netherite_boots']);
    const op = await testControlOf(b.task)!.ops.ensure();
    expect(op.state).toBe('op');
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.clearAround(centre(at), 24).catch(() => undefined);
      await clearAreaHome(bot.truth, at, 10, 5).catch(() => undefined);
      if (homeLayout) await removeHome(bot, homeLayout, { x: area.x, z: area.z }).catch(() => undefined);
      await bot.stop();
    }
    rmSync(TESTS_DIR, { recursive: true, force: true });
    console.log(`[test-inv e2e] area cell ${area.cell}\n  ${notes.join('\n  ')}`);
  }, 120_000);

  const only = process.env.T3_PRESETS?.split(',').filter(Boolean);
  for (const preset of INV_PRESETS.filter((p) => !only || only.includes(p))) {
    it(`${preset}: the preset by commands, the room chore on its own, the restore: every slot as it was`, async () => {
      const b = bot!;
      await teleport(b, centre(at));
      await b.truth.clearAround(centre(at), 12).catch(() => undefined);
      const fullHotbar = FULL_HOTBAR_PRESETS.has(preset);
      await ownerInventory(b, fullHotbar ? OWNER_FULL_HOTBAR : OWNER);
      if (fullHotbar) {
        // the boxes in the main inventory, the hotbar full
        expect(inv(b).slots.slice(0, 9).every((s) => !!s)).toBe(true);
        expect(inv(b).slots.slice(9, 36).filter((s) => !!s && isShulkerBox(s.name))).toHaveLength(3);
      }
      // Track V1c: a block with a collision box over the lid of the nearest box cell (it keeps a box shut): never chosen
      const lid = { x: at.x + 1, y: FEET_Y + 1, z: at.z };
      if (preset === 'rockets') await b.truth.ok('set', [lid.x, lid.y, lid.z, 'glass']);
      const t0 = await truthInv(b);
      const before = truthSlots(t0);
      const boxed0 = boxed(b);
      const counts0 = carriedCounts(inv(b));
      expect(modelSlots(b)).toEqual(before.slice(0, 36));
      const logFrom = b.logs.length;
      const sayFrom = b.said.length;
      // 1. the preset
      const first = await ask(b, `!test inv ${preset}`, /^test inv \w+: (saved|nothing|not now|stopped)/, 60_000);
      note(`${preset}: ${first}`);
      expect(first).toMatch(/^test inv \w+: saved; \d+ slots cleared/);
      const doneLine = await until(() => b.said.slice(sayFrom).find((x) => new RegExp(`^test inv ${preset}: (\\d+ -> \\d+ free|stopped)`).test(x)), 240_000, 'the preset done');
      note(`${preset}: ${doneLine}`);
      expect(doneLine).toMatch(/ -> [0-2] free in /); // every preset fills every free slot (the keeper may drop the junk at 36 of 36 at once)
      if (preset === 'rockets') {
        // Track V1c: the loose rockets' NBT (the preset's /replaceitem, the truth pack's setslot) and the box's rockets'
        const loose = new Set<string>();
        let inBox = '';
        inv(b).slots.slice(0, 36).forEach((s, i) => {
          const raw = inv(b).rawItem(0, i);
          if (s?.name === 'firework_rocket') loose.add(stackKey(s.name, s.metadata, raw) ?? '?');
          if (s && isShulkerBox(s.name) && shulkerContents(raw).firework_rocket) {
            const list = (raw as { extra?: { nbt?: { nbt?: { value?: { Items?: { value?: { value?: Record<string, unknown>[] } } } } } } }).extra?.nbt?.nbt?.value?.Items?.value?.value ?? [];
            const { Count: _c, Slot: _s, ...rest } = list[0] ?? {};
            inBox = JSON.stringify(rest, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x));
          }
        });
        note(`rockets: loose stack keys ${[...loose].join(' | ')}; the box's first rocket entry ${inBox}`);
      }
      const t1 = await truthInv(b);
      const snap = testControlOf(b.task)!.inv.saved()!;
      const plan = planPreset(snap, preset);
      // Track T3 follow-up: the kept slots and the food stay as they were
      const fedSlots = new Set(plan.fed.map((f) => f.slot));
      const want: string[] = before.slice(0, 36).map((s, i) => (snap.slots[i]?.kept !== undefined || fedSlots.has(i) ? s : '-'));
      expect(plan.fed.length).toBeGreaterThan(0); // the owner's food: beef, bread, golden carrots
      for (const st of plan.stacks) want[st.slot] = `${st.item} x${st.count}`;
      const got = truthSlots(t1).slice(0, 36);
      // the keeper drops the junk at 36 of 36 (rotten flesh, string): those slots may be empty by now
      const diffs = got.flatMap((g, i) => (g === want[i] ? [] : [`${i}: want ${want[i]}, got ${g}`]));
      note(`${preset}: kept ${snap.slots.filter((x) => x?.kept).map((x) => `${x!.slot} ${x!.name} (${x!.kept})`).join(', ')}; slots off the plan: ${diffs.join('; ') || 'none'}`);
      for (const d of diffs) expect(d).toMatch(/want (rotten_flesh|string) x\d+, got -|got (rotten_flesh|string)/);
      expect(truthSlots(t1).slice(36)).toEqual(before.slice(36)); // the worn pieces untouched
      // 2. the room chore (or, fullbar, the place skill's exchange)
      if (preset === 'fullbar') {
        const target = { x: at.x + 2, y: FEET_Y, z: at.z };
        const r = await b.built.mobility!.skills.place(target, { item: 'cobblestone', face: 'up' });
        const ex = b.logs.slice(logFrom).filter((l) => /place: .*moved from slot/.test(l));
        note(`fullbar: place ${r.ok ? 'ok' : r.reason}; ${ex.join(' | ') || 'no exchange line'}`);
        expect(r.ok).toBe(true);
        expect(ex.some((l) => l.includes('exchanged'))).toBe(true);
        await b.truth.ok('set', [target.x, target.y, target.z, 'air']).catch(() => undefined);
      } else {
        const pass = await until(() => b.logs.slice(logFrom).find((l) => /inventory: \d+ -> \d+ slots free in/.test(l)), 90_000, 'a room pass');
        note(`${preset}: ${pass.replace(/^\S+ \w+ /, '')}`);
      }
      await sleep(3000);
      const status = await ask(b, '!test inv status', new RegExp(`^test inv ${preset} \\(`), 10_000);
      note(`${preset}: ${status}`);
      if (preset !== 'fullbar') expect(status).toMatch(/room chore \d+ pass/);
      // 3. the restore
      note(`${preset}: before the restore ${truthSlots(await truthInv(b)).slice(0, 36).map((s, i) => `${i}:${s}`).join(' ')}`);
      // the keeper's dropped stone may lie past the sweep's 8 (2 of 4 runs of `full` here: 48 cobblestone picked up onto the
      // restored 16 during the restore): gone first, so the check below is the restore's alone
      const me = b.built.mobility!.world.self.pos;
      const far = [...b.built.mobility!.world.entities.values()].filter((e) => e.type.includes('item') && Math.hypot(e.pos.x - me.x, e.pos.z - me.z) > 8).length;
      note(`${preset}: items on the ground past 8: ${far}`);
      await testControlOf(b.task)!.runner.run('/kill @e[type=item,r=24]', { pace: true });
      const restoreLogFrom = b.logs.length;
      const restored = await ask(b, '!test inv restore sweep', RESTORED, 240_000);
      note(`${preset}: ${restored}`);
      note(`${preset}: moves during the restore: ${b.logs.slice(restoreLogFrom).filter((l) => /merged|moved|inventory:|room|exchange|process/.test(l)).map((l) => l.replace(/^\S+ /, '')).join(' | ') || 'none'}`);
      expect(restored).toMatch(/^test inv restore: \d+ -> \d+ free/);
      await sleep(1500);
      const t2 = await truthInv(b);
      const after = truthSlots(t2);
      const off = after.flatMap((g, i) => (g === before[i] ? [] : [`${i}: was ${before[i]}, now ${g}`]));
      note(`${preset}: after the restore, slots not as before: ${off.join('; ') || 'none'}; boxes changed ${JSON.stringify(countsDiff(boxed0, boxed(b)))}; carried changed ${JSON.stringify(countsDiff(counts0, carriedCounts(inv(b))))}`);
      if (/moved from slot \d+ to \d+|took back out of the boxes/.test(restored)) {
        // (Track T3 follow-up 2: the take-back places the box and picks it up again, into the first free slot: the same)
        // Track V1c: the rocket step picked the fireworks box up into a lower slot (one its own moves had freed); the restore never
        // overwrites a kept box, so the stack saved there is given into a free slot: the same stacks, two slots swapped
        const sorted = (x: string[]) => [...x.slice(0, 36)].sort();
        expect(sorted(after)).toEqual(sorted(before));
        expect(after.slice(36)).toEqual(before.slice(36));
        expect(off.length).toBeLessThanOrEqual(3);
      } else expect(off).toEqual([]);
      expect(Object.entries(countsDiff(counts0, carriedCounts(inv(b)))).filter(([k]) => !k.startsWith('boxed:'))).toEqual([]);
      expect(modelSlots(b)).toEqual(after.slice(0, 36));
      const boxDiff = countsDiff(boxed0, boxed(b));
      // Track T3 follow-up 2: what the room chore boxed of the preset is taken back out: every box holds what it held
      expect(boxDiff).toEqual({});
      if (preset === 'rockets') {
        // Track V1c: rockets went into the box (before: none, every deposit onto a partial stack of other NBT refused)
        expect(b.logs.slice(logFrom).some((l) => /inventory: .*firework_rocket into the fireworks box/.test(l))).toBe(true);
        expect(restored).toMatch(/took back out of the boxes firework_rocket \d+/);
        expect(b.logs.slice(logFrom).filter((l) => /deposit \d+ firework_rocket .*: error/.test(l))).toEqual([]);
      }
      // Track V1c: the owner's empty named box is still empty and still named
      const owner = inv(b).slots.slice(0, 36).findIndex((s, i) => !!s && isShulkerBox(s.name) && itemDisplayName(inv(b).rawItem(0, i)) === 'owner_stuff');
      expect(owner).toBeGreaterThanOrEqual(0);
      expect(shulkerSlotsUsed(inv(b).rawItem(0, owner))).toBe(0);
      const told = b.logs.slice(logFrom).filter((l) => /inventory: .*(boxed|into the fireworks box)/.test(l));
      note(`${preset}: room lines ${told.map((l) => l.replace(/^\S+ \w+ /, '')).join(' | ') || 'none'}`);
      expect(b.logs.slice(logFrom).filter((l) => /inventory: .*\((the box is not in the hotbar|open: )/.test(l))).toEqual([]);
      if (preset === 'rockets') {
        const placed = b.logs.slice(logFrom).filter((l) => /place \(-?\d+, -?\d+, -?\d+\) \w*shulker_box/.test(l));
        note(`rockets: box placements ${placed.map((l) => l.replace(/^\S+ \w+ /, '')).join(' | ') || 'none'}`);
        expect(placed.some((l) => l.includes(`place (${lid.x}, ${FEET_Y}, ${lid.z})`))).toBe(false);
        await b.truth.ok('set', [lid.x, lid.y, lid.z, 'air']).catch(() => undefined);
      }
      expect(testControlOf(b.task)!.inv.saved()).toBeUndefined();
    }, 900_000);
  }

  it('refusals: a user process runs; a second preset before the restore', async () => {
    const b = bot!;
    const h = b.processes.add(new Hold());
    await sleep(500);
    const no = await ask(b, '!test inv early', /^test inv: /, 20_000);
    note(`refusal: ${no}`);
    expect(no).toBe('test inv: not now: hold runs (!stop)');
    b.processes.stop(h);
    await sleep(500);
    const from = b.said.length;
    const first = await ask(b, '!test inv split', /^test inv split: (saved|not now)/, 60_000);
    expect(first).toMatch(/saved/);
    await until(() => b.said.slice(from).find((x) => /^test inv split: \d+ -> \d+ free/.test(x)), 240_000, 'the preset done');
    const second = await ask(b, '!test inv full', /^test inv: /, 20_000);
    note(`second preset: ${second}`);
    expect(second).toMatch(/is not back yet: !test inv restore first/);
    const r = await ask(b, '!test inv restore sweep', RESTORED, 240_000);
    note(`restore: ${r}`);
    // Track T3 follow-up: every refusal is one INFO line with its reason
    const refused = b.logs.filter((l) => l.includes('test inv: refused: '));
    note(`refusal log lines: ${refused.length}`);
    expect(refused.some((l) => l.includes('not now: hold runs (!stop)'))).toBe(true);
    expect(refused.some((l) => l.includes('is not back yet'))).toBe(true);
  }, 600_000);

  // ---- Track T3 follow-up: a waiting save never leaks the preset -----------------------------------------------------

  /** A preset on the owner's inventory; resolves when it is done. */
  async function presetOn(b: HomeBot, preset: string): Promise<void> {
    // a case that failed may have left its save: restore it first (else this preset is refused and the cases cascade)
    if (testControlOf(b.task)!.inv.saved()) {
      const r = await ask(b, '!test inv restore', RESTORED, 300_000).catch((e: unknown) => String(e));
      note(`(a save left by an earlier case restored first: ${r})`);
    }
    await ownerInventory(b);
    const from = b.said.length;
    await b.command(`!test inv ${preset}`);
    await until(() => b.said.slice(from).find((x) => new RegExp(`^test inv ${preset}: \\d+ -> \\d+ free`).test(x)), 240_000, 'the preset done');
  }
  const foodPoints = (b: HomeBot) => inventoryFoodPoints(inv(b).slots);

  it("a carried bot_loot box (the full preset): the room chore boxes the preset's items; the restore takes them back out, the box holds what it held", async () => {
    const b = bot!;
    await teleport(b, centre(at));
    await b.truth.clearAround(centre(at), 12).catch(() => undefined);
    if (testControlOf(b.task)!.inv.saved()) await ask(b, '!test inv restore', RESTORED, 300_000).catch(() => undefined);
    await ownerInventory(b);
    // the bot's own loot box, holding 12 bone already (dropped by the truth pack, picked up, named bot_loot)
    const feet = b.task.position()!;
    const drop = { x: Math.floor(feet.x) - 1, y: Math.floor(feet.y), z: Math.floor(feet.z) };
    const boneBox = () => {
      const k = inv(b).slots.slice(0, 36).findIndex((s, i) => !!s && isShulkerBox(s.name) && shulkerContents(inv(b).rawItem(0, i)).bone === 12);
      return k >= 0 ? k : undefined;
    };
    await b.truth.ok('boxmix', [drop.x, drop.y, drop.z, 'bone', 12, 1]);
    await sleep(1200);
    if (boneBox() === undefined) await b.built.mobility!.skills.collect(4, 160, { origin: centre(drop), filter: (it) => isShulkerBox(it.name) });
    const k = await until(boneBox, 10_000, 'the bone box in the inventory');
    await b.truth.ok('nameinv', [b.name, k, 'bot_loot']);
    const loot = await until(() => {
      const i = inv(b).slots.slice(0, 36).findIndex((s, j) => !!s && isShulkerBox(s.name) && itemDisplayName(inv(b).rawItem(0, j)) === 'bot_loot');
      return i >= 0 ? i : undefined;
    }, 10_000, 'the box named bot_loot');
    const lootBefore = shulkerContents(inv(b).rawItem(0, loot));
    const boxed0 = boxed(b);
    const counts0 = carriedCounts(inv(b));
    note(`loot box: slot ${loot} holds ${JSON.stringify(lootBefore)}`);
    // the stone stays carried (dropStone 0: never dropped), so the room pass boxes it
    const dropStone0 = b.settings.get('dropStone');
    b.settings.set('dropStone', '0');
    const logFrom = b.logs.length;
    try {
      const sayFrom = b.said.length;
      const first = await ask(b, '!test inv full', /^test inv \w+: (saved|nothing|not now|stopped)/, 60_000);
      expect(first).toMatch(/saved/);
      await until(() => b.said.slice(sayFrom).find((x) => /^test inv full: \d+ -> \d+ free/.test(x)), 240_000, 'the preset done');
      const pass = await until(() => b.logs.slice(logFrom).find((l) => /inventory: \d+ -> \d+ slots free in/.test(l)), 90_000, 'a room pass');
      note(`loot box: ${pass.replace(/^\S+ \w+ /, '')}`);
      const gained = countsDiff(boxed0, boxed(b));
      note(`loot box: the boxes gained ${JSON.stringify(gained)}`);
      expect(Object.values(gained).some((v) => v > 0)).toBe(true); // the room chore boxed some of the preset
      await testControlOf(b.task)!.runner.run('/kill @e[type=item,r=24]', { pace: true });
      const restored = await ask(b, '!test inv restore sweep', RESTORED, 300_000);
      note(`loot box: ${restored}`);
      expect(restored).toMatch(/took back out of the boxes /);
      expect(restored).not.toMatch(/still in the boxes/);
      await sleep(1500);
      const now = inv(b).slots.slice(0, 36).findIndex((s, j) => !!s && isShulkerBox(s.name) && itemDisplayName(inv(b).rawItem(0, j)) === 'bot_loot');
      expect(now).toBeGreaterThanOrEqual(0);
      note(`loot box: after the restore slot ${now} holds ${JSON.stringify(shulkerContents(inv(b).rawItem(0, now)))}; boxes changed ${JSON.stringify(countsDiff(boxed0, boxed(b)))}; carried changed ${JSON.stringify(countsDiff(counts0, carriedCounts(inv(b))))}`);
      expect(shulkerContents(inv(b).rawItem(0, now))).toEqual(lootBefore);
      expect(countsDiff(boxed0, boxed(b))).toEqual({});
      expect(Object.entries(countsDiff(counts0, carriedCounts(inv(b)))).filter(([x]) => !x.startsWith('boxed:'))).toEqual([]);
      expect(testControlOf(b.task)!.inv.saved()).toBeUndefined();
    } finally {
      b.settings.set('dropStone', String(dropStone0));
    }
  }, 900_000);

  it('the food chore asking to run while a save waits: the restore goes first, on its own, and the food is back', async () => {
    const b = bot!;
    await teleport(b, centre(at));
    // autoFood on only once the preset is in place (ownerInventory empties the inventory first: a hunt could start)
    b.settings.set('autoFood', 'off');
    await presetOn(b, 'fullbar');
    b.settings.set('autoFood', 'on');
    const fed = foodPoints(b);
    note(`food: after fullbar ${fed} food points (the food stays)`);
    expect(fed).toBeGreaterThanOrEqual(10);
    // the bot "ate" its food: clear it (the food chore wants to run below foodMin 10)
    const run = testControlOf(b.task)!.runner;
    const from = b.said.length;
    const logFrom = b.logs.length;
    // (the chore found nothing to hunt while ownerInventory had the inventory empty: its 10 min backoff goes)
    const chore = foodControllerOf(b.task)!.chore;
    chore.nextTry = -Infinity;
    const cleared: string[] = [];
    for (const f of ['cooked_beef', 'bread', 'golden_carrot']) {
      const s = await run.run(`/clear @s ${f}`, { pace: true });
      cleared.push(`${f} ${s.ok ? 'ok' : 'failed'} ${s.messageId}`);
    }
    note(`food: cleared ${cleared.join(', ')}`);
    await until(() => (foodPoints(b) < 10 ? true : undefined), 15_000, `the food gone from the model (${foodPoints(b)} points)`);
    const own = await until(() => b.said.slice(from).find((x) => x.startsWith('test inv: restoring the saved inventory on my own')), 30_000, 'the restore of its own').catch((e: unknown) => {
      note(`food: no restore of its own: chore ${JSON.stringify(chore.check())}; active ${b.processes.active?.name ?? 'none'}; logs ${b.logs.slice(logFrom).filter((l) => /food|test inv/.test(l)).join(' | ')}`);
      throw e;
    });
    note(`food: ${own}`);
    expect(own).toMatch(/restore first: the food chore: 0 food points carried \(< 10\)/);
    const done = await until(() => b.said.slice(from).find((x) => /^test inv restore: \d+ -> \d+ free/.test(x)), 120_000, 'the restore');
    note(`food: ${done}`);
    await sleep(1500);
    expect(foodPoints(b)).toBe(fed);
    expect(testControlOf(b.task)!.inv.saved()).toBeUndefined();
    // the food chore never started a hunt with the preset's items
    expect(b.logs.slice(logFrom).filter((l) => /food chore: .* hunting/.test(l) || l.includes('process: food started'))).toEqual([]);
  }, 600_000);

  it('a restore during a fight waits for the guard to hand back (said at once), then runs', async () => {
    const b = bot!;
    await teleport(b, centre(at));
    await presetOn(b, 'split');
    await homeCmd('difficulty', 'easy');
    const run = testControlOf(b.task)!.runner;
    const guard0 = b.task.pve!.guard.on;
    b.task.pve!.setGuard({ on: true }); // (the e2e bot starts with the guard off)
    try {
      await sleep(1000);
      for (const dx of [5, 6]) {
        const s = await run.run(`/summon zombie ~${dx} ~ ~ 0 0 minecraft:entity_spawned`, { pace: true });
        note(`fight: summon ${s.ok ? 'ok' : 'failed'} ${s.messageId}`);
      }
      await sleep(1000);
      const zombies = [...b.built.mobility!.world.entities.values()].filter((e) => e.type.includes('zombie')).length;
      note(`fight: ${zombies} zombie(s) seen; guard ${b.task.pve?.guard.on ? 'on' : 'off'}; active ${b.processes.active?.name ?? 'none'}`);
      await until(() => (b.task.pve?.combat.busy || b.processes.active?.name === 'guard' ? true : undefined), 20_000, 'the guard fights');
      const from = b.said.length;
      await b.command('!test inv restore sweep');
      const first = await b.reply((x) => /^test inv (restore|:)/.test(x), from, 10_000);
      note(`fight: first reply ${first}`);
      expect(first).toMatch(/^test inv restore: waiting for .* to end \(at most 3 min\), then the restore/);
      const done = await b.reply((x) => RESTORED.test(x) && !x.startsWith('test inv restore: waiting'), from, 240_000);
      note(`fight: ${done}`);
      expect(done).toMatch(/^test inv restore: \d+ -> \d+ free/);
      const waited = b.logs.find((l) => /test inv restore: .* waited, restoring/.test(l));
      note(`fight: ${waited?.replace(/^\S+ \w+ /, '') ?? 'no wait line'}`);
      expect(testControlOf(b.task)!.inv.saved()).toBeUndefined();
    } finally {
      b.task.pve!.setGuard({ on: guard0 });
      await homeCmd('difficulty', 'peaceful');
      await run.run('/kill @e[type=zombie,r=32]', { pace: true }).catch(() => undefined);
    }
  }, 600_000);

  it('the time limit: a forgotten save is restored on its own', async () => {
    const b = bot!;
    await teleport(b, centre(at));
    const t = testControlOf(b.task)!.inv;
    const limit0 = t.limitMs;
    t.limitMs = 20_000;
    try {
      const t0 = Date.now();
      await presetOn(b, 'early');
      const from = b.said.length - 1; // the preset's end line is the last one: the restore of its own comes after it
      const own = await until(() => b.said.slice(from).find((x) => x.startsWith('test inv: restoring the saved inventory on my own')), 60_000, 'the restore of its own');
      const done = await until(() => b.said.slice(from).find((x) => /^test inv restore: \d+ -> \d+ free/.test(x)), 120_000, 'the restore');
      note(`time limit: ${own} | ${done} (${((Date.now() - t0) / 1000).toFixed(0)} s after the preset was asked)`);
      expect(own).toMatch(/the save waited \d+ s, the limit is 20 s/);
      expect(t.saved()).toBeUndefined();
    } finally {
      t.limitMs = limit0;
    }
  }, 600_000);

  it('an unload due at home while a save waits: nothing reaches the chests until the restore', async () => {
    const b = bot!;
    const c = { x: area.x, z: area.z };
    homeLayout = await buildHome(b, c);
    const L = homeLayout;
    b.task.home!.set(L.home);
    b.settings.set('autoUnload', 'on');
    await teleport(b, centre(L.home));
    const from = b.said.length;
    await b.command('!chests scan');
    note(`unload: ${await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000)}`);
    const chests = [L.coal, L.wood, L.empty, L.boxes, L.barrel];
    const stored = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const p of chests) for (const [k, v] of Object.entries((await b.truth.box(p)).counts)) out[k] = (out[k] ?? 0) + v;
      return out;
    };
    await presetOn(b, 'full'); // 0 free at home: the unload's trigger (fewer than 4 free with stacks to unload)
    const s0 = await stored();
    const logFrom = b.logs.length;
    await sleep(25_000); // the Realm's wait before its restore
    const s1 = await stored();
    const held = b.logs.slice(logFrom).filter((l) => /held until the restore|home: unload held/.test(l));
    const unloads = b.logs.slice(logFrom).filter((l) => /home chore: (unload|spares|tidy) done|unloaded: /.test(l));
    note(`unload: chests changed while the save waited ${JSON.stringify(countsDiff(s0, s1))}; ${held.length} held line(s); unloads ${unloads.length}`);
    expect(countsDiff(s0, s1)).toEqual({});
    expect(unloads).toEqual([]);
    // !unload by hand is refused too
    const no = await ask(b, '!unload', /^unload/, 10_000);
    note(`unload: ${no}`);
    expect(no).toMatch(/^unload: not now: a !test inv full save from .* waits for its restore/);
    const r = await ask(b, '!test inv restore sweep', RESTORED, 240_000);
    note(`unload: ${r}`);
    expect(r).toMatch(/^test inv restore: \d+ -> \d+ free/);
  }, 900_000);
});
