import { getRiderApiBase } from "./envValidation";

const BASE = getRiderApiBase();

/* PWA4: Centralized base URL getter used by socket.tsx and error-reporter.ts to ensure sync */
export function getApiBase(): string {
  return BASE;
}

const TOKEN_KEY   = "ajkmart_rider_token";
const REFRESH_KEY = "ajkmart_rider_refresh_token";

/* ── Secure token storage ──────────────────────────────────────────────────────
   Access tokens are stored in @capacitor/preferences (secure plugin) on native.
   In-memory cache avoids repeated async reads during a session.

   Migration: on first boot, if an existing token is found in localStorage,
   it is moved to Preferences and deleted from localStorage.

   Refresh tokens are carried by an HttpOnly cookie (no localStorage). */

let _inMemoryAccessToken   = "";
let _inMemoryRefreshToken  = "";

/* One-time purge of legacy refresh-token persistence. */
try {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(REFRESH_KEY);
  }
} catch { /* storage may be blocked */ }

/* ── Preferences-backed async token storage ── */
async function preferencesSet(key: string, value: string): Promise<void> {
  try {
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.set({ key, value });
  } catch (err) {
    console.warn("[capacitor/preferences] preferencesSet failed — falling back to localStorage:", err);
    try { localStorage.setItem(key, value); } catch {}
  }
}

async function preferencesGet(key: string): Promise<string> {
  try {
    const { Preferences } = await import("@capacitor/preferences");
    const { value } = await Preferences.get({ key });
    return value ?? "";
  } catch (err) {
    console.warn("[capacitor/preferences] preferencesGet failed — falling back to localStorage:", err);
    try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
  }
}

async function preferencesRemove(key: string): Promise<void> {
  try {
    const { Preferences } = await import("@capacitor/preferences");
    await Preferences.remove({ key });
  } catch (err) {
    console.warn("[capacitor/preferences] preferencesRemove failed — falling back to localStorage:", err);
    try { localStorage.removeItem(key); } catch {}
  }
}

/* One-time migration: move any token from localStorage → Preferences at boot.
   Exported as a promise so AuthProvider can await it before reading the token —
   avoids treating a valid persisted session as "no token" when the async load
   hasn't completed yet (critical on app restart). */
export const tokenStoreReady: Promise<void> = (async () => {
  try {
    if (typeof localStorage === "undefined") return;
    const legacy = localStorage.getItem(TOKEN_KEY);
    if (legacy) {
      _inMemoryAccessToken = legacy;
      await preferencesSet(TOKEN_KEY, legacy);
      localStorage.removeItem(TOKEN_KEY);
    } else {
      _inMemoryAccessToken = await preferencesGet(TOKEN_KEY);
    }
  } catch { /* swallow — token access is non-fatal on boot */ }
})();

/* Access token helpers — Preferences-backed, with in-memory cache */
function sessionGet(): string {
  return _inMemoryAccessToken;
}
function sessionSet(value: string): void {
  _inMemoryAccessToken = value;
  preferencesSet(TOKEN_KEY, value).catch(() => {});
}
function sessionRemove(): void {
  _inMemoryAccessToken = "";
  preferencesRemove(TOKEN_KEY).catch(() => {});
}

/* Refresh token helpers — IN-MEMORY ONLY.
   The raw value is also delivered as an HttpOnly cookie by the server for
   subsequent /auth/refresh and /auth/logout calls. The in-memory copy backs
   the legacy POST-body fallback during the cookie-rollout window.
   TODO(remove-after-v1): once the cookie-bearing rider build has fully
   propagated, remove _inMemoryRefreshToken and the body fallback in
   refreshAccessToken/logout. */
function localGet(): string {
  return _inMemoryRefreshToken;
}
function localSet(value: string): void {
  _inMemoryRefreshToken = value;
  /* Also belt-and-braces clear any stale localStorage entry that may have
     been written by an older bundle still cached in this browser. */
  try { localStorage.removeItem(REFRESH_KEY); } catch {}
}
function localRemove(): void {
  _inMemoryRefreshToken = "";
  try { localStorage.removeItem(REFRESH_KEY); } catch {}
}

