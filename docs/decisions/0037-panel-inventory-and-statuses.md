# 0037: Control panel: graphical inventory, status blocks, responsive layout

Date: 2026-10-30. Status: accepted (Phase 7, wave 9 Track AP; extends [0026](0026-lan-control-panel.md)).
Server: BDS 1.26.60.6 (`bds-core`). Details: [../panel.md](../panel.md) "The page" and "API".

## Context

The owner, reaching the panel from a phone over a tailnet, asked for a better web view, starting with
the bot's inventory and other statuses shown graphically. The page of 0026 showed the
`!status` text, five vitals and the stack as plain lines. The machine may be offline from the
internet, so no CDN, fonts or image files; the token auth, the rate limit and the endpoints stay as
they are; the bot's main thread must not be slowed by the poll.

## Decisions

1. **Icons are drawn, not textured.** *(Superseded by [0046](0046-item-icons.md): the cells now show
   the game's own icons, read from an npm package at install time; the glyphs below are the
   fallback.)* Minecraft textures are not ours to ship and would need files
   or the internet. Each item gets a hand-drawn 16 x 16 inline SVG glyph for its class (18 classes,
   about 3 KB for the set, `<symbol>` + `<use>`), a colour (the material's for iron, gold, diamond,
   wood ...; else an FNV-1a hash hue of the name, so it never changes between polls or machines), a
   2 to 3 letter abbreviation and the count. The class, colour and letters are computed on the server
   (`inventory.ts`), so the page script only places them and the rules are unit-tested in one place.
2. **Durability and box contents come from what the bot already has.** `ItemStack.damage` (the NBT
   `Damage`, Track S) against `maxDurability`; shulker box contents from the raw wire item's NBT
   `Items` (`shulkerContents`, Track AD). A box the bot moved itself has no raw item until the server
   resends the slot: `known: false`, shown as "contents unknown" rather than "empty". Contents are
   capped at 8 kinds per box (the rest counted) to bound the payload.
3. **Statuses use getters that exist; the panel keeps its own counters for the two that do not.**
   Damage taken (the PvE stats only keep the last few hits) is summed in the panel from
   `MobTracker.onHit`; saturation and weather (not in the world model) come from passive
   `update_attributes` / `level_event` listeners registered by the panel when it serves. No module
   outside `health/panel` was changed.
4. **Memory counts are cached for 15 s.** Forests and seen ores read the world cache's marks around
   the bot (cached summaries may be decoded from disk), so the count runs at most every 15 s; its
   duration is in the payload (`memory.ms`, 0.5 ms on a fresh cache). The chest list is a separate
   `GET /api/chests`, fetched only when opened.
5. **The page polls a lite state.** `GET /api/state?lite=1` leaves out what does not change while the
   bot runs (setting descriptions, defaults and ranges, the command names, the quick buttons), which
   the page has from its first render: 9.6 KB per poll on bds-core instead of 14.7 KB, under 20 KB in
   the worst case of the unit test (full inventory, long logs). Plain `/api/state` is unchanged apart
   from the new fields, which are additive (`v` stays 1).
6. **Render into existing nodes.** The server renders the structure (41 inventory cells, every status
   block) and the script writes a node only when its text, width or the cell's signature changed: no
   flicker, open sections and half-typed input survive polls. A failed poll shows a stale badge and
   fades the cards; a hidden tab polls every 10 s instead of 2 s.
7. **Dark by default, light on request.** `prefers-color-scheme` picks the first theme, the header
   button switches and stores the choice in `localStorage` (every access in try/catch); a two-line
   script in `<head>` applies it before the first paint. One column under 760 px (inventory first),
   two from 760, three from 1200; nothing scrolls sideways at 360 px.
8. **The script is tested without a browser.** It is a plain string (`client.ts`), and a unit test runs
   it on a small fake DOM: first render, unchanged polls write nothing, a stale poll, the hidden-tab
   back-off, the theme toggle with throwing storage, and a render-time figure.

## Consequences

- The page is 62 to 75 KB (was 23.5 KB): the script, the CSS and the glyphs; still one request, no
  assets, and the poll itself shrank.
- New item classes need a glyph in `glyphs.ts` and a rule in `iconClassOf`; anything unknown is a
  coloured tile with its letters, so nothing breaks.
- `weather` is `unknown` until the server sends a rain or thunder event after the bot connected
  (not verified on BDS which events, if any, arrive at join; the e2e does not assert the weather).
- Without a world cache (`BEDROCKBOT_CACHE=0`) the memory block says so; the chest memory of
  `!chests` lives in the home commands then and is not visible to the panel.
