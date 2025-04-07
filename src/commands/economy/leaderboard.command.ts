import type { CacheService } from "@/services/cache.service"; // Import CacheService
// src/commands/utility/leaderboard.command.ts
import type { LoggerService } from "@/services/logger.service";
import type { PrismaService } from "@/services/prisma.service"; // Import PrismaService
import type { CommandServices } from "@/types/command.types"; // Import CommandServices
import { retryDbOperation } from "@/utils/dbUtils"; // Import retry utility
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
    SlashCommandBuilder,
    type User,
} from "discord.js";
import { Prisma } from "generated/prisma"; // Keep Prisma for SortOrder

const PAGE_SIZE = 10; // Number of entries per page
const COLLECTOR_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CACHE_TTL_MS = 60 * 1000; // 60 seconds for leaderboard cache

class LeaderboardCommand /* implements Command */ {
    data = new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("Shows server leaderboards.")
        .addStringOption(option =>
            option.setName("type")
                .setDescription("The type of leaderboard to display.")
                .setRequired(true)
                .addChoices(
                    { name: '💰 Richest Players', value: 'richest' },
                    { name: '🎮 Most Games Played', value: 'most_played' }
                )
        )
        .addIntegerOption(option =>
            option.setName("page")
                .setDescription("The page number to display.")
                .setRequired(false)
                .setMinValue(1)
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        services: CommandServices,
    ): Promise<void> {
        // Destructure cache from CommandServices
        const { logger, prisma, cache: cacheService } = services;
        const guildId = interaction.guildId;
        const leaderboardType = interaction.options.getString("type", true) as 'richest' | 'most_played';
        let currentPage = interaction.options.getInteger("page") ?? 1;

        if (!guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            // Create initial page (uses cache and retry internally now)
            const { embed, row, totalPages } = await this.createLeaderboardPage(
                interaction,
                prisma,
                logger,
                cacheService,
                guildId,
                leaderboardType,
                currentPage
            );

            const message = await interaction.editReply({ embeds: [embed], components: row ? [row] : [] });

            if (!row || totalPages <= 1) return;

            const collector: InteractionCollector<ButtonInteraction<CacheType>> = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(`leaderboard_${leaderboardType}_${interaction.id}`),
                time: COLLECTOR_TIMEOUT,
            });

            collector.on('collect', async (buttonInteraction) => {
                const action = buttonInteraction.customId.split('_')[3];
                if (action === 'prev') currentPage--;
                else if (action === 'next') currentPage++;

                try {
                    await buttonInteraction.deferUpdate();
                    // Fetch updated page (uses cache and retry internally now)
                    const { embed: updatedEmbed, row: updatedRow } = await this.createLeaderboardPage(
                        interaction,
                        prisma,
                        logger,
                        cacheService,
                        guildId,
                        leaderboardType,
                        currentPage
                    );
                    await buttonInteraction.editReply({ embeds: [updatedEmbed], components: updatedRow ? [updatedRow] : [] });
                } catch (error) {
                    logger.error("Error updating leaderboard page (collector):", error);
                    // Attempt to notify user, ignore errors
                    await buttonInteraction.editReply({ content: "Failed to update leaderboard page.", components: [] }).catch(() => { });
                    collector.stop();
                }
            });