/* Read the access token from localStorage (current scheme) or scan for legacy keys. */
function getToken(): string {
  return sessionGet();
}

function getRefreshToken(): string {
  return localGet();
}

/* Sweep localStorage for any stale rider auth keys from older app versions.
   Removes every key that looks like a rider access token (matches "rider_" or
   "ajkmart_rider" prefix) but is NOT the current access-token key or refresh-token key,
   which are intentionally kept in localStorage for mid-trip rehydration. */
function sweepLegacyTokens(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key === TOKEN_KEY || key === REFRESH_KEY) continue;
      if (key.startsWith("rider_") || key.startsWith("ajkmart_rider")) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
  } catch {}
}

function clearTokens(): void {
  sessionRemove();
  localRemove();
  /* Erase all known legacy keys AND any additional pattern-matching keys */
  sweepLegacyTokens();
  _inMemoryAccessToken  = "";
  _inMemoryRefreshToken = "";
}

/* ── Module-level token-refresh callbacks ─────────────────────────────────────
   Registered by socket.tsx (and any other consumer) to be notified immediately
   when a token refresh succeeds — enabling instant socket reconnection rather
   than waiting for the next polling tick. */
const _tokenRefreshCallbacks = new Set<() => void>();

export function registerTokenRefreshCallback(fn: () => void): () => void {
  _tokenRefreshCallbacks.add(fn);
  return () => { _tokenRefreshCallbacks.delete(fn); };
}

/* ── Module-level logout callback ─────────────────────────────────────────────
   The auth context registers this callback at mount time. Using a module-level
   reference avoids coupling to React's event system and guarantees the logout
   fires regardless of which component is mounted or whether the CustomEvent
   listener has been attached yet. */
let _logoutCallback: (() => void) | null = null;

export function registerLogoutCallback(fn: () => void): () => void {
  _logoutCallback = fn;
  return () => { if (_logoutCallback === fn) _logoutCallback = null; };
}

function triggerLogout(reason: string) {
  clearTokens();
  if (_logoutCallback) {
    _logoutCallback();
  }
  /* Also dispatch CustomEvent for components that still listen to it */
  try {
    window.dispatchEvent(new CustomEvent("ajkmart:logout", { detail: { reason } }));
  } catch {}
}

let _refreshPromise: Promise<RefreshResult> | null = null;

async function attemptTokenRefresh(): Promise<RefreshResult> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = _doRefresh();
  try { return await _refreshPromise; } finally { _refreshPromise = null; }
}

type RefreshResult = "refreshed" | "auth_failed" | "transient";

export interface ApiError extends Error {
  status?: number;
  responseData?: { existingAccount?: boolean; [key: string]: unknown };
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof Error && ("status" in e || "responseData" in e);
}

async function _doRefresh(): Promise<RefreshResult> {
  /* The refresh credential travels in an HttpOnly cookie set by the server.
     We still pass any in-memory shadow copy in the body as a one-release
     legacy fallback for older API servers that have not been redeployed. If
     neither path can prove identity we mark this as auth_failed so the
     caller routes to login — but only when there is genuinely no cookie OR
     in-memory token to send. We cannot read the cookie from JS, so we
     optimistically attempt the request and let the server respond. */
  const refreshToken = getRefreshToken();
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    });
    if (!res.ok) {
      /* 5xx / network-level: transient, keep tokens, let apiFetch retry */
      if (res.status >= 500) return "transient";
      /* 401 / 403: refresh token is invalid — must re-authenticate */
      clearTokens();
      return "auth_failed";
    }
    const data = await res.json();
    if (data.token) {
      sessionSet(data.token);
      sweepLegacyTokens();
      _tokenRefreshCallbacks.forEach(fn => { try { fn(); } catch {} });
    }
    if (data.refreshToken) localSet(data.refreshToken);
    return "refreshed";
  } catch {
    /* Network errors (offline, timeout) are transient */
    return "transient";
  }
}


interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  code?: string;
}

/** Typed shape returned by GET /rider/requests (includes serverTime envelope field) */
/* T1: Concrete shapes for the Rider request feed. The previous `any[]`
   annotations propagated unchecked through Home/Active filters and renderers,
   so a backend rename used to silently render `undefined`. We keep the types
   permissive (most fields optional) because the backend still returns
   loosely-shaped payloads in some legacy code paths, but every consumer now
   gets compile-time guidance for the canonical fields. */
