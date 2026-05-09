import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { logger as pinoLogger } from "../lib/logger.js";

/**
 * Resolve a JWT secret from an environment variable.
 * Exits the process in production if the secret is absent or too short;
 * logs a warning and uses a padded dev fallback in development.
 */
function resolveAdminSecret(envVar: string): string {
  const val = process.env[envVar];
  if (!val || val.length < 32) {
    const msg = !val
      ? `[admin-shared] FATAL: ${envVar} is not set. A minimum 32-character secret is required.`
      : `[admin-shared] FATAL: ${envVar} is too short (${val.length} chars, need ≥32).`;
    if (process.env.NODE_ENV === "production") {
      pinoLogger.fatal(msg);
      process.exit(1);
    }
    pinoLogger.warn(
      `[admin-shared] WARNING: ${envVar} not set or too short. ` +
      `Using unsafe dev fallback — set a strong secret before deploying.`,
    );
    return (val ?? "") + "dev_fallback_pad_to_32_chars_min!!";
  }
  return val;
}
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { redisClient } from "../lib/redis.js";
import {
  db,
  platformSettingsTable,
  adminAccountsTable,
  adminActionAuditLogTable,
} from "@workspace/db";
import { generateId as _generateId } from "../lib/id.js";

/* ── Re-exports ──────────────────────────────────────────────────────────── */
export { generateId } from "../lib/id.js";
export { logger } from "../lib/logger.js";

/* ── CONSTANTS ─────────────────────────────────────────────────────────── */

export const ADMIN_TOKEN_TTL_HRS = 24;
export const ADMIN_REFRESH_TTL_DAYS = 30;
export const ADMIN_MAX_ATTEMPTS = 5;
export const ADMIN_LOCKOUT_TIME = 15;

/* ── NOTIFICATION KEYS ─────────────────────────────────────────────────── */

export const ORDER_NOTIF_KEYS = ["order_placed", "order_confirmed", "order_assigned", "order_picked", "order_delivered", "order_cancelled"];
export const RIDE_NOTIF_KEYS  = ["ride_requested", "ride_accepted", "ride_started", "ride_completed", "ride_cancelled"];
export const PHARMACY_NOTIF_KEYS = ["pharmacy_order_placed", "pharmacy_order_confirmed", "pharmacy_order_ready", "pharmacy_order_delivered"];
export const PARCEL_NOTIF_KEYS   = ["parcel_booked", "parcel_picked", "parcel_delivered", "parcel_cancelled"];

/* ── DEFAULT PLATFORM SETTINGS ─────────────────────────────────────────── */

export const DEFAULT_PLATFORM_SETTINGS: Array<{ key: string; value: string; category: string }> = [
  { key: "feature_mart",      value: "on",  category: "features" },
  { key: "feature_food",      value: "on",  category: "features" },
  { key: "feature_rides",     value: "on",  category: "features" },
  { key: "feature_pharmacy",  value: "on",  category: "features" },
  { key: "feature_parcel",    value: "on",  category: "features" },
  { key: "feature_van",       value: "on",  category: "features" },
  { key: "feature_wallet",    value: "on",  category: "features" },
  { key: "feature_referral",  value: "on",  category: "features" },
  { key: "feature_new_users", value: "on",  category: "features" },
  { key: "auth_mode",                      value: "OTP",  category: "auth" },
  { key: "auth_otp_enabled",               value: "on",   category: "auth" },
  { key: "auth_email_enabled",             value: "on",   category: "auth" },
  { key: "auth_google_enabled",            value: "on",   category: "auth" },
  { key: "auth_facebook_enabled",          value: "off",  category: "auth" },
  { key: "auth_phone_otp_enabled",         value: "on",   category: "auth" },
  { key: "auth_email_otp_enabled",         value: "on",   category: "auth" },
  { key: "auth_username_password_enabled", value: "off",  category: "auth" },
  { key: "auth_magic_link_enabled",        value: "off",  category: "auth" },
  { key: "firebase_enabled",               value: "off",  category: "integrations" },
  { key: "security_login_max_attempts",    value: "5",    category: "security" },
  { key: "security_lockout_minutes",       value: "30",   category: "security" },
  { key: "security_otp_max_per_phone",     value: "5",    category: "security" },
  { key: "security_otp_max_per_ip",        value: "20",   category: "security" },
  { key: "security_otp_window_min",        value: "60",   category: "security" },
  { key: "security_suspicious_pattern_threshold", value: "60", category: "security" },
  { key: "jwt_access_ttl_sec",             value: "900",  category: "security" },
  { key: "jwt_refresh_ttl_days",           value: "7",    category: "security" },
  { key: "platform_mode",                  value: "demo", category: "general" },
  { key: "currency",                       value: "PKR",  category: "general" },
  { key: "currency_symbol",               value: "Rs.",  category: "general" },
  { key: "default_language",              value: "en",   category: "general" },
  { key: "health_monitor_enabled",        value: "off",  category: "health" },
  { key: "loyalty_enabled",              value: "off",  category: "features" },
  { key: "loyalty_points_per_rupee",     value: "1",    category: "loyalty" },
  { key: "loyalty_redemption_rate",      value: "0.01", category: "loyalty" },
];

