import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PwaInstallBanner } from "@/components/PwaInstallBanner";
import { OnlineStatusBanner } from "@/components/OnlineStatusBanner";
import { useLanguage } from "@/lib/useLanguage";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorRetry } from "@/components/ui/ErrorRetry";
import { initSentry, setSentryUser } from "@/lib/sentry";
import { initAnalytics, identifyUser } from "@/lib/analytics";
import { registerPush } from "@/lib/push";
import { initErrorReporter, reportError } from "@/lib/error-reporter";
import { AdminAuthProvider, useAdminAuth } from "@/lib/adminAuthContext";
import { usePermissions } from "@/hooks/usePermissions";
import { setupAdminFetcherHandlers } from "@/lib/adminFetcher";
import { auditAdminEnv } from "@/lib/envValidation";
import { bootAccessibilitySettings } from "@/lib/useAccessibilitySettings";
import { useVersionCheck } from "@/hooks/useVersionCheck";

// Run env audit once at module load so warnings appear before any
// component depends on `import.meta.env.BASE_URL` etc.
// The typed result is consumed below in place of raw import.meta.env access.
const _adminEnv = auditAdminEnv();
// Apply persisted font-scale + contrast on boot so the very first paint
// already honours the admin's accessibility preferences.
bootAccessibilitySettings();

// Layout & Pages
import { AdminLayout } from "@/components/layout/AdminLayout";
import { FirstLoginCredentialsDialog } from "@/components/FirstLoginCredentialsDialog";
import Login from "@/pages/login";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
import SetNewPassword from "@/pages/set-new-password";
import RolesPermissions from "@/pages/roles-permissions";
import Dashboard from "@/pages/dashboard";
import Users from "@/pages/users";
import Orders from "@/pages/orders";
import Rides from "@/pages/rides";
import Pharmacy from "@/pages/pharmacy";
import Parcel from "@/pages/parcel";
import Products from "@/pages/products";
import Broadcast from "@/pages/broadcast";
import Transactions from "@/pages/transactions";
import Settings from "@/pages/settings";
const AnalyticsPage     = lazy(() => import("@/pages/analytics"));
const BusinessRulesPage = lazy(() => import("@/pages/business-rules"));
import FlashDeals from "@/pages/flash-deals";
import Categories from "@/pages/categories";
import Banners from "@/pages/banners";
import AppManagement from "@/pages/app-management";
import AccessibilityPage from "@/pages/accessibility";
import ConsentLogPage from "@/pages/consent-log";
import VendorInventorySettingsPage from "@/pages/vendor-inventory-settings";
import Vendors from "@/pages/vendors";
import Riders from "@/pages/riders";
import PromoCodes from "@/pages/promo-codes";
import Withdrawals from "@/pages/Withdrawals";
import DepositRequests from "@/pages/DepositRequests";
import Security from "@/pages/security";
// Heavy map/dashboard routes are code-split — react-leaflet, mapbox-gl,
// recharts, and the long error-monitor / communication panels add ~1MB
// of JS that should not block the initial admin shell. React.lazy +
// Suspense delivers the chunk only when the admin actually navigates to
// the route.
const LiveRidersMap = lazy(() => import("@/pages/live-riders-map"));
import SosAlerts from "@/pages/sos-alerts";
import ReviewsPage from "@/pages/reviews";
import KycPage from "@/pages/kyc";
import VanService from "@/pages/van";
import DeliveryAccess from "@/pages/delivery-access";
import Popups from "@/pages/popups";
import PromotionsHub from "@/pages/promotions-hub";
import SupportChat from "@/pages/support-chat";
import FaqManagement from "@/pages/faq-management";
const ErrorMonitor = lazy(() => import("@/pages/error-monitor"));
const Communication = lazy(() => import("@/pages/communication"));
import Loyalty from "@/pages/loyalty";
import WalletTransfers from "@/pages/wallet-transfers";
import ChatMonitor from "@/pages/chat-monitor";
import QrCodes from "@/pages/qr-codes";
import Experiments from "@/pages/experiments";
import WebhookManager from "@/pages/webhook-manager";
import DeepLinks from "@/pages/deep-links";
import Forbidden from "@/pages/forbidden";
import LaunchControl from "@/pages/launch-control";
import OtpControl from "@/pages/otp-control";

