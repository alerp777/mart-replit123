import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { setBaseUrl, setAuthTokenGetter, setOnApiError, setMaxRetryAttempts, setRetryBackoffBaseMs } from "@workspace/api-client-react";
import * as Linking from "expo-linking";
import { loadCoreFonts, loadUrduFonts } from "@/utils/fonts";
import { router, Stack, useSegments, type Href } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Platform, ScrollView, TouchableOpacity, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import { PopupEngine } from "@/components/PopupEngine";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { reportError as reportErrorToBackend, initErrorReporter } from "@/utils/error-reporter";
import { PwaInstallBanner } from "@/components/PwaInstallBanner";
import { registerServiceWorker } from "@/utils/register-service-worker";
import { initSentry, setSentryUser } from "@/utils/sentry";
import { initAnalytics, trackScreen, identifyUser } from "@/utils/analytics";
import { registerPush } from "@/utils/push";
import { AuthProvider, useAuth, hasRole } from "@/context/AuthContext";
import { hasSeenOnboarding } from "./onboarding";
import { CartProvider } from "@/context/CartContext";
import { FontSizeProvider } from "@/context/FontSizeContext";
import { LanguageProvider, useLanguage } from "@/context/LanguageContext";
import { PlatformConfigProvider, usePlatformConfig } from "@/context/PlatformConfigContext";
import { PerformanceProvider } from "@/context/PerformanceContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { ToastProvider } from "@/context/ToastContext";

import { OfflineBar, SlowConnectionBar } from "@/components/OfflineBar";
import { tDual, type TranslationKey } from "@workspace/i18n";

function DeferredProviders({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (!ready) return <>{children}</>;
  return (
    <CartProvider>
      <ToastProvider>{children}</ToastProvider>
    </CartProvider>
  );
}

/* Resolve the API host the web/native bundle should talk to.
   1. Build-time env (EXPO_PUBLIC_DOMAIN) wins — Expo statically inlines this.
   2. On web, fall back to the page's own host so single-port production
      deployments (where api-server serves the SPA bundle on the same origin)
      "just work" without a separate env var.
   On native, no fallback is possible — MisconfigScreen will be shown. */
const _envDomain = process.env.EXPO_PUBLIC_DOMAIN?.trim();
const _webHost =
  Platform.OS === "web" &&
  typeof window !== "undefined" &&
  typeof window.location !== "undefined" &&
  window.location.host
    ? window.location.host
    : "";
const _domain = _envDomain || _webHost;
if (_domain) setBaseUrl(`https://${_domain}/api`);

SplashScreen.preventAutoHideAsync();

if (Platform.OS === "web" && typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const msg: string = event?.reason?.message ?? String(event?.reason ?? "");
    const isRouterTimeout =
      /\b6000ms\b/.test(msg) ||
      /\b\d+ms timeout exceeded\b/.test(msg) ||
      (msg.includes("timeout") && msg.toLowerCase().includes("route"));
    if (isRouterTimeout) {
      event.preventDefault();
      if (__DEV__) console.warn("[AJKMart] Suppressed Expo Router startup timeout:", msg);
    }
  });
}

function WebShell({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== "web") return <>{children}</>;
  return (
    <View style={webStyles.bg}>
      <View style={webStyles.phone}>
        {children}
      </View>
    </View>
  );
}

const webStyles = Platform.OS === "web" ? StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: "#0a0f1e",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  phone: {
    width: "100%",
    maxWidth: 430,
    flex: 1,
    overflow: "hidden" as const,
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  },
}) : { bg: {}, phone: {} };

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      retryDelay: (attempt) => Math.floor(1500 * Math.pow(1.5, attempt - 1)),
      gcTime: 1000 * 60 * 60 * 24,
    },
  },
});

const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "ajkmart-query-cache",
  throttleTime: 2000,
});

const GUEST_BROWSABLE = new Set([
  "food", "mart", "ride", "pharmacy", "parcel", "product", "search",
  "cart", "categories",
]);

const AUTH_REDIRECT_CAP = 4;
const AUTH_REDIRECT_RESET_MS = 3000;

