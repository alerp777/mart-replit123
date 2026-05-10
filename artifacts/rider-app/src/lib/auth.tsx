import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, tokenStoreReady } from "./api";
import { executeLogoutSequence } from "./logoutSequence";

/* A2: UTF-8 safe JWT decoder (COMPLETED) */
function decodeJwtExp(tok: string): number | null {
  try {
    const parts = tok.split(".");
    if (parts.length !== 3) return null;
    const b64 = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    /* UTF-8 safe decoder for non-ASCII claim values */
    const payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export interface AuthUser {
  id: string; phone: string; name?: string; email?: string;
  avatar?: string; isOnline: boolean; walletBalance: number;
  isRestricted?: boolean;
  approvalStatus?: string;
  rejectionReason?: string | null;
  role?: string; roles?: string;
  createdAt?: string; lastLoginAt?: string;
  stats: { deliveriesToday: number; earningsToday: number; totalDeliveries: number; totalEarnings: number; rating?: number };
  cnic?: string; city?: string; address?: string; emergencyContact?: string;
  vehicleType?: string; vehiclePlate?: string; vehiclePhoto?: string;
  vehicleRegNo?: string; drivingLicense?: string;
  bankName?: string; bankAccount?: string; bankAccountTitle?: string;
  twoFactorEnabled?: boolean;
  /** Document photo URLs — uploaded separately for admin verification */
  cnicDocUrl?: string | null;
  licenseDocUrl?: string | null;
  /** Registration document photo URL */
  regDocUrl?: string | null;
  /** Personal daily earnings goal set by the rider; null means use admin default */
  dailyGoal?: number | null;
}

interface AuthCtx {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  twoFactorPending: boolean;
  setTwoFactorPending: (v: boolean) => void;
  login: (token: string, user: AuthUser, refreshToken?: string) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({} as AuthCtx);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser]   = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [twoFactorPending, setTwoFactorPending] = useState(false);
  const refreshFailCountRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshingRef = useRef(false);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleProactiveRefresh = useCallback((tok: string) => {
    clearRefreshTimer();
    const exp = decodeJwtExp(tok);
    if (!exp) return;
    const refreshIn = Math.max((exp * 1000 - Date.now()) - 60_000, 10_000);
    refreshTimerRef.current = setTimeout(async () => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      try {
        const result = await api.refreshToken();
        if (result === "refreshed") {
          const newToken = api.getToken();
          if (newToken) {
            setToken(newToken);
            scheduleProactiveRefresh(newToken);
          }
        } else if (result === "auth_failed") {
          api.clearTokens();
          setToken(null);
          setUser(null);
        } else if (result === "transient") {
          /* A3: Apply exponential backoff on transient failures (COMPLETED) */
          refreshFailCountRef.current++;
          if (refreshFailCountRef.current <= 5) {
            const backoffMs = Math.min(60_000 * Math.pow(2, refreshFailCountRef.current - 1), 15 * 60_000);
            refreshTimerRef.current = setTimeout(() => {
              const currentToken = api.getToken();
              if (currentToken) scheduleProactiveRefresh(currentToken);
            }, backoffMs);
          } else {
            /* Bail after ~5 failures */
            api.clearTokens();
            setToken(null);
            setUser(null);
            try {
              window.dispatchEvent(new CustomEvent("ajkmart:refresh-user-failed"));
            } catch {}
          }
          refreshingRef.current = false;
          return; /* Don't fall through to finally */
        }
      } catch {
        /* A3: Network errors also get backoff */
        refreshFailCountRef.current++;
        if (refreshFailCountRef.current <= 5) {
          const backoffMs = Math.min(60_000 * Math.pow(2, refreshFailCountRef.current - 1), 15 * 60_000);
          refreshTimerRef.current = setTimeout(() => {
            const currentToken = api.getToken();
            if (currentToken) scheduleProactiveRefresh(currentToken);
          }, backoffMs);
        }
      } finally {
        refreshingRef.current = false;
      }
    }, refreshIn);
  }, [clearRefreshTimer]);

  useEffect((): () => void => {
    /* Await Preferences token hydration before reading getToken() — otherwise
       a rider who was logged in on a previous session will be treated as
       unauthenticated because _inMemoryAccessToken hasn't been populated yet
       from the async Preferences.get() call. */
    const controller = new AbortController();
    (async () => {
      try {
        await tokenStoreReady;
      } catch (storeErr) {
        /* Secure token store (Capacitor Preferences) failed to initialise.
           This is a hard error: we cannot safely read the persisted token, so
           we clear any stale in-memory state and surface an auth failure rather
           than silently treating the session as unauthenticated. */
        console.error("[auth] tokenStoreReady failed — secure storage unavailable:", storeErr);
        api.clearTokens();
        setLoading(false);
        /* Dispatch so any listening component can show a "storage unavailable"
           banner or toast instead of a blank/stuck login screen. */
        try {
          window.dispatchEvent(new CustomEvent("ajkmart:storage-error", {
            detail: { message: "Secure storage unavailable. Please reinstall the app or clear app data." },
          }));
        } catch {}
        return;
      }
      if (controller.signal.aborted) return;
      const t = api.getToken();
      if (!t) { setLoading(false); return; }
      setToken(t);
      try {
        const u = await api.getMe(controller.signal);
        if (controller.signal.aborted) return;
        const roles = (u.roles || u.role || "").split(",").map((r: string) => r.trim());
        if ((u.roles || u.role) && !roles.includes("rider")) {
          api.clearTokens();
          setToken(null);
          return;
        }
        setUser(u);
        refreshFailCountRef.current = 0;
        scheduleProactiveRefresh(t);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        const errAny = err as Record<string, unknown>;
        if (errAny.code === "APPROVAL_PENDING") {
          setUser({ id: "", phone: "", isOnline: false, walletBalance: 0, approvalStatus: "pending", stats: { deliveriesToday: 0, earningsToday: 0, totalDeliveries: 0, totalEarnings: 0 } });
          return;
        }
        if (errAny.code === "APPROVAL_REJECTED") {
          setUser({ id: "", phone: "", isOnline: false, walletBalance: 0, approvalStatus: "rejected", rejectionReason: (errAny.rejectionReason as string | undefined) ?? null, stats: { deliveriesToday: 0, earningsToday: 0, totalDeliveries: 0, totalEarnings: 0 } });
          return;
        }
        api.clearTokens();
        setToken(null);
      } finally {
        setLoading(false);
      }
    })();
    return () => { controller.abort(); clearRefreshTimer(); };
  }, [scheduleProactiveRefresh, clearRefreshTimer]);

  /* Register module-level logout callback so api.ts can trigger logout directly
     without relying only on the CustomEvent system. Also keep the CustomEvent
     listener as a secondary mechanism (it's useful for cross-tab scenarios). */
  useEffect(() => {
    const clearAuth = () => { setToken(null); setUser(null); };

    const unregister = api.registerLogoutCallback(clearAuth);

    const handleLogoutEvent = () => clearAuth();
    window.addEventListener("ajkmart:logout", handleLogoutEvent);

    return () => {
      unregister();
      window.removeEventListener("ajkmart:logout", handleLogoutEvent);
    };
  }, []);

  const login = (t: string, u: AuthUser, refreshToken?: string) => {
    const roles = (u.roles || u.role || "").split(",").map((r: string) => r.trim());
    if ((u.roles || u.role) && !roles.includes("rider")) {
      throw new Error("This app is for riders only");
    }
    queryClient.clear();
    api.storeTokens(t, refreshToken);
    setToken(t);
    setUser(u);
    refreshFailCountRef.current = 0;
    scheduleProactiveRefresh(t);
  };

  const logout = () => {
    clearRefreshTimer();
    executeLogoutSequence(api, () => {
      setToken(null);
      setUser(null);
      queryClient.clear();
    });
  };

  const refreshUserInflightRef = useRef<Promise<void> | null>(null);

  const refreshUser = useCallback(async () => {
    if (refreshUserInflightRef.current) return refreshUserInflightRef.current;
    const p = (async () => {
      try {
        const u = await api.getMe();
        setUser(u);
        refreshFailCountRef.current = 0;
      } catch {
        refreshFailCountRef.current += 1;
        if (refreshFailCountRef.current >= 3) {
          window.dispatchEvent(new CustomEvent("ajkmart:refresh-user-failed", {
            detail: { count: refreshFailCountRef.current },
          }));
        }
      } finally {
        refreshUserInflightRef.current = null;
      }
    })();
    refreshUserInflightRef.current = p;
    return p;
  }, []);

  return <Ctx.Provider value={{ user, token, loading, twoFactorPending, setTwoFactorPending, login, logout, refreshUser }}>{children}</Ctx.Provider>;
}
