# Chip Minigame Parlor 🎰 🐈

[![Node.js](https://img.shields.io/badge/Node.js-≥22.0.0-000000?style=flat-square&logo=node.js&logoColor=339933)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-000000?style=flat-square&logo=typescript&logoColor=3178C6)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-000000?style=flat-square&logo=discord&logoColor=5865F2)](https://discord.js.org/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-000000?style=flat-square&logo=prisma&logoColor=2D3748)](https://www.prisma.io/)
[![Neon](https://img.shields.io/badge/Neon-Serverless_Postgres-000000?style=flat-square&logo=neon&logoColor=00E5CA)](https://neon.tech/)
[![Vitest](https://img.shields.io/badge/Vitest-Testing-000000?style=flat-square&logo=vitest&logoColor=6E9F18)](https://vitest.dev/)
[![Biome](https://img.shields.io/badge/Biome-Lint/Format-000000?style=flat-square&logo=biome&logoColor=5FA5FA)](https://biomejs.dev/)
[![MIT License](https://img.shields.io/badge/License-MIT-000000?style=flat-square&logoColor=white)](LICENSE)

Welcome to the **Chip Minigame Parlor**, your friendly neighborhood casino cat Discord bot! Engage in fun minigames, manage your chip economy, and climb the leaderboards.

Built with a modern tech stack including Node.js, TypeScript, Discord.js v14, Prisma ORM with Neon serverless Postgres, Vitest for testing, and Biome for linting/formatting.

## ✨ Features

*   **Economy System:** Earn, wager, and track your "chips" (💰).
    *   `/balance [user?]`: Check chip balance.
    *   `/sell <item|all>`: Sell items (like fish) for chips.
*   **Minigames:**
    *   `/coinflip`: A classic coin flip (Deluxe features planned!).
    *   `/connect4tress`: Connect 4 with a twist! Full rows disappear, adding a strategic layer. Play against the CPU or challenge friends via a lobby system.
    *   `/bigblast`: A 4-player luck-based game of pressing switches and avoiding the bomb! Supports CPU players and lobbies. High-risk, high-reward wagers.
    *   `/blackcat`: Classic Blackjack against the CPU dealer. Hit or Stand!
    *   `/fishing`: Cast your line to catch fish and other items. Includes a cooldown.
    *   `/8ball <question>`: Consult the mystical (and sassy) 8-ball powered by Google Gemini for answers.
*   **Leaderboards:**
    *   `/leaderboard <type> [page?]`: View server rankings for the richest players or most games played.
*   **(Planned)**
    *   `/catheist`: High-stakes best-of-3 poker against the house.
    *   Enhanced `/coinflip deluxe`.

## 🚀 Getting Started

### Prerequisites

*   **Node.js:** Version 22.0.0 or higher.
*   **Package Manager:** pnpm (recommended), npm, or yarn.
*   **Database:** A NeonDB serverless Postgres instance (or standard Postgres). Get connection strings from [Neon](https://neon.tech/).
*   **Discord Bot:** A Discord application and bot token. See [Discord Developer Portal](https://discord.com/developers/applications).
*   **Gemini API Key:** For the `/8ball` command. Get one from [Google AI Studio](https://aistudio.google.com/app/apikey).

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/nix24/chipminigameparlor.git
    cd chipminigameparlor
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    # or pnpm install / yarn install
    ```

### Configuration

1.  **Create a `.env` file** in the root directory by copying `.env.example`:
    ```bash
    cp .env.example .env
    ```
2.  **Fill in the required variables** in the `.env` file:
    *   `DISCORD_BOT_TOKEN`: Your Discord bot token.
    *   `DISCORD_CLIENT_ID`: Your Discord application's client ID (needed for registering commands).
    *   `DATABASE_URL`: Your primary NeonDB (or Postgres) connection string (used for migrations and general access).
    *   `DIRECT_URL`: Your *direct* NeonDB (or Postgres) connection string (used by Prisma Migrate). Often the same as `DATABASE_URL` but without connection pooling for Neon.
    *   `GEMINI_API_KEY`: Your Google Gemini API key.

### Database Setup

1.  **Apply Migrations:** Ensure your database schema is up-to-date.
    ```bash
    pnpm db:migrate
    # or npx prisma migrate dev
    ```
2.  **Generate Prisma Client:** Create the type-safe database client.
    ```bash
    pnpm db:generate
    # or npx prisma generate
    ```
3.  **(Optional) Seed Database:** Populate initial data, especially the `Item` table for `/fishing`.
    ```bash
    pnpm db:seed
    # or npx prisma db seed (requires configuration in package.json)
    ```
    *(Make sure you have a seed script defined, like the example provided for fishing items)*

### Running the Bot

1.  **Register Slash Commands:** Run this once after setting up your `.env` file or whenever you add/modify commands.
    ```bash
    pnpm commands:register
    # or tsx src/core/registerCommands.ts
    ```
2.  **Start Development Server (with hot-reloading):**
    ```bash
    pnpm dev
    ```
3.  **Build for Production:**
    ```bash
    pnpm build
    ```
4.  **Start Production Server:**
    ```bash
    pnpm start
    ```

## 🛠️ Development Workflow

Use these commands to help during development:

| Command                 | Action                              |
| :---------------------- | :---------------------------------- |
| `npm dev`              | Start dev server with file watching |
| `npm dev:test`         | Start test suite with file watching |
| `npm check`            | Verify code formatting & lint rules |
| `npm fix`              | Auto-fix formatting & lint issues   |
| `npm format`           | Format code without lint fixes      |
| `npm test`             | Execute test suite                  |
| `npm test:coverage`    | Generate test coverage reports      |
| `npm build`            | Create production build             |
| `npm start`            | Start optimized production server   |
| `npm db:migrate`       | Run database migrations             |
| `npm db:generate`      | Generate Prisma Client              |
| `npm db:studio`        | Open Prisma Studio GUI              |
| `npm commands:register`| Register slash commands with Discord|
| `npm db:validate`      | Validate loot tables vs DB          |

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
┣ biome.json
┣ blueprint.md
┣ LICENSE
┣ NOTICE.md
┣ package-lock.json
┣ package.json
┣ README.md
┣ repomix-output.pdf
┣ repomix-output.txt
┣ tsconfig.json
┣ tsconfig.tsbuildinfo
┗ vite.config.ts
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
pnpm install

# Run in development mode
pnpm dev

# Build for production
pnpm build

# Start the bot
pnpm start
```

## Testing

```bash
# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage
```

## Database

```bash
# Run database migrations
pnpm db:migrate

# Generate Prisma client
pnpm db:generate

# Open Prisma Studio
pnpm db:studio