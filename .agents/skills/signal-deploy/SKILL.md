---
name: signal-deploy
description: Check, deploy, disable or recover this fork's Cloudflare Signal Container and Cloudflare Realtime integration under explicit deployment and spending approval.
---

# Signal deploy

Use [the deployment runbook](../../../docs/remote-session-deployment.md) and [Remote configuration](../../../remote/README.md#production-requirements). The fork has no production Compose, coturn, ACME or upstream SSH deployment path.

## Rules

- Confirm the owned Cloudflare account, approved source, runtime allowance and cleanup deadline. Source changes are not deployment or release approval.
- Never load upstream encrypted environments or target upstream resource IDs/domains. Never print secret values, credentials, tickets, request bodies or raw connection logs.
- Keep one fixed Durable Object/Container identity. Do not add independent Signal replicas behind random load balancing.
- Keep public HTTPS/WSS, exact browser origins, native/desktop compatibility, signed account calls and account outbox delivery.
- `REMOTE_CONTROL_PLANE_URL` is the direct owned account origin. `REMOTE_SIGNAL_ORIGIN` is the actual returned public Signal origin. An optional distinct `REMOTE_BROWSER_ORIGIN` replaces only the trusted browser origin, not the JWKS/control-plane target.
- Realtime issuer credentials stay server-side. Unknown credentials after process loss or uncertain issuance expire by TTL; do not claim guaranteed immediate termination of existing relay allocations.

## Procedure

1. Read the affected source and run focused remote type checking, `test:signal`, Compose-development validation and Worker syntax checking. Local synthetic credential tests do not prove real Realtime behavior.
2. Check provider account/deployment identity and required secret **names/status**, without exposing values. Apply compatible owned account schema/routes before enabling Signal.
3. `bun run remote:update --deploy` is disabled by default and requires an explicit account ID. `--enable` requires runtime approval. Record actual image/deployment IDs and endpoint; do not invent them from configuration.
4. Verify real readiness, authenticated WSS, independent device sessions, direct and relay ICE paths, revocation races, issuer failure and approved Signal replacement. Observe results; health alone is insufficient.
5. If a proof ends or verification fails, disable operation, verify provider state and complete the allowance's resource/artifact/credential cleanup. A stopped billable resource is not deleted.

## Report

One table of exercised checks, actual source/image/deployment identities, secret-name readiness, spending/cleanup and remaining acceptance blockers. Mark every unrun device, relay or persistence scenario unverified. Do not complete the original Cloudflare-only filesystem goal based on Signal deployment or an external-host exception.
