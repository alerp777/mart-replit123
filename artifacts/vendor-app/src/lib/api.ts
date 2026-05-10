import { getVendorApiBase } from "./envValidation";
import { createApiFetcher, RefreshError, createCircuitBreaker, CircuitOpenError } from "@workspace/api-client-react";

const BASE = getVendorApiBase();

const TOKEN_KEY   = "ajkmart_vendor_token";
const REFRESH_KEY = "ajkmart_vendor_refresh_token";

/* ── Secure token storage (IN-MEMORY ONLY) ─────────────────────────────────────
   Both access and refresh tokens are held exclusively in module-level memory —
   never written to localStorage — so they are not accessible to injected scripts.
   Refresh tokens are also delivered as HttpOnly cookies by the server (see
   task #40) which handles cross-tab / page-reload rehydration once deployed.

   One-time migration: on first load after this upgrade, any access or refresh
   token previously written to localStorage by an older bundle is read into
   memory and then immediately erased from storage. This keeps existing
   sessions alive for the current page session while eliminating persistent
   XSS-accessible storage going forward. */

let _inMemoryAccessToken  = "";
let _inMemoryRefreshToken = "";

/* One-time migration from localStorage → in-memory, then purge. */
try {
  if (typeof localStorage !== "undefined") {
    const legacyAccess  = localStorage.getItem(TOKEN_KEY);
    const legacyRefresh = localStorage.getItem(REFRESH_KEY);
    if (legacyAccess)  { _inMemoryAccessToken  = legacyAccess;  localStorage.removeItem(TOKEN_KEY); }
    if (legacyRefresh) { _inMemoryRefreshToken = legacyRefresh; localStorage.removeItem(REFRESH_KEY); }
    /* Sweep any other vendor auth keys left by older bundles. */
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("vendor_") || k.startsWith("ajkmart_vendor"))) keysToRemove.push(k);
    }
    keysToRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
  }
} catch { /* storage may be blocked — start fresh */ }

/* Refresh token helpers — IN-MEMORY ONLY.
   The value is also sent as an HttpOnly cookie by the server for
   /auth/refresh and /auth/logout once task #40 is shipped. The in-memory
   copy is the POST-body fallback during that rollout window. */
function localGet(): string { return _inMemoryRefreshToken; }
function localSet(value: string): void {
  _inMemoryRefreshToken = value;
  /* Belt-and-braces: ensure no refresh token lingers in localStorage. */
  try { localStorage.removeItem(REFRESH_KEY); } catch {}
}
function localRemove(): void {
  _inMemoryRefreshToken = "";
  try { localStorage.removeItem(REFRESH_KEY); } catch {}
}

function getToken(): string  { return _inMemoryAccessToken; }
function getRefreshToken(): string { return localGet(); }

function clearTokens() {
  _inMemoryAccessToken  = "";
  _inMemoryRefreshToken = "";
  localRemove();
}

/* ── Module-level logout callback ─────────────────────────────────────────────
   The auth context registers this callback at mount time so apiFetch can
   trigger a logout directly without relying on CustomEvent alone. */
let _logoutCallback: (() => void) | null = null;

export function registerLogoutCallback(fn: () => void): () => void {
  _logoutCallback = fn;
  return () => { if (_logoutCallback === fn) _logoutCallback = null; };
}

function triggerLogout(reason: string) {
  clearTokens();
  if (_logoutCallback) _logoutCallback();
  try { window.dispatchEvent(new CustomEvent("ajkmart:logout", { detail: { reason } })); } catch {}
}

/* ── Configurable network settings ────────────────────────────────────────────
   Updated at startup from the platform config. Defaults match the previously
   hardcoded value (30 s) so existing behaviour is preserved. */
let _apiTimeoutMs = 30_000;

export function setApiTimeoutMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) _apiTimeoutMs = Math.min(ms, 300_000);
}

/* ── Per-endpoint circuit breaker ─────────────────────────────────────────────
   Opens after 3 consecutive 5xx failures on the same endpoint (once all
   built-in retries are exhausted). Rejects new requests for 30 s to stop
   hammering a degraded server. After cooldown it allows one probe request; on
   success the circuit closes again, on failure the cooldown resets.           */