export interface Order {
  id: string;
  status?: string;
  pickupAddress?: string;
  pickupLat?: number;
  pickupLng?: number;
  dropoffAddress?: string;
  dropoffLat?: number;
  dropoffLng?: number;
  customerName?: string;
  customerPhone?: string;
  total?: number;
  fare?: number;
  riderEarning?: number;
  paymentMethod?: string;
  distance?: number;
  duration?: number;
  createdAt?: string;
  items?: Array<{ name?: string; quantity?: number; price?: number }>;
  vendorName?: string;
  vendorPhone?: string;
  vendorAddress?: string;
  notes?: string;
  [extra: string]: unknown;
}

export interface Ride {
  id: string;
  status?: string;
  pickupAddress?: string;
  pickupLat?: number;
  pickupLng?: number;
  dropoffAddress?: string;
  dropoffLat?: number;
  dropoffLng?: number;
  customerName?: string;
  customerPhone?: string;
  fare?: number;
  riderEarning?: number;
  distance?: number;
  duration?: number;
  paymentMethod?: string;
  vehicleType?: string;
  createdAt?: string;
  scheduledFor?: string;
  notes?: string;
  [extra: string]: unknown;
}

export interface RiderRequestsResponse {
  orders: Order[];
  rides: Ride[];
  /** ISO timestamp from the server at response time — used to offset AcceptCountdown */
  _serverTime: string | null;
}

/* ── Configurable network settings ────────────────────────────────────────────
   These are updated at startup by the platform config. Defaults match the
   hardcoded values that were previously used so existing behaviour is preserved
   when the platform config cannot be fetched. */
let _apiTimeoutMs = 30_000;

export function setApiTimeoutMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) _apiTimeoutMs = Math.min(ms, 300_000);
}

