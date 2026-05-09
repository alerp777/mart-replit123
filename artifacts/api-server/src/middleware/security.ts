import { logger } from "../lib/logger.js";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { db } from "@workspace/db";
import { usersTable, refreshTokensTable, authAuditLogTable, rateLimitsTable, adminActionAuditLogTable } from "@workspace/db/schema";
import { eq, and, lt, gt, like, sql, isNull } from "drizzle-orm";
import { getPlatformSettings } from "../routes/admin.js";
import { generateId } from "../lib/id.js";

/* ══════════════════════════════════════════════════════════════
   JWT CONFIGURATION — fail-fast if secret is absent or too short
══════════════════════════════════════════════════════════════ */
const _jwtSecret = process.env["JWT_SECRET"];
if (!_jwtSecret || _jwtSecret.length < 32) {
  const msg = !_jwtSecret
    ? "[AUTH] FATAL: JWT_SECRET environment variable is not set. Minimum 32 characters required."
    : `[AUTH] FATAL: JWT_SECRET too short (${_jwtSecret.length} chars, need ≥32).`;
  logger.error(msg);
  process.exit(1);
}
export const JWT_SECRET: string = _jwtSecret;

/* Access token TTL defaults — overridden at runtime by platform settings jwt_access_ttl_sec / jwt_refresh_ttl_days */
export const ACCESS_TOKEN_TTL_SEC = 900;      /* 15 minutes */
export const REFRESH_TOKEN_TTL_DAYS = 7;       /* 7 days */

