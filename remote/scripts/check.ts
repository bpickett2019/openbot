import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const runtimeNodeBin = resolve(root, "runtime/node/bin");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--compose")) throw new Error("Use remote:check [--compose].");

// Isolated interpolation inputs, not operator secrets. No env file, network or daemon is used.
const environment = {
  PATH: existsSync(join(runtimeNodeBin, "node"))
    ? `${runtimeNodeBin}${delimiter}${process.env.PATH ?? ""}`
    : process.env.PATH,
  HOME: process.env.HOME,
  ACME_EMAIL: "configuration-check@example.invalid",
  SIGNAL_DOMAIN: "signal.example.invalid",
  TURN_DOMAIN: "turn.example.invalid",
  TURN_PUBLIC_IP: "203.0.113.1",
  CLOUDFLARE_DNS_API_TOKEN: "configuration-check-only",
  REMOTE_TICKET_JWKS_URL: "https://accounts.example.invalid/.well-known/jwks.json",
  REMOTE_CONTROL_PLANE_URL: "https://accounts.example.invalid",
  REMOTE_TICKET_PUBLIC_KEYS: '{"keys":[{"kty":"EC"}]}',
  REMOTE_SESSION_SECRET: randomBytes(32).toString("hex"),
  REMOTE_AUTH_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  TURN_SHARED_SECRET: randomBytes(32).toString("hex"),
};

const composeOnly = args.includes("--compose");
if (!composeOnly) {
  const child = Bun.spawn(["bun", "run", "--cwd", "remote/api", "check"], {
    cwd: root,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error("Remote API check failed.");
}
for (const file of ["remote/compose.yaml", "remote/compose.dev.yaml"]) {
  // Compose config is client-side. --quiet prevents resolved values from entering output.
  const child = Bun.spawn(["docker", "compose", "--env-file", "/dev/null", "-f", file, "config", "--quiet"], {
    cwd: root,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`Docker Compose validation failed for ${file}.`);
}
console.log(
  composeOnly ? "Docker Compose configuration is valid." : "Remote API and Docker Compose configuration are valid.",
);
