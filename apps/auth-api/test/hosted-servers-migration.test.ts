import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migratedDatabase, migration } from "./sqlite-d1";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const insertServer = (database: DatabaseSync, values: { id: string; plan: string; size: string; state: string }) =>
  database
    .prepare(
      `INSERT INTO hosted_servers(
         server_id, owner_user_id, name, size, plan, billing_interval, currency, desired_state, observed_state,
         idempotency_key, created_at, updated_at
       ) VALUES (?, 'user-1', 'Cloud server', ?, ?, 'year', 'pln', 'stopped', ?, ?, 1, 1)`,
    )
    .run(values.id, values.size, values.plan, values.state, `key-${values.id}`);

describe("hosted servers migration", () => {
  it("adds its tables to a database with billing, and keeps accounts, sessions and plans", () => {
    const database = migratedDatabase("0022_billing.sql");
    databases.push(database);
    database.exec(`
      INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
      VALUES ('user-1', 'email:one@example.test', 'one@example.test', 'One', NULL, 1, 1);
      INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
      VALUES ('session-1', 'user-1', 'hash-1', 100, 1, 1);
      INSERT INTO billing_customers(user_id, stripe_customer_id, created_at, updated_at)
      VALUES ('user-1', 'cus_1', 1, 1);
      INSERT INTO billing_subscriptions(
        stripe_subscription_id, user_id, stripe_customer_id, server_id, plan, interval, currency, status,
        current_period_end, cancel_at_period_end, updated_at
      ) VALUES ('sub_1', 'user-1', 'cus_1', 'server-1', 'pro', 'year', 'pln', 'active', 10, 0, 1);
    `);
    const before = snapshot(database);

    database.exec("BEGIN");
    database.exec(migration("0023_hosted_servers.sql"));
    database.exec("COMMIT");

    expect(snapshot(database)).toEqual(before);
    insertServer(database, { id: "server-1", plan: "pro", size: "large", state: "awaiting_payment" });
    expect(() => insertServer(database, { id: "server-2", plan: "free", size: "small", state: "stopped" })).toThrow();
    expect(() => database.exec("UPDATE hosted_servers SET pending_size = 'huge'")).toThrow();
    database.exec(
      "UPDATE hosted_servers SET desired_state = 'idle', last_active_at = 2, lease_until = 3, next_run_at = 4, last_wake_reason = 'schedule'",
    );
    expect(() => database.exec("UPDATE hosted_servers SET last_wake_reason = 'timer'")).toThrow();
    expect(() => database.exec("UPDATE hosted_servers SET desired_state = 'asleep'")).toThrow();
    // A paid sandbox never loses its row: the owner cannot be removed while the row exists.
    expect(() => database.exec("DELETE FROM users WHERE id = 'user-1'")).toThrow();
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});

const snapshot = (database: DatabaseSync) => ({
  users: database.prepare("SELECT * FROM users ORDER BY id").all(),
  sessions: database.prepare("SELECT * FROM auth_sessions ORDER BY id").all(),
  customers: database.prepare("SELECT * FROM billing_customers ORDER BY user_id").all(),
  subscriptions: database.prepare("SELECT * FROM billing_subscriptions ORDER BY stripe_subscription_id").all(),
});

const organizationMigration = "0041_organization_hosting.sql";
const lifecycleDefaults = {
  deletion_scheduled_at: null,
  deletion_subscription_id: null,
  lifecycle_token: null,
  lifecycle_lease_until: null,
};
const organizationDefaults = {
  funding: "stripe",
  funding_status: null,
  organization_entitlement_plan: null,
  provider_droplet_id: null,
  provider_volume_id: null,
  provider_volume_name: null,
  provider_region: null,
  provider_size: null,
  provider_image_id: null,
  openbot_image: null,
  openbot_version: null,
  provider_phase: "new",
  provider_operation: null,
  provider_operation_id: null,
  provider_operation_started_at: null,
  provider_operation_token: null,
  funding_revision: 0,
  organization_request_name: null,
};

function releasedHostedDatabase(last: string): DatabaseSync {
  const database = migratedDatabase(last);
  databases.push(database);
  database.exec(`
    INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
    VALUES ('user-1', 'email:one@example.test', 'one@example.test', 'One', NULL, 1, 1);
    INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
    VALUES ('session-1', 'user-1', 'session-hash', 100, 1, 2);
    INSERT INTO billing_customers(user_id, stripe_customer_id, created_at, updated_at)
    VALUES ('user-1', 'cus_1', 1, 2);
    INSERT INTO billing_subscriptions(
      stripe_subscription_id, user_id, stripe_customer_id, server_id, plan, interval, currency, status,
      current_period_end, cancel_at_period_end, updated_at
    ) VALUES ('sub_1', 'user-1', 'cus_1', 'server-running', 'pro', 'year', 'pln', 'active', 100, 0, 2);
    INSERT INTO hosting_webhook_deliveries(delivery_id, received_at) VALUES ('delivery-1', 12);
  `);
  for (const state of [
    "awaiting_payment",
    "creating",
    "starting",
    "running",
    "stopping",
    "stopped",
    "waking",
    "error",
    "deleted",
  ]) {
    insertServer(database, { id: `server-${state}`, plan: "pro", size: "large", state });
  }
  database.exec(`
    UPDATE hosted_servers SET
      provider_sandbox_id = 'sandbox-' || server_id,
      provider_template = 'template-' || server_id,
      pending_size = 'small',
      checkout_session_id = 'checkout-' || server_id,
      desired_state = CASE WHEN observed_state = 'deleted' THEN 'deleted' ELSE 'idle' END,
      observed_error = CASE WHEN observed_state = 'error' THEN 'provider_error' ELSE NULL END,
      provider_event_at = 11,
      last_wake_reason = 'schedule',
      claim_token_hash = 'claim-' || server_id,
      claim_expires_at = 13,
      claim_redeemed_at = 14,
      auth_session_id = 'session-1',
      last_active_at = 15,
      lease_until = 16,
      next_run_at = 17,
      created_at = 18,
      updated_at = 19,
      deleted_at = CASE WHEN observed_state = 'deleted' THEN 20 ELSE NULL END;
  `);
  if (last >= "0028_hosted_server_lifecycle.sql") {
    database.exec(`
      UPDATE hosted_servers SET deletion_scheduled_at = 21, deletion_subscription_id = 'sub_1',
        lifecycle_token = 'lease-' || server_id, lifecycle_lease_until = 22
      WHERE observed_state IN ('stopped', 'error');
    `);
  }
  return database;
}

function advanceToOrganizationMigration(database: DatabaseSync, after: string): void {
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    if (name > after && name < organizationMigration) database.exec(migration(name));
  }
}

function applyOrganizationMigration(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database.exec(migration(organizationMigration));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const hostedRows = (database: DatabaseSync) =>
  database.prepare("SELECT * FROM hosted_servers ORDER BY server_id").all();

const hostedSchema = (database: DatabaseSync) =>
  database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'hosted_servers' ORDER BY name").all();

function insertOrganization(database: DatabaseSync, id: string): void {
  database
    .prepare(`
    INSERT INTO hosted_servers(
      server_id, owner_user_id, name, provider, size, funding, funding_status, organization_entitlement_plan,
      desired_state, observed_state, idempotency_key, created_at, updated_at, organization_request_name
    ) VALUES (?, 'user-1', 'ODIC', 'digitalocean', 'default', 'organization', 'active', 'standard',
      'running', 'creating', ?, 30, 30, 'ODIC')
  `)
    .run(id, `key-${id}`);
}

describe("organization hosted servers migration", () => {
  it.each(["0023_hosted_servers.sql", "0028_hosted_server_lifecycle.sql", "0040_server_member_limits.sql"])(
    "preserves all data from %s and accepts the old Worker's reads and inserts",
    (last) => {
      const database = releasedHostedDatabase(last);
      const before = hostedRows(database);
      const accounts = snapshot(database);
      const deliveries = database.prepare("SELECT * FROM hosting_webhook_deliveries").all();
      database.exec("BEGIN");
      advanceToOrganizationMigration(database, last);
      database.exec(migration(organizationMigration));
      database.exec("COMMIT");

      expect(hostedRows(database)).toEqual(
        before.map((row) => ({ ...lifecycleDefaults, ...row, ...organizationDefaults })),
      );
      expect(snapshot(database)).toEqual(accounts);
      expect(database.prepare("SELECT * FROM hosting_webhook_deliveries").all()).toEqual(deliveries);
      insertServer(database, { id: "old-worker", plan: "starter", size: "small", state: "awaiting_payment" });
      expect(
        database
          .prepare(`
        SELECT provider, funding, funding_status, plan, billing_interval, currency, provider_phase, funding_revision
        FROM hosted_servers WHERE server_id = 'old-worker'
      `)
          .get(),
      ).toEqual({
        provider: "boat",
        funding: "stripe",
        funding_status: null,
        plan: "starter",
        billing_interval: "year",
        currency: "pln",
        provider_phase: "new",
        funding_revision: 0,
      });
      database.exec(`
        UPDATE hosted_servers SET deletion_scheduled_at = 40, deletion_subscription_id = 'sub_1',
          lifecycle_token = 'old-worker-lease', lifecycle_lease_until = 41
        WHERE server_id = 'old-worker';
      `);
      expect(
        database
          .prepare(`
        SELECT server_id FROM hosted_servers INDEXED BY hosted_servers_owner
        WHERE owner_user_id = 'user-1' AND server_id = 'old-worker'
      `)
          .get(),
      ).toEqual({ server_id: "old-worker" });
      expect(
        database
          .prepare(`
        SELECT server_id FROM hosted_servers INDEXED BY hosted_servers_scheduled_deletion
        WHERE deletion_scheduled_at IS NOT NULL AND server_id = 'old-worker'
      `)
          .get(),
      ).toEqual({ server_id: "old-worker" });
      expect(() => database.exec("DELETE FROM users WHERE id = 'user-1'")).toThrow();
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    },
  );

  it("keeps the allocation through errors, revoked funding and deletion until cleanup is observed", () => {
    const database = releasedHostedDatabase("0040_server_member_limits.sql");
    applyOrganizationMigration(database);
    insertOrganization(database, "organization-1");
    for (const update of [
      "observed_state = 'error', provider_phase = 'rejected'",
      "funding_status = 'revoked', desired_state = 'stopped', observed_state = 'stopped'",
      "desired_state = 'deleted', observed_state = 'stopping'",
      "desired_state = 'deleted', observed_state = 'error'",
    ]) {
      database.exec(`UPDATE hosted_servers SET ${update} WHERE server_id = 'organization-1'`);
      expect(() => insertOrganization(database, "organization-2")).toThrow();
    }
    database.exec(`
      UPDATE hosted_servers SET observed_state = 'deleted', deleted_at = 50 WHERE server_id = 'organization-1'
    `);
    insertOrganization(database, "organization-2");
    expect(() =>
      database.exec(`
      UPDATE hosted_servers SET observed_state = 'running' WHERE server_id = 'organization-1'
    `),
    ).toThrow();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM hosted_servers WHERE funding = 'organization'").get(),
    ).toEqual({ count: 2 });
  });

  it("allows null billing only for organization funding and keeps all released constraints", () => {
    const database = releasedHostedDatabase("0040_server_member_limits.sql");
    applyOrganizationMigration(database);
    insertOrganization(database, "organization-1");
    expect(
      database
        .prepare(`
      SELECT plan, billing_interval, currency, funding_status, organization_entitlement_plan
      FROM hosted_servers WHERE server_id = 'organization-1'
    `)
        .get(),
    ).toEqual({
      plan: null,
      billing_interval: null,
      currency: null,
      funding_status: "active",
      organization_entitlement_plan: "standard",
    });
    for (const assignment of [
      "plan = NULL",
      "billing_interval = NULL",
      "currency = NULL",
      "funding_status = 'active'",
      "plan = 'free'",
      "billing_interval = 'week'",
      "currency = 'gbp'",
      "provider = 'other'",
      "pending_size = 'huge'",
      "size = 'huge'",
      "last_wake_reason = 'timer'",
      "desired_state = 'asleep'",
      "observed_state = 'asleep'",
      "observed_error = 'raw-error'",
      "provider_sandbox_id = 'sandbox-server-running'",
      "claim_token_hash = 'claim-server-running'",
      "idempotency_key = 'key-server-running'",
      "owner_user_id = 'missing-owner'",
    ]) {
      expect(() =>
        database.exec(`
        UPDATE hosted_servers SET ${assignment} WHERE server_id = 'server-stopped'
      `),
      ).toThrow();
    }
    for (const assignment of [
      "plan = 'standard'",
      "billing_interval = 'year'",
      "currency = 'usd'",
      "funding_status = NULL",
      "funding_status = 'paid'",
      "funding = 'stripe'",
      "provider = 'boat'",
      "organization_entitlement_plan = 'free'",
      "provider_phase = 'unknown'",
      "provider_operation = 'restart'",
    ]) {
      expect(() =>
        database.exec(`
        UPDATE hosted_servers SET ${assignment} WHERE server_id = 'organization-1'
      `),
      ).toThrow();
    }
    database.exec(`
      UPDATE hosted_servers SET provider_droplet_id = 123, provider_volume_id = 'volume-1',
        provider_volume_name = 'odic-data', provider_region = 'fra1', provider_size = 's-4vcpu-8gb',
        provider_image_id = 456, openbot_image = 'image@sha256:digest', openbot_version = '1.0.0',
        provider_phase = 'ready', provider_operation = 'shutdown', provider_operation_id = 789,
        provider_operation_started_at = 60, provider_operation_token = 'operation-1', funding_revision = 1,
        observed_state = 'deleted'
      WHERE server_id = 'organization-1';
    `);
    insertOrganization(database, "organization-2");
    for (const assignment of ["provider_droplet_id = 123", "provider_volume_id = 'volume-1'"]) {
      expect(() =>
        database.exec(`
        UPDATE hosted_servers SET ${assignment} WHERE server_id = 'organization-2'
      `),
      ).toThrow();
    }
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("rolls back a failed copy without losing data and can retry after the invalid row is repaired", () => {
    const database = releasedHostedDatabase("0040_server_member_limits.sql");
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.exec("UPDATE hosted_servers SET plan = 'invalid-plan' WHERE server_id = 'server-error'");
    database.exec("PRAGMA ignore_check_constraints = OFF");
    const before = hostedRows(database);
    const schema = hostedSchema(database);
    expect(() => applyOrganizationMigration(database)).toThrow();
    expect(hostedRows(database)).toEqual(before);
    expect(hostedSchema(database)).toEqual(schema);
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'hosted_servers_organization'").all()).toEqual(
      [],
    );
    database.exec("UPDATE hosted_servers SET plan = 'pro' WHERE server_id = 'server-error'");
    applyOrganizationMigration(database);
    expect(hostedRows(database)).toEqual(before.map((row) => ({ ...row, plan: "pro", ...organizationDefaults })));
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("restores the old table and indexes when a later statement fails after the rebuild", () => {
    const database = releasedHostedDatabase("0040_server_member_limits.sql");
    const before = hostedRows(database);
    const schema = hostedSchema(database);
    const accounts = snapshot(database);
    database.exec("BEGIN");
    try {
      database.exec(migration(organizationMigration));
      expect(() =>
        insertServer(database, {
          id: "server-running",
          plan: "pro",
          size: "large",
          state: "running",
        }),
      ).toThrow();
    } finally {
      database.exec("ROLLBACK");
    }
    expect(hostedRows(database)).toEqual(before);
    expect(hostedSchema(database)).toEqual(schema);
    expect(snapshot(database)).toEqual(accounts);
    insertServer(database, { id: "old-worker-retry", plan: "standard", size: "default", state: "creating" });
    const retryRows = hostedRows(database);
    applyOrganizationMigration(database);
    expect(hostedRows(database)).toEqual(retryRows.map((row) => ({ ...row, ...organizationDefaults })));
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("fails safely without the lifecycle migration and succeeds after the missing versions are applied", () => {
    const database = releasedHostedDatabase("0023_hosted_servers.sql");
    const before = hostedRows(database);
    const schema = hostedSchema(database);
    expect(() => applyOrganizationMigration(database)).toThrow();
    expect(hostedRows(database)).toEqual(before);
    expect(hostedSchema(database)).toEqual(schema);
    advanceToOrganizationMigration(database, "0023_hosted_servers.sql");
    applyOrganizationMigration(database);
    expect(hostedRows(database)).toEqual(
      before.map((row) => ({ ...row, ...lifecycleDefaults, ...organizationDefaults })),
    );
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});
