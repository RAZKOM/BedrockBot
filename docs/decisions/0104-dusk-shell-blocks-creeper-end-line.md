# 0104: A job at dusk, the shell's blocks, a creeper in reach, the end line (Track E7)

Date: 2026-11-19. Status: accepted. One setting is on (`jobDusk`: a `!get` job waits out the night where the night
rule already takes the bot, or where the job itself can shelter, and works on where there is nowhere). One is off
(`shellBlocks`: it digs the ground). One code switch is off (`creeperReach`: measured, better in no cell). The end
line's change has no switch. No survival rule is loosened. Details and numbers: [../early-game.md](../early-game.md)
"Dusk, the shell's blocks, the end line" and [../pve.md](../pve.md) "A creeper in reach".

## Context

Track E5 ran the early chain on five fresh worlds (ADR 0103). The iron kit finished in none of 10 runs, and 19 of 25
deaths were arrows:

- **A job does not stop at dusk.** 6 deaths came in a step that ran into the evening. With a shelter set the night
  rule takes the bot there and holds it, with the step paused under it; the step's 10 minutes run on, and the job
  ends in the night (`stopped`) or with the bot (`stopped by a death`). With no shelter set the job works through the
  night on the surface.
- **The night shell had no blocks.** The shell (ADR 0098) needs 10 throwaway blocks. In 5 of 10 nights there were
  none: a death drops them all, and nothing gets them back.
- **A creeper in reach.** One death by day in a mine step: the reflex struck a creeper next to the bot and the blast
  killed it from 18 health.
- **An end line was lost.** A job's `stopped` line came in the same second as its last step's reply with the chat
  rate limit full: the owner saw neither.

## Decision

