// src/lib/emoji.ts
import type { ChatInputCommandInteraction } from "discord.js";

/**
 * Finds custom guild emojis matching :emoji_name: placeholders in text.
 * @param text The text potentially containing placeholders.
 * @param interaction The command interaction to access guild emojis.
 * @returns The text with placeholders replaced by found custom emojis.
 */
export function replaceEmojiPlaceholders(text: string, interaction: ChatInputCommandInteraction): string {
    if (!interaction.guild) {
        // Cannot replace custom emojis outside a guild
        return text.replace(/:\w+:/g, ''); // Remove placeholders if not in guild
    }

    const emojiCache = interaction.guild.emojis.cache;
    if (emojiCache.size === 0) {
        return text.replace(/:\w+:/g, ''); // Remove placeholders if no custom emojis
    }

    // Regex to find :emoji_name: patterns
    return text.replace(/:(\w+):/g, (_match, emojiName) => {
        // Find emoji by name (case-insensitive)
        const foundEmoji = emojiCache.find(emoji => emoji.name?.toLowerCase() === emojiName.toLowerCase());

        if (foundEmoji && !foundEmoji.animated) { // Only use non-animated emojis
            return foundEmoji.toString(); // Replace with <[:name:]id>
        }
        // Fallback: If no custom emoji found, remove the placeholder for now
        // Alternatively, map common names to Unicode here
        return '';
    });
}
