# 0100: A mob in the shaft, the furnace wait, a bed (Track E3)

Date: 2026-11-18. Status: accepted. The blade strike (`PveRules.bladeStrike`) is on; `!bed`, `!get bed` and the iron
kit's bed step are on (commands); the food hunt leaving the sheep a bed needs is on; the smelt shell (`smeltShell`)
is off. Details and numbers: [../early-game.md](../early-game.md) "A mob at the top of a shaft", "The furnace wait",
"A bed"; [../pve.md](../pve.md) "The blade strike".

## Context

Track E2 (ADR 0099) measured `!get kit iron` on a fresh world and left three deaths and gaps:

- A death by day in the mine step: the walk pillared up a one-wide shaft it had dug, a zombie came down it, the bot
  went from 20 to 0 in 6 s. The reflex (ADR 0079) struck it 14 times, but with the cobblestone the pillar held (0.9 a
  strike against a zombie's 20); guard was off and the flight found no way out of the shaft.
- A death at the furnace at dusk 186 s into a 33-item smelt (arrows, a witch's poison, a creeper): the bot waits by
  the furnace with the window open (ADR 0099 decision 3), in the open, and with no home or shelter the night rule has
  nowhere to take it.
- No bed: every death of Tracks E1 and E2 was at night, the night process sleeps in a bed it finds near the shelter
  or home but nothing set one down, and the food hunt took the sheep before `!kill sheep 3` looked.

## Decision

1. **The reflex strikes with the blade (`bladeStrike`, on).** A reflex strike made while the hand holds a block, a
   digging tool while no dig runs, or nothing, is made with the best sword or axe in the hotbar: the slot is swapped
   for that strike and back, all before the job's next action. Never during a dig, while eating, with a blade held,
   with an item that works by holding it, or in guard's or a flight's own fight (they choose their weapon). The other
   choices for the shaft, a stop of the climb or a block over the head, change what the walk does on every pillar;
   the strike only changes what a strike already made hits with. Measured on a replica shaft, 5 runs a side, and on
   the gauntlet's live-kit rows, 15 a side (no change there: the live kit holds a sword).
2. **The furnace wait: the night rule leaves, the smelt shell is the option (`smeltShell`, off).** With a home or a
   shelter set, the night rule already takes the bot there at dusk; the furnace smelts on and the smelt resumes at
   its furnace after (ADR 0099 decision 5). That is the "load and leave" way; its one fault, found measuring it, is
   fixed: at dawn the night process let go while its night shell was still shut (the dawn wait, the dig), and the
   resumed smelt planned from inside the shell and ended `unreachable`; the night process now keeps control while
   its shell is shut (bounded by the shell's own dawn wait). With neither
   set there is nowhere to leave to: with `smeltShell` on, a smelt that will not end before dusk (200 ticks an item
   plus 400 against the ticks left) or one started by night, with no shelter or home within 16 of the furnace, waits
   in Track M1's shell on a cell next to the furnace (the furnace is one of its walls, so the window still opens; the
   cell over the furnace gets a brace on its diagonal first, since a click on the furnace's top opens it),
   and digs one side it placed open at the end: by day at once, by night at dawn, with a hostile within 16 then up
   to the night shell's dawn wait. It ships off because it builds and digs (the rule for anything that can strand
   the bot).
3. **A bed (`!bed`, `!get bed`, the iron kit's bed step).** `!bed` sets the bed carried down where the night rule
   will find it: by home when one is set (the bot walks within 3 of it), else by the shelter, else where it stands,
   with the `bed` waypoint set there (an owner's own waypoint is kept). The spot is a pair of cells beside the
   centre with a full top under both, free or holding a cover that is dug first. By day the bot clicks it once: the
   click is refused (not night) and the server moves the spawn point anyway. `!get bed` is an obtain job: the wool
   from sheep (`!kill sheep 3`; with none within 32 it walks to the nearest remembered flock, twice at most), the
   craft, then `!bed`. The iron kit gets the bed as its last, soft step, planned only once the other targets are met
   or dropped (`ObtainTarget.last`; planned with the rest, its logs and sheep came first and the e2e kit took 575 s
   against 274).
4. **The food hunt leaves the bed's sheep.** With no bed known (where the night rule looks) or carried, the hunt
   leaves 3 wild sheep less the wool carried of one colour (`sheepForBed`), on top of `foodLeave`.
5. **The job never dyes.** A recipe with a dye in it (a `_dye`, bone meal, ink, cocoa, lapis, a dye tag) is left out
   of the obtain job's plans (`noDyeRecipe`): on the server's full recipe set each wool colour and each bed re-dyes
   from the others, and the chain planner tried them all for every plan, 15 to 53 s with the event loop blocked
   (nothing in the unit fixtures has those recipes). `!craft` keeps every recipe.
6. **Shears are not used.** A sheep sheared gives 1 to 3 wool and lives; the kill gives 1 and is food. The job kills;
   shears are for a later track (they need 2 iron the kit would rather spend on armour).

## Consequences

- Measured (docs/early-game.md): the shaft replica with obsidian walls 0 of 5 at the top with the rule off, 5 of 5
  with it, no damage; the gauntlet's live-kit rows unchanged (15 a side); the smelt by night with mobs, 5 runs a way:
  in the open 2 deaths, walled in 0 and no damage, leaving for a walled-in shelter 0 and no damage (after the dawn fix); the bed on a fresh world 4 of 4 made (83 to 146 s before the dye rule, 54 s after it), 7
  nights slept and skipped, 0 deaths, against 2 deaths in 3 nights without one.
- The reflex now changes the hotbar slot for a strike. A job that reads the held item between its own actions sees
  its item back (the swap and the restore are queued in the same tick). Guard's own fight is unchanged.
- The smelt shell leaves 8 of its 10 blocks next to the furnace (one side dug open); nothing takes them down.
- A bed set down stays. The spawn point moves to it at once (by day), so a death after `!bed` respawns there.
- The herd walk is a goto inside the obtain job (two at most, a minute or two); a flock the bot has not seen is not
  found, and the job stops as before (`!kill sheep 3 got nothing`).
- Not covered: the shaft's other two ways (stop climbing, block the top); a shell that also covers a second furnace;
  wool from shears; a bed carried on trips (`!trip`); a bed near the furnace when home is far.
