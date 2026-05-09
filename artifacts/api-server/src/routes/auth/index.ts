import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { rotateRefreshToken, invalidateTokenFamily } from "../../services/auth/tokenRotation.js";
import { z } from "zod";
import { db } from "@workspace/db";
import { usersTable, walletTransactionsTable, notificationsTable, refreshTokensTable, magicLinkTokensTable, rateLimitsTable, pendingOtpsTable, userSessionsTable, loginHistoryTable, vendorProfilesTable, riderProfilesTable, totpRecoveryCodesTable } from "@workspace/db/schema";
import { eq, and, sql, lt, or, desc, ilike, isNull } from "drizzle-orm";
import { generateId } from "../../lib/id.js";
import { getPlatformSettings } from "../admin.js";
import { emitWebhookEvent } from "../../lib/webhook-emitter.js";
import {
  checkLockout,
  recordFailedAttempt,
  resetAttempts,
  addAuditEntry,
  addSecurityEvent,
  getClientIp,
  getCachedSettings,
  signUserJwt,
  signAccessToken,
  sign2faChallengeToken,
  verify2faChallengeToken,
  generateRefreshToken,
  hashRefreshToken,
  isRefreshTokenValid,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  verifyUserJwt,
  blacklistJti,
  writeAuthAuditLog,
  REFRESH_TOKEN_TTL_DAYS,
  getRefreshTokenTtlDays,
  ACCESS_TOKEN_TTL_SEC,
  getAccessTokenTtlSec,
  verifyCaptcha,
  checkAvailableRateLimit,
} from "../../middleware/security.js";
import { sendOtpSMS, isSMSProviderConfigured, isSMSConsoleActive } from "../../services/sms.js";
import { sendOtpWithFailover, getWhitelistBypass } from "../../services/smsGateway.js";
import { sendWhatsAppOTP, isWhatsAppProviderConfigured } from "../../services/whatsapp.js";
import { randomBytes, createHash, randomInt } from "crypto";
import { hashPassword, verifyPassword, validatePasswordStrength, generateSecureOtp } from "../../services/password.js";
import { generateTotpSecret, verifyTotpToken, generateQRCodeDataURL, getTotpUri, encryptTotpSecret, decryptTotpSecret } from "../../services/totp.js";
import { sendVerificationEmail, sendPasswordResetEmail, sendMagicLinkEmail, alertNewVendor, isEmailProviderConfigured } from "../../services/email.js";
import { encrypt, decrypt, isEncryptionAvailable } from "../../lib/crypto/encryption.js";
import { getUserLanguage, getPlatformDefaultLanguage } from "../../lib/getUserLanguage.js";
import { t, type TranslationKey } from "@workspace/i18n";
import { logger } from "../../lib/logger.js";
import { sendError, sendErrorWithData, sendUnauthorized, sendForbidden, sendNotFound, sendInternalError, sendTooManyRequests, sendSuccess, sendCreated } from "../../lib/response.js";
import { clearSpoofHits } from "../rider/index.js";
import { canonicalizePhone } from "@workspace/phone-utils";
import { isAuthMethodEnabled, isAuthMethodEnabledStrict } from "@workspace/auth-utils/server";
import { validateBody as sharedValidateBody } from "../../middleware/validate.js";
import { authLimiter, loginLimiter, otpLimiter } from "../../middleware/rate-limit.js";
import { SendOtpSchema, VerifyOtpSchema, UserLoginSchema } from "../../lib/validation/schemas.js";
import {
  RIDER_REFRESH_COOKIE,
  RIDER_REFRESH_COOKIE_PATH,
  VENDOR_REFRESH_COOKIE,
  VENDOR_REFRESH_COOKIE_PATH,
  hashOtp,
  normalizeVehicleTypeForStorage,
  generateVerificationToken,
  hashVerificationToken,
  isValidCanonicalPhone,
  isRiderSession,
  shouldUseSecureCookie,
  setRiderRefreshCookie,
  clearRiderRefreshCookie,
  setVendorRefreshCookie,
  clearVendorRefreshCookie,
} from "./helpers.js";

/* OTP rate limiting is handled per-account + per-IP inside the route handler
   using the admin-configurable settings (security_otp_max_per_phone,
   security_otp_max_per_ip, security_otp_window_min) via checkAndIncrOtpRateLimit(). */

/* ── OTP TTL ─────────────────────────────────────────────────
   All auth OTPs (phone, email, forgot-password) expire in 5 minutes.
   Account-merge OTPs use a longer 10-minute window.
   ──────────────────────────────────────────────────────────── */
const AUTH_OTP_TTL_MS = 5 * 60 * 1000;

/* ── Auth Zod schemas ─────────────────────────────────────────
   One schema per key endpoint. Extra/unknown fields are stripped.
   ──────────────────────────────────────────────────────────── */
const checkIdentifierSchema = z.object({
  identifier: z.string().min(3, "Identifier must be at least 3 characters"),
  role: z.enum(["customer", "rider", "vendor"]).optional(),
  deviceId: z.string().max(256).optional(),
}).strip();

const phoneSchema = z
  .string()
  .min(7, "Phone number is required")
  .max(20, "Phone number too long")
  .regex(/^[\d\s\-()+]{7,20}$/, "Phone number must contain only digits, spaces, dashes, or parentheses");

/* OTP / login schemas — consolidated aliases so all sharedValidateBody()
   call sites below continue to compile unchanged. */
const sendOtpSchema = SendOtpSchema;
const verifyOtpSchema = VerifyOtpSchema;
const loginSchema = UserLoginSchema;

/* Refresh tokens are carried exclusively as HttpOnly cookies (rider or vendor).
   Body-submitted refresh tokens are rejected unconditionally by the handler.
   This schema is kept minimal — the body field is not accepted. */
const refreshTokenSchema = z.object({}).strip();

function isVendorSession(req: Request, user?: { role?: string | null; roles?: string | null } | null): boolean {
  const body: Record<string, unknown> = (req.body && typeof req.body === "object")
    ? (req.body as Record<string, unknown>)
    : {};
  const bodyRole = typeof body.role === "string" ? body.role : undefined;
  if (bodyRole === "vendor") return true;
  const rolesStr = (user?.roles ?? user?.role ?? "") as string;
  if (!rolesStr) return false;
  return rolesStr.split(",").map((r) => r.trim()).includes("vendor");
}

const forgotPasswordSchema = z.object({
  phone: z.string().min(7).optional(),
  email: z.string().email("Invalid email address").optional(),
  identifier: z.string().min(3).optional(),
}).strip().refine(d => d.phone || d.email || d.identifier, {
  message: "Phone, email, or username is required",
  path: ["phone"],
});

const registerSchema = z.object({
  phone: z.string().min(7, "Phone number is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().max(80).optional(),
  role: z.enum(["customer", "rider", "vendor"]).optional(),
  email: z.string().email().optional().or(z.literal("")),
  username: z.string().min(3).max(20).regex(/^[a-z0-9_]+$/, "Username can only contain lowercase letters, numbers, and underscores").optional(),
  cnic: z.string().regex(/^\d{5}-\d{7}-\d{1}$/, "CNIC format must be XXXXX-XXXXXXX-X").optional().or(z.literal("")),
  nationalId: z.string().optional(),
  vehicleType: z.string().optional(),
  vehicleRegNo: z.string().optional(),
  drivingLicense: z.string().optional(),
  address: z.string().max(255).optional(),
  city: z.string().max(80).optional(),
  emergencyContact: z.string().optional(),
  vehiclePlate: z.string().optional(),
  vehiclePhoto: z.string().optional(),
  documents: z.string().optional(),
  businessName: z.string().max(120).optional(),
  businessType: z.string().optional(),
  storeAddress: z.string().max(255).optional(),
  ntn: z.string().optional(),
  storeName: z.string().max(120).optional(),
  captchaToken: z.string().optional(),
}).strip();

/** Encrypt a PII string when ENCRYPTION_MASTER_KEY is available; returns null silently if not. */
function tryEncrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    if (!isEncryptionAvailable()) return null;
    return encrypt(value);
  } catch {
    return null;
  }
}

/** Resolve a PII field: read from encrypted column first, fall back to plaintext for legacy rows. */
function decryptPii(encrypted: string | null | undefined, plaintext: string | null | undefined): string | null {
  if (encrypted) {
    try {
      if (isEncryptionAvailable()) return decrypt(encrypted);
    } catch {
      /* fall through to plaintext on decryption failure */
    }
  }
  return plaintext ?? null;
}


const router: IRouter = Router();

/* ── Pending TOTP secrets — two-phase setup, NOT written to DB until verified ──
   When a user calls GET /auth/2fa/setup we generate a secret and store it here
   in memory (keyed by userId, TTL 10 minutes) instead of immediately persisting
   it to the database. The DB write only happens after the user successfully
   verifies their first TOTP code in POST /auth/2fa/verify-setup (or /totp/enable).
   This prevents a half-initialised secret from sitting in the DB when the user
   never completes enrollment (e.g. they close the tab mid-setup). */
const pendingTotpSecrets = new Map<string, { secret: string; encryptedSecret: string; createdAt: number }>();
const PENDING_TOTP_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of pendingTotpSecrets.entries()) {
    if (now - entry.createdAt > PENDING_TOTP_TTL_MS) pendingTotpSecrets.delete(userId);
  }
}, 5 * 60 * 1000);

router.use(authLimiter);

/* ══════════════════════════════════════════════════════════════
   GET /auth/config
   Public endpoint — returns auth mode + enabled method flags so
   frontend apps can show/hide login UI panels without hardcoding.
   Also returns OTP bypass status for frontend UI notifications.
══════════════════════════════════════════════════════════════ */
router.get("/config", async (_req, res) => {
  try {
    const settings = await getCachedSettings();
    
    /* ── Check if OTP bypass is currently active (global) ── */
    const otpGlobalDisabledUntilStr = settings["otp_global_disabled_until"];
    const now = new Date();
    let otpBypassActive = false;
    let otpBypassExpiresAt: string | null = null;
    
    if (otpGlobalDisabledUntilStr) {
      try {
        const disabledUntil = new Date(otpGlobalDisabledUntilStr);
        if (disabledUntil > now) {
          otpBypassActive = true;
          otpBypassExpiresAt = disabledUntil.toISOString();
        }
      } catch (e) {
        logger.error({ error: e }, "[/auth/config] Failed to parse OTP bypass timestamp");
      }
    }
    
    const bypassMessage = settings["otp_bypass_message"] ?? null;
    
    sendSuccess(res, {
      auth_mode:             settings["auth_mode"]             ?? "OTP",
      firebase_enabled:      settings["firebase_enabled"]      ?? "off",
      auth_otp_enabled:      settings["auth_otp_enabled"]      ?? "on",
      auth_email_enabled:    settings["auth_email_enabled"]    ?? "on",
      auth_google_enabled:   settings["auth_google_enabled"]   ?? "on",
      auth_facebook_enabled: settings["auth_facebook_enabled"] ?? "off",
      otpBypassActive,
      otpBypassExpiresAt,
      bypassMessage,
    });
  } catch (e) {
    logger.error({ error: e }, "[/auth/config] Failed to get config");
    sendSuccess(res, { 
      auth_mode: "OTP", 
      firebase_enabled: "off", 
      auth_otp_enabled: "on", 
      auth_email_enabled: "on", 
      auth_google_enabled: "on", 
      auth_facebook_enabled: "off",
      otpBypassActive: false,
      otpBypassExpiresAt: null,
      bypassMessage: null,
    });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /auth/otp-status?phone=...
   Lightweight phone-specific bypass query for frontend apps.
   Runs the same bypass checks as send-otp (global setting,
   per-user otp_bypass_until, whitelist) without generating or
   sending an OTP.
   Returns { bypassActive, bypassExpiresAt, message }
══════════════════════════════════════════════════════════════ */
router.get("/otp-status", async (req, res) => {
  try {
    const rawPhone = (req.query.phone as string | undefined) ?? "";
    if (!rawPhone || rawPhone.length < 7) {
      sendError(res, "phone query parameter is required", 400);
      return;
    }

    const phone = canonicalizePhone(rawPhone);
    const settings = await getCachedSettings();
    const now = new Date();

    let bypassActive = false;
    let bypassExpiresAt: string | null = null;
    let message: string | null = (settings["otp_bypass_message"] as string | undefined) ?? null;

    /* Priority 1: per-user bypass */
    const [userRow] = await db
      .select({ otpBypassUntil: usersTable.otpBypassUntil })
      .from(usersTable)
      .where(eq(usersTable.phone, phone))
      .limit(1);

    if (userRow?.otpBypassUntil && userRow.otpBypassUntil > now) {
      bypassActive = true;
      bypassExpiresAt = userRow.otpBypassUntil.toISOString();
    }

    /* Priority 2: global OTP bypass flag */
    if (!bypassActive && settings["security_otp_bypass"] === "on") {
      bypassActive = true;
      bypassExpiresAt = null;
    }

    /* Priority 3: timed global disable */
    if (!bypassActive) {
      const disabledUntilStr = settings["otp_global_disabled_until"];
      if (disabledUntilStr) {
        const disabledUntil = new Date(disabledUntilStr);
        if (disabledUntil > now) {
          bypassActive = true;
          bypassExpiresAt = disabledUntil.toISOString();
        }
      }
    }

    /* Priority 4: whitelist bypass */
    if (!bypassActive) {
      const whitelistCode = await getWhitelistBypass(phone);
      if (whitelistCode !== null) {
        bypassActive = true;
        bypassExpiresAt = null;
        message = null;
      }
    }

    sendSuccess(res, { bypassActive, bypassExpiresAt, message });
  } catch (e) {
    logger.error({ error: e }, "[/auth/otp-status] Failed");
    sendSuccess(res, { bypassActive: false, bypassExpiresAt: null, message: null });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/check-identifier
   Unified Auth Gatekeeper — Account Discovery.
   Step 1 of the smart "Continue" login flow.
   Body: { identifier: string, role?: string, deviceId?: string }
   Returns what the client should do next: action + available methods.

   Rate-limited to 10 requests/min/IP to prevent phone number enumeration.
══════════════════════════════════════════════════════════════ */
const checkIdentifierLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many identifier checks. Please wait a minute before trying again." },
  validate: { xForwardedForHeader: false },
  keyGenerator: (req) => getClientIp(req),
});

router.post("/check-identifier", checkIdentifierLimiter, sharedValidateBody(checkIdentifierSchema), async (req, res) => {
  const { identifier, role, deviceId } = req.body;

  const ip          = getClientIp(req);
  const settings    = await getCachedSettings();
  const userRole    = (role === "rider" || role === "vendor") ? role : "customer";
  const registrationOpen = settings["feature_new_users"] !== "off";

  /* ── Normalise identifier — detect phone vs email vs username ── */
  let user: (typeof usersTable.$inferSelect) | undefined;

  const looksLikePhone = /^[\d\s\-+()]{7,15}$/.test(identifier.trim());
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim());

  if (looksLikePhone) {
    const phone = canonicalizePhone(identifier);
    const rows = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    user = rows[0];
  } else if (looksLikeEmail) {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, identifier.trim().toLowerCase())).limit(1);
    user = rows[0];
  } else {
    const rows = await db.select().from(usersTable).where(sql`lower(${usersTable.username}) = ${identifier.trim().toLowerCase()}`).limit(1);
    user = rows[0];
  }

  const exists    = !!user;
  const isNewUser = !exists;

  /* ── Phone / email enumeration hardening ─────────────────────────────────
     For phone/email identifiers we must return an IDENTICAL response whether
     the account exists, is banned, is locked, is Google-linked, or doesn't
     exist at all.  Any distinguishable response would let an attacker enumerate
     registered phone numbers.

     Security events are still logged server-side; actual enforcement (banned,
     locked, Google-linked) happens in /auth/verify-otp after OTP proof.

     Exception: username-based identifiers may safely reveal existence (the
     attacker must already know the username) and may show banned/locked there.

     Rule: for phone/email, always use the *request* role, never the DB user's
     role — the latter would differ between existing and non-existing records. ── */

  /* For username path only: surface banned/locked at check time (acceptable) */
  if (!looksLikePhone && !looksLikeEmail) {
    if (user?.isBanned) {
      addSecurityEvent({ type: "banned_user_identifier_check", ip, userId: user.id, details: `Banned user check: ${identifier}`, severity: "medium" });
      sendSuccess(res, { isBanned: true, action: "blocked", availableMethods: [] });
      return;
    }
    const maxAttempts    = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
    const lockoutMinutes = parseInt(settings["security_lockout_minutes"] ?? "30", 10);
    const lockoutKey     = identifier.trim();
    const lockout        = await checkLockout(lockoutKey, maxAttempts, lockoutMinutes);
    if (lockout.locked) {
      sendSuccess(res, { isLocked: true, lockedMinutes: lockout.minutesLeft, action: "locked", availableMethods: [] });
      return;
    }
  } else {
    /* Phone / email: log security events silently, never gate on them */
    if (user?.isBanned) {
      addSecurityEvent({ type: "banned_user_identifier_check", ip, userId: user.id, details: `Banned user phone/email check: ${identifier}`, severity: "medium" });
    }
  }

  /* ── Build available methods based on admin config + request role ──
     Use userRole (from request) for phone/email — never user?.role — so the
     response shape is identical for existing and non-existing identifiers. ── */
  const effectiveCheckRole = (looksLikePhone || looksLikeEmail) ? userRole : (user?.roles ?? userRole);
  const googleEnabled    = isAuthMethodEnabled(settings, "auth_google_enabled", effectiveCheckRole);
  const facebookEnabled  = isAuthMethodEnabled(settings, "auth_facebook_enabled", effectiveCheckRole);
  const phoneOtpEnabled  = isAuthMethodEnabled(settings, "auth_phone_otp_enabled", effectiveCheckRole);
  const emailOtpEnabled  = isAuthMethodEnabled(settings, "auth_email_otp_enabled", effectiveCheckRole);
  const passwordEnabled  = isAuthMethodEnabled(settings, "auth_username_password_enabled", effectiveCheckRole);
  const magicLinkEnabled = isAuthMethodEnabled(settings, "auth_magic_link_enabled", effectiveCheckRole);

  const availableMethods: string[] = [];
  if (phoneOtpEnabled)  availableMethods.push("phone_otp");
  if (emailOtpEnabled)  availableMethods.push("email_otp");
  if (passwordEnabled)  availableMethods.push("password");
  if (googleEnabled)    availableMethods.push("google");
  if (facebookEnabled)  availableMethods.push("facebook");
  if (magicLinkEnabled) availableMethods.push("magic_link");

  /* ── Phone / email enumeration hardening ─────────────────────────────────
     For phone and email identifiers we MUST NOT reveal whether an account
     exists.  Return a single generic action ("send_otp") for every phone/email,
     regardless of whether the account is new, existing, Google-linked, etc.
     Account state is only enforced inside /auth/verify-otp (after OTP proof).

     For username-based identifiers the threat model is different (the attacker
     must already know the username), so we can still route to "register" vs
     "login_password" there — but we never return social-linked flags. ── */
  let action: string;
  let noMethodReason: string | undefined;
  let responseAvailableMethods: string[] = availableMethods;

  if (looksLikePhone) {
    /* Always say "send OTP" — never distinguish new vs returning user */
    if (phoneOtpEnabled) {
      action = "send_phone_otp";
    } else {
      action = "no_method";
      noMethodReason = "phone_disabled";
    }
  } else if (looksLikeEmail) {
    if (emailOtpEnabled)       action = "send_email_otp";
    else if (magicLinkEnabled) action = "send_magic_link";
    else { action = "no_method"; noMethodReason = "email_disabled"; }
  } else {
    /* Username path: determine action from existence without leaking social links */
    const usableMethods = availableMethods.filter(m => {
      if (m === "password") return !!user?.passwordHash;
      return true;
    });
    responseAvailableMethods = exists ? usableMethods : availableMethods;

    if (!registrationOpen && !exists) {
      action = "registration_closed";
    } else if (!exists) {
      action = "register";
    } else if (passwordEnabled && user?.passwordHash) {
      action = "login_password";
    } else if (usableMethods.length > 0) {
      const first = usableMethods[0]!;
      action = first === "password" ? "login_password"
             : first === "phone_otp" ? "send_phone_otp"
             : first === "email_otp" ? "send_email_otp"
             : first === "magic_link" ? "send_magic_link"
             : "no_method";
      if (action === "no_method") noMethodReason = "all_disabled";
    } else {
      action = "no_method";
      noMethodReason = exists && !user?.passwordHash ? "password_disabled" : "all_disabled";
    }
  }

  const whatsappOn = settings["integration_whatsapp"] === "on";
  const smsOn      = phoneOtpEnabled;
  const otpChannels: string[] = [];
  if (whatsappOn) otpChannels.push("whatsapp");
  if (smsOn)      otpChannels.push("sms");

  sendSuccess(res, {
    registrationOpen,
    action,
    reason: noMethodReason,
    availableMethods: responseAvailableMethods,
    isBanned:  false,
    isLocked:  false,
    otpChannels,
  });
});

/* ─────────────────────────────────────────────────────────────
   POST /auth/send-merge-otp
   Send OTP for linking a new identifier to the authenticated user.
   Stores OTP on the authenticated user's record.
   Body: { identifier }
───────────────────────────────────────────────────────────── */
router.post("/send-merge-otp", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { identifier } = req.body;
  if (!identifier) { sendError(res, "Identifier is required", 400); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  const looksLikePhone = /^[\d\s\-+()]{7,15}$/.test(identifier.trim());
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim());

  if (!looksLikePhone && !looksLikeEmail) {
    sendError(res, "Identifier must be a phone number or email address", 400);
    return;
  }

  if (looksLikePhone) {
    const phone = canonicalizePhone(identifier);
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (existing) { sendError(res, "This phone number is already linked to another account", 409); return; }
  } else {
    const email = identifier.trim().toLowerCase();
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing) { sendError(res, "This email is already linked to another account", 409); return; }
  }

  const otp = generateSecureOtp();
  const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
  const normalizedIdentifier = looksLikePhone ? canonicalizePhone(identifier) : identifier.trim().toLowerCase();
  await db.update(usersTable).set({ mergeOtpCode: hashOtp(otp), mergeOtpExpiry: otpExpiry, pendingMergeIdentifier: normalizedIdentifier, updatedAt: new Date() }).where(eq(usersTable.id, auth.userId));

  if (looksLikePhone) {
    const phone = canonicalizePhone(identifier);
    const lang = await getUserLanguage(auth.userId);
    const whatsappEnabled = settings["integration_whatsapp"] === "on";
    let sent = false;
    if (whatsappEnabled) {
      const waResult = await sendWhatsAppOTP(phone, otp, settings, lang);
      if (waResult.sent) sent = true;
    }
    if (!sent) {
      const smsResult = await sendOtpSMS(phone, otp, settings, lang);
      sent = smsResult.sent;
    }
    const isDev = process.env.NODE_ENV !== "production";
    sendSuccess(res, undefined, "OTP sent to phone");
  } else {
    const email = identifier.trim().toLowerCase();
    const lang = await getUserLanguage(auth.userId);
    const [user] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
    await sendPasswordResetEmail(email, otp, user?.name ?? undefined, lang);
    sendSuccess(res, undefined, "OTP sent to email");
  }

  writeAuthAuditLog("merge_otp_sent", { ip, userId: auth.userId, userAgent: req.headers["user-agent"] ?? undefined, metadata: { identifier } });
});

