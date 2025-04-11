import type {
    EconomyService,
} from "@/services/economy.service";
import type { LoggerService } from "@/services/logger.service";
import type { BigBlastGameState, Command, PlayerInfo } from "@/types/types";
// src/commands/games/bigblast.command.ts
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type ChatInputCommandInteraction,
    ComponentType,
    EmbedBuilder,
    type Message,
    SlashCommandBuilder,
    type User
} from "discord.js";
import type { PrismaClient } from "generated/prisma";
import { z } from "zod";

// Initialize the activeGames map
const activeGames = new Map<string, BigBlastGameState>();
const LOBBY_TIMEOUT_BB = 60000; // 60 seconds
const TURN_TIMEOUT_BB = 90000; // 90 seconds

// --- Zod Schema ---
const optionsSchema = z.object({
    wager: z.number().int().positive("Wager must be positive.").optional().nullable(),
    // Opponent validation done manually
});

// --- Command ---


class BigBlastCommand implements Command {
    data = new SlashCommandBuilder()
        .setName("bigblast")
        .setDescription("Don't blow up! Last one standing wins.")
        .addUserOption((option) =>
            option.setName("opponent1").setDescription("Invite player 1.").setRequired(false),
        )
        .addUserOption((option) =>
            option.setName("opponent2").setDescription("Invite player 2.").setRequired(false),
        )
        .addUserOption((option) =>
            option.setName("opponent3").setDescription("Invite player 3.").setRequired(false),
        )
        .addIntegerOption((option) =>
            option
                .setName("wager")
                .setDescription("Amount each player wagers.")
                .setRequired(false)
                .setMinValue(1),
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void> {
        const { economy } = services;
        const hostUser = interaction.user;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "Command unavailable outside servers.", ephemeral: true });
            return;
        }

        // 1. Validate Wager Input
        const validation = optionsSchema.safeParse({
            wager: interaction.options.getInteger("wager"),
        });
        if (!validation.success) {
            await interaction.reply({ content: `Invalid input: ${validation.error.errors.map(e => e.message).join(', ')}`, ephemeral: true });
            return;
        }
        const wager = validation.data.wager ? BigInt(validation.data.wager) : 0n;

        // 2. Collect Human Players
        const humanPlayers = new Map<string, User>();
        humanPlayers.set(hostUser.id, hostUser); // Add host

        const opponents: (User | null)[] = [
            interaction.options.getUser("opponent1"),
            interaction.options.getUser("opponent2"),
            interaction.options.getUser("opponent3"),
        ];

        const invitedPlayerIds: string[] = [];
        for (const opp of opponents) {
            if (opp && !opp.bot && opp.id !== hostUser.id && !humanPlayers.has(opp.id)) {
                humanPlayers.set(opp.id, opp);
                invitedPlayerIds.push(opp.id);
            }
        }

        // Store the human players size for later use
        const totalHumanPlayers = humanPlayers.size;

        // 3. Check Balances if Wagered
        if (wager > 0n) {
            for (const player of humanPlayers.values()) {
                const balanceResult = await economy.getBalance(player.id, guildId);
                if (!balanceResult.success || balanceResult.balance === null || balanceResult.balance < wager) {
                    await interaction.reply({
                        content: `Cannot start wagered game. ${player.username} has insufficient funds (needs ${wager}, has ${balanceResult.balance ?? 'unknown'}).`,
                        ephemeral: true,
                    });
                    return;
                }
            }
        }

        // 4. Determine Players & Add CPUs
        const finalPlayers: PlayerInfo[] = [];
        let playerOrder = 0;
        for (const user of humanPlayers.values()) {
            finalPlayers.push({ userId: user.id, displayName: user.username, isCPU: false, eliminated: false, order: playerOrder++ });
        }

        const currentPlayers = finalPlayers.length;
        const cpusToAddStrict = Math.max(0, 4 - currentPlayers); // Always ensure 4 players total

        for (let i = 0; i < cpusToAddStrict; i++) {
            finalPlayers.push({ userId: `CPU_${i + 1}`, displayName: `CPU ${i + 1}`, isCPU: true, eliminated: false, order: playerOrder++ });
        }

        if (finalPlayers.length > 4) {
            await interaction.reply({ content: "You can only have a maximum of 4 players in Big Blast.", ephemeral: true });
            return;
        }
        if (finalPlayers.length < 4) {
            await interaction.reply({ content: "Big Blast requires exactly 4 players (including CPUs).", ephemeral: true });
            return;
        }

        // 5. Start Game or Lobby
        const gameId = interaction.id;
        if (activeGames.has(gameId)) {
            await interaction.reply({ content: "This interaction already has an active game.", ephemeral: true });
            return;
        }

        if (invitedPlayerIds.length > 0) {
            await this.startLobby(interaction, services, finalPlayers, invitedPlayerIds, wager, gameId, totalHumanPlayers);
        } else {
            // Send initial reply before starting game
            await interaction.reply({ content: "Starting Big Blast..." });
            const message = await interaction.fetchReply() as Message<boolean>;
            await this.startGame(interaction, services, finalPlayers, wager, gameId, message);
        }
    }

    // Update startLobby signature to accept totalHumanPlayers
    async startLobby(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
        players: PlayerInfo[],
        invitedIds: string[],
        wager: bigint,
        gameId: string,
        totalHumanPlayers: number
    ) {
        const { logger } = services;
        const hostId = interaction.user.id;
        logger.info(`Starting Big Blast Lobby ${gameId} by ${hostId}, invited: ${invitedIds.join(', ')}`);

        const joinButtonId = `bigblast_join_${gameId}`;
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(joinButtonId)
                .setLabel("Join Game")
                .setStyle(ButtonStyle.Success)
        );

        const invitedMentions = invitedIds.map(id => `<@${id}>`).join(' ');
        const message = await interaction.reply({
            content: `${invitedMentions}, you've been invited by ${interaction.user.username} to play Big Blast${wager > 0 ? ` for ${wager} chips each` : ''}! Click Join to accept.`,
            components: [row],
            fetchReply: true,
        });

        const gameState: BigBlastGameState = {
            gameId,
            gameType: 'BigBlast',
            players,
            currentPlayerIndex: 0, // Will be set properly on game start
            turnOrder: [], // Will be set on game start
            currentTurnIndex: 0, // Will be set on game start
            availableSwitches: 5,
            detonatorIndex: -1, // Will be set on game start
            status: 'waiting',
            wager,
            interaction,
            message,
            lastMoveTime: Date.now(),
            hostId,
            invitedPlayerIds: invitedIds,
            acceptedPlayerIds: new Set([hostId]), // Host auto-accepts
        };
        activeGames.set(gameId, gameState);

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.customId === joinButtonId && invitedIds.includes(i.user.id),
            time: LOBBY_TIMEOUT_BB,
        });

        collector.on('collect', async (buttonInteraction) => {
            const userId = buttonInteraction.user.id;
            if (gameState.acceptedPlayerIds.has(userId)) {
                await buttonInteraction.reply({ content: "You've already joined!", ephemeral: true });
                return;
            }

            gameState.acceptedPlayerIds.add(userId);
            logger.info(`Player ${userId} accepted invite for game ${gameId}. Accepted: ${gameState.acceptedPlayerIds.size}/${invitedIds.length + 1}`);

            await buttonInteraction.update({ content: `${buttonInteraction.user.username} has joined! Waiting for ${invitedIds.length - gameState.acceptedPlayerIds.size + 1} more player(s)...`, components: [row] }); // Keep button active

            if (gameState.acceptedPlayerIds.size === totalHumanPlayers) {
                collector.stop('all_joined');
                await this.startGame(interaction, services, players, wager, gameId, message);
            }
        });

        collector.on('end', (_, reason) => {
            if (reason !== 'all_joined' && reason !== 'game_started') { // Ensure game didn't start
                logger.warn(`Lobby ${gameId} ended without all players joining (Reason: ${reason}).`);
                activeGames.delete(gameId);
                interaction.editReply({ content: "The Big Blast game lobby expired as not all players joined.", components: [] })
                    .catch(err => logger.error("Error editing expired lobby message:", err));
            }
        });
    }

    // --- Start Game ---
    async startGame(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
        players: PlayerInfo[],
        wager: bigint,
        gameId: string,
        message: Message // Changed to required parameter
    ) {
        const { logger } = services;
        logger.info(`Starting Big Blast game ${gameId} with players: ${players.map(p => p.displayName).join(', ')}`);

        // --- Initial Game Setup ---
        // Shuffle turn order once
        const initialTurnOrder = players.map(p => p.order).sort(() => Math.random() - 0.5);
        const firstPlayerIndex = players.findIndex(p => p.order === initialTurnOrder[0]);

        const gameState: BigBlastGameState = {
            gameId,
            gameType: 'BigBlast',
            players,
            currentPlayerIndex: firstPlayerIndex,
            turnOrder: initialTurnOrder,
            currentTurnIndex: 0,
            availableSwitches: 5,
            detonatorIndex: Math.floor(Math.random() * 5),
            status: 'playing',
            wager,
            interaction,
            message, // Use the provided message
            lastMoveTime: Date.now(),
            hostId: interaction.user.id,
            invitedPlayerIds: players.filter(p => !p.isCPU && p.userId !== interaction.user.id).map(p => p.userId),
            acceptedPlayerIds: new Set(players.filter(p => !p.isCPU).map(p => p.userId)),
        };
        activeGames.set(gameId, gameState);

        logger.debug(`Game ${gameId} setup complete. Detonator: ${gameState.detonatorIndex}. Turn order: ${gameState.turnOrder.join(', ')}.`);

        // Edit the message
        const initialPlayer = players[firstPlayerIndex];
        await this.updateGameMessage(gameState, `Game started! ${initialPlayer.displayName}'s turn. Choose a switch!`, logger);
        this.setupGameCollector(gameState, services);

        // If first player is CPU, trigger their turn
        if (initialPlayer.isCPU) {
            await this.handleCPUTurn(gameState, services);
        }
    }

    // --- Setup Game Collector ---
    setupGameCollector(
        gameState: BigBlastGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }
    ) {
        const { logger } = services;
        const collector = gameState.message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: TURN_TIMEOUT_BB * gameState.players.length * 5, // Generous overall timeout
        });
        gameState.collector = collector;

        collector.on('collect', async (buttonInteraction) => {
            const currentGame = activeGames.get(gameState.gameId);
            if (!currentGame || currentGame.status !== 'playing') {
                collector.stop("game_ended_or_missing");
                return;
            }

            const currentPlayerInfo = currentGame.players[currentGame.currentPlayerIndex];

            // Check if it's the button presser's turn and they are not a CPU
            if (currentPlayerInfo.isCPU || buttonInteraction.user.id !== currentPlayerInfo.userId) {
                await buttonInteraction.reply({ content: "It's not your turn!", ephemeral: true });
                return;
            }

            // Check for turn timeout
            if (Date.now() - currentGame.lastMoveTime > TURN_TIMEOUT_BB) {
                logger.info(`Game ${gameState.gameId}: Player ${currentPlayerInfo.displayName} timed out.`);
                await buttonInteraction.deferUpdate().catch(() => { }); // Acknowledge interaction even if ending
                await this.handleElimination(currentGame, services, currentPlayerInfo.order, true); // Handle timeout elimination
                return;
            }

            await buttonInteraction.deferUpdate(); // Acknowledge interaction

            const switchIndex = Number.parseInt(buttonInteraction.customId.split("_")[2], 10); // e.g., bigblast_switch_1

            await this.handlePlayerChoice(currentGame, services, currentPlayerInfo, switchIndex);

        });

        collector.on("end", (_, reason) => {
            if (reason !== "game_ended" && reason !== "game_started" && reason !== "game_ended_or_missing") {
                const currentGame = activeGames.get(gameState.gameId);
                if (currentGame && currentGame.status === 'playing') {
                    logger.info(`Game ${gameState.gameId} collector ended unexpectedly or timed out (${reason}). Cleaning up.`);
                    // Assume the current player timed out
                    const currentPlayerInfo = currentGame.players[currentGame.currentPlayerIndex];
                    this.handleElimination(currentGame, services, currentPlayerInfo.order, true)
                        .catch(e => logger.error("Error ending game on collector end:", e));
                }
            }
        });
    }

    // --- Handle Player Choice ---
    async handlePlayerChoice(
        gameState: BigBlastGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
        player: PlayerInfo,
        chosenIndex: number
    ) {
        const { logger } = services;
        logger.debug(`Game ${gameState.gameId}: Player ${player.displayName} chose switch ${chosenIndex + 1}`);

        if (chosenIndex < 0 || chosenIndex >= gameState.availableSwitches) {
            logger.error(`Game ${gameState.gameId}: Invalid chosenIndex ${chosenIndex} for ${gameState.availableSwitches} switches.`);
            // Handle this potential error, maybe reply ephemerally
            return;
        }

        if (chosenIndex === gameState.detonatorIndex) {
            // BOOM!
            logger.info(`Game ${gameState.gameId}: Player ${player.displayName} hit the detonator!`);
            await this.updateGameMessage(gameState, `💥 BOOM! ${player.displayName} pressed the wrong switch!`, logger);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Pause for effect
            // Elimination handles switch reduction for the next round
            await this.handleElimination(gameState, services, player.order);
        } else {
            // Safe
            gameState.lastMoveTime = Date.now();

            // --- State Update for SAFE choice ---
            // Decrement available switches for the *next* player's turn within this round
            gameState.availableSwitches--;
            // If the detonator was after the chosen switch, its effective index decreases
            if (gameState.detonatorIndex > chosenIndex) {
                gameState.detonatorIndex--;
            }
            // --- End State Update ---

            await this.updateGameMessage(gameState, `${player.displayName} pressed switch ${chosenIndex + 1}... it's safe! ${gameState.availableSwitches} switches left this turn.`, logger);
            await new Promise(resolve => setTimeout(resolve, 1500)); // Pause
            await this.advanceTurn(gameState, services);
        }
    }

    // --- Handle CPU Turn ---
    async handleCPUTurn(
        gameState: BigBlastGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }
    ) {
        const { logger } = services;
        const cpuPlayer = gameState.players[gameState.currentPlayerIndex];
        if (!cpuPlayer || !cpuPlayer.isCPU || gameState.status !== 'playing') return;

        logger.debug(`Game ${gameState.gameId}: CPU ${cpuPlayer.displayName}'s turn.`);
        await this.updateGameMessage(gameState, `${cpuPlayer.displayName} is choosing a switch...`, logger);
        await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1500));

        // CPU chooses a random *index* from the available switches
        const cpuChoiceIndex = Math.floor(Math.random() * gameState.availableSwitches);
        logger.info(`Game ${gameState.gameId}: CPU ${cpuPlayer.displayName} chose switch ${cpuChoiceIndex + 1} (Index: ${cpuChoiceIndex})`);

        // Pass the chosen index to handlePlayerChoice
        await this.handlePlayerChoice(gameState, services, cpuPlayer, cpuChoiceIndex);
    }


    // --- Handle Elimination ---
    async handleElimination(
        gameState: BigBlastGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
        eliminatedPlayerOrder: number,
        timedOut = false
    ) {
        const { logger } = services;
        const eliminatedPlayer = gameState.players.find(p => p.order === eliminatedPlayerOrder);
        // Ensure player exists and isn't already marked eliminated
        if (!eliminatedPlayer || eliminatedPlayer.eliminated) {
            logger.warn(`Game ${gameState.gameId}: Attempted to eliminate player order ${eliminatedPlayerOrder}, but they were not found or already eliminated.`);
            return;
        }

        eliminatedPlayer.eliminated = true;
        // Filter out the eliminated player's order from the turn order
        gameState.turnOrder = gameState.turnOrder.filter(order => order !== eliminatedPlayerOrder);

        const remainingPlayersCount = gameState.turnOrder.length; // Count based on remaining turns
        const eliminatedMsg = timedOut ? `${eliminatedPlayer.displayName} was eliminated for timing out!` : `${eliminatedPlayer.displayName} is out!`;

        logger.info(`Game ${gameState.gameId}: Player ${eliminatedPlayer.displayName} eliminated. ${remainingPlayersCount} players left.`);

        if (remainingPlayersCount === 1) {
            // Game Over - We have a winner
            const winnerOrder = gameState.turnOrder[0];
            const winner = gameState.players.find(p => p.order === winnerOrder);
            await this.updateGameMessage(gameState, `${eliminatedMsg}`, logger); // Show elimination message first
            await new Promise(resolve => setTimeout(resolve, 1500)); // Pause
            await this.endGame(gameState, services, winner?.userId ?? "draw"); // End game with the winner
        } else if (remainingPlayersCount < 1) {
            // Should not happen, but safety check
            logger.error(`Game ${gameState.gameId}: No players left after elimination? Ending as draw.`);
            await this.updateGameMessage(gameState, `${eliminatedMsg}`, logger);
            await new Promise(resolve => setTimeout(resolve, 1500));
            await this.endGame(gameState, services, "draw");
        }
        else {
            // Continue game: Set switches for the next round and randomize detonator
            if (remainingPlayersCount === 3) {
                gameState.availableSwitches = 4;
            } else if (remainingPlayersCount === 2) {
                gameState.availableSwitches = 3;
            } else {
                // This case implies remainingPlayersCount >= 4, which shouldn't happen if starting with 4.
                // Or if starting with < 4, this logic might need adjustment based on desired minimum switches.
                // Assuming start is always 4, this state is unexpected.
                // Let's default to 3 if somehow > 2 players remain but count is off.
                gameState.availableSwitches = 3;
                logger.warn(`Game ${gameState.gameId}: Unexpected remaining player count (${remainingPlayersCount}) after elimination. Setting switches to 3.`);
            }

            gameState.detonatorIndex = Math.floor(Math.random() * gameState.availableSwitches);
            logger.debug(`Game ${gameState.gameId}: New round starting. ${gameState.availableSwitches} switches available. New detonator index: ${gameState.detonatorIndex}`);

            await this.updateGameMessage(gameState, `${eliminatedMsg} ${gameState.availableSwitches} switches appear for the next round.`, logger);
            await new Promise(resolve => setTimeout(resolve, 1500)); // Pause
            await this.advanceTurn(gameState, services); // Advance to the next player's turn
        }
    }


    // --- Advance Turn ---
    async advanceTurn(
        gameState: BigBlastGameState,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }
    ) {
        if (gameState.status !== 'playing') return; // Don't advance if game ended

        gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.turnOrder.length;
        const nextPlayerOrder = gameState.turnOrder[gameState.currentTurnIndex];
        gameState.currentPlayerIndex = gameState.players.findIndex(p => p.order === nextPlayerOrder);
        gameState.lastMoveTime = Date.now();

        const nextPlayer = gameState.players[gameState.currentPlayerIndex];
        await this.updateGameMessage(gameState, `${nextPlayer.displayName}'s turn. Choose a switch!`, services.logger);

        if (nextPlayer.isCPU) {
            await this.handleCPUTurn(gameState, services);
        }
    }


    // --- Update Game Message ---
    async updateGameMessage(gameState: BigBlastGameState, statusText: string, logger: LoggerService) {
        const embed = new EmbedBuilder()
            .setTitle("💣 Big Blast!")
            .setColor(gameState.status === 'finished' ? 0x888888 : 0xffa500) // Orange for playing
            .setFooter({ text: `Game ID: ${gameState.gameId}` });

        const playerList = gameState.players.map(p =>
            `${p.eliminated ? '~~' : ''}${p.displayName}${p.eliminated ? '~~ (Eliminated)' : (p.order === gameState.turnOrder[gameState.currentTurnIndex] && gameState.status === 'playing' ? ' 🎯' : '')}` // Use actual emoji
        ).join('\n');

        embed.setDescription(`${statusText}\n\n**Players:**\n${playerList}`);

        if (gameState.wager > 0n) {
            embed.addFields({ name: "Wager (per player)", value: `${gameState.wager} chips` });
        }

        const components = gameState.status === 'playing' ? this.createSwitchButtons(gameState.availableSwitches) : [];

        try {
            // Use the message object stored in the state
            await gameState.message.edit({
                content: "\u200B", // Clear previous content
                embeds: [embed],
                components: components,
            });
        } catch (error) {
            logger.error(`Failed to edit game message for Big Blast ${gameState.gameId}:`, error);
        }
    }

    // --- Create Switch Buttons ---
    createSwitchButtons(count: number): ActionRowBuilder<ButtonBuilder>[] {
        const buttons: ButtonBuilder[] = [];
        const labels = ["🔴", "🟣", "🟡", "🟢", "⚪"]; // Using simpler, guaranteed-compatible emojis
        for (let i = 0; i < count; i++) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`bigblast_switch_${i}`)
                    .setLabel(`Switch ${i + 1}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji(labels[i % labels.length])
            );
        }

        // Distribute buttons into rows (max 5 per row)
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        for (let i = 0; i < buttons.length; i += 5) {
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
        }
        return rows;
    }

    // --- End Game ---
    async endGame(gameState: BigBlastGameState, services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient }, winnerUserId: string | "draw") {
        const { logger, prisma } = services;
        gameState.status = "finished";
        gameState.winnerUserId = winnerUserId;
        if (gameState.collector && !gameState.collector.ended) {
            gameState.collector.stop("game_ended");
        }

        let resultText = "";
        const winnerPlayerInfo = gameState.players.find(p => p.userId === winnerUserId);

        if (winnerUserId === "draw") {
            resultText = "It's a draw! No one wins.";
        } else if (winnerPlayerInfo) {
            resultText = `🎉 ${winnerPlayerInfo.displayName} is the last one standing and wins!`;
        } else {
            resultText = "Game over, but the winner could not be determined."; // Should not happen
            logger.error(`Big Blast game ${gameState.gameId} ended with invalid winner ID: ${winnerUserId}`);
        }

        logger.info(`Game ${gameState.gameId} finished. Winner: ${winnerUserId}. Result: ${resultText}`);

        // Handle Wagers
        if (gameState.wager > 0n && winnerUserId !== "draw" && winnerPlayerInfo && !winnerPlayerInfo.isCPU) {
            const humanLosers = gameState.players.filter(p => !p.isCPU && p.eliminated);
            const totalWinnings = gameState.wager * BigInt(humanLosers.length);
            const guildId = gameState.interaction.guildId;

            if (totalWinnings > 0n && guildId) {
                try {
                    await prisma.$transaction(async (tx) => {
                        // Add winnings to winner
                        await tx.userGuildStats.update({
                            where: { userId_guildId: { userId: winnerPlayerInfo.userId, guildId } },
                            data: { chips: { increment: totalWinnings } },
                        });
                        // Subtract wager from each human loser
                        for (const loser of humanLosers) {
                            await tx.userGuildStats.update({
                                where: { userId_guildId: { userId: loser.userId, guildId } },
                                data: { chips: { decrement: gameState.wager } },
                            });
                        }
                    });
                    logger.info(`Game ${gameState.gameId}: Wager payout successful. Winner ${winnerPlayerInfo.userId} received ${totalWinnings} chips.`);
                    resultText += ` ${winnerPlayerInfo.displayName} won ${totalWinnings} chips!`;
                } catch (error) {
                    logger.error(`Game ${gameState.gameId}: Failed to process wager transactions:`, error);
                    resultText += " (Error processing wagers)";
                    // Consider refunding or alternative handling if transaction fails partially
                }
            } else if (humanLosers.length === 0) {
                resultText += " (No chips won as only CPUs were eliminated).";
            }
        } else if (gameState.wager > 0n && winnerPlayerInfo?.isCPU) {
            // CPU Won wagered game
            const humanLosers = gameState.players.filter(p => !p.isCPU); // All humans lost
            const guildId = gameState.interaction.guildId;
            if (humanLosers.length > 0 && guildId) {
                try {
                    await prisma.$transaction(async (tx) => {
                        for (const loser of humanLosers) {
                            await tx.userGuildStats.update({
                                where: { userId_guildId: { userId: loser.userId, guildId } },
                                data: { chips: { decrement: gameState.wager } },
                            });
                        }
                    });
                    logger.info(`Game ${gameState.gameId}: CPU won. ${humanLosers.length} human player(s) lost ${gameState.wager * BigInt(humanLosers.length)} chips.`);
                    resultText += ` The house collects ${gameState.wager * BigInt(humanLosers.length)} chips!`;
                } catch (error) {
                    logger.error(`Game ${gameState.gameId}: Failed to process CPU win wager transactions:`, error);
                    resultText += " (Error processing wagers)";
                }
            }
        }


        await this.updateGameMessage(gameState, `Game Over! ${resultText}`, logger);
        activeGames.delete(gameState.gameId);
    }
}

export default new BigBlastCommand();
