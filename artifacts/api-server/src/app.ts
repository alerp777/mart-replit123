import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { pinoInstance, logger } from "./lib/logger.js";
import { createProxyMiddleware } from "http-proxy-middleware";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runSqlMigrations } from "./services/sqlMigrationRunner.js";
import { db } from "@workspace/db";
import { platformSettingsTable } from "@workspace/db/schema";
import { DEFAULT_PLATFORM_SETTINGS, getCachedSettings } from "./routes/admin-shared.js";
import { sendAdminAlert } from "./services/email.js";
import {
  seedPermissionCatalog,
  seedDefaultRoles,
  backfillAdminRoleAssignments,
} from "./services/permissions.service.js";
import {
  seedDefaultSuperAdmin,
  reconcileSeededSuperAdmin,
} from "./services/admin-seed.service.js";
import { purgeStaleAdminPasswordResetTokens } from "./services/admin-password.service.js";
import { detectAndNotifyOutOfBandPasswordResets } from "./services/admin-password-watch.service.js";
import { ensureErrorResolutionTables } from "./routes/error-reports.js";
import { ensureCartSnapshotTable } from "./services/cartSnapshotMigration.js";
import { ensureReferralAndPrescriptionTables } from "./services/referralPrescriptionMigration.js";
import { startHealthMonitor } from "./services/healthAlertMonitor.js";
import { recordResponseTime } from "./lib/metrics/responseTime.js";
import { checkSchemaDrift } from "./services/schemaDrift.service.js";
import router from "./routes/index.js";
import { globalLimiter } from "./middleware/rate-limit.js";
import { suspiciousPatternDetector } from "./middleware/suspiciousPatternDetector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Run DB migrations + RBAC seed/backfill before the server begins
 * accepting traffic. SQL migration failure is fatal — we throw so the
 * boot script in `index.ts` exits non-zero rather than silently serving
 * authorization decisions against a half-migrated schema.
 *
 * The RBAC seed is best-effort: a transient seed failure should not
 * block the platform from coming up, but it is logged loudly.
 */
