# 0101: The obtain job through wear and setbacks (Track E4)

Date: 2026-11-18. Status: accepted. The worn-tool rule in the plan, the held table and the remembered furnace are on
(they change no survival rule); `deathReturn` (walking back to a death spot) is off by default. Details and numbers:
[../early-game.md](../early-game.md) "Wear and setbacks".

## Context

Track E2's fresh-world runs of `!get kit iron` (ADR 0099) ended short or stopped for reasons that were not the
world's: a stone pickaxe worn out at 30 of 33 iron ore left the helmet off (`short: iron_helmet (!mine iron_ore 33 got
30)`); a run stopped with both pickaxes worn before the coal; with no home a furnace the bot had walked away from was
not found again and a second one was crafted; a crafting table was left standing once, and E1 saw the job craft a
second table when the first one's drop had not been picked up yet; and a death in any step ended the job with the raw
iron in the furnace and the drops on the ground (`!smelt raw_iron 33 got nothing`).

## Decision

1. **A worn tool is not carried for the plan (`skills/items/wear.ts`).** The obtain planner plans on the inventory
   with every item the worn-tool rule refuses (`toolWearLimit`, a Mending item set aside) left out. A step that needs
   a tool then gets a fresh one through the planner's own pickaxe rule, crafted from what is carried or cheap to get:
   3 of the kit's cobblestone for a stone pickaxe, planks for a wooden one, the iron pickaxe once there is iron. A
   worn tool is never an ingredient, so nothing else changes. The worn one stays carried.
2. **The job ends a mine step at the limit, and that caps nothing.** The digger takes the selected slot when every
   tool is refused, and the miner's composite mode checks the pickaxe only when no candidate is left, so a worn
   pickaxe in hand digs on to the end (measured: 13 uses left, 5 ore, 8 left after). The job watches its mine step:
   once no usable carried pickaxe harvests the step's block (one did at the start), it stops the step, and the next
   plan replaces the pickaxe and mines the rest. Plain `!mine` is unchanged (that is a miner and digger change for
   every caller, left for a track of its own). The soft targets of ADR 0099 (decision 6) are not dropped for a step
   that ended on wear, and a worn-out step that got nothing does not end the job. The end line says `replaced the
   stone_pickaxe (worn)`.
3. **The job's crafting table stands between its crafts.** While a job runs the crafter keeps a table it sets down
   standing (`holdTables`), uses it again within 16 (walking back to it), and the plan counts it as carried (the kit's
   own table target no longer crafts a second one). The job picks it up before a step that walks off (gather, mine,
   hunt, food) and when it ends; within 16 of home it stays, as the home's table. A dug table whose drop did not come
   into the inventory is looked for again wider and longer (6 blocks, 200 ticks, before 3 and 100). A stopped job
   (`!get stop`, an owner command) leaves its table to the next craft near it, as before.
4. **The furnaces the bot sets down are remembered (`skills/items/placed.ts`).** The smelt commands record every
   furnace `placeFurnace` sets down; one that still stands within 64 of the bot is offered with the cooker's own (16 of
   home, or of the bot) and the smelt opens it first. With no home, the walk to the coal no longer costs a second
   furnace. `!furnace`, `!cook` and `cookFurnace` keep the cooker's 16 (a cook does not walk 64 blocks to a
   furnace). The memory is task state (a restart forgets it).
6. **Two retries the held table brought out.** A fuel move into a furnace still burning from the last smelt is tried
   once more after 10 ticks, and a table click left unanswered while the armour pass moved an item is sent once
   more. Both were seen in the iron kit's e2e, which ran 90 s faster with the table held.
5. **A death in a job (`deathReturn`, off).** Off: the job ends `stopped by a death (cause) ... (at !step)` and names
   the furnace that holds the smelt. On: the job holds the afk task's walk home after the respawn
   (`respawnClaimed`, now shared by the test harness and the job), and once the respawn settled it walks back by the
   normal nav as a user process (`recover`: the flee, a guard fight and the night rule pre-empt it) when all of these
   hold: the death spot known and not in the void, the cause not lava, fire or the void, by day with a minute of
   daylight left, within 160 blocks of the respawn point, the drops not despawned on arrival (5 minutes from the death,
   at 3 blocks a second), at most 2 returns a job. It picks the drops up within 8 of the spot, then takes what the
   furnace of a stopped smelt holds (nothing more is put in), and the job goes on from the inventory (`recovered 5 of
   5 stacks in 21 s`); not going, it says why and the walk home goes as before.

## Consequences

- The obtain job finishes runs it used to cut short on wear, and it says what it replaced, reused, picked up and
  recovered. The plan may craft a tool the owner did not ask for (a stone pickaxe for 3 cobblestone); the kit's
  cobblestone is mined again when it falls under 16.
- A table stands in the world while the job crafts, and after it ends when the pick-up failed or the table is more
  than 24 blocks off (the end line names where); by home it is left on purpose.
- `deathReturn` walks the bot back to where it died. The death may have come from something still there by day (a
  shaft fight, Track E3's part); the walk keeps every survival rule, and the setting ships off until runs on real
  terrain show it does not lead to a second death.
- Not covered: a death outside a job (nothing walks back), the nether and the end (the death spot is taken as in the
  overworld), items in an unloaded chunk (they do not despawn until loaded, the rule still assumes 5 minutes).
