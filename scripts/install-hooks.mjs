#!/usr/bin/env node
/**
 * install-hooks.mjs
 * Copies scripts/hooks/* into .git/hooks/ and marks them executable.
 * Runs automatically via the "prepare" lifecycle hook (pnpm install).
 * Safe to run multiple times (idempotent).
 */

import { copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const SRC_DIR   = path.join(ROOT, 'scripts/hooks');
const GIT_DIR   = path.join(ROOT, '.git');
const DEST_DIR  = path.join(GIT_DIR, 'hooks');

// ── Guard: only run inside a real git repo ────────────────────────────────────
if (!existsSync(GIT_DIR)) {
  console.log('[install-hooks] No .git directory found — skipping hook installation.');
  process.exit(0);
}

// ── Guard: hook source directory must exist ───────────────────────────────────
if (!existsSync(SRC_DIR)) {
  console.log('[install-hooks] scripts/hooks/ not found — nothing to install.');
  process.exit(0);
}

mkdirSync(DEST_DIR, { recursive: true });

let installed = 0;
let skipped   = 0;

for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
  if (!entry.isFile()) continue;

  const src  = path.join(SRC_DIR,  entry.name);
  const dest = path.join(DEST_DIR, entry.name);

  // If a hook already exists and was NOT installed by us, warn but don't overwrite
  if (existsSync(dest)) {
    try {
      const existing = (await import('node:fs')).readFileSync(dest, 'utf8');
      if (!existing.includes('AJKMart pre-commit hook')) {
        console.warn(`[install-hooks] Skipping ${entry.name} — a custom hook already exists at ${dest}`);
        skipped++;
        continue;
      }
    } catch { /* can't read — overwrite */ }
  }

  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`[install-hooks] Installed ${entry.name} → .git/hooks/${entry.name}`);
  installed++;
}

if (installed === 0 && skipped === 0) {
  console.log('[install-hooks] All hooks already up to date.');
} else if (skipped > 0) {
  console.log(`[install-hooks] ${skipped} hook(s) skipped (custom hooks present — install manually if needed).`);
}