function safeInt(val: string | undefined, fallback: number, min = 1): number {
  const n = parseInt(val ?? String(fallback), 10);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

export function getRefreshTokenTtlDays(): number {
  return safeInt(settingsCache["jwt_refresh_ttl_days"], REFRESH_TOKEN_TTL_DAYS, 1);
}

export function getAccessTokenTtlSec(): number {
  return safeInt(settingsCache["jwt_access_ttl_sec"], ACCESS_TOKEN_TTL_SEC, 60);
}

/* ══════════════════════════════════════════════════════════════
   ADMIN JWT CONFIGURATION — separate from user JWT
══════════════════════════════════════════════════════════════ */
const _adminJwtSecret = process.env["ADMIN_JWT_SECRET"];
if (!_adminJwtSecret || _adminJwtSecret.length < 32) {
  const msg = !_adminJwtSecret
    ? "[AUTH] FATAL: ADMIN_JWT_SECRET environment variable is not set. Minimum 32 characters required."
    : `[AUTH] FATAL: ADMIN_JWT_SECRET too short (${_adminJwtSecret.length} chars, need ≥32).`;
  logger.error(msg);
  process.exit(1);
}
export const ADMIN_JWT_SECRET: string = _adminJwtSecret;
export const ADMIN_TOKEN_TTL_HRS = 24;

/* ══════════════════════════════════════════════════════════════
   TOR EXIT NODE DETECTION
   Startup uses a bundled static fallback list so the server never
   blocks on an external network call at boot time. The live list
   from torproject.org is fetched as a non-blocking background task
   and then refreshed on the normal TTL interval afterwards.
══════════════════════════════════════════════════════════════ */

/**
 * Minimal static fallback — a curated sample of historically
 * persistent Tor exit relays that remain stable across refreshes.
 * This list is intentionally small; it only guards the window
 * between process start and the first successful live refresh.
 * Do NOT rely on this for exhaustive coverage.
 */
const TOR_STATIC_FALLBACK: readonly string[] = [
  "109.70.100.2",
  "109.70.100.18",
  "109.70.100.34",
  "109.70.100.50",
  "185.220.101.1",
  "185.220.101.2",
  "185.220.101.3",
  "185.220.101.4",
  "185.220.101.5",
  "185.220.101.33",
  "185.220.101.34",
  "185.220.101.35",
  "185.220.101.44",
  "185.220.101.45",
  "185.220.101.46",
  "185.220.101.47",
  "185.220.102.8",
  "185.220.103.5",
  "185.220.103.7",
  "199.249.230.65",
  "199.249.230.66",
  "199.249.230.68",
  "199.249.230.76",
];

let torExitNodes: Set<string> = new Set(TOR_STATIC_FALLBACK);
let torListFetchedAt = 0; /* 0 = only the static fallback is loaded */
let TOR_LIST_TTL_MS = 60 * 60 * 1000;

async function refreshTorExitNodes(): Promise<void> {
  try {
    const resp = await fetch("https://check.torproject.org/torbulkexitlist", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const msg = `TOR list HTTP error ${resp.status}`;
      logger.warn(`[TOR] Failed to refresh exit node list: ${msg}`);
      addSecurityEvent({ type: "tor_list_refresh_failed", ip: "server", details: msg, severity: "low" });
      return;
    }
    const text = await resp.text();
    const ips = text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    torExitNodes = new Set(ips);
    torListFetchedAt = Date.now();
    logger.info(`[TOR] Refreshed exit node list: ${torExitNodes.size} nodes`);
  } catch (err: any) {
    const msg = err?.message ?? "unknown error";
    logger.warn(`[TOR] Failed to fetch exit node list: ${msg}`);
    addSecurityEvent({ type: "tor_list_refresh_failed", ip: "server", details: `TOR list fetch error: ${msg}`, severity: "low" });
  }
}

/* Non-blocking background refresh — runs after startup, never delays boot */
setImmediate(() => {
  refreshTorExitNodes().catch(() => {});
  setInterval(() => { refreshTorExitNodes().catch(() => {}); }, TOR_LIST_TTL_MS);
});

async function isTorExitNode(ip: string): Promise<boolean> {
  /* If the live list has never been fetched (torListFetchedAt === 0) the static
     fallback set is already active — no need to await a live refresh here. */
  if (torListFetchedAt > 0 && Date.now() - torListFetchedAt > TOR_LIST_TTL_MS) {
    /* List is stale — trigger a background refresh; use the existing set for now */
    refreshTorExitNodes().catch(() => {});
  }
  return torExitNodes.has(ip);
}

/* ══════════════════════════════════════════════════════════════
   VPN / PROXY DETECTION
══════════════════════════════════════════════════════════════ */
const vpnCache: Map<string, { isVpn: boolean; cachedAt: number }> = new Map();
let VPN_CACHE_TTL_MS = 10 * 60 * 1000;

async function isVpnOrProxy(ip: string): Promise<boolean> {
  const cached = vpnCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < VPN_CACHE_TTL_MS) {
    return cached.isVpn;
  }

  if (ip === "unknown" || ip.startsWith("127.") || ip.startsWith("::1") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("172.")) {
    return false;
  }

  try {
    const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,proxy,hosting`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      logger.warn(`[VPN] Check failed for IP ${ip}: HTTP ${resp.status} — flagging as check_failed`);
      addSecurityEvent({ type: "vpn_check_failed", ip, details: `VPN check HTTP error ${resp.status}`, severity: "low" });
      return false;
    }
    interface IpApiResponse { status?: string; proxy?: boolean; hosting?: boolean; }
    const data = await resp.json() as IpApiResponse;
    const isVpn = data.status === "success" && (data.proxy === true || data.hosting === true);
    vpnCache.set(ip, { isVpn, cachedAt: Date.now() });
    return isVpn;
  } catch (err: any) {
    logger.warn(`[VPN] Check failed for IP ${ip}: ${err?.message ?? "unknown error"} — flagging as check_failed`);
    addSecurityEvent({ type: "vpn_check_failed", ip, details: `VPN check error: ${err?.message ?? "unknown"}`, severity: "low" });
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   BLOCKED-IP CACHE  (backed by rate_limits DB table)
══════════════════════════════════════════════════════════════ */
const blockedIPsCache = new Set<string>();

async function loadBlockedIPs() {
  try {
    const rows = await db.select({ key: rateLimitsTable.key })
      .from(rateLimitsTable)
      .where(like(rateLimitsTable.key, "blocked_ip:%"));
    for (const row of rows) blockedIPsCache.add(row.key.replace("blocked_ip:", ""));
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "[security] loadBlockedIPs DB query failed");
  }
}
loadBlockedIPs().catch((e: Error) => logger.warn({ err: e.message }, "[security] loadBlockedIPs failed"));

export async function blockIP(ip: string) {
  blockedIPsCache.add(ip);
  try {
    await db.insert(rateLimitsTable).values({
      key: `blocked_ip:${ip}`,
      attempts: 0,
      windowStart: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
  } catch (e) {
    logger.error({ ip, err: (e as Error).message }, "[security] blockIP DB insert failed");
  }
}

export async function unblockIP(ip: string) {
  blockedIPsCache.delete(ip);
  try {
    await db.delete(rateLimitsTable).where(eq(rateLimitsTable.key, `blocked_ip:${ip}`));
  } catch (err) {
    logger.warn({ ip, err: err instanceof Error ? err.message : String(err) }, "[security] unblockIP DB delete failed");
  }
}

export async function isIPBlocked(ip: string): Promise<boolean> {
  if (blockedIPsCache.has(ip)) return true;
  try {
    const [row] = await db.select({ key: rateLimitsTable.key }).from(rateLimitsTable)
      .where(eq(rateLimitsTable.key, `blocked_ip:${ip}`)).limit(1);
    if (row) {
      blockedIPsCache.add(ip);
      return true;
    }
  } catch (err) {
    logger.warn({ ip, err: err instanceof Error ? err.message : String(err) }, "[security] isIPBlocked DB query failed");
  }
  return false;
}

export async function getBlockedIPList(): Promise<string[]> {
  try {
    const rows = await db.select({ key: rateLimitsTable.key })
      .from(rateLimitsTable)
      .where(like(rateLimitsTable.key, "blocked_ip:%"));
    const ips = rows.map(r => r.key.replace("blocked_ip:", ""));
    for (const ip of ips) blockedIPsCache.add(ip);
    return ips;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[security] getBlockedIPList DB query failed, returning cache");
    return Array.from(blockedIPsCache);
  }
}

export async function getActiveLockouts(): Promise<Array<{ key: string; attempts: number; lockedUntil: string | null; minutesLeft: number | null }>> {
  try {
    const now = new Date();
    const rows = await db.select().from(rateLimitsTable)
      .where(and(
        gt(rateLimitsTable.attempts, 0),
      ));
    return rows
      .filter(r => !r.key.startsWith("blocked_ip:") && !r.key.startsWith("check-avail:") && !r.key.startsWith("ip_rate:"))
      .map(r => {
        const lockedUntilMs = r.lockedUntil?.getTime() ?? null;
        const minutesLeft = lockedUntilMs && lockedUntilMs > now.getTime()
          ? Math.ceil((lockedUntilMs - now.getTime()) / 60000)
          : null;
        return {
          key: r.key,
          attempts: r.attempts,
          lockedUntil: r.lockedUntil ? r.lockedUntil.toISOString() : null,
          minutesLeft,
        };
      });
  } catch {
    return [];
  }
}

export interface AuditEntry {
  timestamp: string;
  action: string;
  adminId?: string;
  adminName?: string;
  ip: string;
  details: string;
  result: "success" | "fail" | "warn" | "pending";
  affectedUserId?: string;
  affectedUserName?: string;
  affectedUserRole?: string;
}
export const auditLog: AuditEntry[] = [];

export interface SecurityEvent {
  timestamp: string;
  type: string;
  ip: string;
  userId?: string;
  details: string;
  severity: "low" | "medium" | "high" | "critical";
}
export const securityEvents: SecurityEvent[] = [];

/* ══════════════════════════════════════════════════════════════
   IP HELPERS
══════════════════════════════════════════════════════════════ */
export function getClientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

/* ══════════════════════════════════════════════════════════════
   AUDIT LOG (in-memory ring buffer + async DB persistence)
══════════════════════════════════════════════════════════════ */
export function addAuditEntry(entry: Omit<AuditEntry, "timestamp">) {
  if (settingsCache["security_audit_log"] === "off") return;
  const timestamp = new Date().toISOString();
  auditLog.unshift({ ...entry, timestamp });
  if (auditLog.length > 2000) auditLog.splice(2000);

  // Persist to DB asynchronously — never blocks the request
  db.insert(adminActionAuditLogTable).values({
    id:               generateId(),
    adminId:          entry.adminId ?? null,
    adminName:        entry.adminName ?? null,
    ip:               entry.ip,
    action:           entry.action,
    result:           entry.result,
    details:          entry.details ?? null,
    affectedUserId:   entry.affectedUserId ?? null,
    affectedUserName: entry.affectedUserName ?? null,
    affectedUserRole: entry.affectedUserRole ?? null,
  }).catch((err: unknown) => {
    logger.warn({ err, action: entry.action }, "[audit] DB persist failed (in-memory copy retained)");
  });
}

export function addSecurityEvent(event: Omit<SecurityEvent, "timestamp">) {
  securityEvents.unshift({ ...event, timestamp: new Date().toISOString() });
  if (securityEvents.length > 2000) securityEvents.splice(2000);
}

/* ══════════════════════════════════════════════════════════════
   PERSISTENT AUTH AUDIT LOG
   Writes to the auth_audit_log DB table for cross-session durability.
══════════════════════════════════════════════════════════════ */
export async function writeAuthAuditLog(
  event: string,
  opts: {
    userId?: string;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<void> {
  try {
    await db.insert(authAuditLogTable).values({
      id:        generateId(),
      userId:    opts.userId ?? null,
      event,
      ip:        opts.ip ?? "unknown",
      userAgent: opts.userAgent ?? null,
      metadata:  opts.metadata ? JSON.stringify(opts.metadata) : null,
    });
  } catch {
    /* Non-fatal — never let audit log writes crash the main flow */
  }
}

/* ══════════════════════════════════════════════════════════════
   JWT HELPERS — HS256 pinned, iat validation, algorithm confusion prevention
══════════════════════════════════════════════════════════════ */
export interface JwtUserPayload {
  userId: string;
  phone: string;
  role: string;
  roles: string;
  tokenVersion?: number;
  jti?: string;
  exp?: number;
  iat?: number;
}

export function signUserJwt(
  userId: string,
  phone: string,
  role: string,
  roles: string,
  sessionDays: number,
): string {
  return jwt.sign(
    { sub: userId, phone, role, roles },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: `${sessionDays}d` },
  );
}

/** Sign a short-lived access token, embedding tokenVersion + jti for revocation checks.
 *  TTL is read from cached platform settings (jwt_access_ttl_sec), falling back to ACCESS_TOKEN_TTL_SEC.
 *  jti (JWT ID) is a random UUID used for Redis-backed blacklisting on logout. */
export function signAccessToken(userId: string, phone: string, role: string, roles: string, tokenVersion = 0): string {
  const jti = crypto.randomUUID();
  return jwt.sign(
    { sub: userId, phone, role, roles, tokenVersion, type: "access", jti },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: getAccessTokenTtlSec() },
  );
}

/**
 * Blacklist a JWT by its jti in Redis.
 * TTL is set to the remaining lifetime of the token so Redis auto-expires the entry.
 */
export async function blacklistJti(jti: string, expiresAt: number): Promise<void> {
  try {
    const { redisClient } = await import("../lib/redis.js");
    if (!redisClient) return;
    const ttlSec = Math.max(1, Math.ceil((expiresAt * 1000 - Date.now()) / 1000));
    await redisClient.set(`jwt:bl:${jti}`, "1", "EX", ttlSec);
  } catch (err) {
    logger.warn({ jti, err: err instanceof Error ? err.message : String(err) }, "[auth] blacklistJti Redis error");
  }
}

/**
 * Check if a JWT jti is blacklisted.
 * Returns false (allow) when Redis is unavailable so a Redis outage never blocks auth.
 */
export async function isJtiBlacklisted(jti: string): Promise<boolean> {
  try {
    const { redisClient } = await import("../lib/redis.js");
    if (!redisClient) return false;
    const result = await redisClient.exists(`jwt:bl:${jti}`);
    return result === 1;
  } catch {
    return false;
  }
}

export function sign2faChallengeToken(userId: string, phone: string, role: string, roles: string, authMethod?: string): string {
  return jwt.sign(
    { sub: userId, phone, role, roles, type: "2fa_challenge", authMethod: authMethod ?? undefined },
    JWT_SECRET,
    { algorithm: "HS256", expiresIn: safeInt(settingsCache["jwt_2fa_challenge_sec"], 300, 30) },
  );
}

export interface TwoFaChallengePayload {
  userId: string;
  phone: string;
  role: string;
  roles: string;
  authMethod?: string;
}

export function verify2faChallengeToken(token: string): TwoFaChallengePayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if ((payload as Record<string, unknown>)["type"] !== "2fa_challenge") return null;
    if (!payload.sub) return null;
    return {
      userId: payload["sub"] as string,
      phone: payload["phone"] as string ?? "",
      role: payload["role"] as string ?? "customer",
      roles: payload["roles"] as string ?? "customer",
      authMethod: (payload["authMethod"] as string) || undefined,
    };
  } catch {
    return null;
  }
}

/** Sign a refresh token (opaque random value). Returns the raw token and its hash. */
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(40).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export function hashRefreshToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function verifyUserJwt(token: string): JwtUserPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (!payload.sub) return null;

    if ((payload as Record<string, unknown>)["type"] === "2fa_challenge") return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.iat === "number" && payload.iat > nowSec + 60) {
      return null;
    }

    return {
      userId:       payload["sub"] as string,
      phone:        payload["phone"] as string ?? "",
      role:         payload["role"]  as string ?? "customer",
      roles:        payload["roles"] as string ?? "customer",
      tokenVersion: typeof payload["tokenVersion"] === "number" ? payload["tokenVersion"] : undefined,
      jti:          typeof payload["jti"] === "string" ? payload["jti"] : undefined,
      exp:          typeof payload.exp === "number" ? payload.exp : undefined,
      iat:          typeof payload.iat === "number" ? payload.iat : undefined,
    };
  } catch {
    return null;
  }
}

/* ── Legacy decode: kept for internal callers ── */
export function decodeUserToken(token: string): { userId: string; phone: string; issuedAt: number } | null {
  const v = verifyUserJwt(token);
  if (!v) return null;
  const raw = jwt.decode(token) as { iat?: number } | null;
  return { userId: v.userId, phone: v.phone, issuedAt: (raw?.iat ?? 0) * 1000 };
}

/**
 * TTL-based session expiry check for legacy session-day tokens.
 * For access JWTs, revocation is handled via `tokenVersion` in `riderAuth`:
 * whenever a user changes password or logs out, `tokenVersion` is incremented
 * in the DB, and any JWT carrying a stale version is immediately rejected.
 * This function covers the additional wall-clock TTL guard for older-style
 * session tokens that may not carry a `tokenVersion` claim.
 */
export function isTokenExpired(issuedAt: number, sessionDays: number): boolean {
  const issuedAtMs = issuedAt < 1e12 ? issuedAt * 1000 : issuedAt;
  const expiryMs = issuedAtMs + sessionDays * 24 * 60 * 60 * 1000;
  return Date.now() > expiryMs;
}

/* ══════════════════════════════════════════════════════════════
   ADMIN JWT HELPERS — time-limited signed tokens (4-hour TTL)
══════════════════════════════════════════════════════════════ */
export interface AdminJwtPayload {
  adminId: string | null;
  role: string;
  name: string;
  iat?: number;
  exp?: number;
}

export function signAdminJwt(adminId: string | null, role: string, name: string, ttlHrs = ADMIN_TOKEN_TTL_HRS): string {
  return jwt.sign(
    { adminId, role, name, type: "admin" },
    ADMIN_JWT_SECRET,
    { algorithm: "HS256", expiresIn: `${ttlHrs}h` },
  );
}

export function verifyAdminJwt(token: string): AdminJwtPayload | null {
  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if ((payload as Record<string, unknown>)["type"] !== "admin") return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.iat === "number" && payload.iat > nowSec + 60) return null;
    return {
      adminId: payload["adminId"] as string | null,
      role:    payload["role"]    as string ?? "manager",
      name:    payload["name"]    as string ?? "Admin",
      iat:     payload.iat,
      exp:     payload.exp,
    };
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   LOGIN LOCKOUT HELPERS  (DB-backed — survives restarts)
══════════════════════════════════════════════════════════════ */
/**
 * Returns `true` when the admin master toggle `security_lockout_enabled` is `on`
 * (default). When the admin disables the toggle, every lockout helper short-circuits
 * to a no-op so that wrong credentials no longer accumulate or trigger 429 responses.
 * Reads the cached settings (30s TTL) so it costs nothing per call.
 */
async function isLockoutEnabled(): Promise<boolean> {
  try {
    const settings = await getCachedSettings();
    return (settings["security_lockout_enabled"] ?? "on") === "on";
  } catch {
    /* Fail-open on settings read errors — preserves current security posture. */
    return true;
  }
}

export async function checkLockout(
  key: string,
  maxAttempts: number,
  lockoutMinutes: number
): Promise<{ locked: boolean; minutesLeft?: number; attempts?: number }> {
  if (!(await isLockoutEnabled())) return { locked: false, attempts: 0 };
  try {
    const [record] = await db.select().from(rateLimitsTable).where(eq(rateLimitsTable.key, key)).limit(1);
    if (!record) return { locked: false, attempts: 0 };

    if (record.lockedUntil) {
      const now = Date.now();
      const lockedUntilMs = record.lockedUntil.getTime();
      if (now < lockedUntilMs) {
        const minutesLeft = Math.ceil((lockedUntilMs - now) / 60000);
        return { locked: true, minutesLeft, attempts: record.attempts };
      }
      await db.delete(rateLimitsTable).where(eq(rateLimitsTable.key, key));
      return { locked: false, attempts: 0 };
    }

    return { locked: false, attempts: record.attempts };
  } catch {
    return { locked: false, attempts: 0 };
  }
}

export async function recordFailedAttempt(key: string, maxAttempts: number, lockoutMinutes: number) {
  if (!(await isLockoutEnabled())) return { attempts: 0, lockedUntil: null };
  try {
    const now = new Date();
    const lockedUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000);

    const [existing] = await db.select().from(rateLimitsTable).where(eq(rateLimitsTable.key, key)).limit(1);
    if (!existing) {
      const newAttempts = 1;
      await db.insert(rateLimitsTable).values({
        key,
        attempts: newAttempts,
        lockedUntil: newAttempts >= maxAttempts ? lockedUntil : null,
        windowStart: now,
        updatedAt: now,
      });
      return { attempts: newAttempts, lockedUntil: newAttempts >= maxAttempts ? lockedUntil.getTime() : null };
    }

    const newAttempts = existing.attempts + 1;
    await db.update(rateLimitsTable).set({
      attempts: newAttempts,
      lockedUntil: newAttempts >= maxAttempts ? lockedUntil : null,
      updatedAt: now,
    }).where(eq(rateLimitsTable.key, key));

    /* (a) Lockout threshold reached: emit a security event so the lockout
       appears in the security event history visible on the Security Dashboard. */
    if (newAttempts >= maxAttempts) {
      addSecurityEvent({
        type: "account_locked",
        ip: "server",
        userId: key,
        details: `Account locked after ${newAttempts} failed attempts. Locked until ${lockedUntil.toISOString()}. Key: ${key}`,
        severity: "high",
      });

      /* (b) Fire-and-forget email alert to the locked account's owner.
         We attempt a best-effort lookup by phone or email (the key may be
         either). The email send is non-blocking — a failure here never
         blocks the main auth flow. */
      (async () => {
        try {
          const { sendEmail } = await import("../services/email.js");
          const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key);
          let email: string | null = looksLikeEmail ? key : null;
          if (!email) {
            const rows = await db.select({ email: usersTable.email })
              .from(usersTable)
              .where(eq(usersTable.phone, key))
              .limit(1);
            email = rows[0]?.email ?? null;
          }
          if (email) {
            await sendEmail({
              to: email,
              subject: "Security Alert: Your account has been temporarily locked",
              html: `<p>Your account has been temporarily locked due to ${newAttempts} consecutive failed login attempts.</p><p>The lockout will expire in <strong>${lockoutMinutes} minutes</strong>.</p><p>If you did not attempt to log in, please contact support immediately.</p><p>Locked at: ${now.toISOString()}</p>`,
            });
          }
        } catch { /* non-fatal — email failure must never affect auth flow */ }
      })();
    }

    return { attempts: newAttempts, lockedUntil: newAttempts >= maxAttempts ? lockedUntil.getTime() : null };
  } catch {
    return { attempts: 0, lockedUntil: null };
  }
}

export async function resetAttempts(key: string) {
  try {
    await db.delete(rateLimitsTable).where(eq(rateLimitsTable.key, key));
  } catch (err) {
    logger.warn({ key, err: err instanceof Error ? err.message : String(err) }, "[security] resetAttempts DB delete failed");
  }
}

export async function unlockPhone(phone: string) {
  await resetAttempts(phone);
}

export async function cleanupExpiredRateLimits() {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    await db.delete(rateLimitsTable).where(
      and(
        lt(rateLimitsTable.updatedAt, cutoff),
        sql`${rateLimitsTable.key} NOT LIKE 'blocked_ip:%'`
      )
    );
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "[security] cleanupExpiredRateLimits DB delete failed");
  }
}
setInterval(() => { cleanupExpiredRateLimits().catch((e: Error) => logger.warn({ err: e.message }, "[security] cleanupExpiredRateLimits failed")); }, 15 * 60 * 1000);

/* ══════════════════════════════════════════════════════════════
   CHECK-AVAILABLE RATE LIMITER  (DB-authoritative)
══════════════════════════════════════════════════════════════ */
export async function checkAvailableRateLimit(ip: string, maxRequests: number, windowMinutes: number): Promise<{ limited: boolean; minutesLeft?: number }> {
  const result = await dbRateIncrement(`check-avail:${ip}`, windowMinutes);
  if (result.count > maxRequests) {
    const minutesLeft = Math.ceil((result.windowStartMs + windowMinutes * 60_000 - Date.now()) / 60_000);
    return { limited: true, minutesLeft };
  }
  return { limited: false };
}

async function dbRateIncrement(key: string, windowMinutes: number): Promise<{ count: number; windowStartMs: number }> {
  const now = new Date();
  const windowMs = windowMinutes * 60_000;
  try {
    const [existing] = await db.select().from(rateLimitsTable).where(eq(rateLimitsTable.key, key)).limit(1);
    if (!existing || now.getTime() - existing.windowStart.getTime() > windowMs) {
      await db.insert(rateLimitsTable).values({
        key,
        attempts: 1,
        windowStart: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: rateLimitsTable.key,
        set: { attempts: 1, windowStart: now, updatedAt: now },
      });
      return { count: 1, windowStartMs: now.getTime() };
    }

    const newCount = existing.attempts + 1;
    await db.update(rateLimitsTable).set({
      attempts: newCount,
      updatedAt: now,
    }).where(eq(rateLimitsTable.key, key));
    return { count: newCount, windowStartMs: existing.windowStart.getTime() };
  } catch {
    return { count: 0, windowStartMs: now.getTime() };
  }
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS CACHE
   Single source of truth lives in routes/admin-shared.ts. We
   delegate to it so any admin save (which invalidates that cache)
   is immediately visible to the auth & rate-limit middleware here.
   The local `settingsCache` is kept only for the legacy synchronous
   helpers above (getRefreshTokenTtlDays, getAccessTokenTtlSec).
══════════════════════════════════════════════════════════════ */
let settingsCache: Record<string, string> = {};

export async function getCachedSettings(): Promise<Record<string, string>> {
  const adminShared = await import("../routes/admin-shared.js");
  const fresh = await adminShared.getCachedSettings();
  settingsCache = fresh;
  // Keep TTL helpers in sync with whatever the unified cache returned.
  VPN_CACHE_TTL_MS = safeInt(fresh["cache_vpn_ttl_min"], 10, 1) * 60 * 1000;
  TOR_LIST_TTL_MS = safeInt(fresh["cache_tor_ttl_min"], 60, 1) * 60 * 1000;
  return fresh;
}

export async function invalidateSettingsCache() {
  const adminShared = await import("../routes/admin-shared.js");
  adminShared.invalidateSettingsCache();
}

/* ══════════════════════════════════════════════════════════════
   ROLE DETECTION
══════════════════════════════════════════════════════════════ */
function getRoleKey(req: Request): "admin" | "rider" | "vendor" | "general" {
  const url = req.url || "";
  if (req.headers["x-admin-secret"] || req.headers["x-admin-token"] || url.includes("/admin")) return "admin";

  const authHeader = req.headers["authorization"] as string | undefined;
  const tokenHeader = req.headers["x-auth-token"] as string | undefined;
  const rawToken = tokenHeader || authHeader?.replace(/^Bearer\s+/i, "");
  if (rawToken) {
    const payload = verifyUserJwt(rawToken);
    if (payload) {
      if (payload.role === "rider" || (payload.roles && payload.roles.includes("rider"))) return "rider";
      if (payload.role === "vendor" || (payload.roles && payload.roles.includes("vendor"))) return "vendor";
    }
  }
  return "general";
}

/* ══════════════════════════════════════════════════════════════
   RATE LIMITING MIDDLEWARE
══════════════════════════════════════════════════════════════ */
export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = getClientIp(req);

  if (req.url === "/" || req.url.endsWith("/health")) { next(); return; }

  if (await isIPBlocked(ip)) {
    addSecurityEvent({ type: "blocked_ip_access", ip, details: `Blocked IP attempted access to ${req.url}`, severity: "high" });
    res.status(403).json({ success: false, error: "Access denied. Your IP address has been blocked due to suspicious activity.", message: "رسائی سے انکار۔ آپ کا IP ایڈریس مشکوک سرگرمی کی وجہ سے بلاک کر دیا گیا ہے۔" });
    return;
  }

  const settings = await getCachedSettings();

  if (settings["security_block_tor"] === "on") {
    const isTor = await isTorExitNode(ip);
    if (isTor) {
      blockIP(ip);
      addSecurityEvent({ type: "tor_access_blocked", ip, details: `TOR exit node blocked from ${req.url}`, severity: "high" });
      addAuditEntry({ action: "tor_block", ip, details: `Blocked TOR exit node IP`, result: "warn" });
      res.status(403).json({ success: false, error: "Access via TOR is not permitted.", message: "TOR کے ذریعے رسائی کی اجازت نہیں ہے۔" });
      return;
    }
  }

  if (settings["security_block_vpn"] === "on") {
    const isVpn = await isVpnOrProxy(ip);
    if (isVpn) {
      addSecurityEvent({ type: "vpn_access_blocked", ip, details: `VPN/proxy IP blocked from ${req.url}`, severity: "medium" });
      res.status(403).json({ success: false, error: "Access via VPN or proxy is not permitted.", message: "VPN یا پراکسی کے ذریعے رسائی کی اجازت نہیں ہے۔" });
      return;
    }
  }

  const roleKey = getRoleKey(req);

  let limitPerMin: number;
  switch (roleKey) {
    case "admin":   limitPerMin = parseInt(settings["security_rate_admin"]  ?? "60",  10); break;
    case "rider":   limitPerMin = parseInt(settings["security_rate_rider"]  ?? "200", 10); break;
    case "vendor":  limitPerMin = parseInt(settings["security_rate_vendor"] ?? "150", 10); break;
    default:        limitPerMin = parseInt(settings["security_rate_limit"]  ?? "100", 10); break;
  }

  const burst = parseInt(settings["security_rate_burst"] ?? "20", 10);
  const hardLimit = limitPerMin + burst;

  const key = `ip_rate:${ip}:${roleKey}`;
  const rateResult = await dbRateIncrement(key, 1);

  if (rateResult.count > 1) {
    if (settings["security_auto_block_ip"] === "on" && rateResult.count > hardLimit * 3) {
      blockIP(ip);
      addAuditEntry({ action: "auto_block_ip", ip, details: `Auto-blocked: ${rateResult.count} req/min far exceeds limit of ${hardLimit}`, result: "warn" });
      addSecurityEvent({ type: "ip_auto_blocked", ip, details: `Auto-blocked after ${rateResult.count} requests in 1 minute`, severity: "critical" });
      res.status(403).json({ success: false, error: "Your IP has been automatically blocked due to excessive requests.", message: "آپ کا IP ایڈریس زیادہ درخواستوں کی وجہ سے خودکار طور پر بلاک کر دیا گیا ہے۔" });
      return;
    }

    if (rateResult.count > hardLimit) {
      const now = Date.now();
      const retryAfter = Math.ceil((rateResult.windowStartMs + 60_000 - now) / 1000);
      res.setHeader("Retry-After", retryAfter.toString());
      res.status(429).json({ success: false, error: "Too many requests. Please slow down.", message: "بہت زیادہ درخواستیں۔ براہ کرم آہستہ کریں۔", retryAfter });
      return;
    }
  }

  next();
}

/* ══════════════════════════════════════════════════════════════
   ADMIN IP WHITELIST CHECK
══════════════════════════════════════════════════════════════ */
export function checkAdminIPWhitelist(req: Request, settings: Record<string, string>): boolean {
  const rawWhitelist = (settings["security_admin_ip_whitelist"] ?? "").trim();
  if (!rawWhitelist) return true;

  const allowed = rawWhitelist.split(",").map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;

  const clientIP = getClientIp(req);
  return allowed.some(a => {
    if (a === clientIP) return true;
    if (a.endsWith(".") && clientIP.startsWith(a)) return true;
    return false;
  });
}

/* ══════════════════════════════════════════════════════════════
   GPS SPOOF DETECTION
══════════════════════════════════════════════════════════════ */
const R = 6371;
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function detectGPSSpoof(
  prevLat: number, prevLon: number, prevTime: Date,
  newLat: number, newLon: number,
  maxSpeedKmh: number
): { spoofed: boolean; speedKmh: number } {
  const distKm = haversineKm(prevLat, prevLon, newLat, newLon);
  const elapsedHours = (Date.now() - prevTime.getTime()) / 3_600_000;
  if (elapsedHours <= 0) return { spoofed: false, speedKmh: 0 };
  const speedKmh = distKm / elapsedHours;
  return { spoofed: speedKmh > maxSpeedKmh, speedKmh };
}

/* ══════════════════════════════════════════════════════════════
   TOKEN REVOCATION CHECK
   Checks if a refresh token has been revoked or expired.
══════════════════════════════════════════════════════════════ */
export async function isRefreshTokenValid(tokenHash: string): Promise<boolean> {
  const [rt] = await db.select().from(refreshTokensTable)
    .where(and(eq(refreshTokensTable.tokenHash, tokenHash)))
    .limit(1);
  if (!rt) return false;
  if (rt.revokedAt) return false;
  if (new Date() > rt.expiresAt) return false;
  return true;
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  await db.update(refreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokensTable.tokenHash, tokenHash));
}

export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  await db.update(refreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokensTable.userId, userId)));
}

/* ══════════════════════════════════════════════════════════════
   CUSTOMER AUTH MIDDLEWARE
   Validates JWT, checks DB ban/active status, sets req.customerId.
══════════════════════════════════════════════════════════════ */
export async function customerAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"] as string | undefined;
  const tokenHeader = req.headers["x-auth-token"] as string | undefined;
  const token = tokenHeader || authHeader?.replace(/^Bearer\s+/i, "");
  const ip = getClientIp(req);

  if (!token) {
    res.status(401).json({ success: false, error: "Authentication required. Please log in.", message: "تصدیق ضروری ہے۔ براہ کرم لاگ ان کریں۔" });
    return;
  }

  const payload = verifyUserJwt(token);
  if (!payload) {
    writeAuthAuditLog("auth_denied_invalid_token", { ip, metadata: { url: req.url } });
    res.status(401).json({ success: false, error: "Invalid or expired session. Please log in again.", message: "غلط یا ختم شدہ سیشن۔ براہ کرم دوبارہ لاگ ان کریں۔" });
    return;
  }

  if (payload.jti) {
    const blacklisted = await isJtiBlacklisted(payload.jti);
    if (blacklisted) {
      writeAuthAuditLog("auth_denied_blacklisted_jti", { userId: payload.userId, ip, metadata: { url: req.url } });
      res.status(401).json({ success: false, error: "Session has been revoked. Please log in again.", message: "سیشن منسوخ کر دیا گیا۔ براہ کرم دوبارہ لاگ ان کریں۔" });
      return;
    }
  }

  const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, payload.userId), isNull(usersTable.deletedAt))).limit(1);
  if (!user) { res.status(401).json({ success: false, error: "Account not found.", message: "اکاؤنٹ نہیں ملا۔" }); return; }
  if (user.isBanned) {
    writeAuthAuditLog("auth_denied_banned", { userId: user.id, ip });
    res.status(403).json({ success: false, error: "Your account has been suspended. Contact support.", message: "آپ کا اکاؤنٹ معطل کر دیا گیا ہے۔ سپورٹ سے رابطہ کریں۔" });
    return;
  }
  if (!user.isActive) {
    writeAuthAuditLog("auth_denied_inactive", { userId: user.id, ip });
    res.status(403).json({ success: false, error: "Your account is inactive. Contact support.", message: "آپ کا اکاؤنٹ غیر فعال ہے۔ سپورٹ سے رابطہ کریں۔" });
    return;
  }

  if (typeof payload.tokenVersion === "number" && payload.tokenVersion !== (user.tokenVersion ?? 0)) {
    writeAuthAuditLog("auth_denied_token_revoked", { userId: user.id, ip, metadata: { url: req.url } });
    res.status(401).json({ success: false, error: "Session revoked. Please log in again.", message: "سیشن منسوخ کر دیا گیا۔ براہ کرم دوبارہ لاگ ان کریں۔" });
    return;
  }

  const dbRoles = (user.roles || "customer").split(",").map((r: string) => r.trim());
  if (!dbRoles.includes("customer")) {
    writeAuthAuditLog("auth_denied_role", { userId: user.id, ip, metadata: { required: "customer", actual: user.roles, url: req.url } });
    res.status(403).json({ success: false, code: "ROLE_DENIED", error: "Access denied. Customer account required.", message: "رسائی سے انکار۔ کسٹمر اکاؤنٹ ضروری ہے۔" });
    return;
  }

  req.customerId    = payload.userId;
  req.customerPhone = payload.phone;
  req.customerUser  = user;
  next();
}

/* ══════════════════════════════════════════════════════════════
   RIDER AUTH MIDDLEWARE
══════════════════════════════════════════════════════════════ */
export async function riderAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"] as string | undefined;
  const tokenHeader = req.headers["x-auth-token"] as string | undefined;
  const token = tokenHeader || authHeader?.replace(/^Bearer\s+/i, "");
  const ip = getClientIp(req);

  if (!token) {
    res.status(401).json({ success: false, error: "Authentication required.", message: "تصدیق ضروری ہے۔" });
    return;
  }

  const payload = verifyUserJwt(token);
  if (!payload) {
    writeAuthAuditLog("auth_denied_invalid_token", { ip, metadata: { url: req.url, role: "rider" } });
    res.status(401).json({ success: false, error: "Invalid or expired session. Please log in again.", message: "غلط یا ختم شدہ سیشن۔ براہ کرم دوبارہ لاگ ان کریں۔" });
    return;
  }

  if (payload.jti) {
    const blacklisted = await isJtiBlacklisted(payload.jti);
    if (blacklisted) {
      writeAuthAuditLog("auth_denied_blacklisted_jti", { userId: payload.userId, ip, metadata: { url: req.url, role: "rider" } });
      res.status(401).json({ success: false, error: "Session has been revoked. Please log in again.", message: "سیشن منسوخ کر دیا گیا۔ براہ کرم دوبارہ لاگ ان کریں۔" });
      return;
    }
  }

  const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, payload.userId), isNull(usersTable.deletedAt))).limit(1);
  if (!user) { res.status(401).json({ success: false, error: "Account not found.", message: "اکاؤنٹ نہیں ملا۔" }); return; }
  if (user.isBanned) {
    writeAuthAuditLog("auth_denied_banned", { userId: user.id, ip, metadata: { url: req.url, role: "rider" } });
    res.status(403).json({ success: false, code: "AUTH_REQUIRED", error: "Account is banned.", message: "اکاؤنٹ پابندی شدہ ہے۔" }); return;
  }
  if (!user.isActive) {
    writeAuthAuditLog("auth_denied_inactive", { userId: user.id, ip, metadata: { url: req.url, role: "rider" } });
    res.status(403).json({ success: false, code: "AUTH_REQUIRED", error: "Account is inactive.", message: "اکاؤنٹ غیر فعال ہے۔" }); return;
  }

  if (typeof payload.tokenVersion === "number" && payload.tokenVersion !== (user.tokenVersion ?? 0)) {
    writeAuthAuditLog("auth_denied_token_revoked", { userId: user.id, ip, metadata: { url: req.url, role: "rider" } });
    res.status(401).json({ success: false, code: "TOKEN_EXPIRED", error: "Session revoked. Please log in again.", message: "سیشن منسوخ کر دیا گیا۔ براہ کرم دوبارہ لاگ ان کریں۔" });
    return;
  }

  const dbRoles = (user.roles || "customer").split(",").map((r: string) => r.trim());
  if (!dbRoles.includes("rider")) {
    writeAuthAuditLog("auth_denied_role", { userId: user.id, ip, metadata: { required: "rider", actual: user.roles } });
    res.status(403).json({ success: false, code: "ROLE_DENIED", error: "Access denied. Rider account required.", message: "رسائی سے انکار۔ رائیڈر اکاؤنٹ ضروری ہے۔" });
    return;
  }

  req.riderId = user.id;
  req.riderUser = user;
  next();
}

/* ── Legacy middleware alias ── */
export async function requireUserAuth(req: Request, res: Response, next: NextFunction) {
  return customerAuth(req, res, next);
}

/* ══════════════════════════════════════════════════════════════
   ANY-USER AUTH MIDDLEWARE
   Validates JWT and checks ban/active status, but does NOT
   enforce a specific role. Any authenticated user is allowed.
   Sets req.customerId, req.customerPhone, req.customerUser.
══════════════════════════════════════════════════════════════ */
export async function anyUserAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"] as string | undefined;
  const tokenHeader = req.headers["x-auth-token"] as string | undefined;
  const token = tokenHeader || authHeader?.replace(/^Bearer\s+/i, "");
  const ip = getClientIp(req);

  if (!token) {
    res.status(401).json({ success: false, error: "Authentication required. Please log in.", message: "تصدیق ضروری ہے۔ براہ کرم لاگ ان کریں۔" });
    return;
  }

  const payload = verifyUserJwt(token);
  if (!payload) {
    writeAuthAuditLog("auth_denied_invalid_token", { ip, metadata: { url: req.url } });
    res.status(401).json({ success: false, error: "Invalid or expired session. Please log in again.", message: "غلط یا ختم شدہ سیشن۔ براہ کرم دوبارہ لاگ ان کریں۔" });
    return;
  }

  if (payload.jti) {
    const blacklisted = await isJtiBlacklisted(payload.jti);
    if (blacklisted) {
      writeAuthAuditLog("auth_denied_blacklisted_jti", { userId: payload.userId, ip, metadata: { url: req.url } });
      res.status(401).json({ success: false, error: "Session has been revoked. Please log in again.", message: "سیشن منسوخ کر دیا گیا۔ براہ کرم دوبارہ لاگ ان کریں۔" });
      return;
    }
  }

  const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, payload.userId), isNull(usersTable.deletedAt))).limit(1);
  if (!user) { res.status(401).json({ success: false, error: "Account not found.", message: "اکاؤنٹ نہیں ملا۔" }); return; }
  if (user.isBanned) {
    writeAuthAuditLog("auth_denied_banned", { userId: user.id, ip });
    res.status(403).json({ success: false, error: "Your account has been suspended. Contact support.", message: "آپ کا اکاؤنٹ معطل کر دیا گیا ہے۔ سپورٹ سے رابطہ کریں۔" });
    return;
  }
  if (!user.isActive) {
    writeAuthAuditLog("auth_denied_inactive", { userId: user.id, ip });
    res.status(403).json({ success: false, error: "Your account is inactive. Contact support.", message: "آپ کا اکاؤنٹ غیر فعال ہے۔ سپورٹ سے رابطہ کریں۔" });
    return;
  }

  if (typeof payload.tokenVersion === "number" && payload.tokenVersion !== (user.tokenVersion ?? 0)) {
    writeAuthAuditLog("auth_denied_token_revoked", { userId: user.id, ip, metadata: { url: req.url } });
    res.status(401).json({ success: false, error: "Session revoked. Please log in again.", message: "سیشن منسوخ کر دیا گیا۔ براہ کرم دوبارہ لاگ ان کریں۔" });
    return;
  }

  req.customerId    = payload.userId;
  req.customerPhone = payload.phone;
  req.customerUser  = user;
  next();
}

/* ══════════════════════════════════════════════════════════════
   REQUIRE ROLE — DRY factory that replaces customerAuth / riderAuth /
   vendorAuth with a single configurable middleware.

   Usage:
     router.use(requireRole("rider"))          — enforce single role
     router.get("/", requireRole("customer"))  — per-route
     router.use(requireRole("vendor", { vendorApprovalCheck: true }))
            — adds vendor pending/rejected approval status checks

   Sets on req: customerId, customerPhone, customerUser
   Additionally sets riderId + riderUser when role includes "rider"
   Additionally sets vendorId + vendorUser when role includes "vendor"
══════════════════════════════════════════════════════════════ */
export function requireRole(
  role: string | string[],
  opts: { vendorApprovalCheck?: boolean } = {}
) {
  const allowedRoles = Array.isArray(role) ? role : [role];

  return async function requireRoleMiddleware(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers["authorization"] as string | undefined;
    const tokenHeader = req.headers["x-auth-token"] as string | undefined;
    const token = tokenHeader || authHeader?.replace(/^Bearer\s+/i, "");
    const ip = getClientIp(req);

    if (!token) {
      res.status(401).json({ success: false, error: "Authentication required.", message: "تصدیق ضروری ہے۔" });
      return;
    }

    const payload = verifyUserJwt(token);
    if (!payload) {
      writeAuthAuditLog("auth_denied_invalid_token", { ip, metadata: { url: req.url, roles: allowedRoles } });
      res.status(401).json({ success: false, error: "Invalid or expired session. Please log in again.", message: "غلط یا ختم شدہ سیشن۔ براہ کرم دوبارہ لاگ ان کریں۔" });
      return;
    }

    if (payload.jti) {
      const blacklisted = await isJtiBlacklisted(payload.jti);
      if (blacklisted) {
        writeAuthAuditLog("auth_denied_blacklisted_jti", { userId: payload.userId, ip, metadata: { url: req.url } });
        res.status(401).json({ success: false, error: "Session has been revoked. Please log in again.", message: "سیشن منسوخ کر دیا گیا۔ براہ کرم دوبارہ لاگ ان کریں۔" });
        return;
      }
    }

    const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, payload.userId), isNull(usersTable.deletedAt))).limit(1);
    if (!user) { res.status(401).json({ success: false, error: "Account not found.", message: "اکاؤنٹ نہیں ملا۔" }); return; }

    if (user.isBanned) {
      writeAuthAuditLog("auth_denied_banned", { userId: user.id, ip, metadata: { url: req.url } });
      res.status(403).json({ success: false, error: "Account is banned. Please contact support.", message: "اکاؤنٹ پابندی شدہ ہے۔ براہ کرم سپورٹ سے رابطہ کریں۔" });
      return;
    }

    if (opts.vendorApprovalCheck) {
      if (user.approvalStatus === "pending") {
        writeAuthAuditLog("auth_denied_pending", { userId: user.id, ip, metadata: { url: req.url } });
        res.status(403).json({ success: false, error: "Your vendor account is pending admin approval.", message: "آپ کا وینڈر اکاؤنٹ ایڈمن کی منظوری کے انتظار میں ہے۔", pendingApproval: true });
        return;
      }
      if (user.approvalStatus === "rejected") {
        writeAuthAuditLog("auth_denied_rejected", { userId: user.id, ip, metadata: { url: req.url } });
        res.status(403).json({ success: false, error: "Your vendor application was rejected. Contact support for details.", message: "آپ کی وینڈر درخواست مسترد کر دی گئی۔ تفصیلات کے لیے سپورٹ سے رابطہ کریں۔", rejected: true, approvalNote: user.approvalNote });
        return;
      }
      if (!user.isActive) {
        writeAuthAuditLog("auth_denied_inactive", { userId: user.id, ip, metadata: { url: req.url } });
        res.status(403).json({ success: false, error: "Your vendor account has been deactivated. Please contact support.", message: "آپ کا وینڈر اکاؤنٹ غیر فعال کر دیا گیا ہے۔ براہ کرم سپورٹ سے رابطہ کریں۔" });
        return;
      }
    }

    if (!user.isActive) {
      writeAuthAuditLog("auth_denied_inactive", { userId: user.id, ip, metadata: { url: req.url } });
      res.status(403).json({ success: false, error: "Account is inactive. Please contact support.", message: "اکاؤنٹ غیر فعال ہے۔ براہ کرم سپورٹ سے رابطہ کریں۔" });
      return;
    }

    if (typeof payload.tokenVersion === "number" && payload.tokenVersion !== (user.tokenVersion ?? 0)) {
      writeAuthAuditLog("auth_denied_token_revoked", { userId: user.id, ip, metadata: { url: req.url } });
      res.status(401).json({ success: false, error: "Session revoked. Please log in again.", message: "سیشن منسوخ کر دیا گیا۔ براہ کرم دوبارہ لاگ ان کریں۔" });
      return;
    }

    if (allowedRoles.length > 0) {
      const dbRoles = (user.roles || "customer").split(",").map((r: string) => r.trim());
      const hasRole = allowedRoles.some(r => dbRoles.includes(r));
      if (!hasRole) {
        writeAuthAuditLog("auth_denied_role", { userId: user.id, ip, metadata: { required: allowedRoles, actual: user.roles, url: req.url } });
        res.status(403).json({ success: false, error: `Access denied. Required role: ${allowedRoles.join(" or ")}.`, message: "رسائی سے انکار۔" });
        return;
      }
    }

    req.customerId    = user.id;
    req.customerPhone = user.phone ?? "";
    req.customerUser  = user;

    const dbRoles = (user.roles || "customer").split(",").map((r: string) => r.trim());
    if (dbRoles.includes("rider")) {
      req.riderId   = user.id;
      req.riderUser = user;
    }
    if (dbRoles.includes("vendor")) {
      req.vendorId   = user.id;
      req.vendorUser = user;
    }

    next();
  };
}

export async function verifyCaptcha(req: Request, res: Response, next: NextFunction) {
  const settings = await getCachedSettings();
  if (settings["auth_captcha_enabled"] !== "on") {
    next();
    return;
  }

  const captchaToken = req.body?.captchaToken || req.headers["x-captcha-token"];
  if (!captchaToken) {
    res.status(400).json({ success: false, error: "CAPTCHA verification required", message: "CAPTCHA تصدیق ضروری ہے" });
    return;
  }

  const secretKey = process.env["RECAPTCHA_SECRET_KEY"] || settings["recaptcha_secret_key"] || "";
  if (!secretKey) {
    logger.error("[CAPTCHA] CAPTCHA enabled but no RECAPTCHA_SECRET_KEY configured — blocking request");
    res.status(500).json({ success: false, error: "CAPTCHA verification is misconfigured. Please contact support.", message: "CAPTCHA تصدیق میں خرابی۔ براہ کرم سپورٹ سے رابطہ کریں۔" });
    return;
  }

  try {
    const verifyUrl = "https://www.google.com/recaptcha/api/siteverify";
    const resp = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(captchaToken as string)}`,
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      logger.error(`[CAPTCHA] Google API returned non-OK status: ${resp.status}`);
      res.status(502).json({ success: false, error: "CAPTCHA verification service unavailable. Please try again.", message: "CAPTCHA تصدیق کی سروس دستیاب نہیں ہے۔" });
      return;
    }

    const data = await resp.json() as { success: boolean; score?: number; "error-codes"?: string[] };
    if (!data.success) {
      const ip = getClientIp(req);
      addSecurityEvent({ type: "captcha_failed", ip, details: `CAPTCHA failed: ${(data["error-codes"] ?? []).join(", ")}`, severity: "medium" });
      res.status(403).json({ success: false, error: "CAPTCHA verification failed. Please try again.", message: "CAPTCHA تصدیق ناکام ہو گئی۔ براہ کرم دوبارہ کوشش کریں۔" });
      return;
    }

    const minScore = parseFloat(settings["recaptcha_min_score"] ?? "0.5");
    if (typeof data.score === "number" && data.score < minScore) {
      const ip = getClientIp(req);
      addSecurityEvent({ type: "captcha_low_score", ip, details: `CAPTCHA score ${data.score} below threshold ${minScore}`, severity: "medium" });
      res.status(403).json({ success: false, error: "Suspicious activity detected. Please try again.", message: "مشکوک سرگرمی کا پتہ چلا۔ براہ کرم دوبارہ کوشش کریں۔" });
      return;
    }

    next();
  } catch (err: any) {
    logger.error("[CAPTCHA] Verification error:", err.message);
    res.status(502).json({ success: false, error: "CAPTCHA verification failed. Please try again later.", message: "CAPTCHA تصدیق ناکام ہو گئی۔ براہ کرم بعد میں دوبارہ کوشش کریں۔" });
  }
}

