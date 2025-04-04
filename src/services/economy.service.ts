import type { UserGuildStats } from "generated/prisma";
import { PrismaClientKnownRequestError } from "generated/prisma/runtime/library";
import type { CacheService } from "./cache.service";
// import { injectable } from "tsyringe"; // Removed tsyringe
import type { LoggerService } from "./logger.service";
import type { PrismaService } from "./prisma.service";

// Cache TTL for user stats (e.g., 30 seconds)
const USER_STATS_CACHE_TTL_MS = 30 * 1000;

export class InsufficientFundsError extends Error {
    constructor(message = "Insufficient funds") {
        super(message);
        this.name = "InsufficientFundsError";
    }
}

// @injectable() // Removed decorator
export class EconomyService {
    constructor(
        private prisma: PrismaService,
        private logger: LoggerService,
        private cacheService: CacheService
    ) { }

    // Generates the cache key for user guild stats
    private getUserGuildStatsCacheKey(userId: string, guildId: string): string {
        return `userGuildStats:${userId}:${guildId}`;
    }

    // Ensure user and guild exists, then return stats (now wrapped in cache)
    // This method is now primarily for READ operations, returning cached or fresh data.
    private async ensureUserGuildStats(userId: string, guildId: string): Promise<UserGuildStats> {
        const cacheKey = this.getUserGuildStatsCacheKey(userId, guildId);
        this.logger.debug(`Ensuring user (${userId}) and guild (${guildId}) stats exist (cache key: ${cacheKey})...`);

        return this.cacheService.wrap(cacheKey, async () => {
            this.logger.debug(`Cache MISS for ${cacheKey}. Fetching/creating stats from DB.`);
            const stats = await this.prisma.$transaction(async (tx) => {
                // Ensure User exists
                await tx.user.upsert({
                    where: { id: userId },
                    update: {},
                    create: { id: userId },
                });

                // Ensure Guild exists
                await tx.guild.upsert({
                    where: { id: guildId },
                    update: {},
                    create: { id: guildId },
                });

                // Upsert UserGuildStats (create if not exists, return existing otherwise)
                const userStats = await tx.userGuildStats.upsert({
                    where: { userId_guildId: { userId, guildId } },
                    update: {}, // No update needed here
                    create: {
                        userId: userId,
                        guildId: guildId,
                        chips: 100n, // Default starting chips
                        gamesPlayed: 0,
                        // lastDailyClaimed: null, // Initialize if added to schema
                    },
                    // No include needed here unless specifically required by all callers
                    // include: { InventoryItem: true } // Removed invalid include
                });
                return userStats;
            });
            this.logger.debug(`UserGuildStats fetched/created for ${cacheKey}`);
            return stats;
        }, USER_STATS_CACHE_TTL_MS); // Apply TTL
    }

    // Gets the current balance, ensuring user/guild stats exist (uses cached method)
    async getBalance(userId: string, guildId: string): Promise<{ balance: bigint | null; success: boolean }> {
        this.logger.debug(`Getting balance for user (${userId}) in guild (${guildId}) via cache/DB...`);
        try {
            // ensureUserGuildStats now handles caching
            const stats = await this.ensureUserGuildStats(userId, guildId);
            return { balance: stats.chips, success: true };
        } catch (error) {
            this.logger.error(`Failed to get balance for User ${userId}:`, error);
            return { balance: null, success: false };
        }
    }

    // Updates the balance atomically, handling insufficient funds and cache invalidation
    async updateBalance(userId: string, guildId: string, amountChange: bigint): Promise<{ newBalance: bigint | null; success: boolean }> {
        const cacheKey = this.getUserGuildStatsCacheKey(userId, guildId);
        this.logger.debug(`Updating balance for user (${userId}) in guild (${guildId}) by ${amountChange} (cache key: ${cacheKey})...`);

        if (amountChange === 0n) {
            this.logger.debug("Amount change is zero, skipping update.");
            const current = await this.getBalance(userId, guildId); // Uses cached ensureUserGuildStats
            return { newBalance: current.balance, success: current.success };
        }

        try {
            // Perform the update within a transaction
            const result = await this.prisma.$transaction(async (tx) => {
                // We MUST fetch fresh data within the transaction for the check
                // Using upsert ensures the record exists before attempting findUniqueOrThrow
                await tx.userGuildStats.upsert({
                    where: { userId_guildId: { userId, guildId } },
                    update: {},
                    create: { userId: userId, guildId: guildId, chips: 100n, gamesPlayed: 0 },
                    select: { userId: true } // Select minimal field just to ensure creation
                });

                const currentStats = await tx.userGuildStats.findUniqueOrThrow({
                    where: { userId_guildId: { userId, guildId } },
                    select: { chips: true },
                });

                const newBalance = currentStats.chips + amountChange;

                if (amountChange < 0n && newBalance < 0n) {
                    // Use current balance from within transaction for accurate error message
                    throw new InsufficientFundsError(
                        `Cannot decrease balance by ${Math.abs(Number(amountChange))}. Current balance: ${currentStats.chips}`
                    );
                }

                // Update balance
                const updatedStats = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: { chips: newBalance },
                    select: { chips: true },
                });

                // --- Cache Invalidation ---
                // Invalidate cache *after* successful DB update within transaction
                await this.cacheService.del(cacheKey);
                this.logger.debug(`Cache invalidated for key: ${cacheKey} after balance update.`);

                return updatedStats.chips; // Return the new balance
            });

            this.logger.debug(`Balance updated for user (${userId}) in guild (${guildId}) to ${result}`);
            return { newBalance: result, success: true };

        } catch (error) {
            // Handle InsufficientFundsError specifically
            if (error instanceof InsufficientFundsError) {
                this.logger.warn(
                    `Insufficient funds for User ${userId} in Guild ${guildId}. Change: ${amountChange}`,
                    error.message // Log the specific message from the error
                );
                // Re-throw the specific error for the command layer to handle
                // The error message now correctly reflects the balance at the time of the check
                throw error;
            }
            // Handle other Prisma/general errors
            if (error instanceof PrismaClientKnownRequestError) {
                this.logger.error(`Prisma error updating balance for User ${userId}: ${error.code}`, error);
            } else {
                this.logger.error(`Failed to update balance for User ${userId}`, error);
            }
            // Indicate general failure for non-insufficien-funds errors
            return { newBalance: null, success: false };
        }
    }

    // --- Example: Method to update games played (needs cache invalidation) ---
    async incrementGamesPlayed(userId: string, guildId: string): Promise<void> {
        const cacheKey = this.getUserGuildStatsCacheKey(userId, guildId);
        this.logger.debug(`Incrementing games played for user (${userId}) in guild (${guildId}) (cache key: ${cacheKey})...`);
        try {
            await this.prisma.$transaction(async (tx) => {
                await tx.userGuildStats.upsert({
                    where: { userId_guildId: { userId, guildId } },
                    update: { gamesPlayed: { increment: 1 } },
                    create: { userId: userId, guildId: guildId, chips: 100n, gamesPlayed: 1 },
                    select: { userId: true }
                });

                // Invalidate cache after successful update
                await this.cacheService.del(cacheKey);
                this.logger.debug(`Cache invalidated for key: ${cacheKey} after games played update.`);
            });
            this.logger.debug(`Games played incremented for ${userId} in ${guildId}.`);
        } catch (error) {
            this.logger.error(`Failed to increment games played for User ${userId}`, error);
            // Decide how to handle error - maybe rethrow or just log
        }
    }
}