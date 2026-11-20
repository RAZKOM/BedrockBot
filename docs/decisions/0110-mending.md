# 0110: Mending what the bot uses (Track K5)

Date: 2026-11-20. Status: accepted. The hold on the way (`mendOnTheWay`) is on by default: it moves no armour, never
touches the blade or the shield while a hostile is near and adds no walk. `!mend` is a typed command; no background
chore. Details and numbers: [../survival.md](../survival.md) "Mending (Track K5)".

## Context

Track K4 (ADR 0108) puts a better elytra on when the one at hand is worn, but nothing renewed a worn one, and the owner
asked that the bot "mend whatever it can" and know which of the things it uses have Mending. Mending repairs a piece
only while it is worn or held when experience orbs are picked up; between flights the bot wears its chestplate and
carries the elytra, a spare pickaxe or a trident, so the experience it picks up (furnace outputs, ores, kills) went
into the experience bar. The old `!mend <item>` moved a tool into the offhand and told the owner to wear armour or
the elytra by hand.

Measured on the test server (BDS 1.26.60.6, flat, peaceful, n3 a case, test/e2e/mend.test.ts MEND_PROBE):

- One orb summoned is one point; a point mends 2 uses of one damaged Mending piece worn (any armour slot, the elytra
  on the back) or held in the main hand, and gives no experience then. A piece only carried gets nothing (+10 points
  to the bar, 3 of 3). The offhand refuses an elytra (item_stack_request status 55, 3 of 3); a Mending shield in the
  offhand is mended (+20 uses for 10 orbs, 3 of 3).
- With several damaged Mending pieces worn or held, each orb goes whole to one of them, not by damage: an elytra held
  (332/432), a chestplate (128/528) and leggings (445/495) worn took 7 / 3 / 10, 8 / 9 / 3 and 5 / 6 / 9 of 20 single orbs;
  a worn elytra and a held pickaxe 9 / 1, 7 / 3, 5 / 5, 6 / 4, 7 / 3 of 10; a held elytra (132/432) and a worn diamond
  chestplate (228/528) 4 / 6, 6 / 4, 3 / 7.
- A furnace pays when its output is taken, as orbs at the furnace about 2 blocks from the bot, picked up 0.03 to
  2.2 s later: 8 raw iron 6 points (3 of 3), 8 beef 3 (3 of 3), 8 cobblestone 1; a Mending elytra worn during the take
  gained 12 uses from the iron, the bar 0.
- The model knows the mended wear: the worn piece by `player_armor_damage` (one packet an orb), the held one by its
  slot update; the bot's counts equalled the server's in every case.
- The one enchantment reader (world/inventory.ts `tagEnchants`, also for items inside a shulker box) read Mending and
  Unbreaking off every kind enchanted with `/enchant`: the four armour pieces, sword, axe, pickaxe, shovel, hoe,
  shield, trident, bow, crossbow, mace, fishing rod, shears, flint and steel, elytra.

## Decision

1. **Which piece gets the hand (`turnPiece`, skills/survival/mend.ts).** Worn and held pieces mend where they are (the
   server shares the orbs among them). Of the damaged Mending pieces only carried, the one set aside first (it is not
   used until mended: a set-aside pickaxe digs nothing), then the one with the smallest share of its uses left (it
   reaches its limit first), the elytra on a tie. `!mend <piece>`: that kind only, held too.
2. **The hold (tasks/mend-hand.ts).** The piece comes into a hotbar slot that holds no tool, weapon or rocket (one
   move into an empty hotbar slot or one swap with the inventory screen, undone after; with none such no hold), is
   selected while the orbs come (at least 16 ticks after a furnace take or an ore, whose orbs come into view later,
   6 for the watcher's hold: with 6, 3 of 5 points of a coal vein went to the bar; then until 4 ticks with no orb within 8, at most 70), and the slot held
   before comes back. The miner also holds after ores its walk dug on the way. It ends at once when
   a hostile comes within 16 or a skill takes the hand. Nothing takes armour off or touches the offhand.
3. **On the way (`mendOnTheWay`, default on).** At every furnace output take (skills/food/cook.ts `CookerDeps.mend`:
   the swap before the furnace opens, the hold around each take: `!cook`, `!smelt`, the food chore, the obtain job's
   steps); and orbs within 8 with the hand free (no user process, no walk, no fight, the survival kit idle, not
   gliding) and no hostile within 16: a reflex kill's or a guard fight's orbs once the fight is over. A kill's orbs
   lay 4 to 6 blocks off and were not drawn in, so a watcher hold walks once to the nearest orb still farther than 1.5
   blocks 20 ticks in (no digging, 5 s at most); so does an ore's hold, and a furnace job's end walks to its orbs
   still lying within 8 (a take's orbs behind the furnace never came in 2 runs of 15); the take itself never walks. A watcher hold that mended nothing waits 200 ticks before the next. While a hostile is near the blade, the shield and the armour
   stay as they are (skills/combat is unchanged).
4. **`!mend [<piece>] [minutes]`** gathers experience on purpose until the damaged Mending pieces (worst first) or the
   one named are mended, the time bound (default 15 min) or no source: the furnaces where the cooker looks (their
   output taken once a job), a smelt of what is carried (the most experience an item first, sized to the points
   wanted and the fuel), the same out of the chests at home while in reach, then the ore near (coal, lapis, redstone,
   diamond, quartz, outside the base) with a pickaxe that harvests it, the hold after each ore. The job's piece comes into
   the hotbar once for the whole job (a swap per ore was slower than the orbs). Steps are the bot's own
   commands; `!stop` and every command that moves the bot end the job. With no source it says what it needs.
5. **Knowing Mending.** `!mend status` lists each piece with and without Mending and its wear (`no Mending: trident
   (1/250, worn out: cannot be mended)`); `!inv` marks `(Mending)`; `!elytra status` and the takeoff's refusal say a
   damaged Mending elytra can be mended. The worn-tool rule keeps a Mending piece worth keeping (`mendAt`). The test
   harness keeps an elytra with Mending under `elytraMin` (a fresh one from `/replaceitem` has no enchantments).

## Not built

- A background chore (`autoMend`): `!mend` walks no farther than the ore near and the home chests in reach; a chore
  would add body moves at home with nobody asking.
- Mob grinding and the Nether (see survival.md for the numbers and what they would take).

## Consequences

The elytra and every Mending piece the bot carries are renewed by what the bot does anyway (cooking, smelting) and on
request by `!mend`; the K4 spare swap stays for an elytra without Mending. A held piece costs a hotbar slot for at most
3.5 s at a take.
