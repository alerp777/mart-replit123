import { db } from "@workspace/db";
import {
  otpAttemptsTable,
  rideBidsTable,
  refreshTokensTable,
  magicLinkTokensTable,
  pendingOtpsTable,
  userSessionsTable,
  liveLocationsTable,
  loginHistoryTable,
} from "@workspace/db/schema";
import { sql, lt, isNotNull, or } from "drizzle-orm";
import { logger } from "./lib/logger.js";
import { purgeExpiredIdempotencyKeys } from "./lib/cleanupIdempotencyKeys.js";
import { stopDispatchEngine } from "./routes/rides/dispatch.js";

/* ══════════════════════════════════════════════════════════════════════════
   scheduler.ts
   Central registry for all recurring background cleanup jobs.
   Call startScheduler() once at server startup (from index.ts).
   Call stopScheduler() in SIGTERM / SIGINT handlers to cleanly drain timers.

   Jobs managed here:
     1. Idempotency key expiry      — purge rows older than TTL (every 5 min)
     2. OTP attempt cleanup         — delete expired otp_attempts rows (every 5 min)
     3. Ride bid map cleanup        — delete stale ride_bids for non-pending rides (every 30 min)
     4. Refresh token cleanup       — delete expired refresh_tokens rows (every 60 min)
     5. Magic link token cleanup    — delete expired magic_link_tokens rows (every 30 min)
     6. Pending OTP cleanup         — delete expired pending_otps rows (every 15 min)
     7. User session cleanup        — delete expired/revoked user_sessions rows (every 60 min)
     8. Stale location cleanup      — delete live_locations older than 4 hours (every 30 min)
     9. Login history archival      — delete login_history older than 90 days (every 24 hours)
══════════════════════════════════════════════════════════════════════════ */

const _timers: ReturnType<typeof setInterval>[] = [];

function register(
  label: string,
  fn: () => Promise<void>,
  intervalMs: number,
): ReturnType<typeof setInterval> {
  fn().catch((e: unknown) => {
    logger.warn({ err: (e as Error).message, job: label }, "[scheduler] immediate first-run failed");
  });
  const handle = setInterval(async () => {
    try {
      await fn();
    } catch (e: unknown) {
      logger.warn({ err: (e as Error).message, job: label }, "[scheduler] cleanup job failed");
    }
  }, intervalMs);
  _timers.push(handle);
  return handle;
}

/* ── Job implementations ─────────────────────────────────────────────────── */

async function purgeExpiredOtpAttempts(): Promise<void> {
  const deleted = await db
    .delete(otpAttemptsTable)
    .where(sql`expires_at < now()`)
    .returning({ key: otpAttemptsTable.key });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "[scheduler] purged expired OTP attempt rows");
  } else {
    logger.debug("[scheduler] otp-attempt cleanup ran, 0 rows removed");
  }
}

async function purgeStaleRideBids(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(rideBidsTable)
    .where(lt(rideBidsTable.createdAt, cutoff))
    .returning({ id: rideBidsTable.id });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "[scheduler] purged stale ride bid rows");
  } else {
    logger.debug("[scheduler] ride-bid cleanup ran, 0 rows removed");
  }
}

async function purgeExpiredRefreshTokens(): Promise<void> {
  const deleted = await db
    .delete(refreshTokensTable)
    .where(sql`expires_at < now()`)
    .returning({ id: refreshTokensTable.id });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "[scheduler] purged expired refresh token rows");
  } else {
    logger.debug("[scheduler] refresh-token cleanup ran, 0 rows removed");
  }
}

async function purgeExpiredMagicLinkTokens(): Promise<void> {
  const deleted = await db
    .delete(magicLinkTokensTable)
    .where(sql`expires_at < now()`)
    .returning({ id: magicLinkTokensTable.id });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "[scheduler] purged expired magic link token rows");
  } else {
    logger.debug("[scheduler] magic-link-token cleanup ran, 0 rows removed");
  }
}

async function purgeExpiredPendingOtps(): Promise<void> {
  const deleted = await db
    .delete(pendingOtpsTable)
    .where(sql`otp_expiry < now()`)
    .returning({ id: pendingOtpsTable.id });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "[scheduler] purged expired pending OTP rows");
  } else {
    logger.debug("[scheduler] pending-otp cleanup ran, 0 rows removed");
  }
}

async function purgeExpiredUserSessions(): Promise<void> {
  const inactiveCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(userSessionsTable)
    .where(
      or(
        isNotNull(userSessionsTable.revokedAt),
        lt(userSessionsTable.lastActiveAt, inactiveCutoff),
      ),
    )
    .returning({ id: userSessionsTable.id });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "[scheduler] purged expired user session rows");
  } else {
    logger.debug("[scheduler] user-session cleanup ran, 0 rows removed");
  }
}

async function purgeStaleLocations(): Promise<void> {
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const deleted = await db
    .delete(liveLocationsTable)
    .where(
      sql`role = 'rider' AND updated_at < ${cutoff}`,
    )
    .returning({ userId: liveLocationsTable.userId });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "[scheduler] purged stale live location rows for inactive riders");
  } else {
    logger.debug("[scheduler] live-location cleanup ran, 0 rows removed");
  }
}

async function archiveOldLoginHistory(): Promise<void> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(loginHistoryTable)
    .where(lt(loginHistoryTable.createdAt, cutoff))
    .returning({ id: loginHistoryTable.id });
  if (deleted.length > 0) {
    logger.info({ count: deleted.length }, "[scheduler] archived old login history rows");
  } else {
    logger.debug("[scheduler] login-history archival ran, 0 rows removed");
  }
}

/* ── Public API ──────────────────────────────────────────────────────────── */

const ALL_JOBS = [
  "idempotency-key-expiry",
  "otp-attempt-cleanup",
  "ride-bid-map-cleanup",
  "refresh-token-cleanup",
  "magic-link-token-cleanup",
  "pending-otp-cleanup",
  "user-session-cleanup",
  "live-location-cleanup",
  "login-history-archival",
];

export function startScheduler(): void {
  register("idempotency-key-expiry",    purgeExpiredIdempotencyKeys,  5 * 60_000);
  register("otp-attempt-cleanup",       purgeExpiredOtpAttempts,      5 * 60_000);
  register("ride-bid-map-cleanup",      purgeStaleRideBids,           30 * 60_000);
  register("refresh-token-cleanup",     purgeExpiredRefreshTokens,    60 * 60_000);
  register("magic-link-token-cleanup",  purgeExpiredMagicLinkTokens,  30 * 60_000);
  register("pending-otp-cleanup",       purgeExpiredPendingOtps,      15 * 60_000);
  register("user-session-cleanup",      purgeExpiredUserSessions,     60 * 60_000);
  register("live-location-cleanup",     purgeStaleLocations,          30 * 60_000);
  register("login-history-archival",    archiveOldLoginHistory,       24 * 60 * 60_000);
  logger.info({ jobs: ALL_JOBS }, "[scheduler] started");
}

export function stopScheduler(): void {
  for (const handle of _timers) {
    clearInterval(handle);
  }
  _timers.length = 0;
  stopDispatchEngine();
  logger.info("[scheduler] all timers cleared");
}
