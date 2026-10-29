import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, registerSecretValues } from "@openbot/logging";
import { unstable_readConfig } from "wrangler";
import { readFcmServiceAccount } from "../apps/auth-api/src/server/android-notification-relay";

const logger = createOpenBotLogger("deploy-auth-api");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = join(projectRoot, "apps", "auth-api");
const wranglerExecutable = join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.exe" : "wrangler",
);
const REQUIRED_SECRETS = [
  "EMAIL_SMTP_PASSWORD",
  "SKILLS_ADMIN_TOKEN",
  "SITE_REPORT_HASH_SECRET",
  "REMOTE_TICKET_PRIVATE_JWK",
  "REMOTE_TICKET_PUBLIC_JWKS",
  "REMOTE_AUTH_WEBHOOK_SECRET",
] as const;
const OPTIONAL_SECRET_SETS = [
  ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  ["GITHUB_APP_PRIVATE_KEY"],
  ["SERVER_CLAIMS_ADMIN_TOKEN"],
  ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_STATE_SECRET"],
  ["SLACK_ROUTE_PRIVATE_JWK", "SLACK_ROUTE_KEY_ID"],
  ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_STATE_SECRET"],
  ["DISCORD_ROUTE_PRIVATE_JWK", "DISCORD_ROUTE_KEY_ID"],
  ["APNS_PRIVATE_KEY", "APNS_KEY_ID"],
  ["FCM_SERVICE_ACCOUNT"],
  ["DIGITALOCEAN_API_TOKEN", "HOSTED_ORGANIZATION_ADMIN_TOKEN"],
] as const;
const OPTIONAL_VARS = [
  "GITHUB_APP_CLIENT_ID",
  "APNS_TEAM_ID",
  "APNS_TOPIC",
  "TELEGRAM_BOT_ID",
  "TELEGRAM_BOT_USERNAME",
  "HOSTED_DIGITALOCEAN_REGION",
  "HOSTED_DIGITALOCEAN_SIZE",
  "HOSTED_DIGITALOCEAN_IMAGE_ID",
  "HOSTED_OPENBOT_IMAGE_DIGEST",
  "HOSTED_OPENBOT_VERSION",
  "HOSTED_ORGANIZATION_OWNER_USER_ID",
  "HOSTED_ORGANIZATION_ENTITLEMENT_PLAN",
] as const;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value || value.startsWith("encrypted:"))
    throw new Error(`Set your own decrypted ${name} in the deployment environment.`);
  return value;
}

function resourceName(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value)) throw new Error(`${name} must be a valid resource name.`);
  if (/^openbot-(auth|avatars|skills|sites|landing)(-|$)/u.test(value)) {
    throw new Error(`${name} must not target an upstream resource.`);
  }
  return value;
}

function publicUrl(environment: NodeJS.ProcessEnv, name: string, protocol: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(required(environment, name));
  } catch {
    throw new Error(`${name} must be an absolute ${protocol} URL.`);
  }
  if (
    url.protocol !== protocol ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== path ||
    url.hostname === "openbot.run" ||
    url.hostname.endsWith(".openbot.run") ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  ) {
    throw new Error(`${name} must identify your own public service with path ${path}.`);
  }
  return url;
}

function verifyTicketKeys(environment: NodeJS.ProcessEnv, keyId: string): void {
  try {
    const privateJwk = JSON.parse(required(environment, "REMOTE_TICKET_PRIVATE_JWK"));
    const publicJwks = JSON.parse(required(environment, "REMOTE_TICKET_PUBLIC_JWKS"));
    if (
      !isDynamicRecord(privateJwk) ||
      privateJwk.kty !== "EC" ||
      privateJwk.crv !== "P-256" ||
      typeof privateJwk.d !== "string" ||
      !isDynamicRecord(publicJwks) ||
      !Array.isArray(publicJwks.keys)
    )
      throw new Error();
    const publicKey = publicJwks.keys.find((key: unknown) => isDynamicRecord(key) && key.kid === keyId);
    if (
      !isDynamicRecord(publicKey) ||
      publicKey.d !== undefined ||
      publicKey.kty !== "EC" ||
      publicKey.crv !== "P-256" ||
      publicKey.alg !== "ES256"
    )
      throw new Error();
    const derived = createPublicKey(createPrivateKey({ key: privateJwk, format: "jwk" })).export({ format: "jwk" });
    if (derived.x !== publicKey.x || derived.y !== publicKey.y) throw new Error();
  } catch {
    throw new Error(
      "The account ticket keys must be a matching private P-256 JWK and public ES256 JWKS for REMOTE_TICKET_KEY_ID.",
    );
  }
}

