# Hosted servers

This fork manages one organization-funded OpenBot desktop on a DigitalOcean Droplet with a separately retained ext4 Volume. Accounts and the browser app run on Cloudflare Workers with owned D1 and R2 resources. Signal, coturn and ACME run on an owned Linux server through the upstream deployment stack; see [owned remote access](self-hosting.md).

Cloudflare Containers has no production-supported native durable volume for this workload. This design uses an explicitly approved hosting exception; it is not a Cloudflare-native filesystem solution. A source change or passing local test is not proof of cloud persistence.

## What the upstream project provides

The upstream managed service uses paid Boat VMs, not Cloudflare Containers. Its account Worker
creates a VM after Stripe confirms the server subscription. GitHub builds the application and
images; an image download or a source push does not supply a running VM or its durable disk.
See the [original hosting contribution](https://github.com/nightly-labs/openbot/pull/1093) and the
[Docker host tooling](https://github.com/nightly-labs/openbot/pull/2034).

The [upstream pricing page](https://openbot.run/pricing) separates free use on your own computer
from paid hosted servers. Its commercial-license promotion is not free compute. This fork keeps
the PolyForm Noncommercial license; confirm the rights for your intended use before deployment.
AI provider charges are separate from software, VM, storage and relay costs.

Boat saves stopped disks for [14 days](https://docs.boat.dev/snapshots/stop.md), with separate
snapshot and shutdown rules. This is not the same contract as the retained native Volume below.
Cloudflare can run the application, but its [Container disk is ephemeral](https://developers.cloudflare.com/containers/faq/#is-disk-persistent-what-happens-to-my-disk-when-my-container-sleeps).
D1 account records and point-in-time snapshots do not preserve the desktop's native SQLite,
browser profiles and credential state as a supported replacement disk.

The user retained native-volume preservation and ODIC-funded operator controls when selecting
upstream reuse. These are deliberate differences from Boat snapshots and owner Stripe checkout.
Copying the connection stack does not replace the desktop storage, funding or membership contract,
and does not authorize a new server rental, subscription or production deployment.

## Parts

| Owner | Responsibility |
| --- | --- |
| `HostedServerService` | Operator authorization, one allocation, funding, desired/observed state, reconciliation and cleanup. |
| `digitalocean-client.ts` | Documented DigitalOcean API transport; mutation replay decisions remain in the service. |
| D1 migration `0041_organization_hosting.sql` | Organization funding, separate provider identities, durable operation records and the unique non-deleted organization allocation. |
| `openbot-digitalocean-bootstrap` | Root-owned ext4 identity guard and single-writer Docker supervisor. |
| `src/main/hosted-server-bootstrap.ts` | Existing managed claim, account sign-in and host registration. |
| Shared UI and team client | Truthful resources, no organization checkout, and no recovery wake while funding is revoked. |

## Lifecycle

An organization allocation has `funding: "organization"` and `fundingStatus: "active" | "revoked"`. Its Stripe plan, interval and currency are genuinely null. Entitlement capacity comes from the configured organization plan, not a fabricated subscription. Existing Stripe wire summaries remain a separate discriminator branch.

The fixed provider specification is `s-4vcpu-8gb`: 4 vCPU, 8 GiB RAM and a 100-GiB data Volume. Region is explicit. The boot disk is not the data disk. The provider catalog must confirm availability and resources before creation.

- **Create:** operator-only, configured owner, exact `{name}` body and stable `Idempotency-Key`. The owner must have signed in normally. D1 reserves the single allocation before provider I/O. Reusing the same request returns its allocation; changing its body conflicts.
- **Provision:** create and record the native ext4 Volume, then create the Droplet from a prepared image and attach that volume. Provider names and tags identify the allocation, not the owner's email. Provider/admin tokens never enter cloud-init or the desktop.
- **Uncertain create:** inspect the exact volume name/region and host tag. Adopt a discovered resource. Never blindly repeat a create after a lost response. An unresolved outcome keeps the allocation reserved for operator investigation.
- **First boot:** the app redeems a host-scoped claim. The original expiry is one hour; first redemption reduces replay to a non-extendable ten-minute window. Lost responses and concurrent redemption return one stable opaque session credential. A revoked/deleted session, expired claim or revoked funding cannot be revived. Keep the account signing key stable during this window.
- **Idle and wake:** client activity, connectors and scheduled routines use the existing service. Funding is checked on access and in conditional state changes, including cron and recovery paths. There is no Boat stop lease or retention-maintenance wake.
- **Revoke:** persist revoked funding before provider I/O, revoke Remote access, then stop the desktop. A late create/resume is adopted and stopped. Revocation retains the host, volume, owner and allocation; it does not delete data.
- **Reactivate:** preserve the same host and volume. A never-provisioned allocation can provision after reactivation. Staff still use membership/invitations; reactivation does not create a checkout.
- **Delete:** the owner can explicitly confirm immediate deletion. Cleanup confirms Droplet absence, volume absence and Remote removal before releasing the slot. A definitive provider refusal permits a new attempt only after fresh inspection. An uncertain deletion remains reserved and is not blindly replayed. Deletion is destructive, unlike revocation or power-off.

Powering off a Droplet does **not** stop its billing. A detached Volume also remains billable. There is no automatic deletion or 14-day storage expiry in this implementation.

## Operator API

The operator bearer is separate from account sessions, owner/member roles and developer headers. Authorization runs before JSON parsing. These endpoints are outside the browser proxy mutation allowlist:

| Method and route | Body / result |
| --- | --- |
| `GET /v2/hosting/organization/servers` | `{servers: HostedServerSummary[]}` |
| `POST /v2/hosting/organization/servers` | Exact `{name}` and `Idempotency-Key`; returns `{server}`. |
| `POST /v2/hosting/organization/servers/<uuid>/funding` | Exact `{status: "active" | "revoked"}`; returns `{server}`. |

The CLI defaults mutations to a no-network preview:

```sh
bun run hosting:setup list
bun run hosting:setup create --name "Shared desktop" --idempotency-key <stable-request-key>
bun run hosting:setup revoke <host-uuid>
bun run hosting:setup reactivate <host-uuid>
```

Set your own `BROWSER_APP_ORIGIN` and `HOSTED_ORGANIZATION_ADMIN_TOKEN` through a secret manager. Never put the bearer in command arguments. Add `--execute` to a mutation only after its resource/spending approval. A failed or lost response requires inspection, not an automatic retry with a new key.

## Production

Hosting is disabled in the checked-in account configuration. The owned deployment wrapper rejects upstream resource identities and builds a temporary configuration from explicit inputs; see [self-hosting](self-hosting.md).

| Binding | Requirement |
| --- | --- |
| `HOSTED_SERVERS_ENABLED` | Explicit `true` to enable the managed service. |
| `DIGITALOCEAN_API_TOKEN` | Secret with the required size, Droplet, action and Volume permissions. |
| `HOSTED_ORGANIZATION_ADMIN_TOKEN` | Separate secret, at least 32 characters. |
| `HOSTED_ORGANIZATION_OWNER_USER_ID` | Existing, normally signed-in owner account. |
| `HOSTED_ORGANIZATION_ENTITLEMENT_PLAN` | Supported entitlement plan; not a Stripe subscription. |
| `HOSTED_DIGITALOCEAN_REGION` | Region supported by both the size and prepared image. |
| `HOSTED_DIGITALOCEAN_SIZE` | `s-4vcpu-8gb`. |
| `HOSTED_DIGITALOCEAN_IMAGE_ID` | Numeric prepared Ubuntu 24.04 Droplet image ID. |
| `HOSTED_OPENBOT_IMAGE_DIGEST` | `ghcr.io/bpickett2019/openbot@sha256:<digest>`. |
| `HOSTED_OPENBOT_VERSION` | Exact `x.y.z` release version matching image labels. |
| `BROWSER_APP_ORIGIN`, `REMOTE_SIGNAL_URL` | Owned HTTPS account origin and WSS `/v1/signal` endpoint. |
| `REMOTE_TICKET_PRIVATE_JWK` | Existing account signing secret; also derives opaque claim-replay credentials. |

Historical Boat rows are preserved by migration, but there is no Boat runtime adapter. Before any secret upload, migration or deployment, the wrapper refuses a database containing a non-deleted Boat allocation. Do not clear those rows or relabel their provider to bypass the gate; an explicit data-preserving migration is required.

### Real servers from a development build

A local account API or Signal endpoint is not reachable from a cloud desktop. A real managed host needs the owned deployed services, normal owner sign-in, prepared image and approved provider access. The desktop's development profile does not confer operator authority. Never inject the organization admin token into a renderer or developer-key header.

## Build the server image

Build and verify the Linux package on a native Linux runner. The fork release workflow owns `bpickett2019/openbot`, includes the managed bootstrap bundle and checksums, and no longer promotes a Boat template. Release publication is separate from implementation and requires approval.

Prepare the Ubuntu 24.04 Droplet image with `scripts/hosting/provision-digitalocean-image.sh`. It must contain the root-owned bootstrap, managed systemd unit, Docker and seccomp profile. A source checkout is not a prepared provider image. Do not snapshot customer state, provider credentials or an initialized desktop into the base image.

The account service writes root-private `/etc/openbot-host/config.json` and invokes:

```sh
/usr/local/sbin/openbot-digitalocean-bootstrap install /etc/openbot-host/config.json
```

Configuration names the host ID, Volume ID/name, account and Signal origins, exact image/version, explicit initialization flag, bounded claim and expected filesystem UUID after initialization.

### Native state contract

The supervisor mounts the expected DigitalOcean block device as ext4 at `/srv/openbot-volume`. It never formats a device. It verifies the external filesystem UUID and a root-owned identity marker outside agent-writable state. Missing/mismatched markers, unexpected mounts, absent established state and non-empty unmarked volumes fail closed.

Explicit first initialization accepts only an empty filesystem (apart from `lost+found`). It creates UID-1000 `data`, `tmp` and `var-tmp`, records identity and consumes the initialization flag before enabling the service. The supervisor holds an exclusive writer lock and refuses a conflicting live container.

- `/data` is the stable home, including Electron user/session data, browser profiles, provider homes, workspaces, host identity, encrypted account session, keyring and unlock material.
- `/tmp` and `/var/tmp` also persist on the same volume. `/run/openbot`, `/run/lock` and shared memory remain transient.
- The app uses UID 1000, dropped capabilities, seccomp, no-new-privileges and a read-only image. It receives no Docker socket or cloud provider/admin credential. The managed network blocks metadata and host-service access before the app starts.
- SQLite continues to use the native filesystem. No asynchronous file copier, object-store mount or altered commit acknowledgment is introduced.
- The root guard checks the required database/session/keyring/host-identity files as UID 1000. It does not claim to validate every browser/profile file or arbitrary custom-home override.
- If first launch crashes after partial establishment, a later launch requires coherent state. It does not silently turn partial or missing state into a new empty desktop. Bounded claim replay is not a general partial-volume repair mechanism.

### Updates

Managed Docker hosts use an explicit fork image digest, not an upstream or moving-tag fallback. Stop the writer before replacing its image or VM. Retain the same volume, external filesystem identity and host identity. The guard records a high-water version before migration, rejects downgrades and rejects a different digest at the same version. A failed migration is not permission to start an older image on the newer data.

VM replacement and restore require an approved recovery operation that reconciles provider/D1 identities; do not fabricate a new host, reset the allocation or force-attach a disk used by another writer. Native replacement acceptance remains a commissioning gate until exercised with the real application.

The separate self-hosted systemd installer still has its timer/staged-update flow; that is not the managed Docker host's update mechanism.

### Backups and costs

A retained Volume is not a backup. DigitalOcean Droplet backups do not include attached volumes. Use separate, application-consistent volume snapshots and verify restores of the whole native state, including identity and keyring material. This change does not install or verify an automated backup schedule.

Published rates reviewed for this implementation: $48/month cap ($0.07143/hour) for the selected Droplet, $10/month for 100 GiB of Volume storage, and $0.06/GiB/month for volume snapshots. Signal, TURN, account services, taxes and additional storage are separate. Recheck prices and regional availability before spending. Proof and ongoing production allowances are separate.

Sources: [Volume features](https://docs.digitalocean.com/products/volumes/details/features/), [limits](https://docs.digitalocean.com/products/volumes/details/limits/), [Volume pricing](https://docs.digitalocean.com/products/volumes/details/pricing/), [Droplet pricing](https://docs.digitalocean.com/products/droplets/details/pricing/), [snapshot pricing](https://docs.digitalocean.com/products/snapshots/details/pricing/).

## Providers

OpenBot includes no AI subscription. The owner/admin connects providers through the existing provider setup and sign-in relay. Provider credentials and sessions belong to the host's durable home; neither a funded allocation nor its claim grants an AI subscription. See [admin capabilities](architecture/servers.md#admin-capabilities) and [provider terms](provider-terms.md).

## Members

Organization hosts use the existing entitlement and invitation services. The configured organization entitlement plan supplies the capacity; `server_member_limits` overrides and existing license behavior remain in their current owner. No staff checkout is introduced.

A lower limit removes no active member. New joins/reactivations need a free seat. Host lists expose `memberLimit`, and entitlement changes notify clients to reload. Owner-only allocation lists remain separate from the member's joined-host list. Funding revocation denies access and wake paths; changing an invitation or role cannot restore funding.

## Memory

The existing `ServerMemory` and agent-process guards remain active for hosted/server mode. The selected VM has 8 GiB RAM; do not assume the removed Boat image's swap or systemd limits exist in the Docker host.

Every five seconds, the application reads available memory and the cgroup limit. Recent turn starts reserve additional headroom. Low memory queues new turns and prevents new browser tabs; critical memory also closes idle provider threads and stops eligible leftover agent processes. User messages take priority over routine/teammate work when slots become free.

The existing turn-slot limits are 2 up to 5 GiB, 8 up to 10 GiB, and 16 above. `OPENBOT_AGENT_PROCESS` marks agent descendants; CPU-limit handling uses cgroup/affinity limits instead of assuming every host CPU is available. See `src/main/server-memory.ts`, `src/backend/agent/memory-hold.ts` and the [container memory notes](docker.md#memory). Native OOM/abrupt-loss acceptance is still required; these guards do not prove persistence.

## Connector events

Signal's existing sealed, in-memory ingress queue wakes an eligible hosted server through signed `/v2/remote/route-wake`. Funding revocation prevents that wake, including a concurrent or late operation. The normal queue remains bounded to ten minutes, 64 events and 192 KB per host. A Signal restart loses its queue and process-owned keys; it does not erase the desktop volume. Generic webhook senders retry after an unavailable host response. See [sleeping hosted servers](../remote/README.md#sleeping-hosted-servers).

## Billing and server deletion

Organization hosts have no Pay, Renew, subscription cancellation or period-end deletion controls. Revoked funding is administrator-managed and read-only with respect to wake. The owner retains explicit immediate deletion. Stripe subscription webhooks cannot mutate organization allocations; historical Stripe summaries and ordinary license billing remain separate.

## Verification boundary

Focused implementation checks cover migrated SQLite constraints, the real lifecycle service with a synthetic provider transport, access/funding races, lost-response recovery, provider cleanup and Signal HTTP/WebSocket security. Useful commands:

```sh
bun run --cwd apps/auth-api test test/hosted-servers-migration.test.ts --maxWorkers=1
bun run test:hosted-lifecycle
bun run test:cloud-authorization
bun run test:remote-auth-events
bun run test:signal
```

These checks do not prove native ext4 durability, real provider deployment, SMTP sign-in, browser/provider recovery, relay traffic or model-backed computer use. Commissioning must exercise acknowledged SQLite writes under abrupt loss, browser/profile/session/keyring recovery, image/VM replacement, missing-volume refusal, single-writer exclusion, backup restore, real revocation and cleanup within the approved spending deadline. Record actual versions, identities, outcomes and cleanup; never mark unrun cases as passed.
