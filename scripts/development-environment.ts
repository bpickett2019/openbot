import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { config } from "@dotenvx/dotenvx";
import { readDevelopmentState } from "./development-secrets";

const LOCAL_IDENTITY_KEYS = [
  "REMOTE_TICKET_PRIVATE_JWK",
  "REMOTE_TICKET_PUBLIC_JWKS",
  "REMOTE_AUTH_WEBHOOK_SECRET",
  "SITE_REPORT_HASH_SECRET",
  "SKILLS_ADMIN_TOKEN",
] as const;

export function withoutDecryptionKeys(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("DOTENV_")));
}

export async function loadSharedDevelopmentEnvironment(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const privateKey = environment.DOTENV_PRIVATE_KEY_DEV;
  if (!privateKey?.trim()) return {};
  return decryptEnvironment(
    join(projectRoot, "apps/auth-api/.env.dev"),
    { DOTENV_PRIVATE_KEY_DEV: privateKey },
    "Cannot decrypt shared development settings. Check the development key.",
  );
}

async function decryptEnvironment(
  path: string,
  keys: Record<string, string>,
  message: string,
): Promise<Record<string, string>> {
  try {
    const values = { ...keys };
    const result = await config({
      envs: [{ type: "env", value: readFileSync(path, "utf8") }],
      processEnv: values,
      envKeysFile: devNull,
      strict: true,
      quiet: true,
      noArmor: true,
      noNative: true,
      no1Password: true,
      noBitwarden: true,
    });
    if (result.error || Object.values(values).some((value) => value.startsWith("encrypted:"))) throw new Error(message);
    return Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith("DOTENV_")));
  } catch {
    // Library errors can contain private-key details. Do not retain their cause.
    throw new Error(message);
  }
}

export async function loadDevelopmentEnvironment(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const state = readDevelopmentState(projectRoot);
  const shared = await loadSharedDevelopmentEnvironment(projectRoot, environment);
  // Shared service credentials must not change the identity of an existing local instance.
  for (const key of LOCAL_IDENTITY_KEYS) delete shared[key];
  return withoutDecryptionKeys({
    ...state.defaults,
    ...shared,
    ...state.overrides,
    ...definedEnvironment(environment),
  });
}

function definedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

export function requireDevelopmentValues(environment: NodeJS.ProcessEnv, names: string[]): void {
  const missing = names.filter((name) => !environment[name]?.trim() || environment[name]?.startsWith("encrypted:"));
  if (missing.length) throw new Error(`Missing development settings: ${missing.join(", ")}.`);
}

const ACCOUNT_SETTINGS =
  /^(?:STRIPE_|BOAT_|HOSTED_|DIGITALOCEAN_|EMAIL_|SITE_REPORT_HASH_SECRET$|SKILLS_ADMIN_TOKEN$|APNS_|FCM_|GITHUB_APP_|SLACK_|DISCORD_|TELEGRAM_|REMOTE_TICKET_|REMOTE_AUTH_WEBHOOK_SECRET$|OPENPANEL_)/u;
const SIGNAL_SETTINGS = new Set([
  "REMOTE_TICKET_PUBLIC_JWKS",
  "REMOTE_TICKET_PUBLIC_KEYS",
  "REMOTE_TICKET_JWKS_URL",
  "REMOTE_AUTH_WEBHOOK_SECRET",
  "SLACK_SIGNING_SECRET",
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "TELEGRAM_BOT_TOKENS",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_WEBHOOK_ORIGIN",
]);

export function developmentChildEnvironment(
  environment: NodeJS.ProcessEnv,
  service: "api" | "remote" | "app" | "test-client",
): NodeJS.ProcessEnv {
  const child = withoutDecryptionKeys(environment);
  delete child.OPENBOT_DEV_SLACK_SIGNING_SECRET;
  for (const key of Object.keys(child)) {
    if (!ACCOUNT_SETTINGS.test(key)) continue;
    if (service === "api") continue;
    if (service === "remote" && SIGNAL_SETTINGS.has(key)) continue;
    delete child[key];
  }
  if (service === "app" || service === "test-client" || service === "api") {
    delete child.REMOTE_SESSION_SECRET;
    delete child.TURN_SHARED_SECRET;
    delete child.REMOTE_METRICS_TOKEN;
  }
  return child;
}

/** Only the API receives the full account configuration. Signal receives its verification values. */
export function developmentSettingsForService(
  environment: NodeJS.ProcessEnv,
  service: "api" | "remote" | "app" | "test-client",
): NodeJS.ProcessEnv {
  if (service === "api") return withoutDecryptionKeys(environment);
  if (service !== "remote") return {};
  return Object.fromEntries(Object.entries(environment).filter(([key]) => SIGNAL_SETTINGS.has(key)));
}
