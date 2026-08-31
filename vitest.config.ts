import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, main: "./src/index.ts" }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
