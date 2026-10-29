# Cloudflare Signal deployment and session acceptance

Signal uses the existing Bun service behind one fixed-identity Cloudflare Container. TURN is Cloudflare Realtime, not a colocated coturn process. Accounts/web and Signal have separate ownership and deployments. The desktop's durable volume is a separate hosting concern.

## Approval and inputs

Deployment, image upload and runtime are external changes. Confirm the owned Cloudflare account, source, allowance and cleanup deadline before making them. A proof allowance does not authorize ongoing production operation or release publication. Do not use upstream encrypted environments, resource IDs or domains.

Use `remote/cloudflare/wrangler.jsonc`. It declares one `lite` instance with default scheduling, a fixed Durable Object owner, disabled startup and no observability logs. Required Worker bindings are listed in [Remote production requirements](../remote/README.md#production-requirements):

- Owned account HTTPS origin in `REMOTE_CONTROL_PLANE_URL`.
- Actual public Signal HTTPS origin in `REMOTE_SIGNAL_ORIGIN`.
- `REMOTE_SESSION_SECRET` and the account's matching `REMOTE_AUTH_WEBHOOK_SECRET`, each at least 32 bytes.
- Owned `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`.
- Optional `REMOTE_BROWSER_ORIGIN` only when the browser's exact HTTPS origin differs from the direct account origin. This replaces, rather than broadens, the browser allowlist. JWKS and signed account calls still use the direct account origin.

Optional connectors need their own credential groups. Compare binding names and status without printing values. The Realtime issuer token must never reach a desktop, renderer, log, URL, or test report.

## Deployment

1. Run focused source checks and the real local HTTP/WebSocket smoke with synthetic credentials:

   ```sh
   bun run --cwd remote/api typecheck
   bun run test:signal
   bun remote/scripts/check.ts --compose
   node --check remote/cloudflare/worker.js
   ```

2. Use the operator's Wrangler login and explicitly set `CLOUDFLARE_ACCOUNT_ID`. Check the target identity. Configure owned Worker secret bindings through Wrangler stdin or the provider's secure interface.
3. Deploy the intended source disabled:

   ```sh
   bun run remote:update --deploy
   ```

   The wrapper does not load encrypted files or provision TURN credentials. It discards inherited production token/environment selection. Inspect the actual returned Worker URL and image/deployment IDs; do not infer success from a requested name.
4. Set account `REMOTE_SIGNAL_URL` to the actual `wss://<signal-host>/v1/signal`. Its deployment derives `REMOTE_AUTH_WEBHOOK_URL` as `https://<signal-host>/internal/auth-events`. Deploy compatible account routes/schema before enabling Signal.
5. Only within the approved runtime allowance, deploy with `--deploy --enable`. Check the real `/health/live` and `/health/ready` endpoints. Record source and provider image/deployment identity; an unknown health commit is not source proof.

Every client reaches one in-memory Signal owner. Public requests must use the configured HTTPS origin; private Container traffic is HTTP. Forwarding identity is set by the Worker. Browser origins are exact, the released desktop origin is retained, and native peers without Origin are allowed.

## Required transport and access acceptance

Health and compilation are insufficient. Record actual client/host versions, account deployment, D1 migrations and Signal image before running:

1. Normal owner sign-in and staff invitation; unrelated and removed members are denied.
2. Two independent device sessions connected to the same host. Disconnect/revoke one without ending the other.
3. Direct WebRTC and a relay-only connection using real Cloudflare Realtime credentials. Confirm the selected ICE path, not merely receipt of an ICE array.
4. Refresh/reconnect reuse and session-bounded credential expiry. No issuer credential may appear in traffic or logs.
5. Funding/session revocation while credential issuance is pending. Access must be denied before provider cleanup; a failed revocation stays retryable in the account outbox.
6. Approved Signal replacement during active direct and relay traffic. Observe channel continuity, socket reconnect, account revalidation and file-transfer resumption. Do not assume an existing allocation survives or terminates.
7. Disabled-service and issuer-failure behavior; no empty-ICE, upstream-service or authentication fallback.

The credential ledger is process-owned. Known credentials are revoked, including late mint responses. Credentials lost with a process or an uncertain provider response can only expire by their bounded TTL. This implementation does not establish immediate termination of every existing TURN allocation.

## Stop, recovery and cleanup

Deploy without `--enable` to deny new requests and let the existing alarm stop the service. Verify provider runtime state; a local command's success is not proof that billing stopped. A bounded proof must also remove its temporary Worker/Container application, artifacts and credentials as required by its allowance. Preserve unrelated resources and record any billable item left behind.

For a failed rollout, disable operation first. Restore only an approved, compatible known image/source with the same fixed identity and bindings. Do not reverse D1 migrations or deploy the removed coturn/Compose stack as a fallback. Re-run affected transport/access checks before restoring service. No deployment or rollback is automatic from this document.
