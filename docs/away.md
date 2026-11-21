# Away mode: the timeline, notifications, asking the owner (Track P5)

ADR [0116](decisions/0116-away-mode.md), step 5 of the panel programme. The owner leaves the bot with a queue of jobs
([queue.md](queue.md)) and comes back later. Away mode answers three questions:

- What happened? The Away view's timeline and its summary line.
- What needs me now? Notifications, the banner and the tab title.
- What should the bot do when a job fails? A question with choices, a wait and a default.

None of it moves the body. An answer chooses among paths the bot already had, and a question nobody answers ends
the way the bot behaved before questions existed.

| File | What |
|---|---|
| `bot/src/events/timeline.ts` | `buildTimeline`: the groups, their head lines, folded counts and facts, the summary counts and line (pure) |
| `bot/src/health/panel/notes.ts` | `noteFor` (which event notifies and what it says), `NoteLimiter` (the rate limit) (pure) |
| `bot/src/health/panel/away.ts` | `AwayLive`: the state's `away` block, `GET /api/timeline`, `GET /api/away`, `GET /sw.js`, `!notify test` (Track N1) |
| `bot/src/health/notify/discord.ts` | Track N1: the webhook URL (`loadWebhook`, the shape check `parseWebhook`, `webhookText`, `scrub`), the message (`payloadFor`), `DiscordSink` (the queue, 429, the timeout) |
| `bot/src/health/notify/discord-bot.ts` | Track D1: the Discord bot, one more `NoteSink` beside the webhook ([discord.md](discord.md)) |
| `bot/src/health/panel/client/away.ts` | the Away view, the banner, the tab title, the browser notifications |
| `bot/src/tasks/ask.ts` | `AskBox`: questions with choices, the bounded wait, the default |
| `bot/src/chat/commands-ask.ts` | `!answer`, the task's box (`askBoxOf`); `!yes` / `!no` in `chat/commands-nl.ts` |
| `bot/src/tasks/queue.ts` | the first use: a failed job asks (`askOwner`) |
| `bot/test/unit/events/timeline.test.ts`, `unit/health/panel-away.test.ts`, `unit/tasks/ask.test.ts`, `unit/tasks/queue.test.ts` | the rules, the routes, the sizes, the view on the fake DOM |
| `bot/test/e2e/panel-away.test.ts` | on bds-core through the panel's API: a failed job and a death in the timeline, a question answered, one left to time out |
| `bot/test/unit/health/notify-discord.test.ts`, `bot/test/e2e/panel-discord.test.ts` | Track N1: the shape check, the masking, the limits; a local fake webhook (never Discord) gets a death and a question once each |

## Settings

| Setting | Default | What |
|---|---|---|
| `notify` | off | alerts and questions become notes for the open panel pages, through the rate limit |
| `notifyDiscord` | off | the same notes to a Discord channel through the owner's own webhook ("Discord" below) |
| `discordBot`, `discordNotes` | off, dm | Track D1: the same notes through the owner's own Discord bot, a question's choices as buttons ([discord.md](discord.md)) |
| `askOwner` | off | a failed queued job asks the owner: retry, go on or pause |
| `askWaitS` | 120 s (10 to 1800) | how long a question waits before its default is taken |

The switches are off by default because each one changes what the owner sees, what leaves the machine or when the
queue goes on. The timeline needs no setting: it only reads the event history. Notes are made while `notify` or
`notifyDiscord` is on; each path gets them only while its own switch is on.

`!notify` (or `!notify status`) says where notes go: the panel switch and the limiter's counts, then Discord's line
(`discord: on, webhook set (id ...5678, discord-webhook.url); 3 sent, 0 failed, 0 dropped, 0 waiting; last sent (204)
2 min 0 s ago`). `!notify test` sends one test note through every path that is on, outside the rate limit, and says
what happened on each (`panel: a note for the open pages`, `discord: sent (204)`).

## The timeline

`GET /api/timeline?since=<ms>&group=job|hour&tz=<minutes east of UTC>` reads the window from the event history (the
ring, else the files: [events.md](events.md) "Query API"), at most 5 000 events, and groups it. The answer says
`truncated` when the window held more; the counts are then lower bounds, and the page says so.