const CB_DEFAULT_RETRIES = 3;
const _circuitBreaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });

/* ── Shared API fetcher (createApiFetcher factory) ────────────────────────────
   Centralises: Bearer injection, timeout, 401→refresh (mutex)→retry.
   Callbacks close over module-level vars so they always reflect current state.
   _vendorRefresh exposes the mutex-guarded refresh for api.refreshToken. */
const [_vendorFetcher, _vendorRefresh] = createApiFetcher({
  baseUrl: BASE,
  getToken: () => _inMemoryAccessToken || null,
  setToken: (token) => { _inMemoryAccessToken = token; },
  getRefreshToken: localGet,
  setRefreshToken: localSet,
  onRefreshFailed: (isTransient) => {
    if (!isTransient) triggerLogout("session_expired");
  },
  refreshEndpoint: `${BASE}/auth/refresh`,
  extraRefreshHeaders: () => ({ "X-App": "vendor" }),
  timeoutMs: () => _apiTimeoutMs,
  credentialsMode: "include",
});

export async function apiFetch(path: string, opts: RequestInit & { _timeoutMs?: number } = {}, _5xxRetries = CB_DEFAULT_RETRIES): Promise<any> {
  /* Guard: reject immediately if this endpoint's circuit is open.
     Only checked on the initial call — recursive retries bypass this so they
     can attempt the back-off sequence before the circuit actually records a
     failure.  CircuitOpenError is converted to the standard error shape so
     existing catch blocks that inspect { status, transient } still work. */
  if (_5xxRetries === CB_DEFAULT_RETRIES) {
    try {
      _circuitBreaker.check(path);
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        const retryS = Math.ceil(err.retryAfterMs / 1000);
        throw Object.assign(
          new Error(`Service temporarily unavailable. Please try again in ${retryS}s.`),
          { status: 503, transient: true, circuitOpen: true }
        );
      }
      throw err;
    }
  }

  const isFormData = opts.body instanceof FormData;
  const mergedOpts: RequestInit & { _timeoutMs?: number } = {
    ...opts,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(opts.headers as Record<string, string> || {}),
    },
  };

  let res: Response;
  try {
    res = await _vendorFetcher(path, mergedOpts);
  } catch (err: unknown) {
    if (err instanceof RefreshError) {
      if (err.isTransient) {
        /* Transient refresh failure (network/5xx) — keep tokens, surface recoverable error */
        throw Object.assign(
          new Error("Connection issue. Please check your network and try again."),
          { status: 0, transient: true }
        );
      }
      /* auth_failed — triggerLogout already called via onRefreshFailed */
      throw Object.assign(
        new Error("Session expired. Please log in again."),
        { status: 401 }
      );
    }
    /* Re-throw AbortError unchanged so callers can detect request cancellation */
    if (err instanceof Error && err.name === "AbortError") throw err;
    /* Network-level failure (offline, timeout) — never log out for this */
    throw Object.assign(new Error("Network error. Please check your connection and try again."), { status: 0, transient: true });
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
    return apiFetch(path, opts, _5xxRetries - 1);
  }

  if (!res.ok) {
    /* Record a circuit-breaker failure once all 5xx retries are exhausted.
       4xx errors reflect client problems, not server overload, so they are
       deliberately excluded — only sustained 5xx responses open the circuit. */
    if (res.status >= 500) _circuitBreaker.onFailure(path);
    if (res.status === 403) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      if (err.pendingApproval) {
        throw Object.assign(new Error(err.error || "Pending approval"), { status: 403, pendingApproval: true });
      }
      if (err.rejected) {
        throw Object.assign(new Error(err.error || "Application rejected"), { status: 403, rejected: true, approvalNote: err.approvalNote });
      }
      const msg = err.error || "";
      /* code may live at top level OR inside err.data (sendErrorWithData envelope) */
      const code = err.code || (err.data as Record<string, unknown> | undefined)?.code as string || "";
      /* APPROVAL_PENDING and APPROVAL_REJECTED are NOT auth failures — do not force logout */
      const AUTH_DENY_CODES = ["AUTH_REQUIRED", "ROLE_DENIED", "TOKEN_INVALID", "TOKEN_EXPIRED", "ACCOUNT_BANNED"];
      const AUTH_DENY_PHRASES = ["access denied", "forbidden", "unauthorized", "authentication required", "token invalid", "token expired"];
      const isAuthDenial =
        AUTH_DENY_CODES.includes(code) ||
        AUTH_DENY_PHRASES.some(p => msg.toLowerCase().startsWith(p));
      if (isAuthDenial) {
        triggerLogout("access_denied");
      }
      throw Object.assign(new Error(msg || "Access denied"), { status: 403, code });
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    try {
      const { reportApiError } = await import("./error-reporter");
      reportApiError(path, res.status, err.error || "Request failed");
    } catch {}
    throw new Error(err.error || "Request failed");
  }
  const json = await res.json();
  /* Successful response — reset the failure counter for this endpoint so a
     future transient 5xx burst starts counting from zero again. */
  _circuitBreaker.onSuccess(path);
  return json.data !== undefined ? json.data : json;
}

