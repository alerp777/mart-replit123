/**
 * Shared API Fetcher Factory
 *
 * Creates a per-app fetch function that centralises:
 *   - Bearer token injection (from getToken callback)
 *   - Configurable AbortController timeout (per-instance or per-call)
 *   - 401 → refresh → retry with a mutex (one concurrent refresh per instance)
 *   - Pluggable refresh via URL endpoint or custom async function
 *   - Extra headers per request and per refresh (CSRF, X-App, etc.)
 */

export type RefreshResult = "refreshed" | "transient" | "auth_failed";

/** Thrown by the CoreFetch function when a 401-triggered refresh fails. */
export class RefreshError extends Error {
  readonly isTransient: boolean;
  constructor(isTransient: boolean) {
    super(
      isTransient
        ? "Refresh failed: network error"
        : "Refresh failed: session invalid"
    );
    this.name = "RefreshError";
    this.isTransient = isTransient;
  }
}

export interface CreateApiFetcherConfig {
  /** Prepended to every path. Use "" for absolute-path fetchers. */
  baseUrl: string;

  /** Returns the current access token synchronously. */
  getToken: () => string | null;

  /**
   * Called after a successful URL-based refresh to store the new access token.
   * Not required when refreshFn is provided (the function handles storage itself).
   */
  setToken?: (token: string) => void;

  /** Returns the current refresh token for URL-based refresh body. */
  getRefreshToken?: () => string | null;

  /**
   * Called after a successful URL-based refresh to store the new refresh token
   * returned by the server.
   */
  setRefreshToken?: (token: string) => void;

  /**
   * Called when a 401 refresh fails, before RefreshError is thrown.
   * @param isTransient - true = network/5xx (keep tokens, surface recoverable error);
   *                      false = auth denied (clear tokens, log user out).
   */
  onRefreshFailed: (isTransient: boolean) => void;

  /**
   * Full URL to POST for a URL-based token refresh.
   * Mutually exclusive with refreshFn; one must be provided.
   */
  refreshEndpoint?: string;

  /**
   * Custom async refresh handler. Resolves to the new access token string, or
   * throws on any failure (treated as auth_failed — no transient distinction).
   * Mutually exclusive with refreshEndpoint; one must be provided.
   */
  refreshFn?: () => Promise<string>;

  /**
   * Returns extra headers merged into every regular request.
   * Called on each request so values (e.g. CSRF token) are always fresh.
   */
  extraHeaders?: () => Record<string, string>;

  /**
   * Returns extra headers added only to the internal URL-based refresh POST
   * (e.g. { "X-App": "vendor" }). Ignored when refreshFn is used.
   */
  extraRefreshHeaders?: () => Record<string, string>;

  /**
   * Default request timeout in ms. Pass a getter `() => ms` for dynamic
   * updates (e.g. from platform config). Set to 0 to disable.
   * Default: 15 000 ms.
   */
  timeoutMs?: number | (() => number);

  /** credentials mode for all requests. Default: "include". */
  credentialsMode?: RequestCredentials;
}

/** Extended RequestInit with an optional per-call timeout override. */
export type CoreFetchOpts = RequestInit & {
  /**
   * Per-call timeout in ms. Overrides the instance-level timeoutMs for this
   * specific request only. Set to 0 to disable timeout for this call.
   */
  _timeoutMs?: number;
};

/**
 * Function returned by createApiFetcher.
 * Returns a raw Response; callers handle status codes, body parsing, and errors.
 */
export type CoreFetch = (path: string, opts?: CoreFetchOpts) => Promise<Response>;

/**
 * Creates a fetch function with centralised auth handling for a single app.
 *
 * Returns a tuple: [coreFetch, triggerRefresh].
 * - coreFetch(path, opts) — drop-in for fetch(); adds auth, timeout, auto-refresh.
 * - triggerRefresh() — exposes the mutex-guarded refresh for external callers
 *   (e.g. the `api.refreshToken` method in vendor/rider apps).
 */
