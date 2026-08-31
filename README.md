# Chip Minigame Parlor

A Cloudflare Worker Discord interactions bot. D1 owns the guild-scoped economy and roguelite saves; a SQLite-backed Durable Object owns each live multiplayer game.

## Current command status

Every prior command name is registered: `balance`, `daily`, `fishing`, `leaderboard`, `sell`, `8ball`, `bigblast`, `blackcat`, `catheist`, `coinflip`, and `connect4tress`. Only economy reads/daily claims and the Big Blast lobby are live in this foundation; the remaining game mechanics deliberately respond with a clear in-progress message.

## Local setup

1. Copy `.env.example` to `.dev.vars` and set `DISCORD_CLIENT_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_PUBLIC_KEY`.
2. Create a Cloudflare D1 database and replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc`.
3. Run `bun install`, `bun run db:migrate:local`, then `bun run dev`.
4. Register application commands with `bun run commands:register`.

Use Cloudflare secrets for production. `GEMINI_API_KEY` is optional, and `DATABASE_URL` is intentionally gone.

## Commands

| Command                     | Purpose                                                   |
| --------------------------- | --------------------------------------------------------- |
| `bun run dev`               | Start the local Worker with simulated bindings            |
| `bun run test`              | Run Cloudflare Worker and Durable Object tests            |
| `bun run check`             | Lint, format-check, and type-check                        |
| `bun run db:generate`       | Generate a Drizzle SQL migration                          |
| `bun run db:migrate:local`  | Apply migrations to local D1                              |
| `bun run db:migrate:remote` | Apply migrations to production D1                         |
| `bun run deploy`            | Deploy the Worker after production secrets are configured |

## Architecture

```text
Discord HTTP interaction
  -> Worker signature verification and routing
  -> D1 / Drizzle for chips, inventory, leaderboards, and saved runs
  -> one Durable Object per live lobby or game
```

The Worker validates Discord's Ed25519 signature before parsing interaction data. Button IDs route to the owning game object, so Big Blast’s lobby membership is durable and serialized instead of living in a process-local collector.