export async function apiFetch(path: string, opts: RequestInit = {}, _retryBudget = 2, _returnEnvelope = false, _5xxRetries = 3): Promise<any> {
  const token = getToken();
  const isFormData = opts.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers as Record<string, string> || {}),
  };

  /* Build a combined signal: always include a configurable timeout, plus any caller-provided signal */
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), _apiTimeoutMs);
  const externalSignal = opts.signal as AbortSignal | undefined;
  const signal: AbortSignal = externalSignal
    ? (typeof AbortSignal.any === "function"
        ? AbortSignal.any([timeoutController.signal, externalSignal])
        : externalSignal)
    : timeoutController.signal;

  let res: Response;
  try {
    /* `credentials: "include"` ensures the HttpOnly refresh cookie set by the
       server is sent on every API call. Cookies are scoped server-side to
       /api/auth so non-auth endpoints will not see them; this is purely
       enabling the cookie-aware paths. */
    res = await fetch(`${BASE}${path}`, { ...opts, headers, signal, credentials: "include" });
  } finally {
    clearTimeout(timeoutId);
  }

  /* ── 5xx exponential-backoff retry (3 attempts: 1 s / 2 s / 4 s) ────────
     Server errors are transient by nature; retrying after a short back-off
     recovers from momentary overloads without surfacing noise to the user.
     Only 5xx is retried — 4xx errors reflect client-side problems and should
     not be retried.  401 / 403 have their own dedicated handling below.    */
  if (res.status >= 500 && _5xxRetries > 0) {
    const attempt  = 4 - _5xxRetries;                  // 1, 2, 3
    const delayMs  = 1000 * Math.pow(2, attempt - 1);  // 1 s, 2 s, 4 s
    console.debug(`[api] 5xx retry ${attempt}/3 for ${path} (status ${res.status}) — waiting ${delayMs}ms`);
    await new Promise(r => setTimeout(r, delayMs));
    return apiFetch(path, opts, _retryBudget, _returnEnvelope, _5xxRetries - 1);
  }

  if (res.status === 401 && _retryBudget > 0) {
    const refreshResult = await attemptTokenRefresh();
    if (refreshResult === "refreshed") {
      return apiFetch(path, opts, _retryBudget - 1, _returnEnvelope);
    }
    if (refreshResult === "transient" && _retryBudget > 1) {
      /* Transient server error during refresh — wait briefly and retry once more */
      await new Promise((r) => setTimeout(r, 800));
      return apiFetch(path, opts, _retryBudget - 1, _returnEnvelope);
    }
    if (refreshResult === "transient") {
      /* Budget exhausted but refresh was transient (network/5xx) — keep tokens, surface recoverable error */
      throw Object.assign(new Error("Connection issue. Please check your network and try again."), { status: 0, transient: true });
    }
    /* auth_failed — refresh token confirmed invalid — session is definitely invalid */
    triggerLogout("session_expired");
    const err = await res.json().catch(() => ({ error: "Session expired" }));
    throw Object.assign(new Error(err.error || "Session expired. Please log in again."), { status: 401 });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    /* 403 handling:
       - Auth/role denials (missing token, wrong role) trigger logout so the rider is
         sent to the login screen rather than seeing a cryptic error.
       - Business-rule 403s (withdrawals paused, feature disabled, etc.) must NOT
         trigger logout — the rider is still authenticated, just blocked by a policy.
       We use the backend's `code` field as the reliable machine-readable signal.
       When `code` is absent we fall back to a short allowlist of auth-specific phrases
       that the Express riderAuth/customerAuth/adminAuth middleware uses verbatim. */
    if (res.status === 403) {
      const msg = err.error || "";
      /* code and rejectionReason may live at top level OR inside err.data (sendErrorWithData envelope) */
      const code = err.code || (err.data as Record<string, unknown> | undefined)?.code as string || "";
      const rejectionReason = err.rejectionReason ?? (err.data as Record<string, unknown> | undefined)?.rejectionReason ?? null;
      const approvalStatus = err.approvalStatus ?? (err.data as Record<string, unknown> | undefined)?.approvalStatus ?? null;
      /* APPROVAL_PENDING and APPROVAL_REJECTED are NOT auth failures — do not force logout */
      const AUTH_DENY_CODES = ["AUTH_REQUIRED", "ROLE_DENIED", "TOKEN_INVALID", "TOKEN_EXPIRED", "ACCOUNT_BANNED"];
      const AUTH_DENY_PHRASES = ["access denied", "forbidden", "unauthorized", "authentication required", "token invalid", "token expired"];
      const isAuthDenial =
        AUTH_DENY_CODES.includes(code) ||
        AUTH_DENY_PHRASES.some(p => msg.toLowerCase().startsWith(p));
      if (isAuthDenial) {
        triggerLogout("access_denied");
      }
      throw Object.assign(new Error(msg || "Access denied"), { status: 403, code, rejectionReason, approvalStatus });
    }
    const error = new Error(err.error || "Request failed");
    Object.assign(error, { responseData: err, status: res.status });
    try {
      const { reportApiError } = await import("./error-reporter");
      reportApiError(path, res.status, err.error || "Request failed");
    } catch {}
    throw error;
  }
  let json: ApiEnvelope;
  try {
    json = await res.json() as ApiEnvelope;
  } catch {
    throw Object.assign(
      new Error("Response could not be parsed — please try again."),
      { status: res.status, parseError: true },
    );
  }
  /* When returnEnvelope is true, the caller receives the full JSON envelope
     (e.g. to read top-level fields like serverTime alongside data). */
  if (_returnEnvelope) return json;
  return json.data !== undefined ? json.data : json;
}

