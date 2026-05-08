import { Router } from "express";
import { z } from "zod";
import { sendAdminAlert } from "../../services/email.js";
import { sendOtpSMS } from "../../services/sms.js";
import { sendWhatsAppOTP } from "../../services/whatsapp.js";
import { db } from "@workspace/db";
import {
  usersTable,
  walletTransactionsTable,
  notificationsTable,
  ordersTable, ridesTable, pharmacyOrdersTable, parcelBookingsTable, productsTable, platformSettingsTable, adminAccountsTable, authAuditLogTable, refreshTokensTable, rideRatingsTable, riderPenaltiesTable, reviewsTable,
  vendorProfilesTable,
  riderProfilesTable,
  vendorSchedulesTable,
  locationHistoryTable,
  liveLocationsTable,
  supportMessagesTable,
  locationLogsTable,
  integrationTestHistoryTable,
  adminActionAuditLogTable,
} from "@workspace/db/schema";
import { eq, desc, count, sum, and, gte, lte, sql, or, ilike, asc, isNull, isNotNull, avg, ne, lt, type SQL } from "drizzle-orm";
import {
  stripUser, generateId, getUserLanguage, t,
  getPlatformSettings, invalidatePlatformSettingsCache, adminAuth, getAdminSecret,
  sendUserNotification, logger,
  ORDER_NOTIF_KEYS, RIDE_NOTIF_KEYS, PHARMACY_NOTIF_KEYS, PARCEL_NOTIF_KEYS,
  checkAdminLoginLockout, recordAdminLoginFailure, resetAdminLoginAttempts,
  adminLoginAttempts, ADMIN_MAX_ATTEMPTS, ADMIN_LOCKOUT_TIME,
  addAuditEntry, addSecurityEvent, getClientIp,
  signAdminJwt, verifyAdminJwt, invalidateSettingsCache, getCachedSettings,
  ADMIN_TOKEN_TTL_HRS, verifyTotpToken, verifyAdminSecret,
  ensureDefaultRideServices, ensureDefaultLocations, formatSvc,
  type AdminRequest, serializeSosAlert,
} from "../admin-shared.js";
import { emitSosNew, emitSosAcknowledged, emitSosResolved, type SosAlertPayload } from "../../lib/socketio.js";
import { hashPassword } from "../../services/password.js";
import { sendSuccess, sendError, sendErrorWithData, sendNotFound, sendForbidden, sendValidationError } from "../../lib/response.js";
import { auditLog, securityEvents, blockIP, unblockIP, isIPBlocked, getBlockedIPList, getActiveLockouts, unlockPhone } from "../../middleware/security.js";
import { validateBody } from "../../middleware/validate.js";

const router = Router();
router.get("/stats", async (_req, res) => {
  const [
    [userCount],
    [orderCount],
    [rideCount],
    [pharmCount],
    [parcelCount],
    [productCount],
    [pendingOrderCount],
    [activeRideCount],
    [activeSosCount],
    [totalRevenue],
    [rideRevenue],
    [pharmRevenue],
    recentOrders,
    recentRides,
    [riderCount],
    [vendorCount],
    [failedPaymentCount],
  ] = await Promise.all([
    db.select({ count: count() }).from(usersTable),
    db.select({ count: count() }).from(ordersTable),
    db.select({ count: count() }).from(ridesTable),
    db.select({ count: count() }).from(pharmacyOrdersTable),
    db.select({ count: count() }).from(parcelBookingsTable),
    db.select({ count: count() }).from(productsTable),
    /* pending orders only */
    db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "pending")),
    /* active rides: searching / accepted / active */
    db.select({ count: count() }).from(ridesTable)
      .where(or(eq(ridesTable.status, "searching"), eq(ridesTable.status, "accepted"), eq(ridesTable.status, "active"))),
    /* active SOS: pending (unhandled) or acknowledged (in progress) — not yet resolved */
    db.select({ count: count() }).from(notificationsTable)
      .where(and(eq(notificationsTable.type, "sos"), or(eq(notificationsTable.sosStatus, "pending"), eq(notificationsTable.sosStatus, "acknowledged")))),
    db.select({ total: sum(ordersTable.total) }).from(ordersTable).where(eq(ordersTable.status, "delivered")),
    db.select({ total: sum(ridesTable.fare) }).from(ridesTable).where(eq(ridesTable.status, "completed")),
    db.select({ total: sum(pharmacyOrdersTable.total) }).from(pharmacyOrdersTable).where(eq(pharmacyOrdersTable.status, "delivered")),
    db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(5),
    db.select().from(ridesTable).orderBy(desc(ridesTable.createdAt)).limit(5),
    db.select({ count: count() }).from(riderProfilesTable),
    db.select({ count: count() }).from(vendorProfilesTable),
    /* failed payments: orders where paymentStatus = 'failed' */
    db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.paymentStatus, "failed")),
  ]);

  sendSuccess(res, {
    users: userCount!.count,
    orders: orderCount!.count,
    rides: rideCount!.count,
    pendingOrders: pendingOrderCount!.count,
    activeRides: activeRideCount!.count,
    activeSos: activeSosCount!.count,
    failedPayments: failedPaymentCount!.count,
    pharmacyOrders: pharmCount!.count,
    parcelBookings: parcelCount!.count,
    products: productCount!.count,
    revenue: {
      orders: parseFloat(totalRevenue!.total ?? "0"),
      rides: parseFloat(rideRevenue!.total ?? "0"),
      pharmacy: parseFloat(pharmRevenue!.total ?? "0"),
      total:
        parseFloat(totalRevenue!.total ?? "0") +
        parseFloat(rideRevenue!.total ?? "0") +
        parseFloat(pharmRevenue!.total ?? "0"),
    },
    recentOrders: recentOrders.map(o => ({
      ...o,
      total: parseFloat(String(o.total)),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    })),
    totalRiders: riderCount!.count,
    totalVendors: vendorCount!.count,
    recentRides: recentRides.map(r => ({
      ...r,
      fare: parseFloat(r.fare ?? "0"),
      distance: parseFloat(r.distance ?? "0"),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
});

router.get("/platform-settings", async (_req, res) => {
  const rows = await db.select().from(platformSettingsTable);
  const grouped: Record<string, any[]> = {};
  for (const row of rows) {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category]!.push({ key: row.key, value: row.value, label: row.label, updatedAt: row.updatedAt.toISOString() });
  }
  sendSuccess(res, { settings: rows.map(r => ({ ...r, updatedAt: r.updatedAt.toISOString() })), grouped });
});

/* Keys that must be valid finite numbers */
const NUMERIC_SETTING_KEYS = new Set([
  "dispatch_min_radius_km", "dispatch_max_radius_km", "dispatch_avg_speed_kmh",
  "ride_cancellation_fee", "ride_cancel_grace_sec", "ride_surge_multiplier", "ride_bargaining_min_pct",
  "finance_gst_pct", "customer_signup_bonus",
  "payment_min_online", "payment_max_online",
  "security_login_max_attempts", "security_lockout_minutes", "security_otp_cooldown_sec",
  "security_otp_max_per_phone", "security_otp_max_per_ip", "security_otp_window_min",
  "auth_trusted_device_days", "order_refund_days",
  "wallet_withdrawal_processing",
]);

/* Keys that must be strictly "on" or "off" */
const BOOLEAN_SETTING_KEYS = new Set([
  "feature_rides", "feature_wallet", "feature_mart", "feature_food", "feature_parcel",
  "feature_pharmacy", "feature_school", "feature_new_users",
  "ride_bargaining_enabled", "ride_surge_enabled", "rider_cash_allowed",
  "cod_enabled", "finance_gst_enabled", "jazzcash_enabled", "easypaisa_enabled",
  "security_otp_bypass", "security_phone_verify",
  "feature_weather", "user_require_approval", "integration_whatsapp",
  "cod_allowed_rides", "wallet_allowed_rides", "jazzcash_allowed_rides", "easypaisa_allowed_rides",
]);

function isValidOctet(s: string): boolean {
  const n = parseInt(s, 10);
  return n >= 0 && n <= 255 && String(n) === s;
}

function isValidIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every(isValidOctet);
}

function isValidIpOrCidr(entry: string): boolean {
  if (entry.includes("/")) {
    const [ip, prefix] = entry.split("/");
    const p = parseInt(prefix, 10);
    return isValidIPv4(ip) && !isNaN(p) && p >= 0 && p <= 32 && String(p) === prefix;
  }
  return isValidIPv4(entry);
}

function validateSettingValue(key: string, value: string): string | null {
  if (NUMERIC_SETTING_KEYS.has(key)) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return `Setting "${key}" must be a valid number (got: "${value}")`;
  }
  if (BOOLEAN_SETTING_KEYS.has(key)) {
    if (value !== "on" && value !== "off") return `Setting "${key}" must be "on" or "off" (got: "${value}")`;
  }
  if (key === "security_admin_ip_whitelist" && value.trim()) {
    const entries = value.split(",").map((s: string) => s.trim()).filter(Boolean);
    const invalid = entries.filter((e: string) => !isValidIpOrCidr(e));
    if (invalid.length > 0) {
      return `Invalid IP whitelist entr${invalid.length === 1 ? "y" : "ies"}: ${invalid.join(", ")}. Use IPv4 or CIDR notation (e.g. 192.168.1.1 or 10.0.0.0/8).`;
    }
  }
  return null;
}

router.put("/platform-settings", async (req, res) => {
  const { settings } = req.body as { settings: Array<{ key: string; value: string }> };
  if (!Array.isArray(settings)) { sendValidationError(res, "settings array required"); return; }
  for (const { key, value } of settings) {
    const err = validateSettingValue(key, String(value));
    if (err) { sendError(res, err, 422); return; }
  }
  for (const { key, value } of settings) {
    await db
      .insert(platformSettingsTable)
      .values({ key, value: String(value), label: key, category: "custom", updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettingsTable.key,
        set:    { value: String(value), updatedAt: new Date() },
      });
  }
  /* Bust both caches so new values apply immediately to all call sites */
  invalidateSettingsCache();
  invalidatePlatformSettingsCache();
  const changedKeys = settings.map((s: Record<string, unknown>) => s.key).join(", ");
  addAuditEntry({ action: "settings_update", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Updated ${settings.length} setting(s): ${changedKeys}`, result: "success" });
  const rows = await db.select().from(platformSettingsTable);
  sendSuccess(res, { settings: rows.map(r => ({ ...r, updatedAt: r.updatedAt.toISOString() })) });
});

/* ── Backup: download all settings as JSON ───────────────────────────────── */
router.get("/platform-settings/backup", async (req, res) => {
  const rows = await db.select().from(platformSettingsTable);
  const payload = {
    _meta: {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      count: rows.length,
      source: "AJKMart Admin Panel",
    },
    settings: rows.map(r => ({
      key: r.key,
      value: r.value,
      category: r.category,
      label: r.label,
    })),
  };
  addAuditEntry({ action: "settings_backup", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Exported ${rows.length} settings`, result: "success" });
  sendSuccess(res, payload);
});

/* ── Restore: import settings from a backup JSON ─────────────────────────── */
router.post("/platform-settings/restore", async (req, res) => {
  const { settings } = req.body as { settings: Array<{ key: string; value: string }> };
  if (!Array.isArray(settings) || settings.length === 0) {
    sendValidationError(res, "settings array required"); return;
  }
  const errors: string[] = [];
  for (const { key, value } of settings) {
    if (typeof key !== "string" || typeof value !== "string") {
      errors.push(`Invalid entry: ${JSON.stringify({ key, value })}`); continue;
    }
    const err = validateSettingValue(key, value);
    if (err) errors.push(err);
  }
  if (errors.length > 0) { sendError(res, `Validation failed: ${errors.slice(0, 3).join("; ")}`, 422); return; }

  let updated = 0;
  let skipped = 0;
  for (const { key, value } of settings) {
    const result = await db
      .update(platformSettingsTable)
      .set({ value: String(value), updatedAt: new Date() })
      .where(eq(platformSettingsTable.key, key))
      .returning({ key: platformSettingsTable.key });
    if (result.length > 0) { updated++; } else { skipped++; }
  }
  invalidateSettingsCache();
  invalidatePlatformSettingsCache();
  addAuditEntry({ action: "settings_restore", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Restored ${updated} settings (${skipped} unrecognised keys skipped)`, result: "success" });
  const rows = await db.select().from(platformSettingsTable);
  sendSuccess(res, { restored: updated, skipped, settings: rows.map(r => ({ ...r, updatedAt: r.updatedAt.toISOString() })) });
});

const patchSettingSchema = z.object({ value: z.string() });

router.patch("/platform-settings/:key", validateBody(patchSettingSchema), async (req, res) => {
  const { value } = req.body;
  const settingKey = req.params["key"]!;
  const err = validateSettingValue(settingKey, String(value));
  if (err) { sendError(res, err, 422); return; }
  const [row] = await db
    .update(platformSettingsTable)
    .set({ value: String(value), updatedAt: new Date() })
    .where(eq(platformSettingsTable.key, settingKey))
    .returning();
  if (!row) { sendNotFound(res, "Setting not found"); return; }
  /* Bust both caches so new values apply immediately to all call sites */
  invalidateSettingsCache();
  invalidatePlatformSettingsCache();
  addAuditEntry({ action: "settings_update", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Updated setting "${settingKey}" = "${value}"`, result: "success" });
  sendSuccess(res, { ...row, updatedAt: row.updatedAt.toISOString() });
});

/* ── Integration Test Endpoints ────────────────────────────────────────────
 * POST /api/admin/system/test-integration/email
 * POST /api/admin/system/test-integration/sms
 * POST /api/admin/system/test-integration/whatsapp
 * POST /api/admin/system/test-integration/fcm
 * POST /api/admin/system/test-integration/maps
 * GET  /api/admin/system/integration-history          → latest result + recent runs per type
 * GET  /api/admin/system/integration-history/:type    → last 10 runs for one integration
 *
 * Each returns { sent, message } after attempting to send with current settings.
 * Every attempt (pass or fail) is persisted in `integration_test_history`
 * so the Integration Health panel survives page reloads.
 */
async function recordIntegrationTest(opts: {
  req: AdminRequest;
  type: "email" | "sms" | "whatsapp" | "fcm" | "maps" | "jazzcash" | "easypaisa";
  ok: boolean;
  latencyMs: number;
  message: string;
  errorDetail?: string;
}): Promise<void> {
  try {
    await db.insert(integrationTestHistoryTable).values({
      id:          generateId(),
      type:        opts.type,
      ok:          opts.ok,
      latencyMs:   Math.max(0, Math.round(opts.latencyMs)),
      message:     (opts.message ?? "").slice(0, 1000),
      errorDetail: opts.errorDetail ? opts.errorDetail.slice(0, 2000) : null,
      adminId:     opts.req?.adminId ?? null,
    });
  } catch (e) {
    logger.warn("[integration-history] failed to record run", { type: opts.type, err: (e as Error)?.message });
  }
}

router.post("/test-integration/email", async (req, res) => {
  const start = Date.now();
  try {
    const settings = await getCachedSettings();
    const result = await sendAdminAlert(
      "new_vendor",
      "Test Email from AJKMart Admin",
      `
        <h3>✅ Email Integration Test</h3>
        <p>This is a test alert sent from the AJKMart Admin Panel to verify your SMTP configuration is working correctly.</p>
        <p style="color:#6b7280; font-size:13px;">Sent at: ${new Date().toISOString()}</p>
      `,
      { ...settings, email_alert_new_vendor: "on" },
    );
    const latencyMs = Date.now() - start;
    if (result.sent) {
      const msg = `Test email sent to ${settings["smtp_admin_alert_email"]}`;
      await recordIntegrationTest({ req: req as AdminRequest, type: "email", ok: true, latencyMs, message: msg });
      sendSuccess(res, { sent: true, message: msg, latencyMs });
    } else {
      const msg = result.reason ?? result.error ?? "Email test failed";
      await recordIntegrationTest({ req: req as AdminRequest, type: "email", ok: false, latencyMs, message: msg });
      sendError(res, msg, 400);
    }
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const msg = err.message ?? "Email test failed unexpectedly";
    await recordIntegrationTest({ req: req as AdminRequest, type: "email", ok: false, latencyMs, message: msg, errorDetail: String(err?.stack ?? err) });
    sendError(res, msg, 502);
  }
});

router.post("/test-integration/sms", async (req, res) => {
  const start = Date.now();
  try {
    const settings = await getCachedSettings();
    const { phone } = req.body as { phone?: string };
    if (!phone) { sendValidationError(res, "phone number required"); return; }
    const testOtp = "123456";
    const result = await sendOtpSMS(phone, testOtp, { ...settings, integration_sms: "on" });
    const latencyMs = Date.now() - start;
    if (result.sent) {
      const msg = `Test SMS sent to ${phone} via ${result.provider}`;
      await recordIntegrationTest({ req: req as AdminRequest, type: "sms", ok: true, latencyMs, message: msg });
      sendSuccess(res, { sent: true, message: msg, latencyMs });
    } else {
      const msg = result.error ?? "SMS test failed";
      await recordIntegrationTest({ req: req as AdminRequest, type: "sms", ok: false, latencyMs, message: msg });
      sendError(res, msg, 400);
    }
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const msg = err.message ?? "SMS test failed unexpectedly";
    await recordIntegrationTest({ req: req as AdminRequest, type: "sms", ok: false, latencyMs, message: msg, errorDetail: String(err?.stack ?? err) });
    sendError(res, msg, 502);
  }
});

