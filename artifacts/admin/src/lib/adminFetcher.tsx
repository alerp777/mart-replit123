import React from 'react';
import { readCsrfFromCookie } from './adminAuthContext.js';
import { safeSessionSet } from './safeStorage';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { createApiFetcher, RefreshError, FetchTimeoutError } from '@workspace/api-client-react';

/**
 * Typed Error for non-2xx admin fetcher responses. Replaces the previous
 * `(error as any).status = …` pattern so callers can `instanceof`
 * narrow and read the HTTP status without `any`.
 */
export class AdminFetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AdminFetchError';
    this.status = status;
  }
}

/**
 * Typed error for requests that exceeded the timeout window.
 * Callers can `instanceof TimeoutError` to show specific UX.
 */
export class TimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Abort requests that take longer than this (milliseconds). */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Returns an AbortSignal that fires after `ms` milliseconds.
 * Sets the abort reason to a TimeoutError so callers can distinguish
 * our timeout from external aborts (e.g. component unmount).
 * Merges with an optional external signal so either side can abort.
 */
function timeoutSignal(ms: number, externalSignal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(new TimeoutError()), ms);

  controller.signal.addEventListener('abort', () => clearTimeout(timerId), { once: true });

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener(
        'abort',
        () => { clearTimeout(timerId); controller.abort(externalSignal.reason); },
        { once: true },
      );
    }
  }

  return controller.signal;
}

/**
 * If the error is specifically a TimeoutError thrown by our internal timer,
 * show a toast so the user knows the request hung.
 * External aborts (e.g. component unmount via AbortController) are silently
 * swallowed — they are not user-facing errors.
 */
function handleTimeoutError(err: unknown, retry?: () => void): void {
  if (!(err instanceof TimeoutError)) return;
  toast({
    title: 'Request timed out',
    description: 'The server took too long to respond. Check your connection and try again.',
    variant: 'destructive',
    action: retry
      ? <ToastAction altText="Retry" onClick={retry}>Retry</ToastAction>
      : undefined,
  });
}

// ── Module-level handlers set by the app ────────────────────────────────────
let getAccessToken: (() => string | null) | null = null;
let refreshToken: (() => Promise<string>) | null = null;

/**
 * Set up global token handlers.
 * Called from the App component to connect the fetcher to the auth context.
 */
export function setupAdminFetcherHandlers(
  tokenGetter: () => string | null,
  tokenRefresher: () => Promise<string>
) {
  getAccessToken = tokenGetter;
  refreshToken = tokenRefresher;
}

// ── Shared onRefreshFailed handler ──────────────────────────────────────────
function onAdminRefreshFailed(_isTransient: boolean): void {
  const loginUrl = `${import.meta.env.BASE_URL || '/'}login`;
  safeSessionSet('admin_session_expired', 'Your session has expired. Please log in again.');
  window.location.href = loginUrl;
}

// ── Factory instances ────────────────────────────────────────────────────────
// Created at module load; callbacks close over module-level vars so they
// always use the latest handlers set by setupAdminFetcherHandlers.

const [_adminScopedFetcher] = createApiFetcher({
  baseUrl: '/api/admin',
  getToken: () => getAccessToken?.() ?? null,
  setToken: () => { /* no-op: refreshFn (auth context) manages in-memory state */ },
  onRefreshFailed: onAdminRefreshFailed,
  refreshFn: () => {
    if (!refreshToken) throw new Error('Admin fetcher not initialized');
    return refreshToken();
  },
  extraHeaders: () => ({
    'Content-Type': 'application/json',
    'X-CSRF-Token': readCsrfFromCookie(),
  }),
  timeoutMs: FETCH_TIMEOUT_MS,
  credentialsMode: 'include',
});

const [_adminAbsoluteFetcher] = createApiFetcher({
  baseUrl: '',
  getToken: () => getAccessToken?.() ?? null,
  setToken: () => { /* no-op: refreshFn (auth context) manages in-memory state */ },
  onRefreshFailed: onAdminRefreshFailed,
  refreshFn: () => {
    if (!refreshToken) throw new Error('Admin fetcher not initialized');
    return refreshToken();
  },
  extraHeaders: () => ({
    'Content-Type': 'application/json',
    'X-CSRF-Token': readCsrfFromCookie(),
  }),
  timeoutMs: FETCH_TIMEOUT_MS,
  credentialsMode: 'include',
});

// ── Internal helper ──────────────────────────────────────────────────────────

/**
 * Pre-refresh when there is no access token, to avoid a redundant request
 * roundtrip. Falls back to the factory's automatic 401-refresh when the
 * pre-refresh itself fails.
 */
async function ensureToken(context: string): Promise<void> {
  if (getAccessToken?.()) return;
  try {
    await refreshToken!();
  } catch (err) {
    console.error(`Token refresh failed (no token, ${context}):`, err);
    const loginUrl = `${import.meta.env.BASE_URL || '/'}login`;
    safeSessionSet('admin_session_expired', 'Your session has expired. Please log in again.');
    window.location.href = loginUrl;
    throw err;
  }
}

// ── Public fetch functions ───────────────────────────────────────────────────

/**
 * Admin API fetcher scoped to `/api/admin/*`.
 * Handles: Bearer token, CSRF, 30-second timeout (with toast), auto-refresh.
 */