/* ─────────────────────────────────────────────────────────────
   POST /auth/merge-account
   Link a new identifier (phone/email) to an authenticated user.
   Requires: valid JWT + OTP verification for the new identifier.
   Body: { identifier, otp }
───────────────────────────────────────────────────────────── */
router.post("/merge-account", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { identifier, otp } = req.body;
  if (!identifier || !otp) { sendError(res, "Identifier and OTP are required", 400); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  const looksLikePhone = /^[\d\s\-+()]{7,15}$/.test(identifier.trim());
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim());

  if (!looksLikePhone && !looksLikeEmail) {
    sendError(res, "Identifier must be a phone number or email address", 400);
    return;
  }

  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!currentUser) { sendNotFound(res, "User not found"); return; }

  const normalizedIdentifier = looksLikePhone ? canonicalizePhone(identifier) : identifier.trim().toLowerCase();

  if (currentUser.mergeOtpCode !== hashOtp(otp) || !currentUser.mergeOtpExpiry || currentUser.mergeOtpExpiry < new Date()) {
    sendError(res, "Invalid or expired OTP", 400);
    return;
  }

  if (currentUser.pendingMergeIdentifier !== normalizedIdentifier) {
    sendError(res, "OTP was not issued for this identifier", 400);
    return;
  }

  if (looksLikePhone) {
    const phone = normalizedIdentifier;
    if (currentUser.phone === phone) { sendError(res, "This phone is already linked to your account", 400); return; }

    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    if (existing) { sendError(res, "This phone number is already linked to another account", 409); return; }

    await db.update(usersTable).set({ phone, encryptedPhone: tryEncrypt(phone), mergeOtpCode: null, mergeOtpExpiry: null, phoneVerified: true, pendingMergeIdentifier: null, updatedAt: new Date() }).where(eq(usersTable.id, auth.userId));

    writeAuthAuditLog("account_merge_phone", { ip, userId: auth.userId, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone } });
    sendSuccess(res, { success: true, message: "Phone number linked successfully", linked: "phone" });
  } else {
    const email = normalizedIdentifier;
    if (currentUser.email === email) { sendError(res, "This email is already linked to your account", 400); return; }

    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing) { sendError(res, "This email is already linked to another account", 409); return; }

    await db.update(usersTable).set({ email, encryptedEmail: tryEncrypt(email), mergeOtpCode: null, mergeOtpExpiry: null, emailVerified: true, pendingMergeIdentifier: null, updatedAt: new Date() }).where(eq(usersTable.id, auth.userId));

    writeAuthAuditLog("account_merge_email", { ip, userId: auth.userId, userAgent: req.headers["user-agent"] ?? undefined, metadata: { email } });
    sendSuccess(res, { success: true, message: "Email linked successfully", linked: "email" });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /auth/send-otp
   Atomically upsert user by phone — one account per number.
───────────────────────────────────────────────────────────── */
router.post("/send-otp", otpLimiter, verifyCaptcha, sharedValidateBody(sendOtpSchema), async (req, res) => {
  const rawPhone = req.body.phone;
  const deviceId = req.body.deviceId;
  const preferredChannel = req.body.preferredChannel;
  const phone = canonicalizePhone(rawPhone);

  if (!(await isValidCanonicalPhone(phone))) {
    sendErrorWithData(res, "Invalid phone number. Please enter a valid Pakistani mobile number (e.g. 03001234567).", { field: "phone" }, 400);
    return;
  }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  const otpEnabled = isAuthMethodEnabled(settings, "auth_phone_otp_enabled");

  /* ── Look up existing user (not exposed in response — only used server-side) ── */
  const existingUser = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.phone, phone))
    .limit(1);

  const effectiveRole = existingUser[0]?.roles ?? ((req.body.role === "rider" || req.body.role === "vendor") ? req.body.role : "customer");
  const otpEnabledForRole = isAuthMethodEnabled(settings, "auth_phone_otp_enabled", effectiveRole);

  /* ── Phone enumeration hardening ─────────────────────────────────────────
     Do NOT return distinguishable errors for banned accounts, Google-linked
     accounts, or registration-closed states — all of these would reveal
     whether a phone number is registered.  Enforcement of these rules happens
     inside /auth/verify-otp (after the caller has proven OTP ownership).

     Exceptions that are acceptable to surface at send-otp:
       • lockout  — rate-limit response, keyed on the phone, not on account existence
       • invalid phone format — rejected before DB lookup
     Everything else: silently write OTP to pending_otps and return generic success. ── */

  /* ── Check lockout before generating new OTP ── */
  const maxAttempts = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
  const lockoutMinutes = parseInt(settings["security_lockout_minutes"] ?? "30", 10);
  const lockoutStatus = await checkLockout(phone, maxAttempts, lockoutMinutes);
  if (lockoutStatus.locked) {
    addSecurityEvent({ type: "locked_account_otp_request", ip, details: `OTP request for locked phone: ${phone}`, severity: "medium" });
    sendErrorWithData(res, `Account temporarily locked due to too many failed attempts. Please try again in ${lockoutStatus.minutesLeft} minute(s).`, { lockedMinutes: lockoutStatus.minutesLeft }, 429);
    return;
  }

  /* Log security events server-side without blocking the OTP flow */
  if (existingUser[0]?.isBanned) {
    addSecurityEvent({ type: "banned_user_otp_request", ip, details: `Banned user attempted OTP: ${phone}`, severity: "high" });
  }
  const existingGoogleId = existingUser[0]?.googleId;
  if (existingGoogleId && isAuthMethodEnabled(settings, "auth_google_enabled", existingUser[0]?.roles ?? effectiveRole)) {
    addSecurityEvent({ type: "otp_blocked_google_account", ip, details: `OTP attempt on Google-linked account: ${phone}`, severity: "low" });
  }

  /* ── Determine approval status for NEW users ── */
  const isNewUser = existingUser.length === 0;
  const requireApproval = (settings["user_require_approval"] ?? "off") === "on";
  const newUserApprovalStatus = isNewUser && requireApproval ? "pending" : "approved";

  /* ══ OTP DISABLED — return generic "use another method" without revealing account state ══ */
  if (!otpEnabled || !otpEnabledForRole) {
    sendForbidden(res, "Phone OTP is currently disabled. Please use another login method or contact support.");
    return;
  }
  /* ── Per-phone OTP resend cooldown (60 s) — prevents SMS bombing ── */
  const otpCooldownMs = parseInt(settings["security_otp_cooldown_sec"] ?? "60", 10) * 1000;
  const existingOtpExpiry = existingUser[0]?.otpExpiry;
  if (existingOtpExpiry) {
    const otpValidityMs = AUTH_OTP_TTL_MS;
    const issuedAgoMs   = otpValidityMs - (existingOtpExpiry.getTime() - Date.now());
    if (issuedAgoMs < otpCooldownMs) {
      const waitSec = Math.ceil((otpCooldownMs - issuedAgoMs) / 1000);
      addSecurityEvent({ type: "otp_resend_throttle", ip, details: `OTP resend too soon for ${phone} — ${waitSec}s remaining`, severity: "low" });
      sendErrorWithData(res, `Please wait ${waitSec} second(s) before requesting a new OTP.`, { retryAfterSeconds: waitSec }, 429);
      return;
    }
  }

  /* ── Per-account + per-IP OTP rate limit (admin-configurable window) ── */
  const otpRateCheck = await checkAndIncrOtpRateLimit({ identifier: phone, ip, settings });
  if (otpRateCheck.blocked) {
    const label = otpRateCheck.reason === "ip"
      ? "Too many OTP requests from your network"
      : "Too many OTP requests for this account";
    addSecurityEvent({ type: "otp_rate_limit_exceeded", ip, details: `${label} (${phone}) — retry in ${otpRateCheck.retryAfterSeconds}s`, severity: "medium" });
    sendErrorWithData(res, `${label}. Please wait ${otpRateCheck.retryAfterSeconds} second(s) before trying again.`, { retryAfterSeconds: otpRateCheck.retryAfterSeconds }, 429);
    return;
  }

  /* ── Per-user bypass (HIGHEST PRIORITY): skip all delivery if bypass is active ──
     When an admin has set a bypass window for an existing user, the next
     verify-otp call will succeed regardless of OTP code. We must NOT send
     any notification (SMS/WhatsApp/email) — return a generic success response.
     This path is non-enumerating: we only short-circuit for existing users
     with a valid bypass, and the response shape is identical to normal flow. ── */
  const existingBypass = !isNewUser && existingUser[0]?.otpBypassUntil && existingUser[0].otpBypassUntil > new Date();
  if (existingBypass) {
    // no user notification — bypass is silent by admin design
    writeAuthAuditLog("otp_send_bypassed", { ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone } });
    const bypassUntil = existingUser[0]!.otpBypassUntil!;
    sendSuccess(res, {
      otpRequired: false,
      bypass: true,
      expiresAt: bypassUntil.toISOString(),
      message: (settings["otp_bypass_message"] as string | undefined) ?? null,
      channel: "sms",
      fallbackChannels: [],
    });
    return;
  }

  /* ── Global OTP bypass: when enabled in Danger Zone, skip OTP for all users ── */
  if (settings["security_otp_bypass"] === "on") {
    writeAuthAuditLog("otp_send_global_bypassed", { ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone } });
    sendSuccess(res, {
      otpRequired: false,
      bypass: true,
      expiresAt: null,
      message: (settings["otp_bypass_message"] as string | undefined) ?? null,
      channel: "sms",
      fallbackChannels: [],
    });
    return;
  }

  /* ── Timed admin global OTP disable: auto-pass (no OTP delivery) ── */
  const otpGlobalDisabledUntilStrSend = settings["otp_global_disabled_until"];
  if (otpGlobalDisabledUntilStrSend) {
    const otpGlobalDisabledUntilSend = new Date(otpGlobalDisabledUntilStrSend);
    if (otpGlobalDisabledUntilSend > new Date()) {
      writeAuthAuditLog("otp_send_global_bypassed", { ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone, reason: "timed_disable" } });
      sendSuccess(res, {
        otpRequired: false,
        bypass: true,
        expiresAt: otpGlobalDisabledUntilSend.toISOString(),
        message: (settings["otp_bypass_message"] as string | undefined) ?? null,
        channel: "sms",
        fallbackChannels: [],
      });
      return;
    }
  }

  /* ── OTP Whitelist bypass — use bypass code and skip real SMS delivery ── */
  const whitelistBypass = await getWhitelistBypass(phone);
  const otp       = whitelistBypass ?? generateSecureOtp();
  const otpExpiry = new Date(Date.now() + AUTH_OTP_TTL_MS);

  if (isNewUser) {
    /* NEW USERS: store OTP in pending_otps — do NOT create a users record yet.
       The users record is only created after OTP is successfully verified. */
    await db
      .insert(pendingOtpsTable)
      .values({ id: generateId(), phone, otpHash: hashOtp(otp), otpExpiry })
      .onConflictDoUpdate({
        target: pendingOtpsTable.phone,
        set: { otpHash: hashOtp(otp), otpExpiry, attempts: 0 },
      });
  } else {
    /* EXISTING USERS: update OTP in the users table (login / resend flow) */
    await db
      .update(usersTable)
      .set({ otpCode: hashOtp(otp), otpExpiry, otpUsed: false, updatedAt: new Date() })
      .where(eq(usersTable.phone, phone));
  }

  /* If whitelisted, skip SMS entirely and return bypass shape */
  if (whitelistBypass) {
    writeAuthAuditLog("otp_send_whitelist_bypass", { ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone } });
    sendSuccess(res, {
      otpRequired: false,
      bypass: true,
      expiresAt: null,
      message: (settings["otp_bypass_message"] as string | undefined) ?? "OTP verification is temporarily bypassed for your number.",
    });
    return;
  }

  if (process.env.NODE_ENV === "development" && process.env["LOG_OTP"] === "1") {
    logger.info({ phone, otp }, "OTP sent");
  }

  const otpUserId = existingUser[0]?.id;
  const otpLang = otpUserId ? await getUserLanguage(otpUserId) : await getPlatformDefaultLanguage();

  const whatsappEnabled = settings["integration_whatsapp"] === "on";
  const emailEnabled    = isAuthMethodEnabled(settings, "auth_email_otp_enabled", effectiveRole);
  const userEmail       = existingUser[0]?.email;

  let deliveryChannel = "none";
  let deliverySuccess = false;
  let deliveryProvider = "";
  const smsEnabled = isAuthMethodEnabled(settings, "auth_phone_otp_enabled", effectiveRole);
  const availableChannels: string[] = [];
  if (whatsappEnabled) availableChannels.push("whatsapp");
  if (smsEnabled) availableChannels.push("sms");
  if (emailEnabled && userEmail) availableChannels.push("email");

  const channelOrder: string[] = [];
  if (preferredChannel && availableChannels.includes(preferredChannel)) {
    channelOrder.push(preferredChannel);
    for (const ch of availableChannels) { if (ch !== preferredChannel) channelOrder.push(ch); }
  } else {
    /* Use admin-configured channel priority order if set */
    const adminPriorityRaw = settings["otp_channel_priority"];
    const adminPriority = adminPriorityRaw
      ? adminPriorityRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
      : ["whatsapp", "sms", "email"];
    for (const ch of adminPriority) {
      if (ch === "whatsapp" && whatsappEnabled) channelOrder.push("whatsapp");
      else if (ch === "sms" && smsEnabled) channelOrder.push("sms");
      else if (ch === "email" && emailEnabled && userEmail) channelOrder.push("email");
    }
    /* Append any channels not covered by the admin order */
    if (!channelOrder.includes("whatsapp") && whatsappEnabled) channelOrder.push("whatsapp");
    if (!channelOrder.includes("sms") && smsEnabled) channelOrder.push("sms");
    if (!channelOrder.includes("email") && emailEnabled && userEmail) channelOrder.push("email");
  }

  /* ── Auto-bypass: no real delivery provider is configured ─────────────────
   * If none of SMS / WhatsApp / Email has working credentials, requiring OTP
   * would lock everyone out. We auto-bypass and log a warning so the admin
   * knows to configure a provider.
   * ----------------------------------------------------------------------- */
  const smsReady      = isSMSProviderConfigured(settings);
  const smsConsole    = isSMSConsoleActive(settings);   /* dev/staging fallback */
  const whatsappReady = isWhatsAppProviderConfigured(settings);
  const emailReady    = isEmailProviderConfigured(settings) && !!userEmail;

  /* Console mode counts as an active channel — OTP is logged to terminal */
  if (!smsReady && !smsConsole && !whatsappReady && !emailReady) {
    /* otp_require_when_no_provider = "on"  → block login (admin chose strict mode)
     * otp_require_when_no_provider = "off" (default) → auto-bypass               */
    const strictMode = settings["otp_require_when_no_provider"] === "on";
    if (strictMode) {
      logger.error({ phone }, "[OTP] No provider configured & strict mode ON — blocking login");
      writeAuthAuditLog("otp_send_no_provider", {
        ip,
        userAgent: req.headers["user-agent"] ?? undefined,
        metadata: { phone, reason: "no_provider_strict_block" },
      });
      sendErrorWithData(res, "OTP delivery is not configured. Please contact support.", { noProviderConfigured: true }, 503);
      return;
    }
    logger.warn({ phone }, "[OTP] No delivery provider configured — auto-bypassing OTP (bypass mode)");
    writeAuthAuditLog("otp_send_no_provider", {
      ip,
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { phone, reason: "no_delivery_provider_bypass" },
    });
    sendSuccess(res, {
      otpRequired: false,
      message: "OTP sent successfully",
      channel: "auto_bypass",
      fallbackChannels: [],
      noProviderConfigured: true,
    });
    return;
  }

  for (const channel of channelOrder) {
    if (channel === "whatsapp") {
      const waResult = await sendWhatsAppOTP(phone, otp, settings, otpLang);
      if (waResult.sent) { deliveryChannel = "whatsapp"; deliverySuccess = true; deliveryProvider = "whatsapp"; break; }
      logger.warn({ err: waResult.error }, "WhatsApp OTP failed, trying next channel");
    } else if (channel === "sms") {
      const smsResult = await sendOtpSMS(phone, otp, settings, otpLang);
      if (smsResult.sent) { deliveryChannel = "sms"; deliverySuccess = true; deliveryProvider = smsResult.provider ?? "sms"; break; }
      logger.warn({ err: smsResult.error }, "SMS OTP failed, trying next channel");
    } else if (channel === "email" && userEmail) {
      const emailLang = otpUserId ? await getUserLanguage(otpUserId) : await getPlatformDefaultLanguage();
      const emailResult = await sendPasswordResetEmail(userEmail, otp, existingUser[0]?.name ?? undefined, emailLang);
      if (emailResult.sent) { deliveryChannel = "email"; deliverySuccess = true; deliveryProvider = "email"; break; }
      logger.warn({ err: emailResult.reason }, "Email OTP failed");
    }
  }

  const isDev = process.env.NODE_ENV !== "production";
  const isConsoleDelivery = deliveryProvider === "console";

  if (!deliverySuccess) {
    if (isDev) {
      deliveryChannel = "dev";
      logger.warn({ phone }, "All OTP delivery channels failed — returning OTP in dev mode");
    } else {
      logger.error({ phone }, "All OTP delivery channels failed");
      sendErrorWithData(res, "Could not deliver OTP. Please try again or use an alternative login method.", { fallbackChannels: availableChannels }, 502);
      return;
    }
  }

  const fallbackChannels = availableChannels.filter(ch => ch !== deliveryChannel);

  writeAuthAuditLog("otp_sent", {
    userId: otpUserId,
    ip,
    userAgent: req.headers["user-agent"] ?? undefined,
    metadata: { phone, channel: deliveryChannel, result: "success" },
  });

  const response: Record<string, unknown> = {
    otpRequired: true,
    message: "OTP sent successfully",
    channel: deliveryChannel,
    fallbackChannels,
  };

  sendSuccess(res, response);
});