/** Builds only non-secret configuration. It does not create resources, load encrypted files or contact a provider. */
export function prepareAccountDeployment(environment: NodeJS.ProcessEnv, test = false) {
  const base = unstable_readConfig({ config: join(apiRoot, "wrangler.jsonc"), ...(test ? { env: "test" } : {}) });
  const name = resourceName(environment, "OPENBOT_ACCOUNT_WORKER_NAME");
  if (test && !name.endsWith("-test"))
    throw new Error("A test deployment requires an OPENBOT_ACCOUNT_WORKER_NAME ending in -test.");
  const accountId = required(environment, "CLOUDFLARE_ACCOUNT_ID");
  const databaseId = required(environment, "OPENBOT_D1_DATABASE_ID");
  if (!/^[a-f0-9]{32}$/iu.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID must be the target account ID.");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(databaseId))
    throw new Error("OPENBOT_D1_DATABASE_ID must be a D1 UUID.");
  if (["0cf7e5c1-63ad-4089-810a-e9eb67dd863d", "38f1a836-6c70-44bb-bbf3-f0bbc5b766b3"].includes(databaseId)) {
    throw new Error("The account deployment must not use an upstream D1 database.");
  }
  const app = publicUrl(environment, "BROWSER_APP_ORIGIN", "https:", "/");
  const account =
    environment.OPENBOT_ACCOUNT_API_ORIGIN === undefined
      ? app
      : publicUrl(environment, "OPENBOT_ACCOUNT_API_ORIGIN", "https:", "/");
  const signal = publicUrl(environment, "REMOTE_SIGNAL_URL", "wss:", "/v1/signal");
  const keyId = required(environment, "REMOTE_TICKET_KEY_ID");
  const vars: Record<string, string> = {
    AUTH_EXPOSE_DEVELOPMENT_CODE: "false",
    BROWSER_APP_ORIGIN: app.origin,
    EMAIL_SMTP_HOST: required(environment, "EMAIL_SMTP_HOST"),
    EMAIL_SMTP_PORT: environment.EMAIL_SMTP_PORT?.trim() || "465",
    EMAIL_SMTP_USERNAME: required(environment, "EMAIL_SMTP_USERNAME"),
    EMAIL_FROM: required(environment, "EMAIL_FROM"),
    REMOTE_TICKET_KEY_ID: keyId,
    REMOTE_SIGNAL_URL: signal.href,
    REMOTE_AUTH_WEBHOOK_URL: `https://${signal.host}/internal/auth-events`,
    HOSTED_SERVERS_ENABLED: environment.HOSTED_SERVERS_ENABLED?.trim() || "false",
    SITE_PUBLISH_ENABLED: "false",
    SITE_COOKIE_ISOLATION_READY: "false",
  };
  if (vars.EMAIL_SMTP_PORT !== "465") throw new Error("The account SMTP transport requires TLS on port 465.");
  if (!["true", "false"].includes(vars.HOSTED_SERVERS_ENABLED ?? ""))
    throw new Error("HOSTED_SERVERS_ENABLED must be true or false.");
  for (const variable of OPTIONAL_VARS) {
    if (environment[variable]?.trim()) vars[variable] = required(environment, variable);
  }
  const secrets: string[] = [...REQUIRED_SECRETS];
  for (const names of OPTIONAL_SECRET_SETS) {
    const present = names.filter((key) => environment[key]?.trim());
    if (present.length && present.length !== names.length) throw new Error(`Set all or none of ${names.join(", ")}.`);
    if (present.length) secrets.push(...names);
  }
  registerSecretValues(
    secrets.map((name) => required(environment, name)),
    { allowShort: true },
  );
  verifyTicketKeys(environment, keyId);
  if (required(environment, "REMOTE_AUTH_WEBHOOK_SECRET").length < 32)
    throw new Error("REMOTE_AUTH_WEBHOOK_SECRET must contain at least 32 characters.");
  if (environment.FCM_SERVICE_ACCOUNT && !readFcmServiceAccount(environment.FCM_SERVICE_ACCOUNT)) {
    throw new Error("FCM_SERVICE_ACCOUNT is not a valid Firebase service account.");
  }
  const stripeKey = environment.STRIPE_SECRET_KEY?.trim();
  if (stripeKey && (stripeKey.startsWith("sk_live_") || stripeKey.startsWith("rk_live_")) === test) {
    throw new Error("The Stripe key mode does not match the deployment environment.");
  }
  if (vars.HOSTED_SERVERS_ENABLED === "true") {
    for (const name of [
      "DIGITALOCEAN_API_TOKEN",
      "HOSTED_ORGANIZATION_ADMIN_TOKEN",
      ...OPTIONAL_VARS.filter((key) => key.startsWith("HOSTED_")),
    ]) {
      required(environment, name);
    }
    if (required(environment, "HOSTED_ORGANIZATION_ADMIN_TOKEN").length < 32)
      throw new Error("HOSTED_ORGANIZATION_ADMIN_TOKEN must contain at least 32 characters.");
  }
  const config = {
    name,
    account_id: accountId,
    main: join(apiRoot, "src", "worker-entry.ts"),
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    workers_dev: true,
    preview_urls: false,
    cache: base.cache,
    observability: base.observability,
    triggers: base.triggers,
    routes: account.hostname.endsWith(".workers.dev") ? [] : [{ pattern: account.hostname, custom_domain: true }],
    secrets: { required: secrets },
    vars,
    d1_databases: [
      {
        binding: "DB",
        database_name: resourceName(environment, "OPENBOT_D1_DATABASE_NAME"),
        database_id: databaseId,
        migrations_dir: join(apiRoot, "migrations"),
      },
    ],
    r2_buckets: [
      { binding: "AVATARS", bucket_name: resourceName(environment, "OPENBOT_AVATARS_BUCKET") },
      { binding: "SKILLS", bucket_name: resourceName(environment, "OPENBOT_SKILLS_BUCKET") },
      { binding: "SITES", bucket_name: resourceName(environment, "OPENBOT_SITES_BUCKET") },
    ],
    ratelimits: base.ratelimits,
  };
  return { config, secrets };
}

async function run(
  executable: string,
  args: string[],
  options: {
    label: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    capture?: boolean;
  },
): Promise<string> {
  const { promise, resolve: resolveProcess, reject: rejectProcess } = Promise.withResolvers<string>();
  const environment = { ...process.env, ...options.env };
  // Use the operator's Wrangler login, never an inherited upstream production API token.
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_ENV;
  const child = spawn(executable, args, {
    cwd: apiRoot,
    env: environment,
    shell: false,
    stdio: [options.input === undefined ? "ignore" : "pipe", options.capture ? "pipe" : "inherit", "inherit"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.once("error", () => rejectProcess(new Error(`${options.label} could not start.`)));
  child.once("exit", (code, signal) => {
    if (code === 0) resolveProcess(output);
    else rejectProcess(new Error(`${options.label} failed with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`));
  });
  child.stdin?.on("error", () => rejectProcess(new Error(`${options.label} did not accept its input.`)));
  if (options.input !== undefined) child.stdin?.end(options.input);
  return promise;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const migrateOnly = args.includes("--migrate-only");
  const mode = args.filter((value) => value !== "--check" && value !== "--migrate-only");
  const test = mode.length === 2 && mode[0] === "--env" && mode[1] === "test";
  if ((check && migrateOnly) || (mode.length !== 0 && !(mode.length === 1 && mode[0] === "--self-hosted") && !test)) {
    throw new Error("Use --self-hosted or --env test, with optional --check or --migrate-only.");
  }
  const { config, secrets } = prepareAccountDeployment(process.env, test);
  if (check) {
    logger.info("Account deployment inputs passed. No provider call, secret upload, build or migration ran.", {
      worker: config.name,
      accountId: config.account_id,
      databaseId: config.d1_databases[0]?.database_id,
      origin: config.vars.BROWSER_APP_ORIGIN,
      hostingEnabled: config.vars.HOSTED_SERVERS_ENABLED === "true",
    });
    return;
  }
  const temporaryRoot = join(apiRoot, ".wrangler");
  await mkdir(temporaryRoot, { recursive: true });
  const temporary = await mkdtemp(join(temporaryRoot, "owned-deploy-"));
  try {
    const configPath = join(temporary, "wrangler.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const configArgs = ["--config", configPath];
    const query = async (sql: string): Promise<unknown[]> => {
      const raw = await run(
        wranglerExecutable,
        ["d1", "execute", "DB", "--remote", "--json", "--command", sql, ...configArgs],
        { label: "Owned database preflight", capture: true },
      );
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error("The database preflight returned invalid JSON.");
      }
      const first = Array.isArray(value) ? value[0] : undefined;
      if (!isDynamicRecord(first) || first.success !== true || !Array.isArray(first.results))
        throw new Error("The database preflight did not succeed.");
      return first.results;
    };
    const tables = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hosted_servers'");
    if (
      tables.length &&
      (
        await query(
          "SELECT server_id FROM hosted_servers WHERE provider = 'boat' AND observed_state != 'deleted' LIMIT 1",
        )
      ).length
    ) {
      throw new Error(
        "This database has unmigrated Boat allocations. No migration or deployment ran. Approve a data-preserving provider migration first.",
      );
    }
    for (const bucket of config.r2_buckets) {
      await run(wranglerExecutable, ["r2", "bucket", "info", bucket.bucket_name, ...configArgs], {
        label: `${bucket.binding} ownership preflight`,
        capture: true,
      });
    }
    if (!migrateOnly) {
      for (const name of secrets) {
        await run(wranglerExecutable, ["secret", "put", name, ...configArgs], {
          label: `${name} secret`,
          input: `${required(process.env, name)}\n`,
        });
      }
    }
    await run(wranglerExecutable, ["d1", "migrations", "apply", "DB", "--remote", ...configArgs], {
      label: "Owned database migrations",
    });
    if (migrateOnly) return;
    await run(process.execPath, ["run", "build"], {
      label: "Account Worker build",
      env: { CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: configPath },
    });
    await run(wranglerExecutable, ["deploy", "--config", "dist/server/wrangler.json"], {
      label: "Account Worker deployment",
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    logger.error(
      "Account deployment stopped.",
      error instanceof Error ? error.message : "Unexpected deployment error.",
    );
    process.exitCode = 1;
  });
}
