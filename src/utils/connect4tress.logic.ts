// src/lib/connect4tress.logic.ts

export const ROWS = 6;
export const COLS = 7;
const EMPTY = 0;

/**
 * Creates a new game board initialized with empty cells.
 * @returns A 2D number array representing the board.
 */
export function createBoard(): number[][] {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
}

/**
 * Checks if placing a chip in the given column is a valid move.
 * @param board The current game board.
 * @param col The column index (0-based).
 * @returns True if the move is valid, false otherwise.
 */
export function isValidMove(board: number[][], col: number): boolean {
    return col >= 0 && col < COLS && board[0][col] === EMPTY; // Check top row
}

/**
 * Finds the lowest available row in a given column.
 * @param board The current game board.
 * @param col The column index (0-based).
 * @returns The row index (0-based) or -1 if the column is full.
 */
function findLowestEmptyRow(board: number[][], col: number): number {
    for (let r = ROWS - 1; r >= 0; r--) {
        if (board[r][col] === EMPTY) {
            return r;
        }
    }
    return -1; // Column is full
}

/**
 * Places a chip for the given player in the specified column.
 * Modifies the board in place.
 * @param board The current game board.
 * @param col The column index (0-based).
 * @param playerNumber The player number (1 or 2).
 * @returns True if the chip was placed successfully, false otherwise.
 */
export function placeChip(
    board: number[][],
    col: number,
    playerNumber: 1 | 2,
): boolean {
    if (!isValidMove(board, col)) {
        return false;
    }
    const row = findLowestEmptyRow(board, col);
    if (row !== -1) {
        board[row][col] = playerNumber;
        return true;
    }
    return false; // Should not happen if isValidMove passed, but for safety
}

/**
 * Checks if the specified player has won.
 * @param board The current game board.
 * @param playerNumber The player number (1 or 2).
 * @returns True if the player has won, false otherwise.
 */
export function checkWin(board: number[][], playerNumber: 1 | 2): boolean {
    // Check horizontal
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c <= COLS - 4; c++) {
            if (
                board[r][c] === playerNumber &&
                board[r][c + 1] === playerNumber &&
                board[r][c + 2] === playerNumber &&
                board[r][c + 3] === playerNumber
            ) {
                return true;
            }
        }
    }

    // Check vertical
    for (let r = 0; r <= ROWS - 4; r++) {
        for (let c = 0; c < COLS; c++) {
            if (
                board[r][c] === playerNumber &&
                board[r + 1][c] === playerNumber &&
                board[r + 2][c] === playerNumber &&
                board[r + 3][c] === playerNumber
            ) {
                return true;
            }
        }
    }

    // Check positive diagonal (\)
    for (let r = 0; r <= ROWS - 4; r++) {
        for (let c = 0; c <= COLS - 4; c++) {
            if (
                board[r][c] === playerNumber &&
                board[r + 1][c + 1] === playerNumber &&
                board[r + 2][c + 2] === playerNumber &&
                board[r + 3][c + 3] === playerNumber
            ) {
                return true;
            }
        }
    }

    // Check negative diagonal (/)
    for (let r = 3; r < ROWS; r++) {
        for (let c = 0; c <= COLS - 4; c++) {
            if (
                board[r][c] === playerNumber &&
                board[r - 1][c + 1] === playerNumber &&
                board[r - 2][c + 2] === playerNumber &&
                board[r - 3][c + 3] === playerNumber
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Checks if the board is completely full.
 * @param board The current game board.
 * @returns True if the board is full, false otherwise.
 */
export function isBoardFull(board: number[][]): boolean {
    return board[0].every((cell) => cell !== EMPTY); // Check only the top row
}

/**
 * Applies gravity to chips above a cleared row.
 * Modifies the board in place.
 * @param board The game board.
 * @param clearedRowIndex The index of the row that was cleared.
 */
function applyGravity(board: number[][], clearedRowIndex: number): void {
    for (let r = clearedRowIndex; r > 0; r--) {
        for (let c = 0; c < COLS; c++) {
            board[r][c] = board[r - 1][c]; // Move chip down
        }
    }
    // Fill the top row with empty cells
    for (let c = 0; c < COLS; c++) {
        board[0][c] = EMPTY;
    }
}

/**
 * Handles the "4tress" mechanic: checks for and clears full rows, applying gravity.
 * Modifies the board in place.
 * @param board The game board.
 * @returns True if any rows were cleared, false otherwise.
 */
export function handle4tress(board: number[][]): boolean {
    let rowsCleared = false;
    for (let r = ROWS - 1; r >= 0; r--) {
        // Check if row is full (all non-empty)
        if (board[r].every((cell) => cell !== EMPTY)) {
            applyGravity(board, r);
            rowsCleared = true;
            // Important: Re-check the same row index again after gravity,
            // as the row above might also become full and fall into this index.
            // However, a simple loop might clear multiple rows at once correctly.
            // Let's refine: applyGravity shifts everything down, so we only need one pass.
            // Correction: If multiple rows are cleared, gravity needs careful handling.
            // Let's clear all full rows first, then apply gravity based on the number cleared below.

            // Simpler approach: Clear one row, apply gravity, then re-check from bottom.
            // Let's stick to the original idea: clear one row at a time and apply gravity.
            // If a row is cleared, we need to re-evaluate from that row index upwards
            // in the *next* iteration, or simply restart the check.
            // Let's restart the check from the bottom if a row is cleared.
            r = ROWS; // Reset loop to re-check from bottom after gravity
        }
    }
    return rowsCleared;
}

/**
 * Renders the game board to a string representation using emojis.
 * @param board The current game board.
 * @returns A string representing the board.
 */
export function renderBoardToString(board: number[][]): string {
    const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];
    const player1Emoji = "🔴"; // Red
    const player2Emoji = "🟡"; // Yellow (or use ⚫ for black)
    const emptyEmoji = "⚪"; // White

    let boardString = "";
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            switch (board[r][c]) {
                case 1:
                    boardString += player1Emoji;
                    break;
                case 2:
                    boardString += player2Emoji;
                    break;
                default:
                    boardString += emptyEmoji;
                    break;
            }
            boardString += " "; // Add space between cells
        }
        boardString += "\n"; // Newline after each row
    }
    // Add column numbers at the bottom
    boardString += numberEmojis.join(" ");
    return boardString;
}
