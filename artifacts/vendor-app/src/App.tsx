import { Component, type ReactNode, useEffect, useState, useRef } from "react";
import { useVersionCheck } from "@/hooks/useVersionCheck";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./lib/auth";
import { usePlatformConfig } from "./lib/useConfig";
import { useLanguage } from "./lib/useLanguage";
import { registerPush, consumePendingNotificationTap, type PushErrorHandler } from "./lib/push";
import { Capacitor } from "@capacitor/core";
import { initSentry, setSentryUser } from "./lib/sentry";
import { initAnalytics, trackEvent, identifyUser } from "./lib/analytics";
import { initErrorReporter } from "./lib/error-reporter";
import { setApiTimeoutMs, api } from "./lib/api";
import { vendorEnv } from "./lib/envValidation";
import { BottomNav } from "./components/BottomNav";
import { PwaInstallBanner } from "./components/PwaInstallBanner";
import { SideNav } from "./components/SideNav";
import { BOTTOM_PADDING } from "./lib/ui";
import { AnnouncementBar } from "./components/AnnouncementBar";
import { PopupEngine } from "./components/PopupEngine";
import { MaintenanceScreen } from "./components/MaintenanceScreen";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import Products from "./pages/Products";
import Store from "./pages/Store";
import Profile from "./pages/Profile";
import Wallet from "./pages/Wallet";
import Analytics from "./pages/Analytics";
import Notifications from "./pages/Notifications";
import Reviews from "./pages/Reviews";
import Promos from "./pages/Promos";
import Campaigns from "./pages/Campaigns";
import Chat from "./pages/Chat";

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full text-center shadow-xl">
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-extrabold text-gray-800 mb-2">Kuch galat ho gaya / Something went wrong</h2>
            <p className="text-sm text-gray-500 mb-4">
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              className="w-full h-11 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-xl text-sm">
              Dobara koshish karein / Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10000, refetchOnWindowFocus: true } },
});