**Groups.**

- `group=job` (the default): a queued job is one group, from its `queue.started` to its `queue.finished` or
  `queue.failed`. The time between jobs is grouped by the hour.
  - Why: the owner thinks in the jobs they queued ("did the kit finish?"). What happened between jobs (a chore, a
    night, a fight at home) has no job to hang it on, and an hour is the next unit people think in.
- `group=hour`: every event in its hour.
- Hours are the page's own. The page sends its time zone, so 14:00 starts at 14:00 where the owner is.
- Newest group first, at most 48. Older groups are counted (`olderGroups`), and a shorter window shows them.

**In a group.**

- **Head lines**: the notable and alert events, oldest first: the story of the group. At most the newest 10;
  `moreHead` counts the rest.
- **Facts**: one line made from the info events: items gained and lost (the top 4 each), fights, kills and damage,
  chores run by name, and commands started (hour groups).
- **Folded**: the info events as counts per kind (`7 more: 3 commands, 4 item changes`), with the group's id range.
  A tap fetches them all (`/api/events?since=<first - 1>&until=<last>&limit=200`).
  - Why folded: a night of chores is hundreds of info lines. The owner wants the few that matter first and the rest
    on demand.

**The summary.** `while away 3 h 12 min: 5 jobs done, 1 failed, 0 deaths, 1 reconnect`. Jobs, failures, deaths and
reconnects are always said, even at 0, because "0 deaths" is news too. Cancelled jobs, kicks and questions (with how
many went unanswered) are said only when there are any. Jobs count:

- queued jobs by their end;
- user processes started outside a queued job (a typed `!goto`) by their `job.*` end;
- a process inside a queued job is not counted again.

**Since I last looked.** The page keeps the time of the last look in the browser (`bbpanel-seen`). Leaving the Away
view, or Mark seen, sets it. Storage that the browser blocks is caught: the window is then the last 8 h. A first look
from a browser is the last 8 h and says so.

## Notifications

What notifies (`notes.ts` `noteFor`): every **alert** (the bot died, was kicked, lost the connection for good) and
every **question**. Each note says what happened and what the owner can do:

