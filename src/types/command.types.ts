import type { EconomyService } from "@/services/economy.service";
import type { LoggerService } from "@/services/logger.service";
import type { PrismaService } from "@/services/prisma.service";

/**
 * Defines the structure for services passed to command execute methods.
 */
export interface CommandServices {
    economy: EconomyService;
    logger: LoggerService;
    prisma: PrismaService;
} 