export function createApiFetcher(
  config: CreateApiFetcherConfig
): [CoreFetch, () => Promise<RefreshResult>] {
  const {
    baseUrl,
    getToken,
    setToken,
    getRefreshToken,
    setRefreshToken,
    onRefreshFailed,
    refreshEndpoint,
    refreshFn,
    extraHeaders,
    extraRefreshHeaders,
    timeoutMs: timeoutMsConfig = 15_000,
    credentialsMode = "include",
  } = config;

  if (!refreshEndpoint && !refreshFn) {
    throw new Error(
      "createApiFetcher: provide either refreshEndpoint or refreshFn"
    );
  }

  const getTimeoutMs: () => number =
    typeof timeoutMsConfig === "function"
      ? timeoutMsConfig
      : () => timeoutMsConfig;

  // ── Mutex: one concurrent refresh per factory instance ────────────────────
  let _refreshPromise: Promise<RefreshResult> | null = null;

  async function doRefresh(): Promise<RefreshResult> {
    if (refreshFn) {
      try {
        const newToken = await refreshFn();
        if (setToken) setToken(newToken);
        return "refreshed";
      } catch {
        return "auth_failed";
      }
    }

    const bodyToken = getRefreshToken?.() ?? null;
    try {
      const res = await fetch(refreshEndpoint!, {
        method: "POST",
        credentials: credentialsMode,
        headers: {
          "Content-Type": "application/json",
          ...extraRefreshHeaders?.(),
        },
        body: JSON.stringify(bodyToken ? { refreshToken: bodyToken } : {}),
      });
      if (!res.ok) {
        return res.status >= 500 ? "transient" : "auth_failed";
      }
      const data = (await res.json()) as {
        token?: string;
        refreshToken?: string;
      };
      if (!data.token) return "auth_failed";
      if (setToken) setToken(data.token);
      if (data.refreshToken && setRefreshToken) setRefreshToken(data.refreshToken);
      return "refreshed";
    } catch {
      return "transient";
    }
  }

  function attemptRefresh(): Promise<RefreshResult> {
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = doRefresh();
    return _refreshPromise.finally(() => {
      _refreshPromise = null;
    });
  }

  // ── Header builder ────────────────────────────────────────────────────────
  function buildHeaders(opts: RequestInit): Headers {
    const headers = new Headers(opts.headers as HeadersInit | undefined);
    const token = getToken();
    if (token && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${token}`);
    }
    for (const [key, value] of Object.entries(extraHeaders?.() ?? {})) {
      if (!headers.has(key)) headers.set(key, value);
    }
    return headers;
  }

  // ── Timeout signal builder ────────────────────────────────────────────────
  function withTimeout(
    ms: number,
    external?: AbortSignal
  ): [AbortSignal, () => void] {
    if (external) {
      return [external, () => {}];
    }
    if (ms <= 0) {
      return [new AbortController().signal, () => {}];
    }
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), ms);
    ctrl.signal.addEventListener("abort", () => clearTimeout(tid), {
      once: true,
    });
    return [ctrl.signal, () => clearTimeout(tid)];
  }

  // ── Core fetch function ───────────────────────────────────────────────────
  async function coreFetch(
    path: string,
    opts: CoreFetchOpts = {}
  ): Promise<Response> {
    const { _timeoutMs: callTimeout, ...fetchOpts } = opts;
    const effectiveTimeout =
      callTimeout !== undefined ? callTimeout : getTimeoutMs();
    const external = fetchOpts.signal as AbortSignal | undefined;
    const [signal, cancelTimeout] = withTimeout(
      external ? 0 : effectiveTimeout,
      external
    );
    const headers = buildHeaders(fetchOpts);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...fetchOpts,
        headers,
        signal,
        credentials: credentialsMode,
      });
    } finally {
      cancelTimeout();
    }

    if (res.status !== 401) {
      return res;
    }

    // ── 401 → refresh (mutex) → retry once ───────────────────────────────
    const result = await attemptRefresh();

    if (result === "transient") {
      onRefreshFailed(true);
      throw new RefreshError(true);
    }

    if (result === "auth_failed") {
      onRefreshFailed(false);
      throw new RefreshError(false);
    }

    // Refreshed — retry once with the new token
    const retryHeaders = buildHeaders(fetchOpts); // picks up new token via getToken()
    const retryTimeout = getTimeoutMs();
    const [retrySignal, cancelRetryTimeout] = withTimeout(retryTimeout);
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...fetchOpts,
        headers: retryHeaders,
        signal: retrySignal,
        credentials: credentialsMode,
      });
    } finally {
      cancelRetryTimeout();
    }
  }

  return [coreFetch, attemptRefresh];
}
