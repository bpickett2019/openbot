/**
 * End-to-end check of Stripe plans and commercial licenses against the Stripe sandbox and an account Worker.
 * Each scenario gets its own account and a Stripe test clock, so renewals and period ends happen at once.
 * Server-plan fixtures are self-hosted Remote hosts. Subscription webhooks update billing without
 * provisioning provider resources.
 *
 *   bun scripts/stripe-flows-e2e.ts --api http://127.0.0.1:<port> [scenario ...]
 *
 * `stripe listen` must forward events to the Worker. The `portal` scenario prints two Customer Portal
 * pages and waits until someone uses them. The report goes to `.openbot-build/stripe-flows-e2e.json`.
 * `--checkout` pays the license Checkout page with a test card in local Chrome.
 * `--remote-d1` reads the D1 of the deployed `test` Worker; pass its origin as `--api`.
 *
 * The `license-*` scenarios check the commercial license: its tiered Price, Checkout, users, the count
 * of people on the owner's servers, renewal, currency, and that the server plans do not change. They need
 * `bun run api:stripe:bootstrap` to have made the license Price in the sandbox.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BILLING_CURRENCIES, type BillingPortalRequest, memberLimitForPlan } from "@openbot/contracts/billing";
import {
  LICENSE_PRICES,
  type LicenseCheckoutRequest,
  type LicenseRenewalRequest,
  type LicenseUsersRequest,
  licenseAmount,
} from "@openbot/contracts/license";
import { type Browser, chromium } from "playwright-core";
import { z } from "zod";
import { STRIPE_API_VERSION } from "../apps/auth-api/src/server/stripe-client";
import { developmentChildEnvironment, loadSharedDevelopmentEnvironment } from "./development-environment";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = join(ROOT, ".openbot-build", "stripe-flows-e2e.json");
const SCENARIOS = [
  "renewal",
  "failed-renewal",
  "cancel-at-period-end",
  "plan-change",
  "renew",
  "foreign",
  "customer-deleted",
  "refund",
  "dispute",
  "portal",
  "welcome",
  "license-buy",
  "license-checkout",
  "license-double-checkout",
  "license-users",
  "license-count",
  "license-renewal",
  "license-failed-renewal",
  "license-currency",
  "license-isolation",
  "license-limit",
] as const;
type Scenario = (typeof SCENARIOS)[number];
const DAY = 86_400;
/** `WELCOME_EMAIL_CLAIM_PREFIX` of `billing-service.ts`. That module needs the Worker types. */
const WELCOME_EMAIL_CLAIM_PREFIX = "openbot_welcome_email:";

const stepSchema = z.object({
  scenario: z.enum(SCENARIOS),
  step: z.string(),
  result: z.enum(["pass", "fail"]),
  evidence: z.unknown(),
});
type Step = z.infer<typeof stepSchema>;
const steps: Step[] = [];

const idSchema = z.object({ id: z.string() });
const clockSchema = z.object({ id: z.string(), status: z.string(), frozen_time: z.number() });
const subscriptionSchema = z.object({
  id: z.string(),
  status: z.string(),
  latest_invoice: z.string().nullable(),
  cancel_at_period_end: z.boolean(),
  cancel_at: z.number().nullable(),
  items: z.object({ data: z.array(z.object({ id: z.string() })) }),
});
const invoiceListSchema = z.object({
  data: z.array(
    z.object({ id: z.string(), billing_reason: z.string().nullable(), status: z.string(), amount_paid: z.number() }),
  ),
});
const checkoutSessionSchema = z.object({ status: z.string().nullable(), customer: z.string().nullable() });
const scheduleSchema = z.object({
  id: z.string(),
  phases: z.array(z.object({ start_date: z.number(), end_date: z.number() })),
});

const planSchema = z.object({
  subscriptionId: z.string(),
  plan: z.string(),
  interval: z.string(),
  status: z.string(),
  currentPeriodEnd: z.number().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});
type Plan = z.infer<typeof planSchema>;
const billingSchema = z.object({ servers: z.array(planSchema) });
const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const portalSchema = z.object({ url: z.string() });
const invoicePaymentsSchema = z.object({
  data: z.array(z.object({ payment: z.object({ payment_intent: z.string().nullable().optional() }) })),
});
const refundSchema = z.object({ id: z.string(), status: z.string() });
const disputeListSchema = z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })) });
const eventListSchema = z.object({
  data: z.array(z.object({ id: z.string(), data: z.object({ object: z.object({ id: z.string() }) }) })),
});
const factSchema = z.object({ source_key: z.string(), fact_type: z.string(), attributes_json: z.string() });
const licenseStateSchema = z.object({
  available: z.boolean(),
  currency: z.string().nullable(),
  license: z
    .object({
      subscriptionId: z.string(),
      users: z.number(),
      currency: z.string(),
      amount: z.number(),
      status: z.string(),
      currentPeriodEnd: z.number().nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  used: z.number(),
  users: z.array(
    z.object({ name: z.string().nullable(), email: z.string(), servers: z.array(z.string()), owner: z.boolean() }),
  ),
  coveredBy: z.array(z.object({ ownerName: z.string().nullable(), ownerEmail: z.string() })),
});
type LicenseView = z.infer<typeof licenseStateSchema>;
const licenseCheckoutSchema = z.object({ url: z.string() });
const tierSchema = z.object({
  up_to: z.number().nullable(),
  flat_amount: z.number().nullable(),
  unit_amount: z.number().nullable(),
});
const licensePriceSchema = z.object({
  id: z.string(),
  currency: z.string(),
  tiers_mode: z.string().nullable(),
  tiers: z.array(tierSchema).optional(),
  currency_options: z.record(z.string(), z.object({ tiers: z.array(tierSchema).optional() })).optional(),
});
const checkoutLinesSchema = z.object({
  status: z.string().nullable(),
  currency: z.string().nullable(),
  line_items: z.object({
    data: z.array(
      z.object({ quantity: z.number().nullable(), price: z.object({ lookup_key: z.string().nullable() }) }),
    ),
  }),
});

/** The request bodies of the browser API routes that this check calls. */
type BrowserApiBody =
  | BillingPortalRequest
  | LicenseCheckoutRequest
  | LicenseUsersRequest
  | LicenseRenewalRequest
  | { role: "member"; reactivate?: true }
  | { token: string }
  | Record<string, never>;

function print(line: string) {
  process.stdout.write(`${line}\n`);
}

function userId(scenario: Scenario): string {
  return `stripe-e2e-${scenario}`;
}

async function stripe<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  schema: z.ZodType<T>,
  params: Record<string, string> = {},
): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/u.test(key)) throw new Error("STRIPE_SECRET_KEY must be a test-mode key.");
  const body = new URLSearchParams(params).toString();
  const url = `https://api.stripe.com${path}${method === "GET" && body ? `?${body}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method === "POST" ? { body } : {}),
  });
  const value = z.unknown().parse(await response.json());
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string().optional() }) }).safeParse(value);
    throw new Error(`Stripe ${method} ${path} ${response.status}: ${error.data?.error.message ?? "unknown error"}`);
  }
  return schema.parse(value);
}

const d1ResultSchema = z.array(z.object({ results: z.array(z.unknown()) }));

/** `--remote-d1` reads the D1 of the deployed `test` Worker. Wrangler then uses its own sign-in, not the API token. */
const REMOTE_D1 = process.argv.includes("--remote-d1");
/** `--checkout` pays the license on the real Checkout page with a test card, in local Chrome. */
const REAL_CHECKOUT = process.argv.includes("--checkout");

