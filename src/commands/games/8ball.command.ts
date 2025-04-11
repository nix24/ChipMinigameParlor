// src/commands/fun/8ball.command.ts
import { replaceEmojiPlaceholders } from "@/lib/emoji";
import type { EconomyService } from "@/services/economy.service";
import { askEightBall } from "@/services/gemini.service";
import type { LoggerService } from "@/services/logger.service";
import type { Command } from "@/types/types";
import type { PrismaClient } from "@prisma/client";
import {
    type ChatInputCommandInteraction,
    EmbedBuilder,
    SlashCommandBuilder,
} from "discord.js";



class EightBallCommand implements Command {
    data = new SlashCommandBuilder()
        .setName("8ball")
        .setDescription("Consult the mystical (Gen Z) 8-ball.")
        .addStringOption(option =>
            option.setName("question")
                .setDescription("The question you want to ask the 8-ball.")
                .setRequired(true)
        );

    async execute(
        interaction: ChatInputCommandInteraction,
        services: { economy: EconomyService; logger: LoggerService; prisma: PrismaClient },
    ): Promise<void> {
        const { logger } = services;
        const question = interaction.options.getString("question", true);

        if (!process.env.GEMINI_API_KEY) {
            await interaction.reply({ content: "The 8-ball is sleeping... (API key not configured).", ephemeral: true });
            return;
        }
        if (!interaction.inGuild()) {
            await interaction.reply({ content: "The 8-ball needs server vibes (and emojis) to work properly!", ephemeral: true });
            return;
        }


        await interaction.deferReply();

        try {
            const rawAnswer = await askEightBall(question, logger);

            if (!rawAnswer) {
                await interaction.editReply("The 8-ball is silent right now...");
                return;
            }

            // Process the answer for emojis
            const finalAnswer = replaceEmojiPlaceholders(rawAnswer, interaction);

            const embed = new EmbedBuilder()
                .setColor(0x5865F2) // Discord Blurple
                .setTitle("🎱 The 8-Ball Says...")
                .addFields(
                    { name: "Your Question", value: question },
                    { name: "Answer", value: finalAnswer }
                )
                .setFooter({ text: `Asked by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error("Error executing 8ball command:", error);
            await interaction.editReply({ content: "The 8-ball shattered! An error occurred." }).catch(() => { });
        }
    }
}

export default new EightBallCommand();
