// Runs the real hosted lifecycle and its migrated SQLite authority with an isolated provider transport.
// No credentials, network requests, cloud resources, or native disks are used.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createHostedServerStatusCheck,
  createHostedServerWake,
  hostedStartStep,
} from "@openbot/team-client/hosted-server-wake";
import { Effect } from "effect";
import { getServerEntitlement } from "../src/server/billing-entitlement";
import type { DigitalOceanAction, DigitalOceanDroplet, DigitalOceanVolume } from "../src/server/digitalocean-client";
import { type HostedServerBindings, HostedServerService } from "../src/server/hosted-server-service";
import { RemoteControlPlaneError } from "../src/server/remote-control-plane";
import { sqliteD1 } from "./sqlite-d1";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build", "hosted-lifecycle-e2e");
const OWNER = { id: "owner", email: "owner@example.test", name: null, avatarUrl: null };
const MEMBER = { id: "member", email: "member@example.test", name: null, avatarUrl: null };
const STRANGER = { id: "stranger", email: "stranger@example.test", name: null, avatarUrl: null };
const ADMIN = "synthetic-operator-token-not-a-real-secret";
const KEY = "organization-request-0001";
const checks: string[] = [];

interface Barrier {
  wait: Promise<void>;
  release: () => void;
}
function barrier(): Barrier {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: promise, release: resolve };
}

