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
// Then the refusals: a user process running, a second preset before the restore.
// Env: HOME_BDS_PORT / HOME_BDS_CONTAINER (default bds-home on 19196), HOME_VERBOSE=1, T3_OUT (a file for the notes),
// T3_PRESETS=early,rockets (a subset).
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { carriedCounts, countsDiff, INV_PRESETS, planPreset } from '../../src/skills/test/inv.ts';
import { testControlOf } from '../../src/chat/commands-test.ts';
import { BaseProcess, PRIORITY, type ProcessKind } from '../../src/tasks/process/manager.ts';
import { clearAreaHome, E2E, FEET_Y, prepareServer, privateArea, sleep, startHomeBot, teleport, until, type HomeBot } from './home-truth.ts';

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

interface TruthInv {
  slots: ({ slot: number; typeId: string; amount: number } | null)[];
  equipment: Record<string, { typeId: string; amount: number }>;
}
const bare = (s: string) => s.replace(/^minecraft:/, '');

describe.skipIf(!E2E)('@bds test inv: presets and the restore (Track T3)', () => {
  const area = privateArea();
  const at = { x: area.x + 60, y: FEET_Y, z: area.z };
  const notes: string[] = [];
  let bot: HomeBot | undefined;
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

  async function ownerInventory(b: HomeBot): Promise<void> {
    await b.truth.ok('clear', [b.name]);
    await until(() => (inv(b).slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    for (let i = 0; i < OWNER.length; i++) {
      const [item, n] = OWNER[i]!;
      if (item !== 'air') await b.truth.ok('setslot', [b.name, i, item, n]);
    }
    const feet = b.task.position()!;
    const box = { x: Math.floor(feet.x) + 1, y: Math.floor(feet.y), z: Math.floor(feet.z) };
    const boxWith = (item: string) => () => {
      const k = inv(b).slots.slice(0, 36).findIndex((s, i) => !!s && isShulkerBox(s.name) && shulkerContents(inv(b).rawItem(0, i))[item]);
      return k >= 0 ? k : undefined;
    };
    // the owner's named box of sand (a box holding anything else: the room chore never fills it), then the fireworks box
    for (const [item, amount, stacks] of [['sand', 64, 1], ['firework_rocket', 55, 3]] as const) {
      await b.truth.ok('boxdrop', [box.x, box.y, box.z, item, amount, stacks]);
      await sleep(1200);
      if (boxWith(item)() === undefined) await b.built.mobility!.skills.collect(4, 160, { origin: centre(box), filter: (it) => isShulkerBox(it.name) });
      const k = await until(boxWith(item), 10_000, `the box of ${item} in the inventory`);
      if (item === 'sand') await b.truth.ok('nameinv', [b.name, k, 'owner_stuff']);
    }
    // the sword in the held slot (0) gets an enchantment (the kept "enchanted" case)
    const run = testControlOf(b.task)!.runner;
    const hotbar = (b.built.mobility!.skills as unknown as { parts: { hotbar?: { select(slot: number): boolean } } }).parts.hotbar;
    hotbar?.select(0);
    await b.built.mobility!.loop.waitTicks(4);
    const e = await run.run('/enchant @s sharpness 3');
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
      await ownerInventory(b);
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
      const t1 = await truthInv(b);
      const snap = testControlOf(b.task)!.inv.saved()!;
      const plan = planPreset(snap, preset);
      const want: string[] = before.slice(0, 36).map((s, i) => (snap.slots[i]?.kept !== undefined ? s : '-'));
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
      const restored = await ask(b, '!test inv restore sweep', /^test inv (restore|:)/, 240_000);
      note(`${preset}: ${restored}`);
      expect(restored).toMatch(/^test inv restore: \d+ -> \d+ free/);
      await sleep(1500);
      const t2 = await truthInv(b);
      const after = truthSlots(t2);
      const off = after.flatMap((g, i) => (g === before[i] ? [] : [`${i}: was ${before[i]}, now ${g}`]));
      note(`${preset}: after the restore, slots not as before: ${off.join('; ') || 'none'}; boxes changed ${JSON.stringify(countsDiff(boxed0, boxed(b)))}; carried changed ${JSON.stringify(countsDiff(counts0, carriedCounts(inv(b))))}`);
      expect(off).toEqual([]);
      expect(modelSlots(b)).toEqual(after.slice(0, 36));
      const boxDiff = countsDiff(boxed0, boxed(b));
      if (preset === 'rockets') for (const [k, v] of Object.entries(boxDiff)) expect([k, v > 0]).toEqual(['firework_rocket', true]);
      else expect(boxDiff).toEqual({});
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
    const r = await ask(b, '!test inv restore sweep', /^test inv restore: /, 240_000);
    note(`restore: ${r}`);
  }, 600_000);
});