export async function runStartupTasks(): Promise<void> {
  /* ── HMAC secret presence check ───────────────────────────────────────────
     ERROR_REPORT_HMAC_SECRET must be set so the server can verify HMAC-signed
     error reports sent by rider/vendor/customer apps. A missing secret means
     all incoming reports will be rejected (or pass unsigned). In production
     this is a hard requirement; in development it is a loud warning only. */
  if (!process.env.ERROR_REPORT_HMAC_SECRET) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "\n" +
        "╔══════════════════════════════════════════════════════════════════╗\n" +
        "║  FATAL CONFIG ERROR: ERROR_REPORT_HMAC_SECRET is not set.       ║\n" +
        "║  Error reports from rider/vendor/customer apps cannot be         ║\n" +
        "║  verified. Set this secret in your environment before deploying. ║\n" +
        "╚══════════════════════════════════════════════════════════════════╝\n"
      );
      throw new Error("ERROR_REPORT_HMAC_SECRET must be set in production");
    } else {
      console.warn(
        "[startup] WARNING: ERROR_REPORT_HMAC_SECRET is not set. " +
        "Error report HMAC verification will be skipped. " +
        "Set this secret before deploying to production."
      );
    }
  } else {
    console.log("[startup] ERROR_REPORT_HMAC_SECRET is configured.");
  }

  await runSqlMigrations();
  try {
    await seedPermissionCatalog();
    await seedDefaultRoles();
    await backfillAdminRoleAssignments();
    console.log("[startup] RBAC seed + backfill complete");
  } catch (err) {
    console.error("[startup] RBAC seed/backfill failed (continuing):", err);
  }
  // Seed the default super-admin AFTER RBAC so the super_admin role exists
  // and can be granted to the new account on first boot.
  try {
    await seedDefaultSuperAdmin();
  } catch (err) {
    console.error("[startup] admin seed failed (continuing):", err);
  }
  // Reconcile any legacy seeded super-admin row (created by the old
  // forced-password-change flow) to the documented default credentials.
  // Idempotent: only touches a single row matched by ADMIN_SEED_USERNAME
  // when it still carries the legacy `must_change_password = true` flag.
  try {
    await reconcileSeededSuperAdmin();
  } catch (err) {
    console.error("[startup] admin seed reconciliation failed (continuing):", err);
  }
  // Best-effort GC of stale password reset tokens (idempotent, safe to skip).
  try {
    const purged = await purgeStaleAdminPasswordResetTokens();
    if (purged > 0) {
      console.log(`[startup] purged ${purged} expired admin password reset token(s)`);
    }
  } catch (err) {
    console.error("[startup] reset-token purge failed (continuing):", err);
  }
  // Out-of-band admin password reset detection. Compares the current
  // `admin_accounts.secret` against per-admin snapshots maintained by
  // the in-app password flows; mismatches mean somebody (typically an
  // operator) rewrote the hash directly in the database. Best-effort —
  // never blocks boot.
  try {
    await detectAndNotifyOutOfBandPasswordResets();
  } catch (err) {
    console.error(
      "[startup] admin password watchdog failed (continuing):",
      err,
    );
  }
  // Ensure error-monitor supplementary tables exist (error_resolution_backups,
  // auto_resolve_log, file_scan_results). Idempotent — uses CREATE TABLE IF NOT EXISTS.
  try {
    await ensureErrorResolutionTables();
    console.log("[startup] error-monitor supplementary tables ready");
  } catch (err) {
    console.error("[startup] error-monitor table migration failed (continuing):", err);
  }
  // data_export_logs and sentry_known_issues are managed by Drizzle migration 0005
  try {
    await ensureCartSnapshotTable();
    console.log("[startup] cart_snapshots table ready");
  } catch (err) {
    console.error("[startup] cart_snapshots table migration failed (continuing):", err);
  }
  try {
    await ensureReferralAndPrescriptionTables();
    console.log("[startup] referral_codes, referral_usages, pharmacy_prescription_refs tables ready");
  } catch (err) {
    console.error("[startup] referral/prescription table migration failed (continuing):", err);
  }
  // Upsert default platform settings so every section in the Admin
  // App Settings page shows live data immediately — without overwriting
  // any admin-edited values (INSERT … ON CONFLICT DO NOTHING).
  try {
    if (DEFAULT_PLATFORM_SETTINGS.length > 0) {
      await db.insert(platformSettingsTable).values(DEFAULT_PLATFORM_SETTINGS).onConflictDoNothing();
      console.log(`[startup] platform settings defaults ensured (${DEFAULT_PLATFORM_SETTINGS.length} entries)`);
    }
  } catch (err) {
    console.error("[startup] platform settings seed failed (continuing):", err);
  }
  // Start background health monitor (opt-in via health_monitor_enabled=on in platform settings).
  // Deferred 30 s inside startHealthMonitor so the server finishes warming up first.
  try {
    startHealthMonitor();
  } catch (err) {
    console.error("[startup] health monitor failed to start (continuing):", err);
  }
  // Run schema drift check once at startup. Logs a warning when drift is found.
  // The result is cached in schemaDrift.service.ts for the health-dashboard endpoint.
  try {
    const driftReport = await checkSchemaDrift();
    if (!driftReport.ok) {
      logger.warn(driftReport, "[startup] schema drift detected");

      // Build a clear email body with actionable ALTER TABLE commands.
      const hostname = process.env["HOST"] ?? process.env["HOSTNAME"] ?? "unknown-host";
      const timestamp = new Date().toISOString();
      const columnGaps = driftReport.columnDrift.filter(d => d.missingInDb.length > 0);

      const missingTableLines = driftReport.missingTables.length > 0
        ? driftReport.missingTables.map(t => `  • ${t}`).join("\n")
        : "  (none)";

      const columnGapLines = columnGaps.length > 0
        ? columnGaps.map(d =>
            `  Table: ${d.table}\n` +
            d.missingInDb.map(col =>
              `    ALTER TABLE "${d.table}" ADD COLUMN "${col}" TEXT;`
            ).join("\n")
          ).join("\n\n")
        : "  (none)";

      const htmlBody = `
        <h2>Schema Drift Detected on Startup</h2>
        <p><strong>Server:</strong> ${hostname}<br/>
        <strong>Detected at:</strong> ${timestamp}</p>

        <h3>Missing Tables (${driftReport.missingTables.length})</h3>
        <pre>${missingTableLines}</pre>

        <h3>Missing Columns (${columnGaps.length} table(s) affected)</h3>
        <pre>${columnGapLines}</pre>

        <p>Run <code>pnpm drizzle-kit push</code> to apply pending migrations.</p>
      `.trim();

      getCachedSettings()
        .then(settings =>
          sendAdminAlert(
            "schema_drift",
            `[AJKMart] Schema drift detected — ${driftReport.missingTables.length} missing table(s), ${columnGaps.length} column gap(s)`,
            htmlBody,
            settings,
          )
        )
        .then(result => {
          if (result.sent) {
            logger.info("[startup] schema drift alert sent");
          }
        })
        .catch(err => {
          console.error("[startup] schema drift alert email failed (non-fatal):", err);
        });
    } else {
      console.log(`[startup] schema drift check passed (${driftReport.totalSchemaTables} tables checked)`);
    }
  } catch (err) {
    console.error("[startup] schema drift check failed (continuing):", err);
  }
}

