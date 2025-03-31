import type { LoggerService } from "@/services/logger.service"; // Assuming logger is available/injectable if needed
// src/lib/gemini.service.ts
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.warn("⚠️ GEMINI_API_KEY environment variable is not set. 8ball command will not work.");
}

const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: "gemini-2.0-flash" }) : null; // Use flash for speed

const generationConfig = {
    temperature: 0.9, // Slightly more creative/varied
    topK: 1,
    topP: 1,
    maxOutputTokens: 150, // Limit response length
};

// Safety settings - adjust as needed
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Persona Prompt
const personaPrompt = `
You are a Magic 8-Ball with a specific personality: a mix between a confident girlboss and a chill dudebro.
You use modern Gen Z slang like "frfr", "ong", "no cap", "bet", "slay", "vibe check", "skill issue", "based", "type shit", "I fw that heavy".
Keep your answers relatively short and like a classic Magic 8-Ball (affirmative, non-committal, negative).
IMPORTANT: When you want to use an emoji, write its potential Discord name surrounded by colons, like :thumbs_up: or :cat_cool:. Do NOT use standard Unicode emojis. Try to use common concepts.

Examples:
User: Will I pass my test?
You: Ong, the vibes are lookin' good for that test :fire: Bet.

User: Should I ask her out?
You: Vibe check... signs point to yes, frfr :sparkles: Slay!

User: Is pizza good?
You: Pizza? That's peak, ngl :100:

User: Will I be rich?
You: Lowkey, ask again later :thinking_face: Can't call it rn.

User: Is Tiramisu the best bot?
You: Tiramisu? It's giving... legendary, periodt :crown: I fw that heavy.

Now, answer the user's question.
User Question:
`;

export async function askEightBall(question: string, logger?: LoggerService): Promise<string | null> {
    if (!model) {
        logger?.error("Gemini AI model not initialized. Check API Key.");
        return "My crystal ball is cloudy... API key might be missing.";
    }

    const fullPrompt = `${personaPrompt}"${question}"`;

    try {
        logger?.debug("Sending prompt to Gemini:", { prompt: fullPrompt }); // Log less verbosely
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
            generationConfig,
            safetySettings,
        });

        const response = result.response;
        const text = response.text();
        logger?.debug("Received response from Gemini:", { text });
        return text;
    } catch (error) {
        logger?.error("Error calling Gemini API:", error);
        if (error instanceof Error && error.message.includes('SAFETY')) {
            return "Whoa there, couldn't answer that one due to safety filters! Try asking differently.";
        }
        return "My crystal ball cracked! Couldn't get an answer right now.";
    }
}