function d1<T>(sql: string, schema: z.ZodType<T>): T[] {
  const target = REMOTE_D1 ? ["openbot-auth-test", "--remote", "--env", "test"] : ["openbot-auth", "--local"];
  const env = developmentChildEnvironment(process.env, "app");
  if (REMOTE_D1) delete env.CLOUDFLARE_API_TOKEN;
  const result = spawnSync(
    join(ROOT, "node_modules/.bin/wrangler"),
    ["d1", "execute", ...target, "--json", "--command", sql],
    { cwd: join(ROOT, "apps/auth-api"), encoding: "utf8", env },
  );
  if (result.status !== 0) {
    // spawnSync leaves stderr undefined when it cannot start wrangler. Report that error, not a TypeError.
    const detail = result.stderr?.slice(0, 400) || result.error?.message || `exit ${String(result.status)}`;
    throw new Error(`D1 failed: ${detail}`);
  }
  return d1ResultSchema
    .parse(JSON.parse(result.stdout))
    .flatMap((entry) => entry.results)
    .map((row) => schema.parse(row));
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

class Account {
  readonly token = randomBytes(24).toString("base64url");
  clock = "";
  customer = "";

  constructor(
    readonly scenario: Scenario,
    readonly api: string,
  ) {}

  get id() {
    return userId(this.scenario);
  }

  /** A fresh account with a session, a test clock and a customer that pays with a working card. */
  async setUp(): Promise<this> {
    const now = Date.now();
    const hash = createHash("sha256").update(this.token).digest("base64url");
    const id = quote(this.id);
    const hosted = d1(
      `SELECT server_id FROM hosted_servers WHERE owner_user_id = ${id}`,
      z.object({ server_id: z.string() }),
    );
    if (hosted.length > 0)
      throw new Error("This test account has hosted server records. Migrate them before this run.");
    d1(
      [
        `DELETE FROM billing_subscriptions WHERE user_id = ${id}`,
        `DELETE FROM licenses WHERE user_id = ${id}`,
        // The servers and members that a license scenario adds. Deleting a host deletes its memberships.
        `DELETE FROM remote_hosts WHERE host_id LIKE ${quote(`e2e-${this.scenario}-%`)}`,
        `DELETE FROM users WHERE id LIKE ${quote(`${this.id}-member-%`)}`,
        `DELETE FROM billing_customers WHERE user_id = ${id}`,
        `DELETE FROM auth_sessions WHERE user_id = ${id}`,
        `DELETE FROM billing_webhook_events WHERE event_id = ${quote(`${WELCOME_EMAIL_CLAIM_PREFIX}${this.id}`)}`,
        `INSERT OR IGNORE INTO users(id, identity_key, email, name, created_at, updated_at)
         VALUES (${id}, ${quote(`e2e:${this.id}`)}, ${quote(`${this.id}@example.com`)}, 'Stripe e2e', ${now}, ${now})`,
        `INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
         VALUES (${quote(crypto.randomUUID())}, ${id}, ${quote(hash)}, ${now + DAY * 1_000}, ${now}, ${now})`,
      ].join("; "),
      z.unknown(),
    );
    const clock = await stripe("POST", "/v1/test_helpers/test_clocks", idSchema, {
      frozen_time: String(Math.floor(now / 1_000)),
      name: `openbot ${this.scenario}`,
    });
    this.clock = clock.id;
    const customer = await stripe("POST", "/v1/customers", idSchema, {
      email: `${this.id}@example.com`,
      test_clock: this.clock,
      payment_method: "pm_card_visa",
      "invoice_settings[default_payment_method]": "pm_card_visa",
      "metadata[openbot_user_id]": this.id,
    });
    this.customer = customer.id;
    // The Worker makes a customer without a test clock, so the account gets this one before its first Checkout.
    d1(
      `INSERT INTO billing_customers(user_id, stripe_customer_id, created_at, updated_at)
       VALUES (${id}, ${quote(this.customer)}, ${now}, ${now})`,
      z.unknown(),
    );
    return this;
  }

  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: BrowserApiBody,
    headers: Record<string, string> = {},
    token = this.token,
  ) {
    const response = await fetch(`${this.api}/api/browser/${path}`, {
      method,
      headers: {
        Cookie: `__Host-openbot-web=${token}`,
        ...(method === "GET" ? {} : { Origin: this.api, "X-OpenBot-Browser": "1", "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = z.unknown().parse(await response.json().catch(() => null));
    return { status: response.status, body: value, code: errorSchema.safeParse(value).data?.error.code ?? null };
  }

  async createServer(name: string) {
    const serverId = `e2e-${this.scenario}-${crypto.randomUUID()}`;
    const now = Date.now();
    d1(
      `INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
       VALUES (${quote(serverId)}, ${quote(this.id)}, ${quote(name)}, ${now}, ${now});
       INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at)
       VALUES (${quote(crypto.randomUUID())}, ${quote(serverId)}, ${quote(this.id)}, 'owner', 'active', ${now}, ${now})`,
      z.unknown(),
    );
    return { server: { serverId } };
  }

  async tearDown() {
    d1(
      `DELETE FROM remote_hosts WHERE owner_user_id = ${quote(this.id)} AND host_id LIKE ${quote(`e2e-${this.scenario}-%`)}`,
      z.unknown(),
    );
  }

  async portal(flow: "cancel" | "update", subscriptionId: string) {
    const response = await this.request("POST", "v1/me/billing/portal", { flow, subscriptionId });
    return { status: response.status, url: portalSchema.safeParse(response.body).data?.url ?? null };
  }

  async billing() {
    return billingSchema.parse((await this.request("GET", "v1/me/billing")).body).servers;
  }

  async plan(subscriptionId: string): Promise<Plan | null> {
    return (await this.billing()).find((entry) => entry.subscriptionId === subscriptionId) ?? null;
  }

  async memberLimit(serverId: string) {
    const response = await this.request("GET", "v2/remote/hosts");
    const { hosts } = z
      .object({
        hosts: z.array(z.object({ hostId: z.string(), memberLimit: z.number() })),
      })
      .parse(response.body);
    return hosts.find((host) => host.hostId === serverId)?.memberLimit;
  }

  /** Starts a real Stripe subscription with the server metadata, as a paid Checkout does. */
  async pay(serverId: string) {
    const subscription = await stripe("POST", "/v1/subscriptions", idSchema, {
      customer: this.customer,
      "items[0][price]": await priceId("standard", "month"),
      currency: "eur",
      "metadata[openbot_user_id]": this.id,
      "metadata[openbot_server_id]": serverId,
      payment_behavior: "error_if_incomplete",
    });
    return subscription.id;
  }

  async useCard(card: string) {
    const attached = await stripe("POST", `/v1/payment_methods/${card}/attach`, idSchema, { customer: this.customer });
    await stripe("POST", `/v1/customers/${this.customer}`, idSchema, {
      "invoice_settings[default_payment_method]": attached.id,
    });
    return attached.id;
  }

  async license(): Promise<LicenseView> {
    return licenseStateSchema.parse((await this.request("GET", "v1/me/license")).body);
  }

  /**
   * Buys a license as a completed Checkout page does: a subscription of the license Price, with the
   * user count as its quantity and the license metadata.
   */
  async buyLicense(users: number, currency: "eur" | "usd" | "pln" = "eur") {
    const created = await stripe("POST", "/v1/subscriptions", idSchema, {
      customer: this.customer,
      "items[0][price]": await priceId("license", "month"),
      "items[0][quantity]": String(users),
      currency,
      "metadata[openbot_user_id]": this.id,
      "metadata[openbot_kind]": "license",
      payment_behavior: "error_if_incomplete",
    });
    return created.id;
  }

  /**
   * Adds servers that this account owns, with members. A member is a new account; `active: false` adds
   * a revoked membership. The same key on two servers is one person.
   */
  addServers(servers: { name: string; members: { key: string; active?: boolean }[] }[]) {
    const now = Date.now();
    const statements: string[] = [];
    const people = new Set<string>();
    servers.forEach((server, index) => {
      const hostId = `e2e-${this.scenario}-${index}`;
      statements.push(
        `INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
         VALUES (${quote(hostId)}, ${quote(this.id)}, ${quote(server.name)}, ${now}, ${now})`,
        // The owner's own membership. It must not count twice.
        `INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at)
         VALUES (${quote(crypto.randomUUID())}, ${quote(hostId)}, ${quote(this.id)}, 'owner', 'active', ${now}, ${now})`,
      );
      for (const member of server.members) {
        const memberId = this.memberId(member.key);
        if (!people.has(memberId)) {
          people.add(memberId);
          statements.push(
            `INSERT OR IGNORE INTO users(id, identity_key, email, name, created_at, updated_at)
             VALUES (${quote(memberId)}, ${quote(`e2e:${memberId}`)}, ${quote(`${memberId}@example.com`)},
                     ${quote(`Member ${member.key}`)}, ${now}, ${now})`,
          );
        }
        statements.push(
          `INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at)
           VALUES (${quote(crypto.randomUUID())}, ${quote(hostId)}, ${quote(memberId)}, 'member',
                   ${member.active === false ? "'revoked'" : "'active'"}, ${now}, ${now})`,
        );
      }
    });
    d1(statements.join("; "), z.unknown());
  }

  memberId(key: string) {
    return `${this.id}-member-${key}`;
  }

  /** A browser session of a member of this account's servers. A new key is a new account. */
  memberSession(key: string) {
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const memberId = this.memberId(key);
    d1(
      `INSERT OR IGNORE INTO users(id, identity_key, email, name, created_at, updated_at)
       VALUES (${quote(memberId)}, ${quote(`e2e:${memberId}`)}, ${quote(`${memberId}@example.com`)},
               ${quote(`Member ${key}`)}, ${now}, ${now});
       INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
       VALUES (${quote(crypto.randomUUID())}, ${quote(memberId)},
               ${quote(createHash("sha256").update(token).digest("base64url"))}, ${now + DAY * 1_000}, ${now}, ${now})`,
      z.unknown(),
    );
    return token;
  }

  /** The license state that a member of this account's servers sees. */
  async memberLicense(key: string): Promise<LicenseView> {
    return licenseStateSchema.parse(
      (await this.request("GET", "v1/me/license", undefined, {}, this.memberSession(key))).body,
    );
  }

  /** A member opens a new member invitation of the server at this `addServers` index. */
  async memberJoins(key: string, server: number) {
    const invite = await this.request("POST", `v2/remote/hosts/e2e-${this.scenario}-${server}/invites`, {
      role: "member",
    });
    const token = z.object({ token: z.string() }).parse(invite.body).token;
    return this.request("POST", "v2/remote/invites/accept", { token }, {}, this.memberSession(key));
  }

  /** Moves the test clock and waits until Stripe has run everything that the move made due. */
  async advance(days: number) {
    const clock = await stripe("GET", `/v1/test_helpers/test_clocks/${this.clock}`, clockSchema);
    const target = clock.frozen_time + days * DAY;
    await stripe("POST", `/v1/test_helpers/test_clocks/${this.clock}/advance`, clockSchema, {
      frozen_time: String(target),
    });
    await waitFor(
      `clock ${this.scenario} +${days}d`,
      async () => {
        const current = await stripe("GET", `/v1/test_helpers/test_clocks/${this.clock}`, clockSchema);
        return current.status === "ready";
      },
      180_000,
    );
    return target;
  }
}

/** Local Chrome for the optional license Checkout payment. */
let chrome: Promise<Browser> | null = null;
const browser = () => {
  chrome ??= chromium.launch({
    channel: "chrome",
    headless: true,
    env: Object.fromEntries(
      Object.entries(developmentChildEnvironment(process.env, "app")).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  return chrome;
};

/** Pays a Checkout page with the Stripe test card and waits for the return to the Worker. */
async function payCheckout(url: string, returnOrigin: string, screenshot: string) {
  const context = await (await browser()).newContext();
  try {
    const page = await context.newPage();
    await page.goto(url);
    try {
      // With more than one payment method, Checkout shows the card fields after the card choice.
      const card = page.getByRole("radio", { name: "Card", exact: true });
      await Promise.race([card.waitFor(), page.locator("#cardNumber").waitFor()]);
      if (await card.isVisible()) await card.check({ force: true });
      await page.fill("#cardNumber", "4242424242424242");
    } catch (error) {
      await page.screenshot({ path: join(ROOT, ".openbot-build", `failed-${screenshot}`), fullPage: true });
      throw error;
    }
    await page.fill("#cardExpiry", "12 / 34");
    await page.fill("#cardCvc", "123");
    await page.fill("#billingName", "Stripe E2E");
    const country = page.locator("#billingCountry");
    if (await country.count()) await country.selectOption("PL");
    const zip = page.locator("#billingPostalCode");
    if ((await zip.count()) && (await zip.isVisible())) await zip.fill("00-001");
    const save = page.locator("#enableStripePass");
    if ((await save.count()) && (await save.isChecked())) await save.dispatchEvent("click");
    await page.screenshot({ path: join(ROOT, ".openbot-build", screenshot) });
    await page.getByTestId("hosted-payment-submit-button").dispatchEvent("click");
    await page.waitForURL((current) => current.origin === returnOrigin, { timeout: 90_000 });
    return new URL(page.url()).pathname;
  } finally {
    await context.close();
  }
}

const priceIds = new Map<string, string>();
async function priceId(plan: string, interval: string): Promise<string> {
  const key = `openbot_${plan}_${interval}`;
  const cached = priceIds.get(key);
  if (cached) return cached;
  const list = await stripe("GET", "/v1/prices", z.object({ data: z.array(idSchema) }), {
    "lookup_keys[]": key,
    active: "true",
  });
  const id = list.data[0]?.id;
  if (!id) throw new Error(`No price ${key}`);
  priceIds.set(key, id);
  return id;
}

const subscription = (id: string) => stripe("GET", `/v1/subscriptions/${id}`, subscriptionSchema);

async function invoices(subscriptionId: string) {
  const list = await stripe("GET", "/v1/invoices", invoiceListSchema, { subscription: subscriptionId, limit: "10" });
  return list.data.map((invoice) => ({
    id: invoice.id,
    reason: invoice.billing_reason,
    status: invoice.status,
    amount: invoice.amount_paid,
  }));
}

/** The PaymentIntent that paid the latest invoice of the plan. */
async function paymentIntent(subscriptionId: string) {
  const invoice = (await subscription(subscriptionId)).latest_invoice;
  if (!invoice) throw new Error("No invoice");
  const payments = await stripe("GET", "/v1/invoice_payments", invoicePaymentsSchema, { invoice });
  const intent = payments.data[0]?.payment.payment_intent;
  if (!intent) throw new Error("The invoice has no PaymentIntent");
  return { invoice, intent };
}

/** Waits until Stripe sent the event of this type about this object and the Worker applied it. */
async function applied(type: string, objectId: string, timeoutMs = 120_000) {
  // A test refund fails about two minutes after Stripe accepts it.
  const event = await waitFor(
    `${type} ${objectId}`,
    async () => {
      const list = await stripe("GET", "/v1/events", eventListSchema, { type, limit: "20" });
      return list.data.find((entry) => entry.data.object.id === objectId) ?? null;
    },
    timeoutMs,
  );
  await waitFor(
    `Worker applied ${event.id}`,
    async () =>
      d1(`SELECT 1 AS seen FROM billing_webhook_events WHERE event_id = ${quote(event.id)}`, z.unknown()).length > 0,
    timeoutMs,
  );
  return event.id;
}

/** The sales facts of an invoice. The Worker records them only when OpenPanel is set. */
function facts(invoiceId: string) {
  return d1(
    `SELECT source_key, fact_type, attributes_json FROM billing_sales_facts
     WHERE invoice_id = ${quote(invoiceId)} ORDER BY event_timestamp, source_key`,
    factSchema,
  );
}

/** True when the Worker records sales facts: the paid invoice gets its fact soon after the payment. */
async function recordsSales(invoiceId: string) {
  return waitFor(
    "payment fact",
    async () => facts(invoiceId).some((fact) => fact.fact_type === "payment_succeeded"),
    20_000,
  ).catch(() => false);
}

async function waitFor<T>(label: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
      last = String(value);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_500);
  }
  throw new Error(`Timed out: ${label} (last: ${last})`);
}

function record(scenario: Scenario, step: string, pass: boolean, evidence: unknown) {
  steps.push({ scenario, step, result: pass ? "pass" : "fail", evidence });
  print(`${pass ? "PASS" : "FAIL"} [${scenario}] ${step}`);
}

/** The claim that the Worker records when it sends the welcome email of an account. */
function welcomeClaims(account: Account) {
  return d1(
    `SELECT event_id, type, received_at FROM billing_webhook_events
     WHERE event_id = ${quote(`${WELCOME_EMAIL_CLAIM_PREFIX}${account.id}`)}`,
    welcomeClaimSchema,
  );
}

function planWhere(
  account: Account,
  subscriptionId: string,
  label: string,
  test: (plan: Plan) => boolean,
  timeoutMs?: number,
) {
  return waitFor(
    label,
    async () => {
      const plan = await account.plan(subscriptionId);
      return plan && test(plan) ? plan : null;
    },
    timeoutMs,
  );
}

const welcomeClaimSchema = z.object({ event_id: z.string(), type: z.string(), received_at: z.number() });

function licenseWhere(account: Account, label: string, test: (state: LicenseView) => boolean, timeoutMs?: number) {
  return waitFor(
    label,
    async () => {
      const state = await account.license();
      return test(state) ? state : null;
    },
    timeoutMs,
  );
}

/** The license rows in `billing_subscriptions`. There must be none: a license has its own table. */
function licenseInPlans(subscriptionId: string) {
  return d1(
    `SELECT stripe_subscription_id FROM billing_subscriptions WHERE stripe_subscription_id = ${quote(subscriptionId)}`,
    z.unknown(),
  ).length;
}

/** The Checkout Session ID in a Checkout page URL. */
function checkoutSessionId(url: string) {
  const id = /\/(cs_test_[A-Za-z0-9]+)/u.exec(url)?.[1];
  if (!id) throw new Error("No Checkout Session ID in the URL");
  return id;
}

const openSessionsSchema = z.object({
  data: z.array(z.object({ id: z.string(), metadata: z.record(z.string(), z.string()).nullable() })),
});

/** The open license Checkout pages of the account's customer. */
async function openLicensePages(account: Account) {
  const listed = await stripe("GET", "/v1/checkout/sessions", openSessionsSchema, {
    customer: account.customer,
    status: "open",
    limit: "100",
  });
  return listed.data.filter((session) => session.metadata?.openbot_kind === "license").map((session) => session.id);
}

async function expireCheckout(url: string) {
  await stripe("POST", `/v1/checkout/sessions/${checkoutSessionId(url)}/expire`, idSchema).catch(() => null);
}

/** The amount of the latest invoice of a subscription. */
async function latestInvoiceAmount(subscriptionId: string) {
  return (await invoices(subscriptionId))[0]?.amount ?? null;
}

const scenarios: Record<Scenario, (account: Account) => Promise<void>> = {
  async renewal(account) {
    const { server } = await account.createServer("Renewal");
    const sub = await account.pay(server.serverId);
    const before = await planWhere(account, sub, "plan", () => true);
    record(
      "renewal",
      "payment opens the plan and grants its member limit",
      before.status === "active" && (await account.memberLimit(server.serverId)) === memberLimitForPlan("standard"),
      before,
    );
    await account.advance(32);
    const after = await planWhere(
      account,
      sub,
      "renewed period",
      (plan) => (plan.currentPeriodEnd ?? 0) > (before.currentPeriodEnd ?? 0),
    );
    record("renewal", "a paid renewal moves the period end and keeps the plan active", after.status === "active", {
      before: before.currentPeriodEnd,
      after: after.currentPeriodEnd,
      status: after.status,
    });
  },

  async "failed-renewal"(account) {
    const { server } = await account.createServer("Failed renewal");
    const sub = await account.pay(server.serverId);
    const before = await planWhere(account, sub, "plan", () => true);
    await account.useCard("pm_card_chargeCustomerFail");
    const renewalAt = await account.advance(32);
    const pastDue = await planWhere(account, sub, "past_due", (plan) => plan.status === "past_due");
    record(
      "failed-renewal",
      "a failed renewal makes the plan past_due while Stripe retries",
      pastDue.status === "past_due",
      {
        periodEndBefore: before.currentPeriodEnd,
        periodEndAfterFailure: pastDue.currentPeriodEnd,
        renewalAt: renewalAt * 1_000,
      },
    );
    // The user pays the open invoice with a working card, as in the Customer Portal.
    const good = await account.useCard("pm_card_visa");
    const current = await subscription(sub);
    if (!current.latest_invoice) throw new Error("No open invoice");
    await stripe("POST", `/v1/invoices/${current.latest_invoice}/pay`, idSchema, { payment_method: good });
    const recovered = await planWhere(account, sub, "active again", (plan) => plan.status === "active");
    record("failed-renewal", "paying the open invoice makes the plan active again", true, recovered);
    // Now the renewal fails until Stripe gives up.
    await account.useCard("pm_card_chargeCustomerFail");
    const statuses: { afterDays: number; stripeStatus: string }[] = [];
    let final: string | null = null;
    for (let days = 32; days <= 92 && !final; days += 15) {
      await account.advance(days === 32 ? 32 : 15);
      await sleep(4_000);
      const stripeStatus = (await subscription(sub)).status;
      statuses.push({ afterDays: days, stripeStatus });
      if (stripeStatus === "canceled" || stripeStatus === "unpaid") final = stripeStatus;
    }
    const ended =
      final === "unpaid"
        ? await planWhere(account, sub, "unpaid plan", (plan) => plan.status === "unpaid")
        : final === "canceled"
          ? await waitFor("canceled plan hidden", async () => !(await account.plan(sub)))
          : null;
    record("failed-renewal", "when Stripe stops the retries, billing records the terminal state", ended !== null, {
      statuses,
      final,
      ended,
    });
  },

  async "cancel-at-period-end"(account) {
    const { server } = await account.createServer("Cancel later");
    const sub = await account.pay(server.serverId);
    await planWhere(account, sub, "plan", () => true);
    const portal = await account.portal("cancel", sub);
    record("cancel-at-period-end", "the Worker gives a Portal cancel page", portal.status === 200, {
      host: portal.url ? new URL(portal.url).host : null,
    });
    // The Portal with mode `at_period_end` makes the same change.
    await stripe("POST", `/v1/subscriptions/${sub}`, idSchema, { cancel_at_period_end: "true" });
    const cancelling = await planWhere(account, sub, "cancelAtPeriodEnd", (plan) => plan.cancelAtPeriodEnd);
    record(
      "cancel-at-period-end",
      "cancel at period end: the active plan shows the end date",
      cancelling.status === "active" && cancelling.currentPeriodEnd !== null,
      cancelling,
    );
    await stripe("POST", `/v1/subscriptions/${sub}`, idSchema, { cancel_at_period_end: "false" });
    const undone = await planWhere(account, sub, "undo", (plan) => !plan.cancelAtPeriodEnd);
    record("cancel-at-period-end", "undo the cancel: the plan continues", undone.status === "active", undone);
    // A cancel at a set time, as the Portal can store it, shows the same as a cancel at the period end.
    await stripe("POST", `/v1/subscriptions/${sub}`, idSchema, {
      cancel_at: String((undone.currentPeriodEnd ?? 0) / 1_000),
    });
    const scheduled = await planWhere(account, sub, "cancel_at", (plan) => plan.cancelAtPeriodEnd);
    record("cancel-at-period-end", "a cancel with `cancel_at` also shows the end date", true, scheduled);
    await account.advance(32);
    await waitFor("canceled plan hidden", async () => !(await account.plan(sub)));
    record(
      "cancel-at-period-end",
      "at the period end the canceled plan leaves the open billing state",
      (await subscription(sub)).status === "canceled",
      { stripeStatus: (await subscription(sub)).status, billingPlans: await account.billing() },
    );
  },

  async "plan-change"(account) {
    const { server } = await account.createServer("Plan change");
    const sub = await account.pay(server.serverId);
    await planWhere(account, sub, "plan", () => true);
    const item = (await subscription(sub)).items.data[0]?.id;
    if (!item) throw new Error("No subscription item");
    // The Portal upgrade: a higher price now, charged now (`always_invoice`).
    await stripe("POST", `/v1/subscriptions/${sub}`, idSchema, {
      "items[0][id]": item,
      "items[0][price]": await priceId("pro", "month"),
      proration_behavior: "always_invoice",
    });
    const upgraded = await planWhere(account, sub, "pro", (plan) => plan.plan === "pro");
    record(
      "plan-change",
      "upgrade to Pro: the server plan follows; the prorated amount is invoiced at once",
      upgraded.plan === "pro" && (await account.memberLimit(server.serverId)) === memberLimitForPlan("pro"),
      { plan: upgraded, invoices: await invoices(sub) },
    );
    await stripe("POST", `/v1/subscriptions/${sub}`, idSchema, {
      "items[0][id]": item,
      "items[0][price]": await priceId("pro", "year"),
      proration_behavior: "always_invoice",
    });
    const yearly = await planWhere(account, sub, "yearly", (plan) => plan.interval === "year");
    record("plan-change", "month to year: the billing interval follows", yearly.plan === "pro", yearly);
    // The Portal downgrade: a schedule changes the price at the period end.
    const schedule = await stripe("POST", "/v1/subscription_schedules", scheduleSchema, { from_subscription: sub });
    const phase = schedule.phases[0];
    if (!phase) throw new Error("No schedule phase");
    await stripe("POST", `/v1/subscription_schedules/${schedule.id}`, idSchema, {
      "phases[0][items][0][price]": await priceId("pro", "year"),
      "phases[0][start_date]": String(phase.start_date),
      "phases[0][end_date]": String(phase.end_date),
      "phases[1][items][0][price]": await priceId("standard", "year"),
      end_behavior: "release",
    });
    const beforeEnd = await account.plan(sub);
    record(
      "plan-change",
      "a downgrade waits for the period end: the server stays Pro",
      beforeEnd?.plan === "pro",
      beforeEnd,
    );
    await account.advance(370);
    const downgraded = await planWhere(account, sub, "standard", (plan) => plan.plan === "standard", 120_000);
    record(
      "plan-change",
      "after the period end the plan is Standard and stays active",
      downgraded.status === "active",
      downgraded,
    );
  },

  async renew(account) {
    const { server } = await account.createServer("Renew plan");
    const sub = await account.pay(server.serverId);
    await planWhere(account, sub, "plan", () => true);
    await stripe("DELETE", `/v1/subscriptions/${sub}`, idSchema);
    await waitFor("canceled plan hidden", async () => !(await account.plan(sub)));
    record(
      "renew",
      "a canceled plan leaves the open billing state",
      (await account.plan(sub)) === null,
      await account.billing(),
    );
    const replacement = await account.pay(server.serverId);
    const renewed = await planWhere(account, replacement, "replacement active", (plan) => plan.status === "active");
    record("renew", "a replacement subscription restores the server plan", renewed.subscriptionId !== sub, renewed);
  },

  async foreign(account) {
    const victim = await new Account("renewal", account.api).setUp();
    const { server } = await victim.createServer("Victim");
    const sub = await account.pay(server.serverId);
    await planWhere(account, sub, "foreign plan stored", () => true);
    const memberLimit = await victim.memberLimit(server.serverId);
    const stored = d1(
      `SELECT user_id, server_id, status FROM billing_subscriptions WHERE stripe_subscription_id = ${quote(sub)}`,
      z.unknown(),
    );
    record(
      "foreign",
      "a subscription whose metadata names another account's server gives that server nothing",
      memberLimit === memberLimitForPlan(null) && (await victim.billing()).length === 0,
      { memberLimit, stored },
    );
    await stripe("DELETE", `/v1/subscriptions/${sub}`, idSchema);
    await victim.tearDown();
    await stripe("DELETE", `/v1/test_helpers/test_clocks/${victim.clock}`, idSchema).catch(() => null);
  },

  /** The real Customer Portal pages: a person (or Playwright) uses the printed pages while this waits. */
  async portal(account) {
    const { server } = await account.createServer("Portal");
    const sub = await account.pay(server.serverId);
    await planWhere(account, sub, "plan", () => true);
    print(`PORTAL_CANCEL ${(await account.portal("cancel", sub)).url}`);
    const cancelled = await waitFor(
      "Portal cancel",
      async () => {
        const plan = await account.plan(sub);
        return plan?.cancelAtPeriodEnd ? plan : null;
      },
      600_000,
    );
    const stored = await subscription(sub);
    record(
      "portal",
      "Portal cancel: the plan shows the end date",
      cancelled.status === "active" && cancelled.currentPeriodEnd !== null,
      { plan: cancelled, stripe: { cancel_at_period_end: stored.cancel_at_period_end, cancel_at: stored.cancel_at } },
    );
    await stripe(
      "POST",
      `/v1/subscriptions/${sub}`,
      idSchema,
      stored.cancel_at_period_end ? { cancel_at_period_end: "false" } : { cancel_at: "" },
    );
    await planWhere(account, sub, "undo", (plan) => !plan.cancelAtPeriodEnd);
    print(`PORTAL_UPDATE ${(await account.portal("update", sub)).url}`);
    const upgraded = await planWhere(account, sub, "Portal upgrade", (plan) => plan.plan !== "standard", 600_000);
    record("portal", "Portal plan change: the server plan follows, and an upgrade is invoiced at once", true, {
      plan: upgraded,
      invoices: await invoices(sub),
    });
  },

  async "customer-deleted"(account) {
    const old = account.customer;
    await stripe("DELETE", `/v1/customers/${old}`, idSchema);
    const created = await account.request("POST", "v1/me/license/checkout", { users: 5, currency: "eur" });
    const { url } = licenseCheckoutSchema.parse(created.body);
    const [stored] = d1(
      `SELECT stripe_customer_id FROM billing_customers WHERE user_id = ${quote(account.id)}`,
      z.object({ stripe_customer_id: z.string() }),
    );
    const page = await stripe("GET", `/v1/checkout/sessions/${checkoutSessionId(url)}`, checkoutSessionSchema);
    record(
      "customer-deleted",
      "a customer deleted in Stripe: the next Checkout uses a new customer",
      created.status === 200 && stored?.stripe_customer_id !== old && page.customer === stored?.stripe_customer_id,
      { oldReplaced: stored?.stripe_customer_id !== old },
    );
    await expireCheckout(url);
  },
  async refund(account) {
    // A partial refund keeps the plan. The second refund makes the payment refunded in full and ends it.
    const { server } = await account.createServer("Refund");
    const sub = await account.pay(server.serverId);
    await planWhere(account, sub, "plan", () => true);
    const paid = await paymentIntent(sub);
    const sales = await recordsSales(paid.invoice);
    const partial = await stripe("POST", "/v1/refunds", refundSchema, { payment_intent: paid.intent, amount: "100" });
    await applied("refund.created", partial.id);
    const plan = await account.plan(sub);
    record("refund", "a partial refund keeps the plan active", plan?.status === "active", {
      refund: partial.status,
      plan,
    });
    const rest = await stripe("POST", "/v1/refunds", refundSchema, { payment_intent: paid.intent });
    await applied("refund.created", rest.id);
    await waitFor("refunded plan hidden", async () => !(await account.plan(sub)));
    const stripeSub = await subscription(sub);
    record("refund", "a full refund of the current invoice cancels the plan now", stripeSub.status === "canceled", {
      refund: rest.status,
      stripeStatus: stripeSub.status,
      plans: await account.billing(),
    });
    if (sales) {
      const recorded = facts(paid.invoice);
      record(
        "refund",
        "each refund is a payment_refunded sales fact",
        recorded.some((fact) => fact.source_key === `refund:${partial.id}:succeeded`) &&
          recorded.some((fact) => fact.source_key === `refund:${rest.id}:succeeded`),
        recorded,
      );
    } else {
      print("SKIP [refund] sales facts: the Worker has no OpenPanel client");
    }
    // This test card makes the refund fail after Stripe accepts it. The refund is partial, so the plan stays.
    const second = await account.createServer("Refund fails");
    await account.useCard("pm_card_refundFail");
    const secondSub = await account.pay(second.server.serverId);
    await planWhere(account, secondSub, "plan", () => true);
    const secondPaid = await paymentIntent(secondSub);
    const failing = await stripe("POST", "/v1/refunds", refundSchema, {
      payment_intent: secondPaid.intent,
      amount: "100",
    });
    await applied("refund.failed", failing.id, 180_000);
    const failedPlan = await account.plan(secondSub);
    record("refund", "a failed refund keeps the plan active", failedPlan?.status === "active", { plan: failedPlan });
    if (sales) {
      const recorded = facts(secondPaid.invoice);
      // Stripe says this refund starts as succeeded, so both facts exist; the order of their events can vary.
      record(
        "refund",
        "a failed refund is a refund_failed fact",
        recorded.some((fact) => fact.source_key === `refund:${failing.id}:failed`),
        recorded,
      );
    }
  },

  async dispute(account) {
    const { server } = await account.createServer("Dispute");
    // This test card makes the issuer open a dispute soon after the payment.
    await account.useCard("pm_card_createDispute");
    const sub = await account.pay(server.serverId);
    const paid = await paymentIntent(sub);
    const sales = await recordsSales(paid.invoice);
    const disputed = await waitFor("dispute", async () => {
      const list = await stripe("GET", "/v1/disputes", disputeListSchema, { payment_intent: paid.intent });
      return list.data[0] ?? null;
    });
    await applied("charge.dispute.created", disputed.id);
    await waitFor("disputed plan hidden", async () => !(await account.plan(sub)));
    const stripeSub = await subscription(sub);
    record("dispute", "a dispute cancels the plan now", stripeSub.status === "canceled", {
      dispute: disputed.status,
      stripeStatus: stripeSub.status,
      plans: await account.billing(),
    });
    // This evidence text makes the test dispute close as lost.
    await stripe("POST", `/v1/disputes/${disputed.id}`, idSchema, {
      "evidence[uncategorized_text]": "losing_evidence",
      submit: "true",
    });
    await applied("charge.dispute.closed", disputed.id, 180_000);
    if (sales) {
      const recorded = facts(paid.invoice);
      record(
        "dispute",
        "the dispute and its loss are payment_disputed and dispute_lost facts",
        recorded.some((fact) => fact.source_key === `dispute:${disputed.id}:created`) &&
          recorded.some((fact) => fact.source_key === `dispute:${disputed.id}:lost`),
        recorded,
      );
    } else {
      print("SKIP [dispute] sales facts: the Worker has no OpenPanel client");
    }
  },

  // The first server plan claims the welcome once, before the optional hosted-server email send.
  async welcome(account) {
    const first = await account.createServer("Welcome");
    record("welcome", "a server that is not paid gets no welcome email", welcomeClaims(account).length === 0, null);
    const sub = await account.pay(first.server.serverId);
    await applied("customer.subscription.created", sub);
    const claimed = await waitFor("welcome claim", async () => welcomeClaims(account)[0]);
    record(
      "welcome",
      "the first plan of the account claims the welcome email",
      claimed.type === "welcome_email",
      claimed,
    );
    const second = await account.createServer("Welcome second");
    const secondSub = await account.pay(second.server.serverId);
    await applied("customer.subscription.created", secondSub);
    await stripe("DELETE", `/v1/subscriptions/${sub}`, idSchema);
    await waitFor("canceled plan hidden", async () => !(await account.plan(sub)));
    const renewed = await account.pay(first.server.serverId);
    await applied("customer.subscription.created", renewed);
    const claims = welcomeClaims(account);
    record(
      "welcome",
      "a second server and a renewed plan do not replace the first welcome claim",
      claims.length === 1 && claims[0]?.received_at === claimed.received_at,
      claims,
    );
  },
  async "license-buy"(account) {
    const price = await stripe("GET", `/v1/prices/${await priceId("license", "month")}`, licensePriceSchema, {
      "expand[0]": "tiers",
      "expand[1]": "currency_options.usd.tiers",
      "expand[2]": "currency_options.pln.tiers",
    });
    const tiers = {
      eur: price.tiers,
      usd: price.currency_options?.usd?.tiers,
      pln: price.currency_options?.pln?.tiers,
    };
    record(
      "license-buy",
      "the license Price is graduated, with the base and extra-user tiers of LICENSE_PRICES in EUR, USD and PLN",
      price.currency === "eur" &&
        price.tiers_mode === "graduated" &&
        BILLING_CURRENCIES.every((currency) => {
          const amounts = LICENSE_PRICES[currency];
          const [base, extra] = tiers[currency] ?? [];
          return (
            base?.up_to === 5 &&
            base.flat_amount === amounts.base &&
            (base.unit_amount ?? 0) === 0 &&
            extra?.up_to === null &&
            extra.unit_amount === amounts.extraUser
          );
        }),
      tiers,
    );
    const before = await account.license();
    record(
      "license-buy",
      "an account with no license sees an available license and nothing to pay",
      before.available && before.license === null && before.used === 1,
      before,
    );
    const sub = await account.buyLicense(7);
    const bought = await licenseWhere(account, "license active", (state) => state.license?.status === "active");
    record(
      "license-buy",
      "7 users in EUR: the license shows 7 users and the list price €130",
      bought.license?.users === 7 &&
        bought.license.currency === "eur" &&
        bought.license.amount === licenseAmount(7, "eur") &&
        bought.currency === "eur",
      bought,
    );
    record(
      "license-buy",
      "Stripe charged the tiered amount for 7 users",
      (await latestInvoiceAmount(sub)) === licenseAmount(7, "eur"),
      await invoices(sub),
    );
    const plans = await account.billing();
    record(
      "license-buy",
      "the server plans do not show the license, and billing_subscriptions has no license row",
      plans.length === 0 && licenseInPlans(sub) === 0,
      { plans },
    );
    record(
      "license-buy",
      "a license is not a first server plan: no welcome email",
      welcomeClaims(account).length === 0,
      {
        claims: welcomeClaims(account),
      },
    );
  },

  async "license-checkout"(account) {
    const opened = await account.request("POST", "v1/me/license/checkout", { users: 7, currency: "eur" });
    const url = licenseCheckoutSchema.safeParse(opened.body).data?.url ?? "";
    const session = url
      ? await stripe("GET", `/v1/checkout/sessions/${checkoutSessionId(url)}`, checkoutLinesSchema, {
          "expand[0]": "line_items",
          "expand[1]": "line_items.data.price",
        })
      : null;
    const line = session?.line_items.data[0];
    record(
      "license-checkout",
      "the Worker gives a checkout.stripe.com page for the license Price with quantity 7 in EUR",
      opened.status === 200 &&
        new URL(url).host === "checkout.stripe.com" &&
        line?.quantity === 7 &&
        line.price.lookup_key === "openbot_license_month" &&
        session?.currency === "eur",
      { status: opened.status, code: opened.code, session: session && { status: session.status, line } },
    );
    if (REAL_CHECKOUT) {
      const returned = await payCheckout(url, account.api, "license-e2e-checkout.png");
      const paid = await licenseWhere(account, "license paid", (state) => state.license?.status === "active", 120_000);
      record(
        "license-checkout",
        "the paid Checkout page makes an active license of 7 users",
        paid.license?.users === 7,
        {
          returned,
          license: paid.license,
        },
      );
    } else {
      await expireCheckout(url);
      await account.buyLicense(7);
      await licenseWhere(account, "license active", (state) => state.license?.status === "active");
    }
    const second = await account.request("POST", "v1/me/license/checkout", { users: 5, currency: "eur" });
    record("license-checkout", "a second license: 409 license_exists", second.status === 409, {
      status: second.status,
      code: second.code,
    });
    const tooMany = await account.request("POST", "v1/me/license/checkout", { users: 26, currency: "eur" });
    const tooFew = await account.request("POST", "v1/me/license/checkout", { users: 4, currency: "eur" });
    record(
      "license-checkout",
      "26 or 4 users: 400, because the app sells 5 to 25",
      tooMany.status === 400 && tooFew.status === 400,
      { tooMany: tooMany.code, tooFew: tooFew.code },
    );
  },

  async "license-double-checkout"(account) {
    const body = { users: 5, currency: "eur" } as const;
    const pair = await Promise.all([
      account.request("POST", "v1/me/license/checkout", body),
      account.request("POST", "v1/me/license/checkout", body),
    ]);
    const third = await account.request("POST", "v1/me/license/checkout", body);
    const urls = [...pair, third].map((response) => licenseCheckoutSchema.safeParse(response.body).data?.url ?? "");
    const open = await openLicensePages(account);
    record(
      "license-double-checkout",
      "two requests at once and a third one leave one open license page, the page of the last response",
      [...pair, third].every((response) => response.status === 200) &&
        open.length === 1 &&
        urls[2] !== "" &&
        open[0] === checkoutSessionId(urls[2] ?? ""),
      {
        statuses: [...pair, third].map((response) => response.status),
        sameConcurrentPage: urls[0] === urls[1],
        returned: urls.map((url) => (url ? checkoutSessionId(url) : null)),
        open,
      },
    );

    // A license that Stripe has but D1 does not, as before its webhook arrives.
    const sub = await account.buyLicense(5);
    await licenseWhere(account, "license active", (state) => state.license?.status === "active");
    d1(`DELETE FROM licenses WHERE user_id = ${quote(account.id)}`, z.unknown());
    const before = d1(`SELECT stripe_subscription_id FROM licenses WHERE user_id = ${quote(account.id)}`, z.unknown());
    const refused = await account.request("POST", "v1/me/license/checkout", body);
    const after = await account.license();
    const left = await openLicensePages(account);
    record(
      "license-double-checkout",
      "a license in Stripe but not in D1: 409 license_exists, no open license page, and D1 has the license again",
      before.length === 0 &&
        refused.status === 409 &&
        refused.code === "license_exists" &&
        left.length === 0 &&
        after.license?.subscriptionId === sub,
      { rowsBefore: before.length, status: refused.status, code: refused.code, open: left, license: after.license },
    );
  },

  async "license-users"(account) {
    // 6 members on one server: the license counts 7 people with the owner.
    account.addServers([{ name: "Office", members: ["a", "b", "c", "d", "e", "f"].map((key) => ({ key })) }]);
    const sub = await account.buyLicense(9);
    await licenseWhere(account, "license active", (state) => state.license?.users === 9);
    const invoicesBefore = (await invoices(sub)).length;
    const more = await account.request("POST", "v1/me/license/users", { users: 11 });
    const moreInvoices = await invoices(sub);
    record(
      "license-users",
      "9 → 11 users: the license shows 11, and Stripe invoices and charges the prorated amount at once",
      more.status === 200 &&
        licenseStateSchema.parse(more.body).license?.users === 11 &&
        moreInvoices.length === invoicesBefore + 1 &&
        moreInvoices[0]?.reason === "subscription_update" &&
        moreInvoices[0].status === "paid" &&
        moreInvoices[0].amount > 0,
      { status: more.status, invoices: moreInvoices },
    );
    const fewer = await account.request("POST", "v1/me/license/users", { users: 8 });
    const fewerInvoices = await invoices(sub);
    const item = await stripe(
      "GET",
      `/v1/subscriptions/${sub}`,
      z.object({ items: z.object({ data: z.array(z.object({ quantity: z.number() })) }) }),
    );
    record(
      "license-users",
      "11 → 8 users: no new invoice and no refund; the Stripe quantity is 8 for the next invoice",
      fewer.status === 200 && fewerInvoices.length === moreInvoices.length && item.items.data[0]?.quantity === 8,
      { status: fewer.status, invoices: fewerInvoices, quantity: item.items.data[0]?.quantity },
    );
    const inUse = await account.request("POST", "v1/me/license/users", { users: 6 });
    record("license-users", "6 users while 7 people use it: 409 license_users_in_use", inUse.status === 409, {
      status: inUse.status,
      code: inUse.code,
    });
    const over = await account.request("POST", "v1/me/license/users", { users: 26 });
    record("license-users", "26 users: 400", over.status === 400, { status: over.status, code: over.code });
    await account.useCard("pm_card_chargeCustomerFail");
    const declined = await account.request("POST", "v1/me/license/users", { users: 12 });
    const after = await account.license();
    record(
      "license-users",
      "an increase with a failing card: 402 license_payment_failed, and the license keeps 8 users",
      declined.status === 402 && declined.code === "license_payment_failed" && after.license?.users === 8,
      { status: declined.status, code: declined.code, users: after.license?.users },
    );
    await account.useCard("pm_card_visa");
    const paidBack = await account.request("POST", "v1/me/license/users", { users: 10 });
    const paidBackInvoices = await invoices(sub);
    record(
      "license-users",
      "8 → 10 users in the period that paid for 11: no new invoice",
      paidBack.status === 200 && paidBackInvoices.length === moreInvoices.length,
      { status: paidBack.status, invoices: paidBackInvoices },
    );
    const extra = await account.request("POST", "v1/me/license/users", { users: 12 });
    const extraInvoices = await invoices(sub);
    record(
      "license-users",
      "10 → 12 users: one paid invoice for the 12th user only, less than the 9 → 11 invoice",
      extra.status === 200 &&
        licenseStateSchema.parse(extra.body).license?.users === 12 &&
        extraInvoices.length === paidBackInvoices.length + 1 &&
        extraInvoices[0]?.status === "paid" &&
        extraInvoices[0].amount > 0 &&
        extraInvoices[0].amount < (moreInvoices[0]?.amount ?? 0),
      { status: extra.status, invoices: extraInvoices },
    );
  },

  async "license-limit"(account) {
    // Servers with no plan take 3 active members, so each has the owner and one member: the license
    // stops a join before the member limit does. The owner and a, b, c, lab use all 5 users.
    account.addServers([
      { name: "Office", members: [{ key: "a" }] },
      { name: "Studio", members: [{ key: "b" }, { key: "gone", active: false }] },
      { name: "Shop", members: [{ key: "c" }] },
      { name: "Lab", members: [{ key: "lab" }] },
    ]);
    await account.buyLicense(5);
    await licenseWhere(account, "license active", (state) => state.license?.users === 5 && state.used === 5);
    const refused = await account.memberJoins("new", 0);
    record(
      "license-limit",
      "5 of 5 users: a new person cannot join, 409 license_users_full",
      refused.status === 409 && refused.code === "license_users_full",
      { status: refused.status, code: refused.code },
    );
    const counted = await account.memberJoins("lab", 0);
    record("license-limit", "5 of 5 users: a member of another server of the owner joins", counted.status === 200, {
      status: counted.status,
      code: counted.code,
    });
    const [gone] = d1(
      `SELECT membership_id FROM remote_memberships
        WHERE host_id = ${quote(`e2e-${account.scenario}-1`)} AND user_id = ${quote(account.memberId("gone"))}`,
      z.object({ membership_id: z.string() }),
    );
    const reactivate = () =>
      account.request("PATCH", `v2/remote/hosts/e2e-${account.scenario}-1/members/${gone?.membership_id}`, {
        role: "member",
        reactivate: true,
      });
    const reactivated = await reactivate();
    record(
      "license-limit",
      "5 of 5 users: the owner cannot reactivate a removed member, 409 license_users_full",
      reactivated.status === 409 && reactivated.code === "license_users_full",
      { status: reactivated.status, code: reactivated.code },
    );
    const more = await account.request("POST", "v1/me/license/users", { users: 6 });
    const joined = await account.memberJoins("new", 2);
    const state = await account.license();
    record(
      "license-limit",
      "after the owner adds a user to the license, the new person joins and uses it",
      more.status === 200 && joined.status === 200 && state.used === 6,
      { users: more.status, join: joined.status, code: joined.code, used: state.used },
    );
    const again = await reactivate();
    record(
      "license-limit",
      "6 of 6 users: the reactivation is refused again",
      again.status === 409 && again.code === "license_users_full",
      { status: again.status, code: again.code },
    );
  },

  async "license-count"(account) {
    account.addServers([
      { name: "Office", members: [{ key: "shared" }, { key: "office" }, { key: "gone", active: false }] },
      { name: "Lab", members: [{ key: "shared" }, { key: "lab" }] },
    ]);
    const state = await account.license();
    const shared = state.users.find((user) => user.email === `${account.memberId("shared")}@example.com`);
    record(
      "license-count",
      "the owner plus 3 distinct active members: used is 4; a revoked member and the owner's memberships do not count",
      state.used === 4 && state.users.filter((user) => user.owner).length === 1,
      { used: state.used, users: state.users },
    );
    record(
      "license-count",
      "a member of two servers is one user with both server names",
      shared?.servers.length === 2 && shared.servers.includes("Office") && shared.servers.includes("Lab"),
      shared,
    );
    const before = await account.memberLicense("office");
    await account.buyLicense(5);
    await licenseWhere(account, "license active", (current) => current.license?.status === "active");
    const covered = await account.memberLicense("office");
    record(
      "license-count",
      "a member sees the owner's license only when it is open, and buys nothing",
      before.coveredBy.length === 0 &&
        covered.coveredBy.some((entry) => entry.ownerEmail === `${account.id}@example.com`) &&
        covered.license === null,
      { before: before.coveredBy, after: covered.coveredBy },
    );
    const revoked = await account.memberLicense("gone");
    record("license-count", "a revoked member is not covered", revoked.coveredBy.length === 0, revoked.coveredBy);
  },

  async "license-renewal"(account) {
    const sub = await account.buyLicense(5);
    await licenseWhere(account, "license active", (state) => state.license?.status === "active");
    const cancel = await account.request("POST", "v1/me/license/renewal", { cancel: true });
    const cancelled = licenseStateSchema.parse(cancel.body);
    record(
      "license-renewal",
      "cancel: the license ends at the period end, and Stripe has cancel_at_period_end",
      cancel.status === 200 &&
        cancelled.license?.cancelAtPeriodEnd === true &&
        (await subscription(sub)).cancel_at_period_end,
      cancelled.license,
    );
    const renew = await account.request("POST", "v1/me/license/renewal", { cancel: false });
    record(
      "license-renewal",
      "renew: the license continues",
      renew.status === 200 && licenseStateSchema.parse(renew.body).license?.cancelAtPeriodEnd === false,
      { status: renew.status },
    );
    await account.request("POST", "v1/me/license/renewal", { cancel: true });
    await account.advance(32);
    const ended = await licenseWhere(
      account,
      "license ended",
      (state) => state.license?.status === "canceled",
      120_000,
    );
    record(
      "license-renewal",
      "at the period end the license ends and stays in the state as ended",
      true,
      ended.license,
    );
    const again = await account.request("POST", "v1/me/license/checkout", { users: 5, currency: "eur" });
    const url = licenseCheckoutSchema.safeParse(again.body).data?.url;
    record("license-renewal", "an ended license: the account can buy a new one", again.status === 200 && Boolean(url), {
      status: again.status,
      code: again.code,
    });
    if (url) await expireCheckout(url);
    const noLicense = await account.request("POST", "v1/me/license/users", { users: 6 });
    record("license-renewal", "change users of an ended license: 404 no_license", noLicense.status === 404, {
      status: noLicense.status,
      code: noLicense.code,
    });
  },

  async "license-failed-renewal"(account) {
    const sub = await account.buyLicense(5);
    await licenseWhere(account, "license active", (state) => state.license?.status === "active");
    await account.useCard("pm_card_chargeCustomerFail");
    await account.advance(32);
    const due = await licenseWhere(account, "past_due", (state) => state.license?.status === "past_due", 120_000);
    record("license-failed-renewal", "a failed renewal shows the license as past_due", true, due.license);
    const second = await account.request("POST", "v1/me/license/checkout", { users: 5, currency: "eur" });
    record("license-failed-renewal", "a past_due license is open: no second license", second.status === 409, {
      status: second.status,
      code: second.code,
    });
    const good = await account.useCard("pm_card_visa");
    const current = await subscription(sub);
    if (!current.latest_invoice) throw new Error("No open invoice");
    await stripe("POST", `/v1/invoices/${current.latest_invoice}/pay`, idSchema, { payment_method: good });
    const recovered = await licenseWhere(account, "active again", (state) => state.license?.status === "active");
    record("license-failed-renewal", "paying the open invoice makes the license active again", true, recovered.license);
  },

  async "license-currency"(account) {
    const { server } = await account.createServer("Currency");
    const planSub = await account.pay(server.serverId);
    await planWhere(account, planSub, "plan", () => true);
    const state = await account.license();
    record(
      "license-currency",
      "an account with an EUR server plan has its license currency locked to EUR",
      state.currency === "eur",
      {
        currency: state.currency,
      },
    );
    const usd = await account.request("POST", "v1/me/license/checkout", { users: 5, currency: "usd" });
    record("license-currency", "a USD license: 409 license_currency", usd.status === 409, {
      status: usd.status,
      code: usd.code,
    });
    const eur = await account.request("POST", "v1/me/license/checkout", { users: 5, currency: "eur" });
    const url = licenseCheckoutSchema.safeParse(eur.body).data?.url;
    record("license-currency", "an EUR license gives a Checkout page", eur.status === 200 && Boolean(url), {
      status: eur.status,
    });
    if (url) await expireCheckout(url);
  },

  async "license-isolation"(account) {
    const { server } = await account.createServer("Isolation");
    const planSub = await account.pay(server.serverId);
    const planBefore = await planWhere(account, planSub, "plan", () => true);
    const claims = welcomeClaims(account).length;
    const licenseSub = await account.buyLicense(7);
    await licenseWhere(account, "license active", (state) => state.license?.status === "active");
    const plans = await account.billing();
    record(
      "license-isolation",
      "a license next to a server plan does not change the plan list or plan",
      plans.length === 1 &&
        plans[0]?.subscriptionId === planSub &&
        plans[0].plan === planBefore.plan &&
        plans[0].status === planBefore.status &&
        licenseInPlans(licenseSub) === 0,
      { plans, planBefore },
    );
    record("license-isolation", "the license sends no second welcome email", welcomeClaims(account).length === claims, {
      before: claims,
      after: welcomeClaims(account).length,
    });
    await stripe("DELETE", `/v1/subscriptions/${planSub}`, idSchema);
    await waitFor("canceled plan hidden", async () => !(await account.plan(planSub)));
    const license = await account.license();
    record(
      "license-isolation",
      "the server plan ends and the license stays active",
      (await account.plan(planSub)) === null && license.license?.status === "active",
      { plans: await account.billing(), license: license.license },
    );
    await stripe("DELETE", `/v1/subscriptions/${licenseSub}`, idSchema);
    const licenseEnded = await licenseWhere(account, "license ended", (state) => state.license?.status === "canceled");
    const plansAfter = await account.billing();
    record(
      "license-isolation",
      "the license ends without creating or reopening a server plan",
      plansAfter.length === 0,
      { license: licenseEnded.license, plans: plansAfter },
    );
  },
};

function previousSteps(): Step[] {
  try {
    return z.object({ steps: z.array(stepSchema) }).parse(JSON.parse(readFileSync(REPORT, "utf8"))).steps;
  } catch {
    return [];
  }
}

async function main(args: string[]) {
  if (args.includes("--print-user-ids")) {
    print(SCENARIOS.map(userId).join(","));
    return;
  }
  const shared = await loadSharedDevelopmentEnvironment(ROOT);
  for (const [name, value] of Object.entries(shared)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  if (!/^(sk|rk)_test_/u.test(process.env.STRIPE_SECRET_KEY ?? ""))
    throw new Error("STRIPE_SECRET_KEY must be a test-mode key.");
  const api = args[args.indexOf("--api") + 1];
  if (!args.includes("--api") || !api) throw new Error("Pass --api <Worker origin>.");
  const chosen = SCENARIOS.filter((scenario) => args.includes(scenario));
  const run = chosen.length > 0 ? chosen : SCENARIOS;
  const clocks: string[] = [];
  for (const scenario of run) {
    let account: Account | null = null;
    try {
      account = await new Account(scenario, api).setUp();
      clocks.push(account.clock);
      await scenarios[scenario](account);
    } catch (error) {
      record(scenario, "scenario finished", false, error instanceof Error ? error.message : String(error));
    } finally {
      await account?.tearDown().catch((error: unknown) => {
        record(scenario, "test hosts removed", false, error instanceof Error ? error.message : String(error));
      });
    }
  }
  if (chrome) await (await chrome).close();
  // Deleting a test clock deletes its customers and subscriptions.
  for (const clock of clocks)
    await stripe("DELETE", `/v1/test_helpers/test_clocks/${clock}`, idSchema).catch(() => null);
  mkdirSync(join(ROOT, ".openbot-build"), { recursive: true });
  const kept = previousSteps().filter((step) => !run.includes(step.scenario));
  writeFileSync(
    REPORT,
    `${JSON.stringify({ run: new Date().toISOString(), api, steps: [...kept, ...steps] }, null, 2)}\n`,
  );
  print(`Report: ${REPORT}`);
  if (steps.some((step) => step.result === "fail")) process.exitCode = 1;
}

await main(process.argv.slice(2));
