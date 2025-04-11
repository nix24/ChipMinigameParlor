import {
    type EconomyService,
    InsufficientFundsError,
} from "@/services/economy.service";
import type { LoggerService } from "@/services/logger.service";
import { Prisma, type PrismaClient } from "@prisma/client"; // Assuming Prisma namespace and PrismaClient type are exported
// src/commands/games/connect4tress.command.ts
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type ChatInputCommandInteraction,
    ComponentType,
    EmbedBuilder,
    type InteractionReplyOptions,
    type InteractionUpdateOptions,
    type MessageCreateOptions,
    SlashCommandBuilder,
    type User,
} from "discord.js";
import { z } from "zod";

import type { Command, Connect4tressGameState } from "@/types/types";
// --- Game Logic Imports (Assume these exist in src/lib/connect4tress.logic.ts) ---
import {
    COLS,
    checkWin,
    createBoard,
    handle4tress,
    isBoardFull,
    isValidMove,
    placeChip,
    renderBoardToString,
} from "@/utils/connect4tress.logic"; // Adjust path as needed
import { getCpuMove } from "@/utils/cpu.logic"; // Adjust path as needed
// -----------------------------------------------------------------------------


const activeGames = new Map<string, Connect4tressGameState>();
const LOBBY_TIMEOUT = 60000; // 60 seconds for opponent to join
const TURN_TIMEOUT = 60000; // 60 seconds per turn
// ----------------------------------------------------

// Input validation schema - Simplified for wager only, opponent checked separately
const optionsSchema = z.object({
    // Opponent validation happens via interaction.options.getUser
    wager: z.number().int().positive("Wager must be positive.").nullish(),
});

class Connect4tressCommand implements Command {
    data = new SlashCommandBuilder()
        .setName("connect4tress")
        .setDescription("Play a game of Connect 4tress!")
        .addUserOption((option) =>
            option
                .setName("opponent")
                .setDescription("Challenge another user or play against the CPU (default)")
                .setRequired(false),
        )
        .addIntegerOption((option) =>
            option
                .setName("wager")
                .setDescription("Amount of chips to wager (optional)")
                .setRequired(false)
                .setMinValue(1),
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        // Receive prisma client instance via services
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void> {
        const { economy } = services; // Extract prisma
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({
                content: "This command can only be used in a server.",
                ephemeral: true,
            });
            return;
        }

        // --- 1. Validate Input ---
        const opponentUser = interaction.options.getUser("opponent"); // Get opponent User object
        const validationResult = optionsSchema.safeParse({
            // opponent: opponentUser, // Don't validate User object with zod here
            wager: interaction.options.getInteger("wager"),
        });

        if (!validationResult.success) {
            await interaction.reply({
                content: `Invalid input: ${validationResult.error.errors
                    .map((e) => e.message)
                    .join(", ")}`,
                ephemeral: true,
            });
            return;
        }

        const { wager } = validationResult.data;
        const betAmount = wager ? BigInt(wager) : 0n;

        // --- 2. Check Balance if Wagered ---
        if (betAmount > 0n) {
            const balanceResult = await economy.getBalance(userId, guildId);
            if (!balanceResult.success || balanceResult.balance === null) {
                await interaction.reply({
                    content: "Could not check your balance. Please try again later.",
                    ephemeral: true,
                });
                return;
            }
            if (balanceResult.balance < betAmount) {
                await interaction.reply({
                    content: `You don't have enough chips to wager ${betAmount}. Your balance is ${balanceResult.balance}.`,
                    ephemeral: true,
                });
                return;
            }
            // Check opponent balance later if human opponent
        }

        // --- 3. Setup Game ---
        const gameId = interaction.id; // Use interaction ID as unique game ID

        if (activeGames.has(gameId)) {
            await interaction.reply({
                content: "A game with this ID already exists.",
                ephemeral: true,
            });
            return;
        }

        // Check if playing vs CPU (no opponent, opponent is bot, or opponent is self)
        const isVsCPU = !opponentUser || opponentUser.bot || opponentUser.id === userId;

        if (isVsCPU) {
            await this.startCPUGame(interaction, services, betAmount, gameId);
        } else {
            // Ensure opponent is not null before starting human game
            await this.startHumanGame(
                interaction,
                services,
                opponentUser, // Pass the valid User object
                betAmount,
                gameId,
            );
        }
    }