/** The provider seam models asynchronous acceptance, visibility, and lost replies, not application decisions. */
class Provider {
  volume: DigitalOceanVolume | null = null;
  droplet: DigitalOceanDroplet | null = null;
  actions: DigitalOceanAction[] = [];
  calls: string[] = [];
  claim: string | null = null;
  now = Date.UTC(2026, 9, 29, 12);
  holdCreate: Barrier | null = null;
  createEntered = barrier();
  holdStart: Barrier | null = null;
  startEntered = barrier();
  hiddenDroplet = false;
  loseCreateReply = false;
  deleteFailure: "refused" | "uncertain" | null = null;
  failRemoteCleanup = false;
  removeCount = 0;

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.digitalocean.com");
    const method = init.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname === "/v2/sizes")
      return Response.json({
        sizes: [{ slug: "s-4vcpu-8gb", vcpus: 4, memory: 8192, available: true, regions: ["nyc3"] }],
      });
    if (url.pathname === "/v2/volumes" && method === "POST") {
      assert.equal(body.filesystem_type, "ext4");
      this.volume = {
        id: "10000000-0000-4000-8000-000000000001",
        name: body.name,
        size_gigabytes: 100,
        filesystem_type: "ext4",
        region: { slug: "nyc3" },
        droplet_ids: [],
      };
      return Response.json({ volume: this.volume }, { status: 201 });
    }
    if (url.pathname === "/v2/volumes" && method === "GET")
      return Response.json({ volumes: this.volume ? [this.volume] : [] });
    if (url.pathname.startsWith("/v2/volumes/")) {
      if (method === "DELETE") {
        this.volume = null;
        return new Response(null, { status: 204 });
      }
      return this.volume ? Response.json({ volume: this.volume }) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/v2/droplets" && method === "POST") {
      assert.ok(this.volume);
      assert.deepEqual(body.volumes, [this.volume.id]);
      const encoded = String(body.user_data).match(/printf '%s' '([A-Za-z0-9+/=]+)'/u)?.[1];
      assert.ok(encoded);
      const config = JSON.parse(atob(encoded));
      assert.equal(config.volumeId, this.volume.id);
      assert.equal(config.initialize, true);
      assert.equal(config.accountOrigin, "https://accounts.example.test");
      assert.equal(config.signalUrl, "wss://signal.example.test/v1/signal");
      assert.equal(config.image, `ghcr.io/bpickett2019/openbot@sha256:${"a".repeat(64)}`);
      assert.equal(String(body.user_data).includes(ADMIN), false);
      assert.equal(String(body.user_data).includes("synthetic-provider-token"), false);
      this.claim = config.hostedClaim;
      this.droplet = {
        id: 101,
        name: body.name,
        status: "active",
        locked: false,
        vcpus: 4,
        memory: 8192,
        size_slug: "s-4vcpu-8gb",
        region: { slug: "nyc3" },
        image: { id: 777 },
        volume_ids: [this.volume.id],
        tags: body.tags,
      };
      this.volume = { ...this.volume, droplet_ids: [101] };
      this.createEntered.release();
      if (this.holdCreate) await this.holdCreate.wait;
      this.hiddenDroplet = false;
      if (this.loseCreateReply) throw new Error("synthetic lost create response");
      return Response.json({ droplet: this.droplet }, { status: 202 });
    }
    if (url.pathname === "/v2/droplets" && method === "GET")
      return Response.json({ droplets: this.droplet && !this.hiddenDroplet ? [this.droplet] : [] });
    if (url.pathname.endsWith("/actions")) {
      if (method === "GET") return Response.json({ actions: this.actions });
      assert.ok(this.droplet);
      const action: DigitalOceanAction = {
        id: this.actions.length + 1,
        type: body.type,
        status: "in-progress",
        started_at: new Date(this.now).toISOString(),
        resource_id: this.droplet.id,
      };
      this.actions.push(action);
      if (body.type === "power_on" && this.holdStart) {
        this.startEntered.release();
        await this.holdStart.wait;
      }
      this.droplet = { ...this.droplet, status: body.type === "power_on" ? "active" : "off" };
      const completed: DigitalOceanAction = { ...action, status: "completed" };
      this.actions[this.actions.length - 1] = completed;
      return Response.json({ action: completed }, { status: 201 });
    }
    if (url.pathname === "/v2/droplets/101") {
      if (method === "DELETE") {
        const failed = this.deleteFailure;
        this.deleteFailure = null;
        if (failed === "refused") return new Response(null, { status: 403 });
        if (failed === "uncertain") throw new Error("Synthetic lost delete reply.");
        this.droplet = null;
        if (this.volume) this.volume = { ...this.volume, droplet_ids: [] };
        return new Response(null, { status: 204 });
      }
      return this.droplet ? Response.json({ droplet: this.droplet }) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected isolated provider request: ${method} ${url.pathname}`);
  };
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(join(ROOT, "apps/auth-api/migrations")).sort())
    db.exec(readFileSync(join(ROOT, "apps/auth-api/migrations", name), "utf8"));
  const provider = new Provider();
  for (const user of [OWNER, MEMBER, STRANGER])
    db.prepare("INSERT INTO users(id,identity_key,email,created_at,updated_at) VALUES (?,?,?,1,1)").run(
      user.id,
      `email:${user.email}`,
      user.email,
    );
  db.prepare(
    "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,created_at,last_used_at) VALUES ('signed-in-owner','owner','synthetic-session-hash',?,1,1)",
  ).run(provider.now + 86400_000);
  const pending: Effect.Effect<void>[] = [];
  const bindings: HostedServerBindings = {
    DB: sqliteD1(db),
    HOSTED_SERVERS_ENABLED: "true",
    DIGITALOCEAN_API_TOKEN: "synthetic-provider-token",
    HOSTED_ORGANIZATION_ADMIN_TOKEN: ADMIN,
    HOSTED_ORGANIZATION_OWNER_USER_ID: OWNER.id,
    HOSTED_ORGANIZATION_ENTITLEMENT_PLAN: "standard",
    HOSTED_DIGITALOCEAN_REGION: "nyc3",
    HOSTED_DIGITALOCEAN_SIZE: "s-4vcpu-8gb",
    HOSTED_DIGITALOCEAN_IMAGE_ID: "777",
    HOSTED_OPENBOT_IMAGE_DIGEST: `ghcr.io/bpickett2019/openbot@sha256:${"a".repeat(64)}`,
    HOSTED_OPENBOT_VERSION: "0.52.1",
    REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ d: "synthetic-private-key-material-not-a-real-key" }),
    BROWSER_APP_ORIGIN: "https://accounts.example.test",
    REMOTE_SIGNAL_URL: "wss://signal.example.test/v1/signal",
  };
  const service = new HostedServerService(bindings, {
    fetch: provider.fetch,
    now: () => provider.now,
    schedule: (work) => pending.push(work),
    removeHost: () =>
      provider.failRemoteCleanup
        ? Effect.fail(new RemoteControlPlaneError(503, "synthetic_remote_failure", "Synthetic Remote outage."))
        : Effect.sync(() => {
            provider.removeCount += 1;
          }),
    planChanged: () => Effect.void,
  });
  const drain = async () => {
    for (const work of pending.splice(0)) await Effect.runPromise(work);
  };
  return { db, provider, service, bindings, drain };
}

async function allocationAndAccess() {
  const f = fixture();
  try {
    for (const credential of [null, "Bearer owner-session", "Bearer developer-key", "Bearer wrong"])
      assert.throws(() => f.service.authorizeOperator(credential), /Operator authorization/u);
    f.service.authorizeOperator(`Bearer ${ADMIN}`);
    await assert.rejects(Effect.runPromise(f.service.operatorCreate({ name: "Shared", ownerUserId: "stranger" }, KEY)));
    assert.equal(f.provider.calls.length, 0);
    const [first, replay] = await Promise.all([
      Effect.runPromise(f.service.operatorCreate({ name: "Shared" }, KEY)),
      Effect.runPromise(f.service.operatorCreate({ name: "Shared" }, KEY)),
    ]);
    assert.equal(first.serverId, replay.serverId);
    assert.equal(first.funding, "organization");
    assert.equal(first.plan, null);
    assert.equal(first.interval, null);
    assert.equal(first.currency, null);
    await assert.rejects(Effect.runPromise(f.service.operatorCreate({ name: "Changed" }, KEY)));
    await assert.rejects(Effect.runPromise(f.service.operatorCreate({ name: "Second" }, "organization-request-0002")));
    await f.drain();
    assert.equal(f.provider.calls.filter((call) => call === "POST /v2/droplets").length, 1);
    assert.equal(f.provider.calls.filter((call) => call === "POST /v2/volumes").length, 1);
    f.db
      .prepare(
        "INSERT INTO remote_hosts(host_id,owner_user_id,name,created_at,updated_at) VALUES (?,'owner','Shared',1,1)",
      )
      .run(first.serverId);
    f.db
      .prepare(
        "INSERT INTO remote_memberships(membership_id,host_id,user_id,role,status,created_at,updated_at) VALUES ('member-access',?,'member','member','active',1,1)",
      )
      .run(first.serverId);
    assert.equal((await Effect.runPromise(f.service.status(MEMBER, first.serverId))).serverId, first.serverId);
    await assert.rejects(Effect.runPromise(f.service.status(STRANGER, first.serverId)));
    f.db.prepare("UPDATE remote_memberships SET status='revoked' WHERE membership_id='member-access'").run();
    await assert.rejects(Effect.runPromise(f.service.wake(MEMBER, first.serverId)));
    assert.ok(f.provider.claim);
    const [claim, concurrentClaim] = await Promise.all([
      Effect.runPromise(f.service.redeemClaim(f.provider.claim)),
      Effect.runPromise(f.service.redeemClaim(f.provider.claim)),
    ]);
    assert.equal(claim.hostId, first.serverId);
    assert.equal(claim.user.id, OWNER.id);
    assert.equal(concurrentClaim.sessionToken, claim.sessionToken);
    // The first response can be lost before native storage records it.
    const recovered = await Effect.runPromise(f.service.redeemClaim(f.provider.claim));
    assert.equal(recovered.sessionToken, claim.sessionToken);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS total FROM auth_sessions WHERE id != 'signed-in-owner'").get()?.total,
      1,
    );
    assert.ok(await Effect.runPromise(getServerEntitlement(f.bindings.DB, first.serverId, f.provider.now)));
    await Effect.runPromise(f.service.operatorFunding(first.serverId, { status: "revoked" }));
    await Effect.runPromise(f.service.tick());
    await assert.rejects(Effect.runPromise(f.service.redeemClaim(f.provider.claim)));
    assert.equal((await Effect.runPromise(f.service.status(OWNER, first.serverId))).fundingStatus, "revoked");
    assert.equal(await Effect.runPromise(getServerEntitlement(f.bindings.DB, first.serverId, f.provider.now)), null);
    await assert.rejects(Effect.runPromise(f.service.wake(OWNER, first.serverId)));
    await assert.rejects(Effect.runPromise(f.service.restart(OWNER, first.serverId)));
    await assert.rejects(
      Effect.runPromise(
        f.service.reportActivity(claim.sessionToken, first.serverId, {
          inUse: true,
          nextRunAt: f.provider.now + 60000,
        }),
      ),
    );
    const count = f.provider.calls.length;
    await Effect.runPromise(f.service.startForRoute(first.serverId));
    assert.equal(f.provider.calls.length, count);
    const volumeId = f.provider.volume?.id;
    await Effect.runPromise(f.service.operatorFunding(first.serverId, { status: "active" }));
    await Effect.runPromise(f.service.tick());
    assert.equal(f.provider.volume?.id, volumeId);
    assert.equal(f.provider.droplet?.id, 101);
    assert.equal(f.provider.calls.filter((call) => call === "POST /v2/droplets").length, 1);
    checks.push(
      "operator isolation, exact input, atomic allocation, idempotency, null billing, member access, claim, revoke and restore",
    );
  } finally {
    f.db.close();
  }
}

async function revokedBeforeProvisioning() {
  const f = fixture();
  try {
    const host = await Effect.runPromise(f.service.operatorCreate({ name: "Shared" }, KEY));
    await Effect.runPromise(f.service.operatorFunding(host.serverId, { status: "revoked" }));
    await f.drain();
    assert.equal(f.provider.calls.length, 0);
    const restored = await Effect.runPromise(f.service.operatorFunding(host.serverId, { status: "active" }));
    assert.equal(restored.serverId, host.serverId);
    assert.equal(f.provider.droplet?.status, "active");
    checks.push("never-provisioned revocation keeps allocation; reactivation provisions the original host");
  } finally {
    f.db.close();
  }
}

async function createRacesAndLostReply(deleteDuringCreate: boolean) {
  const f = fixture();
  try {
    f.provider.holdCreate = barrier();
    f.provider.hiddenDroplet = true;
    const host = await Effect.runPromise(f.service.operatorCreate({ name: "Shared" }, KEY));
    const creating = f.drain();
    await f.provider.createEntered.wait;
    if (deleteDuringCreate) await Effect.runPromise(f.service.delete(OWNER, host.serverId, "Shared"));
    else await Effect.runPromise(f.service.operatorFunding(host.serverId, { status: "revoked" }));
    await assert.rejects(Effect.runPromise(f.service.operatorCreate({ name: "Second" }, "organization-request-0002")));
    f.provider.loseCreateReply = true;
    f.provider.holdCreate.release();
    await creating;
    await Effect.runPromise(f.service.tick());
    if (deleteDuringCreate) {
      // Each tick independently confirms resource absence before it progresses to the next delete.
      f.provider.failRemoteCleanup = true;
      await Effect.runPromise(f.service.tick());
      await Effect.runPromise(f.service.tick());
      assert.equal(f.provider.droplet, null);
      assert.equal(f.provider.volume, null);
      await assert.rejects(
        Effect.runPromise(f.service.operatorCreate({ name: "Second" }, "organization-request-0002")),
      );
      assert.equal(f.provider.removeCount, 0);
      f.provider.failRemoteCleanup = false;
      await Effect.runPromise(f.service.tick());
      assert.equal(f.provider.removeCount, 1);
      const next = await Effect.runPromise(f.service.operatorCreate({ name: "Second" }, "organization-request-0002"));
      assert.notEqual(next.serverId, host.serverId);
    } else {
      await Effect.runPromise(f.service.tick());
      assert.equal(f.provider.droplet?.status, "off");
      assert.equal((await Effect.runPromise(f.service.status(OWNER, host.serverId))).fundingStatus, "revoked");
    }
    assert.equal(f.provider.calls.filter((call) => call === "POST /v2/droplets").length, 1);
    checks.push(
      deleteDuringCreate
        ? "lost create during deletion is adopted and deleted before slot release"
        : "lost create during revocation is adopted and stopped without mutation replay",
    );
  } finally {
    f.db.close();
  }
}

async function wakeRaceAndSchedules() {
  const f = fixture();
  try {
    const host = await Effect.runPromise(f.service.operatorCreate({ name: "Shared" }, KEY));
    await f.drain();
    f.provider.now += 16 * 60000;
    await Effect.runPromise(f.service.tick());
    await Effect.runPromise(f.service.tick());
    assert.equal((await Effect.runPromise(f.service.status(OWNER, host.serverId))).sleeping, true);
    const volume = f.provider.volume?.id;
    f.provider.holdStart = barrier();
    const waking = Effect.runPromise(f.service.wake(OWNER, host.serverId));
    await f.provider.startEntered.wait;
    await Effect.runPromise(f.service.operatorFunding(host.serverId, { status: "revoked" }));
    f.provider.holdStart.release();
    await waking;
    await Effect.runPromise(f.service.tick());
    assert.equal(f.provider.droplet?.status, "off");
    assert.equal(f.provider.volume?.id, volume);
    const starts = f.provider.calls.filter((call) => call === "POST /v2/droplets/101/actions").length;
    f.provider.now += 20 * 86400_000;
    await Effect.runPromise(f.service.tick());
    assert.equal(f.provider.calls.filter((call) => call === "POST /v2/droplets/101/actions").length, starts);
    const wake = createHostedServerWake(() =>
      Effect.succeed({
        ok: true,
        status: 200,
        json: async () => ({ ...host, state: "waking", fundingStatus: "revoked" }),
      }),
    );
    assert.equal(await Effect.runPromise(wake(host.serverId)), false);
    let attempted = 0;
    const status = createHostedServerStatusCheck(
      () =>
        Effect.succeed({
          ok: true,
          status: 200,
          json: async () => ({
            serverId: host.serverId,
            state: "stopped",
            error: null,
            sleeping: false,
            funding: "organization",
            fundingStatus: "revoked",
          }),
        }),
      () =>
        Effect.sync(() => {
          attempted += 1;
          return true;
        }),
    );
    assert.equal(await Effect.runPromise(status.unavailable(host.serverId)), "offline");
    assert.equal(attempted, 0);
    assert.equal(hostedStartStep({ state: "stopped", error: null, fundingStatus: "revoked" }), null);
    checks.push("revocation during resume stops late runtime; no retention wake or client recovery while revoked");
  } finally {
    f.db.close();
  }
}

async function routineAndMissingVolume() {
  const f = fixture();
  try {
    const host = await Effect.runPromise(f.service.operatorCreate({ name: "Shared" }, KEY));
    await f.drain();
    assert.ok(f.provider.claim);
    const claim = await Effect.runPromise(f.service.redeemClaim(f.provider.claim));
    await Effect.runPromise(
      f.service.reportActivity(claim.sessionToken, host.serverId, {
        inUse: false,
        nextRunAt: f.provider.now + 30 * 60000,
      }),
    );
    f.provider.now += 16 * 60000;
    await Effect.runPromise(f.service.tick());
    await Effect.runPromise(f.service.tick());
    assert.equal(f.provider.droplet?.status, "off");
    f.provider.now += 5 * 60000;
    const scheduled = await Effect.runPromise(f.service.tick());
    assert.equal(scheduled.scheduled, 1);
    await Effect.runPromise(f.service.tick());
    assert.equal(f.provider.droplet?.status, "active");
    assert.equal(f.db.prepare("SELECT next_run_at FROM hosted_servers").get()?.next_run_at, null);
    f.provider.now += 16 * 60000;
    await Effect.runPromise(f.service.tick());
    await Effect.runPromise(f.service.tick());
    const actions = f.provider.actions.length;
    f.provider.now += 20 * 86400_000;
    await Effect.runPromise(f.service.tick());
    assert.equal(f.provider.actions.length, actions);
    assert.equal(f.provider.droplet?.status, "off");
    f.provider.volume = null;
    const missing = await Effect.runPromise(f.service.wake(OWNER, host.serverId));
    assert.equal(missing.state, "error");
    assert.equal(f.provider.calls.filter((call) => call === "POST /v2/volumes").length, 1);
    assert.equal(f.provider.calls.filter((call) => call === "POST /v2/droplets").length, 1);
    assert.equal(f.provider.droplet?.status, "off");
    checks.push("routine cold wake retains volume; long idle has no retention wake; missing volume fails closed");
  } finally {
    f.db.close();
  }
}

async function expiredAndRevokedClaim() {
  for (const expired of [false, true]) {
    const f = fixture();
    try {
      const host = await Effect.runPromise(f.service.operatorCreate({ name: "Shared" }, KEY));
      await f.drain();
      assert.ok(f.provider.claim);
      await Effect.runPromise(f.service.redeemClaim(f.provider.claim));
      if (expired) f.provider.now += 10 * 60000 + 1;
      else
        f.db
          .prepare(
            "UPDATE auth_sessions SET revoked_at = ? WHERE id = (SELECT auth_session_id FROM hosted_servers WHERE server_id = ?)",
          )
          .run(f.provider.now, host.serverId);
      await assert.rejects(Effect.runPromise(f.service.redeemClaim(f.provider.claim)));
      assert.equal(
        f.db.prepare("SELECT COUNT(*) AS total FROM auth_sessions WHERE id != 'signed-in-owner'").get()?.total,
        1,
      );
      if (!expired) {
        f.db.prepare("DELETE FROM auth_sessions WHERE id != 'signed-in-owner'").run();
        await assert.rejects(Effect.runPromise(f.service.redeemClaim(f.provider.claim)));
        assert.equal(
          f.db.prepare("SELECT COUNT(*) AS total FROM auth_sessions WHERE id != 'signed-in-owner'").get()?.total,
          0,
        );
      }
    } finally {
      f.db.close();
    }
  }
  checks.push(
    "claim replay recovers a lost response and concurrent redemption; expiry and revoked/deleted sessions never revive",
  );
}

async function deletionFailureReconciliation() {
  for (const mode of ["refused", "uncertain"] as const) {
    const f = fixture();
    try {
      const host = await Effect.runPromise(f.service.operatorCreate({ name: "Shared" }, KEY));
      await f.drain();
      f.provider.deleteFailure = mode;
      await Effect.runPromise(f.service.delete(OWNER, host.serverId, "Shared"));
      assert.ok(f.provider.droplet);
      await assert.rejects(
        Effect.runPromise(f.service.operatorCreate({ name: "Second" }, "organization-request-0002")),
      );
      await Effect.runPromise(f.service.tick());
      const deletes = f.provider.calls.filter((call) => call === "DELETE /v2/droplets/101").length;
      if (mode === "uncertain") {
        assert.equal(deletes, 1);
        assert.ok(f.provider.droplet);
        // An uncertain request completes later. Only inspection may confirm it.
        f.provider.droplet = null;
        if (f.provider.volume) f.provider.volume = { ...f.provider.volume, droplet_ids: [] };
      } else {
        assert.equal(deletes, 2);
        assert.equal(f.provider.droplet, null);
        const lastDelete = f.provider.calls.lastIndexOf("DELETE /v2/droplets/101");
        assert.equal(f.provider.calls[lastDelete - 1], "GET /v2/droplets/101");
      }
      await Effect.runPromise(f.service.tick());
      await Effect.runPromise(f.service.tick());
      assert.equal(f.provider.volume, null);
      assert.equal(f.provider.removeCount, 1);
      assert.equal(f.db.prepare("SELECT observed_state FROM hosted_servers").get()?.observed_state, "deleted");
    } finally {
      f.db.close();
    }
  }
  checks.push("definitive deletion refusal permits a newly inspected attempt; uncertain deletion is never replayed");
}

let passed = false;
try {
  await allocationAndAccess();
  await revokedBeforeProvisioning();
  await createRacesAndLostReply(false);
  await createRacesAndLostReply(true);
  await wakeRaceAndSchedules();
  await routineAndMissingVolume();
  await expiredAndRevokedClaim();
  await deletionFailureReconciliation();
  passed = true;
} finally {
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, "report.json"),
    `${JSON.stringify({ passed, checks, boundary: "Real HostedServerService and migrated SQLite; synthetic DigitalOcean transport only. No native durability or cloud proof." }, null, 2)}\n`,
  );
}