/* ─────────────────────────────────────────────────────────────
   POST /auth/verify-otp
   Validates the OTP, checks security settings, returns token.
───────────────────────────────────────────────────────────── */
router.post("/verify-otp", otpLimiter, verifyCaptcha, sharedValidateBody(verifyOtpSchema), async (req, res) => {
  const phone = canonicalizePhone(req.body.phone);

  if (!(await isValidCanonicalPhone(phone))) {
    sendErrorWithData(res, "Invalid phone number format.", { field: "phone" }, 400);
    return;
  }

  const { otp } = req.body;

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!isAuthMethodEnabled(settings, "auth_phone_otp_enabled")) {
    sendForbidden(res, "Phone OTP login is currently disabled.");
    return;
  }

  /* ── Global admin OTP temp-disable: auto-pass while active ── */
  const otpGlobalDisabledUntilStr = settings["otp_global_disabled_until"];
  const otpGlobalDisabledUntil = otpGlobalDisabledUntilStr ? new Date(otpGlobalDisabledUntilStr) : null;
  const isTimedGlobalDisableActive = !!(otpGlobalDisabledUntil && otpGlobalDisabledUntil > new Date());
  if (isTimedGlobalDisableActive) {
    addAuditEntry({ action: "user_login_timed_otp_disable_bypass", ip, details: `Timed global OTP disable active — auto-pass for ${phone}`, result: "success" });
    writeAuthAuditLog("login_global_otp_bypass", { ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone, reason: "timed_disable" } });
  }

  const maxAttempts    = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
  const lockoutMinutes = parseInt(settings["security_lockout_minutes"]    ?? "30", 10);

  /* ── Lockout check ── (skipped during global disable for emergency recovery) */
  const lockoutStatus = await checkLockout(phone, maxAttempts, lockoutMinutes);
  if (lockoutStatus.locked && !isTimedGlobalDisableActive) {
    addAuditEntry({ action: "verify_otp_lockout", ip, details: `Locked account OTP attempt: ${phone}`, result: "fail" });
    sendErrorWithData(res, `Account temporarily locked. Please try again in ${lockoutStatus.minutesLeft} minute(s).`, { lockedMinutes: lockoutStatus.minutesLeft }, 429);
    return;
  }

  /* ── Fetch user ── */
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.phone, phone))
    .limit(1);

  if (!user) {
    /* ── Cross-role new-user guard ──
       Riders and vendors must register through admin-controlled flows.
       Block auto-registration for these roles to prevent cross-app token issuance. */
    const requestedRoleForNew = req.body.role as string | undefined;
    if (requestedRoleForNew && requestedRoleForNew !== "customer") {
      sendErrorWithData(res, `No ${requestedRoleForNew} account found for this phone number. Please use the correct registration process or contact admin.`, { wrongApp: true }, 403);
      return;
    }

    /* ── NEW USER REGISTRATION PATH ──────────────────────────────────────────
       If the phone is not yet in usersTable, check pendingOtpsTable.
       This prevents phantom account creation — user records are only
       created AFTER successful OTP verification, not at send-otp time. */
    const [pending] = await db
      .select()
      .from(pendingOtpsTable)
      .where(eq(pendingOtpsTable.phone, phone))
      .limit(1);

    /* During global disable or whitelist bypass, allow new-user registration even
       with no pending OTP row (send-otp short-circuited and never created a pending entry). */
    const whitelistBypassNew = await getWhitelistBypass(phone);
    const globalBypassForNew = settings["security_otp_bypass"] === "on" || isTimedGlobalDisableActive || whitelistBypassNew !== null;
    if (!pending && !globalBypassForNew) {
      sendNotFound(res, "User not found. Please request a new OTP.");
      return;
    }

    /* Verify OTP from pending_otps — skip validation if global or whitelist bypass is enabled */
    const otpValid = globalBypassForNew || !!(pending && pending.otpHash === hashOtp(otp) && new Date() < pending.otpExpiry);
    if (!otpValid) {
      /* Increment failed attempts */
      const newAttempts = (pending.attempts ?? 0) + 1;
      await db.update(pendingOtpsTable)
        .set({ attempts: newAttempts })
        .where(eq(pendingOtpsTable.phone, phone));

      if (newAttempts >= maxAttempts) {
        await db.delete(pendingOtpsTable).where(eq(pendingOtpsTable.phone, phone));
        sendErrorWithData(res, `Too many failed attempts. Please request a new OTP.`, { lockedMinutes: 1 }, 429);
      } else {
        const remaining = maxAttempts - newAttempts;
        sendErrorWithData(res, `Invalid OTP. ${remaining > 0 ? `${remaining} attempt(s) remaining.` : "Please request a new OTP."}`, { attemptsRemaining: Math.max(0, remaining) }, 401);
      }
      return;
    }

    /* OTP valid — create user record now */
    const requireApproval = (settings["user_require_approval"] ?? "off") === "on";
    const deviceId = req.body.deviceId as string | undefined;
    const newUserId = generateId();
    await db.insert(usersTable).values({
      id:             newUserId,
      phone,
      encryptedPhone: tryEncrypt(phone),

      roles:          "customer",
      walletBalance:  "0",
      phoneVerified:  true,
      isActive:       !requireApproval,
      approvalStatus: requireApproval ? "pending" : "approved",
      ...(deviceId ? { deviceId } : {}),
    });

    /* Delete from pending_otps */
    await db.delete(pendingOtpsTable).where(eq(pendingOtpsTable.phone, phone));
    writeAuthAuditLog("otp_verified_new_user", { userId: newUserId, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone } });

    const signupBonus = parseFloat(settings["customer_signup_bonus"] ?? "0");
    if (signupBonus > 0) {
      await db.update(usersTable)
        .set({ walletBalance: sql`wallet_balance + ${signupBonus}` })
        .where(eq(usersTable.id, newUserId));
      await db.insert(walletTransactionsTable).values({
        id: generateId(), userId: newUserId, type: "bonus",
        amount: signupBonus.toFixed(2), description: "Welcome bonus — Thanks for joining!",
      });
    }

    const accessToken = signAccessToken(newUserId, phone, "customer", "customer", 0);
    const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
    await db.insert(refreshTokensTable).values({
      id: generateId(), userId: newUserId, tokenHash: refreshHash,
      authMethod: "phone_otp", expiresAt: new Date(Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000),
    });

    emitWebhookEvent("user_registered", { userId: newUserId, phone, role: "customer", method: "phone_otp" }).catch(() => {});

    /* New phone-OTP signups always create customer accounts, but the rider app
       can also send role=rider on the verify-otp call. The cookie helper
       checks both body role AND user roles so this is safe either way. */
    setRiderRefreshCookie(req, res, refreshRaw, { roles: "customer" });

    sendSuccess(res, {
      token: accessToken,
      refreshToken: refreshRaw,
      expiresAt: new Date(Date.now() + getAccessTokenTtlSec() * 1000).toISOString(),
      user: { id: newUserId, phone, name: null, email: null, username: null, roles: "customer",
              walletBalance: signupBonus, isActive: !requireApproval, totpEnabled: false },
      ...(requireApproval ? { pendingApproval: true } : {}),
    });
    return;
  }

  if (!isAuthMethodEnabled(settings, "auth_phone_otp_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Phone OTP login is currently disabled for your account type.");
    return;
  }

  /* ── Cross-role enforcement (non-customer apps only) ──
     For the customer app context, role enforcement happens AFTER OTP proof
     so the user can be offered the "add customer role" flow with a valid token.
     For rider/vendor apps, block immediately if role mismatch. ── */
  const requestedRole = req.body.role as string | undefined;
  const appIdHeader = req.headers["x-app-id"] as string | undefined;
  const appIdQuery = req.query.appId as string | undefined;
  const isCustomerAppContext = requestedRole === "customer" || appIdHeader === "customer" || appIdQuery === "customer";

  if (requestedRole && !isCustomerAppContext) {
    const userRoles = (user.roles || "customer").split(",").map((r: string) => r.trim());
    if (!userRoles.includes(requestedRole)) {
      addSecurityEvent({ type: "cross_role_login_attempt", ip, userId: user.id, details: `User with roles [${user.roles}] tried to log in as ${requestedRole}`, severity: "high" });
      sendErrorWithData(res, "This account is not registered as a " + requestedRole + ". Please use the correct app.", { wrongApp: true }, 403);
      return;
    }
  }

  /* ── Banned check ── */
  if (user.isBanned) {
    addSecurityEvent({ type: "banned_login_attempt", ip, userId: user.id, details: `Banned user tried to verify OTP: ${phone}`, severity: "high" });
    sendForbidden(res, "Your account has been suspended. Please contact support.");
    return;
  }

  /* ── Google-linked account: block OTP hijack ─────────────────────────────
     Enforcement moved here from send-otp to avoid leaking account existence.
     After OTP proof the caller is bound to this phone, so we can safely tell
     them to use Google instead without disclosing anything about other numbers. ── */
  if (user.googleId && isAuthMethodEnabled(await getCachedSettings(), "auth_google_enabled", user.roles ?? undefined)) {
    addSecurityEvent({ type: "otp_hijack_google_account", ip, userId: user.id, details: `OTP verify attempted on Google-linked account: ${phone}`, severity: "medium" });
    sendErrorWithData(res, "This account is linked to Google. Please sign in with Google.", { useGoogle: true }, 403);
    return;
  }

  /* ── Inactive check ──
     Pending-approval accounts are isActive=false but should NOT be blocked here;
     they need to pass OTP validation and receive the pendingApproval=true response.
     Check approvalStatus directly — the setting only controls NEW users, not existing pending ones. ── */
  const isPendingApproval = user.approvalStatus === "pending";
  if (!user.isActive && !isPendingApproval) {
    sendForbidden(res, "Your account is currently inactive. Please contact support.");
    return;
  }

  /* ── Admin OTP bypass check ──
     If an admin has set a timed bypass window for this user and it has not yet
     expired, skip OTP code validation but continue through the full post-OTP
     pipeline (approval check, 2FA challenge, token issuance) so all other
     security gates remain enforced. Bypass expires naturally via timestamp.
     no user notification — bypass is silent by admin design. ── */
  const otpBypassActive = !!(user.otpBypassUntil && user.otpBypassUntil > new Date());

  /* ── Global OTP bypass: when enabled in Danger Zone or during timed disable, accept any code for all users ── */
  const globalOtpBypass = settings["security_otp_bypass"] === "on" || isTimedGlobalDisableActive;

  /* ── Atomic OTP consumption via a single conditional UPDATE ──
     The WHERE clause combines: correct code + not-yet-used + not-expired.
     Concurrency-safe: only the first concurrent caller gets rows back. ── */
  const signupBonus = parseFloat(settings["customer_signup_bonus"] ?? "0");
  const now = new Date();

  let isActualFirstLogin = false;

  {
    const consumed = await db.transaction(async (tx) => {
      /* ── Per-user bypass path (HIGHEST PRIORITY): skip OTP code check, clear bypass flag (single-use) ── */
      if (otpBypassActive) {
        // no user notification — bypass is silent by admin design
        // clear bypass immediately after use so it cannot be reused
        await tx.update(usersTable)
          .set({ phoneVerified: true, lastLoginAt: now, updatedAt: now, otpBypassUntil: null })
          .where(eq(usersTable.phone, phone));
        addAuditEntry({ action: "user_login_otp_bypass", ip, details: `OTP bypass login for ${phone} (bypass until ${user.otpBypassUntil!.toISOString()})`, result: "success" });
        writeAuthAuditLog("login_otp_bypass", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone } });
        return { id: user.id, lastLoginAt: now };
      }

      /* ── Global bypass path: accept any OTP code when global bypass is enabled ── */
      if (globalOtpBypass) {
        // no user notification — global bypass is silent by admin design
        await tx.update(usersTable)
          .set({ phoneVerified: true, lastLoginAt: now, updatedAt: now })
          .where(eq(usersTable.phone, phone));
        addAuditEntry({ action: "user_login_global_otp_bypass", ip, details: `Global OTP bypass login for ${phone}`, result: "success" });
        /* Skip duplicate writeAuthAuditLog when timed disable already logged it above */
        if (!isTimedGlobalDisableActive) {
          writeAuthAuditLog("login_global_otp_bypass", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone } });
        }
        return { id: user.id, lastLoginAt: now };
      }

      /* ── Whitelist bypass path: accept any OTP code for whitelisted phones ── */
      const whitelistCode = await getWhitelistBypass(phone);
      if (whitelistCode !== null) {
        await tx.update(usersTable)
          .set({ phoneVerified: true, lastLoginAt: now, updatedAt: now })
          .where(eq(usersTable.phone, phone));
        addAuditEntry({ action: "user_login_whitelist_bypass", ip, details: `Whitelist bypass login for ${phone}`, result: "success" });
        writeAuthAuditLog("login_whitelist_bypass", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone } });
        return { id: user.id, lastLoginAt: now };
      }

      /* Single atomic UPDATE: marks OTP as used ONLY if code matches, unused, and unexpired.
         Returns the row if consumed, empty if already used / wrong code / expired. */
      const rows = await tx
        .update(usersTable)
        .set({ otpCode: null, otpExpiry: null, otpUsed: true, phoneVerified: true, lastLoginAt: now })
        .where(and(
          eq(usersTable.phone, phone),
          eq(usersTable.otpCode, hashOtp(otp)),
          eq(usersTable.otpUsed, false),
          sql`otp_expiry > now()`,
        ))
        .returning({ id: usersTable.id, lastLoginAt: usersTable.lastLoginAt });

      if (rows.length === 0) return null;

      /* This is the first login if lastLoginAt was NULL before we set it now.
         We detect first login by checking if no prior refresh tokens exist. */
      const [existingToken] = await tx.select({ id: refreshTokensTable.id })
        .from(refreshTokensTable)
        .where(eq(refreshTokensTable.userId, rows[0]!.id))
        .limit(1);
      isActualFirstLogin = !existingToken;

      /* Credit signup bonus only on verified first login */
      if (isActualFirstLogin && signupBonus > 0) {
        await tx
          .update(usersTable)
          .set({ walletBalance: sql`wallet_balance + ${signupBonus}` })
          .where(eq(usersTable.id, rows[0]!.id));
        await tx.insert(walletTransactionsTable).values({
          id: generateId(), userId: rows[0]!.id, type: "bonus",
          amount: signupBonus.toFixed(2),
          description: `Welcome bonus — Thanks for joining AJKMart!`,
        });
        const bonusLang = await getUserLanguage(rows[0]!.id);
        await tx.insert(notificationsTable).values({
          id: generateId(), userId: rows[0]!.id,
          title: t("notifWelcomeBonusTitle" as TranslationKey, bonusLang),
          body: t("notifWelcomeBonusBody" as TranslationKey, bonusLang).replace("{amount}", String(signupBonus)),
          type: "wallet", icon: "gift-outline",
        });
      }

      return rows[0];
    });

    if (!consumed) {
      /* OTP was wrong, already used, or expired — determine reason from fresh row */
      const [fresh] = await db.select({ otpUsed: usersTable.otpUsed, otpExpiry: usersTable.otpExpiry })
        .from(usersTable).where(eq(usersTable.phone, phone)).limit(1);

      if (fresh?.otpUsed) {
        writeAuthAuditLog("otp_reuse_attempt", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined });
        sendUnauthorized(res, "This OTP has already been used. Please request a new one.");
      } else if (!fresh?.otpExpiry || new Date() > fresh.otpExpiry) {
        writeAuthAuditLog("otp_expired", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined });
        sendUnauthorized(res, "OTP expired. Please request a new one.");
      } else {
        const updated = await recordFailedAttempt(phone, maxAttempts, lockoutMinutes);
        const remaining = maxAttempts - updated.attempts;
        addAuditEntry({ action: "verify_otp_failed", ip, details: `Wrong OTP for phone: ${phone}, attempt ${updated.attempts}/${maxAttempts}`, result: "fail" });
        writeAuthAuditLog("otp_failed", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined });
        if (updated.lockedUntil) {
          addSecurityEvent({ type: "account_locked", ip, userId: user.id, details: `Account locked after ${maxAttempts} failed OTP attempts`, severity: "high" });
          sendErrorWithData(res, `Too many failed attempts. Account locked for ${lockoutMinutes} minutes.`, { lockedMinutes: lockoutMinutes }, 429);
        } else {
          sendErrorWithData(res, `Invalid OTP. ${remaining > 0 ? `${remaining} attempt(s) remaining before lockout.` : "Next failure will lock your account."}`, { attemptsRemaining: Math.max(0, remaining) }, 401);
        }
      }
      return;
    }
  }

  await resetAttempts(phone);

  /* ── Re-fetch user to get latest data (wallet balance, name, etc.) ── */
  const [freshUser] = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
  const u = freshUser ?? user;

  /* ── Admin approval check ──
     approvalStatus is the source of truth; the setting only controls NEW user creation. ── */
  if (u.approvalStatus === "pending") {
    addAuditEntry({ action: "user_login_pending", ip, details: `Pending approval login for phone: ${phone}`, result: "pending" });
    const token = signAccessToken(u.id, phone, u.roles ?? "customer", u.roles ?? "customer", u.tokenVersion ?? 0);
    sendSuccess(res, {
      token, pendingApproval: true,
      message: "Aapka account admin approval ke liye bheja gaya hai. Approve hone par aap login kar sakenge.",
      user: { id: u.id, phone: u.phone, name: u.name, role: u.roles, roles: u.roles, approvalStatus: "pending" },
    });
    return;
  }
  if (u.approvalStatus === "rejected") {
    sendErrorWithData(res, "Aapka account reject kar diya gaya hai. Admin se rabta karein.", { code: "APPROVAL_REJECTED", approvalStatus: "rejected", rejectionReason: u.approvalNote ?? null }, 403);
    return;
  }

  /* ── 2FA challenge ── */
  if (u.totpEnabled && isAuthMethodEnabled(settings, "auth_2fa_enabled", u.roles ?? undefined)) {
    const deviceFingerprint = req.body.deviceFingerprint ?? "";
    const trustedDays = parseInt(settings["auth_trusted_device_days"] ?? "30", 10);
    if (!isDeviceTrusted(u, deviceFingerprint, trustedDays)) {
      const tempToken = sign2faChallengeToken(u.id, u.phone ?? "", u.roles ?? "customer", u.roles ?? "customer", "phone_otp");
      sendSuccess(res, { requires2FA: true, tempToken, userId: u.id }); return;
    }
  }

  addAuditEntry({ action: "user_login", ip, details: `Successful login for phone: ${phone} (role: ${u.roles})`, result: "success" });
  writeAuthAuditLog("otp_verified", { userId: u.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone, role: u.roles, method: "phone_otp", result: "success" } });
  writeAuthAuditLog("login_success", { userId: u.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone, role: u.roles, method: "phone_otp" } });

  /* ── Issue short-lived access token + long-lived refresh token ── */
  const accessToken  = signAccessToken(u.id, phone, u.roles ?? "customer", u.roles ?? "customer", u.tokenVersion ?? 0);
  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000);

  await db.insert(refreshTokensTable).values({
    id:        generateId(),
    userId:    u.id,
    tokenHash: refreshHash,
    authMethod: "phone_otp",
    expiresAt: refreshExpiresAt,
  });

  /* Clean up expired refresh tokens for this user (housekeeping) */
  db.delete(refreshTokensTable)
    .where(and(eq(refreshTokensTable.userId, u.id), lt(refreshTokensTable.expiresAt, new Date())))
    .catch(() => {});

  /* Set HttpOnly cookie for rider and vendor sessions. */
  setRiderRefreshCookie(req, res, refreshRaw, u);
  setVendorRefreshCookie(req, res, refreshRaw, u);

  /* ── Post-OTP customer app cross-role check ──
     If the customer app context was detected and the user doesn't have the
     customer role, return a token + canAddCustomerRole flag so the frontend
     can offer the "Add Customer Access" flow from the wrong-app screen. ── */
  const uRoles = (u.roles || "customer").split(",").map((r: string) => r.trim());
  if (isCustomerAppContext && !uRoles.includes("customer")) {
    addSecurityEvent({ type: "cross_role_login_attempt", ip, userId: u.id, details: `User with roles [${u.roles}] logged in to customer app context — offering add-role`, severity: "low" });
    sendSuccess(res, {
      token:        accessToken,
      refreshToken: refreshRaw,
      expiresAt:    new Date(Date.now() + getAccessTokenTtlSec() * 1000).toISOString(),
      sessionDays:  getRefreshTokenTtlDays(),
      canAddCustomerRole: true,
      code: "cross_app_account",
      wrongApp: true,
      user: {
        id:            u.id,
        phone:         u.phone,
        name:          u.name,
        email:         u.email,
        username:      u.username,
        role:          u.roles,
        roles:         u.roles ?? "customer",
        avatar:        u.avatar,
        walletBalance: parseFloat(u.walletBalance ?? "0"),
        isActive:      u.isActive,
        cnic:          u.cnic,
        city:          u.city,
        totpEnabled:   u.totpEnabled ?? false,
        createdAt:     u.createdAt.toISOString(),
      },
    });
    return;
  }

  const currentTermsVersion = settings["terms_version"] ?? "";
  const requiresTermsAcceptance = currentTermsVersion
    ? (u.acceptedTermsVersion ?? null) !== currentTermsVersion
    : false;

  sendSuccess(res, {
    token:        accessToken,
    refreshToken: refreshRaw,
    expiresAt:    new Date(Date.now() + getAccessTokenTtlSec() * 1000).toISOString(),
    sessionDays:  getRefreshTokenTtlDays(),
    requiresTermsAcceptance,
    user: {
      id:            u.id,
      phone:         u.phone,
      name:          u.name,
      email:         u.email,
      username:      u.username,
      role:          u.roles,
      roles:         u.roles ?? "customer",
      avatar:        u.avatar,
      walletBalance: parseFloat(u.walletBalance ?? "0"),
      isActive:      u.isActive,
      cnic:          u.cnic,
      city:          u.city,
      totpEnabled:   u.totpEnabled ?? false,
      acceptedTermsVersion: u.acceptedTermsVersion ?? null,
      createdAt:     u.createdAt.toISOString(),
    },
  });
});

/* ─────────────────────────────────────────────────────────────
   POST /auth/vendor-register
   Vendor signup: after phone OTP verified, submit store info
   and register as a vendor pending admin approval.
───────────────────────────────────────────────────────────── */
router.post("/vendor-register", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) {
    sendUnauthorized(res, "Authentication required. Please verify your phone via OTP first.");
    return;
  }

  const { storeName, storeCategory, name, cnic, address, city, bankName, bankAccount, bankAccountTitle, username, acceptedTermsVersion } = req.body;
  if (!storeName) {
    sendError(res, "Store name is required", 400);
    return;
  }

  if (username) {
    const normalizedUsername = String(username).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    if (normalizedUsername.length < 3) {
      sendError(res, "Username must be at least 3 characters", 400);
      return;
    }
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable)
      .where(sql`lower(${usersTable.username}) = ${normalizedUsername} AND ${usersTable.id} != ${auth.userId}`)
      .limit(1);
    if (existing) {
      sendError(res, "Username is already taken", 409);
      return;
    }
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!user) {
    sendNotFound(res, "User not found.");
    return;
  }

  if (!user.phoneVerified) {
    sendForbidden(res, "Phone number not verified. Please verify OTP first.");
    return;
  }

  const existingRoles = (user.roles || "").split(",").map((r: string) => r.trim()).filter(Boolean);
  if (existingRoles.includes("vendor")) {
    if (user.approvalStatus === "pending") {
      sendSuccess(res, { success: true, status: "pending", message: "Your vendor application is already pending admin approval." });
      return;
    }
    if (user.approvalStatus === "approved") {
      sendSuccess(res, { success: true, status: "approved", message: "You are already approved as a vendor." });
      return;
    }
  }

  const newRoles = existingRoles.includes("vendor") ? existingRoles : [...existingRoles, "vendor"];
  const settings = await getCachedSettings();
  const autoApprove = (settings["vendor_auto_approve"] ?? "off") === "on";

  await db.update(usersTable).set({
    roles: newRoles.join(","),
    name: name || user.name,
    username: username ? String(username).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) : user.username || null,
    cnic: cnic || user.cnic || null,
    address: address || user.address || null,
    city: city || user.city || null,
    bankName: bankName || user.bankName || null,
    bankAccount: bankAccount || user.bankAccount || null,
    bankAccountTitle: bankAccountTitle || user.bankAccountTitle || null,
    approvalStatus: autoApprove ? "approved" : "pending",
    isActive: autoApprove ? true : false,
    ...(acceptedTermsVersion ? { acceptedTermsVersion: String(acceptedTermsVersion) } : {}),
    updatedAt: new Date(),
  }).where(eq(usersTable.id, user.id));

  await db.insert(vendorProfilesTable).values({
    userId: user.id,
    storeName,
    storeCategory: storeCategory || null,
  }).onConflictDoUpdate({
    target: vendorProfilesTable.userId,
    set: { storeName, storeCategory: storeCategory || null },
  });

  if (acceptedTermsVersion) {
    try {
      const ip = getClientIp(req);
      await db.execute(sql`
        INSERT INTO consent_log (id, user_id, consent_type, consent_version, ip_address, created_at)
        VALUES (${generateId()}, ${user.id}, 'terms_acceptance', ${String(acceptedTermsVersion)}, ${ip}, NOW())
      `);
    } catch {}
  }

  await db.insert(notificationsTable).values({
    id: generateId(),
    userId: user.id,
    title: autoApprove ? "Welcome, Vendor! 🎉" : "Application Submitted ⏳",
    body: autoApprove
      ? "Your vendor account is approved! Start adding products and manage your store."
      : "Your vendor registration is pending admin approval. We'll notify you once approved.",
    type: "system",
    icon: autoApprove ? "checkmark-circle-outline" : "time-outline",
  }).catch(() => {});

  if (!autoApprove) {
    const admins = await db.select({ id: usersTable.id }).from(usersTable)
      .where(ilike(usersTable.roles, "%admin%"));
    const adminNotifs = admins.map(a => ({
      id: generateId(),
      userId: a.id,
      title: "New Vendor Application 📋",
      body: `${name || user.name || user.phone} has applied to become a vendor with store "${storeName}". Review and approve in the admin panel.`,
      type: "system" as const,
      icon: "storefront-outline",
    }));
    if (adminNotifs.length) {
      db.insert(notificationsTable).values(adminNotifs).catch(() => {});
    }
  }

  if (!autoApprove) {
    alertNewVendor(
      name || user.name || user.phone || "Unknown",
      user.phone || "N/A",
      storeName,
      settings,
    ).catch(() => {});
  }

  sendSuccess(res, {
    success: true,
    status: autoApprove ? "approved" : "pending",
    message: autoApprove
      ? "Your vendor account is approved! You can now log in."
      : "Your application has been submitted. Admin will review and approve your account.",
  });
});

/* ─────────────────────────────────────────────────────────────
   POST /auth/validate-token
   Client can use this to check if their token is still valid.
───────────────────────────────────────────────────────────── */
router.post("/validate-token", async (req, res) => {
  /* Support both body token and Authorization header */
  const authHeader = req.headers.authorization ?? "";
  const bodyToken  = req.body?.token ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : bodyToken;

  if (!token) { sendError(res, "token required", 400); return; }

  try {
    const payload = verifyUserJwt(token);
    if (!payload) { sendUnauthorized(res, "Invalid or expired token"); return; }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payload.userId)).limit(1);
    if (!user)         { sendUnauthorized(res, "User not found"); return; }
    if (user.isBanned) { sendForbidden(res, "Account suspended"); return; }
    if (!user.isActive){ sendForbidden(res, "Account inactive"); return; }

    if ((payload.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      sendUnauthorized(res, "Token revoked"); return;
    }

    const expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
    sendSuccess(res, { valid: true, expiresAt, userId: user.id, role: user.roles });
  } catch {
    sendUnauthorized(res, "Token validation failed");
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /auth/refresh
   Exchange a valid refresh token for a new access token.
   Body: { refreshToken }
   On success: returns { token, expiresAt }
   Refresh tokens are rotated on use (old one revoked, new one issued).
───────────────────────────────────────────────────────────── */
async function handleRefreshToken(req: Request, res: any) {
  /* Deterministically select the HttpOnly refresh cookie based on the app
     context signalled by the client via the X-App header (sent by vendor and
     rider builds). Falls back to body token for legacy/non-cookie clients.
     Cookie always wins over body to prevent accidental bypass. */
  const appHint = typeof req.headers["x-app"] === "string"
    ? (req.headers["x-app"] as string).toLowerCase()
    : "";
  const refreshCookies = (req.cookies && typeof req.cookies === "object")
    ? (req.cookies as Record<string, string>)
    : {};
  let cookieToken: string | undefined;
  if (appHint === "vendor") {
    cookieToken = refreshCookies[VENDOR_REFRESH_COOKIE] || refreshCookies[RIDER_REFRESH_COOKIE];
  } else {
    /* Rider (explicit or legacy default) */
    cookieToken = refreshCookies[RIDER_REFRESH_COOKIE] || refreshCookies[VENDOR_REFRESH_COOKIE];
  }
  /* Refresh tokens must arrive as HttpOnly cookies only. Body token submission
     is rejected unconditionally — in all environments — to prevent accidental
     token leakage via request logs, browser history, or CORS. */
  const ip = getClientIp(req);

  if (!cookieToken || cookieToken.length < 10) {
    sendError(res, "Refresh token required. Please log in again.", 400);
    return;
  }

  return doRefresh(cookieToken, ip, req, res);
}

/** Core refresh-token logic, extracted so cookie and dev-body paths share it. */
async function doRefresh(refreshToken: string, ip: string, req: Request, res: any) {
  const tokenHash = hashRefreshToken(refreshToken);

  /* ── Token family replay detection ── */
  let rt: typeof import("@workspace/db/schema").refreshTokensTable.$inferSelect;
  try {
    const { detectAndInvalidateFamily, TokenFamilyBreachError } = await import("../../services/auth/tokenRotation.js");
    rt = await detectAndInvalidateFamily(tokenHash);
  } catch (err: any) {
    if (err?.name === "TokenFamilyBreachError") {
      writeAuthAuditLog("token_family_breach", { userId: err.userId, ip, userAgent: req.headers["user-agent"] ?? undefined });
      sendUnauthorized(res, "Security breach detected. All sessions revoked. Please log in again.");
      return;
    }
    /* Token not found */
    writeAuthAuditLog("refresh_failed_not_found", { ip, userAgent: req.headers["user-agent"] ?? undefined });
    sendUnauthorized(res, "Invalid refresh token. Please log in again.");
    return;
  }

  /* Token reuse detected: already revoked but someone is trying to use it again.
     Invalidate the entire token family (possible token theft). */
  if (rt.revoked || rt.revokedAt) {
    if (rt.tokenFamilyId) {
      await invalidateTokenFamily(rt.tokenFamilyId, rt.userId, "SUSPICIOUS_FAMILY_REUSE", ip);
    } else {
      await revokeAllUserRefreshTokens(rt.userId, "REUSE_DETECTED");
    }
    writeAuthAuditLog("refresh_token_reuse", { userId: rt.userId, ip, userAgent: req.headers["user-agent"] ?? undefined });
    addSecurityEvent({ type: "refresh_token_reuse", ip, userId: rt.userId, details: "Refresh token reuse detected — token family invalidated", severity: "high" });
    sendUnauthorized(res, "Session invalidated for security. Please log in again.");
    return;
  }

  if (new Date() > rt.expiresAt) {
    await revokeRefreshToken(tokenHash, "EXPIRED");
    writeAuthAuditLog("refresh_token_expired", { userId: rt.userId, ip });
    sendUnauthorized(res, "Session expired. Please log in again.");
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, rt.userId)).limit(1);
  if (!user || user.isBanned || !user.isActive) {
    await revokeRefreshToken(tokenHash, "USER_UNAVAILABLE");
    sendUnauthorized(res, "Account not available. Please log in again.");
    return;
  }

  const settings = await getCachedSettings();
  const userRole = user.roles ?? "customer";

  const methodToSettingsKey: Record<string, string> = {
    phone_otp:      "auth_phone_otp_enabled",
    email_otp:      "auth_email_otp_enabled",
    password:       "auth_username_password_enabled",
    social_google:  "auth_google_enabled",
    social_facebook:"auth_facebook_enabled",
    magic_link:     "auth_magic_link_enabled",
  };

  const originalMethod = rt.authMethod;
  if (originalMethod && methodToSettingsKey[originalMethod]) {
    const settingsKey = methodToSettingsKey[originalMethod]!;
    const legacyKeys: Record<string, string> = {
      social_google:   "auth_social_google",
      social_facebook: "auth_social_facebook",
      magic_link:      "auth_magic_link",
    };
    const legacyKey = legacyKeys[originalMethod];
    const isEnabled = legacyKey
      ? isAuthMethodEnabledStrict(settings, settingsKey, legacyKey, userRole)
      : isAuthMethodEnabled(settings, settingsKey, userRole);
    if (!isEnabled) {
      await revokeRefreshToken(tokenHash, "AUTH_METHOD_DISABLED");
      sendForbidden(res, "Your login method has been disabled. Please log in again using an available method.");
      return;
    }
  } else {
    await revokeRefreshToken(tokenHash, "UNKNOWN_METHOD");
    sendForbidden(res, "Session expired. Please log in again.");
    return;
  }

  /* Rotate: revoke old token, issue new access + refresh token via the
     tokenRotation service which also handles token-family tracking. */
  const rotation = await rotateRefreshToken(
    rt,
    { id: user.id, phone: user.phone ?? null, roles: user.roles ?? null, tokenVersion: user.tokenVersion ?? null },
    ip,
  );

  writeAuthAuditLog("token_refresh", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined });

  /* Re-issue HttpOnly cookies with the rotated refresh token. The session
     checks use stored user roles (not req.body.role) so these fire correctly
     for refresh requests, which carry no role hint. */
  setRiderRefreshCookie(req, res, rotation.refreshToken, user);
  setVendorRefreshCookie(req, res, rotation.refreshToken, user);

  sendSuccess(res, {
    token:        rotation.accessToken,
    refreshToken: rotation.refreshToken,
    expiresAt:    rotation.expiresAt,
  });
}