export function createServer() {
  const app = express();
  
  // Trust proxy (for proper IP detection behind reverse proxy/load balancer)
  app.set('trust proxy', 1);

  /* ── Request/response timing logger (pino-http) — MUST be first middleware ──
     Emits one structured JSON log line per request/response with:
       requestId, method, url, statusCode, responseTime (ms)
     The requestId is also propagated as x-request-id response header and
     attached to req so Sentry / audit / downstream middleware can reference it.
     Position: first, so every request including 404s and proxy responses is
     captured and the requestId is available to all later middleware. */
  app.use(pinoHttp({
    logger: pinoInstance,
    genReqId: (req, res) => {
      const existing = req.headers["x-request-id"] as string | undefined;
      const id = existing || crypto.randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        requestId: req.id,
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
    },
  }));

  /* ── Response-time collection for p95 metrics ───────────────────────────
     Hooks into the response `finish` event (after headers are flushed) to
     record each request's duration into the rolling window used by the
     health monitor and /api/health endpoint. Skips health/proxy endpoints
     so they don't skew the application p95. */
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const url = req.originalUrl ?? req.url ?? "";
      if (url.startsWith("/api/health") || url === "/" || url.startsWith("/admin") || url.startsWith("/vendor") || url.startsWith("/rider")) return;
      recordResponseTime(Date.now() - start);
    });
    next();
  });

  /* ── Sentry request handler (official pattern) ─────────────────────────────
     When @sentry/node is installed and initialised (see index.ts IIFE),
     mount Sentry.Handlers.requestHandler() BEFORE all routes so Sentry can
     attach request context (url, method, headers, user) to every captured
     event. Falls back silently if Sentry is not installed. */
  {
    const sentryMod = (globalThis as Record<string, unknown>)["__sentryInstance"] as Record<string, unknown> | undefined;
    if (sentryMod && typeof sentryMod["Handlers"] === "object" && sentryMod["Handlers"]) {
      const handlers = sentryMod["Handlers"] as Record<string, unknown>;
      if (typeof handlers["requestHandler"] === "function") {
        app.use((handlers["requestHandler"] as () => express.RequestHandler)());
      }
    }
  }

  /* ── Dev-only: serve sw.js files directly with Clear-Site-Data so the
        browser clears its SW cache on every update check. SW script fetches
        bypass the SW's own fetch handler (per spec), so this header is
        ALWAYS received by the browser regardless of any cached SW. ──────── */
  if (process.env.NODE_ENV !== "production") {
    const swFiles: Record<string, string> = {
      "/admin/sw.js":  resolve(__dirname, "../../admin/public/sw.js"),
      "/vendor/sw.js": resolve(__dirname, "../../vendor-app/public/sw.js"),
      "/rider/sw.js":  resolve(__dirname, "../../rider-app/public/sw.js"),
    };
    for (const [urlPath, filePath] of Object.entries(swFiles)) {
      app.get(urlPath, (_req, res) => {
        try {
          const content = readFileSync(filePath, "utf-8");
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Clear-Site-Data", '"cache", "storage"');
          res.send(content);
        } catch {
          res.status(404).send("/* sw.js not found */");
        }
      });
    }
  }

  /* ── Dev-only: proxy sibling apps so the api-server preview can render
        admin / vendor / rider / customer (Expo) at their respective paths.
        Registered BEFORE helmet so the proxied responses carry the
        upstream Vite headers untouched. ─────────────────────────────────── */
  if (process.env.NODE_ENV !== "production") {
    const devProxies: Array<{ prefix: string; target: string; ws?: boolean; rewriteToRoot?: boolean }> = [
      { prefix: "/admin",    target: `http://127.0.0.1:${process.env.ADMIN_DEV_PORT  ?? "23744"}`, ws: true },
      { prefix: "/vendor",   target: `http://127.0.0.1:${process.env.VENDOR_DEV_PORT ?? "3002"}`, ws: true },
      { prefix: "/rider",    target: `http://127.0.0.1:${process.env.RIDER_DEV_PORT  ?? "3001"}`, ws: true },
      { prefix: "/__mockup", target: `http://127.0.0.1:${process.env.MOCKUP_DEV_PORT ?? "8081"}`,  ws: true },
      // Expo customer app serves at "/", so /customer/* → strip prefix.
      // Absolute asset URLs Expo embeds (e.g. /_expo/static/...) are caught
      // by the Expo fallback proxy registered at the bottom of this file.
      { prefix: "/customer", target: `http://127.0.0.1:${process.env.EXPO_DEV_PORT   ?? "20716"}`, ws: true, rewriteToRoot: true },
    ];
    for (const p of devProxies) {
      // Mount at root with a path filter so the original `/admin/...` URL is
      // forwarded as-is (Express's app.use(prefix) strips the prefix from
      // req.url, which then collides with Vite's `base` and causes a redirect
      // loop). Filter ensures we only intercept the prefix paths.
      app.use(
        createProxyMiddleware({
          target: p.target,
          changeOrigin: true,
          ws: p.ws,
          xfwd: true,
          logger: undefined,
          pathFilter: (pathname) =>
            pathname === p.prefix ||
            pathname.startsWith(p.prefix + "/") ||
            pathname.startsWith(p.prefix + "?"),
          ...(p.rewriteToRoot
            ? {
                pathRewrite: (path: string) => {
                  const stripped = path.slice(p.prefix.length);
                  return stripped === "" ? "/" : stripped;
                },
              }
            : {}),
          on: {
            error: (err, _req, res) => {
              if (res && "writeHead" in res && !(res as any).headersSent) {
                (res as any).writeHead(502, { "Content-Type": "text/plain" });
                (res as any).end(
                  `Dev proxy error for ${p.prefix} → ${p.target}\n${(err as Error).message}\n` +
                  `Make sure the corresponding workflow is running.`
                );
              }
            },
          },
        }) as unknown as express.RequestHandler,
      );
    }
    console.log("[dev] Sibling app proxies enabled at /admin /vendor /rider /customer /__mockup");
  }

  // Security headers via helmet
  // Swagger UI (/api/docs) requires 'unsafe-inline' scripts and styles plus
  // worker-src blob: for its web worker. These are already present in scriptSrc
  // and styleSrc. The blob: worker is added to workerSrc.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", "blob:"],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'deny' },
    noSniff: true,
    xssFilter: true,
  }));

  // Explicit Permissions-Policy listing only modern, well-supported features.
  // Omitting deprecated/unrecognised directives (e.g. interest-cohort,
  // sync-xhr) prevents the browser from emitting "Unrecognized feature" warnings.
  app.use((_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), fullscreen=(self)"
    );
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    next();
  });
  
  // CORS with credentials support
  // Primary source: ALLOWED_ORIGINS (comma-separated list).
  // Fallback: individual URL vars so no existing deploy is broken.
  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      // In development or on Replit, allow all origins
      if (process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
      // In production, read ALLOWED_ORIGINS first, then fall back to individual vars
      const allowedOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
        : [
            ...(process.env.FRONTEND_URL || '').split(','),
            ...(process.env.CLIENT_URL || '').split(','),
            ...(process.env.ADMIN_BASE_URL || '').split(','),
          ].filter(Boolean);
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Report-Signature', 'X-Request-ID'],
  }));
  
  app.use(cookieParser());

  /* Capture raw body bytes on every JSON request so endpoints that rely on
     request signing (e.g. /api/error-reports HMAC-SHA256 verification) can
     hash the exact bytes the client signed, regardless of JSON formatting
     differences.
     Limit: 10 KB for the API generally (oversized payloads → 413).
     Error-report endpoint raises its own limit to 256 KB via a second parser. */
  app.use(express.json({
    limit: "10kb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: "10kb" }));
  
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  /* ── Dev-only: hub landing page at exact "/" with one-click cards for
        every sibling app. Registered AFTER the prefix proxies so links to
        /admin/, /vendor/, /rider/, /customer/ still hit the right targets. */
  if (process.env.NODE_ENV !== "production") {
    app.get("/", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderHubPage());
    });
  }

  app.use("/api", globalLimiter);
  app.use("/api", suspiciousPatternDetector);
  app.use("/api", router);

  /* ── JSON 404 for unmatched /api/* routes ─────────────────────────────── */
  app.use("/api/*path", (req: express.Request, res: express.Response) => {
    res.status(404).json({
      success: false,
      error: `API route not found: ${req.method} ${req.originalUrl}`,
    });
  });

  /* ── Dev-only fallback: proxy any remaining non-/api request to the
        Expo (customer / ajkmart) dev server, which serves the customer app
        at the root path. Only kicks in in development, AFTER the
        /admin /vendor /rider /__mockup proxies and the /api router. ─────── */
  if (process.env.NODE_ENV !== "production") {
    const expoTarget = `http://127.0.0.1:${process.env.EXPO_DEV_PORT ?? "20716"}`;
    const expoProxy = createProxyMiddleware({
      target: expoTarget,
      changeOrigin: true,
      ws: true,
      xfwd: true,
      logger: undefined,
      pathFilter: (pathname) =>
        pathname !== "/" &&
        pathname !== "/health" &&
        !pathname.startsWith("/api") &&
        !pathname.startsWith("/admin") &&
        !pathname.startsWith("/vendor") &&
        !pathname.startsWith("/rider") &&
        !pathname.startsWith("/customer") &&
        !pathname.startsWith("/__mockup"),
      on: {
        error: (err, _req, res) => {
          if (res && "writeHead" in res && !(res as any).headersSent) {
            (res as any).writeHead(502, { "Content-Type": "text/plain" });
            (res as any).end(
              `Dev proxy error → ${expoTarget}\n${(err as Error).message}\n` +
              `Make sure the artifacts/ajkmart: expo workflow is running.`
            );
          }
        },
      },
    }) as unknown as express.RequestHandler;
    app.use(expoProxy);
  }

  /* ── Sentry error handler (official pattern, must be before global handler) ─
     When @sentry/node is installed and initialised, mount the official
     Sentry.Handlers.errorHandler() which automatically captures unhandled
     Express errors and attaches request context. Falls back to the manual
     captureException approach if Handlers API is unavailable. */
  {
    const sentryMod = (globalThis as Record<string, unknown>)["__sentryInstance"] as Record<string, unknown> | undefined;
    if (sentryMod && typeof sentryMod["Handlers"] === "object" && sentryMod["Handlers"]) {
      const handlers = sentryMod["Handlers"] as Record<string, unknown>;
      if (typeof handlers["errorHandler"] === "function") {
        app.use((handlers["errorHandler"] as () => express.ErrorRequestHandler)());
      }
    } else if (sentryMod && typeof sentryMod["captureException"] === "function") {
      app.use((err: Error, req: express.Request, _res: express.Response, next: express.NextFunction) => {
        const s = sentryMod as Record<string, (...args: unknown[]) => void>;
        if (typeof s["withScope"] === "function") {
          s["withScope"]((scope: unknown) => {
            const sc = scope as Record<string, (...args: unknown[]) => void>;
            if (typeof sc["setTag"] === "function") sc["setTag"]("requestId", (req as unknown as Record<string, unknown>)["id"] ?? "unknown");
          });
        }
        s["captureException"](err);
        next(err);
      });
    }
  }

  /* ── Global error handler ──────────────────────────────────────────────── */
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  });
  
  return app;
}

