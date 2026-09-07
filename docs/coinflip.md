# Coinflip

Coinflip is a single-player Discord Activity on the existing Worker. Players choose Heads or Tails,
set a whole-number wager, and flip. A match returns twice the wager, including the stake; a miss loses
the stake. Each outcome uses an unbiased bit from `crypto.getRandomValues`. Presentation never affects
odds. There are no streak bonuses, escalating bets, or automatic wagers.

## Play and local preview

Run `bun run dev` and open its local URL in a browser. The practice table starts with 100 pretend
chips, offers a refill at zero, and makes no game API calls. Practice balance and the last six outcomes
live only in memory. Sound starts off. The Motion control follows the system preference on startup.
Controls support keyboard input and narrow screens.

`build/activity` is disposable generated output: each Activity build replaces it so obsolete hashed
bundles are not carried into a deployment.

Inside Discord, the Activity connects to the server's chip balance. A failed login leaves the visibly
labelled practice table available. DMs support practice only. The same browser assets serve both modes;
the official Embedded App SDK loads only in an embedded session.

`/coinflip` without options responds with Discord's `LAUNCH_ACTIVITY` callback. Existing callers that
supply both `amount` and `choice` retain the chat result and the same economy rules. Supplying only one
option fails validation without placing a wager.

## Discord setup before live use

These steps change external configuration and are deliberately separate from building this branch.

1. In the existing application's Discord Developer Portal, enable Activities and the supported
   desktop/mobile platforms. Add an OAuth2 redirect URI as described in Discord's setup guide
   (`https://127.0.0.1` is the documented placeholder for Embedded SDK authorization).
2. Set the Activity URL mapping prefix `/` to the deployed Worker's hostname, without `https://` or
   a file path. The Worker's root serves the Activity; `POST /` remains signed interaction delivery.
3. Add the application's OAuth2 client secret as `DISCORD_CLIENT_SECRET` to the intended Worker
   environment. For local development, put it in ignored `.dev.vars`. Never put it in frontend code.
   The existing `DISCORD_CLIENT_ID` identifies the same application.
4. Deploy through the normal authorized workflow. Wrangler builds the Activity automatically. No new
   database, migration, service, or game Durable Object is required.
5. Register the updated slash-command definition so `/coinflip` options become optional. Use a
   guild-scoped registration while testing; the existing registration script targets global commands.
   Global registration and deployment need their normal release authorization.
6. Launch in a server, grant `identify` and `guilds.members.read`, and verify one small wager against
   `/balance`. Test the actual Discord client on desktop and mobile before opening distribution.

The ordinary browser preview needs no OAuth secret. Without that secret, server-chip login returns
a clear unavailable response; it never silently wagers with a guessed identity.

References: [Discord Activity setup](https://docs.discord.com/developers/activities/building-an-activity),
[Activity networking](https://docs.discord.com/developers/activities/development-guides/networking),
[current-user guild membership](https://docs.discord.com/developers/resources/user#get-current-user-guild-member).

## Same-bot local testing

Run the existing `bun run dev:discord` workflow. It starts local D1, supplies `TEST_GUILD_ID`, and prints
the HTTPS tunnel origin. Use that origin as your personal **Application URL Override** in Discord's
developer Activity controls. This keeps the shared production URL mapping in place. Direct overrides
use same-origin `/api/activity/*`; normal Discord proxy sessions use `/.proxy/api/activity/*`.
The development proxy permits only the Activity page, bundled JS/CSS, config, session, and flip routes
alongside existing signed interactions and health checks. Admin and local explorer routes stay blocked.

Activity browser traffic does not inherit slash-command forwarding. The production Activity refuses
server chips in `TEST_GUILD_ID` unless the bot control route explicitly selects production. It checks
again on every wager, so switching the test server to dev also blocks already-open production sessions.
Other production servers do not consult that object. Local sessions accept only `TEST_GUILD_ID`.

Do not point the shared Activity URL mapping at an ephemeral tunnel. Discord also supports a separate
development application if testing the proxy itself is needed; that is a separate setup decision.
See [Discord local development and URL overrides](https://docs.discord.com/developers/activities/development-guides/local-development).

## Ownership, recovery, and cost

- `activity/` owns rendering, input, sound, and practice. The scene animates transforms rather than
  running a render loop. It has no idle animation, polling, uploaded image assets, or audio downloads.
  Recent outcomes are capped at six; a celebration creates at most 20 short-lived particles.
- `src/games/coinflip-api.ts` owns the Activity HTTP boundary. It exchanges the OAuth code server-side
  and verifies membership through Discord's current-user endpoint. The client cannot supply a player
  ID, server ID, payout, or result when wagering. Bodies are capped at 2 KiB and validated with Zod.
- A signed session binds user, guild, application, environment, and a maximum 15-minute expiry. Tokens
  stay in memory. Session signing uses a domain-separated HMAC key derived from the OAuth client secret.
  Secret rotation invalidates existing sessions. Membership is rechecked on reconnection, not per frame
  or per wager; membership changes may therefore take up to the session lifetime to take effect.
- `src/games/coinflip.ts` shares settlement rules with chat. D1 remains the source of truth. An existing
  player's round uses one batch: conditional ledger insert, account update, applied marker, stored
  result, and balance lookup. First-time account creation uses the existing initialization path.
- Before sending a wager, the browser saves only its UUID, amount, and choice in session storage,
  scoped to environment, guild, and user. Until the result is confirmed, controls remain locked and **Check result**
  retries that same wager. Refreshing the Activity preserves this retry ID; reconnecting renews identity
  without changing it. The ledger protects against duplicate delivery and concurrent retries.
- A closed/discarded tab may lose session storage; any settled round remains in the ledger. Balances
  are snapshots from login or settlement, with no background refresh. Other tabs or chat commands may
  change a balance; the next settlement still enforces the real D1 balance. Switch to practice and
  reconnect to refresh explicitly after `/daily`.

Normal login uses two bounded Discord HTTP calls plus the existing balance lookup; subsequent rounds
need no Discord REST calls until reconnection. Animation and sound add no D1 work. Static assets use
the existing Worker's asset binding. This reduces per-round overhead; each real wager still grows the
transaction ledger and incurs its ordinary D1 reads/writes. The one-batch regression test checks that
the existing-account path stays bounded. Authentication is not a global abuse or spending quota.

## Verification

```sh
bun run check
bun run test
bun run test:activity
```

The browser check needs a Chromium-family browser. Set `BUN_CHROME_PATH` when it is not discoverable.
It uses Bun.WebView, a loopback fixture server, and the real Embedded SDK with a simulated Discord
host. It covers mobile fit, practice isolation, sound, reduced motion, keyboard dismissal, login,
lost-response recovery across reload, expired-session reconnection, insufficient chips, and denied
membership. Screenshots are written to `/tmp/coinflip-desktop.png` and `/tmp/coinflip-mobile.png`.
The fixture browser runs without its process sandbox against local test content only.

Worker tests exercise real local D1 for settlement, idempotency, authorization, validation, and
test-environment isolation. Fixture checks do not replace a real Discord OAuth/launch walkthrough;
that requires the portal settings and environment secret above.
