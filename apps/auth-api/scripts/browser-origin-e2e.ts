// Drives a running account Worker without signing in or changing account data.
// Run from the repository root:
// BROWSER_ORIGIN_TEST_URL=http://localhost:3100 bun apps/auth-api/scripts/browser-origin-e2e.ts
// For the proxy case, set BROWSER_APP_ORIGIN in both the Worker and this process to the public HTTPS origin.
// To check bad configuration, set a malformed BROWSER_APP_ORIGIN in the Worker and pass --invalid-config.
// Repeat that case for HTTP, paths, credentials, query strings, fragments, lists, and empty values.
// Writes .openbot-build/browser-origin-e2e/report.json. The Worker must use the same code as this script.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

const endpoint = process.env.BROWSER_ORIGIN_TEST_URL;
if (!endpoint) throw new Error("Set BROWSER_ORIGIN_TEST_URL to the running account Worker origin.");
const target = new URL(endpoint);
if (target.origin !== endpoint || !["http:", "https:"].includes(target.protocol)) {
  throw new Error("BROWSER_ORIGIN_TEST_URL must be an HTTP or HTTPS origin without a path.");
}
const origin = process.env.BROWSER_APP_ORIGIN ?? target.origin;
const invalidConfig = process.argv.includes("--invalid-config");
const checks: { name: string; passed: boolean; status: number; code: unknown }[] = [];
const output = resolve(import.meta.dirname, "../../../.openbot-build/browser-origin-e2e");

async function check(
  name: string,
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    omit?: string[];
    body?: string;
    status?: number;
    code?: string;
    clearsCookie?: boolean;
    corsDenied?: boolean;
  },
) {
  const headers = new Headers({
    Origin: origin,
    "Content-Type": "application/json",
    "X-OpenBot-Browser": "1",
    "Sec-Fetch-Site": "same-origin",
    ...options.headers,
  });
  for (const header of options.omit ?? []) headers.delete(header);
  const method = options.method ?? "POST";
  const response = await fetch(new URL(options.path ?? "/api/browser/logout", target), {
    method,
    headers,
    ...(method === "GET" || method === "OPTIONS" ? {} : { body: options.body ?? "{}" }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  const code = isDynamicRecord(body) && isDynamicRecord(body.error) ? body.error.code : undefined;
  const cookie = response.headers.get("Set-Cookie") ?? "";
  checks.push({
    name,
    passed:
      (options.status === undefined || response.status === options.status) &&
      (!options.corsDenied ||
        (!response.headers.has("Access-Control-Allow-Origin") &&
          !response.headers.has("Access-Control-Allow-Credentials"))) &&
      (options.code === undefined || code === options.code) &&
      (!options.clearsCookie ||
        (isDynamicRecord(body) &&
          body.signedOut === true &&
          cookie.startsWith("__Host-openbot-web=;") &&
          ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=0"].every((part) => cookie.includes(part)))),
    status: response.status,
    code: code ?? null,
  });
}

try {
  if (invalidConfig) {
    for (const method of ["GET", "POST"]) {
      await check(`bad configuration fails closed for ${method}`, {
        method,
        status: 503,
        code: "browser_origin_invalid",
      });
    }
  } else {
    await check("the configured browser origin can sign out", { status: 200, clearsCookie: true });
    const refused = { status: 403, code: "browser_request_refused" };
    await check("an unrelated origin is refused", { ...refused, headers: { Origin: "https://untrusted.invalid" } });
    await check("a missing origin is refused", { ...refused, omit: ["Origin"] });
    await check("an opaque origin is refused", { ...refused, headers: { Origin: "null" } });
    await check("a missing browser header is refused", { ...refused, omit: ["X-OpenBot-Browser"] });
    await check("a form write is refused", {
      ...refused,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    await check("a cross-site write is refused", { ...refused, headers: { "Sec-Fetch-Site": "cross-site" } });
    await check("a cross-site read is refused", {
      ...refused,
      path: "/api/browser/session",
      method: "GET",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    await check("forwarded headers cannot grant origin trust", {
      ...refused,
      headers: {
        Origin: "https://untrusted.invalid",
        "X-Forwarded-Host": "untrusted.invalid",
        "X-Forwarded-Proto": "https",
        Forwarded: "host=untrusted.invalid;proto=https",
      },
    });
    await check("preflight does not open cross-origin access", {
      method: "OPTIONS",
      headers: {
        Origin: "https://untrusted.invalid",
        "Sec-Fetch-Site": "cross-site",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-openbot-browser,content-type",
      },
      corsDenied: true,
    });
    await check("an accepted origin does not grant an account session", {
      path: "/api/browser/v1/me",
      method: "PATCH",
      status: 401,
      code: "sign_in_required",
    });
    const refusedCredentials: Record<string, string>[] = [
      {},
      { Authorization: "Bearer invalid-account-session" },
      { Cookie: "__Host-openbot-web=invalid-browser-session-token" },
      { "OpenBot-Hosting-Developer-Key": "invalid-developer-key" },
    ];
    for (const path of ["/v2/hosting/organization/servers", "/v2/hosting/organization/servers/server-1/funding"]) {
      for (const headers of refusedCredentials) {
        await check(
          `operator authorization precedes JSON parsing at ${path}: ${Object.keys(headers).join(",") || "no credentials"}`,
          {
            path,
            headers,
            body: "{",
            status: 401,
            code: "hosting_operator_unauthorized",
            corsDenied: true,
          },
        );
      }
    }
    await check("browser headers cannot list organization servers", {
      path: "/v2/hosting/organization/servers",
      method: "GET",
      status: 401,
      code: "hosting_operator_unauthorized",
      corsDenied: true,
    });
    if (origin !== target.origin) {
      await check("the upstream origin is not a second trusted browser origin", {
        ...refused,
        headers: { Origin: target.origin },
      });
    } else {
      await check("the default rejects a different HTTPS origin", {
        ...refused,
        headers: { Origin: "https://public-browser.invalid" },
      });
    }
  }
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), `${JSON.stringify({ invalidConfig, checks }, null, 2)}\n`);
}
if (checks.some((entry) => !entry.passed)) throw new Error("Browser origin checks failed. See the JSON report.");
console.info(`Browser origin checks passed: ${checks.length}. Report: ${join(output, "report.json")}`);