import AuthMethods from "@/pages/auth-methods";
import AuditLogs from "@/pages/audit-logs";
import WhatsAppDeliveryLog from "@/pages/whatsapp-delivery-log";
import HealthDashboard from "@/pages/health-dashboard";
import NotFound from "@/pages/not-found";

// Retry once on transient errors (network blips, 5xx) with a fixed 1 s pause,
// instead of the React Query default of retry:3 which causes multi-second
// stalls in the admin UI before a query is declared failed.
const QUERY_RETRY_COUNT = 1;
const QUERY_RETRY_DELAY_MS = 1_000;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: QUERY_RETRY_COUNT,
      retryDelay: QUERY_RETRY_DELAY_MS,
      refetchOnWindowFocus: false,
    },
  },
});

/* Auto-logout when an authenticated query returns 401.
   Guard: only remove token + redirect if we're actually logged in.
   This prevents pre-login query failures (expected 401s) from redirecting. */
interface QueryAuthError {
  message?: string;
  status?: number;
}

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const raw = event.action.error;
    const err: QueryAuthError =
      raw && typeof raw === "object" ? (raw as QueryAuthError) : {};
    const msg = (err.message || "").toLowerCase();
    const is401 =
      msg.includes("unauthorized") ||
      msg.includes("session expired") ||
      msg.includes("please log in") ||
      err.status === 401;
    // Note: Auth state is managed by adminAuthContext (in-memory only)
    // The fetcher will handle 401 with auto-refresh + redirect
    if (is401) {
      console.warn("[App] Received 401 from query - auth will be handled by fetcher");
    }
  }
});

/** How long (ms) before a stuck loader shows the error fallback. */
const LOADER_TIMEOUT_MS = 10_000;

/**
 * Shown as the Suspense fallback while heavy lazy-loaded routes (e.g.
 * live-riders-map) are being fetched. After 10 seconds it transitions to
 * an ErrorRetry so the admin always has a recovery path if the chunk fails.
 */
function RedirectTo({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(to, { replace: true }); }, [to, navigate]);
  return null;
}

