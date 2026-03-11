import Redis from "ioredis";
import chalk from "chalk";

const connectionString = process.env.REDIS_URL || "redis://localhost:6379/";

/**
 * Creates a fresh Redis connection.
 * BullMQ requires separate connections for Queue vs Worker vs QueueEvents.
 * NEVER share a single Redis instance across BullMQ primitives — doing so
 * causes BullMQ to put the connection into blocking/subscriber mode,
 * which deadlocks all regular commands (SET, GET, DEL, etc.).
 */
export function createRedisConnection(): Redis {
  return new Redis(connectionString, {
    maxRetriesPerRequest: null, 
    enableReadyCheck: false,
    lazyConnect: false,
  });
}

/**
 * A shared Redis connection for general-purpose commands
 * (locks, bloom filter checks, ad-hoc reads/writes).
 * Do NOT pass this to BullMQ's Worker, Queue, or QueueEvents.
 */
export const redis = createRedisConnection();

redis.on("error", (err) => {
  console.error(chalk.bgRed.white.bold(" Redis connection error: "), chalk.bgRed.white.bold(` ${err.message} `));
});

redis.on("connect", () => {
  console.log(chalk.bgGreen.black(" Redis connected "));
});
