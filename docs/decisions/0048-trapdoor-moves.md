# 0048: Trapdoors as vertical passages (hatches over ladder shafts)

Date: 2026-10-30. Status: accepted (Phase 7, wave 11, Track BG).
Details: [../pathfinding.md](../pathfinding.md) "Nodes and moves" (the hatch rows), "Trapdoors", "Known gaps".

## Context

Bases hide their ladder shafts under trapdoors: a hatch in the floor, a ladder under it, a room below. The
planner treated every trapdoor as a wall or a partial floor, so a goal in such a room was unreachable (or
reached by digging), and a bot in the room could not get out. The owner's farm has one.

## Decisions

1. **A trapdoor is a vertical passage when the body fits past its panel.** `NavGrid.hatch(x, y, z)` takes
   the real geometry: an open trapdoor is one full-height panel at most 0.25 thick (`isPanel`), and the 0.6
   body needs 0.62 of free width beside the panel and beside a ladder's box in the cells around the hatch.
   Open and fits: clear. Closed, wooden and fits once opened: a toggle, like a door (`allowOpen`, cost `door`
   10, `noAction` respected). Iron trapdoors (no hand use), too-tight gaps and anything else: blocked. Both
   halves, every facing. An open panel's cell is passable (never a floor), so the climb and fall moves can
   pass it; standing is still decided by the floor below.
2. **Moves (additive in `astar.ts`).** Down: from a node beside the hatch onto the ladder under it (a climb
   node), or, without a ladder, a drop to a floor within `maxDrop` or into water up to 16 below (the swim
   entry). The hatch may be in the walking layer or in the floor layer under it. Up: a climb that reaches a
   hatch toggles it from below and climbs on, then `climbOut` beside the column (never out through the
   panel's side). `moves.trapdoor` switches them off; the planner worker gets the flag through `moves`.
3. **Execution.** The navigator clicks the trapdoor before the move (the use action re-checks `open` in the
   world model, times out and re-plans like a door). `closeTrapdoors` (setting, **default true**) closes it
   behind the body once the body is in another column or its head is below the hatch, within 4.5 blocks;
   not after a drop into water. Default on because a hatch left open is a fall hole for the owner and the
   bot and lets mobs into the room below; it is the same rule as doors (closed behind since Track O). Pending
   closes survive a re-plan. The follower holds sneak on ladders, keeps 0.08 off a panel while climbing, and
   drops into the tightest case (panel opposite the ladder: 0.63 of room, the body within 0.0125 of the
   middle) only after aligning on the floor with single-tick forward pulses, then walking straight in.
4. **Not done: horizontal trapdoor toggling.** A trapdoor standing upright in a corridor stays a wall or an
   open panel. The doorway code path would need a second geometry model for a rare layout.

## Measured (bds-move, BDS 1.26.60.6)

- An open trapdoor is **not climbable** on BDS, even over a ladder: a hatch in the roof layer with the ladder
  ending under it can be gone down, never up (the planner says `none`; the e2e asserts it). The owner's farm
  layout is like this if its ladder stops under the roof block.
- A horizontal collision while the feet are just inside a ladder cell makes the **server** climb (v.y 0.2);
  the local model does not: pressing into the panel while dropping in gave a 0.89 correction. Dropping in,
  the body is therefore aimed at the gap's middle with no press.
- **A fractional move vector is corrected** by BDS (0.8 forward: corrections of 0.7 to 0.8); only whole
  inputs are used, so the fine alignment uses whole one-tick pulses (0.216 blocks to rest on default ground)
  with a chosen yaw.
- e2e `nav-trapdoor` (2 runs): closed hatch down and up with the panel opposite the ladder and on its side,
  an open top-half hatch down and up with no action, the roof-layer hatch down (no plan up), a ladderless
  hatch over a pool (fall of 8): all ok, 0 corrections, 99 to 133 ticks each.
