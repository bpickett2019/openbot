import type { BillingCurrency, BillingInterval, BillingPlanId } from "@openbot/contracts/billing";
import { BILLING_PLAN_IDS } from "@openbot/contracts/billing";
import {
  type HostedServerActivityReport,
  type HostedServerCatalog,
  type HostedServerCheckout,
  type HostedServerClaim,
  type HostedServerEntryPoint,
  type HostedServerError,
  type HostedServerLifecycleInput,
  type HostedServerList,
  type HostedServerSize,
  type HostedServerState,
  type HostedServerStatus,
  type HostedServerSummary,
  parseHostedServerName,
} from "@openbot/contracts/hosted-servers";
import { isDynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import type { RouteHostState } from "@openbot/contracts/signal-protocol/ingress-queue";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema } from "effect";
import { BillingError, type BillingReturnTarget, type SubscriptionSync } from "./billing-service";
import { constantTimeEqual, deriveSecret, hmacSha256, randomToken, sha256 } from "./crypto";
import {
  DigitalOceanClient,
  type DigitalOceanDroplet,
  DigitalOceanError,
  type DigitalOceanFetch,
  type DigitalOceanVolume,
  isDefinitiveProviderRefusal,
} from "./digitalocean-client";
import type { RemoteFailure } from "./remote-control-plane";
import { PERSISTENT_SESSION_EXPIRES_AT } from "./session-policy";
import type { AuthUser, WorkerBindings } from "./types";

const CLAIM_TTL_MS = 60 * 60_000;
const CLAIM_REDEEM_RETRY_MS = 10 * 60_000;
const IDLE_STOP_AFTER_MS = 15 * 60_000;
const SCHEDULE_WAKE_BEFORE_MS = 10 * 60_000;
const NEXT_RUN_MAX_AHEAD_MS = 400 * 24 * 60 * 60_000;
const FUNDED_SQL = "funding = 'organization' AND funding_status = 'active' AND desired_state IN ('running', 'idle')";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

export type HostedServerBindings = Pick<
  WorkerBindings,
  | "DB"
  | "HOSTED_SERVERS_ENABLED"
  | "DIGITALOCEAN_API_TOKEN"
  | "HOSTED_DIGITALOCEAN_REGION"
  | "HOSTED_DIGITALOCEAN_SIZE"
  | "HOSTED_DIGITALOCEAN_IMAGE_ID"
  | "HOSTED_OPENBOT_IMAGE_DIGEST"
  | "HOSTED_OPENBOT_VERSION"
  | "HOSTED_ORGANIZATION_OWNER_USER_ID"
  | "HOSTED_ORGANIZATION_ADMIN_TOKEN"
  | "HOSTED_ORGANIZATION_ENTITLEMENT_PLAN"
  | "BROWSER_APP_ORIGIN"
  | "REMOTE_SIGNAL_URL"
  | "REMOTE_TICKET_PRIVATE_JWK"
>;

export class HostedServerServiceError extends Schema.TaggedError<HostedServerServiceError>()(
  "HostedServerServiceError",
  { status: Schema.Number, code: Schema.String, message: Schema.String },
) {
  constructor(status: number, code: string, message: string) {
    super({ status, code, message });
  }
}
class HostedServerOperationError extends Schema.TaggedError<HostedServerOperationError>()(
  "HostedServerOperationError",
  {},
) {}
export type HostedFailure = HostedServerServiceError | DigitalOceanError | BillingError | HostedServerOperationError;
function failure(error: unknown): HostedFailure {
  return error instanceof HostedServerServiceError ||
    error instanceof DigitalOceanError ||
    error instanceof BillingError
    ? error
    : new HostedServerOperationError({});
}
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });

type DesiredState = "running" | "idle" | "stopped" | "deleted";
type ProviderPhase = "new" | "volume_pending" | "volume_ready" | "droplet_pending" | "ready" | "rejected";
type ProviderOperation = "power_on" | "shutdown" | "power_off" | "delete_droplet" | "delete_volume";
interface HostedServerRow {
  server_id: string;
  owner_user_id: string;
  name: string;
  provider: "boat" | "digitalocean";
  funding: "stripe" | "organization";
  funding_status: "active" | "revoked" | null;
  organization_entitlement_plan: BillingPlanId | null;
  organization_request_name: string | null;
  funding_revision: number;
  size: HostedServerSize;
  plan: BillingPlanId | null;
  billing_interval: BillingInterval | null;
  currency: BillingCurrency | null;
  desired_state: DesiredState;
  observed_state: HostedServerState;
  observed_error: HostedServerError | null;
  auth_session_id: string | null;
  claim_token_hash: string | null;
  claim_expires_at: number | null;
  last_active_at: number | null;
  next_run_at: number | null;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
  deletion_scheduled_at: number | null;
  provider_droplet_id: number | null;
  provider_volume_id: string | null;
  provider_volume_name: string | null;
  provider_region: string | null;
  provider_size: string | null;
  provider_image_id: number | null;
  openbot_image: string | null;
  openbot_version: string | null;
  provider_phase: ProviderPhase;
  provider_operation: ProviderOperation | null;
  provider_operation_id: number | null;
  provider_operation_started_at: number | null;
  provider_operation_token: string | null;
}
export interface HostedServerServiceOptions {
  fetch?: DigitalOceanFetch;
  now?: () => number;
  removeHost?: ((ownerUserId: string, hostId: string) => Effect.Effect<void, RemoteFailure>) | null | undefined;
  planChanged?: (hostId: string) => Effect.Effect<void, RemoteFailure>;
  schedule?: (work: Effect.Effect<void>) => void;
}
export interface CheckoutReturn {
  target: BillingReturnTarget;
  origin: string;
  entryPoint?: HostedServerEntryPoint;
}
export interface HostedServerTickResult {
  reconciled: number;
  idle: number;
  scheduled: number;
  failed: number;
}

/** One durable allocation owns the Droplet, the retained volume, and all provider operations. */
export class HostedServerService {
  readonly #bindings: HostedServerBindings;
  readonly #db: D1Database;
  readonly #provider: DigitalOceanClient | null;
  readonly #now: () => number;
  readonly #removeHost: HostedServerServiceOptions["removeHost"];
  readonly #planChanged: HostedServerServiceOptions["planChanged"];
  readonly #schedule: (work: Effect.Effect<void>) => void;

