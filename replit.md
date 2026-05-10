# AJKMart Super-App Monorepo

## Overview

AJKMart is a multi-service super-app platform designed for the AJK region of Pakistan. It integrates e-commerce, food delivery, ride-hailing, pharmacy services, parcel delivery, and inter-city transport into a single platform. The project aims to provide a robust, low-resource-friendly experience optimized for environments with slow networks and budget devices. The system comprises four user-facing applications (customer mobile/web, rider PWA, vendor portal, admin panel) supported by a Node.js API server and PostgreSQL database.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Monorepo Structure

The project is structured as a pnpm workspace monorepo, enforcing pnpm usage. It includes shared libraries for database schema, API client, validation, internationalization, integrations, phone utilities, and shared admin timing utilities, consumed by various deployable applications such as the API server, admin panel, rider app, vendor app, and customer super-app. TypeScript project references are used for efficient type-checking and build processes.

### Applications

1.  **api-server**: A Node.js/Express backend providing a unified API for all clients. It uses Drizzle ORM for database interactions, Zod for validation, and Socket.IO for real-time features.
2.  **admin**: A React + Vite application serving as the central administration panel, featuring a "Command Center" design with various modules for operations, inventory, finance, safety, and configuration.
3.  **rider-app**: A React + Vite PWA for riders, including mapping, GPS tracking, order/ride management, and financial features.
4.  **vendor-app**: A React + Vite application for vendors to manage products, inventory, and orders.
5.  **ajkmart**: An Expo / React Native customer super-app, supporting mobile and web builds, with features like biometrics, deep linking for authentication, and network-aware image loading.

### Backend Architecture

The backend leverages Express with Zod validation, JWT-based authentication, CSRF protection, rate limiting, and structured logging. Socket.IO facilitates real-time events. A multi-method authentication system supports Phone/Email OTP, Username/Password, OAuth, magic links, and TOTP 2FA, with methods togglable via platform configuration. It also uses Redis-backed rate limiting, Firebase admin services, Twilio, Nodemailer, web push, QR code generation, image processing, and AI integrations where needed. A hybrid wallet model manages commissions and rider balances, with atomic transactions for critical operations. A central platform configuration endpoint allows dynamic control over features, pricing, and service settings.

### Frontend Architecture

The customer app uses Expo, supporting lazy-loaded service modules that are toggled via feature flags in platform config. React Query is used for server state management with AsyncStorage persistence for offline resilience. The project supports trilingual internationalization (English/Urdu/Roman Urdu) via a shared library. A consistent design system is applied across applications, utilizing Lucide icons for web and Ionicons for Expo, with specific color palettes per application.

### Data Layer

PostgreSQL is the chosen database, with schema managed by Drizzle ORM. Drizzle Kit is used for migrations. The schema is organized by domain, covering users, orders, products, rides, wallets, platform settings, permissions, and integration-related data.

### Key Architectural Decisions

-   **Single API Server**: Chosen for simplicity, cost efficiency, and easier transaction consistency, suitable for the target regional scale.
-   **pnpm Workspace**: Preferred over more complex monorepo tools for its simplicity and sufficiency for project needs.
-   **Expo for Customer App**: Enables a single codebase for iOS/Android/Web, balancing native capabilities with web compatibility.
-   **Admin-Driven Configuration**: Most business logic and feature toggles are controllable via the admin panel, reducing the need for code redeploys.
-   **Manual Payment Verification**: Aligns with local payment habits and avoids initial gateway fees by supporting bank transfers with admin verification.
-   **Health Alert Monitor**: Background `setInterval` service (`healthAlertMonitor.ts`) runs health checks and sends email + Slack alerts for critical issues. Opt-in via `health_monitor_enabled=on` in platform settings. Deduplicates alerts using in-memory snooze tracking. Alert config visible on the Health Dashboard page (`/admin/health-dashboard`).

## Development Setup

> Full setup guide: see `setup.md` in the project root.

### Prerequisites
This is a pnpm workspace monorepo. All dependencies must be installed from the workspace root before starting any artifact.

```bash
pnpm install
```

### Workflows & Ports (Replit)
Each service runs as its own workflow. The API server at port 5000 also runs an Express dev-proxy that routes `/admin/`, `/rider/`, `/vendor/` to the sibling Vite apps.

