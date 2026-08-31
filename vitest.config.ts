import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(new URL("./drizzle/migrations", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      main: "./src/index.ts",
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.resolve(migrationsPath)) },
      },
    })),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
