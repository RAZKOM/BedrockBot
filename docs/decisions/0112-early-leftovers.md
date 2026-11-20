# 0112: The night shell's open sides, the cook's fuel, sheep for the bed, a step lost to flights (Track E10)

Date: 2026-11-20. Status: accepted. No new setting. The shell's supports place blocks only where the shell
(`nightShell`, off) already places them, and only to close a cell it would have left open. The second fuelling is a
fault fix. The search walk is the work of a typed command (`!get`), bounded and by day. The flight count changes no
rule of when the bot flees. Details and numbers: [../early-game.md](../early-game.md) "Early-game leftovers
(Track E10)" and [../food.md](../food.md) "Fuel for the whole batch".

## Context

Tracks E5 and E7 left these from their fresh-world runs:

- **The night shell left open.** A side by a river bank was never placed (6 nights of 6). The cell over the job's
  own crafting table stayed open. A death in the night left the rest of it without blocks.
- **The fuel plan.** A cook step said `no fuel` with logs still carried.
- **No sheep near.** `!get bed` found no sheep within 32 after its two herd walks in 3 of 10 runs.
- **Flights pre-empting a step.** Skeletons in the shade kept the gather paused until its 10 minutes ran out, and no
  reply named the cause.
- **`!get status` after a job.** It named the last plain `!get` instead of the job that had just ended.

## Decision

1. **A face for every shell cell (`skills/survival/seal.ts` `faceSupports`).** A block goes in only against a solid
   neighbour the server lets the bot click (not air, not a plant, not a crafting table or a furnace, which open on a
   click).
   - The cells are ordered so each has such a face, in the world or in a cell placed before it.
   - A feet-ring cell over a step down gets a support under it first: up to 2 deep, bottom-up, when the lowest has a
     face. This is the river bank: the ground one lower beside the shelter, and grass and air round the cell.
   - A cell over an interactive block gets a corner brace beside it.
   - The night shell, the smelt shell and the reflex's seal pass the world's real faces (`SealDeps.face`).
   - With only the shell's own 10 blocks, the shell is placed as far as they go instead of being refused.
2. **A shell that does not close says why.** The log line names each open cell with its place reason
   (`night shell: 2 cell(s) open (x y z no_face, ...)`), and the shell keeps it (`NightShell.lastOpen`).
3. **A death in the night: nothing new.** Today the bot respawns, the night rule takes it to the shelter, and the
   shell refuses (`0 throwaway blocks for 10 open cells; standing in the open`). `shellBlocks` digs the blocks back
   the next morning. A dig by night near mobs is not obviously safer than standing at the shelter, and it was not
   measured. The rule that exists for this is the bed: the respawn is by the bed, and the night is slept through with
   no blocks. Making the bed reachable (4) is the answer chosen here.
4. **The fuel plan (`skills/food/cook.ts` `planFuel`, the batch loop).** The fuel slot holds one kind.
   - The plan takes the best kind that covers the whole batch on its own (else the one that covers most).
   - An empty slot with input left is fuelled again from what is carried, up to `COOK_REFUELS` (3) times.
   - `no fuel` is said only when nothing burns, nothing cooks and nothing is carried to burn.
5. **The hunt's search walk (`chat/kit-search.ts`, `ObtainController.search`).** This was chosen over a wider look,
   string to wool and a reply alone. On the plains world the sheep stand alone or in twos: 0 to 3 within 32 of where
   a kit ended, and 6 within 128. The desert has none within 256. The server sends a player only the mobs within about
   64 to 80 blocks (a spectator survey over a 64-block grid; a range probe on the test server).
   - A hunt for a job's material that found none within 32, with no remembered herd left to walk to, walks legs
     `HUNT_SEARCH_OUT` (96) out along x and z, `HUNT_SEARCH_STEP` (32) at a time, for at most `HUNT_SEARCH_MS` (300 s).
   - It looks at the mobs the server has sent after each step. The first of the kind seen is walked to, and the hunt
     runs again.
   - It searches once a job. The steps are the job's own `!goto` steps, so `jobDusk` ends them and the job searches
     again by day.
   - The end line says how far it looked: `looked for sheep: walked 412 along the axes in 240 s, none seen`, or `one
     seen 71 off`.
   - String to wool (4 string, `minecraft:string_to_wool`, in the server's data) is not built: an early bot carries no
     string.
   - Measured on the plains world where a kit ended, no sheep within 32, n3 a side: a bed 1 of 3 before, 3 of 3 after
     (38 to 116 s).
6. **A step lost to flights (`chat/kit-flights.ts` `StepFlights`).** While a step runs, the job counts the flights on
   foot (the flee process holding the body) with their time and the hostile kinds near.
   - Each step's record carries them: `!gather 4: 0 of 4 logs in 182 s: 6 flights took 141 s (skeleton)`.
   - A step is ended early as mostly flight when all of these hold: it has run 120 s, it gained fewer items than one
     every 30 s, it had 3 or more flights, and 40 % or more of its time was spent fleeing. The job then stops with that line (`...;
     the step was mostly flight`) instead of using up the step's 10 minutes.
   - Why not the share alone: the flights are short and the walk back between them is lost as well. Measured: 37
     flights in 180 s, 58 % of it fleeing, 0 logs.
7. **`!get status` names the obtain job's end line** when that job ended after the last plain `!get` (cut at 160
   characters).

## Consequences

- On a step down, the shell needs one block more than on open ground: 11 by a river bank. The blocks chore still
  digs 10, so there the cell planned last stays open.
- A `!get bed` or iron kit with no sheep near walks up to 5 minutes more before it gives up, and says so (the iron
  kit's e2e on the flat test server: `walked 592 along the axes in 123 s, none seen`). The note makes the end line
  longer, so its steps list can be cut by the reply limit; the log keeps the whole line.
- A job whose step is pre-empted by flights ends sooner (from 120 s) and names the mobs. The owner decides what next
  (a blade, a shelter, another place).
- Not proven: the shell supports beyond the measured river bank and the flat test server; the search on rough ground,
  in a desert and inside a whole kit job (the plains runs started at !get bed); the flight rule on a fresh world; anything on the Realm.
