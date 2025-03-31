import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url"; // Import fileURLToPath and pathToFileURL
import type { Command } from "@/commands/games/coinflip.command"; // Adjust path as needed
import { LoggerService } from "@/services/logger.service"; // Use alias
import type { CommandServices } from "@/types/command.types"; // Import the new interface
// src/core/handleInteraction.ts
import { type BaseInteraction, Collection } from "discord.js";
import { container as globalContainer } from "tsyringe";

// Get the directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache commands to avoid reloading them on every interaction
const commands = new Collection<string, Command>();

// Helper type guard to check if something is a class constructor
// We expect Command constructors specifically, though type system can't fully enforce parameterless here
function isCommandClass(v: unknown): v is new () => Command {
    return typeof v === 'function' && /^\s*class\s+/.test(v.toString());
}

export async function loadCommands(): Promise<void> {
    const logger = globalContainer.resolve(LoggerService);
    commands.clear(); // Clear existing commands before reloading
    // Construct path using the derived __dirname
    const commandsPath = path.join(__dirname, "../commands");
    const commandFiles = await findCommandFiles(commandsPath);

    for (const file of commandFiles) {
        try {
            // Use dynamic import() for ESM
            const commandModule = await import(file);
            const commandCandidate = commandModule.default || commandModule;
            let commandInstance: Command | null = null;

            // Check if the export is a Command class constructor
            if (isCommandClass(commandCandidate)) {
                // Instantiate the Command class
                commandInstance = new commandCandidate();
            } else if (commandCandidate && typeof commandCandidate.execute === 'function' && commandCandidate.data) {
                // It's likely already an instance that fits the Command structure
                commandInstance = commandCandidate as Command;
            }

            // Validate the final instance
            if (commandInstance && typeof commandInstance.execute === "function" && commandInstance.data) {
                commands.set(commandInstance.data.name, commandInstance);
                logger.debug(`Interaction handler loaded command: ${commandInstance.data.name}`);
            } else {
                logger.warn(
                    `Invalid command structure found for interaction handling in: ${fileURLToPath(file)}`,
                );
            }
        } catch (error) {
            logger.error(`Error loading command for interaction handler ${fileURLToPath(file)}:`, error);
        }
    }
}

// Call loadCommands once during startup (e.g., in bootstrap after DI setup)
// await loadCommands(); // Add this line in src/index.ts bootstrap function

export async function handleInteraction(
    interaction: BaseInteraction,
    // Accept resolved services directly - Use CommandServices here for consistency, even though handleInteraction *creates* it
    services: CommandServices, // Use the CommandServices interface
): Promise<void> {
    if (!interaction.isChatInputCommand()) return; // Only handle slash commands for now

    const { logger } = services; // Destructure prisma
    const command = commands.get(interaction.commandName);

    if (!command) {
        logger.warn(`No command matching interaction '${interaction.commandName}' was found.`);
        try {
            await interaction.reply({
                content: "Sorry, I don't recognize that command.",
                ephemeral: true,
            });
        } catch (replyError) {
            logger.error("Failed to send 'command not found' reply:", replyError);
        }
        return;
    }

    try {
        logger.debug(`Executing command: ${interaction.commandName}`);
        // Services are already resolved and passed in
        // Pass the services object conforming to CommandServices
        await command.execute(interaction, services);
    } catch (error) {
        logger.error(`Error executing command ${interaction.commandName}:`, error);
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: "There was an error while executing this command!",
                    ephemeral: true,
                });
            } else {
                await interaction.reply({
                    content: "There was an error while executing this command!",
                    ephemeral: true,
                });
            }
        } catch (replyError) {
            logger.error("Failed to send error reply to interaction:", replyError);
        }
    }
}

// Helper function (duplicate from registerCommands - consider moving to a shared util)
async function findCommandFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
        entries.map(async (entry) => {
            const res = path.resolve(dir, entry.name);
            if (entry.isDirectory()) {
                return findCommandFiles(res);
            } if (
                entry.isFile() &&
                (res.endsWith(".command.ts") || res.endsWith(".command.js"))
            ) {
                // For dynamic import, we need file URLs
                return pathToFileURL(res).href; // Use the imported pathToFileURL
            }
            return [];
        }),
    );
    return files.flat();
}
