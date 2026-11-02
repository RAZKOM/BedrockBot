# 0039: Control panel: interactive (context menus, map actions, settings, palette)

Date: 2026-10-30. Status: accepted (Phase 7, wave 10 Track AR; extends [0026](0026-lan-control-panel.md)
and [0037](0037-panel-inventory-and-statuses.md)). Server: BDS 1.26.60.6 (`bds-core`). Details:
[../panel.md](../panel.md) "Interaction".

## Context

The owner asked for an interactive UI: drop inventory items by clicking them (crafting could come
later), settings organized with toggles and default values, and context menus on the inventory and on
the map for navigation. The page stays server-rendered HTML with inline
JS and CSS, no internet assets, token auth, the rate limit and every existing endpoint unchanged.

## Decisions

1. **Every action is a chat command.** A menu entry, a switch, Reset, Stop, Pause, a mode button and
   a quick button all send one `!command` through `POST /api/cmd`, the same path as the command box:
   the chat handler's parsing, owner check, log line (`panel: !drop cobblestone 64 (as Steve)`),
   metrics and replies. There is no second API that moves items or the bot, so the audit trail and
   the permission model stay one, and anything the panel can do the owner can type in the game.
2. **Two commands were missing and were added as ordinary commands** (`chat/commands-panel.ts`, tier
   `more`, group `control`; one import and one line in `tasks/registry.ts`): `!select <0..8>` (the
   PvE controller's `Hotbar.select`: `mob_equipment`) and `!offhand <item> | clear` (the shield
   controller's verified request, `place` to `{ container_id: 'offhand' }` slot 1 with the inventory
   screen open, through the survival kit's `StackRequests`, one screen at a time with the kit's own
   moves; `clear` is the same action the other way, the target slot predicted in the model first
   because the response carries only counts). `!drop <item> <n>`, `!equip`, `!eat`, `!unload`, `!goto`,
   `!home set`, `!shelter set`, `!wp set`, `!set <key> default`, `!mode`, `!stop`, `!pause`, `!resume`
   existed. Hotbar reordering by drag (`!move`) was left out: not needed for any requested action.
3. **One menu model, run on both sides.** Which actions a cell, a map column, a setting, a process or
   a mode offers is plain JavaScript in `health/panel/menu.ts` (`MENU_JS`). The page embeds it
   verbatim; the module evaluates the same text so the unit tests and the e2e (which computes each
   command with it and posts it as the page would) check exactly what the browser runs.
4. **Destructive means a second tap.** Dropping a whole stack or all of an item, setting home or
   shelter, and applying a mode arm on the first tap (the label says `tap again: ...`, red) and send on
   a second within 4 s. Dropping one item, selecting, eating, equipping, the offhand and walking do
   not ask. The mode button shows the diff against the current values before it applies.
5. **The map moved into the page.** The debug map (`/map`) was an iframe; the panel now draws its own
   canvas from `/map.json` (only while the section is open, every 2 s) so its menu can call the
   panel's command path. Markers the map JSON lacked come from a new `GET /api/marks` (remembered
   chests and herd marks within 256 blocks), and the map routes lift the afk task's `nav.waypoints`
   and `night.shelter` into the JSON's `waypoints` / `shelter` (they were never shown before). Walk
   here uses the clicked column's surface y + 1 from the tile; an unknown column uses the bot's y.
6. **Settings keep their table, grouped.** Rows by the `!help settings` groups, booleans as switches
   (sent on change), numbers with min / max, word choices as a select, the default and a Reset shown
   only when the value differs, filters (changed only, search), the mode selector on top. The quick
   buttons are editable and kept in the browser (`localStorage`, try / catch). The command palette
   reads `/api/help` once. `PanelState` gains `paused` (additive, `v` stays 1).
7. **Not from the panel:** crafting (needs the crafting screen and recipe packets, below), taking off
   one armour piece (no command does; `!drop all` sheds everything), mining a clicked spot (`!get <ore>
   n` is not positional), build markers, and anything the chat cannot do.

## Crafting, later

What it would take (not verified on BDS yet; the shapes follow the protocol definitions the bot
already decodes): the recipe list the server sends at join (`crafting_data`: shaped and shapeless
recipes with their `network_id`s); for 3 x 3 recipes a crafting table within reach, opened like a
chest (`inventory_transaction` item_use_on the block, then `container_open` type `workbench`); 2 x 2
recipes work from the inventory screen the kit already opens. Then one `item_stack_request` with
`craft_recipe` (the recipe network id, how many times), the `results_deprecated` action, a `consume`
per ingredient slot and a `place` from the `created_output` slot into the inventory, answered by one
`item_stack_response`. The bot has none of this: a `!craft <item> [n]` command (pick the recipe, check
the ingredients, find or place a table) belongs to a skills track, and the panel would offer it as
one more menu entry (Craft... on an item, or a recipe list).

## Consequences

- The page is 105 KB on bds-core (117 KB in the unit test's worst case; the limit is now 160 KB), the
  script 46 KB; the poll is unchanged (5 KB on bds-core, 17 KB worst case, limit 24 KB).
- A shield moved out with `!offhand clear` goes back by itself while the bot is idle (the shield
  controller); a totem or anything else stays where it was put.
- `!drop <item> <n>` drops from the smallest stacks first, not necessarily from the tapped cell; the
  count is what the cell showed.
- Stop on a process sends `!stop`, which ends every user command (there is no per-process stop).
