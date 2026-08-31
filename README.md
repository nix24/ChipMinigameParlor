# Chip Minigame Parlor

A Cloudflare Worker Discord interactions bot. D1 owns the guild-scoped economy and roguelite saves; a SQLite-backed Durable Object owns each live multiplayer game.

## Current command status

Every prior command name is registered: `balance`, `daily`, `fishing`, `leaderboard`, `sell`, `8ball`, `bigblast`, `blackcat`, `catheist`, `coinflip`, and `connect4tress`. Only economy reads/daily claims and the Big Blast lobby are live in this foundation; the remaining game mechanics deliberately respond with a clear in-progress message.

## Local setup

1. Copy `.env.example` to `.dev.vars` and set `DISCORD_CLIENT_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_PUBLIC_KEY`.
2. Run `bun install`, `bun run db:migrate:local`, then `bun run dev`.
   Local D1 and Durable Object state stays under the ignored `.wrangler/` directory.
3. Use `bun run release:staging` when the change needs a stable public Worker for Discord testing.
4. Register application commands with `bun run commands:register`.

Staging and production use separate Workers and D1 databases. Pushes to `main` run the production
deployment workflow after checks and migrations pass. Use Cloudflare secrets for deployed Workers.
`GEMINI_API_KEY` is optional, and `DATABASE_URL` is intentionally gone.

`wrangler dev` is local-only, so Discord cannot send interactions to it without a public tunnel.
Use local tests for the fastest loop. For live Discord testing without moving the production
endpoint, point a separate Discord development application at the staging Worker.

Before the first production push, add `CLOUDFLARE_ACCOUNT_ID` and a narrowly scoped
`CLOUDFLARE_API_TOKEN` to the GitHub repository's Actions secrets and bootstrap the Worker's three
Discord secrets in Cloudflare. Later deployments preserve those Worker secrets.

## Commands

| Command                         | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `bun run dev`                   | Start the local Worker with simulated bindings      |
| `bun run test`                  | Run Cloudflare Worker and Durable Object tests      |
| `bun run check`                 | Lint, format-check, and type-check                  |
| `bun run db:generate`           | Generate a Drizzle SQL migration                    |
| `bun run db:migrate:local`      | Apply migrations to local D1                        |
| `bun run release:staging`       | Check, test, migrate, and deploy the staging Worker |
| `bun run db:migrate:production` | Apply migrations to production D1                   |
| `bun run deploy`                | Deploy the production Worker                        |

## Architecture

```text
Discord HTTP interaction
  -> Worker signature verification and routing
  -> D1 / Drizzle for chips, inventory, leaderboards, and saved runs
  -> one Durable Object per live lobby or game
```

The Worker validates Discord's Ed25519 signature before parsing interaction data. Button IDs route to the owning game object, so Big Blast’s lobby membership is durable and serialized instead of living in a process-local collector.

The economy is guild-scoped and uses an append-only chip transaction ledger. Discord interaction
IDs make daily claims and wagers idempotent, database constraints prevent negative or unsafe chip
balances, and a partial unique index permits only one active roguelite run per player and guild.
Inventory uses the same player-and-guild ownership boundary, so future games cannot accidentally
share items across servers.

Existing accounts use one D1 batch for a daily claim or final wager settlement. Account creation is
only attempted after a missing-account read, live multiplayer turns remain inside the Durable
Object, and leaderboard reads use a covering guild-and-chip index. This keeps the normal production
path bounded without adding speculative caches or per-turn D1 traffic.
