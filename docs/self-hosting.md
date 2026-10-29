# Self-hosted remote access

This guide tells you how to run your own account service (the Account API Worker), Signal and TURN
for remote access. Use it when you do not want `api.openbot.run` and `signal.openbot.run` to carry
your account and connection set-up.

Our Worker does not issue a ticket for another Signal. A ticket gives access to a host, and our key
signs it, so a ticket for your Signal would also open our Signal. Thus a self-hosted Signal needs a
self-hosted account service with its own keys. See
[issue #1263](https://github.com/nightly-labs/openbot/issues/1263).

## What changes

- Accounts on your service are separate from accounts on `openbot.run`. Each person signs in again.
- Each desktop and phone that connects to a host must use the same service.
- Invitations are `openbot://join` links. Copy a link from the app and send it yourself. The app
  does not send an invitation by email.
- The browser client at `openbot.run/app` does not work with your service. Your Worker serves its own
  browser client at `/app`. Staff can use that URL without installing a desktop or phone app.
- Organization-funded hosting is optional and requires its own operator/provider configuration.
  GitHub, Slack, Telegram, Discord and notification integrations stay off unless you supply your own credentials.
- The other network connections in [PRIVACY.md](../PRIVACY.md) do not change.

## What you need

- An owned Cloudflare account with Workers, D1, R2, Containers and Realtime TURN access.
- An SMTP account that accepts TLS on port 465. Sign-in sends a one-time code by email.
- A clone of this fork, [Bun](https://bun.sh), and Node for Wrangler. Native desktop images need a Linux builder.
- Explicit deployment/runtime approval. Managed desktop storage additionally requires the
  [persistent-disk hosting configuration](hosted-servers.md); a Signal Container is not desktop storage.

The examples use `api.example.com` and `signal.example.com`. Owned `workers.dev` origins also work;
use the actual returned endpoints rather than upstream addresses.

The browser must see the client and account API on the same HTTPS origin. Staff can use
`https://api.example.com/app` directly. Do not make credentialed browser requests to a separate API origin.

## 1. Make the keys

Generate an EC P-256 signing key and matching public ES256 JWKS with the same `kid` as
`REMOTE_TICKET_KEY_ID`. Store the private JWK in your secret manager; do not print or commit it.
The deployment preflight verifies the key pair. Generate independent high-entropy values for the
other shared secrets:

| Secret | Where |
| --- | --- |
| `REMOTE_AUTH_WEBHOOK_SECRET` | Worker and Signal. Use the same value on both. |
| `SKILLS_ADMIN_TOKEN`, `SITE_REPORT_HASH_SECRET` | Worker |
| `REMOTE_SESSION_SECRET`, optional `REMOTE_METRICS_TOKEN` | Signal |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | Signal; issued by your Cloudflare Realtime account, not random local strings |

Keep the private JWK secret. With it, a person can open each host that uses your service.

## 2. Deploy the account service

1. Sign in with your own Wrangler identity. Create owned D1/R2 resources only after approval.
   The checked-in Wrangler file is a local template, not permission to deploy to upstream resources.
   Check `wrangler whoami`: a Container-only OAuth login is insufficient. Account deployment needs
   D1 and Workers/R2 permissions, including `d1:write` and the applicable Workers write scopes.
   Review `wrangler login --scopes-list` and request only the necessary consent; do not grant every
   available scope or activate a new subscription as an incidental deployment step. Realtime TURN
   credentials are separate from this Wrangler login.

2. Supply the deployment environment from your secret manager. No encrypted upstream file is loaded.
   Required resource inputs are:
   - `CLOUDFLARE_ACCOUNT_ID`, `OPENBOT_ACCOUNT_WORKER_NAME`.
   - `OPENBOT_D1_DATABASE_ID`, `OPENBOT_D1_DATABASE_NAME`.
   - `OPENBOT_AVATARS_BUCKET`, `OPENBOT_SKILLS_BUCKET`, `OPENBOT_SITES_BUCKET`.
   - `BROWSER_APP_ORIGIN`: your public HTTPS account/browser origin.
   - Optional `OPENBOT_ACCOUNT_API_ORIGIN` when the direct Worker origin differs from the browser origin.
   - `REMOTE_SIGNAL_URL`: your public WSS endpoint ending in `/v1/signal`.
   - `EMAIL_SMTP_HOST`, `EMAIL_SMTP_USERNAME`, `EMAIL_FROM`; the port is TLS `465`.
   - `REMOTE_TICKET_KEY_ID`.
   - Secrets: `EMAIL_SMTP_PASSWORD`, `SKILLS_ADMIN_TOKEN`, `SITE_REPORT_HASH_SECRET`,
     `REMOTE_TICKET_PRIVATE_JWK`, `REMOTE_TICKET_PUBLIC_JWKS`, `REMOTE_AUTH_WEBHOOK_SECRET`.

   Hosting defaults off. To enable it, supply the complete [host binding set](hosted-servers.md#production).
   Optional integration secret groups must be complete or absent. No upstream identities or fake
   subscriptions are supplied as defaults.

3. Run the no-network preflight from the repository root:

   ```sh
   bun scripts/deploy-auth-api.ts --self-hosted --check
   ```

4. After deployment approval, run the same command without `--check`. The wrapper checks the
   target D1 and R2 resources, refuses non-deleted legacy Boat allocations, uploads secrets through
   stdin, applies migrations, builds against a temporary owned configuration and deploys that build.
   It uses your Wrangler login, not an inherited production API token. Do not run raw `wrangler deploy`
   against the resource-less local template. `--migrate-only` performs the owned resource checks and
   migration without secret upload or build. `--env test` requires an explicit `-test` Worker name.

5. Check the service. Each command must return `200`:

   ```sh
   curl -fsS https://api.example.com/health/live
   curl -fsS https://api.example.com/.well-known/jwks.json
   ```

## 3. Start Signal and TURN

Follow the [Cloudflare Signal deployment procedure](remote-session-deployment.md). The required
Worker bindings are the account and Signal HTTPS origins, `REMOTE_SESSION_SECRET`,
`REMOTE_AUTH_WEBHOOK_SECRET` and the two Cloudflare Realtime issuer inputs from step 1.
The Worker derives the account JWKS URL and allowed browser origin. Optional connector bindings
stay absent unless you intentionally configure those integrations.

`bun run remote:update --deploy` deploys with operation disabled. Starting the fixed Signal
Container requires explicit `--enable` and a runtime allowance. Use the actual returned public
origin to configure both services. The old production Compose/coturn/ACME path is removed.

Check `/health/live` and `/health/ready`, then exercise real authenticated WSS and a relay-only
connection. Health alone does not verify TURN, session preservation or access revocation.

## 4. Start the app

Do these steps on ordinary agent hosts and desktop clients. Browser-only staff skip this section.
The fork installer, update feed and container use `bpickett2019/openbot`; publish/verify a fork
Linux artifact before deployment. A managed host uses its scoped claim and durable-volume
bootstrap instead of interactive host sign-in; see [hosted servers](hosted-servers.md).

1. If you signed in to `openbot.run` before, sign out in the app. Otherwise the app sends the old
   session token to your service.
2. Quit the app. Then start it with the two variables. `OPENBOT_REMOTE_SIGNAL_URL` must be equal to
   the `REMOTE_SIGNAL_URL` of your Worker.

   macOS:

   ```sh
   OPENBOT_AUTH_API_URL=https://api.example.com \
   OPENBOT_REMOTE_SIGNAL_URL=wss://signal.example.com/v1/signal \
   /Applications/OpenBot.app/Contents/MacOS/OpenBot
   ```

   Linux:

   ```sh
   OPENBOT_AUTH_API_URL=https://api.example.com \
   OPENBOT_REMOTE_SIGNAL_URL=wss://signal.example.com/v1/signal \
   ./OpenBot-<version>-x86_64.AppImage
   ```

   Windows (PowerShell):

   ```powershell
   $env:OPENBOT_AUTH_API_URL = "https://api.example.com"
   $env:OPENBOT_REMOTE_SIGNAL_URL = "wss://signal.example.com/v1/signal"
   & "$env:LOCALAPPDATA\Programs\OpenBot\OpenBot.exe"
   ```

   This is the default install folder. If you chose a different folder in the installer, use it.

3. Sign in with an email address. The code comes from your SMTP account.
4. To connect an iPhone, scan the connection QR code from the desktop app. The phone then uses the
   service of that desktop. Email sign-in on the phone always uses `openbot.run`, so it cannot
   connect to a self-hosted service.

Set the variables each time that you start the app. Without them, the app uses `openbot.run` and
sends your session token there. To go back to `openbot.run`, sign out first.

The app does not start, and shows an error, if `OPENBOT_REMOTE_SIGNAL_URL` is not a `wss:` URL, has
a user name or password, or is set without `OPENBOT_AUTH_API_URL`.

## 5. Connect from a browser

Open `https://api.example.com/app` and sign in through your own email service. Use the same
account service as the agent host. To add another person, send the self-hosted invitation privately;
they can paste its `openbot://join` link into the browser client's invitation dialog.

The browser entry point also accepts the four invitation query fields on `/app` for its own
account-service origin. It removes the fields from the address bar before sign-in. Do not send
self-hosted invitation tokens through `openbot.run`.

Agents use the virtual desktop on the server for Computer Use. Staff do not grant access to their
own computers. Full remote-desktop viewing in the browser is separate from agents' Computer Use;
see [Web client](web-client.md).

The browser-origin HTTP regression check does not sign in or change account data:

```sh
BROWSER_ORIGIN_TEST_URL=http://localhost:3100 bun apps/auth-api/scripts/browser-origin-e2e.ts
```

For configured-origin coverage, set the same `BROWSER_APP_ORIGIN` in the Worker and check process.
For malformed configuration, set a bad Worker value and run the check with `--invalid-config`.

## Updates

After an approved update, retain your owned resource inputs and secret-manager configuration,
run deployment preflight, and deploy compatible account migrations/source. Update Signal through
the explicit Cloudflare deployment procedure, not the removed production Compose path. Verify
real sessions and relay behavior before restoring production access.