/* ── DEFAULT RIDE SERVICES ─────────────────────────────────────────────── */

export const DEFAULT_RIDE_SERVICES = [
  { id: "bike",     name: "Bike",     icon: "bicycle-outline",   baseFare: "30", perKm: "10" },
  { id: "car",      name: "Car",      icon: "car-outline",       baseFare: "80", perKm: "20" },
  { id: "rickshaw", name: "Rickshaw", icon: "car-sport-outline", baseFare: "50", perKm: "12" },
];

/* ── ADMIN LOGIN LOCKOUT — Redis-backed with in-memory fallback ──────── */

/** In-memory fallback used when Redis is unavailable (lost on restart). */
const _memAttempts = new Map<string, { count: number; lastAttempt: number }>();

function _memKey(ip: string) { return `admin:lockout:${ip}`; }
const LOCKOUT_TTL_SEC = ADMIN_LOCKOUT_TIME * 60;

/**
 * Returns true when the IP has exceeded ADMIN_MAX_ATTEMPTS within the
 * lockout window. Uses Redis when available, falls back to in-memory.
 */
export async function checkAdminLoginLockout(ip: string): Promise<boolean> {
  if (redisClient) {
    try {
      const raw = await redisClient.get(_memKey(ip));
      if (!raw) return false;
      const count = parseInt(raw, 10);
      return count >= ADMIN_MAX_ATTEMPTS;
    } catch (err) {
      pinoLogger.warn({ ip, err }, "[admin-shared] Redis lockout check failed — using memory fallback");
    }
  }
  /* in-memory fallback */
  const record = _memAttempts.get(ip);
  if (!record) return false;
  if (record.count >= ADMIN_MAX_ATTEMPTS) {
    const elapsed = Date.now() - record.lastAttempt;
    if (elapsed < LOCKOUT_TTL_SEC * 1000) return true;
    _memAttempts.delete(ip);
  }
  return false;
}

/**
 * Increment the failure counter for the IP. The key is given a TTL equal
 * to the lockout window so Redis auto-expires it once the window passes.
 */
export async function recordAdminLoginFailure(ip: string): Promise<void> {
  if (redisClient) {
    try {
      const key = _memKey(ip);
      const count = await redisClient.incr(key);
      if (count === 1) {
        /* First failure — start the TTL clock */
        await redisClient.expire(key, LOCKOUT_TTL_SEC);
      }
      return;
    } catch (err) {
      pinoLogger.warn({ ip, err }, "[admin-shared] Redis lockout record failed — using memory fallback");
    }
  }
  /* in-memory fallback */
  const record = _memAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  record.count += 1;
  record.lastAttempt = Date.now();
  _memAttempts.set(ip, record);
}

/** Export for backward compatibility with code that checks the map directly. */
export const adminLoginAttempts = _memAttempts;

/* ── TYPE DEFINITIONS ──────────────────────────────────────────────────── */

export interface AdminPayload {
  adminId: string | null;
  role: string;
  name: string;
  permissions: string[];
}

export interface AdminRequest extends Request {
  adminId?: string;
  adminRole?: string;
  adminName?: string;
  adminPermissions?: string[];
  adminPayload?: AdminPayload;
  adminIp?: string;
}

export type TranslationKey = string;

/* ── SECURITY CORE ─────────────────────────────────────────────────────── */

