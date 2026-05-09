import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
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
      logger.fatal(
        "[startup] FATAL CONFIG ERROR: ERROR_REPORT_HMAC_SECRET is not set. " +
        "Error reports from rider/vendor/customer apps cannot be verified. " +
        "Set this secret in your environment before deploying."
      );
      throw new Error("ERROR_REPORT_HMAC_SECRET must be set in production");
    } else {
      logger.warn(
        "[startup] WARNING: ERROR_REPORT_HMAC_SECRET is not set. " +
        "Error report HMAC verification will be skipped. " +
        "Set this secret before deploying to production."
      );
    }
  } else {
    logger.info("[startup] ERROR_REPORT_HMAC_SECRET is configured.");
  }

  await runSqlMigrations();
  try {
    await seedPermissionCatalog();
    await seedDefaultRoles();
    await backfillAdminRoleAssignments();
    logger.info("[startup] RBAC seed + backfill complete");
  } catch (err) {
    logger.error({ err }, "[startup] RBAC seed/backfill failed (continuing)");
  }
  try {
    await seedDefaultSuperAdmin();
  } catch (err) {
    logger.error({ err }, "[startup] admin seed failed (continuing)");
  }
  try {
    await reconcileSeededSuperAdmin();
  } catch (err) {
    logger.error({ err }, "[startup] admin seed reconciliation failed (continuing)");
  }
  try {
    const purged = await purgeStaleAdminPasswordResetTokens();
    if (purged > 0) {
      logger.info({ purged }, "[startup] purged expired admin password reset token(s)");
    }
  } catch (err) {
    logger.error({ err }, "[startup] reset-token purge failed (continuing)");
  }
  try {
    await detectAndNotifyOutOfBandPasswordResets();
  } catch (err) {
    logger.error({ err }, "[startup] admin password watchdog failed (continuing)");
  }
  try {
    await ensureErrorResolutionTables();
    logger.info("[startup] error-monitor supplementary tables ready");
  } catch (err) {
    logger.error({ err }, "[startup] error-monitor table migration failed (continuing)");
  }
  try {
    await ensureCartSnapshotTable();
    logger.info("[startup] cart_snapshots table ready");
  } catch (err) {
    logger.error({ err }, "[startup] cart_snapshots table migration failed (continuing)");
  }
  try {
    await ensureReferralAndPrescriptionTables();
    logger.info("[startup] referral_codes, referral_usages, pharmacy_prescription_refs tables ready");
  } catch (err) {
    logger.error({ err }, "[startup] referral/prescription table migration failed (continuing)");
  }
  try {
    if (DEFAULT_PLATFORM_SETTINGS.length > 0) {
      await db.insert(platformSettingsTable).values(DEFAULT_PLATFORM_SETTINGS).onConflictDoNothing();
      logger.info({ count: DEFAULT_PLATFORM_SETTINGS.length }, "[startup] platform settings defaults ensured");
    }
  } catch (err) {
    logger.error({ err }, "[startup] platform settings seed failed (continuing)");
  }
  try {
    startHealthMonitor();
  } catch (err) {
    logger.error({ err }, "[startup] health monitor failed to start (continuing)");
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
          logger.error({ err }, "[startup] schema drift alert email failed (non-fatal)");
        });
    } else {
      logger.info({ tables: driftReport.totalSchemaTables }, "[startup] schema drift check passed");
    }
  } catch (err) {
    logger.error({ err }, "[startup] schema drift check failed (continuing)");
  }
}

/**
 * Validate and return the CORS allowed-origins whitelist.
 *
 * Production: fatal exit if no origins are configured — a misconfigured
 *   production server must never silently allow all origins.
 * Development: warns and falls back to a safe localhost-only list so
 *   developers can work without setting every env var upfront.
 */
