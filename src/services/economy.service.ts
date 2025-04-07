import { retryDbOperation } from "@/utils/dbUtils"; // Import the retry utility
import type { UserGuildStats } from "generated/prisma";
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

    // Reads stats, potentially from cache or DB (wrapped in cache)
    private async ensureUserGuildStats(userId: string, guildId: string): Promise<UserGuildStats> {
        const cacheKey = this.getUserGuildStatsCacheKey(userId, guildId);
        this.logger.debug(`Ensuring user (${userId}) and guild (${guildId}) stats exist (cache key: ${cacheKey})...`);

        // Wrap the DB operation *inside* the cache wrap function
        return this.cacheService.wrap(cacheKey, async () => {
            this.logger.debug(`Cache MISS for ${cacheKey}. Fetching/creating stats from DB.`);

            // Retry the database transaction itself
            const operation = () => this.prisma.$transaction(async (tx) => {
                await tx.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
                await tx.guild.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });
                const userStats = await tx.userGuildStats.upsert({
                    where: { userId_guildId: { userId, guildId } },
                    update: {},
                    create: { userId: userId, guildId: guildId, chips: 100n, gamesPlayed: 0 },
                });
                return userStats;
            });

            const stats = await retryDbOperation(operation, this.logger, `ensureUserGuildStats Transaction (${userId}, ${guildId})`);

            this.logger.debug(`UserGuildStats fetched/created for ${cacheKey}`);
            return stats;
        }, USER_STATS_CACHE_TTL_MS);
    }

    // getBalance now implicitly uses the retry logic within ensureUserGuildStats
    async getBalance(userId: string, guildId: string): Promise<{ balance: bigint | null; success: boolean }> {
        this.logger.debug(`Getting balance for user (${userId}) in guild (${guildId})...`);
        try {
            const stats = await this.ensureUserGuildStats(userId, guildId);
            return { balance: stats.chips, success: true };
        } catch (error) {
            this.logger.error(`Failed to get balance for User ${userId} after retries:`, error);
            return { balance: null, success: false }; // Indicate failure after retries
        }
    }

    // updateBalance with retry logic
    async updateBalance(userId: string, guildId: string, amountChange: bigint): Promise<{ newBalance: bigint | null; success: boolean }> {
        const cacheKey = this.getUserGuildStatsCacheKey(userId, guildId);
        this.logger.debug(`Updating balance for user (${userId}) in guild (${guildId}) by ${amountChange} (cache key: ${cacheKey})...`);

        if (amountChange === 0n) {
            // No DB operation needed, just use getBalance (which has retry via ensureUserGuildStats)
            const current = await this.getBalance(userId, guildId);
            return { newBalance: current.balance, success: current.success };
        }

        try {
            // Define the operation to be retried
            const operation = () => this.prisma.$transaction(async (tx) => {
                // Upsert to ensure record exists (important for findUniqueOrThrow)
                await tx.userGuildStats.upsert({
                    where: { userId_guildId: { userId, guildId } },
                    update: {},
                    create: { userId: userId, guildId: guildId, chips: 100n, gamesPlayed: 0 },
                    select: { userId: true }
                });

                const currentStats = await tx.userGuildStats.findUniqueOrThrow({
                    where: { userId_guildId: { userId, guildId } },
                    select: { chips: true },
                });

                const newBalance = currentStats.chips + amountChange;
                if (amountChange < 0n && newBalance < 0n) {
                    throw new InsufficientFundsError(`Current balance: ${currentStats.chips}. Cannot deduct ${Math.abs(Number(amountChange))}.`);
                }

                const updatedStats = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: { chips: newBalance },
                    select: { chips: true },
                });

                // Invalidate cache *after* successful DB update within transaction
                await this.cacheService.del(cacheKey);
                this.logger.debug(`Cache invalidated inside transaction for key: ${cacheKey}.`);

                return updatedStats.chips; // Return the new balance
            });

            // Execute the operation with retry logic
            const result = await retryDbOperation(operation, this.logger, `updateBalance Transaction (${userId}, ${guildId}, ${amountChange})`);

            this.logger.debug(`Balance updated for user (${userId}) in guild (${guildId}) to ${result}`);
            return { newBalance: result, success: true };

        } catch (error) {
            if (error instanceof InsufficientFundsError) {
                this.logger.warn(`Insufficient funds for User ${userId} in Guild ${guildId}. Change: ${amountChange}`, error.message);
                throw error; // Re-throw specific error
            }
            // Log general failure after retries
            this.logger.error(`Failed to update balance for User ${userId} after retries:`, error);
            return { newBalance: null, success: false };
        }
    }

    // incrementGamesPlayed with retry logic
    async incrementGamesPlayed(userId: string, guildId: string): Promise<void> {
        const cacheKey = this.getUserGuildStatsCacheKey(userId, guildId);
        this.logger.debug(`Incrementing games played for user (${userId}) in guild (${guildId}) (cache key: ${cacheKey})...`);

        try {
            // Define the operation
            const operation = () => this.prisma.$transaction(async (tx) => {
                await tx.userGuildStats.upsert({
                    where: { userId_guildId: { userId, guildId } },
                    update: { gamesPlayed: { increment: 1 } },
                    create: { userId: userId, guildId: guildId, chips: 100n, gamesPlayed: 1 },
                    select: { userId: true }
                });

                // Invalidate cache after successful update
                await this.cacheService.del(cacheKey);
                this.logger.debug(`Cache invalidated inside transaction for key: ${cacheKey}.`);
            });

            // Execute with retry
            await retryDbOperation(operation, this.logger, `incrementGamesPlayed Transaction (${userId}, ${guildId})`);

            this.logger.debug(`Games played incremented for ${userId} in ${guildId}.`);
        } catch (error) {
            this.logger.error(`Failed to increment games played for User ${userId} after retries:`, error);
            // Decide how to handle error - maybe rethrow or just log
        }
    }
}