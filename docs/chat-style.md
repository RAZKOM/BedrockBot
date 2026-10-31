# Chat style: colours, framed multi-line blocks, and the /me, /say and /tellraw routes

**Read this before you print more than one line, want a colour, or add a command or a setting.** The
style lives in one place (`bot/src/chat/style.ts`); everything else asks it. If you find yourself typing a
section sign (`§`), counting characters for a chat limit (the limits are in BYTES), or writing `if (chatLines)`, stop: one of the
recipes below does it for you.

Decision record: [decisions/0050-chat-style.md](decisions/0050-chat-style.md). What it looks like in your
own client: type `!colors` in game.

## The three switches (settings, all off or `chat` by default)

| Setting | Does | Default |
|---|---|---|
| `chatColor` | Every reply is coloured: commands aqua, numbers gold, one verdict word (done / failed / no path), a trailing `(note)` gray | off |
| `chatLines` | Long structured answers (`!help`, `!help all`, `!help settings`, `!set`) are a few multi-line messages with headings, instead of one packed line each | off |
| `chatVia` | How replies are sent, see "Routes": `chat` (`<Bot> text`), `me` (`* Bot text`, no operator needed), `say` (`[Bot] text`, operator) or `tellraw` (no name in front, operator). A refused route falls back to chat | `chat` |

Defaults stay off in code so every test and every other task is unchanged. The owner turns them on after
`!colors` shows the client draws them: `!set chatColor on`, `!set chatLines on`, `!set chatVia me` (or `say`,
`tellraw`). Settings are live: the next reply uses them.

## Layers

```
command code            reply('text')  |  chat.layout(plain, build)  |  chat.paint(tone, text)
        |
Chat.say()  (chat/chat.ts)   rate limit 8 / 10 s, hint, then finish():
        |                      cut to the reply limit, colorize() if chatColor, fitWire() <= 480 BYTES
        |
Chat.send()                  chat packet | /me text | /say text | /tellraw @a {"rawtext":[...]}  (chat/route.ts)
```

| File | What |
|---|---|
| `bot/src/chat/style.ts` | **The only file that builds `§` codes.** `Tone`, `paint`, `colorize`, `strip`, `fitWire`, `Doc`, `wireSize` (bytes), the limits `MAX_WIRE` (480) and `DOC_MESSAGE` / `DOC_TELLRAW` (440), `RULE_WIDTH` |
| `bot/src/chat/help-rich.ts` | `!help` / `!help all` / `!help <cmd>` / `!help settings` / `!set` as Docs, built from the registered metadata |
| `bot/src/chat/commands-style.ts` | `!colors` (the demo and the route line) |
| `bot/src/chat/route.ts` | `routeCommand` (the only builder of /me, /say, /tellraw), `commandRequestPacket`, `SlashRoute` (the pause after a refusal), `ROUTE_INFO` (what each route looks like), `SLASH_MAX` (480 bytes) |
| `bot/src/chat/chat.ts` | `styleSource`, `styleMode()`, `paint()`, `layout()`, `routeStatus()`, `finish()`, `send()` |
| `bot/src/chat/help.ts` | `SETTING_GROUPS`: every setting in exactly one group (a unit test fails otherwise) |
| `bot/test/unit/chat/style.test.ts` | the unit tests and the two guards |
| `bot/test/e2e/chat-style.test.ts` | what the server relays and drops (re-measure after every BDS bump), and the /me, /say and /tellraw routes against bds-dev |

## Recipes

### A one-line reply (almost always)

```ts
reply('goto: no path to 100 64 -50 (blacklisted, try !come)');
```

Nothing else. With `chatColor` on, `colorize()` makes the command aqua, the numbers gold, `no path` red and
the trailing note gray. Write replies as you did before; keep the verdict word near the start; put side notes
in a trailing `(parenthesis)`.

### You know what a word means and the guess would be wrong

