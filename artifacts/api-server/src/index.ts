import 'dotenv/config';
import { logger } from './lib/logger.js';
import net from 'net';
import { execSync } from 'child_process';
import { createServer, runStartupTasks } from "./app.js";
import { startScheduler, stopScheduler } from "./scheduler.js";

/* ── Sentry error tracking ───────────────────────────────────────────────────
   Imported directly (no dynamic import) so initialization happens synchronously
   before any routes are registered, capturing startup errors too.
   Initialization is gated on SENTRY_DSN — if unset, Sentry is a no-op.
   Set SENTRY_DSN in the Replit Secrets panel to enable. */
import * as Sentry from "@sentry/node";
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: parseFloat(
      process.env.SENTRY_SAMPLE_RATE ?? (process.env.NODE_ENV === "production" ? "0.2" : "0")
    ),
    integrations: [],
  });
  (globalThis as Record<string, unknown>)["__sentryInstance"] = Sentry;
  logger.info("[sentry] Initialized successfully");
}

process.on("unhandledRejection", (reason, promise) => {
  logger.error("[UnhandledRejection] at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  logger.error("[UncaughtException] Error:", err);
});

// ─── ENV FIRST-RUN CHECK ───────────────────────────────────────────────────
const CRITICAL_VARS = ["DATABASE_URL", "JWT_SECRET", "ENCRYPTION_MASTER_KEY"] as const;
const IMPORTANT_VARS = [
  "ADMIN_ACCESS_TOKEN_SECRET",
  "ADMIN_REFRESH_TOKEN_SECRET",
  "ADMIN_CSRF_SECRET",
  "ERROR_REPORT_HMAC_SECRET",
] as const;
// REDIS_URL is optional — rate limiting falls back to in-memory store and
// JWT blacklisting is disabled when absent. The redis.ts module logs its own
// warning. Not listed as CRITICAL so the server starts cleanly without Redis.
const OPTIONAL_VARS = ["REDIS_URL"] as const;

/** Known dev placeholder JWT secret values — must not be used in production. */
const DEV_PLACEHOLDER_SECRETS = new Set([
  "70d7bbb271fc1cf1a6397e8407153c9212f0e27c4b1b38c3f56ec08701718bc3849fe94eebaaed82f47d1cd93830ca7fe3255983484582511c8860cbec76f7cb",
  "0bf96d92374ef22e78a01b29ee69c0356a06e30e3e194c75fa2458704d296412833291a297210a3b6037fc99e5f1c1117b0b8b8c358ff9aa9561c8aa3029b186",
  "e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4b7c0d3e6f9a2b5c8d1e4f7a0b3c6d9e2",
  "f9a2b5c8d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4b7c0d3e6f9",
]);
const JWT_SECRET_VARS = [
  "JWT_SECRET", "ADMIN_JWT_SECRET", "ADMIN_ACCESS_TOKEN_SECRET",
  "ADMIN_REFRESH_TOKEN_SECRET", "ADMIN_REFRESH_SECRET", "ADMIN_SECRET",
  "VENDOR_JWT_SECRET", "RIDER_JWT_SECRET",
];

function checkEnv(): void {
  const nodeEnv = process.env.NODE_ENV ?? "";
  const isProduction = ["production", "staging"].includes(nodeEnv);
  const missing = CRITICAL_VARS.filter((k) => !process.env[k]);
  const empty   = IMPORTANT_VARS.filter((k) => !process.env[k]);

  /* Warn loudly (fatal in production) if dev placeholder JWT secrets are in use */
  if (isProduction) {
    const placeholderVars = JWT_SECRET_VARS.filter(
      (k) => process.env[k] && DEV_PLACEHOLDER_SECRETS.has(process.env[k]!),
    );
    if (placeholderVars.length > 0) {
      logger.fatal(
        { vars: placeholderVars },
        "[env:check] FATAL — dev placeholder JWT secrets detected in production. " +
        "Generate new secrets: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\" " +
        "and update them in the Replit Secrets panel before deploying.",
      );
      process.exit(1);
    }
  }

  if (missing.length === 0 && empty.length === 0) return;

  const hr  = "═".repeat(66);
  const pad = (s: string) => `║  ${s.padEnd(63)}║`;

  const lines: string[] = [
    `╔${hr}╗`,
    pad("⚠️  AJKMart API — ENVIRONMENT NOT CONFIGURED"),
    `╠${hr}╣`,
  ];

  if (missing.length > 0) {
    lines.push(pad("CRITICAL (server will not function correctly):"));
    for (const k of missing) lines.push(pad(`  ✗ ${k}`));
    lines.push(pad(""));
  }

  if (empty.length > 0) {
    lines.push(pad("MISSING (features may break or be insecure):"));
    for (const k of empty) lines.push(pad(`  ! ${k}`));
    lines.push(pad(""));
  }

  lines.push(`╠${hr}╣`);
  lines.push(pad("To fix:"));
  lines.push(pad(""));
  lines.push(pad("  On Replit:  add secrets in the Secrets panel (padlock icon)"));
  lines.push(pad("  Other envs: set values in your .env file at the project root"));
  lines.push(pad(""));
  lines.push(pad("  Then restart:   pnpm replit-start"));
  lines.push(`╚${hr}╝`);

  logger.error("\n" + lines.join("\n") + "\n");

  if (isProduction && missing.length > 0) {
    logger.error("[env:check] FATAL — critical vars missing in production. Exiting.");
    process.exit(1);
  }

  if (!isProduction && missing.length > 0) {
    logger.warn("[env:check] Development mode — continuing despite missing critical vars.");
    logger.warn("[env:check] Add missing secrets in the Replit Secrets panel, then restart.\n");
  }
}

checkEnv();
// ──────────────────────────────────────────────────────────────────────────

// Configuration from environment variables
const PORT = parseInt(process.env.PORT ?? "5000", 10);
const PORT_FALLBACK_ENABLE = (process.env.PORT_FALLBACK_ENABLE ?? "true").toLowerCase() === "true";
const PORT_MAX_RETRIES = parseInt(process.env.PORT_MAX_RETRIES ?? "10", 10);

/**
 * Returns true if a TCP listener is already bound to the port.
 * @param p - Port number to check
 */
function isPortInUse(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.debug(`[port:check] Port ${p} is in use (EADDRINUSE)`);
        resolve(true);
      } else {
        logger.warn(`[port:check] Unexpected error checking port ${p}:`, err.code, err.message);
        resolve(false);
      }
    });
    probe.once("listening", () => {
      probe.close(() => {
        logger.debug(`[port:check] Port ${p} is available`);
        resolve(false);
      });
    });
    probe.listen(p, "0.0.0.0");
  });
}

