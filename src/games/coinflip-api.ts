import { z } from "zod";
import { EconomyRepository } from "../db/repository";
import type { Env } from "../env";
import { MAX_COIN_FLIP_STAKE, settleCoinFlip } from "./coinflip";

const snowflake = z.string().regex(/^\d{17,20}$/);
const sessionRequest = z.object({ code: z.string().min(1).max(512), guildId: snowflake }).strict();
const wagerRequest = z
  .object({
    roundId: z.string().uuid(),
    amount: z.number().int().min(1).max(MAX_COIN_FLIP_STAKE),
    choice: z.enum(["heads", "tails"]),
  })
  .strict();
const sessionClaims = z
  .object({
    userId: snowflake,
    guildId: snowflake,
    environment: z.string(),
    clientId: snowflake,
    expiresAt: z.number().int(),
  })
  .strict();
const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const memberResponse = z.object({
  user: z.object({ id: snowflake }),
  pending: z.boolean().optional(),
});
const encoder = new TextEncoder();
const API = "https://discord.com/api/v10";

class ActivityError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function reply<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function bodyText(request: Request): Promise<string> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new ActivityError(415, "Send a JSON request.");
  const reader = request.body?.getReader();
  if (!reader) throw new ActivityError(400, "The request is empty.");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw new ActivityError(413, "The request is too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`coinflip-session-v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signSession(claims: z.infer<typeof sessionClaims>, secret: string): Promise<string> {
  const payload = btoa(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(payload)
  );
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

async function authenticate(request: Request, env: Env, secret: string) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (token.length > 1024 || !/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(token))
    throw new ActivityError(401, "Reconnect to Discord to keep playing.");
  const [payload, signature] = token.split(".");
  let claims;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)),
      encoder.encode(payload)
    );
    if (!valid) throw new ActivityError(401, "Your session could not be verified.");
    claims = sessionClaims.parse(JSON.parse(atob(payload)));
  } catch {
    throw new ActivityError(401, "Reconnect to Discord to keep playing.");
  }
  if (
    claims.expiresAt <= Date.now() ||
    claims.environment !== env.APP_ENV ||
    claims.clientId !== env.DISCORD_CLIENT_ID
  )
    throw new ActivityError(401, "Reconnect to Discord to keep playing.");
  await assertGuild(claims.guildId, env);
  return claims;
}

async function assertGuild(guildId: string, env: Env): Promise<void> {
  if (env.APP_ENV === "local" && (!env.TEST_GUILD_ID || env.TEST_GUILD_ID !== guildId))
    throw new ActivityError(403, "Local play is only available in the test server.");
  if (env.APP_ENV === "production" && guildId === env.TEST_GUILD_ID) {
    const status = await env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("singleton")).fetch(
      "https://bot/status"
    );
    const control = z
      .object({ route: z.object({ mode: z.string() }).nullable() })
      .parse(await status.json());
    if (control.route?.mode !== "production")
      throw new ActivityError(
        403,
        "Server chips aren't available in this test session. Practice is open."
      );
  }
}

async function discord(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
  if (response.status === 429)
    throw new ActivityError(429, "Discord is busy. Wait a moment, then reconnect.");
  if (response.status >= 500)
    throw new ActivityError(503, "Discord is unavailable. Try reconnecting shortly.");
  return response;
}

async function connect(request: Request, env: Env, secret: string): Promise<Response> {
  const { code, guildId } = sessionRequest.parse(JSON.parse(await bodyText(request)));
  await assertGuild(guildId, env);
  const exchange = await discord("/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: secret,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!exchange.ok)
    throw new ActivityError(401, "Discord authorization expired. Reconnect to try again.");
  const token = tokenResponse.parse(await exchange.json());
  // This user-token endpoint verifies both identity and membership, never a client-supplied user ID.
  const membership = await discord(`/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!membership.ok)
    throw new ActivityError(403, "Join this server and authorize membership access to play.");
  const member = memberResponse.parse(await membership.json());
  if (member.pending)
    throw new ActivityError(403, "Finish this server's membership screening before playing.");
  const claims = {
    userId: member.user.id,
    guildId,
    clientId: env.DISCORD_CLIENT_ID,
    environment: env.APP_ENV,
    expiresAt: Date.now() + Math.min(15 * 60, token.expires_in) * 1000,
  };
  return reply({
    accessToken: token.access_token,
    session: await signSession(claims, secret),
    userId: claims.userId,
    chips: await new EconomyRepository(env).balance(claims.userId, guildId),
  });
}

export async function coinflipApi(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/activity/config" && request.method === "GET")
    return reply({
      clientId: env.DISCORD_CLIENT_ID,
      maxStake: MAX_COIN_FLIP_STAKE,
      environment: env.APP_ENV,
    });
  if (request.method !== "POST") return reply({ error: "This route requires POST." }, 405);
  const secret = env.DISCORD_CLIENT_SECRET;
  if (!secret)
    return reply({ error: "Server chips are not connected yet. Practice is ready to play." }, 503);
  try {
    if (path === "/api/activity/session") return await connect(request, env, secret);
    if (path !== "/api/activity/flip") return reply({ error: "Unknown Activity route." }, 404);
    const claims = await authenticate(request, env, secret);
    const wager = wagerRequest.parse(JSON.parse(await bodyText(request)));
    const result = await settleCoinFlip(new EconomyRepository(env), {
      transactionId: `activity:coinflip:${claims.guildId}:${claims.userId}:${wager.roundId}`,
      userId: claims.userId,
      guildId: claims.guildId,
      amount: wager.amount,
      choice: wager.choice,
    });
    return reply(result);
  } catch (error) {
    if (error instanceof ActivityError) return reply({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return reply(
        { error: "The request could not be read. Check your wager and try again." },
        400
      );
    // Never log OAuth bodies, bearer tokens, or database errors containing player identifiers.
    console.error("Coinflip Activity request failed", {
      operation: path.endsWith("/flip") ? "settle" : "connect",
    });
    return reply(
      { error: "The result could not be confirmed. Retry this round to check it safely." },
      503
    );
  }
}
