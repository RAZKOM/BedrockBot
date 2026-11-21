# 0116: Away mode: the timeline, notifications, asking the owner (Track P5, panel programme step 5)

Date: 2026-11-20. Status: accepted. New settings `notify` (off), `askOwner` (off) and `askWaitS` (120 s). Guide:
[../away.md](../away.md); the view: [../panel.md](../panel.md) "Away view"; the queue's question:
[../queue.md](../queue.md) "A failed job"; the levels: [../events.md](../events.md) "Severity rules".

## Context

With the job queue (ADR 0115) the owner can leave the bot with an evening's work. When they come back they have no
short answer to "what happened?". The event history (ADR 0059) holds every fact, but only as a list or an 8-hour
summary. While they are away nothing tells them that the bot died or that a job failed. And a failed job can only go
on or pause by a rule fixed beforehand. Step 5 of the panel programme asks for a timeline, notifications that work
with no cloud, and a way for the bot to ask.

## Decision

1. **The timeline is built from the event history on request** (`events/timeline.ts`, `GET /api/timeline`). It is not
   a new store or a new stream topic.
   - Groups: a queued job (from `queue.started` to its end), else the hour in the page's own time zone. Newest
     first, at most 48.
   - In each group: the notable and alert events (at most 10); a line of facts from the info events; the rest folded
     as counts, fetched on a tap.
   - A summary line counts jobs done and failed, deaths and reconnects (always said), and cancelled jobs, kicks and
     questions (when there are any).
   - Rejected: a new topic (the stream URLs are pinned by the views and their tests, and a timeline is read once per
     look, not followed); grouping by job only (what happens between jobs would have no place).
2. **Five event kinds, one per fact.** `queue.started`, `queue.finished` and `queue.failed`, because the `job.*` events
   are per process: a `!get` job is many processes, and a command that only answers is none. `ask.asked` and
   `ask.answered` for the questions. `queue.failed` and `ask.asked` are notable, the rest info. Nothing else was
   added: deaths, kicks, reconnects, fights, chores and items were already events.
3. **Away mode reaches every page through the lite state** (an `away` block: the notify switch, a mark, the newest 3
   notes, the open questions). So a polling page and a hidden tab get it too, and no view needs a fetch at start.
   The mark (the newest notable or alert, queue or ask event id) tells an open Away view to fetch again, at most
   every 3 s.
4. **Notifications: alerts and questions only, rate-limited, each saying what to do** (`health/panel/notes.ts`).
   - One kind at most once a minute, the rest folded into one note (`the bot died (2 times in 20 s)`).
   - At most 5 notes in 10 minutes in all.
   - A question is never folded and skips the window (it has a deadline), with a 10 s cooldown of its own.
   - Off by default (`notify`), and a per-device switch in the page.
5. **What works with no cloud is what is built.** A system notification from an open page needs a secure context.
   Measured with headless Edge: `127.0.0.1` and `localhost` are secure (permission `default`, a service worker);
   a LAN address over http is not (permission `denied` and fixed, no service worker). So:
   - the bot's own machine gets system notifications;
   - a phone over the LAN or VPN gets the banner, the title count and a tone;
   - behind https a page shows system notifications. The https front is the user's choice: any reverse proxy (Caddy,
     nginx), `tailscale serve`, or another; none is required. It must pass the `Host` header unchanged, pass `Origin`
     and the token through, and not buffer the event stream. A service worker (`/sw.js`) is registered there,
     because Chrome on Android shows them only through one. The panel accepts an `https://<Host>` origin for POSTs.
6. **Web Push is acceptable in principle but not built.**
   - For: it needs no account; messages are end-to-end encrypted to the browser and signed with our own VAPID key.
   - Against: every message passes the browser maker's push service.
   - Not built because it needs a secure origin, which the panel's LAN or VPN address is not. On iOS it needs a Home
     Screen app over https.
   - What it would need is written in the guide. No outbound channel (mail, a chat bot, a push app) was added: each
     needs the owner's account or token. (Track N1 added Discord through the user's own webhook: the addendum.)
7. **Asking: a question always has a bounded wait and a default, and the default is what the bot did before it
   asked** (`tasks/ask.ts`). So no answer never makes anything riskier, and nothing waits for ever.
   - The wait is 10 s to 30 min.
   - One question per key; at most 4 open.
   - Answers come from the panel's card (`!answer <id> <choice>` through `POST /api/cmd`), `!answer` in the game, and
     `!yes` / `!no` when they fit: no `!do` plan waits and exactly one question has that word.
   - Every question and answer is an event and a log line.
8. **The first use is a failed queued job** (`askOwner`, off by default).
   - The choices: retry (first in line), next, stop. The default is the `onfail` rule.
   - The queue holds while it asks. With `onfail stop` the pause is saved at the failure, so a restart during the
     question leaves the queue paused, as before.
   - `!answer`, `!yes` and `!no` answering a question do not pause the queue: they are not work.

## Consequences