/**
 * Try to free the port by killing whatever process is using it.
 * @param p - Port number to free
 * @returns true if a process was killed, false otherwise
 */
function tryKillPort(p: number): boolean {
  try {
    // fuser is available via psmisc (declared in nix packages in .replit)
    execSync(`fuser -k ${p}/tcp`, { stdio: "ignore" });
    logger.info(`[port:kill] Freed port ${p} using fuser`);
    return true;
  } catch {
    logger.debug(`[port:kill] fuser: no process on port ${p}`);
    return false;
  }
}

/**
 * Find the next available port starting from `start`.
 * @param start - Starting port number
 * @param maxAttempts - Maximum number of ports to try
 * @returns Available port number
 * @throws Error if no available port is found
 */
async function findAvailablePort(start: number, maxAttempts: number): Promise<number> {
  logger.info(`[port:search] Searching for available port starting from ${start} (max ${maxAttempts} attempts)`);
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = start + i;
    const inUse = await isPortInUse(candidate);
    if (!inUse) {
      logger.info(`[port:search] Found available port: ${candidate}`);
      return candidate;
    }
  }
  const error = `No available port found in range ${start}–${start + maxAttempts - 1}`;
  logger.error(`[port:search] ${error}`);
  throw new Error(error);
}

/**
 * Main server startup function with production-grade port handling.
 */
