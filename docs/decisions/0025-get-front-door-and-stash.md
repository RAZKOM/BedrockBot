# 0025: `!get` as the one front door, and a stash step when the inventory fills

Date: 2026-10-29. Status: accepted (PLAN.md Phase 7 wave 8, Track AD).
Server: BDS 1.26.60.6 (`bds-get`, flat, peaceful). Details and numbers: [../get.md](../get.md).

## Context

The owner found four work commands confusing (they asked whether a separate gather command next to a
mine command makes sense at all): `!gather` fells trees, `!mine` digs blocks, `!food` hunts,
`!farm` harvests, and the owner has to know which one gets the item they want. They also asked how
mining handles shulker boxes: until now a full inventory ended a gather without a chest (`inventory
full and no chest`), and mining or hunting simply stopped picking things up. The PLAN.md wave 7 note
listed "a stash step (shulker box or ender chest) when the inventory fills" as open.

## Decisions

1. **`!get <item> [n]` picks the strategy from the item, then runs the existing command as the
   owner.** A catalog (`skills/items/catalog.ts`) maps item words (with or without `minecraft:`,
   plurals, common aliases: wood / logs / oak, cobble / cobblestone / stone, coal / iron / gold /
   diamond / copper / redstone / lapis / emerald by drop, ore or raw name, food / beef / pork /
   mutton / chicken, wheat / carrots / potatoes / beetroot, dirt, sand, gravel, flint, string ...)
   to `gather`, `mine`, `hunt`, `farm` or `unknown`. `!get` then feeds `!gather n`, `!mine <block>
   n`, `!food n` / `!kill spider n` or `!farm` to the chat's own command handler as a copy of the
   owner's line (the way the natural-language executor runs plan steps). So the processes, their
   replies, `!stop`, `!pause`, `!status` and the NL abort rules work unchanged, and there is one
   implementation per job. The old commands stay. Defaults: 16 logs, 8 ore or blocks, 6 food, one
   round of a field (farming has no count of its own: `!get` watches the farm process and stops it
   after the round, or when n of that crop were harvested).

2. **The stash step is one object per bot, reached through the ProcessManager.** `Stash`
   (`skills/container/stash.ts`) is built once by `registerGetCommands` on the task's shared
   Containers and registered under the afk task's ProcessManager (`setStash` / `stashFor`). The mine
   process (every tick in control) and the food job (before the hunt starts or resumes) find it
   there; the gather task gets it as a field (`GatherWoodTask.stash`). Each call site is one guarded
   `await stash.ifFull(job)`; without a registered stash (the CLI `--task gather`, unit tests) the
   behaviour is the old one. A control change of the manager (guard, flee, night, a new command)
   cancels a running stash step; `ifFull` then answers true and the job checks again when it gets
   control back.

3. **Order: chest, shulker box, drop junk, give up.** With fewer than 2 free slots: (a) the
   `stashChest` setting (`x y z`), else the job's own chest; (b) a carried shulker box when
   `stashShulker` is on: placed on a free full-topped cell next to the bot with open space above
   (the lid), opened, filled, closed, broken, picked up; (c) the junk is dropped (what `!drop items`
   drops minus what the job is getting); (d) still fewer than 2 free: `ifFull` answers false and the
   job ends `inventory full`, with one chat line from the stash. The step deposits everything
   `keepOnDropItems` does not keep (the job's produce and junk; tools, armour, food, totems, shulker
   boxes stay). Afterwards the bot walks back to where the job had it (a miner left standing on its
   own line of sight would refuse to dig under its feet).

4. **Shulker box slots are `shulker` in item stack requests.** Verified on BDS 1.26.60.6: the box
   opens with `container_open` window type `container` and 27 slots, but `item_stack_request` with
   `container_id: 'container'` or `'shulker_box'` is refused (status 50); `'shulker'`
   (ContainerSlotType 30) works. The Containers class has one chest slot type per instance, so the
   stash switches its (private) option for the deposit and restores it; the chest skill learns the
   17 shulker box names by adding them to its `CONTAINER_BLOCKS` set at load time. Both live in
   stash.ts so that no shared file changes; a per-window slot type in `world/containers.ts` is the
   clean follow-up (barrels are probably `barrel`, slot type 58, too).

5. **Contents are verified through the server's own data.** The Script API 2.10.0 has no reader for
   a shulker box item's contents (ItemInventoryComponent is absent on it), so the e2e checks the
   server's inventory packet for the picked-up box (NBT `Items`: 1728 cobblestone) and places the
   box again and reads the block's inventory with `truth:container`.

6. **`stashChest` needs a text setting.** The settings registry knew booleans and numbers; a third
   kind `text` with its own `parse` (here: `x y z` / `x,y,z` / `none`) was added to
   config/settings.ts.

7. **A buried ore in reach is dug for, not skipped.** `!get coal 4` with coal 3 blocks under the
   floor showed that the miner marked such ores unreachable (the planner has no dig-down move, so the
   approach plan leads nowhere) although the eye is already within reach. One line in `mineOne`: when
   the first approach plan leads nowhere but the ore is in reach, the line-of-sight digs run instead.

## Consequences

- One command for the owner and for the natural-language front end (`get` is a plan step and the
  first example for "get / bring / collect"); the four old commands remain for precise control.
- A job never stops on a full inventory while a chest, a box or junk can make room; it ends with a
  reason when nothing can.
- The stash step walks: to the stash chest (and back), or a few blocks for the box pickup. The food
  job checks only before a hunt (a hunt for 6 items rarely fills an inventory); farming keeps its
  own chest trips and has no stash call.
- The private-option switch on Containers and the runtime addition to `CONTAINER_BLOCKS` are
  deliberate shortcuts for this wave (no shared-file edits); both are listed as open points.
- `!get` replies first (`getting 16 oak_log: gathering wood`), then the command it runs answers for
  itself (`gathering 16 logs ...`), so the owner sees two lines.