| Workflow name | Preview path | Port |
|---|---|---|
| `Start application` | `/` (hub), `/api` | 5000 |
| `artifacts/admin: web` | `/admin/` | 23744 |
| `Rider App` | `/rider/` | 3003 |
| `Vendor App` | `/vendor/` | 3002 |
| `Ajkmart Customer App` | `/` (Expo web) | 4200 |

Port env vars: `PORT=5000` (API), `ADMIN_DEV_PORT=23744`, `RIDER_DEV_PORT=3003`, `VENDOR_DEV_PORT=3002`. Each Vite config reads its own specific env var first (e.g. `RIDER_DEV_PORT || PORT`) so apps don't fight over the global `PORT` value.

**Important — Replit port constraints:** Replit's workflow system only supports a fixed set of ports for `waitForPort` (3000–3003, 4200, 5000, 5173, 6000, 6800, 8000–9000). Port 23744 is outside this set, so the `artifacts/admin: web` workflow will show "failed" in Replit's UI even though the Vite process starts successfully on 23744. The admin panel is still accessible via the API server proxy at `/admin/`.

**All workflows run `pnpm install --frozen-lockfile` before starting their dev server**, so a fresh Repl environment will self-heal on first run without any manual install step.

### Shared Libraries
The monorepo contains shared libraries under `lib/` that are consumed by the artifacts via workspace `*` references:
- `@workspace/db` — Drizzle ORM schema and migration utilities
- `@workspace/api-client-react` — typed API client with React Query hooks
- `@workspace/api-spec` / `@workspace/api-zod` — Zod-validated API contracts
- `@workspace/i18n` — trilingual string catalogue (English / Urdu / Roman Urdu)
- `@workspace/service-constants` — shared enums, IDs, and feature flags
- `@workspace/auth-utils` — JWT helpers shared between server and clients
- `@workspace/admin-timing-shared` — time-slot utilities for the admin panel
- `@workspace/phone-utils` — phone number utilities and helpers
- `@workspace/integrations` — shared integration helpers and adapters
- `@workspace/integrations-gemini-ai` — Gemini AI integration utilities

### Environment Variables

All credentials and secrets are managed via **Replit Secrets** (the padlock icon in the sidebar) and `[userenv.shared]` in `.replit`. There is no encrypted `.env.enc` file or `env-manager` — secrets flow directly from Replit's secrets store into the process environment.

**Required secrets — add these in the Replit Secrets panel:**
- `DATABASE_URL` — PostgreSQL connection string (required)
- `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_REFRESH_SECRET`, `ADMIN_SECRET` — JWT signing keys
- `ADMIN_ACCESS_TOKEN_SECRET`, `ADMIN_REFRESH_TOKEN_SECRET`, `ADMIN_CSRF_SECRET` — Admin auth
- `VENDOR_JWT_SECRET`, `RIDER_JWT_SECRET` — App-specific JWT keys
- `ERROR_REPORT_HMAC_SECRET` — HMAC signing for error reports

**Optional API keys — add in Replit Secrets when needed:**
- `GEMINI_API_KEY` — Gemini AI features
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — Push notifications
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — SMS OTP
- `SENDGRID_API_KEY` — Email delivery
- `GOOGLE_MAPS_API_KEY` — Maps features
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTACT_EMAIL` — Web push
- `REDIS_URL` — Redis for rate-limiting
- `SENTRY_DSN` — Error tracking

**API server first-run check:** `artifacts/api-server/src/index.ts` runs `checkEnv()` on boot — shows a banner with exact fix commands if `DATABASE_URL` or `JWT_SECRET` are missing. Fatal in production, warning in development.

**Frontend dev warnings:** Admin, Vendor, and Rider apps log a `console.group` warning in dev mode if `VITE_API_PROXY_TARGET` is not set.

**Secrets with dev placeholder values (must replace before production):**
The following JWT secrets have development placeholder values set in `userenv.shared`. They are safe for local dev but **must be replaced with strong, unique random values before any production deployment**:
- `ADMIN_REFRESH_SECRET` — used to sign admin refresh tokens
- `ADMIN_SECRET` — used for admin session signing
- `VENDOR_JWT_SECRET` — used to sign vendor app JWTs
- `RIDER_JWT_SECRET` — used to sign rider app JWTs
- `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_ACCESS_TOKEN_SECRET`, `ADMIN_REFRESH_TOKEN_SECRET`, `ADMIN_CSRF_SECRET`, `ERROR_REPORT_HMAC_SECRET` — already present in `userenv.shared` with dev placeholders

Generate production values with: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`

