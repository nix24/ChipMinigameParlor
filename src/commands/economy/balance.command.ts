// src/commands/economy/balance.command.ts
import type { EconomyService } from "@/services/economy.service";
import type { LoggerService } from "@/services/logger.service";
import type { PrismaClient } from "@prisma/client";
import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
    type SlashCommandOptionsOnlyBuilder,
    type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export interface Command {
    data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
    execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void>;
}

class BalanceCommand implements Command {
    data = new SlashCommandBuilder()
        .setName("balance")
        .setDescription("Check your or another user's chip balance.")
        .addUserOption(option =>
            option.setName("user")
                .setDescription("The user whose balance you want to check (defaults to yourself).")
                .setRequired(false)
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void> {
        const { economy, logger } = services;
        const targetUser = interaction.options.getUser("user") ?? interaction.user;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        logger.debug(`Fetching balance for user ${targetUser.id} in guild ${guildId}`);

        try {
            const balanceResult = await economy.getBalance(targetUser.id, guildId);

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setAuthor({ name: `${targetUser.username}'s Balance`, iconURL: targetUser.displayAvatarURL() })
                .setTimestamp();

            if (balanceResult.success && balanceResult.balance !== null) {
                embed.setDescription(`💰 You have **${balanceResult.balance}** chips!`);
            } else if (balanceResult.success && balanceResult.balance === null) {
                // This case implies ensureUserGuildStats created the record but balance is somehow null (shouldn't happen with default)
                // Or if getBalance doesn't ensure creation, it means no record exists.
                // Let's assume getBalance ensures a record with default 100 chips exists.
                // If getBalance *doesn't* ensure creation, this message is appropriate:
                // embed.setDescription("Hmm, looks like you haven't played any games yet. Your balance is effectively 0.");
                // Assuming getBalance *does* ensure creation:
                logger.warn(`Balance check for ${targetUser.id} returned success but null balance.`);
                embed.setDescription("Could not retrieve balance information. Defaulting to 0.")
                    .setColor(0xFFCC00); // Yellow for warning
            }
            else {
                embed.setDescription("Sorry, couldn't fetch the balance. Please try again later.")
                    .setColor(0xFF0000); // Red for error
            }

            await interaction.reply({ embeds: [embed] });

        } catch (error) {
            logger.error(`Error fetching balance for user ${targetUser.id}:`, error);
            await interaction.reply({ content: "An error occurred while fetching the balance.", ephemeral: true });
        }
    }
}

export default new BalanceCommand();