            collector.on('end', (_, reason) => {
                if (reason !== 'messageDelete' && reason !== 'user') {
                    interaction.editReply({ components: [] }).catch(() => { });
                }
            });

        } catch (error) {
            logger.error(`Error initially fetching leaderboard (${leaderboardType}) for guild ${guildId} after retries:`, error);
            await interaction.editReply({ content: "An error occurred while fetching the leaderboard." }).catch(() => { });
        }
    }

    // --- Helper to create leaderboard page (caches the result) ---
    async createLeaderboardPage(
        interaction: ChatInputCommandInteraction,
        prisma: PrismaService,
        logger: LoggerService,
        cacheService: CacheService,
        guildId: string,
        type: 'richest' | 'most_played',
        page: number
    ): Promise<{ embed: EmbedBuilder, row: ActionRowBuilder<ButtonBuilder> | null, totalPages: number }> {

        const cacheKey = `leaderboard:${guildId}:${type}:${page}`;

        // Wrap the generation logic in cache
        return cacheService.wrap(cacheKey, async () => {
            logger.debug(`Cache MISS for ${cacheKey}. Generating leaderboard page.`);

            const whereClause = { guildId: guildId };
            const orderByClause = type === 'richest'
                ? { chips: Prisma.SortOrder.desc }
                : { gamesPlayed: Prisma.SortOrder.desc };

            // Retry DB operations
            const getTotalCount = () => prisma.userGuildStats.count({ where: whereClause });
            const totalCount = await retryDbOperation(getTotalCount, logger, `Leaderboard total count (${guildId}, ${type})`);

            const totalPages = Math.ceil(totalCount / PAGE_SIZE);
            let adjustedPage = page;
            if (adjustedPage < 1) adjustedPage = 1;
            else if (adjustedPage > totalPages && totalPages > 0) adjustedPage = totalPages;
            const skip = (adjustedPage - 1) * PAGE_SIZE;

            // Retry fetching stats for the page
            const getStatsPage = () => prisma.userGuildStats.findMany({
                where: whereClause,
                orderBy: orderByClause,
                take: PAGE_SIZE,
                skip: skip,
            });
            const stats = await retryDbOperation(getStatsPage, logger, `Leaderboard stats page (${guildId}, ${type}, ${adjustedPage})`);

            // Fetch user details for display names
            const userIds = stats.map(s => s.userId);
            const userMap = new Map<string, User>();
            if (userIds.length > 0) {
                for (const userId of userIds) {
                    try {
                        const cachedUser = await cacheService.get<User>(`user:${userId}`);
                        if (cachedUser) {
                            userMap.set(userId, cachedUser);
                        } else {
                            // Consider adding retry specifically for user fetch if it becomes problematic
                            const user = await interaction.client.users.fetch(userId);
                            userMap.set(userId, user);
                            await cacheService.set(`user:${userId}`, user, 300 * 1000);
                        }
                    } catch (fetchError) {
                        logger.warn(`Could not fetch user ${userId} for leaderboard:`, fetchError);
                        userMap.set(userId, { username: `Unknown User (${userId.slice(0, 4)})` } as User);
                    }
                }
            }

            // Build the description string
            let description = "";
            if (stats.length === 0) {
                description = "No stats found for this server yet!";
            } else {
                description = stats.map((stat, index) => {
                    const rank = skip + index + 1;
                    const userName = userMap.get(stat.userId)?.username ?? "Unknown User";
                    const value = type === 'richest' ? stat.chips : stat.gamesPlayed;
                    const valueSuffix = type === 'richest' ? 'chips' : 'games';
                    return `**${rank}.** ${userName} - ${value.toLocaleString()} ${valueSuffix}`;
                }).join('\n');
            }

            // Create the embed
            const embed = new EmbedBuilder()
                .setTitle(`🏆 ${type === 'richest' ? 'Richest Players' : 'Most Games Played'} - Server Leaderboard`)
                .setColor(type === 'richest' ? 0xFFD700 : 0x0099FF)
                .setDescription(description)
                .setFooter({ text: `Page ${adjustedPage} of ${totalPages === 0 ? 1 : totalPages}` })
                .setTimestamp();

            // Create pagination buttons if needed
            let row: ActionRowBuilder<ButtonBuilder> | null = null;
            if (totalPages > 1) {
                row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`leaderboard_${type}_${interaction.id}_prev_${adjustedPage}`)
                        .setLabel("◀️ Previous")
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(adjustedPage <= 1),
                    new ButtonBuilder()
                        .setCustomId(`leaderboard_${type}_${interaction.id}_next_${adjustedPage}`)
                        .setLabel("Next ▶️")
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(adjustedPage >= totalPages)
                );
            }

            return { embed, row, totalPages };

        }, CACHE_TTL_MS);
    }
}

export default new LeaderboardCommand();
