import { validatedCommands } from "@/commands";
import { LoggerService } from "@/services/logger.service"; // Use alias
import type { Command } from "@/types/types";
import { REST, Routes } from "discord.js";
// src/core/registerCommands.ts
import dotenv from "dotenv";
import { container } from "tsyringe"; // Keep for now

dotenv.config();

// Removed local isCommandClass definition

export async function registerCommands() {
    const logger = container.resolve(LoggerService);
    const commandDataList: Command["data"][] = [];

    logger.info(`registering data for ${validatedCommands.length} commands...`);
    for (const commandInstance of validatedCommands) {
        if (commandInstance.data) {
            commandDataList.push(commandInstance.data);
            logger.debug(`registering ${commandInstance.data.name}`);
        } else {
            logger.warn("Invalid command structure:", commandInstance);
        }
    }

    const token = process.env.DISCORD_BOT_TOKEN;
    const clientId = process.env.DISCORD_CLIENT_ID; // Add CLIENT_ID to .env!

    if (!token || !clientId) {
        logger.error(
            "DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID is missing. Cannot register commands.",
        );
        return;
    }

    const rest = new REST({ version: "10" }).setToken(token);

    try {
        logger.info(
            `Started refreshing ${commandDataList.length} application (/) commands.`,
        );

        // Use put method to ensure commands are overwritten (good for development)
        const data = (await rest.put(Routes.applicationCommands(clientId), {
            body: commandDataList.map((cmd) => cmd.toJSON()), // Ensure data is serialized
        })) as unknown[]; // Type assertion might be needed depending on API version

        logger.info(
            `Successfully reloaded ${data.length} application (/) commands.`,
        );
    } catch (error) {
        logger.error("Failed to refresh application commands:", error);
        throw error; // Re-throw to be caught in index.ts
    }
}