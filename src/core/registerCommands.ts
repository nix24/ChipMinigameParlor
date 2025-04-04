import path from "node:path";
import { fileURLToPath } from "node:url"; // Keep fileURLToPath if used for logging
import type { Command } from "@/commands/games/coinflip.command";
import { LoggerService } from "@/services/logger.service"; // Use alias
import { findCommandFiles, isCommandClass } from "@/utils/commandLoader.utils"; // Import helpers
import { REST, Routes } from "discord.js";
// src/core/registerCommands.ts
import dotenv from "dotenv";
import { container } from "tsyringe"; // Keep for now

dotenv.config();
// Get the directory name in ESM - Still needed for commandsPath
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = container.resolve(LoggerService); // Resolve logger instance - Keep tsyringe for now

// Removed local isCommandClass definition

export async function registerCommands() {
    const commandDataList: Command["data"][] = []; // Array to hold command data for registration
    const commandsPath = path.join(__dirname, "../commands");
    const commandFiles = await findCommandFiles(commandsPath); // Use imported helper

    for (const file of commandFiles) {
        try {
            // Use dynamic import() for ESM - expects a URL
            const commandModule = await import(file);
            const commandCandidate = commandModule.default || commandModule;
            let commandInstance: Command | null = null;

            // Use imported helper
            if (isCommandClass(commandCandidate)) {
                // Instantiate the Command class
                commandInstance = new commandCandidate();
            } else if (commandCandidate && typeof commandCandidate.execute === 'function' && commandCandidate.data) {
                // It's likely already an instance
                commandInstance = commandCandidate as Command;
            }

            // Validate the final instance and push its data
            if (commandInstance?.data) {
                commandDataList.push(commandInstance.data);
                logger.debug(`Loaded command data: ${commandInstance.data.name} from ${fileURLToPath(file)}`);
            } else {
                logger.warn(`Invalid command structure in file: ${fileURLToPath(file)}`);
            }
        } catch (error) {
            logger.error(`Error loading command from file ${fileURLToPath(file)}:`, error);
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

// Removed local findCommandFiles definition
