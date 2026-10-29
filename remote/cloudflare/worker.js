import { DurableObject } from "cloudflare:workers";

// All sockets and connector routes must reach this one in-memory Signal owner.
const SIGNAL_IDENTITY = "odic-shared-signal";
const SIGNAL_PORT = 8081;
const ALARM_INTERVAL_MS = 60_000;
const STARTUP_TIMEOUT_MS = 120_000;
const OPTIONAL_ENVIRONMENT = [
  "REMOTE_METRICS_TOKEN",
  "REMOTE_MAX_CONNECTIONS_PER_USER",
  "REMOTE_MAX_CONNECTIONS_PER_IP",
  "REMOTE_MAX_MESSAGES_PER_MINUTE",
  "SLACK_SIGNING_SECRET",
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DISCORD_MESSAGE_CONTENT",
  "TELEGRAM_BOT_TOKENS",
  "TELEGRAM_WEBHOOK_SECRET",
];

function unavailable() {
  return new Response("Signal is unavailable.", { status: 503, headers: { "Cache-Control": "no-store" } });
}

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("Invalid Signal origin configuration.");
  return url.origin;
}

function containerEnvironment(env) {
  const accountOrigin = httpsOrigin(env.REMOTE_CONTROL_PLANE_URL);
  const signalOrigin = httpsOrigin(env.REMOTE_SIGNAL_ORIGIN);
  const browserOrigin = httpsOrigin(env.REMOTE_BROWSER_ORIGIN ?? accountOrigin);
  for (const name of [
    "REMOTE_SESSION_SECRET",
    "REMOTE_AUTH_WEBHOOK_SECRET",
    "CLOUDFLARE_TURN_KEY_ID",
    "CLOUDFLARE_TURN_API_TOKEN",
  ])
    if (typeof env[name] !== "string" || !env[name].trim()) throw new Error("Signal secrets are not configured.");
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(env.CLOUDFLARE_TURN_KEY_ID)) throw new Error("Signal TURN key is invalid.");
  for (const name of ["REMOTE_SESSION_SECRET", "REMOTE_AUTH_WEBHOOK_SECRET"])
    if (new TextEncoder().encode(env[name]).byteLength < 32) throw new Error("Signal secret is too short.");
  const result = {
    NODE_ENV: "production",
    REMOTE_SIGNAL_HOST: "0.0.0.0",
    REMOTE_SIGNAL_PORT: String(SIGNAL_PORT),
    REMOTE_HEALTH_PORT: "8080",
    // Only the private Container port is HTTP. The Worker refuses non-HTTPS public requests.
    REMOTE_TLS_DISABLED: "true",
    REMOTE_TRUST_PROXY: "true",
    REMOTE_CONTROL_PLANE_URL: accountOrigin,
    REMOTE_TICKET_JWKS_URL: `${accountOrigin}/.well-known/jwks.json`,
    REMOTE_ALLOWED_ORIGINS: browserOrigin,
    REMOTE_SESSION_SECRET: env.REMOTE_SESSION_SECRET,
    REMOTE_AUTH_WEBHOOK_SECRET: env.REMOTE_AUTH_WEBHOOK_SECRET,
    CLOUDFLARE_TURN_KEY_ID: env.CLOUDFLARE_TURN_KEY_ID,
    CLOUDFLARE_TURN_API_TOKEN: env.CLOUDFLARE_TURN_API_TOKEN,
    TELEGRAM_WEBHOOK_ORIGIN: signalOrigin,
  };
  for (const name of OPTIONAL_ENVIRONMENT) if (env[name]) result[name] = env[name];
  return result;
}

export class SignalContainer extends DurableObject {
  #starting = null;
  #runningReady = false;

  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container?.running) {
      ctx.blockConcurrencyWhile(async () => {
        if (env.REMOTE_SIGNAL_ENABLED !== "true") {
          await ctx.container.destroy();
          await ctx.storage.deleteAlarm();
          return;
        }
        await ctx.container.setInactivityTimeout(6 * 60 * 60_000);
        await ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      });
    }
  }

  async #ready() {
    if (this.env.REMOTE_SIGNAL_ENABLED !== "true") throw new Error("Signal is disabled.");
    if (this.#runningReady && this.ctx.container?.running) return;
    if (this.#starting) return this.#starting;
    const pending = this.#startAndWait();
    this.#starting = pending;
    try {
      await pending;
    } finally {
      this.#starting = null;
    }
  }

  async #startAndWait() {
    const container = this.ctx.container;
    if (!container) throw new Error("Signal Container is not configured.");
    // Arm shutdown/recovery before starting, including an instance that never reaches readiness.
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    if (!container.running) {
      container.start({ enableInternet: true, env: containerEnvironment(this.env) });
    }
    let stopped = false;
    const ended = () => {
      stopped = true;
      this.#runningReady = false;
    };
    this.ctx.waitUntil(container.monitor().then(ended, ended));
    await container.setInactivityTimeout(6 * 60 * 60_000);
    const port = container.getTcpPort(SIGNAL_PORT);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline && !stopped) {
      try {
        const response = await port.fetch("http://signal/health/ready", { signal: AbortSignal.timeout(2_000) });
        const ready = response.ok;
        await response.body?.cancel();
        if (ready) {
          this.#runningReady = true;
          await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
          return;
        }
      } catch {
        /* Readiness checks are bounded reads, not repeated starts. */
      }
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(resolve, 250);
      await promise;
    }
    throw new Error("Signal did not become ready.");
  }

  async fetch(request) {
    try {
      await this.#ready();
      const target = new URL(request.url);
      target.protocol = "http:";
      target.host = "signal";
      return await this.ctx.container.getTcpPort(SIGNAL_PORT).fetch(new Request(target, request));
    } catch {
      // Provider errors and request paths can contain secret values. Do not log them.
      return unavailable();
    }
  }

  async alarm() {
    if (this.env.REMOTE_SIGNAL_ENABLED !== "true") {
      if (this.ctx.container?.running) await this.ctx.container.destroy();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // Signal is independent of the sleeping desktop. This also retains optional Gateway ownership.
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    try {
      await this.#ready();
    } catch {
      /* A later alarm can recover a stopped service. */
    }
  }
}

export default {
  async fetch(request, env) {
    if (env.REMOTE_SIGNAL_ENABLED !== "true") return unavailable();
    const url = new URL(request.url);
    let browserOrigin;
    try {
      if (url.origin !== httpsOrigin(env.REMOTE_SIGNAL_ORIGIN)) return new Response(null, { status: 421 });
      browserOrigin = httpsOrigin(env.REMOTE_BROWSER_ORIGIN ?? env.REMOTE_CONTROL_PLANE_URL);
    } catch {
      return unavailable();
    }
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== browserOrigin && origin !== "openbot-app://app")
      return new Response(null, { status: 403 });
    if (
      !(
        url.pathname.startsWith("/v1/") ||
        url.pathname === "/internal/auth-events" ||
        url.pathname === "/health/live" ||
        url.pathname === "/health/ready"
      )
    )
      return new Response(null, { status: 404 });
    const headers = new Headers(request.headers);
    // Never accept a caller's forwarding chain as the quota identity.
    headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "unknown");
    headers.delete("Forwarded");
    headers.delete("Cookie");
    const id = env.SIGNAL.idFromName(SIGNAL_IDENTITY);
    return env.SIGNAL.get(id).fetch(new Request(request, { headers }));
  },
};
