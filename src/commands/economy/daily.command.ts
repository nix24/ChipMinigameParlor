// Define Command interface locally if not available centrally
// import type { Command } from '@/types/command.types'; // Assuming Command interface path
import type { CommandServices } from '@/types/command.types';
import { retryDbOperation } from "@/utils/dbUtils"; // Import retry utility
import { formatDistanceToNowStrict } from 'date-fns'; // For calculating time difference
import { type ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';

// Local Command Interface Definition (if not central)
interface Command {
    data: Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup">;
    execute(interaction: ChatInputCommandInteraction, services: CommandServices): Promise<void>;
}

const DAILY_AMOUNT = 500n; // Amount of chips to grant
const COOLDOWN_HOURS = 24;

export default class DailyCommand implements Command {
    data = new SlashCommandBuilder()
        .setName('daily')
        .setDescription(`Claim your daily ${DAILY_AMOUNT} chips! (Resets every ${COOLDOWN_HOURS} hours)`);

    async execute(interaction: ChatInputCommandInteraction, services: CommandServices): Promise<void> {
        const { logger, prisma, cache } = services;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            // Define the operation to fetch stats
            const findStatsOp = () => prisma.userGuildStats.findUnique({
                where: { userId_guildId: { userId, guildId } },
                select: { chips: true, lastDailyClaimed: true }
            });
            // Execute with retry
            let userStats = await retryDbOperation(findStatsOp, logger, `Find User Stats for Daily (${userId}, ${guildId})`);

            // If stats don't exist, create them (within a retryable transaction)
            if (!userStats) {
                // Define the creation operation
                const createStatsOp = () => prisma.$transaction(async (tx) => {
                    await tx.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
                    await tx.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });
                    const createdStats = await tx.userGuildStats.create({ // Renamed to avoid conflict
                        data: { userId, guildId, chips: 100n },
                        select: { chips: true, lastDailyClaimed: true }
                    });
                    return createdStats; // Return the created stats
                });
                // Execute creation with retry
                userStats = await retryDbOperation(createStatsOp, logger, `Create User Stats for Daily (${userId}, ${guildId})`);

                if (!userStats) { // Should really not happen if retry succeeds or throws
                    throw new Error("Failed to create user stats after retries.");
                }
            }

            const now = new Date();
            const lastClaim = userStats.lastDailyClaimed;
            let canClaim = false;
            let timeRemainingString = '';

            if (!lastClaim) {
                canClaim = true; // First claim
            } else {
                const twentyFourHoursAgo = new Date(now.getTime() - COOLDOWN_HOURS * 60 * 60 * 1000);
                if (lastClaim < twentyFourHoursAgo) {
                    canClaim = true; // Cooldown expired
                } else {
                    // Calculate remaining time
                    const nextClaimTime = new Date(lastClaim.getTime() + COOLDOWN_HOURS * 60 * 60 * 1000);
                    timeRemainingString = formatDistanceToNowStrict(nextClaimTime, { addSuffix: true });
                }
            }

            if (!canClaim) {
                const embed = new EmbedBuilder()
                    .setTitle('Daily Cooldown')
                    .setColor(0xFFCC00) // Yellow
                    .setDescription(`You have already claimed your daily reward.\nYou can claim again ${timeRemainingString}.`);
                await interaction.editReply({ embeds: [embed] });
                return;
            }

            // --- Perform Transaction to Claim (with retry) ---
            // Define the claim operation
            const claimOp = () => prisma.$transaction(async (tx) => {
                const result = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: {
                        chips: { increment: DAILY_AMOUNT },
                        lastDailyClaimed: now, // Set claim time to now
                    },
                    select: { chips: true }
                });
                // Invalidate cache *inside* successful transaction
                const cacheKey = `userGuildStats:${userId}:${guildId}`;
                await cache.del(cacheKey);
                logger.debug(`Cache invalidated inside transaction for key: ${cacheKey}.`);
                return result;
            });

            // Execute claim with retry
            const updatedStats = await retryDbOperation(claimOp, logger, `Claim Daily Reward Transaction (${userId}, ${guildId})`);

            // --- Success Reply ---
            const embed = new EmbedBuilder()
                .setTitle('Daily Reward Claimed!')
                .setColor(0x00FF00) // Green
                .setDescription(`🎉 You received **${DAILY_AMOUNT}** chips! 🎉`)
                .addFields({ name: 'New Balance', value: `💰 ${updatedStats.chips} chips` })
                .setFooter({ text: `Come back in ${COOLDOWN_HOURS} hours!` })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.info(`User ${userId} claimed daily reward in guild ${guildId}. New balance: ${updatedStats.chips}`);

        } catch (error) {
            logger.error(`Error processing /daily command for user ${userId} in guild ${guildId} (potentially after retries):`, error);
            await interaction.editReply({ content: 'An error occurred while trying to claim your daily reward.' }).catch(() => { });
        }
    }
} 