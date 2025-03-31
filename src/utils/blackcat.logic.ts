// src/lib/blackcat.logic.ts

import type { Card } from "../types/types";

const SUITS = { Hearts: '❤️', Diamonds: '♦️', Clubs: '♣️', Spades: '♠️' };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** Creates a standard 52-card deck */
export function createDeck(): Card[] {
    const deck: Card[] = [];
    for (const suit of Object.keys(SUITS) as (keyof typeof SUITS)[]) {
        for (const rank of RANKS) {
            let value: number;
            if (rank === 'A') {
                value = 11; // Ace initially 11
            } else if (['K', 'Q', 'J'].includes(rank)) {
                value = 10;
            } else {
                value = Number.parseInt(rank, 10);
            }
            deck.push({ suit, rank: rank as Card['rank'], value, emoji: `${SUITS[suit]}${rank}` }); // Combine emoji + rank for display
        }
    }
    return deck;
}

/** Shuffles a deck using Fisher-Yates algorithm */
export function shuffleDeck(deck: Card[]): void {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]]; // Swap
    }
}

/** Deals one card from the top of the deck */
export function dealCard(deck: Card[]): Card | undefined {
    return deck.pop();
}

/** Calculates the best value of a hand, handling Aces */
export function calculateHandValue(hand: Card[]): { value: number; isSoft: boolean } {
    let value = 0;
    let aceCount = 0;
    let isSoft = false;

    for (const card of hand) {
        value += card.value;
        if (card.rank === 'A') {
            aceCount++;
        }
    }

    // Adjust for Aces if value > 21
    while (value > 21 && aceCount > 0) {
        value -= 10; // Change Ace value from 11 to 1
        aceCount--;
    }

    // Check if the hand is soft (contains an Ace counted as 11)
    isSoft = hand.some(card => card.rank === 'A' && value <= 21 && card.value === 11);
    // Re-calculate aceCount specifically for soft check
    let softAceCount = 0;
    let tempValue = 0;
    for (const card of hand) {
        tempValue += card.value;
        if (card.rank === 'A') softAceCount++;
    }
    while (tempValue > 21 && softAceCount > 0) {
        tempValue -= 10;
        softAceCount--;
    }
    isSoft = softAceCount > 0 && tempValue <= 21;


    return { value, isSoft };
}

/** Checks if the initial two cards form a Blackjack */
export function isBlackjack(hand: Card[]): boolean {
    return hand.length === 2 && calculateHandValue(hand).value === 21;
}

/** Renders a hand to a string */
export function renderHand(hand: Card[], hideFirstCard = false): string {
    if (hideFirstCard && hand.length > 0) {
        // Show first card as hidden, then the rest
        return `❓ ${hand.slice(1).map(card => card.emoji).join(' ')}`;
    }
    return hand.map(card => card.emoji).join(' ');
}

/** Determines the winner based on final values */
export function determineWinner(
    playerValue: number,
    dealerValue: number,
    playerBusted: boolean,
    dealerBusted: boolean,
    playerBlackjack: boolean,
    dealerBlackjack: boolean
): 'win' | 'lose' | 'push' | 'blackjack' {
    if (playerBlackjack && dealerBlackjack) return 'push';
    if (playerBlackjack) return 'blackjack'; // Player wins 3:2
    if (dealerBlackjack) return 'lose';
    if (playerBusted) return 'lose';
    if (dealerBusted) return 'win';
    if (playerValue > dealerValue) return 'win';
    if (dealerValue > playerValue) return 'lose';
    return 'push'; // Tie
}
