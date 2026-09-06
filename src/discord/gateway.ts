import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { forwardToDev, tunnelUrl, type DevRoute } from "./dev-route";

interface Session {
  id: string;
  url: string;
  sequence: number;
}

interface ConnectionState {
  attempts: number;
  nextAttemptAt: number;
  identifyAfter: number;
  stopped?: string;
  session?: Session;
}

interface GatewayPacket {
  op: number;
  s?: number;
  t?: string;
  d?:
    | {
        heartbeat_interval?: number;
        session_id?: string;
        resume_gateway_url?: string;
      }
    | boolean
    | null;
}

interface GatewayDiscovery {
  url: string;
  shards: number;
  session_start_limit: { remaining: number; reset_after: number };
}

interface GatewayIdentify {
  token: string;
  intents: number;
  properties: { os: string; browser: string; device: string };
  presence: { status: string; since: null; activities: never[]; afk: boolean };
}

interface GatewayResume {
  token: string;
  session_id: string;
  seq: number;
}

const INITIAL_STATE: ConnectionState = { attempts: 0, nextAttemptAt: 0, identifyAfter: 0 };
const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

function gatewayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "wss:" || !url.hostname.endsWith(".discord.gg"))
    throw new Error("Invalid Discord Gateway URL.");
  url.search = "?v=10&encoding=json";
  return url.href;
}

