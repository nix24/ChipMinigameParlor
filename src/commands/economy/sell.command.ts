import type { CommandServices } from "@/types/command.types";
import { retryDbOperation } from "@/utils/dbUtils"; // Import retry utility
import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
    type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

// Custom error class
class SellError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SellError';
    }
}

// Transaction result type for selling a single item stack
interface SellItemTransactionResult {
    itemName: string;
    quantitySold: number;
    earnings: bigint;
    newBalance: bigint;
    itemEmoji: string; // Assuming FISH for now
}

// Transaction result type for selling all
interface SellAllTransactionResult {
    totalEarnings: bigint;
    newBalance: bigint;
    soldItemDetails: string[];
}

// --- Command Interface (Adjust services type) ---
export interface Command {
    data: SlashCommandSubcommandsOnlyBuilder; // Data uses subcommands
    execute(
        interaction: ChatInputCommandInteraction,
        services: CommandServices, // Use the shared CommandServices type
    ): Promise<void>;
}

class SellCommand /* implements Command */ {
    data = new SlashCommandBuilder()
        .setName("sell")
        .setDescription("Sell items or display sellable inventory.")
        .addSubcommand(subcommand =>
            subcommand
                .setName("item")
                .setDescription("Sell a specific fish.")
                .addStringOption(option =>
                    option.setName("name")
                        .setDescription("The exact name of the fish to sell.")
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
                .setDescription("Sell all fish in your inventory.")
        )
        .addSubcommand(subcommand => // New subcommand
            subcommand
                .setName("display")
                .setDescription("Show all sellable fish in your inventory.")
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        services: CommandServices,
    ): Promise<void> {
        const subcommand = interaction.options.getSubcommand(true);

        // Invalidate cache for user stats before potentially modifying balance/inventory
        // This ensures subsequent reads within the handlers get fresh data if needed after the transaction.
        // Consider if this is too aggressive or if invalidation should only happen *after* success.
        // For now, let's invalidate before, assuming reads might happen before the final transaction commit.
        // const userId = interaction.user.id;
        // const guildId = interaction.guildId;
        // if (guildId && (subcommand === 'item' || subcommand === 'all')) {
        //     const cacheKey = `userGuildStats:${userId}:${guildId}`;
        //     await services.cache.del(cacheKey);
        //     services.logger.debug(`Cache invalidated for ${cacheKey} before sell operation.`);
        // }
        // --> Decided against pre-invalidation. It's safer to invalidate *after* the DB change is confirmed.

        switch (subcommand) {
            case "item":
                await this.handleSellItem(interaction, services);
                break;
            case "all":
                await this.handleSellAll(interaction, services);
                break;
            case "display": // Add case for display
                await this.handleDisplayInventory(interaction, services);
                break;
            default:
                await interaction.reply({ content: "Unknown subcommand.", ephemeral: true });
        }
    }

    // --- Handler for /sell display ---
    async handleDisplayInventory(
        interaction: ChatInputCommandInteraction,
        services: CommandServices,
    ) {
        const { logger, prisma } = services;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true }); // Make display ephemeral

