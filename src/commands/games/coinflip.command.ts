import { InsufficientFundsError } from "@/services/economy.service"; // Regular import for value usage
import type { CommandServices } from "@/types/command.types"; // Import the CommandServices interface
// src/commands/games/coinflip.command.ts
import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
} from "discord.js";
// import { injectable } from "tsyringe"; // Removed tsyringe
import { z } from "zod";

// Define the structure of a command module
export interface Command {
    data: SlashCommandBuilder;
    execute(
        interaction: ChatInputCommandInteraction,
        services: CommandServices, // Use the CommandServices interface
    ): Promise<void>;
}

// Input validation schema
const coinflipOptionsSchema = z.object({
    amount: z.number().int().positive("Bet amount must be positive."),
    choice: z.enum(["Heads", "Tails"]),
});

// @injectable() // Removed decorator
class CoinflipCommand implements Command {
    // Command definition using SlashCommandBuilder
    data = new SlashCommandBuilder()
        .setName("coinflip")
        .setDescription("Flip a coin for chips!")
        .addIntegerOption((option) =>
            option
                .setName("amount")
                .setDescription("The amount of chips to bet.")
                .setRequired(true)
                .setMinValue(1),
        )
        .addStringOption((option) =>
            option
                .setName("choice")
                .setDescription("Your choice: Heads or Tails.")
                .setRequired(true)
                .addChoices(
                    { name: "Heads", value: "Heads" },
                    { name: "Tails", value: "Tails" },
                ),
        ) as SlashCommandBuilder;

    // Execution logic
    async execute(
        interaction: ChatInputCommandInteraction,
        services: CommandServices, // Update signature here as well
    ): Promise<void> {
        const { economy, logger } = services; // Destructure prisma if needed by this command
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({
                content: "This command can only be used in a server.",
                ephemeral: true,
            });
            return;
        }

        try {
            // Validate input
            const options = coinflipOptionsSchema.safeParse({
                amount: interaction.options.getInteger("amount", true),
                choice: interaction.options.getString("choice", true),
            });

            if (!options.success) {
                await interaction.reply({
                    content: `Invalid input: ${options.error.errors
                        .map((e) => e.message)
                        .join(", ")}`,
                    ephemeral: true,
                });
                return;
            }

            const { amount, choice } = options.data;
            const betAmount = BigInt(amount);

            logger.info(
                `User ${userId} initiated coinflip in Guild ${guildId} for ${betAmount} chips, choosing ${choice}.`,
            );

            await interaction.deferReply();

            // 1. Check current balance using the new getBalance method
            const balanceResult = await economy.getBalance(userId, guildId);

            if (!balanceResult.success || balanceResult.balance === null) {
                await interaction.editReply({
                    content: "Failed to check your balance. Please try again later.",
                });
                return;
            }

            const currentBalance = balanceResult.balance;

            // 2. Check if user has enough chips
            if (currentBalance < betAmount) {
                await interaction.editReply({
                    content: `You don't have enough chips! Your balance is ${currentBalance} chips.`,
                });
                return;
            }

            // 3. Simulate the coin flip
            const result = Math.random() < 0.5 ? "Heads" : "Tails";
            const win = result === choice;
            const amountChange = win ? betAmount : -betAmount;

            // 4. Update balance using the new updateBalance method
            const updateResult = await economy.updateBalance(
                userId,
                guildId,
                amountChange,
            );

            if (!updateResult.success || updateResult.newBalance === null) {
                // Economy service already logged the error, unless it was insufficient funds
                await interaction.editReply({
                    content:
                        "Something went wrong while updating your balance. Please try again later.",
                });
                return;
            }

            const newBalance = updateResult.newBalance;

            // 5. Build and send the result embed
            const embed = new EmbedBuilder()
                .setTitle("Coin Flip Deluxe!")
                .setColor(win ? 0x00ff00 : 0xff0000)
                .setDescription(
                    `You chose **${choice}**. The coin landed on **${result}**!`,
                )
                .addFields(
                    {
                        name: win ? "🎉 You Won! 🎉" : "😢 You Lost! 😢",
                        value: `You ${win ? "won" : "lost"} **${betAmount}** chips.`,
                        inline: true,
                    },
                    {
                        name: "New Balance",
                        value: `**${newBalance}** chips`,
                        inline: true,
                    },
                )
                .setFooter({
                    text: `Player: ${interaction.user.username}`,
                    iconURL: interaction.user.displayAvatarURL(),
                })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

            logger.info(
                `Coinflip finished for User ${userId}. Result: ${win ? "Win" : "Loss"
                }. New Balance: ${newBalance}`,
            );
        } catch (error) {
            logger.error("Error executing coinflip command:", error);
            // Handle specific InsufficientFundsError with the improved message
            if (error instanceof InsufficientFundsError) {
                await interaction.editReply({
                    content: error.message, // Use the message from the thrown error
                });
            } else {
                // Generic error reply
                const replyContent = "An unexpected error occurred while flipping the coin.";
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: replyContent });
                } else {
                    // Should not happen if deferReply was successful, but as a fallback
                    await interaction.reply({ content: replyContent, ephemeral: true });
                }
            }
        }
    }
}

// Export the class for manual instantiation if needed elsewhere, or default instance
// Since we removed DI from core, let's export the class directly.
// If other commands need DI, they might need separate handling.
export default CoinflipCommand;
// If you were creating instances manually elsewhere:
// export default new CoinflipCommand();
