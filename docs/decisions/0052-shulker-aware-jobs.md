# 0052: Shulker-aware jobs: one supply layer, bring extract, build refill, crop reserve (wave 12, Track BJ)

Date: 2026-10-31. Status: accepted. Details: [../home.md](../home.md) "Supply", "Bring", "Decision table";
[../build.md](../build.md) "Materials"; [../get.md](../get.md) "`!get` or `!bring`".

## Context

The owner: "So im noticing that all of the smart shulker features ... aren't universally applied ... !get 1000
dirt ... only ask for 10, itll bring a whole shulker. With building too ... scaffolding ... crops that it harvested
being not unloadable cause it considers it food". Before this track, box handling lived in each feature:
`HomeLogistics` had its own place / empty / break / pick-up helpers and three inline copies of the
place-deposit-pickup sequence (`viaSpareBox`, `boxStepRun`, `fillStep`); `!bring` only knew whole boxes (as the
last source); `!build` counted loose blocks only; the unload plan kept every crop as food.

## Decision

1. **One shared layer** (`bot/src/skills/supply/`):
   - `BoxOps` (boxes.ts): the box primitives, moved out of `HomeLogistics` (`place`, `takeOut` (was
     `emptyBox`), `breakAndPickUp`, `pickUpOrFetch`, `fetchLeft`, the slot helpers), plus `putIn` (place, deposit,
     break, pick up), which replaces the three inline copies. `place` takes an `avoid` predicate (a cell and the
     cell above it); `standing` names the cells where a box of the layer stands so the home chore ignores them.
   - `Supply` (supply.ts): `available(item)` (loose + carried boxes + the chest memory at home), `ensure(item, n,
     {avoid, home})` (carried boxes first, at most 4 box rounds; with `home` the rest through `!bring`'s
     withdrawal), `stow(item, keep)`, `topUpThrowaway(min)`. One per task (`setSupply` / `supplyOf`), built by
     commands-home over the logistics' skills, so the box work shares the logistics' serial lock and hotbar rules.
2. **`!bring` threshold: half a box** (`halfBox` = floor(27 x stack size / 2)). Still needed at least half a box:
   whole boxes holding at least half a box, fullest first, before loose stacks. Less: loose stacks first, then
   just what is missing is taken out of one box (the smallest box holding enough, else the fullest) next to the
   bot, and the box goes back into its chest. The chest record keeps every box's contents (`boxList`). An extract
   needs 3 free inventory slots, else the box comes whole. Half a box keeps a big order to few chest trips and a
   whole box in the inventory (one slot) where it is worth a box, and a small order to loose items.
3. **`!build`**: materials count the carried boxes; the runner refills on the ground from a box placed off the
   build's footprint, tops up a column's blocks and scaffold blocks before pillaring, and stows the rest at the
   end. Never from a column top.
4. **Crops vs food**: `CROP_FOODS` are no longer kept whole. `foodReserve` (64 items) is filled by other food
   first, then crops by food value; `seedReserve` (32) of each `!farm` seed stays; the rest is unloaded.
5. **`!get` stays chest-free**: it never calls `ensure` with `home`.

## What was duplicated, and what was consolidated

| Piece | Before | Now |
|---|---|---|
| place / empty / break / pick up / fetch a left box | `HomeLogistics` private methods | `BoxOps`, used by `HomeLogistics` and `Supply` |
| place-deposit-pickup | inline in `viaSpareBox`, `boxStepRun`, `fillStep` | `BoxOps.putIn` |
| items out of a box | `emptyBox` (unload only) | `BoxOps.takeOut`: unload, `!bring` extract, `Supply.ensure` |
| home stock | `stockOf` in `!bring` | the same `stockOf` in `Supply.available` |
| home route | `HomeLogistics.withdraw` | the same, as `Supply.ensure`'s `home` route |

Left duplicated, on purpose:

- `Stash.viaShulker` (container/stash.ts) keeps its own place / fill / re-pack: its packing order (drop junk
  first, re-pack), the `carveSpots` for mine shafts and its e2e-tuned timing differ from a plain `putIn`. It shares
  the cell rules (`boxSpots`, `carveSpots`). Moving it is the next step once the mine shaft cases have a fake.
- `takeSpare` and `viaSpareBox` each take a box out of a chest window (different targets: a spare for the stash
  step, a spare to fill at once).
- `BringController.hint` calls `stockOf` directly (the same function as `Supply.available`, without a Supply).

## Deferred

- **Mid-path throwaway refill**: navigation (navigator.ts bridging / pillaring), the miner's throwaway checks and
  the fall clutch read the loose inventory only; those files were owned by other tracks this wave. The top-up
  happens before a build and before each column; `Supply.topUpThrowaway` is ready for a pre-job hook.
- **Pre-job top-up for `!get` / `!mine`**: `GetController.run` dispatches synchronously; a hook there needs an
  async step first.

## Consequences

- A small `!bring` costs a box place / break next to the chest (7.8 s for 10 sand vs 2.9 s for a whole box), but
  the box stays at home and the bot carries only what was asked for.
- The home chore no longer reads a supply box near home as a new container (`standing`).
- Tests: unit `supply.test.ts` (7), `build-supply.test.ts` (4), `home-crops.test.ts` (4), new cases in
  `home-bring.test.ts` (6) and `bring-commands.test.ts`; e2e `home-supply.test.ts` (4) and the updated
  `home-bring` diamond case on bds-home.