1. **A job's step ends at the night rule's dusk (`jobDusk`, on; `chat/commands-kit.ts`, `chat/kit-night.ts`).**
   - While a step that walks or waits runs (a mine, a gather, a hunt, the food step, a smelt, a cook, a walk to a
     herd), the job looks at the clock with its other checks. At the night rule's own dusk (12000) it ends the step.
     Crafts, the furnace and the bed are short and run on; the pause then comes before the next step.
   - The job keeps its targets, steps, notes and caps. A step ended this way caps nothing and is no dead end.
   - It says where the night is spent and waits until the night is over and the night process has let go (asleep, the
     shell's dawn wait): `get kit iron: paused for the night at step 6 (mine iron_ore 33: 15 of 33), at the shelter
     10 64 3; resuming at dawn`.
   - At dawn it takes the output of a smelt the dusk ended (the furnace smelted on; Track E4's collect), says `get kit
     iron: dawn: going on (paused at !mine iron_ore 33)`, and plans again from what is carried. The end line carries
     `paused for N nights`.
   - A job started by night runs on and pauses at the next dusk. A death or the owner ends the wait as they end a
     step.
2. **Where the night is spent (`shelterPlan`).** In this order:
   - a bed where the night rule sleeps (`autoSleep`);
   - the shelter; home when no shelter is set (the night rule's shelter is set to home for the night and put back at
     dawn). The night shell walls in there when `nightShell` is on, as it does for an idle bot;
   - with neither: the nearest enclosed spot the bot can walk to (`enclosedSpot`: a floor, a roof that is no tree
     within 6, at most 2 of the 8 cells round the body open; found by a flood over standable cells from the feet, so
     a pocket behind rock is never chosen), else where it stands when the night shell will wall in there (`nightShell`
     on, its blocks carried, the open sky over it);
   - else nowhere: the job works on tonight, as it did before, and says so at its end (`worked through a night
     (nowhere to shelter)`). Standing still in the open or in a cave is no safer than working.
   - When the night rule gives the walk up (3 tries), the plan is made once more from where the bot stands; with
     nowhere there either, the pause ends and the job goes on.
   - The step the job ends cancels the walk the night rule had just begun. That try does not count
     (`NightSafety.retryNow`): measured, it cost `shelter unreachable (interrupted), attempt 1/3` and 60 s in the open.
3. **A shell over a hole opens by a step up (`shellStepOut`, `tasks/night-shell.ts`).** The night shell opens a
   side at dawn only where both of its cells are its own. A body in a hole has a wall that was there at the feet on
   every side, so only one head cell was dug and the body stood under its own roof: inside the base (never dug) it
   could not leave, and a job that had waited there stopped at dawn. When no side opens at the feet, the shell now
   digs the head cell of a side, its roof and its block over that side's head cell (its own blocks only) and the body
   steps up.
4. **The shell's blocks (`shellBlocks`, off; `skills/survival/shell-blocks.ts`, `tasks/shell-refill.ts`).**
   - The reserve is the shell's own count on open ground: 10 (9 cells and the roof's support), of the kinds the shell
     places.
   - Short of it, the bot digs the shortfall near itself: dirt kinds by hand, stone kinds with a pickaxe the worn-tool
     rule allows. A cell qualifies when its top is open, it is not under or next to the feet, no liquid touches it, it
     is no built block and it lies outside the base (the navigator's protected area round home).
   - Inside the base nothing is dug: the bot walks out by branch mining's ways out (ADR 0103) and digs there.
   - A job digs before dusk (from 1200 ticks before it, once a day, ending its step), first after a death it goes on
     from, and before its end line (`dug the night shell's blocks`, or `the night shell N blocks short`).
   - The blocks chore (`blockschore`, the chores' priority) digs by day when nothing else runs and no hostile is
     within 16: after a respawn (before the walk home), and the morning after a death in the night. A refill that
     ends short waits 5 minutes.
   - Nothing is dug within 4 of the night rule's shelter (the shell needs its floor: a hole dug beside the shelter
     left 2 of its cells open), and the floor of a hole is never dug (holes stay one deep).
   - It is off because it digs holes in the ground on its own.
5. **A creeper in reach (`PveRules.creeperReach`, off).** The reflex's strikes stay as they are, and the back-off that
   was built ships off: ADR 0079 decisions 70 and 71.
6. **The end line is kept (`Chat.sayKept`).** A job's end line that finds the rate limit full, or the bot not
   spawned, is kept (4 lines at most, 2 minutes each) and sent as soon as a slot frees, in order. Every other reply
   is dropped as before.

## Consequences

- Measured on three fresh worlds, two runs a side, dusk in the job's first mine step (early-game.md): deaths at dusk
  and in the night during the job 2 of 6 before (arrows at the open shelter) and 0 of 6 with `jobDusk`, `nightShell`
  and `shellBlocks` on; lowest health of that night 0, 4, 9, 0, 20, 3 against 20, 20, 16, 20, 20, 10; the job went on
  at dawn in 6 of 6. The shell closed fully in 2 of 6 nights before and 7 of 12 after. 2 of the 6 after-runs lost the
  bot in the first minutes of the next day, on the way back to the mine (an arrow, a witch); none before.
- What still keeps a shell open is terrain, not blocks: a side with nothing to place against (a river bank, 6 of 6
  nights there) and the cell over the job's own crafting table.
- With a shelter, a home or a bed, a `!get` job that reaches dusk goes on the next morning instead of ending in the
  night. The body does at night what the night rule already did with it; with home only (no shelter) the bot now
  walks home at dusk during a job.
- `jobDusk` alone does not keep arrows off a bot at an open shelter. That takes the night shell (`nightShell`, off)
  and its blocks (`shellBlocks`, off): measured together in early-game.md.
- A job that runs over several days carries its state across the nights; `!get status` says `paused for the night`.
- With `shellBlocks` on the bot leaves one-deep holes outside the base, 10 a refill at most.
- Not changed: the night rule, the night shell's rules, the reflex, the flight on foot, `!gather` / `!mine` typed by
  an owner (they are paused under the night rule as before).
