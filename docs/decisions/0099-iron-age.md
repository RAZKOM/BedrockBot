# 0099: The iron age from the stone kit (Track E2)

Date: 2026-11-17. Status: accepted. `!furnace`, `!smelt`, `!get iron_ingot`, the iron items through `!get` and `!get
kit iron` are on (commands); `cookFurnace` (a furnace made for the cook step) is on. Details and numbers:
[../early-game.md](../early-game.md) "The iron age".

## Context

After ADR 0098 the bot gets the stone kit from nothing, but nothing past it: `!get iron_pickaxe` was refused (`it
needs iron_ingot`), all food stayed raw (`cook: no furnace or smoker within 32 blocks`), and `!craft furnace` with 8
cobblestone and logs but no table carried ended `craft: made no furnace (no_table)`. Iron gates the bucket (milk, ADR
0096), the shield, iron tools and armour. The cooker (`skills/food/cook.ts`) already drove a furnace's window
(ingredient, fuel, output) for food.

## Decision

1. **The cooker smelts (`skills/food/smelt.ts`).** One table of what a furnace makes of what (raw ores, sand,
   cobblestone, clay, logs to charcoal; food as before), which block takes what (a smoker food only, a blast furnace
   ores only, a furnace both), 200 ticks an item in a furnace. `Cooker.cook` takes the inputs to put in, a limit and
   the furnace kind the input needs; the fuel rule is the cooker's (`planFuel`: coal 8 items, planks and logs 1.5).
2. **A furnace goes where the cooker looks (`skills/food/furnace.ts`).** With a home: the bot walks within 3 of it and
   sets the furnace down next to its feet (the crafting table's spot rule, ADR 0098); without one, next to the bot.
   One that stands there already is used, never a second. `!furnace` does this (crafting it from 8 cobblestone when
   none is carried), `!smelt` first when none stands there.
3. **The bot waits by the furnace.** `!smelt` keeps the window open while the items smelt and takes the output as it
   comes (10 s an item: 33 raw iron is 5.5 minutes). The other choice, walking off to the next step and coming back,
   needs a second trip and a furnace that is not lit by someone else in between; it is not built.
4. **The obtain job smelts (`skills/items/obtain.ts`).** A smelted material is its raw input mined (one `!mine` step
   for all of it), then the furnace (a target of its own: crafted, then `!furnace`), then the fuel, then `!smelt input
   n`. The fuel is the cheapest that is near: what the crafts leave of the fuel carried (no more than is carried now:
   planks the crafts would make from a log are not counted, the furnace may burn that log); then coal when a coal ore
   is known within 24 and a carried pickaxe harvests it (`!mine coal_ore n`); then planks from the logs left (`!craft oak_planks n`: a log is 6 items as
   planks, 1.5 as a log; charcoal is not made: 8 items a log but 10 s in the furnace each); then logs. The fuel for the
   raw food carried comes in the same step; once a furnace stands, raw food is cooked (`!cook`) before the job counts
   its food.
5. **`!get` routes the smelted items to the job.** `!get iron_ingot [n]` (and `gold_ingot`, `copper_ingot`, `glass`)
   is the obtain job's; `!get iron` still mines raw iron. Iron items (`!get iron_pickaxe`, `bucket`, `shield`,
   `iron_sword`, the armour) chain through it; a pickaxe tier needs the one below (an iron pickaxe from nothing:
   wooden, stone, iron).
6. **`!get kit iron` (`iron kit`).** An iron pickaxe, an iron sword, a shield, a bucket (9 ingots), the four armour
   pieces (24 more) as soft targets, 16 cobblestone kept, 6 food. The job asks for the ore of every target in one mine
   step; when that step comes back short, each soft target the iron carried no longer covers is dropped and the end
   line says which and why (`; short: iron_chestplate, iron_leggings, iron_helmet (!mine iron_ore 33 got 13)`). A mine
   step for soft targets that reaches the 10-minute step limit ends with what it got instead of stopping the job. A
   food step that gets nothing ends the iron kit done with the food short even with none carried (the stone kit's food
   is eaten during the mine and the smelt).
7. **Worn counts as carried.** Armour worn and the shield in the offhand count for the targets and for a step's gain:
   the armour pass (docs/survival.md) puts the armour on, and the shield goes to the offhand, right after the craft.
8. **A 3 x 3 craft with all its materials but no table carried or near chains the table** (`!craft`, so the job too).
   When no cell round the feet is free or clearable (a one-wide tunnel whose open cell the furnace took), the table
   goes into a dug wall cell: a side cell of natural stone or soil a carried tool harvests, not built, a full top under
   it, nothing falling or liquid over it, no liquid next to it.
9. **`cookFurnace` (on).** `!cook`, and the food hunt when the bot is within 64 of home or has no home, set a furnace
   down when raw food waits and none stands near: one carried, or crafted from 8 cobblestone (the hunt keeps the 16
   the night shell needs; `!cook` uses any).
10. **A paused smelt goes back to its furnace.** A flee or a guard fight closes the window with the input in the
    furnace; the resume opens that furnace first, even with nothing left to put in, waits out what is in it and takes
    the output. The limit counts what was put in, not only what came out.
11. **A timed-out ore takes its vein with it.** A mine goto that times out with no segment skips, for the run, the
    same ores touching the closest one (they are as unreachable as it; measured: 8 of a 10-minute step lost to one
    vein).

## Consequences

- From the stone kit the bot reaches iron tools, a shield, a bucket and the armour the ore allows with one command;
  the numbers on a fresh world are in the doc (10 runs: 3 of the last 7 done, 4 with every hard target, 2 deaths,
  one at the furnace at dusk, one in a shaft in the mine step).
- The furnace stays standing where it was set down (near home it is the home's furnace from then on). Without a home
  a furnace is set down wherever the job smelts, and a later job with a home does not find it.
- The bot stands by the furnace for the whole smelt; a hostile near during it is the guard's (the smelt is a user
  process at priority 40 and resumes).
- Mining iron is the existing `!mine` (ADR 0005 and docs/mining.md: buried ore is found by the scan, branch mining
  when none is found); nothing digs down in a new way. The table's wall cell (decision 8) is one block dug sideways
  at the feet's height, only when no other cell fits, never under the bot; it ships on with `!craft` (a command).
- Not covered: smelting while doing something else, blast furnaces and smokers made by the bot, charcoal, a second
  furnace for speed, diamonds (the job would plan them: `pickaxeFor('diamond_ore')` is now the iron pickaxe, untested).
