#!/usr/bin/env node
/**
 * AJKMart — audit-secrets
 * ────────────────────────
 * Three-phase secret health audit:
 *
 *   Phase A — Env var completeness
 *     Checks every required secret is present in the current environment,
 *     flags dev placeholder values, and warns on missing optional keys.
 *
 *   Phase B — Rotation staleness
 *     Reads .env.enc mtime to determine days since last rotation.
 *     If .env.enc.bak exists, decrypts both files and compares values
 *     key-by-key so you can see exactly which secrets were unchanged.
 *
 *   Phase C — Hardcoded secret scan
 *     Walks artifacts/ and lib/ source files looking for:
 *       • JWT tokens (eyJ…) embedded in source
 *       • Known dev-placeholder hex values outside their definition file
 *       • Long secret-like literals assigned to secret-named variables
 *       • High-entropy base64/alphanumeric strings in secret contexts
 *     Lines annotated with  // audit-ok  are silently skipped.
 *
 * Usage:
 *   node scripts/audit-secrets.mjs [options]
 *   pnpm audit-secrets
 *
 * Options:
 *   --days <N>        Rotation age threshold in days (default: 90)
 *   --password <pw>   .env.enc password (default: ENV_PASSWORD or Khan@123.com)
 *   --no-scan         Skip Phase C (hardcoded scan)
 *   --no-env          Skip Phase A (env check)
 *   --no-rotation     Skip Phase B (rotation age)
 *   --json            Print final summary as JSON (for CI)
 *   --help            Show this message
 */

import { createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
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
const col  = (code, s) => `${code}${s}${C.reset}`;
const bold = s => col(C.bold, s);
const dim  = s => col(C.dim,  s);

// ── CLI ───────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const hasFlag   = f => args.includes(f);
const flagVal   = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
${bold('AJKMart audit-secrets')} — three-phase secret health audit

${col(C.cyan, 'USAGE')}
  node scripts/audit-secrets.mjs [options]
  pnpm audit-secrets

${col(C.cyan, 'OPTIONS')}
  ${col(C.green, '--days <N>')}       Warn if secrets not rotated in N days (default: 90)
  ${col(C.green, '--password <pw>')}  .env.enc password (default: ENV_PASSWORD or Khan@123.com)
  ${col(C.green, '--no-scan')}        Skip Phase C hardcoded secret scan
  ${col(C.green, '--no-env')}         Skip Phase A env var check
  ${col(C.green, '--no-rotation')}    Skip Phase B rotation age check
  ${col(C.green, '--staged')}         Phase C only scans git-staged files (used by pre-commit hook)
  ${col(C.green, '--json')}           Emit summary as JSON (for CI integration)
  ${col(C.green, '--help')}           Show this message
`);
  process.exit(0);
}

const ROTATION_DAYS_THRESHOLD = parseInt(flagVal('--days') || '90', 10);
const PASSWORD                = flagVal('--password') || process.env.ENV_PASSWORD || 'Khan@123.com';
const SKIP_SCAN               = hasFlag('--no-scan');
const SKIP_ENV                = hasFlag('--no-env');
const SKIP_ROTATION           = hasFlag('--no-rotation');
const STAGED_MODE             = hasFlag('--staged');
const JSON_OUTPUT             = hasFlag('--json');

// ── Variable lists ────────────────────────────────────────────────────────────
const CRITICAL_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ENCRYPTION_MASTER_KEY',
];
const JWT_SECRET_VARS = [
  'JWT_SECRET', 'ADMIN_JWT_SECRET',
  'ADMIN_ACCESS_TOKEN_SECRET', 'ADMIN_REFRESH_TOKEN_SECRET',
  'ADMIN_CSRF_SECRET', 'ADMIN_REFRESH_SECRET', 'ADMIN_SECRET',
  'VENDOR_JWT_SECRET', 'RIDER_JWT_SECRET',
  'ENCRYPTION_MASTER_KEY', 'ERROR_REPORT_HMAC_SECRET',
];
const IMPORTANT_VARS = [
  'ADMIN_JWT_SECRET', 'ADMIN_ACCESS_TOKEN_SECRET',
  'ADMIN_REFRESH_TOKEN_SECRET', 'ADMIN_CSRF_SECRET',
  'ERROR_REPORT_HMAC_SECRET',
];
const OPTIONAL_VARS = [
  'REDIS_URL', 'SENDGRID_API_KEY', 'TWILIO_ACCOUNT_SID',
  'VAPID_PUBLIC_KEY', 'GOOGLE_MAPS_API_KEY', 'SENTRY_DSN',
  'FIREBASE_PROJECT_ID', 'STORAGE_BUCKET_URL', 'GEMINI_API_KEY',
];

/** Dev placeholder values — these must NOT appear in production env */
const DEV_PLACEHOLDER_SECRETS = new Set([
  '70d7bbb271fc1cf1a6397e8407153c9212f0e27c4b1b38c3f56ec08701718bc3849fe94eebaaed82f47d1cd93830ca7fe3255983484582511c8860cbec76f7cb',
  '0bf96d92374ef22e78a01b29ee69c0356a06e30e3e194c75fa2458704d296412833291a297210a3b6037fc99e5f1c1117b0b8b8c358ff9aa9561c8aa3029b186',
  'e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4b7c0d3e6f9a2b5c8d1e4f7a0b3c6d9e2',
  'f9a2b5c8d1e4f7a0b3c6d9e2f5a8b1c4d7e0f3a6b9c2d5e8f1a4b7c0d3e6f9',
]);

/**
 * Files that are explicitly allowed to contain dev-placeholder values
 * (they define them, not use them).
 */
const SCAN_ALLOWLIST_FILES = new Set([
  path.join(ROOT, 'artifacts/api-server/src/index.ts'),
  path.join(ROOT, 'scripts/audit-secrets.mjs'),
]);

// ── Crypto helpers ────────────────────────────────────────────────────────────
const ENC_SALT = Buffer.from('AJKMart-Env-Salt-2024-v1', 'utf8');

function decryptEnc(filePath, password) {
  try {
    const raw  = JSON.parse(readFileSync(filePath, 'utf8'));
    const key  = scryptSync(password, ENC_SALT, 32);
    const dc   = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'hex'));
    dc.setAuthTag(Buffer.from(raw.authTag, 'hex'));
    let d  = dc.update(raw.encrypted, 'hex', 'utf8');
    d     += dc.final('utf8');
    return JSON.parse(d);
  } catch { return null; }
}

// ── Entropy ───────────────────────────────────────────────────────────────────
function shannonEntropy(str) {
  const freq = {};
  for (const c of str) freq[c] = (freq[c] || 0) + 1;
  const len = str.length;
  return -Object.values(freq).reduce((sum, count) => {
    const p = count / len;
    return sum + p * Math.log2(p);
  }, 0);
}

/** True if a string looks like a random secret (not a URL, path, etc.) */
function looksLikeSecret(s) {
  if (s.startsWith('http') || s.startsWith('/') || s.includes('{{')) return false;
  if (s.split('.').length > 3 && !s.startsWith('eyJ')) return false; // likely a domain/path
  const isHex    = /^[0-9a-f]+$/i.test(s);
  const isBase64 = /^[A-Za-z0-9+/=_-]+$/.test(s);
  if (isHex && s.length >= 40) return true;
  if (isBase64 && s.length >= 32 && shannonEntropy(s) >= 4.2) return true;
  if (s.startsWith('eyJ')) return true; // JWT header
  return false;
}

// ── Scanner ───────────────────────────────────────────────────────────────────
const SCAN_DIRS   = ['artifacts', 'lib', 'scripts'].map(d => path.join(ROOT, d));
const SKIP_DIRS   = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '__snapshots__']);
const SKIP_EXTS   = new Set(['.d.ts', '.map', '.snap', '.png', '.jpg', '.ico', '.svg', '.woff', '.ttf']);
const SCAN_EXTS   = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml', '.sh', '.env.example']);
const SKIP_SUFFIX = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.d.ts'];

/** Keywords that, when adjacent to a string literal, suggest it is a secret */
const SECRET_KEYWORDS_RE = /\b(secret|password|passwd|token|api_?key|private_?key|auth_?key|credentials?|hmac|salt|signing)\b/i;
/** Variable / property names that strongly imply the value is a secret */
const SECRET_VAR_RE      = /(SECRET|_TOKEN|_KEY|PASSWORD|CREDENTIAL|PRIVATE_KEY|_HMAC|_SALT)\s*[=:]\s*/;

/** Matches a single-quoted or double-quoted string literal (simplified) */
const STRING_LITERAL_RE  = /["']([^"'\r\n]{20,})["']/g;

/** JWT token embedded in source */
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

function* walkFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkFiles(full);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (SKIP_EXTS.has(e.name.includes('.d.ts') ? '.d.ts' : ext)) continue;
      if (SKIP_SUFFIX.some(s => e.name.endsWith(s))) continue;
      if (!SCAN_EXTS.has(ext) && !e.name.endsWith('.env.example')) continue;
      // Skip binary-looking files by checking size
      try {
        if (statSync(full).size > 500_000) continue; // skip large generated files
      } catch { continue; }
      yield full;
    }
  }
}

/** Scan a single file, return array of findings */
function scanFile(filePath) {
  const findings = [];
  let lines;
  try {
    lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch { return findings; }

  const relPath = path.relative(ROOT, filePath);
  const isAllowlisted = SCAN_ALLOWLIST_FILES.has(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Respect suppression comment
    if (/\/\/\s*(audit-ok|nosec|audit-ignore)/i.test(line)) continue;

    // ── JWT tokens ────────────────────────────────────────────────────────────
    JWT_RE.lastIndex = 0;
    const jwtMatch = JWT_RE.exec(line);
    if (jwtMatch) {
      findings.push({
        severity: 'CRITICAL',
        rule:     'jwt-in-source',
        file:     relPath,
        line:     lineNum,
        snippet:  line.trim().slice(0, 120),
        detail:   'JWT token found hardcoded in source code',
      });
      continue;
    }

    // ── Known dev-placeholder values ──────────────────────────────────────────
    if (!isAllowlisted) {
      for (const placeholder of DEV_PLACEHOLDER_SECRETS) {
        if (line.includes(placeholder)) {
          findings.push({
            severity: 'CRITICAL',
            rule:     'dev-placeholder-in-source',
            file:     relPath,
            line:     lineNum,
            snippet:  line.trim().slice(0, 120),
            detail:   'Known dev-placeholder secret value found outside its definition file',
          });
          break;
        }
      }
    }

    // ── Secret-like literal near secret-named variable ────────────────────────
    if (SECRET_VAR_RE.test(line) && !line.trimStart().startsWith('//') && !line.includes('process.env')) {
      STRING_LITERAL_RE.lastIndex = 0;
      let m;
      while ((m = STRING_LITERAL_RE.exec(line)) !== null) {
        const val = m[1];
        if (looksLikeSecret(val)) {
          // Skip if it's clearly a key name placeholder like 'YOUR_API_KEY_HERE'
          if (/YOUR|EXAMPLE|PLACEHOLDER|CHANGEME|FIXME|TODO|xxx/i.test(val)) continue;
          findings.push({
            severity: 'HIGH',
            rule:     'secret-literal-assignment',
            file:     relPath,
            line:     lineNum,
            snippet:  line.trim().slice(0, 120),
            detail:   `Possible secret literal (${val.length} chars) assigned to secret-named variable`,
          });
        }
      }
    }

    // ── High-entropy string near secret keyword (context check) ──────────────
    if (SECRET_KEYWORDS_RE.test(line) && !line.includes('process.env') && !line.trimStart().startsWith('//')) {
      STRING_LITERAL_RE.lastIndex = 0;
      let m;
      while ((m = STRING_LITERAL_RE.exec(line)) !== null) {
        const val = m[1];
        if (val.length < 32) continue;
        const isHex = /^[0-9a-f]+$/i.test(val);
        if (isHex) continue; // handled above with context check
        const ent = shannonEntropy(val);
        if (ent >= 4.5 && looksLikeSecret(val)) {
          if (/YOUR|EXAMPLE|PLACEHOLDER|CHANGEME|FIXME|TODO|xxx/i.test(val)) continue;
          findings.push({
            severity: 'HIGH',
            rule:     'high-entropy-string',
            file:     relPath,
            line:     lineNum,
            snippet:  line.trim().slice(0, 120),
            detail:   `High-entropy string (ent=${ent.toFixed(2)}, len=${val.length}) near secret keyword`,
          });
        }
      }
    }
  }
  return findings;
}

// ── Report helpers ────────────────────────────────────────────────────────────
function severityColour(sev) {
  if (sev === 'CRITICAL') return col(C.red,    `[CRITICAL]`);
  if (sev === 'HIGH')     return col(C.yellow, `[HIGH]    `);
  if (sev === 'WARN')     return col(C.yellow, `[WARN]    `);
  if (sev === 'PASS')     return col(C.green,  `[PASS]    `);
  return                         col(C.blue,   `[INFO]    `);
}

function dayStr(d) {
  return d === 1 ? '1 day' : `${d} days`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const totals = { critical: 0, high: 0, warn: 0, pass: 0 };
  const results = {};

  if (!JSON_OUTPUT) {
    console.log('');
    console.log(bold('╔══════════════════════════════════════════════════════════╗'));
    console.log(bold('║          AJKMart  audit-secrets                          ║'));
    console.log(bold('║          Secret health audit — three phases              ║'));
    console.log(bold('╚══════════════════════════════════════════════════════════╝'));
    console.log('');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PHASE A — Env var completeness
  ═══════════════════════════════════════════════════════════════════════════ */
  if (!SKIP_ENV) {
    if (!JSON_OUTPUT) console.log(bold('  Phase A — Environment variable completeness'));

    const envResults = { missing_critical: [], missing_important: [], missing_optional: [], placeholders: [] };

    // Critical
    for (const k of CRITICAL_VARS) {
      if (!process.env[k]) envResults.missing_critical.push(k);
    }
    // Important
    for (const k of IMPORTANT_VARS) {
      if (!process.env[k] && !envResults.missing_critical.includes(k)) {
        envResults.missing_important.push(k);
      }
    }
    // Optional
    for (const k of OPTIONAL_VARS) {
      if (!process.env[k]) envResults.missing_optional.push(k);
    }
    // Dev placeholders in current env
    for (const k of JWT_SECRET_VARS) {
      if (process.env[k] && DEV_PLACEHOLDER_SECRETS.has(process.env[k])) {
        envResults.placeholders.push(k);
      }
    }

    // ── Tally (runs regardless of output mode) ────────────────────────────────
    if (envResults.missing_critical.length === 0) { totals.pass++; }
    else { totals.critical += envResults.missing_critical.length; }

    if (envResults.missing_important.length > 0) { totals.high += envResults.missing_important.length; }
    else if (envResults.missing_critical.length === 0) { totals.pass++; }

    if (envResults.placeholders.length > 0) { totals.critical += envResults.placeholders.length; }
    else { totals.pass++; }

    // ── Display ───────────────────────────────────────────────────────────────
    if (!JSON_OUTPUT) {
      if (envResults.missing_critical.length === 0) {
        console.log(`  ${severityColour('PASS')} All critical secrets are set`);
      } else {
        for (const k of envResults.missing_critical) {
          console.log(`  ${severityColour('CRITICAL')} Missing critical var: ${col(C.red, k)}`);
        }
      }
      if (envResults.missing_important.length > 0) {
        for (const k of envResults.missing_important) {
          console.log(`  ${severityColour('HIGH')}    Missing important var: ${col(C.yellow, k)}`);
        }
      } else if (envResults.missing_critical.length === 0) {
        console.log(`  ${severityColour('PASS')} All JWT / auth secrets are set`);
      }
      if (envResults.placeholders.length > 0) {
        console.log(`  ${severityColour('CRITICAL')} Dev placeholder values detected in live env:`);
        for (const k of envResults.placeholders) {
          console.log(`              ${col(C.red, k)} — run ${col(C.cyan, 'pnpm rotate-secrets')} to replace`);
        }
      } else {
        console.log(`  ${severityColour('PASS')} No dev placeholder secrets in environment`);
      }
      if (envResults.missing_optional.length > 0) {
        console.log(`  ${severityColour('INFO')}    Optional vars not set (${envResults.missing_optional.length}): ${dim(envResults.missing_optional.join(', '))}`);
      }
    }
    results.env = envResults;
    console.log('');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PHASE B — Rotation staleness
  ═══════════════════════════════════════════════════════════════════════════ */
  if (!SKIP_ROTATION) {
    if (!JSON_OUTPUT) console.log(bold('  Phase B — Secret rotation staleness'));

    const encPath = path.join(ROOT, '.env.enc');
    const bakPath = path.join(ROOT, '.env.enc.bak');
    const rotationResults = { last_rotation_days: null, unchanged_keys: [], stale: false };

    if (!existsSync(encPath)) {
      if (!JSON_OUTPUT) console.log(`  ${severityColour('WARN')}    .env.enc not found — rotation age unknown`);
      totals.warn++;
    } else {
      const ageDays = Math.floor((Date.now() - statSync(encPath).mtimeMs) / (1000 * 60 * 60 * 24));
      rotationResults.last_rotation_days = ageDays;

      // ── Tally ──────────────────────────────────────────────────────────────
      if (ageDays > ROTATION_DAYS_THRESHOLD) { totals.warn++; rotationResults.stale = true; }
      else { totals.pass++; }

      // Compare with backup
      const bakUnchanged = [];
      let bakDecryptFailed = false;
      if (existsSync(bakPath)) {
        const current = decryptEnc(encPath, PASSWORD);
        const backup  = decryptEnc(bakPath, PASSWORD);
        if (current && backup) {
          const unchanged = JWT_SECRET_VARS.filter(k => current[k] && backup[k] && current[k] === backup[k]);
          rotationResults.unchanged_keys = unchanged;
          bakUnchanged.push(...unchanged);
          if (unchanged.length === 0) totals.pass++;
          else totals.warn += unchanged.length;
        } else {
          bakDecryptFailed = true;
        }
      }

      // Leftover .env.reload
      const reloadPath = path.join(ROOT, '.env.reload');
      const reloadStuck = existsSync(reloadPath);
      if (reloadStuck) totals.warn++;

      // ── Display ────────────────────────────────────────────────────────────
      if (!JSON_OUTPUT) {
        const ageStr = dayStr(ageDays);
        if (ageDays > ROTATION_DAYS_THRESHOLD) {
          console.log(`  ${severityColour('WARN')}    .env.enc last written ${col(C.yellow, ageStr)} ago — exceeds ${ROTATION_DAYS_THRESHOLD}-day threshold`);
        } else {
          console.log(`  ${severityColour('PASS')} .env.enc last written ${col(C.green, ageStr)} ago (threshold: ${ROTATION_DAYS_THRESHOLD} days)`);
        }
        if (existsSync(bakPath)) {
          if (bakDecryptFailed) {
            console.log(`  ${severityColour('INFO')}    .env.enc.bak exists but could not be decrypted — skipping comparison`);
          } else if (bakUnchanged.length === 0) {
            console.log(`  ${severityColour('PASS')} All secrets differ from .env.enc.bak — full rotation confirmed`);
          } else {
            console.log(`  ${severityColour('WARN')}    ${bakUnchanged.length} secret(s) unchanged vs .env.enc.bak:`);
            for (const k of bakUnchanged) console.log(`              ${col(C.yellow, k)}`);
          }
        } else {
          console.log(`  ${severityColour('INFO')}    No .env.enc.bak found — run ${col(C.cyan, 'pnpm rotate-secrets')} to create a rotation baseline`);
        }
        if (reloadStuck) {
          console.log(`  ${severityColour('WARN')}    .env.reload still present — rotation was triggered but server may not have restarted`);
        }
      }
    }
    results.rotation = rotationResults;
    if (!JSON_OUTPUT) console.log('');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PHASE C — Hardcoded secret scan
  ═══════════════════════════════════════════════════════════════════════════ */
  if (!SKIP_SCAN) {
    if (!JSON_OUTPUT) {
      const modeLabel = STAGED_MODE ? dim(' (staged files only)') : '';
      console.log(bold(`  Phase C — Hardcoded secret scan${modeLabel}`));
    }

    const scanFindings = [];
    let filesScanned   = 0;

    if (STAGED_MODE) {
      // ── Staged-file mode: only scan files in the git index ─────────────────
      const { execSync } = await import('node:child_process');
      let stagedOutput = '';
      try {
        stagedOutput = execSync(
          'git diff --cached --name-only --diff-filter=ACM',
          { encoding: 'utf8', cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
        );
      } catch { /* not a git repo or no staged files — scan nothing */ }

      const stagedPaths = stagedOutput
        .trim().split('\n').filter(Boolean)
        .map(f => path.join(ROOT, f))
        .filter(filePath => {
          const ext = path.extname(filePath);
          if (SKIP_SUFFIX.some(s => filePath.endsWith(s))) return false;
          if (!SCAN_EXTS.has(ext) && !filePath.endsWith('.env.example')) return false;
          try { return statSync(filePath).size < 500_000; } catch { return false; }
        });

      for (const filePath of stagedPaths) {
        filesScanned++;
        scanFindings.push(...scanFile(filePath));
      }
    } else {
      // ── Full scan: walk all configured source directories ──────────────────
      for (const dir of SCAN_DIRS) {
        if (!existsSync(dir)) continue;
        for (const filePath of walkFiles(dir)) {
          filesScanned++;
          scanFindings.push(...scanFile(filePath));
        }
      }
    }

    // ── Tally ────────────────────────────────────────────────────────────────
    const criticals = scanFindings.filter(f => f.severity === 'CRITICAL');
    const highs     = scanFindings.filter(f => f.severity === 'HIGH');
    if (scanFindings.length === 0) { totals.pass++; }
    else {
      totals.critical += criticals.length;
      totals.high     += highs.length;
    }

    // ── Display ──────────────────────────────────────────────────────────────
    if (!JSON_OUTPUT) {
      console.log(`  ${dim(`Scanned ${filesScanned} files`)}`);
      if (scanFindings.length === 0) {
        console.log(`  ${severityColour('PASS')} No hardcoded secrets detected`);
      } else {
        for (const f of scanFindings) {
          console.log(`  ${severityColour(f.severity)} ${col(C.cyan, f.file)}:${col(C.yellow, String(f.line))}`);
          console.log(`              ${dim('Rule:')} ${f.rule}  ${dim('—')} ${f.detail}`);
          console.log(`              ${dim('Code:')} ${dim(f.snippet)}`);
          console.log(`              ${dim('Fix: add  // audit-ok  to suppress a false positive')}`);
          console.log('');
        }
      }
    }
    results.scan = { files_scanned: filesScanned, findings: scanFindings };
    if (!JSON_OUTPUT) console.log('');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Summary
  ═══════════════════════════════════════════════════════════════════════════ */
  const hasIssues = totals.critical > 0 || totals.high > 0;
  const hasWarns  = totals.warn > 0;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ totals, results }, null, 2));
  } else {
    // Box width = 60 visible chars between ║ and ║ (including leading spaces)
    const W = 58; // visible chars between ║  prefix and  ║ suffix
    const box  = s => `${bold('║')}  ${s}  ${bold('║')}`;
    const pad  = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));

    const statusText    = hasIssues ? 'ISSUES FOUND' : hasWarns ? 'WARNINGS' : 'ALL CLEAR';
    const statusColored = hasIssues ? col(C.red, statusText) : hasWarns ? col(C.yellow, statusText) : col(C.green, statusText);

    console.log(bold('╔══════════════════════════════════════════════════════════╗'));
    console.log(box(pad(`Summary: ${statusColored}`, W + statusColored.length - statusText.length)));
    console.log(bold('╠══════════════════════════════════════════════════════════╣'));

    const critStr  = `Critical: ${totals.critical}`;
    const highStr  = `High: ${totals.high}`;
    const warnStr  = `Warn: ${totals.warn}`;
    const passStr  = `Pass: ${totals.pass}`;
    const statsRow = `${col(C.red, critStr)}   ${col(C.yellow, highStr)}   ${col(C.yellow, warnStr)}   ${col(C.green, passStr)}`;
    const statsVis = `${critStr}   ${highStr}   ${warnStr}   ${passStr}`;
    console.log(box(pad(statsRow, W + statsRow.length - statsVis.length)));
    console.log(bold('╠══════════════════════════════════════════════════════════╣'));

    const lines = hasIssues
      ? [
          col(C.red,    'Recommended actions:'),
          col(C.red,    '• pnpm rotate-secrets    (regenerate all JWT secrets)'),
          col(C.red,    '• Remove any hardcoded secrets found above'),
        ]
      : hasWarns
      ? [col(C.yellow, '• pnpm rotate-secrets    (refresh stale secrets)')]
      : [col(C.green,  'All checks passed. Run periodically (e.g. weekly).')];

    const rawLines = hasIssues
      ? ['Recommended actions:', '• pnpm rotate-secrets    (regenerate all JWT secrets)', '• Remove any hardcoded secrets found above']
      : hasWarns
      ? ['• pnpm rotate-secrets    (refresh stale secrets)']
      : ['All checks passed. Run periodically (e.g. weekly).'];

    for (let i = 0; i < lines.length; i++) {
      console.log(box(pad(lines[i], W + lines[i].length - rawLines[i].length)));
    }
    console.log(bold('╚══════════════════════════════════════════════════════════╝'));
    console.log('');
  }

  process.exit(hasIssues ? 1 : 0);
}

main().catch(e => {
  console.error(col(C.red, `Unexpected error: ${e.message}`));
  process.exit(1);
});