**Required variables (50 total):**
| Category | Variables |
|---|---|
| Database | `DATABASE_URL` |
| JWT / Auth | `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_REFRESH_SECRET`, `ADMIN_SECRET`, `ADMIN_ACCESS_TOKEN_SECRET`, `ADMIN_REFRESH_TOKEN_SECRET`, `ADMIN_CSRF_SECRET`, `VENDOR_JWT_SECRET`, `RIDER_JWT_SECRET`, `JWT_ISSUER` |
| Admin Seed | `ADMIN_SEED_USERNAME`, `ADMIN_SEED_PASSWORD`, `ADMIN_SEED_EMAIL`, `ADMIN_SEED_NAME` |
| Security | `ERROR_REPORT_HMAC_SECRET`, `ALLOWED_ORIGINS`, `ADMIN_LEGACY_AUTH_DISABLED`, `ADMIN_PASSWORD_RESET_TOKEN_TTL_MIN` |
| Ports & URLs | `PORT` (5000), `APP_BASE_URL`, `ADMIN_BASE_URL`, `FRONTEND_URL`, `CLIENT_URL`, `PORT_FALLBACK_ENABLE`, `PORT_MAX_RETRIES` |
| Firebase | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` |
| Twilio / SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` |
| Email | `SENDGRID_API_KEY`, `SMTP_HOST` |
| AI | `GEMINI_API_KEY` |
| Maps | `GOOGLE_MAPS_API_KEY`, `OSRM_API_URL` |
| Push (VAPID) | `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_CONTACT_EMAIL` |
| Infrastructure | `REDIS_URL`, `SENTRY_DSN` |
| Runtime | `NODE_ENV`, `LOG_LEVEL` |
| Expo / Vite | `EXPO_PUBLIC_DOMAIN`, `VITE_API_BASE_URL`, `VITE_API_PROXY_TARGET` |
| WebRTC / TURN | `VITE_TURN_SERVER_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` |

### Security & Observability (Task #1 hardening — 2025)

| Area | What changed |
|---|---|
| **JWT** | `ACCESS_TOKEN_TTL_SEC` reduced 3600→900 (15 min); `REFRESH_TOKEN_TTL_DAYS` reduced 90→7. `signAccessToken()` now embeds a `jti` UUID. `blacklistJti()` / `isJtiBlacklisted()` in `security.ts` use Redis to blacklist tokens on logout. |
| **Rate limiting** | `loginLimiter` (5/60s/IP) applied to `/auth/login` and `/auth/login/username`. `otpLimiter` (3/60s/phone) applied to `/auth/send-otp` and `/auth/verify-otp`. `userApiLimiter` (100/60s/user) available for authenticated routes. |
| **CORS** | `ALLOWED_ORIGINS` env var is the primary source (comma-separated). Falls back to `FRONTEND_URL`, `CLIENT_URL`, `ADMIN_BASE_URL` for backward compatibility. |
| **Request logging** | `pino-http` logs every request/response with `x-request-id` header (UUID, propagated as response header). |
| **Body limit** | Global JSON body limit reduced 256 KB→10 KB (error-report route handles its own larger limit). |
| **Sentry** | Optional — set `SENTRY_DSN` secret to enable. Install `@sentry/node` first: `pnpm --filter @workspace/api-server add @sentry/node`. |
| **Health endpoint** | `/api/health` now checks Redis (2-second timeout) and returns `{ status, db, redis, uptime, timestamp }`. Returns HTTP 503 when DB is down. |
| **PII encryption** | `artifacts/api-server/src/lib/crypto/encryption.ts` — AES-256-GCM helpers. Requires `ENCRYPTION_MASTER_KEY` secret (min 16 chars). Columns not yet migrated — add `ALTER TABLE ... ADD COLUMN encrypted_* TEXT;` and migrate data when ready. |
| **Cursor pagination** | `artifacts/api-server/src/lib/pagination/cursor.ts` — `buildCursorPage()` / `encodeCursor()` / `decodeCursor()` utilities. |
| **Ownership guard** | `artifacts/api-server/src/middleware/verifyOwnership.ts` — `verifyOwnership("rider" | "vendor" | "wallet_transaction" | "order" | "ride" | "user")` middleware. Admins bypass. |
| **Validation schemas** | `artifacts/api-server/src/lib/validation/schemas.ts` — consolidated Zod schemas for registration, login, OTP, orders, wallet, location, products, chat. |
| **Audit logging** | Wallet `topup`, `deposit`, and `send` operations now emit structured `[audit:wallet]` pino log lines. Admin `withdrawal_approved` / `withdrawal_rejected` now call `addAuditEntry()`. |