async function main() {
  let listenPort = PORT;

  logger.info(`[port:init] Primary port: ${PORT}, fallback enabled: ${PORT_FALLBACK_ENABLE}, max retries: ${PORT_MAX_RETRIES}`);

  // Check if primary port is available
  const occupied = await isPortInUse(PORT);
  if (occupied) {
    logger.warn(`[port:conflict] Port ${PORT} is already in use`);

    if (!PORT_FALLBACK_ENABLE) {
      logger.error(`[port:conflict] Port fallback is disabled — refusing to continue`);
      process.exit(1);
    }

    // Try to free the port
    logger.info(`[port:conflict] Attempting to free port ${PORT}…`);
    const killed = tryKillPort(PORT);
    if (killed) {
      // Give the OS a moment to release the port
      await new Promise((r) => setTimeout(r, 500));
      const stillOccupied = await isPortInUse(PORT);
      if (stillOccupied) {
        logger.warn(`[port:conflict] Port ${PORT} still occupied after killing process — falling back`);
        listenPort = await findAvailablePort(PORT + 1, PORT_MAX_RETRIES);
        logger.info(`[port:fallback] Using fallback port ${listenPort} instead of primary port ${PORT}`);
      } else {
        logger.info(`[port:conflict] Port ${PORT} successfully freed — using primary port`);
        listenPort = PORT;
      }
    } else {
      logger.info(`[port:conflict] Could not free port ${PORT} (no process to kill) — falling back`);
      listenPort = await findAvailablePort(PORT + 1, PORT_MAX_RETRIES);
      logger.info(`[port:fallback] Using fallback port ${listenPort} instead of primary port ${PORT}`);
    }
  } else {
    logger.info(`[port:check] Primary port ${PORT} is available`);
  }

  /* Seed runtime config from DB so a previously-rotated ADMIN_SECRET
     takes effect on restart without requiring an env-var change. */
  try {
    const { seedRuntimeConfigFromDb } = await import("./lib/runtime-config.js");
    await seedRuntimeConfigFromDb();
    logger.info("[runtime-config] Seeded from DB");
  } catch (e) {
    logger.warn({ err: e }, "[runtime-config] Seed failed — env var fallback will be used");
  }

  const server = createServer();

  // Open the port FIRST so the platform's port detector sees a live listener
  // quickly. Migrations + RBAC seeding run immediately after; if they fail,
  // we exit non-zero so the platform restarts us.
  const httpServer = server.listen(listenPort, "0.0.0.0", () => {
    const addr = httpServer.address();
    logger.info(`[server:listen] Server listening on port ${listenPort} (addr=${JSON.stringify(addr)})`);

    runStartupTasks()
      .then(() => {
        logger.info("[startup] migrations + RBAC ready — serving requests");
        startScheduler();
        logger.info("[startup] background scheduler started");
      })
      .catch((err: Error) => {
        logger.error("[startup] fatal — refusing to continue:", err);
        process.exit(1);
      });
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    logger.error(`[server:error] Failed to bind port ${listenPort}:`, {
      code: err.code,
      message: err.message,
      errno: err.errno
    });
    process.exit(1);
  });

  /* ── Graceful shutdown ────────────────────────────────────────────────────
     On SIGTERM (container stop / platform restart) or SIGINT (Ctrl-C):
       1. Stop accepting new connections.
       2. Call stopScheduler() — clears all cleanup job timers and stops the
          ride dispatch engine, allowing in-flight DB queries to settle.
       3. Close existing HTTP connections, then exit cleanly.
  ───────────────────────────────────────────────────────────────────────── */
  const gracefulShutdown = (signal: string) => {
    logger.info(`[shutdown] ${signal} received — initiating graceful shutdown`);
    stopScheduler();
    httpServer.close((closeErr) => {
      if (closeErr) {
        logger.error("[shutdown] error closing HTTP server:", closeErr);
        process.exit(1);
      } else {
        logger.info("[shutdown] HTTP server closed — exiting");
        process.exit(0);
      }
    });
    /* Safety net: force-exit after 10 s if connections don't drain */
    setTimeout(() => {
      logger.error("[shutdown] graceful shutdown timed out — force exiting");
      process.exit(1);
    }, 10_000).unref();
  };

  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.once("SIGINT",  () => gracefulShutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("[startup] Unrecoverable error:", err);
  process.exit(1);
});
