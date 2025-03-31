// src/commands/games/blackcat.command.ts
import type { LoggerService } from "@/services/logger.service";
import type { CommandServices } from "@/types/command.types";
import type { Card } from "@/types/types";
import {
    calculateHandValue,
    createDeck,
    dealCard,
    determineWinner,
    isBlackjack,
    renderHand,
    shuffleDeck,
} from "@/utils/blackcat.logic";
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
} from "discord.js";
import { z } from "zod";

// --- Game State ---
interface BlackcatGameState {
    gameId: string;
    gameType: 'Blackcat';
    userId: string;
    guildId: string;
    playerHand: Card[];
    dealerHand: Card[];
    playerValue: { value: number; isSoft: boolean };
    dealerValue: { value: number; isSoft: boolean };
    deck: Card[];
    wager: bigint;
    status: 'player_turn' | 'dealer_turn' | 'finished';
    result: 'win' | 'lose' | 'push' | 'blackjack' | 'player_bust' | 'dealer_bust' | null;
    interaction: ChatInputCommandInteraction;
    message: Message;
    collector?: InteractionCollector<ButtonInteraction<CacheType>>;
}

const activeGames = new Map<string, BlackcatGameState>(); // Keep separate or use GameManager
const GAME_TIMEOUT = 120000; // 2 minutes for player inactivity

// --- Zod Schema ---
const optionsSchema = z.object({
    wager: z.number().int().positive("Wager must be positive."),
});