```ts
reply(`${chat.paint('bad', 'refused')}: ${name} is not yours`);
```

`chat.paint(tone, text)` is the text itself when `chatColor` is off. A reply with a painted part is sent as it
is (no second automatic pass), so paint every part that matters.

### A list, a table, several parts (help, stock, chests, waypoints)

```ts
for (const m of chat.layout(oldLines, (d) => {
  d.title('stock', `${rows.length} items`);
  d.section('tools');
  d.pairs(rows.map((r) => ({ key: r.name, value: String(r.n) })));
  d.note('!bring <item> fetches one');
})) reply(m);
```

`chat.layout(plain, build)` returns `plain` untouched when `chatLines` is off (keep the lines you had: tests
and the panel compare them) and the Doc's messages when it is on. Write both once; never branch on the modes
yourself. `Doc` strips `§` from everything you pass in and lays the block out:

```
========== settings 1/5 ==========      every message opens with a rule: the title, and the page when there are several
67 · mode normal                         the title's detail (gray), first message only
safety                                   a section heading
fleeHealth 12  guardRadius 16 ...        pairs, packed to the width (tellraw: one per line)
walking (cont.)                          a section that runs on repeats its heading
...
!set <key> explains one ...              the note
==============================           the last message closes with a plain rule
```

- A Doc **with a title is framed**; one without (`!help <cmd>`, a few lines) is not. `new Doc(mode, { frame: false })` turns it off.
- Messages are packed to 440 BYTES (`DOC_MESSAGE`), a line is never split, and a small section (up to half a message) is
  never split at all; a big one starts only where its heading and first three lines fit.
- On the **tellraw route** (`mode.tellraw`) every `pairs` entry is a line of its own, and sizes are counted the way
  the JSON string counts them (a newline and a quote are 2), so the command always fits (`DOC_TELLRAW`).
- The page labels (`2/5`) are the pagination: there is no `!set 2`, the pages arrive together, one reply each
  (5 of the 8 per 10 seconds).

Doc building blocks: `title(name, detail?)`, `section(name, detail?)`, `item(cmd, text)`, `line(text)`,
`dim(text)`, `tone(tone, text)`, `tokens(list)`, `pairs([{key, value}])`, `note(text)`.

### A new command

Register it with `tier`, `group`, `help`, `example` (and `auto` when it also happens by itself). `!help`,
`!help all` and `!help <cmd>` are generated from that; nothing in help-rich.ts changes. The `ux.test.ts`
guards fail when a command is missing from `!help all`.

### A new setting

Add it to `SETTING_DEFS` **and to a group in `SETTING_GROUPS`** (`bot/src/chat/help.ts`). `!set` and
`!help settings` list from the groups; a unit test fails when a setting is in none (or in two). Give it a
`description` that works as the one-line explanation `!set <key>` prints.

## Rules

1. **No `§` literal outside style.ts.** A guard test scans `bot/src` and fails on any other file with a
   section sign, except an allow-list of files that only strip codes from names. Do not add to the list for a
   colour; use `paint` / `Doc`.
2. **No mode branching.** Do not read `chatColor`, `chatLines` or `chatVia` in a command. `chat.layout`,
   `chat.paint` and `Chat.say` read them.
3. **The text is complete without colour.** Tests compare `strip(message)`. Never put information only in a
   colour (a red word that is not also a word).
4. **Messages are at most 480 BYTES with their codes** (see Limits; `wireSize(s)` counts them, a `§` is 2). `Chat.say`
   guarantees it (`fitWire` falls back to the plain text); Doc packs to it. Never measure with `.length`, and do not send
   long text around `say`.
5. **8 replies per 10 seconds** (`maxReplies`). A Doc of 4 messages uses half. Do not turn a one-line reply into
   a Doc without need; `!help settings` is 4 messages, a table of 30 rows should not be 12.
