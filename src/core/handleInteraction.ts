import { validatedCommands } from "@/commands";
import { LoggerService } from "@/services/logger.service"; // Use alias
import type { CommandServices } from "@/types/command.types"; // Import the new interface
import type { Command } from "@/types/types";
// src/core/handleInteraction.ts
import { type BaseInteraction, Collection } from "discord.js";
import { container as globalContainer } from "tsyringe";


// Cache commands to avoid reloading them on every interaction
const commands = new Collection<string, Command>();

export async function loadCommands(): Promise<void> {
    const logger = globalContainer.resolve(LoggerService);
    commands.clear(); // Clear existing commands before reloading

    logger.info(`Loading ${validatedCommands.length} commands...`);

    for (const commandInstance of validatedCommands) {
        commands.set(commandInstance.data.name, commandInstance);
        logger.debug(`Loaded command: ${commandInstance.data.name}`);
    }

    logger.info(`Loaded ${commands.size} commands.`);
}

// Call loadCommands once during startup (e.g., in bootstrap after DI setup)
// await loadCommands(); // Add this line in src/index.ts bootstrap function

export async function handleInteraction(
    interaction: BaseInteraction,
    // Accept resolved services directly - Use CommandServices here for consistency, even though handleInteraction *creates* it
    services: CommandServices, // Use the CommandServices interface
): Promise<void> {
    if (!interaction.isChatInputCommand()) return; // Only handle slash commands for now

    const { logger } = services; // Destructure logger
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