/**
 * Dev-only landing page rendered at `GET /` on the API server.
 * Shows an iframe-based app switcher — click a tab to preview any app
 * without leaving the Replit preview window.
 */
function renderHubPage(): string {
  const apps = [
    { id: "admin",    href: "/admin/",    label: "Admin",    icon: "🛠️", color: "#6366f1" },
    { id: "vendor",   href: "/vendor/",   label: "Vendor",   icon: "🏪", color: "#10b981" },
    { id: "rider",    href: "/rider/",    label: "Rider",    icon: "🛵", color: "#f59e0b" },
    { id: "customer", href: "/customer/", label: "Customer", icon: "🛍️", color: "#ec4899" },
  ];

  const tabs = apps.map((a, i) => `
    <button
      class="tab${i === 0 ? " active" : ""}"
      data-href="${a.href}"
      data-id="${a.id}"
      style="--accent:${a.color}"
      onclick="switchApp(this)"
    >
      <span class="tab-icon">${a.icon}</span>
      <span class="tab-label">${a.label}</span>
    </button>
  `).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AJKMart — Dev Hub</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      display: flex;
      flex-direction: column;
    }

    /* ── Top bar ── */
    .topbar {
      display: flex;
      align-items: center;
      gap: 0;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      height: 44px;
      flex-shrink: 0;
      padding: 0 8px;
    }
    .logo {
      font-size: 13px;
      font-weight: 700;
      color: #58a6ff;
      padding: 0 12px 0 6px;
      letter-spacing: -0.02em;
      white-space: nowrap;
      border-right: 1px solid #30363d;
      margin-right: 8px;
    }
    .tabs {
      display: flex;
      align-items: center;
      gap: 2px;
      flex: 1;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: #8b949e;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all .15s ease;
      font-family: inherit;
    }
    .tab:hover {
      background: #21262d;
      color: #e6edf3;
      border-color: #30363d;
    }
    .tab.active {
      background: rgba(88,166,255,0.1);
      border-color: var(--accent, #6366f1);
      color: #e6edf3;
    }
    .tab.active .tab-icon { opacity: 1; }
    .tab-icon { font-size: 15px; opacity: 0.75; }

    /* ── Address bar ── */
    .addressbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      padding-left: 12px;
    }
    .url-display {
      font-size: 12px;
      color: #8b949e;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 4px 10px;
      min-width: 180px;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn-open {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #8b949e;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: all .15s ease;
      text-decoration: none;
    }
    .btn-open:hover {
      background: #30363d;
      color: #e6edf3;
    }
    .dot { width:7px; height:7px; border-radius:50%; background:#3fb950; box-shadow:0 0 5px #3fb950; flex-shrink:0; }

    /* ── iFrame area ── */
    .preview-wrap {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    iframe {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: none;
      background: #fff;
    }

    /* ── Loading overlay ── */
    .loader {
      position: absolute;
      inset: 0;
      background: #0d1117;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      z-index: 10;
      transition: opacity .3s ease;
    }
    .loader.hidden { opacity: 0; pointer-events: none; }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid #30363d;
      border-top-color: #58a6ff;
      border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loader-text { font-size: 13px; color: #8b949e; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">⬡ AJKMart</div>
    <div class="tabs" id="tabs">${tabs}</div>
    <div class="addressbar">
      <span class="dot"></span>
      <span class="url-display" id="urlDisplay">/admin/</span>
      <a class="btn-open" id="openLink" href="/admin/" target="_blank">↗ Open</a>
    </div>
  </div>

  <div class="preview-wrap">
    <div class="loader hidden" id="loader">
      <div class="spinner"></div>
      <div class="loader-text" id="loaderText">Loading…</div>
    </div>
    <iframe id="preview" src="/admin/" allow="fullscreen"></iframe>
  </div>

  <script>
    var loaderTimer = null;
    function hideLoader() {
      clearTimeout(loaderTimer);
      document.getElementById('loader').classList.add('hidden');
    }
    function showLoader(label) {
      clearTimeout(loaderTimer);
      document.getElementById('loaderText').textContent = 'Loading ' + label + '…';
      document.getElementById('loader').classList.remove('hidden');
      loaderTimer = setTimeout(hideLoader, 4000);
    }
    function switchApp(btn) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      const href = btn.dataset.href;
      const label = btn.querySelector('.tab-label').textContent;
      document.getElementById('urlDisplay').textContent = href;
      document.getElementById('openLink').href = href;
      showLoader(label);
      document.getElementById('preview').src = href;
    }
    document.getElementById('preview').addEventListener('load', hideLoader);
  </script>
</body>
</html>`;
}