        try {
            // Define the operation
            const getInventory = () => prisma.inventoryItem.findMany({
                where: {
                    userId: userId,
                    item: { type: 'FISH', baseValue: { gt: 0 } }
                },
                include: { item: true },
                orderBy: { item: { name: 'asc' } }
            });

            // Execute with retry
            const inventoryItems = await retryDbOperation(getInventory, logger, `Display Inventory (${userId})`);

            const embed = new EmbedBuilder()
                .setTitle(`${interaction.user.username}'s Sellable Fish`)
                .setColor(0x0099FF); // Blue

            if (inventoryItems.length === 0) {
                embed.setDescription("You have no fish to sell right now.");
            } else {
                let totalValue = 0n;
                const descriptionLines = inventoryItems.map(invItem => {
                    const itemValue = BigInt(invItem.item.baseValue);
                    const itemQuantity = BigInt(invItem.quantity);
                    const stackValue = itemValue * itemQuantity;
                    totalValue += stackValue;
                    // Remove .emoji access, use default
                    const emoji = '🐠';
                    return `${emoji} **${invItem.item.name}** x ${invItem.quantity} (@ ${itemValue} each) - Total: **${stackValue}** chips`;
                });
                embed.setDescription(descriptionLines.join('\n'));
                embed.setFooter({ text: `Total potential earnings: ${totalValue} chips` });
            }

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error(`Error displaying inventory for user ${userId} after retries:`, error);
            await interaction.editReply({ content: 'An error occurred while fetching your inventory.' }).catch(() => { });
        }
    }


    // --- Handler for /sell item ---
    async handleSellItem(
        interaction: ChatInputCommandInteraction,
        services: CommandServices,
    ) {
        const { logger, prisma, cache } = services;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const itemName = interaction.options.getString("name", true);
        const quantityToSell = interaction.options.getInteger("quantity") ?? 1;

        if (!guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            // Retry finding the item info first (single query)
            const findItemOp = () => prisma.item.findFirst({
                where: { name: { equals: itemName, mode: 'insensitive' } },
            });
            const itemInfo = await retryDbOperation(findItemOp, logger, `Find Item Info (${itemName})`);

            if (!itemInfo) {
                throw new SellError(`Could not find an item named "${itemName}". Check the spelling!`);
            }

            // Explicitly disallow selling Junk
            if (itemInfo.name.toLowerCase() === 'junk') {
                throw new SellError("You cannot sell Junk! It's worthless.");
            }

            // Check if item is sellable type and has value
            if (itemInfo.type !== 'FISH') {
                throw new SellError(`You can only sell fish right now, not items of type "${itemInfo.type}".`);
            }
            if (itemInfo.baseValue <= 0) {
                throw new SellError(`${itemInfo.name} cannot be sold as it has no value.`);
            }

            // Define the transaction operation
            const transactionOp = () => prisma.$transaction(async (tx) => {
                const inventoryItem = await tx.inventoryItem.findUnique({
                    where: { userId_itemId: { userId, itemId: itemInfo.id } }
                });

                if (!inventoryItem || inventoryItem.quantity < quantityToSell) {
                    throw new SellError(`Insufficient quantity. You only have ${inventoryItem?.quantity ?? 0} ${itemInfo.name}.`);
                }

                const earnings = BigInt(quantityToSell) * BigInt(itemInfo.baseValue);

                if (inventoryItem.quantity === quantityToSell) {
                    await tx.inventoryItem.delete({ where: { id: inventoryItem.id } });
                } else {
                    await tx.inventoryItem.update({
                        where: { id: inventoryItem.id },
                        data: { quantity: { decrement: quantityToSell } }
                    });
                }

                const updatedStats = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: { chips: { increment: earnings } },
                    select: { chips: true }
                });

                const cacheKey = `userGuildStats:${userId}:${guildId}`;
                await cache.del(cacheKey);
                logger.debug(`Cache invalidated inside transaction for key: ${cacheKey}.`);

                return {
                    itemName: itemInfo.name,
                    quantitySold: quantityToSell,
                    earnings: earnings,
                    newBalance: updatedStats.chips,
                    // Remove .emoji access, use default
                    itemEmoji: '🐠'
                } satisfies SellItemTransactionResult;
            });

            // Execute transaction with retry
            const transactionResult = await retryDbOperation(transactionOp, logger, `Sell Item Transaction (${userId}, ${itemInfo.name}, ${quantityToSell})`);

            const embed = new EmbedBuilder()
                .setTitle("Item Sold!")
                .setColor(0x00FF00)
                .setDescription(`You sold **${transactionResult.quantitySold}x** ${transactionResult.itemEmoji} **${transactionResult.itemName}** for **${transactionResult.earnings}** chips!`)
                .addFields({ name: "New Balance", value: `💰 ${transactionResult.newBalance} chips` })
                .setFooter({ text: `Player: ${interaction.user.username}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.info(`User ${userId} sold ${transactionResult.quantitySold}x ${transactionResult.itemName} for ${transactionResult.earnings} chips.`);

        } catch (error) {
            logger.error(`Error selling item for user ${userId} (potentially after retries):`, error);
            const errorMessage = error instanceof SellError
                ? error.message
                : 'An unexpected error occurred while selling the item.';
            await interaction.editReply({ content: errorMessage }).catch(() => { });
        }
    }

    // --- Handler for /sell all ---
    async handleSellAll(
        interaction: ChatInputCommandInteraction,
        services: CommandServices,
    ) {
        const { logger, prisma, cache } = services;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
            return;
        }

        await interaction.deferReply();

        try {
            // Define the transaction operation
            const transactionOp = () => prisma.$transaction(async (tx) => {
                const itemsToSell = await tx.inventoryItem.findMany({
                    where: {
                        userId: userId,
                        item: { type: 'FISH', baseValue: { gt: 0 } }
                    },
                    include: { item: true }
                });

                // Use SellError if no items found
                if (itemsToSell.length === 0) {
                    throw new SellError("You have no fish of value to sell!");
                }

                let totalEarnings = 0n;
                const soldItemDetails: string[] = [];
                const itemIdsToDelete: string[] = [];

                for (const invItem of itemsToSell) {
                    // Skip Junk just in case it got through the query
                    if (invItem.item.name.toLowerCase() === 'junk') continue;

                    const itemValue = BigInt(invItem.item.baseValue);
                    const itemQuantity = BigInt(invItem.quantity);
                    const itemEarning = itemValue * itemQuantity;
                    totalEarnings += itemEarning;
                    // Remove .emoji access, use default
                    const emoji = '🐠';
                    soldItemDetails.push(`${emoji} ${invItem.quantity}x ${invItem.item.name} (+${itemEarning})`);
                    itemIdsToDelete.push(invItem.id);
                }

                // If only junk was found after filtering
                if (itemIdsToDelete.length === 0) {
                    throw new SellError("You only have Junk, which cannot be sold.");
                }

                await tx.inventoryItem.deleteMany({ where: { id: { in: itemIdsToDelete } } });

                const updatedStats = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: { chips: { increment: totalEarnings } },
                    select: { chips: true }
                });

                const cacheKey = `userGuildStats:${userId}:${guildId}`;
                await cache.del(cacheKey);
                logger.debug(`Cache invalidated inside transaction for key: ${cacheKey}.`);

                return {
                    totalEarnings: totalEarnings,
                    newBalance: updatedStats.chips,
                    soldItemDetails: soldItemDetails
                } satisfies SellAllTransactionResult;
            });

            // Execute transaction with retry
            const transactionResult = await retryDbOperation(transactionOp, logger, `Sell All Transaction (${userId})`);

            const embed = new EmbedBuilder()
                .setTitle("Sold All Fish!")
                .setColor(0x00FF00)
                .setDescription(`You sold all your fish!
${transactionResult.soldItemDetails.join('\n')}`)
                .addFields(
                    { name: "Total Earnings", value: `💰 ${transactionResult.totalEarnings} chips`, inline: true },
                    { name: "New Balance", value: `💰 ${transactionResult.newBalance} chips`, inline: true }
                )
                .setFooter({ text: `Player: ${interaction.user.username}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            logger.info(`User ${userId} sold all fish for ${transactionResult.totalEarnings} chips.`);

        } catch (error) {
            logger.error(`Error selling all items for user ${userId} (potentially after retries):`, error);
            // Catch SellError specifically
            const errorMessage = error instanceof SellError
                ? error.message
                : 'An unexpected error occurred while selling all items.';
            await interaction.editReply({ content: errorMessage }).catch(() => { });
        }
    }
}

export default new SellCommand();