6. **Dark colours are not used** (the chat background is dark): the tones in `style.ts` are the palette.
7. **Reuse the tones.** `cmd` aqua, `ok` green, `bad` red, `warn` yellow, `num` gold, `dim` gray, `head` gold
   bold, `sub` yellow bold, `name` purple. A new tone is a change to `CODE` in style.ts, not a literal elsewhere.

## Limits (measured, not assumed)

On BDS 1.26.60.6 (`bot/test/e2e/chat-style.test.ts` pins every line; re-run it after a BDS bump and when a
Realm update lands: `BDS_E2E=1 pnpm exec vitest run --project e2e chat-style`):

| Fact | Result |
|---|---|
| `§` codes in a player chat message | relayed unchanged (also a trailing sign and an unknown code) |
| Newlines in a chat message | relayed unchanged (how a client draws them is what `!colors` shows) |
| Chat message length | **counted in UTF-8 bytes** (a `§` is 2): 503 relayed, 515 DROPPED SILENTLY (no error, no kick); 480 characters with 40 signs (520 bytes) are dropped. We cap at 480 bytes |
| `command_request` length | **counted in bytes too**: 505 delivered, **511 makes the server drop the connection**, ASCII or with signs alike. We cap at 480 bytes (`SLASH_MAX`, `wireSize`) |
| `/me <text>` as a **non-operator** | works; arrives as `chat` with no source name, message `* Bot text`; colour codes and newlines relayed |
| `/say <text>` | operator only (non-operator: `commands.generic.error.permissions`, parameter `say`); arrives as `announcement`, source = the bot, message `[Bot] text` |
| `@a` and other selectors in `/me` and `/say` text | expanded by the server (an operator: replaced by the player names; a non-operator: the command is refused, `commands.generic.permission.selector`). A reply with an `@` never goes out through them |
| `/tellraw @a` as an operator | delivered to every player as `json_whisper` (the message is the rawtext JSON); success gives no `command_output` |
| `/tellraw @a` as a non-operator | refused at once: `command_output` with `success_count` 0 and `commands.generic.permission.selector` (other refusals: `commands.generic.error.permissions`, `.syntax`, `.unknown`) |
| `/tell <name>` as a non-operator | works, arrives as a `whisper` (this is how the update notice reaches the owners) |

**Not verified on the Realm** (only on local BDS): whether the Realm bot account is an operator, whether the
Realm relays `§` and newlines the same way, and how the owner's client draws them. `!colors` is how to check
the last one; `!set chatVia tellraw` followed by any reply is how to check the first (the bot logs
`/tellraw refused (<message id>)` once and `!colors` says so).

The owner's client masks digits in player chat as `####` (observed 2026-10-29). A tellraw message is a system
message, not player chat, so it may avoid that filter; not confirmed.

## Routes (`chatVia`)

| Value | Looks like | Operator? | Command | Notes |
|---|---|---|---|---|
| `chat` | `<Bot> text` | no | the chat packet | the default; the owner's client masks digits in it as `####` (observed 2026-10-29) |
| `me` | `* Bot text` | **no** | `/me <text>` | arrives as chat; the prefix is only in front of the first line; no `@` in the text |
| `say` | `[Bot] text` | yes | `/say <text>` | arrives as an announcement; no `@` in the text |
| `tellraw` | `text`, nothing in front | yes | `/tellraw @a {"rawtext":[{"text":"..."}]}` | arrives as a system message (`json_whisper`); the JSON carries any text, `@` too; no click or hover events on Bedrock |

The point of the routes is which prefix and which client-side filter (`####`) a reply meets. Which one is best on the
Realm is for the owner to try: `!set chatVia me`, then `!colors`.

The safety net is built in, do not duplicate it:

- A command longer than `SLASH_MAX` (480 **bytes**) is never sent; that reply goes out as chat. So is a reply the style
  cannot carry (an `@` for `me` / `say`, an empty text).
- A refused command (its `command_output` has `success_count` 0 and the uuid we sent) is resent as chat at once and the
  route pauses for a minute (`RETRY_MS`), after which the next reply tries it again by itself.
