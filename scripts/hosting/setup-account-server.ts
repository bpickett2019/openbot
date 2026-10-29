import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseHostedServerName, parseHostedServerSummary } from "@openbot/contracts/hosted-servers";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, registerSecretValue } from "@openbot/logging";

const logger = createOpenBotLogger("hosting-setup");
const COLLECTION = "/v2/hosting/organization/servers";

/** Plans one operator request. It never creates provider resources or loads account-session credentials. */
export function prepareHostingOperation(args: string[], environment: NodeJS.ProcessEnv) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      origin: { type: "string" },
      name: { type: "string" },
      "idempotency-key": { type: "string" },
      execute: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0];
  if (!["list", "create", "revoke", "reactivate"].includes(command ?? "")) {
    throw new Error(
      "Use hosting:setup list | create --name <name> --idempotency-key <key> | revoke <host-id> | reactivate <host-id>. Mutations require --execute.",
    );
  }
  const configuredOrigin = values.origin ?? environment.OPENBOT_ACCOUNT_API_ORIGIN ?? environment.BROWSER_APP_ORIGIN;
  let origin: URL;
  try {
    origin = new URL(configuredOrigin ?? "");
  } catch {
    throw new Error("Set OPENBOT_ACCOUNT_API_ORIGIN, BROWSER_APP_ORIGIN or --origin to your own account HTTPS origin.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.hostname === "openbot.run" ||
    origin.hostname.endsWith(".openbot.run")
  ) {
    throw new Error("The operator command requires your own account HTTPS origin, without credentials or a path.");
  }
  const adminToken = environment.HOSTED_ORGANIZATION_ADMIN_TOKEN?.trim();
  if (!adminToken || adminToken.startsWith("encrypted:") || adminToken.length < 32) {
    throw new Error("Set your own decrypted HOSTED_ORGANIZATION_ADMIN_TOKEN in the shell, not in a command argument.");
  }
  registerSecretValue(adminToken);
  const headers: Record<string, string> = { Authorization: `Bearer ${adminToken}`, Accept: "application/json" };
  let path = COLLECTION;
  let body: { name: string } | { status: "active" | "revoked" } | undefined;
  if (command === "create") {
    const name = parseHostedServerName(values.name ?? "");
    const key = values["idempotency-key"];
    if (!name || !key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(key) || positionals.length !== 1) {
      throw new Error("Create requires a valid --name and a stable --idempotency-key of 16 to 128 characters.");
    }
    headers["Idempotency-Key"] = key;
    body = { name };
  } else if (command === "revoke" || command === "reactivate") {
    const hostId = positionals[1] ?? "";
    if (
      positionals.length !== 2 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(hostId) ||
      values.name !== undefined ||
      values["idempotency-key"] !== undefined
    ) {
      throw new Error("Funding changes require exactly one host UUID, with no name or idempotency-key option.");
    }
    path = `${COLLECTION}/${encodeURIComponent(hostId)}/funding`;
    body = { status: command === "revoke" ? "revoked" : "active" };
  } else if (positionals.length !== 1 || values.name !== undefined || values["idempotency-key"] !== undefined) {
    throw new Error("List takes no host, name or idempotency key.");
  }
  if (values.check && values.execute) throw new Error("Use --check or --execute, not both.");
  if (body) headers["Content-Type"] = "application/json";
  return {
    command,
    url: `${origin.origin}${path}`,
    method: body ? "POST" : "GET",
    headers,
    body,
    checkOnly: values.check || (body !== undefined && !values.execute),
  };
}

async function main(): Promise<void> {
  const operation = prepareHostingOperation(process.argv.slice(2), process.env);
  if (operation.checkOnly) {
    // Machine-readable: no Authorization header or other secret is included.
    process.stdout.write(
      `${JSON.stringify(
        {
          checkOnly: true,
          method: operation.method,
          url: operation.url,
          body: operation.body,
          idempotencyKey: operation.headers["Idempotency-Key"],
          next: "Use --execute only after approving provider spending. No request was sent.",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  let response: Response;
  try {
    response = await fetch(operation.url, {
      method: operation.method,
      headers: operation.headers,
      ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(
      "The operator request did not complete. Inspect the host list before another mutation; no automatic retry was made.",
    );
  }
  if (!response.ok)
    throw new Error(`The operator request returned HTTP ${response.status}. No automatic retry was made.`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The account service returned invalid JSON.");
  }
  if (!isDynamicRecord(payload)) throw new Error("The account service returned an invalid operator result.");
  const rows: unknown[] =
    operation.command === "list" && Array.isArray(payload.servers) ? payload.servers : [payload.server];
  const summaries = rows.map((row) => parseHostedServerSummary(row));
  if (summaries.some((row) => row?.funding !== "organization")) {
    throw new Error("The account service returned an invalid organization-host summary.");
  }
  // Machine-readable: the public host summary contains no claim, session or provider token.
  process.stdout.write(
    `${JSON.stringify(operation.command === "list" ? { servers: summaries } : { server: summaries[0] }, null, 2)}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    logger.error("Hosting operation stopped.", error instanceof Error ? error.message : "Unexpected operator error.");
    process.exitCode = 1;
  });
}