**New required secret:**
- `ENCRYPTION_MASTER_KEY` — required to use PII encryption (add in Replit Secrets panel, minimum 16 characters)

### Security Pattern Detection & Alerting (Task #3 — 2025)

| Area | What changed |
|---|---|
| **Data export audit** | `POST /api/users/export-data` now writes a record to `data_export_logs` table (user_id, masked phone, IP, timestamps, success). Fires email + Slack alert to admins after each successful export. |
| **Data exports admin view** | `GET /api/admin/security/data-exports` endpoint. "Data Exports" tab added to the Security Dashboard page, paginated, sorted by date. |
| **Suspicious pattern detector** | `suspiciousPatternDetector` Express middleware tracks request counts per IP per minute across sensitive path prefixes (`/api/auth`, `/api/users/lookup`, `/api/admin`). Exceeding the configurable threshold (platform setting `security_suspicious_pattern_threshold`, default 60 req/min) logs a `suspicious_pattern` security event and fires an email + Slack alert. Snooze-aware to prevent spam from a single attacker IP. |
| **Suspicious pattern events** | Visible in the Security Dashboard "Data Exports" tab alongside data export logs. |
| **Sentry webhook** | `POST /api/admin/sentry-webhook` — HMAC-verified (SHA-256 using `SENTRY_WEBHOOK_SECRET`). On new error fingerprint: inserts to `sentry_known_issues` table and fires admin alert. On known fingerprint: silently acknowledges and updates `last_seen_at`. |
| **New DB tables** | `data_export_logs`, `sentry_known_issues` — created at startup via `ensureSecurityTables()`. |

**New secrets — add in Replit Secrets panel:**
- `SENTRY_WEBHOOK_SECRET` — shared secret for verifying Sentry webhook payloads (HMAC-SHA256). Set the same value in Sentry: Project Settings → Integrations → Webhooks → Secret.

**Sentry webhook setup:**
1. Add `SENTRY_WEBHOOK_SECRET` to Replit Secrets (any strong random string).
2. In Sentry: Project Settings → Integrations → Webhooks → Add Webhook.
3. URL: `https://<your-domain>/api/admin/sentry-webhook`
4. Events: check **Issue** (created).
5. Secret: same value as `SENTRY_WEBHOOK_SECRET`.

**New platform setting:**
- `security_suspicious_pattern_threshold` — integer, req/min per IP on sensitive paths before alert fires (default: 60).

### Production Readiness Hardening (Task #5 — 2025)

| Area | What changed |
|---|---|
| **Production start script** | `"start"` in `artifacts/api-server/package.json` now runs `node dist/index.js`. Dev stays on `tsx` via `pnpm dev`. |
| **DB connection pool** | `lib/db/src/index.ts` and `artifacts/api-server/src/lib/db.ts` now set explicit `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`. Configurable via `DB_POOL_MAX` env var. |
| **Migration deduplicated** | `lib/db/migrations/0006_token_family_invalidation.sql` renamed to `0009_token_family_invalidation.sql` — no more duplicate prefix conflict. |
| **OTP bypass security** | `"000000"` blocked in production alongside `"123456"`. The whitelist POST endpoint now requires `bypassCode` and rejects insecure codes in production. |
| **Map API keys protected** | `GET /api/maps/config` now strips all API keys from unauthenticated responses. Only authenticated requests (valid Bearer JWT) receive Mapbox/Google/LocationIQ tokens. |
| **Startup guards** | `REDIS_URL` added to `CRITICAL_VARS` (fatal in production). Dev placeholder JWT secrets trigger a fatal exit in production. |
| **Replit decoupling** | `REPLIT_DOMAINS` replaced with `ALLOWED_DOMAINS` in Socket.IO CORS config (with Replit as optional fallback). `REPLIT_DEV_DOMAIN` replaced with `APP_BASE_URL` in admin password reset URL builder. |
| **Sentry** | `@sentry/node` moved from `optionalDependencies` to `dependencies`. Init is now synchronous (top-level await in ESM entrypoint). |
| **PM2 ecosystem** | `ecosystem.config.cjs` updated with all five apps: API server, admin (served by API), vendor, rider, and customer mobile-web. |
| **Object storage guard** | Missing `STORAGE_BUCKET_URL` in production now throws a fatal error at module load time instead of just warning. |

