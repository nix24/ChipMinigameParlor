// src/lib/cpu.logic.ts
import {
    COLS,
    checkWin,
    isValidMove,
    placeChip,
} from "./connect4tress.logic"; // Import necessary functions

/**
 * Determines the CPU's next move in Connect 4tress.
 * @param board The current game board.
 * @param cpuPlayerNumber The CPU's player number (1 or 2).
 * @param humanPlayerNumber The human opponent's player number (1 or 2).
 * @returns The column index (0-based) for the CPU's move, or -1 if no valid move.
 */
export function getCpuMove(
    board: number[][],
    cpuPlayerNumber: 1 | 2,
    humanPlayerNumber: 1 | 2,
): number {
    // --- Strategy: ---
    // 1. Check if CPU can win in the next move
    for (let c = 0; c < COLS; c++) {
        if (isValidMove(board, c)) {
            const tempBoard = board.map((row) => [...row]); // Create a copy
            placeChip(tempBoard, c, cpuPlayerNumber);
            if (checkWin(tempBoard, cpuPlayerNumber)) {
                return c; // Winning move
            }
        }
    }

    // 2. Check if human can win in the next move, and block them
    for (let c = 0; c < COLS; c++) {
        if (isValidMove(board, c)) {
            const tempBoard = board.map((row) => [...row]); // Create a copy
            placeChip(tempBoard, c, humanPlayerNumber);
            if (checkWin(tempBoard, humanPlayerNumber)) {
                return c; // Blocking move
            }
        }
    }

    // 3. Fallback: Choose a random valid column
    const validMoves: number[] = [];
    for (let c = 0; c < COLS; c++) {
        if (isValidMove(board, c)) {
            validMoves.push(c);
        }
    }

    if (validMoves.length === 0) {
        return -1; // No valid moves left
    }

    const randomIndex = Math.floor(Math.random() * validMoves.length);
    return validMoves[randomIndex];
}
