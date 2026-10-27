# 0031: Wave 9 small fixes (Track AK)

Date: 2026-10-29. Status: accepted (Track AK, wave 9). Server: BDS 1.26.60.6 (bds-dev, bds-core,
bds-gaunt, bds-reg). Closes open issues of Tracks AC (0024), W (0018) and AF (0027), and gaps in the
docs.

## Context

Waves 7 and 8 left a list of small open issues, each too small for a track of its own:

- the natural-language schema (0020) did not know `!breed`, `!panel`, `!drop all` / `!drop items` or
  `!food pen`, so `!do` answered `question` or `not available` for them;
- palette-only block states (0024: the 7 664 BDS 1.26.60 states minecraft-data 1.26.30 lacks, e.g. the
  poplar wood set and the wool / concrete stairs and slabs) borrowed the collision boxes of the
  closest minecraft-data state. For doors that is minecraft-data's single door box (x 0..0.1825 for
  every state), so an open poplar door was a wall where the panel is not, and the terrain layer's
  state-dependent door panel applied to minecraft-data door ids only;
- fences, panes and bars on 1.26.60 carry their connections in `minecraft:connection_*` states, but the
  terrain layer still derived the arms from the neighbours (it cannot see a connection the server
  computed differently, e.g. to a block it does not classify as connecting);
- `!goto` had no `now` (`!come now` makes the night process yield; a goto at dusk was pre-empted by the
  shelter walk);
- the sleeping body was held at the bed through `InputLoop.setTickExtras`, a single slot the digger and
  the hotbar moves also take and clear: a dig or a hotbar move in bed would drop the held pose (and the
  bot would be corrected every 16 ticks again), and the pose would replace a dig's extras;
- docs: five settings missing from docs/processes.md, the flee row silent on the urgent bypass of the
  cooldown, the truth README without the palette / gaunt / get requests, the `--health-port` usage
  line without the panel, no runbook row for panel-core.

## Decisions

1. **NL schema entries** (`bot/src/nl/plan.ts`, `prompt.ts`): `breed { type?, pairs? 1..8 }` (type: the six
   animals `!breed` knows; done on `breed: fed`, fail on any other `breed:` line), `panel {}` (instant),
   `drop { what: all | items }` (done on `dropped N items of` or the empty-inventory lines, fail on
   `(stopped at`; no single-item drop through the model), `food { pen? }` (`!food pen`). Three new worked
   examples (breed, drop items, food pen); `panel` needs none.
2. **Partial blocks by name suffix** (`skills/terrain/shapes.ts` `partialBoxes`, used by `boxesOf`): a state
   whose id is not a minecraft-data state of the same block name gets doors from `doorBoxes(states)`,
   stairs from `stairBoxes(states)`, and trapdoors / fence gates / slabs / double slabs from the
   minecraft-data donor (`trapdoor`, `fence_gate`, `oak_slab`, `oak_double_slab`) state with the same
   state values; anything else keeps the registry's borrowed boxes. Checked against every palette-only
   state of those kinds (4 076 states, 6 kinds) in a unit test with the palette ids.
3. **Fence and pane arms from the connection states** (`skills/terrain/classify.ts`): when a fence / pane /
   bars state has `minecraft:connection_*` states, `TerrainClass.arms` holds the CONNECT_* bits and
   `boxes` are the post plus those arms; `terrain/query.ts boxesAtCell` (one line) then skips the
   neighbour scan. minecraft-data states (no connection states: 1.26.51, fixtures, generated test worlds)
   keep the neighbour rule. The class stays `connect: 'fence' | 'pane'`, so neighbours without the states
   still connect to it.
4. **`!goto ... now`** (`chat/commands-nav.ts`): a trailing `now` (not a lone `!goto now`, which is the
   waypoint called `now`) passes `urgent` to the walk; through the PvE layer the goto process is marked
   `urgent`, the flag the night process yields to (`yieldWhile`), exactly like `!come now`. The reply is
   `walking to <what> now`. Walks are never refused at night, so `now` changes nothing else.
5. **A pose slot in the input loop** (`InputLoop.setPose`): a second, separate provider slot merged after
   the tick extras (its fields win, flags add up). The sleep controller uses it (falling back to
   `setTickExtras` for loops without it), so the digger's slot and the pose never replace each other.
   Kept to one more slot instead of a provider list: there are exactly two users.
6. **Docs**: settings rows `plannerThreads`, `stashChest`, `stashShulker`, `autoBreed`, `chorePen` and the
   flee cooldown bypass in docs/processes.md; the palette, gaunt and get requests in packs/truth/README.md;
   the panel on the `--health-port` usage line; a panel-core row in the runbook's test list.

## Consequences

- A model can now answer requests such as "breed two pairs of cows", "drop your junk", "get food from the
  pen too" or "show the panel" with a plan instead of a question (the schema validates them; how often a
  real model picks them was not measured: no model service in this track). `drop all` through the model is possible (the plan is shown
  and waits for `!yes` while `nlConfirm` is on, the default).
- Poplar, wool and concrete doors, trapdoors, gates, stairs and slabs collide like their oak relatives in
  every state; nothing changes for minecraft-data states (the shape still comes from the data).
- On 1.26.60 a fence's collision follows the server's connection states even where the neighbour rule
  disagreed; a fence next to an unloaded or not yet updated neighbour no longer guesses.
- The night shelter waits for `!goto ... now`; a goto without `now` still yields to it at dusk.
- A dig, a hotbar move or anything else using `setTickExtras` while the bot is asleep no longer drops the
  held sleeping position, and the pose no longer clears their extras.