router.post("/test-integration/whatsapp", async (req, res) => {
  const start = Date.now();
  try {
    const settings = await getCachedSettings();
    const { phone } = req.body as { phone?: string };
    if (!phone) { sendValidationError(res, "phone number required"); return; }
    const testOtp = "123456";
    const result = await sendWhatsAppOTP(phone, testOtp, {
      ...settings,
      integration_whatsapp: "on",
      wa_send_otp: "on",
    });
    const latencyMs = Date.now() - start;
    if (result.sent) {
      const msg = `Test WhatsApp message sent to ${phone}`;
      await recordIntegrationTest({ req: req as AdminRequest, type: "whatsapp", ok: true, latencyMs, message: msg });
      sendSuccess(res, { sent: true, message: msg, messageId: result.messageId, latencyMs });
    } else {
      const msg = result.error ?? "WhatsApp test failed";
      await recordIntegrationTest({ req: req as AdminRequest, type: "whatsapp", ok: false, latencyMs, message: msg });
      sendError(res, msg, 400);
    }
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const msg = err.message ?? "WhatsApp test failed unexpectedly";
    await recordIntegrationTest({ req: req as AdminRequest, type: "whatsapp", ok: false, latencyMs, message: msg, errorDetail: String(err?.stack ?? err) });
    sendError(res, msg, 502);
  }
});

router.post("/test-integration/fcm", async (req, res) => {
  const start = Date.now();
  const fail = async (msg: string, status = 400, errorDetail?: string) => {
    const latencyMs = Date.now() - start;
    await recordIntegrationTest({ req: req as AdminRequest, type: "fcm", ok: false, latencyMs, message: msg, errorDetail });
    sendError(res, msg, status);
  };
  try {
    const settings = await getCachedSettings();
    const { deviceToken } = req.body as { deviceToken?: string };
    if (!deviceToken) { sendValidationError(res, "deviceToken is required"); return; }

    const serverKey = settings["fcm_server_key"]?.trim();
    const projectId = settings["fcm_project_id"]?.trim();

    if (!serverKey) { await fail("FCM Server Key is not configured. Set fcm_server_key in Integrations → Firebase.", 400); return; }
    if (!projectId) { await fail("Firebase Project ID is not configured. Set fcm_project_id in Integrations → Firebase.", 400); return; }

    // Firebase deprecated the legacy HTTP API on June 20, 2024 — projects created
    // after that date only accept the HTTP v1 API (which uses a service-account
    // OAuth2 token, NOT a server key). Detect both endpoints and report a clear
    // result either way so the admin knows what's wrong.
    const resp = await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `key=${serverKey}`,
      },
      body: JSON.stringify({
        to: deviceToken,
        notification: {
          title: "AJKMart — Test Push Notification ✅",
          body: `This is a test push sent from AJKMart Admin at ${new Date().toISOString()}`,
        },
        data: { type: "test", timestamp: Date.now().toString() },
      }),
    });

    let body: any = null;
    try { body = await resp.json(); } catch { body = { raw: await resp.text().catch(() => "") }; }

    if (resp.status === 401 || resp.status === 404) {
      const detail = body?.error?.message || body?.error || body?.raw || `HTTP ${resp.status}`;
      await fail(
        `FCM legacy endpoint rejected the request (${resp.status}). Your Firebase project most likely requires the new HTTP v1 API — switch to a service-account JSON in Integrations → Firebase. Original error: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
        400,
        JSON.stringify(body),
      );
      return;
    }
    if (!resp.ok) {
      const detail = body?.error?.message || body?.error || `FCM HTTP ${resp.status}`;
      await fail(typeof detail === "string" ? detail : JSON.stringify(detail), 400, JSON.stringify(body));
      return;
    }
    if (body?.failure > 0) {
      const errDetail = body?.results?.[0]?.error ?? "Unknown FCM error";
      await fail(`FCM rejected the message: ${errDetail}`, 400, JSON.stringify(body));
      return;
    }

    const latencyMs = Date.now() - start;
    const msg = `Test push notification sent to device token successfully (legacy HTTP API)`;
    await recordIntegrationTest({ req: req as AdminRequest, type: "fcm", ok: true, latencyMs, message: msg });
    sendSuccess(res, { sent: true, message: msg, fcmMessageId: body?.results?.[0]?.message_id, latencyMs });
  } catch (err: any) {
    await fail(err.message ?? "FCM test failed unexpectedly", 502, String(err?.stack ?? err));
  }
});

router.post("/test-integration/maps", async (req, res) => {
  const start = Date.now();
  const fail = async (msg: string, status = 400, errorDetail?: string) => {
    const latencyMs = Date.now() - start;
    await recordIntegrationTest({ req: req as AdminRequest, type: "maps", ok: false, latencyMs, message: msg, errorDetail });
    sendError(res, msg, status);
  };
  try {
    const settings = await getCachedSettings();
    const mapsProvider = settings["maps_provider"] ?? "google";
    const googleKey  = settings["google_maps_api_key"]?.trim() || settings["maps_api_key"]?.trim();
    const mapboxKey  = settings["mapbox_api_key"]?.trim();
    const locationIqKey = settings["locationiq_api_key"]?.trim();

    const testQuery = "Muzaffarabad, Azad Kashmir";
    let provider = mapsProvider;
    let result: unknown = null;

    if (mapsProvider === "google" || (!mapsProvider && googleKey)) {
      if (!googleKey) { await fail("Google Maps API key is not configured. Set google_maps_api_key in Integrations → Maps.", 400); return; }
      provider = "google";
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(testQuery)}&key=${googleKey}`;
      const resp = await fetch(url);
      const body = await resp.json() as any;
      if (body?.status !== "OK") { await fail(`Google Maps geocoding failed: ${body?.status} — ${body?.error_message ?? ""}`, 400); return; }
      result = body?.results?.[0]?.geometry?.location;
    } else if (mapsProvider === "mapbox") {
      if (!mapboxKey) { await fail("Mapbox API key is not configured. Set mapbox_api_key in Integrations → Maps.", 400); return; }
      provider = "mapbox";
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(testQuery)}.json?access_token=${mapboxKey}`;
      const resp = await fetch(url);
      const body = await resp.json() as any;
      if (!resp.ok || !body?.features?.length) { await fail(`Mapbox geocoding failed: ${body?.message ?? `HTTP ${resp.status}`}`, 400); return; }
      result = body?.features?.[0]?.center;
    } else if (mapsProvider === "locationiq") {
      if (!locationIqKey) { await fail("LocationIQ API key is not configured. Set locationiq_api_key in Integrations → Maps.", 400); return; }
      provider = "locationiq";
      const url = `https://us1.locationiq.com/v1/search.php?key=${locationIqKey}&q=${encodeURIComponent(testQuery)}&format=json&limit=1`;
      const resp = await fetch(url);
      const body = await resp.json() as any;
      if (!resp.ok || (Array.isArray(body) && body.length === 0)) { await fail(`LocationIQ geocoding failed: ${body?.error ?? `HTTP ${resp.status}`}`, 400); return; }
      result = { lat: body?.[0]?.lat, lon: body?.[0]?.lon };
    } else {
      await fail("No maps provider is configured. Set up an API key in Integrations → Maps.", 400);
      return;
    }

    const latencyMs = Date.now() - start;
    const msg = `${provider} geocoded "${testQuery}" successfully`;
    await recordIntegrationTest({ req: req as AdminRequest, type: "maps", ok: true, latencyMs, message: msg });
    sendSuccess(res, { sent: true, provider, latencyMs, result, query: testQuery, message: msg });
  } catch (err: any) {
    await fail(err.message ?? "Maps test failed unexpectedly", 502, String(err?.stack ?? err));
  }
});

/* ── Integration Test History ──────────────────────────────────────────────
 * GET /api/admin/system/integration-history
 *   → { latest: { [type]: row|null }, recent: { [type]: row[] (last 10) } }
 *   `?type=email` (optional) restricts to one integration.
 */
router.get("/integration-history", async (req, res) => {
  const filterType = (req.query["type"] as string | undefined)?.trim();
  const cap = 10;

  // Pull a generous window then bucket in JS — avoids per-type SELECTs.
  const limitRows = filterType ? cap : 200;
  const baseQuery = db.select({
    id:          integrationTestHistoryTable.id,
    type:        integrationTestHistoryTable.type,
    ok:          integrationTestHistoryTable.ok,
    latencyMs:   integrationTestHistoryTable.latencyMs,
    message:     integrationTestHistoryTable.message,
    errorDetail: integrationTestHistoryTable.errorDetail,
    createdAt:   integrationTestHistoryTable.createdAt,
  }).from(integrationTestHistoryTable);

  const rows = filterType
    ? await baseQuery.where(eq(integrationTestHistoryTable.type, filterType))
        .orderBy(desc(integrationTestHistoryTable.createdAt)).limit(limitRows)
    : await baseQuery.orderBy(desc(integrationTestHistoryTable.createdAt)).limit(limitRows);

  type SerialisedRow = Omit<typeof rows[number], "createdAt"> & { createdAt: string };
  const recent: Record<string, SerialisedRow[]> = {};
  const latest: Record<string, SerialisedRow | null> = {};

  for (const r of rows) {
    const serialised = { ...r, createdAt: r.createdAt.toISOString() };
    const bucket = recent[r.type] ?? (recent[r.type] = []);
    if (bucket.length < cap) bucket.push(serialised);
    if (!latest[r.type]) latest[r.type] = serialised;
  }

  sendSuccess(res, { latest, recent });
});

/* ── Pharmacy Orders Enriched ── */
router.get("/app-overview", async (_req, res) => {
  const [
    totalUsers, activeUsers, bannedUsers,
    totalOrders, pendingOrders,
    totalRides, activeRides,
    totalPharmacy, totalParcel,
    settings, adminAccounts,
  ] = await Promise.all([
    db.select({ c: count() }).from(usersTable),
    db.select({ c: count() }).from(usersTable).where(eq(usersTable.isActive, true)),
    db.select({ c: count() }).from(usersTable).where(eq(usersTable.isBanned, true)),
    db.select({ c: count() }).from(ordersTable),
    db.select({ c: count() }).from(ordersTable).where(eq(ordersTable.status, "pending")),
    db.select({ c: count() }).from(ridesTable),
    db.select({ c: count() }).from(ridesTable).where(eq(ridesTable.status, "ongoing")),
    db.select({ c: count() }).from(pharmacyOrdersTable),
    db.select({ c: count() }).from(parcelBookingsTable),
    db.select().from(platformSettingsTable),
    db.select({ c: count() }).from(adminAccountsTable).where(eq(adminAccountsTable.isActive, true)),
  ]);
  const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
  sendSuccess(res, {
    users:    { total: totalUsers[0]?.c ?? 0, active: activeUsers[0]?.c ?? 0, banned: bannedUsers[0]?.c ?? 0 },
    orders:   { total: totalOrders[0]?.c ?? 0, pending: pendingOrders[0]?.c ?? 0 },
    rides:    { total: totalRides[0]?.c ?? 0, active: activeRides[0]?.c ?? 0 },
    pharmacy: { total: totalPharmacy[0]?.c ?? 0 },
    parcel:   { total: totalParcel[0]?.c ?? 0 },
    adminAccounts: adminAccounts[0]?.c ?? 0,
    appStatus:    settingsMap["app_status"]    || "active",
    appName:      settingsMap["app_name"]      || "AJKMart",
    features: {
      mart:     settingsMap["feature_mart"]     || "on",
      food:     settingsMap["feature_food"]     || "on",
      rides:    settingsMap["feature_rides"]    || "on",
      pharmacy: settingsMap["feature_pharmacy"] || "on",
      parcel:   settingsMap["feature_parcel"]   || "on",
      wallet:   settingsMap["feature_wallet"]   || "on",
    },
  });
});

/* ── Categories Management ── */
router.get("/all-notifications", async (req, res) => {
  const role = req.query["role"] as string | undefined;
  const limit = Math.min(parseInt(String(req.query["limit"] || "100")), 300);
  let userIds: string[] = [];
  if (role) {
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(ilike(usersTable.roles, `%${role}%`));
    userIds = users.map(u => u.id);
    if (userIds.length === 0) { sendSuccess(res, { notifications: [] }); return; }
  }
  const notifs = await db.select().from(notificationsTable)
    .orderBy(desc(notificationsTable.createdAt))
    .limit(limit);
  const filtered = role ? notifs.filter(n => userIds.includes(n.userId)) : notifs;
  const enriched = await Promise.all(filtered.slice(0, 200).map(async n => {
    const [user] = await db.select({ id: usersTable.id, name: usersTable.name, phone: usersTable.phone, roles: usersTable.roles })
      .from(usersTable).where(eq(usersTable.id, n.userId)).limit(1);
    return { ...n, user: user || null };
  }));
  sendSuccess(res, { notifications: enriched });
});

/* ══════════════════════════════════════════════════════════════
   SECURITY MANAGEMENT ENDPOINTS
══════════════════════════════════════════════════════════════ */

/* ── GET /admin/audit-log(s) — view admin action audit trail (DB-backed) ── */
const auditLogHandler = async (req: import("express").Request, res: import("express").Response) => {
  const page    = Math.max(1, parseInt(String(req.query["page"]    || "1")));
  const limit   = Math.min(parseInt(String(req.query["limit"]   || "50")), 500);
  const action  = req.query["action"]  as string | undefined;
  const result  = req.query["result"]  as string | undefined;
  const from    = (req.query["from"]    ?? req.query["dateFrom"]) as string | undefined;
  const to      = (req.query["to"]      ?? req.query["dateTo"])   as string | undefined;
  const search  = req.query["search"]  as string | undefined;
  const adminId = req.query["adminId"] as string | undefined;

  /* Role restriction: non-super_admin callers only see their own entries */
  const callerRole = (req as AdminRequest).adminRole ?? "";
  const callerId   = (req as AdminRequest).adminId   ?? "";
  const isSuperAdmin = callerRole === "super_admin" || callerRole === "super";
  const restricted = !isSuperAdmin;

  try {
    const conditions: SQL[] = [];
    if (action)  conditions.push(ilike(adminActionAuditLogTable.action, `%${action}%`));
    if (result)  conditions.push(eq(adminActionAuditLogTable.result, result));
    if (from)    conditions.push(gte(adminActionAuditLogTable.createdAt, new Date(from)));
    if (to)      conditions.push(lte(adminActionAuditLogTable.createdAt, new Date(to)));
    /* Honour explicit adminId filter but never let non-super_admin query other admins */
    if (restricted) {
      conditions.push(eq(adminActionAuditLogTable.adminId, callerId));
    } else if (adminId) {
      conditions.push(eq(adminActionAuditLogTable.adminId, adminId));
    }
    if (search) {
      const q = `%${search}%`;
      conditions.push(or(
        ilike(adminActionAuditLogTable.action, q),
        ilike(adminActionAuditLogTable.details, q),
        ilike(adminActionAuditLogTable.ip, q),
        ilike(adminActionAuditLogTable.adminName, q),
        ilike(adminActionAuditLogTable.affectedUserName, q),
        ilike(adminActionAuditLogTable.adminId, q),
      )!);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ total }] = await db
      .select({ total: count() })
      .from(adminActionAuditLogTable)
      .where(where);

    const adminAlias = adminAccountsTable;
    const userAlias  = usersTable;

    const rows = await db
      .select({
        id:               adminActionAuditLogTable.id,
        action:           adminActionAuditLogTable.action,
        result:           adminActionAuditLogTable.result,
        details:          adminActionAuditLogTable.details,
        ip:               adminActionAuditLogTable.ip,
        adminId:          adminActionAuditLogTable.adminId,
        adminName:        sql<string | null>`COALESCE(${adminActionAuditLogTable.adminName}, ${adminAlias.name})`,
        affectedUserId:   adminActionAuditLogTable.affectedUserId,
        affectedUserName: sql<string | null>`COALESCE(${adminActionAuditLogTable.affectedUserName}, ${userAlias.name}, ${userAlias.phone})`,
        affectedUserRole: adminActionAuditLogTable.affectedUserRole,
        timestamp:        adminActionAuditLogTable.createdAt,
      })
      .from(adminActionAuditLogTable)
      .leftJoin(adminAlias, eq(adminActionAuditLogTable.adminId, adminAlias.id))
      .leftJoin(userAlias, eq(adminActionAuditLogTable.affectedUserId, userAlias.id))
      .where(where)
      .orderBy(desc(adminActionAuditLogTable.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    const entries = rows.map(r => ({
      ...r,
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
    }));

    sendSuccess(res, {
      entries,
      total: Number(total),
      page,
      limit,
      totalPages: Math.ceil(Number(total) / limit),
      restricted,
    });
  } catch (err) {
    logger.warn({ err }, "[audit-log] DB query failed, falling back to in-memory buffer");
    let entries = restricted
      ? [...auditLog].filter(e => e.adminId === callerId)
      : [...auditLog];
    if (action) entries = entries.filter(e => e.action.includes(action));
    if (result) entries = entries.filter(e => e.result === result);
    if (from)   entries = entries.filter(e => new Date(e.timestamp) >= new Date(from));
    if (to)     entries = entries.filter(e => new Date(e.timestamp) <= new Date(to));
    if (!restricted && adminId) entries = entries.filter(e => e.adminId === adminId);
    if (search) {
      const q = search.toLowerCase();
      entries = entries.filter(e =>
        (e.adminId || "").toLowerCase().includes(q) ||
        (e.adminName || "").toLowerCase().includes(q) ||
        (e.action || "").toLowerCase().includes(q) ||
        (e.details || "").toLowerCase().includes(q) ||
        (e.ip || "").toLowerCase().includes(q) ||
        (e.affectedUserName || "").toLowerCase().includes(q)
      );
    }
    const total = entries.length;
    sendSuccess(res, { entries: entries.slice((page - 1) * limit, page * limit), total, page, limit, totalPages: Math.ceil(total / limit), restricted });
  }
};
router.get("/audit-log",  adminAuth, auditLogHandler);
router.get("/audit-logs", adminAuth, auditLogHandler);

/* ── GET /api/admin/me/preferences — per-admin UI preferences ── */
router.get("/me/preferences", adminAuth, async (req, res) => {
  const adminId = (req as AdminRequest).adminId;
  if (!adminId) { sendForbidden(res, "Not authenticated"); return; }
  try {
    const [row] = await db
      .select({ id: adminAccountsTable.id, preferences: sql<string | null>`preferences` })
      .from(adminAccountsTable)
      .where(eq(adminAccountsTable.id, adminId))
      .limit(1);
    let prefs: Record<string, unknown> = {};
    if (row) {
      const raw = (row as any).preferences;
      if (raw !== null && raw !== undefined) {
        if (typeof raw === "object") {
          prefs = raw as Record<string, unknown>;
        } else {
          try { prefs = JSON.parse(raw as string); } catch { prefs = {}; }
        }
      }
    }
    sendSuccess(res, { preferences: prefs });
  } catch {
    sendSuccess(res, { preferences: {} });
  }
});

/* ── PUT /api/admin/me/preferences — save per-admin UI preferences ── */
router.put("/me/preferences", adminAuth, async (req, res) => {
  const adminId = (req as AdminRequest).adminId;
  if (!adminId) { sendForbidden(res, "Not authenticated"); return; }
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== "object") { sendValidationError(res, "preferences object required"); return; }
  const allowed: Record<string, unknown> = {};
  if (typeof body["font_scale"] === "number") allowed["font_scale"] = body["font_scale"];
  if (typeof body["contrast"] === "string") allowed["contrast"] = body["contrast"];
  if (typeof body["reduce_motion"] === "boolean") allowed["reduce_motion"] = body["reduce_motion"];
  const prefsJson = JSON.stringify(allowed);
  try {
    await db.execute(sql`
      ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS preferences JSONB
    `);
    await db.execute(sql`
      UPDATE admin_accounts SET preferences = ${prefsJson}::jsonb WHERE id = ${adminId}
    `);
  } catch (err) {
    logger.warn({ err }, "[admin/me/preferences] PUT failed — returning browser-only response");
    sendSuccess(res, { preferences: allowed, persisted: false });
    return;
  }
  sendSuccess(res, { preferences: allowed, persisted: true });
});

