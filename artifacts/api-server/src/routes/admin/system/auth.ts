import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  usersTable,
  walletTransactionsTable,
  notificationsTable,
  adminAccountsTable,
  platformSettingsTable,
} from "@workspace/db/schema";
import {
  eq,
  desc,
  count,
  sum,
  and,
  gte,
  lte,
  sql,
  or,
  ilike,
  asc,
  isNull,
  isNotNull,
  avg,
  ne,
} from "drizzle-orm";
import {
  stripUser,
  generateId,
  getUserLanguage,
  t,
  getPlatformSettings,
  adminAuth,
  getAdminSecret,
  sendUserNotification,
  logger,
  ORDER_NOTIF_KEYS,
  RIDE_NOTIF_KEYS,
  PHARMACY_NOTIF_KEYS,
  PARCEL_NOTIF_KEYS,
  checkAdminLoginLockout,
  recordAdminLoginFailure,
  resetAdminLoginAttempts,
  addAuditEntry,
  addSecurityEvent,
  getClientIp,
  signAdminJwt,
  verifyAdminJwt,
  invalidateSettingsCache,
  getCachedSettings,
  ADMIN_TOKEN_TTL_HRS,
  verifyTotpToken,
  verifyAdminSecret,
  ensureDefaultRideServices,
  ensureDefaultLocations,
  formatSvc,
  type AdminRequest,
  adminLoginAttempts,
  ADMIN_MAX_ATTEMPTS,
} from "../../admin-shared.js";
import { hashAdminSecret } from "../../../services/password.js";
import { recordAdminPasswordSnapshot } from "../../../services/admin-password-watch.service.js";
import {
  generateTotpSecret,
  verifyTotpToken as verifyTotp,
  generateQRCodeDataURL,
  getTotpUri,
} from "../../../services/totp.js";
import { writeAuthAuditLog } from "../../../middleware/security.js";
import {
  sendSuccess,
  sendError,
  sendNotFound,
  sendForbidden,
  sendUnauthorized,
  sendValidationError,
} from "../../../lib/response.js";
import { UserService } from "../../../services/admin-user.service.js";
import { AuditService } from "../../../services/admin-audit.service.js";
import { requirePermission } from "../../../middleware/require-permission.js";
import { logAdminAudit } from "../../../middleware/admin-audit.js";
import { adminAuthLimiter } from "../../../middleware/rate-limit.js";
import { resolveAdminPermissions } from "../../../services/permissions.service.js";

const router = Router();

const createAdminAccountSchema = z.object({
  name:     z.string().min(1).max(100).optional(),
  username: z.string().min(1).max(100).optional(),
  password: z.string().min(8, "password must be at least 8 characters").optional(),
  secret:   z.string().min(8, "secret must be at least 8 characters").optional(),
  email:    z.union([z.string().email("Invalid email address").max(255), z.literal(""), z.null()]).optional(),
  role:     z.enum(["super", "manager", "support", "viewer", "custom"]).default("manager"),
}).strip()
  .refine(d => d.name || d.username, { message: "name or username is required" })
  .refine(d => d.password || d.secret, { message: "password or secret is required" });

const patchAdminAccountSchema = z.object({
  name:        z.string().min(1).max(100).optional(),
  username:    z.string().min(1).max(100).optional(),
  email:       z.union([z.string().email("Invalid email address").max(255), z.literal(""), z.null()]).optional(),
  role:        z.enum(["super", "manager", "support", "viewer", "custom"]).optional(),
  permissions: z.array(z.string()).optional(),
  isActive:    z.boolean().optional(),
  password:    z.string().min(8, "password must be at least 8 characters").optional(),
  secret:      z.string().min(8, "secret must be at least 8 characters").optional(),
}).strip();

