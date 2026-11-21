# Discord: command the bot and answer it from Discord (Track D1)

ADR [0118](decisions/0118-discord-bot.md). The bot can be its own Discord bot: an allowed Discord user sends `!pos`
or `!goto home` in a channel or a direct message and gets the reply there, notes arrive as messages, and a question's
choices are buttons. A phone with Discord is enough, on any network. Nothing listens on the bot's machine: the bot
connects out to Discord, as a browser would.

Every user makes their own Discord application and bot. Nothing in the project names a server, a channel or a person.
The webhook of [away.md](away.md) "Discord" stays: it is one way (notes only) and needs no bot. Both may be on.

| File | What |
|---|---|
| `bot/src/health/notify/discord-access.ts` | the rules, pure: who and where (`gate`), the refused commands (`refusal`), the per-user limit, the token (`loadToken`, `parseToken`, `tokenText`, `scrubToken`), the id lists, the reply's cut (`replyMessages`), the button ids |
| `bot/src/health/notify/discord-gateway.ts` | `DiscordGateway`: the websocket (identify, heartbeat, resume, reconnect, backoff, the fatal closes) |
| `bot/src/health/notify/discord-rest.ts` | `DiscordRest`: the HTTP calls (rate-limit buckets, 429, 401, timeouts) |
| `bot/src/health/notify/discord-bot.ts` | `DiscordBot`: the wiring (messages to commands, replies, notes, buttons, `!discord`) |
| `bot/src/health/panel/away.ts` | `NoteSink`: away mode's notes to each sink that is on |
| `bot/src/events/actor.ts` | `viaDiscord`, `sourceOf`: a command's source `discord` |
| `bot/test/unit/health/discord-access.test.ts`, `discord-bot.test.ts`, `fake-discord.ts` | the rules; the gateway and REST against fakes; the whole bot against a local fake Discord |
| `bot/test/e2e/discord-bot.test.ts` | on bds-core: a real bot process against the local fake Discord |

## Set-up from nothing

You need a Discord account and a Discord server where you may add bots (your own: Discord's "+" button, Create My
Own, makes one in a minute). The steps name the Discord pages as they were known when this was written; Discord moves
things from time to time.

1. **Make the application.** Open the Discord Developer Portal (`https://discord.com/developers/applications`),
   sign in, New Application, give it a name (the bot shows with that name), accept the terms.
2. **Set up its bot user.** In the application, open **Bot**.
   - **Reset Token**, confirm, **Copy**. This is the bot's password: whoever has it can act as the bot. Do not paste
     it into Discord, the game or a chat; step 5 says where it goes. Discord shows it once; if it is lost or seen by
     anyone, Reset Token again (the old one stops working).
   - Under **Privileged Gateway Intents**, switch on **Message Content Intent** and Save. Without it Discord sends
     the bot messages with empty text and the gateway closes with 4014; `!discord` then says so.
   - Switch off **Public Bot** (Save), so only you can add the bot to a server.
3. **Invite it to your server.** In **OAuth2**, copy the **Client ID** (the application id; it is not a secret).
   Open this link with your id in place of `<application id>`:

   ```
   https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=84992
   ```

   Choose your server and Authorise. The scope `bot` adds the bot user (no slash commands and no other scope are
   needed). `84992` is the sum of the four permissions it uses: View Channels (1 024), Send Messages (2 048), Embed
   Links (16 384: the notes are embeds) and Read Message History (65 536: a reply points at your message). The same
   link can be made in **OAuth2**, **URL Generator**: tick `bot`, then those four permissions.
4. **Find the ids.** In Discord, User Settings, Advanced, switch on **Developer Mode**. Then right-click (on a phone:
   long-press) your own name and **Copy User ID**, and the channel the bot should answer in and **Copy Channel ID**.
   Ids are 17 to 20 digits. They are not secrets, but the bot shows only their last 4 digits in chat.
   A private channel only you (and the people you list) can read is best: everyone who reads the channel sees the
   bot's replies.
5. **Give the bot the token**, in one of two places (the environment wins):
   - the environment where the bot starts: `BEDROCKBOT_DISCORD_TOKEN=<the token>`;
   - a file named `discord-bot.token` in the config directory (next to `config.json`; by default
     `%LOCALAPPDATA%\bedrockbot\` on Windows), the token on its first line (blank lines and `#` comments are skipped;
     a leading `Bot ` is accepted). `--no-config` leaves the file unread.

   The file name is in `.gitignore`, and the bot warns when the file sits inside a repository.
