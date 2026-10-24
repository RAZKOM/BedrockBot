# 0016: Farming and legit mining: skills on the existing stack, an exposure rule instead of x-ray

Date: 2026-10-29. Status: accepted (PLAN.md tasks 7.13 and 7.14, Track U). Server: BDS 1.26.60.6
(`bds-farm`, flat world, peaceful, truth pack). Details and numbers: [../farming.md](../farming.md),
[../mining.md](../mining.md).

## Decisions

1. **Both are loops over existing skills, siblings of GatherWoodTask.** `FarmTask` and `MineTask`
   use the public BotSkills calls (goto, dig, place, collect, open / deposit / close) and the
   navigator's `plan` and `grid.stand`; nothing in the navigator, terrain, place, dig, tree or combat
   modules changed. They take their dependencies injected (unit tests drive them with fake worlds),
   and their settings (`useBoneMeal`, `mineTunnelLen`) as getters so a runtime settings registry
   (task 7.9) can drive them without a restart.

2. **Planting is a placement; bone meal is its own small click.** Verified on BDS: a seed is
   planted by PlaceSkill's packet unchanged (`inventory_transaction` item_use / click_block on the
   farmland's top face, `held_item` = the seed; the server answers with the crop at growth 0 and a
   `playerPlaceBlock` event). PlaceSkill refuses non-replaceable targets and UseSkill knows only
   doors and the like, so bone meal on a crop goes through a 150-line sibling (`skills/farm/click.ts`,
   same transaction, resolves on the crop's `update_block`) rather than widening another track's
   module.

3. **Trampling is avoided by choosing where to stand, not by a planner hook.** Measured: walking
   never tramples farmland, falls of 0.75 or less never did, 0.9 to 1.25 sometimes, 1.5 and more
   always; a jump in place on farmland usually does. The planner has no per-cell rule this wave, so
   the farmer picks standing cells off the farmland when they reach the work (with a planning margin
   for the 0.3-block stop tolerance), plans the route first (`nav.plan`) and refuses one whose drop
   lands on farmland, and never jumps itself. A field with a raised rim would still be crossed by
   walking, never by dropping in.

4. **Legit mining = an exposure rule the bot keeps itself.** BDS sends every block of a loaded chunk
   (no anti-xray), so the bot could see every buried ore. A block becomes a target only once a face
   of it is open (a loaded neighbour without a collision box that is not a liquid) or next to a block
   the bot dug; buried blocks are counted but never stored. Exposure is not visibility (a sealed air
   pocket counts); a line-of-sight rule would forget ores the bot walked past and was rejected for
   targeting, but it is applied to the dig itself: the bot digs only blocks on its line of sight to
   the target (and under the navigator's break safety rules).

5. **Safety before reach.** A target is checked with the navigator's own `breakBlocker` (never next
   to water or lava, never under sand or gravel, never the block under the feet) before any walking;
   a failing target is blacklisted at once, a target that fails 3 times too. The planned route's dig
   count is checked against `mineTunnelLen` before walking. Mining stops below health 8 and when no
   pickaxe is carried for a block that needs one.

## Consequences

- No planner change was needed, but a per-cell "do not drop here" rule (and a get-to-block goal,
  7.10) would make the trampling rule exact instead of route-checked.
- Ore memory lives in memory only; task 7.12 (world cache) can persist it.
- `!stop` (PvE) does not stop `!farm` / `!mine`; the process manager (7.8) will unify that.