router.post("/refresh", sharedValidateBody(refreshTokenSchema), handleRefreshToken);
router.post("/refresh-token", sharedValidateBody(refreshTokenSchema), handleRefreshToken);

/* ─────────────────────────────────────────────────────────────
   POST /auth/logout
   Revokes the refresh token and clears OTP. Client must discard tokens.
───────────────────────────────────────────────────────────── */
router.post("/logout", async (req, res) => {
  const authHeader = req.headers["authorization"] as string | undefined;
  const tokenHeader = req.headers["x-auth-token"] as string | undefined;
  const raw = tokenHeader || authHeader?.replace(/^Bearer\s+/i, "");
  /* Collect all refresh tokens across every source (body + rider cookie +
     vendor cookie) and revoke each unique one. This ensures logout is total
     regardless of which app context or cookie the client carried. */
  const logoutCookies = (req.cookies && typeof req.cookies === "object")
    ? (req.cookies as Record<string, string>)
    : {};
  const { refreshToken: bodyRefresh } = (req.body ?? {}) as { refreshToken?: string };
  const tokensToRevoke = new Set<string>(
    [bodyRefresh,
     logoutCookies[RIDER_REFRESH_COOKIE],
     logoutCookies[VENDOR_REFRESH_COOKIE]]
      .filter((t): t is string => typeof t === "string" && t.length >= 10)
  );
  const ip = getClientIp(req);

  if (raw) {
    const payload = verifyUserJwt(raw);
    if (payload) {
      /* Blacklist this specific jti in Redis so the token is immediately revoked
         even before tokenVersion takes effect (covers Redis-connected deployments). */
      if (payload.jti && payload.exp) {
        await blacklistJti(payload.jti, payload.exp).catch(() => {});
      }
      /* Increment tokenVersion to immediately invalidate ALL outstanding access JWTs for this user */
      await db.update(usersTable)
        .set({ otpCode: null, tokenVersion: sql`token_version + 1` })
        .where(eq(usersTable.id, payload.userId));
      /* Clear GPS spoof hit counter so next login starts with a clean session */
      clearSpoofHits(payload.userId);
      addAuditEntry({ action: "user_logout", ip, details: `User logout: ${payload.userId}`, result: "success" });
      writeAuthAuditLog("logout", { userId: payload.userId, ip, userAgent: req.headers["user-agent"] ?? undefined });
    }
  }

  /* Revoke all unique refresh tokens found across body + both app cookies */
  for (const tok of tokensToRevoke) {
    await revokeRefreshToken(hashRefreshToken(tok)).catch(() => {});
  }
  if (tokensToRevoke.size > 0) writeAuthAuditLog("token_revoked", { ip });

  /* Always clear both rider and vendor cookies on logout, even if the request
     did not carry them — defends against stale cookies after role/app switches. */
  clearRiderRefreshCookie(res);
  clearVendorRefreshCookie(res);

  sendSuccess(res, undefined, "Logged out successfully");
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/check-available
   Check if phone, email, or username is already taken.
   Body: { phone?, email?, username? }
   Returns: { phone: {available,taken}, email: {...}, username: {...} }
══════════════════════════════════════════════════════════════ */
router.post("/check-available", async (req, res) => {
  /* ── IP-based rate limit: max 20 checks per 10 minutes per IP ──
     Prevents scraping the entire user registry via phone/email/username probing. */
  const ip = getClientIp(req);
  const rlCheck = await checkAvailableRateLimit(ip, 20, 10);
  if (rlCheck.limited) {
    sendTooManyRequests(res, `Too many requests. Try again in ${rlCheck.minutesLeft} minute(s).`); return;
  }

  const { phone, email, username } = req.body;
  const result: Record<string, { available: boolean; message: string }> = {};

  if (phone) {
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    result.phone = existing
      ? { available: false, message: "Is number se pehle se ek account bana hua hai" }
      : { available: true,  message: "Available" };
  }

  if (email && email.length > 3) {
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email.toLowerCase().trim())).limit(1);
    result.email = existing
      ? { available: false, message: "Is email se pehle se ek account bana hua hai" }
      : { available: true,  message: "Available" };
  }

  if (username && username.length > 2) {
    const clean = username.toLowerCase().trim();
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(sql`lower(${usersTable.username}) = ${clean}`).limit(1);
    result.username = existing
      ? { available: false, message: "Yeh username pehle se liya hua hai. Koi aur try karein." }
      : { available: true,  message: "Available" };
  }

  sendSuccess(res, result);
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/send-email-otp
   Send OTP to email address (only for existing accounts with that email)
   Body: { email }
══════════════════════════════════════════════════════════════ */
router.post("/send-email-otp", verifyCaptcha, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) {
    sendError(res, "Valid email address required", 400); return;
  }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!isAuthMethodEnabled(settings, "auth_email_otp_enabled")) {
    sendForbidden(res, "Email OTP login is currently disabled.");
    return;
  }
  const normalized = email.toLowerCase().trim();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalized)).limit(1);
  if (!user) {
    const isDev = process.env.NODE_ENV !== "production";
    sendSuccess(res, { message: "If an account exists with this email, an OTP has been sent.", ...(isDev ? { hint: "No account found" } : {}) });
    return;
  }

  if (!isAuthMethodEnabled(settings, "auth_email_otp_enabled", user.roles ?? "customer")) {
    sendForbidden(res, "Email OTP login is currently disabled for your account type.");
    return;
  }

  if (user.isBanned) { sendForbidden(res, "Your account has been suspended."); return; }
  const isPendingEmail = user.approvalStatus === "pending";
  if (!user.isActive && !isPendingEmail) { sendForbidden(res, "Your account is inactive. Contact support."); return; }

  /* Lockout check using email as key */
  const maxAttempts = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
  const lockoutMinutes = parseInt(settings["security_lockout_minutes"] ?? "30", 10);
  const lockout = await checkLockout(normalized, maxAttempts, lockoutMinutes);
  if (lockout.locked) {
    sendTooManyRequests(res, `Too many attempts. Try again in ${lockout.minutesLeft} minute(s).`); return;
  }

  /* ── Per-email OTP resend cooldown — prevents inbox flooding ──
     Same 60-second window as the SMS OTP cooldown. */
  const otpCooldownMs   = parseInt(settings["security_otp_cooldown_sec"] ?? "60", 10) * 1000;
  const existingExpiry  = user.emailOtpExpiry;
  if (existingExpiry) {
    const otpValidityMs = AUTH_OTP_TTL_MS;
    const issuedAgoMs   = otpValidityMs - (existingExpiry.getTime() - Date.now());
    if (issuedAgoMs < otpCooldownMs) {
      const waitSec = Math.ceil((otpCooldownMs - issuedAgoMs) / 1000);
      addAuditEntry({ action: "email_otp_throttle", ip, details: `Email OTP resend too soon for ${normalized} — ${waitSec}s remaining`, result: "fail" });
      sendErrorWithData(res, `Please wait ${waitSec} second(s) before requesting a new email OTP.`, { retryAfterSeconds: waitSec }, 429);
      return;
    }
  }

  /* ── Per-account + per-IP OTP rate limit (admin-configurable window) ── */
  const emailRateCheck = await checkAndIncrOtpRateLimit({ identifier: normalized, ip, settings });
  if (emailRateCheck.blocked) {
    const label = emailRateCheck.reason === "ip"
      ? "Too many OTP requests from your network"
      : "Too many OTP requests for this email";
    addAuditEntry({ action: "email_otp_rate_limit", ip, details: `${label} (${normalized}) — retry in ${emailRateCheck.retryAfterSeconds}s`, result: "fail" });
    sendErrorWithData(res, `${label}. Please wait ${emailRateCheck.retryAfterSeconds} second(s) before trying again.`, { retryAfterSeconds: emailRateCheck.retryAfterSeconds }, 429);
    return;
  }

  const otp    = generateSecureOtp();
  const expiry = new Date(Date.now() + AUTH_OTP_TTL_MS);

  await db.update(usersTable)
    .set({ emailOtpCode: hashOtp(otp), emailOtpExpiry: expiry, updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  const isDev = process.env.NODE_ENV !== "production";
  logger.info({ email: normalized, otp: isDev ? otp : "[hidden]" }, "Email OTP generated");

  /* Send OTP via email service. Falls back gracefully when SMTP is not configured.
     In development, the OTP is also exposed in the response for easy testing. */
  const emailOtpLang = await getUserLanguage(user.id);
  const emailResult = await sendPasswordResetEmail(normalized, otp, user.name ?? undefined, emailOtpLang);

  if (!emailResult.sent) {
    if (isDev) {
      /* In development, log OTP to console so developers can see it */
      logger.info(`[EMAIL-OTP DEV] Email OTP for ${normalized}: ${otp} (SMTP not configured: ${emailResult.reason ?? "unknown"})`);
    } else {
      /* In production, use structured logger so the warning is captured properly */
      logger.warn({ email: normalized, reason: emailResult.reason ?? "SMTP not configured" }, "[EMAIL-OTP] Failed to send OTP email");
    }
  }

  addAuditEntry({ action: "email_otp_sent", ip, details: `Email OTP for: ${normalized} (delivered: ${emailResult.sent})`, result: "success" });

  const emailConsoleFallback = !emailResult.sent;
  sendSuccess(res, {
    message: "OTP aapki email par bhej diya gaya hai",
    channel: emailResult.sent ? "email" : "console",
    ...(isDev && emailConsoleFallback ? { otp, devMode: true } : {}),
  });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/verify-email-otp
   Login via email OTP. Body: { email, otp }
══════════════════════════════════════════════════════════════ */
router.post("/verify-email-otp", verifyCaptcha, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) { sendError(res, "Email and OTP are required", 400); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!isAuthMethodEnabled(settings, "auth_email_otp_enabled")) {
    sendForbidden(res, "Email OTP login is currently disabled.");
    return;
  }
  const normalized = email.toLowerCase().trim();

  const maxAttempts = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
  const lockoutMinutes = parseInt(settings["security_lockout_minutes"] ?? "30", 10);

  const lockout = await checkLockout(normalized, maxAttempts, lockoutMinutes);
  if (lockout.locked) {
    sendTooManyRequests(res, `Account locked. Try again in ${lockout.minutesLeft} minute(s).`); return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalized)).limit(1);
  if (!user) { sendNotFound(res, "Is email se koi account nahi mila."); return; }

  if (!isAuthMethodEnabled(settings, "auth_email_otp_enabled", user.roles ?? "customer")) {
    sendForbidden(res, "Email OTP login is currently disabled for your account type.");
    return;
  }

  /* Cross-role enforcement: rider/vendor apps send their role; reject mismatches.
     Customer app context is identified by X-App-Id header or role=customer body field.
     For customer app, enforcement happens post-OTP so user can be issued a token and
     offered the "Add Customer Access" flow from wrong-app screen. */
  const requestedEmailRole = req.body.role as string | undefined;
  const emailAppIdHeader = req.headers["x-app-id"] as string | undefined;
  const emailAppIdQuery = req.query.appId as string | undefined;
  const isEmailCustomerAppCtx = requestedEmailRole === "customer" || emailAppIdHeader === "customer" || emailAppIdQuery === "customer";
  if (requestedEmailRole && !isEmailCustomerAppCtx) {
    const userRolesEmail = (user.roles || "customer").split(",").map((r: string) => r.trim());
    if (!userRolesEmail.includes(requestedEmailRole)) {
      addSecurityEvent({ type: "cross_role_login_attempt", ip, userId: user.id, details: `User with roles [${user.roles}] tried email OTP login as ${requestedEmailRole}`, severity: "high" });
      sendErrorWithData(res, "This account is not registered as a " + requestedEmailRole + ". Please use the correct app.", { wrongApp: true }, 403); return;
    }
  }

  if (user.isBanned) { sendForbidden(res, "Account suspended. Contact support."); return; }
  const emailIsPending = user.approvalStatus === "pending";
  if (!user.isActive && !emailIsPending) { sendForbidden(res, "Account inactive. Contact support."); return; }

  /* ── Per-user OTP bypass (HIGHEST PRIORITY) ── */
  const emailPerUserBypass = !!(user.otpBypassUntil && user.otpBypassUntil > new Date());

  /* ── Global OTP bypass: danger-zone toggle OR timed suspension ── */
  const emailGlobalDisabledUntilStr = settings["otp_global_disabled_until"];
  const emailTimedSuspension = !!(emailGlobalDisabledUntilStr && new Date(emailGlobalDisabledUntilStr) > new Date());
  const emailGlobalBypass = settings["security_otp_bypass"] === "on" || emailTimedSuspension;

  const emailOtpBypassed = emailPerUserBypass || emailGlobalBypass;

  if (!emailOtpBypassed) {
    /* Check expiry FIRST — prevents timing oracle */
    if (user.emailOtpExpiry && new Date() > user.emailOtpExpiry) {
      sendUnauthorized(res, "OTP expired. Please request a new one."); return;
    }
  }

  if (!emailOtpBypassed && user.emailOtpCode !== hashOtp(otp)) {
    const updated = await recordFailedAttempt(normalized, maxAttempts, lockoutMinutes);
    const remaining = maxAttempts - updated.attempts;
    addAuditEntry({ action: "email_otp_failed", ip, details: `Wrong email OTP for: ${normalized}`, result: "fail" });
    if (updated.lockedUntil) {
      sendTooManyRequests(res, `Too many failed attempts. Locked for ${lockoutMinutes} minutes.`);
    } else {
      sendErrorWithData(res, `Invalid OTP. ${remaining} attempt(s) remaining.`, { attemptsRemaining: remaining }, 401);
    }
    return;
  }

  /* Check approval BEFORE touching the DB — a rejected user must not have their OTP cleared */
  if (user.approvalStatus === "rejected") {
    sendErrorWithData(res, "Account rejected. Contact admin.", { code: "APPROVAL_REJECTED", approvalStatus: "rejected", rejectionReason: user.approvalNote ?? null }, 403); return;
  }

  /* Clear email OTP + mark email verified + update last login */
  await db.update(usersTable)
    .set({ emailOtpCode: null, emailOtpExpiry: null, emailVerified: true, lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(usersTable.id, user.id));

  await resetAttempts(normalized);

  addAuditEntry({ action: "email_login", ip, details: `Email OTP login for: ${normalized}`, result: "success" });

  /* ── 2FA challenge ── */
  if (user.totpEnabled && isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    const deviceFingerprint = req.body.deviceFingerprint ?? "";
    const trustedDays = parseInt(settings["auth_trusted_device_days"] ?? "30", 10);
    if (!isDeviceTrusted(user, deviceFingerprint, trustedDays)) {
      const tempToken = sign2faChallengeToken(user.id, user.phone ?? "", user.roles ?? "customer", user.roles ?? "customer", "email_otp");
      sendSuccess(res, { requires2FA: true, tempToken, userId: user.id }); return;
    }
  }

  const isPendingApproval = user.approvalStatus === "pending";

  /* Issue short-lived access token + refresh token (consistent with OTP flow) */
  const accessToken = signAccessToken(user.id, user.phone ?? "", user.roles ?? "customer", user.roles ?? "customer", user.tokenVersion ?? 0);
  const expiresAt   = new Date(Date.now() + getAccessTokenTtlSec() * 1000).toISOString();

  if (isPendingApproval) {
    sendSuccess(res, {
      token: accessToken, expiresAt, pendingApproval: true,
      message: "Aapka account admin approval ke liye bheja gaya hai.",
      user: { id: user.id, phone: decryptPii(user.encryptedPhone, user.phone), name: user.name, role: user.roles, roles: user.roles, approvalStatus: "pending" },
    });
    return;
  }

  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000);
  await db.insert(refreshTokensTable).values({ id: generateId(), userId: user.id, tokenHash: refreshHash, authMethod: "email_otp", expiresAt: refreshExpiresAt });
  db.delete(refreshTokensTable).where(and(eq(refreshTokensTable.userId, user.id), lt(refreshTokensTable.expiresAt, new Date()))).catch(() => {});

  setRiderRefreshCookie(req, res, refreshRaw, user);
  setVendorRefreshCookie(req, res, refreshRaw, user);

  writeAuthAuditLog("login_success", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { method: "email_otp" } });

  /* Post-OTP customer app cross-role check: issue token + wrongApp flag so frontend
     can offer "Add Customer Access" flow from the wrong-app screen */
  const emailUserRoles = (user.roles || "customer").split(",").map((r: string) => r.trim());
  if (isEmailCustomerAppCtx && !emailUserRoles.includes("customer")) {
    addSecurityEvent({ type: "cross_role_login_attempt", ip, userId: user.id, details: `User with roles [${user.roles}] email-logged in to customer app context — offering add-role`, severity: "low" });
    sendSuccess(res, {
      token: accessToken, refreshToken: refreshRaw, expiresAt, sessionDays: getRefreshTokenTtlDays(),
      canAddCustomerRole: true, code: "cross_app_account", wrongApp: true,
      user: { id: user.id, phone: decryptPii(user.encryptedPhone, user.phone), name: user.name, email: decryptPii(user.encryptedEmail, user.email), username: user.username, role: user.roles, roles: user.roles ?? "customer", avatar: user.avatar, walletBalance: parseFloat(user.walletBalance ?? "0"), emailVerified: true, phoneVerified: user.phoneVerified ?? false },
    });
    return;
  }

  sendSuccess(res, {
    token:        accessToken,
    refreshToken: refreshRaw,
    expiresAt,
    sessionDays:  getRefreshTokenTtlDays(),
    pendingApproval: false,
    user: { id: user.id, phone: decryptPii(user.encryptedPhone, user.phone), name: user.name, email: decryptPii(user.encryptedEmail, user.email), username: user.username, role: user.roles, roles: user.roles ?? "customer", avatar: user.avatar, walletBalance: parseFloat(user.walletBalance ?? "0"), emailVerified: true, phoneVerified: user.phoneVerified ?? false },
  });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/login/username   (kept for backward-compat)
   POST /auth/login            (new unified endpoint)
   Unified identifier + password login (Binance-style).
   Accepts phone, email, OR username as `identifier` (or `username`).
   Body: { identifier, password } OR { username, password }
══════════════════════════════════════════════════════════════ */
function detectIdentifierType(raw: string): "phone" | "email" | "username" {
  if (raw.includes("@")) return "email";
  const cleaned = raw.replace(/[\s\-()]/g, "");
  if (/^\+?92\d{10}$/.test(cleaned) || /^0?3\d{9}$/.test(cleaned)) return "phone";
  if (/^\d{10,}$/.test(cleaned)) return "phone";
  return "username";
}

async function findUserByIdentifier(identifier: string) {
  const clean = identifier.toLowerCase().trim();
  const idType = detectIdentifierType(clean);

  if (idType === "phone") {
    const phone = canonicalizePhone(clean);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
    return { user: user ?? null, idType, lookupKey: phone };
  }
  if (idType === "email") {
    const [user] = await db.select().from(usersTable).where(sql`lower(${usersTable.email}) = ${clean}`).limit(1);
    return { user: user ?? null, idType, lookupKey: clean };
  }
  const [user] = await db.select().from(usersTable).where(sql`lower(${usersTable.username}) = ${clean}`).limit(1);
  return { user: user ?? null, idType, lookupKey: clean };
}