6. **The settings**, in the game, the panel or `settings.json` (ids separated by commas or spaces):

   ```
   !set discordUsers 111111111111111111
   !set discordChannels 333333333333333333
   !set discordNotes dm
   !set discordBot on
   ```

   `discordNotes` is `dm` (the default: notes as direct messages to the listed users), a channel id, or `none`.
7. **Test it.** `!discord` says whether it is connected (`discord bot: on, token set (discord-bot.token); gateway ready
   for 5 s (1 session, ...)`). `!discord test` sends one test note to where notes go. Then, in the listed channel, send
   `!pos`: the reply comes back as a reply to your message. In a direct message to the bot the `!` may be left out.

**What to keep safe.** Anyone who can log in as a listed Discord user can command the bot as its owner. Use
two-factor login on that account. If the token leaks, Reset Token in the portal and put the new one in place
(`!discord` reads it again).

## Settings and command

| Setting | Default | What |
|---|---|---|
| `discordBot` | off | connect to Discord with the token and take commands, send notes and buttons |
| `discordUsers` | none | up to 10 Discord user ids that may command the bot; `none`: nobody |
| `discordChannels` | none | up to 10 server channel ids where commands are taken; direct messages from listed users always are |
| `discordNotes` | dm | where notes go: `dm` (each listed user), a channel id, or `none` |

`!set` shows the lists as `2 ids (...1111, ...2222)`. The panel's settings editor holds the whole value it edits (the
panel needs its own token).

`!discord` (or `!discord status`), two lines:

```
discord bot: on, token set (BEDROCKBOT_DISCORD_TOKEN); gateway ready for 3 min 2 s (1 session, 1 resumed, 1 reconnects, heartbeat 48 ms)
discord bot: 1 user, 1 channel, notes dm; in: 4 run, 1 presses, 1 refused, 0 rate-limited, 3 ignored; out: 9 sent, 0 failed, 0 waiting
```

When it is not ready the first line says why (`gateway stopped: the token was refused (401): make a new one in the
developer portal`, `gateway waiting (..., last: 4000 ...)`). `!discord test` sends one test note to the notes target
and says what happened (`discord bot: test sent to 1 of 1 channel (channel ...3333)`). Both read the token again.
`!notify` carries a short line too (`discord bot: on, gateway ready, notes dm; 2 notes, 9 sent, 0 failed, 0
dropped`), and `!notify test` tries every path that is on.

## The security model

The rules are ADR 0118's "Security model", each with its reason; in short:

- **Closed by default**: the switch off, no token, no users: each step is the user's own act.
- **Who**: Discord user ids, never names (a name can be copied; an id cannot).
- **Where**: a listed channel, or a direct message from a listed user. A listed user in another channel is ignored
  too: the user decides which channels carry the replies.
- **Everything else is ignored without a reply**: strangers, other channels, other bots, webhooks, the bot itself,
  system messages. They are counted (`!discord`) and logged as one count line at most every 10 minutes.
- **The same handler**: a command runs as the panel's does, as the first owner, marked `discord` in the command
  event, an answer's `how` and a queued job's `via`. The log names both sides:
  `discord: !goto home (as <owner>, from <discord user id>)`. A command from Discord pauses the queue as a typed one
  does ([queue.md](queue.md)).
- **Refused, with the reason**: `!quit` (nothing on Discord could start the bot again), `!test` (it sends slash
  commands as an operator), `!learn` (it records a flight flown in the game), and `!set` with a value for any of the
  four `discord*` settings (Discord may not widen or move its own door). `!queue add` from Discord checks the line it
  queues by the same rule, and a `!do` plan cannot set the four keys from anywhere (its steps run past this check).
- **Per user**: 5 commands (button presses too) in 20 s; the first one over is told, the rest of the window ignored.
- **No pings**: every message carries `allowed_mentions: { parse: [] }`, so nothing the bot repeats (a player's chat,
  `@everyone`) pings anyone.
- **The token** is never a setting, a command or chat. Every output says only `set (<where>)`, `not set` or
  `refused (<where>: <reason>)`; every line the Discord code logs or returns is scrubbed of it; the panel's log ring
  hides token-shaped strings; it goes only to `https://discord.com/api/v10` and to a gateway URL that is `wss://` on a
  `discord.gg` host.
- **Nothing listens**: an outbound websocket and outbound https only; no port, no public URL, no https front.

## Replies, notes and buttons

