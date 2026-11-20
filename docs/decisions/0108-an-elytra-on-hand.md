# 0108: An elytra on hand (Track K4)

Date: 2026-11-19. Status: accepted. `elytraSpare` on by default (a carried swap, no new body move); the background swap
at home (`autoElytra`) ships off. Details and numbers: [../flight.md](../flight.md) "An elytra on hand (Track K4)".

## Context

Track F20 (ADR 0107) made the takeoff ask whether the elytra covers the trip and walk a trip it does not cover. Nothing
renewed an elytra: once the one the kit puts on was worn, every long trip was walked, though a better elytra lay loose
in the inventory, in a carried shulker box or in a chest at home. The kit reads one elytra only: the one on the back,
else the first carried in slot order, so a worn one in an earlier slot hid a new one behind it. Measured on the test
server before the change: a worn elytra (58 uses) and a new one loose, on the back's slot or in a box, or in a home
chest with the bot at home: `!goto` 400 blocks walked every time, the new one untouched.

Mending repairs only an item worn or held while experience orbs are picked up (on the test server: worn +20 uses for
10 orbs, held in the main hand +20, in the inventory 0, `/xp` 0). After a flight the bot puts its chestplate back on and
carries the elytra, so a Mending elytra is not mended on the ground. The server sends 14 multi recipes (computed
server-side; the grid repair of two worn items is one of that kind) and no grid recipe makes or repairs an elytra; the
recipe index keeps shaped and shapeless grid recipes only. The bot drives no anvil.

## Decision

1. **The stock rule (`chooseElytra`, skills/supply/elytra.ts).** When the elytra at hand does not cover the trip
   (`tripCover`; a trip no new elytra covers asks nothing) or, for the chore and `!elytra`, has fewer than 100 uses over
   its worn limit: the cheapest source first, loose, then a carried box, then the chests at home, these only while they
   are in reach (Track K2's rule, docs/home.md "Room for a take", as for the milk and the rockets). Within a source the piece with the most uses left of those
   that cover the need: every swap is a body action, and the most uses give the most trips before the next one. The
   best fit was not chosen: it keeps a new elytra back but swaps again on the next trip.
2. **The swap.** A loose spare goes on in place of the worn one by one armour swap (the worn one comes into the spare's
   slot), or, with no elytra worn, into the slot the kit reads by one slot exchange; one in a carried box is taken out
   of that box slot only (`Supply.takeFromBox`, the box placed, opened, broken and picked up as every box take); one in a
   home chest by the home withdrawal, the stacks read at the chest (`WithdrawRequest.pick`: only one that covers the
   need, the most uses first; the memory keeps no uses). The worn one stays carried.
3. **The keep rule (`elytraToStore`, `UnloadSlot.store`).** The elytra with the most uses always stays. Every other
   carried one that is low (under 100 uses over its worn limit) and has no Mending is unloaded like loot; a better spare
   and a Mending one stay. The only flyable elytra is never stored, and worn ones do not pile up.
4. **Where it runs.** The takeoff: `autoFly` (`!goto`, `!come`, the trip home) and `!fly` ask the rule before a trip is
   refused for its elytra, and the flight's preparation asks it again (FlyProcess.prepare); a walk's re-checks only look
   (nothing moves while a walk runs). The trip readiness gains an `elytra` phase: before a long trip that may fly, carried
   sources only (never a walk to storage). `!elytra [status]` (a user process). The elytra chore (auto, chore priority,
   `autoElytra`, default off): by day, idle, within 16 of home, no hostile within 16. It runs before the rockets in the
   registration order, since the rockets' trip step asks whether the kit flies.
5. **It says what it needs.** The refusal of a trip says why no spare helped (`; no spare that covers it (carried, in
   the boxes or at home in reach)`, and the uses of the spares that are short), `!status` has an `elytra` part, `!elytra
   status` the whole stock, the web panel's vitals an `elytra` row.
6. **`elytraSpare` (default on) switches the takeoff's and the readiness's swap and the keep rule.** Off, the bot does
   what it did before.
7. **Not built, written down with the evidence (docs/flight.md):** wearing a Mending elytra to take experience (a walk to
   an experience farm moves the body: it would be a typed command and a default-off chore), the grid repair of two worn
   elytra (a multi recipe: the crafter would need to send the server's recipe id and predict an output the server
   computes; not measured whether the server takes it), phantom membranes at an anvil (an anvil screen, its request and
   the experience levels it costs; the bot drives no anvil).

## Consequences

- With a better elytra carried or boxed, a trip the worn one does not cover is flown on the better one instead of
  walked; at home a chest's elytra is used the same way. The worn one is carried back and stored at the next unload.
- Nothing new moves the body by default: the swap is an inventory request or a box placed beside the bot, as the rocket
  refill out of a carried box was; a home chest is only walked to while it is in reach, as for the milk and rockets.
- The trip readiness's stock steps grew by one (`elytra`), registered before the rockets.
- `!status` carries one more part; the web page grew by the two setting rows and the vitals row (docs/panel.md budgets).
- The stock is limited to what the bot has: nothing renews an elytra yet. Proven on the test server only.
