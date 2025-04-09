import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Converts generated/prisma imports to relative imports in a file
 * @param filePath Path to the file to process
 */
function fixPrismaImports(filePath: string): void {
    try {
        // Read the file content
        const content = fs.readFileSync(filePath, 'utf8');

        // Check if the file contains any Prisma imports
        if (!content.includes('generated/prisma')) {
            return; // Skip files without Prisma imports
        }

        // Get the relative path from the current file to the generated/prisma directory
        const relativePath = path.relative(
            path.dirname(filePath),
            path.resolve(__dirname, '../../build/generated/prisma')
        ).replace(/\\/g, '/');

        // If the relative path is empty (same directory), use './'
        const prefix = relativePath === '' ? './' : `${relativePath}/`;

        // Direct replacement for the specific case we're seeing
        let newContent = content.replace(
            /import\s+{\s*Prisma\s*}\s+from\s+['"]generated\/prisma['"]/g,
            `import { Prisma } from '${prefix}index.js'`
        );

        // Regular expressions to match different import patterns from generated/prisma
        const importPatterns = [
            // Standard import pattern
            /from\s+['"]generated\/prisma\/([^'"]+)['"]/g,
            // Import with index.js explicitly mentioned
            /from\s+['"]generated\/prisma\/([^'"]+)\/index['"]/g,
            // Import without specifying a file (assumes index)
            /from\s+['"]generated\/prisma['"]/g
        ];

        // Apply each pattern
        for (const pattern of importPatterns) {
            if (pattern.toString().includes('generated\\/prisma[\'"]')) {
                // Special case for imports without specifying a file
                newContent = newContent.replace(pattern, `from '${prefix}index.js'`);
            } else {
                // Standard case for imports with a specific file
                newContent = newContent.replace(pattern, (_match, importPath) => {
                    // Add .js extension if not already present
                    const jsPath = importPath.endsWith('.js') ? importPath : `${importPath}.js`;
                    return `from '${prefix}${jsPath}'`;
                });
            }
        }

        // Write the modified content back to the file
        if (content !== newContent) {
            fs.writeFileSync(filePath, newContent, 'utf8');
            console.log(`Fixed Prisma imports in ${filePath}`);
            console.log(`  Changed imports to use relative path: ${prefix}`);

            // Debug: Show the changes
            const originalImports = content.match(/from\s+['"]generated\/prisma[^'"]*['"]/g) || [];
            const newImports = newContent.match(/from\s+['"][^'"]*prisma[^'"]*['"]/g) || [];

            console.log('  Original imports:', originalImports);
            console.log('  New imports:', newImports);
        }
    } catch (error) {
        console.error(`Error processing file ${filePath}:`, error);
    }
}

/**
 * Recursively finds all JavaScript files in a directory and processes them
 * @param dir Directory to search for JavaScript files
 */
function findJsFiles(dir: string): void {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            findJsFiles(filePath);
        } else if (file.endsWith('.js')) {
            fixPrismaImports(filePath);
        }
    }
}

/**
 * Main function to fix Prisma imports in the build directory
 */
function main(): void {
    const buildDir = path.resolve(__dirname, '../../build');

    if (!fs.existsSync(buildDir)) {
        console.error(`Build directory ${buildDir} does not exist. Run the build command first.`);
        process.exit(1);
    }

    console.log('Fixing Prisma imports in build files...');

    // First, specifically check and fix dbUtils.js if it exists
    const dbUtilsPath = path.join(buildDir, 'utils', 'dbUtils.js');
    if (fs.existsSync(dbUtilsPath)) {
        console.log('Specifically checking dbUtils.js...');
        fixPrismaImports(dbUtilsPath);
    }

    // Then process all other files
    findJsFiles(buildDir);
    console.log('Finished fixing Prisma imports.');
}

main(); 