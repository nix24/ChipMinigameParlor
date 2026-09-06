import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { botAdmin } from "./bot-admin-client";
import { startTunnelProxy } from "./dev-tunnel-proxy";

const children: ChildProcess[] = [];
const stopped = new AbortController();
function stop(): void {
  stopped.abort();
  for (const child of children) child.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", stop);

function launch(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.once("error", () => stop());
  child.once("exit", () => stop());
  return child;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (stopped.signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      stopped.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stopped.signal.addEventListener("abort", done, { once: true });
  });
}

async function localReady(origin: string, guildId: string): Promise<void> {
  for (let attempt = 0; attempt < 60 && !stopped.signal.aborted; attempt += 1) {
    try {
      const response = await fetch(`${origin}/__dev/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        // SAFETY: this startup check verifies the expected local-only health contract.
        const health = (await response.json()) as { environment?: string; guildId?: string };
        if (health.environment === "local" && health.guildId === guildId) return;
      }
    } catch {
      /* The local process is still starting; retry within the startup deadline. */
    }
    await pause(500);
  }
  throw new Error(
    `Dev health check failed for ${origin}; expected local mode and server ${guildId}.`
  );
}

async function tunnelOrigin(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let tail = "";
    const timer = setTimeout(
      () => reject(new Error("Cloudflare tunnel did not start within 30 seconds.")),
      30_000
    );
    const read = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).slice(-4096);
      const match = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Cloudflare tunnel exited."));
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not start cloudflared."));
    });
  });
}

try {
  if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0)
    throw new Error("cloudflared is required. Install it with brew install cloudflared.");
  const response = await botAdmin("status");
  // SAFETY: the authenticated status endpoint supplies the guild; validate it before passing to Wrangler.
  const status = (await response.json()) as { testGuildId?: string };
  if (!status.testGuildId || !/^\d{17,20}$/.test(status.testGuildId))
    throw new Error("Configure the production TEST_GUILD_ID before starting Discord dev.");
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.DISCORD_PUBLIC_KEY ?? ""))
    throw new Error("Set DISCORD_PUBLIC_KEY in .dev.vars.");
  const migration = spawnSync("bun", ["run", "db:migrate:local"], { stdio: "inherit" });
  if (migration.status !== 0) throw new Error("Local database migrations failed.");
  const port = 8790;
  // Refuse to accidentally tunnel an unrelated process already listening on our port.
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
  const worker = launch("bun", [
    "x",
    "--no-install",
    "wrangler",
    "dev",
    "--env",
    "local",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--var",
    `TEST_GUILD_ID:${status.testGuildId}`,
  ]);
  worker.stdout?.pipe(process.stdout);
  worker.stderr?.pipe(process.stderr);
  console.log("Waiting for the local Worker...");
  await localReady(`http://127.0.0.1:${port}`, status.testGuildId);
  const proxy = await startTunnelProxy(port, stopped.signal);
  const address = proxy.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's address API also supports Unix sockets; require its TCP contract here.
  if (!address || typeof address === "string")
    throw new Error("Local tunnel proxy has no TCP address.");
  const tunnel = launch("cloudflared", [
    "tunnel",
    "--no-autoupdate",
    "--url",
    `http://127.0.0.1:${address.port}`,
  ]);
  const url = await tunnelOrigin(tunnel);
  console.log(`Local Worker ready. Production is checking ${url}...`);
  const lease = randomUUID();
  if (stopped.signal.aborted) throw new Error("Dev startup cancelled.");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await botAdmin("dev", "PUT", { url, lease });
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("HTTP 503") ||
        attempt >= 59 ||
        stopped.signal.aborted
      )
        throw error;
      await pause(2000);
    }
  }
  console.log(`DEV connected for server ${status.testGuildId}. Other servers stay on production.`);
  console.log(
    "Ctrl+C stops local dev. Test commands then fail closed. Use bun run bot:prod to explicitly switch the test server to production."
  );
  while (!stopped.signal.aborted) {
    await pause(30_000);
    if (stopped.signal.aborted) break;
    await botAdmin("dev", "PATCH", { url, lease });
  }
} finally {
  stop();
}
