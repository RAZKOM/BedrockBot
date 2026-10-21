# 0006: Wood skills: serialisation by pre-emption, re-path instead of pillar-up, predicted stack moves

Date: 2026-10-29. Status: accepted (PLAN.md tasks 4.3 to 4.6). Server: BDS 1.26.60.6 (`bds-wood`,
flat world, truth pack). Details and numbers: [../wood.md](../wood.md).

## Decisions

1. **Skills are serialised by pre-emption, not by a queue.** Every public `BotSkills` call cancels
   the skill that is running and starts at once. The navigator, the digger and the look controller
   all finish their promise synchronously inside `cancel()`, so the old skill has released yaw/pitch
   before the new one sets them. A queue would make `goto` start asynchronously (callers and the
   nav tests check `nav.busy` right after the call) and would let a stale goto run after the task
   has moved on; the existing behaviour "a new goto interrupts the old one" is kept and extended to
   dig, lookAt, collect, fellTree and the chest calls. Compound skills (collect, fellTree) call the
   navigator and the digger directly, one at a time, and stop when a cancel epoch changes.

2. **Re-path, no pillar-up.** On the flat test world every log of a tree up to 7 logs is in reach
   from a cell next to the trunk (feet + 6 is 4.40 from the eye; feet + 7 is 5.40, beyond
   `DEFAULT_REACH` 5), and the test trees are 4 to 6. Pillar-up needs block placement under the
   feet while jumping (an `item_use` click on the block below, predicted by the movement model),
   which is new physics and protocol work without a test that needs it. The feller instead walks to
   the best standable cell that reaches the next log (also cells on higher ground), and reports logs
   no cell reaches in `left`. Revisit for real terrain with tall trees (jungle, dark oak, spruce).

3. **Stack moves are predicted and reconciled, one request at a time.** BDS answers an
   `item_stack_request` with an `item_stack_response` (counts and new stack ids), not with
   `inventory_slot` for the player inventory, so the model applies each `place` at once and takes
   counts and stack ids from the response; an error or a 3 s silence rolls it back. Moves are sent
   and awaited one by one (a deposit of a full inventory is at most 36 round trips of about one tick
   each): batching several actions into one request would save little and makes a partial failure
   hard to attribute.

4. **Only logs count and only logs are dug.** The target counts logs of any kind in the chest;
   saplings and other drops are collected (they lie where the logs fall) but neither counted nor
   deposited. The feller refuses any non-log block unless `allowDig` (`--allow-dig`) names it, so a
   wrong tree detection cannot dig into a house.

5. **Death handling is borrowed, not owned.** GatherWood uses Track I's `RespawnController`
   (`ctx.respawn()`): its `death` event pauses the task (skills cancelled), its after-respawn hook
   resumes it from find-tree. The task does not walk back to the death point; the spawn point is
   expected near the forest.
