# 0044: Boxing at the chests, the owner's `bot_loot` boxes, packing priority (wave 11, Track AV)

Date: 2026-10-30. Status: accepted. Details: [../home.md](../home.md) "Boxing at the chests (Track AV)".

## Context

The owner named the shulker boxes they give the bot `bot_loot` and asked that the bot keep those. For
unloading: when a chest is full of empty shulker boxes, the bot can find that chest, load items from a
full chest into a box, break the box and put it back in the chest (a large amount of sand will not fit in
one chest that is already partly full of sand, so an empty box can take it). Later the owner asked what
happens when the bot carries five boxes and is asked for five boxes' worth of sand after it has started
filling some of them with other items: would it put those back down and prioritise the sand?

## Decision

1. **Named boxes** are recognised by the item NBT's `display.Name` (verified on BDS 1.26.60:
   `extra.nbt.nbt.value.display.value.Name.value`, a string with colour codes kept; naming keeps the box's
   `Items`). The name is the setting `keepBoxName` (default `bot_loot`), compared without case, colour
   codes and surrounding spaces. A named box is never unloaded, stored, used for boxing, a spare, or dropped
   by `!drop all` / `!drop items`; the stash step fills it first; `!unload` empties it into the inventory
   and unloads its items; the bot keeps it. The fireworks box (Track AU) is checked first and keeps its rule.
2. **Box steps** in the unload plan (`UnloadPlan.steps`, kind `box`): a kind whose chests (rule 1: the
   chests holding it loose or in boxes) cannot take what the bot carries, with a spare empty box known
   (carried, else in a chest: `ChestRecord.boxes.empty` counts unnamed empty boxes only), gets a box at the
   chest holding most of it: its loose stacks first (27 slots freed for 1), topped up with the bot's own
   stacks, the box stored back in that chest. The planner simulates it, so the deposits after it go to the
   same chest; kinds with a home claim their room before the label / emptiest rules. At most 4 box steps a
   run; a failed step plans that kind without boxing for the rest of the run.
3. **The `compact` hook** (Track AW, crafting into blocks): `UnloadPlan.compact` (`{kind, count}[]`) and
   unloader.ts `setCompactRunner(fn)`: the logistics calls the installed runner once, under its serial
   lock, before the chest trips, and puts its reply fragment (`compacted 27 raw_iron into 3 raw_iron_block`)
   into the `!unload` reply; without a runner nothing changes. The logistics crafts nothing itself.
4. **Packing priority in the stash step**: junk that is no building block (`DROP_FIRST`: the keeper's junk, snowballs, kelp, seagrass, vines; not bones, seeds, flint, feathers, arrows) is dropped before a box is filled and never boxed; the box takes the job's
   produce, then other items of value, filler blocks (cobblestone, sand, ...) last and only when no produce
   waits. A box that already holds stash junk the job does not want while produce waits is re-packed: the
   junk taken out stack by stack into a free inventory slot (always with a second slot free), the produce
   fills the freed slots, the junk is dropped (`re-packed 1 box: dropped 1280 junk, boxed 20 stacks of sand`).

## Consequences

- Filler blocks are boxed last instead of dropped first (the get-stash regression boxes 27 stacks of
  cobblestone while getting coal, as before). The owner's wording was "drop the junk"; rotten flesh and
  string are dropped, cobblestone is kept and boxed only after the produce.
- A re-pack needs one free inventory slot besides the placed box's; with the inventory completely full the
  box is not re-packed (the survival keeper's own full-inventory drops raced the takes on bds-home).
- The home chore ignores the block updates of the stash step's own box cell (`Stash.boxAt`) while the step
  runs: its box was read as a new container and its window closed under the stash step. A container the
  owner places meanwhile is still read.
- Other behaviour changes of this track:
  - the throwaway reserve of the unload plan is the `throwawayMin` setting (was a fixed 16; default 16);
  - `unloadableStacks().fullBoxes` (the autoUnload trigger) leaves the fireworks box out;
  - rule 1 treats a chest holding the item only inside full boxes as its home;
  - `!unload all` empties full boxes through `placesExactly` / `boxToHotbar`: a box in the main inventory
    behind another box of its colour makes the bot walk to the nearest chest first to move it to the hotbar;
  - the deposit order puts the kinds with a home (rule 1) before the others, so they claim the room first;
  - a box broken by someone else while placed is picked up without a dig;
  - re-pack junk is thrown from the job's spot, looking up and away from the box cell;
  - `!bring` does not count the bot_loot and fireworks boxes as boxes already carried.