export const api = {
  /* Auth */
  sendOtp:      (phone: string, captchaToken?: string, preferredChannel?: string) => apiFetch("/auth/send-otp", { method: "POST", body: JSON.stringify({ phone, captchaToken, ...(preferredChannel ? { preferredChannel } : {}) }) }),
  verifyOtp:    (phone: string, otp: string, deviceFingerprint?: string, captchaToken?: string) => apiFetch("/auth/verify-otp", { method: "POST", body: JSON.stringify({ phone, otp, role: "rider", deviceFingerprint, captchaToken }) }),
  sendEmailOtp: (email: string, captchaToken?: string) => apiFetch("/auth/send-email-otp", { method: "POST", body: JSON.stringify({ email, captchaToken }) }),
  verifyEmailOtp:(email: string, otp: string, deviceFingerprint?: string, captchaToken?: string) => apiFetch("/auth/verify-email-otp", { method: "POST", body: JSON.stringify({ email, otp, role: "rider", deviceFingerprint, captchaToken }) }),
  loginUsername:(identifier: string, password: string, captchaToken?: string, deviceFingerprint?: string) => apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ identifier, password, role: "rider", captchaToken, deviceFingerprint }) }),
  checkAvailable:(data: { phone?: string; email?: string; username?: string }, signal?: AbortSignal) => apiFetch("/auth/check-available", { method: "POST", body: JSON.stringify(data), ...(signal ? { signal } : {}) }),
  logout:       (refreshToken?: string) => apiFetch("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }).finally(clearTokens),
  refreshToken: () => attemptTokenRefresh(),

  registerRider: (data: {
    name: string; phone: string; email: string; cnic: string; vehicleType: string;
    vehicleRegistration: string; drivingLicense: string; password: string;
    captchaToken?: string; username?: string;
    address?: string; city?: string; emergencyContact?: string;
    vehiclePlate?: string; vehiclePhoto?: string; documents?: string;
  }) =>
    apiFetch("/auth/register", { method: "POST", body: JSON.stringify({ ...data, role: "rider", vehicleRegNo: data.vehicleRegistration }) }),
  emailRegisterRider: (data: {
    name: string; phone: string; email: string; cnic: string; vehicleType: string;
    vehicleRegistration: string; drivingLicense: string; password: string;
    captchaToken?: string; username?: string;
    address?: string; city?: string; emergencyContact?: string;
    vehiclePlate?: string; vehiclePhoto?: string; documents?: string;
  }) =>
    apiFetch("/auth/email-register", { method: "POST", body: JSON.stringify({ ...data, role: "rider", vehicleRegNo: data.vehicleRegistration }) }),
  uploadFile: (data: { file: string; filename?: string; mimeType?: string }) =>
    apiFetch("/uploads", { method: "POST", body: JSON.stringify(data) }),
  /* Multipart/form-data upload — avoids large base64 payload; used for delivery proof.
     Calls /uploads/proof which is gated by riderAuth and handles multipart parsing. */
  uploadProof: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name || "proof.jpg");
    form.append("purpose", "delivery_proof");
    return apiFetch("/uploads/proof", { method: "POST", body: form });
  },
  uploadRegistrationDoc: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name || "document.jpg");
    return apiFetch("/uploads/register", { method: "POST", body: form });
  },
  forgotPassword: (data: { method: "phone" | "email"; phone?: string; email?: string; captchaToken?: string }) =>
    apiFetch("/auth/forgot-password", { method: "POST", body: JSON.stringify(data) }),
  resetPassword: (data: { phone?: string; email?: string; otp: string; newPassword: string; totpCode?: string; captchaToken?: string }) =>
    apiFetch("/auth/reset-password", { method: "POST", body: JSON.stringify(data) }),
  socialGoogle: (data: { idToken: string }) =>
    apiFetch("/auth/social/google", { method: "POST", body: JSON.stringify({ ...data, role: "rider" }) }),
  socialFacebook: (data: { accessToken: string }) =>
    apiFetch("/auth/social/facebook", { method: "POST", body: JSON.stringify({ ...data, role: "rider" }) }),
  magicLinkVerify: (data: { token: string }) =>
    apiFetch("/auth/magic-link/verify", { method: "POST", body: JSON.stringify(data) }),
  twoFactorSetup: () =>
    apiFetch("/auth/2fa/setup"),
  twoFactorEnable: (data: { code: string }) =>
    apiFetch("/auth/2fa/verify-setup", { method: "POST", body: JSON.stringify(data) }),
  twoFactorVerify: (data: { code: string; tempToken?: string; deviceFingerprint?: string; trustDevice?: boolean }) =>
    apiFetch("/auth/2fa/verify", { method: "POST", body: JSON.stringify(data) }),
  twoFactorRecovery: (data: { backupCode: string; tempToken?: string; deviceFingerprint?: string }) =>
    apiFetch("/auth/2fa/recovery", { method: "POST", body: JSON.stringify(data) }),
  twoFactorDisable: (data: { code: string }) =>
    apiFetch("/auth/2fa/disable", { method: "POST", body: JSON.stringify(data) }),
  sendMagicLink: (email: string) =>
    apiFetch("/auth/magic-link/send", { method: "POST", body: JSON.stringify({ email }) }),

  /* Token helpers */
  storeTokens: (token: string, refreshToken?: string) => {
    /* Store access token in sessionStorage; refresh token in localStorage */
    sessionSet(token);
    if (refreshToken) localSet(refreshToken);
    /* Sweep all stale legacy rider access keys from localStorage */
    sweepLegacyTokens();
  },
  clearTokens,
  getToken,
  getRefreshToken,
  registerLogoutCallback,

  /* Rider */
  getMe:        (signal?: AbortSignal) => apiFetch("/rider/me", signal ? { signal } : {}),
  setOnline:    (isOnline: boolean) => apiFetch("/rider/online", { method: "PATCH", body: JSON.stringify({ isOnline }) }),
  updateProfile:(data: any) => apiFetch("/rider/profile", { method: "PATCH", body: JSON.stringify(data) }),
  getRequests:  (): Promise<RiderRequestsResponse> =>
    apiFetch("/rider/requests", {}, 2, true).then((env: ApiEnvelope<{ orders: Order[]; rides: Ride[] }> & { serverTime?: string }) => {
      const payload = env.data ?? { orders: [], rides: [] };
      return {
        orders: payload.orders ?? [],
        rides: payload.rides ?? [],
        _serverTime: env.serverTime ?? null,
      };
    }),
  getActive:    () => apiFetch("/rider/active"),
  acceptOrder:  (id: string) => apiFetch(`/rider/orders/${id}/accept`, { method: "POST", body: "{}" }),
  rejectOrder:  (id: string, reason?: string) => apiFetch(`/rider/orders/${id}/reject`, { method: "POST", body: JSON.stringify({ reason: reason || "not_interested" }) }),
  updateOrder:  (id: string, status: string, proofPhoto?: string) => apiFetch(`/rider/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, ...(proofPhoto ? { proofPhoto } : {}) }) }),
  acceptRide:   (id: string) => apiFetch(`/rider/rides/${id}/accept`, { method: "POST", body: "{}" }),
  updateRide:   (id: string, status: string, loc?: { lat: number; lng: number }) => apiFetch(`/rider/rides/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, ...(loc || {}) }) }),
  verifyRideOtp:(id: string, otp: string) => apiFetch(`/rider/rides/${id}/verify-otp`, { method: "POST", body: JSON.stringify({ otp }) }),
  counterRide:  (id: string, data: { counterFare: number; note?: string }) => apiFetch(`/rider/rides/${id}/counter`, { method: "POST", body: JSON.stringify(data) }),
  rejectOffer:  (id: string) => apiFetch(`/rider/rides/${id}/reject-offer`, { method: "POST", body: "{}" }),
  ignoreRide:   (id: string) => apiFetch(`/rider/rides/${id}/ignore`, { method: "POST", body: "{}" }),
  getCancelStats: () => apiFetch("/rider/cancel-stats"),
  getIgnoreStats: () => apiFetch("/rider/ignore-stats"),
  getPenaltyHistory: () => apiFetch("/rider/penalty-history"),
  getHistory:   (opts: { limit?: number; offset?: number } = {}): Promise<{ history: Array<{ id: string; kind: "order" | "ride"; type: string; status: string; earnings: number; amount: number; address?: string; createdAt: string; proofPhoto?: string; origin?: string; destination?: string; fare?: number; distance?: string | number; duration?: number }>; hasMore: boolean; limit: number; offset: number }> => {
    const params = new URLSearchParams();
    if (opts.limit  !== undefined) params.set("limit",  String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return apiFetch(`/rider/history${qs ? `?${qs}` : ""}`);
  },
  getEarnings:  (): Promise<{ today: { earnings: number; deliveries: number; breakdown?: { food: { earnings: number; count: number }; parcel: { earnings: number; count: number }; rides: { earnings: number; count: number } } }; week: { earnings: number; deliveries: number; breakdown?: { food: { earnings: number; count: number }; parcel: { earnings: number; count: number }; rides: { earnings: number; count: number } } }; month: { earnings: number; deliveries: number; breakdown?: { food: { earnings: number; count: number }; parcel: { earnings: number; count: number }; rides: { earnings: number; count: number } } }; dailyGoal: number | null }> => apiFetch("/rider/earnings"),
  getMyReviews: () => apiFetch("/rider/reviews"),

  /* Location */
  updateLocation: (data: { latitude: number; longitude: number; accuracy?: number; speed?: number; heading?: number; batteryLevel?: number; mockProvider?: boolean; rideId?: string }) => apiFetch("/rider/location", { method: "PATCH", body: JSON.stringify(data) }),
  batchLocation: (pings: Array<{ timestamp: string; latitude: number; longitude: number; accuracy?: number; speed?: number; heading?: number; batteryLevel?: number; mockProvider?: boolean; action?: string | null }>) =>
    apiFetch("/rider/location/batch", { method: "POST", body: JSON.stringify({ locations: pings }) }),

  /* Wallet */
  /* getWallet — kept for backward compatibility. Calls the legacy non-paged
     endpoint shape `{ balance, transactions }` via `?legacy=1`. New code
     should use `getWalletPage` for cursor pagination. */
  getWallet:      () => apiFetch("/rider/wallet/transactions?legacy=1"),
  /* getWalletPage — cursor-paginated. Returns `{ balance, items, nextCursor, limit }`.
     Pass `cursor` (opaque string from the previous response) to fetch the
     next page. Pass `limit` (1–200) to control page size; default 50. */
  getWalletPage:  (opts: { cursor?: string | null; limit?: number } = {}): Promise<{ balance: number; items: Array<{ id: string; type: string; amount: number; description?: string | null; reference?: string | null; createdAt: string; [k: string]: unknown }>; nextCursor: string | null; limit: number }> => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return apiFetch(`/rider/wallet/transactions${qs ? `?${qs}` : ""}`);
  },
  getMinBalance:  () => apiFetch("/rider/wallet/min-balance"),
  withdrawWallet: (data: { amount: number; bankName: string; accountNumber: string; accountTitle: string; paymentMethod?: string; note?: string }) =>
    apiFetch("/rider/wallet/withdraw", { method: "POST", body: JSON.stringify(data) }),
  submitDeposit:  (data: { amount: number; paymentMethod: string; transactionId: string; accountNumber?: string; note?: string }) =>
    apiFetch("/rider/wallet/deposit", { method: "POST", body: JSON.stringify(data) }),
  getDeposits:    () => apiFetch("/rider/wallet/deposits"),

  /* COD Remittance */
  getCodSummary:       () => apiFetch("/rider/cod-summary"),
  submitCodRemittance: (data: { amount: number; paymentMethod: string; accountNumber: string; transactionId?: string; note?: string }) =>
    apiFetch("/rider/cod/remit", { method: "POST", body: JSON.stringify(data) }),

  /* Notifications */
  getNotifications: () => apiFetch("/rider/notifications"),
  markAllRead:      () => apiFetch("/rider/notifications/read-all", { method: "PATCH", body: "{}" }),
  markOneRead:      (id: string) => apiFetch(`/rider/notifications/${id}/read`, { method: "PATCH", body: "{}" }),

  /* Settings */
  getSettings:    () => apiFetch("/settings"),
  updateSettings: (data: Record<string, unknown>) => apiFetch("/settings", { method: "PUT", body: JSON.stringify(data) }),

  /* AI Assistant */
  aiChat: (message: string, history?: Array<{ role: "user" | "assistant"; content: string }>) =>
    apiFetch("/rider/ai-chat", { method: "POST", body: JSON.stringify({ message, history }) }),

  /* Generic fetch — exposed on the api object so Chat (and other surfaces that
     migrated off their own apiFetch copy) can call api.apiFetch(...) and
     transparently get the auth refresh, timeout, and error-reporter integration.
     Closes C1/C3 by removing all parallel apiFetch implementations. */
  apiFetch,
};
