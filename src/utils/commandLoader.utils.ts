import { Command } from "@/types/types";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Assuming Command interface is defined representatively here, adjust if a central type exists

/**
 * Type guard to check if a value is a class constructor for a Command.
 * @param v The value to check.
 * @returns True if the value is a Command class constructor, false otherwise.
 */
export function isCommandClass(v: unknown): v is new () => Command {
    // Basic check for function and class structure
    return typeof v === 'function' && /^\s*class\s+/.test(v.toString());
}

/**
 * Recursively finds files ending with .command.ts or .command.js in a directory.
 * @param dir The directory to search in.
 * @returns A promise that resolves to an array of file URLs (as strings).
 */
export async function findCommandFiles(dir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(
            entries.map(async (entry) => {
                const res = path.resolve(dir, entry.name);
                if (entry.isDirectory()) {
                    // Recursively search subdirectories
                    return findCommandFiles(res);
                }
                // No 'else' needed here, if it wasn't a directory, check if it's a matching file
                if (
                    entry.isFile() &&
                    // Look for specific suffixes
                    (res.endsWith(".command.ts") || res.endsWith(".command.js"))
                ) {
                    // Return file URL for dynamic import()
                    return pathToFileURL(res).href;
                }
                // Return empty array for non-matching files/dirs or if not a file/directory
                return [];
            }),
        );
        // Flatten the array of arrays/strings into a single array of strings
        return files.flat();
    } catch (error) {
        // Log or handle the error appropriately, e.g., if the directory doesn't exist
        console.error(`Error reading directory ${dir}:`, error);
        // Return an empty array to allow the process to continue if possible
        return [];
    }
} 