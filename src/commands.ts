import { EconomyRepository } from "./db/repository";
import {
  message,
  type DiscordInteraction,
  type InteractionResponse,
  userId,
} from "./discord/protocol";
import type { Env } from "./env";

export const applicationCommands = [
  "balance",
  "daily",
  "fishing",
  "leaderboard",
  "sell",
  "8ball",
  "bigblast",
  "blackcat",
  "catheist",
  "coinflip",
  "connect4tress",
  "roguelite",
].map((name) =>
  name === "coinflip"
    ? {
        name,
        description: "Bet chips on a coin flip.",
        options: [
          {
            name: "amount",
            description: "How many chips to bet.",
            type: 4,
            required: true,
            min_value: 1,
          },
          {
            name: "choice",
            description: "Choose Heads or Tails.",
            type: 3,
            required: true,
            choices: [
              { name: "Heads", value: "heads" },
              { name: "Tails", value: "tails" },
            ],
          },
        ],
      }
    : { name, description: `${name} command` }
);

const inProgress = (name: string): InteractionResponse =>
  message(`/${name} is registered and will be implemented after Big Blast.`, true);

function coinFlipStake(value: string | number | boolean | undefined): number | undefined {
  if (value === undefined || value === true || value === false) return undefined;
  const stake = Number(value);
  return Number.isSafeInteger(stake) && stake > 0 ? stake : undefined;
}

export async function handleCommand(
  env: Env,
  interaction: DiscordInteraction
): Promise<InteractionResponse> {
  const name = interaction.data?.name;
  const actorId = userId(interaction);
  const guildId = interaction.guild_id;
  if (!name || !actorId || !guildId)
    return message("This command can only run inside a server.", true);
  const economy = new EconomyRepository(env);
  if (name === "balance")
    return message(
      `You have ${await economy.balance(actorId, guildId)} chips in this server.`,
      true
    );
  if (name === "daily") {
    const result = await economy.claimDaily(actorId, guildId);
    return message(
      result.claimed
        ? `Daily claimed. Balance: ${result.chips} chips.`
        : `Your daily reward is not ready. Balance: ${result.chips} chips.`,
      true
    );
  }
  if (name === "leaderboard") {
    const leaders = await economy.leaderboard(guildId);
    return message(
      leaders.length
        ? leaders
            .map((leader, index) => `${index + 1}. <@${leader.userId}>: ${leader.chips}`)
            .join("\n")
        : "No leaderboard entries yet."
    );
  }
  if (name === "bigblast") {
    const id = env.GAME_SESSIONS.idFromName(interaction.id);
    const response = await env.GAME_SESSIONS.get(id).fetch("https://game/init", {
      method: "POST",
      body: JSON.stringify({
        action: "init",
        gameId: interaction.id,
        game: name,
        guildId,
        hostId: actorId,
      }),
    });
    // SAFETY: GameSession only returns an InteractionResponse object.
    return (await response.json()) as InteractionResponse;
  }
  if (name === "coinflip") {
    const amount = coinFlipStake(
      interaction.data?.options?.find((option) => option.name === "amount")?.value
    );
    const choice = interaction.data?.options?.find((option) => option.name === "choice")?.value;
    if (amount === undefined)
      return message("Choose a whole-number wager of at least 1 chip.", true);
    if (choice !== "heads" && choice !== "tails")
      return message("Choose either Heads or Tails.", true);

    const result = crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0 ? "heads" : "tails";
    const won = result === choice;
    const settlement = await economy.settleCoinFlip(actorId, guildId, amount, won);
    if (!settlement.settled)
      return message(
        `You don't have enough chips. Your balance is ${settlement.chips} chips.`,
        true
      );
    const outcome = result === "heads" ? "Heads" : "Tails";
    return message(
      `The coin landed on **${outcome}**. You ${won ? "won" : "lost"} **${amount}** chips. New balance: **${settlement.chips}**.`
    );
  }
  if (name === "roguelite")
    return message(
      `Roguelite run ${await economy.resumeRun(actorId, guildId)} is saved and ready for its game loop.`,
      true
    );
  return inProgress(name);
}