### S3-Compatible Object Storage (Task #6 — 2025)

| Area | What changed |
|---|---|
| **Storage adapter** | New `artifacts/api-server/src/lib/storage.ts` module. Wraps `@aws-sdk/client-s3`. When `STORAGE_BUCKET_URL` + `STORAGE_ACCESS_KEY` + `STORAGE_SECRET_KEY` are set, all file uploads go to the S3 bucket via `PutObjectCommand`. Falls back to `./uploads/` on local disk in development. |
| **Image uploads** | `saveBuffer()` in `uploads.ts` now calls `storageUpload()`. All image routes (base64 JSON, multipart proof, registration, prescription) use S3 when configured. |
| **Video/audio uploads** | `saveVideoBuffer()` and `saveAudioBuffer()` both route through `storageUpload()`. Videos still use a local temp file for `ffprobe` duration check before upload. |
| **Admin uploads** | `POST /api/admin/uploads/admin` in `admin/content.ts` also uses `storageUpload()`. |
| **Returned URLs** | In S3 mode, returned URLs point directly to `${STORAGE_BUCKET_URL}/${key}`. In local mode, URLs remain `/api/uploads/${key}`. |
| **Provider support** | `forcePathStyle: true` ensures compatibility with all S3-compatible providers (AWS, DigitalOcean Spaces, Cloudflare R2, MinIO, Backblaze B2). |

**New required env vars — add in Replit Secrets panel:**
- `ALLOWED_DOMAINS` — comma-separated domain list (no scheme) for Socket.IO CORS in production (e.g. `example.com,www.example.com`). Falls back to `REPLIT_DOMAINS` for Replit-hosted environments.
- `STORAGE_BUCKET_URL` — S3-compatible bucket public base URL required in production (e.g. `https://bucket.s3.amazonaws.com` or `https://s3.us-east-1.amazonaws.com/my-bucket`). Files are uploaded here; returned URLs point to this base.
- `STORAGE_ACCESS_KEY` — Access key ID for the S3-compatible bucket.
- `STORAGE_SECRET_KEY` — Secret access key for the S3-compatible bucket.

**New optional env vars:**
- `DB_POOL_MAX` — maximum PostgreSQL pool connections (default: `10`).
- `STORAGE_BUCKET_NAME` — Override for the bucket name; auto-extracted from `STORAGE_BUCKET_URL` path segment if not set.
- `STORAGE_ENDPOINT` — Override for the S3 endpoint URL; auto-derived from `STORAGE_BUCKET_URL` host if not set. Useful for DigitalOcean Spaces, Cloudflare R2, MinIO, etc.
- `STORAGE_REGION` — S3 region (default: `us-east-1`).

### Validation and Support Scripts
The API server includes a `check-permissions` validation script used by the Replit workflow, and the monorepo includes launcher scripts for Replit, Codespaces, VPS, and local development.

## External Dependencies

### Core Runtime & Frameworks
-   **Node.js**, **Express**, **Socket.IO**, **Drizzle ORM**, **Zod** (API server).
-   **PostgreSQL** (database).
-   **React 19**, **Vite** (admin/rider/vendor web apps).
-   **Wouter**, **React Router**, **Expo Router** (routing).
-   **Expo SDK** (with `expo-secure-store`, `expo-local-authentication`, `expo-image`, `expo-auth-session`, `expo-camera`, `expo-store-review`, `expo-linking`).
-   **EAS CLI** (for native builds).

### Authentication & Security
-   **@react-oauth/google** (Google sign-in).
-   **Facebook SDK**.
-   **JWT**, **bcrypt**, **TOTP** (2FA), **reCAPTCHA v3**.

### Maps & Location
-   **Leaflet** (web maps).
-   **NetInfo** (network quality detection).

### Real-time & State
-   **Socket.IO** (real-time communication).
-   **TanStack React Query** (server state management with offline persistence).

### Payment & Wallet
-   Integration with **JazzCash**, **EasyPaisa**, **Bank Transfer** (manual verification).

### Notifications
-   **Expo push tokens** (mobile push notifications).
-   **SMS / WhatsApp / Email OTP** (provider abstracted).

### Tooling
-   **TypeScript 5.9**, **Prettier 3.8**.
-   **pnpm**.
-   **Drizzle Kit** (migrations).
-   **Sentry** (error reporting).
