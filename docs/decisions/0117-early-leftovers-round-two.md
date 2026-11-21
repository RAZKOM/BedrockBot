# 0117: A gather after a stopped pause, the cooker's timeout, the walk out in the morning (Track E11)

Date: 2026-11-20. Status: accepted. One new setting, `morningWay`, off by default. The gather fix and the cooker fix
are fault fixes; the job's cook retry (`OBTAIN_COOK_RETRIES`) tries a step once more and changes no body rule. Details
and numbers: [../early-game.md](../early-game.md) "Early-game leftovers, round two (Track E11)" and
[../food.md](../food.md) "The batch's time".

## Context

Tracks E9 and E10 left three faults from their runs:

- **A gather that never starts.** After Track E10's flight case the next `!get oak_log 2` showed `gather 0/2 logs
  (find, 0 trees)` for 90 s and logged nothing after its start (3 of 3 on the tree before E10, 3 of 5 after).
- **The cooker's timeout.** On a river bank's iron kit the last step, `!cook` with 2 beef, ended `cook: timeout in
  the furnace` 30 s after the furnace opened, so the job ended `stopped` with the whole kit made.
- **The morning.** With `jobMorning` on, what does not burn or stands in shade is still within 16 to 32 blocks when
  the wait's bound (2000 of the day) runs out, and the job's first walk goes straight through it to the mine.

## Decision

1. **A new gather run never inherits a pause (`tasks/gatherWood.ts`).** The afk task keeps one `GatherWoodTask` for
   every `!gather`. The flee process pauses a gather (`halt('pause')`); a gather stopped while paused (the job's
   flight rule, `!get stop`, `!gather stop`) left `paused` set, and the next run waited in its loop for a resume
   that never came. `start()` and `stop()` now clear the pause. The cause is in the log line itself (`processes
   gather 0/2 logs (find, 0 trees); ... said get: nothing to stop | stopped (was fleeing)`).
2. **The batch's time (`skills/food/cook.ts`).** When the batch's deadline (count x 200 + 200 ticks) passes with input
   left, the cooker no longer returns at once: it reads the fuel slot and the furnace's light, takes the output and
   the input back, and says `no_fuel` when the fuel ran out (nothing in the slot, the furnace unlit) and `timeout`
   only when the furnace is still lit or holds fuel. Before, a fuel shortage whose last item ran into the deadline
   (the server's cook a poll or two behind the bot's clock) said `timeout` and left the cooked item in the furnace.
   The river run's own cause was Track E9's tree: it put in the 1 plank (1.5 items) as the best-ranked kind with
   6 logs carried, had no second fuelling, and checked the deadline before the fuel. Track E10's fuel plan already
   fixes that inventory; this rule closes the race that remains.
3. **The job tries a cook or smelt step once more (`OBTAIN_COOK_RETRIES` 1, `chat/commands-kit.ts`)** when the step
   gained nothing and its reply says `timeout in the furnace` (or another furnace) or `request failed`, as
   `OBTAIN_CRAFT_RETRIES` does for a craft: a furnace timeout or a refused request clears; a `no fuel` does not, and
   is not retried. The end line says it (`cooked again after a furnace timeout`).
4. **The walk out in the morning (`morningWay`, off; `chat/kit-morning.ts` `morningWayRadius`).** When a job that
   waited out a night goes on, for `MORNING_WAY_MS` (120 s) the navigator's mob avoidance (`avoidMobRadius`, 4)
   is widened to `MORNING_WAY_RADIUS` (16) through the survival kit's overrides, and put back after.
   - Chosen over a longer wait for creepers only (Track E9's held mornings were held by zombies in shade, husks,
     skeletons and witches as much as creepers, and a wait does not move them) and over a line alone (it changes
     nothing the bot does).
   - The zones stay passable: a goal inside one is still reached; the planner only prefers a way that keeps 16
     from the hostiles it knows when it plans. No fight rule, no flee rule and no navigator code changes.
   - It applies after every night the job waited out, not only when something is near at the shelter: the first
     fresh-world morning measured was ended by two skeletons about 90 blocks out at the mine, in no census taken at
     the shelter.
   - Off by default: it was measured with the night shell and `jobMorning` on, as Track E9's rule was.

## Consequences

- A gather stopped while the flight held it is followed by a gather that runs.
- A cook or smelt step that ran out of fuel says `no fuel` with what it cooked, the furnace emptied; a job's cook or
  smelt step that timed out is tried once more.
- With `morningWay` on, the walk out of the shelter can be longer (the e2e: 7.0 s against 5.4 s for 26 blocks), and
  a goal inside a zone is reached through it. In the e2e the bot passed a zombie on its line at 15.0 to 15.2 blocks
  (4.8 with the setting off, 3 of 3 each).
- On fresh worlds (n6 a side) the walk kept a wider berth (the nearest hostile on it: median 3.1 blocks before, 5.6
  after) but the deaths did not change: 2 of 6 in each arm, all at the mine on the river world, where the step's goal
  is. So it stays off; the next lever is the mine itself (what stands at the goal), not the way there.
- Not proven: anything on the Realm; `morningWay` without the night shell; a mob above or below the walk by more
  than 3 blocks (the avoidance's height window); mobs the bot has not been sent yet when the walk plans.