| Event | Title | What the owner can do |
|---|---|---|
| `life.died` | the bot died | nothing at once: it respawns by itself, and what it carried lies at the spot for 5 minutes; the Away view shows what led to it |
| `connection.kicked` | the bot was kicked | nothing when it reconnects by itself; else start it again on its machine |
| `connection.lost` | the bot lost the connection for good | start it again on its machine |
| `ask.asked` | the bot asks (#N) | answer in the Away view, or `!answer N <choice>` in the game, before the wait runs out (the default is named) |
| another alert kind | its line | the Away view has the rest |

**The rate limit** (`NoteLimiter`), so 3 deaths in a minute are not 3 pings:

- One kind at most once a minute (`NOTE_COOLDOWN_MS`). The ones in between fold into one note sent when the minute
  ends: `the bot died (2 times in 20 s)`, with the last one's text.
- At most 5 notes in 10 minutes over all kinds (`NOTE_WINDOW_MAX`, `NOTE_WINDOW_MS`). Beyond that they wait, folded
  by kind, until the window frees a place.
- A question skips the window and is never folded with another, because it has a deadline. Its own cooldown is
  10 s. The box keeps at most 4 questions open.

Notes are kept by the bot (the newest 20, `GET /api/away`). The newest 3 ride in the state.

### What reaches the owner, and what does not

The panel is served over plain http on the bot's machine, to the LAN or a VPN address. What a browser
allows depends on whether the page is a **secure context**: https, or http on `localhost` / `127.0.0.1`. Measured
with headless Edge on this PC (n=1 per origin; `.work/p5/secure-context.txt`):

| Origin | `isSecureContext` | `Notification.permission` | `navigator.serviceWorker` | `PushManager` |
|---|---|---|---|---|
| `http://127.0.0.1:<port>` | true | `default` (it can ask) | yes | yes |
| `http://localhost:<port>` | true | `default` | yes | yes |
| `http://<LAN address>:<port>` | false | `denied` (fixed: it cannot ask) | no | present but unusable without a service worker |

So:

| Path | Works? | Why |
|---|---|---|
| **The page open, any origin**: the banner, the tab title `(2) ...`, the header's `Away 2` | yes | plain page content |
| **The page open on the bot's machine** (`127.0.0.1`): a system notification | yes | a secure context: the page asks for permission on the device switch's tap |
| **The page open over the LAN or VPN** (a phone): a system notification | no | not a secure context: the permission is `denied` and cannot be asked. A short tone plays instead, once the device switch has been tapped (browsers allow sound only after a tap) |
| **The page open behind https** (any https front, below): a system notification | yes, while a panel tab is open, in the foreground or the background. Chrome on Android shows it only through a service worker: the page registers `/sw.js` on a secure origin only | |
| **The page closed** | no | nothing runs. Only Web Push can wake a closed page (below) |
| **Discord** (Track N1): a message in a channel, a push on a phone with the Discord app | yes, with the page closed, on any network | the bot posts to the user's own webhook ("Discord" below); no https and no open page needed |
| **Another outbound channel** (mail, ntfy, Pushover, Telegram) | not built | each needs its own account or token (below) |

**Web Push (not built).** A closed page can get a notification only through the browser maker's push service:
Google's FCM for Chrome, Mozilla's autopush for Firefox, Apple's for Safari. The bot would send each message there,
and that service wakes the browser.

- Acceptable in principle. The message is end-to-end encrypted to the browser (RFC 8291 aes128gcm), the sender is
  identified by its own VAPID key pair, and no account is needed. But every notification would leave the house
  through a third party's servers, and only when the browser maker keeps the service up.
- Not built, because it needs a secure origin: a service worker and `PushManager.subscribe` exist only there, and the
  panel's LAN or VPN origin is plain http. On iOS, Web Push works only for a page added to the Home Screen and served
  over https.
- What it would need:
  1. https for the panel ("A secure page", below);
  2. a VAPID key pair made once and kept in the config directory;
  3. `POST /api/push/subscribe`, with the subscriptions kept beside the queue file;
  4. the RFC 8291 encryption with `node:crypto` (ECDH P-256, HKDF, AES-128-GCM; no new package);
  5. outbound https from the bot's machine to the push service;
  6. a `push` handler in `/sw.js`.

  The rate limit and the notes are ready for it.

**A secure page (the user's choice).** The panel itself speaks plain http. https comes from a front the user runs on
the bot's machine or their network: any reverse proxy (Caddy, nginx, Apache, Traefik), `tailscale serve` on a
tailnet, or another TLS front with a certificate the phone trusts. The bot neither needs nor prefers one. Whatever the
front, it must:

- **Pass the `Host` header unchanged.** A POST from the page carries `Origin: https://<the name in the address bar>`,
  and the panel accepts it only when it equals `https://<Host>` (or `http://<Host>`; ADR 0116). A front that rewrites
  `Host` to `127.0.0.1:<port>` turns every command into a 403 `cross-origin request`.
- **Pass `Origin`, `Authorization` and `Cookie` through, with `panel.token` set.** Any name that is not the loopback
  needs the token; without one the panel answers 403 `loopback only`.
- **Not buffer the stream.** `GET /api/stream` is `text/event-stream` with a heartbeat every 5 s, and the panel sends
  `X-Accel-Buffering: no` and `Cache-Control: no-transform`. A front with a read timeout under 5 s, or one that holds
  the response until it ends, leaves the page polling: it still works, a second or two behind.

Examples, not requirements: Caddy's `reverse_proxy 127.0.0.1:<panel port>` keeps the Host and streams by default;
nginx needs `proxy_set_header Host $host;` and `proxy_buffering off;`; `tailscale serve --bg --https=443
http://127.0.0.1:<panel port>` serves the panel at `https://<machine>.<tailnet>.ts.net/` inside one tailnet. None
of these was measured with the panel by this project. The rules above are what the panel checks.

**Other outbound channels (not built).** Mail (an SMTP account), ntfy, Pushover or a Telegram bot would each need an
account or a token the user makes, a place for the secret (as for Discord: an environment variable or a file in the
config directory, never chat) and outbound network access. `DiscordSink` is the pattern: it takes every note the rate
limit lets through.

## Discord (Track N1)

A closed page gets nothing, and a phone's system notification needs https. A Discord webhook reaches a phone with the
page closed, on any network, with no https: the bot posts each note to a channel, and the Discord app shows a push
for it. Nothing in the bot names a server or a channel: every user makes their own webhook.

**Set-up (once).**

1. In Discord, on a server where you may manage webhooks: open the channel's settings (the gear by its name), then
   Integrations, Webhooks, New Webhook. Name it (that name shows as the sender), then Copy Webhook URL. A private
   channel is best: anyone who can read the channel sees what the bot sends.
2. Give the URL to the bot, in one of two places:
   - the environment where the bot starts: `BEDROCKBOT_DISCORD_WEBHOOK=https://discord.com/api/webhooks/123/EXAMPLE`;
   - a file named `discord-webhook.url` in the config directory (next to `config.json`; by default
     `%LOCALAPPDATA%\bedrockbot\` on Windows), with the URL on one line (blank lines and `#` comments are skipped).

   The environment wins over the file, and `--no-config` leaves the file unread. The bot reads the URL at start and
   again on every `!notify` and `!set notifyDiscord`, so a file put in place while the bot runs is picked up without
   a restart.
3. `!set notifyDiscord on`. The reply says whether a URL is set: `notifyDiscord: webhook set (id ...5678,
   discord-webhook.url); !notify test sends one`, or `no webhook URL is set, so nothing is sent: ...`.
4. `!notify test` sends one test message. The reply is one of `discord: sent (204)`, `discord: 401 the webhook is
   invalid or was deleted`, `discord: not set (...)`, `discord: refused (...)`, `discord: off (!set notifyDiscord on)`.

**Why never through chat.** The game chat is read by every player and written to the bot's log and the event store,
and a webhook URL is all anyone needs to post in that channel. So no command or setting takes it, and the bot never
prints it:

- `!notify`, `!set`, the panel's settings and Away view, the log and the events say only `set (id ...5678, <where>)`
  (the last 4 digits of the webhook's id, which is not the secret part), `not set`, or why it was refused;
- every line the Discord code logs or returns passes `scrub()`, and the panel's log ring hides any
  `webhooks/<id>/<token>` too;
- `discord-webhook.url` is in `.gitignore`, and the bot warns when that file sits inside the repository.

**The shape check.** Only `https://<host>/api/webhooks/<id>/<token>` is accepted.

- The host is one of `discord.com`, `discordapp.com`, `canary.discord.com`, `ptb.discord.com`,
  `canary.discordapp.com`, `ptb.discordapp.com`.
- An API version (`/api/v10/webhooks/...`) and a trailing slash are allowed. A port, a user, a query (`?thread_id=`,
  `?wait=`) or a fragment are refused.
- Why: the URL decides where the bot sends what happened in the user's game, so it may only ever be Discord's own
  webhook endpoint. A refusal names the rule broken, never the value.

**What is sent.** Every note the rate limit lets through ("Notifications": alerts and questions, at most 5 in 10
minutes, a question at most every 10 s), as one message:

- `content`: `<bot name>: <the note's title>`, what a phone's push shows;
- one embed: the title, the note's text (what happened and what the owner can do), the time, and a footer with the
  bot, the event kind and how many were folded; red for an alert, amber for a question;
- for a question, three fields: the choices (`1 retry (retry it), 2 next (go on), 3 stop (pause)`), when the default
  is taken (`in 2 min 0 s: next (the default)`), and how to answer. **Discord cannot carry an answer back** through a
  webhook, so the answer is `!answer <id> <choice>` in the game or the choice's button in the panel's Away view;
- `allowed_mentions: { parse: [] }`, so no text the bot sends (a player's name, a chat line) can ping `@everyone`, a
  role or a user;
- no `username` override: the webhook's own name shows (Discord refuses some names).

**The limits** (`DiscordSink`), on top of the note limiter's:

- **Discord's message limits** (characters): content 2 000, embed title 256, description 4 096, a field's value
  1 024, footer 2 048, 6 000 in all for an embed. Each text is cut to its limit, counted in UTF-16 units (never more
  than Discord counts) and never splitting a surrogate pair. These are the numbers in Discord's developer
  documentation; no test checks them against the live service, because no test contacts Discord.
- **One request at a time**, each with a 10 s timeout.
- **A `429` is honoured.** Its `retry_after` (from the JSON body, else the `Retry-After` header) holds every request
  until it passes, and the note goes back to the head of the queue, at most 3 tries. A wait over 10 minutes drops the
  queue. An answer with `X-RateLimit-Remaining: 0` holds the next request for `X-RateLimit-Reset-After`.
  - Why: Discord limits each webhook (a few requests a second, about 30 messages a minute in one channel) and blocks
    an address for a while after many 401, 403 or 429 answers. So the bot never hammers it.
- **At most 10 notes wait.** Beyond that the oldest is dropped and counted (`dropped` in `!notify`).
- **A 5xx answer or no answer** is tried once more after 30 s, then dropped. No retry storm.
- **A `401`, `403` or `404`** (a wrong token, a deleted webhook) stops the sending until the URL changes or
  `!notify test` (which tries once). One warning is logged.
- **Failures are logged at most once in 10 minutes.** Nothing the sink does is thrown into the bot.

**Testing without Discord.** No test contacts Discord. The unit tests and the `panel-discord` e2e post to a fake
webhook server inside the test (ports 10120 to 10129) through `BEDROCKBOT_DISCORD_TEST_ORIGIN`. That variable accepts
only `http://127.0.0.1:<port>` or `http://localhost:<port>`; the path stays the webhook's, and the URL must still pass
the shape check. Set to anything else, the bot logs an error and sends nothing.

## Ask the owner

`tasks/ask.ts` `AskBox`, one per task (`askBoxOf(task)`).

```ts
const q = box.ask({ key: 'queue-fail', text: 'job #4 ... failed: retry it, go on with the next, or pause the queue?',
  choices: [{ id: 'retry', label: 'retry it', aliases: ['yes'] }, { id: 'next', label: 'go on', aliases: ['no'] }, { id: 'stop', label: 'pause' }],
  default: 'next', waitMs: 120_000 });
const a = await q.answer; // { choice, how: 'panel' | 'chat' | 'console' | 'timeout' | 'replaced' | 'closed', by?, afterMs }
```

Each rule, and why:

- **The default is required, and it is one of the choices.** It is what the bot did before it asked. So a question
  nobody answers never makes anything riskier, and nothing waits for ever.
- **The wait is bounded**: 10 s to 30 min, whatever the caller asks. A shorter wait could not be answered; a longer
  one would hold the work all night.
- **One question per key.** A second one replaces the first, which takes its default (`replaced`). At most 4 are
  open; a fifth closes the oldest with its default (`closed`). The task stopping closes them all.
- **Every question and every answer is an event and a log line**: `ask.asked` (notable: the timeline shows it) and
  `ask.answered` (`ask: #2 answered retry by Steve (panel) after 14 s`, `ask: #3 unanswered after 2 min 0 s: next
  (the default)`). The question is also said in the game chat, kept past the chat's rate limit:
  `ask #2: ... !answer 2 retry|next|stop (!yes retry, !no next); in 2 min 0 s: next`.

**Answering.**

- **In the panel**: the Away view's card has a button per choice with the countdown. A tap sends `!answer <id>
  <choice>`.
- **In the game**:
  - `!answer` lists the open questions.
  - `!answer <choice>` answers the only one, by its word, its number or an alias.
  - `!answer <id> <choice>` answers one by its id.
  - `!yes` and `!no` answer too, when no `!do` plan waits and exactly one open question has a choice with that word.
    With two such questions neither is guessed. A plan from `!do` keeps `!yes` / `!no` first.
- An answer from the panel is marked `panel`, one from the server console `console`, one from the game `chat`.

**Where it is used: a failed queued job** (`askOwner`; [queue.md](queue.md) "A failed job").

- The choices: `retry` (the job again, first in line), `next` (go on), `stop` (pause the queue).
- The default is the queue's `onfail` rule, so unanswered is what the queue did without the question.
- The queue holds while it asks. With `onfail stop` the pause is saved at once, so a restart during the question
  leaves the queue paused.

## Measured

On bds-core (`panel-away` e2e, n3, `askWaitS` 10, through the panel's API):

| Case | What was measured |
|---|---|
| timeline | a queue of `!craft diamond_sword` with no materials (failed), a `!goto` about 31 blocks off during which the bot was killed, and `!pos` (done). `GET /api/timeline` since the start: 4 groups, the death in the walk's group as a head line (`died (generic) at ...`), the line `1 job done, 1 failed, 1 cancelled, 1 death, 0 reconnects`. The walk ended `cancelled` (`interrupted (last: walking to ...)`, [queue.md](queue.md) "Known limits"). 1 879 bytes over 16 events, answered in 1 to 2 ms. The away block was 302 bytes of a 15 762-byte lite state. With `notify` on, the death's note was in the block 1.1 to 1.2 s after the kill |
| answer | `askOwner` on: the question was in the away block 0.0 s after the failure, with `retry`, `next`, `stop`, default `next`, a 10 s deadline. The queue's hold line named it, and the next job waited. `!answer <id> retry` put the job back first in line; it failed again and asked again. `!answer <id> next`: the next job started 5.3 s after the answer and ended `done`. Both answers were `ask.answered` events with `how: panel`, and both questions were notes |
| timeout | left alone with `onfail next`: the next job started 15.3 to 15.4 s after the failure (`question #N unanswered after 10 s: next (the default)`). With `onfail stop`: the queue was paused from the failure (`#N failed: the owner is asked`) and still paused after the wait (`#N failed (unanswered: the onfail rule)`), the next job waiting |

On bds-core (`panel-discord` e2e, n3, a fake webhook on the loopback, `notify` off so Discord alone made the notes,
the URL from `BEDROCKBOT_DISCORD_WEBHOOK`):

| Case | What was measured |
|---|---|
| test | `!notify test` through the panel's API: one POST 0.23 to 0.24 s after the command, the reply `discord: sent (204)` |
| death | the bot killed by the server: one POST 1.15 to 1.20 s after the kill, none more in the next 5 s |
| question | `askOwner` on, a queued `!craft diamond_sword` with nothing: one POST 0.01 s after the question was asked, with the choices `1 retry (retry it (next in line)), 2 next (go on with the next), 3 stop (pause the queue)`, `in 30 s: next (the default)` and how to answer; none more after `!answer <id> next` |
| secret | the token in none of the bot's whole output (about 10 000 characters), `/api/state`, `/api/state?lite=1`, `/api/help`, `/api/away`, `/api/events`, the event store's files, and the replies of `!set`, `!set notifyDiscord`, `!notify` |

Unit worst cases: the away block 4 738 bytes (4 questions of 6 choices, 3 notes, every text at its limit); a timeline
of 48 job groups with full head lines 149 313 bytes (`health/panel/budgets.ts` `away`, `timeline`).

## Known limits

- **A closed page gets nothing** except through Discord (`notifyDiscord` and a webhook). Web Push needs https and a
  vendor push service; other outbound channels need their own account. Neither is built (above).
- **The webhook is one way.** An answer goes back through `!answer` in the game or the panel. Track D1's Discord bot
  ([discord.md](discord.md)) takes commands and answers (buttons) from Discord, with the user's own bot token.
- **Discord itself was never called by a test.** The limits and status codes are Discord's documented ones. The fake
  server answers 204; the unit tests feed 429, 401, 404, 5xx and requests that never answer.
- **Over plain http on the LAN or VPN**, an open page has a tone, the banner and the title, not a system
  notification.
- **A notification on Chrome for Android** through `/sw.js` was not measured on a phone. The headless browser here
  left the service worker's registration pending.
- **Only a failed queued job asks.** Other places that could ask (a death far from home, a trip refused for wear)
  need their own question and default.
- **A death during a queued walk ends it `cancelled`**, so it does not ask ([queue.md](queue.md) "Known limits").
- **The timeline reads at most 5 000 events.** A longer window says `truncated`.
