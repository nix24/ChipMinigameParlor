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

export { GameSession };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!env.DISCORD_PUBLIC_KEY)
      return new Response("Discord public key is not configured.", { status: 500 });
    const body = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!body) return new Response("Invalid request signature.", { status: 401 });
    // SAFETY: Discord signs the raw request body after its public-key verification succeeds.
    const interaction = JSON.parse(body) as import("./discord/protocol").DiscordInteraction;
    if (interaction.type === InteractionType.Ping) return json({ type: ResponseType.Pong });
    if (interaction.type === InteractionType.ApplicationCommand)
      return json(await handleCommand(env, interaction));
    if (interaction.type === InteractionType.MessageComponent) {
      const gameId = interaction.data?.custom_id?.split(":")[1];
      if (!gameId) return json(message("This component is not attached to a game.", true));
      const response = await env.GAME_SESSIONS.get(env.GAME_SESSIONS.idFromName(gameId)).fetch(
        "https://game/component",
        { method: "POST", body: JSON.stringify({ action: "component", interaction }) }
      );
      // SAFETY: GameSession only returns an InteractionResponse object.
      return json((await response.json()) as import("./discord/protocol").InteractionResponse);
    }
    return json(message("This Discord interaction is not supported yet.", true));
  },
};
