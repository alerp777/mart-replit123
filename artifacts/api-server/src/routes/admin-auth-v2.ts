/**
 * Enhanced Admin Authentication Routes (v2)
 * Implements production-grade authentication with:
 * - HttpOnly refresh tokens with cookie-based storage
 * - 15-minute access tokens (in-memory on frontend)
 * - MFA/TOTP support
 * - Session management with rotation and revocation
 * - CSRF protection
 * - Comprehensive audit logging
 * - Forgot-password / reset-password flow with single-use, time-limited
 *   tokens and audit logging
 * - Force-password-change flow gated by the `mpc` JWT claim
 *
 * Reference: /workspaces/mart/artifacts/admin/admin-login-guide.md
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../lib/logger.js';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '@workspace/db';
import { adminAccountsTable, usersTable, ordersTable, walletTransactionsTable } from '@workspace/db/schema';
import { eq, count, and, sql } from 'drizzle-orm';
import {
  adminLogin,
  verify2fa,
  createAdminSession,
  refreshAdminSession,
  logoutAdminSession,
  getAdminActiveSessions,
  revokeAllAdminSessions,
} from '../services/admin-auth.service.js';
import {
  issueAdminPasswordResetToken,
  verifyAdminPasswordResetToken,
  completeAdminPasswordReset,
  changeAdminPassword,
} from '../services/admin-password.service.js';
import { sendAdminPasswordResetLinkEmail } from '../services/email.js';
import {
  authenticateAdmin,
  csrfProtection,
} from '../middleware/admin-auth.js';
import {
  getClientIp,
  logAdminAudit,
} from '../middleware/admin-audit.js';
import { verify2faChallengeToken } from '../utils/admin-jwt.js';
import { verifyRefreshToken } from '../utils/admin-jwt.js';
import { adminAuthLimiter } from '../middleware/rate-limit.js';

const router = Router();

// Rate limiting for login attempts: max 5 failed attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failures
  keyGenerator: (req) => getClientIp(req),
});

// Rate limiting for 2FA verification: max 5 failed attempts per 15 minutes per IP
const verifyTotpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too many 2FA verification attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failures
  keyGenerator: (req) => getClientIp(req),
});

/**
 * Forgot-password is intentionally aggressive on rate limiting because it
 * accepts an arbitrary email and emits an email if the email matches an
 * admin account. Per-IP limit prevents enumeration / mass spam; the response
 * is always a generic success regardless of whether the email exists.
 */
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { error: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});

/**
 * Reset-password (token consumption) is rate-limited per IP to prevent
 * brute-forcing the 64-hex-char token space. The token itself is high
 * entropy, but a hard cap is cheap insurance.
 */
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many reset attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});

const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many password change attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});

// Validation schemas
const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
}).strict();

const twoFaSchema = z.object({
  tempToken: z.string().min(1, 'Temporary token is required'),
  totp: z.string().length(6, 'TOTP must be 6 digits').regex(/^\d{6}$/, 'TOTP must be numeric'),
}).strict();

const forgotPasswordSchema = z.object({
  email: z.string().email('A valid email address is required').max(254),
}).strict();

const resetPasswordSchema = z.object({
  token: z.string().min(32).max(256),
  newPassword: z.string().min(8).max(256),
}).strict();

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(256),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(256),
}).strict();

