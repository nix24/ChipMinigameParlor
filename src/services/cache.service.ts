import { type Cache, createCache } from "cache-manager";
import { KeyvCacheableMemory } from "cacheable";
import { Keyv } from "keyv";
import type { LoggerService } from "./logger.service";

// Configuration constants (could be moved to a config file)
const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds
const LRU_SIZE = 500; // Max items in LRU cache

export class CacheService {
    public readonly cache: Cache;
    private readonly logger: LoggerService;

    constructor(logger: LoggerService) {
        this.logger = logger;
        this.logger.info("Initializing Cache Service...");

        try {
            // Configure the in-memory store using cacheable
            const memoryStore = new KeyvCacheableMemory({
                ttl: DEFAULT_TTL_MS, // Default TTL for items in this store
                lruSize: LRU_SIZE,
            });

            // Create the Keyv instance with the configured store
            const keyvInstance = new Keyv({ store: memoryStore });

            // Create the cache-manager instance using the Keyv instance
            this.cache = createCache({
                stores: [keyvInstance],
                // Global default TTL (can be overridden per `set` or `wrap` call)
                ttl: DEFAULT_TTL_MS,
            });

            this.setupEventListeners();
            this.logger.info(
                `Cache Service initialized with CacheableMemory (LRU: ${LRU_SIZE}, Default TTL: ${DEFAULT_TTL_MS}ms)`,
            );
        } catch (error) {
            this.logger.error("Failed to initialize Cache Service:", error);
            // Depending on requirements, you might want to throw the error
            // or provide a fallback (e.g., a no-op cache)
            throw new Error("Cache Service initialization failed.");
        }
    }

    private setupEventListeners(): void {
        this.cache.on("set", ({ key }) => {
            this.logger.debug(`Cache SET: ${key}`);
        });

        this.cache.on("del", ({ key }) => {
            this.logger.debug(`Cache DEL: ${key}`);
        });

        this.cache.on("clear", () => {
            this.logger.info("Cache CLEARED");
        });

        // Log errors from underlying store operations if possible/needed
        // Note: Keyv might handle some internal errors, check its docs
    }

    // Convenience wrapper for `wrap` to simplify usage
    async wrap<T>(
        key: string,
        fn: () => Promise<T>,
        ttl?: number,
    ): Promise<T> {
        try {
            // cache-manager's wrap needs a callback, not async directly
            const wrappedFn = async () => await fn();
            const result = await this.cache.wrap(key, wrappedFn, ttl);
            this.logger.debug(`Cache HIT/SET for key: ${key}`);
            return result;
        } catch (error) {
            this.logger.error(`Cache WRAP error for key ${key}:`, error);
            // Fallback: Execute the function directly without caching on error
            this.logger.warn(`Cache fallback: Executing function directly for key ${key}`);
            return await fn();
        }
    }

    // Add other convenience methods if needed (get, set, del)
    async get<T>(key: string): Promise<T | null> {
        const result = await this.cache.get<T>(key);
        return result;
    }

    async set<T>(key: string, value: T, ttl?: number): Promise<T> {
        await this.cache.set(key, value, ttl);
        return value;
    }

    async del(key: string): Promise<boolean> {
        try {
            await this.cache.del(key);
            return true;
        } catch (error) {
            this.logger.error(`Cache DEL error for key ${key}:`, error);
            return false;
        }
    }

    async disconnect(): Promise<void> {
        try {
            await this.cache.disconnect();
            this.logger.info("Cache disconnected.");
        } catch (error) {
            this.logger.error("Error disconnecting cache:", error);
        }
    }
} 