async function handleUnifiedLogin(req: Request, res: any) {
  const parsed = loginSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    sendErrorWithData(res, first?.message ?? "Invalid request body", { field: first?.path?.[0] ?? undefined }, 400);
    return;
  }
  const identifier = (parsed.data.identifier || parsed.data.username || "").trim();
  const { password } = parsed.data;
  if (!identifier) { sendError(res, "Identifier and password required", 400); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!isAuthMethodEnabled(settings, "auth_username_password_enabled")) {
    sendForbidden(res, "Password login is currently disabled.");
    return;
  }

  const { user, idType, lookupKey } = await findUserByIdentifier(identifier);

  const lockoutEnabled = (settings["security_lockout_enabled"] ?? "on") === "on";
  const maxAttempts = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
  const lockoutMinutes = parseInt(settings["security_lockout_minutes"] ?? "30", 10);

  const lockoutKey = user ? `uid:${user.id}` : lookupKey;

  if (lockoutEnabled) {
    const lockout = await checkLockout(lockoutKey, maxAttempts, lockoutMinutes);
    if (lockout.locked) {
      sendTooManyRequests(res, `Account locked. Try again in ${lockout.minutesLeft} minute(s).`); return;
    }
  }

  if (!user || !user.passwordHash) {
    if (lockoutEnabled) await recordFailedAttempt(lockoutKey, maxAttempts, lockoutMinutes);
    addAuditEntry({ action: "unified_login_failed", ip, details: `Not found or no password (${idType}): ${lookupKey}`, result: "fail" });
    sendUnauthorized(res, "Invalid credentials"); return;
  }

  if (!isAuthMethodEnabled(settings, "auth_username_password_enabled", user.roles ?? "customer")) {
    sendForbidden(res, "Password login is currently disabled for your account type.");
    return;
  }

  /* ── Cross-role enforcement ── */
  const requestedRoleLogin = parsed.data.role;
  if (requestedRoleLogin) {
    const userRolesLogin = (user.roles || "customer").split(",").map((r: string) => r.trim());
    if (!userRolesLogin.includes(requestedRoleLogin)) {
      addSecurityEvent({ type: "cross_role_login_attempt", ip, userId: user.id, details: `User with roles [${user.roles}] tried to log in as ${requestedRoleLogin}`, severity: "high" });
      sendErrorWithData(res, "This account is not registered as a " + requestedRoleLogin + ". Please use the correct app.", { wrongApp: true }, 403); return;
    }
  }

  if (user.isBanned) { sendForbidden(res, "Account suspended. Contact support."); return; }
  const isPendingApproval = user.approvalStatus === "pending";
  if (!user.isActive && !isPendingApproval) { sendForbidden(res, "Account inactive. Contact support."); return; }

  const passwordOk = verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    /* recordFailedAttempt is a no-op when admin toggle security_lockout_enabled='off' */
    const updated = await recordFailedAttempt(lockoutKey, maxAttempts, lockoutMinutes);
    addAuditEntry({ action: "unified_login_failed", ip, details: `Wrong password (${idType}): ${lookupKey}`, result: "fail" });
    if (lockoutEnabled && updated.lockedUntil) {
      sendTooManyRequests(res, `Too many failed attempts. Locked for ${lockoutMinutes} minutes.`);
    } else if (lockoutEnabled) {
      sendUnauthorized(res, `Invalid credentials. ${Math.max(0, maxAttempts - updated.attempts)} attempt(s) remaining.`);
    } else {
      sendUnauthorized(res, "Invalid credentials");
    }
    return;
  }

  if (user.approvalStatus === "rejected") {
    sendErrorWithData(res, "Account rejected. Contact admin.", { code: "APPROVAL_REJECTED", approvalStatus: "rejected", rejectionReason: user.approvalNote ?? null }, 403); return;
  }

  await resetAttempts(lockoutKey);
  addAuditEntry({ action: "unified_login", ip, details: `Login via ${idType}: ${lookupKey}`, result: "success" });

  /* ── OTP step after password verification ────────────────────────────────
     Priority: per-user bypass (skip OTP) → global suspension (skip OTP) → require OTP.
     OTP is sent to console for demo; in production this would go via SMS/email. ── */
  const pwPerUserBypass = !!(user.otpBypassUntil && user.otpBypassUntil > new Date());
  const pwGlobalDisabledUntilStr = settings["otp_global_disabled_until"];
  const pwGlobalDisabledUntil = pwGlobalDisabledUntilStr ? new Date(pwGlobalDisabledUntilStr) : null;
  const pwGlobalSuspended = !!(pwGlobalDisabledUntil && pwGlobalDisabledUntil > new Date());
  const pwDangerBypass = settings["security_otp_bypass"] === "on";
  const skipLoginOtp = pwPerUserBypass || pwGlobalSuspended || pwDangerBypass;

  if (!skipLoginOtp) {
    const loginOtp = generateSecureOtp();
    const loginOtpExpiry = new Date(Date.now() + 5 * 60 * 1000);
    await db.update(usersTable)
      .set({ otpCode: hashOtp(loginOtp), otpExpiry: loginOtpExpiry, otpUsed: false, updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));
    if (process.env.NODE_ENV !== 'production') {
      logger.info(`\n[AUTH:OTP] ====== LOGIN OTP ======`);
      logger.info(`[AUTH:OTP] User: ${lookupKey}`);
      logger.info(`[AUTH:OTP] OTP Code: ${loginOtp}`);
      logger.info(`[AUTH:OTP] Expires: ${loginOtpExpiry.toISOString()}`);
      logger.info(`[AUTH:OTP] =======================\n`);
    }
    writeAuthAuditLog("otp_sent", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { method: "password_login", channel: "console" } });
    const tempToken = sign2faChallengeToken(user.id, user.phone ?? user.email ?? "", user.roles ?? "customer", user.roles ?? "customer", "password_otp");
    sendSuccess(res, { requiresOtp: true, tempToken, userId: user.id, message: "OTP sent — check server console" });
    return;
  }

  if (pwPerUserBypass) {
    writeAuthAuditLog("login_otp_bypass", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { method: "password", reason: "per_user_bypass" } });
  } else if (pwGlobalSuspended || pwDangerBypass) {
    writeAuthAuditLog("login_global_otp_bypass", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { method: "password", reason: pwGlobalSuspended ? "global_suspension" : "danger_zone" } });
  }

  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));

  if (user.totpEnabled && isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    const deviceFingerprint = req.body.deviceFingerprint ?? "";
    const trustedDays = parseInt(settings["auth_trusted_device_days"] ?? "30", 10);
    if (!isDeviceTrusted(user, deviceFingerprint, trustedDays)) {
      const tempToken = sign2faChallengeToken(user.id, user.phone ?? "", user.roles ?? "customer", user.roles ?? "customer", "password");
      sendSuccess(res, { requires2FA: true, tempToken, userId: user.id }); return;
    }
  }

  const accessToken = signAccessToken(user.id, user.phone ?? "", user.roles ?? "customer", user.roles ?? "customer", user.tokenVersion ?? 0);
  const expiresAt   = new Date(Date.now() + getAccessTokenTtlSec() * 1000).toISOString();

  if (isPendingApproval) {
    sendSuccess(res, {
      token: accessToken, expiresAt, pendingApproval: true,
      message: "Aapka account admin approval ke liye bheja gaya hai.",
      user: { id: user.id, phone: decryptPii(user.encryptedPhone, user.phone), name: user.name, role: user.roles, roles: user.roles, approvalStatus: "pending" },
    });
    return;
  }

  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000);
  await db.insert(refreshTokensTable).values({ id: generateId(), userId: user.id, tokenHash: refreshHash, authMethod: "password", expiresAt: refreshExpiresAt });
  db.delete(refreshTokensTable).where(and(eq(refreshTokensTable.userId, user.id), lt(refreshTokensTable.expiresAt, new Date()))).catch(() => {});

  setRiderRefreshCookie(req, res, refreshRaw, user);
  setVendorRefreshCookie(req, res, refreshRaw, user);

  writeAuthAuditLog("login_success", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { method: `password_${idType}`, identifier: lookupKey } });

  sendSuccess(res, {
    token:        accessToken,
    refreshToken: refreshRaw,
    expiresAt,
    sessionDays:  getRefreshTokenTtlDays(),
    pendingApproval: false,
    identifierType: idType,
    requirePasswordChange: user.requirePasswordChange ?? false,
    user: { id: user.id, phone: decryptPii(user.encryptedPhone, user.phone), name: user.name, email: decryptPii(user.encryptedEmail, user.email), username: user.username, role: user.roles, roles: user.roles, avatar: user.avatar, walletBalance: parseFloat(user.walletBalance ?? "0"), emailVerified: user.emailVerified ?? false, phoneVerified: user.phoneVerified ?? false },
  });
}

router.post("/login/username", loginLimiter, verifyCaptcha, handleUnifiedLogin);
router.post("/login", loginLimiter, verifyCaptcha, handleUnifiedLogin);

/* ══════════════════════════════════════════════════════════════
   POST /auth/login/verify-otp
   Verify the OTP sent after email/password login.
   Body: { tempToken: string, otp: string }
   Returns JWT token on success.
══════════════════════════════════════════════════════════════ */
router.post("/login/verify-otp", async (req, res) => {
  const { tempToken, otp } = req.body ?? {};
  if (!tempToken || !otp) {
    sendError(res, "tempToken and otp are required", 400); return;
  }

  const payload = verify2faChallengeToken(tempToken);
  if (!payload || payload.authMethod !== "password_otp") {
    sendUnauthorized(res, "Invalid or expired OTP challenge token. Please log in again."); return;
  }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payload.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }
  if (user.isBanned) { sendForbidden(res, "Account suspended. Contact support."); return; }

  const lockoutEnabled = (settings["security_lockout_enabled"] ?? "on") === "on";
  const maxAttempts    = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
  const lockoutMinutes = parseInt(settings["security_lockout_minutes"]    ?? "30", 10);
  const lockoutKey     = `uid:${user.id}`;
  if (lockoutEnabled) {
    const lockout = await checkLockout(lockoutKey, maxAttempts, lockoutMinutes);
    if (lockout.locked) {
      sendTooManyRequests(res, `Account locked. Try again in ${lockout.minutesLeft} minute(s).`); return;
    }
  }

  const now = new Date();
  const rows = await db
    .update(usersTable)
    .set({ otpCode: null, otpExpiry: null, otpUsed: true, lastLoginAt: now, updatedAt: now })
    .where(and(
      eq(usersTable.id, user.id),
      eq(usersTable.otpCode, hashOtp(otp)),
      eq(usersTable.otpUsed, false),
      sql`otp_expiry > now()`,
    ))
    .returning({ id: usersTable.id });

  if (rows.length === 0) {
    /* recordFailedAttempt is a no-op when admin toggle security_lockout_enabled='off' */
    const updated = await recordFailedAttempt(lockoutKey, maxAttempts, lockoutMinutes);
    writeAuthAuditLog("otp_failed", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { method: "password_login_otp" } });
    if (lockoutEnabled && updated.lockedUntil) {
      sendTooManyRequests(res, `Too many failed attempts. Account locked for ${lockoutMinutes} minutes.`);
    } else if (lockoutEnabled) {
      const remaining = Math.max(0, maxAttempts - updated.attempts);
      sendErrorWithData(res, `Invalid or expired OTP. ${remaining} attempt(s) remaining.`, { attemptsRemaining: remaining }, 401);
    } else {
      sendUnauthorized(res, "Invalid or expired OTP.");
    }
    return;
  }

  await resetAttempts(lockoutKey);
  writeAuthAuditLog("otp_verified", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { method: "password_login_otp" } });

  if (user.totpEnabled && isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    const deviceFingerprint = req.body.deviceFingerprint ?? "";
    const trustedDays = parseInt(settings["auth_trusted_device_days"] ?? "30", 10);
    if (!isDeviceTrusted(user, deviceFingerprint, trustedDays)) {
      const totpToken = sign2faChallengeToken(user.id, user.phone ?? "", user.roles ?? "customer", user.roles ?? "customer", "password");
      sendSuccess(res, { requires2FA: true, tempToken: totpToken, userId: user.id }); return;
    }
  }

  const accessToken = signAccessToken(user.id, user.phone ?? "", user.roles ?? "customer", user.roles ?? "customer", user.tokenVersion ?? 0);
  const expiresAt   = new Date(Date.now() + getAccessTokenTtlSec() * 1000).toISOString();
  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  await db.insert(refreshTokensTable).values({
    id: generateId(), userId: user.id, tokenHash: refreshHash, authMethod: "password_otp",
    expiresAt: new Date(Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000),
  });

  setRiderRefreshCookie(req, res, refreshRaw, user);
  setVendorRefreshCookie(req, res, refreshRaw, user);

  writeAuthAuditLog("login_success", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { method: "password_otp_verified" } });

  sendSuccess(res, {
    token: accessToken,
    refreshToken: refreshRaw,
    expiresAt,
    sessionDays: getRefreshTokenTtlDays(),
    user: { id: user.id, phone: decryptPii(user.encryptedPhone, user.phone), name: user.name, email: decryptPii(user.encryptedEmail, user.email), username: user.username, role: user.roles, roles: user.roles, walletBalance: parseFloat(user.walletBalance ?? "0") },
  });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/complete-profile
   Set name, email, username, password for first-time setup.
   Requires valid JWT. Body: { token, name, email?, username?, password? }
══════════════════════════════════════════════════════════════ */
router.post("/complete-profile", async (req, res) => {
  /* Accept token from body OR Authorization: Bearer header */
  const authHeader = req.headers["authorization"] as string | undefined;
  const rawToken = req.body?.token || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);
  const { name, email, username, password, currentPassword, cnic, address, city, area, latitude, longitude, acceptedTermsVersion } = req.body;
  if (!rawToken) { sendUnauthorized(res, "Token required"); return; }

  /* Verify JWT to get userId */
  const payload = verifyUserJwt(rawToken);
  if (!payload) { sendUnauthorized(res, "Invalid or expired token. Please log in again."); return; }
  const userId = payload.userId;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user)         { sendNotFound(res, "User not found"); return; }
  if (user.isBanned) { sendForbidden(res, "Account suspended. Contact support."); return; }
  if (!user.isActive && user.approvalStatus !== "pending") {
    sendForbidden(res, "Account inactive. Contact support."); return;
  }

  const updates: Record<string, any> = { updatedAt: new Date() };

  if (name && name.trim().length > 1) {
    updates.name = name.trim();
  }

  if (email && email.includes("@")) {
    const normalized = email.toLowerCase().trim();
    /* Check email uniqueness (skip if it's already this user's email) */
    if (normalized !== user.email) {
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, normalized)).limit(1);
      if (existing && existing.id !== userId) {
        sendError(res, "Is email se pehle se ek account bana hua hai", 409); return;
      }
    }
    updates.email = normalized;
  }

  if (username && username.length > 2) {
    const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, "").trim();
    if (clean.length < 3) { sendError(res, "Username must be at least 3 characters (letters, numbers, underscore only)", 400); return; }
    if (clean !== user.username) {
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(sql`lower(${usersTable.username}) = ${clean}`).limit(1);
      if (existing && existing.id !== userId) {
        sendError(res, "Yeh username pehle se liya hua hai", 409); return;
      }
    }
    updates.username = clean;
  }

  if (cnic && cnic.trim()) {
    const cnicClean = cnic.trim();
    if (CNIC_REGEX.test(cnicClean)) {
      updates.cnic = cnicClean;
      updates.nationalId = cnicClean;
    }
  }

  if (address && typeof address === "string" && address.trim()) {
    updates.address = address.trim();
  }
  if (city && typeof city === "string" && city.trim()) {
    updates.city = city.trim();
  }
  if (area && typeof area === "string" && area.trim()) {
    updates.area = area.trim();
  }
  if (latitude && typeof latitude === "string") {
    updates.latitude = latitude;
  }
  if (longitude && typeof longitude === "string") {
    updates.longitude = longitude;
  }

  if (password && password.length >= 8) {
    if (user.passwordHash) {
      if (!currentPassword) {
        sendError(res, "Current password required to change password", 400); return;
      }
      if (!verifyPassword(currentPassword, user.passwordHash)) {
        sendUnauthorized(res, "Current password galat hai"); return;
      }
    }
    const check = validatePasswordStrength(password);
    if (!check.ok) { sendError(res, check.message, 400); return; }
    updates.passwordHash = hashPassword(password);
  }

  const hasName = updates.name || user.name;
  const hasEmail = updates.email || user.email;
  const hasAddress = updates.address || user.address;
  const hasCity = updates.city || user.city;
  const hasCnic = updates.cnic || user.cnic;
  const hasPassword = updates.passwordHash || user.passwordHash;
  const filledCount = [hasName, hasEmail, hasAddress, hasCity, hasCnic, hasPassword].filter(Boolean).length;
  let newLevel = "bronze";
  if (filledCount >= 5 && hasCnic) newLevel = "gold";
  else if (filledCount >= 3) newLevel = "silver";
  updates.accountLevel = newLevel;

  if (acceptedTermsVersion && typeof acceptedTermsVersion === "string") {
    updates.acceptedTermsVersion = acceptedTermsVersion;
  } else {
    /* Auto-assign current termsVersion if not provided and this is first profile completion */
    try {
      const s = await getCachedSettings();
      const currentTermsVer = s["terms_version"] ?? "";
      if (currentTermsVer && !user.acceptedTermsVersion) {
        updates.acceptedTermsVersion = currentTermsVer;
      }
    } catch {}
  }

  if (Object.keys(updates).length === 1) {
    sendError(res, "Koi update nahi kiya — name, email, username ya password provide karein", 400); return;
  }

  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, userId)).returning();

  if ((updates as any).acceptedTermsVersion) {
    try {
      const ip = getClientIp(req);
      await db.execute(sql`
        INSERT INTO consent_log (id, user_id, consent_type, consent_version, ip_address, created_at)
        VALUES (${generateId()}, ${userId}, 'terms_acceptance', ${(updates as any).acceptedTermsVersion}, ${ip}, NOW())
      `);
    } catch {}
  }

  const accessToken = signAccessToken(updated!.id, updated!.phone ?? "", updated!.roles ?? "customer", updated!.roles ?? "customer", updated!.tokenVersion ?? 0);
  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000);

  await db.insert(refreshTokensTable).values({
    id:        generateId(),
    userId:    updated!.id,
    tokenHash: refreshHash,
    authMethod: "password",
    expiresAt: refreshExpiresAt,
  });

  db.delete(refreshTokensTable)
    .where(and(eq(refreshTokensTable.userId, updated!.id), lt(refreshTokensTable.expiresAt, new Date())))
    .catch(() => {});

  setRiderRefreshCookie(req, res, refreshRaw, updated);
  setVendorRefreshCookie(req, res, refreshRaw, updated);

  sendSuccess(res, {
    success: true,
    message: "Profile update ho gaya",
    token: accessToken,
    refreshToken: refreshRaw,
    user: { id: updated!.id, phone: updated!.phone, name: updated!.name, email: updated!.email, username: updated!.username, role: updated!.roles, roles: updated!.roles, avatar: updated!.avatar, cnic: updated!.cnic, city: updated!.city, area: updated!.area, address: updated!.address, latitude: updated!.latitude, longitude: updated!.longitude, kycStatus: updated!.kycStatus, accountLevel: updated!.accountLevel, totpEnabled: updated!.totpEnabled ?? false, emailVerified: updated!.emailVerified, phoneVerified: updated!.phoneVerified, walletBalance: parseFloat(updated!.walletBalance ?? "0"), isActive: updated!.isActive, createdAt: updated!.createdAt.toISOString() },
  });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/set-password
   Set or change password. Body: { token, password, currentPassword? }
══════════════════════════════════════════════════════════════ */
router.post("/set-password", async (req, res) => {
  /* Accept token from body OR Authorization: Bearer header */
  const authHeader = req.headers["authorization"] as string | undefined;
  const rawToken = req.body?.token || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);
  const { password, currentPassword } = req.body;
  if (!rawToken || !password) { sendError(res, "Token and password required", 400); return; }

  const payload = verifyUserJwt(rawToken);
  if (!payload) { sendUnauthorized(res, "Invalid or expired token. Please log in again."); return; }
  const userId = payload.userId;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user)         { sendNotFound(res, "User not found"); return; }
  if (user.isBanned) { sendForbidden(res, "Account suspended. Contact support."); return; }
  if (!user.isActive){ sendForbidden(res, "Account inactive. Contact support."); return; }

  /* If user has a non-temporary password, ALWAYS require the current password — no bypass.
     If requirePasswordChange is true (admin set a temp password), skip current-password
     check to allow the user to change it on first login without knowing the old hash. */
  const isTempPasswordChange = user.requirePasswordChange === true;
  if (user.passwordHash && !isTempPasswordChange) {
    if (!currentPassword) {
      sendError(res, "Current password required to change password", 400); return;
    }
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      sendUnauthorized(res, "Current password galat hai"); return;
    }
  }

  const check = validatePasswordStrength(password);
  if (!check.ok) { sendError(res, check.message, 400); return; }

  /* Bump tokenVersion to invalidate all outstanding JWTs on password change;
     also clear requirePasswordChange now that the user has set their own password. */
  await db.update(usersTable).set({
    passwordHash: hashPassword(password),
    requirePasswordChange: false,
    tokenVersion: sql`token_version + 1`,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, userId));
  writeAuthAuditLog("password_changed", { userId, ip: getClientIp(req), userAgent: req.headers["user-agent"] ?? undefined });
  sendSuccess(res, { success: true, message: "Password set ho gaya", requirePasswordChange: false });
});

/* isAuthMethodEnabled is now exported from @workspace/auth-utils/server
   so the same logic is shared with any future server-side helpers. */

/* ══════════════════════════════════════════════════════════════════════
   OTP Rate Limiter — per account (phone/email) + per IP address
   Uses rateLimitsTable with sliding window (resets after window expires).
   Keys: otp_acct:<identifier>  and  otp_ip:<ip>
══════════════════════════════════════════════════════════════════════ */
async function checkAndIncrOtpRateLimit(params: {
  identifier: string;
  ip:         string;
  settings:   Record<string, string>;
}): Promise<{ blocked: true; retryAfterSeconds: number; reason: "account" | "ip" } | { blocked: false }> {
  const maxPerAcct = Math.max(1, parseInt(params.settings["security_otp_max_per_phone"] ?? "5",  10));
  const maxPerIp   = Math.max(1, parseInt(params.settings["security_otp_max_per_ip"]    ?? "10", 10));
  const windowMin  = Math.max(1, parseInt(params.settings["security_otp_window_min"]     ?? "60", 10));
  const windowMs   = windowMin * 60 * 1000;
  const now        = new Date();

  async function checkOne(
    key: string,
    max: number,
  ): Promise<{ blocked: true; retryAfterSeconds: number } | { blocked: false }> {
    const rows = await db.select().from(rateLimitsTable).where(eq(rateLimitsTable.key, key)).limit(1);
    const row  = rows[0];
    const windowExpired = !row || (now.getTime() - row.windowStart.getTime()) >= windowMs;

    if (windowExpired) {
      /* Reset (or create) the window and count this as 1 request */
      await db
        .insert(rateLimitsTable)
        .values({ key, attempts: 1, windowStart: now, updatedAt: now })
        .onConflictDoUpdate({
          target: rateLimitsTable.key,
          set:    { attempts: 1, windowStart: now, updatedAt: now },
        });
      return { blocked: false };
    }

    if (row.attempts >= max) {
      const windowEndsAt       = row.windowStart.getTime() + windowMs;
      const retryAfterSeconds  = Math.max(1, Math.ceil((windowEndsAt - now.getTime()) / 1000));
      return { blocked: true, retryAfterSeconds };
    }

    await db
      .update(rateLimitsTable)
      .set({ attempts: row.attempts + 1, updatedAt: now })
      .where(eq(rateLimitsTable.key, key));
    return { blocked: false };
  }

  /* 1. Per-account limit */
  const acctResult = await checkOne(`otp_acct:${params.identifier}`, maxPerAcct);
  if (acctResult.blocked) return { blocked: true, retryAfterSeconds: acctResult.retryAfterSeconds, reason: "account" };

  /* 2. Per-IP limit */
  const ipResult = await checkOne(`otp_ip:${params.ip}`, maxPerIp);
  if (ipResult.blocked) return { blocked: true, retryAfterSeconds: ipResult.retryAfterSeconds, reason: "ip" };

  return { blocked: false };
}

/* isAuthMethodEnabledStrict is now imported from @workspace/auth-utils/server
   above (see top of file). The previous local implementation has been removed. */

const CNIC_REGEX = /^\d{5}-\d{7}-\d{1}$/;
const PHONE_REGEX = /^0?3\d{9}$/;