function AppRoutes() {
  const { user, loading } = useAuth();
  const { config } = usePlatformConfig();
  useLanguage(); /* initialises RTL + language from API on mount */

  useEffect(() => { initErrorReporter(); }, []);

  /* ── Apply network/retry settings from platform config on startup ── */
  useEffect(() => {
    const net = config?.network;
    if (!net) return;
    if (typeof net.apiTimeoutMs === "number") setApiTimeoutMs(net.apiTimeoutMs);
  }, [config]);

  /* ── Sentry + Analytics init from platform config ── */
  useEffect(() => {
    const integ = config?.integrations;
    if (!integ) return;
    if (integ.sentry && integ.sentryDsn) {
      initSentry(integ.sentryDsn, integ.sentryEnvironment, integ.sentrySampleRate, integ.sentryTracesSampleRate);
    }
    if (integ.analytics && integ.analyticsTrackingId) {
      initAnalytics(integ.analyticsPlatform, integ.analyticsTrackingId, integ.analyticsDebug ?? false);
    }
  }, [config?.integrations]);

  const [, navigate] = useLocation();

  /* ── Cold-start notification tap: consume any tap captured before auth loaded ──
     When the vendor taps a new-order push notification from a killed app, the
     pushNotificationActionPerformed listener fires at module-load time and
     stashes the data.  We drain it here once the session is ready. */
  useEffect(() => {
    if (!user) return;
    const pending = consumePendingNotificationTap();
    if (pending?.orderId) {
      /* Fire-and-forget prefetch: seed the per-order cache so Orders.tsx
         renders the tapped order detail instantly from cache.
         Navigation is immediate — never blocked by network or prefetch outcome. */
      const orderId = pending.orderId;
      queryClient.prefetchQuery({
        queryKey: ["vendor-order", orderId],
        queryFn: () => api.getVendorOrder(orderId),
        staleTime: 30_000,
      }).catch(() => {});
      navigate(`/orders/${orderId}`);
    } else if (pending) {
      navigate("/orders");
    }
  }, [user?.id]);

  /* ── Push registration error state: shown as a dismissable banner ── */
  const [pushError, setPushError] = useState<"permission_denied" | "registration_failed" | "network_error" | null>(null);

  /* ── FCM foreground notification banner ── */
  const [fcmNotif, setFcmNotif] = useState<{ title: string; body: string; orderId?: string } | null>(null);
  const fcmCleanupRef = useRef<{ remove: () => void } | null>(null);
  const fcmDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!user) return undefined;
    const onForeground = (title: string, body: string, data?: Record<string, string>) => {
      /* Play a short notification sound for new-order events */
      const notifType = data?.type ?? "";
      if (notifType === "new_order" || notifType === "order_status") {
        try {
          type AudioCtxCtor = typeof AudioContext;
          const AudioCtxClass: AudioCtxCtor =
            window.AudioContext ??
            (window as Window & { webkitAudioContext?: AudioCtxCtor }).webkitAudioContext ??
            null!;
          if (!AudioCtxClass) return;
          const ctx = new AudioCtxClass();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.setValueAtTime(880, ctx.currentTime);
          gain.gain.setValueAtTime(0.3, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.4);
        } catch {}
      }
      /* Banner copy for cancellation and settlement types */
      let displayTitle = title;
      let displayBody = body;
      if (notifType === "order_cancelled") {
        displayTitle = "❌ Order Cancelled";
        displayBody = body || "An order has been cancelled.";
      } else if (notifType === "payment_settlement") {
        displayTitle = "💰 Payment Settled";
        displayBody = body || "A payment has been settled to your wallet.";
      }
      setFcmNotif({ title: displayTitle, body: displayBody, orderId: data?.orderId });
      if (fcmDismissTimer.current) clearTimeout(fcmDismissTimer.current);
      fcmDismissTimer.current = setTimeout(() => setFcmNotif(null), 5000);
    };
    /* When the vendor taps a push notification (background state), navigate
       to the specific order if orderId is provided. */
    const onNotificationTap = (data: Record<string, string>) => {
      if (data.orderId) {
        navigate(`/orders/${data.orderId}`);
      } else {
        navigate("/orders");
      }
    };
    const onPushError: PushErrorHandler = (reason) => {
      setPushError(reason);
    };

    if (Capacitor.isNativePlatform()) {
      registerPush(onForeground, onNotificationTap, onPushError).then(cleanup => {
        if (cleanup) fcmCleanupRef.current = cleanup;
      }).catch(() => {});
      return () => {
        fcmCleanupRef.current?.remove();
        if (fcmDismissTimer.current) clearTimeout(fcmDismissTimer.current);
      };
    }
    if (typeof Notification !== "undefined" && Notification.requestPermission) {
      Notification.requestPermission().then(perm => {
        if (perm === "granted") {
          registerPush(undefined, undefined, onPushError).catch(() => {});
        } else if (perm === "denied") {
          setPushError("permission_denied");
        }
      }).catch(() => {});
    }

    /* Re-register whenever the vendor tab regains focus so tokens stay fresh
       and any rotation that happened while backgrounded is picked up. */
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        registerPush(undefined, undefined, onPushError).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    /* Listen for SW_NAVIGATE messages from the service worker notificationclick handler.
       Normalize via URL() so both absolute URLs and path strings are handled safely. */
    const onSwMessage = (event: MessageEvent) => {
      if (event.data?.type === "SW_NAVIGATE" && event.data?.path) {
        try {
          const fullUrl = new URL(event.data.path as string, window.location.origin);
          const base = (import.meta.env.BASE_URL || "/vendor").replace(/\/$/, "");
          const appPath = fullUrl.pathname.replace(new RegExp(`^${base}`), "") || "/";
          navigate(appPath);
        } catch {
          navigate("/");
        }
      }
    };
    navigator.serviceWorker?.addEventListener("message", onSwMessage);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
    };
  }, [user?.id]);

  const MAINTENANCE_GRACE_MS = 5 * 60 * 1000; /* 5-minute grace period */
  const maintenanceSince = useRef<number | null>(null);
  const [maintenanceBlocked, setMaintenanceBlocked] = useState(false);
  const [maintenanceSecs, setMaintenanceSecs] = useState(0);

  useEffect(() => {
    if (config.platform.appStatus !== "maintenance") {
      maintenanceSince.current = null;
      setMaintenanceBlocked(false);
      return;
    }
    if (maintenanceSince.current === null) {
      maintenanceSince.current = Date.now();
    }
    const tick = () => {
      const elapsed = Date.now() - (maintenanceSince.current ?? Date.now());
      const remaining = Math.max(0, Math.ceil((MAINTENANCE_GRACE_MS - elapsed) / 1000));
      setMaintenanceSecs(remaining);
      if (elapsed >= MAINTENANCE_GRACE_MS) setMaintenanceBlocked(true);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [config.platform.appStatus]);

  if (loading) return (
    <div className="min-h-screen bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center">
      <div className="text-center">
        <div className="w-20 h-20 bg-white rounded-3xl flex items-center justify-center mx-auto mb-5 shadow-2xl">
          <span className="text-4xl">🏪</span>
        </div>
        <div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-white mt-4 font-semibold text-lg">Loading Vendor Portal...</p>
        <p className="text-orange-100 text-sm mt-1">{config.platform.appName} Business Partner</p>
      </div>
    </div>
  );

  if (!user) return <Login />;

  return (
    <div className="h-screen bg-gray-100 flex flex-col overflow-hidden">
      {/* ── Maintenance overlay: shown immediately but blocks after 5-min grace ── */}
      {config.platform.appStatus === "maintenance" && maintenanceBlocked && (
        <MaintenanceScreen message={config.content.maintenanceMsg} appName={config.platform.appName} />
      )}
      {config.platform.appStatus === "maintenance" && !maintenanceBlocked && maintenanceSecs > 0 && (
        <div className="fixed top-0 inset-x-0 z-50 bg-amber-500 text-white text-center py-2 px-4 text-xs font-bold shadow">
          ⚠️ {config.platform.appName} is in maintenance mode. Full screen in {Math.floor(maintenanceSecs / 60)}:{String(maintenanceSecs % 60).padStart(2, "0")}
        </div>
      )}
      {/* ── Limited-service banner: non-blocking strip shown when app_status = "limited" ── */}
      {config.platform.appStatus === "limited" && (
        <div className="fixed top-0 inset-x-0 z-50 bg-orange-400 text-white text-center py-2 px-4 text-xs font-bold shadow">
          ⚠️ Limited service — some features may be temporarily unavailable
        </div>
      )}

      {/* ── Push registration error banner ── */}
      {pushError && (
        <div className="fixed top-0 left-0 right-0 z-[10001] bg-amber-500 text-white text-xs font-semibold px-4 py-2.5 flex items-center gap-3 shadow-md">
          <span className="flex-1">
            {pushError === "permission_denied"
              ? "🔕 Order notifications are blocked. Go to browser settings → Site Settings → Notifications → Allow."
              : pushError === "network_error"
              ? "📡 Could not register for notifications. Check your connection."
              : "⚠️ Notification registration failed. Go to Settings → Test Notification to retry."}
          </span>
          <button onClick={() => setPushError(null)} className="flex-shrink-0 font-bold text-white/80 hover:text-white text-lg leading-none">×</button>
        </div>
      )}

      {/* ── FCM foreground notification banner ── */}
      {fcmNotif && (
        <button
          onClick={() => {
            if (fcmNotif.orderId) navigate(`/orders/${fcmNotif.orderId}`);
            setFcmNotif(null);
          }}
          className="fixed top-4 left-4 right-4 z-[10000] bg-orange-600 text-white text-sm font-semibold px-4 py-3 rounded-2xl shadow-xl text-left">
          <div className="font-bold truncate">{fcmNotif.title}</div>
          <div className="text-xs opacity-90 truncate">{fcmNotif.body}</div>
        </button>
      )}

      {/* ── Announcement bar (top, dismissable) ── */}
      <AnnouncementBar message={config.content.announcement} />
      <PopupEngine />

      <div className="flex flex-1 overflow-hidden">
        {/* ── Desktop Sidebar (hidden on mobile) ── */}
        <div className="hidden md:flex md:w-64 md:flex-shrink-0">
          <SideNav />
        </div>

        {/* ── Main Content ── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <div
            className="flex-1 overflow-y-auto scroll-momentum"
            style={{ paddingBottom: BOTTOM_PADDING }}
            id="main-scroll"
          >
            <div className="md:max-w-5xl md:mx-auto md:px-6 md:pb-8">
              <Switch>
                <Route path="/"><ErrorBoundary><Dashboard /></ErrorBoundary></Route>
                <Route path="/orders/:id">{(params) => <ErrorBoundary key={`order-${params.id}`}><Orders targetOrderId={params.id} /></ErrorBoundary>}</Route>
                <Route path="/orders"><ErrorBoundary><Orders /></ErrorBoundary></Route>
                <Route path="/products"><ErrorBoundary><Products /></ErrorBoundary></Route>
                <Route path="/wallet"><ErrorBoundary><Wallet /></ErrorBoundary></Route>
                <Route path="/analytics"><ErrorBoundary><Analytics /></ErrorBoundary></Route>
                <Route path="/reviews"><ErrorBoundary><Reviews /></ErrorBoundary></Route>
                <Route path="/promos"><ErrorBoundary><Promos /></ErrorBoundary></Route>
                <Route path="/campaigns"><ErrorBoundary><Campaigns /></ErrorBoundary></Route>
                <Route path="/chat"><ErrorBoundary><Chat /></ErrorBoundary></Route>
                <Route path="/store"><ErrorBoundary><Store /></ErrorBoundary></Route>
                <Route path="/notifications"><ErrorBoundary><Notifications /></ErrorBoundary></Route>
                <Route path="/profile"><ErrorBoundary><Profile /></ErrorBoundary></Route>
                <Route>
                  <div className="flex items-center justify-center h-64">
                    <div className="text-center">
                      <p className="text-4xl mb-3">🔍</p>
                      <p className="text-lg font-extrabold text-gray-700">Page not found</p>
                      <p className="text-sm text-gray-400 mt-1">This page doesn't exist</p>
                      <a href="/" className="mt-4 inline-block h-10 px-6 bg-orange-500 text-white font-bold rounded-xl text-sm leading-10">← Go Home</a>
                    </div>
                  </div>
                </Route>
              </Switch>
            </div>
          </div>

          {/* Mobile Bottom Nav */}
          <BottomNav />
        </div>
      </div>
    </div>
  );
}

function VersionCheckInit() {
  useVersionCheck();
  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <VersionCheckInit />
        <AuthProvider>
          <WouterRouter base={(() => {
              /* Use BASE_URL exactly as Vite computed it from vite.config's
                 `base` option:
                   "/"        → ""        (app mounted at site root)
                   "/vendor/" → "/vendor" (path-routed behind a proxy)
                 The previous logic forced "/vendor" whenever BASE_URL was
                 "/", which broke standalone deployments by mounting every
                 route under a non-existent /vendor prefix. */
              const raw = vendorEnv.baseUrl;
              if (typeof raw !== "string" || raw.length === 0) return "";
              return raw.replace(/\/$/, "");
            })()}>
            <AppRoutes />
          </WouterRouter>
          <PwaInstallBanner />
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
