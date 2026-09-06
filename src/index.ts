import { handleCommand } from "./commands";
import {
  InteractionType,
  ResponseType,
  json,
  message,
  verifyDiscordRequest,
} from "./discord/protocol";
import type { Env } from "./env";
import { GameSession } from "./games/game-session";
import { GatewayPresence } from "./discord/gateway";
import { admin } from "./discord/admin";
import type { DiscordInteraction, InteractionResponse } from "./discord/protocol";

export { GameSession, GatewayPresence };

function responseForEnvironment(response: InteractionResponse, environment: string): Response {
  for (const row of response.data?.components ?? []) {
    for (const button of row.components ?? []) {
      if (button.custom_id) button.custom_id = `${environment}:${button.custom_id}`;
    }
  }
  if (environment === "dev" && response.data?.content)
    response.data.content = `[DEV] ${response.data.content}`;
  return json(response);
}

async function runInteraction(interaction: DiscordInteraction, env: Env): Promise<Response> {
  const environment = env.APP_ENV === "local" || env.APP_ENV === "staging" ? "dev" : "prod";
  if (interaction.type === InteractionType.ApplicationCommand)
    return responseForEnvironment(await handleCommand(env, interaction), environment);
  if (interaction.type === InteractionType.MessageComponent) {
    const customId = interaction.data?.custom_id ?? "";
    const tagged = customId.startsWith("prod:") || customId.startsWith("dev:");
    if ((tagged && !customId.startsWith(`${environment}:`)) || (!tagged && environment !== "prod"))
      return json(
        message(
          "This button belongs to a different environment. Run the command again in the current environment.",
          true
        )
      );
    const normalized = tagged ? customId.slice(environment.length + 1) : customId;
    const [prefix, gameId] = normalized.split(":");
    if (prefix !== "game" || !gameId)
      return json(message("This component is not attached to a game.", true));
    const component = { ...interaction, data: { ...interaction.data, custom_id: normalized } };
    const response = await env.GAME_SESSIONS.get(env.GAME_SESSIONS.idFromName(gameId)).fetch(
      "https://game/component",
      { method: "POST", body: JSON.stringify({ action: "component", interaction: component }) }
    );
    // SAFETY: GameSession only returns an InteractionResponse object.
    return responseForEnvironment((await response.json()) as InteractionResponse, environment);
  }
  return json(message("This Discord interaction is not supported yet.", true));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (
      env.APP_ENV === "local" &&
      request.method === "GET" &&
      new URL(request.url).pathname === "/__dev/health"
    )
      return Response.json({
        environment: "local",
        guildId: env.TEST_GUILD_ID,
        gateway: "disabled",
      });
    if (new URL(request.url).pathname.startsWith("/admin/")) return admin(request, env);
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!env.DISCORD_PUBLIC_KEY)
      return new Response("Discord public key is not configured.", { status: 500 });
    const body = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!body) return new Response("Invalid request signature.", { status: 401 });
    // SAFETY: signature verification authenticates Discord; routing fields are checked before use.
    const interaction = JSON.parse(body) as DiscordInteraction;
    if (!interaction || !Number.isInteger(interaction.type))
      return new Response("Invalid interaction", { status: 400 });
    if (interaction.type === InteractionType.Ping) return json({ type: ResponseType.Pong });
    if (
      env.APP_ENV === "local" &&
      (!env.TEST_GUILD_ID || interaction.guild_id !== env.TEST_GUILD_ID)
    )
      return json(message("Local dev accepts only the configured test server.", true));
    if (
      env.APP_ENV === "production" &&
      env.TEST_GUILD_ID &&
      interaction.guild_id === env.TEST_GUILD_ID
    ) {
      const routed = await env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("singleton")).fetch(
        "https://bot/route",
        {
          method: "POST",
          headers: request.headers,
          body,
        }
      );
      if (routed.status !== 204) return routed;
    }
    return runInteraction(interaction, env);
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.APP_ENV !== "production" || env.GATEWAY_ENABLED !== "true") return;
    await env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("singleton")).fetch("https://bot/ensure");
  },
};