router.post("/register", verifyCaptcha, sharedValidateBody(registerSchema), async (req, res) => {
  const { phone, password, name, role, cnic, nationalId, email, username,
          vehicleType, vehicleRegNo, drivingLicense,
          address, city, emergencyContact, vehiclePlate, vehiclePhoto, documents,
          businessName, businessType, storeAddress, ntn, storeName } = req.body;

  const ip = getClientIp(req);
  const settings = await getCachedSettings();
  const userRole = (role === "rider" || role === "vendor") ? role : "customer";

  if (settings["feature_new_users"] === "off") {
    sendForbidden(res, "New user registration is currently disabled.");
    return;
  }

  /* Per-role registration kill-switch (admin panel: Vendor Registration / Rider Registration).
     When the admin sets vendor_registration or rider_registration to "off",
     the corresponding role cannot complete signup even if phone OTP is on. */
  if (userRole === "vendor" && (settings["vendor_registration"] ?? "on") === "off") {
    sendForbidden(res, "Vendor registration is currently closed by the administrator.");
    return;
  }
  if (userRole === "rider" && (settings["rider_registration"] ?? "on") === "off") {
    sendForbidden(res, "Rider registration is currently closed by the administrator.");
    return;
  }

  if (!isAuthMethodEnabled(settings, "auth_phone_otp_enabled", userRole)) {
    sendForbidden(res, "Phone registration is currently disabled for this role.");
    return;
  }

  if (!phone) {
    sendError(res, "Phone number is required", 400);
    return;
  }
  const cleanedPhone = phone.replace(/[\s\-()]/g, "");
  if (!PHONE_REGEX.test(cleanedPhone)) {
    sendError(res, "Invalid phone number. Use format: 03XXXXXXXXX", 400);
    return;
  }

  if (!password) {
    sendError(res, "Password is required", 400);
    return;
  }
  const pwCheck = validatePasswordStrength(password);
  if (!pwCheck.ok) {
    sendError(res, pwCheck.message, 400);
    return;
  }

  const cnicValue = cnic || nationalId;
  if (cnicValue && !CNIC_REGEX.test(cnicValue)) {
    sendError(res, "CNIC format must be XXXXX-XXXXXXX-X", 400);
    return;
  }

  if (userRole === "rider") {
    if (!cnicValue) { sendError(res, "CNIC is required for rider registration", 400); return; }
    if (!vehicleType) { sendError(res, "Vehicle type is required for rider registration", 400); return; }
  }

  if (userRole === "vendor") {
    if (!businessName && !storeName) { sendError(res, "Business/store name is required for vendor registration", 400); return; }
  }

  const normalizedPhone = canonicalizePhone(phone);
  const [existingReg] = await db.select().from(usersTable).where(and(eq(usersTable.phone, normalizedPhone), isNull(usersTable.deletedAt))).limit(1);
  if (existingReg) {
    /* Allow re-registration only if the account is pending approval AND phone was never OTP-verified.
       This covers the case where a rider went back during registration and is retrying with the same number. */
    const canOverwrite = existingReg.approvalStatus === "pending" && !existingReg.phoneVerified;
    if (!canOverwrite) {
      /* Verified or approved account — guide user to login instead */
      const friendly = existingReg.phoneVerified
        ? "An account with this phone number already exists. Please log in instead."
        : "An account with this phone number is already pending approval. Please log in to check your status.";
      sendErrorWithData(res, friendly, { existingAccount: true }, 409);
      return;
    }
    /* Stale unverified pending record — soft-delete and allow fresh registration */
    await db.update(usersTable).set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() }).where(eq(usersTable.id, existingReg.id));
  }

  if (email) {
    const normalizedEmail = email.toLowerCase().trim();
    const [existingEmail] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
    if (existingEmail) {
      sendError(res, "An account with this email already exists", 409);
      return;
    }
  }

  let cleanUsername: string | null = null;
  if (username) {
    cleanUsername = username.toLowerCase().trim().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    if (cleanUsername !== null && cleanUsername.length >= 3) {
      const [existingUsername] = await db.select({ id: usersTable.id }).from(usersTable).where(sql`lower(${usersTable.username}) = ${cleanUsername}`).limit(1);
      if (existingUsername) {
        sendError(res, "This username is already taken", 409);
        return;
      }
    } else {
      cleanUsername = null;
    }
  }

  const requireApproval = (settings["user_require_approval"] ?? "off") === "on";
  const autoApproveRider = userRole === "rider" && settings["rider_auto_approve"] === "on";
  const autoApproveVendor = userRole === "vendor" && settings["vendor_auto_approve"] === "on";
  const needsApproval = requireApproval && !autoApproveRider && !autoApproveVendor;

  /* ── OTP bypass detection — mirrors send-otp bypass logic ──────────────── */
  const otpGlobalBypass = settings["security_otp_bypass"] === "on";
  const otpGlobalDisabledUntilStr = settings["otp_global_disabled_until"];
  const otpTimedBypass = otpGlobalDisabledUntilStr
    ? new Date(otpGlobalDisabledUntilStr) > new Date()
    : false;
  const otpBypassed = otpGlobalBypass || otpTimedBypass;

  const otp = generateSecureOtp();
  const otpExpiry = new Date(Date.now() + AUTH_OTP_TTL_MS);
  const userId = generateId();

  const ajkChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let ajkId = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    ajkId = "AJK-";
    for (let i = 0; i < 6; i++) ajkId += ajkChars.charAt(randomInt(0, ajkChars.length));
    const [dup] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.ajkId, ajkId)).limit(1);
    if (!dup) break;
    if (attempt === 9) throw new Error("Failed to generate unique AJK ID after 10 attempts");
  }

  const emailForInsert = email ? email.toLowerCase().trim() : null;
  await db.insert(usersTable).values({
    id: userId,
    phone: normalizedPhone,
    encryptedPhone: tryEncrypt(normalizedPhone),
    name: name?.trim() || null,
    email: emailForInsert,
    encryptedEmail: tryEncrypt(emailForInsert),
    username: cleanUsername,

    roles: userRole,
    passwordHash: hashPassword(password),
    otpCode: hashOtp(otp),
    otpExpiry,
    otpUsed: false,
    /* When OTP is bypassed, mark the phone as verified immediately */
    phoneVerified: otpBypassed,
    walletBalance: "0",
    isActive: !needsApproval,
    approvalStatus: needsApproval ? "pending" : "approved",
    ajkId,
    cnic: cnicValue || null,
    nationalId: cnicValue || null,
    address: address || null,
    city: city || null,
    emergencyContact: emergencyContact || null,
  });

  if (userRole === "rider") {
    await db.insert(riderProfilesTable).values({
      userId,
      vehicleType: vehicleType ? normalizeVehicleTypeForStorage(vehicleType) : null,
      vehicleRegNo: vehicleRegNo || null,
      vehiclePlate: vehiclePlate || vehicleRegNo || null,
      drivingLicense: drivingLicense || null,
      vehiclePhoto: vehiclePhoto || null,
      documents: documents || null,
    });
  }

  if (userRole === "vendor") {
    await db.insert(vendorProfilesTable).values({
      userId,
      businessName: businessName || storeName || null,
      storeName: storeName || businessName || null,
      businessType: businessType || null,
      storeAddress: storeAddress || null,
      ntn: ntn || null,
    });
  }

  writeAuthAuditLog("register", { ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone: normalizedPhone, role: userRole } });
  emitWebhookEvent("user_registered", { userId, phone: normalizedPhone, role: userRole, method: "username_password" }).catch(() => {});

  /* ── OTP bypass: skip delivery; issue tokens when account is immediately active ── */
  if (otpBypassed) {
    writeAuthAuditLog("register_otp_bypassed", { ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { phone: normalizedPhone, role: userRole } });
    if (!needsApproval) {
      /* Account auto-approved and active — issue access + refresh tokens now */
      const accessToken = signAccessToken(userId, normalizedPhone, userRole, userRole, 0);
      const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
      await db.insert(refreshTokensTable).values({
        id: generateId(), userId, tokenHash: refreshHash, authMethod: "register_otp_bypass",
        expiresAt: new Date(Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000),
      });
      setRiderRefreshCookie(req, res, refreshRaw, { roles: userRole });
      setVendorRefreshCookie(req, res, refreshRaw, { roles: userRole });
      sendSuccess(res, {
        message: "Registration successful.",
        userId, role: userRole,
        pendingApproval: false,
        otpRequired: false,
        channel: "bypass",
        token: accessToken,
        refreshToken: refreshRaw,
        expiresAt: new Date(Date.now() + getAccessTokenTtlSec() * 1000).toISOString(),
      }, undefined, 201);
    } else {
      /* Needs approval — no token yet, flag as pending */
      sendSuccess(res, {
        message: "Registration submitted. Your account is pending admin approval.",
        userId, role: userRole,
        pendingApproval: true,
        otpRequired: false,
        channel: "bypass",
      }, undefined, 201);
    }
    return;
  }

  const registerLang = await getUserLanguage(userId);
  const smsResult = await sendOtpSMS(normalizedPhone, otp, settings, registerLang);
  if (settings["integration_whatsapp"] === "on") {
    sendWhatsAppOTP(normalizedPhone, otp, settings, registerLang).catch(err =>
      logger.warn({ err: err.message }, "WhatsApp OTP send failed (non-fatal)")
    );
  }

  const isDev = process.env.NODE_ENV !== "production";
  sendSuccess(res, {
    message: "Registration successful. Please verify your phone with the OTP sent.",
    userId,

    pendingApproval: needsApproval,
    otpRequired: true,
    channel: smsResult.sent ? smsResult.provider : "console",
  }, undefined, 201);
});

router.post("/forgot-password", verifyCaptcha, sharedValidateBody(forgotPasswordSchema), async (req, res) => {
  let { phone, email, identifier } = req.body;
  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (identifier && !phone && !email) {
    const resolved = await findUserByIdentifier(identifier);
    if (resolved.user) {
      if (resolved.idType === "phone") {
        phone = resolved.user.phone ?? undefined;
      } else if (resolved.idType === "email") {
        email = resolved.user.email ?? undefined;
      } else if (resolved.idType === "username") {
        if (resolved.user.email) {
          email = resolved.user.email ?? undefined;
        } else if (resolved.user.phone) {
          phone = resolved.user.phone ?? undefined;
        }
      }
    }
  }

  if (!phone && !email) {
    sendError(res, "Phone, email, or username is required", 400);
    return;
  }

  if (phone && !isAuthMethodEnabled(settings, "auth_phone_otp_enabled")) {
    sendForbidden(res, "Phone-based password reset is currently disabled");
    return;
  }
  if (email && !phone && !isAuthMethodEnabled(settings, "auth_email_otp_enabled")) {
    sendForbidden(res, "Email-based password reset is currently disabled");
    return;
  }

  let user;
  if (phone) {
    const canonPhone = canonicalizePhone(phone);
    const [found] = await db.select().from(usersTable).where(eq(usersTable.phone, canonPhone)).limit(1);
    user = found;
  } else {
    const normalized = email!.toLowerCase().trim();
    const [found] = await db.select().from(usersTable).where(eq(usersTable.email, normalized)).limit(1);
    user = found;
  }

  const isDev = process.env.NODE_ENV !== "production";
  if (!user) {
    sendSuccess(res, { message: "If an account exists, a reset code has been sent.", ...(isDev ? { hint: "No account found" } : {}) });
    return;
  }

  const forgotRole = user.roles ?? "customer";
  if (phone && !isAuthMethodEnabled(settings, "auth_phone_otp_enabled", forgotRole)) {
    sendForbidden(res, "Phone-based password reset is currently disabled for your account type.");
    return;
  }
  if (email && !phone && !isAuthMethodEnabled(settings, "auth_email_otp_enabled", forgotRole)) {
    sendForbidden(res, "Email-based password reset is currently disabled for your account type.");
    return;
  }

  if (user.isBanned) { sendForbidden(res, "Account suspended."); return; }
  if (!user.isActive) { sendForbidden(res, "Account inactive."); return; }

  const maxAttempts = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
  const lockoutMinutes = parseInt(settings["security_lockout_minutes"] ?? "30", 10);
  const lockoutKey = `reset:${user.id}`;
  const lockout = await checkLockout(lockoutKey, maxAttempts, lockoutMinutes);
  if (lockout.locked) {
    sendTooManyRequests(res, `Too many attempts. Try again in ${lockout.minutesLeft} minute(s).`);
    return;
  }

  const otp = generateSecureOtp();
  const otpExpiry = new Date(Date.now() + AUTH_OTP_TTL_MS);

  const forgotLang = await getUserLanguage(user.id);

  if (phone) {
    await db.update(usersTable)
      .set({ otpCode: hashOtp(otp), otpExpiry, otpUsed: false, updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));

    const targetPhone = canonicalizePhone(phone);
    await sendOtpSMS(targetPhone, otp, settings, forgotLang);
    if (settings["integration_whatsapp"] === "on") {
      sendWhatsAppOTP(targetPhone, otp, settings, forgotLang).catch(() => {});
    }
  } else {
    await db.update(usersTable)
      .set({ emailOtpCode: hashOtp(otp), emailOtpExpiry: otpExpiry, updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));

    await sendPasswordResetEmail(email!, otp, user.name ?? undefined, forgotLang);
  }

  writeAuthAuditLog("forgot_password", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined });

  sendSuccess(res, {
    message: "If an account exists, a reset code has been sent.",
  });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/verify-reset-otp
   Pre-verify the OTP before allowing the user to set a new password.
   Body: { phone?, email?, otp }
   Returns: { valid: true } or 400/422 with error
══════════════════════════════════════════════════════════════ */
router.post("/verify-reset-otp", verifyCaptcha, async (req, res) => {
  let { phone, email, otp } = req.body;
  const ip = getClientIp(req);

  if (!otp || typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    sendError(res, "OTP must be exactly 6 digits", 400);
    return;
  }
  if (!phone && !email) {
    sendError(res, "Phone or email is required", 400);
    return;
  }

  let user: (typeof usersTable.$inferSelect) | undefined;
  if (phone) {
    const canonPhone = canonicalizePhone(phone);
    const [found] = await db.select().from(usersTable).where(eq(usersTable.phone, canonPhone)).limit(1);
    user = found;
  } else {
    const normalized = (email as string).toLowerCase().trim();
    const [found] = await db.select().from(usersTable).where(eq(usersTable.email, normalized)).limit(1);
    user = found;
  }

  if (!user) {
    sendError(res, "Invalid or expired code", 422);
    return;
  }

  const hashed = hashOtp(otp);
  const now = new Date();

  if (phone) {
    if (!user.otpCode || user.otpCode !== hashed) {
      sendError(res, "Invalid verification code", 422);
      return;
    }
    if (!user.otpExpiry || user.otpExpiry < now) {
      sendError(res, "Verification code has expired. Please request a new one.", 422);
      return;
    }
    if (user.otpUsed) {
      sendError(res, "This code has already been used. Please request a new one.", 422);
      return;
    }
  } else {
    if (!user.emailOtpCode || user.emailOtpCode !== hashed) {
      sendError(res, "Invalid verification code", 422);
      return;
    }
    if (!user.emailOtpExpiry || user.emailOtpExpiry < now) {
      sendError(res, "Verification code has expired. Please request a new one.", 422);
      return;
    }
  }

  writeAuthAuditLog("verify_reset_otp", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined });
  sendSuccess(res, { valid: true });
});

router.post("/reset-password", verifyCaptcha, async (req, res) => {
  let { phone, email, identifier, otp, newPassword, totpCode } = req.body;
  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!otp || typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    sendError(res, "OTP must be exactly 6 digits", 400);
    return;
  }
  if (!newPassword) {
    sendError(res, "New password is required", 400);
    return;
  }

  if (identifier && !phone && !email) {
    const resolved = await findUserByIdentifier(identifier);
    if (resolved.user) {
      if (resolved.idType === "phone") {
        phone = resolved.user.phone ?? undefined;
      } else if (resolved.idType === "email") {
        email = resolved.user.email ?? undefined;
      } else if (resolved.idType === "username") {
        if (resolved.user.email) {
          email = resolved.user.email ?? undefined;
        } else if (resolved.user.phone) {
          phone = resolved.user.phone ?? undefined;
        }
      }
    }
  }

  if (!phone && !email) {
    sendError(res, "Phone, email, or username is required", 400);
    return;
  }

  const pwCheck = validatePasswordStrength(newPassword);
  if (!pwCheck.ok) {
    sendError(res, pwCheck.message, 400);
    return;
  }

  let user;
  if (phone) {
    const canonPhone = canonicalizePhone(phone);
    const [found] = await db.select().from(usersTable).where(eq(usersTable.phone, canonPhone)).limit(1);
    user = found;
  } else {
    const normalized = email!.toLowerCase().trim();
    const [found] = await db.select().from(usersTable).where(eq(usersTable.email, normalized)).limit(1);
    user = found;
  }

  if (!user) {
    sendNotFound(res, "Account not found");
    return;
  }

  const userRole = user.roles ?? "customer";

  if (phone && !isAuthMethodEnabled(settings, "auth_phone_otp_enabled", userRole)) {
    sendForbidden(res, "Phone-based password reset is currently disabled for your account type.");
    return;
  }
  if (email && !phone && !isAuthMethodEnabled(settings, "auth_email_otp_enabled", userRole)) {
    sendForbidden(res, "Email-based password reset is currently disabled for your account type.");
    return;
  }

  if (user.isBanned) { sendForbidden(res, "Account suspended."); return; }

  const maxAttempts = parseInt(settings["security_login_max_attempts"] ?? "5", 10);
  const lockoutMinutes = parseInt(settings["security_lockout_minutes"] ?? "30", 10);
  const lockoutKey = `reset:${user.id}`;
  const lockout = await checkLockout(lockoutKey, maxAttempts, lockoutMinutes);
  if (lockout.locked) {
    sendTooManyRequests(res, `Too many attempts. Try again in ${lockout.minutesLeft} minute(s).`);
    return;
  }

  let otpValid = false;
  if (phone) {
    otpValid = user.otpCode === hashOtp(otp) && !user.otpUsed && user.otpExpiry != null && new Date() < user.otpExpiry;
  } else {
    otpValid = user.emailOtpCode === hashOtp(otp) && user.emailOtpExpiry != null && new Date() < user.emailOtpExpiry;
  }

  if (!otpValid) {
    await recordFailedAttempt(lockoutKey, maxAttempts, lockoutMinutes);
    addAuditEntry({ action: "reset_password_failed", ip, details: `Invalid OTP for password reset: ${user.id}`, result: "fail" });
    sendUnauthorized(res, "Invalid or expired OTP");
    return;
  }

  if (user.totpEnabled && isAuthMethodEnabled(settings, "auth_2fa_enabled", userRole)) {
    if (!totpCode) {
      sendErrorWithData(res, "Two-factor authentication code required", { requires2FA: true }, 400);
      return;
    }
    if (!/^\d{6}$/.test(totpCode)) {
      sendError(res, "TOTP code must be 6 digits", 400);
      return;
    }
    if (!user.totpSecret) {
      sendError(res, "2FA is not properly configured for this account. Please contact support.", 400);
      return;
    }
    const { verifyTotpCode } = await import("../../services/password.js");
    const decryptedSecret = decryptTotpSecret(user.totpSecret);
    if (!verifyTotpCode(decryptedSecret, totpCode)) {
      await recordFailedAttempt(lockoutKey, maxAttempts, lockoutMinutes);
      addAuditEntry({ action: "reset_password_2fa_failed", ip, details: `Invalid TOTP for password reset: ${user.id}`, result: "fail" });
      sendUnauthorized(res, "Invalid two-factor authentication code");
      return;
    }
  }

  await db.update(usersTable).set({
    passwordHash: hashPassword(newPassword),
    requirePasswordChange: false,
    otpCode: null,
    otpExpiry: null,
    otpUsed: true,
    emailOtpCode: null,
    emailOtpExpiry: null,
    tokenVersion: sql`token_version + 1`,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, user.id));

  await resetAttempts(lockoutKey);

  writeAuthAuditLog("password_reset", { userId: user.id, ip, userAgent: req.headers["user-agent"] ?? undefined });

  sendSuccess(res, undefined, "Password has been reset successfully. Please login with your new password.");
});

router.post("/email-register", verifyCaptcha, async (req, res) => {
  const { email, password, name, role, phone, username, cnic, vehicleType, vehicleRegNo, vehicleRegistration, drivingLicense,
          address, city, emergencyContact, vehiclePlate, vehiclePhoto, documents } = req.body;
  const ip = getClientIp(req);
  const settings = await getCachedSettings();
  const userRole = (role === "rider" || role === "vendor") ? role : "customer";

  if (!isAuthMethodEnabled(settings, "auth_email_register_enabled", userRole)) {
    sendForbidden(res, "Email registration is currently disabled");
    return;
  }

  if (settings["feature_new_users"] === "off") {
    sendForbidden(res, "New user registration is currently disabled.");
    return;
  }

  if (!email || !email.includes("@")) {
    sendError(res, "Valid email address is required", 400);
    return;
  }
  if (!password) {
    sendError(res, "Password is required", 400);
    return;
  }

  const pwCheck = validatePasswordStrength(password);
  if (!pwCheck.ok) {
    sendError(res, pwCheck.message, 400);
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);
  if (existing) {
    sendError(res, "An account with this email already exists", 409);
    return;
  }

  let cleanUsername: string | null = null;
  if (username) {
    cleanUsername = username.toLowerCase().trim().replace(/[^a-z0-9_]/g, "").slice(0, 20);
    if (cleanUsername !== null && cleanUsername.length >= 3) {
      const [existingUsername] = await db.select({ id: usersTable.id }).from(usersTable).where(sql`lower(${usersTable.username}) = ${cleanUsername}`).limit(1);
      if (existingUsername) {
        sendError(res, "This username is already taken", 409);
        return;
      }
    } else {
      cleanUsername = null;
    }
  }

  const requireApproval = (settings["user_require_approval"] ?? "off") === "on";
  const userId = generateId();
  const tempPhone = `email_${Date.now()}_${randomBytes(3).toString("hex")}`;

  const rawToken = generateVerificationToken();
  const tokenHash = hashVerificationToken(rawToken);
  const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const resolvedPhone = phone?.trim() || tempPhone;
  const resolvedVehicleRegNo = vehicleRegNo || vehicleRegistration || null;

  await db.insert(usersTable).values({
    id: userId,
    phone: resolvedPhone,
    encryptedPhone: tryEncrypt(phone?.trim() || null),
    name: name?.trim() || null,
    email: normalizedEmail,
    encryptedEmail: tryEncrypt(normalizedEmail),
    username: cleanUsername,

    roles: userRole,
    passwordHash: hashPassword(password),
    walletBalance: "0",
    isActive: !requireApproval,
    approvalStatus: requireApproval ? "pending" : "approved",
    emailVerified: false,
    emailOtpCode: tokenHash,
    emailOtpExpiry: verificationExpiry,
    ...(cnic ? { cnic: cnic.trim() } : {}),
    ...(address ? { address: address.trim() } : {}),
    ...(city ? { city: city.trim() } : {}),
    ...(emergencyContact ? { emergencyContact: emergencyContact.trim() } : {}),
  });

  if (userRole === "rider" && (vehicleType || resolvedVehicleRegNo || drivingLicense || vehiclePlate || vehiclePhoto || documents)) {
    await db.insert(riderProfilesTable).values({
      userId,
      vehicleType: vehicleType ? normalizeVehicleTypeForStorage(vehicleType) : null,
      vehicleRegNo: resolvedVehicleRegNo ? resolvedVehicleRegNo.trim() : null,
      vehiclePlate: vehiclePlate ? vehiclePlate.trim() : null,
      drivingLicense: drivingLicense ? drivingLicense.trim() : null,
      vehiclePhoto: vehiclePhoto || null,
      documents: documents || null,
    });
  }

  const domain = process.env["REPLIT_DEV_DOMAIN"] || process.env["APP_DOMAIN"] || "localhost";
  const verificationLink = `https://${domain}/api/auth/verify-email?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(normalizedEmail)}`;

  const verifyLang = await getUserLanguage(userId);
  const emailResult = await sendVerificationEmail(normalizedEmail, verificationLink, name, verifyLang);

  writeAuthAuditLog("email_register", { userId, ip, userAgent: req.headers["user-agent"] ?? undefined, metadata: { email: normalizedEmail, role: userRole, emailSent: emailResult.sent } });
  emitWebhookEvent("user_registered", { userId, email: normalizedEmail, role: userRole, method: "email" }).catch(() => {});

  const isDevTokenLog = process.env.NODE_ENV === "development" && process.env["LOG_OTP"] === "1";
  if (isDevTokenLog) {
    logger.info({ email: normalizedEmail, emailSent: emailResult.sent }, "Email verification token generated");
  }

  sendCreated(res, {
    userId,
    pendingApproval: requireApproval,
    emailSent: emailResult.sent,
    verificationLink: isDevTokenLog ? verificationLink : undefined,
    ...(isDevTokenLog ? { verificationToken: rawToken } : {}),
  }, emailResult.sent
    ? "Registration successful. Please check your email to verify your account."
    : "Registration successful. Please check your email to verify your account. (Email delivery pending — contact support if not received.)");
});

router.get("/verify-email", async (req, res) => {
  const { token, email } = req.query as { token?: string; email?: string };
  const ip = getClientIp(req);

  if (!token || !email) {
    sendError(res, "Invalid verification link", 400);
    return;
  }

  const normalizedEmail = decodeURIComponent(email).toLowerCase().trim();
  const verifyKey = `email_verify:${normalizedEmail}`;

  const lockout = await checkLockout(verifyKey, 5, 15);
  if (lockout.locked) {
    sendTooManyRequests(res, `Too many verification attempts. Try again in ${lockout.minutesLeft} minute(s).`);
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail)).limit(1);

  if (!user) {
    await recordFailedAttempt(verifyKey, 5, 15);
    sendError(res, "Invalid or expired verification link", 400);
    return;
  }

  if (user.emailVerified) {
    sendSuccess(res, undefined, "Email already verified. You can log in.");
    return;
  }

  if (user.emailOtpExpiry && new Date() > user.emailOtpExpiry) {
    sendUnauthorized(res, "Verification link has expired. Please register again.");
    return;
  }

  const incomingHash = hashVerificationToken(decodeURIComponent(token));
  if (!user.emailOtpCode || user.emailOtpCode !== incomingHash) {
    await recordFailedAttempt(verifyKey, 5, 15);
    addAuditEntry({ action: "email_verify_failed", ip, details: `Invalid verification token for ${normalizedEmail}`, result: "fail" });
    sendUnauthorized(res, "Invalid or expired verification link");
    return;
  }

  await db.update(usersTable).set({
    emailVerified: true,
    emailOtpCode: null,
    emailOtpExpiry: null,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, user.id));

  await resetAttempts(verifyKey);
  writeAuthAuditLog("email_verified", { userId: user.id, ip });

  sendSuccess(res, undefined, "Email verified successfully. You can now log in.");
});

/* ══════════════════════════════════════════════════════════════
   HELPER: Extract authenticated user from JWT (Authorization header)
══════════════════════════════════════════════════════════════ */
function extractAuthUser(req: Request): { userId: string; phone: string; role: string } | null {
  const authHeader = req.headers["authorization"] as string | undefined;
  const raw = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : (req.body?.token ?? null);
  if (!raw) return null;
  const payload = verifyUserJwt(raw);
  if (!payload) return null;
  return { userId: payload.userId, phone: payload.phone, role: payload.role };
}

/* ══════════════════════════════════════════════════════════════
   HELPER: Issue tokens & build response for a given user
══════════════════════════════════════════════════════════════ */
function parseUserAgent(ua?: string): { deviceName: string; browser: string; os: string } {
  if (!ua) return { deviceName: "Unknown", browser: "Unknown", os: "Unknown" };
  let browser = "Unknown";
  if (ua.includes("Firefox/")) browser = "Firefox";
  else if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("OPR/") || ua.includes("Opera/")) browser = "Opera";
  else if (ua.includes("Chrome/")) browser = "Chrome";
  else if (ua.includes("Safari/")) browser = "Safari";
  let os = "Unknown";
  if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac OS")) os = "macOS";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
  else if (ua.includes("Linux")) os = "Linux";
  const deviceName = `${browser} on ${os}`;
  return { deviceName, browser, os };
}

