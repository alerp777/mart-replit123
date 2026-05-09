/**
 * Shared ioredis client for rate limiting.
 *
 * Handles common copy-paste artifacts in REDIS_URL:
 *  - URL-encoded prefixes  ("%20--tls%20-u%20...")
 *  - Literal shell flags   ("--tls -u redis://...")
 *  - Non-TLS scheme        ("redis://" → "rediss://") for Upstash
 *
 * Uses enableOfflineQueue:true so RedisStore's startup SCRIPT LOAD
 * commands queue safely during the initial TLS handshake.
 *
 * Exports:
 *   redisClient  — ioredis instance, or null when REDIS_URL is absent/invalid
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

let redisClient: Redis | null = null;

const rawUrl = process.env["REDIS_URL"];

if (!rawUrl) {
  logger.warn(
    "[redis] REDIS_URL is not set — JWT token blacklisting is DISABLED. " +
    "Logged-out access tokens will remain valid until they expire naturally. " +
    "Set REDIS_URL in the Replit Secrets panel to enable blacklisting."
  );
}

if (rawUrl) {
  const url = sanitizeRedisUrl(rawUrl);
  if (url) {
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
      logger.error({ err: (err as Error).message }, "[redis] Failed to initialise client");
      logger.warn(
        "[redis] Redis init failed — JWT token blacklisting is DISABLED. " +
        "Logged-out access tokens will remain valid until they expire naturally."
      );
      redisClient = null;
    }
  }
}

export { redisClient };
