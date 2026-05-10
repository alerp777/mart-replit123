import { Router } from "express";
import { db } from "@workspace/db";
import { sql, count, eq } from "drizzle-orm";
import { platformSettingsTable } from "@workspace/db/schema";
import { adminAuth } from "./admin-shared.js";
import { getLastDriftReport, checkSchemaDrift } from "../services/schemaDrift.service.js";
import { redisClient } from "../lib/redis.js";
import { getP95Ms, getMemoryPct, getDiskPct } from "../lib/metrics/responseTime.js";
import { getVpnCircuitBreakerStatus } from "../middleware/security.js";

const router = Router();

const SERVER_EPOCH = Math.round(Date.now() / 1000 - process.uptime());

router.get("/", async (_req, res) => {
  let dbStatus: "ok" | "error" = "ok";
  let redisStatus: "ok" | "error" | "disabled" = "disabled";

  const DB_TIMEOUT_MS = 2000;
  const REDIS_TIMEOUT_MS = 2000;

  await Promise.allSettled([
    (async () => {
      try {
        await Promise.race([
          db.execute(sql`SELECT 1`),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("DB timeout")), DB_TIMEOUT_MS)
          ),
        ]);
        dbStatus = "ok";
      } catch {
        dbStatus = "error";
      }
    })(),
    (async () => {
      if (!redisClient) {
        redisStatus = "disabled";
        return;
      }
      try {
        await Promise.race([
          redisClient.ping(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Redis timeout")), REDIS_TIMEOUT_MS)
          ),
        ]);
        redisStatus = "ok";
      } catch {
        redisStatus = "error";
      }
    })(),
  ]);

  const db2 = dbStatus as "ok" | "error";
  const redis2 = redisStatus as "ok" | "error" | "disabled";
  const overallStatus: "ok" | "degraded" | "down" =
    db2 === "error" ? "down" : redis2 === "error" ? "degraded" : "ok";

  const httpStatus = (db2 === "error" || redis2 === "error") ? 503 : 200;

  /* ── Performance metrics ── */
  let dbQueryMs: number | null = null;
  if (db2 === "ok") {
    try {
      const t0 = Date.now();
      await db.select({ c: count() }).from(platformSettingsTable);
      dbQueryMs = Date.now() - t0;
    } catch {
      dbQueryMs = null;
    }
  }
  const p95Ms    = getP95Ms();
  const memoryPct = getMemoryPct();
  const diskPct   = getDiskPct();

  /* Read the app version from platform settings — never fatal if unavailable */
  let appVersion = "1.0.0";
  if (db2 === "ok") {
    try {
      const [row] = await db
        .select({ value: platformSettingsTable.value })
        .from(platformSettingsTable)
        .where(eq(platformSettingsTable.key, "app_version"))
        .limit(1);
      if (row?.value) appVersion = row.value;
    } catch { /* ignore — appVersion defaults to 1.0.0 */ }
  }

  const vpnDetection = getVpnCircuitBreakerStatus();

  res.status(httpStatus).json({
    status: overallStatus,
    db: db2,
    redis: redis2,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    serverEpoch: SERVER_EPOCH,
    appVersion,
    p95Ms,
    dbQueryMs,
    memoryPct,
    diskPct,
    vpnDetection: { status: vpnDetection.status },
  });
});

/**
 * GET /api/health/schema-drift
 * Admin-only endpoint that compares the Drizzle schema definition against the
 * live PostgreSQL database and reports any tables or columns that are defined
 * in code but missing from the database (crash risk), as well as extra tables
 * and columns that exist only in the database (informational).
 *
 * Returns HTTP 200 with { ok: true } when the DB fully matches the schema.
 * Returns HTTP 200 with { ok: false, ... } when drift is detected so callers
 * can distinguish "endpoint reachable" from "schema is clean" without relying
 * on HTTP status codes for alerting.
 */
router.get("/schema-drift", adminAuth, async (_req, res) => {
  try {
    // Return the startup-cached result so the dashboard doesn't re-run a
    // full DB introspection on every page load. If the cache is empty (server
    // restarted and startup task is still in progress), fall back to a live
    // check so callers always get a meaningful response.
    const cached = getLastDriftReport();
    const report = cached ?? await checkSchemaDrift();
    res.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

export default router;