  constructor(bindings: HostedServerBindings, options: HostedServerServiceOptions = {}) {
    this.#bindings = bindings;
    this.#db = bindings.DB;
    this.#provider = bindings.DIGITALOCEAN_API_TOKEN?.trim()
      ? new DigitalOceanClient({
          token: bindings.DIGITALOCEAN_API_TOKEN.trim(),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : null;
    this.#now = options.now ?? Date.now;
    this.#removeHost = options.removeHost;
    this.#planChanged = options.planChanged;
    this.#schedule =
      options.schedule ??
      ((work) => {
        Effect.runFork(work);
      });
  }

  /** Operator authority is independent of cookies, owner roles, and developer headers. */
  authorizeOperator(header: string | null): void {
    const key = this.#bindings.HOSTED_ORGANIZATION_ADMIN_TOKEN?.trim() ?? "";
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (key.length < 32 || !token || !constantTimeEqual(new TextEncoder().encode(key), new TextEncoder().encode(token)))
      throw new HostedServerServiceError(401, "hosting_operator_unauthorized", "Operator authorization is required.");
  }

  isAvailableFor(_user: Pick<AuthUser, "id" | "email">): boolean {
    return false;
  }

  readonly plans = Effect.fn("HostedServerService.plans")(
    (_user: AuthUser): Effect.Effect<HostedServerCatalog> => Effect.succeed({ plans: [] }),
  );
  readonly create = Effect.fn("HostedServerService.create")(function* (
    _user: AuthUser,
    _input: { name: unknown; plan: unknown; interval: unknown; currency: unknown; entryPoint?: unknown },
    _idempotencyKey: string | null,
    _returnTo: CheckoutReturn,
  ): Effect.fn.Return<HostedServerCheckout, HostedFailure> {
    return yield* managedOnly();
  });
  readonly checkout = Effect.fn("HostedServerService.checkout")(function* (
    _user: AuthUser,
    _serverId: string,
    _returnTo: CheckoutReturn,
  ): Effect.fn.Return<HostedServerCheckout, HostedFailure> {
    return yield* managedOnly();
  });

  readonly list = Effect.fn("HostedServerService.list")(function* (
    this: HostedServerService,
    user: AuthUser,
  ): Effect.fn.Return<HostedServerList, HostedFailure> {
    const rows = yield* io(() =>
      this.#db
        .prepare(
          "SELECT * FROM hosted_servers WHERE owner_user_id = ? AND observed_state != 'deleted' ORDER BY created_at",
        )
        .bind(user.id)
        .all<HostedServerRow>(),
    );
    return { available: false, lifecycleAvailable: true, servers: rows.results.map(summary), maxServers: 1 };
  }).bind(this);

  readonly operatorList = Effect.fn("HostedServerService.operatorList")(function* (
    this: HostedServerService,
  ): Effect.fn.Return<HostedServerSummary[], HostedFailure> {
    const rows = yield* io(() =>
      this.#db
        .prepare("SELECT * FROM hosted_servers WHERE funding = 'organization' ORDER BY created_at")
        .all<HostedServerRow>(),
    );
    return rows.results.map(summary);
  }).bind(this);

  readonly operatorCreate = Effect.fn("HostedServerService.operatorCreate")(function* (
    this: HostedServerService,
    input: unknown,
    key: string | null,
  ): Effect.fn.Return<HostedServerSummary, HostedFailure> {
    if (!isDynamicRecord(input) || Object.keys(input).length !== 1 || typeof input.name !== "string")
      return yield* invalidRequest();
    const name = parseHostedServerName(input.name);
    if (!name || !key || !REQUEST_ID.test(key)) return yield* invalidRequest();
    const configuration = yield* Effect.try({ try: () => this.#configuration(), catch: failure });
    const now = this.#now();
    const owner = yield* io(() =>
      this.#db
        .prepare(`SELECT id FROM users WHERE id = ? AND EXISTS(
      SELECT 1 FROM auth_sessions WHERE user_id = users.id AND revoked_at IS NULL AND expires_at > ?)`)
        .bind(configuration.owner, now)
        .first<{ id: string }>(),
    );
    if (!owner)
      return yield* new HostedServerServiceError(
        409,
        "hosting_owner_not_signed_in",
        "The configured owner must sign in first.",
      );
    const previous = yield* io(() =>
      this.#db
        .prepare(
          "SELECT * FROM hosted_servers WHERE funding = 'organization' AND owner_user_id = ? AND idempotency_key = ?",
        )
        .bind(owner.id, key)
        .first<HostedServerRow>(),
    );
    if (previous) {
      if (previous.organization_request_name !== name) return yield* requestConflict();
      return summary(previous);
    }
    const serverId = crypto.randomUUID();
    yield* io(() =>
      this.#db
        .prepare(`INSERT INTO hosted_servers(
      server_id, owner_user_id, name, provider, funding, funding_status, organization_entitlement_plan,
      organization_request_name, size, plan, billing_interval, currency, desired_state, observed_state,
      idempotency_key, provider_volume_name, provider_region, provider_size, provider_image_id,
      openbot_image, openbot_version, created_at, updated_at, last_active_at
    ) VALUES (?, ?, ?, 'digitalocean', 'organization', 'active', ?, ?, 'default', NULL, NULL, NULL,
      'running', 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .bind(
          serverId,
          owner.id,
          name,
          configuration.plan,
          name,
          key,
          `openbot-${serverId}`,
          configuration.region,
          configuration.size,
          configuration.imageId,
          configuration.image,
          configuration.version,
          now,
          now,
          now,
        )
        .run(),
    );
    const row = yield* io(() =>
      this.#db
        .prepare(
          "SELECT * FROM hosted_servers WHERE funding = 'organization' AND owner_user_id = ? AND idempotency_key = ?",
        )
        .bind(owner.id, key)
        .first<HostedServerRow>(),
    );
    if (!row)
      return yield* new HostedServerServiceError(
        409,
        "organization_host_capacity",
        "The organization already has a host allocation.",
      );
    if (row.organization_request_name !== name) return yield* requestConflict();
    this.#schedule(this.#reconcileSafely(row.server_id));
    return summary(row);
  }).bind(this);

  readonly operatorFunding = Effect.fn("HostedServerService.operatorFunding")(function* (
    this: HostedServerService,
    serverId: string,
    input: unknown,
  ): Effect.fn.Return<HostedServerSummary, HostedFailure> {
    if (
      !isDynamicRecord(input) ||
      Object.keys(input).length !== 1 ||
      !isOneOf(["active", "revoked"] as const, input.status)
    )
      return yield* invalidRequest();
    const row = yield* this.#requireRow(serverId);
    yield* this.#requireManaged(row);
    if (row.desired_state === "deleted") return yield* notFound();
    if (input.status === "active") yield* Effect.try({ try: () => this.#configuration(), catch: failure });
    // Revoke is committed before any provider request. Every runnable write has the same funding predicate.
    yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET funding_status = ?, funding_revision = funding_revision + 1,
      desired_state = CASE WHEN ? = 'revoked' THEN 'stopped' WHEN funding_status = 'revoked' THEN 'running' ELSE desired_state END,
      provider_phase = CASE WHEN ? = 'active' AND provider_phase = 'rejected' THEN
        CASE WHEN provider_volume_id IS NULL THEN 'new' ELSE 'volume_ready' END ELSE provider_phase END,
      last_active_at = CASE WHEN ? = 'active' THEN ? ELSE last_active_at END, updated_at = ?
      WHERE server_id = ? AND funding = 'organization' AND desired_state != 'deleted'`)
        .bind(input.status, input.status, input.status, input.status, this.#now(), this.#now(), serverId)
        .run(),
    );
    yield* this.#reconcileSafely(serverId);
    if (this.#planChanged) yield* this.#planChanged(serverId).pipe(Effect.mapError(failure));
    return summary(yield* this.#requireRow(serverId));
  }).bind(this);

  /** Stripe can still manage unrelated subscriptions, never this organization's allocation. */
  readonly onSubscriptionSynced = Effect.fn("HostedServerService.onSubscriptionSynced")(function* (
    this: HostedServerService,
    sync: SubscriptionSync,
  ): Effect.fn.Return<void, HostedFailure> {
    const row = yield* io(() =>
      this.#db
        .prepare("SELECT funding, provider FROM hosted_servers WHERE server_id = ?")
        .bind(sync.serverId)
        .first<{ funding: string; provider: string }>(),
    );
    if (!row || row.funding === "organization") return;
    return yield* migrationRequired();
  }).bind(this);

  readonly lifecycle = Effect.fn("HostedServerService.lifecycle")(function* (
    this: HostedServerService,
    user: AuthUser,
    serverId: string,
    input: HostedServerLifecycleInput,
  ): Effect.fn.Return<void, HostedFailure> {
    if (input.action !== "delete" || input.timing !== "now") return yield* managedOnly();
    yield* this.delete(user, serverId, input.confirmName);
  }).bind(this);

  readonly delete = Effect.fn("HostedServerService.delete")(function* (
    this: HostedServerService,
    user: AuthUser,
    serverId: string,
    confirmName: unknown,
  ): Effect.fn.Return<void, HostedFailure> {
    const row = yield* this.#requireRow(serverId);
    if (row.owner_user_id !== user.id) return yield* notFound();
    yield* this.#requireManaged(row);
    if (confirmName !== row.name)
      return yield* new HostedServerServiceError(
        400,
        "hosted_server_confirm_mismatch",
        "Type the server name to delete it.",
      );
    if (row.observed_state === "deleted") return;
    // The unique allocation is released only by #finishDelete after provider and Remote cleanup.
    yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET desired_state = 'deleted', funding_status = 'revoked',
      funding_revision = funding_revision + 1, claim_token_hash = NULL, updated_at = ? WHERE server_id = ? AND funding = 'organization'`)
        .bind(this.#now(), serverId)
        .run(),
    );
    yield* this.#reconcileSafely(serverId);
    if (this.#planChanged) yield* this.#planChanged(serverId).pipe(Effect.mapError(failure));
  }).bind(this);

  readonly status = Effect.fn("HostedServerService.status")(function* (
    this: HostedServerService,
    user: AuthUser,
    serverId: string,
  ): Effect.fn.Return<HostedServerStatus, HostedFailure> {
    const row = yield* this.#authorizedRow(user, serverId);
    return {
      serverId,
      state: row.observed_state,
      error: row.observed_error,
      sleeping: row.desired_state === "idle" && row.funding_status === "active",
      funding: row.funding,
      ...(row.funding === "organization" && row.funding_status ? { fundingStatus: row.funding_status } : {}),
    };
  }).bind(this);

  readonly wake = Effect.fn("HostedServerService.wake")(function* (
    this: HostedServerService,
    user: AuthUser,
    serverId: string,
  ): Effect.fn.Return<HostedServerSummary, HostedFailure> {
    const row = yield* this.#authorizedRow(user, serverId);
    yield* this.#startForUse(row);
    return summary(yield* this.#requireRow(serverId));
  }).bind(this);

  readonly restart = Effect.fn("HostedServerService.restart")(function* (
    this: HostedServerService,
    user: AuthUser,
    serverId: string,
  ): Effect.fn.Return<HostedServerSummary, HostedFailure> {
    const row = yield* this.#authorizedRow(user, serverId, true);
    yield* this.#requireFunded(row);
    const claimed = yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET desired_state = 'running', observed_state = 'stopping', last_active_at = ?, updated_at = ?
      WHERE server_id = ? AND ${FUNDED_SQL} AND provider_operation IS NULL AND observed_state = 'running'`)
        .bind(this.#now(), this.#now(), serverId)
        .run(),
    );
    if (claimed.meta.changes === 1 && row.provider_droplet_id)
      yield* this.#action(yield* this.#requireRow(serverId), "shutdown");
    else yield* this.#startForUse(row);
    return summary(yield* this.#requireRow(serverId));
  }).bind(this);

  readonly routeState = Effect.fn("HostedServerService.routeState")(function* (
    this: HostedServerService,
    hostId: string,
  ): Effect.fn.Return<RouteHostState, HostedFailure> {
    const row = yield* io(() =>
      this.#db.prepare("SELECT * FROM hosted_servers WHERE server_id = ?").bind(hostId).first<HostedServerRow>(),
    );
    if (!row) return "not_hosted";
    if (
      row.funding !== "organization" ||
      row.funding_status !== "active" ||
      row.desired_state === "stopped" ||
      row.desired_state === "deleted"
    )
      return "ended";
    return row.desired_state === "idle" ? "sleeping" : "starting";
  }).bind(this);

  readonly startForRoute = Effect.fn("HostedServerService.startForRoute")(function* (
    this: HostedServerService,
    hostId: string,
  ): Effect.fn.Return<void, HostedFailure> {
    const row = yield* this.#requireRow(hostId);
    if (
      row.funding !== "organization" ||
      row.funding_status !== "active" ||
      row.desired_state === "deleted" ||
      row.desired_state === "stopped"
    )
      return;
    yield* this.#startForUse(row);
  }).bind(this);

  readonly reportActivity = Effect.fn("HostedServerService.reportActivity")(function* (
    this: HostedServerService,
    sessionToken: string,
    serverId: string,
    report: HostedServerActivityReport,
  ): Effect.fn.Return<void, HostedFailure> {
    const hash = yield* sha256(sessionToken).pipe(Effect.mapError(failure));
    const now = this.#now();
    const row = yield* io(() =>
      this.#db
        .prepare(`SELECT * FROM hosted_servers WHERE server_id = ? AND auth_session_id IN (
      SELECT id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?)`)
        .bind(serverId, hash, now)
        .first<HostedServerRow>(),
    );
    if (!row) return yield* notFound();
    yield* this.#requireFunded(row);
    const nextRunAt =
      report.nextRunAt === undefined
        ? row.next_run_at
        : report.nextRunAt !== null && report.nextRunAt > now && report.nextRunAt <= now + NEXT_RUN_MAX_AHEAD_MS
          ? report.nextRunAt
          : null;
    yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET next_run_at = ?, last_active_at = CASE WHEN ? AND desired_state = 'running' THEN ? ELSE last_active_at END
      WHERE server_id = ? AND ${FUNDED_SQL}`)
        .bind(nextRunAt, report.inUse ? 1 : 0, now, serverId)
        .run(),
    );
  }).bind(this);

  readonly redeemClaim = Effect.fn("HostedServerService.redeemClaim")(function* (
    this: HostedServerService,
    claim: unknown,
  ): Effect.fn.Return<HostedServerClaim, HostedFailure> {
    if (typeof claim !== "string" || claim.length < 16 || claim.length > 128) return yield* invalidClaim();
    const hash = yield* sha256(claim).pipe(Effect.mapError(failure));
    const now = this.#now();
    const row = yield* io(() =>
      this.#db
        .prepare(`SELECT * FROM hosted_servers WHERE claim_token_hash = ? AND claim_expires_at > ? AND ${FUNDED_SQL}`)
        .bind(hash, now)
        .first<HostedServerRow>(),
    );
    if (!row) return yield* invalidClaim();
    const user = yield* io(() =>
      this.#db
        .prepare("SELECT id, email, name, avatar_url FROM users WHERE id = ?")
        .bind(row.owner_user_id)
        .first<{ id: string; email: string; name: string | null; avatar_url: string | null }>(),
    );
    if (!user) return yield* invalidClaim();
    const privateKey = yield* Effect.try({
      try: (): unknown => JSON.parse(this.#bindings.REMOTE_TICKET_PRIVATE_JWK ?? ""),
      catch: () => notConfigured(),
    });
    if (!isDynamicRecord(privateKey) || typeof privateKey.d !== "string" || privateKey.d.length < 32)
      return yield* notConfigured();
    const secret = yield* deriveSecret(privateKey.d, "openbot-hosted-session-key:v1").pipe(Effect.mapError(failure));
    const sessionToken = yield* hmacSha256(secret, `${row.server_id}:${hash}`).pipe(Effect.mapError(failure));
    const tokenHash = yield* sha256(sessionToken).pipe(Effect.mapError(failure));
    const sessionId = crypto.randomUUID();
    yield* io(() =>
      this.#db.batch([
        // Replay returns the same opaque credential; it never rotates or revives an existing session.
        this.#db
          .prepare(`UPDATE hosted_servers SET claim_redeemed_at = COALESCE(claim_redeemed_at, ?),
        claim_expires_at = MIN(claim_expires_at, ?), auth_session_id = COALESCE(auth_session_id, ?), updated_at = ?
        WHERE server_id = ? AND claim_token_hash = ? AND claim_expires_at > ? AND ${FUNDED_SQL}
        AND (auth_session_id IS NULL OR EXISTS(SELECT 1 FROM auth_sessions a
          WHERE a.id = hosted_servers.auth_session_id AND a.token_hash = ? AND a.revoked_at IS NULL AND a.expires_at > ?))`)
          .bind(now, now + CLAIM_REDEEM_RETRY_MS, sessionId, now, row.server_id, hash, now, tokenHash, now),
        this.#db
          .prepare(`INSERT OR IGNORE INTO auth_sessions(id,user_id,token_hash,expires_at,created_at,last_used_at)
        SELECT auth_session_id,owner_user_id,?,?,?,? FROM hosted_servers
        WHERE server_id = ? AND auth_session_id = ? AND claim_token_hash = ? AND claim_expires_at > ? AND ${FUNDED_SQL}`)
          .bind(tokenHash, PERSISTENT_SESSION_EXPIRES_AT, now, now, row.server_id, sessionId, hash, now),
      ]),
    );
    const active = yield* io(() =>
      this.#db
        .prepare(`SELECT 1 AS active FROM hosted_servers h
      JOIN auth_sessions a ON a.id = h.auth_session_id WHERE h.server_id = ? AND h.claim_token_hash = ?
      AND h.claim_expires_at > ? AND h.funding = 'organization' AND h.funding_status = 'active'
      AND h.desired_state IN ('running','idle') AND a.token_hash = ? AND a.revoked_at IS NULL AND a.expires_at > ?`)
        .bind(row.server_id, hash, this.#now(), tokenHash, this.#now())
        .first<{ active: number }>(),
    );
    if (!active) return yield* invalidClaim();
    return {
      hostId: row.server_id,
      name: row.name,
      sessionToken,
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url },
    };
  }).bind(this);

  readonly tick = Effect.fn("HostedServerService.tick")(function* (
    this: HostedServerService,
    now = this.#now(),
  ): Effect.fn.Return<HostedServerTickResult, HostedFailure> {
    const result: HostedServerTickResult = { reconciled: 0, idle: 0, scheduled: 0, failed: 0 };
    const rows = yield* io(() =>
      this.#db
        .prepare("SELECT * FROM hosted_servers WHERE funding = 'organization' AND observed_state != 'deleted'")
        .all<HostedServerRow>(),
    );
    for (const row of rows.results) {
      const outcome = yield* Effect.result(
        Effect.gen({ self: this }, function* () {
          if (row.funding_status === "active" && this.#bindings.HOSTED_SERVERS_ENABLED === "true") {
            const idle = yield* io(() =>
              this.#db
                .prepare(`UPDATE hosted_servers SET desired_state = 'idle', updated_at = ?
            WHERE server_id = ? AND ${FUNDED_SQL} AND desired_state = 'running' AND observed_state = 'running'
            AND COALESCE(last_active_at, created_at) <= ? AND provider_operation IS NULL
            AND (next_run_at IS NULL OR next_run_at <= ? OR next_run_at > ?)`)
                .bind(now, row.server_id, now - IDLE_STOP_AFTER_MS, now, now + SCHEDULE_WAKE_BEFORE_MS)
                .run(),
            );
            result.idle += idle.meta.changes;
            const scheduled = yield* io(() =>
              this.#db
                .prepare(`UPDATE hosted_servers SET desired_state = 'running', next_run_at = NULL, last_active_at = ?, updated_at = ?
            WHERE server_id = ? AND ${FUNDED_SQL} AND desired_state = 'idle' AND next_run_at IS NOT NULL AND next_run_at <= ?`)
                .bind(now, now, row.server_id, now + SCHEDULE_WAKE_BEFORE_MS)
                .run(),
            );
            result.scheduled += scheduled.meta.changes;
          }
          yield* this.#reconcile(row.server_id);
          result.reconciled += 1;
        }),
      );
      if (Result.isFailure(outcome)) {
        result.failed += 1;
        yield* this.#recordFailure(row.server_id, outcome.failure);
      }
    }
    return result;
  }).bind(this);

  readonly #startForUse = Effect.fn("HostedServerService.startForUse")(function* (
    this: HostedServerService,
    row: HostedServerRow,
  ): Effect.fn.Return<void, HostedFailure> {
    yield* this.#requireFunded(row);
    yield* Effect.try({ try: () => this.#configuration(), catch: failure });
    const updated = yield* io(() =>
      this.#db
        .prepare(
          `UPDATE hosted_servers SET desired_state = 'running', last_active_at = ?, updated_at = ? WHERE server_id = ? AND ${FUNDED_SQL}`,
        )
        .bind(this.#now(), this.#now(), row.server_id)
        .run(),
    );
    if (updated.meta.changes !== 1) return yield* fundingRevoked();
    yield* this.#reconcileSafely(row.server_id);
  }).bind(this);

  readonly #reconcileSafely = Effect.fn("HostedServerService.reconcileSafely")(function* (
    this: HostedServerService,
    serverId: string,
  ): Effect.fn.Return<void> {
    yield* this.#reconcile(serverId).pipe(
      Effect.catch((error) => this.#recordFailure(serverId, error)),
      Effect.ignore,
    );
  }).bind(this);

  readonly #recordFailure = Effect.fn("HostedServerService.recordFailure")(function* (
    this: HostedServerService,
    serverId: string,
    error: unknown,
  ): Effect.fn.Return<void, HostedFailure> {
    const code: HostedServerError =
      error instanceof DigitalOceanError && error.status === 429 ? "provider_limit" : "provider_error";
    yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET observed_state = 'error', observed_error = ?, updated_at = ?
      WHERE server_id = ? AND funding = 'organization' AND observed_state != 'deleted'`)
        .bind(code, this.#now(), serverId)
        .run(),
    );
  }).bind(this);

  readonly #reconcile = Effect.fn("HostedServerService.reconcile")(function* (
    this: HostedServerService,
    serverId: string,
  ): Effect.fn.Return<void, HostedFailure> {
    let row = yield* this.#requireRow(serverId);
    yield* this.#requireManaged(row);
    if (row.observed_state === "deleted") return;
    const provider = this.#provider;
    if (!provider) return yield* notConfigured();
    // A lost create response is reconciled by identity, never by replaying POST.
    if (row.provider_phase === "volume_pending") {
      const volume = yield* provider.findVolume(required(row.provider_volume_name), required(row.provider_region));
      if (!volume) return;
      yield* this.#adoptVolume(row, volume);
      row = yield* this.#requireRow(serverId);
    }
    if (row.provider_phase === "droplet_pending") {
      const droplets = yield* provider.findDroplets(`openbot:${serverId}`);
      if (droplets.length > 1) return yield* identityConflict();
      if (!droplets[0]) return;
      yield* this.#adoptDroplet(row, droplets[0]);
      row = yield* this.#requireRow(serverId);
    }
    if (row.desired_state === "deleted") return yield* this.#finishDelete(row);
    if (!row.provider_droplet_id) {
      if (row.funding_status !== "active" || row.desired_state !== "running") {
        yield* this.#observeStopped(row);
        return;
      }
      if (this.#bindings.HOSTED_SERVERS_ENABLED !== "true") return;
      if (row.provider_phase === "new" || row.provider_phase === "volume_ready") yield* this.#provision(row);
      return;
    }
    const droplet = yield* provider.getDroplet(row.provider_droplet_id);
    yield* this.#validateDroplet(row, droplet);
    const volume = yield* provider.getVolume(required(row.provider_volume_id));
    yield* this.#validateVolume(row, volume, droplet.id);
    if (row.provider_operation) {
      const settled = yield* this.#settleAction(row, droplet);
      if (!settled) return;
      row = yield* this.#requireRow(serverId);
    }
    if (droplet.locked || droplet.status === "new") return;
    if (row.funding_status !== "active" || row.desired_state !== "running") {
      if (droplet.status === "active") yield* this.#action(row, "shutdown");
      else if (droplet.status === "off") yield* this.#observeStopped(row);
      else return yield* identityConflict();
      return;
    }
    if (droplet.status === "off") {
      yield* this.#observeStopped(row);
      if (this.#bindings.HOSTED_SERVERS_ENABLED === "true")
        yield* this.#action(yield* this.#requireRow(serverId), "power_on");
    } else if (droplet.status === "active") {
      yield* io(() =>
        this.#db
          .prepare(`UPDATE hosted_servers SET observed_state = 'running', observed_error = NULL, updated_at = ?
        WHERE server_id = ? AND ${FUNDED_SQL} AND desired_state = 'running' AND provider_operation IS NULL`)
          .bind(this.#now(), serverId)
          .run(),
      );
      // A funding transition can win the observation write. Read it again before returning to the caller.
      const current = yield* this.#requireRow(serverId);
      if (current.funding_status !== "active" || current.desired_state !== "running")
        yield* this.#action(current, "shutdown");
    }
  }).bind(this);

  readonly #provision = Effect.fn("HostedServerService.provision")(function* (
    this: HostedServerService,
    original: HostedServerRow,
  ): Effect.fn.Return<void, HostedFailure> {
    const provider = this.#provider;
    if (!provider) return yield* notConfigured();
    yield* Effect.try({ try: () => this.#configuration(), catch: failure });
    let row = original;
    if (row.provider_phase === "new") {
      yield* provider.checkSize(required(row.provider_size), required(row.provider_region));
      const claimed = yield* io(() =>
        this.#db
          .prepare(`UPDATE hosted_servers SET provider_phase = 'volume_pending', observed_state = 'creating', updated_at = ?
        WHERE server_id = ? AND provider_phase = 'new' AND ${FUNDED_SQL} AND desired_state = 'running'`)
          .bind(this.#now(), row.server_id)
          .run(),
      );
      if (claimed.meta.changes !== 1) return;
      const result = yield* Effect.result(
        provider.createVolume(required(row.provider_volume_name), required(row.provider_region), row.server_id),
      );
      if (Result.isFailure(result)) {
        if (isDefinitiveProviderRefusal(result.failure)) yield* this.#rejectCreate(row.server_id, "volume_pending");
        return yield* result.failure;
      }
      yield* this.#adoptVolume(row, result.success);
      row = yield* this.#requireRow(row.server_id);
    }
    if (row.provider_phase !== "volume_ready" || row.funding_status !== "active" || row.desired_state !== "running") {
      yield* this.#reconcile(row.server_id);
      return;
    }
    const volume = yield* provider.getVolume(required(row.provider_volume_id));
    yield* this.#validateVolume(row, volume, null);
    const claim = randomToken();
    const hash = yield* sha256(claim).pipe(Effect.mapError(failure));
    const claimed = yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET provider_phase = 'droplet_pending', claim_token_hash = ?, claim_expires_at = ?,
      observed_state = 'creating', last_active_at = ?, updated_at = ? WHERE server_id = ? AND provider_phase = 'volume_ready' AND ${FUNDED_SQL} AND desired_state = 'running'`)
        .bind(hash, this.#now() + CLAIM_TTL_MS, this.#now(), this.#now(), row.server_id)
        .run(),
    );
    if (claimed.meta.changes !== 1) return;
    const config = {
      hostId: row.server_id,
      volumeId: row.provider_volume_id,
      volumeName: row.provider_volume_name,
      accountOrigin: this.#bindings.BROWSER_APP_ORIGIN,
      signalUrl: this.#bindings.REMOTE_SIGNAL_URL,
      image: row.openbot_image,
      version: row.openbot_version,
      initialize: true,
      hostedClaim: claim,
    };
    // JSON is base64-encoded, not shell-interpolated. Only a scoped expiring claim enters metadata.
    const encoded = btoa(JSON.stringify(config));
    const userData = `#!/bin/sh\nset -eu\numask 077\ninstall -d -m 0700 /etc/openbot-host\nprintf '%s' '${encoded}' | base64 -d > /etc/openbot-host/config.json\nexec /usr/local/sbin/openbot-digitalocean-bootstrap install /etc/openbot-host/config.json\n`;
    const result = yield* Effect.result(
      provider.createDroplet({
        name: `openbot-${row.server_id}`,
        tag: `openbot:${row.server_id}`,
        region: required(row.provider_region),
        size: required(row.provider_size),
        image: required(row.provider_image_id),
        volumeId: required(row.provider_volume_id),
        userData,
      }),
    );
    if (Result.isFailure(result)) {
      if (isDefinitiveProviderRefusal(result.failure)) yield* this.#rejectCreate(row.server_id, "droplet_pending");
      return yield* result.failure;
    }
    yield* this.#adoptDroplet(row, result.success);
    yield* this.#reconcile(row.server_id);
  }).bind(this);

  readonly #rejectCreate = Effect.fn("HostedServerService.rejectCreate")(function* (
    this: HostedServerService,
    serverId: string,
    phase: ProviderPhase,
  ): Effect.fn.Return<void, HostedFailure> {
    yield* io(() =>
      this.#db
        .prepare(
          "UPDATE hosted_servers SET provider_phase = 'rejected', claim_token_hash = NULL WHERE server_id = ? AND provider_phase = ?",
        )
        .bind(serverId, phase)
        .run(),
    );
  }).bind(this);

  readonly #adoptVolume = Effect.fn("HostedServerService.adoptVolume")(function* (
    this: HostedServerService,
    row: HostedServerRow,
    volume: DigitalOceanVolume,
  ): Effect.fn.Return<void, HostedFailure> {
    yield* this.#validateVolume(row, volume, null);
    yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET provider_volume_id = ?, provider_phase = 'volume_ready', updated_at = ?
      WHERE server_id = ? AND provider_phase = 'volume_pending' AND provider_volume_id IS NULL`)
        .bind(volume.id, this.#now(), row.server_id)
        .run(),
    );
  }).bind(this);

  readonly #adoptDroplet = Effect.fn("HostedServerService.adoptDroplet")(function* (
    this: HostedServerService,
    row: HostedServerRow,
    droplet: DigitalOceanDroplet,
  ): Effect.fn.Return<void, HostedFailure> {
    yield* this.#validateDroplet(row, droplet);
    // Adoption never grants funding. Even a deleted/revoked row retains late resources for cleanup.
    yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET provider_droplet_id = ?, provider_phase = 'ready', observed_state = 'starting', updated_at = ?
      WHERE server_id = ? AND provider_phase = 'droplet_pending' AND provider_droplet_id IS NULL`)
        .bind(droplet.id, this.#now(), row.server_id)
        .run(),
    );
  }).bind(this);

  readonly #validateVolume = Effect.fn("HostedServerService.validateVolume")(function* (
    this: HostedServerService,
    row: HostedServerRow,
    volume: DigitalOceanVolume,
    dropletId: number | null,
  ): Effect.fn.Return<void, HostedFailure> {
    const attached = volume.droplet_ids ?? [];
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(volume.id) ||
      (row.provider_volume_id !== null && volume.id !== row.provider_volume_id) ||
      volume.name !== row.provider_volume_name ||
      volume.region.slug !== row.provider_region ||
      volume.size_gigabytes !== 100 ||
      volume.filesystem_type !== "ext4" ||
      (dropletId === null ? attached.length !== 0 : attached.length !== 1 || attached[0] !== dropletId)
    )
      return yield* identityConflict();
  }).bind(this);