/* ══════════════════════════════════════════════════════════════
   FEATURE FLAG GUARD — reusable middleware factory.
   Creates a middleware that reads a platform settings key and
   returns 403 when the feature is not "on".  Modelled after the
   requireChatEnabled middleware in support-chat.ts.

   Usage (router-level):
     router.use(requireFeatureEnabled("feature_weather"));
   Usage (route-level):
     router.get("/foo", requireFeatureEnabled("feature_referral"), handler);
══════════════════════════════════════════════════════════════ */
export function requireFeatureEnabled(settingKey: string, disabledMessage?: string) {
  return async function (_req: Request, res: Response, next: NextFunction) {
    const s = await getCachedSettings();
    if ((s[settingKey] ?? "off") !== "on") {
      const msg = disabledMessage ?? `This feature is currently disabled by the administrator.`;
      res.status(403).json({ error: msg });
      return;
    }
    next();
  };
}

/* ══════════════════════════════════════════════════════════════
   IDOR GUARD — ensures the requesting user owns the resource.
   Usage: if (idorGuard(res, requestedOwnerId, req.userId)) return;
══════════════════════════════════════════════════════════════ */
export function idorGuard(
  res: Response,
  resourceOwnerId: string | null | undefined,
  requestingUserId: string,
  opts: { adminBypass?: boolean; requestingRole?: string } = {}
): boolean {
  if (opts.adminBypass && opts.requestingRole && ["admin", "superadmin"].includes(opts.requestingRole)) {
    return false;
  }
  if (!resourceOwnerId || resourceOwnerId !== requestingUserId) {
    res.status(403).json({ success: false, error: "Access denied.", message: "رسائی سے انکار۔" });
    return true;
  }
  return false;
}
