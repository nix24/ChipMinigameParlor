# Chip Minigame Parlor

A Cloudflare Worker Discord interactions bot. D1 owns the guild-scoped economy and roguelite saves; a SQLite-backed Durable Object owns each live multiplayer game.

## Current command status

Every prior command name is registered: `balance`, `daily`, `fishing`, `leaderboard`, `sell`, `8ball`, `bigblast`, `blackcat`, `catheist`, `coinflip`, and `connect4tress`. Only economy reads/daily claims and the Big Blast lobby are live in this foundation; the remaining game mechanics deliberately respond with a clear in-progress message.

## Local setup

1. Copy `.env.example` to `.dev.vars` and set `DISCORD_CLIENT_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_PUBLIC_KEY`.
2. Run `bun install`, `bun run db:migrate:local`, then `bun run dev`.
   Local D1 and Durable Object state stays under the ignored `.wrangler/` directory.
3. Use `bun run dev:discord` for same-bot testing in the designated test server (setup below).
4. Register application commands with `bun run commands:register`.

Staging and production use separate Workers and D1 databases. Pushes to `main` run the production
deployment workflow after checks and migrations pass. Use Cloudflare secrets for deployed Workers.
`GEMINI_API_KEY` is optional, and `DATABASE_URL` is intentionally gone.

Local development explicitly selects the `local` environment, which has a local-only database
binding and no Gateway connection or cron. Its database is separate from both cloud databases
and from the older unnamed local environment. Existing local test data is not migrated automatically.

## Same bot: production and local Discord testing

The Discord application's Interactions Endpoint URL stays on the production Worker. Only server
`1115740106918203453` (`TEST_GUILD_ID` in `wrangler.jsonc`) can route to local dev. All other servers
continue using production. No endpoint swapping or second bot token is needed.

One-time setup before using the new commands:

1. Install the tunnel executable: `brew install cloudflared`.
2. In ignored `.dev.vars`, set `BOT_PRODUCTION_URL` to the production Worker HTTPS origin and
   `BOT_ADMIN_TOKEN` to a new random secret of at least 32 bytes. Keep the existing Discord credentials.
3. Store the same admin token in production using `bunx wrangler secret put BOT_ADMIN_TOKEN --env=""`.
   This changes a remote secret; do it as part of the authorized rollout. Do not put it in Git.
4. Deploy this revision through the normal `main` workflow. Keep the existing Discord Interactions
   Endpoint URL on production. After cron propagation, `bun run bot:status` should report `ready`.
   Stop any older Gateway host for this identity during cutover so it does not compete for sessions.

Daily workflow:

| Command               | Result                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `bun run dev:discord` | Migrates local D1, starts the local Worker and a quick tunnel, then routes only the test server to it |
| Ctrl+C                | Stops local dev; the test server reports dev unavailable, without accessing production                |
| `bun run bot:prod`    | Explicitly switches the test server to production; other servers are unchanged                        |
| `bun run bot:status`  | Shows Gateway and test-server routing status without exposing credentials                             |
| `bun run bot:restart` | Retries Gateway recovery after fixing an invalid token or other fatal configuration error             |

Dev replies are marked `[DEV]`. Buttons carry an environment marker, so buttons from one
environment cannot affect the other after switching. Pre-existing unmarked buttons work only in
production. When the test server has never been switched, it defaults to dev unavailable.

The tunnel lease renews every 30 seconds and expires after two minutes. An expired lease, stopped
computer, bad tunnel response, or two-second forwarding timeout returns a dev error. There is no
automatic production fallback and no forwarding retry of a potentially completed mutation.
An explicit production switch also prevents an old dev process from renewing itself back into control.
Only one local session can hold the active lease; after an abrupt stop, allow up to two minutes
before starting a replacement. Quick tunnels are temporary development infrastructure, not an SLA.
Startup allows about two minutes for tunnel propagation. A local proxy exposes only signed
interaction delivery and the dev health check; Wrangler's database explorer and admin routes are blocked.
Keep `global_fetch_strictly_public` enabled: the deployed routing object must reach the tunnel
through Cloudflare's public routing. Without it, live tunnel checks returned HTTP 530 / error 1016.

Local game/database execution avoids cloud D1 and game-object usage. Testing still sends requests
through the production Worker and its routing object, and lease renewals incur small control writes.
This is not a zero-cost cloud proxy. Staging remains available, but uses cloud resources and has no
Gateway connection. Slash-command definitions are shared by the Discord application: do not run
global command registration from experimental code; use Discord guild-scoped registration for schema changes.

## Gateway and cost bounds

One `GatewayPresence` Durable Object, named `singleton`, owns the production connection and dev
route. A once-per-minute production cron starts/rechecks it, including after deploys or eviction.
No connection is created per guild, game, interaction, or local test session. Command delivery stays
on the existing HTTP handler; presence uses zero Gateway intents and does not process game commands.

The connection handles heartbeats and missing ACKs, resume sessions, invalid sessions, fatal close
codes, and connection deadlines. Reconnect backoff grows from one minute to 15 minutes and resets
only after five minutes of stable readiness. Fresh IDENTIFY attempts are at least two minutes apart
and respect Discord's remaining session allowance. Heartbeats do not write to D1 or object storage.
Gateway session metadata and reconnect budgets persist in the single object. Fatal errors stop retries
until an explicit restart. Gateway downtime does not disable HTTP commands.

The account currently uses Workers Free and its platform-enforced CPU limit. Custom CPU limits
require Workers Paid, so this configuration does not set one or require a plan upgrade.
The outbound Gateway WebSocket cannot hibernate. At the documented 128 MB allocation, one
continuously active connection uses approximately 11,059 GB-s/day of the Free plan's shared
13,000 GB-s/day allowance. Exceeding a Free limit makes affected operations fail until the limit
resets; this setup does not upgrade the account to Paid. Presence therefore leaves limited duration
headroom for other objects. Monitor account usage, game-object storage, and the transaction ledger
as the bot grows. A future Paid upgrade changes this cost boundary and needs a fresh budget review.

References: [Discord Gateway](https://docs.discord.com/developers/events/gateway),
[Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Worker CPU limits](https://developers.cloudflare.com/workers/platform/pricing/),
[Quick tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

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
