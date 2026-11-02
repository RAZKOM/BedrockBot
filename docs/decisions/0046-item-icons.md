# 0046: Control panel: real Minecraft item icons, read from an npm package

Date: 2026-10-30. Status: accepted (Phase 7, wave 11; supersedes item 1 of [0037](0037-panel-inventory-and-statuses.md)).
Details: [../panel.md](../panel.md) "Item icons".

## Context

The owner asked for the web UI to show the real Minecraft icons instead of generated ones. The
inventory of 0037 drew a hand-drawn glyph per item class, a hash colour and a few letters. 0037 chose
that because the textures are Mojang's art (not ours to ship) and the page may be offline. Both
constraints still hold; the owner's request outweighs the first half of the choice, so the question is
where the pictures come from without putting them in this repository.

## Decisions

1. **The art comes from `minecraft-assets` (PrismarineJS, MIT, exact pin 1.19.0), at install time.**
   The package carries the Java textures and models of every release; we read only the `26.1`
   folder. Nothing of it is committed, copied into `docs/` or bundled in the page: `pnpm install`
   fetches it (the Mac gets it through `update.sh`'s `pnpm install --frozen-lockfile`, nothing to
   configure). The art is still Mojang's and the package's own licence says so; we use it the way
   the game's own client does on the owner's machine, to show the owner their own bot's inventory on
   their own LAN. `THIRD_PARTY_NOTICES.md` names both.
2. **Icons are rendered on the server, on request, from the game's own models.** `GET /icons/<name>.png`
   (behind the same token as every path) answers a PNG, or 404 when there is no icon. A flat item
   (`items/...` texture) is its texture, untouched, with the game's tints (leather armour, potions,
   grass-coloured plants) multiplied in. A block is its model's `display.gui` view: every face of the
   model's boxes is projected with the game's rotation `[30, 225, 0]`, shaded top 100 % / left 80 % /
   right 60 %, and composited front to back (glass and leaves show what is behind them), 32 x 32
   pixels, in plain arithmetic: no canvas, no native module, no GPU. A model that is neither (an
   entity-rendered item: chest, shulker box, bed, banner, head, shield; or a name the package does not
   know) has no icon, and the cell keeps its glyph.
3. **The rules are the model's parent chain, not a name list.** A model whose chain reaches a solid
   parent (`cube`, `slab`, `stairs`, `leaves`, `carpet`, the fence and button inventory models, ...)
   with `display.gui` and unrotated elements is drawn as a block; a short chain without elements is
   entity-rendered. A few exceptions are named (`SPRITE_BLOCKS`, `NO_ICON`, `ALIASES` for Bedrock
   names that differ: `wooden_door` -> `oak_door`, `reeds` -> `sugar_cane`, `snow` -> `snow_block`,
   `fireworks` -> `firework_rocket`, ...). Over the 1772 identifiers of the creative catalogue and
   the block palette: 604 blocks, 596 flat items, 572 without an icon (technical blocks, Bedrock-only
   content such as cinnabar, sulfur and poplar, and the entity-rendered ones above).
4. **Rendered once, kept in memory, sent with a day of caching.** The index files are read on the
   first request, each answer is cached (4096 names at most; a read error is not cached), the browser
   keeps an icon for a day (`private, max-age=86400`; a 404 for 5 minutes). The poll does not carry
   pictures: the page asks for `/icons/<name>.png` once per item name, and remembers the names that
   answered 404 so it never asks twice.
5. **The glyphs stay as the fallback and as the first frame.** A cell shows its glyph until the image
   loads and keeps it when the image does not come (404, the package missing, a failed load); the
   durability bar, count and abbreviation are unchanged. `PanelState.icons` (additive, `v` stays 1) is
   `false` when the package is not installed, and then the page asks for nothing. The panel logs one
   warning and runs as before.
6. **Names reach the filesystem only through an allowlist.** The route takes `[a-z0-9_]{1,64}`; the
   reader takes the paths of the index only and refuses anything outside
   `^[a-z0-9_]+(/[a-z0-9_]+)*$`.

## Consequences

- `node_modules` grows by about 142 MB (the package holds every version's art); the Mac downloads it
  once. `pngjs` 7.0.0 (MIT, pure JavaScript) decodes and encodes the PNGs.
- The panel's page and poll are unchanged in size (the cell has one more `<img>`); the icons are
  separate requests, about 1 to 3 KB each, a few dozen per session.
- Shulker boxes matter to this bot and have no icon: the entity textures
  (`entity/shulker/*.png`) are in the package, so a dedicated renderer is possible later; until then
  they show the glyph, as chests, beds, banners, heads and the shield do.
- The view of a block was derived from the game's rotation order and is pinned by a unit test
  (which face is where, the shading, the compositing); it was compared with the real game's icons on
  contact sheets but not against a pixel-exact Java screenshot, so a face-order mistake would show as
  mirrored blocks. The pins are the place to change it.
- A new Minecraft version means bumping `ASSET_VERSION` and the package pin; the lookup and the rules
  do not change.
