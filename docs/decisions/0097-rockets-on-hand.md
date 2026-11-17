# 0097: Rockets on hand (Track R9)

Date: 2026-11-17. Status: accepted. `fireworksKeep` 64 by default; the background craft (`autoRockets`) ships off.
Details and numbers: [../flight.md](../flight.md) "Rockets on hand (Track R9)".

## Context

The bot flies on firework rockets. It refills the hotbar from a carried fireworks box (`fireworksMin`) and takes rockets
out of other carried boxes before a takeoff, but it never made rockets: once the box ran dry every trip was walked. The
materials are cheap and often in storage. On the live world every rocket is a crafted one (flight duration 1), and
the flight already reads a rocket's duration from its NBT.

The bot's recipes are the server's (`crafting_data`). BDS 1.26.60.6 sends for the firework rocket one recipe without a
firework star, `paper_sulphur_recipeId`: shapeless, 1 paper and 1 gunpowder for 3 rockets (it fits the inventory's
2 x 2 grid), its output's NBT `Fireworks {Explosions: [], Flight: 1}`; and paper as 3 sugar cane in a row (3 x 1, a
crafting table). Durations 2 and 3 are only in the multi recipes, which the recipe index does not keep.

## Decision

1. **A target count, `fireworksKeep` (default 64, 0 to 640).** Rockets count once in every carried place: loose, the
   fireworks box, the other carried boxes. `fireworksMin` stays the hotbar's refill line; the refill is the flight's own.
2. **The stock rule (`planRockets`, skills/fly/rockets.ts), the cheapest source first:** rockets out of the home chests
   (at home only), then crafts: gunpowder and paper loose, out of the carried boxes, out of the home chests (at home),
   each through the Supply layer (ADR 0052). Paper from sugar cane only when there is not enough paper and a crafting
   table is carried or near (the crafter places a carried one and picks it up, or uses one standing near).
3. **Gunpowder is never farmed.** With none, nothing is crafted, and `!rockets`, `!rockets status` and `!status` say what
   is missing.
4. **Duration 1.** The one plain recipe the server has; measured against the script API's plain rockets on the same
   400-block flight (flat400, 3 a side, `flyKitBurn` off): 2 rockets a flight against 1, 1 and 2, 499 to 515 ticks against
   441, 441 and 620, all landed within 0.7 with no damage. No measured reason for a longer burn.
5. **The crafter writes the output's NBT.** The recipe output's wire extra data is kept (`RecipeOutput.extra`, `flight`)
   and written onto the slot a craft fills, so the model knows a crafted rocket's duration and a use echoes the item
   whole; a crafted stack never merges onto a stack of another duration (`destinationSlot`).
6. **Crafted rockets go into the fireworks box** when one is carried (`Supply.putInto`, the box rules as they are); with
   none they stay loose. The trip readiness leaves them loose for the flight.
7. **Where it runs.** `!rockets [n] | status` (a user process); the rockets chore (auto, chore priority, `autoRockets`,
   default off): by day, idle, within 16 of home, no hostile within 16, under the target with a step to take; 30 s after
   a pass that gained rockets, 10 minutes after one that did not; it walks home after. The trip readiness gains a
   `rockets` phase: before a long trip that may fly (`autoFly`, an elytra above its worn limit, farther than `flyMin`)
   with fewer rockets than the flight's need (twice the energy model's estimate, never under `fireworksMin`, at most
   `fireworksKeep`) and the materials for a craft carried, it crafts from what is carried. It never walks to storage.
8. **The unloader keeps one craft round** (keep reason `rocket_reserve`): ceil(`fireworksKeep` / 3) paper and gunpowder
   and the sugar cane for the paper of that round not carried; the rockets stay as the flight kit, the rest is stored.
9. **Shown.** `!status` has `rockets N/K (...)`; the web panel's vitals a `rockets` row.

## Consequences

- An idle bot at home with `autoRockets` on keeps its box full from the home chests' paper and gunpowder; a bot away
  from home crafts from what it carries before a long flight.
- `fireworksKeep` is on by default, so `!unload` and the room chore now keep up to 22 paper and 22 gunpowder (and sugar
  cane for the paper missing) that they stored before; 0 turns that off. Nothing that moves the body runs by default:
  the chore is off, `!rockets` runs only when asked, and the readiness step crafts in place from what is carried.
- The trip readiness's stock steps are a list (`PveController.addTripStock`): the milk and the rockets each add one,
  and each is asked with the trip's goal.
- `!status` carries one more part (`rockets 40/64`, the reason short); the web page grew by 1 467 bytes (the two setting
  rows and the vitals row), the page budget is 141 500.
- Proven on the test servers only (bds-home, bds-fly3): the chore, the paper from sugar cane at a table standing near,
  the refusal with no gunpowder, and a flight on crafted rockets. Not proven: a crafting table placed from the
  inventory for the paper, the readiness's craft before a real trip, rockets in other carried boxes counted and taken,
  anything on the Realm.
- Not covered: farming gunpowder or sugar cane, rockets of duration 2 or 3, buying rockets, a craft mid-flight.