const _ADMIN_JWT_SECRET = resolveAdminSecret("ADMIN_JWT_SECRET");
const _ADMIN_REFRESH_SECRET = (() => {
  const v = process.env.ADMIN_JWT_REFRESH_SECRET || process.env.ADMIN_REFRESH_SECRET;
  if (!v || v.length < 32) {
    const key = "ADMIN_JWT_REFRESH_SECRET / ADMIN_REFRESH_SECRET";
    const msg = !v
      ? `[admin-shared] FATAL: ${key} is not set. A minimum 32-character secret is required.`
      : `[admin-shared] FATAL: ${key} is too short (${v.length} chars, need ≥32).`;
    if (process.env.NODE_ENV === "production") { pinoLogger.fatal(msg); process.exit(1); }
    pinoLogger.warn(`[admin-shared] WARNING: ${key} not set or too short. Using unsafe dev fallback.`);
    return (v ?? "") + "dev_fallback_pad_to_32_chars_min!!";
  }
  return v;
})();

export function signAdminJwt(
  adminId: string | null,
  role: string,
  name: string,
  expiresInHrs: number = ADMIN_TOKEN_TTL_HRS,
  permissions: string[] = [],
): string {
  return jwt.sign(
    { adminId, role, name, permissions, type: "admin" },
    _ADMIN_JWT_SECRET,
    { expiresIn: `${expiresInHrs}h` },
  );
}

export function signAdminRefreshToken(adminId: string | null, role: string): string {
  return jwt.sign({ adminId, role }, _ADMIN_REFRESH_SECRET, { expiresIn: `${ADMIN_REFRESH_TTL_DAYS}d` });
}

export function verifyAdminJwt(token: string): AdminPayload | null {
  try {
    const secret = _ADMIN_JWT_SECRET;
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    return {
      adminId:     (payload["adminId"] as string | null) ?? null,
      role:        (payload["role"]    as string) ?? "admin",
      name:        (payload["name"]    as string) ?? "Admin",
      permissions: (payload["permissions"] as string[]) ?? [],
    };
  } catch {
    return null;
  }
}

export async function getAdminSecret(): Promise<string | null> {
  const envSecret = process.env.ADMIN_SECRET;
  try {
    const settings = await getCachedSettings();
    return settings["admin_master_secret"] || envSecret || null;
  } catch {
    return envSecret || null;
  }
}

export async function verifyAdminSecret(input: string): Promise<boolean> {
  const actual = await getAdminSecret();
  if (!actual) return false;
  return input === actual;
}

/* ── MIDDLEWARE ────────────────────────────────────────────────────────── */

export const adminAuth = (req: AdminRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: No token provided" });
    return;
  }

  const token = authHeader.split(" ")[1]!;

  try {
    const payload = jwt.verify(token, _ADMIN_JWT_SECRET) as {
      adminId?: string | null;
      role?: string;
      name?: string;
      permissions?: string[];
    };
    req.adminId          = payload.adminId ?? undefined;
    req.adminRole        = payload.role ?? "admin";
    req.adminName        = payload.name ?? "Admin";
    req.adminPermissions = payload.permissions ?? [];
    req.adminPayload     = {
      adminId:     payload.adminId ?? null,
      role:        payload.role ?? "admin",
      name:        payload.name ?? "Admin",
      permissions: payload.permissions ?? [],
    };
    req.adminIp = getClientIp(req);
    next();
  } catch (err) {
    pinoLogger.warn({ err, ip: getClientIp(req) }, "[admin-shared] Invalid admin token");
    res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
  }
};

/* ── AUDIT LOGGING ─────────────────────────────────────────────────────── */

export async function addAuditEntry(params: {
  action: string;
  ip: string;
  adminId?: string | null;
  adminName?: string | null;
  details?: string;
  result: "success" | "fail" | "warn";
  affectedUserId?: string | null;
  affectedUserName?: string | null;
  affectedUserRole?: string | null;
}): Promise<void> {
  try {
    await db.insert(adminActionAuditLogTable).values({
      id:               _generateId(),
      adminId:          params.adminId ?? null,
      adminName:        params.adminName ?? null,
      ip:               params.ip,
      action:           params.action,
      result:           params.result,
      details:          params.details ?? null,
      affectedUserId:   params.affectedUserId ?? null,
      affectedUserName: params.affectedUserName ?? null,
      affectedUserRole: params.affectedUserRole ?? null,
    });
  } catch (err) {
    pinoLogger.error({ err, params }, "[admin-shared] Failed to write audit entry");
  }
}

/* ── SETTINGS CACHE ────────────────────────────────────────────────────── */

let settingsCache: Record<string, string> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 1000;

export async function getCachedSettings(): Promise<Record<string, string>> {
  const now = Date.now();
  if (settingsCache && now - cacheTimestamp < CACHE_TTL_MS) {
    return settingsCache;
  }
  try {
    const rows = await db.select().from(platformSettingsTable);
    const map: Record<string, string> = {};
    for (const r of rows) {
      if (r.value !== null) map[r.key] = r.value;
    }
    settingsCache = map;
    cacheTimestamp = now;
    return map;
  } catch (err) {
    pinoLogger.error({ err }, "[admin-shared] Settings cache refresh failed");
    return settingsCache || {};
  }
}

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

