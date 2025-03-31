import pino, { type Logger } from "pino";
// import { singleton } from "tsyringe"; // Removed tsyringe

// @singleton() // Removed decorator
export class LoggerService {
    private logger: Logger;

    constructor() {
        this.logger = pino({
            level: process.env.NODE_ENV === "development" ? "debug" : "info",
            transport:
                process.env.NODE_ENV === "development"
                    ? {
                        target: "pino-pretty",
                        options: {
                            colorize: true,
                            translateTime: "SYS:HH:MM:ss.l",
                            ignore: "pid,hostname",
                        }
                    }
                    : undefined,
        })
        this.logger.info("Logger initialized");
    }

    debug(message: string, obj?: unknown) {
        if (obj) this.logger.debug(obj, message);
        else this.logger.debug(message);
    }

    info(message: string, obj?: unknown) {
        if (obj) this.logger.info(obj, message);
        else this.logger.info(message);
    }

    warn(message: string, obj?: unknown) {
        if (obj) this.logger.warn(obj, message);
        else this.logger.warn(message);
    }

    error(message: string, error?: Error | unknown, obj?: unknown) {
        const logObj = typeof obj === 'object' && obj !== null
            ? { ...obj, err: error }
            : { err: error };
        this.logger.error(logObj, message);
    }

    fatal(message: string, error?: Error | unknown, obj?: unknown) {
        const logObj = typeof obj === 'object' && obj !== null
            ? { ...obj, err: error }
            : { err: error };
        this.logger.fatal(logObj, message);
    }
}
