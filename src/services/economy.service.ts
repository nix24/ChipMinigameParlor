import { PrismaClientKnownRequestError } from "generated/prisma/runtime/library";
// import { injectable } from "tsyringe"; // Removed tsyringe
import type { LoggerService } from "./logger.service";
import type { PrismaService } from "./prisma.service";


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
        private logger: LoggerService
    ) { }

    //ensure user and guild exists, then return stats
    private async ensureUserGuildStats(userId: string, guildId: string) {
        this.logger.debug(
            `Ensuring user (${userId}) and guild (${guildId}) stats exist...`
        );
        // Use transaction for atomicity: create User, Guild, and Stats if they don't exist
        return this.prisma.$transaction(async (tx) => {
            // upsert User if they don't exist
            await tx.user.upsert({
                where: { id: userId },
                update: {},
                create: { id: userId },
            });

            // upsert Guild if they don't exist
            await tx.guild.upsert({
                where: { id: guildId },
                update: {},
                create: { id: guildId },
            });

            // Upsert UserGuildStats (create if not exists, return existing otherwise)
            const stats = await tx.userGuildStats.upsert({
                where: { userId_guildId: { userId, guildId } },
                update: {}, // No update needed here, just ensure it exists
                create: {
                    userId: userId,
                    guildId: guildId,
                    chips: 100n, // Default starting chips (use BigInt literal 'n')
                    gamesPlayed: 0,
                },
            });
            this.logger.debug("UserGuildStats ensured/found");
            return stats;
        })
    }

    // Gets the current balance, ensuring user/guild stats exist
    async getBalance(userId: string, guildId: string):
        Promise<{ balance: bigint | null; success: boolean }> {
        this.logger.debug(
            `Getting balance for user (${userId}) in guild (${guildId})...`
        );
        try {
            const stats = await this.ensureUserGuildStats(userId, guildId);
            return { balance: stats.chips, success: true };
        } catch (error) {
            this.logger.error(`Failed to get balance for User ${userId}:`, error);
            return { balance: null, success: false };
        }
    }

    // Updates the balance atomically, handling insufficient funds
    async updateBalance(userId: string, guildId: string, amountChange: bigint):
        Promise<{ newBalance: bigint | null; success: boolean }> {
        this.logger.debug(
            `Updating balance for user (${userId}) in guild (${guildId}) by ${amountChange}...`
        );
        if (amountChange === 0n) {
            this.logger.debug("Amount change is zero, skipping update.");
            // If change is zero, just return current balance without a transaction
            const current = await this.getBalance(userId, guildId);
            return { newBalance: current.balance, success: current.success };
        }

        try {
            // We still need ensureUserGuildStats here in case the user wasn't created yet
            // during a potential getBalance call if that failed or was skipped.
            await this.ensureUserGuildStats(userId, guildId);

            // Transaction to update balance
            const result = await this.prisma.$transaction(async (tx) => {
                const currentStats = await tx.userGuildStats.findUniqueOrThrow({
                    where: { userId_guildId: { userId, guildId } },
                    select: { chips: true },
                });

                const newBalance = currentStats.chips + amountChange;

                // Check for insufficient funds ONLY if deducting balance
                if (amountChange < 0n && newBalance < 0n) {
                    throw new InsufficientFundsError(
                        `Cannot decrease balance by ${Math.abs(Number(amountChange))}. Current balance: ${currentStats.chips}`
                    )
                }

                // Update balance
                const updatedStats = await tx.userGuildStats.update({
                    where: { userId_guildId: { userId, guildId } },
                    data: { chips: newBalance },
                    select: { chips: true },
                })
                return updatedStats.chips;
            })

            this.logger.debug(`Balance updated for user (${userId}) in guild (${guildId}) to ${result}`);
            return { newBalance: result, success: true };
        } catch (error) {
            if (error instanceof InsufficientFundsError) {
                this.logger.warn(
                    `Insufficient funds for User ${userId} in Guild ${guildId}. Change: ${amountChange}`,
                    error.message
                );
                // Return current balance on insufficient funds error, indicate failure
                const current = await this.getBalance(userId, guildId);
                // We throw the original error so the command can catch it specifically
                throw new InsufficientFundsError(`Your balance is ${current.balance}, but you tried to bet ${Math.abs(Number(amountChange))}.`);
            } if (error instanceof PrismaClientKnownRequestError) {
                this.logger.error(
                    `Prisma error updating balance for User ${userId}: ${error.code}`,
                    error,
                );
            } else {
                this.logger.error(
                    `Failed to update balance for User ${userId}}`,
                    error
                );
            }
            // Indicate general failure
            return { newBalance: null, success: false };
        }
    }
}