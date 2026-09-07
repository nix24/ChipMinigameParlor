// oxlint-disable-next-line typescript/triple-slash-reference -- Wrangler emits global Worker declarations.
/// <reference path="../worker-configuration.d.ts" />

export interface Env extends Omit<Cloudflare.Env, "TEST_GUILD_ID"> {
  // The local runner receives this value from authenticated production configuration.
  TEST_GUILD_ID: string;
  GEMINI_API_KEY?: string;
  NODE_ENV?: string;
  BOT_ADMIN_TOKEN?: string;
  DISCORD_CLIENT_SECRET?: string;
}
