# 0050: Chat colour, framed multi-line blocks and optional /me, /say, /tellraw routes

Date: 2026-10-31. Status: accepted (Phase 7, UX). Details: [../chat-style.md](../chat-style.md).

## Context

The owner: "What about §? How can we implement the chat color character to improve the ux", then "my main
problem is with like !help or !set where a lot of text is printed, it kind of all garbles up into one blob.
so separation and context help", and "make sure its reusable for future agents to know how to use it and not
just set it and forget in places". Later: "/tellraw if available should be used".

Replies were one packed line per message (`!set` and `!help` chunked at 256 characters, 8 replies per 10
seconds), with no emphasis. Nothing stopped the next feature from adding its own colour codes or its own
chunking.

## Decisions

1. **One module owns the look.** `bot/src/chat/style.ts` is the only file that builds `§` codes (a unit test
   fails on any other file, except an allow-list of files that only strip codes). It has a small tone palette
   (no dark colours: the chat background is dark), `paint`, `colorize`, `strip`, `fitWire` and the `Doc` builder.
2. **Two layers, both automatic.** A one-line reply needs no change: `Chat.say()` runs `colorize()` over it when
   `chatColor` is on (commands aqua, numbers gold, one verdict word, a trailing note gray). A long, structured
   answer is a `Doc` made with `chat.layout(plainLines, build)`: the plain lines when `chatLines` is off, the
   multi-line messages when it is on. Commands never read the modes.
3. **Metadata-driven help.** `!help`, `!help all`, `!help <cmd>` and `!help settings` / `!set` are generated from
   the registered commands (`tier`, `group`, `help`, `example`) and from `SETTING_GROUPS`, which now covers all
   settings; a unit test fails for a setting that is in no group. New commands and settings appear in the
   layout without touching it.
4. **Everything is off in code and opt-in at runtime.** `chatColor`, `chatLines` (booleans) and `chatVia`
   (`chat` | `me` | `say` | `tellraw`) default to off / `chat`, so every test and task is unchanged. `!colors` prints a
   specimen so the owner can see what their client draws before turning anything on. We could not measure how
   the owner's client (or the Realm) draws `§` and newlines, only what the server relays, hence the demo.
5. **Server limits are measured, pinned, and counted in BYTES.** On BDS 1.26.60.6: `§` and newlines are relayed; a
   chat message of 503 bytes is relayed and 515 is dropped silently; a command of 505 bytes works and 511 makes the
   server drop the connection. The server counts UTF-8 bytes and a `§` is 2, so 480 *characters* with 40 colour codes
   are 520 bytes and vanish. Every message leaving `say()` is at most 480 bytes with its codes (the plain text when the
   codes would not fit), every Doc is packed in bytes, and `wireSize` is the one way to measure; the e2e
   (`bot/test/e2e/chat-style.test.ts`) re-measures this after every BDS bump. (The first version counted characters;
   the tellraw e2e disconnected the bot on a coloured settings page, 2026-10-31, before `chatLines` was ever on live.)
6. **`/me`, `/say` and `/tellraw` are optional routes, with a safety net.** `chatVia` picks how the finished text
   is sent: `chat` (`<Bot> text`), `me` (`/me`: `* Bot text`, **no operator rights needed**), `say` (`/say`: `[Bot] text`,
   operator) or `tellraw` (`/tellraw @a {"rawtext":[...]}`: no name in front, operator). The point is which prefix and
   which client-side filter a reply meets (the owner's client masked digits in player chat as `####` on 2026-10-29;
   whether the other routes avoid it is to be confirmed). The server expands `@` selectors in `/me` and `/say`, so a
   reply with an `@` is never sent that way. A refused command (a non-operator's `/say`, `/tellraw`) is resent as chat
   and the route pauses for a minute. The owner never has to wait for that: switching the setting, a restart and
   `!colors` try at once, and a refused try like that is announced in chat with the server's reason (the automatic
   retries stay quiet). A command that would pass 480 bytes is never sent. The only commands the route builds are
   `/me`, `/say` and `/tellraw @a`. Making the bot an operator on a Realm stays the owner's decision. (First version:
   tellraw only, a 10-minute pause and a log line; the owner opped the bot and saw nothing happen, hence this.)
7. **Blocks are framed and paged.** A titled `Doc` opens every message with a rule that carries the title and the page
   (`========== settings 2/5 ==========`) and closes the last one with a plain rule, so a block is visibly one thing among
   the chat; a small section is never split and a big one starts only where its heading and three lines fit. On the
   tellraw route every setting is a line of its own and sizes are counted as the JSON counts them (a newline is 2), so
   the command fits. There is no interactive paging: the pages arrive together, and the command is capped by the 480
   bytes even on tellraw, so a long list still takes several messages.

## Alternatives rejected

- **A colour per command, written by hand.** Scatters `§` through 40 files and rots the first time a tone changes.
- **Colouring only through `colorize()`.** It cannot make a heading, a table or a section; a Doc can.
- **`/tellraw` always, or `/tell` per player.** An always-on tellraw breaks on a non-operator account (the
  Realm is unverified). `/tell` works without operator rights (measured) but reaches one named player at a time
  as a whisper, so a reply is no longer visible to everyone and needs a recipient per message. `/me` is the
  route that works without operator rights.
- **A new packet path for lines (several `text` packets per Doc) instead of `\n`.** The server relays `\n` and
  the 8 replies per 10 seconds limit makes one message per line impossible.

## Consequences

- To keep the style consistent a future change goes through [../chat-style.md](../chat-style.md): the recipes,
  the rules and the reviewer checklist. The briefs for agents that touch chat output must include it.
- Long-list replies not yet converted (`!inv`, `!stock`, `!chests`, `!wp`, `!status`, `!build list`) are listed
  in the guide; each is a few lines with `chat.layout`.
- Open on the Realm: the account's operator status, the client's drawing of `§` and `\n`, and whether a
  `/me`, `/say` or tellraw message avoids the `####` masking. `!colors` and `!set chatVia me|say|tellraw` answer
  these in game.
