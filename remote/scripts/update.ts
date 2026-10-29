import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
if (!args.includes("--deploy") || args.some((arg) => !["--deploy", "--enable"].includes(arg))) {
  throw new Error("Use remote:update --deploy [--enable] only after deployment and runtime approval.");
}
if (!/^[a-f0-9]{32}$/u.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? ""))
  throw new Error("Set the approved CLOUDFLARE_ACCOUNT_ID before deployment.");

// No encrypted upstream environment loader, secret arguments, implicit credential provisioning or retry.
// Without --enable the Worker refuses every request and its existing alarm stops the Container.
const environment = { ...process.env };
delete environment.CLOUDFLARE_API_TOKEN;
delete environment.CLOUDFLARE_ENV;
const child = spawn(
  "node",
  [
    resolve(root, "node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    "--config",
    "remote/cloudflare/wrangler.jsonc",
    "--var",
    `REMOTE_SIGNAL_ENABLED:${args.includes("--enable") ? "true" : "false"}`,
  ],
  { cwd: root, env: environment, stdio: "inherit", shell: false },
);
const { promise, resolve: resolveExit, reject } = Promise.withResolvers<void>();
child.once("error", () => reject(new Error("Signal deployment could not start.")));
child.once("exit", (code) => (code === 0 ? resolveExit() : reject(new Error("Signal deployment failed."))));
await promise;