export async function fetchAdmin(
  endpoint: string,
  options: RequestInit = {}
): Promise<any> {
  if (!getAccessToken || !refreshToken) {
    throw new Error('Admin fetcher not initialized. Call setupAdminFetcherHandlers first.');
  }

  await ensureToken('fetchAdmin');

  const signal = timeoutSignal(FETCH_TIMEOUT_MS, options.signal as AbortSignal | undefined);
  try {
    const res = await _adminScopedFetcher(endpoint, { ...options, signal });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new AdminFetchError(errorData.error || `HTTP ${res.status}`, res.status);
    }
    return res.json();
  } catch (err) {
    if (err instanceof RefreshError) {
      throw new Error('Session expired. Please log in again.');
    }
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    // FetchTimeoutError = factory's own timer fired (retry or parallel race).
    // TimeoutError = admin's own timer fired (initial request signal).
    const isTimeout =
      err instanceof TimeoutError ||
      err instanceof FetchTimeoutError ||
      reason instanceof TimeoutError;
    if (isTimeout) {
      handleTimeoutError(new TimeoutError(), () => { fetchAdmin(endpoint, options).catch(() => {}); });
      throw new TimeoutError();
    }
    throw err;
  }
}

/**
 * Same as fetchAdmin but takes an absolute API path (e.g. `/api/kyc/…`,
 * `/api/payments/…`) instead of being scoped to `/api/admin`.
 * Use this for admin-authenticated routes that live outside `/api/admin/*`.
 */
export async function fetchAdminAbsolute(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  if (!getAccessToken || !refreshToken) {
    throw new Error('Admin fetcher not initialized. Call setupAdminFetcherHandlers first.');
  }
  if (!path.startsWith('/')) {
    throw new Error(`fetchAdminAbsolute requires an absolute path starting with "/", got: ${path}`);
  }

  await ensureToken('fetchAdminAbsolute');

  const signal = timeoutSignal(FETCH_TIMEOUT_MS, options.signal as AbortSignal | undefined);
  try {
    const res = await _adminAbsoluteFetcher(path, { ...options, signal });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new AdminFetchError(errorData.error || `HTTP ${res.status}`, res.status);
    }
    return res.json();
  } catch (err) {
    if (err instanceof RefreshError) {
      throw new Error('Session expired. Please log in again.');
    }
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    const isTimeout =
      err instanceof TimeoutError ||
      err instanceof FetchTimeoutError ||
      reason instanceof TimeoutError;
    if (isTimeout) {
      handleTimeoutError(new TimeoutError(), () => { fetchAdminAbsolute(path, options).catch(() => {}); });
      throw new TimeoutError();
    }
    throw err;
  }
}

/**
 * Same as fetchAdminAbsolute but returns the raw Response (not parsed JSON).
 * Use for binary downloads (blobs, CSV exports) while still benefiting from
 * Bearer + CSRF + auto-refresh.
 */
export async function fetchAdminAbsoluteResponse(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  if (!getAccessToken || !refreshToken) {
    throw new Error('Admin fetcher not initialized. Call setupAdminFetcherHandlers first.');
  }
  if (!path.startsWith('/')) {
    throw new Error(`fetchAdminAbsoluteResponse requires an absolute path starting with "/", got: ${path}`);
  }

  await ensureToken('fetchAdminAbsoluteResponse');

  const signal = timeoutSignal(FETCH_TIMEOUT_MS, options.signal as AbortSignal | undefined);
  try {
    return await _adminAbsoluteFetcher(path, { ...options, signal });
  } catch (err) {
    if (err instanceof RefreshError) {
      throw new Error('Session expired. Please log in again.');
    }
    const reason = (signal as AbortSignal & { reason?: unknown }).reason;
    const isTimeout =
      err instanceof TimeoutError ||
      err instanceof FetchTimeoutError ||
      reason instanceof TimeoutError;
    if (isTimeout) {
      handleTimeoutError(new TimeoutError(), () => { fetchAdminAbsoluteResponse(path, options).catch(() => {}); });
      throw new TimeoutError();
    }
    throw err;
  }
}

/**
 * Read the current in-memory access token (or null). Useful for non-fetch
 * call sites such as Socket.IO `auth` payloads.
 */
export function getAdminAccessToken(): string | null {
  return getAccessToken ? getAccessToken() : null;
}

// ============================================================================
// Drop-in replacements for legacy api.ts helpers
// These mirror the exact data-unwrapping behaviour of the old `fetcher` and
// `apiAbsoluteFetch` so every page can be migrated with a pure import swap.
// ============================================================================

/**
 * Authenticated admin fetch scoped to `/api/admin/*`.
 * Unwraps `response.data` when present — identical to the old `fetcher()`.
 */
export async function adminFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const result = await fetchAdmin(endpoint, options);
  return result?.data !== undefined ? result.data : result;
}

/**
 * Authenticated admin fetch against an absolute API path (e.g. `/api/kyc/…`).
 * Unwraps `response.data` when present — identical to the old `apiAbsoluteFetch()`.
 */
export async function adminAbsoluteFetch(path: string, options: RequestInit = {}): Promise<any> {
  const result = await fetchAdminAbsolute(path, options);
  return result?.data !== undefined ? result.data : result;
}

/**
 * Convenience methods for common HTTP verbs
 */
export async function adminGet(endpoint: string): Promise<any> {
  return fetchAdmin(endpoint, { method: 'GET' });
}

export async function adminPost(endpoint: string, data?: any): Promise<any> {
  return fetchAdmin(endpoint, {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  });
}

export async function adminPut(endpoint: string, data?: any): Promise<any> {
  return fetchAdmin(endpoint, {
    method: 'PUT',
    body: data ? JSON.stringify(data) : undefined,
  });
}

export async function adminDelete(endpoint: string): Promise<any> {
  return fetchAdmin(endpoint, { method: 'DELETE' });
}

export async function adminPatch(endpoint: string, data?: any): Promise<any> {
  return fetchAdmin(endpoint, {
    method: 'PATCH',
    body: data ? JSON.stringify(data) : undefined,
  });
}
