import { type LootItem, fishingLootTable } from '@/lib/lootTables';
import chalk from 'chalk';
import { type Item, PrismaClient } from 'generated/prisma';

const prisma = new PrismaClient();

interface ValidationResult {
    missingItems: LootItem[];
    dbItemsNotInLootTable: Array<Item>;
    valid: boolean;
}

async function validateLootTables(): Promise<ValidationResult> {
    try {
        // Get all items from database
        const dbItems = await prisma.item.findMany();

        // Check items in loot table that don't exist in DB
        const missingItems = fishingLootTable.filter(
            lootItem => !dbItems.some((dbItem: Item) => dbItem.id === lootItem.itemId)
        );

        // Check items in DB that aren't in loot table
        const dbItemsNotInLootTable = dbItems.filter(
            (dbItem: Item) => !fishingLootTable.some(lootItem => lootItem.itemId === dbItem.id)
        );

        const valid = missingItems.length === 0;

        return {
            missingItems,
            dbItemsNotInLootTable,
            valid
        };
    } catch (error) {
        console.error('Error validating loot tables:', error);
        throw error;
    }
}

async function generateItemCreationScript(items: LootItem[]): Promise<string> {
    const scriptParts: string[] = ['-- Generated Prisma Item Creation Script'];

    for (const item of items) {
        scriptParts.push(`
-- Create ${item.name}
INSERT INTO "Item" ("id", "name", "type", "baseValue")
VALUES (${item.itemId}, '${item.name}', '${item.type}', ${item.baseValue});`);
    }

    return scriptParts.join('\n');
}

async function main() {
    try {
        console.log(chalk.blue('Starting loot table validation...'));

        const result = await validateLootTables();

        if (result.valid) {
            console.log(chalk.green('✓ All loot table items exist in database!'));
        } else {
            console.log(chalk.red('✗ Found discrepancies between loot table and database:'));

            if (result.missingItems.length > 0) {
                console.log(chalk.yellow('\nItems in loot table missing from database:'));
                for (const item of result.missingItems) {
                    console.log(chalk.yellow(`- ${item.name} (ID: ${item.itemId}, Type: ${item.type})`));
                }

                // Generate SQL script for missing items
                const sqlScript = await generateItemCreationScript(result.missingItems);
                console.log(chalk.cyan('\nGenerated SQL script to add missing items:'));
                console.log(sqlScript);
            }

            if (result.dbItemsNotInLootTable.length > 0) {
                console.log(chalk.yellow('\nItems in database not used in loot table:'));
                for (const item of result.dbItemsNotInLootTable) {
                    console.log(chalk.yellow(`- ${item.name} (ID: ${item.id}, Type: ${item.type})`));
                }
            }
        }

        // Template for adding new items
        console.log(chalk.blue('\nTemplate for adding new items to lootTables.ts:'));
        console.log(`
// Example new item template:
{
    itemId: NEXT_ID,  // Next available ID
    name: "Item Name",
    type: 'FISH', // or 'JUNK' or 'BUFF'
    weight: 10,   // Adjust rarity (higher = more common)
    value: 50,    // Chip value
    emoji: '🐠',  // Choose appropriate emoji
},`);

    } catch (error) {
        console.error(chalk.red('Error running validation:'), error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

// Run if this module is being executed directly
if (process.argv[1]?.endsWith('validateLootTables.ts')) {
    main();
}

export { validateLootTables, generateItemCreationScript }; 