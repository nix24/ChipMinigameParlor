// src/commands/games/catheist.command.ts
import type { EconomyService } from "@/services/economy.service";
import type { LoggerService } from "@/services/logger.service";
import type { Card } from "@/types/types";
import { createDeck, renderHand, shuffleDeck } from "@/utils/blackcat.logic"; // Reuse deck logic
import { dealPokerHands, evaluatePokerHands, getHandRankName } from "@/utils/poker.logic"; // Use poker logic
import {
    ActionRowBuilder,
    ButtonBuilder,
    type ButtonInteraction,
    ButtonStyle,
    type CacheType,
    type ChatInputCommandInteraction,
    ComponentType,
    EmbedBuilder,
    type InteractionCollector,
    type Message,
    SlashCommandBuilder,
    type SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import type { PrismaClient } from "generated/prisma";
import { z } from "zod";

// --- Game State ---
interface PlayerInfo { // Reusing from BigBlast for consistency, though only 1 human here
    userId: string;
    displayName: string;
    isCPU: boolean;
}

interface CatHeistGameState {
    gameId: string;
    gameType: 'CatHeist';
    userId: string;
    guildId: string;
    player: PlayerInfo;
    cpu: PlayerInfo;
    playerHand: Card[];
    cpuHand: Card[];
    playerScore: number;
    cpuScore: number;
    currentRound: number;
    wager: bigint;
    potentialLoss: bigint; // Store calculated 25% loss
    status: 'confirm_start' | 'round_start' | 'round_reveal' | 'finished';
    result: 'win' | 'lose' | 'tie' | null;
    interaction: ChatInputCommandInteraction;
    message: Message;
    collector?: InteractionCollector<ButtonInteraction<CacheType>>;
}

const activeGames = new Map<string, CatHeistGameState>(); // Separate map for clarity
const CONFIRM_TIMEOUT = 30000; // 30 seconds to confirm start
const ROUND_TIMEOUT = 60000; // 60 seconds between rounds/reveals

// --- Zod Schema ---
const optionsSchema = z.object({
    wager: z.number().int().positive("Wager must be positive."),
});

// --- Command Interface ---
export interface Command {
    data: SlashCommandOptionsOnlyBuilder | SlashCommandBuilder; // Adjust as needed
    execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void>;
}

// --- Command Implementation ---
class CatHeistCommand implements Command {
    data = new SlashCommandBuilder()
        .setName("catheist")
        .setDescription("Risk it all in a best-of-3 poker game against the house!")
        .addIntegerOption((option) =>
            option
                .setName("wager")
                .setDescription("Amount of chips to wager.")
                .setRequired(true)
                .setMinValue(1),
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void> {
        const { economy } = services;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "Cat Heist can only be played in a server.", ephemeral: true });
            return;
        }

        // 1. Validate Wager
        const validation = optionsSchema.safeParse({
            wager: interaction.options.getInteger("wager", true),
        });
        if (!validation.success) {
            await interaction.reply({ content: `Invalid wager: ${validation.error.errors.map(e => e.message).join(', ')}`, ephemeral: true });
            return;
        }
        const wager = BigInt(validation.data.wager);

        // 2. Check Balance & Calculate Potential Loss
        const balanceResult = await economy.getBalance(userId, guildId);
        if (!balanceResult.success || balanceResult.balance === null) {
            await interaction.reply({ content: "Could not check your balance.", ephemeral: true });
            return;
        }
        if (balanceResult.balance < wager) {
            await interaction.reply({ content: `You don't have enough chips (${balanceResult.balance}) to bet ${wager}.`, ephemeral: true });
            return;
        }

        const potentialLoss = balanceResult.balance / 4n; // BigInt division truncates, which is fine

        // 3. Confirmation Step
        const gameId = interaction.id;
        if (activeGames.has(gameId)) {
            await interaction.reply({ content: "You already have a game in progress.", ephemeral: true });
            return;
        }

        const confirmId = `catheist_confirm_${gameId}`;
        const cancelId = `catheist_cancel_${gameId}`;
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(confirmId).setLabel("Confirm Heist!").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Danger)
        );

        const confirmEmbed = new EmbedBuilder()
            .setTitle("💰 Cat Heist - Confirmation 💰")
            .setColor(0xFFCC00) // Yellow/Gold
            .setDescription("Are you sure you want to start the heist?")
            .addFields(
                { name: "Your Wager", value: `**${wager}** chips`, inline: true },
                { name: "Win Payout", value: `**${wager * 2n}** chips (Total: ${wager * 3n})`, inline: true },
                { name: "🚨 LOSS PENALTY 🚨", value: `Lose **${potentialLoss}** chips (25% of your current balance: ${balanceResult.balance})`, inline: false }
            )
            .setFooter({ text: "Confirm within 30 seconds." });

        const message = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === userId && (i.customId === confirmId || i.customId === cancelId),
            time: CONFIRM_TIMEOUT,
        });

        collector.on('collect', async (buttonInteraction) => {
            collector.stop(); // Stop collector once a button is pressed
            if (buttonInteraction.customId === cancelId) {
                await buttonInteraction.update({ content: "Heist cancelled.", embeds: [], components: [] });
                return;
            }

            // Re-check balance on confirm
            const currentBalanceResult = await economy.getBalance(userId, guildId);
            if (!currentBalanceResult.success || currentBalanceResult.balance === null) {
                await buttonInteraction.update({ content: "Could not re-verify your balance. Please try again.", embeds: [], components: [] });
                return;
            }
            if (currentBalanceResult.balance < wager) {
                await buttonInteraction.update({ content: `Your balance changed! You no longer have enough chips (${currentBalanceResult.balance}) to bet ${wager}.`, embeds: [], components: [] });
                return;
            }
            // Recalculate potential loss based on current balance at confirmation time
            const finalPotentialLoss = currentBalanceResult.balance / 4n;


            // Proceed to start the game
            await buttonInteraction.update({ content: "Heist confirmed! Dealing cards...", embeds: [], components: [] });
            await this.startRound(interaction, services, wager, finalPotentialLoss, gameId, message);
        });

        collector.on('end', (_, reason) => {
            if (reason === 'time') {
                interaction.editReply({ content: "Heist confirmation timed out.", embeds: [], components: [] }).catch(() => { });
            }
        });
    }

    // --- Start a Round ---
    async startRound(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
        wager: bigint,
        potentialLoss: bigint, // Pass calculated loss
        gameId: string,
        message: Message, // Message to edit
        existingState?: CatHeistGameState // Pass state if continuing
    ) {
        const { logger } = services;

        const deck = createDeck();
        shuffleDeck(deck);
        const { playerHand, cpuHand } = dealPokerHands(deck);

        const gameState: CatHeistGameState = existingState ? {
            ...existingState,
            playerHand,
            cpuHand,
            status: 'round_start',
            currentRound: existingState.currentRound + 1,
            message, // Update message reference
        } : {
            gameId,
            gameType: 'CatHeist',
            userId: interaction.user.id,
            guildId: interaction.guildId ?? 'DM',
            player: { userId: interaction.user.id, displayName: interaction.user.username, isCPU: false },
            cpu: { userId: 'CPU_DEALER', displayName: 'Catnip Casino Dealer', isCPU: true },
            playerHand,
            cpuHand,
            playerScore: 0,
            cpuScore: 0,
            currentRound: 1,
            wager,
            potentialLoss,
            status: 'round_start',
            result: null,
            interaction,
            message,
        };

        activeGames.set(gameId, gameState); // Update or set state
        logger.info(`Cat Heist Game ${gameId}: Starting Round ${gameState.currentRound}`);

        await this.updateRoundMessage(gameState, "Round Start! Reveal your hands?", logger);
        this.setupRoundCollector(gameState, services);
    }

    // --- Setup Collector for Reveal/Next Round ---
    setupRoundCollector(
        gameState: CatHeistGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }
    ) {
        const { logger } = services;
        const revealId = `catheist_reveal_${gameState.gameId}_${gameState.currentRound}`;
        const nextRoundId = `catheist_next_${gameState.gameId}_${gameState.currentRound}`;

        const collector = gameState.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === gameState.userId && (i.customId === revealId || i.customId === nextRoundId),
            time: ROUND_TIMEOUT,
        });
        gameState.collector = collector;

        collector.on('collect', async (buttonInteraction) => {
            const currentGame = activeGames.get(gameState.gameId);
            if (!currentGame || (currentGame.status !== 'round_start' && currentGame.status !== 'round_reveal')) {
                collector.stop();
                return;
            }

            await buttonInteraction.deferUpdate();

            if (buttonInteraction.customId === revealId) {
                collector.stop(); // Stop listening for reveal once clicked
                await this.handleRoundReveal(currentGame, services);
            } else if (buttonInteraction.customId === nextRoundId) {
                collector.stop(); // Stop listening for next round once clicked
                await this.startRound(currentGame.interaction, services, currentGame.wager, currentGame.potentialLoss, currentGame.gameId, currentGame.message, currentGame);
            }
        });

        collector.on('end', (_, reason) => {
            const currentGame = activeGames.get(gameState.gameId);
            if (currentGame && currentGame.status !== 'finished' && reason === 'time') {
                logger.warn(`Cat Heist Game ${gameState.gameId}: Round timed out.`);
                this.endGame(currentGame, services, 'lose') // Forfeit on timeout
                    .catch(e => logger.error("Error ending game on round timeout:", e));
            }
        });
    }

    // --- Handle Round Reveal ---
    async handleRoundReveal(
        gameState: CatHeistGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }
    ) {
        const { logger } = services;
        gameState.status = 'round_reveal';

        const roundWinner = evaluatePokerHands(gameState.playerHand, gameState.cpuHand);
        let roundResultText = "";

        if (roundWinner === 1) {
            gameState.playerScore++;
            roundResultText = `You won Round ${gameState.currentRound}!`;
        } else if (roundWinner === 2) {
            gameState.cpuScore++;
            roundResultText = `The Dealer won Round ${gameState.currentRound}.`;
        } else {
            roundResultText = `Round ${gameState.currentRound} is a tie! Re-dealing...`;
            logger.info(`Cat Heist Game ${gameState.gameId}: Round ${gameState.currentRound} tied. Re-dealing.`);
            // Immediately start the same round again
            await this.updateRoundMessage(gameState, roundResultText, logger, false); // Show revealed hands first
            await new Promise(resolve => setTimeout(resolve, 2500));
            await this.startRound(gameState.interaction, services, gameState.wager, gameState.potentialLoss, gameState.gameId, gameState.message, { ...gameState, currentRound: gameState.currentRound - 1 }); // Pass state but decrement round counter before incrementing in startRound
            return;
        }

        logger.info(`Cat Heist Game ${gameState.gameId}: Round ${gameState.currentRound} result: Player ${roundWinner === 1 ? 'Win' : 'Loss'}. Score: P ${gameState.playerScore} - C ${gameState.cpuScore}`);

        // Check for game end
        if (gameState.playerScore >= 2 || gameState.cpuScore >= 2) {
            await this.updateRoundMessage(gameState, roundResultText, logger, false); // Show final round result
            await new Promise(resolve => setTimeout(resolve, 2000));
            await this.endGame(gameState, services, gameState.playerScore > gameState.cpuScore ? 'win' : 'lose');
        } else {
            // Continue to next round
            await this.updateRoundMessage(gameState, `${roundResultText} Current Score: You ${gameState.playerScore} - ${gameState.cpuScore} Dealer.`, logger, false);
            // Add "Play Next Round" button
            const nextRoundId = `catheist_next_${gameState.gameId}_${gameState.currentRound}`;
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(nextRoundId).setLabel(`Start Round ${gameState.currentRound + 1}`).setStyle(ButtonStyle.Primary)
            );
            await gameState.message.edit({ components: [row] }).catch(e => logger.error("Error adding next round button:", e));
            this.setupRoundCollector(gameState, services); // Setup collector for the next round button
        }
    }

    // --- Update Round Message ---
    async updateRoundMessage(gameState: CatHeistGameState, statusText: string, logger: LoggerService, hideCpuHand = true) {
        const playerHandStr = renderHand(gameState.playerHand);
        const cpuHandStr = renderHand(gameState.cpuHand, hideCpuHand);
        const playerRank = getHandRankName(gameState.playerHand);
        const cpuRank = hideCpuHand ? "???" : getHandRankName(gameState.cpuHand);

        const embed = new EmbedBuilder()
            .setTitle(`💰 Cat Heist - Round ${gameState.currentRound} 💰`)
            .setDescription(statusText)
            .setColor(0x8A2BE2) // BlueViolet
            .addFields(
                { name: `Dealer's Hand (${cpuRank})`, value: cpuHandStr || "Empty", inline: true },
                { name: `Your Hand (${playerRank})`, value: playerHandStr || "Empty", inline: true },
                { name: "Score", value: `You: ${gameState.playerScore} | Dealer: ${gameState.cpuScore}`, inline: false },
                { name: "Wager", value: `${gameState.wager} chips`, inline: true },
                { name: "Potential Loss", value: `${gameState.potentialLoss} chips`, inline: true }
            )
            .setFooter({ text: `Player: ${gameState.interaction.user.username} | Game ID: ${gameState.gameId}` })
            .setTimestamp();

        const components: ActionRowBuilder<ButtonBuilder>[] = [];
        if (gameState.status === 'round_start') {
            const revealId = `catheist_reveal_${gameState.gameId}_${gameState.currentRound}`;
            components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(revealId).setLabel("Reveal Hands").setStyle(ButtonStyle.Success)
            ));
        }
        // "Play Next Round" button is added in handleRoundReveal if needed

        try {
            await gameState.message.edit({
                content: "\u200B",
                embeds: [embed],
                components: components,
            });
        } catch (error) {
            logger.error(`Failed to edit Cat Heist message ${gameState.gameId}:`, error);
        }
    }

    // --- End Game ---
    async endGame(
        gameState: CatHeistGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
        result: 'win' | 'lose' | 'tie' // Overall game result
    ) {
        const { economy, logger } = services;
        if (gameState.status === 'finished') return;

        gameState.status = 'finished';
        gameState.result = result;
        if (gameState.collector && !gameState.collector.ended) {
            gameState.collector.stop("game_ended");
        }

        let finalDesc = "";
        let balanceChange = 0n;
        let color = 0x888888;

        if (result === 'win') {
            balanceChange = gameState.wager * 2n; // Win 2x wager
            finalDesc = `**HEIST SUCCESSFUL!** You outsmarted the dealer and won **${balanceChange}** chips!`;
            color = 0x00FF00; // Green
        } else if (result === 'lose') {
            balanceChange = -gameState.potentialLoss; // Lose 25% of initial balance
            finalDesc = `**HEIST FAILED!** The dealer caught you! You lost **${gameState.potentialLoss}** chips!`;
            color = 0xFF0000; // Red
        } else { // Tie
            finalDesc = "**HEIST STALEMATE!** It's a tie! Your chips are safe.";
            balanceChange = 0n;
        }

        logger.info(`Cat Heist Game ${gameState.gameId} ended. Result: ${result}. Balance change: ${balanceChange}`);

        // Update balance
        let newBalanceText = "Balance update pending...";
        if (balanceChange !== 0n) {
            try {
                const updateResult = await economy.updateBalance(gameState.userId, gameState.guildId, balanceChange);
                if (updateResult.success && updateResult.newBalance !== null) {
                    newBalanceText = `New Balance: ${updateResult.newBalance} 칩`;
                } else {
                    newBalanceText = "Failed to update balance.";
                    logger.error(`Cat Heist Game ${gameState.gameId}: Failed to update balance for user ${gameState.userId}.`);
                }
            } catch (error) {
                newBalanceText = "Error updating balance.";
                logger.error(`Cat Heist Game ${gameState.gameId}: Error during balance update for user ${gameState.userId}:`, error);
            }
        } else {
            newBalanceText = "Your balance remains unchanged.";
        }

        // Final message update
        const finalEmbed = new EmbedBuilder()
            .setTitle("💰 Cat Heist - Results 💰")
            .setDescription(`${finalDesc}\n\n${newBalanceText}`)
            .setColor(color)
            .addFields(
                { name: "Final Score", value: `You: ${gameState.playerScore} | Dealer: ${gameState.cpuScore}`, inline: false },
                { name: "Initial Wager", value: `${gameState.wager} chips`, inline: true },
                { name: "Outcome Chips", value: `${balanceChange >= 0 ? '+' : ''}${balanceChange} chips`, inline: true }
            )
            .setFooter({ text: `Player: ${gameState.interaction.user.username} | Game ID: ${gameState.gameId}` })
            .setTimestamp();

        await gameState.message.edit({ embeds: [finalEmbed], components: [] }).catch(e => logger.error("Error editing final game message:", e));

        activeGames.delete(gameState.gameId); // Clean up
    }
}

export default new CatHeistCommand();
