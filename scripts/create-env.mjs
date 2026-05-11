#!/usr/bin/env node
/**
 * AJKMart — create-env
 * ─────────────────────
 * Generates fresh cryptographically-strong secrets and rebuilds .env.enc
 * in a single command. Ideal for production deployments and secret rotation.
 *
 * Usage:
 *   node scripts/create-env.mjs [options]
 *
 * Options:
 *   --password <pw>   Encryption password (default: ENV_PASSWORD env var or Khan@123.com)
 *   --merge           Keep optional API keys from existing .env.enc (Twilio, Firebase, etc.)
 *   --write-env       Also write a plaintext .env file (⚠ never commit this)
 *   --dry-run         Preview what would be generated — no files written
 *   --force           Skip the confirmation prompt
 *   --help            Show this help
 *
 * Examples:
 *   node scripts/create-env.mjs                        # fresh secrets, default password
 *   node scripts/create-env.mjs --merge                # fresh JWT secrets, keep API keys
 *   node scripts/create-env.mjs --password MyP@ss --merge --write-env
 *   ENV_PASSWORD=MyP@ss node scripts/create-env.mjs --force
 */

import {
  createCipheriv, createDecipheriv,
  randomBytes, scryptSync,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const ENC_FILE  = path.join(ROOT, '.env.enc');
const ENV_FILE  = path.join(ROOT, '.env');
const ALGORITHM = 'aes-256-gcm';
const ENC_SALT  = Buffer.from('AJKMart-Env-Salt-2024-v1', 'utf8');

// ── Colours ───────────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};
const col  = (code, s) => `${code}${s}${c.reset}`;
const ok   = s => console.log(col(c.green,  `  ✓  ${s}`));
const warn = s => console.log(col(c.yellow, `  ⚠  ${s}`));
const info = s => console.log(col(c.blue,   `  ℹ  ${s}`));
const dim  = s => console.log(col(c.dim,    `     ${s}`));
const die  = s => { console.error(col(c.red, `  ✗  ${s}`)); process.exit(1); };

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const hasFlag  = f  => args.includes(f);
const flagVal  = f  => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
${col(c.bold, 'AJKMart create-env')} — generate fresh secrets and rebuild .env.enc

${col(c.cyan, 'USAGE')}
  node scripts/create-env.mjs [options]

${col(c.cyan, 'OPTIONS')}
  ${col(c.green, '--password <pw>')}   Encryption password (default: ENV_PASSWORD or Khan@123.com)
  ${col(c.green, '--merge')}           Preserve optional API keys from existing .env.enc
  ${col(c.green, '--write-env')}       Also write plaintext .env  (⚠ never commit!)
  ${col(c.green, '--dry-run')}         Preview only — no files written
  ${col(c.green, '--force')}           Skip confirmation prompt
  ${col(c.green, '--help')}            Show this message

${col(c.cyan, 'EXAMPLES')}
  node scripts/create-env.mjs
  node scripts/create-env.mjs --merge
  node scripts/create-env.mjs --password "MyP@ss" --merge --write-env
  ENV_PASSWORD=MyP@ss node scripts/create-env.mjs --force
`);
  process.exit(0);
}

const OPT_MERGE     = hasFlag('--merge');
const OPT_WRITE_ENV = hasFlag('--write-env');
const OPT_DRY_RUN   = hasFlag('--dry-run');
const OPT_FORCE     = hasFlag('--force');
const PASSWORD      = flagVal('--password') || process.env.ENV_PASSWORD || 'Khan@123.com';

// ── Secrets to ALWAYS regenerate ─────────────────────────────────────────────
const JWT_SECRET_KEYS = [
  'JWT_SECRET',
  'ADMIN_JWT_SECRET',
  'ADMIN_ACCESS_TOKEN_SECRET',
  'ADMIN_REFRESH_TOKEN_SECRET',
  'ADMIN_CSRF_SECRET',
  'ADMIN_REFRESH_SECRET',
  'ADMIN_SECRET',
  'VENDOR_JWT_SECRET',
  'RIDER_JWT_SECRET',
  'ENCRYPTION_MASTER_KEY',
  'ERROR_REPORT_HMAC_SECRET',
];

// ── Optional API keys to PRESERVE when --merge ────────────────────────────────
const OPTIONAL_API_KEYS = [
  'GEMINI_API_KEY',
  'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
  'SENDGRID_API_KEY', 'SMTP_HOST',
  'GOOGLE_MAPS_API_KEY', 'OSRM_API_URL',
  'REDIS_URL', 'SENTRY_DSN', 'SENTRY_WEBHOOK_SECRET',
  'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_CONTACT_EMAIL',
  'STORAGE_BUCKET_URL', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY',
  'STORAGE_BUCKET_NAME', 'STORAGE_ENDPOINT', 'STORAGE_REGION',
  'VITE_TURN_SERVER_URL', 'VITE_TURN_USERNAME', 'VITE_TURN_CREDENTIAL',
  'ALLOWED_DOMAINS', 'DB_POOL_MAX',
];

// ── Non-secret config defaults ────────────────────────────────────────────────
const CONFIG_DEFAULTS = {
  DATABASE_URL:                    'postgresql://postgres:postgres@localhost:5432/ajkmart',
  ADMIN_SEED_USERNAME:             'superadmin',
  ADMIN_SEED_PASSWORD:             'Admin@123',
  ADMIN_SEED_EMAIL:                'admin@ajkmart.com',
  ADMIN_SEED_NAME:                 'Super Admin',
  PORT:                            '5000',
  PORT_FALLBACK_ENABLE:            'true',
  PORT_MAX_RETRIES:                '10',
  ADMIN_DEV_PORT:                  '3000',
  ADMIN_PORT_OVERRIDE:             '3000',
  VENDOR_DEV_PORT:                 '3002',
  RIDER_DEV_PORT:                  '3003',
  APP_BASE_URL:                    'http://localhost:5000',
  ADMIN_BASE_URL:                  'http://localhost:3000',
  FRONTEND_URL:                    'http://localhost:3000,http://localhost:3002,http://localhost:3003,http://localhost:19006',
  CLIENT_URL:                      'http://localhost:4200',
  ALLOWED_ORIGINS:                 'http://localhost:3000,http://localhost:3002,http://localhost:3003,http://localhost:19006,http://localhost:5000',
  ADMIN_LEGACY_AUTH_DISABLED:      '0',
  ADMIN_PASSWORD_RESET_TOKEN_TTL_MIN: '15',
  LOG_LEVEL:                       'debug',
  NODE_ENV:                        'development',
  JWT_ISSUER:                      'ajkmart-dev',
  EXPO_PUBLIC_DOMAIN:              'localhost:5000',
  VITE_API_BASE_URL:               'http://localhost:5000',
  VITE_API_PROXY_TARGET:           'http://127.0.0.1:5000',
};

// ── Optional key empty defaults ───────────────────────────────────────────────
const OPTIONAL_DEFAULTS = Object.fromEntries(OPTIONAL_API_KEYS.map(k => [k, '']));

// ── Crypto helpers ────────────────────────────────────────────────────────────
function deriveKey(password) {
  return scryptSync(password, ENC_SALT, 32);
}

function encryptData(plaintext, password) {
  const key    = deriveKey(password);
  const iv     = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let enc      = cipher.update(plaintext, 'utf8', 'hex');
  enc         += cipher.final('hex');
  return {
    encrypted: enc,
    iv:        iv.toString('hex'),
    authTag:   cipher.getAuthTag().toString('hex'),
  };
}

function decryptData(payload, password) {
  const key      = deriveKey(password);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  let dec  = decipher.update(payload.encrypted, 'hex', 'utf8');
  dec     += decipher.final('utf8');
  return dec;
}

function loadExistingEnc(password) {
  if (!existsSync(ENC_FILE)) return null;
  try {
    const raw     = JSON.parse(readFileSync(ENC_FILE, 'utf8'));
    const plain   = decryptData(raw, password);
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

// ── Secret generation ─────────────────────────────────────────────────────────
function genSecret(bytes = 64) {
  return randomBytes(bytes).toString('hex');
}

// ── Readline confirm ──────────────────────────────────────────────────────────
function confirm(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log(col(c.bold, '╔══════════════════════════════════════════════════════════╗'));
  console.log(col(c.bold, '║          AJKMart  create-env  — Secret Generator         ║'));
  console.log(col(c.bold, '╚══════════════════════════════════════════════════════════╝'));
  console.log('');

  if (OPT_DRY_RUN) warn('DRY RUN — no files will be written');
  if (OPT_MERGE)   info('--merge: optional API keys will be preserved from existing .env.enc');

  // ── Step 1: Load existing enc for merge ─────────────────────────────────────
  let existing = null;
  if (OPT_MERGE && existsSync(ENC_FILE)) {
    existing = loadExistingEnc(PASSWORD);
    if (existing) {
      ok(`Loaded existing .env.enc (${Object.keys(existing).length} vars) for merge`);
    } else {
      warn('Could not decrypt existing .env.enc — optional API keys will be empty');
    }
  }

  // ── Step 2: Generate fresh JWT/security secrets ──────────────────────────────
  console.log('');
  console.log(col(c.bold, '  Generating secrets…'));

  const freshSecrets = {};
  for (const key of JWT_SECRET_KEYS) {
    // ENCRYPTION_MASTER_KEY only needs 32 bytes (used as AES key), rest get 64
    const bytes = key === 'ENCRYPTION_MASTER_KEY' ? 32 : 64;
    freshSecrets[key] = genSecret(bytes);
  }

  // ── Step 3: Build complete env object ───────────────────────────────────────
  // Priority: freshSecrets > existing config (--merge) > CONFIG_DEFAULTS
  const configLayer   = OPT_MERGE && existing
    ? { ...CONFIG_DEFAULTS, ...pickKeys(existing, Object.keys(CONFIG_DEFAULTS)) }
    : { ...CONFIG_DEFAULTS };

  const optionalLayer = OPT_MERGE && existing
    ? { ...OPTIONAL_DEFAULTS, ...pickKeys(existing, OPTIONAL_API_KEYS) }
    : { ...OPTIONAL_DEFAULTS };

  const finalEnv = {
    ...configLayer,
    ...optionalLayer,
    ...freshSecrets,    // always last — new secrets override everything
  };

  // ── Step 4: Confirmation prompt ──────────────────────────────────────────────
  if (!OPT_DRY_RUN && !OPT_FORCE) {
    console.log('');
    if (existsSync(ENC_FILE)) {
      warn(`This will OVERWRITE the existing .env.enc`);
      warn(`Old secrets will be backed up to .env.enc.bak`);
    }
    const answer = await confirm(
      col(c.yellow, `  Continue? (yes/no): `)
    );
    if (!['yes', 'y'].includes(answer)) {
      info('Aborted — no files changed.');
      process.exit(0);
    }
  }

  // ── Step 5: Print what was generated ────────────────────────────────────────
  console.log('');
  console.log(col(c.bold, '  Generated secrets (first 16 chars shown):'));
  for (const key of JWT_SECRET_KEYS) {
    const val = freshSecrets[key];
    console.log(`  ${col(c.cyan, key.padEnd(35))} ${col(c.green, val.slice(0, 16))}…`);
  }

  if (OPT_MERGE && existing) {
    const preserved = OPTIONAL_API_KEYS.filter(k => existing[k] && existing[k].trim() !== '');
    if (preserved.length > 0) {
      console.log('');
      console.log(col(c.bold, '  Preserved from existing .env.enc:'));
      for (const key of preserved) {
        const val = existing[key];
        const preview = val.length > 12 ? val.slice(0, 6) + '…' + val.slice(-4) : '***';
        console.log(`  ${col(c.blue, key.padEnd(35))} ${col(c.dim, preview)}`);
      }
    }
  }

  // ── Step 6: Write files ──────────────────────────────────────────────────────
  if (!OPT_DRY_RUN) {
    // Backup existing .env.enc
    if (existsSync(ENC_FILE)) {
      const backupPath = ENC_FILE + '.bak';
      renameSync(ENC_FILE, backupPath);
      dim(`Backed up old .env.enc → .env.enc.bak`);
    }

    // Write new .env.enc
    const payload = encryptData(JSON.stringify(finalEnv, null, 2), PASSWORD);
    writeFileSync(ENC_FILE, JSON.stringify(payload, null, 2));
    ok(`.env.enc written (${Object.keys(finalEnv).length} variables)`);

    // Self-validate
    try {
      const raw     = JSON.parse(readFileSync(ENC_FILE, 'utf8'));
      const decoded = JSON.parse(decryptData(raw, PASSWORD));
      const mismatch = JWT_SECRET_KEYS.find(k => decoded[k] !== freshSecrets[k]);
      if (mismatch) throw new Error(`Secret mismatch for ${mismatch}`);
      ok(`Self-validation passed — decrypt confirmed`);
    } catch (e) {
      die(`Self-validation FAILED: ${e.message}`);
    }

    // Optionally write .env
    if (OPT_WRITE_ENV) {
      if (existsSync(ENV_FILE)) {
        renameSync(ENV_FILE, ENV_FILE + '.bak');
        dim(`Backed up old .env → .env.bak`);
      }
      const lines = Object.entries(finalEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      writeFileSync(ENV_FILE, lines);
      ok(`.env written`);
      warn('.env contains plaintext secrets — add it to .gitignore, never commit it!');
    }
  } else {
    console.log('');
    info(`Dry run complete — ${Object.keys(finalEnv).length} variables would be written to .env.enc`);
  }

  // ── Step 7: Summary ──────────────────────────────────────────────────────────
  console.log('');
  console.log(col(c.bold, '╔══════════════════════════════════════════════════════════╗'));
  if (OPT_DRY_RUN) {
    console.log(col(c.bold, '║  Dry run complete — no files written                     ║'));
  } else {
    console.log(col(c.bold, '║  Done! Next steps:                                       ║'));
    console.log(col(c.bold, '║                                                          ║'));
    console.log(col(c.bold, '║  Replit:                                                 ║'));
    console.log(col(c.bold, '║    Secrets are in Replit panel — just press Run          ║'));
    console.log(col(c.bold, '║                                                          ║'));
    console.log(col(c.bold, '║  Codespaces / Local:                                     ║'));
    console.log(col(c.bold, `║    Password: ${PASSWORD.padEnd(43)}║`));
    console.log(col(c.bold, '║    Run: pnpm run start:all                               ║'));
    console.log(col(c.bold, '║                                                          ║'));
    console.log(col(c.bold, '║  Production — update these in your secrets panel:        ║'));
    for (const key of JWT_SECRET_KEYS) {
      const short = `  ${key}=${freshSecrets[key]}`;
      if (short.length <= 56) {
        console.log(col(c.dim, `║${short.padEnd(58)}║`));
      }
    }
  }
  console.log(col(c.bold, '╚══════════════════════════════════════════════════════════╝'));
  console.log('');
}

// ── Utility ───────────────────────────────────────────────────────────────────
function pickKeys(obj, keys) {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}

main().catch(e => { die(`Unexpected error: ${e.message}`); });