  readonly #validateDroplet = Effect.fn("HostedServerService.validateDroplet")(function* (
    this: HostedServerService,
    row: HostedServerRow,
    droplet: DigitalOceanDroplet,
  ): Effect.fn.Return<void, HostedFailure> {
    if (
      !Number.isSafeInteger(droplet.id) ||
      droplet.id <= 0 ||
      (row.provider_droplet_id !== null && droplet.id !== row.provider_droplet_id) ||
      droplet.name !== `openbot-${row.server_id}` ||
      !droplet.tags.includes(`openbot:${row.server_id}`) ||
      droplet.region.slug !== row.provider_region ||
      droplet.size_slug !== row.provider_size ||
      droplet.image.id !== row.provider_image_id ||
      droplet.vcpus !== 4 ||
      droplet.memory !== 8192 ||
      droplet.volume_ids.length !== 1 ||
      droplet.volume_ids[0] !== row.provider_volume_id
    )
      return yield* identityConflict();
  }).bind(this);

  readonly #action = Effect.fn("HostedServerService.action")(function* (
    this: HostedServerService,
    row: HostedServerRow,
    operation: "power_on" | "shutdown" | "power_off",
  ): Effect.fn.Return<void, HostedFailure> {
    const provider = this.#provider;
    if (!provider || !row.provider_droplet_id) return yield* notConfigured();
    const token = crypto.randomUUID();
    const now = this.#now();
    const condition = operation === "power_on" ? ` AND ${FUNDED_SQL} AND desired_state = 'running'` : "";
    const claimed = yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET provider_operation = ?, provider_operation_token = ?, provider_operation_started_at = ?,
      observed_state = ?, updated_at = ? WHERE server_id = ? AND provider_operation IS NULL AND observed_state != 'deleted'${condition}`)
        .bind(operation, token, now, operation === "power_on" ? "waking" : "stopping", now, row.server_id)
        .run(),
    );
    if (claimed.meta.changes !== 1) return;
    const result = yield* Effect.result(provider.act(row.provider_droplet_id, operation));
    if (Result.isFailure(result)) {
      if (isDefinitiveProviderRefusal(result.failure)) yield* this.#clearOperation(row.server_id, token);
      return yield* result.failure;
    }
    yield* io(() =>
      this.#db
        .prepare(
          "UPDATE hosted_servers SET provider_operation_id = ? WHERE server_id = ? AND provider_operation_token = ?",
        )
        .bind(result.success.id, row.server_id, token)
        .run(),
    );
    // A revocation during this await is not overwritten. Cron or the same request adopts and stops it.
    const current = yield* this.#requireRow(row.server_id);
    if (operation === "power_on" && (current.funding_status !== "active" || current.desired_state !== "running"))
      yield* this.#reconcile(row.server_id);
  }).bind(this);

  readonly #settleAction = Effect.fn("HostedServerService.settleAction")(function* (
    this: HostedServerService,
    row: HostedServerRow,
    droplet: DigitalOceanDroplet,
  ): Effect.fn.Return<boolean, HostedFailure> {
    const provider = this.#provider;
    if (
      !provider ||
      !row.provider_operation ||
      !row.provider_operation_token ||
      row.provider_operation_started_at === null
    )
      return false;
    if (row.provider_operation === "delete_droplet" || row.provider_operation === "delete_volume") return false;
    const actions = yield* provider.actions(droplet.id, row.provider_operation_started_at);
    const candidates = actions.filter(
      (action) =>
        action.resource_id === droplet.id &&
        action.type === row.provider_operation &&
        (row.provider_operation_id === null || action.id === row.provider_operation_id),
    );
    if (candidates.length !== 1 || candidates[0]?.status === "in-progress" || droplet.locked) return false;
    const action = candidates[0];
    if (!action) return false;
    yield* this.#clearOperation(row.server_id, row.provider_operation_token);
    if (action.status === "errored")
      return yield* new DigitalOceanError({ status: 502, code: "provider_action_failed" });
    if (row.provider_operation === "shutdown" && droplet.status === "active") {
      // DigitalOcean shutdown is graceful but is not guaranteed. A durable stop still needs enforcement.
      yield* this.#action(yield* this.#requireRow(row.server_id), "power_off");
      return false;
    }
    return true;
  }).bind(this);

  readonly #clearOperation = Effect.fn("HostedServerService.clearOperation")(function* (
    this: HostedServerService,
    serverId: string,
    token: string,
  ): Effect.fn.Return<void, HostedFailure> {
    yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET provider_operation = NULL, provider_operation_token = NULL,
      provider_operation_id = NULL, provider_operation_started_at = NULL WHERE server_id = ? AND provider_operation_token = ?`)
        .bind(serverId, token)
        .run(),
    );
  }).bind(this);

  readonly #observeStopped = Effect.fn("HostedServerService.observeStopped")(function* (
    this: HostedServerService,
    row: HostedServerRow,
  ): Effect.fn.Return<void, HostedFailure> {
    yield* io(() =>
      this.#db
        .prepare(
          "UPDATE hosted_servers SET observed_state = 'stopped', observed_error = NULL, updated_at = ? WHERE server_id = ? AND observed_state != 'deleted'",
        )
        .bind(this.#now(), row.server_id)
        .run(),
    );
  }).bind(this);

  readonly #finishDelete = Effect.fn("HostedServerService.finishDelete")(function* (
    this: HostedServerService,
    row: HostedServerRow,
  ): Effect.fn.Return<void, HostedFailure> {
    const provider = this.#provider;
    if (!provider) return yield* notConfigured();
    // No proof of absence can cancel an in-flight create. Keep the slot until its resource is adopted.
    if (row.provider_phase === "volume_pending" || row.provider_phase === "droplet_pending") return;
    if (row.provider_droplet_id) {
      const lookup = yield* Effect.result(provider.getDroplet(row.provider_droplet_id));
      if (Result.isSuccess(lookup)) {
        yield* this.#validateDroplet(row, lookup.success);
        if (row.provider_operation && row.provider_operation !== "delete_droplet") {
          if (!(yield* this.#settleAction(row, lookup.success))) return;
          row = yield* this.#requireRow(row.server_id);
        }
        if (lookup.success.locked) return;
        if (row.provider_operation === "delete_droplet") return;
        const claimed = yield* this.#claimDelete(row, "delete_droplet");
        if (!claimed) return;
        const deleted = yield* Effect.result(provider.deleteDroplet(required(row.provider_droplet_id)));
        if (Result.isFailure(deleted)) {
          if (isDefinitiveProviderRefusal(deleted.failure)) {
            yield* this.#clearOperation(row.server_id, claimed);
          }
          return yield* deleted.failure;
        }
        return;
      }
      if (!(lookup.failure instanceof DigitalOceanError && lookup.failure.status === 404)) return yield* lookup.failure;
      yield* io(() =>
        this.#db
          .prepare(`UPDATE hosted_servers SET provider_droplet_id = NULL, provider_operation = NULL, provider_operation_id = NULL,
        provider_operation_token = NULL, provider_operation_started_at = NULL WHERE server_id = ? AND desired_state = 'deleted' AND provider_droplet_id = ?`)
          .bind(row.server_id, row.provider_droplet_id)
          .run(),
      );
      row = yield* this.#requireRow(row.server_id);
    }
    if (row.provider_volume_id) {
      const lookup = yield* Effect.result(provider.getVolume(row.provider_volume_id));
      if (Result.isSuccess(lookup)) {
        yield* this.#validateVolume(row, lookup.success, null);
        if (row.provider_operation === "delete_volume") return;
        const claimed = yield* this.#claimDelete(row, "delete_volume");
        if (!claimed) return;
        const deleted = yield* Effect.result(provider.deleteVolume(row.provider_volume_id));
        if (Result.isFailure(deleted)) {
          if (isDefinitiveProviderRefusal(deleted.failure)) {
            yield* this.#clearOperation(row.server_id, claimed);
          }
          return yield* deleted.failure;
        }
        return;
      }
      if (!(lookup.failure instanceof DigitalOceanError && lookup.failure.status === 404)) return yield* lookup.failure;
      yield* io(() =>
        this.#db
          .prepare(`UPDATE hosted_servers SET provider_volume_id = NULL, provider_operation = NULL, provider_operation_token = NULL,
        provider_operation_id = NULL, provider_operation_started_at = NULL WHERE server_id = ? AND desired_state = 'deleted' AND provider_volume_id = ?`)
          .bind(row.server_id, row.provider_volume_id)
          .run(),
      );
    }
    if (!this.#removeHost) return yield* notConfigured();
    yield* this.#removeHost(row.owner_user_id, row.server_id).pipe(Effect.mapError(failure));
    const now = this.#now();
    yield* io(() =>
      this.#db.batch([
        this.#db
          .prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
          .bind(now, row.auth_session_id),
        this.#db
          .prepare(`UPDATE hosted_servers SET observed_state = 'deleted', claim_token_hash = NULL, deleted_at = ?, updated_at = ?
        WHERE server_id = ? AND desired_state = 'deleted' AND provider_droplet_id IS NULL AND provider_volume_id IS NULL
        AND provider_phase NOT IN ('volume_pending', 'droplet_pending') AND provider_operation IS NULL`)
          .bind(now, now, row.server_id),
      ]),
    );
  }).bind(this);

  readonly #claimDelete = Effect.fn("HostedServerService.claimDelete")(function* (
    this: HostedServerService,
    row: HostedServerRow,
    operation: "delete_droplet" | "delete_volume",
  ): Effect.fn.Return<string | null, HostedFailure> {
    const token = crypto.randomUUID();
    const result = yield* io(() =>
      this.#db
        .prepare(`UPDATE hosted_servers SET provider_operation = ?, provider_operation_token = ?, provider_operation_started_at = ?
      WHERE server_id = ? AND desired_state = 'deleted' AND provider_operation IS NULL`)
        .bind(operation, token, this.#now(), row.server_id)
        .run(),
    );
    return result.meta.changes === 1 ? token : null;
  }).bind(this);

  readonly #requireRow = Effect.fn("HostedServerService.requireRow")(function* (
    this: HostedServerService,
    serverId: string,
  ): Effect.fn.Return<HostedServerRow, HostedFailure> {
    const row = yield* io(() =>
      this.#db.prepare("SELECT * FROM hosted_servers WHERE server_id = ?").bind(serverId).first<HostedServerRow>(),
    );
    if (!row) return yield* notFound();
    return row;
  }).bind(this);

  readonly #authorizedRow = Effect.fn("HostedServerService.authorizedRow")(function* (
    this: HostedServerService,
    user: AuthUser,
    serverId: string,
    admin = false,
  ): Effect.fn.Return<HostedServerRow, HostedFailure> {
    const row = yield* io(() =>
      this.#db
        .prepare(`SELECT * FROM hosted_servers h WHERE h.server_id = ? AND h.desired_state != 'deleted'
      AND (h.owner_user_id = ? OR EXISTS(SELECT 1 FROM remote_memberships m WHERE m.host_id = h.server_id
        AND m.user_id = ? AND m.status = 'active'${admin ? " AND m.role IN ('owner','admin')" : ""}))`)
        .bind(serverId, user.id, user.id)
        .first<HostedServerRow>(),
    );
    if (!row) return yield* notFound();
    return row;
  }).bind(this);

  readonly #requireManaged = Effect.fn("HostedServerService.requireManaged")(function* (
    row: HostedServerRow,
  ): Effect.fn.Return<void, HostedFailure> {
    if (row.provider !== "digitalocean" || row.funding !== "organization") return yield* migrationRequired();
  });
  readonly #requireFunded = Effect.fn("HostedServerService.requireFunded")(function* (
    this: HostedServerService,
    row: HostedServerRow,
  ): Effect.fn.Return<void, HostedFailure> {
    yield* this.#requireManaged(row);
    if (row.funding_status !== "active" || row.desired_state === "stopped" || row.desired_state === "deleted")
      return yield* fundingRevoked();
  }).bind(this);

  #configuration() {
    const b = this.#bindings;
    const imageId = Number(b.HOSTED_DIGITALOCEAN_IMAGE_ID);
    const image = b.HOSTED_OPENBOT_IMAGE_DIGEST ?? "";
    const version = b.HOSTED_OPENBOT_VERSION ?? "";
    const origin = b.BROWSER_APP_ORIGIN ?? "";
    const signal = b.REMOTE_SIGNAL_URL ?? "";
    const owner = b.HOSTED_ORGANIZATION_OWNER_USER_ID?.trim();
    const region = b.HOSTED_DIGITALOCEAN_REGION?.trim();
    const size = b.HOSTED_DIGITALOCEAN_SIZE?.trim();
    const plan = b.HOSTED_ORGANIZATION_ENTITLEMENT_PLAN;
    const privateKey = JSON.parse(b.REMOTE_TICKET_PRIVATE_JWK ?? "null");
    if (!isDynamicRecord(privateKey) || typeof privateKey.d !== "string" || privateKey.d.length < 32)
      throw notConfigured();
    if (
      b.HOSTED_SERVERS_ENABLED !== "true" ||
      !this.#provider ||
      !owner ||
      !region ||
      size !== "s-4vcpu-8gb" ||
      !Number.isSafeInteger(imageId) ||
      imageId <= 0 ||
      !/^ghcr\.io\/bpickett2019\/openbot@sha256:[a-f0-9]{64}$/u.test(image) ||
      !/^\d+\.\d+\.\d+$/u.test(version) ||
      !isOneOf(BILLING_PLAN_IDS, plan)
    )
      throw notConfigured();
    const accountUrl = new URL(origin);
    const signalUrl = new URL(signal);
    if (
      accountUrl.protocol !== "https:" ||
      accountUrl.origin !== origin ||
      accountUrl.username ||
      accountUrl.password ||
      signalUrl.protocol !== "wss:" ||
      signalUrl.pathname !== "/v1/signal" ||
      signalUrl.username ||
      signalUrl.password ||
      signalUrl.search ||
      signalUrl.hash
    )
      throw notConfigured();
    return { owner, region, size, imageId, image, version, plan };
  }
}