function SuspenseLoadingFallback() {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), LOADER_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);
  if (timedOut) {
    return <ErrorRetry variant="page" title="Loading timed out" description="The page chunk took too long to load. Check your connection and try again." />;
  }
  return (
    <div className="flex items-center justify-center p-12">
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

/**
 * Hook that returns true after `ms` milliseconds while `loading` stays true.
 * Resets whenever `loading` flips to false.
 */
function useLoaderTimeout(loading: boolean, ms = LOADER_TIMEOUT_MS): boolean {
  const [timedOut, setTimedOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!loading) {
      setTimedOut(false);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    timerRef.current = setTimeout(() => setTimedOut(true), ms);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [loading, ms]);

  return timedOut;
}


function ProtectedRoute({
  component: Component,
  /**
   * When true, the route renders WITHOUT the standard AdminLayout chrome.
   * Used by the optional `/set-new-password` voluntary password-change
   * screen so it presents as a focused full-screen flow.
   *
   * Note: there is no longer a forced password-change gate. Admins who
   * land here just see the page; the optional first-login popup is
   * surfaced separately via <FirstLoginCredentialsDialog />.
   */
  bypassPasswordGate = false,
  requiredPermission,
}: {
  component: React.ComponentType;
  bypassPasswordGate?: boolean;
  requiredPermission?: string;
}) {
  const [, setLocation] = useLocation();
  const { state } = useAdminAuth();
  const { has, isSuper, legacyToken } = usePermissions();

  const permDenied = !!(requiredPermission && !isSuper && !legacyToken && !has(requiredPermission));
  const authTimedOut = useLoaderTimeout(state.isLoading);

  useEffect(() => {
    if (!state.isLoading && !state.accessToken) {
      setLocation("/login");
    }
  }, [state.accessToken, state.isLoading, setLocation]);

  useEffect(() => {
    if (!state.isLoading && state.accessToken && permDenied) {
      setLocation("/403");
    }
  }, [permDenied, state.isLoading, state.accessToken, setLocation]);

  if (state.isLoading) {
    if (authTimedOut) {
      return <ErrorRetry variant="page" title="Authentication taking too long" description="The authentication check is taking too long. This may be a connection issue." />;
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!state.accessToken) {
    return null;
  }

  if (permDenied) {
    return null;
  }

  // The set-new-password screen renders without the full admin chrome so the
  // user is not tempted to navigate elsewhere via the sidebar.
  if (bypassPasswordGate) {
    return (
      <ErrorBoundary fallback={
        <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
          <div className="text-4xl">⚠️</div>
          <h2 className="text-lg font-bold text-gray-900">Page crashed unexpectedly</h2>
          <p className="text-sm text-gray-500">An error occurred while loading this page.</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700">Reload</button>
        </div>
      }>
        <Component />
      </ErrorBoundary>
    );
  }

  return (
    <AdminLayout>
      <ErrorBoundary fallback={
        <div className="flex flex-col items-center justify-center gap-4 p-12 text-center rounded-xl border border-red-100 bg-red-50 m-4">
          <div className="text-4xl">⚠️</div>
          <h2 className="text-base font-bold text-red-900">This page crashed unexpectedly</h2>
          <p className="text-sm text-red-600">An error occurred while rendering this page. Other parts of the admin are unaffected.</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700">Reload Page</button>
        </div>
      }>
        {/* Suspense fallback only matters for the lazy-loaded heavy
            routes (live-riders-map, error-monitor, communication).
            Eager-imported pages render synchronously and skip it. */}
        <Suspense fallback={<SuspenseLoadingFallback />}>
          <Component />
        </Suspense>
      </ErrorBoundary>
      {/* Surfaces the OPTIONAL credentials popup whenever the admin is
          still on the seeded defaults and has not dismissed it for the
          session. Skipping is safe — defaults keep working. */}
      <FirstLoginCredentialsDialog />
    </AdminLayout>
  );
}

/* Root "/" gate: bounce authenticated users to the dashboard and
 * otherwise render the login page. The redirect must run from a
 * useEffect so wouter's navigate isn't called during render — calling
 * setLocation in a render body produces the "Cannot update a component
 * while rendering a different component" warning.
 */
function RootRedirect() {
  const { state } = useAdminAuth();
  const [, setLocation] = useLocation();
  const rootTimedOut = useLoaderTimeout(state.isLoading);

  useEffect(() => {
    if (state.isLoading) return;
    if (state.accessToken) {
      setLocation("/dashboard");
    }
  }, [state.isLoading, state.accessToken, setLocation]);

  if (state.isLoading) {
    if (rootTimedOut) {
      return <ErrorRetry variant="page" title="Session restore taking too long" description="Session restore is taking too long. Please reload to try again." />;
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (state.accessToken) {
    // Effect above will navigate; render nothing in the meantime.
    return null;
  }
  return <Login />;
}

function Router() {
  return (
    <Switch>
      {/* Public Routes */}
      <Route path="/login" component={Login} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      {/* Optional voluntary password-change screen. Reachable any time
          for admins who prefer the dedicated full-screen flow over the
          first-login popup. Renders without the AdminLayout chrome. */}
      <Route path="/set-new-password">
        <ProtectedRoute component={SetNewPassword} bypassPasswordGate />
      </Route>
      <Route path="/">
        <RootRedirect />
      </Route>

      {/* Protected Routes */}
      <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
      <Route path="/users"><ProtectedRoute component={Users} requiredPermission="users.view" /></Route>
      <Route path="/orders"><ProtectedRoute component={Orders} requiredPermission="orders.view" /></Route>
      <Route path="/rides"><ProtectedRoute component={Rides} requiredPermission="fleet.rides.view" /></Route>
      <Route path="/pharmacy"><ProtectedRoute component={Pharmacy} requiredPermission="fleet.pharmacy.view" /></Route>
      <Route path="/parcel"><ProtectedRoute component={Parcel} requiredPermission="fleet.parcel.view" /></Route>
      <Route path="/products"><ProtectedRoute component={Products} requiredPermission="content.products.view" /></Route>
      <Route path="/broadcast"><ProtectedRoute component={Broadcast} requiredPermission="support.broadcast.send" /></Route>
      <Route path="/communications"><ProtectedRoute component={Communication} requiredPermission="support.broadcast.send" /></Route>
      <Route path="/transactions"><ProtectedRoute component={Transactions} requiredPermission="finance.transactions.view" /></Route>
      <Route path="/revenue-analytics"><RedirectTo to="/analytics?tab=revenue" /></Route>
      <Route path="/analytics"><ProtectedRoute component={AnalyticsPage} requiredPermission="finance.transactions.view" /></Route>
      {/*
        Settings hub deep links: `/settings/:section` and
        `/settings/:section/:subsection`. The hub component reads route
        params via `useParams` from wouter and falls back to the legacy
        `?tab=` / `?cat=` query strings so existing bookmarks keep working.
      */}
      <Route path="/settings"><ProtectedRoute component={Settings} requiredPermission="system.settings.view" /></Route>
      <Route path="/settings/:section"><ProtectedRoute component={Settings} requiredPermission="system.settings.view" /></Route>
      <Route path="/settings/:section/:subsection"><ProtectedRoute component={Settings} requiredPermission="system.settings.view" /></Route>
      <Route path="/flash-deals"><ProtectedRoute component={FlashDeals} requiredPermission="promotions.view" /></Route>
      <Route path="/categories"><ProtectedRoute component={Categories} requiredPermission="content.products.view" /></Route>
      <Route path="/banners"><ProtectedRoute component={Banners} requiredPermission="content.products.view" /></Route>
      <Route path="/app-management"><ProtectedRoute component={AppManagement} requiredPermission="system.settings.view" /></Route>
      <Route path="/vendors"><ProtectedRoute component={Vendors} requiredPermission="vendors.view" /></Route>
      <Route path="/riders"><ProtectedRoute component={Riders} requiredPermission="fleet.rides.view" /></Route>
      <Route path="/promo-codes"><ProtectedRoute component={PromoCodes} requiredPermission="promotions.view" /></Route>
      <Route path="/notifications"><RedirectTo to="/communications?tab=log" /></Route>
      <Route path="/withdrawals"><ProtectedRoute component={Withdrawals} requiredPermission="finance.withdrawals.view" /></Route>
      <Route path="/deposit-requests"><ProtectedRoute component={DepositRequests} requiredPermission="finance.deposits.review" /></Route>
      <Route path="/security"><ProtectedRoute component={Security} requiredPermission="system.settings.view" /></Route>
      <Route path="/sos-alerts"><ProtectedRoute component={SosAlerts} requiredPermission="fleet.rides.view" /></Route>
      <Route path="/live-riders-map"><ProtectedRoute component={LiveRidersMap} requiredPermission="fleet.rides.view" /></Route>
      <Route path="/reviews"><ProtectedRoute component={ReviewsPage} requiredPermission="content.products.view" /></Route>
      <Route path="/kyc"><ProtectedRoute component={KycPage} requiredPermission="finance.kyc.view" /></Route>
      <Route path="/van"><ProtectedRoute component={VanService} requiredPermission="fleet.rides.view" /></Route>
      <Route path="/delivery-access"><ProtectedRoute component={DeliveryAccess} requiredPermission="vendors.view" /></Route>
      <Route path="/account-conditions"><RedirectTo to="/business-rules?tab=conditions" /></Route>
      <Route path="/condition-rules"><RedirectTo to="/business-rules?tab=rules" /></Route>
      <Route path="/popups"><ProtectedRoute component={Popups} requiredPermission="content.products.view" /></Route>
      <Route path="/promotions"><ProtectedRoute component={PromotionsHub} requiredPermission="promotions.view" /></Route>
      <Route path="/support-chat"><ProtectedRoute component={SupportChat} requiredPermission="support.chat.view" /></Route>
      <Route path="/faq-management"><ProtectedRoute component={FaqManagement} requiredPermission="content.products.view" /></Route>
      <Route path="/search-analytics"><RedirectTo to="/analytics?tab=search" /></Route>
      <Route path="/error-monitor"><ProtectedRoute component={ErrorMonitor} requiredPermission="system.settings.view" /></Route>
      <Route path="/communication"><RedirectTo to="/communications?tab=kpis" /></Route>
      <Route path="/loyalty"><ProtectedRoute component={Loyalty} requiredPermission="promotions.view" /></Route>
      <Route path="/wallet-transfers"><ProtectedRoute component={WalletTransfers} requiredPermission="finance.transactions.view" /></Route>
      <Route path="/chat-monitor"><ProtectedRoute component={ChatMonitor} requiredPermission="support.chat.view" /></Route>
      <Route path="/wishlist-insights"><RedirectTo to="/analytics?tab=users" /></Route>
      <Route path="/business-rules"><ProtectedRoute component={BusinessRulesPage} requiredPermission="system.settings.view" /></Route>
      <Route path="/qr-codes"><ProtectedRoute component={QrCodes} requiredPermission="content.products.view" /></Route>
      <Route path="/experiments"><ProtectedRoute component={Experiments} requiredPermission="system.settings.view" /></Route>
      <Route path="/webhooks"><ProtectedRoute component={WebhookManager} requiredPermission="system.settings.view" /></Route>
      <Route path="/deep-links"><ProtectedRoute component={DeepLinks} requiredPermission="content.products.view" /></Route>
      <Route path="/launch-control"><ProtectedRoute component={LaunchControl} requiredPermission="system.maintenance" /></Route>
      <Route path="/otp-control"><ProtectedRoute component={OtpControl} requiredPermission="system.settings.edit" /></Route>
      <Route path="/sms-gateways"><RedirectTo to="/communications?tab=settings" /></Route>
      <Route path="/auth-methods"><ProtectedRoute component={AuthMethods} requiredPermission="system.settings.edit" /></Route>
      <Route path="/roles-permissions"><ProtectedRoute component={RolesPermissions} requiredPermission="system.roles.manage" /></Route>
      <Route path="/audit-logs"><ProtectedRoute component={AuditLogs} requiredPermission="system.audit.view" /></Route>
      <Route path="/whatsapp-delivery-log"><ProtectedRoute component={WhatsAppDeliveryLog} requiredPermission="system.settings.view" /></Route>
      <Route path="/accessibility"><ProtectedRoute component={AccessibilityPage} requiredPermission="system.settings.view" /></Route>
      <Route path="/consent-log"><ProtectedRoute component={ConsentLogPage} requiredPermission="system.audit.view" /></Route>
      <Route path="/vendor-inventory-settings"><ProtectedRoute component={VendorInventorySettingsPage} requiredPermission="vendors.view" /></Route>
      <Route path="/health-dashboard"><ProtectedRoute component={HealthDashboard} requiredPermission="system.settings.view" /></Route>

      <Route path="/403"><Forbidden /></Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function VersionCheckInit() {
  useVersionCheck();
  return null;
}

function LanguageInit() {
  useLanguage();
  return null;
}

function IntegrationsInit() {
  const { state, refreshAccessToken } = useAdminAuth();

  useEffect(() => {
    // Setup fetcher with auth handlers
    setupAdminFetcherHandlers(
      () => state.accessToken,
      () => refreshAccessToken()
    );
    
  }, [state.accessToken, refreshAccessToken]);

  useEffect(() => {
    initErrorReporter();

    /* /api/* is proxied by Vite (and served by the api-server in production)
       regardless of BASE_URL. Prefixing with BASE_URL turned this into
       `/admin/api/platform-config`, which falls outside the proxy rule and
       returns the SPA index.html — silently breaking integrations init. */
    fetch(`/api/platform-config`)
      .then(r => r.ok ? r.json() : null)
      .then(raw => {
        if (!raw) return;
        const d = raw?.data ?? raw;
        const integ = d?.integrations;
        if (!integ) return;
        if (integ.sentry && integ.sentryDsn) {
          initSentry({
            dsn: integ.sentryDsn,
            environment: integ.sentryEnvironment || "production",
            sampleRate: integ.sentrySampleRate ?? 0.2,
            tracesSampleRate: integ.sentryTracesSampleRate ?? 0.1,
          });
        }
        if (integ.analytics && integ.analyticsTrackingId) {
          initAnalytics(integ.analyticsPlatform, integ.analyticsTrackingId, integ.analyticsDebug ?? false);
        }
      })
      .catch((err) => {
        console.error("[App] Platform config fetch failed:", err);
      });

    /* Register admin push when authenticated */
    if (state.accessToken && !state.isLoading) {
      if (typeof Notification !== "undefined" && Notification.requestPermission) {
        Notification.requestPermission()
          .then(perm => { if (perm === "granted") registerPush().catch((err: unknown) => { console.error("[App] Push registration failed:", err); }); })
          .catch((err: unknown) => { console.error("[App] Notification permission request failed:", err); });
      }
      setSentryUser(state.user?.id || "admin");
      identifyUser(state.user?.id || "admin");
    }
  }, [state.accessToken, state.user, state.isLoading]);

  return null;
}

function App() {
  return (
    <ErrorBoundary>
      <AdminAuthProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <WouterRouter base={_adminEnv.baseUrl.replace(/\/$/, "")}>
              <VersionCheckInit />
              <LanguageInit />
              <IntegrationsInit />
              <Router />
            </WouterRouter>
            <Toaster />
            <PwaInstallBanner />
            <OnlineStatusBanner />
          </TooltipProvider>
        </QueryClientProvider>
      </AdminAuthProvider>
    </ErrorBoundary>
  );
}

export default App;