function validateCORS(): string[] {
  const fromEnv = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) {
    return fromEnv;
  }

  if (process.env.NODE_ENV === 'production') {
    logger.fatal(
      '\n' +
      '╔══════════════════════════════════════════════════════════════════╗\n' +
      '║  FATAL: ALLOWED_ORIGINS is not set in production.               ║\n' +
      '║  Without it the CORS middleware would allow ALL origins,         ║\n' +
      '║  exposing credentialed API endpoints to any website.             ║\n' +
      '║  Set ALLOWED_ORIGINS to a comma-separated list of allowed URLs   ║\n' +
      '║  and restart the server.                                         ║\n' +
      '╚══════════════════════════════════════════════════════════════════╝'
    );
    process.exit(1);
  }

  // Development fallback — safe localhost-only list
  const devFallback = [
    'http://localhost:5173',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://127.0.0.1:5000',
  ];
  logger.warn(
    { allowedOrigins: devFallback },
    '[SECURITY:CORS] ALLOWED_ORIGINS not set — falling back to localhost-only whitelist for development. Set ALLOWED_ORIGINS before deploying to production.'
  );
  return devFallback;
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
    logger.info("[dev] Sibling app proxies enabled at /admin /vendor /rider /customer /__mockup");
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
  
  // CORS with strict origin whitelist.
  // validateCORS() enforces production-fatal / dev-fallback logic and returns
  // the final allowed-origins list. The callback never falls through to allow-all.
  const allowedOrigins = validateCORS();
  logger.info({ allowedOrigins }, '[SECURITY:CORS] Active allowed origins');

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      logger.warn({ blockedOrigin: origin }, '[SECURITY:CORS] Request blocked — origin not in whitelist');
      callback(new Error('CORS policy violation'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Report-Signature', 'X-Request-ID'],
    maxAge: 3600,
  }));
  
  app.use(cookieParser());

  /* ── HTTP response compression (gzip/brotli) ──────────────────────────────
     Applied after cookieParser and before the API router. Skipped for
     health and proxy paths so they are not affected. */
  app.use(compression({
    filter: (req, res) => {
      const url = req.originalUrl ?? req.url ?? "";
      if (url === "/health" || url.startsWith("/admin") || url.startsWith("/vendor") || url.startsWith("/rider") || url.startsWith("/customer") || url.startsWith("/__mockup")) {
        return false;
      }
      return compression.filter(req, res);
    },
  }));

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
  
  /* ── Root /health — rich DB+Redis check (same as /api/health) ───────────
     Uptime monitors and load balancers often probe the root /health path.
     We proxy to the full /api/health logic so both endpoints are meaningful. */
  app.get("/health", (_req, res) => {
    res.redirect(307, "/api/health");
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

  /* ── Request timeout guard ───────────────────────────────────────────────
     Requests that hang longer than REQUEST_TIMEOUT_MS (default 30 s) receive
     a 503 response and the socket is terminated. SSE streams and WebSocket
     upgrade requests are excluded so long-lived connections work normally. */
  const REQUEST_TIMEOUT_MS = parseInt(process.env["REQUEST_TIMEOUT_MS"] ?? "30000", 10);
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const isSSE = req.headers["accept"] === "text/event-stream";
    const isWsUpgrade = req.headers["upgrade"]?.toLowerCase() === "websocket";
    if (isSSE || isWsUpgrade) { next(); return; }

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn({ method: req.method, url: req.originalUrl, timeoutMs: REQUEST_TIMEOUT_MS }, "[timeout] Request timed out — returning 503");
        res.status(503).json({ success: false, error: "Request timeout. Please try again." });
      }
    }, REQUEST_TIMEOUT_MS);
    timer.unref();

    res.on("finish", () => clearTimeout(timer));
    res.on("close",  () => clearTimeout(timer));
    next();
  });

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

  /* ── Sentry error handler (must be mounted BEFORE the generic error handler) */
  {
    const sentryMod = (globalThis as Record<string, unknown>)["__sentryInstance"] as Record<string, unknown> | undefined;
    if (sentryMod && typeof sentryMod["Handlers"] === "object" && sentryMod["Handlers"]) {
      const handlers = sentryMod["Handlers"] as Record<string, unknown>;
      if (typeof handlers["errorHandler"] === "function") {
        app.use((handlers["errorHandler"] as () => express.ErrorRequestHandler)());
      }
    }
  }

  /* ── Global Express error handler ──────────────────────────────────────
     Catches any error passed to next(err) from route handlers or middleware.
     Never leaks stack traces or internal messages to the client in production. */
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, method: req.method, url: req.originalUrl }, "[error] Unhandled route error");
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: "Internal server error" });
    }
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
              `Dev proxy error for EXPO → ${expoTarget}\n${(err as Error).message}\n` +
              `Make sure the ajkmart (expo) workflow is running.`
            );
          }
        },
      },
    });
    app.use(expoProxy as unknown as express.RequestHandler);
  }

  return app;
}

function renderHubPage() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AJKMart — Project Hub</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-white min-h-screen flex items-center justify-center p-6">
      <div class="max-w-4xl w-full">
        <header class="mb-12 text-center">
          <h1 class="text-4xl font-extrabold tracking-tight mb-2">AJKMart</h1>
          <p class="text-slate-400 text-lg">Pakistan's Premium Multi-Service Platform</p>
        </header>
        
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <a href="/admin/" class="group block p-6 bg-slate-800 rounded-2xl border border-slate-700 hover:border-indigo-500 transition-all">
            <h3 class="text-xl font-bold mb-2 group-hover:text-indigo-400">Admin Panel</h3>
            <p class="text-slate-400 text-sm">Fleet management, financial reconciliation, and platform settings.</p>
          </a>
          <a href="/vendor/" class="group block p-6 bg-slate-800 rounded-2xl border border-slate-700 hover:border-emerald-500 transition-all">
            <h3 class="text-xl font-bold mb-2 group-hover:text-emerald-400">Vendor App</h3>
            <p class="text-slate-400 text-sm">Store management, order fulfillment, and inventory tracking.</p>
          </a>
          <a href="/rider/" class="group block p-6 bg-slate-800 rounded-2xl border border-slate-700 hover:border-amber-500 transition-all">
            <h3 class="text-xl font-bold mb-2 group-hover:text-amber-400">Rider App</h3>
            <p class="text-slate-400 text-sm">Real-time ride dispatch, GPS tracking, and delivery logistics.</p>
          </a>
          <a href="/customer/" class="group block p-6 bg-slate-800 rounded-2xl border border-slate-700 hover:border-rose-500 transition-all">
            <h3 class="text-xl font-bold mb-2 group-hover:text-rose-400">Customer App</h3>
            <p class="text-slate-400 text-sm">Marketplace, ride booking, and digital wallet (Expo/Web).</p>
          </a>
          <a href="/api/docs" class="group block p-6 bg-slate-800 rounded-2xl border border-slate-700 hover:border-sky-500 transition-all">
            <h3 class="text-xl font-bold mb-2 group-hover:text-sky-400">API Documentation</h3>
            <p class="text-slate-400 text-sm">Interactive Swagger UI for the backend REST endpoints.</p>
          </a>
          <a href="/__mockup/" class="group block p-6 bg-slate-800 rounded-2xl border border-slate-700 hover:border-slate-500 transition-all">
            <h3 class="text-xl font-bold mb-2">Component Preview</h3>
            <p class="text-slate-400 text-sm">Sandbox for UI components and design system verification.</p>
          </a>
        </div>

        <footer class="mt-16 pt-8 border-t border-slate-800 text-center text-slate-500 text-sm">
          AJKMart Dev Hub &bull; ${new Date().getFullYear()}
        </footer>
      </div>
    </body>
    </html>
  `;
}