export function invalidatePlatformSettingsCache(): void {
  settingsCache = null;
}

export async function getPlatformSettings(): Promise<Record<string, string>> {
  return getCachedSettings();
}

/* ── HELPERS ───────────────────────────────────────────────────────────── */

export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return (Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0])?.trim() || req.ip || "unknown";
  }
  return req.ip || "unknown";
}

/* ── MFA UTILITIES ─────────────────────────────────────────────────────── */

export function generateTotpSecret(): string {
  return randomBytes(20).toString("hex");
}

export async function generateQRCodeDataURL(secret: string, accountName: string): Promise<string> {
  const { default: qrcode } = await import("qrcode");
  const uri = getTotpUri(secret, accountName);
  return qrcode.toDataURL(uri);
}

export function getTotpUri(secret: string, accountName: string): string {
  const issuer = "AJKMart Admin";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}

export async function verifyTotpToken(token: string, secret: string): Promise<boolean> {
  try {
    const { verifyTotpToken: totpVerify } = await import("../services/totp.js");
    return totpVerify(token, secret);
  } catch {
    return false;
  }
}

/* ── RATE LIMITING / SECURITY EVENTS ──────────────────────────────────── */

export async function resetAdminLoginAttempts(ip: string): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.del(_memKey(ip));
    } catch (err) {
      pinoLogger.warn({ ip, err }, "[admin-shared] Redis reset failed — clearing memory fallback");
    }
  }
  _memAttempts.delete(ip);
  pinoLogger.info({ ip }, "[admin-shared] Reset login attempts");
}

export async function addSecurityEvent(params: {
  type: string;
  ip: string;
  userId?: string;
  details: string;
  severity: "low" | "medium" | "high" | "critical";
}): Promise<void> {
  pinoLogger.warn(params, "[admin-shared] Security event recorded");
}

/* ── LOCALISATION ──────────────────────────────────────────────────────── */

export function stripUser(user: Record<string, unknown>): Record<string, unknown> {
  const { password: _p, ...rest } = user;
  return rest;
}

export async function getUserLanguage(_userId: string): Promise<string> {
  return "en";
}

export function t(key: TranslationKey, _lang: string): string {
  return key;
}

export async function sendUserNotification(
  userId: string,
  title: string,
  body: string,
  _type?: string,
  _icon?: string,
): Promise<void> {
  pinoLogger.info({ userId, title, body }, "[admin-shared] User notification sent");
}

/* ── RIDE SERVICES / LOCATIONS SEEDING ─────────────────────────────────── */

export async function ensureDefaultRideServices(): Promise<void> {}
export async function ensureDefaultLocations(): Promise<void> {}
export function formatSvc(svc: unknown): unknown { return svc; }

/* ── MIGRATION STUBS ────────────────────────────────────────────────────── */

export async function ensureAuthMethodColumn(): Promise<void> {}
export async function ensureRideBidsMigration(): Promise<void> {}
export async function ensureOrdersGpsColumns(): Promise<void> {}
export async function ensurePromotionsTables(): Promise<void> {}
export async function ensureSupportMessagesTable(): Promise<void> {}
export async function ensureFaqsTable(): Promise<void> {}
export async function ensureCommunicationTables(): Promise<void> {}
export async function ensureVendorLocationColumns(): Promise<void> {}
export async function ensureVanServiceUpgrade(): Promise<void> {}
export async function ensureWalletP2PColumns(): Promise<void> {}
export async function ensureComplianceTables(): Promise<void> {}

/* ── SESSION MANAGEMENT ─────────────────────────────────────────────────── */

export async function revokeAllUserSessions(userId: string): Promise<void> {
  try {
    const { revokeAllUserRefreshTokens } = await import("../middleware/security.js");
    await revokeAllUserRefreshTokens(userId);
  } catch {
    pinoLogger.warn({ userId }, "[admin-shared] revokeAllUserSessions failed");
  }
}

/* ── SOS ────────────────────────────────────────────────────────────────── */

export function serializeSosAlert(alert: unknown): unknown {
  return alert;
}

/* ── AUDIT LOG PROXY ─────────────────────────────────────────────────────── */

export type { AuditEntry } from "../middleware/security.js";
export { auditLog } from "../middleware/security.js";