async function issueTokensForUser(user: any, ip: string, method: string, userAgent?: string, req?: Request, res?: Response) {
  const accessToken = signAccessToken(user.id, user.phone ?? "", user.roles ?? "customer", user.roles ?? "customer", user.tokenVersion ?? 0);
  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + getRefreshTokenTtlDays() * 24 * 60 * 60 * 1000);

  const refreshTokenId = generateId();
  await db.insert(refreshTokensTable).values({ id: refreshTokenId, userId: user.id, tokenHash: refreshHash, authMethod: method, expiresAt: refreshExpiresAt });
  db.delete(refreshTokensTable).where(and(eq(refreshTokensTable.userId, user.id), lt(refreshTokensTable.expiresAt, new Date()))).catch((err) => { logger.error("[auth] Expired token cleanup failed:", err); });
  await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
  writeAuthAuditLog("login_success", { userId: user.id, ip, userAgent, metadata: { method } });

  /* Cookie path is exercised by social/2FA/magic-link/firebase callers; req
     and res are optional to preserve the function's existing API for any
     internal call site that does not have a response object. */
  if (req && res) {
    setRiderRefreshCookie(req, res, refreshRaw, user);
    setVendorRefreshCookie(req, res, refreshRaw, user);
  }

  const parsed = parseUserAgent(userAgent);
  const tokenHash = crypto.createHash("sha256").update(accessToken).digest("hex");
  try {
    await db.insert(userSessionsTable).values({
      id: generateId(),
      userId: user.id,
      tokenHash,
      refreshTokenId,
      deviceName: parsed.deviceName,
      browser: parsed.browser,
      os: parsed.os,
      ip,
    });
  } catch (err) { logger.error("[auth] Session record insert failed:", err); }

  try {
    await db.insert(loginHistoryTable).values({
      id: generateId(),
      userId: user.id,
      ip,
      deviceName: parsed.deviceName,
      browser: parsed.browser,
      os: parsed.os,
      success: true,
      method,
    });
  } catch (err) { logger.error("[auth] Login history insert failed:", err); }

  return {
    token: accessToken,
    refreshToken: refreshRaw,
    expiresAt: new Date(Date.now() + getAccessTokenTtlSec() * 1000).toISOString(),
    sessionDays: getRefreshTokenTtlDays(),
    user: {
      id: user.id, phone: user.phone, name: user.name, email: user.email,
      role: user.roles, roles: user.roles, avatar: user.avatar,
      walletBalance: parseFloat(user.walletBalance ?? "0"),
      isActive: user.isActive, cnic: user.cnic, city: user.city,
      emailVerified: user.emailVerified ?? false, phoneVerified: user.phoneVerified ?? false,
      totpEnabled: user.totpEnabled ?? false,
      needsProfileCompletion: !user.cnic || !user.name,
      acceptedTermsVersion: (user as any).acceptedTermsVersion ?? null,
    },
    requiresTermsAcceptance: await (async () => {
      try {
        const s = await getCachedSettings();
        const currentTermsVersion = s["terms_version"] ?? "";
        if (!currentTermsVersion) return false;
        const userAccepted = (user as any).acceptedTermsVersion ?? null;
        return userAccepted !== currentTermsVersion;
      } catch { return false; }
    })(),
  };
}

