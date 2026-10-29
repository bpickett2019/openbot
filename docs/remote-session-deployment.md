# Owned Linux Signal deployment and session acceptance

Signal uses the upstream Bun service, coturn and ACME on one owned Linux host. The source is based
on [public upstream f3e3f8a](https://github.com/nightly-labs/openbot/tree/f3e3f8ade9c146e96d9d68d65770d2a9126a7856/remote).
Accounts and the website stay on the owned Cloudflare account. The shared desktop stays on
DigitalOcean with its separate native ext4 Volume and ODIC-funded, operator-controlled lifecycle.
This deployment does not move desktop state, restore Boat or Stripe provisioning, or use snapshots
as active storage. SQLite WAL/NORMAL semantics remain unchanged; no stronger power-loss guarantee
or new asynchronous storage publication window is claimed.

## Approval and inputs

Source preparation is not approval to rent a Linux host, deploy services, issue certificates, buy a
subscription, publish a release or start paid runtime. The earlier one-desktop/one-Signal-Container
proof allowance does not approve this two-host Linux architecture. Obtain its actual provider price,
recurring budget and commissioning scope first. No provider or price is inferred from upstream.

Use `remote/compose.yaml` and the owned inputs in
[Remote production requirements](../remote/README.md#production-requirements). Supply secrets only
through the operator environment or secret manager. Do not load upstream `.env.production`, keys,
resource IDs or domains. `remote/.env.example` contains no usable credentials and is not loaded.
The deploy entrypoint disables implicit Compose env-file loading with `--env-file /dev/null`.
Do not print resolved Compose configuration or a container's environment: both can contain secrets.

Prerequisites:

- One approved Linux machine with Docker Engine, a Compose version with `up --wait`, Bun and a
  reviewed checkout. `REMOTE_DEPLOY_HOST` must equal that machine's exact hostname. The entrypoint
  connects only to `/var/run/docker.sock`, not an inherited remote Docker context.
- Owned DNS-only Signal and TURN records that point at the host. Do not proxy either record. Use
  an owned Cloudflare zone and a DNS token restricted to DNS Edit and Zone Read for those zones.
- Public TCP 443; UDP/TCP 3478; TCP 5349; UDP 49152–65535. Allow UDP 5349 if DTLS is needed.
  Do not expose the private health listener (8080) or coturn metrics (127.0.0.1:9641).
- Outbound DNS and HTTPS for DNS-01 ACME, account/JWKS requests and configured connectors. Inbound
  port 80 is not required by ACME. Publish AAAA records only after IPv6 is tested.
- Owned account HTTPS origin, JWKS URL, independent session/TURN secrets, and the same auth-event
  secret on Signal and the account Worker. Secret values must not enter logs or reports.
- Exact `REMOTE_BROWSER_ORIGIN` when the website origin differs from the account origin. It
  replaces the default browser origin without redirecting JWKS or account calls. An explicit
  `REMOTE_ALLOWED_ORIGINS` list is authoritative; empty means desktop-only. Keep this unset for
  the normal single website origin. The released desktop origin and native peers remain supported.

Metrics, Slack, Discord and Telegram are off without their credential groups. With Telegram
credentials, setting its webhook origin registers webhooks on startup. This is a separate external
mutation. Use only owned integrations and do not enable them as a test default.

## Checks before deployment

Run the focused checks one at a time after source integration:

```sh
bun run --cwd remote/api typecheck
bun run test:signal
bun run remote:check:compose
sh -n remote/acme/renew.sh
sh -n remote/coturn/entrypoint.sh
```

`remote:check:compose` checks production and development definitions with isolated generated
secrets and reserved example domains. It does not open a Docker daemon connection, load operator
secrets, fetch images or contact a provider. It does not start services. The local Signal smoke
uses synthetic credentials; it cannot prove real TURN, TLS, DNS or native desktop durability.

## Approved deployment

1. Confirm the Linux host identity, source commit, DNS, firewall, owned inputs, spending approval
   and cleanup deadline. Export `OPENBOT_SOURCE_COMMIT` with the reviewed commit for health evidence.
2. Deploy compatible account routes first. Set account `REMOTE_SIGNAL_URL` to the actual
   `wss://<owned-signal-host>/v1/signal`; its auth-event webhook uses
   `https://<owned-signal-host>/internal/auth-events` and the matching secret.
3. On the approved Linux host, with its explicit operator environment:

   ```sh
   bun run remote:update --deploy
   ```

   This is not a check. It builds Signal/coturn, starts ACME, waits for certificates, starts Signal,
   then drains and replaces coturn. It can make DNS/ACME calls and start billable runtime. It does
   not create a cloud server, open a firewall or install nginx. No command loads upstream secrets.
   There is no runtime enable flag or implicit deployment without `--deploy`.
4. Check the actual public endpoints, using the configured owned domain:

   ```sh
   curl --fail --silent --show-error "https://${SIGNAL_DOMAIN}/health/live"
   curl --fail --silent --show-error "https://${SIGNAL_DOMAIN}/health/ready"
   ```

   These are read-only health checks, not deployment commands. Record the reported source commit
   and actual image IDs. Unknown commit output is not source provenance. Do not put tokens in URLs.

Direct mode terminates TLS in Signal on TCP 443. Keep `REMOTE_TLS_DISABLED=false` and
`REMOTE_TRUST_PROXY=false`. ACME stores its account and certificate state in the `acme-data` Docker
volume; it checks renewal every 12 hours with a 30-day threshold. Signal and coturn check certificate
changes every five minutes. Signal's certificate reload can close sockets; test reconnect behavior.
The coturn entrypoint forwards `SIGUSR1` for drain and `SIGUSR2` for certificate reload. Its PID 1
waits through those signals instead of exiting before allocations drain.

## Optional host nginx

nginx is optional and is not installed or started by `remote:update`. To use it, set:

```sh
export REMOTE_TLS_DISABLED=true
export REMOTE_SIGNAL_BIND_ADDRESS=127.0.0.1
export REMOTE_SIGNAL_PUBLIC_PORT=8081
export REMOTE_SIGNAL_PORT=8081
export REMOTE_TRUST_PROXY=true
```

nginx terminates public TLS; plain Signal HTTP must stay on loopback. The supplied template replaces
forwarding headers, supports WebSocket upgrades and blocks `/metrics`. Access and error request logs
are disabled to avoid recording connector token paths; use Signal's redacted diagnostics and health
checks. Do not enable a proxy log format that includes tokens, cookies, request bodies or query strings.

After approved ACME startup, get the volume's actual mountpoint with
`docker --host unix:///var/run/docker.sock volume inspect openbot-remote_acme-data --format '{{.Mountpoint}}'`.
Export that absolute path as `ACME_DATA_PATH`, and export the owned `SIGNAL_DOMAIN`. Render only
these two variables; a bare `envsubst` would corrupt nginx's own variables:

```sh
envsubst '${SIGNAL_DOMAIN} ${ACME_DATA_PATH}' < remote/nginx/signal.conf.template > /tmp/openbot-signal.conf
envsubst '${SIGNAL_DOMAIN} ${ACME_DATA_PATH}' < remote/nginx/openbot-remote-nginx-reload.path.template > /tmp/openbot-remote-nginx-reload.path
```

Review the generated paths and names. Under the approved installation, install the rendered config
into the host's nginx include directory, and install the rendered `.path` plus
`remote/nginx/openbot-remote-nginx-reload.service` into `/etc/systemd/system`. Remove temporary
rendered files after installation. Run `nginx -t` before reloading nginx. Enable the path unit only
when the certificate exists. It runs `nginx -t` and reloads nginx when that certificate changes.
The paths assume rootful Docker and root nginx; confirm permissions and binary locations on the
chosen host. Open TCP 80 only if the optional HTTP-to-HTTPS redirect is used. These steps are host
mutations, not part of the offline configuration check.

## Required transport and access acceptance

Health and compilation are insufficient. Record client/host versions, account deployment, D1
migration state and Signal/coturn image identities before these real tests:

1. Normal owner sign-in and staff invitation; unrelated and removed members are denied.
2. Two independent device sessions on the same host. Disconnect or revoke one without ending the other.
3. Direct and relay-only WebRTC with real coturn credentials. Transfer and verify 1 MiB each way;
   record selected ICE candidates, not just receipt of an ICE array.
4. Session-bounded credential expiry, refresh, reconnect and resumed account revalidation. No
   shared secret, ticket or password may enter logs, screenshots or reports.
5. Membership, session and ODIC funding revocation: deny new credentials, reconnect and every
   unauthorized wake path. Retain the durable auth-event outbox and retry semantics.
6. Approved Signal replacement and coturn drain during active direct and relay traffic. Observe
   channel continuity, socket reconnect and file-transfer resumption; do not assume uninterrupted use.
7. Wrong secrets, foreign origins, opaque Origin and unavailable services must fail without an
   empty-ICE or upstream-service fallback. Check TLS renewal and proxy-header handling if nginx is used.
8. Independently complete native desktop SQLite, keyring, browser/profile/session, file, crash,
   replacement and backup/restore acceptance. Signal health does not prove preservation.

Coturn credentials use HMAC-SHA1 and expire no later than their authenticated session. Revocation
blocks further Signal access and issuance; already issued credentials remain valid until expiry.
Existing TURN allocations are not guaranteed to end immediately. Do not present allocation drain,
secret rotation or a Signal socket close as individual immediate TURN revocation.

## Stop, recovery and cleanup

The update builds first, updates Signal, disables coturn restart, sends `SIGUSR1`, and waits for all
allocations to end before recreation. If it fails or is interrupted during drain, inspect this exact
Compose project's coturn state before recovery. A deliberate rerun of the approved update can
recreate a drained container; there is no automatic force-stop or mutation retry. While draining,
new relay allocations can fail. A failed Signal rollout must not be called a successful update.

For an approved shutdown, stop this exact Compose project on this host; do not use global Docker
cleanup or delete the desktop Volume. Preserve the ACME volume for recovery unless its explicit
removal is authorized. Restore only reviewed compatible source/images and the owned configuration;
never reverse D1 migrations or restore a removed transport provider as a fallback. Re-run affected
access and relay checks before returning service.

Stopping containers does not stop Linux VM charges. A bounded proof must remove only its recorded
temporary resources and credentials, verify provider cleanup, and report any retained billable host,
disk or certificate state. No automatic cleanup in this guide deletes unrelated resources or native
desktop data. Ongoing operation needs a separate approved budget.
