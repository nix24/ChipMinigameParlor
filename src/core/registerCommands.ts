import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Command } from "@/commands/games/coinflip.command";
import { LoggerService } from "@/services/logger.service"; // Use alias
// src/core/registerCommands.ts
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import dotenv from "dotenv";
import { container } from "tsyringe";

dotenv.config();
// Get the directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = container.resolve(LoggerService); // Resolve logger instance

// Helper type guard (duplicate, consider moving to shared util)
function isCommandClass(v: unknown): v is new () => Command {
    return typeof v === 'function' && /^\s*class\s+/.test(v.toString());
}

export async function registerCommands() {
    const commandDataList: Command["data"][] = []; // Array to hold command data for registration
    const commandsPath = path.join(__dirname, "../commands");
    const commandFiles = await findCommandFiles(commandsPath);

    for (const file of commandFiles) {
        try {
            // Use dynamic import() for ESM - expects a URL
            const commandModule = await import(file);
            const commandCandidate = commandModule.default || commandModule;
            let commandInstance: Command | null = null;

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

// Helper function to recursively find command files (duplicate)
async function findCommandFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
        entries.map(async (entry) => {
            const res = path.resolve(dir, entry.name);
            if (entry.isDirectory()) {
                return findCommandFiles(res);
            } if (
                entry.isFile() &&
                (res.endsWith(".command.ts") || res.endsWith(".command.js")) // Look for specific suffix
            ) {
                // Return file URL for dynamic import()
                return pathToFileURL(res).href;
            }
            return []; // Return empty array for non-matching files/dirs
        }),
    );
    return files.flat(); // Flatten the array of arrays
}
