import { builtinModules } from 'node:module'; // Import built-in modules
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
// vite.config.ts
import { defineConfig } from "vite"; // Use 'vite' instead of 'vitest/config'
import { viteStaticCopy } from 'vite-plugin-static-copy'; // Import copy plugin
import tsconfigPaths from "vite-tsconfig-paths";
import type { ViteUserConfig } from 'vitest/config'; // Keep Vitest config type if needed

// Define __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define Vitest config separately
const testConfig: ViteUserConfig['test'] = {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        thresholds: {
            lines: 90,
            functions: 90,
            branches: 90,
            statements: 90,
        },
    },
};
// Find 
// all .ts files in src to use as potential entry points for structure preservation
const entries = Object.fromEntries(
    glob
        .sync("src/**/*.ts") // Find all ts files
        .map((file: string) => [
            // Generate entry name (relative path without extension)
            path.relative(
                "src",
                file.slice(0, file.length - path.extname(file).length),
            ),
            // Full path to the file
            fileURLToPath(new URL(file, import.meta.url)),
        ]),
);

export default defineConfig(({ mode }) => ({
    plugins: [
        tsconfigPaths(),
        // Copy prisma schema during build
        viteStaticCopy({
            targets: [
                {
                    src: 'prisma/schema.prisma',
                    dest: 'prisma' // Copies to dist/prisma/schema.prisma
                },
                // Add other assets if needed, like .env.example
                {
                    src: '.env.example',
                    dest: '.' // Copies to dist/.env.example
                }
            ]
        })
    ],
    // --- Define Globals ---
    // Make __dirname available, as Prisma client might rely on it internally
    // even when externalized, especially during initialization paths.
    define: {
        '__dirname': JSON.stringify(__dirname),
    },
    // --- Build Configuration ---
    build: {
        outDir: "dist", // Output directory (instead of 'build')
        sourcemap: true, // Generate source maps for easier debugging
        target: "node20",
        rollupOptions: {
            input: entries,
            preserveEntrySignatures: "strict",
            external: [
                ...builtinModules, // Externalize built-ins (e.g., 'fs', 'path')
                ...builtinModules.map((m) => `node:${m}`), // Also externalize prefixed versions (e.g., 'node:fs')
                // List your dependencies from package.json [cite: 906]
                "discord.js",
                "@google/generative-ai",
                "@prisma/client",
                "@prisma/adapter-neon", // Add adapter [cite: 906]
                "@neondatabase/serverless", // Add serverless driver [cite: 906]
                "cache-manager",
                "cacheable",
                "chalk",
                "date-fns",
                "dotenv",
                "keyv",
                "pino",
                "pino-pretty",
                "poker-evaluator",
                "reflect-metadata",
                "tsyringe", // Keep if still used elsewhere, otherwise remove
                "ws",
                "zod",
                // Add any other runtime dependencies here
            ],
            output: {
                format: "es",
                dir: "dist",
                preserveModules: true,
                entryFileNames: "[name].js",
            }
        },
        minify: mode === 'production', // Minify only in production mode
        emptyOutDir: true, // Clean output directory before build
    },
    // --- Test Configuration (from your original file) ---
    test: testConfig,
}));