router.post("/auth", adminAuthLimiter, async (req, res) => {
  const body = (req.body ?? {}) as { username?: string; password?: string; secret?: string; totpCode?: string };
  const username = (body.username ?? "").trim();
  /* Backwards-compatible: accept "password" (new) or "secret" (legacy) */
  const password = body.password ?? body.secret ?? "";
  const ip = getClientIp(req);
  const ADMIN_SECRET = await getAdminSecret();

  const lockout = checkAdminLoginLockout(ip);
  if (lockout.locked) {
    addSecurityEvent({
      type: "admin_login_locked",
      ip,
      details: `Locked admin login attempt from ${ip}`,
      severity: "high",
    });
    res
      .status(429)
      .json({
        error: `Too many failed attempts. Try again in ${lockout.minutesLeft} minute(s).`,
      });
    return;
  }

  /* ── Attempt master super-admin login ──
     Accepts:
       - new flow: username "admin" (or "super") + password = ADMIN_SECRET
       - legacy flow: any payload whose password equals ADMIN_SECRET (no username) */
  const isMasterUsername =
    username === "" || username.toLowerCase() === "admin" || username.toLowerCase() === "super";
  if (ADMIN_SECRET && password === ADMIN_SECRET && isMasterUsername) {
    resetAdminLoginAttempts(ip);

    /* ── Fix 5: Enforce TOTP for super admin when security_super_admin_mfa_required=on ──
       Read the platform setting. If enabled, verify the TOTP code or issue an
       MFA challenge token (same response shape as the standard MFA challenge). */
    const settings = await getCachedSettings();
    if (settings["security_super_admin_mfa_required"] === "on") {
      const masterTotpSecret = settings["admin_master_totp_secret"]?.trim();
      if (!masterTotpSecret) {
        // TOTP not yet configured for master admin — block login until it is set up.
        addAuditEntry({
          action: "admin_master_mfa_misconfigured",
          ip,
          details: "Super admin MFA required but admin_master_totp_secret is not configured",
          result: "fail",
        });
        res.status(403).json({
          error: "Super admin MFA is required but TOTP is not configured. Set admin_master_totp_secret in platform settings first.",
        });
        return;
      }

      const totpCode = (body.totpCode ?? "").trim();
      if (!totpCode) {
        /* No TOTP code provided — return a MFA challenge (same shape as sub-admin flow).
           The tempToken is a short-lived signed JWT the client echoes back alongside the TOTP. */
        const tempToken = signAdminJwt(null, "master_mfa_challenge", "Super Admin", 5 / 60);
        res.json({ requiresMfa: true, tempToken });
        return;
      }

      /* TOTP code provided — verify it against the stored master secret. */
      if (!verifyTotpToken(totpCode, masterTotpSecret)) {
        addAuditEntry({
          action: "admin_master_mfa_failed",
          ip,
          details: "Invalid TOTP code for master super-admin login",
          result: "fail",
        });
        addSecurityEvent({ type: "admin_master_mfa_failed", ip, details: "Master admin TOTP verification failed", severity: "high" });
        res.status(401).json({ error: "Invalid TOTP code. Please try again." });
        return;
      }
    }

    const adminToken = signAdminJwt(
      null,
      "super",
      "Super Admin",
      ADMIN_TOKEN_TTL_HRS,
    );
    addAuditEntry({
      action: "admin_login_success",
      ip,
      details: "Master admin login — JWT issued",
      result: "success",
    });
    writeAuthAuditLog("admin_login", {
      ip,
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { role: "super" },
    });
    res.json({
      success: true,
      token: adminToken,
      expiresIn: `${ADMIN_TOKEN_TTL_HRS}h`,
    });
    return;
  }

  /* ── Attempt sub-admin login via username + password ──
     Username matches `username` column (preferred) or falls back to `name`
     (case-insensitive). Password verified via bcrypt / legacy scrypt / plaintext. */
  const activeSubs2 = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.isActive, true));

  let candidates = activeSubs2;
  if (username) {
    const u = username.toLowerCase();
    candidates = activeSubs2.filter(
      (s) =>
        (s.username && s.username.toLowerCase() === u) ||
        s.name.toLowerCase() === u,
    );
  }
  const sub = candidates.find((s) => verifyAdminSecret(password, s.secret));

  if (sub) {
    resetAdminLoginAttempts(ip);
    const adminToken = signAdminJwt(
      sub.id,
      sub.role,
      sub.name,
      ADMIN_TOKEN_TTL_HRS,
    );
    await db
      .update(adminAccountsTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminAccountsTable.id, sub.id));
    addAuditEntry({
      action: "admin_login_success",
      ip,
      adminId: sub.id,
      details: `Sub-admin ${sub.name} login — JWT issued`,
      result: "success",
    });
    writeAuthAuditLog("admin_login", {
      ip,
      userAgent: req.headers["user-agent"] ?? undefined,
      metadata: { adminId: sub.id, role: sub.role },
    });
    res.json({
      success: true,
      token: adminToken,
      expiresIn: `${ADMIN_TOKEN_TTL_HRS}h`,
    });
    return;
  }

  recordAdminLoginFailure(ip);
  const rec = adminLoginAttempts.get(ip);
  const remaining = Math.max(0, ADMIN_MAX_ATTEMPTS - (rec?.count ?? 0));
  addAuditEntry({
    action: "admin_login_failed",
    ip,
    details: "Wrong admin secret",
    result: "fail",
  });
  addSecurityEvent({
    type: "admin_login_failed",
    ip,
    details: `Failed admin login attempt from ${ip}`,
    severity: "high",
  });
  if (remaining === 0) {
    res
      .status(429)
      .json({
        error: `Too many failed attempts. Account locked for 15 minutes.`,
      });
  } else {
    res
      .status(401)
      .json({
        error: `Invalid admin password. ${remaining} attempt(s) remaining.`,
      });
  }
});