/* ── GET /admin/auth-audit-log — persistent auth event log from DB ── */
router.get("/auth-audit-log", adminAuth, async (req, res) => {
  const limit  = Math.min(parseInt(String(req.query["limit"]  || "100")), 500);
  const event  = req.query["event"] as string | undefined;
  const userId = req.query["userId"] as string | undefined;

  const conditions: SQL[] = [];
  if (event)  conditions.push(eq(authAuditLogTable.event, event));
  if (userId) conditions.push(eq(authAuditLogTable.userId, userId));

  const entries = await db.select().from(authAuditLogTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(authAuditLogTable.createdAt))
    .limit(limit);

  sendSuccess(res, { entries, total: entries.length });
});

/* ── POST /admin/rotate-secret — rotate the admin master secret ── */
router.get("/security-events", adminAuth, (req, res) => {
  const limit    = Math.min(parseInt(String(req.query["limit"]    || "200")), 1000);
  const severity = req.query["severity"] as string | undefined;
  const type     = req.query["type"]     as string | undefined;

  let events = [...securityEvents];
  if (severity) events = events.filter(e => e.severity === severity);
  if (type)     events = events.filter(e => e.type.includes(type));

  sendSuccess(res, {
    events: events.slice(0, limit),
    total: events.length,
    summary: {
      critical: securityEvents.filter(e => e.severity === "critical").length,
      high:     securityEvents.filter(e => e.severity === "high").length,
      medium:   securityEvents.filter(e => e.severity === "medium").length,
      low:      securityEvents.filter(e => e.severity === "low").length,
    },
  });
});

/* ── GET /admin/blocked-ips — list all blocked IPs ── */
router.get("/blocked-ips", adminAuth, async (_req, res) => {
  const blocked = await getBlockedIPList();
  sendSuccess(res, {
    blocked,
    total: blocked.length,
  });
});

/* ── POST /admin/blocked-ips — block an IP ── */
router.post("/blocked-ips", adminAuth, async (req, res) => {
  const { ip, reason } = req.body as { ip: string; reason?: string };
  if (!ip) { sendValidationError(res, "ip required"); return; }

  await blockIP(ip.trim());
  addAuditEntry({
    action: "manual_block_ip",
    ip: getClientIp(req),
    adminId: req.adminId!,
    details: `IP ${ip} manually blocked. Reason: ${reason || "No reason given"}`,
    result: "success",
  });
  addSecurityEvent({ type: "ip_manually_blocked", ip, details: `Admin manually blocked IP: ${ip}. Reason: ${reason || "none"}`, severity: "high" });
  const blocked = await getBlockedIPList();
  sendSuccess(res, { blocked: ip, totalBlocked: blocked.length });
});

/* ── DELETE /admin/blocked-ips/:ip — unblock an IP ── */
router.delete("/blocked-ips/:ip", adminAuth, async (req, res) => {
  const ip = decodeURIComponent(String(req.params["ip"]));
  const wasBlocked = await isIPBlocked(ip);
  await unblockIP(ip);
  addAuditEntry({
    action: "unblock_ip",
    ip: getClientIp(req),
    adminId: req.adminId!,
    details: `IP ${ip} unblocked`,
    result: "success",
  });
  sendSuccess(res, { unblocked: ip, wasBlocked });
});

/* ── GET /admin/login-lockouts — view locked accounts ── */
router.get("/login-lockouts", adminAuth, async (_req, res) => {
  const lockouts = await getActiveLockouts();
  sendSuccess(res, {
    lockouts: lockouts.map(l => ({
      phone: l.key,
      attempts: l.attempts,
      lockedUntil: l.lockedUntil,
      minutesLeft: l.minutesLeft,
    })),
    total: lockouts.length,
  });
});

/* ── DELETE /admin/login-lockouts/:phone — unlock a phone ── */
router.delete("/login-lockouts/:phone", adminAuth, async (req, res) => {
  const phone = decodeURIComponent(String(req.params["phone"]));
  await unlockPhone(phone);
  addAuditEntry({
    action: "admin_unlock_phone",
    ip: getClientIp(req),
    adminId: req.adminId!,
    details: `Admin manually unlocked phone: ${phone}`,
    result: "success",
  });
  sendSuccess(res, { unlocked: phone });
});

/* ── DELETE /admin/system/admin-ip-lockouts/:key — clear an admin IP lockout ── */
router.delete("/system/admin-ip-lockouts/:key", adminAuth, async (req: AdminRequest, res) => {
  const key = decodeURIComponent(String(req.params["key"]));
  const existed = adminLoginAttempts.has(key);
  adminLoginAttempts.delete(key);
  addAuditEntry({
    action: "admin_ip_lockout_cleared",
    ip: getClientIp(req),
    adminId: req.adminId!,
    details: `Admin manually cleared IP lockout for: ${key}`,
    result: "success",
  });
  sendSuccess(res, { cleared: key, existed });
});

/* ── GET /admin/security-dashboard — quick security overview ── */
router.get("/security-dashboard", adminAuth, async (_req, res) => {
  const settings = await getCachedSettings();
  const now = Date.now();

  const blockedList = await getBlockedIPList();
  const activeBlocks = blockedList.length;
  const lockoutList = await getActiveLockouts();
  const activeLockouts = lockoutList.filter(r => r.minutesLeft !== null && r.minutesLeft > 0).length;
  const recentCritical = securityEvents.filter(e => e.severity === "critical" && new Date(e.timestamp).getTime() > now - 24 * 60 * 60 * 1000).length;
  const recentHigh     = securityEvents.filter(e => e.severity === "high"     && new Date(e.timestamp).getTime() > now - 24 * 60 * 60 * 1000).length;

  sendSuccess(res, {
    status: recentCritical > 0 ? "critical" : recentHigh > 5 ? "warning" : "healthy",
    activeBlockedIPs: activeBlocks,
    activeAccountLockouts: activeLockouts,
    last24hCriticalEvents: recentCritical,
    last24hHighEvents: recentHigh,
    totalAuditEntries: auditLog.length,
    totalSecurityEvents: securityEvents.length,
    settings: {
      otpBypass:      settings["security_otp_bypass"]       === "on",
      mfaRequired:    settings["security_mfa_required"]      === "on",
      autoBlockIP:    settings["security_auto_block_ip"]     === "on",
      spoofDetection: settings["security_spoof_detection"]   === "on",
      fakeOrderDetect:settings["security_fake_order_detect"] === "on",
      rateLimitGeneral: parseInt(settings["security_rate_limit"]  ?? "100", 10),
      rateLimitAdmin:   parseInt(settings["security_rate_admin"]  ?? "60",  10),
      rateLimitRider:   parseInt(settings["security_rate_rider"]  ?? "200", 10),
      rateLimitVendor:  parseInt(settings["security_rate_vendor"] ?? "150", 10),
      sessionDays:      parseInt(settings["security_session_days"]      ?? "30", 10),
      adminTokenHrs:    parseInt(settings["security_admin_token_hrs"]   ?? "24", 10),
      riderTokenDays:   parseInt(settings["security_rider_token_days"]  ?? "30", 10),
      maxLoginAttempts: parseInt(settings["security_login_max_attempts"]?? "5",  10),
      lockoutMinutes:   parseInt(settings["security_lockout_minutes"]   ?? "30", 10),
      maxDailyOrders:   parseInt(settings["security_max_daily_orders"]  ?? "20", 10),
      maxSpeedKmh:      parseInt(settings["security_max_speed_kmh"]     ?? "150",10),
      ipWhitelistActive: !!(settings["security_admin_ip_whitelist"] || "").trim(),
    },
  });
});

/* ── POST /admin/settings (override) — invalidate settings cache on save ── */
/* This wraps the existing settings update to bust the cache */
router.post("/invalidate-cache", adminAuth, (_req, res) => {
  invalidateSettingsCache();
  invalidatePlatformSettingsCache();
  sendSuccess(res, { message: "Settings cache invalidated. New security settings will be applied immediately." });
});

/* ═══════════════════════════════════════════════════════════════
   TOTP / MFA ENDPOINTS
   Sub-admins can set up Google Authenticator / Authy for their account.
   Super admin is not required to use TOTP (secret key is the master).
═══════════════════════════════════════════════════════════════ */

/* GET /admin/me/language — get current admin's saved language */
router.get("/search", async (req, res) => {
  const q        = String(req.query["q"]        ?? "").trim();
  const category = String(req.query["category"] ?? "").trim().toLowerCase(); // users | rides | orders
  const statusParam = String(req.query["status"] ?? "").trim(); // comma-separated DB status values

  if (!q || q.length < 2) {
    sendSuccess(res, { users: [], rides: [], orders: [], pharmacy: [], query: q });
    return;
  }

  const pattern = `%${q}%`;

  /* Build status IN-clause values from comma-separated param */
  const statusValues = statusParam ? statusParam.split(",").map(s => s.trim()).filter(Boolean) : [];

  type UserResult = { id: string; name: string | null; phone: string | null; email: string | null; roles: string; createdAt: Date };
  type RideResult = { id: string; type: string; status: string; pickupAddress: string; dropAddress: string; fare: string | null; offeredFare: string | null; riderName: string | null; createdAt: Date };
  type OrderResult = { id: string; status: string; type: string; total: string; deliveryAddress: string | null; createdAt: Date };
  type PharmacyResult = { id: string; status: string; total: string; deliveryAddress: string; createdAt: Date };
  type SearchError = { source: string; message: string };

  const errors: SearchError[] = [];

  async function safeSearchQuery<R>(source: string, fn: () => Promise<R[]>): Promise<R[]> {
    try {
      return await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      errors.push({ source, message });
      return [];
    }
  }

  /* Determine which entity types to query based on category filter */
  const queryUsers   = !category || category === "users";
  const queryRides   = !category || category === "rides";
  const queryOrders  = !category || category === "orders";

  /* Build status IN-clause conditions (undefined → no filter) */
  function buildStatusCond(col: any, vals: string[]): SQL | undefined {
    if (vals.length === 0) return undefined;
    if (vals.length === 1) return eq(col, vals[0]!);
    return or(...vals.map(v => eq(col, v)));
  }

  const ridesStatusCond  = buildStatusCond(ridesTable.status, statusValues);
  const ordersStatusCond = buildStatusCond(ordersTable.status, statusValues);
  const pharmStatusCond  = buildStatusCond(pharmacyOrdersTable.status, statusValues);

  const [users, rides, orders, pharmacy] = await Promise.all([
    queryUsers
      ? safeSearchQuery<UserResult>("users", async () =>
          db.select({
            id:    usersTable.id,
            name:  usersTable.name,
            phone: usersTable.phone,
            email: usersTable.email,
            roles: usersTable.roles,
            createdAt: usersTable.createdAt,
          })
          .from(usersTable)
          .where(or(ilike(usersTable.name, pattern), ilike(usersTable.phone, pattern), ilike(usersTable.email, pattern)))
          .orderBy(desc(usersTable.createdAt))
          .limit(5)
        )
      : Promise.resolve([] as UserResult[]),

    queryRides
      ? safeSearchQuery<RideResult>("rides", () =>
          db.select({
            id:            ridesTable.id,
            type:          ridesTable.type,
            status:        ridesTable.status,
            pickupAddress: ridesTable.pickupAddress,
            dropAddress:   ridesTable.dropAddress,
            fare:          ridesTable.fare,
            offeredFare:   ridesTable.offeredFare,
            riderName:     ridesTable.riderName,
            createdAt:     ridesTable.createdAt,
          })
          .from(ridesTable)
          .where(and(
            or(
              ilike(ridesTable.id, pattern),
              ilike(ridesTable.pickupAddress, pattern),
              ilike(ridesTable.dropAddress, pattern),
              ilike(ridesTable.riderName, pattern),
              ilike(ridesTable.status, pattern),
            ),
            ridesStatusCond,
          ))
          .orderBy(desc(ridesTable.createdAt))
          .limit(8)
        )
      : Promise.resolve([] as RideResult[]),

    queryOrders
      ? safeSearchQuery<OrderResult>("orders", async () =>
          db.select({
            id:              ordersTable.id,
            status:          ordersTable.status,
            type:            ordersTable.type,
            total:           ordersTable.total,
            deliveryAddress: ordersTable.deliveryAddress,
            createdAt:       ordersTable.createdAt,
          })
          .from(ordersTable)
          .where(and(
            or(
              ilike(ordersTable.id, pattern),
              ilike(ordersTable.deliveryAddress, pattern),
              ilike(ordersTable.status, pattern),
            ),
            ordersStatusCond,
          ))
          .orderBy(desc(ordersTable.createdAt))
          .limit(8)
        )
      : Promise.resolve([] as OrderResult[]),

    queryOrders
      ? safeSearchQuery<PharmacyResult>("pharmacy", () =>
          db.select({
            id:              pharmacyOrdersTable.id,
            status:          pharmacyOrdersTable.status,
            total:           pharmacyOrdersTable.total,
            deliveryAddress: pharmacyOrdersTable.deliveryAddress,
            createdAt:       pharmacyOrdersTable.createdAt,
          })
          .from(pharmacyOrdersTable)
          .where(and(
            or(
              ilike(pharmacyOrdersTable.id, pattern),
              ilike(pharmacyOrdersTable.deliveryAddress, pattern),
              ilike(pharmacyOrdersTable.status, pattern),
            ),
            pharmStatusCond,
          ))
          .orderBy(desc(pharmacyOrdersTable.createdAt))
          .limit(5)
        )
      : Promise.resolve([] as PharmacyResult[]),
  ]);

  sendSuccess(res, {
    users, rides, orders, pharmacy, query: q,
    ...(errors.length > 0 ? { errors, partial: true } : {}),
  });
});

