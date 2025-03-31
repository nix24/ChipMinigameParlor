// src/lib/poker.logic.ts
// Assuming 'poker-evaluator' is installed
// Adjust import based on the actual library structure if needed
import type { Card } from '@/types/types';
import PokerEvaluator from 'poker-evaluator'; // Or specific functions if available

/** Deals two 5-card hands */
export function dealPokerHands(deck: Card[]): { playerHand: Card[]; cpuHand: Card[] } {
    if (deck.length < 10) {
        throw new Error("Insufficient cards in deck to deal poker hands.");
    }
    const playerHand = deck.splice(-5); // Take 5 cards from the end
    const cpuHand = deck.splice(-5);    // Take next 5 cards
    return { playerHand, cpuHand };
}

/** Formats hand for poker-evaluator library */
function formatCardForEval(card: Card): string {
    const rank = card.rank === '10' ? 'T' : card.rank; // Use 'T' for 10
    const suit = card.suit.charAt(0).toLowerCase(); // h, d, c, s
    return `${rank}${suit}`;
}

export function formatHandForEval(hand: Card[]): string[] {
    return hand.map(formatCardForEval);
}

/**
 * Evaluates two 5-card hands using poker-evaluator.
 * @returns 1 if player wins, 2 if CPU wins, 0 for a tie.
 */
export function evaluatePokerHands(playerHand: Card[], cpuHand: Card[]): 0 | 1 | 2 {
    const playerHandStr = formatHandForEval(playerHand);
    const cpuHandStr = formatHandForEval(cpuHand);

    // Ensure exactly 5 cards are passed if the library requires it
    if (playerHandStr.length !== 5 || cpuHandStr.length !== 5) {
        console.error("Invalid hand size for evaluation:", playerHandStr, cpuHandStr);
        throw new Error("Internal error: Invalid hand size for poker evaluation.");
    }

    try {
        const playerResult = PokerEvaluator.evalHand(playerHandStr);
        const cpuResult = PokerEvaluator.evalHand(cpuHandStr);

        if (playerResult.value > cpuResult.value) return 1; // Player wins
        if (cpuResult.value > playerResult.value) return 2; // CPU wins
        return 0; // Tie
    } catch (error) {
        console.error("Error evaluating poker hands:", error);
        throw new Error("Internal error during hand evaluation.");
    }
}

/** Gets the readable name of the hand rank */
export function getHandRankName(hand: Card[]): string {
    const handStr = formatHandForEval(hand);
    if (handStr.length !== 5) return "Invalid Hand";
    try {
        return PokerEvaluator.evalHand(handStr).handName;
    } catch {
        return "Evaluation Error";
    }
}