function AuthGuard() {
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const redirectCountRef = useRef(0);
  const redirectResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const safeReplace = (path: Href) => {
    if (redirectCountRef.current >= AUTH_REDIRECT_CAP) {
      console.error("[AuthGuard] Redirect loop detected — cap hit navigating to", path, ". Routing to /auth as safe fallback.");
      router.replace("/auth" as Href);
      return;
    }
    redirectCountRef.current += 1;
    if (redirectResetTimerRef.current) clearTimeout(redirectResetTimerRef.current);
    redirectResetTimerRef.current = setTimeout(() => { redirectCountRef.current = 0; }, AUTH_REDIRECT_RESET_MS);
    router.replace(path);
  };

  useEffect(() => {
    return () => { if (redirectResetTimerRef.current) clearTimeout(redirectResetTimerRef.current); };
  }, []);

  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === "auth";
    const inTabsGroup = segments[0] === "(tabs)";
    const inRootIndex = (segments as string[]).length === 0;
    const isBrowsable = GUEST_BROWSABLE.has(segments[0] as string);
    const inOnboarding = segments[0] === "onboarding";

    const isPublicRoute = inAuthGroup || inTabsGroup || inRootIndex || isBrowsable || inOnboarding;
    const onWrongAppScreen = segments[0] === "auth" && segments[1] === "wrong-app";

    if (!user && !isPublicRoute) {
      hasSeenOnboarding().then(seen => {
        if (!seen) safeReplace("/onboarding");
        else safeReplace("/auth");
      }).catch(() => { safeReplace("/auth"); });
    } else if (!user && inRootIndex) {
      hasSeenOnboarding().then(seen => {
        if (!seen) safeReplace("/onboarding");
        else safeReplace("/auth");
      }).catch(() => { safeReplace("/auth"); });
    } else if (user && !hasRole(user, "customer") && !onWrongAppScreen) {
      safeReplace("/auth/wrong-app");
    } else if (user && hasRole(user, "customer") && (inAuthGroup || inRootIndex)) {
      safeReplace("/(tabs)");
    }
  }, [user, isLoading, segments]);

  return null;
}

function SuspendedScreen() {
  const { suspendedMessage, clearSuspended } = useAuth();
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  return (
    <View style={{ flex: 1, backgroundColor: "#FEF2F2", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <View style={{ width: 90, height: 90, borderRadius: 45, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center", marginBottom: 24 }}>
        <Text style={{ fontSize: 44 }}>🚫</Text>
      </View>
      <Text style={{ fontFamily: "Inter_700Bold", fontSize: 22, color: "#991B1B", textAlign: "center", marginBottom: 12 }}>{T("accountSuspended")}</Text>
      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, color: "#7F1D1D", textAlign: "center", lineHeight: 22, marginBottom: 32 }}>
        {suspendedMessage || T("accountSuspendedMsg")}
      </Text>
      <TouchableOpacity activeOpacity={0.7} onPress={clearSuspended} style={{ backgroundColor: "#DC2626", borderRadius: 14, paddingVertical: 14, paddingHorizontal: 32, alignItems: "center" }}>
        <Text style={{ fontFamily: "Inter_700Bold", fontSize: 15, color: "#fff" }}>{T("signOutLabel")}</Text>
      </TouchableOpacity>
    </View>
  );
}

function MaintenanceScreen() {
  const { config } = usePlatformConfig();
  const { language } = useLanguage();
  const T = (key: TranslationKey) => tDual(key, language);
  return (
    <View style={{ flex: 1, backgroundColor: "#FFF7ED", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <View style={{ width: 90, height: 90, borderRadius: 45, backgroundColor: "#FEF3C7", alignItems: "center", justifyContent: "center", marginBottom: 24 }}>
        <Text style={{ fontSize: 44 }}>🔧</Text>
      </View>
      <Text style={{ fontFamily: "Inter_700Bold", fontSize: 22, color: "#92400E", textAlign: "center", marginBottom: 12 }}>{T("underMaintenance")}</Text>
      <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, color: "#78350F", textAlign: "center", lineHeight: 22, marginBottom: 16 }}>
        {config.content.maintenanceMsg || T("maintenanceApology")}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#FEF3C7", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 }}>
        <Text style={{ fontFamily: "Inter_500Medium", fontSize: 12, color: "#B45309" }}>
          Support: {config.platform.supportPhone || config.platform.supportEmail}
        </Text>
      </View>
    </View>
  );
}

const API_BASE = `https://${_domain}/api`;

function ImpersonationHandler() {
  const { login } = useAuth();

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const impersonateToken = params.get("impersonateToken");
    if (!impersonateToken) return;

    /* Clear the token from the URL immediately so it's not visible or shared */
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("impersonateToken");
      window.history.replaceState({}, "", url.pathname + (url.search || "") + (url.hash || ""));
    } catch {}

    const doImpersonate = async () => {
      try {
        const base = `https://${_domain}`;
        const profileRes = await fetch(`${base}/api/users/profile`, {
          headers: { Authorization: `Bearer ${impersonateToken}` },
        });
        if (!profileRes.ok) {
          if (__DEV__) console.warn("[ImpersonationHandler] Profile fetch failed:", profileRes.status);
          return;
        }
        const profileData = await profileRes.json();
        const userData = profileData.data || profileData.user || profileData;
        if (userData && userData.id) {
          await login(userData, impersonateToken);
          router.replace("/(tabs)");
        }
      } catch (err: any) {
        if (__DEV__) console.warn("[ImpersonationHandler] Error:", err?.message || err);
      }
    };

    doImpersonate();
  }, []);

  return null;
}

