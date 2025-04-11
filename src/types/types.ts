import type { ButtonInteraction, CacheType, ChatInputCommandInteraction, InteractionCollector, Message, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from "discord.js";
import type { CommandServices } from "./command.types";


//----big blast
export interface PlayerInfo {
    userId: string;
    displayName: string;
    isCPU: boolean;
    eliminated: boolean;
    order: number; // Unique order ID for turn management
}
export interface BigBlastGameState {
    gameId: string;
    gameType: "BigBlast";
    players: PlayerInfo[];
    currentPlayerIndex: number; // Index in the original players array
    turnOrder: number[]; // Array of player 'order' values
    currentTurnIndex: number; // Index in the turnOrder array
    availableSwitches: number;
    detonatorIndex: number;
    status: "waiting" | "playing" | "finished";
    winnerUserId?: string;
    interaction: ChatInputCommandInteraction;
    message: Message;
    collector?: InteractionCollector<ButtonInteraction<CacheType>>;
    wager: bigint;
    cpuDifficulty?: "easy";
    lastMoveTime: number;
    // Lobby specific
    hostId: string;
    invitedPlayerIds: string[];
    acceptedPlayerIds: Set<string>;
}

//----connect4tress
// --- Game State Management (In-memory for now) ---
export interface Connect4tressGameState {
    gameId: string; // Use interaction.id for simplicity
    gameType: "Connect4tress";
    board: number[][];
    players: { userId: string; playerNumber: 1 | 2; isCPU: boolean }[];
    currentPlayer: 1 | 2;
    interaction: ChatInputCommandInteraction;
    message: Message;
    collector?: InteractionCollector<ButtonInteraction<CacheType>>;
    status: "waiting" | "playing" | "finished";
    winner?: 1 | 2 | "draw";
    wager: bigint;
    cpuDifficulty?: "easy";
    lastMoveTime: number;
}

//----blackcat
export interface Card {
    suit: 'Hearts' | 'Diamonds' | 'Clubs' | 'Spades';
    rank: 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
    value: number; // Base value (Ace=11 initially, adjusted later)
    emoji: string; // Combined suit+rank emoji or text
}

// ----Command interface
export interface Command {
    data: SlashCommandOptionsOnlyBuilder | SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder; // Adjust as needed
    execute(
        interaction: ChatInputCommandInteraction,
        services: CommandServices,
    ): Promise<void>;
}
