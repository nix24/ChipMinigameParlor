// import { singleton } from "tsyringe"; // Removed tsyringe
import { PrismaClient } from '@prisma/client'

// @singleton() // Removed decorator
export class PrismaService extends PrismaClient {
    constructor() {
        super({
            log:
                process.env.NODE_ENV === "development"
                    ? ["query", "info", "warn", "error"]
                    : ["error"],
        })
        // add connection logic or health check
        this.$connect()
            .then(() => console.log("Database connected successfully"))
            .catch((e: Error) => console.error("Database connection failed:", e));
    }

    //custom methods
    async disconnect() {
        await this.$disconnect();
    }
}