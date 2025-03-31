import "reflect-metadata";
import { Client, Events, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
// import { container } from "tsyringe"; // Removed tsyringe container usage for core services
import { handleInteraction, loadCommands } from "./core/handleInteraction";
import { registerCommands } from "./core/registerCommands";
import { EconomyService } from "./services/economy.service";
import { LoggerService } from "./services/logger.service";
import { PrismaService } from "./services/prisma.service";

//initialize 
dotenv.config();

async function bootstrap() {
    // Manual Service Instantiation
    const logger = new LoggerService();
    logger.info("Starting bot...");
    const prismaService = new PrismaService();
    // Allow Prisma time to connect (or add explicit init method)
    await new Promise(resolve => setTimeout(resolve, 2000)); // Simple wait, consider better readiness check
    const economyService = new EconomyService(prismaService, logger);

    //validate env
    const token = process.env.DISCORD_BOT_TOKEN;
    const databaseUrl = process.env.DATABASE_URL;

    if (!token) {
        logger.fatal("Missing DISCORD_BOT_TOKEN");
        process.exit(1);
    }
    if (!databaseUrl) {
        logger.fatal("Missing DATABASE_URL");
        process.exit(1);
    }

    //ensure prisma client is initialized (already connected by constructor)
    try {
        // Optional: Run a simple query to be absolutely sure
        await prismaService.$queryRaw`SELECT 1`;
        logger.info("Prisma client connection verified.");
    } catch (dbError) {
        logger.fatal("Failed to verify database connection", dbError);
        process.exit(1);
    }

    // Load commands for interaction handling
    // Note: loadCommands might still use tsyringe's global container if it resolves Logger itself.
    // If errors persist there, Logger needs to be passed to loadCommands.
    try {
        await loadCommands();
        logger.info("Successfully loaded commands for interaction handling");
    } catch (error) {
        logger.error("Failed to load commands for interaction handling:", error);
        process.exit(1);
    }

    //initialize discord client
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers,
        ],
    });

    //register event listeners
    client.once(Events.ClientReady, async (readyClient) => {
        logger.info(`Ready! Logged in as ${readyClient.user.tag}`);
        // Note: registerCommands might still use tsyringe's global container.
        // If errors persist there, Logger needs to be passed.
        try {
            await registerCommands(); // Register slash commands
            logger.info("Successfully registered application commands.");
        } catch (error) {
            logger.error("Failed to register application commands:", error);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        // Pass the manually instantiated instances
        await handleInteraction(interaction, {
            economy: economyService,
            logger: logger,
            prisma: prismaService,
        });
    });

    //login to discord
    try {
        await client.login(token);
    } catch (error) {
        logger.fatal("Failed to login to discord", error);
        process.exit(1);
    }

    //gracefully shutdown
    process.on("SIGINT", async () => {
        logger.info("Received SIGINT. Shutting down...");
        await prismaService.disconnect(); // Use disconnect method if available
        client.destroy();
        process.exit(0);
    });

    process.on("SIGTERM", async () => {
        logger.info("Received SIGTERM. Shutting down...");
        await prismaService.disconnect(); // Use disconnect method if available
        client.destroy();
        process.exit(0);
    });
}

bootstrap().catch((error) => {
    //fallback catch for unhandled errors
    console.error("Unhandled error in bootstrap", error);
    process.exit(1);
});