/* ══════════════════════════════════════════════════════════════
   HELPER: Check trusted device
══════════════════════════════════════════════════════════════ */
function isDeviceTrusted(user: any, deviceFingerprint: string, trustedDays: number): boolean {
  if (!user.trustedDevices || !deviceFingerprint) return false;
  try {
    const devices: Array<{ fp: string; expiresAt: number }> = JSON.parse(user.trustedDevices);
    const now = Date.now();
    return devices.some(d => d.fp === deviceFingerprint && d.expiresAt > now);
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   POST /auth/social/google
   Verify Google ID token, match or create user, return JWT.
   Body: { idToken, deviceFingerprint? }
══════════════════════════════════════════════════════════════ */
router.post("/social/google", async (req, res) => {
  const { idToken, deviceFingerprint } = req.body;
  if (!idToken) { sendError(res, "idToken required", 400); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!isAuthMethodEnabledStrict(settings, "auth_google_enabled", "auth_social_google")) {
    sendForbidden(res, "Google login is currently disabled"); return;
  }

  let googlePayload: any;
  try {
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error("Invalid token");
    googlePayload = await resp.json();
  } catch {
    addSecurityEvent({ type: "social_google_invalid_token", ip, details: "Invalid Google ID token", severity: "medium" });
    sendUnauthorized(res, "Invalid Google token"); return;
  }

  const googleId = googlePayload.sub;
  const email = googlePayload.email?.toLowerCase?.() ?? null;
  const name = googlePayload.name ?? null;
  const avatar = googlePayload.picture ?? null;

  if (!googleId) { sendUnauthorized(res, "Google token missing sub"); return; }

  let [user] = await db.select().from(usersTable).where(eq(usersTable.googleId, googleId)).limit(1);

  if (!user && email) {
    [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (user) {
      await db.update(usersTable).set({ googleId, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
      user.googleId = googleId;
    }
  }

  const isNewUser = !user;

  /* ── Cross-role guard for social login ──
     If the caller specifies a role (rider/vendor), enforce that the existing account
     includes that role. Block new user creation for non-customer roles via social auth. */
  const requestedSocialRole = (req.body?.role as string | undefined) ?? null;
  if (requestedSocialRole && requestedSocialRole !== "customer") {
    if (user) {
      const userRoles = (user.roles || "").split(",").map((r: string) => r.trim());
      if (!userRoles.includes(requestedSocialRole)) {
        addSecurityEvent({ type: "cross_role_social_login_attempt", ip, details: `Social Google cross-role: requested=${requestedSocialRole} user.roles=${user.roles}`, severity: "medium" });
        sendErrorWithData(res, `No ${requestedSocialRole} account found for this Google account. Please use the correct app.`, { wrongApp: true }, 403); return;
      }
    } else {
      /* No user found — cannot auto-create non-customer accounts via social auth */
      sendErrorWithData(res, `No ${requestedSocialRole} account found for this Google account. Please use the correct registration process or contact admin.`, { wrongApp: true }, 403); return;
    }
  }

  const googleEffectiveRole = user?.roles ?? "customer";
  if (!isAuthMethodEnabledStrict(settings, "auth_google_enabled", "auth_social_google", googleEffectiveRole)) {
    sendForbidden(res, "Google login is currently disabled for your account type."); return;
  }

  if (!user) {
    if (settings["feature_new_users"] === "off") {
      sendForbidden(res, "New user registration is currently disabled"); return;
    }
    const requireApproval = settings["user_require_approval"] === "on";
    const id = generateId();
    [user] = await db.insert(usersTable).values({
      id, name, email, avatar, googleId,
      roles: "customer", walletBalance: "0",
      emailVerified: !!email,
      isActive: !requireApproval, approvalStatus: requireApproval ? "pending" : "approved",
    }).returning();
    emitWebhookEvent("user_registered", { userId: id, email, role: "customer", method: "social_google" }).catch(() => {});
  }

  if (user!.isBanned) { sendForbidden(res, "Account suspended"); return; }
  if (!user!.isActive && user!.approvalStatus !== "pending") { sendForbidden(res, "Account inactive"); return; }

  if (user!.totpEnabled && isAuthMethodEnabled(settings, "auth_2fa_enabled", user!.roles ?? undefined)) {
    const trustedDays = parseInt(settings["auth_trusted_device_days"] ?? "30", 10);
    if (!isDeviceTrusted(user!, deviceFingerprint, trustedDays)) {
      const tempToken = sign2faChallengeToken(user!.id, user!.phone ?? "", user!.roles ?? "customer", user!.roles ?? "customer", "social_google");
      sendSuccess(res, { requires2FA: true, tempToken, userId: user!.id }); return;
    }
  }

  addAuditEntry({ action: "social_google_login", ip, details: `Google login: ${email ?? googleId}`, result: "success" });
  const result = await issueTokensForUser(user!, ip, "social_google", req.headers["user-agent"] as string, req, res);
  sendSuccess(res, { ...result, isNewUser, needsProfileCompletion: isNewUser || !user!.cnic || !user!.name });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/social/facebook
   Verify Facebook access token, match or create user, return JWT.
   Body: { accessToken, deviceFingerprint? }
══════════════════════════════════════════════════════════════ */
router.post("/social/facebook", async (req, res) => {
  const { accessToken: fbToken, deviceFingerprint } = req.body;
  if (!fbToken) { sendError(res, "accessToken required", 400); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!isAuthMethodEnabledStrict(settings, "auth_facebook_enabled", "auth_social_facebook")) {
    sendForbidden(res, "Facebook login is currently disabled"); return;
  }

  let fbPayload: any;
  try {
    const resp = await fetch(`https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${encodeURIComponent(fbToken)}`, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error("Invalid token");
    fbPayload = await resp.json();
  } catch {
    addSecurityEvent({ type: "social_facebook_invalid_token", ip, details: "Invalid Facebook access token", severity: "medium" });
    sendUnauthorized(res, "Invalid Facebook token"); return;
  }

  const facebookId = fbPayload.id;
  const email = fbPayload.email?.toLowerCase?.() ?? null;
  const name = fbPayload.name ?? null;
  const avatar = fbPayload.picture?.data?.url ?? null;

  if (!facebookId) { sendUnauthorized(res, "Facebook token missing id"); return; }

  let [user] = await db.select().from(usersTable).where(eq(usersTable.facebookId, facebookId)).limit(1);

  if (!user && email) {
    [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (user) {
      await db.update(usersTable).set({ facebookId, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
      user.facebookId = facebookId;
    }
  }

  const isNewUser = !user;

  /* ── Cross-role guard for social login ──
     If the caller specifies a role (rider/vendor), enforce that the existing account
     includes that role. Block new user creation for non-customer roles via social auth. */
  const requestedFbSocialRole = (req.body?.role as string | undefined) ?? null;
  if (requestedFbSocialRole && requestedFbSocialRole !== "customer") {
    if (user) {
      const userRoles = (user.roles || "").split(",").map((r: string) => r.trim());
      if (!userRoles.includes(requestedFbSocialRole)) {
        addSecurityEvent({ type: "cross_role_social_login_attempt", ip, details: `Social Facebook cross-role: requested=${requestedFbSocialRole} user.roles=${user.roles}`, severity: "medium" });
        sendErrorWithData(res, `No ${requestedFbSocialRole} account found for this Facebook account. Please use the correct app.`, { wrongApp: true }, 403); return;
      }
    } else {
      /* No user found — cannot auto-create non-customer accounts via social auth */
      sendErrorWithData(res, `No ${requestedFbSocialRole} account found for this Facebook account. Please use the correct registration process or contact admin.`, { wrongApp: true }, 403); return;
    }
  }

  const fbEffectiveRole = user?.roles ?? "customer";
  if (!isAuthMethodEnabledStrict(settings, "auth_facebook_enabled", "auth_social_facebook", fbEffectiveRole)) {
    sendForbidden(res, "Facebook login is currently disabled for your account type."); return;
  }

  if (!user) {
    if (settings["feature_new_users"] === "off") {
      sendForbidden(res, "New user registration is currently disabled"); return;
    }
    const requireApproval = settings["user_require_approval"] === "on";
    const id = generateId();
    [user] = await db.insert(usersTable).values({
      id, name, email, avatar, facebookId,
      roles: "customer", walletBalance: "0",
      emailVerified: !!email,
      isActive: !requireApproval, approvalStatus: requireApproval ? "pending" : "approved",
    }).returning();
    emitWebhookEvent("user_registered", { userId: id, email, role: "customer", method: "social_facebook" }).catch(() => {});
  }

  if (user!.isBanned) { sendForbidden(res, "Account suspended"); return; }
  if (!user!.isActive && user!.approvalStatus !== "pending") { sendForbidden(res, "Account inactive"); return; }

  if (user!.totpEnabled && isAuthMethodEnabled(settings, "auth_2fa_enabled", user!.roles ?? undefined)) {
    const trustedDays = parseInt(settings["auth_trusted_device_days"] ?? "30", 10);
    if (!isDeviceTrusted(user!, deviceFingerprint, trustedDays)) {
      const tempToken = sign2faChallengeToken(user!.id, user!.phone ?? "", user!.roles ?? "customer", user!.roles ?? "customer", "social_facebook");
      sendSuccess(res, { requires2FA: true, tempToken, userId: user!.id }); return;
    }
  }

  addAuditEntry({ action: "social_facebook_login", ip, details: `Facebook login: ${email ?? facebookId}`, result: "success" });
  const result = await issueTokensForUser(user!, ip, "social_facebook", req.headers["user-agent"] as string, req, res);
  sendSuccess(res, { ...result, isNewUser, needsProfileCompletion: isNewUser || !user!.cnic || !user!.name });
});

/* ══════════════════════════════════════════════════════════════
   GET /auth/2fa/setup
   Generate TOTP secret + QR code URI. Requires valid JWT.
══════════════════════════════════════════════════════════════ */
router.get("/2fa/setup", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const settings = await getCachedSettings();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Two-factor authentication is currently disabled"); return;
  }
  if (user.totpEnabled) { sendError(res, "2FA is already enabled", 409); return; }

  const secret = generateTotpSecret();
  const label = user.email ?? user.phone ?? user.name ?? auth.userId;
  const uri = getTotpUri(secret, label);

  /* Two-phase setup: store the secret in memory only (NOT in the database).
     The DB write happens in /auth/2fa/verify-setup only after the user
     successfully verifies their first TOTP code. This prevents an unverified
     secret from persisting in the DB when the user abandons setup. */
  const encryptedSecret = encryptTotpSecret(secret);
  pendingTotpSecrets.set(auth.userId, { secret, encryptedSecret, createdAt: Date.now() });

  let qrDataUrl: string | null = null;
  try { qrDataUrl = await generateQRCodeDataURL(secret, label); } catch (err) { logger.error("[2fa/setup] QR code generation failed:", err); }

  sendSuccess(res, { secret, uri, qrDataUrl });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/2fa/verify-setup
   Confirm first TOTP code, activate 2FA, return backup codes.
   Body: { code }
══════════════════════════════════════════════════════════════ */
router.post("/2fa/verify-setup", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { code } = req.body;
  if (!code) { sendError(res, "TOTP code required", 400); return; }

  const settings = await getCachedSettings();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Two-factor authentication is currently disabled"); return;
  }
  if (user.totpEnabled) { sendError(res, "2FA is already enabled", 409); return; }

  /* Two-phase setup: read pending secret from the in-memory map (set by /auth/2fa/setup).
     If not found the setup step was never called (or the TTL expired). */
  const pendingEntry = pendingTotpSecrets.get(auth.userId);
  if (!pendingEntry) {
    sendError(res, "Please call /auth/2fa/setup first (setup session expired or not started)", 400); return;
  }

  const secret = pendingEntry.secret;
  if (!verifyTotpToken(code, secret)) {
    sendUnauthorized(res, "Invalid TOTP code. Please try again."); return;
  }

  /* Verification succeeded — now write the encrypted secret to the database. */
  await db.update(usersTable).set({ totpSecret: pendingEntry.encryptedSecret, updatedAt: new Date() }).where(eq(usersTable.id, auth.userId));
  pendingTotpSecrets.delete(auth.userId);

  /* Generate 8 single-use recovery codes and store them as individual rows in
     totp_recovery_codes (bcrypt-hashed). We delete any stale rows from a previous
     enrollment first (idempotent re-enrollment). */
  const backupCodes: string[] = [];
  const codeRows: { id: string; userId: string; codeHash: string }[] = [];
  for (let i = 0; i < 8; i++) {
    const raw = crypto.randomBytes(4).toString("hex");
    backupCodes.push(raw);
    codeRows.push({ id: generateId(), userId: auth.userId, codeHash: hashPassword(raw) });
  }

  await db.delete(totpRecoveryCodesTable).where(eq(totpRecoveryCodesTable.userId, auth.userId));
  await db.insert(totpRecoveryCodesTable).values(codeRows);

  await db.update(usersTable).set({
    totpEnabled: true,
    backupCodes: null, /* deprecated — codes are now stored in totp_recovery_codes */
    updatedAt: new Date(),
  }).where(eq(usersTable.id, auth.userId));

  const ip = getClientIp(req);
  writeAuthAuditLog("2fa_enabled", { userId: auth.userId, ip, userAgent: req.headers["user-agent"] as string });
  addAuditEntry({ action: "2fa_enabled", ip, details: `2FA enabled for user ${auth.userId}`, result: "success" });

  sendSuccess(res, { success: true, backupCodes, message: "2FA activated. Save your backup codes securely — they cannot be shown again." });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/totp/enable
   Canonical TOTP activation endpoint — confirms the first valid
   TOTP code, marks 2FA active, generates 8 single-use recovery
   codes stored in totp_recovery_codes (bcrypt-hashed), and
   returns them once in plaintext for the user to save.

   Body: { code }
   Auth: Bearer token (authenticated user)

   Functionally identical to POST /auth/2fa/verify-setup (which
   is kept as the backward-compatible alias). Clients should
   prefer this canonical path going forward.
══════════════════════════════════════════════════════════════ */
router.post("/totp/enable", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { code } = req.body;
  if (!code) { sendError(res, "TOTP code required", 400); return; }

  const settings = await getCachedSettings();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Two-factor authentication is currently disabled"); return;
  }
  if (user.totpEnabled) { sendError(res, "2FA is already enabled", 409); return; }

  /* Two-phase setup: read pending secret from the in-memory map (set by /auth/2fa/setup).
     This is the canonical enable endpoint — the DB write only happens here after
     the user verifies their first code, never during setup. */
  const pendingEntryEnable = pendingTotpSecrets.get(auth.userId);
  if (!pendingEntryEnable) {
    sendError(res, "Please call /auth/2fa/setup first to obtain a TOTP secret (setup session expired or not started)", 400); return;
  }

  const secret = pendingEntryEnable.secret;
  if (!verifyTotpToken(code, secret)) {
    sendUnauthorized(res, "Invalid TOTP code. Please try again."); return;
  }

  /* Verification succeeded — write encrypted secret to the database now. */
  await db.update(usersTable).set({ totpSecret: pendingEntryEnable.encryptedSecret, updatedAt: new Date() }).where(eq(usersTable.id, auth.userId));
  pendingTotpSecrets.delete(auth.userId);

  /* Generate 8 single-use recovery codes and store them as individual rows in
     totp_recovery_codes (bcrypt-hashed). Delete any stale rows from a previous
     incomplete enrollment first (idempotent). */
  const backupCodes: string[] = [];
  const codeRows: { id: string; userId: string; codeHash: string }[] = [];
  for (let i = 0; i < 8; i++) {
    const raw = crypto.randomBytes(4).toString("hex");
    backupCodes.push(raw);
    codeRows.push({ id: generateId(), userId: auth.userId, codeHash: hashPassword(raw) });
  }

  await db.delete(totpRecoveryCodesTable).where(eq(totpRecoveryCodesTable.userId, auth.userId));
  await db.insert(totpRecoveryCodesTable).values(codeRows);

  await db.update(usersTable).set({
    totpEnabled: true,
    backupCodes: null, /* deprecated — codes now stored in totp_recovery_codes */
    updatedAt: new Date(),
  }).where(eq(usersTable.id, auth.userId));

  const ip = getClientIp(req);
  writeAuthAuditLog("2fa_enabled", { userId: auth.userId, ip, userAgent: req.headers["user-agent"] as string });
  addAuditEntry({ action: "2fa_enabled", ip, details: `2FA enabled for user ${auth.userId} via /auth/totp/enable`, result: "success" });

  sendSuccess(res, { success: true, backupCodes, message: "2FA activated. Save your backup codes securely — they cannot be shown again." });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/2fa/verify
   Verify TOTP code during login flow.
   Body: { tempToken, code, deviceFingerprint? }
══════════════════════════════════════════════════════════════ */
router.post("/2fa/verify", async (req, res) => {
  const { tempToken, code, deviceFingerprint } = req.body;
  if (!tempToken || !code) { sendError(res, "tempToken and code required", 400); return; }

  const challengePayload = verify2faChallengeToken(tempToken);
  if (!challengePayload) { sendUnauthorized(res, "Invalid or expired 2FA challenge token"); return; }

  const settings = await getCachedSettings();
  const ip = getClientIp(req);

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, challengePayload.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Two-factor authentication has been disabled by admin."); return;
  }

  if (!user.totpEnabled || !user.totpSecret) { sendError(res, "2FA is not enabled", 400); return; }

  const secret = decryptTotpSecret(user.totpSecret);
  if (!verifyTotpToken(code, secret)) {
    addSecurityEvent({ type: "2fa_verify_failed", ip, userId: user.id, details: "Invalid 2FA code on login", severity: "medium" });
    sendUnauthorized(res, "Invalid 2FA code"); return;
  }

  writeAuthAuditLog("2fa_verified", { userId: user.id, ip, userAgent: req.headers["user-agent"] as string });
  const originalMethod = challengePayload.authMethod ?? "phone_otp";
  const result = await issueTokensForUser(user, ip, originalMethod, req.headers["user-agent"] as string, req, res);
  sendSuccess(res, result);
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/2fa/disable
   Disable 2FA for the authenticated user. Body: { code }
══════════════════════════════════════════════════════════════ */
router.post("/2fa/disable", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { code } = req.body;
  if (!code) { sendError(res, "TOTP code required to disable 2FA", 400); return; }

  const settings = await getCachedSettings();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Two-factor authentication has been disabled by admin."); return;
  }

  if (!user.totpEnabled || !user.totpSecret) { sendError(res, "2FA is not enabled", 400); return; }

  const secret = decryptTotpSecret(user.totpSecret);
  if (!verifyTotpToken(code, secret)) {
    sendUnauthorized(res, "Invalid TOTP code"); return;
  }

  await db.update(usersTable).set({
    totpEnabled: false, totpSecret: null, backupCodes: null, trustedDevices: null, updatedAt: new Date(),
  }).where(eq(usersTable.id, auth.userId));

  const ip = getClientIp(req);
  writeAuthAuditLog("2fa_disabled", { userId: auth.userId, ip, userAgent: req.headers["user-agent"] as string });
  addAuditEntry({ action: "2fa_disabled", ip, details: `2FA disabled by user ${auth.userId}`, result: "success" });

  sendSuccess(res, undefined, "Two-factor authentication has been disabled");
});

/* ══════════════════════════════════════════════════════════════
   consumeRecoveryCode — shared helper used by both recovery
   endpoints to validate, atomically consume, and audit a
   single-use TOTP recovery code.

   Returns:
     { codesRemaining: number } on success
     { error: string, status: number } on failure (caller sends response)

   New-table path: SELECT unused rows → bcrypt match → atomic UPDATE
     WHERE id = ? AND used_at IS NULL → empty RETURNING = already consumed
   Legacy path: read users.backupCodes JSON, match, migrate remainder
     into totp_recovery_codes on first use, clear the JSON column.
══════════════════════════════════════════════════════════════ */
async function consumeRecoveryCode(
  user: { id: string; backupCodes: string | null },
  backupCode: string,
  ip: string,
  sourcePath: string,
): Promise<{ codesRemaining: number } | { error: string; status: number }> {
  const unusedRows = await db.select()
    .from(totpRecoveryCodesTable)
    .where(and(eq(totpRecoveryCodesTable.userId, user.id), isNull(totpRecoveryCodesTable.usedAt)));

  const useNewTable = unusedRows.length > 0;

  if (useNewTable) {
    let matchedRow: typeof unusedRows[number] | null = null;
    for (const row of unusedRows) {
      if (verifyPassword(backupCode, row.codeHash)) { matchedRow = row; break; }
    }
    if (!matchedRow) {
      addSecurityEvent({ type: "2fa_recovery_failed", ip, userId: user.id, details: `Invalid recovery code attempt via ${sourcePath}`, severity: "high" });
      return { error: "Invalid recovery code", status: 401 };
    }
    /* Atomic consume: UPDATE with AND used_at IS NULL — concurrent racing requests
       get empty RETURNING (the row is already marked used), guaranteeing single-use. */
    const consumed = await db.update(totpRecoveryCodesTable)
      .set({ usedAt: new Date() })
      .where(and(eq(totpRecoveryCodesTable.id, matchedRow.id), isNull(totpRecoveryCodesTable.usedAt)))
      .returning({ id: totpRecoveryCodesTable.id });
    if (consumed.length === 0) {
      addSecurityEvent({ type: "2fa_recovery_failed", ip, userId: user.id, details: `Recovery code already consumed (concurrent attempt) via ${sourcePath}`, severity: "high" });
      return { error: "Invalid recovery code", status: 401 };
    }
    const codesRemaining = unusedRows.length - 1;
    writeAuthAuditLog("2fa_recovery_used", { userId: user.id, ip, userAgent: "", metadata: { codesRemaining, path: sourcePath } });
    addAuditEntry({ action: "2fa_recovery_used", ip, details: `Recovery code used for user ${user.id} via ${sourcePath}, ${codesRemaining} remaining`, result: "success" });
    return { codesRemaining };
  } else {
    /* Legacy JSON fallback: honour codes stored in users.backupCodes before the migration */
    if (!user.backupCodes) {
      addSecurityEvent({ type: "2fa_recovery_no_codes", ip, userId: user.id, details: `No recovery codes (table empty, JSON null) via ${sourcePath}`, severity: "high" });
      return { error: "All recovery codes have been used. Please contact an administrator to regain access.", status: 400 };
    }
    let legacyStoredCodes: string[] = [];
    try { legacyStoredCodes = JSON.parse(user.backupCodes); if (!Array.isArray(legacyStoredCodes)) legacyStoredCodes = []; } catch { legacyStoredCodes = []; }
    if (legacyStoredCodes.length === 0) {
      addSecurityEvent({ type: "2fa_recovery_no_codes", ip, userId: user.id, details: `All legacy recovery codes exhausted via ${sourcePath}`, severity: "high" });
      return { error: "All recovery codes have been used. Please contact an administrator to regain access.", status: 400 };
    }
    let matchIdx = -1;
    for (let i = 0; i < legacyStoredCodes.length; i++) {
      if (verifyPassword(backupCode, legacyStoredCodes[i]!)) { matchIdx = i; break; }
    }
    if (matchIdx === -1) {
      addSecurityEvent({ type: "2fa_recovery_failed", ip, userId: user.id, details: `Invalid legacy backup code via ${sourcePath}`, severity: "high" });
      return { error: "Invalid recovery code", status: 401 };
    }
    legacyStoredCodes.splice(matchIdx, 1);
    /* Migrate remaining hashes into the new table, then clear the deprecated JSON column */
    if (legacyStoredCodes.length > 0) {
      await db.insert(totpRecoveryCodesTable).values(
        legacyStoredCodes.map(hash => ({ id: generateId(), userId: user.id, codeHash: hash }))
      );
    }
    await db.update(usersTable).set({ backupCodes: null, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    const codesRemaining = legacyStoredCodes.length;
    writeAuthAuditLog("2fa_recovery_used", { userId: user.id, ip, userAgent: "", metadata: { codesRemaining, legacyPath: true, path: sourcePath } });
    addAuditEntry({ action: "2fa_recovery_used", ip, details: `Legacy recovery code used for user ${user.id} via ${sourcePath}, migrated ${codesRemaining} remaining`, result: "success" });
    return { codesRemaining };
  }
}

/* ══════════════════════════════════════════════════════════════
   POST /auth/2fa/recovery
   Use a single-use backup code. Body: { tempToken, backupCode }
══════════════════════════════════════════════════════════════ */
router.post("/2fa/recovery", async (req, res) => {
  const { tempToken, backupCode } = req.body;
  if (!tempToken || !backupCode) { sendError(res, "tempToken and backupCode required", 400); return; }

  const challengePayload = verify2faChallengeToken(tempToken);
  if (!challengePayload) { sendUnauthorized(res, "Invalid or expired 2FA challenge token"); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, challengePayload.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Two-factor authentication has been disabled by admin."); return;
  }

  if (!user.totpEnabled) { sendError(res, "2FA is not enabled", 400); return; }

  const outcome = await consumeRecoveryCode(user, backupCode, ip, "/auth/2fa/recovery");
  if ("error" in outcome) { sendError(res, outcome.error, outcome.status); return; }

  const recoveryOrigMethod = challengePayload.authMethod ?? "phone_otp";
  const result = await issueTokensForUser(user, ip, recoveryOrigMethod, req.headers["user-agent"] as string, req, res);
  sendSuccess(res, { ...result, codesRemaining: outcome.codesRemaining });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/totp/recover
   Alias for /auth/2fa/recovery — accepts a single-use backup/
   recovery code and issues a full session on success.
   Body: { tempToken, backupCode }

   This endpoint is the canonical TOTP lockout-recovery path.
   The underlying backup codes are generated at 2FA setup time,
   bcrypt-hashed, and stored as single-use tokens that are
   consumed on use.  Eight codes are issued per setup; running
   out requires admin intervention or 2FA re-enrollment.
══════════════════════════════════════════════════════════════ */
router.post("/totp/recover", async (req, res) => {
  /* Canonical TOTP lockout-recovery path — delegates to consumeRecoveryCode() shared
     helper which handles new-table atomic consume and legacy JSON fallback/migration. */
  const { tempToken, backupCode } = req.body;
  if (!tempToken || !backupCode) { sendError(res, "tempToken and backupCode required", 400); return; }

  const challengePayload = verify2faChallengeToken(tempToken);
  if (!challengePayload) { sendUnauthorized(res, "Invalid or expired 2FA challenge token"); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, challengePayload.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Two-factor authentication has been disabled by admin."); return;
  }

  if (!user.totpEnabled) { sendError(res, "2FA is not enabled", 400); return; }

  const outcome = await consumeRecoveryCode(user, backupCode, ip, "/auth/totp/recover");
  if ("error" in outcome) { sendError(res, outcome.error, outcome.status); return; }

  const recoveryOrigMethod = challengePayload.authMethod ?? "phone_otp";
  const result = await issueTokensForUser(user, ip, recoveryOrigMethod, req.headers["user-agent"] as string, req, res);
  sendSuccess(res, { ...result, codesRemaining: outcome.codesRemaining });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/2fa/trust-device
   Store device fingerprint for trusted device bypass.
   Body: { deviceFingerprint }
══════════════════════════════════════════════════════════════ */
router.post("/2fa/trust-device", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { deviceFingerprint } = req.body;
  if (!deviceFingerprint || typeof deviceFingerprint !== "string" || deviceFingerprint.length < 8) {
    sendError(res, "Valid deviceFingerprint required (min 8 chars)", 400); return;
  }

  const settings = await getCachedSettings();
  const trustedDays = parseInt(settings["auth_trusted_device_days"] ?? "30", 10);

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (!isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    sendForbidden(res, "Two-factor authentication has been disabled by admin."); return;
  }

  if (!user.totpEnabled) { sendError(res, "2FA is not enabled", 400); return; }

  let devices: Array<{ fp: string; expiresAt: number }> = [];
  try { if (user.trustedDevices) devices = JSON.parse(user.trustedDevices); } catch {}

  const now = Date.now();
  devices = devices.filter(d => d.expiresAt > now && d.fp !== deviceFingerprint);
  devices.push({ fp: deviceFingerprint, expiresAt: now + trustedDays * 24 * 60 * 60 * 1000 });

  if (devices.length > 10) devices = devices.slice(-10);

  await db.update(usersTable).set({ trustedDevices: JSON.stringify(devices), updatedAt: new Date() }).where(eq(usersTable.id, auth.userId));

  const ip = getClientIp(req);
  writeAuthAuditLog("device_trusted", { userId: auth.userId, ip, userAgent: req.headers["user-agent"] as string });

  sendSuccess(res, { success: true, message: `Device trusted for ${trustedDays} days`, trustedDevices: devices.length });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/magic-link/send
   Send a magic link to the user's email. Rate limited: 3 per email per 10 min.
   Body: { email }
══════════════════════════════════════════════════════════════ */
const magicLinkRateMap = new Map<string, { count: number; windowStart: number }>();

router.post("/magic-link/send", async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) { sendError(res, "Valid email address required", 400); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!isAuthMethodEnabledStrict(settings, "auth_magic_link_enabled", "auth_magic_link")) {
    sendForbidden(res, "Magic link login is currently disabled"); return;
  }

  const normalized = email.toLowerCase().trim();

  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const rlKey = `ml:${normalized}`;
  const rl = magicLinkRateMap.get(rlKey);
  if (rl && now - rl.windowStart < windowMs) {
    if (rl.count >= 3) {
      const waitMin = Math.ceil((rl.windowStart + windowMs - now) / 60000);
      sendTooManyRequests(res, `Too many magic link requests. Try again in ${waitMin} minute(s).`); return;
    }
    rl.count++;
  } else {
    magicLinkRateMap.set(rlKey, { count: 1, windowStart: now });
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalized)).limit(1);
  if (!user) {
    sendSuccess(res, undefined, "If an account exists with this email, a magic link has been sent."); return;
  }

  const effectiveMagicRole = user.roles ?? ((req.body?.role === "rider" || req.body?.role === "vendor") ? req.body.role : "customer");
  if (!isAuthMethodEnabledStrict(settings, "auth_magic_link_enabled", "auth_magic_link", effectiveMagicRole)) {
    sendForbidden(res, "Magic link login is currently disabled for your account type."); return;
  }

  if (user.isBanned) { sendForbidden(res, "Account suspended"); return; }
  if (!user.isActive) { sendForbidden(res, "Account inactive"); return; }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashPassword(rawToken);
  const expiresAt = new Date(Date.now() + getAccessTokenTtlSec() * 1000);

  await db.insert(magicLinkTokensTable).values({
    id: generateId(),
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const magicLinkLang = await getUserLanguage(user.id);
  await sendMagicLinkEmail(normalized, rawToken, settings, magicLinkLang);

  addAuditEntry({ action: "magic_link_sent", ip, details: `Magic link sent to: ${normalized}`, result: "success" });
  writeAuthAuditLog("magic_link_sent", { ip, metadata: { email: normalized } });

  const isDevTokenLog = process.env.NODE_ENV === "development" && process.env["LOG_OTP"] === "1";
  sendSuccess(res, {
    message: "If an account exists with this email, a magic link has been sent.",
    ...(isDevTokenLog ? { token: rawToken } : {}),
  });
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/magic-link/verify
   Validate magic link token, handle 2FA guard.
   Body: { token, totpCode?, deviceFingerprint? }
══════════════════════════════════════════════════════════════ */
router.post("/magic-link/verify", async (req, res) => {
  const { token, totpCode, deviceFingerprint } = req.body;
  if (!token) { sendError(res, "Token required", 400); return; }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();

  if (!isAuthMethodEnabledStrict(settings, "auth_magic_link_enabled", "auth_magic_link")) {
    sendForbidden(res, "Magic link login is currently disabled"); return;
  }

  const allTokens = await db.select().from(magicLinkTokensTable)
    .where(sql`${magicLinkTokensTable.usedAt} IS NULL AND ${magicLinkTokensTable.expiresAt} > now()`)
    .limit(50);

  let matchedRow: typeof allTokens[0] | null = null;
  for (const row of allTokens) {
    if (verifyPassword(token, row.tokenHash)) { matchedRow = row; break; }
  }

  if (!matchedRow) {
    addSecurityEvent({ type: "magic_link_invalid", ip, details: "Invalid or expired magic link token", severity: "medium" });
    sendUnauthorized(res, "Invalid or expired magic link. Please request a new one."); return;
  }

  await db.update(magicLinkTokensTable).set({ usedAt: new Date() }).where(eq(magicLinkTokensTable.id, matchedRow.id));

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, matchedRow.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }
  if (user.isBanned) { sendForbidden(res, "Account suspended"); return; }
  if (!user.isActive) { sendForbidden(res, "Account inactive"); return; }

  if (!isAuthMethodEnabledStrict(settings, "auth_magic_link_enabled", "auth_magic_link", user.roles ?? "customer")) {
    sendForbidden(res, "Magic link login is currently disabled for your account type."); return;
  }

  if (user.totpEnabled && isAuthMethodEnabled(settings, "auth_2fa_enabled", user.roles ?? undefined)) {
    const trustedDays = parseInt(settings["auth_trusted_device_days"] ?? "30", 10);
    if (!isDeviceTrusted(user, deviceFingerprint ?? "", trustedDays)) {
      if (!totpCode) {
        const tempToken = sign2faChallengeToken(user.id, user.phone ?? "", user.roles ?? "customer", user.roles ?? "customer", "magic_link");
        sendSuccess(res, { requires2FA: true, tempToken, userId: user.id }); return;
      }
      const secret = decryptTotpSecret(user.totpSecret!);
      if (!verifyTotpToken(totpCode, secret)) {
        sendUnauthorized(res, "Invalid 2FA code"); return;
      }
    }
  }

  await db.update(usersTable).set({ emailVerified: true, updatedAt: new Date() }).where(eq(usersTable.id, user.id));

  addAuditEntry({ action: "magic_link_login", ip, details: `Magic link login: ${user.email ?? matchedRow.userId}`, result: "success" });
  const result = await issueTokensForUser(user, ip, "magic_link", req.headers["user-agent"] as string, req, res);
  sendSuccess(res, result);
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/change-phone/request
   Send OTP to a new phone number for phone change flow.
   Body: { newPhone }
══════════════════════════════════════════════════════════════ */
router.post("/change-phone/request", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { newPhone } = req.body;
  if (!newPhone || typeof newPhone !== "string") {
    sendError(res, "New phone number is required", 400); return;
  }

  const phone = canonicalizePhone(newPhone);
  if (!/^3\d{9}$/.test(phone)) {
    sendError(res, "Invalid Pakistani phone number format", 400); return;
  }

  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
  if (existing) {
    sendError(res, "This phone number is already registered to another account", 409); return;
  }

  const ip = getClientIp(req);
  const settings = await getCachedSettings();
  const otp = generateSecureOtp();
  const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

  await db.update(usersTable).set({
    mergeOtpCode: hashOtp(otp),
    mergeOtpExpiry: otpExpiry,
    pendingMergeIdentifier: phone,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, auth.userId));

  const lang = await getUserLanguage(auth.userId);
  const whatsappEnabled = settings["integration_whatsapp"] === "on";
  let sent = false;
  if (whatsappEnabled) {
    const waResult = await sendWhatsAppOTP(phone, otp, settings, lang);
    if (waResult.sent) sent = true;
  }
  if (!sent) {
    await sendOtpSMS(phone, otp, settings, lang);
  }

  writeAuthAuditLog("phone_change_requested", { userId: auth.userId, ip, userAgent: req.headers["user-agent"] as string, metadata: { newPhone: phone } });

  sendSuccess(res, undefined, "OTP sent to new phone number");
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/change-phone/confirm
   Verify OTP and update phone number.
   Body: { newPhone, otp }
══════════════════════════════════════════════════════════════ */
router.post("/change-phone/confirm", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { newPhone, otp } = req.body;
  if (!newPhone || !otp) {
    sendError(res, "New phone number and OTP are required", 400); return;
  }

  const phone = canonicalizePhone(newPhone);
  const ip = getClientIp(req);

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId)).limit(1);
  if (!user) { sendNotFound(res, "User not found"); return; }

  if (user.pendingMergeIdentifier !== phone) {
    sendError(res, "OTP was not requested for this phone number", 400); return;
  }

  if (user.mergeOtpCode !== hashOtp(otp) || !user.mergeOtpExpiry || user.mergeOtpExpiry < new Date()) {
    sendError(res, "Invalid or expired OTP", 400); return;
  }

  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.phone, phone)).limit(1);
  if (existing) {
    sendError(res, "This phone number is already registered to another account", 409); return;
  }

  await db.update(usersTable).set({
    phone,
    phoneVerified: true,
    mergeOtpCode: null,
    mergeOtpExpiry: null,
    pendingMergeIdentifier: null,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, auth.userId));

  writeAuthAuditLog("phone_changed", { userId: auth.userId, ip, userAgent: req.headers["user-agent"] as string, metadata: { newPhone: phone } });

  sendSuccess(res, { success: true, message: "Phone number updated successfully", phone });
});

/* ══════════════════════════════════════════════════════════════
   GET /auth/login-history
   Return last 20 login attempts for authenticated user.
══════════════════════════════════════════════════════════════ */
router.get("/login-history", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const history = await db.select().from(loginHistoryTable)
    .where(eq(loginHistoryTable.userId, auth.userId))
    .orderBy(desc(loginHistoryTable.createdAt))
    .limit(20);

  sendSuccess(res, {
    history: history.map(h => ({
      id: h.id,
      ip: h.ip,
      deviceName: h.deviceName,
      browser: h.browser,
      os: h.os,
      location: h.location,
      success: h.success,
      method: h.method,
      createdAt: h.createdAt.toISOString(),
    })),
  });
});

/* ══════════════════════════════════════════════════════════════
   GET /auth/sessions
   List active sessions for the authenticated user.
══════════════════════════════════════════════════════════════ */
router.get("/sessions", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const sessions = await db
    .select()
    .from(userSessionsTable)
    .where(and(eq(userSessionsTable.userId, auth.userId), sql`revoked_at IS NULL`))
    .orderBy(desc(userSessionsTable.lastActiveAt));

  sendSuccess(res, {
    sessions: sessions.map(s => ({
      id: s.id,
      deviceName: s.deviceName,
      browser: s.browser,
      os: s.os,
      ip: s.ip,
      location: s.location,
      lastActiveAt: s.lastActiveAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
    })),
  });
});

/* ══════════════════════════════════════════════════════════════
   DELETE /auth/sessions/:id
   Revoke a single session (remote logout from one device).
══════════════════════════════════════════════════════════════ */
router.delete("/sessions/:id", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { id } = req.params;
  const [session] = await db
    .select()
    .from(userSessionsTable)
    .where(and(eq(userSessionsTable.id, id!), eq(userSessionsTable.userId, auth.userId)))
    .limit(1);

  if (!session) { sendNotFound(res, "Session not found"); return; }

  await db
    .update(userSessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(userSessionsTable.id, id!));

  /* Also revoke the linked refresh token if present */
  if (session.refreshTokenId) {
    await db
      .update(refreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokensTable.id, session.refreshTokenId));
  }

  writeAuthAuditLog("session_revoked", { userId: auth.userId, ip: getClientIp(req), metadata: { sessionId: id } });
  sendSuccess(res, undefined, "Session revoked");
});

/* ══════════════════════════════════════════════════════════════
   DELETE /auth/sessions — revoke ALL sessions (remote logout everywhere)
══════════════════════════════════════════════════════════════ */
router.delete("/sessions", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  await db
    .update(userSessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(userSessionsTable.userId, auth.userId), sql`revoked_at IS NULL`));

  await revokeAllUserRefreshTokens(auth.userId);

  /* Bump tokenVersion so all outstanding access JWTs are immediately invalid */
  await db
    .update(usersTable)
    .set({ tokenVersion: sql`token_version + 1`, updatedAt: new Date() })
    .where(eq(usersTable.id, auth.userId));

  writeAuthAuditLog("all_sessions_revoked", { userId: auth.userId, ip: getClientIp(req) });
  sendSuccess(res, undefined, "All sessions revoked");
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/link-google
   Link a Google account to the currently authenticated user.
   Body: { idToken: string }   (Google idToken from client)
══════════════════════════════════════════════════════════════ */
router.post("/link-google", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { idToken } = req.body;
  if (!idToken) { sendError(res, "idToken is required", 400); return; }

  const ip = getClientIp(req);

  try {
    /* Verify Google JWT signature by calling Google's tokeninfo endpoint */
    const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    if (!tokenInfoRes.ok) throw new Error("Token verification failed");
    const tokenInfo = await tokenInfoRes.json() as { sub?: string; email?: string };
    const googleId = tokenInfo.sub as string;
    const email = tokenInfo.email as string | undefined;

    if (!googleId) { sendError(res, "Could not extract Google ID from token", 400); return; }

    /* Check if another user already has this googleId */
    const [conflict] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.googleId, googleId), sql`id != ${auth.userId}`))
      .limit(1);

    if (conflict) {
      sendError(res, "This Google account is already linked to another user", 409);
      return;
    }

    const updates: Record<string, any> = { googleId, updatedAt: new Date() };
    if (email) updates["email"] = email;

    await db.update(usersTable).set(updates).where(eq(usersTable.id, auth.userId));

    addAuditEntry({ action: "google_account_linked", ip, details: `Google account linked: ${email ?? googleId}`, result: "success" });
    sendSuccess(res, undefined, "Google account linked successfully");
  } catch (err: any) {
    sendErrorWithData(res, "Invalid Google token", { detail: err.message }, 400);
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/link-facebook
   Link a Facebook account to the currently authenticated user.
   Body: { accessToken: string }
══════════════════════════════════════════════════════════════ */
router.post("/link-facebook", async (req, res) => {
  const auth = extractAuthUser(req);
  if (!auth) { sendUnauthorized(res, "Authentication required"); return; }

  const { accessToken } = req.body;
  if (!accessToken) { sendError(res, "accessToken is required", 400); return; }

  const ip = getClientIp(req);

  try {
    /* Fetch Facebook user info */
    const fbRes = await fetch(`https://graph.facebook.com/me?fields=id,email,name&access_token=${accessToken}`, { signal: AbortSignal.timeout(10000) });
    if (!fbRes.ok) { sendError(res, "Invalid Facebook access token", 400); return; }

    const fbPayload = await fbRes.json() as { id: string; email?: string; name?: string };
    const facebookId = fbPayload.id;

    if (!facebookId) { sendError(res, "Could not extract Facebook ID", 400); return; }

    /* Check conflict */
    const [conflict] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.facebookId, facebookId), sql`id != ${auth.userId}`))
      .limit(1);

    if (conflict) {
      sendError(res, "This Facebook account is already linked to another user", 409);
      return;
    }

    const updates: Record<string, any> = { facebookId, updatedAt: new Date() };
    if (fbPayload.email) updates["email"] = fbPayload.email;

    await db.update(usersTable).set(updates).where(eq(usersTable.id, auth.userId));

    addAuditEntry({ action: "facebook_account_linked", ip, details: `Facebook account linked: ${facebookId}`, result: "success" });
    sendSuccess(res, undefined, "Facebook account linked successfully");
  } catch (err: any) {
    sendErrorWithData(res, "Failed to link Facebook account", { detail: err.message }, 400);
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /auth/firebase-verify
   Verify a Firebase idToken and return a platform JWT.
   Enables Firebase Phone Auth / Google Sign-In as an alternative
   entry point that returns the same token format as OTP login.
   Body: { idToken: string, role?: string }
══════════════════════════════════════════════════════════════ */
router.post("/firebase-verify", async (req, res) => {
  const { idToken, role: requestedRole } = req.body;
  if (!idToken) { sendError(res, "idToken is required", 400); return; }

  if (requestedRole !== undefined && !["customer", "rider", "vendor"].includes(requestedRole)) {
    sendError(res, "Invalid role", 400);
    return;
  }

  const ip = getClientIp(req);

  /* Dynamic import — only works if FIREBASE_SERVICE_ACCOUNT_JSON is set */
  const { verifyFirebaseToken, setFirebaseCustomClaims } = await import("../../services/firebase.js");
  const decoded = await verifyFirebaseToken(idToken);

  if (!decoded) {
    sendUnauthorized(res, "Invalid or expired Firebase token. Ensure Firebase is configured on the server.");
    return;
  }

  /* Find user by firebaseUid, then by phone, then by email */
  let user: any = null;

  const [byUid] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.firebaseUid, decoded.uid))
    .limit(1);
  user = byUid;

  if (!user && decoded.phone) {
    const normalized = decoded.phone.replace(/\D/g, "").replace(/^92/, "0");
    const [byPhone] = await db.select().from(usersTable).where(eq(usersTable.phone, `0${normalized.slice(-10)}`)).limit(1);
    user = byPhone;
  }

  if (!user && decoded.email) {
    const [byEmail] = await db.select().from(usersTable).where(eq(usersTable.email, decoded.email)).limit(1);
    user = byEmail;
  }

  /* Auto-create if not found */
  if (!user) {
    const newId = generateId();
    const role = (requestedRole ?? "customer") as string;
    await db.insert(usersTable).values({
      id: newId,
      firebaseUid: decoded.uid,
      email: decoded.email ?? null,
      phone: decoded.phone ?? null,
      name: decoded.name ?? null,
      roles: role,
      emailVerified: decoded.email_verified ?? false,
      phoneVerified: !!decoded.phone,
    });
    const [created] = await db.select().from(usersTable).where(eq(usersTable.id, newId)).limit(1);
    user = created;
  } else if (!user.firebaseUid) {
    /* Link firebaseUid to existing account */
    await db.update(usersTable).set({ firebaseUid: decoded.uid, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    user.firebaseUid = decoded.uid;
  }

  if (!user.isActive || user.isBanned) {
    sendErrorWithData(res, "Account suspended", { reason: user.banReason ?? "Contact support" }, 403);
    return;
  }

  /* Set Firebase Custom Claims so next Firebase idToken refresh carries the role */
  setFirebaseCustomClaims(decoded.uid, { role: user.roles ?? "customer", roles: user.roles ?? "customer", userId: user.id }).catch(() => {});

  /* Issue platform tokens */
  const userAgent = req.headers["user-agent"] as string | undefined;
  const tokenData = await issueTokensForUser(user, ip, "firebase", userAgent, req, res);

  writeAuthAuditLog("firebase_login", { userId: user.id, ip, userAgent, metadata: { uid: decoded.uid } });

  const { passwordHash: _ph, otpCode: _otp, otpExpiry: _exp, emailOtpCode: _eotp, emailOtpExpiry: _eexp, totpSecret: _ts, backupCodes: _bc, ...safeUser } = user;
  sendSuccess(res, { ...tokenData, user: safeUser });
});

export default router;