// --- Command Implementation ---
class BlackcatCommand {
    data = new SlashCommandBuilder()
        .setName("blackcat")
        .setDescription("Play a game of Blackjack!")
        .addIntegerOption((option) =>
            option
                .setName("wager")
                .setDescription("Amount of chips to wager.")
                .setRequired(true)
                .setMinValue(1),
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        services: CommandServices,
    ): Promise<void> {
        const { economy, logger } = services;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "Blackcat can only be played in a server.", ephemeral: true });
            return;
        }

        // 1. Validate Wager
        const validation = optionsSchema.safeParse({
            wager: interaction.options.getInteger("wager", true), // Required
        });
        if (!validation.success) {
            await interaction.reply({ content: `Invalid wager: ${validation.error.errors.map(e => e.message).join(', ')}`, ephemeral: true });
            return;
        }
        const wager = BigInt(validation.data.wager);

        // 2. Check Balance
        const balanceResult = await economy.getBalance(userId, guildId);
        if (!balanceResult.success || balanceResult.balance === null) {
            await interaction.reply({ content: "Could not check your balance.", ephemeral: true });
            return;
        }
        if (balanceResult.balance < wager) {
            await interaction.reply({ content: `You don't have enough chips (${balanceResult.balance}) to bet ${wager}.`, ephemeral: true });
            return;
        }

        // 3. Start Game Setup
        const gameId = interaction.id;
        if (activeGames.has(gameId)) {
            await interaction.reply({ content: "You already have a game in progress.", ephemeral: true });
            return;
        }

        await interaction.deferReply(); // Defer reply as setup takes time

        try {
            const deck = createDeck();
            shuffleDeck(deck);

            const playerHand: Card[] = [];
            const dealerHand: Card[] = [];

            for (let i = 0; i < 2; i++) {
                const playerCard = dealCard(deck);
                const dealerCard = dealCard(deck);

                if (!playerCard || !dealerCard) {
                    throw new Error("Failed to deal initial cards");
                }

                playerHand.push(playerCard);
                dealerHand.push(dealerCard);
            }

            const playerValue = calculateHandValue(playerHand);
            const dealerValue = calculateHandValue(dealerHand); // Calculate initial dealer value for checks

            const message = await interaction.editReply("Dealing cards..."); // Placeholder

            const gameState: BlackcatGameState = {
                gameId,
                gameType: 'Blackcat',
                userId,
                guildId,
                playerHand,
                dealerHand,
                playerValue,
                dealerValue, // Store initial dealer value
                deck,
                wager,
                status: 'player_turn',
                result: null,
                interaction,
                message,
            };

            activeGames.set(gameId, gameState);
            logger.info(`Blackcat game ${gameId} started for ${userId} with wager ${wager}.`);

            // 4. Check for Initial Blackjacks
            const playerHasBlackjack = isBlackjack(playerHand);
            const dealerHasBlackjack = isBlackjack(dealerHand);

            if (playerHasBlackjack || dealerHasBlackjack) {
                await this.endGame(gameState, services); // Pass updated services
            } else {
                // 5. Start Player Turn
                await this.updateGameMessage(gameState, "Your turn!", logger);
                this.setupGameCollector(gameState, services); // Pass updated services
            }
        } catch (error) {
            logger.error(`Error starting Blackcat game ${gameId}:`, error);
            await interaction.editReply("An error occurred while starting the game.").catch(() => { });
            activeGames.delete(gameId);
        }
    }

    // --- Setup Collector ---
    setupGameCollector(
        gameState: BlackcatGameState,
        services: CommandServices
    ) {
        const { logger } = services;
        const collector = gameState.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === gameState.userId && (i.customId.startsWith(`blackcat_hit_${gameState.gameId}`) || i.customId.startsWith(`blackcat_stand_${gameState.gameId}`)),
            time: GAME_TIMEOUT,
        });
        gameState.collector = collector;

        collector.on('collect', async (buttonInteraction) => {
            const currentGame = activeGames.get(gameState.gameId);
            if (!currentGame || currentGame.status !== 'player_turn') {
                // Game ended or it's not the player's turn (shouldn't happen with filter, but safety)
                await buttonInteraction.reply({ content: "It's not your turn or the game has ended.", ephemeral: true }).catch(() => { });
                return;
            }

            await buttonInteraction.deferUpdate(); // Acknowledge button press

            if (buttonInteraction.customId.startsWith('blackcat_hit_')) {
                // --- Handle Hit ---
                const newCard = dealCard(currentGame.deck);
                if (newCard) {
                    currentGame.playerHand.push(newCard);
                    currentGame.playerValue = calculateHandValue(currentGame.playerHand);
                    logger.debug(`Game ${gameState.gameId}: Player hits, receives ${newCard.emoji}. New value: ${currentGame.playerValue.value}`);

                    if (currentGame.playerValue.value > 21) {
                        // Player Busts
                        await this.endGame(currentGame, services, 'player_bust'); // Pass services
                    } else if (currentGame.playerValue.value === 21) {
                        // Auto-stand on 21
                        logger.debug(`Game ${gameState.gameId}: Player hit 21, automatically standing.`);
                        await this.dealerTurn(currentGame, services); // Pass services
                    } else {
                        // Continue player turn
                        await this.updateGameMessage(currentGame, "Hit or Stand?", logger);
                    }
                } else {
                    logger.error(`Game ${gameState.gameId}: Deck empty during player hit?`);
                    await this.endGame(currentGame, services, 'push'); // End as draw if deck runs out
                }
            } else if (buttonInteraction.customId.startsWith('blackcat_stand_')) {
                // --- Handle Stand ---
                logger.debug(`Game ${gameState.gameId}: Player stands with ${currentGame.playerValue.value}.`);
                await this.dealerTurn(currentGame, services); // Pass services
            }
        });

        collector.on('end', (_, reason) => {
            const currentGame = activeGames.get(gameState.gameId);
            // If the game is still in player_turn when collector ends, player timed out or abandoned
            if (currentGame && currentGame.status === 'player_turn' && reason !== 'game_ended') {
                logger.info(`Game ${gameState.gameId} collector ended (${reason}). Player forfeits.`);
                this.endGame(currentGame, services, 'lose') // Pass services
                    .catch(e => logger.error("Error ending game on collector end:", e));
            }
        });
    }

    // --- Dealer's Turn Logic ---
    async dealerTurn(
        gameState: BlackcatGameState,
        services: CommandServices
    ) {
        const { logger } = services;
        gameState.status = 'dealer_turn';
        gameState.dealerValue = calculateHandValue(gameState.dealerHand); // Recalculate with revealed card

        await this.updateGameMessage(gameState, `Dealer reveals ${gameState.dealerHand[0].emoji}. Dealer's turn...`, logger, false); // Show both cards
        await new Promise(resolve => setTimeout(resolve, 1500)); // Pause

        // Dealer hits until 17 or higher
        while (gameState.dealerValue.value < 17) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Pause between hits
            const newCard = dealCard(gameState.deck);
            if (newCard) {
                gameState.dealerHand.push(newCard);
                gameState.dealerValue = calculateHandValue(gameState.dealerHand);
                logger.debug(`Game ${gameState.gameId}: Dealer hits, receives ${newCard.emoji}. New value: ${gameState.dealerValue.value}`);
                await this.updateGameMessage(gameState, `Dealer hits and gets ${newCard.emoji}...`, logger, false);
            } else {
                logger.error(`Game ${gameState.gameId}: Deck empty during dealer hit?`);
                break; // Exit loop if deck is empty
            }
        }

        // Determine result after dealer finishes
        if (gameState.dealerValue.value > 21) {
            await this.endGame(gameState, services, 'dealer_bust'); // Pass services
        } else {
            // Compare hands if dealer didn't bust
            await this.endGame(gameState, services); // Pass services
        }
    }

    // --- Update Game Message ---
    async updateGameMessage(gameState: BlackcatGameState, statusText: string, logger: LoggerService, hideDealerCard = true) {
        const playerHandStr = renderHand(gameState.playerHand);
        const dealerHandStr = renderHand(gameState.dealerHand, hideDealerCard && gameState.status === 'player_turn');

        const embed = new EmbedBuilder()
            .setTitle(`Blackcat Game - Wager: ${gameState.wager} 칩`) // Using 칩 for chips
            .setColor(0x000000) // Black Cat color
            .addFields(
                { name: `Dealer's Hand (${hideDealerCard && gameState.status === 'player_turn' ? '?' : gameState.dealerValue.value})`, value: dealerHandStr || "Empty", inline: false },
                { name: `Your Hand (${gameState.playerValue.value}${gameState.playerValue.isSoft ? ' Soft' : ''})`, value: playerHandStr || "Empty", inline: false },
                { name: "Status", value: statusText, inline: false }
            )
            .setFooter({ text: `Player: ${gameState.interaction.user.username} | Game ID: ${gameState.gameId}` })
            .setTimestamp();

        const components = gameState.status === 'player_turn' ? [this.createActionButtons(gameState.gameId)] : [];

        try {
            await gameState.message.edit({
                content: "\u200B",
                embeds: [embed],
                components: components,
            });
        } catch (error) {
            logger.error(`Failed to edit Blackcat message ${gameState.gameId}:`, error);
        }
    }

    // --- Create Action Buttons ---
    createActionButtons(gameId: string): ActionRowBuilder<ButtonBuilder> {
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`blackcat_hit_${gameId}`)
                .setLabel("Hit")
                .setStyle(ButtonStyle.Success)
                .setEmoji("➕"), // Example emoji
            new ButtonBuilder()
                .setCustomId(`blackcat_stand_${gameId}`)
                .setLabel("Stand")
                .setStyle(ButtonStyle.Danger)
                .setEmoji("✋"), // Example emoji
        );
    }

    // --- End Game ---
    async endGame(
        gameState: BlackcatGameState,
        services: CommandServices,
        forcedResult: BlackcatGameState['result'] | null = null // e.g., for busts
    ) {
        const { logger, prisma } = services;
        const { gameId, userId, guildId, playerHand, dealerHand, wager, playerValue } = gameState;

        // Prevent double processing
        if (gameState.status === 'finished') {
            logger.warn(`Game ${gameId} attempting to end again.`);
            return;
        }
        gameState.status = 'finished';

        // Stop the collector if it exists
        gameState.collector?.stop('game_ended');

        // Determine result if not forced
        // Ensure dealer value is calculated with revealed card if needed (should be done by dealerTurn)
        const finalDealerValue = calculateHandValue(dealerHand); // Calculate final value just in case
        const playerBlackjack = isBlackjack(playerHand);
        const dealerBlackjack = isBlackjack(dealerHand);

        const gameResult = forcedResult ?? determineWinner(
            playerValue.value,      // Use pre-calculated player value
            finalDealerValue.value, // Use final dealer value
            playerValue.value > 21, // Calculate player busted status
            finalDealerValue.value > 21, // Calculate dealer busted status
            playerBlackjack,
            dealerBlackjack
        );
        gameState.result = gameResult;

        // Calculate balance change (handle BigInt)
        let balanceChange = 0n;
        let outcomeText = "";
        switch (gameResult) {
            case 'win':
                balanceChange = wager;
                outcomeText = `You won ${wager} chips!`;
                break;
            case 'blackjack':
                balanceChange = wager * 3n / 2n; // Blackjack pays 3:2
                outcomeText = `Blackjack! You won ${balanceChange} chips!`;
                break;
            case 'lose':
            case 'player_bust':
                balanceChange = -wager;
                outcomeText = `You lost ${wager} chips.`;
                break;
            case 'push':
            case 'dealer_bust': // Dealer bust often results in player win, but can be push if player also busted (handled by forcedResult)
                balanceChange = 0n;
                outcomeText = "It's a push!";
                break;
            default: // Should not happen
                logger.error(`Game ${gameId}: Unknown game result: ${gameResult}`);
                outcomeText = "Game ended unexpectedly.";
        }

        logger.info(`Game ${gameId} ended. Result: ${gameResult}. Balance change: ${balanceChange}`);

        // --- Update Database (Transaction) ---
        let finalBalance: bigint | string = "Error";
        try {
            // *** This is the critical part using prisma.$transaction ***
            const result = await prisma.$transaction(async (tx) => {
                // 1. Ensure stats exist (should usually be true if game started)
                const stats = await tx.userGuildStats.findUniqueOrThrow({
                    where: { userId_guildId: { userId, guildId } },
                });

                // 2. Check for sufficient funds if losing (should be okay if already checked)
                const newBalance = stats.chips + balanceChange;
                if (balanceChange < 0n && newBalance < 0n) {
                    // This case indicates a logic error elsewhere if the bet was allowed initially.
                    logger.error(`Game ${gameId}: Insufficient funds detected during end game transaction. Bet: ${wager}, Balance: ${stats.chips}`);
                    // Force a loss without deducting chips if balance is somehow insufficient now
                    // Alternatively, throw to cancel transaction, but the game already happened.
                    // Let's log and proceed with 0 change if balance is negative.
                    return { chips: stats.chips, gamesPlayed: stats.gamesPlayed + 1 }; // Return current stats
                    // throw new Error("Insufficient funds detected post-game");
                }

                // 3. Update chips and games played
                const updatedStats = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: {
                        chips: newBalance,
                        gamesPlayed: { increment: 1 },
                    },
                });
                return updatedStats;
            });
            finalBalance = result.chips;
        } catch (error) {
            logger.error(`Game ${gameId}: Error during balance update for user ${userId}:`, error);
            outcomeText += "\n⚠️ Failed to update your balance!"; // Append error info
            // Let finalBalance remain "Error"
        }

        // --- Update Embed and Remove Buttons ---
        await this.updateGameMessage(gameState, `**${outcomeText}**\nNew Balance: ${finalBalance}`, logger, false); // Show final result, show dealer cards

        // --- Clean up ---
        activeGames.delete(gameId);
        logger.debug(`Game ${gameId} removed from active games.`);
    }
}

export default new BlackcatCommand();
