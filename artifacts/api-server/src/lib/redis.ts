/**
 * Shared ioredis client for rate limiting and JWT blacklisting.
 *
 * Handles common copy-paste artifacts in REDIS_URL:
 *  - URL-encoded prefixes  ("%20--tls%20-u%20...")
 *  - Literal shell flags   ("--tls -u redis://...")
 *  - Non-TLS scheme        ("redis://" → "rediss://") for Upstash
 *
 * Uses enableOfflineQueue:true so RedisStore's startup SCRIPT LOAD
 * commands queue safely during the initial TLS handshake.
 *
 * Production behaviour (NODE_ENV=production|staging):
 *   - Missing REDIS_URL       → fatal exit at module load
 *   - Malformed REDIS_URL     → fatal exit at module load
 *   - Unreachable Redis       → fatal exit when waitForRedisReady() is awaited
 *
 * Development behaviour:
 *   - Any of the above → WARN log, null client, server continues normally
 *
 * Exports:
 *   redisClient        — ioredis instance, or null when Redis is unavailable
 *   waitForRedisReady  — async startup check; call before serving requests
 */
import Redis from "ioredis";
import { logger } from "./logger.js";

function sanitizeRedisUrl(raw: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, "").trim();
  const decoded = (() => {
    try {
      return decodeURIComponent(value).trim();
    } catch {
      return value;
    }
  })();
  const normalized = decoded.startsWith("redis://")
    ? `rediss://${decoded.slice("redis://".length)}`
    : decoded;
  try {
    const parsed = new URL(normalized);
    if (!parsed.hostname) return null;
    return normalized;
  } catch {
    return null;
  }
}

export let redisClient: Redis | null = null;

const rawUrl = process.env["REDIS_URL"];
export const isProduction = ["production", "staging"].includes(process.env["NODE_ENV"] ?? "");

/* ── Missing REDIS_URL ───────────────────────────────────────────────────── */
if (!rawUrl) {
  if (isProduction) {
    logger.fatal(
      "[redis] FATAL — REDIS_URL is not set in production. " +
      "JWT token blacklisting and distributed rate limiting require Redis. " +
      "Without Redis, revoked tokens stay valid and brute-force protection is per-instance only. " +
      "Set REDIS_URL in the Replit Secrets panel and restart."
    );
    process.exit(1);
  }
  logger.warn(
    "[redis] REDIS_URL is not set — JWT token blacklisting is DISABLED. " +
    "Logged-out access tokens will remain valid until they expire naturally. " +
    "Set REDIS_URL in the Replit Secrets panel to enable blacklisting."
  );
}

/* ── Malformed or valid REDIS_URL ────────────────────────────────────────── */
if (rawUrl) {
  const url = sanitizeRedisUrl(rawUrl);

  if (!url) {
    /* Malformed URL — fatal in production, warn + null client in dev */
    if (isProduction) {
      logger.fatal(
        { rawUrl: rawUrl.slice(0, 40) + "…" },
        "[redis] FATAL — REDIS_URL is set but could not be parsed as a valid Redis URL in production. " +
        "Check the value in the Replit Secrets panel (must start with redis:// or rediss://)."
      );
      process.exit(1);
    }
    logger.warn(
      "[redis] REDIS_URL is set but is malformed — Redis is DISABLED. " +
      "JWT token blacklisting and distributed rate limiting are unavailable."
    );
  } else {
    try {
      redisClient = new Redis(url, {
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        connectTimeout: 8000,
        retryStrategy: (times) => {
          if (times >= 4) {
            logger.error("[redis] Max reconnect attempts reached — rate limits will use in-memory store");
            logger.warn(
              "[redis] Redis connection failed — JWT token blacklisting is DISABLED. " +
              "Logged-out access tokens will remain valid until they expire naturally."
            );
            return null; // stop retrying; RedisStore will throw and express-rate-limit falls back
          }
          return Math.min(times * 500, 3000);
        },
      });

      redisClient.on("connect", () => logger.info("[redis] Connected to Redis"));
      redisClient.on("ready",   () => logger.info("[redis] Ready"));
      redisClient.on("error",   (err: Error) => logger.error({ err: err.message }, "[redis] Error"));
      redisClient.on("close",   () => logger.warn("[redis] Connection closed"));
    } catch (err) {
      if (isProduction) {
        logger.fatal({ err: (err as Error).message }, "[redis] FATAL — Failed to initialise Redis client in production.");
        process.exit(1);
      }
      logger.error({ err: (err as Error).message }, "[redis] Failed to initialise client");
      logger.warn(
        "[redis] Redis init failed — JWT token blacklisting is DISABLED. " +
        "Logged-out access tokens will remain valid until they expire naturally."
      );
      redisClient = null;
    }
  }
}

/**
 * Verifies that the Redis client is reachable by sending an initial PING.
 * Must be called once during server startup before accepting requests.
 *
 * Production (NODE_ENV=production|staging):
 *   - Exits the process if Redis cannot be reached within PING_TIMEOUT_MS.
 *   - This ensures a production deployment fails fast rather than silently
 *     degrading (JWT blacklisting disabled, rate limits per-instance only).
 *
 * Development:
 *   - Logs a warning if unreachable and sets redisClient to null so the
 *     rest of the application treats Redis as unavailable.
 *   - Server startup continues normally.
 */
export async function waitForRedisReady(): Promise<void> {
  if (!redisClient) {
    /* null = missing/malformed URL already handled at module load */
    return;
  }

  const PING_TIMEOUT_MS = 10_000;

  try {
    /*
     * enableOfflineQueue:true means ping() queues safely if the client
     * is still performing the initial TLS handshake and executes as soon
     * as the connection is ready. The race() provides a hard deadline so
     * a broken host doesn't stall startup indefinitely.
     */
    await Promise.race([
      redisClient.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Redis ping timed out after ${PING_TIMEOUT_MS}ms`)),
          PING_TIMEOUT_MS
        )
      ),
    ]);
    logger.info("[redis] Startup connectivity check passed — Redis is ready");
  } catch (err) {
    const message = (err as Error).message;
    if (isProduction) {
      logger.fatal(
        { err: message },
        "[redis] FATAL — Redis is unreachable at startup in production. " +
        "JWT token blacklisting and distributed rate limiting require a live Redis connection. " +
        "Verify REDIS_URL is correct and the Redis instance is reachable, then restart."
      );
      process.exit(1);
    }
    logger.warn(
      { err: message },
      "[redis] Redis unreachable at startup — running without Redis in development. " +
      "JWT token blacklisting and distributed rate limiting are DISABLED."
    );
    redisClient = null;
  }
}
