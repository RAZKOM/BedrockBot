# 0110: Mending what the bot uses (Track K5)

Date: 2026-11-20. Status: accepted. The hold on the way (`mendOnTheWay`) is on by default: it moves no armour, never
touches the blade or the shield while a hostile can reach the bot (decision 6) and adds no walk that a hostile could
cut (decision 9). `!mend` is a typed command; the post (decision 8) and the chore (decision 10) ship off. Details and
numbers: [../survival.md](../survival.md) "Mending (Track K5)" and "Mending, part two (Track K6)".

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
   a hostile can hurt the bot during it (decision 6) or a skill takes the hand. Nothing takes armour off or touches the
   offhand.
3. **On the way (`mendOnTheWay`, default on).** At every furnace output take (skills/food/cook.ts `CookerDeps.mend`:
   the swap before the furnace opens, the hold around each take: `!cook`, `!smelt`, the food chore, the obtain job's
   steps); and orbs within 8 with the hand free (no user process, no walk, no fight, the survival kit idle, not
   gliding) and no hostile that can hurt the bot (decision 6): a reflex kill's or a guard fight's orbs once the fight is over. A kill's orbs
   lay 4 to 6 blocks off and were not drawn in, so a watcher hold walks once to the nearest orb still farther than 1.5
   blocks 20 ticks in (no digging, 5 s at most); so does an ore's hold, and a furnace job's end walks to its orbs
   still lying within 8 (a take's orbs behind the furnace never came in 2 runs of 15); the take itself never walks. The
   walks keep the strict rule (no hostile within 16). A watcher hold that mended nothing waits 200 ticks before the next
   (not one a hostile ended). While a hostile can reach the bot the blade, the shield and the armour stay as they are
   (skills/combat is unchanged).
4. **`!mend [<piece>] [minutes]`** gathers experience on purpose until the damaged Mending pieces (worst first) or the
   one named are mended, the time bound (default 15 min) or no source: the furnaces where the cooker looks (their
   output taken once a job), a smelt of what is carried (the most experience an item first, sized to the points
   wanted and the fuel), the same out of the chests at home while in reach, then the ore near (coal, lapis, redstone,
   diamond, quartz, outside the base) with a pickaxe that harvests it, the hold after each ore. The job's piece comes into
   the hotbar once for the whole job (a swap per ore was slower than the orbs). Steps are the bot's own
   commands; `!stop` and every command that moves the bot end the job. With no source it says what it needs; with
   nothing mended the end line says `uses gained 0` and the hand's refusal. The mine source keeps the strict rule.
5. **Knowing Mending.** `!mend status` lists each piece with and without Mending and its wear (`no Mending: trident
   (1/250, worn out: cannot be mended)`); `!inv` marks `(Mending)`; `!elytra status` and the takeoff's refusal say a
   damaged Mending elytra can be mended. The worn-tool rule keeps a Mending piece worth keeping (`mendAt`). The test
   harness keeps an elytra with Mending under `elytraMin` (a fresh one from `/replaceitem` has no enchantments).

6. **The hold rule (addendum, 2026-11-20; tasks/mend-threat.ts).** The rule was a radius: no hold, and a hold ended,
   with any hostile within 16, its way to the bot never looked at. On the Realm that was true at the owner's home at
   every hour (drowned in the lake and mobs in the caves around a walled base: 3 within 16 at noon, 11 within 32, none
   fighting), so a smelt there mended nothing (`held the elytra for furnace 0 ticks ... 132 -> 132`) and by day no hold
   was made and nothing was logged. Reproduced on the test server: a walled, roofed room with the furnace, drowned in a
   lake beside it, a zombie in a pit, zombies and a skeleton behind the walls, 7 within 16: the take 0 uses, a kill's
   orbs inside the room 0. Now a hostile stops a hold only when it can hurt the bot during it, from what the fight rules
   already know (skills/combat unchanged): it hit the bot in the last 10 s; it is in strike reach with a line on the
   bot; a lit creeper within 8; a shooter within 16 with a line of sight (`lineOfSight`); a flying mob within its walk
   bound with a line; any other mob whose walking path (the guard's `PathReach` probe) is within what it walks in the
   hold (`mobSpeed` x 70 ticks + its reach + 1: a zombie 11.2, a spider 14.6). A cached path counts 3 blocks shorter, a
   mob whose probe has not answered stops a hold within 6 only. The rule is asked before the move, before the take and
   every tick, and the hand comes back the tick it says no. The walks keep the radius (they leave where the bot stands);
   so does `!mend`'s mine source. (Decision 9 gives the walk to lying orbs its own rule.) Every refusal is logged (`mend: not held: a zombie 5 blocks off with a clear way to
   me (6 path blocks)`), and `!mend`'s end line names `uses gained 0` and the cause. After: the room's take 10 to 12 uses
   with the same mobs near; a zombie charging from 15 on open ground (n5): the hold ended at 10.9 to 11.0 blocks, 2.9 to
   3.0 s before the zombie was in strike reach; a spider (n5) 2.5 and 2.6 s; no hold in the hand at a mob's strike reach
   in any run; damage 0 with and without holds (the reflex killed every zombie first). The reflex's blade strike (Track
   E3, `swapHandOk`) does not take a held elytra out of the hand (it strikes with it), and takes a held pickaxe, shovel
   or hoe out only for the strike's tick; the rule is what keeps a hold out of a fight.

Track K6 (addenda, 2026-11-20; survival.md "Mending, part two (Track K6)"):

7. **Every point accounted; the ore hold starts at the break (skills/dig/digger.ts `predictHook`, tasks/mend-hand.ts
   `preselect`).** A probe counts the points each source pays, the uses mended, the bar and when each lost orb was
   picked up (n10 a source). A furnace take lost nothing in the open, against a wall, in a nook one block wide or with
   the bot 3 off (226 of 226 points mended in 40 runs; 226 of 227 measured again); a reflex kill lost nothing; with a
   damaged Mending piece worn the points split between the pieces, which is what the Realm's `178 -> 184` (3 of 6)
   shows, so the hold's line now names the worn share. Ores lost 85 of 369 points (23 %): the hold began when the server's update_block came back, after the orbs
   of a block broken beside the bot were spawned and often picked up. Now, while a `!mend` job's piece is staged, any
   dig of an ore that pays experience brings the piece into the hand the tick after the break's input has gone out
   (the slot held before comes back after 1.5 s with no hold to take it over): 53 of 371 (14 %). The piece is never
   moved before the break, because the server breaks with what is held then. Sending the change in the break's own
   batch mended no more (56 of 357), so it was not kept.
8. **The post: kills by night as the last `!mend` source (`mendPost`, default off; tasks/process/mend.ts
   `postCheck`).** By night at home (or where the bot stands with no home), with guard on, a blade, a chestplate,
   health and food at 14 or more, and no night shelter or bed due, the job stands and the rules that exist kill what
   comes; the watcher holds the piece for each kill's orbs. It never seeks mobs, and the first flight on foot ends it
   for the night; it ends too at dawn, at those bounds, after 30 s farther from home than the guard's radius + 8, at
   the job's bound. Each refusal is named in the end line (logged whole). On the gauntlet's idle night (n5 a kit, about 550 s): live kit
   37.6 uses a night, iron 30.4, the watcher alone (live, n3) 41.3; 0 deaths in 13 nights, at most 6.6 damage a night.
   The post mends no more than the watcher (the kills are the guard's either way; a quarter to a third of a kill's
   points mend, the hold rule refusing while other hostiles can reach), so it stays off; it is safe to turn on with
   either kit, and it cannot start without a blade and a chestplate. With the first bound (8 off home for 30 s) it
   ended in 7 of 10 nights during guard fights 13 to 20 off.
9. **The walk to lying orbs with hostiles near (tasks/mend-threat.ts `walkThreat`).** The walk (8 off at most, no
   digging, 5 s) is refused by the hold rule's tests over the walk and the hold (170 ticks: a zombie's bound 23.2 path
   blocks), asked of every hostile within 16 of the bot or of the orbs, with the lines taken from both; a walker whose
   probe found no path cannot reach the orbs either (the bot walks there without digging), and one whose way is not
   known refuses it. In a walled room with 6 or 7 hostiles within 16 that cannot reach (n10): the strict rule walked 0
   of 10 (2.9 uses a run), the rule 10 of 10 (5.8), damage 0; with a doorway and a zombie outside, both walked 0 of 10,
   damage 0. `!mend`'s mine source and the chore's start keep the radius of 16: they walk farther and dig.
10. **The chore (`autoMend`, default on since 2026-11-23, off before; tasks/process/mend.ts `MendChore`).** By day, idle, at home (within 16), no
    hostile within 16, a Mending piece at or under 75 % of its uses: a `!mend` job with the cheap sources only (the
    output of a furnace the bot's own smelt left, and raw ore out of the home chests smelted on a furnace already
    there), never what is carried, the ore near or the post. At most 32 items smelted in any hour (about 45 uses, a
    short flight's wear, for 4 coal); a pass that mended nothing waits 10 minutes. The smelt runs inside the chore's
    own process so that a typed command pre-empts it. Tested on a flat server: 8 raw iron in a home chest smelted and
    10 to 12 uses mended, 3 of 3; not measured over a day on a real home.

## Not built

- Mob grinding (a spawner or a dark room as a source).
- The Nether trip for quartz (survival.md "Quartz and the Nether"): on a generated Nether a median of about 220
  quartz ores lay within 32 of a site and some within 16 at 6 of 10 sites; `!mine quartz_ore 5` took 15 to 111 s for
  15 to 18 points (about 1 200 to 8 600 uses an hour while it lasts; a whole elytra is about 63 ores). Not built: a
  `!mend` source would need the portal trip as one job, a bounded stay and the Nether's mob hazards (ghast fireballs,
  lava edges, fortresses, piglins and gold) measured with the bot's rules, which they are not; a death there costs
  the piece being mended.
- The ore orbs picked up within two ticks of the break (one point in seven): a hold before the break would change the
  tool the server breaks with.

## Consequences

The elytra and every Mending piece the bot carries are renewed by what the bot does anyway (cooking, smelting) and on
request by `!mend`; the K4 spare swap stays for an elytra without Mending. A held piece costs a hotbar slot for at most
3.5 s at a take.
