// src/commands/economy/sell.command.ts
import type { EconomyService } from "@/services/economy.service";
import type { LoggerService } from "@/services/logger.service";
import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
    type SlashCommandSubcommandsOnlyBuilder, // Use this type for subcommands
} from "discord.js";
import type { PrismaClient } from "generated/prisma"; // Import needed types

// Custom error class for business logic errors
class SellError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SellError';
    }
}

// Transaction result type
interface SellTransactionResult {
    itemName: string;
    quantitySold: number;
    earnings: bigint;
    newBalance: bigint;
    itemEmoji: string;
}

// --- Command Interface ---
export interface Command {
    data: SlashCommandSubcommandsOnlyBuilder; // Data uses subcommands
    execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void>;
}

class SellCommand implements Command {
    data = new SlashCommandBuilder()
        .setName("sell")
        .setDescription("Sell items from your inventory for chips.")
        .addSubcommand(subcommand =>
            subcommand
                .setName("item")
                .setDescription("Sell a specific item.")
                .addStringOption(option =>
                    option.setName("name")
                        .setDescription("The exact name of the item to sell.")
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option.setName("quantity")
                        .setDescription("How many to sell (default: 1).")
                        .setRequired(false)
                        .setMinValue(1)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("all")
                .setDescription("Sell all sellable items (currently FISH) in your inventory.")
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void> {
        const subcommand = interaction.options.getSubcommand(true); // Get subcommand name

        switch (subcommand) {
            case "item":
                await this.handleSellItem(interaction, services);
                break;
            case "all":
                await this.handleSellAll(interaction, services);
                break;
            default:
                await interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
        }
    }

    // --- Handler for /sell item ---
    async handleSellItem(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ) {
        const { logger, prisma } = services;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const itemName = interaction.options.getString("name", true);
        const quantityToSell = interaction.options.getInteger("quantity") ?? 1; // Default to 1

        if (!guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            // 1. Find the item definition
            const itemInfo = await prisma.item.findFirst({
                where: {
                    name: {
                        equals: itemName,
                        mode: 'insensitive', // Case-insensitive search
                    },
                    // Optionally restrict sellable types here if needed
                    // type: 'FISH'
                }
            });

            if (!itemInfo) {
                await interaction.editReply(`Could not find an item named "${itemName}". Check the spelling!`);
                return;
            }

            // Check if item is sellable (e.g., only FISH type for now)
            if (itemInfo.type !== 'FISH') {
                await interaction.editReply(`You cannot sell items of type "${itemInfo.type}" (like ${itemInfo.name}).`);
                return;
            }
            if (itemInfo.baseValue <= 0) {
                await interaction.editReply(`${itemInfo.name} cannot be sold as it has no value.`);
                return;
            }


            // 2. Use transaction to check inventory and update balances/inventory
            const transactionResult = await prisma.$transaction(async (tx) => {
                // Find the user's inventory item within the transaction
                const inventoryItem = await tx.inventoryItem.findUnique({
                    where: {
                        userId_itemId: { userId, itemId: itemInfo.id }
                    }
                });

                if (!inventoryItem || inventoryItem.quantity < quantityToSell) {
                    throw new SellError(`Insufficient quantity. You only have ${inventoryItem?.quantity ?? 0} ${itemInfo.name}.`);
                }

                // Calculate earnings
                const earnings = BigInt(quantityToSell) * BigInt(itemInfo.baseValue);

                // Update inventory: decrement or delete
                if (inventoryItem.quantity === quantityToSell) {
                    // Delete the record if selling all
                    await tx.inventoryItem.delete({
                        where: { id: inventoryItem.id }
                    });
                } else {
                    // Decrement quantity
                    await tx.inventoryItem.update({
                        where: { id: inventoryItem.id },
                        data: { quantity: { decrement: quantityToSell } }
                    });
                }

                // Update user balance
                const updatedStats = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: { chips: { increment: earnings } },
                    select: { chips: true }
                });

                return {
                    itemName: itemInfo.name,
                    quantitySold: quantityToSell,
                    earnings: earnings,
                    newBalance: updatedStats.chips,
                    itemEmoji: '🐠'
                } satisfies SellTransactionResult;
            });

            // 3. Send success reply
            const embed = new EmbedBuilder()
                .setTitle("Item Sold!")
                .setColor(0x00FF00) // Green
                .setDescription(`You sold **${transactionResult.quantitySold}x** ${transactionResult.itemEmoji} **${transactionResult.itemName}** for **${transactionResult.earnings}** chips!`)
                .addFields({ name: "New Balance", value: `💰 ${transactionResult.newBalance} chips` })
                .setFooter({ text: `Player: ${interaction.user.username}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.info(`User ${userId} sold ${transactionResult.quantitySold}x ${transactionResult.itemName} for ${transactionResult.earnings} chips.`);

        } catch (error) {
            logger.error(`Error selling item for user ${userId}:`, error);
            const errorMessage = error instanceof SellError ? error.message : 'An unexpected error occurred while selling the item.';
            await interaction.editReply({ content: errorMessage }).catch(() => { });
        }
    }

    // --- Handler for /sell all ---
    async handleSellAll(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ) {
        const { logger, prisma } = services;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            // Use transaction for atomicity
            const transactionResult = await prisma.$transaction(async (tx) => {
                // 1. Find all sellable items (FISH type) in inventory
                const itemsToSell = await tx.inventoryItem.findMany({
                    where: {
                        userId: userId,
                        item: {
                            type: 'FISH',
                            baseValue: { gt: 0 } // Only items with value > 0
                        }
                    },
                    include: {
                        item: true // Include item details (name, value)
                    }
                });

                if (itemsToSell.length === 0) {
                    throw new Error("You have no fish to sell!");
                }

                // 2. Calculate total earnings and prepare for deletion
                let totalEarnings = 0n;
                const soldItemDetails: string[] = [];
                const itemIdsToDelete: string[] = []; // Store inventory item IDs

                for (const invItem of itemsToSell) {
                    const itemValue = BigInt(invItem.item.baseValue);
                    const itemQuantity = BigInt(invItem.quantity);
                    const itemEarning = itemValue * itemQuantity;
                    totalEarnings += itemEarning;
                    soldItemDetails.push(`- ${invItem.quantity}x ${invItem.item.name} (+${itemEarning} chips)`);
                    itemIdsToDelete.push(invItem.id); // Add inventory item ID to delete list
                }

                // 3. Delete sold items from inventory
                await tx.inventoryItem.deleteMany({
                    where: {
                        id: { in: itemIdsToDelete }
                    }
                });

                // 4. Update user balance
                const updatedStats = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: { chips: { increment: totalEarnings } },
                    select: { chips: true }
                });

                return {
                    soldSummary: soldItemDetails.join('\n'),
                    totalEarnings: totalEarnings,
                    newBalance: updatedStats.chips
                };
            });

            // 5. Send success reply
            const embed = new EmbedBuilder()
                .setTitle("Sold All Fish!")
                .setColor(0x00FF00) // Green
                .setDescription(`You sold all your fish!\n\n**Items Sold:**\n${transactionResult.soldSummary}`)
                .addFields(
                    { name: "Total Earnings", value: `💰 **${transactionResult.totalEarnings}** chips` },
                    { name: "New Balance", value: `💰 ${transactionResult.newBalance} chips` }
                )
                .setFooter({ text: `Player: ${interaction.user.username}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.info(`User ${userId} sold all fish for ${transactionResult.totalEarnings} chips.`);

        } catch (error) {
            logger.error(`Error selling all items for user ${userId}:`, error);
            const errorMessage = error instanceof SellError ? error.message : 'An unexpected error occurred while selling all items.';
            await interaction.editReply({ content: errorMessage }).catch(() => { });
        }
    }
}

export default new SellCommand();
