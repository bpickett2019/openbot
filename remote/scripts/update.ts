import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--deploy")
  throw new Error("Use remote:update --deploy on the approved Linux host. This starts paid services.");
if (process.platform !== "linux" || process.env.REMOTE_DEPLOY_HOST !== hostname())
  throw new Error("Set REMOTE_DEPLOY_HOST to the intended Linux hostname and run on that host.");

// Use only this host's Docker socket and explicit operator environment. Do not load .env files.
const docker = ["--host", "unix:///var/run/docker.sock"];
const compose = [...docker, "compose", "--env-file", "/dev/null", "-f", "remote/compose.yaml"];
for (const name of ["REMOTE_SESSION_SECRET", "REMOTE_AUTH_WEBHOOK_SECRET", "TURN_SHARED_SECRET"])
  if (Buffer.byteLength(process.env[name] ?? "", "utf8") < 32)
    throw new Error(`${name} must contain at least 32 bytes.`);
if (process.env.REMOTE_TLS_DISABLED === "true") {
  if (process.env.REMOTE_SIGNAL_BIND_ADDRESS !== "127.0.0.1" || process.env.REMOTE_TRUST_PROXY !== "true")
    throw new Error("Plain HTTP requires the local TLS proxy, loopback binding and REMOTE_TRUST_PROXY=true.");
} else if (process.env.REMOTE_TRUST_PROXY === "true") {
  throw new Error("Direct public TLS must not trust caller forwarding headers.");
}

await run([...compose, "config", "--quiet"]);
await run([...compose, "build", "remote-api", "coturn"]);
await run([...compose, "up", "-d", "--wait", "acme"]);
await run([...compose, "up", "-d", "--no-build", "--no-deps", "--wait", "remote-api"]);

// Resolve the service through this Compose project, not an unrelated named container.
const coturnId = await run([...compose, "ps", "--all", "--quiet", "coturn"], true);
if (coturnId) {
  const running = await run([...docker, "inspect", "--format", "{{.State.Running}}", coturnId], true);
  if (running === "true") {
    console.log("Draining coturn. The update waits until all relay allocations end.");
    await run([...docker, "update", "--restart=no", coturnId]);
    await run([...docker, "kill", "--signal=SIGUSR1", coturnId]);
    await run([...docker, "wait", coturnId]);
  }
}
await run([...compose, "up", "-d", "--no-build", "--no-deps", "--force-recreate", "--wait", "coturn"]);
await run([...compose, "ps"]);

function run(arguments_: string[], captureOutput = false): Promise<string> {
  const { promise, resolve: resolveExit, reject } = Promise.withResolvers<string>();
  const environment = { ...process.env };
  delete environment.DOCKER_CONTEXT;
  delete environment.DOCKER_TLS_VERIFY;
  delete environment.DOCKER_CERT_PATH;
  const child = spawn("docker", arguments_, {
    cwd: root,
    env: environment,
    stdio: ["ignore", captureOutput ? "pipe" : "inherit", "inherit"],
    shell: false,
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.once("error", () => reject(new Error("The local Docker command could not start.")));
  child.once("exit", (code) => {
    if (code === 0) resolveExit(output.trim());
    else reject(new Error(`The local Docker command failed with exit code ${code ?? 1}.`));
  });
  return promise;
}
