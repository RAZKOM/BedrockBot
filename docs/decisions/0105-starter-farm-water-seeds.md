# 0105: Water and seeds for the starter farm (Track E8)

Date: 2026-11-19. Status: accepted. `!farm new` (a typed command, on) now finds surface water past 96 and plants
more of its cells; the farm chore's seed top-up digs grass and plants by itself, so it runs only under `farmFood`
(off by default). No new settings. Details and numbers: [../farming.md](../farming.md) "Water for the plot" and "Seeds",
[../early-game.md](../early-game.md) "A farm: water and seeds".

## Context

Track E6 left the plot dry whenever the kit's bucket was empty: on its fresh world every such plot was dry, and the
reply said `no still water within 96`. Measured again from the iron kit with home set, on one normal world with the
spawn moved so that surface water lay at different distances (n3 a spawn): every plot was dry, 9 of 9 that got a site,
393 to 732 s. The cause was not distance. The search took the 6 nearest still sources in a sphere round the bot and
tried them 3 times; on the first spawn those 6 were a cave pool 9 under the plot while the sea lay 17 off, and they
were never reached. On a mountain spawn one try filled the bucket in a cave 45 down, the bot was left 88 off the
middle, the middle's digs were `out of reach` and the end line read `not poured (occupied)`. And 14 to 28 of the 80
cells were planted: the 150 s of grass round the plot gives about 1 seed in 8 (146 to 216 plants broken).

## Decision

1. **Surface water only (skills/farm/water.ts).** A still source counts when nothing over it is water and the cells
   above it are open (air, plants, leaves) for 24 and up to the plot's height plus 8. A cave can be more than 24 high:
   with only the 24 rule a mountain plot at y 85 tried six pools at y 19 to 59 for 9 minutes.
2. **Pools, not cells.** The sources are grouped (within 4 on x and z, 2 on y) and tried nearest first, one try a pool,
   at most 4 before a search and 4 more during it.
3. **Seen water.** With the world cache, a column its map layer remembers with water on top is a candidate up to 256
   from the plot (not loaded now: the walk there decides). The loaded blocks within 160 of the bot are read first-hand.
4. **A bounded search walk.** With nothing known within 256, the bot walks out 96 from the plot along +x, +z, -x, -z,
   32 at a time, and looks again after each step (the server loads the chunks round it). At most 300 s.
5. **Back at the plot, or say so.** The walk back to the middle is tried a second time with a looser goal and twice
   the time when it ends out of reach; still out of reach, the plot is left dry with the water kept, and the reply
   says `water carried, not back at the plot (reason)`. A rerun pours.
6. **The reply says why.** `water poured (filled 17 off)`, `(filled 161 off, seen before)`, `(..., walked N
   looking)`, `water dry (none seen within 256, walked N looking)`, `(K tried, none reached, nearest D off, walked
   N)`, `(no bucket)`, `(not poured (reason))`. A pour answered `rejected` while the water shows within 2 s counts as
   poured and is logged `the pour read rejected; the water showed within N ms`.
7. **Seeds.** Ferns and large ferns count as seed plants (they drop wheat seeds as grass does). From each stand every
   plant in reach is broken before the next walk. With the plants within 24 gone and time left, the step looks out to
   48 (a mountain plot had 11 plants within 24 and planted 2 cells).
8. **The seed top-up (tasks/process/farm-new.ts, under `farmFood`).** With nothing to harvest and 8 or more
   farmland cells bare, the farm chore breaks plants within 40 of the plot for up to 60 s, at most once every 10
   minutes, and the farmer plants them. Seeds carried go in first; no plant is broken then.

## Dropped

- **Filling the bucket when any job passes water.** It touches every walk in the bot for one bucket; the world
  cache already remembers the water those walks saw, and rule 3 uses it.
- **Siting the plot by the water.** The site rules (near home, the owner's builds) stay as they are; the fetch costs
  1 to 3 minutes once.
- **An endless water source at home.** One plot needs one bucket; a second bucket and a second fetch double the trip.
- **A longer seed step.** The rate is about 1.2 plants a second either way; more time on the set-up delays the
  planting the farm needs most, and the top-up spreads the rest over later days.

## Consequences

- The set-up, n3 a side a spawn (early-game.md "A farm: water and seeds"): water 36 from the spawn, dry 3 of 3 ->
  wet 3 of 3 (`filled 17 off`, 373 to 459 s against 393 to 431); 145, dry 3 of 3 -> wet 3 of 3 (`filled 161 off`,
  473 and 499 s with the plot-height rule, 886 s before it); 125, wet 2 of 3 from a cave pocket -> wet 3 of 3 from the
  sea 83 off (about 130 s more: the cave pocket is passed over on purpose). A mountain spawn had a site in 1 of 5 runs
  (the site rules are unchanged).
- On a flat test world (e2e, 3 of 3): a pond 117 off filled (dry before), one 222 off remembered and one 236 off
  searched for; none within 256 dry in about 157 s with the reply saying so.
- Six days with the water fetched, n2: every one of the 80 cells planted by day 6 (21 and 29 before, a full bucket
  given and no top-up), the first wheat on day 3 as before, 3 and 5 loaves on days 4 to 6 (2 and 3 before), 0
  deaths, the hunt still on most days. The farm feeds the bot from its second week, not its first; `farmFood` stays
  off.
- The set-up's seeds did not change much: one stand for every plant in reach broke 372 to 394 plants in dense grass
  against 321 (n1 before), and 146 to 216 either way on the fresh world.
