# OpenBot Remote

This directory holds the Signal control plane for WebRTC connections. Signal relays SDP and ICE,
not Team files, chats, commands or desktop media. Direct WebRTC is preferred; encrypted relay
traffic passes through Cloudflare Realtime when TURN is needed. Signal also carries the optional
Slack, Discord and Telegram connector payloads described below.

## Flow

1. The app signs the user in through the Cloudflare API.
2. Cloudflare D1 checks membership and creates a logical session.
3. Cloudflare signs a short ES256 ticket. The ticket names the host, the user, the role, the protocol version and `authEpoch`.
4. The client and the host open `WSS /v1/signal`. Signal validates the ticket locally through JWKS.
5. Signal relays SDP and ICE and issues a `resume token` with session-bounded Cloudflare Realtime TURN credentials.
6. Chromium sets up WebRTC. The Team API uses the `rpc`, `events` and `files` channels.
7. ICE picks a direct `p2p` path or an encrypted `relay` path through Cloudflare Realtime.

Signal has no application database. Rooms, presence, resume caches and the issued TURN credential
ledger exist only in process memory. The queue of a hosted server that sleeps also lives in memory (see
[Sleeping hosted servers](#sleeping-hosted-servers)): Signal keeps a Slack, Discord or Telegram event
for it in memory, sealed to the host's key so that Signal cannot read it, for at most 10 minutes.

A `resume token` is valid for 10 minutes. Signal keeps the issued token in a bounded in-memory cache.
A normal reconnect validates that token locally. After a Signal restart the cache is empty, so the first
reconnect for a given token makes one signed request to the control plane. The same request is needed once
the token has expired. The control plane checks the session, the membership and `authEpoch`. Signal then
issues a new token. Subsequent reconnects are local again. There are no heartbeats and no periodic refresh
through Cloudflare.

Ending a session and changing access both write a revocation event to a durable D1 outbox. The Worker tries
to deliver it to Signal immediately. If Signal is unreachable, the Worker retries the delivery from cron. An
ordinary reconnect still does not ask Cloudflare. Ended and expired sessions are removed after the 10-minute
validation window.

## Slack requests

The OpenBot Slack app sends the events and button presses of every workspace to one request URL,
`<Signal HTTPS origin>/v1/slack/events`. Signal checks Slack's signature with the app's signing
secret, answers Slack's `url_verification` challenge, and reads only the app ID (`api_app_id`), the
workspace ID, and the event's type, channel type, thread and bot ID (to know whether it addresses
OpenBot, not its text). `SLACK_SIGNING_SECRET` is a comma-separated list of `<app ID>:<signing secret>`,
because the production and development apps share Signal. A request must name the app whose secret
signed it, so one app's secret cannot reach the other app's hosts; a malformed value turns off only
the Slack route. Then Signal passes the exact request body to the `ingress` socket of the host that
the app and workspace are linked to, and returns the host's answer, or 503 when no host holds the workspace or the
host does not answer in 2.5 seconds. Slack then sends the request again. For a hosted server that
sleeps, Signal answers 200 instead (see [Sleeping hosted servers](#sleeping-hosted-servers)).

An `ingress` socket names its workspaces with a Slack route ticket: an ES256 JWT with the audience
`openbot-slack-route`, signed by the Worker with `SLACK_ROUTE_PRIVATE_JWK` (key id
`SLACK_ROUTE_KEY_ID`) for the workspaces, each with its app, that the account service links to that
host. Its public key
must be in the ticket JWKS that Signal loads (`REMOTE_TICKET_PUBLIC_JWKS` on the Worker, or
`REMOTE_TICKET_PUBLIC_KEYS` here). Signal does not store or log the body. Without
`SLACK_SIGNING_SECRET`, the Slack route answers 503.

## Discord

The OpenBot Discord bot is one bot for every guild that installs it. Signal holds its bot token
(`DISCORD_BOT_TOKEN`) and its application ID (`DISCORD_APPLICATION_ID`). Without both, or with a
malformed value, Discord is off: Signal logs one line without the value, keeps no Gateway
connection, and `POST /v1/discord/api` answers 503. The remote sessions and the Slack route keep
running.

Signal asks for the privileged Message Content intent, so that OpenBot gets the text of the message
a person replies to and of the conversation history. Turn on **Message Content Intent** in the
Developer Portal. When Discord refuses the intent (close code 4014), Signal logs one line and connects
without it. `DISCORD_MESSAGE_CONTENT=false` stops Signal asking for it.

Signal keeps the bot's Gateway connection with the intents `Guilds`, `GuildMessages` and
`DirectMessages`, plus `MessageContent` unless `DISCORD_MESSAGE_CONTENT` is `false`. Without the
Message Content intent, Discord gives the bot the text of a message only when the message mentions
the bot. With it, Discord sends the text of every message in the channels the bot can see; Signal
still passes on only the messages that mention the bot. From the Gateway, Signal reads:

- the names of the guilds, channels and threads, and which guild each channel is in;
- each guild message that mentions the bot and that a person wrote. Signal passes the message ID,
  channel, author, the author's role IDs, text without the bot's mention, the replied message (with
  its author, text and time when a person wrote it and Discord gave its text), the Discord CDN
  addresses of the attachments and the time to the `ingress` socket of the host that the guild is linked to;
- each press of an OpenBot button. Signal acknowledges it to Discord at once and passes it on;
- the removal of the bot from a guild, which ends that guild's connection on the host.

A direct message to the bot gets one fixed answer, at most once an hour for each user. Signal does not
pass it on.

An `ingress` socket names its guilds with a Discord route ticket: an ES256 JWT with the audience
`openbot-discord-route`, signed by the Worker for the guilds that the account service links to that
host. Its public key must be in the ticket JWKS that Signal loads, as for the Slack route ticket. The
account service revokes a guild link through `/internal/auth-events`. After a start, Signal asks the
account service which links are current until every older ticket has expired.

A socket with a Discord route gets a `discord-session` token and the list of the guilds routed to it. The host sends it as the
bearer of its calls to `POST /v1/discord/api`: post, edit or delete a message, add or remove a
reaction, read the messages after one message, read a member or channel name, list the guild's roles, answer a button press,
and upload one file of at most 10 MB. Signal makes each call with the bot token, only in a guild that
is routed to that socket, and only in a channel of that guild. No post can ping anyone. The token is
valid while the socket is open.

So the answers and files of Discord conversations pass through Signal. Signal does not store them or
log them, and it does not log a token or Discord's error text.

When the bot leaves a guild, Signal drops its route and asks the account service to unlink it
(`/v2/remote/discord-route/removed`). After the Gateway lists the bot's guilds, and every 30 minutes,
Signal sends the account service the guild IDs that the bot is in
(`/v2/remote/discord-route/reconcile`), and the account service unlinks each older link of another
guild. Signal sends nothing while a Gateway shard is closed, because the list can then miss a new
guild. So a link goes also when its host is off and the first unlink failed, or Signal restarted.

## Telegram updates

One OpenBot bot serves every user, and only Signal has its token. `TELEGRAM_BOT_TOKENS` is a
comma-separated list of bot tokens (`<bot ID>:<secret>`), because the production and development
bots share Signal. `TELEGRAM_WEBHOOK_SECRET` (at least 32 bytes) is required with them: the webhook
secret of each bot is the base64url HMAC-SHA256 of `telegram-webhook:<bot ID>` with it. A malformed
value turns off only Telegram. With `TELEGRAM_WEBHOOK_ORIGIN`, Signal sets the webhook of each bot to
`<origin>/v1/telegram/updates/<bot ID>` when it starts; a failure is logged and Signal runs on.

Telegram posts each update to `/v1/telegram/updates/<bot ID>`. Signal checks the secret header,
reads only the chat ID, the callback query ID and a `/start <code>` link code, and passes the exact
body to the `ingress` socket of the chat's host. A link code makes Signal ask the account service to
link the chat (`/v2/remote/telegram-route/link`), and routes the chat to that host at once. Signal
answers 200 to each signed update, also when no host holds the chat: Telegram holds back the bot's
other updates while one fails.

An `ingress` socket names its chats with a Telegram route ticket: an ES256 JWT with the audience
`openbot-telegram-route`, signed with the key of the Slack route ticket. When `ready` names the
`telegram` capability, the host calls the Bot API through the socket (`telegram-call`). Signal
accepts only the methods and parameters of `TelegramCallParams`, only for the chats routed to that
socket, and returns only the reduced result. A host downloads a file from `/v1/telegram/files/<token>`
and posts a document to `/v1/telegram/uploads/<token>`. These tokens are signed, expire after two
minutes, and an upload token works once. Signal does not store or log an update or a file, except
for the sealed queue of a hosted server that sleeps.

## Sleeping hosted servers

All messaging platforms share one path (`src/ingress-queue.ts`). For an event whose route has no
`ingress` socket, Signal asks the account service (`/v2/remote/route-wake`, signed), at most once a
minute for each route. An event that addresses OpenBot starts a hosted server that sleeps. Signal
then keeps the event's delivery frame, sealed with the host's queue key (`queueKey` in the `ingress`
hello) and the host ID, for at most 10 minutes, 64 events and 192 KB for each host. When the host's
socket holds the route again, Signal sends each kept event in order as `queued-delivery`, and keeps it
until the host sends `queued-delivery-ack`. While a host has kept events, Signal asks for its start
again once a minute, because a start can fail after the account service answered. A host that
sent no key gets nothing kept. A restart of Signal loses the queue and the keys: until a sleeping
host connects again, its events start it but are not kept. Signal remembers at most 100,000 keys
and 100,000 route answers, and drops the oldest first. Signal names the
`ingress-queue` capability in `ready` only when the account service answered `/v2/remote/route-wake`
when Signal started: only then does a hosted server with a live connection sleep. Deploy the account
service before Signal.

## Production requirements

The fork deployment is `remote/cloudflare/wrangler.jsonc`: one `lite` Container, default scheduling
policy, one fixed Durable Object identity and public Worker HTTPS/WSS ingress. Do not load-balance
independent in-memory Signal owners. Private Worker-to-Container transport is HTTP; public transport
must remain HTTPS/WSS. The Worker replaces caller-supplied forwarding identity and strips cookies.

Required Worker secret bindings:

| Binding | Value |
| --- | --- |
| `REMOTE_CONTROL_PLANE_URL` | The owned account HTTPS origin. JWKS and allowed browser origins derive from it. |
| `REMOTE_SIGNAL_ORIGIN` | The actual Signal HTTPS origin, without a path. |
| `REMOTE_SESSION_SECRET` | Independent secret of at least 32 bytes. |
| `REMOTE_AUTH_WEBHOOK_SECRET` | At least 32 bytes; identical to the account Worker's webhook secret. |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | Owned Cloudflare Realtime issuer credentials; never sent to clients. |

Optional connector/metrics bindings retain their current names. The browser origin must match
the owned account origin. The released `openbot-app://app` desktop origin and native peers without
an Origin header remain supported; opaque `null` and unrelated browser origins are refused.
If an existing same-origin website proxy uses a different public origin, set `REMOTE_BROWSER_ORIGIN`
to that one exact HTTPS origin. It replaces the browser origin; JWKS and account calls still use
`REMOTE_CONTROL_PLANE_URL`. The selected Cloudflare-only website needs no override.

Set secrets with Wrangler against the explicit owned account and this configuration; do not load
upstream encrypted environment files. The deployment command requires an explicit account ID and
uses the operator's Wrangler login. It starts disabled:

```sh
bun run remote:update --deploy
```

Only an approved runtime allowance permits `--deploy --enable`. Deployment/build success is not
a readiness or relay test. Set account `REMOTE_SIGNAL_URL` to `wss://<signal-host>/v1/signal`;
the account deployment derives its webhook URL as `https://<signal-host>/internal/auth-events`.
See [the deployment and acceptance procedure](../docs/remote-session-deployment.md).

Realtime issuance is asynchronous, deadline-bounded and capped by the remaining authenticated
session life. Reconnect/refresh shares the session's credential and pending request. Provider
failures do not fall back to empty ICE lists or upstream TURN.

Revocation denies local access before provider I/O. Known issued credentials, including a late
mint response, are revoked; failed revocation returns 503 so the account outbox can retry. The ledger
is process-owned. Credentials lost with a process or an uncertain provider response can only expire
by their bounded TTL. This does not prove immediate termination of every existing TURN allocation.

Replacing Signal closes its WebSockets and clears process state. Check active direct and relay
connections, independent device sessions and reconnects during an approved replacement. Do not
claim transport preservation from health checks alone.

Current hosts advertise `multiplex: true` and support independent device sessions at the same time.
Reconnecting one session replaces only that session's Signal socket. Disconnecting or revoking one device
must not end another device's session. Legacy hosts that omit `multiplex` keep the one-client limit:
a second session receives `host_busy` without interrupting the first.

`REMOTE_MAX_CONNECTIONS_PER_USER` (default 32) limits the authenticated client Signal sockets of one
account. Each open desktop, phone, or browser keeps a socket for each saved host. A reconnect of the
same session does not count its old socket. Host sockets do not count, and the limit never refuses a
host. A host hello moves the clients of the older sockets of the same host to the new socket. The older
sockets stay open; when the new socket closes, the last remaining one takes the clients. A host keeps at
most 4 sockets: a fifth hello closes the oldest with code 1013, and that host can connect again. Change the value
on the Signal server: a desktop environment does not change it.
This also applies when the old client socket waits for its host to reconnect. Token signing finishes
before Signal admits the new socket, so concurrent reconnects do not hold extra account slots.

Worker secret/variable changes require an explicit owned deployment. There is no production
Compose/coturn/ACME launcher or automatic upstream secret loading. `compose.dev.yaml` is for local
development only. Without a configured TURN issuer, local health can start but TURN issuance fails
explicitly. `bun run test:signal` exercises HTTP/WebSocket behavior with synthetic credentials;
it is not a Cloudflare Realtime acceptance test.

To run Signal with your own account service, see [Self-hosted remote access](../docs/self-hosting.md).