/* ── AI Search endpoint ──────────────────────────────────────────────────── */
router.post("/search/ai", async (req, res) => {
  try {
    const { query, locale } = req.body as { query?: string; locale?: string };
    if (!query || query.trim().length < 2) {
      sendValidationError(res, "query is required (min 2 chars)"); return;
    }
    const q = query.trim();

    /* Admin structure context for the AI */
    const adminStructure = `
AJKMart Admin Panel pages and sections:
Operations:
- Dashboard (page-dashboard): overview, stats, revenue, recent orders/rides
- Orders (page-orders): customer orders, delivery status (pending/accepted/preparing/picked/delivered/cancelled)
- Rides (page-rides): taxi/bike/rickshaw bookings (searching/bargaining/accepted/arrived/in_transit/completed/cancelled)
- Van Service (page-van): van and minibus ride bookings
- Pharmacy (page-pharmacy): medicine orders
- Parcels (page-parcels): courier/parcel bookings
- Live Riders Map (page-live-map): real-time GPS tracking of all riders

Marketplace:
- Users (page-users): registered customers, profiles, banning
- Vendors (page-vendors): restaurant/shop management
- Riders (page-riders): delivery rider management
- Products (page-products): product catalog, inventory
- Categories (page-categories): product and service categories
- Promotions Hub (page-promotions): all promotions management
- Banners (page-banners): promotional images/ads
- Popup Campaigns (page-popups): in-app popup campaigns
- Flash Deals (page-flash-deals): time-limited discounts
- Promo Codes (page-promo-codes): discount coupons

Finance:
- Transactions (page-transactions): financial transactions, wallet history
- Withdrawals (page-withdrawals): rider/vendor payout requests
- Deposit Requests (page-deposits): user wallet top-ups
- Loyalty Points (page-loyalty): customer rewards program
- KYC (page-kyc): identity verification (CNIC, documents) — statuses: pending/approved/rejected
- Wallet Transfers (page-wallet-transfers): peer-to-peer transfers
- Reviews (page-reviews): ratings and feedback

Security & Monitoring:
- SOS Alerts (page-sos): emergency alerts from users
- Error Monitor (page-error-monitor): client error reports and crash logs
- Security / Audit Logs (page-security): OTP settings, MFA, sessions, IP blocking, audit log

Rules & Compliance:
- Account Conditions (page-account-conditions): account condition rules
- Condition Rules (page-condition-rules): dynamic business rules

Analytics & Communication:
- Support Chat (page-support-chat): customer support conversations
- FAQ Management (page-faq): help articles and FAQs
- Search Analytics (page-search-analytics): what users search in the app
- Communication (page-communication): broadcast templates
- Chat Monitor (page-chat-monitor): monitor support conversations
- Broadcast (page-broadcast): send mass push notifications
- Notifications (page-notifications): push notification history

Growth & Experiments:
- Wishlist Insights (page-wishlist-insights): user wishlist analytics
- QR Codes (page-qr-codes): generate and manage QR codes
- Experiments (page-experiments): A/B testing and feature experiments

Developer / Integrations:
- Webhooks (page-webhooks): webhook management
- Deep Links (page-deep-links): app deep link management

System:
- Settings (page-settings): platform configuration
- App Management / Feature Toggles (page-app-management): version, maintenance, feature flags
- Delivery Access (page-delivery-access): delivery zone and access control
- Settings > General (settings-general): app name, logo, tagline, maintenance
- Settings > Ride Pricing (settings-ride-pricing): base fares, per-km rates, surge, bargaining
- Settings > Payment (settings-payment): JazzCash, EasyPaisa, COD, wallet toggles
- Settings > Orders (settings-orders): delivery radius, cart limits
- Settings > Finance (settings-finance): commission rates, GST, payouts
- Settings > Security (settings-security): OTP, MFA, session expiry, IP whitelist
- Settings > Features (settings-features): enable/disable rides/wallet/mart/food/parcel/pharmacy
- Settings > Notifications (settings-notifications): FCM, SMS gateway, WhatsApp OTP
- Settings > Maps (settings-maps): Google Maps, Mapbox, LocationIQ config
- Settings > Integrations (settings-integrations): SMTP, SMS, WhatsApp, Firebase config

Quick Actions (pre-filtered views):
- Pending Orders (action-pending-orders): /orders?status=pending
- Cancelled Orders (action-cancelled-orders): /orders?status=cancelled
- Searching Rides (action-searching-rides): /rides?status=searching
- Bargaining Rides (action-bargaining-rides): /rides?status=bargaining
- Cancelled Rides (action-cancelled-rides): /rides?status=cancelled
- Pending KYC (action-pending-kyc): /kyc?status=pending
- Pending Withdrawals (action-pending-withdrawals): /withdrawals?status=pending
- Banned Users (action-banned-users): /users?filter=banned
- Send Broadcast (action-send-broadcast): navigate to broadcast page
- Add Promo Code (action-add-promo): navigate to promo codes
- Add Flash Deal (action-add-flash-deal): navigate to flash deals

Supported languages: English, Urdu (اردو), Roman Urdu (phonetic Urdu in Latin script).
`;

    const baseUrl = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
    const apiKey  = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];

    if (!baseUrl || !apiKey) {
      sendError(res, "AI search is not configured", 503); return;
    }

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl } });

    /* Valid IDs are derived from the SEARCH_INDEX defined in the admin frontend.
       Keep this list in sync with artifacts/admin/src/lib/searchIndex.ts */
    const VALID_IDS = [
      "page-dashboard","page-orders","page-rides","page-van","page-pharmacy","page-parcels",
      "page-live-map","page-users","page-vendors","page-riders","page-products","page-categories",
      "page-promotions","page-banners","page-popups","page-flash-deals","page-promo-codes",
      "page-transactions","page-withdrawals","page-deposits","page-loyalty","page-kyc",
      "page-wallet-transfers","page-reviews","page-notifications","page-broadcast",
      "page-sos","page-error-monitor","page-security","page-account-conditions",
      "page-condition-rules","page-support-chat","page-faq","page-search-analytics",
      "page-communication","page-chat-monitor","page-wishlist-insights","page-qr-codes",
      "page-experiments","page-webhooks","page-deep-links","page-settings","page-app-management",
      "page-delivery-access",
      "settings-general","settings-ride-pricing","settings-payment","settings-orders",
      "settings-finance","settings-security","settings-features","settings-notifications",
      "settings-maps","settings-integrations",
      "action-live-rides","action-send-broadcast","action-add-promo","action-add-flash-deal",
      "action-pending-orders","action-cancelled-orders","action-searching-rides",
      "action-bargaining-rides","action-cancelled-rides","action-pending-kyc",
      "action-pending-withdrawals","action-search-users","action-banned-users",
    ];

    const systemPrompt = `You are a search assistant for the AJKMart Admin Panel. The user typed a search query. Your job is to interpret their intent — even if the query is in Urdu, Roman Urdu, or English — and return the most relevant admin panel pages/sections.

${adminStructure}

Return a JSON object with this structure (no markdown, no code fences):
{
  "results": [
    { "id": "page-orders", "title": "Orders", "path": "/orders", "reason": "brief reason" },
    ...
  ],
  "suggestedFilters": ["pending", "cancelled"]
}

You MUST only use IDs from this exact list (do NOT invent new IDs):
${VALID_IDS.join(", ")}

Return max 5 results. Only include results that are genuinely relevant. If unsure, still return at most 3 plausible results.`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: `Search query: "${q}"\nLocale: ${locale ?? "auto"}` }] }],
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    });

    const text = response.text ?? "{}";
    let parsed: { results?: unknown[]; suggestedFilters?: string[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { results: [], suggestedFilters: [] };
    }

    const VALID_IDS_SET = new Set(VALID_IDS);

    /* Validate each result: must have a known id (string) and a string title */
    interface AiResult { id: string; title: string; path?: string; reason?: string }
    const validResults: AiResult[] = Array.isArray(parsed.results)
      ? parsed.results.filter((r): r is AiResult =>
          typeof r === "object" && r !== null &&
          typeof (r as AiResult).id === "string" &&
          VALID_IDS_SET.has((r as AiResult).id) &&
          typeof (r as AiResult).title === "string"
        )
      : [];

    sendSuccess(res, {
      results: validResults,
      suggestedFilters: Array.isArray(parsed.suggestedFilters)
        ? parsed.suggestedFilters.filter(f => typeof f === "string")
        : [],
      query: q,
    });
  } catch (err: any) {
    logger.error({ err }, "AI search error");
    sendError(res, "AI search failed, falling back to keyword search", 503);
  }
});

/* ── AI Natural-Language Command Executor ────────────────────────────────── */
router.post("/command/execute", adminAuth, async (req, res) => {
  try {
    const { command } = req.body as { command?: string };
    if (!command || command.trim().length < 3) {
      sendValidationError(res, "command is required (min 3 chars)"); return;
    }
    const cmd = command.trim();

    const baseUrl = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
    const apiKey  = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];

    if (!baseUrl || !apiKey) {
      sendError(res, "AI command execution is not configured", 503); return;
    }

    const SAFE_TOGGLE_KEYS: Record<string, string> = {
      maintenance_mode:      "Maintenance Mode",
      rides_enabled:         "Rides Service",
      food_enabled:          "Food Service",
      mart_enabled:          "Mart Service",
      wallet_enabled:        "Wallet",
      parcel_enabled:        "Parcel Service",
      pharmacy_enabled:      "Pharmacy Service",
      van_enabled:           "Van Service",
      registration_open:     "User Registration",
      vendor_registration:   "Vendor Registration",
      rider_registration:    "Rider Registration",
    };

    const SAFE_WRITE_KEYS: Record<string, { label: string; type: "number" | "string" }> = {
      delivery_radius_km:         { label: "Delivery Radius (km)", type: "number" },
      min_order_amount:           { label: "Minimum Order Amount", type: "number" },
      max_order_amount:           { label: "Maximum Order Amount", type: "number" },
      platform_commission_percent:{ label: "Platform Commission %", type: "number" },
      gst_percent:                { label: "GST/Tax %", type: "number" },
      support_phone:              { label: "Support Phone", type: "string" },
      support_email:              { label: "Support Email", type: "string" },
      app_name:                   { label: "App Name", type: "string" },
    };

    const systemPrompt = `You are an AJKMart admin command parser. Parse the user's natural-language command and return a JSON action. Return ONLY valid JSON, no markdown.

Available toggle settings (true/false):
${Object.entries(SAFE_TOGGLE_KEYS).map(([k, l]) => `- ${k}: ${l}`).join("\n")}

Available value settings:
${Object.entries(SAFE_WRITE_KEYS).map(([k, v]) => `- ${k} (${v.type}): ${v.label}`).join("\n")}

Return one of these JSON structures:

For toggle:
{"type":"toggle","key":"<key>","value":"true"|"false","label":"<human label>","description":"<what this does>"}

For setting a value:
{"type":"set","key":"<key>","value":"<new value>","label":"<human label>","description":"<what this does>"}

For navigate:
{"type":"navigate","path":"<path>","label":"<page name>","description":"<what this opens>"}

For unrecognized commands:
{"type":"unknown","description":"Could not interpret command: <brief reason>"}

Important: Only use keys from the lists above. If the command is ambiguous, map it to the closest match or return unknown.`;

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl } });

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: `Admin command: "${cmd}"` }] }],
      config: { systemInstruction: systemPrompt, maxOutputTokens: 512, responseMimeType: "application/json" },
    });

    const text = response.text ?? "{}";
    interface ParsedAction {
      type: "toggle" | "set" | "navigate" | "unknown";
      key?: string;
      value?: string;
      label?: string;
      path?: string;
      description?: string;
    }
    let action: ParsedAction;
    try {
      action = JSON.parse(text) as ParsedAction;
    } catch {
      action = { type: "unknown", description: "Could not parse AI response" };
    }

    if (action.type === "unknown" || !action.type) {
      return sendSuccess(res, {
        executed: false,
        type: "unknown",
        description: action.description ?? "Command not understood",
        command: cmd,
      });
    }

    if (action.type === "navigate") {
      return sendSuccess(res, {
        executed: false,
        type: "navigate",
        path: action.path,
        label: action.label,
        description: action.description,
        command: cmd,
      });
    }

    /* ── Execute toggle or set ─────────────────────────────────────────── */
    const key = action.key;
    if (!key) {
      return sendSuccess(res, { executed: false, type: "unknown", description: "Missing setting key", command: cmd });
    }

    const isToggle = action.type === "toggle" && key in SAFE_TOGGLE_KEYS;
    const isSet    = action.type === "set"    && key in SAFE_WRITE_KEYS;

    if (!isToggle && !isSet) {
      return sendSuccess(res, { executed: false, type: "unknown", description: `Setting "${key}" is not in the allowed list`, command: cmd });
    }

    const newValue = action.value ?? "";

    const [existing] = await db.select().from(platformSettingsTable)
      .where(eq(platformSettingsTable.key, key))
      .limit(1);

    const previousValue = existing?.value ?? null;

    await db.insert(platformSettingsTable).values({
      key,
      value: newValue,
      label: SAFE_TOGGLE_KEYS[key] ?? SAFE_WRITE_KEYS[key]?.label ?? key,
      category: "ai_command",
    }).onConflictDoUpdate({
      target: platformSettingsTable.key,
      set: { value: newValue, updatedAt: new Date() },
    });

    return sendSuccess(res, {
      executed: true,
      type: action.type,
      key,
      value: newValue,
      previousValue,
      label: action.label ?? SAFE_TOGGLE_KEYS[key] ?? SAFE_WRITE_KEYS[key]?.label ?? key,
      description: action.description,
      command: cmd,
    });
  } catch (err) {
    logger.error({ err }, "Command execution failed");
    sendError(res, "Command execution failed", 500);
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
   NEW ENDPOINTS — Task 4: Operations Pages (51–100)
══════════════════════════════════════════════════════════════════════════════ */

/* ── PATCH /admin/users/:id/request-correction — ask user to re-upload specific doc ── */

/* ══════════════════════════════════════════════════════════════════════════════
   RIDE MANAGEMENT MODULE — Admin ride actions with full audit logging
══════════════════════════════════════════════════════════════════════════════ */

router.get("/reviews", adminAuth, async (req, res) => {
  const page   = Math.max(1, parseInt(String(req.query["page"]  || "1")));
  const limit  = Math.min(parseInt(String(req.query["limit"] || "50")), 200);
  const offset = (page - 1) * limit;

  const typeFilter    = req.query["type"]    as string | undefined;  // "order" | "ride"
  const starsFilter   = req.query["stars"]   as string | undefined;  // "1"–"5"
  const statusFilter  = req.query["status"]  as string | undefined;  // "visible" | "hidden" | "deleted"
  const subjectFilter = req.query["subject"] as string | undefined;  // "vendor" | "rider"
  const dateFrom      = req.query["dateFrom"] as string | undefined;
  const dateTo        = req.query["dateTo"]   as string | undefined;

  /* ── Order Reviews ── */
  const orderConditions: SQL[] = [];
  if (starsFilter) orderConditions.push(eq(reviewsTable.rating, parseInt(starsFilter)));
  if (statusFilter === "hidden")  orderConditions.push(eq(reviewsTable.hidden, true));
  if (statusFilter === "deleted") orderConditions.push(isNotNull(reviewsTable.deletedAt));
  if (statusFilter === "visible") orderConditions.push(eq(reviewsTable.hidden, false), isNull(reviewsTable.deletedAt));
  if (dateFrom) orderConditions.push(gte(reviewsTable.createdAt, new Date(dateFrom)));
  if (dateTo)   orderConditions.push(lte(reviewsTable.createdAt, new Date(dateTo)));
  /* subject filter:
     vendor = has vendorId (includes dual-rated delivery orders)
     rider  = has riderId (includes both ride-only AND dual-rated delivery orders where rider feedback exists) */
  if (subjectFilter === "vendor") orderConditions.push(isNotNull(reviewsTable.vendorId));
  if (subjectFilter === "rider")  orderConditions.push(isNotNull(reviewsTable.riderId));

  /* ── Ride Ratings ── */
  const rideConditions: SQL[] = [];
  if (starsFilter) rideConditions.push(eq(rideRatingsTable.stars, parseInt(starsFilter)));
  if (statusFilter === "hidden")  rideConditions.push(eq(rideRatingsTable.hidden, true));
  if (statusFilter === "deleted") rideConditions.push(isNotNull(rideRatingsTable.deletedAt));
  if (statusFilter === "visible") rideConditions.push(eq(rideRatingsTable.hidden, false), isNull(rideRatingsTable.deletedAt));
  if (dateFrom) rideConditions.push(gte(rideRatingsTable.createdAt, new Date(dateFrom)));
  if (dateTo)   rideConditions.push(lte(rideRatingsTable.createdAt, new Date(dateTo)));
  /* For ride_ratings: all rows are rider-subject; vendor filter means exclude all ride_ratings */
  const skipRideRatings = subjectFilter === "vendor";

  const [orderReviews, rideRatings] = await Promise.all([
    typeFilter === "ride" ? [] : db
      .select({
        id: reviewsTable.id,
        type: sql<string>`'order'`,
        rating: reviewsTable.rating,
        riderRating: reviewsTable.riderRating,
        comment: reviewsTable.comment,
        orderType: reviewsTable.orderType,
        hidden: reviewsTable.hidden,
        deletedAt: reviewsTable.deletedAt,
        createdAt: reviewsTable.createdAt,
        reviewerId: reviewsTable.userId,
        subjectId: sql<string | null>`COALESCE(${reviewsTable.vendorId}, ${reviewsTable.riderId})`,
        subjectRiderId: reviewsTable.riderId,
        reviewerName: usersTable.name,
        reviewerPhone: usersTable.phone,
      })
      .from(reviewsTable)
      .leftJoin(usersTable, eq(reviewsTable.userId, usersTable.id))
      .where(orderConditions.length > 0 ? and(...orderConditions) : undefined)
      .orderBy(desc(reviewsTable.createdAt)),

    (typeFilter === "order" || skipRideRatings) ? [] : db
      .select({
        id: rideRatingsTable.id,
        type: sql<string>`'ride'`,
        rating: rideRatingsTable.stars,
        riderRating: sql<null>`null`,
        comment: rideRatingsTable.comment,
        orderType: sql<string>`'ride'`,
        hidden: rideRatingsTable.hidden,
        deletedAt: rideRatingsTable.deletedAt,
        createdAt: rideRatingsTable.createdAt,
        reviewerId: rideRatingsTable.customerId,
        subjectId: rideRatingsTable.riderId,
        subjectRiderId: rideRatingsTable.riderId,
        reviewerName: usersTable.name,
        reviewerPhone: usersTable.phone,
      })
      .from(rideRatingsTable)
      .leftJoin(usersTable, eq(rideRatingsTable.customerId, usersTable.id))
      .where(rideConditions.length > 0 ? and(...rideConditions) : undefined)
      .orderBy(desc(rideRatingsTable.createdAt)),
  ]);

  /* Merge and sort by date descending */
  const combined = [...orderReviews, ...rideRatings]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = combined.length;
  const paginated = combined.slice(offset, offset + limit);

  /* Enrich with subject names */
  const subjectIds = [...new Set(paginated.map(r => r.subjectId).filter(Boolean))];
  const subjectUsers = subjectIds.length > 0
    ? await db.select({ id: usersTable.id, name: usersTable.name, storeName: vendorProfilesTable.storeName, phone: usersTable.phone })
        .from(usersTable)
        .leftJoin(vendorProfilesTable, eq(usersTable.id, vendorProfilesTable.userId))
        .where(sql`${usersTable.id} = ANY(${subjectIds})`)
    : [];
  const subjectMap = new Map(subjectUsers.map(u => [u.id, u]));

  const enriched = paginated.map(r => ({
    ...r,
    deletedAt: r.deletedAt ? r.deletedAt.toISOString?.() ?? r.deletedAt : null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    subjectName: r.subjectId ? (subjectMap.get(r.subjectId)?.storeName || subjectMap.get(r.subjectId)?.name || null) : null,
    subjectPhone: r.subjectId ? subjectMap.get(r.subjectId)?.phone ?? null : null,
  }));

  sendSuccess(res, { reviews: enriched, total, page, limit, pages: Math.ceil(total / limit) });
});

/* ── PATCH /admin/reviews/:id/hide — toggle hidden status ── */
router.patch("/reviews/:id/hide", adminAuth, async (req, res) => {
  const [existing] = await db.select({ id: reviewsTable.id, hidden: reviewsTable.hidden })
    .from(reviewsTable).where(eq(reviewsTable.id, String(req.params["id"]))).limit(1);
  if (!existing) { sendNotFound(res, "Review not found"); return; }
  const newHidden = !existing.hidden;
  await db.update(reviewsTable).set({ hidden: newHidden }).where(eq(reviewsTable.id, existing.id));
  sendSuccess(res, { hidden: newHidden });
});

/* ── DELETE /admin/reviews/:id — soft delete ── */
router.delete("/reviews/:id", adminAuth, async (req, res) => {
  const adminId = (req as AdminRequest).adminId ?? "admin";
  const [existing] = await db.select({ id: reviewsTable.id })
    .from(reviewsTable).where(eq(reviewsTable.id, String(req.params["id"]))).limit(1);
  if (!existing) { sendNotFound(res, "Review not found"); return; }
  await db.update(reviewsTable)
    .set({ deletedAt: new Date(), deletedBy: adminId, hidden: true })
    .where(eq(reviewsTable.id, existing.id));
  sendSuccess(res);
});

/* ── PATCH /admin/ride-ratings/:id/hide — toggle hidden status ── */
router.patch("/ride-ratings/:id/hide", adminAuth, async (req, res) => {
  const [existing] = await db.select({ id: rideRatingsTable.id, hidden: rideRatingsTable.hidden })
    .from(rideRatingsTable).where(eq(rideRatingsTable.id, String(req.params["id"]))).limit(1);
  if (!existing) { sendNotFound(res, "Ride rating not found"); return; }
  const newHidden = !existing.hidden;
  await db.update(rideRatingsTable).set({ hidden: newHidden }).where(eq(rideRatingsTable.id, existing.id));
  sendSuccess(res, { hidden: newHidden });
});

/* ── DELETE /admin/ride-ratings/:id — soft delete ── */
router.delete("/ride-ratings/:id", adminAuth, async (req, res) => {
  const adminId = (req as AdminRequest).adminId ?? "admin";
  const [existing] = await db.select({ id: rideRatingsTable.id })
    .from(rideRatingsTable).where(eq(rideRatingsTable.id, String(req.params["id"]))).limit(1);
  if (!existing) { sendNotFound(res, "Ride rating not found"); return; }
  await db.update(rideRatingsTable)
    .set({ deletedAt: new Date(), deletedBy: adminId, hidden: true })
    .where(eq(rideRatingsTable.id, existing.id));
  sendSuccess(res);
});

/* ── GET /admin/vendor-ratings — vendor rating leaderboard ─────────── */
router.get("/vendor-ratings", adminAuth, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    /* Aggregate all visible + pending reviews grouped by vendorId */
    const vendorStats = await db
      .select({
        vendorId: reviewsTable.vendorId,
        avgRating: avg(reviewsTable.rating),
        totalReviews: count(),
        oneStarCount: sql<number>`COUNT(*) FILTER (WHERE ${reviewsTable.rating} = 1)`,
        twoStarCount: sql<number>`COUNT(*) FILTER (WHERE ${reviewsTable.rating} = 2)`,
        fiveStarCount: sql<number>`COUNT(*) FILTER (WHERE ${reviewsTable.rating} = 5)`,
        pendingCount: sql<number>`COUNT(*) FILTER (WHERE ${reviewsTable.status} = 'pending_moderation')`,
        hiddenCount: sql<number>`COUNT(*) FILTER (WHERE ${reviewsTable.hidden} = true)`,
        recentAvg: sql<number>`AVG(${reviewsTable.rating}) FILTER (WHERE ${reviewsTable.createdAt} >= ${thirtyDaysAgo})`,
        recentCount: sql<number>`COUNT(*) FILTER (WHERE ${reviewsTable.createdAt} >= ${thirtyDaysAgo})`,
        latestReviewAt: sql<string>`MAX(${reviewsTable.createdAt})`,
      })
      .from(reviewsTable)
      .where(and(
        isNotNull(reviewsTable.vendorId),
        isNull(reviewsTable.deletedAt),
      ))
      .groupBy(reviewsTable.vendorId)
      .orderBy(asc(avg(reviewsTable.rating)));

    if (vendorStats.length === 0) {
      sendSuccess(res, { vendors: [] });
      return;
    }

    /* Enrich with vendor profile info */
    const vendorIds = vendorStats.map(v => v.vendorId).filter(Boolean) as string[];
    const vendorProfiles = await db
      .select({
        userId: vendorProfilesTable.userId,
        storeName: vendorProfilesTable.storeName,
        storeType: vendorProfilesTable.businessType,
        isActive: vendorProfilesTable.storeIsOpen,
        phone: usersTable.phone,
        name: usersTable.name,
      })
      .from(vendorProfilesTable)
      .leftJoin(usersTable, eq(vendorProfilesTable.userId, usersTable.id))
      .where(sql`${vendorProfilesTable.userId} = ANY(${vendorIds})`);

    const profileMap = new Map(vendorProfiles.map(p => [p.userId, p]));

    const vendors = vendorStats.map(v => {
      const profile = v.vendorId ? profileMap.get(v.vendorId) : null;
      return {
        vendorId: v.vendorId,
        storeName: profile?.storeName ?? profile?.name ?? v.vendorId,
        storeType: profile?.storeType ?? null,
        isActive: profile?.isActive ?? true,
        phone: profile?.phone ?? null,
        avgRating: v.avgRating ? parseFloat(String(v.avgRating)).toFixed(2) : null,
        totalReviews: Number(v.totalReviews),
        oneStarCount: Number(v.oneStarCount),
        twoStarCount: Number(v.twoStarCount),
        fiveStarCount: Number(v.fiveStarCount),
        pendingCount: Number(v.pendingCount),
        hiddenCount: Number(v.hiddenCount),
        recentAvg: v.recentAvg ? parseFloat(String(v.recentAvg)).toFixed(2) : null,
        recentCount: Number(v.recentCount),
        latestReviewAt: v.latestReviewAt,
      };
    });

    sendSuccess(res, { vendors });
  } catch (e) {
    logger.error({ err: e }, "[admin] vendor-ratings error");
    sendError(res, "Failed to load vendor ratings.", 500);
  }
});