function summary(row: HostedServerRow): HostedServerSummary {
  const common = {
    serverId: row.server_id,
    name: row.name,
    state: row.observed_state,
    error: row.observed_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
  if (row.funding === "organization") {
    if (!row.funding_status || !row.provider_region) throw new HostedServerOperationError({});
    return {
      ...common,
      size: "default",
      funding: "organization",
      fundingStatus: row.funding_status,
      plan: null,
      interval: null,
      currency: null,
      deletionScheduledAt: null,
      resources: { provider: "digitalocean", vcpu: 4, memoryGb: 8, diskGb: 100, region: row.provider_region },
    };
  }
  if (!row.plan || !row.billing_interval || !row.currency) throw new HostedServerOperationError({});
  return {
    ...common,
    size: row.size,
    funding: "stripe",
    plan: row.plan,
    interval: row.billing_interval,
    currency: row.currency,
    deletionScheduledAt: row.deletion_scheduled_at,
  };
}
function required<A>(value: A | null): A {
  if (value === null) throw new HostedServerOperationError({});
  return value;
}
function managedOnly() {
  return new HostedServerServiceError(
    403,
    "organization_managed_hosting",
    sourceText("error.billing.organizationManaged"),
  );
}
function invalidRequest() {
  return new HostedServerServiceError(400, "invalid_hosted_server_request", "The hosted server request is invalid.");
}
function requestConflict() {
  return new HostedServerServiceError(
    409,
    "hosted_server_request_conflict",
    "This request key was used with different input.",
  );
}
function notFound() {
  return new HostedServerServiceError(404, "hosted_server_not_found", "The server does not exist.");
}
function invalidClaim() {
  return new HostedServerServiceError(401, "hosted_claim_invalid", "The server claim is invalid or used.");
}
function fundingRevoked() {
  return new HostedServerServiceError(403, "hosted_funding_revoked", sourceText("error.billing.fundingRevoked"));
}
function notConfigured() {
  return new HostedServerServiceError(503, "hosting_not_configured", "Organization hosting is not configured.");
}
function migrationRequired() {
  return new HostedServerServiceError(
    409,
    "hosting_migration_required",
    "This host needs an approved provider migration.",
  );
}
function identityConflict() {
  return new HostedServerServiceError(
    409,
    "hosting_provider_identity_conflict",
    "The provider resource does not match the host allocation.",
  );
}
