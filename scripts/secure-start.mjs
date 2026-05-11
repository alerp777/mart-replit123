#!/usr/bin/env node
/**
 * AJKMart — Universal Secure Start
 * ─────────────────────────────────
 * Works on Replit, GitHub Codespaces, and local machines.
 *
 * Environment detection (automatic, no flags needed):
 *   • Replit      — REPL_ID is set in the environment
 *   • Codespaces  — CODESPACE_NAME is set
 *   • Local       — neither of the above
 *
 * Replit mode:
 *   Secrets already live in the Replit Secrets panel → no decrypt needed.
 *   Stale processes on ports are killed automatically before startup.
 *   ALLOWED_ORIGINS and EXPO_PUBLIC_DOMAIN are auto-set from REPLIT_DEV_DOMAIN.
 *
 * Codespaces / Local mode:
 *   Auto-decrypts .env.enc using ENV_PASSWORD env var (default: Khan@123.com).
 *   Falls back to .env if present. Falls back to process.env if neither exists.
 *
 * Password: Khan@123.com  (set ENV_PASSWORD env var to override)
 */

import fs, { existsSync, statSync } from "fs";
import { spawn, spawnSync, execSync } from "node:child_process";
import { createDecipheriv, scryptSync } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

// ── Colours ───────────────────────────────────────────────────────────────────
const c = {
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

function log(msg)  { console.log(`[secure-start] ${msg}`); }
function warn(msg) { console.warn(`[secure-start] ${c.yellow(msg)}`); }
function err(msg)  { console.error(`[secure-start] ${c.red(msg)}`); }
function ok(msg)   { console.log(`[secure-start] ${c.green("✓")} ${msg}`); }

// ── Environment detection ──────────────────────────────────────────────────────
const IS_REPLIT     = !!process.env.REPL_ID;
const IS_CODESPACES = !!process.env.CODESPACE_NAME;
const ENV_NAME      = IS_REPLIT ? "Replit" : IS_CODESPACES ? "Codespaces" : "Local";

// ── Helpers ───────────────────────────────────────────────────────────────────
function run(label, cmd, args, opts = {}) {
  log(label);
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: false, ...opts });
  if (result.status !== 0) {
    err(`${label} failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

function runOptional(label, cmd, args, opts = {}) {
  log(label);
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: false, ...opts });
  if (result.status !== 0) warn(`${label} exited with ${result.status} — continuing`);
}

// ── Dependency install (stamp-cached) ─────────────────────────────────────────
function installDeps() {
  const stamp    = path.join(root, "node_modules", ".secure-start-stamp");
  const lock     = path.join(root, "pnpm-lock.yaml");
  const stampMt  = existsSync(stamp) ? statSync(stamp).mtimeMs : 0;
  const lockMt   = existsSync(lock)  ? statSync(lock).mtimeMs  : Infinity;
  if (!existsSync(path.join(root, "node_modules")) || lockMt > stampMt) {
    run("Installing dependencies", "pnpm", ["install", "--no-frozen-lockfile"]);
    try { fs.writeFileSync(stamp, String(Date.now())); } catch {}
  } else {
    ok("node_modules up to date — skipping install");
  }
}

// ── Shared lib build (stamp-cached) ───────────────────────────────────────────
function buildLibs() {
  const stamp        = path.join(root, "node_modules", ".libs-built-stamp");
  const tsconfigPath = path.join(root, "tsconfig.json");
  const stampMt      = existsSync(stamp)        ? statSync(stamp).mtimeMs        : 0;
  const tscMt        = existsSync(tsconfigPath) ? statSync(tsconfigPath).mtimeMs : Infinity;

  let needsBuild = tscMt > stampMt;
  if (!needsBuild) {
    try {
      for (const sub of fs.readdirSync(path.join(root, "lib"))) {
        const srcDir = path.join(root, "lib", sub, "src");
        if (!existsSync(srcDir)) continue;
        const walk = dir => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (statSync(full).mtimeMs > stampMt) needsBuild = true;
          }
        };
        walk(srcDir);
        if (needsBuild) break;
      }
    } catch { needsBuild = true; }
  }

  if (needsBuild) {
    run("Building shared lib packages", "pnpm", ["run", "typecheck:libs"]);
    try { fs.writeFileSync(stamp, String(Date.now())); } catch {}
  } else {
    ok("Shared lib packages up to date — skipping lib build");
  }
}

// ── .env.enc decrypt ──────────────────────────────────────────────────────────
const ENC_SALT = Buffer.from("AJKMart-Env-Salt-2024-v1", "utf8");

function decryptEnvFile(password) {
  const encPath = path.join(root, ".env.enc");
  if (!existsSync(encPath)) return null;
  try {
    const { encrypted, iv, authTag } = JSON.parse(fs.readFileSync(encPath, "utf8"));
    const key      = scryptSync(password, ENC_SALT, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(authTag, "hex"));
    let plain = decipher.update(encrypted, "hex", "utf8");
    plain += decipher.final("utf8");
    return JSON.parse(plain);
  } catch (e) {
    err(`Failed to decrypt .env.enc: ${e.message}`);
    return null;
  }
}

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return env;
}

function writeEnvFile(envData) {
  const envPath = path.join(root, ".env");
  const lines = Object.entries(envData).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, lines.join("\n") + "\n");
}

/**
 * Load environment variables:
 * - Replit:     secrets already in process.env — nothing to do
 * - Codespaces/Local: decrypt .env.enc → write .env → load into process.env
 */
function loadEnv() {
  if (IS_REPLIT) {
    ok("Replit mode — using Replit Secrets (no decrypt needed)");
    return;
  }

  const envPath = path.join(root, ".env");
  const encPath = path.join(root, ".env.enc");

  // If .env already present and non-empty, use it
  if (existsSync(envPath) && statSync(envPath).size > 100) {
    ok(".env already present — loading");
    for (const [k, v] of Object.entries(parseEnvFile(envPath))) {
      if (!process.env[k]) process.env[k] = v;
    }
    return;
  }

  // Decrypt .env.enc
  if (existsSync(encPath)) {
    const password = process.env.ENV_PASSWORD || "Khan@123.com";
    log(`Decrypting .env.enc (${IS_CODESPACES ? "Codespaces" : "Local"} mode)…`);
    const envData = decryptEnvFile(password);
    if (!envData) {
      err("Could not decrypt .env.enc — check ENV_PASSWORD or recreate the file.");
      process.exit(1);
    }
    writeEnvFile(envData);
    for (const [k, v] of Object.entries(envData)) {
      if (!process.env[k]) process.env[k] = v;
    }
    ok(`Decrypted ${Object.keys(envData).length} variables from .env.enc`);
    return;
  }

  warn("No .env or .env.enc found — relying on process.env (may be incomplete)");
}

// ── Replit: auto-set dynamic env vars ────────────────────────────────────────
function applyReplitOverrides(apiPort, adminPort, vendorPort, riderPort, ajkPort) {
  if (!IS_REPLIT) return;

  const domain     = process.env.REPLIT_DEV_DOMAIN || "";
  const expoDomain = process.env.REPLIT_EXPO_DEV_DOMAIN || domain;

  if (domain) {
    const replitOrigin = `https://${domain}`;
    const existing     = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!existing.includes(replitOrigin)) {
      process.env.ALLOWED_ORIGINS = [...existing, replitOrigin].filter(Boolean).join(",");
    }
    if (!process.env.APP_BASE_URL || process.env.APP_BASE_URL.includes("localhost")) {
      process.env.APP_BASE_URL = replitOrigin;
    }
  }

  if (expoDomain) {
    process.env.EXPO_PUBLIC_DOMAIN      = expoDomain;
    process.env.REPLIT_DEV_DOMAIN       = expoDomain;
    process.env.REPLIT_EXPO_DEV_DOMAIN  = expoDomain;
  }

  ok(`Replit domain: ${domain || "(not set)"}`);
}