router.use(adminAuth);
router.get("/admin-accounts", requirePermission("system.roles.manage"), async (_req, res) => {
  try {
    const accounts = await db
      .select({
        id: adminAccountsTable.id,
        name: adminAccountsTable.name,
        username: adminAccountsTable.username,
        email: adminAccountsTable.email,
        role: adminAccountsTable.role,
        permissions: adminAccountsTable.permissions,
        isActive: adminAccountsTable.isActive,
        mustChangePassword: adminAccountsTable.mustChangePassword,
        lastLoginAt: adminAccountsTable.lastLoginAt,
        createdAt: adminAccountsTable.createdAt,
      })
      .from(adminAccountsTable)
      .orderBy(desc(adminAccountsTable.createdAt));
    res.json({
      accounts: accounts.map((a) => ({
        ...a,
        lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error({ err }, "[admin/system/auth] list admin accounts error");
    sendError(res, "Failed to load admin accounts", 500);
  }
});

router.post("/admin-accounts", requirePermission("system.roles.manage"), async (req, res) => {
  const adminReq = req as AdminRequest;

  const parsed = createAdminAccountSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => e.message).join("; ");
    sendValidationError(res, msg);
    return;
  }
  const data = parsed.data;

  /* Accept both new ("username"/"password") and legacy ("name"/"secret") shapes */
  const name = data.name ?? data.username;
  const password = data.password ?? data.secret;
  const usernameField = data.username ?? data.name;
  const emailField = (data.email && data.email !== "") ? data.email.trim().toLowerCase() : null;

  if (!name || !password) {
    sendValidationError(res, "name or username and password or secret are required");
    return;
  }
  if (password === (await getAdminSecret())) {
    sendError(res, "Cannot use the master secret", 400);
    return;
  }

  try {
    await AuditService.executeWithAudit(
      {
        adminId: adminReq.adminId,
        adminName: adminReq.adminName,
        adminIp: adminReq.adminIp || getClientIp(req),
        action: "admin_account_create",
        resourceType: "admin_account",
        resource: name,
        details: `Role: ${data.role}`,
      },
      () =>
        UserService.createAdminAccount({
          name,
          username: usernameField,
          email: emailField,
          secret: password,
          role: data.role,
        }),
    );

    sendSuccess(res, { success: true, adminName: name }, undefined, 201);
  } catch (error: unknown) {
    logger.error({ err: error }, "[admin/system/auth] create admin account error");
    const isDuplicate =
      (error instanceof Error && (error.message.includes("23505") || error.message.includes("duplicate")));
    if (isDuplicate) {
      sendError(res, "Admin name or username already in use", 409);
    } else {
      sendError(res, "An internal error occurred", 500);
    }
  }
});

router.patch("/admin-accounts/:id", async (req, res) => {
  const parsed = patchAdminAccountSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    const msg = parsed.error.errors.map(e => e.message).join("; ");
    sendValidationError(res, msg);
    return;
  }
  const data = parsed.data;
  const targetId = req.params["id"]!;
  const adminReq = req as AdminRequest;
  const isSelfEdit = adminReq.adminId === targetId;

  // Self-edits of own credentials/profile (name, username, email, password)
  // are permitted without system.roles.manage. Editing another account or
  // touching privileged fields (role / permissions / isActive) always requires it.
  const requiresRolesPermission =
    !isSelfEdit ||
    data.role !== undefined ||
    data.permissions !== undefined ||
    data.isActive !== undefined;

  try {
    if (requiresRolesPermission && adminReq.adminRole !== "super") {
      const perms: string[] =
        Array.isArray(adminReq.adminPermissions) && adminReq.adminPermissions.length > 0
          ? adminReq.adminPermissions
          : await resolveAdminPermissions(adminReq.adminId ?? null, adminReq.adminRole);
      if (!perms.includes("system.roles.manage")) {
        res.status(403).json({
          success: false,
          error: "Forbidden",
          detail: "Missing permission: system.roles.manage",
          code: "PERMISSION_DENIED",
          required: ["system.roles.manage"],
        });
        return;
      }
    }

    const updates: Record<string, unknown> = {};
    if (data.name     !== undefined) updates.name     = data.name;
    if (data.username !== undefined) updates.username = data.username;
    if (data.email    !== undefined) {
      updates.email = (data.email === null || data.email === "")
        ? null
        : data.email.trim().toLowerCase();
    }
    if (data.role        !== undefined) updates.role        = data.role;
    if (data.permissions !== undefined) updates.permissions = data.permissions;
    if (data.isActive    !== undefined) updates.isActive    = data.isActive;

    const newPassword = data.password ?? data.secret;
    if (newPassword !== undefined) {
      if (newPassword === (await getAdminSecret())) {
        sendError(res, "Cannot use the master secret", 400);
        return;
      }
      updates.secret = hashAdminSecret(newPassword);
    }

    // The optional "still using default credentials" marker is cleared as
    // soon as the admin self-edits their username or password (the two
    // surfaces the first-login popup exposes). Edits performed by another
    // super-admin do not touch the flag — that is genuinely a different
    // operator's account.
    if (isSelfEdit && (updates.username !== undefined || updates.secret !== undefined)) {
      updates.defaultCredentials = false;
    }

    const [account] = await db
      .update(adminAccountsTable)
      .set(updates)
      .where(eq(adminAccountsTable.id, targetId))
      .returning();
    if (!account) {
      sendNotFound(res, "Admin account not found");
      return;
    }

    // If a password was set on this PATCH, refresh the watchdog snapshot so the
    // legitimate super-admin edit is not later misclassified as an out-of-band
    // direct DB write on the next startup scan.
    if (updates.secret) {
      await recordAdminPasswordSnapshot({
        adminId: account.id,
        secret: updates.secret as string,
        passwordChangedAt: new Date(),
      });
    }

    res.json({
      ...account,
      secret: "••••••",
      createdAt: account.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "[admin/system/auth] patch admin account error");
    sendError(res, "An internal error occurred", 500);
  }
});

router.delete("/admin-accounts/:id", requirePermission("system.roles.manage"), async (req, res) => {
  try {
    await db
      .delete(adminAccountsTable)
      .where(eq(adminAccountsTable.id, req.params["id"]!));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "[admin/system/auth] delete admin account error");
    sendError(res, "Failed to delete admin account", 500);
  }
});

/**
 * POST /api/admin/system/admin-accounts/:id/send-reset-link
 *
 * Super-admin action: issue a single-use password reset link for the
 * specified admin and email it to them. Returns the (already-emailed) URL
 * to the caller in non-production environments so the operator can copy it
 * out-of-band when SMTP is not configured.
 */
router.post(
  "/admin-accounts/:id/send-reset-link",
  // Identity-management action: gated behind the same RBAC permission used
  // for managing roles/admin identities. requirePermission auto-passes
  // super admins, so this preserves the existing super-admin entry point
  // while allowing fine-grained delegation later via RBAC.
  requirePermission("system.roles.manage"),
  async (req, res) => {
  const adminReq = req as AdminRequest;

  const targetId = req.params["id"]!;
  const [target] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, targetId))
    .limit(1);

  if (!target) {
    res.status(404).json({ success: false, error: "Admin account not found" });
    return;
  }
  if (!target.isActive) {
    res.status(400).json({
      success: false,
      error: "Cannot send a reset link to an inactive admin account.",
    });
    return;
  }
  if (!target.email) {
    res.status(400).json({
      success: false,
      error: "Target admin has no email on file. Set an email first.",
    });
    return;
  }

  const ip = adminReq.adminIp || getClientIp(req);
  const userAgent = req.headers["user-agent"] ?? null;

  // Lazy-load to avoid a circular import at module init.
  const { issueAdminPasswordResetToken } = await import(
    "../../../services/admin-password.service.js"
  );
  const { sendAdminPasswordResetLinkEmail } = await import(
    "../../../services/email.js"
  );

  const issued = await issueAdminPasswordResetToken({
    adminId: target.id,
    requestedBy: "super_admin",
    requesterAdminId: adminReq.adminId ?? null,
    requesterIp: ip,
    requesterUserAgent: userAgent,
  });

  // Force the target admin to choose a new password on their next sign-in,
  // even if they don't click the emailed link. This makes the action a real
  // "lockout + reset" rather than just an out-of-band suggestion.
  await db
    .update(adminAccountsTable)
    .set({ mustChangePassword: true })
    .where(eq(adminAccountsTable.id, target.id));

  // Build the reset URL (mirrors the public flow).
  const base =
    process.env.ADMIN_BASE_URL ||
    process.env.APP_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}/admin`
      : "http://localhost:5000/admin");
  const resetUrl = `${base.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(
    issued.rawToken,
  )}`;

  const sendResult = await sendAdminPasswordResetLinkEmail(target.email, {
    resetUrl,
    recipientName: target.name,
    expiresAt: issued.expiresAt,
  }).catch((err) => ({ sent: false, reason: (err as Error).message }));

  // Funnel into the same admin_audit_log stream the rest of the password
  // lifecycle uses (forgot/reset/change-password) so security teams have a
  // single sink to read.
  await logAdminAudit("admin_password_reset_link_sent", {
    adminId: target.id,
    ip,
    userAgent: userAgent ?? undefined,
    result: sendResult.sent ? "success" : "failure",
    reason: sendResult.sent ? undefined : sendResult.reason,
    metadata: {
      issuedBy: adminReq.adminId ?? null,
      issuedByName: adminReq.adminName ?? null,
      targetEmail: target.email,
      tokenId: issued.id,
      expiresAt: issued.expiresAt.toISOString(),
    },
  });

  res.json({
    success: true,
    sent: sendResult.sent,
    reason: sendResult.sent ? undefined : sendResult.reason,
    expiresAt: issued.expiresAt.toISOString(),
    // Reveal the URL only in non-production so a super-admin can copy it
    // when SMTP is not yet wired up. Production never echoes the token.
    resetUrl: process.env.NODE_ENV === "production" ? undefined : resetUrl,
  });
  },
);

/* ── Fix 6: Rotate master secret at runtime (no server restart required) ── */
router.post("/rotate-secret", adminAuth, async (req, res) => {
  const adminRole = (req as AdminRequest).adminRole;
  if (adminRole !== "super") {
    res.status(403).json({ error: "Only super admin can rotate the master secret." });
    return;
  }

  const ip = getClientIp(req);

  /* Generate a new cryptographically strong secret (48 bytes = 96 hex chars). */
  const { randomBytes } = await import("crypto");
  const newSecret = randomBytes(48).toString("hex");

  /* 1. Update the in-memory runtime variable immediately so subsequent logins
        use the new secret without waiting for a restart. */
  const { setAdminSecretRuntime } = await import("../../../lib/runtime-config.js");
  setAdminSecretRuntime(newSecret);

  /* 2. Persist to platform_settings under "admin_secret_override" so the new
        secret survives a server restart (seeded by seedRuntimeConfigFromDb()). */
  try {
    await db
      .insert(platformSettingsTable)
      .values({ key: "admin_secret_override", value: newSecret, category: "security", label: "Admin Secret Override" })
      .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value: newSecret, updatedAt: new Date() } });
    invalidateSettingsCache();
  } catch (persistErr) {
    logger.warn({ err: persistErr }, "[rotate-secret] Failed to persist new secret to DB — in-memory only until restart");
  }

  /* 3. Send email notification to all active admins. */
  try {
    const { sendEmail } = await import("../../../services/email.js");
    const activeAdmins = await db.select({ email: adminAccountsTable.email, name: adminAccountsTable.name })
      .from(adminAccountsTable)
      .where(eq(adminAccountsTable.isActive, true));
    const recipients = activeAdmins.filter(a => a.email);
    const rotatedAt = new Date().toISOString();
    await Promise.allSettled(
      recipients.map(a =>
        sendEmail({
          to: a.email!,
          subject: "Security Alert: Admin Master Secret Rotated",
          html: `<p>Hello ${a.name},</p><p>The AJKMart admin master secret has been <strong>rotated</strong> by a super-admin on ${rotatedAt} from IP <code>${ip}</code>.</p><p>If you did not authorise this action, please investigate immediately.</p>`,
        })
      )
    );
  } catch (emailErr) {
    logger.warn({ err: emailErr }, "[rotate-secret] Email notification failed — rotation still applied");
  }

  addAuditEntry({
    action: "admin_secret_rotated",
    ip,
    details: "Master admin secret rotated at runtime — in-memory and DB updated",
    result: "success",
  });
  writeAuthAuditLog("admin_secret_rotation", {
    ip,
    metadata: { note: "Secret rotated in-memory and persisted to platform_settings" },
  });

  res.json({
    success: true,
    message: "Master secret rotated successfully. All active admins have been notified by email. No restart required.",
    rotatedAt: new Date().toISOString(),
  });
});

router.get("/me/language", adminAuth, async (req, res) => {
  const adminId = req.adminId;
  if (!adminId) {
    res.json({ language: null });
    return;
  }
  const [admin] = await db
    .select({ language: adminAccountsTable.language })
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);
  res.json({ language: admin?.language ?? null });
});

/* PUT /admin/me/language — save current admin's language preference */
router.put("/me/language", adminAuth, async (req, res) => {
  const adminId = req.adminId;
  if (!adminId) {
    res.json({
      success: false,
      note: "Super admin language is managed locally",
    });
    return;
  }
  const { language } = req.body as { language?: string };
  if (!language) {
    res.status(400).json({ error: "language required" });
    return;
  }
  const VALID = new Set(["en", "ur", "roman", "en_roman", "en_ur"]);
  if (!VALID.has(language)) {
    res.status(400).json({ error: "Invalid language" });
    return;
  }
  await db
    .update(adminAccountsTable)
    .set({ language })
    .where(eq(adminAccountsTable.id, adminId));
  res.json({ success: true, language });
});

/* GET /admin/mfa/status — check if MFA is set up for the current sub-admin */
router.get("/mfa/status", adminAuth, async (req, res) => {
  const adminId = req.adminId!;
  if (!adminId) {
    res.json({ mfaEnabled: false, note: "Super admin does not use TOTP." });
    return;
  }
  const [admin] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);
  if (!admin) {
    res.status(404).json({ error: "Admin account not found" });
    return;
  }
  res.json({
    mfaEnabled: admin.totpEnabled,
    totpConfigured: !!admin.totpSecret,
  });
});

/* POST /admin/mfa/setup — generate a TOTP secret and QR code (step 1 of MFA setup) */
router.post("/mfa/setup", adminAuth, async (req, res) => {
  const adminId = req.adminId!;
  const adminName = req.adminName! ?? "Admin";
  if (!adminId) {
    res.status(400).json({ error: "Super admin does not need TOTP setup." });
    return;
  }

  const secret = generateTotpSecret();
  const qrCodeUrl = await generateQRCodeDataURL(secret, adminName);
  const otpUri = getTotpUri(secret, adminName);

  /* Store secret but don't enable TOTP yet — must be verified first */
  await db
    .update(adminAccountsTable)
    .set({ totpSecret: secret, totpEnabled: false })
    .where(eq(adminAccountsTable.id, adminId));

  addAuditEntry({
    action: "mfa_setup_initiated",
    ip: req.adminIp!,
    adminId,
    details: `MFA setup started for ${adminName}`,
    result: "success",
  });

  res.json({
    secret,
    otpUri,
    qrCodeDataUrl: qrCodeUrl,
    instructions:
      "Scan the QR code with Google Authenticator or Authy. Then call POST /admin/mfa/verify with a valid token to activate MFA.",
  });
});

/* POST /admin/mfa/verify — verify a TOTP token to activate MFA */
router.post("/mfa/verify", adminAuth, async (req, res) => {
  const adminId = req.adminId!;
  const adminName = req.adminName! ?? "Admin";
  if (!adminId) {
    res.status(400).json({ error: "Super admin does not use TOTP." });
    return;
  }

  const { token } = req.body as { token: string };
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  const [admin] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);
  if (!admin || !admin.totpSecret) {
    res
      .status(400)
      .json({
        error: "TOTP not set up yet. Call POST /admin/mfa/setup first.",
      });
    return;
  }

  if (admin.totpEnabled) {
    res.json({ success: true, message: "MFA is already active." });
    return;
  }

  const valid = verifyTotpToken(token, admin.totpSecret);
  if (!valid) {
    addAuditEntry({
      action: "mfa_verify_failed",
      ip: req.adminIp!,
      adminId,
      details: `MFA verify failed for ${adminName}`,
      result: "fail",
    });
    res.status(401).json({ error: "Invalid TOTP token. Please try again." });
    return;
  }

  await db
    .update(adminAccountsTable)
    .set({ totpEnabled: true })
    .where(eq(adminAccountsTable.id, adminId));

  addAuditEntry({
    action: "mfa_activated",
    ip: req.adminIp!,
    adminId,
    details: `MFA activated for ${adminName}`,
    result: "success",
  });

  res.json({
    success: true,
    message:
      "MFA successfully activated. You must now provide x-admin-totp with every request when global MFA is enabled.",
  });
});

/* DELETE /admin/mfa/disable — disable MFA (requires current valid TOTP or super admin) */
router.delete("/mfa/disable", adminAuth, async (req, res) => {
  const adminId = req.adminId!;
  const adminName = req.adminName! ?? "Admin";
  if (!adminId) {
    res.status(400).json({ error: "Super admin does not use TOTP." });
    return;
  }

  const { token } = req.body as { token?: string };
  const [admin] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);
  if (!admin) {
    res.status(404).json({ error: "Admin not found" });
    return;
  }

  if (admin.totpEnabled && admin.totpSecret) {
    if (!token || !verifyTotpToken(token, admin.totpSecret)) {
      res
        .status(401)
        .json({ error: "Valid TOTP token required to disable MFA." });
      return;
    }
  }

  await db
    .update(adminAccountsTable)
    .set({ totpSecret: null, totpEnabled: false })
    .where(eq(adminAccountsTable.id, adminId));

  addAuditEntry({
    action: "mfa_disabled",
    ip: req.adminIp!,
    adminId,
    details: `MFA disabled for ${adminName}`,
    result: "warn",
  });

  res.json({
    success: true,
    message: "MFA has been disabled for your account.",
  });
});

export default router;
