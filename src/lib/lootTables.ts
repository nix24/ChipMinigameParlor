// src/lib/lootTables.ts
import type { ItemType } from "@prisma/client"; // Import generated enum type

export interface LootItem {
    itemId: number; // Corresponds to the ID in the Item table
    name: string; // Name for display
    type: ItemType; // Use the generated Prisma enum type
    weight: number; // Higher weight = more common
    baseValue: number; // Use baseValue to match schema
    emoji: string; // Emoji for display
}

// Example Loot Table - NEEDS corresponding entries in the DB Item table!
// Ensure itemIds match your database seed/migration.
export const fishingLootTable: LootItem[] = [
    { itemId: 1, name: "Old Boot", type: 'JUNK', weight: 40, baseValue: 1, emoji: '👢' },
    { itemId: 2, name: "Rusty Can", type: 'JUNK', weight: 30, baseValue: 1, emoji: '🥫' },
    { itemId: 101, name: "Minnow", type: 'FISH', weight: 20, baseValue: 5, emoji: '🐟' },
    { itemId: 102, name: "Trout", type: 'FISH', weight: 15, baseValue: 12, emoji: '🐠' },
    { itemId: 103, name: "Bass", type: 'FISH', weight: 10, baseValue: 25, emoji: '🐡' },
    { itemId: 104, name: "Shiny Carp", type: 'FISH', weight: 3, baseValue: 75, emoji: '✨' },
    // { itemId: 201, name: "Sturdy Rod", type: 'BUFF', weight: 1, baseValue: 0, emoji: '🎣' }, // Example buff item
    // { itemId: 202, name: "Worm Bait", type: 'BUFF', weight: 1, baseValue: 0, emoji: '🪱' }, // Example buff item
];

// Helper function for weighted random selection
export function selectWeightedRandom(items: LootItem[]): LootItem {
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    let random = Math.random() * totalWeight;

    for (const item of items) {
        if (random < item.weight) {
            return item;
        }
        random -= item.weight;
    }

    // Fallback (shouldn't happen if weights are positive)
    return items[items.length - 1];
}