// ── Port utilities ────────────────────────────────────────────────────────────
function isPortFree(port) {
  return new Promise(resolve => {
    const s = net.createConnection({ port: Number(port), host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error",   () => resolve(true));
  });
}

/** Try to kill whatever is holding a port. Returns true if something was killed. */
function killPort(port) {
  // fuser is from psmisc (declared in .replit nix packages)
  try {
    execSync(`fuser -k ${port}/tcp 2>/dev/null`, { stdio: "ignore" });
    return true;
  } catch { return false; }
}

/**
 * On Replit: kill stale processes then continue.
 * On Codespaces/Local: assert ports are free (user must stop conflicting processes).
 */
async function handlePorts(ports) {
  if (IS_REPLIT) {
    for (const { name, port } of ports) {
      const occupied = !(await isPortFree(port));
      if (occupied) {
        log(`Port ${port} (${name}) occupied — killing stale process…`);
        killPort(port);
        await new Promise(r => setTimeout(r, 600));
      }
    }
    ok("Ports cleared");
    return;
  }

  const inUse = [];
  for (const { name, port } of ports) {
    if (!(await isPortFree(port))) inUse.push(`${name}:${port}`);
  }
  if (inUse.length > 0) {
    err(`Ports already in use: ${inUse.join(", ")}`);
    err("Stop those processes then re-run, or set different PORT env vars.");
    process.exit(1);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
async function healthCheck(name, url, retries = 30, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok || res.status < 500) {
        ok(`${name} is up (${url})`);
        return true;
      }
    } catch { /* not ready yet */ }
    if (i % 5 === 4) log(`Waiting for ${name}… (${i + 1}/${retries})`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  warn(`${name} did not respond at ${url} after ${retries} attempts — continuing`);
  return false;
}

// ── Service launcher ──────────────────────────────────────────────────────────
const children = [];

function startService(name, pnpmArgs, extraEnv = {}) {
  log(`Starting ${name}…`);
  const proc = spawn("pnpm", pnpmArgs, {
    cwd:      root,
    env:      { ...process.env, ...extraEnv },
    stdio:    "inherit",
    detached: true,
    shell:    false,
  });
  proc.on("error", e => err(`[${name}] spawn error: ${e.message}`));
  proc.on("exit", code => {
    if (code !== 0 && code !== null) {
      err(`[${name}] exited with code ${code}`);
      process.exitCode = code;
    }
  });
  proc.unref();
  return proc;
}

// ── Signal handlers ───────────────────────────────────────────────────────────
function shutdown(signal) {
  log(`${signal} received — stopping all services…`);
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  process.exit(0);
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c.bold(`\n╔══════════════════════════════════════════════════════════╗`));
  console.log(c.bold(`║        AJKMart secure-start — ${ENV_NAME.padEnd(25)}      ║`));
  console.log(c.bold(`╚══════════════════════════════════════════════════════════╝\n`));

  // ── Step 1: Load environment ──────────────────────────────────────────────
  loadEnv();

  // ── Step 2: Resolve ports ─────────────────────────────────────────────────
  // These match exactly what .replit [userenv.shared] sets:
  //   ADMIN_PORT_OVERRIDE=3000 / ADMIN_DEV_PORT=3000
  //   RIDER_DEV_PORT=3003
  //   VENDOR_DEV_PORT=3002
  //   PORT=5000
  const apiPort    = process.env.PORT                  || "5000";
  const adminPort  = process.env.ADMIN_PORT_OVERRIDE   ||
                     process.env.ADMIN_DEV_PORT        || "3000";
  const vendorPort = process.env.VENDOR_DEV_PORT       || "3002";
  const riderPort  = process.env.RIDER_DEV_PORT        || "3003";
  const ajkPort    = process.env.PORT_AJK               || "19006";

  const apiProxy   = `http://127.0.0.1:${apiPort}`;

  // ── Step 3: Replit dynamic overrides ──────────────────────────────────────
  applyReplitOverrides(apiPort, adminPort, vendorPort, riderPort, ajkPort);

  // ── Step 4: Check DATABASE_URL ────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    err("DATABASE_URL is not set.");
    if (IS_REPLIT) {
      err("Add DATABASE_URL to the Replit Secrets panel (padlock icon) and restart.");
    } else {
      err("Add DATABASE_URL to .env.enc or set it as an environment variable.");
    }
    process.exit(1);
  }
  ok("DATABASE_URL configured");

  // ── Step 5: Install deps + build libs ────────────────────────────────────
  installDeps();
  buildLibs();

  // ── Step 6: Handle ports ──────────────────────────────────────────────────
  await handlePorts([
    { name: "api",     port: apiPort    },
    { name: "admin",   port: adminPort  },
    { name: "vendor",  port: vendorPort },
    { name: "rider",   port: riderPort  },
    { name: "ajkmart", port: ajkPort    },
  ]);

  // ── Step 7: Launch all services ───────────────────────────────────────────
  const domain     = process.env.REPLIT_DEV_DOMAIN        || "";
  const expoDomain = process.env.REPLIT_EXPO_DEV_DOMAIN   || domain;

  const services = [
    {
      name:      "api",
      args:      ["--filter", "@workspace/api-server", "dev"],
      env:       { PORT: apiPort, NODE_ENV: "development" },
      healthUrl: `http://127.0.0.1:${apiPort}/api/health`,
      retries:   25,
    },
    {
      name:      "admin",
      args:      ["--filter", "@workspace/admin", "dev"],
      env:       {
        ADMIN_DEV_PORT:       adminPort,
        ADMIN_PORT_OVERRIDE:  adminPort,
        HOST:                 "0.0.0.0",
        BASE_PATH:            "/admin/",
        VITE_API_PROXY_TARGET: apiProxy,
      },
      healthUrl: `http://127.0.0.1:${adminPort}/`,
      retries:   20,
    },
    {
      name:      "vendor",
      args:      ["--filter", "@workspace/vendor-app", "dev"],
      env:       {
        VENDOR_DEV_PORT:       vendorPort,
        HOST:                  "0.0.0.0",
        BASE_PATH:             "/vendor/",
        VITE_API_PROXY_TARGET: apiProxy,
      },
      healthUrl: `http://127.0.0.1:${vendorPort}/`,
      retries:   20,
    },
    {
      name:      "rider",
      args:      ["--filter", "@workspace/rider-app", "dev"],
      env:       {
        RIDER_DEV_PORT:        riderPort,
        HOST:                  "0.0.0.0",
        BASE_PATH:             "/rider/",
        VITE_API_PROXY_TARGET: apiProxy,
      },
      healthUrl: `http://127.0.0.1:${riderPort}/`,
      retries:   20,
    },
    {
      name:      "ajkmart",
      args:      ["--filter", "@workspace/ajkmart", "dev:web"],
      env:       {
        PORT:                   ajkPort,
        BASE_PATH:              "/",
        EXPO_PUBLIC_DOMAIN:     expoDomain || `localhost:${apiPort}`,
        REPLIT_DEV_DOMAIN:      expoDomain || `localhost:${apiPort}`,
        REPLIT_EXPO_DEV_DOMAIN: expoDomain || `localhost:${apiPort}`,
        REPL_ID:                process.env.REPL_ID || "secure-start",
      },
      healthUrl: `http://127.0.0.1:${ajkPort}/`,
      // Expo web bundling takes longer — give it more time
      retries:   45,
      delayMs:   3000,
    },
  ];

  for (const svc of services) {
    const proc = startService(svc.name, svc.args, svc.env);
    if (proc) children.push(proc);
  }

  log("All services launched — running health checks in parallel…");

  await Promise.all(
    services.map(svc => healthCheck(svc.name, svc.healthUrl, svc.retries ?? 30, svc.delayMs ?? 2000))
  );

  // ── Step 8: Print summary ─────────────────────────────────────────────────
  const base     = domain ? `https://${domain}` : `http://localhost:${apiPort}`;
  const expoBase = IS_REPLIT
    ? base                                          // Expo served behind API proxy on Replit
    : (expoDomain ? `https://${expoDomain}` : `http://localhost:${ajkPort}`);

  const pad = url => url.padEnd(44);

  console.log("");
  console.log(c.bold("╔══════════════════════════════════════════════════════════╗"));
  console.log(c.bold("║            AJKMart — all services running  ✓             ║"));
  console.log(c.bold("╠══════════════════════════════════════════════════════════╣"));
  console.log(`║  🌐 API          ${pad(base + "/api")} ║`);
  console.log(`║  🛠  Admin        ${pad(base + "/admin/")} ║`);
  console.log(`║  🏪 Vendor        ${pad(base + "/vendor/")} ║`);
  console.log(`║  🚴 Rider         ${pad(base + "/rider/")} ║`);
  console.log(`║  📱 Customer      ${pad(expoBase + "/")} ║`);
  console.log(`║  📋 API Docs      ${pad(base + "/api-docs/")} ║`);
  console.log(c.bold("╠══════════════════════════════════════════════════════════╣"));
  console.log(`║  Environment: ${c.cyan(ENV_NAME.padEnd(44))} ║`);
  if (IS_REPLIT) {
    console.log(`║  ${c.dim("Admin login: superadmin / Admin@123".padEnd(55))}║`);
  }
  console.log(c.bold("╚══════════════════════════════════════════════════════════╝"));
  console.log("");

  // Keep process alive (children are detached but we hold the terminal)
  await new Promise(() => {});
}

main().catch(e => { err(String(e)); process.exit(1); });
