// src/commands/utility/leaderboard.command.ts
import type { LoggerService } from "@/services/logger.service";
import type { PrismaService } from "@/services/prisma.service"; // Import PrismaService
import type { CommandServices } from "@/types/command.types"; // Import CommandServices
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
        const { logger, prisma /* Destructure economy if needed */ } = services; // Destructure from CommandServices
        const guildId = interaction.guildId;
        const leaderboardType = interaction.options.getString("type", true) as 'richest' | 'most_played';
        let currentPage = interaction.options.getInteger("page") ?? 1;

        if (!guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            const { embed, row, totalPages } = await this.createLeaderboardPage(
                interaction,
                prisma, // Pass the destructured prisma
                logger, // Pass the destructured logger
                guildId,
                leaderboardType,
                currentPage
            );

            const message = await interaction.editReply({ embeds: [embed], components: row ? [row] : [] });

            // Don't set up collector if only one page
            if (!row || totalPages <= 1) return;

            const collector: InteractionCollector<ButtonInteraction<CacheType>> = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith(`leaderboard_${leaderboardType}_${interaction.id}`),
                time: COLLECTOR_TIMEOUT,
            });

            collector.on('collect', async (buttonInteraction) => {
                const action = buttonInteraction.customId.split('_')[3]; // prev or next

                if (action === 'prev') {
                    currentPage--;
                } else if (action === 'next') {
                    currentPage++;
                }

                try {
                    await buttonInteraction.deferUpdate(); // Acknowledge button press
                    const { embed: updatedEmbed, row: updatedRow } = await this.createLeaderboardPage(
                        interaction, // Pass original interaction for user context
                        prisma, // Pass the destructured prisma
                        logger, // Pass the destructured logger
                        guildId,
                        leaderboardType,
                        currentPage
                    );
                    await buttonInteraction.editReply({ embeds: [updatedEmbed], components: updatedRow ? [updatedRow] : [] });
                } catch (error) {
                    logger.error("Error updating leaderboard page:", error);
                    await buttonInteraction.editReply({ content: "Failed to update leaderboard page.", components: [] }).catch(() => { });
                    collector.stop();
                }
            });

            collector.on('end', (_, reason) => {
                if (reason !== 'messageDelete' && reason !== 'user') { // Don't edit if manually stopped or message deleted
                    interaction.editReply({ components: [] }).catch(() => { }); // Remove buttons on timeout
                }
            });

        } catch (error) {
            logger.error(`Error fetching leaderboard (${leaderboardType}) for guild ${guildId}:`, error);
            await interaction.editReply({ content: "An error occurred while fetching the leaderboard." }).catch(() => { });
        }
    }

    // --- Helper to create leaderboard page ---
    async createLeaderboardPage(
        interaction: ChatInputCommandInteraction, // Needed for fetching user details
        prisma: PrismaService, // Use PrismaService type
        logger: LoggerService,
        guildId: string,
        type: 'richest' | 'most_played',
        page: number
    ): Promise<{ embed: EmbedBuilder, row: ActionRowBuilder<ButtonBuilder> | null, totalPages: number }> {

        const whereClause = { guildId: guildId };
        const orderByClause = type === 'richest'
            ? { chips: Prisma.SortOrder.desc }
            : { gamesPlayed: Prisma.SortOrder.desc };

        // Get total count for pagination
        const totalCount = await prisma.userGuildStats.count({ where: whereClause });
        const totalPages = Math.ceil(totalCount / PAGE_SIZE);
        let adjustedPage = page;
        if (adjustedPage < 1) {
            adjustedPage = 1;
        } else if (adjustedPage > totalPages && totalPages > 0) {
            adjustedPage = totalPages;
        }

        const skip = (adjustedPage - 1) * PAGE_SIZE;

        // Fetch the data for the current page
        const stats = await prisma.userGuildStats.findMany({
            where: whereClause,
            orderBy: orderByClause,
            take: PAGE_SIZE,
            skip: skip,
        });

        // Fetch user details for display names
        const userIds = stats.map(s => s.userId);
        const userMap = new Map<string, User>();
        if (userIds.length > 0) {
            // Fetch users individually or use guild members fetch if preferred/needed
            // Fetching users globally is often more reliable than guild members
            for (const userId of userIds) {
                try {
                    const user = await interaction.client.users.fetch(userId);
                    userMap.set(userId, user);
                } catch (fetchError) {
                    logger.warn(`Could not fetch user ${userId} for leaderboard:`, fetchError);
                    // Optionally add a placeholder user object
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
                return `**${rank}.** ${userName} - ${value} ${valueSuffix}`;
            }).join('\n');
        }

        // Create the embed
        const embed = new EmbedBuilder()
            .setTitle(`🏆 ${type === 'richest' ? 'Richest Players' : 'Most Games Played'} - Server Leaderboard`)
            .setColor(type === 'richest' ? 0xFFD700 : 0x0099FF) // Gold for rich, Blue for games
            .setDescription(description)
            .setFooter({ text: `Page ${page} of ${totalPages === 0 ? 1 : totalPages}` })
            .setTimestamp();

        // Create pagination buttons if needed
        let row: ActionRowBuilder<ButtonBuilder> | null = null;
        if (totalPages > 1) {
            row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`leaderboard_${type}_${interaction.id}_prev_${page}`) // Include interaction ID for uniqueness
                    .setLabel("◀️ Previous")
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page <= 1),
                new ButtonBuilder()
                    .setCustomId(`leaderboard_${type}_${interaction.id}_next_${page}`)
                    .setLabel("Next ▶️")
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page >= totalPages)
            );
        }

        return { embed, row, totalPages };
    }
}

export default new LeaderboardCommand();