- **Switching `chatVia`, a restart with a route on, and `!colors` try at once** (`Chat.retryRoute`): the next reply is
  the test. If the server refuses it, the owner gets one chat line a moment later (after the refused replies were
  resent): `chatVia say: refused by the server (<message id>), so replies stay in chat. The bot is probably not an
  operator; make it one, then !colors tries again` (for `me` without the operator sentence: it needs none). The
  automatic retries after that refuse quietly (a log line only), so a non-operator account never gets a stream of
  warnings. Success is silent on the wire: a working route shows as replies with the new look. `!colors` shows the route.
- **The only commands this code sends are `/me`, `/say` and `/tellraw @a`** (`routeCommand`; a unit test checks that a reply
  saying `/op Bot` or `/stop` stays text). Do not add other commands to `Chat.send`.
- Making the bot an operator on a Realm is the owner's decision. Do not assume it, and do not ask the bot to op itself.
- **New route:** add it to `ROUTE_VIAS`, `ROUTE_INFO` and `routeCommand` in route.ts and to the `chatVia` setting's
  `values` / `parse`; a unit test fails when they disagree. Measure it first (probe a fresh client per case, an
  over-long command disconnects the sender) and add the result to the Limits table and the e2e.

A route's messages do not reach `Chat.handle` as commands: `/me` arrives without a source name and `/say` with the bot
as source, both ignored by `senderOf`, so there is no feedback loop.

## `colorize()`: what it guesses, and where it is blind

It runs only on replies that carry no codes yet. It colours: `!command` words (aqua), numbers and
coordinates (gold, but not versions like `1.26.60`, sizes like `5x3x5` or ids like `oak_log2`), one verdict
word in the first 60 characters, and a trailing `(note)` gray. One verdict per reply, the worst news first:

| Tone | Words (`OK_WORDS`, `BAD_WORDS`, `WARN_WORDS` in style.ts) |
|---|---|
| red | failed, cannot, refused, unreachable, no path, not available, unknown, error, stuck, died, not safe |
| green | done, ok, saved, started, arrived, resumed, success, completed, ready, finished |
| yellow | stopped, paused, cancelled, nothing to, no command, missing, low |

It is blind to meaning: a number that is a name, a player called "done". For those use `chat.paint` or accept
the plain word. Add to the word lists in style.ts when a common reply is missed, and add that reply to
`CORPUS` in style.test.ts.

## Reviewer checklist

- [ ] No `§` outside style.ts (the guard passes without a new allow-list entry).
- [ ] Multi-line output goes through `chat.layout`, with the old lines as `plain`.
- [ ] The new setting is in `SETTING_GROUPS`; the new command has tier, group, help and example.
- [ ] A test compares `strip(...)` or the plain form, not a coloured string (except style.test.ts).
- [ ] Nothing builds a `command_request` for chat output outside route.ts / `Chat.send`.
- [ ] Sizes are measured with `wireSize` (bytes), never `.length`; no message can pass 480 bytes with codes.

## Brief for an agent that touches chat output

> Read docs/chat-style.md first. One-line replies need nothing special. Several lines: `chat.layout(plain,
> build)` with a `Doc`. Never type `§`, never read chatColor / chatLines / chatVia. New setting: add it to
> `SETTING_GROUPS` in chat/help.ts. New command: set tier, group, help, example. Keep every message under 480
> BYTES with codes (`wireSize`, a `§` is 2) and remember the 8 replies / 10 s limit. Run `pnpm exec vitest run --project unit
> test/unit/chat` before you finish.

## Not converted yet

These still print as packed one-line lists and would gain from `chat.layout`: `!inv`, `!stock`, `!chests`,
`!wp` (waypoint list), `!status` (long form), `!build list`. Each is a few lines: keep the current lines as
`plain`, build the Doc, add a test next to the command's own.