/** Build a user-facing reset URL pointing at the admin SPA. */
function buildAdminResetUrl(rawToken: string): string {
  /* Priority: explicit admin URL → generic app base URL → Replit dev domain (fallback) → localhost */
  const replitFallback = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/admin`
    : null;
  const base =
    process.env.ADMIN_BASE_URL ||
    process.env.APP_BASE_URL ||
    replitFallback ||
    "http://localhost:5000/admin";
  // Trim trailing slash and append the SPA route. The admin SPA exposes a
  // wouter route at `/reset-password` that consumes ?token=...
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/**
 * POST /api/admin/auth/login
 * Login with username and password
 * Returns: access token, user info, or MFA challenge
 *
 * CSRF exemption: pre-authentication endpoint. No session or CSRF token exists
 * yet — enforcing CSRF here would block legitimate unauthenticated logins. The
 * combination of rate-limiting + password verification provides equivalent
 * protection against CSRF-based credential-stuffing.
 */
router.post('/auth/login', adminAuthLimiter, loginLimiter, async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'];

  try {
    const body = loginSchema.parse(req.body);

    // Perform login
    const result = await adminLogin(body.username, body.password, ip, userAgent);

    if (!result.success) {
      await logAdminAudit('admin_login_failed', {
        ip,
        userAgent,
        result: 'failure',
        reason: result.error,
      });
      res.status(401).json({ error: result.error }); return;
    }

    // If MFA is required
    if (result.requiresMfa && result.tempToken) {
      await logAdminAudit('admin_login_mfa_required', {
        adminId: result.admin?.id,
        ip,
        userAgent,
        result: 'success',
      });

      res.json({
        requiresMfa: true,
        tempToken: result.tempToken,
        message: 'Please provide your TOTP code',
      }); return;
    }

    // No MFA - create session
    const admin = result.admin!;
    const session = await createAdminSession(admin, ip, userAgent);

    // Set secure cookies
    res.cookie('refresh_token', session.refreshToken, {
      httpOnly: true, // Cannot be accessed from JavaScript
      secure: process.env.NODE_ENV === 'production', // Only send over HTTPS in production
      sameSite: 'strict', // CSRF protection
      path: '/api/admin/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.cookie('csrf_token', session.csrfToken, {
      httpOnly: false, // Frontend needs to read this for X-CSRF-Token header
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    await logAdminAudit('admin_login_success', {
      adminId: admin.id,
      ip,
      userAgent,
      result: 'success',
      metadata: { mustChangePassword: !!admin.mustChangePassword },
    });

    res.json({
      accessToken: session.accessToken,
      user: {
        id: admin.id,
        name: admin.name,
        username: admin.username,
        email: admin.email || admin.username || admin.name,
        role: admin.role,
        mustChangePassword: !!admin.mustChangePassword,
        usingDefaultCredentials: !!admin.defaultCredentials,
      },
      mustChangePassword: !!admin.mustChangePassword,
      usingDefaultCredentials: !!admin.defaultCredentials,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Invalid request',
        details: err.errors,
      });
      return;
    }

    logger.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/auth/2fa
 * Verify TOTP and complete login
 *
 * CSRF exemption: pre-authentication MFA step. The caller holds only a short-lived
 * tempToken (not a session cookie), so no CSRF token can have been issued yet.
 * The tempToken itself acts as a bound proof-of-login-attempt.
 */
router.post('/auth/2fa', adminAuthLimiter, verifyTotpLimiter, async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'];

  try {
    const body = twoFaSchema.parse(req.body);

    // Verify temp token
    let adminId: string;
    try {
      const payload = verify2faChallengeToken(body.tempToken);
      adminId = payload.sub;
    } catch (err) {
      await logAdminAudit('admin_2fa_failed_invalid_token', {
        ip,
        userAgent,
        result: 'failure',
        reason: 'Invalid temporary token',
      });
      res.status(401).json({ error: 'Temporary token expired or invalid' }); return;
    }

    // Verify TOTP
    const mfaResult = await verify2fa(adminId, body.totp, ip, userAgent);
    if (!mfaResult.success) {
      await logAdminAudit('admin_2fa_failed_invalid_code', {
        adminId,
        ip,
        userAgent,
        result: 'failure',
        reason: 'Invalid TOTP code',
      });
      res.status(401).json({ error: mfaResult.error }); return;
    }

    // Create session
    const admin = mfaResult.admin!;
    const session = await createAdminSession(admin, ip, userAgent);

    // Set secure cookies
    res.cookie('refresh_token', session.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/admin/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.cookie('csrf_token', session.csrfToken, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    await logAdminAudit('admin_2fa_success', {
      adminId: admin.id,
      ip,
      userAgent,
      result: 'success',
      metadata: { mustChangePassword: !!admin.mustChangePassword },
    });

    res.json({
      accessToken: session.accessToken,
      user: {
        id: admin.id,
        name: admin.name,
        username: admin.username,
        email: admin.email || admin.username || admin.name,
        role: admin.role,
        mustChangePassword: !!admin.mustChangePassword,
        usingDefaultCredentials: !!admin.defaultCredentials,
      },
      mustChangePassword: !!admin.mustChangePassword,
      usingDefaultCredentials: !!admin.defaultCredentials,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'Invalid request',
        details: err.errors,
      });
      return;
    }

    logger.error('2FA verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/auth/refresh
 * Refresh access token using refresh token cookie
 * Implements token rotation for enhanced security
 *
 * CSRF exemption: the refresh token is stored as SameSite=Strict; HttpOnly, so
 * a cross-origin attacker page cannot trigger a request that carries the cookie.
 * SameSite=Strict provides equivalent CSRF protection for this cookie-only endpoint.
 * No JSON body parameters carry any privileged side effects — the only input is the
 * HttpOnly cookie which browsers will not attach from a third-party context.
 */
router.post('/auth/refresh', async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'];
  const refreshToken = req.cookies.refresh_token;

  if (!refreshToken) {
    res.status(401).json({
      error: 'No refresh token found',
      code: 'REFRESH_MISSING',
    });
    return;
  }

  const result = await refreshAdminSession(refreshToken, ip, userAgent);

  if (!result.success) {
    res.clearCookie('refresh_token', { path: '/api/admin/auth' });
    res.clearCookie('csrf_token', { path: '/' });

    await logAdminAudit('admin_refresh_failed', {
      ip,
      userAgent,
      result: 'failure',
      reason: result.error,
    });

    res.status(401).json({
      error: result.error,
      code: 'REFRESH_INVALID',
    });
    return;
  }

  // Update cookies with new tokens (rotation)
  res.cookie('refresh_token', result.refreshToken!, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/admin/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.cookie('csrf_token', result.csrfToken!, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  await logAdminAudit('admin_refresh_success', {
    adminId: result.admin?.id,
    ip,
    userAgent,
    result: 'success',
  });

  res.json({
    accessToken: result.accessToken,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    mustChangePassword: !!result.admin?.mustChangePassword,
    usingDefaultCredentials: !!result.admin?.defaultCredentials,
    user: result.admin
      ? {
          id: result.admin.id,
          name: result.admin.name,
          username: result.admin.username,
          email: result.admin.email || result.admin.username || result.admin.name,
          role: result.admin.role,
          mustChangePassword: !!result.admin.mustChangePassword,
          usingDefaultCredentials: !!result.admin.defaultCredentials,
        }
      : undefined,
  });
});

/**
 * GET /api/admin/auth/me
 * Return the authenticated admin's profile (used by the SPA to learn whether
 * the must-change-password flag is set on the current session).
 */
router.get('/auth/me', authenticateAdmin, async (req: Request, res: Response) => {
  const adminId = req.admin?.sub;
  if (!adminId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const [admin] = await db
    .select()
    .from(adminAccountsTable)
    .where(eq(adminAccountsTable.id, adminId))
    .limit(1);

  if (!admin) { res.status(404).json({ error: 'Admin not found' }); return; }

  res.json({
    user: {
      id: admin.id,
      name: admin.name,
      email: admin.email || admin.username || admin.name,
      username: admin.username,
      role: admin.role,
      mustChangePassword: !!admin.mustChangePassword,
      usingDefaultCredentials: !!admin.defaultCredentials,
      passwordChangedAt: admin.passwordChangedAt?.toISOString() ?? null,
    },
    mustChangePassword: !!admin.mustChangePassword,
    usingDefaultCredentials: !!admin.defaultCredentials,
  });
});

/**
 * POST /api/admin/auth/logout
 * Logout and revoke current session
 */
router.post(
  '/auth/logout',
  authenticateAdmin,
  csrfProtection,
  async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'];
    const adminId = req.admin?.sub;
    const refreshToken = req.cookies.refresh_token;

    // Revoke session
    if (refreshToken) {
      try {
        const payload = verifyRefreshToken(refreshToken);
        await logoutAdminSession(payload.sessionId);
      } catch (err) {
        // Token might be invalid, continue anyway
      }
    }

    // Clear cookies
    res.clearCookie('refresh_token', { path: '/api/admin/auth' });
    res.clearCookie('csrf_token', { path: '/' });

    await logAdminAudit('admin_logout', {
      adminId,
      ip,
      userAgent,
      result: 'success',
    });

    res.json({ success: true, message: 'Logged out successfully' });
  }
);

/**
 * POST /api/admin/auth/forgot-password
 * Public endpoint. Always returns a generic success response so callers
 * cannot enumerate which admin emails exist. When the email matches an
 * active admin account we issue a single-use, 30-minute reset token and
 * email the link via the platform's email service.
 *
 * CSRF exemption: unauthenticated endpoint. No session exists at the point
 * this is called; the user has simply entered their email on the login screen.
 * The response is always identical regardless of email existence (oracle-blind),
 * making a CSRF attack against this endpoint entirely useless.
 */
router.post(
  '/auth/forgot-password',
  adminAuthLimiter,
  forgotPasswordLimiter,
  async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    // Generic response — never leaks whether the email exists.
    const genericResponse = {
      success: true,
      message: 'If that email is associated with an admin account, a password reset link has been sent.',
    };

    // Always return the same generic success — even on a malformed/missing
    // email payload — so this endpoint cannot be used as an oracle to learn
    // anything about the system (account existence, validation rules, etc.).
    // Malformed inputs are still audited so brute-force probes leave a trail.
    const parseResult = forgotPasswordSchema.safeParse(req.body);
    if (!parseResult.success) {
      await logAdminAudit('admin_forgot_password_invalid_payload', {
        ip,
        userAgent,
        result: 'failure',
        reason: 'Malformed forgot-password payload',
        metadata: { issues: parseResult.error.errors.map((e) => e.message) },
      });
      res.json(genericResponse); return;
    }
    const parsed = parseResult.data;

    const email = parsed.email.trim().toLowerCase();

    try {
      const [admin] = await db
        .select()
        .from(adminAccountsTable)
        .where(eq(adminAccountsTable.email, email))
        .limit(1);

      if (!admin || !admin.isActive) {
        // Audit the miss (no adminId) so brute-forcing leaves a trail.
        await logAdminAudit('admin_forgot_password_unknown', {
          ip,
          userAgent,
          result: 'failure',
          reason: 'No active admin matched the supplied email',
          metadata: { email },
        });
        res.json(genericResponse); return;
      }

      const issued = await issueAdminPasswordResetToken({
        adminId: admin.id,
        requestedBy: 'self',
        requesterIp: ip,
        requesterUserAgent: userAgent ?? null,
      });

      const resetUrl = buildAdminResetUrl(issued.rawToken);

      const sendResult = await sendAdminPasswordResetLinkEmail(admin.email!, {
        resetUrl,
        recipientName: admin.name,
        expiresAt: issued.expiresAt,
      }).catch((err) => {
        logger.error('[admin-auth-v2] sendAdminPasswordResetLinkEmail threw:', err);
        return { sent: false, reason: (err as Error).message };
      });

      await logAdminAudit('admin_forgot_password_issued', {
        adminId: admin.id,
        ip,
        userAgent,
        result: sendResult.sent ? 'success' : 'failure',
        reason: sendResult.sent ? undefined : sendResult.reason,
        metadata: {
          requestedBy: 'self',
          tokenId: issued.id,
          expiresAt: issued.expiresAt.toISOString(),
        },
      });

      res.json(genericResponse); return;
    } catch (err) {
      logger.error('[admin-auth-v2] forgot-password failed:', err);
      // Still return the generic response — never expose internal failures.
      res.json(genericResponse); return;
    }
  },
);

/**
 * GET /api/admin/auth/reset-password/validate?token=...
 *
 * Public endpoint. Lets the reset-password page check whether the token
 * embedded in the link is still valid before the user fills out the form,
 * so we can show a clean "this link expired / was already used" screen
 * instead of failing on submit.
 *
 * The token itself is never echoed back. Only `valid: true|false` and a
 * machine-readable `reason` are returned. Read-only — the token is NOT
 * consumed by this endpoint.
 */
router.get(
  '/auth/reset-password/validate',
  adminAuthLimiter,
  resetPasswordLimiter,
  async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    const raw = req.query['token'];
    const token = typeof raw === 'string' ? raw : '';
    if (!token) {
      res.status(400).json({ valid: false, reason: 'missing_token' });
      return;
    }

    const verified = await verifyAdminPasswordResetToken(token);
    if (!verified) {
      await logAdminAudit('admin_reset_password_validate', {
        ip,
        userAgent,
        result: 'failure',
        reason: 'Token missing, expired, used, or admin inactive',
      });
      res.status(200).json({ valid: false, reason: 'invalid_or_expired' });
      return;
    }

    await logAdminAudit('admin_reset_password_validate', {
      adminId: verified.admin.id,
      ip,
      userAgent,
      result: 'success',
      metadata: { tokenId: verified.token.id },
    });

    res.json({
      valid: true,
      expiresAt: verified.token.expiresAt.toISOString(),
      adminName: verified.admin.name,
    });
  },
);

/**
 * POST /api/admin/auth/reset-password
 * Public endpoint. Consumes a reset token and replaces the admin's password.
 * Single-use; revokes every session on success so the admin must log in
 * again with the new password.
 *
 * CSRF exemption: the reset token itself (64-char cryptographic random) is the
 * proof-of-intent. An attacker would need to know the token (delivered only via
 * email) to call this endpoint with any effect. CSRF protection would add nothing.
 */
router.post(
  '/auth/reset-password',
  adminAuthLimiter,
  resetPasswordLimiter,
  async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'];

    let body: z.infer<typeof resetPasswordSchema>;
    try {
      body = resetPasswordSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request', details: err.errors }); return;
      }
      res.status(400).json({ error: 'Invalid request' }); return;
    }

    const verified = await verifyAdminPasswordResetToken(body.token);
    if (!verified) {
      await logAdminAudit('admin_reset_password_invalid_token', {
        ip,
        userAgent,
        result: 'failure',
        reason: 'Token missing, expired, used, or admin inactive',
      });
      res.status(400).json({
        error: 'This reset link is invalid or has expired. Please request a new one.',
        code: 'RESET_TOKEN_INVALID',
      });
      return;
    }

    const result = await completeAdminPasswordReset({
      rawToken: body.token,
      newPassword: body.newPassword,
    });

    if (!result.ok) {
      await logAdminAudit('admin_reset_password_failed', {
        adminId: verified.admin.id,
        ip,
        userAgent,
        result: 'failure',
        reason: result.error,
      });
      res.status(400).json({ error: result.error }); return;
    }

    await logAdminAudit('admin_reset_password_success', {
      adminId: result.admin.id,
      ip,
      userAgent,
      result: 'success',
      metadata: { tokenId: verified.token.id },
    });

    res.json({
      success: true,
      message: 'Password updated. Please sign in with your new password.',
    });
  },
);

/**
 * POST /api/admin/auth/change-password
 * Authenticated endpoint. Used both by the must-change-password flow and
 * by self-service rotations. Verifies the current password and replaces it.
 *
 * Reachable on every authenticated session; the legacy FORCE_PASSWORD_CHANGE allow-list is gone —
 * even when the access token carries the `mpc` claim.
 */
router.post(
  '/auth/change-password',
  changePasswordLimiter,
  authenticateAdmin,
  csrfProtection,
  async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'];
    const adminId = req.admin?.sub;

    if (!adminId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    let body: z.infer<typeof changePasswordSchema>;
    try {
      body = changePasswordSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request', details: err.errors }); return;
      }
      res.status(400).json({ error: 'Invalid request' }); return;
    }

    // Determine the current session id (so we can keep it alive while
    // revoking sibling sessions — the user shouldn't get bounced mid-change).
    let keepSessionId: string | undefined;
    const refreshTokenCookie = req.cookies.refresh_token;
    if (refreshTokenCookie) {
      try {
        const payload = verifyRefreshToken(refreshTokenCookie);
        keepSessionId = payload.sessionId;
      } catch {
        /* refresh token invalid — proceed without keeping any session */
      }
    }

    const result = await changeAdminPassword({
      adminId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      keepSessionId,
    });

    if (!result.ok) {
      await logAdminAudit('admin_change_password_failed', {
        adminId,
        ip,
        userAgent,
        result: 'failure',
        reason: result.error,
      });
      res.status(400).json({ error: result.error }); return;
    }

    await logAdminAudit('admin_change_password_success', {
      adminId: result.admin.id,
      ip,
      userAgent,
      result: 'success',
    });

    // Issue a fresh access token *without* the mpc claim so the SPA can
    // immediately resume normal navigation. The refresh-token cookie is
    // unchanged (the current session was kept alive on purpose).
    const { signAccessToken } = await import('../utils/admin-jwt.js');
    const { resolveAdminPermissions } = await import('../services/permissions.service.js');
    const perms = await resolveAdminPermissions(result.admin.id, result.admin.role);
    const accessToken = signAccessToken(
      result.admin.id,
      result.admin.role,
      result.admin.name,
      perms,
      0,
      false,
    );

    res.json({
      success: true,
      message: 'Password updated.',
      accessToken,
      mustChangePassword: false,
      usingDefaultCredentials: false,
      user: {
        id: result.admin.id,
        name: result.admin.name,
        username: result.admin.username,
        email: result.admin.email || result.admin.username || result.admin.name,
        role: result.admin.role,
        mustChangePassword: false,
        usingDefaultCredentials: false,
      },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  },
);

/**
 * GET /api/admin/auth/sessions
 * Get all active sessions for the authenticated admin
 * Requires valid access token
 */
router.get(
  '/auth/sessions',
  authenticateAdmin,
  async (req: Request, res: Response) => {
    const adminId = req.admin?.sub;

    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' }); return;
    }

    const sessions = await getAdminActiveSessions(adminId);

    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.expiresAt,
      })),
      total: sessions.length,
    });
  }
);

/**
 * DELETE /api/admin/auth/sessions/:sessionId
 * Revoke a specific session
 */
router.delete(
  '/auth/sessions/:sessionId',
  authenticateAdmin,
  csrfProtection,
  async (req: Request, res: Response) => {
    const adminId = req.admin?.sub;
    const sessionId = req.params.sessionId;

    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' }); return;
    }

    // Verify the session belongs to the admin
    const sessions = await getAdminActiveSessions(adminId);
    const session = sessions.find((s) => s.id === sessionId);

    if (!session) {
      res.status(404).json({ error: 'Session not found' }); return;
    }

    await logoutAdminSession(sessionId);

    res.json({ success: true, message: 'Session revoked' });
  }
);

/**
 * POST /api/admin/auth/verify-password
 * Authenticated endpoint. Verifies the caller's current password without
 * changing it. Used by the SensitiveActionDialog before executing
 * destructive or high-privilege actions (role changes, user delete, etc.).
 * Returns 200 on success, 401 on wrong password.
 */
router.post(
  '/auth/verify-password',
  authenticateAdmin,
  csrfProtection,
  async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'];
    const adminId = req.admin?.sub;

    if (!adminId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const body = req.body as { password?: string; actionType?: string; targetId?: string };
    const password = body.password ?? '';
    if (!password) {
      res.status(400).json({ error: 'password is required' }); return;
    }
    const actionContext = {
      ...(body.actionType ? { actionType: body.actionType } : {}),
      ...(body.targetId   ? { targetId:   body.targetId   } : {}),
    };

    const [admin] = await db
      .select()
      .from(adminAccountsTable)
      .where(eq(adminAccountsTable.id, adminId))
      .limit(1);

    // Super-admin (no DB row) — fall back to env secret
    if (!admin) {
      const { getAdminSecret } = await import('../routes/admin-shared.js');
      const ADMIN_SECRET = await getAdminSecret();
      if (ADMIN_SECRET && password === ADMIN_SECRET) {
        await logAdminAudit('admin_sensitive_action_verified', {
          adminId, ip, userAgent, result: 'success', ...actionContext,
        });
        res.json({ success: true }); return;
      }
      res.status(401).json({ error: 'Incorrect password' }); return;
    }

    const { verifyAdminSecret } = await import('../services/password.js');
    if (!verifyAdminSecret(password, admin.secret)) {
      await logAdminAudit('admin_sensitive_action_verify_failed', {
        adminId, ip, userAgent, result: 'failure', reason: 'incorrect password', ...actionContext,
      });
      res.status(401).json({ error: 'Incorrect password' }); return;
    }

    await logAdminAudit('admin_sensitive_action_verified', {
      adminId, ip, userAgent, result: 'success', ...actionContext,
    });

    res.json({ success: true });
  }
);

/**
 * DELETE /api/admin/auth/sessions
 * Revoke all sessions for the authenticated admin
 * (Logout from all devices)
 */
router.delete(
  '/auth/sessions',
  authenticateAdmin,
  csrfProtection,
  async (req: Request, res: Response) => {
    const adminId = req.admin?.sub;

    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' }); return;
    }

    await revokeAllAdminSessions(adminId);

    // Clear current cookies
    res.clearCookie('refresh_token', { path: '/api/admin/auth' });
    res.clearCookie('csrf_token', { path: '/' });

    res.json({ success: true, message: 'All sessions revoked' });
  }
);

/**
 * GET /api/admin/pending-counts
 * Returns sidebar badge counts for pending riders, orders, withdrawals, and deposits.
 * Single DB round-trip using parallel queries.
 */
router.get(
  '/pending-counts',
  authenticateAdmin,
  async (_req: Request, res: Response) => {
    try {
      const [[pendingRiders], [pendingOrders], [pendingWithdrawals], [pendingDeposits]] =
        await Promise.all([
          db.select({ count: count() })
            .from(usersTable)
            .where(and(
              eq(usersTable.approvalStatus, 'pending'),
              sql`roles LIKE '%rider%'`,
            )),
          db.select({ count: count() })
            .from(ordersTable)
            .where(eq(ordersTable.status, 'pending')),
          db.select({ count: count() })
            .from(walletTransactionsTable)
            .where(and(
              eq(walletTransactionsTable.type, 'withdrawal'),
              eq(walletTransactionsTable.reference, 'pending'),
            )),
          db.select({ count: count() })
            .from(walletTransactionsTable)
            .where(and(
              sql`type IN ('topup', 'deposit')`,
              eq(walletTransactionsTable.reference, 'pending'),
            )),
        ]);
      res.json({
        pendingRiders:     Number(pendingRiders?.count     ?? 0),
        pendingOrders:     Number(pendingOrders?.count     ?? 0),
        pendingWithdrawals: Number(pendingWithdrawals?.count ?? 0),
        pendingDeposits:   Number(pendingDeposits?.count   ?? 0),
      });
    } catch (err) {
      logger.warn({ err }, '[pending-counts] query failed');
      res.json({ pendingRiders: 0, pendingOrders: 0, pendingWithdrawals: 0, pendingDeposits: 0 });
    }
  }
);

export default router;