export const api = {
  /* Auth */
  sendOtp:      (phone: string, preferredChannel?: string, captchaToken?: string) => apiFetch("/auth/send-otp", { method: "POST", body: JSON.stringify({ phone, ...(preferredChannel ? { preferredChannel } : {}), ...(captchaToken ? { captchaToken } : {}) }) }),
  verifyOtp:    (phone: string, otp: string, deviceFingerprint?: string, role?: string) => apiFetch("/auth/verify-otp", { method: "POST", body: JSON.stringify({ phone, otp, ...(role ? { role } : {}), ...(deviceFingerprint ? { deviceFingerprint } : {}) }) }),
  sendEmailOtp: (email: string, captchaToken?: string) => apiFetch("/auth/send-email-otp", { method: "POST", body: JSON.stringify({ email, ...(captchaToken ? { captchaToken } : {}) }) }),
  verifyEmailOtp:(email: string, otp: string, deviceFingerprint?: string) => apiFetch("/auth/verify-email-otp", { method: "POST", body: JSON.stringify({ email, otp, role: "vendor", ...(deviceFingerprint ? { deviceFingerprint } : {}) }) }),
  loginUsername:(identifier: string, password: string, deviceFingerprint?: string, captchaToken?: string) => apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ identifier, password, role: "vendor", ...(deviceFingerprint ? { deviceFingerprint } : {}), ...(captchaToken ? { captchaToken } : {}) }) }),
  forgotPassword:(data: { phone?: string; email?: string; identifier?: string }) => apiFetch("/auth/forgot-password", { method: "POST", body: JSON.stringify(data) }),
  resetPassword:(data: { phone?: string; email?: string; identifier?: string; otp: string; newPassword: string; totpCode?: string }) => apiFetch("/auth/reset-password", { method: "POST", body: JSON.stringify(data) }),
  logout:       (refreshToken?: string) => apiFetch("/auth/logout", { method: "POST", headers: { "X-App": "vendor" }, body: JSON.stringify({ refreshToken }) }).finally(clearTokens),
  refreshToken: () => _vendorRefresh(),
  checkAvailable: (data: { phone?: string; email?: string; username?: string }, signal?: AbortSignal) =>
    apiFetch("/auth/check-available", { method: "POST", body: JSON.stringify(data), signal }),
  vendorRegister: (data: { phone: string; storeName: string; storeCategory?: string; name?: string; cnic?: string; address?: string; city?: string; bankName?: string; bankAccount?: string; bankAccountTitle?: string; username?: string; acceptedTermsVersion?: string }) =>
    apiFetch("/auth/vendor-register", { method: "POST", body: JSON.stringify(data) }),
  socialGoogle: (data: { idToken: string }) =>
    apiFetch("/auth/social/google", { method: "POST", body: JSON.stringify({ ...data, role: "vendor" }) }),
  socialFacebook: (data: { accessToken: string }) =>
    apiFetch("/auth/social/facebook", { method: "POST", body: JSON.stringify({ ...data, role: "vendor" }) }),
  magicLinkSend: (email: string) =>
    apiFetch("/auth/magic-link/send", { method: "POST", body: JSON.stringify({ email }) }),
  magicLinkVerify: (data: { token: string }) =>
    apiFetch("/auth/magic-link/verify", { method: "POST", body: JSON.stringify(data) }),

  /* Token helpers */
  storeTokens: (token: string, refreshToken?: string) => {
    _inMemoryAccessToken = token;
    if (refreshToken) localSet(refreshToken);
  },
  clearTokens,
  getToken,
  getRefreshToken,
  registerLogoutCallback,

  /* Profile */
  getMe:         (signal?: AbortSignal) => apiFetch("/vendor/me", signal ? { signal } : {}),
  updateProfile: (data: Record<string, string | undefined>) => apiFetch("/vendor/profile", { method: "PATCH", body: JSON.stringify(data) }),
  getQuickReplies:    () => apiFetch("/vendor/profile/quick-replies"),
  updateQuickReplies: (quickReplies: string[]) => apiFetch("/vendor/profile/quick-replies", { method: "PATCH", body: JSON.stringify({ quickReplies }) }),

  /* Store management */
  getStore:      () => apiFetch("/vendor/store"),
  updateStore:   (data: any) => apiFetch("/vendor/store", { method: "PATCH", body: JSON.stringify(data) }),

  /* Stats & Analytics */
  getStats:      () => apiFetch("/vendor/stats"),
  getAnalytics:  (days?: number) => apiFetch(`/vendor/analytics${days ? `?days=${days}` : ""}`),
  getAnalyticsRange: (from: string, to: string) => apiFetch(`/vendor/analytics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  /* Orders */
  getOrders:     (status?: string) => apiFetch(`/vendor/orders${status ? `?status=${status}` : ""}`),
  getVendorOrder: (id: string) => apiFetch(`/vendor/orders/${id}`),
  updateOrder:   (id: string, status: string, reason?: string) => apiFetch(`/vendor/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, ...(reason ? { reason } : {}) }) }),

  /* Products */
  getProducts:   (q?: string, category?: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (category && category !== "all") params.set("category", category);
    const qs = params.toString();
    return apiFetch(`/vendor/products${qs ? `?${qs}` : ""}`);
  },
  createProduct:  (data: any) => apiFetch("/vendor/products", { method: "POST", body: JSON.stringify(data) }),
  bulkAddProducts:(products: any[]) => apiFetch("/vendor/products/bulk", { method: "POST", body: JSON.stringify({ products }) }),
  bulkEditProducts:(products: Array<{ id: string; price?: number; stock?: number | null }>) => apiFetch("/vendor/products/bulk", { method: "PATCH", body: JSON.stringify({ products }) }),
  updateProduct:  (id: string, data: any) => apiFetch(`/vendor/products/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteProduct:  (id: string) => apiFetch(`/vendor/products/${id}`, { method: "DELETE" }),
  getProductStockHistory: (id: string) => apiFetch(`/vendor/products/${id}/stock-history`),

  /* Promos */
  getPromos:     () => apiFetch("/vendor/promos"),
  createPromo:   (data: any) => apiFetch("/vendor/promos", { method: "POST", body: JSON.stringify(data) }),
  updatePromo:   (id: string, data: any) => apiFetch(`/vendor/promos/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  togglePromo:   (id: string) => apiFetch(`/vendor/promos/${id}/toggle`, { method: "PATCH", body: "{}" }),
  deletePromo:   (id: string) => apiFetch(`/vendor/promos/${id}`, { method: "DELETE" }),

  /* Reviews */
  getReviews:    (vendorId: string) => apiFetch(`/reviews/vendor/${vendorId}`),
  getVendorReviews: (params?: { page?: number; limit?: number; stars?: string; sort?: string }) => {
    const q = new URLSearchParams();
    if (params?.page)  q.set("page",  String(params.page));
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.stars) q.set("stars", params.stars);
    if (params?.sort)  q.set("sort",  params.sort);
    return apiFetch(`/vendor/reviews?${q.toString()}`);
  },
  getPublicReviews:    (vendorId: string) => apiFetch(`/reviews/vendor/${vendorId}`),
  postVendorReply:     (reviewId: string, reply: string) => apiFetch(`/reviews/${reviewId}/vendor-reply`, { method: "POST", body: JSON.stringify({ reply }) }),
  updateVendorReply:   (reviewId: string, reply: string) => apiFetch(`/reviews/${reviewId}/vendor-reply`, { method: "PUT", body: JSON.stringify({ reply }) }),
  deleteVendorReply:   (reviewId: string) => apiFetch(`/reviews/${reviewId}/vendor-reply`, { method: "DELETE" }),

  /* Wallet */
  getWallet:      () => apiFetch("/vendor/wallet/transactions"),
  withdrawWallet: (data: { amount: number; bankName: string; accountNumber: string; accountTitle: string; note?: string }) =>
    apiFetch("/vendor/wallet/withdraw", { method: "POST", body: JSON.stringify(data) }),
  depositWallet: (data: { amount: number; paymentMethod: string; paymentReference: string; note?: string }) =>
    apiFetch("/vendor/wallet/deposit", { method: "POST", body: JSON.stringify(data) }),

  /* Image Upload */
  uploadImage: async (file: File): Promise<{ url: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const result = await apiFetch("/uploads", {
            method: "POST",
            body: JSON.stringify({
              file: reader.result as string,
              filename: file.name,
              mimeType: file.type,
            }),
          });
          resolve({ url: result.url });
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  },

  uploadAudio: async (file: File): Promise<{ url: string }> => {
    const formData = new FormData();
    formData.append("file", file);
    const result = await apiFetch("/uploads/audio", { method: "POST", body: formData });
    return { url: result.url };
  },

  uploadVideo: async (file: File): Promise<{ url: string }> => {
    const formData = new FormData();
    formData.append("file", file);
    /* Disable the default timeout for large video uploads; the factory still
       handles token refresh and retry automatically. */
    const result = await apiFetch("/uploads/video", {
      method: "POST",
      body: formData,
      _timeoutMs: 0,
    });
    return { url: result.url };
  },

  /* Location */
  getLocation:       (userId: string) => apiFetch(`/locations/${userId}`),
  updateLocation:    (data: { latitude: number; longitude: number; role: string }) => apiFetch("/locations/update", { method: "POST", body: JSON.stringify(data) }),

  /* Rider assignment */
  getAvailableRiders: (lat: number | null, lng: number | null, maxKm = 10) => {
    const params = new URLSearchParams({ maxKm: String(maxKm) });
    if (lat !== null && lng !== null) { params.set("lat", String(lat)); params.set("lng", String(lng)); }
    return apiFetch(`/vendor/orders/available-riders?${params}`);
  },
  getOrderAvailableRiders: (orderId: string) =>
    apiFetch(`/vendor/orders/${orderId}/available-riders`),
  assignRider:        (orderId: string, riderId: string) => apiFetch(`/vendor/orders/${orderId}/assign-rider`, { method: "POST", body: JSON.stringify({ riderId }) }),
  autoAssignRider:    (orderId: string) => apiFetch(`/vendor/orders/${orderId}/auto-assign`, { method: "POST", body: JSON.stringify({}) }),

  /* Delivery Access */
  getDeliveryAccessStatus: () => apiFetch("/vendor/delivery-access/status"),
  requestDeliveryAccess:   (data: { serviceType?: string; reason?: string }) => apiFetch("/vendor/delivery-access/request", { method: "POST", body: JSON.stringify(data) }),

  /* Weekly Schedule */
  getSchedule:     () => apiFetch("/vendor/schedule"),
  updateSchedule:  (schedule: Array<{ dayOfWeek: number; openTime: string; closeTime: string; isEnabled: boolean }>) =>
    apiFetch("/vendor/schedule", { method: "PUT", body: JSON.stringify({ schedule }) }),

  /* Notifications */
  getNotifications:  () => apiFetch("/vendor/notifications"),
  markAllRead:       () => apiFetch("/vendor/notifications/read-all", { method: "PATCH", body: "{}" }),
  markNotificationRead: (id: string) => apiFetch(`/vendor/notifications/${id}/read`, { method: "PATCH", body: "{}" }),

  /* Settings */
  getSettings:    () => apiFetch("/settings"),
  updateSettings: (data: Record<string, unknown>) => apiFetch("/settings", { method: "PUT", body: JSON.stringify(data) }),

  /* Test notification */
  testNotification: () => apiFetch("/vendor/test-notification", { method: "POST", body: "{}" }),
};
