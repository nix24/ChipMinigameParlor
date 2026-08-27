# Chip Minigame Parlor 🎰 🐈

[![Bun](https://img.shields.io/badge/Bun-≥1.4.0-000000?style=flat-square&logo=bun&logoColor=fbf0df)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-000000?style=flat-square&logo=typescript&logoColor=3178C6)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-000000?style=flat-square&logo=discord&logoColor=5865F2)](https://discord.js.org/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-000000?style=flat-square&logo=prisma&logoColor=2D3748)](https://www.prisma.io/)
[![Neon](https://img.shields.io/badge/Neon-Serverless_Postgres-000000?style=flat-square&logo=neon&logoColor=00E5CA)](https://neon.tech/)
[![Bun Test](https://img.shields.io/badge/Bun-Test-000000?style=flat-square&logo=bun&logoColor=fbf0df)](https://bun.sh/docs/cli/test)
[![Oxc](https://img.shields.io/badge/Oxc-Lint%2FFormat-000000?style=flat-square)](https://oxc.rs/)
[![MIT License](https://img.shields.io/badge/License-MIT-000000?style=flat-square&logoColor=white)](LICENSE)

Welcome to the **Chip Minigame Parlor**, your friendly neighborhood casino cat Discord bot! Engage in fun minigames, manage your chip economy, and climb the leaderboards.

Built with a modern tech stack including Bun, TypeScript, Discord.js v14, Prisma ORM with Neon serverless Postgres, Bun Test, and Oxc for linting/formatting.

## ✨ Features

- **Economy System:** Earn, wager, and track your "chips" (💰).
  - `/balance [user?]`: Check chip balance.
  - `/sell <item|all>`: Sell items (like fish) for chips.
- **Minigames:**
  - `/coinflip`: A classic coin flip (Deluxe features planned!).
  - `/connect4tress`: Connect 4 with a twist! Full rows disappear, adding a strategic layer. Play against the CPU or challenge friends via a lobby system.
  - `/bigblast`: A 4-player luck-based game of pressing switches and avoiding the bomb! Supports CPU players and lobbies. High-risk, high-reward wagers.
  - `/blackcat`: Classic Blackjack against the CPU dealer. Hit or Stand!
  - `/fishing`: Cast your line to catch fish and other items. Includes a cooldown.
  - `/8ball <question>`: Consult the mystical (and sassy) 8-ball powered by Google Gemini for answers.
- **Leaderboards:**
  - `/leaderboard <type> [page?]`: View server rankings for the richest players or most games played.
- **(Planned)**
  - `/catheist`: High-stakes best-of-3 poker against the house.
  - Enhanced `/coinflip deluxe`.

## 🚀 Getting Started

### Prerequisites

- **Bun:** Version 1.4.0 or higher.
- **Package Manager:** Bun.
- **Database:** A NeonDB serverless Postgres instance (or standard Postgres). Get connection strings from [Neon](https://neon.tech/).
- **Discord Bot:** A Discord application and bot token. See [Discord Developer Portal](https://discord.com/developers/applications).
- **Gemini API Key:** For the `/8ball` command. Get one from [Google AI Studio](https://aistudio.google.com/app/apikey).

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/nix24/chipminigameparlor.git
    cd chipminigameparlor
    ```
2.  **Install dependencies:**
    ```bash
    bun install
    ```

### Configuration

1.  **Create a `.env` file** in the root directory by copying `.env.example`:
    ```bash
    cp .env.example .env
    ```
2.  **Fill in the required variables** in the `.env` file:
    - `DISCORD_BOT_TOKEN`: Your Discord bot token.
    - `DISCORD_CLIENT_ID`: Your Discord application's client ID (needed for registering commands).
    - `DATABASE_URL`: Your primary NeonDB (or Postgres) connection string (used for migrations and general access).
    - `DIRECT_URL`: Your _direct_ NeonDB (or Postgres) connection string (used by Prisma Migrate). Often the same as `DATABASE_URL` but without connection pooling for Neon.
    - `GEMINI_API_KEY`: Your Google Gemini API key.

### Database Setup

1.  **Apply Migrations:** Ensure your database schema is up-to-date.
    ```bash
    bun run db:migrate
    ```
2.  **Generate Prisma Client:** Create the type-safe database client.
    ```bash
    bun run db:generate
    ```
3.  **(Optional) Seed Database:** Populate initial data, especially the `Item` table for `/fishing`.
    ```bash
    bunx prisma db seed
    ```
    _(Make sure you have a seed script defined, like the example provided for fishing items)_

### Running the Bot

1.  **Register Slash Commands:** Run this once after setting up your `.env` file or whenever you add/modify commands.
    ```bash
    bun run commands:register
    ```
2.  **Start Development Server (with hot-reloading):**
    ```bash
    bun run dev
    ```
3.  **Build for Production:**
    ```bash
    bun run build
    ```
4.  **Start Production Server:**
    ```bash
    bun run start
    ```

## 🛠️ Development Workflow

Use these commands to help during development:

| Command                     | Action                               |
| :-------------------------- | :----------------------------------- |
| `bun run dev`               | Start the bot with file watching     |
| `bun run dev:test`          | Watch the Bun test suite             |
| `bun run check`             | Verify lint and formatting rules     |
| `bun run fix`               | Apply lint and formatting fixes      |
| `bun run format`            | Format source with Oxfmt             |
| `bun run test`              | Execute the Bun test suite           |
| `bun run test:coverage`     | Generate test coverage reports       |
| `bun run typecheck`         | Type-check without emitting files    |
| `bun run build`             | Create the production build          |
| `bun run start`             | Start the production bot with Bun    |
| `bun run db:migrate`        | Run database migrations              |
| `bun run db:generate`       | Generate Prisma Client               |
| `bun run db:studio`         | Open Prisma Studio GUI               |
| `bun run commands:register` | Register slash commands with Discord |
| `bun run db:validate`       | Validate loot tables vs DB           |

## 📁 Project Structure

```tree
┣ src/
┃ ┣ commands/
┃ ┃ ┣ economy/
┃ ┃ ┃ ┣ balance.command.ts
┃ ┃ ┃ ┣ fishing.command.ts
┃ ┃ ┃ ┣ leaderboard.command.ts
┃ ┃ ┃ ┗ sell.command.ts
┃ ┃ ┗ games/
┃ ┃   ┣ 8ball.command.ts
┃ ┃   ┣ bigblast.command.ts
┃ ┃   ┣ blackcat.command.ts
┃ ┃   ┣ catheist.command.ts
┃ ┃   ┣ coinflip.command.ts
┃ ┃   ┗ connect4tress.command.ts
┃ ┣ core/
┃ ┃ ┣ handleInteraction.ts
┃ ┃ ┗ registerCommands.ts
┃ ┣ events/
┃ ┣ lib/
┃ ┃ ┣ emoji.ts
┃ ┃ ┗ lootTables.ts
┃ ┣ scripts/
┃ ┃ ┗ validateLootTables.ts
┃ ┣ services/
┃ ┃ ┣ economy.service.ts
┃ ┃ ┣ gemini.service.ts
┃ ┃ ┣ logger.service.ts
┃ ┃ ┗ prisma.service.ts
┃ ┣ types/
┃ ┃ ┣ command.types.ts
┃ ┃ ┗ types.ts
┃ ┣ utils/
┃ ┃ ┣ blackcat.logic.ts
┃ ┃ ┣ connect4tress.logic.ts
┃ ┃ ┣ cpu.logic.ts
┃ ┃ ┗ poker.logic.ts
┃ ┣ index.test.ts
┃ ┗ index.ts
┣ .env
┣ .env.example
┣ .gitignore
┣ .oxfmtrc.json
┣ .oxlintrc.json
┣ blueprint.md
┣ LICENSE
┣ NOTICE.md
┣ bun.lock
┣ package.json
┣ README.md
┣ repomix-output.pdf
┣ repomix-output.txt
┗ tsconfig.json
```

## Build Process

The project uses a custom build process that includes:

1. Cleaning the build directory
2. Generating Prisma client
3. Compiling TypeScript code
4. Resolving path aliases
5. Copying assets
6. Fixing Prisma imports

### Fixing Prisma Imports

The build process includes a custom step that converts all `generated/prisma` imports to relative imports in the compiled JavaScript files. This is necessary because:

- In TypeScript, imports from `generated/prisma` work correctly with path aliases
- In the compiled JavaScript, these imports need to be relative to work properly

The script `src/scripts/fixPrismaImports.ts` handles this conversion by:

1. Finding all JavaScript files in the build directory
2. Replacing imports like `from 'generated/prisma/index'` with relative imports like `from '../../generated/prisma/index'`
3. Writing the modified files back to disk

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Build for production
bun run build

# Start the bot
bun run start
```

## Testing

```bash
# Run tests
bun run test

# Run tests with coverage
bun run test:coverage
```

## Database

```bash
# Run database migrations
bun run db:migrate

# Generate Prisma client
bun run db:generate

# Open Prisma Studio
bun run db:studio
```