/** One production instance owns presence. HTTP interactions still own command delivery. */
export class GatewayPresence extends DurableObject<Env> {
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private acknowledged = true;
  private helloReceived = false;
  private readyAt = 0;
  private connecting = false;
  private state: ConnectionState = { ...INITIAL_STATE };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<ConnectionState>("connection")) ?? { ...INITIAL_STATE };
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/route")
      return forwardToDev(request, await this.ctx.storage.get<DevRoute>("dev-route"));
    if (path === "/dev") return this.configureDev(request);
    if (path === "/restart" && request.method === "POST") {
      this.disconnect();
      delete this.state.stopped;
      delete this.state.session;
      await this.save();
    }
    if (path === "/status")
      return Response.json({
        gateway: this.readyAt ? "ready" : (this.state.stopped ?? "disconnected"),
        nextAttemptAt: this.state.nextAttemptAt,
        testGuildId: this.env.TEST_GUILD_ID || null,
        route: (await this.ctx.storage.get<DevRoute>("dev-route")) ?? null,
      });
    if (this.env.APP_ENV !== "production" || this.env.GATEWAY_ENABLED !== "true") {
      this.disconnect();
      return Response.json({ status: "disabled" });
    }
    if (this.socket?.readyState === WebSocket.OPEN || this.connecting) {
      if (this.readyAt && Date.now() - this.readyAt >= 5 * 60_000 && this.state.attempts) {
        this.state.attempts = 0;
        await this.save();
      }
      return Response.json({ status: this.readyAt ? "ready" : "connecting" });
    }
    if (this.state.stopped || Date.now() < this.state.nextAttemptAt)
      return Response.json({
        status: this.state.stopped ?? "backoff",
        nextAttemptAt: this.state.nextAttemptAt,
      });
    this.connecting = true;
    try {
      await this.openGateway();
    } catch {
      this.disconnect();
      console.error(
        "Discord Gateway connection failed; the scheduled watchdog will retry after backoff."
      );
    } finally {
      this.connecting = false;
    }
    return Response.json({ status: this.socket ? "connecting" : "backoff" });
  }

  private async openGateway(): Promise<void> {
    const now = Date.now();
    this.state.attempts += 1;
    this.state.nextAttemptAt =
      now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(this.state.attempts - 1, 4));
    await this.save();
    let url = this.state.session?.url;
    if (!url) {
      if (now < this.state.identifyAfter) return;
      const response = await fetch("https://discord.com/api/v10/gateway/bot", {
        headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 || response.status === 403) {
        this.state.stopped = "invalid-token";
        await this.save();
        return;
      }
      if (!response.ok) throw new Error("Gateway discovery failed.");
      // SAFETY: Discord's authenticated endpoint supplies this contract; fields are checked below.
      const discovery = (await response.json()) as GatewayDiscovery;
      if (!Number.isSafeInteger(discovery.shards) || discovery.shards !== 1) {
        this.state.stopped = "sharding-required";
        await this.save();
        return;
      }
      if (
        !Number.isFinite(discovery.session_start_limit?.remaining) ||
        !Number.isFinite(discovery.session_start_limit?.reset_after)
      )
        throw new Error("Invalid Gateway session limits.");
      if (discovery.session_start_limit.remaining < 10) {
        this.state.nextAttemptAt =
          now + Math.max(60_000, discovery.session_start_limit.reset_after);
        await this.save();
        return;
      }
      url = discovery.url;
      // Also survive object restarts without burning through Discord's IDENTIFY budget.
      this.state.identifyAfter = now + 120_000;
      await this.save();
    }
    const socket = new WebSocket(gatewayUrl(url));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.acknowledged = true;
    this.helloReceived = false;
    this.deadline = setTimeout(() => this.disconnect(), 30_000);
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.ctx.waitUntil(
        this.receive(event.data).catch(() => {
          this.disconnect();
          console.error("Discord Gateway protocol failure; reconnect scheduled.");
        })
      );
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.disconnect();
      if (FATAL_CODES.has(event.code)) this.state.stopped = `discord-close-${event.code}`;
      if ([4007, 4009].includes(event.code)) delete this.state.session;
      this.ctx.waitUntil(this.save());
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.disconnect();
    });
  }

  private async configureDev(request: Request): Promise<Response> {
    if (!this.env.TEST_GUILD_ID)
      return new Response("Configure TEST_GUILD_ID before switching.", { status: 409 });
    if (request.method === "DELETE") {
      await this.ctx.storage.put<DevRoute>("dev-route", { mode: "production" });
      return Response.json({ mode: "production", testGuildId: this.env.TEST_GUILD_ID });
    }
    if (request.method !== "PUT" && request.method !== "PATCH")
      return new Response("Method not allowed", { status: 405 });
    try {
      // SAFETY: this internal endpoint is reached only after admin authentication; fields are validated.
      const payload = (await request.json()) as { url?: string; lease?: string };
      if (!payload?.url || !payload.lease || !/^[a-zA-Z0-9-]{16,80}$/.test(payload.lease))
        return new Response("Invalid dev lease", { status: 400 });
      const route: DevRoute = {
        mode: "development",
        url: tunnelUrl(payload.url),
        lease: payload.lease,
        expiresAt: Date.now() + 120_000,
      };
      if (request.method === "PUT") {
        try {
          const healthResponse = await fetch(`${route.url}/__dev/health`, {
            redirect: "manual",
            signal: AbortSignal.timeout(2500),
          });
          if (!healthResponse.ok) {
            const errorCode = (await healthResponse.text()).match(/error code: (\d{4})/i)?.[1];
            return new Response(
              `Tunnel health returned HTTP ${healthResponse.status}${errorCode ? ` (Cloudflare ${errorCode})` : ""}.`,
              {
                status: 503,
              }
            );
          }
          // SAFETY: only the validated tunnel origin is queried; verify its local-health contract.
          const health = (await healthResponse.json()) as {
            environment?: string;
            guildId?: string;
          };
          if (
            !healthResponse.ok ||
            health.environment !== "local" ||
            health.guildId !== this.env.TEST_GUILD_ID
          )
            return new Response("Tunnel is not serving the expected local environment.", {
              status: 503,
            });
        } catch {
          return new Response("Tunnel is not reachable from production yet.", { status: 503 });
        }
      }
      const current = await this.ctx.storage.get<DevRoute>("dev-route");
      if (
        request.method === "PATCH" &&
        (current?.mode !== "development" || current.lease !== route.lease)
      )
        return new Response("Dev session was replaced or switched to production.", { status: 409 });
      if (
        current?.mode === "development" &&
        current.expiresAt > Date.now() &&
        current.lease !== route.lease
      )
        return new Response("Another dev session is active. Stop it before starting a new one.", {
          status: 409,
        });
      await this.ctx.storage.put("dev-route", route);
      return Response.json({ mode: route.mode, testGuildId: this.env.TEST_GUILD_ID });
    } catch {
      return new Response("Invalid dev tunnel configuration", { status: 400 });
    }
  }

  private async receive(data: string | ArrayBuffer): Promise<void> {
    if (data instanceof ArrayBuffer || data.length > 1_000_000)
      throw new Error("Unsupported Gateway packet.");
    // SAFETY: JSON is untrusted; only opcode-specific checked fields are consumed below.
    const packet = JSON.parse(data) as GatewayPacket;
    if (!packet || !Number.isInteger(packet.op)) throw new Error("Invalid Gateway opcode.");
    if (packet.op === 10) {
      if (this.helloReceived) throw new Error("Duplicate Gateway hello.");
      this.helloReceived = true;
      const hello = packet.d;
      if (!hello || hello === true) throw new Error("Invalid Gateway hello.");
      const interval = hello.heartbeat_interval;
      if (!interval || !Number.isFinite(interval) || interval < 1000 || interval > 120_000)
        throw new Error("Invalid heartbeat interval.");
      clearTimeout(this.heartbeat);
      this.heartbeat = setTimeout(() => this.beat(interval), Math.random() * interval);
      const session = this.state.session;
      this.send(
        session ? 6 : 2,
        session
          ? {
              token: this.env.DISCORD_BOT_TOKEN,
              session_id: session.id,
              seq: session.sequence,
            }
          : {
              token: this.env.DISCORD_BOT_TOKEN,
              intents: 0,
              properties: {
                os: "linux",
                browser: "chip-minigame-parlor",
                device: "chip-minigame-parlor",
              },
              presence: { status: "online", since: null, activities: [], afk: false },
            }
      );
    } else if (packet.op === 11) {
      this.acknowledged = true;
    } else if (packet.op === 1) {
      this.send(1, this.state.session?.sequence ?? null);
    } else if (packet.op === 7 || packet.op === 9) {
      if (packet.op === 9 && packet.d !== true) delete this.state.session;
      this.disconnect();
      await this.save();
    } else if (packet.op === 0) {
      if (!Number.isSafeInteger(packet.s)) throw new Error("Invalid Gateway sequence.");
      if (packet.t === "READY") {
        const ready = packet.d;
        if (!ready || ready === true || !ready.session_id || !ready.resume_gateway_url)
          throw new Error("Invalid Gateway ready packet.");
        this.state.session = {
          id: ready.session_id,
          url: gatewayUrl(ready.resume_gateway_url),
          sequence: packet.s!,
        };
      }
      if (this.state.session) this.state.session.sequence = packet.s!;
      if (packet.t === "READY" || packet.t === "RESUMED") {
        clearTimeout(this.deadline);
        this.readyAt = Date.now();
      }
      await this.save();
    }
  }

  private beat(interval: number): void {
    if (!this.acknowledged) {
      this.disconnect();
      return;
    }
    this.acknowledged = false;
    try {
      this.send(1, this.state.session?.sequence ?? null);
      this.heartbeat = setTimeout(() => this.beat(interval), interval);
    } catch {
      this.disconnect();
    }
  }

  private send(op: number, d: GatewayIdentify | GatewayResume | number | null): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Gateway is not open.");
    this.socket.send(JSON.stringify({ op, d }));
  }

  private disconnect(): void {
    clearTimeout(this.heartbeat);
    clearTimeout(this.deadline);
    const socket = this.socket;
    this.socket = undefined;
    this.readyAt = 0;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(4000, "Reconnect");
  }

  private save(): Promise<void> {
    return this.ctx.storage.put("connection", this.state);
  }
}
