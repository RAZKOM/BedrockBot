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
| `bot/src/health/panel/away.ts` | `AwayLive`: the state's `away` block, `GET /api/timeline`, `GET /api/away`, `GET /sw.js` |
| `bot/src/health/panel/client/away.ts` | the Away view, the banner, the tab title, the browser notifications |
| `bot/src/tasks/ask.ts` | `AskBox`: questions with choices, the bounded wait, the default |
| `bot/src/chat/commands-ask.ts` | `!answer`, the task's box (`askBoxOf`); `!yes` / `!no` in `chat/commands-nl.ts` |
| `bot/src/tasks/queue.ts` | the first use: a failed job asks (`askOwner`) |
| `bot/test/unit/events/timeline.test.ts`, `unit/health/panel-away.test.ts`, `unit/tasks/ask.test.ts`, `unit/tasks/queue.test.ts` | the rules, the routes, the sizes, the view on the fake DOM |
| `bot/test/e2e/panel-away.test.ts` | on bds-core through the panel's API: a failed job and a death in the timeline, a question answered, one left to time out |

## Settings

| Setting | Default | What |
|---|---|---|
| `notify` | off | alerts and questions become notes for the open panel pages, through the rate limit |
| `askOwner` | off | a failed queued job asks the owner: retry, go on or pause |
| `askWaitS` | 120 s (10 to 1800) | how long a question waits before its default is taken |

Both switches are off by default because each one changes what the owner sees or when the queue goes on. The
timeline needs no setting: it only reads the event history.

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

The panel is served over plain http on the bot's machine, to the LAN or a VPN (Tailscale) address. What a browser
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
| **The page open behind https** (`tailscale serve`, below): a system notification | yes, while a panel tab is open, in the foreground or the background. Chrome on Android shows it only through a service worker: the page registers `/sw.js` on a secure origin only | |
| **The page closed** | no | nothing runs. Only Web Push can wake a closed page (below) |
| **An outbound channel** (mail, a chat bot, a phone push app) | not built | none is configured, and one needs the owner (below) |

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
  1. https for the panel (below);
  2. a VAPID key pair made once and kept in the config directory;
  3. `POST /api/push/subscribe`, with the subscriptions kept beside the queue file;
  4. the RFC 8291 encryption with `node:crypto` (ECDH P-256, HKDF, AES-128-GCM; no new package);
  5. outbound https from the bot's machine to the push service;
  6. a `push` handler in `/sw.js`.

  The rate limit and the notes are ready for it.

**A secure page (the owner's choice).** `tailscale serve --bg --https=443 http://127.0.0.1:<panel port>` on the bot's
machine serves the panel at `https://<machine>.<tailnet>.ts.net/`, with a certificate Tailscale gets. It is reachable
only inside the tailnet. The panel accepts an `Origin` of `https://<Host>` for its POSTs (ADR 0116), so the page works
behind it unchanged. Not done by this track: it changes the owner's Tailscale setup and needs their account.

**An outbound channel (not built).** A message to a phone with the page closed needs a service that delivers it:
mail (an SMTP account), a chat bot (a Discord or Telegram bot token), or a push app (ntfy, Pushover). Each one needs
an account or a token the owner makes, a setting naming it, and outbound network access. None is configured, so none
was added. The notes (`noteFor`) and the rate limit are where one would plug in.

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

Unit worst cases: the away block 4 738 bytes (4 questions of 6 choices, 3 notes, every text at its limit); a timeline
of 48 job groups with full head lines 149 313 bytes (`health/panel/budgets.ts` `away`, `timeline`).

## Known limits

- **A closed page gets nothing.** Web Push needs https and a vendor push service. An outbound channel needs the
  owner's account. Neither is built (above).
- **Over plain http on the LAN or VPN**, an open page has a tone, the banner and the title, not a system
  notification.
- **A notification on Chrome for Android** through `/sw.js` was not measured on a phone. The headless browser here
  left the service worker's registration pending.
- **Only a failed queued job asks.** Other places that could ask (a death far from home, a trip refused for wear)
  need their own question and default.
- **A death during a queued walk ends it `cancelled`**, so it does not ask ([queue.md](queue.md) "Known limits").
- **The timeline reads at most 5 000 events.** A longer window says `truncated`.
