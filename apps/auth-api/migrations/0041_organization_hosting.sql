-- D1 applies this migration in one transaction before the new Worker is deployed.
-- Keep every released column and its defaults so the old Worker can still read and insert Stripe rows.
-- No table references hosted_servers. Keep foreign-key enforcement on during the rebuild.
CREATE TABLE hosted_servers_organization (
  server_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'boat' CHECK(provider IN ('boat', 'digitalocean')),
  provider_sandbox_id TEXT UNIQUE,
  provider_template TEXT,
  size TEXT NOT NULL CHECK(size IN ('small', 'default', 'large')),
  pending_size TEXT CHECK(pending_size IS NULL OR pending_size IN ('small', 'default', 'large')),
  plan TEXT CHECK(plan IS NULL OR plan IN ('starter', 'standard', 'pro')),
  billing_interval TEXT CHECK(billing_interval IS NULL OR billing_interval IN ('month', 'year')),
  currency TEXT CHECK(currency IS NULL OR currency IN ('eur', 'usd', 'pln')),
  checkout_session_id TEXT,
  desired_state TEXT NOT NULL CHECK(desired_state IN ('running', 'idle', 'stopped', 'deleted')),
  observed_state TEXT NOT NULL CHECK(
    observed_state IN (
      'awaiting_payment', 'creating', 'starting', 'running', 'stopping', 'stopped', 'waking', 'error', 'deleted'
    )
  ),
  observed_error TEXT CHECK(
    observed_error IS NULL OR
    observed_error IN ('provider_error', 'provider_billing', 'provider_limit', 'start_failed', 'plan_ended')
  ),
  provider_event_at INTEGER,
  last_wake_reason TEXT CHECK(last_wake_reason IS NULL OR last_wake_reason IN ('create', 'message', 'restart', 'schedule')),
  claim_token_hash TEXT UNIQUE,
  claim_expires_at INTEGER,
  claim_redeemed_at INTEGER,
  auth_session_id TEXT,
  last_active_at INTEGER,
  lease_until INTEGER,
  next_run_at INTEGER,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deletion_scheduled_at INTEGER,
  deletion_subscription_id TEXT,
  lifecycle_token TEXT,
  lifecycle_lease_until INTEGER,
  funding TEXT NOT NULL DEFAULT 'stripe' CHECK(funding IN ('stripe', 'organization')),
  funding_status TEXT CHECK(funding_status IS NULL OR funding_status IN ('active', 'revoked')),
  organization_entitlement_plan TEXT CHECK(
    organization_entitlement_plan IS NULL OR organization_entitlement_plan IN ('starter', 'standard', 'pro')
  ),
  provider_droplet_id INTEGER UNIQUE,
  provider_volume_id TEXT UNIQUE,
  provider_volume_name TEXT,
  provider_region TEXT,
  provider_size TEXT,
  provider_image_id INTEGER,
  openbot_image TEXT,
  openbot_version TEXT,
  provider_phase TEXT NOT NULL DEFAULT 'new' CHECK(
    provider_phase IN ('new', 'volume_pending', 'volume_ready', 'droplet_pending', 'ready', 'rejected')
  ),
  provider_operation TEXT CHECK(
    provider_operation IS NULL OR
    provider_operation IN ('power_on', 'shutdown', 'power_off', 'delete_droplet', 'delete_volume')
  ),
  provider_operation_id INTEGER,
  provider_operation_started_at INTEGER,
  provider_operation_token TEXT,
  funding_revision INTEGER NOT NULL DEFAULT 0,
  organization_request_name TEXT,
  UNIQUE(owner_user_id, idempotency_key),
  CHECK(
    (funding = 'stripe' AND funding_status IS NULL
      AND plan IS NOT NULL AND billing_interval IS NOT NULL AND currency IS NOT NULL)
    OR
    (funding = 'organization' AND funding_status IS NOT NULL AND provider = 'digitalocean'
      AND plan IS NULL AND billing_interval IS NULL AND currency IS NULL)
  )
);

INSERT INTO hosted_servers_organization (
  server_id, owner_user_id, name, provider, provider_sandbox_id, provider_template, size, pending_size,
  plan, billing_interval, currency, checkout_session_id, desired_state, observed_state, observed_error,
  provider_event_at, last_wake_reason, claim_token_hash, claim_expires_at, claim_redeemed_at, auth_session_id,
  last_active_at, lease_until, next_run_at, idempotency_key, created_at, updated_at, deleted_at,
  deletion_scheduled_at, deletion_subscription_id, lifecycle_token, lifecycle_lease_until
)
SELECT
  server_id, owner_user_id, name, provider, provider_sandbox_id, provider_template, size, pending_size,
  plan, billing_interval, currency, checkout_session_id, desired_state, observed_state, observed_error,
  provider_event_at, last_wake_reason, claim_token_hash, claim_expires_at, claim_redeemed_at, auth_session_id,
  last_active_at, lease_until, next_run_at, idempotency_key, created_at, updated_at, deleted_at,
  deletion_scheduled_at, deletion_subscription_id, lifecycle_token, lifecycle_lease_until
FROM hosted_servers;

DROP TABLE hosted_servers;
ALTER TABLE hosted_servers_organization RENAME TO hosted_servers;
CREATE INDEX hosted_servers_owner ON hosted_servers(owner_user_id, created_at);
CREATE INDEX hosted_servers_scheduled_deletion ON hosted_servers(deletion_scheduled_at)
  WHERE deletion_scheduled_at IS NOT NULL;
-- A failed create, revoked funding, or requested deletion still owns the single allocation.
-- Only confirmed provider cleanup (observed_state = 'deleted') releases it.
CREATE UNIQUE INDEX hosted_servers_organization_allocation ON hosted_servers(funding)
  WHERE funding = 'organization' AND observed_state != 'deleted';