- The owner sees a night's work as a handful of groups with the failures and deaths first. On the bot's machine, or
  behind https, they get a notification while a panel tab is open.
- A closed page gets nothing until the owner chooses https and a push service, or an outbound channel (Discord: the
  addendum below).
- `askOwner` turns the queue's failure rule into a default the owner can override for each failure.
- Measured on bds-core (n3): a failed job and a death were in the timeline with the right counts. The death's note
  arrived 1.1 to 1.2 s after the kill. A question answered through the API retried the job first in line, and one left
  alone took its default after the wait.
- Found: a death during a queued walk ends the job `cancelled`, not `failed` (the walk stops as interrupted). So it
  does not ask. Left to the queue's owners ([../queue.md](../queue.md) "Known limits").
- Budgets: page HTML 154 000 -> 160 000 (159 144), modules 200 000 -> 216 000 (214 277), `away` 8 000 (4 738 worst
  case), `timeline` 160 000 (149 313 worst case); the lite poll's bar 22 000 -> 22 300 (22 067), the full state's
  47 300 -> 47 800 (47 499).

## Addendum (Track N1, 2026-11-20): notes to Discord through the user's own webhook

New setting `notifyDiscord` (off); new command `!notify [status|test]`. Guide: [../away.md](../away.md) "Discord".

Context: a closed page gets nothing (decision 5), and a phone's system notification needs https. A Discord webhook
reaches a closed phone on any network with no https. The project is for anyone to run, so nothing in it may be tied
to one server or channel.

1. **Every note the limiter lets through also goes to the webhook** (`health/notify/discord.ts` `DiscordSink`, fed by
   `AwayLive`). Notes are made while `notify` or `notifyDiscord` is on, through the same rate limit (decision 4).
   - One message per note: a short `content` line, one embed (title, text, time, the event kind); a question adds its
     choices, its default with the time left, and how to answer. A webhook is one way, so the answer stays
     `!answer <id> <choice>` in the game or the panel, and the message says so.
   - `allowed_mentions: { parse: [] }`: no text the bot sends can ping anyone.
   - Rejected: a Discord bot (it could read answers, but needs a bot token and a gateway connection for a small
     gain); another vendor first (the user chose Discord; the sink is the pattern for the next one).
2. **The sink has its own limits**, so Discord's are never exceeded and a failing webhook costs nothing: one request
   at a time with a 10 s timeout; a 429's `retry_after` (or `Retry-After`) honoured, the note put back at most 3
   times; a bucket at 0 waits for its reset; at most 10 notes queued, the oldest dropped and counted; a 5xx or no
   answer tried once more after 30 s; 401, 403 and 404 stop it until the URL changes or a test; failures logged at
   most every 10 minutes; nothing thrown. Every text cut to Discord's documented limits (content 2 000, title 256,
   description 4 096, field 1 024, footer 2 048, embed 6 000).
3. **The URL is a secret, supplied only outside the game**: `BEDROCKBOT_DISCORD_WEBHOOK`, else
   `<config dir>/discord-webhook.url` (re-read on `!notify` and `!set notifyDiscord`). Never a setting or a command:
   the chat is read by every player and kept in the log and the event store.
   - Every output says only `set (id ...<last 4 of the id>, <where>)`, `not set` or why it was refused; every line the
     sink logs or returns passes `scrub()`; the panel's log ring hides `webhooks/<id>/<token>`; the file name is in
     `.gitignore`.
   - Rejected: a `!set` text setting for the URL (it would be typed in chat and stored in `settings.json`, which the
     panel shows); the config file's JSON (it is shared and copied more often than a single-purpose file).
4. **Only Discord's own webhook endpoint is accepted**: `https`, one of six Discord hosts, the path
   `/api[/v<n>]/webhooks/<id>/<token>`, no port, user, query or fragment. So a wrong or planted value cannot send the
   user's game events anywhere else. Tests send to a fake server through `BEDROCKBOT_DISCORD_TEST_ORIGIN`, which
   accepts only `http://127.0.0.1:<port>` or `http://localhost:<port>`; anything else there turns the sink off.
5. **`!notify test`** sends one note through every path that is on, outside the rate limit, and says what happened
   on each (`discord: sent (204)`, `discord: 401 the webhook is invalid or was deleted`, `discord: not set (...)`).

Consequences:

- A closed phone gets alerts and questions within about a second of the event, wherever it is. The answer still
  needs the game or the panel.
- What happens in the game leaves the machine for Discord's servers while `notifyDiscord` is on, which is why it is
  off by default.
- Measured on bds-core (n3, a fake webhook, `notify` off): `!notify test` one POST 0.23 to 0.24 s after the command; a
  death one POST 1.15 to 1.20 s after the kill and none more; a question one POST 0.01 s after it was asked, with its
  choices; the token in none of the bot's output, the state, the help, the away block, the events or the replies.
- Not measured: Discord itself (no test may call it); its limits are the documented ones.
- Decision 5 made general: https is the user's choice of front; `tailscale serve` is one example among others.
