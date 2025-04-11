import type { LoggerService } from '@/services/logger.service';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
const MAX_RETRIES = 2; // Number of retries after the initial attempt
const RETRY_DELAY_MS = 500; // Delay between retries in milliseconds

/**
 * Checks if a Prisma error is likely related to a closed/lost connection
 * and is potentially recoverable by retrying.
 * @param error The error object caught.
 * @returns True if the error suggests a retry might help, false otherwise.
 */
function isRetryableDbError(error: unknown): boolean {
    if (error instanceof PrismaClientKnownRequestError) {
        // Official Prisma codes for connection issues
        // P1008: Operations timed out
        // P1017: Server has closed the connection.
        // Add other relevant codes if identified from logs.
        return ['P1008', 'P1017'].includes(error.code);
    }
    // Heuristic check for the specific "kind: Closed" error message structure,
    // as it might not be a standard PrismaClientKnownRequestError.
    if (error instanceof Error && error.message.includes('connection') && error.message.includes('Closed')) {
        return true;
    }
    // Add checks for other potential network or timeout errors if needed
    return false;
}

/**
 * Wraps a database operation with retry logic for connection errors.
 * @param operation An async function that performs the Prisma operation.
 * @param logger A LoggerService instance for logging attempts and errors.
 * @param operationName An optional name for the operation for clearer logging.
 * @returns The result of the operation if successful.
 * @throws The last error encountered if all retries fail or if a non-retryable error occurs.
 */
export async function retryDbOperation<T>(
    operation: () => Promise<T>,
    logger: LoggerService,
    operationName = 'Database operation'
): Promise<T> {
    let attempts = 0;
    while (true) { // Loop until success or throw
        try {
            // Attempt the operation
            return await operation();
        } catch (error) {
            attempts++;
            logger.warn(`Attempt ${attempts} failed for ${operationName}. Error:`, error);

            // Check if the error is retryable and if we haven't exceeded max retries
            if (isRetryableDbError(error) && attempts <= MAX_RETRIES) {
                logger.warn(`Retrying ${operationName} after ${RETRY_DELAY_MS}ms...`);
                // Wait before the next attempt
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                // Continue the loop to retry
            } else {
                // Max retries reached or the error is not considered retryable
                logger.error(`Max retries reached or non-retryable error encountered for ${operationName}.`);
                // Re-throw the error to be handled by the calling code
                throw error;
            }
        }
    }
} 