/* ── GET /admin/reviews/export — export CSV ────────────────────────────── */
router.get("/reviews/export", async (req, res) => {
  const { status, type } = req.query as Record<string, string>;

  const conditions: SQL[] = [];
  if (status && status !== "all") conditions.push(eq(reviewsTable.status, status));
  if (type && type !== "all") conditions.push(eq(reviewsTable.orderType, type));

  const rows = await db
    .select({
      review: reviewsTable,
      reviewerName: usersTable.name,
      reviewerPhone: usersTable.phone,
    })
    .from(reviewsTable)
    .leftJoin(usersTable, eq(reviewsTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reviewsTable.createdAt));

  const escCSV = (v: unknown) => {
    const s = String(v ?? "").replace(/"/g, '""');
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s}"` : s;
  };

  const header = ["id", "orderType", "orderId", "vendorId", "riderId", "reviewer", "stars", "comment", "vendorReply", "status", "date"].join(",");
  const csvRows = rows.map(r => [
    escCSV(r.review.id),
    escCSV(r.review.orderType),
    escCSV(r.review.orderId),
    escCSV(r.review.vendorId || ""),
    escCSV(r.review.riderId || ""),
    escCSV(r.reviewerName || r.reviewerPhone || ""),
    escCSV(r.review.rating),
    escCSV(r.review.comment || ""),
    escCSV(r.review.vendorReply || ""),
    escCSV(r.review.status),
    escCSV(r.review.createdAt.toISOString().slice(0, 10)),
  ].join(","));

  const csv = [header, ...csvRows].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="reviews-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

/* ── POST /admin/reviews/import — import CSV ────────────────────────────── */
router.post("/reviews/import", async (req, res) => {
  const { csvData } = req.body;
  if (!csvData || typeof csvData !== "string") {
    sendValidationError(res, "csvData (string) is required");
    return;
  }

  const lines = csvData.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    sendValidationError(res, "CSV must have a header and at least one data row");
    return;
  }

  const header = lines[0]!.split(",").map(h => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const requiredCols = ["ordertype", "orderid", "stars"];
  const missing = requiredCols.filter(c => !header.includes(c));
  if (missing.length > 0) {
    sendValidationError(res, `Missing required columns: ${missing.join(", ")}`);
    return;
  }

  const col = (row: string[], name: string) => {
    const idx = header.indexOf(name);
    return idx >= 0 ? (row[idx] || "").replace(/^"|"$/g, "").trim() : "";
  };

  let imported = 0, skipped = 0, errored = 0;
  const errors: Array<{ row: number; reason: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] || "").match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || lines[i]!.split(",");
    try {
      const orderId   = col(cells, "orderid");
      const userId    = col(cells, "userid") || generateId();
      const orderType = col(cells, "ordertype");
      const ratingStr = col(cells, "stars") || col(cells, "rating");
      const rating    = parseInt(ratingStr);

      if (!orderId || !orderType || isNaN(rating) || rating < 1 || rating > 5) {
        errored++;
        const missing: string[] = [];
        if (!orderId) missing.push("orderid");
        if (!orderType) missing.push("ordertype");
        if (isNaN(rating) || rating < 1 || rating > 5) missing.push("stars (must be 1-5)");
        errors.push({ row: i, reason: `Validation failed: ${missing.join(", ")}` });
        continue;
      }

      const existing = await db.select({ id: reviewsTable.id })
        .from(reviewsTable)
        .where(and(eq(reviewsTable.orderId, orderId), eq(reviewsTable.userId, userId)))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await db.insert(reviewsTable).values({
        id: generateId(),
        orderId,
        userId,
        vendorId: col(cells, "vendorid") || null,
        riderId: col(cells, "riderid") || null,
        orderType,
        rating,
        comment: col(cells, "comment") || null,
        vendorReply: col(cells, "vendorreply") || null,
        status: col(cells, "status") || "visible",
      });
      imported++;
    } catch (err: unknown) {
      errored++;
      errors.push({ row: i, reason: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  sendSuccess(res, { imported, skipped, errored, total: lines.length - 1, errors });
});

/* ── GET /admin/reviews/moderation-queue — pending moderation ─────────── */
router.get("/reviews/moderation-queue", async (req, res) => {
  const rows = await db
    .select({
      review: reviewsTable,
      reviewerName: usersTable.name,
      reviewerPhone: usersTable.phone,
    })
    .from(reviewsTable)
    .leftJoin(usersTable, eq(reviewsTable.userId, usersTable.id))
    .where(eq(reviewsTable.status, "pending_moderation"))
    .orderBy(desc(reviewsTable.createdAt));

  sendSuccess(res, {
    reviews: rows.map(r => ({
      ...r.review,
      reviewerName: r.reviewerName,
      reviewerPhone: r.reviewerPhone,
    })),
    total: rows.length,
  });
});

/* ── PATCH /admin/reviews/:id/approve — approve a moderated review ──────── */
router.patch("/reviews/:id/approve", async (req, res) => {
  const [updated] = await db.update(reviewsTable)
    .set({ status: "visible" })
    .where(and(eq(reviewsTable.id, req.params["id"]!), eq(reviewsTable.status, "pending_moderation")))
    .returning();
  if (!updated) { sendNotFound(res, "Review not found or not pending moderation"); return; }
  sendSuccess(res, updated);
});

/* ── PATCH /admin/reviews/:id/reject — reject (soft-delete) a moderated review ─ */
router.patch("/reviews/:id/reject", async (req, res) => {
  const [updated] = await db.update(reviewsTable)
    .set({ status: "rejected" })
    .where(eq(reviewsTable.id, req.params["id"]!))
    .returning();
  if (!updated) { sendNotFound(res, "Review not found"); return; }
  sendSuccess(res, updated);
});

/* ── POST /admin/jobs/rating-suspension — auto-suspend low-rated riders/vendors ─ */
router.post("/jobs/rating-suspension", async (req, res) => {
  const s = await getCachedSettings();
  const riderThreshold  = parseFloat(s["auto_suspend_rating_threshold"] ?? "2.5");
  const riderMinReviews = parseInt(s["auto_suspend_min_reviews"] ?? "10");
  const vendorThreshold  = parseFloat(s["auto_suspend_vendor_threshold"] ?? "2.5");
  const vendorMinReviews = parseInt(s["auto_suspend_vendor_min_reviews"] ?? "10");

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const now = new Date();

  let suspendedRiders = 0;
  let suspendedVendors = 0;

  /* ── Rider auto-suspension ── */
  const riderRatings = await db
    .select({
      riderId: reviewsTable.riderId,
      avgRating: avg(reviewsTable.rating),
      reviewCount: count(),
    })
    .from(reviewsTable)
    .where(and(
      eq(reviewsTable.status, "visible"),
      gte(reviewsTable.createdAt, thirtyDaysAgo),
      ne(reviewsTable.riderId, ""),
    ))
    .groupBy(reviewsTable.riderId);

  for (const row of riderRatings) {
    if (!row.riderId) continue;
    const avg_ = parseFloat(String(row.avgRating ?? "5"));
    const cnt  = Number(row.reviewCount ?? 0);
    if (cnt >= riderMinReviews && avg_ < riderThreshold) {
      const [rider] = await db.select({ id: usersTable.id, isActive: usersTable.isActive, adminOverrideSuspension: usersTable.adminOverrideSuspension })
        .from(usersTable)
        .where(eq(usersTable.id, row.riderId))
        .limit(1);

      if (rider && rider.isActive && !rider.adminOverrideSuspension) {
        await db.update(usersTable).set({
          isActive: false,
          autoSuspendedAt: now,
          autoSuspendReason: `Average rating ${avg_.toFixed(1)} (${cnt} reviews in last 30 days) fell below threshold ${riderThreshold}`,
          updatedAt: now,
        }).where(eq(usersTable.id, rider.id));

        await db.insert(notificationsTable).values({
          id: generateId(),
          userId: rider.id,
          title: "Account Suspended",
          body: `Your account has been automatically suspended due to a low average rating of ${avg_.toFixed(1)} stars. Please contact support for assistance.`,
          type: "system",
          icon: "alert-circle-outline",
        }).catch(() => {});

        suspendedRiders++;
      }
    }
  }

  /* ── Vendor auto-suspension ── */
  const vendorRatings = await db
    .select({
      vendorId: reviewsTable.vendorId,
      avgRating: avg(reviewsTable.rating),
      reviewCount: count(),
    })
    .from(reviewsTable)
    .where(and(
      eq(reviewsTable.status, "visible"),
      gte(reviewsTable.createdAt, thirtyDaysAgo),
      ne(reviewsTable.vendorId, ""),
    ))
    .groupBy(reviewsTable.vendorId);

  for (const row of vendorRatings) {
    if (!row.vendorId) continue;
    const avg_ = parseFloat(String(row.avgRating ?? "5"));
    const cnt  = Number(row.reviewCount ?? 0);
    if (cnt >= vendorMinReviews && avg_ < vendorThreshold) {
      const [vendor] = await db.select({ id: usersTable.id, isActive: usersTable.isActive, adminOverrideSuspension: usersTable.adminOverrideSuspension })
        .from(usersTable)
        .where(eq(usersTable.id, row.vendorId))
        .limit(1);

      if (vendor && vendor.isActive && !vendor.adminOverrideSuspension) {
        await db.update(usersTable).set({
          isActive: false,
          autoSuspendedAt: now,
          autoSuspendReason: `Average vendor rating ${avg_.toFixed(1)} (${cnt} reviews in last 30 days) fell below threshold ${vendorThreshold}`,
          updatedAt: now,
        }).where(eq(usersTable.id, vendor.id));

        await db.insert(notificationsTable).values({
          id: generateId(),
          userId: vendor.id,
          title: "Store Suspended",
          body: `Your store has been automatically suspended due to a low average rating of ${avg_.toFixed(1)} stars. Please contact support for assistance.`,
          type: "system",
          icon: "alert-circle-outline",
        }).catch(() => {});

        suspendedVendors++;
      }
    }
  }

  sendSuccess(res, {
    success: true,
    suspendedRiders,
    suspendedVendors,
    message: `Suspended ${suspendedRiders} rider(s) and ${suspendedVendors} vendor(s) due to low ratings.`,
  });
});

const ALLOWED_SOS_STATUSES = new Set(["pending", "acknowledged", "resolved"]);

/* ── POST /admin/riders/:id/override-suspension — override auto-suspension ─ */
router.get("/sos/alerts", async (req, res) => {
  const page   = Math.max(1, parseInt(String(req.query["page"]  || "1"),  10));
  const limit  = Math.min(50, Math.max(1, parseInt(String(req.query["limit"] || "20"), 10)));
  const offset = (page - 1) * limit;
  const rawStatus = req.query["status"] as string | undefined;
  const statusFilter = rawStatus && ALLOWED_SOS_STATUSES.has(rawStatus) ? rawStatus : undefined;

  const baseWhere = eq(notificationsTable.type, "sos");
  const whereClause = statusFilter
    ? and(baseWhere, eq(notificationsTable.sosStatus, statusFilter))
    : baseWhere;

  const [alerts, totalRows, unresolvedRows] = await Promise.all([
    db.select().from(notificationsTable)
      .where(whereClause)
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ id: notificationsTable.id }).from(notificationsTable).where(whereClause).then(r => r.length),
    /* unresolved = pending + acknowledged (anything not resolved) */
    db.select({ id: notificationsTable.id }).from(notificationsTable)
      .where(and(eq(notificationsTable.type, "sos"), ne(notificationsTable.sosStatus, "resolved")))
      .then(r => r.length),
  ]);

  sendSuccess(res, {
    alerts:      alerts.map(serializeSosAlert),
    total:       totalRows,
    page,
    hasMore:     offset + alerts.length < totalRows,
    activeCount: unresolvedRows,
  });
});

/* PATCH /admin/sos/alerts/:id/acknowledge */
router.patch("/sos/alerts/:id/acknowledge", async (req, res) => {
  const alertId  = req.params["id"];
  const adminId  = (req as AdminRequest).adminId  ?? "admin";
  const adminName = (req as AdminRequest).adminName ?? "Admin";

  const [existing] = await db.select().from(notificationsTable)
    .where(and(eq(notificationsTable.id, alertId), eq(notificationsTable.type, "sos")))
    .limit(1);

  if (!existing) { sendNotFound(res, "SOS alert not found"); return; }
  if (existing.sosStatus === "acknowledged") {
    sendErrorWithData(res, "Alert is already acknowledged", { acknowledgedBy: existing.acknowledgedByName ?? existing.acknowledgedBy ?? "another admin" }, 409);
    return;
  }
  if (existing.sosStatus === "resolved") { sendError(res, "Alert is already resolved", 409); return; }

  const now = new Date();
  await db.update(notificationsTable)
    .set({ sosStatus: "acknowledged", acknowledgedAt: now, acknowledgedBy: adminId, acknowledgedByName: adminName })
    .where(eq(notificationsTable.id, alertId));

  const [updatedAck] = await db.select().from(notificationsTable).where(eq(notificationsTable.id, alertId)).limit(1);
  const fullAckPayload = serializeSosAlert(updatedAck) as SosAlertPayload;
  try { emitSosAcknowledged(fullAckPayload); } catch { /* non-critical */ }
  sendSuccess(res, { ok: true, alert: fullAckPayload });
});

/* PATCH /admin/sos/alerts/:id/resolve */
router.patch("/sos/alerts/:id/resolve", async (req, res) => {
  const alertId   = req.params["id"];
  const adminId   = (req as AdminRequest).adminId  ?? "admin";
  const adminName = (req as AdminRequest).adminName ?? "Admin";
  const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : null;

  const [existing] = await db.select().from(notificationsTable)
    .where(and(eq(notificationsTable.id, alertId), eq(notificationsTable.type, "sos")))
    .limit(1);

  if (!existing) { sendNotFound(res, "SOS alert not found"); return; }
  if (existing.sosStatus === "resolved") { sendError(res, "Alert is already resolved", 409); return; }

  const now = new Date();
  await db.update(notificationsTable)
    .set({ sosStatus: "resolved", resolvedAt: now, resolvedBy: adminId, resolvedByName: adminName, resolutionNotes: notes || null })
    .where(eq(notificationsTable.id, alertId));

  const [updatedRes] = await db.select().from(notificationsTable).where(eq(notificationsTable.id, alertId)).limit(1);
  const fullResPayload = serializeSosAlert(updatedRes) as SosAlertPayload;
  try { emitSosResolved(fullResPayload); } catch { /* non-critical */ }
  sendSuccess(res, { ok: true, alert: fullResPayload });
});

/* ── GET /admin/fleet/vendors — active vendor store pins for the fleet map ─────
   Returns all active/approved vendors that have storeLat + storeLng set.
   Used by the Live Fleet Map to render static vendor store-location markers. */
router.get("/fleet/vendors", async (_req, res) => {
  try {
    const vendors = await db
      .select({
        id:            usersTable.id,
        name:          usersTable.name,
        storeName:     vendorProfilesTable.storeName,
        storeAddress:  vendorProfilesTable.storeAddress,
        city:          usersTable.city,
        storeLat:      vendorProfilesTable.storeLat,
        storeLng:      vendorProfilesTable.storeLng,
        storeIsOpen:   vendorProfilesTable.storeIsOpen,
        storeCategory: vendorProfilesTable.storeCategory,
      })
      .from(usersTable)
      .leftJoin(vendorProfilesTable, eq(usersTable.id, vendorProfilesTable.userId))
      .where(
        and(
          ilike(usersTable.roles, "%vendor%"),
          eq(usersTable.isActive, true),
          eq(usersTable.approvalStatus, "approved"),
          isNotNull(vendorProfilesTable.storeLat),
          isNotNull(vendorProfilesTable.storeLng),
        )
      )
      .orderBy(asc(usersTable.name));

    const vendorIds = vendors.map(v => v.id);
    const activeOrderCounts: Record<string, number> = {};

    if (vendorIds.length > 0) {
      const counts = await db
        .select({ vendorId: ordersTable.vendorId, c: count() })
        .from(ordersTable)
        .where(
          and(
            or(
              eq(ordersTable.status, "pending"),
              eq(ordersTable.status, "confirmed"),
              eq(ordersTable.status, "preparing"),
              eq(ordersTable.status, "ready"),
              eq(ordersTable.status, "out_for_delivery"),
            ),
          )
        )
        .groupBy(ordersTable.vendorId);

      for (const row of counts) {
        if (row.vendorId && vendorIds.includes(row.vendorId)) {
          activeOrderCounts[row.vendorId] = Number(row.c);
        }
      }
    }

    const result = vendors
      .filter(v => v.storeLat != null && v.storeLng != null)
      .map(v => {
        const lat = parseFloat(String(v.storeLat));
        const lng = parseFloat(String(v.storeLng));
        if (isNaN(lat) || isNaN(lng)) return null;
        return {
          id:            v.id,
          name:          v.storeName ?? v.name ?? "Vendor",
          storeAddress:  v.storeAddress ?? null,
          city:          v.city ?? null,
          storeCategory: v.storeCategory ?? null,
          storeIsOpen:   v.storeIsOpen ?? false,
          lat,
          lng,
          activeOrders:  activeOrderCounts[v.id] ?? 0,
        };
      })
      .filter(Boolean);

    sendSuccess(res, { vendors: result });
  } catch (err) {
    sendError(res, "Failed to fetch vendor fleet locations", 500);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   WALLET P2P MANAGEMENT
   ══════════════════════════════════════════════════════════════════════════ */

/* ── GET /admin/wallet/stats ─────────────────────────────────────────────── */
router.get("/wallet/stats", adminAuth, async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const todayRes = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE peer_id IS NOT NULL AND type = 'debit') as today_transfers,
        COALESCE(SUM(amount) FILTER (WHERE peer_id IS NOT NULL AND type = 'debit'), 0) as today_volume,
        COUNT(*) FILTER (WHERE flagged = true AND peer_id IS NOT NULL) as today_flagged
      FROM wallet_transactions
      WHERE created_at >= ${todayStart}
    `);
    const monthRes = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE peer_id IS NOT NULL AND type = 'debit') as month_transfers,
        COALESCE(SUM(amount) FILTER (WHERE peer_id IS NOT NULL AND type = 'debit'), 0) as month_volume
      FROM wallet_transactions
      WHERE created_at >= ${monthStart}
    `);
    const totalFlaggedRes = await db.execute(sql`
      SELECT COUNT(*) as total_flagged FROM wallet_transactions WHERE flagged = true AND peer_id IS NOT NULL
    `);

    const r = todayRes.rows?.[0] as any;
    const m = monthRes.rows?.[0] as any;
    const f = totalFlaggedRes.rows?.[0] as any;

    sendSuccess(res, {
      today: {
        transfers: Number(r.today_transfers ?? 0),
        volume: parseFloat(String(r.today_volume ?? "0")),
        flagged: Number(r.today_flagged ?? 0),
      },
      month: {
        transfers: Number(m.month_transfers ?? 0),
        volume: parseFloat(String(m.month_volume ?? "0")),
      },
      totalFlagged: Number(f.total_flagged ?? 0),
    });
  } catch (e) {
    logger.error({ err: e }, "[admin] wallet/stats error");
    sendError(res, "Failed to load wallet stats", 500);
  }
});

/* ── GET /admin/wallet/p2p-transactions ────────────────────────────────── */
router.get("/wallet/p2p-transactions", adminAuth, async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query["page"]  || "1")));
    const limit    = Math.min(parseInt(String(req.query["limit"] || "50")), 200);
    const offset   = (page - 1) * limit;
    const userId   = req.query["userId"]   as string | undefined;
    const dateFrom = req.query["dateFrom"] as string | undefined;
    const dateTo   = req.query["dateTo"]   as string | undefined;
    const minAmt   = req.query["minAmt"]   as string | undefined;
    const maxAmt   = req.query["maxAmt"]   as string | undefined;
    const flaggedQ = req.query["flagged"]  as string | undefined;

    let whereClause = sql`peer_id IS NOT NULL AND type = 'debit'`;
    if (userId)   whereClause = sql`${whereClause} AND (wt.user_id = ${userId} OR wt.peer_id = ${userId})`;
    if (dateFrom) whereClause = sql`${whereClause} AND wt.created_at >= ${new Date(dateFrom)}`;
    if (dateTo)   whereClause = sql`${whereClause} AND wt.created_at <= ${new Date(dateTo)}`;
    if (minAmt)   whereClause = sql`${whereClause} AND CAST(wt.amount AS NUMERIC) >= ${parseFloat(minAmt)}`;
    if (maxAmt)   whereClause = sql`${whereClause} AND CAST(wt.amount AS NUMERIC) <= ${parseFloat(maxAmt)}`;
    if (flaggedQ === "true")  whereClause = sql`${whereClause} AND wt.flagged = true`;
    if (flaggedQ === "false") whereClause = sql`${whereClause} AND wt.flagged = false`;

    const rows = await db.execute(sql`
      SELECT
        wt.id, wt.user_id as sender_id, wt.peer_id as receiver_id,
        wt.amount, wt.description, wt.peer_phone as receiver_phone,
        wt.flagged, wt.flag_reason, wt.flagged_by, wt.flagged_at,
        wt.created_at,
        su.name as sender_name, su.phone as sender_phone,
        ru.name as receiver_name
      FROM wallet_transactions wt
      LEFT JOIN users su ON su.id = wt.user_id
      LEFT JOIN users ru ON ru.id = wt.peer_id
      WHERE ${whereClause}
      ORDER BY wt.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const countRowRes = await db.execute(sql`
      SELECT COUNT(*) as total
      FROM wallet_transactions wt
      WHERE ${whereClause}
    `);

    const total = Number((countRowRes.rows?.[0] as any)?.total ?? 0);
    sendSuccess(res, {
      transactions: rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (e) {
    logger.error({ err: e }, "[admin] wallet/p2p-transactions error");
    sendError(res, "Failed to load P2P transactions", 500);
  }
});

/* ── PATCH /admin/wallet/transactions/:id/flag — flag/unflag ────────────── */
router.patch("/wallet/transactions/:id/flag", adminAuth, async (req, res) => {
  try {
    const adminId = (req as AdminRequest).adminId ?? "admin";
    const { flag, reason } = req.body as { flag?: boolean; reason?: string };
    const txId = req.params["id"]!;

    const shouldFlag = flag !== false;
    await db.execute(sql`
      UPDATE wallet_transactions
      SET
        flagged = ${shouldFlag},
        flag_reason = ${shouldFlag ? (reason ?? null) : null},
        flagged_by = ${shouldFlag ? adminId : null},
        flagged_at = ${shouldFlag ? new Date() : null}
      WHERE id = ${txId}
    `);
    sendSuccess(res, { flagged: shouldFlag });
  } catch (e) {
    logger.error({ err: e }, "[admin] wallet/flag error");
    sendError(res, "Failed to update flag", 500);
  }
});

/* ── PATCH /admin/wallet/freeze-p2p/:userId — toggle P2P freeze ─────────── */
router.patch("/wallet/freeze-p2p/:userId", adminAuth, async (req, res) => {
  try {
    const targetId = req.params["userId"]!;
    const [user] = await db.select({ id: usersTable.id, blockedServices: usersTable.blockedServices })
      .from(usersTable).where(eq(usersTable.id, targetId)).limit(1);
    if (!user) { sendNotFound(res, "User not found"); return; }

    const services = user.blockedServices.split(",").map(s => s.trim()).filter(Boolean);
    const alreadyFrozen = services.includes("wallet_p2p");
    let newServices: string[];
    if (alreadyFrozen) {
      newServices = services.filter(s => s !== "wallet_p2p");
    } else {
      newServices = [...services, "wallet_p2p"];
    }
    await db.update(usersTable)
      .set({ blockedServices: newServices.join(",") })
      .where(eq(usersTable.id, targetId));

    sendSuccess(res, { p2pFrozen: !alreadyFrozen });
  } catch (e) {
    logger.error({ err: e }, "[admin] wallet/freeze-p2p error");
    sendError(res, "Failed to toggle P2P freeze", 500);
  }
});

/* ═══════════════════  Scheduled Maintenance Window  ═══════════════════ */
router.get("/maintenance-schedule", async (_req, res) => {
  const settings = await getCachedSettings();
  sendSuccess(res, {
    scheduledStart: settings["maintenance_scheduled_start"] || null,
    scheduledEnd: settings["maintenance_scheduled_end"] || null,
    scheduledMsg: settings["maintenance_scheduled_msg"] || "We're performing scheduled maintenance. We'll be back shortly!",
  });
});

router.put("/maintenance-schedule", adminAuth, async (req, res) => {
  const { scheduledStart, scheduledEnd, scheduledMsg } = req.body as {
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
    scheduledMsg?: string;
  };

  if (scheduledStart && scheduledEnd) {
    const start = new Date(scheduledStart);
    const end = new Date(scheduledEnd);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      sendValidationError(res, "Invalid date format. Use ISO 8601.");
      return;
    }
    if (end <= start) {
      sendValidationError(res, "End time must be after start time.");
      return;
    }
  }

  const updates = [
    { key: "maintenance_scheduled_start", value: scheduledStart || "" },
    { key: "maintenance_scheduled_end", value: scheduledEnd || "" },
  ];
  if (scheduledMsg !== undefined) {
    updates.push({ key: "maintenance_scheduled_msg", value: scheduledMsg });
  }

  for (const { key, value } of updates) {
    await db.insert(platformSettingsTable)
      .values({ key, value, label: key, category: "maintenance", updatedAt: new Date() })
      .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value, updatedAt: new Date() } });
  }

  invalidateSettingsCache();
  invalidatePlatformSettingsCache();
  addAuditEntry({
    action: "maintenance_schedule",
    ip: getClientIp(req),
    adminId: (req as AdminRequest).adminId,
    details: scheduledStart ? `Scheduled maintenance: ${scheduledStart} to ${scheduledEnd}` : "Cleared maintenance schedule",
    result: "success",
  });

  sendSuccess(res, {
    scheduledStart: scheduledStart || null,
    scheduledEnd: scheduledEnd || null,
    scheduledMsg: scheduledMsg || "We're performing scheduled maintenance. We'll be back shortly!",
  });
});

/* ═══════════════════  Data Retention Policies  ═══════════════════ */
router.get("/retention-policies", async (_req, res) => {
  const settings = await getCachedSettings();
  sendSuccess(res, {
    locationDays: parseInt(settings["retention_location_days"] ?? "90"),
    chatDays: parseInt(settings["retention_chat_days"] ?? "180"),
    auditDays: parseInt(settings["retention_audit_days"] ?? "365"),
    notificationsDays: parseInt(settings["retention_notifications_days"] ?? "30"),
    lastCleanup: settings["retention_last_cleanup"] || null,
  });
});

router.put("/retention-policies", adminAuth, async (req, res) => {
  const { locationDays, chatDays, auditDays, notificationsDays } = req.body as {
    locationDays?: number;
    chatDays?: number;
    auditDays?: number;
    notificationsDays?: number;
  };

  const updates: { key: string; value: string }[] = [];
  if (locationDays !== undefined) updates.push({ key: "retention_location_days", value: String(Math.max(1, locationDays)) });
  if (chatDays !== undefined) updates.push({ key: "retention_chat_days", value: String(Math.max(1, chatDays)) });
  if (auditDays !== undefined) updates.push({ key: "retention_audit_days", value: String(Math.max(1, auditDays)) });
  if (notificationsDays !== undefined) updates.push({ key: "retention_notifications_days", value: String(Math.max(1, notificationsDays)) });

  for (const { key, value } of updates) {
    await db.insert(platformSettingsTable)
      .values({ key, value, label: key, category: "retention", updatedAt: new Date() })
      .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value, updatedAt: new Date() } });
  }

  invalidateSettingsCache();
  invalidatePlatformSettingsCache();
  addAuditEntry({
    action: "retention_policy_update",
    ip: getClientIp(req),
    adminId: (req as AdminRequest).adminId,
    details: `Updated retention policies: ${updates.map(u => `${u.key}=${u.value}`).join(", ")}`,
    result: "success",
  });

  const settings = await getCachedSettings();
  sendSuccess(res, {
    locationDays: parseInt(settings["retention_location_days"] ?? "90"),
    chatDays: parseInt(settings["retention_chat_days"] ?? "180"),
    auditDays: parseInt(settings["retention_audit_days"] ?? "365"),
    notificationsDays: parseInt(settings["retention_notifications_days"] ?? "30"),
    lastCleanup: settings["retention_last_cleanup"] || null,
  });
});

router.post("/retention-cleanup", adminAuth, async (req, res) => {
  try {
    const settings = await getCachedSettings();
    const locationDays = parseInt(settings["retention_location_days"] ?? "90");
    const chatDays = parseInt(settings["retention_chat_days"] ?? "180");
    const auditDays = parseInt(settings["retention_audit_days"] ?? "365");
    const notifDays = parseInt(settings["retention_notifications_days"] ?? "30");
    const now = new Date();

    const locationCutoff = new Date(now.getTime() - locationDays * 86400000);
    const chatCutoff = new Date(now.getTime() - chatDays * 86400000);
    const auditCutoff = new Date(now.getTime() - auditDays * 86400000);
    const notifCutoff = new Date(now.getTime() - notifDays * 86400000);

    const results: Record<string, number> = {};

    try {
      const locDeleted = await db.delete(locationHistoryTable).where(lt(locationHistoryTable.createdAt, locationCutoff)).returning({ id: locationHistoryTable.id });
      results.locationHistory = locDeleted.length;
    } catch { results.locationHistory = 0; }

    try {
      const chatDeleted = await db.delete(supportMessagesTable).where(lt(supportMessagesTable.createdAt, chatCutoff)).returning({ id: supportMessagesTable.id });
      results.chatMessages = chatDeleted.length;
    } catch { results.chatMessages = 0; }

    try {
      const auditDeleted = await db.delete(authAuditLogTable).where(lt(authAuditLogTable.createdAt, auditCutoff)).returning({ id: authAuditLogTable.id });
      results.auditLogs = auditDeleted.length;
    } catch { results.auditLogs = 0; }

    try {
      const notifDeleted = await db.delete(notificationsTable).where(lt(notificationsTable.createdAt, notifCutoff)).returning({ id: notificationsTable.id });
      results.notifications = notifDeleted.length;
    } catch { results.notifications = 0; }

    try {
      const locLogDeleted = await db.delete(locationLogsTable).where(lt(locationLogsTable.createdAt, locationCutoff)).returning({ id: locationLogsTable.id });
      results.locationLogs = locLogDeleted.length;
    } catch { results.locationLogs = 0; }

    const cleanupTimestamp = now.toISOString();
    await db.insert(platformSettingsTable)
      .values({ key: "retention_last_cleanup", value: cleanupTimestamp, label: "Last Cleanup Timestamp", category: "retention", updatedAt: now })
      .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value: cleanupTimestamp, updatedAt: now } });

    invalidateSettingsCache();
    invalidatePlatformSettingsCache();

    const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0);
    addAuditEntry({
      action: "retention_cleanup",
      ip: getClientIp(req),
      adminId: (req as AdminRequest).adminId,
      details: `Retention cleanup: ${totalDeleted} records purged. Location: ${results.locationHistory}, Chat: ${results.chatMessages}, Audit: ${results.auditLogs}, Notifications: ${results.notifications}, LocationLogs: ${results.locationLogs}`,
      result: "success",
    });

    sendSuccess(res, { deleted: results, totalDeleted, lastCleanup: cleanupTimestamp });
  } catch (e: any) {
    logger.error({ err: e }, "[admin] retention-cleanup error");
    sendError(res, e.message || "Cleanup failed", 500);
  }
});

/* ═══════════════════  Vendor Schedule Admin  ═══════════════════ */
router.get("/vendor-schedules/:vendorId", async (req, res) => {
  const vendorId = req.params["vendorId"]!;
  const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const rows = await db.select().from(vendorSchedulesTable).where(eq(vendorSchedulesTable.vendorId, vendorId));
  const schedule = DAY_NAMES.map((name, i) => {
    const existing = rows.find(r => r.dayOfWeek === i);
    return existing
      ? { ...existing, dayName: name, createdAt: existing.createdAt.toISOString(), updatedAt: existing.updatedAt.toISOString() }
      : { id: null, vendorId, dayOfWeek: i, dayName: name, openTime: "09:00", closeTime: "21:00", isEnabled: false };
  });
  sendSuccess(res, { schedule });
});

router.put("/vendor-schedules/:vendorId", adminAuth, async (req, res) => {
  const vendorId = req.params["vendorId"]!;
  const { schedule } = req.body as { schedule: Array<{ dayOfWeek: number; openTime: string; closeTime: string; isEnabled: boolean }> };
  if (!Array.isArray(schedule)) { sendValidationError(res, "schedule array required"); return; }

  const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  for (const item of schedule) {
    if (item.dayOfWeek < 0 || item.dayOfWeek > 6) continue;
    const existing = await db.select().from(vendorSchedulesTable)
      .where(and(eq(vendorSchedulesTable.vendorId, vendorId), eq(vendorSchedulesTable.dayOfWeek, item.dayOfWeek)));

    if (existing.length > 0) {
      await db.update(vendorSchedulesTable)
        .set({ openTime: item.openTime, closeTime: item.closeTime, isEnabled: item.isEnabled, updatedAt: new Date() })
        .where(eq(vendorSchedulesTable.id, existing[0]!.id));
    } else {
      await db.insert(vendorSchedulesTable).values({
        id: generateId(),
        vendorId,
        dayOfWeek: item.dayOfWeek,
        openTime: item.openTime,
        closeTime: item.closeTime,
        isEnabled: item.isEnabled,
      });
    }
  }

  addAuditEntry({
    action: "vendor_schedule_override",
    ip: getClientIp(req),
    adminId: (req as AdminRequest).adminId,
    details: `Admin updated schedule for vendor ${vendorId}`,
    result: "success",
  });

  const rows = await db.select().from(vendorSchedulesTable).where(eq(vendorSchedulesTable.vendorId, vendorId));
  const result = DAY_NAMES.map((name, i) => {
    const r = rows.find(r => r.dayOfWeek === i);
    return r
      ? { ...r, dayName: name, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }
      : { id: null, vendorId, dayOfWeek: i, dayName: name, openTime: "09:00", closeTime: "21:00", isEnabled: false };
  });
  sendSuccess(res, { schedule: result });
});

/* ═══════════════════  CSV / Report Export  ═══════════════════ */
function escapeCSV(val: string): string {
  let safe = val;
  if (/^[=+\-@\t\r]/.test(safe)) safe = "'" + safe;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function csvResponse(res: any, filename: string, header: string, rows: string[]) {
  const csv = [header, ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

router.get("/export/orders", adminAuth, async (req, res) => {
  try {
    const { status, type, dateFrom, dateTo } = req.query;
    const conditions: SQL[] = [];
    if (status && status !== "all") conditions.push(eq(ordersTable.status, String(status)));
    if (type && type !== "all") conditions.push(eq(ordersTable.type, String(type)));
    if (dateFrom) conditions.push(gte(ordersTable.createdAt, new Date(String(dateFrom))));
    if (dateTo) conditions.push(lte(ordersTable.createdAt, new Date(String(dateTo) + "T23:59:59")));

    const orders = conditions.length > 0
      ? await db.select().from(ordersTable).where(and(...conditions)).orderBy(desc(ordersTable.createdAt)).limit(5000)
      : await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(5000);

    const header = "ID,Type,Status,Total,Payment Method,User ID,Vendor ID,Rider ID,Delivery Address,Created At";
    const rows = orders.map(o => [
      escapeCSV(o.id), escapeCSV(o.type || ""), escapeCSV(o.status), String(o.total),
      escapeCSV(o.paymentMethod || ""), escapeCSV(o.userId), escapeCSV(o.vendorId || ""),
      escapeCSV(o.riderId || ""), escapeCSV(o.deliveryAddress || ""),
      escapeCSV(o.createdAt.toISOString().slice(0, 19)),
    ].join(","));

    addAuditEntry({ action: "csv_export", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Exported ${orders.length} orders as CSV`, result: "success" });
    csvResponse(res, `orders-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  } catch (e: any) {
    sendError(res, e.message || "Export failed", 500);
  }
});

router.get("/export/users", adminAuth, async (req, res) => {
  try {
    const { role } = req.query;
    const conditions: SQL[] = [];
    if (role && role !== "all") conditions.push(sql`${usersTable.roles} LIKE ${"%" + String(role) + "%"}`);

    const users = conditions.length > 0
      ? await db.select().from(usersTable).where(and(...conditions)).orderBy(desc(usersTable.createdAt)).limit(10000)
      : await db.select().from(usersTable).orderBy(desc(usersTable.createdAt)).limit(10000);

    const header = "ID,Name,Phone,Email,Roles,City,Active,Banned,Wallet Balance,Created At";
    const rows = users.map(u => [
      escapeCSV(u.id), escapeCSV(u.name || ""), escapeCSV(u.phone || ""), escapeCSV(u.email || ""),
      escapeCSV(u.roles), escapeCSV(u.city || ""),
      u.isActive ? "Yes" : "No", u.isBanned ? "Yes" : "No",
      String(u.walletBalance), escapeCSV(u.createdAt.toISOString().slice(0, 19)),
    ].join(","));

    addAuditEntry({ action: "csv_export", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Exported ${users.length} users as CSV`, result: "success" });
    csvResponse(res, `users-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  } catch (e: any) {
    sendError(res, e.message || "Export failed", 500);
  }
});

router.get("/export/riders", adminAuth, async (req, res) => {
  try {
    const riders = await db.select().from(usersTable)
      .where(sql`${usersTable.roles} LIKE '%rider%'`)
      .orderBy(desc(usersTable.createdAt)).limit(5000);

    const header = "ID,Name,Phone,Email,City,Online,Active,Banned,Wallet Balance,Cancel Count,Rating,Created At";
    const rows = riders.map(r => [
      escapeCSV(r.id), escapeCSV(r.name || ""), escapeCSV(r.phone || ""), escapeCSV(r.email || ""),
      escapeCSV(r.city || ""), r.isOnline ? "Yes" : "No", r.isActive ? "Yes" : "No", r.isBanned ? "Yes" : "No",
      String(r.walletBalance), String(r.cancelCount), "",
      escapeCSV(r.createdAt.toISOString().slice(0, 19)),
    ].join(","));

    addAuditEntry({ action: "csv_export", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Exported ${riders.length} riders as CSV`, result: "success" });
    csvResponse(res, `riders-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  } catch (e: any) {
    sendError(res, e.message || "Export failed", 500);
  }
});

router.get("/export/vendors", adminAuth, async (req, res) => {
  try {
    const vendors = await db.select().from(usersTable)
      .where(sql`${usersTable.roles} LIKE '%vendor%'`)
      .orderBy(desc(usersTable.createdAt)).limit(5000);

    const header = "ID,Name,Phone,Email,Store Name,City,Active,Banned,Wallet Balance,Created At";
    const rows = vendors.map(v => [
      escapeCSV(v.id), escapeCSV(v.name || ""), escapeCSV(v.phone || ""), escapeCSV(v.email || ""),
      escapeCSV((v as any).storeName || ""), escapeCSV(v.city || ""),
      v.isActive ? "Yes" : "No", v.isBanned ? "Yes" : "No",
      String(v.walletBalance), escapeCSV(v.createdAt.toISOString().slice(0, 19)),
    ].join(","));

    addAuditEntry({ action: "csv_export", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Exported ${vendors.length} vendors as CSV`, result: "success" });
    csvResponse(res, `vendors-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  } catch (e: any) {
    sendError(res, e.message || "Export failed", 500);
  }
});

router.get("/export/rides", adminAuth, async (req, res) => {
  try {
    const { status, dateFrom, dateTo } = req.query;
    const conditions: SQL[] = [];
    if (status && status !== "all") conditions.push(eq(ridesTable.status, String(status)));
    if (dateFrom) conditions.push(gte(ridesTable.createdAt, new Date(String(dateFrom))));
    if (dateTo) conditions.push(lte(ridesTable.createdAt, new Date(String(dateTo) + "T23:59:59")));

    const rides = conditions.length > 0
      ? await db.select().from(ridesTable).where(and(...conditions)).orderBy(desc(ridesTable.createdAt)).limit(5000)
      : await db.select().from(ridesTable).orderBy(desc(ridesTable.createdAt)).limit(5000);

    const header = "ID,Type,Status,Fare,Distance KM,User ID,Rider ID,Pickup,Dropoff,Created At";
    const rows = rides.map(r => [
      escapeCSV(r.id), escapeCSV(r.type || ""), escapeCSV(r.status), String(r.fare),
      String(r.distance), escapeCSV(r.userId), escapeCSV(r.riderId || ""),
      escapeCSV(r.pickupAddress || ""), escapeCSV(r.dropAddress || ""),
      escapeCSV(r.createdAt.toISOString().slice(0, 19)),
    ].join(","));

    addAuditEntry({ action: "csv_export", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Exported ${rides.length} rides as CSV`, result: "success" });
    csvResponse(res, `rides-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  } catch (e: any) {
    sendError(res, e.message || "Export failed", 500);
  }
});

/* ── GET /admin/revenue-analytics — monthly breakdown, category totals, top vendors ── */
router.get("/revenue-analytics", adminAuth, async (_req, res) => {
  try {
    const now = new Date();
    // Inclusive 12-month window: from the 1st of (current month - 11) through end of current month.
    // This yields exactly 12 calendar months including the current one.
    const windowStart = new Date(now.getFullYear(), now.getMonth() - 11, 1, 0, 0, 0, 0);

    // Pre-build the 12 month keys so we can zero-fill months with no activity.
    const monthKeys: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(windowStart.getFullYear(), windowStart.getMonth() + i, 1);
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      monthKeys.push(`${d.getFullYear()}-${mm}`);
    }

    const [
      monthlyOrders,
      monthlyRides,
      monthlyPharmacy,
      [orderTotal],
      [rideTotal],
      [pharmTotal],
      topVendors,
    ] = await Promise.all([
      db.select({
        month: sql<string>`to_char(date_trunc('month', ${ordersTable.createdAt}), 'YYYY-MM')`,
        total: sql<string>`coalesce(sum(${ordersTable.total}), 0)`,
      })
        .from(ordersTable)
        .where(and(eq(ordersTable.status, "delivered"), gte(ordersTable.createdAt, windowStart)))
        .groupBy(sql`date_trunc('month', ${ordersTable.createdAt})`)
        .orderBy(sql`date_trunc('month', ${ordersTable.createdAt})`),

      db.select({
        month: sql<string>`to_char(date_trunc('month', ${ridesTable.createdAt}), 'YYYY-MM')`,
        total: sql<string>`coalesce(sum(${ridesTable.fare}), 0)`,
      })
        .from(ridesTable)
        .where(and(eq(ridesTable.status, "completed"), gte(ridesTable.createdAt, windowStart)))
        .groupBy(sql`date_trunc('month', ${ridesTable.createdAt})`)
        .orderBy(sql`date_trunc('month', ${ridesTable.createdAt})`),

      db.select({
        month: sql<string>`to_char(date_trunc('month', ${pharmacyOrdersTable.createdAt}), 'YYYY-MM')`,
        total: sql<string>`coalesce(sum(${pharmacyOrdersTable.total}), 0)`,
      })
        .from(pharmacyOrdersTable)
        .where(and(eq(pharmacyOrdersTable.status, "delivered"), gte(pharmacyOrdersTable.createdAt, windowStart)))
        .groupBy(sql`date_trunc('month', ${pharmacyOrdersTable.createdAt})`)
        .orderBy(sql`date_trunc('month', ${pharmacyOrdersTable.createdAt})`),

      db.select({ total: sum(ordersTable.total) }).from(ordersTable).where(eq(ordersTable.status, "delivered")),
      db.select({ total: sum(ridesTable.fare) }).from(ridesTable).where(eq(ridesTable.status, "completed")),
      db.select({ total: sum(pharmacyOrdersTable.total) }).from(pharmacyOrdersTable).where(eq(pharmacyOrdersTable.status, "delivered")),

      db.select({
        id: usersTable.id,
        name: vendorProfilesTable.storeName,
        phone: usersTable.phone,
        orderCount: sql<number>`count(${ordersTable.id})`,
        totalRevenue: sql<string>`coalesce(sum(${ordersTable.total}), 0)`,
      })
        .from(usersTable)
        .leftJoin(vendorProfilesTable, eq(usersTable.id, vendorProfilesTable.userId))
        .leftJoin(ordersTable, and(eq(ordersTable.vendorId, usersTable.id), eq(ordersTable.status, "delivered")))
        .where(ilike(usersTable.roles, "%vendor%"))
        .groupBy(usersTable.id, vendorProfilesTable.storeName)
        .orderBy(sql`coalesce(sum(${ordersTable.total}), 0) desc`)
        .limit(10),
    ]);

    const monthMap: Record<string, { month: string; orders: number; rides: number; pharmacy: number; total: number }> = {};
    // Zero-fill all 12 months upfront so months with no activity still appear in the response.
    for (const key of monthKeys) {
      monthMap[key] = { month: key, orders: 0, rides: 0, pharmacy: 0, total: 0 };
    }
    const ensureMonth = (m: string) => {
      if (!monthMap[m]) monthMap[m] = { month: m, orders: 0, rides: 0, pharmacy: 0, total: 0 };
    };

    for (const row of monthlyOrders) {
      ensureMonth(row.month);
      const v = parseFloat(row.total);
      monthMap[row.month]!.orders = v;
      monthMap[row.month]!.total += v;
    }
    for (const row of monthlyRides) {
      ensureMonth(row.month);
      const v = parseFloat(row.total);
      monthMap[row.month]!.rides = v;
      monthMap[row.month]!.total += v;
    }
    for (const row of monthlyPharmacy) {
      ensureMonth(row.month);
      const v = parseFloat(row.total);
      monthMap[row.month]!.pharmacy = v;
      monthMap[row.month]!.total += v;
    }

    const monthly = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

    const catOrders  = parseFloat(orderTotal?.total ?? "0");
    const catRides   = parseFloat(rideTotal?.total ?? "0");
    const catPharmacy = parseFloat(pharmTotal?.total ?? "0");
    const catGrand   = catOrders + catRides + catPharmacy;

    const categoryTotals = {
      orders:   catOrders,
      rides:    catRides,
      pharmacy: catPharmacy,
      total:    catGrand,
    };

    sendSuccess(res, {
      monthly,
      categoryTotals,
      topVendors: topVendors.map(v => ({
        ...v,
        orderCount: Number(v.orderCount),
        totalRevenue: parseFloat(String(v.totalRevenue)),
      })),
    });
  } catch (e: unknown) {
    sendError(res, e instanceof Error ? e.message : "Failed to load revenue analytics", 500);
  }
});

router.get("/export/financial", adminAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const conditions: SQL[] = [];
    if (dateFrom) conditions.push(gte(walletTransactionsTable.createdAt, new Date(String(dateFrom))));
    if (dateTo) conditions.push(lte(walletTransactionsTable.createdAt, new Date(String(dateTo) + "T23:59:59")));

    const txns = conditions.length > 0
      ? await db.select().from(walletTransactionsTable).where(and(...conditions)).orderBy(desc(walletTransactionsTable.createdAt)).limit(10000)
      : await db.select().from(walletTransactionsTable).orderBy(desc(walletTransactionsTable.createdAt)).limit(10000);

    const header = "ID,User ID,Type,Amount,Description,Reference,Created At";
    const rows = txns.map(t => [
      escapeCSV(t.id), escapeCSV(t.userId), escapeCSV(t.type), String(t.amount),
      escapeCSV(t.description || ""), escapeCSV(t.reference || ""),
      escapeCSV(t.createdAt.toISOString().slice(0, 19)),
    ].join(","));

    addAuditEntry({ action: "csv_export", ip: getClientIp(req), adminId: (req as AdminRequest).adminId, details: `Exported ${txns.length} financial transactions as CSV`, result: "success" });
    csvResponse(res, `financial-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
  } catch (e: any) {
    sendError(res, e.message || "Export failed", 500);
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   HEALTH DASHBOARD — aggregated real-time status for GPS, moderation, flags
───────────────────────────────────────────────────────────────────────────── */

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

router.get("/system/health-dashboard", async (_req, res) => {
  const s = await getCachedSettings();
  const now = new Date();

  /* ── Performance metrics (parallel with other checks) ── */
  const { getP95Ms, getP50Ms, getP99Ms, getMemoryPct, getDiskPct, getDiskFreeGb } = await import("../../lib/metrics/responseTime.js");

  /* ── Server health ── */
  const uptimeSec = Math.floor(process.uptime());
  let dbStatus: "ok" | "error" = "ok";
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    dbStatus = "error";
  }
  const mem = process.memoryUsage();
  const memoryMb = Math.round(mem.heapUsed / 1024 / 1024);

  /* ── GPS tracking stats ── */
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const [[liveRiderRow], [recentPingRow]] = await Promise.all([
    db.select({ c: count() }).from(liveLocationsTable).where(eq(liveLocationsTable.role, "rider")),
    db.select({ c: count() }).from(liveLocationsTable).where(and(
      eq(liveLocationsTable.role, "rider"),
      gte(liveLocationsTable.updatedAt, fiveMinAgo),
    )),
  ]);
  const liveTrackingEnabled = (s["feature_live_tracking"] ?? "on") === "on";
  const spoofDetectionEnabled = (s["security_gps_spoof_detection"] ?? "on") !== "off";
  const maxSpeedKmh = parseInt(s["security_max_speed_kmh"] ?? "150", 10);
  const ridersInLiveTable = Number(liveRiderRow?.c ?? 0);
  const ridersWithRecentPing = Number(recentPingRow?.c ?? 0);
  const staleRiders = ridersInLiveTable - ridersWithRecentPing;

  /* ── Content moderation ── */
  const rawPatterns = s["moderation_custom_patterns"] ?? "";
  let customPatternsCount = 0;
  let customPatternsValid = true;
  if (rawPatterns) {
    try {
      const parsed = JSON.parse(rawPatterns);
      if (Array.isArray(parsed)) {
        customPatternsCount = parsed.filter((p: any) => p && typeof p.pattern === "string").length;
      } else {
        customPatternsValid = false;
      }
    } catch {
      customPatternsValid = false;
    }
  }
  const flagKeywords = s["comm_flag_keywords"]
    ? s["comm_flag_keywords"].split(",").map((k: string) => k.trim()).filter(Boolean)
    : [];
  const hidePhone   = (s["comm_hide_phone"]   ?? "on")  !== "off";
  const hideEmail   = (s["comm_hide_email"]   ?? "on")  !== "off";
  const hideCnic    = (s["comm_hide_cnic"]    ?? "on")  !== "off";
  const hideBank    = (s["comm_hide_bank"]    ?? "on")  !== "off";
  const hideAddress = (s["comm_hide_address"] ?? "off") !== "off";

  /* ── Feature flags ── */
  const features: Record<string, boolean> = {
    mart:         (s["feature_mart"]          ?? "on")  === "on",
    food:         (s["feature_food"]          ?? "on")  === "on",
    rides:        (s["feature_rides"]         ?? "on")  === "on",
    pharmacy:     (s["feature_pharmacy"]      ?? "on")  === "on",
    parcel:       (s["feature_parcel"]        ?? "on")  === "on",
    van:          (s["feature_van"]           ?? "on")  === "on",
    wallet:       (s["feature_wallet"]        ?? "on")  === "on",
    referral:     (s["feature_referral"]      ?? "on")  === "on",
    newUsers:     (s["feature_new_users"]     ?? "on")  === "on",
    chat:         (s["feature_chat"]          ?? "off") === "on",
    liveTracking: liveTrackingEnabled,
    reviews:      (s["feature_reviews"]       ?? "on")  === "on",
    sos:          (s["feature_sos"]           ?? "on")  === "on",
    weather:      (s["feature_weather"]       ?? "on")  === "on",
  };
  const maintenanceMode = (s["app_status"] ?? "active") === "maintenance";

  /* ── Performance metrics ── */
  const p95Ms    = getP95Ms();
  const p50Ms    = getP50Ms();
  const p99Ms    = getP99Ms();
  const memoryPct = getMemoryPct();
  const diskPct   = getDiskPct();
  const diskFreeGb = getDiskFreeGb();

  /* ── DB latency (SELECT 1 round-trip) ── */
  let dbLatencyMs: number | null = null;
  if (dbStatus === "ok") {
    try {
      const t0 = Date.now();
      await db.execute(sql`SELECT 1`);
      dbLatencyMs = Date.now() - t0;
    } catch {
      dbLatencyMs = null;
    }
  }

  let dbQueryMs: number | null = null;
  if (dbStatus === "ok") {
    try {
      const t0 = Date.now();
      await db.select({ c: count() }).from(platformSettingsTable);
      dbQueryMs = Date.now() - t0;
    } catch {
      dbQueryMs = null;
    }
  }

  /* ── Redis cache hit rate (best-effort) ── */
  let redisCacheHitRate: number | null = null;
  try {
    const { redisClient } = await import("../../lib/redis.js");
    if (redisClient) {
      const info = await (redisClient as any).info("stats");
      const hitsMatch = String(info).match(/keyspace_hits:(\d+)/);
      const missesMatch = String(info).match(/keyspace_misses:(\d+)/);
      if (hitsMatch && missesMatch) {
        const hits = parseInt(hitsMatch[1]!, 10);
        const misses = parseInt(missesMatch[1]!, 10);
        const total = hits + misses;
        if (total > 0) redisCacheHitRate = Math.round((hits / total) * 100);
      }
    }
  } catch {
    redisCacheHitRate = null;
  }

  /* ── Queue / connection depth (Socket.IO connected clients) ── */
  let queueDepth = 0;
  try {
    const socketMod = await import("../../lib/socketio.js");
    const getCount = (socketMod as any).getConnectedClientCount;
    if (typeof getCount === "function") queueDepth = getCount();
  } catch {
    queueDepth = 0;
  }

  const thresholdP95Ms   = Math.max(1, parseInt(s["perf_alert_p95_ms"]      ?? "500",  10));
  const thresholdDbMs    = Math.max(1, parseInt(s["perf_alert_db_query_ms"] ?? "1000", 10));
  const thresholdMemPct  = Math.max(1, parseInt(s["perf_alert_memory_pct"]  ?? "80",   10));
  const thresholdDiskPct = Math.max(1, parseInt(s["perf_alert_disk_pct"]    ?? "80",   10));

  /* ── Issue detection ── */
  const issues: { level: "error" | "warning" | "info"; message: string }[] = [];
  if (dbStatus === "error")
    issues.push({ level: "error", message: "Database connection failed — the server cannot reach PostgreSQL" });
  if (maintenanceMode)
    issues.push({ level: "warning", message: "App is in maintenance mode — customers cannot access the platform" });
  if (!liveTrackingEnabled)
    issues.push({ level: "warning", message: "Live GPS tracking is disabled — rider positions will not update" });
  if (rawPatterns && !customPatternsValid)
    issues.push({ level: "error", message: "Content moderation: custom patterns JSON is malformed — all custom rules are inactive" });
  if (!hidePhone)
    issues.push({ level: "warning", message: "Content moderation: phone number masking is off — phone numbers may be exposed in chat" });
  if (!features.sos)
    issues.push({ level: "warning", message: "SOS alerts feature is disabled — riders/customers cannot send emergency alerts" });
  if (staleRiders > 0)
    issues.push({ level: "info", message: `${staleRiders} rider(s) in the live table have not pinged in the last 5 minutes` });

  /* ── Performance issues ── */
  if (p95Ms !== null && p95Ms > thresholdP95Ms)
    issues.push({ level: "error", message: `API p95 response time is ${p95Ms}ms — exceeds threshold of ${thresholdP95Ms}ms` });
  if (dbQueryMs !== null && dbQueryMs > thresholdDbMs)
    issues.push({ level: "error", message: `DB query latency is ${dbQueryMs}ms — exceeds threshold of ${thresholdDbMs}ms` });
  if (memoryPct > thresholdMemPct)
    issues.push({ level: "error", message: `Heap memory usage is ${memoryPct}% — exceeds threshold of ${thresholdMemPct}%` });
  if (diskPct !== null && diskPct > thresholdDiskPct)
    issues.push({ level: "error", message: `Disk usage is ${diskPct}% — exceeds threshold of ${thresholdDiskPct}%` });

  /* ── Auth lockout monitoring ── */
  const nowMs = Date.now();
  const adminIpLockouts: { key: string; attempts: number; minutesLeft: number; lockedSince: string }[] = [];
  const adminIpAttempts: { key: string; attempts: number; lastAttempt: string }[] = [];
  for (const [key, v] of adminLoginAttempts.entries()) {
    const remaining = ADMIN_LOCKOUT_TIME - (nowMs - v.lastAttempt);
    if (v.count >= ADMIN_MAX_ATTEMPTS && remaining > 0) {
      adminIpLockouts.push({
        key,
        attempts: v.count,
        minutesLeft: Math.ceil(remaining / 60_000),
        lockedSince: new Date(v.lastAttempt).toISOString(),
      });
    } else if (v.count > 0 && (nowMs - v.lastAttempt) < ADMIN_LOCKOUT_TIME) {
      adminIpAttempts.push({
        key,
        attempts: v.count,
        lastAttempt: new Date(v.lastAttempt).toISOString(),
      });
    }
  }
  const accountLockoutsRaw = await getActiveLockouts();
  const accountLockouts = accountLockoutsRaw.map((l: { key: string; attempts: number; lockedUntil: string | null; minutesLeft: number | null }) => ({
    phone: l.key,
    attempts: l.attempts,
    minutesLeft: l.minutesLeft ?? 0,
    lockedUntil: l.lockedUntil ?? null,
  }));
  if (adminIpLockouts.length > 0)
    issues.push({ level: "warning", message: `${adminIpLockouts.length} admin IP${adminIpLockouts.length > 1 ? "s" : ""} currently locked out due to repeated failed login attempts` });
  if (accountLockouts.length > 5)
    issues.push({ level: "warning", message: `${accountLockouts.length} user accounts currently locked out — possible brute-force attack` });

  sendSuccess(res, {
    generatedAt: now.toISOString(),
    server: {
      uptime: uptimeSec,
      uptimeFormatted: formatUptime(uptimeSec),
      db: dbStatus,
      memoryMb,
      nodeVersion: process.version,
    },
    performance: {
      p50Ms,
      p95Ms,
      p99Ms,
      dbLatencyMs,
      dbQueryMs,
      redisCacheHitRate,
      queueDepth,
      memoryPct,
      diskPct,
      diskFreeGb,
      thresholds: {
        p95Ms:    thresholdP95Ms,
        dbMs:     thresholdDbMs,
        memoryPct: thresholdMemPct,
        diskPct:   thresholdDiskPct,
      },
    },
    gps: {
      ridersInLiveTable,
      ridersWithRecentPing,
      staleRiders,
      liveTrackingEnabled,
      spoofDetectionEnabled,
      maxSpeedKmh,
    },
    moderation: {
      customPatternsCount,
      customPatternsValid,
      hidePhone,
      hideEmail,
      hideCnic,
      hideBank,
      hideAddress,
      flagKeywordsCount: flagKeywords.length,
    },
    features,
    maintenanceMode,
    issues,
    alertConfig: {
      monitorEnabled:   (s["health_monitor_enabled"]    ?? "off") === "on",
      intervalMin:      parseInt(s["health_monitor_interval_min"] ?? "5",  10),
      snoozeMin:        parseInt(s["health_monitor_snooze_min"]   ?? "60", 10),
      emailConfigured:  (s["integration_email"] ?? "off") === "on" && Boolean(s["smtp_admin_alert_email"]?.trim()),
      slackConfigured:  Boolean(s["health_alert_slack_webhook"]?.trim()),
      alertEmail:       s["smtp_admin_alert_email"]?.trim() ?? "",
    },
    authLockouts: {
      adminIpLockouts,
      adminIpAttemptsInProgress: adminIpAttempts,
      accountLockouts,
      config: {
        maxAttempts: ADMIN_MAX_ATTEMPTS,
        lockoutMinutes: Math.round(ADMIN_LOCKOUT_TIME / 60_000),
      },
    },
  });
});

export default router;