function MagicLinkHandler() {
  const { login, setTwoFactorPending } = useAuth();

  useEffect(() => {
    const handleUrl = async (url: string) => {
      try {
        const parsed = new URL(url);
        const token = parsed.searchParams.get("magic_token") || parsed.searchParams.get("token");
        if (!token) return;
        if (!parsed.pathname.includes("magic-link") && !parsed.pathname.includes("auth")) return;

        const res = await fetch(`${API_BASE}/auth/magic-link/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (!res.ok) {
          const errMsg: string = data.error || data.message || "";
          let userMessage: string;
          if (errMsg.toLowerCase().includes("expired") || data.code === "EXPIRED") {
            userMessage = "This magic link has expired. Please request a new login link.";
          } else if (errMsg.toLowerCase().includes("used") || data.code === "USED") {
            userMessage = "This magic link has already been used. Please request a new one.";
          } else if (errMsg.toLowerCase().includes("invalid") || data.code === "INVALID") {
            userMessage = "This magic link is invalid. Please request a new login link.";
          } else {
            userMessage = errMsg || "Invalid or expired magic link. Please request a new one.";
          }
          Alert.alert("Sign-In Failed", userMessage, [{ text: "OK" }]);
          return;
        }
        if (data.requires2FA) {
          setTwoFactorPending({ tempToken: data.tempToken, userId: data.userId });
          router.replace("/auth");
          return;
        }
        if (data.token && data.user) {
          const userData = data.user as import("@/context/AuthContext").AppUser;
          await login(userData, data.token, data.refreshToken);
          if (!hasRole(userData, "customer")) {
            router.replace("/auth/wrong-app");
          } else {
            router.replace("/(tabs)");
          }
        }
      } catch (err: any) {
        if (__DEV__) console.warn("MagicLinkHandler error:", err.message || err);
      }
    };

    const sub = Linking.addEventListener("url", (event) => handleUrl(event.url));
    Linking.getInitialURL().then(url => { if (url) handleUrl(url); }).catch(() => {});
    return () => sub.remove();
  }, []);

  return null;
}

function DeepLinkHandler() {
  useEffect(() => {
    const handleDeepLink = (url: string) => {
      try {
        const parsed = new URL(url);
        const rawPath = parsed.pathname.replace(/^\//, "");
        const path = rawPath.split("/")[0] || parsed.hostname || "";

        if (path === "magic-link" || path === "auth") return;

        const params = Object.fromEntries(parsed.searchParams.entries());

        const routeMap: Record<string, string> = {
          product: "/product/{id}",
          vendor: "/vendor/{id}",
          category: "/categories",
          promo: "/offers",
          ride: "/ride",
          food: "/food",
          mart: "/mart",
          pharmacy: "/pharmacy",
          parcel: "/parcel",
          van: "/van",
        };

        const route = routeMap[path];
        if (!route) return;

        let targetPath = route;
        if (route.includes("{id}")) {
          const id = params.productId || params.vendorId || params.id || "";
          if (!id) return;
          targetPath = route.replace("{id}", id);
        }

        if (path === "ride" && (params.pickup || params.dropoff)) {
          const queryParts: string[] = [];
          if (params.pickup) queryParts.push(`pickup=${encodeURIComponent(params.pickup)}`);
          if (params.dropoff) queryParts.push(`dropoff=${encodeURIComponent(params.dropoff)}`);
          if (params.pickupLat) queryParts.push(`pickupLat=${encodeURIComponent(params.pickupLat)}`);
          if (params.pickupLng) queryParts.push(`pickupLng=${encodeURIComponent(params.pickupLng)}`);
          if (params.dropoffLat) queryParts.push(`dropoffLat=${encodeURIComponent(params.dropoffLat)}`);
          if (params.dropoffLng) queryParts.push(`dropoffLng=${encodeURIComponent(params.dropoffLng)}`);
          if (queryParts.length) targetPath += `?${queryParts.join("&")}`;
        }

        if (path === "category" && params.categoryId) {
          targetPath = `/categories?id=${encodeURIComponent(params.categoryId)}`;
        }

        if (path === "promo" && params.code) {
          targetPath = `/offers?code=${encodeURIComponent(params.code)}`;
        }

        if (!targetPath.startsWith("/")) return;

        setTimeout(() => {
          try {
            router.push(targetPath as any);
          } catch {
            if (__DEV__) console.warn("[DeepLink] Could not navigate to:", targetPath);
          }
        }, 500);
      } catch {
      }
    };

    const sub = Linking.addEventListener("url", (event) => handleDeepLink(event.url));
    Linking.getInitialURL().then(url => { if (url) handleDeepLink(url); }).catch(() => {});
    return () => sub.remove();
  }, []);

  return null;
}

function PushNotificationHandler() {
  const lastResponse = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!lastResponse) return;
    const data = lastResponse.notification.request.content.data as Record<string, string | undefined>;
    const { orderId, rideId, parcelId, screen } = data;

    const navigate = () => {
      try {
        if (orderId) {
          router.push({ pathname: "/orders/[id]", params: { id: orderId } });
        } else if (rideId) {
          router.push({ pathname: "/ride", params: { rideId } });
        } else if (parcelId) {
          router.push({ pathname: "/orders/[id]", params: { id: parcelId } });
        } else if (screen === "orders") {
          router.push("/(tabs)/orders");
        } else if (screen === "wallet") {
          router.push("/wallet");
        } else if (screen === "mart") {
          router.push("/mart");
        }
      } catch {
        if (__DEV__) console.warn("[PushNotificationHandler] Navigation failed");
      }
    };

    setTimeout(navigate, 500);
  }, [lastResponse?.notification.request.identifier]);

  return null;
}

function semverGte(a: string, b: string): boolean {
  const pa = a.split(".").map(n => parseInt(n, 10) || 0);
  const pb = b.split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

const WHATS_NEW_KEY = "@ajkmart_last_whats_new_version";

function ForceUpdateDialog({ visible, storeUrl }: { visible: boolean; storeUrl: string }) {
  const openStore = () => {
    if (storeUrl) Linking.openURL(storeUrl).catch(() => {});
  };
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <View style={{ backgroundColor: "#fff", borderRadius: 20, padding: 28, width: "100%", maxWidth: 360, alignItems: "center" }}>
          <Text style={{ fontSize: 48, marginBottom: 12 }}>🚀</Text>
          <Text style={{ fontFamily: "Inter_700Bold", fontSize: 20, color: "#111827", textAlign: "center", marginBottom: 10 }}>
            Update Required
          </Text>
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, color: "#6B7280", textAlign: "center", lineHeight: 22, marginBottom: 24 }}>
            A newer version of AJKMart is required to continue. Please update the app to access all features.
          </Text>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={openStore}
            style={{ backgroundColor: "#7C3AED", borderRadius: 14, paddingVertical: 14, paddingHorizontal: 32, width: "100%" }}
          >
            <Text style={{ fontFamily: "Inter_700Bold", fontSize: 15, color: "#fff", textAlign: "center" }}>
              Update Now
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function TermsModal({ visible, termsVersion, onAccept }: { visible: boolean; termsVersion: string; onAccept: () => void }) {
  const { token } = useAuth();
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    if (accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/platform-config/accept-terms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ termsVersion }),
      });
      if (!res.ok) throw new Error("Failed to record acceptance");
      onAccept();
    } catch {
      setError("Unable to save your acceptance. Please check your connection and try again.");
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: "80%" }}>
          <Text style={{ fontFamily: "Inter_700Bold", fontSize: 20, color: "#111827", marginBottom: 6 }}>
            Updated Terms & Conditions
          </Text>
          <Text style={{ fontFamily: "Inter_400Regular", fontSize: 13, color: "#6B7280", marginBottom: 16 }}>
            Version {termsVersion} — We've updated our terms of service. Please review and accept to continue.
          </Text>
          <ScrollView style={{ maxHeight: 220, backgroundColor: "#F9FAFB", borderRadius: 12, padding: 14, marginBottom: 20 }}>
            <Text style={{ fontFamily: "Inter_400Regular", fontSize: 13, color: "#374151", lineHeight: 22 }}>
              By using AJKMart, you agree to our Terms of Service and Privacy Policy. You must be at least 13 years of age to use our services. We collect and process your data as described in our Privacy Policy. You may not misuse our services or interfere with their normal operation. We reserve the right to suspend or terminate accounts that violate these terms.{"\n\n"}These terms were last updated and require your explicit acknowledgment to continue using the platform.
            </Text>
          </ScrollView>
          {error && (
            <View style={{ backgroundColor: "#FEF2F2", borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: "#DC2626" }}>{error}</Text>
            </View>
          )}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={handleAccept}
            disabled={accepting}
            style={{ backgroundColor: accepting ? "#A78BFA" : "#7C3AED", borderRadius: 14, paddingVertical: 14, alignItems: "center", marginBottom: 10 }}
          >
            <Text style={{ fontFamily: "Inter_700Bold", fontSize: 15, color: "#fff" }}>
              {accepting ? "Accepting..." : "I Accept the Terms"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function WhatsNewSheet({ visible, releaseNotes, appVersion, onDismiss }: {
  visible: boolean;
  releaseNotes: { id: string; version: string; releaseDate: string; notes: string[]; sortOrder: number }[];
  appVersion: string;
  onDismiss: () => void;
}) {
  const currentNotes = releaseNotes.filter(n => n.version === appVersion);

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: "80%" }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 16 }}>
            <Text style={{ fontSize: 28, marginRight: 10 }}>🎉</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: "Inter_700Bold", fontSize: 20, color: "#111827" }}>
                What's New
              </Text>
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 12, color: "#6B7280" }}>
                Version {appVersion}
              </Text>
            </View>
          </View>
          <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
            {currentNotes.length > 0 ? currentNotes[0].notes.map((note, i) => (
              <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 12 }}>
                <Text style={{ color: "#7C3AED", fontSize: 16, marginRight: 8, marginTop: 1 }}>•</Text>
                <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, color: "#374151", lineHeight: 22, flex: 1 }}>
                  {note}
                </Text>
              </View>
            )) : (
              <Text style={{ fontFamily: "Inter_400Regular", fontSize: 14, color: "#6B7280", lineHeight: 22 }}>
                Bug fixes and performance improvements.
              </Text>
            )}
          </ScrollView>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={onDismiss}
            style={{ backgroundColor: "#7C3AED", borderRadius: 14, paddingVertical: 14, alignItems: "center", marginTop: 16 }}
          >
            <Text style={{ fontFamily: "Inter_700Bold", fontSize: 15, color: "#fff" }}>Got it!</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function MisconfigScreen() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: "#0f172a" }}>
      <Text style={{ fontSize: 48 }}>⚙️</Text>
      <Text style={{ color: "#f1f5f9", fontSize: 20, fontWeight: "700", marginTop: 16, textAlign: "center" }}>
        App Not Configured
      </Text>
      <Text style={{ color: "#94a3b8", fontSize: 14, marginTop: 10, textAlign: "center", lineHeight: 22 }}>
        {"EXPO_PUBLIC_DOMAIN is not set.\nPlease configure the environment and rebuild the app."}
      </Text>
    </View>
  );
}

function ApiUnreachableScreen({ url, onRetry, retrying }: { url: string; onRetry: () => void; retrying: boolean }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: "#0f172a" }}>
      <View style={{
        width: 90, height: 90, borderRadius: 45,
        backgroundColor: "rgba(239,68,68,0.15)",
        alignItems: "center", justifyContent: "center", marginBottom: 24,
      }}>
        <Text style={{ fontSize: 44 }}>⚠️</Text>
      </View>
      <Text style={{ color: "#f1f5f9", fontSize: 22, fontWeight: "700", textAlign: "center", marginBottom: 12 }}>
        Cannot Reach Server
      </Text>
      <Text style={{ color: "#94a3b8", fontSize: 14, textAlign: "center", lineHeight: 22, marginBottom: 8 }}>
        AJKMart could not connect to the API server. Please check your connection and try again.
      </Text>
      <Text style={{
        color: "#64748b", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
        textAlign: "center", marginBottom: 32, paddingHorizontal: 8,
      }}>
        {url}
      </Text>
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={onRetry}
        disabled={retrying}
        style={{
          backgroundColor: retrying ? "#3b82f688" : "#3b82f6",
          borderRadius: 14, paddingVertical: 14, paddingHorizontal: 32,
          alignItems: "center", width: "100%",
        }}
      >
        {retrying
          ? <ActivityIndicator color="#fff" />
          : <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700" }}>Retry Connection</Text>
        }
      </TouchableOpacity>
    </View>
  );
}

function RootLayoutNav() {
  const { isSuspended, user, token, logout } = useAuth();
  const { config } = usePlatformConfig();
  const qc = useQueryClient();
  const segments = useSegments();
  const prevUserRef = useRef<string | null>(null);

  /* Keep the api-client-react auth token getter in sync with the session token.
     AuthContext.tsx is the primary owner of all auth-client wiring (via
     registerAuth / doLogout) — it sets setAuthTokenGetter, setOnUnauthorized,
     setRefreshTokenGetter, and setOnTokenRefreshed with the full nuanced logic
     for suspension, wallet_frozen, role-denied, and session-expiry flows.
     This secondary sync only updates the token getter when token state changes
     through paths outside of registerAuth (e.g. token state rehydration). */
  useEffect(() => {
    if (token) {
      setAuthTokenGetter(() => token);
    } else {
      setAuthTokenGetter(null);
    }
  }, [token]);

  const installedVersion = Constants.expoConfig?.version ?? "1.0.0";
  const minAppVersion = config.compliance?.minAppVersion ?? "1.0.0";
  const forceUpdate = !semverGte(installedVersion, minAppVersion);
  const storeUrl = Platform.OS === "ios"
    ? (config.compliance?.appStoreUrl ?? "")
    : (config.compliance?.playStoreUrl ?? "");

  const [showTerms, setShowTerms] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const termsCheckedRef = useRef(false);
  const whatsNewCheckedRef = useRef(false);

  /* ── Reset compliance checks on user change (login/logout) ── */
  const prevComplianceUserRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = user?.id ?? null;
    if (uid !== prevComplianceUserRef.current) {
      termsCheckedRef.current = false;
      whatsNewCheckedRef.current = false;
      if (!uid) {
        setShowTerms(false);
        setShowWhatsNew(false);
      }
      prevComplianceUserRef.current = uid;
    }
  }, [user?.id]);

  useEffect(() => {
    const uid = user?.id ?? null;
    if (prevUserRef.current && !uid) {
      qc.clear();
    }
    prevUserRef.current = uid;
  }, [user?.id]);

  useEffect(() => {
    initErrorReporter();
    setOnApiError((url, status, message) => {
      reportErrorToBackend({
        errorType: "api_error",
        errorMessage: message,
        functionName: url,
        moduleName: "API Call",
        statusCode: status,
        metadata: { path: url, status },
      });
    });
  }, []);

  /* ── Apply network/retry settings from platform config on startup ── */
  useEffect(() => {
    const net = config?.network;
    if (!net) return;
    setMaxRetryAttempts(net.maxRetryAttempts);
    setRetryBackoffBaseMs(net.retryBackoffBaseMs);
  }, [config]);

  /* ── Defer non-critical init (Sentry, analytics) until after first render ── */
  const deferredInitDone = useRef(false);
  useEffect(() => {
    if (deferredInitDone.current) return;
    const integ = config?.integrations;
    if (!integ) return;
    const doInit = () => {
      deferredInitDone.current = true;
      if (integ.sentry && integ.sentryDsn) {
        initSentry(integ.sentryDsn, integ.sentryEnvironment, integ.sentrySampleRate).catch(() => {});
      }
      if (integ.analytics && integ.analyticsTrackingId) {
        initAnalytics(integ.analyticsPlatform, integ.analyticsTrackingId, integ.analyticsDebug ?? false);
        trackScreen("app_start");
      }
    };
    const timer = setTimeout(doInit, 1500);
    return () => clearTimeout(timer);
  }, [config?.integrations?.sentryDsn, config?.integrations?.analyticsTrackingId]);

  /* ── Defer push + identify until after initial home screen render ── */
  useEffect(() => {
    if (!user?.id || !token) return;
    const timer = setTimeout(() => {
      setSentryUser(String(user.id));
      identifyUser(String(user.id));
      registerPush(token).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [user?.id, token]);

  /* ── When terms version changes, allow re-check in the same session ── */
  const lastCheckedTermsVersionRef = useRef<string | null>(null);
  useEffect(() => {
    const currentTermsVersion = config.compliance?.termsVersion ?? null;
    if (currentTermsVersion && currentTermsVersion !== lastCheckedTermsVersionRef.current) {
      termsCheckedRef.current = false;
    }
  }, [config.compliance?.termsVersion]);

  /* ── Terms re-acceptance check ── */
  useEffect(() => {
    if (!user?.id || termsCheckedRef.current || forceUpdate) return;
    termsCheckedRef.current = true;
    const termsVersion = config.compliance?.termsVersion;
    if (!termsVersion) return;
    lastCheckedTermsVersionRef.current = termsVersion;
    fetch(`${API_BASE}/platform-config/compliance-status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        const accepted = data?.data?.acceptedTermsVersion ?? data?.acceptedTermsVersion;
        if (!accepted || accepted !== termsVersion) {
          setShowTerms(true);
        }
      })
      .catch(() => {});
  }, [user?.id, config.compliance?.termsVersion, forceUpdate]);

  /* ── What's New check ── */
  useEffect(() => {
    if (!user?.id || whatsNewCheckedRef.current || forceUpdate) return;
    whatsNewCheckedRef.current = true;
    AsyncStorage.getItem(WHATS_NEW_KEY).then(lastSeen => {
      if (lastSeen !== installedVersion && config.releaseNotes?.length > 0) {
        setTimeout(() => setShowWhatsNew(true), 1500);
      }
    }).catch(() => {});
  }, [user?.id, installedVersion, config.releaseNotes?.length, forceUpdate]);

  if (isSuspended) return <SuspendedScreen />;
  if (config.appStatus === "maintenance" && user) return <MaintenanceScreen />;

  return (
    <>
      {config.appStatus === "limited" && (
        <View style={{
          position: "absolute", top: 0, left: 0, right: 0, zIndex: 1000,
          backgroundColor: "#F59E0B", paddingTop: 44, paddingBottom: 8,
          paddingHorizontal: 16, alignItems: "center",
        }}>
          <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>
            ⚠️ Limited service — some features may be temporarily unavailable
          </Text>
        </View>
      )}
      <AuthGuard />
      <ImpersonationHandler />
      <MagicLinkHandler />
      <DeepLinkHandler />
      <PushNotificationHandler />
      {_domain && <PopupEngine apiBase={`https://${_domain}/api`} triggerKey={segments.join("/")} />}
      <ForceUpdateDialog visible={forceUpdate} storeUrl={storeUrl} />
      <TermsModal
        visible={!forceUpdate && showTerms}
        termsVersion={config.compliance?.termsVersion ?? "1.0"}
        onAccept={() => setShowTerms(false)}
      />
      <WhatsNewSheet
        visible={!forceUpdate && !showTerms && showWhatsNew}
        releaseNotes={config.releaseNotes ?? []}
        appVersion={installedVersion}
        onDismiss={() => {
          AsyncStorage.setItem(WHATS_NEW_KEY, installedVersion).catch(() => {});
          setShowWhatsNew(false);
        }}
      />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index"          options={{ headerShown: false }} />
        <Stack.Screen name="onboarding"     options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="(tabs)"         options={{ headerShown: false }} />
        <Stack.Screen name="auth"           options={{ headerShown: false }} />
        <Stack.Screen name="mart/index"     options={{ headerShown: false }} />
        <Stack.Screen name="food/index"     options={{ headerShown: false }} />
        <Stack.Screen name="ride/index"     options={{ headerShown: false }} />
        <Stack.Screen name="cart/index"     options={{ headerShown: false }} />
        <Stack.Screen name="pharmacy/index" options={{ headerShown: false }} />
        <Stack.Screen name="parcel/index"   options={{ headerShown: false }} />
        <Stack.Screen name="categories/index" options={{ headerShown: false }} />
        <Stack.Screen name="order/index"    options={{ headerShown: false }} />
        <Stack.Screen name="orders/[id]"    options={{ headerShown: false }} />
        <Stack.Screen name="school/index"   options={{ headerShown: false }} />
        <Stack.Screen name="school/book"    options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

async function probeApiHealth(): Promise<{ reachable: boolean; url: string }> {
  const url = `${API_BASE}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { reachable: res.ok, url };
  } catch {
    return { reachable: false, url };
  } finally {
    clearTimeout(timer);
  }
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  /* null = not yet checked, true = reachable, false = unreachable */
  const [apiReachable, setApiReachable] = useState<boolean | null>(_domain ? null : true);
  const [apiUrl, setApiUrl] = useState(`${API_BASE}/health`);
  const [retrying, setRetrying] = useState(false);

  /* Register PWA service worker on web */
  useEffect(() => {
    registerServiceWorker();
  }, []);

  /* Run the API health check concurrently with font loading.
     On failure, show a native Alert (for native/web parity) in addition to
     the blocking ApiUnreachableScreen that renders below. */
  useEffect(() => {
    if (!_domain) return; // misconfig screen handles the no-domain case
    probeApiHealth().then(({ reachable, url }) => {
      setApiUrl(url);
      setApiReachable(reachable);
      if (!reachable) {
        Alert.alert(
          "Cannot Reach Server",
          "AJKMart could not connect to the API server. Please check your connection and tap Retry.",
          [{ text: "OK", style: "cancel" }]
        );
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const SPLASH_DEADLINE_MS = Platform.OS === "web" ? 3000 : 8000;

    const hideSplash = () => {
      if (!cancelled) {
        cancelled = true;
        setReady(true);
        SplashScreen.hideAsync().catch(() => {});
      }
    };

    const deadlineTimer = setTimeout(hideSplash, SPLASH_DEADLINE_MS);

    const loadAllFonts = async () => {
      try {
        const timeout = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

        // Step 1: Load core Inter fonts — always required, fast (~300 KB).
        await Promise.race([
          loadCoreFonts(),
          timeout(Platform.OS === "web" ? 2000 : 6000),
        ]).catch(() => {});

        // Step 2: Pre-load Noto Nastaliq Urdu ONLY if the saved language
        // preference is Urdu. This prevents the large (~2.7 MB) font set
        // from being downloaded/registered on every cold start for
        // English-speaking users — which was the source of the startup error.
        const savedLang = await AsyncStorage.getItem("@ajkmart_language").catch(() => null);
        if (savedLang === "ur" || savedLang === "en_ur") {
          // Fire-and-forget; don't block the splash hide on Urdu font load.
          loadUrduFonts().catch(() => {});
        }
      } catch {
        // Silently continue — the app renders with system fonts as fallback.
      }

      clearTimeout(deadlineTimer);
      hideSplash();
    };

    loadAllFonts();

    return () => {
      cancelled = true;
      clearTimeout(deadlineTimer);
    };
  }, []);

  const handleRetry = async () => {
    setRetrying(true);
    const result = await probeApiHealth();
    setApiUrl(result.url);
    if (result.reachable) {
      setApiReachable(true);
    } else {
      setRetrying(false);
    }
  };

  /* Show splash while fonts are loading or the health probe is still pending */
  if (!ready || (_domain && apiReachable === null)) {
    return (
      <WebShell>
        <View style={{ flex: 1, backgroundColor: "#0047B3", alignItems: "center", justifyContent: "center", gap: 20 }}>
          <View style={{
            width: 72,
            height: 72,
            borderRadius: 20,
            backgroundColor: "rgba(255,255,255,0.15)",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <Text style={{ fontSize: 36 }}>🛒</Text>
          </View>
          <ActivityIndicator size="large" color="#ffffff" />
        </View>
      </WebShell>
    );
  }

  if (!_domain) {
    return (
      <WebShell>
        <MisconfigScreen />
      </WebShell>
    );
  }

  if (apiReachable === false) {
    return (
      <WebShell>
        <ApiUnreachableScreen url={apiUrl} onRetry={handleRetry} retrying={retrying} />
      </WebShell>
    );
  }

  return (
    <WebShell>
      <SafeAreaProvider>
        <ErrorBoundary onError={(error, stackTrace) => {
            reportErrorToBackend({
              errorType: "frontend_crash",
              errorMessage: error.message || "Component crash",
              stackTrace: error.stack || stackTrace,
              componentName: "ErrorBoundary",
            });
          }}>
          <PersistQueryClientProvider client={queryClient} persistOptions={{ persister: asyncStoragePersister, maxAge: 1000 * 60 * 60 * 24 }}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <KeyboardProvider>
                <FontSizeProvider>
                  <ThemeProvider>
                    <PlatformConfigProvider>
                      <PerformanceProvider>
                        <LanguageProvider>
                          <AuthProvider>
                            <DeferredProviders>
                              <OfflineBar />
                              <SlowConnectionBar />
                              <RootLayoutNav />
                              <PwaInstallBanner />
                            </DeferredProviders>
                          </AuthProvider>
                        </LanguageProvider>
                      </PerformanceProvider>
                    </PlatformConfigProvider>
                  </ThemeProvider>
                </FontSizeProvider>
              </KeyboardProvider>
            </GestureHandlerRootView>
          </PersistQueryClientProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </WebShell>
  );
}
