// Define Command interface locally if not available centrally
// import type { Command } from '@/types/command.types'; // Assuming Command interface path
import type { CommandServices } from '@/types/command.types';
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
            // Get current stats (will use cache if available, fetches from DB otherwise)
            // We need a direct DB read *within* the transaction later to be sure, but this is good for the initial check.
            // However, ensureUserGuildStats doesn't exist anymore as a public method. Let's use prisma directly.
            // const userStats = await economy.ensureUserGuildStats(userId, guildId); // Method is private

            // Fetch or create stats using Prisma directly
            // We need the lastDailyClaimed field specifically
            let userStats = await prisma.userGuildStats.findUnique({
                where: { userId_guildId: { userId, guildId } },
                select: { chips: true, lastDailyClaimed: true } // Select needed fields
            });

            // If stats don't exist, create them (user might be new)
            // Note: This duplicates some logic from the old ensureUserGuildStats
            // Ideally, EconomyService would have a public getOrCreateStats method.
            if (!userStats) {
                await prisma.$transaction(async (tx) => {
                    await tx.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
                    await tx.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });
                    userStats = await tx.userGuildStats.create({
                        data: { userId, guildId, chips: 100n }, // Start with default chips
                        select: { chips: true, lastDailyClaimed: true }
                    });
                });
                if (!userStats) { // Should not happen after creation, but satisfies TS
                    throw new Error("Failed to create user stats.");
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

            // --- Perform Transaction to Claim ---
            const updatedStats = await prisma.$transaction(async (tx) => {
                // Important: Re-fetch within transaction to prevent race conditions if needed,
                // but for daily, simply updating based on the initial check is usually okay.
                // Just ensure the update itself is atomic.
                const result = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: {
                        chips: { increment: DAILY_AMOUNT },
                        lastDailyClaimed: now, // Set claim time to now
                    },
                    select: { chips: true } // Select the new balance
                });
                return result;
            });

            // --- Invalidate Cache ---
            const cacheKey = `userGuildStats:${userId}:${guildId}`;
            await cache.del(cacheKey);
            logger.debug(`Cache invalidated for key: ${cacheKey} after daily claim.`);


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
            logger.error(`Error processing /daily command for user ${userId} in guild ${guildId}:`, error);
            await interaction.editReply({ content: 'An error occurred while trying to claim your daily reward.' }).catch(() => { });
        }
    }
} 