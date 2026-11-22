# 0124: Block states: the builder places every block as the build says (Track B1)

Date: 2026-11-22. Status: accepted. No new setting. Details, the rules per family and the refusals:
[../build.md](../build.md) "Block states".

## Context

The builder (ADR 0033) placed a structure file's blocks by name: stairs, logs, slabs and every oriented
block got whatever the clicked face and the bot's yaw gave, verification compared names only, and
redstone parts, doors, beds and tall plants were refused. A file saved from the game names every
block's states, and a build that ignores them is not the build (a stair the wrong way round, a door
on the wrong hinge, a repeater with the wrong delay).

On Bedrock a placement's states come from the `inventory_transaction` click (the clicked block and
face, the point on the face, the player's position) and the view in the last `player_auth_input`;
the server does not check that the view meets the clicked face. Several rules differ from Java and
from what the wiki says (a piston faces the way the player looks, a door's facing is a quarter turn
from the view, a door's hinge never follows the click point, a lone rail is north-south with every
view), so every rule was measured before it was written down.

## Decision

1. **Measure each rule** with raw clicks (`build-measure` e2e on a flat test server: a chosen face,
   point, view and eye position; each placement read back with its states) and keep only what was
   seen. The rules are one table, `skills/build/states.ts` `placementOf`: for a block and its states,
   the item, the faces that may be clicked, the click's half, the view's cardinal, axis or exact yaw,
   where the eye must be (six-way blocks), whether the support may be a scaffold, the states checked
   right after the click, the states after merges and taps, the states that follow the neighbours,
   and the cells it fills besides its own.
2. **The planner chooses the click.** A stand is kept only if a click from it gives the states
   (`chooseClick`: an allowed support in reach, a natural look in the needed quadrant with 12 degrees
   to spare, else a turned view sent with the click). A turned view costs 2.5 in the stand choice,
   so natural looks win when they are close. Six-way blocks facing up or down need a stand over or
   under the cell (a scaffold column for up). Cells whose allowed support the build fills later wait
   for it; attached blocks never hang on a scaffold.
3. **The runner clicks at the point and verifies the states.** Right after the click: the name and
   the chosen states, and the other cells of a two-cell block; then the merges (a click on the
   placed block itself with the same item: double slabs, candles, pickles, snow) and the taps (a
   repeater's delay, a comparator's mode, open doors, trapdoors and gates, a lever on); then the end
   states. A wrong block is dug and placed again (three attempts in all, then kept and reported).
   After the last step every placed block is checked again with the states that follow the
   neighbours; a rail with another shape is placed once more, the rest is reported in the end line.
4. **Two-cell blocks** (doors, beds, tall plants) are one step on their main cell (a door's or a
   plant's lower cell, a bed's foot), with the other cell blocked in the plan and verified after the
   click. Doors come after every other block but the power sources: their hinge follows the
   neighbours at the click (measured: a door beside, else the side with more full solid blocks), and
   when the build's own neighbours would give the other hinge the planner adds scaffold blocks on the
   side that gives the right one and digs them right after the door.
5. **Ordered redstone.** Power sources (redstone torches, redstone blocks, daylight detectors,
   observers, sculk sensors, a lever the build wants on) go after everything else, a lever is placed
   off and switched on by its last tap, and TNT in a build with a power source is refused. Built in
   that order the circuit stays still until its last block, so no piston extends into a cell the
   build fills next, no observer pulses into its neighbours and no repeater changes its name under
   the bot. Power states are not verified and a circuit is not checked to work: that would need its
   intended behaviour, which a structure file does not say.
6. **Refusals with a reason per block.** What no click gives (a hopper facing up, a head facing
   down), what was not measured (vines and other one-face-per-click blocks, coral fans, more than one
   turtle egg, mushroom sides, a hanging sign on a chain, a bell between two blocks), what grows
   (crops), what has no item or is not a block a player places (liquids, portals, fire, bedrock,
   command blocks ...), and block entity data (banners). A structure file builds the rest and lists
   the refusals in its plan line and `!build materials`; a block typed by name that is refused
   refuses the build, and doors, beds and tall plants typed by name need a structure file.
7. **Rotation turns the states** (`rotateStates` in `placeStructure`): every direction-like state.
   It is the one turner for every format: Track B2 (decision 0125) wrote its own (`formats/rotate.ts`)
   for the Java files at the same time; when the tracks met it was folded into `rotateStates` (its vine
   bits and portal axis) and removed, and the readers hand over unturned states, so no state is turned
   twice (a unit test and the e2e build a turned `.schem` with stairs against hand-written states).
8. **The truth pack compares states** (`truth:blocksdiff` palette entries `name[k=v;...]`, the old
   form unchanged; `truth:blockstates` reads a box with every state), so the e2e checks a build cell
   by cell and state by state against a structure the server itself placed.

## Consequences

- A structure file's stairs, slabs, logs, doors, beds, repeaters, pistons and the rest come out as
  saved, turned with the file; the e2e builds a fixture of every family at 0, 90 and 180 degrees
  and compares every chosen state (build-states).
- Plans have more stand changes and some turned views (`turned` in the plan log); a structure with
  oriented blocks takes longer than the same cells by name: 40 stairs, slabs, logs, furnaces and
  pumpkins 16 s before (31 of 40 with other states) and 25 s after (0 of 40). Blocks by name take
  the old path (a 75-block fill 56 s before, 57 s after).
- Not chosen and not verified: power, age and contents states, block entity data (a container is
  placed empty, a sign blank, a bed in the colour of the bed item held), a floor head's rotation.
  Connections (fences, walls, panes, dust) and rail shapes follow the neighbours and are only
  verified at the end.
- A door whose hinge needs scaffold cells that the build or a liquid holds takes what its
  neighbours give, and the plan says so.
