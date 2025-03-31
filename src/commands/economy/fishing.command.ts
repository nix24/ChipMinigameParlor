import { fishingLootTable, selectWeightedRandom } from "@/lib/lootTables";
// src/commands/fun/fishing.command.ts
import type { EconomyService } from "@/services/economy.service";
import type { LoggerService } from "@/services/logger.service";
import type { PrismaService } from "@/services/prisma.service"; // Import PrismaService
import type { CommandServices } from "@/types/command.types"; // Import CommandServices
import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
    type SlashCommandOptionsOnlyBuilder,
    type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

// Cooldown management (in-memory)
const fishingCooldowns = new Map<string, number>();
const COOLDOWN_SECONDS = 30;

export interface Command {
    data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
    execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaService },
    ): Promise<void>;
}

class FishingCommand /* implements Command */ {
    data = new SlashCommandBuilder()
        .setName("fishing")
        .setDescription("Cast your line and see what you catch!");

    async execute(
        interaction: ChatInputCommandInteraction,
        services: CommandServices, // Use CommandServices
    ): Promise<void> {
        const { logger, prisma /* Destructure economy if needed */ } = services; // Destructure from services
        const userId = interaction.user.id;
        const guildId = interaction.guildId; // Fishing might be global, but let's keep guild context for now

        if (!guildId) {
            await interaction.reply({ content: "Fishing is only available in servers.", ephemeral: true });
            return;
        }

        // 1. Check Cooldown
        const now = Date.now();
        const lastFishTimestamp = fishingCooldowns.get(userId);
        if (lastFishTimestamp && now - lastFishTimestamp < COOLDOWN_SECONDS * 1000) {
            const timeLeft = Math.ceil((lastFishTimestamp + COOLDOWN_SECONDS * 1000 - now) / 1000);
            await interaction.reply({
                content: `You need to wait ${timeLeft} more second(s) before fishing again!`,
                ephemeral: true,
            });
            return;
        }

        await interaction.deferReply();

        try {
            // 2. Ensure User exists (implicitly handled by inventory upsert's relation)
            // We might need an explicit user check/creation if the upsert fails due to user not existing
            // For now, assume User record is created elsewhere or handled by relation constraints

            // 3. Determine Catch
            const caughtItem = selectWeightedRandom(fishingLootTable);
            logger.debug(`User ${userId} fishing attempt, caught: ${caughtItem.name} (ID: ${caughtItem.itemId})`);

            // 4. Update Inventory using services.prisma
            const inventoryUpdate = await prisma.inventoryItem.upsert({ // Use destructured prisma
                where: {
                    userId_itemId: { // Use the unique composite key
                        userId: userId,
                        itemId: caughtItem.itemId,
                    },
                },
                update: {
                    quantity: {
                        increment: 1,
                    },
                },
                create: {
                    userId: userId,
                    itemId: caughtItem.itemId,
                    quantity: 1,
                },
                include: { item: true } // Include item details for the reply
            });

            // 5. Update Cooldown
            fishingCooldowns.set(userId, now);

            // 6. Send Reply
            const embed = new EmbedBuilder()
                .setTitle("Fishing Results!")
                .setColor(caughtItem.type === 'FISH' ? 0x0099FF : 0x808080) // Blue for fish, grey for junk/other
                .setDescription(`You cast your line and caught... ${caughtItem.emoji} **${caughtItem.name}**!`)
                .addFields(
                    { name: "Type", value: caughtItem.type, inline: true },
                    { name: "Quantity Owned", value: `${inventoryUpdate.quantity}`, inline: true }
                )
                .setFooter({ text: `Player: ${interaction.user.username}` })
                .setTimestamp();

            if (caughtItem.type === 'FISH') {
                embed.addFields({ name: "Value", value: `${caughtItem.baseValue} chips`, inline: true });
            }

            await interaction.editReply({ embeds: [embed] });
            logger.info(`User ${userId} successfully fished a ${caughtItem.name}.`);

        } catch (error) {
            logger.error(`Error during fishing for user ${userId}:`, error);
            // Check if reply already sent/deferred
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: "Something went wrong while fishing. Please try again later." }).catch(() => { });
            } else {
                await interaction.reply({ content: "Something went wrong while fishing. Please try again later.", ephemeral: true }).catch(() => { });
            }
            // Optionally remove cooldown if the action failed significantly
            // fishingCooldowns.delete(userId);
        }
    }
}

export default new FishingCommand();
