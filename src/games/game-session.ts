import { DurableObject } from "cloudflare:workers";
import {
  ResponseType,
  type DiscordComponent,
  type DiscordInteraction,
  type InteractionResponse,
  userId,
} from "../discord/protocol";
import type { Env } from "../env";

type Phase = "lobby" | "running" | "expired";
interface GameState {
  gameId: string;
  game: string;
  guildId: string;
  hostId: string;
  players: string[];
  phase: Phase;
  expiresAt: number;
}
interface SessionRequest {
  action: "init" | "component";
  interaction?: DiscordInteraction;
  gameId?: string;
  game?: string;
  guildId?: string;
  hostId?: string;
}

const LOBBY_MS = 10 * 60_000;

export class GameSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    // SAFETY: only the Worker router invokes this internal Durable Object endpoint.
    const payload = (await request.json()) as SessionRequest;
    if (payload.action === "init") return Response.json(await this.initialize(payload));
    if (payload.action === "component" && payload.interaction)
      return Response.json(await this.component(payload.interaction));
    return Response.json(
      {
        type: ResponseType.ChannelMessage,
        data: { content: "Invalid game-session request.", flags: 64 },
      },
      { status: 400 }
    );
  }

  async alarm(): Promise<void> {
    const game = await this.read();
    if (game.phase === "lobby" && game.expiresAt <= Date.now())
      await this.write({ ...game, phase: "expired" });
  }

  private async initialize(payload: SessionRequest): Promise<InteractionResponse> {
    if (!payload.gameId || !payload.game || !payload.guildId || !payload.hostId)
      throw new Error("Incomplete game initialization.");
    const existing = await this.ctx.storage.get<GameState>("game");
    if (!existing) {
      const game: GameState = {
        gameId: payload.gameId,
        game: payload.game,
        guildId: payload.guildId,
        hostId: payload.hostId,
        players: [payload.hostId],
        phase: "lobby",
        expiresAt: Date.now() + LOBBY_MS,
      };
      await this.write(game);
      await this.ctx.storage.setAlarm(game.expiresAt);
    }
    return this.render(await this.read(), ResponseType.ChannelMessage);
  }

  private async component(interaction: DiscordInteraction): Promise<InteractionResponse> {
    const actorId = userId(interaction);
    const action = interaction.data?.custom_id?.split(":")[2];
    if (!actorId || !action)
      return {
        type: ResponseType.ChannelMessage,
        data: { content: "This interaction is invalid.", flags: 64 },
      };
    const game = await this.read();
    if (game.phase === "expired")
      return {
        type: ResponseType.ChannelMessage,
        data: { content: "This lobby expired.", flags: 64 },
      };
    if (action === "join" && !game.players.includes(actorId)) {
      if (game.players.length >= 4)
        return {
          type: ResponseType.ChannelMessage,
          data: { content: "Big Blast already has four players.", flags: 64 },
        };
      await this.write({ ...game, players: [...game.players, actorId] });
    }
    if (action === "start") {
      if (actorId !== game.hostId)
        return {
          type: ResponseType.ChannelMessage,
          data: { content: "Only the lobby host can start Big Blast.", flags: 64 },
        };
      if (game.players.length < 2)
        return {
          type: ResponseType.ChannelMessage,
          data: { content: "Big Blast needs at least two players.", flags: 64 },
        };
      await this.write({ ...game, phase: "running" });
    }
    return this.render(await this.read(), ResponseType.UpdateMessage);
  }

  private async read(): Promise<GameState> {
    const game = await this.ctx.storage.get<GameState>("game");
    if (!game) throw new Error("Game session was not initialized.");
    return game;
  } 

  private async write(game: GameState): Promise<void> {
    await this.ctx.storage.put("game", game);
  }

  private render(game: GameState, type: number): InteractionResponse {
    const components: DiscordComponent[] =
      game.phase === "lobby"
        ? [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 1,
                  label: "Join",
                  custom_id: `game:${game.gameId}:join`,
                  disabled: game.players.length >= 4,
                },
                {
                  type: 2,
                  style: 3,
                  label: "Start",
                  custom_id: `game:${game.gameId}:start`,
                  disabled: game.players.length < 2,
                },
              ],
            },
          ]
        : [];
    const status =
      game.phase === "running"
        ? "Big Blast has started. Game-turn mechanics are the next implementation slice."
        : `Big Blast lobby: ${game.players.length}/4 players. The host can start with two or more players.`;
    return { type, data: { content: status, components } };
  }
}