    // --- Helper: Start CPU Game ---
    async startCPUGame(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }, // Add prisma
        wager: bigint,
        gameId: string,
    ) {
        const { logger } = services;
        logger.info(
            `Starting Connect4tress game vs CPU for ${interaction.user.id} (Game ID: ${gameId}, Wager: ${wager})`,
        );

        const board = createBoard();
        const initialMessage = await interaction.reply({
            content: "Starting game against CPU...",
            fetchReply: true,
        });

        const gameState: Connect4tressGameState = {
            gameId,
            gameType: "Connect4tress",
            board,
            players: [
                { userId: interaction.user.id, playerNumber: 1, isCPU: false },
                { userId: "CPU", playerNumber: 2, isCPU: true },
            ],
            currentPlayer: 1, // Human goes first
            interaction,
            message: initialMessage,
            status: "playing",
            wager,
            cpuDifficulty: "easy",
            lastMoveTime: Date.now(),
        };

        activeGames.set(gameId, gameState);
        await this.updateGameMessage(gameState, "Your turn!", services.logger); // Pass logger
        this.setupButtonCollector(gameState, services);
    }

    // --- Helper: Start Human Game (Lobby) ---
    async startHumanGame(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }, // Add prisma
        opponent: User, // Type is User now
        wager: bigint,
        gameId: string,
    ) {
        const { economy, logger } = services;
        const hostId = interaction.user.id;
        const opponentId = opponent.id; // Safe to access .id now
        const guildId = interaction.guildId; // Store guildId

        // Check guildId existence
        if (!guildId) {
            logger.error(`Guild ID is null during human game setup for interaction ${interaction.id}`);
            await interaction.reply({ content: "An error occurred: Could not determine the server.", ephemeral: true });
            return;
        }

        logger.info(
            `Initiating Connect4tress lobby: ${hostId} vs ${opponentId} (Game ID: ${gameId}, Wager: ${wager})`,
        );

        // Check opponent's balance if wagered
        if (wager > 0n) {
            const opponentBalanceResult = await economy.getBalance(
                opponentId,
                guildId,
            );
            if (
                !opponentBalanceResult.success ||
                opponentBalanceResult.balance === null
            ) {
                await interaction.reply({
                    content: `Could not check ${opponent.username}'s balance. Cannot start wagered game.`,
                    ephemeral: true,
                });
                return;
            }
            if (opponentBalanceResult.balance < wager) {
                await interaction.reply({
                    content: `${opponent.username} doesn't have enough chips to accept this ${wager} chip wager. Their balance is ${opponentBalanceResult.balance}.`,
                    ephemeral: true,
                });
                return;
            }
        }

        const board = createBoard(); // Create board early for state
        const joinButtonId = `connect4tress_join_${gameId}`;
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(joinButtonId)
                .setLabel("Join Game")
                .setStyle(ButtonStyle.Success),
        );

        const message = await interaction.reply({
            content: `${opponent.toString()}, ${interaction.user.username} challenges you to Connect 4tress${wager > 0 ? ` for ${wager} chips` : ""
                }! Click Join to accept.`,
            components: [row],
            fetchReply: true,
        });

        const gameState: Connect4tressGameState = {
            gameId,
            gameType: "Connect4tress",
            board,
            players: [
                { userId: hostId, playerNumber: 1, isCPU: false },
                { userId: opponentId, playerNumber: 2, isCPU: false },
            ],
            currentPlayer: 1, // Host goes first
            interaction,
            message,
            status: "waiting",
            wager,
            lastMoveTime: Date.now(), // Use for lobby timeout
        };
        activeGames.set(gameId, gameState);

        // Collector for the "Join" button
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.customId === joinButtonId && i.user.id === opponentId,
            time: LOBBY_TIMEOUT,
        });

        collector.on("collect", async (buttonInteraction) => {
            logger.info(
                `Player ${opponentId} joined game ${gameId}. Starting game.`,
            );
            gameState.status = "playing";
            gameState.lastMoveTime = Date.now(); // Reset timer for first turn
            await buttonInteraction.update({
                content: `Game started! ${interaction.user.toString()} vs ${opponent.toString()}.`,
                components: [], // Remove join button
            });
            await this.updateGameMessage(gameState, "Player 1's turn!", services.logger); // Pass logger
            this.setupButtonCollector(gameState, services); // Setup game buttons
            collector.stop("game_started");
        });

        collector.on("end", (_, reason) => {
            if (reason !== "game_started" && gameState.status === "waiting") {
                logger.info(`Lobby ${gameId} timed out or was cancelled.`);
                activeGames.delete(gameId);
                interaction
                    .editReply({
                        content: "The game invitation expired or was cancelled.",
                        components: [],
                    })
                    .catch((err) =>
                        logger.error("Error editing expired lobby message:", err),
                    );
            }
        });
    }

    // --- Helper: Setup Button Collector for Gameplay ---
    setupButtonCollector(
        gameState: Connect4tressGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }, // Add prisma
    ) {
        const { logger } = services;
        const collector = gameState.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: TURN_TIMEOUT * 5, // Longer timeout for the whole game collector
        });
        gameState.collector = collector; // Store collector reference

        collector.on("collect", async (buttonInteraction) => {
            const currentGame = activeGames.get(gameState.gameId);
            // Check if game still exists and is playing
            if (!currentGame || currentGame.status !== "playing") {
                collector.stop("game_ended_or_missing");
                return;
            }

            const player = currentGame.players.find(
                (p) => p.userId === buttonInteraction.user.id,
            );

            // Check if it's the user's turn
            if (!player || player.playerNumber !== currentGame.currentPlayer) {
                await buttonInteraction.reply({
                    content: "It's not your turn!",
                    ephemeral: true,
                });
                return;
            }

            // Check if turn timed out
            if (Date.now() - currentGame.lastMoveTime > TURN_TIMEOUT) {
                logger.info(`Game ${gameState.gameId}: Player ${player.playerNumber} timed out.`);
                const winner = player.playerNumber === 1 ? 2 : 1;
                // Ensure interaction can still be updated
                if (!buttonInteraction.deferred && !buttonInteraction.replied) {
                    await buttonInteraction.update({
                        content: `Player ${player.playerNumber} timed out! Player ${winner} wins!`,
                        components: [],
                        embeds: []
                    }).catch(e => logger.error("Error updating timeout message:", e));
                } else {
                    // If interaction already replied/deferred, try editing the original message
                    currentGame.interaction.editReply({
                        content: `Player ${player.playerNumber} timed out! Player ${winner} wins!`,
                        components: [],
                        embeds: []
                    }).catch(e => logger.error("Error editing reply for timeout message:", e));
                }
                await this.endGame(currentGame, services, winner, true); // Pass services
                return;
            }

            const column = Number.parseInt(buttonInteraction.customId.split("_")[2], 10); // Use Number.parseInt

            // Use Number.isNaN for safety
            if (Number.isNaN(column) || !isValidMove(currentGame.board, column)) {
                await buttonInteraction.reply({
                    content: "Invalid column or column is full!", // Adjusted message slightly
                    ephemeral: true,
                });
                return;
            }

            // Defer update immediately to prevent interaction timeout
            await buttonInteraction.deferUpdate();

            // --- Player's Move ---
            placeChip(currentGame.board, column, player.playerNumber);
            logger.debug(`Game ${gameState.gameId}: Player ${player.playerNumber} placed chip in column ${column}`);

            // Check for win/draw after player move
            if (checkWin(currentGame.board, player.playerNumber)) {
                await this.endGame(currentGame, services, player.playerNumber, true); // Pass services
                return;
            }
            if (isBoardFull(currentGame.board)) {
                await this.endGame(currentGame, services, "draw", true); // Pass services
                return;
            }

            // Handle 4tress mechanic
            const rowsCleared = handle4tress(currentGame.board);
            if (rowsCleared) {
                logger.debug(`Game ${gameState.gameId}: Rows cleared by 4tress mechanic.`);
                // Re-check win/draw after gravity
                if (checkWin(currentGame.board, player.playerNumber)) {
                    await this.endGame(currentGame, services, player.playerNumber, true); // Pass services
                    return;
                }
                if (isBoardFull(currentGame.board)) {
                    await this.endGame(currentGame, services, "draw", true); // Pass services
                    return;
                }
            }

            // Switch player
            currentGame.currentPlayer = player.playerNumber === 1 ? 2 : 1;
            currentGame.lastMoveTime = Date.now();
            const nextPlayer = currentGame.players.find(
                (p) => p.playerNumber === currentGame.currentPlayer,
            ); // Find next player

            // Check if next player exists (should always unless something went wrong)
            if (!nextPlayer) {
                logger.error(`Game ${gameState.gameId}: Could not find next player (current: ${currentGame.currentPlayer}). Ending game as draw.`);
                await this.endGame(currentGame, services, "draw", true); // Pass services
                return;
            }

            // --- CPU's Move (if applicable) ---
            if (nextPlayer.isCPU) {
                await this.updateGameMessage(currentGame, "CPU is thinking...", services.logger); // Update message before CPU potentially takes time // Pass logger

                // Add a small delay for realism
                await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));

                const cpuColumn = getCpuMove(
                    currentGame.board,
                    nextPlayer.playerNumber,
                    player.playerNumber, // Opponent is the player who just moved
                );

                if (cpuColumn !== -1) {
                    placeChip(currentGame.board, cpuColumn, nextPlayer.playerNumber);
                    logger.debug(`Game ${gameState.gameId}: CPU placed chip in column ${cpuColumn}`);

                    // Check win/draw after CPU move
                    if (checkWin(currentGame.board, nextPlayer.playerNumber)) {
                        await this.endGame(currentGame, services, nextPlayer.playerNumber, true); // Pass services
                        return;
                    }
                    if (isBoardFull(currentGame.board)) {
                        await this.endGame(currentGame, services, "draw", true); // Pass services
                        return;
                    }

                    // Handle 4tress after CPU move
                    const cpuRowsCleared = handle4tress(currentGame.board);
                    if (cpuRowsCleared) {
                        logger.debug(`Game ${gameState.gameId}: Rows cleared by 4tress mechanic after CPU move.`);
                        // Re-check win/draw after gravity
                        if (checkWin(currentGame.board, nextPlayer.playerNumber)) {
                            await this.endGame(currentGame, services, nextPlayer.playerNumber, true); // Pass services
                            return;
                        }
                        if (isBoardFull(currentGame.board)) {
                            await this.endGame(currentGame, services, "draw", true); // Pass services
                            return;
                        }
                    }

                } else {
                    logger.warn(`Game ${gameState.gameId}: CPU could not find a valid move (board likely full).`);
                    await this.endGame(currentGame, services, "draw", true); // Should technically be a draw if CPU can't move // Pass services
                    return;
                }

                // Switch back to player
                currentGame.currentPlayer = nextPlayer.playerNumber === 1 ? 2 : 1;
                currentGame.lastMoveTime = Date.now();
            }

            // --- Update Message for Next Turn ---
            const statusMessage = `Player ${currentGame.currentPlayer}'s turn!`;
            await this.updateGameMessage(currentGame, statusMessage, services.logger); // Pass logger

        });

        collector.on("end", (_, reason) => {
            if (reason !== "game_ended_or_missing" && reason !== "game_started") {
                const currentGame = activeGames.get(gameState.gameId);
                if (currentGame && currentGame.status === 'playing') {
                    logger.info(`Game ${gameState.gameId} collector ended unexpectedly or timed out (${reason}). Cleaning up.`);
                    // Determine winner by timeout if applicable, otherwise maybe draw or just cleanup
                    const winner = currentGame.currentPlayer === 1 ? 2 : 1; // Assume current player timed out
                    this.endGame(currentGame, services, winner, true).catch(e => logger.error("Error ending game on collector end:", e));
                }
            }
        });
    }

    // --- Helper: Update Game Message ---
    async updateGameMessage(gameState: Connect4tressGameState, statusText: string, logger: LoggerService) { // Accept logger
        const embed = new EmbedBuilder()
            .setTitle("Connect 4tress")
            .setDescription(
                `${renderBoardToString(gameState.board)}\n\n${statusText}`,
            )
            .setColor(gameState.status === 'finished' ? 0x888888 : 0x0099ff)
            .setFooter({ text: `Game ID: ${gameState.gameId}` });

        if (gameState.wager > 0n) {
            embed.addFields({ name: "Wager", value: `${gameState.wager} chips` });
        }

        const components =
            gameState.status === "playing"
                ? this.createGameButtons(gameState.board)
                : [];

        // Prepare options for editing reply
        const replyOptions: InteractionReplyOptions & InteractionUpdateOptions = { // Combine types for flexibility
            content: "​", // Clear previous content if any
            embeds: [embed],
            components: components,
        };

        // Create options specifically for channel.send (excluding incompatible properties like flags/ephemeral)
        const messageOptions: MessageCreateOptions = {
            content: replyOptions.content,
            embeds: replyOptions.embeds,
            components: replyOptions.components,
            // Explicitly omit flags or other incompatible properties
        };

        try {
            // Check if interaction is still editable
            if (gameState.interaction.channel && !gameState.interaction.ephemeral) {
                await gameState.interaction.editReply(replyOptions);
            } else {
                logger.warn(`Game ${gameState.gameId}: Interaction no longer editable or is ephemeral.`);
                // Optionally try sending a new message if interaction failed
                await this.sendFallbackMessage(gameState, messageOptions, logger);
            }
        } catch (error) {
            logger.error(
                `Failed to edit game message for game ${gameState.gameId}:`,
                error,
            );
            // Attempt to send a new message if edit fails
            await this.sendFallbackMessage(gameState, messageOptions, logger);
        }
    }

    // --- Helper: Send Fallback Message ---
    // Accept MessageCreateOptions suitable for channel.send
    async sendFallbackMessage(gameState: Connect4tressGameState, options: MessageCreateOptions, logger: LoggerService) {
        try {
            // Check if channel exists and has the 'send' method
            if (gameState.interaction.channel && 'send' in gameState.interaction.channel) {
                await gameState.interaction.channel.send(options); // Use the correct options type
            } else {
                logger.warn(`Game ${gameState.gameId}: Cannot send fallback message, channel not suitable or missing.`);
            }
        } catch (sendError) {
            logger.error(`Failed to send fallback game message for game ${gameState.gameId}:`, sendError);
        }
    }

    // --- Helper: Create Buttons ---
    createGameButtons(board: number[][]): ActionRowBuilder<ButtonBuilder>[] {
        // Split buttons into two rows: 1-4 and 5-7
        const row1 = new ActionRowBuilder<ButtonBuilder>();
        const row2 = new ActionRowBuilder<ButtonBuilder>();

        // Add columns 1-4 to first row
        for (let col = 0; col < 4; col++) {
            row1.addComponents(
                new ButtonBuilder()
                    .setCustomId(`connect4_col_${col}`)
                    .setLabel(`${col + 1}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!isValidMove(board, col)), // Disable if column is full
            );
        }

        // Add columns 5-7 to second row
        for (let col = 4; col < COLS; col++) {
            row2.addComponents(
                new ButtonBuilder()
                    .setCustomId(`connect4_col_${col}`)
                    .setLabel(`${col + 1}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!isValidMove(board, col)), // Disable if column is full
            );
        }

        return [row1, row2];
    }

    // --- Helper: End Game ---
    // Accept the full services object, including prisma
    async endGame(gameState: Connect4tressGameState, services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }, winner: 1 | 2 | "draw", timedOut = false) {
        const { logger, prisma } = services; // Destructure services
        gameState.status = "finished";
        gameState.winner = winner;
        if (gameState.collector && !gameState.collector.ended) {
            gameState.collector.stop("game_ended");
        }

        let resultText = "";
        let winnerPlayer: Connect4tressGameState['players'][number] | undefined;
        let loserPlayer: Connect4tressGameState['players'][number] | undefined;

        if (winner === "draw") {
            resultText = "It's a draw!";
        } else {
            winnerPlayer = gameState.players.find((p) => p.playerNumber === winner);
            if (!winnerPlayer) {
                logger.error(`Game ${gameState.gameId}: Could not find winner player object for player number ${winner}.`);
                resultText = "An error occurred determining the winner.";
            } else {
                resultText = timedOut
                    ? `Player ${winner === 1 ? 2 : 1} timed out! <@${winnerPlayer.userId}> wins!`
                    : `<@${winnerPlayer.userId}> wins!`;
            }
        }

        logger.info(
            `Game ${gameState.gameId} finished. Winner: ${winner}. Result: ${resultText}`,
        );

        // Update balances if wagered and winner is not draw and winnerPlayer exists
        if (gameState.wager > 0n && winner !== "draw" && winnerPlayer) {
            // Find loserPlayer - ensure winnerPlayer is defined first
            loserPlayer = gameState.players.find((p) => p.playerNumber !== winner && p.userId !== winnerPlayer?.userId); // Find the other player
            const guildId = gameState.interaction.guildId; // Get guildId

            // Ensure loserPlayer and guildId are valid before proceeding
            if (loserPlayer && guildId && !winnerPlayer.isCPU && !loserPlayer.isCPU) {
                // Extract loserId here where loserPlayer is confirmed to exist
                const loserId = loserPlayer.userId;
                try {
                    // Use the prisma client passed via services
                    await prisma.$transaction(async (tx: Prisma.TransactionClient) => { // Add type for tx
                        // Add wager to winner
                        await tx.userGuildStats.update({
                            where: { userId_guildId: { userId: winnerPlayer.userId, guildId } },
                            data: { chips: { increment: gameState.wager } },
                        });
                        // Subtract wager from loser
                        await tx.userGuildStats.update({
                            where: { userId_guildId: { userId: loserId, guildId } },
                            data: { chips: { decrement: gameState.wager } },
                        });
                    });
                    logger.info(
                        `Game ${gameState.gameId}: Wager of ${gameState.wager} transferred from ${loserId} to ${winnerPlayer.userId}.`,
                    );
                    resultText += ` <@${winnerPlayer.userId}> won ${gameState.wager} chips!`;
                } catch (error) {
                    // Check for specific Prisma errors or InsufficientFundsError if EconomyService handles this
                    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
                        logger.error(`Game ${gameState.gameId}: Failed to update balance - Record not found (User/Guild possibly left).`, error);
                        resultText += " (Error updating balances - one player record not found)";
                    } else if (error instanceof InsufficientFundsError) { // If EconomyService throws this
                        // Use the loserId derived before the try block
                        logger.error(`Game ${gameState.gameId}: Failed to update balance - Insufficient funds for loser ${loserId}.`, error);
                        resultText += ` (Error updating balances - ${loserId} had insufficient funds)`;
                    }
                    else {
                        logger.error(
                            `Game ${gameState.gameId}: Failed to update balances after wager:`,
                            error,
                        );
                        resultText += " (Error updating balances)";
                    }
                    // Don't throw here, let the game end message still show
                }
            } else if (!guildId) {
                logger.error(`Game ${gameState.gameId}: Cannot process wager, guildId is missing.`);
                resultText += " (Error processing wager - missing server info)";
            } else if (!loserPlayer) {
                logger.error(`Game ${gameState.gameId}: Cannot process wager, loser player not found.`);
                resultText += " (Error processing wager - opponent info missing)";
            } else if (winnerPlayer?.isCPU === true || loserPlayer?.isCPU === true) {
                logger.info(`Game ${gameState.gameId}: Wager not processed as one player was CPU.`);
                // Use optional chaining for checking CPU status
                if (winnerPlayer?.isCPU === false && loserPlayer?.isCPU === true) {
                    resultText += ` You won ${gameState.wager} chips from the house!`;
                    // TODO: Implement logic to potentially deduct wager from a 'house' account or just grant it
                } else if (winnerPlayer?.isCPU === true && loserPlayer?.isCPU === false) {
                    resultText += ` The CPU won ${gameState.wager} chips!`;
                    // TODO: Implement logic to potentially add wager to a 'house' account or just absorb it
                }
            }
        }

        await this.updateGameMessage(gameState, `Game Over! ${resultText}`, logger); // Pass logger
        activeGames.delete(gameState.gameId); // Clean up game state
    }

}

export default new Connect4tressCommand(); // Export instance if no DI