**Replies.** What the bot says while the command runs becomes one reply to the user's message, in a code block, the
game's colour codes removed. A long answer is split between lines into at most 3 messages of 2 000 characters; the
rest is counted (`... 12 more lines (the game chat and the panel have them)`). A command that has said nothing after
1.5 s gets `!x: no reply yet (what the bot says in the next 2 min follows here)`. For 2 min after a command, what the
bot says follows into the same channel, batched every 2 s, at most 8 messages: a `!goto`'s `walking to ...` comes as
the reply, its `arrived at ...` a few seconds later. One command is followed at a time; the next takes over.

**Notes.** Every note away mode's limiter lets through ([away.md](away.md) "Notifications": alerts and questions, at
most 5 in 10 minutes, a question at most every 10 s) goes to the notes target, built as the webhook's message (the
title in the text, one embed). With `dm` each listed user gets it as a direct message. Discord lets a bot open a
direct message only with a user who shares a server with it and accepts direct messages from that server's members;
`!discord test` shows whether it reached them. At most 10 notes wait.

**Buttons.** A question's note carries its choices as buttons (5 a row, the default grey and marked `(default)`). A
press by a listed user runs `!answer <id> <choice>` (logged `discord: !answer 3 next (a button, as <owner>, from
<id>)`) and the message is updated at once to show the answer (`next by <owner> (discord) after 14 s`), the buttons
gone. A press by anyone else gets a private refusal only they see, and changes nothing. A button from before a restart
says it is closed. When a question ends any other way (answered in the game or the panel, its default taken), the
bot edits its messages the same way (`Unanswered: next (the default) after 2 min 0 s`).

## The limits

- **The gateway**: Discord's v10, JSON. The first heartbeat after `interval x random`, then every interval; a beat
  not acknowledged closes the link and resumes the session. Reconnects back off 2 s doubling to 5 min, with jitter.
  The closes that cannot get better by trying again (4004 a refused token, 4010 to 4013, 4014 an intent not switched
  on) stop it with the reason and no loop. At most 20 new sessions in 24 h (Discord allows 1 000). At most 100 frames
  a minute (Discord allows 120; heartbeats always go).
- **REST**: one queue per route with Discord's bucket headers honoured, a 429 waited out (3 tries; a wait over 60 s
  fails it), a global 429 holding every route, at most 10 requests a second in all (Discord allows 50), 10 s a call,
  a 5xx or no answer tried once more. A 401 stops every call and the gateway until the token changes.
- **A press is answered within 2.5 s** (Discord allows 3 s), never retried.
- **Nothing is thrown into the bot**: every handler is caught; a failure is counted and logged at most once a minute.
  A Discord outage costs the bot nothing but the messages.

**Not checked against Discord.** No test contacts Discord. The opcodes, close codes, intent bits, permission bits,
rate limits, the 3 s, the message and button limits, the User-Agent form and the direct-message rule are from Discord's
developer documentation as known when this was written. If something stops working, these are the numbers to recheck.

## Testing without Discord

`bot/test/unit/health/fake-discord.ts` is a small Discord in the test: an HTTP server for the REST routes the bot
uses and a websocket (HELLO, IDENTIFY, RESUME, heartbeats, dispatches) on the same loopback port. The bot reaches it
through `BEDROCKBOT_DISCORD_TEST_ORIGIN=http://127.0.0.1:<port>`, which takes only `http://127.0.0.1` or `localhost`
with a port (anything else: the bot logs it and connects nowhere), and the gateway URL the fake hands out must be on
the same host and port. The unit tests use ports 10130 to 10134; the e2e has the panel there and the fake on 10135
to 10139:

```
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e discord-bot --silent=false
```

Measured with it on bds-core (n3, 3 of 3): IDENTIFY 1.2 to 1.7 s after the bot starts; `!pos`'s reply under 0.01 s
after the message, as a reply to it, with its source `discord` in the command event; a `!goto` 10 blocks off, `walking
to` as the reply and `arrived` followed 4.5 s after the message; four messages from a stranger (in the channel and in
a direct message), the allowed user in another channel and a bot: no reply in 4 s; `!quit` refused with its reason,
the bot still up; a job queued from Discord failing, its question's note under 0.01 s after the question with its
three buttons, a stranger's press answered privately and changing nothing, the owner's press answered (type 7,
`next by <owner> (discord)`) under 0.01 s after it and the answer's event `how` `discord`; the token in none of the
replies, `/api/state`, `/api/state?lite=1`, `/api/away`, `/api/events`, the event store, the bot's output or the
messages sent to the fake Discord.
